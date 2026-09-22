/**
 * What the village decides to build, and where.
 *
 * Nobody tells them. The planner reads the state of the haven - who has a bed,
 * how the food is holding out, whether the shelves are overflowing - picks the
 * one thing most worth doing next, and then looks for somewhere to put it.
 *
 * Site selection is where the player actually gets their influence. Villagers
 * will only build on flat, dry, unoccupied ground near where they already
 * live, so flattening a shelf on the hillside is an invitation and raising a
 * ridge is a refusal. The land is the instruction.
 */
import { BLUEPRINTS, BlueprintDef } from '../build/blueprints';
import { Structure, StructureRegistry } from '../build/structures';
import { Occupancy, WATER_LEVEL, WORLD_SIZE, inBounds } from '../world/constants';
import { Terrain } from '../world/terrain';
import { PropRegistry } from '../world/props';

export interface PlannerView {
  terrain: Terrain;
  props: PropRegistry;
  structures: StructureRegistry;
  population: number;
  beds: number;
  resources: { wood: number; stone: number; food: number; tools: number };
  capacity: number;
  totalStored: number;
  /** Where the village considers itself to be. */
  centre: { x: number; z: number };
}

export interface Plan {
  def: BlueprintDef;
  x: number;
  z: number;
  /** Why, in the village's words. Goes in the event log. */
  reason: string;
}

/** How far out from the village centre they are willing to build. */
const SEARCH_RADIUS = 20;
/** Never queue more than this many unfinished sites at once. */
export const MAX_PENDING = 2;

const byId = (id: string): BlueprintDef => BLUEPRINTS.find((b) => b.id === id)!;

/**
 * Picks the next thing to build, or nothing.
 *
 * The order is a priority list, not a tech tree: the village always wants
 * somewhere to sleep more than it wants a shrine.
 */
export function planNextBuilding(view: PlannerView): Plan | null {
  if (view.structures.pending.length >= MAX_PENDING) return null;

  for (const want of wants(view)) {
    const site = findSite(view, want.def);
    if (site) return { def: want.def, x: site.x, z: site.z, reason: want.reason };
  }
  return null;
}

interface Want {
  def: BlueprintDef;
  reason: string;
}

function wants(view: PlannerView): Want[] {
  const list: Want[] = [];
  const { population, beds, resources } = view;
  const completed = (id: string) => view.structures.completedOfType(id).length;
  const planned = (id: string) =>
    view.structures.structures.filter((s) => s.defId === id).length;

  // Somewhere to gather. The first thing any settlement builds.
  if (planned('hearth') === 0) {
    list.push({ def: byId('hearth'), reason: 'somewhere to sit of an evening' });
  }

  // Beds, always the loudest need.
  if (beds < population) {
    const wantsLonghouse = population >= 5 && resources.tools >= 4 && planned('longhouse') === 0;
    list.push({
      def: wantsLonghouse ? byId('longhouse') : byId('cottage'),
      reason: beds === 0 ? 'nobody has a bed' : 'not enough beds to go round',
    });
  }

  // Food, before it becomes a problem rather than after.
  const farms = planned('farm');
  if (resources.food < population * 12 && farms < Math.ceil(population / 3)) {
    list.push({ def: byId('farm'), reason: 'the food will not stretch' });
  }

  // Somewhere to put it all.
  if (view.totalStored > view.capacity * 0.8 && planned('barn') < 1 + Math.floor(population / 8)) {
    list.push({ def: byId('barn'), reason: 'the shelves are overflowing' });
  }

  // Tools, once there are enough hands to make it worth it.
  if (population >= 4 && planned('workshop') === 0) {
    list.push({ def: byId('workshop'), reason: 'good tools would make all this easier' });
  }

  if (population >= 3 && planned('well') === 0) {
    list.push({ def: byId('well'), reason: 'carrying water is getting old' });
  }

  // Fishing, if the sea is close enough to bother with.
  if (population >= 4 && planned('dock') === 0 && resources.food < population * 20) {
    list.push({ def: byId('dock'), reason: 'there are fish out there' });
  }

  if (population >= 6 && resources.tools >= 5 && planned('shrine') === 0) {
    list.push({ def: byId('shrine'), reason: 'they would like somewhere to leave offerings' });
  }

  // A second and third home once the place is really filling up.
  if (beds >= population && population >= 8 && completed('longhouse') === 0 && resources.tools >= 4) {
    list.push({ def: byId('longhouse'), reason: 'room to grow into' });
  }

  return list;
}

