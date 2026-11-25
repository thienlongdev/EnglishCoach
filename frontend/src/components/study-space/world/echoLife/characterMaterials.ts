import * as T from 'three';
import { applySkinSubsurfaceShader } from '@/lib/embodiment/skin';
import { patchHeightFog } from './atmosphere';
import { chainMaterialShader, patchMaterialWithEchoCsm } from './echoCsm';

export { applySkinSubsurfaceShader };

/**
 * AAA Digital-Human Character Material Pipeline for Echo Life & Study Space.
 *
 * Unifies all three skeletal character families shipped in Echo Life & Study Space:
 *  - Family A (`RunnerRig`, 65b): `Cast_Face`, `Cast_Eyes`, `Cast_Hair`, `Cast_Scarf`, `Runner_Body`, `Runner_Hands`
 *  - Family B (`Codex52`, 52b — 22 named residents + `visitor` + `student2`): `Face_and_visible_skin`, `Eyes`, `Brows`,
 *    `Hair*`, `Wardrobe_*`, `outfit`, `Shoes_*`, `footwear`, `Atelier_*`
 *  - Family C (`EchoStudentRig`, 59b — 4 crowd NPCs): `Mat_Eye_*`, `Mat_Face_*`, `Mat_Skin_*`, `Mat_HandSkin_*`,
 *    `Mat_Hair_*`, `Mat_Top_*`, `Mat_Bottom_*`, `Mat_Outer_*`, `Mat_Shoe_*`, `Mat_Sole_*`, `Mat_Acc_*`
 *
 * Key upgrades:
 *  - Shared Cycles-OptiX-baked micro-detail WebP textures under `/echo-life/aaa-v2/char-pbr/` with instant
 *    procedural `DataTexture` fallbacks (works immediately in headless Node & before network textures resolve).
 *  - **Skin (`ec-skin-sss-face-v3` / `ec-skin-sss-body-v3`):** Eric Penner pre-integrated curvature wrap-SSS LUT +
 *    dual-lobe GGX specular (sebum oil + broad dermal scatter) + T-zone roughness (`0.36` T-zone vs `0.54` cheeks) +
 *    distance-faded micro-pore normal detail.
 *  - **Eyes (`ec-eye-aaa-v1`):** Zero flat `emissiveIntensity` washout, wet corneal specular catchlight (`roughness 0.05`,
 *    `clearcoat 1.0`, `ior 1.38`), concave iris fiber depth, limbal ring darkening, and upper-eyelid shadow grounding.
 *  - **Hair (`ec-hair-aaa-v1`):** UV-bitangent-V aligned (`anisotropyRotation = Math.PI / 2`) dual-shift Kajiya-Kay /
 *    Marschner R + TRT + TT sheen, no 45% `#fff1e6` grey cast, subtle vertex-shader wind sway on rigid-hair NPCs,
 *    and **strict specular radiance clamp `<= 1.30`** so indoor ceiling lights never produce white bloom orbs (`G-08`).
 *  - **Clothing (`ec-cloth-aaa-v1`):** Woven cotton/twill micro-normal + smooth Winter/Snow outerwear color adaptation
 *    and upward-shoulder frost dusting so residents look naturally dressed in snowstorms.
 */

export type CharacterQuality = 'high' | 'balanced' | 'low';

export type CharacterSurfaceClass =
  | 'skin_face'
  | 'skin_body'
  | 'eyes'
  | 'hair'
  | 'brows'
  | 'cloth_cotton'
  | 'cloth_knit'
  | 'cloth_denim'
  | 'footwear_leather'
  | 'footwear_sneaker'
  | 'footwear_sole'
  | 'glass'
  | 'metal'
  | 'accessory';

export interface UpgradeCharacterOptions {
  quality?: CharacterQuality;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Enables lightweight vertex-shader wind sway on zero-hair-bone rigs (Codex52 / EchoStudentRig). */
  vertexHairSway?: boolean;
  /** Optional predicate to skip meshes already owned by another subsystem (e.g. `CastLook.owns`). */
  skipMesh?: (mesh: T.Mesh) => boolean;
  /** Optional actor key (e.g. `crowd:4`) used to diversify untextured crowd top colors safely. */
  actorKey?: string;
  /** Attaches Echo Life HeightFog + CSM hooks at material creation time (defaults to `true` for zero post-boot `needsUpdate`). */
  attachWorldShaders?: boolean;
  /** Optional custom material post-hook invoked at creation time before first compile. */
  patchMaterial?: (material: T.Material) => void;
}

/**
 * Attaches Echo Life Exponential Height Fog (`echo-hfog-v1`) + 3-Cascade CSM (`echo-csm-v5`) in canonical
 * order at material creation time so `echoCsm.patchObject` is an O(1) idempotent no-op with zero post-boot `needsUpdate = true`.
 */
export function attachEchoWorldCharacterShaders<M extends T.Material>(material: M): M {
  patchHeightFog(material);
  patchMaterialWithEchoCsm(material);
  return material;
}

/**
 * Rich non-skin clothing palette strictly excluding all beige/peach/tan/flesh hues
 * so untextured crowd shirts (e.g. `crowd_student_a`'s legacy `#f3d5b5` tee) NEVER look flesh-toned.
 */
const CROWD_SAFE_TOP_PALETTE = [
  '#243b5e', // deep navy
  '#2d5444', // forest green
  '#6d2e3d', // burgundy
  '#3a5574', // slate blue
  '#4d6654', // muted sage
  '#564a72', // dusty plum
  '#285966', // deep teal
  '#8c6730', // warm ochre
  '#383e47', // charcoal knit
  '#dde3ea', // crisp cool off-white
] as const;

const _hslScratch = { h: 0, s: 0, l: 0 };

/** Returns true if a flat cloth color sits in the warm peach/beige/tan skin-tone band. */
export function isFleshLikeClothColor(c: T.Color): boolean {
  c.getHSL(_hslScratch);
  const { h, s, l } = _hslScratch;
  return h >= 0.015 && h <= 0.155 && s >= 0.09 && s <= 0.72 && l >= 0.36 && l <= 0.90;
}

/**
 * Micro-detail meshes (`Brows`, `Eyes`, `Lashes`, `Soles`, `Collar`, small accessories)
 * whose shadows are visually imperceptible from >= 1 m yet waste >40% of skinned shadow draw calls.
 * Note: carefully excludes `Wear_*` / `footwear` clothing silhouettes and `Mat_HandSkin_*` skin contracts.
 */
const SHADOW_MICRO_DETAIL_RE =
  /brow|lash|eye|teeth|tooth|tongue|sole|trim|collar|finger|ring|glass|nail|mouth|lip|watch|button|buckle|lace|zip|strap|scarf|necktie|badge|pin|jewel|earphone|headphone|frame|visor|headband|^Mat_Acc_/i;

export function isShadowMicroDetailMesh(meshName: string, materialName = ''): boolean {
  return SHADOW_MICRO_DETAIL_RE.test(meshName) || (!!materialName && SHADOW_MICRO_DETAIL_RE.test(materialName));
}

export interface UpgradeCharacterResult {
  materials: T.Material[];
  counts: Record<CharacterSurfaceClass, number>;
}

/** Exact Cycles-OptiX-baked content-hashed micro-detail WebP assets staged by Team J (`public/echo-life/aaa-v2/char-pbr/`). */
export const CHAR_PBR_URLS = {
  skinPoreNormal: '/echo-life/aaa-v2/char-pbr/skin_pore_normal-1a213bb01eb7.webp',
  skinTZoneRoughness: '/echo-life/aaa-v2/char-pbr/skin_tzone_roughness-03a4ba167ba0.webp',
  skinSssLut: '/echo-life/aaa-v2/char-pbr/skin_sss_lut-e77a06eff458.webp',
  eyeIrisAlbedo: '/echo-life/aaa-v2/char-pbr/eye_iris_albedo-1a44711ff536.webp',
  eyeIrisNormal: '/echo-life/aaa-v2/char-pbr/eye_iris_normal-c51e08b567bc.webp',
  hairStrandAnisoNormal: '/echo-life/aaa-v2/char-pbr/hair_strand_aniso_normal-998406f3faee.webp',
  fabricWeaveNormal: '/echo-life/aaa-v2/char-pbr/fabric_weave_normal-27a9c2b923fd.webp',
} as const;

// ── Shared Dynamic Uniforms (O(1) per-frame update across all characters) ────────────────────────────

const CHAR_SHARED_UNIFORMS = {
  uEcTime: { value: 0 },
  uEcWindVec: { value: new T.Vector2(0.45, 0.2) },
  uEcWinterCoat: { value: 0 },
  uEcSnowDust: { value: 0 },
};

const REF_SKIN_COLOR = new T.Color('#cb9578');
const _skinTmpColor = new T.Color();
const _hairTmpColor = new T.Color();

export interface FaceMakeupUniformInput {
  blushIntensity?: number;
  blushColor?: string;
  lipOpacity?: number;
  lipColor?: string;
  freckleDensity?: number;
  browDarkness?: number;
  browThickness?: number;
  facialHair?: 'none' | 'stubble' | 'goatee' | 'full_beard' | number;
}

interface EcSkinUniformBag {
  uEcSkinTone: { value: T.Color };
  uEcFaceMakeup: { value: T.Vector4 };
  uEcLipColor: { value: T.Color };
  uEcBlushColor: { value: T.Color };
  uEcFacialHair: { value: number };
}

interface EcEyeUniformBag {
  uEcIrisColor: { value: T.Color };
  uEcIrisTintMix: { value: number };
}

interface EcHairUniformBag {
  uEcHairTipColor: { value: T.Color };
  uEcHairTipMix: { value: number };
}

interface EcClothUniformBag {
  uEcPatternParams: { value: T.Vector4 };
  uEcAccentColor: { value: T.Color };
  uEcAllowWinterTint: { value: number };
}

function getOrCreateSkinUniforms(mat: T.Material): EcSkinUniformBag {
  const ud = mat.userData as { ecSkinUniforms?: EcSkinUniformBag };
  if (!ud.ecSkinUniforms) {
    ud.ecSkinUniforms = {
      uEcSkinTone: { value: new T.Color('#ffffff') },
      uEcFaceMakeup: { value: new T.Vector4(0, 0, 0, 0) },
      uEcLipColor: { value: new T.Color('#c6696e') },
      uEcBlushColor: { value: new T.Color('#d97c7e') },
      uEcFacialHair: { value: 0 },
    };
  }
  return ud.ecSkinUniforms;
}

function getOrCreateEyeUniforms(mat: T.Material): EcEyeUniformBag {
  const ud = mat.userData as { ecEyeUniforms?: EcEyeUniformBag };
  if (!ud.ecEyeUniforms) {
    ud.ecEyeUniforms = {
      uEcIrisColor: { value: new T.Color('#ffffff') },
      uEcIrisTintMix: { value: 0 },
    };
  }
  return ud.ecEyeUniforms;
}

