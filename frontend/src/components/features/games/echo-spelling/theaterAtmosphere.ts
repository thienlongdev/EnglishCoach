import * as T from 'three';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** A few bounded ocean layers on the existing renderer: soft light volumes, caustics and sculpted jellyfish. */
export function theaterAtmosphere(scene:T.Scene){
  const objects:T.Object3D[]=[],materials:T.Material[]=[],geometries:T.BufferGeometry[]=[];
  const add=(o:T.Object3D)=>{scene.add(o);objects.push(o);return o;};
  const shaftMat=new T.ShaderMaterial({transparent:true,depthWrite:false,side:T.DoubleSide,blending:T.AdditiveBlending,
    uniforms:{t:{value:0}},vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:'varying vec2 vUv;uniform float t;void main(){float edge=pow(max(0.,sin(vUv.x*3.14159)),3.);float end=smoothstep(0.,.3,vUv.y)*(1.-smoothstep(.7,1.,vUv.y));float breathe=.85+.15*sin(t*.4+vUv.y*3.);gl_FragColor=vec4(.34,.65,.9,edge*end*.075*breathe);}'});
  materials.push(shaftMat);const shaftGeo=new T.PlaneGeometry(5,25);geometries.push(shaftGeo);
  for(let i=0;i<4;i++){const ray=new T.Mesh(shaftGeo,shaftMat);ray.position.set(-12+i*7,8,-8-i*.7);ray.rotation.z=-.24;add(ray);}
  const caustic=new T.ShaderMaterial({transparent:true,depthWrite:false,blending:T.AdditiveBlending,uniforms:{t:{value:0}},
    vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:`varying vec2 vUv;uniform float t;void main(){vec2 p=(vUv-.5)*26.;float a=sin(p.x*.75+t*.18+sin(p.y*.8))*.6+sin(p.y*.93-t*.13)*.5;float b=sin(p.x*.51-p.y*.6-t*.1);float light=pow(max(0.,1.-abs(a+b)),12.);float edge=1.-smoothstep(.35,.5,length(vUv-.5));gl_FragColor=vec4(.17,.57,.65,light*edge*.13);}`});
  const floorGeo=new T.PlaneGeometry(28,28);geometries.push(floorGeo);materials.push(caustic);const floor=new T.Mesh(floorGeo,caustic);floor.rotation.x=-Math.PI/2;floor.position.y=.03;add(floor);
  const bellMat=new T.MeshPhysicalMaterial({color:'#9889e6',emissive:'#483d94',emissiveIntensity:.6,metalness:.15,roughness:.27,clearcoat:1,transparent:true,opacity:.5,side:T.DoubleSide,depthWrite:false});
  const tendrilMat=new T.MeshBasicMaterial({color:'#91e1ee',transparent:true,opacity:.45,depthWrite:false});materials.push(bellMat,tendrilMat);
  const profile=[new T.Vector2(.01,.45),new T.Vector2(.25,.4),new T.Vector2(.46,.22),new T.Vector2(.53,0),new T.Vector2(.48,-.1),new T.Vector2(.42,-.03),new T.Vector2(.27,.15),new T.Vector2(.01,.2)];
  const bellGeo=new T.LatheGeometry(profile,24);geometries.push(bellGeo);
  const pieces:T.BufferGeometry[]=[];
  for(let i=0;i<7;i++){const a=i*Math.PI*2/7;const curve=new T.CatmullRomCurve3([new T.Vector3(Math.cos(a)*.36,-.08,Math.sin(a)*.36),new T.Vector3(Math.cos(a)*.25,-.5,Math.sin(a)*.25),new T.Vector3(Math.cos(a+.4)*.4,-1.1,Math.sin(a+.4)*.4),new T.Vector3(Math.cos(a-.3)*.23,-1.7,Math.sin(a-.3)*.23)]);pieces.push(new T.TubeGeometry(curve,10,.013,4,false));}
  const tails=mergeGeometries(pieces);pieces.forEach(g=>g.dispose());geometries.push(tails);
  const jellies:T.Group[]=[];
  for(let i=0;i<4;i++){const group=new T.Group();group.add(new T.Mesh(bellGeo,bellMat),new T.Mesh(tails,tendrilMat));group.position.set((i%2?1:-1)*(10+i),6+i%3*1.6,-5-i*2.5);group.scale.setScalar(.75+i*.12);add(group);jellies.push(group);}
  const recordMat=new T.MeshBasicMaterial({color:'#f6d59a',transparent:true,opacity:0,side:T.DoubleSide,depthWrite:false,blending:T.AdditiveBlending});const recordGeo=new T.RingGeometry(.8,.86,96);materials.push(recordMat);geometries.push(recordGeo);const recordRing=new T.Mesh(recordGeo,recordMat);recordRing.rotation.x=-Math.PI/2;recordRing.position.set(0,.06,-2.8);add(recordRing);
  let recordAt=-100;
  return {record:(t:number)=>{recordAt=t;},update:(t:number,reduced:boolean)=>{shaftMat.uniforms.t.value=reduced?0:t;caustic.uniforms.t.value=reduced?0:t;for(let i=0;i<jellies.length;i++){jellies[i].position.y=6+i%3*1.6+(reduced?0:Math.sin(t*.45+i)*.32);jellies[i].rotation.y=reduced?0:Math.sin(t*.2+i)*.35;}
    const age=t-recordAt;recordRing.visible=age<6;recordRing.scale.setScalar(1+Math.max(0,age)*1.2);recordMat.opacity=age<6?Math.max(0,.85-age/7):0;},
    dispose:()=>{objects.forEach(o=>scene.remove(o));materials.forEach(m=>m.dispose());geometries.forEach(g=>g.dispose());}};
}
