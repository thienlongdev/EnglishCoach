'use client';

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { PublicPartDto, PublicGroupDto } from '@/types/exams';
import { QuestionRenderer } from './QuestionRenderers';
import { StimulusRenderer } from './StimulusRenderer';
import { GroupQuestionBlock } from './GroupQuestionBlock';
import { partNumberFromCode, resolveExamMediaUrl } from '@/lib/exams/media';
import { isCompletionGroup } from './renderers/ExamRendererRegistry';
import { ListeningFormRenderer } from './renderers/ListeningFormRenderer';
import { examsApi } from '@/services/examsApi';
import {
  Volume2,
  VolumeX,
  Play,
  Pause,
  Headphones,
  FileText,
  Layers,
  Clock,
  CheckCircle2,
  AlertCircle,
  Flag,
} from 'lucide-react';

interface ListeningPlayerProps {
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
  unlockedSectionIndex?: number;
  onUnlockedSectionChange?: (idx: number) => void;
  onCompleteListening?: () => void;
  remainingSeconds?: number;
  /** Exams Phase 7: printed question numbers computed once by the shell. */
  questionNumbers?: Map<string, number>;
  lang?: 'vi' | 'en';
}

export function ListeningPlayer({
  parts,
  groups,
  audioUrl: propAudioUrl,
  attemptId,
  responses,
  onAnswerChange,
  flaggedPlacements,
  onToggleFlag,
  activePlacementId,
  onSelectPlacement,
  isSimulation = true,
  onCompleteListening,
  remainingSeconds,
  questionNumbers,
  lang = 'vi',
}: ListeningPlayerProps) {
  // 1. Normalize parts structure (Parts 1 to 4)
  const activeParts: PublicPartDto[] = useMemo(() => {
    if (parts && parts.length > 0) return parts;
    if (groups && groups.length > 0) {
      return [
        {
          id: 'part-1',
          partCode: 'LISTENING_PART_1',
          ordinal: 1,
          groups: groups,
        },
      ];
    }
    return [];
  }, [parts, groups]);

  // Printed question numbers from the shell (Exams Phase 7); sequential 1..40 only for legacy payloads.
  const itemNumberMap = useMemo(() => {
    if (questionNumbers && questionNumbers.size > 0) return questionNumbers;
    const map = new Map<string, number>();
    let count = 1;
    activeParts.forEach((part) => {
      part.groups.forEach((group) => {
        group.items.forEach((item) => {
          map.set(item.placementId, count++);
        });
      });
    });
    return map;
  }, [activeParts, questionNumbers]);

  const sectionLabel = (part: PublicPartDto | undefined, idx: number) =>
    `Section ${partNumberFromCode(part?.partCode) ?? idx + 1}`;
  // Practice: the recording plays once; its end never opens the simulation-only 2-minute check (Exams Phase 7).
  const [practiceAudioEnded, setPracticeAudioEnded] = useState(false);

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. QUESTION NAVIGATION STATE (Independent from Audio Timeline!)
  // ─────────────────────────────────────────────────────────────────────────────
  const [activePartIndex, setActivePartIndex] = useState<number>(0);
  const currentPart = activeParts[activePartIndex] || activeParts[0];

  // Sync active question section when an item is selected from question palette
  useEffect(() => {
    if (!activePlacementId) return;
    const partIdx = activeParts.findIndex((part) =>
      part.groups.some((g) => g.items.some((item) => item.placementId === activePlacementId))
    );
    if (partIdx >= 0 && partIdx !== activePartIndex) {
      setActivePartIndex(partIdx);
    }
  }, [activePlacementId, activeParts, activePartIndex]);

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. AUTHORITATIVE AUDIO TIMELINE STATE (One-Pass Sequential Progression)
  // ─────────────────────────────────────────────────────────────────────────────
  const storageKey = attemptId ? `ec_listening_timeline_${attemptId}` : null;

  // Track which audio part is currently playing (0-indexed: 0=Part 1, 1=Part 2, etc.)
  const [audioPartIndex, setAudioPartIndex] = useState<number>(() => {
    if (typeof window !== 'undefined' && storageKey) {
      try {
        const saved = sessionStorage.getItem(`${storageKey}_audio_part`);
        if (saved !== null) return parseInt(saved, 10);
      } catch (e) {}
    }
    return 0;
  });

  const [currentAudioUrl, setCurrentAudioUrl] = useState<string | undefined>(undefined);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState<number>(1.0);
  const [isMuted, setIsMuted] = useState(false);

  // Final 2-minute review period
  const [isFinalReview, setIsFinalReview] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && storageKey) {
      try {
        return sessionStorage.getItem(`${storageKey}_final_review`) === 'true';
      } catch (e) {}
    }
    return false;
  });

  const [finalReviewRemaining, setFinalReviewRemaining] = useState<number>(() => {
    if (typeof window !== 'undefined' && storageKey) {
      try {
        const savedDeadline = sessionStorage.getItem(`${storageKey}_review_deadline`);
        if (savedDeadline) {
          const diff = Math.max(0, Math.floor((parseInt(savedDeadline, 10) - Date.now()) / 1000));
          return diff;
        }
      } catch (e) {}
    }
    return 120; // Official 2-minute review
  });

  // Authoritative server timeline sync: activate final review if simulation remainingSeconds is within 120s
  useEffect(() => {
    if (isSimulation && remainingSeconds !== undefined && remainingSeconds <= 120 && remainingSeconds > 0) {
      setIsFinalReview(true);
      setFinalReviewRemaining(Math.min(120, remainingSeconds));
    }
  }, [isSimulation, remainingSeconds]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hasUnlockedAudioRef = useRef(false);

  // Graceful browser autoplay unlock on first user interaction (click, key, pointer)
  useEffect(() => {
    if (!isSimulation || isFinalReview || hasUnlockedAudioRef.current) return;

    const handleUserInteraction = () => {
      if (hasUnlockedAudioRef.current) return;
      const audio = audioRef.current;
      if (audio && audio.paused && !isFinalReview && audio.src) {
        audio
          .play()
          .then(() => {
            hasUnlockedAudioRef.current = true;
            setIsPlaying(true);
          })
          .catch(() => {});
      }
    };

    window.addEventListener('click', handleUserInteraction, { once: true, passive: true });
    window.addEventListener('keydown', handleUserInteraction, { once: true, passive: true });
    window.addEventListener('pointerdown', handleUserInteraction, { once: true, passive: true });

    return () => {
      window.removeEventListener('click', handleUserInteraction);
      window.removeEventListener('keydown', handleUserInteraction);
      window.removeEventListener('pointerdown', handleUserInteraction);
    };
  }, [isFinalReview, isSimulation]);
  const maxTimeRef = useRef<number>(0);
  const audioPartIndexRef = useRef(audioPartIndex);
  audioPartIndexRef.current = audioPartIndex;

  // Cache grants for audio parts to transition with zero latency
  const grantCacheRef = useRef<Map<number, string>>(new Map());

  // Function to load and play audio for a specific part index
  const loadAudioForPart = useCallback(
    async (partIdx: number, autoPlay: boolean = true) => {
      if (partIdx >= activeParts.length && !isSimulation) {
        setIsPlaying(false);
        setPracticeAudioEnded(true);
        return;
      }
      if (partIdx >= activeParts.length) {
        // All 4 audio parts finished! Enter Final 2-Minute Review phase
        setIsFinalReview(true);
        setIsPlaying(false);
        const deadline = Date.now() + 120 * 1000;
        if (storageKey) {
          try {
            sessionStorage.setItem(`${storageKey}_final_review`, 'true');
            sessionStorage.setItem(`${storageKey}_review_deadline`, deadline.toString());
            sessionStorage.setItem(`${storageKey}_audio_part`, partIdx.toString());
          } catch (e) {}
        }
        return;
      }

      const targetPart = activeParts[partIdx];
      if (!targetPart) return;

      let streamUrl: string | undefined = grantCacheRef.current.get(partIdx);

      if (!streamUrl && propAudioUrl && partIdx === 0) {
        streamUrl = propAudioUrl;
        grantCacheRef.current.set(partIdx, streamUrl);
      }

      if (!streamUrl && attemptId) {
        const audioAsset = targetPart.groups
          ?.flatMap((g) => g.stimuli)
          ?.flatMap((s) => s.assets)
          ?.find((a) => a.mimeType?.startsWith('audio') || a.role === 'PRIMARY');

        if (audioAsset?.assetId) {
          try {
            const grant = await examsApi.createPlaybackGrant(attemptId, audioAsset.assetId);
            const rawUrl = grant.mediaStreamUrl || grant.streamUrl;
            if (rawUrl) {
              const resolved = resolveExamMediaUrl(rawUrl) || rawUrl;
              // The shell may have supplied this same part's grant while our request was in flight.
              // Keep the first resolved source so a late response cannot interrupt a user's Play gesture.
              streamUrl = grantCacheRef.current.get(partIdx) || resolved;
              if (!grantCacheRef.current.has(partIdx)) grantCacheRef.current.set(partIdx, streamUrl);
            }
          } catch (e) {
            console.warn(`Failed to create playback grant for Listening Part ${partIdx + 1}`, e);
          }
        }
      }

      if (streamUrl) {
        setCurrentAudioUrl(streamUrl);
        if (!audioRef.current || (audioRef.current.currentSrc || audioRef.current.src) !== streamUrl) {
          maxTimeRef.current = 0;
          setCurrentTime(0);
        }

        if (storageKey) {
          try {
            sessionStorage.setItem(`${storageKey}_audio_part`, partIdx.toString());
          } catch (e) {}
        }

        if (autoPlay && audioRef.current) {
          const audio = audioRef.current;
          const isSameSrc = audio.src === streamUrl || audio.currentSrc === streamUrl;
          if (!isSameSrc) {
            audio.src = streamUrl;
            audio.load();
          }
          audio
            .play()
            .then(() => {
              hasUnlockedAudioRef.current = true;
              setIsPlaying(true);
            })
            .catch((err: any) => {
              if (err.name !== 'AbortError') {
                console.info('Autoplay deferred pending user interaction:', err.message);
              }
            });
        }
      }
    },
    [activeParts, attemptId, propAudioUrl, storageKey, isSimulation]
  );

  // Pre-seed part 0 grant from prop if available
  useEffect(() => {
    if (propAudioUrl && !grantCacheRef.current.has(0)) {
      grantCacheRef.current.set(0, propAudioUrl);
      if (audioPartIndex === 0 && !currentAudioUrl) {
        setCurrentAudioUrl(propAudioUrl);
        if (isSimulation && audioRef.current) {
          const audio = audioRef.current;
          if (audio.src !== propAudioUrl && audio.currentSrc !== propAudioUrl) {
            audio.src = propAudioUrl;
            audio.load();
          }
          audio.play().then(() => setIsPlaying(true)).catch(() => {});
        }
      }
    }
  }, [propAudioUrl, audioPartIndex, currentAudioUrl, isSimulation]);

  // Initial load of current audio part
  useEffect(() => {
    if (isFinalReview) return;
    loadAudioForPart(audioPartIndex, isSimulation);
  }, [audioPartIndex, isFinalReview, isSimulation, loadAudioForPart]);

  // Preload next part's grant in background for seamless transitions
  useEffect(() => {
    const nextIdx = audioPartIndex + 1;
    if (nextIdx < activeParts.length && !grantCacheRef.current.has(nextIdx) && attemptId) {
      const nextPart = activeParts[nextIdx];
      const audioAsset = nextPart?.groups
        ?.flatMap((g) => g.stimuli)
        ?.flatMap((s) => s.assets)
        ?.find((a) => a.mimeType?.startsWith('audio') || a.role === 'PRIMARY');
      if (audioAsset?.assetId) {
        examsApi
          .createPlaybackGrant(attemptId, audioAsset.assetId)
          .then((grant) => {
            const rawUrl = grant.mediaStreamUrl || grant.streamUrl;
            if (rawUrl) {
              const url = resolveExamMediaUrl(rawUrl) || rawUrl;
              grantCacheRef.current.set(nextIdx, url);
            }
          })
          .catch(() => {});
      }
    }
  }, [audioPartIndex, activeParts, attemptId]);

  const hasCompletedListeningRef = useRef(false);

  // Final 2-Minute Review countdown
  useEffect(() => {
    if (!isFinalReview) return;

    const timer = setInterval(() => {
      setFinalReviewRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          // Transition to Reading automatically and exactly once!
          if (!hasCompletedListeningRef.current) {
            hasCompletedListeningRef.current = true;
            if (onCompleteListening) {
              onCompleteListening();
            }
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isFinalReview, onCompleteListening]);

  // Handle native audio ended -> Advance to next part automatically!
  const handleEnded = useCallback(() => {
    const nextPart = audioPartIndexRef.current + 1;
    setAudioPartIndex(nextPart);
    loadAudioForPart(nextPart, true);
  }, [loadAudioForPart]);

  // Handle manual play toggle (Practice mode or initial gesture unlock)
  const handlePlayToggle = () => {
    if (isSimulation) {
      // In Exam Simulation, candidate pause is strictly disallowed
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;

    if (!audio.paused) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio
        .play()
        .then(() => {
          hasUnlockedAudioRef.current = true;
          setIsPlaying(!audio.paused);
        })
        .catch((e) => {
          console.warn('Playback initiation error:', e);
        });
    }
  };

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const cur = audio.currentTime;

    if (isSimulation) {
      // Forward-only enforcement: reject manual backward seeking in exam simulation
      if (cur < maxTimeRef.current) {
        audio.currentTime = maxTimeRef.current;
        setCurrentTime(maxTimeRef.current);
        return;
      }
      if (cur > maxTimeRef.current) {
        maxTimeRef.current = cur;
      }
    }

    setCurrentTime(cur);
    if (!duration && audio.duration) {
      setDuration(audio.duration);
    }
  };

  const handleVolumeChange = (newVol: number) => {
    setVolume(newVol);
    setIsMuted(newVol === 0);
    if (audioRef.current) {
      audioRef.current.volume = newVol;
      audioRef.current.muted = newVol === 0;
    }
  };

  const toggleMute = () => {
    if (audioRef.current) {
      if (isMuted) {
        audioRef.current.muted = false;
        audioRef.current.volume = volume || 0.8;
        setIsMuted(false);
      } else {
        audioRef.current.muted = true;
        setIsMuted(true);
      }
    }
  };

  // Bind native audio events
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const enforceSeeking = () => {
      if (isSimulation && audio.currentTime < maxTimeRef.current) {
        audio.currentTime = maxTimeRef.current;
        setCurrentTime(maxTimeRef.current);
      }
    };

    audio.addEventListener('seeking', enforceSeeking);
    audio.addEventListener('seeked', enforceSeeking);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('seeking', enforceSeeking);
      audio.removeEventListener('seeked', enforceSeeking);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [isSimulation, handleEnded]);

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  const formatSeconds = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const currentGroups = currentPart?.groups || [];
  const currentStimuli = currentPart?.groups.flatMap((g) => g.stimuli).filter(Boolean) || [];
  // Exams Phase 4B.4: groups with a printed presentation render their template interactively in the answer pane.
  const hasCompletionGroup = currentGroups.some((g) => isCompletionGroup(g) && !g.presentation);

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-background text-foreground overflow-hidden">
      {/* ─────────────────────────────────────────────────────────────────────────────
          1. TOP STICKY AUTHORITATIVE LISTENING TIMELINE BAR
          (Runs forward across all 4 parts, independent of question navigation)
         ───────────────────────────────────────────────────────────────────────────── */}
      <div className="border-b border-border bg-card/95 backdrop-blur px-6 py-3 shadow-xs shrink-0 z-20">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          {/* Left info: Audio track identity and simulation indicator */}
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0 border border-primary/20">
              <Headphones className="w-5 h-5" aria-hidden />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-primary">
                  {isFinalReview
                    ? (lang === 'vi' ? 'Kiểm tra lại đáp án' : 'Answer check')
                    : activeParts.length > 1
                    ? `${sectionLabel(activeParts[audioPartIndex], audioPartIndex)} · ${audioPartIndex + 1}/${activeParts.length}`
                    : sectionLabel(activeParts[0], 0)}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {isFinalReview
                  ? (lang === 'vi' ? 'Bản ghi đã kết thúc. Bạn còn 2 phút để kiểm tra câu trả lời.' : 'The recording has ended. You have 2 minutes to check your answers.')
                  : practiceAudioEnded
                  ? (lang === 'vi' ? 'Bản ghi đã phát xong. Bạn có thể tiếp tục trả lời và nộp bài khi sẵn sàng.' : 'The recording has finished. Keep answering and submit when ready.')
                  : isSimulation
                  ? (lang === 'vi' ? 'Bản ghi phát một lượt, không dừng. Bạn có thể chuyển giữa các câu trong khi nghe.' : 'The recording plays once without pausing. You can move between questions while listening.')
                  : (lang === 'vi' ? 'Luyện tập: bạn có thể tạm dừng bản ghi. Bản ghi phát một lượt, không tua lại.' : 'Practice: you may pause the recording. It plays once and cannot be rewound.')}
              </p>
            </div>
          </div>

          {/* Right controls: Audio player or review countdown */}
          <div className="flex items-center gap-4 w-full sm:w-auto justify-end">
            <audio
              id="listening-audio-element"
              ref={audioRef}
              src={currentAudioUrl}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
              onCanPlay={() => {
                if (isSimulation && !isFinalReview && audioRef.current && audioRef.current.paused) {
                  audioRef.current.play().then(() => {
                    hasUnlockedAudioRef.current = true;
                    setIsPlaying(true);
                  }).catch((err: any) => {
                    if (err.name !== 'AbortError') {
                      console.info('Autoplay deferred pending user interaction:', err.message);
                    }
                  });
                }
              }}
              onPlaying={() => {
                hasUnlockedAudioRef.current = true;
                setIsPlaying(true);
              }}
              onEmptied={() => setIsPlaying(false)}
              onPause={() => {
                if (!isSimulation) {
                  setIsPlaying(false);
                }
              }}
              autoPlay={isSimulation}
            />

            {isFinalReview ? (
              <div
                id="listening-final-review-badge"
                className="flex items-center gap-2.5 px-4 py-2 bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 rounded-xl text-xs font-bold shadow-xs"
              >
                <Clock className="w-4 h-4 text-amber-500" aria-hidden />
                <span>{lang === 'vi' ? 'Thời gian kiểm tra' : 'Check time'}: {formatSeconds(finalReviewRemaining)}</span>
              </div>
            ) : (
              <div className="flex items-center gap-4 w-full sm:w-auto">
                {/* Status Indicator */}
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/60 border border-border text-xs font-semibold">
                  <span className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden />
                  <span className="text-foreground" role="status" aria-live="polite">
                    {practiceAudioEnded
                      ? (lang === 'vi' ? 'Đã phát xong' : 'Finished')
                      : isPlaying
                      ? (lang === 'vi' ? 'Đang phát' : 'Playing')
                      : (lang === 'vi' ? (isSimulation ? 'Chờ phát' : 'Đã tạm dừng') : (isSimulation ? 'Waiting' : 'Paused'))}
                  </span>
                </div>

                {/* Progress bar in Simulation mode (read-only) */}
                <div className="flex items-center gap-2.5 w-44 sm:w-60">
                  <div className="flex-1 bg-muted h-2 rounded-full overflow-hidden border border-border">
                    <div
                      className="bg-primary h-full transition-all duration-300"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono font-medium text-muted-foreground shrink-0 min-w-[70px] text-right">
                    {formatSeconds(currentTime)} / {formatSeconds(duration || 0)}
                  </span>
                </div>

                {/* Volume control */}
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={toggleMute}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
                    title={isMuted ? 'Bật âm lượng' : 'Tắt tiếng'}
                  >
                    {isMuted ? <VolumeX className="w-4 h-4 text-destructive" /> : <Volume2 className="w-4 h-4" />}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={isMuted ? 0 : volume}
                    onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                    className="w-16 h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                    title="Volume"
                  />
                </div>

                {/* Practice mode transport toggle */}
                {!isSimulation && (
                  <button
                    id="listening-play-audio-button"
                    type="button"
                    onClick={handlePlayToggle}
                    disabled={practiceAudioEnded || !currentAudioUrl}
                    aria-label={isPlaying ? (lang === 'vi' ? 'Tạm dừng' : 'Pause') : (lang === 'vi' ? 'Phát' : 'Play')}
                    className="w-10 h-10 inline-flex items-center justify-center rounded-full bg-emerald-600 hover:bg-emerald-500 text-white transition-colors cursor-pointer shrink-0 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────────────────
          2. QUESTION SECTION TABS (All 40 Questions Navigable from the start!)
         ───────────────────────────────────────────────────────────────────────────── */}
      {activeParts.length > 1 && (
        <div className="flex items-center gap-2 px-6 py-2.5 bg-muted/40 border-b border-border shrink-0 overflow-x-auto">
          <span className="text-xs font-semibold text-muted-foreground mr-1 hidden sm:inline">{lang === 'vi' ? 'Câu hỏi:' : 'Questions:'}</span>
          {activeParts.map((part, idx) => {
            const isSelected = idx === activePartIndex;
            const totalItems = part.groups.flatMap((g) => g.items).length;
            const isCurrentAudioPlaying = audioPartIndex === idx && isPlaying;

            return (
              <button
                key={part.id || idx}
                id={`listening-section-tab-${idx + 1}`}
                onClick={() => {
                  // Switch question view WITHOUT interrupting or seeking the audio!
                  setActivePartIndex(idx);
                  const firstItem = part.groups.flatMap((g) => g.items)[0];
                  if (firstItem) {
                    onSelectPlacement(firstItem.placementId);
                  }
                }}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-background text-primary shadow-xs border border-border font-bold'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                }`}
              >
                <span>{sectionLabel(part, idx)}</span>
                <span className="text-[11px] opacity-70">({totalItems} {lang === 'vi' ? 'câu' : 'Qs'})</span>
                {isCurrentAudioPlaying && (
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" title="Đang phát audio ở phần này" />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          3. AUTHENTIC TWO-PANE LISTENING WORKSPACE
         ───────────────────────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        {/* Left Pane: Question Paper / Stimulus / Notes / Form Structure (50% desktop) */}
        <div className="md:w-1/2 w-full h-full flex flex-col border-r border-border bg-card/60 overflow-hidden">
          <div className="px-6 py-2.5 bg-muted/20 border-b border-border flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" />
              <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                {sectionLabel(currentPart, activePartIndex)} · {lang === 'vi' ? 'Đề bài' : 'Question paper'}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {currentGroups.flatMap((g) => g.items).length} {lang === 'vi' ? 'câu' : 'questions'}
            </span>
          </div>

          <div
            id="listening-notes-container"
            className="flex-1 overflow-y-auto p-6 md:p-8 space-y-6 select-text text-foreground"
          >
            {hasCompletionGroup ? (
              <div className="space-y-6">
                {currentGroups.map((group) => {
                  if (!isCompletionGroup(group) || group.presentation) return null;
                  return (
                    <ListeningFormRenderer
                      key={group.id}
                      group={group}
                      partIndex={activePartIndex}
                      partInstructions={currentPart?.instructions}
                      itemNumberMap={itemNumberMap}
                      activePlacementId={activePlacementId}
                      responses={responses}
                      onSelectPlacement={onSelectPlacement}
                    />
                  );
                })}
              </div>
            ) : currentStimuli.length > 0 ? (
              <div className="space-y-6">
                <StimulusRenderer stimuli={currentStimuli} attemptId={attemptId} />
              </div>
            ) : (
              <div className="p-5 rounded-2xl border border-border bg-muted/30 text-foreground space-y-2">
                <div className="flex items-center gap-2">
                  <Headphones className="w-4 h-4 text-primary" aria-hidden />
                  <h4 className="text-sm font-bold">{lang === 'vi' ? 'Hướng dẫn' : 'Instructions'}</h4>
                </div>
                <p className="text-xs leading-relaxed text-foreground/90">
                  {currentPart?.instructions ||
                    (lang === 'vi' ? 'Nghe bản ghi và trả lời các câu hỏi bên cạnh.' : 'Listen to the recording and answer the questions.')}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right Pane: Question Interaction / Answer Sheet Pane (50% desktop) */}
        <div className="md:w-1/2 w-full h-full flex flex-col bg-background overflow-hidden">
          <div className="px-6 py-2.5 bg-muted/20 border-b border-border flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-primary" />
              <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                {lang === 'vi' ? 'Câu hỏi' : 'Questions'} · {sectionLabel(currentPart, activePartIndex)}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {currentGroups.flatMap((g) => g.items).length} {lang === 'vi' ? 'câu' : 'questions'}
            </span>
          </div>

          <div id="listening-questions-container" className="flex-1 overflow-y-auto p-6 md:p-8 space-y-6">
            {currentGroups.map((group) => {
              const groupItemNumbers = group.items.map((it) => itemNumberMap.get(it.placementId) || 0).filter(Boolean);
              const minNum = groupItemNumbers.length > 0 ? Math.min(...groupItemNumbers) : null;
              const maxNum = groupItemNumbers.length > 0 ? Math.max(...groupItemNumbers) : null;
              const rangeText =
                minNum !== null ? (minNum === maxNum ? `Question ${minNum}` : `Questions ${minNum}–${maxNum}`) : '';

              if (group.presentation) {
                return (
                  <GroupQuestionBlock
                    key={group.id}
                    group={group}
                    numberOf={(it) => itemNumberMap.get(it.placementId) || 1}
                    responses={responses}
                    onAnswerChange={onAnswerChange}
                    flaggedPlacements={flaggedPlacements}
                    onToggleFlag={onToggleFlag}
                    activePlacementId={activePlacementId}
                    onSelectPlacement={onSelectPlacement}
                    attemptId={attemptId}
                    lang={lang}
                    figureShownElsewhere={!hasCompletionGroup && currentStimuli.length > 0}
                  />
                );
              }

              const isCompletion = isCompletionGroup(group);

              if (isCompletion) {
                return (
                  <div key={group.id} className="bg-card border border-border rounded-2xl p-6 shadow-xs space-y-4">
                    <div className="flex items-center justify-between border-b border-border/80 pb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full bg-primary" />
                          <h3 className="text-sm font-bold text-foreground tracking-wide">
                            ANSWER SHEET ({rangeText})
                          </h3>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          Type your answer into each numbered box below.
                        </p>
                      </div>
                      <span className="text-xs font-semibold px-2.5 py-0.5 rounded-md bg-muted text-muted-foreground">
                        {group.items.length} answers
                      </span>
                    </div>

                    <div className="space-y-2.5">
                      {group.items.map((item) => {
                        const isFlagged = flaggedPlacements.includes(item.placementId);
                        const userVal = responses[item.placementId];
                        const isCurrent = activePlacementId === item.placementId;
                        const itemNumber = itemNumberMap.get(item.placementId) || 1;

                        let textVal = '';
                        if (typeof userVal === 'string') textVal = userVal;
                        else if (userVal && typeof userVal === 'object') {
                          textVal = userVal.textResponse || userVal.answerPayload?.value || userVal.value || '';
                        }

                        return (
                          <div
                            key={item.id}
                            id={`item-${item.placementId}`}
                            onClick={() => onSelectPlacement(item.placementId)}
                            className={`p-2 rounded-xl border transition-all flex items-center justify-between gap-3 ${
                              isCurrent
                                ? 'bg-primary/5 border-primary ring-1 ring-primary/30 shadow-xs'
                                : 'border-border bg-card hover:border-border/90'
                            }`}
                          >
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                              <span
                                className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs shrink-0 transition-colors ${
                                  isCurrent
                                    ? 'bg-primary text-primary-foreground'
                                    : textVal
                                    ? 'bg-muted text-foreground'
                                    : 'bg-muted/50 text-muted-foreground'
                                }`}
                              >
                                {itemNumber}
                              </span>

                              <input
                                id={`input-${item.placementId}`}
                                type="text"
                                value={textVal}
                                onChange={(e) => onAnswerChange(item.placementId, e.target.value)}
                                onFocus={() => onSelectPlacement(item.placementId)}
                                placeholder="Type answer..."
                                className="flex-1 bg-transparent border-0 text-sm font-medium text-foreground focus:outline-none focus:ring-0 placeholder:text-muted-foreground/40"
                              />
                            </div>

                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleFlag(item.placementId);
                              }}
                              className={`p-1.5 rounded-lg transition-colors cursor-pointer shrink-0 ${
                                isFlagged
                                  ? 'text-amber-500 hover:bg-amber-500/10'
                                  : 'text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted'
                              }`}
                              title={isFlagged ? 'Bỏ đánh dấu' : 'Đánh dấu xem lại'}
                            >
                              <span className="sr-only">Flag</span>
                              <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1v19" />
                              </svg>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }

              // Standard Multiple Choice / Matching / etc.
              return (
                <div key={group.id} className="bg-card border border-border rounded-2xl p-6 shadow-xs space-y-6">
                  <div className="border-b border-border/80 pb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-primary" />
                      <h3 className="text-sm font-bold text-foreground tracking-wide">
                        {rangeText ? `${rangeText.toUpperCase()}` : 'QUESTIONS'}
                      </h3>
                    </div>
                    {(group as any).instructions && (
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{(group as any).instructions}</p>
                    )}
                  </div>

                  <div className="space-y-6 divide-y divide-border/40">
                    {group.items.map((item) => {
                      const itemNumber = itemNumberMap.get(item.placementId) || 1;
                      const isFlagged = flaggedPlacements.includes(item.placementId);
                      const isCurrent = activePlacementId === item.placementId;

                      return (
                        <div
                          key={item.id}
                          id={`item-${item.placementId}`}
                          onClick={() => onSelectPlacement(item.placementId)}
                          className={`pt-6 first:pt-0 transition-all ${
                            isCurrent
                              ? 'p-3 rounded-xl bg-primary/5 ring-1 ring-primary/20 -mx-3'
                              : ''
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3 mb-2.5">
                            <span className="w-7 h-7 rounded-lg bg-primary/10 text-primary border border-primary/20 flex items-center justify-center font-bold text-xs shrink-0 shadow-xs">
                              {itemNumber}
                            </span>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleFlag(item.placementId);
                              }}
                              className={`p-1.5 rounded-lg border transition-colors cursor-pointer shrink-0 ${
                                isFlagged
                                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
                                  : 'text-muted-foreground hover:text-foreground border-border bg-card hover:bg-muted'
                              }`}
                              title={isFlagged ? 'Đã đánh dấu' : 'Đánh dấu câu hỏi'}
                            >
                              <Flag className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          <div className="pl-1">
                            <QuestionRenderer
                              item={item}
                              value={responses[item.placementId]}
                              onChange={(val: any) => onAnswerChange(item.placementId, val)}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
