/**
 * The sea and the river.
 *
 * One animated plane. It samples the island's height field as a texture, so it
 * knows how deep it is at every point and can draw its own shallows, its own
 * foam line along the beach, and sparkle only where the sun is up - all without
 * a depth pre-pass, which matters on tablet GPUs.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  RGBAFormat,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  ClampToEdgeWrapping,
} from 'three';
import { MAX_HEIGHT, WATER_LEVEL, WORLD_SIZE } from '../world/constants';
import { Terrain } from '../world/terrain';

/** A flat grid in the XZ plane, with UVs in island space. */
function buildWaterGeometry(extent: number, segments: number): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const centre = WORLD_SIZE / 2;
  const min = centre - extent / 2;
  const step = extent / segments;

  for (let j = 0; j <= segments; j++) {
    for (let i = 0; i <= segments; i++) {
      const x = min + i * step;
      const z = min + j * step;
      positions.push(x, 0, z);
      uvs.push(x / WORLD_SIZE, z / WORLD_SIZE);
    }
  }
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * (segments + 1) + i;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

const VERTEX = /* glsl */ `
  uniform float uTime;
  varying vec2 vIsland;
  varying vec3 vWorld;
  varying float vFogDepth;

  void main() {
    vIsland = uv;
    vec3 transformed = position;

    // Three crossed sine waves: enough motion to read as water, cheap enough
    // to run on every vertex of a large plane.
    float wave =
      sin(transformed.x * 0.42 + uTime * 0.85) * 0.055 +
      sin(transformed.z * 0.31 - uTime * 0.62) * 0.05 +
      sin((transformed.x + transformed.z) * 0.19 + uTime * 1.25) * 0.028;
    transformed.y += wave;

    vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
    vWorld = worldPosition.xyz;
    vec4 mvPosition = viewMatrix * worldPosition;
    vFogDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D uHeight;
  uniform float uWaterLevel;
  uniform float uMaxHeight;
  uniform float uTime;
  uniform float uNight;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uFoam;
  uniform vec3 uSparkle;

  varying vec2 vIsland;
  varying vec3 vWorld;

  #include <fog_pars_fragment>

  void main() {
    float ground = texture2D(uHeight, clamp(vIsland, 0.0, 1.0)).r * uMaxHeight;
    float depth = clamp((uWaterLevel - ground) / 6.0, 0.0, 1.0);

    vec3 colour = mix(uShallow, uDeep, smoothstep(0.04, 0.8, depth));

    // Foam: a soft band wherever the sea is nearly touching the sand, pulsed
    // so it reads as surf rather than a painted outline.
    float shore = 1.0 - smoothstep(0.0, 0.2, depth);
    float surf = sin(vWorld.x * 1.9 + vWorld.z * 1.4 + uTime * 1.8) * 0.5 + 0.5;
    colour = mix(colour, uFoam, clamp(shore * (0.3 + surf * 0.45), 0.0, 1.0));

    // Specular glints, daytime only.
    float glint = sin(vWorld.x * 3.3 + uTime * 1.7) * sin(vWorld.z * 2.9 - uTime * 1.1);
    colour += uSparkle * pow(max(glint, 0.0), 28.0) * 0.6 * (1.0 - uNight);

    float alpha = mix(0.66, 0.94, depth);
    gl_FragColor = vec4(colour, alpha);

    #include <fog_fragment>
  }
`;

export class WaterRenderer {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private heightTexture: DataTexture;
  private revision = -1;

  constructor(private terrain: Terrain) {
    this.heightTexture = createHeightTexture(terrain);

    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uHeight: { value: null },
          uWaterLevel: { value: WATER_LEVEL },
          uMaxHeight: { value: MAX_HEIGHT },
          uTime: { value: 0 },
          uNight: { value: 0 },
          uShallow: { value: new Color(0x64c4cc) },
          uDeep: { value: new Color(0x1b5570) },
          uFoam: { value: new Color(0xeaf6f7) },
          uSparkle: { value: new Color(0xfff6dd) },
        },
      ]),
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      fog: true,
      depthWrite: false,
    });
    this.material.uniforms.uHeight.value = this.heightTexture;

    // Generous overhang so the ocean reaches past the camera at any zoom.
    this.mesh = new Mesh(buildWaterGeometry(WORLD_SIZE * 3.2, 96), this.material);
    this.mesh.position.y = WATER_LEVEL;
    this.mesh.name = 'water';
    this.mesh.renderOrder = 2;
    this.revision = terrain.revision;
  }

  update(time: number, look: { waterShallow: Color; waterDeep: Color }, night: number): void {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uNight.value = night;
    (this.material.uniforms.uShallow.value as Color).copy(look.waterShallow);
    (this.material.uniforms.uDeep.value as Color).copy(look.waterDeep);

    if (this.terrain.revision !== this.revision) {
      updateHeightTexture(this.heightTexture, this.terrain);
      this.revision = this.terrain.revision;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.heightTexture.dispose();
  }
}

function createHeightTexture(terrain: Terrain): DataTexture {
  const data = new Uint8Array(WORLD_SIZE * WORLD_SIZE * 4);
  const texture = new DataTexture(data, WORLD_SIZE, WORLD_SIZE, RGBAFormat);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  updateHeightTexture(texture, terrain);
  return texture;
}

function updateHeightTexture(texture: DataTexture, terrain: Terrain): void {
  const data = texture.image.data as Uint8Array;
  for (let i = 0; i < WORLD_SIZE * WORLD_SIZE; i++) {
    const value = Math.round((terrain.heights[i] / MAX_HEIGHT) * 255);
    data[i * 4] = value;
    data[i * 4 + 3] = 255;
  }
  texture.needsUpdate = true;
}