function getOrCreateHairUniforms(mat: T.Material): EcHairUniformBag {
  const ud = mat.userData as { ecHairUniforms?: EcHairUniformBag };
  if (!ud.ecHairUniforms) {
    ud.ecHairUniforms = {
      uEcHairTipColor: { value: new T.Color('#ffffff') },
      uEcHairTipMix: { value: 0 },
    };
  }
  return ud.ecHairUniforms;
}

function getOrCreateClothUniforms(mat: T.Material, allowWinterTint = 1): EcClothUniformBag {
  const ud = mat.userData as { ecClothUniforms?: EcClothUniformBag };
  if (!ud.ecClothUniforms) {
    ud.ecClothUniforms = {
      uEcPatternParams: { value: new T.Vector4(0, 12, 0.35, 0.45) },
      uEcAccentColor: { value: new T.Color('#e2e8f0') },
      uEcAllowWinterTint: { value: allowWinterTint },
    };
  }
  return ud.ecClothUniforms;
}

/**
 * Updates skin tone cleanly across `Cast_Face`, `Runner_Hands`, and `Wear_skin` on both AAA and Low tiers.
 * Textured skin meshes compute a calibrated linear tint ratio relative to `#cb9578`; untextured `Wear_skin`
 * applies the exact target tone so neck and wrist seams match seamlessly.
 */
export function setSkinToneUniform(mat: T.Material | null | undefined, hex: string): void {
  if (!mat || !(mat instanceof T.MeshStandardMaterial)) return;
  _skinTmpColor.set(hex);
  const ud = mat.userData as { ecSkinUniforms?: EcSkinUniformBag; ecBaseSkinTint?: T.Color };
  const bag = ud.ecSkinUniforms;
  const baseTint = ud.ecBaseSkinTint;
  const hasMap = !!mat.map;
  if (hasMap) {
    const rr = T.MathUtils.clamp(_skinTmpColor.r / Math.max(0.05, REF_SKIN_COLOR.r), 0.22, 1.48);
    const rg = T.MathUtils.clamp(_skinTmpColor.g / Math.max(0.05, REF_SKIN_COLOR.g), 0.22, 1.48);
    const rb = T.MathUtils.clamp(_skinTmpColor.b / Math.max(0.05, REF_SKIN_COLOR.b), 0.22, 1.48);
    const tr = baseTint ? baseTint.r : 1;
    const tg = baseTint ? baseTint.g : 1;
    const tb = baseTint ? baseTint.b : 1;
    if (bag) {
      bag.uEcSkinTone.value.setRGB(rr, rg, rb);
      mat.color.setRGB(tr, tg, tb);
    } else {
      mat.color.setRGB(rr * tr, rg * tg, rb * tb);
    }
  } else {
    if (bag) {
      bag.uEcSkinTone.value.copy(_skinTmpColor);
      mat.color.setRGB(1, 1, 1);
    } else {
      mat.color.copy(_skinTmpColor);
    }
  }
}

/** Updates facial blush, lip color/opacity, freckles, brow darkness, and facial hair mode (0..3) in O(1). */
export function setFaceMakeupUniform(
  mat: T.Material | null | undefined,
  makeup: FaceMakeupUniformInput | null | undefined,
): void {
  if (!mat || !makeup) return;
  const bag = getOrCreateSkinUniforms(mat);
  const blush = T.MathUtils.clamp(makeup.blushIntensity ?? 0, 0, 1);
  const lipOpacity = T.MathUtils.clamp(makeup.lipOpacity ?? 0, 0, 1);
  const freckles = T.MathUtils.clamp(makeup.freckleDensity ?? 0, 0, 1);
  const browDark = T.MathUtils.clamp(makeup.browDarkness ?? makeup.browThickness ?? 0, 0, 1);
  bag.uEcFaceMakeup.value.set(blush, lipOpacity, freckles, browDark);
  if (makeup.lipColor) bag.uEcLipColor.value.set(makeup.lipColor);
  if (makeup.blushColor) bag.uEcBlushColor.value.set(makeup.blushColor);
  if (makeup.facialHair !== undefined) {
    const fh = makeup.facialHair;
    bag.uEcFacialHair.value =
      typeof fh === 'number'
        ? T.MathUtils.clamp(Math.round(fh), 0, 3)
        : fh === 'stubble'
          ? 1
          : fh === 'goatee'
            ? 2
            : fh === 'full_beard'
              ? 3
              : 0;
  }
}

/** Updates iris pigment color in `ec-eye-aaa-v1` (multiplying `ecIrisMask` only so sclera remains pure white). */
export function setIrisColorUniform(mat: T.Material | null | undefined, hex: string, mix = 0.88): void {
  if (!mat) return;
  const bag = getOrCreateEyeUniforms(mat);
  bag.uEcIrisColor.value.set(hex);
  bag.uEcIrisTintMix.value = T.MathUtils.clamp(mix, 0, 1);
}

/** Updates root-to-tip ombre hair tip color and blend weight in `ec-hair-aaa-v1` (zero extra programs). */
export function setHairTipUniform(mat: T.Material | null | undefined, tipHex: string, mix: number): void {
  if (!mat) return;
  const bag = getOrCreateHairUniforms(mat);
  bag.uEcHairTipColor.value.set(tipHex);
  bag.uEcHairTipMix.value = T.MathUtils.clamp(mix, 0, 1);
}

/** Updates procedural cloth pattern mode (`solid=0, stripe=1, plaid=2, heather=3`) and accent color in `ec-cloth-aaa-v1`. */
export function setClothPatternUniform(
  mat: T.Material | null | undefined,
  pattern: 'solid' | 'stripe' | 'plaid' | 'heather' | number,
  accentHex?: string,
  scale?: number,
  contrast?: number,
  accentMix?: number,
): void {
  if (!mat) return;
  const bag = getOrCreateClothUniforms(mat);
  const mode =
    typeof pattern === 'number'
      ? T.MathUtils.clamp(Math.round(pattern), 0, 3)
      : pattern === 'stripe'
        ? 1
        : pattern === 'plaid'
          ? 2
          : pattern === 'heather'
            ? 3
            : 0;
  const defaultScale = mode === 1 ? 22 : mode === 2 ? 12 : mode === 3 ? 42 : 12;
  const defaultContrast = mode === 1 ? 0.34 : mode === 2 ? 0.42 : mode === 3 ? 0.22 : 0;
  bag.uEcPatternParams.value.set(
    mode,
    scale ?? defaultScale,
    contrast ?? defaultContrast,
    accentMix ?? (accentHex ? 0.55 : 0.35),
  );
  if (accentHex) {
    bag.uEcAccentColor.value.set(accentHex);
  } else if (mat instanceof T.MeshStandardMaterial) {
    _hairTmpColor.copy(mat.color).lerp(new T.Color('#ffffff'), 0.42);
    bag.uEcAccentColor.value.copy(_hairTmpColor);
  }
}

/**
 * Updates shared environmental uniforms across every upgraded character material in O(1) time.
 * Call once per frame from `GameView.update()` with current winter/snow/wind state.
 */
export function setCharacterSeasonState(
  winterFactor: number,
  snowIntensity: number,
  windX: number,
  windZ: number,
  time: number,
): void {
  CHAR_SHARED_UNIFORMS.uEcWinterCoat.value = T.MathUtils.clamp(winterFactor, 0, 1);
  CHAR_SHARED_UNIFORMS.uEcSnowDust.value = T.MathUtils.clamp(snowIntensity, 0, 1);
  CHAR_SHARED_UNIFORMS.uEcWindVec.value.set(windX, windZ);
  CHAR_SHARED_UNIFORMS.uEcTime.value = time;
}

// ── Shared Micro-Detail PBR Texture Bank (Procedural Instant Fallback + Async WebP Upgrade) ──────────

interface CharPbrTextureBank {
  skinSssLut: { value: T.Texture };
  skinPoreNormal: { value: T.Texture };
  skinTZoneRoughness: { value: T.Texture };
  eyeIrisAlbedo: { value: T.Texture };
  eyeIrisNormal: { value: T.Texture };
  hairStrandAnisoNormal: { value: T.Texture };
  fabricWeaveNormal: { value: T.Texture };
  upgradedWebp: boolean;
}

let sharedBank: CharPbrTextureBank | null = null;

