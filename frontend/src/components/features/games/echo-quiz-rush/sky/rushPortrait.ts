import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CHARACTER_LOOKS, SkyCharacter, type RushHero } from './skyCharacter';
import { loadCastArt } from './skyAssets';

/**
 * Portraits for the hero cards, drawn from the very body a real player races in: the cast of the Study Space and the Arena, in the clothes the player
 * chose there (`lib/avatar/look.ts`). One small renderer draws them one after the other into a still and is released when there is nothing left to
 * draw: the lobby never keeps a second live 3D scene. A portrait is drawn once per hero and outfit for the visit.
 */
const W = 320, H = 430;
const done = new Map<string, Promise<string | null>>();
let chain: Promise<unknown> = Promise.resolve();
let kit: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; env: THREE.Texture } | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;

function rig() {
  if (kit) return kit;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .95;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), .04).texture;
  pmrem.dispose();
  scene.environment = env; scene.environmentIntensity = .7;
  scene.add(new THREE.HemisphereLight(0xdfeeff, 0x6c7a62, 1.1));
  const key = new THREE.DirectionalLight(0xfff1df, 2.3); key.position.set(-1.6, 3, -2.6); scene.add(key);
  const rim = new THREE.DirectionalLight(0xbfe6ff, 1.2); rim.position.set(2.2, 2.4, 2.4); scene.add(rim);
  const camera = new THREE.PerspectiveCamera(24, W / H, .05, 30);
  kit = { renderer, scene, camera, env };
  return kit;
}
function release() {
  if (!kit) return;
  kit.env.dispose(); kit.renderer.dispose(); kit.renderer.forceContextLoss();
  kit = null;
}

async function draw(hero: RushHero, avatar: string): Promise<string | null> {
  const art = await loadCastArt(hero);
  if (!art) return null;
  const { renderer, scene, camera } = rig();
  const body = new SkyCharacter(art, CHARACTER_LOOKS[0], 0, null, { hero, avatar });
  try {
    await body.dressed;
    scene.add(body.root);
    // Standing at rest, the way the lobby shows the chosen hero: the clip settles before the still is taken.
    for (let i = 0; i < 45; i++) body.animate({ phase: 'COUNTDOWN', phaseTime: 1, travel: 0, speed: 0, vx: 0, dt: 1 / 30, time: i / 30, dashing: false, rushing: false, momentum: 0, reduced: false, airborne: false, vz: 0, heading: 0 });
    body.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(body.root), size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    const height = Math.max(1, size.y);
    // Three-quarter view from the front (the body faces −Z), the whole figure with a little air above the head.
    const angle = .38, dist = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.02;
    camera.position.set(mid.x + Math.sin(angle) * dist, mid.y + height * .06, mid.z - Math.cos(angle) * dist);
    camera.lookAt(mid.x, mid.y + height * .02, mid.z);
    renderer.render(scene, camera);
    const blob = await new Promise<Blob | null>(r => renderer.domElement.toBlob(r, 'image/webp', .9));
    return blob ? URL.createObjectURL(blob) : null;
  } finally {
    scene.remove(body.root);
    body.dispose();
  }
}

/** The portrait of `hero` dressed as `avatar` (an object URL), or null where no 3D is possible: the card then shows its still. */
export function heroPortrait(hero: RushHero, avatar: string): Promise<string | null> {
  const id = `${hero}:${avatar}`;
  let p = done.get(id);
  if (!p) {
    if (idle) { clearTimeout(idle); idle = null; }
    p = chain.then(() => draw(hero, avatar)).catch(() => null);
    chain = p.finally(() => { if (idle) clearTimeout(idle); idle = setTimeout(release, 1500); });
    done.set(id, p);
  }
  return p;
}
