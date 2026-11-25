import * as T from 'three';
import { acquirePbrSurface, createPbrMaterial, type PbrSurfaceKey } from './pbrAtlas';
import {
  patchWeatherWetness,
  type SharedWeatherUniforms,
  type WeatherRenderTier,
  type WeatherWetnessOptions,
} from './weatherSystem';
import { chainMaterialShader, patchMaterialWithEchoCsm } from './echoCsm';
import { getSharedHeightFogUniforms, patchHeightFog } from './atmosphere';

/**
 * Echo Life — Calibrated PBR World Surface Factory (`worldSurfaces.ts`).
 *
 * Consumes A08's staged Poly Haven CC0 textures (`./pbrAtlas`) and A04's global weather shader patch
 * (`./weatherSystem`) to supply high-craft, anti-tiled, weather-reactive materials for every Echo Life
 * world surface without leaking into Study Space's global material cache (`../materials.ts`):
 * - Roads & crossings: Poly Haven asphalt + dual-scale anti-tiling + subtle wheel-track tire wear + glossy rain puddles
 * - Sidewalks & plazas: Concrete pavers & cobblestones with calibrated matte dry roughness + wet puddle sheen
 * - Boardwalk Fair & outdoor timber: Poly Haven oak wood planks with wet darkening & specular grain
 * - Park, Campus, Greenway & Botanical lawns: Dual-surface `grass_ground` <-> `park_dirt` organic footpath trail
 *   blending + 4-season living turf palette (spring petals, summer lush, autumn leaf-litter, winter snow blanket)
 * - River embankment: Poly Haven stone wall with world-Y capillary waterline dampness & moss + granite coping
 * - Architectural exteriors: Stucco, warm plaster, red brick plinths, terracotta clay roof tiles, flat concrete roofs
 * - Architectural interiors: Oak parquet, terrazzo, ceramic tile, concrete & fine plaster preserving `house.ts`
 *   `setFinishes()` `vertexColors = true` compatibility
 * - Glazed exterior windows: Single-pass tangent-space 3D interior parallax room glow at dusk/night + crisp HDRI Fresnel
 */

export interface WorldSurfaceLibraryOptions {
  /** World Z coordinate of the near riverfront embankment wall (drives park promenade dirt trail). */
  riverZ1?: number;
  /** World Y coordinate of the river water surface (drives embankment capillary wet stone & moss band). */
  waterY?: number;
}

export interface ArchitecturalGlassHandle {
  readonly material: T.MeshStandardMaterial;
  setNight(night: number): void;
  setCameraPos(pos: T.Vector3): void;
  dispose(): void;
}

export interface ArchitecturalGlassOptions {
  /** Closed ground-floor display/bookshop window (always uses full interior parallax at dusk/night). */
  shop?: boolean;
  /** Enterable building storefront: smoothly clears parallax to transparent glass when player walks close. */
  enterable?: boolean;
  /** Optional shared preset tag (`'shop' | 'residential' | 'library'`) for pooling. */
  preset?: 'shop' | 'residential' | 'library';
  /** Override tint color. */
  tint?: T.ColorRepresentation;
}

const SURFACE_NOISE_GLSL = /* glsl */ `
float srfHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float srfNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( srfHash12( i ), srfHash12( i + vec2( 1.0, 0.0 ) ), u.x ),
    mix( srfHash12( i + vec2( 0.0, 1.0 ) ), srfHash12( i + vec2( 1.0, 1.0 ) ), u.x ),
    u.y
  );
}
float srfFbm( vec2 p ) {
  const mat2 rot = mat2( 0.80, -0.60, 0.60, 0.80 );
  float v = 0.54 * srfNoise( p );
  p = rot * p * 2.05 + vec2( 13.7, 29.1 );
  v += 0.30 * srfNoise( p );
  p = rot * p * 2.09 + vec2( 7.3, 41.9 );
  v += 0.16 * srfNoise( p );
  return v;
}
`;

function anisotropyForTier(tier: WeatherRenderTier): number {
  switch (tier) {
    case 'ultra': return 16;
    case 'high': return 8;
    case 'balanced': return 4;
    default: return 2;
  }
}

/**
 * Helper to inject surface-level GLSL detail (anti-tiling, tire wear, grass<->dirt trails) cleanly BEFORE
 * `patchWeatherWetness` executes in the compiled fragment pipeline.
 */
function chainBeforeWeather(
  material: T.MeshStandardMaterial,
  cacheSuffix: string,
  inject: (shader: T.WebGLProgramParametersWithUniforms) => void,
): void {
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => {
    const base = prevKey ? prevKey() : '';
    return base ? `${base}|${cacheSuffix}` : cacheSuffix;
  };
  material.onBeforeCompile = (shader, renderer) => {
    // Run weather patch first so its `.replace(anchor, anchor + weather)` lands AFTER our `.replace(anchor, anchor + surface)`!
    prevCompile?.(shader, renderer);
    inject(shader);
  };
  material.needsUpdate = true;
}

/**
 * Injects dual-scale stochastic anti-tiling + subtle wheel-track tire darkening onto asphalt roadways.
 * Eliminates repeating wallpaper seams across 350 m straight avenues (`Lantern Street`, `Riverside Road`, `Market Blvd`).
 */
