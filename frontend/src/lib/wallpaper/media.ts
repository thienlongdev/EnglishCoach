import type { WallpaperKind, WallpaperPreset, WallpaperQuality, WallpaperRendition } from '@/types/wallpaper';

/** Average bitrate of a rendition in megabits per second (file size over loop length). */
export function mbps(rendition: WallpaperRendition, duration: number): number {
  return (rendition.bytes * 8) / Math.max(1, duration) / 1_000_000;
}

/** Never stream more than this for a background, whatever the learner chose. */
export const MAX_MBPS = 25;
/** "Tự động" stays at or below 1440p unless a sharper file is also light (≤ this bitrate). */
const AUTO_LIGHT_MBPS = 12;

export interface ScreenFacts {
  /** CSS pixels of the viewport. */
  width: number;
  height: number;
  dpr: number;
  /** Data Saver on or a 2G / 3G connection. */
  constrained: boolean;
}

export function readScreenFacts(): ScreenFacts {
  if (typeof window === 'undefined') return { width: 1920, height: 1080, dpr: 1, constrained: false };
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  const constrained = !!connection?.saveData || ['slow-2g', '2g', '3g'].includes(connection?.effectiveType ?? '');
  return { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1, constrained };
}

/**
 * The file a background plays: the smallest one that covers the screen (cover-cropped 16:9) at the device's pixel
 * density (capped at 2), within the bitrate rules. Saver / constrained connections get 720p.
 */
export function pickRendition(preset: WallpaperPreset, quality: WallpaperQuality, screen: ScreenFacts): WallpaperRendition {
  const sorted = [...preset.renditions].sort((a, b) => a.height - b.height);
  const allowed = sorted.filter((r) => mbps(r, preset.duration) <= MAX_MBPS);
  const pool = allowed.length ? allowed : [sorted[0]];
  if (quality === 'saver' || screen.constrained) return pool[0];
  if (quality === 'max') return pool[pool.length - 1];
  const coverWidth = Math.max(screen.width, (screen.height * 16) / 9) * Math.min(2, Math.max(1, screen.dpr));
  // Phones (portrait crop of a 16:9 frame) never need more than 1080p in "Tự động".
  const ceiling = Math.min(screen.width, screen.height) < 768 ? 1080 : 2160;
  const auto = pool.filter((r) => r.height <= ceiling && (r.height <= 1440 || mbps(r, preset.duration) <= AUTO_LIGHT_MBPS));
  const candidates = auto.length ? auto : [pool[0]];
  return candidates.find((r) => r.width >= coverWidth * 0.85) ?? candidates[candidates.length - 1];
}

/** The smallest file — what the studio's preview plays (never the full background file). */
export function previewRendition(preset: WallpaperPreset): WallpaperRendition {
  return [...preset.renditions].sort((a, b) => a.height - b.height)[0];
}

export function qualityLabel(rendition: Pick<WallpaperRendition, 'height'>): string {
  return rendition.height === 2160 ? '4K' : `${rendition.height}p`;
}

const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

// ─── YouTube ────────────────────────────────────────────────────────────────────────────────────────
// Only YouTube's own hosts; the video id is the only thing kept (tracking / time / playlist parameters are dropped),
// and every player or thumbnail URL is rebuilt from that validated id — never from the learner's text.
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
]);
const YOUTUBE_ID_PATHS = new Set(['shorts', 'live', 'embed', 'v', 'e']);

export type YouTubeLink = { type: 'video'; id: string } | { type: 'playlist' } | { type: 'no-video' };

