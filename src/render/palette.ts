/**
 * The colour language of Pixel Haven.
 *
 * Warm, slightly desaturated, a bit more moss-and-timber than pastel - cozy
 * without being sugary. Everything is authored once here so the terrain,
 * buildings, sprites and UI stay in the same family.
 */
import { Color } from 'three';
import { Season } from '../core/time';
import { TerrainType } from '../world/constants';

export const TOP_COLORS: Record<number, number> = {
  [TerrainType.Water]: 0x3f6f7a,
  [TerrainType.Sand]: 0xd9c48c,
  [TerrainType.Grass]: 0x63a04a,
  [TerrainType.Dirt]: 0x8a6b46,
  [TerrainType.Stone]: 0x8e9199,
  [TerrainType.Snow]: 0xe8eff5,
  [TerrainType.Farmland]: 0x6f5135,
  [TerrainType.Path]: 0xa8a294,
};

/** Exposed cliff faces read as earth and rock rather than more grass. */
export const SIDE_COLORS: Record<number, number> = {
  [TerrainType.Water]: 0x35606b,
  [TerrainType.Sand]: 0xc4ad78,
  [TerrainType.Grass]: 0x7a5c3c,
  [TerrainType.Dirt]: 0x74593a,
  [TerrainType.Stone]: 0x777a82,
  [TerrainType.Snow]: 0xb9c6d2,
  [TerrainType.Farmland]: 0x5d442d,
  [TerrainType.Path]: 0x8e8879,
};

/** How strongly each surface responds to the season. */
export const SEASON_RESPONSE: Record<number, number> = {
  [TerrainType.Water]: 0,
  [TerrainType.Sand]: 0.18,
  [TerrainType.Grass]: 1,
  [TerrainType.Dirt]: 0.4,
  [TerrainType.Stone]: 0.12,
  [TerrainType.Snow]: 0,
  [TerrainType.Farmland]: 0.5,
  [TerrainType.Path]: 0.1,
};

export interface SeasonLook {
  /** Multiplicative tint applied to season-responsive surfaces. */
  tint: Color;
  /** Colour foliage and grass are pulled towards. */
  blend: Color;
  /** How far, 0..1, before each material's own scale is applied. */
  blendAmount: number;
  /** 0..1 how much white settles on upward faces. */
  snow: number;
  /** Foliage tint for trees and bushes. */
  foliage: Color;
  /** Sky gradient at noon. */
  skyTop: Color;
  skyBottom: Color;
  /** Distance fog. */
  fog: Color;
  /** Warm/cool bias of the sun. */
  sun: Color;
  /** Ambient bounce light. */
  ambient: Color;
  /** Water surface colour. */
  waterShallow: Color;
  waterDeep: Color;
}

const LOOKS: Record<Season, SeasonLook> = {
  spring: {
    tint: new Color(1.06, 1.08, 0.94),
    blend: new Color(0x7fc25c),
    blendAmount: 0.22,
    snow: 0,
    foliage: new Color(0x76b04a),
    skyTop: new Color(0x5f9fd4),
    skyBottom: new Color(0xbfe0ef),
    fog: new Color(0xb8d8e4),
    sun: new Color(0xfff0d4),
    ambient: new Color(0x9fb8c9),
    waterShallow: new Color(0x6fc2c9),
    waterDeep: new Color(0x2b6b87),
  },
  summer: {
    tint: new Color(1, 1, 1),
    blend: new Color(0x4f8f3c),
    blendAmount: 0.1,
    snow: 0,
    foliage: new Color(0x4f8f3c),
    skyTop: new Color(0x4b90d6),
    skyBottom: new Color(0xd3ebf5),
    fog: new Color(0xc8e2ec),
    sun: new Color(0xfff3d8),
    ambient: new Color(0xa4bccb),
    waterShallow: new Color(0x64c4cc),
    waterDeep: new Color(0x276785),
  },
  autumn: {
    tint: new Color(1.3, 0.96, 0.58),
    blend: new Color(0xc2661f),
    blendAmount: 0.62,
    snow: 0,
    foliage: new Color(0xc07a2e),
    skyTop: new Color(0x6d93bd),
    skyBottom: new Color(0xe6d6be),
    fog: new Color(0xdcc9ae),
    sun: new Color(0xffdfae),
    ambient: new Color(0xb3a894),
    waterShallow: new Color(0x63a8ae),
    waterDeep: new Color(0x356777),
  },
  winter: {
    tint: new Color(0.84, 0.9, 1.0),
    blend: new Color(0x8ba09b),
    blendAmount: 0.45,
    snow: 1,
    foliage: new Color(0x5c7a63),
    skyTop: new Color(0x7e9ec2),
    skyBottom: new Color(0xe4edf5),
    fog: new Color(0xdbe6f0),
    sun: new Color(0xe8f0ff),
    ambient: new Color(0xb6c6d8),
    waterShallow: new Color(0x76a8bd),
    waterDeep: new Color(0x3a6178),
  },
};

