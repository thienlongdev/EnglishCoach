import * as T from 'three';
import { getRenderConfig, type GpuClass, type QualityTier } from './renderConfig';

/**
 * Echo Life AAA — Non-Destructive Chained 3-Cascade Texel-Snapped Shadow Maps (`EchoCsmSystem`).
 *
 * Architectural invariants:
 * 1. ZERO global `THREE.ShaderChunk` mutation (other 3D modules — Speaking Arena, Dictionary, Flashcards,
 *    Games, Study Room Overview — are 100% unaffected!).
 * 2. ZERO `onBeforeCompile` clobbering: `patchMaterialWithEchoCsm` chains cleanly with `weatherSystem`,
 *    `worldSurfaces`, `grassField`, `vegetationSystem`, and `characterMaterials`.
 * 3. ZERO double-lighting on unpatched materials: Cascade 0 reuses the scene's primary `DirectionalLight`
 *    at full sun intensity; Cascades 1 & 2 are shadow-carrier `DirectionalLight(0x000000, 0)` instances
 *    (`intensity = 0`, `castShadow = true`) added AFTER Cascade 0 so `WebGLLights` binds them to
 *    `directionalShadowMap[1]` and `[2]` without ever adding spurious diffuse/specular energy to any
 *    unpatched mesh!
 * 4. Rotation-invariant analytical bounding-sphere frustum slices + light-space texel snapping = ZERO
 *    shadow swimming/flicker during camera movement or rotation, with staggered far-cascade update cadence.
 * 5. Zero `FloatType` render targets; uses Three.js r186 native hardware Vogel-disk + IGN `PCFShadowMap`.
 */

export interface EchoCsmConfig {
  readonly cascades: number;
  /** Cascade 0 map size (kept for backwards compatibility; see `mapSizes` for per-cascade sizes). */
  readonly mapSize: number;
  /** Per-cascade shadow map sizes (e.g. `[2048, 1536, 1024]` Ultra, `[1536, 1024]` High, `[1024]` Balanced). */
  readonly mapSizes: readonly number[];
  readonly splits: readonly number[];
  /** Per-cascade frame cadences (e.g. `[1, 2, 4]` Ultra, `[1, 2]` High, `[2]` Balanced). */
  readonly cadences: readonly number[];
  /** Fractional width of the smooth cross-fade band at each cascade boundary (default 0.12). */
  readonly fadeFraction: number;
  /** Update cadence for the farthest cascade (4 Ultra, 2 High/Balanced). */
  readonly farCadence: number;
  /** Extra pullback margin (metres) toward the sun so tall buildings/trees behind camera cast shadows cleanly. */
  readonly lightMargin: number;
  readonly shadowBiases: readonly number[];
  readonly shadowNormalBiases: readonly number[];
  readonly shadowRadii: readonly number[];
}

export interface EchoCsmCascadeExclusions {
  /** Skinned NPCs, player avatar & dynamic actors excluded from Cascade 1 & Cascade 2 (C0-only shadows). */
  readonly npcs?: readonly (T.Object3D | null | undefined)[];
  /** Vegetation/trees excluded from Cascade 2 (static buildings & landmarks only in C2). */
  readonly vegetation?: readonly (T.Object3D | null | undefined)[];
  /** Optional minor dynamic props/vehicles excluded from Cascade 2. */
  readonly dynamicProps?: readonly (T.Object3D | null | undefined)[];
}

export const ECHO_CSM_LAYER_ALL = 0;
/** Optional Three.js layer bit for small props/clutter that cast shadows only in Cascade 0 (near 0–22 m). */
export const ECHO_CSM_LAYER_C0_ONLY = 1;

/** Marks an Object3D subtree so it casts shadows ONLY in Cascade 0 (excluded from C1/C2 far shadow passes). */
export function markCsmC0Only(object: T.Object3D): void {
  object.userData.__echoCsmC0Only = true;
}

export type EchoCsmZoneMode = 'outdoor' | 'study-room' | 'city-interior';

export interface EchoCsmDiagnostics {
  readonly tier: QualityTier;
  readonly active: boolean;
  readonly zoneMode: EchoCsmZoneMode;
  readonly cascades: number;
  readonly mapSize: number;
  readonly mapSizes: readonly number[];
  readonly splits: readonly number[];
  readonly cadences: readonly number[];
  readonly farCascadeUpdates: number;
  readonly secondaryCascadeRenders: number;
  readonly patchedMaterials: number;
  readonly c1ExcludedNodes: number;
  readonly c2ExcludedNodes: number;
}

export interface SharedCsmUniforms {
  /** (split0, split1, split2, fadeFraction) in positive camera-view metres. */
  uCsmSplits: { value: T.Vector4 };
  /**
   * Per-cascade world-texel-to-depth-span ratio `(texelC0/span0, texelC1/span1, texelC2/span2, texelStudy/spanStudy)`
   * driving exact PCF-kernel-proportional slope receiver bias without Peter-Panning flat contact shadows.
   */
  uCsmSlopeScale: { value: T.Vector4 };
  /**
   * 5-mode float uniform (zero shader defines / zero recompiles across all zones):
   * - `-1.0`: City Interiors / CAZ Studio (`csmSh = 1.0`, skips `getShadow()` completely)
   * - `0.0`: Study Room single-light shadow (`directionalShadowMap[0]`, no far-edge fade, no carriers)
   * - `1.0`: Balanced 1-cascade outdoor shadow with smooth far-edge fade
   * - `2.0`: High 2-cascade CSM (`C0 + C1`)
   * - `3.0`: Ultra 3-cascade CSM (`C0 + C1 + C2`)
   */
  uCsmEnabled: { value: number };
}

const SHARED_CSM_UNIFORMS: SharedCsmUniforms = {
  uCsmSplits: { value: new T.Vector4(22, 60, 140, 0.12) },
  uCsmSlopeScale: { value: new T.Vector4(0.00014, 0.00034, 0.00070, 0.00022) },
  uCsmEnabled: { value: 0 },
};

/** Returns the singleton shared CSM uniform block updated once per frame by `EchoCsmSystem`. */
export function getSharedCsmUniforms(): SharedCsmUniforms {
  return SHARED_CSM_UNIFORMS;
}

/** Resolves calibrated per-cascade splits, resolutions, cadences, and anti-acne biases for a quality tier. */
export function getCsmConfigForTier(tier: QualityTier, gpuClass?: GpuClass): EchoCsmConfig {
  const s = getRenderConfig(tier, undefined, gpuClass).shadow;
  if (!s.enabled || s.cascades <= 0) {
    return {
      cascades: 0,
      mapSize: 0,
      mapSizes: [],
      splits: [],
      cadences: [],
      fadeFraction: 0.12,
      farCadence: 0,
      lightMargin: 80,
      shadowBiases: [],
      shadowNormalBiases: [],
      shadowRadii: [],
    };
  }
  if (s.cascades >= 3) {
    const mapSizes = s.cascadeMapSizes.length >= 3 ? s.cascadeMapSizes : [2048, 1536, 1024];
    const cadences = s.cascadeCadences.length >= 3 ? s.cascadeCadences : [1, 2, 4];
    return {
      cascades: 3,
      mapSize: mapSizes[0] ?? (s.cascadeMapSize || 2048),
      mapSizes,
      splits: s.cascadeSplits.length >= 3 ? s.cascadeSplits : [22, 60, 140],
      cadences,
      fadeFraction: 0.12,
      farCadence: Math.max(1, cadences[2] ?? s.farCascadeCadence ?? 4),
      lightMargin: 96,
      shadowBiases: [-0.00020, -0.00042, -0.00078],
      shadowNormalBiases: [0.028, 0.078, 0.175],
      shadowRadii: [1.55, 1.85, 2.25],
    };
  }
  if (s.cascades === 2) {
    const mapSizes = s.cascadeMapSizes.length >= 2 ? s.cascadeMapSizes : [1536, 1024];
    const cadences = s.cascadeCadences.length >= 2 ? s.cascadeCadences : [1, 2];
    const c0Map = mapSizes[0] ?? (s.cascadeMapSize || 1536);
    const clamped4Gb = c0Map <= 1024;
    return {
      cascades: 2,
      mapSize: c0Map,
      mapSizes,
      splits: s.cascadeSplits.length >= 2 ? s.cascadeSplits : [22, 65],
      cadences,
      fadeFraction: 0.12,
      farCadence: Math.max(1, cadences[1] ?? s.farCascadeCadence ?? 2),
      lightMargin: 88,
      shadowBiases: clamped4Gb ? [-0.00032, -0.00062] : [-0.00025, -0.00058],
      shadowNormalBiases: clamped4Gb ? [0.048, 0.115] : [0.036, 0.110],
      shadowRadii: clamped4Gb ? [1.55, 1.90] : [1.60, 1.95],
    };
  }
  const c0Size = s.cascadeMapSizes[0] ?? (s.cascadeMapSize || 1024);
  const c0Cadence = Math.max(1, s.cascadeCadences[0] ?? s.cadence ?? 2);
  const c0Split = s.cascadeSplits[0] ?? 26;
  return {
    cascades: 1,
    mapSize: c0Size,
    mapSizes: [c0Size],
    splits: [c0Split],
    cadences: [c0Cadence],
    fadeFraction: 0.12,
    farCadence: c0Cadence,
    lightMargin: 76,
    shadowBiases: [-0.00034],
    shadowNormalBiases: [0.052],
    shadowRadii: [1.55],
  };
}

