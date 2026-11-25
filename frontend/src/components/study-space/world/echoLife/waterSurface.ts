import * as T from 'three';
import { RENDER_CONFIGS } from './renderConfig';
import type { SharedWeatherUniforms, WeatherRenderTier } from './weatherSystem';
import { chainMaterialShader, hasAllSceneShadowMaps, patchMaterialWithEchoCsm } from './echoCsm';
import { getSharedHeightFogUniforms, patchHeightFog } from './atmosphere';

/**
 * Echo Life AAA — Real-Time 0.5x Planar-Reflective River Water Surface & Wind-Swaying Shoreline Reeds.
 *
 * Key upgrades:
 * - Distance-gated 0.5x HalfFloatType planar `Reflector` real-time reflection pass on `high` / `ultra`
 *   (oblique clip plane, reflects live sky dome, sculpted downtown skyline, coastal mountains, arched bridge,
 *   riverside trees, and warm night streetlamps — smoothly blended by physical Schlick Fresnel & faded by distance).
 * - Kaplanyan/Toksvig screen-space normal-variance specular anti-aliasing (`dFdx`/`dFdy`) + rain-calibrated
 *   roughness filtering permanently eliminating Night Heavy Rain white/black zebra sparkle aliasing (`G-17`).
 * - Rich Beer-Lambert emerald-teal bathymetry transition + bank caustics + animated multi-scale shoreline foam.
 * - Analytical Exponential Height Fog + Henyey-Greenstein Mie sun scatter synced with `AtmosphereSystem`.
 * - Single-draw-call instanced wind-swaying riverbank reeds/cattails tucked safely outside all walkways.
 */

export const MAX_WATER_LAMPS = 6;

export interface WaterRiverRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface WaterSurfaceOptions {
  river: WaterRiverRect;
  waterY: number;
  tier: WeatherRenderTier;
  weather: SharedWeatherUniforms;
  /** Optional tileable normal map for extra fine capillary detail (can also be attached later via `setNormalMap`). */
  normalMap?: T.Texture | null;
}

export interface WaterAtmosphereState {
  day: number;
  night: number;
  sunDir: T.Vector3;
  moonDir: T.Vector3;
  sunColor: T.Color;
  /** 0..1 effective solar disc brightness above horizon attenuated by cloud cover. */
  sunVisibility: number;
  skyZenith: T.Color;
  skyHorizon: T.Color;
  sunsetColor: T.Color;
  sunsetWeight: number;
  cloudCover: number;
  fogColor: T.Color;
  fogDensity: number;
  /** Optional exponential height-fog vertical falloff (default 0.032). */
  fogHeightFalloff?: number;
  /** Optional exponential height-fog ground reference Y (default -3.2). */
  fogBaseY?: number;
  /** Optional Henyey-Greenstein sun scatter strength in fog (default 0.42). */
  fogMieStrength?: number;
  /** Up to 6 nearest riverside streetlamp world positions (stage coordinates). */
  lampPositions?: readonly T.Vector3[];
  /** True when the player/camera is currently indoors (auto-skips planar river reflection). */
  indoors?: boolean;
}

export interface WaterSurfaceDiagnostics {
  readonly tier: WeatherRenderTier;
  readonly planarReflectionEnabled: boolean;
  readonly lastFrameReflected: boolean;
  readonly reflectionWidth: number;
  readonly reflectionHeight: number;
  readonly reflectionCadence: number;
  readonly reflectionMaxDist: number;
  readonly skippedReason: string | null;
}

const WATER_VERT = /* glsl */ `
uniform float uTime;
uniform float uRiverZ0;
uniform float uRiverZ1;
uniform vec2 uRiverCenter;
uniform float uWaterY;
uniform vec2 uWindVec;
uniform float uSwellAmp;
uniform mat4 uTextureMatrix;

varying vec3 vWorldPos;
varying vec3 vLocalPos;
varying vec4 vReflectUv;
varying float vWaveH;

void main() {
  vec3 localP = vec3( position.x + uRiverCenter.x, position.y + uWaterY, position.z + uRiverCenter.y );
  float bankDist = min( abs( localP.z - uRiverZ1 ), abs( localP.z - uRiverZ0 ) );
  float bankDamp = smoothstep( 0.0, 2.0, bankDist );

  // Subtle multi-directional river swells (damped cleanly to 0 at embankment walls to avoid seams).
  vec2 flow = vec2( 0.42, 0.04 ) + uWindVec * 0.10;
  vec2 p = localP.xz;
  float h = 0.0;
  if ( uSwellAmp > 0.0001 ) {
    h += sin( dot( p, vec2( 0.34,  0.14 ) ) - uTime * ( 1.05 + length( flow ) * 0.35 ) ) * 0.48;
    h += sin( dot( p, vec2( 0.52, -0.36 ) ) - uTime * 1.48 + 1.3 ) * 0.30;
    h += sin( dot( p, vec2( -0.22, 0.68 ) ) - uTime * 1.85 + 2.7 ) * 0.22;
    h *= uSwellAmp * bankDamp;
  }

  vec3 displaced = vec3( position.x, position.y + h, position.z );
  vec4 wp = modelMatrix * vec4( displaced, 1.0 );
  vWorldPos = wp.xyz;
  vLocalPos = vec3( localP.x, localP.y + h, localP.z );
  vReflectUv = uTextureMatrix * vec4( position, 1.0 );
  vWaveH = h;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

function buildWaterFrag(tier: WeatherRenderTier): string {
  if (tier === 'low') {
    // Lean iGPU water fragment shader: single-scroll analytic ripple normal + physical Fresnel sky gradient
    // + emerald-teal bathymetry + single sun highlight + exponential fog (zero FBM clouds/foam/caustics!).
    return /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uDay;
uniform float uNight;
uniform float uRain;
uniform float uSnow;
uniform float uSunVis;
uniform float uSunsetWeight;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunsetColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogBaseY;
uniform vec2 uWindVec;
uniform float uRiverZ0;
uniform float uRiverZ1;

varying vec3 vWorldPos;
varying vec3 vLocalPos;
varying vec4 vReflectUv;
varying float vWaveH;

void main() {
  vec3 toCam = cameraPosition - vWorldPos;
  float camDist = length( toCam );
  vec3 V = toCam / max( camDist, 1e-4 );

  float bankDist = min( abs( vLocalPos.z - uRiverZ1 ), abs( vLocalPos.z - uRiverZ0 ) );
  float depthT = smoothstep( 0.0, 6.2, bankDist );

  // Fast single-scroll analytic directional ripple normal (zero FBM noise octaves).
  vec2 flow = vec2( 0.45, 0.04 ) + uWindVec * 0.12;
  vec2 p = vLocalPos.xz - flow * ( uTime * 0.65 );
  float ph1 = dot( p, vec2( 0.62, 0.28 ) );
  float ph2 = dot( p, vec2( -0.34, 0.88 ) ) + 1.4;
  vec2 grad = ( vec2( 0.62, 0.28 ) * cos( ph1 ) * 0.085 + vec2( -0.34, 0.88 ) * cos( ph2 ) * 0.055 ) * smoothstep( 130.0, 14.0, camDist );
  vec3 N = normalize( vec3( -grad.x, 1.0, -grad.y ) );

  vec3 shallowCol = mix( vec3( 0.025, 0.068, 0.085 ), vec3( 0.125, 0.325, 0.295 ), uDay );
  vec3 deepCol    = mix( vec3( 0.008, 0.020, 0.045 ), vec3( 0.022, 0.115, 0.180 ), uDay );
  vec3 bodyCol    = mix( shallowCol, deepCol, depthT );

  float NdotV = max( dot( N, V ), 0.0 );
  float fresnel = 0.02 + 0.98 * pow( 1.0 - NdotV, 5.0 );
  vec3 R = reflect( -V, N );
  float rh = clamp( abs( R.y ) + 0.02, 0.0, 1.0 );
  vec3 skyRefl = mix( uSkyHorizon, uSkyZenith, pow( rh, 0.56 ) );
  skyRefl += uSunsetColor * uSunsetWeight * pow( 1.0 - rh, 2.2 ) * 0.55;

  vec3 L = normalize( uSunDir );
  vec3 H = normalize( L + V );
  float spec = pow( max( dot( N, H ), 0.0 ), 96.0 ) * uSunVis * smoothstep( -0.02, 0.14, L.y ) * 1.15;
  vec3 waterCol = mix( bodyCol, skyRefl, clamp( fresnel * 0.92, 0.08, 0.94 ) ) + uSunColor * spec;

  // Lightweight exponential height fog synced with AtmosphereSystem.
  float hfCamH = max( 0.0, cameraPosition.y - uFogBaseY );
  float hfTau = uFogDensity * exp( -uFogFalloff * hfCamH ) * camDist;
  float fogFactor = clamp( 1.0 - exp( -hfTau ), 0.0, 0.92 );
  waterCol = mix( waterCol, uFogColor, fogFactor );

  gl_FragColor = vec4( waterCol, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
  }

  const rainLayers = tier === 'ultra' ? 3 : tier === 'high' ? 2 : 1;
  const highDetail = tier === 'ultra' || tier === 'high';

  return /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uDay;
uniform float uNight;
uniform float uRain;
uniform float uSnow;
uniform float uCloudCover;
uniform float uSunVis;
uniform float uSunsetWeight;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunsetColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogBaseY;
uniform float uFogMieStrength;
uniform vec3 uCam;
uniform vec2 uWindVec;
uniform float uRiverZ0;
uniform float uRiverZ1;
uniform vec3 uLampPos[${MAX_WATER_LAMPS}];
uniform int uLampCount;
uniform sampler2D uDetailNormal;
uniform float uHasDetailNormal;
uniform sampler2D uReflectMap;
uniform float uReflectMix;

varying vec3 vWorldPos;
varying vec3 vLocalPos;
varying vec4 vReflectUv;
varying float vWaveH;

const float PI = 3.14159265359;

float wHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

vec2 wHash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}

// Smooth value noise returning (value, d/dx, d/dz) analytically — zero coupled X/Z artifacts!
vec3 wNoiseDeriv( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  vec2 du = 6.0 * f * ( 1.0 - f );

  float a = wHash12( i );
  float b = wHash12( i + vec2( 1.0, 0.0 ) );
  float c = wHash12( i + vec2( 0.0, 1.0 ) );
  float d = wHash12( i + vec2( 1.0, 1.0 ) );

  float k0 = a;
  float k1 = b - a;
  float k2 = c - a;
  float k3 = a - b - c + d;

  float val = k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
  vec2 grad = du * vec2( k1 + k3 * u.y, k2 + k3 * u.x );
  return vec3( val, grad );
}

// Rotated multi-octave FBM returning (height, dH/dx, dH/dz) cleanly in world XZ.
vec3 wWaveFbm( vec2 p, float distAtten ) {
  const mat2 rot = mat2( 0.80, -0.60, 0.60, 0.80 );
  const mat2 rotT = mat2( 0.80, 0.60, -0.60, 0.80 );
  vec3 acc = vec3( 0.0 );
  float amp = 0.50;
  float freq = 1.0;
  mat2 invBasis = mat2( 1.0, 0.0, 0.0, 1.0 );

  vec3 n0 = wNoiseDeriv( p );
  acc.x += n0.x * amp;
  acc.yz += ( invBasis * n0.yz ) * amp * freq;

  p = rot * p * 2.04 + vec2( 19.3, 7.1 );
  invBasis = invBasis * rotT;
  amp *= 0.48; freq *= 2.04;
  vec3 n1 = wNoiseDeriv( p );
  acc.x += n1.x * amp;
  acc.yz += ( invBasis * n1.yz ) * amp * freq * distAtten;

  ${
    highDetail
      ? /* glsl */ `
  p = rot * p * 2.07 + vec2( 31.7, 13.9 );
  invBasis = invBasis * rotT;
  amp *= 0.42; freq *= 2.07;
  vec3 n2 = wNoiseDeriv( p );
  acc.x += n2.x * amp;
  acc.yz += ( invBasis * n2.yz ) * amp * freq * distAtten * distAtten;
  `
      : ''
  }
  return acc;
}

float wFbmSimple( vec2 p ) {
  const mat2 rot = mat2( 0.80, -0.60, 0.60, 0.80 );
  float v = 0.55 * wNoiseDeriv( p ).x;
  p = rot * p * 2.07 + vec2( 11.4, 23.1 );
  v += 0.30 * wNoiseDeriv( p ).x;
  p = rot * p * 2.11 + vec2( 5.7, 41.9 );
  v += 0.15 * wNoiseDeriv( p ).x;
  return v;
}

${
  rainLayers > 0
    ? /* glsl */ `
