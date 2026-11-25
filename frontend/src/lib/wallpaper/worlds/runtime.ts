import { loadWorld } from './loaders';
import { registerCelebration } from '@/lib/vfx/events';
import { WorldBurst } from '@/lib/vfx/worldBurst';
import { vfxReduced } from '@/lib/vfx/quality';
import { findWorld } from './catalog';
import type { WorldEnv, WorldFactory, WorldInstance, WorldParams, WorldPointer, WorldTier } from './types';

/**
 * The shared runtime of a Living World. One running world = one canvas, one WebGL context, one animation loop.
 * It owns what every world needs and no world should reimplement: sizing, scheduling, the pointer, adaptive quality,
 * context loss, and releasing everything on the way out.
 *
 * Client-only by construction: the only network traffic a world can cause is the static files of its own code (and,
 * for Echo Abyss, the same-origin whale model). The server never renders, simulates or stores anything.
 */

export type WorldFailure = 'unsupported' | 'load' | 'crash';

export interface WorldRuntimeOptions {
  id: string;
  /** The element the canvas fills (ResizeObserver keeps them equal). */
  host: HTMLElement;
  params: WorldParams;
  /** One frame only (reduced motion, "Ảnh tĩnh"): renders, then sleeps until something changes. */
  still: boolean;
  onFirstFrame(): void;
  /** The world cannot run on this device: the caller keeps its static picture. */
  onFail(reason: WorldFailure): void;
  /** The device cannot keep up even at the lowest quality: the caller may switch to the static picture. */
  onOverload?(): void;
  /** Echo Spatial runs its scenes on this same runtime: its own scene code, context needs and quality choice. */
  load?: () => Promise<WorldFactory>;
  context?: { antialias?: boolean; depth?: boolean };
  tier?: WorldTier;
}

export interface WorldRuntime {
  setParams(params: Partial<WorldParams>): void;
  setPlaying(playing: boolean): void;
  dispose(): void;
  /** Observable state for tests and diagnostics. */
  readonly stats: { frames: number; scale: number; tier: WorldTier; disposed: boolean; loops: number };
}

export function detectTier(): WorldTier {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  if (nav.connection?.saveData) return 'low';
  const cores = nav.hardwareConcurrency || 4;
  const memory = nav.deviceMemory || 8;
  if (cores <= 2 || memory <= 2) return 'low';
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  if (coarse || cores <= 4 || memory <= 4) return 'balanced';
  return 'high';
}

/** Software renderers report themselves: they get the lightest quality, never a heavy scene. */
function softwareRenderer(gl: WebGL2RenderingContext): boolean {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  if (!info) return false;
  const name = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '');
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}

const PIXEL_BUDGET: Record<WorldTier, number> = { high: 2_700_000, balanced: 1_500_000, low: 800_000 };
const SCALE_STEPS = [1, 0.84, 0.7, 0.56];
const CALM_FPS = 30;
const DEEP_CALM_FPS = 20;

/** A press on one of these belongs to the page: the scene does not take it as a touch of its own. */
const PAGE_CONTROL = 'a,button,input,select,textarea,label,summary,video,audio,iframe,[role="button"],[role="link"],[role="tab"],[role="slider"],[role="menuitem"],[contenteditable="true"],[draggable="true"]';

