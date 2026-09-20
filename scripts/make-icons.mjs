/**
 * Generates the PWA icon set.
 *
 * Draws the mark as a small pixel grid and scales it up with nearest-neighbour
 * sampling, then writes real PNGs with a minimal encoder - no image library, so
 * `npm install` stays to three dev dependencies.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public/icons');

const PALETTE = {
  '.': null,
  b: '#1d2b3a', // background
  d: '#16212d', // background shade
  g: '#63a04a', // grass
  G: '#4f8038', // grass shade
  s: '#d9c48c', // sand
  w: '#3f8fa8', // water
  W: '#2e6c82', // deep water
  t: '#7a5c3c', // timber
  r: '#c39a55', // thatch
  p: '#e3d5b8', // plaster
  y: '#f6d98a', // window
  k: '#5a4028', // trunk
  f: '#3f6b42', // foliage
};

/** 32x32 mark: a slice of island with a cottage and a pine. */
const ART = [
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'bbbbbbbbbbbbrrrrrbbbbbbbbbbbbbbb',
  'bbbbbbbbbbbrrrrrrrbbbbbbbbbbbbbb',
  'bbbbbbbbbbrrrrrrrrrbbbbbbbbbbbbb',
  'bbbbbbbbbrrrrrrrrrrrbbbbbbbbbbbb',
  'bbbbbbbbrrrrrrrrrrrrrbbbfbbbbbbb',
  'bbbbbbbbbtppppppppptbbbfffbbbbbb',
  'bbbbbbbbbtpyypppyyptbbfffffbbbbb',
  'bbbbbbbbbtpyypppyyptbbbfffbbbbbb',
  'bbbbbbbbbtpppppppptbbffffffbbbbb',
  'bbbbbbbbbtpptttpppbbbbbfffbbbbbb',
  'bbbbbbbbbtpptttppptbbbbbkbbbbbbb',
  'bbbbbbbbgggggggggggggggkkgggbbbb',
  'bbbbbbbgggggggggggggggggggggggbb',
  'bbbbbbggggggggggggggggggggggggbb',
  'bbbbbGGGGGGGGGGGGGGGGGGGGGGGGGgb',
  'bbbbsGGGGGGGGGGGGGGGGGGGGGGGGGsb',
  'bbbbssssssssssssssssssssssssssbb',
  'bbbwwsssssssssssssssssssssssswwb',
  'bbwwwwwwwwwwwwwwwwwwwwwwwwwwwwwb',
  'bwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwb',
  'bWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWb',
  'bbWWWWWWWWWWWWWWWWWWWWWWWWWWWWbb',
  'bbbWWWWWWWWWWWWWWWWWWWWWWWWWWbbb',
  'bbbbbWWWWWWWWWWWWWWWWWWWWWWbbbbb',
  'bbbbbbbbWWWWWWWWWWWWWWWWbbbbbbbb',
  'ddddddddddddddddddddddddddddddddd'.slice(0, 32),
  'dddddddddddddddddddddddddddddddd',
  'dddddddddddddddddddddddddddddddd',
];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC = crcTable();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(size) {
  const source = ART.length;
  const rgba = Buffer.alloc(size * size * 4);
  const scale = size / source;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.min(source - 1, Math.floor(x / scale));
      const sy = Math.min(source - 1, Math.floor(y / scale));
      const key = ART[sy][sx] ?? 'b';
      const hex = PALETTE[key] ?? PALETTE.b;
      const [r, g, b] = hexToRgb(hex);
      const offset = (y * size + x) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(outDir, { recursive: true });
const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
  ['favicon.png', 64],
  ['maskable-512.png', 512],
];

for (const [name, size] of targets) {
  writeFileSync(resolve(outDir, name), render(size));
  console.log(`wrote icons/${name} (${size}x${size})`);
}