function enhanceAsphaltRoad(
  material: T.MeshStandardMaterial,
  tier: WeatherRenderTier,
  wheelTracks: boolean,
): void {
  if (tier === 'low') return;
  // Pass `wheelTracks` strictly via uniform `uTrackWear` so `road()` and `crossing()` share ONE compiled program.
  chainBeforeWeather(material, 'srf-asphalt-v2', (shader) => {
    shader.uniforms.uTrackWear = { value: wheelTracks ? 1.0 : 0.0 };
    shader.vertexShader =
      /* glsl */ `
varying vec3 vSrfWorldPos;
` +
      shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        /* glsl */ `#include <worldpos_vertex>
  vec4 srfWp = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    srfWp = batchingMatrix * srfWp;
  #endif
  #ifdef USE_INSTANCING
    srfWp = instanceMatrix * srfWp;
  #endif
  vSrfWorldPos = ( modelMatrix * srfWp ).xyz;
`,
      );

    shader.fragmentShader =
      /* glsl */ `
varying vec3 vSrfWorldPos;
uniform float uTrackWear;
${SURFACE_NOISE_GLSL}
` +
      shader.fragmentShader
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
  float srfMacro = srfFbm( vSrfWorldPos.xz * 0.085 );
  #ifdef USE_MAP
    // Rotated macro second sample breaks up repeating asphalt texture across long city blocks.
    const mat2 srfRot = mat2( 0.80, -0.60, 0.60, 0.80 );
    vec2 altUv = ( srfRot * vSrfWorldPos.xz ) * 0.14 + vec2( 2.3, 4.1 );
    vec3 altTex = texture2D( map, altUv ).rgb;
    diffuseColor.rgb = mix( diffuseColor.rgb, altTex * diffuse, smoothstep( 0.28, 0.72, srfMacro ) * 0.42 );
  #endif
  // Subtle aggregate tonal variation + oil/rubber patina.
  diffuseColor.rgb *= 0.88 + 0.22 * srfMacro;
  // Subtle twin wheel-track darkening & aggregate polishing along city traffic lanes (~1.6 m spacing).
  float trackWaveX = pow( 0.5 + 0.5 * cos( vSrfWorldPos.z * 3.14159 * 1.12 ), 4.0 );
  float trackWaveZ = pow( 0.5 + 0.5 * cos( vSrfWorldPos.x * 3.14159 * 1.12 ), 4.0 );
  float trackWear = uTrackWear * clamp( max( trackWaveX, trackWaveZ ) * ( 0.45 + 0.55 * srfNoise( vSrfWorldPos.xz * 0.22 ) ), 0.0, 1.0 );
  diffuseColor.rgb *= mix( 1.0, 0.86, trackWear * 0.55 );
`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `#include <roughnessmap_fragment>
  // Slight tire polishing makes wheel tracks subtly smoother than untouched asphalt shoulders.
  roughnessFactor = clamp( roughnessFactor - trackWear * 0.09 + ( srfMacro - 0.5 ) * 0.10, 0.32, 0.98 );
`,
        );
  });
}

/**
 * Injects subtle macro tile/stone tonal breakup onto sidewalks, plazas, and boardwalks so wide paved zones
 * never look like sterile repeating grids.
 */
function enhancePavedBreakup(material: T.MeshStandardMaterial, tier: WeatherRenderTier, strength = 0.16): void {
  if (tier === 'low') return;
  // Pass `strength` strictly via uniform `uSrfBreakup` (constant cache key eliminates duplicate shader compiles!).
  chainBeforeWeather(material, 'srf-pave-v1', (shader) => {
    shader.uniforms.uSrfBreakup = { value: strength };
    shader.vertexShader =
      /* glsl */ `
varying vec3 vSrfWorldPos;
` +
      shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        /* glsl */ `#include <worldpos_vertex>
  vec4 srfWp = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    srfWp = batchingMatrix * srfWp;
  #endif
  #ifdef USE_INSTANCING
    srfWp = instanceMatrix * srfWp;
  #endif
  vSrfWorldPos = ( modelMatrix * srfWp ).xyz;
`,
      );

    shader.fragmentShader =
      /* glsl */ `
varying vec3 vSrfWorldPos;
uniform float uSrfBreakup;
${SURFACE_NOISE_GLSL}
` +
      shader.fragmentShader
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
  float srfM1 = srfFbm( vSrfWorldPos.xz * 0.14 );
  float srfM2 = srfNoise( vSrfWorldPos.xz * 0.65 + vec2( 3.1, 7.7 ) );
  // Subtle warm/cool mineral variation + weathered seam grime.
  vec3 mineralTint = mix( vec3( 0.94, 0.93, 0.91 ), vec3( 1.05, 1.04, 1.02 ), srfM1 );
  diffuseColor.rgb *= mix( vec3( 1.0 ), mineralTint * ( 0.92 + 0.16 * srfM2 ), uSrfBreakup * 2.5 );
`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `#include <roughnessmap_fragment>
  roughnessFactor = clamp( roughnessFactor + ( srfM1 - 0.5 ) * 0.14, 0.35, 0.98 );
`,
        );
  });
}

/**
 * Injects world-space `grass_ground` <-> `park_dirt` organic footpath & riverfront border trail blending,
 * macro anti-tiling breakup, and 4-season living botanical coloration (spring blossom speckles, summer emerald,
 * autumn golden-olive + fallen amber leaf scatter, winter dormant frosted turf).
 */
