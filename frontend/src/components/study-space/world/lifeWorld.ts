import * as T from 'three';
import { GrimeField, type Vec2 } from '@/lib/study-space/grime';
import { age, cleanliness, dropWebsOf, freshLife, FLOOR_CELLS, logEvent, readLife, topCells, topsOf, toLocal, type Crumb, type RoomLife, type TopSurface, type Web } from '@/lib/study-space/life';
import { hasWeather, localDay, viewRain, weatherAt, type Weather } from '@/lib/study-space/weather';
import { StoryDirector, type Facts, type Line } from '@/lib/study-space/stories';
import { hasKit } from '@/lib/study-space/kit';
import { CATALOG_BY_ID } from '@/lib/study-space/catalog';
import type { Layout, SpaceObject } from '@/lib/study-space/types';
import { cobwebTexture, disposePrewarmedGrimeMaterials, filmMaterial, floorGrime, forgetCobwebTexture, GrimeTexture, prewarmGrimeMaterials, Puffs, type FloorGrime } from './grimeView';
import { WINDOW, type RoomBuild } from './room';
import { RoomAir } from '@/lib/embodiment/contactAudio';

/**
 * The room going on living while it is open. It owns what time and tools do to surfaces and draws it; every change comes from a cause in the world (a tool that touched
 * something, water that came in, a foot that came down), and the record goes with the layout, saved a moment after the last change, never during it. With nothing wet, nothing
 * moving and nothing to say, a frame costs a few comparisons.
 */
export interface LifeHost {
  stage: T.Group;
  layout(): Layout | null;
  room(): RoomBuild | null;
  /** A piece of furniture's group, to hang its film on. */
  group(id: string): T.Object3D | null;
  reduced(): boolean;
  /** Save: `merge` makes it no step of Undo. */
  commit(life: RoomLife): void;
  caption(line: Line): void;
  /** What only the hands and the body know. */
  facts(): Pick<Facts, 'held' | 'mopLoad' | 'mopWet' | 'panFill' | 'panHeld' | 'bucketDirt' | 'bucketFill' | 'binFull' | 'atDesk' | 'onScreen' | 'bookOpen' | 'busy' | 'unread' | 'invited' | 'trash' | 'kettleHot' | 'teaReady' | 'cupHasTea' | 'plantDry' | 'bulbBurnt' | 'hasKettle'>;
  /** The room was left for this many days. */
  timePassed?(days: number): void;
  spawn(obj: SpaceObject): void;
  uid(): string;
  /** The window, the lamps and the sky changed with the hour: the lights follow. */
  lightChanged(): void;
  /** A line is on the screen right now: the next one waits. */
  captionOn(): boolean;
  pixels(): number;
  /** True when Echo Life `worldAudio` owns ambient weather audio (prevents RoomAir double-playing rain/wind). */
  worldAudioActive?(): boolean;
}
interface Film { field: GrimeField; tex: GrimeTexture; surface: TopSurface; mesh: T.Mesh | null; material: T.Material | null }
const COLOR = { crumb: new T.Color('#6f5a43'), paper: new T.Color('#e8e4da'), leaf: new T.Color('#7d7a3c') };
const MAX_CRUMBS = 60, MAX_CLUMPS = 460;

export class LifeWorld {
  life: RoomLife = freshLife('room', 0);
  floor: GrimeField | null = null;
  private floorTex: GrimeTexture | null = null;
  private floorMat: FloorGrime | null = null;
  private floorOwner: T.Mesh | null = null;
  private baseFloor: T.Material | T.Material[] | null = null;
  readonly films = new Map<string, Film>();
  glass: Film | null = null;
  private identity = '';
  private roomKey = '';
  private sense = { value: 0 };
  private senseUntil = 0;
  readonly group = new T.Group();
  readonly puffs = new Puffs();
  private lastPuff = 0;
  private crumbMesh: T.InstancedMesh;
  private clumpMesh: T.InstancedMesh;
  private readonly warmFilmTex: GrimeTexture;
  private readonly warmFilmMat: T.Material;
  private readonly warmFilmMesh: T.Mesh;
  private readonly crumbTmp = new T.Object3D();
  private readonly heapTmp = new T.Object3D();
  private readonly heapCol = new T.Color();
  private webs = new Map<string, { mesh: T.Mesh; material: T.MeshBasicMaterial; web: Web; sway: number }>();
  private director: StoryDirector;
  private dirty = false;
  private lastChange = 0;
  private tick = 0;
  private air = 0;
  private clumpRev = -1;
  private crumbRev = 0;
  private crumbShown = -1;
  private now: () => number = () => Date.now();
  /** Added to the clock, for the room's own QA: nothing else moves time. */
  shift = 0;
  private soles = 0;
  private dustySoles = 0;
  private spilledAt = 0;
  weather: Weather = { rain: 0, wind: 0, sun: .8, arc: .5 };
  rain = 0;
  private atWindow = 0;
  private sound = new RoomAir();
  private visitDay = '';
  private firstToday = false;
  private lastLight = -1;