function hash2d(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/**
 * Generates an exact Eric Penner pre-integrated 3-Gaussian Jensen/d'Eon skin diffusion LUT (64x64 fallback)
 * until the Cycles-baked 256x256 WebP LUT finishes loading.
 */
function buildFallbackPennerSssLut(): T.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  // Jensen/d'Eon 3-Gaussian variance weights for human epidermis + dermis
  const sigmas = [0.0064, 0.0484, 0.187, 0.567, 1.99, 7.41];
  const weightsR = [0.233, 0.1, 0.118, 0.113, 0.358, 0.078];
  const weightsG = [0.455, 0.336, 0.198, 0.007, 0.004, 0.0];
  const weightsB = [0.649, 0.344, 0.0, 0.007, 0.0, 0.0];

  for (let y = 0; y < size; y++) {
    const curv = 0.08 + (y / (size - 1)) * 1.9; // 1/R in cm^-1
    const radius = 1 / curv;
    for (let x = 0; x < size; x++) {
      const cosTheta = (x / (size - 1)) * 2 - 1;
      const theta = Math.acos(T.MathUtils.clamp(cosTheta, -1, 1));
      let accR = 0, accG = 0, accB = 0;
      let normR = 0, normG = 0, normB = 0;
      const steps = 24;
      for (let s = 0; s < steps; s++) {
        const dt = ((s + 0.5) / steps - 0.5) * Math.PI * 1.4;
        const arc = 2 * radius * Math.sin(Math.abs(dt) * 0.5);
        const arc2 = arc * arc;
        const ndl = Math.max(0, Math.cos(theta + dt));
        let gR = 0, gG = 0, gB = 0;
        for (let k = 0; k < 6; k++) {
          const v = 2 * sigmas[k];
          const g = Math.exp(-arc2 / v) / Math.sqrt(Math.PI * v);
          gR += weightsR[k] * g;
          gG += weightsG[k] * g;
          gB += weightsB[k] * g;
        }
        accR += ndl * gR;
        accG += ndl * gG;
        accB += ndl * gB;
        normR += gR;
        normG += gG;
        normB += gB;
      }
      const o = (y * size + x) * 4;
      data[o] = Math.round(T.MathUtils.clamp(accR / Math.max(1e-5, normR), 0, 1) * 255);
      data[o + 1] = Math.round(T.MathUtils.clamp(accG / Math.max(1e-5, normG), 0, 1) * 255);
      data[o + 2] = Math.round(T.MathUtils.clamp(accB / Math.max(1e-5, normB), 0, 1) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new T.DataTexture(data, size, size, T.RGBAFormat);
  tex.colorSpace = T.SRGBColorSpace;
  tex.wrapS = T.ClampToEdgeWrapping;
  tex.wrapT = T.ClampToEdgeWrapping;
  tex.minFilter = T.LinearFilter;
  tex.magFilter = T.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function buildFallbackNormalMap(
  size: number,
  mode: 'pore' | 'hair' | 'weave' | 'iris',
): T.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      let nx = 0;
      let ny = 0;
      if (mode === 'pore') {
        const a = Math.sin(u * Math.PI * 16 + hash2d(x & 15, y & 15) * 2.4) * Math.cos(v * Math.PI * 16);
        const b = Math.cos(u * Math.PI * 24 - v * Math.PI * 20) * 0.5;
        nx = (a + b) * 0.18;
        ny = (a - b) * 0.18;
      } else if (mode === 'hair') {
        // Vertical V-aligned hair strands (variation strongly across U, smooth along V)
        const strand = Math.sin(u * Math.PI * 48) * 0.65 + Math.sin(u * Math.PI * 96 + 1.1) * 0.35;
        const shift = Math.sin(u * Math.PI * 28 + Math.sin(v * Math.PI * 4) * 0.35);
        nx = strand * 0.34;
        ny = shift * 0.22;
      } else if (mode === 'weave') {
        const warp = Math.sin(u * Math.PI * 32) * Math.cos(v * Math.PI * 16);
        const weft = Math.cos(u * Math.PI * 16) * Math.sin(v * Math.PI * 32);
        nx = warp * 0.22;
        ny = weft * 0.22;
      } else {
        // Radial concave iris fiber ridges
        const dx = u - 0.5;
        const dy = v - 0.5;
        const r = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        const fiber = Math.sin(ang * 42 + r * 12) * 0.16;
        nx = -dx * 0.45 + Math.cos(ang) * fiber;
        ny = -dy * 0.45 + Math.sin(ang) * fiber;
      }
      const nz = Math.sqrt(Math.max(0.01, 1 - nx * nx - ny * ny));
      const o = (y * size + x) * 4;
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new T.DataTexture(data, size, size, T.RGBAFormat);
  tex.wrapS = mode === 'iris' ? T.ClampToEdgeWrapping : T.RepeatWrapping;
  tex.wrapT = mode === 'iris' ? T.ClampToEdgeWrapping : T.RepeatWrapping;
  tex.minFilter = T.LinearFilter;
  tex.magFilter = T.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function buildFallbackTZoneRoughness(): T.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = y / (size - 1);
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1);
      // T-zone centerline (forehead + nose bridge + chin) -> 0.36; cheeks -> 0.54
      const centerDist = Math.abs(u - 0.5) * 2;
      const forehead = Math.exp(-Math.pow((v - 0.72) / 0.2, 2)) * Math.exp(-Math.pow(centerDist / 0.55, 2));
      const noseChin = Math.exp(-Math.pow(centerDist / 0.22, 2)) * Math.exp(-Math.pow((v - 0.42) / 0.32, 2));
      const tZone = T.MathUtils.clamp(Math.max(forehead, noseChin), 0, 1);
      const rough = T.MathUtils.lerp(0.54, 0.36, tZone);
      const val = Math.round(rough * 255);
      const o = (y * size + x) * 4;
      data[o] = val;
      data[o + 1] = Math.round(tZone * 255);
      data[o + 2] = val;
      data[o + 3] = 255;
    }
  }
  const tex = new T.DataTexture(data, size, size, T.RGBAFormat);
  tex.wrapS = T.ClampToEdgeWrapping;
  tex.wrapT = T.ClampToEdgeWrapping;
  tex.minFilter = T.LinearFilter;
  tex.magFilter = T.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function buildFallbackIrisAlbedo(): T.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const dy = y / (size - 1) - 0.5;
    for (let x = 0; x < size; x++) {
      const dx = x / (size - 1) - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const ang = Math.atan2(dy, dx);
      const limbal = 1 - 0.55 * Math.exp(-Math.pow((r - 0.88) / 0.09, 2));
      const fiber = 0.9 + 0.1 * Math.sin(ang * 36 + r * 6);
      const val = Math.round(T.MathUtils.clamp(limbal * fiber, 0.25, 1) * 255);
      const o = (y * size + x) * 4;
      data[o] = val;
      data[o + 1] = val;
      data[o + 2] = val;
      data[o + 3] = 255;
    }
  }
  const tex = new T.DataTexture(data, size, size, T.RGBAFormat);
  tex.colorSpace = T.SRGBColorSpace;
  tex.wrapS = T.ClampToEdgeWrapping;
  tex.wrapT = T.ClampToEdgeWrapping;
  tex.minFilter = T.LinearFilter;
  tex.magFilter = T.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const retainedFallbackDataTextures: T.DataTexture[] = [];
let charPbrPreloadPromise: Promise<void> | null = null;

function getCharPbrBank(): CharPbrTextureBank {
  if (sharedBank) return sharedBank;
  const fallbacks = {
    skinSssLut: buildFallbackPennerSssLut(),
    skinPoreNormal: buildFallbackNormalMap(64, 'pore'),
    skinTZoneRoughness: buildFallbackTZoneRoughness(),
    eyeIrisAlbedo: buildFallbackIrisAlbedo(),
    eyeIrisNormal: buildFallbackNormalMap(64, 'iris'),
    hairStrandAnisoNormal: buildFallbackNormalMap(64, 'hair'),
    fabricWeaveNormal: buildFallbackNormalMap(64, 'weave'),
  };
  retainedFallbackDataTextures.push(
    fallbacks.skinSssLut,
    fallbacks.skinPoreNormal,
    fallbacks.skinTZoneRoughness,
    fallbacks.eyeIrisAlbedo,
    fallbacks.eyeIrisNormal,
    fallbacks.hairStrandAnisoNormal,
    fallbacks.fabricWeaveNormal,
  );
  sharedBank = {
    skinSssLut: { value: fallbacks.skinSssLut },
    skinPoreNormal: { value: fallbacks.skinPoreNormal },
    skinTZoneRoughness: { value: fallbacks.skinTZoneRoughness },
    eyeIrisAlbedo: { value: fallbacks.eyeIrisAlbedo },
    eyeIrisNormal: { value: fallbacks.eyeIrisNormal },
    hairStrandAnisoNormal: { value: fallbacks.hairStrandAnisoNormal },
    fabricWeaveNormal: { value: fallbacks.fabricWeaveNormal },
    upgradedWebp: false,
  };

  // In real browsers, non-blockingly upgrade to Cycles-OptiX-baked 512–1024px WebP maps.
  // Never dispose the tiny 64x64 fallback DataTextures mid-frame so in-flight draw calls never hit a deleted GL texture.
  if (typeof window !== 'undefined' && typeof Image !== 'undefined') {
    void preloadCharacterPbrTextures();
  }

  return sharedBank;
}

/**
 * Preloads and optionally GPU-initializes all 7 shared character micro-detail WebP maps before Stage 6 warmup.
 * Safe to call in SSR/headless Node (resolves immediately using procedural `DataTexture` fallbacks).
 */
export function preloadCharacterPbrTextures(renderer?: T.WebGLRenderer | null): Promise<void> {
  const bank = getCharPbrBank();
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return Promise.resolve();
  }
  if (!charPbrPreloadPromise) {
    bank.upgradedWebp = true;
    const texLoader = new T.TextureLoader();
    const loadSlot = (
      slot: { value: T.Texture },
      url: string,
      opts: { srgb?: boolean; repeat?: boolean },
    ): Promise<void> =>
      new Promise((resolve) => {
        texLoader.load(
          url,
          (tex) => {
            tex.colorSpace = opts.srgb ? T.SRGBColorSpace : T.NoColorSpace;
            tex.wrapS = opts.repeat ? T.RepeatWrapping : T.ClampToEdgeWrapping;
            tex.wrapT = opts.repeat ? T.RepeatWrapping : T.ClampToEdgeWrapping;
            tex.generateMipmaps = true;
            tex.minFilter = T.LinearMipmapLinearFilter;
            tex.magFilter = T.LinearFilter;
            tex.needsUpdate = true;
            slot.value = tex;
            resolve();
          },
          undefined,
          () => {
            /* keep procedural DataTexture fallback cleanly */
            resolve();
          },
        );
      });

    charPbrPreloadPromise = Promise.all([
      loadSlot(bank.skinPoreNormal, CHAR_PBR_URLS.skinPoreNormal, { repeat: true }),
      loadSlot(bank.skinTZoneRoughness, CHAR_PBR_URLS.skinTZoneRoughness, { repeat: false }),
      loadSlot(bank.skinSssLut, CHAR_PBR_URLS.skinSssLut, { srgb: true, repeat: false }),
      loadSlot(bank.eyeIrisAlbedo, CHAR_PBR_URLS.eyeIrisAlbedo, { srgb: true, repeat: false }),
      loadSlot(bank.eyeIrisNormal, CHAR_PBR_URLS.eyeIrisNormal, { repeat: false }),
      loadSlot(bank.hairStrandAnisoNormal, CHAR_PBR_URLS.hairStrandAnisoNormal, { repeat: true }),
      loadSlot(bank.fabricWeaveNormal, CHAR_PBR_URLS.fabricWeaveNormal, { repeat: true }),
    ]).then(() => undefined);
  }
  return charPbrPreloadPromise.then(() => {
    if (!renderer) return;
    for (const slot of [
      bank.skinPoreNormal,
      bank.skinTZoneRoughness,
      bank.skinSssLut,
      bank.eyeIrisAlbedo,
      bank.eyeIrisNormal,
      bank.hairStrandAnisoNormal,
      bank.fabricWeaveNormal,
    ]) {
      if (slot.value) renderer.initTexture(slot.value);
    }
  });
}

// ── Shared GLSL Helpers (Zero Shader Explosion, WebGL2 + Derivative-Safe) ────────────────────────────

const GLSL_PERTURB_HELPER = /* glsl */ `
vec3 ecPerturbDetailNormal( vec3 surfPos, vec3 surfNorm, vec2 uv, vec3 mapN, float strength ) {
  vec3 q0 = dFdx( surfPos );
  vec3 q1 = dFdy( surfPos );
  vec2 st0 = dFdx( uv );
  vec2 st1 = dFdy( uv );
  vec3 N = normalize( surfNorm );
  vec3 q1perp = cross( q1, N );
  vec3 q0perp = cross( N, q0 );
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max( dot( T, T ), dot( B, B ) );
  float valid = step( 1e-10, det );
  float invMax = inversesqrt( max( det, 1e-10 ) );
  vec3 tN = normalize( vec3( mapN.xy * ( strength * valid ), max( 0.08, mapN.z ) ) );
  return normalize( T * ( tN.x * invMax ) + B * ( tN.y * invMax ) + N * tN.z );
}
`;

