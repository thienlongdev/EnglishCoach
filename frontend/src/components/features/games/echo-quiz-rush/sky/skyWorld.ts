import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SkyEnvironment, createPalette, palette } from './skyEnvironment';
import { SkyTrack } from './skyTrack';
import { SkyEffects } from './skyEffects';
import { SkyEcho } from './skyEcho';
import { SkyHazards } from './skyHazards';
import { KnowledgeWall, PendingWall, disposeGateCaches, setWallMotionArt, type WallKind } from './skyGates';
import { SkyOrbs } from './skyOrbs';
import { approach as wallApproach, plane as wallPlane, shutter as wallShutter, slide as wallSlide, type Orb, type Wall6 } from '../rushReforged';
import { SkyRunner, RUNNER_LOOKS, disposeRunnerGeometries, type RunnerPose } from './skyRunner';
import { SkyCharacter, CHARACTER_LOOKS, disposeCharacterPalettes, type RushHero } from './skyCharacter';
import { castArt, loadCastArt } from './skyAssets';
import { loadKai, loadSkyArt, skyArt, type SkyArt } from './skyAssets';
import { LANE_COLORS, SCENE, laneX, toX, toZ, wallZ } from './skyScale';
import type { Hazard } from '../rushTrials';
import type { RushMoment } from '../rushModel';
import { faceHeading } from '../rushNet';

export type Quality = 'high' | 'medium' | 'low';
export interface WorldRacer {
  id: string; name: string; x: number; y: number; vx: number; speed: number; phase: string; phaseTime: number;
  connected: boolean; checkpoint: number; effect: string; streak: number; look: number;
  /** The racer's chosen hero (cosmetic only; never part of the simulation). Missing = Lyra. */
  hero?: RushHero;
  /** What a real player wears (`lib/avatar/look.ts`). Missing: an Echo bot, in the Skybound runner. */
  avatar?: string;
  /** Version 5: height above the road (race z units) and remaining protection. */
  z?: number; guard?: number;
  /** Version 7: height of the walking surface under the runner (scene metres; the leaning deck of a Tilting Road). */
  ground?: number;
  /** Version 6: forward velocity (units/s) — with vx it turns the runner to face where they really go. */
  vy?: number;
}
/** `walls` are resting planes; version 6 adds each wall's motion and the course's orbs. */
/** `open` (version 7): no railing anywhere — every road edge is a real drop. */
export interface WorldCourse { total: number; walls: number[]; finish: number; spacing: number; hazards?: Hazard[]; rising?: boolean[]; motion?: Wall6[]; orbs?: Orb[]; open?: boolean }
export interface WorldFrame {
  mode: 'race' | 'attract' | 'celebrate';
  now: number; dt: number; reduced: boolean;
  /** Race clock (seconds since GO): every obstacle is posed from it. */
  clock?: number;
  course: WorldCourse;
  local: WorldRacer & { gates: number; openGate: number; rejected: number; dashing: boolean; rushing: boolean; vz?: number; sill?: number; shield?: number; boosted?: boolean; taken?: number[] };
  question: { id: string; labels: string[]; monospace: boolean } | null;
  tried: number[]; aim: number;
  /** Version 6: the door the player marked (a reading aid). */
  marked?: number;
  /** `plane`: where a passed wall was crossed (a moving wall stays there for its own racer). */
  passed: { checkpoint: number; gates: number; openGate: number; plane?: number }[];
  remotes: WorldRacer[];
  /** Physical moments of the local racer this frame (from the simulation). */
  moments?: RushMoment[];
}
export type WorldEvent = 'correct' | 'wrong' | 'post' | 'dash' | 'rush' | 'pass' | 'finish' | 'footstep' | 'streak';

/** An angle in (−π, π]. */
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
interface RunnerLike { root: THREE.Group; animate(p: RunnerPose & { airborne?: boolean; vz?: number; heading?: number }): void; setGhost(v: number): void; dispose(): void;
  eyes?(out: THREE.Vector3): THREE.Vector3 | null; setOwnView?(on: boolean): void; readonly hasOwnView?: boolean }
/** The player's camera in a race: behind the runner, or through the runner's own eyes. Only the drawing changes, never the race. */
export type RushView = 'third' | 'first';
interface WallSlot { checkpoint: number; real: KnowledgeWall | null; pending: PendingWall | null; questionId: string; riseStart: number; plinth: THREE.Object3D | null }
interface RemoteSlot { runner: RunnerLike; plate: THREE.Sprite; plateKey: string; lastZ: number; lastX: number; effect: THREE.Mesh | null; effectKind: string; look: number; art: string; heading: number }

export function detectQuality(): Quality {
  if (typeof window === 'undefined') return 'medium';
  const coarse = matchMedia('(pointer: coarse)').matches, small = Math.min(innerWidth, innerHeight) < 560;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  if ((coarse && small) || cores <= 2 || memory <= 2) return 'low';
  if (coarse || cores <= 4 || memory <= 4) return 'medium';
  return 'high';
}

let liveWorlds = 0;
const UP_AXIS = new THREE.Vector3(0, 1, 0);
/** The procedural stand-in runner is drawn a little larger than its collision radius suggests (readability). */
const RUNNER_SCALE = 1.28;
const wallKind = (index: number, total: number): WallKind => index === total - 1 ? 'grand' : (index + 1) % 4 === 0 ? 'milestone' : 'normal';

