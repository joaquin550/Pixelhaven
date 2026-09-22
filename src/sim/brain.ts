/**
 * Villager decision making.
 *
 * A utility-scored state machine, which is the honest version of the brief's
 * "[idle, work, social] modes": every tick a villager without a task scores a
 * handful of candidate actions against their needs, their traits and what the
 * haven is short of, then commits to the winner until it finishes or stalls.
 *
 * The scores are deliberately soft and jittered. Two villagers with identical
 * traits standing in the same spot should not do the same thing, because a
 * diorama you watch for twenty minutes has to surprise you.
 */
import { clamp, clamp01 } from '../core/mathx';
import { SECONDS_PER_DAY } from '../core/time';
import { Occupancy } from '../world/constants';
import { HarvestKind, PROP_YIELD, Prop, isTree } from '../world/props';
import { BLUEPRINT_BY_ID, ResourceKind } from '../build/blueprints';
import { Structure } from '../build/structures';
import type { SimContext } from './context';
import type { Job } from './traits';
import { BubbleIcon, Task, TaskKind, Villager } from './villager';

const ENERGY_DRAIN = 0.2;
const ENERGY_RECOVERY = 0.95;
const HUNGER_RATE = 0.155;
const LONELY_RATE = 0.125;

/** How close a villager has to be to count as "there". */
const ARRIVE_RADIUS = 0.75;

export function updateVillager(v: Villager, ctx: SimContext): void {
  const dt = ctx.dt;
  v.age += dt / SECONDS_PER_DAY;
  v.animTime += dt;
  if (v.boost > 0) v.boost = Math.max(0, v.boost - dt);
  if (v.joy > 0) v.joy = Math.max(0, v.joy - dt * 1.2);
  if (v.repathCooldown > 0) v.repathCooldown = Math.max(0, v.repathCooldown - dt);
  if (v.bubbleTimer > 0) {
    v.bubbleTimer -= dt;
    if (v.bubbleTimer <= 0) v.bubble = 'none';
  }

  updateNeeds(v, ctx);

  if (!v.task) {
    v.idleFor += dt;
    v.anim = 'idle';
    chooseTask(v, ctx);
  }

  if (v.task) {
    v.idleFor = 0;
    v.task.timeout -= dt;
    if (v.task.timeout <= 0) {
      abandonTask(v, ctx);
    } else {
      executeTask(v, ctx);
    }
  }

  v.updateGroundHeight(ctx, dt);
}

/* ------------------------------------------------------------------ needs */

function updateNeeds(v: Villager, ctx: SimContext): void {
  const dt = ctx.dt;
  const asleep = v.anim === 'sleep';
  const working = v.anim === 'work';

  if (asleep) {
    v.energy = clamp(v.energy + ENERGY_RECOVERY * dt, 0, 100);
    v.lonely = clamp(v.lonely + LONELY_RATE * 0.3 * dt, 0, 100);
    v.hunger = clamp(v.hunger + HUNGER_RATE * 0.45 * v.mods.appetite * dt, 0, 100);
  } else {
    const effort = working ? 1.5 : 1;
    v.energy = clamp(v.energy - ENERGY_DRAIN * v.mods.energyDrain * effort * dt, 0, 100);
    v.hunger = clamp(v.hunger + HUNGER_RATE * v.mods.appetite * dt, 0, 100);
    v.lonely = clamp(v.lonely + LONELY_RATE * v.mods.socialDrive * dt, 0, 100);
  }

  // Mood is a readout, not a resource: it drives Favor income and the little
  // face in the inspector, and nothing bad happens when it dips.
  const home = ctx.colony.homeOf(v);
  let target = 52 + v.mods.moodBase + Math.min(22, ctx.colony.charm * 0.35);
  if (v.hunger > 60) target -= (v.hunger - 60) * 0.45;
  if (v.energy < 30) target -= (30 - v.energy) * 0.5;
  if (v.lonely > 65) target -= (v.lonely - 65) * 0.4;
  target += home ? 6 : -5;
  target += v.bestFriend() ? 6 : 0;
  target += v.joy;
  if (ctx.colony.resources.food <= 0) target -= 10;

  const goal = clamp(target, 0, 100);
  v.mood += (goal - v.mood) * clamp01(dt * 0.35);
}

/* ---------------------------------------------------------- task selection */

interface Candidate {
  kind: TaskKind;
  score: number;
  build: () => Task | null;
}

