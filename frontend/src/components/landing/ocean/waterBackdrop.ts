import * as THREE from 'three';

/**
 * The living water behind everything in the ocean canvas: sun shafts from the surface, dancing caustic light, the
 * shimmering underside of the surface itself, deep-water bioluminescence, tap ripples and Echo's wake.
 *
 * It is pure LIGHT over the CSS base water (premultiplied output with alpha ≈ 0 adds to what is below), so it fades in
 * over the CSS ocean without a colour jump and the page keeps its water when WebGL is unavailable. It renders into a
 * low-resolution target (soft light needs no detail) and is stretched over the viewport, so its cost barely depends on
 * the screen size.
 */
const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uRes;        // viewport, CSS px
  uniform float uScroll;    // page scroll, CSS px
  uniform float uDepth;     // 0 at the top of the page, 1 at the bottom
  uniform vec4 uWhale;      // xy = Echo (uv, y down), z = radius (uv of height), w = swim energy 0..1
  uniform vec4 uRipples[3]; // xy = uv (y down), z = start time (s), w = strength (0 = none)
  uniform float uQuality;   // 1 = full, 0 = light

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }

  // Tileable water caustic (iterated sine warp): a bright network of light lines.
  // (tileable every 2π; the −250 offset keeps the iteration in its stable range)
  float caustic(vec2 p, float t) {
    p = mod(p, 6.28318) - 250.0;
    vec2 i = p;
    float c = 1.0;
    const float inten = 0.005;
    for (int n = 0; n < 4; n++) {
      float tt = t * (1.0 - (3.5 / float(n + 1)));
      i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
    }
    c /= 4.0;
    c = 1.17 - pow(c, 1.4);
    return min(pow(abs(c), 8.0), 1.5);
  }

  void main() {
    float aspect = uRes.x / uRes.y;
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);           // y down, like the page
    vec2 p = vec2(uv.x * aspect, uv.y);           // aspect-correct, height = 1
    float t = uTime;
    float scrollV = uScroll / uRes.y;             // viewports scrolled

    // Tap ripples bend the light (refraction ring) and flash along the ring.
    vec2 bend = vec2(0.0);
    float ringLight = 0.0;
    for (int r = 0; r < 3; r++) {
      vec4 rp = uRipples[r];
      if (rp.w <= 0.0) continue;
      float age = t - rp.z;
      if (age < 0.0 || age > 2.6) continue;
      vec2 d = p - vec2(rp.x * aspect, rp.y);
      float dist = length(d);
      float radius = age * 0.42;
      float ring = exp(-pow((dist - radius) * 18.0, 2.0)) * (1.0 - age / 2.6) * rp.w;
      bend += normalize(d + 1e-5) * ring * 0.035;
      ringLight += ring;
    }

    // Echo's wake: the water around the whale glows and its light is stirred.
    vec2 wd = p - vec2(uWhale.x * aspect, uWhale.y);
    float wr = max(uWhale.z, 0.01);
    float wake = exp(-dot(wd, wd) / (wr * wr * 1.6));
    bend += wd * wake * 0.04 * uWhale.w * sin(t * 2.0 + length(wd) * 30.0);

    vec2 q = p + bend;

    // ── Sun shafts: fanning from a sun above the top-right, shimmering slowly ──
    float surfaceFade = clamp(1.0 - scrollV * 0.55, 0.0, 1.0);
    vec2 sun = vec2(0.80 * aspect, -0.32 - scrollV * 0.25);
    vec2 sd = q - sun;
    float ang = atan(sd.x, sd.y);
    float rays = 0.0;
    rays += pow(noise(vec2(ang * 9.0, t * 0.10)), 3.0) * 0.9;
    rays += pow(noise(vec2(ang * 23.0 + 7.0, t * 0.17)), 4.0) * 0.7;
    rays += pow(noise(vec2(ang * 51.0 + 3.0, t * 0.29)), 6.0) * 0.5 * uQuality;
    float sunDist = length(sd);
    float rayFall = smoothstep(2.4, 0.2, sunDist) * smoothstep(-0.05, 0.25, uv.y + 0.2);
    // keep the shafts softer over the centre column (the title) than over the sides
    float titleCalm = 1.0 - 0.45 * exp(-pow((uv.x - 0.5) * 3.2, 2.0)) * exp(-pow((uv.y - 0.55) * 3.0, 2.0)) * surfaceFade;
    rays *= rayFall * titleCalm * (0.25 + 0.75 * surfaceFade);
    vec3 col = vec3(0.42, 0.78, 1.0) * rays * 0.32;

    // ── Sun glow at the top-right ──
    float glow = exp(-sunDist * 2.2) * surfaceFade;
    col += vec3(0.75, 0.92, 1.0) * glow * 0.55;

    // ── Underside of the surface: a bright wavy ceiling that scrolls away as we descend ──
    float surfY = 0.06 - scrollV * 0.65;
    float wave = (noise(vec2(q.x * 3.0 + t * 0.20, t * 0.15)) - 0.5) * 0.05 + sin(q.x * 9.0 + t * 0.8) * 0.006;
    float ceiling = smoothstep(surfY + 0.11, surfY - 0.02, q.y + wave);
    float shimmer = caustic(vec2(q.x * 7.0, q.y * 18.0) + vec2(t * 0.05, 0.0), t * 0.55);
    col += vec3(0.62, 0.9, 1.0) * ceiling * (0.22 + shimmer * 0.65);

    // ── Caustic light sheets drifting through the water, brightest near the surface and in the shafts ──
    vec2 cp = q * vec2(2.4, 2.4) + vec2(0.0, scrollV * 0.35) + vec2(t * 0.02, 0.0);
    float c1 = caustic(cp * 3.0, t * 0.35 + 23.0);
    float c2 = uQuality > 0.5 ? caustic(cp * 5.1 + 3.7, t * 0.28 + 11.0) : c1;
    float causticMask = (0.35 + rays * 1.8) * (0.25 + 0.75 * surfaceFade) * smoothstep(1.25, 0.0, q.y + scrollV * 0.2);
    causticMask *= titleCalm;
    col += vec3(0.45, 0.85, 1.0) * (c1 * 0.10 + c2 * 0.05) * causticMask;

    // ── Echo and the ripples light the water around them ──
    col += vec3(0.4, 0.85, 1.0) * wake * (0.035 + 0.05 * uWhale.w);
    col += vec3(0.62, 0.95, 1.0) * ringLight * 0.16;

    // ── Bioluminescence: sparse living sparks that grow richer with depth ──
    vec2 bp = vec2(p.x, uv.y + scrollV * 0.55) * 26.0;
    vec2 cell = floor(bp);
    vec2 f = fract(bp) - 0.5;
    float h = hash(cell);
    vec2 jitter = vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5;
    float spark = smoothstep(0.08, 0.0, length(f - jitter * 0.6)) * step(0.86, h);
    float twinkle = 0.5 + 0.5 * sin(t * (0.6 + h * 1.7) + h * 40.0);
    float bioAmount = smoothstep(0.15, 0.9, uDepth) * 0.9 + 0.12;
    vec3 bioCol = mix(vec3(0.4, 0.95, 1.0), vec3(0.75, 0.6, 1.0), hash(cell + 1.3));
    col += bioCol * spark * twinkle * bioAmount * 0.55;

    // Light only: alpha 0 means the compositor adds this over the CSS water below.
    gl_FragColor = vec4(col, 0.0);
  }
