'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock,
  GraduationCap,
  Headphones,
  Info,
  ListChecks,
  MinusCircle,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { examsApi } from '@/services/examsApi';
import type { PracticeResultDto, PracticeReviewDto, PracticeReviewGroupDto, PracticeReviewItemDto, PublicStimulusDto, SpeakingAttemptReviewDto } from '@/types/exams';
import { useLanguage } from '@/context/LanguageContext';
import { BackButton } from './BackButton';
import { StimulusRenderer } from './StimulusRenderer';
import { isAudioAsset, useExamAssetUrl } from '@/lib/exams/media';
import { formatAnswer, formatDuration, practiceScopeLabel, rawScoreLine, reviewStatusLabel } from '@/lib/exams/practice';
import { itemOptions, toeicPartName } from '@/lib/exams/runnerModel';
import { formatOptionCleanText, formatOptionDisplayLabel } from './QuestionRenderers';
import { SpeakingResultReview } from './SpeakingResultReview';

interface PracticeResultReviewProps {
  family: string;
  attemptId: string;
}

type ReviewFilter = 'ALL' | 'INCORRECT' | 'UNANSWERED' | 'CORRECT';

const STATUS_STYLE: Record<string, { chip: string; icon: React.ReactNode }> = {
  CORRECT: {
    chip: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200 border-emerald-500/40',
    icon: <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-hidden />,
  },
  INCORRECT: {
    chip: 'bg-rose-500/10 text-rose-800 dark:text-rose-200 border-rose-500/40',
    icon: <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" aria-hidden />,
  },
  UNANSWERED: {
    chip: 'bg-amber-500/10 text-amber-900 dark:text-amber-200 border-amber-500/40 border-dashed',
    icon: <MinusCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" aria-hidden />,
  },
  NOT_SCORED: {
    chip: 'bg-muted text-muted-foreground border-border',
    icon: <Circle className="w-4 h-4 text-muted-foreground" aria-hidden />,
  },
};

function ReviewAudio({ attemptId, stimulus, lang }: { attemptId: string; stimulus: PublicStimulusDto; lang: 'vi' | 'en' }) {
  const asset = (stimulus.assets || []).find(isAudioAsset);
  const { status, url } = useExamAssetUrl(attemptId, asset);
  if (!asset) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Headphones className="w-4 h-4" aria-hidden />
      {status === 'ready' && url ? (
        <audio controls preload="none" src={url} className="h-9 max-w-full" aria-label={lang === 'vi' ? 'Nghe lại bản ghi' : 'Replay the recording'} />
      ) : status === 'loading' || status === 'idle' ? (
        <span>{lang === 'vi' ? 'Đang tải âm thanh…' : 'Loading audio…'}</span>
      ) : (
        <span>{lang === 'vi' ? 'Âm thanh chưa sẵn sàng' : 'Audio not available'}</span>
      )}
    </div>
  );
}

function answerText(item: PracticeReviewItemDto, id: string): string {
  const opt = itemOptions(item as any).find((o) => o.id === id);
  return opt ? formatOptionDisplayLabel(id, opt.text) : id;
}

/**
 * Exams Phase 6 / 7 — raw practice result + learning-oriented review, built from the attempt snapshot. Correct answers
 * arrive only after submission (the API refuses earlier). No standardized score, no invented explanation, no
 * transcript, no source / QA metadata, no AI call on load.
 */
