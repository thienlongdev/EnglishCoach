'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { PublicPartDto, PublicGroupDto, PublicItemDto } from '@/types/exams';
import {
  Volume2,
  VolumeX,
  Play,
  Pause,
  Headphones,
  AlertCircle,
  Lock,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { ExamAssetImage } from './ExamAssetImage';
import { getExamAssetUrl, isAudioAsset, isImageAsset, partNumberFromCode } from '@/lib/exams/media';
import { formatClock, itemOptions, numberRange, selectedChoice, toeicPartName, toeicPartTerm } from '@/lib/exams/runnerModel';
import { ChoiceOptions } from './runner/ChoiceOptions';
import { FlagToggle } from './runner/FlagToggle';

interface ToeicListeningWorkspaceProps {
  parts?: PublicPartDto[];
  groups?: PublicGroupDto[];
  audioUrl?: string;
  attemptId?: string;
  responses: Record<string, any>;
  onAnswerChange: (placementId: string, value: any) => void;
  flaggedPlacements: string[];
  onToggleFlag: (placementId: string) => void;
  activePlacementId?: string;
  onSelectPlacement: (placementId: string) => void;
  isSimulation?: boolean;
  onCompleteListening?: () => void;
  remainingSeconds?: number;
  /** Exams Phase 7: printed question numbers computed once by the shell. */
  questionNumbers?: Map<string, number>;
  lang?: 'vi' | 'en';
}

interface FlattenedToeicItem {
  item: PublicItemDto;
  group: PublicGroupDto;
  part: PublicPartDto;
  partNumber: number; // 1, 2, 3, 4
  questionNumber: number;
  globalIndex: number;
}

type AudioState = 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

/**
 * TOEIC Listening workspace (Exams Phase 7).
 *  - Simulation: one start gesture, then the recording runs through the parts without pause or rewind; the section
 *    completes only when the last recording ends (unchanged Phase 4 contract).
 *  - Practice: the learner starts and pauses the recording (same semantics as IELTS practice); no seeking, no
 *    replay is added, and the end of the audio never completes the section.
 *  - Part 1: the photo is central and uncropped; Part 2: exactly the printed options (three); Part 3 / 4: one
 *    conversation / talk = one set of questions with its graphic shown once.
 */
export function ToeicListeningWorkspace({
  parts = [],
  groups = [],
  audioUrl,
  attemptId,
  responses,
  onAnswerChange,
  flaggedPlacements,
  onToggleFlag,
  activePlacementId,
  onSelectPlacement,
  isSimulation = true,
  onCompleteListening,
  questionNumbers,
  lang = 'vi',
}: ToeicListeningWorkspaceProps) {
  const activeParts: PublicPartDto[] = useMemo(() => {
    if (parts && parts.length > 0) return parts;
    if (groups && groups.length > 0) {
      return [{ id: 'part-listening', partCode: 'LISTENING', ordinal: 1, instructions: '', groups }];
    }
    return [];
  }, [parts, groups]);

  const allItems: FlattenedToeicItem[] = useMemo(() => {
    let fallback = 1;
    const list: FlattenedToeicItem[] = [];
    activeParts.forEach((part, pIdx) => {
      // EXAM-AUD-037: printed part from partCode ("LISTENING_PART_3"); array position only as a legacy fallback.
      const codeNum = partNumberFromCode(part.partCode);
      const partNumber = codeNum && codeNum >= 1 && codeNum <= 4 ? codeNum : Math.min(4, pIdx + 1);
      (part.groups || []).forEach((group) => {
        (group.items || []).forEach((item) => {
          const n = questionNumbers?.get(item.placementId) ?? fallback;
          fallback = n + 1;
          list.push({ item, group, part, partNumber, questionNumber: n, globalIndex: list.length });
        });
      });
    });
    return list;
  }, [activeParts, questionNumbers]);

  const [currentIndex, setCurrentIndex] = useState<number>(0);

  useEffect(() => {
    if (!activePlacementId) return;
    const idx = allItems.findIndex((it) => it.item.placementId === activePlacementId);
    if (idx >= 0) setCurrentIndex(idx);
  }, [activePlacementId, allItems]);

  const current = allItems[currentIndex] || allItems[0];
  const currentPartNum = current?.partNumber || 1;
  const currentGroup = current?.group;
  const groupItems = useMemo(
    () => (currentGroup ? allItems.filter((it) => it.group.id === currentGroup.id) : []),
    [allItems, currentGroup]
  );
  const partSets = useMemo(() => (current?.part?.groups || []).filter((g) => (g.items || []).length > 0), [current]);
  const setIndex = currentGroup ? partSets.findIndex((g) => g.id === currentGroup.id) : -1;

  const presentParts = useMemo(() => {
    const seen = new Map<number, FlattenedToeicItem>();
    allItems.forEach((it) => {
      if (!seen.has(it.partNumber)) seen.set(it.partNumber, it);
    });
    return Array.from(seen.entries()).sort(([a], [b]) => a - b);
  }, [allItems]);

  // ─── Audio ────────────────────────────────────────────────────────────────────────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioState, setAudioState] = useState<AudioState>('loading');
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [audioUnlocked, setAudioUnlocked] = useState<boolean>(false);

  // Exams Phase 4B.8 / EXAM-AUD-010: when each part carries its OWN audio asset (per-part recordings or the explicit
  // derived part segments of a whole-test recording), play them as an ordered playlist and finish Listening only after
  // the LAST part ends. A single section-wide recording keeps the historical single-file behaviour.
  const partAudioAssets = useMemo(
    () =>
      activeParts.map(
        (part) =>
          (part.groups || [])
            .flatMap((g) => g.stimuli || [])
            .flatMap((st) => st.assets || [])
            .find((a) => isAudioAsset(a) && !!a.assetId) || null
      ),
    [activeParts]
  );
  const playlistMode = useMemo(
    () => new Set(partAudioAssets.filter(Boolean).map((a) => a!.assetId)).size > 1,
    [partAudioAssets]
  );
  const [audioPartIdx, setAudioPartIdx] = useState<number>(() => Math.max(0, partAudioAssets.findIndex(Boolean)));
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!playlistMode) return;
    const asset = partAudioAssets[audioPartIdx];
    if (!asset || !attemptId) {
      setPlaylistUrl(null);
      return;
    }
    let cancelled = false;
    getExamAssetUrl(attemptId, asset.assetId).then((url) => {
      if (!cancelled) {
        setPlaylistUrl(url);
        if (!url) setAudioState('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [playlistMode, partAudioAssets, audioPartIdx, attemptId]);

  const effectiveAudioUrl = playlistMode ? playlistUrl || undefined : audioUrl;

  const startPlayback = () => {
    setAudioUnlocked(true);
    const audio = audioRef.current;
    if (!audio) return;
    audio
      .play()
      .then(() => setAudioState(audio.paused ? 'paused' : 'playing'))
      .catch((err) => {
        console.warn('[ToeicListening] Playback request failed:', err);
        setAudioState('paused');
      });
  };

  const togglePlayback = () => {
    if (isSimulation) return; // simulation: no pause
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      setAudioState('paused');
    } else if (audioState !== 'ended') {
      startPlayback();
    }
  };

  const handleAudioEnded = () => {
    if (playlistMode) {
      let next = audioPartIdx + 1;
      while (next < partAudioAssets.length && !partAudioAssets[next]) next++;
      if (next < partAudioAssets.length) {
        setAudioPartIdx(next);
        setCurrentTime(0);
        setDuration(0);
        return;
      }
    }
    setAudioState('ended');
    if (onCompleteListening) {
      onCompleteListening();
    }
  };

  const handleVolumeChange = (newVol: number) => {
    setVolume(newVol);
    if (audioRef.current) {
      audioRef.current.volume = newVol;
      audioRef.current.muted = newVol === 0;
      setIsMuted(newVol === 0);
    }
  };

  const toggleMute = () => {
    if (audioRef.current) {
      const nextMuted = !isMuted;
      audioRef.current.muted = nextMuted;
      setIsMuted(nextMuted);
    }
  };

  // ─── Visuals ──────────────────────────────────────────────────────────────────────────────────────────────────
  const groupImageAsset =
    currentGroup?.stimuli?.flatMap((st) => st.assets || []).find((a) => isImageAsset(a) && a.delivery === 'PLAYBACK_GRANT') ||
    null;

  const select = (idx: number) => {
    const target = allItems[idx];
    if (!target) return;
    if (isSimulation && target.partNumber !== currentPartNum && idx < currentIndex) return; // no going back across parts
    setCurrentIndex(idx);
    onSelectPlacement(target.item.placementId);
  };

  const choose = (pid: string, optionId: string) => onAnswerChange(pid, { value: optionId });

  if (allItems.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-sm text-muted-foreground">
        {lang === 'vi' ? 'Phần này chưa có câu hỏi để hiển thị.' : 'This part has no questions to show.'}
      </div>
    );
  }

  const audioEl = effectiveAudioUrl ? (
    <audio
      key={effectiveAudioUrl}
      data-capability="PER_PART_AUDIO_PLAYLIST"
      ref={audioRef}
      src={effectiveAudioUrl}
      preload="auto"
      autoPlay={audioUnlocked && isSimulation}
      onCanPlay={() => setAudioState((s) => (s === 'loading' || s === 'error' ? 'ready' : s))}
      onPlaying={() => setAudioState('playing')}
      onEmptied={() => setAudioState('loading')}
      onPause={() => setAudioState((s) => (s === 'ended' ? s : 'paused'))}
      onTimeUpdate={() => audioRef.current && setCurrentTime(audioRef.current.currentTime)}
      onLoadedMetadata={() => {
        const d = audioRef.current?.duration;
        if (d && Number.isFinite(d) && d > 0) setDuration(d);
      }}
      onError={() => setAudioState('error')}
      onEnded={handleAudioEnded}
    />
  ) : null;

  // Simulation start gate (browser autoplay needs one gesture; no pause afterwards)
  if (!audioUnlocked && isSimulation) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-background p-4 sm:p-6">
        <div className="max-w-md w-full bg-card border border-border rounded-2xl p-6 sm:p-8 text-center space-y-5">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 mx-auto flex items-center justify-center">
            <Headphones className="w-7 h-7" aria-hidden />
          </div>
          <div className="space-y-2">
            <h2 className="text-lg font-bold text-foreground">{lang === 'vi' ? 'Phần Nghe TOEIC' : 'TOEIC Listening'}</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {lang === 'vi'
                ? 'Bản ghi phát liên tục qua các Part như khi thi thật. Sau khi bắt đầu, bạn không thể tạm dừng hoặc tua lại.'
                : 'The recording runs through the parts like the real test. Once started it cannot be paused or rewound.'}
            </p>
          </div>
          {audioEl}
          {effectiveAudioUrl ? (
            <button
              id="toeic-start-listening-btn"
              type="button"
              onClick={startPlayback}
              className="w-full h-12 px-6 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Play className="w-5 h-5 fill-current" aria-hidden />
              {lang === 'vi' ? 'Bắt đầu phần Nghe' : 'Start Listening'}
            </button>
          ) : (
            <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/10 text-sm text-left flex items-start gap-3">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-rose-600" aria-hidden />
              <div>
                <p className="font-semibold text-foreground">{lang === 'vi' ? 'Chưa tải được âm thanh' : 'Audio could not be loaded'}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {lang === 'vi'
                    ? 'Phần Nghe chỉ bắt đầu khi bản ghi sẵn sàng. Hãy tải lại trang hoặc quay lại sau.'
                    : 'Listening starts only when the recording is ready. Reload the page or come back later.'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const statusText =
    audioState === 'playing'
      ? lang === 'vi' ? 'Đang phát' : 'Playing'
      : audioState === 'paused'
      ? lang === 'vi' ? 'Đã tạm dừng' : 'Paused'
      : audioState === 'ended'
      ? lang === 'vi' ? 'Đã phát xong' : 'Finished'
      : audioState === 'error'
      ? lang === 'vi' ? 'Không tải được âm thanh' : 'Audio unavailable'
      : audioState === 'ready'
      ? lang === 'vi' ? 'Sẵn sàng' : 'Ready'
      : lang === 'vi' ? 'Đang tải âm thanh…' : 'Loading audio…';

  const renderSetQuestion = (entry: FlattenedToeicItem) => {
    const pid = entry.item.placementId;
    const promptId = `prompt-${pid}`;
    const isCurrent = entry.globalIndex === currentIndex;
    return (
      <article
        key={pid}
        id={`item-${pid}`}
        onFocusCapture={() => !isCurrent && select(entry.globalIndex)}
        className={`rounded-2xl border bg-card p-4 sm:p-5 ${isCurrent ? 'border-primary/60 ring-1 ring-primary/30' : 'border-border'}`}
      >
        <div className="flex items-start gap-3 mb-3">
          <span className="shrink-0 min-w-9 h-8 px-2 rounded-lg bg-primary/10 text-primary font-bold text-sm inline-flex items-center justify-center tabular-nums">
            {entry.questionNumber}
          </span>
          <p id={promptId} className="flex-1 text-[15px] leading-relaxed text-foreground pt-1">
            {entry.item.prompt || (lang === 'vi' ? `Câu ${entry.questionNumber}` : `Question ${entry.questionNumber}`)}
          </p>
          <FlagToggle flagged={flaggedPlacements.includes(pid)} onToggle={() => onToggleFlag(pid)} lang={lang} number={entry.questionNumber} />
        </div>
        <div className="sm:pl-12">
          <ChoiceOptions
            name={pid}
            options={itemOptions(entry.item)}
            value={selectedChoice(responses[pid])}
            onChange={(id) => choose(pid, id)}
            labelledBy={promptId}
            lang={lang}
          />
        </div>
      </article>
    );
  };

  const singleQuestionCard = (lettersHint: string) => {
    if (!current) return null;
    const pid = current.item.placementId;
    const promptId = `prompt-${pid}`;
    return (
      <div id={`item-${pid}`} className="w-full max-w-md mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 id={promptId} className="text-xl font-bold text-foreground tabular-nums">
            {lang === 'vi' ? `Câu ${current.questionNumber}` : `Question ${current.questionNumber}`}
          </h3>
          <FlagToggle flagged={flaggedPlacements.includes(pid)} onToggle={() => onToggleFlag(pid)} lang={lang} withLabel number={current.questionNumber} />
        </div>
        <p className="text-xs text-muted-foreground">{lettersHint}</p>
        <ChoiceOptions
          name={pid}
          options={itemOptions(current.item)}
          value={selectedChoice(responses[pid])}
          onChange={(id) => choose(pid, id)}
          labelledBy={promptId}
          lang={lang}
          density="roomy"
          lettersOnly
        />
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            id="toeic-listening-prev-btn"
            onClick={() => select(currentIndex - 1)}
            disabled={currentIndex === 0 || (isSimulation && allItems[currentIndex - 1]?.partNumber !== currentPartNum)}
            className="h-10 px-3 inline-flex items-center gap-1.5 rounded-lg border border-border text-xs font-semibold hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="w-4 h-4" aria-hidden />
            {lang === 'vi' ? 'Câu trước' : 'Previous'}
          </button>
          <button
            type="button"
            id="toeic-listening-next-btn"
            onClick={() => select(currentIndex + 1)}
            disabled={currentIndex >= allItems.length - 1}
            className="h-10 px-4 inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {lang === 'vi' ? 'Câu tiếp theo' : 'Next'}
            <ChevronRight className="w-4 h-4" aria-hidden />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {audioEl}

      {/* Compact, sticky audio bar */}
      <div className="shrink-0 border-b border-border bg-card/80 backdrop-blur px-3 sm:px-4 py-2 flex items-center gap-3" aria-label={lang === 'vi' ? 'Âm thanh' : 'Audio'}>
        {!isSimulation ? (
          <button
            type="button"
            id="toeic-practice-play-btn"
            onClick={togglePlayback}
            disabled={!effectiveAudioUrl || audioState === 'ended' || audioState === 'error'}
            aria-label={audioState === 'playing' ? (lang === 'vi' ? 'Tạm dừng' : 'Pause') : lang === 'vi' ? 'Phát' : 'Play'}
            className="shrink-0 w-10 h-10 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white inline-flex items-center justify-center disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {audioState === 'playing' ? <Pause className="w-4 h-4 fill-current" aria-hidden /> : <Play className="w-4 h-4 fill-current ml-0.5" aria-hidden />}
          </button>
        ) : (
          <span className="shrink-0 w-10 h-10 rounded-full bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 inline-flex items-center justify-center" aria-hidden>
            <Headphones className="w-4 h-4" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-semibold text-foreground truncate" role="status" aria-live="polite">
              {audioState === 'loading' && <Loader2 className="inline w-3 h-3 mr-1 animate-spin motion-reduce:animate-none" aria-hidden />}
              {audioState === 'ended' && <CheckCircle2 className="inline w-3.5 h-3.5 mr-1 text-emerald-600" aria-hidden />}
              {audioState === 'error' && <AlertCircle className="inline w-3.5 h-3.5 mr-1 text-rose-600" aria-hidden />}
              {statusText}
            </span>
            {playlistMode && (
              <span className="text-muted-foreground hidden sm:inline">
                · {lang === 'vi' ? 'Bản ghi' : 'Recording'} {audioPartIdx + 1}/{partAudioAssets.filter(Boolean).length}
              </span>
            )}
            <span className="ml-auto font-mono text-muted-foreground tabular-nums">
              {formatClock(currentTime)}{duration > 0 ? ` / ${formatClock(duration)}` : ''}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 bg-muted rounded-full overflow-hidden" aria-hidden>
            <div className="h-full bg-primary rounded-full transition-[width] duration-300" style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }} />
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={toggleMute}
            aria-label={isMuted ? (lang === 'vi' ? 'Bật âm thanh' : 'Unmute') : lang === 'vi' ? 'Tắt tiếng' : 'Mute'}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" aria-hidden /> : <Volume2 className="w-4 h-4" aria-hidden />}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={isMuted ? 0 : volume}
            onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
            className="w-20 accent-primary"
            aria-label={lang === 'vi' ? 'Âm lượng' : 'Volume'}
          />
        </div>
      </div>
      {!isSimulation && audioState !== 'ended' && (
        <p className="shrink-0 px-3 sm:px-4 py-1.5 text-[11px] text-muted-foreground bg-muted/30 border-b border-border">
          {lang === 'vi'
            ? 'Luyện tập: bạn có thể tạm dừng bản ghi. Bản ghi phát một lượt, không tua lại.'
            : 'Practice: you may pause the recording. It plays once and cannot be rewound.'}
        </p>
      )}

      {/* Part strip (only parts present in this attempt) */}
      {presentParts.length > 1 && (
        <div className="shrink-0 border-b border-border bg-muted/20 px-3 sm:px-4 py-2 flex items-center gap-1.5 overflow-x-auto">
          {presentParts.map(([pNum, first]) => {
            const active = currentPartNum === pNum;
            const past = pNum < currentPartNum;
            if (isSimulation) {
              return (
                <span
                  key={`part-tab-${pNum}`}
                  id={`toeic-part-tab-${pNum}`}
                  aria-current={active ? 'step' : undefined}
                  className={`shrink-0 h-8 px-3 inline-flex items-center gap-1.5 rounded-lg text-xs font-semibold ${
                    active ? 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-200 border border-indigo-500/40' : past ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground/60'
                  }`}
                >
                  {past && <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />}
                  {!active && !past && <Lock className="w-3 h-3" aria-hidden />}
                  Part {pNum}
                </span>
              );
            }
            return (
              <button
                key={`part-tab-${pNum}`}
                id={`toeic-part-tab-${pNum}`}
                type="button"
                onClick={() => select(first.globalIndex)}
                aria-pressed={active}
                className={`shrink-0 h-8 px-3 rounded-lg text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                Part {pNum}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        {currentPartNum === 1 && (
          /* PART 1 — photo central (uncropped), letter choices */
          <div className="h-full flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
            <div className="lg:flex-1 min-h-0 bg-card/40 lg:border-r border-border p-3 sm:p-6 flex items-center justify-center lg:overflow-auto">
              {groupImageAsset ? (
                <ExamAssetImage
                  attemptId={attemptId}
                  asset={groupImageAsset}
                  alt={lang === 'vi' ? `Ảnh của câu ${current?.questionNumber}` : `Photograph for question ${current?.questionNumber}`}
                  className="w-auto max-w-full max-h-[48dvh] lg:max-h-[70dvh] object-contain rounded-xl border border-border bg-white"
                />
              ) : (
                <div className="p-6 rounded-xl border border-dashed border-border text-center text-sm text-muted-foreground max-w-sm">
                  {lang === 'vi' ? 'Ảnh của câu này chưa sẵn sàng.' : 'The photograph for this question is not available.'}
                </div>
              )}
            </div>
            <div className="lg:w-96 shrink-0 p-4 sm:p-6 lg:overflow-y-auto">
              <PartLabel partNumber={1} lang={lang} />
              {singleQuestionCard(
                lang === 'vi' ? 'Chọn câu mô tả đúng nhất bức ảnh bạn nghe được.' : 'Choose the statement that best describes the photograph.'
              )}
            </div>
          </div>
        )}

        {currentPartNum === 2 && (
          /* PART 2 — exactly the printed options (three), no text */
          <div className="h-full overflow-y-auto p-4 sm:p-8 flex flex-col items-center">
            <div className="w-full max-w-md">
              <PartLabel partNumber={2} lang={lang} />
            </div>
            {singleQuestionCard(
              lang === 'vi' ? 'Nghe câu hỏi hoặc câu nói và chọn câu đáp lại phù hợp nhất.' : 'Listen to the question or statement and choose the best response.'
            )}
          </div>
        )}

        {(currentPartNum === 3 || currentPartNum === 4) && (
          /* PART 3 / 4 — one conversation / talk = one set; graphic shown once */
          <div className="h-full flex flex-col md:flex-row overflow-y-auto md:overflow-hidden">
            {groupImageAsset && (
              <div className="md:w-5/12 shrink-0 bg-card/40 md:border-r border-border p-3 sm:p-6 flex flex-col items-center justify-center md:overflow-auto">
                <ExamAssetImage
                  attemptId={attemptId}
                  asset={groupImageAsset}
                  alt={lang === 'vi' ? `Hình cho câu ${numberRange(groupItems.map((g) => g.questionNumber))}` : `Graphic for questions ${numberRange(groupItems.map((g) => g.questionNumber))}`}
                  className="w-auto max-w-full max-h-[40dvh] md:max-h-[70dvh] object-contain rounded-xl border border-border bg-white"
                />
                <span className="text-[11px] text-muted-foreground mt-2">
                  {lang === 'vi' ? 'Hình dùng cho cả bộ câu hỏi' : 'Graphic for the whole set'}
                </span>
              </div>
            )}
            <div className={`flex-1 min-h-0 md:overflow-y-auto p-3 sm:p-6 ${groupImageAsset ? '' : 'max-w-3xl mx-auto w-full'}`}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <PartLabel partNumber={currentPartNum} lang={lang} />
                  <h3 className="text-base font-bold text-foreground tabular-nums">
                    {lang === 'vi' ? 'Câu' : 'Questions'} {numberRange(groupItems.map((g) => g.questionNumber))}
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    {currentPartNum === 3
                      ? lang === 'vi' ? 'Một đoạn hội thoại — các câu dưới đây cùng dựa trên đoạn này.' : 'One conversation — these questions share it.'
                      : lang === 'vi' ? 'Một bài nói — các câu dưới đây cùng dựa trên bài này.' : 'One talk — these questions share it.'}
                  </p>
                </div>
                {setIndex >= 0 && partSets.length > 1 && (
                  <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                    {lang === 'vi' ? 'Bộ' : 'Set'} {setIndex + 1}/{partSets.length}
                  </span>
                )}
              </div>
              <div className="space-y-3">{groupItems.map(renderSetQuestion)}</div>
              <div className="flex items-center justify-between pt-4">
                <button
                  type="button"
                  onClick={() => {
                    const prev = partSets[setIndex - 1];
                    const idx = prev ? allItems.findIndex((it) => it.group.id === prev.id) : -1;
                    if (idx >= 0) select(idx);
                  }}
                  disabled={setIndex <= 0}
                  className="h-10 px-3 inline-flex items-center gap-1.5 rounded-lg border border-border text-xs font-semibold hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden />
                  {lang === 'vi' ? 'Bộ trước' : 'Previous set'}
                </button>
                <button
                  type="button"
                  id="toeic-listening-next-group-btn"
                  onClick={() => {
                    const lastOfSet = groupItems[groupItems.length - 1];
                    if (lastOfSet) select(lastOfSet.globalIndex + 1);
                  }}
                  disabled={!groupItems.length || groupItems[groupItems.length - 1].globalIndex >= allItems.length - 1}
                  className="h-10 px-4 inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {lang === 'vi' ? 'Bộ tiếp theo' : 'Next set'}
                  <ChevronRight className="w-4 h-4" aria-hidden />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PartLabel({ partNumber, lang }: { partNumber: number; lang: 'vi' | 'en' }) {
  return (
    <p className="text-xs font-bold uppercase tracking-wider text-primary mb-1">
      Part {partNumber}
      <span className="normal-case tracking-normal font-semibold text-muted-foreground"> · {toeicPartName(partNumber, lang)}</span>
      {lang === 'vi' && <span className="normal-case tracking-normal font-normal text-muted-foreground/80"> ({toeicPartTerm(partNumber)})</span>}
    </p>
  );
}
