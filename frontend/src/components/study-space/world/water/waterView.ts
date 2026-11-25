import * as T from 'three';

/**
 * Zero-copy screen-space fluid renderer (Green 2010 bilateral sphere-depth + Beer-Lambert thickness):
 * - On HDR `PostFXController` tiers (`high` / `ultra`): `WaterCompositePass` invokes `renderPostFx()`,
 *   sampling `EffectComposer`'s linear HDR `inputBuffer.texture` (`uScene`) and `stableDepthTexture`
 *   (`uSceneDepth`) directly with ZERO `copyFramebufferToTexture`, ZERO `gl_FragDepth` in the fullscreen
 *   composite pass (Early-Z preserved), depth-gated foreground anti-ghosting refraction, and ZERO
 *   `PostFX` bypass (`0` scene shader-define flips, `0` N8AO/Bloom/AgX/SMAA visual pop).
 * - On non-PostFX tiers (`low` / `balanced` MSAA backbuffer / Overview alpha): `render()` composites
 *   via an MSAA-safe analytical translucent Fresnel + Beer-Lambert shader (`composeDirectMat`) with
 *   ZERO `copyFramebufferToTexture` (`0` WebGL2 multisampled-read `GL_INVALID_OPERATION`).
 */
const VERT_POINT = /* glsl */`
precision highp float;
uniform float uRadius, uScreen;
in vec3 tint;
out vec3 vView; out vec3 vTint;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.);
  vView = mv.xyz; vTint = tint;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uRadius * uScreen * projectionMatrix[1][1] / max(.05, -mv.z), 1., 256.);
}`;

const FRAG_DEPTH = /* glsl */`
precision highp float;
uniform float uRadius; uniform mat4 uProj;
in vec3 vView; layout(location = 0) out vec4 outC;
void main() {
  vec2 c = gl_PointCoord * 2. - 1.; c.y = -c.y;
  float d2 = dot(c, c); if (d2 > 1.) discard;
  vec3 p = vView + vec3(c, sqrt(1. - d2)) * uRadius;
  vec4 clip = uProj * vec4(p, 1.);
  gl_FragDepth = clamp(clip.z / clip.w * .5 + .5, 0., 1.);
  outC = vec4(-p.z, 0., 0., 1.);
}`;

const FRAG_THICK = /* glsl */`
precision highp float;
uniform float uRadius;
in vec3 vTint; layout(location = 0) out vec4 outC;
void main() {
  vec2 c = gl_PointCoord * 2. - 1.; float d2 = dot(c, c); if (d2 > 1.) discard;
  float t = uRadius * 2. * sqrt(1. - d2);
  outC = vec4(vTint * t, t);
}`;

const VERT_FS = /* glsl */`
out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

const FRAG_BLUR = /* glsl */`
precision highp float;
uniform sampler2D uTex; uniform vec2 uDir; uniform float uSigmaZ;
in vec2 vUv; layout(location = 0) out vec4 outC;
void main() {
  float c = textureLod(uTex, vUv, 0.0).r;
  if (c <= 0.) { outC = vec4(0.); return; }
  float sum = 0., w = 0.;
  for (int i = -9; i <= 9; i++) {
    float d = textureLod(uTex, vUv + uDir * float(i), 0.0).r;
    if (d <= 0.) continue;
    float g = exp(-float(i * i) / 32.), dz = (d - c) / uSigmaZ, k = g * exp(-dz * dz);
    sum += d * k; w += k;
  }
  outC = vec4(sum / max(w, 1e-5), 0., 0., 1.);
}`;

const FRAG_COMPOSE_POST = /* glsl */`
precision highp float;
uniform sampler2D uDepth, uThick, uScene, uSceneDepth;
uniform float uHasSceneDepth;
uniform mat4 uProj, uViewToWorld;
uniform vec2 uTexel;
uniform vec3 uSun, uLow, uHigh;
in vec2 vUv;
layout(location = 0) out vec4 outC;

vec3 viewAt(vec2 uv, float depth) {
  vec2 ndc = uv * 2. - 1.;
  return vec3((ndc.x + uProj[2][0]) / uProj[0][0] * depth, (ndc.y + uProj[2][1]) / uProj[1][1] * depth, -depth);
}

