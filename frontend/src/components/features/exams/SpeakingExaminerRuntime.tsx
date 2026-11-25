'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  SpeakingRuntimeStateDto,
  SpeakingTurnDto,
  StartPreparationCommand,
  StartRecordingCommand,
  StopRecordingCommand,
  CompleteTurnCommand,
} from '@/types/exams';
import { examsApi } from '@/services/examsApi';
import { useExamMedia } from '@/hooks/useExamMedia';
import { useAudioRecorder, formatTime } from '@/hooks/useAudioRecorder';
import {
  Mic,
  Square,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Volume2,
  ShieldCheck,
  FastForward,
  Play,
  Lock,
  FileText,
  MessageSquare,
  RotateCcw,
} from 'lucide-react';

export interface SpeakingExaminerRuntimeProps {
  attemptId: string;
  lang?: 'en' | 'vi';
  onTurnCompleted?: (turnKey: string, recordingId: string) => void;
  onSectionCompleted?: () => void;
}

export type ExaminerPhase =
  | 'EXAMINER_LOADING'
  | 'EXAMINER_READY'
  | 'EXAMINER_PLAYING'
  | 'EXAMINER_TEXT_FALLBACK'
  | 'PREPARATION'
  | 'READY_TO_RECORD'
  | 'RECORDING'
  | 'UPLOADING'
  | 'FAILED_UPLOAD'
  | 'SEALED'
  | 'SECTION_COMPLETED';

function getTurnPresentedStorageKey(attemptId: string, turnKey: string): string {
  return `ec_speaking_turn_presented_${attemptId}_${turnKey}`;
}

function isTurnPresented(attemptId: string, turnKey: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return sessionStorage.getItem(getTurnPresentedStorageKey(attemptId, turnKey)) === 'true';
  } catch {
    return false;
  }
}

function markTurnPresented(attemptId: string, turnKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(getTurnPresentedStorageKey(attemptId, turnKey), 'true');
  } catch {}
}

