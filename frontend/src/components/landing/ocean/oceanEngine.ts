import * as THREE from 'three';
import { Lane, LaneSample, measureLanes, pickLane, readLanes, sampleLane } from './lanes';
import { oceanSignals } from './oceanSignals';
import { loadWhaleRig, WhaleRig } from './whaleRig';
import { createWaterBackdrop } from './waterBackdrop';
import { createSeaLife } from './seaLife';
import { createKnowledgeForms } from './knowledgeForms';
import { ECHO_STILL_HEADING } from './echoAssets';
import type { EchoCarry, JourneyStage } from '@/lib/journey/journey';

/**
 * The landing page ocean: ONE fixed, click-through WebGL canvas behind the page content.
 *
 * Echo swims in screen space (CSS px + an apparent body length), chasing a target sampled from the swim lane the
 * visitor is looking at. A damped spring gives believable acceleration and arrival; the body's heading, bank and swim
 * cycle all come from that motion, so the whale always swims the way it actually moves. Depth is real perspective: a
 * smaller target means further away, where the water hazes the body.
 *
 * Phase 2 ("living ocean"): the same canvas first paints the water itself (`waterBackdrop`: sun shafts, caustics,
 * the surface seen from below, bioluminescence, ripples, Echo's wake), then the sea life (`seaLife`), then Echo with
 * sun-dapples on its skin and a sparkle trail. The water is always alive, so the loop runs while the page is shown,
 * at half rate when nothing interactive is happening; it stops with the tab, and renders on demand under reduced
 * motion.
 */
/** `model`: Echo could not be loaded — the water keeps running. The other two take the whole WebGL layer down. */
export type OceanFailure = 'webgl' | 'model' | 'context-lost';

export interface OceanEngineOptions {
  canvas: HTMLCanvasElement;
  laneRoot: HTMLElement;
  modelUrl: string;
  reducedMotion: boolean;
  bubble: HTMLElement | null;
  bubbleText: HTMLElement | null;
  /** The first frame of water has been drawn. */
  onLive: () => void;
  /** Echo is in the scene, its shaders compiled, and swimming in. */
  onReady: () => void;
  /** The first frame with Echo has been drawn (the page may now retire its standby still). Called once. */
  onShown: () => void;
  /** The model request has stopped making progress (or is being retried): show the standby still. Called once. */
  onStall: () => void;
  onFail: (reason: OceanFailure) => void;
}

export interface OceanEngine {
  /** How the journey (lib/journey) sends Echo away and brings it back. */
  stage: JourneyStage;
  dispose(): void;
}

const NO_STAGE: JourneyStage = { depart: () => Promise.resolve(null), arrive() {}, awaitArrival() {}, isLive: () => false };

/** A journey's flight in screen space: a cubic Hermite in time, from the body's real position and velocity to the edge, so the whale curves out of whatever it was doing. */
interface EchoFlight {
  start: number;
  ms: number;
  x0: number; y0: number; vx0: number; vy0: number;
  x1: number; y1: number; vx1: number; vy1: number;
  ls0: number; ls1: number;
  onEnd: (() => void) | null;
}

// Model loading tells a STALLED request from a SLOW one by its progress (headers, then every body chunk), and keeps
// what the visitor sees apart from what the network does:
// - no progress for MODEL_STALL_MS: the page shows the standby still at once (presentation only; the request goes on);
// - no progress for MODEL_IDLE_MS: this attempt is cancelled and one fresh attempt follows (a request stuck on a lossy
//   connection rarely recovers by itself, a new one often does);
// - MODEL_ATTEMPT_MS caps an attempt that keeps trickling in. A slow but moving download is never cut short before it.
// After the second failure the standby still stays for good while the water keeps running.
const MODEL_STALL_MS = 2500;
const MODEL_IDLE_MS = 10000;
const MODEL_ATTEMPT_MS = 45000;
const MODEL_ATTEMPTS = 2;

const FOV = 30;
const TAN_HALF = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const HAZE_COLOR = 0x0f3470;
const GREETING = 'Chào bạn! Mình là Echo.';
const CTA_LINE = 'Bắt đầu thôi nào!';

const PLANKTON_VERTEX = /* glsl */ `
  attribute vec4 aSeed;
  uniform float uTime;
  uniform float uScroll;
  uniform float uViewH;
  uniform float uAspect;
  uniform float uPixelRatio;
  uniform float uTanHalf;
  uniform vec3 uWhale;   // ndc xy, radius (ndc of height); z = 0 → none
  uniform vec4 uRipple;  // ndc xy, age s, strength
  varying float vAlpha;
  varying float vTint;
  void main() {
    float depth = aSeed.z;
    float d = mix(5.0, 70.0, depth);
    float parallax = mix(0.32, 0.05, depth);
    float ny = aSeed.y + uScroll * parallax * 2.0 / uViewH + uTime * 0.012 * (0.4 + aSeed.w);
    ny = mod(ny + 1.15, 2.3) - 1.15;
    float nx = aSeed.x + sin(uTime * 0.11 + aSeed.w * 6.2831) * 0.015;
    vec3 p = vec3(nx * d * uTanHalf * uAspect, ny * d * uTanHalf, -d);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    // Motes part around Echo's body and are pushed by a tap ripple's front.
    vec2 ndc = gl_Position.xy / gl_Position.w;
    vec2 asp = vec2(uAspect, 1.0);
    if (uWhale.z > 0.0) {
      vec2 dw = (ndc - uWhale.xy) * asp;
      float lw = length(dw);
      if (lw < uWhale.z) ndc += dw / max(lw, 1e-4) / asp * (uWhale.z - lw) * 0.75;
    }
    if (uRipple.w > 0.0 && uRipple.z < 2.4) {
      vec2 dr = (ndc - uRipple.xy) * asp;
      float lr = length(dr);
      float ring = exp(-pow((lr - uRipple.z * 0.85) * 5.0, 2.0)) * (1.0 - uRipple.z / 2.4) * uRipple.w;
      ndc += dr / max(lr, 1e-4) / asp * ring * 0.09;
    }
    gl_Position.xy = ndc * gl_Position.w;
    gl_PointSize = mix(3.6, 1.3, depth) * uPixelRatio;
    float twinkle = 0.6 + 0.4 * sin(uTime * (0.5 + aSeed.w) + aSeed.w * 37.0);
    vAlpha = mix(0.5, 0.16, depth) * twinkle;
    vTint = fract(aSeed.w * 7.13);
  }
`;