void main() {
  float d = textureLod(uDepth, vUv, 0.0).r;
  vec3 baseScene = textureLod(uScene, vUv, 0.0).rgb;
  if (d <= 0.) {
    outC = vec4(baseScene, 1.);
    return;
  }
  vec3 P = viewAt(vUv, d);
  vec4 clip = uProj * vec4(P, 1.);
  float waterDepth01 = clamp(clip.z / clip.w * .5 + .5, 0., 1.);
  if (uHasSceneDepth > 0.5) {
    float sceneDepth01 = textureLod(uSceneDepth, vUv, 0.0).r;
    if (waterDepth01 > sceneDepth01 + 1e-5) {
      outC = vec4(baseScene, 1.);
      return;
    }
  }

  float l = textureLod(uDepth, vUv - vec2(uTexel.x, 0.), 0.0).r;
  float r = textureLod(uDepth, vUv + vec2(uTexel.x, 0.), 0.0).r;
  float b = textureLod(uDepth, vUv - vec2(0., uTexel.y), 0.0).r;
  float t = textureLod(uDepth, vUv + vec2(0., uTexel.y), 0.0).r;
  vec3 dx = abs(l - d) < abs(r - d) && l > 0. ? P - viewAt(vUv - vec2(uTexel.x, 0.), l) : (r > 0. ? viewAt(vUv + vec2(uTexel.x, 0.), r) - P : vec3(1., 0., 0.));
  vec3 dy = abs(b - d) < abs(t - d) && b > 0. ? P - viewAt(vUv - vec2(0., uTexel.y), b) : (t > 0. ? viewAt(vUv + vec2(0., uTexel.y), t) - P : vec3(0., 1., 0.));
  vec3 N = normalize(cross(dx, dy));
  vec3 V = normalize(-P);
  if (dot(N, V) < 0.) N = -N;

  vec4 th = textureLod(uThick, vUv, 0.0);
  float cosT = max(dot(N, V), 0.);
  float thinNow = smoothstep(0., .022, th.a);
  float fresnel = (.03 + .97 * pow(1. - cosT, 5.)) * mix(.35, 1., thinNow);
  vec3 R = (uViewToWorld * vec4(reflect(-V, N), 0.)).xyz;
  vec3 roomLow = pow(max(uLow, vec3(0.)), vec3(2.2));
  vec3 roomHigh = pow(max(uHigh, vec3(0.)), vec3(2.2));
  vec3 room = mix(roomLow, roomHigh, smoothstep(-.35, .75, R.y));
  float ndl = max(dot(normalize(R), uSun), 0.);
  float sun = pow(ndl, 90.) * 2.4 + pow(ndl, 12.) * .18;
  vec3 through = exp(-th.rgb * 34.);

  float bend = min(.05, .012 + th.a * 1.1);
  vec2 off = N.xy * bend * vec2(uProj[1][1] / uProj[0][0], 1.) / max(.4, d * .9);
  vec2 refrUv = clamp(vUv + off, vec2(.001), vec2(.999));
  vec3 behind = baseScene;
  if (uHasSceneDepth <= 0.5 || textureLod(uSceneDepth, refrUv, 0.0).r >= waterDepth01 - .0004) {
    behind = textureLod(uScene, refrUv, 0.0).rgb;
  }

  float rim = pow(1. - cosT, 2.2);
  vec3 colour = behind * through * (1.02 - rim * .38) + room * fresnel * 1.08 + vec3(sun);
  float a = smoothstep(0., .007, th.a) * .985;
  outC = vec4(clamp(mix(baseScene, colour, a), vec3(0.), vec3(24.)), 1.);
}`;

const FRAG_COMPOSE_DIRECT = /* glsl */`
precision highp float;
uniform sampler2D uDepth, uThick;
uniform mat4 uProj, uViewToWorld;
uniform vec2 uTexel;
uniform vec3 uSun, uLow, uHigh;
in vec2 vUv;
layout(location = 0) out vec4 outC;

vec3 viewAt(vec2 uv, float depth) {
  vec2 ndc = uv * 2. - 1.;
  return vec3((ndc.x + uProj[2][0]) / uProj[0][0] * depth, (ndc.y + uProj[2][1]) / uProj[1][1] * depth, -depth);
}

