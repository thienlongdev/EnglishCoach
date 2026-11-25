'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { Play, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { WALLPAPER_COLLECTIONS, WALLPAPER_PRESETS, findPreset, posterUrl } from '@/lib/wallpaper/catalog';
import {
  checkCustomLink,
  parseYouTubeLink,
  pickRendition,
  previewRendition,
  qualityLabel,
  readScreenFacts,
  youtubeEmbedUrl,
  youtubeThumbnails,
  youtubeWatchUrl,
  type CustomLinkCheck,
} from '@/lib/wallpaper/media';
import {
  currentPreference,
  getWallpaperStatus,
  normalizePreference,
  setBackgroundHeld,
  sourceKey,
  subscribeWallpaperStatus,
  writePreference,
} from '@/lib/wallpaper/storage';
import {
  getLibraryState,
  libraryErrorCode,
  loadLibrary,
  removeFromLibrary,
  saveToLibrary,
  setLibraryBackground,
  subscribeLibrary,
} from '@/lib/wallpaper/youtubeLibrary';
import {
  DeviceVideoQuotaError,
  MAX_DEVICE_VIDEO_BYTES,
  checkDeviceVideo,
  deleteDeviceVideo,
  getDeviceVideo,
  listDeviceVideoEntryIds,
  putDeviceVideo,
} from '@/lib/wallpaper/deviceVideos';
import type {
  WallpaperCollectionId,
  WallpaperKind,
  WallpaperLibraryEntry,
  WallpaperMotion,
  WallpaperPreference,
  WallpaperPreset,
  WallpaperQuality,
  WallpaperStatus,
} from '@/types/wallpaper';
import styles from './WallpaperStudio.module.css';
import WorldStudio from './WorldStudio';
import SpatialStudio from '@/components/spatial/SpatialStudio';
import NavigationStudio from '@/components/navigation/NavigationStudio';
import StudioBar, { type StudioRoom } from './StudioBar';
import { accountOfKey, commitMediaAppearance, currentAppearance, restoreDefaultAppearance } from '@/lib/appearance/state';

const BackgroundStudio = dynamic(() => import('@/components/background-studio/BackgroundStudio'), {
  ssr: false,
  loading: () => <div className="fixed inset-0 z-[120] bg-[rgb(3_7_18/0.72)]" aria-hidden="true" />,
});

/**
 * Hình nền — the studio (opened only from the sidebar entry).
 *
 * A dark "screening room": the left half is a live stage that really plays the wallpaper in focus (the provider's
 * smallest file, so browsing stays light), optionally under a miniature of the workspace to judge readability;
 * the right half is the library. Nothing is applied until "Áp dụng": then the background engine prepares the
 * file, and the studio closes only when the engine reports frames playing (or explains why it could not).
 * While the studio is open the background wallpaper pauses: one video decodes at a time.
 */

type Tab = 'all' | WallpaperCollectionId | 'link';
/** library = the learner's own video attached to a saved YouTube entry (a direct link, or a file kept on this device). */
type Focus = { type: 'none' } | { type: 'preset'; id: string } | { type: 'custom' } | { type: 'library'; entryId: string };
type CustomPreview = { url: string; kind: WallpaperKind | 'unknown' } | null;
type StageState = 'loading' | 'playing' | 'still' | 'failed';
type StageReporter = (key: string, state: StageState) => void;

const DEFAULT_ACCENT = '#38bdf8';
const YOUTUBE_ACCENT = '#f43f5e';
const OWN_VIDEO_ACCENT = '#a78bfa';
const ACCOUNT_PREFIX = 'ec_wallpaper:v2:u';

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  );
}

function useAppDark(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => observer.disconnect();
    },
    () => document.documentElement.classList.contains('dark'),
    () => false,
  );
}

