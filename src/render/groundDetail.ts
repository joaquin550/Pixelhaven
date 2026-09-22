/**
 * Tufts of grass scattered over the open ground.
 *
 * Purely decorative: not simulated, not saved, and regenerated from the
 * terrain whenever it changes. Their job is to stop a large flat meadow
 * reading as a sheet of one colour, and to thin out where the village has worn
 * a path, so the trails look like bare earth rather than tinted grass.
 */
import { Color, DynamicDrawUsage, InstancedMesh, Object3D } from 'three';
import { Rng } from '../core/rng';
import { Occupancy, TRAIL_THRESHOLD, TerrainType, WORLD_SIZE, index } from '../world/constants';
import { Terrain } from '../world/terrain';
import { BoxBuilder } from './voxelBuilder';
import { createSeasonMaterial } from './seasonMaterial';

const MAX_TUFTS = 1400;
/** Share of eligible cells that get a tuft. */
const COVERAGE = 0.34;
const REFRESH_INTERVAL = 3;

export class GroundDetailRenderer {
  readonly mesh: InstancedMesh;
  private dummy = new Object3D();
  private tint = new Color();
  private timer = 0;
  private lastRevision = -1;

  constructor(private terrain: Terrain) {
    // Two leaning blades, which is enough silhouette at the distance these are
    // ever seen from and keeps the whole meadow under fifty thousand triangles.
    const builder = new BoxBuilder();
    builder.add(0, 0.11, 0, 0.07, 0.22, 0.07, 0xffffff, { rotY: 0.3, season: 1, snow: 0.9 });
    builder.add(0.09, 0.08, 0.05, 0.06, 0.17, 0.06, 0xffffff, { rotY: -0.5, season: 1, snow: 0.9 });

    const material = createSeasonMaterial({
      vertexColors: true,
      seasonAttribute: true,
      seasonResponse: 1,
      blendScale: 0.85,
      snowOnTop: true,
    });

    this.mesh = new InstancedMesh(builder.build(), material, MAX_TUFTS);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'ground-detail';
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0 && this.terrain.revision === this.lastRevision) return;
    this.timer = REFRESH_INTERVAL;
    this.lastRevision = this.terrain.revision;
    this.rebuild();
  }

  private rebuild(): void {
    // Seeded, so a tuft stays exactly where it was across rebuilds instead of
    // the whole meadow twitching every few seconds.
    const rng = new Rng(`${this.terrain.seed}:tufts`);
    const { terrain } = this;
    let count = 0;

    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        const i = index(x, z);
        if (terrain.types[i] !== TerrainType.Grass) continue;

        // Roll for every eligible cell whether or not it is used, so the
        // pattern does not shift when a building or a path appears.
        const roll = rng.float();
        const offsetX = rng.range(0.15, 0.85);
        const offsetZ = rng.range(0.15, 0.85);
        const rotation = rng.range(0, Math.PI * 2);
        const scale = rng.range(0.8, 1.5);
        const shade = rng.range(-0.05, 0.05);

        if (roll > COVERAGE) continue;
        if (count >= MAX_TUFTS) return this.finish(count);
        if (terrain.occupancy[i] & (Occupancy.Structure | Occupancy.Prop)) continue;
        // Nothing grows where everybody walks.
        if (terrain.wear[i] >= TRAIL_THRESHOLD * 0.7) continue;

        this.dummy.position.set(x + offsetX, terrain.heights[i], z + offsetZ);
        this.dummy.rotation.set(0, rotation, 0);
        this.dummy.scale.setScalar(scale);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(count, this.dummy.matrix);

        this.tint.setHex(0x6fa34c).offsetHSL(shade * 0.3, shade, shade);
        this.mesh.setColorAt(count, this.tint);
        count++;
      }
    }
    this.finish(count);
  }

  private finish(count: number): void {
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
  }
}
