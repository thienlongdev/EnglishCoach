import type { V3State,V3OwnedObject } from '../game-core/index.mjs';
export function getObjectFootprint(o:V3OwnedObject):{width:number;depth:number};
export function orientedBounds(width:number,depth:number,yaw:number):{halfW:number;halfD:number};
export function validatePlacement(s:V3State,id:string,zone:string,x:number,z:number,yaw:number):{ok:boolean;reason?:string};
