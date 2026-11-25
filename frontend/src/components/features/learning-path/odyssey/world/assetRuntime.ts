import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const worldTime = { value: 0 };
export function disposeAsset(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  root.traverse(o => { if (o instanceof THREE.Mesh) { geometries.add(o.geometry); for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m); } });
  for (const m of materials) for (const v of Object.values(m)) if (v instanceof THREE.Texture) textures.add(v);
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
  textures.forEach(t => { t.dispose(); const data = t.source.data; if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) data.close(); });
}
const PALETTES: Record<string, [string, string]> = {
  harbor:['#c07b41','#efe0b8'], memory:['#bd6e94','#d2e8c3'], grove:['#528b67','#d6dfae'], tides:['#7560b9','#d8d0ea'],
  reef:['#44a7b3','#d5e6d9'], voices:['#d07c58','#ecd6a9'], archive:['#4f849e','#c8d4ce'], lagoon:['#a46eae','#e5cee0'],
  bridges:['#708e9c','#e0d6bf'], communication:['#cf6666','#f0d5b1'], trade:['#bb8c48','#ebe0c5'], summit:['#466b9e','#eee2d5'],
  aurora:['#7465b6','#cfdcea'], review:['#6ba7a3','#d4e0ce'], trial:['#645582','#c4c8db'],
};
function prepare(gltf: GLTF) {
  // Clone by region/material, retaining every authored map and normal map. The
  // same atlas material used by several regions no longer flattens their identity.
  const regional = new Map<string, THREE.Material>();
  const originals = new Set<THREE.Material>();

  gltf.scene.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    o.castShadow = o.receiveShadow = true;
    let owner: THREE.Object3D | null = o;
    while (owner && !owner.userData.odyssey_region && !owner.userData.region_id) owner = owner.parent;
    const id = (owner?.userData.odyssey_region || owner?.userData.region_id) as string, palette = PALETTES[id];
    const recolor = (source: THREE.Material) => {
      originals.add(source);
      const key = `${id}:${source.uuid}`; let m = regional.get(key);
      if (!m) {
        m = source.clone(); regional.set(key,m);
        if (m instanceof THREE.MeshStandardMaterial) {
          if (palette && (m.name === 'Echo_tile' || m.name === 'Echo_copper')) m.color.set(palette[0]);
          if (palette && m.name === 'Echo_ivory') m.color.set(palette[1]);
          if (palette && (m.name === 'Echo_tile' || m.name === 'Echo_copper')) {
            // Retain the authored tile variation and relief without multiplying
            // every regional pigment by the old teal base texture.
            m.onBeforeCompile = shader => {
              shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
                #ifdef USE_MAP
                  vec4 tileSample = texture2D(map, vMapUv);
                  float tileValue = clamp(dot(tileSample.rgb, vec3(.2126,.7152,.0722)) * 3.5, .25, 1.);
                  diffuseColor *= vec4(vec3(tileValue), tileSample.a);
                #endif`);
            };
            m.customProgramCacheKey = () => 'odyssey-regional-tile-1';
          }
          if (/stone|ivory|basalt|tile|rock|coral|sand|earth/.test(m.name)) { m.roughness = .87; m.metalness = 0; }
          if (/gold|copper/.test(m.name)) { m.roughness = .48; m.metalness = .72; }
          if (m.normalMap) m.normalScale.set(.85,.85);
        }
      }
      return m;
    };
    o.material = Array.isArray(o.material) ? o.material.map(recolor) : recolor(o.material);
    const foliage = o.userData.odyssey_layer === 'Foliage';
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m instanceof THREE.MeshStandardMaterial) {
        if (m.map) m.map.anisotropy = 8;
        if (o.userData.odyssey_layer === 'Waterfall') {
          o.castShadow = false; m.transparent = true; m.opacity = .72; m.side = THREE.DoubleSide; m.depthWrite = false; m.roughness = .22;
          m.onBeforeCompile = shader => {
            shader.uniforms.odTime = worldTime;
            shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 odFlow;').replace('#include <begin_vertex>', '#include <begin_vertex>\nodFlow=(modelMatrix*vec4(transformed,1.)).xyz;');
            shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 odFlow;uniform float odTime;').replace('#include <color_fragment>', '#include <color_fragment>\nfloat stream=pow(.5+.5*sin(odFlow.x*17.+odFlow.y*2.+odTime*3.),4.);diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.8,.96,1.),stream*.55);diffuseColor.a*=.55+.45*stream;');
          };
          m.customProgramCacheKey = () => 'odyssey-falling-water-1';
        }
        if (foliage) {
          m.side = THREE.DoubleSide;
          if (m.name === 'Echo_leaf') m.color.setRGB(.035, .23, .04);
          if (m.name === 'Echo_leafLight') m.color.setRGB(.14, .38, .02);
          if (m.name === 'Echo_leafRose') m.color.setRGB(.72, .055, .21);
          m.onBeforeCompile = shader => {
            shader.uniforms.odTime = worldTime;
            shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float odTime;')
              .replace('#include <begin_vertex>', '#include <begin_vertex>\nvec3 odP=(modelMatrix*vec4(transformed,1.)).xyz; transformed.x += sin(odTime*.7+odP.x*.31+odP.z*.21)*.09/max(length(modelMatrix[0].xyz),.001); transformed.z += sin(odTime*.49+odP.y*.5)*.05/max(length(modelMatrix[2].xyz),.001);');
          };
          m.customProgramCacheKey = () => 'odyssey-leaf-breeze-1';
        }
      }
    }
  });
  // Texture ownership stays with the clones; only release replaced material objects.
  originals.forEach(m => m.dispose());
  return gltf;
}
/** Only the atlas and current region reside in memory. Cancel network work on rapid travel. */
export function useWorldAsset(url: string | null, onError: () => void) {
  const [loaded, setLoaded] = useState<{ url: string; gltf: GLTF } | null>(null);
  useEffect(() => {
    if (!url) return;
    const abort = new AbortController(); let asset: GLTF | null = null;
    const compressed = url.startsWith('/assets/odyssey/world/') && typeof DecompressionStream !== 'undefined';
    void fetch(compressed ? url + '.gz' : url, { signal: abort.signal }).then(r => { if (!r.ok) throw Error('Asset unavailable'); return r.arrayBuffer(); })
      .then(async bytes => {
        const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2));
        // A proxy may already decode Content-Encoding. Detect the bytes, never decompress twice.
        if (compressed && header[0] === 0x1f && header[1] === 0x8b) return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        return bytes;
      })
      .then(bytes => new GLTFLoader().parseAsync(bytes, location.origin + '/'))
      .then(gltf => {
        if (abort.signal.aborted) { disposeAsset(gltf.scene); return; }
        asset = prepare(gltf); setLoaded({ url, gltf: asset });
      }).catch(error => { if (error.name !== 'AbortError' && !abort.signal.aborted) onError(); });
    return () => { abort.abort(); if (asset) disposeAsset(asset.scene); };
  }, [url, onError]);
  return loaded?.url === url ? loaded.gltf : null;
}
