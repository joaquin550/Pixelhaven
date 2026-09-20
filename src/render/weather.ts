/**
 * Seasonal particles: falling leaves, snow, rain, and summer fireflies.
 *
 * One Points system with a pre-allocated buffer that is re-seeded whenever the
 * season changes, so switching from autumn leaves to winter snow costs an
 * attribute update rather than an allocation. Purely atmospheric - the brief is
 * explicit that seasons never punish you.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  NearestFilter,
  NormalBlending,
  Points,
  PointsMaterial,
} from 'three';
import { Rng } from '../core/rng';
import { clamp01 } from '../core/mathx';
import { ClockSnapshot, Season } from '../core/time';
import { WATER_LEVEL, WORLD_SIZE } from '../world/constants';

const MAX_PARTICLES = 900;

type Mode = 'none' | 'leaves' | 'snow' | 'rain' | 'fireflies' | 'blossom';

interface ModeConfig {
  count: number;
  fallSpeed: number;
  drift: number;
  size: number;
  colors: number[];
  blending: typeof NormalBlending | typeof AdditiveBlending;
  /** Particles spawn near the ground and rise instead of falling. */
  rises?: boolean;
}

const CONFIGS: Record<Exclude<Mode, 'none'>, ModeConfig> = {
  leaves: {
    count: 320,
    fallSpeed: 1.5,
    drift: 1.5,
    size: 0.34,
    colors: [0xc8813a, 0xb2542f, 0xd9a84e, 0x8f6a2c],
    blending: NormalBlending,
  },
  blossom: {
    count: 260,
    fallSpeed: 1.1,
    drift: 1.2,
    size: 0.28,
    colors: [0xf2d6e0, 0xffffff, 0xf7e6c4],
    blending: NormalBlending,
  },
  snow: {
    count: 620,
    fallSpeed: 1.9,
    drift: 0.75,
    size: 0.3,
    colors: [0xffffff, 0xe8f2ff, 0xdfeaf7],
    blending: NormalBlending,
  },
  rain: {
    count: 700,
    fallSpeed: 13,
    drift: 0.25,
    size: 0.2,
    colors: [0xa9c8d8, 0x8fb2c6],
    blending: NormalBlending,
  },
  fireflies: {
    count: 130,
    fallSpeed: 0.18,
    drift: 0.5,
    size: 0.26,
    colors: [0xffe08a, 0xd8f08a],
    blending: AdditiveBlending,
    rises: true,
  },
};

export class WeatherRenderer {
  readonly points: Points;
  private material: PointsMaterial;
  private geometry: BufferGeometry;
  private positions: Float32Array;
  private velocities: Float32Array;
  private phases: Float32Array;
  private mode: Mode = 'none';
  private config: ModeConfig | null = null;
  private rng: Rng;
  /** 0..1 chance-driven rain, refreshed once per in-game day. */
  private rainToday = 0;
  private lastDay = -1;

