import * as T from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  FABRICS,
  SKIN_TONE,
  WARDROBE,
  WAVE11_ACCESSORY_URLS,
  WAVE11_HAIR_URLS,
  WAVE11_OUTERWEAR_URLS,
  type Covers,
  type WardrobeItem,
} from './wardrobeAssets';
import { SIGNATURE, hasLayeredCoat, isSignature, lookFiles, normalizeLook, type AvatarLook, type Hero } from './look';
import type {
  CharacterCreatorProfile,
  FabricId,
  HairStyleId,
  OutfitSlotConfig,
  OuterwearId,
  PatternId,
} from './characterCreator';
import {
  applyClothAaaShader,
  applyHairAaaShader,
  attachEchoWorldCharacterShaders,
  createCharacterSkinMaterial,
  setClothPatternUniform,
  setHairTipUniform,
  setSkinToneUniform,
  type CharacterQuality,
} from '@/components/study-space/world/echoLife/characterMaterials';
import type {
  HairBoneRestOverride,
  SecondaryPhysics,
  SecondaryWearableContext,
} from '@/components/study-space/world/echoLife/secondaryPhysics';

/**
 * Clothes, modular 3D hair, layered outerwear, and accessories on a RunnerRig body.
 * Every garment and hairstyle is rebound to the live 65-bone skeleton so every clip,
 * IK layer, XPBD hair/scarf chain, and camera moves it identically to the body inside.
 */
const loader = new GLTFLoader();
const files = new Map<string, Promise<GLTF>>();
function loadFile(url: string) {
  let p = files.get(url);
  if (!p) { p = loader.loadAsync(url).catch(e => { files.delete(url); throw e; }); files.set(url, p); }
  return p;
}
const textures = new Map<string, T.Texture>();
const texturePromises = new Map<string, Promise<T.Texture>>();
const texLoader = new T.TextureLoader();
function tile(url: string, srgb: boolean) {
  let t = textures.get(url);
  if (!t) {
    if (typeof Image === 'undefined') {
      t = new T.Texture();
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.anisotropy = 4;
      if (srgb) t.colorSpace = T.SRGBColorSpace;
      textures.set(url, t);
      texturePromises.set(url, Promise.resolve(t));
    } else {
      let resolveTex!: (tex: T.Texture) => void;
      const pending = new Promise<T.Texture>(resolve => {
        resolveTex = resolve;
      });
      t = texLoader.load(
        url,
        loadedTex => resolveTex(loadedTex),
        undefined,
        () => resolveTex(t!),
      );
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.anisotropy = 4;
      if (srgb) t.colorSpace = T.SRGBColorSpace;
      textures.set(url, t);
      texturePromises.set(url, pending);
    }
  }
  return t;
}
export async function awaitWardrobeTextures(): Promise<void> {
  if (texturePromises.size === 0) return;
  await Promise.all(texturePromises.values());
}
export function forgetWardrobe() {
  files.clear();
  texturePromises.clear();
  textures.forEach(t => t.dispose());
  textures.clear();
}

type ExtendedSlot = WardrobeItem['slot'] | 'outerwear' | 'hair';
interface ExtendedWardrobeItem {
  id: string;
  slot: ExtendedSlot;
  url: string;
  fabric?: string | null;
  covers?: Covers;
  pattern?: PatternId;
}

interface Worn {
  item: ExtendedWardrobeItem;
  meshes: T.SkinnedMesh[];
  materials: T.Material[];
  own: T.BufferGeometry[];
  isBackpack?: boolean;
  hairRestOverrides?: Map<string, HairBoneRestOverride>;
}

const HAIR_CHAIN_BONE_NAMES = ['pony.1', 'pony.2', 'pony.3', 'side.L', 'side.R', 'fringe'] as const;
const HAIR_CHAIN_BONE_SET = new Set<string>(HAIR_CHAIN_BONE_NAMES);

export interface WardrobeApplyOptions {
  hairId?: HairStyleId | null;
  hairColor?: string;
  hairTipColor?: string;
  hairTipMix?: number;
  skinHex?: string;
  outerwear?: OuterwearId;
  outfit?: OutfitSlotConfig;
  quality?: CharacterQuality;
  attachWorldShaders?: boolean;
  onExternalHair?: (group: T.Object3D | null) => void;
  onBuiltinHairVisible?: (visible: boolean) => void;
  onWearableContext?: (ctx: SecondaryWearableContext) => void;
}

const HEAD_ACCESSORIES = new Set(['glasses', 'sunglasses', 'headphones', 'cap', 'beanie']);

const EXTRA_FABRIC_PARAMS: Record<
  string,
  { baseKey: string; roughness: number; sheen: number; clearcoat?: number; normalScale?: number }
> = {
  // Melton wool is a felted twill broadcloth (not a coarse 24-row sweater rib-knit) -> eliminates Nyquist rib moiré
  wool: { baseKey: 'cotton', roughness: 0.92, sheen: 0.24, normalScale: 0.30 },
  puffer: { baseKey: 'canvas', roughness: 0.38, sheen: 0.22, clearcoat: 0.16, normalScale: 0.36 },
};

const OUTERWEAR_COVERS: Record<string, Covers> = {
  wool_overcoat: { torso: [0.68, 1.36], arm: 0.94 },
  puffer_parka: { torso: [0.82, 1.36], arm: 0.95 },
  trench_coat: { torso: [0.64, 1.36], arm: 0.94 },
  cardigan: { torso: [0.88, 1.36], arm: 0.93 },
  jacket: { torso: [0.92, 1.36], arm: 0.94 },
  hoodie: { torso: [0.92, 1.36], arm: 0.93 },
  winter_scarf: {},
};

const OUTERWEAR_DEFAULT_FABRIC: Record<string, FabricId> = {
  wool_overcoat: 'wool',
  puffer_parka: 'puffer',
  trench_coat: 'canvas',
  cardigan: 'knit',
  winter_scarf: 'knit',
  jacket: 'canvas',
  hoodie: 'fleece',
};

function fabricMaterial(
  kind: string,
  color: string,
  quality: CharacterQuality = 'high',
  attachWorldShaders = false,
) {
  const extra = EXTRA_FABRIC_PARAMS[kind];
  const f = FABRICS[extra ? extra.baseKey : kind] ?? FABRICS.cotton;
  const roughness = extra ? extra.roughness : f.roughness;
  const sheen = extra ? extra.sheen : f.sheen;
  const nScale = extra?.normalScale ?? (kind === 'knit' ? 0.42 : 0.52);
  if (quality === 'low') {
    const lowMat = new T.MeshStandardMaterial({
      name: 'Fabric ' + kind,
      color: new T.Color(color),
      map: tile(f.map, true),
      roughness,
      metalness: 0,
      vertexColors: true,
      envMapIntensity: 0.45,
    });
    if (attachWorldShaders) attachEchoWorldCharacterShaders(lowMat);
    return lowMat;
  }
  const m = new T.MeshPhysicalMaterial({
    name: 'Fabric ' + kind,
    color: new T.Color(color),
    map: tile(f.map, true),
    normalMap: tile(f.normal, false),
    normalScale: new T.Vector2(nScale, nScale),
    roughness,
    metalness: 0,
    vertexColors: true,
    sheen,
    sheenRoughness: 0.75,
    sheenColor: new T.Color(color).lerp(new T.Color('#ffffff'), 0.35),
    clearcoat: extra?.clearcoat ?? 0,
    clearcoatRoughness: 0.42,
    envMapIntensity: 0.55,
  });
  if (kind !== 'leather') {
    applyClothAaaShader(m, '#2e3640', { allowWinterTint: false, attachWorldShaders });
  } else if (attachWorldShaders) {
    attachEchoWorldCharacterShaders(m);
  }
  return m;
}

