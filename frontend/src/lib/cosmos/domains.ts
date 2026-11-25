/**
 * Galaxies and constellations of the knowledge universe.
 *
 * Word galaxies group Open English WordNet lexicographer files: the semantic category each synset was filed under by
 * WordNet's lexicographers. A word is PLACED by the most common sense of the part of speech on its card (or of the word):
 * that decides a position only. It never claims which sense the learner knows; every relation keeps its own sense scope.
 */
export type GalaxyId = 'people' | 'mind' | 'nature' | 'life' | 'society' | 'measure' | 'action' | 'quality' | 'grammar' | 'sources' | 'other';

export interface GalaxyDef { id: GalaxyId; vi: string; en: string; color: string; angle: number; lift: number }

/** Fixed order and anchors: a galaxy never moves when the learner's universe grows. */
export const GALAXIES: GalaxyDef[] = [
  { id: 'people', vi: 'Con người và cơ thể', en: 'People and the body', color: '#7dd3fc', angle: 0.0, lift: 120 },
  { id: 'mind', vi: 'Tâm trí và cảm xúc', en: 'Mind and feeling', color: '#c4b5fd', angle: 0.57, lift: -160 },
  { id: 'nature', vi: 'Thiên nhiên và sự sống', en: 'Nature and life', color: '#6ee7b7', angle: 1.14, lift: 60 },
  { id: 'life', vi: 'Đồ vật và đời sống', en: 'Things and daily life', color: '#fcd34d', angle: 1.71, lift: -90 },
  { id: 'society', vi: 'Giao tiếp và xã hội', en: 'Communication and society', color: '#f9a8d4', angle: 2.28, lift: 170 },
  { id: 'measure', vi: 'Không gian, thời gian, số lượng', en: 'Space, time and measure', color: '#93c5fd', angle: 2.85, lift: -40 },
  { id: 'action', vi: 'Hành động và thay đổi', en: 'Action and change', color: '#fda4af', angle: 3.42, lift: 110 },
  { id: 'quality', vi: 'Tính chất và mô tả', en: 'Qualities and description', color: '#e9d5ff', angle: 3.99, lift: -140 },
  { id: 'other', vi: 'Cụm từ và từ khác', en: 'Phrases and other words', color: '#cbd5e1', angle: 4.56, lift: 30 },
  { id: 'grammar', vi: 'Ngữ pháp', en: 'Grammar', color: '#f0abfc', angle: 5.13, lift: -80 },
  { id: 'sources', vi: 'Nguồn học của bạn', en: 'Your sources', color: '#86efac', angle: 5.7, lift: 140 },
];
export const GALAXY_INDEX: Record<GalaxyId, number> = Object.fromEntries(GALAXIES.map((g, i) => [g.id, i])) as Record<GalaxyId, number>;

/** lexicographer file -> [galaxy, Vietnamese, English]. Every OEWN 2025 lexfile is listed (the contract test checks it). */
export const LEXFILES: Record<string, [GalaxyId, string, string]> = {
  'noun.Tops': ['measure', 'Khái niệm gốc', 'Top concepts'],
  'noun.person': ['people', 'Con người', 'People'],
  'noun.body': ['people', 'Cơ thể', 'Body'],
  'verb.body': ['people', 'Hoạt động cơ thể', 'Body actions'],
  'noun.cognition': ['mind', 'Tư duy và tri thức', 'Thought and knowledge'],
  'noun.feeling': ['mind', 'Cảm xúc', 'Feelings'],
  'noun.motive': ['mind', 'Động cơ', 'Motives'],
  'verb.cognition': ['mind', 'Nghĩ và hiểu', 'Thinking'],
  'verb.emotion': ['mind', 'Cảm nhận', 'Emotion verbs'],
  'verb.perception': ['mind', 'Giác quan', 'Perception'],
  'noun.animal': ['nature', 'Động vật', 'Animals'],
  'noun.plant': ['nature', 'Thực vật', 'Plants'],
  'noun.object': ['nature', 'Vật thể tự nhiên', 'Natural objects'],
  'noun.phenomenon': ['nature', 'Hiện tượng', 'Phenomena'],
  'noun.substance': ['nature', 'Chất', 'Substances'],
  'verb.weather': ['nature', 'Thời tiết', 'Weather'],
  'noun.artifact': ['life', 'Đồ vật nhân tạo', 'Artifacts'],
  'noun.food': ['life', 'Đồ ăn và thức uống', 'Food and drink'],
  'verb.consumption': ['life', 'Ăn, uống, dùng', 'Consumption'],
  'verb.creation': ['life', 'Tạo ra', 'Creation'],
  'verb.contact': ['life', 'Chạm và tác động', 'Contact'],
  'noun.communication': ['society', 'Giao tiếp', 'Communication'],
  'noun.group': ['society', 'Nhóm và tổ chức', 'Groups'],
  'noun.act': ['society', 'Hành vi và việc làm', 'Acts'],
  'noun.possession': ['society', 'Sở hữu và tiền bạc', 'Possession'],
  'verb.communication': ['society', 'Nói và truyền đạt', 'Communication verbs'],
  'verb.social': ['society', 'Hoạt động xã hội', 'Social verbs'],
  'verb.competition': ['society', 'Thi đấu', 'Competition'],
  'verb.possession': ['society', 'Có, cho, mua bán', 'Possession verbs'],
  'noun.location': ['measure', 'Nơi chốn', 'Places'],
  'noun.time': ['measure', 'Thời gian', 'Time'],
  'noun.quantity': ['measure', 'Số lượng và đơn vị', 'Quantities'],
  'noun.shape': ['measure', 'Hình dạng', 'Shapes'],
  'noun.relation': ['measure', 'Quan hệ', 'Relations'],
  'noun.event': ['measure', 'Sự kiện', 'Events'],
  'noun.process': ['measure', 'Quá trình', 'Processes'],
  'verb.motion': ['action', 'Chuyển động', 'Motion'],
  'verb.change': ['action', 'Thay đổi', 'Change'],
  'verb.stative': ['action', 'Trạng thái (động từ)', 'Stative verbs'],
  'noun.attribute': ['quality', 'Thuộc tính', 'Attributes'],
  'noun.state': ['quality', 'Trạng thái', 'States'],
  'adj.all': ['quality', 'Tính từ', 'Adjectives'],
  'adj.pert': ['quality', 'Tính từ quan hệ', 'Relational adjectives'],
  'adj.ppl': ['quality', 'Tính từ phân từ', 'Participial adjectives'],
  'adv.all': ['quality', 'Trạng từ', 'Adverbs'],
};

export const SOURCE_CONSTELLATIONS: Record<string, [string, string]> = {
  READING: ['Bài đọc đã hoàn thành', 'Completed reading'],
  LISTENING: ['Bài nghe đã hoàn thành', 'Completed listening'],
  WRITING: ['Bài viết của bạn', 'Your writing'],
  SPEAKING: ['Lời nói của bạn', 'Your speaking'],
  MY_BOOKS: ['Đoạn bạn đánh dấu trong Sách của tôi', 'Passages you highlighted in My Books'],
};

export const OTHER_CONSTELLATION: [string, string] = ['Chưa có trong WordNet', 'Not in WordNet'];
