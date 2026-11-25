'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import {
  ArrowRight, Check, ChevronLeft, ChevronRight, CircleHelp, ClipboardCheck, Info, Loader2, Minus, RotateCcw, SearchX, Send, TriangleAlert,
} from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { grammarApi } from '@/services/grammarApi';
import { findTopic, useGrammarCatalog, useGrammarMe, useGrammarUserId } from '@/hooks/useGrammar';
import {
  LEVELS, apiFailure, cx, formatDate, isRight, levelLabel, masteryLabel, outcomeLabel, type Mastery,
} from '@/lib/grammar/format';
import { plainInline } from '@/lib/grammar/inline';
import type { Answer, Catalog, CheckKind, CheckResult, CheckView, Exercise, Level } from '@/types/grammar';
import { ExerciseCard } from './exercises/ExerciseCard';
import { completeness, sendable, verdictOfItem } from './exercises/answer';
import { OUTCOME_STATE, MarkIcon } from './exercises/shared';
import styles from './grammar.module.css';
import v from './subviews.module.css';
import x from './exercises/exercises.module.css';

const storageKey = (userId: string, checkId: string) => `ec_grammar_check:v1:${userId}:${checkId}`;

function readStored(key: string): Record<string, Answer> {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { answers?: Record<string, Answer> } | null;
    return parsed && typeof parsed.answers === 'object' && parsed.answers ? parsed.answers : {};
  } catch {
    return {};
  }
}
function writeStored(key: string, answers: Record<string, Answer>) {
  try { window.sessionStorage.setItem(key, JSON.stringify({ answers, at: Date.now() })); } catch { /* storage may be blocked: the answers live on in this page */ }
}
function dropStored(key: string) {
  try { window.sessionStorage.removeItem(key); } catch { /* nothing to drop */ }
}

const KIND_TITLE: Record<CheckKind, { vi: string; en: string }> = {
  TOPIC: { vi: 'Kiểm tra chủ đề', en: 'Topic check' },
  REVIEW: { vi: 'Ôn lại chủ đề', en: 'Topic review' },
  DIAGNOSTIC: { vi: 'Bài kiểm tra xếp mức ngắn', en: 'Short placement check' },
  DOMAIN: { vi: 'Kiểm tra theo mảng kiến thức', en: 'Check by area' },
  IELTS: { vi: 'Luyện trộn ngữ pháp cho IELTS', en: 'Mixed grammar practice for IELTS' },
  TOEIC: { vi: 'Luyện trộn ngữ pháp cho TOEIC', en: 'Mixed grammar practice for TOEIC' },
};

function scopeTitle(catalog: Catalog | undefined, check: CheckView, vi: boolean): string | null {
  if (!check.scope) return null;
  if (check.kind === 'TOPIC' || check.kind === 'REVIEW') {
    const t = findTopic(catalog, check.scope)?.topic;
    return t ? (vi ? t.title.vi : t.title.en) : null;
  }
  if (check.kind === 'DOMAIN') {
    const d = catalog?.domains.find((dom) => dom.id === check.scope);
    return d ? (vi ? d.title.vi : d.title.en) : null;
  }
  return null;
}

