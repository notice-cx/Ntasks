/**
 * Joins still WebP images into one animated WebP, as the WebP container
 * specification lays it out
 * (https://developers.google.com/speed/webp/docs/riff_container): a RIFF
 * file holding VP8X with the animation flag, ANIM, then one ANMF chunk per
 * frame that wraps the still's ALPH chunk, when it has one, and its VP8 or
 * VP8L chunk. Nothing is decoded or encoded again: each still's bitstream is
 * copied as it is. A still's other chunks, such as the sRGB colour profile
 * Chrome adds, are left out; a viewer reads an image without a profile as
 * sRGB.
 */

/** One RIFF chunk: its four-character code and its payload, without the padding byte. */
export interface Chunk {
  fourcc: string;
  payload: Uint8Array;
}

/** What a still WebP holds that a frame of an animation carries. */
export interface Still {
  width: number;
  height: number;
  /** Its ALPH chunk, when the image is lossy with transparency. */
  alpha: Chunk | null;
  /** Its VP8 or VP8L chunk. */
  image: Chunk;
  /** Whether any pixel can be transparent. */
  hasAlpha: boolean;
}

/** One frame: a still WebP, how long it shows, and where its top-left corner sits on the canvas. */
export interface Frame {
  webp: Uint8Array;
  durationMs: number;
  /** Even, because the container stores half the offset. Zero when left out. */
  x?: number;
  y?: number;
}

/** A frame's duration is 24 bits of milliseconds. */
const MAX_DURATION_MS = 0xff_ffff;
/** VP8X's flags: the image has transparency, and it is an animation. */
const ALPHA_FLAG = 0x10;
const ANIMATION_FLAG = 0x02;
/** ANMF's last byte: draw the frame over its rectangle without blending, and leave it there for the next one. */
const NO_BLEND_NO_DISPOSE = 0x02;

const latin1 = new TextDecoder('latin1');

function fourccAt(bytes: Uint8Array, offset: number): string {
  return latin1.decode(bytes.subarray(offset, offset + 4));
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The chunks after a RIFF file's `WEBP` mark, in order. */
export function readChunks(webp: Uint8Array): Chunk[] {
  if (webp.byteLength < 12 || fourccAt(webp, 0) !== 'RIFF' || fourccAt(webp, 8) !== 'WEBP') {
    throw new Error('Not a WebP file: it does not start with RIFF and WEBP.');
  }
  // The RIFF size counts everything after its own field; a writer may leave bytes after it, which are not the image.
  const end = Math.min(webp.byteLength, 8 + view(webp).getUint32(4, true));
  const chunks: Chunk[] = [];
  let at = 12;
  while (at + 8 <= end) {
    const size = view(webp).getUint32(at + 4, true);
    const start = at + 8;
    if (start + size > end) throw new Error(`The ${fourccAt(webp, at)} chunk runs past the end of the file.`);
    chunks.push({ fourcc: fourccAt(webp, at), payload: webp.subarray(start, start + size) });
    at = start + size + (size % 2);
  }
  return chunks;
}

/** A VP8 key frame's size: after the 3-byte frame tag and the start code, 14 bits each of width and height. */
function vp8Size(payload: Uint8Array): { width: number; height: number } {
  if (payload.byteLength < 10 || payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) {
    throw new Error('The VP8 chunk does not start with a key frame.');
  }
  return { width: view(payload).getUint16(6, true) & 0x3fff, height: view(payload).getUint16(8, true) & 0x3fff };
}

/** A VP8L image's size and whether it uses alpha: after its 0x2f signature, 14 bits each of width and height less one, then the alpha bit. */
function vp8lSize(payload: Uint8Array): { width: number; height: number; alpha: boolean } {
  if (payload.byteLength < 5 || payload[0] !== 0x2f) throw new Error('The VP8L chunk has no VP8L signature.');
  const bits = view(payload).getUint32(1, true);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: ((bits >>> 28) & 1) === 1 };
}