const DIRECT_DIFFUSE_ANCHOR =
  'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );';

// AAA Skin fragment injection inside RE_Direct_Physical:
// - Eric Penner pre-integrated curvature wrap-SSS LUT (`uEcSkinSssLut`) blended with hemoglobin `ecSssTint`
// - Dual-lobe GGX specular (tight sebum oil lobe + broad epidermal scatter, clamped for natural warmth)
const SKIN_AAA_DIRECT_SNIPPET = /* glsl */ `
	float ecRawNL = dot( geometryNormal, directLight.direction );
	float ecCurv = clamp( length( fwidth( geometryNormal ) ) / max( length( fwidth( geometryPosition ) ), 1e-4 ) * 0.045, 0.08, 0.90 );
	vec3 ecLutSss = texture2D( uEcSkinSssLut, vec2( ecRawNL * 0.5 + 0.5, ecCurv ) ).rgb;
	vec3 ecSssTint = vec3( 0.96, 0.38, 0.24 );
	float ecWrap = saturate( ( ecRawNL + 0.36 ) / 1.36 );
	float ecTermBand = smoothstep( -0.28, 0.10, ecRawNL ) * ( 1.0 - smoothstep( 0.08, 0.50, ecRawNL ) );
	vec3 ecBlendedIrr = mix( vec3( dotNL ), ecLutSss, 0.52 ) * directLight.color;
	reflectedLight.directDiffuse += ecBlendedIrr * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
	reflectedLight.directDiffuse += directLight.color * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F )
		* ecSssTint * ( ecTermBand * 0.26 + max( 0.0, ecWrap - dotNL ) * 0.18 );
	// Dual-lobe tight sebum oil highlight (F0 = 0.028, alphaOil = roughness * 0.58)
	vec3 ecH = normalize( directLight.direction + geometryViewDir );
	float ecNdH = saturate( dot( geometryNormal, ecH ) );
	float ecVdH = saturate( dot( geometryViewDir, ecH ) );
	float ecAlphaOil = max( 0.06, material.roughness * 0.56 );
	float ecA2 = ecAlphaOil * ecAlphaOil;
	float ecDen = ( ecNdH * ecNdH * ( ecA2 - 1.0 ) + 1.0 );
	float ecD = ecA2 / max( 3.14159265 * ecDen * ecDen, 1e-4 );
	float ecF = 0.028 + 0.972 * pow( 1.0 - ecVdH, 5.0 );
	reflectedLight.directSpecular += directLight.color * min( 0.42, ecD * ecF * dotNL * 0.22 );`;

let cachedSkinLightsPars: string | null = null;
function getSkinAaaLightsPars(): string {
  if (cachedSkinLightsPars !== null) return cachedSkinLightsPars;
  const base = T.ShaderChunk.lights_physical_pars_fragment;
  cachedSkinLightsPars = base.includes(DIRECT_DIFFUSE_ANCHOR)
    ? base.replace(DIRECT_DIFFUSE_ANCHOR, SKIN_AAA_DIRECT_SNIPPET)
    : base;
  return cachedSkinLightsPars;
}

// Kajiya-Kay / Marschner Dual-Shift Anisotropic Hair injection inside RE_Direct_Physical
// Soft silky hair-tinted sheen + strict specular energy clamp so dark hair NEVER shows harsh white streaks or bloom orbs.
const HAIR_AAA_DIRECT_SNIPPET = /* glsl */ `
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
	{
		vec3 ecH = normalize( directLight.direction + geometryViewDir );
		// Bitangent-V aligned hair strand axis (perpendicular to U, flowing root -> tip)
		vec3 ecStrandBase = normalize( cross( geometryNormal, vec3( 1.0, 0.0, 0.0 ) ) + vec3( 0.0, -0.001, 0.0 ) );
		#ifdef USE_ANISOTROPY
			ecStrandBase = normalize( material.anisotropyT );
		#endif
		vec3 ecShiftSample = texture2D( uEcHairStrandNormal, vEcCharUv * vec2( 3.5, 2.0 ) ).rgb * 2.0 - 1.0;
		float ecShift = ecShiftSample.y * 0.10;
		vec3 ecT1 = normalize( ecStrandBase + geometryNormal * ( -0.05 + ecShift ) );
		vec3 ecT2 = normalize( ecStrandBase + geometryNormal * ( 0.10 + ecShift * 1.2 ) );
		float ecSin1 = sqrt( max( 0.0, 1.0 - pow( dot( ecT1, ecH ), 2.0 ) ) );
		float ecSin2 = sqrt( max( 0.0, 1.0 - pow( dot( ecT2, ecH ), 2.0 ) ) );
		float ecSpecR = pow( ecSin1, 32.0 ) * 0.09;
		float ecSpecTRT = pow( ecSin2, 14.0 ) * 0.11;
		// Strictly warm hair-tinted specular lobe (never pure white 0xffffff!) so dark hair stays rich silky espresso
		vec3 ecHairTint = mix( vec3( 0.52, 0.40, 0.32 ), material.diffuseColor, 0.72 );
		vec3 ecTrtTint = max( material.diffuseColor * material.diffuseColor * 1.25, vec3( 0.03 ) );
		float ecBackTT = pow( saturate( dot( geometryViewDir, -directLight.direction ) ), 4.0 ) * 0.08;
		vec3 ecKkSpec = directLight.color * ( dotNL * ( ecHairTint * ecSpecR + ecTrtTint * ecSpecTRT ) + material.diffuseColor * ecBackTT );
		reflectedLight.directSpecular += ecKkSpec;
		// Soft-clamp hair specular energy so neither midday sun nor indoor fixtures create bright white stripes or bloom orbs
		float ecSpecLum = dot( reflectedLight.directSpecular, vec3( 0.2126, 0.7152, 0.0722 ) );
		if ( ecSpecLum > 0.34 ) {
			float ecClamped = 0.34 + 0.22 * ( ( ecSpecLum - 0.34 ) / ( ( ecSpecLum - 0.34 ) + 0.45 ) );
			reflectedLight.directSpecular *= ecClamped / max( ecSpecLum, 1e-4 );
		}
	}`;

let cachedHairLightsPars: string | null = null;
function getHairAaaLightsPars(): string {
  if (cachedHairLightsPars !== null) return cachedHairLightsPars;
  const base = T.ShaderChunk.lights_physical_pars_fragment;
  cachedHairLightsPars = base.includes(DIRECT_DIFFUSE_ANCHOR)
    ? base.replace(DIRECT_DIFFUSE_ANCHOR, HAIR_AAA_DIRECT_SNIPPET)
    : base;
  return cachedHairLightsPars;
}

/**
 * Applies the AAA Skin shader (Eric Penner pre-integrated SSS LUT + dual-lobe sebum GGX +
 * T-zone roughness + distance-faded micro-pore normal detail + warm grazing rim).
 * Uses distinct cache keys (`ec-skin-aaa-face-v4` / `ec-skin-aaa-body-v4`) chained via `chainMaterialShader`
 * so it never collides with `lib/embodiment/skin.ts` (`ec-skin-sss-face-v3` / `ec-skin-sss-body-v3`).
 */
