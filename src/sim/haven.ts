/**
 * The Haven: the whole simulation in one object.
 *
 * Owns the island, its props, its buildings and its people, and advances all of
 * them. Rendering, input and UI all read from here and never write to it except
 * through the small set of player actions at the bottom of the file.
 */
import { Emitter } from '../core/events';
import { Rng } from '../core/rng';
import { clamp, clamp01 } from '../core/mathx';
import { ClockSnapshot, WorldClock } from '../core/time';
import { Terrain, findFoundingSite } from '../world/terrain';
import { PropRegistry, scatterProps } from '../world/props';
import { NavGrid } from '../world/navgrid';
import { WATER_LEVEL, WORLD_SIZE } from '../world/constants';
import { BLUEPRINT_BY_ID, BlueprintDef, ResourceKind } from '../build/blueprints';
import { Structure, StructureRegistry } from '../build/structures';
import { ColonyView, LogTone, ResourceDemand, SimContext } from './context';
import { Villager, createVillager } from './villager';
import { orderVillagerTo, updateVillager } from './brain';
import { childName, randomName } from './names';
import { hashSeed } from '../core/rng';

export interface LogEntry {
  id: number;
  message: string;
  tone: LogTone;
  day: number;
  /** Real seconds since the entry was created, used to fade it out. */
  age: number;
}

export type HavenEvents = {
  log: LogEntry;
  structureComplete: Structure;
  structurePlaced: Structure;
  villagerAdded: Villager;
  milestone: { title: string; body: string };
  propsChanged: void;
};

/** Player abilities paid for with Favor. */
export interface Miracle {
  id: 'meal' | 'rally' | 'bloom' | 'lullaby';
  name: string;
  blurb: string;
  cost: number;
  glyph: string;
  /** True when the miracle needs a villager selected first. */
  targeted: boolean;
}

export const MIRACLES: Miracle[] = [
  { id: 'meal', name: 'Warm Meal', blurb: 'Feed one villager and put a spring in their step.', cost: 4, glyph: 'meal', targeted: true },
  { id: 'rally', name: 'Good Morning', blurb: 'Everyone works faster for a while.', cost: 18, glyph: 'spark', targeted: false },
  { id: 'bloom', name: 'Bloom', blurb: 'Crops ripen at once and the forest sends up saplings.', cost: 26, glyph: 'leaf', targeted: false },
  { id: 'lullaby', name: 'Lullaby', blurb: 'Rest the whole haven. Everyone wakes restored.', cost: 22, glyph: 'note', targeted: false },
];

export const MAX_POPULATION = 48;

export class Haven implements ColonyView {
  readonly seed: string;
  readonly terrain: Terrain;
  readonly props: PropRegistry;
  readonly nav: NavGrid;
  readonly structures: StructureRegistry;
  readonly clock: WorldClock;
  readonly events = new Emitter<HavenEvents>();
  readonly rng: Rng;

  resources: Record<ResourceKind, number> = { wood: 40, stone: 20, food: 35, tools: 0 };
  favor = 6;
  villagers: Villager[] = [];
  demand: ResourceDemand = { wood: 1, stone: 1, food: 1, tools: 1 };
  charm = 0;
  buildSpeed = 1;
  toolEdge = 1;
  capacity = 400;
  beds = 0;

  /** Where the haven was founded. Always a valid drop-off point. */
  readonly origin: { x: number; z: number };
  logs: LogEntry[] = [];

  /** Totals the player sees on the stats panel. */
  stats = {
    structuresBuilt: 0,
    villagersBorn: 0,
    villagersArrived: 0,
    resourcesGathered: 0,
    daysPassed: 0,
  };

  // Public because the save system round-trips them; nothing else writes here.
  nextVillagerId = 1;
  nextLogId = 1;
  milestonesHit = new Set<string>();
  private derivedTimer = 0;
  private growthTimer = 25;
  private regrowthTimer = 40;
  private favorAccumulator = 0;
  /** Stops the "storehouse is full" nudge repeating every few seconds. */
  private fullStoreCooldown = 0;
  /** Footfall fades on a timer rather than every tick - it is a whole-island pass. */
  private wearTimer = 0;
  private lastDayLogged = 1;

