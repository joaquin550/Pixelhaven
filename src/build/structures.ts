/**
 * Structures: placed blueprints and the buildings they become.
 *
 * Lifecycle: `blueprint` (ghost, waiting on materials) -> `building` (villagers
 * are raising it, mesh reveals bottom-up) -> `complete`.
 */
import { Occupancy, TerrainType, WATER_LEVEL, WORLD_SIZE, inBounds } from '../world/constants';
import { Terrain } from '../world/terrain';
import { BLUEPRINT_BY_ID, BlueprintDef, PlacementRule, ResourceKind } from './blueprints';

export type StructureState = 'blueprint' | 'building' | 'complete';

export interface Structure {
  id: number;
  defId: string;
  x: number;
  z: number;
  /** Ground height the structure sits on. */
  y: number;
  width: number;
  depth: number;
  state: StructureState;
  /** Materials hauled to the site so far. */
  delivered: Record<ResourceKind, number>;
  /** Build work completed, in seconds of 1x villager effort. */
  progress: number;
  work: number;
  /** Farm crop maturity, 0..1. Only used by farm plots. */
  crop: number;
  /** Set while a villager is walking crops in, so two don't double-harvest. */
  claimedBy: number;
  /** Villagers whose bed is here. */
  residents: number[];
  /** In-game seconds since the structure was finished, for reveal animations. */
  age: number;
}

export interface PlacementCheck {
  ok: boolean;
  reason?: string;
}

export class StructureRegistry {
  structures: Structure[] = [];
  private nextId = 1;
  revision = 0;

  constructor(private terrain: Terrain) {}

  byId(id: number): Structure | undefined {
    return this.structures.find((s) => s.id === id);
  }

  ofType(defId: string): Structure[] {
    return this.structures.filter((s) => s.defId === defId);
  }

  completedOfType(defId: string): Structure[] {
    return this.structures.filter((s) => s.defId === defId && s.state === 'complete');
  }

  get completed(): Structure[] {
    return this.structures.filter((s) => s.state === 'complete');
  }

  get pending(): Structure[] {
    return this.structures.filter((s) => s.state !== 'complete');
  }

  /** Validates a footprint against the blueprint's placement rule. */
  canPlace(def: BlueprintDef, x: number, z: number): PlacementCheck {
    const { width, depth } = def;
    if (!inBounds(x, z) || !inBounds(x + width - 1, z + depth - 1)) {
      return { ok: false, reason: 'Outside the island' };
    }

    for (let dz = 0; dz < depth; dz++) {
      for (let dx = 0; dx < width; dx++) {
        const occ = this.terrain.occupancyAt(x + dx, z + dz);
        if (occ & Occupancy.Structure) return { ok: false, reason: 'Something is already here' };
        if (occ & Occupancy.Prop) return { ok: false, reason: 'Clear the trees first' };
      }
    }

    return checkGround(this.terrain, def.placement, x, z, width, depth);
  }

  place(def: BlueprintDef, x: number, z: number): Structure {
    const base =
      def.placement === 'water'
        ? WATER_LEVEL
        : this.terrain.heightAt(x, z);

    if (def.placement === 'land') {
      this.terrain.levelFootprint(x, z, def.width, def.depth, def.id === 'farm' ? TerrainType.Farmland : undefined);
    }

    const structure: Structure = {
      id: this.nextId++,
      defId: def.id,
      x,
      z,
      y: base,
      width: def.width,
      depth: def.depth,
      state: 'blueprint',
      delivered: { wood: 0, stone: 0, food: 0 },
      progress: 0,
      work: def.work,
      crop: 0,
      claimedBy: 0,
      residents: [],
      age: 0,
    };
    this.structures.push(structure);
    this.stampOccupancy(structure, def);
    this.revision++;
    return structure;
  }

  cancel(structure: Structure): Record<ResourceKind, number> {
    const def = BLUEPRINT_BY_ID.get(structure.defId);
    this.clearOccupancy(structure);
    const idx = this.structures.indexOf(structure);
    if (idx >= 0) this.structures.splice(idx, 1);
    this.revision++;
    // Full refund of whatever already made it to the site - no punishment for
    // changing your mind about where the bridge goes.
    if (!def) return { wood: 0, stone: 0, food: 0 };
    return { ...structure.delivered };
  }

  /** Total materials still owed to a site. */
  outstanding(structure: Structure): Partial<Record<ResourceKind, number>> {
    const def = BLUEPRINT_BY_ID.get(structure.defId);
    if (!def) return {};
    const need: Partial<Record<ResourceKind, number>> = {};
    for (const key of ['wood', 'stone', 'food'] as ResourceKind[]) {
      const required = def.cost[key] ?? 0;
      const remaining = required - structure.delivered[key];
      if (remaining > 0) need[key] = remaining;
    }
    return need;
  }

  isFullySupplied(structure: Structure): boolean {
    return Object.keys(this.outstanding(structure)).length === 0;
  }

