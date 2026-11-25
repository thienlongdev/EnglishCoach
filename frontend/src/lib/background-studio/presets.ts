/**
 * Curated cinema-grade preset catalog for Echo Background Studio.
 *
 * Ten handcrafted atmospheric compositions spanning abyssal nacre, boreal
 * aurora, pelagic bioluminescence, molten silk meshes, deep-space nebulae,
 * architectural sapphire, twilight amethyst, translucent crystal, and
 * botanical jade.
 *
 * Every preset provides 4 to 6 perceptually spaced stops with calibrated
 * individual opacities and bespoke mesh focal coordinates `(x, y)` so
 * switching any preset into `mesh`, `linear`, `radial`, or `conic` mode
 * preserves smooth OKLCH transitions, atmospheric depth, and crisp
 * readability across both light and dark workspace surfaces.
 */

import { cloneThemeConfig } from './colorScience';
import type { BackgroundPreset, BackgroundThemeConfig } from './types';

/** Default flagship preset identifier aligned with Echo Ocean Pearl and Abyss. */
export const DEFAULT_BACKGROUND_PRESET_ID = 'pearlescent-abyss' as const;

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  // 1. Pearlescent Abyss — signature Echo Ocean nacre sheen over midnight obsidian
  {
    id: 'pearlescent-abyss',
    name: 'Pearlescent Abyss',
    nameVi: 'Vực Sâu Ngọc Trai',
    taglineEn:
      'Deep midnight obsidian illuminated by opalescent nacre cyan, misty iris violet and silver-pearl sheen.',
    taglineVi:
      'Nền obsidian nửa đêm điểm ánh xà cừ xanh ngọc, tím diên vĩ mờ sương và ánh bạc ngọc trai.',
    category: 'abyss',
    accentRgb: '32 152 184',
    accentHex: '#2098b8',
    config: {
      color: {
        gradientType: 'mesh',
        stops: [
          { id: 'pa-obsidian', color: '#050a1c', position: 0, opacity: 1, x: 14, y: 86 },
          { id: 'pa-indigo', color: '#0d1d42', position: 26, opacity: 0.96, x: 82, y: 78 },
          { id: 'pa-iris', color: '#3d3a87', position: 54, opacity: 0.86, x: 24, y: 34 },
          { id: 'pa-nacre', color: '#2795b5', position: 78, opacity: 0.78, x: 76, y: 24 },
          { id: 'pa-pearl', color: '#b8d4ea', position: 100, opacity: 0.56, x: 52, y: 16 },
        ],
        gradientAngle: 138,
        centerX: 54,
        centerY: 38,
        gradientSpread: 78,
        blendMode: 'screen',
        blendIntensity: 54,
        baseLayerOpacity: 100,
        depthLayerOpacity: 66,
        brightness: 100,
        saturation: 108,
        contrast: 103,
        opacity: 100,
        blur: 4,
        glow: 50,
        colorIntensity: 82,
      },
      motion: {
        effects: ['pearl-shimmer', 'ambient-glow', 'light-drift'],
        animationSpeed: 0.75,
        motionIntensity: 52,
        lightIntensity: 60,
        movementDirection: 128,
        movementScale: 104,
        glowRadius: 64,
        shimmerIntensity: 68,
        animationSmoothness: 88,
        performanceMode: 'auto',
      },
      grainOpacity: 18,
    },
  },

  // 2. Aurora Flow — nocturnal Arctic curtains of boreal emerald, cyan and altitude violet
  {
    id: 'aurora-flow',
    name: 'Aurora Flow',
    nameVi: 'Dải Cực Quang',
    taglineEn:
      'Arctic deep sky swept by boreal emerald-mint curtains, glacial cyan and high-altitude violet-magenta ribbons.',
    taglineVi:
      'Bầu trời Bắc Cực thẫm sâu với dải lụa ngọc lục bảo, xanh băng hà và dải tím hồng tầng cao.',
    category: 'aurora',
    accentRgb: '24 156 128',
    accentHex: '#189c80',
    config: {
      color: {
        gradientType: 'linear',
        stops: [
          { id: 'af-zenith', color: '#050d1c', position: 0, opacity: 1, x: 18, y: 14 },
          { id: 'af-fjord', color: '#0a2438', position: 26, opacity: 0.96, x: 82, y: 24 },
          { id: 'af-boreal', color: '#1b9474', position: 52, opacity: 0.86, x: 36, y: 46 },
          { id: 'af-glacier', color: '#2b93b3', position: 74, opacity: 0.8, x: 72, y: 58 },
          { id: 'af-violet', color: '#5d358a', position: 100, opacity: 0.86, x: 24, y: 84 },
        ],
        gradientAngle: 154,
        centerX: 46,
        centerY: 42,
        gradientSpread: 74,
        blendMode: 'screen',
        blendIntensity: 58,
        baseLayerOpacity: 100,
        depthLayerOpacity: 70,
        brightness: 100,
        saturation: 112,
        contrast: 104,
        opacity: 100,
        blur: 0,
        glow: 54,
        colorIntensity: 86,
      },
      motion: {
        effects: ['aurora', 'light-drift', 'color-breathing'],
        animationSpeed: 0.82,
        motionIntensity: 62,
        lightIntensity: 66,
        movementDirection: 48,
        movementScale: 118,
        glowRadius: 68,
        shimmerIntensity: 32,
        animationSmoothness: 86,
        performanceMode: 'auto',
      },
      grainOpacity: 16,
    },
  },

  // 3. Oceanic Glow — sunlit turquoise lagoon radiating into pelagic trench sapphire
  {
    id: 'oceanic-glow',
    name: 'Oceanic Glow',
    nameVi: 'Ánh Sáng Đại Dương',
    taglineEn:
      'Pelagic deep trench sapphire glowing with bioluminescent turquoise, sunlit cerulean lagoon and soft seafoam light.',
    taglineVi:
      'Đại dương xanh sapphire sâu thẳm bừng sáng sắc ngọc lam phát quang, biển xanh nắng sớm và bọt sóng dịu êm.',
    category: 'abyss',
    accentRgb: '0 160 170',
    accentHex: '#00a0aa',
    config: {
      color: {
        gradientType: 'radial',
        stops: [
          { id: 'og-seafoam', color: '#82d6d2', position: 0, opacity: 0.54, x: 28, y: 22 },
          { id: 'og-turquoise', color: '#1796a0', position: 18, opacity: 0.84, x: 52, y: 30 },
          { id: 'og-cerulean', color: '#0e5888', position: 42, opacity: 0.94, x: 74, y: 48 },
          { id: 'og-cobalt', color: '#082952', position: 68, opacity: 0.98, x: 24, y: 74 },
          { id: 'og-trench', color: '#040f24', position: 100, opacity: 1, x: 82, y: 88 },
        ],
        gradientAngle: 208,
        centerX: 34,
        centerY: 24,
        gradientSpread: 84,
        blendMode: 'lighten',
        blendIntensity: 52,
        baseLayerOpacity: 100,
        depthLayerOpacity: 64,
        brightness: 100,
        saturation: 110,
        contrast: 103,
        opacity: 100,
        blur: 2,
        glow: 56,
        colorIntensity: 84,
      },
      motion: {
        effects: ['liquid-flow', 'ambient-glow', 'color-flow'],
        animationSpeed: 0.78,
        motionIntensity: 58,
        lightIntensity: 64,
        movementDirection: 196,
        movementScale: 112,
        glowRadius: 72,
        shimmerIntensity: 34,
        animationSmoothness: 90,
        performanceMode: 'auto',
      },
      grainOpacity: 16,
    },
  },

  // 4. Liquid Mesh — six-stop molten silk mesh of cobalt, orchid, coral and champagne
  {
    id: 'liquid-mesh',
    name: 'Liquid Mesh',
    nameVi: 'Lụa Sắc Lưu Chuyển',
    taglineEn:
      'Six-stop molten silk mesh blending electric royal cobalt, plum orchid, coral rose and luminous apricot-champagne mist.',
    taglineVi:
      'Lưới lụa sáu sắc chuyển mềm giữa xanh cô-ban hoàng gia, lan tím mận, hồng san hô và sương mơ sâm-panh.',
    category: 'dream',
    accentRgb: '196 70 108',
    accentHex: '#c4466c',
    config: {
      color: {
        gradientType: 'mesh',
        stops: [
          { id: 'lm-velvet', color: '#111438', position: 0, opacity: 1, x: 14, y: 86 },
          { id: 'lm-cobalt', color: '#2645c7', position: 20, opacity: 0.92, x: 20, y: 26 },
          { id: 'lm-orchid', color: '#703492', position: 42, opacity: 0.88, x: 52, y: 44 },
          { id: 'lm-coral', color: '#bd4a6c', position: 64, opacity: 0.84, x: 82, y: 30 },
          { id: 'lm-apricot', color: '#d47e65', position: 82, opacity: 0.74, x: 76, y: 74 },
          { id: 'lm-champagne', color: '#e6c5a6', position: 100, opacity: 0.56, x: 46, y: 80 },
        ],
        gradientAngle: 118,
        centerX: 52,
        centerY: 48,
        gradientSpread: 82,
        blendMode: 'overlay',
        blendIntensity: 56,
        baseLayerOpacity: 100,
        depthLayerOpacity: 68,
        brightness: 99,
        saturation: 114,
        contrast: 102,
        opacity: 100,
        blur: 6,
        glow: 46,
        colorIntensity: 88,
      },
      motion: {
        effects: ['liquid-flow', 'gradient-morph'],
        animationSpeed: 0.92,
        motionIntensity: 66,
        lightIntensity: 54,
        movementDirection: 72,
        movementScale: 128,
        glowRadius: 58,
        shimmerIntensity: 30,
        animationSmoothness: 84,
        performanceMode: 'auto',
      },
      grainOpacity: 20,
    },
  },

  // 5. Nebula Atmosphere — velvet deep-space conic swirl of indigo, rose stardust and lilac
  {
    id: 'nebula-atmosphere',
    name: 'Nebula Atmosphere',
    nameVi: 'Khí Quyển Tinh Vân',
    taglineEn:
      'Velvet deep-space obsidian-plum swirling through ionized indigo clouds, dusty rose stardust and a pale lilac astral core.',
    taglineVi:
      'Không gian nhung tím huyền bí hòa quyện mây chàm ion, bụi sao hồng cổ điển và lõi tử đinh hương mơ màng.',
    category: 'aurora',
    accentRgb: '160 136 212',
    accentHex: '#a088d4',
    config: {
      color: {
        gradientType: 'conic',
        stops: [
          { id: 'na-obsidian', color: '#10091e', position: 0, opacity: 1, x: 16, y: 18 },
          { id: 'na-indigo', color: '#252263', position: 24, opacity: 0.94, x: 78, y: 22 },
          { id: 'na-lilac', color: '#a38cd4', position: 50, opacity: 0.72, x: 52, y: 48 },
          { id: 'na-stardust', color: '#964e70', position: 76, opacity: 0.86, x: 76, y: 78 },
          { id: 'na-twilight', color: '#201031', position: 100, opacity: 0.98, x: 24, y: 82 },
        ],
        gradientAngle: 224,
        centerX: 54,
        centerY: 46,
        gradientSpread: 76,
        blendMode: 'screen',
        blendIntensity: 48,
        baseLayerOpacity: 100,
        depthLayerOpacity: 62,
        brightness: 99,
        saturation: 106,
        contrast: 104,
        opacity: 100,
        blur: 3,
        glow: 54,
        colorIntensity: 80,
      },
      motion: {
        effects: ['ambient-glow', 'light-drift', 'color-breathing'],
        animationSpeed: 0.62,
        motionIntensity: 46,
        lightIntensity: 62,
        movementDirection: 262,
        movementScale: 96,
        glowRadius: 74,
        shimmerIntensity: 36,
        animationSmoothness: 92,
        performanceMode: 'auto',
      },
      grainOpacity: 22,
    },
  },

  // 6. Midnight Sapphire — architectural luxury navy-black with brushed steel-ice gleam
  {
    id: 'midnight-sapphire',
    name: 'Midnight Sapphire',
    nameVi: 'Lam Ngọc Nửa Đêm',
    taglineEn:
      'Architectural luxury navy-black layered with royal sapphire, brushed steel-ice specular gleam and deep indigo vignette.',
    taglineVi:
      'Sắc xanh đen kiến trúc sang trọng kết hợp lam ngọc hoàng gia, ánh thép băng mịn và viền chàm sâu lắng.',
    category: 'abyss',
    accentRgb: '131 169 211',
    accentHex: '#83a9d3',
    config: {
      color: {
        gradientType: 'linear',
        stops: [
          { id: 'ms-navy', color: '#050a17', position: 0, opacity: 1, x: 14, y: 16 },
          { id: 'ms-indigo', color: '#0c1c40', position: 26, opacity: 0.98, x: 84, y: 24 },
          { id: 'ms-sapphire', color: '#1b3f8a', position: 54, opacity: 0.94, x: 36, y: 54 },
          { id: 'ms-steel', color: '#84a9d1', position: 78, opacity: 0.74, x: 60, y: 38 },
          { id: 'ms-vignette', color: '#091329', position: 100, opacity: 0.98, x: 78, y: 84 },
        ],
        gradientAngle: 146,
        centerX: 62,
        centerY: 34,
        gradientSpread: 68,
        blendMode: 'soft-light',
        blendIntensity: 48,
        baseLayerOpacity: 100,
        depthLayerOpacity: 62,
        brightness: 100,
        saturation: 104,
        contrast: 106,
        opacity: 100,
        blur: 0,
        glow: 38,
        colorIntensity: 78,
      },
      motion: {
        effects: ['pearl-shimmer', 'ambient-glow'],
        animationSpeed: 0.54,
        motionIntensity: 38,
        lightIntensity: 48,
        movementDirection: 148,
        movementScale: 82,
        glowRadius: 54,
        shimmerIntensity: 62,
        animationSmoothness: 94,
        performanceMode: 'auto',
      },
      grainOpacity: 14,
    },
  },

  // 7. Violet Dream — twilight amethyst, periwinkle-lavender and opal-pink mist
  {
    id: 'violet-dream',
    name: 'Violet Dream',
    nameVi: 'Giấc Mơ Tử Đinh Hương',
    taglineEn:
      'Twilight amethyst floating with dreamy periwinkle-lavender, opal-pink mist and deep velvet plum depth.',
    taglineVi:
      'Thạch anh tím chạng vạng bồng bềnh cùng xanh hoa dừa cạn, sương hồng opal và chiều sâu mận nhung êm dịu.',
    category: 'dream',
    accentRgb: '146 122 212',
    accentHex: '#927ad4',
    config: {
      color: {
        gradientType: 'mesh',
        stops: [
          { id: 'vd-plum', color: '#140b27', position: 0, opacity: 1, x: 16, y: 84 },
          { id: 'vd-amethyst', color: '#3b226e', position: 28, opacity: 0.94, x: 80, y: 76 },
          { id: 'vd-periwinkle', color: '#6565bd', position: 54, opacity: 0.86, x: 24, y: 32 },
          { id: 'vd-wisteria', color: '#967bd0', position: 78, opacity: 0.78, x: 60, y: 26 },
          { id: 'vd-opal', color: '#d6aac6', position: 100, opacity: 0.58, x: 78, y: 42 },
        ],
        gradientAngle: 162,
        centerX: 48,
        centerY: 40,
        gradientSpread: 80,
        blendMode: 'soft-light',
        blendIntensity: 54,
        baseLayerOpacity: 100,
        depthLayerOpacity: 66,
        brightness: 100,
        saturation: 108,
        contrast: 102,
        opacity: 100,
        blur: 5,
        glow: 50,
        colorIntensity: 82,
      },
      motion: {
        effects: ['color-breathing', 'pearl-shimmer', 'liquid-flow'],
        animationSpeed: 0.72,
        motionIntensity: 54,
        lightIntensity: 56,
        movementDirection: 308,
        movementScale: 108,
        glowRadius: 62,
        shimmerIntensity: 58,
        animationSmoothness: 91,
        performanceMode: 'auto',
      },
      grainOpacity: 18,
    },
  },

  // 8. Rose Quartz — translucent blush crystal glowing over warm rosewood-mauve depth
  {
    id: 'rose-quartz',
    name: 'Rose Quartz',
    nameVi: 'Thạch Anh Hồng',
    taglineEn:
      'Translucent blush crystal glowing with champagne-gold radiance, ivory-pearl luster and warm rosewood-mauve depth.',
    taglineVi:
      'Tinh thể thạch anh hồng trong trẻo tỏa ánh vàng sâm-panh, sắc ngà ngọc trai và chiều sâu gỗ hồng trầm ấm.',
    category: 'crystal',
    accentRgb: '216 154 168',
    accentHex: '#d89aa8',
    config: {
      color: {
        gradientType: 'radial',
        stops: [
          { id: 'rq-ivory', color: '#f2e4dc', position: 0, opacity: 0.78, x: 30, y: 22 },
          { id: 'rq-champagne', color: '#e8c7ae', position: 24, opacity: 0.88, x: 52, y: 28 },
          { id: 'rq-blush', color: '#d89aa8', position: 52, opacity: 0.92, x: 74, y: 42 },
          { id: 'rq-mauve', color: '#ac7083', position: 78, opacity: 0.96, x: 26, y: 74 },
          { id: 'rq-rosewood', color: '#784658', position: 100, opacity: 1, x: 80, y: 86 },
        ],
        gradientAngle: 38,
        centerX: 34,
        centerY: 26,
        gradientSpread: 86,
        blendMode: 'soft-light',
        blendIntensity: 46,
        baseLayerOpacity: 100,
        depthLayerOpacity: 58,
        brightness: 102,
        saturation: 104,
        contrast: 99,
        opacity: 100,
        blur: 4,
        glow: 52,
        colorIntensity: 76,
      },
      motion: {
        effects: ['pearl-shimmer', 'light-drift', 'color-breathing'],
        animationSpeed: 0.64,
        motionIntensity: 44,
        lightIntensity: 62,
        movementDirection: 334,
        movementScale: 92,
        glowRadius: 70,
        shimmerIntensity: 72,
        animationSmoothness: 93,
        performanceMode: 'auto',
      },
      grainOpacity: 15,
    },
  },

  // 9. Emerald Depth — deep abyssal pine-obsidian with malachite-jade core and mint-gold rim
  {
    id: 'emerald-depth',
    name: 'Emerald Depth',
    nameVi: 'Lục Bảo Sâu Thẳm',
    taglineEn:
      'Deep abyssal pine-obsidian infused with a malachite-jade core, viridian caustic glow and soft mint-gold rim.',
    taglineVi:
      'Nền thông đêm huyền bí ẩn chứa lõi ngọc khổng tước, ánh phản quang xanh ngọc bích và viền bạc hà ánh vàng.',
    category: 'botanical',
    accentRgb: '32 148 118',
    accentHex: '#209476',
    config: {
      color: {
        gradientType: 'mesh',
        stops: [
          { id: 'ed-pine', color: '#051412', position: 0, opacity: 1, x: 14, y: 86 },
          { id: 'ed-cypress', color: '#0c302a', position: 28, opacity: 0.96, x: 84, y: 78 },
          { id: 'ed-malachite', color: '#156555', position: 56, opacity: 0.9, x: 44, y: 50 },
          { id: 'ed-viridian', color: '#279175', position: 80, opacity: 0.8, x: 72, y: 24 },
          { id: 'ed-mintgold', color: '#b4d3b1', position: 100, opacity: 0.56, x: 28, y: 20 },
        ],
        gradientAngle: 128,
        centerX: 44,
        centerY: 48,
        gradientSpread: 76,
        blendMode: 'overlay',
        blendIntensity: 52,
        baseLayerOpacity: 100,
        depthLayerOpacity: 64,
        brightness: 100,
        saturation: 106,
        contrast: 104,
        opacity: 100,
        blur: 4,
        glow: 48,
        colorIntensity: 80,
      },
      motion: {
        effects: ['aurora', 'ambient-glow'],
        animationSpeed: 0.68,
        motionIntensity: 48,
        lightIntensity: 58,
        movementDirection: 24,
        movementScale: 98,
        glowRadius: 66,
        shimmerIntensity: 28,
        animationSmoothness: 89,
        performanceMode: 'auto',
      },
      grainOpacity: 17,
    },
  },

  // 10. Arctic Crystal — frosted polar slate refracting glacier cyan, ice-silver and aurora-violet
  {
    id: 'arctic-crystal',
    name: 'Arctic Crystal',
    nameVi: 'Tinh Thể Bắc Cực',
    taglineEn:
      'Frosted polar slate-indigo refracting crystalline glacier cyan, prismatic ice-silver highlights and faint aurora-violet.',
    taglineVi:
      'Đá phiến cực địa phủ sương khúc xạ xanh sông băng trong vắt, ánh bạc tinh thể và tia tím cực quang dịu nhẹ.',
    category: 'crystal',
    accentRgb: '44 134 170',
    accentHex: '#2c86aa',
    config: {
      color: {
        gradientType: 'conic',
        stops: [
          { id: 'ac-slate', color: '#0a1529', position: 0, opacity: 1, x: 16, y: 20 },
          { id: 'ac-glacier', color: '#2a7fa3', position: 26, opacity: 0.84, x: 76, y: 26 },
          { id: 'ac-silver', color: '#a8cde0', position: 50, opacity: 0.54, x: 54, y: 46 },
          { id: 'ac-violet', color: '#52539e', position: 76, opacity: 0.82, x: 74, y: 78 },
          { id: 'ac-polar', color: '#12203b', position: 100, opacity: 0.98, x: 22, y: 80 },
        ],
        gradientAngle: 286,
        centerX: 52,
        centerY: 44,
        gradientSpread: 72,
        blendMode: 'soft-light',
        blendIntensity: 50,
        baseLayerOpacity: 100,
        depthLayerOpacity: 60,
        brightness: 100,
        saturation: 106,
        contrast: 103,
        opacity: 100,
        blur: 1,
        glow: 46,
        colorIntensity: 80,
      },
      motion: {
        effects: ['pearl-shimmer', 'color-flow', 'light-drift'],
        animationSpeed: 0.74,
        motionIntensity: 50,
        lightIntensity: 58,
        movementDirection: 214,
        movementScale: 102,
        glowRadius: 60,
        shimmerIntensity: 74,
        animationSmoothness: 87,
        performanceMode: 'auto',
      },
      grainOpacity: 15,
    },
  },
] as const;

/** Default Echo Background Studio composition used for resets and first-time studio entry. */
export const DEFAULT_STUDIO_CONFIG: BackgroundThemeConfig = cloneThemeConfig(
  BACKGROUND_PRESETS[0].config,
);

const PRESET_BY_ID: ReadonlyMap<string, BackgroundPreset> = new Map(
  BACKGROUND_PRESETS.map((preset) => [preset.id, preset]),
);

/** Looks up a built-in background preset by exact ID, returning `undefined` when absent. */
export function findBackgroundPreset(id: string | null | undefined): BackgroundPreset | undefined {
  if (typeof id !== 'string' || id.length === 0) {
    return undefined;
  }
  return PRESET_BY_ID.get(id);
}

/** Type guard verifying whether an unknown value matches a built-in preset identifier. */
export function isBackgroundPresetId(id: unknown): id is string {
  return typeof id === 'string' && PRESET_BY_ID.has(id);
}
