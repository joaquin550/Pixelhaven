/**
 * Saving, loading, and "while you were away".
 *
 * The island itself is reproducible from its seed, so a save is the seed plus
 * everything that happened afterwards: the terrain edits, the props villagers
 * felled or planted, the buildings, and the people. It all fits comfortably in
 * localStorage, which keeps the game working offline and with no account.
 */
import { Haven } from '../sim/haven';
import { Villager, createVillager } from '../sim/villager';
import { Structure } from '../build/structures';
import { PropKind } from '../world/props';
import { ResourceKind } from '../build/blueprints';
import { formatDuration } from '../core/mathx';
import { Rng } from '../core/rng';

export const SAVE_KEY = 'pixel-haven:save:v1';
export const SETTINGS_KEY = 'pixel-haven:settings:v1';
const SAVE_VERSION = 1;

export interface SavedVillager {
  id: number;
  name: string;
  traits: string[];
  look: [number, number, number, number, number, number];
  x: number;
  z: number;
  y: number;
  facing: number;
  energy: number;
  hunger: number;
  lonely: number;
  mood: number;
  age: number;
  homeId: number;
  friends: [number, number][];
  stats: [number, number, number, number, number];
  /** Skills in JOBS order: forestry, masonry, farming, building, foraging. */
  skills: [number, number, number, number, number];
  carry?: [ResourceKind, number];
}

export interface SavedStructure {
  id: number;
  defId: string;
  x: number;
  z: number;
  y: number;
  state: Structure['state'];
  /** Wood, stone, food, tools. Tools were added later, so it may be absent. */
  delivered: [number, number, number, number?];
  progress: number;
  crop: number;
  residents: number[];
}

export interface SavedProp {
  id: number;
  kind: PropKind;
  x: number;
  z: number;
  rot: number;
  scale: number;
  variant: number;
  yield: number;
  regrow: number;
}

export interface SaveData {
  version: number;
  seed: string;
  savedAt: number;
  elapsed: number;
  resources: Record<ResourceKind, number>;
  favor: number;
  stats: Haven['stats'];
  milestones: string[];
  nextVillagerId: number;
  nextLogId: number;
  heights: string;
  types: string;
  villagers: SavedVillager[];
  structures: SavedStructure[];
  props: SavedProp[];
  logs: { message: string; tone: string; day: number }[];
}

export interface Settings {
  muted: boolean;
  master: number;
  music: number;
  ambience: number;
  sfx: number;
  shadows: boolean;
  weather: boolean;
  speed: number;
  showBubbles: boolean;
  hasPlayed: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  muted: false,
  master: 0.8,
  music: 0.62,
  ambience: 0.75,
  sfx: 0.85,
  shadows: true,
  weather: true,
  speed: 1,
  showBubbles: true,
  hasPlayed: false,
};

/* ------------------------------------------------------------ serialise */

export function serializeHaven(haven: Haven): SaveData {
  return {
    version: SAVE_VERSION,
    seed: haven.seed,
    savedAt: Date.now(),
    elapsed: haven.clock.elapsed,
    resources: { ...haven.resources },
    favor: haven.favor,
    stats: { ...haven.stats },
    milestones: Array.from(haven.milestonesHit),
    nextVillagerId: haven.nextVillagerId,
    nextLogId: haven.nextLogId,
    heights: encodeBuffer(haven.terrain.heights),
    types: encodeBuffer(haven.terrain.types),
    villagers: haven.villagers.map(serializeVillager),
    structures: haven.structures.structures.map((s) => ({
      id: s.id,
      defId: s.defId,
      x: s.x,
      z: s.z,
      y: s.y,
      state: s.state,
      delivered: [s.delivered.wood, s.delivered.stone, s.delivered.food, s.delivered.tools],
      progress: round(s.progress, 2),
      crop: round(s.crop, 3),
      residents: [...s.residents],
    })),
    props: haven.props.props.map((p) => ({
      id: p.id,
      kind: p.kind,
      x: round(p.x, 2),
      z: round(p.z, 2),
      rot: round(p.rotation, 3),
      scale: round(p.scale, 3),
      variant: p.variant,
      yield: p.yield,
      regrow: round(p.regrowIn, 1),
    })),
    logs: haven.logs.slice(-24).map((l) => ({ message: l.message, tone: l.tone, day: l.day })),
  };
}