function chooseTask(v: Villager, ctx: SimContext): void {
  const { colony, clock, rng } = ctx;
  const candidates: Candidate[] = [];
  const daylightFactor = 0.45 + 0.55 * clock.daylight;
  const workBias = 1 + v.mods.workBias;

  // --- rest -------------------------------------------------------------
  const energyDeficit = clamp01((100 - v.energy) / 100);
  let sleepScore = Math.pow(energyDeficit, 1.7) * 2.1 * (clock.isNight ? 1.5 : 0.5) + v.mods.restBias;
  if (v.energy < 18) sleepScore += 1.6;
  if (v.energy > 88) sleepScore = -1;
  candidates.push({ kind: 'sleep', score: sleepScore, build: () => buildSleepTask(v, ctx) });

  // --- eat --------------------------------------------------------------
  if (colony.resources.food >= 1) {
    const hungerNorm = clamp01((v.hunger - 42) / 58);
    let eatScore = Math.pow(hungerNorm, 1.25) * 2.0;
    if (v.hunger > 85) eatScore += 1.3;
    candidates.push({ kind: 'eat', score: eatScore, build: () => buildEatTask(v, ctx) });
  }

  // --- socialise --------------------------------------------------------
  const lonelyNorm = clamp01((v.lonely - 28) / 62);
  const socialScore = lonelyNorm * 1.6 * v.mods.socialDrive * (clock.isNight ? 0.85 : 1);
  candidates.push({ kind: 'socialize', score: socialScore, build: () => buildSocialTask(v, ctx) });

  // --- construction -----------------------------------------------------
  const pending = ctx.structures.pending;
  if (pending.length > 0) {
    candidates.push({
      kind: 'build',
      score: 1.15 * workBias * daylightFactor * v.mods.building,
      build: () => buildConstructionTask(v, ctx),
    });
    candidates.push({
      kind: 'haul',
      score: 1.05 * workBias * daylightFactor,
      build: () => buildHaulTask(v, ctx),
    });
  }

  // --- gathering --------------------------------------------------------
  const spaceLeft = colony.capacity - totalStored(ctx);
  if (spaceLeft > 4) {
    candidates.push({
      kind: 'chop',
      score: colony.demand.wood * 1.7 * workBias * daylightFactor * affinity(v, 'forestry'),
      build: () => buildGatherTask(v, ctx, 'wood', 'chop'),
    });
    candidates.push({
      kind: 'mine',
      score: colony.demand.stone * 1.7 * workBias * daylightFactor * affinity(v, 'masonry'),
      build: () => buildGatherTask(v, ctx, 'stone', 'mine'),
    });
    candidates.push({
      kind: 'forage',
      score: colony.demand.food * 1.5 * workBias * daylightFactor * affinity(v, 'foraging'),
      build: () => buildGatherTask(v, ctx, 'food', 'forage'),
    });
    candidates.push({
      kind: 'harvest',
      score: colony.demand.food * 1.5 * workBias * daylightFactor * affinity(v, 'farming'),
      build: () => buildFarmTask(v, ctx, true),
    });
    candidates.push({
      kind: 'tend',
      score: (0.35 + colony.demand.food * 0.9) * workBias * daylightFactor * affinity(v, 'farming'),
      build: () => buildFarmTask(v, ctx, false),
    });
    candidates.push({
      kind: 'fish',
      score: colony.demand.food * 1.2 * workBias * daylightFactor,
      build: () => buildFishTask(v, ctx),
    });
  }

  // --- crafting ---------------------------------------------------------
  // Outside the storage-headroom block above, because a batch of tools costs
  // six units of raw material and returns three: crafting makes room rather
  // than filling it. It still needs the shelves not to be overflowing, or the
  // finished tools would have nowhere to go and the work would be wasted.
  if (
    colony.resources.wood >= CRAFT_WOOD &&
    colony.resources.stone >= CRAFT_STONE &&
    totalStored(ctx) <= colony.capacity
  ) {
    candidates.push({
      kind: 'craft',
      score: colony.demand.tools * 1.45 * workBias * daylightFactor * affinity(v, 'building'),
      build: () => buildCraftTask(v, ctx),
    });
  }

  // --- downtime ---------------------------------------------------------
  const restfulness = 0.12 + v.mods.restBias * 0.5 + (1 - clamp01(v.energy / 100)) * 0.35;
  candidates.push({ kind: 'relax', score: restfulness, build: () => buildRelaxTask(v, ctx) });
  candidates.push({ kind: 'wander', score: 0.18, build: () => buildWanderTask(v, ctx) });

  // Jitter breaks ties so identical villagers still feel like individuals.
  for (const c of candidates) c.score += rng.range(-0.14, 0.14);
  candidates.sort((a, b) => b.score - a.score);

  for (const candidate of candidates) {
    if (candidate.score <= -0.5) continue;
    const task = candidate.build();
    if (task) {
      v.task = task;
      v.path = [];
      v.pathIndex = 0;
      return;
    }
  }
}

