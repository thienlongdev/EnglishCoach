/* Echo Living Planet — materials. Single forward pass (no post-processing): micro-detail, radial sky light, day/night,
   twilight and aerial perspective are computed inside the material shaders (after the REA Claybound findings:
   derivative bump without tangents, roughness from the procedural detail, analytic aerial light, procedural
   environment instead of downloaded maps). uDetail (0..3) is the graphics tier's shader detail. */
import * as THREE from 'three';

export const shared = {
  uTime: { value: 0 },
  /** Direction towards the sun, world space (one sun for land, sea, sky, clouds, moon and shadows). */
  uSunDir: { value: new THREE.Vector3(-0.5, 0.6, 0.6).normalize() },
  uSkyAmb: { value: new THREE.Color('#78a6dc').multiplyScalar(0.62) },
  uGroundAmb: { value: new THREE.Color('#3a3226').multiplyScalar(0.55) },
  uNightAmb: { value: new THREE.Color('#2a3d66').multiplyScalar(0.17) },
  uHaze: { value: new THREE.Color('#8fc7ff') },
  uHazeK: { value: 1 },
  uDetail: { value: 1 },
  uRadius: { value: 100 },
  uDay: { value: 0 },          // 0 = space around the globe, 1 = a day sky over the ground
  /** Volcano crater (world) and its glow (rises during an eruption). */
  uLavaPos: { value: new THREE.Vector3(0, 0, 0) },
  uLavaGlow: { value: 0 },
  /** Ocean inertia: agitation 0..1 and the lagging rotation (axis × angle) of the wave field while the view turns. */
  uAgitation: { value: 0 },
  uDrift: { value: new THREE.Vector3() },
  /** Two ripples the learner's touch set on the sea (surfaceFx.ts): xyz = the touched direction, w = start time (uTime); old ones are ignored. */
  uRipple0: { value: new THREE.Vector4(0, 1, 0, -1e4) },
  uRipple1: { value: new THREE.Vector4(0, 1, 0, -1e4) },
};

const COMMON = /* glsl */ `
uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSkyAmb; uniform vec3 uGroundAmb; uniform vec3 uNightAmb; uniform vec3 uHaze; uniform float uHazeK;
uniform float uDetail; uniform float uRadius; uniform vec3 uLavaPos; uniform float uLavaGlow;
varying vec3 vWorld; varying vec3 vRadialV;
float odHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float odNoise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(mix(odHash(i), odHash(i + vec3(1,0,0)), f.x), mix(odHash(i + vec3(0,1,0)), odHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(odHash(i + vec3(0,0,1)), odHash(i + vec3(1,0,1)), f.x), mix(odHash(i + vec3(0,1,1)), odHash(i + vec3(1,1,1)), f.x), f.y), f.z); }
vec3 odPerturb(vec3 p, vec3 n, float h, float side){ vec3 sx = dFdx(p), sy = dFdy(p); vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * side; if (abs(det) < 1e-8) return n; vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2); return normalize(abs(det) * n - g); }
// Day (1) / night (0) at a place, and the warm band of sunrise / sunset around the terminator.
float odDayK(vec3 world){ return smoothstep(-0.2, 0.26, dot(normalize(world), uSunDir)); }
float odTwilight(vec3 world){ float s = dot(normalize(world), uSunDir); return exp(-s * s * 26.0) * smoothstep(-0.32, 0.02, s); }
vec3 odAerial(vec3 c, vec3 world){
  vec3 V = normalize(cameraPosition - world); vec3 up = normalize(world);
  float limb = pow(1.0 - clamp(dot(V, up), 0.0, 1.0), 2.6);
  float dist = length(cameraPosition - world);
  float k = clamp(limb * 0.62 + smoothstep(140.0, 700.0, dist) * 0.12, 0.0, 0.78) * uHazeK;
  float day = odDayK(world), tw = odTwilight(world);
  vec3 haze = mix(uHaze * vec3(0.08, 0.1, 0.2), uHaze, day) + vec3(0.9, 0.42, 0.16) * tw * 0.55;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(c, vec3(l), k * 0.2);
  return mix(c, haze, k * mix(0.35, 1.0, day));
}
// Light of the volcano's lava on the land around it (no extra light source: a local, analytic glow).
vec3 odLavaLight(vec3 world, vec3 nView){
  vec3 d = uLavaPos - world; float r = length(d);
  vec3 dv = normalize(mat3(viewMatrix) * (d / max(r, 1e-3)));
  return vec3(1.0, 0.36, 0.08) * uLavaGlow * exp(-r * 0.2) * (0.35 + 0.65 * max(dot(nView, dv), 0.0));
}`;

