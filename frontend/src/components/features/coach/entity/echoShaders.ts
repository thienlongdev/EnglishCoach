/**
 * ESSL 3.00 vertex and fragment shaders for the 5-layer EchoLivingEntity
 * ("Radiant Pearlescent Abyss" — Pearl x Opaline Cyan x Sapphire x Lavender x Rose Nacre).
 *
 * CRITICAL WebGL2 / Three.js invariant:
 * - Every material uses `glslVersion = THREE.GLSL3`, so Three.js WebGLProgram prepends
 *   the GLSL ES 3.00 version directive at byte 0 automatically. Shader sources below MUST NEVER
 *   embed a duplicate version directive (which causes a fatal GLSL compile error).
 *
 * Layering and render order (Premultiplied Luminescent Alpha: ONE, ONE_MINUS_SRC_ALPHA):
 * - Pass 0 (renderOrder =  5): Layer 0 Translucent sapphire-lavender refractive cushion (Light)
 *                              and opaline aurora volumetric bloom (Dark)
 * - Pass 1 (renderOrder = 10): Layer 2B BackSide Spherical Harmonic pearlescent membrane (far hemisphere)
 * - Pass 2 (renderOrder = 20): Layer 1 Radiant Pearlescent Abyss crystal sphere + aurora spectral ribbons
 *                              + 1-pass gyroid plasma filaments + pearl heart + aragonite thin-film nacre
 * - Pass 3 (renderOrder = 25): Layer 2A 5-strand opaline sinusoidal Listening harmonic wave ribbon
 * - Pass 4 (renderOrder = 30): Layer 3 Screen-space-clamped gossamer iridescent orbital light filaments
 * - Pass 5 (renderOrder = 40): Layer 4 1-pass gyroid synaptic lumina and crystalline bokeh trails
 * - Pass 6 (renderOrder = 50): Layer 2B FrontSide 3D undulating liquid-light caustic Speaking shell
 *
 * ANGLE D3D11 HLSL safety invariants:
 * - Zero ternary operators across all GLSL sources
 * - Unconditional `fwidth()` derivatives at top of `rings.frag` `main()` before any flow control
 * - Compile-time constant integer literal loop bounds in every `for` loop
 * - Radial safety vignette <= 1.80 (< 1.8594 frustum half-extent at z = 0) for zero canvas clipping
 */

export interface EchoRingDescriptor {
  /** (radius, halfWidth, tiltTheta, tiltPhi) */
  readonly cfg0: readonly [number, number, number, number];
  /** (spinSpeed, precessionSpeed, tickCount, apertureFrac) */
  readonly cfg1: readonly [number, number, number, number];
  /** (dashFreq, harmonicM, zParallaxSlot, ringRole) */
  readonly cfg2: readonly [number, number, number, number];
}

export const ECHO_CAMERA_FOV_DEG = 38;
export const ECHO_CAMERA_Z = 5.4;
export const ECHO_FRUSTUM_HALF_EXTENT = ECHO_CAMERA_Z * Math.tan((ECHO_CAMERA_FOV_DEG * 0.5 * Math.PI) / 180);
export const ECHO_VIGNETTE_OUTER_RADIUS = 1.8;

/**
 * Canonical 7-ring gossamer orbital light filament configuration:
 * Role 0: Primary inclined pearlescent orbit (R = 0.98) — always active
 * Role 1: Counter-inclined aurora filament arc (R = 1.09, rapid Thinking interleave) — always active
 * Role 2: Acoustic gaze harmonic orbit (R = 1.19, dynamic speaking/listening aperture) — always active
 * Role 3: Counter-precessing 6-lobe iridescent crown (R = 1.29, m = 6 lobes) — welcome/rail/voice/immersive
 * Role 4: Outer directional execution arc (R = 1.40 -> 1.66 on uExecWave) — welcome/rail/voice/immersive
 * Role 5: Golden-angle neural meridian filament A (R = 0.92, m = 3) — immersive
 * Role 6: Orthogonal neural meridian filament B (R = 1.03, counter-spin) — immersive
 */
export const ECHO_RING_CONFIGS: readonly EchoRingDescriptor[] = [
  { cfg0: [0.98, 0.016, 0.52, 0.35], cfg1: [0.54,  0.22, 48.0, 0.86], cfg2: [0.0,  0.0, -1.0, 0.0] },
  { cfg0: [1.09, 0.015, 0.96, 1.25], cfg1: [-1.08, 0.44, 36.0, 0.74], cfg2: [12.0, 0.0, -0.4, 1.0] },
  { cfg0: [1.19, 0.017, 0.58, 3.72], cfg1: [-0.44, 0.28, 42.0, 0.68], cfg2: [6.0,  0.0,  0.8, 3.0] },
  { cfg0: [1.29, 0.015, 0.68, 2.35], cfg1: [0.78, -0.36, 30.0, 0.92], cfg2: [8.0,  6.0,  0.2, 2.0] },
  { cfg0: [1.40, 0.018, 0.36, 4.85], cfg1: [0.32, -0.18, 60.0, 0.96], cfg2: [16.0, 6.0,  1.3, 4.0] },
  { cfg0: [0.92, 0.013, 1.24, 0.62], cfg1: [1.32, -0.58, 24.0, 0.82], cfg2: [10.0, 3.0, -1.4, 5.0] },
  { cfg0: [1.03, 0.013, 1.38, 2.94], cfg1: [-1.26, 0.50, 24.0, 0.80], cfg2: [12.0, 3.0,  0.6, 6.0] },
];

export const ECHO_SHADER_COMMON_GLSL = `
// Fast 1-pass divergence-free gyroid pseudo-curl (6x-10x cheaper than finite-diff 3D curl noise)
vec3 gyroidCurl(vec3 p) {
  vec3 s1 = sin(p.yzx) * cos(p.zxy);
  vec3 p2 = p * 1.93 + vec3(1.71, -2.37, 0.94);
  vec3 s2 = sin(p2.yzx) * cos(p2.zxy) * 0.48;
  return s1 + s2;
}

float gyroidField(vec3 p) {
  float g1 = dot(sin(p), cos(p.yzx));
  vec3 p2 = p * 2.07 + vec3(1.3, -1.9, 0.7);
  float g2 = dot(sin(p2), cos(p2.yzx)) * 0.45;
  return 0.5 + 0.34 * (g1 + g2);
}

// Smooth aragonite mother-of-pearl thin-film interference projected onto the Pearlescent Abyss palette
// (Opaline Cyan -> Electric Violet -> Rose-Pink Nacre -> Turquoise; vivid chroma without olive bands)
vec3 thinFilmNacre(float cosTheta, float thicknessNm) {
  float sin2T = max(0.0, 1.0 - cosTheta * cosTheta) / (1.38 * 1.38);
  float opd = 2.0 * 1.38 * thicknessNm * sqrt(max(0.05, 1.0 - sin2T));
  float phase = opd * 0.0115;
  float wCyan = pow(0.5 + 0.5 * cos(phase), 1.6);
  float wLav  = pow(0.5 + 0.5 * cos(phase - 2.0943951), 1.6);
  float wRose = pow(0.5 + 0.5 * cos(phase - 4.1887902), 1.6);
  float wSum  = max(wCyan + wLav + wRose, 1e-3);
  vec3 nacreCol = (vec3(0.14, 0.90, 0.98) * wCyan
                 + vec3(0.60, 0.38, 0.99) * wLav
                 + vec3(0.98, 0.42, 0.80) * wRose) / wSum;
  return mix(nacreCol, vec3(0.95, 0.97, 1.00), 0.14);
}

vec3 acesFilmic(vec3 x) {
  vec3 a = x * (2.51 * x + 0.03);
  vec3 b = x * (2.43 * x + 0.59) + 0.14;
  return clamp(a / max(b, vec3(1e-4)), 0.0, 1.0);
}

// Chroma-preserving pearlescent filmic curve: prevents ACES highlight desaturation into grey-white
vec3 pearlescentTonemap(vec3 hdr) {
  vec3 mapped = acesFilmic(hdr);
  float peak = max(hdr.r, max(hdr.g, hdr.b));
  vec3 normHue = hdr / max(peak, 1e-4);
  float luma = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
  vec3 vivid = clamp(normHue * (luma * 1.24 + 0.04), 0.0, 0.98);
  float highlightShoulder = smoothstep(0.55, 1.45, peak);
  return mix(vivid, mapped, 0.32 + 0.44 * highlightShoulder);
}

float ign(vec2 fragCoord) {
  return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
}

mat3 rotAxis3(vec3 axis, float a) {
  float s = sin(a);
  float c = cos(a);
  float oc = 1.0 - c;
  return mat3(
    oc * axis.x * axis.x + c,           oc * axis.x * axis.y - axis.z * s,  oc * axis.z * axis.x + axis.y * s,
    oc * axis.x * axis.y + axis.z * s,  oc * axis.y * axis.y + c,           oc * axis.y * axis.z - axis.x * s,
    oc * axis.z * axis.x - axis.y * s,  oc * axis.y * axis.z + axis.x * s,  oc * axis.z * axis.z + c
  );
}
`;