export function applySkinAaaUpgrade(
  material: T.MeshPhysicalMaterial,
  face: boolean,
  options: { attachWorldShaders?: boolean } = {},
): void {
  const bank = getCharPbrBank();
  const uniforms = getOrCreateSkinUniforms(material);
  const rimTint = face ? 'vec3(0.14, 0.045, 0.032)' : 'vec3(0.24, 0.070, 0.042)';
  const poreTile = face ? '16.0' : '11.0';
  const poreStrength = face ? '0.24' : '0.16';
  const useTZone = face ? '1.0' : '0.0';
  const faceMakeupChunk = face
    ? /* glsl */ `
            diffuseColor.rgb *= uEcSkinTone;
            {
              float ecSymX = abs( vEcCharUv.x - 0.5 );
              float ecV = vEcCharUv.y;
              if ( uEcFaceMakeup.x > 0.005 ) {
                float ecCheek = exp( -pow( ( ecSymX - 0.16 ) / 0.075, 2.0 ) - pow( ( ecV - 0.44 ) / 0.065, 2.0 ) );
                diffuseColor.rgb = mix( diffuseColor.rgb, uEcBlushColor, ecCheek * uEcFaceMakeup.x * 0.42 );
              }
              if ( uEcFaceMakeup.y > 0.005 ) {
                float ecLip = exp( -pow( ecSymX / 0.072, 2.0 ) - pow( ( ecV - 0.27 ) / 0.026, 2.0 ) );
                diffuseColor.rgb = mix( diffuseColor.rgb, uEcLipColor, ecLip * uEcFaceMakeup.y * 0.72 );
              }
              if ( uEcFaceMakeup.z > 0.005 ) {
                float ecFZone = exp( -pow( ecSymX / 0.19, 2.0 ) - pow( ( ecV - 0.48 ) / 0.075, 2.0 ) );
                vec2 ecCell = floor( vEcCharUv * 120.0 );
                float ecRnd = fract( sin( dot( ecCell, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
                vec2 ecFrac = fract( vEcCharUv * 120.0 ) - 0.5;
                float ecDot = smoothstep( 0.28, 0.08, length( ecFrac ) ) * step( 0.76, ecRnd );
                diffuseColor.rgb *= 1.0 - ecDot * ecFZone * uEcFaceMakeup.z * 0.26;
              }
              if ( uEcFaceMakeup.w > 0.005 ) {
                float ecBrow = exp( -pow( ( ecSymX - 0.13 ) / 0.065, 2.0 ) - pow( ( ecV - 0.65 ) / 0.022, 2.0 ) );
                diffuseColor.rgb *= 1.0 - ecBrow * uEcFaceMakeup.w * 0.36;
              }
              if ( uEcFacialHair > 0.5 ) {
                float ecGrain = 0.72 + 0.28 * fract( sin( dot( floor( vEcCharUv * 190.0 ), vec2( 41.3, 289.1 ) ) ) * 43758.5453 );
                float ecJawMask = 0.0;
                if ( uEcFacialHair < 1.5 ) {
                  ecJawMask = smoothstep( 0.34, 0.20, ecV ) * ( 1.0 - smoothstep( 0.16, 0.25, ecSymX ) ) * 0.28;
                } else if ( uEcFacialHair < 2.5 ) {
                  float ecChin = exp( -pow( ecSymX / 0.085, 2.0 ) - pow( ( ecV - 0.19 ) / 0.055, 2.0 ) );
                  float ecStache = exp( -pow( ecSymX / 0.08, 2.0 ) - pow( ( ecV - 0.315 ) / 0.018, 2.0 ) );
                  ecJawMask = clamp( ecChin + ecStache, 0.0, 1.0 ) * 0.52;
                } else {
                  ecJawMask = smoothstep( 0.38, 0.16, ecV ) * ( 1.0 - smoothstep( 0.18, 0.27, ecSymX ) ) * 0.62;
                }
                diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.08, 0.06, 0.05 ) * ecGrain, ecJawMask );
              }
            }`
    : /* glsl */ `
            diffuseColor.rgb *= uEcSkinTone;`;

  const tag = face ? 'ec-skin-aaa-face-v4' : 'ec-skin-aaa-body-v4';
  chainMaterialShader(material, tag, (shader) => {
    if (shader.uniforms) {
      shader.uniforms.uEcSkinSssLut = bank.skinSssLut;
      shader.uniforms.uEcSkinPoreNormal = bank.skinPoreNormal;
      shader.uniforms.uEcSkinTZoneRough = bank.skinTZoneRoughness;
      shader.uniforms.uEcSkinTone = uniforms.uEcSkinTone;
      shader.uniforms.uEcFaceMakeup = uniforms.uEcFaceMakeup;
      shader.uniforms.uEcLipColor = uniforms.uEcLipColor;
      shader.uniforms.uEcBlushColor = uniforms.uEcBlushColor;
      shader.uniforms.uEcFacialHair = uniforms.uEcFacialHair;
    }
    if (shader.vertexShader) {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
            #include <common>
            varying vec2 vEcCharUv;`,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
            #include <begin_vertex>
            #ifdef USE_UV
              vEcCharUv = uv;
            #else
              vEcCharUv = vec2( 0.5 );
            #endif`,
        );
    }
    if (shader.fragmentShader) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
            #include <common>
            uniform sampler2D uEcSkinSssLut;
            uniform sampler2D uEcSkinPoreNormal;
            uniform sampler2D uEcSkinTZoneRough;
            uniform vec3 uEcSkinTone;
            uniform vec4 uEcFaceMakeup;
            uniform vec3 uEcLipColor;
            uniform vec3 uEcBlushColor;
            uniform float uEcFacialHair;
            varying vec2 vEcCharUv;
            ${GLSL_PERTURB_HELPER}`,
        )
      if (!shader.fragmentShader.includes('ecTermBand')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <lights_physical_pars_fragment>',
          getSkinAaaLightsPars(),
        );
      }
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
            #include <map_fragment>
            ${faceMakeupChunk}`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `
            #include <roughnessmap_fragment>
            if ( ${useTZone} > 0.5 ) {
              float ecTZoneVal = texture2D( uEcSkinTZoneRough, vEcCharUv ).r;
              float ecTargetRough = mix( 0.36, 0.54, clamp( ( ecTZoneVal - 0.34 ) / 0.24, 0.0, 1.0 ) );
              roughnessFactor = clamp( mix( roughnessFactor, ecTargetRough, 0.62 ), 0.34, 0.66 );
            }`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
            #include <normal_fragment_maps>
            {
              float ecDistFade = smoothstep( 4.2, 1.2, length( vViewPosition ) );
              vec3 ecPoreN = texture2D( uEcSkinPoreNormal, vEcCharUv * ${poreTile} ).xyz * 2.0 - 1.0;
              normal = ecPerturbDetailNormal( -vViewPosition, normal, vEcCharUv * ${poreTile}, ecPoreN, ${poreStrength} * ecDistFade );
            }`,
        );
      if (!shader.fragmentShader.includes('ecRim')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          /* glsl */ `
            {
              float ecAaaRim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
              outgoingLight += diffuseColor.rgb * ${rimTint} * ecAaaRim * (reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + vec3(0.06));
            }
            #include <opaque_fragment>`,
        );
      }
    }
  });
  if (options.attachWorldShaders) attachEchoWorldCharacterShaders(material);
}

/**
 * Applies the AAA Eye shader (concave iris fiber micro-normal, limbal ring darkening,
 * upper-eyelid ambient shadow strip, custom iris tint, and clamped wet corneal catchlight).
 */
export function applyEyeAaaShader(
  material: T.MeshPhysicalMaterial,
  options: { attachWorldShaders?: boolean } = {},
): void {
  const bank = getCharPbrBank();
  const uniforms = getOrCreateEyeUniforms(material);
  material.emissive.set(0x000000);
  material.emissiveIntensity = 0;
  material.roughness = Math.min(material.roughness, 0.06);
  material.clearcoat = 1.0;
  material.clearcoatRoughness = Math.min(material.clearcoatRoughness, 0.025);
  chainMaterialShader(material, 'ec-eye-aaa-v1', (shader) => {
    if (shader.uniforms) {
      shader.uniforms.uEcEyeIrisAlbedo = bank.eyeIrisAlbedo;
      shader.uniforms.uEcEyeIrisNormal = bank.eyeIrisNormal;
      shader.uniforms.uEcIrisColor = uniforms.uEcIrisColor;
      shader.uniforms.uEcIrisTintMix = uniforms.uEcIrisTintMix;
    }
    if (shader.vertexShader) {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
            #include <common>
            varying vec2 vEcCharUv;
            varying vec3 vEcEyeNormal;`,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
            #include <begin_vertex>
            #ifdef USE_UV
              vEcCharUv = uv;
            #else
              vEcCharUv = vec2( 0.5 );
            #endif
            vEcEyeNormal = normalize( objectNormal );`,
        );
    }
    if (shader.fragmentShader) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
            #include <common>
            uniform sampler2D uEcEyeIrisAlbedo;
            uniform sampler2D uEcEyeIrisNormal;
            uniform vec3 uEcIrisColor;
            uniform float uEcIrisTintMix;
            varying vec2 vEcCharUv;
            varying vec3 vEcEyeNormal;`,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
            #include <map_fragment>
            {
              // Subtle iris micro-contrast & limbal ring grounding without tinting white sclera
              float ecLuma = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
              float ecIrisMask = ( 1.0 - smoothstep( 0.48, 0.72, ecLuma ) ) * smoothstep( 0.04, 0.14, ecLuma );
              vec3 ecIrisDetail = texture2D( uEcEyeIrisAlbedo, vEcCharUv ).rgb;
              if ( uEcIrisTintMix > 0.001 ) {
                vec3 ecIrisTarget = mix( diffuseColor.rgb * uEcIrisColor, vec3( max( ecLuma * 2.15, 0.20 ) ) * uEcIrisColor, 0.70 );
                diffuseColor.rgb = mix( diffuseColor.rgb, ecIrisTarget, ecIrisMask * uEcIrisTintMix );
              }
              diffuseColor.rgb *= mix( vec3( 1.0 ), mix( vec3( 0.84 ), ecIrisDetail * 1.18, 0.45 ), ecIrisMask );
              // Soft upper-eyelid ambient shadow strip grounding the eye inside the socket
              float ecUpperLidAo = 1.0 - smoothstep( 0.26, 0.72, vEcEyeNormal.y ) * 0.28;
              diffuseColor.rgb *= ecUpperLidAo;
            }`,
        )
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `
            {
              // Soft-clamp corneal specular peak <= 1.32 so eyes catch crisp window/sky glints without blooming
              float ecOutLum = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
              if ( ecOutLum > 1.12 ) {
                float ecSoft = 1.12 + 0.20 * ( ( ecOutLum - 1.12 ) / ( ( ecOutLum - 1.12 ) + 0.55 ) );
                outgoingLight *= ecSoft / max( ecOutLum, 1e-4 );
              }
            }
            #include <opaque_fragment>`,
        );
    }
  });
  if (options.attachWorldShaders) attachEchoWorldCharacterShaders(material);
}

/**
 * Applies the AAA Dual-Shift Kajiya-Kay Hair shader + strict specular radiance clamp (`<= 1.30`)
 * + root-to-tip ombre uniform + optional vertex-shader wind sway.
 */
export function applyHairAaaShader(
  material: T.MeshPhysicalMaterial,
  options: { vertexSway?: boolean; attachWorldShaders?: boolean } = {},
): void {
  const bank = getCharPbrBank();
  const uniforms = getOrCreateHairUniforms(material);
  const sway = !!options.vertexSway;
  material.anisotropy = Math.min(Math.max(material.anisotropy, 0), 0.24);
  material.anisotropyRotation = Math.PI * 0.5;
  material.specularIntensity = Math.min(material.specularIntensity, 0.22);
  material.roughness = Math.max(material.roughness, 0.58);
  const tag = sway ? 'ec-hair-aaa-sway-v1' : 'ec-hair-aaa-v1';
  chainMaterialShader(material, tag, (shader) => {
    if (shader.uniforms) {
      shader.uniforms.uEcHairStrandNormal = bank.hairStrandAnisoNormal;
      shader.uniforms.uEcTime = CHAR_SHARED_UNIFORMS.uEcTime;
      shader.uniforms.uEcWindVec = CHAR_SHARED_UNIFORMS.uEcWindVec;
      shader.uniforms.uEcSnowDust = CHAR_SHARED_UNIFORMS.uEcSnowDust;
      shader.uniforms.uEcHairTipColor = uniforms.uEcHairTipColor;
      shader.uniforms.uEcHairTipMix = uniforms.uEcHairTipMix;
    }
    if (shader.vertexShader) {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
            #include <common>
            uniform float uEcTime;
            uniform vec2 uEcWindVec;
            varying vec2 vEcCharUv;
            varying float vEcHairUp;`,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
            #include <begin_vertex>
            #ifdef USE_UV
              vEcCharUv = uv;
            #else
              vEcCharUv = vec2( 0.5 );
            #endif
            vEcHairUp = normalize( objectNormal ).y;
            ${
              sway
                ? /* glsl */ `
              // Subtle breezy tip sway on zero-hair-bone Codex52 / crowd GLBs (0.00 ms CPU)
              float ecTipW = smoothstep( 1.56, 1.24, position.y );
              float ecWindMag = clamp( length( uEcWindVec ), 0.15, 2.5 );
              float ecGust = sin( uEcTime * 2.8 + position.x * 7.5 + position.z * 6.0 ) * 0.65
                           + sin( uEcTime * 5.1 + position.y * 11.0 ) * 0.35;
              transformed.x += ( uEcWindVec.x * 0.005 + ecGust * 0.004 * ecWindMag ) * ecTipW;
              transformed.z += ( uEcWindVec.y * 0.005 - ecGust * 0.003 * ecWindMag ) * ecTipW;`
                : ''
            }`,
        );
    }
    if (shader.fragmentShader) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
            #include <common>
            uniform sampler2D uEcHairStrandNormal;
            uniform float uEcSnowDust;
            uniform vec3 uEcHairTipColor;
            uniform float uEcHairTipMix;
            varying vec2 vEcCharUv;
            varying float vEcHairUp;
            ${GLSL_PERTURB_HELPER}`,
        )
        .replace('#include <lights_physical_pars_fragment>', getHairAaaLightsPars())
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
            #include <map_fragment>
            if ( uEcHairTipMix > 0.001 ) {
              float ecTipGrad = smoothstep( 0.28, 0.90, 1.0 - vEcCharUv.y );
              diffuseColor.rgb = mix( diffuseColor.rgb, uEcHairTipColor, ecTipGrad * uEcHairTipMix );
            }`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
            #include <normal_fragment_maps>
            {
              float ecHairDist = smoothstep( 5.5, 1.4, length( vViewPosition ) );
              vec3 ecStrandN = texture2D( uEcHairStrandNormal, vEcCharUv * vec2( 3.0, 1.5 ) ).xyz * 2.0 - 1.0;
              normal = ecPerturbDetailNormal( -vViewPosition, normal, vEcCharUv * vec2( 3.0, 1.5 ), ecStrandN, 0.20 * ecHairDist );
            }`,
        )
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `
            {
              // Subtle frost/snowflakes resting on crown in snowy weather
              float ecCrownSnow = smoothstep( 0.68, 0.94, vEcHairUp ) * uEcSnowDust * 0.18;
              outgoingLight = mix( outgoingLight, vec3( 0.78, 0.83, 0.90 ), ecCrownSnow );
              // Hard total hair radiance soft-cap <= 1.12 (strictly <= 1.30 — guarantees ZERO bloom orb or white streak!)
              float ecHairLum = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
              if ( ecHairLum > 0.78 ) {
                float ecKnee = 0.78 + 0.34 * ( ( ecHairLum - 0.78 ) / ( ( ecHairLum - 0.78 ) + 0.50 ) );
                outgoingLight *= ecKnee / max( ecHairLum, 1e-4 );
              }
            }
            #include <opaque_fragment>`,
        );
    }
  });
  if (options.attachWorldShaders) attachEchoWorldCharacterShaders(material);
}

