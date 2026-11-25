import { CATALOG, CATALOG_BY_ID, type CatalogItem } from './catalog';

/**
 * What a thing in the room allows, from what it is, never from a list of showcase objects. Every catalogue row gets an answer: a row
 * added tomorrow with no entry here still gets one from its size, its place and its category. Pure data and pure logic: no three.js, no
 * physics, so the coverage can be checked in a test and the same answer drives the prompt, the mouse buttons and the world.
 */
export type ContactKind = 'wood' | 'metal' | 'glass' | 'ceramic' | 'paper' | 'cloth' | 'plastic';
export type GripKind = 'relaxed' | 'open' | 'flat' | 'loose' | 'fist' | 'handle' | 'cylinder' | 'pinch' | 'press' | 'book' | 'type';
export type Mobility = 'portable' | 'movable' | 'fixed';
export type SeatMobility = 'stationary' | 'rolling';

export function seatMobilityOf(kind: string | null | undefined): SeatMobility {
  return kind === 'chair.office' || kind === 'gaming-chair' ? 'rolling' : 'stationary';
}
export type Family =
  | 'tool' | 'waste' | 'fixture' | 'book' | 'paper' | 'cup' | 'stationery' | 'storage-box' | 'clock' | 'plant' | 'lamp' | 'ornament' | 'audio' | 'screen' | 'desk'
  | 'chair' | 'lounge' | 'bed' | 'shelf' | 'cabinet' | 'table' | 'rug' | 'board' | 'picture' | 'plush' | 'instrument' | 'door' | 'window' | 'curtain';

/** Things a body can do with a thing. Every verb here has one implementation in `world/manipulation.ts` (the test checks it). */
export type Verb =
  | 'pick' | 'take-one' | 'put-away' | 'place' | 'drop' | 'throw' | 'inspect'
  | 'push' | 'sit' | 'lie' | 'stand' | 'right-upright'
  | 'open' | 'close' | 'pass'
  | 'switch' | 'lid' | 'power' | 'use'
  | 'drink' | 'refill' | 'read' | 'turn-page' | 'write' | 'spin' | 'flip' | 'straighten' | 'look-through' | 'stroke' | 'hug' | 'wear'
  | 'browse' | 'take-book' | 'put-back'
  | 'carry-tool' | 'work-tool' | 'hang' | 'dip' | 'wring' | 'fill' | 'pour' | 'rinse' | 'empty' | 'discard' | 'take-bag' | 'bag-out' | 'run-water' | 'change-bulb';

export interface Affordance {
  kind: string;
  family: Family;
  mobility: Mobility;
  /** Kilograms, as the real thing: heavy furniture moves slowly, a mug nearly weighs nothing. */
  mass: number;
  material: ContactKind;
  grip: GripKind;
  hands: 1 | 2;
  /** The collision shape of a carried thing. */
  shape: 'box' | 'cylinder' | 'sphere';
  /** Light enough to carry in both arms and also stands on the floor to be pushed or pulled along it. */
  pushable: boolean;
  /** Things rest on it (its `tops`, or a stable flat lid). */
  support: boolean;
  seat: boolean;
  seatMobility: SeatMobility;
  bed: boolean;
  /** What else it does, beyond being moved. */
  verbs: Verb[];
}

type Row = Partial<Omit<Affordance, 'kind'>>;
const small = (family: Family, material: ContactKind, grip: GripKind, mass: number, extra: Row = {}): Row => ({ family, material, grip, mass, mobility: 'portable', ...extra });