// Band-limited concentric raindrop ripples (calibrated frequency prevents Night Heavy Rain zebra aliasing).
vec2 wRainRippleLayer( vec2 xz, float scale, float time, float seedOff ) {
  vec2 p = xz * scale;
  vec2 cell = floor( p );
  vec2 f = fract( p );
  vec2 grad = vec2( 0.0 );
  for ( int dy = -1; dy <= 1; dy++ ) {
    for ( int dx = -1; dx <= 1; dx++ ) {
      vec2 g = cell + vec2( float( dx ), float( dy ) );
      vec2 rnd = wHash22( g + seedOff );
      float life = fract( time * ( 0.72 + rnd.x * 0.42 ) + rnd.y );
      vec2 center = vec2( float( dx ), float( dy ) ) + 0.18 + rnd * 0.64;
      vec2 d = f - center;
      float r = length( d ) + 1e-4;
      float waveR = life * 0.56;
      float env = exp( -abs( r - waveR ) * 11.5 ) * ( 1.0 - life ) * smoothstep( 0.0, 0.10, life ) * smoothstep( 0.62, 0.10, r );
      float ring = cos( ( r - waveR ) * 28.0 ) * env;
      grad += ( d / r ) * ring;
    }
  }
  return grad;
}
`
    : ''
}

// Trowbridge-Reitz GGX normal distribution with safe minimum roughness floor.
float ggxD( float NdotH, float alpha ) {
  float a = max( alpha, 0.035 );
  float a2 = a * a;
  float denom = NdotH * NdotH * ( a2 - 1.0 ) + 1.0;
  return a2 / max( 1e-5, PI * denom * denom );
}

vec3 evalDualLobeGlitter( vec3 Nmacro, vec3 Nmicro, vec3 V, vec3 L, vec3 lightCol, float roughBroad, float roughMicro ) {
  float NdotL = max( dot( Nmacro, L ), 0.0 );
  if ( L.y <= -0.02 ) return vec3( 0.0 );
  vec3 H = normalize( L + V );
  float NdotH_b = max( dot( Nmacro, H ), 0.0 );
  float NdotH_m = max( dot( Nmicro, H ), 0.0 );
  float VdotH = max( dot( V, H ), 0.0 );
  float F = 0.02 + 0.98 * pow( 1.0 - VdotH, 5.0 );

  float broad = ggxD( NdotH_b, roughBroad ) * 0.042;
  // Softly capped micro-glint so sunlight shimmers warmly without triggering Bloom blowout.
  float sparkle = min( 3.2, ggxD( NdotH_m, roughMicro ) * 0.015 );
  float horizonLift = smoothstep( -0.02, 0.14, L.y );
  return lightCol * F * ( broad + sparkle ) * ( 0.35 + 0.65 * NdotL ) * horizonLift;
}

// Fast analytic fallback reflection of the physical sky dome (used on Low/Balanced or > maxReflDist).
vec3 evalSkyReflection( vec3 R ) {
  float h = clamp( R.y, 0.0, 1.0 );
  vec3 sky = mix( uSkyHorizon, uSkyZenith, pow( h, 0.56 ) );

  float sunDot = max( dot( R, normalize( uSunDir ) ), 0.0 );
  float mie = pow( sunDot, 6.0 ) * 0.42 + pow( sunDot, 28.0 ) * 0.32;
  sky += uSunsetColor * uSunsetWeight * ( pow( 1.0 - h, 2.2 ) * 0.72 + mie * 0.65 );

  vec2 cloudUv = R.xz / max( 0.16, R.y + 0.10 ) * 0.55 + uWindVec * ( uTime * 0.004 );
  float cn = wFbmSimple( cloudUv );
  float cMask = smoothstep( 0.78 - uCloudCover * 0.58, 0.96 - uCloudCover * 0.48, cn ) * smoothstep( 0.01, 0.22, h );
  vec3 cloudBase = mix( vec3( 0.08, 0.11, 0.18 ), mix( vec3( 0.92, 0.94, 0.97 ), vec3( 0.36, 0.41, 0.48 ), max( uRain, uSnow * 0.8 ) * 0.75 ), uDay );
  cloudBase += uSunsetColor * uSunsetWeight * ( 0.48 + 0.42 * pow( sunDot, 4.0 ) );
  sky = mix( sky, cloudBase, cMask * ( 0.52 + 0.36 * uCloudCover ) );

  float moonDot = max( dot( R, normalize( uMoonDir ) ), 0.0 );
  sky += vec3( 0.68, 0.79, 0.96 ) * pow( moonDot, 24.0 ) * uNight * ( 1.0 - uCloudCover * 0.75 ) * 0.30;
  return sky;
}

void main() {
  vec3 toCam = cameraPosition - vWorldPos;
  float camDist = length( toCam );
  vec3 V = toCam / max( camDist, 1e-4 );

  // ── 1. Analytic River Channel Bathymetry (stage-local Z matches embankment walls exactly) ──
  float bankDist = min( abs( vLocalPos.z - uRiverZ1 ), abs( vLocalPos.z - uRiverZ0 ) );
  float normSpan = clamp( ( vLocalPos.z - uRiverZ0 ) / max( 1.0, uRiverZ1 - uRiverZ0 ), 0.0, 1.0 );
  float depth = mix( 0.14, 4.10, smoothstep( 0.0, 6.8, bankDist ) ) * ( 0.84 + 0.16 * sin( normSpan * PI ) );

  // ── 2. Independent 2D Wave Gradients (Macro Swells + Capillary Ripples + Raindrop Rings) ──
  float windSpd = length( uWindVec );
  vec2 flowDir = vec2( 0.45, 0.04 ) + uWindVec * 0.14;
  float chopScale = 0.72 + 0.28 * clamp( windSpd * 0.32 + uRain * 0.50, 0.0, 1.35 );
  float distAtten = smoothstep( 150.0, 16.0, camDist );
  float rainRough = uRain * 0.085;
  float roughBoost = clamp( camDist * 0.0018 + rainRough, 0.0, 0.24 );

  // Layer A: 4 analytic non-orthogonal directional river swells with true (d/dx, d/dz) derivatives.
  vec2 p = vLocalPos.xz;
  vec2 gMacro = vec2( 0.0 );
  {
    vec2 d1 = vec2( 0.34,  0.14 ); float ph1 = dot( p, d1 ) - uTime * ( 1.05 + windSpd * 0.15 ); gMacro += d1 * cos( ph1 ) * 0.105;
    vec2 d2 = vec2( 0.52, -0.36 ); float ph2 = dot( p, d2 ) - uTime * 1.48 + 1.3;              gMacro += d2 * cos( ph2 ) * 0.070;
    vec2 d3 = vec2( -0.22, 0.68 ); float ph3 = dot( p, d3 ) - uTime * 1.85 + 2.7;              gMacro += d3 * cos( ph3 ) * 0.052;
    vec2 d4 = vec2( 0.84,  0.54 ); float ph4 = dot( p, d4 ) - uTime * 2.15 + 0.6;              gMacro += d4 * cos( ph4 ) * 0.036;
  }

  // Layer B: Dual counter-scrolling analytic rotated FBM gradients.
  vec3 fbmA = wWaveFbm( p * 0.44 - flowDir * ( uTime * 0.52 ), distAtten );
  vec3 fbmB = wWaveFbm( p * 0.86 + vec2( -flowDir.x * 0.30, flowDir.y * 0.46 + 0.20 ) * uTime + vec2( 7.3, 15.1 ), distAtten );
  vec2 gCapillary = ( fbmA.yz * 0.55 + fbmB.yz * 0.45 ) * ( 0.17 * chopScale * ( 0.28 + 0.72 * distAtten ) );

  // Optional Layer C: Poly Haven tileable detail normal map if bound (strictly uniform branch — zero X3595!).
  if ( uHasDetailNormal > 0.5 ) {
    vec2 uvA = p * 0.24 - flowDir * ( uTime * 0.07 );
    vec2 uvB = p * 0.42 + vec2( -flowDir.y, flowDir.x ) * ( uTime * 0.05 ) + vec2( 0.37, 0.61 );
    vec2 nTex = ( texture2D( uDetailNormal, uvA ).xy * 2.0 - 1.0 ) * 0.55
              + ( texture2D( uDetailNormal, uvB ).xy * 2.0 - 1.0 ) * 0.45;
    gCapillary += nTex * ( 0.12 * distAtten );
  }

  // Layer D: Band-limited staggered Voronoi-jittered concentric raindrop ripple rings.
  vec2 gRain = vec2( 0.0 );
  ${
    rainLayers > 0
      ? /* glsl */ `
  if ( uRain > 0.02 ) {
    float rainFade = smoothstep( 52.0, 10.0, camDist );
    if ( rainFade > 0.005 ) {
      gRain += wRainRippleLayer( p, 0.78, uTime, 11.3 ) * 0.54;
      ${rainLayers >= 2 ? 'gRain += wRainRippleLayer( p, 1.24, uTime * 1.08, 47.9 ) * 0.32;' : ''}
      ${rainLayers >= 3 ? 'gRain += wRainRippleLayer( p, 1.78, uTime * 0.94, 93.1 ) * 0.18;' : ''}
      gRain *= ( 0.19 * uRain * rainFade );
    }
  }
  `
      : ''
  }

  vec2 totalMacro = gMacro * 0.60 + gCapillary * 0.52 + gRain * 0.72;
  vec2 totalMicro = gMacro * 0.48 + gCapillary * 1.10 + gRain * 0.88;
  vec3 N_macro = normalize( vec3( -totalMacro.x, 1.0, -totalMacro.y ) );
  vec3 N_micro = normalize( vec3( -totalMicro.x, 1.0, -totalMicro.y ) );

  // Kaplanyan/Toksvig screen-space specular anti-aliasing: widens GGX roughness automatically wherever
  // sub-pixel wave/rain gradients vary rapidly across a pixel — eliminates Night Heavy Rain zebra noise!
  vec3 dNdx = dFdx( N_micro );
  vec3 dNdy = dFdy( N_micro );
  float normalVariance = clamp( dot( dNdx, dNdx ) + dot( dNdy, dNdy ), 0.0, 0.48 );
  float specAA = sqrt( normalVariance * 0.55 );

  // ── 3. Rich Beer-Lambert Emerald-Teal Depth Absorption & Sunlit Bank Caustics ──
  float overcast = max( uRain, uSnow * 0.85 );
  vec3 shallowTint = mix( vec3( 0.028, 0.072, 0.088 ), vec3( 0.145, 0.365, 0.315 ), uDay );
  vec3 midTint     = mix( vec3( 0.014, 0.042, 0.068 ), vec3( 0.048, 0.215, 0.245 ), uDay );
  vec3 deepTint    = mix( vec3( 0.008, 0.018, 0.042 ), vec3( 0.018, 0.092, 0.158 ), uDay );
  vec3 tintMuted   = vec3( dot( shallowTint, vec3( 0.333 ) ) ) * vec3( 0.82, 0.92, 0.98 );
  shallowTint = mix( shallowTint, tintMuted, overcast * 0.42 );
  vec3 absorb = exp( -depth * vec3( 0.62, 0.24, 0.15 ) );
  vec3 bodyCol = mix( deepTint, midTint, clamp( absorb.b * 1.15, 0.0, 1.0 ) );
  bodyCol = mix( bodyCol, shallowTint, clamp( absorb.r * 1.25, 0.0, 1.0 ) );

  // Subtle sunlit shallow riverbed caustics within 4.2 m of the embankments.
  float causticMask = smoothstep( 4.2, 0.16, bankDist ) * uDay * ( 1.0 - overcast * 0.78 ) * distAtten;
  if ( causticMask > 0.005 ) {
    float c1 = wFbmSimple( p * 1.45 + vec2( uTime * 0.32, uTime * 0.14 ) );
    float c2 = wFbmSimple( p * 1.95 - vec2( uTime * 0.24, -uTime * 0.28 ) );
    float caustic = pow( clamp( 1.0 - abs( c1 - c2 ) * 3.2, 0.0, 1.0 ), 4.0 );
    bodyCol += uSunColor * caustic * causticMask * 0.24;
  }

  // ── 4. Physical Schlick Fresnel + Real-Time 0.5x Planar Reflection & Analytic Fallback ──
  float NdotV = max( dot( N_macro, V ), 0.0 );
  float fresnel = 0.02 + 0.98 * pow( 1.0 - NdotV, 5.0 );

  vec3 R = reflect( -V, N_macro );
  R.y = abs( R.y ) + 0.015;
  vec3 analyticRefl = evalSkyReflection( R );

  // Softly filtered procedural skyline shimmer fallback (only when planar reflector is inactive).
  if ( uReflectMix < 0.95 && uNight > 0.04 ) {
    float skylineMask = smoothstep( 0.008, 0.048, R.y ) * smoothstep( 0.24, 0.06, R.y ) * smoothstep( 0.05, -0.35, R.z );
    if ( skylineMask > 0.004 ) {
      float tx = ( p.x + N_macro.x * 8.0 ) * 0.085;
      float towerBand = smoothstep( 0.25, 0.55, wNoiseDeriv( vec2( tx, 3.0 ) ).x );
      float winWave = 0.5 + 0.5 * sin( ( p.x + N_macro.x * 10.0 ) * 0.95 ) * sin( ( R.y + N_macro.z * 0.08 ) * 55.0 );
      float lit = smoothstep( 0.62, 0.92, winWave ) * towerBand;
      vec3 wTint = mix( vec3( 1.0, 0.74, 0.42 ), vec3( 0.66, 0.82, 1.0 ), wNoiseDeriv( vec2( p.x * 0.18, 7.0 ) ).x );
      analyticRefl += wTint * lit * skylineMask * uNight * ( 1.0 - uReflectMix ) * 0.68;
    }
  }

  vec3 reflCol = analyticRefl;
  if ( uReflectMix > 0.005 ) {
    vec2 projUv = vReflectUv.xy / max( 0.0001, vReflectUv.w );
    // Physically scaled wave normal distortion (attenuated gently near screen edges & far distance).
    float edgeSafe = smoothstep( 0.0, 0.06, projUv.x ) * smoothstep( 1.0, 0.94, projUv.x )
                   * smoothstep( 0.0, 0.06, projUv.y ) * smoothstep( 1.0, 0.94, projUv.y );
    float distScale = mix( 0.042, 0.016, clamp( camDist / 90.0, 0.0, 1.0 ) );
    vec2 distort = vec2( totalMacro.x, totalMacro.y * 0.65 ) * distScale * ( 0.35 + 0.65 * edgeSafe );
    vec2 sampleUv = clamp( projUv + distort, vec2( 0.002 ), vec2( 0.998 ) );
    vec3 planarSample = texture2D( uReflectMap, sampleUv ).rgb;
    // Soft-knee compress extreme HDR spikes in reflection so water remains luminous without Bloom haloing.
    planarSample = planarSample / ( 1.0 + max( planarSample - vec3( 1.65 ), vec3( 0.0 ) ) * 0.42 );
    // Slight reflection attenuation in heavy rainstorm chop so deep river body peeks through naturally.
    float reflClarity = mix( 0.96, 0.78, uRain * 0.75 ) * uReflectMix;
    reflCol = mix( analyticRefl, planarSample, reflClarity );
  }

  // Pooled riverside promenade streetlamp golden reflections (specular-AA filtered for silky night rain ribbons!).
  vec3 lampSpec = vec3( 0.0 );
  if ( uNight > 0.06 && uLampCount > 0 ) {
    float lampRoughB = sqrt( pow( 0.15 + roughBoost * 0.65, 2.0 ) + specAA * specAA * 0.45 );
    float lampRoughM = sqrt( pow( 0.085 + roughBoost * 0.55, 2.0 ) + specAA * specAA * 0.85 );
    for ( int i = 0; i < ${MAX_WATER_LAMPS}; i++ ) {
      if ( i >= uLampCount ) break;
      vec3 toLamp = uLampPos[i] - vLocalPos;
      float d2 = dot( toLamp, toLamp );
      if ( d2 > 960.0 ) continue;
      vec3 L = toLamp * inversesqrt( d2 + 1e-4 );
      vec3 H = normalize( L + V );
      float atten = 1.0 / ( 1.0 + d2 * 0.028 );
      float specB = ggxD( max( dot( N_macro, H ), 0.0 ), lampRoughB );
      float specM = min( 14.0, ggxD( max( dot( N_micro, H ), 0.0 ), lampRoughM ) );
      lampSpec += vec3( 1.0, 0.76, 0.44 ) * ( specB * 0.14 + specM * 0.026 ) * atten * uNight;
    }
    lampSpec = min( lampSpec, vec3( 1.25 ) );
  }

  // ── 5. Specular-AA Dual-Lobe GGX Sun & Moon Glitter ──
  float sunRoughB = sqrt( pow( 0.10 + roughBoost, 2.0 ) + specAA * specAA * 0.40 );
  float sunRoughM = sqrt( pow( 0.042 + roughBoost * 0.55, 2.0 ) + specAA * specAA * 0.90 );
  vec3 sunGlitter = evalDualLobeGlitter(
    N_macro, N_micro, V, normalize( uSunDir ), uSunColor,
    sunRoughB, sunRoughM
  ) * uSunVis;

  vec3 moonGlitter = evalDualLobeGlitter(
    N_macro, N_micro, V, normalize( uMoonDir ), vec3( 0.72, 0.84, 1.0 ),
    sunRoughB + 0.03, sunRoughM + 0.02
  ) * uNight * ( 1.0 - uCloudCover * 0.82 ) * 0.36;

  // Soft Fresnel-gated raindrop crest micro-sheen (zero harsh white static noise at night!).
  float rainSheen = min( 0.16, length( gRain ) * ( 0.08 + 0.22 * uDay ) * uRain * ( 0.25 + 0.75 * fresnel ) );

  vec3 waterCol = mix( bodyCol, reflCol, clamp( fresnel * 0.94, 0.06, 0.96 ) )
                + sunGlitter + moonGlitter + lampSpec
                + mix( vec3( 0.28, 0.36, 0.50 ), vec3( 0.82, 0.88, 0.94 ), uDay ) * rainSheen;

  // ── 6. Animated Lapping Shoreline Foam along Both Riverbanks ──
  float lap = sin( p.x * 0.42 + uTime * 1.35 ) * 0.18 + sin( p.x * 1.08 - uTime * 2.05 ) * 0.09;
  float foamZone = smoothstep( 0.98 + lap, 0.03, bankDist );
  if ( foamZone > 0.005 ) {
    float foamN = wFbmSimple( p * 2.4 + vec2( uTime * 0.22, -uTime * 0.14 ) );
    float bubble = wFbmSimple( p * 6.4 - vec2( uTime * 0.18, uTime * 0.26 ) );
    float foamMask = smoothstep( 0.26, 0.66, foamZone * ( 0.48 + 0.72 * foamN + 0.24 * bubble ) );
    foamMask = max( foamMask, smoothstep( 0.18 + lap * 0.25, 0.0, bankDist ) * ( 0.58 + 0.42 * foamN ) );
    vec3 foamLit = mix( vec3( 0.14, 0.20, 0.28 ), vec3( 0.90, 0.94, 0.96 ), uDay )
                 * mix( vec3( 1.0 ), uSunColor, 0.28 * uDay + 0.35 * uSunsetWeight );
    waterCol = mix( waterCol, foamLit, clamp( foamMask * 0.84, 0.0, 0.88 ) );
  }

  // ── 7. Analytical Exponential Height Fog + Henyey-Greenstein Sun Scatter ──
  vec3 rayDir = -V;
  float hfCamH = max( 0.0, cameraPosition.y - uFogBaseY );
  float hfDy = ( vWorldPos.y - cameraPosition.y ) * uFogFalloff;
  float hfInt = abs( hfDy ) < 0.001 ? ( 1.0 - 0.5 * hfDy ) : ( ( 1.0 - exp( -hfDy ) ) / hfDy );
  float hfTau = uFogDensity * exp( -uFogFalloff * hfCamH ) * camDist * clamp( hfInt, 0.0, 4.0 );
  float fogFactor = clamp( 1.0 - exp( -hfTau ), 0.0, 0.95 );
  float hgCos = dot( rayDir, normalize( uSunDir ) );
  float hgG = 0.76;
  float hgPhase = ( 1.0 - hgG * hgG ) / max( 0.05, pow( 1.0 + hgG * hgG - 2.0 * hgG * hgCos, 1.5 ) );
  float hgMie = clamp( hgPhase * 0.13 * uFogMieStrength * ( 0.25 + 0.75 * uDay ), 0.0, 0.75 );
  vec3 scatterCol = mix( uFogColor, mix( uSunColor, uSunsetColor, uSunsetWeight * 0.65 ), hgMie * smoothstep( 16.0, 120.0, camDist ) );
  waterCol = mix( waterCol, scatterCol, fogFactor );

  gl_FragColor = vec4( waterCol, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
}

// ── Procedural Riverbank Reed/Cattail Tuft Geometry (1 Draw Call InstancedMesh) ────────────────────────────────

function hashDet(n: number): number {
  let t = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  t ^= t >>> 15;
  t = Math.imul(t, 0x2c1b3c6d) >>> 0;
  t ^= t >>> 12;
  return (t >>> 0) / 4294967296;
}

function buildReedTuftGeometry(): T.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let vOff = 0;

  const blades = 6;
  for (let b = 0; b < blades; b++) {
    const yaw = (b / blades) * Math.PI * 2 + (hashDet(b * 17 + 3) - 0.5) * 0.42;
    const h = 0.65 + hashDet(b * 31 + 7) * 0.52;
    const lean = 0.10 + hashDet(b * 43 + 11) * 0.16;
    const halfW = 0.022 + hashDet(b * 53 + 13) * 0.012;
    const offR = 0.03 + hashDet(b * 61 + 19) * 0.08;
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const rx = -sinY, rz = cosY;

    const segs = 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const w = halfW * (1 - t * 0.88);
      const cx = cosY * (offR + t * t * lean);
      const cz = sinY * (offR + t * t * lean);
      const cy = t * h;
      const rCol = 0.24 + t * 0.24;
      const gCol = 0.34 + t * 0.30;
      const bCol = 0.16 + t * 0.10;

      for (const side of [-1, 1]) {
        positions.push(cx + rx * w * side, cy, cz + rz * w * side);
        normals.push(cosY, 0.35, sinY);
        uvs.push(side < 0 ? 0 : 1, t);
        colors.push(rCol, gCol, bCol);
      }
      if (s < segs) {
        const i0 = vOff + s * 2;
        indices.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2);
      }
    }
    vOff += (segs + 1) * 2;
  }

  const stalkH = 1.05;
  for (let p = 0; p < 2; p++) {
    const a = p * (Math.PI / 2);
    const dx = Math.cos(a) * 0.024, dz = Math.sin(a) * 0.024;
    const y0 = stalkH * 0.72, y1 = stalkH * 0.94;
    const base = vOff;
    positions.push(-dx, y0, -dz, dx, y0, dz, dx, y1, dz, -dx, y1, -dz);
    normals.push(0, 0.4, 1, 0, 0.4, 1, 0, 0.4, 1, 0, 0.4, 1);
    uvs.push(0, 0.82, 1, 0.82, 1, 0.98, 0, 0.98);
    for (let k = 0; k < 4; k++) colors.push(0.36, 0.22, 0.13);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    vOff += 4;
  }

  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

const TIER_WATER_SEGMENTS: Record<WeatherRenderTier, readonly [number, number]> = {
  ultra: [96, 32],
  high: [64, 24],
  balanced: [32, 12],
  low: [1, 1],
};

const TIER_REED_COUNT: Record<WeatherRenderTier, number> = {
  ultra: 220,
  high: 140,
  balanced: 60,
  low: 0,
};

// Shared zero-allocation scratch objects for planar reflector oblique clip-plane math.
const _reflPlane = new T.Plane();
const _reflNormal = new T.Vector3();
const _reflWorldPos = new T.Vector3();
const _camWorldPos = new T.Vector3();
const _camLocalPos = new T.Vector3();
const _rotMat = new T.Matrix4();
const _lookAtPos = new T.Vector3();
const _clipPlane = new T.Vector4();
const _viewVec = new T.Vector3();
const _targetVec = new T.Vector3();
const _qVec = new T.Vector4();
const _drawSize = new T.Vector2();
const _camForward = new T.Vector3();
const _camRight = new T.Vector3();
const _camUp = new T.Vector3();
const _camLocalDir = new T.Vector3();
const _camLocalRight = new T.Vector3();
const _camLocalUp = new T.Vector3();
const _tmpWorldPt = new T.Vector3();
const _prevViewport = new T.Vector4();
const _prevScissor = new T.Vector4();
const _prevRtScissor = new T.Vector4();
const _warmupCamPos = new T.Vector3();
const _warmupLookAt = new T.Vector3();

const REFLECTION_HIDE_CITY_CHILDREN = new Set([
  'echo-life-weather-particles',
  'city-south',
  'city-sides',
  'city-ground',
  'city-base-ground',
  'city-south-fringe-ground',
  'city-road-continuations',
  'city-horizon-skirt',
]);

const REFLECTION_HIDE_WORLD_CHILDREN = new Set([
  'echo-life-grass-field',
  'echo-life-house',
  'sunrise-market-stock',
  'echo-life-parked-curb-cars',
  'echo-life-tire-particles',
  'echo-life-shared-court',
]);

const REFLECTION_HIDE_STREAM_CHILDREN = new Set([
  'stream-south',
  'stream-sides',
]);

const REFLECTION_HIDE_STAGE_CHILDREN = new Set([
  'echo-life-people',
  'echo-life-shared-city',
  'echo-life-bicycle',
  'echo-life-room-bicycle',
]);

let globalRenderingReflection = false;

export class WaterSurface {
  readonly group = new T.Group();
  readonly waterMesh: T.Mesh;
  readonly reedMesh: T.InstancedMesh | null = null;

  private readonly river: WaterRiverRect;
  private readonly waterY: number;
  private tierValue: WeatherRenderTier;
  private readonly waterGeo: T.PlaneGeometry;
  private readonly waterMat: T.ShaderMaterial;
  private readonly dummyNormalTex: T.DataTexture;
  private readonly dummyReflectTex: T.DataTexture;
  private readonly lampUniforms: T.Vector3[];
  private readonly reedGeo: T.BufferGeometry | null = null;
  private readonly reedMat: T.MeshStandardMaterial | null = null;

  // Distance-gated 0.5x HalfFloatType planar reflection state (High/Ultra only).
  private readonly textureMatrix = new T.Matrix4();
  private readonly reflectionCamera = new T.PerspectiveCamera();
  private reflectionRt: T.WebGLRenderTarget | null = null;
  private reflectionW = 0;
  private reflectionH = 0;
  private reflectionFrame = 0;
  private lastFrameReflected = false;
  private lastSkippedReason: string | null = 'init';
  private explicitInsideBuilding: boolean | null = null;
  private atmosphereIndoors = false;
  private reflectionPreparedThisFrame = false;
  private preparedRenderFrame = -1;
  private readonly lastReflCamPos = new T.Vector3(Infinity, 0, Infinity);
  private readonly lastReflCamDir = new T.Vector3(0, 0, -1);
  private readonly hiddenInReflection: T.Object3D[] = [];
  private disposed = false;

  constructor(opts: WaterSurfaceOptions) {
    this.group.name = 'echo-life-river-water';
    const { river, waterY, tier, weather } = opts;
    this.river = { ...river };
    this.waterY = waterY;
    this.tierValue = tier;

    const width = river.x1 - river.x0;
    const depth = river.z1 - river.z0;
    const cx = (river.x0 + river.x1) / 2;
    const cz = (river.z0 + river.z1) / 2;

    this.dummyNormalTex = new T.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, T.RGBAFormat);
    this.dummyNormalTex.needsUpdate = true;

    this.dummyReflectTex = new T.DataTexture(new Uint8Array([36, 56, 84, 255]), 1, 1, T.RGBAFormat);
    this.dummyReflectTex.needsUpdate = true;

    this.lampUniforms = Array.from({ length: MAX_WATER_LAMPS }, () => new T.Vector3());

    const [segX, segZ] = TIER_WATER_SEGMENTS[tier];
    this.waterGeo = new T.PlaneGeometry(width, depth, segX, segZ);
    this.waterGeo.rotateX(-Math.PI / 2);

    this.waterMat = new T.ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: buildWaterFrag(tier),
      toneMapped: true,
      uniforms: {
        uTime: weather.uTime,
        uRain: weather.uRainIntensity,
        uSnow: weather.uSnowCover,
        uWindVec: weather.uWindVec,
        uDay: { value: 1 },
        uNight: { value: 0 },
        uCloudCover: { value: 0.15 },
        uSunVis: { value: 1 },
        uSunsetWeight: { value: 0 },
        uSunDir: { value: new T.Vector3(0.35, 0.65, -0.65).normalize() },
        uMoonDir: { value: new T.Vector3(-0.35, 0.55, -0.65).normalize() },
        uSunColor: { value: new T.Color('#fff5e4') },
        uSkyZenith: { value: new T.Color('#2d64b8') },
        uSkyHorizon: { value: new T.Color('#b8d6f2') },
        uSunsetColor: { value: new T.Color('#ff8444') },
        uFogColor: { value: new T.Color('#bdd5eb') },
        uFogDensity: { value: 0.0012 },
        uFogFalloff: { value: 0.032 },
        uFogBaseY: { value: waterY },
        uFogMieStrength: { value: 0.42 },
        uCam: { value: new T.Vector3() },
        uRiverZ0: { value: river.z0 },
        uRiverZ1: { value: river.z1 },
        uRiverCenter: { value: new T.Vector2(cx, cz) },
        uWaterY: { value: waterY },
        uSwellAmp: { value: tier === 'low' ? 0 : tier === 'balanced' ? 0.016 : 0.024 },
        uLampPos: { value: this.lampUniforms },
        uLampCount: { value: 0 },
        uDetailNormal: { value: opts.normalMap ?? this.dummyNormalTex },
        uHasDetailNormal: { value: opts.normalMap ? 1 : 0 },
        uTextureMatrix: { value: this.textureMatrix },
        uReflectMap: { value: this.dummyReflectTex },
        uReflectMix: { value: 0 },
      },
    });
    this.waterMat.customProgramCacheKey = () => `echo-river-water-v2:${tier}`;

    this.waterMesh = new T.Mesh(this.waterGeo, this.waterMat);
    this.waterMesh.name = 'echo-life-water-surface';
    this.waterMesh.position.set(cx, waterY, cz);
    this.waterMesh.receiveShadow = false;
    this.waterMesh.onBeforeRender = (renderer, scene, camera) => {
      // Skip if `prepareReflection()` already ran at renderCallDepth === 0 this frame (zero lightsStateVersion ping-pong!).
      if (this.reflectionPreparedThisFrame && this.preparedRenderFrame === renderer.info.render.frame) {
        return;
      }
      this.renderPlanarReflection(renderer, scene, camera);
    };
    this.group.add(this.waterMesh);

    // ── Single-Draw-Call Wind-Swaying Shoreline Reeds (Ultra / High / Balanced) ──
    const reedCount = TIER_REED_COUNT[tier];
    if (reedCount > 0) {
      this.reedGeo = buildReedTuftGeometry();
      this.reedMat = new T.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.78,
        metalness: 0,
        side: T.DoubleSide,
      });
      chainMaterialShader(this.reedMat, 'echo-river-reeds-v1', (shader) => {
        shader.uniforms.uReedTime = weather.uTime;
        shader.uniforms.uReedWind = weather.uWindVec;
        shader.uniforms.uReedSeason = weather.uSeason;
        shader.uniforms.uReedSnow = weather.uSnowCover;

        shader.vertexShader =
          /* glsl */ `
