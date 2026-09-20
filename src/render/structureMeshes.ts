/**
 * Buildings.
 *
 * Each structure is assembled from boxes into two meshes: a lit one, and an
 * unlit "glow" one for windows, fire and lanterns. The glow mesh is what makes
 * the haven read as inhabited after dark, for the price of a MeshBasicMaterial.
 *
 * While a structure is going up its lit mesh is clipped at the current build
 * height, so it genuinely rises out of the ground rather than popping in.
 */
import {
  BoxGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Vector3,
} from 'three';
import { clamp01 } from '../core/mathx';
import { BLUEPRINT_BY_ID } from '../build/blueprints';
import { Structure, StructureRegistry } from '../build/structures';
import { BUILD } from './palette';
import { BoxBuilder } from './voxelBuilder';
import { createSeasonMaterial } from './seasonMaterial';

interface StructureView {
  group: Group;
  lit?: Mesh;
  glow?: Mesh;
  ghost?: LineSegments;
  clip?: Plane;
  signature: string;
  /** Local-space height of the finished building, for the clip plane. */
  height: number;
  /** Glow parts that flicker (hearths, lanterns). */
  flickers: boolean;
}

const GHOST_MATERIAL = new LineBasicMaterial({
  color: BUILD.ghost,
  transparent: true,
  opacity: 0.85,
  depthTest: true,
});

export class StructureRenderer {
  readonly group = new Group();
  private views = new Map<number, StructureView>();
  private revision = -1;
  private glowMaterial = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  private litMaterial = createSeasonMaterial({
    vertexColors: true,
    seasonAttribute: true,
    seasonResponse: 0.25,
    blendScale: 0.25,
    snowOnTop: true,
  });

  constructor(private registry: StructureRegistry) {
    this.group.name = 'structures';
    this.sync();
  }

  syncIfStale(): boolean {
    if (this.registry.revision === this.revision) return false;
    this.sync();
    return true;
  }

  private sync(): void {
    const seen = new Set<number>();

    for (const structure of this.registry.structures) {
      seen.add(structure.id);
      const signature = signatureFor(structure);
      let view = this.views.get(structure.id);

      if (!view || view.signature !== signature) {
        if (view) this.disposeView(view);
        view = this.createView(structure, signature);
        this.views.set(structure.id, view);
      }
      this.updateClip(structure, view);
    }

    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      this.disposeView(view);
      this.views.delete(id);
    }

