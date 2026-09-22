/**
 * Walkability and pathfinding.
 *
 * A* over the 2D cell grid. The height field means "can I step here?" is just a
 * height difference test, and bridges/docks/paths are expressed as structure
 * tiles flagged walkable rather than as terrain edits.
 */
import { MAX_STEP, Occupancy, WATER_LEVEL, WORLD_SIZE, inBounds, index } from './constants';
import { Terrain } from './terrain';

/** Binary min-heap keyed by f-score. Plain arrays, no allocations per push. */
class MinHeap {
  private items: number[] = [];
  private scores: number[] = [];

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
    this.scores.length = 0;
  }

  push(item: number, score: number): void {
    this.items.push(item);
    this.scores.push(score);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.scores[parent] <= this.scores[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastScore = this.scores.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.scores[0] = lastScore;
      let i = 0;
      const n = this.items.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && this.scores[l] < this.scores[smallest]) smallest = l;
        if (r < n && this.scores[r] < this.scores[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.scores[a], this.scores[b]] = [this.scores[b], this.scores[a]];
  }
}

export interface PathNode {
  x: number;
  z: number;
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, 1.4142],
  [1, -1, 1.4142],
  [-1, 1, 1.4142],
  [-1, -1, 1.4142],
];

export class NavGrid {
  /** 1 = walkable. Rebuilt from terrain + occupancy whenever either changes. */
  readonly walkable: Uint8Array;
  private terrainRevision = -1;

  // Reused A* scratch buffers - pathfinding runs many times a second and
  // allocating three typed arrays per query would thrash the GC.
  private gScore: Float32Array;
  private cameFrom: Int32Array;
  private visitGen: Int32Array;
  private generation = 0;
  private open = new MinHeap();

  constructor(private terrain: Terrain) {
    const cells = WORLD_SIZE * WORLD_SIZE;
    this.walkable = new Uint8Array(cells);
    this.gScore = new Float32Array(cells);
    this.cameFrom = new Int32Array(cells);
    this.visitGen = new Int32Array(cells).fill(-1);
    this.rebuild();
  }

