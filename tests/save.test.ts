import { beforeEach, describe, expect, it } from 'vitest';
import { Haven } from '../src/sim/haven';
import { deserializeHaven, serializeHaven } from '../src/state/save';
import { BLUEPRINT_BY_ID } from '../src/build/blueprints';

// The save layer touches btoa/atob, which Node has but only on globalThis.
beforeEach(() => {
  if (typeof globalThis.btoa !== 'function') {
    globalThis.btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
    globalThis.atob = (s: string) => Buffer.from(s, 'base64').toString('binary');
  }
});

function place(haven: Haven, defId: string): void {
  const def = BLUEPRINT_BY_ID.get(defId)!;
  for (let radius = 0; radius < 16; radius++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (haven.placeBlueprint(def, haven.origin.x + dx, haven.origin.z + dz)) return;
      }
    }
  }
}

describe('save round-trip', () => {
  it('restores terrain, props, villagers and buildings', () => {
    const haven = new Haven('round-trip');
    haven.resources = { wood: 200, stone: 200, food: 200, tools: 20 };
    place(haven, 'cottage');
    place(haven, 'farm');
    for (let t = 0; t < 700; t += 1 / 15) haven.update(1 / 15);

    const data = serializeHaven(haven);
    const restored = deserializeHaven(data);

    expect(restored.seed).toBe(haven.seed);
    expect(restored.villagers.length).toBe(haven.villagers.length);
    expect(restored.structures.structures.length).toBe(haven.structures.structures.length);
    expect(restored.props.props.length).toBe(haven.props.props.length);
    expect(Array.from(restored.terrain.heights)).toEqual(Array.from(haven.terrain.heights));
    expect(Array.from(restored.terrain.types)).toEqual(Array.from(haven.terrain.types));
    expect(restored.clock.elapsed).toBeCloseTo(haven.clock.elapsed, 3);
    expect(restored.resources).toEqual(haven.resources);

    const original = haven.villagers[0];
    const copy = restored.villagerById(original.id)!;
    expect(copy.name).toBe(original.name);
    expect(copy.traits).toEqual(original.traits);
    expect(copy.look).toEqual(original.look);
    expect(copy.energy).toBeCloseTo(original.energy, 1);
  });

  it('keeps a restored haven simulating correctly', () => {
    const haven = new Haven('restore-and-run');
    place(haven, 'cottage');
    for (let t = 0; t < 300; t += 1 / 15) haven.update(1 / 15);

    const restored = deserializeHaven(serializeHaven(haven));
    for (let t = 0; t < 600; t += 1 / 15) restored.update(1 / 15);

    for (const v of restored.villagers) {
      expect(Number.isFinite(v.x)).toBe(true);
      expect(restored.nav.isWalkable(v.cellX, v.cellZ)).toBe(true);
      expect(v.mood).toBeGreaterThanOrEqual(0);
    }
  });

  it('rebuilds walkability from restored bridges', () => {
    const haven = new Haven('bridge-save');
    const def = BLUEPRINT_BY_ID.get('bridge')!;
    let placed = null;
    outer: for (let z = 1; z < 95; z++) {
      for (let x = 1; x < 95; x++) {
        if (!haven.terrain.isLand(x, z) && haven.terrain.isLand(x + 1, z)) {
          placed = haven.placeBlueprint(def, x, z);
          if (placed) break outer;
        }
      }
    }
    expect(placed).not.toBeNull();
    haven.structures.deliver(placed!, 'wood', 5);
    haven.structures.applyWork(placed!, 999);
    haven.nav.rebuild();
    expect(haven.nav.isWalkable(placed!.x, placed!.z)).toBe(true);

    const restored = deserializeHaven(serializeHaven(haven));
    expect(restored.nav.isWalkable(placed!.x, placed!.z)).toBe(true);
  });
});
