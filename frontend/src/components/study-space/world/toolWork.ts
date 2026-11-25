import * as T from 'three';
import type { GraspShape, HandContact } from '@/lib/embodiment/human';
import { wristStrain } from '@/lib/embodiment/arms';
import { GraspFrame } from '@/lib/embodiment/graspFrame';
import { surfaceOf } from '@/lib/embodiment/grasp';
import { Scrape } from '@/lib/embodiment/contactAudio';
import { PAN_ROOM, toolOf, type ToolSpec } from '@/lib/study-space/tools';
import type { ObjectState, SpaceObject } from '@/lib/study-space/types';
import type { LifeWorld } from './lifeWorld';
import type { Character } from './character';
import type { Exploration } from './exploration';
import type { StudyPhysics } from './physics';
import type { Placed } from './manipulation';
import { chainMaterialShader, patchMaterialWithEchoCsm } from './echoLife/echoCsm';

/**
 * A cleaning tool in the hands. Its head goes where the eyes are on, with the weight of the thing and no faster than an arm moves it, stopping at what is in its way; its handle
 * leads back to the body and the hands are on the handle, wherever that is this frame. What it does to a surface comes from how the head moved while it was pressed down, so
 * cleaning happens only where the tool has really been. Nothing here reads a button: `press` is told.
 */
export interface ToolHost {
  stage: T.Group;
  character(): Character | null;
  exploration: Exploration;
  physics(): StudyPhysics | null;
  life(): LifeWorld;
  reduced(): boolean;
  /** Small changes to a tool's own state: no step of Undo. */
  saveState(id: string, state: ObjectState): void;
  object(id: string): SpaceObject | undefined;
  /** The free hand is doing something else right now. */
  handBusy(): boolean;
  preparing?(): boolean;
  /** Called after the torso is finalized; the fixed acquired grasp bounds the request. */
  fitPose?(p: Placed, side: number, position: T.Vector3, rotation: T.Quaternion, dt: number): { position: T.Vector3; rotation: T.Quaternion };
}
type Touching = { kind: 'floor' } | { kind: 'top' | 'glass'; key: string } | { kind: 'web'; id: string } | null;

/** Where a handle crosses the palm, metres from the wrist along the hand: the distal palmar crease of the cast (knuckles at 81-97 mm). */
const GRIP_ALONG = .072;
/** How far a handle crosses the palm from square: parallel to the knuckle line (index knuckle 97 mm, little 81 mm from the wrist, 62 mm apart: 14.5 degrees), so every finger closes on it. Radians. */
const GRIP_OBLIQUE = .25;
/** Hysteresis window before switching between locomotion carry and floor-ready posture (seconds). */
const CARRY_HYSTERESIS_SEC = .16;
/** Characteristic time constant so a 0..1 carry/work posture transition settles over ~0.18 s. */
const CARRY_BLEND_TAU = .06;

const UP = new T.Vector3(0, 1, 0);
const X_AXIS = new T.Vector3(1, 0, 0);

// ── Zero-GC module scratch pool for hot per-frame methods ──
const v1 = new T.Vector3(), v2 = new T.Vector3(), v3 = new T.Vector3();
const _hfUp = new T.Vector3(), _hfAt = new T.Vector3(), _hfFace = new T.Vector3(), _hfRight = new T.Vector3();
const _hfShoulder = new T.Vector3(), _hfToward = new T.Vector3(), _hfInward = new T.Vector3(), _hfAxis = new T.Vector3();
const _gwLocal = new T.Vector3(), _gwPoint = new T.Vector3(), _gwAxis = new T.Vector3(), _gwScale = new T.Vector3();
const _gwRay = new T.Ray(new T.Vector3(), new T.Vector3(-1, 0, 0));
const _handInv = new T.Matrix4();
const _secStage = new T.Matrix4(), _secCompose = new T.Matrix4(), _secDelta = new T.Vector3();
const _upFace = new T.Vector3(), _upRight = new T.Vector3(), _upStanding = new T.Vector3();
const _upWant = new T.Vector3(), _upTarget = new T.Vector3(), _upCarried = new T.Vector3();
const _upChest = new T.Vector3(), _upCarryHead = new T.Vector3(), _upCarryChest = new T.Vector3();
const _upHold = new T.Vector3(), _upDown = new T.Vector3(), _upAim = new T.Vector3(), _upIdeal = new T.Vector3();
const _upShoulders = new T.Vector3(), _upUpper = new T.Vector3(), _upOutside = new T.Vector3(), _upNormal = new T.Vector3();
const _upBentMid = new T.Vector3(), _upShaft = new T.Vector3(), _upBounds = new T.Box3();
const _upStageQ = new T.Quaternion(), _upCarriedQ = new T.Quaternion(), _upCarriedAxis = new T.Vector3(), _upTmpQ = new T.Quaternion();
const _upMoveHead = new T.Vector3(), _upStroke = new T.Vector3(), _upClearOut = new T.Vector3();
const _fsFace = new T.Vector3(), _fsRight = new T.Vector3(), _fsSh0 = new T.Vector3(), _fsSh1 = new T.Vector3();
const _fsOff0 = new T.Vector3(), _fsOff1 = new T.Vector3(), _fsCarried = new T.Quaternion(), _fsCarriedAxis = new T.Vector3();
const _fsPos = new T.Vector3(), _fsAxis = new T.Vector3(), _fsQ = new T.Quaternion(), _fsWrist = new T.Vector3();
const _fsToWrist = new T.Vector3(), _fsChestGoal = new T.Vector3();
const _apFace = new T.Vector3(), _apRight = new T.Vector3(), _apDelta = new T.Vector3();
const _apFrom = new T.Vector3(), _apTo = new T.Vector3(), _apTip = new T.Vector3();
const _apAxis = new T.Vector3(), _apPoint = new T.Vector3(), _apInvQ = new T.Quaternion(), _apLocal = new T.Vector3();
const _apTouchDiff = new T.Vector3();
const _rmQ = new T.Quaternion();
const _ccForward = new T.Vector3(), _ccRight = new T.Vector3(), _ccUpper = new T.Vector3(), _ccAxis = new T.Vector3();
const _ccPrevAxis = new T.Vector3(), _ccSwingQ = new T.Quaternion();
const _ccPitchQ = new T.Quaternion(), _ccYawQ = new T.Quaternion(), _ccBaseQ = new T.Quaternion();
const _tcTip = new T.Vector3();
const _ptA = { x: 0, z: 0 }, _ptB = { x: 0, z: 0 }, _ptScoopAt = { x: 0, z: 0 }, _ptScoopDir = { x: 0, z: 0 };
const _filmPt1 = { x: 0, z: 0 }, _filmPt2 = { x: 0, z: 0 };
const _mopToolState = { wet: 0, load: 0 };

/**
 * Enforces strict horizontal body-capsule clearance (`minRadius >= 0.24 m`) along the entire
 * finite shaft `P(s) = pos + s * axis`, `s in [0, length]`, in stage-local coordinates with
 * zero heap allocations. When `keepHeadGrounded` is true, tilts the upper shaft away from the
 * torso first before translating `pos` if the lower end also approaches the legs.
 */
function enforceShaftTorsoClearance(
  pos: T.Vector3,
  axis: T.Vector3,
  length: number,
  bodyPos: T.Vector3,
  face: T.Vector3,
  right: T.Vector3,
  side: number,
  minRadius = .25,
  keepHeadGrounded = false,
) {
  for (let pass = 0; pass < 2; pass++) {
    const rx = pos.x - bodyPos.x;
    const rz = pos.z - bodyPos.z;
    const ax = axis.x;
    const az = axis.z;
    const a2 = ax * ax + az * az;
    const sStar = a2 > 1e-8 ? T.MathUtils.clamp(-(rx * ax + rz * az) / a2, 0, length) : 0;
    const cx = rx + sStar * ax;
    const cz = rz + sStar * az;
    const d = Math.hypot(cx, cz);
    if (d >= minRadius) return;

    let nx: number;
    let nz: number;
    if (d > 1e-5 && (cx * face.x + cz * face.z) > -.05) {
      nx = cx / d;
      nz = cz / d;
    } else {
      nx = face.x * .86 + right.x * (side * .51);
      nz = face.z * .86 + right.z * (side * .51);
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl;
      nz /= nl;
    }

    const push = minRadius - d + .003;
    if (keepHeadGrounded && pass === 0 && sStar > .25 * length) {
      _tcTip.copy(pos).addScaledVector(axis, sStar);
      _tcTip.x += nx * push;
      _tcTip.z += nz * push;
      axis.copy(_tcTip).sub(pos);
      if (axis.lengthSq() > 1e-8) axis.normalize();
      else axis.set(0, 1, 0);
    } else {
      pos.x += nx * push;
      pos.z += nz * push;
      return;
    }
  }
}

/** 26-direction support vectors on the unit sphere to extract exact extreme hull vertices once per head geometry. */
const HULL_DIRS: readonly [number, number, number][] = (() => {
  const out: [number, number, number][] = [];
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      for (const dz of [-1, 0, 1]) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const inv = 1 / Math.hypot(dx, dy, dz);
        out.push([dx * inv, dy * inv, dz * inv]);
      }
    }
  }
  return out;
})();

interface CachedBristleHull {
  version: number;
  count: number;
  coords: Float32Array;
}
const _bristleHullCache = new WeakMap<T.BufferGeometry, CachedBristleHull>();

function getBristleSupportCoords(geometry: T.BufferGeometry, vertices: T.BufferAttribute | T.InterleavedBufferAttribute): Float32Array {
  const version = (vertices as T.BufferAttribute).version ?? 0;
  const cached = _bristleHullCache.get(geometry);
  if (cached && cached.version === version && cached.count === vertices.count) return cached.coords;

  const n = vertices.count;
  let coords: Float32Array;
  if (n <= 64) {
    coords = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      coords[i * 3] = vertices.getX(i);
      coords[i * 3 + 1] = vertices.getY(i);
      coords[i * 3 + 2] = vertices.getZ(i);
    }
  } else {
    const chosen = new Set<number>();
    const raw = vertices instanceof T.BufferAttribute && vertices.itemSize === 3 && !vertices.normalized ? vertices.array : null;
    for (let d = 0; d < HULL_DIRS.length; d++) {
      const [dx, dy, dz] = HULL_DIRS[d];
      let bestMin = Infinity, bestMax = -Infinity, minIdx = 0, maxIdx = 0;
      if (raw) {
        for (let i = 0, j = 0; i < n; i++, j += 3) {
          const dot = dx * raw[j] + dy * raw[j + 1] + dz * raw[j + 2];
          if (dot < bestMin) { bestMin = dot; minIdx = i; }
          if (dot > bestMax) { bestMax = dot; maxIdx = i; }
        }
      } else {
        for (let i = 0; i < n; i++) {
          const dot = dx * vertices.getX(i) + dy * vertices.getY(i) + dz * vertices.getZ(i);
          if (dot < bestMin) { bestMin = dot; minIdx = i; }
          if (dot > bestMax) { bestMax = dot; maxIdx = i; }
        }
      }
      chosen.add(minIdx);
      chosen.add(maxIdx);
    }
    coords = new Float32Array(chosen.size * 3);
    let outIdx = 0;
    for (const idx of chosen) {
      coords[outIdx++] = vertices.getX(idx);
      coords[outIdx++] = vertices.getY(idx);
      coords[outIdx++] = vertices.getZ(idx);
    }
  }
  _bristleHullCache.set(geometry, { version, count: n, coords });
  return coords;
}

function isFlatWipeTool(spec: ToolSpec): boolean {
  return spec.kind === 'tool.cloth' || spec.kind === 'cloth.rag' || spec.kind === 'sponge.block';
}

/** How far along a handle a hand goes, in the tool's own space. */
function gripLocal(spec: ToolSpec, i: 0 | 1, out: T.Vector3, upper?: number, lower?: number) {
  if (spec.kind === 'tool.dustpan') return out.set(0, .79, -.258);
  if (isFlatWipeTool(spec)) return out.set(0, spec.sockets?.upper ?? .02, 0);
  // A long handle: canonical ergonomic spread (~36 cm on broom/mop) keeps both hands naturally spaced.
  if (upper !== undefined && spec.length > .9) {
    const spread = Math.max(.24, (spec.sockets?.upper ?? spec.grips[1]) - (spec.sockets?.lower ?? spec.grips[0]));
    return out.set(0, i === 1 ? upper : lower ?? Math.max(spec.grips[0] * .75, upper - spread), 0);
  }
  return out.set(0, spec.grips[i], 0);
}

interface FeltEntry {
  object: T.Object3D | null;
  point: T.Vector3;
  axis: T.Vector3;
  radius: number;
  half: number;
  shape: () => GraspShape;
}