uniform float uReedTime;
uniform vec2 uReedWind;
varying float vReedTip;
` +
          shader.vertexShader.replace(
            '#include <begin_vertex>',
            /* glsl */ `#include <begin_vertex>
  vReedTip = uv.y;
  #ifdef USE_INSTANCING
    vec3 reedInstOrigin = vec3( instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2] );
  #else
    vec3 reedInstOrigin = vec3( 0.0 );
  #endif
  float phase = reedInstOrigin.x * 0.43 + reedInstOrigin.z * 0.61;
  float bend = uv.y * uv.y;
  float gust = sin( uReedTime * 1.9 + phase ) * 0.65 + sin( uReedTime * 3.4 + phase * 1.7 ) * 0.35;
  transformed.x += ( uReedWind.x * 0.045 + gust * 0.055 ) * bend;
  transformed.z += ( uReedWind.y * 0.045 + cos( uReedTime * 1.6 + phase ) * 0.035 ) * bend;
`,
          );

        shader.fragmentShader =
          /* glsl */ `
uniform float uReedSeason;
uniform float uReedSnow;
varying float vReedTip;
` +
          shader.fragmentShader.replace(
            '#include <color_fragment>',
            /* glsl */ `#include <color_fragment>
  vec3 springT = vec3( 1.05, 1.12, 0.92 );
  vec3 summerT = vec3( 0.88, 1.04, 0.86 );
  vec3 autumnT = vec3( 1.38, 1.02, 0.56 );
  vec3 winterT = vec3( 0.92, 0.90, 0.84 );
  vec3 sTint = uReedSeason < 0.5 ? springT : uReedSeason < 1.5 ? summerT : uReedSeason < 2.5 ? autumnT : winterT;
  diffuseColor.rgb *= sTint;
  if ( uReedSnow > 0.05 ) {
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.90, 0.93, 0.97 ), smoothstep( 0.42, 0.96, vReedTip ) * uReedSnow * 0.78 );
  }
