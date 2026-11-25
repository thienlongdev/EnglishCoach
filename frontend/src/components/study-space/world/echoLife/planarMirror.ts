import * as T from 'three';
import type { Prepared } from './assets';
import { patchHeightFog } from './atmosphere';
import { patchMaterialWithEchoCsm } from './echoCsm';
import type { QualityTier } from './renderConfig';

/**
 * Echo Life / StudySpace — Single-Renderer True Geometric Planar Mirror System (`PlanarMirrorSystem`).
 *
 * Architectural & Zero-Hitch Invariants:
 * 1. Single `THREE.WebGLRenderer` & single `<canvas>`: renders at most ONE active visible front-facing
 *    planar mirror per frame into a pre-allocated adaptive `HalfFloatType` (`LinearSRGBColorSpace`) FBO.
 * 2. Exact Householder camera reflection across world plane `(P_0, n_hat)` with `Object3D.lookAt()`
 *    (`det(reflCam.matrixWorld) === +1`): preserves hardware `gl.CCW` winding, normal maps, tangent `w`
 *    handedness, and `gl_FrontFacing` across skin/hair/cloth while projective UV mapping reverses
 *    horizontal chirality identically to a physical silvered mirror at every yaw, pitch, and roll.
 * 3. Eric Lengyel oblique near-plane matrix replacement on row 2 of `reflCam.projectionMatrix`:
 *    hardware-clips walls & `Halo_Glow` frames behind the mirror with `renderer.clippingPlanes.length === 0`
 *    (`NUM_CLIPPING_PLANES = 0` -> ZERO scene-material shader variant proliferation).
 * 4. Atomic 1P/3P avatar embodiment swap: temporarily restores `character.root.visible = true`,
 *    `character.setOwnView(false)` (`Cast_Face`, `Cast_Eyes`, `Cast_Hair`, modular hair/hats/glasses
 *    `colorWrite = true`), and clears `:ec-1p-limb-guard-v1` (`uOwnLimbGuardActive = 0`) during the
 *    reflection pass, restoring every flag in `finally`.
 * 5. Shared single `T.ShaderMaterial` (`customProgramCacheKey: () => 'echo-planar-mirror-v1'`) +
 *    Stage-6 `1x1` scissored `warmup()` -> `programDelta === 0` and `0` frame spikes on room entry.
 */

export const PLANAR_MIRROR_CACHE_KEY = 'echo-planar-mirror-v1';

/** Default `'mirror'` (`mirror-28a344987713.glb`) reflective front surface in `Prepared` asset space. */
export const DEFAULT_MIRROR_LOCAL_GLASS = Object.freeze({
  width: 0.74,
  height: 0.90,
  center: Object.freeze([0, 0.47, 0.0292] as const),
  normal: Object.freeze([0, 0, 1] as const),
});

const MIRROR_SCALE_BY_TIER: Readonly<Record<QualityTier, number>> = Object.freeze({
  low: 0.50,
  balanced: 0.50,
  high: 0.60,
  ultra: 0.75,
});

const MIRROR_MAX_RES_BY_TIER: Readonly<Record<QualityTier, readonly [number, number]>> = Object.freeze({
  low: Object.freeze([768, 432] as const),
  balanced: Object.freeze([960, 540] as const),
  high: Object.freeze([1280, 720] as const),
  ultra: Object.freeze([1440, 810] as const),
});

const MIRROR_MAX_DIST_BY_TIER: Readonly<Record<QualityTier, number>> = Object.freeze({
  low: 4.8,
  balanced: 6.5,
  high: 8.0,
  ultra: 9.0,
});

const PLAYER_OBSERVE_MAX_DIST_M = 4.5;
const OBLIQUE_CLIP_BIAS = 0.002;
const MIN_FRONT_DIST_M = 0.02;

export interface MirrorLocalGlassSpec {
  readonly width: number;
  readonly height: number;
  readonly center: readonly [number, number, number];
  readonly normal?: readonly [number, number, number];
}

export interface AttachMirrorSurfaceOptions {
  /** Stable unique mirror identifier (e.g. `'house:bath:mirror:0'` or `'bld:clothing_shop:mirror:0'`). */
  readonly id: string;
  /** Zone or building identifier (`'bath'`, `'bedroom'`, `'clothing_shop'`, etc.) for `clearZone()` and steam hooks. */
  readonly zoneId: string;
  /** Parent container (`furnishings` in `house.ts`, `contents` in `buildingsView.ts`) whose ancestor visibility gates this mirror. */
  readonly parent: T.Object3D;
  /** Placement transform from `placeOn(prepared, f.x, f.y, f.z, f.rotY, scale)`. */
  readonly placementMatrix: T.Matrix4;
  /** Optional `Prepared` `'mirror'` asset; automatically mounts the dark brushed-silver bevel backing (`Cube.001`) and extracts exact glass bounds. */
  readonly prepared?: Prepared | null;
  /** Optional pre-created backing mesh (`role === 'mirror-glass'`) to restyle as dark brushed-silver bevel backing instead of spawning a new mesh. */
  readonly backingMesh?: T.Mesh | null;
  /** Optional explicit local mirror rectangle override in `Prepared` asset space. */
  readonly localGlass?: MirrorLocalGlassSpec;
  /** Whether indoor portal culling should temporarily un-hide exterior street/sky during reflection (true for windowed storefronts like `clothing_shop`, false for windowless `bath`). */
  readonly restoreExteriorPortals?: boolean;
}

export type RegisterMirrorOptions = AttachMirrorSurfaceOptions;

export interface MirrorSurfaceHandle {
  readonly id: string;
  readonly zoneId: string;
  readonly glassMesh: T.Mesh;
  readonly backingMesh: T.Mesh | null;
  dispose(): void;
}

export interface MirrorCharacterLike {
  readonly ready?: boolean;
  readonly root: T.Object3D;
  readonly isOwnView?: boolean;
  setOwnView(own: boolean): void;
  setMirrorObserved?(active: boolean): void;
}

export interface PrepareMirrorReflectionContext {
  readonly renderer: T.WebGLRenderer;
  readonly scene: T.Scene;
  readonly camera: T.Camera;
  readonly qualityTier?: QualityTier;
  /** Guard ensuring all active shadow maps are allocated before reflection renders (`!shadowMap.enabled || echoCsm.hasAllActiveShadowMaps()`). Default `true`. */
  readonly canRenderReflection?: boolean;
  /** True when player is actively in 1P/3P exploration (false in room overview or CAZ studio). Default `true`. */
  readonly explorationActive?: boolean;
  /** True when player is driving a vehicle (leaves avatar vehicle visibility untouched). Default `false`. */
  readonly driving?: boolean;
  /** Player `Character` instance so 1P head/hair/face (`setOwnView(false)`) and tight-boom 3P `root.visible` are restored during reflection. */
  readonly character?: MirrorCharacterLike | null;
  /** Clears `:ec-1p-limb-guard-v1` (`uOwnLimbGuardActive = 0`) so chest/collar/lapels are never discarded in the mirror. */
  readonly clearOwnLimbGuard?: () => void;
  /** Restores `:ec-1p-limb-guard-v1` after the mirror pass. */
  readonly restoreOwnLimbGuard?: () => void;
  /** Optional exterior groups (`world.cityView.group`, `world.house.exteriorGroup`, `world.streamer.group`) hidden by main-camera portal culling to restore when an indoor mirror reflects windows/doors behind the player. */
  readonly exteriorPortalGroups?: readonly (T.Object3D | null | undefined)[];
  /** Optional extra meshes/groups to hide during mirror reflection. */
  readonly excludeObjects?: readonly (T.Object3D | null | undefined)[];
}

