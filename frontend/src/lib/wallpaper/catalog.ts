import type { WallpaperCollectionId, WallpaperPreset, WallpaperRendition } from '@/types/wallpaper';

/**
 * Hình nền — curated catalog (2026-10-19).
 *
 * Every entry is a real moving video from Pexels (Pexels License: free use on websites, attribution appreciated, no
 * redistribution as a stock / wallpaper library). Files are played straight from the provider's CDN by the learner's
 * browser (videos.pexels.com: H.264, index first, `Access-Control-Allow-Origin: *`, one-year cache) — English Coach's
 * servers never carry a byte of them. Each rendition below was decoded on the production origin before release
 * (docs/live-wallpaper/RESEARCH_AND_RELEASE.md): `height` is the decoded height, not the name on the CDN (some names
 * alias a different file, e.g. Golden Hour's "1920×1080" is 1280×720 and is listed as 720 here).
 */

const PEXELS_VIDEO = 'https://videos.pexels.com/video-files/';

function r(height: WallpaperRendition['height'], fps: number, bytes: number, path: string): WallpaperRendition {
  const width = height === 720 ? 1280 : height === 1080 ? 1920 : height === 1440 ? 2560 : 3840;
  return { height, width, fps, bytes, url: PEXELS_VIDEO + path };
}

function pexels(author: string, slug: string): WallpaperPreset['credit'] {
  return { author, sourceUrl: `https://www.pexels.com/video/${slug}/`, provider: 'Pexels', license: 'Pexels License' };
}

export const WALLPAPER_COLLECTIONS: { id: WallpaperCollectionId; vi: string; en: string }[] = [
  { id: 'ocean', vi: 'Đại dương', en: 'Ocean' },
  { id: 'sky', vi: 'Bầu trời', en: 'Skies' },
  { id: 'night', vi: 'Đêm và vũ trụ', en: 'Night and cosmos' },
  { id: 'nature', vi: 'Thiên nhiên', en: 'Nature' },
  { id: 'colour', vi: 'Sắc màu', en: 'Colour' },
];