function hairMaterial(
  source: T.MeshStandardMaterial | null,
  colorHex: string,
  quality: CharacterQuality = 'high',
  attachWorldShaders = false,
): T.Material {
  const hairColor = new T.Color(colorHex);
  if (quality === 'low') {
    const lowHair = new T.MeshStandardMaterial({
      name: 'Wear_Hair',
      map: source?.map ?? null,
      color: hairColor,
      vertexColors: true,
      roughness: 0.64,
      metalness: 0,
      envMapIntensity: 0.32,
      polygonOffset: true,
      polygonOffsetFactor: -0.5,
      polygonOffsetUnits: -1,
      side: T.DoubleSide,
    });
    if (attachWorldShaders) attachEchoWorldCharacterShaders(lowHair);
    return lowHair;
  }
  const hairGlint = hairColor.clone().multiplyScalar(0.55).lerp(new T.Color('#5a4030'), 0.35);
  const m = new T.MeshPhysicalMaterial({
    name: 'Wear_Hair',
    map: source?.map ?? null,
    color: hairColor,
    vertexColors: true,
    roughness: 0.58,
    metalness: 0,
    anisotropy: 0.24,
    anisotropyRotation: Math.PI * 0.5,
    specularIntensity: 0.22,
    specularColor: hairGlint,
    sheen: 0.08,
    sheenRoughness: 0.78,
    sheenColor: hairColor.clone().lerp(new T.Color('#6b4d3b'), 0.28),
    envMapIntensity: 0.32,
    polygonOffset: true,
    polygonOffsetFactor: -0.5,
    polygonOffsetUnits: -1,
    side: T.DoubleSide,
  });
  applyHairAaaShader(m, { vertexSway: false, attachWorldShaders });
  return m;
}

/**
 * Recomputes smooth vertex normals while welding coincident UV-seam vertices within each connected
 * shell component so cylindrical bodice/skirt/sleeve UV seams never split into faceted hard creases.
 */
