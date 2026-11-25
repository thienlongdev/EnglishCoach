import * as T from 'three';

/**
 * Echo Life — Weather-Reactive Surface Wetness, Snow Cover & GPU Instanced Atmospheric Particles.
 *
 * Zero external runtime dependencies: owns the shared `SharedWeatherUniforms` uniform block updated once per frame
 * (smooth wetness accumulation + evaporation hysteresis, snow accumulation, animated gusty wind), a composable
 * `patchWeatherWetness` `onBeforeCompile` shader hook for all outdoor PBR materials (porosity albedo darkening,
 * world-space glossy puddles, live concentric puddle raindrop ripples, winter snow drifts, optional waterline moss),
 * and a 2-draw-call GPU instanced billboard particle suite (wind-angled rain streaks + ground splash mists,
 * soft bokeh snowflakes, 3D fluttering spring blossom petals, tumbling autumn leaves — zero 1-px LineSegments).
 */

export type WeatherRenderTier = 'ultra' | 'high' | 'balanced' | 'low';
export type WeatherParticleMode = 'none' | 'rain' | 'snow' | 'petals' | 'leaves';
export type AutoWeatherId = 'sunny' | 'cloudy' | 'light_rain' | 'heavy_rain' | 'golden_breeze' | 'overcast' | 'snowy';

/**
 * Deterministic automatic weather cycle that naturally reaches `heavy_rain` storms
 * (and `snowy` blizzards in Winter) alongside clear, cloudy, and golden-breeze slots.
 */
export const AUTO_WEATHER_PATTERN: readonly AutoWeatherId[] = Object.freeze([
  'sunny',
  'cloudy',
  'light_rain',
  'heavy_rain',
  'golden_breeze',
  'sunny',
  'overcast',
  'sunny',
]);

export interface AutoWeatherSample {
  readonly id: AutoWeatherId;
  readonly label: string;
  readonly rain: number;
  readonly snow: number;
  readonly cloud: number;
}

/**
 * Resolves automatic continuous weather for a game minute & season (0=Spring..3=Winter),
 * ensuring `heavy_rain` (`rain >= 0.92`) is genuinely reachable in automatic rotation.
 */
export function resolveAutoWeather(minute: number, season: number): AutoWeatherSample {
  const sIdx = Math.max(0, Math.min(3, season | 0));
  const slot = Math.floor(Math.max(0, minute) / 300);
  const raw = AUTO_WEATHER_PATTERN[(slot + sIdx * 2) % AUTO_WEATHER_PATTERN.length];
  if (sIdx === 3 && (raw === 'light_rain' || raw === 'heavy_rain')) {
    const heavy = raw === 'heavy_rain';
    return {
      id: 'snowy',
      label: heavy ? 'Heavy Snow' : 'Snowy',
      rain: 0,
      snow: heavy ? 0.96 : 0.78,
      cloud: heavy ? 0.96 : 0.86,
    };
  }
  switch (raw) {
    case 'heavy_rain':
      return { id: 'heavy_rain', label: 'Heavy Rain', rain: 0.96, snow: 0, cloud: 0.98 };
    case 'light_rain':
      return { id: 'light_rain', label: 'Light Rain', rain: 0.62, snow: 0, cloud: 0.88 };
    case 'overcast':
      return { id: 'overcast', label: 'Overcast', rain: 0, snow: 0, cloud: 0.84 };
    case 'cloudy':
      return { id: 'cloudy', label: 'Partly Cloudy', rain: 0, snow: 0, cloud: 0.56 };
    case 'golden_breeze':
      return { id: 'golden_breeze', label: 'Golden Breeze', rain: 0, snow: 0, cloud: 0.24 };
    default:
      return { id: 'sunny', label: 'Sunny', rain: 0, snow: 0, cloud: 0.12 };
  }
}

export interface SharedWeatherUniforms {
  uTime: { value: number };
  /** 0..1 smooth surface wetness with rain accumulation & post-rain drying hysteresis. */
  uWetness: { value: number };
  /** 0..1 active falling precipitation strength (drives live puddle & river raindrop ripples). */
  uRainIntensity: { value: number };
  /** 0..1 snow cover accumulation on upward-facing outdoor surfaces. */
  uSnowCover: { value: number };
  /** 0 = Spring, 1 = Summer, 2 = Autumn, 3 = Winter. */
  uSeason: { value: number };
  /** Animated horizontal wind vector in metres/second (world XZ). */
  uWindVec: { value: T.Vector2 };
  /** 0..1 daylight weight synced from atmosphere for night vs day puddle specular reflection tinting. */
  uDay?: { value: number };
}

export function createSharedWeatherUniforms(): SharedWeatherUniforms {
  return {
    uTime: { value: 0 },
    uWetness: { value: 0 },
    uRainIntensity: { value: 0 },
    uSnowCover: { value: 0 },
    uSeason: { value: 0 },
    uWindVec: { value: new T.Vector2(0.8, 0.25) },
    uDay: { value: 1 },
  };
}

export interface WeatherDynamicsInput {
  rain: number;
  snow: number;
  day: number;
  season: number;
  reduced: boolean;
  /** True when the user/QA explicitly switched weather presets in Settings so wetness/snow responds immediately. */
  snapOverride?: boolean;
}

/**
 * Stateful physical driver for `SharedWeatherUniforms`: accumulates wetness during rain, dries gradually in sun
 * after rain stops, accumulates/melts snow cover, and drives multi-frequency horizontal wind gusts.
 */
export class WeatherDynamics {
  private windClock = 0;

  constructor(readonly uniforms: SharedWeatherUniforms = createSharedWeatherUniforms()) {}

