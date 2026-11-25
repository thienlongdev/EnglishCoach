import type { ActionId } from './types';

/**
 * The catalogue of placeable objects. Metadata only (no three.js): the shapes are built in
 * `components/study-space/world/furniture.ts` under the same ids, and the catalogue test checks that every id here
 * has a builder. A new pack = new rows here + their builders; layouts keep working because they store ids.
 */

export type Placement = 'floor' | 'surface' | 'wall';
export type CatalogCategory = 'furniture' | 'decor' | 'lighting' | 'plants' | 'study' | 'clock' | 'sound' | 'care';

export interface CatalogAnchor {
  x: number;
  z: number;
  rotY: number;
  y: number;
  activity: 'study' | 'sit' | 'sleep' | 'relax' | 'read';
  /** True when a solid backrest blocks rear (`PI`) approaches behind the seat. */
  hasBackrest?: boolean;
}

export interface CatalogItem {
  id: string;
  name: string;
  nameEn: string;
  category: CatalogCategory;
  place: Placement;
  /** Footprint in metres (width x depth) used for snapping and overlap checks. */
  size: [number, number];
  /** Heights of the surfaces other objects can stand on (metres above the item's base). */
  tops?: number[];
  /** Flat items (rugs) never block other items. */
  flat?: boolean;
  /** Primary anchor where a character goes to use it, relative to the item: [x, z, rotY, activity]. */
  anchor?: CatalogAnchor;
  /** Multi-slot anchors along multi-cushion sofas or bedside edges (falls back to `[anchor]` when omitted). */
  anchors?: readonly CatalogAnchor[];
  action?: ActionId;
  /** Emits light (practical lamp). */
  light?: boolean;
  tint?: string;
  /** Comes of living in the room (a crumpled page, a tied bag): not something to pick from the catalogue. */
  unlisted?: boolean;
}

const item = (i: CatalogItem) => i;

