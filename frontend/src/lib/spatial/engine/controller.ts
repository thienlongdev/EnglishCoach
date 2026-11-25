import { startWorld, type WorldRuntime } from '@/lib/wallpaper/worlds/runtime';
import { findSpatialPreset, PALETTES, SPATIAL_PRESETS } from '../catalog';
import type { SpatialProfile } from '../context';
import type { SpatialPreference } from '../preference';
import { loadSpatialScene } from '../scenes/loaders';
import type { SpatialBridge, SpatialPreset } from '../types';
import { PointerOverlay } from './overlay';
import { SurfaceField, type SurfaceConfig } from './surfaces';
import { TransitionLayer } from './transitions';
import { TypeLayer } from './typography';

/**
 * Echo Spatial Engine: one controller, one scene at a time (one WebGL context, one render loop on the shared world runtime), one DOM loop that sleeps
 * when nothing moves. It takes a root (the page or the studio's sample page), a host for the canvas and a route profile, and nothing else, so the
 * preview in the studio is the same code as the real thing. A preset has exactly one scene, one surface motion, one transition: two camera or scroll
 * owners cannot exist. Everything is released in dispose(): attributes, inline styles, listeners, the context.
 */

export interface SpatialStatus {
  scene: 'idle' | 'loading' | 'running' | 'still' | 'failed';
  reason?: string;
}

export interface ControllerOptions {
  host: HTMLElement;
  /** The walkable content. */
  root: HTMLElement;
  scroller: HTMLElement;
  /** Above the content, under dialogs: ghosts, rings, overlay. */
  layer: HTMLElement;
  /** Where the identity marks go: <html> on the real pages, the dialog in the studio's preview. */
  attrRoot?: HTMLElement;
  preset: SpatialPreset;
  pref: SpatialPreference;
  profile: SpatialProfile;
  /** May a scene draw here (no wallpaper in the way, not held by the studio)? */
  sceneAllowed: boolean;
  dark: boolean;
  reduced: boolean;
  still?: boolean;
  shell?: () => HTMLElement[];
  onStatus?: (status: SpatialStatus) => void;
}

export interface SpatialController {
  update(next: Partial<Pick<ControllerOptions, 'preset' | 'pref' | 'profile' | 'sceneAllowed' | 'dark' | 'reduced'>>): void;
  routeChanged(): void;
  rehearseTransition(): void;
  setHeld(held: boolean): void;
  setTyping(typing: boolean): void;
  galleryItems(): HTMLElement[];
  readonly bridge: SpatialBridge;
  readonly stats: () => Record<string, unknown>;
  dispose(): void;
}

export function makeBridge(pref: SpatialPreference): SpatialBridge {
  return {
    rects: new Float32Array(40 * 4),
    meta: new Float32Array(40 * 4),
    count: 0,
    hoverX: 0,
    hoverY: 0,
    hoverAmount: 0,
    scrollProgress: 0,
    scrollTop: 0,
    scrollVelocity: 0,
    routePulse: 0,
    routeSeq: 0,
    routeU: 0.5,
    routeV: 0.5,
    depth: pref.depth,
    material: pref.material,
    words: [],
  };
}

function tierOf(pref: SpatialPreference): 'high' | 'balanced' | 'low' | undefined {
  return pref.quality === 'auto' ? undefined : pref.quality;
}

function attrs(root: HTMLElement, preset: SpatialPreset | null, nav: boolean, spotlight: boolean, dark: boolean) {
  if (!preset) {
    root.removeAttribute('data-spatial');
    root.removeAttribute('data-spatial-nav');
    root.style.removeProperty('--sp-tint');
    root.style.removeProperty('--sp-a');
    root.style.removeProperty('--sp-b');
    return;
  }
  root.setAttribute('data-spatial', preset.category);
  const palette = PALETTES[preset.palette];
  root.style.setProperty('--sp-tint', palette.tint);
  const tones = dark ? palette.dark : palette.light;
  root.style.setProperty('--sp-a', tones[2]);
  root.style.setProperty('--sp-b', tones[3]);
  if (nav) root.setAttribute('data-spatial-nav', '');
  else root.removeAttribute('data-spatial-nav');
  void spotlight;
}