export const WALLPAPER_PRESETS: WallpaperPreset[] = [
  {
    id: 'ocean-light',
    collection: 'ocean',
    titleVi: 'Nắng xuyên đại dương',
    titleEn: 'Ocean Light',
    moodVi: 'Những dải nắng lay động dưới làn nước xanh ngọc.',
    moodEn: 'Shafts of sun drifting through turquoise water.',
    kind: 'video',
    duration: 13.9,
    renditions: [
      r(720, 24, 4_585_895, '2632737/2632737-hd_1280_720_24fps.mp4'),
      r(1080, 24, 8_766_675, '2632737/2632737-hd_1920_1080_24fps.mp4'),
    ],
    poster: 'https://images.pexels.com/videos/2632737/free-video-2632737.jpg',
    accent: '#22d3ee',
    focus: '50% 20%',
    credit: pexels('James Cheney', 'underwater-footage-of-rising-bubbles-2632737'),
  },
  {
    id: 'coral-reef',
    collection: 'ocean',
    titleVi: 'Rạn san hô',
    titleEn: 'Coral Reef',
    moodVi: 'Đàn cá nhỏ lượn quanh rạn san hô xanh thẳm.',
    moodEn: 'Small fish weaving around a deep-blue reef.',
    kind: 'video',
    duration: 10.7,
    renditions: [
      r(720, 30, 3_990_475, '11342020/11342020-hd_1280_720_30fps.mp4'),
      r(1080, 30, 6_935_238, '11342020/11342020-hd_1920_1080_30fps.mp4'),
      r(1440, 30, 10_706_864, '11342020/11342020-uhd_2560_1440_30fps.mp4'),
      r(2160, 30, 19_649_810, '11342020/11342020-uhd_3840_2160_30fps.mp4'),
    ],
    poster: 'https://images.pexels.com/videos/11342020/aquirium-fish-nature-ocean-11342020.jpeg',
    accent: '#3b82f6',
    credit: pexels('Magda Ehlers', 'coral-reef-in-water-11342020'),
  },
  {
    id: 'drifting-jellyfish',
    collection: 'ocean',
    titleVi: 'Sứa lững lờ',
    titleEn: 'Drifting Jellyfish',
    moodVi: 'Một chú sứa trôi chậm trong làn nước xanh trong.',
    moodEn: 'A lone jellyfish pulsing through clear blue water.',
    kind: 'video',
    duration: 8.2,
    renditions: [
      r(720, 24, 2_692_685, '2863432/2863432-hd_1280_720_24fps.mp4'),
      r(1080, 24, 4_999_260, '2863432/2863432-hd_1920_1080_24fps.mp4'),
      r(1440, 24, 12_093_129, '2863432/2863432-uhd_2560_1440_24fps.mp4'),
      r(2160, 24, 22_046_368, '2863432/2863432-uhd_3840_2160_24fps.mp4'),
    ],
    poster: 'https://images.pexels.com/videos/2863432/free-video-2863432.jpg',
    accent: '#7dd3fc',
    credit: pexels('Ben Gibbs', 'a-jellyfish-moving-underwater-2863432'),
  },
  {
    id: 'pastel-sky',
    collection: 'sky',
    titleVi: 'Mây hồng',
    titleEn: 'Pastel Sky',
    moodVi: 'Mây hoàng hôn hồng phấn, đàn chim bay ngang trời.',
    moodEn: 'Blush sunset clouds with birds crossing the sky.',
    kind: 'video',
    duration: 14.9,
    renditions: [
      r(720, 60, 1_421_000, '40061534/17100722_1280_720_60fps.mp4'),
      r(1080, 60, 3_346_993, '40061534/17100724_1920_1080_60fps.mp4'),
      r(1440, 60, 5_512_697, '40061534/17100726_2560_1440_60fps.mp4'),
      r(2160, 60, 15_782_508, '40061534/17100728_3840_2160_60fps.mp4'),
    ],
    poster: 'https://images.pexels.com/videos/40061534/pexels-photo-40061534.jpeg',
    accent: '#f9a8d4',
    credit: pexels('Ahmed', 'captivating-sunset-clouds-with-birds-in-flight-40061534'),
  },
  {
    id: 'golden-hour',
    collection: 'sky',
    titleVi: 'Giờ vàng',
    titleEn: 'Golden Hour',
    moodVi: 'Mây trôi nhanh trên nền trời cam rực.',
    moodEn: 'Time-lapse clouds racing across an amber sky.',
    kind: 'video',
    duration: 18.2,
    renditions: [
      r(720, 30, 4_421_221, '13286601/13286601-hd_1280_720_30fps.mp4'),
      r(2160, 30, 22_121_631, '13286601/13286601-uhd_3840_2160_30fps.mp4'),
    ],
    poster: 'https://images.pexels.com/videos/13286601/4k-video-chasing-cloud-abstract-cloud-formation-13286601.jpeg',
    accent: '#f59e0b',
    focus: '50% 40%',
    credit: pexels('tejinder ladi photography', 'time-lapse-of-moving-clouds-on-a-sunset-sky-13286601'),
  },
  {
    id: 'aurora',
    collection: 'sky',
    titleVi: 'Cực quang',
    titleEn: 'Aurora',
    moodVi: 'Dải sáng xanh tím uốn lượn trên bầu trời đêm.',
    moodEn: 'Green and violet light rippling over the night.',
    kind: 'video',
    duration: 8.5,
    renditions: [
      r(720, 60, 4_178_208, '28889010/12505177_1280_720_60fps.mp4'),
      r(1080, 60, 12_606_261, '28889010/12505178_1920_1080_60fps.mp4'),
      r(1440, 60, 21_954_780, '28889010/12505179_2560_1440_60fps.mp4'),
    ],
    poster: 'https://images.pexels.com/videos/28889010/aurora-time-lapse-28889010.jpeg',
    accent: '#34d399',
    credit: pexels('Frank Cone', 'stunning-aurora-borealis-in-night-sky-timelapse-28889010'),
  },
  {
    id: 'nebula',
    collection: 'night',
    titleVi: 'Tinh vân',
    titleEn: 'Nebula',
    moodVi: 'Trôi qua những đám mây sao xanh ngọc.',
    moodEn: 'Drifting through teal clouds of stars.',
    kind: 'video',
    duration: 19.9,
    renditions: [
      r(720, 25, 4_115_075, '31084223/13283014_1280_720_25fps.mp4'),
      r(1080, 25, 8_858_430, '31084223/13283016_1920_1080_25fps.mp4'),
      r(1440, 25, 14_363_981, '31084223/13283018_2560_1440_25fps.mp4'),
      r(2160, 25, 34_740_860, '31084223/13283019_3840_2160_25fps.mp4'),
    ],
    poster: 'https://images.pexels.com/videos/31084223/nebula-31084223.jpeg',
    accent: '#a78bfa',
    credit: pexels('Adis Resic', 'stunning-cosmic-nebula-with-stars-in-deep-space-31084223'),
  },
  {
    id: 'neon-rain',
    collection: 'night',
    titleVi: 'Phố đêm mưa',
    titleEn: 'Neon Rain',
    moodVi: 'Ánh đèn neon loang trên mặt đường ướt.',
    moodEn: 'Neon signs shimmering on wet city streets.',
    kind: 'video',
    duration: 40.6,
    renditions: [
      r(720, 30, 15_587_511, '3037539/3037539-hd_1280_720_30fps.mp4'),
      r(1080, 30, 29_764_991, '3037539/3037539-hd_1920_1080_30fps.mp4'),
      r(1440, 30, 69_771_032, '3037539/3037539-uhd_2560_1440_30fps.mp4'),
    ],
    poster: 'https://images.pexels.com/videos/3037539/free-video-3037539.jpg',
    accent: '#f472b6',
    credit: pexels('George Morina', 'people-outside-the-streets-on-a-rainy-night-3037539'),
  },
  {
    id: 'emerald-falls',
    collection: 'nature',
    titleVi: 'Thác rừng',
    titleEn: 'Emerald Falls',
    moodVi: 'Dòng thác trắng giữa rừng xanh mướt.',
    moodEn: 'White water tumbling through a green forest.',
    kind: 'video',
    duration: 60.1,
    renditions: [
      r(720, 30, 22_946_265, '8468523/8468523-hd_1280_720_30fps.mp4'),
      r(1080, 30, 43_889_770, '8468523/8468523-hd_1920_1080_30fps.mp4'),
      r(1440, 30, 102_444_916, '8468523/8468523-uhd_2560_1440_30fps.mp4'),
    ],
    poster: 'https://images.pexels.com/videos/8468523/pexels-photo-8468523.jpeg',
    accent: '#10b981',
    credit: pexels('I Am Sorin', 'waterfalls-cascading-through-rocks-8468523'),
  },
  {
    id: 'rain-on-glass',
    collection: 'nature',
    titleVi: 'Mưa bên khung kính',
    titleEn: 'Rain on Glass',
    moodVi: 'Giọt mưa chảy trên ô kính, khu vườn nhòe phía sau.',
    moodEn: 'Raindrops sliding down glass, a garden blurred beyond.',
    kind: 'video',
    duration: 61.6,
    renditions: [
      r(720, 30, 12_181_537, '5517022/5517022-hd_1280_720_30fps.mp4'),
      r(1080, 30, 24_657_831, '5517022/5517022-hd_1920_1080_30fps.mp4'),
      r(1440, 30, 40_209_129, '5517022/5517022-uhd_2560_1440_30fps.mp4'),
    ],
    poster: 'https://images.pexels.com/videos/5517022/pexels-photo-5517022.jpeg',
    accent: '#84cc16',
    credit: pexels('Jose Gabriel Ortega Castro', 'raindrops-on-a-glass-window-5517022'),
  },
  {
    id: 'ink-fire',
    collection: 'colour',
    titleVi: 'Mực lửa',
    titleEn: 'Ink Fire',
    moodVi: 'Sắc cam, đỏ và tím hòa vào nhau trong nước.',
    moodEn: 'Orange, red and violet ink folding through water.',
    kind: 'video',
    duration: 34.9,
    renditions: [
      r(720, 50, 12_397_187, '15432087/15432087-hd_1280_720_50fps.mp4'),
      r(1080, 50, 24_754_849, '15432087/15432087-hd_1920_1080_50fps.mp4'),
      r(1440, 50, 52_945_917, '15432087/15432087-uhd_2560_1440_50fps.mp4'),
    ],
    poster: 'https://images.pexels.com/videos/15432087/abstract-acrylic-art-artist-15432087.jpeg',
    accent: '#fb923c',
    credit: pexels('Dan Cristian Pădureț', 'colorful-ink-mixing-in-water-15432087'),
  },
  {
    id: 'liquid-marble',
    collection: 'colour',
    titleVi: 'Cẩm thạch lỏng',
    titleEn: 'Liquid Marble',
    moodVi: 'Vân màu ngọc lam và vàng chảy chậm rãi.',
    moodEn: 'Turquoise and gold marbling in slow flow.',
    kind: 'video',
    duration: 13.4,
    renditions: [
      r(720, 25, 2_578_491, '12137343/12137343-hd_1280_720_25fps.mp4'),
      r(1080, 25, 5_937_402, '12137343/12137343-hd_1920_1080_25fps.mp4'),
      r(1440, 25, 11_412_640, '12137343/12137343-uhd_2560_1440_25fps.mp4'),
      r(2160, 25, 35_571_160, '12137343/12137343-uhd_3840_2160_25fps.mp4'),
    ],
    poster: 'https://images.pexels.com/videos/12137343/pexels-photo-12137343.jpeg',
    accent: '#2dd4bf',
    credit: pexels('PureRaw: Camera & Film Grain', 'colorful-paint-on-canvas-12137343'),
  },
];

export function findPreset(id: string | undefined | null): WallpaperPreset | undefined {
  return id ? WALLPAPER_PRESETS.find((p) => p.id === id) : undefined;
}

/** Resized poster frame from the provider's image CDN (WebP, compressed). */
export function posterUrl(preset: WallpaperPreset, width: number): string {
  return `${preset.poster}?auto=compress&cs=tinysrgb&fm=webp&w=${Math.round(width)}`;
}
