import { createRequire } from 'node:module';
import type { PNG as PNGCodec } from 'pngjs';
import type jpegCodec from 'jpeg-js';

// The codecs load on first use: most sessions never decode an image.
const require = createRequire(import.meta.url);
let codecs: { PNG: typeof PNGCodec; jpeg: typeof jpegCodec } | undefined;
function load() {
  codecs ??= {
    PNG: (require('pngjs') as { PNG: typeof PNGCodec }).PNG,
    jpeg: require('jpeg-js') as typeof jpegCodec,
  };
  return codecs;
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageInfo {
  mediaType: ImageMediaType;
  width: number;
  height: number;
}

export interface PreparedImage extends ImageInfo {
  data: Buffer;
  original: ImageInfo & { bytes: number };
}

export interface ImageLimits {
  /** Longest side sent; 2000 px keeps requests with more than 20 images valid. */
  maxEdge: number;
  /** Visual tokens (28 px patches) the model reads before it downsizes on its own. */
  maxTokens: number;
  /** Larger files are re-encoded even when their dimensions already fit. */
  maxBytes: number;
}

export const HIGH_RESOLUTION: ImageLimits = { maxEdge: 2000, maxTokens: 4784, maxBytes: 1_000_000 };
export const STANDARD_RESOLUTION: ImageLimits = {
  maxEdge: 1568,
  maxTokens: 1568,
  maxBytes: 1_000_000,
};
/** Base64 grows data by a third; the API accepts at most 10 MB of base64 per image. */
const MAX_SENT_BYTES = 7_000_000;
const REENCODED_BYTES = 700_000;

export function imageTokens(width: number, height: number): number {
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}

/** Read format and dimensions from the file header without decoding pixels. */
export function probeImage(data: Buffer): ImageInfo | undefined {
  if (
    data.length >= 24 &&
    data.readUInt32BE(0) === 0x89504e47 &&
    data.readUInt32BE(4) === 0x0d0a1a0a
  ) {
    return { mediaType: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 10 && data.toString('latin1', 0, 4) === 'GIF8') {
    return { mediaType: 'image/gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (
    data.length >= 30 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  ) {
    const chunk = data.toString('latin1', 12, 16);
    if (chunk === 'VP8X')
      return {
        mediaType: 'image/webp',
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      };
    if (chunk === 'VP8 ')
      return {
        mediaType: 'image/webp',
        width: data.readUInt16LE(26) & 0x3fff,
        height: data.readUInt16LE(28) & 0x3fff,
      };
    if (chunk === 'VP8L') {
      const bits = data.readUInt32LE(21);
      return {
        mediaType: 'image/webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    return undefined;
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = data[offset + 1]!;
      // Start-of-frame markers carry the dimensions; DHT, JPG and DAC share the range.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          mediaType: 'image/jpeg',
          width: data.readUInt16BE(offset + 7),
          height: data.readUInt16BE(offset + 5),
        };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      offset += 2 + data.readUInt16BE(offset + 2);
    }
  }
  return undefined;
}

/** Largest size within the limits that keeps the aspect ratio. */
export function fitImage(
  width: number,
  height: number,
  limits: ImageLimits,
): { width: number; height: number } {
  let scale = Math.min(1, limits.maxEdge / Math.max(width, height));
  while (imageTokens(Math.round(width * scale), Math.round(height * scale)) > limits.maxTokens)
    scale *= 0.98;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Weighted average over one axis; `step` is the distance between neighbors on that axis. */
function averageAxis(
  input: ArrayLike<number>,
  output: Float32Array,
  inLength: number,
  outLength: number,
  lines: number,
  lineStep: number,
  step: number,
  outLineStep: number,
  outStep: number,
): void {
  // Each output sample covers `ratio` input samples; precompute the overlaps once per axis.
  const ratio = inLength / outLength;
  const span = Math.ceil(ratio) + 1;
  const starts = new Int32Array(outLength);
  const counts = new Int32Array(outLength);
  const weights = new Float32Array(outLength * span);
  for (let position = 0; position < outLength; position++) {
    const start = position * ratio;
    const end = Math.min(inLength, start + ratio);
    const first = Math.floor(start);
    starts[position] = first;
    let count = 0;
    for (let at = first; at < end; at++, count++)
      weights[position * span + count] = (Math.min(end, at + 1) - Math.max(start, at)) / ratio;
    counts[position] = count;
  }
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    const outBase = line * outLineStep;
    for (let position = 0; position < outLength; position++) {
      let index = base + starts[position]! * step;
      const offset = position * span;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0, count = counts[position]!; k < count; k++, index += step) {
        const weight = weights[offset + k]!;
        r += input[index]! * weight;
        g += input[index + 1]! * weight;
        b += input[index + 2]! * weight;
        a += input[index + 3]! * weight;
      }
      const target = outBase + position * outStep;
      output[target] = r;
      output[target + 1] = g;
      output[target + 2] = b;
      output[target + 3] = a;
    }
  }
}

/** Area-average downscale of RGBA pixels, one axis at a time. */
export function resizeRGBA(
  source: ArrayLike<number>,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  const rows = new Float32Array(targetWidth * height * 4);
  averageAxis(source, rows, width, targetWidth, height, width * 4, 4, targetWidth * 4, 4);
  const result = new Float32Array(targetWidth * targetHeight * 4);
  averageAxis(
    rows,
    result,
    height,
    targetHeight,
    targetWidth,
    4,
    targetWidth * 4,
    4,
    targetWidth * 4,
  );
  const clamped = new Uint8ClampedArray(result);
  return new Uint8Array(clamped.buffer, clamped.byteOffset, clamped.length);
}

function decode(data: Buffer, info: ImageInfo): { pixels: Uint8Array; alpha: boolean } {
  if (info.mediaType === 'image/png') {
    const png = load().PNG.sync.read(data);
    let alpha = false;
    for (let index = 3; index < png.data.length; index += 4)
      if (png.data[index]! < 255) {
        alpha = true;
        break;
      }
    return { pixels: png.data, alpha };
  }
  const image = load().jpeg.decode(data, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 120,
    maxMemoryUsageInMB: 1024,
  });
  return { pixels: image.data, alpha: false };
}

function encodePNG(pixels: Uint8Array, width: number, height: number): Buffer {
  const { PNG } = load();
  const image = new PNG({ width, height });
  image.data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length);
  return PNG.sync.write(image, { colorType: 6 });
}