    this.revision = this.registry.revision;
  }

  private createView(structure: Structure, signature: string): StructureView {
    const group = new Group();
    group.position.set(structure.x, structure.y, structure.z);
    this.group.add(group);

    const def = BLUEPRINT_BY_ID.get(structure.defId);
    const lit = new BoxBuilder();
    const glow = new BoxBuilder();
    const height = buildStructure(structure, lit, glow);

    const view: StructureView = {
      group,
      signature,
      height,
      flickers: structure.defId === 'hearth' || structure.defId === 'lantern',
    };

    if (!lit.isEmpty) {
      view.lit = new Mesh(lit.build(), this.litMaterial);
      view.lit.castShadow = true;
      view.lit.receiveShadow = true;
      group.add(view.lit);
    }
    if (!glow.isEmpty) {
      view.glow = new Mesh(glow.build(), this.glowMaterial);
      group.add(view.glow);
    }

    // A cyan cage marks out anything not yet finished.
    if (structure.state !== 'complete' && def) {
      const box = new BoxGeometry(def.width, Math.max(0.6, height), def.depth);
      const ghost = new LineSegments(new EdgesGeometry(box), GHOST_MATERIAL);
      ghost.position.set(def.width / 2, Math.max(0.6, height) / 2, def.depth / 2);
      box.dispose();
      group.add(ghost);
      view.ghost = ghost;
    }

    return view;
  }

  /** Reveals a building from the ground up as villagers work on it. */
  private updateClip(structure: Structure, view: StructureView): void {
    if (!view.lit) return;
    if (structure.state === 'complete') {
      if (view.lit.material !== this.litMaterial || this.litMaterial.clippingPlanes) {
        view.lit.material = this.litMaterial;
      }
      view.lit.visible = true;
      if (view.glow) view.glow.visible = true;
      return;
    }

    const fraction = this.registry.buildFraction(structure);
    if (structure.state === 'blueprint') {
      view.lit.visible = false;
      if (view.glow) view.glow.visible = false;
      return;
    }

    view.lit.visible = true;
    if (view.glow) view.glow.visible = fraction > 0.92;

    if (!view.clip) {
      view.clip = new Plane(new Vector3(0, -1, 0), 0);
      // Each in-progress building needs its own material instance so it can
      // carry its own clipping plane.
      const material = createSeasonMaterial({
        vertexColors: true,
        seasonAttribute: true,
        seasonResponse: 0.25,
        blendScale: 0.25,
        snowOnTop: true,
      });
      material.clippingPlanes = [view.clip];
      material.clipShadows = true;
      view.lit.material = material;
    }
    view.clip.constant = structure.y + 0.08 + clamp01(fraction) * view.height;
  }

  /** Per-frame animation: firelight flicker and window glow. */
  update(time: number, night: number): void {
    for (const [id, view] of this.views) {
      if (!view.flickers || !view.glow) continue;
      const structure = this.registry.byId(id);
      if (!structure || structure.state !== 'complete') continue;
      const flicker = 0.92 + Math.sin(time * 7.3 + id * 2.1) * 0.05 + Math.sin(time * 11.7 + id) * 0.03;
      view.glow.scale.setScalar(flicker);
    }
    this.glowMaterial.opacity = 1;
    // Windows and fire read brighter once the sun is down.
    this.glowMaterial.color.setScalar(0.82 + night * 0.18);
  }

  /** World-space positions of light sources, for the scene's point lights. */
  lightSources(): { x: number; y: number; z: number; strength: number }[] {
    const sources: { x: number; y: number; z: number; strength: number }[] = [];
    for (const structure of this.registry.completed) {
      if (structure.defId === 'hearth') {
        sources.push({
          x: structure.x + structure.width / 2,
          y: structure.y + 1.1,
          z: structure.z + structure.depth / 2,
          strength: 1,
        });
      } else if (structure.defId === 'lantern') {
        sources.push({ x: structure.x + 0.5, y: structure.y + 1.9, z: structure.z + 0.5, strength: 0.55 });
      } else if (structure.defId === 'cottage' || structure.defId === 'longhouse') {
        sources.push({
          x: structure.x + structure.width / 2,
          y: structure.y + 1.1,
          z: structure.z + structure.depth / 2,
          strength: 0.4,
        });
      }
    }
    return sources;
  }

  private disposeView(view: StructureView): void {
    this.group.remove(view.group);
    view.lit?.geometry.dispose();
    view.glow?.geometry.dispose();
    view.ghost?.geometry.dispose();
    if (view.lit && view.lit.material !== this.litMaterial) {
      (view.lit.material as { dispose(): void }).dispose();
    }
    view.group.clear();
  }

  dispose(): void {
    for (const view of this.views.values()) this.disposeView(view);
    this.views.clear();
    this.litMaterial.dispose();
    this.glowMaterial.dispose();
  }
}

/** Rebuild key: geometry only changes when one of these does. */
function signatureFor(structure: Structure): string {
  const cropBucket = Math.round(structure.crop * 5);
  return `${structure.defId}|${structure.state}|${cropBucket}|${structure.y}`;
}

/* ------------------------------------------------------------ geometry */

/**
 * Builds a structure into the two supplied builders.
 * Local origin is the footprint's corner; returns the finished height.
 */