  /** Recomputes the walkable mask. Cheap enough to run on any world change. */
  rebuild(): void {
    const { terrain, walkable } = this;
    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        const i = index(x, z);
        const occ = terrain.occupancy[i];
        const isDry = terrain.heights[i] >= WATER_LEVEL;
        const bridged = (occ & Occupancy.Walkable) !== 0;
        const blocked = (occ & (Occupancy.Prop | Occupancy.Structure)) !== 0 && !bridged;
        walkable[i] = (isDry || bridged) && !blocked ? 1 : 0;
      }
    }
    this.terrainRevision = terrain.revision;
  }

  /** Rebuilds only if the terrain changed since the last rebuild. */
  syncIfStale(): void {
    if (this.terrain.revision !== this.terrainRevision) this.rebuild();
  }

  isWalkable(x: number, z: number): boolean {
    if (!inBounds(x, z)) return false;
    return this.walkable[index(x, z)] === 1;
  }

  /**
   * Can a villager move between two adjacent cells?
   *
   * Climbing is limited to a single voxel, but dropping is not: you can always
   * scramble down. That asymmetry is what makes raised ground a one-way wall,
   * and it is also what stops the player stranding somebody on top of a spire
   * they just pulled out of the ground underneath them.
   */
  canStep(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
    if (!this.isWalkable(toX, toZ)) return false;
    const dh = this.terrain.heightAt(toX, toZ) - this.terrain.heightAt(fromX, fromZ);
    if (dh > MAX_STEP) return false;
    // Diagonals may not cut a corner between two blocked cells.
    if (fromX !== toX && fromZ !== toZ) {
      if (!this.isWalkable(toX, fromZ) || !this.isWalkable(fromX, toZ)) return false;
    }
    return true;
  }

  /** Nearest walkable cell to a target, searched outward in rings. */
  nearestWalkable(x: number, z: number, maxRadius = 8): PathNode | undefined {
    if (this.isWalkable(x, z)) return { x, z };
    for (let r = 1; r <= maxRadius; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const nx = x + dx;
          const nz = z + dz;
          if (this.isWalkable(nx, nz)) return { x: nx, z: nz };
        }
      }
    }
    return undefined;
  }

  /**
   * A* from one cell to another.
   *
   * `adjacent` stops one cell short of the goal, which is what you want when
   * walking up to a tree or a workbench rather than onto it.
   */
  findPath(
    startX: number,
    startZ: number,
    goalX: number,
    goalZ: number,
    options: { adjacent?: boolean; maxNodes?: number } = {},
  ): PathNode[] | undefined {
    this.syncIfStale();
    const adjacent = options.adjacent ?? false;
    const maxNodes = options.maxNodes ?? 6000;

    if (!inBounds(startX, startZ) || !inBounds(goalX, goalZ)) return undefined;

    let goal = { x: goalX, z: goalZ };
    if (adjacent) {
      const spot = this.nearestWalkable(goalX, goalZ, 3);
      if (!spot) return undefined;
      goal = spot;
    } else if (!this.isWalkable(goalX, goalZ)) {
      const spot = this.nearestWalkable(goalX, goalZ, 4);
      if (!spot) return undefined;
      goal = spot;
    }

    const startIdx = index(startX, startZ);
    const goalIdx = index(goal.x, goal.z);
    if (startIdx === goalIdx) return [];

    const gen = ++this.generation;
    this.open.clear();
    this.gScore[startIdx] = 0;
    this.cameFrom[startIdx] = -1;
    this.visitGen[startIdx] = gen;
    this.open.push(startIdx, heuristic(startX, startZ, goal.x, goal.z));

    let expanded = 0;
    while (this.open.size > 0) {
      const current = this.open.pop();
      if (current === goalIdx) return this.reconstruct(current, gen);
      if (++expanded > maxNodes) break;

      const cx = current % WORLD_SIZE;
      const cz = (current / WORLD_SIZE) | 0;
      const baseG = this.gScore[current];

      for (const [dx, dz, cost] of NEIGHBOURS) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (!inBounds(nx, nz)) continue;
        if (!this.canStep(cx, cz, nx, nz)) continue;

        const ni = index(nx, nz);
        // Climbing costs extra so villagers prefer the gentle way round, and
        // a long drop costs a little too - they will take the stairs if there
        // are stairs, and jump if there are not.
        const rise = this.terrain.heights[ni] - this.terrain.heights[current];
        const climb = rise >= 0 ? rise * 0.8 : -rise * 0.35;
        // Laid paths are a pleasure to walk on, and so, increasingly, is a
        // trail the village has worn in for itself. Routing along them is what
        // makes a path deepen instead of scattering.
        const paved = (this.terrain.occupancy[ni] & Occupancy.Walkable) !== 0 ? 1 : this.terrain.wear[ni];
        const tentative = baseG + cost + climb - paved * 0.3;

        if (this.visitGen[ni] !== gen || tentative < this.gScore[ni]) {
          this.visitGen[ni] = gen;
          this.gScore[ni] = tentative;
          this.cameFrom[ni] = current;
          this.open.push(ni, tentative + heuristic(nx, nz, goal.x, goal.z));
        }
      }
    }
    return undefined;
  }

  private reconstruct(goalIdx: number, gen: number): PathNode[] {
    const path: PathNode[] = [];
    let current = goalIdx;
    let guard = 0;
    while (current !== -1 && this.visitGen[current] === gen && guard++ < WORLD_SIZE * WORLD_SIZE) {
      path.push({ x: current % WORLD_SIZE, z: (current / WORLD_SIZE) | 0 });
      current = this.cameFrom[current];
    }
    path.pop(); // Drop the start cell; the villager is already standing on it.
    path.reverse();
    return path;
  }
}

/** Octile distance - the admissible heuristic for 8-way movement. */
function heuristic(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return dx + dz + (1.4142 - 2) * Math.min(dx, dz);
}