  step(dt: number, input: WeatherDynamicsInput): void {
    const safeDt = Math.max(0, Math.min(dt, 0.1));
    const rain = Math.max(0, Math.min(1, input.rain));
    const snow = Math.max(0, Math.min(1, input.snow));
    const day = Math.max(0, Math.min(1, input.day));
    const season = Math.max(0, Math.min(3, input.season | 0));

    if (!input.reduced) {
      this.uniforms.uTime.value = (this.uniforms.uTime.value + safeDt) % 86400;
      this.windClock = (this.windClock + safeDt) % 86400;
    }

    this.uniforms.uSeason.value = season;
    if (this.uniforms.uDay) this.uniforms.uDay.value = day;
    // Allow natural auto-rainstorms (0.72..0.75) to swell organically into heavy_rain squalls (>0.85) over time.
    const squallBoost = !input.snapOverride && rain >= 0.70 && rain < 0.85
      ? 0.16 * (0.5 + 0.5 * Math.sin(this.windClock * 0.085))
      : 0;
    const effectiveRain = Math.min(1, rain + squallBoost);
    this.uniforms.uRainIntensity.value = effectiveRain;

    const targetWet = effectiveRain > 0.05 ? Math.min(1, 0.45 + effectiveRain * 0.62) : 0;
    const targetSnow = snow > 0.05 ? Math.min(1, 0.48 + snow * 0.54) : 0;

    if (input.snapOverride || input.reduced) {
      this.uniforms.uWetness.value = targetWet;
      this.uniforms.uSnowCover.value = targetSnow;
    } else {
      // Wetness accumulates briskly in rain (~3-4 s) and evaporates naturally (~16-22 s) after rain ends.
      const wetRate = targetWet > this.uniforms.uWetness.value
        ? 0.26 + rain * 0.22
        : 0.032 + day * 0.042;
      const wAlpha = 1 - Math.exp(-wetRate * safeDt);
      this.uniforms.uWetness.value += (targetWet - this.uniforms.uWetness.value) * wAlpha;
      if (this.uniforms.uWetness.value < 0.002 && targetWet === 0) this.uniforms.uWetness.value = 0;

      // Snow builds steadily during snowfall and melts faster in rain or bright midday sun.
      const snowRate = targetSnow > this.uniforms.uSnowCover.value
        ? 0.20 + snow * 0.16
        : 0.05 + day * 0.045 + rain * 0.25;
      const sAlpha = 1 - Math.exp(-snowRate * safeDt);
      this.uniforms.uSnowCover.value += (targetSnow - this.uniforms.uSnowCover.value) * sAlpha;
      if (this.uniforms.uSnowCover.value < 0.002 && targetSnow === 0) this.uniforms.uSnowCover.value = 0;
    }

    // Gusty horizontal wind vector scaled by storm intensity and seasonal breeze.
    const t = this.windClock;
    const gust = 0.65 + 0.35 * Math.sin(t * 0.37) + 0.22 * Math.sin(t * 0.91 + 1.4) + 0.12 * Math.sin(t * 1.73 + 2.6);
    const storm = Math.max(rain, snow * 0.85);
    const baseSpeed = 0.55 + storm * 2.4 + (season === 2 ? 0.35 : 0);
    const angle = 0.28 + Math.sin(t * 0.13) * 0.32 + storm * 0.18 * Math.cos(t * 0.41);
    this.uniforms.uWindVec.value.set(Math.cos(angle) * baseSpeed * gust, Math.sin(angle) * baseSpeed * gust);
  }
}

export interface WeatherWetnessOptions {
  /** 0..1 porosity albedo darkening in rain (asphalt ~0.88, concrete ~0.74, stone ~0.72, wood ~0.68, grass ~0.45). */
  porosity?: number;
  /** 0..1 standing puddle formation strength on horizontal faces (roads ~0.95, sidewalks ~0.68, roofs ~0.48, walls 0). */
  puddleStrength?: number;
  /** World-space frequency of puddle depressions (default 0.16 m^-1). */
  puddleScale?: number;
  /** Enable animated concentric raindrop ripple normals inside puddles (disabled automatically on balanced/low). */
  puddleRipples?: boolean;
  /** 0..1 snow accumulation receptivity (lawns/roofs ~0.95, sidewalks ~0.70, roads ~0.26, vertical walls ~0.08). */
  snowReceptivity?: number;
  /** Minimum mirror roughness inside standing puddles (default 0.038). */
  wetRoughnessFloor?: number;
  /** Multiplier applied to dry roughness for damp non-puddle film (default 0.46). */
  wetRoughnessScale?: number;
  /** Grazing Fresnel sky-sheen lift inside wet puddles so rain reads clearly even under overcast skies (default 0.26). */
  dampSheen?: number;
  /** Optional river waterline Y coordinate (metres): adds damp capillary darkening & moss band above waterY. */
  waterlineY?: number | null;
  /** Quality tier controlling FBM/ripple shader complexity. */
  tier?: WeatherRenderTier;
  /** Optional cache key suffix to differentiate shader variants cleanly. */
  cacheTag?: string;
}

const WEATHER_GLSL_HELPERS = /* glsl */ `
float wthHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 wthHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float wthNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(wthHash12(i), wthHash12(i + vec2(1.0, 0.0)), u.x),
    mix(wthHash12(i + vec2(0.0, 1.0)), wthHash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
float wthFbm(vec2 p) {
  const mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  float v = 0.0;
  float a = 0.52;
  v += a * wthNoise(p); p = rot * p * 2.03 + vec2(17.1, 31.7); a *= 0.5;
  v += a * wthNoise(p); p = rot * p * 2.07 + vec2(11.3, 47.2); a *= 0.5;
  v += a * wthNoise(p);
  return v;
}
`;

const PUDDLE_RIPPLE_GLSL = /* glsl */ `
vec2 wthPuddleRippleLayer(vec2 xz, float scale, float time, float seedOff) {
  vec2 p = xz * scale;
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 grad = vec2(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 g = cell + vec2(float(dx), float(dy));
      vec2 rnd = wthHash22(g + seedOff);
      float life = fract(time * (0.72 + rnd.x * 0.48) + rnd.y);
      vec2 center = vec2(float(dx), float(dy)) + 0.16 + rnd * 0.68;
      vec2 d = f - center;
      float r = length(d) + 1e-4;
      float waveR = life * 0.56;
      float env = exp(-abs(r - waveR) * 16.0) * (1.0 - life) * smoothstep(0.0, 0.09, life) * smoothstep(0.62, 0.10, r);
      float ring = cos((r - waveR) * 44.0) * env;
      grad += (d / r) * ring;
    }
  }
  return grad;
}
vec2 wthPuddleRipples(vec2 xz, float time) {
  return wthPuddleRippleLayer(xz, 1.35, time, 13.7) * 0.62
       + wthPuddleRippleLayer(xz, 2.25, time * 1.13, 71.3) * 0.38;
}
`;

