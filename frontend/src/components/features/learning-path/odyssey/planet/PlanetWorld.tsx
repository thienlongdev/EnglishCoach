'use client';
/* Echo Living Planet — the Odyssey world view. A miniature planet built on the learner's device (no world download),
   showing the same regions, routes and stations as before. Geography never implies proficiency or completion.
   Graphics: ONE choice (Auto or a tier). A tier changes what is built and drawn without recreating the renderer;
   Auto starts from the device's GPU and then follows measured frame times, with hysteresis. */
import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { AlertCircle, Award, BookOpen, Compass, Flame, Headphones, Home, Landmark, Layers, LocateFixed, Mic, Minus, Mountain, PenLine, Plus, RotateCcw, RotateCw, Globe2, Shapes, Snowflake, Trees, Waves, X, type LucideIcon } from 'lucide-react';
import type { Region, Station, WorldMetrics } from '@/lib/odyssey/types';
import type { LearningRoute } from '@/lib/odyssey/progression';
import { passed, ready } from '@/lib/odyssey/progression';
import { usePlanetBuild } from '@/lib/odyssey/planet/usePlanetBuild';
import type { PlanetBuild } from '@/lib/odyssey/planet/build';
import { createTerrain, newSample } from '@/lib/odyssey/planet/terrain';
import { BY_ID, SITES, siteDir } from '@/lib/odyssey/planet/layout';
import { TIER_SPEC, deviceProfile, higherTier, lowerTier, type GraphicsChoice, type PlanetTier, type TierSpec } from '@/lib/odyssey/graphics';
import { ECHO_MODEL_URL } from '@/components/landing/ocean/echoAssets';
import { useWorldAsset } from '../world/assetRuntime';
import { CinematicBurst } from '@/lib/vfx/particles';
import type { VfxTier } from '@/lib/vfx/quality';
import { PlanetWorld as World, type RegionKind, type PinState } from './world';
import { PlanetRig, localFrame } from './rig';
import { shared } from './materials';
import { SurfaceFx } from './surfaceFx';
import { classify, featureWords, responseOf, surfaceHit, type Feature } from '@/lib/odyssey/planet/surface';
import s from '../odyssey.module.css';
import hud from '@/components/ui/hud/cinematicHud.module.css';
const hudChrome = hud.chrome;

export interface OdysseyCelebration { id: string; region: string }
export interface TierState { tier: PlanetTier; auto: boolean; building: boolean; gpu: string }
type Props = {
  celebration?: OdysseyCelebration | null; regions: Region[]; discovered: string[]; region: string | null; stations: Station[]; selected: string | null;
  routes: LearningRoute[]; current: string | null; next: string | null; nextStation?: string | null; states: Record<string, string>; kinds: Record<string, RegionKind>;
  graphics: GraphicsChoice; vi: boolean; onRegion: (id: string) => void; onStation: (id: string) => void; onFallback: () => void; onMetrics: (m: WorldMetrics) => void;
  /** The tier actually drawn (Auto's decision, or the learner's choice) and whether a denser planet is being built. */
  onTier?: (t: TierState) => void;
  /** Auto lowered or raised the tier (the page may say so once). */
  onAutoChange?: (direction: 'down' | 'up', tier: PlanetTier) => void;
  /** A manual tier stays slow even at its lowest resolution (never overridden; the page may suggest Auto). */
  onHeavy?: () => void;
  /** The journey atlas covers the planet: stop drawing (the last frame stays) to keep the interface smooth. */
  paused?: boolean;
  /** The learner touched the planet (the page may hide its hint, or count a miss). */
  onTouch?: (found: boolean) => void;
};
type Command = { type: 'zoom' | 'spin' | 'home' | 'station' | 'here' | 'turn' | 'inspect'; x?: number; y?: number; nonce: number };
/** The colour of the ground reticle and the touch ring, by what lies there. */
const FEATURE_COLOR: Record<Feature['kind'], string> = { ocean: '#7fe9ff', shallows: '#8ff5ec', stack: '#bfefff', beach: '#ffe7b0', volcano: '#ffb067', lava: '#ff9a52', ice: '#e8f6ff', peak: '#f2f6ff',
  mountain: '#f1dfbd', hill: '#d9efb0', forest: '#a8f59a', village: '#ffd59a', landmark: '#ffe27a', land: '#f4fbff' };
type Inspect = (f: Feature | null, x: number, y: number, how: 'hover' | 'click') => void;
const GL = { antialias: true, powerPreference: 'high-performance' as const, alpha: false, stencil: false };
const VFX: Record<PlanetTier, VfxTier> = { light: 'low', balanced: 'medium', high: 'high', ultra: 'ultra' };
const OVERVIEW_SUN = 20, GROUND_SUN = 38;
const PIN_ORDER: Record<PinState, number> = { next: 1, review: 2, open: 3, locked: 4, done: 5, workflow: 6 };

export function pinState(st: Station, next?: string | null): PinState {
  if (st.kind === 'WORKFLOW') return 'workflow';
  if (passed(st)) return 'done';
  if (st.status === 'REVIEW_DUE' || st.status === 'REMEDIATION') return 'review';
  if (st.id === next) return 'next';
  return ready(st) ? 'open' : 'locked';
}

class SceneBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}

