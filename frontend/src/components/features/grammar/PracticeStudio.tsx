'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, CircleHelp, Dumbbell, Loader2, Plus, RotateCcw, SearchX, SkipForward, TriangleAlert } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { grammarApi } from '@/services/grammarApi';
import { useGrammarCatalog, useGrammarMe } from '@/hooks/useGrammar';
import { LEVELS, apiFailure, cx, isRight, levelLabel } from '@/lib/grammar/format';
import type { Exercise, Outcome, PracticeSet, Verdict } from '@/types/grammar';
import { ExerciseCard } from './exercises/ExerciseCard';
import { TYPE_ORDER } from './exercises/answer';
import styles from './grammar.module.css';
import v from './subviews.module.css';
import x from './exercises/exercises.module.css';

type Kind = 'mixed' | 'mistakes' | 'due';
const KINDS: Kind[] = ['mixed', 'mistakes', 'due'];
const BATCH = 8;

const TYPE_NAME: Record<Exercise['type'], { vi: string; en: string }> = {
  choice: { vi: 'Chọn một đáp án', en: 'Choose one' },
  multi: { vi: 'Chọn nhiều đáp án', en: 'Choose several' },
  cloze: { vi: 'Điền vào chỗ trống', en: 'Fill the blank' },
  order: { vi: 'Sắp xếp từ', en: 'Put words in order' },
  transform: { vi: 'Viết lại câu', en: 'Rewrite the sentence' },
  error: { vi: 'Tìm chỗ sai', en: 'Find the mistake' },
  match: { vi: 'Nối cặp', en: 'Match' },
  classify: { vi: 'Xếp vào nhóm', en: 'Sort into groups' },
  open: { vi: 'Tự viết', en: 'Write it yourself' },
};

const MODE_COPY: Record<Kind, { title: { vi: string; en: string }; text: { vi: string; en: string } }> = {
  mixed: { title: { vi: 'Trộn', en: 'Mixed' }, text: { vi: 'Câu hỏi từ nhiều chủ đề, lọc theo ý bạn', en: 'Questions from many topics, filtered as you like' } },
  mistakes: { title: { vi: 'Lỗi của tôi', en: 'My mistakes' }, text: { vi: 'Những câu bạn từng làm chưa đúng', en: 'Questions you once got wrong' } },
  due: { title: { vi: 'Đến hạn ôn', en: 'Due for review' }, text: { vi: 'Từ các chủ đề đã nắm, đến lúc ôn lại', en: 'From topics you mastered, ready to review' } },
};

const asKind = (v: string | null): Kind => (KINDS.includes(v as Kind) ? (v as Kind) : 'mixed');
const asLevel = (v: string | null): string => (v && LEVELS.includes(v as (typeof LEVELS)[number]) ? v : '');
const asType = (v: string | null): string => (v && TYPE_ORDER.includes(v as Exercise['type']) ? v : '');