  constructor(seed: string, options: { populate?: boolean; blank?: boolean } = {}) {
    this.seed = seed;
    this.rng = new Rng(`${seed}:sim`);
    this.terrain = new Terrain(seed);
    this.props = new PropRegistry(this.terrain);
    // A blank haven is one that is about to be overwritten from a save file,
    // so there is no point scattering a forest just to throw it away.
    if (!options.blank) scatterProps(this.terrain, this.props, hashSeed(seed));
    this.nav = new NavGrid(this.terrain);
    this.structures = new StructureRegistry(this.terrain);
    this.clock = new WorldClock();
    this.origin = findFoundingSite(this.terrain);

    if (options.populate !== false && !options.blank) {
      this.foundVillage();
    }
    this.recomputeDerived();
  }

  /* ------------------------------------------------------------ founding */

  private foundVillage(): void {
    const count = 4;
    for (let i = 0; i < count; i++) {
      const spot = this.spawnPointNear(this.origin.x, this.origin.z, 4);
      this.addVillager(spot.x, spot.z);
    }
    this.log('Four travellers stopped walking and decided this would do.', 'milestone');
  }

  private spawnPointNear(x: number, z: number, radius: number): { x: number; z: number } {
    for (let attempt = 0; attempt < 40; attempt++) {
      const cx = Math.round(x + this.rng.range(-radius, radius));
      const cz = Math.round(z + this.rng.range(-radius, radius));
      if (this.nav.isWalkable(cx, cz)) return { x: cx, z: cz };
    }
    const fallback = this.nav.nearestWalkable(Math.round(x), Math.round(z), 12);
    return fallback ?? { x: Math.round(x), z: Math.round(z) };
  }

  addVillager(cellX: number, cellZ: number, name?: string, traits?: string[]): Villager {
    const takenNames = new Set(this.villagers.map((v) => v.name));
    const villager = createVillager(
      this.nextVillagerId++,
      name ?? randomName(this.rng, takenNames),
      this.rng,
      cellX + 0.5,
      cellZ + 0.5,
      this.terrain.heightAt(cellX, cellZ),
      traits,
    );
    this.villagers.push(villager);
    this.assignHomes();
    this.events.emit('villagerAdded', villager);
    return villager;
  }

  villagerById(id: number): Villager | undefined {
    return this.villagers.find((v) => v.id === id);
  }

  /* -------------------------------------------------------------- update */

  update(dt: number, fastForward = false): void {
    if (dt <= 0) return;
    this.clock.advance(dt);
    const snapshot = this.clock.snapshot();

    this.derivedTimer -= dt;
    if (this.derivedTimer <= 0) {
      this.recomputeDerived();
      this.derivedTimer = 0.5;
    }

    const ctx: SimContext = {
      terrain: this.terrain,
      nav: this.nav,
      props: this.props,
      structures: this.structures,
      colony: this,
      clock: snapshot,
      rng: this.rng,
      dt,
      fastForward,
      // Catch-up ticks get a generous budget; live frames stay smooth.
      budget: { paths: fastForward ? 64 : 8 },
    };

    for (const villager of this.villagers) {
      updateVillager(villager, ctx);
    }

    this.updateFarms(dt);
    this.updateWear(dt);
    this.props.update(dt);
    this.updateFavor(dt, snapshot);
    this.updateStructureAges(dt);
    this.updatePopulation(dt);
    this.updateRegrowth(dt);
    this.updateLogs(dt);
    this.checkStorage(dt);

    if (snapshot.day !== this.lastDayLogged) {
      this.lastDayLogged = snapshot.day;
      this.stats.daysPassed = snapshot.day - 1;
      this.onNewDay(snapshot);
    }
  }