  constructor(private host: LifeHost) {
    this.director = new StoryDirector(this.life);
    this.group.name = 'room-life';
    const crumb = new T.IcosahedronGeometry(1, 0);
    this.crumbMesh = new T.InstancedMesh(crumb, new T.MeshStandardMaterial({ roughness: .86 }), MAX_CRUMBS);
    this.crumbMesh.instanceColor = new T.InstancedBufferAttribute(new Float32Array(MAX_CRUMBS * 3), 3);
    this.crumbMesh.castShadow = false; this.crumbMesh.receiveShadow = true; this.crumbMesh.count = 0; this.crumbMesh.frustumCulled = false;
    this.crumbMesh.userData.noCollision = true; this.crumbMesh.raycast = () => undefined;
    const lump = new T.IcosahedronGeometry(1, 0);
    this.clumpMesh = new T.InstancedMesh(lump, new T.MeshStandardMaterial({ roughness: 1 }), MAX_CLUMPS);
    this.clumpMesh.instanceColor = new T.InstancedBufferAttribute(new Float32Array(MAX_CLUMPS * 3), 3);
    this.clumpMesh.castShadow = false; this.clumpMesh.receiveShadow = true; this.clumpMesh.count = 0; this.clumpMesh.frustumCulled = false;
    this.clumpMesh.userData.noCollision = true; this.clumpMesh.raycast = () => undefined;
    // Zero-triangle sentinel (`drawRange(0, 0)`) keeps `'film-grime-2'` compiled in Stage-6 scene warmup
    // and pinned (`program.usedTimes >= 1`) so clean desk splashes never compile cold mid-stream.
    this.warmFilmTex = new GrimeTexture(new GrimeField(2, 2, 1, 1));
    this.warmFilmMat = filmMaterial(this.warmFilmTex, this.sense, [1, 1]);
    const warmGeom = new T.PlaneGeometry(0.001, 0.001);
    warmGeom.setDrawRange(0, 0);
    this.warmFilmMesh = new T.Mesh(warmGeom, this.warmFilmMat);
    this.warmFilmMesh.frustumCulled = false;
    this.warmFilmMesh.castShadow = false;
    this.warmFilmMesh.receiveShadow = true;
    this.warmFilmMesh.userData.noCollision = true;
    this.warmFilmMesh.userData.skipMirrorPass = true;
    this.warmFilmMesh.raycast = () => undefined;
    this.group.add(this.crumbMesh, this.clumpMesh, this.puffs.points, this.warmFilmMesh);
    this.host.stage.add(this.group);
  }
  clock() { return this.now() + this.shift; }

  /** Stage-6 pre-entry `1x1` warmup for `filmMaterial` and `floorGrime` D3D11 PSOs. */
  warmup(renderer: T.WebGLRenderer, camera: T.Camera, target?: T.WebGLRenderTarget | null, referenceScene?: T.Scene | null) {
    prewarmGrimeMaterials(renderer, camera, target, referenceScene);
  }

