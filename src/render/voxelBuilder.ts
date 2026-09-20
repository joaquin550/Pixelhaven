/**
 * Builds chunky box geometry.
 *
 * Trees, boulders and buildings are all assembled from axis-aligned boxes with
 * baked per-face shading, which gives the whole world one consistent "carved
 * from blocks" read and lets every prop kind live in a single draw call.
 */
import { BufferAttribute, BufferGeometry, Color } from 'three';

/** Per-face brightness. Top faces catch the light, undersides sit in shadow. */
const FACE_SHADE = {
  top: 1.0,
  bottom: 0.55,
  north: 0.86,
  south: 0.93,
  east: 1.02,
  west: 0.78,
};

export interface BoxOptions {
  /** Rotation about Y, in radians, around the box centre. */
  rotY?: number;
  /** How much this surface responds to the season tint, 0..1. */
  season?: number;
  /** How much snow settles on the upward faces, 0..1. */
  snow?: number;
  /** Disables baked face shading (for emissive parts like windows). */
  flat?: boolean;
}

const tmpColor = new Color();

export class BoxBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  private season: number[] = [];
  private indices: number[] = [];

  get isEmpty(): boolean {
    return this.positions.length === 0;
  }

  /** Adds a box centred on (cx, cy, cz). `cy` is the centre, not the base. */
  add(
    cx: number,
    cy: number,
    cz: number,
    width: number,
    height: number,
    depth: number,
    color: number | Color,
    options: BoxOptions = {},
  ): this {
    const { rotY = 0, season = 0, snow = 0, flat = false } = options;
    tmpColor.set(color as number);

    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;
    const cos = Math.cos(rotY);
    const sin = Math.sin(rotY);

    const place = (x: number, y: number, z: number): [number, number, number] => {
      const rx = x * cos - z * sin;
      const rz = x * sin + z * cos;
      return [cx + rx, cy + y, cz + rz];
    };
    const rotateNormal = (x: number, z: number): [number, number] => [
      x * cos - z * sin,
      x * sin + z * cos,
    ];

    type Face = {
      corners: [number, number, number][];
      normal: [number, number, number];
      shade: number;
      snowFace: number;
    };

    const faces: Face[] = [
      {
        corners: [
          [-hw, hh, -hd],
          [-hw, hh, hd],
          [hw, hh, hd],
          [hw, hh, -hd],
        ],
        normal: [0, 1, 0],
        shade: FACE_SHADE.top,
        snowFace: snow,
      },
      {
        corners: [
          [-hw, -hh, hd],
          [-hw, -hh, -hd],
          [hw, -hh, -hd],
          [hw, -hh, hd],
        ],
        normal: [0, -1, 0],
        shade: FACE_SHADE.bottom,
        snowFace: 0,
      },
      {
        corners: [
          [-hw, -hh, hd],
          [hw, -hh, hd],
          [hw, hh, hd],
          [-hw, hh, hd],
        ],
        normal: [0, 0, 1],
        shade: FACE_SHADE.south,
        snowFace: snow * 0.2,
      },
      {
        corners: [
          [hw, -hh, -hd],
          [-hw, -hh, -hd],
          [-hw, hh, -hd],
          [hw, hh, -hd],
        ],
        normal: [0, 0, -1],
        shade: FACE_SHADE.north,
        snowFace: snow * 0.2,
      },
      {
        corners: [
          [hw, -hh, hd],
          [hw, -hh, -hd],
          [hw, hh, -hd],
          [hw, hh, hd],
        ],
        normal: [1, 0, 0],
        shade: FACE_SHADE.east,
        snowFace: snow * 0.2,
      },
      {
        corners: [
          [-hw, -hh, -hd],
          [-hw, -hh, hd],
          [-hw, hh, hd],
          [-hw, hh, -hd],
        ],
        normal: [-1, 0, 0],
        shade: FACE_SHADE.west,
        snowFace: snow * 0.2,
      },
    ];

    for (const face of faces) {
      const base = this.positions.length / 3;
      const shade = flat ? 1 : face.shade;
      const [nx, nz] = rotateNormal(face.normal[0], face.normal[2]);
      for (const corner of face.corners) {
        const [px, py, pz] = place(corner[0], corner[1], corner[2]);
        this.positions.push(px, py, pz);
        this.normals.push(nx, face.normal[1], nz);
        this.colors.push(tmpColor.r * shade, tmpColor.g * shade, tmpColor.b * shade);
        this.season.push(season, face.snowFace);
      }
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }

  /** Adds a box specified by its base rather than its centre. */
  addFromBase(
    cx: number,
    baseY: number,
    cz: number,
    width: number,
    height: number,
    depth: number,
    color: number | Color,
    options: BoxOptions = {},
  ): this {
    return this.add(cx, baseY + height / 2, cz, width, height, depth, color, options);
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    geometry.setAttribute('aSeason', new BufferAttribute(new Float32Array(this.season), 2));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}