export default function WallpaperStudio({
  storageKey,
  initialRoom,
  onClose,
  onMinimizeForPreview,
}: {
  storageKey: string;
  initialRoom?: StudioRoom;
  onClose: () => void;
  onMinimizeForPreview?: () => void;
}) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const reducedMotion = useReducedMotion();
  const appDark = useAppDark();
  const screen = useMemo(() => readScreenFacts(), []);

  const saved = useMemo(() => currentPreference(storageKey), [storageKey]);
  const [draft, setDraft] = useState<WallpaperPreference>(saved);
  const [focus, setFocus] = useState<Focus>(() =>
    saved.source === 'preset' && saved.presetId
      ? { type: 'preset', id: saved.presetId }
      : saved.source === 'custom'
        ? { type: 'custom' }
        : saved.source === 'library' && saved.entryId
          ? { type: 'library', entryId: saved.entryId }
          : { type: 'none' },
  );
  const [tab, setTab] = useState<Tab>(saved.source === 'custom' || saved.source === 'library' || saved.source === 'youtube' ? 'link' : 'all');
  // Three rooms, one dialog: it opens on what is in use (Living Worlds when nothing is). Moving between rooms is browsing: nothing on the page changes until an Apply.
  const appearanceAccount = accountOfKey(storageKey);
  const [room, setRoom] = useState<StudioRoom>(() => {
    if (initialRoom) return initialRoom;
    const mode = currentAppearance(appearanceAccount).mode;
    return mode === 'spatial'
      ? 'spatial'
      : mode === 'background'
        ? 'background'
        : mode === 'wallpaper'
          ? 'media'
          : 'worlds';
  });
  useEffect(() => {
    if (initialRoom) setRoom(initialRoom);
  }, [initialRoom]);
  const [withApp, setWithApp] = useState(false);

  const [linkInput, setLinkInput] = useState(
    saved.source === 'custom' ? saved.customUrl ?? '' : saved.source === 'youtube' && saved.youtubeId ? youtubeWatchUrl(saved.youtubeId) : '',
  );
  const [linkCheck, setLinkCheck] = useState<CustomLinkCheck | null>(null);
  const [customPreview, setCustomPreview] = useState<CustomPreview>(
    saved.source === 'custom' && saved.customUrl ? { url: saved.customUrl, kind: saved.customKind ?? 'unknown' } : null,
  );
  const [customVerified, setCustomVerified] = useState<WallpaperKind | null>(saved.source === 'custom' ? saved.customKind ?? null : null);
  // A recognised YouTube video: shown on the stage (its thumbnail, then YouTube's own player with sound on click);
  // "Áp dụng" puts YouTube's player behind the workspace, muted and looping (owner decision 2026-10-19).
  const [youtubeVideo, setYoutubeVideo] = useState<string | null>(saved.source === 'youtube' ? saved.youtubeId ?? null : null);
  const [youtubeOpen, setYoutubeOpen] = useState(false);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const [focusLinkInput, setFocusLinkInput] = useState(false);

  // "Video YouTube của tôi": kept with the account on the server (signed-in learners only). The list in memory is the
  // server's last answer for THIS account; another account's list is never shown.
  const accountId = storageKey.startsWith(ACCOUNT_PREFIX) ? storageKey.slice(ACCOUNT_PREFIX.length) : '';
  const signedIn = accountId !== '';
  const libraryState = useSyncExternalStore(subscribeLibrary, getLibraryState, getLibraryState);
  const library = libraryState.owner === storageKey ? libraryState : null;
  const savedYoutube: WallpaperLibraryEntry[] = library?.items ?? [];
  useEffect(() => {
    if (signedIn) void loadLibrary(storageKey);
  }, [signedIn, storageKey]);
  const [libraryBusy, setLibraryBusy] = useState<string | null>(null);
  const [libraryMessage, setLibraryMessage] = useState<string | null>(null);
  // Which entries have their attached video file in THIS browser (the bytes never leave it).
  const [deviceEntries, setDeviceEntries] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    listDeviceVideoEntryIds(accountId).then((ids) => { if (live) setDeviceEntries(new Set(ids)); }).catch(() => {});
    return () => { live = false; };
  }, [signedIn, accountId]);
  const [bgLink, setBgLink] = useState('');
  const [bgRights, setBgRights] = useState(false);
  const bgFileRef = useRef<HTMLInputElement>(null);

  // Stage reports are tagged with the stage they belong to, so a late event of a previous preview is ignored.
  const [stageReport, setStageReport] = useState<{ key: string; state: StageState } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<WallpaperStatus['reason'] | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const focusedPreset = focus.type === 'preset' ? findPreset(focus.id) : undefined;
  // The stage shows YouTube (thumbnail / its own player) unless the learner is previewing their own attached video.
  const stageYoutube = focus.type === 'library' ? null : youtubeVideo;
  const focusedEntry = focus.type === 'library' ? savedYoutube.find((item) => item.id === focus.entryId) : undefined;
  const accent = stageYoutube ? YOUTUBE_ACCENT : focus.type === 'library' ? OWN_VIDEO_ACCENT : focusedPreset?.accent ?? DEFAULT_ACCENT;
  const appliedKey = sourceKey(saved);

  // One decoder at a time: the background pauses while any room of the studio is open.
  useEffect(() => {
    setBackgroundHeld(true);
    return () => setBackgroundHeld(false);
  }, [room]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [room]);

  const close = useCallback(() => {
    if (applying) return;
    onClose();
  }, [applying, onClose]);

  // Dialog keyboard: Escape closes, Tab stays inside the studio.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const focusables = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const choosePreset = (preset: WallpaperPreset) => {
    setFocus({ type: 'preset', id: preset.id });
    setDraft((d) => ({ ...d, source: 'preset', presetId: preset.id, customUrl: undefined, customKind: undefined, youtubeId: undefined }));
    setApplyError(null);
    setYoutubeOpen(false);
    setYoutubeVideo(null);
  };

  const chooseDefault = () => {
    setFocus({ type: 'none' });
    setDraft((d) => ({ ...d, source: 'none', presetId: undefined, customUrl: undefined, customKind: undefined, youtubeId: undefined }));
    setApplyError(null);
    setYoutubeOpen(false);
    setYoutubeVideo(null);
  };

  const openLinkTab = () => {
    setTab('link');
    setFocusLinkInput(true);
  };

  useEffect(() => {
    if (tab !== 'link' || !focusLinkInput) return;
    linkInputRef.current?.focus({ preventScroll: true });
    setFocusLinkInput(false);
  }, [tab, focusLinkInput]);

  /** The draft for a YouTube video: only its validated id (the background player URL is rebuilt from it). */
  const youtubeDraft = (id: string) => (d: WallpaperPreference): WallpaperPreference => ({
    ...d,
    source: 'youtube',
    youtubeId: id,
    presetId: undefined,
    customUrl: undefined,
    customKind: undefined,
    entryId: undefined,
    media: undefined,
    fileStamp: undefined,
  });

  // A YouTube link is recognised as it is typed or pasted (no request: only the id is read from the text).
  const onLinkChange = (value: string) => {
    setLinkInput(value);
    const youtube = parseYouTubeLink(value);
    const id = youtube?.type === 'video' ? youtube.id : null;
    if (id !== youtubeVideo) {
      setYoutubeOpen(false);
      setLibraryMessage(null);
      setBgLink('');
      setBgRights(false);
      // Another video in the pane: the stage goes back to it (a preview of an attached video belongs to its entry).
      setFocus((f) => (f.type === 'library' ? { type: 'none' } : f));
    }
    setYoutubeVideo(id);
    if (id) setDraft(youtubeDraft(id));
    else setDraft((d) => (d.source === 'youtube' ? { ...d, source: 'none', youtubeId: undefined } : d));
    if (youtube) {
      setLinkCheck(checkCustomLink(value));
      setApplyError(null);
    } else if (linkCheck && !linkCheck.ok && linkCheck.reason.startsWith('youtube')) {
      setLinkCheck(null);
    }
  };

  const openSavedYoutube = (id: string) => onLinkChange(youtubeWatchUrl(id));
  const savedEntry = youtubeVideo ? savedYoutube.find((item) => item.videoId === youtubeVideo) : undefined;
  const youtubeSaved = !!savedEntry;

  const libraryFailure = (error: unknown): string => {
    const code = libraryErrorCode(error);
    if (code === 'LIBRARY_FULL') return vi ? `Danh sách đã đủ ${library?.limit ?? 50} video. Hãy xóa bớt rồi lưu lại.` : `Your list already holds ${library?.limit ?? 50} videos. Remove one first.`;
    if (code === 'INVALID_VIDEO_LINK') return vi ? 'Liên kết video chưa hợp lệ (cần https://, trỏ thẳng tới một tệp video, không phải trang YouTube).' : 'That video link is not valid (https://, pointing straight at a video file, not a YouTube page).';
    if (code === 'ENTRY_NOT_FOUND') return vi ? 'Video này không còn trong danh sách của bạn.' : 'This video is no longer in your list.';
    if (code === 'DEVICE_FULL') return vi ? 'Bộ nhớ trình duyệt đã đầy. Hãy gỡ bớt video nền hoặc giải phóng dung lượng.' : 'Browser storage is full. Remove a background video or free some space.';
    if (code === 'DEVICE_COUNT') return vi ? 'Thiết bị này đã giữ 10 video nền. Hãy gỡ bớt một video trước.' : 'This device already keeps 10 background videos. Remove one first.';
    if (code === 'DEVICE') return vi ? 'Trình duyệt này không lưu được tệp video.' : 'This browser could not keep the video file.';
    return vi ? 'Chưa lưu được. Kiểm tra kết nối rồi thử lại.' : 'Could not save. Check your connection and try again.';
  };

  const runLibrary = async (label: string, work: () => Promise<void>) => {
    if (libraryBusy) return;
    setLibraryBusy(label);
    setLibraryMessage(null);
    try {
      await work();
    } catch (error) {
      setLibraryMessage(libraryFailure(error));
    } finally {
      setLibraryBusy(null);
    }
  };

  const saveCurrentYoutube = () => {
    if (!youtubeVideo || youtubeSaved || !signedIn) return;
    const id = youtubeVideo;
    void runLibrary('save', async () => { await saveToLibrary(storageKey, id); });
  };

  /** The stored choice still points at an entry that is going away / changing: the app background comes back. */
  const releaseAppliedEntry = (entryId: string) => {
    if (saved.source === 'library' && saved.entryId === entryId) writePreference(storageKey, { ...saved, source: 'none', entryId: undefined, media: undefined, customUrl: undefined, customKind: undefined, fileStamp: undefined });
  };

  const removeEntry = (entry: WallpaperLibraryEntry) => {
    void runLibrary('remove', async () => {
      await removeFromLibrary(storageKey, entry.id);
      releaseAppliedEntry(entry.id);
      if (focus.type === 'library' && focus.entryId === entry.id) chooseDefault();
      if (deviceEntries.has(entry.id)) {
        await deleteDeviceVideo(accountId, entry.id).catch(() => {});
        setDeviceEntries((prev) => { const next = new Set(prev); next.delete(entry.id); return next; });
      }
    });
    // The focused button leaves with its item: keep keyboard focus inside the studio.
    linkInputRef.current?.focus({ preventScroll: true });
  };

  /** Preview the learner's attached video on the stage (Apply becomes possible once frames play). */
  const previewEntryBackground = (entry: WallpaperLibraryEntry, fileStamp?: number) => {
    const bg = entry.background;
    if (!bg) return;
    setYoutubeOpen(false);
    setApplyError(null);
    setCustomVerified(null);
    setFocus({ type: 'library', entryId: entry.id });
    if (bg.kind === 'LINK' && bg.url) {
      setDraft((d) => ({ ...d, source: 'library', entryId: entry.id, media: 'link', customUrl: bg.url ?? undefined, customKind: 'video', presetId: undefined, fileStamp: undefined, youtubeId: undefined }));
    } else {
      const stamp = fileStamp ?? (saved.source === 'library' && saved.entryId === entry.id ? saved.fileStamp ?? 0 : 0);
      setDraft((d) => ({ ...d, source: 'library', entryId: entry.id, media: 'file', fileStamp: stamp, customUrl: undefined, customKind: undefined, presetId: undefined, youtubeId: undefined }));
    }
  };

  const attachLink = (entry: WallpaperLibraryEntry) => {
    const check = checkCustomLink(bgLink);
    if (!check.ok) {
      setLibraryMessage(check.reason === 'youtube' || check.reason.startsWith('youtube')
        ? vi ? 'Đây là liên kết YouTube. Hãy dán liên kết trỏ thẳng tới tệp video (MP4 / WebM) mà bạn có quyền sử dụng.' : 'That is a YouTube link. Paste a link that points straight at a video file (MP4 / WebM) you may use.'
        : linkError(check));
      return;
    }
    if (check.kind === 'image') {
      setLibraryMessage(vi ? 'Liên kết này là ảnh. Video nền cần một tệp video (MP4 / WebM).' : 'That link is an image. A background needs a video file (MP4 / WebM).');
      return;
    }
    void runLibrary('link', async () => {
      releaseAppliedEntry(entry.id);
      const updated = await setLibraryBackground(storageKey, entry.id, { kind: 'LINK', url: check.url });
      if (deviceEntries.has(entry.id)) {
        await deleteDeviceVideo(accountId, entry.id).catch(() => {});
        setDeviceEntries((prev) => { const next = new Set(prev); next.delete(entry.id); return next; });
      }
      setBgLink('');
      previewEntryBackground(updated);
    });
  };

  const attachFile = (entry: WallpaperLibraryEntry, file: File | undefined) => {
    if (!file) return;
    const check = checkDeviceVideo(file);
    if (!check.ok) {
      setLibraryMessage(check.reason === 'size'
        ? vi ? `Tệp lớn hơn ${Math.round(MAX_DEVICE_VIDEO_BYTES / 1048576)} MB.` : `The file is larger than ${Math.round(MAX_DEVICE_VIDEO_BYTES / 1048576)} MB.`
        : vi ? 'Hãy chọn một tệp video MP4, WebM hoặc MOV.' : 'Choose an MP4, WebM or MOV video file.');
      return;
    }
    void runLibrary('file', async () => {
      let stamp: number;
      try {
        stamp = await putDeviceVideo(accountId, entry.id, file);
      } catch (error) {
        throw Object.assign(new Error('device'), { response: { data: { code: error instanceof DeviceVideoQuotaError ? 'DEVICE_FULL' : (error as Error)?.message === 'count' ? 'DEVICE_COUNT' : 'DEVICE' } } });
      }
      setDeviceEntries((prev) => new Set(prev).add(entry.id));
      releaseAppliedEntry(entry.id);
      const updated = await setLibraryBackground(storageKey, entry.id, { kind: 'FILE', fileName: file.name });
      previewEntryBackground(updated, stamp);
    });
  };

  const detachBackground = (entry: WallpaperLibraryEntry) => {
    void runLibrary('detach', async () => {
      await setLibraryBackground(storageKey, entry.id, { kind: null });
      releaseAppliedEntry(entry.id);
      if (focus.type === 'library' && focus.entryId === entry.id) {
        setFocus({ type: 'none' });
        setDraft((d) => ({ ...d, source: 'none', entryId: undefined, media: undefined, customUrl: undefined, customKind: undefined, fileStamp: undefined }));
      }
      if (deviceEntries.has(entry.id)) {
        await deleteDeviceVideo(accountId, entry.id).catch(() => {});
        setDeviceEntries((prev) => { const next = new Set(prev); next.delete(entry.id); return next; });
      }
    });
  };

  const tryLink = () => {
    const check = checkCustomLink(linkInput);
    setLinkCheck(check);
    setApplyError(null);
    setCustomVerified(null);
    const id = !check.ok && check.reason === 'youtube' ? check.youtubeId : null;
    if (id !== youtubeVideo) setYoutubeOpen(false);
    setYoutubeVideo(id);
    if (id) {
      setFocus((f) => (f.type === 'library' ? { type: 'none' } : f));
      setDraft(youtubeDraft(id));
    }
    if (check.ok) {
      setFocus({ type: 'custom' });
      setCustomPreview({ url: check.url, kind: check.kind });
      setDraft((d) => ({ ...d, source: 'custom', presetId: undefined, customUrl: check.url, customKind: undefined, youtubeId: undefined }));
    } else {
      setCustomPreview(null);
    }
  };

  // ─── Stage: what the preview really plays ───────────────────────────────────────────────────────────
  const stillPreview = draft.motion === 'still' || reducedMotion;
  const stageKey = stageYoutube
    ? `y:${stageYoutube}`
    : focus.type === 'preset'
      ? `p:${focus.id}:${stillPreview}`
      : focus.type === 'custom'
        ? `c:${customPreview?.url}:${stillPreview}`
        : focus.type === 'library'
          ? `l:${focus.entryId}:${draft.media}:${draft.media === 'link' ? draft.customUrl : draft.fileStamp}:${stillPreview}`
          : 'none';
  const stageState: StageState =
    stageReport?.key === stageKey ? stageReport.state : focus.type === 'none' && !stageYoutube ? 'still' : 'loading';
  const reportStage = useCallback<StageReporter>((key, state) => setStageReport({ key, state }), []);
  const onCustomKind = useCallback((kind: WallpaperKind) => {
    setCustomVerified(kind);
    setDraft((d) => (d.source === 'custom' ? { ...d, customKind: kind } : d));
  }, []);

  const backgroundFile = focusedPreset ? pickRendition(focusedPreset, draft.quality, screen) : null;

  // ─── Apply: the engine must prove the new wallpaper before the studio says it is on ──────────────────
  const apply = () => {
    if (applying) return;
    const next = normalizePreference(draft);
    const key = sourceKey(next);
    setApplyError(null);
    setBackgroundHeld(false);
    if (!key) {
      // The original background card: the normal look, whichever system was on.
      restoreDefaultAppearance(appearanceAccount);
      writePreference(storageKey, next);
      onClose();
      return;
    }
    writePreference(storageKey, next);
    const now = getWallpaperStatus();
    if (now.key === key && now.state === 'ready') {
      commitMediaAppearance(appearanceAccount);
      onClose();
      return;
    }
    setApplying(true);
  };

  useEffect(() => {
    if (!applying) return;
    const key = sourceKey(normalizePreference(draft));
    const check = () => {
      const status = getWallpaperStatus();
      if (status.key !== key) return;
      if (status.state === 'ready') {
        setApplying(false);
        // Proven on screen: only now does the 3D preset, if there was one, stop being the choice to return to.
        commitMediaAppearance(appearanceAccount);
        onClose();
      } else if (status.state === 'failed') {
        setApplying(false);
        setApplyError(status.reason ?? 'network');
        // Keep what was on screen before: the stored choice goes back to it, the studio stays open.
        writePreference(storageKey, saved);
        setBackgroundHeld(true);
      }
    };
    check();
    return subscribeWallpaperStatus(check);
  }, [applying, draft, onClose, saved, storageKey, appearanceAccount]);

  // A YouTube video can be applied while it is the one on the stage (the engine then proves it plays behind the
  // workspace before the studio closes). The learner's own attached video can, once the stage proved it plays.
  const canApply =
    !applying &&
    (draft.source !== 'youtube' || (!!stageYoutube && draft.youtubeId === stageYoutube)) &&
    (!stageYoutube || draft.source === 'youtube') &&
    (draft.source !== 'custom' || (customVerified !== null && draft.customKind === customVerified)) &&
    (draft.source !== 'library' || (focus.type === 'library' && customVerified === 'video')) &&
    stageState !== 'failed';

  const visiblePresets = tab === 'all' || tab === 'link' ? WALLPAPER_PRESETS : WALLPAPER_PRESETS.filter((p) => p.collection === tab);
  const collectionName = (id: WallpaperCollectionId) => {
    const c = WALLPAPER_COLLECTIONS.find((item) => item.id === id);
    return c ? (vi ? c.vi : c.en) : '';
  };

  const errorText = (reason: WallpaperStatus['reason'] | null) =>
    reason === 'blocked'
      ? vi ? 'YouTube không cho phát video này trong trình phát nhúng (chủ sở hữu tắt nhúng, video riêng tư, đã xóa hoặc bị giới hạn). Hình nền cũ vẫn được giữ.' : 'YouTube will not play this video in an embedded player (embedding off, private, removed or restricted). The previous wallpaper stays.'
      : reason === 'timeout' && draft.source === 'youtube'
      ? vi ? 'Trình phát YouTube chưa bắt đầu phát (trình duyệt hoặc YouTube có thể đang chặn tự phát). Hình nền cũ vẫn được giữ.' : 'The YouTube player did not start (the browser or YouTube may be blocking autoplay). The previous wallpaper stays.'
      : reason === 'missing'
      ? vi ? 'Tệp video không có trong trình duyệt này. Hãy chọn lại tệp trên thiết bị này. Hình nền cũ vẫn được giữ.' : 'The video file is not in this browser. Choose the file again on this device. The previous wallpaper stays.'
      : reason === 'decode'
      ? vi ? 'Trình duyệt không giải mã được tệp này. Hình nền cũ vẫn được giữ.' : 'Your browser cannot decode this file. The previous wallpaper stays.'
      : reason === 'timeout'
        ? vi ? 'Video phản hồi quá chậm. Hình nền cũ vẫn được giữ.' : 'The video took too long to start. The previous wallpaper stays.'
        : vi ? 'Không tải được nội dung này. Hình nền cũ vẫn được giữ.' : 'This media could not be loaded. The previous wallpaper stays.';

  const linkError = (check: CustomLinkCheck | null): string | null => {
    if (!check || check.ok) return null;
    switch (check.reason) {
      case 'empty': return vi ? 'Hãy dán một liên kết.' : 'Paste a link first.';
      case 'invalid': return vi ? 'Liên kết chưa hợp lệ.' : 'That link is not valid.';
      case 'not-https': return vi ? 'Chỉ nhận liên kết bắt đầu bằng https://.' : 'Only https:// links are accepted.';
      case 'credentials': return vi ? 'Liên kết không được chứa tên đăng nhập hay mật khẩu.' : 'Links may not contain a user name or password.';
      case 'local': return vi ? 'Không dùng được địa chỉ mạng nội bộ.' : 'Local network addresses are not allowed.';
      case 'too-long': return vi ? 'Liên kết quá dài.' : 'That link is too long.';
      case 'youtube-playlist': return vi ? 'Đây là danh sách phát. Hãy dán liên kết của một video trong danh sách.' : 'That is a playlist. Paste the link of one video from it.';
      case 'youtube-no-video': return vi ? 'Liên kết YouTube này không trỏ tới một video.' : 'This YouTube link does not point to a video.';
      case 'youtube': return null;
    }
  };

  // YouTube's title, channel and length are shown by YouTube's own player (no API key, no request from this page).
  const title = stageYoutube
    ? vi ? 'Video YouTube của bạn' : 'Your YouTube video'
    : focusedPreset
      ? vi ? focusedPreset.titleVi : focusedPreset.titleEn
      : focus.type === 'custom'
        ? vi ? 'Liên kết của bạn' : 'Your link'
        : focus.type === 'library'
          ? vi ? 'Video nền của bạn' : 'Your background video'
          : vi ? 'Nền English Coach' : 'English Coach default';
  const ownVideoSource =
    draft.source === 'library' && draft.media === 'link' && draft.customUrl
      ? safeHost(draft.customUrl)
      : focusedEntry?.background?.fileName ?? '';
  const mood = stageYoutube
    ? vi ? 'Tiêu đề, kênh và thời lượng hiện trong trình phát YouTube.' : 'Title, channel and length appear in the YouTube player.'
    : focusedPreset
      ? vi ? focusedPreset.moodVi : focusedPreset.moodEn
      : focus.type === 'custom'
        ? customPreview?.url ?? ''
        : focus.type === 'library'
          ? vi
            ? `Bản video bạn gắn${focusedEntry ? ` cho YouTube ${focusedEntry.videoId}` : ''} — phát trực tiếp trong trình duyệt, không phải trình phát YouTube.`
            : `The video you attached${focusedEntry ? ` to YouTube ${focusedEntry.videoId}` : ''} — played in your browser, not the YouTube player.`
          : vi ? 'Giao diện gốc, không có hình nền.' : 'The original look, no wallpaper.';

  const openRoom = (next: StudioRoom) => {
    setRoom(next);
    // The wallpaper room starts from "no wallpaper": choosing nothing here and applying really means the original background.
    if (next === 'media' && saved.source === 'world') setDraft((d) => ({ ...d, source: 'none', worldId: undefined }));
  };
  if (room === 'navigation') return <NavigationStudio storageKey={storageKey} onClose={onClose} onOpenRoom={openRoom} />;
  if (room === 'spatial') return <SpatialStudio storageKey={storageKey} onClose={onClose} onOpenRoom={openRoom} />;
  if (room === 'worlds') return <WorldStudio storageKey={storageKey} onClose={onClose} onOpenRoom={openRoom} />;
  if (room === 'background') {
    return (
      <BackgroundStudio
        storageKey={storageKey}
        onClose={onClose}
        onOpenRoom={openRoom}
        onMinimizeForPreview={onMinimizeForPreview}
      />
    );
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallpaper-studio-title"
      className={styles.studio}
      style={{ '--accent': accent } as React.CSSProperties}
      onKeyDown={onKeyDown}
      data-testid="wallpaper-studio"
    >
      <StudioBar room="media" onRoom={openRoom} storageKey={storageKey} vi={vi} closeRef={closeRef} onClose={close} disabled={applying} />
      <div className={styles.panel}>
        {/* ─── Stage ─────────────────────────────────────────────────────────────── */}
        <section className={styles.stageColumn} aria-label={vi ? 'Xem trước' : 'Preview'}>
          <div className={styles.stage} data-stage-state={stageState} style={{ '--clarity': String(draft.clarity) } as React.CSSProperties}>
            {focus.type === 'none' && !stageYoutube && <div className={styles.defaultArt} />}

            {stageYoutube && !youtubeOpen && <StageYouTube key={stageKey} stageKey={stageKey} id={stageYoutube} onReport={reportStage} />}

            {stageYoutube && youtubeOpen && (
              <iframe
                key={stageYoutube}
                className={styles.youtube}
                src={youtubeEmbedUrl(stageYoutube)}
                title={vi ? 'Trình phát YouTube' : 'YouTube player'}
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                data-testid="wallpaper-youtube-player"
              />
            )}

            {stageYoutube && !youtubeOpen && (
              <button type="button" className={styles.ytPlay} onClick={() => setYoutubeOpen(true)} data-testid="wallpaper-youtube-play">
                <span className={styles.ytPlayMark} aria-hidden="true">
                  <Play className="h-6 w-6" fill="currentColor" />
                </span>
                <span>{vi ? 'Phát bằng trình phát YouTube' : 'Play in the YouTube player'}</span>
              </button>
            )}

            {focusedPreset && !stageYoutube && (
              <StagePreset
                key={stageKey}
                stageKey={stageKey}
                preset={focusedPreset}
                still={stillPreview}
                onReport={reportStage}
              />
            )}

            {focus.type === 'custom' && customPreview && !stageYoutube && (
              <StageCustom
                key={stageKey}
                stageKey={stageKey}
                preview={customPreview}
                still={stillPreview}
                onReport={reportStage}
                onKind={onCustomKind}
              />
            )}

            {focus.type === 'library' && draft.source === 'library' && (
              <StageOwnVideo
                key={stageKey}
                stageKey={stageKey}
                accountId={accountId}
                entryId={focus.entryId}
                media={draft.media}
                url={draft.customUrl}
                still={stillPreview}
                onReport={reportStage}
                onKind={onCustomKind}
              />
            )}

            {/* Nothing is ever drawn over YouTube's player: caption, chips and the app miniature leave once it opens. */}
            {withApp && !stageYoutube && <AppMiniature dark={appDark} vi={vi} />}

            {!youtubeOpen && (!withApp || stageYoutube) && (
              <div className={styles.stageCaption}>
                {stageYoutube && <span className={styles.stageEyebrow}>YouTube</span>}
                {focusedPreset && !stageYoutube && <span className={styles.stageEyebrow}>{collectionName(focusedPreset.collection)}</span>}
                {focus.type === 'library' && <span className={styles.stageEyebrow}>{vi ? 'Video của bạn' : 'Your video'}</span>}
                <h3 className={styles.stageTitle}>{title}</h3>
                <p className={styles.stageMood}>{mood}</p>
              </div>
            )}

            {!youtubeOpen && (
              <div className={styles.stageMeta} aria-live="polite">
                {stageState === 'loading' && <span className={styles.chip}>{vi ? 'Đang tải bản xem trước…' : 'Loading preview…'}</span>}
                {stageState === 'failed' && (
                  <span className={`${styles.chip} ${styles.chipError}`}>
                    {stageYoutube
                      ? vi ? 'Không lấy được ảnh của video' : 'No picture for this video'
                      : vi ? 'Không mở được nội dung này' : 'This media could not be opened'}
                  </span>
                )}
                {stageYoutube && <span className={styles.chip}>{vi ? 'Hình nền: tắt tiếng · lặp lại' : 'As wallpaper: muted · looping'}</span>}
                {focus.type === 'library' && stageState !== 'failed' && (
                  <span className={styles.chip} data-testid="wallpaper-own-video-chip">
                    {stageState === 'playing'
                      ? vi ? 'Video thật · không phải trình phát YouTube' : 'Real video · not the YouTube player'
                      : stillPreview ? (vi ? 'Ảnh tĩnh' : 'Still frame') : vi ? 'Video của bạn' : 'Your video'}
                  </span>
                )}
                {focusedPreset && !stageYoutube && stageState !== 'failed' && (
                  <>
                    <span className={styles.chip}>
                      {stillPreview ? (vi ? 'Ảnh tĩnh' : 'Still frame') : vi ? `Video thật · lặp ${Math.round(focusedPreset.duration)} giây` : `Real video · ${Math.round(focusedPreset.duration)} s loop`}
                    </span>
                    {backgroundFile && !stillPreview && (
                      <span className={styles.chip}>
                        {vi ? 'Hình nền' : 'Wallpaper'} {qualityLabel(backgroundFile)} · {backgroundFile.fps} fps
                      </span>
                    )}
                  </>
                )}
                {appliedKey && appliedKey === sourceKey(normalizePreference(draft)) && (!stageYoutube || draft.source === 'youtube') && (
                  <span className={`${styles.chip} ${styles.chipOn}`}>{vi ? 'Đang dùng' : 'In use'}</span>
                )}
              </div>
            )}
          </div>

          <div className={styles.controls}>
            <label className={styles.control}>
              <span className={styles.controlLabel}>{vi ? 'Độ rõ hình nền' : 'Wallpaper clarity'}</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(draft.clarity * 100)}
                onChange={(e) => setDraft((d) => ({ ...d, clarity: Number(e.target.value) / 100 }))}
                className={styles.range}
                style={{ '--fill': `${Math.round(draft.clarity * 100)}%` } as React.CSSProperties}
                aria-valuetext={`${Math.round(draft.clarity * 100)}%`}
              />
              <span className={styles.rangeEnds} aria-hidden="true">
                <span>{vi ? 'Dịu mắt' : 'Calm'}</span>
                <span>{vi ? 'Rực rỡ' : 'Vivid'}</span>
              </span>
            </label>

            <Segmented<WallpaperMotion>
              label={vi ? 'Chuyển động' : 'Motion'}
              value={draft.motion}
              onChange={(motion) => setDraft((d) => ({ ...d, motion }))}
              options={[
                { value: 'live', label: vi ? 'Phát video' : 'Play video' },
                { value: 'still', label: vi ? 'Ảnh tĩnh' : 'Still frame' },
              ]}
            />

            <Segmented<WallpaperQuality>
              label={vi ? 'Chất lượng' : 'Quality'}
              value={draft.quality}
              onChange={(quality) => setDraft((d) => ({ ...d, quality }))}
              options={[
                { value: 'auto', label: vi ? 'Tự động' : 'Auto' },
                { value: 'saver', label: vi ? 'Tiết kiệm' : 'Data saver' },
                { value: 'max', label: vi ? 'Cao nhất' : 'Highest' },
              ]}
            />

            <button
              type="button"
              className={styles.lens}
              aria-pressed={withApp && !stageYoutube}
              disabled={!!stageYoutube}
              onClick={() => setWithApp((on) => !on)}
            >
              {vi ? 'Xem cùng giao diện' : 'Preview with the app'}
            </button>
          </div>

          {(reducedMotion || screen.constrained) && (
            <p className={styles.note}>
              {reducedMotion
                ? vi ? 'Thiết bị đang bật giảm chuyển động: hình nền hiển thị dạng ảnh tĩnh.' : 'Reduced motion is on: wallpapers show as a still frame.'
                : vi ? 'Đang tiết kiệm dữ liệu: video phát ở 720p.' : 'Data saving is on: videos play at 720p.'}
            </p>
          )}

          {stageYoutube && (
            <p className={styles.credit}>
              {vi ? 'Nguồn' : 'Source'}:{' '}
              <a href={youtubeWatchUrl(stageYoutube)} target="_blank" rel="noopener noreferrer">
                YouTube
              </a>{' '}
              <span className={styles.creditLicense}>({vi ? 'nội dung thuộc chủ sở hữu video' : 'content belongs to its owner'})</span>
            </p>
          )}

          {focus.type === 'library' && ownVideoSource && (
            <p className={styles.credit}>
              {draft.media === 'file' ? (vi ? 'Tệp trên thiết bị này' : 'File on this device') : vi ? 'Nguồn' : 'Source'}: {ownVideoSource}{' '}
              <span className={styles.creditLicense}>({vi ? 'bạn xác nhận có quyền sử dụng' : 'you confirmed you may use it'})</span>
            </p>
          )}

          {focusedPreset && !stageYoutube && (
            <p className={styles.credit}>
              {vi ? 'Video' : 'Video'}: {focusedPreset.credit.author} ·{' '}
              <a href={focusedPreset.credit.sourceUrl} target="_blank" rel="noopener noreferrer">
                {focusedPreset.credit.provider}
              </a>{' '}
              <span className={styles.creditLicense}>({vi ? 'Giấy phép Pexels' : 'Pexels License'})</span>
            </p>
          )}
        </section>

        {/* ─── Library ───────────────────────────────────────────────────────────── */}
        <section className={styles.library} aria-labelledby="wallpaper-studio-title">
          <header className={styles.libraryHeader}>
            <div>
              <p className={styles.eyebrow}>{vi ? 'Hình nền' : 'Wallpapers'}</p>
              <h2 id="wallpaper-studio-title" className={styles.heading}>
                {vi ? 'Chọn khung cảnh cho giờ học' : 'Set the scene for your study'}
              </h2>
              <p className={styles.sub}>{vi ? 'Video thật, phát ngay trên trình duyệt của bạn.' : 'Real footage, played right in your browser.'}</p>
            </div>
          </header>

          <div className={styles.tabs} role="tablist" aria-label={vi ? 'Bộ sưu tập' : 'Collections'}>
            {([['all', vi ? 'Tất cả' : 'All'], ['link', vi ? 'YouTube · Liên kết' : 'YouTube · Links'], ...WALLPAPER_COLLECTIONS.map((c) => [c.id, vi ? c.vi : c.en])] as [Tab, string][]).map(
              ([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  className={`${styles.tab} ${id === 'link' ? styles.tabLink : ''}`}
                  onClick={() => setTab(id)}
                  data-testid={id === 'link' ? 'wallpaper-tab-link' : undefined}
                >
                  {id === 'link' && <span className={styles.tabMark} aria-hidden="true" />}
                  {label}
                </button>
              ),
            )}
          </div>

          <div className={styles.scroller} role="tabpanel">
            {tab === 'link' ? (
              <div className={styles.linkPane}>
                <label htmlFor="wallpaper-link" className={styles.linkLabel}>
                  {vi ? 'Dán liên kết YouTube' : 'Paste a YouTube link'}
                  <span className={styles.linkLabelSub}>{vi ? 'hoặc liên kết HTTPS tới một ảnh / video' : 'or an HTTPS link to an image / video'}</span>
                </label>
                <div className={styles.linkRow}>
                  <input
                    ref={linkInputRef}
                    id="wallpaper-link"
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={vi ? 'Dán URL video YouTube bạn muốn sử dụng' : 'Paste the URL of the YouTube video you want'}
                    value={linkInput}
                    onChange={(e) => onLinkChange(e.target.value)}
                    data-testid="wallpaper-link-input"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        tryLink();
                      }
                    }}
                    className={styles.linkInput}
                    aria-describedby="wallpaper-link-hint"
                  />
                  <button type="button" className={styles.secondary} onClick={tryLink}>
                    {vi ? 'Xem thử' : 'Preview'}
                  </button>
                </div>
                <p id="wallpaper-link-hint" className={styles.linkHint}>
                  {vi
                    ? 'youtube.com, youtu.be, Shorts, Live. Ảnh / video: MP4, WebM, JPG, PNG, WebP, GIF, AVIF. Video YouTube đã lưu đi theo tài khoản của bạn.'
                    : 'youtube.com, youtu.be, Shorts, Live. Images / videos: MP4, WebM, JPG, PNG, WebP, GIF, AVIF. Saved YouTube videos stay with your account.'}
                </p>
                {linkError(linkCheck) && <p className={styles.linkError} role="alert">{linkError(linkCheck)}</p>}
                {youtubeVideo && (
                  <div className={styles.youtubeNote} role="status" data-testid="wallpaper-youtube-found">
                    <div className={styles.ytFound}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img className={styles.ytThumb} src={youtubeThumbnails(youtubeVideo)[2]} alt="" decoding="async" referrerPolicy="no-referrer" />
                      <div className={styles.ytFoundText}>
                        <span className={styles.ytFoundKicker}>{vi ? 'Đã nhận ra video YouTube' : 'YouTube video recognised'}</span>
                        <span className={styles.ytFoundId}>
                          {vi ? 'Mã video' : 'Video ID'} · <code>{youtubeVideo}</code>
                        </span>
                        <a className={styles.ytFoundLink} href={youtubeWatchUrl(youtubeVideo)} target="_blank" rel="noopener noreferrer">
                          {vi ? 'Mở trên YouTube' : 'Open on YouTube'}
                        </a>
                      </div>
                    </div>
                    <p>
                      {vi
                        ? 'Chọn “Áp dụng” để video này phát phía sau giao diện học: tắt tiếng, lặp lại, không có thanh điều khiển. Video phát trực tiếp từ YouTube tới trình duyệt của bạn; video bị chủ sở hữu tắt nhúng, riêng tư hoặc bị giới hạn sẽ không phát được.'
                        : 'Choose “Apply” to play this video behind your lessons: muted, looping, without controls. It streams straight from YouTube to your browser; videos whose owner turned off embedding, and private or restricted videos, cannot play.'}
                    </p>
                    <div className={styles.ytActions}>
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => {
                          // The YouTube player takes the stage back from a preview of the learner's own video.
                          if (focus.type === 'library') {
                            setFocus({ type: 'none' });
                            if (youtubeVideo) setDraft(youtubeDraft(youtubeVideo));
                            setYoutubeOpen(true);
                          } else {
                            setYoutubeOpen((open) => !open);
                          }
                        }}
                        aria-pressed={youtubeOpen && !!stageYoutube}
                      >
                        {youtubeOpen && stageYoutube ? (vi ? 'Đóng trình phát' : 'Close player') : vi ? 'Phát trong khung xem trước' : 'Play in the preview'}
                      </button>
                      {signedIn ? (
                        <button
                          type="button"
                          className={styles.ghost}
                          // aria-disabled, not disabled: a disabled button drops keyboard focus out of the dialog.
                          onClick={saveCurrentYoutube}
                          aria-disabled={youtubeSaved || libraryBusy !== null}
                          data-testid="wallpaper-youtube-save"
                        >
                          {youtubeSaved
                            ? vi ? 'Đã lưu vào video của tôi' : 'Saved to my videos'
                            : libraryBusy === 'save' ? (vi ? 'Đang lưu…' : 'Saving…') : vi ? 'Lưu vào video của tôi' : 'Save to my videos'}
                        </button>
                      ) : (
                        <span className={styles.ytSavedNote}>{vi ? 'Đăng nhập để lưu video vào tài khoản.' : 'Sign in to save videos to your account.'}</span>
                      )}
                    </div>

                    {savedEntry && (
                      <div className={styles.ownVideo} data-testid="wallpaper-own-video">
                        <p className={styles.ownVideoTitle}>{vi ? 'Video nền của bạn cho mục này' : 'Your background video for this entry'}</p>
                        {savedEntry.background ? (
                          <>
                            <p className={styles.ownVideoState} data-testid="wallpaper-own-video-state">
                              {savedEntry.background.kind === 'LINK' ? (
                                <>{vi ? 'Liên kết video' : 'Video link'} · <code>{safeHost(savedEntry.background.url ?? '')}</code></>
                              ) : (
                                <>
                                  {vi ? 'Tệp' : 'File'} · <code>{savedEntry.background.fileName}</code> ·{' '}
                                  {deviceEntries.has(savedEntry.id)
                                    ? vi ? 'trên thiết bị này' : 'on this device'
                                    : vi ? 'nằm trên thiết bị khác — chọn lại tệp để dùng ở đây' : 'on another device — choose the file again to use it here'}
                                </>
                              )}
                            </p>
                            <div className={styles.ytActions}>
                              <button
                                type="button"
                                className={styles.secondary}
                                onClick={() => {
                                  if (savedEntry.background?.kind === 'FILE' && !deviceEntries.has(savedEntry.id)) return;
                                  previewEntryBackground(savedEntry);
                                }}
                                aria-disabled={savedEntry.background.kind === 'FILE' && !deviceEntries.has(savedEntry.id)}
                                aria-pressed={focus.type === 'library' && focus.entryId === savedEntry.id}
                                data-testid="wallpaper-own-video-preview"
                              >
                                {vi ? 'Xem thử làm hình nền' : 'Preview as wallpaper'}
                              </button>
                              <button type="button" className={styles.ghost} onClick={() => detachBackground(savedEntry)} aria-disabled={libraryBusy !== null}>
                                {vi ? 'Gỡ video nền' : 'Remove background video'}
                              </button>
                            </div>
                          </>
                        ) : (
                          <p className={styles.ownVideoHint}>
                            {vi
                              ? 'Nếu bạn có quyền dùng bản gốc của video này (ví dụ video do bạn quay, hoặc có giấy phép cho phép), hãy gắn tệp hoặc liên kết tệp video. English Coach sẽ phát bản đó làm hình nền — không phải trình phát YouTube, và không tải gì từ YouTube.'
                              : 'If you may use the original of this video (you filmed it, or its licence allows it), attach the file or a link to the file. English Coach plays that copy as the wallpaper — not the YouTube player, and nothing is taken from YouTube.'}
                          </p>
                        )}
                        <label className={styles.ownVideoRights}>
                          <input type="checkbox" checked={bgRights} onChange={(e) => setBgRights(e.target.checked)} data-testid="wallpaper-own-video-rights" />
                          <span>{vi ? 'Tôi có quyền sử dụng bản video này làm hình nền.' : 'I may use this copy of the video as a wallpaper.'}</span>
                        </label>
                        <div className={styles.ytActions}>
                          <input
                            ref={bgFileRef}
                            type="file"
                            accept="video/mp4,video/webm,video/quicktime,.mp4,.m4v,.webm,.mov"
                            className={styles.visuallyHidden}
                            tabIndex={-1}
                            aria-hidden="true"
                            onChange={(e) => {
                              attachFile(savedEntry, e.target.files?.[0]);
                              e.target.value = '';
                            }}
                            data-testid="wallpaper-own-video-file"
                          />
                          <button
                            type="button"
                            className={styles.secondary}
                            onClick={() => { if (bgRights && !libraryBusy) bgFileRef.current?.click(); }}
                            aria-disabled={!bgRights || libraryBusy !== null}
                            data-testid="wallpaper-own-video-choose"
                          >
                            {libraryBusy === 'file' ? (vi ? 'Đang lưu tệp…' : 'Keeping the file…') : vi ? 'Chọn tệp video trên máy' : 'Choose a video file'}
                          </button>
                          <span className={styles.ytSavedNote}>{vi ? 'Tệp ở lại trong trình duyệt này, không tải lên máy chủ.' : 'The file stays in this browser; nothing is uploaded.'}</span>
                        </div>
                        <div className={styles.linkRow}>
                          <input
                            type="url"
                            inputMode="url"
                            autoComplete="off"
                            spellCheck={false}
                            className={styles.linkInput}
                            placeholder={vi ? 'hoặc liên kết https:// tới tệp MP4 / WebM' : 'or an https:// link to an MP4 / WebM file'}
                            value={bgLink}
                            onChange={(e) => setBgLink(e.target.value)}
                            aria-label={vi ? 'Liên kết tệp video nền' : 'Background video file link'}
                            data-testid="wallpaper-own-video-link"
                          />
                          <button
                            type="button"
                            className={styles.secondary}
                            onClick={() => { if (bgRights && bgLink.trim() && !libraryBusy) attachLink(savedEntry); }}
                            aria-disabled={!bgRights || !bgLink.trim() || libraryBusy !== null}
                            data-testid="wallpaper-own-video-attach"
                          >
                            {libraryBusy === 'link' ? (vi ? 'Đang gắn…' : 'Attaching…') : vi ? 'Gắn liên kết' : 'Attach link'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {libraryMessage && <p className={styles.linkError} role="alert" data-testid="wallpaper-library-message">{libraryMessage}</p>}
                {stageYoutube && stageState === 'failed' && (
                  <p className={styles.linkError} role="alert">
                    {vi
                      ? 'YouTube không có ảnh cho mã video này: video có thể không tồn tại, đã bị xóa hoặc đang ở chế độ riêng tư.'
                      : 'YouTube has no picture for this video ID: it may not exist, may have been removed, or may be private.'}
                  </p>
                )}
                {focus.type === 'library' && stageState === 'failed' && (
                  <p className={styles.linkError} role="alert">
                    {draft.media === 'file'
                      ? vi ? 'Trình duyệt không phát được tệp này (thiếu tệp hoặc định dạng không được hỗ trợ).' : 'This browser cannot play the file (missing, or an unsupported format).'
                      : vi ? 'Không phát được video từ liên kết này (máy chủ từ chối, cần đăng nhập, hoặc không phải tệp video).' : 'The video at this link could not be played (refused, needs a sign-in, or not a video file).'}
                  </p>
                )}
                {focus.type === 'custom' && !youtubeVideo && stageState === 'failed' && (
                  <p className={styles.linkError} role="alert">
                    {vi
                      ? 'Không mở được nội dung từ liên kết này (máy chủ từ chối, cần đăng nhập, hoặc định dạng không được hỗ trợ).'
                      : 'This link could not be opened (the server refused it, it needs a sign-in, or the format is not supported).'}
                  </p>
                )}
                {signedIn && (
                  <section className={styles.ytSaved} aria-labelledby="wallpaper-yt-saved" data-testid="wallpaper-youtube-saved" data-library-state={library?.status ?? 'idle'}>
                    <h3 id="wallpaper-yt-saved" className={styles.ytSavedTitle}>
                      {vi ? 'Video YouTube của tôi' : 'My YouTube videos'}
                      <span className={styles.ytSavedNote}>{vi ? 'lưu trong tài khoản' : 'kept with your account'}</span>
                    </h3>
                    {library?.moved && library.moved.imported > 0 && (
                      <p className={styles.linkHint}>
                        {vi ? `Đã chuyển ${library.moved.imported} video đã lưu trên thiết bị này vào tài khoản.` : `Moved ${library.moved.imported} videos saved on this device into your account.`}
                        {library.moved.overLimit > 0 && (vi ? ` ${library.moved.overLimit} video không vừa giới hạn.` : ` ${library.moved.overLimit} did not fit the limit.`)}
                      </p>
                    )}
                    {(!library || library.status === 'loading') && savedYoutube.length === 0 && (
                      <p className={styles.linkHint}>{vi ? 'Đang tải video đã lưu…' : 'Loading your saved videos…'}</p>
                    )}
                    {library?.status === 'error' && (
                      <p className={styles.linkError} role="alert">
                        {vi ? 'Chưa tải được danh sách.' : 'Could not load your list.'}{' '}
                        <button type="button" className={styles.inlineRetry} onClick={() => void loadLibrary(storageKey)}>
                          {vi ? 'Thử lại' : 'Retry'}
                        </button>
                      </p>
                    )}
                    {library?.status === 'ready' && savedYoutube.length === 0 && (
                      <p className={styles.linkHint}>{vi ? 'Chưa có video nào. Dán một liên kết YouTube rồi chọn “Lưu vào video của tôi”.' : 'No videos yet. Paste a YouTube link, then “Save to my videos”.'}</p>
                    )}
                    {savedYoutube.length > 0 && (
                      <ul className={styles.ytSavedList}>
                        {savedYoutube.map((item) => (
                          <li key={item.id} className={styles.ytSavedItem} data-youtube-id={item.videoId} data-entry-id={item.id}>
                            <button
                              type="button"
                              className={styles.ytSavedOpen}
                              aria-pressed={youtubeVideo === item.videoId}
                              onClick={() => openSavedYoutube(item.videoId)}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img className={styles.ytSavedThumb} src={youtubeThumbnails(item.videoId)[2]} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                              <span className={styles.ytSavedMeta}>
                                <code>{item.videoId}</code>
                                {item.background && <span className={styles.ytSavedBadge}>{vi ? 'Có video nền' : 'Has background'}</span>}
                              </span>
                            </button>
                            <button
                              type="button"
                              className={styles.ytSavedRemove}
                              onClick={() => removeEntry(item)}
                              aria-label={vi ? `Xóa video ${item.videoId}` : `Remove video ${item.videoId}`}
                            >
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}
              </div>
            ) : (
              <ul className={styles.grid}>
                {tab === 'all' && (
                  <li>
                    <button
                      type="button"
                      className={`${styles.card} ${styles.cardDefault}`}
                      aria-pressed={focus.type === 'none'}
                      onClick={chooseDefault}
                    >
                      <span className={styles.cardDefaultArt} aria-hidden="true" />
                      <span className={styles.cardText}>
                        <span className={styles.cardKicker}>{vi ? 'Mặc định' : 'Default'}</span>
                        <span className={styles.cardTitle}>{vi ? 'Nền English Coach' : 'English Coach'}</span>
                      </span>
                      {!appliedKey && <span className={styles.inUse}>{vi ? 'Đang dùng' : 'In use'}</span>}
                    </button>
                  </li>
                )}
                {tab === 'all' && (
                  <li>
                    <button type="button" className={`${styles.card} ${styles.cardYoutube}`} onClick={openLinkTab} data-testid="wallpaper-youtube-card">
                      <span className={styles.cardYoutubeArt} aria-hidden="true">
                        <span className={styles.cardYoutubeMark}>
                          <Play className="h-5 w-5" fill="currentColor" />
                        </span>
                      </span>
                      <span className={styles.cardText}>
                        <span className={styles.cardKicker}>YouTube</span>
                        <span className={styles.cardTitle}>{vi ? 'Dán liên kết video' : 'Paste a video link'}</span>
                      </span>
                    </button>
                  </li>
                )}
                {visiblePresets.map((preset) => {
                  const focused = focus.type === 'preset' && focus.id === preset.id;
                  return (
                    <li key={preset.id}>
                      <button
                        type="button"
                        className={styles.card}
                        aria-pressed={focused}
                        onClick={() => choosePreset(preset)}
                        style={{ '--card-accent': preset.accent } as React.CSSProperties}
                        data-preset={preset.id}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className={styles.cardImage} src={posterUrl(preset, 560)} alt="" loading="lazy" decoding="async" />
                        <span className={styles.cardText}>
                          <span className={styles.cardKicker}>{collectionName(preset.collection)}</span>
                          <span className={styles.cardTitle}>{vi ? preset.titleVi : preset.titleEn}</span>
                        </span>
                        {appliedKey === `preset:${preset.id}` && <span className={styles.inUse}>{vi ? 'Đang dùng' : 'In use'}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <footer className={styles.footer}>
            {applyError && <p className={styles.applyError} role="alert">{errorText(applyError)}</p>}
            <div className={styles.footerRow}>
              <p className={styles.footerNote}>{vi ? 'Áp dụng sẽ thay giao diện đang dùng. Lựa chọn cũ vẫn được nhớ.' : 'Applying replaces what is in use. Your earlier choice stays remembered.'}</p>
              <div className={styles.footerActions}>
                <button type="button" className={styles.secondary} onClick={close} disabled={applying}>
                  {vi ? 'Hủy' : 'Cancel'}
                </button>
                <button
                  type="button"
                  className={styles.primary}
                  onClick={apply}
                  disabled={!canApply}
                  data-testid="wallpaper-apply"
                >
                  {applying ? (vi ? 'Đang chuẩn bị…' : 'Preparing…') : vi ? 'Áp dụng' : 'Apply'}
                </button>
              </div>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className={styles.control} role="group" aria-label={label}>
      <span className={styles.controlLabel}>{label}</span>
      <div className={styles.segmented}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={styles.segment}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The focused preset, really playing: its poster first, then its smallest video file once frames advance. */
function StagePreset({
  stageKey,
  preset,
  still,
  onReport,
}: {
  stageKey: string;
  preset: WallpaperPreset;
  still: boolean;
  onReport: StageReporter;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoOn, setVideoOn] = useState(false);
  const file = previewRendition(preset);
  const onState = useCallback((state: StageState) => onReport(stageKey, state), [onReport, stageKey]);

  useEffect(() => {
    if (still) return;
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      if (video.currentTime > 0 && !video.paused) {
        setVideoOn(true);
        onState('playing');
        video.removeEventListener('timeupdate', onTime);
      }
    };
    const onError = () => onState('failed');
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('error', onError);
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.src = file.url;
    video.play().catch((error: DOMException) => {
      if (error?.name === 'NotAllowedError') onState('still');
    });
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('error', onError);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [file.url, still, onState]);

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className={styles.stageMedia}
        src={posterUrl(preset, 1280)}
        alt=""
        decoding="async"
        style={preset.focus ? { objectPosition: preset.focus } : undefined}
        onLoad={() => { if (still) onState('still'); }}
      />
      {!still && (
        <video
          ref={videoRef}
          className={`${styles.stageMedia} ${styles.stageVideo} ${videoOn ? styles.stageVideoOn : ''}`}
          style={preset.focus ? { objectPosition: preset.focus } : undefined}
          muted
          loop
          playsInline
          preload="auto"
          disablePictureInPicture
          tabIndex={-1}
          aria-hidden="true"
          data-testid="wallpaper-preview-video"
        />
      )}
    </>
  );
}

/**
 * A YouTube video on the stage: YouTube's own thumbnail, sharpest first. A missing size answers 404 or YouTube's
 * 120 px grey placeholder; both move on to the next size. No thumbnail at all ⇒ "failed" (the player can still be opened).
 */
function StageYouTube({ stageKey, id, onReport }: { stageKey: string; id: string; onReport: StageReporter }) {
  const sources = youtubeThumbnails(id);
  const [index, setIndex] = useState(0);
  const onState = useCallback((state: StageState) => onReport(stageKey, state), [onReport, stageKey]);
  const next = () => {
    if (index < sources.length - 1) setIndex(index + 1);
    else onState('failed');
  };
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`${styles.stageMedia} ${styles.ytStill}`}
      src={sources[index]}
      alt=""
      decoding="async"
      referrerPolicy="no-referrer"
      data-testid="wallpaper-youtube-thumbnail"
      onLoad={(event) => {
        if (event.currentTarget.naturalWidth <= 120) next();
        else onState('still');
      }}
      onError={next}
    />
  );
}

/** A learner's link: proven by the browser itself (image decode, or video frames) before it can be applied. */
function StageCustom({
  stageKey,
  preview,
  still,
  onReport,
  onKind,
}: {
  stageKey: string;
  preview: { url: string; kind: WallpaperKind | 'unknown' };
  still: boolean;
  onReport: StageReporter;
  onKind: (kind: WallpaperKind) => void;
}) {
  const onState = useCallback((state: StageState) => onReport(stageKey, state), [onReport, stageKey]);
  // An unknown extension is tried as an image first, then as a video.
  const [kind, setKind] = useState<WallpaperKind>(preview.kind === 'video' ? 'video' : 'image');
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (kind !== 'video') return;
    const video = videoRef.current;
    if (!video) return;
    let done = false;
    const ok = (state: 'playing' | 'still') => {
      if (done) return;
      done = true;
      onKind('video');
      onState(state);
    };
    const onTime = () => {
      if (video.currentTime > 0 && !video.paused) ok('playing');
    };
    const onLoaded = () => {
      if (still) ok('still');
    };
    const onError = () => {
      if (!done) onState('failed');
    };
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('error', onError);
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.src = preview.url;
    if (!still) {
      video.play().catch((error: DOMException) => {
        if (error?.name === 'NotAllowedError') video.addEventListener('loadeddata', () => ok('still'), { once: true });
      });
    }
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [kind, preview.url, still, onKind, onState]);

  if (kind === 'image') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className={styles.stageMedia}
        src={preview.url}
        alt=""
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => {
          onKind('image');
          onState('still');
        }}
        onError={() => {
          if (preview.kind === 'unknown') setKind('video');
          else onState('failed');
        }}
      />
    );
  }
  return (
    <video
      ref={videoRef}
      className={`${styles.stageMedia} ${styles.stageVideoOn}`}
      muted
      loop
      playsInline
      preload="auto"
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}

/**
 * The learner's own video attached to a saved YouTube entry, really playing on the stage: a direct link (loaded by the
 * browser from its host) or a file kept in this browser (read from the account's IndexedDB into a blob: URL). Proven
 * the same way as a learner link: frames must advance before it can be applied.
 */
function StageOwnVideo({
  stageKey,
  accountId,
  entryId,
  media,
  url,
  still,
  onReport,
  onKind,
}: {
  stageKey: string;
  accountId: string;
  entryId: string;
  media: 'link' | 'file' | undefined;
  url: string | undefined;
  still: boolean;
  onReport: StageReporter;
  onKind: (kind: WallpaperKind) => void;
}) {
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  useEffect(() => {
    if (media !== 'file') return;
    let live = true;
    let objectUrl: string | null = null;
    getDeviceVideo(accountId, entryId)
      .then((stored) => {
        if (!live) return;
        if (!stored) {
          onReport(stageKey, 'failed');
          return;
        }
        objectUrl = URL.createObjectURL(stored.blob);
        setFileUrl(objectUrl);
      })
      .catch(() => { if (live) onReport(stageKey, 'failed'); });
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [media, accountId, entryId, stageKey, onReport]);

  const source = media === 'link' ? url : media === 'file' ? fileUrl : null;
  if (!source) return null;
  return <StageCustom stageKey={stageKey} preview={{ url: source, kind: 'video' }} still={still} onReport={onReport} onKind={onKind} />;
}

/** Host + path of a link, for display only (never used to build a request). */
function safeHost(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 28 ? `${parsed.pathname.slice(0, 26)}…` : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return '';
  }
}

/** A miniature of the workspace over the stage: rail, bar and cards under the chosen veil, to judge readability. */
function AppMiniature({ dark, vi }: { dark: boolean; vi: boolean }) {
  return (
    <div className={`${styles.mini} ${dark ? styles.miniDark : ''}`} aria-hidden="true">
      <div className={styles.miniVeil} />
      <div className={styles.miniRail}>
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className={`${styles.miniDot} ${i === 1 ? styles.miniDotOn : ''}`} />
        ))}
      </div>
      <div className={styles.miniBody}>
        <div className={styles.miniBar} />
        <p className={styles.miniHeading}>{vi ? 'Luyện nghe hôm nay' : 'Today’s listening'}</p>
        <div className={styles.miniCards}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.miniCard}>
              <span className={styles.miniLineStrong} />
              <span className={styles.miniLine} />
              <span className={styles.miniLineShort} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
