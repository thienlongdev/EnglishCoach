import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mat } from './materials';
import { prepareRackAsset, clearRackAssets, type RackClipCache } from './rackMechanism';

/** Original Blender source + mesh/texture budgets: docs/study-space/2026-11-02/completion/art/. */
export const STUDY_FURNITURE_URL='/assets/study-space/study-furniture-c60a1e02be21.glb';
const ids=new Set(['desk.corner','desk.wood','chair.office','bed.single','bed.drawer','shelf.tall','nightstand','lamp.floor','armchair']);
/** The cleaning kit, original and from code: docs/study-space/echo-life-5-20261107/art/care_pack.py. Only a room with some of it pays for it. */
export const STUDY_CARE_URL='/assets/study-space/study-care-bdad72965e8b.glb';
const RACK_CLIP_URL='/assets/study-space/rack-clips-34103ebb57be.json';
const CARE_SHA256='bdad72965e8bdc660b52392e454058f6e32b4872821ed33f811f451075457fdc';
/** The kettle, the can, the tea things, a spare bulb, a real plant: CC0 from Poly Haven through docs/study-space/echo-life-5-20261107/art/life_pack.py. */
export const STUDY_LIFE_URL='/assets/study-space/study-life-f262c22ea736.glb';
const LIFE_IDS=new Set(['kettle.vintage','can.watering','teapot','teacup','saucer','bulb.spare','plant.terracotta']);
export const CARE_IDS=new Set(['tool.broom','tool.dustpan','tool.mop','tool.bucket','tool.cloth','tool.duster','tool.webbrush','bin.trash','rack.cleaning','sink.utility','trash.paper','trash.bag',...LIFE_IDS]);
let models=new Map<string,T.Object3D>();
let scene:T.Group|null=null;
let loading:Promise<void>|null=null;
let careScene:T.Group|null=null;
let careLoading:Promise<void>|null=null;
let lifeScene:T.Group|null=null;
let epoch=0;
function release(root:T.Object3D){
  const geometry=new Set<T.BufferGeometry>(),materials=new Set<T.Material>(),textures=new Set<T.Texture>();
  root.traverse(o=>{const m=o as T.Mesh;if(!m.isMesh)return;geometry.add(m.geometry);for(const mat of Array.isArray(m.material)?m.material:[m.material]){materials.add(mat);for(const v of Object.values(mat))if(v instanceof T.Texture)textures.add(v);}});
  geometry.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());
}
/** A drawer: `open` 0..1 along `axis` by `travel` metres. `handle` is in the piece's own space. */
export interface Slider{node:T.Object3D;axis:T.Vector3;travel:number;handle:T.Vector3;open:number}
export function loadStudyAssets(){
  if(loading)return loading;const at=epoch;
  loading=new GLTFLoader().loadAsync(STUDY_FURNITURE_URL).then(g=>{
    if(at!==epoch){release(g.scene);return;}scene=g.scene;
    g.scene.traverse(o=>{const name=o.userData.name??o.name;if(ids.has(name))models.set(name,o);});
  }).catch(()=>{loading=null;});
  return loading;
}
export function loadCareAssets(){
  if(careLoading)return careLoading;const at=epoch;
  const loader=new GLTFLoader();
  const clips=fetch(RACK_CLIP_URL).then(r=>{if(!r.ok)throw new Error('rack cache unavailable');return r.json() as Promise<RackClipCache>;}).catch(()=>null);
  careLoading=Promise.all([loader.loadAsync(STUDY_CARE_URL),loader.loadAsync(STUDY_LIFE_URL),clips]).then(([g,life,cache])=>{
    if(at!==epoch){release(g.scene);release(life.scene);return;}careScene=g.scene;lifeScene=life.scene;
    for(const root of [g.scene,life.scene])root.traverse(o=>{const name=o.userData.name??o.name;if(CARE_IDS.has(name))models.set(name,o);});
    // A failed cache retains the complete static drawing/collision fallback.
    const rack=models.get('rack.cleaning');
    if(rack&&cache){try{prepareRackAsset(rack,cache,CARE_SHA256);}catch{ /* Keep unknown art fixed; never remove its collisions. */ }}
    // The source has the cup and its saucer as one piece. A cup is lifted to the mouth, its saucer stays on the table: two things here, the cup standing on its own foot at its origin.
    const cup=models.get('teacup');
    if(cup&&!models.has('saucer')){
      const named=(n:string)=>cup.children.find(c=>(c.userData.name??c.name)===n);
      const plate=named('Saucer'),body=named('Body.002');
      if(plate){const saucer=new T.Group();saucer.name='saucer';saucer.userData.name='saucer';saucer.add(plate);models.set('saucer',saucer);}
      if(body)body.position.y-=CUP_FOOT;
    }
  }).catch(()=>{careLoading=null;});
  return careLoading;
}
const CUP_FOOT=.012;
export const careReady=()=>!!careScene;
export function studyAsset(kind:string,color?:string):T.Group|null{
  const source=models.get(kind);if(!source)return null;
  const group=new T.Group();group.add(source.clone(true));
  group.traverse(o=>{const mesh=o as T.Mesh;if(!mesh.isMesh)return;mesh.castShadow=true;mesh.receiveShadow=true;
    // Bristles, strands and what a tool holds are looked at, never landed on: a thing in a collider is its handle and its head.
    if(o.userData.noCollision){o.userData.pickable=true;}
    if(color){const replace=(m:T.Material)=>m.name==='Accent'?mat('fabric',color):m.name==='Warm oak'||m.name==='Walnut'?mat('wood',color):m;mesh.material=Array.isArray(mesh.material)?mesh.material.map(replace):replace(mesh.material);}
  });
  // The drawers are real nodes under the piece (Slider.N, authored in furniture.py): the room slides them along their axis.
  const sliders:Slider[]=[];
  group.traverse(o=>{if(o.userData.sliderTravel!==undefined)sliders.push({node:o,axis:new T.Vector3(...(o.userData.sliderAxis as [number,number,number])),travel:o.userData.sliderTravel,handle:new T.Vector3(...(o.userData.sliderHandle as [number,number,number])),open:0});});
  if(sliders.length)group.userData.sliders=sliders;
  if(kind==='lamp.floor')group.userData.lights=[{pos:[0,1.27,0],color:'#ffd5a0',intensity:.65,distance:2.5}];
  if(kind==='chair.office'){group.userData.seatHeight=.54;group.userData.armrest=.7525;}
  if(kind==='armchair'){group.userData.seatHeight=.485;group.userData.armrest=.68;}
  if(CARE_IDS.has(kind))prepareCare(group);
  group.userData.asset='blender';return group;
}
/** A tool's own materials: its head darkens as it gets wet and dirty, on this one tool. Named parts are kept for what they show. */
function prepareCare(group:T.Group){
  const parts:Record<string,T.Object3D>={};
  group.traverse(o=>{const name=(o.userData.name??o.name) as string;const mesh=o as T.Mesh;if(!mesh.isMesh)return;parts[name]=o;
    if(['Strands','Cloth','Water','Fill','Stream','Leaves','Dirt'].includes(name))mesh.material=(mesh.material as T.Material).clone();
    if(name==='Water'||name==='Stream'){const m=mesh.material as T.MeshStandardMaterial;m.transparent=true;m.depthWrite=false;m.opacity=name==='Stream'?.72:.86;mesh.castShadow=false;}
    if(name==='Stream'||name==='Fill'||name==='Water')mesh.visible=false;
  });
  // What is in a cup is seen from above: a surface at its level, coloured by what it is.
  if(group.children[0]?.name==='teacup'||(group.children[0]?.userData.name==='teacup')){
    const liquid=new T.Mesh(new T.CircleGeometry(.033,28),new T.MeshStandardMaterial({color:'#8fb4c9',roughness:.06,metalness:.1,transparent:true,opacity:.86}));
    liquid.rotation.x=-Math.PI/2;liquid.visible=false;liquid.name='Liquid';liquid.userData.noCollision=true;liquid.castShadow=false;
    group.add(liquid);parts.Liquid=liquid;
  }
  // The bulb's glass is drawn as glass: the file's own glass needs a refraction pass the room does not spend on a thing this small.
  if(group.children[0]?.name==='bulb.spare'||group.children[0]?.userData.name==='bulb.spare'){
    group.traverse(o=>{const mesh=o as T.Mesh;if(!mesh.isMesh)return;const m=(mesh.material as T.MeshStandardMaterial).clone();m.color=new T.Color('#fff8e6');m.emissive=new T.Color('#c9c2ae');m.emissiveIntensity=.5;m.metalness=.1;m.roughness=.2;m.transparent=true;m.opacity=.82;mesh.material=m;});
  }
  group.userData.care=parts;
}
export function disposeStudyAssets(){epoch++;if(scene)release(scene);if(careScene)release(careScene);if(lifeScene)release(lifeScene);clearRackAssets();scene=null;careScene=null;lifeScene=null;models=new Map();loading=null;careLoading=null;}
