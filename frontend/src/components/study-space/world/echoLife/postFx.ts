import * as T from 'three';
import {
  BlendFunction,
  BloomEffect,
  BrightnessContrastEffect,
  DepthDownsamplingPass,
  EdgeDetectionMode,
  Effect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  NormalPass,
  Pass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  SSAOEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
// @ts-expect-error n8ao@2.1.0 ships untyped ESM without bundled .d.ts declarations
import { N8AOPostPass as RawN8AOPostPass } from 'n8ao';
import type { WaterView } from '../water/waterView';
import { RENDER_CONFIGS, type QualityTier } from './renderConfig';

/**
 * Echo Life AAA — Half-Float HDR Post-Processing Controller (`postprocessing@6.39.6` + `n8ao@2.1.0`).
 *
 * Design invariants:
 * 1. Zero allocation and zero GPU cost on `'low'` and `'balanced'` tiers (direct WebGL2 render).
 * 2. Half-res depth-only `N8AOPostPass` on `'high'` and `'ultra'` — RETIRES `ScopedNormalPass`'s ~100 extra
 *    geometry draw calls per frame while delivering 3x richer contact and architectural ambient occlusion, with
 *    automatic graceful fallback to `SSAOEffect` if `N8AOPostPass` throws or `EXT_color_buffer_float` is absent.
 * 3. `HalfFloatType` main composer buffer strictly (never `FloatType` composer RT); `transparencyAware` and
 *    `autoDetectTransparency` explicitly disabled on `N8AOPostPass` so zero extra scene passes run.
 * 4. Zero-copy linear HDR `WaterCompositePass` runs between AO and Bloom/AgX whenever `WaterView` has airborne
 *    particles (disabled at 0 cost when dry), eliminating `EffectComposer` bypass and shader-define flips.
 * 5. Calibrated selective HDR Bloom (`threshold: 1.38`, `smoothing: 0.25`, `intensity: 0.18`) eliminates hair
 *    specular bloom orbs (`G-08`) while preserving warm lamp and emissive glow.
 * 6. AgX Punchy Look (`ToneMappingEffect(AGX)` + `BrightnessContrastEffect` + `HueSaturationEffect` +
 *    `VignetteEffect` merged in 1 `EffectPass`) followed by post-AgX `SMAAEffect` with output dithering.
 * 7. Automatic safe bypass to `renderer.render(scene, camera)` ONLY in Cutaway Overview alpha mode,
 *    preserving `renderer.autoClear` and `scene.background = null`.
 */

interface DisposableLike {
  dispose?: () => void;
}

interface N8AOConfiguration {
  aoSamples: number;
  aoRadius: number;
  denoiseSamples: number;
  denoiseRadius: number;
  distanceFalloff: number;
  intensity: number;
  denoiseIterations: number;
  biasOffset: number;
  biasMultiplier: number;
  color: T.Color;
  gammaCorrection: boolean;
  halfRes: boolean;
  depthAwareUpsampling: boolean;
  colorMultiply: boolean;
  transparencyAware: boolean;
  accumulate: boolean;
  neuralDenoise: boolean;
}

type N8AOPostPassLike = Pass & {
  autoDetectTransparency: boolean;
  configuration: N8AOConfiguration;
  firstFrame?: () => void;
  writeTargetInternal?: DisposableLike | null;
  readTargetInternal?: DisposableLike | null;
  outputTargetInternal?: DisposableLike | null;
  accumulationRenderTarget?: DisposableLike | null;
  depthDownsampleTarget?: DisposableLike | null;
  depthMipAtlas?: DisposableLike | null;
  bluenoise?: DisposableLike | null;
  effectShaderQuad?: DisposableLike | null;
  poissonBlurQuad?: DisposableLike | null;
  effectCompositerQuad?: DisposableLike | null;
  depthDownsampleQuad?: DisposableLike | null;
  copyQuad?: DisposableLike | null;
  accumulationQuad?: DisposableLike | null;
  standardDenoiseMaterial?: DisposableLike | null;
  neuralDenoiseMaterial?: DisposableLike | null;
  configureDenoisePass?: (...args: unknown[]) => unknown;
  standardCompositerMaterial?: DisposableLike | null;
  neuralCompositerMaterial?: DisposableLike | null;
  transparencyRenderTargetDWFalse?: DisposableLike | null;
  transparencyRenderTargetDWTrue?: DisposableLike | null;
  depthCopyPass?: DisposableLike | null;
};

type N8AOPostPassCtor = new (
  scene: T.Scene,
  camera: T.Camera,
  width?: number,
  height?: number,
) => N8AOPostPassLike;

const N8AOPostPassClass = RawN8AOPostPass as unknown as N8AOPostPassCtor;

function disposeN8aoPassResources(pass: N8AOPostPassLike): void {
  const targets: (DisposableLike | null | undefined)[] = [
    pass.writeTargetInternal,
    pass.readTargetInternal,
    pass.outputTargetInternal,
    pass.accumulationRenderTarget,
    pass.depthDownsampleTarget,
    pass.depthMipAtlas,
    pass.bluenoise,
    pass.effectShaderQuad,
    pass.poissonBlurQuad,
    pass.effectCompositerQuad,
    pass.depthDownsampleQuad,
    pass.copyQuad,
    pass.accumulationQuad,
    pass.standardDenoiseMaterial,
    pass.neuralDenoiseMaterial,
    pass.standardCompositerMaterial,
    pass.neuralCompositerMaterial,
    pass.transparencyRenderTargetDWFalse,
    pass.transparencyRenderTargetDWTrue,
    pass.depthCopyPass,
  ];
  for (let i = 0; i < targets.length; i++) {
    try {
      targets[i]?.dispose?.();
    } catch {
      // Best-effort cleanup on internal N8AO buffers.
    }
  }
}

export interface PostFXRenderOptions {
  /** True when Study Space is in cutaway Overview mode over the transparent page wallpaper. */
  readonly isOverviewAlpha?: boolean;
  /** Kept for caller compatibility; active water no longer bypasses `EffectComposer`. */
  readonly waterFluidActive?: boolean;
  /** Optional `WaterView` reference for zero-copy linear HDR fluid compositing inside `EffectComposer`. */
  readonly waterView?: WaterView | null;
  /** Optional stage root transform used by `WaterView`. */
  readonly waterStage?: T.Object3D | null;
  /** Optional scene override (updates composer main scene when changed). */
  readonly scene?: T.Scene;
  /** Optional camera override (updates composer main camera when changed). */
  readonly camera?: T.Camera;
  /**
   * Optional cached list of non-SSAO scene objects temporarily hidden ONLY if the legacy `ScopedNormalPass`
   * fallback is active (unused and zero-cost when depth-only `N8AOPostPass` is active).
   */
  readonly normalPassExclude?: readonly T.Object3D[];
}

const EMPTY_EXCLUDES: readonly T.Object3D[] = Object.freeze([]);

/**
 * Zero-extra-pass HDR NaN/Inf sanitizer merged into the primary `EffectPass`:
 * protects `HalfFloatType` AgX tone mapping and screen compositing against rare grazing-angle /
 * near-plane `NaN` radiance spikes without allocating an extra render target or pass.
 */
class HdrSanitizeEffect extends Effect {
  constructor() {
    super(
      'HdrSanitizeEffect',
      `void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = inputColor.rgb;
        if (!(c.r >= 0.0 && c.r < 65000.0)) c.r = 0.0;
        if (!(c.g >= 0.0 && c.g < 65000.0)) c.g = 0.0;
        if (!(c.b >= 0.0 && c.b < 65000.0)) c.b = 0.0;
        outputColor = vec4(min(c, vec3(32.0)), inputColor.a);
      }`,
      { blendFunction: BlendFunction.SET },
    );
  }
}

/**
 * Legacy fallback `NormalPass` (only allocated when `N8AOPostPass` is unavailable or throws).
 * On normal desktop WebGL2 runs, `N8AOPostPass` runs depth-only with ZERO `NormalPass` draws!
 */
class ScopedNormalPass extends NormalPass {
  private sourceCamera: T.Camera;
  private readonly maxDistance: number;
  private readonly proxyCamera = new T.PerspectiveCamera();
  private lastFov = -1;
  private lastAspect = -1;
  private lastZoom = -1;
  private lastNear = -1;
  private lastFar = -1;
  private excludes: readonly T.Object3D[] = EMPTY_EXCLUDES;
  private readonly hiddenScratch: T.Object3D[] = [];

  constructor(scene: T.Scene, camera: T.Camera, resolutionScale: number, maxDistance: number) {
    super(scene, camera, { resolutionScale });
    this.sourceCamera = camera;
    this.maxDistance = maxDistance;
    this.proxyCamera.matrixAutoUpdate = false;
    this.proxyCamera.matrixWorldAutoUpdate = false;
  }

  override set mainCamera(value: T.Camera) {
    this.sourceCamera = value;
    super.mainCamera = value;
  }

  setExcludes(nodes: readonly T.Object3D[]): void {
    this.excludes = nodes;
  }

  override render(
    renderer: T.WebGLRenderer,
    inputBuffer: T.WebGLRenderTarget,
    outputBuffer: T.WebGLRenderTarget,
    deltaTime?: number,
    stencilTest?: boolean,
  ): void {
    const excludes = this.excludes;
    const hidden = this.hiddenScratch;
    hidden.length = 0;

    for (let i = 0; i < excludes.length; i++) {
      const node = excludes[i];
      if (node && node.visible) {
        node.visible = false;
        hidden.push(node);
      }
    }

    const src = this.sourceCamera;
    let swappedCamera = false;
    try {
      if (src instanceof T.PerspectiveCamera && src.far > this.maxDistance) {
        const proxy = this.proxyCamera;
        proxy.matrixWorld.copy(src.matrixWorld);
        proxy.matrixWorldInverse.copy(src.matrixWorldInverse);
        proxy.layers.mask = src.layers.mask;
        const clampedFar = Math.max(src.near + 2, this.maxDistance);
        if (
          this.lastFov !== src.fov ||
          this.lastAspect !== src.aspect ||
          this.lastZoom !== src.zoom ||
          this.lastNear !== src.near ||
          this.lastFar !== clampedFar
        ) {
          proxy.fov = src.fov;
          proxy.aspect = src.aspect;
          proxy.zoom = src.zoom;
          proxy.near = src.near;
          proxy.far = clampedFar;
          proxy.updateProjectionMatrix();
          this.lastFov = src.fov;
          this.lastAspect = src.aspect;
          this.lastZoom = src.zoom;
          this.lastNear = src.near;
          this.lastFar = clampedFar;
        }
        super.mainCamera = proxy;
        swappedCamera = true;
      }
      super.render(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest);
    } finally {
      if (swappedCamera) {
        super.mainCamera = src;
      }
      for (let i = 0; i < hidden.length; i++) {
        hidden[i].visible = true;
      }
      hidden.length = 0;
    }
  }
}

export interface PostFXDiagnostics {
  readonly tier: QualityTier;
  readonly composerReady: boolean;
  readonly lastFrameUsedPostFx: boolean;
  readonly halfFloat: boolean;
  /** True when either `N8AOPostPass` or fallback `SSAOEffect` is active. */
  readonly ssaoActive: boolean;
  /** True specifically when depth-only `N8AOPostPass` is active (0 NormalPass draws). */
  readonly n8aoActive: boolean;
  readonly aoMode: 'off' | 'n8ao' | 'ssao';
  readonly depthDownsamplingActive: boolean;
  readonly bloomActive: boolean;
  readonly smaaPreset: 'off' | 'high' | 'ultra';
  readonly fallbackReason: string | null;
}

/**
 * Zero-copy linear HDR screen-space fluid pass inserted after AO and before `HdrSanitize + Bloom + AgX`.
 * Disabled (`enabled = false`, 0 GPU cost, 0 swaps) whenever `waterView.activeCount === 0`.
 */
class WaterCompositePass extends Pass {
  private activeCamera: T.Camera;
  private depthTexture: T.Texture | null = null;
  private waterView: WaterView | null = null;
  private waterStage: T.Object3D | null = null;
  warmupActive = false;

  constructor(camera: T.Camera) {
    super('WaterCompositePass');
    this.activeCamera = camera;
    super.mainCamera = camera;
    this.needsSwap = true;
    this.needsDepthTexture = true;
    this.enabled = false;
  }

  override set mainCamera(value: T.Camera) {
    this.activeCamera = value;
    super.mainCamera = value;
  }

  override getDepthTexture(): T.Texture {
    return this.depthTexture as T.Texture;
  }

  override setDepthTexture(depthTexture: T.Texture): void {
    this.depthTexture = depthTexture ?? null;
  }

  setWater(waterView: WaterView | null, stage: T.Object3D | null): void {
    this.waterView = waterView;
    this.waterStage = stage;
    this.syncEnabled();
  }

  syncEnabled(): void {
    const w = this.waterView;
    this.enabled = Boolean(w && w.ready && (this.warmupActive || w.activeCount > 0));
  }

  override render(
    renderer: T.WebGLRenderer,
    inputBuffer: T.WebGLRenderTarget | null,
    outputBuffer: T.WebGLRenderTarget | null,
  ): void {
    const w = this.waterView;
    if (!w || !inputBuffer) return;
    const target = this.renderToScreen ? null : outputBuffer;
    if (this.warmupActive) {
      w.warmupPostFx(renderer, this.activeCamera, this.waterStage, inputBuffer.texture, this.depthTexture, target);
      return;
    }
    w.renderPostFx(renderer, this.activeCamera, this.waterStage, inputBuffer.texture, this.depthTexture, target);
  }
}

/**
 * Pure guard determining whether a frame executes the HDR `EffectComposer` stack
 * or bypasses directly to `renderer.render(scene, camera)` (Cutaway Overview alpha only).
 * Active `WaterView` no longer drops `EffectComposer`, eliminating shader-define flips and visual pop.
 */
export function shouldUsePostFx(
  tier: QualityTier,
  isOverviewAlpha: boolean,
  _waterFluidActive = false,
): boolean {
  void _waterFluidActive;
  if (isOverviewAlpha) return false;
  return RENDER_CONFIGS[tier].postfx.enabled;
}

export class PostFXController {
  private readonly renderer: T.WebGLRenderer;
  private scene: T.Scene;
  private camera: T.Camera;
  private tierValue: QualityTier;

  private composer: EffectComposer | null = null;
  private n8aoPass: N8AOPostPassLike | null = null;
  private scopedNormalPass: ScopedNormalPass | null = null;
  private waterCompositePass: WaterCompositePass | null = null;
  private waterView: WaterView | null = null;
  private waterStage: T.Object3D | null = null;
  private builtForTier: QualityTier | null = null;
  private builtForOrtho = false;
  private width = 0;
  private height = 0;
  private disposed = false;
  private n8aoFailed = false;
  private cachedFog: T.FogExp2 | null = null;

  private lastFrameUsedPostFx = false;
  private halfFloatActive = false;
  private ssaoActive = false;
  private n8aoActive = false;
  private aoModeActive: 'off' | 'n8ao' | 'ssao' = 'off';
  private depthDownsamplingActive = false;
  private bloomActive = false;
  private smaaPresetActive: 'off' | 'high' | 'ultra' = 'off';
  private fallbackReason: string | null = null;

  constructor(
    renderer: T.WebGLRenderer,
    scene: T.Scene,
    camera: T.Camera,
    initialTier: QualityTier = 'balanced',
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.tierValue = initialTier;

    const size = renderer.getSize(new T.Vector2());
    this.width = Math.max(1, Math.floor(size.x));
    this.height = Math.max(1, Math.floor(size.y));
  }

  get tier(): QualityTier {
    return this.tierValue;
  }

  get composerReady(): boolean {
    return this.composer !== null;
  }

  get active(): boolean {
    return this.lastFrameUsedPostFx;
  }

  /** Exposes active composer HDR input buffer for optional integrations (e.g. WaterView). */
  get inputBuffer(): T.WebGLRenderTarget | null {
    return this.composer?.inputBuffer ?? null;
  }

  /** Binds `WaterView` and `stage` so active fluid streams composite in linear HDR inside `EffectComposer`. */
  setWaterView(waterView: WaterView | null, stage: T.Object3D | null = null): void {
    this.waterView = waterView;
    this.waterStage = stage;
    this.waterCompositePass?.setWater(waterView, stage);
  }

  get diagnostics(): PostFXDiagnostics {
    return {
      tier: this.tierValue,
      composerReady: this.composer !== null,
      lastFrameUsedPostFx: this.lastFrameUsedPostFx,
      halfFloat: this.halfFloatActive,
      ssaoActive: this.ssaoActive,
      n8aoActive: this.n8aoActive,
      aoMode: this.aoModeActive,
      depthDownsamplingActive: this.depthDownsamplingActive,
      bloomActive: this.bloomActive,
      smaaPreset: this.smaaPresetActive,
      fallbackReason: this.fallbackReason,
    };
  }

  setTier(tier: QualityTier): void {
    if (this.disposed || tier === this.tierValue) return;
    this.tierValue = tier;
    this.fallbackReason = null;

    if (!RENDER_CONFIGS[tier].postfx.enabled || this.builtForTier !== tier) {
      this.disposeComposer();
    }
  }

  setSceneCamera(scene: T.Scene, camera: T.Camera): void {
    const sceneChanged = scene !== this.scene;
    const cameraChanged = camera !== this.camera;
    const nextOrtho = (camera as T.OrthographicCamera).isOrthographicCamera === true;
    this.scene = scene;
    this.camera = camera;

    if (!this.composer) return;
    if (this.n8aoPass && nextOrtho !== this.builtForOrtho) {
      // N8AO compiles an `#ifdef ORTHO` shader branch; rebuild cleanly if projection type switches.
      this.disposeComposer();
      return;
    }
    if (sceneChanged) {
      this.composer.setMainScene(scene);
      if (this.n8aoPass) this.n8aoPass.mainScene = scene;
    }
    if (cameraChanged) {
      this.composer.setMainCamera(camera);
      if (this.n8aoPass) {
        this.n8aoPass.mainCamera = camera;
        this.n8aoPass.firstFrame?.();
      }
    }
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;

    if (this.composer) {
      this.composer.setSize(w, h, false);
    }
  }

  /**
   * Builds the EffectComposer + N8AO + Bloom + patched SMAA stack eagerly behind the loading overlay
   * so first-frame reveal never stalls on composer allocation or SMAA WebGL2 shader patching.
   */
  prewarmComposer(): void {
    if (this.disposed) return;
    if (!RENDER_CONFIGS[this.tierValue].postfx.enabled || this.fallbackReason !== null) return;
    if (this.composer && this.builtForTier === this.tierValue) return;
    this.buildComposer(this.tierValue);
  }

  /**
   * Returns the exact render target used for main-scene rendering on the active tier so
   * `safeCompileAsync()` compiles against the exact `(outputColorSpace, toneMapping)` tuple:
   * - `high`/`ultra` (PostFX active): `composer.inputBuffer` (`HalfFloatType`, `LinearSRGB`, `NoToneMapping`)
   * - `low`/`balanced` (or PostFX fallback): `null` (`SRGB`, `AgXToneMapping`)
   */
  getWarmupRenderTarget(): T.WebGLRenderTarget | null {
    if (this.disposed) return null;
    if (!RENDER_CONFIGS[this.tierValue].postfx.enabled || this.fallbackReason !== null) return null;
    this.prewarmComposer();
    if (!this.composer) return null;
    const composerInternal = this.composer as unknown as {
      inputBuffer?: T.WebGLRenderTarget | null;
    };
    return composerInternal.inputBuffer ?? null;
  }

  /**
   * Executes one `1x1`-scissored PostFX pipeline warmup pass (`rt.scissor` on `inputBuffer` & `outputBuffer`
   * + backbuffer scissor) so every PostFX shader (`RenderPass`, `N8AOPostPass` + `outputTargetInternal` HalfFloat
   * sync + `DepthMipAtlas` + `DepthDownsample` + `standardDenoiseMaterial`, `HdrSanitizeEffect`, `BloomEffect`,
   * `ToneMappingEffect`, `ColorGradeEffect`, `SMAAEffect`) compiles, links, and warms its D3D11 PSOs BEFORE unlock!
   *
   * Note: Clears full `inputBuffer` depth to `1.0` prior to enabling `1x1` scissor so N8AO's background-depth
   * early-out skips 99.9999% of pixels (`< 1 ms` GPU cost) while still compiling & validating all passes.
   */
  warmupPasses(dt = 0.016): boolean {
    if (this.disposed) return false;
    if (!RENDER_CONFIGS[this.tierValue].postfx.enabled || this.fallbackReason !== null) return false;
    this.prewarmComposer();
    const composer = this.composer;
    if (!composer) return false;

    const composerInternal = composer as unknown as {
      inputBuffer?: T.WebGLRenderTarget | null;
      outputBuffer?: T.WebGLRenderTarget | null;
    };
    const inputBuffer = composerInternal.inputBuffer ?? null;
    const outputBuffer = composerInternal.outputBuffer ?? null;

    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevTone = renderer.toneMapping;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    const prevViewport = new T.Vector4();
    const prevScissor = new T.Vector4();
    const prevScissorTest = renderer.getScissorTest();
    renderer.getViewport(prevViewport);
    renderer.getScissor(prevScissor);

    const savedInScissor = inputBuffer ? inputBuffer.scissor.clone() : null;
    const savedInScissorTest = inputBuffer ? inputBuffer.scissorTest : false;
    const savedOutScissor = outputBuffer ? outputBuffer.scissor.clone() : null;
    const savedOutScissorTest = outputBuffer ? outputBuffer.scissorTest : false;

    try {
      // Clear full inputBuffer depth to 1.0 (far plane) so N8AO early-outs non-warmup pixels in < 0.5 ms.
      if (inputBuffer) {
        inputBuffer.scissorTest = false;
        renderer.setRenderTarget(inputBuffer);
        renderer.clear(true, true, true);
        inputBuffer.scissor.set(0, 0, 1, 1);
        inputBuffer.scissorTest = true;
      }
      if (outputBuffer) {
        outputBuffer.scissor.set(0, 0, 1, 1);
        outputBuffer.scissorTest = true;
      }

      renderer.setRenderTarget(null);
      renderer.setScissor(0, 0, 1, 1);
      renderer.setScissorTest(true);
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.autoClear = false;
      renderer.toneMapping = T.NoToneMapping;

      if (this.waterCompositePass && this.waterView) {
        this.waterCompositePass.setWater(this.waterView, this.waterStage);
        this.waterCompositePass.warmupActive = true;
        this.waterCompositePass.syncEnabled();
      }

      composer.render(dt);
      return true;
    } catch {
      return false;
    } finally {
      if (this.waterCompositePass) {
        this.waterCompositePass.warmupActive = false;
        this.waterCompositePass.syncEnabled();
      }
      if (inputBuffer && savedInScissor) {
        inputBuffer.scissor.copy(savedInScissor);
        inputBuffer.scissorTest = savedInScissorTest;
      }
      if (outputBuffer && savedOutScissor) {
        outputBuffer.scissor.copy(savedOutScissor);
        outputBuffer.scissorTest = savedOutScissorTest;
      }

      // Clear warmup buffers cleanly so zero 1x1 warmup pixels bleed into Frame 1.
      renderer.setScissorTest(false);
      if (inputBuffer) {
        renderer.setRenderTarget(inputBuffer);
        renderer.clear(true, true, true);
      }
      if (outputBuffer) {
        renderer.setRenderTarget(outputBuffer);
        renderer.clear(true, true, true);
      }
      renderer.setRenderTarget(null);
      renderer.clear(true, true, true);

      renderer.setRenderTarget(prevTarget);
      renderer.toneMapping = prevTone;
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.shadowMap.needsUpdate = prevShadowNeeds;
      renderer.setViewport(prevViewport);
      renderer.setScissor(prevScissor);
      renderer.setScissorTest(prevScissorTest);
    }
  }

  render(dt: number, options: PostFXRenderOptions = {}): boolean {
    if (this.disposed) return false;

    const scene = options.scene ?? this.scene;
    const camera = options.camera ?? this.camera;
    if (scene !== this.scene || camera !== this.camera) {
      this.setSceneCamera(scene, camera);
    }

    const isOverviewAlpha = Boolean(options.isOverviewAlpha);
    if (options.waterView !== undefined || options.waterStage !== undefined) {
      this.setWaterView(options.waterView ?? this.waterView, options.waterStage ?? this.waterStage);
    }

    // Keep `scene.fog` continuously bound as a `FogExp2` (density = 0 indoors) during Echo Life exploration
    // instead of toggling `scene.fog = null`, eliminating `USE_FOG` shader permutation doubling on door crossings!
    if (scene.fog instanceof T.FogExp2) {
      this.cachedFog = scene.fog;
    } else if (!isOverviewAlpha && scene.fog === null && this.cachedFog) {
      this.cachedFog.density = 0;
      scene.fog = this.cachedFog;
    }

    if (!shouldUsePostFx(this.tierValue, isOverviewAlpha) || this.fallbackReason !== null) {
      this.renderDirect();
      return false;
    }

    if (!this.composer || this.builtForTier !== this.tierValue) {
      if (!this.buildComposer(this.tierValue)) {
        this.renderDirect();
        return false;
      }
    }

    const composer = this.composer;
    if (!composer) {
      this.renderDirect();
      return false;
    }

    const prevAutoClear = this.renderer.autoClear;
    try {
      this.scopedNormalPass?.setExcludes(options.normalPassExclude ?? EMPTY_EXCLUDES);
      this.waterCompositePass?.syncEnabled();
      this.renderer.autoClear = false;
      composer.render(dt);
      this.lastFrameUsedPostFx = true;
      return true;
    } catch (err) {
      // If N8AO threw during runtime execution, gracefully rebuild once using the SSAOEffect fallback!
      if (this.n8aoActive && !this.n8aoFailed) {
        this.n8aoFailed = true;
        this.disposeComposer();
        if (this.buildComposer(this.tierValue) && this.composer) {
          try {
            this.scopedNormalPass?.setExcludes(options.normalPassExclude ?? EMPTY_EXCLUDES);
            this.waterCompositePass?.syncEnabled();
            this.renderer.autoClear = false;
            this.composer.render(dt);
            this.lastFrameUsedPostFx = true;
            return true;
          } catch (fallbackErr) {
            this.fallbackReason = fallbackErr instanceof Error ? fallbackErr.message : 'postfx-fallback-error';
          }
        }
      } else {
        this.fallbackReason = err instanceof Error ? err.message : 'postfx-render-error';
      }
      this.disposeComposer();
      this.renderDirect();
      return false;
    } finally {
      this.scopedNormalPass?.setExcludes(EMPTY_EXCLUDES);
      this.renderer.autoClear = prevAutoClear;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeComposer();
  }

  private renderDirect(): void {
    this.renderer.autoClear = true;
    this.renderer.render(this.scene, this.camera);
    this.lastFrameUsedPostFx = false;
  }

  private buildComposer(tier: QualityTier): boolean {
    this.disposeComposer();

    const cfg = RENDER_CONFIGS[tier].postfx;
    if (!cfg.enabled) return false;

    const renderer = this.renderer;
    const prevAutoClear = renderer.autoClear;
    const isWebGL2 = renderer.capabilities.isWebGL2;
    const hasColorBufferFloat = isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
    const hasHalfFloatRenderTarget =
      hasColorBufferFloat ||
      (isWebGL2 && renderer.extensions.has('EXT_color_buffer_half_float')) ||
      renderer.extensions.has('EXT_color_buffer_half_float');
    const useHalfFloat = cfg.halfFloat && hasHalfFloatRenderTarget;

    let composer: EffectComposer | null = null;
    let n8aoRef: N8AOPostPassLike | null = null;
    try {
      // Strictly HalfFloatType (never FloatType composer buffer — protects iOS WebKit & saves 2x bandwidth).
      composer = new EffectComposer(renderer, {
        depthBuffer: true,
        stencilBuffer: false,
        multisampling: 0,
        frameBufferType: useHalfFloat ? T.HalfFloatType : T.UnsignedByteType,
      });

      const renderPass = new RenderPass(this.scene, this.camera);
      composer.addPass(renderPass);

      const primaryEffects: Effect[] = [];
      let n8aoBuilt = false;
      let ssaoBuilt = false;
      let depthDownsamplingBuilt = false;
      let normalPassRef: ScopedNormalPass | null = null;

      // Primary AO path: depth-only half-res N8AOPostPass (0 extra NormalPass geometry draw calls!).
      // Gated on `hasColorBufferFloat` because N8AO's half-res depth downsample uses an internal R32F target.
      if (cfg.n8ao.enabled && isWebGL2 && hasColorBufferFloat && !this.n8aoFailed) {
        try {
          const n8 = new N8AOPostPassClass(this.scene, this.camera, this.width, this.height);
          // Immediately disable N8AO's expensive per-frame scene-traverse transparency pass!
          n8.autoDetectTransparency = false;
          n8.configuration.transparencyAware = false;
          n8.configuration.gammaCorrection = false;
          n8.configuration.halfRes = cfg.n8ao.halfRes;
          if (cfg.n8ao.depthAwareUpsampling) {
            n8.configuration.depthAwareUpsampling = true;
          }
          n8.configuration.aoRadius = cfg.n8ao.aoRadius;
          n8.configuration.distanceFalloff = cfg.n8ao.distanceFalloff;
          n8.configuration.intensity = cfg.n8ao.intensity;
          n8.configuration.aoSamples = cfg.n8ao.aoSamples;
          n8.configuration.denoiseSamples = cfg.n8ao.denoiseSamples;
          n8.configuration.denoiseRadius = cfg.n8ao.denoiseRadius;
          n8.configuration.denoiseIterations = cfg.n8ao.denoiseIterations;
          n8.configuration.biasOffset = cfg.n8ao.biasOffset;
          n8.configuration.biasMultiplier = cfg.n8ao.biasMultiplier;
          n8.configuration.color = new T.Color(cfg.n8ao.color);
          n8.configuration.colorMultiply = true;
          n8.configuration.accumulate = false;
          n8.configuration.neuralDenoise = false;

          // Patch N8AO denoise loop on WebGL2 so dynamic-count blur taps (`tDiffuse` AND `sceneDepth`
          // at N8AO.js:1130,1133) plus branched `blueNoise` lookups sample mip 0 explicitly via `textureLod`,
          // eliminating ANGLE/D3D11 `warning X3595: gradient instruction used in a loop with varying iteration`.
          const patchDenoiseMat = (mat: T.ShaderMaterial | null | undefined) => {
            if (!mat || typeof mat.fragmentShader !== 'string') return;
            const patched = mat.fragmentShader
              .replace(
                /texture2D\s*\(\s*tDiffuse\s*,\s*uv\s*\+\s*offset\s*\)/g,
                'textureLod(tDiffuse, uv + offset, 0.0)',
              )
              .replace(
                /texture2D\s*\(\s*sceneDepth\s*,\s*uv\s*\+\s*offset\s*\)/g,
                'textureLod(sceneDepth, uv + offset, 0.0)',
              )
              .replace(
                /texture2D\s*\(\s*blueNoise\s*,\s*gl_FragCoord\.xy\s*\/\s*128\.0\s*\)/g,
                'textureLod(blueNoise, gl_FragCoord.xy / 128.0, 0.0)',
              );
            if (patched !== mat.fragmentShader) {
              mat.fragmentShader = patched;
              mat.needsUpdate = true;
            }
          };
          const applyN8DenoisePatches = () => {
            patchDenoiseMat(n8.standardDenoiseMaterial as T.ShaderMaterial | null | undefined);
            patchDenoiseMat(n8.neuralDenoiseMaterial as T.ShaderMaterial | null | undefined);
          };
          applyN8DenoisePatches();
          // Re-apply automatically if N8AO rebuilds its denoise shaders (e.g. on depthBufferType/camera change).
          if (typeof n8.configureDenoisePass === 'function') {
            const origConfigureDenoise = n8.configureDenoisePass.bind(n8);
            n8.configureDenoisePass = (...args: unknown[]) => {
              const res = origConfigureDenoise(...args);
              applyN8DenoisePatches();
              return res;
            };
          }

          composer.addPass(n8);
          n8aoRef = n8;
          n8aoBuilt = true;
          ssaoBuilt = true;
        } catch {
          this.n8aoFailed = true;
          if (n8aoRef) {
            disposeN8aoPassResources(n8aoRef);
            n8aoRef = null;
          }
        }
      }

      // Graceful fallback to ScopedNormalPass + SSAOEffect when N8AO is unavailable or threw.
      if (!n8aoBuilt && cfg.ssao.enabled && isWebGL2) {
        const ssaoFarCutoff = Math.min(44, cfg.ssao.worldDistanceThreshold + cfg.ssao.worldDistanceFalloff + 4);
        const normalPass = new ScopedNormalPass(
          this.scene,
          this.camera,
          cfg.ssao.resolutionScale,
          ssaoFarCutoff,
        );
        normalPassRef = normalPass;
        composer.addPass(normalPass);

        let depthDownsamplingPass: DepthDownsamplingPass | null = null;
        if (hasColorBufferFloat) {
          depthDownsamplingPass = new DepthDownsamplingPass({
            normalBuffer: normalPass.texture,
            resolutionScale: cfg.ssao.resolutionScale,
          });
          composer.addPass(depthDownsamplingPass);
          depthDownsamplingBuilt = true;
        }

        const ssaoEffect = new SSAOEffect(this.camera, normalPass.texture, {
          blendFunction: BlendFunction.MULTIPLY,
          normalDepthBuffer: depthDownsamplingPass?.texture,
          depthAwareUpsampling: depthDownsamplingBuilt,
          resolutionScale: cfg.ssao.resolutionScale,
          samples: cfg.ssao.samples,
          rings: cfg.ssao.rings,
          radius: cfg.ssao.radius,
          minRadiusScale: cfg.ssao.minRadiusScale,
          intensity: cfg.ssao.intensity,
          luminanceInfluence: cfg.ssao.luminanceInfluence,
          bias: cfg.ssao.bias,
          fade: cfg.ssao.fade,
          worldDistanceThreshold: cfg.ssao.worldDistanceThreshold,
          worldDistanceFalloff: cfg.ssao.worldDistanceFalloff,
          worldProximityThreshold: cfg.ssao.worldProximityThreshold,
          worldProximityFalloff: cfg.ssao.worldProximityFalloff,
        });
        primaryEffects.push(ssaoEffect);
        ssaoBuilt = true;
      }

      // Zero-copy linear HDR screen-space fluid composite (disabled at 0 cost when `waterView.activeCount === 0`).
      const waterCompositePass = new WaterCompositePass(this.camera);
      waterCompositePass.setWater(this.waterView, this.waterStage);
      composer.addPass(waterCompositePass);

      // Sanitize NaN/Inf/overflow HDR pixels in-place (zero extra passes) before Bloom/AgX so a single
      // degenerate HalfFloat pixel can never propagate across mipmapBlur levels into a black square!
      primaryEffects.push(new HdrSanitizeEffect());

      // Selective HDR Bloom (threshold 1.38–1.40 eliminates white hair specular bloom orbs, G-08).
      let bloomBuilt = false;
      if (cfg.bloom.enabled) {
        const bloomEffect = new BloomEffect({
          blendFunction: BlendFunction.ADD,
          mipmapBlur: cfg.bloom.mipmapBlur,
          luminanceThreshold: cfg.bloom.luminanceThreshold,
          luminanceSmoothing: cfg.bloom.luminanceSmoothing,
          intensity: cfg.bloom.intensity,
          radius: cfg.bloom.radius,
          levels: cfg.bloom.levels,
        });
        const lumMat = (bloomEffect as unknown as { luminanceMaterial?: T.ShaderMaterial }).luminanceMaterial;
        if (lumMat && typeof lumMat.fragmentShader === 'string') {
          lumMat.fragmentShader = lumMat.fragmentShader.replace(
            'vec4 texel=texture2D(inputBuffer,vUv);',
            'vec4 texel=texture2D(inputBuffer,vUv);if(!(texel.r>=0.0&&texel.r<65000.0))texel.r=0.0;if(!(texel.g>=0.0&&texel.g<65000.0))texel.g=0.0;if(!(texel.b>=0.0&&texel.b<65000.0))texel.b=0.0;texel.rgb=min(texel.rgb,vec3(16.0));',
          );
          lumMat.needsUpdate = true;
        }
        primaryEffects.push(bloomEffect);
        bloomBuilt = true;
      }

      // AgX Tone Mapping + Subtle Punchy Color Grading (all merged into ONE EffectPass!).
      const toneMappingEffect = new ToneMappingEffect({
        mode: cfg.toneMapping === 'aces' ? ToneMappingMode.ACES_FILMIC : ToneMappingMode.AGX,
      });
      primaryEffects.push(toneMappingEffect);

      if (cfg.colorGrading.enabled) {
        if (Math.abs(cfg.colorGrading.brightness) > 1e-4 || Math.abs(cfg.colorGrading.contrast) > 1e-4) {
          primaryEffects.push(
            new BrightnessContrastEffect({
              brightness: cfg.colorGrading.brightness,
              contrast: cfg.colorGrading.contrast,
            }),
          );
        }
        if (Math.abs(cfg.colorGrading.saturation) > 1e-4) {
          primaryEffects.push(
            new HueSaturationEffect({
              hue: 0,
              saturation: cfg.colorGrading.saturation,
            }),
          );
        }
        if (cfg.colorGrading.vignetteDarkness > 1e-4) {
          primaryEffects.push(
            new VignetteEffect({
              offset: cfg.colorGrading.vignetteOffset,
              darkness: cfg.colorGrading.vignetteDarkness,
            }),
          );
        }
      }

      const hdrAndTonePass = new EffectPass(this.camera, ...primaryEffects);
      composer.addPass(hdrAndTonePass);

      if (cfg.smaa !== 'off') {
        const smaaEffect = new SMAAEffect({
          preset: cfg.smaa === 'ultra' ? SMAAPreset.ULTRA : SMAAPreset.HIGH,
          edgeDetectionMode: EdgeDetectionMode.COLOR,
        });
        // Patch SMAA blending-weight & neighborhood shaders on WebGL2 so dynamic-break search loops
        // (`searchDiag1`, `searchDiag2`, `searchX*`, `searchY*`) sample explicit mip 0 via `textureLod`
        // (eliminating ANGLE/D3D11 `warning X3595: gradient instruction used in a loop with varying iteration`).
        if (renderer.capabilities.isWebGL2) {
          const smaaInternal = smaaEffect as unknown as {
            weightsMaterial?: T.ShaderMaterial;
            weightsPass?: { fullscreenMaterial?: T.ShaderMaterial };
            fragmentShader?: string;
          };
          const weightsMat = smaaInternal.weightsMaterial ?? smaaInternal.weightsPass?.fullscreenMaterial;
          if (weightsMat && typeof weightsMat.fragmentShader === 'string') {
            weightsMat.fragmentShader = weightsMat.fragmentShader
              .replace(
                /#define\s+sampleLevelZeroOffset\(t,\s*coord,\s*offset\)\s+texture2D\(t,\s*coord\s*\+\s*offset\s*\*\s*texelSize\)/,
                '#define sampleLevelZeroOffset(t, coord, offset) textureLod(t, coord + offset * texelSize, 0.0)',
              )
              .replace(/texture2D\s*\(\s*inputBuffer\s*,\s*coord\.xy\s*\)/g, 'textureLod(inputBuffer,coord.xy,0.0)')
              .replace(/texture2D\s*\(\s*inputBuffer\s*,\s*texCoord\s*\)/g, 'textureLod(inputBuffer,texCoord,0.0)')
              .replace(/texture2D\s*\(\s*inputBuffer\s*,\s*coords\.xy\s*\)/g, 'textureLod(inputBuffer,coords.xy,0.0)')
              .replace(/texture2D\s*\(\s*areaTexture\s*,\s*texCoord\s*\)/g, 'textureLod(areaTexture,texCoord,0.0)')
              .replace(
                /texture2D\s*\(\s*searchTexture\s*,\s*scale\s*\*\s*e\s*\+\s*bias\s*\)/g,
                'textureLod(searchTexture,scale*e+bias,0.0)',
              );
            weightsMat.needsUpdate = true;
          }
          if (typeof smaaInternal.fragmentShader === 'string') {
            smaaInternal.fragmentShader = smaaInternal.fragmentShader.replace(
              /texture2D\s*\(\s*inputBuffer\s*,\s*blendingCoord\.(xy|zw)\s*\)/g,
              'textureLod(inputBuffer,blendingCoord.$1,0.0)',
            );
          }
        }
        const smaaPass = new EffectPass(this.camera, smaaEffect);
        smaaPass.dithering = true;
        composer.addPass(smaaPass);
      } else {
        hdrAndTonePass.dithering = true;
      }

      if (this.width > 0 && this.height > 0) {
        composer.setSize(this.width, this.height, false);
      }

      this.composer = composer;
      this.n8aoPass = n8aoRef;
      this.scopedNormalPass = normalPassRef;
      this.waterCompositePass = waterCompositePass;
      this.builtForTier = tier;
      this.builtForOrtho = (this.camera as T.OrthographicCamera).isOrthographicCamera === true;
      this.halfFloatActive = useHalfFloat;
      this.ssaoActive = ssaoBuilt;
      this.n8aoActive = n8aoBuilt;
      this.aoModeActive = n8aoBuilt ? 'n8ao' : ssaoBuilt ? 'ssao' : 'off';
      this.depthDownsamplingActive = depthDownsamplingBuilt;
      this.bloomActive = bloomBuilt;
      this.smaaPresetActive = cfg.smaa;
      this.fallbackReason = null;
      return true;
    } catch (err) {
      if (n8aoRef) disposeN8aoPassResources(n8aoRef);
      composer?.dispose();
      this.composer = null;
      this.n8aoPass = null;
      this.scopedNormalPass = null;
      this.waterCompositePass = null;
      this.builtForTier = null;
      this.halfFloatActive = false;
      this.ssaoActive = false;
      this.n8aoActive = false;
      this.aoModeActive = 'off';
      this.depthDownsamplingActive = false;
      this.bloomActive = false;
      this.smaaPresetActive = 'off';
      this.fallbackReason = err instanceof Error ? err.message : 'postfx-init-error';
      return false;
    } finally {
      renderer.autoClear = prevAutoClear;
    }
  }

  private disposeComposer(): void {
    this.scopedNormalPass?.setExcludes(EMPTY_EXCLUDES);
    this.scopedNormalPass = null;
    this.waterCompositePass?.setWater(null, null);
    this.waterCompositePass = null;
    if (this.n8aoPass) {
      disposeN8aoPassResources(this.n8aoPass);
      this.n8aoPass = null;
    }
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }
    this.builtForTier = null;
    this.lastFrameUsedPostFx = false;
    this.halfFloatActive = false;
    this.ssaoActive = false;
    this.n8aoActive = false;
    this.aoModeActive = 'off';
    this.depthDownsamplingActive = false;
    this.bloomActive = false;
    this.smaaPresetActive = 'off';
    this.renderer.autoClear = true;
  }
}