function computeComponentWeldedNormals(geom: T.BufferGeometry, compOfVert: Int32Array | null): void {
  geom.computeVertexNormals();
  const pos = geom.getAttribute('position') as T.BufferAttribute | undefined;
  const nrm = geom.getAttribute('normal') as T.BufferAttribute | undefined;
  if (!pos || !nrm) return;

  const groups = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const cId = compOfVert ? compOfVert[i] : 0;
    const kx = Math.round(pos.getX(i) * 10000);
    const ky = Math.round(pos.getY(i) * 10000);
    const kz = Math.round(pos.getZ(i) * 10000);
    const key = `${cId}:${kx}:${ky}:${kz}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(i);
  }

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    let sx = 0, sy = 0, sz = 0;
    for (let k = 0; k < list.length; k++) {
      const idx = list[k];
      sx += nrm.getX(idx);
      sy += nrm.getY(idx);
      sz += nrm.getZ(idx);
    }
    const len = Math.hypot(sx, sy, sz);
    if (len > 1e-6) {
      const inv = 1 / len;
      sx *= inv;
      sy *= inv;
      sz *= inv;
      for (let k = 0; k < list.length; k++) {
        nrm.setXYZ(list[k], sx, sy, sz);
      }
    }
  }
  nrm.needsUpdate = true;
}

function hermiteStep(edge0: number, edge1: number, x: number): number {
  const t = T.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * One-time load-time post-processor (`< 0.25 ms`, zero disk GLB mutations -> 464/464 provenance intact):
 * 1) Re-weights `wool_overcoat` and `trench_coat` skirts below the skirt top rim (`y < 0.924 m`) with strict
 *    C1 zero-jump continuity (`wSpine = wUpperOrig * (1 - s)`, `s = 0` and `ds/dy = 0` at `y = 0.924 m`) and
 *    tucks the bodice's hidden lower overlap margin (`y < 0.930 m`) radially inward so bodice/skirt shells
 *    never Z-fight or separate at the waist under CAZ sliders or contrapposto/gait spine tilts.
 * 2) Tapers `wool_overcoat`'s uniform `+29 mm` sleeve radius (`build_wave11_wardrobe.py:707`) inward by `7..13.5 mm`
 *    toward the wrist cuff for a crisp tailored coat silhouette.
 * 3) Re-balances Wave 11 coat deltoid and axilla weights (`wool_overcoat`, `trench_coat`, `puffer_parka`, `cardigan`)
 *    across the glenohumeral pivot (`|x| = 0.158 m`) to match `Runner_Body` and `Wear_longsleeve`, preventing
 *    shoulder/armpit collapse when raising arms or holding objects.
 * 4) Conforms forearm and wrist-cuff weights across all sleeved garments and `Wear_skin`/`Trim_skin`: removes distal
 *    `upper_arm` elbow-crease bowstringing, caps wrist-hinge `hand` weight so flexing the palm never crimps sleeve cuffs,
 *    and aligns the `forearm -> fore_twist` pronation ramp with `Runner_Hands` (`0` candy-wrapper wrist shrinkage).
 */
function refineGarmentRiggingAndConform(root: T.Object3D, slot: ExtendedSlot, itemId: string): void {
  if (slot !== 'skin' && slot !== 'top' && slot !== 'dress' && slot !== 'outerwear') return;
  const isLongSkirt = slot === 'outerwear' && (itemId === 'wool_overcoat' || itemId === 'trench_coat');
  const isWave11Coat =
    slot === 'outerwear' &&
    (itemId === 'wool_overcoat' ||
      itemId === 'trench_coat' ||
      itemId === 'puffer_parka' ||
      itemId === 'cardigan');

  root.traverse(obj => {
    const sm = obj as T.SkinnedMesh;
    if (!sm.isSkinnedMesh || !sm.geometry || sm.geometry.userData.__ecCoatRefined) return;
    const geom = sm.geometry;
    geom.userData.__ecCoatRefined = true;

    const pos = geom.getAttribute('position') as T.BufferAttribute | undefined;
    const joints = geom.getAttribute('skinIndex') as T.BufferAttribute | undefined;
    const weights = geom.getAttribute('skinWeight') as T.BufferAttribute | undefined;
    if (!pos || !joints || !weights || !sm.skeleton) return;

    const bones = sm.skeleton.bones;
    const boneNameOf = (b: T.Bone) => (b.userData.name as string | undefined) ?? b.name;
    const idxHips = bones.findIndex(b => boneNameOf(b) === 'hips');
    const idxSpine = bones.findIndex(b => boneNameOf(b) === 'spine');
    const idxChest = bones.findIndex(b => boneNameOf(b) === 'chest');
    const idxNeck = bones.findIndex(b => boneNameOf(b) === 'neck');
    const idxThighL = bones.findIndex(b => boneNameOf(b) === 'thigh.L');
    const idxThighR = bones.findIndex(b => boneNameOf(b) === 'thigh.R');

    const armBoneIdx = {
      L: {
        sh: bones.findIndex(b => boneNameOf(b) === 'shoulder.L'),
        up: bones.findIndex(b => boneNameOf(b) === 'upper_arm.L'),
        fore: bones.findIndex(b => boneNameOf(b) === 'forearm.L'),
        twist: bones.findIndex(b => boneNameOf(b) === 'fore_twist.L'),
        hand: bones.findIndex(b => boneNameOf(b) === 'hand.L'),
      },
      R: {
        sh: bones.findIndex(b => boneNameOf(b) === 'shoulder.R'),
        up: bones.findIndex(b => boneNameOf(b) === 'upper_arm.R'),
        fore: bones.findIndex(b => boneNameOf(b) === 'forearm.R'),
        twist: bones.findIndex(b => boneNameOf(b) === 'fore_twist.R'),
        hand: bones.findIndex(b => boneNameOf(b) === 'hand.R'),
      },
    } as const;

    const isTrim = sm.name.startsWith('Trim');
    let compOfVert: Int32Array | null = null;
    const bodiceRoots = new Set<number>();
    const skirtRoots = new Set<number>();

    if (!isTrim && isLongSkirt && geom.index && idxHips >= 0 && idxThighL >= 0 && idxThighR >= 0) {
      const nVerts = pos.count;
      const parent = Int32Array.from({ length: nVerts }, (_, idx) => idx);
      const find = (x: number): number => {
        let cur = x;
        while (parent[cur] !== cur) {
          parent[cur] = parent[parent[cur]];
          cur = parent[cur];
        }
        return cur;
      };
      const idxArr = geom.index.array;
      for (let t = 0; t + 2 < idxArr.length; t += 3) {
        const ra = find(idxArr[t]);
        const rb = find(idxArr[t + 1]);
        const rc = find(idxArr[t + 2]);
        parent[rb] = ra;
        parent[rc] = ra;
      }
      compOfVert = new Int32Array(nVerts);
      const bounds = new Map<number, { minY: number; maxY: number }>();
      for (let i = 0; i < nVerts; i++) {
        const r = find(i);
        compOfVert[i] = r;
        const py = pos.getY(i);
        let bnd = bounds.get(r);
        if (!bnd) {
          bnd = { minY: py, maxY: py };
          bounds.set(r, bnd);
        } else {
          if (py < bnd.minY) bnd.minY = py;
          if (py > bnd.maxY) bnd.maxY = py;
        }
      }
      for (const [r, bnd] of bounds) {
        if (bnd.minY > 0.85 && bnd.maxY > 1.25) bodiceRoots.add(r);
        else if (bnd.maxY < 0.96 && bnd.minY < 0.75) skirtRoots.add(r);
      }
    }

    let yMin = Infinity;
    if (isLongSkirt) {
      for (let i = 0; i < pos.count; i++) {
        const py = pos.getY(i);
        if (py < yMin) yMin = py;
      }
    }

    const yHipPivot = 0.924;
    const skirtSpan = Math.max(0.08, yHipPivot - yMin);
    const wScratch = new Float64Array(bones.length);
    const touchedIdx = new Int32Array(12);
    let posChanged = false;
    let weightsChanged = false;

    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      const y = pos.getY(i);
      let z = pos.getZ(i);
      const absX = Math.abs(x);
      const compRoot = compOfVert ? compOfVert[i] : -1;
      const isBodiceVert = bodiceRoots.has(compRoot);
      const isSkirtVert = skirtRoots.size > 0 ? skirtRoots.has(compRoot) : !isBodiceVert;

      // Tuck the bodice's hidden lower overlap margin (`0.900..0.930 m`) smoothly inside the skirt top rim (`0.924 m`)
      if (isLongSkirt && !isTrim && isBodiceVert && y < 0.932 && absX < 0.175) {
        const sTuck = hermiteStep(0.932, 0.900, y);
        const rXZ = Math.hypot(x, z);
        if (rXZ > 1e-4) {
          const tuckMeters = 0.0075 * sTuck;
          const nextR = Math.max(0.01, rXZ - tuckMeters);
          const kTuck = nextR / rXZ;
          x *= kTuck;
          z *= kTuck;
          posChanged = true;
        }
      }

      if (isLongSkirt && idxHips >= 0 && idxThighL >= 0 && idxThighR >= 0 && y < yHipPivot && absX < 0.24) {
        // Preserve original upper-body (`spine`/`chest`) weight at `y = yHipPivot` (`s = 0`) for C1 seam lock
        let wUpperOrig = 0;
        for (let k = 0; k < 4; k++) {
          const jIdx = joints.getComponent(i, k);
          const wVal = weights.getComponent(i, k);
          if (wVal > 0 && (jIdx === idxSpine || jIdx === idxChest)) {
            wUpperOrig += wVal;
          }
        }
        const u = T.MathUtils.clamp((yHipPivot - y) / skirtSpan, 0, 1);
        const s = u * u * (3 - 2 * u);
        const wSpine = idxSpine >= 0 ? wUpperOrig * (1 - s) : 0;
        const wLeg = (1 - wSpine) * 0.92 * s;
        const wHips = Math.max(0, 1 - wSpine - wLeg);
        // +X is `.L`, -X is `.R` on Lyra/Kai; smooth midline slit zone prevents center-front/vent tearing
        const splitHalfW = 0.055 + 0.040 * s;
        const tSide = T.MathUtils.clamp((x + splitHalfW) / (2 * splitHalfW), 0, 1);
        const sideL = tSide * tSide * (3 - 2 * tSide);
        joints.setXYZW(i, idxHips, idxThighL, idxThighR, idxSpine >= 0 ? idxSpine : 0);
        weights.setXYZW(i, wHips, wLeg * sideL, wLeg * (1 - sideL), wSpine);
        weightsChanged = true;

        if (!isTrim && isSkirtVert) {
          const rXZ = Math.hypot(x, z);
          if (rXZ > 1e-4) {
            const scale = (rXZ + 0.010 * s) / rXZ;
            x *= scale;
            z *= scale;
            posChanged = true;
          }
        }
      }

      // Shoulder/deltoid/axilla + forearm/wrist-cuff skin-weight conform on `.L` (+X) and `.R` (-X)
      if (absX >= 0.085 && y >= 0.78 && y <= 1.46) {
        const sideKey = x >= 0 ? 'L' : 'R';
        const signX = x >= 0 ? 1 : -1;
        const ab = armBoneIdx[sideKey];
        if (ab.sh >= 0 && ab.up >= 0 && ab.fore >= 0 && ab.twist >= 0 && ab.hand >= 0) {
          let nTouched = 0;
          const addTouch = (idx: number) => {
            if (idx < 0) return;
            for (let t = 0; t < nTouched; t++) if (touchedIdx[t] === idx) return;
            touchedIdx[nTouched++] = idx;
          };
          for (let k = 0; k < 4; k++) {
            const jIdx = joints.getComponent(i, k);
            const wVal = weights.getComponent(i, k);
            if (wVal > 1e-6 && jIdx >= 0 && jIdx < wScratch.length) {
              addTouch(jIdx);
              wScratch[jIdx] += wVal;
            }
          }

          let wSh = wScratch[ab.sh];
          let wUp = wScratch[ab.up];
          let wFore = wScratch[ab.fore];
          let wTwist = wScratch[ab.twist];
          let wHand = wScratch[ab.hand];
          const wArmChain = wSh + wUp + wFore + wTwist + wHand;
          let vWeightEdited = false;

          if (wArmChain >= 0.25) {
            // 3a) Wave 11 layered coat deltoid & axilla conform (`|x| in [0.115, 0.275]`, `y >= 1.15`)
            if (isWave11Coat && absX >= 0.115 && absX <= 0.275 && y >= 1.15 && wSh + wUp > 0.20) {
              const uLat = hermiteStep(0.140, 0.190, absX) * hermiteStep(1.155, 1.225, y);
              if (uLat > 0) {
                for (const tIdx of [idxSpine, idxChest, idxNeck]) {
                  if (tIdx >= 0 && wScratch[tIdx] > 0) {
                    const move = wScratch[tIdx] * uLat;
                    wScratch[tIdx] -= move;
                    wSh += move * 0.35;
                    wUp += move * 0.65;
                    vWeightEdited = true;
                  }
                }
              }
              const pair = wSh + wUp;
              if (pair > 1e-4) {
                const minUpperShare = hermiteStep(0.100, 0.225, absX) * hermiteStep(1.145, 1.215, y);
                if (wUp < pair * minUpperShare) {
                  wUp = pair * minUpperShare;
                  wSh = pair - wUp;
                  vWeightEdited = true;
                }
              }
            }

            // 3b) Forearm shaft & wrist-cuff conform along bind elbow `(±0.3182, 1.1394, -0.0189)` -> wrist `(±0.4522, 0.9842, -0.0055)`
            const ex = signX * 0.3182, ey = 1.1394, ez = -0.0189;
            const fdx = signX * 0.1340, fdy = -0.1552, fdz = 0.0134;
            const fLenSq = fdx * fdx + fdy * fdy + fdz * fdz;
            const sFore = ((x - ex) * fdx + (y - ey) * fdy + (z - ez) * fdz) / fLenSq;
            if (sFore > 0.14 && wUp + wFore + wTwist + wHand > 0.65) {
              if (wUp > 0 && sFore > 0.16) {
                const dropUp = wUp * hermiteStep(0.16, 0.40, sFore);
                wUp -= dropUp;
                wFore += dropUp;
                vWeightEdited = true;
              }
              if (wHand > 0 && sFore < 1.18) {
                const maxHand = 0.075 * hermiteStep(0.76, 1.05, sFore);
                if (wHand > maxHand) {
                  wTwist += wHand - maxHand;
                  wHand = maxHand;
                  vWeightEdited = true;
                }
              }
              const forePair = wFore + wTwist;
              if (forePair > 1e-4) {
                const minTwistShare = 0.96 * hermiteStep(0.12, 0.80, sFore);
                if (wTwist < forePair * minTwistShare) {
                  wTwist = forePair * minTwistShare;
                  wFore = forePair - wTwist;
                  vWeightEdited = true;
                }
              }
            }
          }

          if (vWeightEdited) {
            addTouch(ab.sh);
            addTouch(ab.up);
            addTouch(ab.fore);
            addTouch(ab.twist);
            addTouch(ab.hand);
            wScratch[ab.sh] = wSh;
            wScratch[ab.up] = wUp;
            wScratch[ab.fore] = wFore;
            wScratch[ab.twist] = wTwist;
            wScratch[ab.hand] = wHand;

            // Select top-4 influences and normalize sum strictly to 1.000000
            let b0 = 0, b1 = 0, b2 = 0, b3 = 0;
            let v0 = 0, v1 = 0, v2 = 0, v3 = 0;
            for (let t = 0; t < nTouched; t++) {
              const idx = touchedIdx[t];
              const w = wScratch[idx];
              if (w <= 1e-5) continue;
              if (w > v0) { b3 = b2; v3 = v2; b2 = b1; v2 = v1; b1 = b0; v1 = v0; b0 = idx; v0 = w; }
              else if (w > v1) { b3 = b2; v3 = v2; b2 = b1; v2 = v1; b1 = idx; v1 = w; }
              else if (w > v2) { b3 = b2; v3 = v2; b2 = idx; v2 = w; }
              else if (w > v3) { b3 = idx; v3 = w; }
            }
            const sum = v0 + v1 + v2 + v3;
            if (sum > 1e-6) {
              const inv = 1 / sum;
              joints.setXYZW(i, b0, b1, b2, b3);
              weights.setXYZW(i, v0 * inv, v1 * inv, v2 * inv, v3 * inv);
              weightsChanged = true;
            }
          }

          for (let t = 0; t < nTouched; t++) wScratch[touchedIdx[t]] = 0;
        }
      }

      if (slot === 'outerwear' && itemId === 'wool_overcoat' && !isTrim && absX > 0.175 && y > 0.82 && y < 1.38) {
        const signX = x >= 0 ? 1 : -1;
        const tArm = T.MathUtils.clamp((absX - 0.175) / 0.275, 0, 1);
        const armY = 1.318 - 0.315 * tArm;
        const armZ = -0.012 + 0.022 * tArm;
        const dy = y - armY;
        const dz = z - armZ;
        const rTube = Math.hypot(dy, dz);
        if (rTube > 0.030 && rTube < 0.110) {
          const trimMeters = T.MathUtils.lerp(0.007, 0.0135, tArm);
          const nextR = Math.max(0.032, rTube - trimMeters);
          const kR = nextR / rTube;
          pos.setXYZ(i, signX * absX, armY + dy * kR, armZ + dz * kR);
          posChanged = true;
          continue;
        }
      }

      if (!isTrim && isLongSkirt) pos.setXYZ(i, x, y, z);
    }

    if (posChanged) {
      pos.needsUpdate = true;
      if (!isTrim) computeComponentWeldedNormals(geom, compOfVert);
    }
    if (weightsChanged) {
      joints.needsUpdate = true;
      weights.needsUpdate = true;
    }
  });
}

/** Creates a lightweight geometry instance sharing all vertex BufferAttributes while owning an independent `.index`. */
function cloneGeometryWithSharedAttributes(source: T.BufferGeometry): T.BufferGeometry {
  const g = new T.BufferGeometry();
  for (const [name, attr] of Object.entries(source.attributes)) {
    g.setAttribute(name, attr);
  }
  if (source.morphAttributes) {
    for (const [name, list] of Object.entries(source.morphAttributes)) {
      const morphKey = name as 'position' | 'normal' | 'color';
      if (list) g.morphAttributes[morphKey] = list.slice();
    }
    g.morphTargetsRelative = source.morphTargetsRelative;
  }
  if (source.index) g.setIndex(source.index);
  if (source.boundingBox) g.boundingBox = source.boundingBox.clone();
  if (source.boundingSphere) g.boundingSphere = source.boundingSphere.clone();
  g.userData.__ecSourceGeom = source;
  return g;
}

function getBaseIndexArray(sourceGeom: T.BufferGeometry): Uint16Array | Uint32Array {
  let cached = sourceGeom.userData.__ecBaseIndexArr as Uint16Array | Uint32Array | undefined;
  if (!cached) {
    const idx = sourceGeom.index;
    if (idx) {
      cached =
        idx.array instanceof Uint32Array
          ? new Uint32Array(idx.array)
          : new Uint16Array(idx.array);
    } else {
      const count = sourceGeom.getAttribute('position')?.count ?? 0;
      cached = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
      for (let i = 0; i < count; i++) cached[i] = i;
    }
    sourceGeom.userData.__ecBaseIndexArr = cached;
  }
  return cached;
}

type OuterMaskMode =
  | 'none'
  | 'wool_overcoat'
  | 'trench_coat'
  | 'puffer_parka'
  | 'cardigan'
  | 'jacket'
  | 'hoodie';

function getOuterMaskedIndex(
  sourceGeom: T.BufferGeometry,
  slot: ExtendedSlot,
  mode: OuterMaskMode,
): T.BufferAttribute {
  let cache = sourceGeom.userData.__ecOuterMaskCache as Map<string, T.BufferAttribute> | undefined;
  if (!cache) {
    cache = new Map<string, T.BufferAttribute>();
    sourceGeom.userData.__ecOuterMaskCache = cache;
  }
  const key = `${slot}:${mode}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const baseArr = getBaseIndexArray(sourceGeom);
  if (mode === 'none') {
    const full = new T.BufferAttribute(baseArr, 1);
    cache.set(key, full);
    return full;
  }

  const pos = sourceGeom.getAttribute('position') as T.BufferAttribute;
  const kept: number[] = [];
  for (let i = 0; i < baseArr.length; i += 3) {
    const a = baseArr[i], b = baseArr[i + 1], c = baseArr[i + 2];
    const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
    const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const absX = Math.abs(cx);
    let hide = false;

    if (slot === 'bottom') {
      // Mask high waistbands & hip pleats covered under closed coats
      if (mode !== 'cardigan' && mode !== 'jacket' && mode !== 'hoodie' && cy > 0.855) hide = true;
    } else if (slot === 'top' || slot === 'dress') {
      if (mode === 'cardigan') {
        // Open-front cardigan: hide sleeves and back torso while keeping full front shirt chest visible
        if ((absX >= 0.155 && cy >= 0.845) || (cy >= 0.835 && cy <= 1.380 && cz < -0.015)) {
          hide = true;
        }
      } else if (mode === 'jacket' || mode === 'hoodie') {
        // Layered jacket/hoodie outerwear: mask covered inner sleeves, back, and lateral chest/shoulders
        const inNeckCollar = absX < 0.072 && cy >= 1.335 && cy <= 1.440 && cz > -0.055;
        if (!inNeckCollar) {
          if (absX >= 0.140 && cy >= 0.840) hide = true;
          else if (mode === 'hoodie' && cy >= 0.900 && cy <= 1.415) hide = true;
          else if (mode === 'jacket' && cy >= 0.900 && cy <= 1.415 && (cz < 0.012 || absX >= 0.075)) hide = true;
        }
      } else {
        // Closed heavy coats (`wool_overcoat`, `trench_coat`, `puffer_parka`, front centerline closed up to y = 1.375 m):
        // Mask covered chest, back, shoulder, and sleeve triangles while preserving the upper crew-neck collar rim!
        const inCollarWindow = absX < 0.068 && cy >= 1.352 && cy <= 1.445 && cz > -0.055;
        const hemCutY = mode === 'trench_coat' ? 0.585 : mode === 'wool_overcoat' ? 0.665 : 0.820;
        if (!inCollarWindow) {
          if (absX >= 0.135 && cy >= 0.825) hide = true;
          else if (cy >= hemCutY && cy <= 1.425) hide = true;
        }
      }
    }

    if (!hide) kept.push(a, b, c);
  }

  const ArrCtor = baseArr instanceof Uint32Array ? Uint32Array : Uint16Array;
  const attr = new T.BufferAttribute(new ArrCtor(kept), 1);
  cache.set(key, attr);
  return attr;
}

