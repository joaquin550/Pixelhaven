import { describe, expect, it } from 'vitest';
import { Rng, hashSeed, mulberry32 } from '../src/core/rng';
import { Noise2D } from '../src/core/noise';
import { SECONDS_PER_DAY, WorldClock, daylightFor } from '../src/core/time';
import { angleDelta, clamp, damp, formatCount, formatDuration, smoothstep } from '../src/core/mathx';
import { Terrain } from '../src/world/terrain';
import { NavGrid } from '../src/world/navgrid';
import { Occupancy, WATER_LEVEL, WORLD_SIZE } from '../src/world/constants';
import { combineTraits, inferVocation } from '../src/sim/traits';

describe('random and noise', () => {
  it('is reproducible from a seed', () => {
    const a = new Rng('same');
    const b = new Rng('same');
    const first = Array.from({ length: 20 }, () => a.float());
    const second = Array.from({ length: 20 }, () => b.float());
    expect(first).toEqual(second);
    expect(new Rng('different').float()).not.toBe(first[0]);
  });

  it('produces values in range', () => {
    const rng = new Rng(42);
    for (let i = 0; i < 500; i++) {
      const f = rng.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = rng.int(3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
    }
  });

  it('weights picks roughly as asked', () => {
    const rng = new Rng('weights');
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 4000; i++) counts[rng.weighted(['a', 'b'] as const, [3, 1])]++;
    expect(counts.a / counts.b).toBeGreaterThan(2);
    expect(counts.a / counts.b).toBeLessThan(4.5);
  });

  it('hashes distinct seeds distinctly', () => {
    expect(hashSeed('moss-harbour-101')).not.toBe(hashSeed('moss-harbour-102'));
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('keeps noise inside its nominal range', () => {
    const noise = new Noise2D(7);
    for (let i = 0; i < 400; i++) {
      const v = noise.fbm(i * 0.13, i * 0.29, 4);
      expect(v).toBeGreaterThan(-1.01);
      expect(v).toBeLessThan(1.01);
      expect(noise.ridged(i * 0.1, i * 0.2, 3)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('maths helpers', () => {
  it('clamps, damps and interpolates', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 5);
    expect(smoothstep(0, 1, -2)).toBe(0);
    // Damping approaches the target without overshooting it.
    let value = 0;
    for (let i = 0; i < 200; i++) value = damp(value, 10, 5, 1 / 60);
    expect(value).toBeGreaterThan(9.9);
    expect(value).toBeLessThanOrEqual(10);
  });

  it('takes the short way round a circle', () => {
    expect(angleDelta(0, Math.PI * 1.9)).toBeCloseTo(-Math.PI * 0.1, 5);
    expect(angleDelta(0, 0.4)).toBeCloseTo(0.4, 5);
  });

  it('formats counts and durations the way the HUD wants', () => {
    expect(formatCount(42)).toBe('42');
    expect(formatCount(1500)).toBe('1.5k');
    expect(formatCount(2_400_000)).toBe('2.4M');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(3720)).toBe('1h 2m');
    expect(formatDuration(90000)).toBe('1d 1h');
  });
});

describe('world clock', () => {
  it('runs dark at midnight and bright at noon', () => {
    expect(daylightFor(0)).toBe(0);
    expect(daylightFor(0.5)).toBe(1);
    expect(daylightFor(0.95)).toBe(0);
  });

  it('advances days and cycles the seasons', () => {
    const clock = new WorldClock(0);
    expect(clock.day).toBe(1);
    expect(clock.season).toBe('spring');
    clock.advance(SECONDS_PER_DAY * 7);
    expect(clock.day).toBe(8);
    expect(clock.season).toBe('summer');
    clock.advance(SECONDS_PER_DAY * 21);
    expect(clock.season).toBe('spring');
  });

  it('reports a sensible snapshot', () => {
    const clock = new WorldClock(SECONDS_PER_DAY * 0.5);
    const snapshot = clock.snapshot();
    expect(snapshot.hour).toBe(12);
    expect(snapshot.isNight).toBe(false);
    expect(snapshot.daylight).toBe(1);
  });
});

describe('navigation', () => {
  const terrain = new Terrain('nav-seed');
  const nav = new NavGrid(terrain);

  it('refuses to walk on water', () => {
    let checked = 0;
    for (let z = 0; z < WORLD_SIZE && checked < 40; z++) {
      for (let x = 0; x < WORLD_SIZE && checked < 40; x++) {
        if (terrain.heightAt(x, z) < WATER_LEVEL) {
          expect(nav.isWalkable(x, z)).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('refuses steps taller than one voxel', () => {
    for (let z = 1; z < WORLD_SIZE - 1; z++) {
      for (let x = 1; x < WORLD_SIZE - 1; x++) {
        if (!nav.isWalkable(x, z) || !nav.isWalkable(x + 1, z)) continue;
        const climb = Math.abs(terrain.heightAt(x + 1, z) - terrain.heightAt(x, z));
        if (climb > 1) expect(nav.canStep(x, z, x + 1, z)).toBe(false);
      }
    }
  });

  it('finds a path made of adjacent, walkable cells', () => {
    const start = nav.nearestWalkable(WORLD_SIZE / 2, WORLD_SIZE / 2, 20)!;
    const goal = nav.nearestWalkable(WORLD_SIZE / 2 + 12, WORLD_SIZE / 2 + 8, 20)!;
    const path = nav.findPath(start.x, start.z, goal.x, goal.z);
    expect(path).toBeDefined();

    let previous = start;
    for (const node of path!) {
      expect(Math.abs(node.x - previous.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(node.z - previous.z)).toBeLessThanOrEqual(1);
      expect(nav.isWalkable(node.x, node.z)).toBe(true);
      previous = node;
    }
    expect(previous).toEqual({ x: goal.x, z: goal.z });
  });

  it('gives up rather than hanging on an unreachable goal', () => {
    const start = nav.nearestWalkable(WORLD_SIZE / 2, WORLD_SIZE / 2, 20)!;
    // Wall the start cell in completely.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      terrain.addOccupancy(start.x + dx, start.z + dz, Occupancy.Structure);
    }
    terrain.revision++;
    nav.rebuild();
    const path = nav.findPath(start.x, start.z, 3, 3);
    expect(path === undefined || path.length === 0).toBe(true);
  });
});

describe('traits', () => {
  it('multiplies stacked modifiers and adds biases', () => {
    const mods = combineTraits(['diligent', 'lumberjack']);
    expect(mods.workSpeed).toBeCloseTo(1.22, 5);
    expect(mods.forestry).toBeCloseTo(1.5, 5);
    expect(mods.workBias).toBeCloseTo(0.2, 5);
  });

  it('ignores unknown trait ids', () => {
    expect(combineTraits(['not-a-trait']).workSpeed).toBe(1);
  });

  it('infers a vocation from the trait mix', () => {
    expect(inferVocation(combineTraits(['lumberjack']))).toBe('forester');
    expect(inferVocation(combineTraits(['greenthumb']))).toBe('farmer');
    expect(inferVocation(combineTraits(['optimist']))).toBe('wanderer');
  });
});