function affinity(v: Villager, job: Job): number {
  // A villager leans towards what they are inclined to do and, more strongly,
  // towards what they have got good at. Nobody refuses anything else, though:
  // there is no such thing as an unemployable villager here.
  return 0.75 + v.mods[job] * 0.35 + (v.skills[job] / 100) * 0.3;
}

/** Practice pays out in yield as well as speed, up to a quarter more. */
function yieldBonus(v: Villager, job: Job): number {
  return 1 + (v.skills[job] / 100) * 0.25;
}

function totalStored(ctx: SimContext): number {
  const r = ctx.colony.resources;
  return (r.wood || 0) + (r.stone || 0) + (r.food || 0) + (r.tools || 0);
}

/* --------------------------------------------------------- task factories */

function makeTask(partial: Partial<Task> & Pick<Task, 'kind' | 'label' | 'targetX' | 'targetZ'>): Task {
  return {
    phase: 'travel',
    work: 0,
    totalWork: 0,
    timeout: 120,
    ...partial,
  };
}

function buildSleepTask(v: Villager, ctx: SimContext): Task | null {
  const home = ctx.colony.homeOf(v);
  let target: { x: number; z: number };
  if (home) {
    target = ctx.structures.accessPoint(home);
  } else {
    // No bed yet? Curl up next to the hearth, or right where they are.
    const hearth = nearestCompleted(ctx, v, ['hearth']);
    target = hearth ? ctx.structures.accessPoint(hearth) : { x: v.cellX, z: v.cellZ };
  }
  return makeTask({
    kind: 'sleep',
    label: home ? 'Heading home to sleep' : 'Finding somewhere to rest',
    targetX: target.x,
    targetZ: target.z,
    structureId: home?.id,
    work: 400,
    totalWork: 400,
    timeout: 600,
  });
}

function buildEatTask(v: Villager, ctx: SimContext): Task | null {
  if (ctx.colony.resources.food < 1) return null;
  const hearth = nearestCompleted(ctx, v, ['hearth']);
  const spot = hearth ? ctx.structures.accessPoint(hearth) : ctx.colony.depotFor(v.x, v.z);
  return makeTask({
    kind: 'eat',
    label: 'Getting something to eat',
    targetX: spot.x,
    targetZ: spot.z,
    work: 5,
    totalWork: 5,
    timeout: 150,
  });
}

function buildSocialTask(v: Villager, ctx: SimContext): Task | null {
  const partner = ctx.colony.villagers.find(
    (other) =>
      other.id !== v.id &&
      !other.isAsleep &&
      other.lonely > 25 &&
      !other.task?.playerDirected &&
      (!other.task || other.task.kind === 'wander' || other.task.kind === 'relax' || other.task.kind === 'idle') &&
      v.distanceTo(other.x, other.z) < 26,
  );
  if (!partner) return null;

  const hearth = nearestCompleted(ctx, v, ['hearth', 'well']);
  let meet: { x: number; z: number };
  if (hearth && v.distanceTo(hearth.x, hearth.z) < 22) {
    meet = ctx.structures.accessPoint(hearth);
  } else {
    const midX = Math.floor((v.x + partner.x) / 2);
    const midZ = Math.floor((v.z + partner.z) / 2);
    meet = ctx.nav.nearestWalkable(midX, midZ, 5) ?? { x: v.cellX, z: v.cellZ };
  }

  const chatSeconds = ctx.rng.range(7, 13);
  partner.clearTask();
  partner.task = makeTask({
    kind: 'socialize',
    label: `Chatting with ${v.name.split(' ')[0]}`,
    targetX: meet.x,
    targetZ: meet.z,
    partnerId: v.id,
    work: chatSeconds,
    totalWork: chatSeconds,
    timeout: 90,
  });

  return makeTask({
    kind: 'socialize',
    label: `Chatting with ${partner.name.split(' ')[0]}`,
    targetX: meet.x,
    targetZ: meet.z,
    partnerId: partner.id,
    work: chatSeconds,
    totalWork: chatSeconds,
    timeout: 90,
  });
}