  private recomputeDerived(): void {
    let charm = 0;
    let storage = 400;
    let workshops = 0;
    let beds = 0;

    for (const structure of this.structures.structures) {
      if (structure.state !== 'complete') continue;
      const def = BLUEPRINT_BY_ID.get(structure.defId);
      if (!def) continue;
      charm += def.charm ?? 0;
      storage += def.storage ?? 0;
      beds += def.beds ?? 0;
      if (def.id === 'workshop') workshops++;
    }

    this.charm = charm;
    this.capacity = storage;
    this.beds = beds;
    this.buildSpeed = 1 + workshops * 0.35;
    // A stocked toolshed is felt across every job, and caps out quickly so it
    // never becomes the only thing worth doing.
    this.toolEdge = 1 + Math.min(0.3, (this.resources.tools || 0) / 90);

    // Demand: what should villagers bother gathering right now?
    const pop = Math.max(1, this.villagers.length);
    let woodNeed = 14;
    let stoneNeed = 8;
    let toolNeed = 0;
    for (const structure of this.structures.pending) {
      const outstanding = this.structures.outstanding(structure);
      woodNeed += outstanding.wood ?? 0;
      stoneNeed += outstanding.stone ?? 0;
      toolNeed += outstanding.tools ?? 0;
    }
    const foodTarget = 18 + pop * 13;
    // Keep a working set of tools on the shelf plus whatever is owed to sites.
    const toolTarget = workshops > 0 ? 12 + pop * 1.5 + toolNeed * 2 : toolNeed;

    this.demand = {
      wood: Math.max(0.45, clamp01((woodNeed * 1.6 - this.resources.wood) / Math.max(10, woodNeed * 1.6))),
      stone: Math.max(0.4, clamp01((stoneNeed * 1.6 - this.resources.stone) / Math.max(8, stoneNeed * 1.6))),
      food: Math.max(0.5, clamp01((foodTarget - this.resources.food) / foodTarget)),
      tools: toolTarget <= 0 ? 0 : clamp01((toolTarget - this.resources.tools) / toolTarget),
    };
  }

  private updateFarms(dt: number): void {
    for (const farm of this.structures.completedOfType('farm')) {
      if (farm.crop < 1) {
        // Seasons are cosmetic by design, so crops grow at the same steady
        // rate all year. Winter just looks different.
        farm.crop = clamp01(farm.crop + dt * 0.0026);
      }
    }
  }

  /** Grass creeping back over routes that have fallen out of use. */
  private updateWear(dt: number): void {
    this.wearTimer += dt;
    if (this.wearTimer < 0.5) return;
    this.terrain.fadeWear(this.wearTimer);
    this.wearTimer = 0;
  }

  private updateStructureAges(dt: number): void {
    for (const structure of this.structures.structures) {
      if (structure.state === 'complete' && structure.age < 100) structure.age += dt;
    }
  }

  private updateFavor(dt: number, snapshot: ClockSnapshot): void {
    let structureFavor = 0;
    for (const structure of this.structures.completed) {
      structureFavor += BLUEPRINT_BY_ID.get(structure.defId)?.favor ?? 0;
    }
    const avgMood =
      this.villagers.length > 0
        ? this.villagers.reduce((sum, v) => sum + v.mood, 0) / this.villagers.length
        : 50;
    const moodFactor = 0.4 + (avgMood / 100) * 1.2;
    const perMinute = (1.1 + this.villagers.length * 0.18 + structureFavor) * moodFactor;
    this.favorAccumulator += (perMinute / 60) * dt;
    if (this.favorAccumulator >= 0.01) {
      this.favor = Math.min(999, this.favor + this.favorAccumulator);
      this.favorAccumulator = 0;
    }
    void snapshot;
  }

  /** Favor earned per in-game minute, shown as a rate in the HUD. */
  get favorRate(): number {
    let structureFavor = 0;
    for (const structure of this.structures.completed) {
      structureFavor += BLUEPRINT_BY_ID.get(structure.defId)?.favor ?? 0;
    }
    const avgMood = this.averageMood;
    const moodFactor = 0.4 + (avgMood / 100) * 1.2;
    return (1.1 + this.villagers.length * 0.18 + structureFavor) * moodFactor;
  }

  /**
   * Everything on the shelves, which is what the storage cap measures.
   *
   * Tolerates a missing line. A resources object assembled elsewhere - an old
   * save, the debug handle, a test - that omits one kind would otherwise turn
   * this into NaN, and from there every total, every demand figure and every
   * villager's decisions quietly become NaN too.
   */
  get totalStored(): number {
    const r = this.resources;
    return (r.wood || 0) + (r.stone || 0) + (r.food || 0) + (r.tools || 0);
  }

