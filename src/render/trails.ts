/**
 * The paths villagers wear into the grass.
 *
 * Drawn as flat decals laid just above the ground rather than baked into the
 * terrain, for two reasons: re-meshing the island every time a cell darkened
 * would hitch, and a decal can fade in continuously, so a path arrives as a
 * thinning of the grass rather than popping into existence.
 */
import {
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Object3D,
  PlaneGeometry,
  MeshLambertMaterial,
} from 'three';
import { TRAIL_THRESHOLD, WORLD_SIZE, index } from '../world/constants';
import { Terrain } from '../world/terrain';


const MAX_TRAIL_CELLS = 2400;
/** Rebuilding the instance list is a whole-island scan, so do it on a timer. */
const REFRESH_INTERVAL = 0.6;

export class TrailRenderer {
  readonly mesh: InstancedMesh;
  private dummy = new Object3D();
  private alphas: InstancedBufferAttribute;
  private timer = 0;
  // Trodden earth showing through grass, not a mud puddle. Lambert shades
  // it down in the shadows, so it starts light.
  private colour = new Color(0x93815f);

  constructor(private terrain: Terrain) {
    const geometry = new PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);

    // Per-instance opacity, so each patch fades in with its own footfall.
    const alphas = new Float32Array(MAX_TRAIL_CELLS);
    this.alphas = new InstancedBufferAttribute(alphas, 1);
    this.alphas.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aAlpha', this.alphas);

    const material = new MeshLambertMaterial({
      map: createScuffTexture(),
      transparent: true,
      depthWrite: false,
      // Decals sit a hair above the ground; the offset keeps them from
      // fighting the terrain for the same depth values.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
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
    material.customProgramCacheKey = () => 'trail-decal';

    this.mesh = new InstancedMesh(geometry, material, MAX_TRAIL_CELLS);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'trails';
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = REFRESH_INTERVAL;
    this.rebuild();
  }

  private rebuild(): void {
    const { terrain } = this;
    const alphas = this.alphas.array as Float32Array;
    let count = 0;

    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        if (count >= MAX_TRAIL_CELLS) break;
        const wear = terrain.wear[index(x, z)];
        if (wear < TRAIL_THRESHOLD) continue;
        if (!terrain.isLand(x, z)) continue;

        this.dummy.position.set(x + 0.5, terrain.heightAt(x, z) + 0.015, z + 0.5);
        // A touch of rotation variety so a long trail does not read as tiling.
        this.dummy.rotation.set(0, ((x * 7 + z * 13) % 4) * (Math.PI / 2), 0);
        // Generously oversized so neighbouring cells overlap into one ribbon
        // instead of a dotted line of separate scuffs.
        this.dummy.scale.setScalar(1.55);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(count, this.dummy.matrix);
        this.mesh.setColorAt(count, this.colour);

        // Ramp from the threshold up, so a new path arrives gently.
        alphas[count] = Math.min(0.5, ((wear - TRAIL_THRESHOLD) / (1 - TRAIL_THRESHOLD)) * 0.55 + 0.08);
        count++;
      }
    }

    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alphas.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
  }
}

/**
 * A scuffed patch with soft edges, so neighbouring cells melt together into
 * one trail instead of reading as a row of tiles.
 */
function createScuffTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.52);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  // Scatter a few darker flecks: loose earth and small stones.
  ctx.globalCompositeOperation = 'destination-in';
  ctx.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.12})`;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
