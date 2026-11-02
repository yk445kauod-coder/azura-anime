/**
 * Minimal PNG encoder, used to embed charts in DOCX exports.
 *
 * DOCX cannot carry vector graphics without the full DrawingML chart schema,
 * and shipping an image encoder as a dependency is not worth it for the two
 * shapes we draw, so this writes PNG directly. Deflate "stored" blocks are
 * valid zlib, so no compression library is needed — chart images are small and
 * the export is not on a hot path.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  const body = new Uint8Array(t.length + data.length);
  body.set(t, 0);
  body.set(data, t.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 4 + body.length);
  return out;
}

/** Wrap raw bytes in a zlib stream made of stored deflate blocks. */
function zlibStore(raw: Uint8Array): Uint8Array {
  const MAX = 65535;
  const blocks: Uint8Array[] = [];
  for (let off = 0; off < raw.length; off += MAX) {
    const len = Math.min(MAX, raw.length - off);
    const final = off + len >= raw.length ? 1 : 0;
    const head = new Uint8Array(5);
    head[0] = final;
    head[1] = len & 0xff;
    head[2] = (len >>> 8) & 0xff;
    head[3] = ~len & 0xff;
    head[4] = (~len >>> 8) & 0xff;
    blocks.push(head, raw.subarray(off, off + len));
  }
  if (!blocks.length) blocks.push(new Uint8Array([1, 0, 0, 0xff, 0xff]));
  const body = concat(blocks);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; // CMF: deflate, 32K window
  out[1] = 0x01; // FLG: no dict, fastest
  out.set(body, 2);
  out.set(u32(adler32(raw)), 2 + body.length);
  return out;
}

/**
 * zlib-compress using the runtime's CompressionStream.
 *
 * PNG's IDAT must be a zlib stream, and a raw scanline buffer is far too large
 * to store uncompressed (a 1440x660 chart is ~2.8 MB). `deflate` is zlib-wrapped
 * deflate, which is exactly the required format. Falls back to stored blocks
 * where CompressionStream is unavailable.
 */
