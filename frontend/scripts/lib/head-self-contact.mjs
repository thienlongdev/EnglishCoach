// Offline authored-surface audit. Explicitly resolves indirect BVH indices;
// excludes only zero-length touches. Does not certify volumes or dynamics.
import assert from 'node:assert/strict';
import * as T from 'three';
import {MeshBVH} from 'three-mesh-bvh';
import {fibreTopology} from './flexible-head-surface.mjs';

export function headSelfContact(source) {
  const geometry=source.clone(),top=fibreTopology(geometry),bySource=new Map();
  top.fibres.forEach((f,i)=>f.triangles.forEach(t=>bySource.set([...t.source].sort((a,b)=>a-b).join(','),{fibre:i,s:t.s.map(s=>s/f.length)})));
  const ix=geometry.index,triangles=[];
  for(let i=0;i<ix.count;i+=3){const key=[ix.getX(i),ix.getX(i+1),ix.getX(i+2)].sort((a,b)=>a-b).join(',');assert.ok(bySource.has(key));triangles.push(bySource.get(key));}
  const bvh=new MeshBVH(geometry,{indirect:true}),pairs=new Set(),away=new Set(),edge=new T.Line3();
  let hits=0,candidates=0,awayHits=0;const begin=performance.now();
  bvh.bvhcast(bvh,new T.Matrix4(),{intersectsTriangles:(a,b,rawI,rawJ)=>{
    const i=bvh.resolveTriangleIndex(rawI),j=bvh.resolveTriangleIndex(rawJ),fa=triangles[i],fb=triangles[j];
    if(i>=j||fa.fibre===fb.fibre)return false;candidates++;
    if(!a.intersectsTriangle(b,edge,true)||edge.distanceSq()<=1e-14)return false;
    hits++;const pair=[fa.fibre,fb.fibre].sort((a,b)=>a-b).join(',');pairs.add(pair);
    const mid=edge.getCenter(new T.Vector3());
    const material=(t,r)=>{const w=t.getBarycoord(mid,new T.Vector3());return w.x*r.s[0]+w.y*r.s[1]+w.z*r.s[2];};
    if(material(a,fa)>.25&&material(b,fb)>.25){awayHits++;away.add(pair);}
    return false;
  }});
  geometry.dispose();
  return {fibres:top.fibres.length,candidates,crossingTrianglePairs:hits,crossingFibrePairs:pairs.size,awayFromRootTrianglePairs:awayHits,awayFromRootFibrePairs:away.size,ms:performance.now()-begin};
}