export class ToolWork {
  active: { p: Placed; spec: ToolSpec; side: number } | null = null;
  /** The head, in the stage: on the floor or on whatever it works on. */
  private head = new T.Vector3();
  private strokeIntent: T.Vector3 | null = null;
  private headLast = new T.Vector3();
  private brushFrameA = new T.Matrix4();
  private brushFrameB = new T.Matrix4();
  private brushFrameParity = 0;
  private hasPreviousBrushFrame = false;
  /** Where the body stood last frame: the head is carried along with it before it moves on its own. */
  private bodyLast = new T.Vector3();
  private bodyYaw = 0;
  private bodySeen = false;
  /** How far out a long floor tool's head may be asked to go: a little past where the hands really have it. */
  private reachNow: number | undefined = undefined;
  private seeded = false;
  private axis = new T.Vector3(0, 1, 0);
  private yaw = 0;
  private strokeYaw = 0;
  pressing = false;
  private touching: Touching = null;
  private surfacePoint = new T.Vector3();
  private surfaceNormal = new T.Vector3(0, 1, 0);
  private requestedRotation = new T.Quaternion();
  private rackAim: { yaw: number; pitch: number } | null = null;
  /** Shaft roll belongs to the acquired grasp, transported by admitted body turns. */
  private shaftInBody = new T.Quaternion();
  private travelling: { head: T.Vector3; rotation: T.Quaternion; remaining: number } | null = null;
  private clearedBrush: { head: T.Vector3; rotation: T.Quaternion } | null = null;
  /** The floor is within reach of the eyes: the tool is down and working, or about to. */
  private working = false;
  private level = 0;
  private blockedTurnTime = 0;
  private alternateTurn = 0;
  private second: HandContact | null = null;
  private secondOn = false;
  /** Smooth 160 ms hysteresis & 0.18 s C1 blend between CARRY (1) and WORK_READY/STROKING (0). */
  private inCarryPosture = false;
  private carryHysteresisSec = 0;
  private carryBlend = 0;
  private gaitCarryPhase = 0;
  /** Continuous rhythmic stroke oscillator state when holding press on a surface. */
  private strokePhase = 0;
  private strokeAmpBlend = 0;
  private lastRayFloor = new T.Vector3();
  private hasLastRayFloor = false;
  /** How much further from the shaft a hand's wrist stands than the nominal grip, metres: what its palm's measured skin needed to rest on the handle. */
  private palmOut = new Map<number, number>();
  /** QA: distance from the other shoulder to its place on the handle, that arm's length, the two places along the handle. */
  secondReach: number[] = [];
  /** Shared with the manipulator: work/carry never replace a secured local frame. */
  private grasps = new Map<number, GraspFrame>();
  private scrape = new Scrape();
  private dripIn = 0;
  private puffIn = 0;
  private soundLevel = 0;
  private strokeSinceSave = 0;
  private bend = new T.Vector2();
  private bendUniform: { value: T.Vector2 } | null = null;
  private faceSkin: { mesh: T.SkinnedMesh; parts: [T.Bone, T.Box3][] } | null = null;
  private faceOwner: T.Object3D | null = null;
  private faceInRoot = new T.Box3();
  private faceFrame = new T.Matrix4();
  private faceJointMat = new T.Matrix4();
  private faceBoxTmp = new T.Box3();

  /** The face follows the posed head, neck and chest. Bound every nonzero
   * bone influence in bind space once; update in zero allocations per frame. */
  private measureFace(ch: Character) {
    const model = ch.rig?.model;
    if (!model) return;
    if (this.faceOwner !== model) {
      this.faceOwner = model; this.faceSkin = null;
      model.traverse(node => {
        const mesh = node as T.SkinnedMesh;
        if (!mesh.isSkinnedMesh || (node.userData.name ?? node.name) !== 'Cast_Face') return;
        const g = mesh.geometry, points = g.getAttribute('position'), joints = g.getAttribute('skinIndex'), weights = g.getAttribute('skinWeight');
        if (!points || !joints || !weights) return;
        const partMap = new Map<number, T.Box3>(), vertex = new T.Vector3(), bound = new T.Vector3();
        for (let i = 0; i < points.count; i++) {
          vertex.fromBufferAttribute(points, i).applyMatrix4(mesh.bindMatrix);
          for (let k = 0; k < 4; k++) {
            if (weights.getComponent(i, k) <= 0) continue;
            const bone = joints.getComponent(i, k);
            let box = partMap.get(bone);
            if (!box) { box = new T.Box3(); partMap.set(bone, box); }
            box.expandByPoint(bound.copy(vertex).applyMatrix4(mesh.skeleton.boneInverses[bone]));
          }
        }
        const parts: [T.Bone, T.Box3][] = [];
        for (const [bone, box] of partMap) {
          const joint = mesh.skeleton.bones[bone];
          if (joint) parts.push([joint, box]);
        }
        this.faceSkin = { mesh, parts };
      });
    }
    this.faceInRoot.makeEmpty();
    if (!this.faceSkin) return;
    const { mesh, parts } = this.faceSkin;
    mesh.updateMatrixWorld(false);
    this.faceFrame.copy(ch.root.matrixWorld).invert().multiply(mesh.matrixWorld).multiply(mesh.bindMatrixInverse);
    for (let i = 0; i < parts.length; i++) {
      const [joint, box] = parts[i];
      this.faceJointMat.multiplyMatrices(this.faceFrame, joint.matrixWorld);
      this.faceInRoot.union(this.faceBoxTmp.copy(box).applyMatrix4(this.faceJointMat));
    }
  }
  private lookKey = '';
  /** Metres the head moved while it was pressed, for what the body does and for tests. */
  worked = 0;
  private tiltBack = 0;
  /** Where along the handle the upper hand has got to. */
  private handAt: number | undefined = undefined;
  /** And the other hand, as far along as that arm really gets. */
  private lowerAt: number | undefined = undefined;
  /** The handle each hand feels, in the tool's own frame: it goes where the tool goes, so fingers fitted at any moment meet the real handle. */
  private felt = new Map<number, FeltEntry>();
  /** The body's twist into a stroke and how far it leans: read by the rig. */
  twist = 0;
  lean = 0;

  constructor(private host: ToolHost) {}

  get kind() { return this.active?.spec.kind ?? null; }
  get transporting() { return !!this.travelling; }
  get carryBlendAmount() { return this.carryBlend; }

  /**
   * Deterministic zero-allocation body-frame sweeping-ready / carry pose for zero-lag
   * `ToolCarry` attachment and express rack/floor equip. Floor tools (`tool.broom`, `tool.mop`)
   * stay in front of the body pointing down at the floor (~19-22 deg) with >= 0.25 m torso clearance.
   */
  canonicalCarryPose(
    p: Placed,
    side: number,
    rootPos: T.Vector3,
    rootQuat: T.Quaternion,
    gaitPhase = 0,
    moveBlend = 0,
    outPos = new T.Vector3(),
    outQuat = new T.Quaternion(),
  ): { position: T.Vector3; rotation: T.Quaternion } | null {
    const spec = toolOf(p.obj.kind);
    if (!spec) return null;
    const sock = spec.sockets;
    _ccForward.set(0, 0, 1).applyQuaternion(rootQuat).setY(0);
    if (_ccForward.lengthSq() < 1e-6) _ccForward.set(0, 0, 1);
    else _ccForward.normalize();
    _ccRight.crossVectors(_ccForward, UP).normalize();

    const sway = Math.min(1, Math.max(0, moveBlend));
    const floorSweepTool = spec.work === 'sweep' || spec.work === 'mop';
    const bobY = Math.sin(gaitPhase * 2) * (floorSweepTool ? .005 : .006) * sway;
    const walkLift = floorSweepTool ? .015 * sway : 0;
    const pitchSway = Math.sin(gaitPhase) * (floorSweepTool ? .012 : .018) * sway;

    _ccPitchQ.setFromAxisAngle(X_AXIS, sock.carryPitch + pitchSway);
    _ccYawQ.setFromAxisAngle(UP, side * sock.carryCrossYaw);
    _ccBaseQ.copy(rootQuat).multiply(_ccYawQ).multiply(_ccPitchQ).normalize();
    outQuat.copy(_ccBaseQ);

    const scaleY = p.group.scale.y || 1;
    _ccUpper.copy(rootPos)
      .addScaledVector(_ccRight, side * sock.carryUpperOffset[0] * scaleY)
      .addScaledVector(UP, (sock.carryUpperOffset[1] + walkLift) * scaleY + bobY)
      .addScaledVector(_ccForward, sock.carryUpperOffset[2] * scaleY);
    _ccAxis.copy(UP).applyQuaternion(outQuat).normalize();
    outPos.copy(_ccUpper).addScaledVector(_ccAxis, -sock.upper * scaleY);
    if (spec.on.includes('floor') && spec.length > .9) {
      outPos.y = Math.max(outPos.y, rootPos.y + (.085 + walkLift) * scaleY + bobY);
    }
    if (spec.length > .5) {
      _ccPrevAxis.copy(_ccAxis);
      enforceShaftTorsoClearance(
        outPos,
        _ccAxis,
        spec.length * scaleY,
        rootPos,
        _ccForward,
        _ccRight,
        side,
        .25 * scaleY,
        false,
      );
      if (_ccPrevAxis.distanceToSquared(_ccAxis) > 1e-10) {
        _ccSwingQ.setFromUnitVectors(_ccPrevAxis, _ccAxis);
        outQuat.premultiply(_ccSwingQ).normalize();
      }
    }
    return { position: outPos, rotation: outQuat };
  }

  /**
   * Captures deterministic primary (`side`) and support (`-side`, when `spec.hands === 2`)
   * `GraspFrame` anchors on `p.group` using body-referenced ergonomic palm normals.
   */
  captureCanonicalGrasps(
    p: Placed,
    side: number,
    out = new Map<number, GraspFrame>(),
  ): Map<number, GraspFrame> | null {
    const spec = toolOf(p.obj.kind);
    const ch = this.host.character();
    if (!spec || !ch?.ready) return null;
    out.clear();
    const primaryIdx: 0 | 1 = spec.hands === 2 ? 1 : 0;
    const primaryContact = this.gripWorld(p, spec, primaryIdx, side, true);
    if (spec.hands === 2 && spec.length > .9) {
      primaryContact.bend = { pitch: .26, drop: .075, yaw: .48 };
    }
    out.set(side, new GraspFrame(p.group, primaryContact));
    if (spec.hands === 2) {
      const supportContact = this.gripWorld(p, spec, 0, -side, true);
      supportContact.support = true;
      if (spec.length > .9) {
        supportContact.bend = { pitch: .26, drop: .075, yaw: .48 };
      }
      out.set(-side, new GraspFrame(p.group, supportContact));
    }
    return out;
  }

