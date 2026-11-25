import * as T from 'three';
import type { Grip } from './fingers';

export type HandGesture = 'idle' | 'wave' | 'clap' | 'cheer' | 'listen' | 'inspect' | 'reach' | 'dance' | 'hop';
export const GESTURE_SECONDS: Record<HandGesture, number> = { idle: 0, wave: 2.9, clap: 2.95, cheer: 2.8, listen: 2.6, inspect: 5.4, reach: 1.05, dance: 4.2, hop: .7 };

type V3 = [number, number, number];
/**
 * One hand in the owner's body frame: x outward from the midline, y up, z forward (metres from the eye).
 * `fingers` is where the fingers point, `palm` the way the palm faces; both are mirrored for the left hand.
 */
export interface HandPose { wrist: V3; fingers: V3; palm: V3; curl: number; pole: V3; /** The thumb held out of the way, radians. */ thumbOut?: number; grip?: Grip }

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

/** Where the two palms touch: half the hand's real thickness (palm surface to its axis) from the midline. */
export const CLAP_CONTACT = .0135;
const CLAP_TILT = .055;
/** Claps land where a person's do, not on a metronome: a little uneven, the last one softer. */
export const CLAP_BEATS = [.62, 1.13, 1.61, 2.14];
const CLAP_CLOSE = .16, CLAP_HOLD = .03;
/**
 * One moment of clapping. `open` 1 is hands apart, 0 is palm on palm. The hands accelerate into the contact, stay for
 * a moment while the impact travels up the arms, then come apart decelerating. `impact` fades over a few frames.
 */
export function clapState(t: number) {
  let previous = -Infinity, next = Infinity;
  for (const beat of CLAP_BEATS) { if (beat <= t) previous = beat; else if (next === Infinity) next = beat; }
  const impact = previous === -Infinity ? 0 : Math.exp(-(t - previous) * 20);
  if (next - t < CLAP_CLOSE) { const k = 1 - (next - t) / CLAP_CLOSE; return { open: 1 - k * k * k, impact }; }
  if (previous === -Infinity) return { open: 1, impact };
  const since = t - previous;
  if (since < CLAP_HOLD) return { open: 0, impact };
  const k = Math.min(1, (since - CLAP_HOLD) / .27);
  return { open: 1 - Math.pow(1 - k, 3), impact };
}

