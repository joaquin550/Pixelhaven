/**
 * Sky, sun, and the light that makes the whole thing feel like a place.
 *
 * A gradient dome, one orbiting directional light, a hemisphere fill, drifting
 * voxel clouds, and stars that fade up after dusk. Fog is tinted to match the
 * sky so the island edge dissolves instead of ending.
 */
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  PointLight,
  Scene,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import { clamp01, lerp, smoothstep } from '../core/mathx';
import { ClockSnapshot, SEASONS, Season } from '../core/time';
import { WORLD_SIZE } from '../world/constants';
import { GOLDEN, NIGHT, SNOW_COLOR, SeasonLook, seasonLook } from './palette';
import { updateSeasonUniforms } from './seasonMaterial';
import { Rng } from '../core/rng';
import { BoxBuilder } from './voxelBuilder';

const SKY_VERTEX = /* glsl */ `
  varying vec3 vPosition;
  void main() {
    vPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uBottom;
  uniform vec3 uHorizonGlow;
  uniform float uGlowStrength;
  uniform float uSunAzimuth;
  varying vec3 vPosition;

  void main() {
    vec3 dir = normalize(vPosition);
    float height = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 colour = mix(uBottom, uTop, pow(height, 0.85));

    // Warm band on the horizon, strongest towards the sun.
    float horizon = 1.0 - smoothstep(0.0, 0.32, abs(dir.y));
    float towardsSun = max(0.0, dot(normalize(vec3(dir.x, 0.0, dir.z)), vec3(sin(uSunAzimuth), 0.0, cos(uSunAzimuth))));
    colour = mix(colour, uHorizonGlow, horizon * uGlowStrength * (0.35 + towardsSun * 0.65));

    gl_FragColor = vec4(colour, 1.0);
  }
`;

export interface SkyState {
  look: SeasonLook;
  /** 0 = full night, 1 = full day. */
  daylight: number;
  /** 0..1 how golden the light currently is. */
  golden: number;
}

export class SkyRenderer {
  readonly group = new Group();
  readonly sun: DirectionalLight;
  readonly hemisphere: HemisphereLight;
  readonly lanternLights: PointLight[] = [];

  private dome: Mesh;
  private domeMaterial: ShaderMaterial;
  private stars: Points;
  private starMaterial: PointsMaterial;
  private clouds: Group;
  private cloudDrift = 0;
  private fog: Fog;

  private currentLook: SeasonLook;
  private topColor = new Color();
  private bottomColor = new Color();
  private fogColor = new Color();
  private sunColor = new Color();
  private ambientSky = new Color();
  private ambientGround = new Color();

