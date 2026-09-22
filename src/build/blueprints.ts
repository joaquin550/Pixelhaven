/**
 * Everything the player can ask for.
 *
 * You never build directly - you place a blueprint, and villagers haul the
 * materials and raise it themselves. That is the whole player fantasy of Pixel
 * Haven: you suggest, they decide when.
 */

/**
 * Wood, stone and food are gathered. Tools are made: the Workshop turns raw
 * materials into them, the better buildings need them, and a well-stocked
 * toolshed makes everybody quicker at everything.
 */
export type ResourceKind = 'wood' | 'stone' | 'food' | 'tools';

export type BlueprintCategory = 'home' | 'food' | 'craft' | 'comfort' | 'paths';

export type PlacementRule =
  /** Flat, dry, unoccupied ground. */
  | 'land'
  /** Entirely over water. */
  | 'water'
  /** Touching both land and water. */
  | 'shore';

export interface BlueprintDef {
  id: string;
  name: string;
  blurb: string;
  category: BlueprintCategory;
  /** Footprint in cells. */
  width: number;
  depth: number;
  cost: Partial<Record<ResourceKind, number>>;
  /** Total build-work seconds at 1x worker speed. */
  work: number;
  placement: PlacementRule;
  /** Sleeping spots provided. */
  beds?: number;
  /** Extra stockpile capacity. */
  storage?: number;
  /** Villagers can walk over the finished tiles (paths, bridges, farm rows). */
  walkable?: boolean;
  /** Flat happiness contribution to the whole haven. */
  charm?: number;
  /** Extra Favor per in-game minute. */
  favor?: number;
  /** Glyph used on the build bar button. */
  glyph: string;
  /** Unlocks once the haven reaches this population. */
  requiresPopulation?: number;
}

export const BLUEPRINTS: BlueprintDef[] = [
  {
    id: 'cottage',
    name: 'Cottage',
    blurb: 'A roof, a hearthstone, two beds. The start of everything.',
    category: 'home',
    width: 3,
    depth: 3,
    cost: { wood: 22, stone: 4 },
    work: 34,
    placement: 'land',
    beds: 2,
    charm: 3,
    glyph: 'home',
  },
  {
    id: 'longhouse',
    name: 'Longhouse',
    blurb: 'Five beds and a long table for arguing over dinner.',
    category: 'home',
    width: 4,
    depth: 4,
    cost: { wood: 48, stone: 20, tools: 4 },
    work: 72,
    placement: 'land',
    beds: 5,
    charm: 6,
    glyph: 'lodge',
    requiresPopulation: 5,
  },
  {
    id: 'farm',
    name: 'Farm Plot',
    blurb: 'Tilled rows. Someone will get around to the weeding.',
    category: 'food',
    width: 3,
    depth: 3,
    cost: { wood: 10 },
    work: 20,
    placement: 'land',
    walkable: true,
    glyph: 'crop',
  },
  {
    id: 'dock',
    name: 'Fishing Dock',
    blurb: 'Boards over the shallows and a bucket of patience.',
    category: 'food',
    width: 2,
    depth: 3,
    cost: { wood: 20 },
    work: 26,
    placement: 'shore',
    walkable: true,
    charm: 2,
    glyph: 'dock',
  },
  {
    id: 'hearth',
    name: 'Great Hearth',
    blurb: 'Where the day gets talked about. Villagers gather here at dusk.',
    category: 'comfort',
    width: 2,
    depth: 2,
    cost: { wood: 12, stone: 14 },
    work: 24,
    placement: 'land',
    charm: 10,
    favor: 0.4,
    glyph: 'fire',
  },
  {
    id: 'well',
    name: 'Stone Well',
    blurb: 'Cold water and a place to lean while you drink it.',
    category: 'comfort',
    width: 2,
    depth: 2,
    cost: { stone: 24 },
    work: 30,
    placement: 'land',
    charm: 7,
    glyph: 'well',
  },
  {
    id: 'barn',
    name: 'Storehouse',
    blurb: 'Dry, dark, and full of next winter.',
    category: 'craft',
    width: 3,
    depth: 3,
    cost: { wood: 36, stone: 10 },
    work: 44,
    placement: 'land',
    storage: 220,
    glyph: 'barn',
  },
  {
    id: 'workshop',
    name: 'Workshop',
    blurb: 'Where tools get made. Everything else gets easier once it stands.',
    category: 'craft',
    width: 3,
    depth: 3,
    cost: { wood: 40, stone: 26 },
    work: 62,
    placement: 'land',
    charm: 4,
    glyph: 'tools',
    requiresPopulation: 4,
  },
  {
    id: 'shrine',
    name: 'Quiet Shrine',
    blurb: 'They leave small offerings. You feel it as Favor.',
    category: 'comfort',
    width: 2,
    depth: 2,
    cost: { stone: 40, wood: 8, tools: 5 },
    work: 54,
    placement: 'land',
    charm: 8,
    favor: 1.6,
    glyph: 'shrine',
    requiresPopulation: 6,
  },
  {
    id: 'bridge',
    name: 'Bridge',
    blurb: 'One span of planks. Place a row to cross the river.',
    category: 'paths',
    width: 1,
    depth: 1,
    cost: { wood: 5 },
    work: 5,
    placement: 'water',
    walkable: true,
    glyph: 'bridge',
  },
  {
    id: 'path',
    name: 'Cobble Path',
    blurb: 'Villagers walk a little quicker, and a little happier.',
    category: 'paths',
    width: 1,
    depth: 1,
    cost: { stone: 2 },
    work: 2,
    placement: 'land',
    walkable: true,
    charm: 0.3,
    glyph: 'path',
  },
  {
    id: 'lantern',
    name: 'Lantern Post',
    blurb: 'A warm circle in the dark. Purely so it looks nice.',
    category: 'comfort',
    width: 1,
    depth: 1,
    cost: { wood: 3, stone: 2 },
    work: 5,
    placement: 'land',
    charm: 2,
    glyph: 'lamp',
  },
];

export const BLUEPRINT_BY_ID = new Map(BLUEPRINTS.map((b) => [b.id, b]));

export function blueprintCostText(def: BlueprintDef): string {
  const parts: string[] = [];
  if (def.cost.wood) parts.push(`${def.cost.wood} wood`);
  if (def.cost.stone) parts.push(`${def.cost.stone} stone`);
  if (def.cost.food) parts.push(`${def.cost.food} food`);
  if (def.cost.tools) parts.push(`${def.cost.tools} tools`);
  return parts.join(' · ') || 'free';
}
