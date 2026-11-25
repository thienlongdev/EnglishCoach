import * as THREE from 'three';
import { loadWhaleRig, type WhaleRig } from '@/components/landing/ocean/whaleRig';
import { ECHO_MODEL_URL } from '@/components/landing/ocean/echoAssets';
import type { EchoCarry, JourneyScene } from '@/lib/journey/journey';

/**
 * The passage between two places of the ocean: a liquid rift that opens on the edge Echo swims into, fills the window with a current of light, and
 * opens again on the opposite edge to show the next place. A short-lived overlay: it exists only during a journey, draws over the page, takes no pointer
 * and gives its context back (`forceContextLoss`) when the journey ends. Everything runs on the visitor's GPU; no request but the whale model, and that
 * only when the bridge itself must carry Echo (the Workspace has no scene of its own, or a slow destination).
 */
export interface BridgePalette { deep: string; glow: string; core: string }

export const PALETTES: Record<'landing' | 'authDay' | 'authDawn' | 'authNight' | 'workspace' | 'workspaceNight', BridgePalette> = {
  landing: { deep: '#031a58', glow: '#1e78e6', core: '#9ff0ff' },
  authDay: { deep: '#0a3aa8', glow: '#3f9df2', core: '#e9f7ff' },
  authDawn: { deep: '#2a2a8e', glow: '#a678e6', core: '#ffd9e6' },
  authNight: { deep: '#040a2c', glow: '#2b4aa8', core: '#c4d4ff' },
  workspace: { deep: '#0a2a78', glow: '#57a4f5', core: '#f2fbff' },
  workspaceNight: { deep: '#050b28', glow: '#2c56b4', core: '#a9dcff' },
};

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// A signed front per opening (domain-warped, so the edge is water and not a circle), and the interior: a flight down a current. Every angular pattern uses
// integer multiples of the angle or its cosine and sine, so the tunnel has no seam.
const FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uAspect;
  uniform float uCover;
  uniform float uReveal;
  uniform float uCoverDir;
  uniform float uCoverY;
  uniform float uRevealY;
  uniform float uMix;
  uniform float uFlow;
  uniform vec3 uDeepA;
  uniform vec3 uGlowA;
  uniform vec3 uCoreA;
  uniform vec3 uDeepB;
  uniform vec3 uGlowB;
  uniform vec3 uCoreB;

  const float TAU = 6.2831853;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float sum = noise(p) * 0.5;
    p = p * 2.03 + vec2(13.7, 7.1);
    sum += noise(p) * 0.25;
    p = p * 2.01 + vec2(4.3, 19.2);
    sum += noise(p) * 0.125;
    return sum / 0.875;
  }

  // Distance to an opening: negative inside. Taller than wide, its edge moved by the water.
  float front(vec2 p, vec2 centre, float radius) {
    vec2 q = p - centre;
    float w = fbm(q * 2.3 + vec2(uTime * 0.22, -uTime * 0.31)) - 0.5;
    float w2 = fbm(q * 6.1 + vec2(-uTime * 0.4, uTime * 0.27)) - 0.5;
    return length(q * vec2(1.0, 0.82)) + (w * 0.42 + w2 * 0.1) * (0.35 + min(radius, 1.0) * 0.65) - radius;
  }

  // The light that plays on anything under water: the same iterated-sine net as the Landing's water, bent onto the walls of the current.
  float caustic(vec2 p) {
    p = mod(p, TAU) - 250.0;
    vec2 i = p;
    float c = 1.0;
    float t = uTime * 0.5;
    for (int n = 0; n < 3; n++) {
      float tt = t * (1.0 - (3.5 / float(n + 1)));
      i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
    }
    c /= 3.0;
    c = 1.17 - pow(c, 1.4);
    return min(pow(abs(c), 8.0), 1.2);
  }

  vec3 current(vec2 p, vec2 v, float bright) {
    vec3 deep = mix(uDeepA, uDeepB, uMix);
    vec3 glow = mix(uGlowA, uGlowB, uMix);
    vec3 core = mix(uCoreA, uCoreB, uMix);
    vec2 w = p - v;
    float r = length(w);
    float depth = 0.4 / (r + 0.12);
    float z = depth - uTime * uFlow;
    // Water does not fly in straight lines: the whole current turns slowly around its axis, more the deeper it is.
    float a = atan(w.y, w.x) + depth * 0.55 + sin(z * 0.9) * 0.16;

    // the walls of the current: slow masses of lighter and darker water
    vec2 ring = vec2(cos(a), sin(a));
    float wall = fbm(ring * 1.9 + vec2(z * 0.42, -z * 0.27));
    float wall2 = fbm(ring * 4.2 + vec2(-z * 0.8, z * 0.5));
    vec3 col = mix(deep * 0.82, glow, smoothstep(0.3, 0.78, wall) * 0.62);
    col += glow * smoothstep(0.55, 0.9, wall2) * 0.2;

    // sunlight netted over them
    float net = caustic(vec2(a * 2.0, z * 1.4) * vec2(1.0, 1.0) + ring * 2.0);
    col += mix(glow, core, 0.55) * net * smoothstep(0.12, 0.6, r) * 0.34;

    // soft ribbons running past
    float s1 = 0.5 + 0.5 * sin(a * 9.0 + 4.0 * noise(vec2(z * 0.4, 2.1)));
    float s2 = 0.5 + 0.5 * sin(a * 23.0 - 5.0 * noise(vec2(z * 0.7, 8.4)));
    float ribbon = pow(s1, 5.0) * 0.5 + pow(s2, 8.0) * 0.26;
    ribbon *= smoothstep(0.14, 0.7, r) * smoothstep(0.36, 0.74, noise(vec2(ring.x * 3.0 + 9.0, z * 0.5 + ring.y * 3.0)));
    col += mix(glow, core, 0.4) * ribbon * 0.3;

    // the light ahead: a glow far down the current, never a white flash
    col += core * exp(-r * r * 26.0) * (0.42 + bright * 0.4);
    col += mix(glow, core, 0.35) * exp(-r * 2.6) * 0.3;

    // living motes in the current
    for (int layer = 0; layer < 2; layer++) {
      float n = layer == 0 ? 26.0 : 44.0;
      float speed = layer == 0 ? 1.0 : 1.7;
      vec2 cell = vec2(fract(a / TAU + 0.5) * n, depth * 3.4 - uTime * uFlow * speed);
      vec2 id = vec2(mod(floor(cell.x), n), floor(cell.y));
      vec2 f = fract(cell) - 0.5;
      float h = hash(id + float(layer) * 17.0);
      float on = step(0.72, h);
      float size = mix(0.09, 0.22, fract(h * 13.7));
      f -= (vec2(fract(h * 7.3), fract(h * 3.1)) - 0.5) * 0.5;
      col += mix(core, vec3(0.62, 0.94, 1.0), fract(h * 5.9)) * on * smoothstep(size, 0.0, length(f)) * smoothstep(0.08, 0.55, r) * 0.6;
    }
    return col * (1.0 - smoothstep(0.7, 1.9, r) * 0.42);
  }

  void main() {
    vec2 p = vec2(vUv.x * uAspect, vUv.y);
    // The passage opens on the edge Echo swims into; the next place opens on the opposite one.
    vec2 coverAt = vec2(uCoverDir > 0.0 ? uAspect + 0.04 : -0.04, uCoverY);
    vec2 revealAt = vec2(uCoverDir > 0.0 ? -0.04 : uAspect + 0.04, uRevealY);
    float span = uAspect + 0.95;
    float cover = front(p, coverAt, uCover * span);
    float reveal = uReveal > 0.0 ? front(p, revealAt, uReveal * span) : 1.0;

    float inCover = smoothstep(0.006, -0.006, cover);
    float inReveal = uReveal > 0.0 ? smoothstep(0.006, -0.006, reveal) : 0.0;
    float solid = inCover * (1.0 - inReveal);

    // The vanishing point travels with the journey, from the opening ahead to the opening behind.
    vec2 v = mix(vec2(coverAt.x - uCoverDir * 0.34, uCoverY), vec2(uAspect * 0.5, 0.52), smoothstep(0.1, 0.8, uCover));
    if (uReveal > 0.0) v = mix(v, vec2(revealAt.x + uCoverDir * 0.25, uRevealY), smoothstep(0.0, 0.45, uReveal));
    vec3 inside = current(p, v, uReveal);

    // The lit lip of each opening, split like light through a lens (additive: alpha stays with the page).
    vec3 lip = mix(uCoreA, uCoreB, uMix);
    float rim = 0.0;
    vec3 rimColour = vec3(0.0);
    if (uCover > 0.001 && uCover < 0.999) {
      float near = exp(-abs(cover) * 62.0);
      rim = max(rim, near);
      rimColour += vec3(exp(-abs(cover + 0.006) * 92.0), exp(-abs(cover) * 92.0), exp(-abs(cover - 0.006) * 92.0)) * lip * 0.72;
      rimColour += lip * exp(-max(cover, 0.0) * 14.0) * (1.0 - inCover) * 0.16;
    }
    if (uReveal > 0.001 && uReveal < 0.999) {
      float near = exp(-abs(reveal) * 62.0);
      rim = max(rim, near);
      rimColour += vec3(exp(-abs(reveal + 0.006) * 92.0), exp(-abs(reveal) * 92.0), exp(-abs(reveal - 0.006) * 92.0)) * lip * 0.72;
      rimColour += lip * exp(-max(-reveal, 0.0) * 14.0) * inReveal * 0.16;
    }

    // Premultiplied: the current replaces the page, the lip only adds light to it.
    gl_FragColor = vec4(inside * solid + rimColour, solid);
  }
