/** Presentation only. Distance is observed motion, never a source of race progress. */
export interface RunnerMotion {
  y: number; stride: number; bank: number; drive: number; row: number; pose: number; phase: string; age: number;
}
export const createRunnerMotion = (y: number): RunnerMotion => ({y,stride:0,bank:0,drive:0,row:0,pose:0,phase:'',age:0});
// The atlas alternates feet in adjacent cells. Group the three drawings of each
// supporting leg into contact -> passing -> toe-off, then change supporting leg.
const RUN_POSES = [0,2,4,1,3,5];
const POSE_END = [.18,.34,.5,.68,.84,1];
export function animateRunner(m: RunnerMotion, y: number, vx: number, speed: number, phase: string, phaseTime: number, dt: number, reduced: boolean) {
  if(m.phase!==phase){m.phase=phase;m.age=0;}else m.age+=dt;
  if(phaseTime<0)phaseTime=m.age;
  const moving = phase === 'RUNNING' || phase === 'FINISHING' || phase === 'OPENING' && phaseTime >= .48;
  // Recoil, Swap/reconnect corrections and large snapshot jumps cannot reverse or
  // fast-forward a stride. Both local and remote bodies use their visible motion.
  const travel = moving ? Math.min(330*dt,Math.max(0,y-m.y)) : 0;
  m.y=y;
  const response=1-Math.exp(-dt*14);
  m.drive+=(Math.min(1,travel/Math.max(.001,153*dt))-m.drive)*response;
  m.bank+=((moving?Math.max(-1,Math.min(1,vx/430)):0)-m.bank)*(1-Math.exp(-dt*12));
  // Higher speeds lengthen the stride rather than multiplying cadence unchecked.
  const length=99+45*Math.max(0,Math.min(1,(speed-153)/177));
  m.stride=(m.stride+travel/length)%1;
  const pose=POSE_END.findIndex(end=>m.stride<end);
  const desiredRow=vx<-70?1:vx>70?2:0;
  if(pose===0||pose===3||m.drive<.15||m.row===desiredRow)m.row=desiredRow;
  m.pose=pose;
  let row=m.row,col=RUN_POSES[pose];
  if(phase==='STUMBLE'){row=3;col=Math.min(5,Math.floor(phaseTime/.13));}
  else if(phase==='FINISHED'){row=4;col=Math.min(5,Math.floor(phaseTime/.16));}
  else if(!moving){row=4;col=5;}
  const half=(m.stride*2)%1;
  // A tiny flight arc, zero at each foot contact. The shadow never follows it.
  const lift=reduced||!moving?0:Math.sin(half*Math.PI)**2*.009*m.drive;
  return {row,col,lift,bank:reduced?0:m.bank*.035,drive:m.drive,contact:pose===0||pose===3,stridePose:pose};
}