/** The gesture's target for one hand at `t` seconds, or null when this hand stays with the clip under it. */
export function gesturePose(g: HandGesture, side: number, t: number, palmDepth = CLAP_CONTACT): HandPose | null {
  const right = side > 0;
  switch (g) {
    case 'wave': {
      if (!right) return null;
      // The upper arm lifts and holds; the forearm swings from the elbow; the hand follows it a beat late, loose at the wrist.
      const strength = smooth((t - .3) / .42) * smooth((GESTURE_SECONDS.wave - .5 - t) / .5);
      const s = Math.sin((t - .34) * 7.0) * strength, lagging = Math.sin((t - .34) * 7.0 - .85) * strength;
      return { wrist: [.265 + s * .06, -.06 + Math.abs(s) * -.012, .30], fingers: [.08 + s * .22 + lagging * .24, .96, .16], palm: [-.08 + lagging * .14, -.12, .98], curl: .05, thumbOut: .28, pole: [.42, -.74, -.12], grip: 'open' };
    }
    case 'clap': {
      // Parallel palms that meet at their own thickness: the hands never pass through each other.
      // Elbows and shoulders bring the arms in; the forearms have turned the palms to face by the time the hands are up.
      const { open, impact } = clapState(t);
      return {
        wrist: [palmDepth + CLAP_TILT * .125 + open * .105, -.262 - impact * .007 + open * .006, .325 + impact * .005],
        // A hand's heel is thicker than its fingers: leaning in a little brings both to the other hand.
        fingers: [-CLAP_TILT, .42, .91], palm: [-1, 0, -CLAP_TILT],
        curl: 0,
        pole: [.20 + open * .10, -.96, -.08],
        // Fingers together and the thumb back along the hand for the whole clap: palms meet, thumbs never cross.
        grip: 'flat',
      };
    }
    case 'cheer': {
      // A dip, the arms thrown up past where they settle, then the fists bouncing on the happy rhythm, not quite together.
      const up = smooth((t - .16) / .3), settle = Math.sin(Math.min(1, Math.max(0, (t - .42) / .34)) * Math.PI);
      const bounce = Math.sin((t - .8) * 6.6 + (right ? 0 : .9)) * smooth((t - .75) / .3);
      return { wrist: [.225 + up * .04, mix(-.34, .09, up) + settle * .03 + bounce * .03, .29], fingers: [.10 + bounce * .05, .95, .22], palm: [-.76, -.14, .62], curl: .62 + Math.abs(bounce) * .08, pole: [.56, -.46, -.12] };
    }
    case 'listen': {
      if (!right) return null;
      // The hand comes up to cup the ear, the fingers curved behind it.
      return { wrist: [.262, -.172, .105], fingers: [-.22, .94, .20], palm: [-.92, -.12, .34], curl: .22, thumbOut: .1, pole: [.46, -.70, -.16], grip: 'cylinder' };
    }
    case 'inspect': {
      // Palms toward the eyes, the forearms roll the hands over, the fingers close one after another.
      const roll = smooth((t - 1.6) / 1.5) * Math.PI * .92;
      const inward = [-.95, 0, .3], toward = [-.3, .10, -.95];
      const palm: V3 = [toward[0] * Math.cos(roll) + inward[0] * Math.sin(roll), toward[1] * Math.cos(roll), toward[2] * Math.cos(roll) + inward[2] * Math.sin(roll)];
      const close = t > 3.3 && t < 4.9 ? Math.sin((t - 3.3) / 1.6 * Math.PI) : 0;
      return { wrist: [.135, -.215, .29], fingers: [-.12, .90, .38], palm, curl: .03 + close * .85, pole: [.50, -.82, -.10] };
    }
    case 'reach':
      if (!right) return null;
      return { wrist: [.15, -.20, .385], fingers: [-.18, .06, .98], palm: [-.26, -.95, .10], curl: .2, pole: [.46, -.76, -.18], grip: 'open' };
    case 'dance': {
      // Arms bent and loose, answering the bounce late, the way hanging weight does; the sway passes from side to side.
      const beat = Math.abs(Math.sin(t * 4.2)), sway = Math.sin(t * 2.1) * side, late = Math.abs(Math.sin(t * 4.2 - .55));
      const lift = smooth((t - .2) / .4);
      return { wrist: [.235 + sway * .05, mix(-.42, -.255, lift) + late * .058, .265 + sway * .06], fingers: [-.22 + sway * .12, .46 - (1 - beat) * .14, .86], palm: [-.84, -.42, .10], curl: .42 + late * .08, pole: [.46, -.80, -.30] };
    }
    case 'hop': {
      const k = Math.sin(Math.min(1, t / GESTURE_SECONDS.hop) * Math.PI);
      return { wrist: [.255, -.40 + .18 * k, .18 + k * .1], fingers: [-.10, .30 * k - .3, .95], palm: [-.80, -.56, .05], curl: .36, pole: [.52, -.80, -.24] };
    }
    default: return null;
  }
}

export interface GestureBody { rise: number; hipRoll: number; spinePitch: number; chestPitch: number; chestRoll: number; spineYaw: number; headPitch: number; headYaw: number; headRoll: number }
const STILL: GestureBody = { rise: 0, hipRoll: 0, spinePitch: 0, chestPitch: 0, chestRoll: 0, spineYaw: 0, headPitch: 0, headYaw: 0, headRoll: 0 };
const OUT: GestureBody = { ...STILL };
/**
 * What the whole body does while the hands gesture. The sign of a pitch is the look's: + leans back or looks up.
 * Every gesture moves the weight first and the arms after it: anticipation, then action, then settle.
 */
export function gestureBody(g: HandGesture, t: number): GestureBody {
  Object.assign(OUT, STILL);
  switch (g) {
    case 'wave': {
      const lean = smooth(t / .4);
      OUT.chestRoll = -.035 * lean; OUT.hipRoll = .02 * lean; OUT.headRoll = .06 * lean + Math.sin((t - .34) * 3.5) * .02 * lean; OUT.headPitch = .03 * lean;
      break;
    }
    case 'clap': {
      const { impact, open } = clapState(t);
      OUT.spinePitch = -.02 - impact * .012; OUT.chestPitch = -.05 - impact * .02 + open * .01; OUT.rise = -.004 * impact; OUT.headPitch = -.05 - impact * .02;
      break;
    }
    case 'cheer': {
      const dip = t < .3 ? Math.sin(t / .3 * Math.PI) : 0, up = smooth((t - .16) / .3);
      const bounce = Math.max(0, Math.sin((t - .8) * 6.6)) * smooth((t - .75) / .3);
      OUT.rise = -.045 * dip + .018 * bounce; OUT.spinePitch = -.08 * dip + .05 * up; OUT.chestPitch = -.05 * dip + .08 * up; OUT.headPitch = .12 * up;
      OUT.chestRoll = Math.sin((t - .8) * 3.3) * .05 * up;
      break;
    }
    case 'listen': {
      const nod = Math.max(0, Math.sin((t - .55) * 3.4)) * smooth((t - .4) / .3);
      OUT.headRoll = .13 * smooth(t / .5); OUT.headPitch = -.04 - nod * .14; OUT.chestRoll = .018; OUT.spinePitch = -.02;
      break;
    }
    case 'inspect': OUT.headPitch = -.12; OUT.chestPitch = -.04; break;
    case 'reach': {
      const k = Math.sin(Math.min(1, t / .5) * Math.PI / 2);
      OUT.spinePitch = -.05 * k; OUT.chestPitch = -.07 * k; OUT.spineYaw = -.08 * k;
      break;
    }
    case 'dance': {
      const beat = Math.abs(Math.sin(t * 4.2)), sway = Math.sin(t * 2.1);
      OUT.rise = -.035 + beat * .03; OUT.hipRoll = sway * .09; OUT.chestRoll = -sway * .10; OUT.spineYaw = sway * .10; OUT.headRoll = sway * .05; OUT.headPitch = (beat - .5) * .06; OUT.chestPitch = -.02;
      break;
    }
    case 'hop': {
      const k = t / GESTURE_SECONDS.hop;
      OUT.spinePitch = -.10 * Math.sin(Math.min(1, k * 2.6) * Math.PI); OUT.chestPitch = -.06 * Math.sin(Math.min(1, k * 2.6) * Math.PI);
      break;
    }
    default: break;
  }
  return OUT;
}