  /** Permit root motion while the previous work grip can travel with it.
   * Compare against the physical pose so a reversing step can recover. */
  rootMotionFraction(from: T.Vector3, to: T.Vector3, turn: number, maximum: number) {
    const a = this.active, ch = this.host.character();
    if (!a || !this.strokeIntent || !ch || !maximum || (from.equals(to) && Math.abs(turn) < 1e-6)) return maximum;
    if (this.pressing && this.grasps.size === 2 && !this.travelling &&
        (a.spec.work === 'web' || this.touching?.kind === 'floor')) {
      const inverse = _upTmpQ.copy(ch.root.quaternion).invert();
      this.travelling = {
        head: a.p.group.position.clone().sub(from).applyQuaternion(inverse),
        rotation: inverse.clone().multiply(a.p.group.quaternion),
        remaining: .12,
      };
    }
    if (!this.travelling) return maximum;
    this.travelling.remaining = .12;
    if (Math.abs(turn) < 1e-6) return maximum;
    const frame = this.travelling;
    const error = (t: number) => _rmQ.setFromAxisAngle(UP, ch.root.rotation.y + t * turn)
      .multiply(frame.rotation).angleTo(a.p.group.quaternion);
    const limit = Math.max(.12, error(0) + 1e-6);
    const follows = (t: number) => error(t) <= limit;
    if (follows(maximum)) return maximum;
    let lo = 0, hi = maximum;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) * .5;
      if (follows(mid)) lo = mid; else hi = mid;
    }
    return lo;
  }

  /**
   * Continuous zero-GC analytical shoulder-envelope projection (replaces the old
   * 48-sample `[.16, .08, .04, .02]` discrete coordinate-search grid that caused
   * frame-to-frame shaft/wrist stepping chatter).
   * Preserves acquired shaft roll (`setFromUnitVectors(carriedAxis, axis) * carried`)
   * and never mutates any `GraspFrame.local`.
   */
  private fitStroke(ch: Character, requested: T.Quaternion, floor: boolean) {
    const a = this.active!;
    const primaryArm = ch.rig?.armHome?.(a.side);
    const supportArm = ch.rig?.armHome?.(-a.side);
    if (!primaryArm || !supportArm) return;

    const stage = this.host.stage, k = stage.scale.x || 1;
    ch.bodyForward(_fsFace).setY(0);
    if (_fsFace.lengthSq() < 1e-6) _fsFace.set(0, 0, 1);
    else _fsFace.normalize();
    _fsRight.crossVectors(_fsFace, UP).normalize();

    _fsSh0.copy(primaryArm.shoulder);
    stage.worldToLocal(_fsSh0);
    _fsSh1.copy(supportArm.shoulder);
    stage.worldToLocal(_fsSh1);
    if (floor && (a.spec.work === 'sweep' || a.spec.work === 'mop')) {
      _fsSh0.addScaledVector(_fsFace, .08);
      _fsSh0.y -= .05;
      _fsSh1.addScaledVector(_fsFace, .10);
      _fsSh1.y -= .06;
    }

    const upper0 = primaryArm.upper / k, fore0 = primaryArm.fore / k, span0 = upper0 + fore0;
    const upper1 = supportArm.upper / k, fore1 = supportArm.fore / k, span1 = upper1 + fore1;

    const primaryGrip = this.grasps.get(a.side)!;
    _fsOff0.setFromMatrixPosition(primaryGrip.local).multiply(a.p.group.scale);
    const supportGrip = this.grasps.get(-a.side)?.local;
    if (supportGrip) {
      _fsOff1.setFromMatrixPosition(supportGrip).multiply(a.p.group.scale);
    } else {
      const spread = Math.max(.24, (a.spec.sockets?.upper ?? a.spec.grips[1]) - (a.spec.sockets?.lower ?? a.spec.grips[0]));
      _fsOff1.set(0, _fsOff0.y - spread * a.p.group.scale.y, 0);
    }

    _fsCarried.copy(ch.root.quaternion).multiply(this.shaftInBody).normalize();
    _fsCarriedAxis.copy(UP).applyQuaternion(_fsCarried).normalize();
    _fsPos.copy(this.head);
    _fsAxis.copy(UP).applyQuaternion(requested).normalize();
    const shaftLen = a.spec.length * (a.p.group.scale.y || 1);

    // Smooth forward floor stand-off prevents the head creeping between the ankles and folding the spine.
    if (floor) {
      const minForward = .55 * (1 - .20 * this.carryBlend);
      const fwdNow = (_fsPos.x - ch.root.position.x) * _fsFace.x + (_fsPos.z - ch.root.position.z) * _fsFace.z;
      if (fwdNow < minForward) {
        _fsPos.addScaledVector(_fsFace, minForward - fwdNow);
      }
    }

    const upperSpanAlong = Math.max(.25, _fsOff0.length());
    // 6 smooth damped Gauss-Seidel projections keep both wrists comfortably inside [0.54, 0.92] * armSpan.
    for (let iter = 0; iter < 6; iter++) {
      _fsQ.setFromUnitVectors(_fsCarriedAxis, _fsAxis).multiply(_fsCarried).normalize();

      // Primary hand projection
      _fsWrist.copy(_fsOff0).applyQuaternion(_fsQ).add(_fsPos);
      _fsToWrist.copy(_fsWrist).sub(_fsSh0);
      const d0 = _fsToWrist.length();
      const max0 = .92 * span0, min0 = .52 * span0;
      if (d0 > max0 && d0 > 1e-6) {
        _fsPos.addScaledVector(_fsToWrist, -((d0 - max0) / d0) * .50);
      } else if (d0 < min0 && d0 > 1e-6) {
        _fsPos.addScaledVector(_fsToWrist, ((min0 - d0) / d0) * .35);
      }

      // Support hand projection
      _fsWrist.copy(_fsOff1).applyQuaternion(_fsQ).add(_fsPos);
      _fsToWrist.copy(_fsWrist).sub(_fsSh1);
      const d1 = _fsToWrist.length();
      const max1 = .94 * span1, min1 = .52 * span1;
      if (d1 > max1 && d1 > 1e-6) {
        _fsPos.addScaledVector(_fsToWrist, -((d1 - max1) / d1) * .45);
      } else if (d1 < min1 && d1 > 1e-6) {
        _fsPos.addScaledVector(_fsToWrist, ((min1 - d1) / d1) * .32);
      }

      if (floor) {
        _fsPos.y = this.head.y;
        const fwd = (_fsPos.x - ch.root.position.x) * _fsFace.x + (_fsPos.z - ch.root.position.z) * _fsFace.z;
        const minFwd = .54 * (1 - .20 * this.carryBlend);
        if (fwd < minFwd) _fsPos.addScaledVector(_fsFace, minFwd - fwd);
      } else if ((a.spec.work === 'sweep' || a.spec.work === 'mop') && !this.pressing) {
        _fsPos.y = Math.min(_fsPos.y, ch.root.position.y + .085);
      }

      // Smoothly tilt shaft axis so upper grip stays inside primary shoulder reach without snapping.
      _fsChestGoal.copy(_fsPos).addScaledVector(_fsAxis, upperSpanAlong);
      _fsToWrist.copy(_fsChestGoal).sub(_fsSh0);
      const chestDist = _fsToWrist.length();
      const chestMax = .90 * span0;
      if (chestDist > chestMax && chestDist > 1e-6) {
        _fsChestGoal.addScaledVector(_fsToWrist, -((chestDist - chestMax) / chestDist) * .42);
        _fsAxis.copy(_fsChestGoal).sub(_fsPos);
        if (_fsAxis.lengthSq() > 1e-6) _fsAxis.normalize();
      }

      enforceShaftTorsoClearance(
        _fsPos,
        _fsAxis,
        shaftLen,
        ch.root.position,
        _fsFace,
        _fsRight,
        a.side,
        .27,
        floor,
      );
    }

    this.head.copy(_fsPos);
    this.axis.copy(_fsAxis).normalize();
    requested.setFromUnitVectors(_fsCarriedAxis, this.axis).multiply(_fsCarried).normalize();
  }

  /** Took it up: work requests a physical target and follows the accepted pose. */
  begin(p: Placed, side: number, grasps: Map<number, GraspFrame>) {
    const spec = toolOf(p.obj.kind);
    if (!spec || !grasps?.has(side)) return false;
    this.grasps = grasps;
    this.strokeIntent = null;
    this.travelling = null;
    this.hasPreviousBrushFrame = false;
    this.clearedBrush = null;
    this.active = { p, spec, side };
    this.rackAim = null;
    const body = this.host.character(); if (body) body.workingBody = true;
    if (body) {
      this.shaftInBody.copy(body.root.quaternion).invert().multiply(p.group.quaternion).normalize();
    } else {
      this.shaftInBody.copy(p.group.quaternion).normalize();
    }
    this.handAt = spec.work === 'web' ? _gwLocal.setFromMatrixPosition(grasps.get(side)!.local).y : undefined;
    this.lowerAt = undefined;
    this.alternateTurn = 0;
    this.blockedTurnTime = 0;
    this.inCarryPosture = false;
    this.carryHysteresisSec = 0;
    this.carryBlend = 0;
    this.gaitCarryPhase = 0;
    this.strokePhase = 0;
    this.strokeAmpBlend = 0;
    this.hasLastRayFloor = false;
    this.override = null; this.gripMiss = 0; this.gripAfter = 0; this.gripSecond = 0;
    this.refitIn = 0; this.refitSecondIn = 0; this.secondReach = [];
    this.strokeSinceSave = 0; this.twist = 0; this.lean = (spec.work === 'sweep' || spec.work === 'mop') ? .04 : 0;
    this.seeded = false; this.bodySeen = false; this.reachNow = undefined; this.pressing = false; this.worked = 0; this.touching = null; this.working = false; this.level = 0; this.secondOn = false; this.second = null; this.palmOut.clear();
    this.bend?.set(0, 0);
    const retained = grasps.get(-side);
    if (retained && body?.rig?.setContact) {
      this.second = retained.contact();
      this.second.support = true;
      this.secondOn = true;
      body.rig.setContact(-side, this.second, .14, .18);
    } else if (spec.hands === 2 && spec.length > .9 && body?.rig?.setContact && !this.host.handBusy() && !this.host.preparing?.()) {
      const sec = this.gripWorld(p, spec, 0, -side, true);
      sec.support = true;
      this.second = sec;
      this.secondOn = true;
      body.rig.setContact(-side, this.second, .14, .18);
    }
    this.head.copy(p.group.position);
    this.headLast.copy(this.head);
    applyToolLook(p);
    this.bendUniform = p.group.userData.toolBend ?? null;
    if (this.bendUniform) this.bendUniform.value.set(0, 0);
    return true;
  }

  /** Let go, or hung back up. What is on it stays on it. */
  end() {
    this.rackAim = null;
    this.override = null;
    const a = this.active;
    if (!a) return;
    this.flushState();
    this.host.physics()?.resumeHeld(a.side);
    const body = this.host.character(); if (body) body.workingBody = false;
    const rig = body?.rig;
    if (this.secondOn && rig?.contactOn?.(-a.side) === this.second) rig.setContact(-a.side, null, undefined, .18);
    this.active = null; this.pressing = false; this.touching = null; this.working = false; this.twist = 0; this.lean = 0; this.scrape.set(0, 'bristle'); this.secondOn = false; this.second = null;
    this.inCarryPosture = false; this.carryHysteresisSec = 0; this.carryBlend = 0; this.strokeAmpBlend = 0;
    this.hasPreviousBrushFrame = false; this.hasLastRayFloor = false;
    this.gripMiss = 0; this.gripAfter = 0; this.gripSecond = 0; this.secondReach = [];
    this.bend?.set(0, 0);
    if (this.bendUniform) this.bendUniform.value.set(0, 0);
    this.bendUniform = null;
  }

  press(down: boolean) {
    if (!this.active) return;
    if (this.pressing !== down) {
      this.flushState();
      this.blockedTurnTime = 0;
      this.alternateTurn = 0;
      if (down) {
        this.inCarryPosture = false;
        this.carryHysteresisSec = 0;
      }
    }
    this.pressing = down;
    if (!down) this.travelling = null;
  }

  /**
   * Completed rack withdrawal / express equip: seed the live pose cleanly
   * WITHOUT latching a stale `rackAim` input freeze so Frame 1 responds immediately.
   */
  finishWithdrawal(position: T.Vector3, rotation: T.Quaternion) {
    this.strokeIntent = null;
    this.head.copy(position);
    this.headLast.copy(position);
    this.requestedRotation.copy(rotation);
    this.axis.copy(UP).applyQuaternion(rotation).normalize();
    this.touching = null;
    this.working = false;
    this.rackAim = null;
  }
  useCurrentAim() { this.rackAim = null; }
  /** A free cursor has no held button to spare, nor a touch screen: a click starts the work, another stops it. */
  togglePress() { this.press(!this.pressing); }
  get isWorking() { return !!this.active && this.working; }
  get touchingNow() { return this.touching; }
  /** Only the support hand actually owned by this tool can be transferred. */
  get supportContact() {
    const side = this.active?.side, rig = this.host.character()?.rig;
    return side !== undefined && this.secondOn && rig?.contactOn(-side) === this.second ? this.second : null;
  }

  /** Geometric approach only. Planning must never move a live finger surface. */
  private handFrameAt(point: T.Vector3, axis: T.Vector3, side: number, radius = .0125, grip: HandContact['grip'] = 'handle', extra = 0): HandContact {
    const ch = this.host.character()!, k = this.host.stage.scale.x;
    this.host.stage.updateWorldMatrix(true, false);
    _hfUp.copy(UP).transformDirection(this.host.stage.matrixWorld);
    ch.root.getWorldPosition(_hfAt);
    ch.bodyForward(_hfFace).transformDirection(this.host.stage.matrixWorld);
    _hfRight.crossVectors(_hfFace, _hfUp);
    _hfShoulder.copy(_hfAt).addScaledVector(_hfRight, side * .17 * k).addScaledVector(_hfUp, 1.33 * k);
    _hfToward.copy(point).sub(_hfShoulder).normalize();
    const along = _hfToward.dot(axis), clear = Math.sqrt(Math.max(0, 1 - along * along));
    const blend = T.MathUtils.smoothstep(clear, .25, .6);
    _hfInward.copy(_hfRight).multiplyScalar(-side).addScaledVector(_hfUp, -.45);
    const fingers = new T.Vector3().copy(_hfToward).addScaledVector(axis, -along).multiplyScalar(blend);
    fingers.addScaledVector(_hfInward.addScaledVector(axis, -_hfInward.dot(axis)), 1 - blend);
    if (fingers.lengthSq() < 1e-6) fingers.copy(_hfFace);
    fingers.normalize();
    const palm = new T.Vector3().crossVectors(fingers, axis).multiplyScalar(-side).normalize();
    fingers.applyAxisAngle(palm, -GRIP_OBLIQUE * side);
    const seat = ch.rig?.palmSeat?.(side, radius, GRIP_ALONG, GRIP_OBLIQUE) ?? radius + .024;
    const wrist = new T.Vector3()
      .copy(point)
      .addScaledVector(palm, -(seat + extra) * k)
      .addScaledVector(fingers, -GRIP_ALONG * k)
      .addScaledVector(axis, -.006 * k);
    return { wrist, fingers, palm, grip };
  }

  /**
   * Deterministic body-referenced shaft grip frame (`0` live-elbow cross-product sign flips).
   * Projects the character's upright shoulder/body approach orthogonal to `axis` so lower and upper
   * palms lock smoothly onto the shaft without `palm.negate()` 180 deg wrist snaps.
   */
  private workHandAt(
    point: T.Vector3,
    axis: T.Vector3,
    side: number,
    radius = .0125,
    grip: HandContact['grip'] = 'handle',
    extra = 0,
    invertedHead = false,
  ): HandContact {
    const ch = this.host.character()!, k = this.host.stage.scale.x;
    this.host.stage.updateWorldMatrix(true, false);
    _hfUp.copy(UP).transformDirection(this.host.stage.matrixWorld);
    ch.root.getWorldPosition(_hfAt);
    ch.bodyForward(_hfFace).transformDirection(this.host.stage.matrixWorld);
    _hfRight.crossVectors(_hfFace, _hfUp);

    const home = ch.rig?.armHome?.(side);
    if (home) _hfShoulder.copy(home.shoulder);
    else _hfShoulder.copy(_hfAt).addScaledVector(_hfRight, side * .17 * k).addScaledVector(_hfUp, 1.30 * k);

    const seat = ch.rig?.palmSeat?.(side, radius, GRIP_ALONG, GRIP_OBLIQUE) ?? radius + .024;
    _hfToward.copy(point).sub(_hfShoulder);
    if (_hfToward.lengthSq() > 1e-8) _hfToward.normalize();
    else _hfToward.copy(_hfFace);

    // Overhead ceiling brush has local +Y pointing down from head to grip when raised;
    // orient thumb upward along the physical shaft without live elbow sign flips.
    const thumbFlip = invertedHead && axis.dot(_hfUp) < -.1 ? -1 : 1;
    _hfAxis.copy(axis).multiplyScalar(thumbFlip);

    const along = _hfToward.dot(_hfAxis);
    const clear = Math.sqrt(Math.max(0, 1 - along * along));
    const blend = T.MathUtils.smoothstep(clear, .22, .58);
    _hfInward.copy(_hfRight).multiplyScalar(-side * .88).addScaledVector(_hfFace, .28).addScaledVector(_hfUp, -.42);

    const fingers = new T.Vector3().copy(_hfToward).addScaledVector(_hfAxis, -along).multiplyScalar(blend);
    fingers.addScaledVector(_hfInward.addScaledVector(_hfAxis, -_hfInward.dot(_hfAxis)), 1 - blend);
    if (fingers.lengthSq() < 1e-6) fingers.copy(_hfFace).addScaledVector(_hfAxis, -_hfFace.dot(_hfAxis));
    if (fingers.lengthSq() < 1e-6) fingers.copy(_hfRight).multiplyScalar(-side);
    fingers.normalize();

    const palm = new T.Vector3().crossVectors(fingers, _hfAxis).multiplyScalar(-side).normalize();
    fingers.applyAxisAngle(palm, -GRIP_OBLIQUE * side);
    const wrist = new T.Vector3()
      .copy(point)
      .addScaledVector(palm, -(seat + extra) * k)
      .addScaledVector(fingers, -GRIP_ALONG * k)
      .addScaledVector(_hfAxis, -.006 * k);
    return { wrist, fingers, palm, grip };
  }

  /** The hand on the physical handle: this alone updates its finger surface. */
  private handOn(
    object: T.Object3D,
    point: T.Vector3,
    axis: T.Vector3,
    side: number,
    radius = .0125,
    grip: HandContact['grip'] = 'handle',
    extent?: [number, number],
    workGrip = false,
    invertedHead = false,
  ): HandContact {
    const extra = this.palmOut.get(side) ?? 0;
    const hand = workGrip
      ? this.workHandAt(point, axis, side, radius, grip, extra, invertedHead)
      : this.handFrameAt(point, axis, side, radius, grip, extra);
    let felt = this.felt.get(side);
    if (!felt) {
      const fAt = new T.Vector3(), fAlong = new T.Vector3(), fScale = new T.Vector3();
      const fQuat = new T.Quaternion(), fMat = new T.Matrix4();
      const fHalf: [number, number, number] = [radius, .06, radius];
      const f: FeltEntry = {
        object: null,
        point: new T.Vector3(),
        axis: new T.Vector3(0, 1, 0),
        radius,
        half: .06,
        shape: (): GraspShape => {
          fAt.copy(f.point);
          fAlong.copy(f.axis);
          if (f.object) {
            f.object.updateWorldMatrix(true, false);
            fAt.applyMatrix4(f.object.matrixWorld);
            fAlong.transformDirection(f.object.matrixWorld);
          }
          const r = f.radius * this.host.stage.scale.x;
          const length = f.object ? f.half * f.object.getWorldScale(fScale).y : f.half * this.host.stage.scale.x;
          fHalf[0] = r; fHalf[1] = length; fHalf[2] = r;
          fQuat.setFromUnitVectors(UP, fAlong.normalize());
          fMat.makeRotationFromQuaternion(fQuat).setPosition(fAt).invert();
          return { kind: 'cyl', toLocal: fMat, half: fHalf };
        },
      };
      this.felt.set(side, felt = f);
    }
    object.updateWorldMatrix(true, false);
    _handInv.copy(object.matrixWorld).invert();
    felt.object = object;
    felt.point.copy(point).applyMatrix4(_handInv);
    felt.axis.copy(axis).transformDirection(_handInv);
    felt.radius = radius;
    felt.half = .06;
    if (extent) {
      felt.point.set(0, (extent[0] + extent[1]) / 2, 0);
      felt.axis.set(0, 1, 0);
      felt.half = (extent[1] - extent[0]) / 2;
    }
    return { ...hand, shape: felt.shape, wrap: true };
  }

  /** The grip of a tool wherever it is now: used while reaching for it, and every frame after. */
  gripWorld(p: Placed, spec: ToolSpec, i: 0 | 1, side: number, workGrip = false) {
    p.group.updateWorldMatrix(true, false);
    const mine = this.active?.p === p;
    gripLocal(spec, i, _gwLocal, mine ? this.handAt : undefined, mine ? this.lowerAt : undefined);
    _gwPoint.copy(_gwLocal).applyMatrix4(p.group.matrixWorld);
    if (isFlatWipeTool(spec)) {
      const k = this.host.stage.scale.x;
      const fingers = this.host.character()!.bodyForward(new T.Vector3()).setY(-.14).normalize();
      return {
        wrist: new T.Vector3().copy(_gwPoint).addScaledVector(UP, .045 * k),
        fingers,
        palm: new T.Vector3(0, -1, 0),
        grip: 'flat' as const,
      };
    }
    if (spec.kind === 'tool.dustpan') _gwAxis.set(0, .98, -.196).normalize().transformDirection(p.group.matrixWorld);
    else _gwAxis.set(0, 1, 0).transformDirection(p.group.matrixWorld);

    let radius = spec.sockets?.shaftRadius ?? (spec.kind === 'tool.dustpan' ? .014 : .0125);
    if (spec.length > .9) {
      const scale = p.group.getWorldScale(_gwScale), k = this.host.stage.scale.x;
      const spanRatio = k / (scale.y || 1);
      const cacheKey = `${_gwLocal.y.toFixed(5)}|${spanRatio.toFixed(5)}`;
      let radiusCache = p.group.userData.__shaftRadii as Map<string, number> | undefined;
      let outer = radiusCache?.get(cacheKey);
      if (outer === undefined) {
        const shaft = surfaceOf(p.group, 'shaft|' + p.obj.kind + '|' + (p.group.userData.asset ?? 'fallback'),
          o => !/^(Handle|Pole|Grip)([._]\d+)?$/.test(o.userData.name ?? o.name));
        outer = 0;
        if (shaft) {
          _gwRay.origin.set(.06, _gwLocal.y, 0);
          _gwRay.direction.set(-1, 0, 0);
          for (const offset of [-.04, 0, .04]) {
            _gwRay.origin.y = _gwLocal.y + offset * spanRatio;
            const hit = shaft.raycastFirst(_gwRay, T.DoubleSide, 0, .06);
            if (hit) outer = Math.max(outer, hit.point.x);
          }
        }
        if (!radiusCache) { radiusCache = new Map(); p.group.userData.__shaftRadii = radiusCache; }
        radiusCache.set(cacheKey, outer);
      }
      if (outer > 0) radius = outer * scale.x / k;
    }
    const hand = this.handOn(
      p.group,
      _gwPoint,
      _gwAxis,
      side,
      radius,
      'handle',
      spec.length > .9 ? [spec.grips[0] * .4 - .05, spec.length] : undefined,
      spec.length > .9 && (mine || workGrip),
      spec.work === 'web',
    );
    if (spec.work === 'scoop') hand.bend = { pitch: .62, drop: .12 };
    return hand;
  }

  private securedContact(side: number): HandContact | null {
    const anchor = this.grasps.get(side), a = this.active;
    if (!anchor || !a) return null;
    const contact = anchor.contact();
    const felt = this.felt.get(side);
    if (felt?.object === a.p.group) { contact.shape = felt.shape; contact.wrap = true; }
    if (this.seeded && !this.host.preparing?.() && (a.spec.length <= .9 || this.override)) {
      _secCompose.compose(this.head, this.requestedRotation, a.p.group.scale);
      _secStage.multiplyMatrices(this.host.stage.matrixWorld, _secCompose).multiply(anchor.local);
      _secDelta.setFromMatrixPosition(_secStage).sub(contact.wrist).clampLength(0, .08 * this.host.stage.scale.x);
      contact.bodyGoal = contact.wrist.clone().add(_secDelta);
      contact.bodyFingers = new T.Vector3(0, 1, 0).transformDirection(_secStage);
    }
    if (a.spec.length > .9 && !this.override && !this.host.preparing?.()) contact.bend = { pitch: .28, drop: .15, yaw: .5 };
    return contact;
  }
  contactFirst(): HandContact { return this.securedContact(this.active!.side)!; }

  /** The head goes somewhere for a moment, whatever the eyes do: into a bucket, under a tap, over a bin. */
  private override: { point: T.Vector3; left: number; seconds: number; tip?: number; then?: () => void; tick?: (k: number) => void } | null = null;
  moveHead(point: T.Vector3, seconds: number, then?: () => void, tip?: number, tick?: (k: number) => void) {
    if (!this.active) return;
    this.override = { point: point.clone(), left: Math.max(.001, seconds), seconds: Math.max(.001, seconds), then, tip, tick };
    this.pressing = false;
  }
  get headBusy() { return !!this.override; }
  /** Cancel the operation without dropping the tool or changing its grasp. */
  cancelOperation() {
    if (!this.override) return;
    this.override = null; this.press(false); this.seeded = false; this.bodySeen = false;
  }

  /** Propose the work target before physics. Contacts and work read the accepted pose afterward. */
  update(dt: number, ray: T.Ray) {
    const a = this.active, ch = this.host.character(), physics = this.host.physics();
    if (!a || !ch?.ready || !physics) return;
    const { spec, p } = a, ex = this.host.exploration, life = this.host.life();
    if (this.strokeIntent) this.head.copy(this.strokeIntent);
    // Clear any legacy rackAim immediately so post-equip aim is never frozen.
    this.rackAim = null;

    ch.lean = Math.max(ch.lean, this.lean);
    const body = ch.root.position, seated = !!ch.body.seat;
    const longTool = spec.hands === 2 && spec.length > .9;
    const flat = longTool || ex.view === 'third' ? ch.bodyForward(v3) : ex.lookFlat(v3);
    _upFace.copy(flat).setY(0);
    if (_upFace.lengthSq() < 1e-6) _upFace.set(0, 0, 1);
    else _upFace.normalize();
    _upRight.crossVectors(_upFace, UP).normalize();

    const over = this.override;
    const reduced = this.host.reduced();
    const speedNow = ex.speed ?? 0;
    const floorSweepTool = spec.work === 'sweep' || spec.work === 'mop';
    const floorY = ch.groundAt?.(body.x, body.z) ?? body.y;

    // Floor sweeping tools stay in their forward 2-hand sweeping-ready stance instead of flipping across the chest.
    if (floorSweepTool || this.pressing || over || seated || this.host.preparing?.()) {
      this.inCarryPosture = false;
      this.carryHysteresisSec = 0;
    } else if (!this.inCarryPosture) {
      if (speedNow > .08) {
        this.carryHysteresisSec += dt;
        if (this.carryHysteresisSec >= CARRY_HYSTERESIS_SEC) {
          this.inCarryPosture = true;
          this.carryHysteresisSec = 0;
        }
      } else {
        this.carryHysteresisSec = Math.max(0, this.carryHysteresisSec - dt * 2);
      }
    } else {
      if (speedNow < .04) {
        this.carryHysteresisSec += dt;
        if (this.carryHysteresisSec >= CARRY_HYSTERESIS_SEC) {
          this.inCarryPosture = false;
          this.carryHysteresisSec = 0;
        }
      } else {
        this.carryHysteresisSec = Math.max(0, this.carryHysteresisSec - dt * 2);
      }
    }
    const wantCarry = this.inCarryPosture ? 1 : 0;
    this.carryBlend = floorSweepTool
      ? 0
      : reduced
        ? wantCarry
        : this.carryBlend + (wantCarry - this.carryBlend) * (1 - Math.exp(-dt / CARRY_BLEND_TAU));
    if (speedNow > .02) this.gaitCarryPhase += dt * Math.min(11, 4.5 + speedNow * 2.2);

    ch.eyePoint(_upStanding);
    _upWant.set(0, 0, 0);
    let surface: Touching = null, normal = UP;
    const floorAim = ray.direction.y < -.06 ? ((floorY - ray.origin.y) / ray.direction.y) : Infinity;
    const onFloor = spec.on.includes('floor') || spec.work === 'wipe';
    const canFloor = onFloor && Number.isFinite(floorAim) && floorAim > 0 && floorAim < 5 && !seated;
    const readyShaft = spec.length > .9 && !this.pressing && !over && !this.host.preparing?.();
    const walkLift = floorSweepTool ? T.MathUtils.clamp((speedNow - .04) / .55, 0, 1) * .035 : 0;

    if (readyShaft) {
      const high = spec.work === 'web';
      if (high) {
        _upWant.copy(body).addScaledVector(_upFace, .57).addScaledVector(_upRight, a.side * .18);
        _upWant.y = floorY + Math.min(2.15, 1 + spec.grips[1] * .76);
      } else {
        // Natural grounded 2-hand sweeping ready stance in front of body; damps any residual stroke arc cleanly.
        const residualLat = this.strokeAmpBlend > 1e-3 && spec.stroke
          ? Math.sin(this.strokePhase) * spec.stroke.lateralAmp * this.strokeAmpBlend
          : 0;
        const gaitBob = Math.sin(this.gaitCarryPhase * 2) * .004 * T.MathUtils.clamp(speedNow, 0, 1);
        _upWant.copy(body)
          .addScaledVector(_upFace, .58)
          .addScaledVector(_upRight, -a.side * .04 + residualLat);
        _upWant.y = floorY + .022 + walkLift + gaitBob;
      }
    } else if (over) {
      _upWant.copy(over.point);
    } else if (spec.work === 'web') {
      const far = Math.min(spec.reachAir ?? 2.6, this.wallAlong(ray, spec.reachAir ?? 2.6));
      const web = life.webNear(ray, far);
      _upHold.set(body.x, floorY + 1.12, body.z).addScaledVector(_upRight, a.side * .15).addScaledVector(_upFace, .27);
      const most = spec.grips[1] + .46;
      if (web && web.at.distanceTo(_upHold) <= most) {
        _upWant.copy(web.at);
        surface = { kind: 'web', id: web.id };
      } else {
        _upCarriedQ.copy(ch.root.quaternion).multiply(this.shaftInBody);
        _upDown.copy(UP).applyQuaternion(_upCarriedQ);
        _upWant.copy(_upHold).addScaledVector(_upDown, -(this.handAt ?? spec.grips[1]));
      }
    } else if (spec.on.includes('top') || spec.on.includes('glass')) {
      const hit = this.surfaceHit(ray, spec.reachAir ?? 1.1, spec);
      if (hit) { _upWant.copy(hit.point); surface = hit.touching; normal = hit.normal; }
      else if (this.surfaceHit(ray, 6, spec)) _upWant.copy(_upStanding).addScaledVector(ray.direction, spec.reachAir ?? .9);
      else if (canFloor && floorAim < 2.4 && spec.work === 'wipe') {
        _upWant.copy(ray.origin).addScaledVector(ray.direction, floorAim);
        _upWant.y = floorY;
        surface = { kind: 'floor' };
      }
      else _upWant.copy(_upStanding).addScaledVector(ray.direction, .62);
    } else if (canFloor) {
      _upWant.copy(ray.origin).addScaledVector(ray.direction, floorAim);
      _upWant.y = floorY;
      surface = { kind: 'floor' };
    } else if (floorSweepTool && !seated && !this.host.preparing?.()) {
      // Looking near/above the horizon while holding press still sweeps the floor in front of the character.
      _upWant.copy(body).addScaledVector(_upFace, .63).addScaledVector(_upRight, -a.side * .04);
      _upWant.y = floorY;
      surface = { kind: 'floor' };
    } else {
      _upWant.copy(body).addScaledVector(_upRight, a.side * .3).addScaledVector(_upFace, .22);
      _upWant.y = floorY + .1;
    }
    this.working = !!surface;

    let bearingAngleError = 0;
    if (!over && !seated && surface?.kind === 'floor' && (spec.work === 'sweep' || spec.work === 'mop') && !this.host.preparing?.()) {
      const headX = p.group.position.x - body.x, headZ = p.group.position.z - body.z;
      const goalX = _upWant.x - body.x, goalZ = _upWant.z - body.z;
      const radius = Math.hypot(goalX, goalZ);
      if (Math.hypot(headX, headZ) > .001 && radius > .001) {
        const bearing = Math.atan2(headX, headZ);
        let angle = Math.atan2(headZ * goalX - headX * goalZ, headX * goalX + headZ * goalZ);
        const lead = Math.atan2(.21, Math.max(spec.reach[0], Math.hypot(headX, headZ)));
        if (Math.abs(angle) <= lead) this.alternateTurn = 0;
        if (this.alternateTurn && angle * this.alternateTurn < 0) angle += this.alternateTurn * 2 * Math.PI;
        bearingAngleError = angle;
        const next = bearing + T.MathUtils.clamp(angle, -lead, lead);
        _upWant.x = body.x + Math.sin(next) * radius;
        _upWant.z = body.z + Math.cos(next) * radius;
      }
    }

    if (surface && ex.view === 'third' && !seated && !this.host.preparing?.()) {
      const before = ch.root.rotation.y;
      const yaw = Math.atan2(_upWant.x - body.x, _upWant.z - body.z);
      ch.turnBody(yaw, dt);
      const requested = Math.atan2(Math.sin(yaw - before), Math.cos(yaw - before));
      const remaining = Math.abs(requested);
      const turned = Math.abs(Math.atan2(Math.sin(ch.root.rotation.y - before), Math.cos(ch.root.rotation.y - before)));
      const floorStroke = surface.kind === 'floor' && (spec.work === 'sweep' || spec.work === 'mop') && !over;
      if (this.pressing && floorStroke && remaining > .06 && turned < remaining * (1 - Math.exp(-7 * dt)) * .1) {
        this.blockedTurnTime += dt;
        if (this.blockedTurnTime > .14) {
          const direction = Math.sign(requested);
          const probe = direction * .02;
          if (physics.heldMotionFraction(body, body, probe) < .1 &&
              physics.heldMotionFraction(body, body, -probe) > .99) this.alternateTurn = -direction;
          this.blockedTurnTime = 0;
        }
      } else this.blockedTurnTime = 0;
      ch.bodyForward(_upFace).setY(0);
      if (_upFace.lengthSq() < 1e-6) _upFace.set(0, 0, 1);
      else _upFace.normalize();
      _upRight.crossVectors(_upFace, UP).normalize();
    }

    // ── Continuous rhythmic pendulum (broom) & figure-8 S-glide (mop) while holding press ──
    if (!over && !seated && this.pressing && surface?.kind === 'floor' &&
        floorSweepTool && !this.host.preparing?.()) {
      const aimSpeed = this.hasLastRayFloor ? _upWant.distanceTo(this.lastRayFloor) / Math.max(dt, .001) : 0;
      this.lastRayFloor.copy(_upWant);
      this.hasLastRayFloor = true;
      // Yield 1:1 to deliberate fast cursor sweeps; blend in rhythmic stroke when holding steady on a dirty area.
      const aligned = !this.alternateTurn && this.blockedTurnTime === 0 && Math.abs(bearingAngleError) < .85;
      const targetAmp = aligned && !reduced ? 1 - T.MathUtils.smoothstep(aimSpeed, .32, 1.05) : 0;
      this.strokeAmpBlend += (targetAmp - this.strokeAmpBlend) * (1 - Math.exp(-dt * 14));
      if (this.strokeAmpBlend > 1e-3 && spec.stroke) {
        this.strokePhase += dt * Math.PI * 2 * spec.stroke.frequencyHz;
        if (this.strokePhase > Math.PI * 4) this.strokePhase -= Math.PI * 4;
        const lat = Math.sin(this.strokePhase) * spec.stroke.lateralAmp * this.strokeAmpBlend;
        const fwd = spec.stroke.pattern === 'figure8'
          ? Math.sin(this.strokePhase * 2) * spec.stroke.forwardAmp * this.strokeAmpBlend
          : (.5 - Math.abs(Math.cos(this.strokePhase))) * spec.stroke.forwardAmp * this.strokeAmpBlend;
        _upWant.addScaledVector(_upRight, lat).addScaledVector(_upFace, fwd);
        _upWant.y = floorY;
      }
    } else {
      this.hasLastRayFloor = false;
      this.strokeAmpBlend = reduced ? 0 : this.strokeAmpBlend * Math.exp(-dt * 14);
    }

    // ── Reach bounds (strictly stage-local so stage scale invariance holds on every frame) ──
    if (!over && (surface?.kind === 'floor' || (!surface && onFloor))) {
      const dx = _upWant.x - body.x, dz = _upWant.z - body.z, d = Math.hypot(dx, dz) || 1;
      const forward = (dx * _upFace.x + dz * _upFace.z) / d;
      let ux = dx / d, uz = dz / d;
      if (forward < -.2) {
        const s = (dx * _upRight.x + dz * _upRight.z) >= 0 ? 1 : -1;
        ux = _upRight.x * s * .95 + _upFace.x * .3;
        uz = _upRight.z * s * .95 + _upFace.z * .3;
        const l = Math.hypot(ux, uz) || 1;
        ux /= l; uz /= l;
      }
      let most = spec.reach[1];
      if (spec.length > .9 && surface?.kind === 'floor' && this.seeded) {
        const actualR = Math.hypot(p.group.position.x - body.x, p.group.position.z - body.z);
        const allowed = T.MathUtils.clamp(actualR + .10, Math.max(spec.reach[0], .58), spec.reach[1]);
        this.reachNow = this.reachNow === undefined ? allowed : this.reachNow + (allowed - this.reachNow) * (1 - Math.exp(-dt * 6));
        most = Math.max(spec.reach[0], this.reachNow);
      }
      const minReach = surface?.kind === 'floor' ? spec.reach[0] : spec.reach[0] * (1 - .18 * this.carryBlend);
      const r = T.MathUtils.clamp(d, minReach, most);
      _upWant.x = body.x + ux * r;
      _upWant.z = body.z + uz * r;
      if (surface?.kind === 'floor') this.clearAlong(physics, body, _upWant, _upWant);
    }

    if (!this.seeded) {
      this.seeded = true;
      this.head.copy(p.group.position);
      this.headLast.copy(this.head);
      this.strokeYaw = Math.atan2(_upFace.x, _upFace.z);
      this.pull.set(0, 0, 0);
    }
    this.pull.multiplyScalar(Math.exp(-dt * (over ? 4 : 1.5)));
    if (!over && spec.length <= .9 && !isFlatWipeTool(spec)) {
      _upWant.x += this.pull.x;
      _upWant.z += this.pull.z;
    }

    const lift = this.pressing && surface ? 0 : surface?.kind === 'floor' ? .03 : surface ? .018 : .0;
    _upTarget.copy(_upWant);
    if (surface) _upTarget.addScaledVector(normal, lift);

    if (this.bodySeen) {
      _upCarried.set(body.x - this.bodyLast.x, 0, body.z - this.bodyLast.z);
      if (_upCarried.lengthSq() < .25) {
        if (longTool && !over) this.head.sub(this.bodyLast).applyAxisAngle(UP, ch.root.rotation.y - this.bodyYaw).add(body);
        else this.head.add(_upCarried);
      }
    }
    this.bodyYaw = ch.root.rotation.y;
    this.bodyLast.copy(body);
    this.bodySeen = true;

    _upTarget.sub(this.head);
    const dist = _upTarget.length();
    const step = reduced ? dist : Math.min(dist, Math.max(dist * (1 - Math.exp(-dt * 18)), 0), spec.speed * dt * (this.pressing ? 1.35 : 1.75));
    if (dist > 1e-5) this.head.addScaledVector(_upTarget, step / dist);
    this.level = this.level + ((surface ? 1 : 0) - this.level) * (1 - Math.exp(-dt * 9));

    // ── Tool orientation: shaft aligned from head through chest pivot with zero roll drift ──
    _upStageQ.identity();
    const delta = v1.copy(this.head).sub(p.group.position), moved = delta.length();
    if (moved > 1e-4 && delta.lengthSq() > .000004) {
      const y = Math.atan2(delta.x, delta.z);
      this.strokeYaw += Math.atan2(Math.sin(y - this.strokeYaw), Math.cos(y - this.strokeYaw)) * (1 - Math.exp(-dt * 6));
    }
    if (spec.work === 'scoop') {
      const yaw = Math.atan2(this.head.x - body.x, this.head.z - body.z);
      _upStageQ.setFromAxisAngle(UP, yaw);
      this.tiltBack += ((over?.tip ?? (surface ? 0 : .5)) - this.tiltBack) * (1 - Math.exp(-dt * 8));
      _upTmpQ.setFromAxisAngle(X_AXIS, -this.tiltBack);
      _upStageQ.multiply(_upTmpQ);
    } else if (spec.length > .5) {
      if (floorSweepTool && !seated) {
        const sock = spec.sockets;
        const upperSway = this.strokeAmpBlend > 1e-3
          ? Math.sin(this.strokePhase) * .045 * this.strokeAmpBlend
          : 0;
        _upChest.copy(body)
          .addScaledVector(_upRight, a.side * sock.carryUpperOffset[0] + upperSway)
          .addScaledVector(UP, sock.carryUpperOffset[1] - .06 + walkLift)
          .addScaledVector(_upFace, sock.carryUpperOffset[2]);
      } else {
        _upChest.set(body.x, body.y + (seated ? .78 : 1.14), body.z)
          .addScaledVector(_upRight, a.side * (spec.hands === 2 ? -.05 : .15 + this.level * .02))
          .addScaledVector(_upFace, (spec.hands === 2 ? .23 : .27) + this.level * .04);
      }
      if (!seated && spec.hands === 2 && spec.work !== 'web' && !floorSweepTool && this.carryBlend > 1e-4) {
        const sock = spec.sockets;
        _upCarryChest.copy(body)
          .addScaledVector(_upRight, a.side * sock.carryUpperOffset[0])
          .addScaledVector(UP, sock.carryUpperOffset[1])
          .addScaledVector(_upFace, sock.carryUpperOffset[2]);
        _upChest.lerp(_upCarryChest, this.carryBlend);
      }
      if (!seated && surface?.kind === 'floor' && floorSweepTool) {
        const home = (side: number) => ch.rig?.armHome ? ch.rig.armHome(side) : ch.rig?.armReach(side);
        const primary = home(a.side), support = home(-a.side);
        if (primary && support) {
          _upShoulders.copy(primary.shoulder).lerp(support.shoulder, .5);
          this.host.stage.worldToLocal(_upShoulders);
          const reach = Math.min(primary.length, support.length) / (this.host.stage.scale.x || 1);
          _upUpper.copy(primary.shoulder);
          this.host.stage.worldToLocal(_upUpper);
          _upOutside.copy(_upUpper).sub(_upShoulders).setY(0);
          const strokeCounter = this.strokeAmpBlend > 1e-3
            ? Math.sin(this.strokePhase) * .04 * this.strokeAmpBlend
            : 0;
          _upChest.copy(_upShoulders)
            .addScaledVector(_upOutside, .75)
            .addScaledVector(_upRight, strokeCounter)
            .addScaledVector(_upFace, .63 * reach);
          _upChest.y -= .42 * reach;
          if (_upOutside.lengthSq() > 1e-8) _upOutside.normalize();
          _upNormal.copy(_upFace).addScaledVector(_upOutside, .48).normalize();
          const gap = v2.copy(_upChest).sub(_upShoulders).dot(_upNormal);
          _upChest.addScaledVector(_upNormal, Math.max(0, .54 * reach - gap));
          if (!this.faceInRoot.isEmpty()) {
            _upBounds.copy(this.faceInRoot).applyMatrix4(ch.root.matrix);
            const bentL = ch.rig?.armReach(-a.side)?.shoulder, bentR = ch.rig?.armReach(a.side)?.shoulder;
            if (bentL && bentR) {
              _upBentMid.copy(bentR).lerp(bentL, .5);
              this.host.stage.worldToLocal(_upBentMid);
              _upBounds.translate(v2.copy(_upShoulders).sub(_upBentMid));
            }
            _upShaft.copy(_upChest).sub(this.head);
            const shaftLen = _upShaft.length() || 1;
            const top = this.head.y + (_upShaft.y / shaftLen) * spec.length;
            const bottom = Math.max(this.head.y, _upBounds.min.y - .016);
            const high = Math.min(top, _upBounds.max.y + .016);
            if (_upShaft.y > 0 && bottom <= high && bottom > this.head.y) {
              const front = _upNormal.x * (_upNormal.x < 0 ? _upBounds.min.x : _upBounds.max.x)
                + _upNormal.z * (_upNormal.z < 0 ? _upBounds.min.z : _upBounds.max.z) + .016;
              const clearance = front - this.head.dot(_upNormal);
              const required = Math.max(clearance * _upShaft.y / (bottom - this.head.y), clearance * _upShaft.y / (high - this.head.y));
              _upChest.addScaledVector(_upNormal, Math.max(0, required - _upShaft.dot(_upNormal)));
            }
          }
        }
      }
      if (spec.work === 'web') {
        _upChest.y = body.y + 1.12;
        if (!over && !this.host.preparing?.()) {
          const hand = ch.rig?.armHome?.(a.side);
          if (hand) {
            _upChest.copy(hand.shoulder);
            this.host.stage.worldToLocal(_upChest);
            _upChest.addScaledVector(_upFace, .23).addScaledVector(_upRight, -a.side * .10);
            _upChest.y -= .27;
            _upAim.copy(this.head).sub(_upChest);
            const ahead = _upAim.dot(_upFace), lateral = _upAim.dot(_upRight);
            _upAim.copy(_upFace).multiplyScalar(Math.max(.2, ahead))
              .addScaledVector(_upRight, T.MathUtils.clamp(lateral, -.45, .45));
            _upAim.y = Math.max(.40, this.head.y - _upChest.y);
            _upAim.normalize();
            const grip = this.handAt ?? spec.grips[1];
            _upIdeal.copy(this.head).addScaledVector(_upAim, -grip);
            _upChest.add(_upIdeal.sub(_upChest).clampLength(0, .11));
            this.head.copy(_upChest).addScaledVector(_upAim, grip);
          }
        }
      }
      const span = this.head.distanceTo(_upChest), most = spec.grips[1] + .46;
      if (span > most && spec.work === 'web') this.head.lerpVectors(_upChest, this.head, most / span);
      this.axis.copy(_upChest).sub(this.head).normalize();
      if (!seated && !over && !this.host.preparing?.() && spec.length > .9 && spec.work !== 'web') {
        enforceShaftTorsoClearance(
          this.head,
          this.axis,
          spec.length * (p.group.scale.y || 1),
          body,
          _upFace,
          _upRight,
          a.side,
          .31,
          surface?.kind === 'floor',
        );
      }
      if (spec.work !== 'web') this.handAt = T.MathUtils.clamp(this.head.distanceTo(_upChest), spec.grips[0], spec.grips[1]);
      const yaw = Math.atan2(this.axis.x, this.axis.z);
      this.yaw = yaw;
      if (spec.length > .9) {
        _upCarriedQ.copy(ch.root.quaternion).multiply(this.shaftInBody).normalize();
        _upCarriedAxis.copy(UP).applyQuaternion(_upCarriedQ).normalize();
        _upStageQ.setFromUnitVectors(_upCarriedAxis, this.axis).multiply(_upCarriedQ).normalize();
      } else {
        _upStageQ.setFromUnitVectors(UP, this.axis);
        _upTmpQ.setFromAxisAngle(UP, yaw + Math.PI);
        _upStageQ.multiply(_upTmpQ);
      }
    } else if (spec.work === 'wipe') {
      _upStageQ.setFromUnitVectors(UP, surface ? normal : UP);
      _upTmpQ.setFromAxisAngle(UP, Math.atan2(_upFace.x, _upFace.z));
      _upStageQ.multiply(_upTmpQ);
    } else {
      _upChest.set(body.x, seated ? .9 : 1.2, body.z).addScaledVector(_upRight, a.side * .2).addScaledVector(_upFace, .22);
      this.axis.copy(_upChest).sub(this.head).normalize();
      _upStageQ.setFromUnitVectors(UP, this.axis);
    }

    if (longTool && !over && !this.host.preparing?.() && !seated) {
      (this.strokeIntent ??= new T.Vector3()).copy(this.head);
      if (spec.work === 'web' && this.pressing && !surface) {
        if (!this.clearedBrush) {
          const inverse = _upTmpQ.copy(ch.root.quaternion).invert();
          this.clearedBrush = {
            head: p.group.position.clone().sub(body).applyQuaternion(inverse),
            rotation: inverse.clone().multiply(p.group.quaternion),
          };
        }
        this.head.copy(this.clearedBrush.head).applyQuaternion(ch.root.quaternion).add(body);
        _upStageQ.copy(ch.root.quaternion).multiply(this.clearedBrush.rotation).normalize();
        this.axis.copy(UP).applyQuaternion(_upStageQ).normalize();
      } else if (this.travelling && (this.travelling.remaining -= dt) > 0) {
        _upMoveHead.copy(this.travelling.head).applyQuaternion(ch.root.quaternion).add(body);
        _upStroke.copy(this.head).sub(_upMoveHead).clampLength(0, .045);
        if (spec.work !== 'web') _upStroke.y = surface?.kind === 'floor' ? _upWant.y - _upMoveHead.y : 0;
        this.head.copy(_upMoveHead).add(_upStroke);
        _upStageQ.copy(ch.root.quaternion).multiply(this.travelling.rotation).normalize();
        this.axis.copy(UP).applyQuaternion(_upStageQ).normalize();
      } else {
        this.travelling = null;
        this.fitStroke(ch, _upStageQ, spec.work !== 'web');
      }
    } else {
      this.strokeIntent = null;
      this.travelling = null;
    }
    if (surface || !this.pressing || over) this.clearedBrush = null;
    this.touching = surface;
    this.surfacePoint.copy(_upWant);
    this.surfaceNormal.copy(normal);
    this.requestedRotation.copy(_upStageQ);
  }

  /** Finalized shoulders constrain the request before Rapier clips its swept shape. */
  beforePhysics(dt: number) {
    const a = this.active, physics = this.host.physics();
    if (!a || !physics) return;
    const pose = this.host.fitPose?.(a.p, a.side, this.head, this.requestedRotation, dt)
      ?? { position: this.head, rotation: this.requestedRotation };
    const preparing = this.host.preparing?.() ?? false;
    physics.driveTool(a.side, a.p.obj.id, pose.position, pose.rotation, dt, preparing, !!this.host.fitPose,
      !!this.host.fitPose && a.spec.length > .9 && !preparing && !this.override);
  }

  /** A named ray surface is only a candidate. Both ends of a cleaning stroke
   * must lie on its actual finite area; a coplanar obstruction is not that surface. */
  private touches(at: T.Vector3, touching: NonNullable<Touching>, spec: ToolSpec, life: LifeWorld) {
    if (touching.kind === 'web') return at.distanceTo(this.surfacePoint) <= Math.max(spec.width, spec.depth) * .5 + .03;
    if (Math.abs(_apTouchDiff.copy(at).sub(this.surfacePoint).dot(this.surfaceNormal)) > .03) return false;
    if (touching.kind === 'floor') return !!life.floor && Math.abs(at.x) <= life.floor.w * .5 && Math.abs(at.z) <= life.floor.d * .5;
    const film = life.film(touching.key);
    if (!film) return false;
    const local = this.toFilm(film, at, at.y, _filmPt1);
    return Math.abs(local.x) <= film.field.w * .5 && Math.abs(local.z) <= film.field.d * .5;
  }

  /** Rapier has moved the actual tool. Hands and cleaning follow that pose,
   * never the requested head path through a shelf or rack. */
  afterPhysics(dt: number) {
    const a = this.active, ch = this.host.character();
    if (!a || !ch?.ready) return;
    const { spec, p } = a, life = this.host.life();
    p.group.updateWorldMatrix(true, true);
    const actual = p.group.position;
    const body = ch.root.position;
    ch.bodyForward(_apFace).setY(0);
    if (_apFace.lengthSq() < 1e-6) _apFace.set(0, 0, 1);
    else _apFace.normalize();
    _apRight.crossVectors(_apFace, UP).normalize();
    _apDelta.copy(actual).sub(this.headLast);

    let from: T.Vector3 = this.headLast, to: T.Vector3 = actual;
    const headMesh = (spec.work === 'sweep' ? p.group.userData.care?.Bristles :
      spec.work === 'mop' ? p.group.userData.care?.Strands : null) as T.Mesh | null;
    const vertices = headMesh?.geometry.getAttribute('position');
    if (this.touching?.kind === 'floor' && headMesh && vertices?.count) {
      const currFrame = this.brushFrameParity === 0 ? this.brushFrameA : this.brushFrameB;
      const prevFrame = this.brushFrameParity === 0 ? this.brushFrameB : this.brushFrameA;
      currFrame.copy(this.host.stage.matrixWorld).invert().multiply(headMesh.matrixWorld);
      const e = currFrame.elements, e1 = e[1], e5 = e[5], e9 = e[9];
      const support = getBristleSupportCoords(headMesh.geometry, vertices);
      let lowest = Infinity, bestJ = 0;
      for (let j = 0, len = support.length; j < len; j += 3) {
        const height = e1 * support[j] + e5 * support[j + 1] + e9 * support[j + 2];
        if (height < lowest) { lowest = height; bestJ = j; }
      }
      _apTip.set(support[bestJ], support[bestJ + 1], support[bestJ + 2]);
      _apFrom.copy(_apTip).applyMatrix4(this.hasPreviousBrushFrame ? prevFrame : currFrame);
      _apTo.copy(_apTip).applyMatrix4(currFrame);
      from = _apFrom;
      to = _apTo;
      this.brushFrameParity ^= 1;
      this.hasPreviousBrushFrame = true;
    } else {
      this.hasPreviousBrushFrame = false;
    }

    const surface = !this.host.preparing?.() && this.touching && this.touches(to, this.touching, spec, life) ? this.touching : null;
    this.touching = surface;

    // ── Support hand placement along shaft (deterministic body-referenced `workHandAt`) ──
    const rigNow = ch.rig;
    if (spec.hands === 2 && spec.length > .9 && this.handAt !== undefined) {
      const upper = _apPoint.setFromMatrixPosition(this.grasps.get(a.side)!.local).y;
      const reach = rigNow?.armReach(-a.side);
      if (reach && !this.grasps.has(-a.side)) {
        const spread = Math.max(.24, (spec.sockets?.upper ?? spec.grips[1]) - (spec.sockets?.lower ?? spec.grips[0]));
        const low = Math.max(spec.grips[0] * .75, upper - .40), high = Math.max(low, upper - .16);
        _apAxis.copy(UP).transformDirection(p.group.matrixWorld);
        let best = Infinity;
        for (let i = 0; i <= 4; i++) {
          const y = T.MathUtils.lerp(low, high, i / 4);
          _apPoint.set(0, y, 0).applyMatrix4(p.group.matrixWorld);
          const hand = this.workHandAt(_apPoint, _apAxis, -a.side, spec.sockets?.shaftRadius ?? .0125, 'handle', 0, spec.work === 'web');
          const distance = reach.shoulder.distanceTo(hand.wrist);
          const cost = Math.max(0, distance - reach.length * .9) + Math.abs(upper - y - spread) * .12;
          if (cost < best) {
            best = cost;
            this.lowerAt = y;
            this.secondReach[0] = distance;
            this.secondReach[1] = reach.length;
            this.secondReach[2] = y;
            this.secondReach[3] = upper;
            this.secondReach.length = 4;
          }
        }
      }
    }
    const secondInReach = !this.secondReach.length || this.secondReach[0] <= this.secondReach[1] - .006 * this.host.stage.scale.x;
    const wantSecond = this.grasps.has(-a.side) || (spec.hands === 2 && (this.secondOn || secondInReach) &&
      (!!surface || !!this.override || spec.length > .9 && !this.host.preparing?.()));
    const rig = ch.rig;
    if (wantSecond) {
      const sec = this.securedContact(-a.side) ?? this.gripWorld(p, spec, 0, -a.side, true);
      sec.support = true;
      if (spec.work === 'web') {
        sec.on = p.group;
        sec.onAt = p.group.getWorldPosition(sec.onAt ?? new T.Vector3());
      }
      if (!this.second) this.second = sec; else Object.assign(this.second, sec);
      if (rig && rig.contactOn(-a.side) !== this.second && !this.host.handBusy()) { rig.setContact(-a.side, this.second, .20, .24); this.secondOn = true; }
    } else if (this.secondOn && rig) {
      if (rig.contactOn(-a.side) === this.second) rig.setContact(-a.side, null, undefined, .24);
      this.secondOn = false;
      this.grasps.delete(-a.side);
    }

    // ── Physical surface cleaning ──
    const stroke = surface && this.touches(from, surface, spec, life) ? from.distanceTo(to) : 0;
    const speed = stroke / Math.max(dt, .001);
    this.working = !!surface;
    const pressed = this.pressing && !!surface;
    if (pressed && (stroke > 1e-4 || spec.work === 'scoop')) this.apply(spec, p, surface!, stroke ? from : to, to, speed, life);
    if (pressed) { this.worked += stroke; this.strokeSinceSave += stroke; }

    const wantSound = pressed ? Math.min(1, speed / 1.1) : 0;
    this.soundLevel += (wantSound - this.soundLevel) * (1 - Math.exp(-dt * 16));
    this.scrape.set(this.soundLevel, spec.sound);
    const st = p.obj.state;
    if (spec.work === 'mop' && (st?.wet ?? 0) > .72 && !pressed) {
      this.dripIn -= dt;
      if (this.dripIn <= 0) { this.dripIn = .32 + Math.random() * .4; life.drip(actual.x, actual.z); }
    }

    // ── Smooth low-pass bristle-tip flex (`tool-bend-v2` uniform, <= 5 mm, 0.000 mm on shaft/ferrule) ──
    if (this.bendUniform) {
      const maxBend = spec.work === 'sweep' ? .0045 : .005;
      const gain = spec.work === 'sweep' ? .0035 : .0045;
      const bx = pressed ? -_apDelta.x / Math.max(dt, .001) * gain : 0;
      const bz = pressed ? -_apDelta.z / Math.max(dt, .001) * gain : 0;
      _apInvQ.copy(p.group.quaternion).invert();
      _apLocal.set(bx, 0, bz).applyQuaternion(_apInvQ);
      if (_apLocal.lengthSq() > maxBend * maxBend) _apLocal.setLength(maxBend);
      this.bend.x += (_apLocal.x - this.bend.x) * (1 - Math.exp(-dt * 14));
      this.bend.y += (_apLocal.z - this.bend.y) * (1 - Math.exp(-dt * 14));
      if (this.bend.lengthSq() > maxBend * maxBend) this.bend.setLength(maxBend);
      this.bendUniform.value.copy(this.bend);
    }

    // ── Torso follow (applied on next pre-IK `update`, never mutating finalized root/lean here) ──
    const floorSweep = spec.work === 'sweep' || spec.work === 'mop';
    const offset = Math.atan2(
      (actual.x - body.x) * _apRight.x + (actual.z - body.z) * _apRight.z,
      Math.max(.2, (actual.x - body.x) * _apFace.x + (actual.z - body.z) * _apFace.z),
    );
    const twistTarget = floorSweep && !this.pressing && this.strokeAmpBlend < .02
      ? 0
      : T.MathUtils.clamp(offset * (floorSweep ? .52 : .45), -.45, .45) * this.level;
    this.twist += (twistTarget - this.twist) * (1 - Math.exp(-dt * (this.pressing ? 9 : 11)));
    const away2 = Math.hypot(actual.x - body.x, actual.z - body.z);
    const leanWanted = floorSweep && !ch.body.seat
      ? (pressed ? .08 + Math.min(.06, Math.max(0, away2 - .68) * .20) : .04)
      : surface?.kind === 'floor' && spec.length > .9
        ? .05 + (pressed ? .035 : 0) + Math.min(.08, Math.max(0, away2 - .95) * .22)
        : surface?.kind === 'floor'
          ? .1 + (pressed ? .06 : 0) + Math.min(.18, Math.max(0, away2 - .55) * .3)
          : surface?.kind === 'top' || surface?.kind === 'glass'
            ? Math.min(.24, Math.max(0, away2 - .42) * .4)
            : 0;
    this.lean += (leanWanted - this.lean) * (1 - Math.exp(-dt * 8));
    applyToolLook(p);
    this.headLast.copy(actual);
    if (this.strokeSinceSave > 1.5) this.flushState();

    const over = this.override;
    if (over && actual.distanceTo(over.point) <= .03 && p.group.quaternion.angleTo(this.requestedRotation) <= .04) {
      over.left -= dt;
      over.tick?.(1 - Math.max(0, over.left) / over.seconds);
      if (this.override === over && over.left <= 0) { this.override = null; over.then?.(); }
    }
  }

  private real = { wrist: new T.Vector3(), fingers: new T.Vector3(), palm: new T.Vector3() };
  /** Stage-local offset learned from the hand: how much nearer a short tool has to rest for the arm that holds it. */
  private pull = new T.Vector3();
  private refitIn = 0;
  /** Actual handle-to-palm mismatch before this frame's work-grip feedback, in metres. */
  gripMiss = 0;
  /** Residual stays visible: neither tool nor secured grasp moves after the solve. */
  gripAfter = 0;
  /**
   * After the arms are solved: record the actual mismatch without mutating an acquired grasp.
   * Rapier remains the only object transform owner, including after arm IK.
   */
  afterBody(dt: number) {
    const a = this.active, ch = this.host.character(), rig = ch?.rig;
    this.gripMiss = 0; this.gripAfter = 0; this.gripSecond = 0;
    if (!a || !rig || !ch?.ready) return;
    const { spec, p } = a;
    if (spec.work === 'sweep' || spec.work === 'mop') this.measureFace(ch);
    const radius = spec.sockets?.shaftRadius ?? (spec.kind === 'tool.dustpan' ? .014 : .0125);
    this.secondInHand(dt, p, spec, radius, this.host.stage.scale.x);
    if (rig.contactProgress(a.side) < .97) return;
    const k = this.host.stage.scale.x;
    const { wrist, fingers, palm } = this.real;
    if (!rig.handFrame(a.side, wrist, fingers, palm)) return;
    this.gripMiss = wrist.distanceTo(this.contactFirst().wrist) / k;
    this.gripAfter = this.gripMiss;
  }
  /** How far the other palm is from the handle, after the solve. Metres. */
  gripSecond = 0;
  private refitSecondIn = 0;
  /** The other hand on a long handle: where its palm really is along the handle is where it holds, and its fingers close round the handle there. */
  private secondInHand(dt: number, p: Placed, spec: ToolSpec, _radius: number, k: number) {
    const a = this.active, rig = this.host.character()?.rig;
    this.gripSecond = 0;
    if (!a || !rig || !this.secondOn || rig.contactOn(-a.side) !== this.second || spec.hands !== 2 || rig.contactProgress(-a.side) < .97) return;
    const { wrist, fingers, palm } = this.real;
    if (!rig.handFrame(-a.side, wrist, fingers, palm)) return;
    const target = this.grasps.get(-a.side)?.contact() ?? this.second;
    this.gripSecond = target ? wrist.distanceTo(target.wrist) / k : 0;
    if (!this.grasps.has(-a.side) && target && rig.contactProgress(-a.side) >= .999 && this.gripSecond <= .003) {
      if (spec.work === 'web') {
        const elbow = rig.elbowWorld?.(-a.side), shoulder = rig.armReach?.(-a.side)?.shoulder;
        if (elbow && shoulder && (Math.abs(wristStrain(-a.side, shoulder, elbow, wrist, fingers, palm).roll) > 1.30 ||
            fingers.angleTo(target.fingers) > .025 || palm.angleTo(target.palm) > .025)) return;
      }
      this.grasps.set(-a.side, new GraspFrame(p.group, target));
      rig.refit(-a.side);
    }
    if (this.grasps.has(-a.side)) return;
    this.refitSecondIn -= dt;
    if (this.refitSecondIn <= 0) { rig.refit(-a.side); this.refitSecondIn = .35; }
  }

  /** What this movement did, from where the head really went. */
  private apply(spec: ToolSpec, p: Placed, touching: NonNullable<Touching>, from: T.Vector3, to: T.Vector3, speed: number, life: LifeWorld) {
    const st: ObjectState = p.obj.state ?? (p.obj.state = {});
    _ptA.x = from.x; _ptA.z = from.z;
    _ptB.x = to.x; _ptB.z = to.z;
    const away = this.host.character()!.root.position;
    switch (spec.work) {
      case 'sweep': {
        if (touching.kind !== 'floor') return;
        const moved = life.sweep(_ptA, _ptB, spec.width);
        this.puffIn -= .016;
        if (moved > .004 && this.puffIn <= 0) { this.puffIn = .12; life.puffs.emit(to.x, .03, to.z, 2, 'dust', (to.x - from.x) * 12, (to.z - from.z) * 12); }
        break;
      }
      case 'scoop': {
        if (touching.kind !== 'floor') return;
        const room = Math.max(0, PAN_ROOM * (1 - (st.fill ?? 0)));
        const yaw = Math.atan2(to.x - away.x, to.z - away.z);
        const sy = Math.sin(yaw), cy = Math.cos(yaw);
        _ptScoopAt.x = to.x + sy * .03; _ptScoopAt.z = to.z + cy * .03;
        _ptScoopDir.x = sy; _ptScoopDir.z = cy;
        const took = life.scoop(_ptScoopAt, _ptScoopDir, spec.width, spec.depth, room);
        if (took > 0) { st.fill = Math.min(1, (st.fill ?? 0) + took / PAN_ROOM); this.lookKey = ''; }
        break;
      }
      case 'mop': {
        if (touching.kind !== 'floor') return;
        _mopToolState.wet = st.wet ?? 0; _mopToolState.load = st.load ?? 0;
        life.mop(_ptA, _ptB, spec.width, spec.depth, _mopToolState);
        if (_mopToolState.wet < .35) life.blot(_ptB, .16, _mopToolState);
        st.wet = _mopToolState.wet; st.load = _mopToolState.load;
        break;
      }
      case 'wipe': {
        _mopToolState.wet = st.wet ?? 0; _mopToolState.load = st.load ?? 0;
        if (touching.kind === 'floor') {
          life.blot(_ptB, .1, _mopToolState);
          life.floor?.mop(_ptA, _ptB, spec.width, spec.depth, _mopToolState, .6, false);
        } else if (touching.kind === 'top' || touching.kind === 'glass') {
          const f = life.film(touching.key);
          if (f) {
            const l1 = this.toFilm(f, _ptA, from.y, _filmPt1);
            const l2 = this.toFilm(f, _ptB, to.y, _filmPt2);
            life.wipe(f, l1, l2, spec.width, spec.depth, _mopToolState, false);
          }
        }
        st.wet = _mopToolState.wet; st.load = _mopToolState.load;
        break;
      }
      case 'dust': {
        if (touching.kind !== 'top') return;
        const f = life.film(touching.key);
        if (f) {
          const l1 = this.toFilm(f, _ptA, from.y, _filmPt1);
          const l2 = this.toFilm(f, _ptB, to.y, _filmPt2);
          life.wipe(f, l1, l2, spec.width, spec.depth, null, true);
        }
        break;
      }
      case 'web': {
        if (touching.kind === 'web') life.brushWeb(touching.id, Math.min(.2, speed * .016));
        break;
      }
    }
  }

  /** A point on a surface in that surface's own grid. A pane is upright: its grid's "depth" is the height on it. */
  private toFilm(
    f: NonNullable<ReturnType<LifeWorld['film']>>,
    p: { x: number; z: number },
    y: number,
    out: { x: number; z: number } = { x: 0, z: 0 },
  ) {
    if (f.surface.key === 'glass') {
      out.x = p.x - f.surface.x;
      out.z = -(y - f.surface.y);
      return out;
    }
    const dx = p.x - f.surface.x, dz = p.z - f.surface.z, c = Math.cos(f.surface.rotY), n = Math.sin(f.surface.rotY);
    out.x = c * dx - n * dz;
    out.z = n * dx + c * dz;
    return out;
  }

  private flushState() {
    const a = this.active;
    if (!a) return;
    this.strokeSinceSave = 0;
    if (a.p.obj.state) this.host.saveState(a.p.obj.id, { ...a.p.obj.state });
  }

  private clearAlong(physics: StudyPhysics, body: T.Vector3, to: T.Vector3, out = _upClearOut) {
    const free = physics.clearFloorLine(v1.set(body.x, .05, body.z), v2.set(to.x, .05, to.z));
    if (free === null) return out.copy(to);
    const d = Math.hypot(to.x - body.x, to.z - body.z);
    if (free >= d) return out.copy(to);
    const k = Math.max(0, free - .03) / Math.max(d, .001);
    return out.set(body.x + (to.x - body.x) * k, to.y, body.z + (to.z - body.z) * k);
  }
  private wallAlong(ray: T.Ray, far: number) { const physics = this.host.physics(); return physics?.clearRay(ray.origin, ray.direction, far) ?? far; }

  private _surfaceHitPoint = new T.Vector3();
  private _surfaceHitGlassNormal = new T.Vector3(0, 0, 1);
  private _surfaceHitResult: { point: T.Vector3; normal: T.Vector3; touching: NonNullable<Touching> } = {
    point: this._surfaceHitPoint,
    normal: UP,
    touching: { kind: 'top', key: '' },
  };
  /** The nearest desk top, shelf board or window pane the eyes are on, within reach. */
  private surfaceHit(ray: T.Ray, far: number, spec: ToolSpec): { point: T.Vector3; normal: T.Vector3; touching: NonNullable<Touching> } | null {
    const life = this.host.life();
    let found = false, near = far;
    if (spec.on.includes('top')) {
      for (const f of life.films.values()) {
        if (ray.direction.y >= -.04 && ray.origin.y <= f.surface.y) continue;
        const t = (f.surface.y - ray.origin.y) / ray.direction.y;
        if (t <= 0 || t >= near) continue;
        const px = ray.origin.x + ray.direction.x * t, pz = ray.origin.z + ray.direction.z * t;
        const dx = px - f.surface.x, dz = pz - f.surface.z, c = Math.cos(f.surface.rotY), n = Math.sin(f.surface.rotY);
        if (Math.abs(c * dx - n * dz) > f.field.w / 2 || Math.abs(n * dx + c * dz) > f.field.d / 2) continue;
        near = t;
        found = true;
        this._surfaceHitPoint.set(px, f.surface.y, pz);
        this._surfaceHitResult.normal = UP;
        this._surfaceHitResult.touching = { kind: 'top', key: f.surface.key };
      }
    }
    const g = life.glass;
    if (spec.on.includes('glass') && g && ray.direction.z < -.05) {
      const t = (g.surface.z - ray.origin.z) / ray.direction.z;
      if (t > 0 && t < near) {
        const px = ray.origin.x + ray.direction.x * t, py = ray.origin.y + ray.direction.y * t;
        if (Math.abs(px - g.surface.x) < g.field.w / 2 && Math.abs(py - g.surface.y) < g.field.d / 2) {
          near = t;
          found = true;
          this._surfaceHitPoint.set(px, py, g.surface.z);
          this._surfaceHitResult.normal = this._surfaceHitGlassNormal;
          this._surfaceHitResult.touching = { kind: 'glass', key: 'glass' };
        }
      }
    }
    return found ? this._surfaceHitResult : null;
  }
  dispose() { this.override = null; this.scrape.stop(); }
}

