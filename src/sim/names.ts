/** Villager naming. Warm, slightly rustic, deliberately gender-neutral. */
import { Rng } from '../core/rng';

const FIRST = [
  'Ash', 'Bram', 'Cass', 'Dell', 'Eno', 'Fen', 'Gale', 'Haze', 'Iver', 'Juno',
  'Kip', 'Lark', 'Mos', 'Nell', 'Orin', 'Pike', 'Quill', 'Rue', 'Sage', 'Tam',
  'Umber', 'Vale', 'Wren', 'Yarrow', 'Zev', 'Briar', 'Clove', 'Dusk', 'Ember',
  'Flint', 'Grove', 'Hollis', 'Indigo', 'Juniper', 'Kestrel', 'Linden', 'Marrow',
  'North', 'Onyx', 'Piper', 'Reed', 'Slate', 'Thistle', 'Vesper', 'Willow',
];

const LAST = [
  'Barrow', 'Cobble', 'Dunmere', 'Elmroot', 'Fallow', 'Greenhollow', 'Hearth',
  'Ivyfell', 'Kettle', 'Longmoor', 'Mistgate', 'Nettle', 'Oakhand', 'Pinewick',
  'Quarry', 'Riverbend', 'Stonebrook', 'Thatcher', 'Underhill', 'Wilder',
  'Ashford', 'Brookmill', 'Coldspring', 'Deepfern', 'Fernwood',
];

export function randomName(rng: Rng, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 60; attempt++) {
    const name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    if (!taken.has(name)) return name;
  }
  return `${rng.pick(FIRST)} ${rng.pick(LAST)} ${rng.int(2, 9)}`;
}

/** Names for a child, so families read as families. */
export function childName(rng: Rng, familyName: string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 40; attempt++) {
    const name = `${rng.pick(FIRST)} ${familyName}`;
    if (!taken.has(name)) return name;
  }
  return randomName(rng, taken);
}
