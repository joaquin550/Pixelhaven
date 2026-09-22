/**
 * Natural features: trees, boulders, bushes, flowers, reeds.
 *
 * Per the design brief these are the one thing that does *not* snap to the
 * voxel grid - each prop sits at a random offset inside its cell with its own
 * rotation and scale, which is what keeps a blocky island from looking like
 * graph paper.
 */
import { Rng } from '../core/rng';
import { Noise2D } from '../core/noise';
import { clamp01 } from '../core/mathx';
import { Terrain } from './terrain';
import { MAX_HEIGHT, Occupancy, TerrainType, WATER_LEVEL, WORLD_SIZE, inBounds } from './constants';

export type PropKind =
  | 'pine'
  | 'oak'
  | 'birch'
  | 'palm'
  | 'boulder'
  | 'rock'
  | 'bush'
  | 'flower'
  | 'reed'
  | 'mushroom';

export interface Prop {
  id: number;
  kind: PropKind;
  /** Continuous world position - deliberately off-grid. */
  x: number;
  z: number;
  y: number;
  cx: number;
  cz: number;
  rotation: number;
  scale: number;
  /** Cosmetic variation index used by the mesh builder. */
  variant: number;
  /** Remaining yield for harvestable props. */
  yield: number;
  /** Seconds until a depleted bush bears fruit again. -1 when not regrowing. */
  regrowIn: number;
  /** Villager id that claimed this prop, or 0. */
  claimedBy: number;
  /** Removed props linger in the array one frame so renderers can react. */
  alive: boolean;
}

/** The resources that can be taken straight off the land. Tools are made. */
export type HarvestKind = 'wood' | 'stone' | 'food';

export const PROP_YIELD: Partial<
  Record<PropKind, { resource: HarvestKind; amount: number; work: number }>
> = {
  pine: { resource: 'wood', amount: 6, work: 7 },
  oak: { resource: 'wood', amount: 8, work: 9 },
  birch: { resource: 'wood', amount: 5, work: 6 },
  palm: { resource: 'wood', amount: 4, work: 5 },
  boulder: { resource: 'stone', amount: 8, work: 11 },
  rock: { resource: 'stone', amount: 4, work: 6 },
  bush: { resource: 'food', amount: 3, work: 3.5 },
};

export const TREE_KINDS: PropKind[] = ['pine', 'oak', 'birch', 'palm'];

export function isTree(kind: PropKind): boolean {
  return TREE_KINDS.includes(kind);
}

/** Props that physically block a villager's path until they are cleared. */
export function blocksMovement(kind: PropKind): boolean {
  return isTree(kind) || kind === 'boulder';
}

export class PropRegistry {
  props: Prop[] = [];
  private nextId = 1;
  /** Incremented whenever the set of props changes, so meshes rebuild. */
  revision = 0;

  constructor(private terrain: Terrain) {}

  add(kind: PropKind, x: number, z: number, rng: Rng): Prop {
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    const yieldInfo = PROP_YIELD[kind];
    const prop: Prop = {
      id: this.nextId++,
      kind,
      x,
      z,
      y: this.terrain.heightAt(cx, cz),
      cx,
      cz,
      rotation: rng.range(0, Math.PI * 2),
      scale: rng.range(0.82, 1.24),
      variant: rng.int(0, 3),
      yield: yieldInfo ? yieldInfo.amount : 0,
      regrowIn: -1,
      claimedBy: 0,
      alive: true,
    };
    this.props.push(prop);
    if (blocksMovement(kind)) this.terrain.addOccupancy(cx, cz, Occupancy.Prop);
    this.revision++;
    return prop;
  }

  remove(prop: Prop): void {
    prop.alive = false;
    const idx = this.props.indexOf(prop);
    if (idx >= 0) this.props.splice(idx, 1);
    if (blocksMovement(prop.kind)) this.terrain.removeOccupancy(prop.cx, prop.cz, Occupancy.Prop);
    this.revision++;
  }

  byId(id: number): Prop | undefined {
    return this.props.find((p) => p.id === id);
  }

  /** Nearest harvestable prop of a given resource, skipping claimed ones. */
  findNearestHarvestable(
    x: number,
    z: number,
    resource: HarvestKind,
    maxDist = WORLD_SIZE,
  ): Prop | undefined {
    let best: Prop | undefined;
    let bestDist = maxDist * maxDist;
    for (const prop of this.props) {
      const info = PROP_YIELD[prop.kind];
      if (!info || info.resource !== resource) continue;
      if (prop.yield <= 0 || prop.claimedBy !== 0) continue;
      const d = (prop.x - x) ** 2 + (prop.z - z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = prop;
      }
    }
    return best;
  }

  countOf(resource: HarvestKind): number {
    let n = 0;
    for (const prop of this.props) {
      const info = PROP_YIELD[prop.kind];
      if (info && info.resource === resource && prop.yield > 0) n++;
    }
    return n;
  }

  /** Berry bushes refill, and the forest slowly reclaims empty ground. */
  update(dt: number): void {
    let changed = false;
    for (const prop of this.props) {
      if (prop.regrowIn > 0) {
        prop.regrowIn -= dt;
        if (prop.regrowIn <= 0) {
          prop.regrowIn = -1;
          prop.yield = PROP_YIELD[prop.kind]?.amount ?? 0;
          changed = true;
        }
      }
    }
    if (changed) this.revision++;
  }

