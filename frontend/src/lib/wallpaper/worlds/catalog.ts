import { WORLD_POSTERS, WORLD_THUMBS } from './thumbs';
import type { WorldCategory, WorldTech } from './types';

/**
 * Echo Universe — the catalogue of Living Worlds. Plain data: no graphics code is imported here, so the preference
 * store and the gallery stay light. Each world's scene is its own lazy chunk (loaders.ts).
 */

export interface WorldMeta {
  id: string;
  /** Names are the collection's own titles, the same in both languages. */
  title: string;
  moodVi: string;
  moodEn: string;
  /** What this world does when you touch it. */
  touchVi: string;
  touchEn: string;
  /** Which study mood it suits. */
  studyVi: string;
  studyEn: string;
  tech: WorldTech;
  categories: WorldCategory[];
  /** Accent the studio borrows and the glass tint of the workspace (r g b). */
  accent: string;
  tint: string;
  /** How much it asks of a device. */
  weight: 'light' | 'medium' | 'rich';
  /** Follows the app's light / dark appearance with its own day and night scene. */
  dayNight: boolean;
  /** Scene clock at start: every world opens at a good moment. */
  startTime?: number;
  /** Licence credit shown with the world, when it uses someone else's work. */
  credit?: string;
  /** Context needs (the context is created once, by the runtime). */
  antialias?: boolean;
  depth?: boolean;
}

export const WORLD_CATEGORIES: { id: WorldCategory; vi: string; en: string }[] = [
  { id: 'ocean', vi: 'Đại dương', en: 'Ocean' },
  { id: 'nature', vi: 'Thiên nhiên', en: 'Nature' },
  { id: 'cosmos', vi: 'Vũ trụ', en: 'Cosmos' },
  { id: 'ascii', vi: 'ASCII', en: 'ASCII' },
  { id: 'd2', vi: '2D', en: '2D' },
  { id: 'd3', vi: '3D', en: '3D' },
  { id: 'interactive', vi: 'Tương tác', en: 'Interactive' },
  { id: 'focus', vi: 'Tập trung', en: 'Focus' },
];

