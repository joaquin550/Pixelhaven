import { describe, expect, it } from 'vitest';
import { Haven } from '../src/sim/haven';
import { BLUEPRINT_BY_ID } from '../src/build/blueprints';
import { WATER_LEVEL, WORLD_SIZE } from '../src/world/constants';

function runFor(haven: Haven, seconds: number, step = 1 / 20): void {
  for (let t = 0; t < seconds; t += step) haven.update(step);
}

describe('island generation', () => {
  it('produces land, water and a reachable founding site', () => {
    const haven = new Haven('test-island');
    let land = 0;
    let water = 0;
    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        if (haven.terrain.heightAt(x, z) >= WATER_LEVEL) land++;
        else water++;
      }
    }
    expect(land).toBeGreaterThan(500);
    expect(water).toBeGreaterThan(500);
    expect(haven.nav.isWalkable(haven.origin.x, haven.origin.z)).toBe(true);
  });

  it('is deterministic for a given seed', () => {
    const a = new Haven('same-seed', { populate: false });
    const b = new Haven('same-seed', { populate: false });
    expect(Array.from(a.terrain.heights)).toEqual(Array.from(b.terrain.heights));
    expect(a.props.props.length).toBe(b.props.props.length);
  });

  it('scatters natural props off the voxel grid', () => {
    const haven = new Haven('offgrid', { populate: false });
    const offGrid = haven.props.props.filter((p) => p.x % 1 !== 0 && p.z % 1 !== 0);
    expect(haven.props.props.length).toBeGreaterThan(50);
    expect(offGrid.length).toBe(haven.props.props.length);
  });
});

describe('villagers', () => {
  it('starts with four villagers on walkable ground', () => {
    const haven = new Haven('villagers');
    expect(haven.villagers).toHaveLength(4);
    for (const v of haven.villagers) {
      expect(haven.nav.isWalkable(v.cellX, v.cellZ)).toBe(true);
    }
  });

  it('gathers resources when left alone', () => {
    const haven = new Haven('gather-run');
    haven.resources.wood = 0;
    haven.resources.stone = 0;
    haven.resources.food = 30;
    runFor(haven, 400);
    expect(haven.stats.resourcesGathered).toBeGreaterThan(0);
    expect(haven.resources.wood + haven.resources.stone).toBeGreaterThan(0);
  });

  it('moves around the island rather than standing still', () => {
    const haven = new Haven('movement');
    const start = haven.villagers.map((v) => ({ x: v.x, z: v.z }));
    runFor(haven, 120);
    const moved = haven.villagers.filter(
      (v, i) => Math.hypot(v.x - start[i].x, v.z - start[i].z) > 1.5,
    );
    expect(moved.length).toBeGreaterThan(0);
  });

  it('keeps needs inside their bounds over a long run', () => {
    const haven = new Haven('needs');
    runFor(haven, 900, 1 / 10);
    for (const v of haven.villagers) {
      expect(v.energy).toBeGreaterThanOrEqual(0);
      expect(v.energy).toBeLessThanOrEqual(100);
      expect(v.hunger).toBeGreaterThanOrEqual(0);
      expect(v.hunger).toBeLessThanOrEqual(100);
      expect(v.mood).toBeGreaterThanOrEqual(0);
      expect(v.mood).toBeLessThanOrEqual(100);
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.z)).toBe(true);
    }
  });

  it('never lets a villager walk onto water', () => {
    const haven = new Haven('nowater');
    for (let t = 0; t < 600; t += 1 / 20) {
      haven.update(1 / 20);
      for (const v of haven.villagers) {
        if (haven.terrain.heightAt(v.cellX, v.cellZ) < WATER_LEVEL) {
          throw new Error(`${v.name} is standing in the sea at ${v.cellX},${v.cellZ}`);
        }
      }
    }
  });
});

describe('construction', () => {
  it('lets villagers haul materials and finish a cottage', () => {
    const haven = new Haven('build-a-cottage');
    haven.resources.wood = 200;
    haven.resources.stone = 200;
    haven.resources.food = 200;

    const def = BLUEPRINT_BY_ID.get('cottage')!;
    let placed = null;
    for (let radius = 0; radius < 18 && !placed; radius++) {
      for (let dz = -radius; dz <= radius && !placed; dz++) {
        for (let dx = -radius; dx <= radius && !placed; dx++) {
          placed = haven.placeBlueprint(def, haven.origin.x + dx, haven.origin.z + dz);
        }
      }
    }
    expect(placed).not.toBeNull();

    runFor(haven, 900);
    expect(placed!.state).toBe('complete');
    expect(haven.beds).toBeGreaterThan(0);
    expect(haven.villagers.some((v) => v.homeId === placed!.id)).toBe(true);
  });
});

describe('offline catch-up', () => {
  it('advances the world without breaking anything', () => {
    const haven = new Haven('offline');
    const result = haven.catchUp(60 * 60 * 4);
    expect(result.elapsed).toBeGreaterThan(0);
    expect(haven.clock.day).toBeGreaterThan(1);
    for (const v of haven.villagers) {
      expect(Number.isFinite(v.x)).toBe(true);
      expect(haven.nav.isWalkable(v.cellX, v.cellZ)).toBe(true);
    }
  });
});