const TABLE: Record<string, Row> = {
  // Furniture
  'desk.corner': { family: 'desk', mass: 62, material: 'wood', mobility: 'movable', verbs: ['sit'] },
  'desk.basic': { family: 'desk', mass: 24, material: 'wood', mobility: 'movable', verbs: ['sit'] },
  'desk.wood': { family: 'desk', mass: 48, material: 'wood', mobility: 'movable', verbs: ['sit'] },
  'chair.office': { family: 'chair', mass: 13, material: 'plastic', mobility: 'portable', pushable: true, seat: true, seatMobility: 'rolling', verbs: ['sit'] },
  'chair.simple': { family: 'chair', mass: 6, material: 'wood', mobility: 'portable', pushable: true, seat: true, verbs: ['sit'] },
  'bed.single': { family: 'bed', mass: 70, material: 'cloth', mobility: 'movable', bed: true, seat: true, verbs: ['lie', 'sit'] },
  'bed.drawer': { family: 'bed', mass: 85, material: 'wood', mobility: 'movable', bed: true, seat: true, verbs: ['lie', 'sit'] },
  'shelf.tall': { family: 'shelf', mass: 34, material: 'wood', mobility: 'movable', verbs: ['browse'] },
  'shelf.wall': { family: 'shelf', mass: 4, material: 'wood', mobility: 'fixed', verbs: ['browse'] },
  nightstand: { family: 'cabinet', mass: 12, material: 'wood', mobility: 'portable', pushable: true },
  drawers: { family: 'cabinet', mass: 30, material: 'wood', mobility: 'movable' },
  'table.side': { family: 'table', mass: 7, material: 'wood', mobility: 'portable', pushable: true },
  armchair: { family: 'lounge', mass: 26, material: 'cloth', mobility: 'movable', seat: true, verbs: ['sit'] },
  sofa: { family: 'lounge', mass: 48, material: 'cloth', mobility: 'movable', seat: true, verbs: ['sit', 'lie'] },
  beanbag: { family: 'lounge', mass: 5, material: 'cloth', mobility: 'portable', pushable: true, shape: 'sphere', seat: true, verbs: ['sit'] },
  pouf: { family: 'lounge', mass: 4, material: 'cloth', mobility: 'portable', pushable: true, seat: true, support: true, verbs: ['sit'] },
  'rug.round': { family: 'rug', mass: 7, material: 'cloth', mobility: 'movable' },
  'rug.rect': { family: 'rug', mass: 8, material: 'cloth', mobility: 'movable' },
  'rug.cloud': { family: 'rug', mass: 6, material: 'cloth', mobility: 'movable' },
  whiteboard: { family: 'board', mass: 6, material: 'metal', mobility: 'fixed', verbs: ['write', 'straighten'] },
  pinboard: { family: 'board', mass: 3, material: 'wood', mobility: 'fixed', verbs: ['write', 'straighten'] },
  // Light
  'lamp.desk': small('lamp', 'metal', 'cylinder', .9, { verbs: ['switch'] }),
  'lamp.floor': { family: 'lamp', mass: 5, material: 'metal', mobility: 'portable', pushable: true, verbs: ['switch'] },
  'lamp.moon': small('lamp', 'plastic', 'cylinder', .5, { shape: 'sphere', verbs: ['switch'] }),
  'lamp.shell': small('lamp', 'ceramic', 'cylinder', .6, { verbs: ['switch'] }),
  'lamp.jelly': small('lamp', 'glass', 'cylinder', .6, { shape: 'sphere', verbs: ['switch'] }),
  'lamp.lantern': small('lamp', 'metal', 'handle', .8, { shape: 'cylinder', verbs: ['switch'] }),
  // Plants
  'plant.pothos': small('plant', 'ceramic', 'cylinder', 1.2, { shape: 'cylinder', verbs: ['stroke'] }),
  'plant.monstera': { family: 'plant', mass: 9, material: 'ceramic', mobility: 'portable', pushable: true, verbs: ['stroke'] },
  'plant.snake': { family: 'plant', mass: 6, material: 'ceramic', mobility: 'portable', pushable: true, verbs: ['stroke'] },
  'plant.succulent': small('plant', 'ceramic', 'cylinder', .4, { shape: 'cylinder', verbs: ['stroke'] }),
  'plant.hanging': { family: 'plant', mass: 1.5, material: 'ceramic', mobility: 'fixed', verbs: ['stroke'] },
  // Decor
  'art.whale': { family: 'picture', mass: 1, material: 'cloth', mobility: 'fixed', verbs: ['straighten'] },
  'art.sky': { family: 'picture', mass: 1.2, material: 'wood', mobility: 'fixed', verbs: ['straighten'] },
  'art.coral': { family: 'picture', mass: 1.2, material: 'wood', mobility: 'fixed', verbs: ['straighten'] },
  'art.leaf': { family: 'picture', mass: 1, material: 'wood', mobility: 'fixed', verbs: ['straighten'] },
  'art.photos': { family: 'picture', mass: .3, material: 'paper', mobility: 'fixed', verbs: ['straighten'] },
  'whale.plush': small('plush', 'cloth', 'open', 1.1, { hands: 2, shape: 'sphere', verbs: ['hug', 'stroke'] }),
  lighthouse: small('ornament', 'ceramic', 'cylinder', .5, { shape: 'cylinder' }),
  coral: small('ornament', 'ceramic', 'cylinder', .4),
  globe: small('instrument', 'plastic', 'cylinder', .9, { shape: 'sphere', verbs: ['spin'] }),
  telescope: { family: 'instrument', mass: 5, material: 'metal', mobility: 'portable', pushable: true, verbs: ['look-through'] },
  rocket: small('ornament', 'metal', 'cylinder', .4, { shape: 'cylinder' }),
  crystal: small('ornament', 'glass', 'cylinder', .7),
  // Study
  laptop: small('screen', 'metal', 'book', 1.4, { verbs: ['use', 'lid'] }),
  monitor: { family: 'screen', mass: 5, material: 'plastic', mobility: 'portable', hands: 2, verbs: ['use', 'power'] },
  'pc.tower': { family: 'screen', mass: 8, material: 'metal', mobility: 'portable', hands: 2, grip: 'handle', support: true },
  keyboard: small('stationery', 'plastic', 'book', .9),
  'mouse.pc': small('stationery', 'plastic', 'loose', .1),
  'books.stack': small('book', 'paper', 'book', 1.8, { verbs: ['take-one', 'use'], support: true }),
  'books.row': small('book', 'paper', 'book', 2.4, { hands: 2, verbs: ['take-one', 'use'] }),
  'book.single': small('book', 'paper', 'book', .45, { verbs: ['read'], support: true }),
  notebook: small('book', 'paper', 'book', .35, { verbs: ['read', 'write'], support: true }),
  dictionary: small('book', 'paper', 'book', 1.4, { verbs: ['use'], support: true }),
  pencup: small('stationery', 'ceramic', 'cylinder', .3, { shape: 'cylinder', verbs: ['use'] }),
  flashbox: small('storage-box', 'plastic', 'book', .5, { verbs: ['use'], support: true }),
  'docs.stack': small('paper', 'paper', 'book', .5, { verbs: ['read', 'use'], support: true }),
  'calendar.desk': small('paper', 'paper', 'pinch', .2, { verbs: ['use'] }),
  mug: small('cup', 'ceramic', 'handle', .32, { shape: 'cylinder', verbs: ['drink', 'refill'] }),
  'kettle.vintage': small('cup', 'metal', 'handle', 1.05, { shape: 'cylinder', verbs: ['switch'] }),
  teapot: small('cup', 'ceramic', 'handle', .62, { shape: 'cylinder' }),
  teacup: small('cup', 'ceramic', 'pinch', .14, { shape: 'cylinder', verbs: ['drink'] }),
  saucer: small('ornament', 'ceramic', 'pinch', .12, { shape: 'cylinder', support: true }),
  'can.watering': small('cup', 'metal', 'handle', .85, { shape: 'cylinder' }),
  'bulb.spare': small('ornament', 'glass', 'pinch', .04, { shape: 'sphere' }),
  'plant.terracotta': small('plant', 'ceramic', 'cylinder', 3.4, { hands: 2, shape: 'cylinder', verbs: ['stroke'] }),
  // Clocks
  'clock.desk': small('clock', 'plastic', 'cylinder', .4, { verbs: ['use'] }),
  'clock.wall': { family: 'clock', mass: 1, material: 'wood', mobility: 'fixed', verbs: ['use', 'straighten'] },
  'clock.digital': small('clock', 'plastic', 'book', .35, { verbs: ['use'] }),
  hourglass: small('clock', 'glass', 'cylinder', .5, { shape: 'cylinder', verbs: ['flip', 'use'] }),
  // Sound
  speaker: small('audio', 'plastic', 'book', 1.2, { verbs: ['use'] }),
  mic: small('audio', 'metal', 'cylinder', .7, { shape: 'cylinder', verbs: ['use'] }),
  headphones: small('audio', 'plastic', 'handle', .25, { verbs: ['wear', 'use'] }),
  radio: small('audio', 'wood', 'book', 1.3, { verbs: ['use'] }),
  // Cleaning. A long tool is taken by its handle in one hand and worked with both; the rest is in `lib/study-space/tools.ts`.
  'tool.broom': small('tool', 'wood', 'handle', .7, { shape: 'cylinder' }),
  'tool.mop': small('tool', 'wood', 'handle', 1.4, { shape: 'cylinder' }),
  'tool.webbrush': small('tool', 'metal', 'handle', .6, { shape: 'cylinder' }),
  'tool.duster': small('tool', 'wood', 'handle', .18, { shape: 'cylinder' }),
  'tool.dustpan': small('tool', 'plastic', 'handle', .35),
  'tool.cloth': small('tool', 'cloth', 'flat', .06),
  'tool.bucket': small('tool', 'metal', 'handle', 1.3, { shape: 'cylinder', support: false }),
  'bin.trash': small('waste', 'metal', 'handle', 1.6, { shape: 'cylinder', hands: 2, pushable: true }),
  'trash.paper': small('waste', 'paper', 'loose', .01, { shape: 'sphere' }),
  'trash.bag': small('waste', 'plastic', 'handle', 3.5, { shape: 'sphere' }),
  'rack.cleaning': { family: 'fixture', mass: 14, material: 'wood', mobility: 'movable' },
  'sink.utility': { family: 'fixture', mass: 40, material: 'ceramic', mobility: 'movable', verbs: ['run-water'] },
};

