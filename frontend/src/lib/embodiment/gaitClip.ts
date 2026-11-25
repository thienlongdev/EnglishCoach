import * as T from 'three';
import type { FootSurface } from './footSurface';

/**
 * The captured gaits, put right for this skeleton once, when the cast loads.
 *
 * The CMU skeleton fit has legs about 5 % longer than the walker who was captured, so the source keeps its knees bent
 * (29 degrees at mid stance in 35_01, against 5 to 10 in a person: Perry and Burnfield, Gait Analysis, 2010; Winter,
 * Biomechanics and Motor Control of Human Movement, 2009), and a bone for bone copy carries that crouch, a toes-up
 * foot and soles 3 cm under the floor onto the cast. Everything at run time then fought the clip.
 *
 * What is measured is kept: where the feet go, how they turn, how the pelvis and the trunk move. What the bad fit
 * invented is recomputed:
 *  - a shoe on the floor lies flat on it and does not turn about the vertical, rolling in over the heel and off over the toe;
 *  - the sole touches the floor exactly (never under it), with the captured clearance in the swing;
 *  - the point of the sole on the floor stays where it is while the body passes over it, at one constant speed (the
 *    speed the clip is played for: no foot ever skates);
 *  - walking, the pelvis rides at the height the leg that has just taken the weight gives it with the knee flexion a
 *    walker has in stance (5 degrees at contact, 17 in loading, back to 5 at heel off);
 *  - a trailing foot that the pelvis has left behind comes up on its toe, as a foot does, instead of pulling the pelvis down;
 *  - thigh and shin are solved again between that pelvis and that ankle, in the captured knee plane.
 */
export interface GaitLeg { side: number; thigh: T.Bone; shin: T.Bone; foot: T.Bone; sole: FootSurface; footForward: T.Vector3; footUp: T.Vector3 }
export interface GaitReport {
  /** Speed of the floor under the stance foot, model units a second: the travel speed this clip is drawn for. */
  speed: number; duration: number;
  /** Knee flexion of the leg that carries the weight (to heel off), degrees: lowest, median, highest. */
  stanceKnee: [number, number, number]; swingKneeMax: number;
  /** Hip joint height, model units: lowest and highest of the cycle. */
  hipRange: [number, number];
  /** Share of the stride each foot is on the floor. */
  stanceShare: [number, number];
  maxSlip: number; minSole: number; maxAnchor: number; maxHeelRise: number;
  /** Largest turn of the shoe about the shin against the capture's own flat stance, degrees. */
  maxAnkleTwist: number;
  /** Normalized clip fraction `[0..1)` at which the left foot (`side < 0`) reaches maximum forward `+Z` relative to hips (for phase-locked blend spaces). */
  leftFootForwardFrac: number;
}
export interface GaitResult { clip: T.AnimationClip; report: GaitReport }

/** Knee flexion a walker has through stance, degrees, against the share of stance done (Perry and Burnfield 2010, Winter 2009). */
const STANCE_KNEE: readonly (readonly [number, number])[] = [[0, 5], [.1, 11], [.22, 17], [.36, 12], [.5, 8], [.67, 5], [1, 5]];
const deg = (r: number) => r * 180 / Math.PI;
const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

function stanceKnee(share: number) {
  for (let i = 1; i < STANCE_KNEE.length; i++) {
    const [x0, y0] = STANCE_KNEE[i - 1], [x1, y1] = STANCE_KNEE[i];
    if (share <= x1) return y0 + (y1 - y0) * smooth((share - x0) / (x1 - x0));
  }
  return STANCE_KNEE[STANCE_KNEE.length - 1][1];
}

/** The longest run of `true` on a ring: [first, length]. */
function longestRun(flags: boolean[]): [number, number] {
  const n = flags.length;
  if (flags.every(Boolean)) return [0, n];
  let best: [number, number] = [0, 0];
  for (let i = 0; i < n; i++) {
    if (!flags[i] || flags[(i + n - 1) % n]) continue;
    let len = 0;
    while (len < n && flags[(i + len) % n]) len++;
    if (len > best[1]) best = [i, len];
  }
  return best;
}