`;

const BUBBLE_VERTEX = /* glsl */ `
  attribute float aLife;
  attribute float aSize;
  uniform float uPixelRatio;
  varying float vLife;
  void main() {
    vLife = aLife;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aLife > 0.0 ? aSize * uPixelRatio / max(0.2, -(modelViewMatrix * vec4(position, 1.0)).z) : 0.0;
  }
`;
const BUBBLE_FRAGMENT = /* glsl */ `
  precision highp float;
  varying float vLife;
  void main() {
    if (vLife <= 0.0) discard;
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    float rim = smoothstep(0.62, 0.9, r) * smoothstep(1.0, 0.9, r);
    float glint = smoothstep(0.24, 0.0, length(c - vec2(-0.16, 0.16)));
    float a = (rim * 0.75 + smoothstep(1.0, 0.0, r) * 0.14 + glint * 0.7) * min(1.0, vLife * 2.0);
    gl_FragColor = vec4(vec3(0.82, 0.96, 1.0) * a, a);
  }
`;

const FOV = 30;
const TAN_HALF = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const BUBBLES = 60;
const ease = {
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  in: (t: number) => t * t * t,
  out: (t: number) => 1 - Math.pow(1 - t, 3),
};
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

export interface BridgeOptions {
  host: HTMLElement;
  from: BridgePalette;
  to: BridgePalette;
  dir: 1 | -1;
  /** The opening ahead is centred where Echo crosses. */
  y: number;
  /** A journey that starts covered: the browser already changed the page, or the page was loaded into it. */
  startCovered: boolean;
  onLost: () => void;
}

export interface Bridge {
  /** Resolves once the first frame is drawn (the shaders are compiled off the main thread where the driver allows). */
  ready: Promise<boolean>;
  /** Open the passage over `ms`; resolves when the window is covered. */
  cover(ms: number): Promise<void>;
  /** Echo leaves a scene that has no whale of its own: from the companion's place to the edge of the opening. Null when the model is not there in time. */
  departEcho(from: { x: number; y: number; size: number }, to: { y: number; size: number }, ms: number, onStart: () => void): Promise<EchoCarry | null>;
  /** Echo in the current, while a slow destination gets ready. Costs the model only if the wait is real. */
  holdEcho(carry: EchoCarry | null): void;
  /** A whale waiting in the current swims out across the far edge before the next place opens, so the next scene brings in the same body, not a second one. */
  releaseEcho(carry: EchoCarry, ms: number): Promise<EchoCarry>;
  /** Open the next place over `ms`; resolves when the window is clear. */
  reveal(ms: number, y: number): Promise<void>;
  /** Echo crosses the revealed page to `target` (the companion's place) and fades there. */
  carryEcho(carry: EchoCarry, target: { x: number; y: number; size: number } | null, ms: number): Promise<void>;
  /** Lets the model load begin before it is needed. */
  loadEcho(): void;
  dispose(): void;
}

export function createBridge(options: BridgeOptions): Bridge {
  const { host, dir } = options;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.purpose = 'journey-bridge';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;opacity:1;';
  host.appendChild(canvas);
  const abort = new AbortController();
  let disposed = false;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: true, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const coarse = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768;
  const baseRatio = Math.min(window.devicePixelRatio || 1, 1) * (coarse ? 0.72 : 0.9);
  let ratio = baseRatio;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 300);
  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x13205a, 1.15));
  const sun = new THREE.DirectionalLight(0xfff8ec, 2);
  sun.position.set(0.55, 1, 0.35);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9fdcff, 1.5);
  fill.position.set(-0.5, 0.25, 1);
  scene.add(fill);
  const rimLight = new THREE.DirectionalLight(0xa5f3fc, 2);
  rimLight.position.set(-0.7, 0.6, -1);
  scene.add(rimLight);

  // The shader writes display colours directly (no colour management on the quad), so a uniform holds the sRGB numbers of its hex.
  const colour = (hex: string) => new THREE.Color(hex).convertLinearToSRGB();
  const uniforms = {
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uCover: { value: options.startCovered ? 1 : 0 },
    uReveal: { value: 0 },
    uCoverDir: { value: dir },
    uCoverY: { value: 1 - options.y },
    uRevealY: { value: 1 - options.y },
    uMix: { value: options.startCovered ? 1 : 0 },
    uFlow: { value: 0.55 },
    uDeepA: { value: colour(options.from.deep) },
    uGlowA: { value: colour(options.from.glow) },
    uCoreA: { value: colour(options.from.core) },
    uDeepB: { value: colour(options.to.deep) },
    uGlowB: { value: colour(options.to.glow) },
    uCoreB: { value: colour(options.to.core) },
  };
  const material = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  quad.renderOrder = -10;
  scene.add(quad);

  // Echo's breath when the bridge carries it
  const bubblePos = new Float32Array(BUBBLES * 3);
  const bubbleVel = new Float32Array(BUBBLES * 3);
  const bubbleLife = new Float32Array(BUBBLES);
  const bubbleSize = new Float32Array(BUBBLES);
  const bubbleGeometry = new THREE.BufferGeometry();
  bubbleGeometry.setAttribute('position', new THREE.BufferAttribute(bubblePos, 3).setUsage(THREE.DynamicDrawUsage));
  bubbleGeometry.setAttribute('aLife', new THREE.BufferAttribute(bubbleLife, 1).setUsage(THREE.DynamicDrawUsage));
  bubbleGeometry.setAttribute('aSize', new THREE.BufferAttribute(bubbleSize, 1).setUsage(THREE.DynamicDrawUsage));
  const bubbleUniforms = { uPixelRatio: { value: 1 } };
  const bubbleMaterial = new THREE.ShaderMaterial({ vertexShader: BUBBLE_VERTEX, fragmentShader: BUBBLE_FRAGMENT, uniforms: bubbleUniforms, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, toneMapped: false });
  const bubbles = new THREE.Points(bubbleGeometry, bubbleMaterial);
  bubbles.frustumCulled = false;
  bubbles.renderOrder = 5;
  scene.add(bubbles);
  let bubbleNext = 0;

  let vw = 1;
  let vh = 1;
  const applySize = () => {
    vw = Math.max(1, window.innerWidth);
    vh = Math.max(1, window.innerHeight);
    renderer.setPixelRatio(ratio);
    renderer.setSize(vw, vh, false);
    camera.aspect = vw / vh;
    camera.updateProjectionMatrix();
    uniforms.uAspect.value = vw / vh;
    bubbleUniforms.uPixelRatio.value = ratio;
  };
  applySize();

  const worldAt = (x: number, y: number, size: number, out: THREE.Vector3) => {
    const d = Math.min(220, Math.max(1.2, vh / (Math.max(size, 8) * 2 * TAN_HALF)));
    return out.set(((x / vw) * 2 - 1) * d * TAN_HALF * camera.aspect, (1 - (y / vh) * 2) * d * TAN_HALF, -d);
  };

  // ── Echo, when the bridge carries it ──
  let rig: WhaleRig | null = null;
  let rigLoad: Promise<WhaleRig | null> | null = null;
  const loadEcho = () => {
    rigLoad ??= loadWhaleRig(ECHO_MODEL_URL, abort.signal)
      .then((loaded) => {
        if (disposed) {
          loaded.dispose();
          return null;
        }
        loaded.root.visible = false;
        scene.add(loaded.root);
        rig = loaded;
        return loaded;
      })
      .catch(() => null);
    return rigLoad;
  };

  interface Flight { x: number; y: number; size: number; vx: number; vy: number; heading: THREE.Vector3; roll: number; speedBl: number }
  const flight: Flight = { x: 0, y: 0, size: 200, vx: 0, vy: 0, heading: new THREE.Vector3(dir, 0, 0.2).normalize(), roll: 0, speedBl: 1 };
  const look = new THREE.Matrix4();
  const lookQ = new THREE.Quaternion();
  const rollQ = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const origin = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const here = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  let script: ((now: number, dt: number) => void) | null = null;
  let released = false;

  const placeWhale = (dt: number, bob: number) => {
    if (!rig) return;
    prev.copy(here);
    worldAt(flight.x, flight.y, flight.size, here);
    rig.root.position.copy(here);
    rig.root.position.y += bob;
    if (dt > 0) {
      velocity.subVectors(here, prev).divideScalar(dt);
      if (velocity.lengthSq() > 1e-4) flight.heading.lerp(velocity.normalize(), 1 - Math.exp(-dt * 7)).normalize();
    }
    const yawDrift = flight.heading.x;
    flight.roll += (THREE.MathUtils.clamp(-flight.vy * 0.0014 * Math.sign(yawDrift || 1), -0.5, 0.5) - flight.roll) * Math.min(1, dt * 4);
    look.lookAt(flight.heading, origin, up);
    lookQ.setFromRotationMatrix(look);
    rollQ.setFromAxisAngle(zAxis, flight.roll);
    rig.root.quaternion.copy(lookQ).multiply(rollQ);
    rig.root.updateMatrixWorld(true);
    rig.update(dt, flight.speedBl, 0.25);
    rig.setWaterLight(uniforms.uTime.value, 0.4);
  };

  const emitBubble = () => {
    if (!rig) return;
    const i = bubbleNext;
    bubbleNext = (bubbleNext + 1) % BUBBLES;
    prev.copy(rig.fluke).applyMatrix4(rig.root.matrixWorld);
    bubblePos[i * 3] = prev.x;
    bubblePos[i * 3 + 1] = prev.y;
    bubblePos[i * 3 + 2] = prev.z;
    worldAt(flight.x, flight.y, flight.size, here);
    const scale = -here.z * 0.04;
    bubbleVel[i * 3] = (Math.random() - 0.5) * scale;
    bubbleVel[i * 3 + 1] = (0.5 + Math.random() * 0.7) * scale;
    bubbleVel[i * 3 + 2] = 0;
    bubbleLife[i] = 1;
    bubbleSize[i] = 40 + Math.random() * 90;
  };
  const stepBubbles = (dt: number) => {
    for (let i = 0; i < BUBBLES; i++) {
      if (bubbleLife[i] <= 0) continue;
      bubbleLife[i] = Math.max(0, bubbleLife[i] - dt / 1.5);
      bubblePos[i * 3] += bubbleVel[i * 3] * dt;
      bubblePos[i * 3 + 1] += bubbleVel[i * 3 + 1] * dt;
    }
    (bubbleGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (bubbleGeometry.attributes.aLife as THREE.BufferAttribute).needsUpdate = true;
    (bubbleGeometry.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
  };

  // ── Loop ──
  interface Tween { from: number; to: number; start: number; ms: number; shape: (t: number) => number; apply: (v: number) => void; done: () => void }
  const tweens: Tween[] = [];
  const tween = (from: number, to: number, ms: number, shape: (t: number) => number, apply: (v: number) => void) =>
    new Promise<void>((resolve) => {
      tweens.push({ from, to, start: performance.now(), ms: Math.max(1, ms), shape, apply, done: resolve });
    });

  let raf = 0;
  let last = 0;
  let live = false;
  let resolveReady: (value: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  let slow = 0;
  let samples = 0;

  const frame = (now: number) => {
    raf = 0;
    if (disposed) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    uniforms.uTime.value += dt;
    for (let i = tweens.length - 1; i >= 0; i--) {
      const t = tweens[i];
      const k = clamp01((now - t.start) / t.ms);
      t.apply(t.from + (t.to - t.from) * t.shape(k));
      if (k >= 1) {
        tweens.splice(i, 1);
        t.done();
      }
    }
    script?.(now, dt);
    stepBubbles(dt);
    // A device that cannot keep up draws fewer pixels rather than stuttering through the one moment that must feel fluid.
    samples++;
    if (dt > 0.026) slow++;
    if (samples >= 20) {
      if (slow > 10 && ratio > 0.45) {
        ratio = Math.max(0.45, ratio * 0.75);
        applySize();
      }
      samples = 0;
      slow = 0;
    }
    renderer.render(scene, camera);
    if (!live) {
      live = true;
      resolveReady(true);
    }
    raf = requestAnimationFrame(frame);
  };

  const onLost = (event: Event) => {
    event.preventDefault();
    resolveReady(false);
    options.onLost();
  };
  const onResize = () => applySize();
  canvas.addEventListener('webglcontextlost', onLost);
  window.addEventListener('resize', onResize, { passive: true });

  const start = () => {
    if (disposed || raf) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  };
  try {
    renderer.compileAsync(scene, camera).then(start, start);
  } catch {
    start();
  }

  return {
    ready,
    cover(ms) {
      // The colours turn from where Echo was to where it is going on the way through; the current speeds up while the opening fills the window.
      void tween(0, 1, ms * 1.8, ease.inOut, (v) => {
        uniforms.uMix.value = v;
      });
      void tween(0.4, 1.15, ms, ease.inOut, (v) => {
        uniforms.uFlow.value = v;
      });
      return tween(uniforms.uCover.value, 1, ms, ease.in, (v) => {
        uniforms.uCover.value = v;
      });
    },
    async departEcho(from, to, ms, onStart) {
      const loaded = await Promise.race([loadEcho(), new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 450))]);
      if (!loaded || disposed) return null;
      const seconds = ms / 1000;
      const x1 = dir > 0 ? vw + to.size * 0.66 : -to.size * 0.66;
      const y1 = vh * to.y;
      const speed = Math.max(vw * 0.8, (Math.abs(x1 - from.x) / seconds) * 1.45);
      flight.size = from.size;
      flight.x = from.x;
      flight.y = from.y;
      flight.heading.set(dir, 0, 0.2).normalize();
      loaded.root.visible = true;
      worldAt(from.x, from.y, from.size, here);
      onStart();
      const began = performance.now();
      return new Promise<EchoCarry | null>((resolve) => {
        script = (now, dt) => {
          const t = clamp01((now - began) / ms);
          const t2 = t * t;
          const t3 = t2 * t;
          const nx = (2 * t3 - 3 * t2 + 1) * from.x + (-2 * t3 + 3 * t2) * x1 + (t3 - t2) * seconds * dir * speed;
          const ny = from.y + (y1 - from.y) * ease.inOut(t) + Math.sin(t * Math.PI) * vh * 0.05;
          flight.vx = (nx - flight.x) / Math.max(dt, 0.001);
          flight.vy = (ny - flight.y) / Math.max(dt, 0.001);
          flight.x = nx;
          flight.y = ny;
          flight.size = Math.exp(Math.log(from.size) + (Math.log(to.size) - Math.log(from.size)) * ease.inOut(t));
          flight.speedBl = Math.max(0.8, (Math.abs(flight.vx) / flight.size) * 0.5);
          placeWhale(dt, 0);
          if (Math.random() < dt * 16) emitBubble();
          if (t >= 1) {
            loaded.root.visible = false;
            script = null;
            resolve({ dir, y: to.y, size: to.size, speed, tail: loaded.swimTime() });
          }
        };
      });
    },
    releaseEcho(carry, ms) {
      released = true;
      const body = rig;
      if (!body || !script) return Promise.resolve(carry);
      const seconds = ms / 1000;
      const x0 = flight.x;
      const y0 = flight.y;
      const vx0 = Math.max(-vw, Math.min(vw, flight.vx));
      const vy0 = Math.max(-vh, Math.min(vh, flight.vy));
      const size0 = flight.size;
      const x1 = dir > 0 ? vw + carry.size * 0.66 : -carry.size * 0.66;
      const y1 = vh * carry.y;
      const speed = Math.max(vw * 0.8, (Math.abs(x1 - x0) / seconds) * 1.45);
      const began = performance.now();
      return new Promise<EchoCarry>((resolve) => {
        script = (now, dt) => {
          const t = clamp01((now - began) / ms);
          const t2 = t * t;
          const t3 = t2 * t;
          const h00 = 2 * t3 - 3 * t2 + 1;
          const h10 = t3 - 2 * t2 + t;
          const h01 = -2 * t3 + 3 * t2;
          const h11 = t3 - t2;
          const nx = h00 * x0 + h10 * seconds * vx0 + h01 * x1 + h11 * seconds * dir * speed;
          const ny = h00 * y0 + h10 * seconds * vy0 + h01 * y1;
          flight.vx = (nx - flight.x) / Math.max(dt, 0.001);
          flight.vy = (ny - flight.y) / Math.max(dt, 0.001);
          flight.x = nx;
          flight.y = ny;
          flight.size = Math.exp(Math.log(size0) + (Math.log(carry.size) - Math.log(size0)) * ease.inOut(t));
          flight.speedBl = Math.max(1.1, (Math.abs(flight.vx) / flight.size) * 0.5);
          placeWhale(dt, 0);
          if (Math.random() < dt * 12) emitBubble();
          if (t >= 1) {
            body.root.visible = false;
            script = null;
            resolve({ ...carry, speed, tail: body.swimTime() });
          }
        };
      });
    },
    holdEcho(carry) {
      void loadEcho().then((loaded) => {
        if (!loaded || disposed || script || released) return;
        flight.size = Math.max(90, Math.min(240, (carry?.size ?? vw * 0.16) * 0.72));
        flight.x = dir > 0 ? -flight.size : vw + flight.size;
        flight.y = vh * (carry?.y ?? 0.55);
        flight.speedBl = 1.1;
        loaded.root.visible = true;
        worldAt(flight.x, flight.y, flight.size, here);
        const entered = performance.now();
        script = (now, dt) => {
          // Echo waits in the current with the visitor: swims in, then holds a slow S in the middle of the window.
          const t = (now - entered) / 1000;
          const k = ease.out(clamp01(t / 1.4));
          const edge = dir > 0 ? -flight.size : vw + flight.size;
          const nx = edge + (vw * 0.5 - edge) * k + Math.sin(t * 0.8) * vw * 0.06;
          const ny = vh * (0.5 + Math.sin(t * 0.55 + 1) * 0.09);
          flight.vx = (nx - flight.x) / Math.max(dt, 0.001);
          flight.vy = (ny - flight.y) / Math.max(dt, 0.001);
          flight.x = nx;
          flight.y = ny;
          placeWhale(dt, 0);
          if (Math.random() < dt * 5) emitBubble();
        };
      });
    },
    reveal(ms, y) {
      uniforms.uRevealY.value = 1 - y;
      void tween(uniforms.uFlow.value, 0.32, ms, ease.out, (v) => {
        uniforms.uFlow.value = v;
      });
      // A whale still in the current leaves ahead of the opening, across the far edge.
      if (rig && script) {
        const startX = flight.x;
        const startY = flight.y;
        const began = performance.now();
        const away = dir > 0 ? vw + flight.size * 1.2 : -flight.size * 1.2;
        script = (now, dt) => {
          const k = ease.in(clamp01((now - began) / (ms * 0.8)));
          flight.x = startX + (away - startX) * k;
          flight.y = startY + (vh * 0.5 - startY) * k;
          flight.speedBl = 1.3 + k;
          placeWhale(dt, 0);
          if (k >= 1 && rig) {
            rig.root.visible = false;
            script = null;
          }
        };
      }
      uniforms.uReveal.value = 0.0001;
      return tween(0.0001, 1, ms, ease.inOut, (v) => {
        uniforms.uReveal.value = v;
      });
    },
    async carryEcho(carry, target, ms) {
      const loaded = await Promise.race([loadEcho(), new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 900))]);
      if (!loaded || disposed) return;
      const startSize = carry.size;
      const fromX = dir > 0 ? -startSize * 0.55 : vw + startSize * 0.55;
      const fromY = vh * carry.y;
      const toX = target ? target.x : dir > 0 ? vw + startSize : -startSize;
      const toY = target ? target.y : vh * 0.42;
      const endSize = target ? Math.max(56, target.size) : startSize;
      flight.size = startSize;
      flight.x = fromX;
      flight.y = fromY;
      flight.heading.set(dir, 0, 0.18).normalize();
      loaded.setSwimTime(carry.tail);
      loaded.root.visible = true;
      worldAt(fromX, fromY, startSize, here);
      const began = performance.now();
      const seconds = ms / 1000;
      // Cubic Hermite in time: starts at the speed it crossed the edge with, ends turning up to rest at the companion's place.
      const v0x = dir * carry.speed;
      const v1x = target ? dir * carry.speed * 0.16 : dir * carry.speed;
      const dx = toX - fromX;
      const dy = toY - fromY;
      await new Promise<void>((resolve) => {
        script = (now, dt) => {
          const t = clamp01((now - began) / ms);
          const t2 = t * t;
          const t3 = t2 * t;
          const h10 = t3 - 2 * t2 + t;
          const h01 = -2 * t3 + 3 * t2;
          const h11 = t3 - t2;
          const nx = fromX + h10 * v0x * seconds + h01 * dx + h11 * v1x * seconds;
          // An arc, not a line: the body dips, then rises to its place.
          const ny = fromY + dy * ease.inOut(t) + Math.sin(t * Math.PI) * vh * 0.08;
          flight.vx = (nx - flight.x) / Math.max(dt, 0.001);
          flight.vy = (ny - flight.y) / Math.max(dt, 0.001);
          flight.x = nx;
          flight.y = ny;
          flight.size = Math.exp(Math.log(startSize) + (Math.log(endSize) - Math.log(startSize)) * ease.inOut(t));
          flight.speedBl = Math.max(0.35, (Math.hypot(flight.vx, flight.vy) / flight.size) * 0.5);
          placeWhale(dt, 0);
          if (Math.random() < dt * 14 * (1 - t)) emitBubble();
          if (t >= 1) {
            script = null;
            resolve();
          }
        };
      });
    },
    loadEcho() {
      void loadEcho();
    },
    dispose() {
      disposed = true;
      abort.abort();
      if (raf) cancelAnimationFrame(raf);
      resolveReady(false);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('webglcontextlost', onLost);
      for (const t of tweens.splice(0)) t.done();
      rig?.dispose();
      quad.geometry.dispose();
      material.dispose();
      bubbleGeometry.dispose();
      bubbleMaterial.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
