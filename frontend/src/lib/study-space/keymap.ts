import type { RotationAxis3D } from './orientation';

/**
 * The keyboard of the room, in one table: what each shortcut does, the key it starts on, and the owner's own choice over it. WASD, Shift,
 * Space, Esc and the gesture digits are the body's own and stay out of this table, so nothing here can take them away. Nothing here fires
 * while a text field has the focus: the world only listens when the canvas does. The camera, the bars, settings, help and mouse-look keys are the same in
 * Speaking Arena and Echo Quiz Rush (`lib/hud/sharedKeys.ts`), so one change here is one change everywhere.
 */
export type Shortcut =
  | 'camera'
  | 'focus'
  | 'wardrobe'
  | 'quick'
  | 'actions'
  | 'hud'
  | 'settings'
  | 'help'
  | 'cancel'
  | 'use-held'
  | 'rotate-axis'
  | 'drop'
  | 'effort'
  | 'mouse'
  | 'arena'
  | 'games'
  | 'planner'
  | 'sense';

export const SHORTCUTS: { id: Shortcut; key: string; vi: string; en: string }[] = [
  { id: 'camera', key: 'KeyV', vi: 'Đổi góc nhìn', en: 'Switch camera' },
  { id: 'focus', key: 'KeyF', vi: 'Tập trung', en: 'Focus' },
  { id: 'wardrobe', key: 'KeyB', vi: 'Tủ đồ', en: 'Wardrobe' },
  { id: 'quick', key: 'KeyQ', vi: 'Thao tác nhanh', en: 'Quick actions' },
  { id: 'actions', key: 'KeyI', vi: 'Vòng hành động', en: 'Action wheel' },
  { id: 'hud', key: 'KeyU', vi: 'Ẩn hoặc hiện thanh công cụ', en: 'Hide or show the bar' },
  { id: 'settings', key: 'KeyO', vi: 'Mở cài đặt', en: 'Open settings' },
  { id: 'help', key: 'KeyK', vi: 'Cách điều khiển', en: 'Show the controls' },
  { id: 'cancel', key: 'KeyX', vi: 'Hủy việc đang làm', en: 'Cancel what is happening' },
  { id: 'use-held', key: 'KeyR', vi: 'Dùng vật đang cầm hoặc dựng đứng lại', en: 'Use held item or stand upright' },
  { id: 'rotate-axis', key: 'KeyZ', vi: 'Đổi trục xoay 3D (X / Y / Z)', en: 'Cycle 3D rotation axis (X / Y / Z)' },
  { id: 'drop', key: 'KeyY', vi: 'Thả vật đang cầm', en: 'Let go of it' },
  // Held when pushing heavy furniture; toggles the 3D rotation and translation gizmo when carrying or editing.
  { id: 'effort', key: 'KeyT', vi: 'Dồn sức đẩy (giữ) hoặc mở vòng xoay 3D', en: 'Put weight in (hold) or toggle 3D gizmo' },
  { id: 'mouse', key: 'KeyM', vi: 'Nhìn bằng chuột', en: 'Mouse look' },
  { id: 'arena', key: 'KeyN', vi: 'Tới Speaking Arena', en: 'Go to Speaking Arena' },
  { id: 'games', key: 'KeyJ', vi: 'Tới phòng trò chơi', en: 'Go to Games' },
  { id: 'planner', key: 'KeyP', vi: 'Kế hoạch', en: 'Planner' },
  { id: 'sense', key: 'KeyL', vi: 'Soi chỗ còn bẩn', en: 'Show what is still dirty' },
];

export const AXIS_META_3D: Record<
  RotationAxis3D,
  { axis: RotationAxis3D; code: 'X' | 'Y' | 'Z'; color: string; vi: string; en: string; shortVi: string; shortEn: string }