/**
 * Composable `onBeforeCompile` weather wetness & snow-cover shader patch for any outdoor `MeshStandardMaterial`
 * or `MeshPhysicalMaterial` (roads, crossings, sidewalks, plazas, parks, embankment walls, roofs, facades, wood).
 *
 * Preserves existing `onBeforeCompile` hooks and `vertexColors` (`house.ts` `setFinishes`) cleanly while sharing
 * one global `SharedWeatherUniforms` instance across the entire city (zero per-material CPU updates).
 */
export function patchWeatherWetness<M extends T.MeshStandardMaterial>(
  material: M,
  uniforms: SharedWeatherUniforms,
  opts: WeatherWetnessOptions = {},
): M {
  if (material.userData.__echoWeatherPatched) return material;
  material.userData.__echoWeatherPatched = true;

  const tier: WeatherRenderTier = opts.tier ?? 'high';
  const porosity = opts.porosity ?? 0.78;
  const snowReceptivity = opts.snowReceptivity ?? 0.65;
  const wetRoughFloor = Math.max(0.04, Math.min(0.10, opts.wetRoughnessFloor ?? 0.045));
  const wetRoughScale = opts.wetRoughnessScale ?? 0.44;

  const prevCompile = material.onBeforeCompile;
  const prevCacheKey = material.customProgramCacheKey?.bind(material);

  // Low-tier iGPU fast path: uniform wetness darkening/roughness & simple upward snow tint — ZERO per-fragment FBM!
  if (tier === 'low') {
    const lowKey = 'echo-wth-v2-low';
    material.customProgramCacheKey = () => {
      const base = prevCacheKey ? prevCacheKey() : '';
      return base ? `${base}|${lowKey}` : lowKey;
    };
    material.onBeforeCompile = (shader, renderer) => {
      prevCompile?.(shader, renderer);
      shader.uniforms.uWthWetness = uniforms.uWetness;
      shader.uniforms.uWthSnow = uniforms.uSnowCover;
      shader.uniforms.uWthPorosity = { value: porosity };
      shader.uniforms.uWthSnowReceptivity = { value: snowReceptivity };
      shader.uniforms.uWthRoughFloor = { value: wetRoughFloor };
      shader.uniforms.uWthRoughScale = { value: wetRoughScale };

      shader.vertexShader =
        /* glsl */ `varying float vWthUpY;\n` +
        shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          /* glsl */ `#include <worldpos_vertex>
  vec3 wthLowN = objectNormal;
  #ifdef USE_BATCHING
    wthLowN = mat3( batchingMatrix ) * wthLowN;
  #endif
  #ifdef USE_INSTANCING
    wthLowN = mat3( instanceMatrix ) * wthLowN;
  #endif
  vWthUpY = normalize( mat3( modelMatrix ) * wthLowN ).y;
`,
        );

      shader.fragmentShader =
        /* glsl */ `
varying float vWthUpY;
uniform float uWthWetness;
uniform float uWthSnow;
uniform float uWthPorosity;
uniform float uWthSnowReceptivity;
uniform float uWthRoughFloor;
uniform float uWthRoughScale;
` +
        shader.fragmentShader
          .replace(
            '#include <color_fragment>',
            /* glsl */ `#include <color_fragment>
  float wthUp = smoothstep( 0.35, 0.85, vWthUpY );
  float wthSnowMask = clamp( uWthSnow * uWthSnowReceptivity * wthUp, 0.0, 0.90 );
  float wthWet = clamp( uWthWetness * mix( 0.45, 1.0, wthUp ) * ( 1.0 - wthSnowMask * 0.85 ), 0.0, 1.0 );
  if ( wthWet > 0.01 ) {
    diffuseColor.rgb *= mix( 1.0, 1.0 - 0.38 * uWthPorosity, wthWet );
  }
  if ( wthSnowMask > 0.01 ) {
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.90, 0.93, 0.97 ), wthSnowMask );
  }
`,
          )
          .replace(
            '#include <roughnessmap_fragment>',
            /* glsl */ `#include <roughnessmap_fragment>
  if ( wthWet > 0.01 ) {
    roughnessFactor = mix( roughnessFactor, max( uWthRoughFloor + 0.08, roughnessFactor * uWthRoughScale ), wthWet );
  }
  if ( wthSnowMask > 0.01 ) {
    roughnessFactor = mix( roughnessFactor, 0.78, wthSnowMask );
  }
`,
          );
    };
    material.needsUpdate = true;
    return material;
  }

  const enablePuddles = (opts.puddleStrength ?? 0.85) > 0.001;
  const enableRipples = (tier === 'ultra' || tier === 'high') && enablePuddles && (opts.puddleRipples ?? true);
  const hasWaterline = typeof opts.waterlineY === 'number' && Number.isFinite(opts.waterlineY);

  const puddleStrength = enablePuddles ? (opts.puddleStrength ?? 0.85) : 0;
  const puddleScale = opts.puddleScale ?? 0.16;
  const dampSheen = opts.dampSheen ?? 0.30;
  const waterlineY = hasWaterline ? opts.waterlineY! : -9999;

  // Key strictly on boolean GLSL-branching flags (NOT opts.cacheTag or tier) — slashes ~20 duplicate shader programs!
  const variantKey = `echo-wth-v2:${enablePuddles ? 1 : 0}:${enableRipples ? 1 : 0}:${hasWaterline ? 1 : 0}`;

  material.customProgramCacheKey = () => {
    const base = prevCacheKey ? prevCacheKey() : '';
    return base ? `${base}|${variantKey}` : variantKey;
  };

  const dayUniform = uniforms.uDay ?? { value: 1 };

  material.onBeforeCompile = (shader, renderer) => {
    prevCompile?.(shader, renderer);

    // Bind shared references so updating `SharedWeatherUniforms` once updates every patched material automatically.
    shader.uniforms.uWthTime = uniforms.uTime;
    shader.uniforms.uWthWetness = uniforms.uWetness;
    shader.uniforms.uWthRain = uniforms.uRainIntensity;
    shader.uniforms.uWthSnow = uniforms.uSnowCover;
    shader.uniforms.uWthSeason = uniforms.uSeason;
    shader.uniforms.uWthDay = dayUniform;

    shader.uniforms.uWthPorosity = { value: porosity };
    shader.uniforms.uWthPuddleStrength = { value: puddleStrength };
    shader.uniforms.uWthPuddleScale = { value: puddleScale };
    shader.uniforms.uWthSnowReceptivity = { value: snowReceptivity };
    shader.uniforms.uWthRoughFloor = { value: wetRoughFloor };
    shader.uniforms.uWthRoughScale = { value: wetRoughScale };
    shader.uniforms.uWthDampSheen = { value: dampSheen };
    shader.uniforms.uWthWaterlineY = { value: waterlineY };

    // ── Vertex Shader: world position, world normal & view-space orthonormal basis (zero fragment mat3(viewMatrix)) ──
    shader.vertexShader =
      /* glsl */ `
varying vec3 vWthWorldPos;
varying vec3 vWthWorldNormal;
varying vec3 vWthViewUp;
varying vec3 vWthViewX;
varying vec3 vWthViewZ;
` +
      shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        /* glsl */ `#include <worldpos_vertex>
  vec4 wthWp = vec4( transformed, 1.0 );
  vec3 wthWn = objectNormal;
  #ifdef USE_BATCHING
    wthWp = batchingMatrix * wthWp;
    wthWn = mat3( batchingMatrix ) * wthWn;
  #endif
  #ifdef USE_INSTANCING
    wthWp = instanceMatrix * wthWp;
    wthWn = mat3( instanceMatrix ) * wthWn;
  #endif
  wthWp = modelMatrix * wthWp;
  vWthWorldPos = wthWp.xyz;
  vWthWorldNormal = normalize( mat3( modelMatrix ) * wthWn );
  vWthViewUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  vWthViewX  = normalize( ( viewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz );
  vWthViewZ  = normalize( ( viewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );
`,
      );

    // ── Fragment Shader: porosity darkening, world-space puddles, live puddle ripples, snow drifts & waterline moss ──
    const fragHeader = /* glsl */ `
varying vec3 vWthWorldPos;
varying vec3 vWthWorldNormal;
varying vec3 vWthViewUp;
varying vec3 vWthViewX;
varying vec3 vWthViewZ;
uniform float uWthTime;
uniform float uWthWetness;
uniform float uWthRain;
uniform float uWthSnow;
uniform float uWthSeason;
uniform float uWthDay;
uniform float uWthPorosity;
uniform float uWthPuddleStrength;
uniform float uWthPuddleScale;
uniform float uWthSnowReceptivity;
uniform float uWthRoughFloor;
uniform float uWthRoughScale;
uniform float uWthDampSheen;
uniform float uWthWaterlineY;
${WEATHER_GLSL_HELPERS}
${enableRipples ? PUDDLE_RIPPLE_GLSL : ''}
`;

    shader.fragmentShader =
      fragHeader +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
  float wthUp = smoothstep( 0.30, 0.86, vWthWorldNormal.y );
  float wthMacroN = wthFbm( vWthWorldPos.xz * uWthPuddleScale );
  float wthDetailN = wthNoise( vWthWorldPos.xz * ( uWthPuddleScale * 3.7 ) + vec2( 4.1, 7.3 ) );

  // Optional riverbank capillary waterline darkening & moss band above waterY.
  float wthCapillary = 0.0;
  ${
    hasWaterline
      ? /* glsl */ `
  float wthAboveWater = vWthWorldPos.y - uWthWaterlineY;
  float wthWaveEdge = ( wthDetailN - 0.5 ) * 0.16;
  wthCapillary = smoothstep( 0.72 + wthWaveEdge, 0.04, wthAboveWater ) * smoothstep( -0.35, -0.02, wthAboveWater );
  float wthMoss = smoothstep( 0.56 + wthWaveEdge, 0.08, wthAboveWater ) * smoothstep( 0.36, 0.78, wthMacroN * 0.65 + wthDetailN * 0.35 );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.13, 0.18, 0.11 ), wthMoss * 0.52 );
  `
      : ''
  }

  // Winter snow accumulation mask on upward-facing surfaces (fades on steep slopes & salted roadways).
  float wthSnowMask = 0.0;
  if ( uWthSnow > 0.005 && uWthSnowReceptivity > 0.005 ) {
    float snowNoise = wthMacroN * 0.65 + wthDetailN * 0.35;
    float snowThresh = mix( 0.88, 0.24, clamp( uWthSnow * uWthSnowReceptivity, 0.0, 1.0 ) );
    wthSnowMask = smoothstep( snowThresh, snowThresh + 0.18, wthUp * ( 0.68 + 0.52 * snowNoise ) ) * uWthSnow * uWthSnowReceptivity;
  }

  // Effective wetness (reduced slightly on vertical faces and suppressed under dry snow).
  float wthWet = clamp( max( uWthWetness * mix( 0.42, 1.0, wthUp ), wthCapillary * 0.92 ), 0.0, 1.0 ) * ( 1.0 - wthSnowMask * 0.85 );

  // World-space reflective puddle depressions on horizontal paved surfaces.
  float wthPuddle = 0.0;
  ${
    enablePuddles
      ? /* glsl */ `
  if ( uWthWetness > 0.04 && uWthPuddleStrength > 0.005 ) {
    float pField = wthMacroN * 0.68 + wthDetailN * 0.32;
    float pThresh = 0.76 - uWthWetness * 0.36;
    wthPuddle = smoothstep( pThresh, pThresh + 0.085, pField ) * wthUp * uWthPuddleStrength * smoothstep( 0.08, 0.32, uWthWetness ) * ( 1.0 - wthSnowMask );
  }
  `
      : ''
  }

  // Physically plausible porous wetness darkening (preserves hue saturation instead of turning gray).
  if ( wthWet > 0.002 ) {
    float wetAmt = clamp( max( wthWet, wthPuddle * 1.15 ) * uWthPorosity, 0.0, 0.95 );
    vec3 darkened = diffuseColor.rgb * diffuseColor.rgb * 0.56 + diffuseColor.rgb * 0.18;
    diffuseColor.rgb = mix( diffuseColor.rgb, darkened, wetAmt );
  }

  // Apply winter snow blanket albedo.
  if ( wthSnowMask > 0.002 ) {
    vec3 snowCol = mix( vec3( 0.84, 0.88, 0.94 ), vec3( 0.96, 0.97, 0.99 ), wthDetailN );
    diffuseColor.rgb = mix( diffuseColor.rgb, snowCol, wthSnowMask * 0.92 );
  }