export const SNOW_COLOR = new Color(0xeef5fb);

/** Night sky and lighting, blended in by daylight. */
/**
 * Night is a colour, not an absence of one.
 *
 * These are deliberately well off black: a cozy game's night should read as
 * cool moonlight you can still see the village by, not as a screen you have to
 * turn the brightness up for.
 */
export const NIGHT = {
  skyTop: new Color(0x16224a),
  skyBottom: new Color(0x3d5076),
  fog: new Color(0x2f3f63),
  ambient: new Color(0x6b7da6),
  moon: new Color(0xb8c8f0),
};

/** Warm dusk/dawn colours mixed in around the light transitions. */
export const GOLDEN = {
  sun: new Color(0xffa860),
  skyBottom: new Color(0xf2b077),
  fog: new Color(0xdfa585),
};

/** Blends between the current season and the next for smooth transitions. */
export function seasonLook(season: Season, progress: number, next: Season): SeasonLook {
  const a = LOOKS[season];
  const b = LOOKS[next];
  // Only cross-fade over the tail of the season, so most of it looks settled.
  const t = progress < 0.75 ? 0 : (progress - 0.75) / 0.25;
  if (t <= 0) return a;
  return {
    tint: a.tint.clone().lerp(b.tint, t),
    blend: a.blend.clone().lerp(b.blend, t),
    blendAmount: a.blendAmount + (b.blendAmount - a.blendAmount) * t,
    snow: a.snow + (b.snow - a.snow) * t,
    foliage: a.foliage.clone().lerp(b.foliage, t),
    skyTop: a.skyTop.clone().lerp(b.skyTop, t),
    skyBottom: a.skyBottom.clone().lerp(b.skyBottom, t),
    fog: a.fog.clone().lerp(b.fog, t),
    sun: a.sun.clone().lerp(b.sun, t),
    ambient: a.ambient.clone().lerp(b.ambient, t),
    waterShallow: a.waterShallow.clone().lerp(b.waterShallow, t),
    waterDeep: a.waterDeep.clone().lerp(b.waterDeep, t),
  };
}

/** Structure palette - timber, thatch, plaster, stone. */
export const BUILD = {
  timber: 0x8a5f39,
  timberDark: 0x6d4a2c,
  plaster: 0xe3d5b8,
  thatch: 0xc39a55,
  thatchDark: 0x9d7a3f,
  roofTile: 0xa2513c,
  roofTileDark: 0x7f3d2d,
  stone: 0x9a9791,
  stoneDark: 0x77746f,
  plank: 0xa87b4d,
  window: 0xf6d98a,
  windowNight: 0xffc95e,
  ghost: 0x6fc7e8,
  crop: 0x8fbc4a,
  cropRipe: 0xd8c14e,
  soil: 0x5f4530,
  fire: 0xff9a3c,
  lantern: 0xffcf7a,
};