> = {
  x: {
    axis: 'x',
    code: 'X',
    color: '#ff5c6c',
    vi: 'Trục X · Nghiêng trước sau',
    en: 'X axis · Pitch',
    shortVi: 'Nghiêng trước sau',
    shortEn: 'Pitch',
  },
  y: {
    axis: 'y',
    code: 'Y',
    color: '#34d399',
    vi: 'Trục Y · Xoay ngang',
    en: 'Y axis · Yaw',
    shortVi: 'Xoay ngang',
    shortEn: 'Yaw',
  },
  z: {
    axis: 'z',
    code: 'Z',
    color: '#38bdf8',
    vi: 'Trục Z · Nghiêng trái phải',
    en: 'Z axis · Roll',
    shortVi: 'Nghiêng trái phải',
    shortEn: 'Roll',
  },
};

export const MANIPULATION_HINTS = {
  cycleAxis: { vi: 'Đổi trục xoay X / Y / Z', en: 'Cycle X / Y / Z axis' },
  resetUpright: { vi: 'Dựng đứng lại', en: 'Stand upright' },
  toggleGizmo: { vi: 'Vòng xoay và dịch chuyển 3D', en: '3D rotate and move gizmo' },
  turnStep: { vi: 'Xoay trên trục đang chọn (giữ Alt để xoay mịn)', en: 'Rotate on active axis (hold Alt for fine step)' },
  reachDistance: { vi: 'Giữ Shift và lăn chuột để đưa xa hoặc gần', en: 'Hold Shift and scroll to adjust distance' },
} as const;

const RESERVED = new Set([
  'KeyC', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyG', 'KeyH',
  'ShiftLeft', 'ShiftRight', 'Space', 'Escape',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter',
]);
const STORE = 'ec_study_keys:v1';
export type Keymap = Record<Shortcut, string>;

export const defaultKeymap = (): Keymap => Object.fromEntries(SHORTCUTS.map(s => [s.id, s.key])) as Keymap;
export function loadKeymap(): Keymap {
  const map = defaultKeymap();
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || '{}') as Record<string, unknown>;
    for (const s of SHORTCUTS) { const k = saved[s.id]; if (typeof k === 'string' && /^(Key[A-Z]|Digit[6-9]|F[1-9])$/.test(k) && !RESERVED.has(k)) map[s.id] = k; }
  } catch { /* the defaults stand */ }
  // A newly introduced shortcut must not shadow a learner's existing binding.
  const used = new Set<string>();
  const pool = [
    'KeyI', 'KeyQ', 'KeyF', 'KeyB', 'KeyU', 'KeyO', 'KeyK', 'KeyX', 'KeyR', 'KeyZ',
    'KeyY', 'KeyT', 'KeyM', 'KeyN', 'KeyJ', 'KeyP', 'KeyL', 'KeyV',
    'Digit6', 'Digit7', 'Digit8', 'Digit9',
  ];
  for (const s of SHORTCUTS.filter(s => s.id !== 'actions').concat(SHORTCUTS.filter(s => s.id === 'actions'))) {
    if (used.has(map[s.id])) map[s.id] = pool.find(k => !used.has(k) && !Object.entries(map).some(([id, v]) => id !== s.id && v === k)) ?? s.key;
    used.add(map[s.id]);
  }
  return map;
}
/** Swaps when the key is already in use: no key ever does two things. */
export function remap(map: Keymap, id: Shortcut, code: string): Keymap | null {
  if (RESERVED.has(code) || !/^(Key[A-Z]|Digit[6-9]|F[1-9])$/.test(code)) return null;
  const next = { ...map }, other = (Object.keys(map) as Shortcut[]).find(k => map[k] === code);
  if (other) next[other] = map[id];
  next[id] = code;
  try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* it holds for this visit */ }
  return next;
}
export function actionForKey(map: Keymap, code: string): Shortcut | null {
  return (Object.keys(map) as Shortcut[]).find(k => map[k] === code) ?? null;
}
export const keyLabel = (code: string) => code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5) : code;