  get averageMood(): number {
    if (this.villagers.length === 0) return 50;
    return this.villagers.reduce((sum, v) => sum + v.mood, 0) / this.villagers.length;
  }

  private updatePopulation(dt: number): void {
    this.growthTimer -= dt;
    if (this.growthTimer > 0) return;
    this.growthTimer = 50;

    if (this.villagers.length >= MAX_POPULATION) return;
    const freeBeds = this.beds - this.villagers.length;
    if (freeBeds <= 0) return;
    if (this.resources.food < this.villagers.length * 7 + 15) return;

    // A child, if two villagers are close enough.
    const pair = this.findClosePair();
    if (pair && this.rng.chance(0.55)) {
      const [a, b] = pair;
      const home = this.homeOf(a) ?? this.homeOf(b);
      const spot = home
        ? this.structures.accessPoint(home)
        : this.spawnPointNear(a.x, a.z, 3);
      const familyName = a.name.split(' ')[1] ?? b.name.split(' ')[1] ?? 'Wilder';
      const taken = new Set(this.villagers.map((v) => v.name));
      const child = this.addVillager(spot.x, spot.z, childName(this.rng, familyName, taken));
      child.energy = 90;
      a.addFriendship(b.id, 12);
      b.addFriendship(a.id, 12);
      this.stats.villagersBorn++;
      this.log(`${a.name.split(' ')[0]} and ${b.name.split(' ')[0]} welcomed ${child.name}.`, 'good');
      this.checkMilestones();
      return;
    }

    // Otherwise a newcomer might wander in, if the haven looks inviting.
    const inviting = this.charm > 12 && this.averageMood > 55;
    if (inviting && this.rng.chance(0.45)) {
      const spot = this.shorelineArrival();
      const newcomer = this.addVillager(spot.x, spot.z);
      this.stats.villagersArrived++;
      this.log(`${newcomer.name} arrived, took one look around, and stayed.`, 'good');
      this.checkMilestones();
    }
  }

  private findClosePair(): [Villager, Villager] | undefined {
    for (const a of this.villagers) {
      const friend = a.bestFriend();
      if (!friend || friend.value < 55) continue;
      const b = this.villagerById(friend.id);
      if (!b) continue;
      if (b.friendshipWith(a.id) < 45) continue;
      return [a, b];
    }
    return undefined;
  }

  /** A walkable cell near the coast, so newcomers appear to arrive by boat. */
  private shorelineArrival(): { x: number; z: number } {
    let best = { x: this.origin.x, z: this.origin.z };
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < 120; attempt++) {
      const x = this.rng.int(2, WORLD_SIZE - 3);
      const z = this.rng.int(2, WORLD_SIZE - 3);
      if (!this.nav.isWalkable(x, z)) continue;
      const h = this.terrain.heightAt(x, z);
      if (h > WATER_LEVEL + 2) continue;
      const score = -Math.hypot(x - this.origin.x, z - this.origin.z);
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    return best;
  }

  private updateRegrowth(dt: number): void {
    this.regrowthTimer -= dt;
    if (this.regrowthTimer > 0) return;
    this.regrowthTimer = 30;
    // Keep the island wooded enough that a long idle session never strips it
    // bare - a haven surrounded by stumps is not what anyone signed up for.
    if (this.props.countOf('wood') < 160 && this.rng.chance(0.85)) {
      const planted = this.props.tryPlantTree(this.rng);
      if (planted) this.events.emit('propsChanged', undefined);
    }
  }

  /**
   * A full storehouse is the one state where villagers visibly stop working,
   * so it is worth saying out loud rather than leaving the player to wonder
   * why everyone has wandered off.
   */
  private checkStorage(dt: number): void {
    this.fullStoreCooldown = Math.max(0, this.fullStoreCooldown - dt);
    if (this.fullStoreCooldown > 0) return;
    if (this.totalStored < this.capacity * 0.96) return;
    this.fullStoreCooldown = 240;
    this.log('The storehouse is full. Time to mark out something worth building.', 'warn');
  }

  private updateLogs(dt: number): void {
    for (const entry of this.logs) entry.age += dt;
    if (this.logs.length > 60) this.logs.splice(0, this.logs.length - 60);
  }

