import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// Pure Node CRC32 + PNG encoder (zero external dependencies)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crcVal = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function blendPixel(buf, width, height, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= width || y >= height || a <= 0) return;
  const idx = (y * width + x) * 4;
  const alpha = Math.min(1, a);
  const inv = 1 - alpha;
  buf[idx] = Math.round(buf[idx] * inv + r * alpha);
  buf[idx + 1] = Math.round(buf[idx + 1] * inv + g * alpha);
  buf[idx + 2] = Math.round(buf[idx + 2] * inv + b * alpha);
  buf[idx + 3] = Math.round(Math.min(255, buf[idx + 3] + alpha * (255 - buf[idx + 3])));
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function drawCapsule(buf, size, x1, y1, x2, y2, radius, color) {
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - radius - 2));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(x1, x2) + radius + 2));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - radius - 2));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(y1, y2) + radius + 2));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = distToSegment(x + 0.5, y + 0.5, x1, y1, x2, y2);
      const cov = Math.max(0, Math.min(1, radius + 0.6 - d));
      if (cov > 0) blendPixel(buf, size, size, x, y, color[0], color[1], color[2], cov);
    }
  }
}

function drawCircle(buf, size, cx, cy, radius, color) {
  const minX = Math.max(0, Math.floor(cx - radius - 2));
  const maxX = Math.min(size - 1, Math.ceil(cx + radius + 2));
  const minY = Math.max(0, Math.floor(cy - radius - 2));
  const maxY = Math.min(size - 1, Math.ceil(cy + radius + 2));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = Math.max(0, Math.min(1, radius + 0.6 - d));
      if (cov > 0) blendPixel(buf, size, size, x, y, color[0], color[1], color[2], cov);
    }
  }
}

function renderTransitIcon(size, maskable = false) {
  const buf = Buffer.alloc(size * size * 4);
  const bg = [15, 23, 42]; // #0F172A
  const cornerRadius = maskable ? 0 : size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let alpha = 1;
      if (cornerRadius > 0) {
        const cx = Math.min(Math.max(x + 0.5, cornerRadius), size - cornerRadius);
        const cy = Math.min(Math.max(y + 0.5, cornerRadius), size - cornerRadius);
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (x + 0.5 !== cx && y + 0.5 !== cy) {
          alpha = Math.max(0, Math.min(1, cornerRadius + 0.6 - d));
        }
      }
      const idx = (y * size + x) * 4;
      buf[idx] = bg[0];
      buf[idx + 1] = bg[1];
      buf[idx + 2] = bg[2];
      buf[idx + 3] = Math.round(alpha * 255);
    }
  }

  // Scale into safe-zone (70% for maskable -> 15% padding on all sides; 86% for standard)
  const scale = maskable ? 0.68 : 0.88;
  const offset = (size * (1 - scale)) / 2;
  const pt = (nx, ny) => [offset + nx * size * scale, offset + ny * size * scale];
  const stroke = size * scale * 0.068;

  // Stylized Sierra Nevada backdrop triangles
  const s1 = pt(0.14, 0.72);
  const s2 = pt(0.35, 0.42);
  const s3 = pt(0.50, 0.56);
  const s4 = pt(0.68, 0.30);
  const s5 = pt(0.86, 0.72);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // simple barycentric check for mountain silhouette
      const inLeft =
        x >= s1[0] &&
        x <= s3[0] &&
        y <= s1[1] &&
        y >= (x < s2[0] ? s1[1] + ((s2[1] - s1[1]) * (x - s1[0])) / (s2[0] - s1[0]) : s2[1] + ((s3[1] - s2[1]) * (x - s2[0])) / (s3[0] - s2[0]));
      const inRight =
        x >= s3[0] &&
        x <= s5[0] &&
        y <= s5[1] &&
        y >= (x < s4[0] ? s3[1] + ((s4[1] - s3[1]) * (x - s3[0])) / (s4[0] - s3[0]) : s4[1] + ((s5[1] - s4[1]) * (x - s4[0])) / (s5[0] - s4[0]));
      if (inLeft || inRight) {
        blendPixel(buf, size, size, x, y, 30, 41, 59, 0.9);
      }
    }
  }

  // Red Urban Bus route
  const r1 = pt(0.16, 0.38);
  const r2 = pt(0.58, 0.38);
  const r3 = pt(0.66, 0.48);
  const r4 = pt(0.66, 0.66);
  const red = [220, 38, 38];
  drawCapsule(buf, size, r1[0], r1[1], r2[0], r2[1], stroke, red);
  drawCapsule(buf, size, r2[0], r2[1], r3[0], r3[1], stroke, red);
  drawCapsule(buf, size, r3[0], r3[1], r4[0], r4[1], stroke, red);

  // Emerald Metro diagonal line
  const m1 = pt(0.28, 0.78);
  const m2 = pt(0.50, 0.52);
  const m3 = pt(0.70, 0.26);
  const m4 = pt(0.84, 0.26);
  const emerald = [5, 150, 105];
  drawCapsule(buf, size, m1[0], m1[1], m2[0], m2[1], stroke, emerald);
  drawCapsule(buf, size, m2[0], m2[1], m3[0], m3[1], stroke, emerald);
  drawCapsule(buf, size, m3[0], m3[1], m4[0], m4[1], stroke, emerald);

  // Station nodes
  const white = [248, 250, 252];
  const nodeR = stroke * 1.45;
  const innerR = stroke * 0.78;
  drawCircle(buf, size, m1[0], m1[1], nodeR, emerald);
  drawCircle(buf, size, m1[0], m1[1], innerR, white);

  drawCircle(buf, size, m2[0], m2[1], nodeR * 1.1, bg);
  drawCircle(buf, size, m2[0], m2[1], innerR * 1.1, white);

  drawCircle(buf, size, r4[0], r4[1], nodeR, red);
  drawCircle(buf, size, r4[0], r4[1], innerR, white);

  drawCircle(buf, size, m4[0], m4[1], nodeR, emerald);
  drawCircle(buf, size, m4[0], m4[1], innerR, white);

  return encodePNG(size, size, buf);
}

fs.writeFileSync(path.join(PUBLIC_DIR, 'pwa-192x192.png'), renderTransitIcon(192, false));
fs.writeFileSync(path.join(PUBLIC_DIR, 'pwa-512x512.png'), renderTransitIcon(512, false));
fs.writeFileSync(path.join(PUBLIC_DIR, 'pwa-maskable-512x512.png'), renderTransitIcon(512, true));
fs.writeFileSync(path.join(PUBLIC_DIR, 'apple-touch-icon.png'), renderTransitIcon(180, true));

console.log('Generated PWA icons in /public successfully.');
