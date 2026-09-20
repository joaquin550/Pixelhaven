/**
 * Villager traits.
 *
 * Traits never gate content - they only tilt the utility scores in the brain,
 * so a Lazy villager still gets everything done, just with more naps on the
 * way. Every villager gets two, and they are the main reason the diorama is
 * worth watching for more than a minute.
 */

export interface TraitModifiers {
  /** Multiplier on how fast work tasks tick down. */
  workSpeed: number;
  /** Multiplier on walking speed. */
  moveSpeed: number;
  /** Multiplier on how fast energy drains while awake. */
  energyDrain: number;
  /** Multiplier on how fast the social need builds. */
  socialDrive: number;
  /** Multiplier on how fast hunger builds. */
  appetite: number;
  /** Added to the score of resting / napping tasks. */
  restBias: number;
  /** Added to the score of work tasks. */
  workBias: number;
  /** Per-job speed multipliers. */
  farming: number;
  forestry: number;
  masonry: number;
  building: number;
  foraging: number;
  /** Units carried per trip. */
  carry: number;
  /** Baseline contribution to mood. */
  moodBase: number;
  /** Multiplier on Favor generated for the player. */
  favor: number;
}

const NEUTRAL: TraitModifiers = {
  workSpeed: 1,
  moveSpeed: 1,
  energyDrain: 1,
  socialDrive: 1,
  appetite: 1,
  restBias: 0,
  workBias: 0,
  farming: 1,
  forestry: 1,
  masonry: 1,
  building: 1,
  foraging: 1,
  carry: 1,
  moodBase: 0,
  favor: 1,
};

export interface Trait {
  id: string;
  name: string;
  blurb: string;
  /** Single glyph used in the inspector chip. */
  glyph: string;
  mods: Partial<TraitModifiers>;
}

export const TRAITS: Trait[] = [
  { id: 'lazy', name: 'Lazy', blurb: 'Finds a sunbeam and a reason.', glyph: 'z', mods: { workSpeed: 0.78, restBias: 0.35, energyDrain: 0.85 } },
  { id: 'diligent', name: 'Diligent', blurb: 'Finishes what they start.', glyph: '!', mods: { workSpeed: 1.22, workBias: 0.2, energyDrain: 1.1 } },
  { id: 'sociable', name: 'Sociable', blurb: 'Never met a stranger.', glyph: '"', mods: { socialDrive: 1.5, moodBase: 4 } },
  { id: 'solitary', name: 'Solitary', blurb: 'Happier with the trees.', glyph: '.', mods: { socialDrive: 0.45, forestry: 1.15 } },
  { id: 'greenthumb', name: 'Green Thumb', blurb: 'Things grow where they walk.', glyph: '*', mods: { farming: 1.45, foraging: 1.2 } },
  { id: 'lumberjack', name: 'Timberwise', blurb: 'Reads the grain before the axe falls.', glyph: '/', mods: { forestry: 1.5 } },
  { id: 'stonecutter', name: 'Stonecutter', blurb: 'Knows where the rock wants to split.', glyph: '#', mods: { masonry: 1.5 } },
  { id: 'carpenter', name: 'Carpenter', blurb: 'Builds it once, builds it right.', glyph: '+', mods: { building: 1.45 } },
  { id: 'nightowl', name: 'Night Owl', blurb: 'Works past the lantern hour.', glyph: 'c', mods: { energyDrain: 0.85, restBias: -0.15 } },
  { id: 'earlybird', name: 'Early Bird', blurb: 'Up before the mist lifts.', glyph: '^', mods: { workBias: 0.12, restBias: -0.1 } },
  { id: 'dreamer', name: 'Dreamer', blurb: 'Stops to watch the weather.', glyph: '~', mods: { workSpeed: 0.9, moodBase: 6, favor: 1.25 } },
  { id: 'glutton', name: 'Big Appetite', blurb: 'Second breakfast is a right.', glyph: '%', mods: { appetite: 1.45, carry: 1.2 } },
  { id: 'sturdy', name: 'Sturdy', blurb: 'Carries more than looks likely.', glyph: '=', mods: { carry: 1.6, moveSpeed: 0.92 } },
  { id: 'nimble', name: 'Nimble', blurb: 'Takes the goat path.', glyph: '>', mods: { moveSpeed: 1.3, carry: 0.85 } },
  { id: 'optimist', name: 'Sunny', blurb: 'Rain is just weather.', glyph: 'o', mods: { moodBase: 9, favor: 1.15 } },
  { id: 'grumbler', name: 'Grumbler', blurb: 'Complains, then does it anyway.', glyph: '-', mods: { moodBase: -7, workSpeed: 1.1 } },
  { id: 'tinkerer', name: 'Tinkerer', blurb: 'Improves things nobody asked about.', glyph: '&', mods: { building: 1.25, masonry: 1.15 } },
  { id: 'forager', name: 'Forager', blurb: 'Always knows where the berries are.', glyph: ',', mods: { foraging: 1.5, moveSpeed: 1.08 } },
];

export const TRAIT_BY_ID = new Map(TRAITS.map((t) => [t.id, t]));

/** Combines a villager's traits into one multiplier set. */
export function combineTraits(traitIds: readonly string[]): TraitModifiers {
  const result: TraitModifiers = { ...NEUTRAL };
  for (const id of traitIds) {
    const trait = TRAIT_BY_ID.get(id);
    if (!trait) continue;
    for (const [key, value] of Object.entries(trait.mods) as [keyof TraitModifiers, number][]) {
      if (key === 'restBias' || key === 'workBias' || key === 'moodBase') {
        result[key] += value;
      } else {
        result[key] *= value;
      }
    }
  }
  return result;
}

/** The job a villager gravitates towards, inferred from their trait mix. */
export type Vocation = 'forester' | 'mason' | 'farmer' | 'builder' | 'forager' | 'wanderer';

export const VOCATION_LABEL: Record<Vocation, string> = {
  forester: 'Forester',
  mason: 'Mason',
  farmer: 'Farmer',
  builder: 'Builder',
  forager: 'Forager',
  wanderer: 'Wanderer',
};

export function inferVocation(mods: TraitModifiers): Vocation {
  const scores: [Vocation, number][] = [
    ['forester', mods.forestry],
    ['mason', mods.masonry],
    ['farmer', mods.farming],
    ['builder', mods.building],
    ['forager', mods.foraging],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 1.05 ? scores[0][0] : 'wanderer';
}