const VERTEX_COMMON = /* glsl */ `
uniform float uTime; uniform vec3 uSunDir; uniform float uRadius;
varying vec3 vWorld; varying vec3 vRadialV;`;

type Shader = THREE.WebGLProgramParametersWithUniforms;
const addUniforms = (sh: Shader) => { Object.assign(sh.uniforms, shared); };
/** Sky light from the planet's own up direction (a radial hemisphere light), dimmed to moonlight on the night side. */
const RADIAL_AMBIENT = `#include <lights_fragment_maps>
  { float hemi = dot(normal, normalize(vRadialV)) * 0.5 + 0.5; float odDay = odDayK(vWorld);
    irradiance += mix(uNightAmb * (0.55 + 0.45 * hemi), mix(uGroundAmb, uSkyAmb, hemi), odDay); }`;
/** After lighting: twilight warmth on the lit side, lava light, aerial perspective. */
const FINISH = (lava = true) => `outgoingLight *= mix(vec3(1.0), vec3(1.3, 0.84, 0.62), odTwilight(vWorld) * 0.85);
  ${lava ? 'outgoingLight += diffuseColor.rgb * odLavaLight(vWorld, normal);' : ''}
  outgoingLight = odAerial(outgoingLight, vWorld);
  #include <opaque_fragment>`;

/** Terrain: albedo from the builder + procedural micro-detail, slope rock strata, cavities, snow glint, sand ripples,
    caustics, lava; roughness from the surface kind (wet sand and snow shine, grass and rock stay matte). */