function Echo({ world, region, reduced }: { world: World; region: string | null; reduced: boolean }) {
  const whale = useWorldAsset(ECHO_MODEL_URL, noop), root = useRef<THREE.Group>(null);
  const mixer = useMemo(() => whale ? new THREE.AnimationMixer(whale.scene) : null, [whale]);
  const length = useMemo(() => whale ? Math.max(...new THREE.Box3().setFromObject(whale.scene).getSize(new THREE.Vector3()).toArray()) : 1, [whale]);
  useEffect(() => { if (!whale || !mixer) return; whale.animations.forEach(c => mixer.clipAction(c).play()); return () => { mixer.stopAllAction(); mixer.uncacheRoot(whale.scene); }; }, [whale, mixer]);
  const site = region ? world.sitePlace(region) : null;
  const center = useMemo(() => new THREE.Vector3(...(site?.water ?? world.build.sites[0].water)), [site, world]);
  useFrame((_, dt) => {
    const g = root.current; if (!g) return;
    const t = reduced ? 0 : shared.uTime.value * 0.05;
    const e = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), center).normalize(), n = new THREE.Vector3().crossVectors(center, e);
    const a = 0.045, up = center.clone().multiplyScalar(Math.cos(a)).addScaledVector(e, Math.sin(a) * Math.cos(t)).addScaledVector(n, Math.sin(a) * Math.sin(t)).normalize();
    const fwd = e.clone().multiplyScalar(-Math.sin(t)).addScaledVector(n, Math.cos(t)); fwd.addScaledVector(up, -fwd.dot(up)).normalize();
    const side = new THREE.Vector3().crossVectors(up, fwd);
    g.matrix.makeBasis(side, up, fwd).setPosition(up.clone().multiplyScalar(world.R - 0.7 + Math.sin(shared.uTime.value * 0.8) * 0.2));
    g.matrixWorldNeedsUpdate = true;
    if (!reduced) mixer?.update(Math.min(dt, 0.05));
  });
  return whale ? <group ref={root} matrixAutoUpdate={false}><group scale={4.4 / length}><primitive object={whale.scene} dispose={null} /></group></group> : null;
}
const noop = () => {};
/** The heart of the learning continent: the opening view frames every region. */
const CONTINENT = SITES.reduce((v, s) => v.add(new THREE.Vector3(...siteDir(s))), new THREE.Vector3()).normalize();

function Burst({ world, event, reduced, tier }: { world: World; event: OdysseyCelebration | null; reduced: boolean; tier: PlanetTier }) {
  const { scene, gl, invalidate } = useThree(), seen = useRef(''), burst = useRef<CinematicBurst | null>(null);
  useEffect(() => { const effect = new CinematicBurst(VFX[tier]); burst.current = effect; scene.add(effect.root); return () => { effect.dispose(); burst.current = null; seen.current = ''; }; }, [scene]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { burst.current?.setTier(VFX[tier]); }, [tier]);
  useEffect(() => {
    if (!event || event.id === seen.current || reduced) return; seen.current = event.id;
    const p = world.beaconWorld(event.region); if (!p) return;
    burst.current?.start(p.clone(), 18); invalidate();
  }, [event, reduced, invalidate, world]);
  useFrame((_, dt) => { const effect = burst.current; if (!effect) return; effect.update(dt, gl.getPixelRatio(), reduced); if (effect.active) invalidate(); });
  return null;
}

