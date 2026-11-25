/**
 * Portions adapted from Abyssal Garden — Copyright (c) 2026 Maksymilian Dendura, MIT License
 *
 * Adapted cleanly to Three.js 0.186.1 WebGL2 (`GLSL 300 es` / `ShaderMaterial`) for Project ECHO ARCHIPELAGO.
 * Maintains ONE unified WebGL2 renderer and canvas with shared hardware DepthTexture and PCFShadowMap.
 */

import * as T from 'three';
import type { ArenaQualityTier, ArenaTimeOfDay } from './arenaContracts';
import { ARENA_WATER_Y } from './arenaTerrain';

export { ARENA_WATER_Y };

/**
 * Shared GLSL underwater spectral optics module (`UNDERWATER_OPTICS_GLSL`).
 * Models Beer-Lambert spectral extinction (`UW_SIG`), diffuse downwelling attenuation (`UW_KD`),
 * closed-form vertical in-scattering integral (`uwFogIn` with `1e-4` division-by-zero guard),
 * purple bioluminescent grotto blending, and chromatic dual-scale seabed caustics.
 */
export const UNDERWATER_OPTICS_GLSL = /* glsl */ `
const vec3 UW_SIG  = vec3(0.058, 0.0235, 0.0195);
const vec3 UW_KD   = vec3(0.056, 0.0245, 0.0170);
const vec3 UW_WCOL = vec3(0.068, 0.36,   0.64);
const vec3 UW_KDZ  = vec3(0.034, 0.023,  0.018);
const vec3 UW_PCOL = vec3(0.34,  0.40,   0.78);
const vec3 UW_SUNC = vec3(1.70,  1.60,   1.45);
const vec3 UW_KDF  = vec3(0.043, 0.045,  0.042);
const float UW_TAU = 6.28318530718;
const float WATER_Y = ${ARENA_WATER_Y.toFixed(4)};

float uwSat(float x) { return clamp(x, 0.0, 1.0); }
vec3 uwSat3(vec3 x) { return clamp(x, vec3(0.0), vec3(1.0)); }

float uwSS(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float uwIGN(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float uwHash1(float x) {
  return fract(sin(x * 127.1) * 43758.5453123);
}

vec3 uwKd(float z) {
  return mix(UW_KD, UW_KDZ, z);
}

vec3 uwSg(float z) {
  return mix(UW_SIG, vec3(0.034, 0.026, 0.022), z);
}

vec3 uwSafeHDR(vec3 c, float cap) {
  vec3 cl = clamp(c, vec3(0.0), vec3(cap));
  return cl;
}

vec3 uwQRot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

// Closed-form analytical integral of scattered sunlight along ray ro + t * rd for t in [0, d]:
// Integrates exp(-sg * t) * exp(k * (roSubY + rd.y * t)) dt with strict 1e-4 zero-division guard.
vec3 uwFogIn(vec3 ro, vec3 rd, float d, float z, vec3 sunDir) {
  vec3 k = mix(UW_KD, UW_KDF, z);
  vec3 sgz = uwSg(z);
  vec3 a = sgz - k * rd.y;
  vec3 safeA = vec3(
    abs(a.x) < 1e-4 ? 1e-4 : a.x,
    abs(a.y) < 1e-4 ? 1e-4 : a.y,
    abs(a.z) < 1e-4 ? 1e-4 : a.z
  );
  vec3 I = mix(vec3(d), (1.0 - exp(-safeA * d)) / safeA, step(vec3(1e-4), abs(a)));
  float mu = max(dot(rd, sunDir), 0.0);
  float m2 = mu * mu;
  float roSubY = min(ro.y - WATER_Y, 0.0) - 4.2;
  return mix(UW_WCOL, UW_PCOL, z) * sgz * exp(k * roSubY) * I * (1.16 + 0.32 * m2 * m2);
}

vec3 uwSunE(float worldY, float z, vec3 sunDir) {
  float subY = min(worldY - WATER_Y, 0.0);
  return UW_SUNC * exp(uwKd(z) * (subY / max(sunDir.y, 0.15))) * (0.5 + 0.5 * uwSat(-subY / 30.0));
}

vec3 uwAmb(vec3 p, vec3 n, float skyOpen, float z) {
  float subY = min(p.y - WATER_Y, 0.0);
  float up = n.y * 0.5 + 0.5;
  return mix(vec3(0.22, 0.60, 0.80), vec3(0.34, 0.56, 0.82), z)
       * exp(uwKd(z) * subY * 1.2)
       * (0.30 + 0.70 * skyOpen)
       * (0.24 + 0.76 * up * up) * 1.3
       * (0.55 + 0.45 * uwSat(-subY / 30.0))
       + vec3(0.003, 0.010, 0.016);
}

vec3 uwSide(vec3 p, vec3 n, float open, float z) {
  float subY = min(p.y - WATER_Y, 0.0);
  return mix(UW_WCOL, UW_PCOL, z) * exp(uwKd(z) * subY) * open * (1.0 - abs(n.y)) * 0.7;
}

vec3 uwApplyFog(vec3 c, vec3 wp, vec3 camPos, float z, vec3 sunDir, float farSky) {
  vec3 v = wp - camPos;
  float d = max(length(v), 1e-4);
  vec3 rd = v / d;
  return c * exp(-uwSg(z) * d) * uwSS(230.0, 185.0, d)
       + uwFogIn(camPos, rd, d, z, sunDir) * (0.58 + 0.42 * farSky);
}

vec2 uwCausticUV(vec3 p, vec3 sunDir) {
  float subY = p.y - WATER_Y;
  return p.xz - sunDir.xz * (subY / max(sunDir.y, 0.15));
}

// Chromatic 3-tap prismatic dispersion + cross-octave seabed caustics
vec3 uwCausticsRGB(sampler2D tWater, vec3 p, float dist, vec3 sunDir) {
  vec2 q = uwCausticUV(p, sunDir);
  vec2 o = vec2(0.004, 0.0025);
  vec3 a = vec3(
    texture(tWater, q / 3.3 + o).r,
    texture(tWater, q / 3.3).r,
    texture(tWater, q / 3.3 - o).r
  );
  float b = texture(tWater, q.yx / 6.9 + 0.37).r;
  vec3 c = min(pow(max(a, vec3(0.0)), vec3(2.3)) * 5.0 * (0.45 + b * 1.3), vec3(4.0));
  return mix(c, vec3(0.33), uwSS(35.0, 100.0, dist));
}

// Fast 2-tap scalar caustic for swaying kelp and seagrass fronds
float uwCausticsScalar(sampler2D tWater, vec3 p, float dist, vec3 sunDir) {
  vec2 q = uwCausticUV(p, sunDir);
  float r0 = max(texture(tWater, q / 4.1).r, 0.0);
  float r1 = texture(tWater, q.yx / 6.9 + 0.37).r;
  float c = min(pow(r0, 1.4) * 2.6 * (0.45 + r1 * 1.3), 2.6);
  return mix(c, 0.33, uwSS(35.0, 100.0, dist));
}

vec2 uwSway(vec2 xz, float h, float t) {
  float ph = dot(xz, vec2(0.031, 0.017));
  float a = 0.024 * pow(max(h, 0.0), 1.25);
  return a * (
    vec2(sin(t * 0.5 + ph + h * 0.09), cos(t * 0.37 + ph * 1.3 + h * 0.07)) +
    0.35 * vec2(sin(t * 1.3 + ph * 3.0 + h * 0.3), cos(t * 1.1 + ph * 2.0 + h * 0.23))
  );
}
`;

const UNDERWATER_SCENE_SAMPLERS_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunTint;
uniform float uGrottoBoost;
uniform float uQualityLevel; // 3 = ultra, 2 = high, 1 = balanced, 0 = low
uniform float uWidthScale;
uniform float uFarScale;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec4 uRepelPos; // xyz = swimmer/boat pos, w = radius

uniform sampler2D tWater;
uniform sampler2D tDetail;
uniform sampler2D tZoneMap;
uniform highp sampler2DShadow tShadow;
uniform mat4 uShadowMatrix;
uniform float uShadowTexel;
uniform float uShadowEnabled;

float uwZone(vec3 p) {
  vec4 zm = texture(tZoneMap, p.xz / 960.0 + 0.5);
  return clamp(mix(uGrottoBoost, zm.b, 0.65), 0.0, 1.0);
}

vec4 uwZoneSample(vec3 p) {
  return texture(tZoneMap, p.xz / 960.0 + 0.5);
}

// Analytical + zone-modulated underwater openness (r) and skylight (g)
vec2 uwOpenSky(vec3 p) {
  vec4 zm = uwZoneSample(p);
  float subDepth = max(0.0, WATER_Y - p.y);
  float canopyOcc = zm.g;
  float sky = clamp((1.0 - 0.52 * canopyOcc) * exp(-subDepth * 0.014), 0.14, 1.0);
  float open = clamp(0.88 - 0.36 * canopyOcc, 0.32, 1.0);
  return vec2(open, sky);
}

float uwShadow1(vec3 wp) {
  if (uShadowEnabled < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  vec3 s = sc.xyz / max(sc.w, 1e-5);
  if (s.x <= 0.002 || s.x >= 0.998 || s.y <= 0.002 || s.y >= 0.998 || s.z <= 0.0 || s.z >= 0.999) {
    return 1.0;
  }
  return texture(tShadow, vec3(s.xy, s.z - 0.0006));
}

float uwShadow4(vec3 wp) {
  if (uShadowEnabled < 0.5) return 1.0;
  if (uQualityLevel < 0.5) return uwShadow1(wp);
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  vec3 s = sc.xyz / max(sc.w, 1e-5);
  if (s.x <= 0.004 || s.x >= 0.996 || s.y <= 0.004 || s.y >= 0.996 || s.z <= 0.0 || s.z >= 0.999) {
    return 1.0;
  }
  float e = uShadowTexel * 1.4;
  float zRef = s.z - 0.00065;
  return 0.25 * (
    texture(tShadow, vec3(s.xy + vec2(-e, -e), zRef)) +
    texture(tShadow, vec3(s.xy + vec2( e, -e), zRef)) +
    texture(tShadow, vec3(s.xy + vec2(-e,  e), zRef)) +
    texture(tShadow, vec3(s.xy + vec2( e,  e), zRef))
  );
}

float uwShadow9(vec3 wp) {
  if (uShadowEnabled < 0.5) return 1.0;
  if (uQualityLevel < 1.5) return uwShadow1(wp);
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  vec3 s = sc.xyz / max(sc.w, 1e-5);
  if (s.x <= 0.005 || s.x >= 0.995 || s.y <= 0.005 || s.y >= 0.995 || s.z <= 0.0 || s.z >= 0.999) {
    return 1.0;
  }
  float e = uShadowTexel * 1.85;
  float zRef = s.z - 0.0007;
  float acc = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      acc += texture(tShadow, vec3(s.xy + vec2(float(x), float(y)) * e, zRef));
    }
  }
  return acc * (1.0 / 9.0);
}
`;

export function tierLevel(tier: ArenaQualityTier): number {
  switch (tier) {
    case 'ultra':
      return 3;
    case 'high':
      return 2;
    case 'balanced':
      return 1;
    case 'low':
      return 0;
  }
}

export function supportsRenderableHalfFloat(renderer: T.WebGLRenderer): boolean {
  if (!renderer.capabilities.isWebGL2) return false;
  return (
    renderer.extensions.has('EXT_color_buffer_float') ||
    renderer.extensions.has('EXT_color_buffer_half_float')
  );
}

function makeFullscreenTriangle(): T.BufferGeometry {
  const g = new T.BufferGeometry();
  const pos = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]);
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  return g;
}

const FULLSCREEN_VS = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ============================================================================
// 1. Tileable Animated Caustics + 10-Wave Surface Slope Pass (`W_WATER`)
// ============================================================================

const W_WATER_FS = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uWaterRes;

float calcCaustic(vec2 uv, float t) {
  vec2 p = uv * 6.28318530718;
  vec2 i = p;
  float c = 0.0;
  for (int n = 1; n <= 5; n++) {
    float tt = t * (1.0 - 3.5 / float(n));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    float s = sin(i.x + tt);
    float k = cos(i.y + tt);
    c += abs(s * k) / (1.25 * sqrt(s * s + k * k) + 1e-4);
  }
  c = 1.17 - pow(c / 5.0, 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 8.0);
}

const vec3 WK[10] = vec3[10](
  vec3( 1.0,  2.0, 1.00), vec3(-2.0,  1.0, 0.90), vec3( 3.0,  1.0, 0.60),
  vec3( 1.0, -4.0, 0.50), vec3( 4.0,  3.0, 0.40), vec3(-3.0,  5.0, 0.32),
  vec3( 6.0, -2.0, 0.28), vec3( 5.0,  7.0, 0.20), vec3(-8.0,  3.0, 0.18),
  vec3( 2.0, 11.0, 0.14)
);

uniform float uPackUnsigned; // 1.0 when UnsignedByteType fallback is active, 0.0 for HalfFloatType

void main() {
  vec2 uv = gl_FragCoord.xy / uWaterRes;
  float t = uTime;
  float c = calcCaustic(uv, t * 0.45 + 23.0);
  vec2 wu = uv + 0.02 * vec2(
    sin(6.28318530718 * (uv.y * 2.0 + 0.10 * t)),
    cos(6.28318530718 * (uv.x * 3.0 - 0.07 * t))
  );
  vec2 s = vec2(0.0);
  for (int i = 0; i < 10; i++) {
    vec3 k = WK[i];
    float dir = ((i & 1) == 0) ? 1.0 : -1.0;
    s += k.xy * k.z * cos(dot(k.xy, wu) * 6.28318530718 + t * (0.5 + 0.35 * sqrt(length(k.xy))) * dir + float(i) * 1.7);
  }
  vec2 slope = s * 0.06;
  if (uPackUnsigned > 0.5) {
    gl_FragColor = vec4(clamp(c * 0.5, 0.0, 1.0), clamp(c * 0.5, 0.0, 1.0), clamp(slope * 0.5 + 0.5, 0.0, 1.0));
  } else {
    gl_FragColor = vec4(c, c, slope);
  }
}
`;