  constructor(seed: string) {
    this.rng = new Rng(`${seed}:weather`);
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.phases = new Float32Array(MAX_PARTICLES);

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3));
    this.geometry.setDrawRange(0, 0);
    // The particle field follows the camera, so a fixed bounding sphere avoids
    // three culling it at the wrong moment.
    this.geometry.boundingSphere = null;

    this.material = new PointsMaterial({
      size: 0.32,
      sizeAttenuation: true,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      map: createFlakeTexture(),
      alphaTest: 0.2,
    });

    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.name = 'weather';
  }

  /** Picks the right particle mode for the season and time of day. */
  update(clock: ClockSnapshot, dt: number, focus: { x: number; z: number }): void {
    if (clock.day !== this.lastDay) {
      this.lastDay = clock.day;
      this.rainToday = this.rng.float();
    }

    const desired = chooseMode(clock.season, clock, this.rainToday);
    if (desired !== this.mode) this.setMode(desired, focus);
    if (this.mode === 'none' || !this.config) return;

    this.step(dt, focus);
  }

  private setMode(mode: Mode, focus: { x: number; z: number }): void {
    this.mode = mode;
    if (mode === 'none') {
      this.config = null;
      this.geometry.setDrawRange(0, 0);
      return;
    }

    const config = CONFIGS[mode];
    this.config = config;
    this.material.size = config.size;
    this.material.blending = config.blending;
    this.material.needsUpdate = true;

    const colors = this.geometry.getAttribute('color') as BufferAttribute;
    const colorArray = colors.array as Float32Array;
    const tmp = new Color();

    for (let i = 0; i < config.count; i++) {
      this.seedParticle(i, focus, true);
      tmp.setHex(this.rng.pick(config.colors));
      colorArray[i * 3] = tmp.r;
      colorArray[i * 3 + 1] = tmp.g;
      colorArray[i * 3 + 2] = tmp.b;
    }
    colors.needsUpdate = true;
    this.geometry.setDrawRange(0, config.count);
  }

  private seedParticle(i: number, focus: { x: number; z: number }, anywhere: boolean): void {
    const config = this.config!;
    const spread = 46;
    const x = focus.x + this.rng.range(-spread, spread);
    const z = focus.z + this.rng.range(-spread, spread);

    let y: number;
    if (config.rises) {
      y = WATER_LEVEL + this.rng.range(0.5, 6);
    } else if (anywhere) {
      y = this.rng.range(WATER_LEVEL, WATER_LEVEL + 34);
    } else {
      y = WATER_LEVEL + this.rng.range(28, 36);
    }

    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;

    this.velocities[i * 3] = this.rng.range(-config.drift, config.drift);
    this.velocities[i * 3 + 1] = -config.fallSpeed * this.rng.range(0.75, 1.3);
    this.velocities[i * 3 + 2] = this.rng.range(-config.drift, config.drift);
    this.phases[i] = this.rng.range(0, Math.PI * 2);
  }

  private step(dt: number, focus: { x: number; z: number }): void {
    const config = this.config!;
    const attribute = this.geometry.getAttribute('position') as BufferAttribute;
    const floor = WATER_LEVEL - 1;

    for (let i = 0; i < config.count; i++) {
      const base = i * 3;
      this.phases[i] += dt * 1.6;

      if (config.rises) {
        // Fireflies bob rather than fall.
        this.positions[base] += Math.sin(this.phases[i] * 0.7) * config.drift * dt;
        this.positions[base + 1] += Math.sin(this.phases[i]) * 0.35 * dt;
        this.positions[base + 2] += Math.cos(this.phases[i] * 0.9) * config.drift * dt;
      } else {
        this.positions[base] += (this.velocities[base] + Math.sin(this.phases[i]) * config.drift * 0.6) * dt;
        this.positions[base + 1] += this.velocities[base + 1] * dt;
        this.positions[base + 2] +=
          (this.velocities[base + 2] + Math.cos(this.phases[i] * 0.8) * config.drift * 0.6) * dt;
      }

      // Recycle anything that fell out of the world or drifted too far.
      const dx = this.positions[base] - focus.x;
      const dz = this.positions[base + 2] - focus.z;
      if (this.positions[base + 1] < floor || Math.abs(dx) > 56 || Math.abs(dz) > 56) {
        this.seedParticle(i, focus, false);
      }
    }
    attribute.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}

function chooseMode(season: Season, clock: ClockSnapshot, rainRoll: number): Mode {
  if (season === 'winter') return 'snow';
  if (season === 'autumn') return rainRoll < 0.22 ? 'rain' : 'leaves';
  if (season === 'spring') return rainRoll < 0.3 ? 'rain' : 'blossom';
  // Summer: fireflies after dark, clear skies otherwise.
  if (clock.daylight < 0.18) return 'fireflies';
  return rainRoll < 0.1 ? 'rain' : 'none';
}

/** A tiny pixel flake, reused for every particle type. */
function createFlakeTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(2, 2, 4, 4);
  ctx.fillRect(3, 1, 2, 6);
  ctx.fillRect(1, 3, 6, 2);
  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

export { clamp01, WORLD_SIZE };
