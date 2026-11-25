'use client';

import React, { useState } from 'react';
import {
  ExamResultDto,
  AttemptReviewDto,
  RecommendationDto,
} from '@/types/exams';
import { EXAM_LABELS } from '@/lib/exams/labels';
import {
  Award,
  Clock,
  ArrowRight,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  BookOpen,
  Headphones,
  PenTool,
  Mic,
  ShieldAlert,
  Loader2,
  FileText,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import Link from 'next/link';
import { BackButton } from './BackButton';
import { useLanguage } from '@/context/LanguageContext';
import { SpeakingResultReview } from './SpeakingResultReview';

interface ExamResultViewProps {
  result: ExamResultDto;
  review?: AttemptReviewDto | null;
  recommendations?: RecommendationDto[];
  onOpenReviewItem?: (placementId: string) => void;
  lang?: 'en' | 'vi';
}

function formatAnswerValue(val: any): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    return val.map((v) => (typeof v === 'object' ? formatAnswerValue(v) : String(v))).join(' / ');
  }
  if (typeof val === 'object') {
    if (Array.isArray(val.values)) {
      return val.values.map((v: any) => formatAnswerValue(v)).join(' / ');
    }
    if (Array.isArray(val.items)) {
      return val.items.map((i: any) => formatAnswerValue(i)).join(', ');
    }
    if (val.value !== undefined) {
      return formatAnswerValue(val.value);
    }
    if (val.text !== undefined) {
      return formatAnswerValue(val.text);
    }
    if (val.answer !== undefined) {
      return formatAnswerValue(val.answer);
    }
    return JSON.stringify(val);
  }
  return String(val);
}