function getHeadwearMaskedHairIndex(
  sourceGeom: T.BufferGeometry,
  bones: T.Bone[],
  headwear: 'none' | 'beanie' | 'cap',
): T.BufferAttribute {
  let cache = sourceGeom.userData.__ecHairMaskCache as Map<string, T.BufferAttribute> | undefined;
  if (!cache) {
    cache = new Map<string, T.BufferAttribute>();
    sourceGeom.userData.__ecHairMaskCache = cache;
  }
  const hit = cache.get(headwear);
  if (hit) return hit;

  const baseArr = getBaseIndexArray(sourceGeom);
  if (headwear === 'none') {
    const full = new T.BufferAttribute(baseArr, 1);
    cache.set(headwear, full);
    return full;
  }

  const pos = sourceGeom.getAttribute('position') as T.BufferAttribute;
  const skinIdx = sourceGeom.getAttribute('skinIndex') as T.BufferAttribute | undefined;
  const skinW = sourceGeom.getAttribute('skinWeight') as T.BufferAttribute | undefined;
  const isPonyJoint = bones.map(b => /^pony[._]?\d+/i.test((b.userData.name as string | undefined) ?? b.name));

  const maxPonyWeightOf = (v: number): number => {
    if (!skinIdx || !skinW) return 0;
    let mw = 0;
    for (let k = 0; k < 4; k++) {
      const j = skinIdx.getComponent(v, k);
      const w = skinW.getComponent(v, k);
      if (isPonyJoint[j] && w > mw) mw = w;
    }
    return mw;
  };

  const kept: number[] = [];
  const rimBase = headwear === 'beanie' ? 1.520 : 1.548;
  for (let i = 0; i < baseArr.length; i += 3) {
    const a = baseArr[i], b = baseArr[i + 1], c = baseArr[i + 2];
    const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
    const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const ponyW = Math.max(maxPonyWeightOf(a), maxPonyWeightOf(b), maxPonyWeightOf(c));
    const yRim = rimBase + 0.044 * T.MathUtils.clamp((cz + 0.135) / 0.275, 0, 1);
    let hide = false;

    if (ponyW < 0.25) {
      // Non-ponytail skull cap & wide curl puffs (`hair_textured_curl` ±0.153m vs beanie ±0.118m)
      const radialNorm = (cx * cx) / (0.106 * 0.106) + ((cz - 0.005) * (cz - 0.005)) / (0.126 * 0.126);
      if (cy > yRim || (cy > 1.495 && radialNorm > 1.0)) {
        hide = true;
      }
    } else if (headwear === 'beanie') {
      // High ponytail (`pony.1..3`): hide only the top elastic tie cap while keeping the full flowing tail
      // (which `SecondaryPhysics.setWearableContext` tucks cleanly beneath the back beanie cuff at y≈1.509m!)
      if (cy > 1.575 && cz > -0.150) {
        hide = true;
      }
    }

    if (!hide) kept.push(a, b, c);
  }

  const ArrCtor = baseArr instanceof Uint32Array ? Uint32Array : Uint16Array;
  const attr = new T.BufferAttribute(new ArrCtor(kept), 1);
  cache.set(headwear, attr);
  return attr;
}

