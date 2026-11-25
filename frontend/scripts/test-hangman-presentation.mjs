import assert from 'node:assert/strict';
import { playableEntry, acceptsRound, descent, lossPhase, LOSS_DURATION } from '../src/components/features/games/hangman/hangmanPresentation.ts';
const track = { difficulty:'EASY', highestUnlocked:5, lastPlayedLevel:4, publishedLevels:20, catalogCompleted:false };
const active = {roundId:'a',status:'ACTIVE',levelNumber:4,version:3};
assert.deepEqual(playableEntry(track,null),{resume:null,level:4,completed:false});
assert.equal(playableEntry(track,active).resume,active);
assert.equal(playableEntry(track,{...active,status:'WON'}).level,5);
assert.equal(playableEntry(track,{...active,status:'LOST'}).level,4);
assert.equal(playableEntry({...track,catalogCompleted:true},{...active,status:'WON'}).completed,true);
// A historical win cannot request a locked level; replay respects current progression.
assert.equal(playableEntry({...track,highestUnlocked:4},{...active,status:'WON'}).level,4);
assert.equal(playableEntry({...track,catalogCompleted:true},active).resume,active);
for(const event of ['refresh','retry command','hint','guess']){
  assert.equal(acceptsRound(active,{...active,version:4},7,7),true,event);
  assert.equal(acceptsRound(active,{...active,version:2},7,7),false,event);
  assert.equal(acceptsRound(active,{...active,roundId:'old'},7,7),false,event);
  assert.equal(acceptsRound(active,{...active,version:99},7,8),false,`${event}: account/route/difficulty changed`);
}
for(const initial of [6,7,8,9,10]){
  assert.equal(descent(initial,initial),0);
  let last=-1;
  for(let remaining=initial;remaining>=1;remaining--){const drop=descent(initial,remaining);assert.ok(drop>last);assert.ok(341+drop<412);last=drop;}
  assert.equal(descent(initial,1),58);
}
assert.deepEqual([0,280,1100,1320,2000,2850,3070,LOSS_DURATION].map(lossPhase),['FINAL_POP','FREE_FALL','WATER_CONTACT','WATER_STRUGGLE','SHARK_APPROACH','SHARK_BITE','X_EYES_REACTION','LOSS_RESULT']);
assert.equal(lossPhase(LOSS_DURATION-1),'X_EYES_REACTION');
assert.equal(lossPhase(999999),'LOSS_RESULT');
console.log('Hangman entry/version/descent/loss timeline regressions: PASS');

// The controller stays inside the joint ranges inspected in the frozen pose review.
const {explorerPose,explorerHands,jawFront,mouthBridge}=await import('../src/components/features/games/hangman/hangmanRig.ts');
const {balloonHand,balloonRope}=await import('../src/components/features/games/hangman/hangmanRig.ts');
assert.deepEqual(Array.from({length:10},(_,i)=>balloonHand(i)),[0,0,0,1,1,1,0,1,0,1]);
const hands=explorerHands({head:0,leftArm:-6,rightArm:7,leftLeg:0,rightLeg:0});
for(let i=0;i<10;i++){
  const [hx,hy]=hands[balloonHand(i)],taut=balloonRope(300,50,[hx,hy],4,-2),slack=balloonRope(300,50,[hx,hy],4,-2,1);
  assert.ok(taut.startsWith('M304 85 '),'Rope starts at moving knot tip, not balloon centre');
  assert.ok(taut.endsWith(`${hx} ${hy}`)&&slack.endsWith(`${hx} ${hy}`),'Tension loss preserves inherited grip endpoint until release');
  assert.notEqual(taut,slack,'Pop loses tension without scaling an entire rope away from the hand');
}
for(let at=0;at<=4600;at+=17){
 const pose=explorerPose(at,at,null,false,false);
 for(const angle of Object.values(pose))assert.ok(Number.isFinite(angle)&&Math.abs(angle)<=7,'Motion must stay within reviewed joint overlap');
 for(const hand of explorerHands(pose))assert.ok(hand.every(Number.isFinite),'Ropes use finite inherited hand anchors');
}
for(let a=0;a<=30;a+=.5){assert.ok(jawFront(a)[1]>=jawFront(0)[1],'Lower jaw opens down from the fixed rear hinge');assert.ok(!mouthBridge(a).includes('NaN'));}
console.log('Hangman rig geometry: PASS (reviewed joint ranges, rope anchors, continuous mouth opening).');

