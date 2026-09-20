/**
 * Trees, boulders, bushes and the rest of the flora.
 *
 * Every prop kind is one InstancedMesh, so a forest of several hundred trees
 * costs a handful of draw calls. Trunks and foliage are separate instanced
 * meshes sharing the same transforms, which lets autumn recolour the leaves
 * without staining the bark.
 */
import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Object3D,
} from 'three';
import { Rng } from '../core/rng';
import { Prop, PropKind, PropRegistry } from '../world/props';
import { BoxBuilder } from './voxelBuilder';
import { createSeasonMaterial } from './seasonMaterial';

const BARK = { pine: 0x5a4028, oak: 0x6b4b2c, birch: 0xd8d2c4, palm: 0x7a5c37 };
const FOLIAGE_BASE = 0xffffff; // Tinted per instance and per season.

interface KindMeshes {
  trunk?: InstancedMesh;
  foliage?: InstancedMesh;
  solid?: InstancedMesh;
  count: number;
}

/** How strongly each kind's leaves turn with the season. */
const SEASON_RESPONSE: Partial<Record<PropKind, number>> = {
  pine: 0.22,
  oak: 1,
  birch: 1,
  palm: 0.45,
  bush: 0.85,
  flower: 0.7,
  reed: 0.6,
  mushroom: 0.2,
};

export class PropRenderer {
  readonly group = new Group();
  private kinds = new Map<PropKind, KindMeshes>();
  private revision = -1;
  private dummy = new Object3D();
  private tint = new Color();

  constructor(private registry: PropRegistry) {
    this.group.name = 'props';
    this.rebuild();
  }

  syncIfStale(): boolean {
    if (this.registry.revision === this.revision) return false;
    this.rebuild();
    return true;
  }

  private rebuild(): void {
    // Group props by kind so each becomes one instanced draw.
    const byKind = new Map<PropKind, Prop[]>();
    for (const prop of this.registry.props) {
      const list = byKind.get(prop.kind);
      if (list) list.push(prop);
      else byKind.set(prop.kind, [prop]);
    }

    for (const [kind, props] of byKind) {
      let entry = this.kinds.get(kind);
      const needed = props.length;
      if (!entry || entry.count < needed) {
        // Grow in generous steps; reallocating an InstancedMesh per felled tree
        // would churn GPU buffers every few seconds.
        const capacity = Math.max(32, Math.ceil(needed * 1.35));
        entry = this.createKind(kind, capacity);
        this.kinds.set(kind, entry);
      }
      this.writeInstances(kind, entry, props);
    }

    // Kinds that vanished entirely.
    for (const [kind, entry] of this.kinds) {
      if (!byKind.has(kind)) this.setInstanceCount(entry, 0);
    }

    this.revision = this.registry.revision;
  }

  private setInstanceCount(entry: KindMeshes, count: number): void {
    if (entry.trunk) entry.trunk.count = count;
    if (entry.foliage) entry.foliage.count = count;
    if (entry.solid) entry.solid.count = count;
  }

  private createKind(kind: PropKind, capacity: number): KindMeshes {
    const previous = this.kinds.get(kind);
    if (previous) {
      for (const mesh of [previous.trunk, previous.foliage, previous.solid]) {
        if (!mesh) continue;
        this.group.remove(mesh);
        mesh.geometry.dispose();
      }
    }

    const parts = buildPropGeometry(kind);
    const entry: KindMeshes = { count: capacity };
    const response = SEASON_RESPONSE[kind] ?? 0.3;

    if (parts.trunk) {
      const material = createSeasonMaterial({
        vertexColors: true,
        seasonAttribute: true,
        seasonResponse: response * 0.25,
        blendScale: 0.2,
        snowOnTop: true,
      });
      entry.trunk = new InstancedMesh(parts.trunk, material, capacity);
      entry.trunk.castShadow = true;
      entry.trunk.receiveShadow = true;
      entry.trunk.instanceMatrix.setUsage(DynamicDrawUsage);
      this.group.add(entry.trunk);
    }

    if (parts.foliage) {
      const material = createSeasonMaterial({
        vertexColors: true,
        seasonAttribute: true,
        seasonResponse: response,
        // Leaves get the season's full authority - this is what actually turns
        // an oak orange in October.
        blendScale: 1,
        snowOnTop: true,
      });
      entry.foliage = new InstancedMesh(parts.foliage, material, capacity);
      entry.foliage.castShadow = true;
      entry.foliage.receiveShadow = true;
      entry.foliage.instanceMatrix.setUsage(DynamicDrawUsage);
      this.group.add(entry.foliage);
    }

    if (parts.solid) {
      const material = createSeasonMaterial({
        vertexColors: true,
        seasonAttribute: true,
        seasonResponse: response * 0.3,
        blendScale: 0.25,
        snowOnTop: true,
      });
      entry.solid = new InstancedMesh(parts.solid, material, capacity);
      entry.solid.castShadow = true;
      entry.solid.receiveShadow = true;
      entry.solid.instanceMatrix.setUsage(DynamicDrawUsage);
      this.group.add(entry.solid);
    }

    return entry;
  }