function enhanceParkLawn(
  material: T.MeshStandardMaterial,
  weather: SharedWeatherUniforms,
  dirtSurf: ReturnType<typeof acquirePbrSurface> | null,
  riverZ1: number,
  variant: 'park' | 'garden',
  tier: WeatherRenderTier,
): void {
  // On `low` (iGPU floor), skip expensive multi-octave FBM & dual-surface dirt blending:
  // apply a lightweight uniform 4-season meadow tint only so lawns read rich at full iGPU FPS!
  if (tier === 'low' || !dirtSurf) {
    chainBeforeWeather(material, 'srf-lawn-low-v1', (shader) => {
      shader.uniforms.uLawnSeason = weather.uSeason;
      shader.fragmentShader =
        /* glsl */ `uniform float uLawnSeason;\n` +
        shader.fragmentShader.replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
  vec3 springT = vec3( 0.44, 0.94, 0.36 );
  vec3 summerT = vec3( 0.38, 0.86, 0.32 );
  vec3 autumnT = vec3( 0.96, 0.78, 0.42 );
  vec3 winterT = vec3( 0.62, 0.65, 0.58 );
  vec3 sTint = uLawnSeason < 0.5 ? springT : uLawnSeason < 1.5 ? summerT : uLawnSeason < 2.5 ? autumnT : winterT;
  diffuseColor.rgb *= sTint;
`,
        );
    });
    return;
  }

  const dummyTex = new T.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, T.RGBAFormat);
  dummyTex.needsUpdate = true;
  material.userData.__srfDummy = dummyTex;

  const useDirtNormal = !!dirtSurf.normalMap;
  const useDirtOrm = !!dirtSurf.ormMap;

  // Key strictly on GLSL-branching flags (`variant` is already a uniform `uLawnIsPark`!).
  chainBeforeWeather(material, `srf-lawn-v2:${useDirtNormal ? 1 : 0}:${useDirtOrm ? 1 : 0}`, (shader) => {
    shader.uniforms.uLawnSeason = weather.uSeason;
    shader.uniforms.uLawnRiverZ1 = { value: riverZ1 };
    shader.uniforms.uLawnIsPark = { value: variant === 'park' ? 1 : 0 };
    shader.uniforms.uDirtColor = { value: dirtSurf.colorMap };
    shader.uniforms.uDirtNormal = { value: dirtSurf.normalMap ?? dummyTex };
    shader.uniforms.uDirtOrm = { value: dirtSurf.ormMap ?? dummyTex };

    shader.vertexShader =
      /* glsl */ `
varying vec3 vLawnWorldPos;
varying vec3 vLawnViewX;
varying vec3 vLawnViewUp;
varying vec3 vLawnViewZ;
` +
      shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        /* glsl */ `#include <worldpos_vertex>
  vec4 lawnWp = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    lawnWp = batchingMatrix * lawnWp;
  #endif
  #ifdef USE_INSTANCING
    lawnWp = instanceMatrix * lawnWp;
  #endif
  vLawnWorldPos = ( modelMatrix * lawnWp ).xyz;
  vLawnViewX  = normalize( ( viewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz );
  vLawnViewUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  vLawnViewZ  = normalize( ( viewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );
`,
      );

    shader.fragmentShader =
      /* glsl */ `
varying vec3 vLawnWorldPos;
varying vec3 vLawnViewX;
varying vec3 vLawnViewUp;
varying vec3 vLawnViewZ;
uniform float uLawnSeason;
uniform float uLawnRiverZ1;
uniform float uLawnIsPark;
uniform sampler2D uDirtColor;
uniform sampler2D uDirtNormal;
uniform sampler2D uDirtOrm;
${SURFACE_NOISE_GLSL}
` +
      shader.fragmentShader
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
  vec2 lawnXZ = vLawnWorldPos.xz;
  // Multi-scale domain-warped organic meadow fields (broad sun/canopy turf, clover/moss pockets, fine soil/thatch).
  float lawnBroad = srfFbm( lawnXZ * 0.055 );
  float lawnMacro = srfFbm( lawnXZ * 0.14 + vec2( lawnBroad * 1.35, -lawnBroad * 1.10 ) );
  float lawnClover = srfFbm( lawnXZ * 0.34 + vec2( 9.2, 4.7 ) );
  float lawnMicro = srfNoise( lawnXZ * 1.15 + vec2( 5.3, 11.7 ) );
  float lawnFine  = srfNoise( lawnXZ * 4.40 + vec2( 17.1, 2.9 ) );

  #ifdef USE_MAP
    // Dual-scale rotated grass lookup kills repeating lawn grid across Riverside Park & Greenway.
    const mat2 lawnRot = mat2( 0.80, -0.60, 0.60, 0.80 );
    vec3 grassAlt = texture2D( map, ( lawnRot * lawnXZ ) * 0.21 + vec2( 1.7, 3.3 ) ).rgb;
    diffuseColor.rgb = mix( diffuseColor.rgb, grassAlt * diffuse, smoothstep( 0.24, 0.76, lawnMacro ) * 0.50 );
  #endif

  // Rich multi-scale mottled meadow grass / clover / moss / soil variation (never flat pale green!).
  vec3 springTint = vec3( 0.52, 1.16, 0.44 );
  vec3 summerTint = vec3( 0.46, 1.06, 0.38 );
  vec3 autumnTint = vec3( 1.12, 0.90, 0.48 );
  vec3 winterTint = vec3( 0.72, 0.76, 0.68 );
  vec3 sTint = uLawnSeason < 0.5 ? springTint : uLawnSeason < 1.5 ? summerTint : uLawnSeason < 2.5 ? autumnTint : winterTint;
  vec3 grassCol = diffuseColor.rgb * sTint * ( 0.78 + 0.34 * lawnMacro );

  if ( uLawnSeason < 1.5 ) {
    float gLum = max( dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) ), 0.03 );
    // Deep shady moss-emerald, sunlit meadow chartreuse, and rich clover pockets
    vec3 mossDeep  = uLawnSeason < 0.5 ? vec3( 0.036, 0.155, 0.032 ) : vec3( 0.028, 0.130, 0.028 );
    vec3 cloverMid = uLawnSeason < 0.5 ? vec3( 0.068, 0.235, 0.048 ) : vec3( 0.056, 0.205, 0.042 );
    vec3 sunMeadow = uLawnSeason < 0.5 ? vec3( 0.145, 0.325, 0.062 ) : vec3( 0.125, 0.275, 0.052 );
    vec3 meadowMix = mix( mossDeep, cloverMid, smoothstep( 0.25, 0.72, lawnClover ) );
    meadowMix = mix( meadowMix, sunMeadow, smoothstep( 0.36, 0.80, lawnBroad * 0.65 + lawnMacro * 0.35 ) );
    // Subtle dark humic soil/thatch peeking through fine tuft gaps grounds 3D grass blades naturally!
    vec3 soilThatch = vec3( 0.11, 0.085, 0.052 );
    float thatchGap = smoothstep( 0.64, 0.90, lawnFine ) * smoothstep( 0.35, 0.75, 1.0 - lawnClover );
    meadowMix = mix( meadowMix, soilThatch, thatchGap * 0.42 );
    vec3 meadowTarget = meadowMix * ( 0.56 + 2.25 * gLum );
    grassCol = mix( grassCol, meadowTarget, uLawnSeason < 0.5 ? 0.64 : 0.60 );
  } else if ( uLawnSeason < 2.5 ) {
    // Autumn mottled moss + olive meadow + russet earth
    vec3 autumnMoss = vec3( 0.085, 0.145, 0.045 );
    grassCol = mix( grassCol, autumnMoss, smoothstep( 0.58, 0.86, lawnClover ) * 0.35 );
  } else {
    // Winter dormant frosted sage-straw (never neon green under snow!)
    vec3 dormantStraw = vec3( 0.24, 0.23, 0.18 ) * ( 0.75 + 0.45 * lawnMacro );
    grassCol = mix( grassCol, dormantStraw, 0.58 );
  }

  // Seasonal botanical micro-scatter (spring clover blossoms & fallen sakura petals / autumn fallen leaves).
  if ( uLawnSeason < 0.5 ) {
    float cloverBloom = smoothstep( 0.82, 0.94, lawnFine ) * smoothstep( 0.52, 0.82, lawnClover );
    grassCol = mix( grassCol, vec3( 0.94, 0.95, 0.84 ), cloverBloom * 0.32 );
    float petalFleck = smoothstep( 0.86, 0.96, lawnFine ) * smoothstep( 0.42, 0.72, lawnMicro );
    grassCol = mix( grassCol, vec3( 0.98, 0.76, 0.85 ), petalFleck * 0.30 );
  } else if ( uLawnSeason > 1.5 && uLawnSeason < 2.5 ) {
    float leafFleck = smoothstep( 0.68, 0.91, lawnFine ) * smoothstep( 0.34, 0.74, lawnMicro );
    vec3 leafCol = mix( vec3( 0.74, 0.38, 0.12 ), vec3( 0.86, 0.58, 0.16 ), lawnMacro );
    grassCol = mix( grassCol, leafCol, leafFleck * 0.52 );
  }

  // World-space organic park dirt footpath & riverfront embankment border trail mask.
  float distFromRiver = abs( lawnXZ.y - uLawnRiverZ1 );
  float edgeWarp = ( lawnMicro - 0.5 ) * 0.72;
  float riverWalk = smoothstep( 1.65 + edgeWarp, 0.55, distFromRiver ) * step( lawnXZ.y, uLawnRiverZ1 + 2.6 );
  float meanderZ = uLawnRiverZ1 + 6.3 + sin( lawnXZ.x * 0.085 ) * 1.45 + ( lawnMacro - 0.5 ) * 1.1;
  float footpath = smoothstep( 1.05 + edgeWarp * 0.45, 0.38, abs( lawnXZ.y - meanderZ ) ) * uLawnIsPark;
  // Localized worn earth / tree-root mulch patches
  float wornPatch = smoothstep( 0.74, 0.88, lawnMacro * 0.68 + lawnMicro * 0.32 ) * ( uLawnIsPark > 0.5 ? 0.44 : 0.50 );
  float trailMask = clamp( max( max( riverWalk * 0.92, footpath * 0.95 ), wornPatch ), 0.0, 1.0 );

  // Sample Poly Haven park_dirt texture (warm earthy brown-tan) with height-biased crisp grass edges gated to trails.
  vec2 dirtUv = lawnXZ * 0.38;
  vec3 dirtCol = texture2D( uDirtColor, dirtUv ).rgb * vec3( 0.92, 0.76, 0.58 ) * ( 0.82 + 0.28 * lawnMicro );
  float grassHeight = dot( grassCol, vec3( 0.25, 0.65, 0.10 ) );
  float dirtHeight  = dot( dirtCol, vec3( 0.42, 0.38, 0.20 ) );
  float heightBias = ( dirtHeight - grassHeight ) * 0.34 * smoothstep( 0.05, 0.38, trailMask );
  float lawnDirtBlend = smoothstep( 0.20, 0.72, clamp( trailMask + heightBias, 0.0, 1.0 ) );

  diffuseColor.rgb = mix( grassCol, dirtCol, lawnDirtBlend );
`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `#include <roughnessmap_fragment>
  ${
    useDirtOrm
      ? /* glsl */ `
  float dirtRough = texture2D( uDirtOrm, dirtUv ).g;
  roughnessFactor = mix( clamp( roughnessFactor * 0.95, 0.72, 0.98 ), clamp( dirtRough, 0.76, 0.98 ), lawnDirtBlend );
  `
      : 'roughnessFactor = mix( roughnessFactor, 0.92, lawnDirtBlend );'
  }
`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `#include <normal_fragment_maps>
  ${
    useDirtNormal
      ? /* glsl */ `
  // Hoist texture2D unconditionally outside varying control flow to prevent ANGLE D3D11 X3595 gradient warnings!
  vec3 dMapN = texture2D( uDirtNormal, dirtUv ).xyz * 2.0 - 1.0;
  if ( lawnDirtBlend > 0.02 ) {
    vec3 dirtViewN = normalize( vLawnViewX * dMapN.x * 0.85 + vLawnViewZ * dMapN.y * 0.85 + vLawnViewUp * max( 0.25, dMapN.z ) );
    normal = normalize( mix( normal, dirtViewN, lawnDirtBlend * 0.88 ) );
  }
  `
      : ''
  }
`,
        );
  });
}

/**
 * Single-pass tangent-space 3D interior parallax glazed window shader:
 * - Daytime: crisp physically calibrated architectural glass reflecting the live blended Poly Haven HDRI.
 * - Dusk / Night: projects a 3D virtual room behind each exterior window (warm ceiling glow, soft drapery curtains,
 *   back wall, randomized cozy 2700K-3400K occupancy per window cell!) instead of flat solid yellow stickers.
 * - Smart enterable fade: when `enterable === true`, smoothly fades interior parallax back to clear glass within
 *   10 m of the camera so real furnished interiors inside enterable shops/homes remain cleanly visible!
 */
function createArchitecturalGlass(
  tier: WeatherRenderTier,
  opts: ArchitecturalGlassOptions = {},
): ArchitecturalGlassHandle {
  const shop = !!opts.shop;
  const enterable = !!opts.enterable;
  const closedDisplayShop = shop && !enterable;
  const enableParallax = tier !== 'low';

  const uNight = { value: 0 };
  const uCamPos = { value: new T.Vector3() };

  // On `low` (iGPU floor), use lean `MeshStandardMaterial` instead of heavy clearcoat/IOR `MeshPhysicalMaterial`!
  // Enterable buildings (including enterable shops/cafes) always use crystal-clear `#d8ecfa` glazing so closed
  // windows show the full 3D city from inside and real 3D interiors from nearby outside!
  const material: T.MeshStandardMaterial =
    tier === 'low'
      ? new T.MeshStandardMaterial({
          color: opts.tint ?? (closedDisplayShop ? '#1e2733' : '#d8ecfa'),
          roughness: 0.12,
          metalness: 0.06,
          envMapIntensity: 0.90,
          transparent: true,
          opacity: closedDisplayShop ? 0.84 : 0.20,
          depthWrite: false,
          side: T.DoubleSide,
        })
      : new T.MeshPhysicalMaterial({
          color: opts.tint ?? (closedDisplayShop ? '#1e2733' : '#d8ecfa'),
          roughness: closedDisplayShop ? 0.055 : 0.04,
          metalness: closedDisplayShop ? 0.04 : 0.02,
          clearcoat: 1.0,
          clearcoatRoughness: closedDisplayShop ? 0.05 : 0.035,
          ior: 1.52,
          reflectivity: 0.90,
          envMapIntensity: closedDisplayShop ? 1.45 : 1.25,
          transparent: true,
          opacity: closedDisplayShop ? 0.88 : 0.18,
          depthWrite: false,
          side: T.DoubleSide,
        });
  material.name = `glass:${opts.preset ?? (closedDisplayShop ? 'shop' : enterable ? (shop ? 'shop-ent' : 'enterable') : 'window')}`;

  if (enableParallax) {
    // Constant program cache key: `shop`, `enterable`, & `closedDisplayShop` are uniforms, not GLSL compile branches!
    chainMaterialShader(material, 'echo-parallax-glass-v3', (shader) => {
      shader.uniforms.uGlassNight = uNight;
      shader.uniforms.uGlassCam = uCamPos;
      shader.uniforms.uGlassShop = { value: shop ? 1 : 0 };
      shader.uniforms.uGlassEnterable = { value: enterable ? 1 : 0 };
      shader.uniforms.uGlassClosedShop = { value: closedDisplayShop ? 1 : 0 };

      shader.vertexShader =
        /* glsl */ `
varying vec3 vGlassWorldPos;
varying vec3 vGlassWorldNormal;
varying vec2 vGlassPaneUv;
` +
        shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          /* glsl */ `#include <worldpos_vertex>
  vGlassPaneUv = uv;
  vec4 glsWp = modelMatrix * vec4( transformed, 1.0 );
  vGlassWorldPos = glsWp.xyz;
  vGlassWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
`,
        );

      shader.fragmentShader =
        /* glsl */ `
varying vec3 vGlassWorldPos;
varying vec3 vGlassWorldNormal;
varying vec2 vGlassPaneUv;
uniform float uGlassNight;
uniform vec3 uGlassCam;
uniform float uGlassShop;
uniform float uGlassEnterable;
uniform float uGlassClosedShop;

float glsHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
` +
        shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
  vec3 glsToCam = uGlassCam - vGlassWorldPos;
  float glsDist = length( glsToCam );
  vec3 glsV = glsToCam / max( glsDist, 1e-4 );
  // Exterior window pane normals point OUTDOORS (glsFacingOut > 0.0 outdoors looking in, <= 0.0 indoors looking out).
  vec3 glsRawN = normalize( vGlassWorldNormal );
  float glsFacingOut = dot( glsRawN, glsV );
  vec3 glsN = glsFacingOut < 0.0 ? -glsRawN : glsRawN;
  float glsFresnel = pow( 1.0 - clamp( abs( glsFacingOut ), 0.0, 1.0 ), 4.0 );

  // Tangent basis aligned horizontally across the window wall & vertically along world +Y.
  vec3 glsUp = vec3( 0.0, 1.0, 0.0 );
  vec3 glsRight = normalize( cross( glsUp, glsN ) + vec3( 1e-4, 0.0, 0.0 ) );
  vec3 glsRayDir = -glsV; // Ray traveling from camera INTO the room behind the glass.
  vec3 rayT = vec3( dot( glsRayDir, glsRight ), dot( glsRayDir, glsUp ), dot( glsRayDir, -glsN ) );

  // Virtual 3D room cell behind the pane (single-pass box intersection in [-1..1]^2 x [0..depth]).
  vec2 cellUv = vGlassPaneUv * 2.0 - 1.0;
  float roomDepth = uGlassShop > 0.5 ? 1.15 : 0.90;
  vec3 posT = vec3( cellUv, 0.0 );
  vec3 invR = 1.0 / ( sign( rayT ) * max( abs( rayT ), vec3( 1e-4 ) ) );
  float tx = ( ( rayT.x > 0.0 ? 1.0 : -1.0 ) - posT.x ) * invR.x;
  float ty = ( ( rayT.y > 0.0 ? 1.0 : -1.0 ) - posT.y ) * invR.y;
  float tz = ( roomDepth - posT.z ) * invR.z;
  float tHit = min( min( tx, ty ), tz );
  vec3 hit = posT + rayT * tHit;

  // Deterministic room seed per physical window so every window has its own warm lamp temperature & occupancy.
  vec2 winCell = floor( vec2( dot( vGlassWorldPos.xz, glsRight.xz ) * 0.45, vGlassWorldPos.y * 0.38 ) );
  float rndA = glsHash( winCell );
  float rndB = glsHash( winCell + vec2( 17.3, 9.1 ) );
  float occupied = uGlassShop > 0.5 ? 1.0 : step( 0.24, rndA );

  // Shade virtual back wall, ceiling lamp pool, subtle bookshelf/floor depth, and soft side drapery.
  float hitBack = step( abs( hit.z - roomDepth ), 0.04 );
  float hitCeil = step( 0.94, hit.y );
  float hitFloor = step( hit.y, -0.94 );
  float lampPool = exp( -dot( hit.xz - vec2( 0.0, roomDepth * 0.48 ), hit.xz - vec2( 0.0, roomDepth * 0.48 ) ) * 2.4 );
  vec3 warmTint = mix( vec3( 1.0, 0.78, 0.44 ), vec3( 1.0, 0.90, 0.70 ), rndB );
  vec3 wallShade = mix( vec3( 0.28, 0.24, 0.20 ), vec3( 0.66, 0.56, 0.44 ), 0.45 + 0.55 * ( 1.0 - hit.z / roomDepth ) );
  vec3 roomCol = wallShade * ( 0.48 + 0.72 * lampPool );
  if ( hitCeil > 0.5 ) roomCol = vec3( 0.95, 0.88, 0.74 ) * ( 0.65 + 0.75 * lampPool );
  if ( hitFloor > 0.5 ) roomCol = vec3( 0.34, 0.25, 0.17 ) * ( 0.55 + 0.45 * lampPool );
  if ( hitBack > 0.5 && uGlassShop > 0.5 ) {
    // Cozy bookshop shelf silhouette bands on closed ground-floor shopfront windows.
    float shelf = smoothstep( 0.08, 0.14, abs( fract( hit.y * 2.4 ) - 0.5 ) );
    roomCol *= 0.62 + 0.38 * shelf;
  }

  // Soft translucent curtains framing outer left/right edges of residential windows.
  float curtainMask = ( 1.0 - uGlassShop ) * smoothstep( 0.56, 0.88, abs( cellUv.x ) + sin( cellUv.y * 5.0 ) * 0.04 );
  float curtainFold = 0.78 + 0.22 * sin( cellUv.x * 32.0 );
  roomCol = mix( roomCol, vec3( 0.94, 0.89, 0.80 ) * curtainFold, curtainMask * 0.58 );

  // Enterable windows NEVER paint a fake parallax room when looking from inside out (glsFacingOut <= 0.0),
  // and fade parallax cleanly to zero within 18 m outdoors so real 3D interiors and city vistas stay crystal-clear!
  float distWeight = uGlassEnterable > 0.5
    ? ( glsFacingOut > 0.0 ? smoothstep( 18.0, 28.0, glsDist ) : 0.0 )
    : 1.0;
  float dayDepth = ( uGlassClosedShop > 0.5 ? 0.26 : 0.14 ) * distWeight;
  float parallaxStrength = max( uGlassNight * occupied * distWeight, dayDepth );
  totalEmissiveRadiance += roomCol * warmTint * parallaxStrength * ( uGlassShop > 0.5 ? 1.10 : 0.96 );

  float clearGlassAlpha = clamp( diffuseColor.a + glsFresnel * 0.40, 0.16, 0.58 );
  float parallaxGlassAlpha = clamp( 0.34 + parallaxStrength * 0.54, 0.34, 0.90 );
  diffuseColor.a = uGlassClosedShop > 0.5
    ? clamp( diffuseColor.a + parallaxStrength * 0.08, 0.86, 0.95 )
    : mix( clearGlassAlpha, parallaxGlassAlpha, clamp( parallaxStrength * 1.35, 0.0, 1.0 ) );
`,
        );
    });
  }
  // Attach Height Fog + 3-cascade CSM at creation time across all tiers (canonical order: domain -> fog -> CSM).
  patchHeightFog(material, getSharedHeightFogUniforms());
  patchMaterialWithEchoCsm(material);

  return {
    material,
    setNight(night: number) {
      const n = Math.max(0, Math.min(1, night));
      uNight.value = n;
      if (!enableParallax) {
        material.emissive.setRGB(1, 0.84, 0.54);
        material.emissiveIntensity = closedDisplayShop ? n * 0.55 : enterable ? n * 0.06 : n * 0.72;
        material.opacity = closedDisplayShop ? 0.86 : enterable ? 0.20 : 0.24 + n * 0.34;
      }
    },
    setCameraPos(pos: T.Vector3) {
      uCamPos.value.copy(pos);
    },
    dispose() {
      material.dispose();
    },
  };
}

// ── Main WorldSurfaceLibrary Class ─────────────────────────────────────────────────────────────────────────────

export class WorldSurfaceLibrary {
  private readonly ownedMaterials = new Map<string, T.Material>();
  private readonly ownedExtras: { dispose(): void }[] = [];
  private readonly glassPool = new Map<string, ArchitecturalGlassHandle>();
  private readonly aniso: number;
  private readonly colorOnly: boolean;
  private readonly riverZ1: number;
  private readonly waterY: number;

  constructor(
    readonly weather: SharedWeatherUniforms,
    readonly tier: WeatherRenderTier = 'high',
    opts: WorldSurfaceLibraryOptions = {},
  ) {
    this.aniso = anisotropyForTier(tier);
    this.colorOnly = tier === 'low';
    this.riverZ1 = opts.riverZ1 ?? -22;
    this.waterY = opts.waterY ?? -3.75;
  }

  private getOrCreate<M extends T.Material>(key: string, create: () => M): M {
    const hit = this.ownedMaterials.get(key);
    if (hit) return hit as M;
    const mat = create();
    this.ownedMaterials.set(key, mat);
    return mat;
  }

  private buildPbr(
    pbrKey: PbrSurfaceKey,
    opts: {
      color?: T.ColorRepresentation;
      repeat?: number;
      roughness?: number;
      metalness?: number;
      normalScale?: number;
      aoMapIntensity?: number;
      envMapIntensity?: number;
      side?: T.Side;
      weather?: WeatherWetnessOptions | false;
    } = {},
  ): T.MeshStandardMaterial {
    const rep = opts.repeat;
    const m = createPbrMaterial(pbrKey, {
      color: opts.color ?? '#ffffff',
      repeatX: rep,
      repeatY: rep,
      maxAnisotropy: this.aniso,
      roughness: opts.roughness,
      metalness: opts.metalness,
      normalScale: opts.normalScale,
      aoMapIntensity: opts.aoMapIntensity,
      envMapIntensity: opts.envMapIntensity ?? 1.0,
      side: opts.side,
      colorOnly: this.colorOnly,
    });
    if (opts.weather !== false && opts.weather) {
      patchWeatherWetness(m, this.weather, { tier: this.tier, ...opts.weather });
    }
    // Always attach analytical Exponential Height Fog + 3-cascade CSM at creation time (canonical order:
    // weather -> fog -> CSM) across both outdoor and indoor materials so no late post-compile CSM mutation occurs!
    patchHeightFog(m, getSharedHeightFogUniforms());
    patchMaterialWithEchoCsm(m);
    return m;
  }

  // ── Outdoor Ground & Infrastructure ────────────────────────────────────────────────────────────────────────

  /** Asphalt roadway with anti-tiling breakup, dual wheel tracks, wet darkening & mirror rain puddles. */
  road(): T.MeshStandardMaterial {
    return this.getOrCreate('road', () => {
      const m = this.buildPbr('asphalt', {
        color: '#b8bec7',
        repeat: 0.85,
        normalScale: 0.88,
        envMapIntensity: 1.15,
        weather: {
          porosity: 0.88,
          puddleStrength: 0.96,
          puddleScale: 0.145,
          snowReceptivity: 0.24,
          wetRoughnessFloor: 0.036,
          wetRoughnessScale: 0.44,
          dampSheen: 0.34,
          cacheTag: 'road',
        },
      });
      enhanceAsphaltRoad(m, this.tier, true);
      return m;
    });
  }

  /** Crosswalk asphalt sharing full rain-puddle continuity with adjacent roads. */
  crossing(): T.MeshStandardMaterial {
    return this.getOrCreate('crossing', () => {
      const m = this.buildPbr('asphalt_clean', {
        color: '#b4bac3',
        repeat: 0.9,
        normalScale: 0.82,
        envMapIntensity: 1.15,
        weather: {
          porosity: 0.88,
          puddleStrength: 0.86,
          puddleScale: 0.15,
          snowReceptivity: 0.24,
          wetRoughnessFloor: 0.038,
          wetRoughnessScale: 0.45,
          dampSheen: 0.32,
          cacheTag: 'crossing',
        },
      });
      enhanceAsphaltRoad(m, this.tier, false);
      return m;
    });
  }

  /** Worn thermoplastic crosswalk zebra stripes & road centre dashes (matte off-white dry, glossy sheen wet). */
  roadMarking(): T.MeshStandardMaterial {
    return this.getOrCreate('road-marking', () => {
      const m = this.buildPbr('stucco_white', {
        color: '#e3dfd5',
        repeat: 1.8,
        roughness: 0.82,
        normalScale: 0.35,
        aoMapIntensity: 0.35,
        weather: {
          porosity: 0.36,
          puddleStrength: 0.38,
          puddleScale: 0.15,
          snowReceptivity: 0.26,
          wetRoughnessFloor: 0.08,
          wetRoughnessScale: 0.42,
          dampSheen: 0.16,
          cacheTag: 'marking',
        },
      });
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -2;
      return m;
    });
  }

  /** Concrete paver sidewalks with mortar relief, zero whitewashed glare, and glossy rain puddles. */
  sidewalk(): T.MeshStandardMaterial {
    return this.getOrCreate('sidewalk', () => {
      const m = this.buildPbr('pavers', {
        color: '#cbc4b7',
        repeat: 1.25,
        normalScale: 0.92,
        aoMapIntensity: 0.88,
        envMapIntensity: 1.05,
        weather: {
          porosity: 0.74,
          puddleStrength: 0.68,
          puddleScale: 0.19,
          snowReceptivity: 0.72,
          wetRoughnessFloor: 0.042,
          wetRoughnessScale: 0.48,
          dampSheen: 0.26,
          cacheTag: 'sidewalk',
        },
      });
      enhancePavedBreakup(m, this.tier, 0.18);
      return m;
    });
  }

  /** Chamfered granite/concrete road curbs & river embankment coping capstones. */
  graniteCurb(): T.MeshStandardMaterial {
    return this.getOrCreate('granite-curb', () =>
      this.buildPbr('concrete', {
        color: '#b8b3aa',
        repeat: 1.4,
        normalScale: 0.85,
        aoMapIntensity: 0.82,
        weather: {
          porosity: 0.76,
          puddleStrength: 0.25,
          snowReceptivity: 0.66,
          wetRoughnessFloor: 0.07,
          wetRoughnessScale: 0.48,
          dampSheen: 0.14,
          cacheTag: 'curb',
        },
      }),
    );
  }

  /** Cast-iron slotted gutter storm drains along road edges. */
  stormDrain(): T.MeshStandardMaterial {
    return this.getOrCreate('storm-drain', () => {
      const m = new T.MeshStandardMaterial({
        color: '#2e343c',
        roughness: 0.46,
        metalness: 0.84,
        envMapIntensity: 1.2,
      });
      m.name = 'srf:storm-drain';
      patchWeatherWetness(m, this.weather, {
        tier: this.tier,
        porosity: 0.22,
        puddleStrength: 0.2,
        snowReceptivity: 0.15,
        wetRoughnessFloor: 0.08,
        cacheTag: 'drain',
      });
      patchHeightFog(m, getSharedHeightFogUniforms());
      patchMaterialWithEchoCsm(m);
      return m;
    });
  }

  /** Campus, Fountain Court & shopping breezeway cobblestone / flagstone plazas. */
  plaza(): T.MeshStandardMaterial {
    return this.getOrCreate('plaza', () => {
      const m = this.buildPbr('cobblestone', {
        color: '#d4cdc1',
        repeat: 1.3,
        normalScale: 0.96,
        aoMapIntensity: 0.9,
        envMapIntensity: 1.05,
        weather: {
          porosity: 0.72,
          puddleStrength: 0.72,
          puddleScale: 0.18,
          snowReceptivity: 0.70,
          wetRoughnessFloor: 0.042,
          wetRoughnessScale: 0.46,
          dampSheen: 0.26,
          cacheTag: 'plaza',
        },
      });
      enhancePavedBreakup(m, this.tier, 0.16);
      return m;
    });
  }

  /** Boardwalk Fair & riverside timber deck (Poly Haven oak planks with rain darkening & specular wood sheen). */
  boardwalk(): T.MeshStandardMaterial {
    return this.getOrCreate('boardwalk', () => {
      const m = this.buildPbr('oak_wood', {
        color: '#cfb28e',
        repeat: 1.25,
        normalScale: 0.82,
        aoMapIntensity: 0.78,
        envMapIntensity: 1.05,
        weather: {
          porosity: 0.74,
          puddleStrength: 0.54,
          puddleScale: 0.22,
          snowReceptivity: 0.76,
          wetRoughnessFloor: 0.055,
          wetRoughnessScale: 0.44,
          dampSheen: 0.22,
          cacheTag: 'boardwalk',
        },
      });
      enhancePavedBreakup(m, this.tier, 0.14);
      return m;
    });
  }

  /** Park & botanical garden lawns blending Poly Haven `grass_ground` with `park_dirt` trails + 4-season living turf! */
  parkLawn(variant: 'park' | 'garden'): T.MeshStandardMaterial {
    return this.getOrCreate(`lawn:${variant}`, () => {
      const m = this.buildPbr('grass_ground', {
        color: '#ffffff',
        repeat: 0.95,
        normalScale: 0.88,
        aoMapIntensity: 0.78,
        weather: {
          porosity: 0.48,
          puddleStrength: 0.14,
          puddleScale: 0.22,
          puddleRipples: false,
          snowReceptivity: 0.96,
          wetRoughnessFloor: 0.16,
          wetRoughnessScale: 0.58,
          dampSheen: 0.08,
          cacheTag: `lawn-${variant}`,
        },
      });
      const dirtSurf = this.tier === 'low' ? null : acquirePbrSurface('park_dirt', 1, 1, this.aniso, this.colorOnly);
      enhanceParkLawn(m, this.weather, dirtSurf, this.riverZ1, variant, this.tier);
      const dummy = m.userData.__srfDummy as T.DataTexture | undefined;
      if (dummy) this.ownedExtras.push(dummy);
      return m;
    });
  }

  /** Riverbank stone retaining wall with automatic world-Y capillary wetness & river moss band above `waterY`. */
  embankmentWall(): T.MeshStandardMaterial {
    return this.getOrCreate('embankment-wall', () =>
      this.buildPbr('stone_wall', {
        color: '#bdb6aa',
        repeat: 0.9,
        normalScale: 0.98,
        aoMapIntensity: 0.88,
        weather: {
          porosity: 0.80,
          puddleStrength: 0.18,
          puddleRipples: false,
          snowReceptivity: 0.42,
          wetRoughnessFloor: 0.09,
          wetRoughnessScale: 0.46,
          waterlineY: this.waterY,
          cacheTag: 'embankment',
        },
      }),
    );
  }

  /** Painted wrought-iron waterfront railing reflecting real HDRI sky & sunset highlights. */
  embankmentRail(): T.MeshStandardMaterial {
    return this.getOrCreate('embankment-rail', () => {
      const m = new T.MeshStandardMaterial({
        color: '#2c343e',
        roughness: 0.34,
        metalness: 0.85,
        envMapIntensity: 1.35,
      });
      m.name = 'srf:embankment-rail';
      patchWeatherWetness(m, this.weather, {
        tier: this.tier,
        porosity: 0.18,
        puddleStrength: 0,
        snowReceptivity: 0.28,
        wetRoughnessScale: 0.45,
        cacheTag: 'rail',
      });
      patchHeightFog(m, getSharedHeightFogUniforms());
      patchMaterialWithEchoCsm(m);
      return m;
    });
  }

  /** Distant far riverbank meadow strip across the river. */
  farBank(): T.MeshStandardMaterial {
    return this.getOrCreate('far-bank', () =>
      this.buildPbr('grass_ground', {
        color: '#6ba456',
        repeat: 0.45,
        normalScale: 0.6,
        aoMapIntensity: 0.65,
        weather: {
          porosity: 0.42,
          puddleStrength: 0,
          snowReceptivity: 0.94,
          wetRoughnessScale: 0.65,
          cacheTag: 'far-bank',
        },
      }),
    );
  }

  // ── Architectural Exteriors & Interiors ────────────────────────────────────────────────────────────────────

  /** Weather-reactive PBR exterior building wall (`stucco`, `beige`, `brick`, or `stone` plinth). */
  exteriorWall(hexColor: string, style: 'stucco' | 'beige' | 'brick' | 'stone' = 'stucco'): T.MeshStandardMaterial {
    const normHex = hexColor.toLowerCase();
    return this.getOrCreate(`ext-wall:${style}:${normHex}`, () => {
      const key: PbrSurfaceKey =
        style === 'brick' ? 'red_brick' : style === 'stone' ? 'stone_wall' : style === 'beige' ? 'wall_beige' : 'stucco_white';
      return this.buildPbr(key, {
        color: style === 'brick' ? '#ffffff' : normHex,
        repeat: style === 'brick' ? 1.15 : 0.85,
        normalScale: style === 'stucco' ? 0.72 : 0.92,
        aoMapIntensity: 0.78,
        weather: {
          porosity: 0.66,
          puddleStrength: 0,
          snowReceptivity: 0.12,
          wetRoughnessScale: 0.54,
          cacheTag: `ext-wall-${style}`,
        },
      });
    });
  }

  /** Weather-reactive PBR exterior roof (`pitched`: terracotta clay roof tiles; flat: weathered concrete slab). */
  exteriorRoof(hexColor = '#ffffff', pitched = false): T.MeshStandardMaterial {
    const normHex = hexColor.toLowerCase();
    return this.getOrCreate(`ext-roof:${pitched ? 'tile' : 'flat'}:${normHex}`, () =>
      this.buildPbr(pitched ? 'roof_tiles' : 'concrete', {
        color: pitched ? '#e8dfd8' : normHex,
        repeat: pitched ? 1.2 : 0.9,
        normalScale: pitched ? 1.05 : 0.82,
        aoMapIntensity: 0.85,
        weather: {
          porosity: 0.78,
          puddleStrength: pitched ? 0.16 : 0.62,
          puddleScale: 0.22,
          snowReceptivity: 0.92,
          wetRoughnessFloor: 0.05,
          wetRoughnessScale: 0.45,
          dampSheen: 0.20,
          cacheTag: pitched ? 'roof-tile' : 'roof-flat',
        },
      }),
    );
  }

  /** Exterior metal/wood architectural trims (window mullions, eaves cornices, awnings). */
  exteriorTrim(hexColor: string, metallic = false): T.MeshStandardMaterial {
    const normHex = hexColor.toLowerCase();
    return this.getOrCreate(`ext-trim:${metallic ? 'm' : 'p'}:${normHex}`, () =>
      this.buildPbr('stucco_white', {
        color: normHex,
        repeat: 1.4,
        roughness: metallic ? 0.36 : 0.76,
        metalness: metallic ? 0.72 : 0.04,
        normalScale: 0.28,
        aoMapIntensity: 0.45,
        weather: {
          porosity: metallic ? 0.25 : 0.55,
          puddleStrength: 0,
          snowReceptivity: 0.55,
          wetRoughnessScale: 0.48,
          cacheTag: metallic ? 'trim-m' : 'trim-p',
        },
      }),
    );
  }

  /**
   * Fine lime-plaster interior wall PBR material (bright white-normalized `stucco_white` base so `house.ts`
   * `setFinishes()` `vertexColors = true` preserves user room paint colors accurately while adding real micro-grain!).
   */
  interiorWall(hexColor: string): T.MeshStandardMaterial {
    const normHex = hexColor.toLowerCase();
    return this.getOrCreate(`int-wall:${normHex}`, () =>
      this.buildPbr('stucco_white', {
        color: normHex,
        repeat: 1.0,
        roughness: 0.94,
        normalScale: 0.32,
        aoMapIntensity: 0.42,
        weather: false,
      }),
    );
  }

  /** Calibrated interior floor PBR surfaces (`oak` parquet, `terrazzo`, `tile`, `concrete`). */
  interiorFloor(
    finish: 'oak' | 'parquet_rect' | 'terrazzo' | 'tile' | 'concrete',
    tint = '#ffffff',
  ): T.MeshStandardMaterial {
    const normHex = tint.toLowerCase();
    return this.getOrCreate(`int-floor:${finish}:${normHex}`, () => {
      const key: PbrSurfaceKey =
        finish === 'oak'
          ? 'parquet'
          : finish === 'parquet_rect'
            ? 'parquet_rect'
            : finish === 'terrazzo'
              ? 'terrazzo'
              : finish === 'tile'
                ? 'tiles_floor'
                : 'concrete';
      return this.buildPbr(key, {
        color: normHex,
        repeat: 1.25,
        normalScale: finish === 'terrazzo' ? 0.50 : 0.75,
        aoMapIntensity: 0.72,
        envMapIntensity: finish === 'terrazzo' || finish === 'tile' ? 1.15 : 0.95,
        weather: false,
      });
    });
  }

  /** Warm architectural timber (door jambs, stair treads, handrails, pergolas, shelves). */
  timber(hexColor = '#ffffff', dark = false, outdoors = false): T.MeshStandardMaterial {
    const normHex = hexColor.toLowerCase();
    return this.getOrCreate(`timber:${dark ? 'w' : 'o'}:${outdoors ? 'out' : 'in'}:${normHex}`, () =>
      this.buildPbr(dark ? 'walnut_wood' : 'oak_wood', {
        color: normHex,
        repeat: 1.4,
        normalScale: 0.72,
        aoMapIntensity: 0.7,
        weather: outdoors
          ? {
              porosity: 0.70,
              puddleStrength: 0.18,
              snowReceptivity: 0.58,
              wetRoughnessScale: 0.45,
              cacheTag: 'timber-out',
            }
          : false,
      }),
    );
  }

  /** Continuous weathered urban base apron sealing alleyways, setbacks & south-fringe lots (`G-03`). */
  urbanApron(): T.MeshStandardMaterial {
    return this.getOrCreate('urban-apron', () => {
      const m = this.buildPbr('concrete', {
        color: '#a8a299',
        repeat: 0.45,
        normalScale: 0.72,
        aoMapIntensity: 0.75,
        weather: {
          porosity: 0.74,
          puddleStrength: 0.42,
          puddleScale: 0.16,
          snowReceptivity: 0.74,
          wetRoughnessFloor: 0.055,
          wetRoughnessScale: 0.48,
          dampSheen: 0.22,
        },
      });
      enhancePavedBreakup(m, this.tier, 0.16);
      return m;
    });
  }

  /**
   * Shared vertex-colored architectural trim material (`outdoors` weather/CSM/fog patched, `indoors` clean PBR)
   * allowing `buildingsView.ts` to merge stone sills, mullions, frieze, and accent trims into 1 draw call per building!
   */
  vertexColoredTrim(outdoors = true): T.MeshStandardMaterial {
    return this.getOrCreate(`vc-trim:${outdoors ? 'out' : 'in'}`, () => {
      const m = new T.MeshStandardMaterial({
        color: '#ffffff',
        vertexColors: true,
        roughness: outdoors ? 0.64 : 0.56,
        metalness: outdoors ? 0.14 : 0.18,
        envMapIntensity: outdoors ? 1.05 : 0.95,
      });
      m.name = `srf:vc-trim:${outdoors ? 'out' : 'in'}`;
      if (outdoors) {
        patchWeatherWetness(m, this.weather, {
          tier: this.tier,
          porosity: 0.48,
          puddleStrength: 0,
          snowReceptivity: 0.52,
          wetRoughnessScale: 0.50,
          cacheTag: 'vc-trim',
        });
      }
      // Always chain Height Fog + CSM at creation time for both outdoor and indoor trims (canonical order).
      patchHeightFog(m, getSharedHeightFogUniforms());
      patchMaterialWithEchoCsm(m);
      return m;
    });
  }

  /**
   * Returns a pooled shared architectural glazed window handle (`shop`, `residential`, `library` presets)
   * with HDRI Fresnel sky reflection + single-pass tangent-space 3D interior parallax room glow at dusk/night.
   * Pooled & disposed once via `WorldSurfaceLibrary.dispose()` — zero material leak across building mounts/unmounts!
   */
  createGlass(opts: ArchitecturalGlassOptions = {}): ArchitecturalGlassHandle {
    const presetKey =
      opts.preset ??
      (opts.shop ? (opts.enterable ? 'shop-ent' : 'shop') : opts.enterable ? 'residential' : 'window');
    const tintKey = opts.tint !== undefined ? String(opts.tint).toLowerCase() : 'default';
    const key = `${presetKey}:${opts.shop ? 1 : 0}:${opts.enterable ? 1 : 0}:${tintKey}`;

    let pooled = this.glassPool.get(key);
    if (!pooled) {
      pooled = createArchitecturalGlass(this.tier, opts);
      this.glassPool.set(key, pooled);
      this.ownedExtras.push(pooled);
    }

    const shared = pooled;
    return {
      material: shared.material,
      setNight(night: number) {
        shared.setNight(night);
      },
      setCameraPos(pos: T.Vector3) {
        shared.setCameraPos(pos);
      },
      dispose() {
        // Pooled glass handle is shared across buildings and disposed once by `WorldSurfaceLibrary.dispose()`.
      },
    };
  }

  /**
   * Releases every material and shader helper created by this library instance.
   * Shared `pbrAtlas.ts` textures are managed by `disposePbrAtlas()` and are intentionally NOT disposed here.
   */
  dispose(): void {
    for (const m of this.ownedMaterials.values()) m.dispose();
    this.ownedMaterials.clear();
    this.glassPool.clear();
    for (const extra of this.ownedExtras) extra.dispose();
    this.ownedExtras.length = 0;
  }
}