export function retargetGait(source: T.AnimationClip, model: T.Object3D, hips: T.Bone, legs: readonly GaitLeg[], kind: 'Walk' | 'Run'): GaitResult | null {
  if (legs.length !== 2 || !hips.parent) return null;
  const bones: T.Bone[] = [];
  model.traverse(o => { if ((o as T.Bone).isBone) bones.push(o as T.Bone); });
  const saved = bones.map(b => ({ b, p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() }));
  const mixer = new T.AnimationMixer(model), action = mixer.clipAction(source);
  action.reset().play();
  const duration = source.duration, N = Math.max(48, Math.round(duration * 60)), dt = duration / N;
  model.updateWorldMatrix(true, true);
  const toModel = model.matrixWorld.clone().invert(), modelQ = model.getWorldQuaternion(new T.Quaternion()).invert();
  const modelScale = model.getWorldScale(new T.Vector3());
  const pos = (b: T.Object3D) => b.getWorldPosition(new T.Vector3()).applyMatrix4(toModel);
  const rot = (b: T.Object3D) => modelQ.clone().multiply(b.getWorldQuaternion(new T.Quaternion()));
  interface Sample { H: T.Vector3; K: T.Vector3; A: T.Vector3; thighQ: T.Quaternion; shinQ: T.Quaternion; footQ: T.Quaternion; parentQ: T.Quaternion }
  const samples: Sample[][] = legs.map(() => []);
  const hipsAt: T.Vector3[] = [], hipsParent: T.Matrix4[] = [];
  for (let i = 0; i < N; i++) {
    action.time = i * dt; mixer.update(0); model.updateWorldMatrix(true, true);
    hipsAt.push(pos(hips));
    hipsParent.push(toModel.clone().multiply(hips.parent.matrixWorld));
    legs.forEach((leg, l) => samples[l].push({ H: pos(leg.thigh), K: pos(leg.shin), A: pos(leg.foot), thighQ: rot(leg.thigh), shinQ: rot(leg.shin), footQ: rot(leg.foot), parentQ: rot(leg.thigh.parent!) }));
  }
  const footScale = legs.map(leg => leg.foot.getWorldScale(new T.Vector3()).divide(modelScale));
  action.stop(); mixer.stopAllAction(); mixer.uncacheRoot(model);
  for (const s of saved) { s.b.position.copy(s.p); s.b.quaternion.copy(s.q); s.b.scale.copy(s.s); }
  model.updateWorldMatrix(true, true);

  const UPV = new T.Vector3(0, 1, 0);
  const wrap = (i: number) => ((i % N) + N) % N;
  const length = legs.map((_, l) => {
    let a = 0, b = 0;
    for (const s of samples[l]) { a += s.H.distanceTo(s.K); b += s.K.distanceTo(s.A); }
    return [a / N, b / N] as const;
  });
  // ── The shoes: flat and still on the floor, rolling in and out of it. ──
  const footQ: T.Quaternion[][] = [], ankle: T.Vector3[][] = [], contact: boolean[][] = [];
  /** Per leg: first stance sample, how many, and how many of them up to the heel coming off. */
  const runs: { first: number; count: number; flatEnd: number }[] = [];
  const toeTip: T.Vector3[] = [], floorLevel: number[] = [];
  legs.forEach((leg, l) => {
    const S = samples[l], scale = footScale[l];
    const local = new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(leg.footUp.clone().cross(leg.footForward), leg.footUp, leg.footForward)).invert();
    const flat = (yaw: number) => new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(new T.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)), UPV, new T.Vector3(Math.sin(yaw), 0, Math.cos(yaw)))).multiply(local);
    const forward = S.map(s => leg.footForward.clone().applyQuaternion(s.footQ));
    const pitch = forward.map(f => Math.asin(T.MathUtils.clamp(f.y, -1, 1))), yaw = forward.map(f => Math.atan2(f.x, f.z));
    const low = Math.min(...S.map(s => s.A.y));
    const [c0, cn] = longestRun(S.map(s => s.A.y < low + .02));
    const mid = wrap(c0 + Math.floor(cn / 2));
    // Flat on the floor: between the roll over the heel and the heel coming up the captured foot hardly turns
    // (under 45 degrees a second) and its ankle has not begun to rise; a real one does not turn at all.
    const rate = T.MathUtils.degToRad(45) * dt;
    let back = 0, ahead = 0;
    while (back + ahead < N - 2 && Math.abs(pitch[wrap(mid - back)] - pitch[wrap(mid - back - 1)]) <= rate && S[wrap(mid - back - 1)].A.y < low + .035) back++;
    while (back + ahead < N - 2 && Math.abs(pitch[wrap(mid + ahead)] - pitch[wrap(mid + ahead + 1)]) <= rate && S[wrap(mid + ahead + 1)].A.y < low + .012) ahead++;
    const f0 = wrap(mid - back), fn = back + ahead + 1, f1 = wrap(f0 + fn - 1);
    let ys = 0, yc = 0;
    for (let k = 0; k < fn; k++) { ys += Math.sin(yaw[wrap(f0 + k)]); yc += Math.cos(yaw[wrap(f0 + k)]); }
    const planted = flat(Math.atan2(ys, yc));
    // Off the flat part the shoe only pitches: it rolls over the heel, over the toe and swings, all about the axis
    // across the foot. The captured pitch is kept; the captured turn about the vertical and the roll are not (they are
    // where the fit twisted the shoe sideways, up to 100 degrees in the run).
    const q: T.Quaternion[] = S.map((_, i) => {
      const p = pitch[i], y = Math.atan2(ys, yc);
      const z = new T.Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p));
      const yv = new T.Vector3(-Math.sin(y) * Math.sin(p), Math.cos(p), -Math.cos(y) * Math.sin(p));
      return new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(yv.clone().cross(z), yv, z)).multiply(local);
    });
    for (let k = 0; k < fn; k++) q[wrap(f0 + k)] = planted.clone();
    footQ.push(q);
    // The floor of the capture, read under the flat shoe; what is above it is the clearance of the swing.
    const bottom = S.map((s, i) => s.A.y + leg.sole.offsetY(q[i], scale));
    const flats = Array.from({ length: fn }, (_, k) => bottom[wrap(f0 + k)]).sort((a, b) => a - b);
    const level = flats[Math.floor(flats.length / 2)];
    floorLevel.push(level);
    const clear = bottom.map(b => Math.max(0, b - level));
    // A stance is the flat part and, either side of it, the roll about the heel and about the toe: from the heel
    // reaching its furthest forward to the toe reaching its furthest back, the two events a gait cycle is cut at.
    const lateral = new T.Vector3(1, 0, 0).applyQuaternion(planted.clone().multiply(local.clone().invert()));
    const tipped = (angle: number) => leg.sole.supportPoint(new T.Quaternion().setFromAxisAngle(lateral, angle).multiply(planted), scale, new T.Vector3()).multiply(scale);
    const heel = tipped(-.35), toe = tipped(.35);
    toeTip.push(toe);
    let strike = 0, off = 0, most = -Infinity, least = Infinity;
    for (let i = 0; i < N; i++) {
      const hz = heel.clone().applyQuaternion(q[i]).z + S[i].A.z, tz = toe.clone().applyQuaternion(q[i]).z + S[i].A.z;
      if (hz > most) { most = hz; strike = i; }
      if (tz < least) { least = tz; off = i; }
    }
    const stance = new Array<boolean>(N).fill(false);
    let a = f0, b = f1, count = fn;
    if (kind === 'Walk') {
      // Walking, a foot is on the floor for 60 to 62 % of the stride (Perry and Burnfield 2010): the capture's own
      // events, held to that, so both feet share the floor at each change of support and neither leaves it early.
      const share = T.MathUtils.clamp(wrap(off - strike) + 1, Math.round(N * .58), Math.round(N * .64));
      a = strike; count = Math.max(share, wrap(f1 - strike) + 1);
    } else {
      // Running, the capture decides: on the floor for as long as the point of the sole under it keeps the floor's pace.
      let pace = 0;
      for (let k = 0; k < fn - 1; k++) pace -= S[wrap(f0 + k + 1)].A.z - S[wrap(f0 + k)].A.z;
      pace /= Math.max(1, fn - 1);
      const rolls = (i: number, j: number) => {
        if (clear[i] > .012 || clear[j] > .012) return false;
        const tilt = (k: number) => Math.abs(Math.asin(T.MathUtils.clamp(leg.footForward.clone().applyQuaternion(q[k]).y, -1, 1)));
        const p = leg.sole.supportPoint(q[tilt(j) >= tilt(i) ? j : i], scale, new T.Vector3()).multiply(scale);
        const dz = p.clone().applyQuaternion(q[j]).z + S[j].A.z - p.clone().applyQuaternion(q[i]).z - S[i].A.z;
        return Math.abs(dz + pace) <= .5 * Math.abs(pace);
      };
      for (let k = wrap(f0 - strike); k > 0 && count < N - 2 && rolls(wrap(a - 1), a); k--) { a = wrap(a - 1); count++; }
      for (let k = wrap(off - f1); k > 0 && count < N - 2 && rolls(b, wrap(b + 1)); k--) { b = wrap(b + 1); count++; }
    }
    for (let k = 0; k < count; k++) stance[wrap(a + k)] = true;
    // The heel comes off by 40 % of the stride (Perry and Burnfield 2010): 60 % of the stance at the latest.
    contact.push(stance); runs.push({ first: a, count, flatEnd: kind === 'Walk' ? Math.min(wrap(f1 - a), Math.round((count - 1) * .6)) : wrap(f1 - a) });
    // Off the floor the shoe clears it: never a heel scuffing forward at floor height on its way to the strike.
    ankle.push(S.map((s, i) => {
      let away = 0;
      if (!stance[i]) { away = 1; while (away < N && !stance[wrap(i + away)] && !stance[wrap(i - away)]) away++; }
      return new T.Vector3(s.A.x, -leg.sole.offsetY(q[i], scale) + (stance[i] ? 0 : Math.max(clear[i], .008) * smooth(away / 4)), s.A.z);
    }));
  });

  // ── The floor passes under a stance foot at one speed: what the clip is played for. ──
  const pivotStep = (l: number, i: number) => {
    const leg = legs[l], j = wrap(i + 1), scale = footScale[l];
    const tilt = (k: number) => Math.abs(Math.asin(T.MathUtils.clamp(leg.footForward.clone().applyQuaternion(footQ[l][k]).y, -1, 1)));
    const p = leg.sole.supportPoint(footQ[l][tilt(j) >= tilt(i) ? j : i], scale, new T.Vector3()).multiply(scale);
    const a = p.clone().applyQuaternion(footQ[l][i]).add(samples[l][i].A), b = p.clone().applyQuaternion(footQ[l][j]).add(samples[l][j].A);
    return b.sub(a);
  };
  let travel = 0, time = 0;
  legs.forEach((_, l) => { for (let i = 0; i < N; i++) if (contact[l][i] && contact[l][wrap(i + 1)]) { travel -= pivotStep(l, i).z; time += dt; } });
  const speed = time > 0 ? travel / time : 0;
  let maxAnchor = 0;
  legs.forEach((_, l) => {
    // The foot comes down where it was captured coming down; from there the floor carries it.
    const { first, count } = runs[l], ex = new Array<number>(N).fill(0), ez = new Array<number>(N).fill(0);
    let x = 0, z = 0;
    for (let k = 0; k < count; k++) {
      const i = wrap(first + k); ex[i] = x; ez[i] = z;
      if (k < count - 1) { const step = pivotStep(l, i); x -= step.x; z -= step.z + speed * dt; }
    }
    // Through the swing the correction goes back to nothing.
    const last = wrap(first + count - 1), gap = N - count;
    for (let k = 1; k <= gap; k++) { const i = wrap(last + k), w = 1 - smooth(k / (gap + 1)); ex[i] = ex[last] * w; ez[i] = ez[last] * w; }
    for (let i = 0; i < N; i++) { ankle[l][i].x += ex[i]; ankle[l][i].z += ez[i]; maxAnchor = Math.max(maxAnchor, Math.hypot(ex[i], ez[i])); }
  });

  // ── The pelvis: as high as the leg that has taken the weight carries it. ──
  const raise = new Array<number>(N).fill(0);
  const since = (l: number, i: number) => contact[l][i] ? wrap(i - runs[l].first) : -1;
  if (kind === 'Walk') {
    const limit = new Array<number>(N).fill(Infinity);
    legs.forEach((_, l) => {
      const { count } = runs[l], full = length[l][0] + length[l][1], other = 1 - l;
      for (let i = 0; i < N; i++) {
        const mine = since(l, i), theirs = since(other, i);
        // With both feet down the one that struck last carries; the trailing one comes up on its toe (below).
        // After its heel has come off a foot no longer sets the height either: it rolls up over its toe as far as the leg needs.
        if (mine < 0 || mine > runs[l].flatEnd || (theirs >= 0 && theirs < mine)) continue;
        const s = samples[l][i], at = ankle[l][i], flat2 = (s.H.x - at.x) ** 2 + (s.H.z - at.z) ** 2;
        const reach = full * Math.cos(stanceKnee(mine / Math.max(1, count - 1)) * Math.PI / 360);
        limit[i] = Math.min(limit[i], at.y + Math.sqrt(Math.max(0, reach * reach - flat2)) - s.H.y);
      }
    });
    // From heel off to the other foot's strike nothing sets the height: the pelvis goes over from the one to the other.
    const known = limit.map(Number.isFinite);
    for (let i = 0; i < N; i++) if (!known[i]) {
      let before = 1, after = 1;
      while (before < N && !known[wrap(i - before)]) before++;
      while (after < N && !known[wrap(i + after)]) after++;
      limit[i] = limit[wrap(i - before)] + (limit[wrap(i + after)] - limit[wrap(i - before)]) * smooth(before / (before + after));
    }
    // Support passes from one leg to the other without a corner, and nothing is asked of a leg beyond its reach: the
    // smooth curve that lies under the limit and touches it (smooth, take the lower, again).
    const sigma = Math.max(1, N * .014), radius = Math.ceil(sigma * 3);
    let soft = limit.slice();
    for (let pass = 0; pass < 12; pass++) {
      const blurred = soft.map((_, i) => { let sum = 0, weight = 0; for (let k = -radius; k <= radius; k++) { const w = Math.exp(-.5 * (k / sigma) ** 2); sum += soft[wrap(i + k)] * w; weight += w; } return sum / weight; });
      soft = blurred.map((v, i) => Math.min(v, limit[i]));
    }
    for (let i = 0; i < N; i++) raise[i] = soft[i];
  } else raise.fill(-(floorLevel[0] + floorLevel[1]) / 2);

  // ── A stance foot the pelvis has gone on from comes up on its toe until the leg reaches again. ──
  let maxHeelRise = 0;
  legs.forEach((leg, l) => {
    const { first, count, flatEnd } = runs[l], whole = length[l][0] + length[l][1], scale = footScale[l], other = 1 - l;
    const axis = (i: number) => leg.footUp.clone().cross(leg.footForward).applyQuaternion(footQ[l][i]).normalize();
    let carried = 0;
    for (let k = flatEnd + 1; k < count; k++) {
      const i = wrap(first + k), H = samples[l][i].H.clone().setY(samples[l][i].H.y + raise[i]), A = ankle[l][i];
      // Once the other foot has the floor this knee gives, 5 degrees to 35 by the time the toe leaves (pre-swing).
      const theirs = kind === 'Walk' ? since(other, i) : -1;
      const share = theirs >= 0 && theirs < k ? theirs / Math.max(1, count - 1 - (k - theirs)) : 0;
      const full = whole * Math.cos((5 + 30 * smooth(share)) * Math.PI / 360);
      if (A.distanceTo(H) <= full) { carried = 0; continue; }
      const pivot = toeTip[l].clone().applyQuaternion(footQ[l][i]).add(A), arm = A.clone().sub(pivot), around = axis(i);
      const at = (angle: number) => pivot.clone().add(arm.clone().applyAxisAngle(around, angle));
      // No further than a foot goes: about 70 degrees to the floor at toe off.
      const most = Math.max(0, 1.2 + Math.asin(T.MathUtils.clamp(leg.footForward.clone().applyQuaternion(footQ[l][i]).y, -1, 1)));
      let lo = 0, hi = most;
      if (at(hi).distanceTo(H) <= full) for (let n = 0; n < 24; n++) { const m = (lo + hi) / 2; if (at(m).distanceTo(H) <= full) hi = m; else lo = m; }
      carried = hi; maxHeelRise = Math.max(maxHeelRise, hi);
      A.copy(at(hi));
      footQ[l][i] = new T.Quaternion().setFromAxisAngle(around, hi).multiply(footQ[l][i]);
      A.y = Math.max(A.y, -leg.sole.offsetY(footQ[l][i], scale));
    }
    // Leaving the floor the shoe lets go of that rise over the first of the swing.
    const fade = Math.max(3, Math.round(N * .09));
    for (let k = 1; k <= fade && carried > 0; k++) {
      const i = wrap(first + count - 1 + k);
      if (contact[l][i]) break;
      footQ[l][i] = new T.Quaternion().setFromAxisAngle(axis(i), carried * (1 - smooth(k / (fade + 1)))).multiply(footQ[l][i]);
      ankle[l][i].y = Math.max(ankle[l][i].y, -leg.sole.offsetY(footQ[l][i], scale) + .004);
    }
  });

  // ── Thigh and shin, between that pelvis and that ankle, in the captured knee plane. ──
  const thighLocal: number[][] = legs.map(() => []), shinLocal: number[][] = legs.map(() => []), footLocal: number[][] = legs.map(() => []);
  const hipsLocal: number[] = [], times: number[] = [];
  const stanceFlex: number[] = [];
  let maxAnkleTwist = 0;
  const twistRef: (number | null)[] = legs.map(() => null);
  const twistOf = (leg: GaitLeg, shinQ: T.Quaternion, fq: T.Quaternion) => { const f = leg.footForward.clone().applyQuaternion(fq).applyQuaternion(shinQ.clone().invert()); return Math.atan2(f.x, f.z); };
  let swingKneeMax = 0, hipLow = Infinity, hipHigh = -Infinity, maxSlip = 0, minSole = Infinity;
  const supportBefore: (T.Vector3 | null)[] = legs.map(() => null);
  const write = (i: number, measure: boolean) => {
    const up = new T.Vector3(0, raise[i], 0);
    hipsLocal.push(...hipsAt[i].clone().add(up).applyMatrix4(hipsParent[i].clone().invert()).toArray());
    legs.forEach((leg, l) => {
      const s = samples[l][i], [l1, l2] = length[l], H = s.H.clone().add(up), A = ankle[l][i].clone();
      const to = A.clone().sub(H), far = (l1 + l2) * .9998;
      if (to.length() > far) A.copy(H).addScaledVector(to.normalize(), far);
      const axis = A.clone().sub(H), D = axis.length(); axis.normalize();
      const bend = s.K.clone().sub(s.H); bend.addScaledVector(axis, -bend.dot(axis));
      if (bend.lengthSq() < 1e-8) { bend.set(0, 0, 1).applyQuaternion(s.thighQ); bend.addScaledVector(axis, -bend.dot(axis)); }
      bend.normalize();
      const along = (l1 * l1 - l2 * l2 + D * D) / (2 * D), out = Math.sqrt(Math.max(0, l1 * l1 - along * along));
      const K = H.clone().addScaledVector(axis, along).addScaledVector(bend, out);
      const thighQ = new T.Quaternion().setFromUnitVectors(s.K.clone().sub(s.H).normalize(), K.clone().sub(H).normalize()).multiply(s.thighQ);
      const shinQ = new T.Quaternion().setFromUnitVectors(s.A.clone().sub(s.K).normalize(), A.clone().sub(K).normalize()).multiply(s.shinQ);
      thighLocal[l].push(...s.parentQ.clone().invert().multiply(thighQ).toArray());
      shinLocal[l].push(...thighQ.clone().invert().multiply(shinQ).toArray());
      footLocal[l].push(...shinQ.clone().invert().multiply(footQ[l][i]).toArray());
      if (!measure) return;
      const tw = twistOf(leg, shinQ, footQ[l][i]);
      if (twistRef[l] === null && since(l, i) >= 0 && since(l, i) <= runs[l].flatEnd) twistRef[l] = tw;
      if (twistRef[l] !== null) maxAnkleTwist = Math.max(maxAnkleTwist, Math.abs(deg(Math.atan2(Math.sin(tw - twistRef[l]!), Math.cos(tw - twistRef[l]!)))));
      const flex = deg(K.clone().sub(H).angleTo(A.clone().sub(K))), k = since(l, i);
      if (k >= 0 && k <= runs[l].flatEnd) stanceFlex.push(flex); else if (k < 0) swingKneeMax = Math.max(swingKneeMax, flex);
      hipLow = Math.min(hipLow, H.y); hipHigh = Math.max(hipHigh, H.y);
      const scale = footScale[l];
      minSole = Math.min(minSole, A.y + leg.sole.offsetY(footQ[l][i], scale));
      const point = leg.sole.supportPoint(footQ[l][i], scale, new T.Vector3()).multiply(scale).applyQuaternion(footQ[l][i]).add(A);
      point.z += speed * i * dt;
      const before = supportBefore[l];
      if (before && i > 0 && footQ[l][i].angleTo(footQ[l][i - 1]) < 1e-6 && contact[l][i] && contact[l][i - 1]) maxSlip = Math.max(maxSlip, Math.hypot(point.x - before.x, point.z - before.z));
      supportBefore[l] = point;
    });
  };
  for (let i = 0; i <= N; i++) { times.push(i * dt); write(i % N, i < N); }
  stanceFlex.sort((a, b) => a - b);

  const clip = source.clone();
  const set = (bone: T.Bone, property: 'position' | 'quaternion', values: number[]) => {
    const name = `${bone.name}.${property}`, track = property === 'position' ? new T.VectorKeyframeTrack(name, times, values) : new T.QuaternionKeyframeTrack(name, times, values);
    const at = clip.tracks.findIndex(t => t.name === name || t.name === `${bone.uuid}.${property}`);
    if (at >= 0) clip.tracks[at] = track; else clip.tracks.push(track);
  };
  set(hips, 'position', hipsLocal);
  legs.forEach((leg, l) => { set(leg.thigh, 'quaternion', thighLocal[l]); set(leg.shin, 'quaternion', shinLocal[l]); set(leg.foot, 'quaternion', footLocal[l]); });
  clip.resetDuration();
  let leftFootForwardFrac = 0;
  const leftIdx = legs.findIndex(leg => leg.side < 0);
  if (leftIdx >= 0) {
    let bestFwdZ = -Infinity;
    let bestI = 0;
    for (let i = 0; i < N; i++) {
      const dz = ankle[leftIdx][i].z - hipsAt[i].z;
      if (dz > bestFwdZ) {
        bestFwdZ = dz;
        bestI = i;
      }
    }
    const prevDz = ankle[leftIdx][wrap(bestI - 1)].z - hipsAt[wrap(bestI - 1)].z;
    const nextDz = ankle[leftIdx][wrap(bestI + 1)].z - hipsAt[wrap(bestI + 1)].z;
    const denom = 2 * (2 * bestFwdZ - prevDz - nextDz);
    const sub = Math.abs(denom) > 1e-6 ? T.MathUtils.clamp((nextDz - prevDz) / denom, -0.5, 0.5) : 0;
    const rawFrac = (bestI + sub) / N;
    leftFootForwardFrac = ((rawFrac % 1) + 1) % 1;
  }
  return {
    clip,
    report: {
      speed, duration: clip.duration,
      stanceKnee: stanceFlex.length ? [stanceFlex[0], stanceFlex[Math.floor(stanceFlex.length / 2)], stanceFlex[stanceFlex.length - 1]] : [0, 0, 0],
      swingKneeMax, hipRange: [hipLow, hipHigh], stanceShare: [runs[0].count / N, runs[1].count / N], maxSlip, minSole, maxAnchor, maxHeelRise, maxAnkleTwist,
      leftFootForwardFrac,
    },
  };
}