export class Wardrobe {
  private bones = new Map<string, T.Bone>();
  private refBoneInverses = new Map<string, T.Matrix4>();
  private nativeHairBoneRest = new Map<string, HairBoneRestOverride>();
  private signature: T.Mesh[] = [];
  private signatureScarf: T.Mesh[] = [];
  private builtinHair: T.Mesh[] = [];
  private worn = new Map<string, Worn>();
  private externalHairRoot: T.Group | null = null;
  private epoch = 0;
  private disposed = false;
  private ownView = false;
  private backpackHidden = false;
  private quality: CharacterQuality = 'high';
  private skinHex: string;
  private hairColorHex: string;
  private hairTipHex = '#ffffff';
  private hairTipMix = 0;
  /** What is on the body right now: the same record the caller asked for, once it really is on. */
  applied: AvatarLook | null = null;
  /** Head-worn things leave the owner's own view; their shadow stays. */
  private headMaterials: T.Material[] = [];

  constructor(
    private model: T.Object3D,
    private hero: Hero,
    quality: CharacterQuality = 'high',
    private attachWorldShaders = false,
  ) {
    this.quality = quality;
    this.skinHex = SKIN_TONE[hero];
    this.hairColorHex = hero === 'LYRA' ? '#40303f' : '#3a2a22';
    model.traverse(o => {
      if ((o as T.Bone).isBone) {
        const b = o as T.Bone;
        b.scale.set(1, 1, 1);
        const bName = (b.userData.name as string | undefined) ?? b.name;
        this.bones.set(bName, b);
        if (HAIR_CHAIN_BONE_SET.has(bName) && !this.nativeHairBoneRest.has(bName)) {
          this.nativeHairBoneRest.set(bName, {
            position: b.position.clone(),
            quaternion: b.quaternion.clone(),
          });
        }
      } else if ((o as T.Mesh).isMesh) {
        const mesh = o as T.Mesh;
        if (/^(Runner_Body|Cast_Scarf)/.test(mesh.name)) this.signature.push(mesh);
        if (/^Cast_Scarf/.test(mesh.name)) this.signatureScarf.push(mesh);
        if (/^Cast_Hair/.test(mesh.name)) this.builtinHair.push(mesh);
        const sm = mesh as T.SkinnedMesh;
        if (sm.isSkinnedMesh && sm.skeleton && this.refBoneInverses.size === 0 && sm.skeleton.bones.length >= 60) {
          for (let i = 0; i < sm.skeleton.bones.length; i++) {
            const b = sm.skeleton.bones[i];
            const bName = (b.userData.name as string | undefined) ?? b.name;
            if (sm.skeleton.boneInverses[i]) {
              this.refBoneInverses.set(bName, sm.skeleton.boneInverses[i].clone());
            }
          }
        }
      }
    });
  }