function buildStructure(structure: Structure, lit: BoxBuilder, glow: BoxBuilder): number {
  switch (structure.defId) {
    case 'cottage':
      return buildHouse(lit, glow, 3, 3, 1.35, BUILD.plaster, BUILD.thatch, BUILD.thatchDark);
    case 'longhouse':
      return buildHouse(lit, glow, 4, 4, 1.7, BUILD.plaster, BUILD.roofTile, BUILD.roofTileDark);
    case 'barn':
      return buildBarn(lit, glow);
    case 'workshop':
      return buildWorkshop(lit, glow);
    case 'farm':
      return buildFarm(lit, structure.crop, structure.state === 'complete');
    case 'dock':
      return buildDock(lit, structure);
    case 'hearth':
      return buildHearth(lit, glow);
    case 'well':
      return buildWell(lit);
    case 'shrine':
      return buildShrine(lit, glow);
    case 'bridge':
      return buildBridge(lit);
    case 'path':
      return buildPath(lit);
    case 'lantern':
      return buildLantern(lit, glow);
    default:
      lit.addFromBase(0.5, 0, 0.5, 0.8, 0.8, 0.8, BUILD.timber, { season: 0.2 });
      return 0.8;
  }
}

function buildHouse(
  lit: BoxBuilder,
  glow: BoxBuilder,
  w: number,
  d: number,
  wallHeight: number,
  wallColor: number,
  roofColor: number,
  roofDark: number,
): number {
  const cx = w / 2;
  const cz = d / 2;
  const inset = 0.35;

  // Stone footing, so houses sit into the ground rather than on it.
  lit.addFromBase(cx, -0.1, cz, w - 0.1, 0.25, d - 0.1, BUILD.stone, { season: 0.1, snow: 0.3 });

  // Walls.
  lit.addFromBase(cx, 0.1, cz, w - inset, wallHeight, d - inset, wallColor, { season: 0.05, snow: 0.2 });

  // Corner posts and a beam, for the half-timbered look.
  const px = (w - inset) / 2 - 0.08;
  const pz = (d - inset) / 2 - 0.08;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    lit.addFromBase(cx + sx * px, 0.1, cz + sz * pz, 0.22, wallHeight, 0.22, BUILD.timberDark, { season: 0.1 });
  }
  lit.addFromBase(cx, 0.1 + wallHeight - 0.12, cz, w - inset + 0.06, 0.16, d - inset + 0.06, BUILD.timber, {
    season: 0.1,
  });

  // Stepped hip roof. Five shrinking slabs rather than three: seen from the
  // usual high angle a shallow roof just reads as a flat lid, and the whole
  // village ends up looking like a set of tables.
  let roofY = 0.1 + wallHeight;
  const sizes = [1, 0.78, 0.57, 0.37, 0.18];
  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i];
    lit.addFromBase(
      cx,
      roofY,
      cz,
      (w + 0.5) * size,
      0.3,
      (d + 0.5) * size,
      i % 2 === 0 ? roofColor : roofDark,
      { season: 0.15, snow: 1 },
    );
    roofY += 0.26;
  }

  // Chimney with a little smoke-stained cap.
  const chimneyX = cx + (w - inset) / 2 - 0.45;
  lit.addFromBase(chimneyX, 0.1 + wallHeight - 0.2, cz - 0.6, 0.42, 1.15, 0.42, BUILD.stone, {
    season: 0.05,
    snow: 0.8,
  });
  lit.addFromBase(chimneyX, 0.1 + wallHeight + 0.9, cz - 0.6, 0.52, 0.14, 0.52, BUILD.stoneDark, { season: 0 });

  // Door on the +Z face.
  lit.addFromBase(cx, 0.1, d - inset / 2 - 0.02, 0.62, 0.95, 0.12, BUILD.timberDark, { season: 0 });
  lit.addFromBase(cx + 0.2, 0.62, d - inset / 2 - 0.09, 0.09, 0.09, 0.09, 0xd8c07a, { season: 0, flat: true });

  // Windows glow from inside.
  const windowY = 0.62;
  glow.addFromBase(cx - 0.85, windowY, d - inset / 2 - 0.02, 0.44, 0.44, 0.1, BUILD.window, { flat: true });
  glow.addFromBase(cx + 0.85, windowY, d - inset / 2 - 0.02, 0.44, 0.44, 0.1, BUILD.window, { flat: true });
  glow.addFromBase(inset / 2 + 0.02, windowY, cz, 0.1, 0.44, 0.44, BUILD.window, { flat: true });

  return roofY + 0.2;
}

