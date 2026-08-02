/**
 * PNG decode, encode and diff, with no dependency.
 *
 * Comparing two screenshots needs a decoder, and Bun ships none. Adding
 * pngjs and pixelmatch would work but would contradict the one promise
 * printed on the box, so the format is parsed here: node:zlib does the
 * inflate, the rest is chunk parsing, scanline unfiltering and a CRC.
 *
 * Scope is deliberate. Simulator and device screenshots are 8-bit
 * non-interlaced greyscale, RGB or RGBA, and that is exactly what is
 * supported. Anything else fails with a message naming what it found
 * rather than returning wrong pixels.
 */

import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };
const COLOR_TYPE_NAMES = {
  0: "greyscale",
  2: "RGB",
  3: "palette",
  4: "greyscale+alpha",
  6: "RGBA",
};

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

const crc32 = (bytes) => {
  let crc = -1;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
};

const readUint32 = (bytes, offset) =>
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/** Reverses the per-scanline filter PNG applies before compressing */
const unfilter = (raw, width, height, bytesPerPixel) => {
  const stride = width * bytesPerPixel;
  const out = new Uint8Array(stride * height);
  let position = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[position];
    position += 1;
    const start = row * stride;
    const previous = start - stride;
    for (let index = 0; index < stride; index += 1) {
      const value = raw[position + index];
      const left = index >= bytesPerPixel ? out[start + index - bytesPerPixel] : 0;
      const up = row > 0 ? out[previous + index] : 0;
      const upLeft = row > 0 && index >= bytesPerPixel ? out[previous + index - bytesPerPixel] : 0;
      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: restored = value + paeth(left, up, upLeft); break;
        default: throw new Error(`Unsupported PNG scanline filter: ${filter}`);
      }
      out[start + index] = restored & 0xff;
    }
    position += stride;
  }
  return out;
};

/** Always returns 4 channels: comparing is simpler on one shape */
const toRgba = (pixels, width, height, colorType) => {
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (channels === 4) return pixels;
  const out = new Uint8Array(width * height * 4);
  for (let index = 0, target = 0; target < out.length; index += channels, target += 4) {
    if (colorType === 0) {
      out[target] = out[target + 1] = out[target + 2] = pixels[index];
      out[target + 3] = 255;
    } else if (colorType === 2) {
      out[target] = pixels[index];
      out[target + 1] = pixels[index + 1];
      out[target + 2] = pixels[index + 2];
      out[target + 3] = 255;
    } else {
      out[target] = out[target + 1] = out[target + 2] = pixels[index];
      out[target + 3] = pixels[index + 1];
    }
  }
  return out;
};

export const decodePng = (buffer) => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 8 || SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("Not a PNG file");
  }

  let header = null;
  const dataChunks = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const start = offset + 8;
    if (type === "IHDR") {
      header = {
        width: readUint32(bytes, start),
        height: readUint32(bytes, start + 4),
        bitDepth: bytes[start + 8],
        colorType: bytes[start + 9],
        interlace: bytes[start + 12],
      };
    } else if (type === "IDAT") {
      dataChunks.push(bytes.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4; // skip the chunk CRC
  }

  if (!header) throw new Error("PNG without an IHDR chunk");
  if (header.bitDepth !== 8) {
    throw new Error(`Only 8-bit PNGs are supported, found ${header.bitDepth}-bit`);
  }
  if (header.interlace !== 0) {
    throw new Error("Interlaced (Adam7) PNGs are not supported");
  }
  const channels = CHANNELS_BY_COLOR_TYPE[header.colorType];
  if (!channels) {
    throw new Error(
      `Unsupported PNG colour type ${header.colorType} (${COLOR_TYPE_NAMES[header.colorType] ?? "unknown"})`
    );
  }
  if (!dataChunks.length) throw new Error("PNG without image data");

  const compressed = Buffer.concat(dataChunks.map((chunk) => Buffer.from(chunk)));
  const raw = new Uint8Array(inflateSync(compressed));
  const pixels = unfilter(raw, header.width, header.height, channels);
  return {
    width: header.width,
    height: header.height,
    data: toRgba(pixels, header.width, header.height, header.colorType),
  };
};

const chunk = (type, payload) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(payload)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(payload.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

export const encodePng = (width, height, rgba) => {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0; // filter "none": the diff image is not worth optimising
    Buffer.from(rgba.buffer ?? rgba, rgba.byteOffset ?? 0, rgba.length).copy(
      raw,
      row * (stride + 1) + 1,
      row * stride,
      row * stride + stride
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** Rec. 601 luma: a hue shift at equal brightness matters less to a human
 * eye than a brightness shift, and a pure per-channel delta ignores that */
const luma = (data, index) =>
  0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];

/**
 * Compares two decoded images. Returns the changed ratio, the bounding
 * box of the change and, on request, a diff image with the changed
 * pixels marked. The bounding box is what makes the result explainable:
 * a region can be attributed to the component that owns it.
 */
export const diffImages = (before, after, options = {}) => {
  if (before.width !== after.width || before.height !== after.height) {
    return {
      comparable: false,
      reason: `Different dimensions: baseline ${before.width}x${before.height}, current ${after.width}x${after.height}`,
      changedPixels: null,
      ratio: null,
      bbox: null,
    };
  }
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 8;
  const { width, height } = before;
  const diff = options.withImage ? new Uint8Array(width * height * 4) : null;

  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const delta = Math.abs(luma(before.data, index) - luma(after.data, index));
      const alphaDelta = Math.abs(before.data[index + 3] - after.data[index + 3]);
      const differs = delta > threshold || alphaDelta > threshold;
      if (differs) {
        changed += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      if (diff) {
        if (differs) {
          diff[index] = 255;
          diff[index + 1] = 0;
          diff[index + 2] = 0;
          diff[index + 3] = 255;
        } else {
          // Dim the unchanged background so the change reads at a glance
          const grey = Math.round(luma(after.data, index) * 0.25 + 190);
          diff[index] = diff[index + 1] = diff[index + 2] = Math.min(255, grey);
          diff[index + 3] = 255;
        }
      }
    }
  }

  const total = width * height;
  return {
    comparable: true,
    width,
    height,
    changedPixels: changed,
    ratio: changed / total,
    bbox: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    image: diff ? encodePng(width, height, diff) : null,
  };
};
