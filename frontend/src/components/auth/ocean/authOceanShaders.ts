/**
 * GLSL of the sign-in ocean. ONE sky function (`ecSky`) is shared by the sky dome, the water's reflections and fog, the
 * islands' haze and their reflections: every surface meets the horizon in exactly the colour the sky has there, so the
 * world never shows a seam between "sky picture" and "sea picture".
 */

export const NOISE_GLSL = /* glsl */ `
float ecHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float ecNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ecHash(i), ecHash(i + vec2(1.0, 0.0)), u.x), mix(ecHash(i + vec2(0.0, 1.0)), ecHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float ecFbm(vec2 p, int octaves) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    v += a * ecNoise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}
`;

/** Uniforms of the sky; every material that calls ecSky declares them (values shared by reference). */
export const SKY_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uCloudCover;
uniform float uTime;
`;

export const SKY_GLSL = /* glsl */ `
vec3 ecSkyGradient(vec3 d) {
  float h = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(h, 0.42));
  col = mix(uHaze, col, smoothstep(0.0, 0.075, h));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 6.0) * 0.14 + pow(sd, 48.0) * 0.5);
  return col;
}
// Clouds on a dome above the sea, lit from the sun's side; they thin into the haze near the horizon.
vec4 ecClouds(vec3 d, int octaves) {
  if (d.y <= 0.004) return vec4(0.0);
  vec2 uv = d.xz / (d.y + 0.07) * 0.55 + vec2(uTime * 0.0035, uTime * 0.0012);
  float base = ecFbm(uv, octaves);
  float dens = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.32, base);
  dens *= smoothstep(0.012, 0.22, d.y);
  if (dens <= 0.001) return vec4(0.0);
  float toward = ecFbm(uv + uSunDir.xz * 0.09, octaves);
  float shade = clamp((toward - base) * 4.0 + 0.5, 0.0, 1.0);
  vec3 col = mix(uCloudLit, uCloudShade, shade * 0.85);
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * pow(sd, 10.0) * (1.0 - dens) * 0.9; // silver lining toward the sun
  return vec4(col, dens * 0.92);
}
vec3 ecSky(vec3 d, int octaves) {
  vec3 col = ecSkyGradient(d);
  vec4 c = ecClouds(d, octaves);
  return mix(col, c.rgb, c.a);
}
// The colour of the horizon in the direction of a point (what the far sea and far land fade into).
vec3 ecHorizonAt(vec3 dirFromCamera) {
  vec3 level = normalize(vec3(dirFromCamera.x, 0.0, dirFromCamera.z));
  return ecSkyGradient(level);
}
`;

export const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // always at the far plane
}
`;

export const SKY_FRAGMENT = /* glsl */ `
${SKY_UNIFORMS_GLSL}
uniform float uSunDisc;
uniform float uStars;
uniform float uMoon;
varying vec3 vDir;
${NOISE_GLSL}
${SKY_GLSL}
void main() {
  vec3 d = normalize(vDir);
  vec3 col = ecSkyGradient(d);
  // stars (night): a sparse hashed field that twinkles, hidden behind clouds
  if (uStars > 0.001 && d.y > 0.0) {
    vec2 sp = vec2(atan(d.x, -d.z), asin(d.y)) * 140.0;
    vec2 cell = floor(sp);
    float rnd = ecHash(cell);
    vec2 offs = vec2(ecHash(cell + 7.1), ecHash(cell + 3.3)) - 0.5;
    float star = smoothstep(0.08, 0.0, length(fract(sp) - 0.5 - offs * 0.6)) * step(0.965, rnd);
    star *= 0.6 + 0.4 * sin(uTime * (1.0 + rnd * 3.0) + rnd * 40.0);
    col += vec3(0.85, 0.9, 1.0) * star * uStars * smoothstep(0.02, 0.25, d.y);
  }
  // the sun (or the moon) itself
  float sd = dot(d, uSunDir);
  float disc = smoothstep(uSunDisc, uSunDisc + 0.00035, sd);
  vec3 discCol = mix(uSunColor * 6.0, vec3(0.92, 0.95, 1.0) * 2.4, uMoon);
  col = mix(col, discCol, disc);
  col += uSunColor * smoothstep(uSunDisc - 0.004, uSunDisc, sd) * 0.6;
  vec4 c = ecClouds(d, 5);
  col = mix(col, c.rgb, c.a);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Number of ripple slots (contact, splash and tap ripples) the water knows at once. */
export const RIPPLE_SLOTS = 24;

export const OCEAN_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uWaveTime;
uniform float uWaveScale;
uniform vec4 uWaves[6];
uniform vec4 uRipples[${RIPPLE_SLOTS}];
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vHeight;

void main() {
  vec3 p = position;
  float dist = length(p.xz - cameraPosition.xz);
  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
  vec3 disp = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    vec4 w = uWaves[i];
    float k = 6.28318 / w.w;
    float fade = 1.0 - smoothstep(w.w * 7.0, w.w * 34.0, dist); // short waves fade out with distance (no shimmer)
    float steep = w.z * uWaveScale * fade;
    if (steep <= 0.0) continue;
    float c = sqrt(9.8 / k);
    vec2 d = normalize(w.xy);
    float f = k * (dot(d, p.xz) - c * uWaveTime);
    float a = steep / k;
    float sf = sin(f), cf = cos(f);
    tangent += vec3(-d.x * d.x * steep * sf, d.x * steep * cf, -d.x * d.y * steep * sf);
    binormal += vec3(-d.x * d.y * steep * sf, d.y * steep * cf, -d.y * d.y * steep * sf);
    disp += vec3(d.x * a * cf, a * sf, d.y * a * cf);
  }
  vec3 n = normalize(cross(binormal, tangent));

  // Ripples lift the water only broadly here (the grid is too coarse for their rings); the rings themselves, their
  // light and their foam are drawn per pixel in the fragment shader.
  float rise = 0.0;
  for (int i = 0; i < ${RIPPLE_SLOTS}; i++) {
    vec4 r = uRipples[i];
    float age = uTime - r.z;
    if (r.w <= 0.0 || age < 0.0 || age > 6.0) continue;
    float rr = length(p.xz - r.xy);
    float x = rr - (0.6 + age * 2.1);
    rise += exp(-x * x * 0.35) * r.w * exp(-age * 0.75) * 0.07 + exp(-rr * rr * 0.4) * r.w * exp(-age * 1.6) * 0.12;
  }
  disp.y += rise;

  vec3 world = (modelMatrix * vec4(p + disp, 1.0)).xyz;
  vWorld = world;
  vNormalW = n;
  vHeight = disp.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const OCEAN_FRAGMENT = /* glsl */ `