function buildBarn(lit: BoxBuilder, glow: BoxBuilder): number {
  const w = 3;
  const d = 3;
  lit.addFromBase(1.5, -0.1, 1.5, w - 0.1, 0.22, d - 0.1, BUILD.stone, { season: 0.1 });
  lit.addFromBase(1.5, 0.1, 1.5, w - 0.3, 1.5, d - 0.3, BUILD.timber, { season: 0.1, snow: 0.2 });
  // Gambrel roof: a steep lower slope and a shallow cap, faked with slabs.
  lit.addFromBase(1.5, 1.6, 1.5, w + 0.35, 0.3, d + 0.35, BUILD.roofTileDark, { season: 0.12, snow: 1 });
  lit.addFromBase(1.5, 1.88, 1.5, w - 0.2, 0.3, d - 0.2, BUILD.roofTile, { season: 0.12, snow: 1 });
  lit.addFromBase(1.5, 2.16, 1.5, w - 1.0, 0.3, d - 1.0, BUILD.roofTileDark, { season: 0.12, snow: 1 });
  lit.addFromBase(1.5, 2.42, 1.5, w - 1.9, 0.28, d - 1.9, BUILD.roofTile, { season: 0.12, snow: 1 });
  // Big double doors.
  lit.addFromBase(1.5, 0.1, d - 0.16, 1.3, 1.25, 0.12, BUILD.timberDark, { season: 0 });
  lit.addFromBase(1.5, 0.1, d - 0.12, 0.08, 1.25, 0.08, BUILD.plank, { season: 0 });
  glow.addFromBase(1.5, 1.72, d - 0.2, 0.34, 0.3, 0.1, BUILD.window, { flat: true });
  return 2.8;
}

function buildWorkshop(lit: BoxBuilder, glow: BoxBuilder): number {
  lit.addFromBase(1.5, -0.1, 1.5, 2.9, 0.22, 2.9, BUILD.stone, { season: 0.1 });
  lit.addFromBase(1.4, 0.1, 1.4, 2.4, 1.35, 2.4, BUILD.plaster, { season: 0.05, snow: 0.2 });
  // Lean-to roof: slabs stepped along one axis.
  for (let i = 0; i < 4; i++) {
    lit.addFromBase(1.5, 1.45 + i * 0.16, 0.6 + i * 0.55, 3.1, 0.2, 0.75, i % 2 ? BUILD.plank : BUILD.timber, {
      season: 0.12,
      snow: 1,
    });
  }
  // Workbench and a sawhorse outside, so it looks used.
  lit.addFromBase(0.45, 0.1, 2.5, 0.8, 0.55, 0.45, BUILD.timber, { season: 0.1 });
  lit.addFromBase(2.5, 0.1, 2.55, 0.5, 0.42, 0.28, BUILD.timberDark, { season: 0.1, rotY: 0.4 });
  glow.addFromBase(1.4, 0.65, 0.22, 0.6, 0.45, 0.1, BUILD.window, { flat: true });
  return 2.3;
}

function buildFarm(lit: BoxBuilder, crop: number, complete: boolean): number {
  // Tilled soil in rows.
  for (let row = 0; row < 3; row++) {
    lit.addFromBase(1.5, -0.05, row + 0.5, 2.85, 0.18, 0.72, BUILD.soil, { season: 0.4, snow: 0.5 });
  }
  if (!complete) return 0.35;

  // Crops grow taller and turn gold as they ripen.
  const height = 0.12 + crop * 0.52;
  const ripe = crop >= 1;
  const color = ripe ? BUILD.cropRipe : BUILD.crop;
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 4; i++) {
      const x = 0.45 + i * 0.7;
      lit.addFromBase(x, 0.12, row + 0.5, 0.2, height, 0.2, color, { season: ripe ? 0.2 : 0.8, snow: 0.3 });
    }
  }
  // A scarecrow once there is something worth guarding.
  if (crop > 0.4) {
    lit.addFromBase(2.6, 0.12, 0.4, 0.09, 0.9, 0.09, BUILD.timberDark, { season: 0 });
    lit.addFromBase(2.6, 0.72, 0.4, 0.62, 0.08, 0.08, BUILD.timberDark, { season: 0 });
    lit.addFromBase(2.6, 0.95, 0.4, 0.26, 0.26, 0.26, BUILD.thatch, { season: 0.3 });
  }
  return 1.3;
}

