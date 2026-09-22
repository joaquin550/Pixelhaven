import { describe, expect, it } from 'vitest';
import { Haven } from '../src/sim/haven';
import { BLUEPRINT_BY_ID } from '../src/build/blueprints';
import { sculpt } from '../src/world/sculpt';
import { MAX_HEIGHT, WATER_LEVEL } from '../src/world/constants';

function runFor(haven: Haven, seconds: number, step = 1 / 10): void {
  for (let t = 0; t < seconds; t += step) haven.update(step);
}

describe('the village builds for itself', () => {
  it('raises a hearth and then homes without being told', () => {
    const haven = new Haven('self-build');
    haven.resources = { wood: 200, stone: 200, food: 200, tools: 0 };
    expect(haven.structures.structures).toHaveLength(0);

    runFor(haven, 2400);

    const kinds = haven.structures.structures.map((s) => s.defId);
    expect(kinds.length).toBeGreaterThan(1);
    expect(kinds).toContain('hearth');
    expect(kinds.some((k) => k === 'cottage' || k === 'longhouse')).toBe(true);
    expect(haven.beds).toBeGreaterThan(0);
  });

  it('never queues more sites than it can work on', () => {
    const haven = new Haven('queue-limit');
    haven.resources = { wood: 40, stone: 20, food: 35, tools: 0 };
    for (let t = 0; t < 3000; t += 1 / 10) {
      haven.update(1 / 10);
      expect(haven.structures.pending.length).toBeLessThanOrEqual(2);
    }
  });

  it('nobody gets stranded on a spire pulled up under them', () => {
    const haven = new Haven('stranding');
    const victim = haven.villagers[0];
    const x = victim.cellX;
    const z = victim.cellZ;

    // Yank a tall, sheer pillar out of the ground beneath them.
    for (let i = 0; i < 8; i++) sculpt(haven.terrain, haven.props, 'raise', x, z, 1);
    haven.nav.rebuild();
    expect(haven.terrain.heightAt(x, z)).toBeGreaterThan(WATER_LEVEL + 6);

    // They cannot climb back up, but they can always get down.
    const path = haven.nav.findPath(x, z, haven.origin.x, haven.origin.z);
    expect(path).toBeDefined();
    expect(path!.length).toBeGreaterThan(0);
  });

  it('flattening a shelf makes ground the village will build on', () => {
    const haven = new Haven('invitation');
    haven.resources = { wood: 400, stone: 400, food: 400, tools: 0 };
    const c = haven.origin;

    // A wide, deliberately flat shelf off to one side.
    for (let i = 0; i < 14; i++) sculpt(haven.terrain, haven.props, 'level', c.x + 9, c.z + 2, 4);
    haven.nav.rebuild();

    const shelf = haven.terrain.heightAt(c.x + 9, c.z + 2);
    expect(shelf).toBeGreaterThanOrEqual(WATER_LEVEL);
    expect(shelf).toBeLessThanOrEqual(MAX_HEIGHT);
    // Flat enough to take a building, which is the whole point of the tool.
    expect(haven.terrain.isBuildable(c.x + 8, c.z + 1, 3, 3)).toBe(true);
  });
});

describe('sculpting', () => {
  it('raises and lowers whole voxels', () => {
    const haven = new Haven('sculpt', { populate: false });
    const { x, z } = haven.origin;
    const before = haven.terrain.heightAt(x, z);

    const up = sculpt(haven.terrain, haven.props, 'raise', x, z, 2);
    expect(up.changed).toBeGreaterThan(0);
    expect(haven.terrain.heightAt(x, z)).toBe(before + 1);

    sculpt(haven.terrain, haven.props, 'lower', x, z, 2);
    expect(haven.terrain.heightAt(x, z)).toBe(before);
  });

  it('refuses to pull the ground from under a building', () => {
    const haven = new Haven('sculpt-guard');
    const cottage = BLUEPRINT_BY_ID.get('cottage')!;
    let placed = null;
    for (let r = 0; r < 14 && !placed; r++)
      for (let dz = -r; dz <= r && !placed; dz++)
        for (let dx = -r; dx <= r && !placed; dx++)
          placed = haven.placeBlueprint(cottage, haven.origin.x + dx, haven.origin.z + dz);
    const before = haven.terrain.heightAt(placed!.x, placed!.z);
    const result = sculpt(haven.terrain, haven.props, 'lower', placed!.x, placed!.z, 1);
    expect(result.blocked).toBeGreaterThan(0);
    expect(haven.terrain.heightAt(placed!.x, placed!.z)).toBe(before);
  });

  it('levels ground towards the height under the cursor', () => {
    const haven = new Haven('level', { populate: false });
    const { x, z } = haven.origin;
    for (let i = 0; i < 10; i++) sculpt(haven.terrain, haven.props, 'level', x, z, 3);

    const target = haven.terrain.heightAt(x, z);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        expect(haven.terrain.heightAt(x + dx, z + dz)).toBe(target);
      }
    }
  });

  it('drowns trees dropped below the waterline and keeps the height field sane', () => {
    const haven = new Haven('drown', { populate: false });
    const { x, z } = haven.origin;
    for (let i = 0; i < 30; i++) sculpt(haven.terrain, haven.props, 'lower', x, z, 4);

    expect(haven.terrain.heightAt(x, z)).toBe(0);
    for (const prop of haven.props.props) {
      const ground = haven.terrain.heightAt(prop.cx, prop.cz);
      if (prop.kind !== 'reed') expect(ground).toBeGreaterThanOrEqual(WATER_LEVEL);
    }
  });
});
