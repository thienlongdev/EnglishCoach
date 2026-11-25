'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PublicGroupDto, PublicItemDto } from '@/types/exams';
import { useAudioRecorder, formatTime } from '@/hooks/useAudioRecorder';
import {
  Mic,
  Square,
  Clock,
  CheckCircle2,
  AlertCircle,
  Play,
  RotateCcw,
  ArrowRight,
  Volume2,
  FileText,
  Image as ImageIcon,
} from 'lucide-react';

export interface ToeicSpeakingWorkspaceProps {
  attemptId: string;
  allSpeakingItems: Array<{
    item: PublicItemDto;
    group: PublicGroupDto;
    partOrdinal: number;
    globalIndex: number;
  }>;
  savedResponses?: Record<string, any>;
  onRecordingSaved: (placementId: string, recordingId: string) => void;
  onSectionCompleted?: () => void;
  lang?: 'en' | 'vi';
}

type Phase = 'PREPARING' | 'RECORDING' | 'REVIEWING' | 'COMPLETED';

export const ToeicSpeakingWorkspace: React.FC<ToeicSpeakingWorkspaceProps> = ({
  attemptId,
  allSpeakingItems = [],
  savedResponses = {},
  onRecordingSaved,
  onSectionCompleted,
  lang = 'vi',
}) => {
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const currentEntry = allSpeakingItems[currentIndex] || allSpeakingItems[0];
  const item = currentEntry?.item;
  const group = currentEntry?.group;
  const questionNumber = currentIndex + 1;

  // Determine standard timing per TOEIC question blueprint
  const getTimings = (qNum: number) => {
    if (qNum <= 2) return { prep: 45, response: 45, title: 'Read a Text Aloud', part: 'Part 1 (Questions 1–2)' };
    if (qNum <= 4) return { prep: 45, response: 30, title: 'Describe a Picture', part: 'Part 2 (Questions 3–4)' };
    if (qNum <= 6) return { prep: 3, response: 15, title: 'Respond to Questions', part: 'Part 3 (Questions 5–7)' };
    if (qNum === 7) return { prep: 3, response: 30, title: 'Respond to Questions', part: 'Part 3 (Questions 5–7)' };
    if (qNum <= 9) return { prep: 3, response: 15, title: 'Respond using Information Provided', part: 'Part 4 (Questions 8–10)' };
    if (qNum === 10) return { prep: 3, response: 30, title: 'Respond using Information Provided', part: 'Part 4 (Questions 8–10)' };
    return { prep: 45, response: 60, title: 'Express an Opinion', part: 'Part 5 (Question 11)' };
  };

  const timings = getTimings(questionNumber);

  const [phase, setPhase] = useState<Phase>('PREPARING');
  const [timeLeft, setTimeLeft] = useState<number>(timings.prep);

  // Audio Recorder Hook
  const {
    isRecording,
    duration,
    audioBlob,
    audioUrl,
    startRecording,
    stopRecordingAsync,
    playAudio,
    isPlaying,
    reset: resetRecorder,
  } = useAudioRecorder({
    maxDurationSeconds: timings.response,
    onMaxDurationReached: () => {
      handleStopRecording();
    },
  });

  // Initialize timers on question transition
  useEffect(() => {
    resetRecorder();
    const t = getTimings(currentIndex + 1);
    setPhase('PREPARING');
    setTimeLeft(t.prep);
  }, [currentIndex]);

  // Main countdown effect
  useEffect(() => {
    if (timeLeft <= 0) {
      if (phase === 'PREPARING') {
        // Auto-start recording when prep expires
        setPhase('RECORDING');
        setTimeLeft(timings.response);
        startRecording().catch((err) => console.error('Failed to start recording:', err));
      } else if (phase === 'RECORDING') {
        handleStopRecording();
      }
      return;
    }

    const timer = setInterval(() => {
      setTimeLeft((prev) => Math.max(0, prev - 1));
    }, 1000);

    return () => clearInterval(timer);
  }, [phase, timeLeft, timings.response]);

  const handleStartSpeakingNow = async () => {
    if (phase === 'PREPARING') {
      setPhase('RECORDING');
      setTimeLeft(timings.response);
      await startRecording();
    }
  };

  const handleStopRecording = async () => {
    if (phase === 'RECORDING') {
      setPhase('REVIEWING');
      const blob = await stopRecordingAsync();
      const placementId = item?.placementId || `SPK_Q${questionNumber}`;
      const mockRecordingId = `rec_${attemptId}_q${questionNumber}_${Date.now()}`;
      onRecordingSaved(placementId, mockRecordingId);
    }
  };

  const handleNextQuestion = () => {
    if (currentIndex < allSpeakingItems.length - 1) {
      setCurrentIndex((prev) => prev + 1);
    } else {
      setPhase('COMPLETED');
      if (onSectionCompleted) {
        onSectionCompleted();
      }
    }
  };

  // Image source detection for Q3 and Q4
  const getStimulusImage = () => {
    if (questionNumber === 3) return '/assets/toeic_spk_q03_office.svg';
    if (questionNumber === 4) return '/assets/toeic_spk_q04_market.svg';
    return null;
  };
  const stimulusImg = getStimulusImage();

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6 select-none">
      {/* 1. Header Banner */}
      <div className="bg-card border border-border rounded-2xl p-5 shadow-sm flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold px-2.5 py-1 rounded-md bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
              TOEIC SPEAKING
            </span>
            <span className="text-xs text-muted-foreground font-medium">
              {timings.part}
            </span>
          </div>
          <h2 className="text-xl font-extrabold text-foreground mt-1">
            {timings.title}
          </h2>
        </div>

        {/* Question Counter Pill */}
        <div className="flex items-center gap-1.5 bg-muted px-3.5 py-1.5 rounded-xl border border-border">
          <span className="text-xs text-muted-foreground font-medium">Câu hỏi:</span>
          <span className="text-sm font-bold text-foreground">
            {questionNumber} / {allSpeakingItems.length || 11}
          </span>
        </div>
      </div>

      {/* 2. Primary Workspace Card */}
      <div className="bg-card border border-border rounded-2xl p-6 sm:p-8 space-y-6 shadow-sm">
        {/* Phase Indicator & Dynamic Timer */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-border/60 pb-5">
          <div className="flex items-center gap-3">
            {phase === 'PREPARING' && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 text-xs font-bold animate-pulse">
                <Clock className="w-4 h-4" />
                <span>{lang === 'en' ? 'PREPARATION' : 'CHUẨN BỊ TRẢ LỜI'}</span>
              </div>
            )}
            {phase === 'RECORDING' && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 text-xs font-bold animate-pulse">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block animate-ping" />
                <span>{lang === 'en' ? 'RECORDING' : 'ĐANG GHI ÂM'}</span>
              </div>
            )}
            {phase === 'REVIEWING' && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 text-xs font-bold">
                <CheckCircle2 className="w-4 h-4" />
                <span>{lang === 'en' ? 'SAVED' : 'ĐÃ LƯU BÀI NÓI'}</span>
              </div>
            )}
          </div>

          {/* Large Countdown Clock */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">
              {phase === 'PREPARING' ? 'Thời gian chuẩn bị còn:' : 'Thời gian nói còn:'}
            </span>
            <span className="font-mono text-2xl font-extrabold text-foreground">
              {formatTime(timeLeft)}
            </span>
          </div>
        </div>

        {/* 3. Question Prompt / Stimulus Display */}
        <div className="space-y-4">
          {stimulusImg && (
            <div className="rounded-xl overflow-hidden border border-border bg-muted/20 flex items-center justify-center p-2 max-h-96">
              <img
                src={stimulusImg}
                alt={`Stimulus for Question ${questionNumber}`}
                className="max-h-80 w-auto object-contain rounded-lg shadow-sm"
              />
            </div>
          )}

          {/* Agenda Table for Questions 8-10 */}
          {questionNumber >= 8 && questionNumber <= 10 && (
            <div className="bg-muted/40 border border-border rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider">
                <FileText className="w-4 h-4" />
                <span>Annual Marketing Innovation Symposium — Schedule of Sessions</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-muted/80 text-muted-foreground border-b border-border">
                    <tr>
                      <th className="py-2 px-3">Time</th>
                      <th className="py-2 px-3">Session Title</th>
                      <th className="py-2 px-3">Presenter</th>
                      <th className="py-2 px-3">Room</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    <tr>
                      <td className="py-2 px-3 font-mono">09:00 - 10:30</td>
                      <td className="py-2 px-3 font-semibold">Keynote: AI in Global Consumer Trends</td>
                      <td className="py-2 px-3">Dr. Elena Rostova</td>
                      <td className="py-2 px-3">Grand Hall A</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-mono">11:00 - 12:30</td>
                      <td className="py-2 px-3 font-semibold">Workshop: Multi-Channel Customer Engagement</td>
                      <td className="py-2 px-3">David Chen</td>
                      <td className="py-2 px-3">Conference Room 2</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-mono">12:30 - 14:00</td>
                      <td className="py-2 px-3 font-semibold text-emerald-600 dark:text-emerald-400">Networking Luncheon (Provided for all attendees)</td>
                      <td className="py-2 px-3">Catering Pavilion</td>
                      <td className="py-2 px-3">Pavilion Terrace</td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-mono">17:30 - 19:00</td>
                      <td className="py-2 px-3 font-semibold">Evening Roundtable: Agile Brand Management</td>
                      <td className="py-2 px-3">Sarah Jenkins</td>
                      <td className="py-2 px-3">Executive Suite B</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Prompt Text Box */}
          <div className="bg-muted/20 border border-border/80 rounded-xl p-5">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              Đề bài (Prompt):
            </h4>
            <p className="text-base text-foreground font-medium leading-relaxed whitespace-pre-wrap">
              {item?.prompt || 'Please respond to the speaking prompt.'}
            </p>
          </div>
        </div>

        {/* 4. Controls & Recording Action Bar */}
        <div className="pt-4 border-t border-border/60 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {phase === 'PREPARING' && (
              <button
                onClick={handleStartSpeakingNow}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold shadow-sm transition-all cursor-pointer"
              >
                <Mic className="w-4 h-4" />
                <span>{lang === 'en' ? 'Start Speaking' : 'Bắt đầu nói ngay'}</span>
              </button>
            )}

            {phase === 'RECORDING' && (
              <button
                onClick={handleStopRecording}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-sm transition-all cursor-pointer animate-pulse"
              >
                <Square className="w-4 h-4" />
                <span>{lang === 'en' ? 'Done Recording' : 'Hoàn tất ghi âm'}</span>
              </button>
            )}

            {phase === 'REVIEWING' && audioUrl && (
              <button
                onClick={playAudio}
                disabled={isPlaying}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-secondary text-secondary-foreground text-xs font-bold hover:bg-secondary/80 transition-all cursor-pointer"
              >
                <Volume2 className="w-4 h-4" />
                <span>{isPlaying ? (lang === 'en' ? 'Playing...' : 'Đang phát...') : (lang === 'en' ? 'Listen back' : 'Nghe lại bài nói')}</span>
              </button>
            )}
          </div>

          {/* Next Question Navigation */}
          {phase === 'REVIEWING' && (
            <button
              onClick={handleNextQuestion}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90 shadow-sm transition-all cursor-pointer"
            >
              <span>{currentIndex < allSpeakingItems.length - 1 ? (lang === 'en' ? 'Next' : 'Câu tiếp theo') : (lang === 'en' ? 'Finish Speaking Section' : 'Hoàn thành phần thi Nói')}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
