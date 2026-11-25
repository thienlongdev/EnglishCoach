import * as THREE from 'three';
import { BODY, HANDLE, PLINTH, TROPHY_HEIGHT, type P2 } from './trophyShape';

/**
 * The Echo Hall trophy in real time: a gold lathe cup on a lapis plinth, two handles, a sapphire, two halo rings, lit by a
 * small painted "hall" environment (sapphire, violet and warm gold panels) so the gold reflects the room it stands in.
 * Procedural geometry only (no model download). Loaded in its own chunk after the page is interactive.
 *
 * Cost rules: one WebGL context, ≤ 2× pixel ratio, rendering only while the hero is on screen and the tab is visible
 * (`setActive`), at most ~45 frames a second; `still` renders single frames (reduced motion) and never loops.
 * `dispose` releases every geometry, material, the environment texture and the context.
 */
export interface TrophyHandle {
  setActive(active: boolean): void;
  setPointer(x: number, y: number): void;
  dispose(): void;
}

export interface TrophyOptions {
  still: boolean;
  /** Called once, after the first frame is on the canvas (the page then fades the still picture out). */
  onFirstFrame?: () => void;
  /** The context was lost: the page shows the still picture again. */
  onLost?: () => void;
}

const lathe = (pts: readonly P2[], seg = 96) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);

function hallEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const env = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.MeshBasicMaterial({ color: 0x8a6f86, side: THREE.BackSide }));
  env.add(room);
  const panel = (color: number, power: number, pos: [number, number, number], size: [number, number]) => {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), side: THREE.DoubleSide });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), m);
    p.position.set(...pos);
    p.lookAt(0, 1, 0);
    env.add(p);
  };
  panel(0xfff1d6, 7, [-3.5, 4, 4], [4, 3]); // warm key from the window
  panel(0xffc970, 4, [0, 7, -2], [6, 2]); // gold vault
  panel(0x5aa8ff, 4, [-5, 1.5, -2], [2.5, 5]); // sapphire side
  panel(0xa070ff, 4, [5, 1.8, -1.5], [2.5, 5]); // violet side
  panel(0xffffff, 2.5, [4, 2, 5], [2, 2]); // small sparkle source
  panel(0xffc98a, 2.2, [0, -3, 3], [8, 2]); // warm floor bounce
  panel(0xffe3b0, 6, [0, 2.4, 7], [12, 5]); // the hall behind the viewer: what the bowl's face mirrors
  panel(0xffd27a, 3, [-6, 0.5, 4], [3, 3]); // warm side lamp
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.035).texture;
  pmrem.dispose();
  env.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  return tex;
}

