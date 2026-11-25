import * as T from 'three';
import type {HumanRig} from '@/lib/embodiment/human';
import {acquireLifeAsset, releaseLifeAsset, instance, placeOn} from './assets';
import type {EchoLifeWorld} from './world';

export type CourtAction = 'join'|'strike'|'replay'|'leave';
export interface CourtFrame {
  revision:number; phase:'OPEN'|'WAITING'|'SERVE'|'FLIGHT'|'PAUSED'|'MISSED'|'COMPLETE';
  north:number|null; south:number|null; turn:number; returns:number; goal:number;
  netX:number; netZ:number; depth:number; fromX:number; toX:number; hitAt:number; serverNow:number; flightMs:number;
}
export interface CourtControls {
  phase:CourtFrame['phase']; joined:boolean; turn:boolean; action:CourtAction|null; ready:boolean; returns:number; goal:number;
}

/** Per-view visuals. Only the room server changes sides, timing or the rally count. */
export class SharedCourt {
  private frame:CourtFrame|null=null;
  controls:CourtControls|null=null;
  private pending:{action:CourtAction;revision:number}|null=null;
  private waitingUntil=0;
  private props:T.Group|null=null;
  private shuttle:T.Group|null=null;
  private rackets:T.Group[]=[];
  private point=new T.Vector3();

  act(action:CourtAction) {
    if(!this.frame || !this.controls || performance.now()<this.waitingUntil) return false;
    if(action==='leave' ? !this.controls.joined : (action!==this.controls.action || !this.controls.ready))return false;
    this.pending={action,revision:this.frame.revision};
    this.waitingUntil=performance.now()+420;
    return true;
  }
  takeIntent() { const value=this.pending; this.pending=null; return value; }

  update(frame:CourtFrame|null,received:number,group:T.Group,world:EchoLifeWorld,body:T.Vector3|null,
         base:{x:number;z:number}|undefined,user:number,localRig:HumanRig|null,
         peerRig:(id:number)=>HumanRig|undefined,reduced:boolean) {
    if (!frame || !base || !body) { this.clear(); return; }
    if(this.frame?.revision!==frame.revision)this.waitingUntil=0;
    this.frame=frame;
    const x=base.x+frame.netX,z=base.z+frame.netZ;
    const side=body.z<z?0:1, own=frame.north===user?0:frame.south===user?1:-1;
    const age=frame.serverNow-frame.hitAt+performance.now()-received;
    const phase=frame.phase;
    let action:CourtAction|null=null;
    let ready=false;
    if(own===-1 && (side===0?frame.north:frame.south)===null) {
      action='join';
      ready=Math.abs(body.z-z)>=.6 && Math.hypot(body.x-x,body.z-z-(side===0?-frame.depth:frame.depth))<=2.6;
    } else if(own!==-1 && (phase==='COMPLETE' || phase==='MISSED')) { action='replay'; ready=own===side; }
    else if(own===frame.turn && (phase==='SERVE' || phase==='FLIGHT')) {
      action='strike';
      ready=own===side && (phase==='SERVE' || age>=frame.flightMs*2/3 && age<=frame.flightMs+900)
        && Math.hypot(body.x-x-frame.toX,body.z-z-(own===0?-frame.depth:frame.depth))<=2.1;
    }
    this.controls={phase,joined:own>=0,turn:own===frame.turn,action,ready,returns:frame.returns,goal:frame.goal};
    if(frame.north===null && frame.south===null){this.releaseProps();return;}
    if(!this.props)this.loadProps(group);
    const floor=world.walk.groundAt(x,z)??0;
    if(this.shuttle) {
      const t=phase==='FLIGHT'?Math.min(1,Math.max(0,age/frame.flightMs)):1;
      const dir=frame.turn===0?-1:1;
      this.shuttle.position.set(x+T.MathUtils.lerp(frame.fromX,frame.toX,t),
        floor+1.12+Math.sin(Math.PI*t)*1.22,z+dir*frame.depth*(2*t-1));
      this.shuttle.rotation.x=reduced?0:dir*(1.1-2.2*t);
      this.shuttle.visible=phase==='SERVE' || phase==='FLIGHT';
    }
    for(const [i,racket] of this.rackets.entries()) {
      const player=i===0?frame.north:frame.south, rig=player===user?localRig:player!=null?peerRig(player):null;
      racket.visible=!!rig;
      if(!rig)continue;
      racket.position.copy(group.worldToLocal(rig.wristWorld(1,this.point)));
      const swing=!reduced && phase==='FLIGHT' && i!==frame.turn && age>=0 && age<400 ? Math.sin(age*Math.PI/400) : 0;
      racket.rotation.set(-.55+swing*.75,i===0?0:Math.PI,-.25,'YXZ');
    }
  }
  private loadProps(parent:T.Group) {
    const props=new T.Group();
    props.name='echo-life-shared-court'; this.props=props; parent.add(props);
    void acquireLifeAsset('court-racket').then(p=>{
      if(!p || this.props!==props)return;
      for(let i=0;i<2;i++) {
        // The factory grip anchor is (0,9,-240) mm in the metric design frame.
        const racket=instance(p,[new T.Matrix4().makeTranslation(0,-.009,.24)]);
        racket.name='court-racket-'+i; racket.visible=false;props.add(racket);this.rackets.push(racket);
      }
    });
    void acquireLifeAsset('court-shuttle').then(p=>{
      if(!p || this.props!==props)return;
      this.shuttle=instance(p,[placeOn(p,0,0,0,0)]);
      this.shuttle.name='court-shuttle';this.shuttle.visible=false;props.add(this.shuttle);
    });
  }
  private releaseProps() {
    if(!this.props)return;
    this.props.removeFromParent();this.props=null;this.rackets=[];this.shuttle=null;
    releaseLifeAsset('court-racket');releaseLifeAsset('court-shuttle');
  }
  clear() {
    this.frame=null; this.controls=null; this.pending=null; this.waitingUntil=0; this.releaseProps();
  }
}
