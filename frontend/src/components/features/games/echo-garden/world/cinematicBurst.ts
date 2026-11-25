import { Geometry, GlProgram, Mesh, Shader, UniformGroup } from 'pixi.js';
import { VFX_BUDGET, VfxQuality, vfxReduced } from '@/lib/vfx/quality';

/** One GPU mesh in the existing Pixi scene, immutable quad seeds, no per-particle JS loop. */
export class GardenCinematicBurst {
 readonly mesh: Mesh<Geometry,Shader>;
 private uniforms=new UniformGroup({uAge:{value:5,type:'f32'},uExtent:{value:240,type:'f32'},uBudget:{value:1,type:'f32'}});
 private started=-Infinity;
 private last=0;private quality=new VfxQuality();
 private geometry: Geometry;
 private shader: Shader;
 private disposed=false;
 constructor(){
  const n=VFX_BUDGET.ultra.particles;
  const positions=new Float32Array(n*8),uvs=new Float32Array(n*8),seeds=new Float32Array(n*4),indices=new Uint32Array(n*6);
  for(let i=0;i<n;i++){positions.set([-1,-1,1,-1,1,1,-1,1],i*8);uvs.set([0,0,1,0,1,1,0,1],i*8);seeds.fill((i+.5)/n,i*4,i*4+4);indices.set([i*4,i*4+1,i*4+2,i*4,i*4+2,i*4+3],i*6);}
  const geometry=new Geometry({attributes:{aPosition:{buffer:positions,format:'float32x2'},aUV:{buffer:uvs,format:'float32x2'},aSeed:{buffer:seeds,format:'float32'}},indexBuffer:indices});
  const glProgram=GlProgram.from({name:'echo-garden-cinematic',vertex:`
precision highp float;in vec2 aPosition,aUV;in float aSeed;out vec2 vUv;out float vLife,vHue;
uniform mat3 uProjectionMatrix,uWorldTransformMatrix,uTransformMatrix;uniform float uAge,uExtent,uBudget;
void main(){float t=uAge-fract(aSeed*11.)*.18;float a=aSeed*333.+t*.8;float gather=1.-smoothstep(0.,.95,t),release=smoothstep(.8,1.65,t);float r=(.45+fract(aSeed*31.7)*.55)*(gather+release*(.5+max(0.,t-1.6)*.22));
vec2 p=vec2(cos(a)*r,sin(a)*r*.38-release*(.1+fract(aSeed*23.1)*.65)-max(0.,t-1.8)*.12)*uExtent+aPosition*(1.8+fract(aSeed*13.)*2.8);
gl_Position=vec4((uProjectionMatrix*uWorldTransformMatrix*uTransformMatrix*vec3(p,1.)).xy,0.,1.);vUv=aUV;vHue=fract(aSeed*13.);vLife=step(aSeed,uBudget)*smoothstep(0.,.2,t)*(1.-smoothstep(2.1,3.8,t));}`,
fragment:`precision highp float;in vec2 vUv;in float vLife,vHue;out vec4 finalColor;uniform vec4 uColor;void main(){float r=length(vUv-.5);if(r>.5)discard;float a=(exp(-r*r*20.)*.5+pow(max(0.,1.-r*2.),4.))*vLife*.75;vec3 c=mix(vec3(.4,1.,.85),vec3(1.,.78,.32),smoothstep(.65,.95,vHue));finalColor=vec4(c*a,a)*uColor;}`});
  const shader=new Shader({glProgram,resources:{burstUniforms:this.uniforms}});this.geometry=geometry;this.shader=shader;this.mesh=new Mesh({geometry,shader});this.mesh.blendMode='add';this.mesh.eventMode='none';this.mesh.visible=false;
 }
 start(now:number,x:number,y:number,extent:number){this.started=now;this.mesh.position.set(x,y);this.uniforms.uniforms.uExtent=extent;this.uniforms.uniforms.uAge=0;this.mesh.visible=true;}
 update(now:number,reduced:boolean){const age=now-this.started;this.uniforms.uniforms.uAge=age;this.uniforms.uniforms.uBudget=VFX_BUDGET[this.quality.update(this.last?now-this.last:0)].particles/VFX_BUDGET.ultra.particles;this.last=now;this.mesh.visible=!reduced&&!vfxReduced()&&age>=0&&age<4;}
 destroy(){if(this.disposed)return;this.disposed=true;if(!this.mesh.destroyed)this.mesh.destroy();this.geometry.destroy();this.shader.destroy(true);}
}