  private writeInstances(kind: PropKind, entry: KindMeshes, props: Prop[]): void {
    const rng = new Rng(`prop-tint:${kind}`);
    for (let i = 0; i < props.length; i++) {
      const prop = props[i];
      this.dummy.position.set(prop.x, prop.y, prop.z);
      this.dummy.rotation.set(0, prop.rotation, 0);
      const squash = prop.kind === 'bush' && prop.yield <= 0 ? 0.72 : 1;
      this.dummy.scale.setScalar(prop.scale * squash);
      this.dummy.updateMatrix();

      entry.trunk?.setMatrixAt(i, this.dummy.matrix);
      entry.solid?.setMatrixAt(i, this.dummy.matrix);

      if (entry.foliage) {
        entry.foliage.setMatrixAt(i, this.dummy.matrix);
        // Per-instance green so a grove is not one flat colour.
        const variation = rng.range(-0.06, 0.06);
        this.tint.setHex(baseFoliageColor(prop.kind));
        this.tint.offsetHSL(variation * 0.35, variation, variation * 0.6);
        if (prop.kind === 'bush' && prop.yield <= 0) this.tint.multiplyScalar(0.82);
        entry.foliage.setColorAt(i, this.tint);
      }
    }

    this.setInstanceCount(entry, props.length);
    if (entry.trunk) entry.trunk.instanceMatrix.needsUpdate = true;
    if (entry.solid) entry.solid.instanceMatrix.needsUpdate = true;
    if (entry.foliage) {
      entry.foliage.instanceMatrix.needsUpdate = true;
      if (entry.foliage.instanceColor) entry.foliage.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const entry of this.kinds.values()) {
      for (const mesh of [entry.trunk, entry.foliage, entry.solid]) {
        if (!mesh) continue;
        mesh.geometry.dispose();
        (mesh.material as { dispose(): void }).dispose();
      }
    }
    this.kinds.clear();
    this.group.clear();
  }
}

function baseFoliageColor(kind: PropKind): number {
  switch (kind) {
    case 'pine':
      return 0x3f6b42;
    case 'oak':
      return 0x598f3e;
    case 'birch':
      return 0x7aa845;
    case 'palm':
      return 0x4f9b55;
    case 'bush':
      return 0x497f3c;
    case 'flower':
      return 0xe4d36a;
    case 'reed':
      return 0x7d9a4c;
    case 'mushroom':
      return 0xc6604a;
    default:
      return 0x5a8a42;
  }
}

interface PropParts {
  trunk?: BufferGeometry;
  foliage?: BufferGeometry;
  solid?: BufferGeometry;
}

