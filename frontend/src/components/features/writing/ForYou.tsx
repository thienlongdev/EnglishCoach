'use client';

import React, { useEffect, useState, useRef } from 'react';
import {
  ForYouDashboard,
  WritingProfile,
  WritingSourceContext,
  WritingSourceType,
  WeeklyWritingReport,
  AdaptiveTaskResponse,
  SentenceCheckResult,
  SentenceLabSubView
} from '@/types/writing';
import { writingApi } from '@/services/writingApi';
import { formatPatternCode, getCategoryLabel, getPatternDisplayTitle, getStageLabel } from '@/lib/writing/labels';
import { echoSrc } from '@/lib/brand/echoCharacters';

interface ForYouProps {
  onNavigateToCoach: (sessionId?: string, taskId?: string) => void;
  onNavigateToSentenceLab: (subView?: SentenceLabSubView, targetPatternCode?: string) => void;
}

export const ForYou: React.FC<ForYouProps> = ({
  onNavigateToCoach,
  onNavigateToSentenceLab
}) => {
  const [dashboard, setDashboard] = useState<ForYouDashboard | null>(null);
  const [profile, setProfile] = useState<WritingProfile | null>(null);
  const [sources, setSources] = useState<WritingSourceContext[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Weekly report state
  const [showWeeklyReport, setShowWeeklyReport] = useState<boolean>(false);
  const [weeklyReport, setWeeklyReport] = useState<WeeklyWritingReport | null>(null);
  const [loadingWeekly, setLoadingWeekly] = useState<boolean>(false);

  // Adaptive task generation state
  const [generatingAdaptive, setGeneratingAdaptive] = useState<boolean>(false);
  const [adaptivePreview, setAdaptivePreview] = useState<AdaptiveTaskResponse | null>(null);

  // Source session creation state
  const [creatingFromSource, setCreatingFromSource] = useState<string | null>(null);

  // Quick Single-Sentence Inspection Sandbox
  const [quickSentence, setQuickSentence] = useState<string>('');
  const [evaluatingSentence, setEvaluatingSentence] = useState<boolean>(false);
  const [sentenceResult, setSentenceResult] = useState<SentenceCheckResult | null>(null);
  const [sentenceError, setSentenceError] = useState<string | null>(null);
  const quickSentenceInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let isMounted = true;
    async function loadData() {
      try {
        const [dashData, profData, sourceList] = await Promise.all([
          writingApi.getForYou().catch(() => null),
          writingApi.getProfile().catch(() => null),
          writingApi.getAvailableSources().catch(() => [])
        ]);

        if (!isMounted) return;
        if (dashData) setDashboard(dashData);
        if (profData) setProfile(profData);
        if (sourceList) setSources(sourceList);
      } finally {
        if (isMounted) setLoading(false);
      }
    }
    loadData();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleOpenWeeklyReport = async () => {
    setShowWeeklyReport(true);
    if (!weeklyReport) {
      setLoadingWeekly(true);
      try {
        const rep = await writingApi.getWeeklyReport();
        setWeeklyReport(rep);
      } catch (err) {
        console.error('Failed to load weekly report', err);
      } finally {
        setLoadingWeekly(false);
      }
    }
  };

  const handleGenerateAdaptive = async () => {
    setGeneratingAdaptive(true);
    try {
      const topPattern = dashboard?.activeFocusPatterns?.[0]?.patternCode;
      const resp = await writingApi.generateAdaptiveTask({
        cefrLevel: profile?.cefrLevel || 'B1',
        category: 'Work',
        register: profile?.preferredRegister || 'formal',
        focusPatternCodes: topPattern ? [topPattern] : []
      });
      setAdaptivePreview(resp);
    } catch (err) {
      console.error('Failed to generate adaptive task', err);
    } finally {
      setGeneratingAdaptive(false);
    }
  };

  const handleStartAdaptiveSession = async () => {
    if (!adaptivePreview) return;
    try {
      const sess = await writingApi.createSession(adaptivePreview.title);
      setAdaptivePreview(null);
      onNavigateToCoach(sess.id);
    } catch (err) {
      console.error('Failed to start session from adaptive task', err);
    }
  };

  const handleStartFromSource = async (source: WritingSourceContext) => {
    setCreatingFromSource(source.sourceId);
    try {
      const sess = await writingApi.createSessionFromSource(source.sourceType, source.sourceId);
      onNavigateToCoach(sess.id);
    } catch (err) {
      console.error('Failed to create session from source', err);
    } finally {
      setCreatingFromSource(null);
    }
  };

  const handleQuickSentenceEvaluate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = quickSentence.trim();
    if (!trimmed || trimmed.length < 4) return;

    setEvaluatingSentence(true);
    setSentenceError(null);
    setSentenceResult(null);
    try {
      const res = await writingApi.submitSentenceCheck(trimmed, profile?.preferredRegister || 'formal');
      setSentenceResult(res);
    } catch (err: any) {
      console.error('Failed to check sentence', err);
      setSentenceError('Check currently unavailable. Try full Sentence Lab.');
    } finally {
      setEvaluatingSentence(false);
    }
  };

  function formatRelativeTime(iso?: string): string {
    if (!iso) return '';
    try {
      const diffMs = Date.now() - new Date(iso).getTime();
      const diffMinutes = Math.floor(diffMs / 60000);
      if (diffMinutes < 1) return 'vừa xong';
      if (diffMinutes < 60) return `${diffMinutes} phút trước`;
      const diffHours = Math.floor(diffMinutes / 60);
      if (diffHours < 24) return `${diffHours} giờ trước`;
      const diffDays = Math.floor(diffHours / 24);
      if (diffDays < 7) return `${diffDays} ngày trước`;
      return new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
    } catch {
      return '';
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse max-w-[88rem] mx-auto w-full">
        <div className="h-28 bg-surface-container rounded-3xl" />
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 h-96 bg-surface-container rounded-3xl" />
          <div className="lg:col-span-4 h-96 bg-surface-container rounded-3xl" />
        </div>
      </div>
    );
  }

  const continueSession = dashboard?.continueSession;
  const recommendedPractice = dashboard?.recommendedDuePractice;
  const focusPatterns = dashboard?.activeFocusPatterns || [];
  const weeklyCount = Number(dashboard?.weeklyEvidenceCount) || 0;
  const canonicalUserLevel = profile?.cefrLevel?.trim() || null;
  const weeklyWordsWritten = Number(dashboard?.weeklyWordsWritten) || 0;
  const weeklyTargetWords = Number(dashboard?.weeklyTargetWords) || 1500;
  const daysCompleted = Number(dashboard?.daysCompletedThisWeek) || 0;

  // Real grammar robustness: weighted mean of active error pattern masteries
  const grammarPatterns = focusPatterns.filter(
    (p) => !p.category || p.category.toLowerCase() === 'grammar' || p.category.toLowerCase() === 'syntax' || p.category.toLowerCase() === 'capitalization' || p.category.toLowerCase() === 'spelling'
  );
  const totalOccurrences = grammarPatterns.reduce((sum, p) => sum + (p.occurrenceCount || 1), 0);
  const avgMastery = grammarPatterns.length > 0 && totalOccurrences > 0
    ? Math.round(grammarPatterns.reduce((sum, p) => sum + ((p.estimatedMastery != null ? p.estimatedMastery : 50) * (p.occurrenceCount || 1)), 0) / totalOccurrences)
    : (focusPatterns.length > 0
        ? Math.round(focusPatterns.reduce((sum, p) => sum + (p.estimatedMastery || 0), 0) / focusPatterns.length)
        : null);

  // Real Weekly Rhythm from authentic backend dailyWordCounts (zero activity = 0%)
  const dailyCounts = dashboard?.dailyWordCounts || [];
  const maxDayWord = Math.max(100, ...dailyCounts.map((d) => d.wordCount));
  const rhythmItems = dailyCounts.length === 7 ? dailyCounts.map((item) => {
    const pct = item.wordCount > 0 ? Math.min(100, Math.max(12, Math.round((item.wordCount / maxDayWord) * 100))) : 0;
    const height = item.wordCount > 0 ? `${pct}%` : '0%';
    const label = `${item.dayName}${item.isToday ? ' (Hôm nay)' : ''}: ${item.wordCount > 0 ? `${item.wordCount} từ` : 'Chưa có lượt viết'}`;
    return {
      day: item.dayCode,
      height,
      active: item.isToday,
      label,
      wordCount: item.wordCount,
    };
  }) : [
    { day: 'T2', height: '0%', active: false, label: 'Thứ 2: Chưa có lượt viết', wordCount: 0 },
    { day: 'T3', height: '0%', active: false, label: 'Thứ 3: Chưa có lượt viết', wordCount: 0 },
    { day: 'T4', height: '0%', active: false, label: 'Thứ 4: Chưa có lượt viết', wordCount: 0 },
    { day: 'T5', height: '0%', active: false, label: 'Thứ 5: Chưa có lượt viết', wordCount: 0 },
    { day: 'T6', height: '0%', active: false, label: 'Thứ 6: Chưa có lượt viết', wordCount: 0 },
    { day: 'T7', height: '0%', active: false, label: 'Thứ 7: Chưa có lượt viết', wordCount: 0 },
    { day: 'CN', height: '0%', active: false, label: 'Chủ nhật: Chưa có lượt viết', wordCount: 0 },
  ];

  return (
    <div className="flex flex-col w-full">
      <div className="max-w-[88rem] mx-auto w-full flex flex-col gap-space-xl">
        {/* Top Atelier Welcome Greeting - Radiant Scholarly Amber / Royal Indigo Banner */}
        <section className="relative overflow-hidden rounded-2xl sm:rounded-3xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 border border-amber-500/25 p-6 sm:p-8 text-white shadow-xl shadow-indigo-950/20 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="absolute -right-16 -top-24 w-96 h-96 rounded-full bg-amber-500/10 blur-3xl pointer-events-none" />
          <div className="absolute left-1/4 -bottom-24 w-80 h-80 rounded-full bg-indigo-500/15 blur-2xl pointer-events-none" />

          <div className="relative z-10 flex flex-col gap-2.5 max-w-2xl">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/15 border border-amber-400/30 text-amber-300 text-xs font-bold uppercase tracking-wider backdrop-blur-md shadow-xs">
                <img src={echoSrc('scholar', 24)} alt="Echo" className="w-3.5 h-3.5 object-contain drop-shadow-[0_0_6px_rgba(245,158,11,0.6)]" />
                <span>Không gian viết cá nhân</span>
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white drop-shadow-sm">
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-200 via-amber-100 to-white">
                Echo sẵn sàng rồi, luyện viết thôi nào!
              </span>
            </h1>
          </div>

          {/* Compact Top Action Row */}
          <div className="relative z-10 flex items-center gap-3 self-start md:self-center shrink-0 flex-wrap">
            {/* Weekly Report CTA */}
            <button
              onClick={handleOpenWeeklyReport}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white transition-all shadow-sm cursor-pointer text-xs font-bold backdrop-blur-md"
              type="button"
            >
              <span className="material-symbols-outlined text-amber-300 text-[18px]">analytics</span>
              <span>Báo cáo tuần</span>
            </button>

            {/* Adaptive AI Challenge CTA */}
            <button
              onClick={handleGenerateAdaptive}
              disabled={generatingAdaptive}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-bold text-xs shadow-lg shadow-amber-950/40 border border-amber-400/40 active:translate-y-0.5 transition-all disabled:opacity-60 cursor-pointer"
              type="button"
            >
              {generatingAdaptive ? (
                <span className="material-symbols-outlined text-[18px] animate-spin">sync</span>
              ) : (
                <img src={echoSrc('scholar', 24)} alt="Echo" width={18} height={18} className="w-[18px] h-[18px] object-contain shrink-0 select-none pointer-events-none drop-shadow-[0_0_6px_rgba(0,0,0,0.4)]" />
              )}
              <span>{generatingAdaptive ? 'Đang tạo...' : 'Thử thách thích ứng'}</span>
            </button>
          </div>
        </section>

        {/* Adaptive Task Preview Modal / Card */}
        {adaptivePreview && (
          <div className="p-space-xl rounded-[28px] bg-primary-fixed/30 border border-primary/20 space-y-4 animate-in fade-in slide-in-from-top-4 duration-200">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-2xl bg-primary text-on-primary flex items-center justify-center shadow-sm">
                  <img src={echoSrc('scholar', 24)} alt="Echo" width={22} height={22} className="w-[22px] h-[22px] object-contain shrink-0 select-none pointer-events-none" />
                </div>
                <div>
                  <span className="font-label-stamp text-label-stamp uppercase tracking-wider text-primary font-bold">
                    Thử thách thích ứng AI
                  </span>
                  <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                    {adaptivePreview.title}
                  </h3>
                </div>
              </div>
              <button
                onClick={() => setAdaptivePreview(null)}
                className="text-on-surface-variant hover:text-on-surface p-1"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            <p className="font-body-md text-body-md text-on-surface leading-relaxed">
              {adaptivePreview.prompt}
            </p>

            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
              <span className="font-label-stamp text-label-stamp px-2.5 py-1 rounded-lg bg-surface-container text-on-surface font-semibold">
                Đối tượng: {adaptivePreview.audience}
              </span>
              <span className="font-label-stamp text-label-stamp px-2.5 py-1 rounded-lg bg-surface-container text-on-surface font-semibold">
                Mục tiêu: {adaptivePreview.target_word_count_min}–{adaptivePreview.target_word_count_max} từ
              </span>
              {adaptivePreview.elicited_patterns?.length > 0 && (
                <span className="font-label-stamp text-label-stamp px-2.5 py-1 rounded-lg bg-secondary/10 text-secondary font-bold">
                  Trọng tâm: {adaptivePreview.elicited_patterns.map((p) => getPatternDisplayTitle(undefined, p)).join(', ')}
                </span>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setAdaptivePreview(null)}
                className="px-4 py-2 text-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container/60 rounded-xl font-semibold cursor-pointer transition-colors"
              >
                Bỏ qua
              </button>
              <button
                onClick={handleStartAdaptiveSession}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white dark:text-on-primary font-semibold text-sm shadow-sm hover:opacity-95 active:translate-y-0.5 cursor-pointer transition-all min-h-[40px]"
              >
                <span>Chấp nhận thử thách và Bắt đầu viết</span>
                <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
              </button>
            </div>
          </div>
        )}

        {/* MAIN TWO-COLUMN DESK: Dominant Hero Canvas + Intelligence & Trajectory Rail */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl items-start">
          {/* LEFT 8 COLS: Dominant Learning Canvas (Physical Desk Cardstock) */}
          <section className="lg:col-span-8 flex flex-col gap-space-lg">
            {/* The Focal "Today's Writing" Paper Cardstock */}
            <div className="relative bg-surface-container-lowest rounded-[28px] p-6 sm:p-8 lg:p-9 shadow-[0_16px_40px_-12px_rgba(44,39,32,0.08),0_2px_6px_0_rgba(44,39,32,0.04)] border border-surface-container-high/70 overflow-hidden">
              {/* Tactile Binding Rule (Left margin red/ochre draft paper line) */}
              <div className="absolute left-8 lg:left-12 top-0 bottom-0 w-[1.5px] bg-rose-400/25 pointer-events-none" />

              {continueSession ? (
                /* REAL ACTIVE DRAFT STATE */
                <>
                  {/* Header Ribbon within the Manuscript */}
                  <div className="relative z-10 pl-6 lg:pl-10 flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-surface-container/70 mb-5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-label-stamp text-label-stamp px-2.5 py-1 rounded-full bg-secondary-fixed text-on-secondary-fixed font-bold tracking-wider uppercase">
                        Bản nháp đang viết
                      </span>
                      <span className="font-label-stamp text-label-stamp px-2.5 py-1 rounded-full bg-surface-container text-on-surface font-semibold">
                        {getStageLabel(continueSession.stage).title}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-on-surface-variant text-body-sm font-medium">
                      <span className="material-symbols-outlined text-[16px] text-tertiary">schedule</span>
                      <span>{continueSession.updatedAt ? `Cập nhật ${formatRelativeTime(continueSession.updatedAt)}` : 'Tự động lưu'}</span>
                    </div>
                  </div>

                  {/* Manuscript Content Container */}
                  <div className="relative z-10 pl-6 lg:pl-10 flex flex-col gap-5">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-1.5 text-on-surface-variant font-label-stamp text-label-stamp uppercase tracking-widest font-semibold">
                        <span className="material-symbols-outlined text-[16px] text-primary">draw</span>
                        <span>Tiêu đề bài viết</span>
                      </div>
                      <h2 className="text-xl sm:text-2xl font-bold text-on-surface tracking-tight leading-snug">
                        {continueSession.taskSnapshot?.title || 'Bài viết chưa đặt tên'}
                      </h2>
                      <div className="flex items-center gap-3 text-body-sm text-on-surface-variant font-medium pt-0.5">
                        <span className="flex items-center gap-1">
                          <span className="material-symbols-outlined text-[16px] text-primary">edit_note</span>
                          <span>
                            {continueSession.workingText?.trim()
                              ? `${continueSession.workingText.trim().split(/\s+/).filter(Boolean).length} từ đã viết`
                              : 'Chưa có nội dung văn bản'}
                          </span>
                        </span>
                      </div>
                    </div>

                    {/* Excerpt Preview Box */}
                    <div className="p-4 sm:p-5 rounded-2xl bg-surface-container-low/80 border border-surface-container-high/60 text-on-surface">
                      <p className="font-body-md text-body-md text-on-surface leading-relaxed italic line-clamp-3">
                        {continueSession.workingText?.trim()
                          ? `“${continueSession.workingText.trim()}”`
                          : (continueSession.taskSnapshot?.prompt
                              ? `“${continueSession.taskSnapshot.prompt}”`
                              : 'Bản nháp đang mở. Bấm tiếp tục để bắt đầu viết nội dung bài.')}
                      </p>
                    </div>

                    {/* Action & Streak Horizon */}
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-space-md pt-2">
                      <button
                        onClick={() => onNavigateToCoach(continueSession.id)}
                        className="w-full sm:w-auto inline-flex items-center justify-center gap-space-sm px-7 py-3.5 min-h-[44px] rounded-2xl bg-primary text-white dark:text-on-primary font-headline-sm font-semibold shadow-[0_4px_16px_rgba(42,20,180,0.25)] hover:opacity-95 active:translate-y-0.5 transition-all cursor-pointer"
                        type="button"
                      >
                        <span>Tiếp tục bản nháp</span>
                        <span className="material-symbols-outlined text-[20px]">arrow_forward</span>
                      </button>

                      {/* Streak Horizon Meter */}
                      <div className="flex items-center gap-4 bg-surface-container-low px-5 py-3 rounded-2xl w-full sm:w-auto justify-between sm:justify-start border border-surface-container-high/60">
                        <div className="flex flex-col">
                          <span className="font-label-stamp text-label-stamp text-on-surface-variant uppercase">
                            Mục tiêu tuần
                          </span>
                          <span className="font-body-md text-body-md font-semibold text-on-surface">
                            Ngày {daysCompleted}/5 ngày đã hoàn thành
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 ml-space-xs">
                          {[1, 2, 3, 4, 5].map((day) => (
                            <span
                              key={day}
                              className={`w-3 h-7 rounded-full shadow-2xs ${
                                day <= daysCompleted
                                  ? 'bg-secondary'
                                  : 'bg-surface-container-high'
                              }`}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                /* REAL ACTIVE-DRAFT EMPTY STATE */
                <>
                  {/* Header Ribbon within the Manuscript */}
                  <div className="relative z-10 pl-6 lg:pl-10 flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-surface-container/70 mb-5">
                    <div className="flex items-center gap-2">
                      <span className="font-label-stamp text-label-stamp px-2.5 py-1 rounded-full bg-surface-container text-on-surface font-bold tracking-wider uppercase">
                        Không gian viết
                      </span>
                      <span className="font-label-stamp text-label-stamp text-on-surface-variant font-medium">
                        Sẵn sàng phiên mới
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-on-surface-variant text-body-sm font-medium">
                      <span className="material-symbols-outlined text-[16px] text-tertiary">timer</span>
                      <span>Tự động lưu bản nháp</span>
                    </div>
                  </div>

                  {/* Content Container */}
                  <div className="relative z-10 pl-6 lg:pl-10 flex flex-col gap-5">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-1.5 text-on-surface-variant font-label-stamp text-label-stamp uppercase tracking-widest font-semibold">
                        <span className="material-symbols-outlined text-[16px] text-primary">draw</span>
                        <span>Bắt đầu bài viết mới</span>
                      </div>
                      <h2 className="text-xl sm:text-2xl font-bold text-on-surface tracking-tight leading-snug">
                        Bạn chưa có bản nháp đang viết
                      </h2>
                      <p className="font-body-md text-body-md text-on-surface-variant leading-relaxed max-w-2xl">
                        Chọn một đề bài từ danh mục Writing Coach để rèn luyện cấu trúc bài, nhận phản hồi ngữ pháp và phát triển luận điểm cùng gia sư AI.
                      </p>
                    </div>

                    {/* Action & Streak Horizon */}
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-space-md pt-2">
                      <button
                        onClick={() => onNavigateToCoach()}
                        className="w-full sm:w-auto inline-flex items-center justify-center gap-space-sm px-7 py-3.5 min-h-[44px] rounded-2xl bg-primary text-white dark:text-on-primary font-headline-sm font-semibold shadow-[0_4px_16px_rgba(42,20,180,0.25)] hover:opacity-95 active:translate-y-0.5 transition-all cursor-pointer"
                        type="button"
                      >
                        <span>Chọn đề để luyện viết</span>
                        <span className="material-symbols-outlined text-[20px]">arrow_forward</span>
                      </button>

                      {/* Streak Horizon Meter */}
                      <div className="flex items-center gap-4 bg-surface-container-low px-5 py-3 rounded-2xl w-full sm:w-auto justify-between sm:justify-start border border-surface-container-high/60">
                        <div className="flex flex-col">
                          <span className="font-label-stamp text-label-stamp text-on-surface-variant uppercase">
                            Mục tiêu tuần
                          </span>
                          <span className="font-body-md text-body-md font-semibold text-on-surface">
                            Ngày {daysCompleted}/5 ngày đã hoàn thành
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 ml-space-xs">
                          {[1, 2, 3, 4, 5].map((day) => (
                            <span
                              key={day}
                              className={`w-3 h-7 rounded-full shadow-2xs ${
                                day <= daysCompleted
                                  ? 'bg-secondary'
                                  : 'bg-surface-container-high'
                              }`}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Subtle bottom decorative note stamp */}
              <div className="absolute -bottom-6 -right-6 w-32 h-32 rounded-full bg-primary/5 pointer-events-none blur-2xl" />
            </div>

            {/* Actionable Next Pathways Ribbon */}
            <div className="flex flex-col gap-space-md pt-space-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-space-sm">
                  <span className="w-2 h-5 rounded-full bg-secondary" />
                  <h2 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                    Gợi ý tiếp theo
                  </h2>
                  <span className="font-label-stamp text-label-stamp uppercase px-2 py-0.5 rounded bg-surface-container font-semibold text-on-surface-variant">
                    Hàng đợi đề xuất
                  </span>
                </div>
                <button
                  onClick={() => onNavigateToCoach()}
                  className="font-label-md text-label-md text-primary hover:underline font-semibold flex items-center gap-1 cursor-pointer"
                >
                  <span>Xem toàn bộ đề bài</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_right_alt</span>
                </button>
              </div>

              {/* 3-Card Responsive Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-stretch">
                {/* Action 1: Explore Writing Coach Catalog (Non-duplicate, real action) */}
                <div
                  onClick={() => onNavigateToCoach()}
                  className="bg-surface-container-lowest rounded-3xl p-5 shadow-xs border border-surface-container-high/60 flex flex-col justify-between hover:shadow-md transition-all group cursor-pointer min-h-[300px]"
                >
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-label-stamp text-label-stamp px-2 py-0.5 rounded bg-surface-container text-on-surface-variant font-bold tracking-wider uppercase shrink-0">
                        DANH MỤC ĐỀ BÀI
                      </span>
                      <span className="material-symbols-outlined text-primary text-[18px]">menu_book</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <h3 className="font-headline-sm text-sm font-semibold text-on-surface group-hover:text-primary transition-colors leading-snug">
                        Khám phá đề bài mới
                      </h3>
                      <p className="font-body-sm text-xs text-on-surface-variant leading-relaxed">
                        Luyện viết theo cấu trúc chuẩn với đa dạng chủ đề: IELTS Task 1, Task 2, Academic Writing và viết tự do.
                      </p>
                    </div>
                    <div className="rounded-xl bg-surface-container-low p-2.5 flex items-center gap-2 border border-surface-container-high/40">
                      <span className="material-symbols-outlined text-[16px] text-secondary">verified</span>
                      <span className="font-label-stamp text-[11px] text-on-surface font-medium">
                        Hướng dẫn lập dàn ý và phản hồi từng bước
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-3 mt-2 border-t border-surface-container/60">
                    <span className="font-body-sm text-xs font-semibold text-primary group-hover:underline flex items-center gap-1">
                      <span>Chọn đề viết</span>
                      <span className="material-symbols-outlined text-[15px]">arrow_forward</span>
                    </span>
                    <span className="w-7 h-7 rounded-full bg-surface-container flex items-center justify-center text-on-surface group-hover:bg-primary group-hover:text-on-primary transition-colors">
                      <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                    </span>
                  </div>
                </div>

                {/* Action 2: Targeted Weakness Drill */}
                <div className="bg-surface-container-lowest rounded-3xl p-5 shadow-xs border border-surface-container-high/60 flex flex-col justify-between hover:shadow-md transition-all group min-h-[300px]">
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-label-stamp text-label-stamp px-2 py-0.5 rounded bg-secondary-fixed text-on-secondary-fixed font-bold tracking-wider uppercase shrink-0">
                        {dashboard?.isCurriculumRecommendation ? 'GỢI Ý LỘ TRÌNH' : 'TRỌNG TÂM RÈN LUYỆN'}
                      </span>
                      <span className="font-body-sm text-xs text-secondary font-bold flex items-center gap-0.5 shrink-0">
                        <span className="material-symbols-outlined text-[15px]">bolt</span> 2 phút
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <h3 className="font-headline-sm text-sm font-semibold text-on-surface leading-snug">
                        {getPatternDisplayTitle(
                          recommendedPractice?.patternTitle,
                          recommendedPractice?.patternCode || focusPatterns[0]?.patternCode
                        )}
                      </h3>
                      <p className="font-body-sm text-xs text-on-surface-variant leading-relaxed">
                        {recommendedPractice?.dueReason || 'Bài tập thực hành rèn luyện cấu trúc ngữ pháp và từ vựng chuẩn CEFR.'}
                      </p>
                    </div>
                    <div className="rounded-xl bg-surface-container-low p-2.5 flex flex-col gap-1 border border-surface-container-high/40">
                      <div className="font-label-stamp text-[9px] text-primary uppercase font-bold tracking-wider">
                        {dashboard?.isCurriculumRecommendation ? 'Mục tiêu luyện tập:' : 'Lỗi cần chú ý:'}
                      </div>
                      <div className="font-body-sm text-xs text-on-surface font-medium">
                        {recommendedPractice?.dueReason || 'Hoàn thành bài tập để củng cố phản xạ dùng câu chuẩn xác.'}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() =>
                      onNavigateToSentenceLab(
                        'mistakes',
                        recommendedPractice?.patternCode || focusPatterns[0]?.patternCode
                      )
                    }
                    className="mt-3 w-full py-2 px-3 min-h-[36px] rounded-xl bg-primary text-white dark:text-on-primary font-body-sm text-xs font-bold hover:opacity-95 transition-all flex items-center justify-center gap-1 cursor-pointer shadow-xs"
                    type="button"
                  >
                    <span>Luyện tập bài tập này</span>
                    <span className="material-symbols-outlined text-[15px]">play_arrow</span>
                  </button>
                </div>

                {/* Action 3: Quick Sandbox Tool "Test Single Sentence" */}
                <div className="bg-surface-container-lowest rounded-3xl p-5 shadow-xs border border-surface-container-high/60 flex flex-col justify-between hover:shadow-md transition-all min-h-[300px]">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="font-label-stamp text-label-stamp px-2 py-0.5 rounded bg-primary/10 text-primary font-bold tracking-wider uppercase">
                        KIỂM TRA NHANH
                      </span>
                      <span className="material-symbols-outlined text-primary text-[16px]">terminal</span>
                    </div>
                    <h3 className="font-headline-sm text-sm font-semibold text-on-surface">
                      Kiểm tra một câu
                    </h3>
                    <p className="font-body-sm text-xs text-on-surface-variant leading-relaxed">
                      Dán câu tiếng Anh bất kỳ để đánh giá cú pháp, ngữ pháp và độ tự nhiên.
                    </p>

                    <form onSubmit={handleQuickSentenceEvaluate} className="flex flex-col gap-1.5 mt-1">
                      <div className="relative">
                        <textarea
                          ref={quickSentenceInputRef}
                          value={quickSentence}
                          onChange={(e) => setQuickSentence(e.target.value)}
                          className="w-full p-2 rounded-xl bg-surface-container-low text-on-surface font-body-sm text-xs focus:outline-hidden focus:ring-2 focus:ring-primary resize-none placeholder:text-outline/60 border border-surface-container-high/60"
                          placeholder="Ví dụ: In contrast to classical methods, immersive learning..."
                          rows={2}
                        />
                      </div>
                      <button
                        disabled={evaluatingSentence || !quickSentence.trim()}
                        className="py-1.5 min-h-[34px] rounded-xl bg-secondary text-white dark:text-on-secondary font-body-sm text-xs font-semibold hover:opacity-90 active:translate-y-0.5 transition-all flex items-center justify-center gap-1 shadow-xs cursor-pointer disabled:opacity-50"
                        type="submit"
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {evaluatingSentence ? 'sync' : 'verified'}
                        </span>
                        <span>{evaluatingSentence ? 'Đang kiểm tra...' : 'Kiểm tra câu'}</span>
                      </button>
                    </form>

                    {sentenceResult && (
                      <div
                        className={`p-2 rounded-xl text-xs font-medium animate-in fade-in duration-150 border ${
                          sentenceResult.grammaticallyCorrect === true
                            ? 'bg-tertiary-fixed/40 text-on-tertiary-fixed border-tertiary/30'
                            : sentenceResult.grammaticallyCorrect === false
                            ? 'bg-error-container text-on-error-container border-error/30'
                            : 'bg-surface-container text-on-surface border-surface-container-high/60'
                        }`}
                      >
                        {sentenceResult.grammaticallyCorrect === true ? (
                          <div>
                            ✓ <strong>Ngữ pháp chuẩn xác!</strong>
                          </div>
                        ) : sentenceResult.grammaticallyCorrect === false ? (
                          <div>
                            ⚠ <strong>Lưu ý:</strong>{' '}
                            {sentenceResult.grammarFeedback || sentenceResult.issues?.[0]?.description || 'Đề xuất sửa ngữ pháp.'}
                          </div>
                        ) : (
                          <div>Chưa đủ dữ liệu kết luận.</div>
                        )}
                      </div>
                    )}

                    {sentenceError && (
                      <div className="p-1.5 rounded-lg bg-error-container text-on-error-container text-[11px] border border-error/30">
                        {sentenceError}
                      </div>
                    )}
                  </div>

                  <div className="pt-2 border-t border-surface-container/60 flex items-center justify-between text-on-surface-variant font-label-stamp text-[9px] uppercase">
                    <span>Chẩn đoán tức thì</span>
                    <button
                      type="button"
                      onClick={() => onNavigateToSentenceLab('check')}
                      className="text-primary hover:underline font-bold cursor-pointer"
                    >
                      Mở Sentence Lab →
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* RIGHT 4 COLS: Intelligence & Heuristics Deck (Educational Card Stack) */}
          <aside className="lg:col-span-4 flex flex-col gap-space-lg">
            {/* Trajectory Card with SVG Donut Progress */}
            <div className="bg-surface-container-lowest rounded-3xl p-space-lg shadow-[0_8px_30px_-4px_rgba(44,39,32,0.06)] border border-surface-container-high/60 flex flex-col gap-space-md">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col min-w-0 pr-1">
                  <h2 className="font-headline-sm text-headline-sm font-bold text-on-surface truncate">
                    Tiến bộ tuần này
                  </h2>
                </div>
                <span className="font-label-stamp text-label-stamp px-2.5 py-1 rounded-full bg-tertiary-fixed text-on-tertiary-fixed font-bold tracking-wider shrink-0 whitespace-nowrap shadow-2xs">
                  {weeklyCount > 0 ? `+${weeklyCount} DỮ LIỆU MỚI` : 'ĐANG RÈN LUYỆN'}
                </span>
              </div>

              {/* Gauge Container */}
              <div className="flex items-center gap-4 sm:gap-5 bg-surface-container-low p-space-md rounded-2xl border border-surface-container-high/50">
                {/* Responsive Ring Chart */}
                <div className="relative w-28 h-28 flex-shrink-0 flex items-center justify-center">
                  <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
                    <circle
                      className="text-surface-container-high"
                      cx="50"
                      cy="50"
                      fill="none"
                      r="42"
                      stroke="currentColor"
                      strokeWidth="7"
                    />
                    <circle
                      className="text-primary transition-all duration-1000 ease-out"
                      cx="50"
                      cy="50"
                      fill="none"
                      r="42"
                      stroke="currentColor"
                      strokeDasharray="263.89"
                      strokeDashoffset={263.89 * (1 - (avgMastery !== null && avgMastery > 0 ? avgMastery / 100 : 0))}
                      strokeLinecap="round"
                      strokeWidth="7"
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-1 select-none pointer-events-none">
                    <span className="font-bold text-xl sm:text-[22px] text-on-surface leading-none tracking-tight">
                      {avgMastery !== null ? `${avgMastery}%` : 'Chưa đủ dữ liệu'}
                    </span>
                    <span className="text-[9px] leading-tight text-on-surface-variant font-semibold tracking-wider uppercase mt-1 max-w-[76px] truncate">
                      {avgMastery !== null ? 'Thành thạo' : 'Chưa đủ dữ liệu'}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="font-body-sm text-body-sm text-on-surface-variant font-medium">
                    Độ vững ngữ pháp
                  </span>
                  <div className="font-headline-sm text-headline-sm text-on-surface font-semibold truncate">
                    {canonicalUserLevel ? `Vững trình độ ${canonicalUserLevel}` : 'Đang xây dựng hồ sơ năng lực'}
                  </div>
                  <div className="inline-flex items-center gap-1 text-tertiary font-body-sm text-body-sm font-semibold pt-1">
                    <span className="material-symbols-outlined text-[16px]">trending_up</span>
                    <span>{weeklyCount > 0 ? 'Tiến trình đang được ghi nhận' : 'Chưa đủ dữ liệu'}</span>
                  </div>
                </div>
              </div>

              {/* Learning Activity Evidence Pill */}
              <div className="flex items-center justify-between px-space-md py-space-xs bg-secondary-fixed/50 rounded-xl border border-secondary-fixed/40">
                <div className="flex items-center gap-space-xs min-w-0">
                  <span className="material-symbols-outlined text-[18px] text-secondary shrink-0">history_edu</span>
                  <span className="font-body-sm text-body-sm font-semibold text-on-secondary-fixed truncate">
                    Hoạt động rèn luyện
                  </span>
                </div>
                <span className="font-label-stamp text-label-stamp uppercase font-bold text-secondary shrink-0 ml-2">
                  {weeklyCount > 0 ? `${weeklyCount} sự kiện đã ghi nhận` : 'Chưa đủ dữ liệu'}
                </span>
              </div>
            </div>

            {/* Practice Zone Card with Dot Matrix Sub-Skills */}
            <div className="bg-surface-container-lowest rounded-3xl p-space-lg shadow-[0_8px_30px_-4px_rgba(44,39,32,0.06)] border border-surface-container-high/60 flex flex-col gap-space-md">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col min-w-0 pr-1">
                  <h2 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                    Khu vực luyện tập
                  </h2>
                </div>
                <span className="material-symbols-outlined text-on-surface-variant text-[20px] shrink-0">tune</span>
              </div>

              <div className="flex flex-col gap-space-md">
                {focusPatterns.length > 0 ? (
                  focusPatterns.slice(0, 3).map((pat) => {
                    const dotsFilled = Math.min(5, Math.max(1, Math.round((pat.estimatedMastery || 20) / 20)));
                    return (
                      <div key={pat.id} className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between text-body-sm font-medium gap-2">
                          <span className="text-on-surface font-semibold line-clamp-1 min-w-0 pr-1">
                            {getPatternDisplayTitle(pat.title, pat.patternCode)}
                          </span>
                          <span
                            className={`shrink-0 whitespace-nowrap ${
                              dotsFilled <= 2
                                ? 'text-error font-bold'
                                : dotsFilled >= 4
                                ? 'text-tertiary font-bold'
                                : 'text-primary font-bold'
                            }`}
                          >
                            Cấp độ {dotsFilled}/5
                          </span>
                        </div>
                        <div className="grid grid-cols-5 gap-1.5 h-2.5">
                          {[1, 2, 3, 4, 5].map((d) => (
                            <span
                              key={d}
                              className={`rounded-full ${
                                d <= dotsFilled
                                  ? dotsFilled <= 2
                                    ? 'bg-error'
                                    : dotsFilled >= 4
                                    ? 'bg-tertiary'
                                    : 'bg-primary'
                                  : 'bg-surface-container-high'
                              }`}
                            />
                          ))}
                        </div>
                        <span className="font-label-stamp text-label-stamp text-on-surface-variant">
                          {getCategoryLabel(pat.category)} • {pat.occurrenceCount} lần gặp
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <div className="flex flex-col items-center justify-center py-6 px-4 text-center rounded-2xl bg-surface-container-low/60 border border-surface-container-high/40 gap-2">
                    <span className="material-symbols-outlined text-[32px] text-on-surface-variant/60">
                      psychology_alt
                    </span>
                    <div className="font-headline-sm text-sm font-semibold text-on-surface">
                      Chưa có dữ liệu trọng tâm
                    </div>
                    <p className="font-body-sm text-xs text-on-surface-variant max-w-xs">
                      Hệ thống sẽ ghi nhận lỗi lặp lại và tính toán mức độ thành thạo khi bạn thực hành viết và kiểm tra câu.
                    </p>
                  </div>
                )}
              </div>

              <button
                onClick={() => onNavigateToSentenceLab('mistakes')}
                className="inline-flex items-center justify-center gap-1.5 min-h-[40px] py-2.5 px-4 rounded-xl bg-surface-container text-on-surface font-body-sm text-body-sm font-semibold hover:bg-surface-container-high transition-colors text-center cursor-pointer border border-outline-variant/60 shadow-xs"
                type="button"
              >
                <span>Xem lỗi thường gặp</span>
                <span className="material-symbols-outlined text-[16px]">chevron_right</span>
              </button>
            </div>

            {/* Weekly Word Rhythm (Tactile Bar Chart) */}
            <div className="bg-surface-container-lowest rounded-3xl p-space-lg shadow-[0_8px_30px_-4px_rgba(44,39,32,0.06)] flex flex-col gap-space-md">
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <h2 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                    Nhịp độ luyện tập
                  </h2>
                </div>
                <div className="text-right">
                  <span className="font-headline-sm text-headline-sm font-bold text-primary">
                    {weeklyWordsWritten.toLocaleString('vi-VN')}
                  </span>
                  <span className="font-body-sm text-body-sm text-on-surface-variant font-medium">
                    {' '}/ {weeklyTargetWords.toLocaleString('vi-VN')} từ
                  </span>
                </div>
              </div>

              {/* Inline Bar Graphic */}
              <div className="flex items-end justify-between h-28 pt-4 gap-2 px-1">
                {rhythmItems.map((item, i) => (
                  <div key={i} className="flex flex-col items-center gap-1.5 flex-1 h-full justify-end">
                    <div
                      className={`w-full rounded-t-lg transition-all ${
                        item.active
                          ? 'bg-primary shadow-xs'
                          : item.wordCount > 0
                          ? 'bg-secondary-container'
                          : 'bg-surface-container'
                      }`}
                      style={{ height: item.height }}
                      title={item.label}
                    />
                    <span
                      className={`font-label-stamp text-[10px] font-bold ${
                        item.active ? 'text-primary' : 'text-on-surface-variant'
                      }`}
                    >
                      {item.day}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between text-body-sm text-on-surface-variant pt-space-2xs">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-primary" />
                  <span>Phiên học hôm nay</span>
                </span>
                <span className={`font-semibold ${weeklyCount > 0 ? 'text-tertiary' : 'text-on-surface-variant'}`}>
                  {weeklyCount > 0 ? 'Đang tiến triển' : 'Sẵn sàng bắt đầu'}
                </span>
              </div>
            </div>
          </aside>
        </div>

      </div>

      {/* Weekly Writing Report Modal */}
      {showWeeklyReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="relative w-full max-w-3xl max-h-[85vh] overflow-y-auto bg-surface-container-lowest rounded-3xl p-6 sm:p-8 border border-surface-container-high shadow-2xl space-y-6 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
                  <span className="material-symbols-outlined text-[26px]">analytics</span>
                </div>
                <div>
                  <h3 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                    Báo cáo viết tuần
                  </h3>
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    Kết quả 7 ngày qua, tốc độ khắc phục lỗi và tiến trình kỹ năng
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowWeeklyReport(false)}
                className="text-on-surface-variant hover:text-on-surface p-1 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[22px]">close</span>
              </button>
            </div>

            {loadingWeekly || !weeklyReport ? (
              <div className="py-16 flex flex-col items-center justify-center space-y-3">
                <span className="material-symbols-outlined text-[32px] animate-spin text-primary">
                  sync
                </span>
                <span className="font-body-sm text-body-sm text-on-surface-variant">
                  Đang tổng hợp báo cáo viết tuần...
                </span>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Stat Grid: All 4 cards fit on ONE ROW on desktop */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-3">
                  <div className="p-3.5 sm:p-4 rounded-2xl bg-surface-container-low border border-surface-container-high flex flex-col justify-between">
                    <span className="font-label-stamp text-[10px] uppercase font-bold text-on-surface-variant whitespace-nowrap truncate" title="Số từ đã viết">
                      Số từ đã viết
                    </span>
                    <span className="font-headline-sm text-[20px] sm:text-headline-sm font-black text-on-surface block mt-1">
                      {weeklyReport.totalWordsWritten}
                    </span>
                  </div>
                  <div className="p-3.5 sm:p-4 rounded-2xl bg-surface-container-low border border-surface-container-high flex flex-col justify-between">
                    <span className="font-label-stamp text-[10px] uppercase font-bold text-on-surface-variant whitespace-nowrap truncate" title="Bài viết hoàn thành">
                      Bài hoàn thành
                    </span>
                    <span className="font-headline-sm text-[20px] sm:text-headline-sm font-black text-on-surface block mt-1">
                      {weeklyReport.completedSessions}
                    </span>
                  </div>
                  <div className="p-3.5 sm:p-4 rounded-2xl bg-surface-container-low border border-surface-container-high flex flex-col justify-between">
                    <span className="font-label-stamp text-[10px] uppercase font-bold text-on-surface-variant whitespace-nowrap truncate" title="Bài luyện đã làm">
                      Bài luyện tập
                    </span>
                    <span className="font-headline-sm text-[20px] sm:text-headline-sm font-black text-on-surface block mt-1">
                      {weeklyReport.practicesCompleted}
                    </span>
                  </div>
                  <div className="p-3.5 sm:p-4 rounded-2xl bg-surface-container-low border border-surface-container-high flex flex-col justify-between">
                    <span className="font-label-stamp text-[10px] uppercase font-bold text-on-surface-variant whitespace-nowrap truncate" title="Tốc độ sửa lỗi">
                      Tốc độ sửa lỗi
                    </span>
                    <span className="font-headline-sm text-[20px] sm:text-headline-sm font-black text-primary block mt-1 truncate">
                      {weeklyReport.errorResolutionVelocity !== null && weeklyReport.errorResolutionVelocity !== undefined
                        ? `${weeklyReport.errorResolutionVelocity}%`
                        : 'Chưa đủ dữ liệu'}
                    </span>
                  </div>
                </div>

                {/* Coach Summary */}
                <div className="p-4 rounded-2xl bg-primary-fixed/30 border border-primary/20 text-body-sm text-on-surface">
                  <span className="font-bold block mb-1">Nhận xét từ Huấn luyện viên:</span>
                  {weeklyReport.constructiveSummary}
                </div>

                {/* Skill Dimensions & Mastery */}
                <div className="space-y-3">
                  <h4 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                    Tiêu chí kỹ năng và Mức độ thành thạo
                  </h4>
                  <div className="space-y-2.5">
                    {weeklyReport.skillDimensionScores?.map((dim) => (
                      <div
                        key={dim.dimension}
                        className="p-3 rounded-xl bg-surface-container-low border border-surface-container-high space-y-1.5"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-on-surface">{dim.name}</span>
                          <span className="font-bold text-primary">
                            {dim.score !== null && dim.score !== undefined
                              ? `${dim.score}% (${dim.trend})`
                              : 'Chưa đủ dữ liệu'}
                          </span>
                        </div>
                        {dim.score !== null && dim.score !== undefined && (
                          <div className="w-full bg-surface-container-high h-1.5 rounded-full overflow-hidden">
                            <div
                              className="bg-primary h-full rounded-full"
                              style={{ width: `${dim.score}%` }}
                            />
                          </div>
                        )}
                        <p className="font-label-stamp text-[10px] text-on-surface-variant">
                          {dim.guidance}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Top Mastered Patterns */}
                {weeklyReport.topMasteredPatterns?.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                      Các dạng lỗi đã làm chủ tốt nhất
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {weeklyReport.topMasteredPatterns.map((pat) => (
                        <div
                          key={pat.patternCode}
                          className="p-3 rounded-xl bg-surface-container-low border border-surface-container-high flex items-center justify-between"
                        >
                          <div>
                            <span className="text-xs font-bold text-on-surface block">
                              {pat.title || formatPatternCode(pat.patternCode).title}
                            </span>
                            <span className="font-label-stamp text-[10px] text-on-surface-variant">
                              {pat.occurrenceCount} lần gặp · {pat.masteryPercentage}% thành thạo
                            </span>
                          </div>
                          <span
                            className={`px-2 py-0.5 rounded-full font-label-stamp text-[10px] font-bold ${
                              pat.status === 'RESOLVED'
                                ? 'bg-tertiary-fixed text-on-tertiary-fixed'
                                : pat.status === 'IN_PROGRESS'
                                ? 'bg-secondary-fixed text-on-secondary-fixed'
                                : 'bg-error-container text-on-error-container'
                            }`}
                          >
                            {pat.status === 'RESOLVED' ? 'Đã khắc phục' : pat.status === 'IN_PROGRESS' ? 'Đang rèn luyện' : 'Cần chú ý'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