// ── Scoped Non-Destructive GLSL Patch Builder (Zero Global ShaderChunk Mutation!) ──────────────────────────

let cachedCsmLightsChunk: string | null = null;

const DIR_LOOP_BLOCK_RE =
  /#if\s*\(\s*NUM_DIR_LIGHTS\s*>\s*0\s*\)\s*&&\s*defined\(\s*RE_Direct\s*\)[\s\S]*?#pragma\s+unroll_loop_end\s*#endif/;

const ECHO_CSM_DIR_LIGHTS_BLOCK = /* glsl */ `#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

		#if ( UNROLLED_LOOP_INDEX == 0 )
			directionalLight = directionalLights[ 0 ];
			getDirectionalLightInfo( directionalLight, directLight );
			float csmGeoNdotL = dot( nonPerturbedNormal, directLight.direction );
			#ifdef DOUBLE_SIDED
				// Preserve P1-VIS-4B upward-bent snowy grass & foliage illumination on double-sided leaves/blades.
				float csmHorizonVis = 1.0;
				float csmCos = clamp( max( csmGeoNdotL, dot( geometryNormal, directLight.direction ) ), 0.0, 1.0 );
			#else
				// Geometric horizon micro-shadowing: prevents PBR normal-mapped plaster/stucco/brick bumps on ceilings
				// and back-facing/grazing walls (csmGeoNdotL <= 0.0) from catching grazing direct sun & sparkling!
				float csmHorizonVis = smoothstep( 0.005, 0.085, csmGeoNdotL );
				float csmCos = clamp( csmGeoNdotL, 0.0, 1.0 );
				directLight.color *= csmHorizonVis;
			#endif
			#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )
				// uCsmEnabled < -0.5 -> City Interiors / CAZ Studio: skip all shadow taps (csmSh = 1.0).
				// csmHorizonVis <= 0.001 -> back-facing / grazing ceiling or wall: already 0 direct sun, skip noisy PCF tap!
				if ( directLight.visible && receiveShadow && uCsmEnabled > -0.5 && csmHorizonVis > 0.001 ) {
					float csmSin = sqrt( max( 0.0, 1.0 - csmCos * csmCos ) );
					// Slope-scaled receiver bias: ~0 on horizontal sunlit floors (0 Peter-Panning!), scales smoothly with
					// tan(theta) * cascade PCF kernel radius on walls, roofs & grazing facades (0 Vogel-IGN scratch bands!).
					float csmSlope = min( 5.5, csmSin / max( csmCos, 0.16 ) );
					#ifdef DOUBLE_SIDED
						float csmGrazingKeep = 1.0;
					#else
						float csmGrazingKeep = smoothstep( 0.02, 0.10, csmCos );
					#endif
					if ( uCsmEnabled > 1.5 ) {
						float csmDepth = vViewPosition.z;
						float csmS0 = uCsmSplits.x;
						float csmS1 = uCsmSplits.y;
						float csmS2 = uCsmSplits.z;
						float csmFade = uCsmSplits.w;
						float csmSh = 1.0;

						if ( csmDepth < csmS0 ) {
							float csmBias0 = directionalLightShadows[ 0 ].shadowBias - uCsmSlopeScale.x * ( directionalLightShadows[ 0 ].shadowRadius + 0.85 ) * csmSlope;
							float sh0 = getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowIntensity, csmBias0, directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ] );
							float band0 = csmS0 * csmFade;
							if ( csmDepth > csmS0 - band0 ) {
								#if ( NUM_DIR_LIGHT_SHADOWS >= 2 )
									float csmBias1 = directionalLightShadows[ 1 ].shadowBias - uCsmSlopeScale.y * ( directionalLightShadows[ 1 ].shadowRadius + 0.85 ) * csmSlope;
									float sh1 = getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowIntensity, csmBias1, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] );
									csmSh = mix( sh0, sh1, smoothstep( csmS0 - band0, csmS0, csmDepth ) );
								#else
									csmSh = sh0;
								#endif
							} else {
								csmSh = sh0;
							}
						} else if ( csmDepth < csmS1 ) {
							#if ( NUM_DIR_LIGHT_SHADOWS >= 2 )
								float csmBias1 = directionalLightShadows[ 1 ].shadowBias - uCsmSlopeScale.y * ( directionalLightShadows[ 1 ].shadowRadius + 0.85 ) * csmSlope;
								float sh1 = getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowIntensity, csmBias1, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] );
								if ( uCsmEnabled > 2.5 ) {
									float band1 = max( 1.0, csmS1 - csmS0 ) * csmFade;
									if ( csmDepth > csmS1 - band1 ) {
										#if ( NUM_DIR_LIGHT_SHADOWS >= 3 )
											float csmBias2 = directionalLightShadows[ 2 ].shadowBias - uCsmSlopeScale.z * ( directionalLightShadows[ 2 ].shadowRadius + 0.85 ) * csmSlope;
											float sh2 = getShadow( directionalShadowMap[ 2 ], directionalLightShadows[ 2 ].shadowMapSize, directionalLightShadows[ 2 ].shadowIntensity, csmBias2, directionalLightShadows[ 2 ].shadowRadius, vDirectionalShadowCoord[ 2 ] );
											csmSh = mix( sh1, sh2, smoothstep( csmS1 - band1, csmS1, csmDepth ) );
										#else
											csmSh = sh1;
										#endif
									} else {
										csmSh = sh1;
									}
								} else {
									csmSh = mix( sh1, 1.0, smoothstep( csmS1 * 0.86, csmS1, csmDepth ) );
								}
							#endif
						} else if ( uCsmEnabled > 2.5 && csmDepth < csmS2 ) {
							#if ( NUM_DIR_LIGHT_SHADOWS >= 3 )
								float csmBias2 = directionalLightShadows[ 2 ].shadowBias - uCsmSlopeScale.z * ( directionalLightShadows[ 2 ].shadowRadius + 0.85 ) * csmSlope;
								float sh2 = getShadow( directionalShadowMap[ 2 ], directionalLightShadows[ 2 ].shadowMapSize, directionalLightShadows[ 2 ].shadowIntensity, csmBias2, directionalLightShadows[ 2 ].shadowRadius, vDirectionalShadowCoord[ 2 ] );
								csmSh = mix( sh2, 1.0, smoothstep( csmS2 * 0.88, csmS2, csmDepth ) );
							#endif
						}

						directLight.color *= mix( 1.0, csmSh, csmGrazingKeep );
					} else if ( uCsmEnabled > 0.5 ) {
						// Crisp single-cascade Balanced outdoor path: smooth far edge fade prevents square cutoff.
						directionalLightShadow = directionalLightShadows[ 0 ];
						float csmBias0 = directionalLightShadow.shadowBias - uCsmSlopeScale.x * ( directionalLightShadow.shadowRadius + 0.85 ) * csmSlope;
						float sh0 = getShadow( directionalShadowMap[ 0 ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, csmBias0, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ 0 ] );
						float fadedSh0 = mix( sh0, 1.0, smoothstep( uCsmSplits.x * 0.82, uCsmSplits.x, vViewPosition.z ) );
						directLight.color *= mix( 1.0, fadedSh0, csmGrazingKeep );
					} else {
						// Study Room & Starter House single-light shadow (uCsmEnabled == 0.0): exact room frustum, slope-biased.
						directionalLightShadow = directionalLightShadows[ 0 ];
						float csmBiasRoom = directionalLightShadow.shadowBias - uCsmSlopeScale.w * ( directionalLightShadow.shadowRadius + 0.85 ) * csmSlope;
						float shRoom = getShadow( directionalShadowMap[ 0 ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, csmBiasRoom, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ 0 ] );
						directLight.color *= mix( 1.0, shRoom, csmGrazingKeep );
					}
				}
			#endif
			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		#elif defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX > 0 ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
			// Compile-time skip for CSM cascade carrier slots [1 .. NUM_DIR_LIGHT_SHADOWS - 1]:
			// WebGLLights stably sorts castShadow directional lights first ([0]=primaryKey, [1..N-1]=carriers).
			// Keeping active-tier carriers visible=true & castShadow=true indoors preserves constant
			// NUM_DIR_LIGHTS & NUM_DIR_LIGHT_SHADOWS with ZERO shadow taps and ZERO illumination overhead!
		#else
			// Non-shadow directional lights (windowLight, fill) at indices >= NUM_DIR_LIGHT_SHADOWS.
			directionalLight = directionalLights[ i ];
			getDirectionalLightInfo( directionalLight, directLight );
			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		#endif

	}
	#pragma unroll_loop_end

#endif`;