export function createSpatialController(options: ControllerOptions): SpatialController {
  const html = options.attrRoot ?? document.documentElement;
  let preset = options.preset;
  let pref = options.pref;
  let profile = options.profile;
  let sceneAllowed = options.sceneAllowed;
  let dark = options.dark;
  let reduced = options.reduced;
  let held = false;
  let typing = false;
  const bridge = makeBridge(pref);

  const surfaceConfig = (): SurfaceConfig => ({
    motion: preset.surface,
    sheen: preset.sheen,
    glass: !!preset.glass && sceneOn() && profile.surfaces === 'play',
    spotlight: !!preset.spotlight,
    level: typing && profile.surfaces === 'play' ? 'still' : profile.surfaces,
    reduced,
    pointer: pref.focus === 'on' ? pref.pointer * 0.3 : pref.pointer,
    depth: pref.depth,
    material: pref.material,
  });
  const calmNow = () => {
    if (pref.focus === 'off') return 0;
    if (pref.focus === 'on') return Math.max(0.9, profile.calm);
    return Math.max(profile.calm, typing ? 0.85 : 0);
  };
  const sceneOn = () => sceneAllowed && profile.env !== 'off';
  const worldParams = () => ({
    motion: pref.motion,
    pointer: calmNow() >= 0.8 ? 0 : pref.pointer,
    calm: calmNow(),
    dark,
  });

  attrs(html, preset, !!preset.nav, !!preset.spotlight, dark);

  const surfaces = new SurfaceField(options.root, options.scroller, bridge, surfaceConfig(), options.shell);
  const transitions = new TransitionLayer(
    () => options.root.firstElementChild as HTMLElement | null,
    bridge,
    () => preset.transition,
    () => profile.transition,
    () => reduced,
    options.layer,
  );
  const type = new TypeLayer(
    options.root,
    () => preset.type,
    () => profile.type && pref.focus !== 'on',
    () => reduced,
  );
  const overlay = new PointerOverlay(
    options.layer,
    () => preset.overlay,
    () => profile.overlay && !typing && !reduced && pref.focus !== 'on',
    () => PALETTES[preset.palette].tint,
    () => pref.pointer,
  );

  // ─── The scene ────────────────────────────────────────────────────────────────────────────────────────────
  let runtime: WorldRuntime | null = null;
  let runningKey = '';
  let status: SpatialStatus = { scene: 'idle' };
  const setStatus = (next: SpatialStatus) => {
    status = next;
    options.onStatus?.(next);
  };
  const stopScene = () => {
    runtime?.dispose();
    runtime = null;
    runningKey = '';
  };
  const syncScene = () => {
    const wanted = sceneOn();
    const still = reduced || !!options.still;
    const key = wanted ? `${preset.id}|${still ? 'still' : 'live'}|${pref.quality}` : '';
    if (key === runningKey) {
      if (runtime) {
        runtime.setParams(worldParams());
        runtime.setPlaying(!held && document.visibilityState !== 'hidden');
      }
      return;
    }
    stopScene();
    if (!wanted) {
      setStatus({ scene: 'idle' });
      return;
    }
    runningKey = key;
    setStatus({ scene: 'loading' });
    const scenePreset = preset;
    runtime = startWorld({
      id: `spatial:${scenePreset.id}`,
      host: options.host,
      params: worldParams(),
      still,
      context: { antialias: true, depth: true },
      tier: tierOf(pref),
      load: async () => {
        const factory = await loadSpatialScene(scenePreset.scene);
        return (env) => factory(env, bridge, scenePreset.sceneOpts ?? {}, scenePreset.palette);
      },
      onFirstFrame: () => setStatus({ scene: still ? 'still' : 'running' }),
      onFail: (reason) => {
        // Release the context at once; the key stays, so it is not retried on this device until the preset changes.
        runtime?.dispose();
        runtime = null;
        setStatus({ scene: 'failed', reason });
      },
      onOverload: () => {
        stopScene();
        runningKey = key; // do not restart it: this device said no
        setStatus({ scene: 'failed', reason: 'overload' });
      },
    });
    if (held || document.visibilityState === 'hidden') runtime.setPlaying(false);
  };

  // ─── One DOM loop that sleeps when nothing moves ─────────────────────────────────────────────────────────
  let raf = 0;
  let last = 0;
  let quietFrames = 0;
  let disposed = false;
  const needsLoop = () => sceneOn() || profile.surfaces === 'play';
  const wake = () => {
    quietFrames = 0;
    if (!raf && !disposed && !held && document.visibilityState !== 'hidden') raf = window.requestAnimationFrame(frame);
  };
  const frame = (now: number) => {
    raf = 0;
    if (disposed || held || document.visibilityState === 'hidden') return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    bridge.depth = pref.depth;
    bridge.material = pref.material;
    bridge.routePulse *= Math.exp(-dt * 2.4);
    if (bridge.routePulse < 0.002) bridge.routePulse = 0;
    const busy = surfaces.update(dt);
    if (preset.surface === 'float' && profile.surfaces === 'play' && !reduced) quietFrames = 0;
    else if (busy || bridge.routePulse > 0) quietFrames = 0;
    else quietFrames += 1;
    // Sleep automatically once surfaces settle (even while runtime runs); pointer, scroll and resize events wake it.
    if (quietFrames < 40) raf = window.requestAnimationFrame(frame);
  };
  const onActivity = () => wake();
  options.scroller.addEventListener('scroll', onActivity, { passive: true });
  window.addEventListener('pointermove', onActivity, { passive: true });
  window.addEventListener('pointerdown', onActivity, { passive: true });
  window.addEventListener('resize', onActivity, { passive: true });
  const scrollerResize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onActivity) : null;
  scrollerResize?.observe(options.scroller);
  const onVisibility = () => {
    const visible = document.visibilityState !== 'hidden';
    runtime?.setPlaying(!held && visible);
    if (!visible) {
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    } else {
      last = 0;
      wake();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  syncScene();
  wake();

  return {
    bridge,
    update(next) {
      const before = preset;
      if (next.preset) preset = next.preset;
      if (next.pref) pref = next.pref;
      if (next.profile) profile = next.profile;
      if (next.sceneAllowed !== undefined) sceneAllowed = next.sceneAllowed;
      if (next.dark !== undefined) {
        if (next.dark !== dark) surfaces.resetColours();
        dark = next.dark;
      }
      if (next.reduced !== undefined) reduced = next.reduced;
      attrs(html, preset, !!preset.nav, !!preset.spotlight, dark);
      surfaces.setConfig(surfaceConfig());
      if (before.type !== preset.type) type.refresh();
      else type.requestScan(60);
      syncScene();
      wake();
    },
    routeChanged() {
      transitions.play();
      surfaces.requestScan(120);
      type.requestScan(160);
      wake();
    },
    rehearseTransition() {
      transitions.rehearse();
      wake();
    },
    setHeld(next) {
      held = next;
      runtime?.setPlaying(!held && document.visibilityState !== 'hidden');
      if (held) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      } else wake();
    },
    setTyping(next) {
      if (typing === next) return;
      typing = next;
      surfaces.setConfig(surfaceConfig());
      runtime?.setParams(worldParams());
    },
    galleryItems: () => surfaces.galleryItems(),
    stats: () => ({ ...surfaces.stats, scene: status.scene, reason: status.reason, needsLoop: needsLoop(), frames: runtime?.stats.frames ?? 0, tier: runtime?.stats.tier, overlayResting: overlay.resting, preset: preset.id, rects: bridge.count }),
    dispose() {
      disposed = true;
      window.cancelAnimationFrame(raf);
      options.scroller.removeEventListener('scroll', onActivity);
      window.removeEventListener('pointermove', onActivity);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('resize', onActivity);
      scrollerResize?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      stopScene();
      surfaces.dispose();
      transitions.dispose();
      type.dispose();
      overlay.dispose();
      attrs(html, null, false, false, dark);
    },
  };
}

export { SPATIAL_PRESETS, findSpatialPreset };
