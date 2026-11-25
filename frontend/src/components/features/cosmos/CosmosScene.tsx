'use client';
/**
 * Echo Neural Cosmos — the 3D scene (lazy chunk). Everything heavy runs on the visitor's device: no server rendering, no AI.
 *
 * Draw budget: 1 decorative starfield, 1 galaxy-dust field, ≤ 11 nebula quads, 1 instanced draw for every knowledge star,
 * 1 line draw for edges + strands, 1 draw for frontier ghosts. Decorative points are tiny, uniform, unpickable and never
 * labelled; knowledge stars are larger, haloed, pickable and every one of them is a real node of the graph.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import type { OrbitControls as OrbitImpl } from 'three-stdlib';
import { GALAXIES } from '@/lib/cosmos/domains';
import { hash01, tilt, untilt, UNIVERSE_RADIUS } from '@/lib/cosmos/layout';
import { CATEGORY_COLOR, RELATIONS } from '@/lib/cosmos/ontology';
import { dominant } from '@/lib/cosmos/aggregate';
import type { CosmosGraph } from '@/lib/cosmos/types';
import { FLAG, type ViewModel } from '@/lib/cosmos/view';
import { QUALITY, type QualityLevel } from './quality';

export type Pick = { kind: 'node'; index: number } | { kind: 'edge'; index: number } | { kind: 'bundle'; index: number } | { kind: 'galaxy' | 'constellation' | 'system'; index: number } | { kind: 'none' };
/** A place the page offers as a destination besides stars (lib/cosmos/navigate.ts pickableRegions). */
export interface PickRegion { kind: 'galaxy' | 'constellation' | 'system'; index: number }
/** The ring of light on what the pointer is over, or on where a flight is going. */
export interface HoverMark { x: number; y: number; z: number; r: number; color: string; travel?: boolean }
export interface ProjectedLabel { key: string; sx: number; sy: number; depth: number }
export interface SceneHandle {
  /** What lies under a screen point: stars first (bright ones win a tie), then relations, then the offered regions (the smallest
   *  region around the point wins, so a constellation beats the galaxy it is in). `coarse`: a finger, larger targets. */
  pick(x: number, y: number, opts?: { regions?: PickRegion[]; coarse?: boolean }): Pick;
  /** A flight; `arc` lifts the camera out of the galaxy and back in, so the learner sees where they travel. */
  flyTo(target: [number, number, number], distance: number, instant?: boolean, view?: [number, number, number], arc?: boolean): void;
  /** The ring of light on a star or region (null hides it). */
  mark(m: HoverMark | null): void;
  flying(): boolean;
  /** A sphere on screen: centre (px) and radius (px, along the camera's own right vector), or null behind the camera. */
  measure(x: number, y: number, z: number, r: number): { sx: number; sy: number; pr: number } | null;
  /** Stop a flight where the camera is now (Escape during a flight). */
  stop(): void;
  project(points: { key: string; x: number; y: number; z: number }[]): ProjectedLabel[];
  cameraDistance(): number;
  /** The camera as it is now (position + orbit target), so a remounted scene can come back to the same place. */
  getView(): CameraView | null;
  /** Put the camera exactly there (no flight). */
  setView(v: CameraView): void;
}
export interface CameraView { pos: [number, number, number]; target: [number, number, number] }
/** The orbit target never drifts further than this from the universe's centre (panning / zoom-to-cursor): the camera can never
 *  wander into the empty void where every structure is behind it. */
const TARGET_LIMIT = UNIVERSE_RADIUS * 2.6;
interface Props {
  graph: CosmosGraph; view: ViewModel; quality: QualityLevel; reduced: boolean; selectedEdge: number;
  onReady: (h: SceneHandle) => void; onFrameLabels: () => void; onContextLost: () => void; onSlow: () => void;
  onUserMove: () => void;
  /** The focused star system (system / star level) whose members' orbits are drawn; -1 = none. */
  orbitSystem?: number;
}

const STATUS_GLOW: Record<string, number> = { NEW: 0.72, LEARNED: 0.9, MASTERED: 1.05 };
/** How far past a region's centre a stub reaches, in region radii (just beyond the rim). */
const STUB_REACH: Record<string, number> = { galaxy: 1.08, constellation: 1.12 };