  // ── The room's record ───────────────────────────────────────────────────────────────────────────────
  /** Called with every layout. It rebuilds nothing unless the room, or which room it is, changed. */
  sync(layout: Layout, identity: string) {
    const switched = identity !== this.identity;
    const key = JSON.stringify([layout.room.visible, layout.room.floor, layout.room.size, layout.room.floorStyle, layout.room.theme, layout.room.wallColor, layout.room.wallLeft, layout.room.wallRight, layout.room.base]);
    if (switched) {
      this.sound.stop();
      this.identity = identity;
      const stored = readLife(layout.life);
      const created = !stored;
      this.life = stored ?? freshLife(identity.slice(0, 40) || 'room', this.clock());
      this.director.use(this.life);
      this.films.forEach(f => this.dropFilm(f)); this.films.clear();
      if (this.glass) { this.dropFilm(this.glass); this.glass = null; }
      this.webs.forEach(w => this.dropWeb(w)); this.webs.clear();
      this.crumbShown = -1; this.clumpRev = -1;
      this.roomKey = '';
      this.ensureFloor(layout);
      this.syncFilms(layout);
      this.passTime(layout, created);
    } else {
      if (key !== this.roomKey) this.ensureFloor(layout);
      this.syncFilms(layout);
    }
    this.roomKey = key;
    this.attachFloor();
    this.syncWebs();
  }
  private ensureFloor(layout: Layout) {
    const size = layout.room.size;
    if (!this.floor || this.floor.w !== size) {
      this.floorTex?.dispose();
      this.floor = GrimeField.decode(this.life.floor, FLOOR_CELLS, FLOOR_CELLS, size, size);
      this.floorTex = new GrimeTexture(this.floor);
      this.floorMat?.dispose(); this.floorMat = null; this.floorOwner = null;
    }
    this.floorOwner = null;
  }
  /** The floor mesh is rebuilt with the room: what it shows has to be put back on it. */
  private attachFloor() {
    const room = this.host.room(), mesh = room?.floor ?? null;
    if (!mesh || !this.floorTex || !this.floor || mesh === this.floorOwner) return;
    this.floorOwner = mesh;
    this.baseFloor = mesh.material;
    this.floorMat?.dispose();
    this.floorMat = floorGrime(mesh.material as T.MeshStandardMaterial, this.floorTex, this.floor.w);
    this.floorMat.sense.value = this.sense.value;
    this.sense = this.floorMat.sense;
    mesh.material = this.floorMat.material;
    this.films.forEach(f => { if (f.mesh) { this.dropFilmMesh(f); this.filmMesh(f); } });
    if (this.glass) { this.dropFilmMesh(this.glass); this.filmMesh(this.glass); }
  }
  private syncFilms(layout: Layout) {
    const tops = layout.room.visible ? topsOf(layout.objects) : [];
    const seen = new Set<string>();
    for (const s of tops) {
      seen.add(s.key);
      let f = this.films.get(s.key);
      if (!f || f.field.w !== s.w || f.field.d !== s.d) {
        if (f) this.dropFilm(f);
        const [nx, nz] = topCells(s.w, s.d);
        const field = GrimeField.decode(this.life.tops?.[s.key], nx, nz, s.w, s.d);
        f = { field, tex: new GrimeTexture(field), surface: s, mesh: null, material: null };
        this.films.set(s.key, f);
      }
      f.surface = s;
      if (!f.mesh && f.field.total('dust') + f.field.total('stain') + f.field.total('wet') > .001) this.filmMesh(f);
    }
    for (const [k, f] of this.films) if (!seen.has(k)) { this.dropFilm(f); this.films.delete(k); }
    if (layout.room.visible && layout.room.wallRight && !this.glass) {
      const w = WINDOW.x1 - WINDOW.x0, h = WINDOW.y1 - WINDOW.y0, field = GrimeField.decode(this.life.tops?.glass, 32, 18, w, h);
      this.glass = { field, tex: new GrimeTexture(field), surface: { key: 'glass', object: '', level: 0, x: (WINDOW.x0 + WINDOW.x1) / 2, y: (WINDOW.y0 + WINDOW.y1) / 2, z: -layout.room.size / 2 + .012, rotY: 0, w, d: h }, mesh: null, material: null };
      if (field.total('dust') + field.total('stain') > .001) this.filmMesh(this.glass);
    }
  }
  private filmMesh(f: Film) {
    const material = filmMaterial(f.tex, this.sense, [f.field.w, f.field.d]);
    const mesh = new T.Mesh(new T.PlaneGeometry(f.field.w, f.field.d), material);
    mesh.userData.noCollision = true; mesh.userData.blob = true;
    mesh.geometry.boundingBox = new T.Box3(new T.Vector3(), new T.Vector3());
    mesh.geometry.boundingSphere = new T.Sphere(new T.Vector3(), Math.hypot(f.field.w, f.field.d));
    mesh.raycast = () => undefined; mesh.renderOrder = 2; mesh.castShadow = false; mesh.receiveShadow = true;
    if (f.surface.key === 'glass') {
      // On the pane, facing into the room.
      mesh.position.set(f.surface.x, f.surface.y, f.surface.z); this.group.add(mesh);
    } else {
      const parent = this.host.group(f.surface.object);
      if (!parent) { mesh.geometry.dispose(); material.dispose(); return; }
      const obj = this.host.layout()?.objects.find(o => o.id === f.surface.object), scale = obj?.scale ?? 1;
      mesh.rotation.x = -Math.PI / 2; mesh.position.set(0, (f.surface.y - (obj?.pos[1] ?? 0)) / scale + .0015, 0); mesh.scale.setScalar(1 / scale);
      parent.add(mesh);
    }
    f.mesh = mesh; f.material = material;
  }
  private dropFilmMesh(f: Film) { if (!f.mesh) return; f.mesh.parent?.remove(f.mesh); f.mesh.geometry.dispose(); f.material?.dispose(); f.mesh = null; f.material = null; }
  private dropFilm(f: Film) { this.dropFilmMesh(f); f.tex.dispose(); }

