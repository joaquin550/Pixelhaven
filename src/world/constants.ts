/** World-scale constants. One voxel is one unit in every axis. */

/** Cells per side of the island grid. */
export const WORLD_SIZE = 96;

/** Sea level, in voxels. Columns at or below this are underwater. */
export const WATER_LEVEL = 5;

/** Highest column the generator will produce. */
export const MAX_HEIGHT = 26;

/** Largest step a villager can walk up or down without stairs. */
export const MAX_STEP = 1;

/**
 * Footfall added to a cell each time somebody walks onto it.
 *
 * Balanced against WEAR_DECAY: a cell holds its trail if it is stepped on
 * about once every two minutes, which a route between the storehouse and the
 * woods comfortably manages and a one-off stroll does not.
 */
export const WEAR_PER_STEP = 0.085;

/** How fast unused ground recovers, per second. */
export const WEAR_DECAY = 0.0006;

/** Footfall at which the grass gives up and a trail shows. */
export const TRAIL_THRESHOLD = 0.14;

/** How much quicker a fully worn trail is to walk than open ground. */
export const TRAIL_SPEED_BONUS = 0.3;

export const TerrainType = {
  Water: 0,
  Sand: 1,
  Grass: 2,
  Dirt: 3,
  Stone: 4,
  Snow: 5,
  Farmland: 6,
  Path: 7,
} as const;
export type TerrainType = (typeof TerrainType)[keyof typeof TerrainType];

/** Bit flags stored per cell in the occupancy mask. */
export const Occupancy = {
  Free: 0,
  /** A tree or boulder stands here - blocks walking until harvested. */
  Prop: 1 << 0,
  /** A finished or in-progress structure footprint. */
  Structure: 1 << 1,
  /** Structure tile you can still walk across (bridges, docks, paths, farm rows). */
  Walkable: 1 << 2,
  /** Reserved by a villager's current task so two of them don't collide on it. */
  Reserved: 1 << 3,
} as const;

/**
 * Cells per side of a mesh chunk.
 *
 * The island is meshed in chunks so sculpting only rebuilds what changed. A
 * full rebuild is ~25ms, which is a visible hitch every time the ground moves;
 * one chunk is under a millisecond.
 */
export const CHUNK_SIZE = 16;
export const CHUNKS_PER_SIDE = WORLD_SIZE / CHUNK_SIZE;
export const CHUNK_COUNT = CHUNKS_PER_SIDE * CHUNKS_PER_SIDE;

export const chunkIndexFor = (x: number, z: number): number =>
  Math.floor(z / CHUNK_SIZE) * CHUNKS_PER_SIDE + Math.floor(x / CHUNK_SIZE);

export const index = (x: number, z: number): number => z * WORLD_SIZE + x;
export const inBounds = (x: number, z: number): boolean =>
  x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE;