`;

const BLIT_VERTEX = VERTEX;
const BLIT_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform float uOpacity;
  void main() {
    vec4 c = texture2D(uTex, vUv);
    gl_FragColor = vec4(c.rgb * uOpacity, 0.0);
  }
`;

export interface WaterBackdrop {
  /** Renders the water into its low-resolution target. Call before the main scene. */
  render(renderer: THREE.WebGLRenderer): void;
  /** Compiles the water shader without blocking the main thread (resolves when it can be drawn without a stall). */
  compile(renderer: THREE.WebGLRenderer): Promise<unknown>;
  /** A full-screen quad that draws the target first in the main scene. */
  quad: THREE.Mesh;
  uniforms: {
    uTime: { value: number };
    uRes: { value: THREE.Vector2 };
    uScroll: { value: number };
    uDepth: { value: number };
    uWhale: { value: THREE.Vector4 };
    uRipples: { value: THREE.Vector4[] };
    uQuality: { value: number };
  };
  setOpacity(value: number): void;
  resize(width: number, height: number, scale: number): void;
  dispose(): void;
}

export function createWaterBackdrop(): WaterBackdrop {
  const uniforms = {
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uScroll: { value: 0 },
    uDepth: { value: 0 },
    uWhale: { value: new THREE.Vector4(-1, -1, 0.1, 0) },
    uRipples: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uQuality: { value: 1 },
  };
  const geometry = new THREE.PlaneGeometry(2, 2);
  const waterMaterial = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
  const waterScene = new THREE.Scene();
  const waterMesh = new THREE.Mesh(geometry, waterMaterial);
  waterMesh.frustumCulled = false;
  waterScene.add(waterMesh);
  const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const target = new THREE.WebGLRenderTarget(4, 4, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    type: THREE.HalfFloatType,
  });

  const blitUniforms = { uTex: { value: target.texture }, uOpacity: { value: 1 } };
  const blitMaterial = new THREE.ShaderMaterial({
    vertexShader: BLIT_VERTEX,
    fragmentShader: BLIT_FRAGMENT,
    uniforms: blitUniforms,
    depthTest: false,
    depthWrite: false,
    // Opaque list + lowest renderOrder ⇒ drawn FIRST, so Echo and the sea life are painted over the water, never
    // washed by it. Additive blending keeps it pure light over the CSS water.
    transparent: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  const quad = new THREE.Mesh(geometry, blitMaterial);
  quad.frustumCulled = false;
  quad.renderOrder = -10;

  return {
    quad,
    uniforms,
    render(renderer) {
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(waterScene, orthoCamera);
      renderer.setRenderTarget(previous);
    },
    compile(renderer) {
      // Compiled with the target bound: a program drawn into a render target has no tone mapping / output conversion,
      // so compiling it for the screen would leave the real variant to compile synchronously on the first frame.
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      try {
        return renderer.compileAsync(waterScene, orthoCamera);
      } finally {
        renderer.setRenderTarget(previous);
      }
    },
    setOpacity(value) {
      blitUniforms.uOpacity.value = value;
    },
    resize(width, height, scale) {
      target.setSize(Math.max(2, Math.round(width * scale)), Math.max(2, Math.round(height * scale)));
      uniforms.uRes.value.set(width, height);
    },
    dispose() {
      geometry.dispose();
      waterMaterial.dispose();
      blitMaterial.dispose();
      target.dispose();
    },
  };
}