/** From what the catalogue says: this is what makes a new row work with no entry above. */
function derive(item: CatalogItem | undefined, kind: string): Row {
  if (!item) return { family: 'ornament', mobility: 'portable', mass: .5, material: 'plastic', grip: 'cylinder' };
  const area = item.size[0] * item.size[1];
  const family: Family = item.anchor ? (item.anchor.activity === 'sleep' ? 'bed' : 'chair') : item.flat ? 'rug' : item.category === 'lighting' ? 'lamp' : item.category === 'plants' ? 'plant' : item.category === 'clock' ? 'clock' : item.category === 'sound' ? 'audio' : item.tops ? 'table' : item.place === 'wall' ? 'picture' : 'ornament';
  const material: ContactKind = family === 'rug' || family === 'bed' ? 'cloth' : family === 'plant' ? 'ceramic' : family === 'table' ? 'wood' : 'plastic';
  if (item.place === 'wall') return { family, material, mobility: 'fixed', mass: 2, verbs: ['straighten'] };
  if (item.place === 'surface') return { family, material, mobility: 'portable', mass: Math.max(.15, area * 18), grip: item.size[1] < .14 ? 'cylinder' : 'book', verbs: item.light ? ['switch'] : item.action ? ['use'] : [] };
  return { family, material, mobility: 'movable', mass: Math.max(3, area * 30), seat: !!item.anchor && item.anchor.activity !== 'sleep', bed: item.anchor?.activity === 'sleep', verbs: [...(item.anchor ? ['sit' as Verb] : []), ...(item.light ? ['switch' as Verb] : []), ...(item.action ? ['use' as Verb] : [])] };
}