function serializeVillager(v: Villager): SavedVillager {
  return {
    id: v.id,
    name: v.name,
    traits: v.traits,
    look: [v.look.skin, v.look.hair, v.look.hairStyle, v.look.shirt, v.look.trousers, v.look.hat],
    x: round(v.x, 2),
    z: round(v.z, 2),
    y: round(v.y, 2),
    facing: round(v.facing, 3),
    energy: round(v.energy, 1),
    hunger: round(v.hunger, 1),
    lonely: round(v.lonely, 1),
    mood: round(v.mood, 1),
    age: round(v.age, 2),
    homeId: v.homeId,
    friends: Array.from(v.friendships.entries()).map(([id, value]) => [id, Math.round(value)]),
    stats: [v.stats.gathered, Math.round(v.stats.built), v.stats.chats, v.stats.mealsEaten, v.stats.stepsTaken],
    skills: [
      round(v.skills.forestry, 1),
      round(v.skills.masonry, 1),
      round(v.skills.farming, 1),
      round(v.skills.building, 1),
      round(v.skills.foraging, 1),
    ],
    ...(v.carry ? { carry: [v.carry.resource, v.carry.amount] as [ResourceKind, number] } : {}),
  };
}

/* ------------------------------------------------------------ deserialise */

export function deserializeHaven(data: SaveData): Haven {
  const haven = new Haven(data.seed, { blank: true });

  // Terrain first: everything else is positioned relative to it.
  const heights = decodeInt16(data.heights);
  const types = decodeUint8(data.types);
  if (heights.length === haven.terrain.heights.length) haven.terrain.heights.set(heights);
  if (types.length === haven.terrain.types.length) haven.terrain.types.set(types);
  haven.terrain.occupancy.fill(0);

  const rng = new Rng(`${data.seed}:restore`);
  for (const saved of data.props) {
    const prop = haven.props.add(saved.kind, saved.x, saved.z, rng);
    prop.id = saved.id;
    prop.rotation = saved.rot;
    prop.scale = saved.scale;
    prop.variant = saved.variant;
    prop.yield = saved.yield;
    prop.regrowIn = saved.regrow;
    prop.y = haven.terrain.heightAt(prop.cx, prop.cz);
  }

  for (const saved of data.structures) {
    const structure: Structure = {
      id: saved.id,
      defId: saved.defId,
      x: saved.x,
      z: saved.z,
      y: saved.y,
      width: 1,
      depth: 1,
      state: saved.state,
      delivered: {
        wood: saved.delivered[0],
        stone: saved.delivered[1],
        food: saved.delivered[2],
        tools: saved.delivered[3] ?? 0,
      },
      progress: saved.progress,
      work: 1,
      crop: saved.crop,
      claimedBy: 0,
      residents: [...saved.residents],
      age: 100,
    };
    haven.structures.restore(structure);
  }

  for (const saved of data.villagers) {
    const villager = createVillager(
      saved.id,
      saved.name,
      rng,
      saved.x,
      saved.z,
      saved.y,
      saved.traits,
    );
    villager.look = {
      skin: saved.look[0],
      hair: saved.look[1],
      hairStyle: saved.look[2],
      shirt: saved.look[3],
      trousers: saved.look[4],
      hat: saved.look[5],
    };
    villager.facing = saved.facing;
    villager.energy = saved.energy;
    villager.hunger = saved.hunger;
    villager.lonely = saved.lonely;
    villager.mood = saved.mood;
    villager.age = saved.age;
    villager.homeId = saved.homeId;
    villager.friendships = new Map(saved.friends);
    villager.stats = {
      gathered: saved.stats[0],
      built: saved.stats[1],
      chats: saved.stats[2],
      mealsEaten: saved.stats[3],
      stepsTaken: saved.stats[4],
    };
    // `skills` postdates the first saves, so an older file just starts everyone
    // back at the beginning rather than failing to load.
    if (saved.skills) {
      villager.skills = {
        forestry: saved.skills[0] ?? 0,
        masonry: saved.skills[1] ?? 0,
        farming: saved.skills[2] ?? 0,
        building: saved.skills[3] ?? 0,
        foraging: saved.skills[4] ?? 0,
      };
    }
    if (saved.carry) villager.carry = { resource: saved.carry[0], amount: saved.carry[1] };
    haven.villagers.push(villager);
  }

  haven.clock.elapsed = data.elapsed;
  // An older save has no tools line; start that shelf empty rather than NaN.
  haven.resources = { ...data.resources, tools: data.resources.tools ?? 0 };
  haven.favor = data.favor;
  haven.stats = { ...data.stats };
  haven.milestonesHit = new Set(data.milestones);
  haven.nextVillagerId = Math.max(data.nextVillagerId, ...data.villagers.map((v) => v.id + 1), 1);
  haven.nextLogId = data.nextLogId;

  haven.nav.rebuild();
  haven.assignHomes();
  for (const entry of data.logs) {
    haven.logs.push({
      id: haven.nextLogId++,
      message: entry.message,
      tone: entry.tone as 'neutral',
      day: entry.day,
      age: 0,
    });
  }
  return haven;
}