${SKY_UNIFORMS_GLSL}
uniform vec3 uDeep;
uniform vec3 uScatter;
uniform vec3 uFoamColor;
uniform float uSunVisible;
uniform float uFogDensity;
uniform float uNearAlpha;
uniform float uDetail;
uniform vec4 uRipples[${RIPPLE_SLOTS}];
uniform vec4 uEcho; // x, z, radius, clarity (0..1)
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vHeight;
${NOISE_GLSL}
${SKY_GLSL}

vec2 ecDetailGrad(vec2 p) {
  float e = 0.08;
  float c = ecNoise(p);
  return vec2(ecNoise(p + vec2(e, 0.0)) - c, ecNoise(p + vec2(0.0, e)) - c) / e;
}

void main() {
  vec3 toFrag = vWorld - cameraPosition;
  float dist = length(toFrag);
  vec3 V = -toFrag / dist;
  vec3 n = normalize(vNormalW);

  // small capillary ripples riding the swell (fade with distance)
  float detailFade = (1.0 - smoothstep(18.0, 160.0, dist)) * uDetail;
  if (detailFade > 0.0) {
    vec2 g = ecDetailGrad(vWorld.xz * 0.9 + uTime * vec2(0.35, 0.12)) * 0.6
           + ecDetailGrad(vWorld.xz * 2.1 - uTime * vec2(0.18, 0.31)) * 0.3;
    n = normalize(n - vec3(g.x, 0.0, g.y) * 0.22 * detailFade);
  }

  // rings travelling out from where Echo meets the water (and from taps), damped as they go — per pixel
  float ringFoam = 0.0;
  vec2 grad = vec2(0.0);
  for (int i = 0; i < ${RIPPLE_SLOTS}; i++) {
    vec4 r = uRipples[i];
    float age = uTime - r.z;
    if (r.w <= 0.0 || age < 0.0 || age > 6.0) continue;
    vec2 dv = vWorld.xz - r.xy;
    float rr = length(dv) + 1e-4;
    float front = 0.6 + age * 2.1;
    float env = r.w * exp(-age * 0.75);
    float x = rr - front;
    float band = exp(-x * x * 0.9);
    float dh = (cos(x * 5.0) * 5.0 - sin(x * 5.0) * 1.8 * x) * band * env * 0.11;
    grad += (dv / rr) * dh;
    ringFoam += env * exp(-x * x * 3.2) * 0.32 + step(0.9, r.w) * env * exp(-rr * rr * 0.3) * 0.7 * exp(-age * 1.3); // churn only where it splashed
  }
  n = normalize(n - vec3(grad.x, 0.0, grad.y) * 0.55);

  float ndv = max(dot(n, V), 0.0);
  float fres = 0.02 + 0.8 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, n);
  R.y = abs(R.y) * 0.85 + 0.06; // reflections lean to the bluer sky above the haze band
  vec3 refl = ecSky(normalize(R), 3);

  // the water's own colour: deep blue, lifted toward the scatter tint on crests and toward the light
  float crest = clamp(vHeight * 0.9 + 0.45, 0.0, 1.0);
  vec3 body = mix(uDeep, uScatter, crest * 0.5);
  vec3 L = normalize(uSunDir);
  float sss = pow(max(dot(-V, normalize(vec3(L.x, 0.25, L.z))), 0.0), 4.0) * smoothstep(-0.1, 0.6, vHeight);
  body += uScatter * sss * 0.55;
  vec3 col = mix(body, refl, fres);

  // sunlight: a sharp core, a soft sheen, and glints on the ripples along the sun's path
  vec3 H = normalize(L + V);
  float nh = max(dot(n, H), 0.0);
  float spec = pow(nh, 420.0) * 5.0 + pow(nh, 70.0) * 0.35;
  float glint = step(0.93, ecNoise(vWorld.xz * 3.2 + uTime * 0.6)) * pow(nh, 30.0) * (1.0 - smoothstep(20.0, 200.0, dist));
  col += uSunColor * (spec + glint * 1.6) * uSunVisible;

  // foam: on the highest crests and in Echo's wake / splashes
  float lace = ecNoise(vWorld.xz * 1.7 + uTime * 0.2) * 0.6 + ecNoise(vWorld.xz * 4.3 - uTime * 0.3) * 0.4;
  float crestFoam = smoothstep(0.62, 1.05, vHeight + lace * 0.35) * 0.55;
  float wakeFoam = smoothstep(0.08, 1.4, ringFoam) * (0.35 + 0.65 * smoothstep(0.3, 0.8, lace));
  float foam = clamp(crestFoam + wakeFoam, 0.0, 1.0);
  col = mix(col, uFoamColor, foam * 0.8);

  // distance: the sea melts into the sky's own horizon colour in this direction
  float fog = 1.0 - exp(-dist * uFogDensity);
  fog = clamp(fog * fog * (3.0 - 2.0 * fog), 0.0, 1.0);
  col = mix(col, ecHorizonAt(-V), fog);

  float alpha = mix(uNearAlpha, 1.0, smoothstep(14.0, 70.0, dist));
  alpha = max(alpha, max(fres * 1.2, foam));
  vec2 eo = (vWorld.xz - uEcho.xy) / uEcho.z;
  float clear = exp(-dot(eo, eo) * 1.3) * uEcho.w;
  alpha = mix(alpha, max(0.42, foam), clear * 0.7);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const LAND_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uMirror;