export class SkyWorld {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(58, 1, .1, 1400);
  private scene = new THREE.Scene();
  private env: SkyEnvironment;
  private track: SkyTrack;
  private effects: SkyEffects;
  private echo: SkyEcho;
  private hazards: SkyHazards;
  private orbs = new SkyOrbs();
  private lastLocalX = 0; private heading = 0;
  private view: RushView = 'third';
  /** 0 = behind the runner, 1 = through their eyes; eased, so a switch is a short glide and never a cut. */
  private firstBlend = 0;
  private lookYaw = 0; private lookPitch = 0; private lookHeld = false;
  private eyeY = Number.NaN; private baseYaw = 0; private ownView = false;
  private eyeAt = new THREE.Vector3(); private tpPos = new THREE.Vector3(); private fpPos = new THREE.Vector3();
  private rigQ = { third: new THREE.Quaternion(), first: new THREE.Quaternion() };
  /** A stand-in camera to aim each pose with: a camera's lookAt points its −Z at the target (an Object3D's would point +Z, looking backwards). */
  private rig = new THREE.PerspectiveCamera();
  private currentPlaneZ = 0; private currentSlideX = 0;
  private local: RunnerLike;
  private localIsArt = false;
  private hemi = new THREE.HemisphereLight(0xffffff, 0x88aa77, 1.1);
  private sun = new THREE.DirectionalLight(0xffffff, 2.4);
  private rim = new THREE.DirectionalLight(0xbfe6ff, .9);
  private pal = createPalette();
  private progress = 0;
  private walls = new Map<number, WallSlot>();
  private remotes = new Map<string, RemoteSlot>();
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private quality: Quality;
  private width = 1; private height = 1;
  private camX = 0; private camZ = 6; private camLift = 0; private fov = 58; private speed01 = 0;
  private shake = 0; private orbit = 0; private celebrateAt = -1;
  private lastLocalZ = 0; private initialized = false;
  private runnerPos = new THREE.Vector3();
  private rejectedAt = -10; private lastRejected = -1;
  private sunDir = new THREE.Vector3();
  private keyDir = new THREE.Vector3();
  private font: string;
  private lastFootPhase = 0;
  private finishPlaced = -1;
  private disposed = false;
  private artApplied = false;
  private time = 0;
  // Image-based light from the current sky (a tiny gradient dome, prefiltered); refreshed as the palette travels.
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envSky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envAt = -10; private envProgress = -1;
  /** Foot contacts of the local runner (0 = left, 1 = right) with the pace 0..1 — the footstep sound follows these. */
  onFootstep: (foot: 0 | 1, pace: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement, quality: Quality, private onLost: () => void = () => {}) {
    this.quality = quality;
    liveWorlds++;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance', alpha: false, stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = .86;
    this.renderer.shadowMap.enabled = quality === 'high'; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    canvas.addEventListener('webglcontextlost', this.lost, false);
    canvas.addEventListener('webglcontextrestored', this.restored, false);
    this.font = getComputedStyle(canvas).fontFamily || 'sans-serif';

    this.scene.fog = new THREE.Fog(0xbcdcff, 120, 480);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.rim, this.rim.target);
    this.sun.castShadow = quality === 'high';
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera; sc.left = -10; sc.right = 10; sc.top = 14; sc.bottom = -14; sc.near = 1; sc.far = 70;
    this.sun.shadow.bias = -.0006; this.sun.shadow.normalBias = .025; this.sun.shadow.radius = 3;

