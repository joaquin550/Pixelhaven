/**
 * The scene: everything visible, assembled and driven.
 *
 * Also owns picking. Ground taps are resolved by marching the ray against the
 * height field rather than raycasting the terrain mesh - it is exact enough,
 * costs nothing, and lets the build preview follow a dragging finger at 60fps
 * on hardware that would choke on 200k triangles of BVH-less raycast.
 */
import {
  ACESFilmicToneMapping,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  RingGeometry,
  SRGBColorSpace,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { clamp } from '../core/mathx';
import { ClockSnapshot } from '../core/time';
import { WATER_LEVEL, WORLD_SIZE, inBounds } from '../world/constants';
import { Haven } from '../sim/haven';
import { CameraRig, CameraRigOptions } from './cameraRig';
import { TerrainRenderer } from './terrainMesh';
import { WaterRenderer } from './water';
import { PropRenderer } from './propMeshes';
import { StructureRenderer } from './structureMeshes';
import { VillagerRenderer } from './villagerRenderer';
import { SkyRenderer } from './sky';
import { WeatherRenderer } from './weather';
import { TrailRenderer } from './trails';
import { SmokeRenderer } from './smoke';
import { GroundDetailRenderer } from './groundDetail';

export interface GroundHit {
  /** Integer cell coordinates. */
  x: number;
  z: number;
  /** Exact intersection point. */
  point: Vector3;
  /** True when the ray landed on open water. */
  water: boolean;
}

export interface SceneQuality {
  shadows: boolean;
  weather: boolean;
  /** Thought bubbles over villagers' heads. */
  bubbles: boolean;
  /** Renderer pixel ratio cap. */
  maxPixelRatio: number;
}

export const DEFAULT_QUALITY: SceneQuality = {
  shadows: true,
  weather: true,
  bubbles: true,
  maxPixelRatio: 2,
};

export class GameScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly rig: CameraRig;
  readonly terrain: TerrainRenderer;
  readonly water: WaterRenderer;
  readonly props: PropRenderer;
  readonly structures: StructureRenderer;
  readonly villagers: VillagerRenderer;
  readonly sky: SkyRenderer;
  readonly weather: WeatherRenderer;
  readonly trails: TrailRenderer;
  readonly smoke: SmokeRenderer;
  readonly groundDetail: GroundDetailRenderer;

  private raycaster = new Raycaster();
  private brush: Group;
  private brushRing: Mesh;
  private brushFill: Mesh;
  private brushRadius = -1;
  private quality: SceneQuality = { ...DEFAULT_QUALITY };
  private elapsed = 0;
  /** Rolling average frame time, used to back off quality automatically. */
  private frameTimeAvg = 16;
  private autoQualityCooldown = 6;

  constructor(
    private canvas: HTMLCanvasElement,
    private haven: Haven,
    rigOptions: CameraRigOptions = {},
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: window.devicePixelRatio < 1.5,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(new Color(0xc8e2ec), 1);

    this.rig = new CameraRig(canvas, {
      ...rigOptions,
      groundHeight: (x, z) =>
        Math.max(WATER_LEVEL, haven.terrain.heightAt(Math.floor(x), Math.floor(z))),
    });

    this.terrain = new TerrainRenderer(haven.terrain);
    this.water = new WaterRenderer(haven.terrain);
    this.props = new PropRenderer(haven.props);
    this.structures = new StructureRenderer(haven.structures);
    this.villagers = new VillagerRenderer();
    this.sky = new SkyRenderer(this.scene, haven.seed);
    this.weather = new WeatherRenderer(haven.seed);
    this.trails = new TrailRenderer(haven.terrain);
    this.smoke = new SmokeRenderer(haven.structures);
    this.groundDetail = new GroundDetailRenderer(haven.terrain);

    this.scene.add(this.terrain.group);
    this.scene.add(this.water.mesh);
    this.scene.add(this.trails.mesh);
    this.scene.add(this.groundDetail.mesh);
    this.scene.add(this.props.group);
    this.scene.add(this.structures.group);
    this.scene.add(this.villagers.group);
    this.scene.add(this.weather.points);
    this.scene.add(this.smoke.mesh);

    const { group, ring, fill } = createBrush();
    this.brush = group;
    this.brushRing = ring;
    this.brushFill = fill;
    this.brush.visible = false;
    this.scene.add(this.brush);

    this.rig.focusOn(haven.origin.x, haven.origin.z, 58);
    this.resize();
  }

  setQuality(quality: Partial<SceneQuality>): void {
    this.quality = { ...this.quality, ...quality };
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.sky.sun.castShadow = this.quality.shadows;
    this.weather.points.visible = this.quality.weather;
    this.villagers.showBubbles = this.quality.bubbles;
    for (const child of this.terrain.group.children) child.castShadow = this.quality.shadows;
    this.resize();
    // Materials need recompiling when the shadow setting flips.
    this.scene.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.material) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) material.needsUpdate = true;
      }
    });
  }

  get currentQuality(): SceneQuality {
    return { ...this.quality };
  }

  resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.rig.resize(width, height);
  }

  /** Advances all visual systems and draws a frame. */
  render(dt: number, clock: ClockSnapshot, selectedVillagerId: number | null): void {
    this.elapsed += dt;
    const frameStart = performance.now();

    this.rig.update(dt);
    this.sky.setFogRange(this.rig.cameraDistance);

    this.terrain.syncIfStale();
    this.props.syncIfStale();
    this.structures.syncIfStale();

    const focus = this.rig.focusPoint;
    const skyState = this.sky.update(clock, dt, this.structures.lightSources(), {
      x: focus.x,
      z: focus.z,
    });

    this.water.update(this.elapsed, skyState.look, 1 - skyState.daylight);
    this.trails.update(dt);
    this.groundDetail.update(dt);
    this.smoke.update(dt, 1 - skyState.daylight, Math.sin(this.elapsed * 0.07) * 0.6 + 0.5);
    this.structures.update(this.elapsed, 1 - skyState.daylight);
    this.villagers.update(this.haven.villagers, this.rig.orbitAngle, dt, selectedVillagerId);
    if (this.quality.weather) {
      this.weather.update(clock, dt, { x: focus.x, z: focus.z });
    }

    this.renderer.render(this.scene, this.rig.camera);

    this.trackPerformance(performance.now() - frameStart, dt);
  }

  /**
   * Drops quality a notch if frames are consistently slow.
   * Older iPads get a playable haven instead of a beautiful slideshow.
   */
  private trackPerformance(frameMs: number, dt: number): void {
    this.frameTimeAvg += (frameMs - this.frameTimeAvg) * 0.05;
    this.autoQualityCooldown -= dt;
    if (this.autoQualityCooldown > 0) return;

    if (this.frameTimeAvg > 26 && this.quality.shadows) {
      this.setQuality({ shadows: false });
      this.autoQualityCooldown = 12;
    } else if (this.frameTimeAvg > 30 && this.quality.maxPixelRatio > 1.25) {
      this.setQuality({ maxPixelRatio: 1.25 });
      this.autoQualityCooldown = 12;
    } else if (this.frameTimeAvg > 34 && this.quality.weather) {
      this.setQuality({ weather: false });
      this.autoQualityCooldown = 20;
    } else {
      this.autoQualityCooldown = 3;
    }
  }

  /* ------------------------------------------------------------ picking */

  /** Marches a ray against the height field. */
  pickGround(ndc: Vector2): GroundHit | null {
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    const origin = this.raycaster.ray.origin;
    const direction = this.raycaster.ray.direction;

    const maxDistance = WORLD_SIZE * 3;
    const step = 0.35;
    const point = new Vector3();
    let previous = 0;

    for (let t = 0; t < maxDistance; t += step) {
      point.copy(direction).multiplyScalar(t).add(origin);
      const cellX = Math.floor(point.x);
      const cellZ = Math.floor(point.z);
      if (!inBounds(cellX, cellZ)) {
        if (point.y < WATER_LEVEL - 12) return null;
        previous = t;
        continue;
      }
      const surface = Math.max(this.haven.terrain.heightAt(cellX, cellZ), WATER_LEVEL);
      if (point.y <= surface) {
        // Bisect back towards the exact crossing so the cell is never off by one.
        let lo = previous;
        let hi = t;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          point.copy(direction).multiplyScalar(mid).add(origin);
          const mx = Math.floor(point.x);
          const mz = Math.floor(point.z);
          const s = inBounds(mx, mz) ? Math.max(this.haven.terrain.heightAt(mx, mz), WATER_LEVEL) : -999;
          if (point.y <= s) hi = mid;
          else lo = mid;
        }
        point.copy(direction).multiplyScalar(hi).add(origin);
        const x = clamp(Math.floor(point.x), 0, WORLD_SIZE - 1);
        const z = clamp(Math.floor(point.z), 0, WORLD_SIZE - 1);
        return { x, z, point: point.clone(), water: !this.haven.terrain.isLand(x, z) };
      }
      previous = t;
    }
    return null;
  }

  /** Returns the id of a villager under the tap, if any. */
  pickVillager(ndc: Vector2): number | null {
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    const hits = this.raycaster.intersectObjects(this.villagers.pickables(), false);
    for (const hit of hits) {
      const id = hit.object.userData.villagerId as number | undefined;
      if (id !== undefined) return id;
    }
    return null;
  }

  /* -------------------------------------------------------- sculpt brush */

  /**
   * Shows where a stroke would land.
   *
   * The ring sits at the height of the cell under the cursor and follows the
   * ground, so on a slope it reads as a contour rather than a floating disc.
   */
  showBrush(x: number, z: number, radius: number, affordable: boolean): void {
    if (this.brushRadius !== radius) {
      rebuildBrushGeometry(this.brushRing, this.brushFill, radius);
      this.brushRadius = radius;
    }

    this.brush.visible = true;
    this.brush.position.set(x + 0.5, this.haven.terrain.heightAt(x, z) + 0.05, z + 0.5);

    const colour = affordable ? 0x9fe8ff : 0xe8564a;
    (this.brushRing.material as MeshBasicMaterial).color.setHex(colour);
    (this.brushFill.material as MeshBasicMaterial).color.setHex(colour);
    const pulse = 0.5 + Math.sin(this.elapsed * 7) * 0.16;
    (this.brushRing.material as MeshBasicMaterial).opacity = pulse + 0.35;
    (this.brushFill.material as MeshBasicMaterial).opacity = pulse * 0.24;
  }

  hideBrush(): void {
    this.brush.visible = false;
  }

  dispose(): void {
    this.rig.dispose();
    this.terrain.dispose();
    this.water.dispose();
    this.props.dispose();
    this.structures.dispose();
    this.villagers.dispose();
    this.sky.dispose();
    this.weather.dispose();
    this.trails.dispose();
    this.smoke.dispose();
    this.groundDetail.dispose();
    this.brushRing.geometry.dispose();
    this.brushFill.geometry.dispose();
    this.renderer.dispose();
  }
}

function createBrush(): { group: Group; ring: Mesh; fill: Mesh } {
  const group = new Group();
  group.name = 'sculpt-brush';

  const fill = new Mesh(
    new CircleGeometry(1, 28).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({
      color: 0x9fe8ff,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: DoubleSide,
    }),
  );
  group.add(fill);

  const ring = new Mesh(
    new RingGeometry(0.9, 1, 28).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({
      color: 0x9fe8ff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
    }),
  );
  ring.renderOrder = 6;
  group.add(ring);

  return { group, ring, fill };
}

function rebuildBrushGeometry(ring: Mesh, fill: Mesh, radius: number): void {
  // The sculpt brush covers a disc of cells, so the ring is drawn at the
  // radius the stroke actually reaches rather than a nominal one.
  const reach = radius + 0.5;
  ring.geometry.dispose();
  ring.geometry = new RingGeometry(reach - 0.14, reach, 40).rotateX(-Math.PI / 2);
  fill.geometry.dispose();
  fill.geometry = new CircleGeometry(reach, 40).rotateX(-Math.PI / 2);
}