export function terrainMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 });
  m.onBeforeCompile = sh => {
    addUniforms(sh);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${VERTEX_COMMON}\nattribute vec4 surface; varying vec4 vSurf;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n vSurf = surface; vec4 odW = modelMatrix * vec4(transformed, 1.0); vWorld = odW.xyz; vRadialV = normalize(mat3(viewMatrix) * normalize(odW.xyz));`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${COMMON}\nvarying vec4 vSurf; float odH; float odWet; float odRock;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float rad = length(vWorld); float elev = rad - uRadius;
        vec3 q = vWorld;
        // Every octave fades out before it is smaller than a pixel (no speckled aliasing on far slopes).
        float fw = length(fwidth(vWorld));
        float k3 = 1.0 - smoothstep(0.06, 0.16, fw), k4 = 1.0 - smoothstep(0.025, 0.07, fw), k5 = 1.0 - smoothstep(0.012, 0.03, fw);
        float n1 = odNoise(q * 0.9), n2 = odNoise(q * 2.7 + 7.3), n3 = uDetail > 0.5 ? mix(0.5, odNoise(q * 6.3 + 1.7), k3) : 0.5;
        float n4 = uDetail > 1.5 ? mix(0.5, odNoise(q * 15.0 + 3.3), k4) : 0.5, n5 = uDetail > 2.5 ? mix(0.5, odNoise(q * 34.0 + 9.1), k5) : 0.5;
        float grass = 1.0 - clamp(vSurf.x + vSurf.y + vSurf.z, 0.0, 1.0);
        odRock = vSurf.x;
        // Macro variation: lush hollows, sun-dried rises, so meadows are never one flat colour.
        float macro = odNoise(q * 0.33 + 2.0);
        vec3 lush = diffuseColor.rgb * vec3(0.86, 1.02, 0.88), dry = diffuseColor.rgb * vec3(1.12, 1.06, 0.82);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(lush, dry, smoothstep(0.35, 0.75, macro + elev * 0.05)), grass * 0.55);
        // Meadow patches, tufts and (on higher tiers) blades.
        diffuseColor.rgb *= mix(1.0, 0.8 + 0.3 * n1 + 0.16 * (n2 - 0.5) + 0.12 * (n3 - 0.5) + 0.1 * (n4 - 0.5) + 0.07 * (n5 - 0.5), grass);
        // Rock strata following altitude, broken by noise, with darker cracks.
        float strata = 0.5 + 0.5 * sin(rad * 2.4 + n1 * 3.0 + n2 * 1.5);
        float crack = smoothstep(0.62, 0.9, abs(n3 * 2.0 - 1.0)) * (uDetail > 0.5 ? k3 : 0.0);
        diffuseColor.rgb *= mix(1.0, (0.78 + 0.28 * strata + 0.08 * (n4 - 0.5)) * (1.0 - 0.22 * crack), vSurf.x);
        // Sand ripples and wet sand at the waterline.
        diffuseColor.rgb *= mix(1.0, 0.93 + 0.09 * sin(dot(q, vec3(2.3, 1.7, 2.9)) * (1.0 + 0.6 * step(1.5, uDetail)) + n2 * 3.0), vSurf.z);
        odWet = smoothstep(uRadius + 0.38, uRadius, rad) * step(uRadius - 0.6, rad);
        diffuseColor.rgb *= 1.0 - 0.3 * odWet;
        // Snow: soft blue in hollows, bright on crests.
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.88, 0.95, 1.06), vSurf.y * (1.0 - n2) * 0.6);
        // Seabed caustics (the water above is transparent in the shallows).
        if (rad < uRadius) {
          float depth = uRadius - rad;
          vec3 c = q * 1.4 + vec3(uTime * 0.25, uTime * 0.17, -uTime * 0.21);
          float caustic = pow(1.0 - abs(odNoise(c) * 2.0 - 1.0), 6.0) + pow(1.0 - abs(odNoise(c * 1.7 + 3.0) * 2.0 - 1.0), 6.0) * 0.6;
          diffuseColor.rgb += vec3(0.35, 0.55, 0.5) * caustic * smoothstep(3.5, 0.3, depth) * 0.35 * odDayK(vWorld);
        }
        odH = (n1 * 0.4 + n2 * 0.34 + n3 * 0.14 + n4 * 0.08 + n5 * 0.04) * (0.3 + vSurf.x * 1.1 + grass * 0.35 + vSurf.z * 0.2) - crack * vSurf.x * 0.25;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(mix(0.95, 0.84 - 0.1 * n2, odRock), 0.0, 1.0);
        roughnessFactor = mix(roughnessFactor, 0.42, odWet * 0.8);
        roughnessFactor = mix(roughnessFactor, 0.55 + 0.25 * n3, vSurf.y);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n normal = odPerturb(-vViewPosition, normal, odH * (0.16 + 0.05 * uDetail), faceDirection);`)
      .replace('#include <lights_fragment_maps>', RADIAL_AMBIENT)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float lavaPulse = 0.72 + 0.28 * sin(uTime * 2.2 + length(vWorld) * 3.0) + uLavaGlow * 0.6;
        totalEmissiveRadiance += vec3(1.6, 0.42, 0.06) * vSurf.w * lavaPulse;`)
      .replace('#include <opaque_fragment>', FINISH());
  };
  m.customProgramCacheKey = () => 'od-planet-terrain-2';
  return m;
}

/** Instanced props: per-instance tint on the masked parts, windows that light up at night, a breeze and soft
    translucency in the canopies, a little grime at the foot of walls. */
export function propMaterial(opts: { wind: number; detail?: boolean; rough?: number; smooth?: boolean }) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: opts.rough ?? 0.86, metalness: 0 });
  m.onBeforeCompile = sh => {
    addUniforms(sh); sh.uniforms.uWind = { value: opts.wind };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${VERTEX_COMMON}\nuniform float uWind; attribute float aTint; attribute float aGlow; varying float vGlow; varying float vTint; varying float vLocalY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 odBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float odSway = max(transformed.y - 0.35, 0.0); odSway *= odSway;
        float gust = 0.75 + 0.25 * sin(uTime * 0.31 + odBase.x * 0.05);
        transformed.x += sin(uTime * 1.35 + odBase.x * 0.61 + odBase.z * 0.37) * 0.06 * odSway * uWind * gust;
        transformed.z += sin(uTime * 1.05 + odBase.y * 0.53) * 0.045 * odSway * uWind * gust;
        vGlow = aGlow; vTint = aTint; vLocalY = position.y; vRadialV = normalize(mat3(viewMatrix) * normalize(odBase));
        vWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb = mix(color.rgb, color.rgb * instanceColor.rgb, aTint);
        #endif`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${COMMON}\nuniform float uWind; varying float vGlow; varying float vTint; varying float vLocalY; float odH;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${opts.detail ? `float d1 = odNoise(vWorld * 1.9), d2 = odNoise(vWorld * 5.1 + 3.1), d3 = uDetail > 1.5 ? odNoise(vWorld * 13.0) : 0.5;
          diffuseColor.rgb *= 0.82 + 0.26 * d1 + 0.08 * (d2 - 0.5) + 0.06 * (d3 - 0.5); odH = d1 * 0.6 + d2 * 0.3 + d3 * 0.1;
          diffuseColor.rgb *= mix(0.86, 1.0, smoothstep(0.0, 0.6, vLocalY));`
          : opts.smooth ? `float d1 = odNoise(vWorld * 1.7); diffuseColor.rgb *= 0.95 + 0.08 * d1; odH = 0.0;
          // Roofs: courses of tiles; walls: a little grime at the foot.
          diffuseColor.rgb *= mix(1.0, 0.9 + 0.1 * step(0.5, fract(vLocalY * 11.0)), vTint * step(0.5, uDetail));
          diffuseColor.rgb *= mix(0.78, 1.0, smoothstep(0.0, 0.22, vLocalY));`
          : `float d1 = odNoise(vWorld * 6.0), d2 = uDetail > 1.5 ? odNoise(vWorld * 17.0 + 2.0) : 0.5;
          diffuseColor.rgb *= 0.88 + 0.22 * d1 + 0.08 * (d2 - 0.5); odH = d1 * 0.8 + d2 * 0.2;
          diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(0.1, 0.9, vLocalY));`}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n normal = odPerturb(-vViewPosition, normal, odH * ${opts.detail ? '0.16' : opts.smooth ? '0.0' : '0.05'}, faceDirection);`)
      .replace('#include <lights_fragment_maps>', RADIAL_AMBIENT)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float odNight = 1.0 - odDayK(vWorld);
        totalEmissiveRadiance += diffuseColor.rgb * vGlow * (0.9 + 3.2 * odNight);
        ${opts.wind ? `// Leaves let the light through when the sun is behind them.
        vec3 odV = normalize(cameraPosition - vWorld);
        totalEmissiveRadiance += diffuseColor.rgb * vTint * pow(max(dot(-odV, uSunDir), 0.0), 3.0) * 0.38 * odDayK(vWorld);` : ''}`)
      .replace('#include <opaque_fragment>', FINISH());
  };
  m.customProgramCacheKey = () => `od-planet-prop-2-${opts.wind}-${!!opts.detail}-${!!opts.smooth}`;
  return m;
}