export function mountTrophy(canvas: HTMLCanvasElement, opts: TrophyOptions): TrophyHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const envTex = hallEnvironment(renderer);
  scene.environment = envTex;

  const gold = new THREE.MeshPhysicalMaterial({ color: 0xffc35c, metalness: 1, roughness: 0.24, clearcoat: 0.6, clearcoatRoughness: 0.08, envMapIntensity: 1.6, side: THREE.DoubleSide });
  const goldBright = new THREE.MeshPhysicalMaterial({ color: 0xffe0a0, metalness: 1, roughness: 0.12, envMapIntensity: 1.7 });
  const lapis = new THREE.MeshPhysicalMaterial({ color: 0x0e2280, metalness: 0.15, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.1, side: THREE.DoubleSide });
  const sapphire = new THREE.MeshPhysicalMaterial({ color: 0x4f8bff, emissive: 0x1e4fff, emissiveIntensity: 0.9, metalness: 0, roughness: 0.04, clearcoat: 1, envMapIntensity: 2 });
  const haloGold = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  const haloCyan = new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });

  const geos: THREE.BufferGeometry[] = [];
  const keep = <G extends THREE.BufferGeometry>(g: G) => { geos.push(g); return g; };
  const trophy = new THREE.Group();
  trophy.add(new THREE.Mesh(keep(lathe(PLINTH)), lapis));
  trophy.add(new THREE.Mesh(keep(lathe(BODY)), gold));
  const rim = (r: number, y: number, t: number, m: THREE.Material) => {
    const ring = new THREE.Mesh(keep(new THREE.TorusGeometry(r, t, 12, 96)), m);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = y;
    trophy.add(ring);
  };
  rim(0.64, 0.03, 0.025, gold);
  rim(0.62, 0.29, 0.022, gold);
  rim(0.2, 0.925, 0.03, goldBright);
  rim(0.79, 2.1, 0.022, goldBright);
  const curve = new THREE.CatmullRomCurve3(HANDLE.map(([x, y]) => new THREE.Vector3(x, y, 0)));
  const handleGeo = keep(new THREE.TubeGeometry(curve, 48, 0.045, 12, false));
  for (const s of [1, -1]) {
    const h = new THREE.Mesh(handleGeo, gold);
    h.scale.x = s;
    trophy.add(h);
  }
  const gem = new THREE.Mesh(keep(new THREE.OctahedronGeometry(0.13, 0)), sapphire);
  gem.scale.set(0.8, 1.25, 0.5);
  gem.position.set(0, 1.66, 0.68);
  trophy.add(gem);
  const gemSet = new THREE.Mesh(keep(new THREE.TorusGeometry(0.15, 0.02, 10, 48)), goldBright);
  gemSet.position.set(0, 1.66, 0.665);
  gemSet.rotation.x = -0.08;
  trophy.add(gemSet);
  const orb = new THREE.Mesh(keep(new THREE.OctahedronGeometry(0.1, 0)), sapphire);
  orb.scale.set(0.9, 1.5, 0.9);
  orb.position.set(0, 2.42, 0);
  trophy.add(orb);

  const halos = new THREE.Group();
  const haloA = new THREE.Mesh(keep(new THREE.TorusGeometry(1.32, 0.008, 6, 160)), haloGold);
  const haloB = new THREE.Mesh(keep(new THREE.TorusGeometry(1.5, 0.005, 6, 160)), haloCyan);
  haloA.rotation.x = Math.PI / 2 - 0.32;
  haloB.rotation.set(Math.PI / 2 - 0.2, 0.25, 0);
  halos.add(haloA, haloB);
  halos.position.y = 1.35;

  const root = new THREE.Group();
  root.add(trophy, halos);
  scene.add(root);
  const key = new THREE.DirectionalLight(0xfff0d8, 1.4);
  key.position.set(-2, 4, 4);
  scene.add(key);
  const rimLight = new THREE.PointLight(0x9a7bff, 8, 10);
  rimLight.position.set(2.5, 2.2, -1.5);
  scene.add(rimLight);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 1.45, 6.4);
  camera.lookAt(0, TROPHY_HEIGHT / 2 + 0.1, 0);

  let w = 0;
  let h = 0;
  const resize = () => {
    const box = canvas.parentElement?.getBoundingClientRect();
    const nw = Math.max(1, Math.round(box?.width ?? canvas.clientWidth));
    const nh = Math.max(1, Math.round(box?.height ?? canvas.clientHeight));
    if (nw === w && nh === h) return false;
    w = nw;
    h = nh;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    return true;
  };

  const target = { x: 0, y: 0 };
  const tilt = { x: 0, y: 0 };
  let raf = 0;
  let active = false;
  let disposed = false;
  let first = true;
  let last = 0;
  let t = 0;
  const start = performance.now();

  const pose = (time: number, dt: number) => {
    const intro = Math.min(1, (time - start) / 1400);
    const ease = 1 - Math.pow(1 - intro, 3);
    tilt.x += (target.x - tilt.x) * Math.min(1, dt * 3);
    tilt.y += (target.y - tilt.y) * Math.min(1, dt * 3);
    t += dt;
    trophy.rotation.y = opts.still ? 0.45 : 0.45 + t * 0.38;
    root.position.y = (opts.still ? 0 : Math.sin(t * 1.1) * 0.05) + (1 - ease) * 0.7;
    root.rotation.x = tilt.y * 0.1;
    root.rotation.z = -tilt.x * 0.07;
    haloA.rotation.z = t * 0.5;
    haloB.rotation.z = -t * 0.32;
    gem.rotation.y = -trophy.rotation.y; // the sapphire keeps its face lit
  };

  const draw = () => {
    renderer.render(scene, camera);
    if (first) {
      first = false;
      opts.onFirstFrame?.();
    }
  };

  const loop = (now: number) => {
    raf = 0;
    if (!active || disposed || document.hidden) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    if (now - last >= 21) {
      last = now;
      pose(now, dt);
      draw();
    }
    raf = requestAnimationFrame(loop);
  };

  const ro = new ResizeObserver(() => {
    if (resize() && (opts.still || !active)) {
      pose(performance.now(), 0);
      draw();
    }
  });
  if (canvas.parentElement) ro.observe(canvas.parentElement);

  const onVisibility = () => {
    if (disposed || opts.still) return;
    if (document.hidden) {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    } else if (active && !raf) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const onLost = (e: Event) => {
    e.preventDefault();
    active = false;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    opts.onLost?.();
  };
  canvas.addEventListener('webglcontextlost', onLost);

  resize();
  if (opts.still) {
    // the settled pose, one frame
    t = 0;
    pose(start + 5000, 0);
    draw();
  }

  return {
    setActive(next) {
      if (disposed || opts.still) return;
      if (next === active) return;
      active = next;
      if (!active && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (active && !raf && !document.hidden) {
        last = 0;
        raf = requestAnimationFrame(loop);
      }
    },
    setPointer(x, y) {
      target.x = Math.max(-1, Math.min(1, x));
      target.y = Math.max(-1, Math.min(1, y));
    },
    dispose() {
      disposed = true;
      active = false;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      geos.forEach((g) => g.dispose());
      [gold, goldBright, lapis, sapphire, haloGold, haloCyan].forEach((m) => m.dispose());
      envTex.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