  /** How long the room was left, once per opening. A new room has been lived in for no time at all. */
  private passTime(layout: Layout, created: boolean) {
    const now = this.clock();
    const day = localDay(now).key, last = this.life.lastVisit ? localDay(this.life.lastVisit).key : '';
    this.firstToday = day !== last;
    this.visitDay = day;
    if (!this.floor || !layout.room.visible) { this.life.at = now; return; }
    const away = created ? 0 : Math.max(0, now - this.life.at);
    if (away > 0) {
      this.floor.dry(away / 1000, .0045);
      this.films.forEach(f => f.field.dry(away / 1000, .006));
    }
    const tops = new Map<string, { field: GrimeField; surface: TopSurface }>();
    this.films.forEach((f, k) => tops.set(k, { field: f.field, surface: f.surface }));
    const before = this.life.webs.length;
    const r = created ? { days: 0, webs: 0, crumbs: 0 } : age(this.life, { floor: this.floor, tops, room: { size: layout.room.size, wallLeft: layout.room.wallLeft, wallRight: layout.room.wallRight }, objects: layout.objects }, now);
    if (r.days > 0) this.host.timePassed?.(r.days);
    if (this.glass && r.days > 0) { const k = Math.min(1, r.days / 20); for (let i = 0; i < this.glass.field.dust.length; i++) this.glass.field.dust[i] = Math.min(.3, this.glass.field.dust[i] + .3 * k); this.glass.field.rev++; this.glass.field.dustRev++; this.glass.field.solidRev++; }
    this.films.forEach(f => { if (!f.mesh && f.field.total('dust') > .001) this.filmMesh(f); });
    if (this.glass && !this.glass.mesh && this.glass.field.total('dust') > .001) this.filmMesh(this.glass);
    // A page that did not work out, now and then, on the floor by the desk.
    if (r.days >= 1 && this.life.settings.care !== 'off') {
      const have = layout.objects.filter(o => o.kind === 'trash.paper').length, desk = layout.objects.find(o => o.kind.startsWith('desk.') && !o.hidden);
      const seed = Math.abs(Math.sin(now / 86_400_000 * 12.9898) * 43758.5453) % 1;
      if (desk && have < 3 && seed < .5) {
        const x = desk.pos[0] + (seed - .25) * 2.4, z = desk.pos[2] + .9 + seed * .5, half = layout.room.size / 2 - .1;
        if (Math.abs(x) < half && Math.abs(z) < half) this.host.spawn({ id: this.host.uid(), kind: 'trash.paper', pos: [x, 0, z], rotY: seed * 6, scale: 1 });
      }
    }
    this.life.visits = (this.life.visits ?? 0) + 1; this.life.lastVisit = now;
    if (r.webs !== 0 || before !== this.life.webs.length || r.crumbs) this.crumbShown = -1;
    this.save(true);
  }

