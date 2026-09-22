/**
 * The voxel island.
 *
 * Terrain is a height field rather than a full 3D voxel volume: there are no
 * overhangs in Pixel Haven, so one integer height plus one material per column
 * describes the world exactly, meshes an order of magnitude faster, and makes
 * pathfinding a 2D problem. Cliffs still read as stacked cubes because the
 * mesher emits a side quad per exposed voxel layer.
 */
import { Noise2D } from '../core/noise';
import { Rng, hashSeed } from '../core/rng';
import { clamp, clamp01, smoothstep } from '../core/mathx';
import {
  MAX_HEIGHT,
  Occupancy,
  TRAIL_THRESHOLD,
  TerrainType,
  WATER_LEVEL,
  WEAR_DECAY,
  WORLD_SIZE,
  inBounds,
  index,
} from './constants';

export class Terrain {
  readonly size = WORLD_SIZE;
  readonly seed: string;
  readonly heights: Int16Array;
  readonly types: Uint8Array;
  readonly occupancy: Uint8Array;
  /** Soil fertility 0..1, drives where crops and forests thrive. */
  readonly fertility: Float32Array;
  /**
   * Footfall per cell, 0..1.
   *
   * Every step a villager takes adds a little; it fades over time. Where a
   * route is walked often enough the grass gives up and a trail appears, which
   * is then quicker to walk, which makes it get walked more. Nobody plans the
   * paths through a village and nobody plans these either.
   */
  readonly wear: Float32Array;
  /** Bumped whenever geometry changes so the renderer knows to re-mesh. */
  revision = 0;

  constructor(seed: string) {
    this.seed = seed;
    const cells = WORLD_SIZE * WORLD_SIZE;
    this.heights = new Int16Array(cells);
    this.types = new Uint8Array(cells);
    this.occupancy = new Uint8Array(cells);
    this.fertility = new Float32Array(cells);
    this.wear = new Float32Array(cells);
    generateIsland(this);
  }

  heightAt(x: number, z: number): number {
    if (!inBounds(x, z)) return 0;
    return this.heights[index(x, z)];
  }

  typeAt(x: number, z: number): number {
    if (!inBounds(x, z)) return TerrainType.Water;
    return this.types[index(x, z)];
  }

  setType(x: number, z: number, type: number): void {
    if (!inBounds(x, z)) return;
    this.types[index(x, z)] = type;
    this.revision++;
  }

  setHeight(x: number, z: number, height: number): void {
    if (!inBounds(x, z)) return;
    this.heights[index(x, z)] = clamp(Math.round(height), 0, MAX_HEIGHT);
    this.revision++;
  }

  /** Records a footstep. Returns true if this crossed the visible threshold. */
  addWear(x: number, z: number, amount: number): boolean {
    if (!inBounds(x, z)) return false;
    const i = index(x, z);
    const before = this.wear[i];
    this.wear[i] = Math.min(1, before + amount);
    return before < TRAIL_THRESHOLD && this.wear[i] >= TRAIL_THRESHOLD;
  }

  wearAt(x: number, z: number): number {
    if (!inBounds(x, z)) return 0;
    return this.wear[index(x, z)];
  }

  /** True once a cell is worn enough to walk quicker across. */
  isTrail(x: number, z: number): boolean {
    return this.wearAt(x, z) >= TRAIL_THRESHOLD;
  }

  /** Grass grows back over routes nobody uses any more. */
  fadeWear(dt: number): void {
    const decay = WEAR_DECAY * dt;
    const { wear } = this;
    for (let i = 0; i < wear.length; i++) {
      if (wear[i] > 0) wear[i] = Math.max(0, wear[i] - decay);
    }
  }

  isWater(x: number, z: number): boolean {
    return this.heightAt(x, z) < WATER_LEVEL;
  }

  /** Land above the tideline, ignoring anything built or grown on it. */
  isLand(x: number, z: number): boolean {
    return inBounds(x, z) && this.heights[index(x, z)] >= WATER_LEVEL;
  }