varying vec3 vWorld;
varying float vLocalY;
void main() {
  vec3 p = position;
  vLocalY = p.y;
  if (uMirror > 0.5) {
    p.y = -p.y * 0.85;
    p.x += sin(p.y * 0.45 + uTime * 1.3) * 0.9 * clamp(-p.y * 0.06, 0.0, 1.0);
  }
  vec3 world = (modelMatrix * vec4(p, 1.0)).xyz;
  vWorld = world;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const LAND_FRAGMENT = /* glsl */ `
${SKY_UNIFORMS_GLSL}
uniform vec3 uLand;
uniform vec3 uLandLit;
uniform float uHazeAmount;
uniform float uMirror;
uniform float uTop;
varying vec3 vWorld;
varying float vLocalY;
${NOISE_GLSL}
${SKY_GLSL}
void main() {
  vec3 toFrag = vWorld - cameraPosition;
  vec3 dir = normalize(toFrag);
  float up = clamp(vLocalY / max(uTop, 1.0), 0.0, 1.0);
  float sunSide = clamp(dot(normalize(vec3(uSunDir.x, 0.0, uSunDir.z)), vec3(1.0, 0.0, 0.0)) * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uLand, uLandLit, up * 0.7 * (0.5 + sunSide * 0.5));
  float tex = ecNoise(vWorld.xy * 0.08) * 0.12;
  col *= 0.94 + tex;
  float haze = clamp(uHazeAmount + (1.0 - up) * 0.18, 0.0, 1.0); // the foot sits in the sea mist
  col = mix(col, ecHorizonAt(dir), haze);
  float alpha = 1.0;
  if (uMirror > 0.5) {
    col = mix(col, ecHorizonAt(dir) * 0.92, 0.35);
    alpha = 0.32 * (1.0 - up) * smoothstep(0.0, 0.25, up + 0.25);
    alpha *= 0.7 + 0.3 * ecNoise(vec2(vWorld.x * 0.3, vWorld.y * 2.0 + uTime * 2.0));
  }
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const PARTICLE_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
uniform float uPixelRatio;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uPixelRatio / max(-mv.z, 0.5), 0.0, 256.0); // uPixelRatio = device ratio × projection scale
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * mv;
}
`;

export const PARTICLE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uSoft;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  float a = smoothstep(0.5, 0.5 - uSoft, r) * vAlpha;
  if (a <= 0.003) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const GLOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
void main() {
  vec2 c = vUv - 0.5;
  float r = length(c * vec2(1.0, 2.6));
  float a = exp(-r * r * 22.0) * uIntensity + exp(-abs(c.y) * 60.0) * smoothstep(0.5, 0.0, abs(c.x)) * uIntensity * 0.35;
  gl_FragColor = vec4(uColor * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const GLOW_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