function attachToolBendShader(mat: T.Material, uniform: { value: T.Vector2 }, bendHeight: { value: number }) {
  chainMaterialShader(mat, 'tool-bend-v2', (s) => {
    s.uniforms.uBend = uniform;
    s.uniforms.uBendHeight = bendHeight;
    s.vertexShader =
      'uniform vec2 uBend;\nuniform float uBendHeight;\n' +
      s.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n float bendK = 1. - clamp(position.y / max(uBendHeight, 0.001), 0., 1.); transformed.xz += uBend * bendK * bendK;',
      );
  });
  patchMaterialWithEchoCsm(mat);
}

/** Bind the flexible head while assembling the room so pickup only changes its uniform. */
export function ensureToolBendPrepared(group: T.Object3D): T.Material | null {
  if (group.userData.toolBendMaterial) return group.userData.toolBendMaterial as T.Material;
  const parts = group.userData.care as Record<string, T.Mesh> | undefined;
  const mesh = parts?.Bristles ?? parts?.Strands ?? parts?.Feathers;
  if (!mesh) return null;
  // Strictly restrict broom bristle flex to `y < 0.09 m` near the floor (`0.000 mm` deformation on twine, ferrule, and shaft `y >= 0.09 m`).
  const height = mesh === parts?.Strands ? .16 : mesh === parts?.Feathers ? .20 : .09;
  const uniform = { value: new T.Vector2() };
  const bendHeight = { value: height };
  const base = mesh.material as T.Material;
  const mat = mesh === parts?.Strands ? base : base.clone();
  if (mat !== base && mat.userData.__ecShaderTags && !(mat.userData.__ecShaderTags instanceof Set)) {
    const srcTags = base.userData.__ecShaderTags;
    mat.userData.__ecShaderTags = srcTags instanceof Set ? new Set(srcTags) : new Set<string>();
  }
  attachToolBendShader(mat, uniform, bendHeight);
  mesh.material = mat;
  group.userData.toolBend = uniform;
  group.userData.toolBendMaterial = mat;
  return mat;
}

