/** Atlas-space anchors and bounded poses shared by the renderer and scene controller. */
export const EXPLORER_SOURCE_ROOT = [1088, 1044] as const;
export const EXPLORER_SCALE = .63;
export const EXPLORER_NECK = [330, 217] as const;
/** Arm names are screen sides. Facing us, the explorer's anatomical RIGHT is
 * screen-left. The grip atlas has the opposite order from its open palms: its
 * rightmost grip has the outward left thumb. Swap source crops/pivots together,
 * leaving the intact arm chain and its world wrist unchanged. No mirroring. */
export const EXPLORER_GRIPS = [
  { anatomy: 'RIGHT', wrist: [979,976], sourceWrist: [766,877], sourceGrip: [759,765], crop: [686,706,156,192], angle: -20, scale: .32 },
  { anatomy: 'LEFT', wrist: [1189,982], sourceWrist: [480,877], sourceGrip: [491,765], crop: [410,706,155,192], angle: 25, scale: .32 },
] as const;
export type ExplorerPose = { head: number; leftArm: number; rightArm: number; leftLeg: number; rightLeg: number };
export const EXPLORER_REST: ExplorerPose = { head: 0, leftArm: 0, rightArm: 0, leftLeg: 0, rightLeg: 0 };
export const EXPLORER_CONTACT = [385, 327] as const;
export const EXPLORER_JOINTS = { leftArm: [1038,1046], rightArm: [1138,1042], leftLeg: [1067,1116], rightLeg: [1123,1116] } as const;
export function ease(n: number) { const t=Math.min(1,Math.max(0,n)); return t*t*(3-2*t); }
export function explorerHands(pose: ExplorerPose) {
  return EXPLORER_GRIPS.map((grip,i)=>{
    const ga=grip.angle*Math.PI/180, dx=(grip.sourceGrip[0]-grip.sourceWrist[0])*grip.scale,dy=(grip.sourceGrip[1]-grip.sourceWrist[1])*grip.scale;
    const x=grip.wrist[0]+dx*Math.cos(ga)-dy*Math.sin(ga), y=grip.wrist[1]+dx*Math.sin(ga)+dy*Math.cos(ga);
    const [hx,hy]=EXPLORER_JOINTS[i===0?'leftArm':'rightArm'], a=(i===0?pose.leftArm:pose.rightArm)*Math.PI/180;
    return [EXPLORER_NECK[0]+(hx+(x-hx)*Math.cos(a)-(y-hy)*Math.sin(a)-EXPLORER_SOURCE_ROOT[0])*EXPLORER_SCALE,
      EXPLORER_NECK[1]+(hy+(x-hx)*Math.sin(a)+(y-hy)*Math.cos(a)-EXPLORER_SOURCE_ROOT[1])*EXPLORER_SCALE] as const;
  });
}
export const EXPLORER_HANDS = explorerHands(EXPLORER_REST);
export const mirrorBundles = (roundId: string) => Array.from(roundId).reduce((sum,c)=>sum+c.charCodeAt(0),0)%2===1;
export const balloonHand = (index: number, mirrored = false) => {
  const hand=([0,0,0,1,1,1,0,1,0,1] as const)[index];
  return mirrored?1-hand:hand;
};
export type Bundle = 'DUAL' | 'LEFT' | 'RIGHT' | 'RELEASED';
export type GripState = 'DUAL_BUNDLE_HOLD' | 'TRANSFER_TO_LEFT_BUNDLE' | 'TRANSFER_TO_RIGHT_BUNDLE' | 'SINGLE_BUNDLE_TWO_HAND_HOLD' | 'FINAL_RELEASE';
/** Inspect each surviving attachment, including asymmetric fixtures. Count alone
 * cannot tell which hand has lost its last string. IDs follow the existing rig. */