  /** Plants a sapling on a free, fertile cell. Used by forest regrowth. */
  tryPlantTree(rng: Rng): Prop | undefined {
    for (let attempt = 0; attempt < 24; attempt++) {
      const x = rng.int(2, WORLD_SIZE - 3);
      const z = rng.int(2, WORLD_SIZE - 3);
      if (!this.terrain.isLand(x, z)) continue;
      if (this.terrain.occupancyAt(x, z) !== Occupancy.Free) continue;
      const type = this.terrain.typeAt(x, z);
      if (type !== TerrainType.Grass && type !== TerrainType.Dirt) continue;
      if (this.terrain.slopeAt(x, z) > 1) continue;
      if (hasTreeNeighbour(this.terrain, x, z)) continue;
      const kind = rng.weighted(['pine', 'oak', 'birch'] as PropKind[], [3, 3, 2]);
      return this.add(kind, x + rng.range(0.2, 0.8), z + rng.range(0.2, 0.8), rng);
    }
    return undefined;
  }
}

/**
 * Scatters the starting flora and geology.
 *
 * Forest density follows a low-frequency noise field so woods clump into groves
 * with clearings between them, instead of an even dusting of trees.
 */
export function scatterProps(terrain: Terrain, registry: PropRegistry, seed: number): void {
  const rng = new Rng(seed ^ 0x7f4a7c15);
  const forest = new Noise2D(seed ^ 0x2545f491);
  const rocks = new Noise2D(seed ^ 0x94d049bb);

  for (let z = 1; z < WORLD_SIZE - 1; z++) {
    for (let x = 1; x < WORLD_SIZE - 1; x++) {
      if (!terrain.isLand(x, z)) {
        maybeReed(terrain, registry, rng, x, z);
        continue;
      }
      if (terrain.occupancyAt(x, z) !== Occupancy.Free) continue;

      const h = terrain.heightAt(x, z);
      const type = terrain.typeAt(x, z);
      const slope = terrain.slopeAt(x, z);
      const fert = terrain.fertility[z * WORLD_SIZE + x];

      // Raised to a power so groves read as groves and the gaps between them
      // stay properly open - villages need somewhere to go.
      const groveField = Math.pow(clamp01(forest.fbm(x * 0.045, z * 0.045, 3) * 0.5 + 0.5), 1.9);
      const rockField = clamp01(rocks.fbm(x * 0.07 + 31, z * 0.07 - 17, 3) * 0.5 + 0.5);

      // Trees: grass and dirt, gentle slopes, denser in fertile groves.
      // Never two trees side by side: a solid wall of trunks hides the
      // villagers, blocks every path through the wood, and reads as a green
      // blanket rather than a forest you can walk into.
      if ((type === TerrainType.Grass || type === TerrainType.Dirt) && slope <= 1 && !hasTreeNeighbour(terrain, x, z)) {
        const density = groveField * fert * 0.78;
        if (rng.chance(density)) {
          const kind = pickTreeKind(rng, h, fert);
          registry.add(kind, x + rng.range(0.15, 0.85), z + rng.range(0.15, 0.85), rng);
          continue;
        }
      }

      // Palms fringe the beaches.
      if (type === TerrainType.Sand && slope <= 1 && rng.chance(0.045)) {
        registry.add('palm', x + rng.range(0.2, 0.8), z + rng.range(0.2, 0.8), rng);
        continue;
      }

      // Boulders and loose rock on stone, snow and steep ground.
      if (type === TerrainType.Stone || type === TerrainType.Snow || slope >= 2) {
        if (rng.chance(rockField * 0.3)) {
          registry.add(rng.chance(0.45) ? 'boulder' : 'rock', x + rng.range(0.2, 0.8), z + rng.range(0.2, 0.8), rng);
          continue;
        }
      } else if (rng.chance(rockField * 0.035)) {
        registry.add('rock', x + rng.range(0.2, 0.8), z + rng.range(0.2, 0.8), rng);
        continue;
      }

      // Undergrowth: berry bushes, flowers, mushrooms. None of these block.
      if (type === TerrainType.Grass) {
        if (rng.chance(fert * 0.05)) {
          registry.add('bush', x + rng.range(0.2, 0.8), z + rng.range(0.2, 0.8), rng);
        } else if (rng.chance(0.1)) {
          registry.add('flower', x + rng.range(0.15, 0.85), z + rng.range(0.15, 0.85), rng);
        } else if (groveField > 0.62 && rng.chance(0.03)) {
          registry.add('mushroom', x + rng.range(0.25, 0.75), z + rng.range(0.25, 0.75), rng);
        }
      }
    }
  }
}

/** True when an orthogonal neighbour already holds a blocking prop. */
function hasTreeNeighbour(terrain: Terrain, x: number, z: number): boolean {
  return (
    terrain.hasOccupancy(x + 1, z, Occupancy.Prop) ||
    terrain.hasOccupancy(x - 1, z, Occupancy.Prop) ||
    terrain.hasOccupancy(x, z + 1, Occupancy.Prop) ||
    terrain.hasOccupancy(x, z - 1, Occupancy.Prop)
  );
}

function pickTreeKind(rng: Rng, height: number, fertility: number): PropKind {
  const alpine = height > MAX_HEIGHT - 12 ? 3 : 1;
  return rng.weighted(['pine', 'oak', 'birch'] as PropKind[], [2 * alpine, 3 * fertility, 2]);
}

/** Reeds grow in the shallows along the shoreline, one voxel under the water. */
function maybeReed(terrain: Terrain, registry: PropRegistry, rng: Rng, x: number, z: number): void {
  const h = terrain.heightAt(x, z);
  if (h < WATER_LEVEL - 2 || h >= WATER_LEVEL) return;
  let touchesLand = false;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    if (inBounds(x + dx, z + dz) && terrain.isLand(x + dx, z + dz)) touchesLand = true;
  }
  if (!touchesLand) return;
  if (rng.chance(0.3)) {
    registry.add('reed', x + rng.range(0.2, 0.8), z + rng.range(0.2, 0.8), rng);
  }
}
