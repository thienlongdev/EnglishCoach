/** Hình nền (Wallpapers) — client-only types. Nothing here is sent to the backend. */

export type WallpaperKind = 'video' | 'image';
/** Auto = by screen + connection; saver = 720p; max = the sharpest file within the bitrate cap. */
export type WallpaperQuality = 'auto' | 'saver' | 'max';
/** live = the video plays; still = one sharp frame (the poster), no decoding. */
export type WallpaperMotion = 'live' | 'still';

export type WallpaperCollectionId = 'ocean' | 'sky' | 'night' | 'nature' | 'colour';

export interface WallpaperRendition {
  /** Real decoded height of the file (verified in the browser), not the name on the CDN. */
  height: 720 | 1080 | 1440 | 2160;
  width: number;
  fps: number;
  bytes: number;
  url: string;
}

export interface WallpaperPreset {
  id: string;
  collection: WallpaperCollectionId;
  titleVi: string;
  titleEn: string;
  moodVi: string;
  moodEn: string;
  kind: 'video';
  /** Loop length in seconds (from the file). */
  duration: number;
  renditions: WallpaperRendition[];
  /** Poster frame on the provider's image CDN, resized with `?w=`. */
  poster: string;
  /** Accent the studio borrows while this wallpaper is in focus. */
  accent: string;
  /** CSS object-position: keeps the subject in view when the screen crops the frame. */
  focus?: string;
  credit: { author: string; sourceUrl: string; provider: 'Pexels'; license: 'Pexels License' };
}

export interface WallpaperPreference {
  version: 2;
  /**
   * library = the learner's own background video attached to a saved YouTube entry; youtube = YouTube's own embedded
   * player (muted, looping) behind the workspace, identified only by the validated 11-character video id.
   */
  source: 'none' | 'preset' | 'custom' | 'library' | 'youtube' | 'world';
  presetId?: string;
  /** custom: the link; library + link: the attached direct video link. */
  customUrl?: string;
  customKind?: WallpaperKind;
  /** library only: the saved entry (server id) and where the attached video lives. Never a YouTube id or URL. */
  entryId?: string;
  media?: 'link' | 'file';
  /** library + file: when the file was kept (a replaced file is a new source for the engine). */
  fileStamp?: number;
  /** youtube only: the 11-character video id (never a URL; every player URL is rebuilt from it). */
  youtubeId?: string;
  /** world only: the Living World on screen (Echo Universe). Exactly one background source exists at any time: `source`. */
  worldId?: string;
  /** Living World tuning, kept while another source is active. All optional: absent = the world's defaults. */
  worldMotion?: number;
  worldPointer?: number;
  worldInteractive?: boolean;
  worldFocus?: WorldFocusMode;
  /** The tint of the workspace glass over any background (never a second background). */
  glass?: GlassTint;
  /** The world to offer again after another background was chosen. */
  lastWorldId?: string;
  /** The wallpaper to restore after a Living World was chosen (never another world). */
  lastMedia?: Pick<WallpaperPreference, 'source' | 'presetId' | 'customUrl' | 'customKind' | 'entryId' | 'media' | 'fileStamp' | 'youtubeId'>;
  /** 0 = calm (strong veil) … 1 = vivid (light veil). */
  clarity: number;
  motion: WallpaperMotion;
  quality: WallpaperQuality;
}

/** auto = quieter on its own during lessons; on = always quiet; off = the world stays as tuned. */
export type WorldFocusMode = 'auto' | 'on' | 'off';
export type GlassTint = 'auto' | 'neutral' | 'ocean' | 'dusk' | 'forest';

/** What the background engine is doing right now (shared with the studio and the sidebar). */
export interface WallpaperStatus {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  /** Identity of the source the state belongs to (see `sourceKey`). */
  key: string | null;
  /** Rendition actually playing (videos) — reported, never assumed. */
  rendition?: { height: number; fps: number } | null;
  still?: boolean;
  /**
   * missing = the attached device file is not in this browser (another device, or removed); blocked = YouTube refused to
   * play the video in an embedded player (embedding off, private, removed, restricted).
   */
  reason?: 'network' | 'decode' | 'timeout' | 'blocked' | 'missing' | 'unsupported';
}

/** "Video YouTube của tôi" — one saved entry of the signed-in learner, as the server stores it (no owner id). */
export interface WallpaperLibraryBackground {
  /** LINK = an HTTPS link to a directly playable video file; FILE = a video kept in the learner's browser on one device. */
  kind: 'LINK' | 'FILE';
  url: string | null;
  fileName: string | null;
}

export interface WallpaperLibraryEntry {
  id: string;
  videoId: string;
  background: WallpaperLibraryBackground | null;
  createdAt: string;
  updatedAt: string;
}