export function balloonBundle(ids: readonly number[], mirrored = false): Bundle {
  const left=ids.some(id=>balloonHand(id,mirrored)===0),right=ids.some(id=>balloonHand(id,mirrored)===1);
  return left&&right?'DUAL':left?'LEFT':right?'RIGHT':'RELEASED';
}
export const GRIP_TRANSFER_DURATION = 850;
export function gripState(bundle: Bundle, age: number): GripState {
  if(bundle==='RELEASED')return 'FINAL_RELEASE';
  if(bundle==='DUAL')return 'DUAL_BUNDLE_HOLD';
  if(age<GRIP_TRANSFER_DURATION)return bundle==='LEFT'?'TRANSFER_TO_LEFT_BUNDLE':'TRANSFER_TO_RIGHT_BUNDLE';
  return 'SINGLE_BUNDLE_TWO_HAND_HOLD';
}
/** Rotate the intact painted arms around their shoulders; never stretch wrists.
 * Hands meet diagonally above the cap, with room for both curled-finger sprites. */
export function bundlePose(bundle: Bundle) {
  return bundle==='LEFT'?{leftArm:44,rightArm:-63}:bundle==='RIGHT'?{leftArm:58,rightArm:-48}:{leftArm:0,rightArm:0};
}
export function gripTransfer(bundle: Bundle, age: number) {
  const t=ease((age-140)/(GRIP_TRANSFER_DURATION-140)),target=bundlePose(bundle);
  return { ...target, leftArm:target.leftArm*t,rightArm:target.rightArm*t,
    secondaryGrip:ease((age-650)/200),state:gripState(bundle,age) };
}
/** Scene world coordinates are shared by the painted sea, collision and actors.
 * The waterline bisects neck-to-boots anatomy, leaving head/upper torso readable. */
export const WATER_Y = 412;
// Last opaque left-sole pixel is y=1230 (right sole y=1224), not atlas padding.
export const EXPLORER_FEET_Y = EXPLORER_NECK[1]+(1230-EXPLORER_SOURCE_ROOT[1])*EXPLORER_SCALE;
export const EXPLORER_WATERLINE = (EXPLORER_NECK[1]+EXPLORER_FEET_Y)/2;
export const WATER_DROP = WATER_Y-EXPLORER_WATERLINE;
export const WATER_ENTRY_X = EXPLORER_NECK[0]+(1107-EXPLORER_SOURCE_ROOT[0])*EXPLORER_SCALE;
export const FOOT_CONTACT_DROP = WATER_Y-EXPLORER_FEET_Y;
export const WATER_CONTACT_AT = 1100;
export const WATER_SETTLED_AT = 1580;
export const BITE_AT = 2850;
export const X_EYES_AT = 3070;
export function lossMotion(elapsed: number, initialDrop: number, reduced = false) {
  const fall=Math.min(1,Math.max(0,(elapsed-280)/(WATER_CONTACT_AT-280)));
  const wet=elapsed>=WATER_CONTACT_AT;
  const settle=ease((elapsed-WATER_CONTACT_AT)/(WATER_SETTLED_AT-WATER_CONTACT_AT));
  const bob=wet&&!reduced?Math.sin((elapsed-WATER_CONTACT_AT)/150)*2.0*settle:0;
  const recoil=-7*Math.sin(Math.PI*ease((elapsed-BITE_AT)/220));
  return {drop:initialDrop+(FOOT_CONTACT_DROP-initialDrop)*fall*fall+(WATER_DROP-FOOT_CONTACT_DROP)*settle+bob+recoil,
    x:recoil*.55,angle:reduced?0:wet?Math.sin((elapsed-WATER_CONTACT_AT)/160)*1.5*settle:Math.sin(elapsed/95)*2*(1-ease(fall)),
    wet,xEyes:elapsed>=X_EYES_AT};
}
/** Mouth centre is aimed at the upper torso at the same physical water plane. */
export function surfaceBiteTarget(drop: number, x = 0, angle = 0) {
  const a=angle*Math.PI/180,dx=24,dy=EXPLORER_WATERLINE-12-245;
  return {x:330+x+dx*Math.cos(a)-dy*Math.sin(a),y:245+drop+dx*Math.sin(a)+dy*Math.cos(a)};
}
/** End behind the curled fingers. The knot uses the same +37 point as its painted tip. */
export function balloonRope(x: number, y: number, hand: readonly number[], sway: number, lift: number, slack = 0) {
  const sx=x+sway,sy=y+37+lift,[hx,hy]=hand;
  return `M${sx} ${sy} Q${(sx+hx)/2+sway*.35+slack*18} ${(sy+hy)/2+slack*28} ${hx} ${hy}`;
}
/** Keep angles inside the visually reviewed ranges; ease the panic envelope and
 * offset the head/legs in time so momentum travels through the complete figure. */
