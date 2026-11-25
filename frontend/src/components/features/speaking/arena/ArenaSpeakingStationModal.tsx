'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flag,
  MapPin,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Square,
  Users,
  X,
} from 'lucide-react';
import { formatTime, selectSupportedRecorderMimeType } from '@/hooks/useAudioRecorder';
import { echoSrc } from '@/lib/brand/echoCharacters';
import {
  analyzeQuickCheck,
  recheckQuickCheck,
  type QuickCheckResponse,
} from '@/services/speakingApi';
import { arenaStations, type StationDrillPreset } from './arenaCopy';
import hud from './arenaHud.module.css';

export interface ArenaSpeakingStationModalProps {
  stationId: string;
  vi: boolean;
  onClose: () => void;
  /** Multiplayer room host controls (preserved for seamless ArenaExperience room sync) */
  isHost?: boolean;
  roomPhase?: string | null;
  roomRound?: number;
  roomBusy?: boolean;
  canTriggerRoomTurn?: boolean;
  onSetRoomTopic?: (headingEn: string, promptIndex: number) => void;
  onStartRoomTurn?: (headingEn: string, promptIndex: number) => void;
  onStationPracticed?: (stationId: string) => void;
  /** Called whenever kiosk recording/playback starts or stops so live room voice and ambience isolate cleanly. */
  onRecordingChange?: (active: boolean) => void;
}

type StudioTab = 'drill' | 'record';
type RecorderPhase = 'idle' | 'requesting' | 'recording' | 'reviewing';

const IELTS_PART2_OVERRIDE: StationDrillPreset = {
  prepSeconds: 60,
  talkSeconds: 120,
  labelEn: 'IELTS Part 2 · 60s + 120s',
  labelVi: 'IELTS Part 2 · 60s + 120s',
};

const STANDARD_OVERRIDE: StationDrillPreset = {
  prepSeconds: 20,
  talkSeconds: 60,
  labelEn: 'Quick Turn · 20s + 60s',
  labelVi: 'Lượt nhanh · 20s + 60s',
};

function describeAiError(err: unknown, vi: boolean): string {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  if (status === 401) {
    return vi
      ? 'Vui lòng đăng nhập tài khoản để gửi bản thu tới bộ chấm AI. Bạn vẫn có thể tự thu và nghe lại miễn phí tại trạm.'
      : 'Please sign in to submit audio for AI assessment. Local recording and self-playback remain free at every station.';
  }
  if (status === 402 || status === 403) {
    return vi
      ? 'Tính năng Chấm phát âm và diễn đạt AI thuộc gói Premium hoặc đã hết lượt miễn phí. Bạn vẫn có thể thu âm, nghe lại và luyện bấm giờ tự do.'
      : 'AI pronunciation and language check requires an active Premium AI allowance. Local recording, self-listen, and timed drills remain open.';
  }
  if (status === 429) {
    return vi
      ? 'Bạn gửi yêu cầu chấm hơi nhanh hoặc đã chạm hạn mức tạm thời. Hãy chờ ít phút rồi thử lại.'
      : 'Too many AI check requests in a short window. Please wait briefly and try again.';
  }
  if (status === 503 || status === 502 || status === 504) {
    return vi
      ? 'Máy chủ phân tích giọng nói đang bận. Bản thu của bạn vẫn được giữ nguyên để nghe lại hoặc bấm gửi lại sau.'
      : 'The speech analysis service is temporarily busy. Your recording is preserved locally to replay or retry shortly.';
  }
  return vi
    ? 'Chưa thể phân tích bản thu lúc này. Vui lòng kiểm tra kết nối và thử lại.'
    : 'Could not analyze this recording right now. Please check your connection and try again.';
}

