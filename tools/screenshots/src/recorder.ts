/**
 * Records a walkthrough: a page of the web app driven by a drawn cursor,
 * captured frame by frame through a camera that pans and zooms, then encoded
 * as one animated WebP.
 *
 * The cursor is an arrow drawn into the page that ignores the pointer. Each
 * of its moves and clicks is also sent to Chrome as real mouse input at the
 * same point, so the app shows its hover states and reacts to the click. The
 * camera is the area each frame captures: every frame is the same size in
 * pixels, and a smaller area is drawn at a larger scale, so zooming in
 * redraws the page's text sharply rather than enlarging pixels.
 *
 * Each frame is captured as PNG and encoded afterwards, in the page, by
 * Chrome's own WebP encoder: a frame the camera moved through is encoded
 * whole at a lower quality, since it is on screen for one frame; any other
 * frame is encoded as only the rectangle that changed since the frame
 * before, and a frame with no change lengthens the one before it.
 */
import { animatedWebp, type Frame } from './animated-webp.ts';
import { until, type PageSend } from './devtools.ts';

export interface Point {
  x: number;
  y: number;
}

/** An element: a CSS selector, or the first element it matches whose text is `text`. */
export type Target = string | { selector: string; text: string };

/** An area of the page, in CSS pixels from the viewport's top-left corner. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecorderOptions {
  /** The page's size in CSS pixels. */
  viewport: { width: number; height: number };
  /** Every frame's size in pixels, the same shape as the viewport. */
  frame: { width: number; height: number };
  fps: number;
  /** WebP quality, 0 to 1, of a frame the camera holds still and of one it moves through. */
  quality: { still: number; moving: number };
}

/** One captured frame, before encoding. */
interface Shot {
  png: string;
  /** When it starts, in milliseconds from the walkthrough's start. */
  at: number;
  /** The camera moved since the frame before. */
  moving: boolean;
}

/** How long Chrome takes to draw the page again at a new scale. */
const SETTLE_MS = 400;

/** Slow at both ends. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * The cursor: a black arrow with a white edge, its tip at the element's
 * top-left corner, and the ring a click shows, white with black edges, so
 * both stand out on light, dark and coloured backgrounds alike.
 */
const CURSOR_SCRIPT = `(() => {
  if (window.__walkthrough) return;
  const style = document.createElement('style');
  style.textContent = \`
    #walkthrough-cursor, #walkthrough-ring { position: fixed; left: 0; top: 0; pointer-events: none; z-index: 2147483647; }
    #walkthrough-cursor { width: 22px; height: 22px; filter: drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.35)); }
    #walkthrough-ring { width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; opacity: 0;
      border: 2.5px solid #fff; box-shadow: 0 0 0 1.5px rgb(17 17 17 / 0.6), inset 0 0 0 1.5px rgb(17 17 17 / 0.6); }\`;
  const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  cursor.id = 'walkthrough-cursor';
  cursor.setAttribute('viewBox', '0 0 22 22');
  cursor.innerHTML = '<path d="M2 1.5v16.2l4.2-4 2.9 6.6 2.9-1.3-2.9-6.4h5.9z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>';
  const ring = document.createElement('div');
  ring.id = 'walkthrough-ring';
  const place = () => document.documentElement.append(style, ring, cursor);
  if (document.documentElement) place();
  else document.addEventListener('DOMContentLoaded', place);
  window.__walkthrough = {
    move(x, y) {
      if (!cursor.isConnected) place();
      cursor.style.transform = 'translate(' + (x - 2) + 'px, ' + (y - 1.5) + 'px)';
    },
    ring(x, y, t) {
      ring.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + (0.45 + 0.55 * t) + ')';
      ring.style.opacity = t >= 1 ? '0' : String(1 - t * t);
    },
  };
})()`;

/**
 * The encoder the page runs. It keeps the pixels the animation shows so far,
 * and answers each frame with the rectangle to draw over them, or null when
 * nothing changed. It compares 16-pixel tiles: Chrome draws the edge of a
 * shape at a fractional position a shade differently from one capture to the
 * next, so a tile counts as changed only when enough of its pixels change or
 * one changes by much. A change too small to count stays in the comparison
 * until it adds up to one that does.
 */
