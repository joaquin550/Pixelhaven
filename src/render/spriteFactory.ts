/**
 * Pixel-art villagers, drawn at runtime.
 *
 * Every villager gets their own small atlas painted onto a canvas: four facing
 * directions by six poses. Generating the art in code rather than shipping
 * sprite sheets means an unlimited cast, no download, and skin/hair/clothing
 * that can be rolled per villager and saved as six small integers.
 */
import { CanvasTexture, LinearMipmapLinearFilter, NearestFilter, SRGBColorSpace, Texture } from 'three';
import type { VillagerLook } from '../sim/villager';

export const CELL_W = 24;
export const CELL_H = 32;
export const COLS = 6;
export const ROWS = 4;

/** Pose column order in the atlas. */
export const POSE = {
  stand: 0,
  walkA: 1,
  walkB: 2,
  work: 3,
  sit: 4,
  sleep: 5,
} as const;
export type PoseName = keyof typeof POSE;

/**
 * Facing row order. `west` is drawn in profile looking towards screen-left;
 * `east` is the same art mirrored.
 */
export const FACING = { south: 0, west: 1, north: 2, east: 3 } as const;

const SKIN = ['#f2cda6', '#e3ac7d', '#c98a4b', '#9c6334', '#6d4526', '#f8dcc0'];
const SKIN_SHADE = ['#d9ac83', '#c78c5f', '#a86c34', '#7d4c24', '#523219', '#dcbb9c'];
const HAIR = ['#2b1d12', '#4a2f1a', '#7d4a22', '#b06a2c', '#dcb96f', '#8f8f93', '#3d2f4c', '#a8402c'];
const SHIRT = [
  '#c65c3e', '#3f7fa0', '#5a8f4a', '#8a5ca0', '#c9a13e',
  '#4a5a7a', '#a04a5a', '#3f8f7a', '#b86b3a', '#6a6a8a',
];
const TROUSERS = ['#3c4352', '#5a4632', '#2f3a2c', '#4a3a4a', '#57606e', '#6b4a2a'];
const HAT_COLORS = ['', '#d9bd72', '#8c5a3c', '#5d6b8a'];
const SHOE = '#2a2119';
const EYE = '#2a2a2a';

interface Paints {
  skin: string;
  skinShade: string;
  hair: string;
  shirt: string;
  shirtShade: string;
  trousers: string;
  hat: string;
  hatStyle: number;
  hairStyle: number;
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * amount)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * amount)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * amount)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function paintsFor(look: VillagerLook): Paints {
  const shirt = SHIRT[look.shirt % SHIRT.length];
  return {
    skin: SKIN[look.skin % SKIN.length],
    skinShade: SKIN_SHADE[look.skin % SKIN_SHADE.length],
    hair: HAIR[look.hair % HAIR.length],
    shirt,
    shirtShade: shade(shirt, 0.78),
    trousers: TROUSERS[look.trousers % TROUSERS.length],
    hat: HAT_COLORS[look.hat % HAT_COLORS.length],
    hatStyle: look.hat % HAT_COLORS.length,
    hairStyle: look.hairStyle % 4,
  };
}

/** Builds the full 6x4 atlas for one villager. */
export function createVillagerTexture(look: VillagerLook): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * COLS;
  canvas.height = CELL_H * ROWS;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const paints = paintsFor(look);
  const poses: PoseName[] = ['stand', 'walkA', 'walkB', 'work', 'sit', 'sleep'];
  const facings: (keyof typeof FACING)[] = ['south', 'west', 'north', 'east'];

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      ctx.save();
      ctx.translate(col * CELL_W, row * CELL_H);
      drawVillager(ctx, paints, facings[row], poses[col]);
      ctx.restore();
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  // Mipmaps on minification keep distant villagers from shimmering, while
  // NearestFilter magnification keeps the pixels honest up close.
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

type Ctx = CanvasRenderingContext2D;

