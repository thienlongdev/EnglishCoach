export type MusicMood = 'piano' | 'ambient' | 'focus' | 'night' | 'calm';
export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  source: 'curated' | 'local';
  url?: string;
  artwork?: string;
  accent: string;
  mood: MusicMood;
  duration?: number;
  creditUrl?: string;
  bytes?: number;
}
export interface StoredTrack extends MusicTrack { file: Blob; cover?: Blob; importedAt: number; }
export type RepeatMode = 'off' | 'all' | 'one';
export const musicDatabaseName = (scope: string) => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(scope) || scope === 'guest') throw new Error('ACCOUNT_REQUIRED');
  return `ec-music-v1-u${scope}`;
};
export function focusReason(path: string, tab = ''): 'listening' | 'speaking' | 'exam' | 'game' | 'quiet' | null {
  if (/^\/(login|register|forgot-password|reset-password|verify-email|landing-preview)(\/|$)/.test(path) || (path === '/' && (!tab || tab === 'landing'))) return 'quiet';
  if (/^\/(listening|dictation)(\/|$)/.test(path) || /^(listening|dictation)$/.test(tab)) return 'listening';
  if (/^\/speaking(\/|$)/.test(path) || tab === 'speaking') return 'speaking';
  if (/^\/exams(\/|$)/.test(path) || tab === 'exams') return 'exam';
  if (/^\/games\//.test(path)) return 'game';
  return null;
}
export function nextIndex(index: number, count: number, direction = 1, shuffle = false, random = Math.random()): number {
  if (!count) return -1;
  if (shuffle && count > 1) return (index + 1 + Math.floor(Math.max(0, Math.min(.999999, random)) * (count - 1))) % count;
  return (index + direction + count) % count;
}
export function clock(seconds = 0): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
export const MAX_FILE_BYTES = 150 * 1024 * 1024;
export const MAX_LIBRARY_BYTES = 1024 * 1024 * 1024;
export const MAX_TRACKS = 200;
export function validateMusicFile(file: {size: number; name: string; type: string}): void {
  if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('FILE_SIZE');
  if (!/\.(mp3|m4a|aac|wav|ogg|opus|flac|webm)$/i.test(file.name) || (file.type && !/^(audio\/|video\/webm)/.test(file.type))) throw new Error('FILE_TYPE');
}