function buildConstructionTask(v: Villager, ctx: SimContext): Task | null {
  let best: Structure | undefined;
  let bestDist = Infinity;
  for (const structure of ctx.structures.structures) {
    if (structure.state !== 'building') continue;
    const d = v.distanceTo(structure.x + structure.width / 2, structure.z + structure.depth / 2);
    if (d < bestDist) {
      bestDist = d;
      best = structure;
    }
  }
  if (!best) return null;
  const spot = ctx.structures.accessPoint(best);
  const remaining = best.work - best.progress;
  return makeTask({
    kind: 'build',
    label: `Building the ${BLUEPRINT_BY_ID.get(best.defId)?.name ?? 'structure'}`,
    targetX: spot.x,
    targetZ: spot.z,
    structureId: best.id,
    work: remaining,
    totalWork: best.work,
    timeout: 240,
  });
}

function buildHaulTask(v: Villager, ctx: SimContext): Task | null {
  for (const structure of ctx.structures.structures) {
    if (structure.state !== 'blueprint') continue;
    const outstanding = ctx.structures.outstanding(structure);
    for (const [resource, needed] of Object.entries(outstanding) as [ResourceKind, number][]) {
      const available = ctx.colony.resources[resource];
      if (available < 1) continue;
      const amount = Math.min(needed, available, v.carryCapacity);
      if (amount < 1) continue;
      const depot = ctx.colony.depotFor(v.x, v.z);
      return makeTask({
        kind: 'haul',
        label: `Carrying ${resource} to the site`,
        targetX: depot.x,
        targetZ: depot.z,
        structureId: structure.id,
        resource,
        amount,
        work: 1.2,
        totalWork: 1.2,
        timeout: 200,
      });
    }
  }
  return null;
}

function buildGatherTask(
  v: Villager,
  ctx: SimContext,
  resource: HarvestKind,
  kind: TaskKind,
): Task | null {
  const prop = ctx.props.findNearestHarvestable(v.x, v.z, resource);
  if (!prop) return null;
  const spot = ctx.nav.nearestWalkable(prop.cx, prop.cz, 3);
  if (!spot) return null;

  const info = PROP_YIELD[prop.kind]!;
  const job = resource === 'wood' ? 'forestry' : resource === 'stone' ? 'masonry' : 'foraging';
  prop.claimedBy = v.id;

  return makeTask({
    kind,
    label:
      resource === 'wood'
        ? 'Felling a tree'
        : resource === 'stone'
          ? 'Working the rock'
          : 'Picking berries',
    targetX: spot.x,
    targetZ: spot.z,
    propId: prop.id,
    resource,
    work: info.work / Math.max(0.35, v.workRate(job) * ctx.colony.toolEdge),
    totalWork: info.work,
    timeout: 220,
  });
}

function buildFarmTask(v: Villager, ctx: SimContext, wantRipe: boolean): Task | null {
  let best: Structure | undefined;
  let bestDist = Infinity;
  for (const farm of ctx.structures.completedOfType('farm')) {
    if (farm.claimedBy !== 0 && farm.claimedBy !== v.id) continue;
    const ripe = farm.crop >= 1;
    if (ripe !== wantRipe) continue;
    if (!wantRipe && farm.crop > 0.9) continue;
    const d = v.distanceTo(farm.x + 1.5, farm.z + 1.5);
    if (d < bestDist) {
      bestDist = d;
      best = farm;
    }
  }
  if (!best) return null;
  best.claimedBy = v.id;
  const spot = ctx.structures.accessPoint(best);
  const work = wantRipe ? 6 : 8;
  return makeTask({
    kind: wantRipe ? 'harvest' : 'tend',
    label: wantRipe ? 'Bringing in the harvest' : 'Tending the rows',
    targetX: spot.x,
    targetZ: spot.z,
    structureId: best.id,
    resource: 'food',
    work: work / Math.max(0.35, v.workRate('farming') * ctx.colony.toolEdge),
    totalWork: work,
    timeout: 200,
  });
}

/** Wood and stone in, tools out. */
export const CRAFT_WOOD = 4;
export const CRAFT_STONE = 2;
export const CRAFT_TOOLS = 3;

