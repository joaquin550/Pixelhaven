/**
 * Turns the height field into geometry.
 *
 * Because there are no overhangs, meshing is one top quad per column plus a
 * side quad wherever a neighbour sits lower - roughly a tenth of the triangles
 * a naive full-voxel mesher would emit, which is the difference between 60fps
 * and 25fps on an iPad.
 *
 * Top faces get classic voxel ambient occlusion from their eight neighbours,
 * which is what makes flat-shaded cubes read as a landscape rather than a
 * spreadsheet.
 */
import { BufferAttribute, BufferGeometry, Color, Group, Mesh } from 'three';
import { Terrain } from '../world/terrain';
import {
  CHUNKS_PER_SIDE,
  CHUNK_SIZE,
  WATER_LEVEL,
  WORLD_SIZE,
  index,
} from '../world/constants';
import { SEASON_RESPONSE, SIDE_COLORS, TOP_COLORS } from './palette';
import { createSeasonMaterial } from './seasonMaterial';

const scratch = new Color();

/** Deterministic per-cell brightness jitter so large flats are not flat. */
function cellShade(x: number, z: number): number {
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return 0.94 + (n - Math.floor(n)) * 0.12;
}

interface MeshBuffers {
  positions: number[];
  normals: number[];
  colors: number[];
  season: number[];
  indices: number[];
}

/**
 * Meshes one chunk of the island.
 *
 * Cells outside the chunk are still *read* - a side face and its ambient
 * occlusion depend on the neighbours - but only cells inside it emit geometry,
 * so chunks tile seamlessly.
 */
