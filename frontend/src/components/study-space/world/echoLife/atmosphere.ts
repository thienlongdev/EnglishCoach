import * as T from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { acquireHdriEnv, selectHdriEnvKey, type HdriEnvKey } from './pbrAtlas';
import type { SharedWeatherUniforms, WeatherRenderTier } from './weatherSystem';
import type { WaterAtmosphereState } from './waterSurface';
import { chainMaterialShader, patchMaterialWithEchoCsm } from './echoCsm';
import { EchoLifeTimeSlicer } from './loadScheduler';

/**
 * Echo Life AAA — Calibrated inZOI Physical Atmosphere, HDRI PMREM Crossfade IBL,
 * Analytical Exponential Height Fog + Henyey-Greenstein Sun Scatter, & Sculpted Coastal Skyline Vista.
 *
 * Key upgrades:
 * 1. Physical outdoor sun-to-fill calibration: `3.6:1–4.0:1` midday & `~3.2:1` golden hour with cool sky-blue
 *    hemisphere shadow fill, balanced HDRI IBL (`0.38–0.44`), clamped `>= 12.1°` golden-hour shadow elevation,
 *    and explicit `isIndoors` / `outdoorLightSuppression` suppression of indoor `windowLight` & `fill` outdoors (`G-01`).
 * 2. Analytical Exponential Height Fog + Henyey-Greenstein Mie forward sun scatter (`patchHeightFog` /
 *    `getSharedHeightFogUniforms`) seamlessly synced to the sky horizon & `FogExp2`.
 * 3. Completely replaces the 44 blocky PS1 cubes with a sculpted 6-archetype contemporary downtown skyline +
 *    two-tier coastal mountain ridgeline + twin arched river bridges + far-bank embankment promenade, lush tree line,
 *    and warm dusk/night waterfront streetlamps (`<= 12` draw calls total, ZERO void horizon!).
 * 4. Preserves `scene.background = null` strictly for transparent Study Space Overview mode.
 */

export interface AtmosphereInput {
  /** Game clock hour in [0, 24). */
  hour: number;
  /** Season index: 0 = Spring, 1 = Summer, 2 = Autumn, 3 = Winter. */
  season: number;
  /** 0..1 active rainfall strength. */
  rain: number;
  /** 0..1 active snowfall strength. */
  snow: number;
  /** 0..1 total cloud cover. */
  cloud: number;
  /** True when the player is outdoors (street, park, plaza, balcony, garden); false indoors. */
  outdoors: boolean;
  /** True when reduced-motion accessibility preference is active. */
  reduced: boolean;
  /** Optional explicit outdoor fog density override (otherwise physically computed from weather + twilight). */
  baseFogDensity?: number;
}

export interface AtmosphereLightTargets {
  hemi: T.HemisphereLight;
  key: T.DirectionalLight;
  fill?: T.DirectionalLight;
  windowLight?: T.DirectionalLight;
  fog: T.FogExp2;
}

export interface AtmosphereSnapshot {
  day: number;
  night: number;
  goldenHour: number;
  twilight: number;
  sinAlt: number;
  sunVisibility: number;
  interiorBlend: number;
  /** True when predominantly indoors (`interiorBlend >= 0.5`). */
  isIndoors: boolean;
  /** 0.0 outdoors (strictly suppresses indoor `windowLight` & `fill`), 1.0 indoors, smooth during transition. */
  outdoorLightSuppression: number;
  sunDir: T.Vector3;
  moonDir: T.Vector3;
  keyDir: T.Vector3;
  sunColor: T.Color;
  keyColor: T.Color;
  keyIntensity: number;
  hemiSky: T.Color;
  hemiGround: T.Color;
  hemiIntensity: number;
  envIntensity: number;
  exposure: number;
  skyZenith: T.Color;
  skyHorizon: T.Color;
  sunsetColor: T.Color;
  sunsetWeight: number;
  fogColor: T.Color;
  fogDensity: number;
  fogHeightFalloff: number;
  fogBaseY: number;
  fogMieStrength: number;
  cloudCover: number;
  overcast: number;
}

/**
 * Explicit helper reporting whether the camera/player is indoors from either a boolean `outdoors` flag
 * or `AtmosphereSnapshot.interiorBlend` (`0 = outdoors`, `1 = indoors`).
 */
export function isIndoors(outdoorsOrInteriorBlend: boolean | number): boolean {
  if (typeof outdoorsOrInteriorBlend === 'boolean') return !outdoorsOrInteriorBlend;
  return outdoorsOrInteriorBlend >= 0.5;
}

/**
 * Multiplier (`0` outdoors .. `1` indoors) used to zero indoor `windowLight` & `fill` directional lights
 * outdoors (`G-01`) so outdoor sun-to-fill shadow contrast stays crisp at `3.2:1–4.0:1`.
 */
export function outdoorLightSuppression(outdoorsOrInteriorBlend: boolean | number): number {
  if (typeof outdoorsOrInteriorBlend === 'boolean') return outdoorsOrInteriorBlend ? 0 : 1;
  return smoothstep(0.08, 0.92, outdoorsOrInteriorBlend);
}

/** Resolves a 4-tier rendering preset (`ultra` on discrete RTX/RX GPUs, otherwise mirroring `high`/`balanced`/`low`). */
export function resolveAtmosphereTier(
  quality: 'ultra' | 'high' | 'balanced' | 'low',
  renderer?: T.WebGLRenderer | null,
): WeatherRenderTier {
  if (quality === 'ultra' || quality === 'balanced' || quality === 'low') return quality;
  if (!renderer) return 'high';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) ?? '');
    if (/(RTX|GeForce GTX 1[06]|Radeon RX [6789]|Apple M[234] (Pro|Max|Ultra))/i.test(name)) {
      return 'ultra';
    }
  } catch {
    // Fallback cleanly to high if debug extension is unavailable.
  }
  return 'high';
}

// ── Shared Analytical Exponential Height Fog + Henyey-Greenstein Sun Scatter ──────────────────────────────────

export interface SharedHeightFogUniforms {
  uHfColor: { value: T.Color };
  uHfSunColor: { value: T.Color };
  uHfSunDir: { value: T.Vector3 };
  /** (density, heightFalloff, baseY, enabled [0|1]) */
  uHfParams: { value: T.Vector4 };
  /** (mieG, mieStrength, maxOpacity, sunsetWeight) */
  uHfScatter: { value: T.Vector4 };
}

const SHARED_HEIGHT_FOG_UNIFORMS: SharedHeightFogUniforms = {
  uHfColor: { value: new T.Color('#bed7ee') },
  uHfSunColor: { value: new T.Color('#fff2dc') },
  uHfSunDir: { value: new T.Vector3(0.35, 0.72, -0.58).normalize() },
  uHfParams: { value: new T.Vector4(0.0012, 0.030, -3.2, 0) },
  uHfScatter: { value: new T.Vector4(0.76, 0.42, 0.94, 0) },
};

/** Returns the singleton shared Height Fog + HG Sun Scatter uniforms synced every frame by `AtmosphereSystem`. */
export function getSharedHeightFogUniforms(): SharedHeightFogUniforms {
  return SHARED_HEIGHT_FOG_UNIFORMS;
}

/**
 * Non-destructively chains analytical Exponential Height Fog + Henyey-Greenstein Mie sun scatter onto
 * any lit PBR material's `#include <fog_fragment>` chunk (0 extra render pass, 0 shader permutation explosion).
 */
export function patchHeightFog<M extends T.Material>(
  material: M,
  uniforms: SharedHeightFogUniforms = SHARED_HEIGHT_FOG_UNIFORMS,
): M {
  // Require a live Set tag so Material.clone() (which JSON-copies userData while dropping onBeforeCompile)
  // cleanly re-attaches height fog instead of silently skipping!
  const liveTags = material.userData.__ecShaderTags;
  if (material.userData.__echoHeightFogPatched && liveTags instanceof Set && liveTags.has('echo-hfog-v1')) {
    return material;
  }
  if (
    !(material instanceof T.MeshStandardMaterial) &&
    !(material instanceof T.MeshPhysicalMaterial) &&
    !(material instanceof T.MeshLambertMaterial) &&
    !(material instanceof T.MeshPhongMaterial)
  ) {
    return material;
  }
  material.userData.__echoHeightFogPatched = true;
  if (material.userData.__ecShaderTags && !(material.userData.__ecShaderTags instanceof Set)) {
    material.userData.__ecShaderTags = new Set<string>();
  }

  chainMaterialShader(material, 'echo-hfog-v1', (shader) => {
    if (!shader.fragmentShader.includes('#include <fog_fragment>')) return;

    shader.uniforms.uHfColor = uniforms.uHfColor;
    shader.uniforms.uHfSunColor = uniforms.uHfSunColor;
    shader.uniforms.uHfSunDir = uniforms.uHfSunDir;
    shader.uniforms.uHfParams = uniforms.uHfParams;
    shader.uniforms.uHfScatter = uniforms.uHfScatter;

    if (!shader.vertexShader.includes('varying vec3 vHfWorldPos;')) {
      shader.vertexShader =
        /* glsl */ `varying vec3 vHfWorldPos;\n` +
        shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          /* glsl */ `#include <worldpos_vertex>
  vec4 hfWp = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    hfWp = batchingMatrix * hfWp;
  #endif
  #ifdef USE_INSTANCING
    hfWp = instanceMatrix * hfWp;
  #endif
  vHfWorldPos = ( modelMatrix * hfWp ).xyz;
`,
        );
    }

    if (!shader.fragmentShader.includes('uniform vec4 uHfParams;')) {
      shader.fragmentShader =
        /* glsl */ `
varying vec3 vHfWorldPos;
uniform vec3 uHfColor;
uniform vec3 uHfSunColor;
uniform vec3 uHfSunDir;
uniform vec4 uHfParams;
uniform vec4 uHfScatter;
` + shader.fragmentShader;
    }

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `#include <opaque_fragment>
#ifdef USE_FOG
  // Apply analytical Exponential Height Fog + Henyey-Greenstein sun scatter in LINEAR HDR space
  // BEFORE <tonemapping_fragment> so horizon fog matches SkyDome, Skyline & Water identically on every tier!
  if ( uHfParams.w > 0.5 && uHfParams.x > 0.00001 ) {
    vec3 hfRay = vHfWorldPos - cameraPosition;
    float hfDist = length( hfRay );
    vec3 hfDir = hfRay / max( hfDist, 1e-4 );
    float hfFalloff = uHfParams.y;
    float hfCamH = max( 0.0, cameraPosition.y - uHfParams.z );
    float hfDy = hfRay.y * hfFalloff;
    float hfInt = abs( hfDy ) < 0.001
      ? ( 1.0 - 0.5 * hfDy )
      : ( ( 1.0 - exp( -hfDy ) ) / hfDy );
    float hfTau = uHfParams.x * exp( -hfFalloff * hfCamH ) * hfDist * clamp( hfInt, 0.0, 4.0 );
    float hfFactor = clamp( 1.0 - exp( -hfTau ), 0.0, uHfScatter.z );
    float hfCos = dot( hfDir, normalize( uHfSunDir ) );
    float hfG = uHfScatter.x;
    float hfG2 = hfG * hfG;
    float hfPhase = ( 1.0 - hfG2 ) / max( 0.05, pow( 1.0 + hfG2 - 2.0 * hfG * hfCos, 1.5 ) );
    float hfMie = clamp( hfPhase * 0.13 * uHfScatter.y, 0.0, 0.80 );
    vec3 hfCol = mix( uHfColor, uHfSunColor, hfMie * smoothstep( 18.0, 140.0, hfDist ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, hfCol, hfFactor );
  }
#endif
`,
      )
      .replace(
        '#include <fog_fragment>',
        /* glsl */ `
#ifdef USE_FOG
  if ( uHfParams.w <= 0.5 || uHfParams.x <= 0.00001 ) {
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  }
#endif
`,
      );
  });

  return material;
}

// ── PMREM CubeUV Crossfade Shader (~0.04 ms single pass, preserves exact Three.js CubeUV mip packing) ──────────

const PMREM_BLEND_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const PMREM_BLEND_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uEnvA;
uniform sampler2D uEnvB;
uniform float uMix;
uniform float uOvercast;
uniform vec3 uOvercastTint;
varying vec2 vUv;

void main() {
  vec3 a = texture2D( uEnvA, vUv ).rgb;
  vec3 b = texture2D( uEnvB, vUv ).rgb;
  vec3 env = mix( a, b, uMix );

  if ( uOvercast > 0.005 ) {
    float lum = dot( env, vec3( 0.2126, 0.7152, 0.0722 ) );
    vec3 muted = mix( env, vec3( lum ) * uOvercastTint, uOvercast * 0.58 );
    vec3 compressed = muted / ( 1.0 + muted * ( uOvercast * 0.24 ) );
    env = mix( env, compressed, uOvercast );
  }
  gl_FragColor = vec4( env, 1.0 );
}
`;

// ── Physical Rayleigh + Mie Sky Dome with Curved-Shell 5-Octave FBM Clouds & Cube-Projected Circular Stars ─────

const SKY_DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  // Early-Z sky dome rendered AFTER all opaque geometry (renderOrder = 999, depthTest = true):
  // occluded pixels indoors and behind buildings fail hardware depth test and skip fragment shading 100%!
  gl_Position = gl_Position.xyww;
  gl_Position.z = gl_Position.w * 0.999999;
}
`;