function buildCraftTask(v: Villager, ctx: SimContext): Task | null {
  const workshop = nearestCompleted(ctx, v, ['workshop'], (s) => s.claimedBy === 0 || s.claimedBy === v.id);
  if (!workshop) return null;
  workshop.claimedBy = v.id;
  const spot = ctx.structures.accessPoint(workshop);
  return makeTask({
    kind: 'craft',
    label: 'Making tools at the workshop',
    targetX: spot.x,
    targetZ: spot.z,
    structureId: workshop.id,
    resource: 'tools',
    work: 14 / Math.max(0.35, v.workRate('building') * ctx.colony.toolEdge),
    totalWork: 14,
    timeout: 220,
  });
}

function buildFishTask(v: Villager, ctx: SimContext): Task | null {
  const dock = nearestCompleted(ctx, v, ['dock'], (s) => s.claimedBy === 0 || s.claimedBy === v.id);
  if (!dock) return null;
  dock.claimedBy = v.id;
  const spot = ctx.structures.accessPoint(dock);
  return makeTask({
    kind: 'fish',
    label: 'Fishing off the dock',
    targetX: spot.x,
    targetZ: spot.z,
    structureId: dock.id,
    resource: 'food',
    work: 13 / Math.max(0.35, v.workRate('foraging') * ctx.colony.toolEdge),
    totalWork: 13,
    timeout: 220,
  });
}

function buildRelaxTask(v: Villager, ctx: SimContext): Task | null {
  const spot = nearestCompleted(ctx, v, ['hearth', 'well', 'shrine', 'dock']);
  const target = spot
    ? ctx.structures.accessPoint(spot)
    : ctx.nav.nearestWalkable(
        v.cellX + ctx.rng.int(-6, 6),
        v.cellZ + ctx.rng.int(-6, 6),
        4,
      );
  if (!target) return null;
  const seconds = ctx.rng.range(6, 14);
  return makeTask({
    kind: 'relax',
    label: spot ? 'Taking a moment' : 'Watching the weather',
    targetX: target.x,
    targetZ: target.z,
    work: seconds,
    totalWork: seconds,
    timeout: 120,
  });
}

function buildWanderTask(v: Villager, ctx: SimContext): Task | null {
  for (let attempt = 0; attempt < 6; attempt++) {
    const x = v.cellX + ctx.rng.int(-9, 9);
    const z = v.cellZ + ctx.rng.int(-9, 9);
    if (!ctx.nav.isWalkable(x, z)) continue;
    return makeTask({
      kind: 'wander',
      label: 'Strolling',
      targetX: x,
      targetZ: z,
      work: ctx.rng.range(1, 4),
      totalWork: 4,
      timeout: 90,
    });
  }
  return null;
}

/** Player-issued "go there" order. Overrides whatever they were doing. */
export function orderVillagerTo(v: Villager, ctx: SimContext, x: number, z: number): boolean {
  const spot = ctx.nav.nearestWalkable(x, z, 6);
  if (!spot) return false;
  releaseClaims(v, ctx);
  v.clearTask();
  v.task = makeTask({
    kind: 'goto',
    label: 'On their way',
    targetX: spot.x,
    targetZ: spot.z,
    work: 0.5,
    totalWork: 0.5,
    timeout: 180,
    playerDirected: true,
  });
  v.say('spark', 2.5);
  return true;
}

/* --------------------------------------------------------- task execution */

function executeTask(v: Villager, ctx: SimContext): void {
  const task = v.task!;

  if (task.phase === 'travel' || task.phase === 'deliver') {
    if (travel(v, ctx, task.targetX, task.targetZ)) {
      if (task.phase === 'deliver') {
        completeDelivery(v, ctx);
        return;
      }
      task.phase = 'work';
      onArrive(v, ctx);
    }
    return;
  }

  performWork(v, ctx);
}

/**
 * Walks towards a cell, planning or replanning a route as needed.
 * Returns true on arrival.
 */
function travel(v: Villager, ctx: SimContext, x: number, z: number): boolean {
  const targetX = x + 0.5;
  const targetZ = z + 0.5;
  if (v.distanceTo(targetX, targetZ) <= ARRIVE_RADIUS) {
    v.path = [];
    return true;
  }

  if (v.pathComplete) {
    if (v.repathCooldown > 0 || ctx.budget.paths <= 0) {
      v.anim = 'idle';
      return false;
    }
    ctx.budget.paths--;
    const path = ctx.nav.findPath(v.cellX, v.cellZ, x, z);
    if (!path || path.length === 0) {
      // Either already adjacent, or genuinely unreachable.
      if (v.distanceTo(targetX, targetZ) < 2.2) return true;
      v.repathCooldown = 1.5;
      abandonTask(v, ctx);
      return false;
    }
    v.setPath(path);
  }

  v.anim = v.carry ? 'carry' : 'walk';
  const arrived = v.followPath(ctx);
  return arrived && v.distanceTo(targetX, targetZ) <= 1.6;
}