export const WORLDS: WorldMeta[] = [
  {
    id: 'echo-abyss', title: 'Echo Abyss',
    moodVi: 'Đại dương phát sáng: Echo lướt qua giữa sứa, đàn cá và những luồng sáng từ mặt nước.',
    moodEn: 'A glowing ocean: Echo glides past jellyfish, schools of fish and shafts of light from the surface.',
    touchVi: 'Con trỏ tạo dòng nước đẩy cá và bụi biển.', touchEn: 'Your pointer makes a current that moves fish and marine snow.',
    studyVi: 'Hợp ôn bài thư thái', studyEn: 'Good for relaxed review',
    tech: '3D', categories: ['ocean', 'd3', 'interactive'], accent: '#38bdf8', tint: '56 189 248', weight: 'rich', dayNight: true, startTime: 40, antialias: true, depth: true,
    credit: '3D Mascot: Low poly animated Cartoon Whale by Blue Colossus Studio (CC BY 4.0).',
  },
  {
    id: 'ascii-dreamscape', title: 'ASCII Dreamscape',
    moodVi: 'Giấc mơ dệt bằng chữ: hàng nghìn ký tự bay lượn, kết thành cá voi, sứa, chim rồi tan ra.',
    moodEn: 'A dream woven from letters: thousands of characters drift into a whale, a jellyfish, a bird, then let go.',
    touchVi: 'Con trỏ là cơn gió thổi tan ký tự; chúng tự tìm về hình cũ.', touchEn: 'Your pointer is a wind that scatters letters; they find their way back.',
    studyVi: 'Hợp nghỉ giữa giờ', studyEn: 'Good for study breaks',
    tech: 'ASCII', categories: ['ascii', 'd2', 'interactive'], accent: '#a78bfa', tint: '139 122 250', weight: 'light', dayNight: false,
  },
  {
    id: 'aurora-silk', title: 'Aurora Silk',
    moodVi: 'Những dải lụa cực quang gấp nếp trên nền trời đêm và mặt hồ phản chiếu.',
    moodEn: 'Ribbons of aurora silk folding over the night sky and a mirror lake.',
    touchVi: 'Con trỏ uốn cong dải sáng và để lại vệt chảy dịu.', touchEn: 'Your pointer bends the ribbons and leaves a soft flowing wake.',
    studyVi: 'Hợp học buổi tối', studyEn: 'Good for evening study',
    tech: 'Shader', categories: ['cosmos', 'nature', 'd2', 'interactive'], accent: '#34d399', tint: '52 211 153', weight: 'medium', dayNight: true,
  },
  {
    id: 'luminous-garden', title: 'Luminous Garden',
    moodVi: 'Khu rừng phát quang: rêu, nấm sáng, đom đóm và bào tử trôi trong sương.',
    moodEn: 'A bioluminescent forest: moss, glowing mushrooms, fireflies and spores in the mist.',
    touchVi: 'Đom đóm tìm đến con trỏ; chạm vào tạo sóng sáng lan qua cỏ.', touchEn: 'Fireflies come to your pointer; a touch sends a wave of light through the grass.',
    studyVi: 'Hợp luyện nghe thư giãn', studyEn: 'Good for relaxed listening',
    tech: '3D', categories: ['nature', 'd3', 'interactive'], accent: '#2dd4bf', tint: '45 212 191', weight: 'rich', dayNight: false, antialias: true, depth: true,
  },
  {
    id: 'sakura-breeze', title: 'Sakura Breeze',
    moodVi: 'Bình minh mùa hoa anh đào: sương mỏng, núi xa, cánh hoa bay theo gió.',
    moodEn: 'A cherry-blossom dawn: thin mist, far mountains, petals riding the wind.',
    touchVi: 'Mỗi chuyển động là một làn gió đổi hướng bay của cánh hoa.', touchEn: 'Every movement is a breeze that turns the petals.',
    studyVi: 'Hợp đọc dài, dịu mắt', studyEn: 'Gentle for long reading',
    tech: '2D', categories: ['nature', 'd2', 'interactive', 'focus'], accent: '#f472b6', tint: '244 114 182', weight: 'medium', dayNight: true,
  },
  {
    id: 'crystal-mirage', title: 'Crystal Mirage',
    moodVi: 'Khối pha lê lơ lửng khúc xạ ánh sáng thành dải cầu vồng trên nền ngọc trai.',
    moodEn: 'Floating crystals breaking light into rainbows above a pearl floor.',
    touchVi: 'Pha lê khẽ nghiêng về phía con trỏ, ánh phản chiếu đổi theo.', touchEn: 'Crystals tilt toward your pointer and their highlights shift.',
    studyVi: 'Hợp tư duy, viết bài', studyEn: 'Good for thinking and writing',
    tech: '3D', categories: ['d3', 'interactive'], accent: '#a5b4fc', tint: '165 180 252', weight: 'rich', dayNight: true, antialias: true, depth: true,
  },
  {
    id: 'celestial-observatory', title: 'Celestial Observatory',
    moodVi: 'Đài quan sát bầu trời: những vòng thiên văn bằng vàng xoay giữa tinh vân và các vì sao.',
    moodEn: 'An observatory of the sky: golden rings turning among nebulae and stars.',
    touchVi: 'Con trỏ làm lộ các chòm sao và đổi góc nhìn.', touchEn: 'Your pointer reveals constellations and shifts the view.',
    studyVi: 'Hợp học khuya', studyEn: 'Good for late study',
    tech: '3D', categories: ['cosmos', 'd3', 'interactive'], accent: '#fbbf24', tint: '251 191 36', weight: 'rich', dayNight: false, antialias: true, depth: true,
  },
  {
    id: 'ink-and-paper', title: 'Ink and Paper',
    moodVi: 'Tranh thủy mặc trên giấy dó: núi loang mực, mây trôi chậm, rất yên tĩnh.',
    moodEn: 'Ink wash on handmade paper: mountains in bleeding ink, slow clouds, deep quiet.',
    touchVi: 'Con trỏ để lại vệt mực loãng tan dần vào giấy.', touchEn: 'Your pointer leaves a diluted ink trail that sinks into the paper.',
    studyVi: 'Dịu mắt nhất khi đọc lâu', studyEn: 'The calmest for long reading',
    tech: '2D', categories: ['nature', 'd2', 'interactive', 'focus'], accent: '#a8a29e', tint: '168 162 158', weight: 'medium', dayNight: true,
  },
  {
    id: 'terminal-rain', title: 'Terminal Rain',
    moodVi: 'Mưa ký tự rơi xuống mặt sàn phản chiếu, thỉnh thoảng hiện lên một từ tiếng Anh.',
    moodEn: 'Rain of characters falling onto a mirror floor, now and then spelling an English word.',
    touchVi: 'Dòng ký tự rẽ quanh con trỏ và sáng lên khi lại gần.', touchEn: 'Streams part around your pointer and light up nearby.',
    studyVi: 'Hợp tập trung làm bài', studyEn: 'Good for focused practice',
    tech: 'ASCII', categories: ['ascii', 'd2', 'interactive', 'focus'], accent: '#34d399', tint: '16 185 129', weight: 'light', dayNight: false,
  },
  {
    id: 'cloud-sanctuary', title: 'Cloud Sanctuary',
    moodVi: 'Bầu trời nhiều tầng mây, đảo nổi xa xa, nắng sớm hoặc hoàng hôn rất nhẹ.',
    moodEn: 'A layered sky with far floating islands, in soft dawn or dusk light.',
    touchVi: 'Con trỏ tạo gió, các tầng mây trôi lệch theo độ sâu.', touchEn: 'Your pointer makes wind; cloud layers slide at their own depths.',
    studyVi: 'Thoáng và dịu khi đọc', studyEn: 'Airy and gentle for reading',
    tech: 'Shader', categories: ['nature', 'd2', 'interactive', 'focus'], accent: '#7dd3fc', tint: '125 211 252', weight: 'medium', dayNight: true,
  },
  {
    id: 'echo-code-garden', title: 'Echo Code Garden',
    moodVi: 'Khu vườn lớn lên từ ký hiệu: cành bằng dấu ngoặc, lá bằng từ khóa, hoa bằng từ vựng.',
    moodEn: 'A garden that grows from symbols: bracket branches, keyword leaves, flowers of vocabulary.',
    touchVi: 'Cây nghiêng về con trỏ; ký tự gần đó tự sắp xếp lại.', touchEn: 'Plants lean toward your pointer; nearby characters rearrange themselves.',
    studyVi: 'Hợp học từ vựng', studyEn: 'Good for vocabulary work',
    tech: 'ASCII', categories: ['ascii', 'nature', 'd2', 'interactive'], accent: '#86efac', tint: '74 222 128', weight: 'light', dayNight: false,
  },
  {
    id: 'cloud-drift', title: 'Cloud Drift',
    moodVi: 'Mây trắng xếp từ những ô chữ nhỏ trôi trên trời xanh, tan ra rồi tụ lại.',
    moodEn: 'White clouds made of tiny letter tiles drifting over blue sky, dissolving and regathering.',
    touchVi: 'Con trỏ là cơn gió đẩy mây lệch đi.', touchEn: 'Your pointer is a wind that pushes the clouds aside.',
    studyVi: 'Tươi sáng cho buổi sáng', studyEn: 'Bright for morning study',
    tech: 'ASCII', categories: ['ascii', 'nature', 'd2', 'interactive', 'focus'], accent: '#60a5fa', tint: '96 165 250', weight: 'light', dayNight: true,
  },
  {
    id: 'lagoon-letters', title: 'Lagoon Letters',
    moodVi: 'Đầm phá xanh ngọc nhìn từ trên cao: cá đuối và đàn cá bằng chữ lượn trên cát.',
    moodEn: 'A turquoise lagoon from above: manta rays and schools of letter fish over the sand.',
    touchVi: 'Con trỏ tạo dòng chảy, đàn cá dạt ra rồi tụ lại.', touchEn: 'Your pointer makes a current; the school parts and regroups.',
    studyVi: 'Hợp nghe và chép chính tả nhẹ', studyEn: 'Good for light listening',
    tech: 'ASCII', categories: ['ascii', 'ocean', 'd2', 'interactive'], accent: '#2dd4bf', tint: '20 184 166', weight: 'light', dayNight: true,
  },
  {
    id: 'koi-pond', title: 'Koi Pond',
    moodVi: 'Ao cá koi yên tĩnh: cá chép bằng ký tự uốn mình giữa lá sen và gợn nước.',
    moodEn: 'A quiet koi pond: carp made of characters curving between lily pads and ripples.',
    touchVi: 'Chạm tạo gợn sóng thật; cá nhận ra con trỏ và rẽ hướng.', touchEn: 'A touch makes real ripples; the fish notice your pointer and turn.',
    studyVi: 'Hợp thư giãn giữa bài', studyEn: 'Good between lessons',
    tech: 'ASCII', categories: ['ascii', 'nature', 'd2', 'interactive'], accent: '#fb923c', tint: '20 184 166', weight: 'light', dayNight: false,
  },
  {
    id: 'jellyfish-ballet', title: 'Jellyfish Ballet',
    moodVi: 'Vũ điệu của sứa ký tự: chuông co bóp, xúc tu mềm mại trong làn nước sâu.',
    moodEn: 'A ballet of letter jellyfish: pulsing bells and soft tentacles in deep water.',
    touchVi: 'Dòng nước từ con trỏ cuốn xúc tu và làm sứa sáng hơn.', touchEn: 'Currents from your pointer sweep the tentacles and brighten the bells.',
    studyVi: 'Hợp học buổi tối', studyEn: 'Good for evening study',
    tech: 'ASCII', categories: ['ascii', 'ocean', 'd2', 'interactive'], accent: '#c084fc', tint: '168 85 247', weight: 'light', dayNight: false,
  },
  {
    id: 'paper-boats', title: 'Paper Boats',
    moodVi: 'Thuyền giấy tự gấp mình rồi xuôi theo mặt nước yên, để lại vệt sóng nhỏ.',
    moodEn: 'Paper boats fold themselves and sail a calm water, leaving small wakes.',
    touchVi: 'Con trỏ tạo dòng nước đẩy thuyền đi và làm gợn mặt nước.', touchEn: 'Your pointer makes a current that steers boats and ripples the water.',
    studyVi: 'Nhẹ nhàng khi đọc', studyEn: 'Gentle for reading',
    tech: 'ASCII', categories: ['ascii', 'ocean', 'd2', 'interactive', 'focus'], accent: '#5eead4', tint: '94 234 212', weight: 'light', dayNight: true,
  },
  {
    id: 'fireflies-at-dusk', title: 'Fireflies at Dusk',
    moodVi: 'Hoàng hôn trên đồng cỏ: đom đóm bằng ký tự chập chờn trên lớp cỏ đung đưa.',
    moodEn: 'Dusk over a meadow: letter fireflies flicker above swaying grass.',
    touchVi: 'Đom đóm tụ lại quanh con trỏ; chạm vào làm chúng tản ra.', touchEn: 'Fireflies gather around your pointer; a touch scatters them.',
    studyVi: 'Ấm áp cho buổi tối', studyEn: 'Warm for the evening',
    tech: 'ASCII', categories: ['ascii', 'nature', 'd2', 'interactive', 'focus'], accent: '#fcd34d', tint: '251 191 36', weight: 'light', dayNight: false,
  },
  {
    id: 'moonlit-characters', title: 'Moonlit Characters',
    moodVi: 'Trăng xếp bằng chữ trên hồ đêm, ánh trăng lấp lánh, sao thưa và mây mỏng.',
    moodEn: 'A moon built of letters over a night lake, shimmering light, few stars, thin cloud.',
    touchVi: 'Con trỏ làm hiện chòm sao ghép từ tiếng Anh, chạm vào mặt hồ tạo gợn sóng.', touchEn: 'Your pointer reveals constellations of English words; touching the lake makes ripples.',
    studyVi: 'Tĩnh lặng khi học khuya', studyEn: 'Still for late study',
    tech: 'ASCII', categories: ['ascii', 'cosmos', 'd2', 'interactive', 'focus'], accent: '#c7d2fe', tint: '129 140 248', weight: 'light', dayNight: false,
  },
  {
    id: 'liquid-lab', title: 'Liquid Lab',
    moodVi: 'Phòng thí nghiệm chất lỏng: sắc màu chảy như thủy tinh nóng, có một thấu kính theo tay bạn.',
    moodEn: 'A liquid laboratory: colour flows like molten glass, with a lens that follows your hand.',
    touchVi: 'Di chuyển để khuấy dòng chảy thật; chạm tạo gợn lan ra rồi lắng xuống.', touchEn: 'Move to stir a real flow; a touch sends ripples that settle.',
    studyVi: 'Hợp nghỉ giữa giờ', studyEn: 'Good for study breaks',
    tech: 'Shader', categories: ['d2', 'interactive'], accent: '#818cf8', tint: '129 140 248', weight: 'rich', dayNight: true,
  },
  {
    id: 'particle-constellation', title: 'Particle Constellation',
    moodVi: 'Vũ trụ của hàng chục nghìn hạt sáng, chảy theo những lực vô hình và kết thành chòm sao.',
    moodEn: 'A universe of tens of thousands of light particles, flowing along unseen forces into constellations.',
    touchVi: 'Con trỏ hút, xoáy và nối các hạt; chạm để đẩy chúng ra.', touchEn: 'Your pointer attracts, swirls and links particles; press to push them away.',
    studyVi: 'Hợp nghỉ giữa giờ', studyEn: 'Good for study breaks',
    tech: 'Shader', categories: ['cosmos', 'd2', 'interactive'], accent: '#f0abfc', tint: '217 70 239', weight: 'medium', dayNight: false,
  },
];

const BY_ID = new Map(WORLDS.map((world) => [world.id, world]));

export function findWorld(id: string | null | undefined): WorldMeta | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function isWorldId(id: unknown): id is string {
  return typeof id === 'string' && BY_ID.has(id);
}

/** The world's still picture: a real frame of the scene (scripts capture it from the running world). */
export function worldThumb(id: string): string {
  return WORLD_THUMBS[id] ?? '';
}

/** The same frame, larger: the first paint of a world and its static fallback. */
export function worldPoster(id: string): string {
  return WORLD_POSTERS[id] ?? '';
}
