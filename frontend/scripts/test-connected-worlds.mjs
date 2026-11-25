import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),babel=require('next/dist/compiled/babel/bundle.js');
const src=fileURLToPath(new URL('../src/',import.meta.url)),cache=new Map();
function load(rel){if(cache.has(rel))return cache.get(rel);const m={exports:{}};cache.set(rel,m.exports);const code=babel.core().transformSync(fs.readFileSync(path.join(src,rel),'utf8'),{filename:rel,babelrc:false,configFile:false,presets:[babel.presetTypescript()],plugins:[babel.pluginTransformModulesCommonjs()]}).code;new Function('module','exports','require',code)(m,m.exports,n=>load(n.startsWith('@/')?n.slice(2)+'.ts':path.posix.normalize(path.posix.dirname(rel)+'/'+n)+'.ts'));return m.exports;}

const {RoomNavigation}=load('lib/study-space/navigation.ts');
const {walkSlide,worldDestination,studyReturn}=load('lib/study-space/exploration.ts');
let checks=0;
for(const rotation of [0,Math.PI/6,Math.PI/2])for(const step of [.016,.05,.5,2]){
 const nav=new RoomNavigation(6,[{x:0,z:0,width:2.5,depth:.025,rotation}]);let p={x:0,z:2.5};
 for(let i=0;i<150;i++){p=walkSlide(nav,p,0,-step);assert.ok(nav.free(p),'Swept motion cannot tunnel into thin rotated obstacles');}
 checks++;
}
const nav=new RoomNavigation(6,[]);let p={x:0,z:0};for(let i=0;i<60;i++)p=walkSlide(nav,p,.08,.08);assert.ok(nav.free(p));assert.ok(p.x>2.7&&p.z>2.7);checks++;
assert.equal(worldDestination('arena','room-1'),'/speaking/arena?studyRoom=room-1');assert.equal(worldDestination('games','room-1'),'/games?studyRoom=room-1');checks+=2;
for(const id of ['', '../private', 'https://bad.example', 'a&x=1', 'a'.repeat(65)])assert.equal(studyReturn(new URLSearchParams({studyRoom:id})),null);
assert.equal(studyReturn(new URLSearchParams({studyRoom:'room-1'})),'/study-space?space=room-1');checks+=6;
const bytes=fs.readFileSync(new URL('../public/assets/study-space/connected-door-8388ba11dbcc.glb',import.meta.url));assert.equal(bytes.readUInt32LE(0),0x46546c67);const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());assert.ok(gltf.nodes.some(n=>n.name==='Frame'));assert.ok(gltf.nodes.some(n=>n.name==='Leaf'));assert.ok(gltf.meshes.length<=8);assert.ok(bytes.length<300000);checks++;
console.log(`PASS ${checks} Connected Worlds collision, deep-link and authored asset checks`);