const ENCODER_SCRIPT = `window.__encoder = {
  shown: null,
  async encode(png, whole, quality) {
    // A tile's size is even, so each rectangle starts on even pixels, as the container's halved offsets need.
    const TILE = 16, PIXELS = 24, STEP = 48;
    const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    let left = 0, top = 0, right = width, bottom = height;
    const shown = this.shown;
    if (!whole && shown) {
      left = width; top = height; right = 0; bottom = 0;
      for (let ty = 0; ty < height; ty += TILE) {
        for (let tx = 0; tx < width; tx += TILE) {
          let count = 0, most = 0;
          for (let y = ty; y < Math.min(ty + TILE, height); y += 1) {
            for (let x = tx; x < Math.min(tx + TILE, width); x += 1) {
              const at = (y * width + x) * 4;
              const step = Math.max(
                Math.abs(pixels[at] - shown[at]),
                Math.abs(pixels[at + 1] - shown[at + 1]),
                Math.abs(pixels[at + 2] - shown[at + 2]),
              );
              if (step > 0) count += 1;
              if (step > most) most = step;
            }
          }
          if (count >= PIXELS || most >= STEP) {
            left = Math.min(left, tx);
            top = Math.min(top, ty);
            right = Math.max(right, Math.min(tx + TILE, width));
            bottom = Math.max(bottom, Math.min(ty + TILE, height));
          }
        }
      }
      if (right === 0) return null;
    }
    // What the animation shows once this frame is drawn: the new pixels inside the rectangle.
    if (!shown || whole) this.shown = pixels;
    else {
      for (let y = top; y < bottom; y += 1) {
        shown.set(pixels.subarray((y * width + left) * 4, (y * width + right) * 4), (y * width + left) * 4);
      }
    }
    const part = new OffscreenCanvas(right - left, bottom - top);
    part.getContext('2d').drawImage(canvas, left, top, right - left, bottom - top, 0, 0, right - left, bottom - top);
    const blob = await part.convertToBlob({ type: 'image/webp', quality });
    const out = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let at = 0; at < out.length; at += 0x8000) text += String.fromCharCode(...out.subarray(at, at + 0x8000));
    return { x: left, y: top, webp: btoa(text) };
  },
};`;

export class Recorder {
  readonly #send: PageSend;
  readonly #options: RecorderOptions;
  #shots: Shot[] = [];
  /** The walkthrough's clock, in milliseconds: the next frame starts here. */
  #clock = 0;
  /** The wall-clock time the walkthrough's clock counts from, so frames are captured no faster than they play. */
  #started = 0;
  #camera: Rect;
  #cursor: Point;
  #ring: { at: Point; frame: number } | null = null;

  constructor(send: PageSend, options: RecorderOptions) {
    this.#send = send;
    this.#options = options;
    this.#camera = { x: 0, y: 0, ...options.viewport };
    this.#cursor = { x: options.viewport.width / 2, y: options.viewport.height / 2 };
  }