export interface PrepareMirrorReflectionResult {
  readonly active: boolean;
  readonly renderedThisFrame: boolean;
  readonly activeMirrorId: string | null;
  readonly distanceM: number;
  /** True when the player is within `<= 4.5 m` in front of a visible mirror (`character.setMirrorObserved`). */
  readonly isObservingPlayer: boolean;
  readonly skippedReason: string | null;
}

export interface PlanarMirrorDiagnostics {
  readonly registeredMirrors: number;
  readonly activeMirrorId: string | null;
  readonly rtWidth: number;
  readonly rtHeight: number;
  readonly allocatedVramBytes: number;
  readonly lastRenderedFrame: number;
  readonly lastSkippedReason: string | null;
  readonly isObservingPlayer: boolean;
}

interface MirrorEntry {
  readonly id: string;
  readonly zoneId: string;
  readonly parent: T.Object3D;
  readonly glassMesh: T.Mesh;
  readonly backingMesh: T.Mesh | null;
  readonly ownsBackingMesh: boolean;
  readonly localWidth: number;
  readonly localHeight: number;
  readonly restoreExteriorPortals: boolean;
  readonly textureMatrix: T.Matrix4;
  readonly worldSize: T.Vector2;
  mix: number;
}

// ── Zero-GC Module Scratch Objects ───────────────────────────────────────────────────────────────────────────

const _drawSize = new T.Vector2();
const _camWorldPos = new T.Vector3();
const _camForward = new T.Vector3();
const _camRotMat = new T.Matrix4();
const _lookTarget = new T.Vector3();
const _mirrorWorldPos = new T.Vector3();
const _mirrorNormal = new T.Vector3();
const _mirrorScale = new T.Vector3();
const _eyeOffset = new T.Vector3();
const _tmpVec = new T.Vector3();
const _reflectedEye = new T.Vector3();
const _reflectedTarget = new T.Vector3();
const _reflectedUp = new T.Vector3();
const _reflPlane = new T.Plane();
const _clipPlane = new T.Vector4();
const _qVec = new T.Vector4();
const _projScreenMat = new T.Matrix4();
const _mainFrustum = new T.Frustum();
const _worldBox = new T.Box3();
const _localQuadMat = new T.Matrix4();
const _localPos = new T.Vector3();
const _localNormalVec = new T.Vector3();
const _localQuat = new T.Quaternion();
const _localScaleVec = new T.Vector3();
const _combinedMat = new T.Matrix4();
const _prevViewport = new T.Vector4();
const _prevScissor = new T.Vector4();
const _prevRtScissor = new T.Vector4();
const _zAxis = new T.Vector3(0, 0, 1);

const UNIT_MIRROR_LOCAL_BOX = new T.Box3(
  new T.Vector3(-0.5, -0.5, -0.025),
  new T.Vector3(0.5, 0.5, 0.025),
);

const UV_BIAS_MATRIX = new T.Matrix4().set(
  0.5, 0.0, 0.0, 0.5,
  0.0, 0.5, 0.0, 0.5,
  0.0, 0.0, 0.5, 0.5,
  0.0, 0.0, 0.0, 1.0,
);

let globalRenderingMirror = false;

export function isRenderingPlanarMirror(): boolean {
  return globalRenderingMirror;
}

/**
 * Verifies every visible `castShadow` light in `scene` already has an allocated `shadow.map`
 * so rendering with `shadowMap.autoUpdate = false` can NEVER trigger `GL_INVALID_OPERATION`
 * on `sampler2DShadow` bindings during early boot frames.
 */
function hasAllSceneShadowMaps(scene: T.Scene, renderer: T.WebGLRenderer): boolean {
  if (!renderer.shadowMap.enabled) return true;
  let allReady = true;
  const stack: T.Object3D[] = [scene];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!node.visible) continue;
    if ((node as T.Light).isLight && node.castShadow) {
      const sh = (node as T.DirectionalLight).shadow;
      if (!sh || !sh.map) {
        allReady = false;
        break;
      }
    }
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      stack.push(children[i]);
    }
  }
  return allReady;
}