void main() {
  float d = textureLod(uDepth, vUv, 0.0).r;
  if (d <= 0.) discard;
  vec3 P = viewAt(vUv, d);
  float l = textureLod(uDepth, vUv - vec2(uTexel.x, 0.), 0.0).r;
  float r = textureLod(uDepth, vUv + vec2(uTexel.x, 0.), 0.0).r;
  float b = textureLod(uDepth, vUv - vec2(0., uTexel.y), 0.0).r;
  float t = textureLod(uDepth, vUv + vec2(0., uTexel.y), 0.0).r;
  vec3 dx = abs(l - d) < abs(r - d) && l > 0. ? P - viewAt(vUv - vec2(uTexel.x, 0.), l) : (r > 0. ? viewAt(vUv + vec2(uTexel.x, 0.), r) - P : vec3(1., 0., 0.));
  vec3 dy = abs(b - d) < abs(t - d) && b > 0. ? P - viewAt(vUv - vec2(0., uTexel.y), b) : (t > 0. ? viewAt(vUv + vec2(0., uTexel.y), t) - P : vec3(0., 1., 0.));
  vec3 N = normalize(cross(dx, dy));
  vec3 V = normalize(-P);
  if (dot(N, V) < 0.) N = -N;

  vec4 th = textureLod(uThick, vUv, 0.0);
  float cosT = max(dot(N, V), 0.);
  float thinNow = smoothstep(0., .022, th.a);
  float fresnel = (.05 + .95 * pow(1. - cosT, 5.)) * mix(.38, 1., thinNow);
  vec3 R = (uViewToWorld * vec4(reflect(-V, N), 0.)).xyz;
  vec3 room = mix(uLow, uHigh, smoothstep(-.35, .75, R.y));
  float ndl = max(dot(normalize(R), uSun), 0.);
  float sun = pow(ndl, 90.) * 1.45 + pow(ndl, 12.) * .18;
  vec3 body = clamp(vec3(.76, .87, .94) * exp(-th.rgb * 28.), vec3(0.), vec3(1.));
  float coverage = smoothstep(0., .007, th.a);
  float alpha = clamp(((1. - exp(-th.a * 16.)) * .38 + fresnel * .88 + min(.55, sun * .35)) * coverage, 0., .94);
  vec3 colour = body * (1. - fresnel) * .52 + room * fresnel * 1.08 + vec3(sun * .75);
  outC = vec4(colour * alpha, alpha);
  vec4 clip = uProj * vec4(P, 1.);
  gl_FragDepth = clamp(clip.z / clip.w * .5 + .5, 0., 1.);
}`;

function createSolid1x1Texture(r: number, g: number, b: number, a: number): T.DataTexture {
  const tex = new T.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, T.RGBAFormat, T.UnsignedByteType);
  tex.minFilter = T.NearestFilter;
  tex.magFilter = T.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export class WaterView {
  private readonly geometry = new T.BufferGeometry();
  private readonly positions: T.BufferAttribute;
  private readonly tints: T.BufferAttribute;
  private readonly depthPts: T.Points;
  private readonly thickPts: T.Points;
  private readonly depthScene = new T.Scene();
  private readonly thickScene = new T.Scene();
  private readonly fsScene = new T.Scene();
  private readonly fsCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fsQuad: T.Mesh;
  private rtDepth: T.WebGLRenderTarget | null = null;
  private rtA: T.WebGLRenderTarget | null = null;
  private rtB: T.WebGLRenderTarget | null = null;
  private rtThick: T.WebGLRenderTarget | null = null;
  private rtUseFloat = true;
  private readonly fallbackSceneTex = createSolid1x1Texture(0, 0, 0, 255);
  private readonly fallbackDepthTex = createSolid1x1Texture(255, 255, 255, 255);
  private readonly depthMat: T.ShaderMaterial;
  private readonly thickMat: T.ShaderMaterial;
  private readonly blurMat: T.ShaderMaterial;
  private readonly composePostMat: T.ShaderMaterial;
  private readonly composeDirectMat: T.ShaderMaterial;
  private readonly size = new T.Vector2();
  private readonly bufSize = new T.Vector2();
  private readonly savedClear = new T.Color();
  private readonly stageScale = new T.Vector3(1, 1, 1);
  private readonly dummyStage = new T.Object3D();
  private readonly savedViewport = new T.Vector4();
  private readonly savedScissor = new T.Vector4();
  private currentCount = 0;
  private renderedInPostFxThisFrame = false;
  private disposed = false;

  /** Set to false on unsupported contexts. */
  ready = true;

  constructor(private capacity: number, private radius = .0135) {
    this.positions = new T.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.positions.setUsage(T.DynamicDrawUsage);
    this.tints = new T.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.tints.setUsage(T.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positions);
    this.geometry.setAttribute('tint', this.tints);
    this.geometry.setDrawRange(0, 0);

    const shared = { uRadius: { value: radius }, uScreen: { value: 1000 } };
    this.depthMat = new T.ShaderMaterial({
      glslVersion: T.GLSL3,
      vertexShader: VERT_POINT,
      fragmentShader: FRAG_DEPTH,
      uniforms: { ...shared, uProj: { value: new T.Matrix4() } },
      depthTest: true,
      depthWrite: true,
      blending: T.NoBlending,
      transparent: false,
    });
    this.depthMat.customProgramCacheKey = () => 'ec-water-depth-v2';

    this.thickMat = new T.ShaderMaterial({
      glslVersion: T.GLSL3,
      vertexShader: VERT_POINT,
      fragmentShader: FRAG_THICK,
      uniforms: { ...shared },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: T.CustomBlending,
      blendEquation: T.AddEquation,
      blendSrc: T.OneFactor,
      blendDst: T.OneFactor,
    });
    this.thickMat.customProgramCacheKey = () => 'ec-water-thick-v2';

    this.blurMat = new T.ShaderMaterial({
      glslVersion: T.GLSL3,
      vertexShader: VERT_FS,
      fragmentShader: FRAG_BLUR,
      uniforms: { uTex: { value: this.fallbackDepthTex }, uDir: { value: new T.Vector2() }, uSigmaZ: { value: radius * 1.6 } },
      depthTest: false,
      depthWrite: false,
      blending: T.NoBlending,
    });
    this.blurMat.customProgramCacheKey = () => 'ec-water-blur-v2';

    const sharedSun = new T.Vector3(.2, .8, -.5).normalize();
    const sharedLow = new T.Vector3(.62, .6, .56);
    const sharedHigh = new T.Vector3(.93, .96, 1);

    this.composePostMat = new T.ShaderMaterial({
      glslVersion: T.GLSL3,
      vertexShader: VERT_FS,
      fragmentShader: FRAG_COMPOSE_POST,
      uniforms: {
        uDepth: { value: this.fallbackDepthTex },
        uThick: { value: this.fallbackSceneTex },
        uScene: { value: this.fallbackSceneTex },
        uSceneDepth: { value: this.fallbackDepthTex },
        uHasSceneDepth: { value: 0 },
        uProj: { value: new T.Matrix4() },
        uViewToWorld: { value: new T.Matrix4() },
        uTexel: { value: new T.Vector2(1 / 512, 1 / 512) },
        uSun: { value: sharedSun },
        uLow: { value: sharedLow },
        uHigh: { value: sharedHigh },
      },
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: T.NoBlending,
    });
    this.composePostMat.customProgramCacheKey = () => 'ec-water-compose-post-v2';

    this.composeDirectMat = new T.ShaderMaterial({
      glslVersion: T.GLSL3,
      vertexShader: VERT_FS,
      fragmentShader: FRAG_COMPOSE_DIRECT,
      uniforms: {
        uDepth: { value: this.fallbackDepthTex },
        uThick: { value: this.fallbackSceneTex },
        uProj: { value: new T.Matrix4() },
        uViewToWorld: { value: new T.Matrix4() },
        uTexel: { value: new T.Vector2(1 / 512, 1 / 512) },
        uSun: { value: sharedSun },
        uLow: { value: sharedLow },
        uHigh: { value: sharedHigh },
      },
      depthTest: true,
      depthWrite: false,
      transparent: true,
      blending: T.CustomBlending,
      blendEquation: T.AddEquation,
      blendSrc: T.OneFactor,
      blendDst: T.OneMinusSrcAlphaFactor,
      blendSrcAlpha: T.OneFactor,
      blendDstAlpha: T.OneMinusSrcAlphaFactor,
    });
    this.composeDirectMat.customProgramCacheKey = () => 'ec-water-compose-direct-v2';

    this.depthPts = new T.Points(this.geometry, this.depthMat);
    this.thickPts = new T.Points(this.geometry, this.thickMat);
    this.depthPts.frustumCulled = false;
    this.thickPts.frustumCulled = false;
    this.depthPts.matrixAutoUpdate = false;
    this.thickPts.matrixAutoUpdate = false;
    this.depthPts.matrixWorldAutoUpdate = false;
    this.thickPts.matrixWorldAutoUpdate = false;
    this.depthScene.add(this.depthPts);
    this.thickScene.add(this.thickPts);
    this.fsQuad = new T.Mesh(new T.PlaneGeometry(2, 2), this.blurMat);
    this.fsQuad.frustumCulled = false;
    this.fsScene.add(this.fsQuad);
  }

  get activeCount(): number {
    return this.currentCount;
  }

  private target(w: number, h: number, half: boolean, withDepth: boolean, useFloat: boolean) {
    const useRgbaHalf = half || !useFloat;
    return new T.WebGLRenderTarget(w, h, {
      format: useRgbaHalf ? T.RGBAFormat : T.RedFormat,
      type: useRgbaHalf ? T.HalfFloatType : T.FloatType,
      minFilter: half ? T.LinearFilter : T.NearestFilter,
      magFilter: half ? T.LinearFilter : T.NearestFilter,
      depthBuffer: withDepth,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: T.NoColorSpace,
    });
  }

  private supportsColorBufferFloat(renderer: T.WebGLRenderer): boolean {
    return renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
  }

  resizeTo(w: number, h: number, useFloat = true) {
    if (this.disposed) return;
    const cw = Math.max(2, Math.floor(w));
    const ch = Math.max(2, Math.floor(h));
    if (this.size.x === cw && this.size.y === ch && this.rtDepth && this.rtUseFloat === useFloat) return;
    this.size.set(cw, ch);
    this.rtUseFloat = useFloat;
    this.rtDepth?.dispose();
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtThick?.dispose();
    const dw = Math.max(2, cw >> 1);
    const dh = Math.max(2, ch >> 1);
    this.rtDepth = this.target(dw, dh, false, true, useFloat);
    this.rtA = this.target(dw, dh, false, false, useFloat);
    this.rtB = this.target(dw, dh, false, false, useFloat);
    this.rtThick = this.target(dw, dh, true, false, useFloat);
  }

  /** Packs living particles and uploads ONLY the active `0 .. count * 3` slice to WebGL. */
  set(count: number, write: (positions: Float32Array, tints: Float32Array) => void) {
    write(this.positions.array as Float32Array, this.tints.array as Float32Array);
    this.currentCount = count;
    this.renderedInPostFxThisFrame = false;
    if (count > 0) {
      this.positions.clearUpdateRanges();
      this.positions.addUpdateRange(0, count * 3);
      this.positions.needsUpdate = true;
      this.tints.clearUpdateRanges();
      this.tints.addUpdateRange(0, count * 3);
      this.tints.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, count);
  }

  setCount(count: number) {
    this.currentCount = count;
    if (count === 0) this.renderedInPostFxThisFrame = false;
    this.geometry.setDrawRange(0, count);
  }

  /** Updates reflected sky/floor colors (shared across both PostFX and Direct shaders). */
  light(low: T.Vector3, high: T.Vector3, sun: T.Vector3) {
    (this.composePostMat.uniforms.uLow.value as T.Vector3).copy(low);
    (this.composePostMat.uniforms.uHigh.value as T.Vector3).copy(high);
    (this.composePostMat.uniforms.uSun.value as T.Vector3).copy(sun).normalize();
  }

  private blurStep(renderer: T.WebGLRenderer, from: T.WebGLRenderTarget, to: T.WebGLRenderTarget, dx: number, dy: number) {
    this.blurMat.uniforms.uTex.value = from.texture;
    (this.blurMat.uniforms.uDir.value as T.Vector2).set(dx, dy);
    renderer.setRenderTarget(to);
    renderer.clear(true, false, false);
    renderer.render(this.fsScene, this.fsCam);
  }

  private renderFluidMaps(renderer: T.WebGLRenderer, camera: T.Camera, stage: T.Object3D) {
    camera.updateMatrixWorld();
    this.depthPts.matrixWorld.copy(stage.matrixWorld);
    this.thickPts.matrixWorld.copy(stage.matrixWorld);
    const scale = stage.getWorldScale(this.stageScale).x || 1;
    const proj = (camera as T.PerspectiveCamera).projectionMatrix;
    this.depthMat.uniforms.uRadius.value = this.radius * scale;
    this.thickMat.uniforms.uRadius.value = this.radius * scale;
    this.blurMat.uniforms.uSigmaZ.value = this.radius * scale * 1.6;
    (this.depthMat.uniforms.uProj.value as T.Matrix4).copy(proj);

    const rtD = this.rtDepth!, rtA = this.rtA!, rtB = this.rtB!, rtT = this.rtThick!;
    this.depthMat.uniforms.uScreen.value = rtD.height;
    this.thickMat.uniforms.uScreen.value = rtT.height;

    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rtD);
    renderer.clear(true, true, false);
    renderer.render(this.depthScene, camera);

    this.fsQuad.material = this.blurMat;
    const px = 1 / rtD.width, py = 1 / rtD.height;
    this.blurStep(renderer, rtD, rtA, px, 0);
    this.blurStep(renderer, rtA, rtB, 0, py);
    this.blurStep(renderer, rtB, rtA, px, 0);
    this.blurStep(renderer, rtA, rtB, 0, py);

    renderer.setRenderTarget(rtT);
    renderer.clear(true, false, false);
    renderer.render(this.thickScene, camera);
  }

  /**
   * Zero-copy linear HDR composite executed inside `PostFXController` (`WaterCompositePass`)
   * right after AO and BEFORE `HdrSanitize + Bloom + AgX + ColorGrade + SMAA`.
   */
  renderPostFx(
    renderer: T.WebGLRenderer,
    camera: T.Camera,
    stage: T.Object3D | null,
    sceneColor: T.Texture,
    sceneDepth: T.Texture | null,
    outputTarget: T.WebGLRenderTarget | null,
    count = this.currentCount,
  ): boolean {
    if (this.disposed || !count || !this.ready) return false;
    const size = renderer.getDrawingBufferSize(this.bufSize);
    this.resizeTo(size.x, size.y, this.supportsColorBufferFloat(renderer));
    const activeStage = stage ?? this.dummyStage;

    const prevTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const clear = renderer.getClearColor(this.savedClear);
    const clearA = renderer.getClearAlpha();
    const shadow = renderer.shadowMap.autoUpdate;
    const tone = renderer.toneMapping;
    const sort = renderer.sortObjects;

    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.toneMapping = T.NoToneMapping;
    try {
      this.geometry.setDrawRange(0, count);
      this.renderFluidMaps(renderer, camera, activeStage);

      const rtB = this.rtB!, rtT = this.rtThick!;
      const proj = (camera as T.PerspectiveCamera).projectionMatrix;
      const u = this.composePostMat.uniforms;
      u.uDepth.value = rtB.texture;
      u.uThick.value = rtT.texture;
      u.uScene.value = sceneColor;
      u.uSceneDepth.value = sceneDepth ?? this.fallbackDepthTex;
      u.uHasSceneDepth.value = sceneDepth ? 1 : 0;
      (u.uProj.value as T.Matrix4).copy(proj);
      (u.uViewToWorld.value as T.Matrix4).copy(camera.matrixWorld);
      (u.uTexel.value as T.Vector2).set(1 / rtB.width, 1 / rtB.height);

      renderer.setRenderTarget(outputTarget);
      renderer.setClearColor(clear, clearA);
      this.fsQuad.material = this.composePostMat;
      renderer.render(this.fsScene, this.fsCam);
      this.renderedInPostFxThisFrame = true;
      return true;
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(clear, clearA);
      renderer.autoClear = autoClear;
      renderer.shadowMap.autoUpdate = shadow;
      renderer.toneMapping = tone;
      renderer.sortObjects = sort;
    }
  }

  /**
   * `1x1`-scissored warmup inside `PostFXController.warmupPasses()` so all 4 HDR water programs
   * (`depthMat`, `blurMat`, `thickMat`, `composePostMat`) and half-res FBOs compile before unlock.
   */
  warmupPostFx(
    renderer: T.WebGLRenderer,
    camera: T.Camera,
    stage: T.Object3D | null,
    sceneColor: T.Texture,
    sceneDepth: T.Texture | null,
    outputTarget: T.WebGLRenderTarget | null,
  ): void {
    if (this.disposed || !this.ready) return;
    const size = renderer.getDrawingBufferSize(this.bufSize);
    this.resizeTo(size.x, size.y, this.supportsColorBufferFloat(renderer));

    const posArr = this.positions.array as Float32Array;
    const tintArr = this.tints.array as Float32Array;
    const p0 = posArr[0], p1 = posArr[1], p2 = posArr[2];
    const t0 = tintArr[0], t1 = tintArr[1], t2 = tintArr[2];
    const savedCount = this.currentCount;
    const rts = [this.rtDepth!, this.rtA!, this.rtB!, this.rtThick!];

    try {
      posArr[0] = 0; posArr[1] = -1000; posArr[2] = 0;
      tintArr[0] = .022; tintArr[1] = .009; tintArr[2] = .006;
      this.positions.clearUpdateRanges();
      this.positions.addUpdateRange(0, 3);
      this.positions.needsUpdate = true;
      this.tints.clearUpdateRanges();
      this.tints.addUpdateRange(0, 3);
      this.tints.needsUpdate = true;

      for (let i = 0; i < rts.length; i++) {
        rts[i].scissor.set(0, 0, 1, 1);
        rts[i].scissorTest = true;
      }

      this.renderPostFx(renderer, camera, stage, sceneColor, sceneDepth, outputTarget, 1);
    } finally {
      for (let i = 0; i < rts.length; i++) {
        rts[i].scissorTest = false;
        rts[i].scissor.set(0, 0, rts[i].width, rts[i].height);
      }
      posArr[0] = p0; posArr[1] = p1; posArr[2] = p2;
      tintArr[0] = t0; tintArr[1] = t1; tintArr[2] = t2;
      this.positions.clearUpdateRanges();
      this.positions.addUpdateRange(0, Math.max(3, savedCount * 3));
      this.positions.needsUpdate = true;
      this.tints.clearUpdateRanges();
      this.tints.addUpdateRange(0, Math.max(3, savedCount * 3));
      this.tints.needsUpdate = true;
      this.currentCount = savedCount;
      this.geometry.setDrawRange(0, savedCount);
      this.renderedInPostFxThisFrame = false;
    }
  }

  /**
   * Stage-6 `1x1`-scissored warmup for non-PostFX tiers (`low` / `balanced` / Overview alpha):
   * pre-allocates half-res FBOs and compiles `depthMat`, `blurMat`, `thickMat`, and `composeDirectMat`.
   */
  warmup(
    renderer: T.WebGLRenderer,
    camera: T.Camera,
    stage?: T.Object3D | null,
    width?: number,
    height?: number,
  ): void {
    if (this.disposed || !this.ready) return;
    const size = renderer.getDrawingBufferSize(this.bufSize);
    this.resizeTo(width ?? size.x, height ?? size.y, this.supportsColorBufferFloat(renderer));

    const posArr = this.positions.array as Float32Array;
    const tintArr = this.tints.array as Float32Array;
    const p0 = posArr[0], p1 = posArr[1], p2 = posArr[2];
    const t0 = tintArr[0], t1 = tintArr[1], t2 = tintArr[2];
    const savedCount = this.currentCount;
    const rts = [this.rtDepth!, this.rtA!, this.rtB!, this.rtThick!];

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevTone = renderer.toneMapping;
    const prevScissorTest = renderer.getScissorTest();
    renderer.getViewport(this.savedViewport);
    renderer.getScissor(this.savedScissor);

    try {
      posArr[0] = 0; posArr[1] = -1000; posArr[2] = 0;
      tintArr[0] = .022; tintArr[1] = .009; tintArr[2] = .006;
      this.positions.clearUpdateRanges();
      this.positions.addUpdateRange(0, 3);
      this.positions.needsUpdate = true;
      this.tints.clearUpdateRanges();
      this.tints.addUpdateRange(0, 3);
      this.tints.needsUpdate = true;

      for (let i = 0; i < rts.length; i++) {
        rts[i].scissor.set(0, 0, 1, 1);
        rts[i].scissorTest = true;
      }

      renderer.setRenderTarget(null);
      renderer.setScissor(0, 0, 1, 1);
      renderer.setScissorTest(true);
      this.renderedInPostFxThisFrame = false;
      this.render(renderer, camera, stage ?? this.dummyStage, 1);

      renderer.setRenderTarget(null);
      renderer.setScissor(0, 0, 1, 1);
      renderer.setScissorTest(true);
      renderer.clear(true, true, true);
    } finally {
      for (let i = 0; i < rts.length; i++) {
        rts[i].scissorTest = false;
        rts[i].scissor.set(0, 0, rts[i].width, rts[i].height);
      }
      posArr[0] = p0; posArr[1] = p1; posArr[2] = p2;
      tintArr[0] = t0; tintArr[1] = t1; tintArr[2] = t2;
      this.positions.clearUpdateRanges();
      this.positions.addUpdateRange(0, Math.max(3, savedCount * 3));
      this.positions.needsUpdate = true;
      this.tints.clearUpdateRanges();
      this.tints.addUpdateRange(0, Math.max(3, savedCount * 3));
      this.tints.needsUpdate = true;
      this.currentCount = savedCount;
      this.geometry.setDrawRange(0, savedCount);
      this.renderedInPostFxThisFrame = false;

      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
      renderer.toneMapping = prevTone;
      renderer.setViewport(this.savedViewport);
      renderer.setScissor(this.savedScissor);
      renderer.setScissorTest(prevScissorTest);
    }
  }

  /**
   * Direct MSAA-safe overlay render for `'low'` / `'balanced'` / Overview alpha (zero `copyFramebufferToTexture`).
   * Automatically skips if `renderPostFx()` already composited water during `PostFXController.render()`.
   */
  render(renderer: T.WebGLRenderer, camera: T.Camera, stage: T.Object3D, count: number) {
    if (this.renderedInPostFxThisFrame) {
      this.renderedInPostFxThisFrame = false;
      return;
    }
    if (this.disposed || !count || !this.ready) return;

    const size = renderer.getDrawingBufferSize(this.bufSize);
    this.resizeTo(size.x, size.y, this.supportsColorBufferFloat(renderer));

    const prevTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const clear = renderer.getClearColor(this.savedClear);
    const clearA = renderer.getClearAlpha();
    const shadow = renderer.shadowMap.autoUpdate;
    const tone = renderer.toneMapping;
    const sort = renderer.sortObjects;

    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.toneMapping = T.NoToneMapping;
    try {
      this.geometry.setDrawRange(0, count);
      this.renderFluidMaps(renderer, camera, stage);

      const rtB = this.rtB!, rtT = this.rtThick!;
      const proj = (camera as T.PerspectiveCamera).projectionMatrix;
      const u = this.composeDirectMat.uniforms;
      u.uDepth.value = rtB.texture;
      u.uThick.value = rtT.texture;
      (u.uProj.value as T.Matrix4).copy(proj);
      (u.uViewToWorld.value as T.Matrix4).copy(camera.matrixWorld);
      (u.uTexel.value as T.Vector2).set(1 / rtB.width, 1 / rtB.height);

      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(clear, clearA);
      this.fsQuad.material = this.composeDirectMat;
      renderer.render(this.fsScene, this.fsCam);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(clear, clearA);
      renderer.autoClear = autoClear;
      renderer.shadowMap.autoUpdate = shadow;
      renderer.toneMapping = tone;
      renderer.sortObjects = sort;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.rtDepth?.dispose();
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtThick?.dispose();
    this.fallbackSceneTex.dispose();
    this.fallbackDepthTex.dispose();
    this.geometry.dispose();
    this.depthMat.dispose();
    this.thickMat.dispose();
    this.blurMat.dispose();
    this.composePostMat.dispose();
    this.composeDirectMat.dispose();
    this.fsQuad.geometry.dispose();
    this.rtDepth = this.rtA = this.rtB = this.rtThick = null;
  }
}
