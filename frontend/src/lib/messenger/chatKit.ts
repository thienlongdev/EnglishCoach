import type { MessengerPerson, ThemeId } from '@/types/messenger';
import type { PendingFile } from './store';

/**
 * Small things the Messenger's screens share: the conversation themes, how "last active" is said, the emoji a picker offers, and how a file chosen or pasted is
 * prepared on this device before anything is sent. Nothing here asks the server anything.
 */

// ── Themes: CSS only (messenger.module.css, [data-theme]); these are their names and the swatch a picker shows ─────────────
export const THEMES: { id: ThemeId; vi: string; en: string; swatch: string }[] = [
  { id: 'pearl', vi: 'Ngọc trai', en: 'Pearl', swatch: 'linear-gradient(135deg,#ffffff,#dbeafe 55%,#0e7490)' },
  { id: 'ocean', vi: 'Đại dương Echo', en: 'Echo Ocean', swatch: 'linear-gradient(135deg,#cffafe,#38bdf8 50%,#1d4ed8)' },
  { id: 'abyss', vi: 'Vực sâu', en: 'Deep Abyss', swatch: 'linear-gradient(135deg,#020617,#0c4a6e 60%,#22d3ee)' },
  { id: 'aurora', vi: 'Cực quang', en: 'Aurora', swatch: 'linear-gradient(135deg,#a7f3d0,#22d3ee 45%,#8b5cf6)' },
  { id: 'lavender', vi: 'Oải hương', en: 'Lavender', swatch: 'linear-gradient(135deg,#f5f3ff,#c4b5fd 55%,#7c3aed)' },
  { id: 'sunset', vi: 'Hoàng hôn', en: 'Warm Sunset', swatch: 'linear-gradient(135deg,#fef3c7,#fb923c 50%,#e11d48)' },
  { id: 'mint', vi: 'Bạc hà', en: 'Mint', swatch: 'linear-gradient(135deg,#f0fdf4,#6ee7b7 55%,#059669)' },
  { id: 'rose', vi: 'Hồng phấn', en: 'Rose', swatch: 'linear-gradient(135deg,#fff1f2,#fda4af 55%,#db2777)' },
  { id: 'midnight', vi: 'Đêm tối giản', en: 'Minimal Dark', swatch: 'linear-gradient(135deg,#0f172a,#334155 60%,#94a3b8)' },
  { id: 'sand', vi: 'Cát ấm', en: 'Warm Sand', swatch: 'linear-gradient(135deg,#fefce8,#fcd9a5 55%,#b45309)' },
];
export const themeName = (id: string | undefined, vi: boolean) => { const t = THEMES.find(x => x.id === id) ?? THEMES[0]; return vi ? t.vi : t.en; };