async function zlibCompress(raw: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return zlibStore(raw);
  try {
    const cs = new CompressionStream("deflate");
    const writer = cs.writable.getWriter();
    void writer.write(raw);
    void writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return zlibStore(raw);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export type Canvas = {
  width: number;
  height: number;
  data: Uint8Array; // RGB, 3 bytes per pixel
};

export function createCanvas(width: number, height: number, bg: [number, number, number]): Canvas {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = bg[0];
    data[i * 3 + 1] = bg[1];
    data[i * 3 + 2] = bg[2];
  }
  return { width, height, data };
}

export function setPixel(c: Canvas, x: number, y: number, rgb: [number, number, number]): void {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const i = (y * c.width + x) * 3;
  c.data[i] = rgb[0];
  c.data[i + 1] = rgb[1];
  c.data[i + 2] = rgb[2];
}

export function fillRect(c: Canvas, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(c.width, Math.round(x + w)), y1 = Math.min(c.height, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    const row = yy * c.width;
    for (let xx = x0; xx < x1; xx++) {
      const i = (row + xx) * 3;
      c.data[i] = rgb[0];
      c.data[i + 1] = rgb[1];
      c.data[i + 2] = rgb[2];
    }
  }
}

/** Bresenham line; `thickness` grows the stroke symmetrically. */
export function drawLine(
  c: Canvas, x0: number, y0: number, x1: number, y1: number,
  rgb: [number, number, number], thickness = 1,
): void {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const half = Math.floor(thickness / 2);
  for (;;) {
    for (let oy = -half; oy <= half; oy++)
      for (let ox = -half; ox <= half; ox++) setPixel(c, x0 + ox, y0 + oy, rgb);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

export function drawCircle(c: Canvas, cx: number, cy: number, r: number, rgb: [number, number, number]): void {
  const rr = Math.round(r);
  for (let y = -rr; y <= rr; y++)
    for (let x = -rr; x <= rr; x++)
      if (x * x + y * y <= rr * rr) setPixel(c, cx + x, cy + y, rgb);
}

export async function encodePng(c: Canvas): Promise<Uint8Array> {
  const { width, height, data } = c;
  const stride = width * 3;
  // Each scanline is prefixed with a filter byte; 0 means "no filter", which
  // deflate handles well for the flat colour regions a chart is made of.
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour RGB
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlibCompress(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// ------------------------------------------------------------ 5x7 bitmap font

/**
 * Uppercase-only 5x7 font for axis labels and tick values.
 *
 * Charts need legible numbers and short labels; drawing them keeps the PNG
 * self-describing instead of relying on a caption to say what the axes mean.
 * Lowercase is folded to uppercase, which is conventional for chart labels.
 */
const GLYPHS: Record<string, number[]> = {
  "0": [0x1f, 0x11, 0x11, 0x11, 0x1f], "1": [0x04, 0x0c, 0x04, 0x04, 0x0e],
  "2": [0x1f, 0x01, 0x1f, 0x10, 0x1f], "3": [0x1f, 0x01, 0x0f, 0x01, 0x1f],
  "4": [0x11, 0x11, 0x1f, 0x01, 0x01], "5": [0x1f, 0x10, 0x1f, 0x01, 0x1f],
  "6": [0x1f, 0x10, 0x1f, 0x11, 0x1f], "7": [0x1f, 0x01, 0x02, 0x04, 0x04],
  "8": [0x1f, 0x11, 0x1f, 0x11, 0x1f], "9": [0x1f, 0x11, 0x1f, 0x01, 0x1f],
  ".": [0x00, 0x00, 0x00, 0x0c, 0x0c], "-": [0x00, 0x00, 0x0e, 0x00, 0x00],
  "+": [0x04, 0x04, 0x1f, 0x04, 0x04], "%": [0x11, 0x02, 0x04, 0x08, 0x11],
  "/": [0x01, 0x02, 0x04, 0x08, 0x10], "(": [0x02, 0x04, 0x04, 0x04, 0x02],
  ")": [0x08, 0x04, 0x04, 0x04, 0x08], ",": [0x00, 0x00, 0x00, 0x04, 0x08],
  ":": [0x00, 0x0c, 0x00, 0x0c, 0x00], "=": [0x00, 0x1f, 0x00, 0x1f, 0x00],
  " ": [0, 0, 0, 0, 0], "_": [0x00, 0x00, 0x00, 0x00, 0x1f],
  A: [0x0e, 0x11, 0x1f, 0x11, 0x11], B: [0x1e, 0x11, 0x1e, 0x11, 0x1e],
  C: [0x0f, 0x10, 0x10, 0x10, 0x0f], D: [0x1e, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x1e, 0x10, 0x1f], F: [0x1f, 0x10, 0x1e, 0x10, 0x10],
  G: [0x0f, 0x10, 0x13, 0x11, 0x0f], H: [0x11, 0x11, 0x1f, 0x11, 0x11],
  I: [0x1f, 0x04, 0x04, 0x04, 0x1f], J: [0x01, 0x01, 0x01, 0x11, 0x0e],
  K: [0x11, 0x12, 0x1c, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x11, 0x11], N: [0x11, 0x19, 0x15, 0x13, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x1e, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x1e, 0x12, 0x11],
  S: [0x0f, 0x10, 0x0e, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x15, 0x1b, 0x11], X: [0x11, 0x0a, 0x04, 0x0a, 0x11],
  Y: [0x11, 0x0a, 0x04, 0x04, 0x04], Z: [0x1f, 0x02, 0x04, 0x08, 0x1f],
};

export function textWidth(s: string, scale = 1): number {
  return s.length * 6 * scale;
}

export function drawText(
  c: Canvas, x: number, y: number, s: string,
  rgb: [number, number, number], scale = 1,
): void {
  let cx = Math.round(x);
  for (const raw of s) {
    const ch = raw.toUpperCase();
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (let row = 0; row < 5; row++) {
        const bits = glyph[row];
        for (let col = 0; col < 5; col++) {
          if (bits & (1 << (4 - col))) {
            if (scale === 1) setPixel(c, cx + col, y + row, rgb);
            else fillRect(c, cx + col * scale, y + row * scale, scale, scale, rgb);
          }
        }
      }
    }
    cx += 6 * scale;
  }
}
