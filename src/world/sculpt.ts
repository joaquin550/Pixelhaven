/**
 * Moving the earth.
 *
 * The player's primary verb. Raising and lowering ground changes what the
 * island affords: a flattened shelf is somewhere a village can expand to, a
 * scooped-out hollow below the waterline becomes a bay, a raised ridge is a
 * wall. Villagers are never told any of this. They read the land and decide
 * for themselves.
 *
 * Heights are integers, so a stroke moves whole voxels. That keeps the result
 * legible - you can always see exactly what you did - and matches a world
 * built out of cubes.
 */
import { MAX_HEIGHT, Occupancy, TerrainType, WATER_LEVEL, inBounds, index } from './constants';
import { Terrain } from './terrain';
import { PROP_YIELD, PropRegistry, blocksMovement } from './props';

export type SculptTool = 'raise' | 'lower' | 'level';

export interface SculptResult {
  /** Cells whose height actually moved. */
  changed: number;
  /** Cells the tool refused to touch because something is built on them. */
  blocked: number;
  /** Trees and boulders knocked out by the change. */
  propsLost: number;
  /** What was salvaged from them, which goes to the stockpile. */
  salvaged: { wood: number; stone: number; food: number };
}

const EMPTY: SculptResult = {
  changed: 0,
  blocked: 0,
  propsLost: 0,
  salvaged: { wood: 0, stone: 0, food: 0 },
};

/**
 * Applies one stroke of a tool.
 *
 * Structures pin the ground under them: you cannot pull the earth out from
 * beneath a house. Everything else is fair game, including the seabed.
 */
export function sculpt(
  terrain: Terrain,
  props: PropRegistry,
  tool: SculptTool,
  centreX: number,
  centreZ: number,
  radius: number,
): SculptResult {
  if (!inBounds(centreX, centreZ)) return EMPTY;

  const result: SculptResult = {
    changed: 0,
    blocked: 0,
    propsLost: 0,
    salvaged: { wood: 0, stone: 0, food: 0 },
  };
  const targetHeight = terrain.heightAt(centreX, centreZ);
  const reach = Math.max(0, radius);
  const moved = new Set<number>();

  for (let dz = -reach; dz <= reach; dz++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const x = centreX + dx;
      const z = centreZ + dz;
      if (!inBounds(x, z)) continue;
      // A round brush, not a square one.
      if (Math.hypot(dx, dz) > reach + 0.35) continue;

      if (terrain.hasOccupancy(x, z, Occupancy.Structure)) {
        result.blocked++;
        continue;
      }

      const i = index(x, z);
      const current = terrain.heights[i];
      let next = current;

      if (tool === 'raise') {
        next = current + 1;
      } else if (tool === 'lower') {
        next = current - 1;
      } else {
        // Level: step one voxel towards the height under the cursor, so a
        // held stroke smooths rather than stamping a flat disc instantly.
        if (current > targetHeight) next = current - 1;
        else if (current < targetHeight) next = current + 1;
      }

      next = Math.max(0, Math.min(MAX_HEIGHT, next));
      if (next === current) continue;

      terrain.heights[i] = next;
      terrain.markDirty(x, z);
      moved.add(i);
      result.changed++;
    }
  }

  if (result.changed === 0) return result;

  // The ground moved, so everything sitting on it has to be reconciled.
  retypeArea(terrain, centreX, centreZ, reach + 1);
  reconcileProps(terrain, props, centreX, centreZ, reach + 1, moved, result);
  terrain.revision++;
  return result;
}

/**
 * Repaints surface materials around an edit.
 *
 * Raise a seabed above the tideline and it should become sand, then grass;
 * drop a meadow into the water and it should read as riverbed. Without this,
 * sculpted ground keeps whatever it looked like before it moved.
 */
function retypeArea(terrain: Terrain, centreX: number, centreZ: number, reach: number): void {
  for (let dz = -reach; dz <= reach; dz++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const x = centreX + dx;
      const z = centreZ + dz;
      if (!inBounds(x, z)) continue;
      const i = index(x, z);
      const h = terrain.heights[i];
      const type = terrain.types[i];

      // Leave anything the villagers have made alone.
      if (type === TerrainType.Farmland || type === TerrainType.Path) continue;

      const slope = terrain.slopeAt(x, z);
      let next: number;
      if (h < WATER_LEVEL) next = TerrainType.Sand;
      else if (h <= WATER_LEVEL + 1) next = TerrainType.Sand;
      else if (h > MAX_HEIGHT - 6) next = TerrainType.Snow;
      else if (slope >= 3 || h > MAX_HEIGHT - 10) next = TerrainType.Stone;
      else next = terrain.fertility[i] < 0.32 ? TerrainType.Dirt : TerrainType.Grass;

      if (next !== type) {
        terrain.types[i] = next;
        terrain.markDirty(x, z);
      }
    }
  }
}

/**
 * Reconciles everything growing on ground that just moved.
 *
 * A tree cannot stay standing on earth you have heaved several feet, so
 * anything rooted in a cell whose height changed comes out. The timber and
 * stone are not wasted - they go to the stockpile, which makes reshaping the
 * land a way to clear and harvest it in one gesture rather than a punishment
 * for wanting somewhere flat to build.
 */
function reconcileProps(
  terrain: Terrain,
  props: PropRegistry,
  centreX: number,
  centreZ: number,
  reach: number,
  moved: Set<number>,
  result: SculptResult,
): void {
  for (const prop of [...props.props]) {
    if (Math.abs(prop.cx - centreX) > reach || Math.abs(prop.cz - centreZ) > reach) continue;

    const ground = terrain.heightAt(prop.cx, prop.cz);
    const drowned = ground < WATER_LEVEL;
    const reeds = prop.kind === 'reed';
    const uprooted = moved.has(index(prop.cx, prop.cz)) && blocksMovement(prop.kind);

    // Reeds want shallow water; everything else wants dry land.
    if (uprooted || drowned !== reeds) {
      const yields = PROP_YIELD[prop.kind];
      if (uprooted && yields && prop.yield > 0) {
        result.salvaged[yields.resource] += prop.yield;
      }
      props.remove(prop);
      result.propsLost++;
      continue;
    }
    prop.y = ground;
  }
  if (result.propsLost > 0) props.revision++;
}

/** Cells a stroke would touch, for costing it before it happens. */
export function strokeFootprint(radius: number): number {
  let cells = 0;
  const reach = Math.max(0, radius);
  for (let dz = -reach; dz <= reach; dz++) {
    for (let dx = -reach; dx <= reach; dx++) {
      if (Math.hypot(dx, dz) <= reach + 0.35) cells++;
    }
  }
  return cells;
}

/** True when a cell can be reshaped at all. */
export function isSculptable(terrain: Terrain, x: number, z: number): boolean {
  return inBounds(x, z) && !terrain.hasOccupancy(x, z, Occupancy.Structure);
}

export { blocksMovement };
