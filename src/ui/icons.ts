/**
 * Pixel icons, drawn as SVG.
 *
 * Each icon is an 8x8 grid of characters mapped to colours, rendered as merged
 * horizontal runs of <rect>. That keeps them razor sharp at any size on a
 * Retina display, matches the sprite work, and costs nothing to ship.
 */

interface IconDef {
  palette: Record<string, string>;
  rows: string[];
}

const T = '.'; // transparent

const ICONS: Record<string, IconDef> = {
  wood: {
    palette: { a: '#a87b4d', b: '#7d5a36', c: '#c79a68' },
    rows: [
      '........',
      '..cccb..',
      '.caaabb.',
      '.caaabb.',
      '.caaabb.',
      '.caaabb.',
      '..bbbb..',
      '........',
    ],
  },
  stone: {
    palette: { a: '#9a9791', b: '#77746f', c: '#b9b6b0' },
    rows: [
      '........',
      '..ccc...',
      '.caaab..',
      'caaaabb.',
      'caaabbb.',
      '.caabbb.',
      '..bbbb..',
      '........',
    ],
  },
  food: {
    palette: { a: '#c0563a', b: '#8f3f2c', c: '#5a8f4a' },
    rows: [
      '...c....',
      '..cc....',
      '.aaaaa..',
      'aaaaaaa.',
      'aaaaaaa.',
      'aaabbbb.',
      '.abbbb..',
      '..bbb...',
    ],
  },
  favor: {
    palette: { a: '#f0cc6b', b: '#d8a23c', c: '#fff0bd' },
    rows: [
      '...c....',
      '..cac...',
      '.caaac..',
      'caaaaaac',
      '.caaac..',
      '..cabc..',
      '.c.b.c..',
      '........',
    ],
  },
  home: {
    palette: { a: '#c39a55', b: '#e3d5b8', c: '#6d4a2c', d: '#f6d98a' },
    rows: [
      '...aa...',
      '..aaaa..',
      '.aaaaaa.',
      'aaaaaaaa',
      '.bbbbbb.',
      '.bdbbdb.',
      '.bbccbb.',
      '.bbccbb.',
    ],
  },
  lodge: {
    palette: { a: '#a2513c', b: '#e3d5b8', c: '#6d4a2c', d: '#f6d98a' },
    rows: [
      '..aaaa..',
      '.aaaaaa.',
      'aaaaaaaa',
      'bbbbbbbb',
      'bdbbbdbb',
      'bbbbbbbb',
      'bbccbbbb',
      'bbccbbbb',
    ],
  },
  crop: {
    palette: { a: '#8fbc4a', b: '#d8c14e', c: '#5f4530' },
    rows: [
      '........',
      '.b.b.b..',
      'aba bab.',
      '.a.a.a..',
      '.a.a.a..',
      'cccccccc',
      'cccccccc',
      '........',
    ],
  },
  dock: {
    palette: { a: '#a87b4d', b: '#6d4a2c', c: '#5aa9c4' },
    rows: [
      '........',
      'aaaaaaaa',
      'bbbbbbbb',
      '.b....b.',
      '.b....b.',
      'cccccccc',
      'cccccccc',
      '........',
    ],
  },
  fire: {
    palette: { a: '#ff9a3c', b: '#ffd27a', c: '#9a9791' },
    rows: [
      '...a....',
      '..aba...',
      '.aabaa..',
      '.abbba..',
      'aabbbaa.',
      'aaabaaa.',
      'cccccccc',
      '........',
    ],
  },
  well: {
    palette: { a: '#9a9791', b: '#a87b4d', c: '#2d4a58' },
    rows: [
      '.bbbbbb.',
      'bbbbbbbb',
      '...bb...',
      '...bb...',
      'aaaaaaaa',
      'acccccca',
      'acccccca',
      'aaaaaaaa',
    ],
  },
  barn: {
    palette: { a: '#a2513c', b: '#8a5f39', c: '#6d4a2c' },
    rows: [
      '..aaaa..',
      '.aaaaaa.',
      'aaaaaaaa',
      'bbbbbbbb',
      'bbbbbbbb',
      'bbccccbb',
      'bbccccbb',
      'bbccccbb',
    ],
  },
  tools: {
    palette: { a: '#b9bec6', b: '#6d4a2c', c: '#8d939c' },
    rows: [
      '.aa.....',
      'aaaa..a.',
      'aaaa.aa.',
      '.bb.aca.',
      '.bb.ac..',
      '.bb.c...',
      '.bb.c...',
      '........',
    ],
  },
  shrine: {
    palette: { a: '#9a9791', b: '#77746f', c: '#bfe4ff' },
    rows: [
      '...c....',
      '..ccc...',
      '.a.a.a..',
      '.a.a.a..',
      '.aaaaa..',
      'bbbbbbb.',
      'bbbbbbb.',
      '........',
    ],
  },
  bridge: {
    palette: { a: '#a87b4d', b: '#6d4a2c', c: '#5aa9c4' },
    rows: [
      '........',
      'b......b',
      'baaaaaab',
      'bbbbbbbb',
      'ccccccc.',
      'cccccccc',
      'ccccccc.',
      '........',
    ],
  },
  path: {
    palette: { a: '#9a9791', b: '#77746f' },
    rows: [
      '........',
      '.aa.bb..',
      '.aa.bb..',
      '........',
      '.bb.aa..',
      '.bb.aa..',
      '........',
      '........',
    ],
  },
  lamp: {
    palette: { a: '#ffcf7a', b: '#6d4a2c', c: '#fff0bd' },
    rows: [
      '..bbbb..',
      '.baaaab.',
      '.bacaab.',
      '.baaaab.',
      '..bbbb..',
      '...bb...',
      '...bb...',
      '..bbbb..',
    ],
  },
  meal: {
    palette: { a: '#d8c8a8', b: '#c9803e', c: '#e8d9b8' },
    rows: [
      '...c....',
      '..c.c...',
      '.bbbbb..',
      'bbbbbbb.',
      'aaaaaaa.',
      '.aaaaa..',
      '........',
      '........',
    ],
  },
  spark: {
    palette: { a: '#f0cc6b', b: '#fff0bd' },
    rows: [
      '...a....',
      '.a.a.a..',
      '..aba...',
      'aabbbaa.',
      '..aba...',
      '.a.a.a..',
      '...a....',
      '........',
    ],
  },
  leaf: {
    palette: { a: '#5a8f4a', b: '#6fa858', c: '#6d4a2c' },
    rows: [
      '.....bb.',
      '...bbbb.',
      '..bbbba.',
      '.baaaaa.',
      'baaaaa..',
      'caaaa...',
      'c.......',
      'c.......',
    ],
  },
  note: {
    palette: { a: '#5c6f8a', b: '#8a9cb5' },
    rows: [
      '....aaa.',
      '....aab.',
      '....a...',
      '....a...',
      '..aaa...',
      '.aaa....',
      '.aa.....',
      '........',
    ],
  },
  moon: {
    palette: { a: '#cfdcf5', b: '#8fa3c8' },
    rows: [
      '..aaa...',
      '.aab....',
      'aab.....',
      'aab.....',
      'aab.....',
      '.aab....',
      '..aaa...',
      '........',
    ],
  },
  sun: {
    palette: { a: '#ffd27a', b: '#ffb04a' },
    rows: [
      '...a....',
      'a..a..a.',
      '..bbb...',
      '.bbbbb..',
      'abbbbba.',
      '.bbbbb..',
      '..bbb...',
      '.a.a.a..',
    ],
  },
  gear: {
    palette: { a: '#cdc3b4', b: '#8a8177' },
    rows: [
      '..a..a..',
      '.aaaaaa.',
      'aabbbbaa',
      '.bb..bb.',
      '.bb..bb.',
      'aabbbbaa',
      '.aaaaaa.',
      '..a..a..',
    ],
  },
  pause: {
    palette: { a: '#f2e9db' },
    rows: [
      '.aa..aa.',
      '.aa..aa.',
      '.aa..aa.',
      '.aa..aa.',
      '.aa..aa.',
      '.aa..aa.',
      '.aa..aa.',
      '........',
    ],
  },
  play: {
    palette: { a: '#f2e9db' },
    rows: [
      '.aa.....',
      '.aaaa...',
      '.aaaaaa.',
      '.aaaaaaa',
      '.aaaaaa.',
      '.aaaa...',
      '.aa.....',
      '........',
    ],
  },
  fast: {
    palette: { a: '#f2e9db' },
    rows: [
      'aa..aa..',
      'aaa.aaa.',
      'aaaaaaaa',
      'aaaaaaaa',
      'aaaaaaaa',
      'aaa.aaa.',
      'aa..aa..',
      '........',
    ],
  },
  close: {
    palette: { a: '#f2e9db' },
    rows: [
      'aa....aa',
      'aaa..aaa',
      '.aaaaaa.',
      '..aaaa..',
      '..aaaa..',
      '.aaaaaa.',
      'aaa..aaa',
      'aa....aa',
    ],
  },
  people: {
    palette: { a: '#e8c9a0', b: '#c65c3e', c: '#3f7fa0' },
    rows: [
      '.a...a..',
      '.a...a..',
      'bbb.ccc.',
      'bbb.ccc.',
      'bbb.ccc.',
      '.b...c..',
      '.b...c..',
      '........',
    ],
  },
  hammer: {
    palette: { a: '#8d939c', b: '#6d4a2c', c: '#b9bec6' },
    rows: [
      '..cccc..',
      '.aaaaaa.',
      '.aaaaaa.',
      '...bb...',
      '...bb...',
      '...bb...',
      '...bb...',
      '........',
    ],
  },
  heart: {
    palette: { a: '#d4566a', b: '#f08a98' },
    rows: [
      '.bb..bb.',
      'baabaab.',
      'aaaaaaa.',
      'aaaaaaa.',
      '.aaaaa..',
      '..aaa...',
      '...a....',
      '........',
    ],
  },
};

/** Builds an inline SVG string for an icon, merging runs into few rects. */
export function iconSvg(name: string, size = 20): string {
  const def = ICONS[name] ?? ICONS.spark;
  const rects: string[] = [];

  for (let y = 0; y < def.rows.length; y++) {
    const row = def.rows[y];
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === T) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < row.length && row[x + run] === ch) run++;
      const colour = def.palette[ch] ?? '#ffffff';
      rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" fill="${colour}"/>`);
      x += run;
    }
  }

  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">${rects.join('')}</svg>`;
}

/** Convenience: an <span> wrapper holding the icon. */
export function icon(name: string, size = 20): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'icon-wrap';
  span.innerHTML = iconSvg(name, size);
  return span;
}

export function hasIcon(name: string): boolean {
  return name in ICONS;
}