  occupancyAt(x: number, z: number): number {
    if (!inBounds(x, z)) return Occupancy.Structure;
    return this.occupancy[index(x, z)];
  }

  addOccupancy(x: number, z: number, flag: number): void {
    if (!inBounds(x, z)) return;
    this.occupancy[index(x, z)] |= flag;
  }

  removeOccupancy(x: number, z: number, flag: number): void {
    if (!inBounds(x, z)) return;
    this.occupancy[index(x, z)] &= ~flag;
  }

  hasOccupancy(x: number, z: number, flag: number): boolean {
    return (this.occupancyAt(x, z) & flag) !== 0;
  }

  /** Steepest height difference to any of the four neighbours. */
  slopeAt(x: number, z: number): number {
    const h = this.heightAt(x, z);
    let worst = 0;
    worst = Math.max(worst, Math.abs(h - this.heightAt(x + 1, z)));
    worst = Math.max(worst, Math.abs(h - this.heightAt(x - 1, z)));
    worst = Math.max(worst, Math.abs(h - this.heightAt(x, z + 1)));
    worst = Math.max(worst, Math.abs(h - this.heightAt(x, z - 1)));
    return worst;
  }

  /** True if every cell of a footprint is flat, dry, and unbuilt. */
  isBuildable(x0: number, z0: number, w: number, d: number): boolean {
    const base = this.heightAt(x0, z0);
    for (let z = z0; z < z0 + d; z++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!inBounds(x, z)) return false;
        if (this.heights[index(x, z)] !== base) return false;
        if (this.heights[index(x, z)] < WATER_LEVEL) return false;
        const occ = this.occupancy[index(x, z)];
        if (occ & (Occupancy.Structure | Occupancy.Prop)) return false;
      }
    }
    return true;
  }

  /** Flattens a footprint to its corner height - used when a build begins. */
  levelFootprint(x0: number, z0: number, w: number, d: number, type?: number): void {
    const base = this.heightAt(x0, z0);
    for (let z = z0; z < z0 + d; z++) {
      for (let x = x0; x < x0 + w; x++) {
        if (!inBounds(x, z)) continue;
        this.heights[index(x, z)] = base;
        if (type !== undefined) this.types[index(x, z)] = type;
      }
    }
    this.revision++;
  }
}

/**
 * Island generation.
 *
 * The shape comes from a radial falloff warped by noise, so the coastline is
 * organic rather than a circle, and the whole haven stays surrounded by water -
 * a diorama you can spin, not an endless map you get lost in.
 */
function generateIsland(terrain: Terrain): void {
  const seedNum = hashSeed(terrain.seed);
  const shape = new Noise2D(seedNum);
  const detail = new Noise2D(seedNum ^ 0x9e3779b9);
  const mountain = new Noise2D(seedNum ^ 0x85ebca6b);
  const moisture = new Noise2D(seedNum ^ 0xc2b2ae35);
  const coast = new Noise2D(seedNum ^ 0x27d4eb2f);

  const half = WORLD_SIZE / 2;
  const { heights, fertility } = terrain;
  // Heights are accumulated as floats and only quantised at the very end -
  // rounding each octave as it lands produces a corduroy of one-voxel terraces.
  const raw = new Float32Array(WORLD_SIZE * WORLD_SIZE);

  for (let z = 0; z < WORLD_SIZE; z++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const i = index(x, z);
      const nx = x / WORLD_SIZE;
      const nz = z / WORLD_SIZE;

      // Radial falloff, warped so the coast wanders.
      const dx = (x - half) / half;
      const dz = (z - half) / half;
      const radius = Math.sqrt(dx * dx + dz * dz);
      const coastWarp = coast.fbm(nx * 3.1, nz * 3.1, 3) * 0.22;
      const island = 1 - smoothstep(0.52 + coastWarp, 0.95 + coastWarp, radius);

      // Rolling base terrain.
      const base = shape.fbm(nx * 2.4, nz * 2.4, 5) * 0.5 + 0.5;
      const fine = detail.fbm(nx * 7.5, nz * 7.5, 3) * 0.5 + 0.5;

      // Mountains only in the island interior, masked so they form a ridge
      // rather than covering the whole map.
      const ridgeMask = clamp01(mountain.fbm(nx * 1.6 + 11, nz * 1.6 - 7, 2) * 0.5 + 0.5 - 0.32) * 2.2;
      const ridge = mountain.ridged(nx * 3.4, nz * 3.4, 4) * ridgeMask;

      const elevation = base * 0.64 + fine * 0.12 + ridge * 0.55;
      raw[i] = clamp(elevation * island * (MAX_HEIGHT - 3), 0, MAX_HEIGHT);

      fertility[i] = clamp01(moisture.fbm(nx * 4.2 - 5, nz * 4.2 + 3, 3) * 0.5 + 0.55);
    }
  }

  blurHeights(raw);
  for (let i = 0; i < raw.length; i++) heights[i] = Math.round(raw[i]);

  carveRiver(terrain, seedNum);
  smoothShallows(terrain);
  paintMaterials(terrain);
  terrain.revision++;
}

