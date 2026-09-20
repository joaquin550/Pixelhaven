/**
 * World clock: day/night phase, day counter, and seasons.
 *
 * One in-game day is `SECONDS_PER_DAY` of wall-clock time at 1x speed. Seasons
 * are purely cosmetic by design - Pixel Haven never punishes you for looking
 * away, so winter changes the palette and the mood, never the yields.
 */
import { clamp01, smoothstep } from './mathx';

export const SECONDS_PER_DAY = 420; // 7 real minutes per in-game day at 1x
export const DAYS_PER_SEASON = 7;

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

export const SEASON_LABEL: Record<Season, string> = {
  spring: 'Spring',
  summer: 'Summer',
  autumn: 'Autumn',
  winter: 'Winter',
};

export interface ClockSnapshot {
  /** Total elapsed in-game seconds since the haven was founded. */
  elapsed: number;
  /** Day number, starting at 1. */
  day: number;
  /** Position within the current day, 0 = midnight, 0.5 = noon. */
  phase: number;
  /** 0 at deep night, 1 at full day - drives lighting and villager routines. */
  daylight: number;
  season: Season;
  /** Progress through the current season, 0..1. */
  seasonProgress: number;
  /** Whether villagers consider it sleeping hours. */
  isNight: boolean;
  hour: number;
  minute: number;
}

export class WorldClock {
  elapsed: number;

  constructor(elapsed = SECONDS_PER_DAY * 0.28) {
    // New havens open a little after sunrise so the first thing you see is
    // villagers heading out to work.
    this.elapsed = elapsed;
  }

  advance(dt: number): void {
    this.elapsed += dt;
  }

  get day(): number {
    return Math.floor(this.elapsed / SECONDS_PER_DAY) + 1;
  }

  get phase(): number {
    return (this.elapsed % SECONDS_PER_DAY) / SECONDS_PER_DAY;
  }

  get season(): Season {
    const seasonIndex = Math.floor((this.day - 1) / DAYS_PER_SEASON) % SEASONS.length;
    return SEASONS[seasonIndex];
  }

  snapshot(): ClockSnapshot {
    const phase = this.phase;
    const daylight = daylightFor(phase);
    const dayOfSeason = (this.day - 1) % DAYS_PER_SEASON;
    const totalMinutes = phase * 24 * 60;
    return {
      elapsed: this.elapsed,
      day: this.day,
      phase,
      daylight,
      season: this.season,
      seasonProgress: clamp01((dayOfSeason + phase) / DAYS_PER_SEASON),
      isNight: daylight < 0.25,
      hour: Math.floor(totalMinutes / 60) % 24,
      minute: Math.floor(totalMinutes % 60),
    };
  }
}

/**
 * Daylight curve: dark until ~5am, full brightness 8am-6pm, dark again by ~9pm.
 * Smoothsteps on both ends give a long, soft golden hour.
 */
export function daylightFor(phase: number): number {
  const sunrise = smoothstep(0.21, 0.34, phase); // ~05:00 -> ~08:10
  const sunset = 1 - smoothstep(0.74, 0.88, phase); // ~17:45 -> ~21:00
  return clamp01(Math.min(sunrise, sunset));
}

/** Clock time formatted as a 24h string, e.g. "07:45". */
export function formatClock(snapshot: ClockSnapshot): string {
  const h = String(snapshot.hour).padStart(2, '0');
  const m = String(Math.floor(snapshot.minute / 5) * 5).padStart(2, '0');
  return `${h}:${m}`;
}