const PLANKTON_FRAGMENT = /* glsl */ `
  varying float vAlpha;
  varying float vTint;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c);
    float a = smoothstep(0.5, 0.0, r);
    vec3 cyan = vec3(0.45, 0.88, 1.0);
    vec3 violet = vec3(0.68, 0.62, 1.0);
    gl_FragColor = vec4(mix(cyan, violet, vTint), a * a * vAlpha);
  }
`;

const BUBBLE_VERTEX = /* glsl */ `
  attribute float aLife;
  attribute float aSize;
  uniform float uPixelRatio;
  uniform float uViewH;
  uniform float uTanHalf;
  varying float vLife;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // aSize is in whale lengths; convert to pixels at this distance.
    float pxPerUnit = uViewH / (2.0 * -mv.z * uTanHalf);
    gl_PointSize = aLife > 0.0 ? max(1.5, aSize * pxPerUnit) * uPixelRatio : 0.0;
    vLife = aLife;
  }
`;

const BUBBLE_FRAGMENT = /* glsl */ `
  varying float vLife;
  void main() {
    if (vLife <= 0.0) discard;
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    float rim = smoothstep(0.62, 0.9, r) * smoothstep(1.0, 0.9, r);
    float fill = smoothstep(1.0, 0.0, r) * 0.18;
    float glint = smoothstep(0.22, 0.0, length(c - vec2(-0.16, 0.16)));
    float fade = smoothstep(0.0, 0.25, vLife) * smoothstep(1.0, 0.8, vLife);
    gl_FragColor = vec4(vec3(0.75, 0.95, 1.0), (rim * 0.8 + fill + glint * 0.7) * fade * 0.85);
  }
`;

const BUBBLE_COUNT = 40;
const SPARK_COUNT = 90;

// Echo's sparkle trail: tiny glowing motes shed by the fluke, twinkling as they fade.
const SPARK_FRAGMENT = /* glsl */ `
  varying float vLife;
  void main() {
    if (vLife <= 0.0) discard;
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    float core = smoothstep(1.0, 0.0, r);
    core = core * core;
    vec3 col = mix(vec3(0.75, 0.62, 1.0), vec3(0.6, 0.97, 1.0), vLife);
    gl_FragColor = vec4(col * core * vLife * 1.2, core * vLife);
  }
`;

/** Inverse of smoothstep(0, 1, t) — used to turn a desired haze into a fog distance. */
const inverseSmoothstep = (h: number) => 0.5 - Math.sin(Math.asin(1 - 2 * h) / 3);