export function PracticeStudio() {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const router = useRouter();
  const pathname = usePathname() || '/grammar/practice';
  const search = useSearchParams();
  const { data: catalog } = useGrammarCatalog();
  const { data: me, mutate: mutateMe } = useGrammarMe();

  const kind = asKind(search.get('kind'));
  const domain = search.get('domain') ?? '';
  const level = asLevel(search.get('level'));
  const type = asType(search.get('type'));

  /* filters live in the address, so a set-up can be shared and survives refresh, Back and Forward */
  const go = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname, search]);

  const [queue, setQueue] = useState<Exercise[]>([]);
  const [at, setAt] = useState(0);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [note, setNote] = useState<PracticeSet['note']>(null);
  const [errorStatus, setErrorStatus] = useState<number | undefined>(undefined);
  const [results, setResults] = useState<Record<string, Outcome>>({});
  const [run, setRun] = useState(0);
  const [more, setMore] = useState<'idle' | 'loading' | 'none' | 'error'>('idle');

  const applied = useMemo(() => ({
    kind,
    domain: kind === 'mixed' && domain ? domain : undefined,
    level: kind === 'mixed' && level ? level : undefined,
    type: kind !== 'mistakes' && type ? type : undefined,
  }), [kind, domain, level, type]);

  /* a new set-up (or "start over") draws a fresh run */
  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setQueue([]);
    setAt(0);
    setResults({});
    setNote(null);
    setMore('idle');
    grammarApi.practice({ ...applied, size: BATCH })
      .then((set) => {
        if (cancelled) return;
        setQueue(set.exercises);
        setNote(set.note);
        setPhase('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setErrorStatus(apiFailure(err).status);
        setPhase('error');
      });
    return () => { cancelled = true; };
  }, [applied, run]);

  const onResult = useCallback((v: Verdict) => {
    setResults((r) => ({ ...r, [v.exerciseId]: v.outcome }));
    void mutateMe();
  }, [mutateMe]);

  const addMore = async () => {
    if (more === 'loading') return;
    setMore('loading');
    try {
      const set = await grammarApi.practice({ ...applied, size: BATCH });
      const have = new Set(queue.map((e) => e.id));
      const fresh = set.exercises.filter((e) => !have.has(e.id));
      if (!fresh.length) { setMore('none'); return; }
      setQueue((q) => [...q, ...fresh]);
      setMore('idle');
    } catch {
      setMore('error');
    }
  };

  const tally = useMemo(() => {
    const t = { answered: 0, right: 0, partial: 0, wrong: 0, unknown: 0, self: 0 };
    for (const o of Object.values(results)) {
      t.answered += 1;
      if (isRight(o)) t.right += 1;
      else if (o === 'PARTIAL') t.partial += 1;
      else if (o === 'WRONG') t.wrong += 1;
      else if (o === 'UNRECOGNIZED') t.unknown += 1;
      else t.self += 1;
    }
    return t;
  }, [results]);

  const domains = catalog?.domains ?? [];
  const finished = phase === 'ready' && queue.length > 0 && at >= queue.length;
  const ex = phase === 'ready' ? queue[at] : undefined;
  const answeredHere = ex ? results[ex.id] !== undefined : false;
  const dueCount = me?.counts.due;

  return (
    <div className={cx(x.page, v.view, v.focusPage)}>
      <header className={cx(x.pageHead, v.focusHead)}>
        <p className={styles.eyebrow}>{vi ? 'Luyện tập' : 'Practice'}</p>
        <h1 className={x.pageTitle}>{vi ? 'Phòng luyện tập' : 'Practice studio'}</h1>
        <p className={x.pageLead}>
          {vi
            ? 'Từng câu một, có phản hồi ngay và lý do cho mọi lựa chọn. Luyện tập giúp bạn quen với chủ đề; kết quả “đã nắm” chỉ được ghi sau bài kiểm tra ở trang chủ đề.'
            : 'One question at a time, with feedback at once and the reason for every choice. Practice builds familiarity; “mastered” is recorded only after the check on a topic page.'}
        </p>
      </header>

      <div className={cx(x.modes, v.practiceModes)} role="radiogroup" aria-label={vi ? 'Chọn kiểu luyện tập' : 'Choose how to practise'}>
        {KINDS.map((k) => (
          <label key={k} className={cx(x.mode, v.practiceMode)} data-on={kind === k ? 'true' : 'false'}>
            <input type="radio" name="grammar-practice-kind" value={k} checked={kind === k} onChange={() => go({ kind: k === 'mixed' ? '' : k })} />
            <span className={x.modeTitle}>
              {vi ? MODE_COPY[k].title.vi : MODE_COPY[k].title.en}
              {k === 'due' && dueCount != null ? <span className={x.modeCount}>{dueCount}</span> : null}
            </span>
            <span className={x.modeText}>{vi ? MODE_COPY[k].text.vi : MODE_COPY[k].text.en}</span>
          </label>
        ))}
      </div>

      {kind !== 'mistakes' ? (
        <div className={cx(x.filters, v.practiceFilters)} role="group" aria-label={vi ? 'Bộ lọc' : 'Filters'}>
          {kind === 'mixed' ? (
            <>
              <div className={x.filter}>
                <label className={styles.fieldLabel} htmlFor="pr-domain">{vi ? 'Mảng kiến thức' : 'Area'}</label>
                <select id="pr-domain" className={styles.input} value={domain} onChange={(e) => go({ domain: e.target.value })}>
                  <option value="">{vi ? 'Tất cả' : 'All'}</option>
                  {domains.map((d) => <option key={d.id} value={d.id}>{vi ? d.title.vi : d.title.en}</option>)}
                  {domain && !domains.some((d) => d.id === domain) ? <option value={domain}>{domain}</option> : null}
                </select>
              </div>
              <div className={x.filter}>
                <label className={styles.fieldLabel} htmlFor="pr-level">{vi ? 'Mức' : 'Level'}</label>
                <select id="pr-level" className={styles.input} value={level} onChange={(e) => go({ level: e.target.value })}>
                  <option value="">{vi ? 'Mọi mức' : 'Any level'}</option>
                  {LEVELS.map((l) => <option key={l} value={l}>{levelLabel(l)}</option>)}
                </select>
              </div>
            </>
          ) : null}
          <div className={x.filter}>
            <label className={styles.fieldLabel} htmlFor="pr-type">{vi ? 'Dạng bài' : 'Question type'}</label>
            <select id="pr-type" className={styles.input} value={type} onChange={(e) => go({ type: e.target.value })}>
              <option value="">{vi ? 'Mọi dạng' : 'Any type'}</option>
              {TYPE_ORDER.map((t) => <option key={t} value={t}>{vi ? TYPE_NAME[t].vi : TYPE_NAME[t].en}</option>)}
            </select>
          </div>
        </div>
      ) : null}

      {phase === 'ready' && queue.length ? (
        <p className={x.tally} aria-live="polite">
          {tally.answered
            ? (vi
              ? `Lần luyện này: ${tally.answered} câu đã trả lời · ${tally.right} đúng${tally.partial ? ` · ${tally.partial} đúng một phần` : ''}${tally.wrong ? ` · ${tally.wrong} chưa đúng` : ''}${tally.unknown ? ` · ${tally.unknown} chưa nhận ra, không tính` : ''}${tally.self ? ` · ${tally.self} tự đối chiếu` : ''}`
              : `This run: ${tally.answered} answered · ${tally.right} right${tally.partial ? ` · ${tally.partial} partly right` : ''}${tally.wrong ? ` · ${tally.wrong} not right` : ''}${tally.unknown ? ` · ${tally.unknown} not recognised, not counted` : ''}${tally.self ? ` · ${tally.self} self-review` : ''}`)
            : (vi ? `Lần luyện này: ${queue.length} câu đang chờ bạn. Số liệu chỉ tính trong lần này.` : `This run: ${queue.length} questions waiting. The count is for this run only.`)}
        </p>
      ) : null}

      {phase === 'loading' ? (
        <div className={x.card} aria-busy="true" aria-label={vi ? 'Đang tìm câu hỏi' : 'Finding questions'}>
          <span className={cx(styles.skel, styles.skelLine)} style={{ width: '40%' }} />
          <span className={cx(styles.skel, styles.skelLine)} style={{ width: '88%', marginTop: '0.9rem' }} />
          <span className={cx(styles.skel, styles.skelLine)} style={{ width: '72%', marginTop: '0.6rem' }} />
          <span className={cx(styles.skel, styles.skelBtn)} style={{ marginTop: '1.2rem' }} />
          <span className={styles.srOnly}>{vi ? 'Đang tìm câu hỏi…' : 'Finding questions…'}</span>
        </div>
      ) : null}

      {phase === 'error' ? (
        <div className={styles.stateBox} role="alert">
          <span className={styles.stateIcon} aria-hidden="true"><TriangleAlert /></span>
          <h2 className={styles.stateTitle}>{vi ? 'Chưa lấy được câu hỏi' : 'The questions could not be loaded'}</h2>
          <p className={styles.stateText}>{errorStatus === 401 || errorStatus === 403 ? (vi ? 'Phiên đăng nhập có vấn đề. Hãy đăng nhập lại.' : 'There is a problem with your sign-in. Please sign in again.') : (vi ? 'Kết nối bị gián đoạn. Hãy thử lại.' : 'The connection was interrupted. Please try again.')}</p>
          <div className={styles.stateActions}><button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={() => setRun((n) => n + 1)}><RotateCcw aria-hidden="true" />{vi ? 'Thử lại' : 'Try again'}</button></div>
        </div>
      ) : null}

      {phase === 'ready' && !queue.length ? <EmptyState kind={kind} note={note} vi={vi} onSwitch={(k) => go({ kind: k === 'mixed' ? '' : k })} /> : null}

      {ex ? (
        <div className={cx(x.studioCard, v.exerciseStage)}>
          <progress className={v.progress} value={at} max={queue.length} aria-label={vi ? 'Tiến độ lượt luyện' : 'Practice progress'} />
          <p className={x.studioCount}>{vi ? `Câu ${at + 1} trong ${queue.length}` : `Question ${at + 1} of ${queue.length}`}</p>
          <ExerciseCard key={ex.id} exercise={ex} mode="practice" onResult={onResult} />
          <div className={cx(x.studioNav, v.runActions)}>
            <button type="button" className={cx(styles.btn, styles.btnQuiet)} onClick={() => setAt(at + 1)}>
              <SkipForward aria-hidden="true" />{answeredHere ? (vi ? 'Câu tiếp' : 'Next question') : (vi ? 'Bỏ qua câu này' : 'Skip this one')}
              {answeredHere ? <ArrowRight aria-hidden="true" /> : null}
            </button>
          </div>
        </div>
      ) : null}

      {finished ? (
        <section className={x.finish} aria-labelledby="pr-done">
          <h2 id="pr-done" className={x.finishTitle}>{vi ? 'Bạn đã đi hết các câu trong lần này' : 'You have been through this run'}</h2>
          <p className={x.finishText}>
            {tally.answered
              ? (vi ? `Bạn đã trả lời ${tally.answered} câu, ${tally.right} câu đúng. Muốn luyện tiếp thì thêm câu, hoặc xem lại những lỗi hay gặp.` : `You answered ${tally.answered}, ${tally.right} right. Add more questions to carry on, or look at the mistakes you meet most.`)
              : (vi ? 'Bạn chưa trả lời câu nào trong lần này. Thêm câu để bắt đầu.' : 'You did not answer any in this run. Add questions to begin.')}
          </p>
          <div className={x.actionRow}>
            <button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={() => { void addMore(); }} disabled={more === 'loading'}>
              {more === 'loading' ? <Loader2 className={styles.spin} aria-hidden="true" /> : <Plus aria-hidden="true" />}{vi ? 'Thêm câu' : 'Add more questions'}
            </button>
            <button type="button" className={cx(styles.btn, styles.btnSoft)} onClick={() => setRun((n) => n + 1)}><RotateCcw aria-hidden="true" />{vi ? 'Bắt đầu lần mới' : 'Start a new run'}</button>
            <Link href="/grammar/mistakes" className={cx(styles.btn, styles.btnQuiet)}><CircleHelp aria-hidden="true" />{vi ? 'Lỗi của tôi' : 'My mistakes'}</Link>
          </div>
          {more === 'none' ? <p className={x.failLine} role="status">{vi ? 'Với bộ lọc này không còn câu nào mới. Hãy đổi bộ lọc hoặc bắt đầu lần mới.' : 'No new questions are left for these filters. Change them or start a new run.'}</p> : null}
          {more === 'error' ? <p className={x.failLine} role="alert">{vi ? 'Chưa lấy thêm được câu hỏi. Hãy thử lại.' : 'More questions could not be loaded. Please try again.'}</p> : null}
        </section>
      ) : null}
    </div>
  );
}