function onArrive(v: Villager, ctx: SimContext): void {
  const task = v.task!;
  switch (task.kind) {
    case 'chop':
      v.say('axe', 4);
      break;
    case 'mine':
      v.say('pick', 4);
      break;
    case 'forage':
      v.say('berry', 4);
      break;
    case 'tend':
      v.say('hoe', 4);
      break;
    case 'harvest':
      v.say('hoe', 4);
      break;
    case 'fish':
      v.say('fish', 5);
      break;
    case 'craft':
      v.say('hammer', 5);
      break;
    case 'build':
      v.say('hammer', 5);
      break;
    case 'sleep':
      v.say('sleep', 6);
      break;
    case 'eat':
      v.say('meal', 3);
      break;
    case 'socialize':
      v.say('chat', 5);
      break;
    case 'relax':
      v.say(ctx.rng.chance(0.5) ? 'note' : 'none', 5);
      break;
    default:
      break;
  }
}

function performWork(v: Villager, ctx: SimContext): void {
  const task = v.task!;
  const dt = ctx.dt;

  switch (task.kind) {
    case 'sleep':
      return performSleep(v, ctx);

    case 'socialize':
      return performSocialize(v, ctx);

    case 'build':
      return performBuild(v, ctx);

    case 'haul':
      return performHaulPickup(v, ctx);

    case 'eat': {
      v.anim = 'sit';
      task.work -= dt;
      if (task.work <= 0) {
        if (ctx.colony.take('food', 1) > 0) {
          v.hunger = clamp(v.hunger - 72, 0, 100);
          v.energy = clamp(v.energy + 8, 0, 100);
          v.joy += 6;
          v.stats.mealsEaten++;
        }
        finishTask(v, ctx);
      }
      return;
    }

    case 'relax': {
      v.anim = 'sit';
      task.work -= dt;
      // A quiet sit takes the edge off, but it is no substitute for company.
      v.lonely = clamp(v.lonely - dt * 0.3, 0, 100);
      v.energy = clamp(v.energy + dt * 0.12, 0, 100);
      if (task.work <= 0) {
        v.joy += 5;
        finishTask(v, ctx);
      }
      return;
    }

    case 'wander':
    case 'goto':
    case 'idle': {
      v.anim = 'idle';
      task.work -= dt;
      if (task.work <= 0) finishTask(v, ctx);
      return;
    }

    default:
      return performGather(v, ctx);
  }
}

function performSleep(v: Villager, ctx: SimContext): void {
  const task = v.task!;
  v.anim = 'sleep';
  task.work -= ctx.dt;
  const rested = v.energy >= 96;
  const morning = ctx.clock.daylight > 0.5 && v.energy > 55;
  if (rested || morning || task.work <= 0) {
    v.joy += 3;
    finishTask(v, ctx);
  }
}

function performSocialize(v: Villager, ctx: SimContext): void {
  const task = v.task!;
  const partner = ctx.colony.villagers.find((o) => o.id === task.partnerId);
  if (!partner || partner.isAsleep) {
    finishTask(v, ctx);
    return;
  }

  // Wait politely for the other one to show up.
  if (partner.task?.kind !== 'socialize' || partner.task.phase === 'travel') {
    v.anim = 'idle';
    if (partner.distanceTo(v.x, v.z) > 14) finishTask(v, ctx);
    return;
  }

  v.anim = 'chat';
  v.facing = Math.atan2(partner.x - v.x, partner.z - v.z);
  task.work -= ctx.dt;
  v.lonely = clamp(v.lonely - ctx.dt * 6.5, 0, 100);

  if (task.work <= 0) {
    v.addFriendship(partner.id, 7);
    v.stats.chats++;
    v.joy += 7;
    if (!ctx.fastForward && ctx.rng.chance(0.3)) v.say('heart', 3);
    finishTask(v, ctx);
  }
}