/* ------------------------------------------------------------- storage */

export function saveToStorage(haven: Haven): boolean {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(serializeHaven(haven)));
    return true;
  } catch (error) {
    console.warn('Pixel Haven could not save', error);
    return false;
  }
}

export function loadFromStorage(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    if (data.version !== SAVE_VERSION) return null;
    if (!data.seed || !Array.isArray(data.villagers)) return null;
    return data;
  } catch (error) {
    console.warn('Pixel Haven could not read the save', error);
    return null;
  }
}

export function hasSave(): boolean {
  try {
    return localStorage.getItem(SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* Private browsing; nothing to clear. */
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* Ignore: settings are a convenience, not state worth failing over. */
  }
}

/* ---------------------------------------------------------- away report */

export interface AwayReport {
  /** Real seconds the player was gone. */
  away: number;
  /** In-game seconds actually simulated. */
  simulated: number;
  gained: Record<ResourceKind, number>;
  newVillagers: number;
  structuresFinished: number;
  summary: string;
}

/** Runs catch-up and describes what changed, for the welcome-back card. */
export function applyOfflineProgress(haven: Haven, savedAt: number): AwayReport | null {
  const awaySeconds = Math.max(0, (Date.now() - savedAt) / 1000);
  if (awaySeconds < 90) return null;

  const beforeStructures = haven.stats.structuresBuilt;
  const result = haven.catchUp(awaySeconds);

  const gained: Record<ResourceKind, number> = {
    wood: Math.max(0, Math.round(haven.resources.wood - result.before.wood)),
    stone: Math.max(0, Math.round(haven.resources.stone - result.before.stone)),
    food: Math.max(0, Math.round(haven.resources.food - result.before.food)),
    tools: Math.max(0, Math.round(haven.resources.tools - result.before.tools)),
  };
  const newVillagers = haven.villagers.length - result.beforePop;
  const structuresFinished = haven.stats.structuresBuilt - beforeStructures;

  return {
    away: awaySeconds,
    simulated: result.elapsed,
    gained,
    newVillagers,
    structuresFinished,
    summary: describeAway(awaySeconds, gained, newVillagers, structuresFinished),
  };
}

function describeAway(
  away: number,
  gained: Record<ResourceKind, number>,
  newVillagers: number,
  structures: number,
): string {
  const parts: string[] = [];
  if (gained.wood) parts.push(`${gained.wood} wood`);
  if (gained.stone) parts.push(`${gained.stone} stone`);
  if (gained.food) parts.push(`${gained.food} food`);
  if (gained.tools) parts.push(`${gained.tools} tools`);
  if (structures) parts.push(`${structures} building${structures > 1 ? 's' : ''} finished`);
  if (newVillagers > 0) parts.push(`${newVillagers} new face${newVillagers > 1 ? 's' : ''}`);

  const time = formatDuration(away);
  if (parts.length === 0) return `You were away ${time}. The haven got on quietly without you.`;
  return `You were away ${time}. They brought in ${joinList(parts)}.`;
}

function joinList(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/* ------------------------------------------------------------- encoding */

function round(value: number, places: number): number {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

function encodeBuffer(array: Int16Array | Uint8Array): string {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeInt16(encoded: string): Int16Array {
  const bytes = decodeBytes(encoded);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

function decodeUint8(encoded: string): Uint8Array {
  return decodeBytes(encoded);
}

