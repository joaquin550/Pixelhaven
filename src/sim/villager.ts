/**
 * A villager: body, needs, and whatever they are currently up to.
 *
 * The class holds state and movement. Decision making lives in brain.ts, so
 * that "what would they do next?" stays one readable file.
 */
import { Rng } from '../core/rng';
import { clamp, clamp01, dampAngle } from '../core/mathx';
import { Occupancy, TRAIL_SPEED_BONUS, WEAR_PER_STEP } from '../world/constants';
import type { PathNode } from '../world/navgrid';
import type { ResourceKind } from '../build/blueprints';
import {
  JOBS,
  JOB_VOCATION,
  Job,
  TraitModifiers,
  Vocation,
  combineTraits,
  inferVocation,
} from './traits';
import type { SimContext } from './context';

export type TaskKind =
  | 'idle'
  | 'wander'
  | 'chop'
  | 'mine'
  | 'forage'
  | 'tend'
  | 'harvest'
  | 'fish'
  | 'craft'
  | 'haul'
  | 'build'
  | 'eat'
  | 'sleep'
  | 'socialize'
  | 'relax'
  | 'goto';

export type TaskPhase = 'travel' | 'work' | 'deliver';

export interface Task {
  kind: TaskKind;
  label: string;
  phase: TaskPhase;
  targetX: number;
  targetZ: number;
  propId?: number;
  structureId?: number;
  partnerId?: number;
  resource?: ResourceKind;
  amount?: number;
  /** Remaining work seconds. */
  work: number;
  totalWork: number;
  /** Seconds before the villager gives up and re-decides. */
  timeout: number;
  /** True when the player personally pointed them somewhere. */
  playerDirected?: boolean;
}

export type AnimState = 'idle' | 'walk' | 'work' | 'sleep' | 'sit' | 'chat' | 'carry';

export type BubbleIcon =
  | 'axe'
  | 'pick'
  | 'berry'
  | 'hoe'
  | 'fish'
  | 'hammer'
  | 'crate'
  | 'sleep'
  | 'meal'
  | 'chat'
  | 'heart'
  | 'note'
  | 'spark'
  | 'none';

/** Purely cosmetic appearance seed, stored as small indices for compact saves. */
export interface VillagerLook {
  skin: number;
  hair: number;
  hairStyle: number;
  shirt: number;
  trousers: number;
  hat: number;
}

export const BASE_MOVE_SPEED = 2.35; // cells per second

export class Villager {
  id: number;
  name: string;
  traits: string[];
  mods: TraitModifiers;
  vocation: Vocation;
  look: VillagerLook;

  /** Continuous grid position. */
  x: number;
  z: number;
  /** Rendered height, damped towards the terrain surface. */
  y: number;
  facing = 0;

  /** Needs, 0..100. Energy is "full is good", hunger and lonely are "full is bad". */
  energy = 80;
  hunger = 20;
  lonely = 20;
  mood = 65;
  /** In-game days lived. Purely flavour; nobody ages out of Pixel Haven. */
  age = 0;

  task: Task | null = null;
  path: PathNode[] = [];
  pathIndex = 0;
  repathCooldown = 0;

  carry: { resource: ResourceKind; amount: number } | null = null;
  homeId = 0;
  friendships = new Map<number, number>();

  anim: AnimState = 'idle';
  animTime = 0;
  bubble: BubbleIcon = 'none';
  bubbleTimer = 0;
  /**
   * Hands-on proficiency per job, 0..100.
   *
   * Traits say what someone is inclined towards; skill is what they have
   * actually done. A villager who has felled a hundred trees is better at it
   * than one who merely has the knack, and after a few in-game weeks the
   * village has specialists nobody assigned.
   */
  skills: Record<Job, number> = { forestry: 0, masonry: 0, farming: 0, building: 0, foraging: 0 };