  get #frameMs(): number {
    return 1000 / this.#options.fps;
  }

  async #evaluate<T>(expression: string): Promise<T> {
    const answer = await this.#send<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer.exceptionDetails) throw new Error(`The page failed to run a step: ${answer.exceptionDetails.text}`);
    return answer.result.value;
  }

  /** The area an element covers, in CSS pixels; it fails when no element matches. */
  async box(target: Target): Promise<Rect> {
    const { selector, text = null } = typeof target === 'string' ? { selector: target } : target;
    const box = await this.#evaluate<Rect | null>(`(() => {
      const text = ${JSON.stringify(text)};
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(
        (candidate) => text === null || candidate.textContent.trim() === text,
      );
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    })()`);
    if (box === null) throw new Error(`Nothing on the page matches ${JSON.stringify(target)}.`);
    return box;
  }

  /** The area that holds every one of `targets`. */
  async around(...targets: Target[]): Promise<Rect> {
    const boxes = await Promise.all(targets.map((target) => this.box(target)));
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  /** A point in an element: its center, or `at` across and down it as fractions of its size. */
  async point(target: Target, at: Point = { x: 0.5, y: 0.5 }): Promise<Point> {
    const box = await this.box(target);
    return { x: box.x + box.width * at.x, y: box.y + box.height * at.y };
  }

  /**
   * The camera that shows `area` with `margin` CSS pixels around it: the
   * frame's shape, no narrower than `minWidth`, and inside the viewport.
   */
  frame(area: Rect, { margin = 24, minWidth = 480 }: { margin?: number; minWidth?: number } = {}): Rect {
    const { viewport, frame } = this.#options;
    const aspect = frame.width / frame.height;
    let width = Math.max(area.width + 2 * margin, (area.height + 2 * margin) * aspect, minWidth);
    width = Math.min(width, viewport.width);
    const height = width / aspect;
    const clamp = (start: number, size: number, limit: number) => Math.min(Math.max(start, 0), limit - size);
    return {
      x: clamp(area.x + area.width / 2 - width / 2, width, viewport.width),
      y: clamp(area.y + area.height / 2 - height / 2, height, viewport.height),
      width,
      height,
    };
  }

  /** The whole viewport. */
  wide(): Rect {
    return { x: 0, y: 0, ...this.#options.viewport };
  }

  /** Waits until the page's `expression` is true, without capturing. */
  async waitFor(what: string, expression: string, waitMs = 15_000): Promise<void> {
    await until(what, async () => (await this.#evaluate<unknown>(expression)) === true, { waitMs });
  }

  /** Sets the camera and the cursor where the walkthrough starts, and starts its clock. */
  async start(camera: Rect, cursor: Point): Promise<void> {
    await this.#evaluate(CURSOR_SCRIPT);
    this.#camera = camera;
    this.#cursor = cursor;
    this.#shots = [];
    this.#clock = 0;
    this.#started = performance.now();
    await this.#pointAt(cursor);
  }

  async #pointAt(point: Point): Promise<void> {
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.#evaluate(`window.__walkthrough.move(${point.x}, ${point.y})`);
  }

  /** Captures one frame as the page stands, after it has drawn its latest change, and advances the clock. */
  async #capture(moving: boolean): Promise<void> {
    // The ring of a click grows and fades over a fixed number of frames, whatever the wall clock does.
    const ringFrames = 6;
    if (this.#ring) {
      const t = Math.min(this.#ring.frame / ringFrames, 1);
      await this.#evaluate(`window.__walkthrough.ring(${this.#ring.at.x}, ${this.#ring.at.y}, ${t})`);
      this.#ring = t >= 1 ? null : { ...this.#ring, frame: this.#ring.frame + 1 };
    }
    // Frames are captured no faster than they play, so the app's own timers keep pace with the picture.
    const due = this.#started + this.#clock;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await this.#evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))');
    const { frame } = this.#options;
    const { x, y, width, height } = this.#camera;
    const { data } = await this.#send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      clip: { x, y, width, height, scale: frame.width / width },
    });
    this.#shots.push({ png: data, at: this.#clock, moving });
    this.#clock += this.#frameMs;
  }

  /**
   * Moves the cursor to `to` and the camera to `camera` together over `ms`,
   * both eased; either can stay where it is. The cursor follows a slight arc,
   * as a hand moves a mouse.
   */
  async move({ to, camera, ms }: { to?: Point; camera?: Rect; ms: number }): Promise<void> {
    const fromCursor = this.#cursor;
    const fromCamera = this.#camera;
    const steps = Math.max(1, Math.round(ms / this.#frameMs));
    // The arc's middle sits at most 10 CSS pixels off the straight line, so a move along a row stays on it.
    const distance = to ? Math.hypot(to.x - fromCursor.x, to.y - fromCursor.y) : 0;
    const bend = distance === 0 ? 0 : Math.min(0.1 * distance, 10) / distance;
    const control = to
      ? {
          x: (fromCursor.x + to.x) / 2 - (to.y - fromCursor.y) * bend * 2,
          y: (fromCursor.y + to.y) / 2 + (to.x - fromCursor.x) * bend * 2,
        }
      : fromCursor;
    for (let step = 1; step <= steps; step += 1) {
      const t = easeInOut(step / steps);
      if (to) {
        const u = 1 - t;
        this.#cursor = {
          x: u * u * fromCursor.x + 2 * u * t * control.x + t * t * to.x,
          y: u * u * fromCursor.y + 2 * u * t * control.y + t * t * to.y,
        };
        await this.#pointAt(this.#cursor);
      }
      if (camera) {
        // The width changes by a constant ratio per frame, so the zoom keeps one pace from wide to close.
        const width = fromCamera.width * (camera.width / fromCamera.width) ** t;
        const height = (width * fromCamera.height) / fromCamera.width;
        const cx =
          fromCamera.x + fromCamera.width / 2 + (camera.x + camera.width / 2 - fromCamera.x - fromCamera.width / 2) * t;
        const cy =
          fromCamera.y +
          fromCamera.height / 2 +
          (camera.y + camera.height / 2 - fromCamera.y - fromCamera.height / 2) * t;
        this.#camera = { x: cx - width / 2, y: cy - height / 2, width, height };
      }
      await this.#capture(camera !== undefined);
    }
    if (camera) {
      this.#camera = camera;
      // Chrome draws a page whose scale keeps changing from tiles at an older scale, and draws them again at the new
      // scale once it holds still; the frames wait for that rather than show the page sharpening.
      await this.cut(() => new Promise((resolve) => setTimeout(resolve, SETTLE_MS)));
    }
  }

  /** Captures frames for `ms` while the page does what it does; frames that do not change join into one. */
  async hold(ms: number): Promise<void> {
    const steps = Math.max(1, Math.round(ms / this.#frameMs));
    for (let step = 0; step < steps; step += 1) await this.#capture(false);
  }

  /** Presses and releases the mouse at the cursor, showing the ring. `release: false` ends on the press. */
  async click({ release = true }: { release?: boolean } = {}): Promise<void> {
    const { x, y } = this.#cursor;
    this.#ring = { at: { x, y }, frame: 0 };
    await this.#send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.#capture(false);
    if (release) {
      await this.#send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    await this.#capture(false);
  }

  /** Types `text` into the focused field, `perFrame` characters a frame. */
  async type(text: string, perFrame = 1): Promise<void> {
    for (let at = 0; at < text.length; at += perFrame) {
      await this.#send('Input.insertText', { text: text.slice(at, at + perFrame) });
      await this.#capture(false);
    }
  }

  /**
   * Leaves out the time `work` takes: nothing is captured while it runs, and
   * the next frame follows the last one at once. The cursor is drawn again
   * afterwards, in case `work` loaded another document.
   */
  async cut(work: () => Promise<void>): Promise<void> {
    const before = performance.now();
    await work();
    await this.#evaluate(CURSOR_SCRIPT);
    await this.#pointAt(this.#cursor);
    this.#started += performance.now() - before;
  }

  /** Leaves out the time until the page's `expression` is true. */
  async skipUntil(what: string, expression: string, waitMs = 15_000): Promise<void> {
    await this.cut(() => this.waitFor(what, expression, waitMs));
  }

  /**
   * Encodes the frames, with the last one shown for `endMs`, as an animated
   * WebP that loops, using the page as the encoder. Afterwards the page has
   * the encoder's script in it, so it is not used for another recording.
   */
  async encode({ endMs }: { endMs: number }): Promise<{ webp: Uint8Array; frames: number; durationMs: number }> {
    const { frame, quality } = this.#options;
    await this.#evaluate(ENCODER_SCRIPT);
    const frames: Frame[] = [];
    let previousMoving = true;
    const total = (this.#shots.at(-1)?.at ?? 0) + endMs;
    for (const [index, shot] of this.#shots.entries()) {
      const next = this.#shots[index + 1]?.at ?? total;
      const durationMs = next - shot.at;
      // After the camera stops, the first still frame is drawn whole, so no lower-quality pixels stay on screen.
      const whole = shot.moving || previousMoving;
      previousMoving = shot.moving;
      const part = await this.#evaluate<{ x: number; y: number; webp: string } | null>(
        `window.__encoder.encode(${JSON.stringify(shot.png)}, ${whole}, ${shot.moving ? quality.moving : quality.still})`,
      );
      const last = frames.at(-1);
      if (part === null && last) {
        last.durationMs += durationMs;
        continue;
      }
      if (part === null) throw new Error('The first frame has nothing to draw.');
      frames.push({ webp: Buffer.from(part.webp, 'base64'), x: part.x, y: part.y, durationMs });
    }
    // Durations are whole milliseconds; each frame is rounded at its start so the total stays the same.
    let start = 0;
    let exact = 0;
    for (const entry of frames) {
      exact += entry.durationMs;
      entry.durationMs = Math.round(exact) - start;
      start += entry.durationMs;
    }
    const webp = animatedWebp(frames, frame);
    await this.#check(webp, frames.length);
    return { webp, frames: frames.length, durationMs: start };
  }

  /** Decodes the animation with Chrome's ImageDecoder and fails unless Chrome reads every frame at the frame size. */
  async #check(webp: Uint8Array, frames: number): Promise<void> {
    const { frame } = this.#options;
    const read = await this.#evaluate<{ frames: number; width: number; height: number; last: number }>(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(Buffer.from(webp).toString('base64'))}), (char) => char.charCodeAt(0));
      const decoder = new ImageDecoder({ data: bytes, type: 'image/webp' });
      await decoder.tracks.ready;
      const count = decoder.tracks.selectedTrack.frameCount;
      const first = await decoder.decode({ frameIndex: 0 });
      const last = await decoder.decode({ frameIndex: count - 1 });
      const answer = { frames: count, width: first.image.displayWidth, height: first.image.displayHeight, last: last.image.displayWidth };
      first.image.close();
      last.image.close();
      decoder.close();
      return answer;
    })()`);
    if (
      read.frames !== frames ||
      read.width !== frame.width ||
      read.height !== frame.height ||
      read.last !== frame.width
    ) {
      throw new Error(
        `Chrome decoded ${read.frames} frames of ${read.width} × ${read.height}, not ${frames} of ${frame.width} × ${frame.height}.`,
      );
    }
  }
}