function Scene({ build, props, spec, tier, auto, phone, reduced, command, labels, pinLabels, onReady, onError, onGovern, onFeature }: { build: PlanetBuild; props: Props; spec: TierSpec; tier: PlanetTier; auto: boolean; phone: boolean;
  reduced: boolean; command: Command | null; labels: Map<string, HTMLButtonElement>; pinLabels: Map<string, HTMLButtonElement>; onReady: () => void; onError: () => void; onGovern: (d: 'down' | 'up' | 'heavy') => void; onFeature: Inspect }) {
  const { gl, scene, size, invalidate, setDpr } = useThree();
  const camera = useThree(st => st.camera) as THREE.PerspectiveCamera;
  const world = useMemo(() => new World(build, { phone }), [build, phone]);
  const rig = useMemo(() => new PlanetRig(build.radius), []); // eslint-disable-line react-hooks/exhaustive-deps -- one camera across builds
  const terrain = useMemo(() => createTerrain(), []);
  const sample = useMemo(() => newSample(), []);
  const heightAt = useCallback((d: THREE.Vector3) => terrain.sample(d.x, d.y, d.z, sample).h, [terrain, sample]);
  const ready = useRef(false), last = useRef(0), dprNow = useRef(Math.min(spec.dpr[1], typeof window === 'undefined' ? 1 : window.devicePixelRatio));
  const metrics = useRef({ frames: [] as number[], elapsed: 0, warm: 0, slow: 0, smooth: 0, dprDownAt: -1e9 });
  const propsRef = useRef(props); propsRef.current = props;
  const lastWorld = useRef<World | null>(null), groundAnchored = useRef(false);
  // The living surface: what lies under the pointer, the reticle on the ground, the planet's answer to a touch.
  const fx = useMemo(() => new SurfaceFx(), []);
  const probe = useMemo(() => newSample(), []);
  const reducedRef = useRef(reduced); reducedRef.current = reduced;
  const onFeatureRef = useRef(onFeature); onFeatureRef.current = onFeature;
  useEffect(() => { scene.add(fx.root); return () => { scene.remove(fx.root); fx.dispose(); }; }, [scene, fx]);
  /** The feature under a screen point (client coordinates), or null off the planet. */
  const featureAt = useCallback((x: number, y: number) => {
    const r = gl.domElement.getBoundingClientRect(), ndc = new THREE.Vector2((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1);
    camera.updateMatrixWorld(); const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    const hit = surfaceHit(terrain, probe, [o.x, o.y, o.z], [d.x, d.y, d.z], world.R);
    return hit ? classify(terrain, probe, world.build, hit) : null;
  }, [gl, camera, terrain, probe, world]);
  /** The reticle size on the ground: about the same size on screen at every altitude. */
  const markSize = useCallback((f: Feature) => THREE.MathUtils.clamp(camera.position.distanceTo(new THREE.Vector3(...f.point)) * 0.034, 0.7, 9), [camera]);
  const answer = useCallback((f: Feature) => {
    const kind = responseOf(f), up = new THREE.Vector3(...f.dir), point = new THREE.Vector3(...f.point), red = reducedRef.current;
    if (kind === 'erupt' && !red) world.erupt(shared.uTime.value);
    fx.respond(kind, point, up, FEATURE_COLOR[f.kind], markSize(f) * (f.kind === 'landmark' ? 1.8 : 1.2), shared.uTime.value, red);
    invalidate();
  }, [world, fx, invalidate, markSize]);

  useEffect(() => {
    if (lastWorld.current) world.sunDir.copy(lastWorld.current.sunDir);
    lastWorld.current = world;
    scene.add(world.root);
    world.setRoutes(propsRef.current.routes); world.setRegionKinds(propsRef.current.kinds);
    return () => { scene.remove(world.root); world.dispose(); };
  }, [world, scene]);
  // A tier change: what is drawn, the resolution band, and fresh frame measurements.
  useEffect(() => {
    world.setTier(spec);
    // The tier's band around the screen's own density: Ultra renders above it (supersampling), Light below it.
    dprNow.current = Math.min(spec.dpr[1], Math.max(spec.dpr[0], window.devicePixelRatio)); setDpr(dprNow.current);
    gl.shadowMap.needsUpdate = true;
    Object.assign(metrics.current, { frames: [], elapsed: 0, warm: 0, slow: 0, smooth: 0 });
    invalidate();
  }, [world, spec, gl, setDpr, invalidate]);
  useEffect(() => { world.setRoutes(props.routes); invalidate(); }, [world, props.routes, invalidate]);
  useEffect(() => { world.setRegionKinds(props.kinds); invalidate(); }, [world, props.kinds, invalidate]);
  const pinKey = props.stations.map(st => `${st.id}:${pinState(st, props.nextStation)}`).join('|');
  useEffect(() => {
    // A region may hold more stations than its land has places: the chosen, the next and the due ones come first
    // (every station stays in the journey atlas and the station list).
    const order = (st: Station) => st.id === props.selected ? 0 : PIN_ORDER[pinState(st, props.nextStation)];
    world.setPins(props.region, [...props.stations].sort((a, b) => order(a) - order(b)).map(st => ({ id: st.id, state: pinState(st, props.nextStation) })), props.selected); invalidate();
  }, [world, props.region, pinKey, props.selected, invalidate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where the camera starts: the learner's region, or the heart of the learning continent — in that place's morning.
  const placed = useRef(false);
  useEffect(() => {
    const target = props.region ? BY_ID.get(props.region) : null;
    const focus = target ? new THREE.Vector3(...siteDir(target)) : CONTINENT.clone().lerp(new THREE.Vector3(...siteDir(BY_ID.get(props.current ?? 'harbor') ?? BY_ID.get('harbor')!)), 0.2).normalize();
    if (!placed.current) {
      placed.current = true; rig.f.copy(focus);
      rig.aspect = size.width / Math.max(1, size.height);
      rig.alt = target ? rig.regionAlt : rig.farAlt; rig.heading = target ? THREE.MathUtils.degToRad(target.heading) : 0;
      world.anchorSun(focus, rig.heading, target ? GROUND_SUN : OVERVIEW_SUN, 0);
      return;
    }
    if (target) { const h = THREE.MathUtils.degToRad(target.heading), dur = rig.flyTo(focus, rig.regionAlt, h, reduced); world.anchorSun(focus, h, GROUND_SUN, dur); }
    else { const dur = rig.flyTo(rig.f.clone(), rig.farAlt, 0, reduced); world.anchorSun(rig.f, 0, OVERVIEW_SUN, dur); }
    invalidate();
  }, [props.region]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!command) return;
    if (command.type === 'zoom') rig.zoom(command.x! > 0 ? 0.72 : 1.38);
    if (command.type === 'turn') rig.turn(command.x! * 0.35);
    // Keyboard: the arrows move the view (content slides the opposite way, like a map).
    if (command.type === 'spin') { rig.cancelFlight(); rig.drag(command.x! * 60, command.y! * 60, size.height, camera); rig.stopSpin(); }
    if (command.type === 'home') { const p = propsRef.current; const site = p.region ? BY_ID.get(p.region) : null; const f = site ? new THREE.Vector3(...siteDir(site)) : rig.f.clone(), h = site ? THREE.MathUtils.degToRad(site.heading) : 0;
      const dur = rig.flyTo(f, site ? rig.regionAlt : rig.farAlt, h, reduced); world.anchorSun(f, h, site ? GROUND_SUN : OVERVIEW_SUN, dur); }
    if (command.type === 'here') { const p = propsRef.current; const site = BY_ID.get(p.current ?? ''); if (site) p.onRegion(site.id); }
    if (command.type === 'station') { const p = propsRef.current; if (p.selected) { const w = world.pinWorld(p.selected); if (w) rig.flyTo(w.clone().normalize(), rig.stationAlt, rig.heading, reduced); } }
    // Keyboard: Enter on the planet inspects what lies at the centre of the view (the same answer as a click there).
    if (command.type === 'inspect') { const r = gl.domElement.getBoundingClientRect(), f = featureAt(r.left + r.width / 2, r.top + r.height / 2); if (f) { answer(f); onFeatureRef.current(f, r.left + r.width / 2, r.top + r.height / 2, 'click'); } }
    invalidate();
  }, [command]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pointer, touch, wheel: grab and turn the planet, zoom towards the pointer, turn the view with the right button or
  // two fingers, click to choose.
  useEffect(() => {
    const el = gl.domElement, pointers = new Map<number, { x: number; y: number }>();
    let down: { x: number; y: number; button: number; moved: number } | null = null, pinch = 0, twist = 0;
    let grab: THREE.Vector3 | null = null, lastMove = 0;
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    const cast = (x: number, y: number) => { const r = el.getBoundingClientRect(); ndc.set((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1); camera.updateMatrixWorld(); ray.setFromCamera(ndc, camera); return ray.ray; };
    const hit = (x: number, y: number, radius = world.R + 1) => {
      const sphere = new THREE.Sphere(new THREE.Vector3(), radius), p = new THREE.Vector3();
      return cast(x, y).intersectSphere(sphere, p) ? p : null;
    };
    // The point of the planet under the pointer, or null near the limb (a grazing ray would turn the planet wildly).
    const grabPoint = (x: number, y: number) => {
      const r = cast(x, y), p = r.intersectSphere(new THREE.Sphere(new THREE.Vector3(), rig.grabRadius), new THREE.Vector3());
      if (!p) return null; const n = p.clone().normalize();
      return -r.direction.dot(n) > 0.16 ? n : null;
    };
    // Hover (a mouse at rest above the planet): the reticle and the name of what lies there, at most ~14 times a second.
    let hoverAt = 0, hoverTimer = 0, lastHover = '';
    const hoverNow = (x: number, y: number) => {
      hoverAt = performance.now();
      const p = propsRef.current, r = el.getBoundingClientRect(); ndc.set((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1); camera.updateMatrixWorld(); ray.setFromCamera(ndc, camera);
      if (p.region && world.pickPin(ray)) { fx.hover(null, null, '', 0); el.style.cursor = 'pointer'; if (lastHover) { lastHover = ''; onFeatureRef.current(null, x, y, 'hover'); } invalidate(); return; }
      const f = featureAt(x, y);
      if (!f) { fx.hover(null, null, '', 0); el.style.cursor = ''; if (lastHover) { lastHover = ''; onFeatureRef.current(null, x, y, 'hover'); } invalidate(); return; }
      fx.hover(new THREE.Vector3(...f.point), new THREE.Vector3(...f.dir), FEATURE_COLOR[f.kind], markSize(f));
      el.style.cursor = f.kind === 'landmark' ? 'pointer' : '';
      lastHover = `${f.kind}:${f.site}:${f.landmark}:${f.tree}`;
      onFeatureRef.current(f, x, y, 'hover'); invalidate();
    };
    const onHover = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || pointers.size > 0) return;
      clearTimeout(hoverTimer);
      const wait = 70 - (performance.now() - hoverAt);
      if (wait <= 0) hoverNow(e.clientX, e.clientY); else hoverTimer = window.setTimeout(() => hoverNow(e.clientX, e.clientY), wait);
    };
    const onLeave = () => { clearTimeout(hoverTimer); fx.hover(null, null, '', 0); el.style.cursor = ''; if (lastHover) { lastHover = ''; onFeatureRef.current(null, 0, 0, 'hover'); } invalidate(); };
    const onDown = (e: PointerEvent) => {
      clearTimeout(hoverTimer); fx.hover(null, null, '', 0); if (lastHover) { lastHover = ''; onFeatureRef.current(null, 0, 0, 'hover'); }
      el.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) { down = { x: e.clientX, y: e.clientY, button: e.ctrlKey || e.shiftKey ? 2 : e.button, moved: 0 }; grab = down.button === 0 ? grabPoint(e.clientX, e.clientY) : null; }
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); twist = Math.atan2(b.y - a.y, b.x - a.x); down = null; grab = null; }
      rig.cancelFlight(); rig.stopSpin(); rig.held = true; lastMove = performance.now();
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId); if (!prev) { onHover(e); return; }
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y; pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
        if (pinch > 0) rig.zoom(pinch / Math.max(1, d)); pinch = d;
        rig.turn(-(ang - twist)); twist = ang; invalidate(); return;
      }
      if (!down) return;
      const now = performance.now(), dt = Math.max(1 / 240, (now - lastMove) / 1000); lastMove = now;
      down.moved += Math.abs(dx) + Math.abs(dy);
      if (down.button === 2) rig.turn(dx * 0.006);
      else {
        const h = grabPoint(e.clientX, e.clientY);
        // The hand never turns the planet faster than 1.7 × the speed at the centre of the view (see rig.grabTo).
        if (grab && h) rig.grabTo(grab, h, dt, Math.max(1e-4, Math.hypot(dx, dy) * rig.angularPerPixel(el.clientHeight) * 1.7));
        else { rig.drag(dx, dy, el.clientHeight, camera, dt); grab = null; }
        // Place the camera now, so the next event of this frame measures from where the planet really is.
        rig.update(0, camera, heightAt); camera.updateMatrixWorld();
        if (!grab || rig.capped) { grab = grabPoint(e.clientX, e.clientY); rig.capped = false; }
      }
      invalidate();
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) rig.held = false;
      if (performance.now() - lastMove > 90) rig.holdStill();
      // A press that did not travel is a click (a finger may wobble a little more than a mouse): a drag never inspects.
      if (down && down.moved < (e.pointerType === 'touch' ? 12 : 6) && e.button === 0) {
        const p = propsRef.current;
        const r = el.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(ndc, camera);
        const pin = p.region ? world.pickPin(ray) : null;
        if (pin) p.onStation(pin);
        else {
          const f = featureAt(e.clientX, e.clientY);
          if (f) {
            // From orbit the land of a region chooses that region (as before); its landmark always does; up close the surface is inspected.
            const far = !p.region && rig.closeness < 0.35;
            if (f.site && f.site !== p.region && p.regions.some(r2 => r2.id === f.site) && (f.kind === 'landmark' || (far && f.h >= 0))) { answer(f); p.onRegion(f.site); onFeatureRef.current(null, 0, 0, 'click'); }
            else { answer(f); onFeatureRef.current(f, e.clientX, e.clientY, 'click'); }
          } else onFeatureRef.current(null, 0, 0, 'click');
        }
      }
      if (pointers.size < 2) pinch = 0;
      down = null; grab = null; invalidate();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(THREE.MathUtils.clamp(e.deltaY, -120, 120) * 0.0016);
      const toward = factor < 1 ? hit(e.clientX, e.clientY)?.normalize() : null;
      rig.zoom(factor, toward); invalidate();
    };
    const onDbl = (e: MouseEvent) => { const p = hit(e.clientX, e.clientY); rig.zoom(0.55, p?.normalize()); invalidate(); };
    const onMenu = (e: MouseEvent) => e.preventDefault();
    el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp); el.addEventListener('pointerleave', onLeave);
    el.addEventListener('wheel', onWheel, { passive: false }); el.addEventListener('dblclick', onDbl); el.addEventListener('contextmenu', onMenu);
    el.style.touchAction = 'none';
    return () => {
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp); el.removeEventListener('pointerleave', onLeave); clearTimeout(hoverTimer);
      el.removeEventListener('wheel', onWheel); el.removeEventListener('dblclick', onDbl); el.removeEventListener('contextmenu', onMenu);
      rig.held = false;
    };
  }, [gl, camera, rig, world, invalidate, heightAt, fx, featureAt, answer, markSize]);

  useEffect(() => {
    const lost = (event: Event) => { event.preventDefault(); onError(); };
    gl.domElement.addEventListener('webglcontextlost', lost);
    return () => gl.domElement.removeEventListener('webglcontextlost', lost);
  }, [gl, onError]);

  const projected = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    const delta = Math.min(dt, 0.05);
    if (!reduced) shared.uTime.value += delta;
    const moving = rig.update(delta, camera, heightAt);
    const p = propsRef.current;
    const frame = localFrame(rig.f, rig.heading);
    // Zooming down onto a place in the night brings its morning (a flight already does this).
    if (rig.closeness > 0.62 && !groundAnchored.current && !rig.flying) { groundAnchored.current = true; if (world.sunAt(rig.f) < 0.22) world.anchorSun(rig.f, rig.heading, GROUND_SUN, 1.6); }
    if (rig.closeness < 0.4) groundAnchored.current = false;
    world.update(camera, shared.uTime.value, delta, rig.closeness, p.region, gl.getPixelRatio(), rig.angular, reduced, { focus: frame.up.clone().multiplyScalar(world.R + Math.max(0, rig.ground)) });
    if (world.shadowDirty) { gl.shadowMap.needsUpdate = true; world.shadowDirty = false; }
    if (fx.update(shared.uTime.value, delta, gl.getPixelRatio(), reduced)) invalidate();
    if (!ready.current) { ready.current = true; onReady(); }
    if (moving || rig.flying) invalidate();
    // Labels: front hemisphere, inside the frame, no overlaps; the next destination and "you are here" first.
    // Wall clock: the renderer's clock restarts at zero after a pause (journey atlas, hidden tab), which would freeze labels.
    const now = performance.now() / 1000;
    if (reduced || now - last.current > 1 / 30) {
      last.current = now;
      const camDir = camera.position.clone().normalize(), horizon = world.R / camera.position.length(), occupied: { x: number; y: number }[] = [];
      const order = [...p.regions].sort((a, b) => rank(b.id, p) - rank(a.id, p));
      const showRegions = !p.region && rig.closeness < 0.82;
      for (const r of order) {
        const el = labels.get(r.id), b = world.beaconWorld(r.id); if (!el || !b) continue;
        const facing = b.clone().normalize().dot(camDir);
        projected.copy(b).addScaledVector(b.clone().normalize(), 2.5).project(camera);
        const x = (projected.x * 0.5 + 0.5) * size.width, y = (-projected.y * 0.5 + 0.5) * size.height;
        const visible = showRegions && facing > horizon + 0.04 && projected.z < 1 && x > 70 && x < size.width - 70 && y > (size.width < 760 ? 150 : 96) && y < size.height - (size.width < 760 ? 170 : 110)
          && !occupied.some(o => Math.abs(o.x - x) < 150 && Math.abs(o.y - y) < 44);
        if (el.hidden !== !visible) el.hidden = !visible;
        if (visible) { el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-100%)`; el.style.opacity = String(THREE.MathUtils.clamp((facing - horizon) * 6, 0.35, 1)); occupied.push({ x, y }); }
        el.dataset.x = x.toFixed(1); el.dataset.y = y.toFixed(1);
      }
      for (const [id, el] of pinLabels) {
        const w = p.region ? world.pinWorld(id) : null;
        let visible = false;
        if (w) {
          projected.copy(w).addScaledVector(w.clone().normalize(), 1.6).project(camera);
          const x = (projected.x * 0.5 + 0.5) * size.width, y = (-projected.y * 0.5 + 0.5) * size.height;
          visible = projected.z < 1 && x > 40 && x < size.width - 40 && y > 70 && y < size.height - 60 && w.clone().normalize().dot(camDir) > horizon;
          if (visible) el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-100%)`;
        }
        if (el.hidden !== !visible) el.hidden = !visible;
      }
    }
    // Measured performance: resolution first (within the tier), then — under Auto only — the tier itself.
    const m = metrics.current; m.warm += dt;
    if (m.warm > 2 && dt > 0 && dt < 1) { m.frames.push(dt * 1000); m.elapsed += dt; }
    if (m.elapsed > 2.5 && m.frames.length > 20) {
      const sorted = [...m.frames].sort((a, b) => a - b), p95 = sorted[Math.floor(sorted.length * 0.95)], median = sorted[Math.floor(sorted.length / 2)];
      p.onMetrics({ fps: Math.round(m.frames.length / m.elapsed * 10) / 10, frameP95: Math.round(p95 * 10) / 10, calls: gl.info.render.calls, triangles: gl.info.render.triangles, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, samples: m.frames.length });
      if (!reduced && document.visibilityState === 'visible') {
        const [lo, hi] = spec.dpr, cap = Math.min(hi, Math.max(lo, window.devicePixelRatio));
        if (p95 > 34 && dprNow.current <= lo + 0.01) { if (++m.slow >= 2) { m.slow = 0; onGovern(auto ? 'down' : 'heavy'); } } else m.slow = 0;
        if (p95 > 26 && dprNow.current > lo) { dprNow.current = Math.max(lo, dprNow.current - 0.15); setDpr(dprNow.current); m.dprDownAt = now; m.smooth = 0; }
        else if (p95 < 18.5 && median < 17.6) {
          if (dprNow.current < cap - 0.01) { if (now - m.dprDownAt > 30) { dprNow.current = Math.min(cap, dprNow.current + 0.1); setDpr(dprNow.current); } }
          else if (auto && ++m.smooth >= 4) { m.smooth = 0; onGovern('up'); }
        } else m.smooth = 0;
      }
      m.frames = []; m.elapsed = 0;
    }
    if (process.env.NODE_ENV !== 'production' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      gl.domElement.dataset.planetCamera = JSON.stringify({ tier, level: build.level, auto, dpr: Math.round(gl.getPixelRatio() * 100) / 100, shadow: !!world.sun.shadow.map, cast: world.sun.castShadow,
        alt: Math.round(rig.alt * 10) / 10, closeness: Math.round(rig.closeness * 100) / 100, flying: rig.flying, f: rig.f.toArray().map(v => Math.round(v * 1000) / 1000), u: rig.fw.toArray().map(v => Math.round(v * 1000) / 1000),
        sun: world.sunDir.toArray().map(v => Math.round(v * 1000) / 1000), sunVisible: Math.round(world.sunVisible * 100) / 100, agitation: Math.round(shared.uAgitation.value * 100) / 100, erupt: Math.round(world.eruptLevel * 100) / 100,
        calls: gl.info.render.calls, triangles: gl.info.render.triangles });
    }
    gl.info.reset();
  });

  return <>
    <Burst world={world} event={props.celebration ?? null} reduced={reduced} tier={tier} />
    {!phone && <Echo world={world} region={props.current} reduced={reduced} />}
  </>;
}
const rank = (id: string, p: Props) => (id === p.next ? 4 : 0) + (id === p.current ? 2 : 0) + (p.kinds[id] === 'review' ? 1 : 0);