export class CausticsSlopePass {
  private target: T.WebGLRenderTarget;
  private readonly scene = new T.Scene();
  private readonly camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quadGeo = makeFullscreenTriangle();
  private readonly material: T.ShaderMaterial;
  private tier: ArenaQualityTier;
  private useHalfFloat = true;
  private initializedWithRenderer = false;
  private hasRenderedOnce = false;
  private lastRenderTime = -100;

  constructor(initialTier: ArenaQualityTier = 'high') {
    this.tier = initialTier;
    const res = this.resolutionForTier(initialTier);
    this.target = this.createTarget(res, T.HalfFloatType);
    this.material = new T.ShaderMaterial({
      name: 'AbyssalCausticsSlopePass',
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uWaterRes: { value: res },
        uPackUnsigned: { value: 0 },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: W_WATER_FS,
    });
    const mesh = new T.Mesh(this.quadGeo, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  get texture(): T.Texture {
    return this.target.texture;
  }

  get isUnsignedFallback(): boolean {
    return !this.useHalfFloat;
  }

  private resolutionForTier(tier: ArenaQualityTier): number {
    return tier === 'ultra' || tier === 'high' ? 512 : 256;
  }

  private createTarget(res: number, type: T.TextureDataType): T.WebGLRenderTarget {
    const rt = new T.WebGLRenderTarget(res, res, {
      type,
      format: T.RGBAFormat,
      wrapS: T.RepeatWrapping,
      wrapT: T.RepeatWrapping,
      minFilter: T.LinearMipmapLinearFilter,
      magFilter: T.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.name = 'AbyssalWaterCausticsSlope';
    return rt;
  }

  setQuality(tier: ArenaQualityTier, onTextureChanged?: (tex: T.Texture) => void): void {
    if (this.tier === tier) return;
    const prevRes = this.resolutionForTier(this.tier);
    const nextRes = this.resolutionForTier(tier);
    this.tier = tier;
    if (prevRes !== nextRes) {
      const old = this.target;
      this.target = this.createTarget(nextRes, this.useHalfFloat ? T.HalfFloatType : T.UnsignedByteType);
      this.material.uniforms.uWaterRes.value = nextRes;
      this.hasRenderedOnce = false;
      old.dispose();
      onTextureChanged?.(this.target.texture);
    }
  }

  markNeedsRender(): void {
    this.hasRenderedOnce = false;
  }

  update(
    renderer: T.WebGLRenderer,
    time: number,
    cameraY: number,
    onTextureChanged?: (tex: T.Texture) => void,
  ): void {
    if (!this.initializedWithRenderer) {
      this.initializedWithRenderer = true;
      const canHalf = supportsRenderableHalfFloat(renderer);
      if (!canHalf && this.useHalfFloat) {
        this.useHalfFloat = false;
        this.material.uniforms.uPackUnsigned.value = 1;
        const res = this.resolutionForTier(this.tier);
        const old = this.target;
        this.target = this.createTarget(res, T.UnsignedByteType);
        old.dispose();
        onTextureChanged?.(this.target.texture);
      }
    }

    // Only update when near or in water (always render at least once on startup)
    const nearOrInWater = cameraY <= ARENA_WATER_Y + 28.0;
    if (this.hasRenderedOnce && !nearOrInWater) return;

    // Throttle on low tier to 30 Hz when above water
    const minInterval = this.tier === 'low' ? 1 / 30 : 0;
    if (this.hasRenderedOnce && minInterval > 0 && time - this.lastRenderTime < minInterval) {
      return;
    }

    this.lastRenderTime = time;
    this.hasRenderedOnce = true;
    this.material.uniforms.uTime.value = time;

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevAutoClear = renderer.autoClear;
    const prevAutoReset = renderer.info.autoReset;
    renderer.xr.enabled = false;
    renderer.autoClear = true;
    renderer.info.autoReset = false;
    try {
      renderer.setRenderTarget(this.target);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
      renderer.xr.enabled = prevXr;
      renderer.info.autoReset = prevAutoReset;
    }
  }

  dispose(): void {
    this.target.dispose();
    this.quadGeo.dispose();
    this.material.dispose();
  }
}

// ============================================================================
// 2. Startup-Baked Tileable `1024×1024` Rock Detail Map (`W_DETAIL`)
// ============================================================================

const W_DETAIL_FS = /* glsl */ `
precision highp float;
uniform float uDetailRes;

float detSS(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float h31(vec3 p) {
  vec3 q = fract(p * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 h33(vec3 p) {
  vec3 q = fract(p * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}

float hp(vec2 p, float per) {
  return h31(vec3(p - per * floor(p / per), per));
}

float tn(vec2 p, float per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hp(i, per), hp(i + vec2(1.0, 0.0), per), u.x),
    mix(hp(i + vec2(0.0, 1.0), per), hp(i + vec2(1.0, 1.0), per), u.x),
    u.y
  );
}

float tf(vec2 uv, float per, int n) {
  float a = 0.5;
  float s = 0.0;
  float pr = per;
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    s += a * tn(uv * pr + float(i) * 7.3, pr);
    pr *= 2.0;
    a *= 0.5;
  }
  return s / (1.0 - 2.0 * a);
}

vec3 tw(vec2 p, float per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 d = vec2(9.0);
  float id = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      vec2 o = vec2(float(x), float(y));
      vec2 c = i + o;
      vec2 cw = c - per * floor(c / per);
      vec3 hh = h33(vec3(cw, per));
      vec2 r = o + hh.xy - f;
      float l = dot(r, r);
      if (l < d.x) {
        d.y = d.x;
        d.x = l;
        id = hh.z;
      } else if (l < d.y) {
        d.y = l;
      }
    }
  }
  return vec3(sqrt(d), id);
}

float detailHeight(vec2 uv) {
  vec2 wq = uv + 0.11 * (vec2(tf(uv, 3.0, 4), tf(uv + 0.5, 3.0, 4)) - 0.5);
  float f = tf(wq, 3.0, 8);
  float r1 = 1.0 - abs(tf(wq + 1.7, 5.0, 6) * 2.0 - 1.0);
  float cr = min(abs(tf(wq + 4.1, 4.0, 5) * 2.0 - 1.0) * 7.0, 1.0);
  float cr2 = min(abs(tf(wq.yx + 2.3, 9.0, 4) * 2.0 - 1.0) * 9.0, 1.0);
  vec3 pt = tw(wq * 29.0, 29.0);
  float pit = (1.0 - detSS(0.0, 0.34, pt.x)) * step(0.62, pt.z);
  return f * 0.50 + r1 * r1 * 0.24 + cr * cr2 * 0.26 - pit * 0.07;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uDetailRes;
  float e = 1.0 / uDetailRes;
  float h = detailHeight(uv);
  float gx = detailHeight(uv + vec2(e, 0.0)) - detailHeight(uv - vec2(e, 0.0));
  float gy = detailHeight(uv + vec2(0.0, e)) - detailHeight(uv - vec2(0.0, e));
  vec2 s = clamp(vec2(gx, gy) * uDetailRes * 0.5 * 0.075, vec2(-1.0), vec2(1.0));
  gl_FragColor = vec4(-s * 0.5 + 0.5, clamp(h, 0.0, 1.0), clamp(tf(uv + 3.7, 3.0, 5), 0.0, 1.0));
}
`;

export class RockDetailBaker {
  private target: T.WebGLRenderTarget;
  private readonly scene = new T.Scene();
  private readonly camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quadGeo = makeFullscreenTriangle();
  private readonly material: T.ShaderMaterial;
  private baked = false;
  private tier: ArenaQualityTier;

  constructor(initialTier: ArenaQualityTier = 'high') {
    this.tier = initialTier;
    const res = this.resForTier(initialTier);
    this.target = this.createTarget(res, initialTier);
    this.material = new T.ShaderMaterial({
      name: 'AbyssalRockDetailBaker',
      depthTest: false,
      depthWrite: false,
      uniforms: { uDetailRes: { value: res } },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: W_DETAIL_FS,
    });
    const mesh = new T.Mesh(this.quadGeo, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  get texture(): T.Texture {
    return this.target.texture;
  }

  private resForTier(tier: ArenaQualityTier): number {
    if (tier === 'ultra' || tier === 'high') return 1024;
    if (tier === 'balanced') return 512;
    return 256;
  }

  private createTarget(res: number, tier: ArenaQualityTier): T.WebGLRenderTarget {
    const rt = new T.WebGLRenderTarget(res, res, {
      type: T.UnsignedByteType,
      format: T.RGBAFormat,
      wrapS: T.RepeatWrapping,
      wrapT: T.RepeatWrapping,
      minFilter: T.LinearMipmapLinearFilter,
      magFilter: T.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.anisotropy = tier === 'low' ? 1 : tier === 'balanced' ? 4 : 8;
    rt.texture.name = 'AbyssalRockDetailMap';
    return rt;
  }

  setQuality(tier: ArenaQualityTier): void {
    this.tier = tier;
    this.target.texture.anisotropy = tier === 'low' ? 1 : tier === 'balanced' ? 4 : 8;
  }

  invalidate(): void {
    this.baked = false;
  }

  ensureBaked(renderer: T.WebGLRenderer): void {
    if (this.baked) return;
    this.baked = true;
    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevAutoReset = renderer.info.autoReset;
    renderer.xr.enabled = false;
    renderer.info.autoReset = false;
    try {
      renderer.setRenderTarget(this.target);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.xr.enabled = prevXr;
      renderer.info.autoReset = prevAutoReset;
    }
  }

  dispose(): void {
    this.target.dispose();
    this.quadGeo.dispose();
    this.material.dispose();
  }
}

// ============================================================================
// 3. Half-Resolution Volumetric Sunbeams (`W_RAYS` + `W_RBLUR` + `2×2` Upsample)
// ============================================================================

function buildRaysFragmentShader(raySteps: number): string {
  return /* glsl */ `
precision highp float;
#include <packing>
${UNDERWATER_OPTICS_GLSL}

uniform sampler2D tDepth;
uniform sampler2D tWater;
uniform sampler2D tZoneMap;
uniform highp sampler2DShadow tShadow;
uniform mat4 uShadowMatrix;
uniform float uShadowEnabled;

uniform vec3 uCamPos;
uniform vec3 uCamFwd;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uTanHalfFovY;
uniform float uAspect;
uniform float uNear;
uniform float uFar;
uniform vec3 uSunDir;
uniform float uGrottoBoost;
uniform float uRayIntensity;
uniform vec2 uRayInvRes;

void main() {
  vec2 uv = gl_FragCoord.xy * uRayInvRes;
  float rawDepth = texture(tDepth, uv).r;
  float viewZ = perspectiveDepthToViewZ(rawDepth, uNear, uFar);
  float linearZ = clamp(-viewZ, uNear, uFar);

  vec2 ndc = uv * 2.0 - 1.0;
  vec3 rv = uCamFwd
          + uCamRight * (ndc.x * uTanHalfFovY * uAspect)
          + uCamUp    * (ndc.y * uTanHalfFovY);
  float rl = max(length(rv), 1e-4);
  vec3 rd = rv / rl;

  float tm = min(linearZ * rl, 120.0);
  if (rd.y > 1e-4 && uCamPos.y < WATER_Y) {
    tm = min(tm, max(0.0, (WATER_Y - uCamPos.y) / rd.y));
  }
  if (tm <= 0.02) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, linearZ);
    return;
  }

  float z = clamp(mix(uGrottoBoost, texture(tZoneMap, uCamPos.xz / 960.0 + 0.5).b, 0.5), 0.0, 1.0);
  vec3 sx = uSunDir;
  vec3 k = uwKd(z);
  vec3 sgz = uwSg(z);
  float dt = tm / float(${raySteps});
  float j = uwIGN(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);

  for (int n = 0; n < ${raySteps}; n++) {
    float t = (float(n) + j) * dt;
    vec3 p = uCamPos + rd * t;
    float subY = min(p.y - WATER_Y, 0.0);

    float vis = 1.0;
    if (uShadowEnabled > 0.5) {
      vec4 sc = uShadowMatrix * vec4(p, 1.0);
      vec3 s = sc.xyz / max(sc.w, 1e-5);
      if (s.x > 0.002 && s.x < 0.998 && s.y > 0.002 && s.y < 0.998 && s.z > 0.0 && s.z < 0.999) {
        vis = texture(tShadow, vec3(s.xy, s.z - 0.0006));
      }
    }

    vec2 q = p.xz - sx.xz * (subY / max(sx.y, 0.15));
    float pat = uwSS(0.30, 0.70, textureLod(tWater, q / 27.0, 2.5).r)
              * uwSS(0.15, 0.60, textureLod(tWater, q.yx / 11.0 + 0.3, 2.0).r);
    float canopy = texture(tZoneMap, p.xz / 960.0 + 0.5).g;
    float mist = uwSat(0.35 + 0.65 * canopy);
    acc += exp(-sgz * t + k * (subY / max(sx.y, 0.15)))
         * (vis * (0.012 + pat * 6.0) * (1.0 + 1.2 * mist * mist));
  }

  float mu = max(dot(rd, sx), 0.0);
  float ph = mix(0.2 + 2.0 * mu * mu * mu, 0.8, z);
  vec3 wc = mix(UW_WCOL + vec3(0.04, 0.07, 0.05), UW_PCOL + vec3(0.28, 0.16, 0.12), z);
  vec3 shaftRGB = acc * dt * sgz * wc * UW_SUNC * ph * uRayIntensity * (1.0 - 0.55 * z);
  // Strict HDR NaN/Inf clamp required by Wave 11 / Stage C:
  shaftRGB = min(max(shaftRGB, vec3(0.0)), vec3(16.0));
  gl_FragColor = vec4(shaftRGB, linearZ);
}
`;
}

const W_RBLUR_FS = /* glsl */ `
precision highp float;
uniform sampler2D tRays;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 mx = textureSize(tRays, 0) - ivec2(1);
  vec4 c = texelFetch(tRays, clamp(p, ivec2(0), mx), 0);
  float centerDepth = max(c.a, 1e-3);
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec4 r = texelFetch(tRays, clamp(p + ivec2(x, y), ivec2(0), mx), 0);
      float w = 1.0 / (0.03 + abs(r.a - centerDepth) / centerDepth);
      acc += r.rgb * w;
      ws += w;
    }
  }
  vec3 blurred = min(max(acc / max(ws, 1e-4), vec3(0.0)), vec3(16.0));
  gl_FragColor = vec4(blurred, centerDepth);
}
`;

const W_RAY_UPSAMPLE_FS = /* glsl */ `
precision highp float;
#include <packing>

uniform sampler2D tRayBlur;
uniform sampler2D tDepth;
uniform sampler2D tSceneColor;
uniform float uHasSceneColor;
uniform float uNear;
uniform float uFar;
uniform vec2 uFullInvRes;
uniform float uSubmergeFade;
uniform vec2 uDownscale; // exact (rayWidth / fullWidth, rayHeight / fullHeight)

void main() {
  vec2 uv = gl_FragCoord.xy * uFullInvRes;
  float rawDepth = texture(tDepth, uv).r;
  float zf = max(-perspectiveDepthToViewZ(rawDepth, uNear, uFar), 1e-3);

  vec2 h = gl_FragCoord.xy * uDownscale - 0.5;
  vec2 b = floor(h);
  vec2 f = h - b;
  ivec2 bi = ivec2(b);
  ivec2 mx = textureSize(tRayBlur, 0) - ivec2(1);

  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    vec4 r = texelFetch(tRayBlur, clamp(bi + o, ivec2(0), mx), 0);
    float bw = mix(1.0 - f.x, f.x, float(o.x)) * mix(1.0 - f.y, f.y, float(o.y));
    float w = (bw + 0.02) / (0.02 + abs(r.a - zf) / zf);
    acc += r.rgb * w;
    ws += w;
  }

  vec3 shaftRGB = min(max((acc / max(ws, 1e-4)) * uSubmergeFade, vec3(0.0)), vec3(16.0));
  if (uHasSceneColor > 0.5) {
    vec3 base = texture(tSceneColor, uv).rgb;
    gl_FragColor = vec4(min(base + shaftRGB, vec3(32.0)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  } else {
    gl_FragColor = vec4(shaftRGB, 0.0);
  }
}
`;

export class UnderwaterGodRaysPass {
  private tRays: T.WebGLRenderTarget;
  private tRayBlur: T.WebGLRenderTarget;
  private sceneCaptureRT: T.WebGLRenderTarget | null = null;
  private readonly quadGeo = makeFullscreenTriangle();
  private readonly passScene = new T.Scene();
  private readonly passCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly passMesh: T.Mesh;

  private readonly rayMaterials = new Map<number, T.ShaderMaterial>();
  private readonly blurMaterial: T.ShaderMaterial;
  private readonly upsampleOverlayMaterial: T.ShaderMaterial;
  private readonly upsampleCompositeMaterial: T.ShaderMaterial;

  private tier: ArenaQualityTier;
  private rtType: T.TextureDataType = T.HalfFloatType;
  private probed = false;
  private fullWidth = 0;
  private fullHeight = 0;

  private readonly camFwd = new T.Vector3();
  private readonly camRight = new T.Vector3();
  private readonly camUp = new T.Vector3();
  private readonly drawSize = new T.Vector2();

  constructor(
    initialTier: ArenaQualityTier,
    waterCausticsTex: T.Texture,
    zoneMapTex: T.Texture,
    fallbackShadowTex: T.DepthTexture,
  ) {
    this.tier = initialTier;
    this.tRays = this.makeRayTarget(2, 2, T.HalfFloatType);
    this.tRayBlur = this.makeRayTarget(2, 2, T.HalfFloatType);

    for (const steps of [34, 26, 18, 10]) {
      this.rayMaterials.set(
        steps,
        new T.ShaderMaterial({
          name: `AbyssalGodRays_${steps}`,
          depthTest: false,
          depthWrite: false,
          uniforms: {
            tDepth: { value: null },
            tWater: { value: waterCausticsTex },
            tZoneMap: { value: zoneMapTex },
            tShadow: { value: fallbackShadowTex },
            uShadowMatrix: { value: new T.Matrix4() },
            uShadowEnabled: { value: 0 },
            uCamPos: { value: new T.Vector3() },
            uCamFwd: { value: new T.Vector3(0, 0, -1) },
            uCamRight: { value: new T.Vector3(1, 0, 0) },
            uCamUp: { value: new T.Vector3(0, 1, 0) },
            uTanHalfFovY: { value: 0.5 },
            uAspect: { value: 1.6 },
            uNear: { value: 0.1 },
            uFar: { value: 600 },
            uSunDir: { value: new T.Vector3(-0.58, 0.75, 0.40).normalize() },
            uGrottoBoost: { value: 0 },
            uRayIntensity: { value: 0.42 },
            uRayInvRes: { value: new T.Vector2(0.5, 0.5) },
          },
          vertexShader: FULLSCREEN_VS,
          fragmentShader: buildRaysFragmentShader(steps),
        }),
      );
    }

    this.blurMaterial = new T.ShaderMaterial({
      name: 'AbyssalGodRaysBilateralBlur',
      depthTest: false,
      depthWrite: false,
      uniforms: { tRays: { value: this.tRays.texture } },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: W_RBLUR_FS,
    });

    this.upsampleOverlayMaterial = new T.ShaderMaterial({
      name: 'AbyssalGodRaysOverlayUpsample',
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: T.AdditiveBlending,
      uniforms: {
        tRayBlur: { value: this.tRayBlur.texture },
        tDepth: { value: null },
        tSceneColor: { value: null },
        uHasSceneColor: { value: 0 },
        uNear: { value: 0.1 },
        uFar: { value: 600 },
        uFullInvRes: { value: new T.Vector2(1 / 1280, 1 / 720) },
        uSubmergeFade: { value: 1 },
        uDownscale: { value: new T.Vector2(0.5, 0.5) },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: W_RAY_UPSAMPLE_FS,
    });

    this.upsampleCompositeMaterial = new T.ShaderMaterial({
      name: 'AbyssalGodRaysSceneComposite',
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
      uniforms: {
        tRayBlur: { value: this.tRayBlur.texture },
        tDepth: { value: null },
        tSceneColor: { value: null },
        uHasSceneColor: { value: 1 },
        uNear: { value: 0.1 },
        uFar: { value: 600 },
        uFullInvRes: { value: new T.Vector2(1 / 1280, 1 / 720) },
        uSubmergeFade: { value: 1 },
        uDownscale: { value: new T.Vector2(0.5, 0.5) },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: W_RAY_UPSAMPLE_FS,
    });

    this.passMesh = new T.Mesh(this.quadGeo, this.blurMaterial);
    this.passMesh.frustumCulled = false;
    this.passScene.add(this.passMesh);
  }

  private makeRayTarget(w: number, h: number, type: T.TextureDataType): T.WebGLRenderTarget {
    const rt = new T.WebGLRenderTarget(w, h, {
      type,
      format: T.RGBAFormat,
      minFilter: T.NearestFilter,
      magFilter: T.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    return rt;
  }

  private stepsForTier(tier: ArenaQualityTier): number {
    if (tier === 'ultra') return 34;
    if (tier === 'high') return 26;
    if (tier === 'balanced') return 18;
    return 10;
  }

  private scaleForTier(tier: ArenaQualityTier): number {
    if (tier === 'low') return 0.25;
    if (tier === 'balanced') return 0.38;
    return 0.5;
  }

  /** Zero GPU cost when camera is on dry land (`camera.position.y > ARENA_WATER_Y + 0.8`). */
  isActive(camera: T.Camera): boolean {
    return camera.position.y <= ARENA_WATER_Y + 0.8;
  }

  setQuality(tier: ArenaQualityTier): void {
    if (this.tier === tier) return;
    this.tier = tier;
    this.fullWidth = 0; // triggers clean resize on next active frame
  }

  setWaterTexture(tex: T.Texture): void {
    for (const mat of this.rayMaterials.values()) {
      mat.uniforms.tWater.value = tex;
    }
  }

  private ensureTargets(renderer: T.WebGLRenderer, needSceneCapture: boolean): void {
    if (!this.probed) {
      this.probed = true;
      this.rtType = supportsRenderableHalfFloat(renderer) ? T.HalfFloatType : T.UnsignedByteType;
    }
    renderer.getDrawingBufferSize(this.drawSize);
    const fw = Math.max(2, Math.floor(this.drawSize.x));
    const fh = Math.max(2, Math.floor(this.drawSize.y));
    const scale = this.scaleForTier(this.tier);
    const rw = Math.max(2, Math.floor(fw * scale));
    const rh = Math.max(2, Math.floor(fh * scale));

    if (fw !== this.fullWidth || fh !== this.fullHeight || this.tRays.width !== rw || this.tRays.height !== rh) {
      this.fullWidth = fw;
      this.fullHeight = fh;
      this.tRays.dispose();
      this.tRayBlur.dispose();
      this.tRays = this.makeRayTarget(rw, rh, this.rtType);
      this.tRayBlur = this.makeRayTarget(rw, rh, this.rtType);
      this.blurMaterial.uniforms.tRays.value = this.tRays.texture;
      this.upsampleOverlayMaterial.uniforms.tRayBlur.value = this.tRayBlur.texture;
      this.upsampleCompositeMaterial.uniforms.tRayBlur.value = this.tRayBlur.texture;
    }

    if (needSceneCapture) {
      if (!this.sceneCaptureRT || this.sceneCaptureRT.width !== fw || this.sceneCaptureRT.height !== fh) {
        if (this.sceneCaptureRT) {
          this.sceneCaptureRT.depthTexture?.dispose();
          this.sceneCaptureRT.dispose();
        }
        const depthTex = new T.DepthTexture(fw, fh, T.UnsignedIntType);
        depthTex.format = T.DepthFormat;
        depthTex.minFilter = T.NearestFilter;
        depthTex.magFilter = T.NearestFilter;
        this.sceneCaptureRT = new T.WebGLRenderTarget(fw, fh, {
          type: this.rtType,
          format: T.RGBAFormat,
          minFilter: T.LinearFilter,
          magFilter: T.LinearFilter,
          depthBuffer: true,
          stencilBuffer: false,
          depthTexture: depthTex,
        });
      }
    }
  }

  private runShaftAndBlurPasses(
    renderer: T.WebGLRenderer,
    camera: T.PerspectiveCamera,
    depthTexture: T.Texture,
    sunDir: T.Vector3,
    shadowTex: T.Texture,
    shadowMatrix: T.Matrix4,
    shadowEnabled: boolean,
    grottoBoost: number,
  ): number {
    const rawT = T.MathUtils.clamp((ARENA_WATER_Y + 0.8 - camera.position.y) / 1.1, 0, 1);
    const submergeFade = rawT * rawT * (3 - 2 * rawT);
    const steps = this.stepsForTier(this.tier);
    const rayMat = this.rayMaterials.get(steps)!;

    camera.matrixWorld.extractBasis(this.camRight, this.camUp, this.camFwd);
    this.camFwd.negate().normalize();
    this.camRight.normalize();
    this.camUp.normalize();

    const u = rayMat.uniforms;
    u.tDepth.value = depthTexture;
    u.tShadow.value = shadowTex;
    (u.uShadowMatrix.value as T.Matrix4).copy(shadowMatrix);
    u.uShadowEnabled.value = shadowEnabled ? 1 : 0;
    (u.uCamPos.value as T.Vector3).copy(camera.position);
    (u.uCamFwd.value as T.Vector3).copy(this.camFwd);
    (u.uCamRight.value as T.Vector3).copy(this.camRight);
    (u.uCamUp.value as T.Vector3).copy(this.camUp);
    u.uTanHalfFovY.value = Math.tan(T.MathUtils.degToRad(camera.fov * 0.5));
    u.uAspect.value = camera.aspect;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    (u.uSunDir.value as T.Vector3).copy(sunDir);
    u.uGrottoBoost.value = grottoBoost;
    u.uRayInvRes.value.set(1 / this.tRays.width, 1 / this.tRays.height);

    this.passMesh.material = rayMat;
    renderer.setRenderTarget(this.tRays);
    renderer.render(this.passScene, this.passCam);

    this.passMesh.material = this.blurMaterial;
    renderer.setRenderTarget(this.tRayBlur);
    renderer.render(this.passScene, this.passCam);

    return submergeFade;
  }

  /**
   * Renders half-res shafts + `3×3` bilateral depth blur, then additively upsamples (`2×2` bilateral)
   * onto the currently bound render target (`null` screen or postprocessing buffer).
   * Costs `0 ms` when `camera.position.y > ARENA_WATER_Y + 0.8`.
   */
  renderOverlay(
    renderer: T.WebGLRenderer,
    camera: T.PerspectiveCamera,
    depthTexture: T.Texture,
    sunDir: T.Vector3,
    shadowTex: T.Texture,
    shadowMatrix: T.Matrix4,
    shadowEnabled: boolean,
    grottoBoost = 0,
  ): void {
    if (!this.isActive(camera)) return;
    this.ensureTargets(renderer, false);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevXr = renderer.xr.enabled;
    const prevAutoReset = renderer.info.autoReset;
    renderer.xr.enabled = false;
    renderer.autoClear = true;
    renderer.info.autoReset = false;

    try {
      const fade = this.runShaftAndBlurPasses(
        renderer,
        camera,
        depthTexture,
        sunDir,
        shadowTex,
        shadowMatrix,
        shadowEnabled,
        grottoBoost,
      );

      const up = this.upsampleOverlayMaterial.uniforms;
      up.tDepth.value = depthTexture;
      up.uNear.value = camera.near;
      up.uFar.value = camera.far;
      up.uFullInvRes.value.set(1 / this.fullWidth, 1 / this.fullHeight);
      up.uSubmergeFade.value = fade;
      (up.uDownscale.value as T.Vector2).set(
        this.tRays.width / Math.max(1, this.fullWidth),
        this.tRays.height / Math.max(1, this.fullHeight),
      );

      this.passMesh.material = this.upsampleOverlayMaterial;
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = false;
      renderer.render(this.passScene, this.passCam);
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.xr.enabled = prevXr;
      renderer.info.autoReset = prevAutoReset;
    }
  }

  /**
   * Convenience single-renderer helper when the caller does not maintain its own scene `DepthTexture`:
   * renders `scene` directly to screen on dry land (`0` extra RT overhead!), and automatically captures
   * scene color + hardware `DepthTexture` + volumetric shafts when near/under water while accumulating
   * true scene + post-pass draw/triangle counts on `renderer.info.render`.
   */
  renderSceneWithGodRays(
    renderer: T.WebGLRenderer,
    scene: T.Scene,
    camera: T.PerspectiveCamera,
    sunDir: T.Vector3,
    shadowTex: T.Texture,
    shadowMatrix: T.Matrix4,
    shadowEnabled: boolean,
    grottoBoost = 0,
  ): void {
    if (!this.isActive(camera)) {
      renderer.render(scene, camera);
      return;
    }
    this.ensureTargets(renderer, true);
    const capture = this.sceneCaptureRT!;
    const prevTarget = renderer.getRenderTarget();
    const prevToneMapping = renderer.toneMapping;
    const prevAutoClear = renderer.autoClear;
    const prevAutoReset = renderer.info.autoReset;
    if (prevAutoReset) {
      renderer.info.reset();
    }
    renderer.info.autoReset = false;

    try {
      // Render linear HDR scene into `sceneCaptureRT`
      renderer.toneMapping = T.NoToneMapping;
      renderer.setRenderTarget(capture);
      renderer.autoClear = true;
      renderer.render(scene, camera);

      const fade = this.runShaftAndBlurPasses(
        renderer,
        camera,
        capture.depthTexture!,
        sunDir,
        shadowTex,
        shadowMatrix,
        shadowEnabled,
        grottoBoost,
      );

      // Restore renderer toneMapping for final composite to screen
      renderer.toneMapping = prevToneMapping;
      const up = this.upsampleCompositeMaterial.uniforms;
      up.tSceneColor.value = capture.texture;
      up.tDepth.value = capture.depthTexture;
      up.uNear.value = camera.near;
      up.uFar.value = camera.far;
      up.uFullInvRes.value.set(1 / this.fullWidth, 1 / this.fullHeight);
      up.uSubmergeFade.value = fade;
      (up.uDownscale.value as T.Vector2).set(
        this.tRays.width / Math.max(1, this.fullWidth),
        this.tRays.height / Math.max(1, this.fullHeight),
      );

      this.passMesh.material = this.upsampleCompositeMaterial;
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = true;
      renderer.render(this.passScene, this.passCam);
    } finally {
      renderer.toneMapping = prevToneMapping;
      renderer.autoClear = prevAutoClear;
      renderer.info.autoReset = prevAutoReset;
    }
  }

  /**
   * Pre-allocates full-res `sceneCaptureRT` (`HalfFloat` + `DepthTexture`) and half-res `tRays`/`tRayBlur`
   * targets upfront, places a temporary submerged reef camera at `(18, WATER_Y - 6.0, 326)` pitched `+18°`
   * upward through Snell's window, compiles ALL main-scene shaders in the exact submerged
   * `NoToneMapping + Linear RT` state (`compileAsync` + `1x1` scissored draw), and warms ALL `[34, 26, 18, 10]`
   * `AbyssalGodRays_*` step variants + `BilateralBlur` + `SceneComposite` + `OverlayUpsample` with live
   * shadow depth so first water entry and runtime quality switches hit `programDelta === 0`!
   */
  async warmupSubmergedPipeline(
    renderer: T.WebGLRenderer,
    scene: T.Scene,
    camera: T.Camera,
    yieldFn?: () => Promise<void>,
    aborted?: () => boolean,
    onPrepareSubmergedCamera?: (submergedCam: T.Camera) => void,
  ): Promise<void> {
    if (aborted?.()) return;
    const gl = typeof renderer.getContext === 'function' ? renderer.getContext() : null;
    if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) return;

    this.ensureTargets(renderer, true);
    const capture = this.sceneCaptureRT;
    if (!capture || !capture.depthTexture) return;

    const prevTarget = renderer.getRenderTarget();
    const prevToneMapping = renderer.toneMapping;
    const prevAutoClear = renderer.autoClear;
    const prevAutoReset = renderer.info.autoReset;
    const prevXr = renderer.xr.enabled;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    const prevViewport = new T.Vector4();
    const prevScissor = new T.Vector4();
    const prevScissorTest = renderer.getScissorTest();
    renderer.getViewport(prevViewport);
    renderer.getScissor(prevScissor);

    const savedCamPos = camera.position.clone();
    const savedCamQuat = camera.quaternion.clone();
    const savedCamScale = camera.scale.clone();
    const savedCamMatrix = camera.matrix.clone();
    const savedCamMatrixWorld = camera.matrixWorld.clone();
    const savedCamMatrixWorldInv = camera.matrixWorldInverse.clone();

    const savedCaptureScissor = capture.scissor.clone();
    const savedCaptureScissorTest = capture.scissorTest;
    const savedRaysScissor = this.tRays.scissor.clone();
    const savedRaysScissorTest = this.tRays.scissorTest;
    const savedBlurScissor = this.tRayBlur.scissor.clone();
    const savedBlurScissorTest = this.tRayBlur.scissorTest;

    const maybeAsync = renderer as T.WebGLRenderer & {
      compileAsync?: (s: T.Object3D, c: T.Camera, targetScene?: T.Scene) => Promise<unknown>;
    };
    const compileTarget = async (root: T.Object3D, cam: T.Camera, targetScene: T.Scene) => {
      if (typeof maybeAsync.compileAsync === 'function') {
        await maybeAsync.compileAsync(root, cam, targetScene);
      } else {
        renderer.compile(root, cam, targetScene);
      }
    };

    try {
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.autoClear = true;
      renderer.info.autoReset = false;

      // Place camera in Coral Lagoon reef at (18, WATER_Y - 6.0, 326) pitched +18 deg upward
      // toward Snell's window so W_SNOW, W_GLINT, W_BUBBLE (< 135 m), W_SOLID/W_LEAF submerged
      // branches, and ocean underside TIR (!gl_FrontFacing) all execute non-trivial paths!
      camera.position.set(18, ARENA_WATER_Y - 6.0, 326);
      camera.lookAt(18, ARENA_WATER_Y - 2.1, 314);
      camera.updateMatrixWorld(true);

      const syncCb =
        onPrepareSubmergedCamera ??
        (scene.userData as { __ecArenaSyncShadow?: (c: T.Camera) => void }).__ecArenaSyncShadow;
      syncCb?.(camera);

      // Pass A: Precompile & 1x1 draw-link every main-scene material in `NoToneMapping + Linear HalfFloat RT` state.
      renderer.toneMapping = T.NoToneMapping;
      renderer.setRenderTarget(capture);
      await compileTarget(scene, camera, scene);
      if (aborted?.()) return;
      if (yieldFn) {
        await yieldFn();
        if (aborted?.()) return;
      }

      // Three.js r186 applies `rt.scissor` / `rt.scissorTest` inside `setRenderTarget(rt)`.
      capture.scissor.set(0, 0, 1, 1);
      capture.scissorTest = true;
      renderer.toneMapping = T.NoToneMapping;
      renderer.setRenderTarget(capture);
      renderer.render(scene, camera);

      // Clear full capture buffer (depth -> 1.0) before sampling `capture.depthTexture` in god-rays pass.
      capture.scissorTest = false;
      renderer.setRenderTarget(capture);
      renderer.clear(true, true, true);

      if (yieldFn) {
        await yieldFn();
        if (aborted?.()) return;
      }

      // Pass B: Warm private `passScene` across ALL `[34, 26, 18, 10]` `AbyssalGodRays_*` step variants,
      // `BilateralBlur`, `SceneComposite`, and `OverlayUpsample`.
      const perspCam = (camera as T.PerspectiveCamera).isPerspectiveCamera ? (camera as T.PerspectiveCamera) : null;
      const near = perspCam ? perspCam.near : 0.1;
      const far = perspCam ? perspCam.far : 600;
      const aspect = perspCam ? Math.max(0.5, perspCam.aspect) : 1.6;
      const tanHalfFovY = perspCam ? Math.tan(T.MathUtils.degToRad(perspCam.fov * 0.5)) : 0.5;

      camera.matrixWorld.extractBasis(this.camRight, this.camUp, this.camFwd);
      this.camFwd.negate().normalize();
      this.camRight.normalize();
      this.camUp.normalize();

      const sharedShadowInfo = (scene.userData as {
        __ecArenaShadowState?: { depthTex: T.Texture | null; matrix: T.Matrix4 | null; enabled: boolean };
      }).__ecArenaShadowState;

      // 1. Half-res volumetric god rays (`tRays`, linear NoToneMapping) — warm every tier step variant!
      this.tRays.scissor.set(0, 0, 1, 1);
      this.tRays.scissorTest = true;
      renderer.toneMapping = T.NoToneMapping;
      renderer.setRenderTarget(this.tRays);

      for (const rayMat of this.rayMaterials.values()) {
        const ru = rayMat.uniforms;
        ru.tDepth.value = capture.depthTexture;
        if (sharedShadowInfo?.depthTex && sharedShadowInfo.matrix) {
          ru.tShadow.value = sharedShadowInfo.depthTex;
          (ru.uShadowMatrix.value as T.Matrix4).copy(sharedShadowInfo.matrix);
          ru.uShadowEnabled.value = sharedShadowInfo.enabled ? 1 : 0;
        }
        (ru.uCamPos.value as T.Vector3).copy(camera.position);
        (ru.uCamFwd.value as T.Vector3).copy(this.camFwd);
        (ru.uCamRight.value as T.Vector3).copy(this.camRight);
        (ru.uCamUp.value as T.Vector3).copy(this.camUp);
        ru.uNear.value = near;
        ru.uFar.value = far;
        ru.uAspect.value = aspect;
        ru.uTanHalfFovY.value = tanHalfFovY;
        ru.uRayInvRes.value.set(1 / this.tRays.width, 1 / this.tRays.height);

        this.passMesh.material = rayMat;
        await compileTarget(this.passScene, this.passCam, this.passScene);
        if (aborted?.()) return;
        renderer.render(this.passScene, this.passCam);
      }

      // 2. Depth-aware 3x3 bilateral blur (`tRayBlur`, linear NoToneMapping)
      this.blurMaterial.uniforms.tRays.value = this.tRays.texture;
      this.passMesh.material = this.blurMaterial;
      this.tRayBlur.scissor.set(0, 0, 1, 1);
      this.tRayBlur.scissorTest = true;
      renderer.toneMapping = T.NoToneMapping;
      renderer.setRenderTarget(this.tRayBlur);
      await compileTarget(this.passScene, this.passCam, this.passScene);
      if (aborted?.()) return;
      renderer.render(this.passScene, this.passCam);

      const downscaleX = this.tRays.width / Math.max(1, this.fullWidth);
      const downscaleY = this.tRays.height / Math.max(1, this.fullHeight);

      // 3. Final scene composite (`null` default framebuffer with screen toneMapping, e.g. ACESFilmic)
      const compU = this.upsampleCompositeMaterial.uniforms;
      compU.tRayBlur.value = this.tRayBlur.texture;
      compU.tSceneColor.value = capture.texture;
      compU.tDepth.value = capture.depthTexture;
      compU.uNear.value = near;
      compU.uFar.value = far;
      compU.uFullInvRes.value.set(1 / Math.max(1, this.fullWidth), 1 / Math.max(1, this.fullHeight));
      compU.uSubmergeFade.value = 1;
      (compU.uDownscale.value as T.Vector2).set(downscaleX, downscaleY);

      this.passMesh.material = this.upsampleCompositeMaterial;
      renderer.toneMapping = prevToneMapping;
      renderer.setRenderTarget(null);
      renderer.setViewport(0, 0, 1, 1);
      renderer.setScissor(0, 0, 1, 1);
      renderer.setScissorTest(true);
      await compileTarget(this.passScene, this.passCam, this.passScene);
      if (aborted?.()) return;
      renderer.render(this.passScene, this.passCam);

      // 4. Additive overlay upsample variant (`renderOverlay` compatibility path)
      const ovU = this.upsampleOverlayMaterial.uniforms;
      ovU.tRayBlur.value = this.tRayBlur.texture;
      ovU.tSceneColor.value = capture.texture;
      ovU.tDepth.value = capture.depthTexture;
      ovU.uNear.value = near;
      ovU.uFar.value = far;
      ovU.uFullInvRes.value.set(1 / Math.max(1, this.fullWidth), 1 / Math.max(1, this.fullHeight));
      ovU.uSubmergeFade.value = 1;
      (ovU.uDownscale.value as T.Vector2).set(downscaleX, downscaleY);

      this.passMesh.material = this.upsampleOverlayMaterial;
      renderer.autoClear = false;
      await compileTarget(this.passScene, this.passCam, this.passScene);
      if (aborted?.()) return;
      renderer.render(this.passScene, this.passCam);
    } finally {
      camera.position.copy(savedCamPos);
      camera.quaternion.copy(savedCamQuat);
      camera.scale.copy(savedCamScale);
      camera.matrix.copy(savedCamMatrix);
      camera.matrixWorld.copy(savedCamMatrixWorld);
      camera.matrixWorldInverse.copy(savedCamMatrixWorldInv);

      const syncCb =
        onPrepareSubmergedCamera ??
        (scene.userData as { __ecArenaSyncShadow?: (c: T.Camera) => void }).__ecArenaSyncShadow;
      syncCb?.(camera);

      capture.scissor.copy(savedCaptureScissor);
      capture.scissorTest = savedCaptureScissorTest;
      this.tRays.scissor.copy(savedRaysScissor);
      this.tRays.scissorTest = savedRaysScissorTest;
      this.tRayBlur.scissor.copy(savedBlurScissor);
      this.tRayBlur.scissorTest = savedBlurScissorTest;

      // Clear all warmup targets so zero 1x1 warmup pixels bleed into Frame 1.
      renderer.setScissorTest(false);
      capture.scissorTest = false;
      this.tRays.scissorTest = false;
      this.tRayBlur.scissorTest = false;
      renderer.setRenderTarget(this.tRays);
      renderer.clear(true, false, false);
      renderer.setRenderTarget(this.tRayBlur);
      renderer.clear(true, false, false);
      renderer.setRenderTarget(capture);
      renderer.clear(true, true, true);
      renderer.setRenderTarget(null);
      renderer.clear(true, true, true);

      capture.scissorTest = savedCaptureScissorTest;
      this.tRays.scissorTest = savedRaysScissorTest;
      this.tRayBlur.scissorTest = savedBlurScissorTest;

      renderer.setRenderTarget(prevTarget);
      renderer.toneMapping = prevToneMapping;
      renderer.autoClear = prevAutoClear;
      renderer.info.autoReset = prevAutoReset;
      renderer.xr.enabled = prevXr;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.shadowMap.needsUpdate = prevShadowNeeds;
      renderer.setViewport(prevViewport);
      renderer.setScissor(prevScissor);
      renderer.setScissorTest(prevScissorTest);
    }
  }

  dispose(): void {
    this.tRays.dispose();
    this.tRayBlur.dispose();
    if (this.sceneCaptureRT) {
      this.sceneCaptureRT.depthTexture?.dispose();
      this.sceneCaptureRT.dispose();
      this.sceneCaptureRT = null;
    }
    this.quadGeo.dispose();
    for (const m of this.rayMaterials.values()) m.dispose();
    this.blurMaterial.dispose();
    this.upsampleOverlayMaterial.dispose();
    this.upsampleCompositeMaterial.dispose();
  }
}

// ============================================================================
// 4. Shared Underwater Uniform Store + Fallback Shadow Depth Target
// ============================================================================

export interface SharedUnderwaterUniforms {
  uTime: { value: number };
  uSunDir: { value: T.Vector3 };
  uSunTint: { value: T.Vector3 };
  uGrottoBoost: { value: number };
  uQualityLevel: { value: number };
  uWidthScale: { value: number };
  uFarScale: { value: number };
  uCamRight: { value: T.Vector3 };
  uCamUp: { value: T.Vector3 };
  uCamFwd: { value: T.Vector3 };
  uRepelPos: { value: T.Vector4 };
  tWater: { value: T.Texture };
  tDetail: { value: T.Texture };
  tZoneMap: { value: T.Texture };
  tShadow: { value: T.Texture };
  uShadowMatrix: { value: T.Matrix4 };
  uShadowTexel: { value: number };
  uShadowEnabled: { value: number };
}

export function createFallbackShadowTarget(): {
  target: T.WebGLRenderTarget;
  depthTexture: T.DepthTexture;
  init(renderer: T.WebGLRenderer): void;
  dispose(): void;
} {
  const depthTexture = new T.DepthTexture(2, 2, T.UnsignedIntType);
  depthTexture.format = T.DepthFormat;
  depthTexture.compareFunction = T.LessEqualCompare;
  depthTexture.minFilter = T.LinearFilter;
  depthTexture.magFilter = T.LinearFilter;
  depthTexture.name = 'AbyssalFallbackShadowDepth';

  const target = new T.WebGLRenderTarget(2, 2, {
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture,
  });

  let initialized = false;
  return {
    target,
    depthTexture,
    init(renderer: T.WebGLRenderer) {
      if (initialized) return;
      initialized = true;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.clearDepth();
      renderer.setRenderTarget(prev);
    },
    dispose() {
      depthTexture.dispose();
      target.dispose();
    },
  };
}

export function applyTimeOfDayToUnderwaterUniforms(
  shared: SharedUnderwaterUniforms,
  tod: ArenaTimeOfDay,
): void {
  if (tod === 'sunset') {
    shared.uSunDir.value.set(-0.74, 0.34, 0.58).normalize();
    shared.uSunTint.value.set(1.18, 0.86, 0.68);
    shared.uGrottoBoost.value = 0.24;
  } else {
    shared.uSunDir.value.set(-0.58, 0.75, 0.40).normalize();
    shared.uSunTint.value.set(1.0, 1.0, 1.0);
    shared.uGrottoBoost.value = 0.06;
  }
}

// ============================================================================
// 5. `W_SOLID` — 6-Material Triplanar Underwater Shader (Terrain, Arches,
//    Boulders, Echo Whale Stone Fluke, Sunken Shipwreck, Sponges, Corals)
// ============================================================================

const W_SOLID_VS = /* glsl */ `
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

attribute float aAux;
attribute vec4 aInstA; // xyz = pos, w = scale
attribute vec4 aInstB; // quaternion xyzw
attribute vec4 aInstC; // x = matId, y = seed, z = fadeDist, w = bobAmp

uniform float uIsInstanced;
uniform vec4 uStaticMeta; // x = matId, y = seed, z = texScale, w = bobAmp
uniform vec4 uStaticQuat;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
varying vec3 vObjNormal;
flat out vec4 vMeta;
flat out vec4 vQuat;
varying float vAO;

void main() {
  float ao = aAux;
  vec3 wPos;
  vec3 wNrm;
  vec3 oPos;
  vec3 oNrm = normal;
  vec4 meta;
  vec4 quat;

  if (uIsInstanced > 0.5) {
    float sc = aInstA.w;
    if (aInstC.x < 1.5 && aInstC.z > 1.5) {
      float fadeEnd = aInstC.z * uFarScale;
      sc *= 1.0 - uwSS(fadeEnd * 0.7, fadeEnd, distance(aInstA.xyz, cameraPosition));
    }
    wPos = aInstA.xyz + uwQRot(aInstB, position * sc);
    wPos.y += sin(uTime * 0.3 + aInstC.y * 40.0) * aInstC.w;
    wNrm = uwQRot(aInstB, normal);
    oPos = position * aInstA.w + aInstC.y * 37.0;
    meta = aInstC;
    quat = aInstB;
  } else {
    vec4 wp4 = modelMatrix * vec4(position, 1.0);
    wPos = wp4.xyz;
    wPos.y += sin(uTime * 0.3 + uStaticMeta.y * 40.0) * uStaticMeta.w;
    wNrm = normalize(mat3(modelMatrix) * normal);
    oPos = position * max(uStaticMeta.z, 0.01) + uStaticMeta.y * 37.0;
    meta = uStaticMeta;
    quat = uStaticQuat;
  }

  vWorldPos = wPos;
  vWorldNormal = wNrm;
  vObjPos = oPos;
  vObjNormal = oNrm;
  vMeta = meta;
  vQuat = quat;
  vAO = ao;
  gl_Position = projectionMatrix * viewMatrix * vec4(wPos, 1.0);
}
`;

const W_SOLID_FS = /* glsl */ `
precision highp float;
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
varying vec3 vObjNormal;
flat in vec4 vMeta;
flat in vec4 vQuat;
varying float vAO;

struct TriSample {
  float h;
  float c;
  vec3 n;
};

TriSample sampleTriplanar(vec3 p, vec3 n, float s) {
  vec3 w = pow(abs(n), vec3(4.0));
  w /= max(w.x + w.y + w.z, 1e-4);
  vec4 x = texture(tDetail, p.zy * s);
  vec4 y = texture(tDetail, p.xz * s);
  vec4 z = texture(tDetail, p.xy * s);
  TriSample o;
  o.h = x.b * w.x + y.b * w.y + z.b * w.z;
  o.c = x.a * w.x + y.a * w.y + z.a * w.z;
  vec2 a = x.rg * 2.0 - 1.0;
  vec2 b = y.rg * 2.0 - 1.0;
  vec2 c = z.rg * 2.0 - 1.0;
  o.n = vec3(0.0, a.y, a.x) * w.x + vec3(b.x, 0.0, b.y) * w.y + vec3(c.x, c.y, 0.0) * w.z;
  return o;
}

void main() {
  int mat = int(vMeta.x + 0.5);
  float sd = vMeta.y;
  float fl = gl_FrontFacing ? 1.0 : -1.0;
  vec3 on = normalize(vObjNormal) * fl;
  vec3 n0 = normalize(vWorldNormal) * fl;
  float dist = length(vWorldPos - cameraPosition);
  float ts = (mat >= 2 && vMeta.z > 0.05 && vMeta.z < 8.0) ? vMeta.z : 1.0;

  TriSample A = sampleTriplanar(vObjPos, on, 0.10 * ts);
  TriSample B = sampleTriplanar(vObjPos, on, 0.43 * ts);
  TriSample C = sampleTriplanar(vObjPos, on, 1.90 * ts);
  float fk = (uQualityLevel > 0.5 && mat <= 1) ? uwSS(10.0, 1.5, dist) : 0.0;
  TriSample F = C;
  if (fk > 0.001) {
    F = sampleTriplanar(vObjPos, on, 6.70 * ts);
  }

  vec4 Wd = texture(tDetail, vec2(vObjPos.x * 0.06, (vObjPos.y + vObjPos.z) * 0.7));
  float big = texture(tDetail, vObjPos.xz * 0.013 + vObjPos.y * 0.021).a;
  float big2 = texture(tDetail, vObjPos.zx * 0.031 + vObjPos.y * 0.043 + 0.37).a;
  float sgro = 0.0;
  vec4 sk = texture(tDetail, vec2((vObjPos.x + vObjPos.z) * 0.33, vObjPos.y * 0.035));
  vec4 sk2 = texture(tDetail, vec2((vObjPos.x - vObjPos.z) * 1.1, vObjPos.y * 0.11));
  vec4 gm = uwZoneSample(vWorldPos);
  vec3 ca = uwCausticsRGB(tWater, vWorldPos, dist, uSunDir);
  float hgt = A.h * 0.5 + B.h * 0.35 + C.h * 0.15;

  float bump = 1.7;
  float gloss = 0.10;
  vec3 alb = vec3(0.0);
  vec3 emi = vec3(0.0);
  float vao = 1.0;
  float flu = 0.0;
  float flt = uwSS(0.72, 0.93, n0.y);

  if (mat <= 1) {
    // Sedimentary rock strata + warm encrustation + green algae + rippled sand + magenta crust
    float st = vObjPos.y * 0.55 + A.h * 1.6 + big * 5.0 + big2 * 3.0;
    float bed = uwHash1(floor(st));
    float sf = fract(st);
    alb = mix(vec3(0.11, 0.12, 0.13), vec3(0.33, 0.30, 0.25), uwSat(A.c * 1.5 - 0.25));
    alb = mix(alb, mix(vec3(0.26, 0.19, 0.10), vec3(0.20, 0.22, 0.14), bed), uwSS(0.42, 0.66, big) * 0.7);
    alb *= mix(0.72, 1.15, bed) * (1.0 - 0.45 * uwSS(0.12, 0.0, sf) * (1.0 - abs(on.y)));
    float enc = uwSS(0.46, 0.60, big2 * 0.6 + B.c * 0.5) * uwSS(0.30, 0.60, hgt);
    alb = mix(alb, mix(vec3(0.34, 0.07, 0.10), vec3(0.40, 0.25, 0.07), uwSS(0.45, 0.60, A.c)) * (0.5 + 0.8 * B.h), enc * 0.75);
    alb = mix(alb, vec3(0.50, 0.50, 0.46) * (0.5 + 0.7 * C.h), uwSS(0.60, 0.70, B.c * 0.6 + C.c * 0.5) * 0.5);
    float alg = uwSS(-0.1, 0.6, n0.y) * uwSS(0.30, 0.52, B.c * 0.55 + big * 0.5);
    alb = mix(alb, vec3(0.035, 0.14, 0.07), alg * 0.8);
    alb *= (0.22 + 1.3 * hgt) * mix(1.0, 0.62 + 0.76 * F.h, fk);
    sgro = -uwSS(0.14, 0.0, sf) * (1.0 - abs(on.y)) * 1.2;
    if (mat == 0) {
      alb = mix(alb, vec3(0.22, 0.24, 0.21) * (0.58 + 0.6 * B.h), flt * gm.a * 0.75);
      float mg = flt * uwSat(gm.r * 1.5 - 0.45 + (B.c - 0.5) * 1.6) * uwSS(0.35, 0.60, A.h) * uwSS(-14.0, -24.0, vWorldPos.y - WATER_Y);
      alb = mix(alb, vec3(0.20, 0.02, 0.12) * (0.4 + 0.9 * B.h), mg * 0.8);
      flu = mg * 0.35;
      alb = mix(alb, alb * vec3(0.85, 0.80, 1.40) + vec3(0.015, 0.0, 0.05), gm.b * 0.8);
    }
  } else if (mat == 2) {
    // Echo Whale Stone Fluke Sanctuary: wet pale slate with longitudinal mineral streaks
    alb = mix(vec3(0.42, 0.47, 0.48), vec3(0.10, 0.13, 0.15), uwSS(0.40, 0.62, sk.a * 0.6 + sk2.b * 0.5)) * (0.75 + 0.3 * B.h);
    alb = mix(alb, vec3(0.60, 0.64, 0.62), uwSS(0.62, 0.75, sk2.a) * 0.5);
    gloss = 0.9;
    bump = 0.3;
  } else if (mat == 3) {
    // Sunken Wooden Shipwreck: oak planking + polar plank-seam grooves + teal marine moss
    alb = mix(vec3(0.13, 0.085, 0.05), vec3(0.36, 0.25, 0.14), Wd.b) * (0.6 + 0.5 * B.h);
    float pk = fract(atan(vObjPos.z, 2.0 - vObjPos.y) * 7.0);
    alb *= 0.35 + 0.65 * uwSS(0.0, 0.12, min(pk, 1.0 - pk));
    alb = mix(alb, vec3(0.08, 0.22, 0.16), uwSS(0.5, 0.7, A.c) * 0.6);
    gloss = 0.2;
    bump = 0.7;
  } else if (mat == 4) {
    // Barrel, Vase, and Pipe Sponges: terracotta / ochre / plum hues + cavity AO
    float hue = fract(sd * 7.31);
    alb = mix(vec3(0.60, 0.17, 0.08), vec3(0.64, 0.35, 0.10), fract(hue * 3.0));
    if (hue > 0.75) alb = vec3(0.44, 0.18, 0.42);
    alb *= (0.45 + 0.75 * B.h) * (0.7 + 0.3 * C.h);
    vao = vAO * vAO;
    gloss = 0.2;
    bump = 1.4;
    flu = 0.55;
  } else {
    // Fluorescent Branching Staghorn and Sea-Fan Corals
    float hue = fract(sd * 5.73);
    alb = mix(vec3(0.80, 0.08, 0.10), vec3(0.90, 0.22, 0.40), fract(hue * 4.0));
    if (hue > 0.7) alb = vec3(0.88, 0.42, 0.10);
    if (hue > 0.9) alb = vec3(0.55, 0.22, 0.75);
    alb *= (0.4 + 0.8 * B.h) * (0.5 + 0.9 * vAO * vAO);
    alb = mix(alb, vec3(1.0, 0.75, 0.6), uwSS(0.8, 1.0, vAO) * 0.35);
    emi = alb * 0.015;
    flu = 0.75;
    gloss = 0.25;
    bump = 1.5;
  }

  float rip = (mat == 0) ? flt * gm.a * cos((vWorldPos.x * 0.8 + vWorldPos.z * 0.35) * 5.0 + A.c * 9.0) * 0.65 : 0.0;
  vec3 localN = normalize(
    on + (A.n * 0.85 + B.n * 0.65 + C.n * 0.45 * uwSS(60.0, 12.0, dist) + F.n * 0.5 * fk) * bump
       + vec3(0.8 * rip, sgro, 0.35 * rip)
  );
  vec3 N = normalize(uwQRot(vQuat, localN));
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec2 os1 = uwOpenSky(vWorldPos + n0 * 1.5);
  vec2 os2 = uwOpenSky(vWorldPos + n0 * 4.5);
  float ao = (os1.x * 0.55 + os2.x * 0.45) * vao * uwSS(0.12, 0.60, hgt);
  float z = uwZone(vWorldPos);

  vec3 E = uwSunE(vWorldPos.y, z, L) * uSunTint * uwShadow9(vWorldPos + n0 * 0.35);
  float ndl = uwSat(dot(N, L));
  vec3 am = (uwAmb(vWorldPos, N, os1.y, z) + uwSide(vWorldPos, N, os2.x, z)) * ao;
  vec3 dl = E * ndl * (0.10 + mix(vec3(0.33), ca, uwSS(0.10, 0.45, dot(n0, L))) * 2.5);
  vec3 c = alb * (dl + am) + emi + alb * flu * dot(dl + am, vec3(0.1, 0.5, 0.5));

  vec3 H = normalize(V + L);
  c += E * (0.25 + ca) * pow(uwSat(dot(N, H)), mix(10.0, 70.0, gloss)) * gloss * ndl * 1.8;
  vec3 R = reflect(-V, N);
  c += (uwAmb(vWorldPos, R, os1.y, z) + uwSide(vWorldPos, R, os2.x, z)) * ao * (0.08 + gloss) * 0.6 * pow(1.0 - uwSat(dot(N, V)), 2.5);

  vec3 finalCol = uwApplyFog(c, vWorldPos, cameraPosition, z, L, os2.y);
  // If viewed from above water through shallow sea, only attenuate along submerged path
  if (cameraPosition.y > WATER_Y + 0.05) {
    float airBlend = uwSS(WATER_Y + 0.05, WATER_Y + 0.65, cameraPosition.y);
    float subPath = max(0.0, (WATER_Y - vWorldPos.y) / max(-V.y, 0.12));
    vec3 fromAir = c * exp(-uwSg(z) * min(subPath, 65.0));
    finalCol = mix(finalCol, fromAir, airBlend);
  }
  gl_FragColor = vec4(uwSafeHDR(finalCol, 28.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const W_SOLID_INSTANCED_DEPTH_VS = /* glsl */ `
${UNDERWATER_OPTICS_GLSL}
uniform float uTime;
attribute vec4 aInstA;
attribute vec4 aInstB;
attribute vec4 aInstC;
varying vec2 vHighPrecisionZW;

void main() {
  vec3 wPos = aInstA.xyz + uwQRot(aInstB, position * aInstA.w);
  wPos.y += sin(uTime * 0.3 + aInstC.y * 40.0) * aInstC.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(wPos, 1.0);
  vHighPrecisionZW = gl_Position.zw;
}
`;

const W_CUSTOM_DEPTH_FS = /* glsl */ `
precision highp float;
#include <packing>
varying vec2 vHighPrecisionZW;
void main() {
  float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
  #if DEPTH_PACKING == 3201
    gl_FragColor = packDepthToRGBA(fragCoordZ);
  #else
    gl_FragColor = vec4(vec3(1.0 - fragCoordZ), 1.0);
  #endif
}
`;

export function createUnderwaterSolidMaterial(
  shared: SharedUnderwaterUniforms,
  options: { instanced: boolean; matId?: number; seed?: number; texScale?: number; bobAmp?: number; quat?: T.Quaternion } = { instanced: false },
): T.ShaderMaterial {
  const q = options.quat ?? new T.Quaternion();
  return new T.ShaderMaterial({
    name: options.instanced ? 'AbyssalSolidInstanced' : `AbyssalSolid_${options.matId ?? 0}`,
    side: T.DoubleSide,
    uniforms: {
      ...shared,
      uIsInstanced: { value: options.instanced ? 1 : 0 },
      uStaticMeta: {
        value: new T.Vector4(
          options.matId ?? 0,
          options.seed ?? 0.3,
          options.texScale ?? 1,
          options.bobAmp ?? 0,
        ),
      },
      uStaticQuat: { value: new T.Vector4(q.x, q.y, q.z, q.w) },
    },
    vertexShader: W_SOLID_VS,
    fragmentShader: W_SOLID_FS,
  });
}

export function createUnderwaterSolidDepthMaterial(shared: SharedUnderwaterUniforms): T.ShaderMaterial {
  return new T.ShaderMaterial({
    name: 'AbyssalSolidDepth',
    defines: { DEPTH_PACKING: 3201 },
    uniforms: { uTime: shared.uTime },
    vertexShader: W_SOLID_INSTANCED_DEPTH_VS,
    fragmentShader: W_CUSTOM_DEPTH_FS,
  });
}

// ============================================================================
// 6. `W_LEAF` — 8-Species Parametric Arc-Bent Swaying Kelp, Ribbon Seagrass,
//    Magenta Grotto Carpets, and Additive Twinkling Glints (`vsGl` / `fsGl`)
// ============================================================================

const W_LEAF_VS = /* glsl */ `
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

// position.x = u (-1 or +1), position.y = sin(row/(rows-1) * pi/2) = v
attribute vec4 aInstA; // rootX, rootY, rootZ, length
attribute vec4 aInstB; // yaw, tilt, width, heightAlongColumn
attribute vec4 aInstC; // typeId (0..7), seed1, seed2, baseBend

uniform float uLeafFar;
uniform float uShadowPass;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vLeafUV;
flat out vec3 vCol;
flat out vec4 vProps;
flat out vec2 vSeed;
flat out vec3 vSpecCol;
varying vec2 vHighPrecisionZW;

float leafShapeSin(float v) {
  return sin(3.14159265 * uwSat(v));
}

vec3 glintPalette(float h) {
  if (h < 0.3) return vec3(1.0, 0.62, 0.08);
  if (h < 0.6) return vec3(0.12, 1.0, 0.22);
  if (h < 0.8) return vec3(0.20, 0.85, 1.0);
  return vec3(1.0, 0.30, 0.80);
}

void main() {
  float u = position.x;
  float v = position.y;
  int ty = int(aInstC.x + 0.5);
  float s1 = aInstC.y;
  float s2 = aInstC.z;
  float t = uTime;
  float len = aInstA.w;
  float hA = aInstB.w;

  float cy = cos(aInstB.x);
  float sy = sin(aInstB.x);
  float ct = cos(aInstB.y);
  float st = sin(aInstB.y);
  vec3 d = vec3(st * cy, ct, st * sy);
  vec3 pe = vec3(ct * cy, -st, ct * sy);
  vec3 sd = vec3(-sy, 0.0, cy);

  vec3 col = vec3(0.0);
  vec4 pr = vec4(0.0); // x = sparkle prob, y = translucency, z = iridescence, w = emissive
  vec3 spc = vec3(0.0);
  vec2 shp = vec2(0.75, 0.70);
  float wav = 1.0;
  float fls = 1.0;
  float hsel = uwHash1(s1 * 13.7 + s2 * 71.3);

  if (ty == 0) {
    col = mix(vec3(0.11, 0.125, 0.022), vec3(0.04, 0.10, 0.04), s1);
    col = mix(col, vec3(0.25, 0.17, 0.025), step(0.72, s2));
    pr = vec4(0.24, 0.90, 0.0, 0.0);
    spc = glintPalette(hsel * 0.72);
    shp = vec2(0.50, 0.32);
    wav = 1.9;
  } else if (ty == 1) {
    col = vec3(0.10, 0.11, 0.035);
    pr = vec4(0.0, 0.20, 0.0, 0.0);
    shp = vec2(0.05, 0.10);
    wav = 0.3;
    fls = 0.3;
  } else if (ty == 2) {
    col = mix(vec3(0.05, 0.20, 0.16), vec3(0.12, 0.26, 0.22), s1);
    col = mix(col, vec3(0.30, 0.14, 0.24), step(0.85, s2));
    pr = vec4(0.05, 1.0, 0.25, 0.0);
    spc = vec3(0.60, 1.0, 0.90);
    shp = vec2(0.45, 0.35);
    wav = 2.2;
  } else if (ty == 3) {
    col = mix(vec3(0.02, 0.05, 0.065), vec3(0.05, 0.03, 0.08), s1);
    col = mix(col, vec3(0.09, 0.03, 0.09), step(0.80, s2));
    pr = vec4(0.20, 0.85, 0.55, 0.02);
    spc = mix(vec3(0.50, 0.35, 1.0), vec3(0.20, 1.0, 0.70), step(0.6, hsel));
    shp = vec2(0.70, 0.60);
    wav = 2.4;
  } else if (ty == 4) {
    col = mix(vec3(0.30, 0.15, 0.02), vec3(0.42, 0.25, 0.04), s1);
    pr = vec4(0.20, 1.0, 0.10, 0.0);
    spc = vec3(1.0, 0.85, 0.50);
    shp = vec2(0.50, 0.40);
    wav = 1.8;
  } else if (ty == 5) {
    col = mix(vec3(0.85, 0.05, 0.40), vec3(0.60, 0.10, 0.80), step(0.70, s1));
    col = mix(col, vec3(0.95, 0.25, 0.55), step(0.75, s2));
    pr = vec4(0.22, 0.80, 0.0, 0.30);
    spc = vec3(1.0, 0.35, 0.80);
    shp = vec2(0.60, 0.60);
    fls = 2.0;
  } else if (ty == 6) {
    col = mix(vec3(0.80, 0.16, 0.16), vec3(0.92, 0.36, 0.42), s1);
    pr = vec4(0.06, 1.0, 0.0, 0.10);
    spc = vec3(1.0, 0.50, 0.50);
    shp = vec2(0.40, 0.30);
    wav = 2.0;
  } else {
    col = mix(vec3(0.05, 0.40, 0.36), vec3(0.10, 0.52, 0.58), s1);
    pr = vec4(0.10, 0.90, 0.20, 0.04);
    spc = vec3(0.30, 1.0, 0.90);
    shp = vec2(0.60, 0.50);
  }
  pr.x = step(uwHash1(s1 * 91.7 + s2 * 37.1 + aInstB.x), pr.x);

  float k = (aInstC.w - 0.3) * 2.0 + sin(t * (0.8 + s1) * fls + s2 * 40.0 + hA * 0.25) * 0.10 * fls;
  float wph = v * (3.0 + 5.0 * s2) + s1 * 30.0 + t * 1.1;
  float wv = sin(wph) * 0.12 * wav;
  float kq = k * 1.7;
  float ka = abs(kq) < 0.06 ? 0.06 : kq;
  float sK = sin(ka * v);
  float cK = cos(ka * v);

  vec3 c = aInstA.xyz + len * (d * (sK / ka) + pe * ((1.0 - cK) / ka + wv * v));
  float sl = sK + wv + cos(wph) * 0.10 * wav * v * (3.0 + 5.0 * s2);
  vec3 N = normalize(pe * cK - d * sl);
  vec3 T0 = normalize(d * cK + pe * sl);

  float tw = (s1 - 0.5) * 2.4 * v + sin(t * 0.9 + s2 * 20.0) * 0.25 * v;
  vec3 S = sd * cos(tw) + N * sin(tw);
  vec3 N2 = N * cos(tw) - sd * sin(tw);
  float shape = pow(max(sin(3.14159265 * pow(max(v, 1e-4), shp.x)), 0.0), shp.y);

  float cd = distance(aInstA.xyz, cameraPosition);
  float far = uLeafFar * uFarScale;
  float wid = (ty == 1 ? aInstB.z : aInstB.z * uWidthScale);
  float nearK = uShadowPass > 0.5 ? 0.0 : (1.0 - uwSS(26.0, 40.0, cd));
  float farK = uShadowPass > 0.5 ? 1.0 : (1.0 - uwSS(far * 0.8, far, cd)) * uwSS(0.45, 1.6, distance(c, cameraPosition));

  float ruf = sin(v * 10.0 + s2 * 30.0 + t * 0.6) * wid * 0.36 * u * leafShapeSin(v) * nearK;
  float halfWid = uShadowPass > 0.5 ? (ty == 1 ? 0.0 : max(wid * 0.5, 0.09) * shape) : wid * 0.5 * shape;
  vec3 p = c + S * (u * farK * halfWid) + N2 * ruf;

  vec2 sw = uwSway(aInstA.xz, hA + (p.y - aInstA.y), t);
  p.x += sw.x;
  p.z += sw.y;
  // Keep kelp fronds gracefully bending beneath the surface
  if (p.y > WATER_Y - 0.08) {
    p.y = WATER_Y - 0.08 - 0.12 * uwSat((p.y - (WATER_Y - 0.08)) * 0.5);
  }

  vWorldPos = p;
  vWorldNormal = normalize(N2 + S * u * 0.55 - T0 * cos(v * 10.0 + s2 * 30.0 + t * 0.6) * u * 0.7 * nearK);
  vLeafUV = vec2(u, v);
  vCol = col;
  vProps = pr;
  vSeed = vec2(s1, s2);
  vSpecCol = spc;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vHighPrecisionZW = gl_Position.zw;
}
`;

const W_LEAF_FS = /* glsl */ `
precision highp float;
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vLeafUV;
flat in vec3 vCol;
flat in vec4 vProps;
flat in vec2 vSeed;
flat in vec3 vSpecCol;

void main() {
  float dist = length(vWorldPos - cameraPosition);
  float ca = uwCausticsScalar(tWater, vWorldPos, dist, uSunDir);
  vec3 n = normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = uSunDir;
  float z = uwZone(vWorldPos);
  vec4 lt = texture(tDetail, vec2(vLeafUV.x * 0.13 + vSeed.x * 3.7, vLeafUV.y * 0.8 + vSeed.y * 5.3));
  vec2 os = uwOpenSky(vWorldPos + vec3(0.0, 0.8, 0.0));
  vec3 E = uwSunE(vWorldPos.y, z, L) * uSunTint * uwShadow1(vWorldPos + L * 0.3);
  float ndl = dot(n, L);

  vec3 alb = vCol
    * (0.72 + 0.28 * uwSS(0.0, 0.25, abs(vLeafUV.x)))
    * mix(0.50, 1.12, vLeafUV.y)
    * (1.0 - 0.45 * uwSS(30.0, 8.0, dist) * uwSS(0.6, 1.0, sin(vLeafUV.y * 40.0 - abs(vLeafUV.x) * 7.0 + vSeed.x * 40.0)))
    * (0.58 + 0.42 * uwSS(0.0, 0.13, abs(vLeafUV.x)))
    * (0.50 + 1.0 * lt.b)
    * (0.65 + 0.70 * lt.a);

  float ndv = uwSat(dot(n, V));
  vec3 ir = 0.5 + 0.5 * cos(UW_TAU * (vec3(0.0, 0.33, 0.67) + ndv * 1.1 + vSeed.x * 0.22 + vLeafUV.y * 0.5 + 0.55));
  alb = mix(alb, alb * 0.5 + ir * vec3(0.15, 0.13, 0.30), vProps.z * (1.0 - ndv) * 0.8);

  float tr = (max(-ndl, 0.0) * 0.85 + 0.15) * vProps.y;
  vec3 trc = alb * mix(vec3(1.0), vec3(1.5, 1.4, 0.75), uwSat(vProps.y) * (1.0 - vProps.z));
  float aov = os.x * mix(0.4, 1.0, vLeafUV.y);
  vec3 am = (
    uwAmb(vWorldPos, n, os.y, z) +
    uwAmb(vWorldPos, -n, os.y, z) * vProps.y * 0.55 * vec3(1.1, 1.15, 0.70) +
    uwSide(vWorldPos, n, os.x, z) * 0.6
  ) * (0.3 + 0.7 * aov);

  vec3 c = E * (0.06 + ca * 1.5) * (alb * max(ndl, 0.0) + trc * tr) + alb * am;
  vec3 H = normalize(V + L);
  c += E * (pow(uwSat(dot(n, H)), 40.0) * (0.45 + ir * vProps.z * 2.0) + pow(uwSat(dot(n, H)), 9.0) * 0.07)
     + am * ir * vProps.z * pow(1.0 - ndv, 3.0) * 1.5;
  c += E * trc * vProps.y * pow(uwSat(dot(-V, L)), 3.0) * 1.2;
  c += alb * vProps.w * (0.5 + 3.0 * dot(am + E * 0.3, vec3(0.1, 0.5, 0.5)));

  // Slow whole-leaf twinkling glint
  float tw = pow(0.5 + 0.5 * sin(uTime * (0.5 + vSeed.y * 1.4) + vSeed.x * 90.0), 5.0);
  float m = uwSS(0.20, 0.0, abs(vLeafUV.y - (0.35 + 0.45 * vSeed.y))) * (1.0 - vLeafUV.x * vLeafUV.x);
  float lit = 0.35 + E.g * 1.2;
  c += vSpecCol * vProps.x * (0.1 + tw) * m * lit * 0.6;

  vec3 finalCol = uwApplyFog(c, vWorldPos, cameraPosition, z, L, os.y);
  if (cameraPosition.y > WATER_Y + 0.05) {
    float airBlend = uwSS(WATER_Y + 0.05, WATER_Y + 0.65, cameraPosition.y);
    float subPath = max(0.0, (WATER_Y - vWorldPos.y) / max(-V.y, 0.12));
    finalCol = mix(finalCol, c * exp(-uwSg(z) * min(subPath, 65.0)), airBlend);
  }
  gl_FragColor = vec4(uwSafeHDR(finalCol, 24.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createUnderwaterLeafMaterial(
  shared: SharedUnderwaterUniforms,
  farDist = 150,
): T.ShaderMaterial {
  return new T.ShaderMaterial({
    name: 'AbyssalLeaf',
    side: T.DoubleSide,
    uniforms: {
      ...shared,
      uLeafFar: { value: farDist },
      uShadowPass: { value: 0 },
    },
    vertexShader: W_LEAF_VS,
    fragmentShader: W_LEAF_FS,
  });
}

export function createUnderwaterLeafDepthMaterial(
  shared: SharedUnderwaterUniforms,
  farDist = 150,
): T.ShaderMaterial {
  return new T.ShaderMaterial({
    name: 'AbyssalLeafDepth',
    side: T.DoubleSide,
    defines: { DEPTH_PACKING: 3201 },
    uniforms: {
      ...shared,
      uLeafFar: { value: farDist },
      uShadowPass: { value: 1 },
    },
    vertexShader: W_LEAF_VS,
    fragmentShader: W_CUSTOM_DEPTH_FS,
  });
}

// ============================================================================
// 7. Bioluminescent Kelp Glints (`vsGl` / `fsGl`)
// ============================================================================

const W_GLINT_VS = /* glsl */ `
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

attribute vec4 aGlintA; // xyz = pos, w = swayHeight
attribute vec4 aGlintB; // x = phaseSeed, y = paletteHue, z = baseSize, w = unused

varying vec2 vQuadUV;
flat out vec3 vGlintCol;

vec3 glintPal(float h) {
  if (h < 0.3) return vec3(1.0, 0.62, 0.08);
  if (h < 0.6) return vec3(0.12, 1.0, 0.22);
  if (h < 0.8) return vec3(0.20, 0.85, 1.0);
  return vec3(1.0, 0.30, 0.80);
}

void main() {
  vec2 q = position.xy;
  float t = uTime;
  vec3 p = aGlintA.xyz;
  vec2 sw = uwSway(aGlintA.xz, aGlintA.w, t);
  p.x += sw.x;
  p.z += sw.y;
  p += 0.1 * vec3(
    sin(t * 0.7 + aGlintB.x * 50.0),
    sin(t * 0.9 + aGlintB.x * 70.0),
    cos(t * 0.8 + aGlintB.x * 90.0)
  );

  float d = length(p - cameraPosition);
  // Hide above water or far beyond visibility range
  if (d > 120.0 * uFarScale || dot(p - cameraPosition, uCamFwd) < -1.0 || cameraPosition.y > WATER_Y + 2.5) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vQuadUV = q;
    vGlintCol = vec3(0.0);
    return;
  }

  float tw = pow(0.5 + 0.5 * sin(t * (0.35 + 0.9 * uwHash1(aGlintB.x)) + aGlintB.x * 100.0), 4.0);
  float sz = clamp(aGlintB.z, d * 0.0026, d * 0.0045);
  vec3 w = p + (uCamRight * q.x + uCamUp * q.y) * sz;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  vQuadUV = q;

  float z = uwZone(p);
  float lit = 0.3 + 1.8 * uwShadow1(p) * uwSunE(p.y, z, uSunDir).g;
  float e = aGlintB.z / max(sz, 1e-4);
  float subFade = uwSS(WATER_Y + 2.5, WATER_Y - 0.3, cameraPosition.y);
  vGlintCol = glintPal(aGlintB.y) * (0.12 + tw * 1.7) * lit * e * e * exp(-UW_SIG.g * d) * uwSS(0.4, 1.5, d) * 14.0 * subFade;
}
`;

const W_GLINT_FS = /* glsl */ `
precision highp float;
varying vec2 vQuadUV;
flat in vec3 vGlintCol;

void main() {
  float r = dot(vQuadUV, vQuadUV);
  if (r >= 1.0) discard;
  float falloff = exp(-r * 7.0) * (1.0 - smoothstep(0.7, 1.0, r));
  vec3 col = min(max(vGlintCol * falloff, vec3(0.0)), vec3(10.0));
  gl_FragColor = vec4(col, 0.0);
}
`;

export function createUnderwaterGlintMaterial(shared: SharedUnderwaterUniforms): T.ShaderMaterial {
  return new T.ShaderMaterial({
    name: 'AbyssalKelpGlints',
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
    uniforms: { ...shared },
    vertexShader: W_GLINT_VS,
    fragmentShader: W_GLINT_FS,
  });
}

// ============================================================================
// 8. `W_SPR` — Rising Helical Wobble-Bubbles & `44 m` Camera-Wrapped Marine Snow
// ============================================================================

const W_BUBBLE_VS = /* glsl */ `
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

attribute vec4 aBubA; // vx, vy, vz, baseRadius
attribute vec4 aBubB; // phase, riseSpeed, columnHeight, wobbleAmp

varying vec2 vQuadUV;
varying vec3 vWorldPos;
flat out vec4 vBubProps;

void main() {
  vec2 q = position.xy;
  float t = uTime;
  float colH = max(aBubB.z, 0.5);
  float life = fract(t * aBubB.y / colH + aBubB.x);
  float h = life * colH;
  vec3 p = aBubA.xyz + vec3(0.0, h, 0.0);
  float wob = aBubB.w * (0.3 + h * 0.035);
  p.x += sin(t * 1.7 + aBubB.x * 50.0 + h * 0.6) * wob + sin(h * 0.13 + aBubB.x * 9.0) * aBubB.w * 2.0;
  p.z += cos(t * 1.3 + aBubB.x * 33.0 + h * 0.5) * wob + cos(h * 0.11 + aBubB.x * 7.0) * aBubB.w * 2.0;

  float subY = p.y - WATER_Y;
  float camSub = uwSS(WATER_Y + 2.45, WATER_Y + 0.15, cameraPosition.y);
  float sz = aBubA.w * (0.55 + 0.7 * life) * uwSS(0.0, 0.03, life) * uwSS(0.0, -1.2, subY) * camSub;
  if (sz <= 0.001 || distance(p, cameraPosition) > 135.0 * uFarScale) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vQuadUV = q;
    vWorldPos = p;
    vBubProps = vec4(0.0);
    return;
  }

  vec3 w = p + (uCamRight * q.x + uCamUp * q.y) * sz;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  vQuadUV = q;
  vWorldPos = p;
  vBubProps = vec4(aBubB.x, sz, uwShadow1(p), 0.0);
}
`;

const W_BUBBLE_FS = /* glsl */ `
precision highp float;
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

varying vec2 vQuadUV;
varying vec3 vWorldPos;
flat in vec4 vBubProps;

void main() {
  if (vBubProps.y <= 0.0005) discard;
  float t = uTime;
  float an = atan(vQuadUV.y, vQuadUV.x + 1e-4);
  float big = uwSS(0.04, 0.22, vBubProps.y);
  float r = length(vQuadUV) / (0.9 + big * 0.05 * sin(an * 3.0 + t * 5.0 + vBubProps.x * 40.0) + big * 0.02 * sin(an * 5.0 - t * 7.0));
  float aa = max(fwidth(r) * 1.5, 0.02);
  float disc = 1.0 - uwSS(1.0 - aa, 1.0, r);
  if (disc <= 0.003) discard;

  float rim = uwSS(0.55, 0.98, r);
  float hl = uwSS(0.34, 0.0, length(vQuadUV - vec2(-0.36, 0.42))) + 0.5 * uwSS(0.20, 0.0, length(vQuadUV - vec2(0.40, -0.42)));
  float z = uwZone(vWorldPos);
  vec3 E = uwSunE(vWorldPos.y, z, uSunDir) * uSunTint * (0.25 + 0.75 * vBubProps.z);
  vec3 hi = uwFogIn(vWorldPos, vec3(0.0, 1.0, 0.0), 80.0, z, uSunDir) * 1.5;
  vec3 lo = uwFogIn(vWorldPos, vec3(0.0, -1.0, 0.0), 80.0, z, uSunDir);
  vec3 c = mix(lo, hi, uwSS(-0.5, 0.8, vQuadUV.y + rim * 0.4)) * (0.5 + 1.2 * rim) + E * hl * 1.6;
  float al = disc * uwSat(0.03 + rim * rim * rim * 0.9 + hl);

  vec3 v = vWorldPos - cameraPosition;
  float d = max(length(v), 1e-4);
  float T = exp(-UW_SIG.g * d) * uwSS(0.8, 2.4, d);
  c = c * T + uwFogIn(cameraPosition, v / d, d, z, uSunDir) * (1.0 - T);
  al *= mix(0.35, 1.0, T);
  gl_FragColor = vec4(min(max(c * al, vec3(0.0)), vec3(16.0)), al);
}
`;

export function createUnderwaterBubbleMaterial(shared: SharedUnderwaterUniforms): T.ShaderMaterial {
  return new T.ShaderMaterial({
    name: 'AbyssalWobbleBubbles',
    transparent: true,
    depthWrite: false,
    blending: T.CustomBlending,
    blendSrc: T.OneFactor,
    blendDst: T.OneMinusSrcAlphaFactor,
    uniforms: { ...shared },
    vertexShader: W_BUBBLE_VS,
    fragmentShader: W_BUBBLE_FS,
  });
}

const W_SNOW_VS = /* glsl */ `
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

attribute vec4 aSnowSeed; // 0..1 deterministic 4D seed

varying vec2 vQuadUV;
varying vec3 vWorldPos;
flat out vec4 vSnowProps;

void main() {
  vec2 q = position.xy;
  if (cameraPosition.y > WATER_Y + 0.5) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vQuadUV = q;
    vWorldPos = cameraPosition;
    vSnowProps = vec4(0.0);
    return;
  }

  float t = uTime;
  const float B = 44.0;
  vec3 p = aSnowSeed.xyz * B
         + vec3(t * 0.22, t * 0.05, t * 0.13)
         + 0.5 * vec3(
             sin(t * 0.30 + aSnowSeed.x * 60.0),
             sin(t * 0.23 + aSnowSeed.y * 50.0),
             cos(t * 0.27 + aSnowSeed.z * 70.0)
           );
  p = cameraPosition + (fract((p - cameraPosition) / B + 0.5) - 0.5) * B;
  float d = max(length(p - cameraPosition), 1e-3);
  float sz = 0.012 + 0.045 * aSnowSeed.w * aSnowSeed.w * aSnowSeed.w;
  float angSz = max(sz, d * 0.0011);
  vec3 w = p + (uCamRight * q.x + uCamUp * q.y) * angSz;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  vQuadUV = q;
  vWorldPos = p;

  float subY = p.y - WATER_Y;
  float camSub = uwSS(WATER_Y + 0.5, WATER_Y - 0.3, cameraPosition.y);
  float fade = uwSS(B * 0.5, B * 0.32, d)
             * uwSS(0.6, 2.5, d)
             * min(1.0, sz / angSz)
             * uwSS(-0.3, -1.5, subY)
             * camSub;
  float tw = 0.6 + 0.4 * sin(t * (1.0 + aSnowSeed.w * 2.0) + aSnowSeed.x * 100.0);
  vSnowProps = vec4(fade * tw, uwShadow1(p), aSnowSeed.w, d);
}
`;

const W_SNOW_FS = /* glsl */ `
precision highp float;
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

varying vec2 vQuadUV;
varying vec3 vWorldPos;
flat in vec4 vSnowProps;

void main() {
  if (vSnowProps.x <= 0.002) discard;
  float r = length(vQuadUV);
  if (r >= 1.0) discard;
  float m = uwSS(1.0, 0.2, r);
  float z = uwZone(vWorldPos);
  vec3 c = (uwSunE(vWorldPos.y, z, uSunDir) * uSunTint * vSnowProps.y * 0.8 + uwAmb(vWorldPos, vec3(0.0, 1.0, 0.0), 1.0, z) * 0.3)
         * mix(vec3(1.0), vec3(0.7, 1.0, 0.9), vSnowProps.z);
  vec3 outRGB = min(max(c * m * m * vSnowProps.x * exp(-UW_SIG.g * vSnowProps.w), vec3(0.0)), vec3(8.0));
  gl_FragColor = vec4(outRGB, 0.0);
}
`;

export function createUnderwaterSnowMaterial(shared: SharedUnderwaterUniforms): T.ShaderMaterial {
  return new T.ShaderMaterial({
    name: 'AbyssalMarineSnow',
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
    uniforms: { ...shared },
    vertexShader: W_SNOW_VS,
    fragmentShader: W_SNOW_FS,
  });
}

// ============================================================================
// 9. `W_ANIM` — GPU Schooling Fish (with Swimmer/Boat Repulsion) & Manta Rays
// ============================================================================

const W_FISH_VS = /* glsl */ `
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

attribute vec4 aFishA; // centerX, centerY, centerZ, orbitRadius
attribute vec4 aFishB; // fishSeed, omega, sizeScale, schoolSeed

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
flat out float vFishSeed;
varying float vShadowLit;

void main() {
  float s = aFishB.x;
  vec3 h = vec3(uwHash1(s), uwHash1(s + 0.37), uwHash1(s + 0.71));
  float R = max(aFishA.w, 1.5);
  float t = uTime;
  float ta = t * aFishB.y + aFishB.w * 6.3 + (h.x - 0.5) * (26.0 / R);
  float ph = aFishB.w * 17.0;
  float vAmp = min(2.2, max(0.22, (WATER_Y - 0.65 - aFishA.y) * 0.45));

  vec3 P = aFishA.xyz + vec3(R * cos(ta), vAmp * sin(3.0 * ta + ph), R * 0.6 * sin(ta));
  vec3 Tdir = normalize(vec3(-R * sin(ta), 3.0 * vAmp * cos(3.0 * ta + ph), R * 0.6 * cos(ta))) * (aFishB.y >= 0.0 ? 1.0 : -1.0);
  vec3 S = normalize(cross(vec3(0.0, 1.0, 0.0), Tdir));
  vec3 Up = cross(Tdir, S);
  vec3 off = S * ((h.y - 0.5) * 5.0 + sin(t * 0.6 + s * 40.0) * 0.5)
           + Up * ((h.z - 0.5) * min(3.2, vAmp * 1.4) + cos(t * 0.5 + s * 31.0) * 0.35);

  vec3 l = position * aFishB.z * (0.75 + 0.5 * h.z);
  l.z += sin(t * 9.0 + s * 50.0 + l.x * 5.0) * 0.22 * (0.25 * aFishB.z - l.x);

  vec3 w = P + off + Tdir * l.x + Up * l.y + S * l.z;

  // Interactive swimmer / boat repulsion
  vec3 away = w - uRepelPos.xyz;
  float ad = length(away);
  if (ad < uRepelPos.w && ad > 1e-3) {
    w += (away / ad) * uwSS(uRepelPos.w, 0.5, ad) * 2.2;
  }
  w.y = min(w.y, WATER_Y - 0.22);

  vWorldPos = w;
  vWorldNormal = normalize(Tdir * normal.x + Up * normal.y + S * normal.z);
  vObjPos = position;
  vFishSeed = s;
  vShadowLit = uwShadow1(w);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const W_FISH_FS = /* glsl */ `
precision highp float;
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
flat in float vFishSeed;
varying float vShadowLit;

void main() {
  vec3 n = normalize(vWorldNormal);
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float z = uwZone(vWorldPos);
  vec2 os = uwOpenSky(vWorldPos);

  vec3 alb = mix(vec3(0.50, 0.68, 0.80), vec3(0.10, 0.22, 0.40), uwSS(-0.05, 0.20, vObjPos.y));
  alb = mix(alb, vec3(0.95, 0.80, 0.30), step(0.86, fract(vFishSeed * 7.7)) * 0.65);

  vec3 E = uwSunE(vWorldPos.y, z, L) * uSunTint * vShadowLit;
  vec3 c = alb * (E * (0.25 + 0.75 * uwSat(dot(n, L))) + uwAmb(vWorldPos, n, os.y, z) * 1.3);
  c += E * pow(uwSat(dot(n, normalize(V + L))), 24.0) * 1.6
     + vec3(0.30, 0.60, 0.70) * pow(1.0 - uwSat(dot(n, V)), 3.0) * 0.25 * os.y;

  vec3 finalCol = uwApplyFog(c, vWorldPos, cameraPosition, z, L, os.y);
  if (cameraPosition.y > WATER_Y + 0.05) {
    float airBlend = uwSS(WATER_Y + 0.05, WATER_Y + 0.65, cameraPosition.y);
    float subPath = max(0.0, (WATER_Y - vWorldPos.y) / max(-V.y, 0.12));
    finalCol = mix(finalCol, c * exp(-uwSg(z) * min(subPath, 65.0)), airBlend);
  }
  gl_FragColor = vec4(uwSafeHDR(finalCol, 20.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createUnderwaterFishMaterial(shared: SharedUnderwaterUniforms): T.ShaderMaterial {
  return new T.ShaderMaterial({
    name: 'AbyssalFishSchools',
    uniforms: { ...shared },
    vertexShader: W_FISH_VS,
    fragmentShader: W_FISH_FS,
  });
}

const W_MANTA_VS = /* glsl */ `
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

attribute float aAux; // wing span u in [-1, 1]
attribute vec4 aMantaA; // cx, cy, cz, orbitRadius
attribute vec4 aMantaB; // phase0, omega, sizeScale, seed

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
flat out float vMantaSeed;

void main() {
  float t = uTime;
  float R = max(aMantaA.w, 4.0);
  float sz = aMantaB.z;
  float ta = t * aMantaB.y + aMantaB.x;

  vec3 P = aMantaA.xyz + vec3(R * cos(ta), 2.5 * sin(2.0 * ta + aMantaB.w), R * 0.75 * sin(ta));
  vec3 Tdir = normalize(vec3(-R * sin(ta), 5.0 * cos(2.0 * ta + aMantaB.w), R * 0.75 * cos(ta))) * (aMantaB.y >= 0.0 ? 1.0 : -1.0);
  vec3 S = normalize(cross(vec3(0.0, 1.0, 0.0), Tdir));
  vec3 Up = cross(Tdir, S);

  float bank = -0.28 * (aMantaB.y >= 0.0 ? 1.0 : -1.0);
  vec3 S2 = S * cos(bank) + Up * sin(bank);
  Up = Up * cos(bank) - S * sin(bank);
  S = S2;

  float u = aAux;
  float au = abs(u);
  float fp = t * 1.25 + aMantaB.w * 5.0 - au * 1.2;
  float amp = 0.36 * pow(max(au, 1e-4), 1.6);

  vec3 l = position;
  l.y += amp * sin(fp) - 0.10 * sin(t * 1.25 + aMantaB.w * 5.0);
  float tail = uwSS(-0.5, -1.9, l.z) * step(au, 0.001);
  l.x += tail * sin(t * 0.8 + l.z * 2.0) * 0.12;

  // Analytical derivative dy/du for flexing wing lighting normals
  float sl = (0.576 * pow(max(au, 1e-4), 0.6) * sin(fp) - 0.43 * pow(max(au, 1e-4), 1.6) * cos(fp)) * sign(u);
  vec3 ln = normalize(vec3(normal.x - sl * normal.y, normal.y + sl * normal.x, normal.z));

  vec3 w = P + (S * l.x + Up * l.y + Tdir * l.z) * sz;
  w.y = min(w.y, WATER_Y - 1.2);

  vWorldPos = w;
  vWorldNormal = normalize(S * ln.x + Up * ln.y + Tdir * ln.z);
  vObjPos = position;
  vMantaSeed = aMantaB.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const W_MANTA_FS = /* glsl */ `
precision highp float;
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
flat in float vMantaSeed;

void main() {
  float dist = length(vWorldPos - cameraPosition);
  vec3 ca = uwCausticsRGB(tWater, vWorldPos, dist, uSunDir);
  vec4 tx = texture(tDetail, vObjPos.xz * 0.9 + vMantaSeed);
  vec3 n = normalize(vWorldNormal + (vec3(tx.r, 0.0, tx.g) - vec3(0.5, 0.0, 0.5)) * 0.5);
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float z = uwZone(vWorldPos);
  vec2 os = uwOpenSky(vWorldPos);

  float top = uwSS(-0.20, 0.25, normalize(vWorldNormal).y);
  float au = abs(vObjPos.x);
  float gill = uwSS(0.25, 0.0, abs(au - 0.13) * 8.0)
             * uwSS(0.04, 0.12, vObjPos.z)
             * uwSS(0.34, 0.26, vObjPos.z)
             * uwSS(0.2, 0.8, sin(vObjPos.z * 110.0));

  vec3 belly = vec3(0.18, 0.23, 0.27) * (0.6 + 0.6 * tx.b) * (1.0 - 0.7 * gill);
  belly = mix(belly, vec3(0.05, 0.08, 0.11), uwSat(uwSS(0.45, 0.90, au + tx.a * 0.35) + uwSS(-0.1, -0.4, vObjPos.z + tx.b * 0.2) * 0.7));
  vec3 back = vec3(0.04, 0.065, 0.10) + vec3(0.10, 0.16, 0.20) * uwSS(0.50, 0.75, tx.a);
  back = mix(back, vec3(0.36, 0.46, 0.52), uwSS(0.25, 0.0, abs(au - 0.26) * 3.5 + abs(vObjPos.z - 0.12) * 5.0) * 0.8);
  vec3 alb = mix(belly, back, top);

  vec3 E = uwSunE(vWorldPos.y, z, L) * uSunTint * uwShadow4(vWorldPos + n * 0.3);
  float ndv = uwSat(dot(n, V));
  vec3 ir = 0.5 + 0.5 * cos(UW_TAU * (vec3(0.0, 0.33, 0.67) + ndv * 1.1 + tx.a * 1.5 + 0.55));
  vec3 fillN = vec3(n.x, abs(n.y) * 0.55 + 0.25, n.z);

  vec3 c = alb * (E * uwSat(dot(n, L)) * (0.3 + ca) + uwAmb(vWorldPos, fillN, os.y, z) * 1.1 + uwSide(vWorldPos, n, 1.0, z) * 0.8);
  c += ir * vec3(0.35, 0.16, 0.60) * (0.07 + 0.22 * tx.b) * (0.4 + E.g * 0.2 * ca.g) * (1.0 - top * 0.3);
  c += E * pow(uwSat(dot(n, normalize(V + L))), 30.0) * 0.5 * (0.3 + ca);
  vec3 sky = uwAmb(vWorldPos, vec3(0.0, 1.0, 0.0), os.y, z);
  c += alb * sky * ca * 0.45 * (1.0 - top) + sky * pow(1.0 - ndv, 3.0) * 0.35;

  gl_FragColor = vec4(uwSafeHDR(uwApplyFog(c, vWorldPos, cameraPosition, z, L, os.y), 20.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createUnderwaterMantaMaterial(shared: SharedUnderwaterUniforms): T.ShaderMaterial {
  return new T.ShaderMaterial({
    name: 'AbyssalMantaRays',
    side: T.DoubleSide,
    uniforms: { ...shared },
    vertexShader: W_MANTA_VS,
    fragmentShader: W_MANTA_FS,
  });
}

// ============================================================================
// 10. Submerged Far Horizon Backdrop Dome (`W_SURF` `vsB` / `fsB`)
// ============================================================================

const W_BACKDROP_VS = /* glsl */ `
varying vec3 vRayDir;
void main() {
  vRayDir = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + position, 1.0);
}
`;

const W_BACKDROP_FS = /* glsl */ `
precision highp float;
${UNDERWATER_OPTICS_GLSL}
${UNDERWATER_SCENE_SAMPLERS_GLSL}

varying vec3 vRayDir;

void main() {
  vec3 rd = normalize(vRayDir);
  vec3 p = cameraPosition + rd * 240.0;
  float z = uwZone(p);
  vec3 col = uwApplyFog(vec3(0.0), p, cameraPosition, z, uSunDir, 1.0);
  gl_FragColor = vec4(uwSafeHDR(col, 16.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createUnderwaterBackdropMaterial(shared: SharedUnderwaterUniforms): T.ShaderMaterial {
  return new T.ShaderMaterial({
    name: 'AbyssalSubmergedBackdrop',
    side: T.BackSide,
    depthWrite: false,
    uniforms: { ...shared },
    vertexShader: W_BACKDROP_VS,
    fragmentShader: W_BACKDROP_FS,
  });
}