function createPointer(params: WorldParams): WorldPointer & { update(dt: number): void; dispose(): void; setHost(host: HTMLElement): void; refresh(): void } {
  let host: HTMLElement | null = null;
  let rect = { left: 0, top: 0, width: 1, height: 1 };
  const fine = !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
  let pendingPulses: { u: number; v: number }[] = [];
  let lastU = 0.5;
  let lastV = 0.5;
  let targetVx = 0;
  let targetVy = 0;
  let seen = false;

  const locate = (event: PointerEvent) => {
    const u = (event.clientX - rect.left) / rect.width;
    const v = 1 - (event.clientY - rect.top) / rect.height;
    return { u, v };
  };
  const onMove = (event: PointerEvent) => {
    const { u, v } = locate(event);
    state.u = u;
    state.v = v;
    if (!seen) {
      seen = true;
      lastU = u;
      lastV = v;
      state.su = u;
      state.sv = v;
    }
  };
  const onDown = (event: PointerEvent) => {
    const { u, v } = locate(event);
    state.u = u;
    state.v = v;
    if (!seen) {
      seen = true;
      lastU = u;
      lastV = v;
      state.su = u;
      state.sv = v;
    }
    if (pendingPulses.length < 8 && !(event.target instanceof Element && event.target.closest(PAGE_CONTROL))) pendingPulses.push({ u, v });
  };
  // Passive, on the window: the world watches the pointer; it never receives, blocks or captures it.
  window.addEventListener('pointermove', onMove, { passive: true, capture: true });
  window.addEventListener('pointerdown', onDown, { passive: true, capture: true });

  const state = {
    u: 0.5,
    v: 0.5,
    su: 0.5,
    sv: 0.5,
    vx: 0,
    vy: 0,
    energy: 0,
    strength: 0,
    fine,
    drainPulses() {
      const out = pendingPulses;
      pendingPulses = [];
      return state.strength > 0.001 ? out : [];
    },
    update(dt: number) {
      // Before the first real pointer event the world knows of no pointer at all (nothing reacts to the screen's centre).
      const strength = seen ? Math.max(0, params.pointer) * (1 - 0.85 * Math.max(0, params.calm)) : 0;
      state.strength = strength;
      const aspect = rect.width / Math.max(1, rect.height);
      if (dt > 0) {
        targetVx = ((state.u - lastU) / dt) * aspect;
        targetVy = (state.v - lastV) / dt;
      }
      lastU = state.u;
      lastV = state.v;
      const blend = Math.min(1, dt * 14);
      state.vx += (targetVx - state.vx) * blend;
      state.vy += (targetVy - state.vy) * blend;
      const follow = Math.min(1, dt * 5.5);
      state.su += (state.u - state.su) * follow;
      state.sv += (state.v - state.sv) * follow;
      const speed = Math.min(1, Math.hypot(state.vx, state.vy) * 0.9);
      const wanted = speed * strength;
      state.energy += (wanted - state.energy) * Math.min(1, dt * (wanted > state.energy ? 6 : 1.1));
    },
    setHost(next: HTMLElement) {
      host = next;
      state.refresh();
    },
    refresh() {
      if (!host) return;
      const box = host.getBoundingClientRect();
      rect = { left: box.left, top: box.top, width: Math.max(1, box.width), height: Math.max(1, box.height) };
    },
    dispose() {
      window.removeEventListener('pointermove', onMove, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointerdown', onDown, { capture: true } as EventListenerOptions);
    },
  };
  return state;
}

export function startWorld(options: WorldRuntimeOptions): WorldRuntime {
  const { host, id } = options;
  const meta = findWorld(id);
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.tabIndex = -1;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
  canvas.dataset.worldCanvas = id;

  const params: WorldParams = { ...options.params };
  const stats = { frames: 0, scale: 1, tier: 'balanced' as WorldTier, disposed: false, loops: 0 };
  const pointer = createPointer(params);
  pointer.setHost(host);

  let gl: WebGL2RenderingContext | null = null;
  let instance: WorldInstance | null = null;
  let env: WorldEnv | null = null;
  let raf = 0;
  let playing = true;
  let lastNow = 0;
  let clock = meta?.startTime ?? 14;
  let scaleIndex = 0;
  let firstFrameTold = false;
  let failed = false;
  let building = false;
  let resizePending = true;
  let burst: WorldBurst | null = null;
  const clearBurst = () => { burst?.dispose(); burst = null; };
  const unbindCelebration = registerCelebration(() => {
    if (!gl || !instance || !playing || failed || stats.disposed || options.still || document.hidden || vfxReduced()) return false;
    try { clearBurst(); burst = new WorldBurst(gl); return true; } catch { return false; }
  });

  // Adaptive quality: a window of real frame intervals decides; one step at a time, with a pause after each step.
  let windowSum = 0;
  let windowCount = 0;
  let cooldown = 0;
  let overloadStrikes = 0;

  const targetFps = () => {
    const own = instance?.fps ?? 60;
    if (params.calm >= 0.8) return Math.min(own, DEEP_CALM_FPS);
    if (params.calm >= 0.45) return Math.min(own, CALM_FPS);
    if (stats.tier === 'low') return Math.min(own, CALM_FPS);
    return own;
  };

  const applySize = () => {
    if (!env || !gl) return;
    pointer.refresh();
    const box = host.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(box.width));
    const cssH = Math.max(1, Math.round(box.height));
    const device = Math.min(window.devicePixelRatio || 1, 2);
    let ratio: number;
    if (instance?.crisp) {
      ratio = device;
    } else {
      const budget = PIXEL_BUDGET[stats.tier] * (instance?.pixels ?? 1);
      const fit = Math.sqrt(budget / (cssW * cssH));
      ratio = Math.min(device, fit) * SCALE_STEPS[scaleIndex];
    }
    const w = Math.max(1, Math.round(cssW * ratio));
    const h = Math.max(1, Math.round(cssH * ratio));
    env.cssWidth = cssW;
    env.cssHeight = cssH;
    env.pixelRatio = ratio;
    stats.scale = SCALE_STEPS[scaleIndex];
    if (canvas.width !== w || canvas.height !== h || env.width !== w || env.height !== h) {
      canvas.width = w;
      canvas.height = h;
      env.width = w;
      env.height = h;
      instance?.resize();
    }
  };

  const observer = new ResizeObserver(() => {
    resizePending = true;
    if (options.still || !playing) schedule();
  });
  observer.observe(host);

  let lostTimer = 0;
  const onLost = (event: Event) => {
    event.preventDefault();
    clearBurst();
    window.cancelAnimationFrame(raf);
    raf = 0;
    // Echo Spatial: a context that does not come back must end in the designed fallback, never a blank canvas.
    if (options.load) lostTimer = window.setTimeout(() => fail('crash'), 2500);
    try {
      instance?.dispose();
    } catch {
      // The context is gone: there is nothing left to release.
    }
    instance = null;
  };
  const onRestored = () => {
    window.clearTimeout(lostTimer);
    if (stats.disposed) return;
    void build();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  function fail(reason: WorldFailure) {
    if (failed || stats.disposed) return;
    failed = true;
    window.cancelAnimationFrame(raf);
    raf = 0;
    options.onFail(reason);
  }

  function tick(now: number) {
    raf = 0;
    if (stats.disposed || !instance || !env) return;
    if (!playing && firstFrameTold && !options.still) return;
    const interval = 1000 / targetFps();
    const elapsed = lastNow ? now - lastNow : interval;
    if (!options.still && elapsed < interval - 4) {
      raf = window.requestAnimationFrame(tick);
      return;
    }
    lastNow = now;
    const realDt = Math.min(0.1, elapsed / 1000);
    if (resizePending) {
      resizePending = false;
      applySize();
    }
    pointer.update(realDt);
    const timeScale = Math.max(0.1, params.motion * 1.67) * (1 - 0.72 * Math.max(0, params.calm));
    const dt = realDt * timeScale;
    clock += options.still ? 0 : dt;
    try {
      instance.frame(clock, options.still ? 0 : dt);
      if (burst && !burst.draw(now, realDt)) clearBurst();
    } catch {
      fail('crash');
      return;
    }
    stats.frames += 1;
    if (stats.frames % 15 === 0) canvas.dataset.worldFrames = String(stats.frames); // observable by tests, no React state
    if (!firstFrameTold) {
      firstFrameTold = true;
      options.onFirstFrame();
    }
    if (options.still) return;

    // Adaptive quality.
    if (cooldown > 0) {
      cooldown -= 1;
    } else if (!instance.crisp) {
      windowSum += elapsed;
      windowCount += 1;
      if (windowCount >= 70) {
        const average = windowSum / windowCount;
        windowSum = 0;
        windowCount = 0;
        if (average > interval * 1.45) {
          if (scaleIndex < SCALE_STEPS.length - 1) {
            scaleIndex += 1;
            resizePending = true;
            cooldown = 40;
          } else if (average > 66) {
            overloadStrikes += 1;
            if (overloadStrikes >= 3) options.onOverload?.();
          }
        } else {
          overloadStrikes = 0;
        }
      }
    }
    schedule();
  }

  function schedule() {
    if (!raf && !stats.disposed && !failed) raf = window.requestAnimationFrame(tick);
  }

  async function build() {
    if (building || stats.disposed) return;
    building = true;
    try {
      const context =
        gl ??
        (canvas.getContext('webgl2', {
          alpha: false,
          antialias: options.context?.antialias ?? !!meta?.antialias,
          depth: options.context?.depth ?? !!meta?.depth,
          stencil: false,
          powerPreference: 'high-performance',
          desynchronized: false,
          preserveDrawingBuffer: false,
        }) as WebGL2RenderingContext | null);
      if (!context) {
        building = false;
        fail('unsupported');
        return;
      }
      gl = context;
      let tier = options.tier ?? detectTier();
      if (softwareRenderer(gl)) tier = 'low';
      stats.tier = tier;
      if (!canvas.isConnected) host.appendChild(canvas);
      const box = host.getBoundingClientRect();
      env = {
        gl,
        canvas,
        width: 1,
        height: 1,
        cssWidth: Math.max(1, Math.round(box.width)),
        cssHeight: Math.max(1, Math.round(box.height)),
        pixelRatio: 1,
        tier,
        params,
        pointer,
      };
      canvas.width = 1;
      canvas.height = 1;
      // The drawing buffer has to exist at its real size when the scene is built.
      const device = Math.min(window.devicePixelRatio || 1, 2);
      const ratio = Math.min(device, Math.sqrt(PIXEL_BUDGET[tier] / (env.cssWidth * env.cssHeight)));
      env.width = canvas.width = Math.max(1, Math.round(env.cssWidth * ratio));
      env.height = canvas.height = Math.max(1, Math.round(env.cssHeight * ratio));
      env.pixelRatio = ratio;

      let factory;
      try {
        factory = options.load ? await options.load() : await loadWorld(id);
      } catch {
        building = false;
        fail('load');
        return;
      }
      if (stats.disposed) return;
      const made = await factory(env);
      if (stats.disposed) {
        made.dispose();
        return;
      }
      instance = made;
      resizePending = true;
      instance.warm?.(options.still ? 24 : 9);
      building = false;
      lastNow = 0;
      stats.loops += 1;
      schedule();
    } catch {
      building = false;
      fail('crash');
    }
  }

  void build();

  return {
    stats,
    setParams(next) {
      Object.assign(params, next);
      if (options.still) {
        schedule();
      }
    },
    setPlaying(next) {
      if (playing === next) return;
      playing = next;
      if (!next) clearBurst();
      lastNow = 0;
      if (playing) schedule();
    },
    dispose() {
      if (stats.disposed) return;
      stats.disposed = true;
      unbindCelebration(); clearBurst();
      window.clearTimeout(lostTimer);
      window.cancelAnimationFrame(raf);
      raf = 0;
      observer.disconnect();
      pointer.dispose();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      try {
        instance?.dispose();
      } catch {
        // Releasing is best effort: the context is destroyed right below in any case.
      }
      instance = null;
      // Give the GPU memory back now instead of waiting for garbage collection (browsers cap live contexts).
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}