function EmptyState({ kind, note, vi, onSwitch }: { kind: Kind; note: PracticeSet['note']; vi: boolean; onSwitch: (k: Kind) => void }) {
  const mistakes = kind === 'mistakes' || note === 'NO_MISTAKES';
  const due = kind === 'due';
  return (
    <div className={styles.stateBox} role="status">
      <span className={styles.stateIcon} aria-hidden="true">{mistakes ? <Dumbbell /> : <SearchX />}</span>
      <h2 className={styles.stateTitle}>
        {mistakes ? (vi ? 'Chưa có lỗi nào để luyện lại' : 'No mistakes to practise yet')
          : due ? (vi ? 'Chưa có chủ đề nào đến hạn ôn' : 'No topic is due for review')
            : (vi ? 'Không có câu nào khớp bộ lọc này' : 'No question matches these filters')}
      </h2>
      <p className={styles.stateText}>
        {mistakes
          ? (vi ? 'Những câu bạn làm chưa đúng trong luyện tập sẽ xuất hiện ở đây để luyện lại. Hiện chưa có câu nào được ghi nhận.' : 'Questions you get wrong in practice will appear here to practise again. None have been recorded yet.')
          : due
            ? (vi ? 'Một chủ đề đến hạn ôn sau khi bạn đã đạt bài kiểm tra của nó và đến ngày hẹn. Hiện chưa có chủ đề nào như vậy.' : 'A topic becomes due after you pass its check and the review date arrives. None is due right now.')
            : (vi ? 'Hãy nới bộ lọc, hoặc chọn mức hoặc mảng khác. Một số chủ đề vẫn đang được biên soạn.' : 'Loosen the filters, or choose another level or area. Some topics are still being written.')}
      </p>
      <div className={styles.stateActions}>
        {kind !== 'mixed' ? <button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={() => onSwitch('mixed')}>{vi ? 'Luyện trộn' : 'Mixed practice'}</button> : null}
        <Link href="/grammar/library" className={cx(styles.btn, styles.btnSoft)}>{vi ? 'Mở thư viện' : 'Open the library'}</Link>
      </div>
    </div>
  );
}