interface Site {
  x: number;
  z: number;
  score: number;
}

/**
 * Finds the best spot for a blueprint within reach of the village.
 *
 * Scans outward from the centre so that, all else equal, the village stays
 * compact instead of sprawling. Everything else is a tug against that: farms
 * want fertile soil, docks want the shoreline, and nothing wants to be jammed
 * up against an existing building.
 */
function findSite(view: PlannerView, def: BlueprintDef): Site | null {
  const { centre } = view;
  let best: Site | null = null;

  for (let dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; dz++) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
      const x = Math.round(centre.x) + dx;
      const z = Math.round(centre.z) + dz;
      if (!inBounds(x, z) || !inBounds(x + def.width - 1, z + def.depth - 1)) continue;

      const distance = Math.hypot(dx, dz);
      if (distance > SEARCH_RADIUS) continue;
      if (!view.structures.canPlace(def, x, z).ok) continue;

      // Close to home, but not on top of the neighbours.
      let score = 100 - distance * 3.2;
      const crowding = nearestStructureDistance(view.structures, x, z);
      if (crowding < 2.5) score -= 40;
      else if (crowding < 4) score -= 10;
      else if (crowding > 9) score -= (crowding - 9) * 2;

      score += siteBonus(view, def, x, z);
      if (!best || score > best.score) best = { x, z, score };
    }
  }

  return best;
}

/** Per-blueprint preferences about where it wants to stand. */
function siteBonus(view: PlannerView, def: BlueprintDef, x: number, z: number): number {
  const { terrain } = view;
  let bonus = 0;

  if (def.id === 'farm') {
    // Good soil, and out from under the trees.
    let fertility = 0;
    for (let dz = 0; dz < def.depth; dz++) {
      for (let dx = 0; dx < def.width; dx++) {
        fertility += terrain.fertility[(z + dz) * WORLD_SIZE + (x + dx)];
      }
    }
    bonus += (fertility / (def.width * def.depth)) * 40;
    bonus -= countNearby(terrain, x, z, 3, Occupancy.Prop) * 1.5;
  }

  if (def.id === 'dock') {
    // Deeper water off the end is a better mooring.
    bonus += countWater(terrain, x, z, 4) * 2.2;
  }

  if (def.id === 'hearth' || def.id === 'well' || def.id === 'shrine') {
    // Comfort buildings belong in the middle of things.
    bonus += 14;
  }

  if (def.id === 'cottage' || def.id === 'longhouse') {
    // A view is worth something, and nobody wants to live in a bog.
    const height = terrain.heightAt(x, z);
    bonus += Math.min(8, Math.max(0, height - WATER_LEVEL) * 1.1);
  }

  return bonus;
}

function nearestStructureDistance(structures: StructureRegistry, x: number, z: number): number {
  let nearest = Infinity;
  for (const structure of structures.structures) {
    const d = Math.hypot(structure.x + structure.width / 2 - x, structure.z + structure.depth / 2 - z);
    if (d < nearest) nearest = d;
  }
  return nearest;
}

function countNearby(terrain: Terrain, x: number, z: number, radius: number, flag: number): number {
  let count = 0;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (terrain.hasOccupancy(x + dx, z + dz, flag)) count++;
    }
  }
  return count;
}

function countWater(terrain: Terrain, x: number, z: number, radius: number): number {
  let count = 0;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (!terrain.isLand(x + dx, z + dz)) count++;
    }
  }
  return count;
}

export type { Structure };