  deliver(structure: Structure, resource: ResourceKind, amount: number): void {
    structure.delivered[resource] += amount;
    if (structure.state === 'blueprint' && this.isFullySupplied(structure)) {
      structure.state = 'building';
    }
    this.revision++;
  }

  /** Applies build effort. Returns true when the structure just finished. */
  applyWork(structure: Structure, amount: number): boolean {
    if (structure.state !== 'building') return false;
    structure.progress = Math.min(structure.work, structure.progress + amount);
    this.revision++;
    if (structure.progress >= structure.work) {
      structure.state = 'complete';
      structure.age = 0;
      const def = BLUEPRINT_BY_ID.get(structure.defId);
      if (def) this.stampOccupancy(structure, def);
      return true;
    }
    return false;
  }

  buildFraction(structure: Structure): number {
    if (structure.state === 'complete') return 1;
    if (structure.work <= 0) return 0;
    return structure.progress / structure.work;
  }

  /** Marks every cell of a footprint with the right occupancy flags. */
  private stampOccupancy(structure: Structure, def: BlueprintDef): void {
    for (let dz = 0; dz < structure.depth; dz++) {
      for (let dx = 0; dx < structure.width; dx++) {
        const x = structure.x + dx;
        const z = structure.z + dz;
        this.terrain.addOccupancy(x, z, Occupancy.Structure);
        if (def.walkable) this.terrain.addOccupancy(x, z, Occupancy.Walkable);
      }
    }
    this.terrain.revision++;
  }

  private clearOccupancy(structure: Structure): void {
    for (let dz = 0; dz < structure.depth; dz++) {
      for (let dx = 0; dx < structure.width; dx++) {
        this.terrain.removeOccupancy(
          structure.x + dx,
          structure.z + dz,
          Occupancy.Structure | Occupancy.Walkable,
        );
      }
    }
    this.terrain.revision++;
  }

  /** Cell a villager should stand on to interact with a structure. */
  accessPoint(structure: Structure): { x: number; z: number } {
    const def = BLUEPRINT_BY_ID.get(structure.defId);
    if (def?.walkable) {
      return {
        x: structure.x + Math.floor(structure.width / 2),
        z: structure.z + Math.floor(structure.depth / 2),
      };
    }
    // Otherwise stand on the tile just outside the footprint.
    const candidates: { x: number; z: number }[] = [];
    for (let dx = -1; dx <= structure.width; dx++) {
      candidates.push({ x: structure.x + dx, z: structure.z - 1 });
      candidates.push({ x: structure.x + dx, z: structure.z + structure.depth });
    }
    for (let dz = 0; dz < structure.depth; dz++) {
      candidates.push({ x: structure.x - 1, z: structure.z + dz });
      candidates.push({ x: structure.x + structure.width, z: structure.z + dz });
    }
    for (const c of candidates) {
      if (!inBounds(c.x, c.z)) continue;
      if (this.terrain.heightAt(c.x, c.z) < WATER_LEVEL) continue;
      if (this.terrain.hasOccupancy(c.x, c.z, Occupancy.Prop)) continue;
      const occ = this.terrain.occupancyAt(c.x, c.z);
      if ((occ & Occupancy.Structure) !== 0 && (occ & Occupancy.Walkable) === 0) continue;
      return c;
    }
    return { x: structure.x, z: structure.z };
  }

  centre(structure: Structure): { x: number; z: number } {
    return { x: structure.x + structure.width / 2, z: structure.z + structure.depth / 2 };
  }
}

/** Ground validation shared by placement preview and actual placement. */
export function checkGround(
  terrain: Terrain,
  rule: PlacementRule,
  x: number,
  z: number,
  width: number,
  depth: number,
): PlacementCheck {
  let land = 0;
  let water = 0;
  const heights: number[] = [];

  for (let dz = 0; dz < depth; dz++) {
    for (let dx = 0; dx < width; dx++) {
      const cx = x + dx;
      const cz = z + dz;
      if (!inBounds(cx, cz)) return { ok: false, reason: 'Outside the island' };
      if (terrain.isLand(cx, cz)) {
        land++;
        heights.push(terrain.heightAt(cx, cz));
      } else {
        water++;
      }
    }
  }

  if (rule === 'land') {
    if (water > 0) return { ok: false, reason: 'Needs dry ground' };
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    if (max - min > 1) return { ok: false, reason: 'Ground is too uneven' };
    return { ok: true };
  }

  if (rule === 'water') {
    if (land > 0) return { ok: false, reason: 'Must sit over water' };
    return { ok: true };
  }

  // Shore: needs a foot on the land and a foot in the water.
  if (land === 0) return { ok: false, reason: 'Needs to touch the shore' };
  if (water === 0) return { ok: false, reason: 'Needs to reach the water' };
  return { ok: true };
}

/** Squared distance from a point to a structure footprint, for "nearest" queries. */
export function distanceToStructure(structure: Structure, x: number, z: number): number {
  const cx = structure.x + structure.width / 2;
  const cz = structure.z + structure.depth / 2;
  return (cx - x) ** 2 + (cz - z) ** 2;
}

export const MAX_WORLD_COORD = WORLD_SIZE - 1;