/**
 * Idempotent non-destructive `onBeforeCompile` + `customProgramCacheKey` chainer shared across
 * Study Space and Echo Life materials so domain hooks, weather hooks, height fog, and CSM compose
 * cleanly without clobbering each other or double-patching on repeated traversals.
 */
export function chainMaterialShader(
  material: T.Material,
  tag: string,
  hook: (shader: T.WebGLProgramParametersWithUniforms, renderer: T.WebGLRenderer) => void,
): void {
  const ud = material.userData;
  const hasCustomPrevKey = material.customProgramCacheKey !== T.Material.prototype.customProgramCacheKey;
  let applied = ud.__ecShaderTags as Set<string> | undefined;
  if (!(applied instanceof Set)) {
    applied = new Set<string>();
    // Three.js Material.copy() JSON-clones userData (turning Set into `{}`), while preserving customProgramCacheKey.
    // Re-hydrate existing tags from the cloned material's cache key so cloned patched materials never double-wrap!
    if (hasCustomPrevKey) {
      try {
        const existingKey = material.customProgramCacheKey();
        if (typeof existingKey === 'string' && existingKey.length > 0) {
          for (const part of existingKey.split('|')) {
            if (part) applied.add(part);
          }
        }
      } catch {
        // Non-fatal: proceed with empty tag set if a third-party cache key closure expects render state.
      }
    }
    ud.__ecShaderTags = applied;
  }
  if (applied.has(tag)) return;
  applied.add(tag);

  const prevCompile = material.onBeforeCompile;
  const hasCustomPrevCompile = prevCompile !== T.Material.prototype.onBeforeCompile;
  const prevCacheKey = hasCustomPrevKey ? material.customProgramCacheKey.bind(material) : null;
  const fallbackPrevKey = !hasCustomPrevKey && hasCustomPrevCompile ? prevCompile.toString() : '';

  material.customProgramCacheKey = () => {
    const base = prevCacheKey ? prevCacheKey() : fallbackPrevKey;
    return base ? `${base}|${tag}` : tag;
  };
  material.onBeforeCompile = (shader, renderer) => {
    if (hasCustomPrevCompile) prevCompile.call(material, shader, renderer);
    hook(shader, renderer);
  };
}

function getCsmLightsFragmentBegin(): string | null {
  if (cachedCsmLightsChunk !== null) return cachedCsmLightsChunk;
  const base = T.ShaderChunk.lights_fragment_begin;
  if (!base || !DIR_LOOP_BLOCK_RE.test(base)) {
    return null;
  }
  cachedCsmLightsChunk = base.replace(DIR_LOOP_BLOCK_RE, ECHO_CSM_DIR_LIGHTS_BLOCK);
  return cachedCsmLightsChunk;
}

function isCsmCompatibleMaterial(mat: T.Material): boolean {
  return (
    mat instanceof T.MeshStandardMaterial ||
    mat instanceof T.MeshPhysicalMaterial ||
    mat instanceof T.MeshLambertMaterial ||
    mat instanceof T.MeshPhongMaterial
  );
}

/**
 * Non-destructively chains Echo Life 3-cascade CSM selection (`echo-csm-v5`) onto any Three.js PBR/lit material.
 * - Preserves all prior `onBeforeCompile` hooks and `customProgramCacheKey` values.
 * - Safe to call multiple times (idempotent via `material.userData.__echoCsmPatched`).
 * - Adds only 1 constant key suffix (`echo-csm-v5`); zero shader permutation explosion.
 */
export function patchMaterialWithEchoCsm<M extends T.Material>(
  material: M,
  uniforms: SharedCsmUniforms = SHARED_CSM_UNIFORMS,
): M {
  if (!isCsmCompatibleMaterial(material)) return material;
  // Require a live Set tag (not merely JSON-cloned userData.__echoCsmPatched from Material.clone(),
  // which copies userData while dropping onBeforeCompile / customProgramCacheKey!).
  const liveTags = material.userData.__ecShaderTags;
  if (material.userData.__echoCsmPatched && liveTags instanceof Set && liveTags.has('echo-csm-v6')) {
    return material;
  }
  const replacement = getCsmLightsFragmentBegin();
  if (!replacement) return material;

  material.userData.__echoCsmPatched = true;

  chainMaterialShader(material, 'echo-csm-v6', (shader) => {
    if (!shader.fragmentShader.includes('#include <lights_fragment_begin>')) return;

    shader.uniforms.uCsmSplits = uniforms.uCsmSplits;
    shader.uniforms.uCsmSlopeScale = uniforms.uCsmSlopeScale;
    shader.uniforms.uCsmEnabled = uniforms.uCsmEnabled;

    if (!shader.fragmentShader.includes('uniform vec4 uCsmSplits;')) {
      shader.fragmentShader =
        /* glsl */ `uniform vec4 uCsmSplits;
uniform vec4 uCsmSlopeScale;
uniform float uCsmEnabled;
` + shader.fragmentShader;
    }

    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', replacement);
  });

  material.needsUpdate = true;
  return material;
}

// ── Safe Parallel Shader Compilation (`safeCompileAsync`) & Scene Shadow-Map Readiness Guard ──────────────

let inFlightSafeCompiles = 0;

/** Returns the count of currently active `safeCompileAsync` passes (pruners defer eviction while > 0). */
export function getInFlightCompileCount(): number {
  return inFlightSafeCompiles;
}

/**
 * Returns `true` when `renderer.shadowMap.enabled` is false OR every visible shadow-casting light
 * in `scene` already has an allocated GPU `shadow.map` (prevents Three.js r186 `emptyShadowTexture`
 * `GL_INVALID_OPERATION` / full-shadow black-band artifacts on secondary render passes).
 */
export function hasAllSceneShadowMaps(
  scene: T.Scene,
  renderer?: T.WebGLRenderer | null,
): boolean {
  if (renderer && !renderer.shadowMap.enabled) return true;
  let allReady = true;
  scene.traverseVisible((obj) => {
    if (!allReady) return;
    const light = obj as T.Light;
    if (!light.isLight || !light.castShadow) return;
    const shadow = (light as T.DirectionalLight).shadow;
    if (!shadow || !shadow.map) {
      allReady = false;
    }
  });
  return allReady;
}

export interface SafeCompileAsyncOptions {
  readonly signal?: AbortSignal;
  readonly aborted?: () => boolean;
  /** Optional safety cap in ms (0 = unlimited; default 15_000 ms). */
  readonly timeoutMs?: number;
  readonly onProgress?: (ready: number, total: number) => void;
}

interface ThreeRendererPropertiesLike {
  get: (mat: T.Material) => {
    currentProgram?: {
      program?: WebGLProgram;
      isReady?: () => boolean | null;
    };
  };
}

export interface SafeCompileAsyncResult {
  readonly compiled: number;
  readonly ready: number;
  readonly aborted: boolean;
  /**
   * `true` when `KHR_parallel_shader_compile` is absent on the active WebGL2 context so the caller
   * knows shader programs have NOT been linked asynchronously yet and must run batched `1x1` draw-linking!
   */
  readonly needsDrawLink: boolean;
}

function isTabHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function yieldPollStep(ms: number): Promise<void> {
  // Never tight-spin `MessageChannel` while hidden (100% CPU burn!); yield cleanly at 50 ms when hidden.
  const delay = isTabHidden() ? Math.max(50, ms) : ms;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Safe drop-in replacement for Three.js r186 `renderer.compileAsync()`.
 *
 * - Requires explicit `targetScene: T.Scene` (4th parameter) so subtrees are NEVER compiled against a
 *   lightless root!
 * - Eliminates the verified r186 `WebGLProgram.destroy()` race (`three.module.js:326980-327200`) where
 *   disposing a material mid-compile sets `program.program = undefined` without setting `programReady = true`,
 *   causing `compileAsync`'s 10 ms poll to invoke `gl.getProgramParameter(deletedProgram, COMPLETION_STATUS_KHR)`
 *   (`84x GL_INVALID_VALUE: glGetProgramiv: Program object expected.`) and hang forever when it returns `null`!
 * - Pauses timeout countdown and yields at `50 ms` while `document.visibilityState === 'hidden'`.
 * - Reports `needsDrawLink: true` when `KHR_parallel_shader_compile` is absent instead of faking completion.
 */
export async function safeCompileAsync(
  renderer: T.WebGLRenderer,
  targetRoot: T.Object3D,
  camera: T.Camera,
  targetScene: T.Scene,
  options: SafeCompileAsyncOptions = {},
): Promise<SafeCompileAsyncResult> {
  const isAborted = () => Boolean(options.aborted?.() || options.signal?.aborted);
  const gl = renderer.getContext();
  if (!gl || gl.isContextLost() || isAborted()) {
    return { compiled: 0, ready: 0, aborted: true, needsDrawLink: false };
  }

  inFlightSafeCompiles++;
  try {
    const materials = renderer.compile(targetRoot, camera, targetScene) as Set<T.Material>;
    const total = materials ? materials.size : 0;
    if (total === 0) {
      options.onProgress?.(0, 0);
      return { compiled: 0, ready: 0, aborted: false, needsDrawLink: false };
    }

    const extFromGl = typeof gl.getExtension === 'function' ? gl.getExtension('KHR_parallel_shader_compile') : null;
    const hasParallel = Boolean(extFromGl ?? renderer.extensions.get('KHR_parallel_shader_compile'));
    const props = (renderer as unknown as { properties?: ThreeRendererPropertiesLike }).properties;

    if (!hasParallel || !props) {
      // Do NOT falsely report `ready: total` when KHR_parallel_shader_compile is absent:
      // signal `needsDrawLink: true` so Stage 6 performs batched 1x1 draw-linking behind the overlay!
      await yieldPollStep(0);
      options.onProgress?.(0, total);
      return { compiled: total, ready: 0, aborted: isAborted(), needsDrawLink: true };
    }

    const pending = new Set<T.Material>(materials);
    const timeoutMs = options.timeoutMs ?? 15000;
    let visibleElapsedMs = 0;
    let lastTickMs = performance.now();
    let lastReportedReady = -1;

    while (pending.size > 0) {
      if (isAborted() || gl.isContextLost()) {
        return { compiled: total, ready: total - pending.size, aborted: true, needsDrawLink: false };
      }

      const now = performance.now();
      const hidden = isTabHidden();
      if (!hidden) {
        visibleElapsedMs += Math.max(0, Math.min(250, now - lastTickMs));
      }
      lastTickMs = now;

      for (const mat of pending) {
        const prog = props.get(mat)?.currentProgram;
        // Guard against disposed materials & destroyed WebGLPrograms BEFORE touching `isReady()`!
        if (!prog || !prog.program) {
          pending.delete(mat);
          continue;
        }
        if (typeof gl.isProgram === 'function' && !gl.isProgram(prog.program)) {
          pending.delete(mat);
          continue;
        }
        const status = prog.isReady?.();
        // Treat `true` (linked) OR `null` (context lost / driver invalidated) as terminal so we NEVER leak a timer!
        if (status === true || status === null) {
          pending.delete(mat);
        }
      }

      const readyNow = total - pending.size;
      if (readyNow !== lastReportedReady) {
        lastReportedReady = readyNow;
        options.onProgress?.(readyNow, total);
      }

      if (pending.size === 0) {
        return { compiled: total, ready: total, aborted: false, needsDrawLink: false };
      }
      if (timeoutMs > 0 && visibleElapsedMs >= timeoutMs) {
        return { compiled: total, ready: readyNow, aborted: false, needsDrawLink: false };
      }

      await yieldPollStep(hidden ? 50 : 10);
    }

    return { compiled: total, ready: total, aborted: false, needsDrawLink: false };
  } finally {
    inFlightSafeCompiles = Math.max(0, inFlightSafeCompiles - 1);
  }
}

// ── Zero-Allocation Scratch Math for Per-Frame Texel-Snapped Frustum Slicing ──────────────────────────────

const _sunDir = new T.Vector3();
const _camPos = new T.Vector3();
const _camForward = new T.Vector3();
const _up = new T.Vector3(0, 1, 0);
const _altUp = new T.Vector3(0, 0, 1);
const _origin = new T.Vector3(0, 0, 0);
const _lightMat = new T.Matrix4();
const _lightMatInv = new T.Matrix4();
const _centerWorld = new T.Vector3();
const _centerLight = new T.Vector3();
const _camLightScratch = new T.Vector3();
const _targetWorld = new T.Vector3();
const _savedViewport = new T.Vector4();
const _savedScissor = new T.Vector4();

const NPC_CASCADE_EXCLUDE_NAMES = new Set([
  'echo-life-people',
  'echo-life-shared-city',
  'echo-life-bicycle',
  'echo-life-room-bicycle',
  'echo-life-shared-court',
]);

/** Small props, grass, hedges, interiors, market goods & particles: cast shadows in C0 (0–22 m) ONLY, never in C1/C2. */
const C0_ONLY_CLUTTER_NAMES = new Set([
  'echo-life-grass-field',
  'echo-life-trimmed-hedges',
  'sunrise-market-stock',
  'building-interior',
  'house-interior',
  'house-woven-rugs',
  'house-curtains',
  'echo-life-weather-particles',
  'echo-life-tire-particles',
  'echo-life-river-water',
]);

const C0_ONLY_PREFIXES = [
  'street-prop:',
  'aaa-bld-prop:',
  'shop-aaa-prop:',
  'shop-display-',
  'stock:',
] as const;

/** Vegetation & curb vehicles cast shadows in C0 + C1, excluded from C2 far cascade (buildings & landmarks only). */
const C2_FAR_EXCLUDE_NAMES = new Set([
  'echo-life-vegetation-system',
  'echo-life-parked-curb-cars',
]);

function isC0OnlyPrefixedName(name: string): boolean {
  for (let i = 0; i < C0_ONLY_PREFIXES.length; i++) {
    if (name.startsWith(C0_ONLY_PREFIXES[i])) return true;
  }
  return false;
}

type ShadowMapWithRender = T.WebGLShadowMap & {
  render?: (lights: T.Light[], scene: T.Scene, camera: T.Camera) => void;
};

/**
 * Computes exact minimal enclosing sphere `(centerDistAlongForward, radius)` for a perspective camera
 * frustum slice `[near, far]`. Radius is 100% invariant to camera yaw/pitch/roll -> ZERO shadow swimming!
 */
function computeSliceBoundingSphere(
  fovDeg: number,
  aspect: number,
  near: number,
  far: number,
  safetyScale = 1.04,
): { dist: number; radius: number } {
  const halfTan = Math.tan(T.MathUtils.degToRad(fovDeg * 0.5));
  const k2 = halfTan * halfTan * (1 + aspect * aspect);
  const idealDist = 0.5 * (far + near) * (1 + k2);
  let dist: number;
  let radius: number;
  if (idealDist > far) {
    dist = far;
    radius = far * Math.sqrt(k2);
  } else {
    dist = idealDist;
    const dz = far - dist;
    radius = Math.sqrt(dz * dz + far * far * k2);
  }
  return { dist, radius: Math.max(2, radius * safetyScale) };
}

/**
 * 3-Cascade Texel-Snapped Cascaded Shadow Map Controller for Echo Life.
 *
 * Adopts the scene's existing primary `DirectionalLight` (`this.key`) as Cascade 0 and attaches up to 2
 * zero-intensity shadow-carrier `DirectionalLight`s (`lights[1]`, `lights[2]`) for Mid & Far cascades.
 */
export class EchoCsmSystem {
  readonly uniforms: SharedCsmUniforms;
  /** Cascade directional lights: `[0]` is primaryKey, `[1]` & `[2]` are shadow-only carriers. */
  readonly lights: readonly T.DirectionalLight[];

  private readonly scene: T.Scene;
  private readonly primaryKey: T.DirectionalLight;
  private readonly rawStudyShadowBias: number;
  private readonly rawStudyShadowNormalBias: number;
  private readonly studyRoomShadowBias: number;
  private readonly studyRoomShadowNormalBias: number;
  private readonly studyRoomShadowRadius: number;
  private readonly carriers: T.DirectionalLight[] = [];
  private tierValue: QualityTier;
  private gpuClassValue?: GpuClass;
  private cfg: EchoCsmConfig;
  private activeValue = false;
  private zoneModeValue: EchoCsmZoneMode = 'study-room';
  private disposed = false;

  private frameCounter = 0;
  private farCascadeUpdates = 0;
  private secondaryCascadeRenders = 0;
  private patchedCount = 0;
  private readonly lastSunDir = new T.Vector3(0, 1, 0);
  private readonly lastCascadeCamPos = [
    new T.Vector3(Infinity, 0, Infinity),
    new T.Vector3(Infinity, 0, Infinity),
    new T.Vector3(Infinity, 0, Infinity),
  ];
  private readonly cascadePendingRender = [false, false, false];
  private readonly cascadeRenderCounts = [0, 0, 0];
  private readonly hiddenScratch: T.Object3D[] = [];
  private readonly discoveredNpcs: T.Object3D[] = [];
  private readonly discoveredC0Only: T.Object3D[] = [];
  private readonly discoveredVeg: T.Object3D[] = [];
  private readonly primaryBatchScratch: T.Light[] = [];
  private readonly singleLightScratch: T.Light[] = [null as unknown as T.Light];
  private hookedRenderer: T.WebGLRenderer | null = null;
  private origShadowRender: ((lights: T.Light[], scene: T.Scene, camera: T.Camera) => void) | null = null;
  private activeExclusions: EchoCsmCascadeExclusions | null = null;
  private exclusionScanDirty = true;
  private lastDiscoverFrame = -999;
  private readonly patchedSet = new WeakSet<T.Material>();

  constructor(
    scene: T.Scene,
    primaryKey: T.DirectionalLight,
    initialTier: QualityTier = 'high',
    uniforms: SharedCsmUniforms = SHARED_CSM_UNIFORMS,
    gpuClass?: GpuClass,
  ) {
    this.scene = scene;
    this.primaryKey = primaryKey;
    // Preserve raw initial Study Room shadow tuning for dispose(), while ensuring normalBias >= 20 mm so
    // radius=3 Vogel-IGN PCF never self-shadows Study Room / Starter House walls at oblique sun angles.
    this.rawStudyShadowBias = primaryKey.shadow.bias;
    this.rawStudyShadowNormalBias = primaryKey.shadow.normalBias;
    this.studyRoomShadowBias = Math.min(primaryKey.shadow.bias, -0.00032);
    this.studyRoomShadowNormalBias = Math.max(primaryKey.shadow.normalBias, 0.020);
    this.studyRoomShadowRadius = primaryKey.shadow.radius;
    this.tierValue = initialTier;
    this.gpuClassValue = gpuClass;
    this.uniforms = uniforms;
    this.cfg = getCsmConfigForTier(initialTier, gpuClass);

    // Pre-allocate 2 shadow-carrier DirectionalLights (intensity = 0, color = black) so toggling zones
    // NEVER adds/removes scene lights or flips `NUM_DIR_LIGHTS` / `NUM_DIR_LIGHT_SHADOWS`!
    for (let i = 0; i < 2; i++) {
      const carrier = new T.DirectionalLight(0x000000, 0);
      carrier.name = `echo-csm-cascade-${i + 1}`;
      carrier.castShadow = false;
      carrier.visible = false;
      carrier.shadow.camera.near = 1;
      carrier.shadow.camera.far = 360;
      carrier.shadow.autoUpdate = false;
      carrier.shadow.needsUpdate = false;
      this.scene.add(carrier);
      this.scene.add(carrier.target);
      this.carriers.push(carrier);
    }

    this.lights = [this.primaryKey, this.carriers[0], this.carriers[1]];
    this.applyTierConfiguration(true);
  }

  get tier(): QualityTier {
    return this.tierValue;
  }

  get active(): boolean {
    return this.activeValue;
  }

  get zoneMode(): EchoCsmZoneMode {
    return this.zoneModeValue;
  }

  get config(): EchoCsmConfig {
    return this.cfg;
  }

  /**
   * Returns `true` when 0-cascade OR every active-tier cascade directional light (`[0..cascades-1]`)
   * already has an allocated GPU shadow render target (`light.shadow.map`), preventing secondary passes
   * (planar reflection / portal capture) from binding Three.js's `emptyShadowTexture` (`GL_INVALID_OPERATION`).
   */
  hasAllActiveShadowMaps(): boolean {
    if (this.disposed || this.cfg.cascades <= 0) return true;
    const count = Math.min(this.cfg.cascades, this.lights.length);
    for (let i = 0; i < count; i++) {
      const light = this.lights[i];
      if (!light || !light.shadow.map) return false;
    }
    return true;
  }

  get diagnostics(): EchoCsmDiagnostics {
    return {
      tier: this.tierValue,
      active: this.activeValue,
      zoneMode: this.zoneModeValue,
      cascades: this.activeValue ? this.cfg.cascades : 0,
      mapSize: this.cfg.mapSize,
      mapSizes: this.cfg.mapSizes,
      splits: this.cfg.splits,
      cadences: this.cfg.cadences,
      farCascadeUpdates: this.farCascadeUpdates,
      secondaryCascadeRenders: this.secondaryCascadeRenders,
      patchedMaterials: this.patchedCount,
      c1ExcludedNodes: this.discoveredNpcs.length + this.discoveredC0Only.length,
      c2ExcludedNodes: this.discoveredNpcs.length + this.discoveredC0Only.length + this.discoveredVeg.length,
    };
  }

  /** Switches active CSM tier (`low` / `balanced` / `high` / `ultra`) and optional 4 GB GPU clamp. */
  setTier(tier: QualityTier, gpuClass?: GpuClass): void {
    const nextGpuClass = gpuClass ?? this.gpuClassValue;
    if (this.disposed || (tier === this.tierValue && nextGpuClass === this.gpuClassValue)) return;
    this.tierValue = tier;
    this.gpuClassValue = nextGpuClass;
    this.cfg = getCsmConfigForTier(tier, nextGpuClass);
    this.resetCascadeSchedules();
    this.applyTierConfiguration(true);
  }

  /**
   * Switches between `'outdoor'` (multi-cascade CSM), `'study-room'` (single-light room shadow),
   * and `'city-interior'` (`uCsmEnabled = -1.0`, `primaryKey.shadow.intensity = 0.0`, zero stale outdoor
   * shadows on patched OR unpatched materials) WITHOUT EVER changing `carrier.visible`, `carrier.castShadow`,
   * or disposing `carrier.shadow.map` -> `NUM_DIR_LIGHTS` and `NUM_DIR_LIGHT_SHADOWS` stay 100% constant!
   */
  setZoneMode(mode: EchoCsmZoneMode): void {
    if (this.disposed) return;
    const nextActive = mode === 'outdoor';
    if (this.zoneModeValue === mode && this.activeValue === nextActive) return;
    this.zoneModeValue = mode;
    this.activeValue = nextActive;
    if (nextActive) {
      this.resetCascadeSchedules();
    }
    this.applyTierConfiguration(false);
  }

  /**
   * Backward-compatible wrapper around `setZoneMode()`:
   * `setActive(true)` -> `'outdoor'`, `setActive(false)` -> `'study-room'`.
   * NEVER hides active-tier carriers or disposes their `shadow.map`!
   */
  setActive(active: boolean): void {
    this.setZoneMode(active ? 'outdoor' : 'study-room');
  }

  /**
   * Marks all active-tier cascade shadow lights dirty (`shadow.needsUpdate = true`) and ensures every
   * active carrier has a valid initial ortho frustum so Stage-6 warmup allocates every `shadow.map`
   * (`depthTexture` with `LessEqualCompare`) and compiles all `MeshDepthMaterial` variants BEFORE unlock!
   */
  forceAllActiveCascadesDirty(
    focusWorldPos?: T.Vector3,
    sunDirTowardSun?: T.Vector3,
  ): void {
    if (this.disposed || this.cfg.cascades <= 0) return;
    const dir = _sunDir.copy(sunDirTowardSun ?? this.lastSunDir);
    if (dir.lengthSq() < 1e-6) dir.set(0.35, 0.72, -0.58);
    dir.normalize();
    if (dir.y < 0.20) dir.y = 0.20;
    dir.normalize();

    const focus = focusWorldPos ?? _origin;
    const count = Math.min(this.cfg.cascades, this.lights.length);
    for (let i = 0; i < count; i++) {
      const light = this.lights[i];
      if (!light) continue;
      if (i > 0) {
        const radius = this.cfg.splits[i] ?? (i === 1 ? 60 : 140);
        const pullback = Math.max(this.cfg.lightMargin, radius + 68);
        light.target.position.copy(focus);
        light.position.copy(focus).addScaledVector(dir, pullback);
        light.target.updateMatrixWorld();
        light.updateMatrixWorld();
        const cam = light.shadow.camera;
        cam.left = -radius;
        cam.right = radius;
        cam.top = radius;
        cam.bottom = -radius;
        cam.near = 1;
        cam.far = pullback + radius + 55;
        cam.updateProjectionMatrix();
      }
      light.shadow.needsUpdate = true;
    }
  }

  private resetCascadeSchedules(): void {
    for (let i = 0; i < 3; i++) {
      this.cascadeRenderCounts[i] = 0;
      this.cascadePendingRender[i] = false;
      this.lastCascadeCamPos[i].set(Infinity, 0, Infinity);
    }
  }

  /** Chains CSM onto a single material cleanly (idempotent). */
  patchMaterial(material: T.Material): void {
    if (this.patchedSet.has(material)) return;
    if (!isCsmCompatibleMaterial(material)) return;
    patchMaterialWithEchoCsm(material, this.uniforms);
    this.patchedSet.add(material);
    this.patchedCount++;
  }

  /** Traverses a subtree (`world.group`, streamed chunk, GLB, character) and chains CSM onto all PBR materials. */
  patchObject(root: T.Object3D): number {
    let added = 0;
    root.traverse((node) => {
      const mesh = node as T.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (let i = 0; i < mats.length; i++) {
        const mat = mats[i];
        if (!mat || this.patchedSet.has(mat) || !isCsmCompatibleMaterial(mat)) continue;
        patchMaterialWithEchoCsm(mat, this.uniforms);
        this.patchedSet.add(mat);
        this.patchedCount++;
        added++;
      }
    });
    if (added > 0) this.exclusionScanDirty = true;
    return added;
  }

  /**
   * Updates all active cascade frustums (rotation-invariant sphere radius + light-space texel snapping)
   * and staggered far-cascade update cadence. Call once per frame outdoors BEFORE rendering.
   *
   * @param camera Active perspective (or orthographic) camera.
   * @param sunDirTowardSun Unit direction vector pointing FROM ground TOWARD the sun/moon light source.
   * @param anchorWorldPos Optional fallback world anchor (used if camera is orthographic).
   */
  update(camera: T.Camera, sunDirTowardSun: T.Vector3, anchorWorldPos?: T.Vector3): void {
    if (this.disposed || !this.activeValue || this.cfg.cascades <= 0) {
      this.uniforms.uCsmEnabled.value = this.zoneModeValue === 'city-interior' ? -1 : 0;
      return;
    }

    const cascades = this.cfg.cascades;
    const splits = this.cfg.splits;

    // Normalize sun direction and enforce a >= 11.5° shadow elevation floor so low-angle twilight shadows
    // stay long & dramatic without clipping tall skyline/park trees against the shadow near plane.
    _sunDir.copy(sunDirTowardSun);
    if (_sunDir.lengthSq() < 1e-6) _sunDir.set(0.35, 0.72, -0.58);
    _sunDir.normalize();
    if (_sunDir.y < 0.20) {
      const minY = 0.20;
      const hLen = Math.hypot(_sunDir.x, _sunDir.z);
      const hScale = hLen > 1e-4 ? Math.sqrt(1 - minY * minY) / hLen : 0;
      _sunDir.set(_sunDir.x * hScale, minY, _sunDir.z * hScale);
    }

    const sunChanged = _sunDir.dot(this.lastSunDir) < 0.99996; // > ~0.5° shift forces immediate cascade refresh

    camera.updateMatrixWorld();
    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_camForward).normalize();

    this.frameCounter++;

    // Build stable light-space basis looking along -_sunDir (from sun toward scene).
    const upRef = Math.abs(_sunDir.y) > 0.98 ? _altUp : _up;
    _lightMat.lookAt(_sunDir, _origin, upRef);
    _lightMatInv.copy(_lightMat).invert();

    const perspCam = (camera as T.PerspectiveCamera).isPerspectiveCamera ? (camera as T.PerspectiveCamera) : null;
    const isPersp = perspCam !== null;
    const fov = perspCam ? perspCam.fov : 55;
    const aspect = perspCam ? Math.max(0.5, perspCam.aspect) : 1.7778;
    const camNear = perspCam ? Math.max(0.1, perspCam.near) : 0.2;

    const s0 = splits[0] ?? 22;
    const s1 = splits[1] ?? s0 * 2.8;
    const s2 = splits[2] ?? s1 * 2.4;
    this.uniforms.uCsmSplits.value.set(s0, s1, s2, this.cfg.fadeFraction);
    this.uniforms.uCsmEnabled.value = cascades;

    for (let i = 0; i < cascades; i++) {
      const light = this.lights[i];
      if (!light) continue;

      const cMapSize = this.cfg.mapSizes[i] ?? this.cfg.mapSize;
      const cadence = this.cfg.cadences[i] ?? (i === cascades - 1 ? this.cfg.farCadence : 1);
      // Stagger C1 (even frames: frame % 2 === 0) and C2 (odd frames: frame % 4 === 1) so C1 & C2 NEVER collide!
      const phaseOffset = i === 2 ? 1 : 0;
      const camJumpSq = i === 0 ? 16 : i === 1 ? 64 : 144;
      const camJumped = _camPos.distanceToSquared(this.lastCascadeCamPos[i]) > camJumpSq;
      const isFirst = this.cascadeRenderCounts[i] === 0 || !light.shadow.map;

      if (cadence > 1) {
        const shouldRefresh =
          isFirst || sunChanged || camJumped || ((this.frameCounter % cadence) === phaseOffset);
        light.shadow.autoUpdate = false;
        light.shadow.needsUpdate = shouldRefresh;
        this.cascadePendingRender[i] = shouldRefresh;
        if (!shouldRefresh) continue;
        this.lastCascadeCamPos[i].copy(_camPos);
      } else {
        light.shadow.autoUpdate = true;
        light.shadow.needsUpdate = true;
        this.cascadePendingRender[i] = true;
        this.lastCascadeCamPos[i].copy(_camPos);
      }

      const sliceNear = i === 0 ? camNear : (splits[i - 1] ?? camNear) * 0.90; // 10% overlap for seamless blend
      const sliceFar = splits[i] ?? 60;

      let radius: number;
      let sphereDist = 0;
      if (isPersp) {
        const sphere = computeSliceBoundingSphere(fov, aspect, sliceNear, sliceFar);
        // Quantize bounding-sphere radius to 0.25 m steps so aspect/FOV float jitter never perturbs texelSize.
        radius = Math.ceil(sphere.radius * 4) * 0.25;
        sphereDist = sphere.dist;
        _centerWorld.copy(_camPos).addScaledVector(_camForward, sphereDist);
      } else {
        radius = Math.ceil(sliceFar * 4) * 0.25;
        _centerWorld.copy(anchorWorldPos ?? _camPos);
      }

      // Snap frustum XY to exact per-cascade shadow-map texel grid in world-fixed light basis, AND anchor
      // light-space Z strictly to quantized camera position (independent of `_camForward`!) so rotating the
      // camera in place produces 0.000000 Z-shift in `directionalShadowMatrix` (ZERO shadow swimming!).
      const texelSize = (2 * radius) / Math.max(256, cMapSize);
      _centerLight.copy(_centerWorld).applyMatrix4(_lightMatInv);
      _centerLight.x = Math.floor(_centerLight.x / texelSize) * texelSize;
      _centerLight.y = Math.floor(_centerLight.y / texelSize) * texelSize;
      _camLightScratch.copy(_camPos).applyMatrix4(_lightMatInv);
      _centerLight.z = Math.round(_camLightScratch.z * 2) * 0.5;
      _targetWorld.copy(_centerLight).applyMatrix4(_lightMat);

      const zReach = radius + sphereDist;
      const pullback = Math.max(this.cfg.lightMargin, zReach + 68);
      light.target.position.copy(_targetWorld);
      light.position.copy(_targetWorld).addScaledVector(_sunDir, pullback);
      light.target.updateMatrixWorld();
      light.updateMatrixWorld();

      const cam = light.shadow.camera;
      const farTarget = pullback + zReach + 55;
      const needProj =
        Math.abs(cam.right - radius) > 0.05 ||
        Math.abs(cam.far - farTarget) > 1.0;
      if (needProj) {
        cam.left = -radius;
        cam.right = radius;
        cam.top = radius;
        cam.bottom = -radius;
        cam.near = 1;
        cam.far = farTarget;
        cam.updateProjectionMatrix();
      }
      const depthSpan = Math.max(10, cam.far - cam.near);
      const slopeRatio = texelSize / depthSpan;
      if (i === 0) this.uniforms.uCsmSlopeScale.value.x = slopeRatio;
      else if (i === 1) this.uniforms.uCsmSlopeScale.value.y = slopeRatio;
      else if (i === 2) this.uniforms.uCsmSlopeScale.value.z = slopeRatio;
    }

    if (sunChanged) {
      this.lastSunDir.copy(_sunDir);
    }
  }

  /**
   * Arms per-cascade shadow exclusions for C1 & C2 inside Three.js r186's `WebGLShadowMap.render()`
   * (where `currentRenderState` is live & valid — zero external `shadowMap.render()` crashes!).
   * - C0 (`primaryKey`, 0–22 m): full scene (NPCs, player, grass, hedges, street/building clutter, trees, buildings).
   * - C1 (`carriers[0]`, 22–60 m): excludes NPCs, player, grass, hedges, market stock, interiors & small clutter props.
   * - C2 (`carriers[1]`, 60–140 m): excludes all C1 items PLUS vegetation & parked curb cars (buildings & landmarks only).
   */
  renderSecondaryCascades(
    renderer: T.WebGLRenderer,
    scene: T.Scene,
    _camera: T.Camera,
    exclusions?: EchoCsmCascadeExclusions,
  ): number {
    if (this.disposed || !this.activeValue || this.cfg.cascades <= 0) {
      this.activeExclusions = null;
      return 0;
    }
    this.installShadowHook(renderer);
    if (this.cfg.cascades <= 1) {
      this.activeExclusions = null;
      return 0;
    }
    this.activeExclusions = exclusions ?? null;
    this.refreshAutoExclusions(scene);
    let due = 0;
    for (let i = 1; i < this.cfg.cascades; i++) {
      const light = this.lights[i];
      if (light && light.visible && light.castShadow && (light.shadow.autoUpdate || light.shadow.needsUpdate)) {
        due++;
      }
    }
    return due;
  }

  private hideNodes(nodes?: readonly (T.Object3D | null | undefined)[]): void {
    if (!nodes) return;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node || !node.visible) continue;
      node.visible = false;
      this.hiddenScratch.push(node);
    }
  }

  private restoreHidden(): void {
    for (let i = this.hiddenScratch.length - 1; i >= 0; i--) {
      this.hiddenScratch[i].visible = true;
    }
    this.hiddenScratch.length = 0;
  }

  private installShadowHook(renderer: T.WebGLRenderer): void {
    if (this.hookedRenderer === renderer) return;
    this.uninstallShadowHook();
    const sm = renderer.shadowMap as ShadowMapWithRender;
    if (typeof sm.render !== 'function') return;
    const orig = sm.render.bind(sm);
    this.hookedRenderer = renderer;
    this.origShadowRender = sm.render;

    sm.render = (lights: T.Light[], scene: T.Scene, camera: T.Camera) => {
      if (
        this.disposed ||
        !this.activeValue ||
        this.cfg.cascades <= 0 ||
        scene !== this.scene ||
        !sm.enabled ||
        (sm.autoUpdate === false && sm.needsUpdate === false) ||
        lights.length === 0
      ) {
        orig(lights, scene, camera);
        return;
      }

      if (this.cfg.cascades === 1) {
        const c0WasDue =
          lights.includes(this.primaryKey) &&
          (this.primaryKey.shadow.autoUpdate || this.primaryKey.shadow.needsUpdate);
        orig(lights, scene, camera);
        if (c0WasDue && this.primaryKey.shadow.map) {
          this.cascadeRenderCounts[0]++;
          this.farCascadeUpdates++;
        }
        return;
      }

      const c1Carrier = this.carriers[0];
      const c2Carrier = this.carriers[1];
      let c1Due: T.DirectionalLight | null = null;
      let c2Due: T.DirectionalLight | null = null;
      let c0Due = false;
      const primary = this.primaryBatchScratch;
      primary.length = 0;

      for (let i = 0; i < lights.length; i++) {
        const l = lights[i];
        if (c1Carrier && l === c1Carrier) {
          if (c1Carrier.shadow.autoUpdate || c1Carrier.shadow.needsUpdate) c1Due = c1Carrier;
        } else if (c2Carrier && l === c2Carrier) {
          if (c2Carrier.shadow.autoUpdate || c2Carrier.shadow.needsUpdate) c2Due = c2Carrier;
        } else {
          if (l === this.primaryKey && (this.primaryKey.shadow.autoUpdate || this.primaryKey.shadow.needsUpdate)) {
            c0Due = true;
          }
          primary.push(l);
        }
      }

      if (!c1Due && !c2Due) {
        orig(lights, scene, camera);
        if (c0Due && this.primaryKey.shadow.map) {
          this.cascadeRenderCounts[0]++;
        }
        primary.length = 0;
        return;
      }

      const savedNeedsUpdate = sm.needsUpdate;
      const savedAutoUpdate = sm.autoUpdate;

      if (primary.length > 0) {
        orig(primary, scene, camera);
        if (c0Due && this.primaryKey.shadow.map) {
          this.cascadeRenderCounts[0]++;
        }
      }
      primary.length = 0;

      this.refreshAutoExclusions(scene);
      const savedCamMask = camera.layers.mask;

      if (c1Due) {
        if (!savedAutoUpdate) sm.needsUpdate = savedNeedsUpdate;
        this.hiddenScratch.length = 0;
        try {
          this.hideNodes(this.activeExclusions?.npcs);
          this.hideNodes(this.activeExclusions?.dynamicProps);
          this.hideNodes(this.discoveredNpcs);
          this.hideNodes(this.discoveredC0Only);
          camera.layers.disable(ECHO_CSM_LAYER_C0_ONLY);
          this.singleLightScratch[0] = c1Due;
          orig(this.singleLightScratch, scene, camera);
          if (c1Due.shadow.map) {
            this.cascadeRenderCounts[1]++;
            if (this.cfg.cascades === 2) this.farCascadeUpdates++;
          }
          this.secondaryCascadeRenders++;
        } finally {
          camera.layers.mask = savedCamMask;
          this.restoreHidden();
          this.singleLightScratch[0] = null as unknown as T.Light;
        }
      }

      if (c2Due) {
        if (!savedAutoUpdate) sm.needsUpdate = savedNeedsUpdate;
        this.hiddenScratch.length = 0;
        try {
          this.hideNodes(this.activeExclusions?.npcs);
          this.hideNodes(this.activeExclusions?.dynamicProps);
          this.hideNodes(this.activeExclusions?.vegetation);
          this.hideNodes(this.discoveredNpcs);
          this.hideNodes(this.discoveredC0Only);
          this.hideNodes(this.discoveredVeg);
          camera.layers.disable(ECHO_CSM_LAYER_C0_ONLY);
          this.singleLightScratch[0] = c2Due;
          orig(this.singleLightScratch, scene, camera);
          if (c2Due.shadow.map) {
            this.cascadeRenderCounts[2]++;
            this.farCascadeUpdates++;
          }
          this.secondaryCascadeRenders++;
        } finally {
          camera.layers.mask = savedCamMask;
          this.restoreHidden();
          this.singleLightScratch[0] = null as unknown as T.Light;
        }
      }
    };
  }

  private uninstallShadowHook(): void {
    if (this.hookedRenderer && this.origShadowRender) {
      (this.hookedRenderer.shadowMap as ShadowMapWithRender).render = this.origShadowRender;
    }
    this.hookedRenderer = null;
    this.origShadowRender = null;
    this.activeExclusions = null;
  }

  private refreshAutoExclusions(scene: T.Scene): void {
    // Re-scan scene hierarchy every ~45 frames, when new streamed objects patch in, or if any cached node detached.
    let stale = this.exclusionScanDirty || this.frameCounter - this.lastDiscoverFrame >= 45 || (this.discoveredNpcs.length === 0 && this.discoveredC0Only.length === 0);
    if (!stale) {
      for (let i = 0; i < this.discoveredNpcs.length; i++) {
        if (!this.discoveredNpcs[i].parent) { stale = true; break; }
      }
    }
    if (!stale) {
      for (let i = 0; i < this.discoveredC0Only.length; i++) {
        if (!this.discoveredC0Only[i].parent) { stale = true; break; }
      }
    }
    if (!stale) return;

    this.exclusionScanDirty = false;
    this.lastDiscoverFrame = this.frameCounter;
    this.discoveredNpcs.length = 0;
    this.discoveredC0Only.length = 0;
    this.discoveredVeg.length = 0;

    const c0LayerBit = 1 << ECHO_CSM_LAYER_C0_ONLY;
    const visit = (node: T.Object3D, depth: number) => {
      const name = node.name;
      if (name && NPC_CASCADE_EXCLUDE_NAMES.has(name)) {
        this.discoveredNpcs.push(node);
        return;
      }
      if (
        (name && (C0_ONLY_CLUTTER_NAMES.has(name) || isC0OnlyPrefixedName(name))) ||
        node.userData?.__echoCsmC0Only === true ||
        (node.layers.mask & c0LayerBit) !== 0
      ) {
        this.discoveredC0Only.push(node);
        return;
      }
      if (name && C2_FAR_EXCLUDE_NAMES.has(name)) {
        this.discoveredVeg.push(node);
        return;
      }
      if (depth >= 7) return;
      const ch = node.children;
      if (ch.length === 0) return;
      for (let i = 0; i < ch.length; i++) {
        visit(ch[i], depth + 1);
      }
    };
    visit(scene, 0);
  }

  private applyTierConfiguration(tierChanged: boolean): void {
    const tierCascades = this.cfg.cascades;
    const isOutdoor = this.zoneModeValue === 'outdoor';
    const isCityInterior = this.zoneModeValue === 'city-interior';
    const c0Size = this.cfg.mapSizes[0] ?? this.cfg.mapSize;

    // 1. Primary Key (Cascade 0): keep `castShadow` and `mapSize` constant for the active tier across ALL zones!
    if (tierCascades >= 1 && c0Size > 0) {
      this.primaryKey.castShadow = true;
      if (tierChanged || isOutdoor) {
        this.ensureLightShadowMapSize(this.primaryKey, c0Size);
      }
      if (isOutdoor) {
        this.applyCascadeShadowTuning(this.primaryKey, 0);
        this.primaryKey.shadow.intensity = 1.0;
        const c0Cadence = this.cfg.cadences[0] ?? 1;
        this.primaryKey.shadow.autoUpdate = c0Cadence <= 1;
        this.primaryKey.shadow.needsUpdate = true;
      } else if (isCityInterior) {
        // City Interiors / CAZ Studio: keep castShadow=true & shadow.map allocated, zero shadowIntensity so
        // BOTH patched (uCsmEnabled=-1) and any unpatched material receive zero stale outdoor shadow darkening!
        this.primaryKey.shadow.intensity = 0.0;
        this.primaryKey.shadow.autoUpdate = false;
        this.primaryKey.shadow.needsUpdate = false;
      } else {
        // Study Room / Overview / Starter House: calibrated room bias/normalBias/radius & slope ratio!
        this.primaryKey.shadow.bias = this.studyRoomShadowBias;
        this.primaryKey.shadow.normalBias = this.studyRoomShadowNormalBias;
        this.primaryKey.shadow.radius = this.studyRoomShadowRadius;
        this.primaryKey.shadow.intensity = 1.0;
        this.primaryKey.shadow.autoUpdate = true;
        this.primaryKey.shadow.needsUpdate = true;
        const rCam = this.primaryKey.shadow.camera;
        const rWidth = Math.max(8, rCam.right - rCam.left);
        const rSpan = Math.max(10, rCam.far - rCam.near);
        this.uniforms.uCsmSlopeScale.value.w = (rWidth / Math.max(512, c0Size)) / rSpan;
      }
    } else {
      // Low tier (0 cascades): preserve Study Room bias calibration & keep shadow intensity clean.
      if (!isOutdoor && !isCityInterior) {
        this.primaryKey.shadow.bias = this.studyRoomShadowBias;
        this.primaryKey.shadow.normalBias = this.studyRoomShadowNormalBias;
        this.primaryKey.shadow.radius = this.studyRoomShadowRadius;
      }
      this.primaryKey.shadow.intensity = isCityInterior ? 0.0 : 1.0;
      this.primaryKey.shadow.autoUpdate = !isCityInterior;
      this.primaryKey.shadow.needsUpdate = false;
    }

    // 2. Shadow-Carrier Cascades 1 & 2:
    //    `visible` & `castShadow` depend STRICTLY on `tierCascades` (per-session constant), NEVER on
    //    `zoneMode`! Indoors, carriers simply pause updates (`autoUpdate=false, needsUpdate=false`) while
    //    keeping `shadow.map` allocated -> ZERO `NUM_DIR_LIGHTS` / `NUM_DIR_LIGHT_SHADOWS` shader recompiles
    //    and ZERO `emptyShadowTexture` `GL_INVALID_OPERATION` traps!
    for (let c = 0; c < this.carriers.length; c++) {
      const idx = c + 1;
      const carrier = this.carriers[c];
      const cMapSize = this.cfg.mapSizes[idx] ?? this.cfg.mapSize;
      const activeForTier = tierCascades > idx && cMapSize > 0;

      carrier.visible = activeForTier;
      carrier.castShadow = activeForTier;
      carrier.intensity = 0;
      carrier.color.setHex(0x000000);

      if (activeForTier) {
        this.configureLightShadow(carrier, idx, cMapSize);
        if (isOutdoor) {
          const cCadence = this.cfg.cadences[idx] ?? 2;
          carrier.shadow.autoUpdate = cCadence <= 1;
          carrier.shadow.needsUpdate = true;
        } else {
          // Pause cascade shadow rendering indoors while preserving `carrier.shadow.map`
          // (allowing a newly allocated shadow map to run ONCE so WebGL2 initializes its DepthTexture).
          carrier.shadow.autoUpdate = false;
          const pendingInit = Boolean((carrier.shadow.map as { __ecInitPending?: boolean } | null)?.__ecInitPending);
          if (pendingInit && carrier.shadow.map) {
            (carrier.shadow.map as { __ecInitPending?: boolean }).__ecInitPending = false;
            carrier.shadow.needsUpdate = true;
          } else {
            carrier.shadow.needsUpdate = false;
          }
        }
      } else {
        carrier.shadow.autoUpdate = false;
        carrier.shadow.needsUpdate = false;
        if (tierChanged && carrier.shadow.map) {
          carrier.shadow.map.dispose();
          carrier.shadow.map = null as unknown as T.WebGLRenderTarget;
        }
      }
    }

    // 3. Drive 5-mode `uCsmEnabled` uniform (-1 = City Interior, 0 = Study Room, 1..3 = Outdoor Cascades).
    if (isCityInterior) {
      this.uniforms.uCsmEnabled.value = -1;
    } else if (isOutdoor && tierCascades > 0) {
      this.uniforms.uCsmEnabled.value = tierCascades;
      const s0 = this.cfg.splits[0] ?? 22;
      const s1 = this.cfg.splits[1] ?? s0 * 2.8;
      const s2 = this.cfg.splits[2] ?? s1 * 2.4;
      this.uniforms.uCsmSplits.value.set(s0, s1, s2, this.cfg.fadeFraction);
    } else {
      this.uniforms.uCsmEnabled.value = 0;
    }
  }

  private ensureLightShadowMapSize(light: T.DirectionalLight, mapSize: number): void {
    if (light.shadow.mapSize.x !== mapSize || light.shadow.mapSize.y !== mapSize) {
      light.shadow.mapSize.set(mapSize, mapSize);
      if (light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null as unknown as T.WebGLRenderTarget;
      }
    }
    if (!light.shadow.map && mapSize > 0 && light.castShadow) {
      const depthTexture = new T.DepthTexture(mapSize, mapSize);
      depthTexture.compareFunction = T.LessEqualCompare;
      depthTexture.name = `${light.name || 'csm'}.shadowDepth`;
      const map = new T.WebGLRenderTarget(mapSize, mapSize, {
        minFilter: T.NearestFilter,
        magFilter: T.NearestFilter,
        type: T.UnsignedByteType,
        depthTexture,
      });
      map.texture.name = `${light.name || 'csm'}.shadowMap`;
      map.texture.generateMipmaps = false;
      (map as unknown as { __ecInitPending?: boolean }).__ecInitPending = true;
      light.shadow.map = map;
      light.shadow.needsUpdate = true;
    }
  }

  private applyCascadeShadowTuning(light: T.DirectionalLight, cascadeIndex: number): void {
    light.shadow.bias = this.cfg.shadowBiases[cascadeIndex] ?? -0.00035;
    light.shadow.normalBias = this.cfg.shadowNormalBiases[cascadeIndex] ?? 0.025;
    light.shadow.radius = this.cfg.shadowRadii[cascadeIndex] ?? 1.7;
  }

  private configureLightShadow(light: T.DirectionalLight, cascadeIndex: number, mapSize: number): void {
    this.ensureLightShadowMapSize(light, mapSize);
    this.applyCascadeShadowTuning(light, cascadeIndex);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeValue = false;
    this.uninstallShadowHook();
    this.uniforms.uCsmEnabled.value = 0;
    this.primaryKey.shadow.bias = this.rawStudyShadowBias;
    this.primaryKey.shadow.normalBias = this.rawStudyShadowNormalBias;
    this.primaryKey.shadow.radius = this.studyRoomShadowRadius;
    this.primaryKey.shadow.intensity = 1.0;
    this.primaryKey.shadow.autoUpdate = true;
    this.discoveredNpcs.length = 0;
    this.discoveredC0Only.length = 0;
    this.discoveredVeg.length = 0;
    this.primaryBatchScratch.length = 0;
    this.hiddenScratch.length = 0;

    for (const carrier of this.carriers) {
      carrier.castShadow = false;
      carrier.visible = false;
      if (carrier.shadow.map) {
        carrier.shadow.map.dispose();
        carrier.shadow.map = null as unknown as T.WebGLRenderTarget;
      }
      this.scene.remove(carrier.target);
      this.scene.remove(carrier);
    }
    this.carriers.length = 0;
  }
}