  /** Dresses the body with either a legacy `AvatarLook` or full Wave 11 creator options (modular hair, outerwear, fabrics, patterns, skin tone). */
  async apply(look: AvatarLook, options?: WardrobeApplyOptions): Promise<boolean> {
    const at = ++this.epoch;
    if (options?.quality) this.quality = options.quality;
    if (options?.attachWorldShaders !== undefined) this.attachWorldShaders = options.attachWorldShaders;
    if (options?.skinHex) this.skinHex = options.skinHex;
    this.hairColorHex = options?.hairColor ?? look.colors.hair ?? this.hairColorHex;
    if (options?.hairTipColor) this.hairTipHex = options.hairTipColor;
    if (options?.hairTipMix !== undefined) this.hairTipMix = options.hairTipMix;

    const outfit = options?.outfit;
    const outerId = options?.outerwear ?? outfit?.outerwear ?? look.outerwear ?? 'none';
    const hasHeavyOuter = hasLayeredCoat({ outerwear: outerId });
    const hasScarfOuter = outerId === 'winter_scarf';

    // Defensive decomposition: if a layered coat is equipped over `signature`, decompose into modular garments
    // so `Runner_Body` straps, chest brooch, belt buckle, and calf-high adventure boots NEVER bleed through!
    const effectiveLook: AvatarLook =
      hasHeavyOuter && look.top === SIGNATURE
        ? normalizeLook(this.hero, {
            ...look,
            outerwear: outerId,
          })
        : hasHeavyOuter && !look.outerwear
          ? { ...look, outerwear: outerId }
          : look;

    const need: ExtendedWardrobeItem[] = [];
    const baseLookFiles = lookFiles(this.hero, effectiveLook);
    for (const item of baseLookFiles) {
      const slotFabric =
        item.slot === 'top' || item.slot === 'dress'
          ? outfit?.fabrics.top ?? item.fabric
          : item.slot === 'bottom'
            ? outfit?.fabrics.bottom ?? item.fabric
            : item.slot === 'shoes'
              ? outfit?.fabrics.shoes ?? item.fabric
              : item.fabric;
      const slotPattern: PatternId | undefined =
        item.slot === 'top' || item.slot === 'dress'
          ? outfit?.patterns.top
          : item.slot === 'bottom'
            ? outfit?.patterns.bottom
            : item.slot === 'shoes'
              ? outfit?.patterns.shoes
              : undefined;
      need.push({ ...item, fabric: slotFabric, pattern: slotPattern });
    }

    // Wave 11 accessories (`sunglasses`, `beanie`, `backpack`) alongside legacy (`glasses`, `headphones`, `cap`)
    const allAccIds = outfit?.accessories ?? effectiveLook.accessories;
    for (const accId of allAccIds) {
      if (need.some(n => n.id === accId)) continue;
      const w11Url = (WAVE11_ACCESSORY_URLS as Record<string, string>)[accId];
      if (w11Url) {
        need.push({
          id: accId,
          slot: 'accessory',
          url: w11Url,
          fabric: accId === 'beanie' ? 'knit' : accId === 'backpack' ? 'canvas' : null,
          covers: {},
        });
      }
    }

    // Layered Wave 11 or legacy outerwear on top of base `top`
    if (outerId && outerId !== 'none' && outerId !== effectiveLook.top) {
      const w11OuterUrl = (WAVE11_OUTERWEAR_URLS[this.hero] as Record<string, string>)[outerId];
      const legacyOuter = WARDROBE[this.hero].items[outerId];
      const outerUrl = w11OuterUrl ?? legacyOuter?.url;
      if (outerUrl) {
        need.push({
          id: `outer:${outerId}`,
          slot: 'outerwear',
          url: outerUrl,
          fabric: outfit?.fabrics.outerwear ?? OUTERWEAR_DEFAULT_FABRIC[outerId] ?? legacyOuter?.fabric ?? 'wool',
          covers: OUTERWEAR_COVERS[outerId] ?? legacyOuter?.covers ?? {},
          pattern: outfit?.patterns.outerwear,
        });
      }
    }

    // Modular 3D hairstyle swap (`Wear_hair`)
    const hairId = options?.hairId ?? null;
    const hairUrl = hairId ? (WAVE11_HAIR_URLS as Record<string, string>)[hairId] : undefined;
    if (hairId && hairUrl) {
      need.push({
        id: `hair:${hairId}`,
        slot: 'hair',
        url: hairUrl,
        fabric: null,
        covers: {},
      });
    }

    const pendingFabricTextures: Promise<T.Texture>[] = [];
    for (const item of need) {
      if (item.slot === 'hair' || item.slot === 'skin') continue;
      const kind = item.fabric ?? 'cotton';
      const extra = EXTRA_FABRIC_PARAMS[kind];
      const f = FABRICS[extra ? extra.baseKey : kind] ?? FABRICS.cotton;
      tile(f.map, true);
      const mapP = texturePromises.get(f.map);
      if (mapP) pendingFabricTextures.push(mapP);
      if (this.quality !== 'low') {
        tile(f.normal, false);
        const normP = texturePromises.get(f.normal);
        if (normP) pendingFabricTextures.push(normP);
      }
    }

    let loaded: GLTF[];
    try {
      [loaded] = await Promise.all([
        Promise.all(need.map(i => loadFile(i.url))),
        Promise.all(pendingFabricTextures),
      ]);
    } catch {
      return false;
    }
    if (at !== this.epoch || this.disposed) return false;

    const wanted = new Set(need.map(i => i.id));
    for (const [id, w] of this.worn) {
      const nextItem = need.find(n => n.id === id);
      if (!wanted.has(id) || (nextItem && nextItem.fabric !== w.item.fabric)) {
        this.remove(id, w);
      }
    }
    for (const b of this.bones.values()) b.scale.set(1, 1, 1);
    need.forEach((item, i) => {
      refineGarmentRiggingAndConform(loaded[i].scene, item.slot, item.slot === 'outerwear' ? outerId : item.id);
      if (!this.worn.has(item.id)) this.wear(item, loaded[i]);
      else this.worn.get(item.id)!.item = item;
    });

    const plain = isSignature(effectiveLook) && !hasHeavyOuter;
    for (const mesh of this.signature) {
      if (this.signatureScarf.includes(mesh)) {
        mesh.visible = plain && !hasHeavyOuter && !hasScarfOuter;
      } else {
        mesh.visible = plain;
      }
    }

    const hairWornKey = hairId ? `hair:${hairId}` : null;
    const hairWorn = hairWornKey ? this.worn.get(hairWornKey) : undefined;
    const usingModularHair = !!(hairId && hairUrl && hairWorn);
    for (const m of this.builtinHair) m.visible = !usingModularHair;
    this.syncHairChainRestBones(usingModularHair ? (hairWorn?.hairRestOverrides ?? null) : null);
    options?.onBuiltinHairVisible?.(!usingModularHair);
    options?.onExternalHair?.(usingModularHair ? this.externalHairRoot : null);

    const headwearKind: 'none' | 'beanie' | 'cap' = allAccIds.includes('beanie')
      ? 'beanie'
      : allAccIds.includes('cap')
        ? 'cap'
        : 'none';

    this.paint(effectiveLook, outfit);
    if (!plain) this.hideSkin(effectiveLook);
    this.applyOuterwearLayerMask(outerId);
    this.applyHeadwearHairMask(headwearKind);
    this.setSkinTone(this.skinHex);
    this.setBackpackHiddenForSeat(this.backpackHidden);
    this.showHead(!this.ownView);

    const wearableCtx: SecondaryWearableContext = {
      headwear: headwearKind,
      outerwear: outerId,
      hasBackpack: allAccIds.includes('backpack'),
      hasScarfAccessory: hasScarfOuter,
    };
    this.model.userData.__ecWearableContext = wearableCtx;
    const sec = this.model.userData.__ecSecondaryPhysics as SecondaryPhysics | undefined;
    sec?.setWearableContext(wearableCtx);
    sec?.settleImmediate(8, 1 / 60);
    options?.onWearableContext?.(wearableCtx);

    this.applied = effectiveLook;
    return true;
  }

  /** High-level Character Creator V2 dresser applying modular hair, layered outerwear, fabrics, patterns, and skin tone. */
  async applyProfile(
    profile: CharacterCreatorProfile,
    outfitOverride?: OutfitSlotConfig,
    options?: Omit<WardrobeApplyOptions, 'hairId' | 'hairColor' | 'hairTipColor' | 'hairTipMix' | 'skinHex' | 'outerwear' | 'outfit'>,
  ): Promise<boolean> {
    const outfit = outfitOverride ?? profile.outfits[profile.activeOutfitSlot] ?? profile.outfits.everyday;
    const legacyLook: AvatarLook = {
      top: outfit.top,
      bottom: outfit.bottom,
      shoes: outfit.shoes,
      accessories: outfit.accessories.filter(a => Boolean(WARDROBE[this.hero].items[a])),
      colors: {
        top: outfit.colors.top,
        bottom: outfit.colors.bottom,
        shoes: outfit.colors.shoes,
        hair: profile.hairColor,
        accessory: outfit.colors.accessory,
      },
    };
    return this.apply(legacyLook, {
      ...options,
      hairId: profile.hairId,
      hairColor: profile.hairColor,
      hairTipColor: profile.hairTipColor,
      hairTipMix: profile.hairTipMix,
      skinHex: profile.skinHex,
      outerwear: outfit.outerwear,
      outfit,
    });
  }

  /**
   * Syncs `pony.1..3`, `side.L/R`, and `fringe` rest transforms to the equipped modular `hair_*` GLB
   * (or restores native cast bind poses when reverting to built-in hair) so `KAI` XPBD hair chains use
   * exact authored segment lengths and pivots with zero LBS shear.
   */
  private syncHairChainRestBones(overrides: ReadonlyMap<string, HairBoneRestOverride> | null) {
    const source = overrides ?? this.nativeHairBoneRest;
    for (const [bName, rest] of source) {
      const targetBone = this.bones.get(bName);
      if (targetBone) {
        targetBone.position.copy(rest.position);
        targetBone.quaternion.copy(rest.quaternion);
      }
    }
    const activeOverrides = overrides && overrides.size > 0 ? overrides : null;
    this.model.userData.__ecHairRigOverrides = activeOverrides ?? undefined;
    const sec = this.model.userData.__ecSecondaryPhysics as SecondaryPhysics | undefined;
    sec?.setHairRigOverrides(activeOverrides);
  }