    this.env = new SkyEnvironment(quality); this.scene.add(this.env.group);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envSky = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false,
      uniforms: { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uLow: { value: new THREE.Color() }, uSun: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3() } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uTop, uHorizon, uLow, uSun, uSunDir; varying vec3 vDir; void main(){ vec3 d = normalize(vDir); float h = d.y; vec3 c = h > 0.0 ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), .6)) : mix(uHorizon, uLow, clamp(-h * 2.0, 0.0, 1.0)); c += uSun * pow(max(0.0, dot(d, normalize(uSunDir))), 24.0) * 1.6; gl_FragColor = vec4(c, 1.0); }' }));
    this.envScene.add(this.envSky);
    this.track = new SkyTrack(quality); this.scene.add(this.track.group);
    this.effects = new SkyEffects(quality); this.scene.add(this.effects.group);
    this.hazards = new SkyHazards(quality); this.scene.add(this.hazards.group);
    this.echo = new SkyEcho(); this.scene.add(this.echo.root);
    this.scene.add(this.orbs.group);
    this.local = this.makeRunner(0);
    this.scene.add(this.local.root);
    this.setQuality(quality);
    void loadSkyArt().then(art => { if (!this.disposed) this.applyArt(art); });
  }

  /**
   * A lost context is usually given back by the browser within a moment (a GPU reset, a tab regaining memory); three.js
   * rebuilds its state when it is. The page reports a 3D failure only if the context stays lost.
   */
  private lostTimer: ReturnType<typeof setTimeout> | null = null;
  private lost = (event: Event) => { event.preventDefault(); if (this.lostTimer) clearTimeout(this.lostTimer); this.lostTimer = setTimeout(() => { this.lostTimer = null; if (!this.disposed) this.onLost(); }, 2500); };
  private restored = () => { if (this.lostTimer) clearTimeout(this.lostTimer); this.lostTimer = null; };

  /**
   * Which model a hero is drawn with right now: '' = the procedural stand-in (art not loaded), 'LYRA' / 'KAI' = the
   * authored hero. A Kai is drawn as Lyra until his file arrives (it is fetched on first need), then swapped.
   */
  private heroArt(hero: RushHero | undefined, avatar?: string): string {
    const art = skyArt();
    if (!art?.runner?.animations.length) return '';
    // A real player is the same person as in the Study Space and the Arena, in the same clothes. On the lowest quality the lighter runner stays.
    if (avatar !== undefined && this.quality !== 'low') {
      const who = hero === 'KAI' ? 'KAI' : 'LYRA';
      if (castArt(who)) return `cast:${who}:${avatar}`;
      void loadCastArt(who);
    }
    if (hero === 'KAI') { if (art.runnerKai?.animations.length) return 'KAI'; void loadKai(); }
    return 'LYRA';
  }
  /** The authored hero when the model is loaded, the procedural Skyrunner until then (or if it never loads). */
  private makeRunner(look: number, hero?: RushHero, avatar?: string): RunnerLike & { art?: boolean } {
    const art = skyArt(), which = this.heroArt(hero, avatar);
    if (art?.runner && which.startsWith('cast:')) {
      const who = hero === 'KAI' ? 'KAI' : 'LYRA';
      const c = new SkyCharacter(castArt(who)!, CHARACTER_LOOKS[look % CHARACTER_LOOKS.length], look % CHARACTER_LOOKS.length, null, { hero: who, avatar: avatar ?? '' });
      return Object.assign(c, { art: true });
    }
    if (art?.runner && which) {
      const c = new SkyCharacter(which === 'KAI' ? art.runnerKai! : art.runner, CHARACTER_LOOKS[look % CHARACTER_LOOKS.length], look % CHARACTER_LOOKS.length, art.runnerOrm);
      return Object.assign(c, { art: true });
    }
    const r = new SkyRunner(RUNNER_LOOKS[look % RUNNER_LOOKS.length]); r.root.scale.setScalar(RUNNER_SCALE);
    return r;
  }

  private applyArt(art: SkyArt) {
    if (this.artApplied) return;
    this.artApplied = true;
    this.track.setArt(art);
    this.env.setArt(art.world);
    this.hazards.setArt(art.props, art.propsOrm);
    if (art.props6) {
      this.hazards.setArt6(art.props6, art.props6Orm); this.orbs.setArt(art.props6);
      let shutter: THREE.Object3D | null = null, wheel: THREE.Object3D | null = null, tower: THREE.Object3D | null = null;
      art.props6.scene.traverse(o => { if (o.name === 'shutter') shutter = o; if (o.name === 'wall_wheel') wheel = o; if (o.name === 'knowledge_tower') tower = o; });
      setWallMotionArt({ shutter, wheel, tower });
    }
    if (art.props7) this.hazards.setArt7(art.props7, art.props7Orm);
    if (art.ashlar) KnowledgeWall.setStone(art.ashlar.albedo, art.ashlar.normal);
    if (art.runner?.animations.length) {
      this.rebuildLocal();
      // Remotes are rebuilt on the next frame with the authored model.
      for (const [id, slot] of this.remotes) { this.scene.remove(slot.runner.root); slot.runner.dispose(); (slot.plate.material as THREE.SpriteMaterial).map?.dispose(); slot.plate.material.dispose(); this.remotes.delete(id); }
    }
    // Existing walls pick up the new stone on their next rebuild.
    for (const slot of this.walls.values()) { if (slot.real) { this.scene.remove(slot.real.group); slot.real.dispose(); slot.real = null; } }
  }

  private localHero: RushHero = 'LYRA';
  private localAvatar: string | undefined;
  private localModel = '';
  /** The local racer drawn with the model its hero needs now (after the art arrives, a hero change, Kai's file). */
  private rebuildLocal() {
    const next = this.makeRunner(0, this.localHero, this.localAvatar);
    next.root.position.copy(this.local.root.position);
    this.scene.remove(this.local.root); this.local.dispose();
    this.local = next; this.localIsArt = !!next.art; this.localModel = this.heroArt(this.localHero, this.localAvatar); this.scene.add(next.root);
    // A body swapped while the player looks through its eyes is seen the same way.
    if (this.ownView) { if (next.hasOwnView) next.setOwnView?.(true); else next.root.visible = false; }
    if (next.art) (next as unknown as SkyCharacter).onStep = (foot, pace) => this.onFootstep(foot, pace);
  }

  setView(view: RushView) { this.view = view; }
  get viewMode() { return this.view; }
  /** Mouse movement under mouse-look: the head turns (and the camera behind the runner swings round it); the race does not. */
  lookBy(dx: number, dy: number) {
    this.lookHeld = true;
    this.lookYaw = THREE.MathUtils.clamp(this.lookYaw - dx * .0023, -2.3, 2.3);
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy * .0021, -1.05, .85);
  }
  /** Mouse-look on or off: without it the view settles back on the road ahead. */
  setLookHeld(on: boolean) { this.lookHeld = on; }
  /** For the journeys: where the camera is and how far into the runner's eyes it is. */
  cameraDiagnostics() {
    const p = this.camera.position, d = this.camera.getWorldDirection(new THREE.Vector3());
    return { view: this.view, blend: Math.round(this.firstBlend * 1000) / 1000, ownView: this.ownView, pos: [p.x, p.y, p.z], dir: [d.x, d.y, d.z], eye: this.eyeAt.toArray(), lookYaw: this.lookYaw, lookPitch: this.lookPitch, fov: this.camera.fov, near: this.camera.near };
  }

  setQuality(level: Quality) {
    this.quality = level;
    const dpr = Math.min(window.devicePixelRatio || 1, level === 'high' ? 1.75 : level === 'medium' ? 1.25 : 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.shadowMap.enabled = level === 'high'; this.sun.castShadow = level === 'high';
    if (level === 'high' && !this.composer) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(this.width / 2, this.height / 2), .3, .45, .9);
      this.composer.addPass(this.bloom); this.composer.addPass(new OutputPass());
    } else if (level !== 'high' && this.composer) {
      this.composer.dispose(); this.bloom?.dispose(); this.composer = null; this.bloom = null;
    }
    this.resize(this.width, this.height);
  }
  get tier() { return this.quality; }

  resize(width: number, height: number) {
    this.width = Math.max(1, width); this.height = Math.max(1, height);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix();
    this.composer?.setSize(this.width, this.height);
    this.bloom?.setSize(this.width / 2, this.height / 2);
  }

  /** Compile every shader before the countdown ends, so the first gate never stalls on a program link. */
  async prepare(sample: WorldFrame) {
    // Give the authored art a short head start: a race that starts with it never swaps models mid-run.
    await Promise.race([loadSkyArt(), new Promise(resolve => setTimeout(resolve, 2500))]);
    const art = skyArt(); if (art) this.applyArt(art);
    this.frame({ ...sample, dt: 0 });
    try { await this.renderer.compileAsync(this.scene, this.camera); } catch { /* compile on first use instead */ }
  }

  event(kind: WorldEvent, lane = -1, x = this.runnerPos.x) {
    const reduced = false;
    if (kind === 'correct') {
      const slot = this.walls.get(this.currentCheckpoint);
      if (slot?.real && lane >= 0) this.effects.doorBurst(laneX(lane, slot.real.gates), wallZ(this.wallAt(this.currentCheckpoint)) + slot.real.group.position.y * 0, LANE_COLORS[lane % LANE_COLORS.length], reduced);
      this.echo.react('correct');
    }
    if (kind === 'streak') this.echo.react('streak');
    if (kind === 'wrong' || kind === 'post') {
      this.effects.rejectBurst(x, this.runnerPos.z - .3, reduced);
      this.shake = Math.max(this.shake, kind === 'wrong' ? 1 : .7); this.echo.react('wrong');
    }
    if (kind === 'dash' || kind === 'rush') { this.effects.dash(this.runnerPos.x, this.runnerPos.z, reduced); this.echo.react(kind); }
    if (kind === 'finish') { this.effects.confetti(this.runnerPos.x, this.runnerPos.z - 2, reduced); this.echo.react('finish'); }
  }

  /** The local racer's physical moments: dust, impact sparks, a fall poof, the respawn aura, and the character's clips. */
  private moment(m: RushMoment, f: WorldFrame) {
    const x = this.runnerPos.x, z = this.runnerPos.z, reduced = f.reduced;
    const c = this.local as Partial<SkyCharacter>;
    if (m === 'JUMP') { this.effects.puff(x, z, .6, reduced); c.cue?.('jump'); }
    if (m === 'LAND') this.effects.puff(x, z, 1, reduced);
    if (m === 'DODGE') { this.effects.dash(x, z, reduced); c.cue?.(f.local.vx < 0 ? 'dodge-left' : 'dodge-right'); }
    if (m === 'KNOCK') { this.effects.rejectBurst(x, z, reduced); this.shake = Math.max(this.shake, 1.2); this.echo.react('wrong'); }
    if (m === 'FALL') { this.effects.puff(x, z - .4, 1.6, reduced); this.echo.react('wrong'); }
    if (m === 'RESPAWN') { this.effects.respawn(x, z, reduced); this.echo.react('rush'); }
    if (m === 'SILL') { this.effects.rejectBurst(x, z - .3, reduced); this.shake = Math.max(this.shake, .8); }
    if (m === 'BUMP') { this.effects.rejectBurst(x, z - .3, reduced); this.shake = Math.max(this.shake, .6); }
    if (m === 'ORB') { this.effects.doorBurst(x, z - .2, 0x9ff3ff, reduced); this.echo.react('dash'); }
    if (m === 'SHIELD') { this.effects.respawn(x, z, reduced); this.shake = Math.max(this.shake, .4); }
  }

  private course: WorldCourse = { total: 0, walls: [], finish: 0, spacing: 2800 };
  private currentCheckpoint = 0;
  private wallAt(i: number) { return this.course.walls[i] ?? (i + 1) * this.course.spacing; }

  frame(f: WorldFrame) {
    if (this.disposed) return;
    const dt = Math.min(.05, Math.max(0, f.dt)), time = f.now / 1000, reduced = f.reduced;
    this.time = time;
    this.course = f.course; this.currentCheckpoint = f.local.checkpoint;
    const finishZ = toZ(f.course.finish);

    // Palette travels with progress; the final sprint (after the last wall) turns to starfall night.
    const finishing = ['FINISHING', 'FINISHED'].includes(f.local.phase) || f.mode === 'celebrate';
    const target = f.mode === 'attract' ? .08 : finishing ? 1 : Math.min(.86, Math.max(0, f.local.y / Math.max(1, f.course.finish)) * .92);
    this.progress += (target - this.progress) * (1 - Math.exp(-dt * (finishing ? .9 : 1.8)));
    if (!this.initialized) this.progress = target;
    palette(this.progress, this.pal);
    (this.scene.fog as THREE.Fog).color.copy(this.pal.fog);
    this.hemi.color.copy(this.pal.hemiSky); this.hemi.groundColor.copy(this.pal.hemiGround); this.hemi.intensity = .64 - this.pal.night * .12;
    this.sun.color.copy(this.pal.sun); this.sun.intensity = 2.35 - this.pal.night * 1.0;
    this.rim.color.copy(this.pal.skyHorizon).lerp(new THREE.Color(0xffffff), .4); this.rim.intensity = .65 + this.pal.night * .4;
    this.sunDir.set(Math.sin(this.pal.sunAzimuth), Math.max(.06, this.pal.sunElevation), -Math.cos(this.pal.sunAzimuth)).normalize();
    // The sky light is a soft gradient: a 64 px prefiltered map refreshed after a real palette change is enough (a 256 px
    // one re-rendered every 1.5 s cost a visible frame spike during races).
    if (!this.envTarget || (time - this.envAt > 1.5 && Math.abs(this.progress - this.envProgress) > .05)) {
      const u = this.envSky.material.uniforms;
      u.uTop.value.copy(this.pal.skyTop); u.uHorizon.value.copy(this.pal.skyHorizon); u.uLow.value.copy(this.pal.hemiGround).lerp(this.pal.cloud, .5); u.uSun.value.copy(this.pal.sun); u.uSunDir.value.copy(this.sunDir);
      const target = this.pmrem.fromScene(this.envScene, 0, .1, 100, { size: 64 });
      this.scene.environment = target.texture; this.scene.environmentIntensity = .55 - this.pal.night * .2;
      this.envTarget?.dispose(); this.envTarget = target; this.envAt = time; this.envProgress = this.progress;
    }

    // The chosen hero (the lobby preview changes it live; a race keeps it). Swapping the model keeps the position.
    this.localHero = f.local.hero ?? 'LYRA';
    this.localAvatar = f.local.avatar;
    if (this.artApplied && this.heroArt(this.localHero, this.localAvatar) !== this.localModel) this.rebuildLocal();
    // Local runner: road position plus height (jumps, sills; a fall drops below the road).
    const lx = toX(f.local.x), lz = toZ(f.local.y), ly = (f.local.z ?? 0) * SCENE.kx;
    const v6 = !!f.course.motion?.length;
    if (!this.initialized) { this.lastLocalZ = lz; this.lastLocalX = lx; this.camX = lx * .5; this.camZ = lz + 7; }
    // Version 6 strides follow the distance really walked in any direction (no foot sliding when stepping back or aside).
    const travel = Math.min(14 * Math.max(dt, 1 / 240), v6 ? Math.hypot(lx - this.lastLocalX, lz - this.lastLocalZ) : Math.max(0, this.lastLocalZ - lz));
    this.lastLocalZ = lz; this.lastLocalX = lx;
    // Facing follows the velocity while running and turns back to the wall the short way at one (`faceHeading`: the heading
    // stays in (−π, π], so easing it to 0 never winds through a full turn — the 360° spin at Knowledge Walls).
    if (v6) this.heading = faceHeading(this.heading, f.local.vx * SCENE.kx, (f.local.vy ?? 0) * SCENE.kz, f.local.phase, dt, 12);
    this.runnerPos.set(lx, 0, lz);
    const ground = f.local.ground ?? 0;
    this.local.root.position.set(lx, ly + ground, lz);
    const airborne = (f.local.z ?? 0) > .5 && f.local.phase !== 'VALIDATING';
    for (const m of f.moments ?? []) this.moment(m, f);
    this.local.animate({ phase: f.mode === 'celebrate' ? 'FINISHED' : f.local.phase, phaseTime: f.mode === 'celebrate' ? 1 : f.local.phaseTime, travel, speed: f.local.speed, vx: f.local.vx, dt, time,
      dashing: f.local.dashing, rushing: f.local.rushing, momentum: f.local.streak, reduced, airborne, vz: f.local.vz ?? 0, heading: v6 ? this.heading : undefined });
    // Protection after a hit or a respawn: the runner shimmers (and obstacles pass through).
    const guard = f.local.guard ?? 0;
    this.local.setGhost(guard > 0 && !reduced ? .55 + .45 * (Math.sin(time * 28) * .5 + .5) : 1);
    if (!this.localIsArt) {
      const stridePhase = Math.floor((this.lastFootPhase + travel / .85));
      if (travel > 0 && Math.floor(this.lastFootPhase) !== stridePhase && f.mode === 'race' && !airborne) { this.effects.footstep(lx, lz, Math.min(1, f.local.speed / 300)); this.onFootstep(stridePhase % 2 ? 1 : 0, Math.min(1, f.local.speed / 340)); }
      this.lastFootPhase += travel / .85;
    }

    // Obstacles, then the road (cut at broken bridges), then walls.
    const clock = f.clock ?? 0;
    this.hazards.update(f.course.hazards ?? [], clock, f.local.y, time, reduced);
    this.track.setGaps(this.hazards.gaps());
    // Version 6: obstacle zones have open edges (no railing); everywhere else the balustrade is real.
    this.track.setOpen(f.course.open ? [[1e6, -1e6]] : v6 ? (f.course.hazards ?? []).filter(h => h.to > f.local.y - 1500 && h.from < f.local.y + 8000).map(h => [toZ(h.from), toZ(h.to)] as [number, number]) : []);
    this.orbs.update(f.course.orbs, f.local.taken, f.local.y, time, dt, reduced);
    this.updateWalls(f, time, reduced);
    this.track.update(this.camZ, finishZ);
    if (this.finishPlaced !== f.course.finish && f.course.finish > 0) { this.track.finish(finishZ, this.font, 'ĐÍCH · FINISH'); this.finishPlaced = f.course.finish; }

    // Remote racers: real interpolated positions; a racer on another checkpoint (or inside my wall) is a ghost.
    this.updateRemotes(f, dt, time, reduced);

    // Camera rig: spring follow with speed-dependent field of view; framed so the whole wall fits the screen width.
    const aspect = this.width / this.height, portrait = aspect < 1;
    const vfov = portrait ? 66 : 56;
    const halfTan = Math.tan(THREE.MathUtils.degToRad(vfov / 2)) * aspect;
    const back = THREE.MathUtils.clamp((SCENE.roadHalf + .7) / halfTan - 6, 4.4, 14);
    const s01 = Math.min(1, f.local.speed / 420);
    this.speed01 += (s01 - this.speed01) * (1 - Math.exp(-dt * 4));
    const follow = 1 - Math.exp(-dt * 6);
    this.camX += (lx * (portrait ? .3 : .55) - this.camX) * (this.initialized ? follow : 1);
    const desiredZ = lz + back + this.speed01 * 1.3;
    this.camZ += (desiredZ - this.camZ) * (this.initialized ? 1 - Math.exp(-dt * 9) : 1);
    // The camera rises a little with a jump or a sill (never follows a fall into the clouds).
    this.camLift += (Math.max(0, ly) * .35 + ground * .5 - this.camLift) * (1 - Math.exp(-dt * 5));
    this.shake = Math.max(0, this.shake - dt * 3);
    const jitter = reduced ? 0 : this.shake * this.shake * .09;
    const camY = 1.35 + back * .27 - this.speed01 * .18 + this.camLift;
    // Through the runner's eyes only in a race; the lobby and the celebration keep their cinematic orbit.
    const wantFirst = f.mode === 'race' && this.view === 'first' ? 1 : 0;
    this.firstBlend += (wantFirst - this.firstBlend) * (reduced ? 1 : 1 - Math.exp(-dt * 7));
    if (Math.abs(this.firstBlend - wantFirst) < .006) this.firstBlend = wantFirst;
    const e = this.firstBlend * this.firstBlend * (3 - 2 * this.firstBlend);
    // Without mouse-look the eyes come back to the road; with it they stay where the player put them.
    if (!this.lookHeld) { const k = 1 - Math.exp(-dt * 3); this.lookYaw -= this.lookYaw * k; this.lookPitch -= this.lookPitch * k; }
    if (f.mode === 'race') {
      this.orbit = 0; this.celebrateAt = -1;
      // Behind the runner: the spring follow, swung round the runner by mouse-look (far enough to see who is alongside or behind).
      const swing = THREE.MathUtils.clamp(this.lookYaw, -1.25, 1.25) * (1 - e);
      this.tpPos.set(this.camX + Math.sin(time * 61) * jitter, camY + Math.cos(time * 53) * jitter + this.lookPitch * -1.4 * (1 - e), this.camZ);
      const target = new THREE.Vector3(this.camX * .55 + lx * .45, 1 + this.camLift * .6, lz - 9 - this.speed01 * 2.5);
      if (swing) { const pivot = new THREE.Vector3(lx, 0, lz); this.tpPos.sub(pivot).applyAxisAngle(UP_AXIS, swing).add(pivot); target.sub(pivot).applyAxisAngle(UP_AXIS, swing).add(pivot); }
      this.rig.position.copy(this.tpPos); this.rig.up.set(0, 1, 0); this.rig.lookAt(target);
      this.rig.rotateZ(-f.local.vx / 470 * .02 * (reduced ? 0 : 1));
      this.rigQ.third.copy(this.rig.quaternion);
      if (e > 0) {
        // Through the eyes: the camera sits where the body's eyes are this frame, after the run, the jump, the fall or the landing moved them.
        // Only the run's up-and-down is softened; along the road it never lags (a lag would show the player the inside of their own head).
        const eyes = this.local.eyes?.(this.eyeAt) ?? this.eyeAt.set(lx, ly + ground + 1.5, lz);
        if (!Number.isFinite(this.eyeY) || Math.abs(eyes.y - this.eyeY) > 2.5) this.eyeY = eyes.y;
        this.eyeY += (eyes.y - this.eyeY) * (reduced ? 1 : 1 - Math.exp(-dt * 20));
        const bodyYaw = this.local.root.rotation.y;
        this.baseYaw += wrapAngle(bodyYaw - this.baseYaw) * (1 - Math.exp(-dt * 8));
        const yaw = this.baseYaw + this.lookYaw, pitch = this.lookPitch - .07;
        // A few centimetres ahead of the eyes, past the face the player does not see.
        this.fpPos.set(eyes.x - Math.sin(bodyYaw) * .07, this.eyeY + .02, eyes.z - Math.cos(bodyYaw) * .07);
        this.rig.position.copy(this.fpPos);
        this.rig.lookAt(this.fpPos.x - Math.sin(yaw) * Math.cos(pitch) * 10, this.fpPos.y + Math.sin(pitch) * 10, this.fpPos.z - Math.cos(yaw) * Math.cos(pitch) * 10);
        this.rigQ.first.copy(this.rig.quaternion);
      } else { this.baseYaw = this.local.root.rotation.y; this.eyeY = Number.NaN; }
      this.camera.position.lerpVectors(this.tpPos, e > 0 ? this.fpPos : this.tpPos, e);
      this.camera.quaternion.slerpQuaternions(this.rigQ.third, e > 0 ? this.rigQ.first : this.rigQ.third, e);
      const fovTarget = THREE.MathUtils.lerp(vfov + this.speed01 * 10 + (f.local.dashing ? 4 : 0), (portrait ? 82 : 76) + this.speed01 * 7 + (f.local.dashing ? 3 : 0), e);
      this.fov += (fovTarget - this.fov) * (1 - Math.exp(-dt * 5));
    } else {
      // Attract (lobby) and celebration: a slow cinematic orbit around the runner, ending in front of their face.
      if (f.mode === 'celebrate' && this.celebrateAt < 0) this.celebrateAt = time;
      const t = f.mode === 'celebrate' ? Math.min(1, (time - this.celebrateAt) / 2.2) : 1;
      const base = f.mode === 'celebrate' ? Math.PI * (1 - t * t * (3 - 2 * t)) * .92 : 0;
      this.orbit = reduced ? 0 : this.orbit + dt * (f.mode === 'attract' ? .1 : .08);
      const angle = base + this.orbit + (f.mode === 'attract' ? .7 : 0), radius = f.mode === 'attract' ? 6.6 : 4.4;
      this.camera.position.set(lx + Math.sin(angle) * radius, (f.mode === 'attract' ? 3.2 : 1.55), lz - Math.cos(angle) * radius);
      // The lobby keeps the runner in the screen's centre column, between the title and the mode cards.
      this.camera.lookAt(lx, f.mode === 'attract' ? 1.25 : .95, lz);
      // Results sit in a panel on the right of wide screens: slide the frame so the champion stands left of it.
      if (f.mode === 'celebrate' && aspect > 1.1) this.camera.translateX(1.6);
      this.fov += ((portrait ? 62 : 44) - this.fov) * (1 - Math.exp(-dt * 3));
    }
    // The head, its hair and what is worn on it leave the player's own view once the camera is nearly in the eyes (their shadows stay). A runner
    // that cannot hide its head alone (the light stand-in) is not drawn for its own player in first person.
    const own = e > .55;
    if (own !== this.ownView) {
      this.ownView = own;
      if (this.local.hasOwnView) this.local.setOwnView?.(own); else this.local.root.visible = !own;
    }
    this.camera.near = e > .5 ? .04 : .1;
    this.camera.fov = this.fov; this.camera.updateProjectionMatrix();

    // Key light from behind-above the camera so wall faces, banners and runners are lit; a cool rim from ahead
    // separates silhouettes from the sky; the sky's own sun stays ahead.
    this.keyDir.set(-.42 + this.pal.sunAzimuth * .2, .82, .5).normalize();
    this.sun.position.copy(this.runnerPos).addScaledVector(this.keyDir, 30); this.sun.target.position.copy(this.runnerPos).add(new THREE.Vector3(0, 0, -5));
    this.rim.position.copy(this.runnerPos).add(new THREE.Vector3(3, 6, -14)); this.rim.target.position.copy(this.runnerPos);
    this.env.update(this.camera, this.pal, time, reduced, this.sunDir);
    this.effects.update(dt, time, this.camera, this.runnerPos, this.speed01, f.local.streak, reduced, f.mode !== 'attract');
    if (f.mode === 'race') this.effects.trail(lx, .75 + ly, lz, f.local.streak);
    this.echo.update(dt, time, this.runnerPos, this.speed01, reduced, f.mode);
    this.initialized = true;

    if (this.composer) this.composer.render(dt); else this.renderer.render(this.scene, this.camera);
  }

  private updateWalls(f: WorldFrame, time: number, reduced: boolean) {
    const total = f.course.total, cp = f.local.checkpoint;
    const keep = new Set<number>();
    const passed = new Map(f.passed.map(p => [p.checkpoint, p]));
    const motion = f.course.motion, clock = f.clock ?? 0, grooves: { near: number; far: number }[] = [];
    for (let i = Math.max(0, cp - 2); i <= Math.min(total - 1, cp + 3); i++) {
      const m: Wall6 | null = motion?.[i] ?? null, rest = this.wallAt(i);
      const planeY = i < cp ? passed.get(i)?.plane ?? rest : m ? wallPlane(m, rest, clock) : rest;
      const z = wallZ(planeY);
      if (m && m.travel > 0 && i >= cp) grooves.push({ near: toZ(rest - m.travel) + .4, far: toZ(rest) });
      if (z > this.camZ + 4) continue; // behind the camera
      keep.add(i);
      let slot = this.walls.get(i);
      if (!slot) { slot = { checkpoint: i, real: null, pending: null, questionId: '', riseStart: -1, plinth: null }; this.walls.set(i, slot); }
      const kind = wallKind(i, total);
      const isCurrent = i === cp && f.question && f.local.gates > 0;
      const ledger = passed.get(i);
      const rising = !!f.course.rising?.[i];
      if (rising && !slot.plinth) { slot.plinth = this.hazards.plinth(); slot.plinth.position.z = z; this.scene.add(slot.plinth); }
      if (isCurrent || (i < cp && ledger)) {
        const gates = isCurrent ? f.local.gates : ledger!.gates;
        if (!slot.real || slot.real.gates !== gates) {
          if (slot.real) { this.scene.remove(slot.real.group); slot.real.dispose(); }
          slot.real = new KnowledgeWall(gates, kind, this.font, f.course.spacing, rising, m ? { margin: m.amp * SCENE.kx, shutters: m.shutPeriod > 0, wheels: m.travel > 0 } : null);
          slot.real.group.position.z = z; this.scene.add(slot.real.group);
          // Revealed in the distance: the wall rises from below the causeway. Close by (a resumed race): already standing.
          const near = Math.abs(z - toZ(f.local.y)) < 14;
          slot.riseStart = near || reduced || i < cp ? -1 : time; slot.real.setRise(slot.riseStart < 0 ? 1 : 0);
        }
        if (slot.pending && slot.real.risen > .6) { this.scene.remove(slot.pending.group); slot.pending.dispose(); slot.pending = null; }
        if (slot.riseStart >= 0) slot.real.setRise((time - slot.riseStart) / .9);
        slot.real.group.position.z = z;
        if (m) {
          const slideX = wallSlide(m, clock) * SCENE.kx; slot.real.setSlide(slideX);
          slot.real.setShutter(wallShutter(m, clock), i === cp ? f.local.openGate : ledger?.openGate ?? -1);
          slot.real.setTravel(wallApproach(m, clock) * SCENE.kz);
          if (i === cp) { this.currentPlaneZ = z; this.currentSlideX = slideX; }
        } else if (i === cp) { this.currentPlaneZ = z; this.currentSlideX = 0; }
        // A rising Knowledge Gate lifts on its plinth: this racer's own sill height (the server's rule, mirrored).
        const lift = i === cp ? (f.local.sill ?? 0) * SCENE.kx : 0;
        slot.real.setLift(lift);
        if (slot.plinth) { slot.plinth.scale.y = Math.max(.001, lift); slot.plinth.visible = lift > .005; }
        const opening = i === cp && f.local.phase === 'OPENING' ? Math.min(1, f.local.phaseTime / .48) : 0;
        const openGate = i === cp ? f.local.openGate : ledger?.openGate ?? -1;
        if (i === cp && f.local.rejected !== this.lastRejected) { this.lastRejected = f.local.rejected; if (f.local.rejected >= 0) this.rejectedAt = time; }
        slot.real.update({
          labels: isCurrent ? f.question!.labels : null, monospace: !!f.question?.monospace,
          openGate, openProgress: i < cp ? 1 : openGate < 0 ? 0 : f.local.phase === 'OPENING' ? opening : 1,
          rejected: i === cp ? f.local.rejected : -1, rejectAge: time - this.rejectedAt, tried: i === cp ? f.tried : [], aim: i === cp ? f.aim : -1, marked: i === cp ? f.marked ?? -1 : -1, time, reduced,
          warning: i === cp && rising ? Math.min(1, Math.max(0, 1 - (this.wallAt(i) - f.local.y) / 720)) : 0,
        });
        if (isCurrent) slot.questionId = f.question!.id;
        // Dissolve once the runner is through (or for a ledger wall the camera is about to cross).
        const through = (z - toZ(f.local.y)) - .4;
        slot.real.setFade(openGate >= 0 && through > 0 ? through / 1.6 : 0);
      } else if (!slot.real && !slot.pending) {
        slot.pending = new PendingWall(kind); slot.pending.group.position.z = z; this.scene.add(slot.pending.group);
      }
      if (slot.pending) slot.pending.group.position.z = z;
      if (slot.plinth) slot.plinth.position.z = z;
      slot.pending?.update(time, reduced);
    }
    for (const [index, slot] of this.walls) if (!keep.has(index)) {
      if (slot.real) { this.scene.remove(slot.real.group); slot.real.dispose(); }
      if (slot.pending) { this.scene.remove(slot.pending.group); slot.pending.dispose(); }
      if (slot.plinth) this.scene.remove(slot.plinth);
      this.walls.delete(index);
    }
    // Runways toward the current wall's doors.
    if (f.mode === 'race' && cp < total && f.question && f.local.gates > 0) {
      const planeNow = motion?.[cp] ? wallPlane(motion[cp], this.wallAt(cp), clock) : this.wallAt(cp), remaining = planeNow - f.local.y;
      this.track.runway(f.local.gates, wallZ(planeNow), 1 - (remaining - 250) / 1300, f.aim, f.tried, f.course.spacing, time, reduced, motion?.[cp] ? wallSlide(motion[cp], clock) * SCENE.kx : 0);
    } else this.track.hideRunway();
    this.track.grooves(f.mode === 'race' ? grooves : [], time, reduced);
  }

  private plateTexture(name: string, color: number) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64; const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(12,26,50,.82)'; g.beginPath(); g.roundRect(4, 6, 248, 52, 26); g.fill();
    g.fillStyle = '#' + new THREE.Color(color).getHexString(); g.beginPath(); g.arc(32, 32, 12, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff6df'; g.font = `700 28px ${this.font}`; g.textBaseline = 'middle'; g.fillText(name.slice(0, 14), 54, 34);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  private updateRemotes(f: WorldFrame, dt: number, time: number, reduced: boolean) {
    const seen = new Set<string>();
    const myMotion = f.course.motion?.[f.local.checkpoint];
    const myBarrier = myMotion ? wallPlane(myMotion, this.wallAt(f.local.checkpoint), f.clock ?? 0) : this.wallAt(f.local.checkpoint);
    const v6 = !!f.course.motion?.length;
    for (const r of f.remotes) {
      seen.add(r.id);
      let slot = this.remotes.get(r.id);
      const art = this.heroArt(r.hero, r.avatar);
      if (slot && slot.art !== art) { this.scene.remove(slot.runner.root); slot.runner.dispose(); (slot.plate.material as THREE.SpriteMaterial).map?.dispose(); slot.plate.material.dispose(); this.remotes.delete(r.id); slot = undefined; }
      const look = RUNNER_LOOKS[r.look % RUNNER_LOOKS.length];
      if (!slot) {
        const runner = this.makeRunner(r.look, r.hero, r.avatar);
        const plate = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, toneMapped: false }));
        plate.scale.set(.95, .24, 1); plate.position.y = art ? 2.05 : 1.32; runner.root.add(plate);
        slot = { runner, plate, plateKey: '', lastZ: toZ(r.y), lastX: toX(r.x), effect: null, effectKind: '', look: r.look, art, heading: 0 };
        this.remotes.set(r.id, slot); this.scene.add(runner.root);
      }
      if (slot.plateKey !== r.name) {
        slot.plateKey = r.name;
        const mat = slot.plate.material as THREE.SpriteMaterial; mat.map?.dispose(); mat.map = this.plateTexture(r.name, look.hoodie); mat.needsUpdate = true;
      }
      const x = toX(r.x), z = toZ(r.y), travel = Math.min(14 * Math.max(dt, 1 / 240), v6 ? Math.hypot(x - slot.lastX, z - slot.lastZ) : Math.max(0, slot.lastZ - z));
      // A rival faces its snapshot-segment velocity, never a frame-to-frame position delta: when an extrapolated pose that
      // overshot a stop is pulled back, the delta points backward and used to swing the rival round (a full spin and back).
      if (v6) slot.heading = faceHeading(slot.heading, r.vx * SCENE.kx, (r.vy ?? 0) * SCENE.kz, r.phase, dt, 10);
      slot.lastZ = z; slot.lastX = x;
      slot.runner.root.position.set(x, (r.z ?? 0) * SCENE.kx + (r.ground ?? 0), z);

      slot.runner.animate({ phase: r.connected ? r.phase : 'PAUSED', phaseTime: r.phaseTime, travel, speed: r.speed, vx: r.vx, dt, time, dashing: false, rushing: false, momentum: r.streak, reduced, airborne: (r.z ?? 0) > .5, heading: v6 ? slot.heading : undefined });
      const privatePass = r.checkpoint !== f.local.checkpoint || r.y > myBarrier - 26;
      // A rival behind the local runner sits between it and the camera: keep them see-through so they never hide the doors.
      const behind = z - toZ(f.local.y), occluding = f.mode === 'race' && behind > .35;
      const shimmer = (r.guard ?? 0) > 0 && !reduced ? .7 + .3 * Math.sin(time * 28) : 1;
      slot.runner.setGhost((!r.connected ? .3 : privatePass ? .32 : occluding ? Math.max(.28, 1 - (behind - .35) * .6) : 1) * shimmer);
      (slot.plate.material as THREE.SpriteMaterial).opacity = occluding ? .35 : 1;
      // The results stage belongs to the local runner: rivals (and their name plates) leave the shot.
      slot.runner.root.visible = f.mode !== 'celebrate' && z < this.camZ + 2;
      if (slot.effectKind !== r.effect) {
        if (slot.effect) { slot.runner.root.remove(slot.effect); slot.effect.geometry.dispose(); (slot.effect.material as THREE.Material).dispose(); slot.effect = null; }
        slot.effectKind = r.effect;
        if (r.effect) slot.effect = this.effectMesh(r.effect);
        if (slot.effect) slot.runner.root.add(slot.effect);
      }
      if (slot.effect) slot.effect.rotation.y = reduced ? 0 : time * 2;
    }
    for (const [id, slot] of this.remotes) if (!seen.has(id)) {
      this.scene.remove(slot.runner.root); slot.runner.dispose(); (slot.plate.material as THREE.SpriteMaterial).map?.dispose(); slot.plate.material.dispose();
      if (slot.effect) { slot.effect.geometry.dispose(); (slot.effect.material as THREE.Material).dispose(); }
      this.remotes.delete(id);
    }
  }

  /** Tactical effects (Ice Lock, Time Snare, Position Swap) drawn around the affected racer. */
  private effectMesh(kind: string): THREE.Mesh | null {
    if (kind === 'ICE_LOCK') return new THREE.Mesh(new THREE.IcosahedronGeometry(.75, 1), new THREE.MeshStandardMaterial({ color: 0xbff4ff, transparent: true, opacity: .45, roughness: .05, metalness: .1, emissive: 0x2fa6c9, emissiveIntensity: .4, flatShading: true }));
    if (kind === 'TIME_SNARE') { const m = new THREE.Mesh(new THREE.TorusGeometry(.6, .05, 8, 32), new THREE.MeshBasicMaterial({ color: 0xf2c66d, toneMapped: false })); m.rotation.x = Math.PI / 2; m.position.y = .7; return m; }
    if (kind === 'POSITION_SWAP') { const m = new THREE.Mesh(new THREE.TorusGeometry(.65, .04, 6, 32, Math.PI * 1.5), new THREE.MeshBasicMaterial({ color: 0x8ff6ff, toneMapped: false })); m.position.y = .7; m.rotation.x = Math.PI / 2; return m; }
    return null;
  }

  /** Local effect shells use the same art as remote ones. */
  setLocalEffect(kind: string) {
    const existing = this.local.root.getObjectByName('local-effect') as THREE.Mesh | undefined;
    if ((existing?.userData.kind ?? '') === kind) return;
    if (existing) { this.local.root.remove(existing); existing.geometry.dispose(); (existing.material as THREE.Material).dispose(); }
    const mesh = kind ? this.effectMesh(kind) : null;
    if (mesh) { mesh.name = 'local-effect'; mesh.userData.kind = kind; this.local.root.add(mesh); }
  }

  /** Screen position of a door centre (for HUD alignment and automated checks). */
  doorScreen(checkpoint: number, lane: number, gates: number) {
    const moving = checkpoint === this.currentCheckpoint && !!this.course.motion?.length;
    const v = new THREE.Vector3(laneX(lane, gates) + (moving ? this.currentSlideX : 0), 1, moving ? this.currentPlaneZ : wallZ(this.wallAt(checkpoint))).project(this.camera);
    return { x: (v.x + 1) / 2 * this.width, y: (1 - v.y) / 2 * this.height, visible: v.z < 1 };
  }

  stats() {
    const art = skyArt();
    return { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, textures: this.renderer.info.memory.textures, geometries: this.renderer.info.memory.geometries, quality: this.quality, echo: this.echo.loaded, art: this.localIsArt,
      assets: { runner: !!art?.runner, world: !!art?.world, props: !!art?.props, props6: !!art?.props6 },
      animation: (this.local as Partial<SkyCharacter>).animationState?.() ?? null };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.domElement.removeEventListener('webglcontextlost', this.lost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.restored);
    if (this.lostTimer) clearTimeout(this.lostTimer);
    for (const slot of this.walls.values()) { slot.real?.dispose(); slot.pending?.dispose(); }
    this.walls.clear();
    for (const slot of this.remotes.values()) { slot.runner.dispose(); (slot.plate.material as THREE.SpriteMaterial).map?.dispose(); slot.plate.material.dispose(); slot.effect?.geometry.dispose(); }
    this.remotes.clear();
    this.setLocalEffect('');
    this.local.dispose(); this.env.dispose(); this.track.dispose(); this.effects.dispose(); this.echo.dispose(); this.hazards.dispose(); this.orbs.dispose();
    this.composer?.dispose(); this.bloom?.dispose();
    this.envTarget?.dispose(); this.pmrem.dispose(); this.envSky.geometry.dispose(); this.envSky.material.dispose();
    // Shared geometry caches outlive a world while another (lobby ↔ race hand-over) still draws with them.
    if (--liveWorlds === 0) { disposeRunnerGeometries(); disposeGateCaches(); disposeCharacterPalettes(); }
    // No forceContextLoss: a remount (React dev double-effects) may reuse this canvas; dispose releases GPU objects.
    this.renderer.dispose();
  }
}