function px(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  if (!color) return;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function drawVillager(ctx: Ctx, p: Paints, facing: keyof typeof FACING, pose: PoseName): void {
  if (pose === 'sleep') return drawSleeping(ctx, p);

  const side = facing === 'west' || facing === 'east';
  const back = facing === 'north';
  const mirror = facing === 'east';

  if (mirror) {
    ctx.save();
    ctx.translate(CELL_W, 0);
    ctx.scale(-1, 1);
  }

  const sitting = pose === 'sit';
  const bodyTop = sitting ? 17 : 13;
  const headTop = sitting ? 7 : 3;

  // --- legs -------------------------------------------------------------
  const legY = bodyTop + 10;
  if (sitting) {
    px(ctx, 8, legY, 9, 4, p.trousers);
    px(ctx, 8, legY + 4, 3, 2, SHOE);
    px(ctx, 14, legY + 4, 3, 2, SHOE);
  } else {
    const swingA = pose === 'walkA' ? 1 : pose === 'walkB' ? -1 : 0;
    const frontLegX = side ? 10 + swingA : 9;
    const backLegX = side ? 10 - swingA : 13;
    const legH = 7;
    px(ctx, backLegX, legY, side ? 4 : 2, legH, shade(p.trousers, 0.82));
    px(ctx, frontLegX, legY, side ? 4 : 2, legH, p.trousers);
    px(ctx, backLegX, legY + legH, side ? 4 : 2, 1, SHOE);
    px(ctx, frontLegX, legY + legH, side ? 4 : 2, 1, SHOE);
  }

  // --- torso ------------------------------------------------------------
  const bodyW = side ? 6 : 8;
  const bodyX = side ? 9 : 8;
  px(ctx, bodyX, bodyTop + 1, bodyW, 10, p.shirt);
  px(ctx, bodyX, bodyTop + 8, bodyW, 3, p.shirtShade);

  // --- arms -------------------------------------------------------------
  const working = pose === 'work';
  const swing = pose === 'walkA' ? -1 : pose === 'walkB' ? 1 : 0;
  if (side) {
    const armY = working ? bodyTop - 2 : bodyTop + 2 + swing;
    px(ctx, 11, armY, 2, working ? 6 : 7, p.shirtShade);
    px(ctx, 11, armY + (working ? 6 : 7), 2, 2, p.skin);
  } else {
    const leftY = working ? bodyTop - 3 : bodyTop + 2 + swing;
    const rightY = working ? bodyTop - 3 : bodyTop + 2 - swing;
    px(ctx, bodyX - 2, leftY, 2, working ? 7 : 7, p.shirt);
    px(ctx, bodyX + bodyW, rightY, 2, working ? 7 : 7, p.shirt);
    px(ctx, bodyX - 2, leftY + 7, 2, 2, p.skin);
    px(ctx, bodyX + bodyW, rightY + 7, 2, 2, p.skin);
  }

  // --- head -------------------------------------------------------------
  const headW = side ? 9 : 10;
  const headX = side ? 8 : 7;
  px(ctx, headX, headTop + 1, headW, 10, p.skin);
  px(ctx, headX, headTop + 9, headW, 2, p.skinShade);

  // Hair: a fringe, a cap of hair, or a longer style down the back.
  if (back) {
    px(ctx, headX, headTop, headW, 10, p.hair);
  } else {
    px(ctx, headX, headTop, headW, 3, p.hair);
    px(ctx, headX, headTop, 2, 6, p.hair);
    px(ctx, headX + headW - 2, headTop, 2, 6, p.hair);
    if (p.hairStyle >= 2) px(ctx, headX - 1, headTop + 3, 2, 6, p.hair);
    if (p.hairStyle === 3) px(ctx, headX + headW - 1, headTop + 3, 2, 6, p.hair);
  }

  // Face.
  if (!back) {
    if (side) {
      px(ctx, headX + 2, headTop + 5, 2, 2, EYE);
    } else {
      px(ctx, headX + 2, headTop + 5, 2, 2, EYE);
      px(ctx, headX + 6, headTop + 5, 2, 2, EYE);
      if (pose === 'sit' || pose === 'stand') px(ctx, headX + 4, headTop + 8, 2, 1, p.skinShade);
    }
  }

  // Hats sit on top of everything.
  if (p.hatStyle === 1) {
    px(ctx, headX - 2, headTop + 1, headW + 4, 2, p.hat);
    px(ctx, headX + 1, headTop - 2, headW - 2, 3, p.hat);
  } else if (p.hatStyle === 2) {
    px(ctx, headX, headTop - 1, headW, 4, p.hat);
  } else if (p.hatStyle === 3) {
    px(ctx, headX - 1, headTop - 1, headW + 2, 5, p.hat);
    px(ctx, headX - 1, headTop + 4, 2, 5, p.hat);
  }

  if (mirror) ctx.restore();
}

/** A villager asleep: lying down, with a blanket. */
function drawSleeping(ctx: Ctx, p: Paints): void {
  const y = 22;
  px(ctx, 4, y, 16, 5, p.shirt);
  px(ctx, 4, y + 3, 16, 2, p.shirtShade);
  px(ctx, 3, y - 1, 6, 6, p.skin);
  px(ctx, 3, y - 2, 6, 3, p.hair);
  px(ctx, 5, y + 1, 1, 1, EYE);
  px(ctx, 7, y + 1, 1, 1, EYE);
  px(ctx, 10, y, 11, 5, p.trousers);
  px(ctx, 19, y + 1, 3, 3, SHOE);
}

/**
 * A single standing, camera-facing frame, scaled up for the inspector panel.
 *
 * Reuses the same drawing routine as the in-world atlas, so the portrait is
 * always exactly the person you tapped.
 */
export function createPortraitCanvas(look: VillagerLook, scale = 3): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * scale;
  canvas.height = CELL_H * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.scale(scale, scale);
  drawVillager(ctx, paintsFor(look), 'south', 'stand');
  return canvas;
}