const cache = new Map<string, Affordance>();
export function affordanceOf(kind: string): Affordance {
  const hit = cache.get(kind);
  if (hit) return hit;
  const item = CATALOG_BY_ID[kind];
  const row = TABLE[kind] ?? derive(item, kind);
  const a: Affordance = {
    kind, family: row.family ?? 'ornament', mobility: row.mobility ?? 'portable', mass: row.mass ?? .5, material: row.material ?? 'plastic',
    grip: row.grip ?? (row.mobility === 'movable' || row.pushable ? 'handle' : 'cylinder'), hands: row.hands ?? (row.mobility === 'movable' || row.pushable ? 2 : 1), shape: row.shape ?? 'box', pushable: row.pushable ?? false,
    support: row.support ?? !!item?.tops, seat: row.seat ?? false, seatMobility: row.seatMobility ?? seatMobilityOf(kind), bed: row.bed ?? false, verbs: row.verbs ?? [],
  };
  cache.set(kind, a);
  return a;
}

/** How a body takes hold of something this size: fingers round it, from above, by the edge, or both hands. */
export type GraspStyle = 'wrap' | 'top' | 'edge' | 'both';
export function graspFor(a: Affordance, size: [number, number, number]): GraspStyle {
  const [w, h, d] = size, wide = Math.max(w, d), narrow = Math.min(w, d);
  if (a.hands === 2) return 'both';
  if (h < .05) return 'edge';
  if (wide > .42) return 'both';
  if (narrow <= .11) return 'wrap';
  if (h < narrow * .7) return 'top';
  return narrow <= .17 ? 'wrap' : 'both';
}