  private onNewDay(snapshot: ClockSnapshot): void {
    if (snapshot.day % 7 === 1 && snapshot.day > 1) {
      this.log(`${seasonGreeting(snapshot.season)}`, 'milestone');
    }
    this.checkMilestones();
  }

  private checkMilestones(): void {
    const pop = this.villagers.length;
    const thresholds: [string, number, string][] = [
      ['pop5', 5, 'Five villagers. Somebody has started calling it a village.'],
      ['pop10', 10, 'Ten villagers. There are paths worn into the grass now.'],
      ['pop20', 20, 'Twenty villagers. The hearth is never cold.'],
      ['pop35', 35, 'Thirty-five villagers. You made a proper haven of it.'],
    ];
    for (const [key, count, message] of thresholds) {
      if (pop >= count && !this.milestonesHit.has(key)) {
        this.milestonesHit.add(key);
        this.log(message, 'milestone');
        this.events.emit('milestone', { title: `${count} villagers`, body: message });
      }
    }
  }

  /* ------------------------------------------------------- ColonyView API */

  depotFor(x: number, z: number): { x: number; z: number } {
    let best = this.origin;
    let bestDist = (this.origin.x - x) ** 2 + (this.origin.z - z) ** 2;
    for (const barn of this.structures.completedOfType('barn')) {
      const spot = this.structures.accessPoint(barn);
      const d = (spot.x - x) ** 2 + (spot.z - z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = spot;
      }
    }
    return best;
  }

  store(resource: ResourceKind, amount: number): number {
    const room = Math.max(0, this.capacity - this.totalStored);
    const stored = Math.min(amount, room);
    this.resources[resource] = (this.resources[resource] || 0) + stored;
    this.stats.resourcesGathered += stored;
    return stored;
  }

  take(resource: ResourceKind, amount: number): number {
    const held = this.resources[resource] || 0;
    const taken = Math.min(amount, held);
    this.resources[resource] = held - taken;
    return taken;
  }

  homeOf(villager: Villager): Structure | undefined {
    if (villager.homeId === 0) return undefined;
    const home = this.structures.byId(villager.homeId);
    if (!home || home.state !== 'complete') {
      villager.homeId = 0;
      return undefined;
    }
    return home;
  }

  log(message: string, tone: LogTone = 'neutral'): void {
    const entry: LogEntry = { id: this.nextLogId++, message, tone, day: this.clock.day, age: 0 };
    this.logs.push(entry);
    this.events.emit('log', entry);
  }

  onStructureComplete(structure: Structure, builder: Villager): void {
    const def = BLUEPRINT_BY_ID.get(structure.defId);
    this.stats.structuresBuilt++;
    this.nav.rebuild();
    this.assignHomes();
    this.recomputeDerived();
    this.events.emit('structureComplete', structure);
    if (def) {
      this.log(`${builder.name.split(' ')[0]} finished the ${def.name}.`, 'good');
      if (!this.milestonesHit.has(`first:${def.id}`)) {
        this.milestonesHit.add(`first:${def.id}`);
        this.events.emit('milestone', { title: `First ${def.name}`, body: def.blurb });
      }
    }
  }

  /** Gives every homeless villager a bed, if one is free. */
  assignHomes(): void {
    const homes = this.structures.completed.filter((s) => (BLUEPRINT_BY_ID.get(s.defId)?.beds ?? 0) > 0);
    for (const home of homes) {
      home.residents = home.residents.filter((id) => this.villagerById(id));
    }
    for (const villager of this.villagers) {
      if (this.homeOf(villager)) continue;
      villager.homeId = 0;
      for (const home of homes) {
        const beds = BLUEPRINT_BY_ID.get(home.defId)?.beds ?? 0;
        if (home.residents.length >= beds) continue;
        home.residents.push(villager.id);
        villager.homeId = home.id;
        break;
      }
    }
  }

  /* ------------------------------------------------------- player actions */

  canAfford(def: BlueprintDef): boolean {
    for (const [resource, amount] of Object.entries(def.cost) as [ResourceKind, number][]) {
      if (this.resources[resource] < amount) return false;
    }
    return true;
  }

