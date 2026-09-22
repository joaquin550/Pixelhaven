/**
 * Deterministic pseudo-random number generation.
 *
 * Every world in Pixel Haven is reproducible from a single seed string, which
 * means a save file only has to store the seed plus the mutable state on top of
 * it rather than the whole terrain.
 */

/** Hashes an arbitrary string into a 32-bit unsigned integer seed. */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type RandomFn = () => number;

/** Small, fast, well-distributed 32-bit PRNG. */
export function mulberry32(seed: number): RandomFn {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience wrapper with the helpers the simulation reaches for constantly. */
export class Rng {
  private next: RandomFn;

  constructor(seed: number | string) {
    this.next = mulberry32(typeof seed === 'string' ? hashSeed(seed) : seed);
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(min + this.next() * (max - min + 1));
  }

  /** True with the given probability. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length) % items.length];
  }

  /** Picks an item using per-item weights. Falls back to the last item. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}

/** Process-wide RNG for purely cosmetic rolls that never need to be replayed. */
export const cosmeticRng = new Rng(Date.now() & 0xffffffff);
