import * as T from 'three';

const DIRECT_DIFFUSE_ANCHOR =
  'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';

const SKIN_WRAP_SSS_SNIPPET = /* glsl */ `
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
	float ecRawNL = dot( geometryNormal, directLight.direction );
	float ecWrap = saturate( ( ecRawNL + 0.36 ) / 1.36 );
	float ecTermBand = smoothstep( -0.30, 0.08, ecRawNL ) * ( 1.0 - smoothstep( 0.06, 0.52, ecRawNL ) );
	vec3 ecSssTint = vec3( 0.96, 0.38, 0.24 );
	reflectedLight.directDiffuse += directLight.color * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F )
		* ecSssTint * ( ecTermBand * 0.34 + max( 0.0, ecWrap - dotNL ) * 0.26 );`;

let cachedPatchedPhysicalPars: string | null = null;
function patchedPhysicalLightsPars(): string {
  if (cachedPatchedPhysicalPars !== null) return cachedPatchedPhysicalPars;
  const base = T.ShaderChunk.lights_physical_pars_fragment;
  cachedPatchedPhysicalPars = base.includes(DIRECT_DIFFUSE_ANCHOR)
    ? base.replace(DIRECT_DIFFUSE_ANCHOR, SKIN_WRAP_SSS_SNIPPET)
    : base;
  return cachedPatchedPhysicalPars;
}

/**
 * Shared wrap-diffuse + warm subsurface terminator scatter + grazing rim shader patch.
 * Shares a single compiled WebGL2 program cache key (`ec-skin-sss-face-v3` / `ec-skin-sss-body-v3`)
 * across the player cast, Speaking Arena, and every Echo Life resident & crowd character.
 */
export function applySkinSubsurfaceShader(material: T.MeshPhysicalMaterial, face: boolean): void {
  const rimTint = face ? 'vec3(0.14, 0.045, 0.032)' : 'vec3(0.28, 0.075, 0.045)';
  const tag = face ? 'ec-skin-sss-face-v3' : 'ec-skin-sss-body-v3';
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) {
    if (typeof prevCompile === 'function' && prevCompile !== T.Material.prototype.onBeforeCompile) {
      prevCompile.call(this, shader, renderer);
    }
    if (!shader.fragmentShader.includes('ecTermBand')) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_physical_pars_fragment>', patchedPhysicalLightsPars())
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `
            float ecRim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
            outgoingLight += diffuseColor.rgb * ${rimTint} * ecRim * (reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + vec3(0.06));
            #include <opaque_fragment>`,
        );
    }
  };
  material.customProgramCacheKey = function () {
    const baseKey =
      typeof prevKey === 'function' && prevKey !== T.Material.prototype.customProgramCacheKey
        ? prevKey.call(this)
        : '';
    return baseKey ? `${baseKey}:${tag}` : tag;
  };
}

/**
 * Skin, not plastic: controlled specular, a soft warm sheen in place of wax, wrap-diffuse terminator
 * warmth so shaded faces stay alive under outdoor sunlight, and light bleeding red through thin edges.
 * A single extra fragment term, no extra pass and no screen-space blur: cheap on any laptop GPU.
 */
export function skinMaterial(source: T.MeshStandardMaterial, options: { face?: boolean } = {}): T.MeshPhysicalMaterial {
  const face = !!options.face;
  const baseTint = face ? new T.Color(1, .985, .97) : new T.Color(.80, .70, .64);
  const m = new T.MeshPhysicalMaterial({
    name: face ? 'Face skin' : 'Hand skin',
    // The face's colour is painted to match the hands as they come out of this tint; its vertex colours carry the mouth and the shade.
    map: source.map,
    color: baseTint.clone(),
    vertexColors: face,
    normalMap: source.normalMap,
    ...(source.normalMap ? { normalScale: source.normalScale.clone().multiplyScalar(1.3) } : {}),
    roughnessMap: source.roughnessMap,
    metalnessMap: null,
    roughness: face ? .54 : (source.roughnessMap ? 1 : .58),
    metalness: 0,
    specularIntensity: face ? .42 : .56,
    specularColor: new T.Color('#ffe6d8'),
    sheen: face ? .16 : .28,
    sheenRoughness: .72,
    sheenColor: new T.Color('#d87b60'),
    envMapIntensity: .58,
    // Hand skin sits in front of Wear_skin (+2/+2) at the wrist weld yet strictly behind sleeves/wristbands (0/0).
    ...(face ? {} : { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
  });
  m.userData.ecBaseSkinTint = baseTint;
  applySkinSubsurfaceShader(m, face);
  return m;
}

/**
 * Hands take the skin material; every other surface of the cast keeps its authored palette.
 * Also enforces unit bone scales `(1, 1, 1)` and private `boneInverses` per cloned cast instance
 * so child rotations never shear and skeleton inverse-bind updates never alias across actors.
 * Returns what the caller must dispose.
 */
export function prepareCastMaterials(model: T.Object3D): T.Material[] {
  const owned: T.Material[] = [];
  model.traverse((o) => {
    if ((o as T.Bone).isBone) {
      o.scale.set(1, 1, 1);
      return;
    }
    const sm = o as T.SkinnedMesh;
    if (sm.isSkinnedMesh && sm.skeleton && !sm.userData.__ecPrivateInverses) {
      sm.skeleton.boneInverses = sm.skeleton.boneInverses.map((inv) => inv.clone());
      sm.userData.__ecPrivateInverses = true;
    }
    const mesh = o as T.Mesh;
    if (!mesh.isMesh || !mesh.name.includes('Hands')) return;
    const skin = skinMaterial(mesh.material as T.MeshStandardMaterial);
    mesh.material = skin;
    mesh.receiveShadow = true;
    owned.push(skin);
  });
  return owned;
}