  /** Player-granted speed boost, in seconds. */
  boost = 0;
  /** Short-lived mood lift from gifts and good events. */
  joy = 0;
  /** Seconds since the villager last completed anything - used for nudges. */
  idleFor = 0;
  /** Stats shown in the inspector. */
  stats = { gathered: 0, built: 0, chats: 0, mealsEaten: 0, stepsTaken: 0 };

  constructor(id: number, name: string, traits: string[], look: VillagerLook, x: number, z: number, y: number) {
    this.id = id;
    this.name = name;
    this.traits = traits;
    this.mods = combineTraits(traits);
    this.vocation = inferVocation(this.mods);
    this.look = look;
    this.x = x;
    this.z = z;
    this.y = y;
  }

  get cellX(): number {
    return Math.floor(this.x);
  }

  get cellZ(): number {
    return Math.floor(this.z);
  }

  get isAsleep(): boolean {
    return this.anim === 'sleep';
  }

  get carryCapacity(): number {
    return Math.max(1, Math.round(6 * this.mods.carry));
  }

  /**
   * Current walking speed in cells per second.
   * `footing` is 0 on open ground and 1 on a cobbled path or a fully worn trail.
   */
  speed(footing: number): number {
    const boostFactor = this.boost > 0 ? 1.45 : 1;
    const tiredFactor = 0.7 + 0.3 * clamp01(this.energy / 70);
    const ground = 1 + clamp01(footing) * TRAIL_SPEED_BONUS;
    return BASE_MOVE_SPEED * this.mods.moveSpeed * boostFactor * tiredFactor * ground;
  }

  /** Per-job work multiplier, including skill, player boost and tiredness. */
  workRate(job: Job | 'generic'): number {
    const jobMod = job === 'generic' ? 1 : this.mods[job];
    const practice = job === 'generic' ? 1 : 1 + (this.skills[job] / 100) * 0.55;
    const boostFactor = this.boost > 0 ? 1.6 : 1;
    const tiredFactor = 0.55 + 0.45 * clamp01(this.energy / 60);
    return this.mods.workSpeed * jobMod * practice * boostFactor * tiredFactor;
  }

  /**
   * Records practice at a job. Improvement slows as proficiency rises, so the
   * first week is transformative and the fiftieth is a refinement.
   */
  practise(job: Job, amount: number): void {
    const current = this.skills[job];
    this.skills[job] = clamp(current + amount * (1 - current / 100) * 1.35, 0, 100);
  }

  /** The job this villager has actually become good at, if any. */
  get bestSkill(): { job: Job; level: number } | null {
    let best: { job: Job; level: number } | null = null;
    for (const job of JOBS) {
      if (!best || this.skills[job] > best.level) best = { job, level: this.skills[job] };
    }
    return best && best.level >= 12 ? best : null;
  }

  /** Inclination when untested, earned specialism once there is a track record. */
  get calling(): Vocation {
    const best = this.bestSkill;
    if (!best) return this.vocation;
    return JOB_VOCATION[best.job];
  }

  say(icon: BubbleIcon, seconds = 3): void {
    this.bubble = icon;
    this.bubbleTimer = seconds;
  }

  setPath(path: PathNode[]): void {
    this.path = path;
    this.pathIndex = 0;
  }

  clearTask(): void {
    this.task = null;
    this.path = [];
    this.pathIndex = 0;
  }

  /** True once the villager has walked the whole path. */
  get pathComplete(): boolean {
    return this.pathIndex >= this.path.length;
  }

