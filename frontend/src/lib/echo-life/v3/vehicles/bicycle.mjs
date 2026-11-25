import {walkable} from '../game-physics/controller.mjs';
export function ride(s){
 const p=s.player,b=s.bike;
 if(p.riding){b.zone=p.zone;b.x=p.x;b.z=p.z;b.yaw=p.yaw;p.speed=0;p.riding=false;
  for(const side of [1,-1]){const x=p.x+side*.65*Math.cos(p.yaw),z=p.z-side*.65*Math.sin(p.yaw);
   if(walkable(p.zone,x,z)){p.x=x;p.z=z;break;}}
  return true;
 }
 if(s.held||b.zone!==p.zone||Math.hypot(p.x-b.x,p.z-b.z)>2.4)return false;
 p.riding=true;p.x=b.x;p.z=b.z;p.yaw=b.yaw;return true;
}