/** What a still WebP holds, read from its chunks. An animated file is refused. */
export function readStill(webp: Uint8Array): Still {
  const chunks = readChunks(webp);
  if (chunks.some((chunk) => chunk.fourcc === 'ANIM' || chunk.fourcc === 'ANMF')) {
    throw new Error('The WebP file is already an animation.');
  }
  const image = chunks.find((chunk) => chunk.fourcc === 'VP8 ' || chunk.fourcc === 'VP8L');
  if (!image) throw new Error('The WebP file holds no VP8 or VP8L image.');
  const alpha = chunks.find((chunk) => chunk.fourcc === 'ALPH') ?? null;
  if (image.fourcc === 'VP8L') {
    const size = vp8lSize(image.payload);
    return { width: size.width, height: size.height, alpha: null, image, hasAlpha: size.alpha };
  }
  return { ...vp8Size(image.payload), alpha, image, hasAlpha: alpha !== null };
}

function chunkLength(chunk: Chunk): number {
  return 8 + chunk.payload.byteLength + (chunk.payload.byteLength % 2);
}

/** Writes a chunk at `at` and returns where the next one starts. */
function writeChunk(out: Uint8Array, at: number, chunk: Chunk): number {
  for (let index = 0; index < 4; index += 1) out[at + index] = chunk.fourcc.charCodeAt(index);
  view(out).setUint32(at + 4, chunk.payload.byteLength, true);
  out.set(chunk.payload, at + 8);
  // The padding byte, when there is one, is already zero.
  return at + chunkLength(chunk);
}

function setUint24(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

/** One ANMF chunk: the frame's rectangle, its duration and how it is drawn, then its image chunks. */
function frameChunk(frame: Frame, still: Still): Chunk {
  const parts = still.alpha ? [still.alpha, still.image] : [still.image];
  const payload = new Uint8Array(16 + parts.reduce((sum, part) => sum + chunkLength(part), 0));
  setUint24(payload, 0, (frame.x ?? 0) / 2);
  setUint24(payload, 3, (frame.y ?? 0) / 2);
  setUint24(payload, 6, still.width - 1);
  setUint24(payload, 9, still.height - 1);
  setUint24(payload, 12, Math.round(frame.durationMs));
  payload[15] = NO_BLEND_NO_DISPOSE;
  let at = 16;
  for (const part of parts) at = writeChunk(payload, at, part);
  return { fourcc: 'ANMF', payload };
}

/**
 * An animated WebP of `frames`, in order, on a canvas of `width` × `height`
 * pixels that loops forever. Each frame replaces the pixels of its own
 * rectangle and leaves the rest of the canvas as the frames before it drew
 * it, so a frame can be a part of the picture that changed.
 */
export function animatedWebp(frames: readonly Frame[], canvas: { width: number; height: number }): Uint8Array {
  if (frames.length === 0) throw new Error('An animation needs at least one frame.');
  const chunks: Chunk[] = [];
  let hasAlpha = false;
  frames.forEach((frame, index) => {
    const still = readStill(frame.webp);
    const x = frame.x ?? 0;
    const y = frame.y ?? 0;
    if (x % 2 !== 0 || y % 2 !== 0 || x < 0 || y < 0) throw new Error(`Frame ${index}'s offset must be even.`);
    if (x + still.width > canvas.width || y + still.height > canvas.height) {
      throw new Error(`Frame ${index} (${still.width} × ${still.height} at ${x}, ${y}) does not fit the canvas.`);
    }
    if (!(frame.durationMs >= 0 && Math.round(frame.durationMs) <= MAX_DURATION_MS)) {
      throw new Error(`Frame ${index}'s duration must be 0 to ${MAX_DURATION_MS} ms.`);
    }
    hasAlpha ||= still.hasAlpha;
    chunks.push(frameChunk(frame, still));
  });

  const header = new Uint8Array(10);
  header[0] = ANIMATION_FLAG | (hasAlpha ? ALPHA_FLAG : 0);
  setUint24(header, 4, canvas.width - 1);
  setUint24(header, 7, canvas.height - 1);
  // A background colour of 0, which viewers may ignore, and a loop count of 0, which repeats forever.
  const animation = new Uint8Array(6);
  chunks.unshift({ fourcc: 'VP8X', payload: header }, { fourcc: 'ANIM', payload: animation });

  const out = new Uint8Array(12 + chunks.reduce((sum, chunk) => sum + chunkLength(chunk), 0));
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  view(out).setUint32(4, out.byteLength - 8, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  let at = 12;
  for (const chunk of chunks) at = writeChunk(out, at, chunk);
  return out;
}
