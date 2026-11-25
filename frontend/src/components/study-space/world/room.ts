import * as T from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RoomConfig } from '@/lib/study-space/types';
import { WALL_HEIGHT } from '@/lib/study-space/layout';
import { mat, type MatKind } from './materials';
import { windowMaterial } from './windows';
import { buildInterior, type SideDoor } from './gateways';
import type { VfxTier } from '@/lib/vfx/quality';
import { patchMaterialWithEchoCsm } from './echoLife/echoCsm';
import { patchHeightFog } from './echoLife/atmosphere';

/**
 * The room shell: a floor slab on a lit plinth, the two back walls (left: x = -half, right: z = -half) with skirting,
 * a window cut into the right wall with its living view and blinds, and the room's particles. Every part can be
 * hidden on its own; the surfaces objects stand on or hang from are listed in `surfaces` for placement.
 */

export const WINDOW = { x0: -0.6, x1: 2.3, y0: 0.95, y1: 2.55 };
const THICK = 0.16;

export interface RoomBuild {
  group: T.Group;
  setDistant: (distant: boolean) => void;
  floor: T.Mesh | null;
  walls: { mesh: T.Object3D; axis: 'x' | 'z' }[];
  windowMat: T.ShaderMaterial | null;
  particles: T.Points | null;
  update: (t: number) => void;
  setExploring: (active: boolean, position: T.Vector3 | null, dt: number, reduced: boolean) => void;
  setWindowOpen: (open: boolean) => void;
  /** The casement handle nearest a world x, in world space. */
  windowHandle: (out: T.Vector3, nearX: number) => T.Vector3 | null;
  /** 0 drawn back, 1 across the window. */
  setCurtains: (k: number) => void;
  /** Rain on the glass, air through the window, the hour for a window that follows it. */
  setWeather: (rain: number, wind: number, open: boolean, sun: number, arc: number) => void;
  /** The inner edge of the curtain nearest a world x: where a hand takes it. Null in a room without curtains. */
  curtainEdge: (out: T.Vector3, nearX: number) => T.Vector3 | null;
  door: (id: 'arena' | 'games') => ReturnType<ReturnType<typeof buildInterior>['door']>;
  prepareVfx: (renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera, dt: number, tier: VfxTier, reduced: boolean) => void;
  dispose: () => void;
}

const FLOOR_KIND: Record<RoomConfig['floorStyle'], [MatKind, string]> = {
  oak: ['floorOak', '#e6c9a2'], walnut: ['floorWalnut', '#a8754f'], tile: ['floorTile', '#eef0f6'],
  carpet: ['floorCarpet', '#d9d4f2'], metal: ['floorMetal', '#cfd5e6'], marble: ['floorMarble', '#efeaf6'],
};

function roundedBoxGeo(w: number, h: number, d: number, x: number, y: number, z: number, r = 0.02) {
  const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.1, h / 2.1, d / 2.1));
  if (x || y || z) g.translate(x, y, z);
  return g;
}

function normalizeForMerge(g: T.BufferGeometry): T.BufferGeometry {
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new T.BufferAttribute(idx, 1));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}

function mergeStaticBatch(
  pieces: T.BufferGeometry[],
  material: T.Material,
  disposables: { dispose: () => void }[],
  opts?: { castShadow?: boolean; receiveShadow?: boolean; renderOrder?: number; roomWindow?: boolean },
): T.Mesh | null {
  if (!pieces.length) return null;
  let geo: T.BufferGeometry | null;
  if (pieces.length === 1) {
    geo = pieces[0];
  } else {
    pieces.forEach(normalizeForMerge);
    geo = mergeGeometries(pieces, false);
    pieces.forEach(g => g.dispose());
  }
  if (!geo) return null;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  disposables.push(geo);
  const mesh = new T.Mesh(geo, material);
  mesh.castShadow = opts?.castShadow ?? true;
  mesh.receiveShadow = opts?.receiveShadow ?? true;
  if (opts?.renderOrder !== undefined) mesh.renderOrder = opts.renderOrder;
  if (opts?.roomWindow) mesh.userData.roomWindow = true;
  return mesh;
}