export const SpeakingExaminerRuntime: React.FC<SpeakingExaminerRuntimeProps> = ({
  attemptId,
  lang = 'vi',
  onTurnCompleted,
  onSectionCompleted,
}) => {
  const [speakingState, setSpeakingState] = useState<SpeakingRuntimeStateDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [examinerPhase, setExaminerPhase] = useState<ExaminerPhase>('EXAMINER_LOADING');

  // Stable callback refs to prevent unnecessary re-sync on parent re-renders
  const onTurnCompletedRef = useRef(onTurnCompleted);
  useEffect(() => {
    onTurnCompletedRef.current = onTurnCompleted;
  }, [onTurnCompleted]);

  const onSectionCompletedRef = useRef(onSectionCompleted);
  useEffect(() => {
    onSectionCompletedRef.current = onSectionCompleted;
  }, [onSectionCompleted]);

  // In-memory set of presented turnKeys
  const presentedTurnsRef = useRef<Set<string>>(new Set());

  // Media ladder states
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [isVideo, setIsVideo] = useState<boolean>(false);
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);

  // Micro-gate S1: Mic preflight
  const [micGranted, setMicGranted] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return sessionStorage.getItem('ec_speaking_mic_granted') === 'true';
    }
    return false;
  });
  const [showMicModal, setShowMicModal] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return sessionStorage.getItem('ec_speaking_mic_granted') !== 'true';
    }
    return false;
  });
  const [micChecking, setMicChecking] = useState<boolean>(false);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Media hook for chunk upload, recovery, and sealing
  const {
    initRecording,
    uploadAndSeal,
    acknowledgedChunkCount,
    acknowledgedChunks,
    isSealed,
    reconcileRecording,
    failActiveRecording,
    error: mediaError,
  } = useExamMedia(attemptId);

  // Active recording tracking
  const [activeRecordingId, setActiveRecordingId] = useState<string | null>(null);
  const [prepRemaining, setPrepRemaining] = useState<number>(60);
  const [recordElapsed, setRecordElapsed] = useState<number>(0);

  // Active turn references
  const currentTurn: SpeakingTurnDto | null = speakingState?.currentTurn || null;
  const isPart2 = (currentTurn?.preparationSeconds ?? 0) > 0;
  const maxRecordSeconds = isPart2 ? 120 : 60;

  // Audio Recorder Hook
  const activeBlobRef = useRef<Blob | null>(null);
  const finalizingRef = useRef<boolean>(false);

  const {
    isRecording,
    startRecording,
    stopRecording,
    stopRecordingAsync,
    audioBlob,
    error: recorderError,
  } = useAudioRecorder({
    maxDurationSeconds: maxRecordSeconds,
    onMaxDurationReached: () => {
      handleStopCandidateRecording();
    },
  });

  // Determine presentation ladder for a given turn and reconcile recovery state
  const determineInitialTurnPhase = useCallback(async (turn: SpeakingTurnDto, activePartCode: string) => {
    // Reconcile durable recovery storage with server truth
    const reconciled = await reconcileRecording(turn.turnKey);
    if (reconciled?.recordingId) {
      setActiveRecordingId(reconciled.recordingId);
      if (reconciled.isSealed) {
        setExaminerPhase('SEALED');
        return;
      }
    }

    if (turn.turnState === 'PREPARING') {
      setExaminerPhase('PREPARATION');
      setPrepRemaining(turn.preparationSeconds || 60);
      return;
    }
    if (turn.turnState === 'RECORDING') {
      setExaminerPhase('RECORDING');
      return;
    }
    if (turn.turnState === 'COMPLETED') {
      setExaminerPhase('SEALED');
      return;
    }

    // Media ladder stimulus setup
    const stimulusMedia = turn.mediaUrl;
    if (stimulusMedia) {
      setMediaUrl(stimulusMedia);
      setIsVideo(stimulusMedia.endsWith('.mp4') || stimulusMedia.endsWith('.webm'));
    } else {
      setMediaUrl(null);
      setIsVideo(false);
    }

    // Authoritative check: Once the examiner question media has ended for this turnKey,
    // QUESTION_PRESENTED / READY_TO_ANSWER must remain authoritative and NEVER reset.
    const alreadyPresented = presentedTurnsRef.current.has(turn.turnKey) || isTurnPresented(attemptId, turn.turnKey);
    if (alreadyPresented) {
      const isPart2Turn = (turn.preparationSeconds ?? 0) > 0;
      if (isPart2Turn) {
        setExaminerPhase('PREPARATION');
      } else {
        setExaminerPhase('READY_TO_RECORD');
      }
      return;
    }

    // Media ladder: approved video -> approved audio -> consented TTS -> text fallback
    if (stimulusMedia) {
      setExaminerPhase('EXAMINER_READY');
    } else {
      // Fallback: Text prompt presentation requiring candidate acknowledgement
      setExaminerPhase('EXAMINER_TEXT_FALLBACK');
    }
  }, [attemptId, reconcileRecording]);

  // 1. Initial State Load / Sync on Mount or AttemptId Change
  const refreshSpeakingState = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const state = await examsApi.getSpeakingState(attemptId);
      setSpeakingState(state);

      if (state.sectionCompleted) {
        setExaminerPhase('SECTION_COMPLETED');
        onSectionCompletedRef.current?.();
      } else if (state.currentTurn) {
        await determineInitialTurnPhase(state.currentTurn, state.activePartCode || '');
      }
    } catch (err: any) {
      console.error('Failed to load speaking state:', err);
      setError(err?.response?.data?.message || err?.message || 'Failed to initialize Speaking state');
    } finally {
      setIsLoading(false);
    }
  }, [attemptId, determineInitialTurnPhase]);

  useEffect(() => {
    refreshSpeakingState();
  }, [attemptId]);

  // Actionable retry creating a new generation
  const handleRetryNewGeneration = async () => {
    if (!currentTurn) return;
    try {
      setIsLoading(true);
      setError(null);
      const recId = await initRecording(
        currentTurn.placementId || currentTurn.turnKey,
        'audio/webm',
        currentTurn.turnKey,
        `cmd-retry-${currentTurn.turnKey}-${Date.now()}`
      );
      setActiveRecordingId(recId);
      setRecordElapsed(0);
      setExaminerPhase('READY_TO_RECORD');
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Không thể khởi tạo lượt ghi âm mới');
    } finally {
      setIsLoading(false);
    }
  };

  // 2. Microphone Permission Request
  const handleRequestMic = async () => {
    setMicChecking(true);
    setError(null);
    let permissionExpired = false;
    let permissionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const permission = navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        if (permissionExpired) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error('Microphone permission timed out');
        }
        return stream;
      });
      const stream = await Promise.race([
        permission,
        new Promise<MediaStream>((_, reject) => {
          permissionTimer = setTimeout(() => {
            permissionExpired = true;
            reject(new Error('Microphone permission timed out'));
          }, 20000);
        }),
      ]);
      clearTimeout(permissionTimer);
      micStreamRef.current = stream;
      setMicGranted(true);
      setShowMicModal(false);
      try {
        sessionStorage.setItem('ec_speaking_mic_granted', 'true');
      } catch (e) {}

      // Audio meter
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioCtx;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const updateMeter = () => {
        if (!analyserRef.current) return;
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        setAudioLevel(Math.min(100, Math.round((avg / 128) * 100)));
        animationFrameRef.current = requestAnimationFrame(updateMeter);
      };
      updateMeter();
    } catch (err) {
      console.warn('Microphone permission rejected or unavailable:', err);
      setMicGranted(false);
      setShowMicModal(true);
      setError('Không thể truy cập microphone. Hãy cho phép microphone trong trình duyệt rồi thử lại.');
      try {
        sessionStorage.removeItem('ec_speaking_mic_granted');
      } catch (e) {}
    } finally {
      clearTimeout(permissionTimer);
      setMicChecking(false);
    }
  };

  useEffect(() => {
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (audioContextRef.current) audioContextRef.current.close().catch(() => {});
      if (micStreamRef.current) micStreamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // 3. Presentation Lifecycle Handlers
  const handleExaminerPlayMedia = () => {
    if (mediaRef.current) {
      setExaminerPhase('EXAMINER_PLAYING');
      const p = mediaRef.current.play();
      if (p && typeof p.catch === 'function') {
        p.catch((e) => {
          console.warn('Examiner media play warning:', e);
        });
      }
    }
  };

  const handlePresentationFinished = useCallback(async () => {
    console.info('[SpeakingExaminerRuntime] handlePresentationFinished called for turn:', currentTurn?.turnKey);
    if (currentTurn) {
      presentedTurnsRef.current.add(currentTurn.turnKey);
      markTurnPresented(attemptId, currentTurn.turnKey);
    }

    if (isPart2) {
      // Part 2 cue card: Transition to PREPARATION countdown
      setExaminerPhase('PREPARATION');
      setPrepRemaining(60);
      // Notify backend if needed and record authoritative turnRevision
      if (currentTurn && speakingState) {
        try {
          const nextState = await examsApi.startSpeakingPreparation(attemptId, {
            clientMutationId: `cmd-prep-${Date.now()}`,
            expectedTurnRevision: speakingState.turnRevision,
            turnKey: currentTurn.turnKey,
            transitionToken: speakingState.transitionToken || undefined,
          });
          if (nextState) {
            setSpeakingState(nextState);
          }
        } catch (err: any) {
          console.warn('startSpeakingPreparation error:', err);
          try {
            const fresh = await examsApi.getSpeakingState(attemptId);
            setSpeakingState(fresh);
          } catch {}
        }
      }
    } else {
      // Part 1 & Part 3: Immediately ready to record
      setExaminerPhase('READY_TO_RECORD');
    }
  }, [isPart2, currentTurn, speakingState, attemptId]);

  const handlePresentationFinishedRef = useRef(handlePresentationFinished);
  useEffect(() => {
    handlePresentationFinishedRef.current = handlePresentationFinished;
  }, [handlePresentationFinished]);

  // Robust callback ref binding directly to media DOM element
  const setMediaElementRef = useCallback((node: HTMLVideoElement | HTMLAudioElement | null) => {
    mediaRef.current = node;
    if (node) {
      node.onended = () => {
        console.info('[SpeakingExaminerRuntime] Media onended property triggered');
        handlePresentationFinishedRef.current();
      };
      node.onplay = () => {
        setExaminerPhase('EXAMINER_PLAYING');
      };
      node.addEventListener('ended', () => {
        console.info('[SpeakingExaminerRuntime] Media addEventListener ended triggered');
        handlePresentationFinishedRef.current();
      });
      node.addEventListener('play', () => {
        setExaminerPhase('EXAMINER_PLAYING');
      });
    }
  }, []);

  // Text fallback explicit acknowledgement
  const handleTextFallbackAck = () => {
    handlePresentationFinished();
  };

  // 4. Preparation Timer (Part 2 Cue Card)
  useEffect(() => {
    if (examinerPhase !== 'PREPARATION') return;

    const timer = setInterval(() => {
      setPrepRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          handleBeginCandidateRecording();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [examinerPhase]);

  // 5. Recording Initiation & Control
  const handleBeginCandidateRecording = async () => {
    if (!currentTurn || !speakingState) return;

    try {
      // Initialize server recording record
      const recId = await initRecording(
        currentTurn.placementId || currentTurn.turnKey,
        'audio/webm',
        currentTurn.turnKey
      );
      setActiveRecordingId(recId);
      setExaminerPhase('RECORDING');
      setRecordElapsed(0);

      // Start client recording
      await startRecording();
    } catch (err: any) {
      console.error('Failed to start recording on server:', err);
      // If server failed, still allow recording locally
      setExaminerPhase('RECORDING');
      setRecordElapsed(0);
      await startRecording().catch(() => {});
    }
  };

  // Active recording timer
  useEffect(() => {
    if (examinerPhase !== 'RECORDING') return;

    const timer = setInterval(() => {
      setRecordElapsed((prev) => {
        if (prev >= maxRecordSeconds - 1) {
          clearInterval(timer);
          handleStopCandidateRecording();
          return maxRecordSeconds;
        }
        return prev + 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [examinerPhase, maxRecordSeconds]);

  const handleStopCandidateRecording = async () => {
    try {
      const blob = await stopRecordingAsync();
      if (blob) {
        activeBlobRef.current = blob;
      }
    } catch (err) {
      console.warn('stopRecordingAsync error:', err);
    }
    setExaminerPhase('UPLOADING');
  };

  // 6. Upload Chunk, Seal Recording, and Complete Turn
  useEffect(() => {
    const uploadCandidateBlob = activeBlobRef.current || audioBlob;
    if (examinerPhase === 'UPLOADING' && uploadCandidateBlob && activeRecordingId && currentTurn && speakingState) {
      if (finalizingRef.current) return;
      finalizingRef.current = true;

      const finalizeTurn = async () => {
        try {
          // 1. Upload audio chunk & seal recording
          await uploadAndSeal(activeRecordingId, uploadCandidateBlob);
          setExaminerPhase('SEALED');

          // Brief delay so candidate sees "Bản ghi đã được niêm phong an toàn!"
          await new Promise((resolve) => setTimeout(resolve, 1500));

          // 2. Refresh speaking state to get latest authoritative turnRevision before CompleteTurnCommand
          let currentRev = speakingState.turnRevision;
          let currentToken = speakingState.transitionToken;
          try {
            const freshCheck = await examsApi.getSpeakingState(attemptId);
            if (freshCheck) {
              currentRev = freshCheck.turnRevision;
              currentToken = freshCheck.transitionToken || currentToken;
              setSpeakingState(freshCheck);
            }
          } catch {}

          // 3. Submit CompleteTurnCommand to server
          const durationMs = Math.max(1000, recordElapsed * 1000);
          const compCmd: CompleteTurnCommand = {
            clientMutationId: `cmd-comp-${currentTurn.turnKey}-${Date.now()}`,
            expectedTurnRevision: currentRev,
            recordingId: activeRecordingId,
            durationMs,
            turnKey: currentTurn.turnKey,
            transitionToken: currentToken || undefined,
          };

          const nextState = await examsApi.completeSpeakingTurn(attemptId, compCmd);
          onTurnCompletedRef.current?.(currentTurn.turnKey, activeRecordingId);

          setSpeakingState(nextState);
          activeBlobRef.current = null;

          if (nextState.sectionCompleted) {
            setExaminerPhase('SECTION_COMPLETED');
            onSectionCompletedRef.current?.();
          } else if (nextState.currentTurn) {
            // Reset for next revealed turn
            setActiveRecordingId(null);
            setRecordElapsed(0);
            determineInitialTurnPhase(nextState.currentTurn, nextState.activePartCode || '');
          }
        } catch (err: any) {
          console.error('Failed to complete Speaking turn:', err);
          const errorMsg = err?.response?.data?.message || err?.message || 'Failed to complete speaking turn';
          setError(errorMsg);

          // If turn already completed or revision advanced on server:
          try {
            const freshState = await examsApi.getSpeakingState(attemptId);
            if (freshState) {
              setSpeakingState(freshState);
              if (freshState.currentTurn?.turnKey !== currentTurn.turnKey || freshState.sectionCompleted) {
                setExaminerPhase(freshState.sectionCompleted ? 'SECTION_COMPLETED' : 'SEALED');
                if (freshState.sectionCompleted) onSectionCompletedRef.current?.();
                return;
              }
            }
          } catch {}

          // Do NOT fail sealed recordings
          if (!isSealed && !errorMsg.includes('already SEALED') && !errorMsg.includes('ALREADY_SEALED')) {
            failActiveRecording(activeRecordingId, 'UPLOAD_NETWORK_ERROR').catch(() => {});
          }
          setExaminerPhase('FAILED_UPLOAD');
        } finally {
          finalizingRef.current = false;
        }
      };

      finalizeTurn();
    }
  }, [examinerPhase, audioBlob, activeRecordingId, currentTurn, speakingState, attemptId, recordElapsed, uploadAndSeal, failActiveRecording, determineInitialTurnPhase, isSealed]);

  if (isLoading && !speakingState) {
    return (
      <div className="flex-1 flex items-center justify-center p-12">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <span className="text-xs text-muted-foreground">Đang tải phòng thi Speaking...</span>
        </div>
      </div>
    );
  }

  if (error && !speakingState) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="bg-destructive/10 border border-destructive/30 rounded-2xl p-6 max-w-md w-full space-y-4 text-center">
          <AlertCircle className="w-10 h-10 text-destructive mx-auto" />
          <div className="text-sm font-bold text-foreground">Lỗi phòng thi Speaking</div>
          <p className="text-xs text-muted-foreground">{error}</p>
          <button
            onClick={refreshSpeakingState}
            className="px-4 py-2 bg-primary text-primary-foreground text-xs font-bold rounded-xl shadow cursor-pointer hover:bg-primary/90"
          >
            Thử lại
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-background text-foreground overflow-y-auto p-6 md:p-8">
      {/* 1. Mic Permission Preflight Modal */}
      {showMicModal && !micGranted && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-5 animate-in fade-in zoom-in-95 text-foreground">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-2xl bg-primary/10 text-primary flex items-center justify-center border border-primary/20">
                <Mic className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-foreground">
                  Cấp quyền microphone để vào phòng thi Speaking
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Quy định phòng thi trực tuyến IELTS Speaking
                </p>
              </div>
            </div>

            <p className="text-xs text-foreground/90 leading-relaxed bg-muted/30 p-3.5 rounded-xl border border-border">
              Hệ thống cần quyền microphone để thu âm câu trả lời trực tiếp của bạn cho giám khảo. Bản ghi sẽ được niêm phong mật mã an toàn trên máy chủ.
            </p>

            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                id="speaking-grant-mic-btn"
                onClick={handleRequestMic}
                disabled={micChecking}
                className="w-full py-2.5 px-5 bg-primary text-primary-foreground text-xs font-bold rounded-xl shadow hover:bg-primary/90 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                {micChecking ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Đang kiểm tra micro...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4" />
                    <span>Cho phép microphone</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-4xl mx-auto w-full space-y-6">
        {/* Server Authoritative Progress Bar (Strict Prompt Withholding: NO Item Switcher) */}
        <div className="bg-card border border-border rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="px-3 py-1 bg-primary/10 text-primary border border-primary/20 text-xs font-bold rounded-lg uppercase tracking-wider">
              {speakingState?.activePartCode === 'SPEAKING_PART_1'
                ? 'IELTS Speaking Part 1'
                : speakingState?.activePartCode === 'SPEAKING_PART_2'
                ? 'IELTS Speaking Part 2'
                : 'IELTS Speaking Part 3'}
            </span>
            <span className="text-xs font-medium text-muted-foreground">
              Lượt câu hỏi: <strong className="text-foreground">{speakingState?.currentTurnCursor}</strong> / {speakingState?.totalTurns}
            </span>
          </div>

          <div className="flex items-center gap-2 text-xs">
            {/* Locked Turns Badge */}
            {speakingState && speakingState.lockedTurnCount > 0 && (
              <div
                id="speaking-locked-turns-badge"
                className="inline-flex items-center gap-1.5 px-3 py-1 bg-muted/60 text-muted-foreground rounded-lg border border-border/80 font-medium"
                title="Các câu hỏi tiếp theo được bảo mật bởi giám khảo"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>{speakingState.lockedTurnCount} câu hỏi được bảo mật</span>
              </div>
            )}

            {/* Mic Status */}
            <div className="flex items-center gap-2 pl-2 border-l border-border">
              <span className={`w-2 h-2 rounded-full ${micGranted ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
              <span className="text-[11px] text-muted-foreground">
                {micGranted ? 'Micro đã sẵn sàng' : 'Chưa cấp quyền'}
              </span>
            </div>
          </div>
        </div>

        {/* SECTION COMPLETED STATE */}
        {examinerPhase === 'SECTION_COMPLETED' ? (
          <div
            id="speaking-section-completed-badge"
            className="bg-card border border-border rounded-2xl p-10 text-center shadow-sm space-y-4 animate-in fade-in"
          >
            <div className="h-16 w-16 rounded-3xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center mx-auto border border-emerald-500/20">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h2 className="text-lg font-bold text-foreground">
              Đã hoàn thành toàn bộ phần thi IELTS Speaking!
            </h2>
            <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
              Tất cả các lượt trả lời của bạn đã được niêm phong mật mã an toàn và gắn với hồ sơ bài thi. Bạn có thể nộp bài hoặc chuyển sang phần thi tiếp theo.
            </p>
          </div>
        ) : (
          <>
            {/* Prompt Card: Strictly displays current turn only */}
            {currentTurn && (
              <div
                id="speaking-prompt-card"
                className="bg-card border border-border rounded-xl p-6 shadow-sm space-y-4"
              >
                <div className="flex items-center justify-between border-b border-border/80 pb-3">
                  <span className="text-xs font-bold uppercase tracking-wider text-primary flex items-center gap-2">
                    <MessageSquare className="w-3.5 h-3.5" aria-hidden />
                    {isPart2 ? (lang === 'en' ? 'Cue Card Topic' : 'Chủ đề thuyết trình') : (lang === 'en' ? 'Examiner Question' : 'Câu hỏi từ Giám khảo')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {isPart2 ? 'Chuẩn bị 60s • Nói tối đa 120s' : 'Nói tối đa 60s'}
                  </span>
                </div>

                <div className="space-y-2">
                  <h2
                    id="speaking-current-prompt-text"
                    className="text-base sm:text-lg font-medium text-foreground leading-relaxed whitespace-pre-line"
                  >
                    {currentTurn.prompt}
                  </h2>
                </div>

                {/* Examiner Media (if video/audio exists) */}
                {mediaUrl && (
                  <div className="pt-2">
                    {isVideo ? (
                      <video
                        id="examiner-video-element"
                        ref={setMediaElementRef as any}
                        src={mediaUrl}
                        controls
                        onPlay={() => setExaminerPhase('EXAMINER_PLAYING')}
                        onEnded={handlePresentationFinished}
                        className="w-full max-h-64 rounded-xl border border-border bg-black"
                      />
                    ) : (
                      <div className="relative rounded-2xl overflow-hidden border border-border bg-gradient-to-b from-card to-muted/40 shadow-inner p-4 flex flex-col items-center justify-center gap-3">
                        <div className="relative w-28 h-28 rounded-full overflow-hidden border-2 border-primary/40 shadow-md">
                          <img
                            src="/storage/exams/examiner/examiner_poster.jpg"
                            alt="Examiner"
                            className="w-full h-full object-cover"
                          />
                          {examinerPhase === 'EXAMINER_PLAYING' && (
                            <div className="absolute inset-0 bg-primary/20 backdrop-blur-[1px] flex items-center justify-center">
                              <span className="flex h-3.5 w-3.5 relative">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-primary"></span>
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                          <Volume2 className={`w-4 h-4 ${examinerPhase === 'EXAMINER_PLAYING' ? 'text-primary animate-pulse' : 'text-muted-foreground'}`} />
                          <span>
                            {examinerPhase === 'EXAMINER_PLAYING'
                              ? (lang === 'en' ? 'Examiner reading question...' : 'Giám khảo đang đọc câu hỏi...')
                              : (lang === 'en' ? 'Online Examiner' : 'Giám khảo trực tuyến')}
                          </span>
                        </div>
                        <audio
                          id="examiner-audio-element"
                          ref={setMediaElementRef as any}
                          src={mediaUrl}
                          controls
                          onPlay={() => setExaminerPhase('EXAMINER_PLAYING')}
                          onEnded={handlePresentationFinished}
                          className="w-full max-w-md h-10 mt-1"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Unsent Memory Truthful Recovery Notice */}
            <div
              id="speaking-unsent-memory-notice"
              className="text-[11px] text-muted-foreground flex items-center gap-1.5 bg-muted/40 px-3.5 py-2 rounded-xl border border-border/50 text-left"
            >
              <span className="font-bold text-foreground shrink-0">Lưu ý phục hồi:</span>
              <span>Bản ghi âm trong bộ nhớ tạm chưa gửi sẽ không thể khôi phục sau khi tải lại trang. Chỉ các chunk đã được máy chủ ghi nhận mới được bảo toàn.</span>
            </div>

            {/* Examiner Interaction Console */}
            <div className="bg-card border border-border rounded-2xl p-8 text-center shadow-sm space-y-6">
              {/* Phase: EXAMINER_READY (Media present, waiting to play) */}
              {examinerPhase === 'EXAMINER_READY' && (
                <div className="space-y-4 max-w-md mx-auto">
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-400 text-xs font-semibold">
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>EXAMINER_READY: Giám khảo đã sẵn sàng</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Bấm để nghe giám khảo đọc câu hỏi.
                  </p>
                  <button
                    id="speaking-play-media-btn"
                    onClick={handleExaminerPlayMedia}
                    className="px-6 py-2.5 bg-primary text-primary-foreground text-xs font-bold rounded-xl hover:bg-primary/90 transition-all shadow cursor-pointer flex items-center justify-center gap-2 mx-auto"
                  >
                    <Play className="w-4 h-4" />
                    <span>Nghe câu hỏi</span>
                  </button>
                </div>
              )}

              {/* Phase: EXAMINER_PLAYING (Media playing, candidate recording disabled) */}
              {examinerPhase === 'EXAMINER_PLAYING' && (
                <div className="space-y-4 max-w-md mx-auto">
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-400 text-xs font-semibold animate-pulse">
                    <Volume2 className="w-3.5 h-3.5 animate-bounce" />
                    <span>EXAMINER_PLAYING: Giám khảo đang đặt câu hỏi...</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Vui lòng lắng nghe cẩn thận. Bạn có thể bắt đầu trả lời sau khi giám khảo dứt lời.
                  </p>
                  <button
                    disabled
                    className="px-6 py-2.5 bg-muted text-muted-foreground text-xs font-bold rounded-xl opacity-60 cursor-not-allowed flex items-center justify-center gap-2 mx-auto"
                  >
                    <Mic className="w-4 h-4" />
                    <span>Đang chờ giám khảo hoàn thành...</span>
                  </button>
                </div>
              )}

              {/* Phase: EXAMINER_TEXT_FALLBACK (No media, candidate acknowledges reading prompt) */}
              {examinerPhase === 'EXAMINER_TEXT_FALLBACK' && (
                <div className="space-y-4 max-w-md mx-auto">
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-semibold">
                    <FileText className="w-3.5 h-3.5" />
                    <span>Câu hỏi hiển thị dạng văn bản</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {isPart2
                      ? (lang === 'en' ? 'Review the prompt carefully. Click confirm below to start 60s preparation.' : 'Đọc kỹ các gợi ý trên phiếu chủ đề. Bấm nút xác nhận bên dưới để bắt đầu 60 giây chuẩn bị.')
                      : (lang === 'en' ? 'Read the question above carefully and click confirm to start answering.' : 'Đọc kỹ câu hỏi phía trên và bấm nút xác nhận để bắt đầu trả lời.')}
                  </p>
                  <button
                    id="speaking-text-ack-btn"
                    onClick={handleTextFallbackAck}
                    className="px-6 py-2.5 bg-primary text-primary-foreground text-xs font-bold rounded-xl hover:bg-primary/90 transition-all shadow cursor-pointer flex items-center justify-center gap-2 mx-auto"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{isPart2 ? (lang === 'en' ? 'I understand (Start preparation)' : 'Tôi đã hiểu đề') : (lang === 'en' ? 'Ready to answer' : 'Sẵn sàng trả lời')}</span>
                  </button>
                </div>
              )}

              {/* Phase: PREPARATION (Part 2 Cue Card Countdown) */}
              {examinerPhase === 'PREPARATION' && (
                <div className="space-y-5 max-w-md mx-auto">
                  <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs font-bold">
                    <Clock className="w-3.5 h-3.5 animate-spin" />
                    <span>{lang === 'en' ? 'Preparation Time (Part 2)' : 'Thời gian chuẩn bị'}</span>
                  </div>

                  <div id="speaking-prep-countdown" className="text-5xl font-mono font-extrabold text-foreground">
                    {prepRemaining}s
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Chuẩn bị ý tưởng và ghi chú. Khi hết 60 giây, hệ thống sẽ tự động chuyển sang trạng thái thu âm.
                  </p>

                  <button
                    id="speaking-skip-prep-btn"
                    onClick={handleBeginCandidateRecording}
                    className="inline-flex items-center gap-2 px-4 py-2 border border-input rounded-xl text-xs font-semibold hover:bg-muted transition-colors cursor-pointer"
                  >
                    <FastForward className="w-4 h-4" />
                    <span>{lang === 'en' ? 'Start speaking now' : 'Bắt đầu nói ngay'}</span>
                  </button>
                </div>
              )}

              {/* Phase: READY_TO_RECORD (Presentation completed, ready to speak) */}
              {examinerPhase === 'READY_TO_RECORD' && (
                <div className="space-y-4 max-w-md mx-auto">
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs font-semibold">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>READY_TO_RECORD: Sẵn sàng ghi âm</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Bấm nút bên dưới để bắt đầu thu âm câu trả lời của bạn.
                  </p>
                  <button
                    id="speaking-start-answer-btn"
                    onClick={handleBeginCandidateRecording}
                    className="px-6 py-2.5 bg-primary text-primary-foreground text-xs font-bold rounded-xl hover:bg-primary/90 transition-all shadow cursor-pointer flex items-center justify-center gap-2 mx-auto"
                  >
                    <Mic className="w-4 h-4" />
                    <span>Bắt đầu trả lời</span>
                  </button>
                </div>
              )}

              {/* Phase: RECORDING (Active Recording) */}
              {examinerPhase === 'RECORDING' && (
                <div className="space-y-6 max-w-md mx-auto">
                  <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-rose-500/15 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs font-bold animate-pulse">
                    <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                    <span>Đang thu âm câu trả lời</span>
                  </div>

                  <div id="speaking-record-timer" className="text-5xl font-mono font-extrabold text-foreground">
                    {Math.floor(recordElapsed / 60)}:{(recordElapsed % 60).toString().padStart(2, '0')}
                    <span className="text-xs font-normal text-muted-foreground ml-2">
                      / {Math.floor(maxRecordSeconds / 60)}:{(maxRecordSeconds % 60).toString().padStart(2, '0')}
                    </span>
                  </div>

                  {/* Waveform visualizer */}
                  <div className="flex items-center justify-center gap-1.5 h-10">
                    {[40, 70, 30, 85, 60, 95, 45, 80, 50, 65, 35, 90, 55, 75].map((h, i) => (
                      <span
                        key={i}
                        className="w-1.5 bg-primary rounded-full animate-pulse"
                        style={{
                          height: `${Math.max(15, (h * (audioLevel || 40)) / 100)}%`,
                          animationDelay: `${i * 70}ms`,
                        }}
                      />
                    ))}
                  </div>

                  <button
                    id="speaking-stop-recording-btn"
                    onClick={handleStopCandidateRecording}
                    className="px-6 py-2.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow transition-all flex items-center justify-center gap-2 mx-auto cursor-pointer"
                  >
                    <Square className="w-4 h-4 fill-current" />
                    <span>Hoàn thành câu trả lời</span>
                  </button>
                </div>
              )}

              {/* Phase: UPLOADING (Chunk upload & sealing) */}
              {examinerPhase === 'UPLOADING' && (
                <div className="space-y-4 max-w-md mx-auto">
                  <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
                  <div className="text-sm font-bold text-foreground">Đang tải và niêm phong bản ghi âm...</div>
                  <div
                    id="speaking-chunk-ack-badge"
                    className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-400 text-xs font-semibold"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>{acknowledgedChunkCount} chunk đã xác nhận</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Bản ghi đang được mã hóa và lưu trữ an toàn trên máy chủ. Vui lòng không đóng trình duyệt.
                  </p>
                </div>
              )}

              {/* Phase: SEALED (Recorded and sealed) */}
              {examinerPhase === 'SEALED' && (
                <div className="space-y-4 max-w-md mx-auto">
                  <div className="h-12 w-12 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center mx-auto border border-emerald-500/20">
                    <CheckCircle2 className="w-6 h-6" />
                  </div>
                  <div id="speaking-recording-sealed-badge" className="text-sm font-bold text-foreground">
                    Bản ghi đã được niêm phong an toàn!
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Đang chuyển sang câu hỏi tiếp theo từ giám khảo...
                  </p>
                </div>
              )}

              {/* Phase: FAILED_UPLOAD (Upload error, actionable recovery) */}
              {examinerPhase === 'FAILED_UPLOAD' && (
                <div id="speaking-upload-failed-alert" className="space-y-4 max-w-md mx-auto">
                  <div className="h-12 w-12 rounded-2xl bg-destructive/10 text-destructive flex items-center justify-center mx-auto border border-destructive/20">
                    <AlertCircle className="w-6 h-6" />
                  </div>
                  <div className="text-sm font-bold text-destructive">
                    Không thể hoàn tất tải lên bản ghi âm
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {error || 'Lỗi mạng hoặc gián đoạn kết nối trong quá trình niêm phong. Bản ghi chưa được hoàn thành.'}
                  </p>
                  <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
                    <button
                      id="speaking-retry-upload-btn"
                      onClick={() => setExaminerPhase('UPLOADING')}
                      className="w-full sm:w-auto px-5 py-2.5 bg-primary text-primary-foreground text-xs font-bold rounded-xl hover:bg-primary/90 transition-all shadow cursor-pointer flex items-center justify-center gap-2"
                    >
                      <RotateCcw className="w-4 h-4" />
                      <span>Thử tải lại</span>
                    </button>
                    <button
                      id="speaking-new-generation-btn"
                      onClick={handleRetryNewGeneration}
                      className="w-full sm:w-auto px-5 py-2.5 border border-border bg-card text-foreground text-xs font-bold rounded-xl hover:bg-muted transition-all cursor-pointer flex items-center justify-center gap-2"
                    >
                      <Mic className="w-4 h-4" />
                      <span>Ghi âm lượt mới</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