/** How far this pose may bend the wrist off the forearm, radians. A hand follows its forearm; only a clap or a wave asks the wrist for more. */
export function wristLimit(g: HandGesture, envelope: number) {
  const asked = g === 'clap' ? .9 : g === 'wave' ? .62 : g === 'reach' ? .5 : g === 'listen' ? .62 : .34;
  return mix(.34, asked, envelope);
}

/** A gesture eases in and out of the pose under it; nothing snaps. */
export function gestureEnvelope(g: HandGesture, t: number) {
  if (g === 'idle') return 0;
  return smooth(Math.min(t / .3, (GESTURE_SECONDS[g] - t) / .42));
}

const axisX = new T.Vector3(), axisY = new T.Vector3(), axisZ = new T.Vector3(), basisM = new T.Matrix4();
/** The cast's hand bones, both sides: fingers along +Y, palm toward +Z. The thumb follows from the mesh, never from a separate rule. */
export function handRotation(fingers: T.Vector3, palm: T.Vector3, out = new T.Quaternion()) {
  axisY.copy(fingers);
  if (axisY.lengthSq() < 1e-10) axisY.set(0, 1, 0);
  else axisY.normalize();
  axisZ.copy(palm).addScaledVector(axisY, -palm.dot(axisY));
  if (axisZ.lengthSq() < 1e-6) axisZ.set(0, 0, 1).addScaledVector(axisY, -axisY.z);
  if (axisZ.lengthSq() < 1e-6) axisZ.set(1, 0, 0).addScaledVector(axisY, -axisY.x);
  axisZ.normalize();
  axisX.crossVectors(axisY, axisZ).normalize();
  return out.setFromRotationMatrix(basisM.makeBasis(axisX, axisY, axisZ)).normalize();
}

export const SHOWER_RINSE_PERIOD = 2.8;

/**
 * Standing walk-in shower upper-body/forearm rinse profile (metres from eye in body frame, mirrored by `side`):
 * keeps elbows comfortably lowered while hands alternate gently across shoulders/collarbones/temples.
 */
export function showerRinseHandPose(side: number, t: number): HandPose {
  const phase = (t / SHOWER_RINSE_PERIOD) * Math.PI * 2 + (side > 0 ? 0 : Math.PI);
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  return {
    wrist: [0.155 + 0.025 * c, -0.245 + 0.055 * s, 0.215 + 0.020 * c],
    fingers: [-0.24 + 0.05 * c, 0.86 + 0.04 * s, 0.42 - 0.06 * s],
    palm: [-0.52, -0.22, -0.82],
    curl: 0.28 + 0.06 * Math.abs(s),
    pole: [0.42, -0.76, -0.14],
    grip: 'relaxed',
  };
}

const RINSE_BODY: GestureBody = { ...STILL };
export function showerRinseBody(t: number): GestureBody {
  const phase = (t / SHOWER_RINSE_PERIOD) * Math.PI * 2;
  const sway = Math.sin(phase);
  Object.assign(RINSE_BODY, STILL);
  RINSE_BODY.headPitch = -0.10;
  RINSE_BODY.headRoll = 0.022 * sway;
  RINSE_BODY.chestPitch = -0.03;
  RINSE_BODY.chestRoll = -0.018 * sway;
  RINSE_BODY.spineYaw = 0.024 * sway;
  return RINSE_BODY;
}