  /**
   * Computes `shared_hair_on_kai`-safe inverse bind matrices: once `KAI`'s child hair-chain bones
   * (`pony.1..3`, `side.L/R`, `fringe`) are synced to the `hair_*` GLB's local rest pose under `head`,
   * `sourceInverses[idx]` maps directly through `targetHead * inv(sourceHead)` with 0.000 mm pivot error.
   */
  private buildHairBoneInverses(sourceBones: T.Bone[], sourceInverses: T.Matrix4[]): T.Matrix4[] {
    if (this.hero !== 'KAI' || this.refBoneInverses.size === 0) {
      return sourceInverses.map(m => m.clone());
    }
    const targetHeadInv = this.refBoneInverses.get('head');
    const srcHeadIdx = sourceBones.findIndex(b => ((b.userData.name as string | undefined) ?? b.name) === 'head');
    if (!targetHeadInv || srcHeadIdx < 0 || !sourceInverses[srcHeadIdx]) {
      return sourceInverses.map(m => m.clone());
    }
    const targetHeadRest = targetHeadInv.clone().invert();
    const scalpAlign = targetHeadRest.multiply(sourceInverses[srcHeadIdx]);
    return sourceBones.map((b, idx) => {
      const bName = (b.userData.name as string | undefined) ?? b.name;
      if (bName === 'head' || HAIR_CHAIN_BONE_SET.has(bName)) {
        return sourceInverses[idx].clone();
      }
      const refInv = this.refBoneInverses.get(bName);
      if (!refInv) return sourceInverses[idx].clone();
      return refInv.clone().multiply(scalpAlign);
    });
  }

  private wear(item: ExtendedWardrobeItem, gltf: GLTF) {
    const meshes: T.SkinnedMesh[] = [], materials: T.Material[] = [], own: T.BufferGeometry[] = [];
    const isHair = item.slot === 'hair';
    const isHeadAcc = item.slot === 'accessory' && HEAD_ACCESSORIES.has(item.id);
    const isBackpack = item.slot === 'accessory' && item.id === 'backpack';
    const isFirstPersonOccluded = isHeadAcc || isHair || isBackpack || item.id === 'outer:winter_scarf';
    const useWorldShaders = this.attachWorldShaders || Boolean(this.model.userData.__ecSecondaryPhysics);
    let hairGroup: T.Group | null = null;
    let hairRestOverrides: Map<string, HairBoneRestOverride> | undefined;
    if (isHair) {
      if (this.externalHairRoot) this.externalHairRoot.removeFromParent();
      hairGroup = new T.Group();
      hairGroup.name = `ExternalHair_${item.id}`;
      this.model.add(hairGroup);
      this.externalHairRoot = hairGroup;
      hairRestOverrides = new Map<string, HairBoneRestOverride>();
    }

    gltf.scene.traverse(o => {
      const source = o as T.SkinnedMesh;
      if (!source.isSkinnedMesh) return;
      const bones = source.skeleton.bones.map(b => this.bones.get((b.userData.name as string | undefined) ?? b.name) ?? null);
      if (bones.some(b => !b)) return;
      if (isHair && hairRestOverrides && hairRestOverrides.size === 0) {
        for (const sb of source.skeleton.bones) {
          const sbName = (sb.userData.name as string | undefined) ?? sb.name;
          if (HAIR_CHAIN_BONE_SET.has(sbName)) {
            hairRestOverrides.set(sbName, {
              position: sb.position.clone(),
              quaternion: sb.quaternion.clone(),
            });
            const targetBone = this.bones.get(sbName);
            if (targetBone) {
              targetBone.position.copy(sb.position);
              targetBone.quaternion.copy(sb.quaternion);
            }
          }
        }
      }
      const boneInverses = isHair
        ? this.buildHairBoneInverses(source.skeleton.bones, source.skeleton.boneInverses)
        : source.skeleton.boneInverses.map(m => m.clone());
      for (const tb of bones) if (tb) tb.scale.set(1, 1, 1);
      const skeleton = new T.Skeleton(bones as T.Bone[], boneInverses);
      const trim = source.name.startsWith('Trim');
      let geometry = source.geometry;
      if (item.slot === 'skin' && !trim) {
        geometry = source.geometry.clone();
        geometry.userData.__ecSourceGeom = source.geometry;
        own.push(geometry);
      } else if (
        !trim &&
        (isHair || item.slot === 'top' || item.slot === 'dress' || item.slot === 'bottom')
      ) {
        if (isHair && !source.geometry.getAttribute('tangent') && source.geometry.getAttribute('uv') && source.geometry.index) {
          try { source.geometry.computeTangents(); } catch { /* ignore */ }
        }
        geometry = cloneGeometryWithSharedAttributes(source.geometry);
        own.push(geometry);
      }
      const srcMat = Array.isArray(source.material) ? source.material[0] : source.material;
      let material: T.Material;
      if (isHair) {
        material = hairMaterial(
          srcMat instanceof T.MeshStandardMaterial ? srcMat : null,
          this.hairColorHex,
          this.quality,
          useWorldShaders,
        );
        setHairTipUniform(material, this.hairTipHex, this.hairTipMix);
      } else if (trim) {
        const trimDepthOffset =
          item.slot === 'skin'
            ? { polygonOffset: false }
            : item.slot === 'outerwear' || item.slot === 'accessory'
              ? { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }
              : { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 };
        material = new T.MeshStandardMaterial({
          name: 'Trim',
          vertexColors: true,
          roughness: item.id === 'sunglasses' ? 0.14 : 0.55,
          metalness: item.id === 'sunglasses' ? 0.35 : 0.05,
          envMapIntensity: item.id === 'sunglasses' ? 1.1 : 0.6,
          ...trimDepthOffset,
        });
        if (useWorldShaders) attachEchoWorldCharacterShaders(material);
      } else if (item.slot === 'skin') {
        const baseSkin = new T.MeshStandardMaterial({ color: this.skinHex, vertexColors: true, roughness: 0.60 });
        material = createCharacterSkinMaterial(baseSkin, {
          face: false,
          quality: this.quality,
          vertexColors: true,
          attachWorldShaders: useWorldShaders,
        });
        baseSkin.dispose();
        setSkinToneUniform(material, this.skinHex);
      } else {
        material = fabricMaterial(item.fabric ?? 'cotton', '#ffffff', this.quality, useWorldShaders);
        if (item.slot === 'accessory') {
          material.polygonOffset = true;
          material.polygonOffsetFactor = -2;
          material.polygonOffsetUnits = -4;
        } else if (item.slot === 'outerwear') {
          material.polygonOffset = true;
          material.polygonOffsetFactor = -1.5;
          material.polygonOffsetUnits = -3;
        } else if (item.slot === 'bottom') {
          material.polygonOffset = true;
          material.polygonOffsetFactor = -0.5;
          material.polygonOffsetUnits = -1;
        } else if (item.slot === 'top' || item.slot === 'dress') {
          material.polygonOffset = false;
        }
      }
      const mesh = new T.SkinnedMesh(geometry, material);
      mesh.name = source.name;
      mesh.bindMode = source.bindMode;
      mesh.bind(skeleton, source.bindMatrix);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (hairGroup) hairGroup.add(mesh);
      else this.model.add(mesh);
      meshes.push(mesh);
      materials.push(material);
      if (isFirstPersonOccluded) this.headMaterials.push(material);
    });
    this.worn.set(item.id, { item, meshes, materials, own, isBackpack, hairRestOverrides });
    if (this.ownView) this.showHead(false);
  }

  private remove(id: string, w: Worn) {
    for (const m of w.meshes) { m.removeFromParent(); m.skeleton.dispose(); }
    for (const m of w.materials) { this.headMaterials = this.headMaterials.filter(x => x !== m); m.dispose(); }
    w.own.forEach(g => g.dispose());
    if (w.item.slot === 'hair' && this.externalHairRoot) {
      this.externalHairRoot.removeFromParent();
      this.externalHairRoot = null;
    }
    this.worn.delete(id);
  }