const ICON_FOR: Record<string, LucideIcon> = { GRAMMAR: Shapes, VOCABULARY: Layers, LISTENING: Headphones, READING: BookOpen, WRITING: PenLine, SPEAKING: Mic, ASSESSMENT: Award };

export default function PlanetWorldView(props: Props) {
  const { graphics, vi, region, regions, discovered, onFallback, selected, onTier, onAutoChange, onHeavy } = props;
  const host = useRef<HTMLDivElement>(null), labels = useRef(new Map<string, HTMLButtonElement>()), pinLabels = useRef(new Map<string, HTMLButtonElement>());
  const profile = useMemo(() => deviceProfile(), []);
  const [autoTier, setAutoTier] = useState<PlanetTier>(profile.start);
  const heavy = useRef(new Set<PlanetTier>()), changedAt = useRef(0), autoTierRef = useRef<PlanetTier>(profile.start);
  const auto = graphics === 'auto';
  const tier: PlanetTier = auto ? autoTier : graphics;
  const spec = TIER_SPEC[tier];
  // The wanted planet; while a denser one builds in the worker, the balanced one is shown (never an empty screen).
  const wanted = usePlanetBuild(spec.build);
  const interim = usePlanetBuild(!wanted.build && spec.build.level === 8 ? TIER_SPEC.balanced.build : null);
  const [shown, setShown] = useState<PlanetBuild | null>(null);
  useEffect(() => { if (wanted.build) setShown(wanted.build); else if (interim.build) setShown(b => b ?? interim.build); }, [wanted.build, interim.build]);
  const build = shown;
  const building = !wanted.build;
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false), [reduced, setReduced] = useState(false), [active, setActive] = useState(true);
  const [command, setCommand] = useState<Command | null>(null);
  const onReady = useCallback(() => setReady(true), []), onError = useCallback(() => setFailed(true), []);
  const run = (type: Command['type'], x?: number, y?: number) => setCommand({ type, x, y, nonce: performance.now() });
  useEffect(() => { if (wanted.error && !shown) setFailed(true); }, [wanted.error, shown]);
  useEffect(() => { onTier?.({ tier, auto, building, gpu: profile.gpu }); }, [tier, auto, building, profile.gpu, onTier]);
  const onGovern = useCallback((d: 'down' | 'up' | 'heavy') => {
    if (d === 'heavy') { onHeavy?.(); return; }
    const now = performance.now();
    if (now - changedAt.current < 12000) return;
    // Decide from the tier now drawn, then tell the page outside any render or state updater.
    const t = autoTierRef.current;
    const n = d === 'down' ? lowerTier(t) : higherTier(t, profile.ceiling);
    if (n === t || (d === 'up' && heavy.current.has(n))) return;
    if (d === 'down') heavy.current.add(t);
    changedAt.current = now; autoTierRef.current = n; setAutoTier(n); onAutoChange?.(d, n);
  }, [onAutoChange, onHeavy, profile.ceiling]);
  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)'); const change = () => setReduced(motion.matches); change(); motion.addEventListener('change', change);
    let inView = true; const visibility = () => setActive(inView && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; visibility(); });
    if (host.current) observer.observe(host.current); document.addEventListener('visibilitychange', visibility);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', visibility); motion.removeEventListener('change', change); };
  }, []);
  const name = (r: Region) => vi ? r.name.vi : r.name.en;
  const labelled = props.stations.filter(st => st.id === selected || st.id === props.nextStation).slice(0, 2);
  // The living surface: a name under the pointer (written straight into the DOM, no render per move), a card where the learner touched.
  const chip = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<{ f: Feature; x: number; y: number } | null>(null);
  const propsRef = useRef(props); propsRef.current = props;
  const onFeature = useCallback((f: Feature | null, x: number, y: number, how: 'hover' | 'click') => {
    const el = chip.current, frame = host.current?.getBoundingClientRect();
    if (how === 'hover') {
      if (!el || !frame) return;
      if (!f) { el.hidden = true; return; }
      const w = featureWords(f), region = f.site ? propsRef.current.regions.find(r => r.id === f.site) : null;
      el.dataset.kind = f.kind;
      el.textContent = `${propsRef.current.vi ? w.vi : w.en} · ${w.word}${region ? ` — ${propsRef.current.vi ? region.name.vi : region.name.en}` : ''}`;
      el.style.transform = `translate3d(${Math.round(x - frame.left + 16)}px, ${Math.round(y - frame.top + 18)}px, 0)`;
      el.hidden = false;
      return;
    }
    if (el) el.hidden = true;
    propsRef.current.onTouch?.(!!f);
    setCard(f && frame ? { f, x: x - frame.left, y: y - frame.top } : null);
  }, []);
  // The card closes with Escape before anything else hears it (the page's own Escape would leave the world).
  useEffect(() => {
    if (!card) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCard(null); } };
    addEventListener('keydown', key, true); return () => removeEventListener('keydown', key, true);
  }, [card]);
  useEffect(() => { setCard(null); }, [region]);
  return <div ref={host} className={s.canvasFrame} data-spatial-owner="odyssey" data-morph="off" data-guide="odyssey-map" data-ready={ready || undefined} data-tier={tier}>
    <div className={s.canvas} tabIndex={0} role="group" aria-label={vi ? 'Hành tinh 3D. Kéo để xoay hành tinh theo tay, phím mũi tên để di chuyển, cộng trừ để thu phóng, Q và E để quay hướng nhìn, Home để về toàn cảnh.' : '3D planet. Drag to turn the planet with your hand, arrow keys move, plus and minus zoom, Q and E turn, Home returns to the overview.'}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run('inspect'); return; }
        const spins: Record<string, [number, number]> = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
        if (spins[e.key]) { e.preventDefault(); run('spin', ...spins[e.key]); }
        else if (['+', '='].includes(e.key)) { e.preventDefault(); run('zoom', 1); }
        else if (e.key === '-') { e.preventDefault(); run('zoom', -1); }
        else if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); run('turn', -1); }
        else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); run('turn', 1); }
        else if (e.key === 'Home') { e.preventDefault(); run('home'); }
      }}>
      {!failed && build && <SceneBoundary onError={onError}><Canvas shadows="percentage" dpr={spec.dpr} camera={{ fov: 30, near: 1, far: 4000, position: [0, 0, 560] }}
        frameloop={!active || props.paused ? 'never' : reduced ? 'demand' : 'always'} gl={GL}
        onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.06; gl.info.autoReset = false; gl.shadowMap.autoUpdate = false; }}>
        <Suspense fallback={null}><Scene build={build} props={props} spec={spec} tier={tier} auto={auto} phone={profile.phone} reduced={reduced} command={command} labels={labels.current} pinLabels={pinLabels.current} onReady={onReady} onError={onError} onGovern={onGovern} onFeature={onFeature} /></Suspense>
      </Canvas></SceneBoundary>}
    </div>
    {!ready && !failed && <div className={s.loadingOcean} role="status"><span className={s.loadingGlobe} aria-hidden="true"><Globe2 /></span><span>{build ? (vi ? 'Đang thắp sáng hành tinh…' : 'Lighting the planet…') : (vi ? 'Đang dựng hành tinh của bạn…' : 'Shaping your planet…')}</span></div>}
    {failed && <div className={s.loadingOcean} role="alert"><AlertCircle /><p>{vi ? 'Cảnh 3D chưa tải được. Bạn vẫn có thể mở mọi trạm học.' : 'The 3D scene could not load. Every learning station is still available.'}</p><button onClick={onFallback}>{vi ? 'Mở hải đồ nhẹ' : 'Open the lightweight atlas'}</button></div>}
    <div className={s.labels} aria-label={vi ? 'Các vùng trên hành tinh' : 'Planet regions'}>
      {regions.map(r => <button key={r.id} ref={el => { if (el) labels.current.set(r.id, el); else labels.current.delete(r.id); }} hidden data-region={r.id}
        className={s.mapLabel} data-known={discovered.includes(r.id)} data-kind={props.kinds[r.id] ?? 'open'} aria-label={`${name(r)} — ${props.states[r.id] || (vi ? 'Có thể học' : 'Available')}`} onClick={() => props.onRegion(r.id)}>
        <span>{(() => { const Icon = ICON_FOR[r.skill] ?? Compass; return <i aria-hidden="true"><Icon size={16} strokeWidth={2.4} /></i>; })()}<b>{name(r)}</b><small>{props.states[r.id]}</small></span>
      </button>)}
      {labelled.map(st => <button key={st.id} ref={el => { if (el) pinLabels.current.set(st.id, el); else pinLabels.current.delete(st.id); }} hidden className={s.pinLabel}
        data-next={st.id === props.nextStation || undefined} onClick={() => props.onStation(st.id)}>{vi ? st.title.vi : st.title.en}</button>)}
    </div>
    <div className={s.surfaceChip} ref={chip} hidden aria-hidden="true" data-testid="odyssey-surface-chip" />
    {card && <SurfaceCard card={card} vi={vi} regions={regions} region={region} frame={host.current} onClose={() => setCard(null)} onRegion={id => { setCard(null); props.onRegion(id); }} />}
    <div className={`${s.mapControls} ${hudChrome}`} data-hud-chrome="right" aria-label={vi ? 'Điều khiển hành tinh' : 'Planet controls'}>
      <button onClick={() => run('zoom', 1)} aria-label={vi ? 'Phóng to' : 'Zoom in'}><Plus /></button>
      <button onClick={() => run('zoom', -1)} aria-label={vi ? 'Thu nhỏ' : 'Zoom out'}><Minus /></button>
      <button onClick={() => run('turn', -1)} aria-label={vi ? 'Quay hướng nhìn sang trái' : 'Turn left'}><RotateCcw /></button>
      <button onClick={() => run('turn', 1)} aria-label={vi ? 'Quay hướng nhìn sang phải' : 'Turn right'}><RotateCw /></button>
      <button onClick={() => run('home')} aria-label={region ? (vi ? 'Về toàn cảnh vùng' : 'Back to the region view') : (vi ? 'Về toàn cảnh hành tinh' : 'Back to the planet view')}><Compass /></button>
      {!region && props.current && <button onClick={() => run('here')} aria-label={vi ? 'Đến vùng hiện tại' : 'Go to your current region'}><LocateFixed /></button>}
      {region && selected && <button onClick={() => run('station')} aria-label={vi ? 'Đến trạm đang chọn' : 'Focus the selected station'}><LocateFixed /></button>}
    </div>
  </div>;
}

