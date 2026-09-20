/**
 * Season tinting without re-meshing.
 *
 * Baking autumn into vertex colours would mean rebuilding the island mesh every
 * time the palette shifted - a visible hitch on a tablet. Instead every world
 * material carries two extra uniforms and a per-vertex "how much does this
 * surface care about the weather" weight, so a whole year passes as a uniform
 * update per frame.
 */
import { Color, Material, MeshLambertMaterial, MeshLambertMaterialParameters } from 'three';

export interface SeasonUniforms {
  uSeasonTint: { value: Color };
  uSnowAmount: { value: number };
  uSnowColor: { value: Color };
  /** Scales the whole effect per material (pines barely turn, oaks turn a lot). */
  uSeasonResponse: { value: number };
  /** Night-time cool shift applied on top of the season tint. */
  uNightTint: { value: Color };
  uNightAmount: { value: number };
}

const registry: SeasonUniforms[] = [];

function makeUniforms(response: number): SeasonUniforms {
  const uniforms: SeasonUniforms = {
    uSeasonTint: { value: new Color(1, 1, 1) },
    uSnowAmount: { value: 0 },
    uSnowColor: { value: new Color(0xeef5fb) },
    uSeasonResponse: { value: response },
    uNightTint: { value: new Color(0.62, 0.7, 0.95) },
    uNightAmount: { value: 0 },
  };
  registry.push(uniforms);
  return uniforms;
}

/**
 * A Lambert material that understands seasons.
 *
 * `aSeason` is a per-vertex vec2: x = how much the surface responds to the
 * season tint, y = how upward-facing it is (only upward faces collect snow).
 * Geometry without the attribute falls back to (response, 0).
 */
export function createSeasonMaterial(
  params: MeshLambertMaterialParameters & {
    seasonResponse?: number;
    snowOnTop?: boolean;
    /** Set when the geometry supplies a per-vertex `aSeason` attribute. */
    seasonAttribute?: boolean;
  } = {},
): MeshLambertMaterial {
  const { seasonResponse = 1, snowOnTop = true, seasonAttribute = false, ...rest } = params;
  const material = new MeshLambertMaterial(rest);
  if (seasonAttribute) material.defines = { ...material.defines, USE_SEASON_ATTRIBUTE: '' };
  const uniforms = makeUniforms(seasonResponse);

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSeasonTint = uniforms.uSeasonTint;
    shader.uniforms.uSnowAmount = uniforms.uSnowAmount;
    shader.uniforms.uSnowColor = uniforms.uSnowColor;
    shader.uniforms.uSeasonResponse = uniforms.uSeasonResponse;
    shader.uniforms.uNightTint = uniforms.uNightTint;
    shader.uniforms.uNightAmount = uniforms.uNightAmount;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        #ifdef USE_SEASON_ATTRIBUTE
          attribute vec2 aSeason;
        #endif
        varying vec2 vSeason;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_SEASON_ATTRIBUTE
          vSeason = aSeason;
        #else
          vSeason = vec2(1.0, 1.0);
        #endif`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uSeasonTint;
        uniform float uSnowAmount;
        uniform vec3 uSnowColor;
        uniform float uSeasonResponse;
        uniform vec3 uNightTint;
        uniform float uNightAmount;
        varying vec2 vSeason;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float seasonWeight = clamp(vSeason.x * uSeasonResponse, 0.0, 1.0);
        diffuseColor.rgb *= mix(vec3(1.0), uSeasonTint, seasonWeight);
        ${snowOnTop ? 'diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, clamp(vSeason.y * uSnowAmount * mix(0.35, 1.0, seasonWeight), 0.0, 1.0));' : ''}
        diffuseColor.rgb *= mix(vec3(1.0), uNightTint, uNightAmount);`,
      );
  };

  // Changing onBeforeCompile means three needs a distinct program key.
  material.customProgramCacheKey = () =>
    `season-${seasonResponse}-${snowOnTop ? 1 : 0}-${seasonAttribute ? 1 : 0}`;
  (material as Material & { userData: Record<string, unknown> }).userData.seasonUniforms = uniforms;
  return material;
}

/** Pushes the current look into every season-aware material at once. */
export function updateSeasonUniforms(state: {
  tint: Color;
  snow: number;
  snowColor: Color;
  nightAmount: number;
  nightTint: Color;
}): void {
  for (const uniforms of registry) {
    uniforms.uSeasonTint.value.copy(state.tint);
    uniforms.uSnowAmount.value = state.snow;
    uniforms.uSnowColor.value.copy(state.snowColor);
    uniforms.uNightAmount.value = state.nightAmount;
    uniforms.uNightTint.value.copy(state.nightTint);
  }
}

/** Per-material override, for foliage that should resist the season. */
export function setSeasonResponse(material: Material, response: number): void {
  const uniforms = (material as Material & { userData: Record<string, unknown> }).userData
    .seasonUniforms as SeasonUniforms | undefined;
  if (uniforms) uniforms.uSeasonResponse.value = response;
}