export function buildChunkGeometry(terrain: Terrain, chunkX: number, chunkZ: number): BufferGeometry {
  const buffers: MeshBuffers = { positions: [], normals: [], colors: [], season: [], indices: [] };
  const x0 = chunkX * CHUNK_SIZE;
  const z0 = chunkZ * CHUNK_SIZE;

  for (let z = z0; z < z0 + CHUNK_SIZE; z++) {
    for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
      const i = index(x, z);
      const h = terrain.heights[i];
      const type = terrain.types[i];
      const shade = cellShade(x, z);
      const response = SEASON_RESPONSE[type] ?? 0;

      emitTop(buffers, terrain, x, z, h, type, shade, response);

      // Side faces, one per direction where the neighbour is lower.
      emitSideIfExposed(buffers, terrain, x, z, h, type, shade, response, 1, 0);
      emitSideIfExposed(buffers, terrain, x, z, h, type, shade, response, -1, 0);
      emitSideIfExposed(buffers, terrain, x, z, h, type, shade, response, 0, 1);
      emitSideIfExposed(buffers, terrain, x, z, h, type, shade, response, 0, -1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(buffers.positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(buffers.normals), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(buffers.colors), 3));
  geometry.setAttribute('aSeason', new BufferAttribute(new Float32Array(buffers.season), 2));
  geometry.setIndex(buffers.indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/** The whole island in one geometry. Used by tests and benchmarks. */
export function buildTerrainGeometry(terrain: Terrain): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let cz = 0; cz < CHUNKS_PER_SIDE; cz++) {
    for (let cx = 0; cx < CHUNKS_PER_SIDE; cx++) parts.push(buildChunkGeometry(terrain, cx, cz));
  }
  return parts[0];
}

function emitTop(
  b: MeshBuffers,
  terrain: Terrain,
  x: number,
  z: number,
  h: number,
  type: number,
  shade: number,
  response: number,
): void {
  scratch.setHex(TOP_COLORS[type] ?? 0x888888).multiplyScalar(shade);

  // Voxel ambient occlusion: each corner darkens for every taller neighbour
  // touching it.
  const ao = [
    cornerAO(terrain, x, z, h, -1, -1),
    cornerAO(terrain, x, z, h, 1, -1),
    cornerAO(terrain, x, z, h, 1, 1),
    cornerAO(terrain, x, z, h, -1, 1),
  ];

  const base = b.positions.length / 3;
  const corners: [number, number][] = [
    [x, z],
    [x + 1, z],
    [x + 1, z + 1],
    [x, z + 1],
  ];

  for (let c = 0; c < 4; c++) {
    b.positions.push(corners[c][0], h, corners[c][1]);
    b.normals.push(0, 1, 0);
    b.colors.push(scratch.r * ao[c], scratch.g * ao[c], scratch.b * ao[c]);
    b.season.push(response, 1);
  }

  // Wound counter-clockwise as seen from above, so the quad faces +Y and
  // survives backface culling.
  //
  // The diagonal is flipped towards the darker pair of corners so the AO
  // gradient does not crease the wrong way across the quad.
  if (ao[0] + ao[2] > ao[1] + ao[3]) {
    b.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  } else {
    b.indices.push(base + 1, base + 3, base + 2, base + 1, base, base + 3);
  }
}

function cornerAO(terrain: Terrain, x: number, z: number, h: number, dx: number, dz: number): number {
  const side1 = terrain.heightAt(x + dx, z) > h ? 1 : 0;
  const side2 = terrain.heightAt(x, z + dz) > h ? 1 : 0;
  const corner = terrain.heightAt(x + dx, z + dz) > h ? 1 : 0;
  const occluders = side1 && side2 ? 3 : side1 + side2 + corner;
  return 1 - occluders * 0.11;
}

function emitSideIfExposed(
  b: MeshBuffers,
  terrain: Terrain,
  x: number,
  z: number,
  h: number,
  type: number,
  shade: number,
  response: number,
  dx: number,
  dz: number,
): void {
  const neighbour = terrain.heightAt(x + dx, z + dz);
  // Edge of the world: drop the wall to the sea floor so the island reads as
  // a solid object floating in water rather than a cut-out.
  const outOfBounds = x + dx < 0 || z + dz < 0 || x + dx >= WORLD_SIZE || z + dz >= WORLD_SIZE;
  const bottom = outOfBounds ? Math.min(h, WATER_LEVEL - 2) : neighbour;
  if (bottom >= h) return;

  scratch.setHex(SIDE_COLORS[type] ?? 0x776655).multiplyScalar(shade);
  // Directional shading: two of the four walls catch more light than the
  // others, which gives the cliffs form under a flat-shaded lambert.
  const facing = dx === 1 ? 1.06 : dx === -1 ? 0.82 : dz === 1 ? 0.96 : 0.9;
  scratch.multiplyScalar(facing);

  const base = b.positions.length / 3;
  let x0 = x;
  let z0 = z;
  let x1 = x;
  let z1 = z;

  if (dx === 1) {
    x0 = x1 = x + 1;
    z0 = z;
    z1 = z + 1;
  } else if (dx === -1) {
    x0 = x1 = x;
    z0 = z + 1;
    z1 = z;
  } else if (dz === 1) {
    z0 = z1 = z + 1;
    x0 = x + 1;
    x1 = x;
  } else {
    z0 = z1 = z;
    x0 = x;
    x1 = x + 1;
  }

  // Top edge at full brightness, bottom edge in shadow - a cheap vertical
  // gradient that keeps tall cliffs from looking like flat cards.
  const depth = h - bottom;
  const darken = Math.max(0.55, 1 - depth * 0.08);

  b.positions.push(x0, h, z0, x1, h, z1, x1, bottom, z1, x0, bottom, z0);
  for (let i = 0; i < 4; i++) b.normals.push(dx, 0, dz);
  b.colors.push(scratch.r, scratch.g, scratch.b);
  b.colors.push(scratch.r, scratch.g, scratch.b);
  b.colors.push(scratch.r * darken, scratch.g * darken, scratch.b * darken);
  b.colors.push(scratch.r * darken, scratch.g * darken, scratch.b * darken);
  // Sides barely respond to the season and never collect snow.
  for (let i = 0; i < 4; i++) b.season.push(response * 0.3, 0);
  b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * The island, meshed in chunks.
 *
 * Sculpting the ground is a continuous gesture, so the cost of an edit has to
 * stay well inside a frame. Only the chunks a change touched are rebuilt, and
 * even then a budget spreads a large edit over a few frames rather than
 * dropping one.
 */
export class TerrainRenderer {
  readonly group = new Group();
  private chunks: Mesh[] = [];
  private material = createSeasonMaterial({
    vertexColors: true,
    seasonAttribute: true,
    seasonResponse: 1,
    // Grass takes a gold wash in autumn, not the full leaf colour - the
    // ground should read as dry, not as a pile of leaves.
    blendScale: 0.42,
    snowOnTop: true,
  });

  /** Chunks rebuilt per frame. Enough for a brush stroke, cheap enough to hide. */
  private budget = 4;

  constructor(private terrain: Terrain) {
    this.group.name = 'terrain';
    for (let cz = 0; cz < CHUNKS_PER_SIDE; cz++) {
      for (let cx = 0; cx < CHUNKS_PER_SIDE; cx++) {
        const mesh = new Mesh(buildChunkGeometry(terrain, cx, cz), this.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `terrain-${cx}-${cz}`;
        this.chunks.push(mesh);
        this.group.add(mesh);
      }
    }
    terrain.dirtyChunks.clear();
  }

  /** Drains the terrain's dirty list, up to this frame's budget. */
  syncIfStale(): boolean {
    const dirty = this.terrain.dirtyChunks;
    if (dirty.size === 0) return false;

    let done = 0;
    for (const chunk of dirty) {
      if (done >= this.budget) break;
      dirty.delete(chunk);
      const cx = chunk % CHUNKS_PER_SIDE;
      const cz = Math.floor(chunk / CHUNKS_PER_SIDE);
      const mesh = this.chunks[chunk];
      mesh.geometry.dispose();
      mesh.geometry = buildChunkGeometry(this.terrain, cx, cz);
      done++;
    }
    return true;
  }

  /** Rebuilds everything at once, for a world swap. */
  rebuildAll(): void {
    this.terrain.markAllDirty();
    const previous = this.budget;
    this.budget = this.chunks.length;
    this.syncIfStale();
    this.budget = previous;
  }

  dispose(): void {
    for (const mesh of this.chunks) mesh.geometry.dispose();
    this.chunks.length = 0;
    this.group.clear();
    this.material.dispose();
  }
}