export function explorerPose(now: number, lossElapsed: number|null, reactionAge: number|null, happy: boolean, reduced: boolean, thinking = false): ExplorerPose {
  if(reduced) return { ...EXPLORER_REST, head: lossElapsed===null?0:3 };
  const panic=lossElapsed===null?0:ease(lossElapsed/600)*(1-ease((lossElapsed-2700)/950));
  const startled=reactionAge===null?0:Math.sin(Math.PI*ease(reactionAge/600));
  const t=now/1000, kick=panic*Math.sin((lossElapsed??0)/130), cheer=happy?2:0;
  return { head: Math.sin(t*1.3-.4)*1.4+panic*3-startled*2+(thinking?2:0),
    leftArm: Math.sin(t*1.1)*1.8+panic*(-2+kick*3)-startled*3-cheer,
    rightArm: Math.sin(t*1.0+.8)*1.7+panic*(2-kick*3)+startled*3+cheer,
    leftLeg: Math.sin(t*1.7)*2.2+panic*Math.sin((lossElapsed??0)/150)*4+startled*2,
    rightLeg: Math.sin(t*1.5+1.2)*2.0+panic*Math.sin((lossElapsed??0)/170+.8)*4-startled*2 };
}
/** Source mouth corner (369,307), mapped uniformly from body origin (20,109). */
export const SHARK_SCALE = .36;
export const SHARK_HINGE = [5.64, -16.72] as const;
export const JAW_SOURCE_HINGE = [905, 474] as const;
export const SHARK_LIP = [-109.2, -19.96] as const;
export const JAW_FRONT = [-112.32, -7.92] as const;
export function jawFront(open: number) {
  const a = -open * Math.PI / 180, [x,y] = JAW_FRONT;
  return [SHARK_HINGE[0]+x*Math.cos(a)-y*Math.sin(a), SHARK_HINGE[1]+x*Math.sin(a)+y*Math.cos(a)] as const;
}
export function mouthBridge(open: number) {
  const [x,y] = jawFront(open), [hx,hy] = SHARK_HINGE;
  return `M${SHARK_LIP.join(' ')} Q-55 -6 ${hx} ${hy} L${x.toFixed(3)} ${y.toFixed(3)} Q-113 ${(y-10).toFixed(3)} ${SHARK_LIP.join(' ')}Z`;
}
/** Aim the opening between the actual upper lip and rotating lower-jaw tip.
 * This keeps the bite at the torso while the jaw closes, without a magic offset. */
export function sharkMouthCentre(open: number) {
  const front=jawFront(open);
  return [(SHARK_LIP[0]+front[0])/2,(SHARK_LIP[1]+front[1])/2] as const;
}
/** One surface effect clock, fixed world origin. Shapes expand/fade locally. */
export function waterContactMotion(elapsed: number, reduced = false) {
  const age=Math.max(0,elapsed-WATER_CONTACT_AT),wet=elapsed>=WATER_CONTACT_AT;
  return {splash:wet?(1-ease(age/720))*ease(age/60):0,
    spread:.65+.7*ease(age/1000),ripple:wet?.55+.35*(reduced?0:Math.sin(age/170)**2):0};
}