const _prewarmedToolBendRigs = new WeakMap<
  T.WebGLRenderer,
  { geo: T.BufferGeometry; mat: T.MeshStandardMaterial; scene: T.Scene }
>();

/**
 * Prewarms the `'tool-bend-v2'` + Echo CSM shader program at StudySpace boot
 * so the first broom/mop/duster equip triggers `0` cold WebGL program compiles.
 * Retains the 3-vertex dummy rig per `WebGLRenderer` (WeakMap) so `KHR_parallel_shader_compile`
 * `onFirstUse()` never queries a prematurely `glDeleteProgram`-deleted program (`GL_INVALID_VALUE`).
 */
export function prewarmToolBendMaterial(
  renderer: T.WebGLRenderer | null | undefined,
  camera: T.Camera | null | undefined,
  targetGroup?: T.Object3D | null,
): boolean {
  let preparedTarget = false;
  if (targetGroup) {
    preparedTarget = !!ensureToolBendPrepared(targetGroup);
  }
  if (!renderer || !camera) return preparedTarget;
  if (_prewarmedToolBendRigs.has(renderer)) return true;

  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute([0, 0, 0, .01, 0, 0, 0, .01, 0], 3));
  geo.setAttribute('normal', new T.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  const mat = new T.MeshStandardMaterial();
  attachToolBendShader(mat, { value: new T.Vector2() }, { value: .14 });
  const dummyMesh = new T.Mesh(geo, mat);
  dummyMesh.frustumCulled = false;
  const dummyScene = new T.Scene();
  dummyScene.add(dummyMesh);
  _prewarmedToolBendRigs.set(renderer, { geo, mat, scene: dummyScene });
  renderer.compile(dummyScene, camera);
  return true;
}

