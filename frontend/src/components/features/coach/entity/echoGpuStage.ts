import * as THREE from 'three';
import {
  VFX_BUDGET,
  VfxQuality,
  deviceVfxTier,
  subscribeVfx,
  vfxReduced,
  type VfxTier,
} from '@/lib/vfx/quality';
import {
  ECHO_AURA_FRAGMENT_SHADER,
  ECHO_AURA_VERTEX_SHADER,
  ECHO_CAMERA_FOV_DEG,
  ECHO_CAMERA_Z,
  ECHO_CORE_FRAGMENT_SHADER,
  ECHO_CORE_VERTEX_SHADER,
  ECHO_FRUSTUM_HALF_EXTENT,
  ECHO_HALO_FRAGMENT_SHADER,
  ECHO_HALO_VERTEX_SHADER,
  ECHO_RINGS_FRAGMENT_SHADER,
  ECHO_RINGS_VERTEX_SHADER,
  ECHO_RING_CONFIGS,
  ECHO_TRAILS_FRAGMENT_SHADER,
  ECHO_TRAILS_VERTEX_SHADER,
  ECHO_WAVE_FRAGMENT_SHADER,
  ECHO_WAVE_VERTEX_SHADER,
} from './echoShaders';
import {
  EchoSpringBank,
  EchoThemeObserver,
  resolveEchoEntityState,
  type EchoEntitySlot,
  type EchoEntityState,
  type EchoEntityStateInput,
  type EchoUniformSnapshot,
} from './echoSprings';
import { sampleEchoAcousticFrame } from './echoAcousticBridge';

/**
 * Singleton WebGL2 GPU stage for EchoLivingEntity ("Obsidian Prism x Holographic Core").
 *
 * Guarantees:
 * - At most 1 WebGLRenderer across the entire browser tab, reparented to the highest-priority active slot
 *   (immersive > voice > rail > welcome > ambient > compact > launcher).
 * - Strictly raf === 0 (0.00% GPU / 0.00% CPU) in 'dormant' and 'disabled', when document.hidden,
 *   when offscreen, when html[data-guide-active], and under prefers-reduced-motion: reduce.
 * - Pre-compiles 6 static ESSL 3.00 programs during idle time via compileAsync() + 1x1 scissored draw
 *   so Wake-to-Photons runs synchronously in < 16 ms with programDelta === 0.
 * - Verifies WebGL program LINK_STATUS === true and gl.getError() === 0 before setting data-entity-live=""
 *   (falling back cleanly to CSS/SVG Obsidian Resting Essence or Canvas2D on any compile/link error!).
 * - Immediately releases GPU context via WEBGL_lose_context on /speaking/arena, /study-space,
 *   /learning-path (Odyssey), /games/echo- routes, exam attempt routes, and collapsed /knowledge-universe.
 */

export type EchoRouteGpuPolicy = 'evict' | 'cosmos-defer' | 'leaderboard-cap' | 'allow';

export interface EchoEntitySlotRegistration {
  readonly id: string;
  slot: EchoEntitySlot;
  hostEl: HTMLElement;
  rawState: EchoEntityStateInput;
  sizePx: number;
  attentionAngle?: number;
  softDucked?: boolean;
  pathname: string;
  search: string;
  visible: boolean;
  onLiveChange: (live: boolean) => void;
}

export interface EchoGpuStageDiagnostics {
  readonly hasContext: boolean;
  readonly rafId: number;
  readonly activeSlotId: string | null;
  readonly activeSlotKind: EchoEntitySlot | null;
  readonly activeState: EchoEntityState;
  readonly tier: VfxTier;
  readonly programCount: number;
  readonly programDelta: number;
  readonly renderedFrames: number;
  readonly contextLost: boolean;
  readonly compileFailed: boolean;
  readonly prewarmed: boolean;
}

interface TierGeometrySpec {
  readonly coreSteps: number;
  readonly rings: number;
  readonly particles: number;
  readonly auraDetail: number;
  readonly dpr: number;
}

const TIER_SPECS: Readonly<Record<VfxTier, TierGeometrySpec>> = {
  ultra:  { coreSteps: 14, rings: 7, particles: 360, auraDetail: 4, dpr: VFX_BUDGET.ultra.dpr },
  high:   { coreSteps: 11, rings: 7, particles: 240, auraDetail: 4, dpr: VFX_BUDGET.high.dpr },
  medium: { coreSteps: 8,  rings: 5, particles: 128, auraDetail: 3, dpr: VFX_BUDGET.medium.dpr },
  low:    { coreSteps: 5,  rings: 3, particles: 56,  auraDetail: 2, dpr: VFX_BUDGET.low.dpr },
};

const SLOT_PRIORITY: Readonly<Record<EchoEntitySlot, number>> = {
  immersive: 50,
  voice: 40,
  rail: 30,
  welcome: 20,
  ambient: 16,
  compact: 15,
  launcher: 10,
};

function slotRingLimit(slot: EchoEntitySlot): number {
  if (slot === 'immersive') return 7;
  if (slot === 'voice' || slot === 'rail' || slot === 'welcome') return 5;
  return 3;
}

function isLearningPathListView(search: string): boolean {
  if (!search) return false;
  const query = search.startsWith('?') ? search.slice(1) : search;
  try {
    return new URLSearchParams(query).get('view') === 'list';
  } catch {
    return query.includes('view=list');
  }
}

export function evaluateEchoEntityRoutePolicy(pathname: string, search = ''): EchoRouteGpuPolicy {
  const path = pathname || '';
  if (
    path === '/speaking/arena' ||
    path.startsWith('/speaking/arena/') ||
    path === '/study-space' ||
    path.startsWith('/study-space/') ||
    path.startsWith('/games/echo-') ||
    (path.startsWith('/exams/') && path.includes('/attempts/')) ||
    path.startsWith('/ielts-cbt-preview') ||
    path.startsWith('/toeic-iig-preview') ||
    (path === '/learning-path' && !isLearningPathListView(search))
  ) {
    return 'evict';
  }
  if (path === '/knowledge-universe' || path.startsWith('/knowledge-universe/')) {
    return 'cosmos-defer';
  }
  if (path === '/leaderboard' || path.startsWith('/leaderboard/')) {
    return 'leaderboard-cap';
  }
  return 'allow';
}

function isSoftwareRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return false;
    const rendererName = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
    return /swiftshader|llvmpipe|software|basic render/i.test(rendererName);
  } catch {
    return false;
  }
}

function applyPremultipliedLuminescentBlending(material: THREE.RawShaderMaterial): void {
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  material.glslVersion = THREE.GLSL3;
}

function buildHaloQuadGeometry(): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array([
    -1, -1, 0,
     1, -1, 0,
    -1,  1, 0,
     1,  1, 0,
  ]);
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    0, 1,
    1, 1,
  ]);
  const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  return geom;
}