export const ExamResultView: React.FC<ExamResultViewProps> = ({
  result,
  review,
  recommendations = [],
  onOpenReviewItem,
  lang: propLang,
}) => {
  const { language } = useLanguage();
  const lang = propLang || language || 'vi';
  const t = EXAM_LABELS[lang] || EXAM_LABELS.vi;
  const [activeTab, setActiveTab] = useState<'SUMMARY' | 'ANSWERS' | 'SPEAKING' | 'CRITERIA' | 'RECOMMENDATIONS'>('SUMMARY');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  const isIelts = result.family === 'IELTS';
  const isToeic = result.family === 'TOEIC';

  const components = result.components || [];
  const skillScores = result.skillScores || {};
  const completedAtStr = result.completedAt
    ? new Date(result.completedAt).toLocaleString('vi-VN')
    : new Date().toLocaleString('vi-VN');

  const isPendingSubjective =
    result.resultStatus === 'REVIEW_REQUIRED' ||
    result.resultStatus === 'PARTIAL';

  const isFullyScored = result.resultStatus === 'COMPLETED';

  // Strict Atomic Score Reveal Policy for Full IELTS Mock
  const isFullMock =
    isIelts &&
    (result.scope?.toUpperCase() === 'FULL_MOCK' ||
      result.scope?.toUpperCase() === 'FULL' ||
      result.scope?.toUpperCase() === 'ALL' ||
      result.variant?.toUpperCase() === 'FULL' ||
      components.length >= 4);

  // Format metric icon
  const getSkillIcon = (skill: string) => {
    switch (skill.toUpperCase()) {
      case 'LISTENING':
        return <Headphones className="w-5 h-5 text-sky-500" />;
      case 'READING':
        return <BookOpen className="w-5 h-5 text-emerald-500" />;
      case 'WRITING':
        return <PenTool className="w-5 h-5 text-amber-500" />;
      case 'SPEAKING':
        return <Mic className="w-5 h-5 text-purple-500" />;
      default:
        return <Award className="w-5 h-5 text-primary" />;
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6 select-none">
      <div>
        <BackButton
          href={`/exams/${(result.family || 'ielts').toLowerCase()}`}
          label={t.backToLibrary || (lang === 'vi' ? 'Quay lại Thư viện đề' : 'Back to Library')}
        />
      </div>

      {/* 1. Header Banner */}
      <div className="bg-card border border-border rounded-2xl p-6 sm:p-8 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold px-2.5 py-1 rounded-lg bg-primary/10 text-primary border border-primary/20 tracking-wider">
              {result.family} {result.variant}
            </span>
            <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded-md font-medium">
              Chế độ: {result.mode === 'EXAM_SIMULATION' ? 'Thi mô phỏng' : 'Luyện tập'}
            </span>
            <span
              className={`text-xs font-semibold px-2.5 py-0.5 rounded-md ${
                isFullyScored
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
              }`}
            >
              {isFullyScored
                ? (lang === 'vi' ? 'Đã chấm hoàn tất' : 'Scoring finished')
                : (lang === 'vi' ? 'Đã nộp · Chưa có điểm đầy đủ' : 'Submitted · Complete scores unavailable')}
            </span>
          </div>

          <h1 className="text-2xl font-bold text-foreground">
            {lang === 'vi' ? 'Kết Quả Bài Thi' : 'Examination Results'}
          </h1>
          <p className="text-xs text-muted-foreground">
            Hoàn thành lúc {completedAtStr} • Hệ thống khảo thí English Coach
          </p>
        </div>

        {/* Primary Overall Score Badge */}
        {isIelts && (
          <div className="flex items-center gap-4 bg-primary/5 border border-primary/20 rounded-2xl p-4 shrink-0">
            <div className="p-3 bg-primary text-primary-foreground rounded-xl shadow-sm">
              <Award className="w-8 h-8" />
            </div>
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block">
                Overall Band Score
              </span>
              {isFullyScored && result.overallScore !== undefined && result.overallScore !== null ? (
                <div className="text-4xl font-extrabold text-foreground">
                  {result.overallScore.toFixed(1)}
                </div>
              ) : isFullyScored ? (
                <div className="mt-1">
                  <div className="text-2xl font-extrabold text-muted-foreground">
                    —
                  </div>
                  <span className="text-[11px] text-muted-foreground font-medium block">
                    {lang === 'vi' ? 'Bài thi theo kỹ năng (Không tính điểm Overall)' : 'Partial practice (No Overall Band)'}
                  </span>
                </div>
              ) : (
                <div className="text-sm font-bold text-amber-500 mt-1 flex items-center gap-1.5">
                  <span>{lang === 'vi' ? 'Chưa có điểm Overall khả dụng' : 'Overall score unavailable'}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {isToeic && (
          <div className="bg-primary/5 border border-primary/20 rounded-2xl p-4 shrink-0">
            {skillScores['LR_TOTAL'] !== undefined || (skillScores['LISTENING'] !== undefined && skillScores['READING'] !== undefined) ? (
              <>
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block">
                  TOEIC Listening and Reading Score
                </span>
                <div className="text-3xl font-extrabold text-foreground mt-1">
                  {skillScores['LR_TOTAL'] ?? (skillScores['LISTENING'] + skillScores['READING'])}
                  <span className="text-sm font-normal text-muted-foreground ml-1">/ 990</span>
                </div>
              </>
            ) : skillScores['SPEAKING'] !== undefined ? (
              <>
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block">
                  TOEIC Speaking Score
                </span>
                <div className="text-3xl font-extrabold text-foreground mt-1">
                  {skillScores['SPEAKING']}
                  <span className="text-sm font-normal text-muted-foreground ml-1">/ 200</span>
                </div>
              </>
            ) : skillScores['WRITING'] !== undefined ? (
              <>
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block">
                  TOEIC Writing Score
                </span>
                <div className="text-3xl font-extrabold text-foreground mt-1">
                  {skillScores['WRITING']}
                  <span className="text-sm font-normal text-muted-foreground ml-1">/ 200</span>
                </div>
              </>
            ) : (
              <>
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block">
                  TOEIC Listening and Reading Score
                </span>
                <div className="text-base font-bold text-amber-500 mt-1">
                  {lang === 'vi' ? 'Chưa có điểm khả dụng' : 'Score unavailable'}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Pending Subjective Warning (Only for non-Full Mock or legacy partials) */}
      {isPendingSubjective || result.resultStatus === 'FAILED' ? (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3 text-xs">
          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h4 className="font-bold text-amber-600 dark:text-amber-400">
              {lang === 'vi' ? 'Bài đã được nộp; kết quả đánh giá chưa đầy đủ' : 'Submission saved; assessment is incomplete'}
            </h4>
            <p className="text-muted-foreground leading-relaxed">
              {lang === 'vi' ? 'Bạn có thể xem lại bài đã nộp. Điểm không khả dụng không được thay bằng điểm 0 hoặc band ước đoán.' : 'You can review your submitted work. Unavailable scores are not replaced by zero or an estimated band.'}
            </p>
          </div>
        </div>
      ) : null}

      {/* Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-border pb-1">
        <button
          id="exam-result-summary-tab"
          onClick={() => setActiveTab('SUMMARY')}
          className={`px-4 py-2 text-xs font-bold border-b-2 transition-colors cursor-pointer ${
            activeTab === 'SUMMARY'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {lang === 'vi' ? 'Bảng điểm chi tiết' : 'Score Breakdown'}
        </button>
        {review && (
          <button
            id="exam-result-answers-tab"
            onClick={() => setActiveTab('ANSWERS')}
            className={`px-4 py-2 text-xs font-bold border-b-2 transition-colors cursor-pointer ${
              activeTab === 'ANSWERS'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {lang === 'vi' ? `Xem lại câu trả lời (${review.items.length})` : `Answer Review (${review.items.length})`}
          </button>
        )}
        {review?.speakingReview && (
          <button
            id="exam-result-speaking-tab"
            onClick={() => setActiveTab('SPEAKING')}
            className={`px-4 py-2 text-xs font-bold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'SPEAKING'
                ? 'border-purple-600 text-purple-600 dark:text-purple-400'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Mic className="w-3.5 h-3.5" />
            <span>{lang === 'vi' ? 'Đánh giá Speaking' : 'Speaking Review'}</span>
          </button>
        )}
      </div>

      {/* 2. Score Breakdown Tab */}
      {activeTab === 'SUMMARY' && (
        <div className="space-y-6">
          {/* Skill Breakdown Cards */}
          {(() => {
            const displayComponents = isToeic
              ? components.filter((c) => {
                  const m = c.metric?.toUpperCase();
                  return m !== 'LR_TOTAL' && m !== 'FULL_OVERALL' && m !== 'OVERALL';
                })
              : components;

            const formatMetricLabel = (metric: string) => {
              switch (metric.toUpperCase()) {
                case 'LISTENING':
                  return 'Listening';
                case 'READING':
                  return 'Reading';
                case 'WRITING':
                  return 'Writing';
                case 'SPEAKING':
                  return 'Speaking';
                default:
                  return metric;
              }
            };

            return (
              <div
                className={`grid grid-cols-1 gap-4 ${
                  isToeic
                    ? 'sm:grid-cols-2 max-w-2xl'
                    : 'sm:grid-cols-2 lg:grid-cols-4'
                }`}
              >
                {displayComponents.map((comp) => {
                  const rawOnly = comp.status === 'RAW_ONLY' && typeof comp.rawScore === 'number';
                  const isExplicitlyUnattempted =
                    comp.status === 'UNATTEMPTED' || comp.status === 'OMITTED';
                  const isCompPending =
                    !isExplicitlyUnattempted &&
                    (comp.status === 'PENDING_AI_EVALUATION' ||
                      (comp.scaledScore === 0 &&
                        (comp.metric.toUpperCase() === 'WRITING' ||
                          comp.metric.toUpperCase() === 'SPEAKING')));
                  const isUnattempted =
                    isExplicitlyUnattempted ||
                    (!isCompPending &&
                      (comp.scaledScore === null || comp.scaledScore === undefined));

                  const maxScore =
                    comp.metric.toUpperCase() === 'LISTENING' ||
                    comp.metric.toUpperCase() === 'READING'
                      ? 495
                      : 200;

                  return (
                    <div
                      key={comp.metric}
                      className="bg-card border border-border rounded-xl p-5 space-y-3 shadow-sm hover:border-primary/40 transition-all"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                          {formatMetricLabel(comp.metric)}
                        </span>
                        {getSkillIcon(comp.metric)}
                      </div>

                      <div className="flex items-baseline gap-2">
                        {rawOnly ? (
                          <strong>{comp.rawScore} / {comp.uncertaintyRange?.maxRaw} {lang === 'vi' ? 'câu đúng' : 'correct'}</strong>
                        ) : isUnattempted ? (
                          <span className="text-2xl font-extrabold text-muted-foreground">
                            —
                          </span>
                        ) : isCompPending ||
                          comp.scaledScore === undefined ||
                          comp.scaledScore === null ? (
                          <span className="text-base font-bold text-amber-500">
                            {lang === 'vi' ? 'Chưa có đánh giá khả dụng' : 'Assessment unavailable'}
                          </span>
                        ) : isToeic ? (
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-3xl font-extrabold text-foreground">
                              {comp.scaledScore}
                            </span>
                            <span className="text-sm font-normal text-muted-foreground">
                              / {maxScore}
                            </span>
                          </div>
                        ) : (
                          <span className="text-3xl font-extrabold text-foreground">
                            {isIelts ? comp.scaledScore.toFixed(1) : comp.scaledScore}
                          </span>
                        )}
                        {!isUnattempted && !isToeic && (
                          <span className="text-xs text-muted-foreground">
                            {comp.scaleName === 'IELTS_BAND_ESTIMATE' || (isIelts && ['SPEAKING', 'WRITING'].includes(comp.metric))
                              ? lang === 'vi' ? 'Band luyện tập ước tính' : 'Estimated practice band' : comp.scaleName}
                          </span>
                        )}
                      </div>

                      {!isUnattempted && comp.rawScore !== undefined && !isCompPending && (
                        <p className="text-xs text-muted-foreground">
                          Số câu đúng: <strong>{comp.rawScore}</strong>
                        </p>
                      )}
                      {isUnattempted && !rawOnly && (
                        <p className="text-xs text-muted-foreground italic">
                          {lang === 'vi'
                            ? 'Không thuộc bài làm này (Chưa làm / Không khả dụng)'
                            : 'Not part of this attempt'}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {isFullyScored && result.criteria?.some(c => c.target === 'WRITING') && (
            <section className="rounded-xl border border-border p-5 space-y-4">
              <h3 className="font-semibold">{lang === 'vi' ? 'Nhận xét Writing · Điểm AI ước tính' : 'Writing feedback · AI practice estimate'}</h3>
              {result.criteria.filter(c => c.target === 'WRITING').map(c => (
                <div key={c.rubricCriterion} className="space-y-1 text-sm">
                  <h4 className="font-semibold">{c.rubricCriterion.replaceAll('_', ' ').toLowerCase()} · {c.score}</h4>
                  {typeof c.confidenceMeta?.feedback === 'string' && <p>{c.confidenceMeta.feedback}</p>}
                  {c.evidenceReferences?.map((ref, i) => typeof ref.snippet === 'string' && (
                    <blockquote key={i} className="border-l-2 pl-3 text-muted-foreground">{ref.snippet}</blockquote>
                  ))}
                </div>
              ))}
            </section>
          )}

          {/* Quick Handoff Card */}
          <div className="p-6 bg-muted/30 border border-border rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-bold text-foreground">
                {lang === 'vi' ? 'Xem lộ trình trong Hồ sơ Năng lực' : 'View Pathway in Competency Profile'}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Theo dõi biểu đồ tiến bộ theo thời gian, độ tin cậy kết quả và khuyến nghị học tập cá nhân hóa.
              </p>
            </div>
            <Link
              href={`/exams/profile?family=${result.family.toLowerCase()}`}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground hover:bg-primary/90 rounded-xl text-xs font-bold transition-colors shrink-0 shadow"
            >
              <span>{t.viewProfile}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      )}

      {/* 3. Answer Review Tab */}
      {activeTab === 'ANSWERS' && review && (
        <div className="space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-border">
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
              {lang === 'vi' ? `Chi tiết câu trả lời (${review.items.length} câu)` : `Answer Details (${review.items.length} items)`}
            </span>
            <button
              onClick={() => {
                if (expandedItems.size === review.items.length) {
                  setExpandedItems(new Set());
                } else {
                  setExpandedItems(new Set(review.items.map((it) => it.placementId)));
                }
              }}
              className="text-xs font-medium text-primary hover:underline cursor-pointer"
            >
              {expandedItems.size === review.items.length
                ? (lang === 'vi' ? 'Thu gọn tất cả' : 'Collapse all')
                : (lang === 'vi' ? 'Mở rộng tất cả' : 'Expand all')}
            </button>
          </div>

          <div className="space-y-3.5">
            {review.items.map((item, idx) => {
              const isExpanded = expandedItems.has(item.placementId);
              const hasExplanation = item.explanation && item.explanation.trim().length > 0;
              const isSubjective = Boolean(item.isSubjective || item.skill === 'SPEAKING' || item.skill === 'WRITING');
              const isSpeaking = item.skill === 'SPEAKING';
              const isWriting = item.skill === 'WRITING';

              return (
                <div
                  key={item.placementId}
                  className="bg-card border border-border rounded-xl p-4 space-y-3 shadow-xs transition-all hover:border-border/90"
                >
                  <div
                    onClick={() => {
                      setExpandedItems((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.placementId)) next.delete(item.placementId);
                        else next.add(item.placementId);
                        return next;
                      });
                    }}
                    className="flex items-start justify-between gap-3 cursor-pointer select-none"
                  >
                    <div className="flex items-start gap-2.5 flex-1 min-w-0">
                      <span className="text-xs font-bold px-2.5 py-0.5 rounded-md bg-muted text-foreground shrink-0">
                        {lang === 'vi' ? `Câu ${idx + 1}` : `Question ${idx + 1}`}
                      </span>
                      <span className={`text-xs font-medium text-foreground leading-relaxed ${isExpanded ? '' : 'line-clamp-1'}`}>
                        {item.prompt}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {isSubjective ? (
                        <span className="text-xs font-semibold px-2.5 py-0.5 rounded-md bg-muted text-muted-foreground">
                          {isSpeaking
                            ? (lang === 'vi' ? 'Bài thi nói' : 'Speaking Task')
                            : (lang === 'vi' ? 'Bài thi viết' : 'Writing Task')}
                        </span>
                      ) : item.isCorrect ? (
                        <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="w-4 h-4" />
                          <span>+{item.creditAwarded}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-bold text-rose-600 dark:text-rose-400">
                          <XCircle className="w-4 h-4" />
                          <span>{item.creditAwarded}/{item.maxCredit}</span>
                        </span>
                      )}
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      )}
                    </div>
                  </div>

                  {/* Answers Comparison or Subjective Response Card */}
                  {isSpeaking ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-2 border-t border-border/60">
                      <div className="p-3 bg-muted/40 rounded-lg space-y-1">
                        <span className="text-muted-foreground block text-[11px] uppercase font-bold">
                          {lang === 'vi' ? 'Bản ghi âm bài nói' : 'Spoken Response'}
                        </span>
                        <span className="font-mono text-foreground font-semibold block break-words">
                          {typeof item.userAnswer === 'object' && item.userAnswer?.transcript
                            ? item.userAnswer.transcript
                            : typeof item.userAnswer === 'object' && item.userAnswer?.recordingId
                            ? `Đã ghi âm (ID: ${String(item.userAnswer.recordingId).slice(0, 8)}...)`
                            : (lang === 'vi' ? 'Bản ghi âm đã được ghi nhận' : 'Audio recording registered')}
                        </span>
                      </div>
                      <div className="p-3 bg-purple-500/10 border border-purple-500/20 rounded-lg flex flex-col justify-between gap-2">
                        <div>
                          <span className="text-purple-600 dark:text-purple-400 block text-[11px] uppercase font-bold">
                            {lang === 'vi' ? 'Phương thức đánh giá' : 'Assessment Model'}
                          </span>
                          <span className="text-xs text-muted-foreground block mt-0.5">
                            {lang === 'vi' ? 'Chấm theo 4 tiêu chí chuẩn IELTS' : 'Evaluated across 4 official IELTS criteria'}
                          </span>
                        </div>
                        {review?.speakingReview && (
                          <button
                            onClick={() => setActiveTab('SPEAKING')}
                            className="text-xs font-bold text-purple-600 dark:text-purple-400 hover:underline inline-flex items-center gap-1 cursor-pointer self-start"
                          >
                            <Mic className="w-3.5 h-3.5" />
                            <span>{lang === 'vi' ? 'Xem chi tiết đánh giá Speaking ->' : 'Open Speaking Review ->'}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ) : isWriting ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-2 border-t border-border/60">
                      <div className="p-3 bg-muted/40 rounded-lg space-y-1">
                        <span className="text-muted-foreground block text-[11px] uppercase font-bold">
                          {lang === 'vi' ? 'Bài làm của bạn' : 'Your Submitted Text'}
                        </span>
                        <span className="text-foreground leading-relaxed block break-words font-mono text-[11px] max-h-36 overflow-y-auto whitespace-pre-wrap">
                          {formatAnswerValue(item.userAnswer) || (lang === 'vi' ? '(Chưa điền đáp án)' : '(No response recorded)')}
                        </span>
                      </div>
                      <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                        <span className="text-amber-600 dark:text-amber-400 block text-[11px] uppercase font-bold">
                          {lang === 'vi' ? 'Phương thức đánh giá' : 'Assessment Model'}
                        </span>
                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                          {lang === 'vi'
                            ? 'Chấm điểm tự luận theo Task Achievement / Coherence / Lexical / Grammar.'
                            : 'Assessed against official Task Achievement, Coherence, Lexical, and Grammar rubrics.'}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-2 border-t border-border/60">
                      <div className="p-3 bg-muted/40 rounded-lg">
                        <span className="text-muted-foreground block text-[11px] uppercase font-bold">
                          {lang === 'vi' ? 'Câu trả lời của bạn' : 'Your Answer'}
                        </span>
                        <span className="font-mono text-foreground font-semibold mt-1 block break-words">
                          {formatAnswerValue(item.userAnswer) || (lang === 'vi' ? '(Chưa điền đáp án)' : '(No answer recorded)')}
                        </span>
                      </div>
                      <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                        <span className="text-emerald-600 dark:text-emerald-400 block text-[11px] uppercase font-bold">
                          {lang === 'vi' ? 'Đáp án chính xác' : 'Correct Answer'}
                        </span>
                        <span className="font-mono text-emerald-700 dark:text-emerald-300 font-semibold mt-1 block break-words">
                          {formatAnswerValue(item.acceptedAnswers) || (lang === 'vi' ? '(Theo tiêu chuẩn chấm điểm)' : '(Official key)')}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Optional Explanation - only if genuine explanation text exists */}
                  {hasExplanation && isExpanded && (
                    <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg text-xs space-y-1">
                      <span className="text-primary font-bold block text-[11px] uppercase">
                        {lang === 'vi' ? 'Giải thích đáp án' : 'Explanation'}
                      </span>
                      <p className="text-foreground/90 leading-relaxed">
                        {item.explanation}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 4. Speaking Review Tab */}
      {activeTab === 'SPEAKING' && review?.speakingReview && (
        <SpeakingResultReview speakingReview={review.speakingReview} lang={lang} />
      )}
    </div>
  );
};