// ── Activity: counted in the server's time, said in the product's words ──────────────────────────────────────────────────
/** "Đang hoạt động", "Hoạt động 5 phút trước", …, or nothing (not allowed to see it, or more than seven days ago). `now`: this device's clock plus the server's skew. */
export function activityLine(p: Pick<MessengerPerson, 'online' | 'lastActiveAt'> | null | undefined, vi: boolean, now: number): string | null {
  if (!p) return null;
  if (p.online) return vi ? 'Đang hoạt động' : 'Active now';
  if (!p.lastActiveAt) return null;
  const minutes = Math.max(0, Math.floor((now - new Date(p.lastActiveAt).getTime()) / 60000));
  if (minutes >= 7 * 24 * 60) return null;
  if (minutes < 1) return vi ? 'Vừa mới hoạt động' : 'Active just now';
  if (minutes < 60) return vi ? `Hoạt động ${minutes} phút trước` : `Active ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return vi ? `Hoạt động ${hours} giờ trước` : `Active ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return vi ? `Hoạt động ${days} ngày trước` : `Active ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

// ── Emoji: the system's own glyphs, no image set to download ────────────────────────────────────────────────────────────
export const QUICK_REACTIONS = ['❤️', '😆', '😮', '😢', '😡', '👍'];
export const EMOJI_GROUPS: { id: string; vi: string; en: string; icon: string; items: string }[] = [
  { id: 'smileys', vi: 'Mặt cười', en: 'Smileys', icon: '😀', items: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾' },
  { id: 'people', vi: 'Cử chỉ', en: 'Gestures', icon: '👋', items: '👋 🤚 🖐️ ✋ 🖖 👌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾 👀 👁️ 🧠 🫶 💅 🤳 🙋 🙆 🙅 🤷 🤦 🙇 💁 🧑‍🎓 🧑‍🏫 🧑‍💻 👨‍👩‍👧 🧑‍🤝‍🧑 👫 💃 🕺 🏃 🚶 🧘' },
  { id: 'hearts', vi: 'Trái tim', en: 'Hearts', icon: '❤️', items: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💌 💋 💯 💢 💥 💫 💦 💨 🔥 ⭐ 🌟 🎉 🎊 🎈 🎁 🏆 🥇 🥈 🥉 🏅 🎖️ ✅ ❌ ❓ ❗ 💤 💬 💭' },
  { id: 'nature', vi: 'Thiên nhiên', en: 'Nature', icon: '🐳', items: '🐳 🐋 🐬 🐟 🐠 🐡 🦈 🐙 🦑 🦀 🐚 🪸 🐢 🐧 🦭 🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐤 🦆 🦉 🦋 🐝 🐞 🌸 🌺 🌻 🌹 🌷 🌱 🌿 🍀 🌳 🌴 🌵 🍁 🍂 🌊 🌈 ☀️ 🌤️ ⛅ 🌧️ ⛈️ ❄️ ☃️ 🌙 🌍 🪐 ⚡' },
  { id: 'food', vi: 'Ăn uống', en: 'Food', icon: '🍜', items: '🍜 🍲 🍚 🍙 🍣 🍤 🥟 🍱 🥢 🍞 🥖 🥐 🧀 🥚 🍳 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🥗 🍝 🍗 🍖 🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥑 🥕 🌽 🍰 🎂 🧁 🍩 🍪 🍫 🍬 🍭 🍦 ☕ 🍵 🧋 🥤 🧃 🍺 🍷 🥂' },
  { id: 'activity', vi: 'Hoạt động', en: 'Activities', icon: '⚽', items: '⚽ 🏀 🏐 🎾 🏸 🏓 🥊 🏊 🚴 🏋️ 🤸 🎮 🕹️ 🎲 🧩 ♟️ 🎯 🎨 🎬 🎤 🎧 🎼 🎹 🎸 🥁 🎻 📚 📖 📝 ✏️ 🖊️ 📒 📓 📕 📗 📘 📙 🎓 🧪 🔬 🔭 💡 🧮 🗓️ ⏰ ⏳ 📌 📎 🔖' },
  { id: 'travel', vi: 'Du lịch', en: 'Travel', icon: '✈️', items: '✈️ 🚀 🛸 🚁 ⛵ 🚤 🚢 🚗 🚕 🚌 🚆 🚇 🚲 🛵 🏍️ 🗺️ 🧭 🏝️ 🏖️ 🏔️ ⛰️ 🌋 🏕️ 🏠 🏡 🏫 🏢 🏥 🏦 🏰 🗼 🗽 ⛩️ 🌉 🎡 🎢 🌅 🌄 🌃 🌆' },
  { id: 'objects', vi: 'Đồ vật', en: 'Objects', icon: '💻', items: '💻 🖥️ ⌨️ 🖱️ 📱 ☎️ 📷 📸 🎥 📺 📻 🔋 🔌 💾 💿 🔍 🔑 🔒 🔓 🔔 🔕 📢 📣 💰 💳 💎 🛒 🎒 👓 🕶️ 👑 🧢 👕 👗 👟 ⌚ 💊 🩺 🧸 🪄 🧹 🛏️ 🛋️ 🚪 🪟 🕯️ 📦 ✉️ 📧 📨' },
];
/** A few words for the emoji people look for by name; the rest are found by looking. Folded, Vietnamese and English. */
const EMOJI_WORDS: Record<string, string> = {
  '😀': 'cuoi smile happy vui', '😂': 'cuoi khoc laugh cry haha', '🤣': 'cuoi lan lol rofl haha', '😊': 'cuoi smile blush', '😍': 'yeu love heart eyes thich', '🥰': 'yeu love thuong', '😘': 'hon kiss', '😎': 'ngau cool kinh', '🤔': 'nghi think hmm',
  '😢': 'buon sad khoc cry', '😭': 'khoc cry buon sad', '😡': 'gian angry tuc', '😱': 'so scared shock', '😴': 'ngu sleep buon ngu', '🥳': 'tiec party chuc mung', '😮': 'ngac nhien wow surprised', '🥺': 'xin please nan ni', '😅': 'ngai sweat', '🙄': 'chan roll eyes',
  '👍': 'thich like ok dong y yes', '👎': 'khong thich dislike no', '👏': 'vo tay clap gioi', '🙏': 'cam on thanks please xin', '💪': 'co len strong manh', '👋': 'chao hello hi bye', '🤝': 'bat tay deal handshake', '👌': 'ok tot', '✌️': 'peace hai',
  '❤️': 'tim heart yeu love do red', '💔': 'tan vo broken heart', '🔥': 'lua fire hot', '⭐': 'sao star', '🎉': 'chuc mung party congrats tada', '🎁': 'qua gift', '💯': 'tram diem 100 perfect', '✅': 'xong done check dung', '❌': 'sai wrong x no',
  '🐳': 'ca voi whale echo', '🐋': 'ca voi whale', '🐬': 'ca heo dolphin', '🌊': 'song bien wave ocean sea', '🌸': 'hoa flower', '☀️': 'nang sun', '🌙': 'trang moon dem night', '🌈': 'cau vong rainbow', '☕': 'ca phe coffee', '🍜': 'pho mi noodle',
  '📚': 'sach book hoc study', '📝': 'ghi chu note viet write', '🎓': 'tot nghiep graduate hoc', '💡': 'y tuong idea', '⏰': 'dong ho alarm gio time', '🎧': 'nghe listen tai nghe headphone', '🎤': 'noi speak mic hat sing', '💻': 'may tinh laptop computer', '🏆': 'cup trophy win thang',
  '😆': 'haha cuoi laugh', '🤩': 'tuyet wow star', '😇': 'ngoan angel', '😋': 'ngon yummy', '🤗': 'om hug', '😬': 'ngai awkward', '🤯': 'no nao mind blown', '😤': 'buc tuc', '🤡': 'he clown', '💀': 'chet dead skull', '🫶': 'yeu thuong love heart hands',
};
const foldWord = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
export function searchEmoji(query: string): string[] {
  const q = foldWord(query);
  if (!q) return [];
  const out: string[] = [];
  for (const [emoji, words] of Object.entries(EMOJI_WORDS)) if (words.split(' ').some(w => w.startsWith(q)) || words.includes(q)) out.push(emoji);
  for (const g of EMOJI_GROUPS) if (foldWord(g.vi).includes(q) || g.en.toLowerCase().includes(q)) for (const e of g.items.split(' ')) if (!out.includes(e)) out.push(e);
  return out.slice(0, 64);
}
const RECENT = (account: number) => `ec_msgr_emoji:v1:u${account}`;
export function recentEmoji(account: number): string[] {
  try { const list = JSON.parse(localStorage.getItem(RECENT(account)) || '[]'); return Array.isArray(list) ? list.filter(x => typeof x === 'string').slice(0, 16) : []; } catch { return []; }
}
export function rememberEmoji(account: number, emoji: string) {
  try { localStorage.setItem(RECENT(account), JSON.stringify([emoji, ...recentEmoji(account).filter(e => e !== emoji)].slice(0, 16))); } catch { /* A convenience only. */ }
}

// ── Files: what may go, and how a picture is made ready here ────────────────────────────────────────────────────────────
export const LIMITS = { images: 4, files: 2, image: 5 * 1024 * 1024, file: 10 * 1024 * 1024, message: 20 * 1024 * 1024 };
export const DOCUMENT_TYPES = ['pdf', 'txt', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'];
export const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,' + DOCUMENT_TYPES.map(e => '.' + e).join(',');
const PICTURES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const fileSize = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const extensionOf = (name: string) => { const dot = name.lastIndexOf('.'); return dot < 0 ? '' : name.slice(dot + 1).toLowerCase(); };

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
function draw(source: ImageBitmap, longEdge: number, background: string | null) {
  const scale = Math.min(1, longEdge / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale)); canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * A picture is redrawn on this device before it goes: turned the way the camera held it, at most 2560 px on its long edge, and without the data a camera hides in the
 * file (where and when it was taken). A screenshot stays a PNG while that is small enough; an animation is sent as it is. Its small preview is made here too.
 */
async function preparePicture(file: Blob, name: string): Promise<PendingFile> {
  const key = crypto.randomUUID();
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new Error('ATTACHMENT_NOT_ALLOWED'); }
  try {
    const thumbCanvas = draw(bitmap, 480, '#ffffff');
    const thumb = thumbCanvas ? await toBlob(thumbCanvas, 'image/jpeg', 0.8) : null;
    let blob: Blob = file, mime = file.type, width = bitmap.width, height = bitmap.height;
    if (file.type !== 'image/gif') {
      const full = draw(bitmap, 2560, null);
      if (full) {
        width = full.width; height = full.height;
        const png = file.type === 'image/png' ? await toBlob(full, 'image/png') : null;
        const made = png && png.size <= 3 * 1024 * 1024 ? png : await toBlob(draw(bitmap, 2560, '#ffffff') ?? full, 'image/jpeg', 0.88);
        if (made) { blob = made; mime = made.type; }
      }
    }
    if (blob.size > LIMITS.image) throw new Error('ATTACHMENT_TOO_LARGE');
    const base = name.replace(/\.[a-z0-9]+$/i, '') || 'image';
    const ext = mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'jpg';
    return { key, kind: 'IMAGE', name: `${base}.${ext}`, mime, size: blob.size, blob, thumb, url: URL.createObjectURL(blob), width, height };
  } finally { bitmap.close(); }
}

/** Makes a chosen, dropped or pasted file ready. Throws ATTACHMENT_NOT_ALLOWED / ATTACHMENT_TOO_LARGE for what the server would refuse anyway. */
export async function prepareFile(file: File): Promise<PendingFile> {
  if (PICTURES.includes(file.type)) return preparePicture(file, file.name || 'image');
  const ext = extensionOf(file.name);
  if (!DOCUMENT_TYPES.includes(ext)) throw new Error('ATTACHMENT_NOT_ALLOWED');
  if (file.size > LIMITS.file) throw new Error('ATTACHMENT_TOO_LARGE');
  if (file.size === 0) throw new Error('ATTACHMENT_EMPTY');
  return { key: crypto.randomUUID(), kind: 'FILE', name: file.name, mime: file.type || 'application/octet-stream', size: file.size, blob: file, thumb: null, url: null, width: null, height: null };
}

/** Why these files cannot all go in one message, or null. */
export function overLimit(files: Pick<PendingFile, 'kind' | 'size'>[]): 'ATTACHMENT_TOO_MANY' | 'ATTACHMENT_TOO_LARGE' | null {
  const images = files.filter(f => f.kind === 'IMAGE').length;
  if (images > LIMITS.images || files.length - images > LIMITS.files) return 'ATTACHMENT_TOO_MANY';
  if (files.reduce((n, f) => n + f.size, 0) > LIMITS.message) return 'ATTACHMENT_TOO_LARGE';
  return null;
}

/**
 * The pictures of a paste. A screenshot or a copied picture arrives as a file; text copied from a document or a spreadsheet may arrive WITH a picture of itself, and
 * then the text is what was meant. One picture often arrives in two forms: only one of each is kept.
 */
export function pastedPictures(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []).filter(f => PICTURES.includes(f.type));
  if (!files.length) return [];
  const text = data.getData('text/plain').trim(), html = data.getData('text/html');
  if (text && !/<img\b/i.test(html)) return [];
  const seen = new Set<string>();
  return files.filter(f => { const k = `${f.size}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, LIMITS.images);
}