function buildListeningWaveGeometry(segments = 88, strandCount = 5): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  const cols = segments + 1;
  const vertCount = cols * 2;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint16Array(segments * 6);

  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const x = u * 2 - 1;
    const v0 = i * 2;
    const v1 = v0 + 1;

    positions[v0 * 3] = x;
    positions[v0 * 3 + 1] = -1;
    positions[v0 * 3 + 2] = 0;
    uvs[v0 * 2] = u;
    uvs[v0 * 2 + 1] = 0;

    positions[v1 * 3] = x;
    positions[v1 * 3 + 1] = 1;
    positions[v1 * 3 + 2] = 0;
    uvs[v1 * 2] = u;
    uvs[v1 * 2 + 1] = 1;

    if (i < segments) {
      const idx = i * 6;
      const n0 = (i + 1) * 2;
      const n1 = n0 + 1;
      indices[idx] = v0;
      indices[idx + 1] = n0;
      indices[idx + 2] = v1;
      indices[idx + 3] = v1;
      indices[idx + 4] = n0;
      indices[idx + 5] = n1;
    }
  }

  // (strandIdxNorm, freqScale, phaseOffset, ampScale)
  const waveCfgs: readonly [number, number, number, number][] = [
    [0.00, 0.92, 0.00, 1.00],
    [0.25, 1.18, 1.26, 0.86],
    [0.50, 1.46, 2.51, 0.74],
    [0.75, 1.72, 3.77, 0.64],
    [1.00, 2.04, 5.02, 0.54],
  ];
  const cfgAttr = new Float32Array(strandCount * 4);
  for (let s = 0; s < strandCount; s++) {
    const cfg = waveCfgs[s % waveCfgs.length];
    cfgAttr.set(cfg, s * 4);
  }

  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setAttribute('aWaveCfg', new THREE.InstancedBufferAttribute(cfgAttr, 4));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  return geom;
}

function buildRingRibbonGeometry(uSegments = 192): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  const cols = uSegments + 1;
  const vertCount = cols * 2;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint16Array(uSegments * 6);

  for (let i = 0; i <= uSegments; i++) {
    const u = i / uSegments;
    const angle = u * Math.PI * 2;
    const cx = Math.cos(angle);
    const sy = Math.sin(angle);
    const v0 = i * 2;
    const v1 = v0 + 1;

    positions[v0 * 3] = cx;
    positions[v0 * 3 + 1] = sy;
    positions[v0 * 3 + 2] = 0;
    uvs[v0 * 2] = u;
    uvs[v0 * 2 + 1] = 0;

    positions[v1 * 3] = cx;
    positions[v1 * 3 + 1] = sy;
    positions[v1 * 3 + 2] = 0;
    uvs[v1 * 2] = u;
    uvs[v1 * 2 + 1] = 1;

    if (i < uSegments) {
      const idx = i * 6;
      const n0 = (i + 1) * 2;
      const n1 = n0 + 1;
      indices[idx] = v0;
      indices[idx + 1] = n0;
      indices[idx + 2] = v1;
      indices[idx + 3] = v1;
      indices[idx + 4] = n0;
      indices[idx + 5] = n1;
    }
  }

  const ringCount = ECHO_RING_CONFIGS.length;
  const cfg0 = new Float32Array(ringCount * 4);
  const cfg1 = new Float32Array(ringCount * 4);
  const cfg2 = new Float32Array(ringCount * 4);
  for (let r = 0; r < ringCount; r++) {
    const desc = ECHO_RING_CONFIGS[r];
    cfg0.set(desc.cfg0, r * 4);
    cfg1.set(desc.cfg1, r * 4);
    cfg2.set(desc.cfg2, r * 4);
  }

  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setAttribute('aRingCfg0', new THREE.InstancedBufferAttribute(cfg0, 4));
  geom.setAttribute('aRingCfg1', new THREE.InstancedBufferAttribute(cfg1, 4));
  geom.setAttribute('aRingCfg2', new THREE.InstancedBufferAttribute(cfg2, 4));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  return geom;
}

function buildSynapticTrailsGeometry(maxInstances: number): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array([
    -1, -1, 0,
     1, -1, 0,
    -1,  1, 0,
     1,  1, 0,
  ]);
  const corners = new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
     1,  1,
  ]);
  const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);

  const seeds = new Float32Array(maxInstances);
  const invPhi = 0.61803398875;
  for (let i = 0; i < maxInstances; i++) {
    seeds[i] = ((i + 0.5) * invPhi) % 1;
  }

  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
  geom.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  return geom;
}

interface StageResources {
  renderer: THREE.WebGLRenderer;
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  haloGeom: THREE.BufferGeometry;
  haloMat: THREE.RawShaderMaterial;
  haloMesh: THREE.Mesh;
  coreGeom: THREE.IcosahedronGeometry;
  coreMat: THREE.RawShaderMaterial;
  coreMesh: THREE.Mesh;
  waveGeom: THREE.BufferGeometry;
  waveMat: THREE.RawShaderMaterial;
  waveMesh: THREE.InstancedMesh;
  ringsGeom: THREE.BufferGeometry;
  ringsMat: THREE.RawShaderMaterial;
  ringsMesh: THREE.InstancedMesh;
  trailsGeom: THREE.BufferGeometry;
  trailsMat: THREE.RawShaderMaterial;
  trailsMesh: THREE.InstancedMesh;
  auraGeom: THREE.IcosahedronGeometry;
  auraDetail: number;
  auraBackMat: THREE.RawShaderMaterial;
  auraFrontMat: THREE.RawShaderMaterial;
  auraBackMesh: THREE.Mesh;
  auraFrontMesh: THREE.Mesh;
  software: boolean;
}

class EchoGpuStageSingleton {
  private readonly slots = new Map<string, EchoEntitySlotRegistration>();
  private readonly intersectionObservers = new Map<string, IntersectionObserver>();
  private resizeObserver: ResizeObserver | null = null;
  private guideObserver: MutationObserver | null = null;
  private themeObserver: EchoThemeObserver | null = null;
  private unsubVfx: (() => void) | null = null;
  private globalEventsBound = false;

  private readonly quality = new VfxQuality();
  private readonly springs = new EchoSpringBank();