export default function ArenaSpeakingStationModal({
  stationId,
  vi,
  onClose,
  isHost = false,
  roomPhase = null,
  roomRound = 0,
  roomBusy = false,
  canTriggerRoomTurn = true,
  onSetRoomTopic,
  onStartRoomTurn,
  onStationPracticed,
  onRecordingChange,
}: ArenaSpeakingStationModalProps) {
  const headingId = useId();
  const station = arenaStations[stationId] ?? arenaStations['kiosk-commons'];

  const [topicIdx, setTopicIdx] = useState(0);
  const [activeTab, setActiveTab] = useState<StudioTab>('drill');
  const [useIeltsLongTurn, setUseIeltsLongTurn] = useState(station.category === 'ielts_part2');

  // Timed solo / IELTS drill state (100% local monotonic clock, 0 network calls)
  const [drill, setDrill] = useState<{
    phase: 'prep' | 'talk' | 'done';
    startedAt: number;
    until: number;
    totalMs: number;
  } | null>(null);
  const [drillNow, setDrillNow] = useState<number>(0);

  // Single-stream MediaRecorder + WebAudio RMS ring + local self-playback state
  const [recPhase, setRecPhase] = useState<RecorderPhase>('idle');
  const [recSeconds, setRecSeconds] = useState(0);
  const [rmsLevel, setRmsLevel] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);

  // Explicit user-initiated QuickCheck AI state (NEVER triggered passively!)
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRechecking, setIsRechecking] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [quickResult, setQuickResult] = useState<QuickCheckResponse | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [editedTranscript, setEditedTranscript] = useState('');

  const generationRef = useRef(0);
  const activeAttemptRef = useRef<string | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);
  const aiInFlightRef = useRef(false);
  const onRecordingChangeRef = useRef(onRecordingChange);
  useEffect(() => {
    onRecordingChangeRef.current = onRecordingChange;
  }, [onRecordingChange]);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rmsTimerRef = useRef<number | null>(null);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recStartMsRef = useRef(0);

  const kioskAudioActive = recPhase === 'requesting' || recPhase === 'recording' || isPlaying;
  useEffect(() => {
    onRecordingChangeRef.current?.(kioskAudioActive);
  }, [kioskAudioActive]);

  const topic = station.topics[topicIdx % station.topics.length];

  const activePreset: StationDrillPreset = useMemo(() => {
    if (station.category === 'ielts_part2') {
      return useIeltsLongTurn ? station.drillPreset : STANDARD_OVERRIDE;
    }
    return useIeltsLongTurn ? IELTS_PART2_OVERRIDE : station.drillPreset;
  }, [station.category, station.drillPreset, useIeltsLongTurn]);

  const stopLiveCapture = useCallback(() => {
    if (rmsTimerRef.current !== null) {
      window.clearInterval(rmsTimerRef.current);
      rmsTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      try {
        recorderRef.current.stop();
      } catch {
        // Ignore stop race
      }
    }
    recorderRef.current = null;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors
        }
      }
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setRmsLevel(0);
  }, []);

  const clearRecording = useCallback(() => {
    generationRef.current += 1;
    activeAttemptRef.current = null;
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    aiInFlightRef.current = false;
    stopLiveCapture();
    if (playerRef.current) {
      playerRef.current.pause();
      playerRef.current = null;
    }
    if (objectUrlRef.current) {
      try {
        URL.revokeObjectURL(objectUrlRef.current);
      } catch {
        // Ignore revoke error
      }
      objectUrlRef.current = null;
    }
    chunksRef.current = [];
    setAudioBlob(null);
    setAudioUrl(null);
    setIsPlaying(false);
    setRecSeconds(0);
    setRecPhase('idle');
    setRecError(null);
    setIsAnalyzing(false);
    setIsRechecking(false);
    setAiError(null);
    setQuickResult(null);
    setAttemptId(null);
    setEditedTranscript('');
    onRecordingChangeRef.current?.(false);
  }, [stopLiveCapture]);

  // Reset station state cleanly when switching stationId or unmounting (0 network calls!)
  useEffect(() => {
    setTopicIdx(0);
    setDrill(null);
    setUseIeltsLongTurn(station.category === 'ielts_part2');
    clearRecording();
  }, [stationId, station.category, clearRecording]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      activeAttemptRef.current = null;
      aiAbortRef.current?.abort();
      aiAbortRef.current = null;
      aiInFlightRef.current = false;
      stopLiveCapture();
      if (playerRef.current) {
        playerRef.current.pause();
        playerRef.current = null;
      }
      if (objectUrlRef.current) {
        try {
          URL.revokeObjectURL(objectUrlRef.current);
        } catch {
          // Ignore
        }
        objectUrlRef.current = null;
      }
      onRecordingChangeRef.current?.(false);
    };
  }, [stopLiveCapture]);

  // Monotonic Timed Drill Ticker
  useEffect(() => {
    if (!drill || drill.phase === 'done') return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setDrillNow(now);
      if (now >= drill.until) {
        setDrill(prev => {
          if (!prev) return null;
          if (prev.phase === 'prep') {
            const talkMs = activePreset.talkSeconds * 1000;
            return { phase: 'talk', startedAt: now, until: now + talkMs, totalMs: talkMs };
          }
          onStationPracticed?.(station.id);
          return { phase: 'done', startedAt: now, until: now, totalMs: prev.totalMs };
        });
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [activePreset.talkSeconds, drill, onStationPracticed, station.id]);

  const startTimedDrill = () => {
    const now = Date.now();
    const prepMs = activePreset.prepSeconds * 1000;
    setDrillNow(now);
    setDrill({ phase: 'prep', startedAt: now, until: now + prepMs, totalMs: prepMs });
  };

  const skipPrepToTalk = () => {
    const now = Date.now();
    const talkMs = activePreset.talkSeconds * 1000;
    setDrillNow(now);
    setDrill({ phase: 'talk', startedAt: now, until: now + talkMs, totalMs: talkMs });
  };

  const finishDrill = () => {
    const now = Date.now();
    onStationPracticed?.(station.id);
    setDrill(prev => ({
      phase: 'done',
      startedAt: now,
      until: now,
      totalMs: prev?.totalMs ?? activePreset.talkSeconds * 1000,
    }));
  };

  // Start single-stream local microphone recording + live WebAudio RMS level meter
  const handleStartRecording = async () => {
    if (recPhase === 'recording' || recPhase === 'requesting') return;
    clearRecording();
    const gen = ++generationRef.current;
    onRecordingChangeRef.current?.(true);
    setRecPhase('requesting');

    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error(vi ? 'Trình duyệt này chưa hỗ trợ ghi âm.' : 'Audio recording is not supported in this browser.');
      }
      // Disable WebRTC DSP (AEC/NS/AGC) and capture mono so Module 09 pronunciation scoring preserves fricatives/stops/stress.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });

      // Race-safe guard if learner closed the card while permission prompt was open
      if (gen !== generationRef.current) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }

      streamRef.current = stream;
      chunksRef.current = [];

      // Attach WebAudio AnalyserNode to the exact same stream for genuine acoustic RMS ring
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      let analyser: AnalyserNode | null = null;
      let sampleBuf: Float32Array<ArrayBuffer> | null = null;
      if (Ctx) {
        const audioCtx = new Ctx();
        if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
          void audioCtx.resume().catch(() => undefined);
        }
        audioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        sampleBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      }

      const selectedMime = selectSupportedRecorderMimeType();
      const baseOptions: MediaRecorderOptions = selectedMime ? { mimeType: selectedMime } : {};
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, { ...baseOptions, audioBitsPerSecond: 128000 });
      } catch {
        recorder = new MediaRecorder(stream, baseOptions);
      }
      const effectiveMime = recorder.mimeType || selectedMime || 'audio/webm';
      recorderRef.current = recorder;

      recorder.ondataavailable = (ev: BlobEvent) => {
        if (gen !== generationRef.current) return;
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };

      recorder.onstop = () => {
        if (gen !== generationRef.current) return;
        const elapsed = Math.max(0.2, (Date.now() - recStartMsRef.current) / 1000);
        setRecSeconds(elapsed);
        stopLiveCapture();

        if (chunksRef.current.length > 0) {
          const blob = new Blob(chunksRef.current, { type: effectiveMime });
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          setAudioBlob(blob);
          setAudioUrl(url);
          setRecPhase('reviewing');
          onStationPracticed?.(station.id);
        } else {
          setRecPhase('idle');
        }
      };

      recorder.onerror = () => {
        if (gen !== generationRef.current) return;
        stopLiveCapture();
        setRecPhase('idle');
        setRecError(
          vi
            ? 'Ghi âm bị gián đoạn. Vui lòng kiểm tra micro rồi thử lại.'
            : 'Microphone recording was interrupted. Please check your mic and retry.',
        );
      };

      recStartMsRef.current = Date.now();
      recorder.start(100);
      setRecPhase('recording');

      rmsTimerRef.current = window.setInterval(() => {
        if (gen !== generationRef.current) return;
        const sec = (Date.now() - recStartMsRef.current) / 1000;
        setRecSeconds(sec);
        if (analyser && sampleBuf) {
          analyser.getFloatTimeDomainData(sampleBuf);
          let sumSq = 0;
          for (let i = 0; i < sampleBuf.length; i++) {
            sumSq += sampleBuf[i] * sampleBuf[i];
          }
          const rms = Math.sqrt(sumSq / sampleBuf.length);
          setRmsLevel(Math.min(1, rms * 4.5));
        }
        if (sec >= 120 && recorder.state === 'recording') {
          recorder.stop();
        }
      }, 80);
    } catch (err: unknown) {
      if (gen !== generationRef.current) return;
      stopLiveCapture();
      setRecPhase('idle');
      const name = (err as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setRecError(
          vi
            ? 'Quyền truy cập micro bị từ chối. Hãy cấp quyền micro trên trình duyệt rồi thử lại.'
            : 'Microphone permission was denied. Allow microphone access in your browser and try again.',
        );
      } else {
        setRecError(
          vi
            ? 'Không thể mở micro trên thiết bị này. Vui lòng kiểm tra thiết bị âm thanh.'
            : 'Could not open a microphone on this device. Please check your audio input.',
        );
      }
    }
  };

  const handleStopRecording = () => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.stop();
    }
  };

  const handleTogglePlayback = () => {
    if (!audioUrl) return;
    if (isPlaying && playerRef.current) {
      playerRef.current.pause();
      setIsPlaying(false);
      return;
    }
    if (!playerRef.current) {
      const audio = new Audio(audioUrl);
      audio.onended = () => setIsPlaying(false);
      audio.onpause = () => setIsPlaying(false);
      audio.onplay = () => setIsPlaying(true);
      playerRef.current = audio;
    }
    void playerRef.current.play().catch(() => setIsPlaying(false));
  };

  // EXPLICIT USER ACTION ONLY: Submit recorded blob to canonical `speakingApi.analyzeQuickCheck`
  const handleExplicitAiCheck = async () => {
    if (!audioBlob || audioBlob.size === 0 || isAnalyzing || aiInFlightRef.current) return;
    if (recSeconds > 0 && recSeconds < 0.4) {
      setAiError(
        vi
          ? 'Bản thu quá ngắn (dưới 0,4 giây). Hãy thu lại câu trả lời rõ ràng hơn.'
          : 'Recording is too short (under 0.4s). Please record a complete phrase and try again.',
      );
      return;
    }
    aiInFlightRef.current = true;
    setAiError(null);
    setIsAnalyzing(true);
    const nextAttemptId = `arena_qc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    setAttemptId(nextAttemptId);
    activeAttemptRef.current = nextAttemptId;

    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;

    try {
      const result = await analyzeQuickCheck(audioBlob, nextAttemptId, undefined, controller.signal);
      if (controller.signal.aborted || activeAttemptRef.current !== nextAttemptId) return;
      setQuickResult(result);
      const recognized = (result.intendedTranscript || result.whisperTranscript || '').trim();
      setEditedTranscript(recognized);
      if (result.sttStatus !== 'SUCCESS') {
        setAiError(
          vi
            ? 'Chưa nhận diện rõ câu nói tiếng Anh trong bản thu. Hãy thử thu lại ở nơi yên tĩnh hơn.'
            : 'Speech could not be recognized clearly in this clip. Try recording again a bit closer to the mic.',
        );
      }
    } catch (err: unknown) {
      if (controller.signal.aborted || activeAttemptRef.current !== nextAttemptId) return;
      setAiError(describeAiError(err, vi));
    } finally {
      if (activeAttemptRef.current === nextAttemptId) {
        aiInFlightRef.current = false;
        setIsAnalyzing(false);
      }
    }
  };

  // EXPLICIT USER ACTION ONLY: Recheck edited transcript via `speakingApi.recheckQuickCheck` (0 Whisper calls)
  const handleExplicitRecheck = async () => {
    if (!attemptId || !editedTranscript.trim() || isRechecking || isAnalyzing || aiInFlightRef.current) return;
    const reqAttemptId = attemptId;
    const reqToken = `${reqAttemptId}:recheck:${Date.now()}`;
    aiInFlightRef.current = true;
    activeAttemptRef.current = reqToken;
    setAiError(null);
    setIsRechecking(true);

    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;

    try {
      const updated = await recheckQuickCheck(reqAttemptId, editedTranscript.trim(), controller.signal);
      if (controller.signal.aborted || activeAttemptRef.current !== reqToken) return;
      setQuickResult(updated);
      setEditedTranscript((updated.intendedTranscript || updated.whisperTranscript || editedTranscript).trim());
    } catch (err: unknown) {
      if (controller.signal.aborted || activeAttemptRef.current !== reqToken) return;
      setAiError(describeAiError(err, vi));
    } finally {
      if (activeAttemptRef.current === reqToken) {
        aiInFlightRef.current = false;
        setIsRechecking(false);
      }
    }
  };

  const baselineTranscript = (quickResult?.intendedTranscript || quickResult?.whisperTranscript || '').trim();
  const hasTranscriptEdit = editedTranscript.trim().length > 0 && editedTranscript.trim() !== baselineTranscript;

  const drillRemainingSec = drill
    ? Math.max(0, Math.ceil((drill.until - (drillNow || Date.now())) / 1000))
    : 0;
  const drillProgressPct =
    drill && drill.phase !== 'done' && drill.totalMs > 0
      ? Math.min(100, Math.max(0, ((drill.until - (drillNow || Date.now())) / drill.totalMs) * 100))
      : 0;

  const canStartRoomRound =
    isHost &&
    roomPhase !== null &&
    ['LOBBY', 'FREE', 'REVIEW'].includes(roomPhase) &&
    roomRound < 6 &&
    canTriggerRoomTurn;

  return (
    <section
      className={`${hud.hudScope} ${hud.stationStudio}`}
      data-testid="arena-station-card"
      aria-labelledby={headingId}
    >
      {/* ── Header: Location, CEFR, Category & Close ── */}
      <header className={hud.stationHeader}>
        <div style={{ minWidth: 0 }}>
          <div className={hud.stationMetaRow}>
            <span className={hud.badge}>
              <MapPin size={11} />
              <span>{vi ? station.locationVi : station.locationEn}</span>
            </span>
            <span className={hud.cefrBadge} data-cefr={station.cefr}>
              CEFR {station.cefr}
            </span>
            <span className={hud.badge}>
              <BookOpen size={11} />
              <span>{vi ? station.categoryLabelVi : station.categoryLabelEn}</span>
            </span>
          </div>
          <h3 id={headingId} className={hud.stationTitle}>
            {vi ? station.titleVi : station.titleEn}
          </h3>
          <span className={hud.stationLocation}>{vi ? station.badgeVi : station.badgeEn}</span>
        </div>

        <button
          type="button"
          className={hud.iconBtn}
          onClick={onClose}
          aria-label={vi ? 'Đóng trạm luyện nói' : 'Close speaking station'}
        >
          <X size={16} />
        </button>
      </header>

      {/* ── Mode Tabs & Topic Pager ── */}
      <div className={hud.stationTabsRow}>
        <div className={hud.modeSegment} role="tablist" aria-label={vi ? 'Chế độ luyện nói' : 'Speaking practice mode'}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'drill'}
            className={hud.modeSegmentBtn}
            onClick={() => setActiveTab('drill')}
          >
            <Clock size={13} />
            <span>{vi ? 'Tự luyện bấm giờ' : 'Timed Drill'}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'record'}
            className={hud.modeSegmentBtn}
            onClick={() => setActiveTab('record')}
            data-testid="arena-station-tab-record"
          >
            <Mic size={13} />
            <span>{vi ? 'Thu âm và Chấm AI' : 'Record and AI Check'}</span>
          </button>
        </div>

        {station.topics.length > 1 && (
          <div className={hud.topicPager}>
            <button
              type="button"
              className={hud.iconBtn}
              style={{ width: 28, minWidth: 28, height: 28, minHeight: 28 }}
              onClick={() => {
                setDrill(null);
                clearRecording();
                setTopicIdx(i => (i - 1 + station.topics.length) % station.topics.length);
              }}
              aria-label={vi ? 'Chủ đề trước' : 'Previous topic'}
            >
              <ChevronLeft size={14} />
            </button>
            <span className={hud.mono}>
              {(topicIdx % station.topics.length) + 1}/{station.topics.length}
            </span>
            <button
              type="button"
              className={hud.iconBtn}
              style={{ width: 28, minWidth: 28, height: 28, minHeight: 28 }}
              onClick={() => {
                setDrill(null);
                clearRecording();
                setTopicIdx(i => (i + 1) % station.topics.length);
              }}
              aria-label={vi ? 'Chủ đề tiếp theo' : 'Next topic'}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>

      {/* ── Scrollable Scenario Content & Interactive Practice Stage ── */}
      <div className={hud.stationScroll}>
        {/* Bilingual Scenario Prompt Card */}
        <div className={hud.promptCard}>
          <h4 className={hud.promptHeading}>{vi ? topic.headingVi : topic.headingEn}</h4>
          <p className={hud.promptTextEn} lang="en">
            {topic.promptEn}
          </p>
          {vi && <p className={hud.promptTextVi}>{topic.promptVi}</p>}

          {/* IELTS Cue Card Bullets / Speaking Checklist */}
          {(vi ? topic.cueBulletsVi : topic.cueBulletsEn)?.length ? (
            <div className={hud.cueBox}>
              <small>
                {station.category === 'ielts_part2'
                  ? vi
                    ? 'Gợi ý triển khai thẻ IELTS Part 2 (You should say):'
                    : 'IELTS Part 2 Cue Card — You should say:'
                  : vi
                    ? 'Hướng triển khai ý:'
                    : 'Suggested speaking points:'}
              </small>
              <ul className={hud.cueList}>
                {(vi ? topic.cueBulletsVi : topic.cueBulletsEn)?.map(bullet => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {/* Key English Vocabulary Chips */}
        {topic.vocabulary && topic.vocabulary.length > 0 && (
          <div>
            <small
              style={{
                display: 'block',
                marginBottom: 6,
                fontSize: 11,
                fontWeight: 750,
                color: 'var(--ah-muted)',
              }}
            >
              {vi ? 'Từ vựng và cụm từ ăn điểm:' : 'Key English vocabulary and collocations:'}
            </small>
            <div className={hud.vocabGrid}>
              {topic.vocabulary.map(item => (
                <span key={item.word} className={hud.vocabChip}>
                  <b lang="en">{item.word}</b>
                  <span>— {vi ? item.noteVi : item.noteEn}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Natural English Model Phrases */}
        <div className={hud.phrasesWell}>
          <small>{vi ? 'Mẫu câu mở lời tự nhiên:' : 'Try saying aloud:'}</small>
          <ul className={hud.phrasesList} lang="en">
            {topic.phrases.map(ph => (
              <li key={ph}>“{ph}”</li>
            ))}
          </ul>
          {topic.followUpEn && (
            <small style={{ marginTop: 4, color: 'var(--ah-accent)' }}>
              {vi ? `Câu hỏi mở rộng: ${topic.followUpVi ?? topic.followUpEn}` : `Partner follow-up: ${topic.followUpEn}`}
            </small>
          )}
        </div>

        {/* ── TAB 1: TIMED SOLO / IELTS SPEAKING DRILL ── */}
        {activeTab === 'drill' && (
          <div className={hud.drillPanel} data-testid="arena-board-drill" data-phase={drill?.phase ?? 'idle'}>
            {!drill ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <strong style={{ fontSize: 13 }}>
                    {vi ? activePreset.labelVi : activePreset.labelEn}
                  </strong>
                  <span style={{ fontSize: 11.5, color: 'var(--ah-muted)' }}>
                    {vi
                      ? 'Đồng hồ bấm giờ tại chỗ · Không tự ghi âm hay gọi AI'
                      : 'Local monotonic timer · Zero background recording or AI calls'}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <button
                    type="button"
                    className={hud.btn}
                    aria-pressed={useIeltsLongTurn}
                    onClick={() => setUseIeltsLongTurn(v => !v)}
                  >
                    <span>{useIeltsLongTurn ? '60s + 120s' : '20s + 60s'}</span>
                  </button>
                  <button
                    type="button"
                    className={hud.btnPrimary}
                    data-testid="arena-board-practise"
                    onClick={startTimedDrill}
                  >
                    <Play size={14} />
                    <span>{vi ? 'Bắt đầu bấm giờ' : 'Start Timed Turn'}</span>
                  </button>
                </div>
              </div>
            ) : drill.phase === 'done' ? (
              <>
                <div className={hud.drillTopRow}>
                  <strong style={{ fontSize: 14, color: 'var(--ah-emerald)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <CheckCircle2 size={16} />
                    <span>{vi ? 'Hoàn thành lượt luyện nói!' : 'Speaking turn complete!'}</span>
                  </strong>
                  <button
                    type="button"
                    className={hud.btnPrimary}
                    data-testid="arena-board-practise"
                    onClick={startTimedDrill}
                  >
                    <RotateCcw size={14} />
                    <span>{vi ? 'Lượt mới' : 'Practise Again'}</span>
                  </button>
                </div>
                <ul className={hud.cueList}>
                  <li>{vi ? 'Bạn đã chèn được ít nhất 2 từ vựng hoặc mẫu câu gợi ý chưa?' : 'Did you weave in at least two target phrases or vocabulary items?'}</li>
                  <li>{vi ? 'Bạn có nêu ví dụ trải nghiệm cụ thể và kết câu trọn ý không?' : 'Did you support your point with a concrete example and clear conclusion?'}</li>
                </ul>
              </>
            ) : (
              <div role="timer" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className={hud.drillTopRow}>
                  <span className={hud.badge}>
                    {drill.phase === 'prep'
                      ? vi
                        ? 'Pha chuẩn bị dàn ý'
                        : 'Preparation Phase'
                      : vi
                        ? 'Pha nói liên tục — Hãy nói to rõ!'
                        : 'Speaking Phase — Speak aloud now!'}
                  </span>
                  <b className={`${hud.drillCountdown} ${hud.mono}`}>{drillRemainingSec}s</b>
                </div>
                <div className={hud.progressTrack}>
                  <div className={hud.progressFill} style={{ width: `${drillProgressPct}%` }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  {drill.phase === 'prep' && (
                    <button type="button" className={hud.btn} onClick={skipPrepToTalk}>
                      {vi ? 'Nói ngay' : 'Speak Now'}
                    </button>
                  )}
                  <button type="button" className={hud.btn} onClick={finishDrill}>
                    {vi ? 'Kết thúc lượt' : 'Finish Turn'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── TAB 2: REAL MICROPHONE RECORDING + SELF-LISTEN + EXPLICIT AI CHECK ── */}
        {activeTab === 'record' && (
          <div className={hud.recorderStage} data-testid="arena-station-recorder">
            {recPhase === 'idle' || recPhase === 'requesting' ? (
              <div className={hud.micRow}>
                <div className={hud.micOrbWrap}>
                  <button
                    type="button"
                    className={hud.micRecordBtn}
                    disabled={recPhase === 'requesting'}
                    onClick={() => void handleStartRecording()}
                    aria-label={vi ? 'Bắt đầu thu âm giọng nói' : 'Start microphone recording'}
                    data-testid="arena-station-rec-start"
                  >
                    <Mic size={22} />
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <strong style={{ fontSize: 13.5 }}>
                    {recPhase === 'requesting'
                      ? vi
                        ? 'Đang xin quyền truy cập micro…'
                        : 'Requesting microphone access…'
                      : vi
                        ? 'Nhấn để thu âm câu trả lời của bạn (tối đa 120 giây)'
                        : 'Tap to record your spoken response (up to 120 seconds)'}
                  </strong>
                  <span style={{ fontSize: 11.5, color: 'var(--ah-muted)' }}>
                    {vi
                      ? 'Nghe lại trực tiếp trên máy miễn phí · Chỉ chấm AI khi bạn bấm nút gửi'
                      : 'Listen back locally for free · AI check runs only when you explicitly submit'}
                  </span>
                </div>
              </div>
            ) : recPhase === 'recording' ? (
              <div className={hud.micRow} role="status" aria-live="polite">
                <div className={hud.micOrbWrap}>
                  <span
                    className={hud.micRmsRing}
                    style={{
                      transform: `scale(${(1 + rmsLevel * 0.42).toFixed(3)})`,
                      opacity: (0.35 + rmsLevel * 0.65).toFixed(2),
                    }}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    className={hud.micRecordBtn}
                    data-recording="true"
                    onClick={handleStopRecording}
                    aria-label={vi ? 'Dừng thu âm' : 'Stop recording'}
                    data-testid="arena-station-rec-stop"
                  >
                    <Square size={18} />
                  </button>
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <strong style={{ fontSize: 13, color: 'var(--ah-coral)' }}>
                      {vi ? 'Đang thu âm trực tiếp…' : 'Recording live audio…'}
                    </strong>
                    <span className={hud.mono} style={{ fontWeight: 800, fontSize: 15 }}>
                      {formatTime(recSeconds)}
                    </span>
                  </div>
                  <div className={hud.progressTrack}>
                    <div
                      className={hud.progressFill}
                      style={{ width: `${Math.min(100, rmsLevel * 100).toFixed(1)}%` }}
                    />
                  </div>
                </div>
                <button type="button" className={hud.btn} onClick={clearRecording}>
                  {vi ? 'Hủy' : 'Cancel'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                    <button
                      type="button"
                      className={hud.btn}
                      onClick={handleTogglePlayback}
                      data-testid="arena-station-self-listen"
                    >
                      {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                      <span>
                        {isPlaying
                          ? vi
                            ? 'Tạm dừng'
                            : 'Pause'
                          : vi
                            ? `Nghe lại (${formatTime(recSeconds)})`
                            : `Self-Listen (${formatTime(recSeconds)})`}
                      </span>
                    </button>
                    <button type="button" className={hud.btn} onClick={clearRecording}>
                      <RotateCcw size={14} />
                      <span>{vi ? 'Thu lại' : 'Record Again'}</span>
                    </button>
                  </div>

                  {!quickResult && (
                    <button
                      type="button"
                      className={hud.btnPrimary}
                      disabled={isAnalyzing}
                      onClick={() => void handleExplicitAiCheck()}
                      data-testid="arena-station-ai-submit"
                    >
                      <img src={echoSrc('official', 24)} width={16} height={16} alt="" aria-hidden="true" />
                      <span>
                        {isAnalyzing
                          ? vi
                            ? 'Đang phân tích giọng nói…'
                            : 'Analyzing speech…'
                          : vi
                            ? 'Chấm phát âm và phản hồi AI'
                            : 'AI Pronunciation and Language Check'}
                      </span>
                    </button>
                  )}
                </div>

                {/* Canonical `speakingApi.analyzeQuickCheck` Result Display (Zero Invented Scores) */}
                {quickResult && quickResult.sttStatus === 'SUCCESS' && (
                  <div className={hud.aiResultStack} data-testid="arena-station-ai-result">
                    <div>
                      <small style={{ display: 'block', marginBottom: 4, fontSize: 11, fontWeight: 750, color: 'var(--ah-muted)' }}>
                        {vi ? 'Nội dung nhận diện (có thể chỉnh lại nếu tên riêng khác):' : 'Recognized transcript (edit if a proper noun differed):'}
                      </small>
                      <textarea
                        rows={2}
                        maxLength={500}
                        value={editedTranscript}
                        onChange={e => setEditedTranscript(e.target.value)}
                        aria-label={vi ? 'Nội dung câu nói nhận diện' : 'Recognized spoken transcript'}
                        className={hud.transcriptInput}
                      />
                      {hasTranscriptEdit && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                          <button
                            type="button"
                            className={hud.btnPrimary}
                            disabled={isRechecking}
                            onClick={() => void handleExplicitRecheck()}
                          >
                            <Check size={14} />
                            <span>
                              {isRechecking
                                ? vi
                                  ? 'Đang chấm lại…'
                                  : 'Rechecking…'
                                : vi
                                  ? 'Chấm lại theo câu đã sửa'
                                  : 'Recheck edited transcript'}
                            </span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Acoustic Pronunciation Scores */}
                    {quickResult.pronunciationStatus === 'SUCCESS' &&
                      (quickResult.overallScore != null || quickResult.pronunciation?.overall) ? (
                        <div>
                          <small style={{ display: 'block', marginBottom: 6, fontSize: 11, fontWeight: 750, color: 'var(--ah-accent)' }}>
                            {vi ? 'Điểm âm học Pronunciation Engine:' : 'Pronunciation Engine Acoustic Metrics:'}
                          </small>
                          <div className={hud.scoreGrid}>
                            {(
                              [
                                [vi ? 'Tổng thể' : 'Overall', quickResult.overallScore ?? quickResult.pronunciation?.overall?.overallScore],
                                [vi ? 'Âm vị' : 'Phonemes', quickResult.phonemeScore ?? quickResult.pronunciation?.overall?.segmentalScore],
                                [vi ? 'Trọng âm' : 'Stress', quickResult.stressScore ?? quickResult.pronunciation?.overall?.stressScore],
                                [vi ? 'Ngữ điệu' : 'Intonation', quickResult.pitchScore ?? quickResult.pronunciation?.overall?.intonationScore],
                                [vi ? 'Nhịp điệu' : 'Rhythm', quickResult.rhythmScore ?? quickResult.pronunciation?.overall?.rhythmScore],
                                [vi ? 'Trôi chảy' : 'Fluency', quickResult.fluencyScore ?? quickResult.pronunciation?.overall?.fluencyScore],
                              ] as const
                            ).map(([label, val]) => (
                              <div key={label} className={hud.scoreCell}>
                                <small>{label}</small>
                                <b className={hud.mono}>{val != null ? Math.round(val) : '—'}</b>
                              </div>
                            ))}
                          </div>

                          {quickResult.pronunciation?.priorities &&
                            quickResult.pronunciation.priorities.length > 0 && (
                              <div className={hud.cueBox} style={{ marginTop: 8 }}>
                                <small>{vi ? 'Ưu tiên chỉnh phát âm:' : 'Top pronunciation coaching cues:'}</small>
                                <ul className={hud.cueList}>
                                  {quickResult.pronunciation.priorities.slice(0, 2).map(p => (
                                    <li key={`${p.priorityRank}-${p.word}`}>
                                      <b>{p.word}:</b> {vi ? p.instructionVi : p.instructionEn}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                        </div>
                      ) : quickResult.pronunciationStatus === 'UNAVAILABLE' || quickResult.pronunciationError ? (
                        <div className={hud.cueBox}>
                          <small>{vi ? 'Phân tích phát âm tạm thời chưa khả dụng' : 'Pronunciation analysis unavailable'}</small>
                          <span style={{ fontSize: 12, color: 'var(--ah-soft)' }}>
                            {quickResult.pronunciationError ||
                              (vi
                                ? 'Chưa đủ tín hiệu âm học hoặc bộ chấm phát âm đang bận. Bạn có thể thu lại hoặc thử lại sau.'
                                : 'Pronunciation scoring was unavailable for this clip. Try recording again clearly.')}
                          </span>
                        </div>
                      ) : null}

                    {/* Structured Language and Naturalness Feedback */}
                    {quickResult.languageStatus === 'SUCCESS' && quickResult.languageFeedback ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <small style={{ fontSize: 11, fontWeight: 750, color: 'var(--ah-accent)' }}>
                          {vi ? 'Nhận xét ngữ pháp và độ tự nhiên:' : 'Grammar and natural phrasing feedback:'}
                        </small>
                        {quickResult.languageFeedback.corrections.length === 0 ? (
                          <div className={hud.correctionItem} style={{ color: 'var(--ah-emerald)', fontWeight: 700 }}>
                            <span>
                              {vi ? 'Câu diễn đạt tự nhiên và chuẩn ngữ pháp.' : 'Natural and grammatically accurate phrasing.'}
                              {quickResult.languageFeedback.positiveFeedback
                                ? ` — ${quickResult.languageFeedback.positiveFeedback}`
                                : ''}
                            </span>
                          </div>
                        ) : (
                          quickResult.languageFeedback.corrections.map((corr, idx) => (
                            <div key={idx} className={hud.correctionItem}>
                              <div>
                                <span style={{ color: 'var(--ah-coral)', textDecoration: 'line-through' }}>
                                  “{corr.original}”
                                </span>{' '}
                                → <b style={{ color: 'var(--ah-emerald)' }}>“{corr.suggestion}”</b>
                              </div>
                              {corr.explanationVi && (
                                <span style={{ color: 'var(--ah-soft)' }}>{corr.explanationVi}</span>
                              )}
                            </div>
                          ))
                        )}
                        {quickResult.languageFeedback.naturalVersion && (
                          <div className={hud.cueBox}>
                            <small>{vi ? 'Cách diễn đạt bản xứ gợi ý:' : 'Suggested natural phrasing:'}</small>
                            <strong lang="en" style={{ fontSize: 12.5 }}>
                              “{quickResult.languageFeedback.naturalVersion}”
                            </strong>
                          </div>
                        )}
                      </div>
                    ) : quickResult.languageStatus === 'UNAVAILABLE' || quickResult.languageError ? (
                      <div className={hud.cueBox}>
                        <small>{vi ? 'Phân tích ngữ pháp tạm thời chưa khả dụng' : 'Grammar check unavailable'}</small>
                        <span style={{ fontSize: 12, color: 'var(--ah-soft)' }}>
                          {quickResult.languageError ||
                            (vi
                              ? 'Chưa thể kiểm tra ngữ pháp và cách diễn đạt lúc này.'
                              : 'Language feedback is temporarily unavailable for this clip.')}
                        </span>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )}

            {(recError || aiError) && (
              <div className={hud.errorNotice} role="alert">
                <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 7 }}>
                  <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{aiError ?? recError}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setRecError(null);
                    setAiError(null);
                  }}
                  style={{ all: 'unset', cursor: 'pointer', fontWeight: 800, textDecoration: 'underline' }}
                >
                  {vi ? 'Đóng' : 'Dismiss'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Footer: Topic Switch + Multiplayer Room Host Sync ── */}
      <footer className={hud.stationFooter}>
        <button
          type="button"
          className={hud.btn}
          onClick={() => {
            setDrill(null);
            clearRecording();
            setTopicIdx(i => (i + 1) % station.topics.length);
          }}
        >
          <span>{vi ? 'Chủ đề khác tại trạm' : 'Another station topic'}</span>
        </button>

        {isHost && roomPhase && roomPhase !== 'FINISHED' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {onSetRoomTopic && (
              <button
                type="button"
                className={hud.btn}
                disabled={roomBusy}
                onClick={() => {
                  onSetRoomTopic(topic.headingEn, topic.promptIndex);
                  onClose();
                }}
              >
                <Flag size={13} />
                <span>{vi ? 'Đặt làm chủ đề phòng' : 'Set as room topic'}</span>
              </button>
            )}
            {canStartRoomRound && onStartRoomTurn && (
              <button
                type="button"
                className={hud.btnPrimary}
                data-testid="arena-board-round"
                disabled={roomBusy}
                onClick={() => {
                  onStartRoomTurn(topic.headingEn, topic.promptIndex);
                  onClose();
                }}
              >
                <Users size={14} />
                <span>{vi ? 'Bắt đầu lượt nói của phòng' : 'Start a room speaking turn'}</span>
              </button>
            )}
          </div>
        )}
      </footer>
    </section>
  );
}