`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `#include <roughnessmap_fragment>
  if ( wthWet > 0.002 ) {
    roughnessFactor = mix( roughnessFactor, max( uWthRoughFloor + 0.08, roughnessFactor * uWthRoughScale ), wthWet );
  }
  if ( wthPuddle > 0.002 ) {
    roughnessFactor = mix( roughnessFactor, uWthRoughFloor, wthPuddle );
  }
  if ( wthSnowMask > 0.002 ) {
    float frostSparkle = smoothstep( 0.86, 0.98, wthNoise( vWthWorldPos.xz * 26.0 ) );
    roughnessFactor = mix( roughnessFactor, 0.74 - frostSparkle * 0.42, wthSnowMask );
  }
`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `#include <normal_fragment_maps>
  if ( wthPuddle > 0.005 ) {
    vec3 wthFlatN = normalize( vWthViewUp );
    // Flatten standing puddle normals cleanly (0.94) so sky & night streetlamps mirror crisply on wet asphalt.
    normal = normalize( mix( normal, wthFlatN, wthPuddle * 0.94 ) );
    ${
      enableRipples
        ? /* glsl */ `
    if ( uWthRain > 0.04 ) {
      float wthCamDist = length( vViewPosition );
      float wthRipFade = smoothstep( 44.0, 9.0, wthCamDist );
      if ( wthRipFade > 0.005 ) {
        vec2 wthRG = wthPuddleRipples( vWthWorldPos.xz, uWthTime ) * ( wthPuddle * uWthRain * wthRipFade * 0.14 );
        normal = normalize( normal + normalize( vWthViewX ) * wthRG.x + normalize( vWthViewZ ) * wthRG.y );
      }
    }
    `
        : ''
    }
  }