// ---------------------------------------------------------------------------
// LAYER 0 (renderOrder = 5): Translucent Refractive Cushion (Light) and Opaline Aurora Bloom (Dark)
// ---------------------------------------------------------------------------

export const ECHO_HALO_VERTEX_SHADER = `
precision highp float;
precision highp int;

in vec3 position;
in vec2 uv;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uCoreScale;

out vec2 vPlanePos;

void main() {
  vec2 p = (uv * 2.0 - 1.0) * 1.80;
  vPlanePos = p;
  vec4 wp = modelMatrix * vec4(p.x, p.y, -0.18, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const ECHO_HALO_FRAGMENT_SHADER = `
precision highp float;
precision highp int;

in vec2 vPlanePos;

uniform float uTime;
uniform float uDark;
uniform float uCoreScale;
uniform float uVoiceRms;
uniform float uListenWaveMix;
uniform float uSpeakFieldMix;
uniform float uConstellation;
uniform float uShockwave;
uniform float uExecWave;
uniform vec3 uCoreColorA;
uniform vec3 uCoreColorB;
uniform vec3 uRimColor;

out vec4 fragColor;

void main() {
  float r = length(vPlanePos);
  float outerSafe = smoothstep(1.76, 1.32, r);
  float baseR = 0.86 * max(uCoreScale, 0.55);
  float angle = atan(vPlanePos.y, vPlanePos.x);

  // Light-mode refractive sapphire-violet caustics cushion (luminous, zero dark smudge)
  vec2 cushionDelta = vPlanePos - vec2(0.0, -0.055);
  float cushionR = length(cushionDelta);
  float cushionFalloff = exp(-pow(max(0.0, cushionR - baseR * 0.66) * 2.45, 2.0)) * (1.0 - uDark) * outerSafe;
  float cushionAlpha = clamp(cushionFalloff * 0.24, 0.0, 0.28);
  vec3 cushionTint = mix(vec3(0.24, 0.44, 0.94), vec3(0.58, 0.36, 0.96), 0.5 + 0.5 * sin(angle + uTime * 0.6));
  vec3 cushionPremul = cushionTint * cushionAlpha;

  // Azimuthally iridescent volumetric aurora bloom (cyan <-> violet <-> rose-pink)
  float ringTargetR = baseR * (1.08 + 0.06 * uListenWaveMix + 0.06 * uVoiceRms);
  float softBloom = exp(-pow((r - ringTargetR) / (0.23 + 0.07 * uListenWaveMix + 0.07 * uSpeakFieldMix), 2.0));
  float softMeniscus = exp(-pow((r - (baseR * 1.015)) / 0.038, 2.0));
  float pulse = 0.90 + 0.10 * sin(uTime * 1.85 - r * 2.6);

  float waveR = baseR + 0.54 * (1.0 - uShockwave) * step(0.02, uShockwave) + 0.58 * uExecWave;
  float wavePulse = exp(-pow((r - waveR) / 0.064, 2.0)) * max(uShockwave * 0.80, uExecWave * 0.88);

  float coronaStrength = (softBloom * (0.34 + 0.40 * uListenWaveMix + 0.42 * uSpeakFieldMix + 0.38 * uConstellation + 0.38 * uVoiceRms)
                        + softMeniscus * (0.28 + 0.28 * uListenWaveMix)
                        + wavePulse * 0.78) * pulse * outerSafe;

  float azA = 0.5 + 0.5 * sin(angle * 2.0 - uTime * 0.75);
  float azB = 0.5 + 0.5 * cos(angle - uTime * 0.52);
  vec3 nacreRose = vec3(0.96, 0.46, 0.82);
  vec3 haloColDark = mix(uCoreColorA, uCoreColorB, azA * 0.76);
  haloColDark = mix(haloColDark, nacreRose, azB * 0.34);
  haloColDark = mix(haloColDark, uRimColor, clamp(softMeniscus * 0.50 + wavePulse * 0.48, 0.0, 1.0));

  vec3 haloColLight = mix(vec3(0.08, 0.72, 0.96), vec3(0.54, 0.34, 0.96), azA * 0.74);
  haloColLight = mix(haloColLight, vec3(0.92, 0.38, 0.78), azB * 0.32);

  float haloAlphaLight = clamp(coronaStrength * 0.30, 0.0, 0.40);
  float haloAlphaDark = clamp(coronaStrength * 0.24, 0.0, 0.42);

  vec3 lightPremul = cushionPremul + haloColLight * haloAlphaLight * (1.0 - cushionAlpha);
  float lightOutA = clamp(cushionAlpha + haloAlphaLight * (1.0 - cushionAlpha), 0.0, 0.54);
  lightPremul = min(lightPremul, vec3(lightOutA));

  vec3 darkPremul = min(vec3(0.58), haloColDark * coronaStrength * 0.48);
  float darkOutA = haloAlphaDark;

  vec3 finalRgb = mix(lightPremul, darkPremul, uDark);
  float finalA = mix(lightOutA, darkOutA, uDark);

  fragColor = vec4(finalRgb, finalA);
}
`;

// ---------------------------------------------------------------------------
// LAYER 1 (renderOrder = 20): Radiant Pearlescent Abyss Sphere
// Spatially Sculpted Opaline Cyan + Sapphire + Electric Violet + Rose Nacre + Pearl Heart
// ---------------------------------------------------------------------------

export const ECHO_CORE_VERTEX_SHADER = `
precision highp float;
precision highp int;

in vec3 position;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uCoreScale;
uniform float uVoiceRms;
uniform float uShockwave;
uniform vec3 uGazeDir;

out vec3 vLocalPos;
out vec3 vLocalNormal;
out vec3 vWorldPos;

${ECHO_SHADER_COMMON_GLSL}

float shellRadius(vec3 d) {
  vec3 gz = normalize(uGazeDir);
  float c = dot(d, gz);
  float p2 = 0.5 * (3.0 * c * c - 1.0);
  float swell = 0.020 * (gyroidField(d * 2.0 + vec3(0.0, uTime * 0.34, -uTime * 0.22)) - 0.5);
  float voice = 0.042 * uVoiceRms * p2;
  float recoil = -0.085 * uShockwave * cos(3.8 * c);
  return 0.84 * uCoreScale * (1.0 + swell + voice + recoil);
}