/**
 * The cast's Walk and Run put right for this skeleton, every other clip as it is. `speed` is what each corrected clip
 * is drawn for (model units a second, the floor under a stance foot): the rate a gait is played at comes from it.
 */
const _gaitV0 = new T.Vector3();
const _gaitV1 = new T.Vector3();
const _gaitV2 = new T.Vector3();
const _gaitScale = new T.Vector3();
const done = new WeakMap<T.AnimationClip, Map<string, GaitResult | null>>();
export function correctGaits(animations: readonly T.AnimationClip[], model: T.Object3D, skeleton: { hips: T.Bone; legs: readonly GaitLeg[] } | null) {
  const speed: Partial<Record<'Walk' | 'Run', number>> = {}, reports: Partial<Record<'Walk' | 'Run', GaitReport>> = {};
  let sig = 'default';
  if (skeleton && skeleton.legs.length > 0) {
    model.updateWorldMatrix(true, true);
    const ms = Math.max(1e-4, Math.abs(model.getWorldScale(_gaitScale).y));
    const l0 = skeleton.legs[0];
    l0.thigh.getWorldPosition(_gaitV0);
    l0.shin.getWorldPosition(_gaitV1);
    l0.foot.getWorldPosition(_gaitV2);
    const normLeg = (_gaitV0.distanceTo(_gaitV1) + _gaitV1.distanceTo(_gaitV2)) / ms;
    sig = `${normLeg.toFixed(3)}:${l0.sole.vertices}`;
  }
  const clips = animations.map(clip => {
    if (!skeleton || (clip.name !== 'Walk' && clip.name !== 'Run')) return clip;
    // Key by normalized leg length & sole vertex count so CAZ legRatio / footwear changes re-solve cleanly while default casts cache O(1).
    let bySig = done.get(clip);
    if (!bySig) { bySig = new Map(); done.set(clip, bySig); }
    let fixed = bySig.get(sig);
    if (fixed === undefined) { fixed = retargetGait(clip, model, skeleton.hips, skeleton.legs, clip.name); bySig.set(sig, fixed); }
    if (!fixed || !(fixed.report.speed > .2) || fixed.report.minSole < -.001) return clip;
    speed[clip.name] = fixed.report.speed; reports[clip.name] = fixed.report;
    return fixed.clip;
  });
  return { clips, speed, reports };
}
