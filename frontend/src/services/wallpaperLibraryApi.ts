import { apiClient } from '@/services/api-client';
import type { WallpaperLibraryEntry } from '@/types/wallpaper';

/**
 * Hình nền — "Video YouTube của tôi", kept with the signed-in account (`/api/v1/wallpaper/youtube-videos`).
 * The server scopes every call to the session's learner; nothing here names a user. Only 11-character video ids and
 * the learner's own background source (an HTTPS video link, or the NAME of a file kept on one device) are sent —
 * never a video file, a title or the pasted URL text. No AI, no metadata lookup.
 */
const BASE = '/wallpaper/youtube-videos';

export interface WallpaperLibraryList {
  items: WallpaperLibraryEntry[];
  limit: number;
}

export interface WallpaperLibraryImport {
  items: WallpaperLibraryEntry[];
  imported: number;
  alreadySaved: number;
  overLimit: number;
  limit: number;
}

export type WallpaperBackgroundInput = { kind: 'LINK'; url: string } | { kind: 'FILE'; fileName: string } | { kind: null };

export const wallpaperLibraryApi = {
  list: () => apiClient.get<WallpaperLibraryList>(BASE).then((r) => r.data),
  save: (videoId: string) =>
    apiClient.post<{ entry: WallpaperLibraryEntry; created: boolean }>(BASE, { videoId }).then((r) => r.data),
  importDeviceList: (videoIds: string[]) =>
    apiClient.post<WallpaperLibraryImport>(`${BASE}/import`, { videoIds }).then((r) => r.data),
  setBackground: (entryId: string, input: WallpaperBackgroundInput) =>
    apiClient
      .put<WallpaperLibraryEntry>(`${BASE}/${encodeURIComponent(entryId)}/background`, {
        kind: input.kind,
        url: input.kind === 'LINK' ? input.url : null,
        fileName: input.kind === 'FILE' ? input.fileName : null,
      })
      .then((r) => r.data),
  remove: (entryId: string) => apiClient.delete(`${BASE}/${encodeURIComponent(entryId)}`).then(() => undefined),
};