/* ═══ the page ═══════════════════════════════════════════════════════════════════════════════════════════════════════ */
export function CheckRunner({ checkId }: { checkId: string }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const userId = useGrammarUserId();
  const { data: catalog } = useGrammarCatalog();
  const { mutate: mutateMe } = useGrammarMe();
  const { data: check, error, isLoading, mutate } = useSWR<CheckView>(
    userId ? ['grammar-check', userId, checkId] : null,
    () => grammarApi.check(checkId),
    { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 5_000 },
  );

  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [restored, setRestored] = useState(false);
  const [at, setAt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const key = userId ? storageKey(userId, checkId) : null;

  /* the answers of a running check survive a refresh in this tab (sessionStorage, keyed by check and account) */
  useEffect(() => {
    if (!check || !key || restored) return;
    if (!check.submitted) {
      const ids = new Set(check.exercises.map((e) => e.id));
      const saved = readStored(key);
      const kept: Record<string, Answer> = {};
      for (const [id, a] of Object.entries(saved)) if (ids.has(id)) kept[id] = a;
      setAnswers(kept);
    }
    setRestored(true);
  }, [check, key, restored]);
  useEffect(() => {
    if (!key || !restored || !check || check.submitted) return;
    if (Object.keys(answers).length) writeStored(key, answers); else dropStored(key);
  }, [answers, key, restored, check]);
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);

  const exercises = check?.exercises ?? [];
  const change = useCallback((id: string, next: Answer | null) => {
    setAnswers((prev) => {
      const copy = { ...prev };
      if (next) copy[id] = next; else delete copy[id];
      return copy;
    });
    setConfirming(false);
    setSubmitError(null);
  }, []);

  const counts = useMemo(() => {
    let none = 0;
    let part = 0;
    for (const e of exercises) {
      const c = completeness(e, answers[e.id]);
      if (c === 'none') none += 1;
      else if (c === 'partial') part += 1;
    }
    return { none, part, answered: exercises.length - none };
  }, [exercises, answers]);

  const doSubmit = async () => {
    if (!check || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload: Record<string, Answer> = {};
      for (const e of check.exercises) {
        const a = sendable(e, answers[e.id]);
        if (a) payload[e.id] = a;
      }
      const result = await grammarApi.submitCheck(check.id, payload);
      if (key) dropStored(key);
      setConfirming(false);
      await mutate({ ...check, submitted: true, result }, { revalidate: false });
      void mutateMe();
      topRef.current?.scrollIntoView({ block: 'start' });
    } catch (err) {
      if (apiFailure(err).status === 409) {
        /* already submitted (a repeated press, or another tab): show what the server holds */
        const fresh = await mutate();
        if (fresh?.submitted) { if (key) dropStored(key); void mutateMe(); return; }
      }
      setSubmitError(vi
        ? 'Chưa nộp được bài. Câu trả lời của bạn vẫn được giữ, hãy bấm nộp lại.'
        : 'The check was not submitted. Your answers are kept; press submit again.');
    } finally {
      setSubmitting(false);
    }
  };
  const requestSubmit = () => {
    if (counts.none > 0 || counts.part > 0) { setConfirming(true); return; }
    void doSubmit();
  };

  /* ── states ── */
  if (!userId || (isLoading && !check)) return <RunnerSkeleton />;
  if (error || !check) {
    const missing = apiFailure(error).status === 404;
    return (
      <div className={styles.stateBox} role={missing ? 'status' : 'alert'}>
        <span className={styles.stateIcon} aria-hidden="true">{missing ? <SearchX /> : <TriangleAlert />}</span>
        <h1 className={styles.stateTitle}>{missing ? (vi ? 'Không tìm thấy bài kiểm tra này' : 'This check was not found') : (vi ? 'Chưa tải được bài kiểm tra' : 'The check could not be loaded')}</h1>
        <p className={styles.stateText}>
          {missing
            ? (vi ? 'Bài này có thể thuộc tài khoản khác hoặc đã không còn. Bạn có thể bắt đầu một bài mới từ trang chủ đề.' : 'It may belong to another account or no longer exist. You can start a new one from a topic page.')
            : (vi ? 'Kết nối bị gián đoạn. Câu trả lời bạn đã chọn trong tab này vẫn được giữ.' : 'The connection was interrupted. The answers you gave in this tab are kept.')}
        </p>
        <div className={styles.stateActions}>
          {missing ? null : <button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={() => { void mutate(); }}><RotateCcw aria-hidden="true" />{vi ? 'Thử lại' : 'Try again'}</button>}
          <Link href="/grammar" className={cx(styles.btn, styles.btnSoft)}>{vi ? 'Về lộ trình' : 'Back to the path'}</Link>
        </div>
      </div>
    );
  }

  const title = vi ? KIND_TITLE[check.kind].vi : KIND_TITLE[check.kind].en;
  const scope = scopeTitle(catalog, check, vi);

  if (check.submitted) {
    return (
      <div className={cx(x.page, v.view, v.focusPage)} ref={topRef}>
        <PageHead eyebrow={vi ? 'Kết quả' : 'Result'} title={scope ? `${title}: ${scope}` : title} vi={vi} />
        {check.result ? (
          <ResultView check={check} result={check.result} answers={answers} catalog={catalog} vi={vi} />
        ) : (
          <div className={styles.stateBox} role="status">
            <span className={styles.stateIcon} aria-hidden="true"><Info /></span>
            <h2 className={styles.stateTitle}>{vi ? 'Bài này đã được nộp' : 'This check was submitted'}</h2>
            <p className={styles.stateText}>{vi ? 'Chưa đọc được kết quả của bài. Bạn có thể làm một bài mới.' : 'The result could not be read. You can take a new one.'}</p>
            <div className={styles.stateActions}><Link href="/grammar" className={cx(styles.btn, styles.btnSoft)}>{vi ? 'Về lộ trình' : 'Back to the path'}</Link></div>
          </div>
        )}
      </div>
    );
  }

  if (!exercises.length) {
    return (
      <div className={styles.stateBox} role="status">
        <span className={styles.stateIcon} aria-hidden="true"><Info /></span>
        <h1 className={styles.stateTitle}>{vi ? 'Bài kiểm tra này chưa có câu hỏi' : 'This check has no questions'}</h1>
        <div className={styles.stateActions}><Link href="/grammar" className={cx(styles.btn, styles.btnSoft)}>{vi ? 'Về lộ trình' : 'Back to the path'}</Link></div>
      </div>
    );
  }

  const index = Math.min(at, exercises.length - 1);
  const ex = exercises[index];
  const last = index === exercises.length - 1;
  const intro = check.kind === 'DIAGNOSTIC'
    ? (vi ? 'Bài ngắn, chỉ để gợi ý mức bắt đầu. Kết quả là ước lượng, không phải chứng nhận trình độ.' : 'A short check, only to suggest where to start. The result is an estimate, not a certificate of level.')
    : (vi ? 'Không tính giờ. Bạn có thể đi lại giữa các câu và sửa câu trả lời trước khi nộp. Đáp án chỉ hiện sau khi nộp bài.' : 'No timer. You can move between questions and change answers before you submit. Answers appear only after you submit.');

  return (
    <div className={cx(x.page, v.view, v.focusPage)} ref={topRef}>
      <PageHead eyebrow={vi ? 'Đang làm bài' : 'In progress'} title={scope ? `${title}: ${scope}` : title} lead={intro} vi={vi} />

      <nav className={cx(x.runnerBar, v.runBar)} aria-label={vi ? 'Các câu trong bài' : 'Questions in this check'}>
        <p className={x.position} aria-live="polite">
          <strong>{index + 1}</strong>
          <span>{` / ${exercises.length}`}</span>
          <span className={x.positionNote}>{vi ? `${counts.answered} câu đã có trả lời` : `${counts.answered} answered`}</span>
        </p>
        <progress className={v.progress} value={counts.answered} max={exercises.length} aria-label={vi ? 'Số câu đã trả lời' : 'Answered questions'} />
        <ol className={x.dots}>
          {exercises.map((e, i) => {
            const c = completeness(e, answers[e.id]);
            return (
              <li key={e.id}>
                <button
                  type="button"
                  className={x.dot}
                  data-at={i === index ? 'true' : 'false'}
                  data-fill={c}
                  aria-current={i === index ? 'step' : undefined}
                  aria-label={vi
                    ? `Câu ${i + 1}: ${c === 'full' ? 'đã trả lời' : c === 'partial' ? 'mới trả lời một phần' : 'chưa trả lời'}`
                    : `Question ${i + 1}: ${c === 'full' ? 'answered' : c === 'partial' ? 'partly answered' : 'not answered'}`}
                  onClick={() => { setAt(i); setConfirming(false); }}
                >
                  {c === 'full' ? <Check aria-hidden="true" /> : c === 'partial' ? <Minus aria-hidden="true" /> : <span aria-hidden="true">{i + 1}</span>}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className={v.exerciseStage}>
      <ExerciseCard
        key={ex.id}
        exercise={ex}
        mode="check"
        number={index + 1}
        value={answers[ex.id] ?? null}
        onChange={(a) => change(ex.id, a)}
      />
      </div>

      {confirming ? (
        <div ref={confirmRef} tabIndex={-1} className={x.confirm} role="alertdialog" aria-labelledby="chk-confirm-t" aria-describedby="chk-confirm-d">
          <h2 id="chk-confirm-t" className={x.confirmTitle}>{vi ? 'Nộp bài bây giờ?' : 'Submit now?'}</h2>
          <p id="chk-confirm-d" className={x.confirmText}>
            {counts.none > 0
              ? (vi ? `Bạn còn ${counts.none} câu chưa trả lời. ` : `You have ${counts.none} unanswered. `)
              : ''}
            {counts.part > 0
              ? (vi ? `${counts.part} câu mới trả lời một phần. ` : `${counts.part} only partly answered. `)
              : ''}
            {vi ? 'Câu chưa trả lời sẽ được tính là chưa đúng. Sau khi nộp, bạn không sửa được nữa.' : 'An unanswered question counts as not right. After you submit you cannot change anything.'}
          </p>
          <div className={x.actionRow}>
            <button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={() => { void doSubmit(); }} disabled={submitting}>
              {submitting ? <Loader2 className={styles.spin} aria-hidden="true" /> : <Send aria-hidden="true" />}
              {vi ? 'Nộp bài luôn' : 'Submit anyway'}
            </button>
            <button type="button" className={cx(styles.btn, styles.btnQuiet)} onClick={() => setConfirming(false)}>{vi ? 'Quay lại làm tiếp' : 'Keep working'}</button>
          </div>
        </div>
      ) : null}
      {submitError ? <p className={x.failLine} role="alert">{submitError}</p> : null}

      <div className={cx(x.runnerNav, v.runActions)}>
        <button type="button" className={cx(styles.btn, styles.btnQuiet)} onClick={() => { setAt(Math.max(0, index - 1)); setConfirming(false); }} disabled={index === 0}>
          <ChevronLeft aria-hidden="true" />{vi ? 'Câu trước' : 'Previous'}
        </button>
        {!last ? (
          <button type="button" className={cx(styles.btn, styles.btnSoft)} onClick={() => { setAt(index + 1); setConfirming(false); }}>
            {vi ? 'Câu sau' : 'Next'}<ChevronRight aria-hidden="true" />
          </button>
        ) : null}
        <button type="button" className={cx(styles.btn, last ? styles.btnPrimary : styles.btnQuiet, x.submitBtn)} onClick={requestSubmit} disabled={submitting}>
          {submitting ? <Loader2 className={styles.spin} aria-hidden="true" /> : <ClipboardCheck aria-hidden="true" />}
          {vi ? 'Nộp bài' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

function PageHead({ eyebrow, title, lead, vi }: { eyebrow: string; title: string; lead?: string; vi: boolean }) {
  return (
    <header className={cx(x.pageHead, v.focusHead)}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1 className={x.pageTitle}>{title}</h1>
      {lead ? <p className={x.pageLead}>{lead}</p> : null}
      <Link href="/grammar" className={x.backLink}><ChevronLeft aria-hidden="true" />{vi ? 'Về lộ trình' : 'Back to the path'}</Link>
    </header>
  );
}

function RunnerSkeleton() {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  return (
    <div className={cx(x.page, v.view, v.focusPage)} aria-busy="true" aria-label={vi ? 'Đang tải bài kiểm tra' : 'Loading the check'}>
      <div className={cx(x.pageHead, v.focusHead)}>
        <span className={cx(styles.skel, styles.skelLine)} style={{ width: '8rem' }} />
        <span className={cx(styles.skel, styles.skelTitle)} />
        <span className={cx(styles.skel, styles.skelLine)} style={{ width: '70%' }} />
      </div>
      <div className={x.card}>
        <span className={cx(styles.skel, styles.skelLine)} style={{ width: '60%' }} />
        <span className={cx(styles.skel, styles.skelLine)} style={{ width: '85%', marginTop: '0.9rem' }} />
        <span className={cx(styles.skel, styles.skelLine)} style={{ width: '75%', marginTop: '0.6rem' }} />
        <span className={cx(styles.skel, styles.skelBtn)} style={{ marginTop: '1.2rem' }} />
      </div>
      <span className={styles.srOnly}>{vi ? 'Đang tải…' : 'Loading…'}</span>
    </div>
  );
}

/* ═══ the result ═════════════════════════════════════════════════════════════════════════════════════════════════════ */
interface ResultProps { check: CheckView; result: CheckResult; answers: Record<string, Answer>; catalog: Catalog | undefined; vi: boolean }

function ResultView({ check, result, answers, catalog, vi }: ResultProps) {
  const { mutate: mutateMe } = useGrammarMe();
  const byId = useMemo(() => new Map(check.exercises.map((e) => [e.id, e])), [check.exercises]);
  const unrecognized = result.items.filter((i) => i.outcome === 'UNRECOGNIZED').length;
  const selfReview = result.items.filter((i) => i.outcome === 'SELF_REVIEW').length;
  const unanswered = result.items.filter((i) => i.reveal.unanswered).length;
  const wrongItems = result.items.filter((i) => (i.outcome === 'WRONG' || i.outcome === 'PARTIAL'));
  const mastery = result.mastery as Mastery | null;
  const hasScore = result.scoredItems > 0;
  const topicKind = check.kind === 'TOPIC' || check.kind === 'REVIEW';
  const practiceKind = check.kind === 'DOMAIN' || check.kind === 'IELTS' || check.kind === 'TOEIC';

  const toStudy = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of wrongItems) counts.set(i.topic, (counts.get(i.topic) ?? 0) + 1);
    return Array.from(counts.entries()).map(([slug, n]) => ({ slug, n, title: findTopic(catalog, slug)?.topic.title })).sort((a, b) => b.n - a.n);
  }, [wrongItems, catalog]);

  const needsLesson = mastery === 'NOT_YET' || mastery === 'NEEDS_REVIEW' || mastery === 'INSUFFICIENT';
  const lessonLink = topicKind && !!check.scope && needsLesson && !toStudy.some((s) => s.slug === check.scope);
  const showStudy = lessonLink || toStudy.length > 0;

  const [again, setAgain] = useState(false);
  const [againError, setAgainError] = useState<string | null>(null);
  const router = useRouter();
  const startAgain = async () => {
    if (again) return;
    setAgain(true);
    setAgainError(null);
    try {
      const view = await grammarApi.startCheck(check.kind, check.scope ?? undefined);
      void mutateMe();
      router.push(`/grammar/check/${encodeURIComponent(view.id)}`);
    } catch (err) {
      const f = apiFailure(err);
      setAgainError(f.code === 'NOT_ENOUGH_ITEMS'
        ? (vi ? 'Chưa đủ câu hỏi để tạo bài mới cho chủ đề này.' : 'There are not enough questions for a new check on this topic yet.')
        : (vi ? 'Chưa tạo được bài mới. Hãy thử lại.' : 'A new check could not be created. Please try again.'));
      setAgain(false);
    }
  };

  return (
    <div className={x.result}>
      <section className={x.hero} aria-labelledby="res-h" data-mastery={mastery ?? 'none'}>
        <div className={x.heroScore}>
          <p className={x.scoreNum} aria-label={hasScore ? `${result.pct}%` : (vi ? 'Chưa có điểm' : 'No score')}>
            {hasScore ? <>{result.pct}<span>%</span></> : '—'}
          </p>
          <p className={x.scoreLabel}>{hasScore ? (vi ? 'đúng trong các câu được chấm' : 'right among the scored questions') : (vi ? 'chưa có câu nào được chấm' : 'no question could be scored')}</p>
        </div>
        <div className={x.heroBody}>
          <h2 id="res-h" className={x.heroTitle}>{vi ? 'Kết quả của bạn' : 'Your result'}</h2>
          <p className={x.heroLine}>
            {vi
              ? `${result.scoredItems} câu được chấm${result.unscoredItems ? `, ${result.unscoredItems} câu không tính` : ''}.`
              : `${result.scoredItems} scored${result.unscoredItems ? `, ${result.unscoredItems} not counted` : ''}.`}
          </p>
          {result.unscoredItems > 0 ? (
            <p className={x.heroFine}>
              {[
                unrecognized ? (vi ? `${unrecognized} câu hệ thống chưa nhận ra (câu của bạn có thể vẫn đúng, nên không bị tính là sai)` : `${unrecognized} not recognised (your sentence may be right, so it is not counted as wrong)`) : null,
                selfReview ? (vi ? `${selfReview} câu tự đối chiếu (không chấm điểm)` : `${selfReview} for self-review (not graded)`) : null,
              ].filter(Boolean).join('; ')}.
            </p>
          ) : null}
          {unanswered > 0 ? <p className={x.heroFine}>{vi ? `${unanswered} câu chưa trả lời được tính là chưa đúng.` : `${unanswered} unanswered counted as not right.`}</p> : null}

          {topicKind && mastery ? (
            <div className={x.mastery} data-mastery={mastery}>
              <span className={x.masteryIcon}>
                {mastery === 'MASTERED' || mastery === 'KEPT' ? <Check aria-hidden="true" /> : mastery === 'INSUFFICIENT' ? <Minus aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
              </span>
              <div>
                <p className={x.masteryTitle}>{masteryLabel(mastery, vi)}</p>
                {result.nextReviewAt ? (
                  <p className={x.masteryText}>
                    {mastery === 'NEEDS_REVIEW'
                      ? (vi ? `Nên ôn lại vào ${formatDate(result.nextReviewAt, vi)}.` : `Review again on ${formatDate(result.nextReviewAt, vi)}.`)
                      : (vi ? `Lần ôn tiếp theo: ${formatDate(result.nextReviewAt, vi)}.` : `Next review: ${formatDate(result.nextReviewAt, vi)}.`)}
                  </p>
                ) : null}
                {mastery === 'INSUFFICIENT' ? (
                  <p className={x.masteryText}>{(result.productionRequired ?? 0) > (result.productionScored ?? 0)
                    ? (vi ? 'Chưa có đủ câu vận dụng cấu trúc được chấm để kết luận. Câu ngoài danh sách đáp án có thể vẫn đúng; hãy đối chiếu hoặc gửi góp ý về đáp án.' : 'There is not enough scored construction evidence yet. An unrecognised response may still be valid; compare it with the model or report an alternative.')
                    : (vi ? 'Số câu được chấm còn ít, nên chưa kết luận được. Hãy luyện thêm rồi kiểm tra lại.' : 'Too few questions were scored to conclude. Practise a little more, then check again.')}</p>
                ) : null}
                {(result.productionRequired ?? 0) > 0 ? (
                  <p className={x.masteryText}>{vi
                    ? `Phần vận dụng cấu trúc: ${result.productionCorrect ?? 0} câu đúng; cần ít nhất ${result.productionRequired}. Phần này gồm điền cụm, viết lại câu hoặc sắp xếp từ.`
                    : `Construction practice: ${result.productionCorrect ?? 0} correct; at least ${result.productionRequired} required. This covers completion, rewriting or word ordering.`}</p>
                ) : null}
                {mastery === 'NOT_YET' ? (
                  <p className={x.masteryText}>{vi ? 'Kết quả lần này chưa được ghi là đã nắm. Xem lại bài học và các câu chưa đúng bên dưới, rồi thử lại khi bạn sẵn sàng.' : 'This time is not recorded as mastered. Look at the lesson and the questions below, then try again when you are ready.'}</p>
                ) : null}
              </div>
            </div>
          ) : null}

          {practiceKind ? (
            <p className={x.disclaimer}><Info aria-hidden="true" />{vi ? 'Đây là kết quả luyện tập, không quy đổi thành điểm IELTS hay TOEIC.' : 'This is a practice result. It is not converted into an IELTS or TOEIC score.'}</p>
          ) : null}
        </div>
      </section>

      {check.kind === 'DIAGNOSTIC' ? <DiagnosticView result={result} vi={vi} /> : null}

      {showStudy ? (
        <section className={x.study} aria-labelledby="res-study">
          <h2 id="res-study" className={x.sectionH}>{vi ? 'Nên xem lại' : 'Worth another look'}</h2>
          <ul className={x.studyList}>
            {lessonLink && check.scope ? (
              <li><Link href={`/grammar/topics/${encodeURIComponent(check.scope)}`} className={x.studyLink}><span>{vi ? 'Đọc lại bài học của chủ đề này' : 'Read this topic’s lesson again'}</span><ArrowRight aria-hidden="true" /></Link></li>
            ) : null}
            {toStudy.map((s) => (
              <li key={s.slug}>
                <Link href={`/grammar/topics/${encodeURIComponent(s.slug)}`} className={x.studyLink}>
                  <span>{s.title ? (vi ? s.title.vi : s.title.en) : s.slug}<small>{vi ? `${s.n} câu cần xem lại` : `${s.n} to look at`}</small></span>
                  <ArrowRight aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="res-items" className={x.reviewSection}>
        <div className={x.sectionRow}>
          <h2 id="res-items" className={x.sectionH}>{vi ? 'Xem lại từng câu' : 'Review each question'}</h2>
          <p className={x.pageLead}>{vi ? 'Mở từng câu để xem câu trả lời của bạn, lý do của từng lựa chọn và giải thích. Các câu chưa đúng đã được mở sẵn.' : 'Open a question to see your answer, the reason for each choice and the explanation. Questions that were not right are already open.'}</p>
        </div>
        <ol className={x.reviewList}>
          {result.items.map((item, i) => {
            const ex: Exercise | undefined = byId.get(item.exerciseId);
            if (!ex) return (
              <li key={item.exerciseId} className={x.reviewItem}>
                <p className={x.reviewPrompt}>{i + 1}. {outcomeLabel(item.outcome, vi)}</p>
                <p>{item.explain}</p>
                <p className={x.pageLead}>{vi ? 'Bài cũ này không lưu nguyên câu hỏi và câu trả lời; kết quả gốc vẫn được giữ.' : 'This older check did not save its question and answer; the original result is preserved.'}</p>
              </li>
            );
            const state = OUTCOME_STATE[item.outcome];
            const word = item.reveal.unanswered ? (vi ? 'Chưa trả lời' : 'Not answered') : outcomeLabel(item.outcome, vi);
            return (
              <li key={item.exerciseId}>
                <details className={x.reviewItem} data-state={item.reveal.unanswered ? 'neutral' : state} open={!isRight(item.outcome) && item.outcome !== 'SELF_REVIEW'}>
                  <summary className={x.reviewSummary}>
                    <span className={x.reviewNum}>{i + 1}</span>
                    <span className={x.reviewWord}><MarkIcon state={item.reveal.unanswered ? 'neutral' : state} />{word}</span>
                    <span className={x.reviewPrompt}>{plainInline(ex.prompt)}</span>
                  </summary>
                  <div className={x.reviewBody}>
                    <ExerciseCard exercise={ex} mode="check" topic={item.topic} value={item.answer !== undefined ? item.answer : answers[ex.id] ?? null} verdict={verdictOfItem(item)} />
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
      </section>

      <div className={x.resultActions}>
        <Link href="/grammar" className={cx(styles.btn, styles.btnSoft)}>{vi ? 'Về lộ trình' : 'Back to the path'}</Link>
        {wrongItems.length ? <Link href="/grammar/practice?kind=mistakes" className={cx(styles.btn, styles.btnSoft)}><CircleHelp aria-hidden="true" />{vi ? 'Luyện lại những câu hay sai' : 'Practise what you got wrong'}</Link> : null}
        {topicKind && check.scope ? (
          <>
            <Link href={`/grammar/topics/${encodeURIComponent(check.scope)}`} className={cx(styles.btn, styles.btnSoft)}>{vi ? 'Mở bài học' : 'Open the lesson'}</Link>
            <button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={() => { void startAgain(); }} disabled={again}>
              {again ? <Loader2 className={styles.spin} aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}{vi ? 'Làm bài kiểm tra mới' : 'Take a new check'}
            </button>
          </>
        ) : null}
      </div>
      {againError ? <p className={x.failLine} role="alert">{againError}</p> : null}
    </div>
  );
}

/* ═══ the placement result ═══════════════════════════════════════════════════════════════════════════════════════════ */
function DiagnosticView({ result, vi }: { result: CheckResult; vi: boolean }) {
  const { mutate: mutateMe } = useGrammarMe();
  const [open, setOpen] = useState(!result.enoughEvidence);
  const [level, setLevel] = useState<Level>(result.suggestedLevel ?? 'A1');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Level | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await grammarApi.setLevel(level);
      setSaved(level);
      void mutateMe();
    } catch {
      setError(vi ? 'Chưa lưu được mức. Hãy thử lại.' : 'The level was not saved. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={x.diag} aria-labelledby="diag-h">
      <h2 id="diag-h" className={x.sectionH}>{vi ? 'Mức bắt đầu' : 'Where to start'}</h2>
      {result.levels.length ? (
        <ul className={x.bars} aria-label={vi ? 'Kết quả theo từng mức' : 'Result by level'}>
          {result.levels.map((l) => (
            <li key={l.level} className={x.barRow}>
              <span className={x.barLevel}>{levelLabel(l.level)}</span>
              <span className={x.barTrack} aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, l.pct))}%` }} /></span>
              <span className={x.barText}>{vi ? `${l.pct}% · ${l.scored} câu` : `${l.pct}% · ${l.scored} q.`}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={x.suggest}>
        {result.suggestedLevel ? (
          <p className={x.suggestLine}>
            <span>{vi ? 'Gợi ý bắt đầu' : 'Suggested start'}</span>
            <strong>{levelLabel(result.suggestedLevel)}</strong>
          </p>
        ) : null}
        <p className={x.heroFine}>
          {vi ? 'Chỉ là ước lượng từ một bài ngắn. ' : 'Only an estimate from one short check. '}
          {result.enoughEvidence
            ? (vi ? 'Mức này đã được lưu làm điểm bắt đầu của bạn; bạn đổi được bất cứ lúc nào.' : 'This level was saved as your starting point; you can change it any time.')
            : (vi ? 'Bài này có quá ít câu được chấm nên mức chưa được lưu. Hãy chọn mức bạn muốn bắt đầu.' : 'Too few questions were scored, so no level was saved. Choose where you want to start.')}
        </p>
        {!open ? (
          <button type="button" className={cx(styles.btn, styles.btnQuiet, styles.btnSm)} onClick={() => setOpen(true)}>{vi ? 'Chọn mức khác' : 'Choose another level'}</button>
        ) : (
          <div className={x.levelPick}>
            <label className={styles.fieldLabel} htmlFor="diag-level">{vi ? 'Mức bắt đầu của bạn' : 'Your starting level'}</label>
            <div className={x.levelRow}>
              <select id="diag-level" className={cx(styles.input, x.levelSelect)} value={level} onChange={(e) => { setLevel(e.target.value as Level); setSaved(null); }}>
                {LEVELS.map((l) => <option key={l} value={l}>{levelLabel(l)}</option>)}
              </select>
              <button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={() => { void save(); }} disabled={saving}>
                {saving ? <Loader2 className={styles.spin} aria-hidden="true" /> : null}{vi ? 'Dùng mức này' : 'Use this level'}
              </button>
            </div>
            {saved ? <p className={x.thanks} role="status"><Check aria-hidden="true" />{vi ? `Đã lưu: bạn bắt đầu từ mức ${levelLabel(saved)}.` : `Saved: you start at ${levelLabel(saved)}.`}</p> : null}
            {error ? <p className={x.failLine} role="alert">{error}</p> : null}
          </div>
        )}
      </div>
    </section>
  );
}