`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `#include <emissivemap_fragment>
  if ( wthPuddle > 0.01 && uWthDampSheen > 0.001 ) {
    vec3 wthV = normalize( vViewPosition );
    float wthNdotV = clamp( dot( normal, wthV ), 0.0, 1.0 );
    float wthFr = 0.04 + 0.96 * pow( 1.0 - wthNdotV, 4.2 );
    float wthEdge = wthPuddle * ( 1.0 - wthPuddle ) * 3.2;
    // Crisp wet mirror reflection sheen: cool overcast sky by day, atmospheric slate + warm city streetlamp bounce at night.
    float wthWarmVar = wthNoise( vWthWorldPos.xz * 0.09 + vec2( 3.7, 9.1 ) );
    vec3 wthNightRefl = mix( vec3( 0.16, 0.22, 0.34 ), vec3( 0.56, 0.40, 0.22 ), smoothstep( 0.45, 0.85, wthWarmVar ) * 0.62 );
    vec3 wthDayRefl   = vec3( 0.54, 0.64, 0.76 );
    vec3 wthSheenCol  = mix( wthNightRefl, wthDayRefl, uWthDay );
    totalEmissiveRadiance += wthSheenCol * ( wthFr * 0.28 + wthEdge * 0.03 ) * wthPuddle * uWthDampSheen;
  }
`,
        );
  };

  material.needsUpdate = true;
  return material;
}

// ── GPU Instanced Atmospheric Particle System (Rain + Splashes / Snow / Spring Petals / Autumn Leaves) ──────────

const TIER_PRIMARY_COUNT: Record<WeatherRenderTier, number> = {
  ultra: 2400,
  high: 1600,
  balanced: 900,
  low: 350,
};

const TIER_SPLASH_COUNT: Record<WeatherRenderTier, number> = {
  ultra: 450,
  high: 280,
  balanced: 120,
  low: 0,
};

const PRIMARY_PARTICLE_VERT = /* glsl */ `
attribute vec4 aSeed; // x, y, z normalized [0..1], w = phase [0..1]
attribute vec3 aRand; // x = size scale, y = speed scale, z = color/variant seed

uniform float uTime;
uniform vec3 uEye;
uniform vec2 uWindVec;
uniform float uMode; // 0 = rain, 1 = snow, 2 = spring petals, 3 = autumn leaves

varying vec2 vUv;
varying float vMode;
varying float vVariant;
varying float vAlphaFade;