void main() {
  vec3 d = normalize(position);
  vec3 upAxis = vec3(0.0, 1.0, 0.0);
  if (abs(d.y) >= 0.92) {
    upAxis = vec3(1.0, 0.0, 0.0);
  }
  vec3 t1 = normalize(cross(upAxis, d));
  vec3 t2 = cross(d, t1);
  const float eps = 0.02;
  float r0 = shellRadius(d);
  vec3 d1 = normalize(d + eps * t1);
  vec3 d2 = normalize(d + eps * t2);
  vec3 p0 = d * r0;
  vec3 p1 = d1 * shellRadius(d1);
  vec3 p2 = d2 * shellRadius(d2);

  vLocalPos = p0;
  vLocalNormal = normalize(cross(p1 - p0, p2 - p0));
  vec4 wp = modelMatrix * vec4(p0, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const ECHO_CORE_FRAGMENT_SHADER = `
precision highp float;
precision highp int;

in vec3 vLocalPos;
in vec3 vLocalNormal;
in vec3 vWorldPos;

uniform vec3 uCameraPos;
uniform float uTime;
uniform float uDark;
uniform float uCoreScale;
uniform float uPlasmaSpeed;
uniform float uDispersion;
uniform float uSheetMix;
uniform float uPlasmaMix;
uniform float uListenWaveMix;
uniform float uSpeakFieldMix;
uniform float uConstellation;
uniform float uPrismMix;
uniform float uVoiceRms;
uniform float uAudioBass;
uniform float uAudioMid;
uniform float uAudioTreble;
uniform float uOnsetFlux;
uniform float uAttention;
uniform float uShockwave;
uniform int uCoreSteps;
uniform vec3 uGazeDir;
uniform vec3 uCoreColorA;
uniform vec3 uCoreColorB;
uniform vec3 uRimColor;
uniform vec3 uAmbientTint;

out vec4 fragColor;

${ECHO_SHADER_COMMON_GLSL}

vec2 intersectSphere(vec3 ro, vec3 rd, float rad) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - rad * rad;
  float h = b * b - c;
  if (h < 0.0) {
    return vec2(0.0, -1.0);
  }
  float s = sqrt(h);
  return vec2(max(0.0, -b - s), -b + s);
}

// Sculpted aurora spectral ribbon with distinct spatial wave separation (prevents uniform grey overlap)
float evalLightSheet(vec3 p, float amp, float freqX, float freqZ, float phase, float width) {
  float surf = amp * sin(freqX * p.x + phase) * cos(freqZ * p.z - phase * 0.72);
  float dist = abs(p.y - surf);
  float planarR = length(p.xz);
  float radialClip = smoothstep(0.84, 0.24, length(p));
  float sheetBody = exp(-(dist * dist) / max(width * width, 1e-4));
  float rimEdge = 1.0 + 1.85 * smoothstep(0.38, 0.76, planarR) * smoothstep(0.86, 0.66, planarR);
  return sheetBody * radialClip * rimEdge;
}

void main() {
  float jitter = ign(gl_FragCoord.xy);
  vec3 n = normalize(vLocalNormal);
  vec3 v = normalize(uCameraPos - vWorldPos);
  float cosV = clamp(dot(n, v), 0.0, 1.0);

  vec3 rd = refract(-v, n, 1.0 / 1.45);
  if (dot(rd, rd) < 0.01) {
    rd = -v;
  }

  float safeScale = max(uCoreScale, 0.35);
  float rad = 0.85 * safeScale;
  vec2 hit = intersectSphere(vLocalPos + rd * 0.01, rd, rad);
  float tLen = max(0.0, hit.y - hit.x);
  int steps = clamp(uCoreSteps, 4, 16);
  float dtStep = tLen / float(steps);
  float flowT = uTime * (0.44 + 0.82 * uPlasmaSpeed);

  // 4 distinct inclined orbital frames so cyan, violet, rose, and turquoise occupy separate 3D quadrants
  mat3 m0 = rotAxis3(normalize(vec3(0.38, 0.84, 0.38)), flowT * 0.48 + 0.35);
  mat3 m1 = rotAxis3(normalize(vec3(-0.70, 0.38, 0.60)), -flowT * 0.42 + 1.55);
  mat3 m2 = rotAxis3(normalize(vec3(0.52, -0.62, 0.58)), flowT * 0.56 + 2.75);
  mat3 m3 = rotAxis3(normalize(vec3(-0.30, -0.80, 0.52)), -flowT * 0.36 + 4.15);

  // Jewel-saturated Pearlescent Abyss primaries
  vec3 colOpalCyan  = mix(vec3(0.06, 0.88, 0.99), uCoreColorA, 0.35);
  vec3 colAqua      = vec3(0.08, 0.92, 0.80);
  vec3 colViolet    = mix(vec3(0.52, 0.28, 0.99), uCoreColorB, 0.45);
  vec3 colRosePink  = mix(vec3(0.98, 0.34, 0.74), vec3(0.92, 0.32, 0.96), 0.40 * uPrismMix);
  vec3 colPearlWarm = vec3(0.96, 0.98, 1.00);

  vec3 gz = normalize(uGazeDir);
  vec3 eyeCenter = gz * 0.14;
  float effectiveSheetMix = max(0.48, uSheetMix);
  float effectivePlasmaMix = max(0.28, uPlasmaMix);
  float energyDrive = 0.88 + 0.32 * uVoiceRms + 0.18 * uAudioMid + 0.16 * uOnsetFlux;

  vec3 radiance = vec3(0.0);
  float opticalDepth = 0.0;

  for (int i = 0; i < 16; i++) {
    if (i >= steps) {
      break;
    }
    float s = hit.x + (float(i) + jitter) * dtStep;
    vec3 p = (vLocalPos + rd * s) / safeScale;
    float r2 = dot(p, p);

    // Spatially gated aurora ribbons (quadrant masks prevent complementary RGB cancellation into grey!)
    float qCyan   = smoothstep(-0.45, 0.55, -p.x * 0.65 + p.y * 0.75);
    float qRose   = smoothstep(-0.45, 0.55,  p.x * 0.68 - p.y * 0.72);
    float qViolet = smoothstep(-0.50, 0.55,  p.x * 0.55 + p.y * 0.45 - p.z * 0.35);
    float qAqua   = smoothstep(-0.50, 0.55, -p.x * 0.45 - p.y * 0.50 + p.z * 0.45);

    float wBase = 0.044 + 0.012 * uVoiceRms;
    float s0 = evalLightSheet(m0 * p, 0.28 + 0.09 * uAudioBass,   2.4, 1.9, flowT * 1.12, wBase) * (0.35 + 0.85 * qCyan);
    float s1 = evalLightSheet(m1 * p, 0.26 + 0.08 * uAudioMid,    2.2, 2.3, -flowT * 0.94, wBase * 1.04) * (0.35 + 0.85 * qViolet);
    float s2 = evalLightSheet(m2 * p, 0.24 + 0.08 * uAudioTreble, 2.7, 1.8, flowT * 1.26, wBase * 0.96) * (0.35 + 0.90 * qRose);
    float s3 = evalLightSheet(m3 * p, 0.22 + 0.07 * uVoiceRms,    2.3, 2.5, -flowT * 0.84, wBase * 1.06) * (0.30 + 0.85 * qAqua);

    float sheetSum = s0 + s1 + s2 + s3;
    float intersectPearl = pow(clamp(sheetSum * 0.32, 0.0, 1.30), 2.4) * exp(-6.8 * r2);

    vec3 sheetCol = (
      colOpalCyan * s0 * 0.78
      + colViolet * s1 * 0.76
      + colRosePink * s2 * (0.62 + 0.36 * uPrismMix)
      + colAqua * s3 * (0.50 + 0.42 * uSpeakFieldMix)
    ) * effectiveSheetMix;
    sheetCol += colPearlWarm * intersectPearl * (0.32 + 0.36 * effectiveSheetMix + 0.32 * uConstellation);

    // 1-pass gyroid curl-noise plasma + crisp branching neural lumina in Thinking / Speaking
    vec3 warp = gyroidCurl(p * 2.25 + vec3(0.0, flowT * 0.46, -flowT * 0.34));
    float g = gyroidField(p * 3.0 + warp * (0.40 + 0.28 * effectivePlasmaMix + 0.22 * uVoiceRms));
    float causticFine = gyroidField(p * 5.4 - warp * 0.62 + vec3(flowT * 0.36, -flowT * 0.24, flowT * 0.28));
    float plasmaDens = smoothstep(0.46, 0.88, g) * exp(-2.5 * r2) * effectivePlasmaMix;
    float neuralRidge = pow(smoothstep(0.56, 0.94, causticFine), 1.8) * exp(-2.6 * r2);
    float fineLumina = neuralRidge * (0.20 + 1.35 * uConstellation + 0.65 * uSpeakFieldMix);

    vec3 plasmaCol = mix(colOpalCyan, colViolet, clamp(g * 1.15 - 0.10, 0.0, 1.0));
    plasmaCol = mix(plasmaCol, colRosePink, qRose * (0.38 + 0.26 * uPrismMix));
    vec3 neuralCol = mix(colOpalCyan, mix(colViolet, colRosePink, 0.5), clamp(causticFine * 1.2 - 0.2, 0.0, 1.0));
    neuralCol = mix(neuralCol, colPearlWarm, smoothstep(0.80, 0.96, causticFine) * 0.65);
    vec3 filamentEmission = plasmaCol * plasmaDens * 0.84 + neuralCol * fineLumina * 0.92;

    // Focused Pearl-White luminous nucleus (compact jewel heart so sapphire/cyan/rose ribbons shine around it!)
    vec3 toEye = p - eyeCenter + gz * 0.04;
    float dEye2 = dot(toEye, toEye);
    float heartGlow = exp(-7.5 * dEye2) * (0.24 + 0.20 * uSpeakFieldMix + 0.18 * uVoiceRms);
    float heartStar = exp(-22.0 * dEye2) * (0.28 + 0.78 * uConstellation + 0.24 * uVoiceRms + 0.16 * uAudioBass);
    vec3 heartCol = mix(colOpalCyan, colPearlWarm, 0.58) * heartGlow * 0.55
                  + colPearlWarm * heartStar * 0.95;

    vec3 stepEmission = (sheetCol + filamentEmission + heartCol) * energyDrive;
    float trans = exp(-opticalDepth * 1.52);
    radiance += stepEmission * trans * dtStep * 0.56;
    opticalDepth += (sheetSum * 0.24 * effectiveSheetMix + plasmaDens * 0.52 + heartStar * 0.36) * dtStep;
  }

  // Translucent Sapphire-Iris-Pearl Depth Substrate (eliminates dark navy-black void while keeping rich jewel depth)
  float upperLeft = clamp(-n.x * 0.42 + n.y * 0.58 + 0.5, 0.0, 1.0);
  float lowerRight = clamp(n.x * 0.48 - n.y * 0.52 + 0.5, 0.0, 1.0);
  float centerDome = pow(cosV, 1.8);

  // Light mode: rich cerulean-sapphire and amethyst-violet depth cradling an opaline aqua-pearl heart
  vec3 sapphireDepthLight = mix(vec3(0.16, 0.34, 0.84), vec3(0.42, 0.28, 0.88), lowerRight);
  sapphireDepthLight = mix(sapphireDepthLight, vec3(0.14, 0.68, 0.94), upperLeft * 0.46);
  vec3 pearlHeartLight = mix(vec3(0.38, 0.72, 0.96), vec3(0.76, 0.58, 0.96), lowerRight * 0.55);
  vec3 baseLight = mix(sapphireDepthLight, pearlHeartLight, centerDome * 0.48);

  // Dark mode: luminous royal-sapphire, deep turquoise, and twilight-violet ocean depth (zero black void!)
  vec3 sapphireDepthDark = mix(vec3(0.08, 0.22, 0.62), vec3(0.26, 0.16, 0.66), lowerRight);
  sapphireDepthDark = mix(sapphireDepthDark, vec3(0.08, 0.52, 0.78), upperLeft * 0.42);
  vec3 pearlHeartDark = mix(vec3(0.14, 0.46, 0.84), vec3(0.44, 0.28, 0.82), lowerRight * 0.52);
  vec3 baseDark = mix(sapphireDepthDark, pearlHeartDark, centerDome * 0.44);

  vec3 cavityBase = mix(baseLight, baseDark, uDark);
  float fresnel = pow(1.0 - cosV, 2.9);
  float softFresnel = pow(1.0 - cosV, 1.75);
  cavityBase += uAmbientTint * softFresnel * 0.08;

  // Chroma-preserving pearlescent filmic curve keeps cyan, violet, sapphire, and rose-pink jewel-saturated!
  vec3 mappedInterior = pearlescentTonemap(cavityBase + radiance * mix(0.88, 0.96, uDark));
  vec3 interiorRgb = min(mappedInterior, vec3(0.965, 0.975, 0.995));

  // Multilayer Pearlescent Fresnel Nacre Sheen (opaline cyan upper-left + rose-pink lower-right mother-of-pearl)
  float filmThick = 330.0 + 195.0 * gyroidField(vLocalPos * 2.4 + vec3(uTime * 0.16, -uTime * 0.12, 0.0)) + 85.0 * lowerRight + 70.0 * uAudioTreble;
  vec3 nacre = thinFilmNacre(cosV, filmThick);

  vec3 keyDir = normalize(vec3(-0.44, 0.72, 0.52) + gz * 0.18);
  vec3 roseRimDir = normalize(vec3(0.62, -0.54, 0.46));
  float specKey = pow(max(dot(reflect(-keyDir, n), v), 0.0), 96.0);
  float specSoft = pow(max(dot(reflect(-keyDir, n), v), 0.0), 18.0);
  float specRose = pow(max(dot(reflect(-roseRimDir, n), v), 0.0), 14.0);

  float crescent = 0.48 + 0.52 * clamp(dot(n, normalize(vec3(-0.38, 0.66, 0.42))) + 0.30, 0.0, 1.0);
  vec3 rimTone = mix(uRimColor, nacre, 0.62 + 0.22 * uDispersion);
  vec3 glassRim = rimTone * fresnel * crescent * mix(0.66, 0.86, uDark)
                + nacre * softFresnel * mix(0.20, 0.26, uDark);
  glassRim += vec3(0.98, 0.54, 0.82) * uShockwave * fresnel * 0.78;

  // Crisp sapphire-iris edge definition on Light mode
  vec3 lightEdgeContour = mix(vec3(0.16, 0.38, 0.86), vec3(0.48, 0.28, 0.88), lowerRight) * fresnel * (1.0 - uDark) * 0.40;
  interiorRgb = mix(interiorRgb, interiorRgb * 0.80 + lightEdgeContour, clamp(fresnel * (1.0 - uDark) * 0.58, 0.0, 0.46));

  vec3 vesselRgb = clamp(
    interiorRgb
      + glassRim
      + vec3(0.96, 0.98, 1.00) * specKey * 0.48
      + colOpalCyan * specSoft * 0.16
      + colRosePink * specRose * 0.28,
    0.0,
    0.98
  );

  // Translucent crystal vessel (harmonizes with Pearl, Abyss, and Background Studio)
  float edgeFeather = smoothstep(0.0, 0.15, cosV);
  float glassBodyAlpha = mix(mix(0.88, 0.96, softFresnel), mix(0.84, 0.95, softFresnel), uDark);
  float alpha = edgeFeather * glassBodyAlpha;
  vec3 premulRgb = vesselRgb * alpha;

  fragColor = vec4(premulRgb, alpha);
}
`;

// ---------------------------------------------------------------------------
// LAYER 2A (renderOrder = 25): 5-Strand Opaline Aurora Sinusoidal Listening Wave
// ---------------------------------------------------------------------------

export const ECHO_WAVE_VERTEX_SHADER = `
precision highp float;
precision highp int;

in vec3 position;
in vec2 uv;
in vec4 aWaveCfg; // (strandIdxNorm, freqScale, phaseOffset, ampScale)

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uCoreScale;
uniform float uListenWaveMix;
uniform float uVoiceRms;
uniform float uAudioBass;
uniform float uAudioMid;
uniform float uAudioTreble;
uniform float uSpectralCentroid;
uniform float uOnsetFlux;

out vec2 vWaveUv;
out float vStrand;
out float vEnvelope;
out float vAmplitude;

void main() {
  float xNorm = uv.x * 2.0 - 1.0;
  float strand = aWaveCfg.x;
  float freqScale = aWaveCfg.y;
  float phaseOff = aWaveCfg.z;
  float ampScale = aWaveCfg.w;

  float gauss = exp(-3.85 * xNorm * xNorm);
  float kShift = 1.0 + 0.65 * uSpectralCentroid;
  float t = uTime * (2.4 + 2.1 * uVoiceRms);

  float wLow  = (0.055 + 0.42 * uAudioBass) * sin(xNorm * 3.6 * freqScale - t * 0.95 + phaseOff);
  float wMid  = (0.042 + 0.36 * uAudioMid)  * sin(xNorm * 6.4 * freqScale * kShift + t * 1.35 + phaseOff * 1.7);
  float wHigh = (0.024 + 0.28 * uAudioTreble + 0.16 * uOnsetFlux) * sin(xNorm * 10.8 * freqScale * kShift - t * 2.00 + phaseOff * 2.3);

  // Graceful separated multi-strand breathing even during quiet pauses (never collapses into a 1px ruler line)
  float calmBreath = 0.068 * sin(xNorm * 3.14159 - uTime * 1.45 + phaseOff * 1.3);
  float strandArch = (strand - 0.5) * 0.085 * gauss;
  float waveAmp = (calmBreath + (wLow + wMid + wHigh) * (0.34 + 1.12 * uVoiceRms)) * ampScale;

  float halfBand = (0.028 + abs(waveAmp) * 0.78) * gauss * max(uCoreScale, 0.45);
  float centerShift = (strandArch + waveAmp * 0.44 * gauss) * max(uCoreScale, 0.45);
  float yLocal = centerShift + (uv.y * 2.0 - 1.0) * halfBand;

  float xLocal = xNorm * 0.78 * max(uCoreScale, 0.45);
  float zLocal = 0.25 + (strand - 0.5) * 0.075;

  vWaveUv = uv;
  vStrand = strand;
  vEnvelope = gauss;
  vAmplitude = clamp(abs(waveAmp) * 2.4 + uVoiceRms * 0.6, 0.0, 1.5);

  vec4 wp = modelMatrix * vec4(xLocal, yLocal, zLocal, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const ECHO_WAVE_FRAGMENT_SHADER = `
precision highp float;
precision highp int;

in vec2 vWaveUv;
in float vStrand;
in float vEnvelope;
in float vAmplitude;

uniform float uListenWaveMix;
uniform float uVoiceRms;
uniform float uSpectralCentroid;
uniform float uOnsetFlux;
uniform vec3 uCoreColorA;
uniform vec3 uCoreColorB;
uniform vec3 uRimColor;

out vec4 fragColor;

void main() {
  if (uListenWaveMix < 0.04) {
    discard;
  }

  float v = vWaveUv.y * 2.0 - 1.0;
  float absV = abs(v);

  float bodyFill = pow(max(0.0, 1.0 - absV), 1.45) * 0.30;
  float edgeCrest = exp(-pow((absV - 0.84) / 0.12, 2.0)) * 0.46;
  float centerSpine = exp(-absV * absV * 22.0) * (0.68 + 0.36 * uVoiceRms + 0.28 * uOnsetFlux);

  // Vivid opaline cyan -> turquoise -> electric violet -> rose-pink nacreous harmonic strands
  vec3 c0 = vec3(0.08, 0.94, 1.00);
  vec3 c1 = vec3(0.14, 0.88, 0.82);
  vec3 c2 = vec3(0.62, 0.38, 1.00);
  vec3 c3 = vec3(0.98, 0.42, 0.82);

  vec3 strandCol = mix(c0, c1, smoothstep(0.0, 0.38, vStrand));
  strandCol = mix(strandCol, c2, smoothstep(0.34, 0.72, vStrand));
  strandCol = mix(strandCol, c3, smoothstep(0.66, 1.0, vStrand) * (0.52 + 0.48 * uSpectralCentroid));
  strandCol = mix(strandCol, vec3(0.96, 0.99, 1.00), clamp(centerSpine * 0.56, 0.0, 0.74));

  float mixGate = smoothstep(0.04, 0.32, uListenWaveMix);
  float intensity = (bodyFill + edgeCrest + centerSpine) * vEnvelope * mixGate * (0.66 + 0.44 * vAmplitude);
  float alpha = clamp(intensity * 0.46, 0.0, 0.72);
  vec3 rgb = min(vec3(0.94), strandCol * clamp(intensity * 0.84, 0.0, 0.90));

  fragColor = vec4(rgb, alpha);
}
`;

// ---------------------------------------------------------------------------
// LAYER 3 (renderOrder = 30): Gossamer Iridescent Orbital Light Filaments
// ---------------------------------------------------------------------------

export const ECHO_RINGS_VERTEX_SHADER = `
precision highp float;
precision highp int;

in vec2 uv;
in vec4 aRingCfg0;
in vec4 aRingCfg1;
in vec4 aRingCfg2;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uPixelsPerUnit;
uniform float uRingSpeed;
uniform float uRingAlign;
uniform float uRingAperture;
uniform float uRingPhaseClick;
uniform float uExecWave;
uniform float uShockwave;
uniform float uAudioMid;
uniform vec3 uGazeDir;

out vec2 vRibbonUv;
out vec4 vPattern;
out float vViewFade;

${ECHO_SHADER_COMMON_GLSL}

void main() {
  float radius = aRingCfg0.x;
  float minHalfW = 1.15 / max(uPixelsPerUnit, 12.0);
  float halfW = max(aRingCfg0.y, minHalfW);
  float role = aRingCfg2.w;

  float isExecRing = 1.0 - step(0.5, abs(role - 4.0));
  radius += isExecRing * uExecWave * 0.24;
  radius += uShockwave * 0.07 * (1.0 + 0.2 * aRingCfg2.z);

  float theta = uv.x * 6.28318530718;
  float harmAmp = 0.0;
  if (role > 1.5 && role < 2.5) {
    harmAmp = 0.022 + 0.028 * uAudioMid;
  }
  float rLocal = radius * (1.0 + harmAmp * cos(aRingCfg2.y * theta + uTime * 2.2))
               + (uv.y - 0.5) * 2.0 * halfW;
  rLocal = min(rLocal, 1.74);

  vec3 tiltAxis = normalize(vec3(
    sin(aRingCfg0.z) * cos(aRingCfg0.w),
    cos(aRingCfg0.z),
    sin(aRingCfg0.z) * sin(aRingCfg0.w)
  ));
  float spinA = uTime * aRingCfg1.x * uRingSpeed + uRingPhaseClick * (0.65 + 0.15 * role);
  float precA = uTime * aRingCfg1.y * uRingSpeed;
  mat3 freeBasis = rotAxis3(vec3(0.0, 1.0, 0.0), precA) * rotAxis3(tiltAxis, aRingCfg0.z + 0.35 * sin(precA * 0.7));

  vec3 gz = normalize(uGazeDir);
  vec3 upRef = vec3(0.0, 1.0, 0.0);
  if (abs(gz.y) >= 0.92) {
    upRef = vec3(1.0, 0.0, 0.0);
  }
  vec3 gx = normalize(cross(upRef, gz));
  vec3 gy = cross(gz, gx);
  float cSpin = cos(spinA * 0.45);
  float sSpin = sin(spinA * 0.45);
  vec3 gxRot = gx * cSpin + gy * sSpin;

  float roleAlignScale = 1.0;
  if (role > 4.5) {
    roleAlignScale = 0.35;
  }
  float alignW = clamp(uRingAlign * roleAlignScale, 0.0, 1.0);
  vec3 bx = normalize(mix(freeBasis[0], gxRot, alignW) + vec3(1e-5, 0.0, 0.0));
  vec3 bz = normalize(mix(freeBasis[2], gz, alignW) + vec3(0.0, 0.0, 1e-5));
  vec3 by = normalize(cross(bz, bx));
  bx = cross(by, bz);

  vec3 localRing = bx * (cos(theta + spinA) * rLocal)
                 + by * (sin(theta + spinA) * rLocal)
                 + bz * (aRingCfg2.z * 0.075 * alignW);

  vec4 mv = viewMatrix * modelMatrix * vec4(localRing, 1.0);
  vRibbonUv = uv;
  float caliperDelta = 0.0;
  if (role > 2.5 && role < 3.5) {
    caliperDelta = uRingAperture * 0.24;
  }
  float aperture = clamp(aRingCfg1.w + caliperDelta, 0.15, 1.0);
  vPattern = vec4(aRingCfg1.z, aRingCfg2.x, aperture, role);
  vViewFade = smoothstep(-6.6, -4.6, mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

export const ECHO_RINGS_FRAGMENT_SHADER = `
precision highp float;
precision highp int;

in vec2 vRibbonUv;
in vec4 vPattern;
in float vViewFade;

uniform float uTime;
uniform float uDark;
uniform float uDashSpeed;
uniform float uExecWave;
uniform float uVoiceRms;
uniform vec3 uCoreColorA;
uniform vec3 uCoreColorB;
uniform vec3 uRimColor;

out vec4 fragColor;

void main() {
  // Unconditional screen-space derivatives at top of main() for ANGLE D3D11 compliance
  float du = max(fwidth(vRibbonUv.x), 1e-4);
  float dv = max(fwidth(vRibbonUv.y), 1e-4);

  float u = vRibbonUv.x;
  float v = vRibbonUv.y * 2.0 - 1.0;
  float tickCount = vPattern.x;
  float dashFreq  = vPattern.y;
  float aperture  = vPattern.z;
  float role      = vPattern.w;

  float centeredU = abs(fract(u + 0.5) - 0.5) * 2.0;
  float arcMask = 1.0 - smoothstep(aperture * 0.72, aperture + du * 4.0, centeredU);

  // Silky gossamer light filament
  float filamentCore = exp(-v * v * 10.0) * (1.0 - smoothstep(0.55, 0.95 + dv, abs(v)));
  float dashPhase = fract(u * max(dashFreq * 0.35, 2.0) - uTime * uDashSpeed * (0.45 + 0.18 * role));
  float auroraWave = 0.42 + 0.58 * sin(dashPhase * 6.2831853);

  float glintCoord = u * max(tickCount / 6.0, 4.0);
  float glintDist = abs(fract(glintCoord + 0.5) - 0.5) / max(du * 8.0, 1e-3);
  float pearlGlint = exp(-glintDist * glintDist * 0.35) * exp(-v * v * 14.0) * 0.40;

  float pktDelta = (fract(u * 2.0 - uTime * (0.32 + 0.38 * uDashSpeed)) - 0.5) * 7.0;
  float packet = exp(-(pktDelta * pktDelta));

  float pattern = filamentCore * mix(0.72, auroraWave, step(1.0, dashFreq))
                + pearlGlint
                + filamentCore * packet * (0.76 + 0.65 * uVoiceRms);

  float execMask = 1.0;
  if (role > 3.5 && role < 4.5) {
    execMask = mix(0.14, 1.45 * (1.0 - uExecWave * 0.50), step(0.01, uExecWave));
  }

  float softGlow = exp(-v * v * 3.6) * 0.22 * (0.8 + packet);
  float intensity = (pattern + softGlow) * arcMask * vViewFade * execMask;

  float specShift = 0.5 + 0.5 * sin(u * 6.2831853 + role * 1.2 + uTime * 0.6);
  vec3 nacreRose = vec3(0.96, 0.46, 0.84);
  vec3 darkTone = mix(uCoreColorA, uCoreColorB, specShift * 0.78);
  darkTone = mix(darkTone, nacreRose, smoothstep(1.2, 5.2, role) * 0.38);
  darkTone = mix(darkTone, vec3(0.96, 0.98, 1.00), clamp(packet * 0.52 + pearlGlint * 0.42, 0.0, 0.70));

  vec3 lightInk = mix(vec3(0.08, 0.64, 0.92), vec3(0.52, 0.32, 0.94), specShift * 0.78);
  lightInk = mix(lightInk, vec3(0.88, 0.36, 0.76), smoothstep(1.5, 5.2, role) * 0.34);

  float alphaLight = clamp(intensity * 0.46, 0.0, 0.58);
  vec3 rgbLight = min(vec3(alphaLight), lightInk * alphaLight);

  float alphaDark = clamp(intensity * 0.28, 0.0, 0.54);
  vec3 rgbDark = min(vec3(0.72), darkTone * intensity * 0.48);

  fragColor = vec4(mix(rgbLight, rgbDark, uDark), mix(alphaLight, alphaDark, uDark));
}
`;

// ---------------------------------------------------------------------------
// LAYER 4 (renderOrder = 40): 1-Pass Gyroid Synaptic Neural Lumina and Bokeh Trails
// ---------------------------------------------------------------------------

export const ECHO_TRAILS_VERTEX_SHADER = `
precision highp float;
precision highp int;

in vec2 aCorner;
in float aSeed;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 uViewportPx;
uniform float uPixelRatio;
uniform float uTime;
uniform float uCurlAmp;
uniform float uTrailStretch;
uniform float uConstellation;
uniform float uAudioBass;
uniform float uAudioMid;
uniform float uAudioTreble;
uniform float uVoiceRms;
uniform float uAttention;
uniform float uShockwave;
uniform float uExecWave;
uniform vec4 uStateGroupA;
uniform vec3 uGazeDir;

out vec2 vQuadCoord;
out float vTone;
out float vAlpha;
out float vBlur;
out float vHexWeight;

${ECHO_SHADER_COMMON_GLSL}

vec3 particleTrajectory(float seed, float t) {
  float h1 = fract(seed * 17.371);
  float h2 = fract(seed * 43.819);
  float h3 = fract(seed * 97.113);

  float z = 1.0 - 2.0 * seed;
  float rXY = sqrt(max(0.0, 1.0 - z * z));
  float spinSign = -1.0;
  if (h3 > 0.5) {
    spinSign = 1.0;
  }

  float spokeAngle = floor(h1 * 12.0) * (6.2831853 / 12.0) + 0.18 * sin(t * 0.42 + h2 * 6.28);
  float freeAngle = h1 * 6.2831853 + t * (0.26 + 0.48 * h2) * spinSign;
  float phi = mix(freeAngle, spokeAngle + t * 0.18 * spinSign, uConstellation * 0.65);

  vec3 baseDir = vec3(cos(phi) * rXY, z, sin(phi) * rXY);

  float radialSpread = mix(0.90, 1.04, uConstellation) + (0.42 + 0.24 * uConstellation) * pow(h2, 0.72);
  radialSpread *= (1.0 + 0.24 * uStateGroupA.x * (1.0 - h3) + 0.08 * uAudioBass + 0.08 * uVoiceRms);
  radialSpread += uShockwave * (0.26 * (0.4 + 0.6 * h1));
  radialSpread += uExecWave * 0.28 * sin(h2 * 6.2831853);

  vec3 p = baseDir * radialSpread;

  float curlFreq = 1.35 + 0.62 * uStateGroupA.z;
  vec3 curlVec = gyroidCurl(p * curlFreq + vec3(0.0, t * 0.26, -t * 0.20));
  p += curlVec * uCurlAmp * (0.12 + 0.18 * h3 + 0.14 * uAudioMid);

  vec3 gz = normalize(uGazeDir);
  float curLen = max(length(p), 1e-4);
  p = mix(p, normalize(p + gz * 0.42) * curLen, uAttention * 0.24 * uStateGroupA.y);

  float len = length(p);
  if (len > 1.72) {
    p *= 1.72 / len;
  }
  return p;
}

void main() {
  float rate = 0.68 + 1.08 * uStateGroupA.z + 0.48 * uVoiceRms;
  float tNow = uTime * rate;
  float dtTrail = (0.018 + 0.042 * uTrailStretch) * (1.0 + 0.65 * uShockwave + 0.55 * uExecWave);

  vec3 p0 = particleTrajectory(aSeed, tNow);
  vec3 p1 = particleTrajectory(aSeed, tNow - dtTrail);

  vec4 mv0 = viewMatrix * modelMatrix * vec4(p0, 1.0);
  vec4 mv1 = viewMatrix * modelMatrix * vec4(p1, 1.0);
  vec4 clip0 = projectionMatrix * mv0;
  vec4 clip1 = projectionMatrix * mv1;

  vec2 ndc0 = clip0.xy / max(clip0.w, 1e-4);
  vec2 ndc1 = clip1.xy / max(clip1.w, 1e-4);
  vec2 deltaPx = (ndc0 - ndc1) * 0.5 * uViewportPx;
  float speedPx = length(deltaPx);
  vec2 tangent = vec2(1.0, 0.0);
  if (speedPx > 0.001) {
    tangent = deltaPx / speedPx;
  }
  vec2 normal2D = vec2(-tangent.y, tangent.x);

  float dist = -mv0.z;
  vBlur = clamp(abs(dist - 5.40) * 0.40, 0.0, 1.0);
  float isHexNode = step(0.66, fract(aSeed * 31.7)) * uConstellation;
  vHexWeight = isHexNode;

  float baseRadiusPx = (1.6 + 2.0 * fract(aSeed * 29.3) + 2.2 * vBlur + 1.2 * uAudioTreble + 2.2 * isHexNode) * uPixelRatio;
  float stretchScale = mix(1.0, 0.22, isHexNode);
  float tailHalfLenPx = baseRadiusPx + min(speedPx * (0.52 + 0.82 * uTrailStretch) * stretchScale, 24.0 * uPixelRatio);

  vec2 offsetPx = tangent * (aCorner.x * tailHalfLenPx) + normal2D * (aCorner.y * baseRadiusPx);
  vec2 finalNdc = ndc0 + (offsetPx / max(uViewportPx, vec2(1.0))) * 2.0;

  vQuadCoord = aCorner;
  vTone = fract(aSeed * 13.7 + uAudioTreble * 0.35);
  float twinkle = 0.64 + 0.36 * sin(uTime * (2.2 + 2.8 * fract(aSeed * 7.7)) + aSeed * 62.8);
  float radialSafe = smoothstep(1.74, 1.36, length(p0));
  float visibilityGate = clamp(0.14 + 0.86 * max(uConstellation, max(uStateGroupA.x, max(uStateGroupA.w * 0.45, max(uShockwave, uExecWave)))), 0.0, 1.0);
  vAlpha = mix(0.90, 0.30, vBlur) * twinkle * radialSafe * visibilityGate;

  gl_Position = vec4(finalNdc * clip0.w, clip0.z, clip0.w);
}
`;

export const ECHO_TRAILS_FRAGMENT_SHADER = `
precision highp float;
precision highp int;

in vec2 vQuadCoord;
in float vTone;
in float vAlpha;
in float vBlur;
in float vHexWeight;

uniform float uDark;
uniform vec3 uCoreColorA;
uniform vec3 uCoreColorB;
uniform vec3 uRimColor;

out vec4 fragColor;

float sdfHexagon(vec2 p, float r) {
  vec2 q = abs(p);
  return max(q.x * 0.8660254 + q.y * 0.5, q.y) - r;
}

void main() {
  float r2 = dot(vQuadCoord, vQuadCoord);
  if (r2 > 1.0) {
    discard;
  }
  float r = sqrt(r2);

  float bokehCore = pow(max(0.0, 1.0 - r), mix(2.8, 1.4, vBlur));
  float bokehHalo = exp(-r2 * mix(5.0, 2.2, vBlur)) * 0.52;
  float taper = mix(0.45, 1.0, vQuadCoord.x * 0.5 + 0.5);
  float bokehShape = (bokehCore + bokehHalo) * taper;

  float hexD = sdfHexagon(vQuadCoord, 0.58);
  float hexFill = 1.0 - smoothstep(-0.10, 0.10, hexD);
  float hexRim = exp(-abs(hexD) * 12.0) * 1.05;
  float hexShape = hexFill * 0.52 + hexRim + exp(-r2 * 9.0) * 0.86;

  float intensity = mix(bokehShape, hexShape, vHexWeight) * vAlpha;

  vec3 nacrePink = vec3(0.98, 0.46, 0.84);
  vec3 darkCol = mix(uCoreColorA, uCoreColorB, smoothstep(0.10, 0.65, vTone));
  darkCol = mix(darkCol, nacrePink, smoothstep(0.55, 0.90, vTone) * 0.62);
  darkCol = mix(darkCol, vec3(0.96, 0.98, 1.00), smoothstep(0.78, 0.99, vTone) * 0.52);

  vec3 lightCol = mix(vec3(0.08, 0.68, 0.96), vec3(0.54, 0.34, 0.96), smoothstep(0.10, 0.65, vTone));
  lightCol = mix(lightCol, vec3(0.92, 0.38, 0.78), smoothstep(0.58, 0.94, vTone) * 0.55);

  float alphaLight = clamp(intensity * 0.68, 0.0, 0.80);
  vec3 rgbLight = min(vec3(alphaLight), lightCol * alphaLight);

  float alphaDark = clamp(intensity * 0.40, 0.0, 0.70);
  vec3 rgbDark = min(vec3(0.78), darkCol * intensity * 0.58);

  fragColor = vec4(mix(rgbLight, rgbDark, uDark), mix(alphaLight, alphaDark, uDark));
}
`;

// ---------------------------------------------------------------------------
// LAYER 2B (renderOrder = 10 BackSide, 50 FrontSide):
// Gaze-Aligned Orthonormal Cartesian Spherical Harmonics Y_l^m (l = 0..4)
// Multilayer Translucent Pearlescent Membrane and Liquid-Light Speaking Caustics
// ---------------------------------------------------------------------------

export const ECHO_AURA_VERTEX_SHADER = `
precision highp float;
precision highp int;

in vec3 position;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uSpectrum[32];
uniform float uVoiceRms;
uniform float uHarmonicGain;
uniform float uSpeakFieldMix;
uniform float uAudioSource;
uniform float uAttention;
uniform float uShockwave;
uniform vec3 uGazeDir;

out vec3 vWorldPos;
out vec3 vWorldNormal;
out vec3 vUnitDir;
out float vRadialDisp;
out float vGazeDot;
out float vRadiusLen;
out float vViewZ;

float xzTerm(float x, float z, float w, float ph) {
  return x * z * w * ph;
}

float yzTerm(float y, float z, float w, float ph) {
  return y * z * w * ph;
}

float evalHarmonicRadius(vec3 worldDir, vec3 gx, vec3 gy, vec3 gz) {
  float x = dot(worldDir, gx);
  float y = dot(worldDir, gy);
  float z = dot(worldDir, gz);
  float x2 = x * x;
  float y2 = y * y;
  float z2 = z * z;

  float phase = z * 3.2 - uTime * 4.2 * uAudioSource;
  float ph1 = sin(phase);
  float ph2 = cos(phase * 1.35);

  // F0 fundamental pitch (85 - 300 Hz, bins 0..5)
  float f0_a = (uSpectrum[0] + uSpectrum[1]) * 0.5;
  float f0_b = (uSpectrum[2] + uSpectrum[3]) * 0.5;
  float f0_c = (uSpectrum[4] + uSpectrum[5]) * 0.5;

  // F1 first vowel formant (300 - 1000 Hz, bins 6..13)
  float f1_a = (uSpectrum[6]  + uSpectrum[7])  * 0.5;
  float f1_b = (uSpectrum[8]  + uSpectrum[9])  * 0.5;
  float f1_c = (uSpectrum[10] + uSpectrum[11]) * 0.5;
  float f1_d = (uSpectrum[12] + uSpectrum[13]) * 0.5;

  // F2 and F3 second and third vowel formants (1.0 - 3.2 kHz, bins 14..23)
  float f2_a = (uSpectrum[14] + uSpectrum[15]) * 0.5;
  float f2_b = (uSpectrum[16] + uSpectrum[17]) * 0.5;
  float f2_c = (uSpectrum[18] + uSpectrum[19]) * 0.5;
  float f2_d = (uSpectrum[20] + uSpectrum[21]) * 0.5;
  float f2_e = (uSpectrum[22] + uSpectrum[23]) * 0.5;

  // Sibilants, fricatives and plosive bursts (3.2 - 7.8 kHz, bins 24..31)
  float s_a  = (uSpectrum[24] + uSpectrum[25]) * 0.5;
  float s_b  = (uSpectrum[26] + uSpectrum[27]) * 0.5;
  float s_c  = (uSpectrum[28] + uSpectrum[29]) * 0.5;
  float s_d  = (uSpectrum[30] + uSpectrum[31]) * 0.5;

  // Orthonormal Cartesian Spherical Harmonics Y_l^m (l = 0..4)
  float sh0 = 0.282095 * uVoiceRms;
  float sh1 = 0.488603 * (f0_a * z + 0.55 * f0_b * x * ph1 + 0.55 * f0_c * y * ph2);
  float sh2 = 0.315392 * (3.0 * z2 - 1.0) * f1_a
            + 1.092548 * (xzTerm(x, z, f1_b, ph1) + yzTerm(y, z, f1_c, ph2))
            + 0.546274 * (x2 - y2) * f1_d * ph1;
  float sh3 = 0.373176 * z * (5.0 * z2 - 3.0) * f2_a
            + 0.457046 * (x * (5.0 * z2 - 1.0) * f2_b * ph2 + y * (5.0 * z2 - 1.0) * f2_c * ph1)
            + 1.445306 * z * (x2 - y2) * f2_d
            + 2.890611 * x * y * z * f2_e * ph2;
  float sh4 = 0.105786 * (35.0 * z2 * z2 - 30.0 * z2 + 3.0) * s_a
            + 0.473087 * (x2 - y2) * (7.0 * z2 - 1.0) * s_b * ph1
            + 0.625836 * (x2 * x2 - 6.0 * x2 * y2 + y2 * y2) * s_c * ph2
            + 2.503343 * x * y * (x2 - y2) * s_d;

  // Expressive undulating liquid-light caustic folds during Speaking
  float speakFold = 0.050 * uSpeakFieldMix * (0.38 + 0.92 * uVoiceRms)
                  * sin(x * 4.2 + uTime * 2.1) * cos(y * 3.9 - uTime * 1.8 + z * 3.0);

  float idleBreath = 0.020 * sin(uTime * 1.30 + z * 2.3) + 0.013 * cos(uTime * 0.92 - x * 2.8 + y * 2.0);
  float gazeLobe = 0.044 * uAttention * pow(max(0.0, z), 3.0);
  float shock = 0.11 * uShockwave * sin(z * 7.5 - (1.0 - uShockwave) * 8.5);

  float baseShell = mix(1.12, 0.96, uSpeakFieldMix);
  float disp = idleBreath + gazeLobe + shock + speakFold
             + uHarmonicGain * (0.19 * sh0 + 0.11 * sh1 + 0.12 * sh2 + 0.09 * sh3 + 0.06 * sh4);
  return clamp(baseShell + disp, 0.86, 1.72);
}

void main() {
  vec3 gz = normalize(uGazeDir);
  vec3 upRef = vec3(0.0, 1.0, 0.0);
  if (abs(gz.y) >= 0.92) {
    upRef = vec3(1.0, 0.0, 0.0);
  }
  vec3 gx = normalize(cross(upRef, gz));
  vec3 gy = cross(gz, gx);

  vec3 d = normalize(position);
  vec3 dUp = vec3(0.0, 1.0, 0.0);
  if (abs(d.y) >= 0.92) {
    dUp = vec3(1.0, 0.0, 0.0);
  }
  vec3 t1 = normalize(cross(dUp, d));
  vec3 t2 = cross(d, t1);

  const float eps = 0.018;
  float r0 = evalHarmonicRadius(d, gx, gy, gz);
  vec3 d1 = normalize(d + eps * t1);
  vec3 d2 = normalize(d + eps * t2);
  vec3 p0 = d * r0;
  vec3 p1 = d1 * evalHarmonicRadius(d1, gx, gy, gz);
  vec3 p2 = d2 * evalHarmonicRadius(d2, gx, gy, gz);

  vec3 localN = normalize(cross(p1 - p0, p2 - p0));
  vec4 wp = modelMatrix * vec4(p0, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * localN);
  vUnitDir = d;
  float baseShell = mix(1.12, 0.96, uSpeakFieldMix);
  vRadialDisp = r0 - baseShell;
  vGazeDot = dot(d, gz);
  vRadiusLen = r0;
  vViewZ = (viewMatrix * wp).z + 5.4;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const ECHO_AURA_FRAGMENT_SHADER = `
precision highp float;
precision highp int;

in vec3 vWorldPos;
in vec3 vWorldNormal;
in vec3 vUnitDir;
in float vRadialDisp;
in float vGazeDot;
in float vRadiusLen;
in float vViewZ;

uniform vec3 uCameraPos;
uniform float uTime;
uniform float uDark;
uniform float uPassFade;
uniform float uSpeakFieldMix;
uniform float uVoiceRms;
uniform float uAudioTreble;
uniform float uOnsetFlux;
uniform float uAttention;
uniform vec3 uCoreColorA;
uniform vec3 uCoreColorB;
uniform vec3 uRimColor;
uniform vec3 uAmbientTint;

out vec4 fragColor;

${ECHO_SHADER_COMMON_GLSL}

void main() {
  vec3 v = normalize(uCameraPos - vWorldPos);
  vec3 n = normalize(vWorldNormal);
  if (dot(n, v) < 0.0) {
    n = -n;
  }

  float hemiMask = mix(1.0, smoothstep(-0.18, 0.24, vViewZ), step(0.75, uPassFade));

  float cosV = clamp(dot(n, v), 0.0, 1.0);
  float limbFresnel = pow(1.0 - cosV, 3.0);
  float speakFresnel = pow(1.0 - cosV, 1.50);
  float crest = smoothstep(0.01, 0.13, abs(vRadialDisp)) * (0.38 + 0.92 * uVoiceRms) * uSpeakFieldMix;

  // Flowing 3D sculpted liquid-light caustics wrapping the pearlescent core during Speaking
  float flowCoordA = vUnitDir.y * 6.6 + sin(vUnitDir.x * 3.8 + uTime * 1.8) * 1.35 + vRadialDisp * 13.0;
  float waveRibbonA = pow(0.5 + 0.5 * sin(flowCoordA - uTime * 2.5), 3.4);
  float flowCoordB = (vUnitDir.x * 0.72 - vUnitDir.z * 0.68) * 5.8 + cos(vUnitDir.y * 4.2 - uTime * 1.5) * 1.25 + vRadialDisp * 11.0;
  float waveRibbonB = pow(0.5 + 0.5 * sin(flowCoordB + uTime * 2.0), 4.0);
  float silkBands = (waveRibbonA * 0.66 + waveRibbonB * 0.54) * (0.28 + 0.72 * speakFresnel) * uSpeakFieldMix * (0.64 + 0.76 * uVoiceRms + 0.38 * uOnsetFlux);

  // Smooth radial safety vignette reaching 0.0 at 1.80 (< 1.8594 frustum edge)
  float outerSafe = smoothstep(1.80, 1.44, vRadiusLen);

  vec3 irid = thinFilmNacre(cosV, 340.0 + 420.0 * vRadialDisp + 80.0 * uAudioTreble + 14.0 * sin(uTime * 0.65));
  vec3 col = mix(vec3(0.06, 0.90, 0.98), vec3(0.58, 0.32, 1.00), clamp(0.45 + vRadialDisp * 3.4 + waveRibbonB * 0.42, 0.0, 1.0));
  col = mix(col, vec3(0.98, 0.38, 0.82), waveRibbonA * 0.50);
  col = mix(col, irid, 0.32 + 0.22 * speakFresnel);

  float nonSpeakRim = limbFresnel * (0.24 + 0.22 * uVoiceRms) * (1.0 - uSpeakFieldMix);
  float speakRibbonIntensity = (speakFresnel * 0.28 + crest * 0.42 + silkBands * 0.88) * uSpeakFieldMix;
  float intensity = (nonSpeakRim + speakRibbonIntensity) * uPassFade * outerSafe * hemiMask;

  float projR = length(vWorldPos.xy);
  float exteriorMask = smoothstep(0.82, 0.98, projR) * (1.0 - uDark);

  vec3 extOpalInk = mix(vec3(0.06, 0.68, 0.96), vec3(0.54, 0.32, 0.96), clamp(0.45 + vRadialDisp * 3.0, 0.0, 1.0));
  extOpalInk = mix(extOpalInk, vec3(0.92, 0.36, 0.78), 0.38 * waveRibbonA);
  vec3 finalCol = mix(col, extOpalInk, exteriorMask);

  // Low alphaDark + vibrant RGB keeps Dark-mode Speaking aura bioluminescent (zero grey smoke!)
  float alphaDark = clamp(intensity * mix(0.10, 0.18, uSpeakFieldMix), 0.0, 0.22);
  float alphaLight = clamp(intensity * mix(0.24, 0.38, uSpeakFieldMix), 0.0, 0.42);
  float alpha = mix(alphaLight, alphaDark, uDark);

  vec3 rgbInterior = min(vec3(0.78), finalCol * intensity * mix(0.64, 0.76, uDark));
  vec3 rgbLightExt = min(vec3(alpha), extOpalInk * alpha);
  vec3 rgb = mix(rgbInterior, rgbLightExt, exteriorMask);
  rgb = mix(rgb, min(rgb, vec3(alpha)), (1.0 - uDark) * exteriorMask);

  fragColor = vec4(rgb, alpha);
}
`;

export const ECHO_SHADER_PROGRAMS = {
  halo:   { vertexShader: ECHO_HALO_VERTEX_SHADER,   fragmentShader: ECHO_HALO_FRAGMENT_SHADER,   renderOrder: 5 },
  core:   { vertexShader: ECHO_CORE_VERTEX_SHADER,   fragmentShader: ECHO_CORE_FRAGMENT_SHADER,   renderOrder: 20 },
  wave:   { vertexShader: ECHO_WAVE_VERTEX_SHADER,   fragmentShader: ECHO_WAVE_FRAGMENT_SHADER,   renderOrder: 25 },
  rings:  { vertexShader: ECHO_RINGS_VERTEX_SHADER,  fragmentShader: ECHO_RINGS_FRAGMENT_SHADER,  renderOrder: 30 },
  trails: { vertexShader: ECHO_TRAILS_VERTEX_SHADER, fragmentShader: ECHO_TRAILS_FRAGMENT_SHADER, renderOrder: 40 },
  aura:   { vertexShader: ECHO_AURA_VERTEX_SHADER,   fragmentShader: ECHO_AURA_FRAGMENT_SHADER,   renderOrders: [10, 50] as const },
} as const;
