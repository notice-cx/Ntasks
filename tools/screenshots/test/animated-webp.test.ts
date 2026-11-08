import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { animatedWebp, readChunks, readStill, type Chunk } from '../src/animated-webp.ts';

const fourcc = (code: string) => [...code].map((char) => char.charCodeAt(0));
const uint32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];

/** A RIFF chunk's bytes, with the padding byte an odd payload takes. */
function chunk(code: string, payload: number[]): number[] {
  return [...fourcc(code), ...uint32(payload.length), ...payload, ...(payload.length % 2 === 1 ? [0] : [])];
}

/** A WebP file holding `chunks`. */
function webp(...chunks: number[][]): Uint8Array {
  const body = [...fourcc('WEBP'), ...chunks.flat()];
  return Uint8Array.from([...fourcc('RIFF'), ...uint32(body.length), ...body]);
}

/** A VP8 key frame's header for an image of `width` × `height`, then `rest`. */
function vp8(width: number, height: number, rest: number[]): number[] {
  return [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8, ...rest];
}

/** A VP8L image's header for `width` × `height`, then `rest`. */
function vp8l(width: number, height: number, alpha: boolean, rest: number[]): number[] {
  const bits = (width - 1) | ((height - 1) << 14) | ((alpha ? 1 : 0) << 28);
  return [0x2f, ...uint32(bits), ...rest];
}

/** A lossy still as Chrome writes a screenshot: VP8X, an ICC profile, then the VP8 image, of odd length. */
const LOSSY = webp(
  chunk('VP8X', [0x20, 0, 0, 0, 7, 0, 0, 3, 0, 0]),
  chunk('ICCP', [1, 2, 3, 4]),
  chunk('VP8 ', vp8(8, 4, [0xaa, 0xbb, 0xcc])),
);
/** A lossy still with transparency, as a part of the frame: its ALPH chunk, then VP8. */
const LOSSY_ALPHA = webp(
  chunk('VP8X', [0x10, 0, 0, 0, 3, 0, 0, 1, 0, 0]),
  chunk('ALPH', [0x00, 0x11, 0x22]),
  chunk('VP8 ', vp8(4, 2, [0xdd, 0xee])),
);
/** A lossless still in the simple format, with no VP8X. */
const LOSSLESS = webp(chunk('VP8L', vp8l(2, 2, false, [0x01, 0x02, 0x03])));

function payloadOf(file: Uint8Array, code: string): Uint8Array {
  const found = readChunks(file).find((entry) => entry.fourcc === code);
  assert.ok(found, `no ${code} chunk`);
  return found.payload;
}

function uint24(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
}

/** An ANMF chunk's header fields and the chunks it wraps. */
function frameOf({ payload }: Chunk) {
  return {
    x: uint24(payload, 0) * 2,
    y: uint24(payload, 3) * 2,
    width: uint24(payload, 6) + 1,
    height: uint24(payload, 9) + 1,
    durationMs: uint24(payload, 12),
    flags: payload[15],
    inner: readChunks(webp([...payload.subarray(16)])),
  };
}

describe('readStill', () => {
  it('reads the size and image chunks of lossy, lossy-with-alpha and lossless stills', () => {
    const lossy = readStill(LOSSY);
    assert.deepEqual(
      [lossy.width, lossy.height, lossy.image.fourcc, lossy.alpha, lossy.hasAlpha],
      [8, 4, 'VP8 ', null, false],
    );
    const alpha = readStill(LOSSY_ALPHA);
    assert.deepEqual([alpha.width, alpha.height, alpha.alpha?.fourcc, alpha.hasAlpha], [4, 2, 'ALPH', true]);
    const lossless = readStill(LOSSLESS);
    assert.deepEqual(
      [lossless.width, lossless.height, lossless.image.fourcc, lossless.hasAlpha],
      [2, 2, 'VP8L', false],
    );
  });

  it('refuses a file that is not a WebP still', () => {
    assert.throws(() => readStill(Uint8Array.from(fourcc('GIF89a....'))), /Not a WebP file/);
    assert.throws(() => readStill(webp(chunk('ANIM', [0, 0, 0, 0, 0, 0]))), /already an animation/);
    assert.throws(() => readStill(webp(chunk('VP8 ', [0, 0, 0, 1, 2, 3, 4, 5, 6, 7]))), /key frame/);
  });
});