export interface ActContext {
  /** Free hands right now. */
  free: number;
  held: string[];
  seated: boolean;
  lying: boolean;
  /** This very thing is the seat under the body. */
  onThis: boolean;
  on?: boolean;
  open?: boolean;
  /** How many can still be taken out of a row or a stack. */
  countLeft?: number;
  sipsLeft?: number;
  /** The accessory is on the head already. */
  wearing?: boolean;
  /** This thing is inside an open drawer. */
  stored?: boolean;
  /** Something is in the hands and the eyes are on a place it could go. */
  canPlace?: boolean;
  canStore?: boolean;
  /** A desk with a chair at it: false when there is none. */
  chairNear?: boolean;
  /** True when the body is already seated on the chair paired with this desk. */
  atThisDesk?: boolean;
  /** Tool behind it, from the catalogue or the learner's own choice. */
  hasTool?: boolean;
  /** A bin with no room left in it. */
  full?: boolean;
  /** Physical seat validation (`seatValidation.ts`): false when tilted, moving, unsupported, obstructed, or blocked. */
  seatValid?: boolean;
  /** True when a portable chair/object is tilted or fallen (`seatUp.y < MIN_SEAT_UPRIGHT_DOT`). */
  tipped?: boolean;
}
export interface Act { verb: Verb; key?: string; vi: string; en: string; blocked?: boolean; hint?: { vi: string; en: string } }