const FEATURE_ICON: Record<Feature['kind'], LucideIcon> = { ocean: Waves, shallows: Waves, stack: Mountain, beach: Waves, volcano: Flame, lava: Flame, ice: Snowflake, peak: Snowflake,
  mountain: Mountain, hill: Mountain, forest: Trees, village: Home, landmark: Landmark, land: Globe2 };

/** What the learner touched: its name, the English word (looked up only on a click, in the real dictionary), and the
    region whose land it is — the one learning link a place has. Nothing here is invented learning content. */
function SurfaceCard({ card, vi, regions, region, frame, onClose, onRegion }: { card: { f: Feature; x: number; y: number }; vi: boolean; regions: Region[]; region: string | null;
  frame: HTMLDivElement | null; onClose: () => void; onRegion: (id: string) => void }) {
  const { f } = card, w = featureWords(f), home = f.site ? regions.find(r => r.id === f.site) : null, Icon = FEATURE_ICON[f.kind];
  // Beside the touched point on a wide screen; above the bottom controls, full width, on a phone.
  const W = frame?.clientWidth ?? 1200, H = frame?.clientHeight ?? 800, cw = Math.min(300, W - 24);
  const place = W < 760 ? { left: 10, right: 10, bottom: 150 } : { left: Math.max(12, Math.min(W - cw - 12, card.x + 18)), top: Math.max(76, Math.min(H - 230, card.y - 40)), width: cw };
  return <div className={s.surfaceCard} style={place} role="group" aria-label={vi ? `Bạn đã chạm vào ${w.vi}` : `You touched: ${w.en}`} data-kind={f.kind} data-testid="odyssey-surface-card">
    <div className={s.surfaceHead}><span className={s.surfaceIcon} data-kind={f.kind} aria-hidden="true"><Icon size={18} /></span>
      <span><strong>{vi ? w.vi : w.en}</strong><small lang="en">{w.word}</small></span>
      <button type="button" onClick={onClose} aria-label={vi ? 'Đóng' : 'Close'}><X size={15} /></button></div>
    {home ? <p>{f.kind === 'landmark' ? (vi ? 'Trái tim của vùng ' : 'The heart of ') : (vi ? 'Thuộc vùng ' : 'Part of ')}<b>{vi ? home.name.vi : home.name.en}</b>{home.id === region ? (vi ? ' — bạn đang ở đây.' : ' — you are here.') : '.'}</p>
      : <p>{f.kind === 'ocean' || f.kind === 'shallows' ? (vi ? 'Biển nối các vùng học với nhau.' : 'The sea joins the learning regions.') : (vi ? 'Một nơi hoang sơ, không thuộc vùng học nào.' : 'A wild place that belongs to no learning region.')}</p>}
    <div className={s.surfaceActions}>
      {home && home.id !== region && <button type="button" className={s.surfacePrimary} onClick={() => onRegion(home.id)} data-testid="odyssey-surface-visit"><Compass size={15} />{vi ? 'Đến vùng này' : 'Go to this region'}</button>}
      <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('ec:dictionary:lookup', { detail: { word: w.word } }))} data-testid="odyssey-surface-lookup"><BookOpen size={15} />{vi ? `Tra “${w.word}”` : `Look up “${w.word}”`}</button>
    </div>
  </div>;
}
