/**
 * Seeded 2D value/Perlin noise used for terrain, moisture and weather drift.
 *
 * Perlin (rather than simplex) keeps the implementation short and patent-free,
 * and the directional artefacts it is criticised for are invisible once the
 * height field is quantised into voxel steps.
 */
import { mulberry32 } from './rng';

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class Noise2D {
  private perm: Uint8Array;
  private gradX: Float32Array;
  private gradY: Float32Array;

  constructor(seed: number) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];

    // Unit gradient vectors, one per permutation slot.
    this.gradX = new Float32Array(256);
    this.gradY = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const angle = rand() * Math.PI * 2;
      this.gradX[i] = Math.cos(angle);
      this.gradY[i] = Math.sin(angle);
    }
  }

  /** Raw noise in roughly [-1, 1]. */
  sample(x: number, y: number): number {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);

    const u = fade(xf);
    const v = fade(yf);

    const aa = this.perm[this.perm[xi] + yi];
    const ab = this.perm[this.perm[xi] + yi + 1];
    const ba = this.perm[this.perm[xi + 1] + yi];
    const bb = this.perm[this.perm[xi + 1] + yi + 1];

    const dot = (h: number, dx: number, dy: number) => this.gradX[h] * dx + this.gradY[h] * dy;

    const x1 = lerp(dot(aa, xf, yf), dot(ba, xf - 1, yf), u);
    const x2 = lerp(dot(ab, xf, yf - 1), dot(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }

  /** Fractal Brownian motion: layered noise, normalised to roughly [-1, 1]. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.sample(x * frequency, y * frequency) * amplitude;
      norm += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return norm === 0 ? 0 : sum / norm;
  }

  /** Ridged noise, good for mountain spines. */
  ridged(x: number, y: number, octaves = 4): number {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.sample(x * frequency, y * frequency));
      sum += n * n * amplitude;
      norm += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }
    return norm === 0 ? 0 : sum / norm;
  }
}
