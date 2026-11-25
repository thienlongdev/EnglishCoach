import * as T from 'three';
import type {GLTF,GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Original modelled fish, five shared instance draws. Head remains steady while body and forked tail swim. */
export function marineSchool(scene:T.Scene,loader:GLTFLoader){
  const count=36,meshes:T.InstancedMesh[]=[],time={value:0};let disposed=false;
  const dummy=new T.Object3D(),forward=new T.Vector3(1,0,0),direction=new T.Vector3(),position=new T.Vector3();
  const disposeGltf=(g:GLTF)=>g.scene.traverse(o=>{const m=o as T.Mesh;if(m.isMesh){m.geometry.dispose();for(const mat of Array.isArray(m.material)?m.material:[m.material])mat.dispose();}});
  const ready=loader.loadAsync('/games/echo-spelling/reef-fish-cb0f1d62ff5f.glb').then(g=>{
    if(disposed){disposeGltf(g);return;}
    g.scene.updateMatrixWorld(true);
    g.scene.traverse(o=>{const source=o as T.Mesh<T.BufferGeometry,T.MeshStandardMaterial>;if(!source.isMesh)return;
      const geometry=source.geometry.clone().applyMatrix4(source.matrixWorld);
      geometry.setAttribute('swimPhase',new T.InstancedBufferAttribute(Float32Array.from({length:count},(_,i)=>i*1.79),1));
      const material=source.material.clone();material.envMapIntensity=.75;material.onBeforeCompile=shader=>{
        shader.uniforms.swimTime=time;
        shader.vertexShader='uniform float swimTime; attribute float swimPhase;\n'+shader.vertexShader;
        shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
          float tailWeight=pow(1.-smoothstep(-1.05,.35,position.x),1.5);
          transformed.z+=sin(swimTime*4.2+swimPhase-position.x*3.5)*tailWeight*.105;`);
      };material.customProgramCacheKey=()=> 'echo-spelling-reef-swim-1';
      const mesh=new T.InstancedMesh(geometry,material,count);mesh.frustumCulled=false;scene.add(mesh);meshes.push(mesh);
    });disposeGltf(g);
  });
  return {ready,update:(t:number,reduced:boolean)=>{
    time.value=reduced?0:t;
    for(let i=0;i<count;i++){
      const a=(reduced?0:t*.055)+i*.31,group=i%3;
      const radius=group===0?17:20;position.set(Math.sin(a)*radius,4.5+group*1.55+Math.sin(i*2.1)*1.1,-7+Math.cos(a)*9);
      // Keep marine life outside the typed-word sightline and behind the stage where it crosses the centre.
      if(Math.abs(position.x)<9)position.z=Math.min(position.z,-12);
      direction.set(Math.cos(a)*radius,Math.cos(t*.4+i)*.1,-Math.sin(a)*9).normalize();
      dummy.position.copy(position);dummy.quaternion.setFromUnitVectors(forward,direction);dummy.rotateX(Math.sin(a*.7+i)*.12);dummy.scale.setScalar(.38+(i%5)*.055);dummy.updateMatrix();
      for(const mesh of meshes)mesh.setMatrixAt(i,dummy.matrix);
    }
    for(const mesh of meshes)mesh.instanceMatrix.needsUpdate=true;
  },dispose:()=>{disposed=true;for(const mesh of meshes){scene.remove(mesh);mesh.geometry.dispose();(mesh.material as T.Material).dispose();}}};
}