export function PracticeResultReview({ family, attemptId }: PracticeResultReviewProps) {
  const router = useRouter();
  const { language } = useLanguage();
  const lang: 'vi' | 'en' = language === 'en' ? 'en' : 'vi';
  const familySlug = family.toLowerCase();

  const [result, setResult] = useState<PracticeResultDto | null>(null);
  const [review, setReview] = useState<PracticeReviewDto | null>(null);
  const [speakingReview, setSpeakingReview] = useState<SpeakingAttemptReviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [again, setAgain] = useState(false);
  const [againError, setAgainError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReviewFilter>('ALL');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await examsApi.getPracticeResult(attemptId);
        if (cancelled) return;
        setResult(r);
        if (r.skill === 'SPEAKING' && r.completionStatus === 'SUBMITTED') {
          examsApi.getSpeakingReview(attemptId).then((sr) => { if (!cancelled) setSpeakingReview(sr); }).catch(() => {});
        }
        if (r.reviewAvailable) {
          if (r.skill !== 'SPEAKING') {
            examsApi.getPracticeReview(attemptId).then((rv) => { if (!cancelled) setReview(rv); }).catch(() => {});
          }
        }
      } catch (err: any) {
        if (cancelled) return;
        if (err?.response?.status === 404) setNotFound(true);
        else setError(lang === 'vi' ? 'Không tải được kết quả luyện tập.' : 'Could not load the practice result.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attemptId, lang]);

  const allItems = useMemo(() => (review?.groups || []).flatMap((g) => g.items), [review]);
  const counts = useMemo(() => {
    const c = { ALL: allItems.length, INCORRECT: 0, UNANSWERED: 0, CORRECT: 0 } as Record<ReviewFilter, number>;
    allItems.forEach((i) => {
      if (i.status === 'INCORRECT') c.INCORRECT++;
      else if (i.status === 'UNANSWERED') c.UNANSWERED++;
      else if (i.status === 'CORRECT') c.CORRECT++;
    });
    return c;
  }, [allItems]);
  const objective = result?.scoringMode === 'OBJECTIVE_RAW';

  const practiceAgain = async () => {
    if (again) return;
    setAgain(true);
    setAgainError(null);
    try {
      const next = await examsApi.practiceAgain(attemptId);
      router.push(`/exams/${familySlug}/attempts/${next.attemptId}`);
    } catch (err: any) {
      const code = err?.response?.data?.code;
      setAgainError(
        code === 'PRACTICE_SOURCE_UNAVAILABLE'
          ? lang === 'vi'
            ? 'Phiên bản đề của lần luyện này hiện không còn dùng được, nên chưa thể luyện lại đúng phần này. Bạn có thể chọn đề khác trong kho đề.'
            : 'The test version of this practice is no longer available, so this part cannot be repeated. Choose another test in the library.'
          : code === 'RATE_LIMITED'
          ? lang === 'vi'
            ? 'Bạn thao tác hơi nhanh. Vui lòng đợi khoảng một phút rồi thử lại.'
            : 'Too many attempts in a short time. Please wait a minute and try again.'
          : code === 'PRACTICE_ATTEMPT_IN_PROGRESS'
          ? lang === 'vi'
            ? 'Bạn đang có một lần luyện phần này chưa nộp. Hãy tiếp tục lần đó trước.'
            : 'You already have an unfinished practice of this part. Continue it first.'
          : lang === 'vi'
          ? 'Chưa tạo được lần luyện mới. Vui lòng thử lại.'
          : 'A new practice could not be created. Please try again.'
      );
      setAgain(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-4" role="status" aria-live="polite">
        <span className="sr-only">{lang === 'vi' ? 'Đang tải kết quả…' : 'Loading result…'}</span>
        <div className="h-8 w-28 rounded-xl bg-muted animate-pulse motion-reduce:animate-none" />
        <div className="h-48 rounded-2xl bg-muted/50 animate-pulse motion-reduce:animate-none" />
        <div className="h-72 rounded-2xl bg-muted/30 animate-pulse motion-reduce:animate-none" />
      </div>
    );
  }

  if (notFound || (!result && error)) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 text-center space-y-4">
        <AlertCircle className="w-8 h-8 mx-auto text-muted-foreground" aria-hidden />
        <h1 className="text-lg font-bold text-foreground">
          {notFound ? (lang === 'vi' ? 'Không tìm thấy lần luyện tập này' : 'Practice attempt not found') : error}
        </h1>
        <Link href={`/exams/${familySlug}`} className="inline-flex h-10 px-4 items-center rounded-xl border border-border text-sm font-semibold hover:bg-muted">
          {lang === 'vi' ? 'Về kho đề' : 'Back to library'}
        </Link>
      </div>
    );
  }
  if (!result) return null;

  const scopeName = result.scopeType === 'TOEIC_PART' ? toeicPartName(result.scopeNumber, lang) : '';
  const title = practiceScopeLabel({ scopeType: result.scopeType, number: result.scopeNumber }, lang);
  const submitted = result.completionStatus === 'SUBMITTED';
  const accuracy = typeof result.rawAccuracyPercent === 'number' ? result.rawAccuracyPercent : null;
  const visible = (it: PracticeReviewItemDto) => filter === 'ALL' || it.status === filter;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <BackButton href={`/exams/${familySlug}`} label={lang === 'vi' ? 'Về kho đề' : 'Back to library'} />
        {result.sourceFormId && (
          <Link href={`/exams/${familySlug}/tests/${result.sourceFormId}`} className="text-xs font-semibold text-muted-foreground hover:text-foreground">
            {lang === 'vi' ? 'Xem các phần khác của đề' : 'Other parts of this test'}
          </Link>
        )}
      </div>

      {/* SUMMARY */}
      <section
        data-practice-result={result.scopeCode}
        className="rounded-2xl border border-border bg-card overflow-hidden border-t-4 border-t-emerald-500"
        aria-labelledby="practice-result-title"
      >
        <div className="p-5 sm:p-6 space-y-5">
          <div className="space-y-1.5">
            <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40 text-[11px] font-bold">
              <GraduationCap className="w-3.5 h-3.5" aria-hidden />
              {lang === 'vi' ? 'Kết quả luyện tập' : 'Practice result'}
            </span>
            <h1 id="practice-result-title" className="text-xl sm:text-2xl font-extrabold text-foreground">
              {title}
              {scopeName && <span className="font-semibold text-muted-foreground"> · {scopeName}</span>}
            </h1>
            {result.sourceTitle && <p className="text-sm text-muted-foreground">{result.sourceTitle}</p>}
          </div>

          {!submitted ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted-foreground">{lang === 'vi' ? 'Bài luyện này chưa được nộp.' : 'This practice has not been submitted yet.'}</p>
              <Link href={`/exams/${familySlug}/attempts/${attemptId}`} className="h-10 px-4 inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold">
                <RotateCcw className="w-4 h-4" aria-hidden />
                {lang === 'vi' ? 'Tiếp tục làm' : 'Continue'}
              </Link>
            </div>
          ) : objective ? (
            <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-5 items-center">
              <div className="flex items-center gap-4">
                <div className="relative w-24 h-24 shrink-0" aria-hidden>
                  <svg viewBox="0 0 36 36" className="w-24 h-24 -rotate-90">
                    <circle cx="18" cy="18" r="15.9" fill="none" className="stroke-muted" strokeWidth="3.2" />
                    <circle
                      cx="18"
                      cy="18"
                      r="15.9"
                      fill="none"
                      className="stroke-emerald-500"
                      strokeWidth="3.2"
                      strokeLinecap="round"
                      strokeDasharray={`${Math.max(0, Math.min(100, accuracy ?? 0))} 100`}
                    />
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center text-lg font-extrabold text-foreground tabular-nums">
                    {accuracy !== null ? `${accuracy}%` : '—'}
                  </span>
                </div>
                <div>
                  <p className="text-2xl font-extrabold text-foreground tabular-nums">
                    {result.correct}
                    <span className="text-base font-semibold text-muted-foreground">/{result.total}</span>
                  </p>
                  <p className="text-sm text-muted-foreground">{lang === 'vi' ? 'câu đúng' : 'correct'}</p>
                  <p className="sr-only">{rawScoreLine(result.correct, result.total, result.rawAccuracyPercent, lang)}</p>
                </div>
              </div>
              <dl className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-emerald-500/10 p-3">
                  <dt className="text-[11px] text-muted-foreground inline-flex items-center gap-1 justify-center">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" aria-hidden />
                    {lang === 'vi' ? 'Đúng' : 'Correct'}
                  </dt>
                  <dd className="text-xl font-extrabold text-foreground tabular-nums">{result.correct}</dd>
                </div>
                <div className="rounded-xl bg-rose-500/10 p-3">
                  <dt className="text-[11px] text-muted-foreground inline-flex items-center gap-1 justify-center">
                    <XCircle className="w-3.5 h-3.5 text-rose-600" aria-hidden />
                    {lang === 'vi' ? 'Sai' : 'Incorrect'}
                  </dt>
                  <dd className="text-xl font-extrabold text-foreground tabular-nums">{result.incorrect}</dd>
                </div>
                <div className="rounded-xl bg-amber-500/10 p-3">
                  <dt className="text-[11px] text-muted-foreground inline-flex items-center gap-1 justify-center">
                    <MinusCircle className="w-3.5 h-3.5 text-amber-600" aria-hidden />
                    {lang === 'vi' ? 'Bỏ trống' : 'Blank'}
                  </dt>
                  <dd className="text-xl font-extrabold text-foreground tabular-nums">{result.unanswered}</dd>
                </div>
              </dl>
              {typeof result.timeSpentSeconds === 'number' && (
                <p className="md:col-span-2 text-xs text-muted-foreground inline-flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" aria-hidden />
                  {lang === 'vi' ? 'Thời gian từ lúc bắt đầu đến khi nộp: ' : 'Elapsed from start to submission: '}
                  {formatDuration(result.timeSpentSeconds, lang)}
                  {typeof result.averageSecondsPerQuestion === 'number' &&
                    (lang === 'vi' ? ` · trung bình ${Math.round(result.averageSecondsPerQuestion)} giây/câu` : ` · ${Math.round(result.averageSecondsPerQuestion)} s per question`)}
                </p>
              )}
            </div>
          ) : result.skill === 'SPEAKING' ? (
            <p className="text-sm text-foreground">{lang === 'vi'
              ? 'Đã nộp bài luyện nói. Bản ghi đã được lưu; bài luyện này không có band IELTS chính thức.'
              : 'Speaking practice submitted. Recordings are saved; this practice has no official IELTS band.'}</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-foreground">
                {lang === 'vi'
                  ? `Bài viết đã được lưu: ${result.wordCount ?? 0} từ${result.minimumWords ? ` (tối thiểu ${result.minimumWords})` : ''}.`
                  : `Your response was saved: ${result.wordCount ?? 0} words${result.minimumWords ? ` (minimum ${result.minimumWords})` : ''}.`}
              </p>
              <p className="text-xs text-muted-foreground inline-flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
                {lang === 'vi'
                  ? 'Bài luyện viết không được chấm điểm và không được AI đánh giá.'
                  : 'Practice writing is not scored and was not evaluated by AI.'}
              </p>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {lang === 'vi'
              ? 'Đây là kết quả luyện tập theo phần, không phải điểm TOEIC / band IELTS chính thức và không được tính vào hồ sơ năng lực.'
              : 'This is a part-practice result — not an official TOEIC score / IELTS band, and not counted in the competency profile.'}
          </p>

          {submitted && (
            <div className="flex flex-wrap items-center gap-2">
              {review && (
                <a
                  href="#practice-review"
                  className="h-10 px-4 inline-flex items-center gap-1.5 rounded-xl border border-border text-sm font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ListChecks className="w-4 h-4" aria-hidden />
                  {lang === 'vi' ? 'Xem lại bài' : 'Review answers'}
                </a>
              )}
              <button
                type="button"
                onClick={practiceAgain}
                disabled={again}
                className="h-10 px-4 inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RotateCcw className="w-4 h-4" aria-hidden />
                {again ? (lang === 'vi' ? 'Đang tạo lần mới…' : 'Creating…') : lang === 'vi' ? 'Luyện lại phần này' : 'Practise this part again'}
              </button>
              <span className="text-[11px] text-muted-foreground">
                {lang === 'vi' ? 'Luyện lại tạo một lần làm mới; kết quả này vẫn được giữ nguyên.' : 'This creates a new attempt; this result stays unchanged.'}
              </span>
            </div>
          )}
          {againError && (
            <p role="alert" className="text-xs text-rose-700 dark:text-rose-300 bg-rose-500/10 rounded-lg p-2.5">
              {againError}
            </p>
          )}
        </div>
      </section>

      {/* REVIEW */}
      {speakingReview && <SpeakingResultReview speakingReview={speakingReview} lang={lang} responseOnly />}
      {review && result.skill !== 'SPEAKING' && (
        <section id="practice-review" className="space-y-4 scroll-mt-4" aria-labelledby="practice-review-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="practice-review-title" className="text-lg font-bold text-foreground">
              {lang === 'vi' ? 'Xem lại bài' : 'Review'}
            </h2>
            {objective && (
              <div role="radiogroup" aria-label={lang === 'vi' ? 'Lọc câu hỏi' : 'Filter questions'} className="flex flex-wrap gap-1.5">
                {(['ALL', 'INCORRECT', 'UNANSWERED', 'CORRECT'] as ReviewFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={filter === f}
                    onClick={() => setFilter(f)}
                    className={`h-8 px-3 rounded-full text-xs font-semibold border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      filter === f ? 'bg-foreground text-background border-foreground' : 'bg-background text-muted-foreground border-border hover:text-foreground'
                    }`}
                  >
                    {f === 'ALL'
                      ? lang === 'vi' ? 'Tất cả' : 'All'
                      : f === 'INCORRECT'
                      ? lang === 'vi' ? 'Sai' : 'Incorrect'
                      : f === 'UNANSWERED'
                      ? lang === 'vi' ? 'Bỏ trống' : 'Blank'
                      : lang === 'vi' ? 'Đúng' : 'Correct'}{' '}
                    <span className="tabular-nums opacity-80">({counts[f]})</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {allItems.length > 1 && (
            <nav className="flex flex-wrap gap-1.5" aria-label={lang === 'vi' ? 'Danh sách câu hỏi' : 'Questions'}>
              {allItems.map((it) => {
                const style = STATUS_STYLE[it.status] || STATUS_STYLE.NOT_SCORED;
                return (
                  <a
                    key={it.itemId}
                    href={`#review-${it.itemId}`}
                    data-review-status={it.status}
                    aria-label={`${lang === 'vi' ? 'Câu' : 'Question'} ${it.questionNumber ?? ''}: ${reviewStatusLabel(it.status, lang)}`}
                    className={`relative min-w-9 h-9 px-1.5 rounded-lg text-xs font-bold inline-flex items-center justify-center border tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${style.chip}`}
                  >
                    {it.questionNumber ?? '•'}
                    <span className="absolute -top-1.5 -right-1.5 bg-card rounded-full">{style.icon}</span>
                  </a>
                );
              })}
            </nav>
          )}

          {review.partInstructions && <p className="text-xs text-muted-foreground leading-relaxed">{review.partInstructions}</p>}

          {review.groups.map((g) => (
            <ReviewGroup key={g.groupId} group={g} attemptId={attemptId} lang={lang} visible={visible} />
          ))}
          {filter !== 'ALL' && counts[filter] === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">
              {lang === 'vi' ? 'Không có câu nào trong nhóm này.' : 'No questions in this group.'}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function ReviewGroup({
  group,
  attemptId,
  lang,
  visible,
}: {
  group: PracticeReviewGroupDto;
  attemptId: string;
  lang: 'vi' | 'en';
  visible: (it: PracticeReviewItemDto) => boolean;
}) {
  const items = group.items.filter(visible);
  if (items.length === 0) return null;
  const audio = group.stimuli.filter((s) => (s.kind || '').toUpperCase() === 'AUDIO');
  const shown = group.stimuli.filter((s) => (s.kind || '').toUpperCase() !== 'AUDIO');
  const split = shown.length > 0;

  return (
    <article className="rounded-2xl border border-border bg-card p-4 sm:p-5 space-y-4">
      <header className="space-y-1.5">
        {group.displayNumbering && (
          <span className="inline-flex px-2.5 py-1 rounded-md bg-primary/10 text-primary font-bold text-xs">
            {lang === 'vi' ? 'Câu' : 'Questions'} {group.displayNumbering}
          </span>
        )}
        {Array.isArray(group.presentation?.instructions) &&
          group.presentation!.instructions!.map((line, i) => (
            <p key={i} className="text-xs text-foreground/90 leading-relaxed">
              {line}
            </p>
          ))}
        {audio.map((s) => (
          <ReviewAudio key={s.id} attemptId={attemptId} stimulus={s} lang={lang} />
        ))}
      </header>
      <div className={split ? 'grid grid-cols-1 lg:grid-cols-2 gap-4 items-start' : ''}>
        {split && (
          <div className="lg:sticky lg:top-4 max-h-[70dvh] overflow-y-auto rounded-xl border border-border/70 bg-background p-4">
            <StimulusRenderer stimuli={shown} attemptId={attemptId} />
          </div>
        )}
        <ol className="space-y-3">
          {items.map((it) => (
            <ReviewItem key={it.itemId} item={it} lang={lang} />
          ))}
        </ol>
      </div>
    </article>
  );
}

function ReviewItem({ item: it, lang }: { item: PracticeReviewItemDto; lang: 'vi' | 'en' }) {
  const style = STATUS_STYLE[it.status] || STATUS_STYLE.NOT_SCORED;
  const options = itemOptions(it as any);
  const learner = formatAnswer(it.learnerAnswer);
  const learnerIds = Array.isArray(it.learnerAnswer) ? it.learnerAnswer.map(String) : learner ? [learner] : [];
  const showOptionList = options.length > 0 && it.status !== 'NOT_SCORED';

  return (
    <li id={`review-${it.itemId}`} data-review-status={it.status} className="rounded-xl border border-border/70 p-3 sm:p-4 space-y-2.5 scroll-mt-4">
      <div className="flex items-start gap-2.5">
        {it.questionNumber !== undefined && (
          <span className="shrink-0 min-w-8 h-8 px-1.5 rounded-lg bg-muted text-foreground font-bold text-sm inline-flex items-center justify-center tabular-nums">
            {it.questionNumber}
          </span>
        )}
        <div className="flex-1 min-w-0 space-y-1">
          {it.prompt && <p className="text-[15px] text-foreground leading-relaxed">{it.prompt}</p>}
          <span className={`inline-flex items-center gap-1 h-6 px-2 rounded-full border text-[11px] font-bold ${style.chip}`}>
            {style.icon}
            {reviewStatusLabel(it.status, lang)}
          </span>
        </div>
      </div>

      {showOptionList ? (
        <ul className="space-y-1.5 sm:pl-10" aria-label={lang === 'vi' ? 'Các lựa chọn' : 'Options'}>
          {options.map((o) => {
            const correct = it.correctAnswerAvailable && it.correctAnswers.includes(o.id);
            const chosen = learnerIds.includes(o.id);
            return (
              <li
                key={o.id}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm ${
                  correct ? 'border-emerald-500/50 bg-emerald-500/10' : chosen ? 'border-rose-500/50 bg-rose-500/10' : 'border-border'
                }`}
              >
                <span className="shrink-0 w-6 h-6 rounded-full bg-muted text-xs font-bold inline-flex items-center justify-center">{o.id}</span>
                <span className="flex-1 min-w-0">{formatOptionCleanText(o.id, o.text) || `(${o.id})`}</span>
                {chosen && (
                  <span className="shrink-0 text-[11px] font-semibold text-foreground/80">{lang === 'vi' ? 'Bạn chọn' : 'Your answer'}</span>
                )}
                {correct && <CheckCircle2 className="shrink-0 w-4 h-4 text-emerald-600" aria-label={lang === 'vi' ? 'Đáp án đúng' : 'Correct answer'} />}
                {chosen && !correct && <XCircle className="shrink-0 w-4 h-4 text-rose-600" aria-hidden />}
              </li>
            );
          })}
        </ul>
      ) : it.status !== 'NOT_SCORED' ? (
        <dl className="sm:pl-10 space-y-1 text-sm">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">{lang === 'vi' ? 'Bạn trả lời:' : 'Your answer:'}</dt>
            <dd className={`font-semibold ${it.status === 'INCORRECT' ? 'text-rose-700 dark:text-rose-300' : 'text-foreground'}`}>
              {learner ? answerText(it, learner) : lang === 'vi' ? '(bỏ trống)' : '(blank)'}
            </dd>
          </div>
          {it.correctAnswerAvailable && (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">{lang === 'vi' ? 'Đáp án:' : 'Answer:'}</dt>
              <dd className="font-semibold text-emerald-700 dark:text-emerald-300">{it.correctAnswers.map((a) => answerText(it, a)).join(' / ')}</dd>
            </div>
          )}
        </dl>
      ) : null}

      {it.status === 'NOT_SCORED' && (
        <div className="space-y-1.5">
          <div className="text-sm whitespace-pre-wrap p-3 rounded-lg bg-muted/40 max-h-96 overflow-y-auto">
            {typeof it.learnerAnswer === 'string' && it.learnerAnswer ? it.learnerAnswer : lang === 'vi' ? '(Chưa viết)' : '(Empty)'}
          </div>
          {typeof it.wordCount === 'number' && (
            <p className="text-[11px] text-muted-foreground">
              {lang === 'vi' ? `${it.wordCount} từ` : `${it.wordCount} words`}
              {it.minimumWords ? (lang === 'vi' ? ` / tối thiểu ${it.minimumWords}` : ` / minimum ${it.minimumWords}`) : ''}
            </p>
          )}
        </div>
      )}

      {it.explanationAvailable && it.explanation && (
        <p className="sm:pl-10 text-sm text-foreground/90 leading-relaxed">{it.explanation}</p>
      )}
    </li>
  );
}

export default PracticeResultReview;