/**
 * Applies woven fabric micro-normal detail + Toksvig screen-space derivative (`fwidth`) moiré filter
 * + procedural textile patterns (stripe/plaid/heather) + smooth Winter/Snow outerwear adaptation
 * + subtle wind hem flutter (invariant shared program tag `ec-cloth-aaa-v1`).
 */
export function applyClothAaaShader(
  material: T.MeshPhysicalMaterial,
  winterTintHex: string,
  options: { allowWinterTint?: boolean; attachWorldShaders?: boolean } = {},
): void {
  const bank = getCharPbrBank();
  const winterColor = new T.Color(winterTintHex);
  const uniforms = getOrCreateClothUniforms(material, options.allowWinterTint === false ? 0 : 1);
  chainMaterialShader(material, 'ec-cloth-aaa-v1', (shader) => {
    if (shader.uniforms) {
      shader.uniforms.uEcFabricWeave = bank.fabricWeaveNormal;
      shader.uniforms.uEcTime = CHAR_SHARED_UNIFORMS.uEcTime;
      shader.uniforms.uEcWindVec = CHAR_SHARED_UNIFORMS.uEcWindVec;
      shader.uniforms.uEcWinterCoat = CHAR_SHARED_UNIFORMS.uEcWinterCoat;
      shader.uniforms.uEcSnowDust = CHAR_SHARED_UNIFORMS.uEcSnowDust;
      shader.uniforms.uEcWinterTint = { value: winterColor };
      shader.uniforms.uEcPatternParams = uniforms.uEcPatternParams;
      shader.uniforms.uEcAccentColor = uniforms.uEcAccentColor;
      shader.uniforms.uEcAllowWinterTint = uniforms.uEcAllowWinterTint;
    }
    if (shader.vertexShader) {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
            #include <common>
            uniform float uEcTime;
            uniform vec2 uEcWindVec;
            varying vec2 vEcCharUv;
            varying float vEcClothUp;`,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
            #include <begin_vertex>
            #ifdef USE_UV
              vEcCharUv = uv;
            #else
              vEcCharUv = vec2( 0.5 );
            #endif
            vEcClothUp = normalize( objectNormal ).y;
            #ifndef USE_SKINNING
              // Gentle unskinned cloth/banner hem breeze flutter; skipped on skinned character garments
              // so sleeves, waistbands, and collars never oscillate through Trim_* buttons, skin, or inner layers.
              float ecHemMask = smoothstep( 1.05, 0.62, position.y ) * smoothstep( 0.32, 0.55, position.y );
              float ecClothFlutter = sin( uEcTime * 3.1 + position.x * 8.0 + position.z * 7.0 ) * 0.0032 * clamp( length( uEcWindVec ), 0.2, 2.2 );
              transformed.x += ( uEcWindVec.x * 0.0022 + ecClothFlutter ) * ecHemMask;
              transformed.z += ( uEcWindVec.y * 0.0022 - ecClothFlutter * 0.7 ) * ecHemMask;
            #else
              if ( uEcTime < -1e9 ) transformed.x += uEcWindVec.x * 0.0;
            #endif`,
        );
    }
    if (shader.fragmentShader) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
            #include <common>
            uniform sampler2D uEcFabricWeave;
            uniform float uEcWinterCoat;
            uniform float uEcSnowDust;
            uniform vec3 uEcWinterTint;
            uniform vec4 uEcPatternParams;
            uniform vec3 uEcAccentColor;
            uniform float uEcAllowWinterTint;
            varying vec2 vEcCharUv;
            varying float vEcClothUp;
            ${GLSL_PERTURB_HELPER}`,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
            #include <map_fragment>
            if ( uEcPatternParams.x > 0.5 ) {
              vec2 ecPuv = vEcCharUv * uEcPatternParams.y;
              if ( uEcPatternParams.x < 1.5 ) {
                float ecStripe = smoothstep( 0.62, 0.72, fract( ecPuv.x ) );
                diffuseColor.rgb = mix( diffuseColor.rgb, mix( diffuseColor.rgb * ( 1.0 - uEcPatternParams.z ), uEcAccentColor, uEcPatternParams.w ), ecStripe );
              } else if ( uEcPatternParams.x < 2.5 ) {
                float ecBx = smoothstep( 0.68, 0.78, fract( ecPuv.x ) );
                float ecBy = smoothstep( 0.68, 0.78, fract( ecPuv.y ) );
                float ecGrid = clamp( ecBx * 0.55 + ecBy * 0.55, 0.0, 1.0 );
                float ecPin = smoothstep( 0.90, 0.96, fract( ecPuv.x ) ) + smoothstep( 0.90, 0.96, fract( ecPuv.y ) );
                diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * ( 1.0 - uEcPatternParams.z ), ecGrid * 0.75 );
                diffuseColor.rgb = mix( diffuseColor.rgb, uEcAccentColor, clamp( ecPin, 0.0, 1.0 ) * uEcPatternParams.w * 0.65 );
              } else {
                float ecH1 = fract( sin( dot( floor( ecPuv * 2.5 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
                float ecH2 = fract( sin( dot( floor( ecPuv * 5.0 ), vec2( 269.5, 183.3 ) ) ) * 43758.5453 );
                float ecSpeck = ( ecH1 * 0.6 + ecH2 * 0.4 - 0.5 ) * uEcPatternParams.z;
                diffuseColor.rgb = clamp( diffuseColor.rgb * ( 1.0 + ecSpeck ) + uEcAccentColor * max( ecSpeck, 0.0 ) * uEcPatternParams.w * 0.35, 0.0, 1.0 );
              }
            }
            if ( uEcWinterCoat * uEcAllowWinterTint > 0.01 ) {
              // Smoothly adapt bright summer clothing into deeper, cozy winter coat/wool shades
              float ecLum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
              vec3 ecCozy = mix( diffuseColor.rgb * 0.64, uEcWinterTint * ( 0.45 + ecLum * 0.65 ), 0.58 );
              diffuseColor.rgb = mix( diffuseColor.rgb, ecCozy, uEcWinterCoat * uEcAllowWinterTint );
            }
            if ( uEcSnowDust > 0.01 ) {
              float ecShoulderSnow = smoothstep( 0.58, 0.90, vEcClothUp ) * uEcSnowDust * 0.24;
              diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.86, 0.90, 0.95 ), ecShoulderSnow );
            }`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          /* glsl */ `
            #include <roughnessmap_fragment>
            {
              // Toksvig specular roughness compensation for filtered sub-pixel rib/twill normal frequencies
              vec2 ecRoughUvD = max( abs( dFdx( vEcCharUv ) ), abs( dFdy( vEcCharUv ) ) );
              float ecToksvig = smoothstep( 0.009, 0.034, max( ecRoughUvD.x, ecRoughUvD.y ) );
              roughnessFactor = clamp( sqrt( roughnessFactor * roughnessFactor + ecToksvig * 0.065 ), 0.04, 1.0 );
              roughnessFactor = mix( roughnessFactor, max( roughnessFactor, 0.90 ), uEcWinterCoat * uEcAllowWinterTint * 0.65 );
            }`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
            vec3 ecBaseClothNormal = normal;
            #include <normal_fragment_maps>
            {
              vec2 ecUvDeriv = max( abs( dFdx( vEcCharUv ) ), abs( dFdy( vEcCharUv ) ) );
              float ecNyquist = 1.0 - smoothstep( 0.009, 0.034, max( ecUvDeriv.x, ecUvDeriv.y ) );
              normal = normalize( mix( ecBaseClothNormal, normal, mix( 0.24, 1.0, ecNyquist ) ) );
              float ecClothDist = smoothstep( 5.0, 1.4, length( vViewPosition ) ) * ecNyquist;
              vec3 ecWeaveN = texture2D( uEcFabricWeave, vEcCharUv * 12.0 ).xyz * 2.0 - 1.0;
              normal = ecPerturbDetailNormal( -vViewPosition, normal, vEcCharUv * 12.0, ecWeaveN, 0.22 * ecClothDist );
            }`,
        );
    }
  });
  if (options.attachWorldShaders) attachEchoWorldCharacterShaders(material);
}

function hashClothKey(seedName: string): number {
  let h = 2166136261;
  for (let i = 0; i < seedName.length; i++) {
    h ^= seedName.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const WINTER_COAT_PALETTE = ['#243447', '#4a2630', '#2b3e33', '#3b3347', '#5c4636', '#2e3640'] as const;
function pickWinterTint(seedName: string): string {
  return WINTER_COAT_PALETTE[hashClothKey(seedName) % WINTER_COAT_PALETTE.length];
}

function pickSafeTopColor(seedName: string): T.Color {
  return new T.Color(CROWD_SAFE_TOP_PALETTE[hashClothKey(seedName) % CROWD_SAFE_TOP_PALETTE.length]);
}

/** Deterministic surface classifier covering all 72 material signatures across RunnerRig, Codex52, and Echo59. */
export function classifyCharacterSurface(meshName: string, materialName: string): CharacterSurfaceClass {
  const m = (materialName || '').trim();
  const o = (meshName || '').trim();
  const both = `${o} ${m}`;

  if (/^Cast_Eyes/i.test(o) || /^Eyes$/i.test(o) || /^Eyes$/i.test(m) || /^Mat_Eye_/i.test(m) || /^cast_eye/i.test(m)) {
    return 'eyes';
  }
  if (/^Brows$/i.test(o) || /^Brows$/i.test(m)) {
    return 'brows';
  }
  if (/^Cast_Hair/i.test(o) || /^Hair/i.test(o) || /^Hair/i.test(m) || /^Mat_Hair_/i.test(m) || /^cast_hair/i.test(m)) {
    return 'hair';
  }
  if (/^Cast_Face/i.test(o) || /^Face_and_visible_skin/i.test(o) || /^Mat_Face_/i.test(m) || /^cast_face/i.test(m)) {
    return 'skin_face';
  }
  if (
    /Hands/i.test(o) ||
    /^skin$/i.test(m) ||
    /^Mat_(Skin|HandSkin)_/i.test(m) ||
    /^Hand_Skin/i.test(m) ||
    /^Canonical_MH_Body/i.test(o)
  ) {
    return 'skin_body';
  }
  if (/^Atelier_glass/i.test(m) || /glasses/i.test(both)) {
    return 'glass';
  }
  if (/^Atelier_metal/i.test(m)) {
    return 'metal';
  }
  if (/^Mat_Sole_/i.test(m) || /^Trim_Soles_/i.test(o)) {
    return 'footwear_sole';
  }
  if (/loafer|boot|leather/i.test(both)) {
    return 'footwear_leather';
  }
  if (/^Shoes_/i.test(o) || /^Shoes_/i.test(m) || /^footwear$/i.test(m) || /^Mat_Shoe_/i.test(m) || /^Wear_Shoes_/i.test(o)) {
    return 'footwear_sneaker';
  }
  if (/denim|jeans/i.test(both)) {
    return 'cloth_denim';
  }
  if (/knit|cardigan|sweater|fleece|scarf/i.test(both) || /^Cast_Scarf/i.test(o)) {
    return 'cloth_knit';
  }
  if (/^Mat_Acc_/i.test(m) || /backpack/i.test(both)) {
    return 'accessory';
  }
  return 'cloth_cotton';
}

export function createCharacterSkinMaterial(
  source: T.MeshStandardMaterial,
  options: { face?: boolean; quality?: CharacterQuality; vertexColors?: boolean; attachWorldShaders?: boolean } = {},
): T.MeshStandardMaterial {
  const face = !!options.face;
  const low = options.quality === 'low';
  const hasRoughMap = !!source.roughnessMap;
  // Body skin (`Wear_skin`, `Canonical_MH_Body`, etc.) pushes depth back (+2/+2) behind Runner_Hands (+1/+1), shirts (0/0), and outerwear (-1.5/-3)
  const skinDepthOffset = !face
    ? { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }
    : {};
  const sourceBaseTint = (source.userData as { ecBaseSkinTint?: T.Color } | undefined)?.ecBaseSkinTint;
  if (low) {
    // Low-tier iGPU diet: lean MeshStandardMaterial (zero clearcoat/sheen/pore/Kajiya-Kay overhead)
    const lowMat = new T.MeshStandardMaterial({
      name: source.name ? `PBR_Skin_${source.name}` : face ? 'PBR_Skin_Face' : 'PBR_Skin_Body',
      map: source.map ?? null,
      color: source.color ? source.color.clone() : new T.Color('#ffffff'),
      vertexColors: options.vertexColors ?? source.vertexColors,
      normalMap: source.normalMap ?? null,
      roughnessMap: source.roughnessMap ?? null,
      aoMap: source.aoMap ?? null,
      aoMapIntensity: source.aoMapIntensity,
      roughness: hasRoughMap ? 1.0 : face ? 0.54 : 0.60,
      metalness: 0,
      envMapIntensity: 0.45,
      ...skinDepthOffset,
      side: source.side,
    });
    if (sourceBaseTint) lowMat.userData.ecBaseSkinTint = sourceBaseTint.clone();
    if (options.attachWorldShaders) attachEchoWorldCharacterShaders(lowMat);
    return lowMat;
  }
  const mat = new T.MeshPhysicalMaterial({
    name: source.name ? `PBR_Skin_${source.name}` : face ? 'PBR_Skin_Face' : 'PBR_Skin_Body',
    map: source.map ?? null,
    color: source.color ? source.color.clone() : new T.Color('#ffffff'),
    vertexColors: options.vertexColors ?? source.vertexColors,
    normalMap: source.normalMap ?? null,
    ...(source.normalMap ? { normalScale: source.normalScale.clone().multiplyScalar(1.25) } : {}),
    roughnessMap: source.roughnessMap ?? null,
    aoMap: source.aoMap ?? null,
    aoMapIntensity: source.aoMapIntensity,
    roughness: hasRoughMap ? 1.0 : face ? 0.50 : 0.56,
    metalness: 0,
    specularIntensity: face ? 0.42 : 0.46,
    specularColor: new T.Color('#ffe8db'),
    sheen: face ? 0.14 : 0.20,
    sheenRoughness: 0.72,
    sheenColor: new T.Color('#d87b60'),
    envMapIntensity: 0.52,
    ...skinDepthOffset,
    side: source.side,
  });
  if (sourceBaseTint) mat.userData.ecBaseSkinTint = sourceBaseTint.clone();
  applySkinAaaUpgrade(mat, face, { attachWorldShaders: options.attachWorldShaders });
  return mat;
}

function buildUpgradedMaterial(
  mesh: T.Mesh,
  source: T.MeshStandardMaterial,
  surface: CharacterSurfaceClass,
  quality: CharacterQuality,
  vertexHairSway: boolean,
  actorKey = '',
): T.Material {
  const low = quality === 'low';
  const baseColor = source.color ? source.color.clone() : new T.Color('#ffffff');
  const meshAndMat = `${mesh.name} ${source.name}`;
  const isOuterwear = /^(wear_outer|trim_outer|mat_outer)|overcoat|parka|trench|winter_coat/i.test(meshAndMat);
  const isClothingTop = !isOuterwear && /wear_top|shirt|tee|upper|blouse|sweater|polo|oxford/i.test(meshAndMat);
  if (
    (surface === 'cloth_cotton' || surface === 'cloth_knit') &&
    !source.map &&
    (isFleshLikeClothColor(baseColor) || /mat_top_.*f3d5b5/i.test(source.name) || (actorKey.startsWith('crowd:') && isClothingTop))
  ) {
    // Strictly replace beige/peach/flesh-toned untextured shirts (e.g. `crowd_student_a`'s `#f3d5b5`)
    // and diversify ambient crowd tops with rich non-skin wardrobe colors!
    baseColor.copy(pickSafeTopColor(`${actorKey || 'npc'}:${mesh.name}:${source.name}`));
  }

  switch (surface) {
    case 'skin_face':
      return createCharacterSkinMaterial(source, { face: true, quality });

    case 'skin_body':
      return createCharacterSkinMaterial(source, { face: false, quality });

    case 'eyes': {
      if (low) {
        return new T.MeshStandardMaterial({
          name: `PBR_Eye_${source.name || 'eye'}`,
          map: source.map ?? null,
          color: baseColor,
          vertexColors: source.vertexColors,
          roughness: 0.08,
          metalness: 0,
          envMapIntensity: 0.9,
          side: T.FrontSide,
        });
      }
      // Zero artificial flat emissiveIntensity (0.12–0.16 removed!) — crisp wet corneal catchlights & dark pupils
      const eye = new T.MeshPhysicalMaterial({
        name: `PBR_Eye_${source.name || 'eye'}`,
        map: source.map ?? null,
        color: baseColor,
        vertexColors: source.vertexColors,
        roughness: 0.055,
        metalness: 0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.025,
        ior: 1.38,
        specularIntensity: 1.0,
        envMapIntensity: 1.22,
        emissive: new T.Color('#000000'),
        emissiveIntensity: 0,
        side: T.FrontSide,
      });
      applyEyeAaaShader(eye);
      return eye;
    }

    case 'hair': {
      const isAlphaCard = source.transparent || source.alphaTest > 0;
      if (low) {
        return new T.MeshStandardMaterial({
          name: `PBR_Hair_${source.name || 'hair'}`,
          map: source.map ?? null,
          color: baseColor,
          vertexColors: source.vertexColors,
          roughness: 0.64,
          metalness: 0,
          envMapIntensity: 0.30,
          transparent: false,
          alphaTest: isAlphaCard ? 0.42 : 0,
          depthWrite: true,
          polygonOffset: true,
          polygonOffsetFactor: -0.5,
          polygonOffsetUnits: -1,
          side: T.DoubleSide,
        });
      }
      const hasTangents =
        !!mesh.geometry.getAttribute('uv') &&
        !!mesh.geometry.index &&
        (!!mesh.geometry.getAttribute('tangent') || tryComputeTangents(mesh.geometry));
      // Warm dark hair-tinted specular (never pure white 0xffffff!) — eliminates bright white crown streaks
      const warmGlint = baseColor.clone().multiplyScalar(0.55).lerp(new T.Color('#5a4030'), 0.35);
      const hair = new T.MeshPhysicalMaterial({
        name: `PBR_Hair_${source.name || 'hair'}`,
        map: source.map ?? null,
        color: baseColor,
        vertexColors: source.vertexColors,
        normalMap: source.normalMap ?? null,
        roughness: 0.58,
        metalness: 0,
        anisotropy: hasTangents ? 0.24 : 0,
        anisotropyRotation: Math.PI * 0.5, // Aligned with UV bitangent V (root -> tip strand flow!)
        specularIntensity: 0.22,
        specularColor: warmGlint,
        sheen: 0.08,
        sheenRoughness: 0.78,
        sheenColor: baseColor.clone().lerp(new T.Color('#6b4d3b'), 0.28),
        envMapIntensity: 0.32,
        transparent: false,
        alphaTest: isAlphaCard ? 0.42 : 0,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: -0.5,
        polygonOffsetUnits: -1,
        side: T.DoubleSide,
      });
      applyHairAaaShader(hair, { vertexSway: vertexHairSway });
      return hair;
    }

    case 'brows': {
      const isAlphaCard = source.transparent || source.alphaTest > 0;
      return new T.MeshStandardMaterial({
        name: `PBR_Brows_${source.name || 'brows'}`,
        map: source.map ?? null,
        color: baseColor,
        vertexColors: source.vertexColors,
        roughness: 0.62,
        metalness: 0,
        envMapIntensity: 0.42,
        transparent: false,
        alphaTest: isAlphaCard ? 0.38 : 0,
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
        side: T.DoubleSide,
      });
    }

    case 'cloth_denim': {
      if (low) {
        return new T.MeshStandardMaterial({
          name: `PBR_Denim_${source.name || 'denim'}`,
          map: source.map ?? null,
          color: baseColor,
          vertexColors: source.vertexColors,
          roughness: 0.88,
          metalness: 0,
          envMapIntensity: 0.4,
          polygonOffset: true,
          polygonOffsetFactor: -0.5,
          polygonOffsetUnits: -1,
          side: source.side,
        });
      }
      const denim = new T.MeshPhysicalMaterial({
        name: `PBR_Denim_${source.name || 'denim'}`,
        map: source.map ?? null,
        color: baseColor,
        vertexColors: source.vertexColors,
        normalMap: source.normalMap ?? null,
        ...(source.normalMap ? { normalScale: source.normalScale.clone() } : {}),
        roughnessMap: source.roughnessMap ?? null,
        aoMap: source.aoMap ?? null,
        roughness: source.roughnessMap ? 1.0 : 0.88,
        metalness: 0,
        sheen: 0.16,
        sheenRoughness: 0.84,
        sheenColor: baseColor.clone().lerp(new T.Color('#dce8f5'), 0.24),
        envMapIntensity: 0.44,
        polygonOffset: true,
        polygonOffsetFactor: -0.5,
        polygonOffsetUnits: -1,
        side: source.side,
      });
      applyClothAaaShader(denim, '#243447');
      return denim;
    }

    case 'cloth_knit': {
      if (low) {
        return new T.MeshStandardMaterial({
          name: `PBR_Knit_${source.name || 'knit'}`,
          map: source.map ?? null,
          color: baseColor,
          vertexColors: source.vertexColors,
          roughness: 0.90,
          metalness: 0,
          envMapIntensity: 0.4,
          ...(isOuterwear ? { polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -3 } : { polygonOffset: false }),
          side: source.side,
        });
      }
      const knit = new T.MeshPhysicalMaterial({
        name: `PBR_Knit_${source.name || 'knit'}`,
        map: source.map ?? null,
        color: baseColor,
        vertexColors: source.vertexColors,
        normalMap: source.normalMap ?? null,
        roughnessMap: source.roughnessMap ?? null,
        aoMap: source.aoMap ?? null,
        roughness: source.roughnessMap ? 1.0 : 0.9,
        metalness: 0,
        sheen: 0.52,
        sheenRoughness: 0.78,
        sheenColor: baseColor.clone().lerp(new T.Color('#ffffff'), 0.30),
        envMapIntensity: 0.45,
        ...(isOuterwear ? { polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -3 } : { polygonOffset: false }),
        side: source.side,
      });
      applyClothAaaShader(knit, pickWinterTint(`${mesh.name}:${source.name}`));
      return knit;
    }

    case 'footwear_leather':
      if (low) {
        return new T.MeshStandardMaterial({
          name: `PBR_Leather_${source.name || 'leather'}`,
          map: source.map ?? null,
          color: baseColor,
          vertexColors: source.vertexColors,
          roughness: 0.42,
          metalness: 0.02,
          envMapIntensity: 0.55,
          side: source.side,
        });
      }
      return new T.MeshPhysicalMaterial({
        name: `PBR_Leather_${source.name || 'leather'}`,
        map: source.map ?? null,
        color: baseColor,
        vertexColors: source.vertexColors,
        normalMap: source.normalMap ?? null,
        roughness: 0.38,
        metalness: 0.02,
        clearcoat: 0.25,
        clearcoatRoughness: 0.34,
        envMapIntensity: 0.65,
        side: source.side,
      });

    case 'footwear_sneaker':
      if (low) {
        return new T.MeshStandardMaterial({
          name: `PBR_Sneaker_${source.name || 'sneaker'}`,
          map: source.map ?? null,
          color: baseColor,
          vertexColors: source.vertexColors,
          roughness: 0.58,
          metalness: 0.02,
          envMapIntensity: 0.45,
          side: source.side,
        });
      }
      return new T.MeshPhysicalMaterial({
        name: `PBR_Sneaker_${source.name || 'sneaker'}`,
        map: source.map ?? null,
        color: baseColor,
        vertexColors: source.vertexColors,
        normalMap: source.normalMap ?? null,
        roughness: 0.54,
        metalness: 0.02,
        sheen: 0.08,
        sheenRoughness: 0.8,
        envMapIntensity: 0.52,
        side: source.side,
      });

    case 'footwear_sole':
      return new T.MeshStandardMaterial({
        name: `PBR_Sole_${source.name || 'sole'}`,
        map: source.map ?? null,
        color: baseColor,
        vertexColors: source.vertexColors,
        roughness: 0.74,
        metalness: 0,
        envMapIntensity: 0.4,
        side: source.side,
      });

    case 'glass':
      if (low) {
        return new T.MeshStandardMaterial({
          name: `PBR_Glass_${source.name || 'glass'}`,
          map: source.map ?? null,
          color: baseColor,
          roughness: 0.16,
          metalness: 0.08,
          envMapIntensity: 0.75,
          side: source.side,
        });
      }
      return new T.MeshPhysicalMaterial({
        name: `PBR_Glass_${source.name || 'glass'}`,
        map: source.map ?? null,
        color: baseColor,
        roughness: 0.12,
        metalness: 0.05,
        clearcoat: 1.0,
        clearcoatRoughness: 0.06,
        envMapIntensity: 0.9,
        side: source.side,
      });

    case 'metal':
      return new T.MeshStandardMaterial({
        name: `PBR_Metal_${source.name || 'metal'}`,
        map: source.map ?? null,
        color: baseColor,
        roughness: 0.28,
        metalness: 0.78,
        envMapIntensity: 0.85,
        side: source.side,
      });

    case 'accessory':
      if (low) {
        return new T.MeshStandardMaterial({
          name: `PBR_Acc_${source.name || 'acc'}`,
          map: source.map ?? null,
          color: baseColor,
          vertexColors: source.vertexColors,
          roughness: 0.78,
          metalness: 0.02,
          envMapIntensity: 0.42,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -4,
          side: source.side,
        });
      }
      return new T.MeshPhysicalMaterial({
        name: `PBR_Acc_${source.name || 'acc'}`,
        map: source.map ?? null,
        color: baseColor,
        vertexColors: source.vertexColors,
        roughness: 0.76,
        metalness: 0.02,
        sheen: 0.15,
        sheenRoughness: 0.82,
        envMapIntensity: 0.48,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
        side: source.side,
      });

    case 'cloth_cotton':
    default: {
      if (low) {
        return new T.MeshStandardMaterial({
          name: `PBR_Cloth_${source.name || 'cotton'}`,
          map: source.map ?? null,
          color: baseColor,
          vertexColors: source.vertexColors,
          roughness: 0.86,
          metalness: 0,
          envMapIntensity: 0.42,
          transparent: false,
          alphaTest: 0,
          depthWrite: true,
          ...(isOuterwear ? { polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -3 } : { polygonOffset: false }),
          side: source.side,
        });
      }
      const cotton = new T.MeshPhysicalMaterial({
        name: `PBR_Cloth_${source.name || 'cotton'}`,
        map: source.map ?? null,
        color: baseColor,
        vertexColors: source.vertexColors,
        normalMap: source.normalMap ?? null,
        roughnessMap: source.roughnessMap ?? null,
        aoMap: source.aoMap ?? null,
        roughness: source.roughnessMap ? 1.0 : 0.84,
        metalness: 0,
        sheen: 0.30,
        sheenRoughness: 0.78,
        sheenColor: baseColor.clone().lerp(new T.Color('#ffffff'), 0.26),
        envMapIntensity: 0.46,
        transparent: false,
        alphaTest: 0,
        depthWrite: true,
        ...(isOuterwear ? { polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -3 } : { polygonOffset: false }),
        side: source.side,
      });
      applyClothAaaShader(cotton, pickWinterTint(`${mesh.name}:${source.name}`));
      return cotton;
    }
  }
}