/** Hand-built box compositions, one per prop kind. */
function buildPropGeometry(kind: PropKind): PropParts {
  switch (kind) {
    case 'pine': {
      const trunk = new BoxBuilder().addFromBase(0, 0, 0, 0.26, 1.5, 0.26, BARK.pine, { season: 0.2 });
      const foliage = new BoxBuilder();
      foliage.addFromBase(0, 0.9, 0, 1.55, 0.72, 1.55, FOLIAGE_BASE, { season: 1, snow: 0.9 });
      foliage.addFromBase(0, 1.5, 0, 1.15, 0.68, 1.15, FOLIAGE_BASE, { season: 1, snow: 0.9 });
      foliage.addFromBase(0, 2.05, 0, 0.72, 0.62, 0.72, FOLIAGE_BASE, { season: 1, snow: 1 });
      return { trunk: trunk.build(), foliage: foliage.build() };
    }
    case 'oak': {
      const trunk = new BoxBuilder().addFromBase(0, 0, 0, 0.34, 1.35, 0.34, BARK.oak, { season: 0.2 });
      const foliage = new BoxBuilder();
      foliage.addFromBase(0, 1.15, 0, 1.75, 1.0, 1.75, FOLIAGE_BASE, { season: 1, snow: 0.8 });
      foliage.addFromBase(-0.45, 1.9, 0.3, 1.0, 0.62, 1.0, FOLIAGE_BASE, { season: 1, snow: 0.9 });
      foliage.addFromBase(0.5, 1.85, -0.25, 0.9, 0.55, 0.9, FOLIAGE_BASE, { season: 1, snow: 0.9 });
      return { trunk: trunk.build(), foliage: foliage.build() };
    }
    case 'birch': {
      const trunk = new BoxBuilder();
      trunk.addFromBase(0, 0, 0, 0.22, 2.0, 0.22, BARK.birch, { season: 0.1 });
      trunk.addFromBase(0, 0.7, 0, 0.24, 0.12, 0.24, 0x4a4438, { season: 0 });
      trunk.addFromBase(0, 1.3, 0, 0.24, 0.1, 0.24, 0x4a4438, { season: 0 });
      const foliage = new BoxBuilder();
      foliage.addFromBase(0, 1.8, 0, 1.3, 0.85, 1.3, FOLIAGE_BASE, { season: 1, snow: 0.85 });
      foliage.addFromBase(0.2, 2.5, -0.1, 0.8, 0.5, 0.8, FOLIAGE_BASE, { season: 1, snow: 0.9 });
      return { trunk: trunk.build(), foliage: foliage.build() };
    }
    case 'palm': {
      const trunk = new BoxBuilder();
      for (let i = 0; i < 5; i++) {
        // A gentle lean, built by offsetting each trunk segment.
        trunk.addFromBase(i * 0.07, i * 0.38, i * 0.03, 0.24, 0.4, 0.24, BARK.palm, { season: 0.15 });
      }
      const foliage = new BoxBuilder();
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2;
        foliage.add(
          0.35 + Math.cos(angle) * 0.62,
          2.0,
          0.15 + Math.sin(angle) * 0.62,
          1.15,
          0.14,
          0.4,
          FOLIAGE_BASE,
          { rotY: angle, season: 1, snow: 0.2 },
        );
      }
      return { trunk: trunk.build(), foliage: foliage.build() };
    }
    case 'boulder': {
      const solid = new BoxBuilder();
      solid.addFromBase(0, 0, 0, 1.25, 0.8, 1.15, 0x8b8c8f, { season: 0.1, snow: 1 });
      solid.addFromBase(0.22, 0.6, -0.18, 0.85, 0.55, 0.8, 0x9a9b9e, { rotY: 0.6, season: 0.1, snow: 1 });
      solid.addFromBase(-0.3, 0.35, 0.28, 0.6, 0.4, 0.55, 0x7e7f82, { rotY: -0.4, season: 0.1, snow: 1 });
      return { solid: solid.build() };
    }
    case 'rock': {
      const solid = new BoxBuilder();
      solid.addFromBase(0, 0, 0, 0.7, 0.4, 0.62, 0x8b8c8f, { season: 0.1, snow: 1 });
      solid.addFromBase(0.2, 0.25, 0.1, 0.42, 0.3, 0.4, 0x9a9b9e, { rotY: 0.8, season: 0.1, snow: 1 });
      return { solid: solid.build() };
    }
    case 'bush': {
      const foliage = new BoxBuilder();
      foliage.addFromBase(0, 0, 0, 0.9, 0.5, 0.85, FOLIAGE_BASE, { season: 1, snow: 0.8 });
      foliage.addFromBase(0.15, 0.4, -0.1, 0.55, 0.35, 0.5, FOLIAGE_BASE, { season: 1, snow: 0.8 });
      const solid = new BoxBuilder();
      // Berries, deliberately not season-tinted so ripe fruit stays readable.
      solid.addFromBase(-0.2, 0.3, 0.25, 0.14, 0.14, 0.14, 0xc0392b, { season: 0, flat: true });
      solid.addFromBase(0.3, 0.42, 0.12, 0.13, 0.13, 0.13, 0xd0453a, { season: 0, flat: true });
      return { foliage: foliage.build(), solid: solid.build() };
    }
    case 'flower': {
      const foliage = new BoxBuilder();
      foliage.addFromBase(0, 0, 0, 0.09, 0.3, 0.09, 0x6f8f43, { season: 0.8 });
      const solid = new BoxBuilder();
      solid.addFromBase(0, 0.28, 0, 0.22, 0.12, 0.22, 0xe8dc72, { season: 0.2, flat: true });
      return { foliage: foliage.build(), solid: solid.build() };
    }
    case 'reed': {
      const foliage = new BoxBuilder();
      foliage.addFromBase(-0.1, 0, 0.05, 0.07, 1.0, 0.07, FOLIAGE_BASE, { season: 0.8 });
      foliage.addFromBase(0.12, 0, -0.08, 0.07, 1.25, 0.07, FOLIAGE_BASE, { season: 0.8 });
      foliage.addFromBase(0.02, 0, 0.18, 0.07, 0.8, 0.07, FOLIAGE_BASE, { season: 0.8 });
      return { foliage: foliage.build() };
    }
    case 'mushroom': {
      const trunk = new BoxBuilder().addFromBase(0, 0, 0, 0.13, 0.22, 0.13, 0xe6dcc6, { season: 0 });
      const foliage = new BoxBuilder().addFromBase(0, 0.2, 0, 0.36, 0.14, 0.36, FOLIAGE_BASE, { season: 0.2 });
      return { trunk: trunk.build(), foliage: foliage.build() };
    }
    default: {
      const solid = new BoxBuilder().addFromBase(0, 0, 0, 0.5, 0.5, 0.5, 0x888888, { season: 0.3 });
      return { solid: solid.build() };
    }
  }
}