/**
 * One gentle blur pass over the float height field.
 *
 * Without it the terraces come out one voxel wide and the island reads as
 * corduroy; with it they broaden into the wide steps that make a voxel
 * landscape look carved rather than noisy.
 */
function blurHeights(raw: Float32Array): void {
  const copy = Float32Array.from(raw);
  const at = (x: number, z: number): number =>
    copy[index(clamp(x, 0, WORLD_SIZE - 1), clamp(z, 0, WORLD_SIZE - 1))];

  for (let z = 0; z < WORLD_SIZE; z++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const orthogonal = at(x - 1, z) + at(x + 1, z) + at(x, z - 1) + at(x, z + 1);
      const diagonal = at(x - 1, z - 1) + at(x + 1, z - 1) + at(x - 1, z + 1) + at(x + 1, z + 1);
      raw[index(x, z)] = copy[index(x, z)] * 0.38 + orthogonal * 0.125 + diagonal * 0.03;
    }
  }
}

/**
 * Carves a meandering river from the highest interior point down to the sea.
 * The walk is a noise-perturbed descent rather than true hydraulic erosion -
 * cheap, and it produces exactly the lazy S-bends a cozy village wants.
 */
function carveRiver(terrain: Terrain, seedNum: number): void {
  const rng = new Rng(seedNum ^ 0x5bf03635);
  const wander = new Noise2D(seedNum ^ 0x1b873593);
  const { heights } = terrain;

  // Start from a high cell near the middle of the island.
  let bestX = WORLD_SIZE / 2;
  let bestZ = WORLD_SIZE / 2;
  let bestH = -1;
  const inner = Math.floor(WORLD_SIZE * 0.22);
  for (let z = inner; z < WORLD_SIZE - inner; z++) {
    for (let x = inner; x < WORLD_SIZE - inner; x++) {
      const h = heights[index(x, z)];
      if (h > bestH) {
        bestH = h;
        bestX = x;
        bestZ = z;
      }
    }
  }
  if (bestH < WATER_LEVEL + 4) return; // Flat island, no river to carve.

  let x = bestX;
  let z = bestZ;
  let angle = rng.range(0, Math.PI * 2);
  const maxSteps = WORLD_SIZE * 3;

  for (let step = 0; step < maxSteps; step++) {
    // Steer downhill, nudged by noise so the river meanders.
    let downAngle = angle;
    let lowest = Infinity;
    for (let a = 0; a < 12; a++) {
      const test = (a / 12) * Math.PI * 2;
      const tx = Math.round(x + Math.cos(test) * 2);
      const tz = Math.round(z + Math.sin(test) * 2);
      if (!inBounds(tx, tz)) continue;
      const h = heights[index(tx, tz)];
      if (h < lowest) {
        lowest = h;
        downAngle = test;
      }
    }
    const meander = wander.sample(x * 0.08, z * 0.08) * 1.1;
    angle = downAngle + meander;

    x += Math.cos(angle);
    z += Math.sin(angle);
    if (!inBounds(Math.round(x), Math.round(z))) break;

    const t = step / maxSteps;
    const width = 1.1 + t * 1.9; // Widens into an estuary as it nears the sea.
    const depth = 2 + t * 2;
    carveDisc(terrain, x, z, width, depth);

    if (heights[index(Math.round(x), Math.round(z))] < WATER_LEVEL - 1) break;
  }
}