function tryComputeTangents(geo: T.BufferGeometry): boolean {
  try {
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    geo.computeTangents();
    return !!geo.getAttribute('tangent');
  } catch {
    return false;
  }
}

function emptyCounts(): Record<CharacterSurfaceClass, number> {
  return {
    skin_face: 0,
    skin_body: 0,
    eyes: 0,
    hair: 0,
    brows: 0,
    cloth_cotton: 0,
    cloth_knit: 0,
    cloth_denim: 0,
    footwear_leather: 0,
    footwear_sneaker: 0,
    footwear_sole: 0,
    glass: 0,
    metal: 0,
    accessory: 0,
  };
}

/**
 * Traverses a character scene graph (Player, Codex52 resident, or Echo59 crowd) and upgrades all meshes to
 * AAA digital-human materials with proper `castShadow` and `receiveShadow` flags.
 * Returns every newly allocated `THREE.Material` so the caller can dispose them cleanly on actor teardown.
 */
export function upgradeCharacterMaterials(
  root: T.Object3D,
  options: UpgradeCharacterOptions = {},
): UpgradeCharacterResult {
  const quality = options.quality ?? 'high';
  const castShadow = options.castShadow ?? quality !== 'low';
  const receiveShadow = options.receiveShadow ?? quality !== 'low';
  const vertexHairSway = options.vertexHairSway ?? true;
  const actorKey = options.actorKey ?? '';
  const attachWorld = options.attachWorldShaders !== false;
  const owned: T.Material[] = [];
  const counts = emptyCounts();

  root.traverse((o) => {
    const mesh = o as T.Mesh;
    if (!mesh.isMesh) return;
    if (options.skipMesh?.(mesh)) return;

    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const upgraded: T.Material[] = [];
    let hasEyesOnly = true;
    let isMicroShadow = isShadowMicroDetailMesh(mesh.name);

    for (const raw of list) {
      if (!(raw instanceof T.MeshStandardMaterial)) {
        upgraded.push(raw);
        hasEyesOnly = false;
        continue;
      }
      const surface = classifyCharacterSurface(mesh.name, raw.name);
      counts[surface]++;
      if (surface !== 'eyes') hasEyesOnly = false;
      if (
        surface === 'eyes' ||
        surface === 'brows' ||
        surface === 'footwear_sole' ||
        surface === 'glass' ||
        surface === 'metal' ||
        isShadowMicroDetailMesh(mesh.name, raw.name)
      ) {
        isMicroShadow = true;
      }
      const next = buildUpgradedMaterial(mesh, raw, surface, quality, vertexHairSway, actorKey);
      if (attachWorld) attachEchoWorldCharacterShaders(next);
      options.patchMaterial?.(next);
      upgraded.push(next);
      owned.push(next);
    }

    mesh.material = Array.isArray(mesh.material) ? upgraded : upgraded[0];
    mesh.castShadow = hasEyesOnly || isMicroShadow ? false : castShadow;
    mesh.receiveShadow = hasEyesOnly ? false : receiveShadow;
  });

  return { materials: owned, counts };
}