const ACT: Record<Verb, [string, string]> = {
  'carry-tool': ['Mang dụng cụ', 'Carry tool'], 'work-tool': ['Dùng dụng cụ', 'Use tool'],
  pick: ['Cầm lên', 'Pick up'], 'take-one': ['Lấy một cuốn', 'Take one'], 'put-away': ['Cất vào ngăn kéo', 'Put in the drawer'], place: ['Đặt xuống đây', 'Put it here'], drop: ['Thả xuống', 'Let go'], throw: ['Ném', 'Throw'], inspect: ['Xem kỹ', 'Look closer'],
  browse: ['Chọn sách', 'Choose a book'], hang: ['Treo lại lên giá', 'Hang it back'], dip: ['Nhúng vào xô', 'Dip it in the bucket'], wring: ['Vắt', 'Wring it'], fill: ['Hứng nước', 'Fill it'], pour: ['Đổ nước đi', 'Pour it out'], rinse: ['Giặt dưới vòi', 'Rinse it'], empty: ['Đổ vào thùng', 'Empty it in'], discard: ['Bỏ vào thùng', 'Throw it in'], 'take-bag': ['Buộc túi, lấy ra', 'Tie the bag, take it out'], 'bag-out': ['Mang ra ngoài', 'Take it outside'], 'run-water': ['Mở vòi', 'Run the water'], 'change-bulb': ['Thay bóng đèn', 'Change the bulb'], 'take-book': ['Lấy cuốn này', 'Take this book'], 'put-back': ['Cất lại lên kệ', 'Put it back on the shelf'],
  push: ['Đẩy, kéo', 'Push, pull'], sit: ['Ngồi xuống', 'Sit down'], lie: ['Nằm xuống', 'Lie down'], stand: ['Đứng dậy', 'Stand up'], 'right-upright': ['Dựng đứng lại', 'Stand upright'],
  open: ['Mở ra', 'Open'], close: ['Đóng lại', 'Close'], pass: ['Đi qua cửa', 'Go through'],
  switch: ['Bật đèn', 'Switch on'], lid: ['Mở nắp máy', 'Open the lid'], power: ['Bật màn hình', 'Turn on'], use: ['Dùng', 'Use'],
  drink: ['Uống một ngụm', 'Take a sip'], refill: ['Rót thêm', 'Refill'], read: ['Mở ra đọc', 'Open and read'], 'turn-page': ['Lật trang', 'Turn the page'], write: ['Viết', 'Write'], spin: ['Xoay', 'Spin'], flip: ['Lật ngược', 'Turn over'], straighten: ['Chỉnh lại', 'Straighten'], 'look-through': ['Nhìn qua kính', 'Look through'], stroke: ['Vuốt nhẹ', 'Touch'], hug: ['Ôm vào lòng', 'Hug'], wear: ['Đeo vào', 'Put on'],
};
const act = (verb: Verb, vi?: string, en?: string, key?: string): Act => ({
  verb,
  ...(key ? { key } : verb === 'right-upright' ? { key: 'KeyE' } : {}),
  vi: vi ?? ACT[verb][0],
  en: en ?? ACT[verb][1],
});
export const actOf = act;

/**
 * What can be done right now, best first. [0] answers the left button, [1] the right button, all of them appear in the quick menu.
 * A hand that is full, a body that is sitting, a lamp that is already on: the answer changes with what is true now.
 */