  /**
   * Advances along the current path. Returns true when the destination is
   * reached this frame.
   */
  followPath(ctx: SimContext): boolean {
    if (this.pathComplete) return true;
    const node = this.path[this.pathIndex];
    const targetX = node.x + 0.5;
    const targetZ = node.z + 0.5;
    const dx = targetX - this.x;
    const dz = targetZ - this.z;
    const distance = Math.hypot(dx, dz);

    // Laid paths give full footing; worn grass gives however much of it the
    // village has walked in so far.
    const paved = ctx.terrain.hasOccupancy(node.x, node.z, Occupancy.Walkable);
    const footing = paved ? 1 : ctx.terrain.wearAt(node.x, node.z);
    const step = this.speed(footing) * ctx.dt;

    if (distance <= step || distance < 0.001) {
      this.x = targetX;
      this.z = targetZ;
      this.pathIndex++;
      this.stats.stepsTaken++;
      // Leave a mark. Only on open ground: cobbles and bridges do not wear,
      // and a dozing villager is not treading anything down.
      if (!paved) ctx.terrain.addWear(node.x, node.z, WEAR_PER_STEP);
      return this.pathComplete;
    }

    const inv = 1 / distance;
    this.x += dx * inv * step;
    this.z += dz * inv * step;
    this.facing = dampAngle(this.facing, Math.atan2(dx, dz), 12, ctx.dt);
    return false;
  }

  /** Keeps the sprite glued to the terrain, smoothing over voxel steps. */
  updateGroundHeight(ctx: SimContext, dt: number): void {
    const ground = ctx.terrain.heightAt(this.cellX, this.cellZ);
    const rate = Math.abs(ground - this.y) > 2 ? 1 : 0.18;
    this.y += clamp(ground - this.y, -rate, rate) * Math.min(1, dt * 12);
  }

  /** Distance in cells to a point. */
  distanceTo(x: number, z: number): number {
    return Math.hypot(this.x - x, this.z - z);
  }

  friendshipWith(other: number): number {
    return this.friendships.get(other) ?? 0;
  }

  addFriendship(other: number, amount: number): void {
    this.friendships.set(other, clamp(this.friendshipWith(other) + amount, 0, 100));
  }

  bestFriend(): { id: number; value: number } | undefined {
    let best: { id: number; value: number } | undefined;
    for (const [id, value] of this.friendships) {
      if (!best || value > best.value) best = { id, value };
    }
    return best && best.value > 12 ? best : undefined;
  }
}

/** Builds a villager with a random look and a compatible pair of traits. */
export function createVillager(
  id: number,
  name: string,
  rng: Rng,
  x: number,
  z: number,
  y: number,
  forcedTraits?: string[],
): Villager {
  const traits = forcedTraits ?? rollTraits(rng);
  const look: VillagerLook = {
    skin: rng.int(0, 5),
    hair: rng.int(0, 7),
    hairStyle: rng.int(0, 4),
    shirt: rng.int(0, 9),
    trousers: rng.int(0, 5),
    hat: rng.chance(0.28) ? rng.int(1, 3) : 0,
  };
  const villager = new Villager(id, name, traits, look, x, z, y);
  villager.energy = rng.range(65, 95);
  villager.hunger = rng.range(10, 35);
  villager.lonely = rng.range(10, 40);
  villager.facing = rng.range(0, Math.PI * 2);
  return villager;
}

/** Two traits, never contradictory ones. */
export function rollTraits(rng: Rng): string[] {
  const exclusive: string[][] = [
    ['lazy', 'diligent'],
    ['sociable', 'solitary'],
    ['optimist', 'grumbler'],
    ['nightowl', 'earlybird'],
    ['sturdy', 'nimble'],
  ];
  const pool = [
    'lazy', 'diligent', 'sociable', 'solitary', 'greenthumb', 'lumberjack',
    'stonecutter', 'carpenter', 'nightowl', 'earlybird', 'dreamer', 'glutton',
    'sturdy', 'nimble', 'optimist', 'grumbler', 'tinkerer', 'forager',
  ];
  const first = rng.pick(pool);
  const banned = new Set<string>([first]);
  for (const group of exclusive) {
    if (group.includes(first)) group.forEach((g) => banned.add(g));
  }
  const remaining = pool.filter((t) => !banned.has(t));
  const second = rng.pick(remaining);
  return [first, second];
}