const {balloonBundle,gripTransfer,gripState,GRIP_TRANSFER_DURATION,WATER_Y,WATER_DROP,FOOT_CONTACT_DROP,WATER_SETTLED_AT,WATER_ENTRY_X,EXPLORER_GRIPS,EXPLORER_WATERLINE,EXPLORER_FEET_Y,lossMotion,surfaceBiteTarget,waterContactMotion,sharkMouthCentre,mirrorBundles}=await import('../src/components/features/games/hangman/hangmanRig.ts');
const {lossClockRate}=await import('../src/components/features/games/hangman/hangmanPresentation.ts');
assert.equal(balloonBundle([0,3]),'DUAL');
// Equal counts, different surviving ownership: neither direction can be inferred from count.
assert.equal(balloonBundle([0,1,2]),'LEFT');assert.equal(balloonBundle([3,4,5]),'RIGHT');
assert.equal(balloonBundle([]),'RELEASED');assert.equal(gripState('RELEASED',0),'FINAL_RELEASE');
assert.notEqual(mirrorBundles('round-a'),mirrorBundles('round-b'));
for(const mirrored of [false,true]){
 const ids=[0,1,2],bundle=balloonBundle(ids,mirrored);
 assert.equal(bundle,mirrored?'RIGHT':'LEFT');
 const before=structuredClone(ids);
 assert.equal(gripTransfer(bundle,0).state,mirrored?'TRANSFER_TO_RIGHT_BUNDLE':'TRANSFER_TO_LEFT_BUNDLE');
 assert.equal(gripTransfer(bundle,100).secondaryGrip,0,'Empty hand visibly releases first');
 let last=explorerHands({head:0,leftArm:0,rightArm:0,leftLeg:0,rightLeg:0});
 for(let t=0;t<=GRIP_TRANSFER_DURATION;t+=10){
  const transfer=gripTransfer(bundle,t),points=explorerHands({head:0,leftArm:transfer.leftArm,rightArm:transfer.rightArm,leftLeg:0,rightLeg:0});
  points.forEach((point,i)=>assert.ok(Math.hypot(point[0]-last[i][0],point[1]-last[i][1])<3,'No hand teleport or arm stretch'));
  last=points;
 }
 const final=gripTransfer(bundle,GRIP_TRANSFER_DURATION);
 assert.equal(final.state,'SINGLE_BUNDLE_TWO_HAND_HOLD');assert.equal(final.secondaryGrip,1);
 assert.ok(Math.hypot(last[0][0]-last[1][0],last[0][1]-last[1][1])<25,'Two hands secure the same bundle');
 assert.deepEqual(ids,before,'Presentation cannot consume a second balloon');
}
assert.equal(WATER_DROP+EXPLORER_WATERLINE,WATER_Y);
assert.ok(WATER_DROP+EXPLORER_FEET_Y>WATER_Y,'Lower body is actually under water');
for(const initial of [0,58]){
 const before=lossMotion(279,initial,true),fall=lossMotion(690,initial,true),wet=lossMotion(1100,initial,true);
 assert.equal(before.drop,initial);assert.ok(fall.drop>initial&&fall.drop<wet.drop);
 assert.equal(wet.drop,FOOT_CONTACT_DROP);assert.equal(wet.wet,true);
 assert.equal(wet.drop+EXPLORER_FEET_Y,WATER_Y,'Splash starts when soles actually reach water');
 assert.equal(lossMotion(WATER_SETTLED_AT,initial,true).drop,WATER_DROP);
 assert.equal(lossMotion(3069,initial,true).xEyes,false);assert.equal(lossMotion(3070,initial,true).xEyes,true);
 const bite=lossMotion(2850,initial,true),target=surfaceBiteTarget(bite.drop,bite.x,bite.angle);
 assert.equal(target.y,WATER_Y-12,'Bite follows the submerged torso at the water surface');
}
assert.equal(LOSS_DURATION/lossClockRate(true),1100,'Reduced motion has a clear, short terminal sequence');
console.log('Hangman: both bundle transfers, final release, water collision, bite and X-eye timing PASS.');

assert.equal(EXPLORER_GRIPS[0].anatomy,'RIGHT');assert.equal(EXPLORER_GRIPS[1].anatomy,'LEFT');
assert.ok(EXPLORER_GRIPS[0].crop[0]>EXPLORER_GRIPS[1].crop[0],'Closed atlas order differs from open palms');
assert.ok(WATER_ENTRY_X>330&&WATER_ENTRY_X<350);
let lastDrop=58;
for(let time=280;time<=WATER_SETTLED_AT;time+=10){
 const drop=lossMotion(time,58,true).drop;assert.ok(drop>=lastDrop);lastDrop=drop;
 assert.equal(waterContactMotion(time,true).splash===0,time<=1100||time>=1820);
}
for(const angle of [0,10,30]){
 const centre=sharkMouthCentre(angle),tip=jawFront(angle);
 assert.ok(centre[1]>=-23&&centre[1]<10);if(angle>=10)assert.ok(tip[1]>=centre[1]);
}
console.log('Hangman V4.3 anatomical crop mapping, soles/contact/settle and jaw-centre targeting PASS.');

for(const budget of [6,7,8,9,10]){const ids=Array.from({length:budget},(_,i)=>i);assert.ok(Math.abs(ids.filter(i=>balloonHand(i)===0).length-ids.filter(i=>balloonHand(i)===1).length)<=1);assert.equal(balloonBundle(ids),"DUAL");}