export function actsFor(kind: string, ctx: ActContext): Act[] {
  const out: Act[] = [];
  const a = affordanceOf(kind);
  const oneFree = ctx.free >= 1, bothFree = ctx.free >= 2;

  if (kind === 'door') {
    out.push(ctx.open ? act('close') : act('open'));
    if (ctx.open && !ctx.seated) out.push(act('pass'));
    else out.push(act('pass'));
    return out;
  }
  if (kind === 'shelfbook') {
    out.push(oneFree ? act('take-book') : { ...act('take-book'), blocked: true, hint: { vi: 'Hai tay đang bận', en: 'Both hands are full' } });
    return out;
  }
  if (kind === 'drawer' || kind === 'window' || kind === 'curtain') {
    if (ctx.canStore && kind === 'drawer' && ctx.open) out.push(act('put-away'));
    out.push(ctx.open ? act('close', kind === 'curtain' ? 'Kéo rèm lại' : undefined, kind === 'curtain' ? 'Draw the curtain' : undefined) : act('open', kind === 'curtain' ? 'Kéo rèm ra' : undefined, kind === 'curtain' ? 'Pull the curtain back' : undefined));
    return out;
  }
  // Tipped portable objects/chairs: stand upright [0] + pick up [1]; suppress sit, lie, and push while fallen.
  if (ctx.tipped && a.mobility === 'portable') {
    const rightAct = act('right-upright', 'Dựng đứng lại', 'Stand upright', 'KeyE');
    out.push(oneFree ? rightAct : { ...rightAct, blocked: true, hint: { vi: 'Hai tay đang bận', en: 'Both hands are full' } });
    const lift = a.hands === 2 ? bothFree : oneFree;
    out.push(lift ? act('pick') : { ...act('pick'), blocked: true, hint: a.hands === 2 && oneFree ? { vi: 'Vật này cần cả hai tay', en: 'This takes both hands' } : { vi: 'Hai tay đang bận', en: 'Both hands are full' } });
    if (ctx.canPlace && ctx.held.length) out.push(act('place'));
    return out;
  }
  // Something in the hands and a place to put it comes first: that is what the hands are asking.
  if (ctx.canPlace && ctx.held.length) out.push(act('place'));
  const canUseSeat = !ctx.onThis && ctx.seatValid !== false && !ctx.tipped;
  if (a.bed && canUseSeat) out.push(act('lie'));
  if (a.seat && canUseSeat) {
    out.push(act('sit'));
    if (!a.bed && a.verbs.includes('lie')) out.push(act('lie'));
  }
  if (a.family === 'desk' && !ctx.onThis) {
    if (ctx.seated && ctx.atThisDesk) out.push(act('stand'));
    else out.push(ctx.chairNear === false || ctx.seatValid === false ? act('sit', 'Đứng vào bàn', 'Stand at the desk') : act('sit', 'Ngồi vào bàn', 'Sit at the desk'));
  }
  if (ctx.onThis) out.push(act('stand'));
  if (a.verbs.includes('browse')) out.push(act('browse'));
  if (a.verbs.includes('run-water')) out.push(act('run-water'));
  if (kind === 'bin.trash' && ctx.full) out.push(oneFree ? act('take-bag') : { ...act('take-bag'), blocked: true, hint: { vi: 'Hai tay đang bận', en: 'Both hands are full' } });
  if (a.verbs.includes('switch') && kind !== 'kettle.vintage') out.push(ctx.on === false ? act('switch') : act('switch', 'Tắt đèn', 'Switch off'));
  // A screen and a sound system are for using: lifting them comes second.
  const usedFirst = (a.family === 'screen' || (a.family === 'audio' && !a.verbs.includes('wear'))) && (ctx.hasTool || a.verbs.includes('use'));
  if (usedFirst) out.push(act('use'));
  if (a.mobility === 'portable') {
    if (a.verbs.includes('take-one') && (ctx.countLeft ?? 0) > 1) out.push(oneFree ? act('take-one') : { ...act('take-one'), blocked: true, hint: { vi: 'Hai tay đang bận', en: 'Both hands are full' } });
    const lift = a.hands === 2 ? bothFree : oneFree;
    out.push(lift ? act('pick') : { ...act('pick'), blocked: true, hint: a.hands === 2 && oneFree ? { vi: 'Vật này cần cả hai tay', en: 'This takes both hands' } : { vi: 'Hai tay đang bận', en: 'Both hands are full' } });
  }
  // A kettle is picked up first; its switch is the other button.
  if (kind === 'kettle.vintage') out.push(ctx.on ? act('switch', 'Tắt ấm', 'Switch it off') : act('switch', 'Đun nước', 'Boil it'));
  if (a.verbs.includes('lid')) out.push(ctx.open === false ? act('lid') : act('lid', 'Gập nắp máy', 'Close the lid'));
  if (a.verbs.includes('power')) out.push(ctx.on === false ? act('power') : act('power', 'Tắt màn hình', 'Turn off'));
  if (a.verbs.includes('spin')) out.push(act('spin'));
  if (a.verbs.includes('flip')) out.push(act('flip'));
  if (a.verbs.includes('look-through')) out.push(act('look-through'));
  if (a.verbs.includes('stroke')) out.push(act('stroke'));
  if (a.verbs.includes('hug')) out.push(act('hug'));
  if (a.verbs.includes('wear') && !ctx.wearing) out.push(act('wear'));
  if (a.verbs.includes('wear') && ctx.wearing) out.push(act('wear', 'Tháo ra', 'Take off'));
  if (a.verbs.includes('write')) out.push(act('write'));
  if (a.verbs.includes('straighten')) out.push(act('straighten'));
  if (!usedFirst && (ctx.hasTool || a.verbs.includes('use'))) out.push(act('use'));
  if (!ctx.tipped && (a.mobility === 'movable' || a.pushable)) out.push(bothFree && !ctx.seated ? act('push') : { ...act('push'), blocked: true, hint: ctx.seated ? { vi: 'Đứng dậy trước đã', en: 'Stand up first' } : { vi: 'Cần cả hai tay', en: 'Takes both hands' } });
  return out;
}