function buildDock(lit: BoxBuilder, structure: Structure): number {
  const w = structure.width;
  const d = structure.depth;
  // Planking.
  for (let z = 0; z < d; z++) {
    lit.addFromBase(w / 2, 0.05, z + 0.5, w - 0.1, 0.14, 0.85, z % 2 ? BUILD.plank : BUILD.timber, {
      season: 0.1,
      snow: 0.6,
    });
  }
  // Posts down into the water.
  for (const [px, pz] of [[0.25, 0.25], [w - 0.25, 0.25], [0.25, d - 0.25], [w - 0.25, d - 0.25]] as const) {
    lit.addFromBase(px, -1.3, pz, 0.18, 1.4, 0.18, BUILD.timberDark, { season: 0.05 });
  }
  // A crate and a coil of rope at the landward end.
  lit.addFromBase(w - 0.45, 0.19, 0.45, 0.42, 0.42, 0.42, BUILD.timber, { season: 0.1, rotY: 0.3 });
  lit.addFromBase(0.4, 0.19, d - 0.5, 0.34, 0.12, 0.34, BUILD.thatchDark, { season: 0.1 });
  return 0.6;
}

function buildHearth(lit: BoxBuilder, glow: BoxBuilder): number {
  // Ring of stones.
  const cx = 1;
  const cz = 1;
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    lit.addFromBase(
      cx + Math.cos(angle) * 0.72,
      0,
      cz + Math.sin(angle) * 0.72,
      0.36,
      0.28,
      0.36,
      i % 2 ? BUILD.stone : BUILD.stoneDark,
      { rotY: angle, season: 0.08, snow: 0.7 },
    );
  }
  // Crossed logs.
  lit.addFromBase(cx, 0.1, cz, 0.85, 0.16, 0.16, BUILD.timberDark, { rotY: 0.6, season: 0.05 });
  lit.addFromBase(cx, 0.24, cz, 0.85, 0.16, 0.16, BUILD.timber, { rotY: -0.7, season: 0.05 });
  // Benches, because a fire wants somewhere to sit.
  lit.addFromBase(cx, 0.05, cz + 1.55, 1.2, 0.26, 0.28, BUILD.timber, { season: 0.1, snow: 0.5 });
  lit.addFromBase(cx, 0.05, cz - 1.55, 1.2, 0.26, 0.28, BUILD.timber, { season: 0.1, snow: 0.5 });
  // Flames.
  glow.addFromBase(cx, 0.3, cz, 0.42, 0.52, 0.42, BUILD.fire, { flat: true });
  glow.addFromBase(cx, 0.75, cz, 0.22, 0.3, 0.22, 0xffd27a, { flat: true });
  return 1.1;
}

function buildWell(lit: BoxBuilder): number {
  const cx = 1;
  const cz = 1;
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    lit.addFromBase(
      cx + Math.cos(angle) * 0.6,
      0,
      cz + Math.sin(angle) * 0.6,
      0.34,
      0.62,
      0.34,
      i % 2 ? BUILD.stone : BUILD.stoneDark,
      { rotY: angle, season: 0.06, snow: 0.6 },
    );
  }
  lit.addFromBase(cx, 0.1, cz, 0.85, 0.06, 0.85, 0x2d4a58, { season: 0, flat: true });
  lit.addFromBase(cx - 0.5, 0.62, cz, 0.14, 1.0, 0.14, BUILD.timber, { season: 0.08 });
  lit.addFromBase(cx + 0.5, 0.62, cz, 0.14, 1.0, 0.14, BUILD.timber, { season: 0.08 });
  // A small stepped canopy, not a tabletop.
  lit.addFromBase(cx, 1.58, cz, 1.35, 0.18, 1.1, BUILD.thatch, { season: 0.2, snow: 1 });
  lit.addFromBase(cx, 1.74, cz, 0.95, 0.18, 0.78, BUILD.thatchDark, { season: 0.2, snow: 1 });
  lit.addFromBase(cx, 1.9, cz, 0.5, 0.18, 0.42, BUILD.thatch, { season: 0.2, snow: 1 });
  lit.addFromBase(cx, 1.1, cz, 0.28, 0.3, 0.28, BUILD.timberDark, { season: 0 });
  return 2.0;
}