function box(w: number, h: number, d: number, m: T.Material, x: number, y: number, z: number, r = 0.02) {
  const mesh = new T.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.1, h / 2.1, d / 2.1)), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildRoom(cfg: RoomConfig, reduced: boolean, sideDoor: SideDoor | null = null): RoomBuild {
  const group = new T.Group();
  group.name = 'room';
  const half = cfg.size / 2;
  const disposables: { dispose: () => void }[] = [];
  const wallM = mat('wall', cfg.wallColor);
  const trimM = mat('trim', '#fbf9ff');
  const accent = mat('glow', cfg.accentColor, '1.5');
  let floor: T.Mesh | null = null;
  const walls: RoomBuild['walls'] = [];
  const facadeParts: T.BufferGeometry[] = [];
  let windowMat: T.ShaderMaterial | null = null;
  const sashes: { pivot: T.Group; side: number; crank: T.Group; grip: T.Object3D; latch: T.Object3D }[] = [];
  const curtains: { mesh: T.Mesh; side: number; outer: number; closedWidth: number }[] = [];
  let sashTarget = 0, sashAngle = 0, air = 0, swayAt = 0;

  if (cfg.base) {
    const plinth = box(cfg.size + 0.3, 0.32, cfg.size + 0.3, mat('paint', '#f4f2fb'), 0, -0.2, 0, 0.08);
    plinth.castShadow = false;
    group.add(plinth);
    const strip = new T.Mesh(new T.BoxGeometry(cfg.size + 0.32, 0.03, cfg.size + 0.32), accent);
    strip.position.y = -0.33;
    group.add(strip);
    disposables.push(plinth.geometry, strip.geometry);
  }
  if (cfg.floor) {
    const [kind, color] = FLOOR_KIND[cfg.floorStyle];
    floor = box(cfg.size, 0.08, cfg.size, mat(kind, color), 0, -0.04, 0, 0.02);
    floor.castShadow = false;
    floor.name = 'floor';
    group.add(floor);
    disposables.push(floor.geometry);
  }

  const wallPiece = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    facadeParts.push(new T.BoxGeometry(w, h, d).translate(x, y, z));
    return roundedBoxGeo(w, h, d, x, y, z, 0.015);
  };

  if (cfg.wallLeft) {
    const left = new T.Group();
    const leftWallMesh = mergeStaticBatch(
      [wallPiece(THICK, WALL_HEIGHT, cfg.size, -half - THICK / 2, WALL_HEIGHT / 2, 0)],
      wallM,
      disposables,
    );
    if (leftWallMesh) left.add(leftWallMesh);
    const leftTrimMesh = mergeStaticBatch(
      [
        roundedBoxGeo(0.03, 0.12, cfg.size - 0.03, -half + 0.015, 0.06, 0.015, 0.01),
        roundedBoxGeo(THICK + 0.04, 0.05, cfg.size + 0.02, -half - THICK / 2, WALL_HEIGHT + 0.02, 0.01, 0.015),
      ],
      trimM,
      disposables,
    );
    if (leftTrimMesh) left.add(leftTrimMesh);
    // Architectural joinery belongs to the removable room shell, never to an invisible permanent foreground.
    const joinery = mat('wood', cfg.theme === 'library' ? '#614330' : cfg.theme === 'rain' ? '#a87c56' : '#a9bed4');
    if (cfg.theme !== 'station') {
      const joineryPieces: T.BufferGeometry[] = [];
      for (let i = 0; i < 8; i++) {
        joineryPieces.push(roundedBoxGeo(.035, .72, .055, -half + .025, .42, -half + .2 + i * (cfg.size - .4) / 7, .009));
      }
      joineryPieces.push(roundedBoxGeo(.045, .065, cfg.size, -half + .03, .79, 0, .015));
      const joineryMesh = mergeStaticBatch(joineryPieces, joinery, disposables);
      if (joineryMesh) left.add(joineryMesh);
    } else {
      const panelPieces: T.BufferGeometry[] = [];
      const insetPieces: T.BufferGeometry[] = [];
      for (let i = 0; i < 4; i++) {
        const pz = -half + .75 + i * (cfg.size - 1.5) / 3;
        panelPieces.push(roundedBoxGeo(.10, 2.68, 1.24, -half + .01, 1.40, pz, .12));
        insetPieces.push(roundedBoxGeo(.12, 2.30, .99, -half + .05, 1.40, pz, .10));
      }
      const panelMesh = mergeStaticBatch(panelPieces, mat('metal', '#b5bfd7'), disposables);
      const insetMesh = mergeStaticBatch(insetPieces, mat('paint', '#dbe3f0'), disposables);
      if (panelMesh) left.add(panelMesh);
      if (insetMesh) left.add(insetMesh);
    }
    left.name = 'wall-x';
    group.add(left);
    walls.push({ mesh: left, axis: 'x' });
  }
  if (cfg.wallRight) {
    const right = new T.Group();
    const { x0, x1, y0, y1 } = WINDOW;
    const z = -half - THICK / 2;
    const rightWallMesh = mergeStaticBatch(
      [
        wallPiece(x0 + half, WALL_HEIGHT, THICK, (-half + x0) / 2, WALL_HEIGHT / 2, z),
        wallPiece(half - x1, WALL_HEIGHT, THICK, (x1 + half) / 2, WALL_HEIGHT / 2, z),
        wallPiece(x1 - x0, y0, THICK, (x0 + x1) / 2, y0 / 2, z),
        wallPiece(x1 - x0, WALL_HEIGHT - y1, THICK, (x0 + x1) / 2, (WALL_HEIGHT + y1) / 2, z),
      ],
      wallM,
      disposables,
    );
    if (rightWallMesh) right.add(rightWallMesh);
    // Window: frame, mullion, sill, living view, blinds.
    const frameM = mat('trim', cfg.theme === 'library' ? '#a78048' : cfg.theme === 'rain' ? '#c4a784' : cfg.theme === 'station' ? '#67718c' : '#e0eaf4');
    const fw = x1 - x0, fh = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const staticFramePieces: T.BufferGeometry[] = [
      roundedBoxGeo(fw + 0.1, 0.06, 0.2, cx, y1, z + 0.02),
      roundedBoxGeo(fw + 0.16, 0.06, 0.3, cx, y0, z + 0.08),
      roundedBoxGeo(0.06, fh, 0.2, x0, cy, z + 0.02),
      roundedBoxGeo(0.06, fh, 0.2, x1, cy, z + 0.02),
      roundedBoxGeo(fw + 0.12, 0.06, 0.08, cx, y1 + 0.02, z + 0.12, 0.02),
    ];
    // The living view hangs further out than the sashes' swing, and larger, so an open window never shows its edge.
    windowMat = windowMaterial(cfg.windowView, fw / fh);
    const view = new T.Mesh(new T.PlaneGeometry(fw * 1.7, fh * 1.7), windowMat);
    view.position.set(cx, cy, z - 0.86);
    view.name = 'window-view';
    view.userData.roomWindow = true;
    right.add(view);
    disposables.push(view.geometry, windowMat);
    // Two fixed side lights and a pair of real casements in the middle, hinged on their outer stiles, opening outward: nothing in the room is in their way.
    const sashW = Math.min(.66, fw / 4), sashH = fh - .05, glassM = mat('glass', '#d8ecfa');
    const brassM = mat('brass', '#c3a67b');
    const fixedGlassPieces: T.BufferGeometry[] = [];
    const spindlePieces: T.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const fixedW = fw / 2 - sashW;
      const fixedX = cx + side * (sashW + fixedW / 2);
      const fixedGeo = new T.PlaneGeometry(fixedW, fh);
      fixedGeo.translate(fixedX, cy, z + 0.03);
      fixedGlassPieces.push(fixedGeo);
      staticFramePieces.push(
        roundedBoxGeo(0.04, fh, 0.09, cx + side * sashW, cy, z + 0.02),
        roundedBoxGeo(fixedW, 0.03, 0.07, fixedX, cy + 0.15, z + 0.02),
      );
      const pivot = new T.Group();
      pivot.position.set(cx + side * (sashW - .02), cy, z + 0.02);
      const dir = -side;
      const pane = new T.Mesh(new T.PlaneGeometry(sashW - .05, sashH - .05), glassM);
      pane.position.set(dir * (sashW - .02) / 2, 0, .012);
      pane.castShadow = false;
      pane.receiveShadow = false;
      pane.renderOrder = 2;
      disposables.push(pane.geometry);
      const sashFrame = mergeStaticBatch(
        [
          roundedBoxGeo(0.036, sashH, 0.05, 0.018 * dir, 0, 0),
          roundedBoxGeo(0.036, sashH, 0.05, dir * (sashW - .04), 0, 0),
          roundedBoxGeo(sashW - .02, 0.036, 0.05, dir * (sashW - .02) / 2, sashH / 2 - .018, 0),
          roundedBoxGeo(sashW - .02, 0.036, 0.05, dir * (sashW - .02) / 2, -sashH / 2 + .018, 0),
          roundedBoxGeo(sashW - .05, 0.024, 0.04, dir * (sashW - .02) / 2, 0.15, 0),
        ],
        frameM,
        disposables,
        { roomWindow: true },
      );
      const latch = box(0.02, 0.12, 0.03, brassM, dir * (sashW - .065), -.04, .03);
      disposables.push(latch.geometry);
      if (sashFrame) pivot.add(sashFrame);
      pivot.add(pane, latch);
      pivot.traverse((o) => { o.userData.roomWindow = true; });
      right.add(pivot);
      // The latch swings outdoors with its leaf. The return crank stays on
      // the interior face of the fixed mullion, clear of the desk.
      const crank = new T.Group();
      crank.position.set(cx + side * sashW, cy - .12, z + .125);
      const crankMesh = mergeStaticBatch(
        [
          roundedBoxGeo(.095, .022, .025, .04, 0, .01, .006),
          roundedBoxGeo(.027, .03, .065, .084, 0, .045, .009),
        ],
        brassM,
        disposables,
        { roomWindow: true },
      );
      const grip = new T.Object3D();
      grip.position.set(.084, 0, .045);
      if (crankMesh) crank.add(crankMesh);
      crank.add(grip);
      crank.traverse(o => { o.userData.roomWindow = true; });
      right.add(crank);
      spindlePieces.push(roundedBoxGeo(.045, .05, .09, crank.position.x, crank.position.y, z + .085, .006));
      sashes.push({ pivot, side, crank, grip, latch });
    }
    const frameBatchMesh = mergeStaticBatch(staticFramePieces, frameM, disposables);
    if (frameBatchMesh) right.add(frameBatchMesh);
    const fixedGlassMesh = mergeStaticBatch(fixedGlassPieces, glassM, disposables, {
      castShadow: false,
      receiveShadow: false,
      renderOrder: 2,
      roomWindow: true,
    });
    if (fixedGlassMesh) right.add(fixedGlassMesh);
    const spindleMesh = mergeStaticBatch(spindlePieces, brassM, disposables, { roomWindow: true });
    if (spindleMesh) right.add(spindleMesh);

    const slatCount = cfg.theme === 'station' || cfg.theme === 'library' ? 0 : 9;
    if (slatCount > 0) {
      const slatPieces: T.BufferGeometry[] = [];
      for (let i = 0; i < slatCount; i++) {
        const sGeo = new T.BoxGeometry(fw + 0.08, 0.018, 0.05);
        sGeo.rotateX(0.5);
        sGeo.translate(cx, y1 - 0.06 - i * 0.034, z + 0.12);
        slatPieces.push(sGeo);
      }
      const blindsMesh = mergeStaticBatch(slatPieces, mat('paint', '#fbfaff'), disposables, {
        castShadow: true,
        receiveShadow: false,
      });
      if (blindsMesh) right.add(blindsMesh);
    }
    if (cfg.theme === 'library') {
      const points = Array.from({ length: 33 }, (_, i) => new T.Vector3(cx + fw * .52 * Math.cos(i / 32 * Math.PI), y1 - .12 + .40 * Math.sin(i / 32 * Math.PI), z + .16));
      const arch = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(points), 48, .055, 8, false), mat('metal', '#b99755'));
      arch.castShadow = true; right.add(arch); disposables.push(arch.geometry);
      const colMesh = mergeStaticBatch(
        [x0 - .09, x1 + .09].map(x => roundedBoxGeo(.13, fh + .10, .16, x, cy, z + .12, .035)),
        mat('wood', '#67452e'),
        disposables,
      );
      if (colMesh) right.add(colMesh);
    } else if (cfg.theme === 'station') {
      // Rounded structural pressure frame and fastening sockets, with restrained emission inside the recess.
      const bracePieces: T.BufferGeometry[] = [
        roundedBoxGeo(fw + .4, .20, .24, cx, y1 + .10, z + .10, .09),
      ];
      const boltPieces: T.BufferGeometry[] = [];
      for (const x of [x0 - .1, x1 + .1]) {
        bracePieces.push(roundedBoxGeo(.22, fh + .30, .24, x, cy, z + .10, .09));
        for (const y of [y0 + .12, y1 - .12]) {
          const bGeo = new T.CylinderGeometry(.035, .035, .025, 12);
          bGeo.rotateX(Math.PI / 2);
          bGeo.translate(x, y, z + .24);
          boltPieces.push(bGeo);
        }
      }
      const braceMesh = mergeStaticBatch(bracePieces, mat('metal', '#59647f'), disposables);
      const boltMesh = mergeStaticBatch(boltPieces, mat('metal', '#a5b3ce'), disposables, { castShadow: false, receiveShadow: false });
      if (braceMesh) right.add(braceMesh);
      if (boltMesh) right.add(boltMesh);
    } else {
      const fabric = mat('fabric', cfg.theme === 'rain' ? '#987b65' : '#789cbd');
      for (const side of [-1, 1]) {
        const geom = new T.PlaneGeometry(.34, fh + .10, 14, 12); const a = geom.attributes.position;
        for (let i = 0; i < a.count; i++) { const px = a.getX(i); a.setZ(i, Math.sin((px + .17) * Math.PI * 6 / .34) * .035); }
        geom.computeVertexNormals(); const curtain = new T.Mesh(geom, fabric); curtain.position.set(side < 0 ? x0 + .08 : x1 - .08, cy, z + .18); curtain.castShadow = true; curtain.receiveShadow = true; curtain.userData.curtain = true; right.add(curtain); disposables.push(geom);
        curtains.push({ mesh: curtain, side, outer: side < 0 ? x0 - .09 : x1 + .09, closedWidth: fw / 2 + .1 });
      }
    }
    const rightTrimMesh = mergeStaticBatch(
      [
        roundedBoxGeo(cfg.size - 0.03, 0.12, 0.03, 0.015, 0.06, -half + 0.015, 0.01),
        roundedBoxGeo(cfg.size + THICK + 0.04, 0.05, THICK + 0.04, -THICK / 2, WALL_HEIGHT + 0.02, z, 0.015),
      ],
      trimM,
      disposables,
    );
    if (rightTrimMesh) right.add(rightTrimMesh);
    right.name = 'wall-z';
    group.add(right);
    walls.push({ mesh: right, axis: 'z' });
  }
  if (cfg.wallLeft && cfg.wallRight) {
    const corner = box(THICK, WALL_HEIGHT, THICK, wallM, -half - THICK / 2, WALL_HEIGHT / 2, -half - THICK / 2, 0.01);
    group.add(corner);
    disposables.push(corner.geometry);
  }

  // Particles: bubbles rise, motes drift, stars twinkle. Soft round sprites drawn by a tiny shader.
  let particles: T.Points | null = null;
  if (cfg.particles !== 'none' && !reduced) {
    const n = cfg.particles === 'bubbles' ? 40 : cfg.particles === 'motes' ? 70 : 90;
    const pos = new Float32Array(n * 3), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * cfg.size * 0.95;
      pos[i * 3 + 1] = Math.random() * WALL_HEIGHT;
      pos[i * 3 + 2] = (Math.random() - 0.5) * cfg.size * 0.95;
      seed[i] = Math.random();
    }
    const geom = new T.BufferGeometry();
    geom.setAttribute('position', new T.BufferAttribute(pos, 3));
    geom.setAttribute('seed', new T.BufferAttribute(seed, 1));
    const color = cfg.particles === 'bubbles' ? new T.Color('#cfe6ff') : cfg.particles === 'motes' ? new T.Color('#ffe2a8') : new T.Color('#dfe6ff');
    const pm = new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: { value: color }, uKind: { value: cfg.particles === 'bubbles' ? 0 : cfg.particles === 'motes' ? 1 : 2 }, uH: { value: WALL_HEIGHT }, uScale: { value: 1 } },
      vertexShader: `attribute float seed; uniform float uTime; uniform int uKind; uniform float uH; uniform float uScale; varying float vA; varying float vS;
        void main(){ vec3 p=position; float t=uTime*(0.4+seed*0.6);
          if(uKind==0){ p.y=mod(p.y+t*0.25,uH); p.x+=sin(t+seed*20.)*0.08; vA=smoothstep(0.,0.3,p.y)*smoothstep(uH,uH-0.6,p.y); }
          else if(uKind==1){ p+=vec3(sin(t*0.5+seed*30.),sin(t*0.3+seed*10.)*0.5,cos(t*0.4+seed*20.))*0.3; vA=0.5+0.5*sin(t*2.+seed*40.); }
          else { vA=0.35+0.65*abs(sin(t*1.5+seed*60.)); }
          vS=seed; vec4 mv=modelViewMatrix*vec4(p,1.); gl_Position=projectionMatrix*mv;
          gl_PointSize=(uKind==0?(3.+seed*6.):(2.+seed*4.))*uScale; }`,
      fragmentShader: `uniform vec3 uColor; uniform int uKind; varying float vA; varying float vS;
        void main(){ vec2 d=gl_PointCoord-.5; float r=length(d); if(r>.5) discard;
          float a=uKind==0? (smoothstep(.5,.4,r)*smoothstep(.25,.45,r)*0.55+smoothstep(.2,.0,length(d-vec2(-.12,-.12)))*0.35) : smoothstep(.5,0.,r);
          gl_FragColor=vec4(uColor,a*vA*0.6); }`,
    });
    particles = new T.Points(geom, pm);
    particles.frustumCulled = false;
    group.add(particles);
    disposables.push(geom, pm);
  }

  const interior = buildInterior(cfg, sideDoor);
  group.add(interior.group);
  disposables.push(interior);
  // Preserve the actual wall outline, opening and room colour from across the street.
  // Interior casements, handles, portals and room particles live only in the near group.
  const facade = new T.Group();
  facade.name = 'study-exterior';
  if (facadeParts.length) {
    const shell = mergeGeometries(facadeParts)!;
    facadeParts.forEach(g => g.dispose());
    facade.add(new T.Mesh(shell, wallM));
    disposables.push(shell);
  }
  if (cfg.wallRight) {
    const pane = new T.PlaneGeometry(WINDOW.x1-WINDOW.x0, WINDOW.y1-WINDOW.y0);
    const glass = new T.MeshStandardMaterial({color:0x8299ad, roughness:.23, metalness:.3, side:T.DoubleSide});
    const mesh = new T.Mesh(pane,glass);
    mesh.position.set((WINDOW.x0+WINDOW.x1)/2,(WINDOW.y0+WINDOW.y1)/2,-half-THICK/2);
    facade.add(mesh);
    disposables.push(pane,glass);
  }
  facade.visible = false;
  const lightGroup = new T.Group();
  lightGroup.name = 'room-lights';
  lightGroup.visible = true;
  const root = new T.Group();
  root.add(group, facade, lightGroup);

  // Creation-time CSM + height-fog patching on all room & interior standard/physical materials
  // so Overview <-> Study Room <-> Lantern Street never triggers shader cache-key drift.
  const patchedMats = new Set<T.Material>();
  root.traverse((obj) => {
    const mesh = obj as T.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      if (!m || patchedMats.has(m)) continue;
      if (m instanceof T.MeshStandardMaterial) {
        patchedMats.add(m);
        patchMaterialWithEchoCsm(m);
        patchHeightFog(m);
      }
    }
  });

  // Reparent every `T.Light` inside `group` / `interior.group` (e.g. `LiquidPortal` PointLights) onto
  // permanently-visible `lightGroup` so `group.visible = !distant` & `interior.group.visible = active`
  // NEVER mutate `NUM_POINT_LIGHTS` (zero shader recompiles when entering/exiting the Study Room!).
  root.updateMatrixWorld(true);
  const detachedLights: { light: T.Light; savedIntensity: number }[] = [];
  const lightsToMove: T.Light[] = [];
  group.traverse((obj) => {
    if ((obj as T.Light).isLight) lightsToMove.push(obj as T.Light);
  });
  for (let i = 0; i < lightsToMove.length; i++) {
    const l = lightsToMove[i];
    const saved = l.intensity;
    lightGroup.attach(l);
    l.visible = true;
    l.intensity = 0;
    detachedLights.push({ light: l, savedIntensity: saved });
  }

  let isDistant = false;
  let isExploringActive = false;
  const syncDetachedLightSilence = () => {
    lightGroup.visible = true;
    const silent = isDistant || !isExploringActive;
    for (let i = 0; i < detachedLights.length; i++) {
      const entry = detachedLights[i];
      entry.light.visible = true;
      if (silent) {
        if (entry.light.intensity > 0) entry.savedIntensity = entry.light.intensity;
        entry.light.intensity = 0;
      } else if (entry.light.intensity === 0 && entry.savedIntensity > 0) {
        entry.light.intensity = entry.savedIntensity;
      }
    }
  };

  return {
    group: root, floor, walls, windowMat, particles,
    setDistant(distant) {
      isDistant = distant;
      group.visible = !distant;
      facade.visible = distant;
      syncDetachedLightSilence();
    },
    prepareVfx: interior.prepare,
    setExploring: (active, position, dt, reduced) => {
      isExploringActive = active;
      interior.update(active, position, dt, reduced);
      syncDetachedLightSilence();
      // A heavy casement on its hinges: it eases open and comes to rest, and draws nothing new once it has.
      sashAngle = reduced ? sashTarget : sashAngle + (sashTarget - sashAngle) * (1 - Math.exp(-3.4 * dt));
      for (const s of sashes) {
        s.pivot.rotation.y = -s.side * sashAngle;
        s.crank.rotation.z = s.side * sashAngle * 3;
      }
      // Air through an open window moves the cloth: a slow breath, and more with more wind.
      if (curtains.length && !reduced) { swayAt += dt * (.8 + air * 1.6); const lift = air * .1; curtains.forEach((c, i) => { c.mesh.rotation.x = -lift * (.6 + .4 * Math.sin(swayAt + i * 1.7)) - lift * .25 * Math.sin(swayAt * 2.3 + i); }); }
    },
    setWindowOpen: (open) => { sashTarget = open ? 1.12 : 0; },
    setWeather: (rain, wind, open, sun, arc) => {
      if (windowMat) { windowMat.uniforms.uRain.value = rain; windowMat.uniforms.uSun.value = sun; windowMat.uniforms.uArc.value = arc; }
      air = open ? wind : wind * .08;
    },
    setCurtains: (k) => {
      for (const c of curtains) {
        // Gathered at the side, or spread to the middle: the cloth widens from its outer edge.
        const w = .34 + (c.closedWidth - .34) * k;
        c.mesh.scale.x = w / .34;
        c.mesh.position.x = c.outer + (c.side < 0 ? 1 : -1) * w / 2;
      }
    },
    curtainEdge: (out, nearX) => {
      if (!curtains.length) return null;
      let best: T.Vector3 | null = null;
      for (const c of curtains) {
        const inner = c.mesh.position.x - (c.side < 0 ? -1 : 1) * .17 * c.mesh.scale.x;
        const p = c.mesh.localToWorld(new T.Vector3(c.side < 0 ? .17 : -.17, -.12, .02));
        void inner;
        if (!best || Math.abs(p.x - nearX) < Math.abs(best.x - nearX)) best = p;
      }
      return out.copy(best!);
    },
    windowHandle: (out, nearX) => {
      if (!sashes.length) return null;
      let best: T.Vector3 | null = null;
      for (const s of sashes) {
        const p = (sashTarget > 0 ? s.grip : s.latch).getWorldPosition(new T.Vector3());
        if (!best || Math.abs(p.x - nearX) < Math.abs(best.x - nearX)) best = p;
      }
      return out.copy(best!);
    },
    door: (id) => interior.door(id),
    update: (t) => {
      if (windowMat) windowMat.uniforms.uTime.value = t;
      if (particles) (particles.material as T.ShaderMaterial).uniforms.uTime.value = t;
    },
    dispose: () => {
      lightGroup.removeFromParent();
      disposables.forEach((d) => d.dispose());
    },
  };
}