`,
          );
      });
      // Attach Height Fog + 3-cascade CSM at creation time (canonical order: domain -> fog -> CSM).
      patchHeightFog(this.reedMat, getSharedHeightFogUniforms());
      patchMaterialWithEchoCsm(this.reedMat);

      const reeds = new T.InstancedMesh(this.reedGeo, this.reedMat, reedCount);
      reeds.name = 'echo-life-river-reeds';
      reeds.castShadow = false;
      reeds.receiveShadow = true;
      reeds.raycast = () => undefined;

      const spanX0 = river.x0 + 165;
      const spanX1 = river.x1 - 165;
      const m4 = new T.Matrix4();
      const pos = new T.Vector3();
      const quat = new T.Quaternion();
      const scl = new T.Vector3();
      const upAxis = new T.Vector3(0, 1, 0);

      for (let i = 0; i < reedCount; i++) {
        const h1 = hashDet(i * 19 + 5);
        const h2 = hashDet(i * 37 + 11);
        const h3 = hashDet(i * 59 + 17);
        const h4 = hashDet(i * 73 + 23);

        const farBank = h1 < 0.72;
        const clusterBase = spanX0 + hashDet(Math.floor(i / 4) * 97 + 29) * (spanX1 - spanX0);
        const x = clusterBase + (h2 - 0.5) * 4.8;
        const z = farBank ? river.z0 + 0.45 + h3 * 1.05 : river.z1 - 0.58 - h3 * 0.35;
        const scaleXZ = 0.78 + h4 * 0.72;
        const scaleY = (farBank ? 0.92 : 0.64) + h3 * 0.52;

        pos.set(x, waterY - 0.10, z);
        quat.setFromAxisAngle(upAxis, h2 * Math.PI * 2);
        scl.set(scaleXZ, scaleY, scaleXZ);
        reeds.setMatrixAt(i, m4.compose(pos, quat, scl));
      }
      reeds.instanceMatrix.needsUpdate = true;
      reeds.computeBoundingSphere();
      this.reedMesh = reeds;
      this.group.add(reeds);
    }
  }

  get diagnostics(): WaterSurfaceDiagnostics {
    const wCfg = RENDER_CONFIGS[this.tierValue].water;
    return {
      tier: this.tierValue,
      planarReflectionEnabled: wCfg.planarReflection,
      lastFrameReflected: this.lastFrameReflected,
      reflectionWidth: this.reflectionW,
      reflectionHeight: this.reflectionH,
      reflectionCadence: wCfg.reflectionCadence,
      reflectionMaxDist: wCfg.reflectionMaxDist,
      skippedReason: this.lastSkippedReason,
    };
  }

  /** Live quality tier switching — allocates/frees 0.5x planar reflection RT & swaps low-tier fast water shader. */
  setQuality(tier: WeatherRenderTier): void {
    if (this.disposed || tier === this.tierValue) return;
    const prevLow = this.tierValue === 'low';
    const nextLow = tier === 'low';
    this.tierValue = tier;
    this.waterMat.uniforms.uSwellAmp.value = nextLow ? 0 : tier === 'balanced' ? 0.016 : 0.024;
    if (prevLow !== nextLow) {
      this.waterMat.fragmentShader = buildWaterFrag(tier);
      this.waterMat.customProgramCacheKey = () => `echo-river-water-v2:${tier}`;
      this.waterMat.needsUpdate = true;
    }
    if (tier !== 'high' && tier !== 'ultra') {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.waterMat.uniforms.uReflectMap.value = this.dummyReflectTex;
      this.reflectionRt?.dispose();
      this.reflectionRt = null;
      this.reflectionW = 0;
      this.reflectionH = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'tier-disabled';
    }
  }

  /** Explicitly notifies water whether the camera/player is indoors (skips planar reflection completely). */
  setInsideBuilding(insideBuilding: boolean): void {
    this.explicitInsideBuilding = insideBuilding;
    if (insideBuilding) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'inside-building';
    }
  }

  /** Attaches or clears an optional tileable water detail normal map at runtime. */
  setNormalMap(tex: T.Texture | null): void {
    this.waterMat.uniforms.uDetailNormal.value = tex ?? this.dummyNormalTex;
    this.waterMat.uniforms.uHasDetailNormal.value = tex ? 1 : 0;
  }

  /** Synchronizes sky, sun, moon, sunset, height fog, and nearest streetlamp reflections from `AtmosphereSystem`. */
  setAtmosphere(state: WaterAtmosphereState): void {
    const u = this.waterMat.uniforms;
    u.uDay.value = state.day;
    u.uNight.value = state.night;
    u.uCloudCover.value = state.cloudCover;
    u.uSunVis.value = state.sunVisibility;
    u.uSunsetWeight.value = state.sunsetWeight;
    u.uSunDir.value.copy(state.sunDir).normalize();
    u.uMoonDir.value.copy(state.moonDir).normalize();
    u.uSunColor.value.copy(state.sunColor);
    u.uSkyZenith.value.copy(state.skyZenith);
    u.uSkyHorizon.value.copy(state.skyHorizon);
    u.uSunsetColor.value.copy(state.sunsetColor);
    u.uFogColor.value.copy(state.fogColor);
    u.uFogDensity.value = state.fogDensity;
    if (state.fogHeightFalloff !== undefined) u.uFogFalloff.value = state.fogHeightFalloff;
    if (state.fogBaseY !== undefined) u.uFogBaseY.value = state.fogBaseY;
    if (state.fogMieStrength !== undefined) u.uFogMieStrength.value = state.fogMieStrength;
    if (state.indoors !== undefined) this.atmosphereIndoors = state.indoors;

    const lamps = state.lampPositions;
    const count = lamps ? Math.min(MAX_WATER_LAMPS, lamps.length) : 0;
    u.uLampCount.value = count;
    for (let i = 0; i < count; i++) {
      this.lampUniforms[i].copy(lamps![i]);
    }
  }

  /**
   * Per-frame update. Pass optional `insideBuilding` boolean to immediately gate off planar river
   * reflections indoors (e.g. Library, Cafe, Market, Home).
   */
  update(_dt: number, cameraLocalPos: T.Vector3, _reduced: boolean, insideBuilding?: boolean): void {
    this.waterMat.uniforms.uCam.value.copy(cameraLocalPos);
    this.reflectionPreparedThisFrame = false;
    if (insideBuilding !== undefined) {
      this.explicitInsideBuilding = insideBuilding;
    }
    if (this.explicitInsideBuilding ?? this.atmosphereIndoors) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'inside-building';
    }
  }

  /**
   * Renders the distance- & facing-gated 0.5x planar river reflection BEFORE the main pass (`renderCallDepth === 0`).
   * Calling this from `engine.ts` right before `postFx.render()` shares Three.js `renderStateArray[0]` and its exact
   * `lights.state.version` with the main pass, eliminating 100% of `getParameters`/`getProgram` CPU ping-pong!
   * Pass `canRenderReflection = echoCsm.hasAllActiveShadowMaps()` (optional) to cleanly skip 1 boot frame until
   * all active shadow maps are allocated (zero boot `GL_INVALID_OPERATION`).
   * Backwards-compatible: if not called externally, `waterMesh.onBeforeRender` falls back automatically.
   */
  prepareReflection(
    renderer: T.WebGLRenderer,
    scene: T.Scene,
    camera: T.Camera,
    canRenderReflection = true,
  ): boolean {
    this.reflectionPreparedThisFrame = true;
    this.preparedRenderFrame = renderer.info.render.frame;
    if (!canRenderReflection) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'csm-not-ready';
      return false;
    }
    if (!this.group.visible || !this.waterMesh.visible) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'water-hidden';
      return false;
    }
    return this.renderPlanarReflection(renderer, scene, camera);
  }

  /**
   * Exact frustum-corner test verifying whether any view ray can intersect the river band `[river.z0, river.z1]`.
   * Guarantees zero planar reflection work when the camera stands south of the river facing south!
   */
  private isCameraLookingTowardRiver(camera: T.PerspectiveCamera): boolean {
    camera.getWorldDirection(_camForward).normalize();
    _camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    _camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

    // Convert basis directions cleanly into group-local space (accounts for stage rotation/scale if any).
    _tmpWorldPt.copy(_camWorldPos).add(_camForward);
    this.group.worldToLocal(_tmpWorldPt);
    _camLocalDir.subVectors(_tmpWorldPt, _camLocalPos).normalize();

    _tmpWorldPt.copy(_camWorldPos).add(_camRight);
    this.group.worldToLocal(_tmpWorldPt);
    _camLocalRight.subVectors(_tmpWorldPt, _camLocalPos).normalize();

    _tmpWorldPt.copy(_camWorldPos).add(_camUp);
    this.group.worldToLocal(_tmpWorldPt);
    _camLocalUp.subVectors(_tmpWorldPt, _camLocalPos).normalize();

    const tanV = Math.tan(T.MathUtils.degToRad(camera.fov * 0.5));
    const tanH = tanV * Math.max(0.5, camera.aspect);

    // Camera south of river (`z > river.z1`): river lies toward -Z.
    if (_camLocalPos.z > this.river.z1) {
      const dzSouth = _camLocalPos.z - this.river.z1;
      if (dzSouth > 4.0 && _camLocalDir.z > 0.28) return false;
      const z0 = _camLocalDir.z + _camLocalRight.z * tanH + _camLocalUp.z * tanV;
      const z1 = _camLocalDir.z - _camLocalRight.z * tanH + _camLocalUp.z * tanV;
      const z2 = _camLocalDir.z + _camLocalRight.z * tanH - _camLocalUp.z * tanV;
      const z3 = _camLocalDir.z - _camLocalRight.z * tanH - _camLocalUp.z * tanV;
      const minCornerZ = Math.min(z0, z1, z2, z3);
      return minCornerZ < -0.01;
    }

    // Camera north of river (`z < river.z0`): river lies toward +Z.
    if (_camLocalPos.z < this.river.z0) {
      const dzNorth = this.river.z0 - _camLocalPos.z;
      if (dzNorth > 4.0 && _camLocalDir.z < -0.28) return false;
      const z0 = _camLocalDir.z + _camLocalRight.z * tanH + _camLocalUp.z * tanV;
      const z1 = _camLocalDir.z - _camLocalRight.z * tanH + _camLocalUp.z * tanV;
      const z2 = _camLocalDir.z + _camLocalRight.z * tanH - _camLocalUp.z * tanV;
      const z3 = _camLocalDir.z - _camLocalRight.z * tanH - _camLocalUp.z * tanV;
      const maxCornerZ = Math.max(z0, z1, z2, z3);
      return maxCornerZ > 0.01;
    }

    // Camera directly over river channel -> always visible.
    return true;
  }

  /** True when real-time planar river reflection is active on the current quality tier (`high` / `ultra`). */
  isPlanarReflectionEnabled(): boolean {
    if (this.disposed) return false;
    const wCfg = RENDER_CONFIGS[this.tierValue].water;
    return Boolean(wCfg.planarReflection) && (this.tierValue === 'high' || this.tierValue === 'ultra');
  }

  private ensureReflectionRt(renderer: T.WebGLRenderer): T.WebGLRenderTarget {
    const wCfg = RENDER_CONFIGS[this.tierValue].water;
    renderer.getDrawingBufferSize(_drawSize);
    const scale = wCfg.reflectionScale > 0 ? wCfg.reflectionScale : 0.5;
    const targetW = Math.min(1280, Math.max(256, Math.round(_drawSize.x * scale)));
    const targetH = Math.min(720, Math.max(144, Math.round(_drawSize.y * scale)));
    if (!this.reflectionRt || this.reflectionW !== targetW || this.reflectionH !== targetH) {
      this.reflectionRt?.dispose();
      this.reflectionRt = new T.WebGLRenderTarget(targetW, targetH, {
        minFilter: T.LinearFilter,
        magFilter: T.LinearFilter,
        format: T.RGBAFormat,
        type: T.HalfFloatType,
        colorSpace: T.LinearSRGBColorSpace,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      this.reflectionRt.texture.name = 'echo-life-water-reflection';
      this.reflectionW = targetW;
      this.reflectionH = targetH;
      this.waterMat.uniforms.uReflectMap.value = this.reflectionRt.texture;
      this.lastFrameReflected = false;
    }
    return this.reflectionRt;
  }

  private hideNonReflectingSubtrees(scene: T.Scene): void {
    // Aggressively hide non-reflecting & expensive subtrees (all zero-light visual groups -> zero lightsStateVersion drift!):
    // skinned NPCs (`echo-life-people`), `city-ground`, `city-south`, `stream-south`, `echo-life-house`, grass, weather.
    const hidden = this.hiddenInReflection;
    hidden.length = 0;
    const hideNode = (obj: T.Object3D | null | undefined) => {
      if (obj && obj.visible) {
        obj.visible = false;
        hidden.push(obj);
      }
    };
    hideNode(this.waterMesh);
    hideNode(this.reedMesh);

    const northSector = this.group.parent; // city-north
    const cityGroup = northSector?.parent; // echo-life-city
    const worldGroup = cityGroup?.parent; // echo-life
    const stageGroup = worldGroup?.parent; // stage

    if (northSector) {
      for (let i = 0; i < northSector.children.length; i++) {
        const ch = northSector.children[i];
        if (ch.name === 'city-ground') hideNode(ch);
      }
    }
    if (cityGroup) {
      for (let i = 0; i < cityGroup.children.length; i++) {
        const ch = cityGroup.children[i];
        if (REFLECTION_HIDE_CITY_CHILDREN.has(ch.name)) hideNode(ch);
      }
    }
    if (worldGroup) {
      for (let i = 0; i < worldGroup.children.length; i++) {
        const ch = worldGroup.children[i];
        if (REFLECTION_HIDE_WORLD_CHILDREN.has(ch.name)) {
          hideNode(ch);
        } else if (ch.name === 'echo-life-stream') {
          for (let j = 0; j < ch.children.length; j++) {
            const sub = ch.children[j];
            if (REFLECTION_HIDE_STREAM_CHILDREN.has(sub.name)) hideNode(sub);
          }
        }
      }
    }
    if (stageGroup) {
      for (let i = 0; i < stageGroup.children.length; i++) {
        const ch = stageGroup.children[i];
        if (REFLECTION_HIDE_STAGE_CHILDREN.has(ch.name)) hideNode(ch);
      }
    }
    // Also check direct scene children in case `echo-life-people` is mounted directly on `scene`.
    if (scene !== stageGroup) {
      for (let i = 0; i < scene.children.length; i++) {
        const ch = scene.children[i];
        if (REFLECTION_HIDE_STAGE_CHILDREN.has(ch.name)) hideNode(ch);
      }
    }
  }

  /**
   * 1×1 scissored planar reflection warmup behind the loading overlay (`high`/`ultra` only).
   * Bypasses indoors, distance, facing, and cadence gates to allocate the 0.5× HalfFloat reflection RT
   * and warm any reflection-pass shader/FBO states with ~1-pixel fill cost, while keeping
   * `lastFrameReflected = false` so the first live gameplay frame near the river renders at full res.
   */
  warmupReflection(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera): boolean {
    if (!this.isPlanarReflectionEnabled() || globalRenderingReflection) return false;
    if (!hasAllSceneShadowMaps(scene, renderer)) return false;
    if (!(camera as T.PerspectiveCamera).isPerspectiveCamera) return false;

    const perspCamera = camera as T.PerspectiveCamera;
    const rt = this.ensureReflectionRt(renderer);

    this.group.updateMatrixWorld();
    this.waterMesh.updateMatrixWorld();
    camera.updateMatrixWorld();

    _reflWorldPos.setFromMatrixPosition(this.waterMesh.matrixWorld);
    _rotMat.extractRotation(this.waterMesh.matrixWorld);
    _reflNormal.set(0, 1, 0).applyMatrix4(_rotMat).normalize();

    camera.getWorldPosition(_camWorldPos);
    _viewVec.subVectors(_reflWorldPos, _camWorldPos);

    const reflCam = this.reflectionCamera;
    reflCam.fov = perspCamera.fov;
    reflCam.aspect = perspCamera.aspect;
    reflCam.near = perspCamera.near;
    reflCam.far = Math.min(perspCamera.far, 420);

    if (_viewVec.dot(_reflNormal) >= -0.08) {
      // Camera is indoors or at/below water level: synthesize an elevated riverbank warmup pose over the channel.
      const cx = (this.river.x0 + this.river.x1) * 0.5;
      _warmupCamPos.set(cx, this.waterY + 4.5, this.river.z1 + 12.0);
      this.group.localToWorld(_warmupCamPos);
      _warmupLookAt.set(cx, this.waterY + 1.5, this.river.z0 - 10.0);
      this.group.localToWorld(_warmupLookAt);

      _viewVec.subVectors(_reflWorldPos, _warmupCamPos).reflect(_reflNormal).negate().add(_reflWorldPos);
      _targetVec.subVectors(_reflWorldPos, _warmupLookAt).reflect(_reflNormal).negate().add(_reflWorldPos);
      reflCam.position.copy(_viewVec);
      reflCam.up.set(0, 1, 0).reflect(_reflNormal);
      reflCam.lookAt(_targetVec);
    } else {
      _viewVec.reflect(_reflNormal).negate().add(_reflWorldPos);
      _rotMat.extractRotation(camera.matrixWorld);
      _lookAtPos.set(0, 0, -1).applyMatrix4(_rotMat).add(_camWorldPos);
      _targetVec.subVectors(_reflWorldPos, _lookAtPos).reflect(_reflNormal).negate().add(_reflWorldPos);
      reflCam.position.copy(_viewVec);
      reflCam.up.set(0, 1, 0).applyMatrix4(_rotMat).reflect(_reflNormal);
      reflCam.lookAt(_targetVec);
    }

    reflCam.updateMatrixWorld();
    reflCam.updateProjectionMatrix();

    // Apply oblique near-plane clip when non-degenerate; otherwise keep standard perspective projection so warmup always runs.
    _reflPlane.setFromNormalAndCoplanarPoint(_reflNormal, _reflWorldPos);
    _reflPlane.applyMatrix4(reflCam.matrixWorldInverse);
    _clipPlane.set(_reflPlane.normal.x, _reflPlane.normal.y, _reflPlane.normal.z, _reflPlane.constant);
    const proj = reflCam.projectionMatrix;
    _qVec.x = (Math.sign(_clipPlane.x) + proj.elements[8]) / proj.elements[0];
    _qVec.y = (Math.sign(_clipPlane.y) + proj.elements[9]) / proj.elements[5];
    _qVec.z = -1.0;
    _qVec.w = (1.0 + proj.elements[10]) / proj.elements[14];
    const clipDot = _clipPlane.dot(_qVec);
    if (Number.isFinite(clipDot) && Math.abs(clipDot) >= 1e-4) {
      const obliqueScale = Math.max(-50.0, Math.min(50.0, 2.0 / clipDot));
      _clipPlane.multiplyScalar(obliqueScale);
      const clipBias = 0.003;
      proj.elements[2] = _clipPlane.x;
      proj.elements[6] = _clipPlane.y;
      proj.elements[10] = _clipPlane.z + 1.0 - clipBias;
      proj.elements[14] = _clipPlane.w;
    }

    this.hideNonReflectingSubtrees(scene);

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    const prevAutoClear = renderer.autoClear;
    const prevToneMapping = renderer.toneMapping;
    renderer.getViewport(_prevViewport);
    renderer.getScissor(_prevScissor);
    const prevScissorTest = renderer.getScissorTest();
    _prevRtScissor.copy(rt.scissor);
    const prevRtScissorTest = rt.scissorTest;

    globalRenderingReflection = true;
    try {
      // Three.js r186 applies `rt.scissor` and `rt.scissorTest` inside `setRenderTarget(rt)`.
      rt.scissor.set(0, 0, 1, 1);
      rt.scissorTest = true;
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.autoClear = true;
      renderer.toneMapping = T.NoToneMapping;
      renderer.setRenderTarget(rt);
      renderer.state.buffers.depth.setMask(true);
      renderer.clear(true, true, false);
      renderer.render(scene, reflCam);
      return true;
    } catch {
      return false;
    } finally {
      globalRenderingReflection = false;
      rt.scissor.copy(_prevRtScissor);
      rt.scissorTest = prevRtScissorTest;
      renderer.setRenderTarget(prevTarget);
      renderer.setViewport(_prevViewport);
      renderer.setScissor(_prevScissor);
      renderer.setScissorTest(prevScissorTest);
      renderer.toneMapping = prevToneMapping;
      renderer.xr.enabled = prevXr;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.shadowMap.needsUpdate = prevShadowNeeds;
      renderer.autoClear = prevAutoClear;
      for (let i = 0; i < this.hiddenInReflection.length; i++) {
        this.hiddenInReflection[i].visible = true;
      }
      this.hiddenInReflection.length = 0;
    }
  }

  /** Alias for `warmupReflection` matching PSO warmup coordinator call sites. */
  warmupPlanarReflectionScissored(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera): boolean {
    return this.warmupReflection(renderer, scene, camera);
  }

  private renderPlanarReflection(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera): boolean {
    if (this.disposed || globalRenderingReflection) return false;

    const wCfg = RENDER_CONFIGS[this.tierValue].water;
    if (!this.isPlanarReflectionEnabled()) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'tier-disabled';
      return false;
    }
    if (this.explicitInsideBuilding ?? this.atmosphereIndoors) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'inside-building';
      return false;
    }
    // Boot safety guard: planar reflection renders with `shadowMap.autoUpdate = false`; if ANY visible
    // shadow-casting light anywhere in the scene still lacks an allocated `shadow.map`, skip cleanly for 1 frame
    // to guarantee ZERO `GL_INVALID_OPERATION`!
    if (!hasAllSceneShadowMaps(scene, renderer)) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'shadow-maps-pending';
      return false;
    }
    if (!(camera as T.PerspectiveCamera).isPerspectiveCamera) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'non-perspective';
      return false;
    }
    const perspCamera = camera as T.PerspectiveCamera;

    camera.updateMatrixWorld();
    camera.getWorldPosition(_camWorldPos);
    _camLocalPos.copy(_camWorldPos);
    this.group.worldToLocal(_camLocalPos);

    if (_camLocalPos.y <= this.waterY + 0.08) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'below-water';
      return false;
    }

    // Strict distance gate (<= 52 m Ultra / <= 48 m High) -> zero cost on Lantern/Market/Residential/EV!
    const dx = Math.max(this.river.x0 - _camLocalPos.x, 0, _camLocalPos.x - this.river.x1);
    const dz = Math.max(this.river.z0 - _camLocalPos.z, 0, _camLocalPos.z - this.river.z1);
    const distToRiver = Math.hypot(dx, dz);
    const maxDist = wCfg.reflectionMaxDist > 0 ? wCfg.reflectionMaxDist : (this.tierValue === 'ultra' ? 52 : 48);
    if (distToRiver >= maxDist) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'beyond-max-dist';
      return false;
    }

    // Exact facing-direction frustum gate -> zero cost whenever camera looks away from the river!
    if (!this.isCameraLookingTowardRiver(perspCamera)) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'facing-away';
      return false;
    }

    const distFade = Math.max(0, Math.min(1, (maxDist - distToRiver) / 14));
    this.waterMat.uniforms.uReflectMix.value = distFade;

    // 0.5x HalfFloatType HDR linear reflection target matching EffectComposer's inputBuffer format strictly!
    this.ensureReflectionRt(renderer);

    // Always update reflectionCamera & textureMatrix so UV projection matches current camera pose smoothly.
    _reflWorldPos.setFromMatrixPosition(this.waterMesh.matrixWorld);
    _rotMat.extractRotation(this.waterMesh.matrixWorld);
    _reflNormal.set(0, 1, 0).applyMatrix4(_rotMat).normalize();

    _viewVec.subVectors(_reflWorldPos, _camWorldPos);
    if (_viewVec.dot(_reflNormal) > 0) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'under-plane';
      return false;
    }

    _viewVec.reflect(_reflNormal).negate().add(_reflWorldPos);

    _rotMat.extractRotation(camera.matrixWorld);
    _lookAtPos.set(0, 0, -1).applyMatrix4(_rotMat).add(_camWorldPos);
    _targetVec.subVectors(_reflWorldPos, _lookAtPos).reflect(_reflNormal).negate().add(_reflWorldPos);

    const reflCam = this.reflectionCamera;
    reflCam.position.copy(_viewVec);
    reflCam.up.set(0, 1, 0).applyMatrix4(_rotMat).reflect(_reflNormal);
    reflCam.lookAt(_targetVec);
    reflCam.fov = perspCamera.fov;
    reflCam.aspect = perspCamera.aspect;
    reflCam.near = perspCamera.near;
    reflCam.far = Math.min(perspCamera.far, 420);
    reflCam.updateMatrixWorld();
    reflCam.projectionMatrix.copy(perspCamera.projectionMatrix);

    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0,
    );
    this.textureMatrix.multiply(reflCam.projectionMatrix);
    this.textureMatrix.multiply(reflCam.matrixWorldInverse);
    this.textureMatrix.multiply(this.waterMesh.matrixWorld);

    // Cadence throttle: 2 on Ultra, 3 on High (immediate refresh only on teleport > 3 m or snap turn > 16°).
    this.reflectionFrame++;
    const cadence = Math.max(1, wCfg.reflectionCadence || (this.tierValue === 'ultra' ? 2 : 3));
    const camJumped =
      _camWorldPos.distanceToSquared(this.lastReflCamPos) > 9.0 ||
      _camForward.dot(this.lastReflCamDir) < 0.96;
    if (cadence > 1 && this.lastFrameReflected && !camJumped && (this.reflectionFrame % cadence) !== 0) {
      this.lastSkippedReason = 'cadence-cached';
      return false;
    }

    // Oblique near-plane clipping (Eric Lengyel method) applied directly to `reflCam.projectionMatrix`
    // clips all geometry below `waterY` with ZERO `renderer.clippingPlanes` (`NUM_CLIPPING_PLANES=0`).
    _reflPlane.setFromNormalAndCoplanarPoint(_reflNormal, _reflWorldPos);
    _reflPlane.applyMatrix4(reflCam.matrixWorldInverse);
    _clipPlane.set(_reflPlane.normal.x, _reflPlane.normal.y, _reflPlane.normal.z, _reflPlane.constant);

    const proj = reflCam.projectionMatrix;
    _qVec.x = (Math.sign(_clipPlane.x) + proj.elements[8]) / proj.elements[0];
    _qVec.y = (Math.sign(_clipPlane.y) + proj.elements[9]) / proj.elements[5];
    _qVec.z = -1.0;
    _qVec.w = (1.0 + proj.elements[10]) / proj.elements[14];
    const clipDot = _clipPlane.dot(_qVec);
    if (!Number.isFinite(clipDot) || Math.abs(clipDot) < 1e-4) {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'oblique-degenerate';
      return false;
    }
    const obliqueScale = Math.max(-50.0, Math.min(50.0, 2.0 / clipDot));
    _clipPlane.multiplyScalar(obliqueScale);

    const clipBias = 0.003;
    proj.elements[2] = _clipPlane.x;
    proj.elements[6] = _clipPlane.y;
    proj.elements[10] = _clipPlane.z + 1.0 - clipBias;
    proj.elements[14] = _clipPlane.w;

    this.hideNonReflectingSubtrees(scene);
    const hidden = this.hiddenInReflection;

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    const prevAutoClear = renderer.autoClear;
    const prevToneMapping = renderer.toneMapping;

    globalRenderingReflection = true;
    try {
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.autoClear = true;
      // Match composer HDR RT tone-mapping state (`NoToneMapping`) so shader parameters stay identical.
      renderer.toneMapping = T.NoToneMapping;
      renderer.setRenderTarget(this.reflectionRt);
      renderer.state.buffers.depth.setMask(true);
      renderer.clear(true, true, false);
      renderer.render(scene, reflCam);
      this.lastFrameReflected = true;
      this.lastSkippedReason = null;
      this.lastReflCamPos.copy(_camWorldPos);
      this.lastReflCamDir.copy(_camForward);
      return true;
    } catch {
      this.waterMat.uniforms.uReflectMix.value = 0;
      this.lastFrameReflected = false;
      this.lastSkippedReason = 'render-error';
      return false;
    } finally {
      globalRenderingReflection = false;
      renderer.setRenderTarget(prevTarget);
      renderer.toneMapping = prevToneMapping;
      renderer.xr.enabled = prevXr;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.shadowMap.needsUpdate = prevShadowNeeds;
      renderer.autoClear = prevAutoClear;
      for (let i = 0; i < hidden.length; i++) {
        hidden[i].visible = true;
      }
      hidden.length = 0;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.waterMesh.onBeforeRender = () => undefined;
    this.reflectionRt?.dispose();
    this.reflectionRt = null;
    this.waterGeo.dispose();
    this.waterMat.dispose();
    this.dummyNormalTex.dispose();
    this.dummyReflectTex.dispose();
    if (this.reedMesh) this.reedMesh.dispose();
    this.reedGeo?.dispose();
    this.reedMat?.dispose();
    this.group.removeFromParent();
  }
}