describe('animatedWebp', () => {
  const animation = animatedWebp(
    [
      { webp: LOSSY, durationMs: 67 },
      { webp: LOSSY_ALPHA, durationMs: 1500, x: 2, y: 2 },
      { webp: LOSSLESS, durationMs: 133, x: 6 },
    ],
    { width: 8, height: 4 },
  );

  it('writes a RIFF file whose size is its length less the RIFF header', () => {
    assert.equal(String.fromCharCode(...animation.subarray(0, 4)), 'RIFF');
    assert.equal(new DataView(animation.buffer).getUint32(4, true), animation.byteLength - 8);
    assert.equal(String.fromCharCode(...animation.subarray(8, 12)), 'WEBP');
    assert.deepEqual(
      readChunks(animation).map((entry) => entry.fourcc),
      ['VP8X', 'ANIM', 'ANMF', 'ANMF', 'ANMF'],
    );
  });

  it('marks the animation and its transparency in VP8X, with the canvas size, and loops forever', () => {
    const header = payloadOf(animation, 'VP8X');
    assert.equal(header.byteLength, 10);
    assert.equal(header[0], 0x02 | 0x10);
    assert.deepEqual([uint24(header, 4) + 1, uint24(header, 7) + 1], [8, 4]);
    const loop = payloadOf(animation, 'ANIM');
    assert.equal(loop.byteLength, 6);
    assert.equal(new DataView(loop.buffer, loop.byteOffset).getUint16(4, true), 0);
  });

  it('leaves out the transparency mark when no frame has transparency', () => {
    const opaque = animatedWebp([{ webp: LOSSY, durationMs: 100 }], { width: 8, height: 4 });
    assert.equal(payloadOf(opaque, 'VP8X')[0], 0x02);
  });

  it('writes each frame with its rectangle, its duration and no blending, around its own image chunks', () => {
    const frames = readChunks(animation)
      .filter((entry) => entry.fourcc === 'ANMF')
      .map(frameOf);
    assert.deepEqual(
      frames.map(({ x, y, width, height, durationMs, flags }) => ({ x, y, width, height, durationMs, flags })),
      [
        { x: 0, y: 0, width: 8, height: 4, durationMs: 67, flags: 0x02 },
        { x: 2, y: 2, width: 4, height: 2, durationMs: 1500, flags: 0x02 },
        { x: 6, y: 0, width: 2, height: 2, durationMs: 133, flags: 0x02 },
      ],
    );
    // The still's VP8X and ICC profile stay out; its ALPH comes before its image.
    assert.deepEqual(
      frames.map((frame) => frame.inner.map((entry) => entry.fourcc)),
      [['VP8 '], ['ALPH', 'VP8 '], ['VP8L']],
    );
    // Each bitstream is copied byte for byte.
    assert.deepEqual(frames[0]?.inner[0]?.payload, payloadOf(LOSSY, 'VP8 '));
    assert.deepEqual(frames[1]?.inner[0]?.payload, payloadOf(LOSSY_ALPHA, 'ALPH'));
    assert.deepEqual(frames[2]?.inner[0]?.payload, payloadOf(LOSSLESS, 'VP8L'));
  });

  it('sizes each frame chunk as its 16-byte header and its padded image chunks', () => {
    const sizes = readChunks(animation)
      .filter((entry) => entry.fourcc === 'ANMF')
      .map((entry) => entry.payload.byteLength);
    // VP8 of 13 bytes pads to 14; ALPH of 3 pads to 4 and VP8 of 12 does not; VP8L of 8 does not.
    assert.deepEqual(sizes, [16 + 8 + 14, 16 + 8 + 4 + 8 + 12, 16 + 8 + 8]);
  });

  it('refuses frames it cannot place', () => {
    const canvas = { width: 8, height: 4 };
    assert.throws(() => animatedWebp([], canvas), /at least one frame/);
    assert.throws(() => animatedWebp([{ webp: LOSSLESS, durationMs: 10, x: 1 }], canvas), /offset must be even/);
    assert.throws(() => animatedWebp([{ webp: LOSSY, durationMs: 10, x: 2 }], canvas), /does not fit the canvas/);
    assert.throws(() => animatedWebp([{ webp: LOSSY, durationMs: 0x1_000_000 }], canvas), /duration/);
  });
});
