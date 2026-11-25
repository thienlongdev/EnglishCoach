'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useAudioRecorder } from '@/hooks/useAudioRecorder';
import { EXAM_LABELS } from '@/lib/exams/labels';
import { Mic, CheckCircle2, AlertTriangle, Play, Square, ShieldCheck, GraduationCap, Infinity as InfinityIcon, Eye, Loader2, Lock, Clock } from 'lucide-react';

interface ExamPreflightProps {
  family: 'IELTS' | 'TOEIC';
  formTitle: string;
  hasSpeaking: boolean;
  onReady: () => void;
  lang?: 'en' | 'vi';
  /** Exams Phase 7: practice gets a light start card; simulation keeps the formal rules + agreement. */
  mode?: 'EXAM_SIMULATION' | 'PRACTICE';
  /** Practice scope label ("TOEIC Part 5 · Hoàn thành câu"). */
  scopeLabel?: string | null;
  /** Server-provided question count of the attempt (omitted when unknown). */
  questionCount?: number | null;
  /** Duration text from the server sections (simulation only; omitted when unknown). */
  durationText?: string | null;
  isStarting?: boolean;
}

export const ExamPreflight: React.FC<ExamPreflightProps> = ({
  family,
  formTitle,
  hasSpeaking,
  onReady,
  lang = 'vi',
  mode = 'EXAM_SIMULATION',
  scopeLabel,
  questionCount,
  durationText,
  isStarting = false,
}) => {
  const isPractice = mode === 'PRACTICE';
  const t = EXAM_LABELS[lang];

  // Device & Permission state
  const [micPermission, setMicPermission] = useState<'prompt' | 'granted' | 'denied'>('prompt');
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [volumeLevel, setVolumeLevel] = useState<number>(0);
  const [hasTestedAudio, setHasTestedAudio] = useState(false);
  const [skipAudioTest, setSkipAudioTest] = useState(false);
  const [agreedToRules, setAgreedToRules] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const {
    isRecording,
    isPlaying,
    startRecording,
    stopRecording,
    togglePlayback,
    audioUrl,
    duration,
  } = useAudioRecorder({
    maxDurationSeconds: 5,
    deviceId: selectedDeviceId || undefined,
    onMaxDurationReached: () => {
      setHasTestedAudio(true);
    },
  });

  // Query microphone devices and request permission
  const checkPermissions = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicPermission('granted');
      micStreamRef.current = stream;

      // Setup audio level meter
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioCtx;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateMeter = () => {
        if (analyserRef.current) {
          analyserRef.current.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((acc, val) => acc + val, 0) / dataArray.length;
          setVolumeLevel(Math.min(100, Math.round((average / 128) * 100)));
          animFrameRef.current = requestAnimationFrame(updateMeter);
        }
      };
      updateMeter();

      // Enumerate available input devices
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === 'audioinput');
      setAudioDevices(audioInputs);
      if (audioInputs.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(audioInputs[0].deviceId);
      }
    } catch (err) {
      console.warn('Microphone permission denied or unavailable:', err);
      setMicPermission('denied');
    }
  };

  useEffect(() => {
    if (hasSpeaking) {
      checkPermissions();
    }
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };
  }, [hasSpeaking]);

  const handleTestRecord = async () => {
    if (isRecording) {
      stopRecording();
      setHasTestedAudio(true);
    } else {
      await startRecording();
    }
  };

  const isReadyToProceed = isPractice
    ? !isStarting
    : (!hasSpeaking || (micPermission === 'granted' && hasTestedAudio) || skipAudioTest) && agreedToRules && !isStarting;

  const unlockAudioThenReady = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContextClass) {
        const ctx = new AudioContextClass();
        ctx.resume().catch(() => {});
      }
    } catch (e) {}
    onReady();
  };

  const vi = lang === 'vi';

  return (
    <div
      data-preflight-mode={mode}
      className={`max-w-2xl mx-auto bg-card border border-border rounded-2xl overflow-hidden border-t-4 ${isPractice ? 'border-t-emerald-500' : 'border-t-indigo-500'}`}
    >
      <div className="p-6 sm:p-8 space-y-6">
        <header className="space-y-2">
          <span
            className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-bold ${
              isPractice ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40' : 'bg-indigo-600 text-white'
            }`}
          >
            {isPractice ? <GraduationCap className="w-3.5 h-3.5" aria-hidden /> : <ShieldCheck className="w-3.5 h-3.5" aria-hidden />}
            {isPractice ? (scopeLabel ? (vi ? 'Luyện theo phần' : 'Practice by part') : vi ? 'Luyện tập' : 'Practice') : vi ? 'Thi đầy đủ' : 'Full simulation'}
            <span className="font-medium opacity-80">· {family}</span>
          </span>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">{scopeLabel || formTitle}</h1>
          {scopeLabel && <p className="text-sm text-muted-foreground">{formTitle}</p>}
        </header>

        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          {typeof questionCount === 'number' && questionCount > 0 && (
            <li className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2.5">
              <CheckCircle2 className="w-4 h-4 text-primary shrink-0" aria-hidden />
              {vi ? `${questionCount} câu hỏi` : `${questionCount} questions`}
            </li>
          )}
          {isPractice ? (
            <>
              <li className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2.5">
                <InfinityIcon className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden />
                {vi ? 'Không giới hạn thời gian' : 'No time limit'}
              </li>
              <li className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2.5">
                <Eye className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden />
                {vi ? 'Xem đáp án sau khi nộp bài' : 'Answers shown after you submit'}
              </li>
              <li className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2.5 sm:col-span-2">
                <Lock className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden />
                {vi ? 'Kết quả luyện tập không tính vào hồ sơ năng lực chính thức' : 'Practice results are not part of the official profile'}
              </li>
            </>
          ) : (
            durationText && (
              <li className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2.5">
                <Clock className="w-4 h-4 text-indigo-600 shrink-0" aria-hidden />
                {durationText}
              </li>
            )
          )}
        </ul>

        {/* Speaking readiness (simulation with Speaking only) */}
        {hasSpeaking && !isPractice && (
          <section className="p-4 sm:p-5 bg-muted/40 border border-border rounded-xl space-y-4" aria-label={t.speakingPreflightTitle}>
            <div className="flex items-center gap-2">
              <Mic className="w-5 h-5 text-primary" aria-hidden />
              <h2 className="text-base font-semibold text-foreground">{vi ? 'Kiểm tra micro' : 'Microphone check'}</h2>
            </div>
            {micPermission === 'denied' ? (
              <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive rounded-lg flex items-start gap-3" role="alert">
                <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" aria-hidden />
                <div>
                  <p className="font-semibold text-sm">{vi ? 'Chưa có quyền dùng micro' : 'Microphone access denied'}</p>
                  <p className="text-xs mt-1">
                    {vi ? 'Hãy cho phép trình duyệt dùng micro để làm phần Nói.' : 'Allow microphone access in your browser to take the speaking section.'}
                  </p>
                  <button type="button" onClick={checkPermissions} className="mt-2 h-9 px-3 text-xs font-semibold bg-destructive text-destructive-foreground rounded-lg">
                    {vi ? 'Thử lại' : 'Retry'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {audioDevices.length > 1 && (
                  <div>
                    <label htmlFor="preflight-mic-select" className="block text-xs font-medium text-muted-foreground mb-1">
                      {vi ? 'Chọn micro' : 'Microphone'}
                    </label>
                    <select
                      id="preflight-mic-select"
                      value={selectedDeviceId}
                      onChange={(e) => setSelectedDeviceId(e.target.value)}
                      className="w-full text-sm bg-background border border-input rounded-lg px-3 py-2 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {audioDevices.map((dev) => (
                        <option key={dev.deviceId} value={dev.deviceId}>
                          {dev.label || `Micro ${dev.deviceId.slice(0, 5)}…`}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>{vi ? 'Mức âm thanh vào' : 'Input level'}</span>
                    <span className="tabular-nums">{volumeLevel}%</span>
                  </div>
                  <div className="w-full bg-background border border-input rounded-full h-2.5 overflow-hidden" aria-hidden>
                    <div className="h-full bg-emerald-500" style={{ width: `${volumeLevel}%` }} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleTestRecord}
                    className={`inline-flex items-center gap-2 h-10 px-4 text-sm font-semibold rounded-lg ${
                      isRecording ? 'bg-rose-600 text-white' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                    }`}
                  >
                    {isRecording ? (
                      <>
                        <Square className="w-4 h-4" aria-hidden />
                        {vi ? `Dừng ghi (${duration}s / 5s)` : `Stop (${duration}s / 5s)`}
                      </>
                    ) : (
                      <>
                        <Mic className="w-4 h-4" aria-hidden />
                        {vi ? 'Ghi thử 5 giây' : 'Record a 5-second sample'}
                      </>
                    )}
                  </button>
                  {audioUrl && (
                    <button type="button" onClick={togglePlayback} className="inline-flex items-center gap-2 h-10 px-4 text-sm font-semibold bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-lg">
                      {isPlaying ? <Square className="w-4 h-4" aria-hidden /> : <Play className="w-4 h-4" aria-hidden />}
                      {vi ? 'Nghe lại' : 'Play back'}
                    </button>
                  )}
                  {hasTestedAudio ? (
                    <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                      <CheckCircle2 className="w-4 h-4" aria-hidden />
                      {vi ? 'Micro hoạt động' : 'Microphone ready'}
                    </span>
                  ) : (
                    <button
                      type="button"
                      id="preflight-skip-audio-btn"
                      onClick={() => setSkipAudioTest(true)}
                      aria-pressed={skipAudioTest}
                      className={`text-xs px-2 py-1 rounded ${skipAudioTest ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-muted-foreground hover:text-foreground underline'}`}
                    >
                      {skipAudioTest ? (vi ? 'Đã bỏ qua kiểm tra micro' : 'Microphone check skipped') : vi ? 'Bỏ qua kiểm tra micro' : 'Skip microphone check'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {!isPractice && (
          <section className="space-y-3" aria-label={vi ? 'Quy chế làm bài' : 'Test rules'}>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-indigo-600" aria-hidden />
              {vi ? 'Quy chế làm bài' : 'Test rules'}
            </h3>
            <ul className="text-sm text-muted-foreground space-y-1.5 list-disc pl-5">
              <li>{vi ? 'Đồng hồ do máy chủ quản lý; tải lại trang hoặc rời đi không làm dừng thời gian.' : 'The server keeps time; reloading or leaving does not pause the clock.'}</li>
              <li>{vi ? 'Trong lúc thi không có gợi ý, tra từ hay trợ lý AI.' : 'No hints, dictionary or AI assistance during the test.'}</li>
              <li>{vi ? 'Câu trả lời được tự động lưu lên máy chủ.' : 'Answers are saved to the server automatically.'}</li>
              <li>{vi ? 'Sau khi nộp bài, câu trả lời không thể thay đổi.' : 'Answers cannot be changed after you submit.'}</li>
            </ul>
            <label className="flex items-start gap-3 p-3 bg-muted/30 border border-border rounded-xl cursor-pointer hover:bg-muted/50">
              <input
                id="preflight-agree-rules-checkbox"
                type="checkbox"
                checked={agreedToRules}
                onChange={(e) => setAgreedToRules(e.target.checked)}
                className="mt-0.5 rounded border-input text-primary focus:ring-primary h-4 w-4"
              />
              <span className="text-sm text-foreground">
                {vi ? 'Tôi đã sẵn sàng và đồng ý làm bài theo điều kiện thi.' : 'I am ready and agree to take this test under exam conditions.'}
              </span>
            </label>
          </section>
        )}
      </div>

      <div className="px-6 sm:px-8 py-4 border-t border-border bg-muted/20 flex justify-end">
        <button
          type="button"
          id="preflight-ready-button"
          onClick={unlockAudioThenReady}
          disabled={!isReadyToProceed}
          aria-busy={isStarting}
          className={`inline-flex items-center gap-2 h-11 px-6 text-sm font-bold rounded-xl text-white disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            isPractice ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-indigo-600 hover:bg-indigo-500'
          }`}
        >
          {isStarting ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Play className="w-4 h-4 fill-current" aria-hidden />}
          {isStarting
            ? vi ? 'Đang bắt đầu…' : 'Starting…'
            : isPractice
            ? vi ? 'Bắt đầu luyện' : 'Start practice'
            : hasSpeaking
            ? vi ? 'Bắt đầu bài thi' : 'Start the test'
            : vi ? 'Bắt đầu bài thi' : 'Start the test'}
        </button>
      </div>
    </div>
  );
};