  /**
   * Places a blueprint. Materials are not deducted here - villagers haul them
   * from the stockpile, which is the whole point of watching them work.
   */
  placeBlueprint(def: BlueprintDef, x: number, z: number): Structure | null {
    const check = this.structures.canPlace(def, x, z);
    if (!check.ok) return null;
    const structure = this.structures.place(def, x, z);
    this.nav.rebuild();
    this.events.emit('structurePlaced', structure);
    this.log(`You marked out a ${def.name}.`, 'neutral');
    return structure;
  }

  cancelBlueprint(structure: Structure): void {
    const def = BLUEPRINT_BY_ID.get(structure.defId);
    const refund = this.structures.cancel(structure);
    for (const [resource, amount] of Object.entries(refund) as [ResourceKind, number][]) {
      if (amount > 0) this.store(resource, amount);
    }
    for (const villager of this.villagers) {
      if (villager.task?.structureId === structure.id) villager.clearTask();
    }
    this.nav.rebuild();
    if (def) this.log(`The ${def.name} plan was set aside.`, 'neutral');
  }

  orderTo(villager: Villager, x: number, z: number): boolean {
    const ctx = this.makeLightContext();
    return orderVillagerTo(villager, ctx, x, z);
  }

  castMiracle(miracle: Miracle, target?: Villager): boolean {
    if (this.favor < miracle.cost) return false;

    switch (miracle.id) {
      case 'meal': {
        if (!target) return false;
        target.hunger = 0;
        target.energy = clamp(target.energy + 30, 0, 100);
        target.joy += 16;
        target.boost = 55;
        target.say('meal', 4);
        this.log(`You set a warm meal in front of ${target.name.split(' ')[0]}.`, 'good');
        break;
      }
      case 'rally': {
        for (const villager of this.villagers) {
          villager.boost = Math.max(villager.boost, 75);
          villager.joy += 6;
          villager.say('spark', 3);
        }
        this.log('A good feeling goes round the haven. Everyone picks up the pace.', 'good');
        break;
      }
      case 'bloom': {
        for (const farm of this.structures.completedOfType('farm')) farm.crop = 1;
        for (let i = 0; i < 6; i++) this.props.tryPlantTree(this.rng);
        for (const prop of this.props.props) {
          if (prop.kind === 'bush' && prop.yield <= 0) {
            prop.yield = 3;
            prop.regrowIn = -1;
          }
        }
        this.events.emit('propsChanged', undefined);
        this.log('Everything green leans towards the light at once.', 'good');
        break;
      }
      case 'lullaby': {
        for (const villager of this.villagers) {
          villager.energy = 100;
          villager.joy += 10;
          villager.say('note', 4);
        }
        this.log('You hum something old. The whole haven sleeps well tonight.', 'good');
        break;
      }
    }

    this.favor -= miracle.cost;
    return true;
  }

  /** Context object for one-off calls outside the main update loop. */
  private makeLightContext(): SimContext {
    return {
      terrain: this.terrain,
      nav: this.nav,
      props: this.props,
      structures: this.structures,
      colony: this,
      clock: this.clock.snapshot(),
      rng: this.rng,
      dt: 0,
      fastForward: false,
      budget: { paths: 4 },
    };
  }

  /** Fast-forwards the simulation in coarse steps for offline progress. */
  catchUp(seconds: number): { elapsed: number; before: Record<ResourceKind, number>; beforePop: number } {
    const before = { ...this.resources };
    const beforePop = this.villagers.length;
    // Eight hours is the most we will replay. Beyond that the stockpile has
    // long since filled anyway, so there is nothing further to earn.
    const capped = Math.min(seconds, 60 * 60 * 8);
    const step = 1;
    let remaining = capped;
    while (remaining > 0) {
      const dt = Math.min(step, remaining);
      this.update(dt, true);
      remaining -= dt;
    }
    return { elapsed: capped, before, beforePop };
  }
}

function seasonGreeting(season: string): string {
  switch (season) {
    case 'spring':
      return 'Spring. The island smells like rain on warm stone.';
    case 'summer':
      return 'Summer. Long light, slow afternoons.';
    case 'autumn':
      return 'Autumn. The woods have gone gold overnight.';
    default:
      return 'Winter. Quiet, and the smoke goes straight up.';
  }
}
