/** World-scale constants. One voxel is one unit in every axis. */

/** Cells per side of the island grid. */
export const WORLD_SIZE = 96;

/** Sea level, in voxels. Columns at or below this are underwater. */
export const WATER_LEVEL = 5;

/** Highest column the generator will produce. */
export const MAX_HEIGHT = 26;

/** Largest step a villager can walk up or down without stairs. */
export const MAX_STEP = 1;

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

export const index = (x: number, z: number): number => z * WORLD_SIZE + x;
export const inBounds = (x: number, z: number): boolean =>
  x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE;