function isAncestorChainVisible(obj: T.Object3D): boolean {
  let cur: T.Object3D | null = obj.parent;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

function createMirrorFallbackTexture(): T.DataTexture {
  const data = new Uint8Array([148, 164, 182, 255]);
  const tex = new T.DataTexture(data, 1, 1, T.RGBAFormat, T.UnsignedByteType);
  tex.colorSpace = T.LinearSRGBColorSpace;
  tex.minFilter = T.LinearFilter;
  tex.magFilter = T.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.name = 'echo-planar-mirror-fallback';
  return tex;
}

// ── Shared `echo-planar-mirror-v1` GLSL Shaders ──────────────────────────────────────────────────────────────

const MIRROR_VERTEX_SHADER = /* glsl */ `
uniform mat4 uTextureMatrix;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vMirrorProj;

void main() {
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4( position, 1.0 );
  vWorldPos = worldPos.xyz;
  vWorldNormal = normalize( mat3( modelMatrix ) * vec3( 0.0, 0.0, 1.0 ) );
  vMirrorProj = uTextureMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const MIRROR_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uMirrorMap;
uniform vec2 uTexelSize;
uniform vec2 uMirrorSize;
uniform float uMirrorMix;
uniform float uSteamAmount;
uniform vec3 uFallbackTint;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vMirrorProj;

void main() {
  vec3 N = normalize( vWorldNormal );
  vec3 V = normalize( cameraPosition - vWorldPos );
  float NoV = clamp( dot( N, V ), 0.0, 1.0 );
  float fresnel = pow( 1.0 - NoV, 4.0 );

  vec3 reflCol = vec3( 0.0 );
  if ( uMirrorMix > 0.001 ) {
    float invW = 1.0 / max( 1e-4, vMirrorProj.w );
    vec2 reflUv = clamp( vMirrorProj.xy * invW, vec2( 0.0015 ), vec2( 0.9985 ) );
    vec3 sharpCol = texture2D( uMirrorMap, reflUv ).rgb;
    reflCol = sharpCol;

    // Optional hot-shower steam condensation (5-tap rotated cross blur + radial center wipe clarity).
    if ( uSteamAmount > 0.001 ) {
      vec2 r1 = uTexelSize * ( 2.5 + 9.0 * uSteamAmount );
      vec2 r2 = uTexelSize * ( 5.5 + 18.0 * uSteamAmount );
      vec3 blurCol = sharpCol * 0.24
        + texture2D( uMirrorMap, clamp( reflUv + vec2(  r1.x,  r1.y ), vec2( 0.0015 ), vec2( 0.9985 ) ) ).rgb * 0.19
        + texture2D( uMirrorMap, clamp( reflUv + vec2( -r1.x,  r1.y ), vec2( 0.0015 ), vec2( 0.9985 ) ) ).rgb * 0.19
        + texture2D( uMirrorMap, clamp( reflUv + vec2(  r2.x, -r2.y ), vec2( 0.0015 ), vec2( 0.9985 ) ) ).rgb * 0.19
        + texture2D( uMirrorMap, clamp( reflUv + vec2( -r2.x, -r2.y ), vec2( 0.0015 ), vec2( 0.9985 ) ) ).rgb * 0.19;
      vec2 centered = ( vUv - 0.5 ) * 2.0;
      float edgeFog = clamp( uSteamAmount * ( 0.68 + 0.32 * dot( centered, centered ) ), 0.0, 0.92 );
      reflCol = mix( sharpCol, blurCol, smoothstep( 0.0, 0.65, edgeFog ) );
      reflCol = mix( reflCol, vec3( 0.74, 0.79, 0.84 ), edgeFog * 0.34 );
    }

    // Physical low-iron silvered architectural mirror reflectance + subtle grazing Fresnel sheen.
    reflCol *= vec3( 0.958, 0.976, 0.992 );
    reflCol += vec3( 0.028, 0.036, 0.046 ) * fresnel;
  }

  // Smooth silvered-glass fallback when beyond max reflection distance.
  vec3 fallbackCol = uFallbackTint * mix( 0.36, 0.72, clamp( vUv.y, 0.0, 1.0 ) ) + vec3( 0.075 ) * fresnel;
  vec3 finalCol = mix( fallbackCol, reflCol, clamp( uMirrorMix, 0.0, 1.0 ) );

  // Physical 1.1 cm chamfered perimeter glass bevel (scale-invariant via uMirrorSize in metres).
  float distX = min( vUv.x, 1.0 - vUv.x ) * max( 0.05, uMirrorSize.x );
  float distY = min( vUv.y, 1.0 - vUv.y ) * max( 0.05, uMirrorSize.y );
  float edgeM = min( distX, distY );
  float bevelInner = smoothstep( 0.0025, 0.0125, edgeM );
  float bevelHighlight = smoothstep( 0.0012, 0.0052, edgeM ) * ( 1.0 - smoothstep( 0.0052, 0.0115, edgeM ) );
  finalCol = finalCol * mix( 0.78, 1.0, bevelInner ) + vec3( 0.048, 0.056, 0.066 ) * bevelHighlight;

  // Sanitize HDR radiance so PostFX Bloom never ingests NaN/Inf fireflies.
  if ( !( finalCol.r >= 0.0 && finalCol.r < 65000.0 ) ) finalCol.r = 0.0;
  if ( !( finalCol.g >= 0.0 && finalCol.g < 65000.0 ) ) finalCol.g = 0.0;
  if ( !( finalCol.b >= 0.0 && finalCol.b < 65000.0 ) ) finalCol.b = 0.0;
  finalCol = min( finalCol, vec3( 16.0 ) );

  gl_FragColor = vec4( finalCol, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ── PlanarMirrorSystem Implementation ────────────────────────────────────────────────────────────────────────

export class PlanarMirrorSystem {
  private readonly mirrors = new Map<string, MirrorEntry>();
  private readonly zoneSteam = new Map<string, number>();
  private readonly reflectionCamera = new T.PerspectiveCamera(55, 16 / 9, 0.04, 56);
  private readonly unitQuadGeometry = new T.PlaneGeometry(1, 1);
  private readonly fallbackTexture = createMirrorFallbackTexture();
  private readonly mirrorMaterial: T.ShaderMaterial;
  private readonly bevelBackingMaterial: T.MeshStandardMaterial;

  private mirrorRt: T.WebGLRenderTarget | null = null;
  private rtWidth = 0;
  private rtHeight = 0;
  private qualityTier: QualityTier = 'high';
  private activeMirrorId: string | null = null;
  private lastRenderedFrame = -1;
  private lastSkippedReason: string | null = 'idle';
  private lastObservingPlayer = false;
  private cadenceCounter = 0;
  private readonly lastCamPos = new T.Vector3(Infinity, Infinity, Infinity);
  private readonly lastCamDir = new T.Vector3(0, 0, -1);
  private readonly hiddenScratch: T.Object3D[] = [];
  private readonly unhiddenPortalScratch: T.Object3D[] = [];
  private disposed = false;

  constructor(initialTier: QualityTier = 'high') {
    this.qualityTier = initialTier;
    this.unitQuadGeometry.boundingBox = UNIT_MIRROR_LOCAL_BOX.clone();
    this.unitQuadGeometry.computeBoundingSphere();

    this.mirrorMaterial = new T.ShaderMaterial({
      name: PLANAR_MIRROR_CACHE_KEY,
      uniforms: {
        uMirrorMap: { value: this.fallbackTexture },
        uTexelSize: { value: new T.Vector2(1 / 960, 1 / 540) },
        uTextureMatrix: { value: new T.Matrix4() },
        uMirrorSize: { value: new T.Vector2(DEFAULT_MIRROR_LOCAL_GLASS.width, DEFAULT_MIRROR_LOCAL_GLASS.height) },
        uMirrorMix: { value: 0.0 },
        uSteamAmount: { value: 0.0 },
        uFallbackTint: { value: new T.Color('#8c9eb2') },
      },
      vertexShader: MIRROR_VERTEX_SHADER,
      fragmentShader: MIRROR_FRAGMENT_SHADER,
      side: T.FrontSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      toneMapped: true,
      fog: false,
    });
    this.mirrorMaterial.customProgramCacheKey = () => PLANAR_MIRROR_CACHE_KEY;

    // Dark brushed-silver bevel backing for the 1.4 cm extruded `Cube.001` glass slab behind the front mirror plane.
    this.bevelBackingMaterial = new T.MeshStandardMaterial({
      name: 'echo-planar-mirror-bevel-backing',
      color: '#2a3038',
      metalness: 0.88,
      roughness: 0.24,
      side: T.FrontSide,
    });
    patchMaterialWithEchoCsm(this.bevelBackingMaterial);
    patchHeightFog(this.bevelBackingMaterial);
  }

  /** Shared dark brushed-silver bevel backing material for `Cube.001` (`role === 'mirror-glass'`). */
  get backingMaterial(): T.MeshStandardMaterial {
    return this.bevelBackingMaterial;
  }

  /** Shared `echo-planar-mirror-v1` optical surface material. */
  get surfaceMaterial(): T.ShaderMaterial {
    return this.mirrorMaterial;
  }

  setQuality(tier: QualityTier): void {
    if (this.qualityTier === tier) return;
    this.qualityTier = tier;
  }

  /**
   * Sets condensation mist amount `[0..1]` for all mirrors in a zone (e.g. `'bath'` hot-shower steam hook for A7).
   * Zero shader recompiles — updates per-draw `uSteamAmount` uniform smoothly.
   */
  setZoneSteamLevel(zoneId: string, steam01: number): void {
    const clamped = T.MathUtils.clamp(Number.isFinite(steam01) ? steam01 : 0, 0, 1);
    if (clamped <= 0.0001) {
      this.zoneSteam.delete(zoneId);
    } else {
      this.zoneSteam.set(zoneId, clamped);
    }
  }

  getZoneSteamLevel(zoneId: string): number {
    return this.zoneSteam.get(zoneId) ?? 0;
  }

  /**
   * Returns resident GPU bytes consumed by the shared planar mirror `HalfFloatType` + `DEPTH24` FBO
   * (`RGBA16F` 8 B/px + depth 4 B/px = 12 B/px) for `StudyWorld.updateResidencyFixedBreakdown()`.
   */
  getAllocatedVramBytes(): number {
    if (!this.mirrorRt || this.rtWidth <= 0 || this.rtHeight <= 0) return 0;
    return this.rtWidth * this.rtHeight * 12;
  }

  getDiagnostics(): PlanarMirrorDiagnostics {
    return {
      registeredMirrors: this.mirrors.size,
      activeMirrorId: this.activeMirrorId,
      rtWidth: this.rtWidth,
      rtHeight: this.rtHeight,
      allocatedVramBytes: this.getAllocatedVramBytes(),
      lastRenderedFrame: this.lastRenderedFrame,
      lastSkippedReason: this.lastSkippedReason,
      isObservingPlayer: this.lastObservingPlayer,
    };
  }

  /**
   * Mounts a coplanar `FrontSide` mirror quad (`2` tris, shared `PlaneGeometry(1, 1)` + shared
   * `echo-planar-mirror-v1` `ShaderMaterial`) and converts the `1.4 cm` `Cube.001` box (`role === 'mirror-glass'`)
   * into a dark brushed-silver bevel backing (`#2a3038`).
   */
  attachMirrorSurface(opts: AttachMirrorSurfaceOptions): MirrorSurfaceHandle {
    if (this.mirrors.has(opts.id)) {
      this.unregisterMirror(opts.id);
    }

    let backingMesh: T.Mesh | null = opts.backingMesh ?? null;
    let ownsBackingMesh = false;
    let resolvedSpec: MirrorLocalGlassSpec = opts.localGlass ?? DEFAULT_MIRROR_LOCAL_GLASS;

    if (opts.prepared) {
      const glassPart = opts.prepared.parts.find((p) => p.role === 'mirror-glass');
      if (glassPart) {
        if (!glassPart.geometry.boundingBox) {
          glassPart.geometry.computeBoundingBox();
        }
        const bb = glassPart.geometry.boundingBox;
        if (bb && !opts.localGlass) {
          const w = Math.max(0.12, bb.max.x - bb.min.x);
          const h = Math.max(0.12, bb.max.y - bb.min.y);
          const cx = (bb.min.x + bb.max.x) * 0.5;
          const cy = (bb.min.y + bb.max.y) * 0.5;
          // Sit 0.25 mm proud of `Cube.001`'s front face so bevel backing never z-fights with the mirror plane.
          const cz = bb.max.z + 0.00025;
          resolvedSpec = {
            width: w,
            height: h,
            center: [cx, cy, cz],
            normal: [0, 0, 1],
          };
        }
        if (!backingMesh) {
          backingMesh = new T.Mesh(glassPart.geometry, this.bevelBackingMaterial);
          backingMesh.applyMatrix4(opts.placementMatrix);
          backingMesh.castShadow = false;
          backingMesh.receiveShadow = true;
          backingMesh.name = `mirror-bevel:${opts.id}`;
          backingMesh.userData.lifeFurniture = 'mirror';
          backingMesh.userData.isMirrorBevel = true;
          opts.parent.add(backingMesh);
          ownsBackingMesh = true;
        }
      }
    }

    if (backingMesh && backingMesh.material !== this.bevelBackingMaterial) {
      backingMesh.material = this.bevelBackingMaterial;
      backingMesh.castShadow = false;
      backingMesh.receiveShadow = true;
      backingMesh.userData.isMirrorBevel = true;
    }

    const nTuple = resolvedSpec.normal ?? DEFAULT_MIRROR_LOCAL_GLASS.normal;
    _localNormalVec.set(nTuple[0], nTuple[1], nTuple[2]).normalize();
    if (_localNormalVec.lengthSq() < 0.5) _localNormalVec.set(0, 0, 1);

    _localPos.set(resolvedSpec.center[0], resolvedSpec.center[1], resolvedSpec.center[2]);
    _localQuat.setFromUnitVectors(_zAxis, _localNormalVec);
    _localScaleVec.set(resolvedSpec.width, resolvedSpec.height, 1);
    _localQuadMat.compose(_localPos, _localQuat, _localScaleVec);
    _combinedMat.multiplyMatrices(opts.placementMatrix, _localQuadMat);

    const glassMesh = new T.Mesh(this.unitQuadGeometry, this.mirrorMaterial);
    glassMesh.applyMatrix4(_combinedMat);
    glassMesh.castShadow = false;
    glassMesh.receiveShadow = false;
    glassMesh.name = `planar-mirror:${opts.id}`;
    glassMesh.userData.isPlanarMirror = true;
    glassMesh.userData.mirrorId = opts.id;
    glassMesh.userData.mirrorZoneId = opts.zoneId;
    glassMesh.userData.lifeFurniture = 'mirror';

    _mirrorScale.setFromMatrixScale(opts.placementMatrix);
    const uniformScale = Math.max(0.05, Math.abs(_mirrorScale.z) || 1);

    const entry: MirrorEntry = {
      id: opts.id,
      zoneId: opts.zoneId,
      parent: opts.parent,
      glassMesh,
      backingMesh,
      ownsBackingMesh,
      localWidth: resolvedSpec.width,
      localHeight: resolvedSpec.height,
      restoreExteriorPortals: opts.restoreExteriorPortals ?? (opts.zoneId !== 'bath'),
      textureMatrix: new T.Matrix4(),
      worldSize: new T.Vector2(resolvedSpec.width * uniformScale, resolvedSpec.height * uniformScale),
      mix: 0,
    };

    // Per-draw uniform upload on the single shared `echo-planar-mirror-v1` ShaderMaterial (`0` extra programs).
    glassMesh.onBeforeRender = () => {
      const u = this.mirrorMaterial.uniforms;
      const isCurrentActive = this.activeMirrorId === entry.id && entry.mix > 0.001 && this.mirrorRt !== null;
      u.uMirrorMap.value = isCurrentActive && this.mirrorRt ? this.mirrorRt.texture : this.fallbackTexture;
      u.uMirrorMix.value = isCurrentActive ? entry.mix : 0.0;
      u.uTextureMatrix.value.copy(entry.textureMatrix);
      u.uMirrorSize.value.copy(entry.worldSize);
      u.uSteamAmount.value = this.zoneSteam.get(entry.zoneId) ?? 0.0;
      this.mirrorMaterial.uniformsNeedUpdate = true;
    };

    opts.parent.add(glassMesh);
    this.mirrors.set(opts.id, entry);

    return {
      id: opts.id,
      zoneId: opts.zoneId,
      glassMesh,
      backingMesh,
      dispose: () => {
        this.unregisterMirror(opts.id);
      },
    };
  }

  /** Alias of `attachMirrorSurface` for callers registering placed mirror descriptors. */
  registerMirror(opts: RegisterMirrorOptions): MirrorSurfaceHandle {
    return this.attachMirrorSurface(opts);
  }

  /** Symmetric cleanup for a single mirror handle. */
  unregisterMirror(id: string): boolean {
    const entry = this.mirrors.get(id);
    if (!entry) return false;
    entry.glassMesh.onBeforeRender = () => {};
    entry.glassMesh.removeFromParent();
    if (entry.ownsBackingMesh && entry.backingMesh) {
      entry.backingMesh.removeFromParent();
    }
    if (this.activeMirrorId === id) {
      this.activeMirrorId = null;
    }
    this.mirrors.delete(id);
    return true;
  }

  /** Symmetric bulk cleanup for streamed interiors (`buildingsView.unfurnish()` / `house` rebuild). */
  clearZone(zoneId: string): number {
    let removed = 0;
    for (const [id, entry] of this.mirrors) {
      if (entry.zoneId === zoneId) {
        this.unregisterMirror(id);
        removed++;
      }
    }
    return removed;
  }

  private ensureMirrorRt(renderer: T.WebGLRenderer, tier: QualityTier): T.WebGLRenderTarget {
    renderer.getDrawingBufferSize(_drawSize);
    const scale = MIRROR_SCALE_BY_TIER[tier];
    const [maxW, maxH] = MIRROR_MAX_RES_BY_TIER[tier];
    const targetW = Math.min(maxW, Math.max(256, Math.round(_drawSize.x * scale)));
    const targetH = Math.min(maxH, Math.max(144, Math.round(_drawSize.y * scale)));

    if (!this.mirrorRt || this.rtWidth !== targetW || this.rtHeight !== targetH) {
      this.mirrorRt?.dispose();
      this.mirrorRt = new T.WebGLRenderTarget(targetW, targetH, {
        minFilter: T.LinearFilter,
        magFilter: T.LinearFilter,
        format: T.RGBAFormat,
        type: T.HalfFloatType,
        colorSpace: T.LinearSRGBColorSpace,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
        samples: 0,
      });
      this.mirrorRt.texture.name = 'echo-planar-mirror-rt';
      this.rtWidth = targetW;
      this.rtHeight = targetH;
      this.mirrorMaterial.uniforms.uTexelSize.value.set(1 / targetW, 1 / targetH);
      this.lastRenderedFrame = -1;
    }
    return this.mirrorRt;
  }

  private collectAutoExteriorPortalGroups(scene: T.Scene, out: T.Object3D[]): void {
    // Auto-discover hidden `echo-life-city` / `echo-life-stream` groups when reflecting windowed shop interiors.
    for (let i = 0; i < scene.children.length; i++) {
      const top = scene.children[i];
      const scanRoot = top.name === 'echo-life' ? top : null;
      if (scanRoot) {
        for (let j = 0; j < scanRoot.children.length; j++) {
          const ch = scanRoot.children[j];
          if ((ch.name === 'echo-life-city' || ch.name === 'echo-life-stream') && !ch.visible) {
            out.push(ch);
          }
        }
      } else {
        for (let j = 0; j < top.children.length; j++) {
          const sub = top.children[j];
          if (sub.name === 'echo-life' && sub.visible) {
            for (let k = 0; k < sub.children.length; k++) {
              const ch = sub.children[k];
              if ((ch.name === 'echo-life-city' || ch.name === 'echo-life-stream') && !ch.visible) {
                out.push(ch);
              }
            }
          }
        }
      }
    }
  }

  /**
   * Evaluates visibility, front-facing plane distance, and camera frustum culling across all registered
   * mirrors, rendering at most ONE active planar mirror per frame before `PostFXController.render()`.
   */
  prepareReflection(ctx: PrepareMirrorReflectionContext): PrepareMirrorReflectionResult {
    const tier = ctx.qualityTier ?? this.qualityTier;
    this.qualityTier = tier;

    if (this.disposed || globalRenderingMirror || this.mirrors.size === 0) {
      this.activeMirrorId = null;
      this.lastObservingPlayer = false;
      this.lastSkippedReason = this.mirrors.size === 0 ? 'no-mirrors' : 'reentrant-or-disposed';
      ctx.character?.setMirrorObserved?.(false);
      return {
        active: false,
        renderedThisFrame: false,
        activeMirrorId: null,
        distanceM: Infinity,
        isObservingPlayer: false,
        skippedReason: this.lastSkippedReason,
      };
    }

    if (!(ctx.camera as T.PerspectiveCamera).isPerspectiveCamera) {
      this.activeMirrorId = null;
      this.lastObservingPlayer = false;
      this.lastSkippedReason = 'non-perspective-camera';
      ctx.character?.setMirrorObserved?.(false);
      return {
        active: false,
        renderedThisFrame: false,
        activeMirrorId: null,
        distanceM: Infinity,
        isObservingPlayer: false,
        skippedReason: this.lastSkippedReason,
      };
    }

    const perspCamera = ctx.camera as T.PerspectiveCamera;
    perspCamera.updateMatrixWorld();
    perspCamera.getWorldPosition(_camWorldPos);
    _projScreenMat.multiplyMatrices(perspCamera.projectionMatrix, perspCamera.matrixWorldInverse);
    _mainFrustum.setFromProjectionMatrix(_projScreenMat);

    const maxDist = MIRROR_MAX_DIST_BY_TIER[tier];
    let bestEntry: MirrorEntry | null = null;
    let bestDistSq = Infinity;
    let bestNormalDist = Infinity;
    let observingPlayer = false;

    for (const entry of this.mirrors.values()) {
      entry.mix = 0;
      if (!entry.glassMesh.visible || !isAncestorChainVisible(entry.glassMesh)) {
        continue;
      }

      entry.glassMesh.updateWorldMatrix(true, false);
      _mirrorWorldPos.setFromMatrixPosition(entry.glassMesh.matrixWorld);
      _mirrorNormal.setFromMatrixColumn(entry.glassMesh.matrixWorld, 2).normalize();

      _eyeOffset.subVectors(_camWorldPos, _mirrorWorldPos);
      const normalDist = _eyeOffset.dot(_mirrorNormal);
      if (normalDist <= MIN_FRONT_DIST_M || normalDist > maxDist) {
        continue;
      }

      const distSq = _eyeOffset.lengthSq();
      if (distSq > maxDist * maxDist) {
        continue;
      }

      if (normalDist <= PLAYER_OBSERVE_MAX_DIST_M && distSq <= PLAYER_OBSERVE_MAX_DIST_M * PLAYER_OBSERVE_MAX_DIST_M) {
        observingPlayer = true;
      }

      _worldBox.copy(UNIT_MIRROR_LOCAL_BOX).applyMatrix4(entry.glassMesh.matrixWorld);
      if (!_mainFrustum.intersectsBox(_worldBox)) {
        continue;
      }

      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestNormalDist = normalDist;
        bestEntry = entry;
      }
    }

    this.lastObservingPlayer = observingPlayer;
    ctx.character?.setMirrorObserved?.(observingPlayer);

    if (!bestEntry) {
      this.activeMirrorId = null;
      this.lastSkippedReason = 'out-of-range-or-frustum';
      return {
        active: false,
        renderedThisFrame: false,
        activeMirrorId: null,
        distanceM: Infinity,
        isObservingPlayer: observingPlayer,
        skippedReason: this.lastSkippedReason,
      };
    }

    const canRender =
      (ctx.canRenderReflection ?? true) && hasAllSceneShadowMaps(ctx.scene, ctx.renderer);
    if (!canRender) {
      this.activeMirrorId = null;
      this.lastSkippedReason = 'shadow-maps-pending';
      return {
        active: false,
        renderedThisFrame: false,
        activeMirrorId: null,
        distanceM: bestNormalDist,
        isObservingPlayer: observingPlayer,
        skippedReason: this.lastSkippedReason,
      };
    }

    const distCenter = Math.sqrt(bestDistSq);
    const fadeBand = 1.25;
    bestEntry.mix = T.MathUtils.clamp((maxDist - distCenter) / fadeBand, 0, 1);
    if (bestEntry.mix <= 0.001) {
      this.activeMirrorId = null;
      this.lastSkippedReason = 'distance-faded';
      return {
        active: false,
        renderedThisFrame: false,
        activeMirrorId: null,
        distanceM: bestNormalDist,
        isObservingPlayer: observingPlayer,
        skippedReason: this.lastSkippedReason,
      };
    }

    const rt = this.ensureMirrorRt(ctx.renderer, tier);

    // Re-extract exact world plane `(P_0, n_hat)` of the winning mirror.
    _mirrorWorldPos.setFromMatrixPosition(bestEntry.glassMesh.matrixWorld);
    _mirrorNormal.setFromMatrixColumn(bestEntry.glassMesh.matrixWorld, 2).normalize();
    _eyeOffset.subVectors(_camWorldPos, _mirrorWorldPos);
    const normalDist = _eyeOffset.dot(_mirrorNormal);

    // Householder reflection across `(P_0, n_hat)`:
    // E' = E - 2((E - P_0)·n_hat)n_hat, T' = T - 2((T - P_0)·n_hat)n_hat, U' = U - 2(U·n_hat)n_hat.
    _reflectedEye.copy(_camWorldPos).addScaledVector(_mirrorNormal, -2.0 * normalDist);

    _camRotMat.extractRotation(perspCamera.matrixWorld);
    _camForward.set(0, 0, -1).applyMatrix4(_camRotMat);
    _lookTarget.copy(_camWorldPos).add(_camForward);
    const targetNormalDist = _tmpVec.subVectors(_lookTarget, _mirrorWorldPos).dot(_mirrorNormal);
    _reflectedTarget.copy(_lookTarget).addScaledVector(_mirrorNormal, -2.0 * targetNormalDist);

    _reflectedUp.set(0, 1, 0).applyMatrix4(_camRotMat);
    const upDot = _reflectedUp.dot(_mirrorNormal);
    _reflectedUp.addScaledVector(_mirrorNormal, -2.0 * upDot).normalize();

    const reflCam = this.reflectionCamera;
    reflCam.position.copy(_reflectedEye);
    reflCam.up.copy(_reflectedUp);
    reflCam.lookAt(_reflectedTarget);
    reflCam.fov = perspCamera.fov;
    reflCam.aspect = perspCamera.aspect;
    reflCam.near = Math.max(0.02, perspCamera.near);
    reflCam.far = Math.min(perspCamera.far, 56.0);
    reflCam.layers.mask = perspCamera.layers.mask;
    reflCam.updateMatrixWorld(true);
    reflCam.projectionMatrix.copy(perspCamera.projectionMatrix);

    // Projective UV matrix `Bias * P * V_refl * M_mirror` computed BEFORE oblique row-2 modification.
    bestEntry.textureMatrix
      .copy(UV_BIAS_MATRIX)
      .multiply(reflCam.projectionMatrix)
      .multiply(reflCam.matrixWorldInverse)
      .multiply(bestEntry.glassMesh.matrixWorld);

    // Low-tier distant stationary cadence optimization (always 1:1 when close or moving/turning!).
    this.cadenceCounter++;
    const camMoved =
      _camWorldPos.distanceToSquared(this.lastCamPos) > 0.0004 ||
      _camForward.dot(this.lastCamDir) < 0.9995;
    if (
      tier === 'low' &&
      distCenter > 3.2 &&
      !camMoved &&
      this.activeMirrorId === bestEntry.id &&
      this.lastRenderedFrame >= 0 &&
      (this.cadenceCounter & 1) === 1
    ) {
      this.lastSkippedReason = 'low-stationary-cached';
      return {
        active: true,
        renderedThisFrame: false,
        activeMirrorId: bestEntry.id,
        distanceM: bestNormalDist,
        isObservingPlayer: observingPlayer,
        skippedReason: this.lastSkippedReason,
      };
    }

    // Eric Lengyel oblique near-plane replacement on row 2 of `reflCam.projectionMatrix` (`NUM_CLIPPING_PLANES === 0`).
    _reflPlane.setFromNormalAndCoplanarPoint(_mirrorNormal, _mirrorWorldPos);
    _reflPlane.applyMatrix4(reflCam.matrixWorldInverse);
    _clipPlane.set(_reflPlane.normal.x, _reflPlane.normal.y, _reflPlane.normal.z, _reflPlane.constant);

    const proj = reflCam.projectionMatrix;
    const pe = proj.elements;
    _qVec.x = (Math.sign(_clipPlane.x) + pe[8]) / pe[0];
    _qVec.y = (Math.sign(_clipPlane.y) + pe[9]) / pe[5];
    _qVec.z = -1.0;
    _qVec.w = (1.0 + pe[10]) / pe[14];
    const clipDot = _clipPlane.dot(_qVec);
    if (!Number.isFinite(clipDot) || Math.abs(clipDot) < 1e-4) {
      bestEntry.mix = 0;
      this.activeMirrorId = null;
      this.lastSkippedReason = 'oblique-degenerate';
      return {
        active: false,
        renderedThisFrame: false,
        activeMirrorId: null,
        distanceM: bestNormalDist,
        isObservingPlayer: observingPlayer,
        skippedReason: this.lastSkippedReason,
      };
    }
    const obliqueScale = Math.max(-50.0, Math.min(50.0, 2.0 / clipDot));
    _clipPlane.multiplyScalar(obliqueScale);
    pe[2] = _clipPlane.x;
    pe[6] = _clipPlane.y;
    pe[10] = _clipPlane.z + 1.0 - OBLIQUE_CLIP_BIAS;
    pe[14] = _clipPlane.w;

    // ── Pre-Pass Scene & Avatar State Swap ─────────────────────────────────────────────────────────────────
    const hidden = this.hiddenScratch;
    hidden.length = 0;
    // Prevent mirror recursion on active mirror (and any secondary mirrors in view).
    for (const m of this.mirrors.values()) {
      if (m.glassMesh.visible) {
        m.glassMesh.visible = false;
        hidden.push(m.glassMesh);
      }
    }
    if (ctx.excludeObjects) {
      for (let i = 0; i < ctx.excludeObjects.length; i++) {
        const obj = ctx.excludeObjects[i];
        if (obj && obj.visible) {
          obj.visible = false;
          hidden.push(obj);
        }
      }
    }

    // Temporarily un-cull exterior city/stream sectors when a windowed shop mirror (`clothing_shop`) reflects behind the player.
    const unhiddenPortals = this.unhiddenPortalScratch;
    unhiddenPortals.length = 0;
    if (bestEntry.restoreExteriorPortals) {
      if (ctx.exteriorPortalGroups && ctx.exteriorPortalGroups.length > 0) {
        for (let i = 0; i < ctx.exteriorPortalGroups.length; i++) {
          const grp = ctx.exteriorPortalGroups[i];
          if (grp && !grp.visible) {
            grp.visible = true;
            unhiddenPortals.push(grp);
          }
        }
      } else {
        this.collectAutoExteriorPortalGroups(ctx.scene, unhiddenPortals);
        for (let i = 0; i < unhiddenPortals.length; i++) {
          unhiddenPortals[i].visible = true;
        }
      }
    }

    // Restore full 3D player avatar visibility (1P head/hair/face `colorWrite`, `:ec-1p-limb-guard-v1`, & tight-boom 3P root).
    const ch = ctx.character;
    const swapCharacter = Boolean(ch && (ch.ready ?? true) && (ctx.explorationActive ?? true) && !ctx.driving);
    let prevCharRootVisible = true;
    let prevCharOwnView = false;
    if (swapCharacter && ch) {
      prevCharRootVisible = ch.root.visible;
      prevCharOwnView = Boolean(ch.isOwnView);
      ch.root.visible = true;
      ch.setOwnView(false);
      ctx.clearOwnLimbGuard?.();
      if (!prevCharRootVisible) {
        ch.root.updateMatrixWorld(true);
      }
    }

    const renderer = ctx.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    const prevAutoClear = renderer.autoClear;
    const prevToneMapping = renderer.toneMapping;

    globalRenderingMirror = true;
    try {
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.autoClear = true;
      // Match EffectComposer's linear HDR inputBuffer (`NoToneMapping`) so ZERO new scene shader variants compile!
      renderer.toneMapping = T.NoToneMapping;
      renderer.setRenderTarget(rt);
      renderer.state.buffers.depth.setMask(true);
      renderer.clear(true, true, false);
      renderer.render(ctx.scene, reflCam);

      this.activeMirrorId = bestEntry.id;
      this.lastRenderedFrame = renderer.info.render.frame;
      this.lastSkippedReason = null;
      this.lastCamPos.copy(_camWorldPos);
      this.lastCamDir.copy(_camForward);

      return {
        active: true,
        renderedThisFrame: true,
        activeMirrorId: bestEntry.id,
        distanceM: bestNormalDist,
        isObservingPlayer: observingPlayer,
        skippedReason: null,
      };
    } catch {
      bestEntry.mix = 0;
      this.activeMirrorId = null;
      this.lastSkippedReason = 'render-error';
      return {
        active: false,
        renderedThisFrame: false,
        activeMirrorId: null,
        distanceM: bestNormalDist,
        isObservingPlayer: observingPlayer,
        skippedReason: this.lastSkippedReason,
      };
    } finally {
      globalRenderingMirror = false;
      renderer.setRenderTarget(prevTarget);
      renderer.toneMapping = prevToneMapping;
      renderer.xr.enabled = prevXr;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.shadowMap.needsUpdate = prevShadowNeeds;
      renderer.autoClear = prevAutoClear;

      if (swapCharacter && ch) {
        ctx.restoreOwnLimbGuard?.();
        ch.setOwnView(prevCharOwnView);
        ch.root.visible = prevCharRootVisible;
      }

      for (let i = 0; i < unhiddenPortals.length; i++) {
        unhiddenPortals[i].visible = false;
      }
      unhiddenPortals.length = 0;

      for (let i = 0; i < hidden.length; i++) {
        hidden[i].visible = true;
      }
      hidden.length = 0;
    }
  }

  /**
   * Stage-6 `1x1` scissored planar mirror warmup behind the boot loading overlay.
   * Pre-allocates the adaptive `HalfFloatType` FBO and compiles/links `echo-planar-mirror-v1` +
   * `bevelBackingMaterial` in BOTH linear HDR (`NoToneMapping`) and backbuffer (`AgXToneMapping`)
   * states before `baselinePrograms` locks -> `programDelta === 0` and `0` hitches on bathroom/shop entry!
   */
  warmup(
    renderer: T.WebGLRenderer,
    scene: T.Scene,
    camera: T.Camera,
    qualityTier?: QualityTier,
  ): boolean {
    if (this.disposed || globalRenderingMirror) return false;
    if (!hasAllSceneShadowMaps(scene, renderer)) return false;
    if (!(camera as T.PerspectiveCamera).isPerspectiveCamera) return false;

    const tier = qualityTier ?? this.qualityTier;
    this.qualityTier = tier;
    const perspCamera = camera as T.PerspectiveCamera;
    const rt = this.ensureMirrorRt(renderer, tier);

    // Temporary tiny warmup meshes attached directly to `scene` so `bevelBackingMaterial` inherits the
    // exact scene `lightsStateVersion` and `echo-planar-mirror-v1` links cleanly even before lazy interiors stream in!
    const warmupGroup = new T.Group();
    warmupGroup.name = 'echo-planar-mirror-warmup-probe';
    const probeMirror = new T.Mesh(this.unitQuadGeometry, this.mirrorMaterial);
    const probeBacking = new T.Mesh(this.unitQuadGeometry, this.bevelBackingMaterial);
    probeMirror.frustumCulled = false;
    probeBacking.frustumCulled = false;
    probeMirror.scale.setScalar(0.001);
    probeBacking.scale.setScalar(0.001);

    perspCamera.updateMatrixWorld();
    perspCamera.getWorldPosition(_camWorldPos);
    _camRotMat.extractRotation(perspCamera.matrixWorld);
    _camForward.set(0, 0, -1).applyMatrix4(_camRotMat);
    warmupGroup.position.copy(_camWorldPos).addScaledVector(_camForward, 0.5);
    warmupGroup.lookAt(_camWorldPos);
    warmupGroup.add(probeMirror, probeBacking);

    const reflCam = this.reflectionCamera;
    reflCam.position.copy(_camWorldPos);
    reflCam.quaternion.copy(perspCamera.quaternion);
    reflCam.fov = perspCamera.fov;
    reflCam.aspect = perspCamera.aspect;
    reflCam.near = Math.max(0.02, perspCamera.near);
    reflCam.far = Math.min(perspCamera.far, 56.0);
    reflCam.updateMatrixWorld(true);
    reflCam.updateProjectionMatrix();

    const hidden = this.hiddenScratch;
    hidden.length = 0;
    for (const m of this.mirrors.values()) {
      if (m.glassMesh.visible) {
        m.glassMesh.visible = false;
        hidden.push(m.glassMesh);
      }
    }

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    const prevAutoClear = renderer.autoClear;
    const prevToneMapping = renderer.toneMapping;
    renderer.getViewport(_prevViewport);
    renderer.getScissor(_prevScissor);
    const prevScissorTest = renderer.getScissorTest();
    _prevRtScissor.copy(rt.scissor);
    const prevRtScissorTest = rt.scissorTest;

    globalRenderingMirror = true;
    scene.add(warmupGroup);
    warmupGroup.updateMatrixWorld(true);

    try {
      // Bind `fallbackTexture` while `rt` is attached as FBO color target so WebGL2 NEVER forms a
      // texture-framebuffer feedback loop when `probeMirror` draws inside `scene`!
      this.mirrorMaterial.uniforms.uMirrorMap.value = this.fallbackTexture;
      this.mirrorMaterial.uniforms.uMirrorMix.value = 1.0;
      this.mirrorMaterial.uniformsNeedUpdate = true;

      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;

      // 1. 1x1 scissored Linear HDR pass into `mirrorRt` (`HalfFloatType` + `NoToneMapping`) —
      //    validates the FBO attachment AND links `echo-planar-mirror-v1` for PostFX HDR tiers!
      rt.scissor.set(0, 0, 1, 1);
      rt.scissorTest = true;
      renderer.autoClear = true;
      renderer.toneMapping = T.NoToneMapping;
      renderer.setRenderTarget(rt);
      renderer.state.buffers.depth.setMask(true);
      renderer.clear(true, true, false);
      renderer.render(scene, reflCam);

      // 2. Compile & 1x1 scissored non-clearing draw in `AgXToneMapping` backbuffer state (`rt` unbound -> safe to sample `rt.texture`)!
      this.mirrorMaterial.uniforms.uMirrorMap.value = rt.texture;
      this.mirrorMaterial.uniformsNeedUpdate = true;
      renderer.setRenderTarget(null);
      renderer.toneMapping = T.AgXToneMapping;
      renderer.autoClear = false;
      renderer.setScissorTest(true);
      renderer.setScissor(0, 0, 1, 1);
      renderer.compile(scene, perspCamera);
      renderer.render(warmupGroup, perspCamera);

      return true;
    } catch {
      return false;
    } finally {
      globalRenderingMirror = false;
      warmupGroup.removeFromParent();
      this.mirrorMaterial.uniforms.uMirrorMix.value = 0.0;
      this.mirrorMaterial.uniformsNeedUpdate = true;

      rt.scissor.copy(_prevRtScissor);
      rt.scissorTest = prevRtScissorTest;
      renderer.setRenderTarget(prevTarget);
      renderer.setViewport(_prevViewport);
      renderer.setScissor(_prevScissor);
      renderer.setScissorTest(prevScissorTest);
      renderer.toneMapping = prevToneMapping;
      renderer.xr.enabled = prevXr;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.shadowMap.needsUpdate = prevShadowNeeds;
      renderer.autoClear = prevAutoClear;

      for (let i = 0; i < hidden.length; i++) {
        hidden[i].visible = true;
      }
      hidden.length = 0;
      this.activeMirrorId = null;
      this.lastRenderedFrame = -1;
    }
  }

  /** Alias matching `WaterSurface.warmupReflection` call convention. */
  warmupReflection(
    renderer: T.WebGLRenderer,
    scene: T.Scene,
    camera: T.Camera,
    qualityTier?: QualityTier,
  ): boolean {
    return this.warmup(renderer, scene, camera, qualityTier);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.mirrors.keys()]) {
      this.unregisterMirror(id);
    }
    this.zoneSteam.clear();
    this.mirrorRt?.dispose();
    this.mirrorRt = null;
    this.rtWidth = 0;
    this.rtHeight = 0;
    this.unitQuadGeometry.dispose();
    this.fallbackTexture.dispose();
    this.mirrorMaterial.dispose();
    this.bevelBackingMaterial.dispose();
  }
}

// ── Shared Echo Life Singleton Accessor ──────────────────────────────────────────────────────────────────────

let sharedPlanarMirrorSystem: PlanarMirrorSystem | null = null;

/** Returns the shared `PlanarMirrorSystem` singleton across `house.ts`, `buildingsView.ts`, `world.ts`, and `engine.ts`. */
export function getEchoLifePlanarMirrors(): PlanarMirrorSystem {
  if (!sharedPlanarMirrorSystem) {
    sharedPlanarMirrorSystem = new PlanarMirrorSystem();
  }
  return sharedPlanarMirrorSystem;
}

/** Disposes and resets the shared `PlanarMirrorSystem` singleton when StudyWorld unmounts. */
export function disposeEchoLifePlanarMirrors(): void {
  if (sharedPlanarMirrorSystem) {
    sharedPlanarMirrorSystem.dispose();
    sharedPlanarMirrorSystem = null;
  }
}

/** Convenience helper forwarding directly to `getEchoLifePlanarMirrors().attachMirrorSurface(opts)`. */
export function attachMirrorSurface(opts: AttachMirrorSurfaceOptions): MirrorSurfaceHandle {
  return getEchoLifePlanarMirrors().attachMirrorSurface(opts);
}