/** Landmarks and bridges: plaster/stone grain, windows and lanterns that glow brighter at night. */
export function landmarkMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.76, metalness: 0.02 });
  m.onBeforeCompile = sh => {
    addUniforms(sh);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${VERTEX_COMMON}\nattribute float aGlow; varying float vGlow;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n vGlow = aGlow; vec4 odW = modelMatrix * vec4(transformed, 1.0); vWorld = odW.xyz; vRadialV = normalize(mat3(viewMatrix) * normalize(odW.xyz));`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\n${COMMON}\nvarying float vGlow; float odH;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float g1 = odNoise(vWorld * 1.3), g2 = odNoise(vWorld * 4.2 + 5.0), g3 = uDetail > 1.5 ? odNoise(vWorld * 11.0 + 1.0) : 0.5;
        diffuseColor.rgb *= mix(0.92 + 0.11 * g1 + 0.05 * (g2 - 0.5) + 0.05 * (g3 - 0.5), 1.0, vGlow);
        // Weathering: darker towards the ground, as stone and plaster really age.
        float odFoot = smoothstep(0.0, 1.6, length(vWorld) - uRadius);
        diffuseColor.rgb *= mix(1.0, mix(0.84, 1.0, odFoot), 1.0 - vGlow);
        odH = (g1 * 0.45 + g2 * 0.4 + g3 * 0.15) * (1.0 - vGlow);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n normal = odPerturb(-vViewPosition, normal, odH * 0.016, faceDirection);`)
      .replace('#include <lights_fragment_maps>', RADIAL_AMBIENT)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float odNight = 1.0 - odDayK(vWorld);
        totalEmissiveRadiance += diffuseColor.rgb * vGlow * (1.5 + 0.25 * sin(uTime * 3.0 + vWorld.x) + 2.6 * odNight);`)
      .replace('#include <opaque_fragment>', FINISH());
  };
  m.customProgramCacheKey = () => 'od-planet-landmark-2';
  return m;
}

/** Ocean: analytic directional swells (normals from their exact gradient, faded below the pixel size so far water
    never sparkles into noise), depth-graded colour, Fresnel sky, sun and moon glints, breaking foam bands on the
    shore, whitecaps that rise with agitation, and a wave field that lags behind the view's rotation and settles
    back (inertia) — coastlines never move. uDetail sets the number of wave trains. */
export function oceanMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { ...shared, uShallow: { value: new THREE.Color('#57e6d6') }, uMid: { value: new THREE.Color('#13a8c6') }, uDeep: { value: new THREE.Color('#0a4f98') }, uAbyss: { value: new THREE.Color('#062a66') },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) } },
    vertexShader: /* glsl */ `attribute float depth; varying float vDepth; varying vec3 vWorld; uniform float uTime;
      void main(){ vDepth = depth; vec3 p = position; vWorld = (modelMatrix * vec4(p, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0); }`,
    fragmentShader: /* glsl */ `precision highp float;
      uniform float uTime; uniform vec3 uSunDir; uniform vec3 uHaze; uniform float uHazeK; uniform float uRadius; uniform float uDetail; uniform float uDay;
      uniform float uAgitation; uniform vec3 uDrift; uniform vec3 uMoonDir; uniform vec4 uRipple0; uniform vec4 uRipple1;
      uniform vec3 uShallow; uniform vec3 uMid; uniform vec3 uDeep; uniform vec3 uAbyss;
      varying float vDepth; varying vec3 vWorld;
      // A touch on the water: rings travelling out from the touched point, bending the normal and catching a little light.
      void ripple(vec3 up, vec4 R, inout vec3 grad, inout float glow){
        float age = uTime - R.w; if (age < 0.0 || age > 4.5) return;
        vec3 c = normalize(R.xyz); float cd = dot(up, c); if (cd < 0.98) return;
        float dist = acos(clamp(cd, -1.0, 1.0)) * uRadius, x = dist - age * 2.6;
        float env = exp(-x * x * 0.22) * (1.0 - age / 4.5) * smoothstep(0.0, 0.25, age) * smoothstep(9.0, 2.0, dist);
        vec3 t = up * cd - c; float tl = length(t); if (tl < 1e-5) return; t /= tl;
        float k = 3.1, a = 0.16 * env;
        grad += t * (a * k * cos(k * x)) * 1.6;
        glow += env * (0.35 + 0.35 * sin(k * x));
      }
      float odHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float odNoise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        return mix(mix(mix(odHash(i), odHash(i + vec3(1,0,0)), f.x), mix(odHash(i + vec3(0,1,0)), odHash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(odHash(i + vec3(0,0,1)), odHash(i + vec3(1,0,1)), f.x), mix(odHash(i + vec3(0,1,1)), odHash(i + vec3(1,1,1)), f.x), f.y), f.z); }
      // One wave train: direction (3D, travels across the sphere), wavelength, steepness, speed.
      float gAmp; float gNear;
      void wave(vec3 p, vec3 d, float len, float steep, float speed, float footprint, inout vec3 grad, inout float h){
        float k = 6.2831853 / len; float fade = (1.0 - smoothstep(len * 0.12, len * 0.33, footprint)) * gNear;
        if (fade <= 0.0) return;
        float a = steep / k * fade * (1.0 + uAgitation * 0.9); gAmp += steep / k * (1.0 + uAgitation * 0.9);
        float ph = k * dot(p, d) - speed * k * uTime;
        h += a * sin(ph); grad += d * (a * k * cos(ph));
      }
      void main(){
        vec3 up = normalize(vWorld);
        float footprint = length(fwidth(vWorld));
        // The wave field lags behind the view's rotation (small-angle rotation by uDrift), then settles back.
        vec3 p = vWorld + cross(uDrift, vWorld);
        vec3 grad = vec3(0.0); float h = 0.0; gAmp = 1e-4;
        // Swells are a near view: from orbit the sea reads as calm glass with a sun glint.
        gNear = 1.0 - 0.92 * smoothstep(110.0, 300.0, length(cameraPosition - vWorld));
        wave(p, normalize(vec3(0.83, 0.12, 0.55)), 11.0, 0.32, 1.1, footprint, grad, h);
        wave(p, normalize(vec3(-0.35, 0.28, 0.89)), 6.3, 0.28, 0.85, footprint, grad, h);
        if (uDetail > 0.5) wave(p, normalize(vec3(0.42, -0.86, 0.29)), 3.7, 0.24, 0.66, footprint, grad, h);
        if (uDetail > 1.5) wave(p, normalize(vec3(-0.71, -0.33, -0.62)), 2.2, 0.2, 0.52, footprint, grad, h);
        if (uDetail > 2.5) { wave(p, normalize(vec3(0.15, 0.97, -0.2)), 1.3, 0.18, 0.4, footprint, grad, h); wave(p, normalize(vec3(-0.9, 0.1, 0.42)), 0.85, 0.16, 0.33, footprint, grad, h); }
        // Fine ripples as noise, only where a pixel is small enough to hold them.
        float fine = odNoise(p * 1.8 + vec3(uTime * 0.31, 0.0, uTime * 0.2)) * 0.6 + odNoise(p * 4.1 - vec3(0.0, uTime * 0.37, uTime * 0.23)) * 0.4;
        float rippleGlow = 0.0; ripple(up, uRipple0, grad, rippleGlow); ripple(up, uRipple1, grad, rippleGlow);
        vec3 n = normalize(up - (grad - up * dot(grad, up)) * 0.55);
        vec3 sx = dFdx(vWorld), sy = dFdy(vWorld); vec3 r1 = cross(sy, up), r2 = cross(up, sx); float det = dot(sx, r1);
        float fineK = (1.0 - smoothstep(0.05, 0.22, footprint)) * 0.22 * gNear;
        if (abs(det) > 1e-8 && fineK > 0.0) { vec3 g = sign(det) * (dFdx(fine * fineK) * r1 + dFdy(fine * fineK) * r2); n = normalize(abs(det) * n - g); }
        vec3 V = normalize(cameraPosition - vWorld);
        float d = max(vDepth, 0.0);
        float day = smoothstep(-0.2, 0.26, dot(up, uSunDir)), tw = exp(-pow(dot(up, uSunDir), 2.0) * 26.0) * smoothstep(-0.32, 0.02, dot(up, uSunDir));
        vec3 col = mix(uShallow, uMid, smoothstep(0.2, 2.4, d)); col = mix(col, uDeep, smoothstep(2.0, 5.0, d)); col = mix(col, uAbyss, smoothstep(5.0, 7.0, d));
        // Light under the surface: the wave crest facing the sun is a little greener and brighter.
        col += vec3(0.02, 0.09, 0.07) * max(h, 0.0) * 1.8;
        float fres = pow(1.0 - clamp(dot(V, n), 0.0, 1.0), 4.0);
        vec3 skyDay = mix(vec3(0.5, 0.74, 0.96), uHaze, 0.45), skySpace = vec3(0.05, 0.09, 0.18);
        col = mix(col, mix(skySpace, skyDay, max(uDay, day * 0.6)), fres * 0.5);
        float diffuse = clamp(dot(up, uSunDir) * 0.55 + 0.45, 0.0, 1.0);
        col *= mix(0.1, 1.0, day) * mix(0.55, 1.0, diffuse);
        col *= mix(vec3(1.0), vec3(1.25, 0.85, 0.66), tw * 0.8);
        vec3 Hv = normalize(uSunDir + V); float nh = clamp(dot(n, Hv), 0.0, 1.0);
        float spec = pow(nh, 320.0) * 1.5 * mix(0.25, 1.0, gNear) + pow(nh, 30.0) * 0.14 + pow(clamp(dot(up, Hv), 0.0, 1.0), 90.0) * 0.5 * (1.0 - gNear);
        col += mix(vec3(1.0, 0.93, 0.78), vec3(1.0, 0.62, 0.32), tw) * spec * step(0.0, dot(up, uSunDir));
        // Moon glints on the night side.
        float mh = clamp(dot(n, normalize(uMoonDir + V)), 0.0, 1.0);
        col += vec3(0.55, 0.65, 0.9) * (pow(clamp(dot(up, normalize(uMoonDir + V)), 0.0, 1.0), 400.0) * 0.18 + pow(mh, 160.0) * 0.5 * gNear) * (1.0 - day);
        // Shore: foam bands rolling in towards the beach, breaking up with the noise; whitecaps offshore.
        float shore = 1.0 - smoothstep(0.0, 0.7, d);
        float bands = smoothstep(0.55, 1.0, sin(d * 13.0 - uTime * 1.9 + odNoise(vWorld * 1.3) * 4.0));
        float lace = smoothstep(0.42, 0.72, odNoise(vWorld * 2.4 + vec3(uTime * 0.6, uTime * 0.3, 0.0)) + 0.25 * sin(uTime * 1.6 + d * 9.0));
        float foam = shore * (0.45 * lace + 0.55 * bands * smoothstep(0.7, 0.1, d)) * smoothstep(-0.05, 0.06, d) + (1.0 - smoothstep(0.0, 0.16, d)) * 0.6;
        float hn = h / gAmp, capPatch = smoothstep(0.55, 0.8, odNoise(vWorld * 0.45 + vec3(0.0, uTime * 0.05, 0.0)));
        float caps = smoothstep(0.78 - uAgitation * 0.2, 0.95, hn * 0.55 + fine * 0.5) * capPatch * (0.1 + uAgitation * 0.45) * smoothstep(1.5, 4.0, d) * (1.0 - smoothstep(0.12, 0.35, footprint));
        col = mix(col, vec3(0.95, 0.99, 1.0) * mix(0.12, 1.0, day) * mix(0.75, 1.0, diffuse), clamp(foam + caps, 0.0, 1.0));
        // Limb haze, as on land.
        float limb = pow(1.0 - clamp(dot(V, up), 0.0, 1.0), 2.6);
        vec3 haze = mix(uHaze * vec3(0.08, 0.1, 0.2), uHaze, day) + vec3(0.9, 0.42, 0.16) * tw * 0.55;
        col = mix(col, haze, clamp(limb * 0.66, 0.0, 0.8) * uHazeK * mix(0.35, 1.0, day));
        col += vec3(0.55, 0.85, 1.0) * rippleGlow * 0.28 * mix(0.35, 1.0, day);
        float alpha = mix(0.42, 0.97, smoothstep(0.0, 2.6, d));
        alpha = max(alpha, clamp(foam, 0.0, 1.0));
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

/** Atmosphere: an outer shell (back faces) — blue scattering on the day side, a sunset ring along the terminator and
    a bright forward-scattering halo when the sun is behind the planet — and an inner limb haze (front faces). */
export function atmosphereMaterial(inner: boolean) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: inner ? THREE.FrontSide : THREE.BackSide,
    uniforms: { uSunDir: shared.uSunDir, uDay: shared.uDay, uColor: { value: new THREE.Color(inner ? '#7ec4ff' : '#4c9cff') } },
    vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position, 1.0)).xyz; vN = normalize(vW); gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
    fragmentShader: /* glsl */ `uniform vec3 uSunDir; uniform vec3 uColor; uniform float uDay; varying vec3 vN; varying vec3 vW;
      void main(){
        vec3 V = normalize(cameraPosition - vW);
        float s = dot(vN, uSunDir);
        float day = smoothstep(-0.28, 0.35, s), twilight = exp(-s * s * 18.0);
        float forward = pow(max(dot(-V, uSunDir), 0.0), 10.0);
        vec3 tint = uColor * day + vec3(1.0, 0.45, 0.18) * twilight * 0.75 + vec3(1.0, 0.86, 0.62) * forward * 1.3;
        ${inner
          ? `float f = pow(1.0 - clamp(dot(V, vN), 0.0, 1.0), 3.6); vec3 c = tint * f * 0.42;`
          : `float f = clamp(dot(-V, vN), 0.0, 1.0); f = pow(smoothstep(0.0, 0.42, f), 2.6) * (1.0 - smoothstep(0.42, 0.55, f)); vec3 c = tint * f * 0.5;`}
        gl_FragColor = vec4(c * (1.0 - uDay * ${inner ? '0.55' : '0.92'}), 1.0);
      }`,
  });
}