function performBuild(v: Villager, ctx: SimContext): void {
  const task = v.task!;
  const structure = ctx.structures.byId(task.structureId ?? -1);
  if (!structure || structure.state !== 'building') {
    finishTask(v, ctx);
    return;
  }
  v.anim = 'work';
  faceTowards(v, structure.x + structure.width / 2, structure.z + structure.depth / 2);
  const amount = ctx.dt * v.workRate('building') * ctx.colony.buildSpeed * ctx.colony.toolEdge;
  const done = ctx.structures.applyWork(structure, amount);
  v.stats.built += amount;
  v.practise('building', ctx.dt * 0.22);
  task.work = structure.work - structure.progress;
  if (done) {
    ctx.colony.onStructureComplete(structure, v);
    v.joy += 10;
    finishTask(v, ctx);
  }
}

/** Haul step one: collect the goods from the stockpile. */
function performHaulPickup(v: Villager, ctx: SimContext): void {
  const task = v.task!;
  const structure = ctx.structures.byId(task.structureId ?? -1);
  if (!structure || structure.state !== 'blueprint' || !task.resource) {
    finishTask(v, ctx);
    return;
  }
  v.anim = 'work';
  task.work -= ctx.dt;
  if (task.work > 0) return;

  const outstanding = ctx.structures.outstanding(structure)[task.resource] ?? 0;
  const wanted = Math.min(outstanding, task.amount ?? 0, v.carryCapacity);
  const taken = ctx.colony.take(task.resource, wanted);
  if (taken <= 0) {
    finishTask(v, ctx);
    return;
  }

  v.carry = { resource: task.resource, amount: taken };
  v.say('crate', 4);
  const spot = ctx.structures.accessPoint(structure);
  task.targetX = spot.x;
  task.targetZ = spot.z;
  task.phase = 'deliver';
}

/** Gathering: chop / mine / forage / tend / harvest / fish. */
function performGather(v: Villager, ctx: SimContext): void {
  const task = v.task!;
  v.anim = 'work';
  task.work -= ctx.dt;

  if (task.kind === 'chop' || task.kind === 'mine' || task.kind === 'forage') {
    const prop = ctx.props.byId(task.propId ?? -1);
    if (!prop || prop.yield <= 0) {
      finishTask(v, ctx);
      return;
    }
    faceTowards(v, prop.x, prop.z);
    if (task.work > 0) return;
    harvestProp(v, ctx, prop);
    return;
  }

  const structure = ctx.structures.byId(task.structureId ?? -1);
  if (!structure) {
    finishTask(v, ctx);
    return;
  }
  faceTowards(v, structure.x + structure.width / 2, structure.z + structure.depth / 2);
  if (task.work > 0) return;

  if (task.kind === 'tend') {
    structure.crop = clamp01(structure.crop + 0.4);
    v.practise('farming', 1.1);
    v.joy += 2;
    finishTask(v, ctx);
    return;
  }

  if (task.kind === 'harvest') {
    // A practised farmer brings more in off the same rows.
    const amount = Math.round(9 * v.mods.farming * yieldBonus(v, 'farming'));
    structure.crop = 0;
    structure.claimedBy = 0;
    v.practise('farming', 1.6);
    startDelivery(v, ctx, 'food', amount);
    return;
  }

  if (task.kind === 'fish') {
    const amount = Math.round(5 * v.mods.foraging * yieldBonus(v, 'foraging'));
    structure.claimedBy = 0;
    v.practise('foraging', 1.4);
    startDelivery(v, ctx, 'food', amount);
    return;
  }

  if (task.kind === 'craft') {
    structure.claimedBy = 0;
    // The raw materials come off the shelf as the work finishes.
    const wood = ctx.colony.take('wood', CRAFT_WOOD);
    const stone = ctx.colony.take('stone', CRAFT_STONE);
    if (wood < CRAFT_WOOD || stone < CRAFT_STONE) {
      // Somebody beat them to the last of it. Put back what was taken.
      ctx.colony.store('wood', wood);
      ctx.colony.store('stone', stone);
      finishTask(v, ctx);
      return;
    }
    v.practise('building', 1.5);
    startDelivery(v, ctx, 'tools', Math.round(CRAFT_TOOLS * yieldBonus(v, 'building')));
    return;
  }

  finishTask(v, ctx);
}