export const CATALOG: CatalogItem[] = [
  // ── Nội thất ────────────────────────────────────────────────────────────
  item({ id: 'desk.corner', name: 'Bàn học kệ liền', nameEn: 'Desk with hutch', category: 'furniture', place: 'floor', size: [1.9, 0.8], tops: [0.76, 1.38], anchor: { x: -0.25, z: 0.72, rotY: Math.PI, y: 0, activity: 'study' }, tint: '#f4efe9' }),
  item({ id: 'desk.basic', name: 'Bàn học cơ bản', nameEn: 'Simple desk', category: 'furniture', place: 'floor', size: [1.4, 0.7], tops: [0.76], anchor: { x: 0, z: 0.68, rotY: Math.PI, y: 0, activity: 'study' }, tint: '#e9dccb' }),
  item({ id: 'desk.wood', name: 'Bàn gỗ cổ điển', nameEn: 'Classic wooden desk', category: 'furniture', place: 'floor', size: [1.6, 0.8], tops: [0.78], anchor: { x: 0, z: 0.75, rotY: Math.PI, y: 0, activity: 'study' }, tint: '#8a5a3b' }),
  item({ id: 'chair.office', name: 'Ghế xoay', nameEn: 'Swivel chair', category: 'furniture', place: 'floor', size: [0.62, 0.62], anchor: { x: 0, z: 0, rotY: 0, y: 0, activity: 'sit', hasBackrest: true }, tint: '#c9c3f0' }),
  item({ id: 'chair.simple', name: 'Ghế học', nameEn: 'Study chair', category: 'furniture', place: 'floor', size: [0.5, 0.5], anchor: { x: 0, z: 0, rotY: 0, y: 0, activity: 'sit', hasBackrest: true }, tint: '#f6f3ee' }),
  item({ id: 'bed.single', name: 'Giường đơn', nameEn: 'Single bed', category: 'furniture', place: 'floor', size: [1.15, 2.05], tops: [0.52], anchor: { x: 0, z: 0, rotY: 0, y: 0.52, activity: 'sleep', hasBackrest: false }, anchors: [{ x: 0.475, z: -0.22, rotY: Math.PI / 2, y: 0.52, activity: 'sit', hasBackrest: false }, { x: 0.475, z: 0.28, rotY: Math.PI / 2, y: 0.52, activity: 'sit', hasBackrest: false }, { x: -0.475, z: -0.22, rotY: -Math.PI / 2, y: 0.52, activity: 'sit', hasBackrest: false }, { x: -0.475, z: 0.28, rotY: -Math.PI / 2, y: 0.52, activity: 'sit', hasBackrest: false }], tint: '#9fb4ee' }),
  item({ id: 'bed.drawer', name: 'Giường có ngăn kéo', nameEn: 'Bed with drawers', category: 'furniture', place: 'floor', size: [1.25, 2.1], tops: [0.58], anchor: { x: 0, z: 0, rotY: 0, y: 0.58, activity: 'sleep', hasBackrest: false }, anchors: [{ x: 0.525, z: -0.22, rotY: Math.PI / 2, y: 0.58, activity: 'sit', hasBackrest: false }, { x: 0.525, z: 0.28, rotY: Math.PI / 2, y: 0.58, activity: 'sit', hasBackrest: false }, { x: -0.525, z: -0.22, rotY: -Math.PI / 2, y: 0.58, activity: 'sit', hasBackrest: false }, { x: -0.525, z: 0.28, rotY: -Math.PI / 2, y: 0.58, activity: 'sit', hasBackrest: false }], tint: '#b6a6ec' }),
  item({ id: 'shelf.tall', name: 'Kệ sách đứng', nameEn: 'Bookcase', category: 'furniture', place: 'floor', size: [0.9, 0.36], tops: [0.42, 0.84, 1.26, 1.68], tint: '#f1ece5' }),
  item({ id: 'shelf.wall', name: 'Kệ treo tường', nameEn: 'Wall shelf', category: 'furniture', place: 'wall', size: [1.0, 0.26], tops: [0.02], tint: '#f3eee8' }),
  item({ id: 'nightstand', name: 'Tủ đầu giường', nameEn: 'Nightstand', category: 'furniture', place: 'floor', size: [0.46, 0.42], tops: [0.56], tint: '#f4efe9' }),
  item({ id: 'drawers', name: 'Tủ ngăn kéo', nameEn: 'Chest of drawers', category: 'furniture', place: 'floor', size: [0.85, 0.46], tops: [0.82], tint: '#f0c27a' }),
  item({ id: 'table.side', name: 'Bàn tròn nhỏ', nameEn: 'Side table', category: 'furniture', place: 'floor', size: [0.56, 0.56], tops: [0.56], tint: '#d9b48a' }),
  item({ id: 'armchair', name: 'Ghế bành', nameEn: 'Armchair', category: 'furniture', place: 'floor', size: [0.9, 0.85], anchor: { x: 0, z: 0.05, rotY: 0, y: 0, activity: 'relax', hasBackrest: true }, tint: '#a99be8' }),
  item({ id: 'sofa', name: 'Sofa', nameEn: 'Sofa', category: 'furniture', place: 'floor', size: [1.8, 0.85], anchor: { x: 0, z: 0.06, rotY: 0, y: 0, activity: 'relax', hasBackrest: true }, anchors: [{ x: -0.54, z: 0.06, rotY: 0, y: 0, activity: 'relax', hasBackrest: true }, { x: 0, z: 0.06, rotY: 0, y: 0, activity: 'relax', hasBackrest: true }, { x: 0.54, z: 0.06, rotY: 0, y: 0, activity: 'relax', hasBackrest: true }], tint: '#8fa3e8' }),
  item({ id: 'beanbag', name: 'Ghế lười', nameEn: 'Beanbag', category: 'furniture', place: 'floor', size: [0.85, 0.85], anchor: { x: 0, z: 0, rotY: 0, y: 0, activity: 'relax', hasBackrest: true }, tint: '#b7a8f1' }),
  item({ id: 'pouf', name: 'Đôn tròn', nameEn: 'Pouf', category: 'furniture', place: 'floor', size: [0.6, 0.6], tops: [0.42], anchor: { x: 0, z: 0, rotY: 0, y: 0, activity: 'sit', hasBackrest: false }, tint: '#f4f1ee' }),
  item({ id: 'rug.round', name: 'Thảm tròn', nameEn: 'Round rug', category: 'furniture', place: 'floor', size: [2.2, 2.2], flat: true, tint: '#c7cdf6' }),
  item({ id: 'rug.rect', name: 'Thảm chữ nhật', nameEn: 'Rectangular rug', category: 'furniture', place: 'floor', size: [2.4, 1.6], flat: true, tint: '#d8d2f4' }),
  item({ id: 'rug.cloud', name: 'Thảm đám mây', nameEn: 'Cloud rug', category: 'furniture', place: 'floor', size: [2.0, 1.4], flat: true, tint: '#f1f0fb' }),
  item({ id: 'whiteboard', name: 'Bảng trắng', nameEn: 'Whiteboard', category: 'study', place: 'wall', size: [1.3, 0.06], action: 'open:planner' }),
  item({ id: 'pinboard', name: 'Bảng ghim', nameEn: 'Pinboard', category: 'study', place: 'wall', size: [0.9, 0.05], action: 'open:planner', tint: '#d6a46b' }),

  // ── Ánh sáng ────────────────────────────────────────────────────────────
  item({ id: 'lamp.desk', name: 'Đèn bàn', nameEn: 'Desk lamp', category: 'lighting', place: 'surface', size: [0.26, 0.26], light: true, tint: '#f2d9a7' }),
  item({ id: 'lamp.floor', name: 'Đèn cây', nameEn: 'Floor lamp', category: 'lighting', place: 'floor', size: [0.45, 0.45], light: true, tint: '#efe6f9' }),
  item({ id: 'lamp.moon', name: 'Đèn mặt trăng', nameEn: 'Moon lamp', category: 'lighting', place: 'surface', size: [0.26, 0.26], light: true }),
  item({ id: 'lamp.shell', name: 'Đèn vỏ sò', nameEn: 'Shell lamp', category: 'lighting', place: 'surface', size: [0.3, 0.26], light: true }),
  item({ id: 'lamp.jelly', name: 'Đèn sứa', nameEn: 'Jellyfish lamp', category: 'lighting', place: 'surface', size: [0.26, 0.26], light: true }),
  item({ id: 'lamp.lantern', name: 'Đèn lồng cổ', nameEn: 'Brass lantern', category: 'lighting', place: 'surface', size: [0.22, 0.22], light: true }),

  // ── Cây ─────────────────────────────────────────────────────────────────
  item({ id: 'plant.pothos', name: 'Trầu bà', nameEn: 'Pothos', category: 'plants', place: 'surface', size: [0.3, 0.3] }),
  item({ id: 'plant.monstera', name: 'Cây lá lớn', nameEn: 'Monstera', category: 'plants', place: 'floor', size: [0.6, 0.6] }),
  item({ id: 'plant.snake', name: 'Lưỡi hổ', nameEn: 'Snake plant', category: 'plants', place: 'floor', size: [0.36, 0.36] }),
  item({ id: 'plant.succulent', name: 'Sen đá', nameEn: 'Succulent', category: 'plants', place: 'surface', size: [0.16, 0.16] }),
  item({ id: 'plant.hanging', name: 'Cây treo tường', nameEn: 'Hanging plant', category: 'plants', place: 'wall', size: [0.4, 0.3] }),

  // ── Trang trí ───────────────────────────────────────────────────────────
  item({ id: 'art.whale', name: 'Tranh cá voi', nameEn: 'Whale banner', category: 'decor', place: 'wall', size: [0.8, 0.05] }),
  item({ id: 'art.sky', name: 'Tranh bầu trời', nameEn: 'Sky print', category: 'decor', place: 'wall', size: [0.7, 0.04] }),
  item({ id: 'art.coral', name: 'Tranh san hô', nameEn: 'Coral print', category: 'decor', place: 'wall', size: [0.7, 0.04] }),
  item({ id: 'art.leaf', name: 'Tranh cây lá', nameEn: 'Leaf print', category: 'decor', place: 'wall', size: [0.6, 0.04] }),
  item({ id: 'art.photos', name: 'Ảnh kỷ niệm', nameEn: 'Photo strip', category: 'decor', place: 'wall', size: [0.7, 0.03] }),
  item({ id: 'whale.plush', name: 'Cá voi bông', nameEn: 'Whale plush', category: 'decor', place: 'floor', size: [0.9, 0.5] }),
  item({ id: 'lighthouse', name: 'Hải đăng', nameEn: 'Lighthouse', category: 'decor', place: 'surface', size: [0.18, 0.18] }),
  item({ id: 'coral', name: 'San hô', nameEn: 'Coral', category: 'decor', place: 'surface', size: [0.26, 0.2] }),
  item({ id: 'globe', name: 'Quả địa cầu', nameEn: 'Globe', category: 'decor', place: 'surface', size: [0.3, 0.3] }),
  item({ id: 'telescope', name: 'Kính thiên văn', nameEn: 'Telescope', category: 'decor', place: 'floor', size: [0.6, 0.6] }),
  item({ id: 'rocket', name: 'Tên lửa mô hình', nameEn: 'Model rocket', category: 'decor', place: 'surface', size: [0.18, 0.18] }),
  item({ id: 'crystal', name: 'Pha lê phát sáng', nameEn: 'Glowing crystal', category: 'decor', place: 'surface', size: [0.2, 0.2], light: true }),

  // ── Công cụ học tập ─────────────────────────────────────────────────────
  item({ id: 'laptop', name: 'Laptop', nameEn: 'Laptop', category: 'study', place: 'surface', size: [0.38, 0.28], action: 'route:path' }),
  item({ id: 'monitor', name: 'Màn hình', nameEn: 'Monitor', category: 'study', place: 'surface', size: [0.62, 0.24], action: 'route:writing' }),
  item({ id: 'pc.tower', name: 'Thùng máy', nameEn: 'Computer tower', category: 'study', place: 'surface', size: [0.2, 0.42] }),
  item({ id: 'keyboard', name: 'Bàn phím', nameEn: 'Keyboard', category: 'study', place: 'surface', size: [0.44, 0.15] }),
  item({ id: 'mouse.pc', name: 'Chuột máy tính', nameEn: 'Computer mouse', category: 'study', place: 'surface', size: [0.07, 0.11] }),
  item({ id: 'books.stack', name: 'Chồng sách', nameEn: 'Stack of books', category: 'study', place: 'surface', size: [0.3, 0.24], action: 'route:reading' }),
  item({ id: 'books.row', name: 'Hàng sách', nameEn: 'Row of books', category: 'study', place: 'surface', size: [0.5, 0.2], action: 'route:mybooks' }),
  item({ id: 'book.single', name: 'Một cuốn sách', nameEn: 'A book', category: 'study', place: 'surface', size: [0.16, 0.22] }),
  item({ id: 'notebook', name: 'Sổ ghi chú', nameEn: 'Notebook', category: 'study', place: 'surface', size: [0.24, 0.3], action: 'open:notebook' }),
  item({ id: 'dictionary', name: 'Từ điển', nameEn: 'Dictionary', category: 'study', place: 'surface', size: [0.18, 0.25], action: 'route:dictionary' }),
  item({ id: 'pencup', name: 'Cốc bút', nameEn: 'Pen cup', category: 'study', place: 'surface', size: [0.12, 0.12], action: 'route:writing' }),
  item({ id: 'flashbox', name: 'Hộp flashcard', nameEn: 'Flashcard box', category: 'study', place: 'surface', size: [0.26, 0.2], action: 'route:flashcards' }),
  item({ id: 'docs.stack', name: 'Tài liệu nghiên cứu', nameEn: 'Research papers', category: 'study', place: 'surface', size: [0.3, 0.24], action: 'open:research' }),
  item({ id: 'calendar.desk', name: 'Lịch để bàn', nameEn: 'Desk calendar', category: 'study', place: 'surface', size: [0.2, 0.12], action: 'open:planner' }),
  item({ id: 'mug', name: 'Cốc trà', nameEn: 'Mug', category: 'study', place: 'surface', size: [0.12, 0.12] }),
  item({ id: 'kettle.vintage', name: 'Ấm đun nước', nameEn: 'Kettle', category: 'study', place: 'surface', size: [0.21, 0.27] }),
  item({ id: 'teapot', name: 'Ấm trà', nameEn: 'Teapot', category: 'study', place: 'surface', size: [0.17, 0.27] }),
  item({ id: 'teacup', name: 'Tách trà', nameEn: 'Teacup', category: 'study', place: 'surface', size: [0.11, 0.13] }),
  item({ id: 'saucer', name: 'Đĩa lót tách', nameEn: 'Saucer', category: 'study', place: 'surface', size: [0.15, 0.15] }),

  item({ id: 'plant.terracotta', name: 'Cây chậu đất nung', nameEn: 'Terracotta plant', category: 'plants', place: 'surface', size: [0.3, 0.3] }),

  // ── Đồng hồ ─────────────────────────────────────────────────────────────
  item({ id: 'clock.desk', name: 'Đồng hồ để bàn', nameEn: 'Desk clock', category: 'clock', place: 'surface', size: [0.18, 0.12], action: 'open:focus' }),
  item({ id: 'clock.wall', name: 'Đồng hồ treo tường', nameEn: 'Wall clock', category: 'clock', place: 'wall', size: [0.42, 0.06], action: 'open:focus' }),
  item({ id: 'clock.digital', name: 'Đồng hồ điện tử', nameEn: 'Digital clock', category: 'clock', place: 'surface', size: [0.24, 0.1], action: 'open:focus' }),
  item({ id: 'hourglass', name: 'Đồng hồ cát', nameEn: 'Hourglass', category: 'clock', place: 'surface', size: [0.12, 0.12], action: 'open:focus' }),

  // ── Âm thanh ────────────────────────────────────────────────────────────
  item({ id: 'speaker', name: 'Loa', nameEn: 'Speaker', category: 'sound', place: 'surface', size: [0.3, 0.18], action: 'toggle:music' }),
  item({ id: 'mic', name: 'Micro thu âm', nameEn: 'Microphone', category: 'sound', place: 'surface', size: [0.16, 0.16], action: 'route:speaking' }),
  item({ id: 'headphones', name: 'Tai nghe', nameEn: 'Headphones', category: 'sound', place: 'surface', size: [0.22, 0.18], action: 'route:listening' }),
  item({ id: 'radio', name: 'Đài âm thanh nền', nameEn: 'Ambience radio', category: 'sound', place: 'surface', size: [0.28, 0.14], action: 'open:ambient' }),

  // ── Dọn dẹp ─────────────────────────────────────────────────────────────
  item({ id: 'tool.broom', name: 'Chổi', nameEn: 'Broom', category: 'care', place: 'surface', size: [0.3, 0.09] }),
  item({ id: 'tool.dustpan', name: 'Ki hốt rác', nameEn: 'Dustpan', category: 'care', place: 'surface', size: [0.26, 0.24] }),
  item({ id: 'tool.mop', name: 'Cây lau nhà', nameEn: 'Mop', category: 'care', place: 'surface', size: [0.3, 0.2] }),
  item({ id: 'tool.bucket', name: 'Xô nước', nameEn: 'Bucket', category: 'care', place: 'surface', size: [0.33, 0.33] }),
  item({ id: 'tool.cloth', name: 'Khăn lau', nameEn: 'Cleaning cloth', category: 'care', place: 'surface', size: [0.2, 0.15] }),
  item({ id: 'tool.duster', name: 'Chổi lông', nameEn: 'Feather duster', category: 'care', place: 'surface', size: [0.2, 0.2] }),
  item({ id: 'tool.webbrush', name: 'Chổi cán dài', nameEn: 'Long brush', category: 'care', place: 'surface', size: [0.24, 0.24] }),
  item({ id: 'bin.trash', name: 'Thùng rác', nameEn: 'Bin', category: 'care', place: 'surface', size: [0.36, 0.36] }),
  item({ id: 'rack.cleaning', name: 'Giá dụng cụ', nameEn: 'Cleaning rack', category: 'care', place: 'floor', size: [1.02, 0.36] }),
  item({ id: 'sink.utility', name: 'Bồn rửa', nameEn: 'Utility sink', category: 'care', place: 'floor', size: [0.54, 0.46] }),
  item({ id: 'can.watering', name: 'Bình tưới', nameEn: 'Watering can', category: 'care', place: 'surface', size: [0.2, 0.45] }),
  item({ id: 'bulb.spare', name: 'Bóng đèn dự phòng', nameEn: 'Spare bulb', category: 'care', place: 'surface', size: [0.07, 0.07] }),
  item({ id: 'trash.paper', name: 'Giấy vo tròn', nameEn: 'Crumpled paper', category: 'care', place: 'surface', size: [0.08, 0.08], unlisted: true }),
  item({ id: 'trash.bag', name: 'Túi rác', nameEn: 'Rubbish bag', category: 'care', place: 'surface', size: [0.34, 0.34], unlisted: true }),
];