function buildSkyDomeFrag(tier: WeatherRenderTier): string {
  if (tier === 'low') {
    // Lean iGPU sky dome: analytic Rayleigh/Mie gradient + lightweight 1-layer 2-octave clouds (zero 3x warped FBM!).
    return /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uDay;
uniform float uNight;
uniform float uRain;
uniform float uSnow;
uniform float uSeason;
uniform float uCloudCover;
uniform float uSunsetWeight;
uniform float uTwilight;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunsetColor;
uniform vec3 uFogColor;
uniform vec2 uWindVec;

varying vec3 vDir;

float sHash12Low( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float sNoiseLow( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = sHash12Low( i );
  float b = sHash12Low( i + vec2( 1.0, 0.0 ) );
  float c = sHash12Low( i + vec2( 0.0, 1.0 ) );
  float d = sHash12Low( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

void main() {
  vec3 dir = normalize( vDir );
  vec3 sunDir = normalize( uSunDir );
  vec3 moonDir = normalize( uMoonDir );
  float h = clamp( dir.y, 0.0, 1.0 );
  float overcast = max( uRain, uSnow * 0.82 );
  float gloomy = max( overcast, smoothstep( 0.72, 0.96, uCloudCover ) * 0.72 );
  float clearDay = uDay * ( 1.0 - overcast ) * ( 1.0 - smoothstep( 0.65, 0.94, uCloudCover ) * 0.75 );

  float skyGrad = pow( 1.0 - h, mix( 2.1, 1.25, gloomy ) );
  vec3 sky = mix( uSkyZenith * ( 1.0 + 0.15 * clearDay ), uSkyHorizon * ( 1.0 + 0.14 * clearDay ), skyGrad );

  float sunDot = max( dot( dir, sunDir ), 0.0 );
  vec3 sunsetBand = uSunsetColor * uSunsetWeight * pow( 1.0 - h, 2.2 ) * ( 0.45 + 0.55 * sunDot * sunDot );
  vec3 mieGlow = uSunColor * ( pow( sunDot, 8.0 ) * 0.35 + pow( sunDot, 64.0 ) * 0.55 ) * ( 0.18 + 0.82 * uDay ) * ( 1.0 - overcast * 0.72 );
  sky += sunsetBand + mieGlow * ( 0.22 + 0.78 * pow( 1.0 - h, 1.8 ) );

  vec3 stormSky = mix( vec3( 0.06, 0.08, 0.13 ), vec3( 0.44, 0.50, 0.58 ), uDay );
  sky = mix( sky, stormSky, max( overcast * 0.62, smoothstep( 0.76, 0.98, uCloudCover ) * 0.44 ) );

  // Lightweight 1-layer 2-octave analytic cloud deck (zero domain-warp FBM, zero shadow-march loop).
  float cloudTransmittance = 1.0;
  if ( dir.y > 0.0 ) {
    float horizonFade = smoothstep( 0.0, 0.10, dir.y );
    vec2 uv = ( dir.xz / ( dir.y + 0.18 ) ) * 0.48 + uWindVec * ( uTime * 0.006 );
    float n = sNoiseLow( uv ) * 0.66 + sNoiseLow( uv * 2.15 + vec2( 7.3, 13.1 ) ) * 0.34;
    float effCloud = max( uCloudCover, 0.14 * uDay * ( 1.0 - overcast ) );
    float cAlpha = smoothstep( mix( 0.62, 0.32, effCloud ), mix( 0.82, 0.56, effCloud ), n ) * horizonFade;
    vec3 cloudCol = mix(
      vec3( 0.10, 0.14, 0.22 ),
      mix( vec3( 1.08, 1.10, 1.14 ), vec3( 0.52, 0.57, 0.64 ), overcast * 0.78 ),
      uDay
    );
    cloudCol = mix( cloudCol, uSunsetColor * 1.15 + vec3( 0.12, 0.06, 0.04 ), uSunsetWeight * 0.72 );
    cloudCol = mix( uFogColor, cloudCol, smoothstep( 0.0, 0.16, dir.y ) );
    sky = mix( sky, cloudCol, clamp( cAlpha * 0.82, 0.0, 0.90 ) );
    cloudTransmittance = 1.0 - cAlpha * 0.82;
  }

  // Clean sun & moon disc highlights.
  if ( uDay > 0.01 && sunDir.y > -0.04 ) {
    float sDisc = smoothstep( 0.99965, 0.99990, dot( dir, sunDir ) );
    sky += uSunColor * sDisc * 3.2 * ( 1.0 - overcast * 0.85 ) * cloudTransmittance;
  }
  float moonVis = smoothstep( 0.45, 0.06, uDay ) * ( 1.0 - overcast * 0.85 );
  if ( moonVis > 0.004 && dir.y > -0.02 ) {
    float mDot = dot( dir, moonDir );
    sky += vec3( 0.56, 0.68, 0.88 ) * pow( max( mDot, 0.0 ), 32.0 ) * moonVis * 0.24;
    sky += vec3( 0.94, 0.96, 1.0 ) * smoothstep( 0.9995, 0.99985, mDot ) * moonVis * 1.25;
  }

  if ( dir.y < 0.02 ) {
    sky = mix( sky, uFogColor, smoothstep( 0.02, -0.08, dir.y ) );
  }

  gl_FragColor = vec4( sky, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
  }

  const octaves = tier === 'ultra' || tier === 'high' ? 5 : 4;
  const shadowSteps = tier === 'ultra' ? 4 : tier === 'high' ? 3 : 2;
  const enableCirrus = true;

  return /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uDay;
uniform float uNight;
uniform float uRain;
uniform float uSnow;
uniform float uSeason;
uniform float uCloudCover;
uniform float uSunsetWeight;
uniform float uTwilight;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunsetColor;
uniform vec3 uFogColor;
uniform vec2 uWindVec;

varying vec3 vDir;

const float PI = 3.14159265359;

float sHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

vec3 sHash32( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yxz + 33.33 );
  return fract( ( p3.xxy + p3.yzz ) * p3.zyx );
}

float sNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  float a = sHash12( i );
  float b = sHash12( i + vec2( 1.0, 0.0 ) );
  float c = sHash12( i + vec2( 0.0, 1.0 ) );
  float d = sHash12( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

float sFbm( vec2 p ) {
  const mat2 rot = mat2( 0.80, -0.60, 0.60, 0.80 );
  float v = 0.0;
  float amp = 0.50;
  for ( int i = 0; i < ${octaves}; i++ ) {
    v += amp * sNoise( p );
    p = rot * p * 2.03 + vec2( 19.7, 37.3 );
    amp *= 0.50;
  }
  return v;
}

vec2 projectCloudShell( vec3 dir, float altKm ) {
  const float R = 6371.0;
  float y = max( dir.y, 0.012 );
  float b = R * y;
  float t = sqrt( b * b + 2.0 * R * altKm + altKm * altKm ) - b;
  return ( dir.xz * t ) / max( altKm * 2.4, 1.0 );
}

float hgPhase( float cosTheta, float g ) {
  float g2 = g * g;
  return ( 1.0 - g2 ) / max( 1e-4, 4.0 * PI * pow( 1.0 + g2 - 2.0 * g * cosTheta, 1.5 ) );
}

float sampleCumulus( vec2 uv, vec2 windOff, float coverage ) {
  vec2 q = uv * 0.46 + windOff;
  float warpA = sFbm( q * 0.82 + vec2( 2.3, 5.1 ) );
  float warpB = sFbm( q * 0.82 + vec2( 8.7, 1.4 ) );
  float base = sFbm( q + vec2( warpA - 0.5, warpB - 0.5 ) * 0.78 );
  float erode = sNoise( q * 3.1 - windOff * 1.3 );
  float shaped = base - ( 1.0 - erode ) * 0.095 * ( 1.0 - coverage * 0.55 );
  float lo = mix( 0.555, 0.28, coverage );
  float hi = mix( 0.695, 0.50, coverage );
  return smoothstep( lo, hi, shaped );
}

vec3 evalStarLayer( vec3 d, float scale, float densityThresh, float time ) {
  vec3 ad = abs( d );
  vec2 faceUv;
  float faceId;
  if ( ad.y >= ad.x && ad.y >= ad.z ) {
    faceUv = d.xz / max( ad.y, 1e-4 );
    faceId = d.y > 0.0 ? 1.0 : 2.0;
  } else if ( ad.x >= ad.z ) {
    faceUv = d.zy / max( ad.x, 1e-4 );
    faceId = d.x > 0.0 ? 3.0 : 4.0;
  } else {
    faceUv = d.xy / max( ad.z, 1e-4 );
    faceId = d.z > 0.0 ? 5.0 : 6.0;
  }

  vec2 grid = faceUv * scale;
  vec2 cell = floor( grid );
  vec2 f = fract( grid );
  vec3 rnd = sHash32( cell + vec2( faceId * 71.3, scale * 0.17 ) );
  if ( rnd.z < densityThresh ) return vec3( 0.0 );

  vec2 center = 0.20 + rnd.xy * 0.60;
  float dist = length( f - center );
  float mag = ( rnd.z - densityThresh ) / max( 1e-4, 1.0 - densityThresh );
  float radius = mix( 0.045, 0.105, mag );
  float disc = smoothstep( radius, 0.0, dist );
  float twinkle = 0.68 + 0.32 * sin( time * ( 1.6 + rnd.x * 3.2 ) + rnd.y * 62.8 );

  vec3 tint = rnd.x < 0.33
    ? vec3( 0.74, 0.85, 1.0 )
    : rnd.x < 0.72
      ? vec3( 0.98, 0.97, 0.95 )
      : vec3( 1.0, 0.86, 0.66 );
  return tint * ( disc * disc * ( 0.45 + 1.35 * mag * mag ) * twinkle );
}

void main() {
  vec3 dir = normalize( vDir );
  vec3 sunDir = normalize( uSunDir );
  vec3 moonDir = normalize( uMoonDir );
  float h = clamp( dir.y, 0.0, 1.0 );
  float overcast = max( uRain, uSnow * 0.82 );

  float gloomy = max( overcast, smoothstep( 0.72, 0.96, uCloudCover ) * 0.72 );
  float clearDay = uDay * ( 1.0 - overcast ) * ( 1.0 - smoothstep( 0.65, 0.94, uCloudCover ) * 0.75 );
  float airMass = 1.0 / ( h + 0.15 * pow( h * 57.2958 + 3.885, -1.253 ) );
  float rayleighCurve = 1.0 - exp( -airMass * mix( 0.135, 0.25, gloomy ) );
  float skyGrad = pow( rayleighCurve, mix( 1.28, 0.84, gloomy ) );
  float clearSunBoost = 1.0 + 0.20 * clearDay * ( 1.0 - uSunsetWeight * 0.75 );
  vec3 sky = mix( uSkyZenith * ( 1.0 + 0.18 * clearDay ), uSkyHorizon * clearSunBoost, skyGrad );

  float sunDot = dot( dir, sunDir );
  float sunCos = max( sunDot, 0.0 );
  float antiSolar = max( -sunDot, 0.0 );
  vec3 venusBelt = vec3( 0.72, 0.44, 0.56 ) * uSunsetWeight * pow( 1.0 - h, 2.4 ) * ( 0.35 + 0.65 * antiSolar ) * 0.38;
  sky += venusBelt;

  float miePhase = hgPhase( sunDot, 0.76 );
  float turbidity = 0.74 + ( uSeason > 1.5 && uSeason < 2.5 ? 0.32 : 0.0 ) + overcast * 0.55;
  vec3 sunsetBand = uSunsetColor * uSunsetWeight * pow( 1.0 - h, 2.25 ) * ( 0.42 + 0.58 * pow( sunCos, 2.0 ) );
  vec3 mieGlow = uSunColor * min( 2.8, miePhase * 0.44 ) * turbidity * ( 0.16 + 0.84 * uDay ) * ( 1.0 - overcast * 0.72 );
  sky += sunsetBand + mieGlow * ( 0.14 + 0.86 * pow( 1.0 - h, 2.2 ) );

  vec3 stormSky = mix( vec3( 0.06, 0.08, 0.13 ), vec3( 0.44, 0.50, 0.58 ), uDay );
  if ( uSnow > 0.15 ) stormSky = mix( stormSky, vec3( 0.68, 0.74, 0.82 ) * ( 0.18 + 0.82 * uDay ), uSnow * 0.65 );
  float stormMix = max( overcast * 0.62, smoothstep( 0.76, 0.98, uCloudCover ) * 0.46 );
  sky = mix( sky, stormSky, stormMix );

  float starMask = smoothstep( 0.32, 0.02, uDay ) * ( 1.0 - uCloudCover * 0.88 ) * smoothstep( 0.03, 0.26, h );
  if ( starMask > 0.004 ) {
    vec3 stars = evalStarLayer( dir, 130.0, 0.965, uTime )
               + evalStarLayer( dir, 225.0, 0.974, uTime * 1.15 ) * 0.68;
    sky += stars * starMask;
  }

  float moonVis = smoothstep( 0.45, 0.06, uDay ) * ( 1.0 - overcast * 0.85 );
  if ( moonVis > 0.004 && dir.y > -0.02 ) {
    float mDot = dot( dir, moonDir );
    sky += vec3( 0.56, 0.68, 0.88 ) * pow( max( mDot, 0.0 ), 36.0 ) * moonVis * 0.28;
    float moonRad = radians( 0.68 );
    float mAng = acos( clamp( mDot, -1.0, 1.0 ) );
    if ( mAng < moonRad * 1.15 ) {
      vec3 mRight = normalize( cross( vec3( 0.0, 1.0, 0.0 ), moonDir ) );
      vec3 mUp = cross( moonDir, mRight );
      vec2 mUv = vec2( dot( dir - moonDir, mRight ), dot( dir - moonDir, mUp ) ) / moonRad;
      float r2 = dot( mUv, mUv );
      float disc = smoothstep( 1.04, 0.92, sqrt( r2 ) );
      float maria = 0.78 + 0.22 * sNoise( mUv * 3.6 + vec2( 1.7, 2.9 ) );
      vec3 mNorm = vec3( mUv, sqrt( max( 0.0, 1.0 - r2 ) ) );
      float phase = smoothstep( -0.18, 0.38, dot( mNorm, normalize( vec3( 0.55, 0.22, 0.78 ) ) ) );
      vec3 moonCol = vec3( 0.92, 0.94, 0.98 ) * maria * ( 0.14 + 0.86 * phase );
      sky = mix( sky, sky + moonCol * 1.35 * moonVis, disc );
    }
  }

  float sunDiscMask = 0.0;
  vec3 sunDiscRadiance = vec3( 0.0 );
  if ( uDay > 0.01 && sunDir.y > -0.04 ) {
    float sRad = radians( 0.62 );
    float sAng = acos( clamp( sunDot, -1.0, 1.0 ) );
    float edge = smoothstep( sRad * 1.12, sRad * 0.78, sAng );
    float limb = pow( clamp( 1.0 - ( sAng / sRad ) * ( sAng / sRad ), 0.0, 1.0 ), 0.35 );
    sunDiscMask = edge;
    sunDiscRadiance = uSunColor * ( 1.8 + 2.4 * limb ) * smoothstep( -0.03, 0.06, sunDir.y ) * ( 1.0 - overcast * 0.85 );
  }

  float cloudTransmittance = 1.0;
  if ( dir.y > -0.02 ) {
    float horizonFade = smoothstep( 0.0, 0.09, dir.y );
    vec2 windDrift = uWindVec * ( uTime * 0.0085 );

    ${
      enableCirrus
        ? /* glsl */ `
    vec2 cirrusUv = projectCloudShell( dir, 6.8 ) * vec2( 0.38, 0.72 ) + windDrift * 0.45;
    float cirN = sFbm( cirrusUv + vec2( sNoise( cirrusUv * 1.6 ) * 0.65 ) );
    float cirrusAlpha = smoothstep( 0.60 - uCloudCover * 0.18, 0.84 - uCloudCover * 0.10, cirN ) * horizonFade * ( 0.28 + 0.20 * ( 1.0 - overcast ) );
    vec3 cirrusCol = mix( vec3( 0.11, 0.14, 0.22 ), vec3( 1.12, 1.15, 1.20 ), uDay );
    cirrusCol = mix( cirrusCol, uSunsetColor * 1.15 + vec3( 0.16, 0.06, 0.08 ), uSunsetWeight * 0.82 );
    sky = mix( sky, cirrusCol, cirrusAlpha * ( 1.0 - overcast * 0.5 ) );
    `
        : ''
    }

    vec2 cumUv = projectCloudShell( dir, 1.85 );
    float effCloud = max( uCloudCover, 0.16 * uDay * ( 1.0 - overcast ) );
    float density = sampleCumulus( cumUv, windDrift, effCloud );
    float cloudAlpha = density * horizonFade * smoothstep( 0.02, 0.16, effCloud + density * 0.35 );

    if ( cloudAlpha > 0.004 ) {
      vec3 lightDir = uDay > 0.12 ? sunDir : moonDir;
      vec2 stepDir = lightDir.xz / max( 0.32, lightDir.y + 0.38 );
      float tau = 0.0;
      ${
        shadowSteps > 0
          ? /* glsl */ `
      for ( int s = 1; s <= ${shadowSteps}; s++ ) {
        float fs = float( s ) * 0.18;
        tau += sampleCumulus( cumUv + stepDir * fs, windDrift, effCloud ) * ( 1.0 / float( ${shadowSteps} ) );
      }
      `
          : 'tau = density * 0.65;'
      }

      float stormDark = max( overcast * 0.78, smoothstep( 0.74, 0.98, uCloudCover ) * 0.56 );
      float beer = exp( -tau * ( 1.38 + stormDark * 1.35 ) );
      float powder = 1.0 - exp( -density * 2.4 );
      float lightDot = dot( dir, lightDir );
      float phase = mix( hgPhase( lightDot, 0.68 ), hgPhase( lightDot, -0.22 ), 0.36 );
      float silverLining = clamp( phase * 0.55, 0.0, 1.35 ) * beer * ( 0.35 + 0.65 * powder );

      vec3 litBase = mix(
        vec3( 0.15, 0.20, 0.30 ),
        mix( vec3( 1.24, 1.25, 1.27 ), vec3( 0.56, 0.61, 0.68 ), stormDark ),
        uDay
      );
      vec3 shadowBase = mix(
        vec3( 0.045, 0.06, 0.105 ),
        mix( vec3( 0.48, 0.66, 0.90 ), vec3( 0.20, 0.24, 0.31 ), stormDark ),
        uDay
      );
      litBase = mix( litBase, uSunsetColor * 1.25 + vec3( 0.18, 0.10, 0.04 ), uSunsetWeight * 0.85 );
      shadowBase = mix( shadowBase, vec3( 0.34, 0.24, 0.36 ), uSunsetWeight * 0.62 );
      if ( uSnow > 0.15 ) {
        shadowBase = mix( shadowBase, vec3( 0.58, 0.63, 0.70 ) * ( 0.20 + 0.80 * uDay ), uSnow * 0.55 );
      }

      float litFactor = clamp( beer * ( 0.62 + 0.38 * powder ) + silverLining * 0.48, 0.0, 1.25 );
      vec3 cloudCol = mix( shadowBase, litBase, clamp( litFactor, 0.0, 1.0 ) );
      cloudCol += uSunColor * silverLining * ( 0.36 * uDay + 0.55 * uSunsetWeight ) * ( 1.0 - overcast * 0.65 );

      cloudCol = mix( uFogColor, cloudCol, smoothstep( 0.0, 0.14, dir.y ) );
      sky = mix( sky, cloudCol, clamp( cloudAlpha * ( 0.86 + 0.12 * overcast ), 0.0, 0.97 ) );
      cloudTransmittance = clamp( 1.0 - cloudAlpha * 0.92, 0.0, 1.0 );
    }
  }

  sky += sunDiscRadiance * sunDiscMask * cloudTransmittance;

  if ( dir.y < 0.02 ) {
    sky = mix( sky, uFogColor, smoothstep( 0.02, -0.08, dir.y ) );
  }

  gl_FragColor = vec4( sky, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
}

// ── Sculpted AAA Downtown Skyline + Coastal Mountain Ridgeline + Arched Bridges + Far-Bank Vista (<= 12 Draws) ──

const SKYLINE_VERT = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vHeightFrac;
varying float vTowerSeed;
varying float vMatTag; // 0 = tower facade, 1 = cornice/parapet trim, 2 = spire/beacon

void main() {
  vHeightFrac = clamp( uv.y, 0.0, 1.5 );
  vMatTag = uv.y > 1.05 ? 2.0 : ( uv.x < -0.5 ? 1.0 : 0.0 );
  vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
  vWorldPos = wp.xyz;
  vWorldNormal = normalize( mat3( modelMatrix * instanceMatrix ) * normal );
  vec3 origin = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  vTowerSeed = fract( sin( dot( origin.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SKYLINE_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uDay;
uniform float uNight;
uniform float uSunsetWeight;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform vec3 uSunsetColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogBaseY;
uniform float uFogMieStrength;
uniform vec3 uCam;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vHeightFrac;
varying float vTowerSeed;
varying float vMatTag;

float tHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float tNoise12( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( tHash12( i ), tHash12( i + vec2( 1.0, 0.0 ) ), u.x ),
    mix( tHash12( i + vec2( 0.0, 1.0 ) ), tHash12( i + vec2( 1.0, 1.0 ) ), u.x ),
    u.y
  );
}

vec3 applySkylineHeightFog( vec3 col, vec3 worldPos, vec3 sunDir ) {
  vec3 ray = worldPos - cameraPosition;
  float dist = length( ray );
  vec3 dir = ray / max( dist, 1e-4 );
  float camH = max( 0.0, cameraPosition.y - uFogBaseY );
  float dy = ray.y * uFogFalloff;
  float integral = abs( dy ) < 0.001 ? ( 1.0 - 0.5 * dy ) : ( ( 1.0 - exp( -dy ) ) / dy );
  float tau = uFogDensity * exp( -uFogFalloff * camH ) * dist * clamp( integral, 0.0, 4.0 );
  float fogF = clamp( 1.0 - exp( -tau ), 0.0, 0.90 );
  // Subtle cool-blue Rayleigh aerial perspective + HG sun scatter
  float hgCos = dot( dir, sunDir );
  float g = 0.76;
  float hg = ( 1.0 - g * g ) / max( 0.05, pow( 1.0 + g * g - 2.0 * g * hgCos, 1.5 ) );
  float mie = clamp( hg * 0.12 * uFogMieStrength * ( 0.25 + 0.75 * uDay ), 0.0, 0.65 );
  vec3 scatterCol = mix( uFogColor, mix( uSunColor, uSunsetColor, uSunsetWeight * 0.7 ), mie );
  // Keep foreground waterfront midrises crisp (baseMist 0.08 < 120 m) while retaining gentle horizon aerial depth.
  float baseMistAmt = mix( 0.08, 0.15, smoothstep( 120.0, 220.0, dist ) );
  float baseMist = smoothstep( 12.0, -3.5, worldPos.y ) * baseMistAmt * ( 0.40 + 0.60 * uDay );
  return mix( col, scatterCol, clamp( max( fogF, baseMist ), 0.0, 0.92 ) );
}

void main() {
  vec3 N = normalize( vWorldNormal );
  vec3 V = normalize( cameraPosition - vWorldPos );
  vec3 L = normalize( uSunDir );

  // Rooftop tapered architectural spire & warm night aviation beacon tip (real directional metal PBR + Fresnel + fog!).
  if ( vMatTag > 1.5 ) {
    vec3 metalAlb = mix( vec3( 0.16, 0.20, 0.28 ), vec3( 0.64, 0.69, 0.76 ), uDay );
    float NdotL = max( dot( N, L ), 0.0 );
    vec3 H = normalize( L + V );
    float spec = pow( max( dot( N, H ), 0.0 ), 44.0 ) * ( 1.45 * uDay + 1.15 * uSunsetWeight );
    float fresnel = 0.08 + 0.92 * pow( 1.0 - max( dot( N, V ), 0.0 ), 4.0 );
    vec3 R = reflect( -V, N );
    vec3 skyRefl = mix( uSkyHorizon, uSkyZenith, clamp( R.y * 0.65 + 0.35, 0.0, 1.0 ) )
                 + uSunsetColor * uSunsetWeight * pow( max( dot( R, L ), 0.0 ), 4.0 ) * 0.85;
    vec3 sunLit = uSunColor * NdotL * ( 0.95 * uDay + 0.65 * uSunsetWeight );
    vec3 skyAmb = mix( uSkyHorizon * 0.38, uSkyZenith * 0.54, 0.5 + 0.5 * N.y ) * ( 0.24 + 0.44 * uDay );
    vec3 metalCol = mix( metalAlb * ( sunLit + skyAmb ), skyRefl * ( 0.55 + 0.45 * uDay ), fresnel * 0.58 )
                  + uSunColor * spec;
    // Subtle vertical crown-to-needle sheen gradient
    metalCol *= 0.86 + 0.22 * smoothstep( 1.05, 1.45, vHeightFrac );
    float pulse = 0.35 + 0.65 * pow( 0.5 + 0.5 * sin( uTime * 2.2 + vTowerSeed * 18.0 ), 3.0 );
    float hasBeacon = step( 0.42, vTowerSeed ) * smoothstep( 1.28, 1.46, vHeightFrac );
    vec3 beacon = mix( vec3( 1.95, 0.32, 0.14 ), vec3( 2.15, 0.68, 0.24 ), step( 0.72, vTowerSeed ) )
                * hasBeacon * pulse * ( 0.18 + 0.82 * uNight );
    vec3 col = applySkylineHeightFog( metalCol + beacon, vWorldPos, L );
    gl_FragColor = vec4( col, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }

  // Diverse coastal metropolitan palette (zero monochrome blue-block look!):
  // warm cream travertine, warm precast concrete, bronze-champagne anodized cladding,
  // warm terracotta-brick accent midrises, and slate/bronze architectural curtain walls.
  float isGlass = step( 0.60, vTowerSeed );
  float isBronzeCurtain = isGlass * ( 1.0 - step( 0.78, vTowerSeed ) );
  float matIdx = fract( vTowerSeed * 4.31 );
  vec3 masonryDay = matIdx < 0.32
    ? vec3( 0.80, 0.75, 0.68 ) // warm cream travertine limestone
    : matIdx < 0.62
      ? vec3( 0.68, 0.65, 0.60 ) // warm architectural precast concrete
      : matIdx < 0.84
        ? vec3( 0.57, 0.52, 0.46 ) // bronze-champagne anodized cladding
        : vec3( 0.62, 0.46, 0.38 ); // warm coastal terracotta-brick midrise
  vec3 curtainDay = isBronzeCurtain > 0.5
    ? mix( vec3( 0.48, 0.44, 0.39 ), vec3( 0.58, 0.53, 0.46 ), fract( vTowerSeed * 9.7 ) )
    : mix( vec3( 0.34, 0.41, 0.48 ), vec3( 0.43, 0.49, 0.54 ), fract( vTowerSeed * 7.3 ) );
  vec3 wallDay = isGlass > 0.5 ? curtainDay : masonryDay;

  vec2 faceCoord = abs( N.x ) > abs( N.z ) ? vWorldPos.zy : vWorldPos.xy;
  // Procedural precast cladding panel joint grid + 2-octave stone/concrete micro-grain (0 texture fetches).
  float grain1 = tNoise12( faceCoord * 0.78 + vec2( vTowerSeed * 19.3, 4.1 ) );
  float grain2 = tNoise12( faceCoord * 2.35 + vec2( 7.7, vTowerSeed * 31.7 ) );
  float stoneGrain = grain1 * 0.62 + grain2 * 0.38;
  vec2 panelUv = fract( faceCoord / ( isGlass > 0.5 ? vec2( 2.1, 3.3 ) : vec2( 1.45, 1.75 ) ) );
  float seamH = smoothstep( 0.0, 0.045, panelUv.y ) * smoothstep( 1.0, 0.955, panelUv.y );
  float seamV = smoothstep( 0.0, 0.035, panelUv.x ) * smoothstep( 1.0, 0.965, panelUv.x );
  float panelSeam = mix( 0.88, 1.0, min( seamH, seamV ) );
  wallDay *= ( 0.93 + 0.14 * stoneGrain ) * panelSeam;

  vec3 wallNight = wallDay * vec3( 0.15, 0.17, 0.23 );
  vec3 wallBase = mix( wallNight, wallDay, uDay );

  // Directional key + warm/cool architectural hemisphere bounce + podium base AO
  float grainBump = ( stoneGrain - 0.5 ) * 0.08;
  float NdotL = clamp( max( dot( N, L ), 0.0 ) + grainBump * step( 0.05, dot( N, L ) ), 0.0, 1.0 );
  float baseAo = 0.66 + 0.34 * smoothstep( 0.0, 0.24, vHeightFrac );
  vec3 sunBounce = uSunColor * NdotL * ( 1.02 * uDay + 0.66 * uSunsetWeight );
  vec3 skyAmb = mix( uSkyHorizon * 0.40, uSkyZenith * 0.48, 0.5 + 0.5 * N.y ) * ( 0.24 + 0.40 * uDay );
  vec3 litSurface = wallBase * ( sunBounce + skyAmb ) * baseAo;

  // Roof parapets, mechanical terrace decks & structural cornice bands
  if ( vMatTag > 0.5 || abs( N.y ) > 0.78 ) {
    vec3 trimCol = litSurface * ( abs( N.y ) > 0.78 ? 0.86 : 0.78 );
    // Subtle sunlit top cornice highlight catches directional sunlight cleanly on stepped midrises
    trimCol += wallBase * uSunColor * ( 0.12 * uDay ) * step( 0.5, N.y );
    // Subtle architectural parapet crown uplighting at dusk & night
    float crownGlow = smoothstep( 0.65, 0.98, vHeightFrac ) * smoothstep( 0.55, 0.08, uDay );
    vec3 uplight = mix( vec3( 0.95, 0.76, 0.46 ), vec3( 0.62, 0.78, 1.0 ), step( 0.62, vTowerSeed ) );
    trimCol += uplight * crownGlow * 0.24;
    vec3 col = applySkylineHeightFog( trimCol, vWorldPos, L );
    gl_FragColor = vec4( col, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }

  // Sculpted curtain-wall mullions, structural pilasters, spandrel bands & recessed window bays
  vec2 baySize = isGlass > 0.5 ? vec2( 2.1, 3.3 ) : vec2( 2.55, 3.45 );
  vec2 cell = floor( faceCoord / baySize );
  vec2 g = fract( faceCoord / baySize );

  // Double-height ground-floor storefront podium colonnade & mid-tower louvered mechanical floor band
  float isPodium = 1.0 - smoothstep( 0.095, 0.115, vHeightFrac );
  float isMechBand = smoothstep( 0.615, 0.625, vHeightFrac ) * smoothstep( 0.675, 0.665, vHeightFrac ) * step( 0.28, vTowerSeed );

  // Protruding vertical architectural pilasters every 3rd column create strong sunlit vertical rhythm
  float pilasterCol = 1.0 - step( 0.5, mod( abs( cell.x ) + floor( vTowerSeed * 7.0 ), 3.0 ) );
  float pilasterStrip = pilasterCol * ( 1.0 - smoothstep( 0.10, 0.14, g.x ) * smoothstep( 0.90, 0.86, g.x ) );
  litSurface *= 1.0 + pilasterStrip * ( 0.14 * NdotL - 0.06 * ( 1.0 - NdotL ) );
  // Subtle horizontal floor-slab spandrel shadow line separating stories
  float spandrelShadow = mix( 0.82, 1.0, smoothstep( 0.02, 0.13, g.y ) );
  litSurface *= spandrelShadow;
  // Slightly darker polished stone colonnade at ground podium
  litSurface *= mix( 1.0, 0.84, isPodium );

  float edgeX = isPodium > 0.5 ? 0.14 : ( isGlass > 0.5 ? 0.075 : 0.17 );
  float edgeY0 = isPodium > 0.5 ? 0.06 : ( isGlass > 0.5 ? 0.20 : 0.24 );
  float edgeY1 = isPodium > 0.5 ? 0.92 : ( isGlass > 0.5 ? 0.88 : 0.84 );
  float winX = smoothstep( edgeX - 0.02, edgeX + 0.02, g.x ) * smoothstep( 1.0 - edgeX + 0.02, 1.0 - edgeX - 0.02, g.x );
  float winY = smoothstep( edgeY0 - 0.02, edgeY0 + 0.02, g.y ) * smoothstep( edgeY1 + 0.02, edgeY1 - 0.02, g.y );
  float winMask = winX * winY * smoothstep( 0.975, 0.93, vHeightFrac ) * smoothstep( 0.015, 0.045, vHeightFrac ) * ( 1.0 - isMechBand );

  // Bright sunlit projecting window sill lip directly beneath each recessed masonry/cladding window bay
  float sillBand = winX * smoothstep( edgeY0 - 0.07, edgeY0 - 0.035, g.y ) * smoothstep( edgeY0 + 0.01, edgeY0 - 0.015, g.y ) * ( 1.0 - isMechBand );
  litSurface += wallBase * ( sunBounce * 0.24 + skyAmb * 0.10 ) * sillBand * ( isGlass > 0.5 ? 0.45 : 1.0 );

  // Recessed louvered mechanical floor band (horizontal dark anodized aluminum slats)
  if ( isMechBand > 0.02 ) {
    float louver = 0.55 + 0.45 * sin( faceCoord.y * 15.0 );
    vec3 mechCol = wallBase * ( 0.34 + 0.22 * louver ) * ( sunBounce * 0.7 + skyAmb );
    litSurface = mix( litSurface, mechCol, isMechBand * 0.92 );
  }

  // Per-pane normal jitter + Fresnel sky/sunset reflection
  float paneRnd = tHash12( cell + vec2( vTowerSeed * 71.0, 13.0 ) );
  float paneRnd2 = tHash12( cell * 1.73 + vec2( 29.1, vTowerSeed * 53.0 ) );
  vec3 paneN = normalize( N + vec3( ( paneRnd - 0.5 ) * 0.042, ( paneRnd2 - 0.5 ) * 0.032, 0.0 ) );
  float fresnel = 0.06 + 0.94 * pow( 1.0 - max( dot( paneN, V ), 0.0 ), 4.0 );
  vec3 R = reflect( -V, paneN );
  vec3 glassRefl = mix( uSkyHorizon, uSkyZenith, clamp( R.y * 0.65 + 0.35, 0.0, 1.0 ) );
  // Catch golden sunset blaze across west-facing curtain walls!
  glassRefl += uSunsetColor * uSunsetWeight * ( 0.35 + pow( max( dot( R, L ), 0.0 ), 5.0 ) * 1.35 );

  // Single-pass 2D tangent-space interior room parallax + varied Venetian blinds inside each window pane
  vec2 winLocalUv = clamp( vec2( ( g.x - edgeX ) / max( 1.0 - 2.0 * edgeX, 0.05 ), ( g.y - edgeY0 ) / max( edgeY1 - edgeY0, 0.05 ) ), 0.0, 1.0 );
  vec3 winRight = abs( N.x ) > abs( N.z ) ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
  vec2 parShift = clamp( vec2( dot( -V, winRight ), dot( -V, vec3( 0.0, 1.0, 0.0 ) ) ) / max( 0.32, abs( dot( V, N ) ) ) * 0.22, -0.32, 0.32 );
  vec2 roomUv = clamp( winLocalUv + parShift, 0.0, 1.0 );

  // Recessed interior ceiling/back-wall depth + varied Venetian blind drop height per window
  float blindDrop = mix( 0.20, 0.78, paneRnd2 );
  float hasBlind = step( 0.38, paneRnd );
  float blindMask = hasBlind * smoothstep( blindDrop - 0.05, blindDrop + 0.04, winLocalUv.y );
  float blindSlats = 0.86 + 0.14 * sin( winLocalUv.y * 42.0 );
  vec3 blindCol = mix( vec3( 0.54, 0.51, 0.46 ), vec3( 0.68, 0.64, 0.56 ), paneRnd ) * blindSlats * ( 0.28 + 0.55 * uDay );
  float innerCeil = smoothstep( 0.72, 0.96, roomUv.y );
  vec3 innerRoomDay = mix( vec3( 0.08, 0.10, 0.12 ), vec3( 0.22, 0.21, 0.19 ), innerCeil * 0.65 + ( 1.0 - abs( roomUv.x - 0.5 ) * 1.4 ) * 0.25 );
  vec3 glassInterior = mix( innerRoomDay * ( 0.25 + 0.75 * uDay ), blindCol, blindMask * 0.62 );

  vec3 glassTint = isBronzeCurtain > 0.5
    ? vec3( 0.15, 0.14, 0.12 )
    : isGlass > 0.5
      ? vec3( 0.11, 0.15, 0.20 )
      : vec3( 0.09, 0.11, 0.14 );
  vec3 glassBase = mix( glassTint * ( 0.30 + 0.60 * uDay ) + glassInterior * 0.65, glassRefl * ( 0.58 + 0.24 * paneRnd ), 0.26 + 0.64 * fresnel );

  // Recessed upper window lintel overhang shadow + subtle vertical jamb occlusion gives genuine 3D facade depth!
  float lintelShadow = mix( 0.46, 1.0, smoothstep( 0.0, 0.22, 1.0 - winLocalUv.y ) );
  float jambShadow = mix( 0.78, 1.0, smoothstep( 0.0, 0.12, min( winLocalUv.x, 1.0 - winLocalUv.x ) ) );
  glassBase *= lintelShadow * jambShadow;

  vec3 col = mix( litSurface, mix( litSurface, glassBase, isGlass > 0.5 ? 0.88 : 0.82 ), winMask );

  // Organic clustered evening & night occupancy (warm amber residential, ivory & cool studio offices)
  float duskNight = smoothstep( 0.58, 0.08, uDay );
  if ( duskNight > 0.01 && winMask > 0.15 ) {
    float floorCluster = tHash12( vec2( cell.y, floor( vTowerSeed * 41.0 ) ) );
    float roomCluster  = tHash12( vec2( floor( cell.x * 0.32 ), cell.y + floor( vTowerSeed * 97.0 ) ) );
    float roomIndiv    = tHash12( cell + vec2( vTowerSeed * 131.0, 7.0 ) );
    float litProb = mix( 0.76, 0.56, step( 0.52, floorCluster ) );
    float isLit = step( litProb, roomCluster * 0.60 + roomIndiv * 0.40 );
    float hueSeed = tHash12( cell * 1.37 + vTowerSeed * 53.0 );
    vec3 wWarm   = vec3( 1.0, 0.76, 0.42 );
    vec3 wStudio = vec3( 1.0, 0.90, 0.72 );
    vec3 wCool   = vec3( 0.72, 0.86, 1.0 );
    vec3 winEmissive = hueSeed < 0.56 ? wWarm : hueSeed < 0.86 ? wStudio : wCool;
    // Deep parallax ceiling-to-floor brightness gradient modulated by drawn blinds
    float roomShade = ( 0.58 + 0.42 * smoothstep( 0.18, 0.84, roomUv.y ) ) * mix( 1.0, 0.58, blindMask );
    col += winEmissive * isLit * roomShade * winMask * duskNight * 1.04;
  }

  // Architectural rooftop crown illumination band at night
  float crownBand = smoothstep( 0.87, 0.98, vHeightFrac );
  col += mix( vec3( 0.56, 0.70, 0.94 ), vec3( 0.96, 0.78, 0.50 ), vTowerSeed ) * crownBand * duskNight * 0.22;

  col = applySkylineHeightFog( col, vWorldPos, L );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ── Layered Coastal Mountain Ridgeline Shader (Soft Atmospheric Silhouettes — ZERO Void Horizon!) ─────────────

const MOUNTAIN_VERT = /* glsl */ `
attribute float aRidgeLayer;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vRidgeLayer;
varying float vElev;

void main() {
  vRidgeLayer = aRidgeLayer;
  vElev = uv.y;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldPos = wp.xyz;
  vWorldNormal = normalize( mat3( modelMatrix ) * normal );
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const MOUNTAIN_FRAG = /* glsl */ `
precision highp float;

uniform float uDay;
uniform float uNight;
uniform float uSunsetWeight;
uniform float uSeason;
uniform float uSnow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform vec3 uSunsetColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogBaseY;
uniform float uFogMieStrength;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vRidgeLayer;
varying float vElev;

float mHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float mNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mHash12( i ), mHash12( i + vec2( 1.0, 0.0 ) ), u.x ),
    mix( mHash12( i + vec2( 0.0, 1.0 ) ), mHash12( i + vec2( 1.0, 1.0 ) ), u.x ),
    u.y
  );
}

void main() {
  vec3 N = normalize( vWorldNormal );
  vec3 L = normalize( uSunDir );
  vec3 ray = vWorldPos - cameraPosition;
  float dist = length( ray );
  vec3 dir = ray / max( dist, 1e-4 );

  // Seasonal forested coastal foothills -> exposed granite/slate upper ridge -> winter alpine snow caps
  float treeDetail = mNoise( vWorldPos.xz * 0.028 ) * 0.65 + mNoise( vWorldPos.xz * 0.09 ) * 0.35;
  vec3 springSlope = vec3( 0.16, 0.30, 0.20 );
  vec3 summerSlope = vec3( 0.13, 0.26, 0.17 );
  vec3 autumnSlope = vec3( 0.34, 0.26, 0.16 );
  vec3 winterSlope = vec3( 0.28, 0.32, 0.36 );
  vec3 forestCol = uSeason < 0.5 ? springSlope : uSeason < 1.5 ? summerSlope : uSeason < 2.5 ? autumnSlope : winterSlope;
  vec3 rockCol = vec3( 0.30, 0.34, 0.40 );
  vec3 baseAlb = mix( forestCol * ( 0.80 + 0.40 * treeDetail ), rockCol, smoothstep( 0.52, 0.88, vElev ) );

  // Winter snow caps on upper coastal peaks
  float snowCap = smoothstep( 0.48 - uSnow * 0.26, 0.84 - uSnow * 0.18, vElev + ( treeDetail - 0.5 ) * 0.15 )
                * max( uSnow, uSeason > 2.5 ? 0.55 : 0.0 );
  baseAlb = mix( baseAlb, vec3( 0.86, 0.90, 0.96 ), snowCap * 0.82 );

  // Directional sunlit crest + cool Rayleigh sky shadow fill
  float NdotL = max( dot( N, L ), 0.0 );
  vec3 sunLit = uSunColor * NdotL * ( 0.72 * uDay + 0.55 * uSunsetWeight );
  vec3 amb = mix( vec3( 0.04, 0.06, 0.12 ), mix( uSkyHorizon * 0.46, uSkyZenith * 0.56, 0.45 ), uDay );
  vec3 col = baseAlb * ( sunLit + amb );

  // Layered aerial perspective: distant coastal range (vRidgeLayer = 1) sits deeper in Rayleigh haze
  vec3 aerialTint = mix(
    mix( vec3( 0.06, 0.09, 0.17 ), uSkyHorizon * vec3( 0.78, 0.88, 1.02 ), uDay ),
    uSunsetColor * 0.85 + vec3( 0.14, 0.08, 0.14 ),
    uSunsetWeight * 0.65
  );
  float layerHaze = mix( 0.34, 0.62, vRidgeLayer );
  col = mix( col, aerialTint, layerHaze );

  // Exact analytical Height Fog + HG sun scatter blended smoothly into horizon
  float camH = max( 0.0, cameraPosition.y - uFogBaseY );
  float dy = ray.y * uFogFalloff;
  float integral = abs( dy ) < 0.001 ? ( 1.0 - 0.5 * dy ) : ( ( 1.0 - exp( -dy ) ) / dy );
  float tau = uFogDensity * exp( -uFogFalloff * camH ) * dist * clamp( integral, 0.0, 4.0 );
  float fogF = clamp( 1.0 - exp( -tau * 0.78 ), 0.0, 0.88 );
  float hgCos = dot( dir, L );
  float g = 0.76;
  float hg = ( 1.0 - g * g ) / max( 0.05, pow( 1.0 + g * g - 2.0 * g * hgCos, 1.5 ) );
  float mie = clamp( hg * 0.14 * uFogMieStrength * ( 0.25 + 0.75 * uDay ), 0.0, 0.65 );
  vec3 scatterCol = mix( uFogColor, mix( uSunColor, uSunsetColor, uSunsetWeight * 0.7 ), mie );
  float footMist = smoothstep( 0.24, 0.0, vElev ) * 0.45;
  col = mix( col, scatterCol, clamp( max( fogF, footMist ), 0.0, 0.94 ) );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ── Far-Bank Textured Botanical Tree Line (Multi-Cluster Irregular Foliage + Subsurface Translucency) ──────────

const FAR_TREES_VERT = /* glsl */ `
attribute vec3 color;
varying vec3 vColor;
varying vec3 vLocalPos;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vTreeSeed;

void main() {
  vColor = color;
  vLocalPos = position;
  vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
  vWorldPos = wp.xyz;
  vWorldNormal = normalize( mat3( modelMatrix * instanceMatrix ) * normal );
  vec3 origin = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  vTreeSeed = fract( sin( dot( origin.xz, vec2( 19.31, 63.17 ) ) ) * 43758.5453 );
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FAR_TREES_FRAG = /* glsl */ `
precision highp float;

uniform float uDay;
uniform float uSunsetWeight;
uniform float uSeason;
uniform float uSnow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform vec3 uSunsetColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogBaseY;

varying vec3 vColor;
varying vec3 vLocalPos;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vTreeSeed;

float ftHash31( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}

float ftNoise3( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float n000 = ftHash31( i + vec3( 0.0, 0.0, 0.0 ) );
  float n100 = ftHash31( i + vec3( 1.0, 0.0, 0.0 ) );
  float n010 = ftHash31( i + vec3( 0.0, 1.0, 0.0 ) );
  float n110 = ftHash31( i + vec3( 1.0, 1.0, 0.0 ) );
  float n001 = ftHash31( i + vec3( 0.0, 0.0, 1.0 ) );
  float n101 = ftHash31( i + vec3( 1.0, 0.0, 1.0 ) );
  float n011 = ftHash31( i + vec3( 0.0, 1.0, 1.0 ) );
  float n111 = ftHash31( i + vec3( 1.0, 1.0, 1.0 ) );
  float nx00 = mix( n000, n100, f.x );
  float nx10 = mix( n010, n110, f.x );
  float nx01 = mix( n001, n101, f.x );
  float nx11 = mix( n011, n111, f.x );
  float nxy0 = mix( nx00, nx10, f.y );
  float nxy1 = mix( nx01, nx11, f.y );
  return mix( nxy0, nxy1, f.z );
}

void main() {
  vec3 N = normalize( vWorldNormal );
  vec3 L = normalize( uSunDir );
  vec3 V = normalize( cameraPosition - vWorldPos );

  // Distinguish bark trunk/limbs (brown: r > g) from foliage canopy clusters (green: g > r).
  float isCanopy = step( 0.04, vColor.g - vColor.r * 0.92 );

  // Multi-scale 3D procedural leaf-clump detail breaks up smooth geometry into crisp botanical foliage!
  vec3 lp = vLocalPos + vec3( vTreeSeed * 17.3, 0.0, vTreeSeed * 9.7 );
  float clumpCoarse = ftNoise3( lp * 1.45 );
  float clumpMid    = ftNoise3( lp * 3.85 + vec3( 5.2, 2.7, 8.1 ) );
  float clumpFine   = ftNoise3( lp * 8.40 + vec3( 11.4, 4.9, 3.3 ) );
  float leafPattern = clumpCoarse * 0.44 + clumpMid * 0.36 + clumpFine * 0.20;

  // Perturb canopy shading normal with procedural leaf-cluster micro-relief (eliminates smooth sphere look!).
  if ( isCanopy > 0.5 ) {
    vec3 leafBump = vec3(
      clumpMid * 2.0 - 1.0,
      ( clumpFine - 0.45 ) * 0.95,
      ftNoise3( lp * 4.10 + vec3( 19.3, 7.1, 13.7 ) ) * 2.0 - 1.0
    );
    N = normalize( N + leafBump * 0.44 );
  }

  // Rich coastal parkland seasonal palette across varied tree species
  float speciesHue = fract( vTreeSeed * 3.71 );
  vec3 springT = mix( vec3( 0.82, 1.08, 0.72 ), vec3( 0.96, 1.12, 0.68 ), speciesHue );
  // Subtle spring cherry-blossom / coral-leaf accent on ~12% of far-bank trees
  springT = mix( springT, vec3( 1.24, 0.94, 0.98 ), step( 0.88, vTreeSeed ) );
  vec3 summerT = mix( vec3( 0.72, 0.98, 0.68 ), vec3( 0.86, 1.02, 0.62 ), speciesHue );
  vec3 autumnT = mix( vec3( 1.38, 0.84, 0.34 ), vec3( 1.22, 0.52, 0.24 ), speciesHue );
  autumnT = mix( autumnT, vec3( 0.78, 0.86, 0.56 ), step( 0.78, vTreeSeed ) ); // evergreen coastal mix
  vec3 winterT = mix( vec3( 0.56, 0.68, 0.58 ), vec3( 0.66, 0.64, 0.56 ), speciesHue );
  vec3 sTint = uSeason < 0.5 ? springT : uSeason < 1.5 ? summerT : uSeason < 2.5 ? autumnT : winterT;

  // Deep shaded inner-bough crevices vs warm sunlit outer leaf tips!
  float heightAo = smoothstep( 1.6, 6.2, vLocalPos.y );
  float leafDepth = mix( 0.58, 1.22, smoothstep( 0.24, 0.78, leafPattern ) );
  float barkGrain = 0.78 + 0.36 * ftNoise3( vec3( vLocalPos.x * 6.0, vLocalPos.y * 1.4, vLocalPos.z * 6.0 ) );

  vec3 canopyCol = vColor * sTint * leafDepth * ( 0.74 + 0.34 * heightAo ) * ( 0.86 + 0.28 * speciesHue );
  vec3 barkCol = vColor * barkGrain;
  vec3 alb = mix( barkCol, canopyCol, isCanopy );

  if ( uSnow > 0.05 && isCanopy > 0.5 ) {
    float snowMask = smoothstep( 0.18, 0.76, N.y + ( clumpMid - 0.5 ) * 0.35 ) * uSnow * 0.80;
    alb = mix( alb, vec3( 0.88, 0.92, 0.97 ), snowMask );
  }

  float NdotL = max( dot( N, L ), 0.0 );
  float wrap = max( 0.0, ( dot( N, L ) + 0.38 ) / 1.38 );
  // Subtle sunlit subsurface foliage glow along outer leaf margins (gorgeous at golden hour & midday!).
  float backLit = pow( max( dot( -V, L ), 0.0 ), 3.0 ) * isCanopy * smoothstep( 0.35, 0.85, leafPattern );
  vec3 sssGlow = alb * uSunColor * backLit * ( 0.42 * uDay + 0.68 * uSunsetWeight );

  vec3 sunLit = uSunColor * mix( NdotL, wrap, isCanopy * 0.48 ) * ( 0.98 * uDay + 0.58 * uSunsetWeight );
  vec3 skyFill = mix( uSkyHorizon * 0.38, uSkyZenith * 0.50, 0.5 + 0.5 * N.y );
  vec3 amb = mix( vec3( 0.035, 0.055, 0.11 ), skyFill, uDay ) * ( 0.68 + 0.32 * heightAo );
  vec3 col = alb * ( sunLit + amb ) + sssGlow;

  vec3 ray = vWorldPos - cameraPosition;
  float dist = length( ray );
  float camH = max( 0.0, cameraPosition.y - uFogBaseY );
  float dy = ray.y * uFogFalloff;
  float integral = abs( dy ) < 0.001 ? ( 1.0 - 0.5 * dy ) : ( ( 1.0 - exp( -dy ) ) / dy );
  float tau = uFogDensity * exp( -uFogFalloff * camH ) * dist * clamp( integral, 0.0, 4.0 );
  float fogF = clamp( 1.0 - exp( -tau ), 0.0, 0.90 );
  col = mix( col, uFogColor, fogF );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ── Procedural Geometry Builders for 6 Sculpted Tower Archetypes, Coastal Mountains, Bridges & Far Bank ───────

function prepMerge(geo: T.BufferGeometry): T.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    const count = g.attributes.position.count;
    g.setAttribute('uv', new T.BufferAttribute(new Float32Array(count * 2), 2));
  }
  return g;
}

function tagTowerGeo(geo: T.BufferGeometry, mode: 'facade' | 'trim' | 'spire'): T.BufferGeometry {
  const g = prepMerge(geo);
  const pos = g.attributes.position as T.BufferAttribute;
  const uv = g.attributes.uv as T.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const y = pos.getY(i);
    if (mode === 'spire') {
      uv.setXY(i, 0.5, 1.12 + Math.max(0, y - 0.96) * 2.8);
    } else if (mode === 'trim') {
      uv.setXY(i, -1.0, Math.max(0, Math.min(1, y)));
    } else {
      uv.setXY(i, 0.5, Math.max(0, Math.min(1, y)));
    }
  }
  return g;
}

function makeBox(w: number, h: number, d: number, x: number, y: number, z: number, mode: 'facade' | 'trim' | 'spire'): T.BufferGeometry {
  const b = new T.BoxGeometry(w, h, d);
  b.translate(x, y, z);
  return tagTowerGeo(b, mode);
}

/** Sleek tapered architectural needle spire (replaces blocky grey rooftop cutouts in Scenes 05 & 14). */
function makeTaperedSpire(
  baseR: number,
  topR: number,
  h: number,
  x: number,
  yBottom: number,
  z: number,
): T.BufferGeometry[] {
  const collarH = Math.min(0.022, h * 0.14);
  const collar = new T.CylinderGeometry(baseR * 1.45, baseR * 1.85, collarH, 8, 1);
  collar.translate(x, yBottom + collarH * 0.5, z);
  const needle = new T.CylinderGeometry(topR, baseR, h, 6, 1);
  needle.translate(x, yBottom + collarH + h * 0.5, z);
  return [tagTowerGeo(collar, 'trim'), tagTowerGeo(needle, 'spire')];
}

/** Archetype 0: Tapered chamfered glass curtain-wall high-rise with angled crown & twin spires. */
function buildArchetypeTaperedGlass(): T.BufferGeometry {
  const parts: T.BufferGeometry[] = [];
  // Broad urban podium + cornice ledge
  parts.push(makeBox(1.12, 0.16, 1.08, 0, 0.08, 0, 'facade'));
  parts.push(makeBox(1.16, 0.025, 1.12, 0, 0.165, 0, 'trim'));
  // Chamfered 8-sided tapered main shaft
  const shaft = new T.CylinderGeometry(0.46, 0.58, 0.68, 8, 1);
  shaft.rotateY(Math.PI / 8);
  shaft.translate(0, 0.50, 0);
  parts.push(tagTowerGeo(shaft, 'facade'));
  // Sculpted angled glass crown (bevelled upper tier)
  const crown = new T.CylinderGeometry(0.32, 0.45, 0.16, 8, 1);
  crown.rotateY(Math.PI / 8);
  crown.translate(0, 0.92, 0);
  const cPos = crown.attributes.position as T.BufferAttribute;
  for (let i = 0; i < cPos.count; i++) {
    if (cPos.getY(i) > 0.96) cPos.setY(i, cPos.getY(i) + cPos.getX(i) * 0.18);
  }
  crown.computeVertexNormals();
  parts.push(tagTowerGeo(crown, 'facade'));
  // Crown parapet collar + slender tapered architectural communication needles
  const collar = new T.CylinderGeometry(0.46, 0.46, 0.022, 8, 1);
  collar.rotateY(Math.PI / 8);
  collar.translate(0, 0.84, 0);
  parts.push(tagTowerGeo(collar, 'trim'));
  parts.push(...makeTaperedSpire(0.020, 0.0035, 0.17, -0.075, 0.985, 0));
  parts.push(...makeTaperedSpire(0.016, 0.0030, 0.125, 0.085, 0.980, 0));
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

/** Archetype 1: Asymmetric stepped-terrace coastal residential/mixed-use tower with overhanging slabs. */
function buildArchetypeSteppedTerrace(): T.BufferGeometry {
  const parts: T.BufferGeometry[] = [];
  parts.push(makeBox(1.14, 0.22, 1.04, 0, 0.11, 0, 'facade'));
  parts.push(makeBox(1.18, 0.024, 1.08, 0, 0.225, 0, 'trim'));
  parts.push(makeBox(0.94, 0.34, 0.86, -0.06, 0.39, 0.02, 'facade'));
  parts.push(makeBox(0.98, 0.022, 0.90, -0.06, 0.565, 0.02, 'trim'));
  parts.push(makeBox(0.72, 0.28, 0.72, 0.08, 0.70, -0.04, 'facade'));
  parts.push(makeBox(0.76, 0.022, 0.76, 0.08, 0.845, -0.04, 'trim'));
  parts.push(makeBox(0.48, 0.14, 0.50, 0.12, 0.91, -0.04, 'facade'));
  parts.push(makeBox(0.54, 0.024, 0.56, 0.12, 0.985, -0.04, 'trim'));
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

/** Archetype 2: Sculpted elliptical coastal sail tower with diagonal sloped sky-gallery crown. */
function buildArchetypeCurvedSail(): T.BufferGeometry {
  const parts: T.BufferGeometry[] = [];
  parts.push(makeBox(1.06, 0.14, 0.96, 0, 0.07, 0, 'facade'));
  parts.push(makeBox(1.10, 0.022, 1.00, 0, 0.145, 0, 'trim'));
  const sail = new T.CylinderGeometry(0.42, 0.56, 0.84, 10, 3);
  sail.scale(1.12, 1.0, 0.76);
  sail.translate(0, 0.56, 0);
  const pos = sail.attributes.position as T.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > 0.82) {
      pos.setY(i, y + pos.getX(i) * 0.24);
    }
  }
  sail.computeVertexNormals();
  parts.push(tagTowerGeo(sail, 'facade'));
  parts.push(...makeTaperedSpire(0.019, 0.0032, 0.155, 0.16, 0.985, 0));
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

/** Archetype 3: Twin-fin modern office towers linked by mid-level glazed skybridge. */
function buildArchetypeTwinFin(): T.BufferGeometry {
  const parts: T.BufferGeometry[] = [];
  parts.push(makeBox(1.16, 0.16, 0.96, 0, 0.08, 0, 'facade'));
  parts.push(makeBox(1.20, 0.024, 1.00, 0, 0.165, 0, 'trim'));
  // West & east slender slabs
  parts.push(makeBox(0.46, 0.80, 0.80, -0.30, 0.56, 0, 'facade'));
  parts.push(makeBox(0.46, 0.72, 0.80, 0.30, 0.52, 0, 'facade'));
  // Glazed skybridge connecting the twin towers
  parts.push(makeBox(0.24, 0.10, 0.52, 0, 0.62, 0, 'facade'));
  parts.push(makeBox(0.26, 0.020, 0.56, 0, 0.57, 0, 'trim'));
  parts.push(makeBox(0.26, 0.020, 0.56, 0, 0.675, 0, 'trim'));
  // Roof caps & slender architectural mast
  parts.push(makeBox(0.50, 0.026, 0.84, -0.30, 0.965, 0, 'trim'));
  parts.push(makeBox(0.50, 0.026, 0.84, 0.30, 0.885, 0, 'trim'));
  parts.push(...makeTaperedSpire(0.018, 0.0030, 0.155, -0.30, 0.975, 0));
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

/** Archetype 4: Broad waterfront mid-rise coastal residence / boutique hotel with horizontal terrace bands. */
function buildArchetypeMidriseBlock(): T.BufferGeometry {
  const parts: T.BufferGeometry[] = [];
  parts.push(makeBox(1.26, 0.78, 0.96, 0, 0.39, 0, 'facade'));
  // Horizontal balcony cornice bands
  parts.push(makeBox(1.30, 0.028, 1.00, 0, 0.24, 0, 'trim'));
  parts.push(makeBox(1.30, 0.028, 1.00, 0, 0.52, 0, 'trim'));
  parts.push(makeBox(1.32, 0.036, 1.04, 0, 0.79, 0, 'trim'));
  // Recessed penthouse pavilion + stepped rooftop parapet & mechanical louver housing (0 extra draw calls)
  parts.push(makeBox(0.76, 0.16, 0.64, 0, 0.88, 0, 'facade'));
  parts.push(makeBox(0.84, 0.030, 0.72, 0, 0.97, 0, 'trim'));
  parts.push(makeBox(0.32, 0.07, 0.26, -0.18, 1.02, -0.06, 'trim'));
  parts.push(makeBox(0.20, 0.05, 0.22, 0.20, 1.01, 0.08, 'trim'));
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

/** Archetype 5: Signature tiered landmark spire with glowing octagonal crown lantern. */
function buildArchetypeLandmarkSpire(): T.BufferGeometry {
  const parts: T.BufferGeometry[] = [];
  parts.push(makeBox(1.04, 0.44, 1.04, 0, 0.22, 0, 'facade'));
  parts.push(makeBox(1.08, 0.024, 1.08, 0, 0.445, 0, 'trim'));
  parts.push(makeBox(0.82, 0.32, 0.82, 0, 0.60, 0, 'facade'));
  parts.push(makeBox(0.86, 0.022, 0.86, 0, 0.765, 0, 'trim'));
  const lantern = new T.CylinderGeometry(0.24, 0.38, 0.20, 8, 1);
  lantern.rotateY(Math.PI / 8);
  lantern.translate(0, 0.87, 0);
  parts.push(tagTowerGeo(lantern, 'facade'));
  parts.push(...makeTaperedSpire(0.036, 0.0042, 0.25, 0, 0.965, 0));
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * Builds a continuous 360° two-tier coastal mountain & forested foothill ridgeline enclosing the entire
 * city valley — strictly behind ALL skyline towers (North), strictly outside Botanical Garden (West),
 * East Greenway (East), and South Residential fringe (South), and comfortably inside `camera.far = 420 m`
 * so ZERO horizon direction ever clips or ends in a flat green plane (still 1 draw call!).
 */
function buildCoastalMountainGeometry(
  groundY: number,
  riverFarZ: number,
  centerX: number,
  minTowerZ: number,
): T.BufferGeometry {
  const layers: T.BufferGeometry[] = [];
  // Clear strictly behind the northernmost skyline tower while keeping mountains comfortably inside camera.far (420 m).
  const northClear0 = Math.max(255, Math.min(312, Math.abs(Math.min(minTowerZ - 24, riverFarZ - 228))));
  const northClear1 = Math.min(358, northClear0 + 48);

  const periodicRidge = (ang: number, seed: number) => {
    const n1 = Math.sin(ang * 3 + seed) * 0.42 + 0.5;
    const n2 = Math.sin(ang * 7 - seed * 1.9) * 0.28 + 0.5;
    const n3 = Math.sin(ang * 13 + seed * 3.1) * 0.16 + 0.5;
    const n4 = Math.abs(Math.sin(ang * 5 + seed * 0.7));
    const n5 = Math.sin(ang * 19 + seed * 4.7) * 0.08 + 0.5;
    return Math.max(0.10, n1 * 0.40 + n2 * 0.26 + n3 * 0.14 + (1 - n4) * 0.16 + n5 * 0.08);
  };

  const layerDefs = [
    // Layer 0: Near forested coastal foothills wrapping 360° around North, West (Botanical Garden!), East & South
    {
      layerId: 0,
      radiusX: 282,
      radiusZNorth: northClear0,
      radiusZSouth: 205,
      maxH: 48,
      minH: 16,
      segs: 128,
      seed: 1.7,
    },
    // Layer 1: Majestic misty distant coastal mountain range framing all horizons inside camera.far (<= 420 m)
    {
      layerId: 1,
      radiusX: 338,
      radiusZNorth: northClear1,
      radiusZSouth: 258,
      maxH: 88,
      minH: 28,
      segs: 144,
      seed: 4.3,
    },
  ];

  for (const def of layerDefs) {
    const positions: number[] = [];
    const uvs: number[] = [];
    const ridgeLayers: number[] = [];
    const indices: number[] = [];

    const rows = 4; // buried base skirt -> flared foot slope -> forested mid slope -> sculpted peak crest
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      for (let i = 0; i <= def.segs; i++) {
        const u = i / def.segs;
        // Full 360° seamless ring: ang = 0 is North (-Z), -PI/2 is West (-X, Botanical Garden!), +PI/2 is East (+X)
        const ang = (u - 0.5) * Math.PI * 2;
        const sinA = Math.sin(ang);
        const cosA = Math.cos(ang);
        const depthPush = (1 - v) * 32; // Foot slopes gently inward toward valley plain
        const rZ = cosA >= 0 ? def.radiusZNorth : def.radiusZSouth;
        // Mild superellipse diagonal push clears NW/NE skyline towers while staying strictly inside camera.far (420 m).
        const cornerBoost = 1 + (def.layerId === 0 ? 0.14 : 0.11) * Math.pow(Math.sin(2 * ang), 2);

        const px = centerX + sinA * (def.radiusX * cornerBoost - depthPush);
        const pz = -cosA * (rZ * cornerBoost - depthPush * 0.80);

        // Tallest dramatic coastal peaks across North & Northwest (Skyline + Botanical Garden!),
        // graceful rolling coastal hills on West/Southwest/East/South flanks (zero abrupt cutoff!).
        const northWeight = Math.max(0, cosA); // 1 due north, 0 east/west
        const westHillBoost = Math.max(0, -sinA) * 0.36; // rich rolling hills directly behind Botanical Garden!
        const directionalScale = 0.54 + northWeight * 0.46 + westHillBoost * (1 - northWeight * 0.5);

        // Gentle coastal river-valley saddle where the river channel exits far west & far east
        const riverGapZ = Math.abs(pz - (riverFarZ + 18));
        const isFlank = Math.abs(sinA) > 0.72;
        const riverPassDamp = isFlank ? 0.64 + 0.36 * Math.min(1, riverGapZ / 52) : 1.0;

        const ridgeH = (def.minH + periodicRidge(ang, def.seed) * def.maxH) * directionalScale * riverPassDamp;
        const slopeCurve = Math.pow(v, 1.15);
        const microCrag =
          v > 0.2 && v < 0.95 ? Math.sin(ang * 29 + r * 2.1 + def.seed) * 1.8 : 0;
        const y = groundY - 6.5 + slopeCurve * ridgeH + microCrag;

        positions.push(px, y, pz);
        uvs.push(u, v);
        ridgeLayers.push(def.layerId);
      }
    }

    const stride = def.segs + 1;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < def.segs; i++) {
        const a = r * stride + i;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        indices.push(a, b, d, a, d, c);
      }
    }

    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
    g.setAttribute('aRidgeLayer', new T.Float32BufferAttribute(ridgeLayers, 1));
    g.setIndex(indices);
    g.computeVertexNormals();
    const nonIdx = g.toNonIndexed();
    g.dispose();
    layers.push(nonIdx);
  }

  const merged = mergeGeometries(layers, false)!;
  layers.forEach((l) => l.dispose());
  return merged;
}

/**
 * Builds twin iconic coastal tied-arch river bridges flanking the west & east horizon vistas
 * (strictly outside walkable city bounds): returns 1 merged structural geometry + 1 warm night light geometry.
 */
function buildArchedRiverBridges(
  bridgeXs: readonly number[],
  groundY: number,
  riverFarZ: number,
  riverNearZ: number,
): { structure: T.BufferGeometry; lights: T.BufferGeometry } {
  const structParts: T.BufferGeometry[] = [];
  const lightParts: T.BufferGeometry[] = [];

  const spanLen = riverNearZ - riverFarZ + 18;
  const midZ = (riverNearZ + riverFarZ) * 0.5;
  const deckY = groundY + 4.8;
  const deckW = 9.2;
  const archHalfSpan = (riverNearZ - riverFarZ) * 0.48;
  const archRise = 13.5;

  for (const bx of bridgeXs) {
    // Tapered bridge roadway deck + side guardrails
    const deck = new T.BoxGeometry(deckW, 0.85, spanLen);
    deck.translate(bx, deckY, midZ);
    structParts.push(prepMerge(deck));

    for (const side of [-1, 1]) {
      const sx = bx + side * (deckW * 0.47);
      const rail = new T.BoxGeometry(0.32, 0.95, spanLen);
      rail.translate(sx, deckY + 0.85, midZ);
      structParts.push(prepMerge(rail));

      // Parabolic tied steel arch segments (14 smooth chords per side)
      const segs = 14;
      for (let s = 0; s < segs; s++) {
        const t0 = (s / segs) * 2 - 1;
        const t1 = ((s + 1) / segs) * 2 - 1;
        const z0 = midZ + t0 * archHalfSpan;
        const z1 = midZ + t1 * archHalfSpan;
        const y0 = deckY + (1 - t0 * t0) * archRise;
        const y1 = deckY + (1 - t1 * t1) * archRise;
        const segLen = Math.hypot(z1 - z0, y1 - y0);
        const pitch = Math.atan2(y1 - y0, z1 - z0);
        const rib = new T.BoxGeometry(0.55, 0.72, segLen + 0.14);
        rib.rotateX(-pitch);
        rib.translate(sx, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
        structParts.push(prepMerge(rib));

        // Warm bridge arch accent light strip beneath arch chord
        if (s >= 1 && s <= segs - 2) {
          const strip = new T.BoxGeometry(0.24, 0.20, segLen * 0.72);
          strip.rotateX(-pitch);
          strip.translate(sx, (y0 + y1) * 0.5 - 0.40, (z0 + z1) * 0.5);
          lightParts.push(prepMerge(strip));
        }

        // Slender vertical suspender cables down to bridge deck
        if (s > 0 && s < segs) {
          const cableH = Math.max(0.6, y0 - deckY);
          const cable = new T.BoxGeometry(0.10, cableH, 0.10);
          cable.translate(sx, deckY + cableH * 0.5, z0);
          structParts.push(prepMerge(cable));
        }
      }
    }

    // Overhead lateral cross-bracing struts tying the two arches together
    for (const tz of [-0.45, 0, 0.45]) {
      const cz = midZ + tz * archHalfSpan;
      const cy = deckY + (1 - tz * tz) * archRise;
      const brace = new T.BoxGeometry(deckW * 0.94, 0.42, 0.48);
      brace.translate(bx, cy, cz);
      structParts.push(prepMerge(brace));
    }

    // Sculpted concrete piers anchored deeply into the river channel
    for (const pz of [riverFarZ + 1.5, riverNearZ - 1.5]) {
      const pier = new T.BoxGeometry(deckW * 0.88, 7.6, 2.2);
      pier.translate(bx, deckY - 3.9, pz);
      structParts.push(prepMerge(pier));
    }

    // Warm promenade deck light beacons along bridge span
    for (let lz = riverFarZ - 4; lz <= riverNearZ + 4; lz += 8) {
      for (const side of [-1, 1]) {
        const bulb = new T.BoxGeometry(0.26, 0.32, 0.26);
        bulb.translate(bx + side * (deckW * 0.44), deckY + 2.4, lz);
        lightParts.push(prepMerge(bulb));
      }
    }
  }

  const structure = mergeGeometries(structParts, false)!;
  const lights = mergeGeometries(lightParts, false)!;
  structParts.forEach((p) => p.dispose());
  lightParts.forEach((p) => p.dispose());
  return { structure, lights };
}

/**
 * Sculpted smooth-shaded organic foliage bough cluster (indexed SphereGeometry + smooth radial foliage
 * normals prevent faceted crystal shading while keeping irregular botanical canopy lobes!).
 */
function makeCrinkledCrownCluster(
  radius: number,
  sx: number,
  sy: number,
  sz: number,
  tx: number,
  ty: number,
  tz: number,
  seed: number,
  baseR: number,
  baseG: number,
  baseB: number,
): T.BufferGeometry {
  // Indexed SphereGeometry ensures smooth shared-vertex normals (non-indexed IcosahedronGeometry produced flat facets!).
  const geo = new T.SphereGeometry(radius, 12, 9);
  const pos = geo.attributes.position as T.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const len = Math.hypot(vx, vy, vz) || 1;
    const nx = vx / len;
    const ny = vy / len;
    const nz = vz / len;
    // Direction-only multi-frequency lobe displacement stays 100% seamless across sphere UV seam & poles.
    const lobe1 = Math.sin(nx * 4.3 + seed) * Math.cos(nz * 4.7 - seed * 0.8) * Math.cos(ny * 3.9 + seed * 0.4);
    const lobe2 = Math.sin(nx * 9.1 - ny * 7.6 + seed * 2.1) * Math.sin(nz * 8.4 + seed * 1.3);
    const disp = 1.0 + lobe1 * 0.22 + lobe2 * 0.09;
    // Gently flatten undersides so boughs hang naturally like real broadleaved foliage layers.
    const ySquash = ny < 0 ? 0.82 : 1.04;
    pos.setXYZ(i, vx * sx * disp + tx, vy * sy * ySquash * disp + ty, vz * sz * disp + tz);
  }
  geo.computeVertexNormals();

  // Blend outward radial sphere foliage-volume normals (`normalize(pos - center) * 0.72 + vec3(0, 0.28, 0)`)
  // BEFORE non-indexing so far-bank crowns render as lush sunlit foliage clouds with ZERO faceted edges!
  const gNorm = geo.attributes.normal as T.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const rx = (pos.getX(i) - tx) / Math.max(0.25, radius * sx);
    const ry = (pos.getY(i) - ty) / Math.max(0.25, radius * sy);
    const rz = (pos.getZ(i) - tz) / Math.max(0.25, radius * sz);
    const rLen = Math.hypot(rx, ry, rz) || 1;
    const radX = (rx / rLen) * 0.72;
    const radY = (ry / rLen) * 0.72 + 0.28;
    const radZ = (rz / rLen) * 0.72;
    const radLen = Math.hypot(radX, radY, radZ) || 1;
    const bx = (radX / radLen) * 0.78 + gNorm.getX(i) * 0.22;
    const by = (radY / radLen) * 0.78 + gNorm.getY(i) * 0.22;
    const bz = (radZ / radLen) * 0.78 + gNorm.getZ(i) * 0.22;
    const bLen = Math.hypot(bx, by, bz) || 1;
    gNorm.setXYZ(i, bx / bLen, by / bLen, bz / bLen);
  }
  gNorm.needsUpdate = true;

  const ng = prepMerge(geo);
  const nPos = ng.attributes.position as T.BufferAttribute;
  const nNorm = ng.attributes.normal as T.BufferAttribute;
  const cols = new Float32Array(nPos.count * 3);
  for (let i = 0; i < nPos.count; i++) {
    // Per-vertex canopy self-occlusion: darker under-boughs & inner core, luminous outer leaf tips!
    const dy = (nPos.getY(i) - ty) / Math.max(0.4, radius * sy);
    const upShade = 0.74 + 0.34 * Math.max(0, Math.min(1, nNorm.getY(i) * 0.5 + 0.5));
    const crownGrad = 0.80 + 0.28 * Math.max(0, Math.min(1, dy * 0.5 + 0.5));
    const shade = upShade * crownGrad;
    cols[i * 3 + 0] = baseR * shade;
    cols[i * 3 + 1] = baseG * shade;
    cols[i * 3 + 2] = baseB * shade;
  }
  ng.setAttribute('color', new T.BufferAttribute(cols, 3));
  return ng;
}

function addBarkPart(parts: T.BufferGeometry[], geo: T.BufferGeometry, r: number, g: number, b: number): void {
  const ng = prepMerge(geo);
  const n = ng.attributes.position.count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    cols[i * 3 + 0] = r;
    cols[i * 3 + 1] = g;
    cols[i * 3 + 2] = b;
  }
  ng.setAttribute('color', new T.BufferAttribute(cols, 3));
  parts.push(ng);
}

/**
 * Far-Bank Archetype A: Wide irregular broadleaf coastal banyan/oak with splayed structural limbs and
 * 12 organically displaced crinkled foliage bough clusters (1 InstancedMesh draw!).
 */
function buildFarBankTreeGeometry(): T.BufferGeometry {
  const parts: T.BufferGeometry[] = [];

  // Tapered flared main trunk + 4 outward-splaying primary limbs
  const trunk = new T.CylinderGeometry(0.24, 0.42, 3.4, 7, 1);
  trunk.translate(0, 1.7, 0);
  addBarkPart(parts, trunk, 0.27, 0.20, 0.14);

  const limbs: readonly [number, number, number, number][] = [
    [0.55, 0.2, 0.55, 2.1],
    [-0.58, 0.15, 0.48, 2.0],
    [0.12, -0.58, -0.52, 2.2],
    [-0.44, -0.36, -0.44, 1.9],
  ];
  for (let i = 0; i < limbs.length; i++) {
    const [rx, rz, leanX, len] = limbs[i];
    const b = new T.CylinderGeometry(0.08, 0.18, len, 5, 1);
    b.translate(0, len * 0.5, 0);
    b.rotateZ(rx);
    b.rotateX(rz);
    b.translate(leanX * 0.35, 2.75, rz * 0.3);
    addBarkPart(parts, b, 0.25, 0.18, 0.12);
  }

  // 12 irregular crinkled crown boughs: shaded lower sprays -> lush mid perimeter -> sunlit irregular apex
  const clusters: readonly [number, number, number, number, number, number, number, number, number, number, number][] = [
    // [r, sx, sy, sz, tx, ty, tz, seed, R, G, B]
    // Lower shaded canopy shelf
    [1.45, 1.24, 0.64, 1.16, -1.65, 3.95, 0.85, 1.1, 0.14, 0.33, 0.15],
    [1.50, 1.18, 0.68, 1.22, 1.62, 4.10, -0.65, 2.4, 0.15, 0.35, 0.16],
    [1.38, 1.20, 0.62, 1.15, 0.35, 3.85, 1.55, 3.7, 0.14, 0.32, 0.15],
    [1.42, 1.15, 0.66, 1.20, -0.62, 4.05, -1.52, 4.9, 0.13, 0.31, 0.14],
    // Mid spreading crown boughs
    [1.62, 1.16, 0.78, 1.10, -1.25, 5.15, -0.45, 6.2, 0.18, 0.42, 0.19],
    [1.58, 1.20, 0.74, 1.14, 1.32, 5.25, 0.62, 7.5, 0.20, 0.45, 0.21],
    [1.52, 1.12, 0.76, 1.18, 0.18, 5.05, -1.18, 8.8, 0.17, 0.40, 0.18],
    [1.48, 1.18, 0.72, 1.08, -0.35, 5.35, 1.12, 10.1, 0.19, 0.44, 0.20],
    // Upper sunlit irregular crown peak sprays (asymmetrical organic silhouette!)
    [1.34, 1.14, 0.82, 1.08, -0.58, 6.25, 0.24, 11.4, 0.23, 0.50, 0.23],
    [1.26, 1.18, 0.78, 1.12, 0.78, 6.10, -0.32, 12.7, 0.24, 0.52, 0.24],
    [1.04, 1.10, 0.84, 1.04, 0.12, 6.85, 0.08, 14.0, 0.26, 0.55, 0.25],
    [0.96, 1.22, 0.68, 1.08, 1.95, 4.75, 0.15, 15.3, 0.21, 0.46, 0.21],
  ];

  for (const c of clusters) {
    parts.push(makeCrinkledCrownCluster(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10]));
  }

  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * Far-Bank Archetype B: Tall tiered coastal acacia/parkland shade tree with asymmetric layered foliage
 * shelves for rich skyline silhouette variety (1 InstancedMesh draw!).
 */
function buildFarBankLayeredTreeGeometry(): T.BufferGeometry {
  const parts: T.BufferGeometry[] = [];

  const trunk = new T.CylinderGeometry(0.18, 0.34, 4.4, 6, 1);
  trunk.translate(0, 2.2, 0);
  addBarkPart(parts, trunk, 0.29, 0.22, 0.15);

  const b1 = new T.CylinderGeometry(0.07, 0.14, 1.9, 5, 1);
  b1.translate(0, 0.95, 0);
  b1.rotateZ(0.48);
  b1.translate(0.15, 3.2, 0.1);
  addBarkPart(parts, b1, 0.27, 0.20, 0.14);

  const b2 = new T.CylinderGeometry(0.07, 0.13, 1.8, 5, 1);
  b2.translate(0, 0.9, 0);
  b2.rotateZ(-0.44);
  b2.rotateX(0.32);
  b2.translate(-0.12, 3.6, -0.08);
  addBarkPart(parts, b2, 0.27, 0.20, 0.14);

  const clusters: readonly [number, number, number, number, number, number, number, number, number, number, number][] = [
    // Tier 1 (lower broad tier)
    [1.36, 1.25, 0.60, 1.18, -1.15, 3.85, 0.55, 21.3, 0.15, 0.36, 0.17],
    [1.32, 1.20, 0.62, 1.22, 1.18, 4.05, -0.45, 22.8, 0.16, 0.38, 0.18],
    [1.24, 1.16, 0.58, 1.15, 0.10, 3.70, -1.12, 24.1, 0.14, 0.34, 0.16],
    // Tier 2 (mid asymmetrical crown)
    [1.38, 1.18, 0.72, 1.14, -0.78, 5.25, -0.48, 25.6, 0.19, 0.44, 0.21],
    [1.34, 1.22, 0.70, 1.12, 0.92, 5.45, 0.52, 27.0, 0.21, 0.47, 0.22],
    [1.20, 1.14, 0.68, 1.18, -0.15, 5.10, 0.98, 28.4, 0.18, 0.42, 0.20],
    // Tier 3 (tapered sunlit upper spire)
    [1.16, 1.12, 0.80, 1.08, 0.32, 6.65, -0.18, 29.9, 0.23, 0.51, 0.24],
    [1.06, 1.08, 0.78, 1.12, -0.48, 6.85, 0.26, 31.2, 0.24, 0.52, 0.25],
    [0.88, 1.02, 0.92, 1.02, 0.06, 7.80, 0.04, 32.7, 0.26, 0.56, 0.26],
  ];

  for (const c of clusters) {
    parts.push(makeCrinkledCrownCluster(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10]));
  }

  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

export interface SkylineTowerSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

export interface SkylineView {
  /** Root container (`T.Group` named `'city-skyline'`, directly mountable via `sector.add(skylineView.mesh)`). */
  readonly mesh: T.Group;
  readonly group: T.Group;
  /** Primary skyline curtain-wall `ShaderMaterial`. */
  readonly material: T.ShaderMaterial;
  readonly drawCallCount: number;
  syncAtmosphere(snap: AtmosphereSnapshot, cameraLocal: T.Vector3): void;
  dispose(): void;
}

/**
 * Builds the sculpted AAA Downtown Skyline + Coastal Mountain Ridgeline + Twin Arched River Bridges +
 * Far-Bank Embankment Promenade, Tree Line, and Warm Night Lights (`<= 12` draw calls total, ZERO void horizon!).
 */
export function buildSkylineView(
  towers: readonly SkylineTowerSpec[],
  groundY: number,
  weather: SharedWeatherUniforms,
  tier: WeatherRenderTier,
  riverFarZOverride?: number,
): SkylineView {
  const root = new T.Group();
  root.name = 'city-skyline';

  const ownedGeos: T.BufferGeometry[] = [];
  const ownedMats: T.Material[] = [];
  const ownedInsts: T.InstancedMesh[] = [];

  // Infer exact river & skyline bounds from incoming tower coordinates if caller didn't pass `riverFarZOverride`.
  let minX = Infinity, maxX = -Infinity, maxTowerZ = -Infinity, minTowerZ = Infinity;
  for (let i = 0; i < towers.length; i++) {
    const t = towers[i];
    if (t.x < minX) minX = t.x;
    if (t.x > maxX) maxX = t.x;
    if (t.z > maxTowerZ) maxTowerZ = t.z;
    if (t.z - t.d * 0.5 < minTowerZ) minTowerZ = t.z - t.d * 0.5;
  }
  const centerX = Number.isFinite(minX) && Number.isFinite(maxX) ? (minX + maxX) * 0.5 : 40;
  const riverFarZ = riverFarZOverride ?? (Number.isFinite(maxTowerZ) ? maxTowerZ + 55 : -66);
  const safeMinTowerZ = Number.isFinite(minTowerZ) ? minTowerZ : riverFarZ - 210;
  const riverNearZ = riverFarZ + 36;

  // Shared atmosphere uniforms synced once per frame across skyline, mountains, bridge & far-bank trees.
  const uDay = { value: 1 };
  const uNight = { value: 0 };
  const uSunsetWeight = { value: 0 };
  const uSunDir = { value: new T.Vector3(0.3, 0.6, -0.7).normalize() };
  const uSunColor = { value: new T.Color('#fff4e2') };
  const uSkyHorizon = { value: new T.Color('#b8d6f2') };
  const uSkyZenith = { value: new T.Color('#2d64b8') };
  const uSunsetColor = { value: new T.Color('#ff8444') };
  const uFogColor = { value: new T.Color('#c2d8ee') };
  const uFogDensity = { value: 0.0012 };
  const uFogFalloff = { value: 0.030 };
  const uFogBaseY = { value: groundY };
  const uFogMieStrength = { value: 0.42 };
  const uCam = { value: new T.Vector3() };

  const skylineMat = new T.ShaderMaterial({
    vertexShader: SKYLINE_VERT,
    fragmentShader: SKYLINE_FRAG,
    toneMapped: true,
    uniforms: {
      uTime: weather.uTime,
      uDay,
      uNight,
      uSunsetWeight,
      uSunDir,
      uSunColor,
      uSkyHorizon,
      uSkyZenith,
      uSunsetColor,
      uFogColor,
      uFogDensity,
      uFogFalloff,
      uFogBaseY,
      uFogMieStrength,
      uCam,
    },
  });
  ownedMats.push(skylineMat);

  // ── 1. Sculpted 6-Archetype Downtown Skyline (6 InstancedMesh draws on Bal/High/Ultra, 3 on Low) ──
  const archBuilders =
    tier === 'low'
      ? [buildArchetypeTaperedGlass, buildArchetypeSteppedTerrace, buildArchetypeMidriseBlock]
      : [
          buildArchetypeTaperedGlass,
          buildArchetypeSteppedTerrace,
          buildArchetypeCurvedSail,
          buildArchetypeTwinFin,
          buildArchetypeMidriseBlock,
          buildArchetypeLandmarkSpire,
        ];

  const buckets: SkylineTowerSpec[][] = archBuilders.map(() => []);
  const srcTowers = tier === 'low' ? towers.filter((_, i) => i % 2 === 0) : towers;
  for (let i = 0; i < srcTowers.length; i++) {
    const t = srcTowers[i];
    // Assign shorter foreground buildings to mid-rise/terrace archetypes and tall center towers to landmark spires/sails!
    let idx: number;
    if (archBuilders.length === 3) {
      idx = t.h < 42 ? 2 : i % 2;
    } else if (t.h < 36) {
      idx = 4; // waterfront midrise
    } else if (t.h > 92) {
      idx = i % 2 === 0 ? 5 : 2; // signature spire or curved sail
    } else {
      idx = i % 4; // tapered glass, stepped terrace, curved sail, twin fin
    }
    buckets[idx].push(t);
  }

  // Add foreground waterfront mid-rise boulevard blocks along the far bank so the skyline steps up naturally!
  if (tier !== 'low') {
    const midBucket = buckets[4];
    const spanStart = Math.max(-220, (Number.isFinite(minX) ? minX : -200) + 25);
    const spanEnd = Math.min(340, (Number.isFinite(maxX) ? maxX : 320) - 25);
    const count = 16;
    for (let i = 0; i < count; i++) {
      const u = i / Math.max(1, count - 1);
      const jitter = Math.sin(i * 19.7) * 0.5 + 0.5;
      midBucket.push({
        x: spanStart + u * (spanEnd - spanStart) + (jitter - 0.5) * 9,
        z: riverFarZ - 26 - jitter * 18,
        w: 16 + jitter * 10,
        d: 12 + (1 - jitter) * 7,
        h: 14 + jitter * 14,
      });
    }
  }

  const m4 = new T.Matrix4();
  const pos = new T.Vector3();
  const quat = new T.Quaternion();
  const scl = new T.Vector3();
  const upAxis = new T.Vector3(0, 1, 0);
  let drawCallCount = 0;

  for (let a = 0; a < archBuilders.length; a++) {
    const list = buckets[a];
    if (!list.length) continue;
    const geo = archBuilders[a]();
    ownedGeos.push(geo);
    const inst = new T.InstancedMesh(geo, skylineMat, list.length);
    inst.name = `city-skyline-arch-${a}`;
    inst.castShadow = false;
    inst.receiveShadow = false;
    inst.raycast = () => undefined;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      pos.set(b.x, groundY - 0.45, b.z);
      // Gentle architectural yaw variety (0°, 90°, or ±12° for curved coastal towers)
      const yaw = a === 2 ? ((i % 3) - 1) * 0.22 : (i % 2) * (Math.PI * 0.5);
      quat.setFromAxisAngle(upAxis, yaw);
      scl.set(b.w, b.h, b.d);
      inst.setMatrixAt(i, m4.compose(pos, quat, scl));
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    ownedInsts.push(inst);
    root.add(inst);
    drawCallCount++;
  }

  // ── 2. Layered Coastal Mountain Ridgeline Silhouette (1 Draw Call, ZERO Void Horizon!) ──
  const mountainGeo = buildCoastalMountainGeometry(groundY, riverFarZ, centerX, safeMinTowerZ);
  ownedGeos.push(mountainGeo);
  const mountainMat = new T.ShaderMaterial({
    vertexShader: MOUNTAIN_VERT,
    fragmentShader: MOUNTAIN_FRAG,
    toneMapped: true,
    side: T.DoubleSide,
    uniforms: {
      uDay,
      uNight,
      uSunsetWeight,
      uSeason: weather.uSeason,
      uSnow: weather.uSnowCover,
      uSunDir,
      uSunColor,
      uSkyHorizon,
      uSkyZenith,
      uSunsetColor,
      uFogColor,
      uFogDensity,
      uFogFalloff,
      uFogBaseY,
      uFogMieStrength,
    },
  });
  ownedMats.push(mountainMat);
  const mountainMesh = new T.Mesh(mountainGeo, mountainMat);
  mountainMesh.name = 'city-coastal-mountains';
  mountainMesh.raycast = () => undefined;
  root.add(mountainMesh);
  drawCallCount++;

  // ── 3. Far-Bank Embankment Promenade Walkway & Stone Quay Wall (1 Draw Call) ──
  const promSpan = 640;
  const promWalk = new T.BoxGeometry(promSpan, 0.36, 8.5);
  promWalk.translate(centerX, groundY - 0.16, riverFarZ - 4.2);
  const promCurb = new T.BoxGeometry(promSpan, 0.55, 0.55);
  promCurb.translate(centerX, groundY + 0.12, riverFarZ - 0.25);
  const promGeo = mergeGeometries([prepMerge(promWalk), prepMerge(promCurb)], false)!;
  promWalk.dispose();
  promCurb.dispose();
  ownedGeos.push(promGeo);
  const promMat = new T.MeshStandardMaterial({
    color: '#c2bab0',
    roughness: 0.84,
    metalness: 0.04,
  });
  patchHeightFog(promMat, SHARED_HEIGHT_FOG_UNIFORMS);
  patchMaterialWithEchoCsm(promMat);
  ownedMats.push(promMat);
  const promMesh = new T.Mesh(promGeo, promMat);
  promMesh.name = 'city-farbank-promenade';
  promMesh.receiveShadow = false;
  promMesh.raycast = () => undefined;
  root.add(promMesh);
  drawCallCount++;

  // ── 4. Twin Arched River Bridges + Far-Bank Trees + Warm Promenade Lights (Balanced / High / Ultra) ──
  let bridgeLightMat: T.MeshBasicMaterial | null = null;
  let farLampMat: T.MeshBasicMaterial | null = null;

  if (tier !== 'low') {
    const bridgeXs = [-132, 246];
    const { structure: bridgeGeo, lights: bridgeLightGeo } = buildArchedRiverBridges(
      bridgeXs,
      groundY,
      riverFarZ,
      riverNearZ,
    );
    ownedGeos.push(bridgeGeo, bridgeLightGeo);

    const bridgeMat = new T.MeshStandardMaterial({
      color: '#cfd6df',
      roughness: 0.42,
      metalness: 0.55,
      envMapIntensity: 0.9,
    });
    patchHeightFog(bridgeMat, SHARED_HEIGHT_FOG_UNIFORMS);
    patchMaterialWithEchoCsm(bridgeMat);
    ownedMats.push(bridgeMat);
    const bridgeMesh = new T.Mesh(bridgeGeo, bridgeMat);
    bridgeMesh.name = 'city-arched-river-bridges';
    bridgeMesh.raycast = () => undefined;
    root.add(bridgeMesh);
    drawCallCount++;

    bridgeLightMat = new T.MeshBasicMaterial({
      color: '#ffd28c',
      fog: true,
    });
    ownedMats.push(bridgeLightMat);
    const bridgeLightsMesh = new T.Mesh(bridgeLightGeo, bridgeLightMat);
    bridgeLightsMesh.name = 'city-bridge-lights';
    bridgeLightsMesh.raycast = () => undefined;
    root.add(bridgeLightsMesh);
    drawCallCount++;

    // Far-bank textured multi-cluster irregular botanical tree line (2 InstancedMesh archetypes = lush natural variety!)
    const totalTrees = tier === 'balanced' ? 56 : 96;
    const broadCount = Math.ceil(totalTrees * 0.62);
    const layeredCount = totalTrees - broadCount;
    const farBroadGeo = buildFarBankTreeGeometry();
    const farLayeredGeo = buildFarBankLayeredTreeGeometry();
    ownedGeos.push(farBroadGeo, farLayeredGeo);

    const farTreeMat = new T.ShaderMaterial({
      vertexShader: FAR_TREES_VERT,
      fragmentShader: FAR_TREES_FRAG,
      toneMapped: true,
      uniforms: {
        uDay,
        uSunsetWeight,
        uSeason: weather.uSeason,
        uSnow: weather.uSnowCover,
        uSunDir,
        uSunColor,
        uSkyHorizon,
        uSkyZenith,
        uSunsetColor,
        uFogColor,
        uFogDensity,
        uFogFalloff,
        uFogBaseY,
      },
    });
    ownedMats.push(farTreeMat);

    const broadInst = new T.InstancedMesh(farBroadGeo, farTreeMat, broadCount);
    broadInst.name = 'city-farbank-trees';
    broadInst.raycast = () => undefined;

    const layeredInst = new T.InstancedMesh(farLayeredGeo, farTreeMat, layeredCount);
    layeredInst.name = 'city-farbank-trees-layered';
    layeredInst.raycast = () => undefined;

    const leanQuat = new T.Quaternion();
    const leanAxis = new T.Vector3(0, 0, 1);
    let bIdx = 0;
    let lIdx = 0;
    for (let i = 0; i < totalTrees; i++) {
      const u = i / Math.max(1, totalTrees - 1);
      const r1 = (Math.sin(i * 27.1 + 3.1) * 43758.5453) % 1;
      const h1 = r1 < 0 ? r1 + 1 : r1;
      const r2 = (Math.sin(i * 53.7 + 9.4) * 43758.5453) % 1;
      const h2 = r2 < 0 ? r2 + 1 : r2;
      const r3 = (Math.sin(i * 91.3 + 1.9) * 43758.5453) % 1;
      const h3 = r3 < 0 ? r3 + 1 : r3;

      const tx = centerX - 275 + u * 550 + (h1 - 0.5) * 9.5;
      const tz = riverFarZ - 7.8 - h2 * 19.5;
      const useLayered = lIdx < layeredCount && (bIdx >= broadCount || (i % 3 === 1 && h3 > 0.22));
      const sxz = (useLayered ? 0.82 : 0.88) + h1 * 0.62;
      const sy = sxz * (0.86 + h2 * 0.36);

      pos.set(tx, groundY - 0.30, tz);
      quat.setFromAxisAngle(upAxis, h2 * Math.PI * 2);
      leanQuat.setFromAxisAngle(leanAxis, (h3 - 0.5) * 0.09);
      quat.multiply(leanQuat);
      scl.set(sxz, sy, sxz * (0.90 + h3 * 0.22));
      m4.compose(pos, quat, scl);

      if (useLayered) {
        layeredInst.setMatrixAt(lIdx++, m4);
      } else {
        broadInst.setMatrixAt(bIdx++, m4);
      }
    }
    broadInst.instanceMatrix.needsUpdate = true;
    broadInst.computeBoundingSphere();
    layeredInst.instanceMatrix.needsUpdate = true;
    layeredInst.computeBoundingSphere();
    ownedInsts.push(broadInst, layeredInst);
    root.add(broadInst, layeredInst);
    drawCallCount += 2;

    // Far-bank warm waterfront promenade lanterns (1 InstancedMesh — reflects warmly in planar river water!)
    const lampCount = tier === 'balanced' ? 28 : 44;
    const lampGlobe = new T.SphereGeometry(0.42, 7, 5);
    lampGlobe.translate(0, 3.6, 0);
    const lampPost = new T.CylinderGeometry(0.08, 0.11, 3.5, 5, 1);
    lampPost.translate(0, 1.75, 0);
    const lampGeo = mergeGeometries([prepMerge(lampPost), prepMerge(lampGlobe)], false)!;
    lampPost.dispose();
    lampGlobe.dispose();
    ownedGeos.push(lampGeo);
    farLampMat = new T.MeshBasicMaterial({
      color: '#ffcf86',
      fog: true,
    });
    ownedMats.push(farLampMat);
    const lampInst = new T.InstancedMesh(lampGeo, farLampMat, lampCount);
    lampInst.name = 'city-farbank-lamps';
    lampInst.raycast = () => undefined;
    for (let i = 0; i < lampCount; i++) {
      const u = i / Math.max(1, lampCount - 1);
      pos.set(centerX - 240 + u * 480, groundY - 0.1, riverFarZ - 2.4);
      quat.identity();
      scl.set(1, 1, 1);
      lampInst.setMatrixAt(i, m4.compose(pos, quat, scl));
    }
    lampInst.instanceMatrix.needsUpdate = true;
    lampInst.computeBoundingSphere();
    ownedInsts.push(lampInst);
    root.add(lampInst);
    drawCallCount++;
  }

  return {
    mesh: root,
    group: root,
    material: skylineMat,
    drawCallCount,
    syncAtmosphere(snap, cameraLocal) {
      uDay.value = snap.day;
      uNight.value = snap.night;
      uSunsetWeight.value = snap.sunsetWeight;
      uSunDir.value.copy(snap.sunDir);
      uSunColor.value.copy(snap.sunColor);
      uSkyHorizon.value.copy(snap.skyHorizon);
      uSkyZenith.value.copy(snap.skyZenith);
      uSunsetColor.value.copy(snap.sunsetColor);
      uFogColor.value.copy(snap.fogColor);
      uFogDensity.value = snap.fogDensity;
      uFogFalloff.value = snap.fogHeightFalloff;
      uFogBaseY.value = snap.fogBaseY;
      uFogMieStrength.value = snap.fogMieStrength;
      uCam.value.copy(cameraLocal);

      // Smoothly ignite warm golden bridge & waterfront promenade lanterns across sunset -> night
      const warmGlow = smoothstep(0.55, 0.08, snap.day);
      if (bridgeLightMat) {
        bridgeLightMat.color.setRGB(
          0.35 + 1.15 * warmGlow,
          0.36 + 0.84 * warmGlow,
          0.40 + 0.36 * warmGlow,
        );
      }
      if (farLampMat) {
        farLampMat.color.setRGB(
          0.26 + 1.24 * warmGlow,
          0.28 + 0.88 * warmGlow,
          0.32 + 0.38 * warmGlow,
        );
      }
    },
    dispose() {
      for (const inst of ownedInsts) inst.dispose();
      for (const geo of ownedGeos) geo.dispose();
      for (const mat of ownedMats) mat.dispose();
      root.clear();
      root.removeFromParent();
    },
  };
}

// ── Main AtmosphereSystem Class ────────────────────────────────────────────────────────────────────────────────

const SEASON_DECLINATION = [0.02, 0.36, -0.06, -0.34] as const;

const COL_MIDDAY_ZENITH = new T.Color('#1d6de6');
const COL_MIDDAY_HORIZON = new T.Color('#b0dbff');
const COL_AUTUMN_ZENITH = new T.Color('#2564c9');
const COL_AUTUMN_HORIZON = new T.Color('#c8dff2');
const COL_WINTER_ZENITH = new T.Color('#2c5db0');
const COL_WINTER_HORIZON = new T.Color('#c4dbf0');
const COL_DUSK_ZENITH = new T.Color('#2b2c5c');
const COL_DUSK_HORIZON = new T.Color('#e69b72');
const COL_NIGHT_ZENITH = new T.Color('#050b1c');
const COL_NIGHT_HORIZON = new T.Color('#13213c');
const COL_SUNSET_GLOW = new T.Color('#ff7b3b');
const COL_SUNRISE_GLOW = new T.Color('#ffa05c');
const COL_RAIN_FOG = new T.Color('#667484');
const COL_SNOW_FOG = new T.Color('#b8c4d2');
const COL_NIGHT_RAIN_FOG = new T.Color('#161e2e');
const COL_OVERCAST_TINT_DAY = new T.Color('#96a4b5');
const COL_OVERCAST_TINT_NIGHT = new T.Color('#303d54');
const COL_MIDDAY_SUN = new T.Color('#fff4e0');
const COL_COOL_HEMI_SKY = new T.Color('#7cb4f2');
const COL_GOLDEN_HEMI_SKY = new T.Color('#6b8bc8');
const COL_NIGHT_HEMI_SKY = new T.Color('#1d2e4d');
const COL_NIGHT_HEMI_GROUND = new T.Color('#121824');

const ALL_HDRI_SLOTS: readonly HdriEnvKey[] = ['midday', 'morning', 'sunset', 'night', 'interior'];
const BALANCED_HDRI_SLOTS: readonly HdriEnvKey[] = ['midday', 'sunset', 'interior'];

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Complete Echo Life Atmosphere, Calibrated inZOI Lighting & HDRI PMREM IBL Controller.
 *
 * Mount `atmosphere.skyMesh` inside `echoLife.group` (never sets `scene.background`, so Study Space Overview stays
 * 100% transparent over Giao diện!). Call `warmupHdris(renderer)` when Echo Life starts, `update(dt, input, camera)`
 * every frame, and `applyToScene(...)` to drive `scene.environment`, `hemi`, `key`, indoor `fill`/`windowLight`
 * suppression, analytical height fog, `FogExp2`, and AgX exposure.
 */
export class AtmosphereSystem {
  readonly skyMesh: T.Mesh;
  readonly snapshot: AtmosphereSnapshot;
  readonly heightFogUniforms: SharedHeightFogUniforms = SHARED_HEIGHT_FOG_UNIFORMS;

  private readonly skyGeo: T.SphereGeometry;
  private readonly skyMat: T.ShaderMaterial;
  private readonly tier: WeatherRenderTier;
  private readonly fallbackEnv: T.Texture | null;

  private readonly envBySlot = new Map<HdriEnvKey, T.Texture>();
  private readonly requestedSlots = new Set<HdriEnvKey>();
  private activeRenderer: T.WebGLRenderer | null = null;
  private hdrisRequested = false;
  private disposed = false;

  private blendRt: T.WebGLRenderTarget | null = null;
  private blendScene: T.Scene | null = null;
  private blendCam: T.OrthographicCamera | null = null;
  private blendGeo: T.PlaneGeometry | null = null;
  private blendMat: T.ShaderMaterial | null = null;
  private lastBlendA: T.Texture | null = null;
  private lastBlendB: T.Texture | null = null;
  private lastBlendMix = -1;
  private lastBlendOvercast = -1;
  private blendCooldown = 0;

  private interiorBlend = 1;
  private readonly tmpColA = new T.Color();
  private readonly tmpColB = new T.Color();
  private readonly tmpOvercastTint = new T.Color();
  private readonly tmpViewport = new T.Vector4();
  private readonly tmpScissor = new T.Vector4();
  private readonly waterState: WaterAtmosphereState;

  constructor(
    private readonly weather: SharedWeatherUniforms,
    tier: WeatherRenderTier = 'high',
    fallbackEnv: T.Texture | null = null,
  ) {
    this.tier = tier;
    this.fallbackEnv = fallbackEnv;

    this.snapshot = {
      day: 1,
      night: 0,
      goldenHour: 0,
      twilight: 0,
      sinAlt: 0.7,
      sunVisibility: 1,
      interiorBlend: 1,
      isIndoors: true,
      outdoorLightSuppression: 1,
      sunDir: new T.Vector3(0.35, 0.72, -0.58).normalize(),
      moonDir: new T.Vector3(-0.35, 0.55, -0.65).normalize(),
      keyDir: new T.Vector3(0.35, 0.72, -0.58).normalize(),
      sunColor: new T.Color('#fff4e2'),
      keyColor: new T.Color('#fff4e2'),
      keyIntensity: 3.85,
      hemiSky: COL_COOL_HEMI_SKY.clone(),
      hemiGround: new T.Color('#6e5d49'),
      hemiIntensity: 0.42,
      envIntensity: 0.42,
      exposure: 1.03,
      skyZenith: COL_MIDDAY_ZENITH.clone(),
      skyHorizon: COL_MIDDAY_HORIZON.clone(),
      sunsetColor: COL_SUNSET_GLOW.clone(),
      sunsetWeight: 0,
      fogColor: new T.Color('#bed7ee'),
      fogDensity: 0.0012,
      fogHeightFalloff: 0.032,
      fogBaseY: -3.2,
      fogMieStrength: 0.44,
      cloudCover: 0.15,
      overcast: 0,
    };

    this.waterState = {
      day: 1,
      night: 0,
      sunDir: this.snapshot.sunDir,
      moonDir: this.snapshot.moonDir,
      sunColor: this.snapshot.sunColor,
      sunVisibility: 1,
      skyZenith: this.snapshot.skyZenith,
      skyHorizon: this.snapshot.skyHorizon,
      sunsetColor: this.snapshot.sunsetColor,
      sunsetWeight: 0,
      cloudCover: 0.15,
      fogColor: this.snapshot.fogColor,
      fogDensity: 0.0012,
      fogHeightFalloff: 0.032,
      fogBaseY: -3.2,
      fogMieStrength: 0.44,
    };

    this.skyGeo = new T.SphereGeometry(360, tier === 'low' ? 28 : 48, tier === 'low' ? 16 : 24);
    this.skyMat = new T.ShaderMaterial({
      vertexShader: SKY_DOME_VERT,
      fragmentShader: buildSkyDomeFrag(tier),
      side: T.BackSide,
      depthTest: true,
      depthWrite: false,
      toneMapped: true,
      uniforms: {
        uTime: weather.uTime,
        uRain: weather.uRainIntensity,
        uSnow: weather.uSnowCover,
        uSeason: weather.uSeason,
        uWindVec: weather.uWindVec,
        uDay: { value: 1 },
        uNight: { value: 0 },
        uCloudCover: { value: 0.15 },
        uSunsetWeight: { value: 0 },
        uTwilight: { value: 0 },
        uSunDir: { value: this.snapshot.sunDir.clone() },
        uMoonDir: { value: this.snapshot.moonDir.clone() },
        uSunColor: { value: this.snapshot.sunColor.clone() },
        uSkyZenith: { value: this.snapshot.skyZenith.clone() },
        uSkyHorizon: { value: this.snapshot.skyHorizon.clone() },
        uSunsetColor: { value: this.snapshot.sunsetColor.clone() },
        uFogColor: { value: this.snapshot.fogColor.clone() },
      },
    });

    this.skyMesh = new T.Mesh(this.skyGeo, this.skyMat);
    this.skyMesh.name = 'echo-life-physical-sky';
    // Render sky dome AFTER all opaque geometry (still before transparent glass/particles) for 100% hardware Early-Z culling!
    this.skyMesh.renderOrder = 999;
    this.skyMesh.frustumCulled = false;
    this.skyMesh.raycast = () => undefined;
  }

  /** True when the player/camera is currently indoors. */
  get isIndoors(): boolean {
    return this.snapshot.isIndoors;
  }

  /** 0 outdoors (suppresses indoor `windowLight` & `fill`), 1 indoors, smooth during transition. */
  get outdoorLightSuppression(): number {
    return this.snapshot.outdoorLightSuppression;
  }

  private readonly frameYieldSlicer = new EchoLifeTimeSlicer(8);

  private async waitFrames(count: number): Promise<void> {
    if (count <= 0 || this.disposed) return;
    // Use hidden-tab-safe EchoLifeTimeSlicer (`rAF` when visible, `MessageChannel` / `setTimeout`
    // when backgrounded) so `prewarmHdrisNow()` and `warmupHdris()` NEVER stall in hidden tabs!
    for (let i = 0; i < count; i++) {
      if (this.disposed) return;
      await this.frameYieldSlicer.yieldFrame();
    }
  }

  private requestHdriSlot(
    slot: HdriEnvKey,
    renderer: T.WebGLRenderer,
    priority: 'immediate' | 'background',
    frameSpacing: number,
  ): Promise<T.Texture | null> {
    if (this.disposed) return Promise.resolve(null);
    const cached = this.envBySlot.get(slot);
    if (cached) return Promise.resolve(cached);
    this.requestedSlots.add(slot);
    return acquireHdriEnv(slot, renderer, { priority, frameSpacing }).then((tex) => {
      if (this.disposed) return null;
      if (tex) {
        this.envBySlot.set(slot, tex);
        this.lastBlendMix = -1;
      } else {
        this.requestedSlots.delete(slot);
      }
      return tex;
    });
  }

  /**
   * Active-first amortized HDRI warmup (`P0-PERF-3`):
   * Bakes ONLY the immediately active time-of-day HDRI first (typically `midday` or `interior`),
   * then yields 4 frames before smoothly pacing inactive time-of-day HDRIs at 10-frame intervals
   * (eliminating any sudden 60-frame mid-scene stall while keeping boot responsive).
   */
  warmupHdris(renderer: T.WebGLRenderer): void {
    this.activeRenderer = renderer;
    if (this.hdrisRequested || this.disposed || this.tier === 'low') return;
    this.hdrisRequested = true;

    const slots = this.tier === 'balanced' ? BALANCED_HDRI_SLOTS : ALL_HDRI_SLOTS;
    // Prioritize active outdoor midday/ToD HDRI first so boot doesn't stall baking 4 inactive HDRIs!
    const preferred = selectHdriEnvKey(this.snapshot.day, this.snapshot.isIndoors);
    const primary: HdriEnvKey = slots.includes(preferred) ? preferred : 'midday';
    const deferred = slots.filter((s) => s !== primary);

    void (async () => {
      await this.requestHdriSlot(primary, renderer, 'immediate', 4);
      if (this.disposed || deferred.length === 0) return;

      // Start gentle background pacing right after initial paint (4 frames) instead of stalling 60 frames later!
      await this.waitFrames(4);
      for (const slot of deferred) {
        if (this.disposed) return;
        if (this.envBySlot.has(slot)) continue;
        await this.requestHdriSlot(slot, renderer, 'background', 10);
        if (this.disposed) return;
        await this.waitFrames(10);
      }
    })();
  }

  /**
   * Eagerly prewarms active & tier HDRI PMREM slots behind the loading overlay with short 2-frame yields
   * so mid-scene ToD switches never incur a sudden PMREM bake spike.
   */
  async prewarmHdrisNow(renderer: T.WebGLRenderer): Promise<void> {
    this.activeRenderer = renderer;
    if (this.disposed || this.tier === 'low') return;
    this.hdrisRequested = true;

    const slots = this.tier === 'balanced' ? BALANCED_HDRI_SLOTS : ALL_HDRI_SLOTS;
    const preferred = selectHdriEnvKey(this.snapshot.day, this.snapshot.isIndoors);
    const primary: HdriEnvKey = slots.includes(preferred) ? preferred : 'midday';
    const ordered: HdriEnvKey[] = [primary, ...slots.filter((s) => s !== primary)];
    for (const slot of ordered) {
      if (this.disposed) return;
      if (this.envBySlot.has(slot)) continue;
      await this.requestHdriSlot(slot, renderer, 'immediate', 2);
      if (this.disposed) return;
      await this.waitFrames(2);
    }
  }

  get studioEnvironment(): T.Texture | null {
    return this.envBySlot.get('interior') ?? this.fallbackEnv;
  }

  get activeEnvironment(): T.Texture | null {
    return this.blendRt?.texture ?? this.envBySlot.get('midday') ?? this.envBySlot.get('interior') ?? this.fallbackEnv;
  }

  /** Computes unified physical solar/lunar ephemeris, inZOI calibrated key:fill lighting, height fog & sky dome uniforms. */
  update(dt: number, input: AtmosphereInput, cameraLocal: T.Vector3): AtmosphereSnapshot {
    const safeDt = Math.max(0, Math.min(dt, 0.1));
    const hour = ((input.hour % 24) + 24) % 24;
    const sIdx = Math.max(0, Math.min(3, input.season | 0));
    const rain = Math.max(0, Math.min(1, input.rain));
    const snow = Math.max(0, Math.min(1, input.snow));
    const cloud = Math.max(0, Math.min(1, input.cloud));
    const overcast = Math.max(rain, snow * 0.82);

    const targetInterior = input.outdoors ? 0 : 1;
    if (input.reduced) {
      this.interiorBlend = targetInterior;
    } else {
      this.interiorBlend += (targetInterior - this.interiorBlend) * (1 - Math.exp(-6.5 * safeDt));
      if (Math.abs(this.interiorBlend - targetInterior) < 0.002) this.interiorBlend = targetInterior;
    }

    // ── 1. Physical Seasonal Solar & Lunar Ephemeris ──
    const decl = SEASON_DECLINATION[sIdx];
    const hourAngle = ((hour - 12) / 12) * Math.PI;
    const lat = 0.56; // ~32° N coastal latitude gives crisp sculptural ~52–58° midday shadows instead of flat overhead noon
    const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
    const azimX = -Math.sin(hourAngle) * Math.cos(decl);
    const azimZ = -(Math.sin(decl) - Math.sin(lat) * sinAlt) / Math.max(0.18, Math.cos(lat));
    this.snapshot.sunDir.set(azimX, sinAlt, azimZ * 0.38 - 0.36).normalize();
    this.snapshot.moonDir.set(-azimX * 0.85, Math.max(0.28, -sinAlt * 0.85 + 0.28), -0.46).normalize();
    this.snapshot.sinAlt = sinAlt;

    // ── 2. Continuous Solar Phase Weights ──
    const day = smoothstep(-0.08, 0.40, sinAlt);
    const night = smoothstep(0.08, -0.14, sinAlt);
    const twilight = smoothstep(-0.18, -0.02, sinAlt) * smoothstep(0.18, 0.0, sinAlt);
    const sunsetWeight = smoothstep(-0.11, 0.04, sinAlt) * smoothstep(0.36, 0.06, sinAlt) * (1 - overcast * 0.55);
    const goldenHour = smoothstep(-0.04, 0.14, sinAlt) * smoothstep(0.46, 0.16, sinAlt) * (1 - overcast * 0.42);
    const isMorning = hour < 12;

    this.snapshot.day = day;
    this.snapshot.night = night;
    this.snapshot.goldenHour = goldenHour;
    this.snapshot.twilight = twilight;
    this.snapshot.sunsetWeight = sunsetWeight;
    this.snapshot.cloudCover = cloud;
    this.snapshot.overcast = overcast;
    this.snapshot.interiorBlend = this.interiorBlend;
    this.snapshot.isIndoors = isIndoors(this.interiorBlend);
    this.snapshot.outdoorLightSuppression = outdoorLightSuppression(this.interiorBlend);

    // ── 3. Calibrated inZOI Physical Sun Key & Shadow Vector (3.6:1–4.0:1 Midday, 3.2:1 Golden Hour!) ──
    const midWeight = smoothstep(0.18, 0.50, sinAlt);
    this.tmpColA.copy(isMorning ? COL_SUNRISE_GLOW : COL_SUNSET_GLOW);
    this.tmpColB.set('#ffdcb0').lerp(COL_MIDDAY_SUN, midWeight);
    this.snapshot.sunColor.copy(this.tmpColA).lerp(this.tmpColB, smoothstep(0.0, 0.34, sinAlt));

    const sunAbove = smoothstep(-0.04, 0.08, sinAlt);
    this.snapshot.sunVisibility = sunAbove * (1 - cloud * 0.68) * (1 - overcast * 0.62);

    const useMoonKey = sinAlt < -0.04;
    if (useMoonKey) {
      this.snapshot.keyDir.copy(this.snapshot.moonDir);
      if (this.snapshot.keyDir.y < 0.28) {
        const minY = 0.28;
        const hLen = Math.hypot(this.snapshot.keyDir.x, this.snapshot.keyDir.z);
        const hScale = hLen > 1e-4 ? Math.sqrt(1 - minY * minY) / hLen : 0;
        this.snapshot.keyDir.set(this.snapshot.keyDir.x * hScale, minY, this.snapshot.keyDir.z * hScale);
      }
      this.snapshot.keyColor.set('#84aef0');
      const moonFade = smoothstep(-0.04, -0.14, sinAlt);
      this.snapshot.keyIntensity = (0.14 + 0.48 * moonFade) * (1 - overcast * 0.52);
    } else {
      // Clamp directional shadow key elevation >= 12.4° (`y >= 0.215`) during golden hour/sunset
      // so long golden shadows stay crisp & grounded instead of collapsing to 0.02:1 (`G-01`)!
      this.snapshot.keyDir.copy(this.snapshot.sunDir);
      if (this.snapshot.keyDir.y < 0.215) {
        const minY = 0.215;
        const hLen = Math.hypot(this.snapshot.keyDir.x, this.snapshot.keyDir.z);
        const hScale = hLen > 1e-4 ? Math.sqrt(1 - minY * minY) / hLen : 0;
        this.snapshot.keyDir.set(this.snapshot.keyDir.x * hScale, minY, this.snapshot.keyDir.z * hScale);
      }
      this.snapshot.keyColor.copy(this.snapshot.sunColor);
      const sunLift = smoothstep(-0.04, 0.06, sinAlt);
      // Golden hour ~3.35 -> Crisp sunny midday ~3.88; overcast & heavy rain soften naturally.
      const clearInt = 0.25 + sunLift * (3.10 + midWeight * 0.53);
      this.snapshot.keyIntensity = clearInt * (1 - cloud * 0.34) * (1 - overcast * 0.38);
    }

    // ── 4. Physical Sky Palette, Cool Sky-Blue Hemisphere Fill, Height Fog & Balanced HDRI IBL ──
    const seasonZenith = sIdx === 3 ? COL_WINTER_ZENITH : sIdx === 2 ? COL_AUTUMN_ZENITH : COL_MIDDAY_ZENITH;
    const seasonHorizon = sIdx === 3 ? COL_WINTER_HORIZON : sIdx === 2 ? COL_AUTUMN_HORIZON : COL_MIDDAY_HORIZON;

    this.snapshot.skyZenith
      .copy(COL_NIGHT_ZENITH)
      .lerp(COL_DUSK_ZENITH, twilight * 0.92)
      .lerp(seasonZenith, day);
    this.snapshot.skyHorizon
      .copy(COL_NIGHT_HORIZON)
      .lerp(COL_DUSK_HORIZON, sunsetWeight * 0.88)
      .lerp(seasonHorizon, smoothstep(0.14, 0.55, sinAlt));
    this.snapshot.sunsetColor.copy(isMorning ? COL_SUNRISE_GLOW : COL_SUNSET_GLOW);

    // Cool sky-blue hemisphere shadow fill (contrasts crisply against warm sunlit key like inZOI!)
    this.snapshot.hemiSky
      .copy(COL_NIGHT_HEMI_SKY)
      .lerp(COL_GOLDEN_HEMI_SKY, goldenHour * 0.85)
      .lerp(COL_COOL_HEMI_SKY, day * (1 - goldenHour * 0.35));
    this.snapshot.hemiGround
      .set(sIdx === 2 ? '#765c44' : sIdx === 3 ? '#646e78' : '#5e5645')
      .lerp(COL_NIGHT_HEMI_GROUND, night * 0.86);
    // Calibrated midday hemi = 0.40, golden hour = 0.36, night = 0.24 (keeps sun:fill at 3.6–4.0:1!).
    this.snapshot.hemiIntensity = (0.24 + day * 0.16 + goldenHour * 0.03) * (1 - overcast * 0.16);

    // Fog color harmonized seamlessly with horizon + sunset Mie glow
    this.snapshot.fogColor
      .copy(this.snapshot.skyHorizon)
      .lerp(this.snapshot.sunsetColor, sunsetWeight * 0.40);
    if (rain > 0.05) {
      this.tmpColA.copy(COL_NIGHT_RAIN_FOG).lerp(COL_RAIN_FOG, day);
      this.snapshot.fogColor.lerp(this.tmpColA, rain * 0.72);
    } else if (snow > 0.05) {
      this.tmpColA.copy(COL_NIGHT_RAIN_FOG).lerp(COL_SNOW_FOG, day);
      this.snapshot.fogColor.lerp(this.tmpColA, snow * 0.72);
    } else if (cloud > 0.72) {
      this.tmpColA.copy(COL_NIGHT_RAIN_FOG).lerp(COL_RAIN_FOG, day);
      this.snapshot.fogColor.lerp(this.tmpColA, smoothstep(0.72, 0.96, cloud) * 0.42);
    }

    const baseFog = input.baseFogDensity ?? (
      rain > 0.75 ? 0.0032 : rain > 0.1 ? 0.0024 : snow > 0.1 ? 0.0026 : cloud > 0.7 ? 0.0019 : 0.00135
    );
    const outMask = 1 - this.interiorBlend;
    this.snapshot.fogDensity = baseFog * (1 + night * 0.22 + goldenHour * 0.18) * outMask;
    this.snapshot.fogHeightFalloff = rain > 0.3 || snow > 0.3 ? 0.022 : 0.032;
    this.snapshot.fogBaseY = -3.2;
    this.snapshot.fogMieStrength = (0.36 + goldenHour * 0.48 + day * 0.10) * (1 - overcast * 0.65);

    // Sync shared analytical Exponential Height Fog uniforms once per frame for all patched world surfaces!
    const hf = this.heightFogUniforms;
    hf.uHfColor.value.copy(this.snapshot.fogColor);
    hf.uHfSunColor.value.copy(this.snapshot.sunColor).lerp(this.snapshot.sunsetColor, sunsetWeight * 0.65);
    hf.uHfSunDir.value.copy(this.snapshot.sunDir);
    hf.uHfParams.value.set(
      this.snapshot.fogDensity,
      this.snapshot.fogHeightFalloff,
      this.snapshot.fogBaseY,
      this.snapshot.fogDensity > 0.00005 ? 1 : 0,
    );
    hf.uHfScatter.value.set(0.76, this.snapshot.fogMieStrength, 0.94, sunsetWeight);

    // Balanced HDRI IBL: 0.40 midday, 0.38 golden hour, 0.25 night (prevents shadow washout while keeping rich PBR reflections!)
    const outdoorEnvInt = (0.25 + day * 0.16 + goldenHour * 0.05) * (1 - overcast * 0.18);
    this.snapshot.envIntensity = outdoorEnvInt * outMask + 0.50 * this.interiorBlend;
    const outdoorExp = 0.96 + day * 0.08 + goldenHour * 0.03 - overcast * 0.04;
    this.snapshot.exposure = outdoorExp * outMask + 1.00 * this.interiorBlend;

    // ── 5. Update Sky Dome Uniforms & Follow Camera Position ──
    const su = this.skyMat.uniforms;
    su.uDay.value = day;
    su.uNight.value = night;
    su.uCloudCover.value = cloud;
    su.uSunsetWeight.value = sunsetWeight;
    su.uTwilight.value = twilight;
    su.uSunDir.value.copy(this.snapshot.sunDir);
    su.uMoonDir.value.copy(this.snapshot.moonDir);
    su.uSunColor.value.copy(this.snapshot.sunColor);
    su.uSkyZenith.value.copy(this.snapshot.skyZenith);
    su.uSkyHorizon.value.copy(this.snapshot.skyHorizon);
    su.uSunsetColor.value.copy(this.snapshot.sunsetColor);
    su.uFogColor.value.copy(this.snapshot.fogColor);
    this.skyMesh.position.copy(cameraLocal);

    this.blendCooldown = Math.max(0, this.blendCooldown - safeDt);
    return this.snapshot;
  }

  private resolveHdriBlend(): { texA: T.Texture; texB: T.Texture; mix: number } | null {
    const fallback = this.fallbackEnv ?? this.envBySlot.get('interior') ?? this.envBySlot.get('midday') ?? null;
    if (!fallback) return null;

    const { sinAlt, interiorBlend } = this.snapshot;
    const wNight = smoothstep(0.05, -0.14, sinAlt);
    const wSunset = smoothstep(-0.12, 0.04, sinAlt) * smoothstep(0.28, 0.06, sinAlt);
    const wMorning = smoothstep(0.06, 0.24, sinAlt) * smoothstep(0.62, 0.34, sinAlt);
    const wMidday = smoothstep(0.38, 0.66, sinAlt);

    const outScale = 1 - interiorBlend;
    const candidates: [HdriEnvKey, number][] = [
      ['midday', wMidday * outScale],
      ['morning', wMorning * outScale],
      ['sunset', wSunset * outScale],
      ['night', wNight * outScale],
      ['interior', interiorBlend],
    ];

    const resolved = new Map<T.Texture, number>();
    const pickTex = (slot: HdriEnvKey): T.Texture => {
      const direct = this.envBySlot.get(slot);
      if (direct) return direct;
      if (slot === 'morning') return this.envBySlot.get('midday') ?? this.envBySlot.get('sunset') ?? fallback;
      if (slot === 'night') return this.envBySlot.get('sunset') ?? this.envBySlot.get('interior') ?? fallback;
      return fallback;
    };

    for (const [slot, w] of candidates) {
      if (w <= 0.001) continue;
      // On-demand immediate promotion if player switched ToD or entered/exited a building before background prewarm!
      if (w > 0.08 && !this.envBySlot.has(slot) && this.activeRenderer && this.tier !== 'low') {
        const allowed = this.tier === 'balanced' ? BALANCED_HDRI_SLOTS : ALL_HDRI_SLOTS;
        if (allowed.includes(slot) && !this.requestedSlots.has(slot)) {
          void this.requestHdriSlot(slot, this.activeRenderer, 'immediate', 6);
        }
      }
      const tex = pickTex(slot);
      resolved.set(tex, (resolved.get(tex) ?? 0) + w);
    }

    const sorted = [...resolved.entries()].sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return { texA: fallback, texB: fallback, mix: 0 };
    if (sorted.length === 1) return { texA: sorted[0][0], texB: sorted[0][0], mix: 0 };
    const [texA, wA] = sorted[0];
    const [texB, wB] = sorted[1];
    return { texA, texB, mix: wB / Math.max(1e-4, wA + wB) };
  }

  syncEnvironment(renderer: T.WebGLRenderer, scene: T.Scene, force = false): void {
    if (this.disposed) return;
    this.activeRenderer = renderer;
    if (this.tier === 'low') {
      const tex = this.envBySlot.get('interior') ?? this.fallbackEnv;
      if (tex && scene.environment !== tex) scene.environment = tex;
      return;
    }

    const blend = this.resolveHdriBlend();
    if (!blend) return;

    const { texA, texB, mix } = blend;
    const overcast = this.snapshot.overcast * (1 - this.interiorBlend);

    // Fast path: single dominant HDRI with clear weather -> bind directly with ZERO blend-RT render pass!
    if ((texA === texB || mix <= 0.002) && overcast <= 0.01) {
      if (scene.environment !== texA) scene.environment = texA;
      this.lastBlendA = texA;
      this.lastBlendB = texA;
      this.lastBlendMix = 0;
      this.lastBlendOvercast = 0;
      return;
    }

    const imgA = texA.image as { width?: number; height?: number } | undefined;
    const imgB = texB.image as { width?: number; height?: number } | undefined;
    const wA = imgA?.width ?? 0, hA = imgA?.height ?? 0;
    const wB = imgB?.width ?? 0, hB = imgB?.height ?? 0;
    if (!wA || !hA || wA !== wB || hA !== hB) {
      const dom = mix > 0.5 ? texB : texA;
      if (scene.environment !== dom) scene.environment = dom;
      return;
    }

    const slotChanged = texA !== this.lastBlendA || texB !== this.lastBlendB;
    const mixDelta = Math.abs(mix - this.lastBlendMix);
    const overDelta = Math.abs(overcast - this.lastBlendOvercast);
    if (!force && !slotChanged && (this.blendCooldown > 0 || (mixDelta < 0.012 && overDelta < 0.02))) {
      if (this.blendRt && scene.environment !== this.blendRt.texture) {
        scene.environment = this.blendRt.texture;
      }
      return;
    }

    if (!this.blendRt || this.blendRt.width !== wA || this.blendRt.height !== hA) {
      this.blendRt?.dispose();
      this.blendRt = new T.WebGLRenderTarget(wA, hA, {
        magFilter: T.LinearFilter,
        minFilter: T.LinearFilter,
        generateMipmaps: false,
        type: T.HalfFloatType,
        format: T.RGBAFormat,
        colorSpace: T.LinearSRGBColorSpace,
        depthBuffer: false,
      });
      this.blendRt.texture.mapping = T.CubeUVReflectionMapping;
      this.blendRt.texture.name = 'echo-life-blended-pmrem';
    }

    if (!this.blendMat) {
      this.blendGeo = new T.PlaneGeometry(2, 2);
      this.blendMat = new T.ShaderMaterial({
        vertexShader: PMREM_BLEND_VERT,
        fragmentShader: PMREM_BLEND_FRAG,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        uniforms: {
          uEnvA: { value: texA },
          uEnvB: { value: texB },
          uMix: { value: 0 },
          uOvercast: { value: 0 },
          uOvercastTint: { value: new T.Color('#96a4b5') },
        },
      });
      this.blendCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.blendScene = new T.Scene();
      this.blendScene.add(new T.Mesh(this.blendGeo, this.blendMat));
    }

    this.tmpOvercastTint.copy(COL_OVERCAST_TINT_NIGHT).lerp(COL_OVERCAST_TINT_DAY, this.snapshot.day);
    this.blendMat.uniforms.uEnvA.value = texA;
    this.blendMat.uniforms.uEnvB.value = texB;
    this.blendMat.uniforms.uMix.value = mix;
    this.blendMat.uniforms.uOvercast.value = overcast;
    this.blendMat.uniforms.uOvercastTint.value.copy(this.tmpOvercastTint);

    const prevTarget = renderer.getRenderTarget();
    const prevTone = renderer.toneMapping;
    const prevAutoClear = renderer.autoClear;
    const prevXr = renderer.xr.enabled;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    renderer.getViewport(this.tmpViewport);
    renderer.getScissor(this.tmpScissor);
    const prevScissorTest = renderer.getScissorTest();

    try {
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.toneMapping = T.NoToneMapping;
      renderer.autoClear = false;
      renderer.setScissorTest(false);
      renderer.setRenderTarget(this.blendRt);
      renderer.render(this.blendScene!, this.blendCam!);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setViewport(this.tmpViewport);
      renderer.setScissor(this.tmpScissor);
      renderer.setScissorTest(prevScissorTest);
      renderer.toneMapping = prevTone;
      renderer.autoClear = prevAutoClear;
      renderer.xr.enabled = prevXr;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.shadowMap.needsUpdate = prevShadowNeeds;
    }

    if (scene.environment !== this.blendRt.texture) {
      scene.environment = this.blendRt.texture;
    }

    this.lastBlendA = texA;
    this.lastBlendB = texB;
    this.lastBlendMix = mix;
    this.lastBlendOvercast = overcast;
    this.blendCooldown = 1 / 15;
  }

  /**
   * Applies the active outdoor/transition lighting rig (calibrated HDRI PMREM, cool sky-blue hemisphere fill,
   * directional sun/moon key, explicit outdoor suppression of indoor `windowLight` & `fill`, `FogExp2` + height fog,
   * and AgX exposure) while strictly preserving `scene.background = null`.
   */
  applyToScene(
    scene: T.Scene,
    renderer: T.WebGLRenderer,
    targets: AtmosphereLightTargets,
    audioEnvPulse = 0,
  ): void {
    this.syncEnvironment(renderer, scene);
    const s = this.snapshot;
    scene.environmentIntensity = s.envIntensity + audioEnvPulse;

    targets.hemi.color.copy(s.hemiSky);
    targets.hemi.groundColor.copy(s.hemiGround);
    targets.hemi.intensity = s.hemiIntensity;

    targets.key.color.copy(s.keyColor);
    targets.key.intensity = s.keyIntensity;
    renderer.toneMappingExposure = s.exposure;

    // Fix G-01: strictly suppress un-shadowed indoor directional `fill` & `windowLight` outdoors!
    const indoorSup = s.outdoorLightSuppression;
    if (targets.fill) {
      targets.fill.intensity = indoorSup <= 0.001 ? 0 : targets.fill.intensity * indoorSup;
    }
    if (targets.windowLight) {
      targets.windowLight.intensity = indoorSup <= 0.001 ? 0 : targets.windowLight.intensity * indoorSup;
    }

    // Always keep `scene.fog` bound as `FogExp2` (`density = 0` indoors instead of `scene.fog = null`)
    // so `USE_FOG` shader permutations never double when crossing building doorways!
    targets.fog.color.copy(s.fogColor);
    targets.fog.density = s.fogDensity > 0.00005 ? s.fogDensity : 0;
    if (scene.fog !== targets.fog) {
      scene.fog = targets.fog;
    }
  }

  /** Returns a zero-allocation `WaterAtmosphereState` view synchronized to the current frame. */
  toWaterAtmosphere(lampPositions?: readonly T.Vector3[]): WaterAtmosphereState {
    const s = this.snapshot;
    const w = this.waterState;
    w.day = s.day;
    w.night = s.night;
    w.sunVisibility = s.sunVisibility;
    w.sunsetWeight = s.sunsetWeight;
    w.cloudCover = s.cloudCover;
    w.fogDensity = s.fogDensity;
    w.fogHeightFalloff = s.fogHeightFalloff;
    w.fogBaseY = s.fogBaseY;
    w.fogMieStrength = s.fogMieStrength;
    w.lampPositions = lampPositions;
    w.indoors = s.isIndoors;
    return w;
  }

  dispose(): void {
    this.disposed = true;
    this.activeRenderer = null;
    this.requestedSlots.clear();
    this.skyGeo.dispose();
    this.skyMat.dispose();
    this.skyMesh.removeFromParent();
    this.blendRt?.dispose();
    this.blendRt = null;
    this.blendGeo?.dispose();
    this.blendGeo = null;
    this.blendMat?.dispose();
    this.blendMat = null;
    this.blendScene = null;
    this.blendCam = null;
    this.envBySlot.clear();
  }
}
