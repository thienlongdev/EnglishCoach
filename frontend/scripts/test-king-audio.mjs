import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(import.meta.url),babel=require('next/dist/compiled/babel/bundle.js');
let contexts=[];
class Context {
  state='running';currentTime=0;destination={};nodes=[];closed=false;
  constructor(){contexts.push(this);}
  resume(){return Promise.resolve();}
  close(){this.closed=true;return Promise.resolve();}
  createOscillator(){const n={frequency:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){n.disconnected=true;},start(){},stop(){},onended:null};this.nodes.push(n);return n;}
  createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
}
const exports={};
const code=babel.core().transformSync(readFileSync(new URL('../src/components/features/games/king-of-english/kingAudio.ts',import.meta.url),'utf8'),{filename:'kingAudio.ts',configFile:false,babelrc:false,presets:[babel.presetTypescript()],plugins:[babel.pluginTransformModulesCommonjs()]}).code;
runInNewContext(code,{exports,window:{},AudioContext:Context});
const audio=new exports.KingAudio();
audio.play('win');assert.equal(contexts.length,0);console.log('PASS default muted, no audio allocation before gesture');
audio.enable(true);const ctx=contexts[0];
for(let n=0;n<20;n++)audio.play('correct');assert.equal(ctx.nodes.length,1);console.log('PASS same-time events throttled');
for(let n=0;n<20;n++){ctx.currentTime+=.1;audio.play('place');}assert.equal(ctx.nodes.length,4);console.log('PASS four live voices maximum');
ctx.nodes[0].onended();ctx.currentTime+=.1;audio.play('wrong');assert.equal(ctx.nodes.length,5);console.log('PASS completed voices release capacity');
audio.enable(false);assert(ctx.nodes.every(n=>n.disconnected));ctx.currentTime+=1;audio.play('win');assert.equal(ctx.nodes.length,5);console.log('PASS mute clears nodes immediately and blocks sound');
audio.enable(true);ctx.currentTime+=1;audio.play('win');audio.close();assert(ctx.closed);assert(ctx.nodes.every(n=>n.disconnected));audio.close();console.log('PASS repeated close disposes context and nodes');
console.log('King audio: 6 behavioral groups passed; actual browser sound/hearing is separate.');