function buildShrine(lit: BoxBuilder, glow: BoxBuilder): number {
  const cx = 1;
  const cz = 1;
  lit.addFromBase(cx, -0.06, cz, 1.9, 0.2, 1.9, BUILD.stone, { season: 0.08, snow: 0.7 });
  lit.addFromBase(cx, 0.14, cz, 1.35, 0.22, 1.35, BUILD.stoneDark, { season: 0.08, snow: 0.7 });
  // Three standing stones of different heights.
  lit.addFromBase(cx - 0.5, 0.3, cz - 0.35, 0.3, 1.25, 0.3, BUILD.stone, { rotY: 0.2, season: 0.06, snow: 0.8 });
  lit.addFromBase(cx + 0.45, 0.3, cz - 0.2, 0.28, 0.95, 0.28, BUILD.stone, { rotY: -0.3, season: 0.06, snow: 0.8 });
  lit.addFromBase(cx, 0.3, cz + 0.5, 0.34, 1.5, 0.34, BUILD.stoneDark, { season: 0.06, snow: 0.8 });
  // Offerings and a small flame.
  lit.addFromBase(cx - 0.1, 0.36, cz - 0.05, 0.3, 0.1, 0.3, BUILD.timber, { season: 0.2 });
  glow.addFromBase(cx, 1.85, cz + 0.5, 0.24, 0.28, 0.24, 0xbfe4ff, { flat: true });
  return 2.1;
}

function buildBridge(lit: BoxBuilder): number {
  lit.addFromBase(0.5, 0.0, 0.5, 0.95, 0.16, 0.95, BUILD.plank, { season: 0.1, snow: 0.6 });
  lit.addFromBase(0.06, 0.14, 0.5, 0.1, 0.4, 0.9, BUILD.timberDark, { season: 0.05 });
  lit.addFromBase(0.94, 0.14, 0.5, 0.1, 0.4, 0.9, BUILD.timberDark, { season: 0.05 });
  lit.addFromBase(0.5, -0.9, 0.5, 0.14, 1.0, 0.14, BUILD.timberDark, { season: 0.05 });
  return 0.6;
}

function buildPath(lit: BoxBuilder): number {
  // Four cobbles, slightly offset, so a run of path has texture.
  const cobbles: [number, number, number][] = [
    [0.28, 0.28, 0.4],
    [0.72, 0.3, 0.36],
    [0.32, 0.72, 0.34],
    [0.7, 0.7, 0.42],
  ];
  for (const [x, z, size] of cobbles) {
    lit.addFromBase(x, 0, z, size, 0.1, size, BUILD.stone, { rotY: x * 6, season: 0.1, snow: 0.8 });
  }
  lit.addFromBase(0.5, 0, 0.5, 0.98, 0.06, 0.98, BUILD.stoneDark, { season: 0.1, snow: 0.6 });
  return 0.16;
}

function buildLantern(lit: BoxBuilder, glow: BoxBuilder): number {
  lit.addFromBase(0.5, 0, 0.5, 0.36, 0.18, 0.36, BUILD.stone, { season: 0.08, snow: 0.6 });
  lit.addFromBase(0.5, 0.16, 0.5, 0.14, 1.5, 0.14, BUILD.timberDark, { season: 0.05 });
  lit.addFromBase(0.5, 1.62, 0.5, 0.42, 0.08, 0.42, BUILD.timber, { season: 0.1, snow: 1 });
  glow.addFromBase(0.5, 1.3, 0.5, 0.3, 0.34, 0.3, BUILD.lantern, { flat: true });
  return 1.85;
}

