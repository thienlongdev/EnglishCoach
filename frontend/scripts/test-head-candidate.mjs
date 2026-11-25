import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import * as T from 'three';
import {loadCastGeometry} from './lib/load-cast.mjs';
import {headSelfContact} from './lib/head-self-contact.mjs';
import {convexVolume,separation,headVolumeClearance} from './lib/head-volume-clearance.mjs';
import {fibreTopology,headSurface} from './lib/flexible-head-surface.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),run=process.env.RUN;assert.match(run??'',/^[a-z0-9_-]+$/i);
const out=resolve(root,'docs/study-space/echo-life-6-20261108',run),report=JSON.parse(await readFile(resolve(out,'report.json'),'utf8'));
const candidate=resolve(out,report.candidate),source=resolve(root,report.source),hash=b=>createHash('sha256').update(b).digest('hex');
const before=await readFile(candidate);assert.equal(hash(before),report.candidateHash);
let checks=0;const ok=(x,msg)=>{checks++;assert.ok(x,msg);};
const parse=bytes=>{const n=bytes.readUInt32LE(12);return {doc:JSON.parse(bytes.subarray(20,20+n)),bin:bytes.subarray(28+n)};};
const originalBytes=await readFile(source),original=parse(originalBytes),exported=parse(before),authorized=new Set();
for(const r of report.reports){const parent=original.doc.nodes.find(n=>n.name===r.kind);assert.ok(parent);for(const i of parent.children??[]){const n=original.doc.nodes[i];if(/^(Bristles|Strands)(\.\d+)?$/.test(n.name))authorized.add(n.mesh);}}
ok(authorized.size===report.reports.length,'only named flexible heads authorized');
for(let i=0;i<original.doc.meshes.length;i++){
  const expected=structuredClone(original.doc.meshes[i]),actual=structuredClone(exported.doc.meshes[i]);
  if(authorized.has(i))for(let p=0;p<expected.primitives.length;p++)for(const a of ['POSITION','NORMAL'])actual.primitives[p].attributes[a]=expected.primitives[p].attributes[a];
  assert.deepEqual(actual,expected,'all unrelated mesh attributes/indices/materials retained');checks++;
}
for(const key of Object.keys(original.doc).filter(k=>!['meshes','buffers','accessors','bufferViews'].includes(k))){assert.deepEqual(exported.doc[key],original.doc[key],key+' unchanged');checks++;}
ok(exported.bin.subarray(0,original.bin.length).equals(original.bin),'entire original binary prefix unchanged');
assert.deepEqual(exported.doc.accessors.slice(0,original.doc.accessors.length),original.doc.accessors);checks++;
assert.deepEqual(exported.doc.bufferViews.slice(0,original.doc.bufferViews.length),original.doc.bufferViews);checks++;
const box=(half,offset=new T.Vector3(),q=new T.Quaternion())=>convexVolume([-1,1].flatMap(x=>[-1,1].flatMap(y=>[-1,1].map(z=>new T.Vector3(x,y,z).multiplyScalar(half).applyQuaternion(q).add(offset)))));
const unit=box(1);
ok(Math.abs(separation(unit,box(1,new T.Vector3(2.001,0,0)))-.001)<1e-10,'known disjoint gap');
ok(separation(unit,box(1,new T.Vector3(1.999,0,0)))<0,'crossing volumes rejected');
ok(separation(unit,box(.2))<0,'fully contained volume rejected');
ok(Math.abs(separation(unit,box(1,new T.Vector3(2,0,0))))<1e-10,'touching volume is not positive clearance');
const spin=new T.Quaternion().setFromEuler(new T.Euler(.61,-1.18,.42));
const transformed=v=>convexVolume(v.points.map(p=>p.clone().applyQuaternion(spin).add(new T.Vector3(3,-4,7))));
ok(Math.abs(separation(transformed(unit),transformed(box(1,new T.Vector3(2.001,0,0))))-.001)<1e-9,'arbitrary rigid covariance');
const a=await loadCastGeometry(source),b=await loadCastGeometry(candidate),results=[];
const get=(g,kind)=>{let head;g.scene.traverse(o=>{if((o.userData.name??o.name)===kind)o.traverse(m=>{if(m.isMesh&&/^(Bristles|Strands)(\.\d+)?$/.test(m.userData.name??m.name))head=m;});});assert.ok(head);return head;};
for(const {kind} of report.reports){
  const old=get(a,kind),head=get(b,kind),geo=head.geometry,top=fibreTopology(geo),surface=headSurface(geo);
  ok(top.fibres.length===({'tool.broom':420,'tool.mop':84,'tool.webbrush':300})[kind],kind+' count retained');
  ok(Buffer.from(geo.attributes.uv.array.buffer).equals(Buffer.from(old.geometry.attributes.uv.array.buffer)),kind+' UVs retained');
  ok(Buffer.from(geo.index.array.buffer).equals(Buffer.from(old.geometry.index.array.buffer)),kind+' indices retained');
  ok(head.matrix.equals(old.matrix),kind+' local origin retained');
  const crossings=headSelfContact(geo),volume=headVolumeClearance(geo);results.push({kind,crossings,volume,visibleSurfaceVertices:surface.geometry.attributes.position.count});
  ok(crossings.crossingFibrePairs===0,kind+' no crossing original triangles');
  // Record all numerical evidence before deciding whether this candidate passes.
  surface.dispose();
}
const pass=results.every(r=>r.volume.failedCount===0);
const files=['frontend/scripts/test-head-candidate.mjs','frontend/scripts/lib/head-volume-clearance.mjs','frontend/scripts/lib/head-self-contact.mjs','frontend/scripts/lib/flexible-head-surface.mjs'];
const sourceHashes=Object.fromEntries(await Promise.all(files.map(async p=>[p,hash(await readFile(resolve(root,p)))])));
const result={checks,pass,candidateHash:hash(before),sourceHashes,results,sourceUnchanged:hash(await readFile(source))===report.sourceHash,candidateUnchanged:hash(await readFile(candidate))===hash(before),scope:'Offline geometry only. Runtime support, rods, retention, all-tool gameplay and final QA remain open.'};
await writeFile(resolve(out,'validation.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));assert.ok(pass,'conservative volume clearance gate');
