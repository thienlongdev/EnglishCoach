import * as T from 'three';
import { VFX_BUDGET, type VfxTier } from './quality';
import type { AudioBands } from './audio';

const vertex = `varying vec2 vUv; varying vec3 vWorld; void main(){vUv=uv;vWorld=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const fragment = `
uniform float uTime,uEnergy,uLive,uCaptured,uReduced; uniform vec3 uTint; uniform vec2 uResolution;
uniform sampler2D uField,uScene; varying vec2 vUv; varying vec3 vWorld;
float wave(vec2 p){return sin(p.x*15.+sin(p.y*12.+uTime*.7)*1.5+uTime*.65)*.5+sin(p.y*21.-p.x*9.-uTime*.8)*.25;}
void main(){
 vec2 p=(vUv-.5)*vec2(1.,2.35); float r=length(p); float a=atan(p.y,p.x);
 vec2 flow=vec2(sin(a*3.+r*7.-uTime*.55),cos(a*2.-r*9.+uTime*.4));
 vec2 q=p+flow*.055; float f=wave(q);
 vec2 grad=vec2(wave(q+vec2(.012,0.))-f,wave(q+vec2(0.,.012))-f)*.55;
 vec2 d=vec2(.007,0.); grad+=vec2(texture2D(uField,vUv+d).r-texture2D(uField,vUv-d).r,texture2D(uField,vUv+d.yx).r-texture2D(uField,vUv-d.yx).r)*uLive*2.;
 grad*=1.-uReduced*.8;
 vec2 screen=gl_FragCoord.xy/uResolution;
 vec3 refracted=vec3(texture2D(uScene,clamp(screen+grad*.16,.001,.999)).r,texture2D(uScene,clamp(screen+grad*.14,.001,.999)).g,texture2D(uScene,clamp(screen+grad*.12,.001,.999)).b);
 float border=min(min(vUv.x,1.-vUv.x),min(vUv.y,1.-vUv.y));
 float rim=exp(-border*65.); float caustic=pow(.5+.5*sin(f*5.+r*19.-uTime*.4),14.);
 float spiral=pow(.5+.5*sin(a*3.+r*17.-uTime*.7+f*.7),18.)*exp(-r*1.3);
 vec3 depth=mix(vec3(.006,.018,.05),uTint*.16,exp(-r*2.));
 depth+=uTint*(caustic*.24+spiral*.55+rim*.9)*( .72+uEnergy*.22 );
 vec3 color=mix(depth,depth+refracted*.45,uCaptured*.65);
 color+=vec3(.63,.86,1.)*pow(max(0.,dot(normalize(vec3(-grad*7.,1.)),normalize(vec3(-.5,.8,.35)))),40.)*.35;
 gl_FragColor=vec4(color,1.);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`;

/** A bounded shallow-water wavefield in the scene's WebGL context; no second renderer. */
class WaveField {
  private targets: [T.WebGLRenderTarget, T.WebGLRenderTarget];
  private scene = new T.Scene(); private camera = new T.Camera(); private quad: T.Mesh<T.PlaneGeometry,T.ShaderMaterial>;
  private elapsed = 0; private initial = true;
  constructor(readonly size: number) {
    const make = () => new T.WebGLRenderTarget(size,size,{type:T.HalfFloatType,format:T.RGBAFormat,minFilter:T.LinearFilter,magFilter:T.LinearFilter,depthBuffer:false,stencilBuffer:false});
    this.targets=[make(),make()];
    const material=new T.ShaderMaterial({depthTest:false,depthWrite:false,uniforms:{field:{value:this.targets[0].texture},texel:{value:1/size},pulse:{value:new T.Vector3(.5,.45,0)}},vertexShader:'varying vec2 v;void main(){v=uv;gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:`varying vec2 v;uniform sampler2D field;uniform float texel;uniform vec3 pulse;void main(){vec2 s=texture2D(field,v).rg;vec2 d=vec2(texel,0.);float lap=texture2D(field,v+d).r+texture2D(field,v-d).r+texture2D(field,v+d.yx).r+texture2D(field,v-d.yx).r-4.*s.r;float speed=(s.g+lap*.22)*.985;float h=s.r+speed;h+=exp(-dot(v-pulse.xy,v-pulse.xy)*950.)*pulse.z;float edge=smoothstep(0.,.045,min(min(v.x,1.-v.x),min(v.y,1.-v.y)));gl_FragColor=vec4(clamp(h*edge,-1.,1.),speed*edge,0.,1.);}`});
    this.quad=new T.Mesh(new T.PlaneGeometry(2,2),material);this.scene.add(this.quad);
  }
  pulse(x=.5,y=.45,strength=.18){this.quad.material.uniforms.pulse.value.set(x,y,strength);}
  update(renderer:T.WebGLRenderer,dt:number){
    const old=renderer.getRenderTarget(),clear=renderer.getClearColor(new T.Color()),alpha=renderer.getClearAlpha();
    try{
      if(this.initial){renderer.setClearColor(0,0);for(const target of this.targets){renderer.setRenderTarget(target);renderer.clear();}this.initial=false;}
      this.elapsed=Math.min(.05,this.elapsed+dt);
      while(this.elapsed>=1/60){this.elapsed-=1/60;this.quad.material.uniforms.field.value=this.targets[0].texture;renderer.setRenderTarget(this.targets[1]);renderer.render(this.scene,this.camera);this.targets.reverse();this.quad.material.uniforms.pulse.value.z=0;}
    }finally{renderer.setRenderTarget(old);renderer.setClearColor(clear,alpha);}
    return this.targets[0].texture;
  }
  dispose(){this.targets.forEach(t=>t.dispose());this.quad.geometry.dispose();this.quad.material.dispose();}
}

function hasAllVisibleShadowMaps(scene: T.Scene, renderer: T.WebGLRenderer): boolean {
  if (!renderer.shadowMap.enabled) return true;
  let ready = true;
  scene.traverseVisible((obj) => {
    if (!ready) return;
    const light = obj as T.Light;
    if (!light.isLight || !light.castShadow) return;
    const shadow = (light as T.DirectionalLight).shadow;
    if (!shadow || !shadow.map) ready = false;
  });
  return ready;
}

export class LiquidPortal {
  readonly group=new T.Group();
  /** Visual portal meshes separated from `light` so `PortalCapture` hides only visuals and NEVER hides `PointLight`! */
  readonly visualGroup=new T.Group();
  readonly material:T.ShaderMaterial;
  readonly light:T.PointLight;
  private wave:WaveField|null=null; private clock=0; private previousNear=false;
  private pendingPulse: T.Vector2 | null = null;
  private dummy=new T.DataTexture(new Uint8Array([0,0,0,255]),1,1);
  private glass:T.MeshPhysicalMaterial;
  constructor(kind:'arena'|'games'){
    this.dummy.needsUpdate=true;
    const tint=new T.Color(kind==='arena'?'#58e5dc':'#b49fff');
    this.material=new T.ShaderMaterial({side:T.DoubleSide,uniforms:{uTime:{value:0},uEnergy:{value:0},uLive:{value:0},uCaptured:{value:0},uReduced:{value:0},uTint:{value:tint},uResolution:{value:new T.Vector2(1,1)},uField:{value:this.dummy},uScene:{value:this.dummy}},vertexShader:vertex,fragmentShader:fragment});
    const surface=new T.Mesh(new T.PlaneGeometry(.94,2.25),this.material);surface.position.set(0,1.155,.075);surface.userData.liquidRipple=(uv:T.Vector2)=>this.pulse(uv);this.visualGroup.add(surface);
    // Lock `transmission: 0` permanently (physical Fresnel clearcoat glass -> zero `USE_TRANSMISSION` recompiles).
    this.glass=new T.MeshPhysicalMaterial({color:'#d8f9ff',roughness:.08,metalness:0,transmission:0,transparent:true,opacity:.72,depthWrite:false,ior:1.45,clearcoat:1,clearcoatRoughness:.05,envMapIntensity:1.5});
    for(const side of [-1,1]){const bar=new T.Mesh(new T.BoxGeometry(.035,2.28,.075),this.glass);bar.position.set(side*.48,1.155,.035);this.visualGroup.add(bar);}
    this.group.add(this.visualGroup);
    // Keep portal PointLight permanently `visible = true` (toggle via `intensity = 0` when inactive so NUM_POINT_LIGHTS never mutates!).
    this.light=new T.PointLight(tint,0,2.1,2);this.light.position.set(0,1.2,-.2);this.light.visible=true;this.group.add(this.light);
    this.group.name=`liquid-portal-${kind}`;this.group.userData.portal=kind;
  }
  update(dt:number,near:boolean,reduced:boolean,audio:Readonly<AudioBands>){
    if(!reduced)this.clock+=Math.min(dt,.05)*(1+audio.mid*.07);
    if(near&&!this.previousNear)this.pulse(new T.Vector2(.5,.45));this.previousNear=near;
    this.material.uniforms.uTime.value=this.clock;
    this.material.uniforms.uReduced.value=Number(reduced);
    this.material.uniforms.uEnergy.value=reduced?0:(near?.8:.2)+audio.bass*.25+audio.treble*.08;
    this.light.visible=true;
    this.light.intensity=reduced?.1:.12+(near?.08:0)+audio.bass*.035;
  }
  pulse(uv:T.Vector2){this.pendingPulse=uv.clone();}
  /** Keeps portal `PointLight` permanently `visible = true` while silencing illumination (`intensity = 0`) -> zero shader recompiles. */
  setLightActive(active:boolean){this.light.visible=true;if(!active)this.light.intensity=0;}
  suspend(){
    this.wave?.dispose();this.wave=null;this.material.uniforms.uLive.value=0;this.material.uniforms.uField.value=this.dummy;
    this.setLightActive(false);
  }
  prepare(renderer:T.WebGLRenderer,dt:number,tier:VfxTier,reduced:boolean){
    const size=reduced?0:VFX_BUDGET[tier].fluid;
    const capable=renderer.extensions.has('EXT_color_buffer_float');
    if(this.wave?.size!==size){this.wave?.dispose();this.wave=null;if(size&&capable)this.wave=new WaveField(size);}
    if(this.pendingPulse&&this.wave){this.wave.pulse(this.pendingPulse.x,this.pendingPulse.y);this.pendingPulse=null;}
    this.material.uniforms.uLive.value=this.wave?1:0;
    this.material.uniforms.uField.value=this.wave?.update(renderer,dt)??this.dummy;
  }
  capture(texture:T.Texture|null,resolution:T.Vector2){this.material.uniforms.uScene.value=texture??this.dummy;this.material.uniforms.uCaptured.value=texture?1:0;this.material.uniforms.uResolution.value.copy(resolution);}
  dispose(){this.wave?.dispose();this.dummy.dispose();this.material.dispose();this.glass.dispose();this.group.traverse(o=>{if(o instanceof T.Mesh)o.geometry.dispose();});}
}

/** One shared refraction capture for both doors, only while the room is explored. */
export class PortalCapture {
  private target:T.WebGLRenderTarget|null=null;private resolution=new T.Vector2();
  render(renderer:T.WebGLRenderer,scene:T.Scene,camera:T.Camera,portals:LiquidPortal[],tier:VfxTier){
    renderer.getDrawingBufferSize(this.resolution);const scale=VFX_BUDGET[tier].refraction;
    if(!scale){this.target?.dispose();this.target=null;portals.forEach(p=>p.capture(null,this.resolution));return;}
    // Guard against first-frame / unallocated shadow maps (`emptyShadowTexture` -> WebGL2 GL_INVALID_OPERATION!).
    if(!hasAllVisibleShadowMaps(scene,renderer)){portals.forEach(p=>p.capture(null,this.resolution));return;}
    const w=Math.max(1,Math.round(this.resolution.x*scale)),h=Math.max(1,Math.round(this.resolution.y*scale));
    if(!this.target)this.target=new T.WebGLRenderTarget(w,h,{depthBuffer:true});
    if(this.target.width!==w||this.target.height!==h)this.target.setSize(w,h);
    const old=renderer.getRenderTarget(),visible=portals.map(p=>p.visualGroup.visible),shadow=renderer.shadowMap.autoUpdate,shadowNeeds=renderer.shadowMap.needsUpdate,tone=renderer.toneMapping;
    try{
      // Hide ONLY portal visual meshes — NEVER hide `p.light` (keeps NUM_POINT_LIGHTS 100% constant!).
      portals.forEach(p=>p.visualGroup.visible=false);
      renderer.shadowMap.autoUpdate=false;
      renderer.shadowMap.needsUpdate=false;
      renderer.toneMapping=T.NoToneMapping;
      renderer.setRenderTarget(this.target);
      renderer.render(scene,camera);
    }finally{
      renderer.setRenderTarget(old);
      renderer.toneMapping=tone;
      renderer.shadowMap.autoUpdate=shadow;
      renderer.shadowMap.needsUpdate=shadowNeeds;
      portals.forEach((p,i)=>p.visualGroup.visible=visible[i]);
    }
    portals.forEach(p=>p.capture(this.target!.texture,this.resolution));
  }
  dispose(){this.target?.dispose();this.target=null;}
}