  constructor(private scene: Scene, seed: string) {
    this.group.name = 'sky';

    this.domeMaterial = new ShaderMaterial({
      uniforms: {
        uTop: { value: new Color(0x4b90d6) },
        uBottom: { value: new Color(0xd3ebf5) },
        uHorizonGlow: { value: new Color(GOLDEN.skyBottom) },
        uGlowStrength: { value: 0 },
        uSunAzimuth: { value: 0 },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
    this.dome = new Mesh(new SphereGeometry(WORLD_SIZE * 2.4, 24, 16), this.domeMaterial);
    this.dome.position.set(WORLD_SIZE / 2, 0, WORLD_SIZE / 2);
    this.dome.renderOrder = -1;
    this.group.add(this.dome);

    this.sun = new DirectionalLight(0xfff3d8, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = WORLD_SIZE * 2.4;
    const span = WORLD_SIZE * 0.62;
    this.sun.shadow.camera.left = -span;
    this.sun.shadow.camera.right = span;
    this.sun.shadow.camera.top = span;
    this.sun.shadow.camera.bottom = -span;
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.035;
    this.sun.target.position.set(WORLD_SIZE / 2, 0, WORLD_SIZE / 2);
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    this.hemisphere = new HemisphereLight(0xa4bccb, 0x5a5142, 1.15);
    this.group.add(this.hemisphere);

    // Four warm lights, re-homed each frame onto whichever hearths and
    // lanterns are nearest the camera.
    for (let i = 0; i < 4; i++) {
      const light = new PointLight(0xffb469, 0, 12, 2);
      light.visible = false;
      this.lanternLights.push(light);
      this.group.add(light);
    }

    const stars = buildStars(seed);
    this.starMaterial = stars.material;
    this.stars = stars.points;
    this.group.add(this.stars);

    this.clouds = buildClouds(seed);
    this.group.add(this.clouds);

    this.fog = new Fog(0xc8e2ec, WORLD_SIZE * 0.55, WORLD_SIZE * 2.1);
    scene.fog = this.fog;
    scene.add(this.group);

    this.currentLook = seasonLook('summer', 0, 'autumn');
  }

  /** Advances sky, light and season tinting to match the clock. */
  update(clock: ClockSnapshot, dt: number, lightSources: { x: number; y: number; z: number; strength: number }[], focus: { x: number; z: number }): SkyState {
    const nextSeason = SEASONS[(SEASONS.indexOf(clock.season) + 1) % SEASONS.length] as Season;
    const look = seasonLook(clock.season, clock.seasonProgress, nextSeason);
    this.currentLook = look;

    const daylight = clock.daylight;
    // Golden hour: peaks while the sun is low but present.
    const golden = clamp01(smoothstep(0.02, 0.35, daylight) * (1 - smoothstep(0.42, 0.78, daylight)));

    // --- sun position -----------------------------------------------------
    // The sun rises in the east, crosses high at noon, sets in the west.
    const sunAngle = (clock.phase - 0.25) * Math.PI * 2;
    const elevation = Math.sin(sunAngle);
    const azimuth = Math.cos(sunAngle);
    const radius = WORLD_SIZE * 0.95;
    this.sun.position.set(
      WORLD_SIZE / 2 + azimuth * radius,
      Math.max(6, elevation * radius * 0.8 + WORLD_SIZE * 0.2),
      WORLD_SIZE / 2 + radius * 0.45,
    );
    this.sun.target.position.set(focus.x, 0, focus.z);
    this.sun.target.updateMatrixWorld();

    // --- colours ----------------------------------------------------------
    this.topColor.copy(NIGHT.skyTop).lerp(look.skyTop, daylight);
    this.bottomColor.copy(NIGHT.skyBottom).lerp(look.skyBottom, daylight);
    this.bottomColor.lerp(GOLDEN.skyBottom, golden * 0.55);
    this.fogColor.copy(NIGHT.fog).lerp(look.fog, daylight);
    this.fogColor.lerp(GOLDEN.fog, golden * 0.4);

    this.sunColor.copy(NIGHT.moon).lerp(look.sun, daylight);
    this.sunColor.lerp(GOLDEN.sun, golden * 0.7);

    this.domeMaterial.uniforms.uTop.value.copy(this.topColor);
    this.domeMaterial.uniforms.uBottom.value.copy(this.bottomColor);
    this.domeMaterial.uniforms.uGlowStrength.value = golden * 0.9 + daylight * 0.15;
    this.domeMaterial.uniforms.uSunAzimuth.value = Math.atan2(
      this.sun.position.x - WORLD_SIZE / 2,
      this.sun.position.z - WORLD_SIZE / 2,
    );

    this.sun.color.copy(this.sunColor);
    this.sun.intensity = lerp(0.22, 2.25, daylight);

    this.ambientSky.copy(NIGHT.ambient).lerp(look.ambient, daylight);
    this.ambientGround.set(0x4a4436).lerp(new Color(0x6b6250), daylight);
    this.hemisphere.color.copy(this.ambientSky);
    this.hemisphere.groundColor.copy(this.ambientGround);
    this.hemisphere.intensity = lerp(0.65, 1.25, daylight);

    this.fog.color.copy(this.fogColor);
    this.scene.background = this.fogColor;

    // --- season tinting ---------------------------------------------------
    updateSeasonUniforms({
      tint: look.tint,
      snow: look.snow,
      snowColor: SNOW_COLOR,
      nightAmount: (1 - daylight) * 0.45,
      nightTint: NIGHT.ambient,
    });

    // --- stars and clouds -------------------------------------------------
    this.starMaterial.opacity = clamp01(1 - daylight * 2.6);
    this.stars.visible = this.starMaterial.opacity > 0.01;
    this.stars.rotation.y += dt * 0.004;

    this.cloudDrift += dt * 0.35;
    this.clouds.position.x = ((this.cloudDrift % (WORLD_SIZE * 2)) - WORLD_SIZE) * 0.5;
    for (const child of this.clouds.children) {
      const material = (child as Mesh).material as MeshBasicMaterial;
      material.color.copy(this.bottomColor).lerp(new Color(0xffffff), 0.45 + daylight * 0.35);
      material.opacity = lerp(0.35, 0.8, daylight);
    }

    this.updateLanternLights(lightSources, focus, 1 - daylight);

    return { look, daylight, golden };
  }

  /** Moves the small pool of warm lights onto the nearest fires. */
  private updateLanternLights(
    sources: { x: number; y: number; z: number; strength: number }[],
    focus: { x: number; z: number },
    night: number,
  ): void {
    if (night < 0.06 || sources.length === 0) {
      for (const light of this.lanternLights) light.visible = false;
      return;
    }
    const sorted = sources
      .map((s) => ({ ...s, d: (s.x - focus.x) ** 2 + (s.z - focus.z) ** 2 }))
      .sort((a, b) => a.d - b.d);

    for (let i = 0; i < this.lanternLights.length; i++) {
      const light = this.lanternLights[i];
      const source = sorted[i];
      if (!source) {
        light.visible = false;
        continue;
      }
      light.visible = true;
      light.position.set(source.x, source.y, source.z);
      light.intensity = night * source.strength * 9;
      light.distance = 11 * source.strength + 5;
    }
  }

  get look(): SeasonLook {
    return this.currentLook;
  }

  /** Adjusts fog to the camera distance so close-ups stay clear. */
  setFogRange(cameraDistance: number): void {
    this.fog.near = Math.max(8, cameraDistance * 0.9);
    this.fog.far = cameraDistance * 3.4 + WORLD_SIZE * 0.8;
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.domeMaterial.dispose();
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
    for (const child of this.clouds.children) {
      (child as Mesh).geometry.dispose();
      ((child as Mesh).material as MeshBasicMaterial).dispose();
    }
    this.scene.remove(this.group);
  }
}

function buildStars(seed: string): { points: Points; material: PointsMaterial } {
  const rng = new Rng(`${seed}:stars`);
  const count = 420;
  const positions = new Float32Array(count * 3);
  const radius = WORLD_SIZE * 2.15;

  for (let i = 0; i < count; i++) {
    // Upper hemisphere only - nobody looks at stars below the horizon.
    const theta = rng.range(0, Math.PI * 2);
    const phi = Math.acos(rng.range(0.05, 1));
    positions[i * 3] = WORLD_SIZE / 2 + radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi);
    positions[i * 3 + 2] = WORLD_SIZE / 2 + radius * Math.sin(phi) * Math.sin(theta);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));

  const material = new PointsMaterial({
    color: 0xdfe8ff,
    size: 1.4,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: AdditiveBlending,
    map: createStarTexture(),
  });

  const points = new Points(geometry, material);
  points.renderOrder = -1;
  return { points, material };
}

function createStarTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(3, 2, 2, 4);
  ctx.fillRect(2, 3, 4, 2);
  return new CanvasTexture(canvas);
}

/** Chunky voxel clouds, drifting slowly overhead. */
function buildClouds(seed: string): Group {
  const rng = new Rng(`${seed}:clouds`);
  const group = new Group();
  group.name = 'clouds';

  for (let i = 0; i < 14; i++) {
    const builder = new BoxBuilder();
    const puffs = rng.int(3, 6);
    const scale = rng.range(3.5, 8);
    for (let p = 0; p < puffs; p++) {
      builder.add(
        rng.range(-scale, scale),
        rng.range(-scale * 0.18, scale * 0.18),
        rng.range(-scale * 0.7, scale * 0.7),
        rng.range(scale * 0.7, scale * 1.4),
        rng.range(scale * 0.3, scale * 0.55),
        rng.range(scale * 0.6, scale * 1.1),
        0xffffff,
        { flat: true },
      );
    }
    const mesh = new Mesh(
      builder.build(),
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        fog: false,
      }),
    );
    mesh.position.set(
      rng.range(-WORLD_SIZE * 0.8, WORLD_SIZE * 1.8),
      rng.range(WORLD_SIZE * 0.55, WORLD_SIZE * 0.85),
      rng.range(-WORLD_SIZE * 0.8, WORLD_SIZE * 1.8),
    );
    mesh.renderOrder = -1;
    group.add(mesh);
  }
  return group;
}
