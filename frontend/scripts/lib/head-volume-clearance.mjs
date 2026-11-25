// Offline conservative volume gate: each pair of adjacent authored rings is
// enclosed by its convex hull. Separating every pair of foreign fibre hulls
// proves more than a crossing-surface count (which misses contained volumes).
import * as T from 'three';
import {ConvexHull} from 'three/examples/jsm/math/ConvexHull.js';
import {fibreTopology} from './flexible-head-surface.mjs';

export function convexVolume(points) {
  const hull=new ConvexHull().setFromPoints(points),axes=[],edges=[];
  const add=(list,v)=>{if(v.lengthSq()<1e-20)return;v.normalize();if(!list.some(n=>Math.abs(n.dot(v))>1-1e-10))list.push(v);};
  for(const face of hull.faces){add(axes,face.normal.clone());let e=face.edge;do{add(edges,e.head().point.clone().sub(e.tail().point));e=e.next;}while(e!==face.edge);}
  return {points,axes,edges,box:new T.Box3().setFromPoints(points)};
}

export function separation(a,b,earlyExit=Infinity) {
  let gap=-Infinity;
  const project=axis=>{
    if(axis.lengthSq()<1e-20)return;
    axis.normalize();let a0=Infinity,a1=-Infinity,b0=Infinity,b1=-Infinity;
    for(const p of a.points){const d=p.dot(axis);a0=Math.min(a0,d);a1=Math.max(a1,d);}
    for(const p of b.points){const d=p.dot(axis);b0=Math.min(b0,d);b1=Math.max(b1,d);}
    gap=Math.max(gap,b0-a1,a0-b1);
  };
  for(const axis of [...a.axes,...b.axes]){project(axis.clone());if(gap>earlyExit)return gap;}
  for(const x of a.edges)for(const y of b.edges){project(new T.Vector3().crossVectors(x,y));if(gap>earlyExit)return gap;}
  return gap;
}

export function headVolumeClearance(geometry,clearance=1e-5) {
  const top=fibreTopology(geometry),segments=[];
  top.fibres.forEach((f,fibre)=>{for(let i=0;i<f.rings.length-1;i++)segments.push({...convexVolume([...f.rings[i],...f.rings[i+1]].map(id=>top.points[id])),fibre,segment:i});});
  let checked=0,boxesSeparated=0,minimumCertifiedGap=Infinity;const failed=[],start=performance.now();
  for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++){
    const a=segments[i],b=segments[j];if(a.fibre===b.fibre&&Math.abs(a.segment-b.segment)<=1)continue;
    // Adjacent pieces share their material ring by construction. All other
    // self pairs and every inter-fibre pair must be separated.
    const boxGap=Math.max(...['x','y','z'].flatMap(k=>[b.box.min[k]-a.box.max[k],a.box.min[k]-b.box.max[k]]));
    if(boxGap>clearance){boxesSeparated++;minimumCertifiedGap=Math.min(minimumCertifiedGap,boxGap);continue;}
    checked++;const gap=separation(a,b,clearance);minimumCertifiedGap=Math.min(minimumCertifiedGap,gap);
    if(gap<=clearance)failed.push({a:[a.fibre,a.segment],b:[b.fibre,b.segment],gap});
  }
  return {fibres:top.fibres.length,segments:segments.length,clearance,checked,boxesSeparated,minimumCertifiedGap,failedCount:failed.length,failed:failed.slice(0,12),ms:performance.now()-start,scope:'Conservative convex envelopes of adjacent authored rings. Shared adjacent material rings excluded; no dynamic contact or rigid attachment acceptance.'};
}