/** The moon: a cratered stone lit by the same sun (its phase is real). */
export function moonMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: '#d9dce6', roughness: 1, metalness: 0 });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\nvarying vec3 vObj;`).replace('#include <begin_vertex>', `#include <begin_vertex>\n vObj = position;`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vObj; float mH;
      float mHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float mNoise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(mHash(i), mHash(i + vec3(1,0,0)), f.x), mix(mHash(i + vec3(0,1,0)), mHash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(mHash(i + vec3(0,0,1)), mHash(i + vec3(1,0,1)), f.x), mix(mHash(i + vec3(0,1,1)), mHash(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 mp = normalize(vObj) * 3.0; float maria = smoothstep(0.45, 0.62, mNoise(mp * 0.9 + 2.0));
        float craters = 0.0; for (int i = 0; i < 3; i++) { float c = mNoise(mp * (2.5 + float(i) * 3.1)); craters += smoothstep(0.62, 0.8, c) - smoothstep(0.8, 0.86, c) * 1.4; }
        diffuseColor.rgb *= (1.0 - maria * 0.32) * (0.94 + 0.12 * mNoise(mp * 9.0)) * (1.0 - craters * 0.08);
        mH = craters * 0.6 + mNoise(mp * 11.0) * 0.3;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition); vec3 r1 = cross(sy, normal), r2 = cross(normal, sx); float det = dot(sx, r1) * faceDirection;
          if (abs(det) > 1e-8) { vec3 g = sign(det) * (dFdx(mH * 0.35) * r1 + dFdy(mH * 0.35) * r2); normal = normalize(abs(det) * normal - g); } }`);
  };
  m.customProgramCacheKey = () => 'od-planet-moon-1';
  return m;
}
