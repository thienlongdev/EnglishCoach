import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const input = readFileSync(new URL('../src/lib/morph/spring.ts', import.meta.url), 'utf8');
const js = stripTypeScriptTypes(input, {mode:'transform'});
const {stepSpring,Spring} = await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
let next=0, frames=new Map();
globalThis.requestAnimationFrame=fn=>{frames.set(++next,fn);return next;};
globalThis.cancelAnimationFrame=id=>frames.delete(id);
for(const damping of [16,36,52]){
 const spec={stiffness:324,damping,mass:1,precision:.001};
 const start={position:317,velocity:-28};
 const one=stepSpring(start,20,.6,spec);
 let small=start;for(let i=0;i<144;i++)small=stepSpring(small,20,.6/144,spec);
 assert.ok(Math.abs(one.position-small.position)<1e-8,'refresh rate independent position');
 assert.ok(Math.abs(one.velocity-small.velocity)<1e-8,'refresh rate independent velocity');
 const settled=stepSpring(start,20,20,spec);assert.ok(Math.abs(settled.position-20)<.001);
}
const painted=[];const spring=new Spring([350,1],{stiffness:330,damping:36,mass:1,precision:.001},x=>painted.push(x));
spring.set([120,.7],[840,.5]);spring.retarget([500,1]);
const before=structuredClone(spring.state);spring.retarget([0,.2]);
assert.deepEqual(spring.state,before,'reversal retains measured position AND velocity');
assert.equal(frames.size,1,'one frame owner even after repeated retargets');
spring.stop();assert.equal(frames.size,0,'cancellation releases RAF');
console.log('Morph physics: timestep equivalence, three damping regimes, velocity-preserving reversal, one scheduler, cleanup PASS');