function carveDisc(terrain: Terrain, cx: number, cz: number, radius: number, depth: number): void {
  const r = Math.ceil(radius);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = Math.round(cx) + dx;
      const z = Math.round(cz) + dz;
      if (!inBounds(x, z)) continue;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > radius) continue;
      const i = index(x, z);
      const falloff = 1 - d / (radius + 0.001);
      const target = WATER_LEVEL - 1 + Math.round((1 - falloff) * depth * 0.5);
      if (terrain.heights[i] > target) {
        terrain.heights[i] = Math.max(target, terrain.heights[i] - Math.ceil(depth * falloff));
      }
    }
  }
}

/** Flattens single-voxel spikes in shallow water so beaches read as beaches. */
function smoothShallows(terrain: Terrain): void {
  const { heights } = terrain;
  const copy = Int16Array.from(heights);
  for (let z = 1; z < WORLD_SIZE - 1; z++) {
    for (let x = 1; x < WORLD_SIZE - 1; x++) {
      const i = index(x, z);
      if (copy[i] > WATER_LEVEL + 2) continue;
      const avg =
        (copy[index(x - 1, z)] + copy[index(x + 1, z)] + copy[index(x, z - 1)] + copy[index(x, z + 1)]) / 4;
      heights[i] = Math.round((copy[i] + avg) / 2);
    }
  }
}

/** Assigns a surface material per column from height, slope and moisture. */
function paintMaterials(terrain: Terrain): void {
  const { heights, types, fertility } = terrain;
  for (let z = 0; z < WORLD_SIZE; z++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const i = index(x, z);
      const h = heights[i];
      const slope = terrain.slopeAt(x, z);

      let type: number;
      if (h < WATER_LEVEL) {
        type = TerrainType.Sand; // Riverbed / seabed, seen through the water.
      } else if (h <= WATER_LEVEL + 1) {
        type = TerrainType.Sand;
      } else if (h > MAX_HEIGHT - 6) {
        type = TerrainType.Snow;
      } else if (slope >= 3 || h > MAX_HEIGHT - 10) {
        type = TerrainType.Stone;
      } else if (fertility[i] < 0.32) {
        type = TerrainType.Dirt;
      } else {
        type = TerrainType.Grass;
      }
      types[i] = type;
    }
  }
}

/** Finds a pleasant, flat, coastal-ish spot to drop the first villagers. */
export function findFoundingSite(terrain: Terrain): { x: number; z: number } {
  let best = { x: Math.floor(WORLD_SIZE / 2), z: Math.floor(WORLD_SIZE / 2) };
  let bestScore = -Infinity;
  const half = WORLD_SIZE / 2;

  for (let z = 6; z < WORLD_SIZE - 6; z += 2) {
    for (let x = 6; x < WORLD_SIZE - 6; x += 2) {
      if (!terrain.isLand(x, z)) continue;
      const h = terrain.heightAt(x, z);
      if (h < WATER_LEVEL + 2 || h > WATER_LEVEL + 8) continue;

      // Prefer big flat areas, some nearby water, and a spot near the middle.
      let flatness = 0;
      let water = 0;
      for (let dz = -4; dz <= 4; dz++) {
        for (let dx = -4; dx <= 4; dx++) {
          const nh = terrain.heightAt(x + dx, z + dz);
          if (nh === h) flatness++;
          if (nh < WATER_LEVEL) water++;
        }
      }
      const centrality = 1 - Math.hypot(x - half, z - half) / half;
      const score = flatness * 1.8 + Math.min(water, 12) * 0.8 + centrality * 30;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
  }
  return best;
}