/* ------------------------------------------------------------- bubbles */

const bubbleCache = new Map<string, Texture>();

/** Small icon that floats over a villager's head. */
export function bubbleTexture(icon: string): Texture {
  const cached = bubbleCache.get(icon);
  if (cached) return cached;

  const size = 20;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  // Rounded speech bubble background.
  ctx.fillStyle = 'rgba(252, 249, 240, 0.94)';
  ctx.fillRect(2, 1, 16, 14);
  ctx.fillRect(1, 2, 18, 12);
  ctx.fillRect(8, 15, 4, 3);
  ctx.fillStyle = 'rgba(60, 48, 38, 0.35)';
  ctx.fillRect(1, 14, 18, 1);

  drawIcon(ctx, icon);

  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = SRGBColorSpace;
  bubbleCache.set(icon, texture);
  return texture;
}

function drawIcon(ctx: Ctx, icon: string): void {
  switch (icon) {
    case 'axe':
      px(ctx, 9, 4, 2, 9, '#6b4a2c');
      px(ctx, 5, 3, 5, 4, '#b9bec6');
      px(ctx, 5, 3, 2, 2, '#e2e6ea');
      break;
    case 'pick':
      px(ctx, 9, 5, 2, 8, '#6b4a2c');
      px(ctx, 4, 4, 12, 2, '#b9bec6');
      px(ctx, 4, 3, 3, 2, '#8d939c');
      px(ctx, 13, 3, 3, 2, '#8d939c');
      break;
    case 'berry':
      px(ctx, 6, 7, 4, 4, '#c0392b');
      px(ctx, 10, 9, 4, 4, '#a33227');
      px(ctx, 8, 3, 2, 4, '#5a8f4a');
      break;
    case 'hoe':
      px(ctx, 10, 3, 2, 10, '#6b4a2c');
      px(ctx, 5, 3, 6, 2, '#b9bec6');
      break;
    case 'fish':
      px(ctx, 5, 7, 8, 5, '#5aa9c4');
      px(ctx, 13, 6, 3, 7, '#3d8aa4');
      px(ctx, 6, 8, 2, 2, '#ffffff');
      break;
    case 'hammer':
      px(ctx, 9, 6, 2, 8, '#6b4a2c');
      px(ctx, 5, 3, 9, 4, '#8d939c');
      px(ctx, 5, 3, 9, 2, '#b9bec6');
      break;
    case 'crate':
      px(ctx, 4, 5, 12, 8, '#a87b4d');
      px(ctx, 4, 8, 12, 2, '#7d5a36');
      px(ctx, 9, 5, 2, 8, '#7d5a36');
      break;
    case 'sleep':
      px(ctx, 5, 9, 6, 2, '#5c6f8a');
      px(ctx, 9, 6, 2, 3, '#5c6f8a');
      px(ctx, 5, 4, 5, 2, '#5c6f8a');
      px(ctx, 8, 2, 2, 2, '#5c6f8a');
      break;
    case 'meal':
      px(ctx, 3, 8, 14, 3, '#d8c8a8');
      px(ctx, 5, 5, 10, 3, '#c9803e');
      px(ctx, 7, 3, 2, 2, '#e8d9b8');
      break;
    case 'chat':
      px(ctx, 4, 6, 4, 2, '#5a7f9a');
      px(ctx, 9, 6, 3, 2, '#5a7f9a');
      px(ctx, 4, 9, 8, 2, '#5a7f9a');
      break;
    case 'heart':
      px(ctx, 5, 5, 3, 3, '#d4566a');
      px(ctx, 11, 5, 3, 3, '#d4566a');
      px(ctx, 5, 7, 9, 3, '#d4566a');
      px(ctx, 7, 10, 5, 2, '#d4566a');
      px(ctx, 9, 12, 1, 1, '#d4566a');
      break;
    case 'note':
      px(ctx, 10, 3, 2, 8, '#4a5a7a');
      px(ctx, 6, 9, 5, 4, '#4a5a7a');
      px(ctx, 10, 3, 5, 2, '#4a5a7a');
      break;
    case 'spark':
      px(ctx, 9, 2, 2, 12, '#e8c257');
      px(ctx, 4, 7, 12, 2, '#e8c257');
      px(ctx, 6, 4, 2, 2, '#f2dc9a');
      px(ctx, 12, 10, 2, 2, '#f2dc9a');
      break;
    case 'leaf':
      px(ctx, 5, 8, 8, 4, '#5a8f4a');
      px(ctx, 8, 5, 5, 4, '#6fa858');
      px(ctx, 4, 11, 3, 2, '#6b4a2c');
      break;
    default:
      px(ctx, 8, 6, 3, 3, '#7a6a5a');
      break;
  }
}

/** Frees cached bubble textures. Used when tearing the scene down. */
export function disposeBubbleCache(): void {
  for (const texture of bubbleCache.values()) texture.dispose();
  bubbleCache.clear();
}