/** A tool shows what is on it. Only when something changed. */
export function applyToolLook(p: { obj: SpaceObject; group: T.Object3D }) {
  const parts = p.group.userData.care as Record<string, T.Mesh> | undefined;
  if (!parts) return;
  if (p.group.userData.careKey === undefined) ensureToolBendPrepared(p.group);
  const st = p.obj.state ?? {}, key = `${st.wet ?? 0}|${st.load ?? 0}|${st.fill ?? 0}|${st.dirt ?? 0}|${st.tea ?? 0}|${st.soil ?? 0}`;
  if (p.group.userData.careKey === key) return;
  p.group.userData.careKey = key;
  const wet = st.wet ?? 0, load = st.load ?? 0, fill = st.fill ?? 0, dirt = st.dirt ?? 0;
  const tint = (mesh: T.Mesh | undefined, base: [number, number, number], rough: number) => {
    const m = mesh?.material as T.MeshStandardMaterial | undefined;
    if (!m?.color) return;
    const w = 1 - wet * .3, r = base[0] * w * (1 - load * .5), g = base[1] * w * (1 - load * .58), b = base[2] * w * (1 - load * .68);
    m.color.setRGB(r, g, b);
    m.roughness = rough * (1 - wet * .22);
  };
  if (parts.Liquid) {
    const on = fill > .012;
    parts.Liquid.visible = on;
    if (on) {
      parts.Liquid.position.y = .012 + .044 * fill;
      const k = .78 + .62 * fill;
      parts.Liquid.scale.set(k, k, 1);
      const tea = st.tea ?? 0, m = parts.Liquid.material as T.MeshStandardMaterial;
      m.color.setRGB(.62 - tea * .34, .74 - tea * .52, .82 - tea * .74);
    }
  }
  if (parts.Dirt) { const m = parts.Dirt.material as T.MeshStandardMaterial, s = st.soil ?? .5; m.color.setScalar(.62 + (1 - s) * .55); m.roughness = 1 - s * .35; }
  if (parts.Leaves) { const m = parts.Leaves.material as T.MeshStandardMaterial, dry = Math.max(0, 1 - (st.soil ?? .5) / .22); m.color.setRGB(1 + dry * .1, 1 - dry * .16, 1 - dry * .55); }
  tint(parts.Strands, [1, 1, 1], 1);
  tint(parts.Cloth, [1, 1, 1], 1);
  if (parts.Water) {
    const on = fill > .01;
    parts.Water.visible = on;
    if (on) {
      parts.Water.position.y = .03 + .255 * fill;
      const r = (.128 + .027 * fill) / .15;
      parts.Water.scale.set(r, 1, r);
      const m = parts.Water.material as T.MeshStandardMaterial;
      m.color.setRGB(.3 + dirt * .08, .44 - dirt * .16, .54 - dirt * .36);
      m.opacity = .7 + dirt * .26;
      m.roughness = .05 + dirt * .22;
    }
  }
  if (parts.Fill) {
    parts.Fill.visible = fill > .005;
    const inBin = p.obj.kind === 'bin.trash';
    if (inBin) { parts.Fill.position.y = .03 + fill * .3; parts.Fill.scale.setScalar(.82 + fill * .24); }
    else { const k = Math.cbrt(Math.max(.02, fill)); parts.Fill.scale.set(.4 + k * .6, .3 + k * .7, .4 + k * .6); }
  }
}
