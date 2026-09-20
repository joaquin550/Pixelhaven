/**
 * The slice of the world a villager's brain is allowed to see.
 *
 * Declaring it as an interface (rather than importing Colony directly) keeps
 * the AI free of circular imports and makes the brain trivially testable with a
 * stub world.
 */
import type { Rng } from '../core/rng';
import type { ClockSnapshot } from '../core/time';
import type { NavGrid } from '../world/navgrid';
import type { PropRegistry } from '../world/props';
import type { Terrain } from '../world/terrain';
import type { ResourceKind } from '../build/blueprints';
import type { Structure, StructureRegistry } from '../build/structures';
import type { Villager } from './villager';

export interface ResourceDemand {
  wood: number;
  stone: number;
  food: number;
}

export type LogTone = 'neutral' | 'good' | 'warn' | 'milestone';

export interface ColonyView {
  resources: Record<ResourceKind, number>;
  capacity: number;
  villagers: Villager[];
  /** Weighted 0..1 urgency per resource, recomputed each simulation tick. */
  demand: ResourceDemand;
  /** Total charm from finished comfort buildings. */
  charm: number;
  /** Workshop bonus applied to construction work. */
  buildSpeed: number;
  /** Nearest place to drop off or pick up goods. */
  depotFor(x: number, z: number): { x: number; z: number };
  store(resource: ResourceKind, amount: number): number;
  take(resource: ResourceKind, amount: number): number;
  /** Home the villager sleeps in, if they have been given a bed. */
  homeOf(villager: Villager): Structure | undefined;
  log(message: string, tone?: LogTone): void;
  /** Fired when a structure is finished, so the colony can react. */
  onStructureComplete(structure: Structure, builder: Villager): void;
}

export interface SimContext {
  terrain: Terrain;
  nav: NavGrid;
  props: PropRegistry;
  structures: StructureRegistry;
  colony: ColonyView;
  clock: ClockSnapshot;
  rng: Rng;
  /** Wall-clock seconds this tick, already scaled by game speed. */
  dt: number;
  /** True while catching up on offline progress - skips cosmetic work. */
  fastForward: boolean;
  /**
   * Shared per-tick pathfinding allowance. A* is cheap but not free, so a
   * crowded haven staggers its route planning across frames instead of
   * dropping one.
   */
  budget: { paths: number };
}