export default function CosmosScene(props: Props) {
  const q = QUALITY[props.quality];
  // A context lost BECAUSE this scene is going away (the learner chose the tree, the page is left: R3F forces the loss after
  // unmounting) is not a failure of the device. Only a loss while the scene is mounted and on the page is reported.
  const alive = useRef(true);
  const onLost = useRef(props.onContextLost);
  onLost.current = props.onContextLost;
  const [tabHidden, setTabHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const onVisibility = () => setTabHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  return (
    <Canvas
      dpr={[1, Math.min(q.dpr, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)]}
      gl={{ antialias: q.antialias, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false }}
      // far is generous: nothing writes depth, so depth precision costs nothing, and no decoration may ever be cut by the far
      // plane (a far plane inside the sky dome cut a polygonal hole into it behind the galaxy when the camera was far out)
      camera={{ fov: 55, near: 1, far: 120000, position: [0, 2600, 5200] }}
      frameloop={tabHidden ? 'never' : props.reduced ? 'demand' : 'always'}
      onCreated={({ gl }) => {
        gl.setClearColor('#02040d');
        gl.info.autoReset = false; // counted per whole frame (the post-processing passes would otherwise reset it)
        const canvas = gl.domElement;
        canvas.addEventListener('webglcontextlost', e => {
          e.preventDefault();
          if (!alive.current || !canvas.isConnected) return;
          onLost.current();
        }, { once: true });
      }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <Universe {...props} />
      {q.bloom && <EffectComposer multisampling={0}><Bloom mipmapBlur intensity={q.bloomIntensity} luminanceThreshold={0.32} luminanceSmoothing={0.2} /></EffectComposer>}
    </Canvas>
  );
}

function Universe({ graph, view, quality, reduced, selectedEdge, onReady, onFrameLabels, onSlow, onUserMove, orbitSystem = -1 }: Props) {
  const q = QUALITY[quality];
  const { camera, gl, size, invalidate } = useThree();
  const controls = useRef<OrbitImpl>(null);
  const fly = useRef<{ from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number; dur: number; ctrl: THREE.Vector3 | null } | null>(null);
  const clock = useRef({ last: 0, slow: 0, frames: 0, acc: 0, samples: [] as number[] });
  const labelTick = useRef(0);
  // live star state of the previous build: a rebuild (growth) keeps every existing star where and how it is
  const prevStars = useRef<{ ids: Map<string, number>; alpha: Float32Array; scale: Float32Array } | null>(null);

  // ── knowledge stars: one instanced draw ──────────────────────────────────────────────────────────────────────────
  const stars = useMemo(() => {
    const N = graph.nodes.length;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), base = new Float32Array(N);
    graph.nodes.forEach((n, i) => {
      pos.set([n.x, n.y, n.z], i * 3);
      const c = new THREE.Color(n.kind === 'source' ? '#bbf7d0' : n.kind === 'grammar' ? '#f5d0fe' : GALAXIES[n.galaxy]?.color ?? '#e2e8f0');
      const glow = n.kind === 'concept' ? 0.55 : STATUS_GLOW[n.status] ?? 0.85;
      col.set([c.r * glow, c.g * glow, c.b * glow], i * 3);
      base[i] = n.size;
    });
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
    geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(col, 3));
    geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(base, 1));
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(N), 1); alpha.setUsage(THREE.DynamicDrawUsage);
    const scale = new THREE.InstancedBufferAttribute(new Float32Array(N), 1); scale.setUsage(THREE.DynamicDrawUsage);
    const flag = new THREE.InstancedBufferAttribute(new Float32Array(N), 1); flag.setUsage(THREE.DynamicDrawUsage);
    const mem = new THREE.InstancedBufferAttribute(new Float32Array(N), 1); mem.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iAlpha', alpha); geo.setAttribute('iScale', scale); geo.setAttribute('iFlag', flag); geo.setAttribute('iMem', mem);
    geo.instanceCount = N;
    const prev = prevStars.current;
    if (prev) {
      const a = alpha.array as Float32Array, sc = scale.array as Float32Array;
      graph.nodes.forEach((n, i) => {
        const j = prev.ids.get(n.id);
        if (j !== undefined) { a[i] = prev.alpha[j]; sc[i] = prev.scale[j]; }
        else { a[i] = 0; sc[i] = 2.6; } // a new star: born large and bright, settles into place
      });
    }
    prevStars.current = { ids: new Map(graph.nodes.map((n, i) => [n.id, i])), alpha: alpha.array as Float32Array, scale: scale.array as Float32Array };
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPixel: { value: 0.0016 }, uMotion: { value: 1 } },
      vertexShader: STAR_VS, fragmentShader: STAR_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return { mesh, alpha, scale, flag, mem, target: { alpha: new Float32Array(N), scale: new Float32Array(N) } };
  }, [graph]);

  // false once every star sits on its target: the frame loop then skips the per-star easing scan until the targets change
  // (performance release 2026-11-16, PERF-12). The drawn result is identical: a settled star moved by nothing anyway.
  const starsEasing = useRef(true);
  useEffect(() => {
    starsEasing.current = true;
    stars.target.alpha.set(view.starAlpha);
    stars.target.scale.set(view.starScale);
    const f = stars.flag.array as Float32Array;
    for (let i = 0; i < f.length; i++) f[i] = view.starFlag[i];
    stars.flag.needsUpdate = true;
    const mm = stars.mem.array as Float32Array;
    for (let i = 0; i < mm.length; i++) mm[i] = view.starMem[i];
    stars.mem.needsUpdate = true;
    (stars.mesh.material as THREE.ShaderMaterial).uniforms.uMotion.value = reduced ? 0 : 1;
    if (reduced) { (stars.alpha.array as Float32Array).set(view.starAlpha); (stars.scale.array as Float32Array).set(view.starScale); stars.alpha.needsUpdate = stars.scale.needsUpdate = true; }
    invalidate();
  }, [view, stars, reduced, invalidate]);

  // ── edges + strands: one line draw, pulses in the shader ────────────────────────────────────────────────────────
  const lines = useMemo(() => {
    const p: number[] = [], c: number[] = [], t: number[] = [], m: number[] = [];
    const seg = (a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, alpha: number, t0: number, t1: number, mode: number) => {
      p.push(a.x, a.y, a.z, b.x, b.y, b.z); c.push(color.r, color.g, color.b, alpha, color.r, color.g, color.b, alpha); t.push(t0, t1); m.push(mode, mode);
    };
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    for (const i of view.edges) {
      const e = graph.edges[i], s = graph.nodes[e.s], d = graph.nodes[e.t];
      const color = new THREE.Color(CATEGORY_COLOR[e.category]);
      const sel = i === selectedEdge;
      const alpha = sel ? 1 : e.note === 'concept' ? 0.18 : e.status === 'SUGGESTED' ? 0.4 : 0.55;
      // mode: 0 still, 1 directed pulse, 2 undirected shimmer, 3 dashed suggestion, 4 wormhole
      const mode = e.status === 'SUGGESTED' ? 3 : e.type === 'CROSS_SKILL_TRANSFER' ? 4 : e.note === 'concept' ? 0 : RELATIONS[e.type].directed ? 1 : 2;
      const a = V(s.x, s.y, s.z), b = V(d.x, d.y, d.z);
      if (mode === 4) { // a wormhole arcs out of the plane
        const mid = a.clone().add(b).multiplyScalar(0.5).add(V(0, a.distanceTo(b) * 0.35, 0));
        curve(a, mid, b, 18, (p0, p1, u0, u1) => seg(p0, p1, color, sel ? 1 : 0.7, u0, u1, mode));
      } else seg(a, b, color, alpha, 0, 1, mode);
    }
    view.bundles.forEach(bu => {
      const list = bu.kind === 'galaxy' ? graph.galaxies : graph.constellations;
      const [ia, ib] = bu.stub && bu.from === bu.b ? [bu.b, bu.a] : [bu.a, bu.b];
      const A = list[ia], B = list[ib];
      const a = V(A.x, A.y, A.z), b = V(B.x, B.y, B.z);
      if (bu.stub) { // up close: a short fading stub toward the other region, never a line across the whole screen
        // starts at the region's rim (never through its stars) and fades within a short distance
        const dir = b.clone().sub(a).normalize();
        const start = a.clone().add(dir.clone().multiplyScalar(A.radius * 0.85));
        const end = a.clone().add(dir.multiplyScalar(A.radius * STUB_REACH[bu.kind] + 8));
        const color = new THREE.Color(CATEGORY_COLOR[dominant(bu)]);
        for (let k = 0; k < 6; k++) seg(start.clone().lerp(end, k / 6), start.clone().lerp(end, (k + 1) / 6), color, 0.36 * (1 - k / 6) ** 2, k / 6, (k + 1) / 6, 2);
        return;
      }
      // a strand arcs ABOVE the plane of the galaxies (higher for longer ones): strands never cross the centre as a web
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y += a.distanceTo(b) * (bu.kind === 'galaxy' ? 0.42 : 0.25);
      const color = new THREE.Color(CATEGORY_COLOR[dominant(bu)]);
      const alpha = bu.kind === 'galaxy' ? Math.min(0.42, 0.14 + Math.log2(1 + bu.edges.length) * 0.05) : Math.min(0.8, 0.22 + Math.log2(1 + bu.edges.length) * 0.09);
      curve(a, mid, b, 24, (p0, p1, u0, u1) => seg(p0, p1, color, alpha, u0, u1, 2));
    });
    for (const g of view.ghosts) {
      const s = graph.nodes[g.from];
      seg(V(s.x, s.y, s.z), V(g.x, g.y, g.z), new THREE.Color('#cbd5e1'), 0.35, 0, 1, 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(c, 4));
    geo.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
    geo.setAttribute('aMode', new THREE.Float32BufferAttribute(m, 1));
    const mat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uMotion: { value: reduced ? 0 : 1 } }, vertexShader: LINE_VS, fragmentShader: LINE_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const obj = new THREE.LineSegments(geo, mat);
    obj.frustumCulled = false;
    return obj;
  }, [graph, view, selectedEdge, reduced]);
  useEffect(() => () => { lines.geometry.dispose(); (lines.material as THREE.Material).dispose(); }, [lines]);

  const ghostPoints = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(view.ghosts.flatMap(g => [g.x, g.y, g.z]), 3));
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false,
      vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = 9.0; }',
      fragmentShader: 'void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; float ring = smoothstep(0.25, 0.0, abs(r - 0.7)); gl_FragColor = vec4(vec3(0.62, 0.69, 0.8), ring * 0.85); }' });
    return new THREE.Points(geo, mat);
  }, [view.ghosts]);
  useEffect(() => () => { ghostPoints.geometry.dispose(); (ghostPoints.material as THREE.Material).dispose(); }, [ghostPoints]);

  // ── the ring of light on what the pointer is over, or on the destination of a flight (one billboard, drawn only when shown) ──
  const halo = useMemo(() => {
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color('#67e8f9') }, uOpacity: { value: 0 }, uTime: { value: 0 }, uMotion: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `precision mediump float; varying vec2 vUv; uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uMotion;
        void main(){ vec2 p = vUv * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard;
          float breath = 0.5 + 0.5 * sin(uTime * 2.4) * uMotion;
          float ring = smoothstep(0.045, 0.0, abs(r - (0.86 + breath * 0.03)));
          float glow = smoothstep(1.0, 0.55, r) * smoothstep(0.35, 0.86, r) * 0.22;
          float ang = atan(p.y, p.x) - uTime * 0.35 * uMotion;
          float arcs = smoothstep(0.55, 0.95, cos(ang * 3.0)) * smoothstep(0.03, 0.0, abs(r - 0.95)) * 0.8;
          gl_FragColor = vec4(uColor, (ring * 0.9 + glow + arcs) * uOpacity); }` });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false; mesh.renderOrder = 10; mesh.visible = false;
    return { mesh, mat, target: 0, travel: false };
  }, []);
  useEffect(() => () => { halo.mesh.geometry.dispose(); halo.mat.dispose(); }, [halo]);

  // ── decorative layers (never data) ─────────────────────────────────────────────────────────────────────────────
  const backdrop = useMemo(() => buildBackdrop(graph, q.backgroundStars, q.dustPerGalaxy), [graph, q.backgroundStars, q.dustPerGalaxy]);
  const cosmic = useMemo(() => buildCosmicStructure(q.cosmicDust), [q.cosmicDust]);
  useEffect(() => () => { cosmic.points.geometry.dispose(); (cosmic.points.material as THREE.Material).dispose(); cosmic.bulge.geometry.dispose(); (cosmic.bulge.material as THREE.Material).dispose(); }, [cosmic]);
  // the galactic disc itself (decoration): one quad in the disc's plane, procedural arms; not on Lite (fill rate on weak GPUs)
  const disc = useMemo(() => (q.nebula ? buildGalacticDisc(q.nebulaOctaves) : null), [q.nebula, q.nebulaOctaves]);
  useEffect(() => () => { if (disc) { disc.geometry.dispose(); (disc.material as THREE.Material).dispose(); } }, [disc]);
  // the real orbits of the focused system's stars around its centre (decoration over real positions; the stars never move)
  const orbits = useMemo(() => buildOrbits(graph, orbitSystem), [graph, orbitSystem]);
  useEffect(() => () => { if (orbits) { orbits.geometry.dispose(); (orbits.material as THREE.Material).dispose(); } }, [orbits]);
  const decorMats = useMemo(() => [cosmic.points.material, backdrop.stars.material, backdrop.dust.material, disc?.material, orbits?.material]
    .filter(Boolean) as THREE.ShaderMaterial[], [cosmic, backdrop, disc, orbits]);
  const nebulae = useMemo(() => graph.galaxies.filter(g => g.count > 0).map(g => {
    const m = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(g.color) }, uSeed: { value: hash01(g.key) * 10 }, uOct: { value: q.nebulaOctaves } },
      vertexShader: NEB_VS, fragmentShader: NEB_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    // Lite (no nebula noise): only the core is drawn, on a small quad (overdraw is what costs on weak / software GPUs)
    mesh.position.set(g.x, g.y, g.z); mesh.scale.setScalar(g.radius * (q.nebula ? 2.8 : 0.9));
    return mesh;
  }), [graph, q.nebula, q.nebulaOctaves]);
  const sky = useMemo(() => {
    if (!q.nebula) return null;
    // the sky is at infinity: a unit sphere drawn around the camera (rotation only) at the far end of the depth range, so no
    // camera position, angle or zoom can ever leave it or cut it
    const m = new THREE.ShaderMaterial({ uniforms: { uOct: { value: Math.max(2, q.nebulaOctaves - 1) } }, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), m);
    mesh.frustumCulled = false; mesh.renderOrder = -1;
    return mesh;
  }, [q.nebula, q.nebulaOctaves]);
  useEffect(() => () => { if (sky) { sky.geometry.dispose(); (sky.material as THREE.Material).dispose(); } }, [sky]);
  useEffect(() => () => {
    const disposeMaterial = (mat: THREE.Material) => {
      for (const value of Object.values(mat)) if (value instanceof THREE.Texture) value.dispose();
      mat.dispose();
    };
    backdrop.stars.geometry.dispose();
    disposeMaterial(backdrop.stars.material as THREE.Material);
    backdrop.dust.geometry.dispose();
    disposeMaterial(backdrop.dust.material as THREE.Material);
  }, [backdrop]);
  useEffect(() => () => { nebulae.forEach(n => { n.geometry.dispose(); (n.material as THREE.Material).dispose(); }); }, [nebulae]);
  useEffect(() => () => { stars.mesh.geometry.dispose(); (stars.mesh.material as THREE.Material).dispose(); }, [stars]);

  // ── handle for the page: picking, projection, camera ───────────────────────────────────────────────────────────
  useEffect(() => {
    const v = new THREE.Vector3();
    const toScreen = (x: number, y: number, z: number) => {
      v.set(x, y, z).project(camera);
      return { sx: (v.x * 0.5 + 0.5) * size.width, sy: (-v.y * 0.5 + 0.5) * size.height, ok: v.z < 1 && v.z > -1, depth: v.z };
    };
    const handle: SceneHandle = {
      pick(x, y, opts) {
        // A star is a target within ~18 px (28 for a finger); a dim star of another branch still counts, but a bright one wins
        // when both are near: distance is weighed by how visible each is.
        const reach = opts?.coarse ? 28 : 18;
        let best = -1, bestD = Infinity;
        const alpha = view.starAlpha;
        for (const n of graph.nodes) {
          if (alpha[n.i] < 0.07) continue;
          const s = toScreen(n.x, n.y, n.z);
          if (!s.ok) continue;
          const d2 = (s.sx - x) ** 2 + (s.sy - y) ** 2;
          if (d2 > reach * reach + view.starScale[n.i] * 20) continue;
          const score = (d2 - view.starScale[n.i] * 20) / (0.35 + alpha[n.i]);
          if (score < bestD) { bestD = score; best = n.i; }
        }
        if (best >= 0) return { kind: 'node', index: best };
        let edge = -1, edgeD = 7;
        for (const i of view.edges) {
          const e = graph.edges[i], a = toScreen(graph.nodes[e.s].x, graph.nodes[e.s].y, graph.nodes[e.s].z), b = toScreen(graph.nodes[e.t].x, graph.nodes[e.t].y, graph.nodes[e.t].z);
          if (!a.ok || !b.ok) continue;
          const d = segDist(x, y, a.sx, a.sy, b.sx, b.sy);
          if (d < edgeD) { edgeD = d; edge = i; }
        }
        if (edge >= 0) return { kind: 'edge', index: edge };
        let bundle = -1, bd = 7;
        view.bundles.forEach((bu, k) => {
          const list = bu.kind === 'galaxy' ? graph.galaxies : graph.constellations;
          const [ia, ib] = bu.stub && bu.from === bu.b ? [bu.b, bu.a] : [bu.a, bu.b];
          const A = list[ia], B = list[ib];
          let bx = B.x, by = B.y, bz = B.z;
          if (bu.stub) { // the drawn stub only, never the invisible rest of the line
            const d = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z) || 1, f = Math.min(0.3, (A.radius * STUB_REACH[bu.kind] + 8) / d);
            bx = A.x + (B.x - A.x) * f; by = A.y + (B.y - A.y) * f; bz = A.z + (B.z - A.z) * f;
          }
          const a = toScreen(A.x, A.y, A.z), b = toScreen(bx, by, bz);
          if (!a.ok || !b.ok) return;
          const d = segDist(x, y, a.sx, a.sy, b.sx, b.sy);
          if (d < bd) { bd = d; bundle = k; }
        });
        if (bundle >= 0) return { kind: 'bundle', index: bundle };
        // Regions: the body of a galaxy, a constellation, a system — not only their names. Its screen radius is measured with
        // the camera's own right vector (true at any angle); the smallest region around the point wins (the most specific place).
        const regions = opts?.regions ?? graph.galaxies.filter(g => g.count > 0).map(g => ({ kind: 'galaxy' as const, index: g.i }));
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        let region: PickRegion | null = null, regionR = Infinity;
        for (const r of regions) {
          const c = r.kind === 'galaxy' ? graph.galaxies[r.index] : r.kind === 'constellation' ? graph.constellations[r.index] : graph.systems[r.index];
          if (!c) continue;
          const p = toScreen(c.x, c.y, c.z);
          if (!p.ok) continue;
          const e = toScreen(c.x + right.x * c.radius, c.y + right.y * c.radius, c.z + right.z * c.radius);
          const pr = Math.hypot(e.sx - p.sx, e.sy - p.sy) * (r.kind === 'galaxy' ? 0.85 : 0.95);
          const rr = Math.max(opts?.coarse ? 40 : r.kind === 'system' ? 20 : 30, pr);
          if (Math.hypot(p.sx - x, p.sy - y) < rr && rr < regionR) { regionR = rr; region = r; }
        }
        if (region) return { kind: region.kind, index: region.index };
        return { kind: 'none' };
      },
      mark(m) {
        if (!m) { halo.target = 0; invalidate(); return; }
        halo.mesh.position.set(m.x, m.y, m.z); halo.mesh.scale.setScalar(Math.max(4, m.r));
        halo.mat.uniforms.uColor.value.set(m.color); halo.target = 1; halo.travel = !!m.travel; halo.mesh.visible = true; invalidate();
      },
      flying: () => fly.current !== null,
      measure(x, y, z, r) {
        const c = toScreen(x, y, z); if (!c.ok) return null;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), e = toScreen(x + right.x * r, y + right.y * r, z + right.z * r);
        return { sx: c.sx, sy: c.sy, pr: Math.hypot(e.sx - c.sx, e.sy - c.sy) };
      },
      stop() { fly.current = null; if (halo.travel) halo.target = 0; },
      flyTo(target, distance, instant, viewDir, arc) {
        const ctl = controls.current;
        if (!ctl) return;
        const tTo = new THREE.Vector3(...target);
        // keep the learner's viewing direction (orientation is preserved) unless a level asks for its own
        const dir = viewDir ? new THREE.Vector3(...viewDir).normalize() : camera.position.clone().sub(ctl.target).normalize();
        if (dir.lengthSq() < 0.5) dir.set(0, 0.45, 1).normalize();
        dir.y = Math.max(0.18, dir.y); dir.normalize();
        const to = tTo.clone().add(dir.multiplyScalar(distance));
        if (instant || reduced) { camera.position.copy(to); ctl.target.copy(tTo); ctl.update(); invalidate(); fly.current = null; return; }
        const span = camera.position.distanceTo(to);
        // A long trip arcs: out of the galaxy (up and away from the universe's centre) and back in, a little longer, so the
        // learner keeps their bearings; a short one is a straight eased glide. Every flight stops the moment the learner moves.
        let ctrl: THREE.Vector3 | null = null;
        if (arc) {
          const mid = camera.position.clone().add(to).multiplyScalar(0.5), out = mid.clone().setY(0);
          ctrl = mid.add(new THREE.Vector3(0, span * 0.42, 0)).add(out.lengthSq() > 1 ? out.normalize().multiplyScalar(span * 0.18) : new THREE.Vector3());
        }
        fly.current = { from: camera.position.clone(), to, tFrom: ctl.target.clone(), tTo, t: 0, ctrl,
          dur: arc ? Math.min(2.6, 1.25 + Math.log10(1 + span) * 0.32) : Math.min(1.6, 0.7 + Math.log10(1 + span) * 0.22) };
      },
      project(points) {
        const out: ProjectedLabel[] = [];
        for (const p of points) { const s = toScreen(p.x, p.y, p.z); if (s.ok) out.push({ key: p.key, sx: s.sx, sy: s.sy, depth: s.depth }); }
        return out;
      },
      cameraDistance: () => controls.current ? camera.position.distanceTo(controls.current.target) : 0,
      getView() {
        const ctl = controls.current;
        if (!ctl) return null;
        return { pos: [camera.position.x, camera.position.y, camera.position.z], target: [ctl.target.x, ctl.target.y, ctl.target.z] };
      },
      setView(v) {
        const ctl = controls.current;
        if (!ctl) return;
        fly.current = null;
        camera.position.set(...v.pos); ctl.target.set(...v.target); ctl.update(); invalidate();
      },
    };
    onReady(handle);
  }, [camera, size, graph, view, reduced, onReady, invalidate, halo]);

  // Cancel an automatic flight the moment the learner takes the camera.
  useEffect(() => {
    const ctl = controls.current;
    if (!ctl) return;
    const start = () => { fly.current = null; onUserMove(); };
    ctl.addEventListener('start', start);
    return () => ctl.removeEventListener('start', start);
  }, [onUserMove]);

  // Resume a fresh frame when the tab returns to visibility (especially in reduced-motion 'demand' mode).
  useEffect(() => {
    const onVis = () => { if (!document.hidden) invalidate(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [invalidate]);

  useFrame((state, dt) => {
    if (document.hidden) return;
    const time = state.clock.elapsedTime;
    (stars.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
    (lines.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
    const dpr = gl.getPixelRatio();
    for (const m of decorMats) { m.uniforms.uTime.value = time; m.uniforms.uMotion.value = reduced ? 0 : 1; if (m.uniforms.uDpr) m.uniforms.uDpr.value = dpr; }
    // eased approach of star alpha / scale (reveal, fade) — no per-node React state
    if (starsEasing.current) {
      const a = stars.alpha.array as Float32Array, s = stars.scale.array as Float32Array, ta = stars.target.alpha, ts = stars.target.scale;
      const k = Math.min(1, dt * 5);
      let moving = false;
      for (let i = 0; i < a.length; i++) {
        const da = ta[i] - a[i], ds = ts[i] - s[i];
        if (Math.abs(da) > 0.002 || Math.abs(ds) > 0.002) { a[i] += da * k; s[i] += ds * k; moving = true; }
      }
      if (moving) { stars.alpha.needsUpdate = true; stars.scale.needsUpdate = true; }
      starsEasing.current = moving;
    }
    const f = fly.current, ctl = controls.current;
    if (ctl && !f) { // keep the orbit target near the structure (pan / zoom-to-cursor); camera moves with it, the view does not jump
      const over = ctl.target.length() - TARGET_LIMIT;
      if (over > 0) { const d = ctl.target.clone().normalize().multiplyScalar(over); ctl.target.sub(d); camera.position.sub(d); ctl.update(); }
    }
    if (f && ctl) {
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      if (f.ctrl) { // quadratic Bézier through the lifted control point; the gaze turns to the destination a little earlier
        const u = 1 - e;
        camera.position.set(0, 0, 0).addScaledVector(f.from, u * u).addScaledVector(f.ctrl, 2 * u * e).addScaledVector(f.to, e * e);
        ctl.target.lerpVectors(f.tFrom, f.tTo, Math.min(1, e * 1.25));
      } else {
        camera.position.lerpVectors(f.from, f.to, e);
        ctl.target.lerpVectors(f.tFrom, f.tTo, e);
      }
      ctl.update();
      if (f.t >= 1) { fly.current = null; if (halo.travel) halo.target = 0; }
    }
    // the halo: faces the camera, fades in and out, breathes (shader); drawn only while it shows
    if (halo.mesh.visible) {
      halo.mesh.quaternion.copy(camera.quaternion);
      const o = halo.mat.uniforms.uOpacity.value as number, k = reduced ? 1 : Math.min(1, dt * 10);
      halo.mat.uniforms.uOpacity.value = o + (halo.target - o) * k;
      halo.mat.uniforms.uTime.value = time; halo.mat.uniforms.uMotion.value = reduced ? 0 : 1;
      if (halo.target === 0 && (halo.mat.uniforms.uOpacity.value as number) < 0.01) halo.mesh.visible = false;
    }
    if (time - labelTick.current > 0.09) { labelTick.current = time; onFrameLabels(); }
    // adaptive quality: sustained slow frames step the profile down (never during a flight)
    const c = clock.current;
    if (dt > 0 && dt < 0.25 && !f) {
      c.slow = Math.max(0, c.slow + (dt > 1 / 38 ? dt : -dt * 0.5));
      if (c.slow > 2.5) { c.slow = 0; onSlow(); }
      c.frames++; c.acc += dt; c.samples.push(dt * 1000);
      if (c.acc > 1) {
        const sorted = [...c.samples].sort((x, y) => x - y);
        const el = gl.domElement.closest('[data-cosmos]') as HTMLElement | null;
        if (el) {
          el.dataset.fps = String(Math.round(c.frames / c.acc));
          el.dataset.frameP95 = sorted[Math.floor(sorted.length * 0.95)]?.toFixed(1) ?? '';
          el.dataset.calls = String(Math.round(gl.info.render.calls / Math.max(1, c.frames)));
          el.dataset.triangles = String(Math.round(gl.info.render.triangles / Math.max(1, c.frames)));
          gl.info.reset();
        }
        c.frames = 0; c.acc = 0; c.samples = [];
      } else if (c.frames === 1 && c.acc < 0.05) {
        gl.info.reset();
      }
    }
  });

  return (
    <>
      {sky && <primitive object={sky} />}
      {disc && <primitive object={disc} />}
      {orbits && <primitive object={orbits} />}
      <primitive object={cosmic.points} />
      <primitive object={cosmic.bulge} />
      <primitive object={backdrop.stars} />
      <primitive object={backdrop.dust} />
      {nebulae.map((n, i) => <primitive key={i} object={n} />)}
      <primitive object={stars.mesh} />
      <primitive object={lines} />
      {view.ghosts.length > 0 && <primitive object={ghostPoints} />}
      <primitive object={halo.mesh} />
      <OrbitControls ref={controls} makeDefault enableDamping={!reduced} dampingFactor={0.08} rotateSpeed={0.55} zoomSpeed={0.9} panSpeed={0.8}
        minDistance={6} maxDistance={UNIVERSE_RADIUS * 4} zoomToCursor screenSpacePanning onChange={() => invalidate()} />
    </>
  );
}

function curve(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, n: number, out: (p0: THREE.Vector3, p1: THREE.Vector3, u0: number, u1: number) => void) {
  const q = new THREE.QuadraticBezierCurve3(a, c, b);
  const pts = q.getPoints(n);
  for (let i = 0; i < n; i++) out(pts[i], pts[i + 1], i / n, (i + 1) / n);
}
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function buildBackdrop(graph: CosmosGraph, count: number, dustPerGalaxy: number) {
  const sp: number[] = [], sc: number[] = [];
  for (let i = 0; i < count; i++) {
    const u = hash01(`bg${i}`, 1) * 2 - 1, th = hash01(`bg${i}`, 2) * Math.PI * 2, r = 16000 + hash01(`bg${i}`, 3) * 6000;
    const s = Math.sqrt(1 - u * u);
    sp.push(Math.cos(th) * s * r, u * r, Math.sin(th) * s * r);
    const w = 0.35 + hash01(`bg${i}`, 4) * 0.4;
    sc.push(w * 0.85, w * 0.9, w);
  }
  const sm: Motion = { center: [], spin: [], tw: [] };
  for (let i = 0; i < count; i++) { sm.center.push(0, 0, 0, hash01(`bg${i}`, 5)); sm.spin.push(0, 1, 0, 0); sm.tw.push(0.12 + 0.38 * hash01(`bg${i}`, 6)); }
  const stars = new THREE.Points(decorGeom(sp, sc, sm), decorMaterial(1.6, 0.85, false));
  const dp: number[] = [], dc: number[] = [];
  const dm: Motion = { center: [], spin: [], tw: [] };
  for (const g of graph.galaxies) {
    if (!g.count || !dustPerGalaxy) continue;
    const col = new THREE.Color(GALAXIES[g.i].color);
    const arms = 2 + Math.floor(hash01(g.key, 9) * 2), twist = 2.6 + hash01(g.key, 8) * 1.6;
    const ax = tilt(g.i, { x: 0, y: 1, z: 0 }), al = Math.hypot(ax.x, ax.y, ax.z) || 1;
    for (let i = 0; i < dustPerGalaxy; i++) {
      const h = (k: number) => hash01(`${g.key}d${i}`, k);
      const bulge = i % 5 === 0;                                   // one fifth: the dense core (bulge)
      const t = bulge ? h(1) ** 2 * 0.28 : Math.sqrt(h(1));        // arms: more dust further out, thinner at the rim
      const arm = (Math.floor(h(4) * arms) / arms) * Math.PI * 2;
      const spread = (h(2) - 0.5) * (bulge ? Math.PI * 2 : 0.55 + t * 0.5);
      const a = arm + t * twist + spread, r = t * g.radius * 1.08 + 4;
      const p = tilt(g.i, { x: Math.cos(a) * r, y: (h(3) - 0.5) * g.radius * (bulge ? 0.16 : 0.05) * (1.2 - t), z: Math.sin(a) * r });
      dp.push(g.x + p.x, g.y + p.y, g.z + p.z);
      // a galaxy turns about its own axis: one pattern speed (arms keep their shape, density-wave style) plus a small differential
      dm.center.push(g.x, g.y, g.z, h(6)); dm.spin.push(ax.x / al, ax.y / al, ax.z / al, GALAXY_PATTERN + GALAXY_SHEAR * 0.2 / (t + 0.2));
      dm.tw.push(bulge ? 0.08 : 0.16);
      const w = (bulge ? 0.34 : 0.1 + 0.2 * (1 - t)) * (0.7 + h(5) * 0.6);
      const warm = Math.max(0, 1 - t * 2.2);                       // the core is whiter / warmer than the arms
      dc.push((col.r * (1 - warm) + 1.0 * warm) * w, (col.g * (1 - warm) + 0.92 * warm) * w, (col.b * (1 - warm) + 0.8 * warm) * w);
    }
  }
  const dust = new THREE.Points(decorGeom(dp, dc, dm), decorMaterial(1.8, 0.95, true));
  stars.frustumCulled = dust.frustumCulled = false;
  return { stars, dust };
}
/**
 * The vast structure the knowledge galaxies float above — DECORATION, never data (no star of it is pickable, labelled or
 * counted): a broad two-armed spiral field far below the galaxies' plane with a warm central bulge, and small distant galaxies
 * on the deep sky. One points draw + one quad; sized by the quality profile; static (no per-frame work).
 */
function buildCosmicStructure(count: number) {
  const R = UNIVERSE_RADIUS, cy = -R * 0.55;
  const p: number[] = [], c: number[] = [];
  const mo: Motion = { center: [], spin: [], tw: [] };
  const n0 = Math.hypot(1, 0.06), axis = [0, 1 / n0, -0.06 / n0];
  const arms = 2, twist = 5.2, discR = R * 3.4;
  const disc = Math.floor(count * 0.88);
  for (let i = 0; i < disc; i++) {
    const h = (k: number) => hash01(`cs${i}`, k);
    const bulge = i % 7 === 0;
    const t = bulge ? h(1) ** 1.6 * 0.22 : 0.06 + Math.sqrt(h(1)) * 0.94;
    const arm = (i % arms) * Math.PI;
    const spread = (h(2) - 0.5) * (bulge ? Math.PI * 2 : 0.34 + t * 0.6) + (h(6) - 0.5) * 0.25;
    const a = arm + Math.log(1 + t * 9) / Math.log(10) * twist + spread;
    const r = t * discR;
    const thick = (h(3) - 0.5) * (bulge ? R * 0.06 : R * 0.035) * (1.1 - t); // a thin disc: never a column seen from above
    // a slight tilt so the disc reads as a disc in perspective
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    p.push(x, cy + thick + z * 0.06, z);
    const warm = Math.max(0, 1 - t * 2.4), w = (bulge ? 0.32 : 0.06 + 0.16 * (1 - t)) * (0.6 + h(5) * 0.8);
    // arms: blue-violet, core: warm white; a few brighter knots (star-forming regions)
    const knot = !bulge && h(7) > 0.985 ? 2.2 : 1;
    c.push((0.55 + 0.45 * warm) * w * knot, (0.6 + 0.32 * warm) * w * knot, (0.95 - 0.2 * warm) * w * knot);
    mo.center.push(0, cy, 0, h(8)); mo.spin.push(axis[0], axis[1], axis[2], DISC_PATTERN + DISC_SHEAR * 0.15 / (t + 0.15));
    mo.tw.push(knot > 1 ? 0.35 : 0.14);
  }
  // distant galaxies on the deep sky: tiny tilted spirals far behind everything
  const far = count - disc, per = 70;
  for (let g = 0; g * per < far; g++) {
    const u = hash01(`fg${g}`, 1) * 2 - 1, th = hash01(`fg${g}`, 2) * Math.PI * 2, dist = 13000 + hash01(`fg${g}`, 3) * 5000, s = Math.sqrt(1 - u * u);
    const cx = Math.cos(th) * s * dist, cyy = u * dist * 0.6, cz = Math.sin(th) * s * dist, size = 180 + hash01(`fg${g}`, 4) * 260, tl = hash01(`fg${g}`, 5) * Math.PI;
    for (let k = 0; k < per; k++) {
      const t = Math.sqrt(hash01(`fg${g}:${k}`, 1)), a = (k % 2) * Math.PI + t * 4 + (hash01(`fg${g}:${k}`, 2) - 0.5) * 0.6;
      const lx = Math.cos(a) * t * size, ly = Math.sin(a) * t * size;
      p.push(cx + lx, cyy + ly * Math.cos(tl), cz + ly * Math.sin(tl));
      const w = 0.25 * (1 - t * 0.7);
      c.push(w * 0.9, w * 0.85, w);
      mo.center.push(cx, cyy, cz, hash01(`fg${g}:${k}`, 3)); mo.spin.push(0, 1, 0, 0); mo.tw.push(0.1);
    }
  }
  const points = new THREE.Points(decorGeom(p, c, mo), decorMaterial(1.7, 0.9, true));
  points.frustumCulled = false; points.renderOrder = -1;
  const bulge = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: NEB_VS,
    fragmentShader: 'varying vec2 vUv; void main(){ float r = length(vUv - 0.5) * 2.0; float a = exp(-r * r * 9.0) * 0.12 + exp(-r * r * 40.0) * 0.06; gl_FragColor = vec4(vec3(1.0, 0.86, 0.68) * a, a); }' }));
  bulge.position.set(0, cy, 0); bulge.scale.setScalar(R * 1.6); bulge.frustumCulled = false; bulge.renderOrder = -1;
  return { points, bulge };
}
/**
 * The galactic disc under the knowledge galaxies — DECORATION (never pickable, labelled or counted). One quad lying in the same
 * slightly tilted plane as the spiral point field, shaded procedurally: a warm bulge, two logarithmic arms that match the point
 * field's twist, darker dust lanes on the inner edge of each arm, a fine grain of unresolved stars and a few pink star-forming
 * knots. Static: no uniform changes per frame; grain fades out where it would alias (fwidth).
 */
function buildGalacticDisc(octaves: number) {
  const R = UNIVERSE_RADIUS, discR = R * 3.4;
  const m = new THREE.ShaderMaterial({ uniforms: { uOct: { value: Math.max(2, Math.min(5, octaves)) }, uTime: { value: 0 }, uMotion: { value: 1 }, uPattern: { value: DISC_PATTERN }, uShear: { value: DISC_SHEAR } }, vertexShader: DISC_VS, fragmentShader: DISC_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
  mesh.rotation.x = -Math.PI / 2 + Math.atan(0.06); // the point field rises by 0.06 per unit of z
  mesh.position.set(0, -R * 0.55, 0);
  mesh.scale.setScalar(discR * 1.05);
  mesh.frustumCulled = false; mesh.renderOrder = -2;
  return mesh;
}
const DISC_VS = /* glsl */ `
varying vec2 vP;
void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const DISC_FS = /* glsl */ `
uniform float uOct; uniform float uTime; uniform float uMotion; uniform float uPattern; uniform float uShear;
varying vec2 vP;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int k = 0; k < 5; k++) { if (float(k) >= uOct) break; v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
void main() {
  // plane coordinates: x, -z of the disc (the mesh is rotated onto the disc); same spiral law as the point field
  vec2 uv = vec2(vP.x, -vP.y);
  float r = length(uv);
  if (r > 1.0) discard;
  float th = atan(uv.y, uv.x);
  float t = clamp(r / 0.9524, 0.0, 1.0); // point field: r = t * discR, quad radius = 1.05 * discR
  // the arm pattern turns as a whole (pattern speed, like a density wave); the stars move at their own, radius-dependent speed
  float tm = uTime * uMotion;
  vec2 uvStars = r * vec2(cos(th + tm * (uPattern + uShear * 0.15 / (t + 0.15))), sin(th + tm * (uPattern + uShear * 0.15 / (t + 0.15))));
  th += tm * uPattern;
  float spiral = log(1.0 + t * 9.0) / log(10.0) * 5.2;
  float ph = th - spiral;
  float arm = pow(0.5 + 0.5 * cos(2.0 * ph), 4.0);
  float lane = pow(0.5 + 0.5 * cos(2.0 * ph + 0.55), 14.0);             // dust lane on the inner edge of each arm
  float n = fbm(uvStars * 9.0 + vec2(ph * 0.6, 0.0));
  float clouds = smoothstep(0.25, 0.85, n);
  float disc = exp(-r * 2.4) * (1.0 - smoothstep(0.8, 1.0, r));
  float core = exp(-r * r * 260.0) * 0.9 + exp(-r * r * 40.0) * 0.18;
  // unresolved stars: a fine grain, faded where a cell is smaller than a pixel (no shimmer)
  vec2 cell = uvStars * 520.0;
  float aa = clamp(1.0 - length(fwidth(cell)) * 0.9, 0.0, 1.0);
  float g = hash(floor(cell));
  float grain = step(0.988, g) * smoothstep(0.42, 0.0, length(fract(cell) - 0.5)) * aa;
  float body = disc * (0.08 + 0.92 * arm * (0.45 + 0.55 * clouds)) * (1.0 - 0.75 * lane * smoothstep(0.08, 0.3, r));
  vec3 warm = vec3(1.0, 0.82, 0.6), blue = vec3(0.55, 0.68, 1.0), pink = vec3(1.0, 0.5, 0.72);
  vec3 col = mix(warm, blue, smoothstep(0.04, 0.3, r)) * body * 0.42;
  col += warm * core * 0.35;
  col += mix(vec3(0.85, 0.9, 1.0), warm, 1.0 - smoothstep(0.0, 0.4, r)) * grain * disc * (0.5 + arm) * 1.6;
  float knot = step(0.9965, hash(floor(uvStars * 140.0) + 7.0)) * arm * smoothstep(0.15, 0.5, r) * disc;
  grain *= 0.75 + 0.25 * sin(tm * 2.3 + g * 40.0);  // unresolved stars twinkle
  col += pink * knot * 0.9 * aa;
  float a = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  gl_FragColor = vec4(col, a);
}`;

// ── decoration motion (no per-frame CPU work: every point turns and twinkles in the vertex shader) ──────────────────
/** Pattern speeds (rad/s): the big disc turns once in ~8 min, a knowledge galaxy's dust once in ~2.5 min; the shear is the
 *  small extra speed of inner orbits. Reduced motion sets uMotion = 0: everything rests at its built position. */
const DISC_PATTERN = (2 * Math.PI) / 480, DISC_SHEAR = 0.004, GALAXY_PATTERN = (2 * Math.PI) / 150, GALAXY_SHEAR = 0.006;
interface Motion { center: number[]; spin: number[]; tw: number[] }
function decorGeom(p: number[], c: number[], m: Motion) {
  const g = geom(p, c);
  g.setAttribute('aCenter', new THREE.Float32BufferAttribute(m.center, 4));
  g.setAttribute('aSpin', new THREE.Float32BufferAttribute(m.spin, 4));
  g.setAttribute('aTw', new THREE.Float32BufferAttribute(m.tw, 1));
  return g;
}
function decorMaterial(size: number, opacity: number, additive: boolean) {
  return new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uMotion: { value: 1 }, uSize: { value: size }, uDpr: { value: 1 }, uOpacity: { value: opacity } },
    vertexShader: DECOR_VS, fragmentShader: DECOR_FS, vertexColors: true, transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
}
/** Orbits of a star system's members around its centre: the circle each star already sits on (its height and distance about the
 *  system's axis, in the galaxy's tilted frame), with a light travelling along it at a Kepler-like speed (inner orbits faster). */
function buildOrbits(graph: CosmosGraph, system: number) {
  const s = graph.systems[system];
  if (!s || s.count < 2) return null;
  const p: number[] = [], t: number[] = [], w: number[] = [], ph: number[] = [];
  const SEG = 96;
  for (const n of graph.nodes) {
    if (n.system !== system || n.i === s.center || n.kind === 'concept') continue;
    const L = untilt(n.galaxy, { x: n.x - s.x, y: n.y - s.y, z: n.z - s.z });
    const R = Math.hypot(L.x, L.z);
    if (R < 0.5) continue;
    const start = Math.atan2(L.z, L.x), omega = 0.55 * Math.pow(6 / R, 1.5);
    const at = (k: number) => { const a = start + (k / SEG) * Math.PI * 2; const q = tilt(n.galaxy, { x: Math.cos(a) * R, y: L.y, z: Math.sin(a) * R }); return [s.x + q.x, s.y + q.y, s.z + q.z]; };
    for (let k = 0; k < SEG; k++) {
      p.push(...at(k), ...at(k + 1)); t.push(k / SEG, (k + 1) / SEG); w.push(omega, omega); ph.push(hash01(n.id, 11), hash01(n.id, 11));
    }
  }
  if (!p.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
  g.setAttribute('aW', new THREE.Float32BufferAttribute(w, 1));
  g.setAttribute('aPh', new THREE.Float32BufferAttribute(ph, 1));
  const m = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uMotion: { value: 1 }, uColor: { value: new THREE.Color(s.color) } },
    vertexShader: ORBIT_VS, fragmentShader: ORBIT_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const lines = new THREE.LineSegments(g, m);
  lines.frustumCulled = false; lines.renderOrder = 1;
  return lines;
}
const DECOR_VS = /* glsl */ `
attribute vec4 aCenter; attribute vec4 aSpin; attribute float aTw;
uniform float uTime; uniform float uMotion; uniform float uSize; uniform float uDpr;
varying vec3 vCol; varying float vB;
vec3 rot(vec3 v, vec3 k, float a) { float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
void main() {
  vec3 p = position;
  if (aSpin.w != 0.0) p = aCenter.xyz + rot(position - aCenter.xyz, aSpin.xyz, aSpin.w * uTime * uMotion);
  float seed = aCenter.w;
  vB = 1.0 + aTw * uMotion * sin(uTime * (0.6 + seed * 2.2) + seed * 61.0) * sin(uTime * (0.37 + seed) + seed * 17.0);
  vCol = color;
  gl_PointSize = uSize * uDpr * (0.85 + 0.3 * vB);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const DECOR_FS = /* glsl */ `
uniform float uOpacity;
varying vec3 vCol; varying float vB;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float a = 1.0 - r * r;
  gl_FragColor = vec4(vCol * vB, a * uOpacity);
}`;
const ORBIT_VS = /* glsl */ `
attribute float aT; attribute float aW; attribute float aPh;
varying float vT; varying float vW; varying float vPh;
void main() { vT = aT; vW = aW; vPh = aPh; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ORBIT_FS = /* glsl */ `
uniform float uTime; uniform float uMotion; uniform vec3 uColor;
varying float vT; varying float vW; varying float vPh;
void main() {
  float head = fract(vPh + uTime * vW / 6.2832);
  float d = fract(vT - head + 1.0);                      // distance behind the travelling light, along the orbit
  float glint = (smoothstep(0.0, 0.004, d) * smoothstep(0.09, 0.0, d)) * uMotion;
  float a = 0.12 + glint * 0.85;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), glint * 0.6) * a, a);
}`;

function geom(p: number[], c: number[]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  return g;
}

// ── shaders ───────────────────────────────────────────────────────────────────────────────────────────────────────
const STAR_VS = /* glsl */ `
attribute vec3 iPos; attribute vec3 iColor; attribute float iSize; attribute float iAlpha; attribute float iScale; attribute float iFlag; attribute float iMem;
uniform float uPixel;
varying vec2 vUv; varying vec3 vColor; varying float vAlpha; varying float vFlag; varying float vMem; varying float vPhase;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float dist = -mv.z;
  float s = max(iSize * iScale * 1.6, dist * uPixel * (2.5 + iSize));
  s = min(s, dist * (mod(iFlag, 2.0) >= 1.0 ? 0.038 : 0.026)); // never a giant disc up close (≈ 22–33 px)
  if (iAlpha < 0.01) s = 0.0;
  mv.xy += position.xy * s * (mod(iFlag, 32.0) >= 16.0 ? 0.8 : 1.0);
  vUv = position.xy; vColor = iColor; vAlpha = iAlpha; vFlag = iFlag; vMem = iMem; vPhase = fract(iPos.x * 0.0137 + iPos.z * 0.0071 + iPos.y * 0.0031);
  gl_Position = projectionMatrix * mv;
}`;
const STAR_FS = /* glsl */ `
uniform float uTime; uniform float uMotion;
varying vec2 vUv; varying vec3 vColor; varying float vAlpha; varying float vFlag; varying float vMem; varying float vPhase;
bool has(float f, float bit) { return mod(floor(f / bit), 2.0) == 1.0; }
bool is(float m, float code) { return abs(m - code) < 0.5; }
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float core = exp(-r * r * 26.0);
  float halo = exp(-r * r * 5.0) * 0.45;
  vec3 col = vColor * (halo + core * 1.4) + vec3(core * 0.6);
  float a = (core + halo);
  // memory state (memory.ts): from the learner's own evidence; calm, never a blink
  float m = mod(vMem, 16.0);
  float grey = dot(col, vec3(0.3333));
  if (is(m, 1.0)) { col = mix(vec3(grey), vColor, 0.35) * core * 1.2; a = core * 0.85; }            // met: a small, cool point, no halo
  else if (is(m, 2.0)) {                                                                               // new: brighter, a slow soft breath
    float b = 0.5 + 0.5 * sin(uTime * 1.2 + vPhase * 6.2832) * uMotion;
    col += vColor * halo * (0.55 + 0.35 * b) + vec3(core * 0.25); a += halo * (0.35 + 0.25 * b);
  } else if (is(m, 3.0)) {                                                                             // recently reinforced: a renewed pulse every ~5 s
    float ph = fract(uTime * 0.2 + vPhase);
    float w = smoothstep(0.07, 0.0, abs(r - 0.25 - ph * 0.6)) * (1.0 - ph) * uMotion;
    col += vec3(0.78, 0.94, 1.0) * w * 0.8; a += w * 0.55;
  } else if (is(m, 10.0)) {                                                                            // reactivated after a long silence: a slow glow that swells back
    float g = 0.5 + 0.5 * sin(uTime * 0.7 + vPhase * 6.2832) * uMotion;
    float shell = smoothstep(0.12, 0.0, abs(r - 0.42)) * (0.35 + 0.4 * g);
    col += vec3(0.7, 1.0, 0.86) * (shell + halo * 0.4 * g); a += shell * 0.6 + halo * 0.25 * g;
  } else if (is(m, 5.0)) {                                                                             // stable: crisp, settled, warm-white core
    col = vColor * (halo * 0.55 + core * 1.5) + vec3(1.0, 0.95, 0.84) * core * 0.75; a = core * 1.25 + halo * 0.55;
  } else if (is(m, 6.0)) { col = mix(vec3(grey), col, 0.45) * 0.85; }                                 // fading: desaturated, softer
  else if (is(m, 7.0)) {                                                                               // at risk: dim, a slow uneven shimmer
    float tw = 0.8 + 0.2 * sin(uTime * 0.9 + vPhase * 17.0) * sin(uTime * 0.53 + vPhase * 7.0) * uMotion;
    col = mix(vec3(grey), col, 0.3) * tw; a *= tw;
  }
  if (!is(m, 5.0) && !is(m, 7.0)) { // scintillation: every star twinkles a little; a stable star stays steady, an at-risk one has its own shimmer
    float sc = 1.0 + 0.11 * uMotion * sin(uTime * (1.9 + vPhase * 2.7) + vPhase * 53.0) * sin(uTime * (1.1 + vPhase) + vPhase * 19.0);
    col *= sc; a *= mix(1.0, sc, 0.6);
  }
  if (vMem >= 16.0) { float ring = smoothstep(0.05, 0.0, abs(r - 0.64)); col += vec3(1.0, 0.82, 0.45) * ring * 0.55; a += ring * 0.4; } // cross-skill: a gold ring
  if (has(vFlag, 16.0)) { // concept: a hollow, dim ring (a group centre, not a learned word)
    float ring = smoothstep(0.16, 0.0, abs(r - 0.55));
    col = vColor * ring * 0.8; a = ring * 0.7;
  }
  if (has(vFlag, 4.0)) { // memory nebula: the learner's last rating was "Khó" — a soft violet haze
    float haze = exp(-r * r * 2.2) * 0.35;
    col += vec3(0.62, 0.48, 1.0) * haze; a += haze;
  }
  if (has(vFlag, 8.0)) { // knowledge black hole: dark centre, bright thin rim
    float dark = smoothstep(0.32, 0.12, r);
    float rim = smoothstep(0.1, 0.0, abs(r - 0.36)) * 1.2;
    col = col * (1.0 - dark) + vec3(1.0, 0.72, 0.4) * rim; a = max(a * (1.0 - dark * 0.9), rim);
  }
  if (has(vFlag, 64.0)) { // fresh: discovered since the last visit / during this one — a slow ring leaves the star
    float ph = fract(uTime * 0.4);
    float wave = smoothstep(0.08, 0.0, abs(r - 0.2 - ph * 0.75)) * (1.0 - ph);
    col += vec3(1.0, 0.93, 0.72) * wave; a += wave;
  }
  if (has(vFlag, 128.0)) { // due by the Flashcards schedule (its stored date has passed): a warm ring that breathes slowly
    float b = 0.65 + 0.35 * sin(uTime * 1.5 + vPhase * 6.2832) * uMotion;
    float ring = smoothstep(0.055, 0.0, abs(r - 0.74)) * b;
    col += vec3(1.0, 0.7, 0.26) * ring * 0.95; a += ring * 0.7;
  }
  if (has(vFlag, 1.0)) { // selected: a calm ring
    float ring = smoothstep(0.06, 0.0, abs(r - 0.82 - 0.03 * sin(uTime * 2.0)));
    col += vec3(0.9, 0.97, 1.0) * ring; a += ring;
  }
  gl_FragColor = vec4(col * vAlpha, a * vAlpha);
}`;
const LINE_VS = /* glsl */ `
attribute vec4 aColor; attribute float aT; attribute float aMode;
varying vec4 vColor; varying float vT; varying float vMode;
void main() { vColor = aColor; vT = aT; vMode = aMode; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const LINE_FS = /* glsl */ `
uniform float uTime; uniform float uMotion;
varying vec4 vColor; varying float vT; varying float vMode;
void main() {
  float a = vColor.a;
  if (vMode > 2.5 && vMode < 3.5) { if (fract(vT * 14.0) > 0.5) discard; a *= 0.8; }
  float pulse = 0.0;
  if (uMotion > 0.5) {
    if (vMode > 0.5 && vMode < 1.5) pulse = smoothstep(0.12, 0.0, abs(fract(vT - uTime * 0.35) - 0.5));        // directed: travels source → target
    else if (vMode > 1.5 && vMode < 2.5) pulse = 0.35 * smoothstep(0.2, 0.0, abs(fract(vT * 2.0 + uTime * 0.12) - 0.5));
    else if (vMode > 3.5) pulse = smoothstep(0.1, 0.0, abs(fract(vT * 3.0 - uTime * 0.5) - 0.5));
  }
  gl_FragColor = vec4(vColor.rgb * (0.65 + pulse * 1.4), a * (0.6 + pulse));
}`;
// A faint galactic band and two distant nebula clouds on the inside of a far sphere: depth and orientation, never data.
const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  // rotation only (the sky does not move with the camera), placed just inside the far end of the depth range
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99995, p.w);
}`;
const SKY_FS = /* glsl */ `
uniform float uOct;
varying vec3 vDir;
float h(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float n(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y), f.z); }
void main() {
  vec3 d = normalize(vDir);
  float v = 0.0, amp = 0.5; vec3 q = d * 3.0;
  for (int i = 0; i < 5; i++) { if (float(i) >= uOct) break; v += amp * n(q); q *= 2.07; amp *= 0.5; }
  float band = exp(-pow(dot(d, normalize(vec3(0.25, 1.0, -0.35))) * 3.2, 2.0));
  vec3 deep = vec3(0.006, 0.01, 0.028);
  vec3 col = deep + vec3(0.05, 0.065, 0.15) * band * pow(v, 1.6) * 0.8 + vec3(0.12, 0.05, 0.16) * pow(v, 3.0) * band * 0.55
           + vec3(0.02, 0.07, 0.1) * smoothstep(0.6, 0.92, v) * (1.0 - band) * 0.35;
  gl_FragColor = vec4(col, 1.0);
}`;
const NEB_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  mv.xy += position.xy * scale;
  gl_Position = projectionMatrix * mv;
}`;
const NEB_FS = /* glsl */ `
uniform vec3 uColor; uniform float uSeed; uniform float uOct;
varying vec2 vUv;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }
float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;
  float v = 0.0, amp = 0.5; vec2 q = p * 3.0;
  for (int i = 0; i < 5; i++) { if (float(i) >= uOct) break; v += amp * n(q); q *= 2.03; amp *= 0.5; }
  float fall = smoothstep(1.0, 0.15, r);
  float core = exp(-r * r * 110.0) * 0.7 + exp(-r * r * 22.0) * 0.12 + exp(-r * r * 6.0) * 0.04; // every profile: the core (Lite has no noise)
  float a = fall * v * v * 0.2 + core;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), core * 0.6) * a, a);
}`;