/** A YouTube link (watch, youtu.be, shorts, live, embed, mobile / music hosts; scheme optional), or null if not YouTube. */
export function parseYouTubeLink(raw: string): YouTubeLink | null {
  let value = (raw || '').trim();
  if (!value || value.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const id = host.endsWith('youtu.be')
    ? parts[0]
    : parts[0] === 'watch'
      ? url.searchParams.get('v')
      : YOUTUBE_ID_PATHS.has(parts[0] ?? '')
        ? parts[1]
        : null;
  // `/embed/videoseries?list=…` is a playlist player whose path word happens to be 11 characters long.
  if (id && id !== 'videoseries' && YOUTUBE_ID.test(id)) return { type: 'video', id };
  if (url.searchParams.get('list')) return { type: 'playlist' };
  return { type: 'no-video' };
}

export function isYouTubeId(id: unknown): id is string {
  return typeof id === 'string' && id !== 'videoseries' && YOUTUBE_ID.test(id);
}

function youtubeId(id: string): string {
  if (!isYouTubeId(id)) throw new Error('invalid YouTube id');
  return id;
}

/** YouTube's own thumbnails of a video, sharpest first (maxres 1280×720 → sd 640×480 → hq 480×360). */
export function youtubeThumbnails(id: string): string[] {
  const safe = youtubeId(id);
  return ['maxresdefault', 'sddefault', 'hqdefault'].map((name) => `https://i.ytimg.com/vi/${safe}/${name}.jpg`);
}

/** YouTube's privacy-enhanced player with its standard controls. Started only by the learner's click on the stage. */
export function youtubeEmbedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${youtubeId(id)}?autoplay=1&rel=0&playsinline=1`;
}

/** Origins the background player's messages may come from (anything else is ignored). */
export const YOUTUBE_PLAYER_ORIGINS: readonly string[] = ['https://www.youtube-nocookie.com', 'https://www.youtube.com'];

/**
 * YouTube as the full-page background (owner decision 2026-10-19, OpenQuiz-style; YouTube's embed rules on overlays and
 * autoplay visibility are NOT met by this use — docs/live-wallpaper/RESEARCH_AND_RELEASE.md §11). YouTube's own
 * privacy-enhanced player streams the video to the browser: muted (so the browser lets it start), looping the one
 * video (`playlist` = itself), without the control bar, inline on phones, driven only by the documented IFrame API
 * messages (`enablejsapi` + this page's origin). Nothing is downloaded, extracted or proxied. Built only from the
 * validated id; `origin` is this page's own origin.
 */
export function youtubeBackgroundUrl(id: string, origin: string): string {
  const safe = youtubeId(id);
  const params = new URLSearchParams({
    autoplay: '1',
    mute: '1',
    controls: '0',
    loop: '1',
    playlist: safe,
    playsinline: '1',
    rel: '0',
    iv_load_policy: '3',
    disablekb: '1',
    fs: '0',
    enablejsapi: '1',
  });
  if (/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin)) params.set('origin', origin);
  return `https://www.youtube-nocookie.com/embed/${safe}?${params.toString()}`;
}

export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${youtubeId(id)}`;
}

export type CustomLinkCheck =
  | { ok: true; url: string; kind: WallpaperKind | 'unknown' }
  | { ok: false; reason: 'empty' | 'invalid' | 'not-https' | 'credentials' | 'local' | 'too-long' | 'youtube-playlist' | 'youtube-no-video' }
  | { ok: false; reason: 'youtube'; youtubeId: string };

/**
 * A learner's own link: HTTPS only, no embedded credentials, no local / private network host. The file type comes
 * from the path; a link without an extension is tried by the browser (image first, then video) before it can be applied.
 */
export function checkCustomLink(raw: string): CustomLinkCheck {
  const value = (raw || '').trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (value.length > 2048) return { ok: false, reason: 'too-long' };
  const youtube = parseYouTubeLink(value);
  if (youtube?.type === 'video') return { ok: false, reason: 'youtube', youtubeId: youtube.id };
  if (youtube) return { ok: false, reason: youtube.type === 'playlist' ? 'youtube-playlist' : 'youtube-no-video' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not-https' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  const host = url.hostname.toLowerCase();
  if (
    !host.includes('.') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith('[')
  ) {
    return { ok: false, reason: 'local' };
  }
  const path = url.pathname;
  const kind: WallpaperKind | 'unknown' = VIDEO_EXT.test(path) ? 'video' : IMAGE_EXT.test(path) ? 'image' : 'unknown';
  return { ok: true, url: url.toString(), kind };
}