  private paint(look: AvatarLook, outfit?: OutfitSlotConfig) {
    for (const w of this.worn.values()) {
      if (w.item.slot === 'hair') {
        for (const m of w.materials) {
          if (m instanceof T.MeshStandardMaterial) m.color.set(this.hairColorHex);
          setHairTipUniform(m, this.hairTipHex, this.hairTipMix);
        }
        continue;
      }
      const c =
        w.item.slot === 'outerwear'
          ? outfit?.colors.outerwear ?? look.colors.top
          : w.item.slot === 'top' || w.item.slot === 'dress'
            ? outfit?.colors.top ?? look.colors.top
            : w.item.slot === 'bottom'
              ? outfit?.colors.bottom ?? look.colors.bottom
              : w.item.slot === 'shoes'
                ? outfit?.colors.shoes ?? look.colors.shoes
                : w.item.slot === 'accessory'
                  ? outfit?.colors.accessory ?? look.colors.accessory
                  : null;
      if (!c) continue;
      for (const m of w.materials) {
        if (m.name.startsWith('Fabric') && m instanceof T.MeshStandardMaterial) {
          m.color.set(c);
          if (m instanceof T.MeshPhysicalMaterial) {
            m.sheenColor?.set(c).lerp(new T.Color('#ffffff'), 0.35);
          }
          if (w.item.pattern) {
            setClothPatternUniform(m, w.item.pattern);
          }
        } else if (w.item.slot === 'accessory' && m.name === 'Trim' && m instanceof T.MeshStandardMaterial) {
          m.color.set(c).lerp(new T.Color('#ffffff'), 0.35);
        }
      }
    }
  }

  /** Updates `Wear_skin` tone live when the skin slider changes (zero geometry reload). */
  setSkinTone(hex: string) {
    this.skinHex = hex;
    const skin = this.worn.get('skin');
    if (!skin) return;
    for (const m of skin.materials) {
      if (m.name !== 'Trim') setSkinToneUniform(m, hex);
    }
  }

  /** Updates modular hair root and ombre tip colors live (zero GLB reload). */
  setHairColors(baseHex: string, tipHex: string, tipMix: number) {
    this.hairColorHex = baseHex;
    this.hairTipHex = tipHex;
    this.hairTipMix = tipMix;
    for (const w of this.worn.values()) {
      if (w.item.slot !== 'hair') continue;
      for (const m of w.materials) {
        if (m instanceof T.MeshStandardMaterial) {
          m.color.set(baseHex);
          if (m instanceof T.MeshPhysicalMaterial) {
            m.specularColor.copy(m.color).multiplyScalar(0.55).lerp(new T.Color('#5a4030'), 0.35);
            m.sheenColor.copy(m.color).lerp(new T.Color('#6b4d3b'), 0.28);
          }
        }
        setHairTipUniform(m, tipHex, tipMix);
      }
    }
  }

  /** Hides any worn backpack mesh while seated on benches so zero straps/packs intersect backrests (Bug #07). */
  setBackpackHiddenForSeat(hidden: boolean) {
    this.backpackHidden = hidden;
    for (const w of this.worn.values()) {
      if (w.isBackpack) {
        for (const m of w.meshes) m.visible = !hidden;
      }
    }
  }

  /** Skin nobody can see never gets drawn. The hem of a garment overlaps what is left, so no gap opens in a pose. */
  private hideSkin(look: AvatarLook) {
    const skin = this.worn.get('skin');
    const mesh = skin?.meshes.find(m => m.name.startsWith('Wear'));
    if (!mesh) return;
    const trunk: [number, number][] = [], leg: [number, number][] = [[-1, .1]];
    let arm = 0;
    const coverIds = [look.top, look.bottom, look.shoes];
    for (const id of this.worn.keys()) {
      if (id.startsWith('outer:')) coverIds.push(id);
    }
    for (const id of coverIds) {
      if (id === SIGNATURE) continue;
      const covers: Covers | undefined = this.worn.get(id)?.item.covers;
      if (!covers) continue;
      if (covers.torso) trunk.push(covers.torso);
      if (covers.leg) leg.push(covers.leg);
      if (covers.arm) arm = Math.max(arm, covers.arm);
    }
    const uv = mesh.geometry.getAttribute('uv'), base = (mesh.geometry.index ?? null) as T.BufferAttribute | null;
    const source = this.skinIndex ??= base ? Array.from(base.array) : Array.from({ length: uv.count }, (_, i) => i);
    const covered = (i: number) => {
      // glTF flips V: what build_wardrobe.py wrote as v arrives as 1 - v.
      const u = uv.getX(i), v = 1 - uv.getY(i);
      if (u < .4) return v < arm;
      if (u < .6) return leg.some(([a, b]) => v > a && v < b);
      const z = v * 2;
      return trunk.some(([a, b]) => z > a && z < b);
    };
    // Under a long sleeve the wrist band has nothing to do.
    for (const m of skin!.meshes) if (m.name.startsWith('Trim')) m.visible = arm < .85;
    const kept: number[] = [];
    for (let i = 0; i < source.length; i += 3) if (!(covered(source[i]) && covered(source[i + 1]) && covered(source[i + 2]))) kept.push(source[i], source[i + 1], source[i + 2]);
    mesh.geometry.setIndex(kept);
  }
  private skinIndex: number[] | null = null;

  /** Masks covered sleeve, torso, and waistband triangles of inner `top`/`bottom` layers under closed outerwear (0 extra DCs). */
  private applyOuterwearLayerMask(outerId: string) {
    const mode: OuterMaskMode =
      outerId === 'wool_overcoat' ||
      outerId === 'trench_coat' ||
      outerId === 'puffer_parka' ||
      outerId === 'cardigan' ||
      outerId === 'jacket' ||
      outerId === 'hoodie'
        ? outerId
        : 'none';

    for (const w of this.worn.values()) {
      const slot = w.item.slot;
      if (slot !== 'top' && slot !== 'dress' && slot !== 'bottom') continue;
      for (const m of w.meshes) {
        if (m.name.startsWith('Trim')) {
          m.visible = mode === 'none' || mode === 'cardigan';
          continue;
        }
        const sourceGeom = (m.geometry.userData.__ecSourceGeom as T.BufferGeometry | undefined) ?? m.geometry;
        m.geometry.setIndex(getOuterMaskedIndex(sourceGeom, slot, mode));
      }
    }
  }

  /** Masks upper skull-crown and wide curl-puff triangles under winter beanies/caps (0 extra DCs, instant O(1) toggle). */
  private applyHeadwearHairMask(headwear: 'none' | 'beanie' | 'cap') {
    for (const w of this.worn.values()) {
      if (w.item.slot !== 'hair') continue;
      for (const m of w.meshes) {
        const sourceGeom = (m.geometry.userData.__ecSourceGeom as T.BufferGeometry | undefined) ?? m.geometry;
        const bones = m.skeleton?.bones ?? [];
        m.geometry.setIndex(getHeadwearMaskedHairIndex(sourceGeom, bones, headwear));
      }
    }
    for (const m of this.builtinHair) {
      const sm = m as T.SkinnedMesh;
      if (!m.geometry) continue;
      if (!m.geometry.userData.__ecOrigIndexSaved) {
        m.geometry.userData.__ecOrigIndexSaved = true;
        m.geometry.userData.__ecOrigIndex = m.geometry.index;
      }
      if (headwear === 'none') {
        m.geometry.setIndex((m.geometry.userData.__ecOrigIndex as T.BufferAttribute | null) ?? null);
      } else {
        m.geometry.setIndex(getHeadwearMaskedHairIndex(m.geometry, sm.skeleton?.bones ?? [], headwear));
      }
    }
  }

  setOwnView(on: boolean) {
    this.ownView = on;
    this.showHead(!on);
  }
  private showHead(show: boolean) { for (const m of this.headMaterials) { m.colorWrite = show; m.depthWrite = show; } }

  /** What is worn, for tests and QA. */
  get state() { return { worn: [...this.worn.keys()], signatureVisible: this.signature.every(m => m.visible), triangles: [...this.worn.values()].reduce((n, w) => n + w.meshes.reduce((k, m) => k + (m.geometry.index?.count ?? 0) / 3, 0), 0) }; }

  dispose() {
    this.disposed = true; this.epoch++;
    this.syncHairChainRestBones(null);
    for (const [id, w] of this.worn) this.remove(id, w);
  }
}