// ── "@" mentions in a group ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Lower case without Vietnamese marks, so "@anh" finds "Ánh" and "đ" finds "d". */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

/** The "@…" being typed right before the caret: an "@" at the start or after a space, then at most 32 characters on one line. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (query.length > 32 || /[\n@]/.test(query) || /\s{2,}/.test(query)) return null;
  return { start: at, query };
}

/** Members whose name or @username matches what is typed (any word of the name may start it), the writer left out, at most `max`. */
export function mentionMatches<T extends { id: number; name: string; username?: string | null }>(people: T[], query: string, me: number, max = 6): T[] {
  const q = fold(query.trim());
  return people.filter(p => p.id !== me && (!q || fold(p.name).startsWith(q) || fold(p.name).split(/\s+/).some(w => w.startsWith(q)) || (p.username ?? '').toLowerCase().startsWith(q))).slice(0, max);
}

/** Where each chosen "@Name" stands in the text about to be sent (the first free place of each, left to right); a name deleted from the text is dropped. */
export function mentionSpans(body: string, chosen: { id: number; name: string }[]): { id: number; at: number; len: number }[] {
  const out: { id: number; at: number; len: number }[] = [];
  const taken = (a: number, l: number) => out.some(m => a < m.at + m.len && m.at < a + l);
  for (const c of chosen) {
    const token = '@' + c.name;
    for (let i = body.indexOf(token); i >= 0; i = body.indexOf(token, i + 1)) {
      const end = body[i + token.length];
      if ((i === 0 || /\s/.test(body[i - 1])) && (end === undefined || !/[\p{L}\p{N}]/u.test(end)) && !taken(i, token.length)) { out.push({ id: c.id, at: i, len: token.length }); break; }
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 10);
}

/** A body cut into plain text and mentions, keeping only mentions that really start with "@" where they say (never trusted blindly). */
export function mentionSegments(body: string, mentions: { id: number; at: number; len: number }[] | undefined): ({ text: string } | { text: string; id: number })[] {
  if (!mentions?.length) return [{ text: body }];
  const out: ({ text: string } | { text: string; id: number })[] = [];
  let i = 0;
  for (const m of [...mentions].sort((a, b) => a.at - b.at)) {
    if (m.at < i || m.at + m.len > body.length || body[m.at] !== '@' || m.len < 2) continue;
    if (m.at > i) out.push({ text: body.slice(i, m.at) });
    out.push({ text: body.slice(m.at, m.at + m.len), id: m.id });
    i = m.at + m.len;
  }
  if (i < body.length) out.push({ text: body.slice(i) });
  return out;
}