  // ── What tools do ───────────────────────────────────────────────────────────────────────────────────
  private changed() { this.dirty = true; this.lastChange = this.clock(); }
  /** Point on the floor, in the field's coordinates (the room is centred). */
  sweep(from: Vec2, to: Vec2, width: number) {
    const f = this.floor;
    if (!f) return 0;
    const moved = f.sweep(from, to, width);
    // Crumbs under the head go along with it, a little to the side at its ends.
    const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz);
    if (len > 1e-4) {
      const ux = dx / len, uz = dz / len, half = f.w / 2 - .03;
      for (const c of this.life.crumbs) {
        const ax = c.x - to.x, az = c.z - to.z, along = ax * ux + az * uz, across = -ax * uz + az * ux;
        if (Math.abs(across) < width / 2 + .012 && along > -len - .05 && along < .05) {
          c.x = Math.max(-half, Math.min(half, to.x + ux * (.05 + Math.random() * .025) + -uz * across * .96));
          c.z = Math.max(-half, Math.min(half, to.z + uz * (.05 + Math.random() * .025) + ux * across * .96));
          this.crumbRev++;
        }
      }
    }
    if (moved > 0 || this.crumbRev !== this.crumbShown) this.changed();
    this.air = Math.min(1, this.air + moved * .004);
    return moved;
  }
  /** Returns how much of the pan's room it took: dust as it is, a crumb as a bit of it. */
  scoop(at: Vec2, dir: Vec2, width: number, depth: number, room: number) {
    const f = this.floor;
    if (!f) return 0;
    let took = f.scoop(at, dir, width, depth, room);
    const keep: Crumb[] = [];
    for (const c of this.life.crumbs) {
      const dx = c.x - at.x, dz = c.z - at.z, along = dx * dir.x + dz * dir.z, across = -dx * dir.z + dz * dir.x;
      if (Math.abs(along) < depth / 2 && Math.abs(across) < width / 2 && took + .15 < room) { took += .15; this.crumbRev++; } else keep.push(c);
    }
    this.life.crumbs = keep;
    if (took > 0) this.changed();
    return took;
  }
  mop(from: Vec2, to: Vec2, width: number, depth: number, tool: { wet: number; load: number }, pressure = 1) {
    const f = this.floor;
    if (!f) return 0;
    const took = f.mop(from, to, width, depth, tool, pressure);
    // A wet mop takes small crumbs with it.
    const before = this.life.crumbs.length;
    this.life.crumbs = this.life.crumbs.filter(c => Math.hypot(c.x - to.x, c.z - to.z) > width * .5);
    if (before !== this.life.crumbs.length) { this.crumbRev++; tool.load = Math.min(1, tool.load + .01); }
    this.changed();
    return took;
  }
  film(key: string) { return key === 'glass' ? this.glass : this.films.get(key) ?? null; }
  /** Over a desk top or a pane. Dry it lifts dust; damp it works at stains as well, and soaks up water. Whatever a duster lifts comes down on the floor below. */
  wipe(f: Film, from: Vec2, to: Vec2, width: number, depth: number, tool: { wet: number; load: number } | null, falls: boolean) {
    if (tool && tool.wet > .08) f.field.mop(from, to, width, depth, tool, 1, f.surface.key !== 'glass' && tool.wet > .6);
    const lifted = f.field.dustOff(from, to, width, depth, tool ? .85 : .55);
    if (tool) tool.load = Math.min(1, tool.load + lifted * .03);
    if (falls && lifted > 0 && this.floor) {
      const s = f.surface, c = Math.cos(s.rotY), n = Math.sin(s.rotY), wx = s.x + c * to.x + n * to.z, wz = s.z - n * to.x + c * to.z;
      this.floor.stamp('dust', wx, wz, .2, lifted * .12, 1.4);
      // A little at a time: a duster raises motes, not a cloud that hides the desk.
      const now = performance.now();
      if (now - this.lastPuff > 90) { this.lastPuff = now; this.puffs.emit(wx, s.y, wz, Math.min(3, Math.ceil(lifted * 3)), 'dust'); }
      this.air = Math.min(1, this.air + lifted * .03);
    }
    if (!f.mesh && f.field.total('dust') + f.field.total('stain') > .001) this.filmMesh(f);
    this.changed();
    return lifted;
  }
  /** Soaks up water from the floor. */
  blot(at: Vec2, radius: number, tool: { wet: number; load: number }) {
    const f = this.floor;
    if (!f || !f.wetting) return 0;
    let soaked = 0;
    const room = Math.max(0, 1 - tool.wet);
    if (room <= 0) return 0;
    const cell = f.cell, cx = (at.x / f.w + .5) * f.nx - .5, cz = (at.z / f.d + .5) * f.nz - .5, r = radius / cell;
    for (let k = Math.floor(cz - r); k <= Math.ceil(cz + r); k++) for (let i = Math.floor(cx - r); i <= Math.ceil(cx + r); i++) {
      if (!f.inside(i, k) || Math.hypot(i - cx, k - cz) > r) continue;
      const a = f.at(i, k), t = Math.min(f.wet[a], .1);
      f.wet[a] -= t; soaked += t;
    }
    if (soaked > 0) { tool.wet = Math.min(1, tool.wet + soaked * .012); f.rev++; this.changed(); }
    return soaked;
  }
  /** The bristles on a web: it comes away a bit at a time, the way webs do. */
  brushWeb(id: string, amount: number) {
    const w = this.webs.get(id);
    if (!w) return false;
    w.web.k = Math.max(0, w.web.k - amount);
    w.material.alphaTest = .08 + (1 - w.web.k) * .62;
    w.material.opacity = .35 + w.web.k * .55;
    w.material.needsUpdate = false;
    if (w.web.k <= .04) { this.life.webs = this.life.webs.filter(q => q.id !== id); this.dropWeb(w); this.webs.delete(id); logEvent(this.life, 'web-gone', this.clock()); }
    this.changed();
    return true;
  }
  webNear(ray: T.Ray, far: number): { id: string; at: T.Vector3 } | null {
    let best: { id: string; at: T.Vector3 } | null = null, score = Infinity;
    const c = new T.Vector3(), normal = new T.Vector3(), plane = new T.Plane(), local = new T.Vector3();
    for (const [id, w] of this.webs) {
      // Work rays and rendered webs share stage coordinates. Intersect the
      // current swaying sheet so a ray passing beside it cannot clean air.
      normal.set(0, 0, 1).applyQuaternion(w.mesh.quaternion);
      plane.setFromNormalAndCoplanarPoint(normal, w.mesh.position);
      if (!ray.intersectPlane(plane, c)) continue;
      const distance = c.distanceTo(ray.origin);
      if (distance >= far || distance >= score) continue;
      local.copy(c).sub(w.mesh.position).applyQuaternion(w.mesh.quaternion.clone().invert());
      const half = w.web.size * .95;
      if (Math.abs(local.x) > half || Math.abs(local.y) > half) continue;
      score = distance; best = { id, at: c.clone() };
    }
    return best;
  }
  /** It spilled here. Amount is how much water; dirt is how much of it stays behind when it has dried. */
  spill(x: number, z: number, amount: number, dirt = 0) {
    const f = this.floor;
    if (!f) return;
    const r = .16 + Math.sqrt(amount) * .55;
    // Water finds its own way across boards: a body and a few tongues, never a circle.
    f.stamp('wet', x, z, r * .74, 1);
    const tongues = 4 + Math.round(amount * 4), turn = Math.random() * Math.PI * 2;
    for (let i = 0; i < tongues; i++) { const a = turn + i / tongues * Math.PI * 2 + (Math.random() - .5) * .7, d = r * (.5 + Math.random() * .5); f.stamp('wet', x + Math.cos(a) * d, z + Math.sin(a) * d, r * (.22 + Math.random() * .28), 1); }
    if (dirt > .02) f.stamp('stain', x, z, r * .75, dirt * .55);
    this.puffs.emit(x, .08, z, Math.min(16, 4 + amount * 14), 'drop');
    this.spilledAt = this.clock();
    logEvent(this.life, 'spill', this.spilledAt);
    this.changed();
  }
  /** Water that landed here: it stays exactly where it came down, however little it is. Litres. */
  wetFloor(x: number, z: number, litres: number, dirt = 0) {
    const f = this.floor;
    if (!f) return;
    f.stamp('wet', x, z, Math.min(.2, .055 + Math.sqrt(litres) * .42), Math.min(1, .18 + litres * 55));
    if (dirt > .02) f.stamp('stain', x, z, .06, dirt * .14);
    this.spilledAt = this.clock();
    this.changed();
  }
  /** The same on a desk or a shelf board, in its own axes. */
  wetFilm(film: Film, x: number, z: number, litres: number, dirt = 0) {
    film.field.stamp('wet', x, z, Math.min(.14, .045 + Math.sqrt(litres) * .34), Math.min(1, .2 + litres * 70));
    if (dirt > .02) film.field.stamp('stain', x, z, .05, dirt * .14);
    if (!film.mesh) this.filmMesh(film);
    this.changed();
  }
  drip(x: number, z: number) { this.floor?.stamp('wet', x, z, .05, .3); this.puffs.emit(x, .15, z, 1, 'drop'); this.changed(); }
  /** A foot came down here. */
  step(x: number, z: number) {
    const f = this.floor;
    if (!f) return;
    const wetHere = f.sample('wet', x, z), dustHere = f.sample('dust', x, z);
    if (wetHere > .22) this.soles = 8;
    else if (this.soles > 0) { f.stamp('wet', x, z, .075, .16 + this.soles * .035); this.soles--; this.changed(); }
    if (dustHere > 1) this.dustySoles = 5;
    else if (this.dustySoles > 0) { f.stamp('dust', x, z, .07, .05 + this.dustySoles * .03, .6); this.dustySoles--; this.changed(); }
    // Feet wear a path through dust, slowly.
    if (dustHere > .03 && dustHere < 1) { const cell = f.at(Math.max(0, Math.min(f.nx - 1, Math.round((x / f.w + .5) * f.nx - .5))), Math.max(0, Math.min(f.nz - 1, Math.round((z / f.d + .5) * f.nz - .5)))); f.dust[cell] *= .93; f.rev++; f.dustRev++; f.solidRev++; }
  }
  get wetSoles() { return this.soles > 3; }
  /** Furniture dragged over the floor ploughs the dust in front of it and marks the boards a little. */
  dragged(from: Vec2, to: Vec2, width: number) {
    const f = this.floor;
    if (!f) return;
    f.sweep(from, to, width, .5);
    const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz);
    if (len > .003) { for (const s of [-1, 1]) { const px = to.x - dz / len * width / 2 * s * .9, pz = to.z + dx / len * width / 2 * s * .9; f.stamp('stain', px, pz, .03, len * .1, .18); } this.changed(); }
  }
  /** A piece was moved for good: what hung from it does not. */
  moved(id: string) { if (dropWebsOf(this.life, id)) { this.syncWebs(); this.changed(); } }
  /** Lit where it is still dirty, for a moment: for the one who wants to finish the job. */
  showDirt(seconds = 3.2) { this.senseUntil = this.clock() + seconds * 1000; }
  get cleanliness() {
    return this.floor ? cleanliness(this.floor, [...this.films.values()].map(f => f.field), this.life.crumbs.length, this.life.webs.length) : 1;
  }

  // ── What is drawn ───────────────────────────────────────────────────────────────────────────────────
  private syncWebs() {
    const layout = this.host.layout();
    const wanted = layout?.room.visible ? this.life.webs : [];
    const ids = new Set(wanted.map(w => w.id));
    for (const [id, w] of this.webs) if (!ids.has(id)) { this.dropWeb(w); this.webs.delete(id); }
    for (const web of wanted) {
      if (this.webs.has(web.id)) continue;
      const material = new T.MeshBasicMaterial({ map: cobwebTexture(), transparent: true, depthWrite: false, side: T.DoubleSide, alphaTest: .08 + (1 - web.k) * .62, opacity: .35 + web.k * .55, toneMapped: false });
      const mesh = new T.Mesh(new T.PlaneGeometry(web.size * 1.9, web.size * 1.9), material);
      // Across the corner, its anchor up where the walls meet the ceiling, hanging a little forward.
      const out = new T.Vector3(Math.sin(web.ry), 0, Math.cos(web.ry));
      mesh.position.set(web.x, web.y, web.z).addScaledVector(out, web.size * .36).add(new T.Vector3(0, -web.size * .62, 0));
      mesh.rotation.set(0, web.ry, 0); mesh.rotateX(-.22);
      mesh.userData.noCollision = true; mesh.raycast = () => undefined; mesh.renderOrder = 5;
      this.group.add(mesh);
      this.webs.set(web.id, { mesh, material, web, sway: Math.random() * 6.28 });
    }
  }
  private dropWeb(w: { mesh: T.Mesh; material: T.Material }) { w.mesh.parent?.remove(w.mesh); w.mesh.geometry.dispose(); w.material.dispose(); }
  private drawCrumbs() {
    if (this.crumbShown === this.crumbRev && this.crumbShown !== -1) return;
    this.crumbShown = this.crumbRev;
    const list = this.life.crumbs, m = this.crumbMesh, tmp = this.crumbTmp, layout = this.host.layout();
    m.count = layout?.room.visible ? Math.min(MAX_CRUMBS, list.length) : 0;
    for (let i = 0; i < m.count; i++) {
      const c = list[i], s = c.kind === 1 ? .014 : c.kind === 2 ? .02 : .0062 + Math.abs(Math.sin(c.r * 7)) * .005;
      tmp.position.set(c.x, s * (c.kind ? .3 : .75), c.z); tmp.rotation.set(c.r, c.r * 2.1, c.r * .7);
      tmp.scale.set(s, c.kind ? s * .22 : s * .8, s * (c.kind ? .72 : 1)); tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      m.setColorAt(i, c.kind === 1 ? COLOR.paper : c.kind === 2 ? COLOR.leaf : COLOR.crumb);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
  /** A heap is grit and fluff, not stones: many small bits where the dust lies thick, more of them the more there is. Gated strictly on `dustRev` so water streams never rebuild clumps. */
  private drawHeaps(dt: number) {
    const f = this.floor;
    if (!f || f.dustRev === this.clumpRev) return;
    this.clumpWait -= dt;
    if (this.clumpWait > 0 && this.clumpMesh.count > 0) return;
    this.clumpWait = .11;
    this.clumpRev = f.dustRev;
    const m = this.clumpMesh, tmp = this.heapTmp, col = this.heapCol, sx = f.w / f.nx, sz = f.d / f.nz;
    const fract = (v: number) => v - Math.floor(v);
    let n = 0;
    for (let k = 0; k < f.nz && n < MAX_CLUMPS; k++) for (let i = 0; i < f.nx && n < MAX_CLUMPS; i++) {
      const d = f.dust[f.at(i, k)];
      if (d < .75) continue;
      const count = Math.min(16, Math.ceil(d * 4.2));
      for (let c = 0; c < count && n < MAX_CLUMPS; c++) {
        const h1 = fract(Math.sin(i * 12.9898 + k * 78.233 + c * 37.719) * 43758.5453), h2 = fract(Math.sin(i * 39.346 + k * 11.135 + c * 91.733) * 24634.6345), h3 = fract(Math.sin(i * 73.156 + k * 52.235 + c * 9.151) * 13758.937);
        const s = .0034 + h3 * h3 * .0105 + Math.min(.004, d * .0007);
        const px = (i + .5) / f.nx * f.w - f.w / 2 + (h1 - .5) * sx * 1.5, pz = (k + .5) / f.nz * f.d - f.d / 2 + (h2 - .5) * sz * 1.5;
        // Higher in the middle of a heap, the way loose stuff lies.
        tmp.position.set(px, s * .5 + h3 * Math.min(.024, d * .0048), pz);
        tmp.rotation.set(h1 * 6.28, h2 * 6.28, h3 * 6.28); tmp.scale.set(s * (1 + h2), s * .72, s * (1 + h1)); tmp.updateMatrix();
        m.setMatrixAt(n, tmp.matrix);
        const g = h3 < .16 ? .14 + h1 * .1 : .3 + h1 * .17;
        col.setRGB(g * 1.03, g, g * .93); m.setColorAt(n, col);
        n++;
      }
    }
    m.count = n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
  private clumpWait = 0;

  // ── Each frame ──────────────────────────────────────────────────────────────────────────────────────
  update(dt: number) {
    const layout = this.host.layout();
    const nowMs = typeof performance !== 'undefined' ? performance.now() : 0;
    this.floorTex?.refresh(nowMs);
    this.films.forEach(f => f.tex.refresh(nowMs));
    this.glass?.tex.refresh(nowMs);
    this.drawCrumbs();
    this.drawHeaps(dt);
    const reduced = this.host.reduced();
    this.puffs.update(dt, this.host.pixels());
    for (const w of this.webs.values()) if (!reduced) { w.sway += dt * (.5 + this.weather.wind); w.mesh.rotation.z = Math.sin(w.sway) * .012 * (1 + this.weather.wind * 3); }
    const senseWanted = this.clock() < this.senseUntil ? 1 : 0;
    if (Math.abs(this.sense.value - senseWanted) > .001) this.sense.value += (senseWanted - this.sense.value) * (1 - Math.exp(-dt * 7));
    else if (this.sense.value !== senseWanted) this.sense.value = senseWanted;
    this.tick += dt;
    if (this.tick < 1 || !layout) return;
    const seconds = this.tick; this.tick = 0;
    this.second(seconds, layout);
  }
  /** Once a second: the weather, water drying, the record, the stories. */
  private second(seconds: number, layout: Layout) {
    const now = this.clock(), view = layout.room.windowView, wants = this.life.settings.weather && layout.room.visible;
    const w = weatherAt(this.life.seed, now);
    this.weather = w;
    const rain = wants ? viewRain(view, w) : 0;
    this.rain = rain;
    const hasWindow = layout.room.visible && layout.room.wallRight;
    const open = !!layout.room.windowOpen, curtains = layout.room.curtains ?? 0;
    const room = this.host.room();
    room?.setWeather(rain, wants && hasWeather(view) ? w.wind : .1, open, w.sun, w.arc);
    if (!this.host.worldAudioActive?.() && this.life.settings.weatherSound === true && wants && hasWindow && hasWeather(view)) {
      this.sound.set(rain, w.wind, open, !this.host.reduced());
    } else this.sound.stop();
    // The rain comes in where the window is open, as far as the wind blows it. The curtain takes some of it.
    if (rain > .15 && open && hasWindow && this.floor) {
      const half = layout.room.size / 2, amount = rain * (1 - curtains * .7) * seconds;
      for (let i = 0; i < 3; i++) this.floor.stamp('wet', WINDOW.x0 + .3 + Math.random() * (WINDOW.x1 - WINDOW.x0 - .6), -half + .14 + Math.random() * (.2 + w.wind * .55), .2, .1 * amount, .9);
      this.changed();
    }
    const dry = .0045 * (open && rain < .1 ? 1.7 : 1) * seconds;
    if (this.floor?.dry(1, dry) && !this.floor.wetting) this.changed();
    this.films.forEach(f => f.field.dry(1, dry * 1.4));
    this.air *= Math.exp(-seconds * .12);
    if (this.floor && hasWindow) { const half = layout.room.size / 2; let sum = 0, n = 0; for (let x = WINDOW.x0; x <= WINDOW.x1; x += .25) for (let z = -half + .1; z < -half + 1; z += .2) { sum += this.floor.sample('wet', x, z) > .1 ? 1 : 0; n++; } this.atWindow = n ? sum / n * (WINDOW.x1 - WINDOW.x0) * .9 : 0; }
    // The hour moves the light, a little at a time.
    const light = view === 'live' ? w.sun * (1 - rain * .55) : rain;
    if (Math.abs(light - this.lastLight) > .012) { this.lastLight = light; this.host.lightChanged(); }
    if (this.dirty && now - this.lastChange > 1800) this.save(false);
    const facts = this.facts(layout, now, hasWindow, curtains, open, rain);
    const quiet = facts.busy || facts.onScreen || this.host.captionOn();
    const out = this.director.update(facts, quiet);
    if (out.memoryChanged) this.changed();
    if (out.line) this.host.caption(out.line);
  }
  private facts(layout: Layout, now: number, hasWindow: boolean, curtains: number, open: boolean, rain: number): Facts {
    const f = this.floor, day = localDay(now), extra = this.host.facts();
    const lampOn = layout.objects.some(o => !o.hidden && CATALOG_BY_ID[o.kind]?.light && o.lightOn !== false);
    return {
      now, hour: day.hour, weekend: day.weekday === 0 || day.weekday === 6, firstToday: this.firstToday, awayHours: 0, hasWindow, hasRoom: layout.room.visible && !!f,
      curtains, windowOpen: open, rain, wetUnderWindow: this.atWindow, wet: f ? f.area('wet', .1) : 0, dust: f ? f.dustIndex() : 0, clean: this.cleanliness,
      stains: f ? Math.round(f.area('stain', .1) / .2) : 0, crumbs: this.life.crumbs.length, webs: this.life.webs.length, heap: !!f?.heap(), hasKit: hasKit(layout.objects),
      lampOn, wetSoles: this.wetSoles, spilled: now - this.spilledAt < 4000, ...extra,
    };
  }
  /** The record goes with the layout. No step of Undo, a moment after the last change, never during one. */
  save(now: boolean) {
    if (!this.floor) return;
    if (!now && !this.dirty) return;
    this.dirty = false;
    this.life.at = this.clock();
    const tops: Record<string, ReturnType<GrimeField['encode']>> = {};
    this.films.forEach((f, k) => { if (f.field.total('dust') + f.field.total('stain') + f.field.total('wet') > .01) tops[k] = f.field.encode(); });
    if (this.glass && this.glass.field.total('dust') + this.glass.field.total('stain') > .01) tops.glass = this.glass.field.encode();
    this.life = { ...this.life, floor: this.floor.encode(), tops: Object.keys(tops).length ? tops : undefined };
    this.director.use(this.life);
    this.host.commit(this.life);
  }
  /** Settings changed from the panel. */
  useSettings(settings: RoomLife['settings']) {
    this.life = { ...this.life, settings };
    if (!settings.weather || !settings.weatherSound) this.sound.stop();
    this.director.use(this.life); this.changed();
  }
  silenceWeather() { this.sound.stop(); }
  /** Time passes faster for the room's own QA: nothing in production calls this. */
  advance(hours: number) { this.shift += hours * 3_600_000; const l = this.host.layout(); if (l) this.passTime(l, false); this.crumbShown = -1; this.syncWebs(); }
  dispose() {
    this.save(false);
    this.sound.stop();
    if (this.floorOwner && this.baseFloor) this.floorOwner.material = this.baseFloor;
    this.floorMat?.dispose(); this.floorTex?.dispose();
    this.films.forEach(f => this.dropFilm(f)); this.films.clear();
    if (this.glass) this.dropFilm(this.glass);
    this.webs.forEach(w => this.dropWeb(w)); this.webs.clear();
    forgetCobwebTexture();
    disposePrewarmedGrimeMaterials();
    this.puffs.dispose();
    this.warmFilmMesh.geometry.dispose();
    this.warmFilmMat.dispose();
    this.warmFilmTex.dispose();
    this.crumbMesh.geometry.dispose(); (this.crumbMesh.material as T.Material).dispose(); this.crumbMesh.dispose();
    this.clumpMesh.geometry.dispose(); (this.clumpMesh.material as T.Material).dispose(); this.clumpMesh.dispose();
    this.host.stage.remove(this.group);
  }
  toLocal(s: TopSurface, x: number, z: number) { return toLocal(s, x, z); }
}
export type { Film };