export const CATALOG_BY_ID: Record<string, CatalogItem> = Object.fromEntries(CATALOG.map((i) => [i.id, i]));

export const CATEGORY_LABEL: Record<CatalogCategory, string> = {
  furniture: 'Nội thất',
  decor: 'Trang trí',
  lighting: 'Ánh sáng',
  plants: 'Cây xanh',
  study: 'Công cụ học tập',
  clock: 'Đồng hồ',
  sound: 'Âm thanh',
  care: 'Dọn dẹp',
};

export const ACTION_LABEL: Record<ActionId, string> = {
  'open:focus': 'Mở đồng hồ tập trung',
  'open:planner': 'Mở kế hoạch',
  'open:notebook': 'Mở sổ ghi chú',
  'open:research': 'Mở góc nghiên cứu',
  'open:ambient': 'Mở âm thanh nền',
  'open:character': 'Tùy chỉnh nhân vật',
  'toggle:music': 'Phát hoặc dừng nhạc',
  'route:reading': 'Đi tới Đọc',
  'route:mybooks': 'Đi tới Sách của tôi',
  'route:listening': 'Đi tới Nghe',
  'route:speaking': 'Đi tới Luyện nói',
  'route:writing': 'Đi tới Viết',
  'route:flashcards': 'Đi tới Thẻ từ vựng',
  'route:grammar': 'Đi tới Ngữ pháp',
  'route:path': 'Đi tới Lộ trình học',
  'route:progress': 'Đi tới Tiến trình học tập',
  'route:exams': 'Đi tới Thi thử',
  'route:games': 'Đi tới Trò chơi',
  'route:dictionary': 'Mở từ điển',
  'character:sit': 'Nhân vật ngồi vào đây',
  'character:sleep': 'Nhân vật nghỉ ngơi',
  'character:read': 'Nhân vật đọc sách',
  none: 'Không làm gì',
};

/** The real English Coach routes behind `route:*` actions. */
export const ROUTE_OF: Partial<Record<ActionId, string>> = {
  'route:reading': '/reading',
  'route:mybooks': '/reading',
  'route:listening': '/listening',
  'route:speaking': '/speaking',
  'route:writing': '/writing',
  'route:flashcards': '/flashcards',
  'route:grammar': '/grammar',
  'route:path': '/learning-path',
  'route:progress': '/progress',
  'route:exams': '/exams',
  'route:games': '/games',
};
