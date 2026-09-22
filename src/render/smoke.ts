/**
 * Smoke from the chimneys and the hearth.
 *
 * Voxel puffs rather than soft sprites, so it belongs to the same world as
 * everything else. Only houses with somebody living in them smoke, which means
 * the skyline quietly tells you how full the village is.
 */
import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
} from 'three';
import { Rng } from '../core/rng';
import { StructureRegistry } from '../build/structures';
import { BoxBuilder } from './voxelBuilder';

const MAX_PUFFS = 150;

export interface SmokeSource {
  x: number;
  y: number;
  z: number;
  /** Puffs per second. */
  rate: number;
  /** Starting puff size. */
  size: number;
}

interface Puff {
  x: number;
  y: number;
  z: number;
  age: number;
  life: number;
  size: number;
  driftX: number;
  driftZ: number;
  spin: number;
}

export class SmokeRenderer {
  readonly mesh: InstancedMesh;
  private dummy = new Object3D();
  private alphas: InstancedBufferAttribute;
  private puffs: Puff[] = [];
  private rng = new Rng('smoke');
  private spawnCredit = 0;
  private sources: SmokeSource[] = [];
  private sourceTimer = 0;
  private tint = new Color();

  constructor(private registry: StructureRegistry) {
    const geometry = new BoxBuilder().add(0, 0, 0, 1, 1, 1, 0xffffff, { flat: true }).build();

    const alphas = new Float32Array(MAX_PUFFS);
    this.alphas = new InstancedBufferAttribute(alphas, 1);
    this.alphas.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aAlpha', this.alphas);

    const material = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n attribute float aAlpha;\n varying float vAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vAlpha = aAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n varying float vAlpha;')
        .replace(
          '#include <dithering_fragment>',
          '#include <dithering_fragment>\n gl_FragColor.a *= vAlpha;',
        );
    };
    material.customProgramCacheKey = () => 'smoke-puff';

    this.mesh = new InstancedMesh(geometry, material, MAX_PUFFS);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'smoke';
  }

  /**
   * `night` darkens the puffs so they read against a dark sky, and `wind`
   * comes from the same drift the clouds use so the whole sky agrees.
   */
  update(dt: number, night: number, wind: number): void {
    this.refreshSources(dt);
    this.spawn(dt);
    this.step(dt, wind);
    this.write(night);
  }

  /** Chimneys move only when something is built, so rescan on a timer. */
  private refreshSources(dt: number): void {
    this.sourceTimer -= dt;
    if (this.sourceTimer > 0) return;
    this.sourceTimer = 2;

    this.sources = [];
    for (const structure of this.registry.completed) {
      if (structure.defId === 'cottage' || structure.defId === 'longhouse') {
        // An empty house has a cold chimney.
        if (structure.residents.length === 0) continue;
        const wallHeight = structure.defId === 'cottage' ? 1.35 : 1.7;
        const inset = 0.35;
        this.sources.push({
          x: structure.x + structure.width / 2 + (structure.width - inset) / 2 - 0.45,
          y: structure.y + 0.1 + wallHeight + 1.05,
          z: structure.z + structure.depth / 2 - 0.6,
          rate: 1.1 + structure.residents.length * 0.2,
          size: 0.17,
        });
      } else if (structure.defId === 'hearth') {
        this.sources.push({
          x: structure.x + 1,
          y: structure.y + 0.9,
          z: structure.z + 1,
          rate: 3,
          size: 0.2,
        });
      }
    }
  }

  private spawn(dt: number): void {
    if (this.sources.length === 0) return;
    let totalRate = 0;
    for (const source of this.sources) totalRate += source.rate;

    this.spawnCredit += totalRate * dt;
    while (this.spawnCredit >= 1 && this.puffs.length < MAX_PUFFS) {
      this.spawnCredit -= 1;
      const source = this.rng.weighted(this.sources, this.sources.map((s) => s.rate));
      this.puffs.push({
        x: source.x + this.rng.range(-0.06, 0.06),
        y: source.y,
        z: source.z + this.rng.range(-0.06, 0.06),
        age: 0,
        life: this.rng.range(3.4, 5.6),
        size: source.size * this.rng.range(0.8, 1.2),
        driftX: this.rng.range(-0.12, 0.12),
        driftZ: this.rng.range(-0.12, 0.12),
        spin: this.rng.range(-0.5, 0.5),
      });
    }
    // Credit does not bank up while the village is unwatched.
    if (this.spawnCredit > 2) this.spawnCredit = 2;
  }

  private step(dt: number, wind: number): void {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const puff = this.puffs[i];
      puff.age += dt;
      if (puff.age >= puff.life) {
        this.puffs.splice(i, 1);
        continue;
      }
      // Rising smoke slows and spreads as it cools.
      const t = puff.age / puff.life;
      puff.y += (0.75 - t * 0.35) * dt;
      puff.x += (puff.driftX + wind * 0.35) * dt * (0.4 + t);
      puff.z += puff.driftZ * dt * (0.4 + t);
    }
  }

  private write(night: number): void {
    const alphas = this.alphas.array as Float32Array;
    // Pale by day so it reads against the sky, darker at night against the stars.
    this.tint.setHex(0xdfe2e4).multiplyScalar(1 - night * 0.45);

    for (let i = 0; i < this.puffs.length; i++) {
      const puff = this.puffs[i];
      const t = puff.age / puff.life;
      this.dummy.position.set(puff.x, puff.y, puff.z);
      this.dummy.rotation.set(0, puff.spin * t * 2, 0);
      this.dummy.scale.setScalar(puff.size * (0.55 + t * 1.7));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.mesh.setColorAt(i, this.tint);
      // Bloom in quickly, thin out slowly.
      alphas[i] = Math.min(t * 6, 1) * (1 - t) * 0.4;
    }

    this.mesh.count = this.puffs.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alphas.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
  }
}
