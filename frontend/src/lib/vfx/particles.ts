import * as T from 'three';
import { VFX_BUDGET, type VfxTier } from './quality';

/** All trajectories execute in the vertex shader; immutable seeds upload only once. */
export const PARTICLE_PATH = `
vec3 flight(float seed,float age){
 float a=seed*6.2831853*53.;float radius=.45+fract(seed*31.7)*.55;
 float gather=1.-smoothstep(0.,.95,age);float release=smoothstep(.8,1.65,age);
 float spread=release*(.5+max(0.,age-1.6)*.22);
 float angle=a+age*(.35+fract(seed*7.2))*(1.-release*.7);
 float r=radius*(gather+spread);
 return vec3(cos(angle)*r,(fract(seed*17.3)-.5)*gather+release*(.1+fract(seed*23.1)*.65)+max(0.,age-1.8)*.12,sin(angle)*r);
}`;
export class CinematicBurst {
 readonly root=new T.Group();readonly material:T.ShaderMaterial;readonly geometry:T.BufferGeometry;
 private age=5;
 constructor(tier:VfxTier='high'){
  const n=VFX_BUDGET.ultra.particles, seeds=new Float32Array(n);
  for(let i=0;i<n;i++)seeds[i]=((i+.5)*.61803398875)%1;
  this.geometry=new T.BufferGeometry();this.geometry.setDrawRange(0,VFX_BUDGET[tier].particles);this.geometry.setAttribute('position',new T.BufferAttribute(new Float32Array(n*3),3));this.geometry.setAttribute('seed',new T.BufferAttribute(seeds,1));
  this.material=new T.ShaderMaterial({transparent:true,depthWrite:false,blending:T.AdditiveBlending,uniforms:{age:{value:5},pixelRatio:{value:1},tint:{value:new T.Color('#99ede0')}},vertexShader:`attribute float seed;uniform float age,pixelRatio;varying float life,hue;${PARTICLE_PATH}\nvoid main(){float t=age-fract(seed*11.)*.18;vec3 p=flight(seed,t);gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);life=smoothstep(0.,.2,t)*(1.-smoothstep(2.1,3.8,t));hue=fract(seed*13.);gl_PointSize=(2.+hue*3.5)*pixelRatio*(.7+life*.3);}`,fragmentShader:`uniform vec3 tint;varying float life,hue;void main(){vec2 p=gl_PointCoord-.5;float r=length(p);if(r>.5)discard;float light=exp(-r*r*20.)*.5+pow(max(0.,1.-r*2.),4.);vec3 color=mix(tint,vec3(1.,.79,.38),smoothstep(.65,.95,hue));gl_FragColor=vec4(color,light*life*.8);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`});
  const points=new T.Points(this.geometry,this.material);points.frustumCulled=false;this.root.add(points);this.root.visible=false;
 }
 start(position?:T.Vector3,scale=1){this.age=0;this.material.uniforms.age.value=0;if(position)this.root.position.copy(position);this.root.scale.setScalar(scale);this.root.visible=true;}
 update(dt:number,dpr=1,reduced=false){if(reduced){this.age=5;this.root.visible=false;return;}this.age+=Math.min(dt,.08);this.material.uniforms.age.value=this.age;this.material.uniforms.pixelRatio.value=Math.min(2,dpr);this.root.visible=this.age<4;}
 setTier(tier:VfxTier){this.geometry.setDrawRange(0,VFX_BUDGET[tier].particles);}
 get active(){return this.root.visible;}
 dispose(){this.root.removeFromParent();this.geometry.dispose();this.material.dispose();}
}