function harvestProp(v: Villager, ctx: SimContext, prop: Prop): void {
  const info = PROP_YIELD[prop.kind];
  if (!info) {
    finishTask(v, ctx);
    return;
  }
  const job: Job =
    info.resource === 'wood' ? 'forestry' : info.resource === 'stone' ? 'masonry' : 'foraging';
  v.practise(job, 1.5);

  const amount = Math.min(prop.yield, v.carryCapacity);
  prop.yield -= amount;
  prop.claimedBy = 0;

  if (prop.yield <= 0) {
    if (prop.kind === 'bush') {
      // Bushes come back. Forests only come back if somebody replants.
      prop.regrowIn = 180;
    } else {
      ctx.props.remove(prop);
      if (isTree(prop.kind)) ctx.terrain.removeOccupancy(prop.cx, prop.cz, Occupancy.Prop);
      ctx.nav.rebuild();
    }
  }

  v.stats.gathered += amount;
  startDelivery(v, ctx, info.resource, amount);
}

/** Switches a finished gather task into its carry-it-home leg. */
function startDelivery(v: Villager, ctx: SimContext, resource: ResourceKind, amount: number): void {
  const task = v.task!;
  v.carry = { resource, amount };
  v.say('crate', 3);
  const depot = ctx.colony.depotFor(v.x, v.z);
  task.targetX = depot.x;
  task.targetZ = depot.z;
  task.phase = 'deliver';
  task.timeout = 200;
  v.path = [];
  v.pathIndex = 0;
}

function completeDelivery(v: Villager, ctx: SimContext): void {
  const task = v.task!;
  if (!v.carry) {
    finishTask(v, ctx);
    return;
  }

  if (task.kind === 'haul' && task.structureId) {
    const structure = ctx.structures.byId(task.structureId);
    if (structure && structure.state === 'blueprint') {
      ctx.structures.deliver(structure, v.carry.resource, v.carry.amount);
    } else {
      ctx.colony.store(v.carry.resource, v.carry.amount);
    }
  } else {
    const stored = ctx.colony.store(v.carry.resource, v.carry.amount);
    if (stored < v.carry.amount) v.say('spark', 2);
  }

  v.carry = null;
  v.joy += 2;
  finishTask(v, ctx);
}

function finishTask(v: Villager, ctx: SimContext): void {
  releaseClaims(v, ctx);
  v.clearTask();
  v.anim = 'idle';
}

function abandonTask(v: Villager, ctx: SimContext): void {
  releaseClaims(v, ctx);
  // Anything already in hand still goes to the stockpile - villagers do not
  // litter, and losing a load to a pathing hiccup would feel unfair.
  if (v.carry) {
    ctx.colony.store(v.carry.resource, v.carry.amount);
    v.carry = null;
  }
  v.clearTask();
  v.anim = 'idle';
  v.repathCooldown = Math.max(v.repathCooldown, 0.8);
}

function releaseClaims(v: Villager, ctx: SimContext): void {
  const task = v.task;
  if (!task) return;
  if (task.propId) {
    const prop = ctx.props.byId(task.propId);
    if (prop && prop.claimedBy === v.id) prop.claimedBy = 0;
  }
  if (task.structureId) {
    const structure = ctx.structures.byId(task.structureId);
    if (structure && structure.claimedBy === v.id) structure.claimedBy = 0;
  }
}

function faceTowards(v: Villager, x: number, z: number): void {
  v.facing = Math.atan2(x - v.x, z - v.z);
}

function nearestCompleted(
  ctx: SimContext,
  v: Villager,
  defIds: string[],
  filter?: (s: Structure) => boolean,
): Structure | undefined {
  let best: Structure | undefined;
  let bestDist = Infinity;
  for (const structure of ctx.structures.structures) {
    if (structure.state !== 'complete') continue;
    if (!defIds.includes(structure.defId)) continue;
    if (filter && !filter(structure)) continue;
    const d = v.distanceTo(structure.x + structure.width / 2, structure.z + structure.depth / 2);
    if (d < bestDist) {
      bestDist = d;
      best = structure;
    }
  }
  return best;
}

/** Icon shown above a villager's head for a given task, used by the renderer. */
export function bubbleForTask(kind: TaskKind): BubbleIcon {
  switch (kind) {
    case 'chop':
      return 'axe';
    case 'mine':
      return 'pick';
    case 'forage':
      return 'berry';
    case 'tend':
    case 'harvest':
      return 'hoe';
    case 'fish':
      return 'fish';
    case 'craft':
      return 'hammer';
    case 'build':
      return 'hammer';
    case 'haul':
      return 'crate';
    case 'sleep':
      return 'sleep';
    case 'eat':
      return 'meal';
    case 'socialize':
      return 'chat';
    default:
      return 'none';
  }
}