void main() {
  vUv = uv;
  vMode = uMode;
  vVariant = aRand.z;

  float isRain   = step( uMode, 0.5 );
  float isSnow   = step( 0.5, uMode ) * step( uMode, 1.5 );
  float isPetal  = step( 1.5, uMode ) * step( uMode, 2.5 );
  float isLeaf   = step( 2.5, uMode );

  vec3 boxSize = vec3( 26.0, 11.5, 26.0 );
  float fallSpeed = isRain * ( 11.5 + aRand.y * 5.0 )
                  + isSnow * ( 1.05 + aRand.y * 0.75 )
                  + isPetal * ( 0.68 + aRand.y * 0.45 )
                  + isLeaf * ( 0.92 + aRand.y * 0.60 );

  float windMul = isRain * 0.48 + isSnow * 0.52 + ( isPetal + isLeaf ) * 0.68;
  float ph = aSeed.w * 6.2831853;
  float swirlAmp = isRain * 0.0 + isSnow * 0.75 + isPetal * 1.15 + isLeaf * 1.35;
  float swirlFreq = isSnow * 1.35 + isPetal * 1.65 + isLeaf * 1.25;

  vec3 basePos = ( aSeed.xyz - 0.5 ) * boxSize;
  vec3 drift = vec3(
    uWindVec.x * windMul * uTime + sin( uTime * swirlFreq + ph ) * swirlAmp,
    -fallSpeed * uTime,
    uWindVec.y * windMul * uTime + cos( uTime * ( swirlFreq * 0.83 ) + ph * 1.3 ) * swirlAmp
  );

  // Seamless toroidal wrap centered on camera eye in local stage coordinates.
  vec3 rel = mod( basePos + drift - uEye + boxSize * 0.5, boxSize ) - boxSize * 0.5;
  vec3 worldCenter = uEye + rel;

  // Fade strictly to alpha = 0 when closer than 1.4 m to the camera lens (and softly near outer wrap edges)
  // so no raindrop, snowflake, petal, or autumn leaf ever blows up giant across the viewport.
  float horizDist = length( rel.xz );
  float camDist = length( rel );
  vec4 mvCenter = modelViewMatrix * vec4( worldCenter, 1.0 );
  float viewDepth = -mvCenter.z;
  float edgeFade = smoothstep( 13.0, 8.8, horizDist ) * smoothstep( 5.8, 3.8, abs( rel.y ) );
  float nearFade = smoothstep( 1.40, 2.35, camDist ) * smoothstep( 1.40, 2.25, viewDepth );
  vAlphaFade = edgeFade * nearFade;

  // Compute billboard / 3D tumbling orientation in world space (collapsed when faded out near lens).
  vec3 camRight = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
  vec3 camUp    = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
  vec3 toCam    = normalize( uEye - worldCenter + vec3( 1e-4 ) );

  vec3 quadOffset = vec3( 0.0 );
  if ( vAlphaFade > 0.002 ) {
    if ( isRain > 0.5 ) {
      // Velocity-aligned elongated rain streak tilted naturally by wind gusts.
      vec3 vel = normalize( vec3( uWindVec.x * windMul, -fallSpeed, uWindVec.y * windMul ) );
      vec3 side = normalize( cross( toCam, vel ) + vec3( 1e-4, 0.0, 0.0 ) );
      float w = ( 0.011 + aRand.x * 0.008 );
      float h = ( 0.34 + aRand.y * 0.24 );
      quadOffset = side * ( position.x * w ) + vel * ( position.y * h );
    } else if ( isSnow > 0.5 ) {
      // Soft spherical camera-facing snowflake quad.
      float sz = 0.036 + aRand.x * 0.044;
      quadOffset = camRight * ( position.x * sz ) + camUp * ( position.y * sz );
    } else {
      // 3D tumbling petal or autumn leaf with fluttering pitch & roll.
      float spinA = uTime * ( 1.8 + aRand.y * 1.9 ) + ph;
      float spinB = uTime * ( 1.1 + aRand.x * 1.4 ) + ph * 1.7;
      float cA = cos( spinA ), sA = sin( spinA );
      float cB = cos( spinB ), sB = sin( spinB );
      vec3 axisX = vec3( cA, sA * sB, -sA * cB );
      vec3 axisY = vec3( -sA * cB, cB, sB );
      float w = ( isPetal > 0.5 ? 0.048 : 0.068 ) * ( 0.78 + aRand.x * 0.52 );
      float h = ( isPetal > 0.5 ? 0.068 : 0.095 ) * ( 0.78 + aRand.x * 0.52 );
      quadOffset = axisX * ( position.x * w ) + axisY * ( position.y * h );
    }
  }

  vec4 mvPosition = modelViewMatrix * vec4( worldCenter + quadOffset, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
}
`;

const PRIMARY_PARTICLE_FRAG = /* glsl */ `
uniform float uDay;
uniform float uIntensity;
uniform vec3 uSunColor;
uniform vec3 uFogColor;

varying vec2 vUv;
varying float vMode;
varying float vVariant;
varying float vAlphaFade;

void main() {
  if ( vAlphaFade <= 0.005 ) discard;

  vec2 p = vUv * 2.0 - 1.0;
  vec3 col = vec3( 1.0 );
  float mask = 0.0;

  if ( vMode < 0.5 ) {
    // Mode 0: Soft tapered translucent raindrop streak (brighter head, feathered tail).
    float across = smoothstep( 1.0, 0.0, abs( p.x ) );
    float along  = smoothstep( -1.0, 0.15, p.y ) * smoothstep( 1.0, 0.45, p.y );
    mask = across * across * along * ( 0.24 + 0.30 * uDay ) * uIntensity;
    vec3 nightRain = mix( vec3( 0.58, 0.68, 0.82 ), vec3( 0.96, 0.80, 0.56 ), smoothstep( 0.72, 1.0, vVariant ) * 0.45 );
    vec3 dayRain   = mix( vec3( 0.78, 0.86, 0.94 ), uFogColor + vec3( 0.15 ), 0.35 );
    col = mix( nightRain, dayRain, uDay );
  } else if ( vMode < 1.5 ) {
    // Mode 1: Soft multi-depth bokeh snowflake.
    float r = length( p );
    if ( r > 1.0 ) discard;
    float core = smoothstep( 1.0, 0.15, r );
    mask = core * core * ( 0.52 + 0.38 * uDay ) * uIntensity;
    col = mix( vec3( 0.70, 0.78, 0.92 ), vec3( 0.97, 0.98, 1.0 ), uDay );
  } else if ( vMode < 2.5 ) {
    // Mode 2: Curved sakura spring blossom petal with delicate tip notch.
    vec2 q = vec2( p.x * 1.25, p.y );
    float notch = smoothstep( 0.25, 0.92, q.y ) * ( 1.0 - smoothstep( 0.0, 0.26, abs( q.x ) ) ) * 0.28;
    float d = length( vec2( q.x, q.y * 0.92 ) ) + notch;
    if ( d > 0.88 ) discard;
    mask = smoothstep( 0.88, 0.62, d ) * ( 0.68 + 0.24 * uDay ) * uIntensity;
    vec3 petalA = vec3( 0.99, 0.76, 0.85 );
    vec3 petalB = vec3( 1.0, 0.93, 0.95 );
    col = mix( petalA, petalB, fract( vVariant * 3.7 ) ) * mix( vec3( 0.36, 0.40, 0.54 ), uSunColor * 0.35 + vec3( 0.70 ), uDay );
  } else {
    // Mode 3: Tapered pointed autumn leaf (amber / burnt orange / crimson / honey gold).
    vec2 q = p;
    float widthAtY = ( 1.0 - q.y * q.y ) * ( 0.72 + 0.22 * sin( q.y * 4.2 ) );
    float d = abs( q.x ) / max( 0.05, widthAtY );
    if ( abs( q.y ) > 0.94 || d > 1.0 ) discard;
    float vein = smoothstep( 0.14, 0.0, abs( q.x ) ) * 0.15;
    mask = smoothstep( 1.0, 0.72, d ) * smoothstep( 0.94, 0.78, abs( q.y ) ) * ( 0.76 + 0.20 * uDay ) * uIntensity;
    vec3 gold    = vec3( 0.91, 0.65, 0.22 );
    vec3 orange  = vec3( 0.84, 0.38, 0.16 );
    vec3 crimson = vec3( 0.72, 0.21, 0.16 );
    vec3 leafBase = vVariant < 0.4 ? mix( gold, orange, vVariant * 2.5 ) : mix( orange, crimson, ( vVariant - 0.4 ) * 1.66 );
    col = ( leafBase - vein ) * mix( vec3( 0.30, 0.32, 0.42 ), uSunColor * 0.35 + vec3( 0.68 ), uDay );
  }

  float a = clamp( mask * vAlphaFade, 0.0, 0.92 );
  if ( a <= 0.005 ) discard;
  gl_FragColor = vec4( col, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPLASH_MIST_VERT = /* glsl */ `
attribute vec4 aSeed; // x, z normalized [0..1], y = height jitter, w = phase

uniform float uTime;
uniform vec3 uEye;
uniform float uGroundY;

varying vec2 vUv;
varying float vLife;
varying float vFade;

void main() {
  vUv = uv;
  float rate = 2.4 + aSeed.y * 1.6;
  float life = fract( uTime * rate + aSeed.w );
  vLife = life;

  // Deterministic per-cycle position jitter so splashes jump unpredictably on pavement & lawns.
  float cycle = floor( uTime * rate + aSeed.w );
  vec2 jitter = fract( sin( vec2( cycle * 127.1 + aSeed.x * 311.7, cycle * 269.5 + aSeed.z * 183.3 ) ) * 43758.5453 );
  vec2 span = vec2( 22.0 );
  vec2 baseXZ = ( fract( aSeed.xz + jitter ) - 0.5 ) * span;
  vec2 relXZ = mod( baseXZ - uEye.xz + span * 0.5, span ) - span * 0.5;

  float dist = length( relXZ );
  vFade = smoothstep( 11.0, 6.2, dist ) * smoothstep( 1.40, 2.15, dist );

  float radius = mix( 0.035, 0.175, pow( life, 0.65 ) );
  float lift = sin( life * 3.14159265 ) * 0.055;
  vec3 worldPos = vec3( uEye.x + relXZ.x + position.x * radius, uGroundY + 0.024 + lift, uEye.z + relXZ.y + position.y * radius );

  gl_Position = projectionMatrix * modelViewMatrix * vec4( worldPos, 1.0 );
}
`;

const SPLASH_MIST_FRAG = /* glsl */ `
uniform float uDay;
uniform float uIntensity;

varying vec2 vUv;
varying float vLife;
varying float vFade;

void main() {
  if ( vFade <= 0.005 ) discard;
  vec2 p = vUv * 2.0 - 1.0;
  float r = length( p );
  if ( r > 1.0 ) discard;

  // Expanding thin ring + soft central mist puff.
  float ringR = mix( 0.22, 0.88, vLife );
  float ring = exp( -pow( ( r - ringR ) * 7.5, 2.0 ) );
  float mist = smoothstep( 0.65, 0.0, r ) * ( 1.0 - vLife );
  float env = smoothstep( 0.0, 0.12, vLife ) * smoothstep( 1.0, 0.25, vLife );
  float a = ( ring * 0.55 + mist * 0.35 ) * env * vFade * ( 0.18 + 0.26 * uDay ) * uIntensity;
  if ( a <= 0.004 ) discard;

  vec3 col = mix( vec3( 0.56, 0.66, 0.80 ), vec3( 0.88, 0.93, 0.98 ), uDay );
  gl_FragColor = vec4( col, clamp( a, 0.0, 0.55 ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface WeatherParticleState {
  mode: WeatherParticleMode;
  intensity: number;
  day: number;
  sunColor?: T.Color;
  fogColor?: T.Color;
  groundY?: number;
  outdoors: boolean;
  reduced: boolean;
}

/**
 * 2-draw-call GPU instanced atmospheric particle suite replacing 1-px `LineSegments`:
 * - Draw 1: Camera-aligned billboard / 3D tumbling instanced quads (Rain streaks, Bokeh Snow, Spring Petals, Autumn Leaves)
 * - Draw 2: Ground-impact rain splash rings & micro-mist bursts (active during rain on Balanced/High/Ultra)
 */
export class WeatherParticleSystem {
  readonly group = new T.Group();
  private readonly primaryGeo: T.PlaneGeometry;
  private readonly primaryMat: T.ShaderMaterial;
  private readonly primaryMesh: T.InstancedMesh;
  private readonly splashGeo: T.PlaneGeometry;
  private readonly splashMat: T.ShaderMaterial;
  private readonly splashMesh: T.InstancedMesh;
  private tier: WeatherRenderTier;
  private activeMode: WeatherParticleMode = 'none';
  private activeOutdoors = false;
  private activeReduced = false;

  constructor(
    private readonly weather: SharedWeatherUniforms,
    tier: WeatherRenderTier = 'high',
    groundY = -3.2,
  ) {
    this.tier = tier;
    this.group.name = 'echo-life-weather-particles';

    // ── Primary Instanced Quad Pool (allocated at max Ultra capacity; tier sets `.count` without reallocation) ──
    const maxPrimary = TIER_PRIMARY_COUNT.ultra;
    this.primaryGeo = new T.PlaneGeometry(1, 1);

    const seeds = new Float32Array(maxPrimary * 4);
    const rands = new Float32Array(maxPrimary * 3);
    for (let i = 0; i < maxPrimary; i++) {
      // Low-discrepancy plastic/golden-ratio sequences prevent visible grid rows.
      seeds[i * 4 + 0] = (i * 0.6180339887) % 1;
      seeds[i * 4 + 1] = (i * 0.7548776662) % 1;
      seeds[i * 4 + 2] = (i * 0.5698402910) % 1;
      seeds[i * 4 + 3] = (i * 0.4301597090) % 1;
      rands[i * 3 + 0] = (i * 0.3247179572) % 1;
      rands[i * 3 + 1] = (i * 0.8191725134) % 1;
      rands[i * 3 + 2] = (i * 0.2451223338) % 1;
    }
    this.primaryGeo.setAttribute('aSeed', new T.InstancedBufferAttribute(seeds, 4));
    this.primaryGeo.setAttribute('aRand', new T.InstancedBufferAttribute(rands, 3));

    this.primaryMat = new T.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: T.DoubleSide,
      uniforms: {
        uTime: weather.uTime,
        uEye: { value: new T.Vector3() },
        uWindVec: weather.uWindVec,
        uMode: { value: 0 },
        uDay: { value: 1 },
        uIntensity: { value: 1 },
        uSunColor: { value: new T.Color('#fff5e4') },
        uFogColor: { value: new T.Color('#b8cde0') },
      },
      vertexShader: PRIMARY_PARTICLE_VERT,
      fragmentShader: PRIMARY_PARTICLE_FRAG,
    });

    this.primaryMesh = new T.InstancedMesh(this.primaryGeo, this.primaryMat, maxPrimary);
    this.primaryMesh.frustumCulled = false;
    this.primaryMesh.renderOrder = 4;
    this.primaryMesh.raycast = () => undefined;
    this.primaryMesh.visible = false;
    const identity = new T.Matrix4();
    for (let i = 0; i < maxPrimary; i++) this.primaryMesh.setMatrixAt(i, identity);
    this.primaryMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.primaryMesh);

    // ── Secondary Ground-Impact Rain Splash Mist Pool ──
    const maxSplash = TIER_SPLASH_COUNT.ultra;
    this.splashGeo = new T.PlaneGeometry(1, 1);

    const sSeeds = new Float32Array(maxSplash * 4);
    for (let i = 0; i < maxSplash; i++) {
      sSeeds[i * 4 + 0] = (i * 0.7548776662) % 1;
      sSeeds[i * 4 + 1] = (i * 0.3247179572) % 1;
      sSeeds[i * 4 + 2] = (i * 0.6180339887) % 1;
      sSeeds[i * 4 + 3] = (i * 0.5698402910) % 1;
    }
    this.splashGeo.setAttribute('aSeed', new T.InstancedBufferAttribute(sSeeds, 4));

    this.splashMat = new T.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: T.DoubleSide,
      uniforms: {
        uTime: weather.uTime,
        uEye: { value: new T.Vector3() },
        uGroundY: { value: groundY },
        uDay: { value: 1 },
        uIntensity: { value: 1 },
      },
      vertexShader: SPLASH_MIST_VERT,
      fragmentShader: SPLASH_MIST_FRAG,
    });

    this.splashMesh = new T.InstancedMesh(this.splashGeo, this.splashMat, maxSplash);
    this.splashMesh.frustumCulled = false;
    this.splashMesh.renderOrder = 3;
    this.splashMesh.raycast = () => undefined;
    this.splashMesh.visible = false;
    for (let i = 0; i < maxSplash; i++) this.splashMesh.setMatrixAt(i, identity);
    this.splashMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.splashMesh);

    this.setTier(tier);
  }

  setTier(tier: WeatherRenderTier): void {
    this.tier = tier;
    this.refreshCounts();
  }

  private refreshCounts(): void {
    const basePrimary = TIER_PRIMARY_COUNT[this.tier];
    // Petals and autumn leaves are sparser and more poetic than dense rainstorms.
    const modeScale = this.activeMode === 'petals' || this.activeMode === 'leaves' ? 0.22 : this.activeMode === 'snow' ? 0.65 : 1.0;
    this.primaryMesh.count = Math.max(0, Math.round(basePrimary * modeScale));
    this.splashMesh.count = TIER_SPLASH_COUNT[this.tier];
  }

  setState(state: WeatherParticleState): void {
    this.activeOutdoors = state.outdoors;
    this.activeReduced = state.reduced;
    const modeChanged = state.mode !== this.activeMode;
    this.activeMode = state.mode;

    const show = state.outdoors && !state.reduced && state.mode !== 'none' && state.intensity > 0.02;
    this.primaryMesh.visible = show;
    this.splashMesh.visible = show && state.mode === 'rain' && TIER_SPLASH_COUNT[this.tier] > 0;

    if (modeChanged) this.refreshCounts();

    const modeNum = state.mode === 'rain' ? 0 : state.mode === 'snow' ? 1 : state.mode === 'petals' ? 2 : 3;
    this.primaryMat.uniforms.uMode.value = modeNum;
    this.primaryMat.uniforms.uDay.value = state.day;
    this.primaryMat.uniforms.uIntensity.value = Math.max(0, Math.min(1.5, state.intensity));
    if (state.sunColor) this.primaryMat.uniforms.uSunColor.value.copy(state.sunColor);
    if (state.fogColor) this.primaryMat.uniforms.uFogColor.value.copy(state.fogColor);

    this.splashMat.uniforms.uDay.value = state.day;
    this.splashMat.uniforms.uIntensity.value = Math.max(0, Math.min(1.5, state.intensity));
    if (state.groundY !== undefined) this.splashMat.uniforms.uGroundY.value = state.groundY;
  }

  update(_dt: number, cameraLocalPos: T.Vector3, reduced: boolean): void {
    if (reduced !== this.activeReduced) {
      this.activeReduced = reduced;
      const show = this.activeOutdoors && !reduced && this.activeMode !== 'none';
      this.primaryMesh.visible = show;
      this.splashMesh.visible = show && this.activeMode === 'rain' && TIER_SPLASH_COUNT[this.tier] > 0;
    }
    if (this.primaryMesh.visible) {
      this.primaryMat.uniforms.uEye.value.copy(cameraLocalPos);
    }
    if (this.splashMesh.visible) {
      this.splashMat.uniforms.uEye.value.copy(cameraLocalPos);
    }
  }

  dispose(): void {
    this.primaryMesh.dispose();
    this.primaryGeo.dispose();
    this.primaryMat.dispose();
    this.splashMesh.dispose();
    this.splashGeo.dispose();
    this.splashMat.dispose();
    this.group.removeFromParent();
  }
}