export function createOceanEngine(options: OceanEngineOptions): OceanEngine {
  const { canvas, laneRoot, reducedMotion, bubble, bubbleText } = options;
  const abort = new AbortController();
  let disposed = false;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
  } catch {
    laneRoot.dataset.echo = 'failed-webgl';
    queueMicrotask(() => options.onFail('webgl'));
    return { stage: NO_STAGE, dispose() {} };
  }
  // Observable lifecycle for QA and support (no console output): loading → ready | failed-<reason>.
  laneRoot.dataset.echo = 'loading';
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HAZE_COLOR, 0, 1e6);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 300);
  camera.position.set(0, 0, 0);

  // Light from the surface above, a soft cyan fill from the visitor's side, cyan and violet rims from behind:
  // Echo reads pale and luminous against the deep water, as the brand mascot does.
  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x13205a, 1.15));
  const sun = new THREE.DirectionalLight(0xfff8ec, 2.0);
  sun.position.set(0.55, 1, 0.35);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9fdcff, 1.5);
  fill.position.set(-0.5, 0.25, 1);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xa5f3fc, 2.0);
  rim.position.set(-0.7, 0.6, -1);
  scene.add(rim);
  const violet = new THREE.DirectionalLight(0x818cf8, 1.3);
  violet.position.set(0.8, -0.3, -0.8);
  scene.add(violet);

  // ── Plankton: drifting motes at many depths, with scroll parallax computed on the GPU ──
  const coarse = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768;
  const planktonCount = coarse ? 70 : 150;
  const seeds = new Float32Array(planktonCount * 4);
  for (let i = 0; i < planktonCount; i++) {
    seeds[i * 4] = Math.random() * 2.3 - 1.15;
    seeds[i * 4 + 1] = Math.random() * 2.3 - 1.15;
    seeds[i * 4 + 2] = Math.pow(Math.random(), 0.7);
    seeds[i * 4 + 3] = Math.random();
  }
  const planktonGeometry = new THREE.BufferGeometry();
  planktonGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(planktonCount * 3), 3));
  planktonGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const planktonUniforms = {
    uTime: { value: 0 },
    uScroll: { value: 0 },
    uViewH: { value: 800 },
    uAspect: { value: 1 },
    uPixelRatio: { value: 1 },
    uTanHalf: { value: TAN_HALF },
    uWhale: { value: new THREE.Vector3(0, 0, 0) },
    uRipple: { value: new THREE.Vector4(0, 0, 9, 0) },
  };
  const planktonMaterial = new THREE.ShaderMaterial({
    vertexShader: PLANKTON_VERTEX,
    fragmentShader: PLANKTON_FRAGMENT,
    uniforms: planktonUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const plankton = new THREE.Points(planktonGeometry, planktonMaterial);
  plankton.frustumCulled = false;
  scene.add(plankton);

  // ── Bubbles: a small pool exhaled while Echo swims fast or celebrates ──
  const bubblePositions = new Float32Array(BUBBLE_COUNT * 3);
  const bubbleLife = new Float32Array(BUBBLE_COUNT);
  const bubbleSize = new Float32Array(BUBBLE_COUNT);
  const bubbleVelocity = new Float32Array(BUBBLE_COUNT * 3);
  const bubbleGeometry = new THREE.BufferGeometry();
  bubbleGeometry.setAttribute('position', new THREE.BufferAttribute(bubblePositions, 3));
  bubbleGeometry.setAttribute('aLife', new THREE.BufferAttribute(bubbleLife, 1));
  bubbleGeometry.setAttribute('aSize', new THREE.BufferAttribute(bubbleSize, 1));
  const bubbleUniforms = {
    uPixelRatio: { value: 1 },
    uViewH: { value: 800 },
    uTanHalf: { value: TAN_HALF },
  };
  const bubbleMaterial = new THREE.ShaderMaterial({
    vertexShader: BUBBLE_VERTEX,
    fragmentShader: BUBBLE_FRAGMENT,
    uniforms: bubbleUniforms,
    transparent: true,
    depthWrite: false,
  });
  const bubbles = new THREE.Points(bubbleGeometry, bubbleMaterial);
  bubbles.frustumCulled = false;
  scene.add(bubbles);
  let bubbleCursor = 0;
  let bubblesAlive = 0;

  const sparkPositions = new Float32Array(SPARK_COUNT * 3);
  const sparkLife = new Float32Array(SPARK_COUNT);
  const sparkSize = new Float32Array(SPARK_COUNT);
  const sparkVelocity = new Float32Array(SPARK_COUNT * 3);
  const sparkGeometry = new THREE.BufferGeometry();
  sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3));
  sparkGeometry.setAttribute('aLife', new THREE.BufferAttribute(sparkLife, 1));
  sparkGeometry.setAttribute('aSize', new THREE.BufferAttribute(sparkSize, 1));
  const sparkMaterial = new THREE.ShaderMaterial({
    vertexShader: BUBBLE_VERTEX,
    fragmentShader: SPARK_FRAGMENT,
    uniforms: bubbleUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sparks = new THREE.Points(sparkGeometry, sparkMaterial);
  sparks.frustumCulled = false;
  scene.add(sparks);
  let sparkCursor = 0;
  let sparkCarry = 0;

  // ── Knowledge forms: the light gathers into a shape where the page teaches something (`data-ocean-form`) ──
  const forms = createKnowledgeForms(coarse);
  scene.add(forms.points);
  forms.read(laneRoot);

  // ── The living water (drawn first) and the life in it ──
  const water = createWaterBackdrop();
  scene.add(water.quad);
  let lastRippleAt = 0;
  let rippleSlot = 0;
  let docHeight = document.documentElement.scrollHeight;

  // ── Viewport, quality ──
  let vw = window.innerWidth;
  let vh = window.innerHeight;
  const dprLevels = [Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 1.75), 1.25, 1, 0.8];
  let dprLevel = 0;
  const applySize = () => {
    vw = window.innerWidth;
    vh = window.innerHeight;
    const ratio = Math.min(dprLevels[0], dprLevels[dprLevel]);
    renderer.setPixelRatio(ratio);
    renderer.setSize(vw, vh, false);
    camera.aspect = vw / vh;
    camera.updateProjectionMatrix();
    planktonUniforms.uViewH.value = vh;
    planktonUniforms.uAspect.value = vw / vh;
    planktonUniforms.uPixelRatio.value = ratio;
    bubbleUniforms.uViewH.value = vh;
    bubbleUniforms.uPixelRatio.value = ratio;
    forms.resize(vw, vh, ratio);
    // Soft light needs little resolution: about half the CSS size, less on phones and on struggling devices.
    water.resize(vw, vh, (coarse ? 0.4 : 0.5) * (dprLevel >= 2 ? 0.7 : 1));
    water.uniforms.uQuality.value = coarse || dprLevel >= 2 ? 0 : 1;
  };
  applySize();

  // ── Lanes ──
  let lanes: Lane[] = readLanes(laneRoot);
  measureLanes(lanes);
  let lane: Lane | null = null;
  const target: LaneSample = { x: 0, y: 0, size: 200, depth: 0, haze: 0 };

  // ── Whale state (screen space) ──
  let rig: WhaleRig | null = null;
  let px = -400;
  let py = 0;
  let pls = Math.log(200); // log of apparent body length — perceptually even approach / retreat
  let vx = 0;
  let vy = 0;
  let vls = 0;
  let haze = 0.6;
  let pathTime = 0;
  let readyAt = 0;
  let interest = 0;
  let attention = 0;
  let excitement = 0;
  const heading = new THREE.Vector3(1, 0, 0.3).normalize();
  let lastYaw = Math.atan2(heading.x, heading.z);
  let yawRate = 0;
  let roll = 0;
  const worldPos = new THREE.Vector3();
  const prevWorld = new THREE.Vector3();
  const worldVel = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const lookMatrix = new THREE.Matrix4();
  const lookQuat = new THREE.Quaternion();
  const rollQuat = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const origin = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const headPoint = new THREE.Vector3();
  let bubbleTextValue = '';
  let bubbleOpacity = 0;
  // A tap on Echo itself (performance.now ms, 0 = never): Echo greets the visitor and exhales a few bubbles.
  let greetedAt = 0;
  // Handoff from the page's standby still (`[data-echo-standby]`, value = model units per image width): while the
  // still is on the page, Echo holds exactly its place, size and heading under it (the still fades out above), then
  // swims off into its lane. Reduced motion keeps that place for good (`anchor`, document px), so nothing jumps.
  let holding = false;
  let anchor: { x: number; y: number; size: number } | null = null;
  let shown = false;
  // Sun-dapples fade in after the handoff (the still has none).
  let lightIn = 1;
  // The journey (10 §BK): `awaiting` keeps Echo out of sight until it swims in on the opposite edge; `flight` is a scripted exit or entrance.
  let awaiting = false;
  let flight: EchoFlight | null = null;
  let pendingCarry: EchoCarry | null = null;
  const readStandby = () => {
    const still = laneRoot.querySelector<HTMLElement>('[data-echo-standby]');
    const unit = Number(still?.dataset.echoStandby);
    if (!still || !unit) return null;
    const rect = still.getBoundingClientRect();
    if (rect.width < 1) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, size: rect.width * unit };
  };

  const screenToWorld = (x: number, y: number, size: number, out: THREE.Vector3) => {
    const d = Math.min(220, Math.max(1.2, vh / (Math.max(size, 8) * 2 * TAN_HALF)));
    const nx = (x / vw) * 2 - 1;
    const ny = 1 - (y / vh) * 2;
    return out.set(nx * d * TAN_HALF * camera.aspect, ny * d * TAN_HALF, -d);
  };

  const seaLife = createSeaLife((x, y, size, out) => screenToWorld(x, y, size, out), coarse);
  scene.add(seaLife.group);

  const emitSparks = (count: number) => {
    if (!rig) return;
    for (let n = 0; n < count; n++) {
      const i = sparkCursor;
      sparkCursor = (sparkCursor + 1) % SPARK_COUNT;
      tmp.copy(rig.fluke).applyMatrix4(rig.root.matrixWorld);
      sparkPositions[i * 3] = tmp.x + (Math.random() - 0.5) * 0.08;
      sparkPositions[i * 3 + 1] = tmp.y + (Math.random() - 0.5) * 0.08;
      sparkPositions[i * 3 + 2] = tmp.z + (Math.random() - 0.5) * 0.08;
      sparkVelocity[i * 3] = (Math.random() - 0.5) * 0.12;
      sparkVelocity[i * 3 + 1] = (Math.random() - 0.3) * 0.12;
      sparkVelocity[i * 3 + 2] = (Math.random() - 0.5) * 0.12;
      sparkSize[i] = 0.012 + Math.random() * 0.02;
      sparkLife[i] = 1;
    }
  };

  const updateSparks = (dt: number, time: number) => {
    for (let i = 0; i < SPARK_COUNT; i++) {
      if (sparkLife[i] <= 0) continue;
      sparkLife[i] = Math.max(0, sparkLife[i] - dt / 1.7);
      if (sparkLife[i] > 0) bubblesAlive++;
      const swirl = Math.sin(time * 2 + i) * 0.04;
      sparkPositions[i * 3] += (sparkVelocity[i * 3] + swirl) * dt;
      sparkPositions[i * 3 + 1] += (sparkVelocity[i * 3 + 1] + 0.03) * dt;
      sparkPositions[i * 3 + 2] += sparkVelocity[i * 3 + 2] * dt;
    }
    sparkGeometry.attributes.position.needsUpdate = true;
    sparkGeometry.attributes.aLife.needsUpdate = true;
    sparkGeometry.attributes.aSize.needsUpdate = true;
  };

  const emitBubble = (count: number) => {
    if (!rig) return;
    for (let n = 0; n < count; n++) {
      const i = bubbleCursor;
      bubbleCursor = (bubbleCursor + 1) % BUBBLE_COUNT;
      tmp.copy(rig.blowhole).applyMatrix4(rig.root.matrixWorld);
      bubblePositions[i * 3] = tmp.x + (Math.random() - 0.5) * 0.04 * rig.root.scale.x;
      bubblePositions[i * 3 + 1] = tmp.y;
      bubblePositions[i * 3 + 2] = tmp.z;
      const scale = rig.root.scale.x;
      bubbleVelocity[i * 3] = (Math.random() - 0.5) * 0.08 * scale;
      bubbleVelocity[i * 3 + 1] = (0.28 + Math.random() * 0.22) * scale;
      bubbleVelocity[i * 3 + 2] = (Math.random() - 0.5) * 0.05 * scale;
      bubbleSize[i] = (0.025 + Math.random() * 0.035) * scale;
      bubbleLife[i] = 1;
    }
  };

  const updateBubbles = (dt: number, time: number) => {
    bubblesAlive = 0;
    for (let i = 0; i < BUBBLE_COUNT; i++) {
      if (bubbleLife[i] <= 0) continue;
      bubbleLife[i] -= dt / 2.4;
      if (bubbleLife[i] <= 0) {
        bubbleLife[i] = 0;
        continue;
      }
      bubblesAlive++;
      bubblePositions[i * 3] += (bubbleVelocity[i * 3] + Math.sin(time * 3 + i) * 0.02 * bubbleSize[i] * 20) * dt;
      bubblePositions[i * 3 + 1] += bubbleVelocity[i * 3 + 1] * dt;
      bubblePositions[i * 3 + 2] += bubbleVelocity[i * 3 + 2] * dt;
    }
    bubbleGeometry.attributes.position.needsUpdate = true;
    bubbleGeometry.attributes.aLife.needsUpdate = true;
    bubbleGeometry.attributes.aSize.needsUpdate = true;
  };

  const setHaze = (value: number, distance: number) => {
    const fog = scene.fog as THREE.Fog;
    if (value < 0.01) {
      fog.near = 0;
      fog.far = 1e6;
      return;
    }
    const t = inverseSmoothstep(Math.min(0.95, value));
    fog.near = 0;
    fog.far = distance / Math.max(t, 0.02);
  };

  const placeBubble = (onScreen: boolean, settled: boolean, now: number) => {
    if (!bubble || !bubbleText) return;
    let text = '';
    const sinceReady = (now - readyAt) / 1000;
    if (oceanSignals.ctaActive && lane && Math.abs(oceanSignals.ctaY - py) < vh * 0.8) text = CTA_LINE;
    else if (interest > 0.55 || (greetedAt > 0 && now - greetedAt < 2600)) text = GREETING;
    else if (lane?.say) {
      if (lane.path === 'orbit') {
        const lap = Math.floor(pathTime / lane.period + 0.25);
        if (target.depth > 0.35 && (sinceReady < 12 || lap % 2 === 0)) text = lane.say;
      } else if (settled) {
        text = lane.say;
      }
    }
    const size = Math.exp(pls);
    const show = !!text && onScreen && rig !== null && !holding && !flight && !awaiting && size > 70;
    bubbleOpacity += ((show ? 1 : 0) - bubbleOpacity) * (reducedMotion ? 1 : 0.12);
    if (show && text !== bubbleTextValue) {
      bubbleTextValue = text;
      bubbleText.textContent = text;
    }
    if (bubbleOpacity < 0.01) {
      bubble.style.opacity = '0';
      bubble.style.visibility = 'hidden';
      return;
    }
    // Anchor to the top of Echo's head, wherever the head is turned.
    const width = bubble.offsetWidth || 220;
    const height = bubble.offsetHeight || 48;
    let hx = px;
    let hy = py - size * 0.2;
    if (rig) {
      headPoint.set(0, 0.2, 0.3).applyMatrix4(rig.root.matrixWorld).project(camera);
      hx = (headPoint.x + 1) * 0.5 * vw;
      hy = (1 - headPoint.y) * 0.5 * vh;
    }
    const bx = Math.min(vw - width - 12, Math.max(12, hx - width * 0.28));
    const by = Math.min(vh - height - 12, Math.max(76, hy - height - 18));
    bubble.style.visibility = 'visible';
    bubble.style.opacity = bubbleOpacity.toFixed(3);
    bubble.style.transform = `translate3d(${bx.toFixed(1)}px, ${(by + (1 - bubbleOpacity) * 8).toFixed(1)}px, 0)`;
  };

  // ── Frame ──
  let raf = 0;
  let running = false;
  let lastFrame = 0;
  let frameEma = 16;
  let slowFor = 0;
  let warmup = 0;
  let lastMeasure = 0;
  let lastActivity = 0;
  let calm = false;
  let frameCount = 0;
  let waterShown = false;
  let live = false;

  /**
   * Paint the water and its life for this frame (both motion modes). `still` freezes time (reduced motion).
   */
  const paintWater = (time: number, scrollY: number, dt: number, still: boolean, whaleOn: boolean, bodySize: number, energy: number) => {
    const depth = Math.min(1, Math.max(0, scrollY / Math.max(1, docHeight - vh)));
    const u = water.uniforms;
    u.uTime.value = still ? 7 : time;
    u.uScroll.value = scrollY;
    u.uDepth.value = depth;
    if (whaleOn) u.uWhale.value.set(px / vw, py / vh, (bodySize * 0.42) / vh, energy);
    else u.uWhale.value.set(-1, -1, 0.01, 0);
    if (oceanSignals.rippleAt !== lastRippleAt && oceanSignals.rippleAt > 0) {
      lastRippleAt = oceanSignals.rippleAt;
      u.uRipples.value[rippleSlot].set(oceanSignals.rippleX / vw, oceanSignals.rippleY / vh, lastRippleAt / 1000, 1);
      rippleSlot = (rippleSlot + 1) % 3;
      // The tap landed on Echo: Echo says hello and puffs a few bubbles (the ripple word still appears).
      if (whaleOn && !still && Math.hypot(oceanSignals.rippleX - px, oceanSignals.rippleY - py) < bodySize * 0.45) {
        greetedAt = performance.now();
        emitBubble(5);
      }
    }
    // The motes part around Echo and ride the newest ripple's front.
    const pw = planktonUniforms.uWhale.value;
    if (whaleOn) pw.set((px / vw) * 2 - 1, 1 - (py / vh) * 2, (bodySize * 0.5 * 2) / vh);
    else pw.set(0, 0, 0);
    const pr = planktonUniforms.uRipple.value;
    if (lastRippleAt > 0) pr.set((oceanSignals.rippleX / vw) * 2 - 1, 1 - (oceanSignals.rippleY / vh) * 2, time - lastRippleAt / 1000, 1);
    seaLife.update({
      dt,
      time,
      vw,
      vh,
      scrollY,
      whaleX: px,
      whaleY: py,
      whaleSize: whaleOn ? bodySize : 0,
      still,
    });
    // Sun-dapples on Echo: bright near the surface, fading with depth and haze.
    rig?.setWaterLight(still ? 7 : time, 0.55 * (1 - depth * 0.55) * (1 - haze * 0.6) * lightIn);
    water.render(renderer);
    if (!waterShown) {
      waterShown = true;
      laneRoot.dataset.oceanLive = '1';
      options.onLive();
    }
  };

  // The first frame that drew Echo: from now on the page may retire its standby still.
  const reportShown = () => {
    if (!rig || shown) return;
    shown = true;
    performance.mark?.('echo:shown');
    options.onShown();
  };

  const frame = (now: number) => {
    raf = 0;
    if (disposed) return;
    // Calm (Echo away, nobody interacting): the water still breathes, at half rate.
    if (calm && !reducedMotion && frameCount++ % 2 === 1) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(0.05, Math.max(0.001, lastFrame ? (now - lastFrame) / 1000 : 1 / 60));
    lastFrame = now;
    const time = now / 1000;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    if (now - lastMeasure > 1500) {
      measureLanes(lanes);
      forms.measure();
      docHeight = document.documentElement.scrollHeight;
      lastMeasure = now;
    }

    if (reducedMotion) {
      // A still portrait that stays with the hero section: no lap, no travel, no lag. Taken over from the standby
      // still, it keeps the still's place (so the swap is invisible).
      lane = lanes.find((l) => l.id === 'hero') ?? lanes[0] ?? null;
      if (lane) sampleLane(lane, pathTime, scrollX, scrollY, vw, target);
      const still = holding ? readStandby() : null;
      if (still) anchor = { x: still.x + scrollX, y: still.y + scrollY, size: still.size };
      else holding = false;
      if (anchor) {
        target.x = anchor.x - scrollX;
        target.y = anchor.y - scrollY;
        target.size = anchor.size;
        target.haze = 0;
      }
      px = target.x;
      py = target.y;
      pls = Math.log(Math.max(30, target.size));
      haze = target.haze;
      if (rig) {
        screenToWorld(px, py, target.size, worldPos);
        rig.root.position.copy(worldPos);
        lookMatrix.lookAt(heading, origin, up);
        rig.root.quaternion.setFromRotationMatrix(lookMatrix);
        rig.root.updateMatrixWorld(true);
        setHaze(haze, -worldPos.z);
      }
      planktonUniforms.uScroll.value = scrollY;
      forms.update(time, scrollX, scrollY, vw, vh, true);
      const stillOn = !!rig && px > 0 && px < vw && py > 0 && py < vh;
      paintWater(time, scrollY, 0, true, stillOn, target.size, 0);
      renderer.render(scene, camera);
      reportShown();
      placeBubble(stillOn, true, now);
      running = false;
      return;
    }

    lane = pickLane(lanes, lane, scrollY, vw, vh);

    // Pointer curiosity: the cursor resting near Echo slows the lap and turns its head.
    const size = Math.exp(pls);
    const pointerFresh = now - oceanSignals.pointerAt < 2500;
    const pdx = oceanSignals.pointerX - px;
    const pdy = oceanSignals.pointerY - py;
    const near = pointerFresh && pdx * pdx + pdy * pdy < (size * 0.85) ** 2;
    interest += ((near ? 1 : 0) - interest) * Math.min(1, dt * (near ? 2.5 : 1.2));

    pathTime += dt * (1 - 0.8 * interest);

    if (lane) {
      sampleLane(lane, pathTime, scrollX, scrollY, vw, target);
    } else {
      target.x = px < vw / 2 ? -vw * 0.4 : vw * 1.4;
      target.y = py;
      target.size = size;
      target.depth = 0;
      target.haze = 0.4;
    }

    // A tap ripple nearby catches Echo's attention for a moment.
    const sinceRipple = (now - oceanSignals.rippleAt) / 1000;
    const rdx = oceanSignals.rippleX - px;
    const rdy = oceanSignals.rippleY - py;
    const rippleNear = oceanSignals.rippleAt > 0 && sinceRipple < 1.8 && Math.hypot(rdx, rdy) < Math.max(380, vw * 0.45);
    attention += ((rippleNear ? 1 : 0) - attention) * Math.min(1, dt * (rippleNear ? 4 : 1.5));
    if (attention > 0.01) {
      target.x += (oceanSignals.rippleX - target.x) * 0.22 * attention;
      target.y += (oceanSignals.rippleY - target.y) * 0.22 * attention;
    }

    // Primary call-to-action: come closer, swim a little faster; a press is a happy dash.
    const sinceCelebrate = (now - oceanSignals.celebrateAt) / 1000;
    const celebrating = oceanSignals.celebrateAt > 0 && sinceCelebrate < 1.4;
    const ctaVisible = oceanSignals.ctaActive && oceanSignals.ctaY > 0 && oceanSignals.ctaY < vh;
    if (ctaVisible || celebrating) {
      const pull = celebrating ? 0.45 : 0.25;
      target.x += (oceanSignals.ctaX + (px < oceanSignals.ctaX ? -1 : 1) * size * 0.7 - target.x) * pull;
      target.y += (oceanSignals.ctaY - size * 0.55 - target.y) * pull;
    }
    const greeting = greetedAt > 0 && now - greetedAt < 1200;
    excitement += ((celebrating ? 1 : ctaVisible ? 0.45 : greeting ? 0.6 : attention * 0.5) - excitement) * Math.min(1, dt * 3);

    // Taking over from the standby still: hold its exact place while the page fades it out, then swim off from rest.
    if (holding) {
      const still = readStandby();
      if (still) {
        px = target.x = still.x;
        py = target.y = still.y;
        target.size = still.size;
        pls = Math.log(still.size);
        vx = vy = vls = 0;
        haze = target.haze = 0;
      } else {
        holding = false;
        readyAt = now; // the gentle entrance spring eases Echo out of the hold
      }
    }
    if (!holding && lightIn < 1) lightIn = Math.min(1, lightIn + dt / 1.5);

    if (flight) {
      // The journey's flight replaces the lap: exact in time, continuous in position and velocity at both ends.
      const seconds = flight.ms / 1000;
      const t = Math.min(1, (now - flight.start) / flight.ms);
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const d00 = (6 * t2 - 6 * t) / seconds;
      const d10 = 3 * t2 - 4 * t + 1;
      const d01 = (-6 * t2 + 6 * t) / seconds;
      const d11 = 3 * t2 - 2 * t;
      px = h00 * flight.x0 + h10 * seconds * flight.vx0 + h01 * flight.x1 + h11 * seconds * flight.vx1;
      py = h00 * flight.y0 + h10 * seconds * flight.vy0 + h01 * flight.y1 + h11 * seconds * flight.vy1;
      vx = d00 * flight.x0 + d10 * flight.vx0 + d01 * flight.x1 + d11 * flight.vx1;
      vy = d00 * flight.y0 + d10 * flight.vy0 + d01 * flight.y1 + d11 * flight.vy1;
      pls = flight.ls0 + (flight.ls1 - flight.ls0) * (3 * t2 - 2 * t3);
      vls = 0;
      target.haze = 0;
      if (t >= 1) {
        const end = flight.onEnd;
        flight = null;
        readyAt = now;
        end?.();
      }
    } else if (awaiting) {
      px = -vw;
      vx = vy = vls = 0;
    } else {
    // Damped spring in screen space (critically-ish damped; slower during the entrance swim).
    const sinceReady = (now - readyAt) / 1000;
    const omega = (sinceReady < 3.5 ? 1.15 + sinceReady * 0.3 : 2.2) * (1 + excitement * 0.35);
    const zeta = 0.86;
    const maxAccel = Math.max(vw, vh) * 3.2;
    let ax = omega * omega * (target.x - px) - 2 * zeta * omega * vx;
    let ay = omega * omega * (target.y - py) - 2 * zeta * omega * vy;
    const aMag = Math.hypot(ax, ay);
    if (aMag > maxAccel) {
      ax *= maxAccel / aMag;
      ay *= maxAccel / aMag;
    }
    vx += ax * dt;
    vy += ay * dt;
    const maxSpeed = Math.max(vw, vh) * 1.8;
    const speed = Math.hypot(vx, vy);
    if (speed > maxSpeed) {
      vx *= maxSpeed / speed;
      vy *= maxSpeed / speed;
    }
    px += vx * dt;
    py += vy * dt;
    const tls = Math.log(Math.max(30, target.size));
    vls += (omega * omega * (tls - pls) - 2 * zeta * omega * vls) * dt;
    pls += vls * dt;
    }
    haze += (target.haze - haze) * Math.min(1, dt * (flight ? 5 : 1.6));

    const bodySize = Math.exp(pls);
    const bodyLengthsPerSecond = Math.hypot(vx, vy) / bodySize + Math.abs(vls) * 0.8;

    if (rig) {
      rig.root.visible = !awaiting;
      // Position in the water.
      prevWorld.copy(worldPos);
      screenToWorld(px, py, bodySize, worldPos);
      const distance = -worldPos.z;
      rig.root.position.copy(worldPos);
      if (!holding) rig.root.position.y += Math.sin(time * 1.25) * 0.018 * distance * TAN_HALF;
      rig.root.scale.setScalar(1);
      tmp.subVectors(worldPos, prevWorld).divideScalar(dt);
      worldVel.lerp(tmp, Math.min(1, dt * 8));

      // Heading: follow the swim; with no swim, keep the last heading and drift toward a side-on pose. Held under
      // the standby still, Echo keeps the still's heading.
      if (holding) {
        desired.copy(heading);
      } else if (bodyLengthsPerSecond > 0.05) {
        desired.copy(worldVel).normalize();
      } else {
        desired.set(px < vw / 2 ? 1 : -1, 0, 0.35).normalize();
        desired.lerp(heading, 0.9);
      }
      if (interest > 0.01 && pointerFresh && !holding && !flight) {
        screenToWorld(oceanSignals.pointerX, oceanSignals.pointerY, bodySize, tmp);
        tmp.sub(worldPos);
        tmp.z += distance * 0.9; // look out of the water, toward the visitor
        desired.lerp(tmp.normalize(), 0.65 * interest);
      }
      if (attention > 0.01 && !holding && !flight) {
        screenToWorld(oceanSignals.rippleX, oceanSignals.rippleY, bodySize, tmp);
        tmp.sub(worldPos);
        tmp.z += distance * 0.4;
        desired.lerp(tmp.normalize(), 0.4 * attention);
      }
      desired.normalize();
      const turn = 1 - Math.exp(-dt * (flight ? 7 : 2.6 + excitement * 2));
      heading.lerp(desired, turn).normalize();

      // Bank into turns.
      const yaw = Math.atan2(heading.x, heading.z);
      let dYaw = yaw - lastYaw;
      if (dYaw > Math.PI) dYaw -= Math.PI * 2;
      if (dYaw < -Math.PI) dYaw += Math.PI * 2;
      lastYaw = yaw;
      yawRate += (dYaw / dt - yawRate) * Math.min(1, dt * 5);
      roll += (THREE.MathUtils.clamp(-yawRate * 0.3, -0.55, 0.55) - roll) * Math.min(1, dt * 4);

      lookMatrix.lookAt(heading, origin, up);
      lookQuat.setFromRotationMatrix(lookMatrix);
      rollQuat.setFromAxisAngle(zAxis, roll);
      rig.root.quaternion.copy(lookQuat).multiply(rollQuat);
      rig.root.updateMatrixWorld(true);

      if (!reducedMotion) rig.update(dt, bodyLengthsPerSecond, excitement);
      setHaze(haze, distance);

      // Exhale while sprinting or celebrating — only where someone can see it.
      const visible = px > -bodySize * 0.5 && px < vw + bodySize * 0.5 && py > -bodySize * 0.5 && py < vh + bodySize * 0.5;
      if (!reducedMotion && visible && !holding && !awaiting) {
        const rate = flight ? 26 : celebrating ? 18 : bodyLengthsPerSecond > 0.6 ? 5 : 0;
        if (rate > 0 && Math.random() < rate * dt) emitBubble(celebrating ? 2 : 1);
        if (celebrating && sinceCelebrate < 0.05) emitBubble(6);
        // The fluke sheds a trail of light while Echo swims.
        if (bodyLengthsPerSecond > 0.12) {
          sparkCarry += dt * Math.min(46, 8 + bodyLengthsPerSecond * 40 + excitement * 20);
          const count = Math.floor(sparkCarry);
          if (count > 0) {
            sparkCarry -= count;
            emitSparks(count);
          }
        }
      }
    }
    updateBubbles(dt, time);
    updateSparks(dt, time);

    planktonUniforms.uTime.value = reducedMotion ? 0 : time;
    planktonUniforms.uScroll.value = scrollY;
    forms.update(time, scrollX, scrollY, vw, vh, false);

    const onScreen =
      px > -bodySize * 0.6 && px < vw + bodySize * 0.6 && py > -bodySize * 0.6 && py < vh + bodySize * 0.6;
    paintWater(time, scrollY, dt, false, !!rig && onScreen, bodySize, Math.min(1, bodyLengthsPerSecond * 1.5 + excitement));
    renderer.render(scene, camera);
    reportShown();

    const settled = Math.hypot(target.x - px, target.y - py) < bodySize * 0.6;
    placeBubble(onScreen, settled, now);

    // Adaptive quality: step the pixel ratio down when frames stay slow (never back up within a visit).
    warmup += dt;
    frameEma = frameEma * 0.95 + dt * 1000 * 0.05;
    if (warmup > 2 && frameEma > 26) {
      slowFor += dt;
      if (slowFor > 1.5 && dprLevel < dprLevels.length - 1) {
        dprLevel++;
        slowFor = 0;
        frameEma = 16;
        applySize();
      }
    } else {
      slowFor = 0;
    }

    // The water is always alive; the loop only slows to half rate when Echo is away and nobody interacts,
    // and stops with the tab (requestAnimationFrame does not run in a hidden tab).
    calm = !onScreen && bubblesAlive === 0 && now - lastActivity > 2500 && now - oceanSignals.rippleAt > 3000;
    schedule();
  };

  const schedule = () => {
    // Nothing is drawn before the water's shaders are compiled (`live`): the first frame never stalls on a compile.
    if (disposed || raf || !live) return;
    running = true;
    raf = requestAnimationFrame(frame);
  };

  // Reduced motion renders one frame per wake (scroll / resize); otherwise the loop resumes.
  const wake = () => {
    lastActivity = performance.now();
    calm = false;
    if (!running) {
      lastFrame = 0;
      schedule();
    }
  };

  // ── Events ──
  const onResize = () => {
    applySize();
    measureLanes(lanes);
    forms.measure();
    wake();
  };
  const onScroll = () => wake();
  const onPointer = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    oceanSignals.pointerX = event.clientX;
    oceanSignals.pointerY = event.clientY;
    oceanSignals.pointerAt = performance.now();
    wake();
  };
  const onVisibility = () => {
    if (!document.hidden) wake();
  };
  const onContextLost = (event: Event) => {
    event.preventDefault();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    running = false;
    laneRoot.dataset.echo = 'failed-context-lost';
    options.onFail('context-lost');
  };
  const layoutObserver = new ResizeObserver(() => {
    lanes = readLanes(laneRoot);
    measureLanes(lanes);
    forms.read(laneRoot);
    wake();
  });
  layoutObserver.observe(laneRoot);
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('ocean:wake', wake);
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onContextLost);

  // ── The water comes alive once its shaders are compiled ──
  // `compileAsync` lets the GPU driver compile in parallel (KHR_parallel_shader_compile) instead of stalling the main
  // thread inside the first render while the visitor may already be pressing a call-to-action.
  const compiled = (work: () => Promise<unknown>) => {
    try {
      return work().catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  };
  Promise.all([compiled(() => water.compile(renderer)), compiled(() => renderer.compileAsync(scene, camera))]).then(() => {
    if (disposed) return;
    live = true;
    lastFrame = 0;
    schedule();
  });

  // ── Echo arrives ──
  // Starts at once (in parallel with the water's compile): the page preloaded the model with the HTML.
  let stallReported = false;
  const reportStall = () => {
    if (stallReported || disposed) return;
    stallReported = true;
    options.onStall();
  };
  const loadEcho = async (): Promise<WhaleRig> => {
    for (let attempt = 1; ; attempt++) {
      const attemptAbort = new AbortController();
      const cancel = () => attemptAbort.abort();
      abort.signal.addEventListener('abort', cancel);
      let progressAt = performance.now();
      let downloading = true;
      // Watch the download only (parsing and compiling are bounded by the attempt ceiling).
      const watch = window.setInterval(() => {
        const idle = performance.now() - progressAt;
        if (!downloading) return;
        if (idle > MODEL_STALL_MS) reportStall();
        if (idle > MODEL_IDLE_MS) cancel();
      }, 500);
      const ceiling = window.setTimeout(cancel, MODEL_ATTEMPT_MS);
      try {
        const loaded = await loadWhaleRig(options.modelUrl, attemptAbort.signal, (done) => {
          progressAt = performance.now();
          if (done) downloading = false;
        });
        // Compile Echo's skin before it joins the scene (fog and lights of the scene), so its first frame is smooth.
        await compiled(() => renderer.compileAsync(loaded.root, camera, scene));
        return loaded;
      } catch (error) {
        if (disposed || attempt >= MODEL_ATTEMPTS) throw error;
        laneRoot.dataset.echo = 'retrying';
        reportStall();
      } finally {
        window.clearInterval(watch);
        window.clearTimeout(ceiling);
        abort.signal.removeEventListener('abort', cancel);
      }
    }
  };

  loadEcho()
    .then((loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      rig = loaded;
      scene.add(rig.root);
      measureLanes(lanes);
      lane = pickLane(lanes, null, window.scrollY, vw, vh);
      const still = readStandby();
      if (still) {
        // The page is showing the standby still: Echo appears exactly under it, in the still's pose and heading, and
        // holds there until the still has faded out (see `holding` in the frame).
        holding = true;
        lightIn = 0;
        px = still.x;
        py = still.y;
        pls = Math.log(still.size);
        vx = vy = vls = 0;
        haze = 0;
        heading.set(...ECHO_STILL_HEADING).normalize();
        lastYaw = Math.atan2(heading.x, heading.z);
        rig.pose();
        pathTime = lane && lane.path === 'orbit' && !reducedMotion ? -lane.period * 0.22 : lane ? lane.period * 0.06 : 0;
      } else if (reducedMotion) {
        // A still, unhurried portrait in the hero lane: no entrance, no travel.
        pathTime = lane ? lane.period * 0.06 : 0;
        if (lane) sampleLane(lane, pathTime, window.scrollX, window.scrollY, vw, target);
        px = target.x;
        py = target.y;
        pls = Math.log(target.size);
        haze = target.haze;
        heading.set(1, 0.05, 0.55).normalize();
        rig.pose();
      } else {
        // Start the lap so the first pass after the swim-in is the near, bright one.
        pathTime = lane && lane.path === 'orbit' ? -lane.period * 0.22 : 0;
        if (lane) sampleLane(lane, pathTime + 2.5, window.scrollX, window.scrollY, vw, target);
        pls = Math.log(Math.max(40, target.size * 0.45));
        // Just behind the left edge, head already in the water: Echo is on screen within the first frames of the
        // swim-in instead of crossing a few hundred px of empty water first.
        px = -Math.exp(pls) * 0.3;
        py = target.y + vh * 0.18;
        vx = vw * 0.55;
        vy = -vh * 0.05;
        heading.set(1, 0.1, -0.4).normalize();
        haze = 0.7;
      }
      screenToWorld(px, py, Math.exp(pls), worldPos);
      prevWorld.copy(worldPos);
      readyAt = performance.now();
      lastFrame = 0;
      if (awaiting) rig.root.visible = false;
      if (pendingCarry) swimIn(pendingCarry);
      laneRoot.dataset.echo = 'ready';
      performance.mark?.('echo:ready');
      options.onReady();
      wake();
    })
    .catch(() => {
      // Cancelled by dispose: nothing to report. Otherwise (both attempts failed or timed out) the hero shows the
      // still illustration; the water and its life keep running.
      if (disposed) return;
      laneRoot.dataset.echo = 'failed-model';
      options.onFail('model');
    });

  // Echo comes in on the edge opposite the one it left, at the height, size and tail beat it left with, and eases into its lap.
  function swimIn(carry: EchoCarry) {
    pendingCarry = null;
    if (!rig) return;
    const edge = carry.dir > 0 ? -carry.size * 0.62 : vw + carry.size * 0.62;
    const ls = Math.log(Math.max(40, carry.size));
    lane = pickLane(lanes, null, window.scrollY, vw, vh);
    if (lane) sampleLane(lane, pathTime, window.scrollX, window.scrollY, vw, target);
    awaiting = false;
    holding = false;
    rig.root.visible = true;
    rig.setSwimTime(carry.tail);
    heading.set(carry.dir, 0, 0.12).normalize();
    lastYaw = Math.atan2(heading.x, heading.z);
    px = edge;
    py = vh * carry.y;
    pls = ls;
    worldVel.set(carry.dir, 0, 0);
    screenToWorld(px, py, carry.size, worldPos);
    prevWorld.copy(worldPos);
    const speedOut = carry.speed * 0.22;
    flight = {
      start: performance.now(),
      ms: 1250,
      x0: edge, y0: py, vx0: carry.dir * carry.speed, vy0: 0,
      x1: carry.dir > 0 ? vw * 0.36 : vw * 0.64,
      y1: Math.min(vh * 0.42, Math.max(vh * 0.12, target.y)),
      vx1: carry.dir * speedOut, vy1: 0,
      ls0: ls,
      ls1: Math.log(Math.max(40, target.size)),
      onEnd: null,
    };
    wake();
  }

  const stage: JourneyStage = {
    depart({ dir, y, size, ms }) {
      if (!rig || reducedMotion || awaiting) return Promise.resolve(null);
      holding = false;
      const seconds = ms / 1000;
      const x1 = dir > 0 ? vw + size * 0.66 : -size * 0.66;
      const y1 = vh * y;
      // Keep the motion it has, but never let it swing far the wrong way before it turns.
      const limit = vw * 0.5;
      const vx0 = Math.max(-limit, Math.min(limit, vx));
      const vy0 = Math.max(-limit, Math.min(limit, vy));
      const speed = Math.max(vw * 0.8, (Math.abs(x1 - px) / seconds) * 1.45);
      return new Promise<EchoCarry | null>((resolve) => {
        flight = {
          start: performance.now(),
          ms,
          x0: px, y0: py, vx0, vy0,
          x1, y1, vx1: dir * speed, vy1: 0,
          ls0: pls,
          ls1: Math.log(size),
          onEnd: () => {
            awaiting = true;
            resolve({ dir, y, size, speed, tail: rig?.swimTime() ?? 0 });
          },
        };
        lastActivity = performance.now();
        wake();
      });
    },
    arrive(carry) {
      if (reducedMotion || !awaiting) return;
      if (rig) swimIn(carry);
      else pendingCarry = carry;
    },
    awaitArrival() {
      if (reducedMotion) return;
      awaiting = true;
      if (rig) rig.root.visible = false;
    },
    isLive: () => waterShown,
  };

  if (process.env.NODE_ENV !== 'production') {
    // QA only: read the swim state from the browser console / automation.
    (window as unknown as { __ocean?: () => object }).__ocean = () => ({
      lane: lane?.id ?? null,
      x: Math.round(px),
      y: Math.round(py),
      size: Math.round(Math.exp(pls)),
      vx: Math.round(vx),
      vy: Math.round(vy),
      heading: heading.toArray().map((n) => +n.toFixed(2)),
      haze: +haze.toFixed(2),
      running,
      pixelRatio: renderer.getPixelRatio(),
      frameMs: +frameEma.toFixed(1),
      ready: rig !== null,
    });
  }

  return {
    stage,
    dispose() {
      disposed = true;
      flight?.onEnd?.();
      flight = null;
      abort.abort();
      if (raf) cancelAnimationFrame(raf);
      layoutObserver.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('ocean:wake', wake);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      rig?.dispose();
      water.dispose();
      seaLife.dispose();
      forms.dispose();
      sparkGeometry.dispose();
      sparkMaterial.dispose();
      delete laneRoot.dataset.oceanLive;
      planktonGeometry.dispose();
      planktonMaterial.dispose();
      bubbleGeometry.dispose();
      bubbleMaterial.dispose();
      renderer.dispose();
    },
  };
}