  private res: StageResources | null = null;
  private activeSlotId: string | null = null;
  private liveNotifiedSlotId: string | null = null;
  private rafId = 0;
  private idleHandle = 0;
  private idleUsesCallback = false;
  private lastFrameMs = 0;
  private simTimeSec = 0;
  private renderedFrames = 0;
  private baselinePrograms = 0;
  private prewarmed = false;
  private prewarming: Promise<void> | null = null;
  private contextLost = false;
  private compileFailed = false;
  private programsVerified = false;
  private currentTier: VfxTier = 'medium';
  private lastAppliedWidth = 0;
  private lastAppliedHeight = 0;
  private lastAppliedDpr = 0;

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.programsVerified = false;
    this.stopLoop();
    this.notifyLiveSlot(null);
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.compileFailed = false;
    this.programsVerified = false;
    this.disposeResourcesOnly(false);
    this.reconcile();
  };

  private readonly onVisibilityOrMotionChange = (): void => {
    if (typeof document !== 'undefined' && document.hidden) {
      this.stopLoop();
      return;
    }
    this.reconcile();
  };

  registerSlot(reg: EchoEntitySlotRegistration): () => void {
    this.bindGlobalListeners();
    this.slots.set(reg.id, reg);

    if (typeof IntersectionObserver !== 'undefined' && reg.hostEl) {
      const io = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          const item = this.slots.get(reg.id);
          if (!item || !entry) return;
          const nextVis = entry.isIntersecting;
          if (item.visible !== nextVis) {
            item.visible = nextVis;
            this.reconcile();
          }
        },
        { threshold: 0.01 },
      );
      io.observe(reg.hostEl);
      this.intersectionObservers.set(reg.id, io);
    }

    this.reconcile();
    return () => {
      this.unregisterSlot(reg.id);
    };
  }

  updateSlot(
    id: string,
    patch: Partial<
      Pick<
        EchoEntitySlotRegistration,
        'slot' | 'rawState' | 'sizePx' | 'attentionAngle' | 'softDucked' | 'pathname' | 'search'
      >
    >,
  ): void {
    const existing = this.slots.get(id);
    if (!existing) return;
    const prevRaw = existing.rawState;
    const prevPath = existing.pathname;
    const prevSearch = existing.search;
    const prevSlot = existing.slot;
    const prevSize = existing.sizePx;
    const prevAngle = existing.attentionAngle;
    const prevDuck = existing.softDucked;

    if (patch.slot !== undefined) existing.slot = patch.slot;
    if (patch.rawState !== undefined) existing.rawState = patch.rawState;
    if (patch.sizePx !== undefined) existing.sizePx = patch.sizePx;
    if (patch.attentionAngle !== undefined) existing.attentionAngle = patch.attentionAngle;
    if (patch.softDucked !== undefined) existing.softDucked = patch.softDucked;
    if (patch.pathname !== undefined) existing.pathname = patch.pathname;
    if (patch.search !== undefined) existing.search = patch.search;

    if (
      prevRaw !== existing.rawState ||
      prevPath !== existing.pathname ||
      prevSearch !== existing.search ||
      prevSlot !== existing.slot ||
      prevSize !== existing.sizePx ||
      prevAngle !== existing.attentionAngle ||
      prevDuck !== existing.softDucked
    ) {
      this.reconcile();
    }
  }

  unregisterSlot(id: string): void {
    const io = this.intersectionObservers.get(id);
    if (io) {
      io.disconnect();
      this.intersectionObservers.delete(id);
    }
    const existing = this.slots.get(id);
    if (existing) {
      if (this.liveNotifiedSlotId === id) {
        existing.onLiveChange(false);
        this.liveNotifiedSlotId = null;
      }
      this.slots.delete(id);
    }
    if (this.activeSlotId === id) {
      this.activeSlotId = null;
      this.resizeObserver?.disconnect();
    }
    this.reconcile();
  }

  private bindGlobalListeners(): void {
    if (this.globalEventsBound || typeof window === 'undefined') return;
    this.globalEventsBound = true;

    this.themeObserver = new EchoThemeObserver((theme) => {
      this.springs.setTheme(theme.isDark, theme.ambientRgb, false);
      if (vfxReduced() && this.activeSlotId && this.res && !this.contextLost && !this.compileFailed) {
        this.renderSingleReducedMotionFrame();
      }
    });
    const initialTheme = this.themeObserver.getSnapshot();
    this.springs.setTheme(initialTheme.isDark, initialTheme.ambientRgb, true);

    this.unsubVfx = subscribeVfx(() => {
      this.reconcile();
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityOrMotionChange);
      if (typeof MutationObserver !== 'undefined' && document.documentElement) {
        this.guideObserver = new MutationObserver(() => {
          this.reconcile();
        });
        this.guideObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-guide-active'],
        });
      }
    }

    if (typeof window.addEventListener === 'function') {
      window.addEventListener('popstate', this.onVisibilityOrMotionChange);
    }

    if (typeof window.matchMedia === 'function') {
      try {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        if (typeof mq.addEventListener === 'function') {
          mq.addEventListener('change', this.onVisibilityOrMotionChange);
        }
      } catch {
        // Optional media query listener
      }
    }
  }

  private currentRoutePolicy(): EchoRouteGpuPolicy {
    let pathname = '';
    let search = '';
    for (const slot of this.slots.values()) {
      if (slot.pathname) {
        pathname = slot.pathname;
        search = slot.search;
        break;
      }
    }
    if (!pathname && typeof window !== 'undefined' && window.location) {
      pathname = window.location.pathname || '';
      search = window.location.search || '';
    }
    return evaluateEchoEntityRoutePolicy(pathname, search);
  }

  private isGuideActive(): boolean {
    if (typeof document === 'undefined' || !document.documentElement) return false;
    return document.documentElement.hasAttribute('data-guide-active');
  }

  private pickWinningActiveSlot(): {
    reg: EchoEntitySlotRegistration;
    state: EchoEntityState;
    calmIdle: boolean;
  } | null {
    let best: { reg: EchoEntitySlotRegistration; state: EchoEntityState; calmIdle: boolean; prio: number } | null = null;
    for (const reg of this.slots.values()) {
      if (!reg.visible) continue;
      const resolved = resolveEchoEntityState(reg.rawState, reg.slot);
      if (resolved.state === 'disabled' || resolved.state === 'dormant') {
        continue;
      }
      const prio = SLOT_PRIORITY[reg.slot] ?? 10;
      if (!best || prio > best.prio) {
        best = { reg, state: resolved.state, calmIdle: resolved.calmIdle, prio };
      }
    }
    return best ? { reg: best.reg, state: best.state, calmIdle: best.calmIdle } : null;
  }

  /**
   * Verifies every compiled Three.js WebGLProgram linked cleanly (LINK_STATUS === true)
   * and gl.getError() === 0 before permitting data-entity-live="".
   * Prevents the fatal silent blank-canvas regression where broken GLSL hides .restingEssence!
   */
  private verifyProgramsLinked(): boolean {
    if (!this.res) return false;
    if (this.programsVerified) return !this.compileFailed;

    const { renderer, gl } = this.res;
    const programs = renderer.info?.programs;
    if (!programs || programs.length === 0) {
      return false;
    }

    if (typeof gl.getProgramParameter === 'function') {
      const linkStatusConst = typeof gl.LINK_STATUS === 'number' ? gl.LINK_STATUS : 0x8b82;
      for (const progInfo of programs as Array<{ program?: WebGLProgram | null }>) {
        if (progInfo && progInfo.program) {
          const linked = Boolean(gl.getProgramParameter(progInfo.program, linkStatusConst));
          if (!linked) {
            this.compileFailed = true;
            this.programsVerified = true;
            return false;
          }
        }
      }
    }

    if (typeof gl.getError === 'function') {
      const err = gl.getError();
      const noError = typeof gl.NO_ERROR === 'number' ? gl.NO_ERROR : 0;
      if (err !== noError) {
        this.compileFailed = true;
        this.programsVerified = true;
        return false;
      }
    }

    this.compileFailed = false;
    this.programsVerified = true;
    return true;
  }

  reconcile(): void {
    const policy = this.currentRoutePolicy();
    if (policy === 'evict') {
      this.releaseContext();
      return;
    }

    const winner = this.pickWinningActiveSlot();

    // Neural Cosmos (/knowledge-universe) zero-context collapsed policy + low/medium iGPU offload to Canvas2D
    if (policy === 'cosmos-defer') {
      if (!winner) {
        this.releaseContext();
        return;
      }
      const hwTier = deviceVfxTier();
      if (hwTier === 'low' || hwTier === 'medium') {
        this.releaseContext();
        return;
      }
    }

    // No active slot (all slots are Dormant or Disabled): park with raf === 0 and schedule idle pre-warm if eligible
    if (!winner) {
      this.detachInactiveCanvas();
      if (this.slots.size > 0 && policy !== 'cosmos-defer' && !this.compileFailed) {
        this.scheduleIdlePrewarm();
      }
      return;
    }

    this.cancelIdlePrewarm();

    if (typeof window === 'undefined' || !('WebGL2RenderingContext' in window) || this.compileFailed) {
      this.stopLoop();
      this.notifyLiveSlot(null);
      return;
    }

    if (!this.res && !this.contextLost) {
      const built = this.createStageResources();
      if (!built) {
        this.notifyLiveSlot(null);
        return;
      }
    }

    if (!this.res || this.contextLost) {
      this.stopLoop();
      this.notifyLiveSlot(null);
      return;
    }

    // Attach single shared <canvas> to winning slot host
    const prevSlotId = this.activeSlotId;
    this.activeSlotId = winner.reg.id;
    if (this.res.canvas.parentElement !== winner.reg.hostEl) {
      winner.reg.hostEl.appendChild(this.res.canvas);
      this.observeWinnerResize(winner.reg.hostEl);
    } else if (prevSlotId !== winner.reg.id) {
      this.observeWinnerResize(winner.reg.hostEl);
    }

    this.springs.setAttentionAngle(winner.reg.attentionAngle);
    this.springs.setSoftDuck(Boolean(winner.reg.softDucked));
    this.springs.setState(winner.state, winner.calmIdle);
    this.syncViewportAndTier(winner.reg, policy, 0);

    // Pause GPU loop while Echo Guide spotlight or hidden tab is active
    if (this.isGuideActive() || (typeof document !== 'undefined' && document.hidden)) {
      this.stopLoop();
      return;
    }

    // Reduced-motion contract: render 1 crisp settled 3D holographic frame, then halt (raf === 0)
    if (vfxReduced()) {
      this.stopLoop();
      const ok = this.renderSingleReducedMotionFrame();
      this.notifyLiveSlot(ok ? winner.reg.id : null);
      return;
    }

    // Synchronous Frame 0 on wakeup (< 1.4 ms when pre-warmed) + strict LINK_STATUS gate
    let ok = !this.compileFailed;
    if (this.rafId === 0) {
      ok = this.renderFrame(0);
    }
    if (!ok) {
      this.stopLoop();
      this.notifyLiveSlot(null);
      this.res?.canvas.remove();
      return;
    }

    this.notifyLiveSlot(this.springs.isSleepSettled() ? null : winner.reg.id);

    if (this.springs.shouldAnimate()) {
      this.startLoop();
    } else {
      this.stopLoop();
    }
  }

  private observeWinnerResize(hostEl: HTMLElement): void {
    this.resizeObserver?.disconnect();
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => {
      const active = this.activeSlotId ? this.slots.get(this.activeSlotId) : null;
      if (!active || !this.res || this.contextLost || this.compileFailed) return;
      this.syncViewportAndTier(active, this.currentRoutePolicy(), 0);
      if (this.rafId === 0 && !this.isGuideActive()) {
        if (vfxReduced()) this.renderSingleReducedMotionFrame();
        else this.renderFrame(0);
      }
    });
    this.resizeObserver.observe(hostEl);
  }

  private notifyLiveSlot(slotId: string | null): void {
    if (this.liveNotifiedSlotId === slotId) return;
    if (this.liveNotifiedSlotId) {
      const prev = this.slots.get(this.liveNotifiedSlotId);
      prev?.onLiveChange(false);
    }
    this.liveNotifiedSlotId = slotId;
    if (slotId) {
      const next = this.slots.get(slotId);
      next?.onLiveChange(true);
    }
  }

  private detachInactiveCanvas(): void {
    this.stopLoop();
    this.resizeObserver?.disconnect();
    this.activeSlotId = null;
    this.notifyLiveSlot(null);
    if (this.res) {
      this.res.canvas.style.opacity = '';
      if (!this.contextLost) {
        try {
          this.res.renderer.clear?.(true, true, false);
        } catch {
          // Best-effort framebuffer clear before detach
        }
      }
      if (this.res.canvas.parentElement) {
        this.res.canvas.remove();
      }
    }
  }

  pause(): void {
    this.cancelIdlePrewarm();
    this.detachInactiveCanvas();
  }

  private createStageResources(): boolean {
    if (this.res) return true;
    if (typeof document === 'undefined') return false;

    try {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.dataset.echoEntityCanvas = '';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      canvas.style.pointerEvents = 'none';

      const initialTier = deviceVfxTier();
      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        premultipliedAlpha: true,
        antialias: initialTier !== 'low',
        depth: true,
        stencil: false,
        powerPreference: 'default',
      });
      const gl = renderer.getContext();
      if (!(typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext)) {
        const isWebGl2Like = Boolean((gl as WebGL2RenderingContext | null)?.createVertexArray);
        if (!isWebGl2Like) {
          renderer.dispose();
          return false;
        }
      }

      const software = isSoftwareRenderer(gl);
      renderer.setClearColor(0x000000, 0);
      renderer.sortObjects = true;
      renderer.autoClear = true;

      canvas.addEventListener('webglcontextlost', this.onContextLost, false);
      canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(ECHO_CAMERA_FOV_DEG, 1.0, 0.1, 20.0);
      camera.position.set(0, 0, ECHO_CAMERA_Z);
      camera.lookAt(0, 0, 0);

      const tier: VfxTier = software ? 'low' : initialTier;
      this.currentTier = tier;
      const spec = TIER_SPECS[tier];

      // Shared uniform carriers (0 per-frame allocations) — Radiant Pearlescent Abyss defaults
      const uCameraPos = new THREE.Vector3(0, 0, ECHO_CAMERA_Z);
      const uGazeDir = new THREE.Vector3(0, 0, 1);
      const uCoreColorA = new THREE.Vector3(0.133, 0.827, 0.933);
      const uCoreColorB = new THREE.Vector3(0.545, 0.361, 0.965);
      const uRimColor = new THREE.Vector3(0.729, 0.902, 0.992);
      const uAmbientTint = new THREE.Vector3(112 / 255, 150 / 255, 240 / 255);
      const uStateGroupA = new THREE.Vector4(0, 0, 0, 0);
      const uViewportPx = new THREE.Vector2(128, 128);
      const uSpectrum = new Float32Array(32);

      // Layer 0 (renderOrder = 5): Translucent Refractive Cushion (Light) / Opaline Aurora Bloom (Dark)
      const haloGeom = buildHaloQuadGeometry();
      const haloMat = new THREE.RawShaderMaterial({
        vertexShader: ECHO_HALO_VERTEX_SHADER,
        fragmentShader: ECHO_HALO_FRAGMENT_SHADER,
        side: THREE.DoubleSide,
        depthTest: false,
        uniforms: {
          uTime: { value: 0 },
          uDark: { value: 0 },
          uCoreScale: { value: 0.96 },
          uVoiceRms: { value: 0 },
          uListenWaveMix: { value: 0 },
          uSpeakFieldMix: { value: 0 },
          uConstellation: { value: 0 },
          uShockwave: { value: 0 },
          uExecWave: { value: 0 },
          uCoreColorA: { value: uCoreColorA },
          uCoreColorB: { value: uCoreColorB },
          uRimColor: { value: uRimColor },
        },
      });
      applyPremultipliedLuminescentBlending(haloMat);
      haloMat.customProgramCacheKey = () => 'echo-entity-halo-v3';
      const haloMesh = new THREE.Mesh(haloGeom, haloMat);
      haloMesh.renderOrder = 5;
      haloMesh.frustumCulled = false;

      // Layer 1 (renderOrder = 20): Radiant Pearlescent Abyss Crystal + Aurora Ribbons + Gyroid Plasma
      const coreGeom = new THREE.IcosahedronGeometry(0.84, 4);
      const coreMat = new THREE.RawShaderMaterial({
        vertexShader: ECHO_CORE_VERTEX_SHADER,
        fragmentShader: ECHO_CORE_FRAGMENT_SHADER,
        side: THREE.FrontSide,
        depthTest: true,
        uniforms: {
          uCameraPos: { value: uCameraPos },
          uTime: { value: 0 },
          uDark: { value: 0 },
          uCoreScale: { value: 0.96 },
          uPlasmaSpeed: { value: 0.34 },
          uDispersion: { value: 0.58 },
          uSheetMix: { value: 0.64 },
          uPlasmaMix: { value: 0.32 },
          uListenWaveMix: { value: 0 },
          uSpeakFieldMix: { value: 0 },
          uConstellation: { value: 0 },
          uPrismMix: { value: 0.68 },
          uVoiceRms: { value: 0 },
          uAudioBass: { value: 0 },
          uAudioMid: { value: 0 },
          uAudioTreble: { value: 0 },
          uOnsetFlux: { value: 0 },
          uAttention: { value: 0.6 },
          uShockwave: { value: 0 },
          uCoreSteps: { value: spec.coreSteps },
          uGazeDir: { value: uGazeDir },
          uCoreColorA: { value: uCoreColorA },
          uCoreColorB: { value: uCoreColorB },
          uRimColor: { value: uRimColor },
          uAmbientTint: { value: uAmbientTint },
        },
      });
      applyPremultipliedLuminescentBlending(coreMat);
      coreMat.customProgramCacheKey = () => 'echo-entity-core-v3';
      const coreMesh = new THREE.Mesh(coreGeom, coreMat);
      coreMesh.renderOrder = 20;
      coreMesh.frustumCulled = false;

      // Layer 2A (renderOrder = 25): 5-Strand Opaline Aurora Listening Harmonic Wave
      const waveGeom = buildListeningWaveGeometry(88, 5);
      const waveMat = new THREE.RawShaderMaterial({
        vertexShader: ECHO_WAVE_VERTEX_SHADER,
        fragmentShader: ECHO_WAVE_FRAGMENT_SHADER,
        side: THREE.DoubleSide,
        depthTest: false,
        uniforms: {
          uTime: { value: 0 },
          uCoreScale: { value: 0.96 },
          uListenWaveMix: { value: 0 },
          uVoiceRms: { value: 0 },
          uAudioBass: { value: 0 },
          uAudioMid: { value: 0 },
          uAudioTreble: { value: 0 },
          uSpectralCentroid: { value: 0.45 },
          uOnsetFlux: { value: 0 },
          uCoreColorA: { value: uCoreColorA },
          uCoreColorB: { value: uCoreColorB },
          uRimColor: { value: uRimColor },
        },
      });
      applyPremultipliedLuminescentBlending(waveMat);
      waveMat.customProgramCacheKey = () => 'echo-entity-wave-v3';
      const waveMesh = new THREE.InstancedMesh(waveGeom, waveMat, 5);
      waveMesh.count = 5;
      waveMesh.renderOrder = 25;
      waveMesh.frustumCulled = false;
      const ident = new THREE.Matrix4();
      for (let i = 0; i < 5; i++) {
        waveMesh.setMatrixAt(i, ident);
      }
      waveMesh.instanceMatrix.needsUpdate = true;

      // Layer 3 (renderOrder = 30): Screen-Space-Clamped Gossamer Iridescent Orbital Light Filaments
      const ringsGeom = buildRingRibbonGeometry(192);
      const ringsMat = new THREE.RawShaderMaterial({
        vertexShader: ECHO_RINGS_VERTEX_SHADER,
        fragmentShader: ECHO_RINGS_FRAGMENT_SHADER,
        side: THREE.DoubleSide,
        depthTest: true,
        uniforms: {
          uTime: { value: 0 },
          uDark: { value: 0 },
          uPixelsPerUnit: { value: 42 },
          uRingSpeed: { value: 0.3 },
          uRingAlign: { value: 0.35 },
          uRingAperture: { value: 0 },
          uRingPhaseClick: { value: 0 },
          uDashSpeed: { value: 0.35 },
          uExecWave: { value: 0 },
          uShockwave: { value: 0 },
          uAudioMid: { value: 0 },
          uVoiceRms: { value: 0 },
          uGazeDir: { value: uGazeDir },
          uCoreColorA: { value: uCoreColorA },
          uCoreColorB: { value: uCoreColorB },
          uRimColor: { value: uRimColor },
        },
      });
      applyPremultipliedLuminescentBlending(ringsMat);
      ringsMat.customProgramCacheKey = () => 'echo-entity-rings-v3';
      const ringsMesh = new THREE.InstancedMesh(ringsGeom, ringsMat, ECHO_RING_CONFIGS.length);
      ringsMesh.count = spec.rings;
      ringsMesh.renderOrder = 30;
      ringsMesh.frustumCulled = false;
      for (let i = 0; i < ECHO_RING_CONFIGS.length; i++) {
        ringsMesh.setMatrixAt(i, ident);
      }
      ringsMesh.instanceMatrix.needsUpdate = true;

      // Layer 4 (renderOrder = 40): 1-Pass Gyroid Synaptic Neural Lumina and Bokeh Trails
      const maxParticles = TIER_SPECS.ultra.particles;
      const trailsGeom = buildSynapticTrailsGeometry(maxParticles);
      const trailsMat = new THREE.RawShaderMaterial({
        vertexShader: ECHO_TRAILS_VERTEX_SHADER,
        fragmentShader: ECHO_TRAILS_FRAGMENT_SHADER,
        side: THREE.DoubleSide,
        depthTest: true,
        uniforms: {
          uViewportPx: { value: uViewportPx },
          uPixelRatio: { value: 1 },
          uTime: { value: 0 },
          uDark: { value: 0 },
          uCurlAmp: { value: 0.3 },
          uTrailStretch: { value: 0.2 },
          uConstellation: { value: 0 },
          uAudioBass: { value: 0 },
          uAudioMid: { value: 0 },
          uAudioTreble: { value: 0 },
          uVoiceRms: { value: 0 },
          uAttention: { value: 0.6 },
          uShockwave: { value: 0 },
          uExecWave: { value: 0 },
          uStateGroupA: { value: uStateGroupA },
          uGazeDir: { value: uGazeDir },
          uCoreColorA: { value: uCoreColorA },
          uCoreColorB: { value: uCoreColorB },
          uRimColor: { value: uRimColor },
        },
      });
      applyPremultipliedLuminescentBlending(trailsMat);
      trailsMat.customProgramCacheKey = () => 'echo-entity-trails-v3';
      const trailsMesh = new THREE.InstancedMesh(trailsGeom, trailsMat, maxParticles);
      trailsMesh.count = spec.particles;
      trailsMesh.renderOrder = 40;
      trailsMesh.frustumCulled = false;
      for (let i = 0; i < maxParticles; i++) {
        trailsMesh.setMatrixAt(i, ident);
      }
      trailsMesh.instanceMatrix.needsUpdate = true;

      // Layer 2B (renderOrder = 10 BackSide, 50 FrontSide): 3D Liquid-Light Caustic Speaking Shell
      const auraGeom = new THREE.IcosahedronGeometry(1.16, spec.auraDetail);
      const makeAuraMaterial = (side: THREE.Side, passFade: number): THREE.RawShaderMaterial => {
        const mat = new THREE.RawShaderMaterial({
          vertexShader: ECHO_AURA_VERTEX_SHADER,
          fragmentShader: ECHO_AURA_FRAGMENT_SHADER,
          side,
          depthTest: true,
          uniforms: {
            uCameraPos: { value: uCameraPos },
            uTime: { value: 0 },
            uDark: { value: 0 },
            uPassFade: { value: passFade },
            uSpectrum: { value: uSpectrum },
            uVoiceRms: { value: 0 },
            uHarmonicGain: { value: 0.25 },
            uSpeakFieldMix: { value: 0 },
            uAudioSource: { value: 0 },
            uAudioTreble: { value: 0 },
            uOnsetFlux: { value: 0 },
            uAttention: { value: 0.6 },
            uShockwave: { value: 0 },
            uGazeDir: { value: uGazeDir },
            uCoreColorA: { value: uCoreColorA },
            uCoreColorB: { value: uCoreColorB },
            uRimColor: { value: uRimColor },
            uAmbientTint: { value: uAmbientTint },
          },
        });
        applyPremultipliedLuminescentBlending(mat);
        mat.customProgramCacheKey = () => 'echo-entity-aura-v3';
        return mat;
      };

      const auraBackMat = makeAuraMaterial(THREE.BackSide, 0.46);
      const auraFrontMat = makeAuraMaterial(THREE.FrontSide, 1.0);

      const auraBackMesh = new THREE.Mesh(auraGeom, auraBackMat);
      auraBackMesh.renderOrder = 10;
      auraBackMesh.frustumCulled = false;

      const auraFrontMesh = new THREE.Mesh(auraGeom, auraFrontMat);
      auraFrontMesh.renderOrder = 50;
      auraFrontMesh.frustumCulled = false;

      scene.add(haloMesh, auraBackMesh, coreMesh, waveMesh, ringsMesh, trailsMesh, auraFrontMesh);
      renderer.setSize(128, 128, false);

      this.res = {
        renderer,
        gl,
        canvas,
        scene,
        camera,
        haloGeom,
        haloMat,
        haloMesh,
        coreGeom,
        coreMat,
        coreMesh,
        waveGeom,
        waveMat,
        waveMesh,
        ringsGeom,
        ringsMat,
        ringsMesh,
        trailsGeom,
        trailsMat,
        trailsMesh,
        auraGeom,
        auraDetail: spec.auraDetail,
        auraBackMat,
        auraFrontMat,
        auraBackMesh,
        auraFrontMesh,
        software,
      };
      this.lastAppliedWidth = 128;
      this.lastAppliedHeight = 128;
      this.lastAppliedDpr = 1;
      this.programsVerified = false;
      this.compileFailed = false;
      return true;
    } catch {
      return false;
    }
  }

  private syncViewportAndTier(
    slot: EchoEntitySlotRegistration,
    policy: EchoRouteGpuPolicy,
    dtSec: number,
  ): void {
    if (!this.res) return;
    let tier = this.quality.update(dtSec, !this.res.software);
    if (this.res.software) tier = 'low';
    if (policy === 'cosmos-defer' && (tier === 'ultra' || tier === 'high')) {
      tier = 'medium';
    } else if (policy === 'leaderboard-cap' && tier === 'ultra') {
      tier = 'high';
    }

    if (tier !== this.currentTier) {
      this.currentTier = tier;
      const spec = TIER_SPECS[tier];
      this.res.coreMat.uniforms.uCoreSteps.value = spec.coreSteps;
      this.res.trailsMesh.count = spec.particles;
      if (this.res.auraDetail !== spec.auraDetail) {
        const nextAuraGeom = new THREE.IcosahedronGeometry(1.16, spec.auraDetail);
        this.res.auraBackMesh.geometry = nextAuraGeom;
        this.res.auraFrontMesh.geometry = nextAuraGeom;
        this.res.auraGeom.dispose();
        this.res.auraGeom = nextAuraGeom;
        this.res.auraDetail = spec.auraDetail;
      }
    }

    const spec = TIER_SPECS[this.currentTier];
    // Slot-aware ring LOD: 3 crisp rings for compact/ambient, 5 for welcome/voice, 7 for immersive
    this.res.ringsMesh.count = Math.min(spec.rings, slotRingLimit(slot.slot));

    const deviceRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    // Cap Immersive slot at 1.5 DPR on non-ultra tiers to protect integrated GPUs
    const maxSlotDpr = slot.slot === 'immersive' && this.currentTier !== 'ultra' ? Math.min(spec.dpr, 1.5) : spec.dpr;
    const targetDpr = vfxReduced() ? 1 : Math.min(deviceRatio, maxSlotDpr);

    const rectW = slot.hostEl?.clientWidth || slot.sizePx || 150;
    const rectH = slot.hostEl?.clientHeight || slot.sizePx || 150;
    const cssW = Math.max(32, Math.round(rectW));
    const cssH = Math.max(32, Math.round(rectH));

    if (
      cssW !== this.lastAppliedWidth ||
      cssH !== this.lastAppliedHeight ||
      Math.abs(targetDpr - this.lastAppliedDpr) > 0.01
    ) {
      this.lastAppliedWidth = cssW;
      this.lastAppliedHeight = cssH;
      this.lastAppliedDpr = targetDpr;
      this.res.renderer.setPixelRatio(targetDpr);
      this.res.renderer.setSize(cssW, cssH, false);
      this.res.camera.aspect = cssW / cssH;
      this.res.camera.updateProjectionMatrix();
      const bufW = Math.max(1, Math.round(cssW * targetDpr));
      const bufH = Math.max(1, Math.round(cssH * targetDpr));
      (this.res.trailsMat.uniforms.uViewportPx.value as THREE.Vector2).set(bufW, bufH);
      this.res.trailsMat.uniforms.uPixelRatio.value = targetDpr;
      // Physical pixels per world unit at z = 0 for screen-space ring thickness guarantee
      this.res.ringsMat.uniforms.uPixelsPerUnit.value = bufH / (2 * ECHO_FRUSTUM_HALF_EXTENT);
    }
  }

  private applyUniforms(
    snap: EchoUniformSnapshot,
    timeSec: number,
    voiceRms: number,
    bass: number,
    mid: number,
    treble: number,
    spectralCentroid: number,
    onsetFlux: number,
    spectrum: Float32Array,
  ): void {
    if (!this.res) return;
    const { haloMat, coreMat, waveMat, ringsMat, trailsMat, auraBackMat, auraFrontMat, canvas } = this.res;

    // Shared Vector3/Vector4 objects update all materials with 0 allocations
    (coreMat.uniforms.uGazeDir.value as THREE.Vector3).set(snap.uGazeDir[0], snap.uGazeDir[1], snap.uGazeDir[2]);
    (coreMat.uniforms.uCoreColorA.value as THREE.Vector3).set(snap.uCoreColorA[0], snap.uCoreColorA[1], snap.uCoreColorA[2]);
    (coreMat.uniforms.uCoreColorB.value as THREE.Vector3).set(snap.uCoreColorB[0], snap.uCoreColorB[1], snap.uCoreColorB[2]);
    (coreMat.uniforms.uRimColor.value as THREE.Vector3).set(snap.uRimColor[0], snap.uRimColor[1], snap.uRimColor[2]);
    (coreMat.uniforms.uAmbientTint.value as THREE.Vector3).set(snap.uAmbientTint[0], snap.uAmbientTint[1], snap.uAmbientTint[2]);
    (trailsMat.uniforms.uStateGroupA.value as THREE.Vector4).set(
      snap.uStateGroupA[0],
      snap.uStateGroupA[1],
      snap.uStateGroupA[2],
      snap.uStateGroupA[3],
    );

    haloMat.uniforms.uTime.value = timeSec;
    haloMat.uniforms.uDark.value = snap.uDark;
    haloMat.uniforms.uCoreScale.value = snap.uCoreScale;
    haloMat.uniforms.uVoiceRms.value = voiceRms;
    haloMat.uniforms.uListenWaveMix.value = snap.uListenWaveMix;
    haloMat.uniforms.uSpeakFieldMix.value = snap.uSpeakFieldMix;
    haloMat.uniforms.uConstellation.value = snap.uConstellation;
    haloMat.uniforms.uShockwave.value = snap.uShockwave;
    haloMat.uniforms.uExecWave.value = snap.uExecWave;

    coreMat.uniforms.uTime.value = timeSec;
    coreMat.uniforms.uDark.value = snap.uDark;
    coreMat.uniforms.uCoreScale.value = snap.uCoreScale;
    coreMat.uniforms.uPlasmaSpeed.value = snap.uPlasmaSpeed;
    coreMat.uniforms.uDispersion.value = snap.uDispersion;
    coreMat.uniforms.uSheetMix.value = snap.uSheetMix;
    coreMat.uniforms.uPlasmaMix.value = snap.uPlasmaMix;
    coreMat.uniforms.uListenWaveMix.value = snap.uListenWaveMix;
    coreMat.uniforms.uSpeakFieldMix.value = snap.uSpeakFieldMix;
    coreMat.uniforms.uConstellation.value = snap.uConstellation;
    coreMat.uniforms.uPrismMix.value = snap.uPrismMix;
    coreMat.uniforms.uVoiceRms.value = voiceRms;
    coreMat.uniforms.uAudioBass.value = bass;
    coreMat.uniforms.uAudioMid.value = mid;
    coreMat.uniforms.uAudioTreble.value = treble;
    coreMat.uniforms.uOnsetFlux.value = onsetFlux;
    coreMat.uniforms.uAttention.value = snap.uAttention;
    coreMat.uniforms.uShockwave.value = snap.uShockwave;

    waveMat.uniforms.uTime.value = timeSec;
    waveMat.uniforms.uCoreScale.value = snap.uCoreScale;
    waveMat.uniforms.uListenWaveMix.value = snap.uListenWaveMix;
    waveMat.uniforms.uVoiceRms.value = voiceRms;
    waveMat.uniforms.uAudioBass.value = bass;
    waveMat.uniforms.uAudioMid.value = mid;
    waveMat.uniforms.uAudioTreble.value = treble;
    waveMat.uniforms.uSpectralCentroid.value = spectralCentroid;
    waveMat.uniforms.uOnsetFlux.value = onsetFlux;
    this.res.waveMesh.visible = snap.uListenWaveMix > 0.015;

    ringsMat.uniforms.uTime.value = timeSec;
    ringsMat.uniforms.uDark.value = snap.uDark;
    ringsMat.uniforms.uRingSpeed.value = snap.uRingSpeed;
    ringsMat.uniforms.uRingAlign.value = snap.uRingAlign;
    ringsMat.uniforms.uRingAperture.value = snap.uRingAperture;
    ringsMat.uniforms.uRingPhaseClick.value = snap.uRingPhaseClick;
    ringsMat.uniforms.uDashSpeed.value = snap.uDashSpeed;
    ringsMat.uniforms.uExecWave.value = snap.uExecWave;
    ringsMat.uniforms.uShockwave.value = snap.uShockwave;
    ringsMat.uniforms.uAudioMid.value = mid;
    ringsMat.uniforms.uVoiceRms.value = voiceRms;

    trailsMat.uniforms.uTime.value = timeSec;
    trailsMat.uniforms.uDark.value = snap.uDark;
    trailsMat.uniforms.uCurlAmp.value = snap.uCurlAmp;
    trailsMat.uniforms.uTrailStretch.value = snap.uTrailStretch;
    trailsMat.uniforms.uConstellation.value = snap.uConstellation;
    trailsMat.uniforms.uAudioBass.value = bass;
    trailsMat.uniforms.uAudioMid.value = mid;
    trailsMat.uniforms.uAudioTreble.value = treble;
    trailsMat.uniforms.uVoiceRms.value = voiceRms;
    trailsMat.uniforms.uAttention.value = snap.uAttention;
    trailsMat.uniforms.uShockwave.value = snap.uShockwave;
    trailsMat.uniforms.uExecWave.value = snap.uExecWave;

    const specArr = auraBackMat.uniforms.uSpectrum.value as Float32Array;
    specArr.set(spectrum);
    const effectiveAudioSource = Math.abs(snap.uAudioSource) > 0.02 ? snap.uAudioSource : 0;

    for (const auraMat of [auraBackMat, auraFrontMat]) {
      auraMat.uniforms.uTime.value = timeSec;
      auraMat.uniforms.uDark.value = snap.uDark;
      auraMat.uniforms.uVoiceRms.value = voiceRms;
      auraMat.uniforms.uHarmonicGain.value = snap.uHarmonicGain;
      auraMat.uniforms.uSpeakFieldMix.value = snap.uSpeakFieldMix;
      auraMat.uniforms.uAudioSource.value = effectiveAudioSource;
      auraMat.uniforms.uAudioTreble.value = treble;
      auraMat.uniforms.uOnsetFlux.value = onsetFlux;
      auraMat.uniforms.uAttention.value = snap.uAttention;
      auraMat.uniforms.uShockwave.value = snap.uShockwave;
    }

    canvas.style.opacity = snap.state === 'sleeping' ? snap.canvasOpacity.toFixed(3) : '';
  }

  private renderSingleReducedMotionFrame(): boolean {
    if (!this.res || this.contextLost || this.compileFailed) return false;
    const snap = this.springs.snapToTarget(0);
    this.res.coreMat.uniforms.uCoreSteps.value = 6;
    this.res.ringsMesh.count = Math.min(3, ECHO_RING_CONFIGS.length);
    this.res.trailsMesh.count = 64;
    const zeroSpectrum = sampleEchoAcousticFrame('dormant', 0).spectrum;
    this.applyUniforms(snap, 0, 0, 0, 0, 0, 0.45, 0, zeroSpectrum);
    this.res.renderer.render(this.res.scene, this.res.camera);
    if (!this.verifyProgramsLinked()) return false;
    this.renderedFrames += 1;
    if (this.baselinePrograms === 0) {
      this.baselinePrograms = this.res.renderer.info.programs?.length ?? 6;
    }
    return true;
  }

  private renderFrame(dtSec: number): boolean {
    if (!this.res || this.contextLost || this.compileFailed) return false;
    const active = this.activeSlotId ? this.slots.get(this.activeSlotId) : null;
    if (active && dtSec > 0) {
      this.syncViewportAndTier(active, this.currentRoutePolicy(), dtSec);
    }

    this.simTimeSec += dtSec;
    const acoustic = sampleEchoAcousticFrame(this.springs.getState(), dtSec > 0 ? dtSec : 1 / 60);
    const snap = this.springs.step(dtSec, acoustic.voiceRms, acoustic.speechIntensityTier);
    this.applyUniforms(
      snap,
      this.simTimeSec,
      acoustic.voiceRms,
      acoustic.bass,
      acoustic.mid,
      acoustic.treble,
      acoustic.spectralCentroid,
      acoustic.onsetFlux,
      acoustic.spectrum,
    );
    this.res.renderer.render(this.res.scene, this.res.camera);
    if (!this.verifyProgramsLinked()) return false;
    this.renderedFrames += 1;
    if (this.baselinePrograms === 0) {
      this.baselinePrograms = this.res.renderer.info.programs?.length ?? 6;
    }
    return true;
  }

  private startLoop(): void {
    if (this.rafId !== 0 || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      return;
    }
    this.lastFrameMs = 0;
    const tick = (nowMs: number): void => {
      this.rafId = 0;
      if (!this.res || this.contextLost || this.compileFailed || !this.activeSlotId) return;
      if ((typeof document !== 'undefined' && document.hidden) || this.isGuideActive() || vfxReduced()) {
        return;
      }
      if (!this.springs.shouldAnimate()) {
        if (this.springs.isSleepSettled()) {
          this.notifyLiveSlot(null);
        }
        return;
      }

      const policy = this.currentRoutePolicy();
      let fpsCap = this.springs.step(0, 0, 0).fpsCap || 60;
      if (this.currentTier === 'low') fpsCap = Math.min(fpsCap, 30);
      if (policy === 'cosmos-defer') fpsCap = Math.min(fpsCap, 30);
      if (policy === 'leaderboard-cap') fpsCap = Math.min(fpsCap, 45);

      const minIntervalMs = fpsCap > 0 && fpsCap < 58 ? 1000 / fpsCap - 1.5 : 0;
      if (this.lastFrameMs > 0 && minIntervalMs > 0 && nowMs - this.lastFrameMs < minIntervalMs) {
        this.rafId = window.requestAnimationFrame(tick);
        return;
      }

      const dtSec = this.lastFrameMs > 0 ? Math.min(0.1, Math.max(0.001, (nowMs - this.lastFrameMs) / 1000)) : 1 / 60;
      this.lastFrameMs = nowMs;

      const ok = this.renderFrame(dtSec);
      if (!ok) {
        this.notifyLiveSlot(null);
        return;
      }

      if (this.springs.isSleepSettled()) {
        this.notifyLiveSlot(null);
        return;
      }
      if (this.springs.shouldAnimate()) {
        this.rafId = window.requestAnimationFrame(tick);
      }
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== 0 && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(this.rafId);
    }
    this.rafId = 0;
    this.lastFrameMs = 0;
  }

  private scheduleIdlePrewarm(): void {
    if (this.prewarmed || this.prewarming || this.idleHandle !== 0 || this.compileFailed) return;
    if (typeof window === 'undefined' || !('WebGL2RenderingContext' in window)) return;
    if (vfxReduced() || deviceVfxTier() === 'low') return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const policy = this.currentRoutePolicy();
    if (policy === 'evict' || policy === 'cosmos-defer') return;

    const run = (): void => {
      this.idleHandle = 0;
      void this.prewarm();
    };
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof ric === 'function') {
      this.idleUsesCallback = true;
      this.idleHandle = ric(run, { timeout: 1800 });
    } else {
      this.idleUsesCallback = false;
      this.idleHandle = window.setTimeout(run, 480);
    }
  }

  private cancelIdlePrewarm(): void {
    if (this.idleHandle === 0 || typeof window === 'undefined') return;
    if (this.idleUsesCallback) {
      const cic = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      cic?.(this.idleHandle);
    } else {
      window.clearTimeout(this.idleHandle);
    }
    this.idleHandle = 0;
  }

  async prewarm(): Promise<void> {
    if (this.prewarmed || this.compileFailed) return;
    if (this.prewarming) return this.prewarming;
    if (typeof window === 'undefined' || !('WebGL2RenderingContext' in window)) return;
    const policy = this.currentRoutePolicy();
    if (policy === 'evict' || policy === 'cosmos-defer') return;

    this.prewarming = (async () => {
      try {
        if (!this.res && !this.createStageResources()) return;
        if (!this.res || this.contextLost) return;

        const { renderer, scene, camera, gl } = this.res;
        if (typeof renderer.compileAsync === 'function') {
          await renderer.compileAsync(scene, camera);
        } else {
          renderer.compile(scene, camera);
        }

        if (!this.res || this.contextLost) return;
        const postPolicy = this.currentRoutePolicy();
        if (postPolicy === 'evict' || (postPolicy === 'cosmos-defer' && !this.activeSlotId)) {
          this.releaseContext();
          return;
        }

        // Single 1x1 scissored warmup draw to bind VAOs/uniforms and verify LINK_STATUS, then park with raf === 0
        if (!this.activeSlotId) {
          this.res.waveMesh.visible = true;
          renderer.setScissorTest(true);
          renderer.setScissor(0, 0, 1, 1);
          renderer.render(scene, camera);
          renderer.setScissorTest(false);
          gl.flush?.();
          this.stopLoop();
        }
        if (!this.verifyProgramsLinked()) {
          this.releaseContext();
          return;
        }
        this.baselinePrograms = renderer.info.programs?.length ?? 6;
        this.prewarmed = true;
      } catch {
        // Best-effort prewarm; CSS/SVG Obsidian resting essence remains intact
      } finally {
        this.prewarming = null;
      }
    })();
    return this.prewarming;
  }

  private disposeResourcesOnly(loseGlContext: boolean): void {
    const r = this.res;
    if (!r) return;
    this.res = null;
    this.prewarmed = false;
    this.programsVerified = false;
    this.baselinePrograms = 0;
    this.lastAppliedWidth = 0;
    this.lastAppliedHeight = 0;
    this.lastAppliedDpr = 0;

    r.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    r.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);

    try {
      r.haloGeom.dispose();
      r.haloMat.dispose();
      r.coreGeom.dispose();
      r.coreMat.dispose();
      r.waveGeom.dispose();
      r.waveMat.dispose();
      r.ringsGeom.dispose();
      r.ringsMat.dispose();
      r.trailsGeom.dispose();
      r.trailsMat.dispose();
      r.auraGeom.dispose();
      r.auraBackMat.dispose();
      r.auraFrontMat.dispose();
      r.renderer.dispose();
      if (loseGlContext) {
        r.gl.getExtension?.('WEBGL_lose_context')?.loseContext();
      }
    } catch {
      // Context teardown is best-effort
    }
    r.canvas.remove();
    r.canvas.width = 1;
    r.canvas.height = 1;
  }

  releaseContext(): void {
    this.cancelIdlePrewarm();
    this.stopLoop();
    this.resizeObserver?.disconnect();
    this.activeSlotId = null;
    this.notifyLiveSlot(null);
    this.contextLost = false;
    this.disposeResourcesOnly(true);
  }

  getDiagnostics(): EchoGpuStageDiagnostics {
    const progCount = this.res?.renderer.info.programs?.length ?? 0;
    const delta = this.baselinePrograms > 0 && progCount > 0 ? progCount - this.baselinePrograms : 0;
    const activeReg = this.activeSlotId ? this.slots.get(this.activeSlotId) : null;
    return {
      hasContext: Boolean(this.res) && !this.contextLost && !this.compileFailed,
      rafId: this.rafId,
      activeSlotId: this.activeSlotId,
      activeSlotKind: activeReg?.slot ?? null,
      activeState: this.springs.getState(),
      tier: this.currentTier,
      programCount: progCount,
      programDelta: delta,
      renderedFrames: this.renderedFrames,
      contextLost: this.contextLost,
      compileFailed: this.compileFailed,
      prewarmed: this.prewarmed,
    };
  }
}

let singletonStage: EchoGpuStageSingleton | null = null;

export function getEchoGpuStage(): EchoGpuStageSingleton {
  if (!singletonStage) {
    singletonStage = new EchoGpuStageSingleton();
  }
  return singletonStage;
}

export function releaseEchoEntityGpuContext(): void {
  singletonStage?.releaseContext();
}

export function pauseEchoEntityGpuStage(): void {
  singletonStage?.pause();
}

export function prewarmEchoEntityGpuStage(): Promise<void> {
  return getEchoGpuStage().prewarm();
}

export function getEchoEntityStageDiagnostics(): EchoGpuStageDiagnostics {
  if (!singletonStage) {
    return {
      hasContext: false,
      rafId: 0,
      activeSlotId: null,
      activeSlotKind: null,
      activeState: 'dormant',
      tier: 'low',
      programCount: 0,
      programDelta: 0,
      renderedFrames: 0,
      contextLost: false,
      compileFailed: false,
      prewarmed: false,
    };
  }
  return singletonStage.getDiagnostics();
}
