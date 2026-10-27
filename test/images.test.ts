import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import {
  HIGH_RESOLUTION,
  STANDARD_RESOLUTION,
  fitImage,
  imageTokens,
  prepareImage,
  probeImage,
  resizeRGBA,
} from '../src/images.js';

function png(width: number, height: number, alpha = 255): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    const pixel = index / 4;
    image.data[index] = pixel % 256;
    image.data[index + 1] = (pixel >> 8) % 256;
    image.data[index + 2] = 90;
    image.data[index + 3] = alpha;
  }
  return PNG.sync.write(image);
}

function noisyJPEG(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < data.length; index++) data[index] = (index * 7919) % 251;
  return Buffer.from(jpeg.encode({ data, width, height }, 95).data);
}

describe('image preparation', () => {
  it('reads dimensions from PNG, JPEG, GIF and WebP headers', () => {
    expect(probeImage(png(3, 2))).toEqual({ mediaType: 'image/png', width: 3, height: 2 });
    expect(probeImage(noisyJPEG(17, 9))).toEqual({ mediaType: 'image/jpeg', width: 17, height: 9 });
    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1');
    expect(probeImage(gif)).toEqual({ mediaType: 'image/gif', width: 320, height: 240 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(1919, 24, 3);
    webp.writeUIntLE(1079, 27, 3);
    expect(probeImage(webp)).toEqual({ mediaType: 'image/webp', width: 1920, height: 1080 });
    expect(probeImage(Buffer.from('plain text file'))).toBeUndefined();
  });

  it('fits images to the edge and visual-token limits while keeping the aspect ratio', () => {
    expect(fitImage(1080, 1920, HIGH_RESOLUTION)).toEqual({ width: 1080, height: 1920 });
    const large = fitImage(3840, 2160, HIGH_RESOLUTION);
    expect(Math.max(large.width, large.height)).toBeLessThanOrEqual(2000);
    expect(imageTokens(large.width, large.height)).toBeLessThanOrEqual(4784);
    expect(large.width / large.height).toBeCloseTo(16 / 9, 1);
    const standard = fitImage(1920, 1080, STANDARD_RESOLUTION);
    expect(imageTokens(standard.width, standard.height)).toBeLessThanOrEqual(1568);
  });

  it('averages pixels when downscaling', () => {
    const source = Uint8Array.from([
      0, 0, 0, 255, 200, 100, 50, 255, 100, 100, 100, 255, 100, 0, 250, 255,
    ]);
    expect([...resizeRGBA(source, 2, 2, 1, 1)]).toEqual([100, 50, 100, 255]);
    const solid = new Uint8Array(10 * 6 * 4).fill(77);
    expect(new Set(resizeRGBA(solid, 10, 6, 3, 2))).toEqual(new Set([77]));
  });

  it('passes small images through byte for byte', () => {
    const data = png(64, 48);
    const prepared = prepareImage(data);
    expect(prepared.data).toBe(data);
    expect(prepared).toMatchObject({ mediaType: 'image/png', width: 64, height: 48 });
  });

  it('downscales and re-encodes large images as JPEG unless transparency matters', () => {
    const wide = prepareImage(png(2600, 400));
    expect(wide).toMatchObject({ mediaType: 'image/jpeg', width: 2000, height: 308 });
    expect(probeImage(wide.data)).toEqual({ mediaType: 'image/jpeg', width: 2000, height: 308 });
    expect(wide.original).toMatchObject({ width: 2600, height: 400, mediaType: 'image/png' });
    const transparent = prepareImage(png(2200, 300, 128));
    expect(transparent.mediaType).toBe('image/png');
    expect(Math.max(transparent.width, transparent.height)).toBe(2000);
    const heavy = noisyJPEG(1200, 1200);
    expect(heavy.length).toBeGreaterThan(1_000_000);
    const recompressed = prepareImage(heavy);
    expect(recompressed.data.length).toBeLessThan(heavy.length);
    expect(recompressed.mediaType).toBe('image/jpeg');
  });

  it('rejects files that are not images and oversized formats it cannot decode', () => {
    expect(() => prepareImage(Buffer.from('not an image'))).toThrow('Unsupported image');
    const gif = Buffer.alloc(8_000_000);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(9000, 6);
    gif.writeUInt16LE(9000, 8);
    expect(() => prepareImage(gif)).toThrow('Convert it to PNG or JPEG');
  });
});
