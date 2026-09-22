import { describe, expect, it } from 'vitest';
import { Haven } from '../src/sim/haven';
import { BLUEPRINT_BY_ID } from '../src/build/blueprints';
import { planNextBuilding } from '../src/sim/planner';
import { TRAIL_THRESHOLD, WATER_LEVEL, WORLD_SIZE } from '../src/world/constants';

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

describe('the resource ledger', () => {
  it('survives a resources object with a line missing', () => {
    const haven = new Haven('partial');
    // Older saves and anything set from the console can be short a key. One
    // missing line used to turn every total in the game into NaN.
    (haven as unknown as { resources: Record<string, number> }).resources = {
      wood: 10,
      stone: 5,
      food: 5,
    };
    haven.update(1);
    expect(Number.isFinite(haven.totalStored)).toBe(true);
    expect(Number.isFinite(haven.toolEdge)).toBe(true);
    haven.store('wood', 4);
    expect(Number.isFinite(haven.stats.resourcesGathered)).toBe(true);

    // And writing to the absent line heals it rather than producing NaN.
    haven.store('tools', 3);
    expect(haven.resources.tools).toBe(3);

    // The whole simulation keeps running on it.
    runFor(haven, 240);
    expect(Number.isFinite(haven.totalStored)).toBe(true);
    for (const v of haven.villagers) expect(Number.isFinite(v.x)).toBe(true);
  });
});

describe('the tool economy', () => {
  it('only ever has tools after a workshop stands', () => {
    const haven = new Haven('toolmaking');
    haven.resources = { wood: 150, stone: 120, food: 60, tools: 0 };

    let workshopStood = false;
    for (let t = 0; t < 3600; t += 1 / 10) {
      haven.update(1 / 10);
      if (haven.structures.completedOfType('workshop').length > 0) workshopStood = true;
      // The causal rule: tools cannot exist before somewhere to make them.
      if (haven.resources.tools > 0) expect(workshopStood).toBe(true);
    }

    // And the village gets there on its own, without being told to.
    expect(workshopStood).toBe(true);
    expect(haven.resources.tools).toBeGreaterThan(0);
  });

  it('does not want a workshop until there are enough hands for one', () => {
    const haven = new Haven('workshop-gate', { populate: false });
    haven.addVillager(haven.origin.x, haven.origin.z);
    haven.addVillager(haven.origin.x + 1, haven.origin.z);
    haven.resources = { wood: 300, stone: 300, food: 300, tools: 0 };

    const ask = () =>
      planNextBuilding({
        terrain: haven.terrain,
        props: haven.props,
        structures: haven.structures,
        population: haven.villagers.length,
        beds: 99,
        resources: haven.resources,
        capacity: haven.capacity,
        totalStored: haven.totalStored,
        centre: haven.villageCentre,
      });

    // Two villagers: plenty of materials, but no call for a workshop yet.
    let plan = ask();
    while (plan && plan.def.id !== 'workshop') {
      haven.structures.place(plan.def, plan.x, plan.z);
      haven.structures.applyWork(haven.structures.structures.at(-1)!, 0);
      plan = ask();
      if (haven.structures.structures.length > 12) break;
    }
    expect(plan?.def.id).not.toBe('workshop');
  });

  it('makes a stocked toolshed speed everyone up, within limits', () => {
    const haven = new Haven('tooledge', { populate: false });
    expect(haven.toolEdge).toBe(1);
    haven.resources.tools = 45;
    haven.update(1);
    expect(haven.toolEdge).toBeGreaterThan(1.1);
    haven.resources.tools = 10000;
    haven.update(1);
    expect(haven.toolEdge).toBeLessThanOrEqual(1.3);
  });
});

describe('skills', () => {
  it('turns villagers into specialists through practice alone', () => {
    const haven = new Haven('specialists');
    for (const v of haven.villagers) {
      expect(v.bestSkill).toBeNull();
    }

    runFor(haven, 3000, 1 / 15);

    const specialists = haven.villagers.filter((v) => v.bestSkill !== null);
    expect(specialists.length).toBeGreaterThan(0);
    for (const v of haven.villagers) {
      for (const level of Object.values(v.skills)) {
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(100);
      }
    }
  });

  it('makes a practised villager faster than a novice with the same traits', () => {
    const haven = new Haven('practice', { populate: false });
    const novice = haven.addVillager(haven.origin.x, haven.origin.z, 'Novice', ['diligent', 'sociable']);
    const veteran = haven.addVillager(haven.origin.x, haven.origin.z, 'Veteran', ['diligent', 'sociable']);
    veteran.skills.forestry = 100;

    expect(veteran.workRate('forestry')).toBeGreaterThan(novice.workRate('forestry'));
    // And no better at anything they have not done.
    expect(veteran.workRate('masonry')).toBeCloseTo(novice.workRate('masonry'), 5);
  });

  it('improves fast at first and slowly once expert', () => {
    const haven = new Haven('curve', { populate: false });
    const v = haven.addVillager(haven.origin.x, haven.origin.z, 'Learner');

    v.practise('forestry', 1);
    const firstGain = v.skills.forestry;

    v.skills.forestry = 90;
    v.practise('forestry', 1);
    const lateGain = v.skills.forestry - 90;

    expect(firstGain).toBeGreaterThan(lateGain * 5);
  });
});

describe('desire paths', () => {
  it('wears trails along the routes villagers actually use', () => {
    const haven = new Haven('trails');
    runFor(haven, 2400, 1 / 15);

    let worn = 0;
    for (let i = 0; i < WORLD_SIZE * WORLD_SIZE; i++) {
      if (haven.terrain.wear[i] >= TRAIL_THRESHOLD) worn++;
    }
    expect(worn).toBeGreaterThan(5);
    // Routes, not a carpet: if everywhere is a path then nowhere is.
    expect(worn).toBeLessThan(WORLD_SIZE * WORLD_SIZE * 0.06);
  });

  it('never wears a trail across water', () => {
    const haven = new Haven('trails-water');
    runFor(haven, 900, 1 / 15);
    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        if (!haven.terrain.isLand(x, z)) expect(haven.terrain.wearAt(x, z)).toBe(0);
      }
    }
  });

  it('lets the grass grow back over ground nobody uses', () => {
    const haven = new Haven('regrow', { populate: false });
    haven.terrain.addWear(10, 10, 1);
    expect(haven.terrain.isTrail(10, 10)).toBe(true);
    // A trail takes roughly twenty minutes of disuse to disappear.
    haven.terrain.fadeWear(30 * 60);
    expect(haven.terrain.isTrail(10, 10)).toBe(false);
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