/** What the thing in the hand itself can do, wherever the eyes are. */
export function heldActs(kind: string, ctx: { reading?: boolean; sipsLeft?: number; inspecting?: boolean; wearing?: boolean; toolMode?: 'working' | 'carrying' }): Act[] {
  const a = affordanceOf(kind), out: Act[] = [];
  if (ctx.toolMode) out.push(act(ctx.toolMode === 'working' ? 'carry-tool' : 'work-tool'));
  if (ctx.reading) out.push(act('turn-page'));
  if (a.verbs.includes('drink')) out.push((ctx.sipsLeft ?? 4) > 0 ? act('drink') : a.verbs.includes('refill') ? act('refill') : act('pour', 'Rót', 'Pour'));
  // What holds a liquid pours, wherever the eyes are: over what they are on, or on the floor.
  if (a.family === 'cup' && (ctx.sipsLeft ?? 1) > 0) out.push(act('pour', 'Rót', 'Pour'));
  if (a.verbs.includes('read') && !ctx.reading) out.push(act('read'));
  if (a.verbs.includes('flip')) out.push(act('flip'));
  if (a.verbs.includes('hug')) out.push(act('hug'));
  if (a.verbs.includes('wear')) out.push(ctx.wearing ? act('wear', 'Tháo ra', 'Take off') : act('wear'));
  out.push(ctx.inspecting ? act('inspect', 'Thôi xem', 'Stop looking') : act('inspect'));
  out.push(act('drop'), act('throw'));
  return out;
}

/** Every kind in the room answers something: used by the coverage test and the world's own debug panel. */
export function coverage() {
  const families = new Set<string>(), combos = new Set<string>();
  const contexts: ActContext[] = [
    { free: 2, held: [], seated: false, lying: false, onThis: false, on: true, open: false, countLeft: 4, sipsLeft: 3, hasTool: false },
    { free: 2, held: [], seated: false, lying: false, onThis: false, on: false, open: true, countLeft: 1, sipsLeft: 0, wearing: true, hasTool: true },
    { free: 2, held: [], seated: true, lying: false, onThis: false, on: true, open: false, hasTool: true },
    { free: 2, held: [], seated: true, lying: false, onThis: true, on: true, open: false },
    { free: 1, held: ['mug'], seated: false, lying: false, onThis: false, canPlace: true, on: true, open: true },
    { free: 0, held: ['mug', 'notebook'], seated: false, lying: false, onThis: false, canPlace: true, on: false, open: false },
    { free: 2, held: [], seated: false, lying: true, onThis: true },
  ];
  for (const { id } of CATALOG) {
    families.add(affordanceOf(id).family);
    contexts.forEach((c, n) => actsFor(id, c).forEach(x => { if (!x.blocked) combos.add(`${id}/${x.verb}/${x.vi}/${n}`); }));
    for (const reading of [false, true]) heldActs(id, { reading }).forEach(x => { if (affordanceOf(id).mobility === 'portable') combos.add(`${id}/held:${x.verb}/${reading}`); });
  }
  for (const part of ['door', 'drawer', 'window', 'curtain']) {
    families.add(part);
    contexts.forEach((c, n) => actsFor(part, c).forEach(x => combos.add(`${part}/${x.verb}/${x.vi}/${n}`)));
  }
  return { kinds: CATALOG.length, families: families.size, combos: combos.size };
}