/** Lower the quality only as far as needed to keep a resent image small. */
function encodeJPEG(pixels: Uint8Array, width: number, height: number): Buffer {
  let encoded = Buffer.alloc(0);
  for (const quality of [85, 75, 60]) {
    encoded = Buffer.from(load().jpeg.encode({ data: pixels, width, height }, quality).data);
    if (encoded.length <= REENCODED_BYTES) break;
  }
  return encoded;
}

/**
 * Prepare an image for a model request. Images within the limits pass through byte for byte;
 * larger PNG and JPEG files are downscaled and re-encoded (JPEG unless transparency matters).
 */
export function prepareImage(data: Buffer, limits: ImageLimits = HIGH_RESOLUTION): PreparedImage {
  const info = probeImage(data);
  if (!info || !info.width || !info.height)
    throw new Error('Unsupported image. Use PNG, JPEG, GIF or WebP.');
  const original = { ...info, bytes: data.length };
  const target = fitImage(info.width, info.height, limits);
  const fits = target.width === info.width && target.height === info.height;
  if (fits && data.length <= limits.maxBytes) return { ...info, data, original };
  if (info.mediaType === 'image/gif' || info.mediaType === 'image/webp') {
    if (
      data.length <= MAX_SENT_BYTES &&
      imageTokens(info.width, info.height) <= 50_000 &&
      Math.max(info.width, info.height) <= 8000
    )
      return { ...info, data, original };
    throw new Error(
      `${info.mediaType === 'image/gif' ? 'GIF' : 'WebP'} image is too large (${info.width}×${info.height}). Convert it to PNG or JPEG first, for example with ffmpeg.`,
    );
  }
  const { pixels, alpha } = decode(data, info);
  // Re-encoded images are resent with every later request, so keep each one compact.
  let size = target;
  for (let attempt = 0; ; attempt++) {
    const resized =
      size.width === info.width && size.height === info.height
        ? pixels
        : resizeRGBA(pixels, info.width, info.height, size.width, size.height);
    const encoded = alpha
      ? encodePNG(resized, size.width, size.height)
      : encodeJPEG(resized, size.width, size.height);
    if (encoded.length <= REENCODED_BYTES || attempt === 3) {
      if (encoded.length > MAX_SENT_BYTES)
        throw new Error('Image is still too large after resizing.');
      return { mediaType: alpha ? 'image/png' : 'image/jpeg', ...size, data: encoded, original };
    }
    size = {
      width: Math.max(1, Math.round(size.width * 0.75)),
      height: Math.max(1, Math.round(size.height * 0.75)),
    };
  }
}
