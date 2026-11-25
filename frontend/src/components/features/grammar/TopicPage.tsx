'use client';

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Bookmark, BookmarkCheck, BookOpen, Check, ChevronRight, CircleCheck, CircleHelp, ClipboardCheck, Eye, EyeOff, Flag, Info, Layers,
  Loader2, Lightbulb, Minus, RotateCcw, SearchX, ShieldAlert, TriangleAlert, X, Zap,
} from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useContentTitle } from '@/lib/brand/tabTitle';
import { grammarApi } from '@/services/grammarApi';
import {
  isBookmarked, isDue, stateOf, topicIndex, useGrammarCatalog, useGrammarMe, useGrammarTopic,
} from '@/hooks/useGrammar';
import {
  REL_ORDER, apiFailure, cx, editorialLabel, isRight, levelLabel, relLabel, sourceName, statusLabel, statusTone, suggestedLevel,
} from '@/lib/grammar/format';
import { rolesInBlocks } from '@/lib/grammar/inline';
import type { Block, CheckView, Exercise, Outcome, Topic, TopicState, Verdict } from '@/types/grammar';
import { Blocks, headingsOf } from './Blocks';
import { ExerciseCard } from './exercises/ExerciseCard';
import { RoleLegend, Vi } from './Inline';
import { useInView } from './diagrams/shared';
import { Professor } from './Professor';
import styles from './grammar.module.css';
import v from './subviews.module.css';

type Layer = 'quick' | 'lesson' | 'deep';
const LAYERS: Layer[] = ['quick', 'lesson', 'deep'];
const ROLES_KEY = 'ec_grammar_roles';

const scroller = () => (typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('main[data-app-scroll]'));

/* ═══ page ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
export function TopicPage({ slug }: { slug: string }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: topic, error, isLoading, mutate: reload } = useGrammarTopic(slug);
  const { data: catalog } = useGrammarCatalog();
  const { data: me, mutate: mutateMe } = useGrammarMe();
  const index = useMemo(() => topicIndex(catalog), [catalog]);
  const entry = index.get(slug) ?? null;
  const state = stateOf(me, slug);
  const bookmarked = isBookmarked(me, slug);
  const due = isDue(me, slug);

  useContentTitle(topic ? (vi ? topic.title.vi : topic.title.en) : null);

  const layerParam = searchParams.get('layer');
  const layer: Layer = layerParam === 'quick' || layerParam === 'deep' ? layerParam : 'lesson';

  /* explicit visit: one record per page view, never an AI call */
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!topic || topic.slug !== slug || opened.current === slug) return;
    opened.current = slug;
    grammarApi.open(slug).then(() => { void mutateMe(); }).catch(() => undefined);
  }, [topic, slug, mutateMe]);

  /* roles toggle, remembered per browser */
  const [showRoles, setShowRoles] = useState(false);
  useEffect(() => {
    try { setShowRoles(window.localStorage.getItem(ROLES_KEY) === '1'); } catch { /* storage may be blocked */ }
  }, []);
  const toggleRoles = () => {
    setShowRoles((v) => {
      try { window.localStorage.setItem(ROLES_KEY, v ? '0' : '1'); } catch { /* ignore */ }
      return !v;
    });
  };

  /* layers: tabs in the URL with native history; each layer remembers its own scroll position */
  const memory = useRef<Partial<Record<Layer, number>>>({});
  const layerRef = useRef<Layer>(layer);
  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const main = scroller();
    if (!main) return;
    const onScroll = () => { memory.current[layerRef.current] = main.scrollTop; };
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => main.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    if (layerRef.current === layer) return;
    layerRef.current = layer;
    const main = scroller();
    const bar = barRef.current;
    if (!main) return;
    const saved = memory.current[layer];
    if (saved !== undefined) { main.scrollTop = saved; return; }
    if (bar) {
      const barTop = bar.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      if (main.scrollTop > barTop) main.scrollTop = barTop;
    }
  }, [layer]);
  const setLayer = useCallback((next: Layer) => {
    if (next === layerRef.current) return;
    const main = scroller();
    if (main) memory.current[layerRef.current] = main.scrollTop;
    const params = new URLSearchParams(window.location.search);
    if (next === 'lesson') params.delete('layer'); else params.set('layer', next);
    const query = params.toString();
    window.history.pushState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, []);

  /* actions */
  const [note, setNote] = useState<{ tone: 'info' | 'warn' | 'good'; text: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [marking, setMarking] = useState(false);
  const startFlight = useRef(false);

  const startCheck = async () => {
    if (startFlight.current) return;
    startFlight.current = true;
    setStarting(true);
    setNote(null);
    try {
      let view: CheckView;
      try {
        view = await grammarApi.startCheck(due ? 'REVIEW' : 'TOPIC', slug);
      } catch (err) {
        if (due && apiFailure(err).code === 'NOT_MASTERED') view = await grammarApi.startCheck('TOPIC', slug);
        else throw err;
      }
      router.push(`/grammar/check/${encodeURIComponent(view.id)}`);
    } catch (err) {
      const { status, code } = apiFailure(err);
      if (code === 'NOT_ENOUGH_ITEMS') setNote({ tone: 'warn', text: vi ? 'Chủ đề này chưa có đủ câu để kiểm tra. Hãy luyện các câu bên dưới trước, rồi quay lại.' : 'This topic does not have enough questions for a check yet. Practise the questions below first, then come back.' });
      else if (code === 'NOT_ENOUGH_PRODUCTION_ITEMS') setNote({ tone: 'warn', text: vi ? 'Phần kiểm tra vận dụng của chủ đề đang được hoàn thiện. Bạn vẫn có thể học và luyện các câu bên dưới.' : 'The construction part of this topic check is being completed. You can still study and practise below.' });
      else if (status === 429) setNote({ tone: 'warn', text: vi ? 'Hôm nay bạn đã bắt đầu nhiều bài kiểm tra. Hãy thử lại vào ngày mai.' : 'You have started many checks today. Try again tomorrow.' });
      else setNote({ tone: 'warn', text: vi ? 'Chưa tạo được bài kiểm tra. Hãy thử lại.' : 'The check could not be created. Please try again.' });
      setStarting(false);
    } finally {
      startFlight.current = false;
    }
  };

  const markStudied = async () => {
    if (marking) return;
    setMarking(true);
    setNote(null);
    try {
      await grammarApi.studied(slug);
      await mutateMe();
      setNote({ tone: 'good', text: vi ? 'Đã ghi nhận: bạn đã học bài này. Hãy kiểm tra để biết mình đã nắm chưa.' : 'Recorded: you have studied this lesson. Take the check to see whether you have it.' });
    } catch {
      setNote({ tone: 'warn', text: vi ? 'Chưa ghi nhận được. Hãy thử lại.' : 'Could not record that. Please try again.' });
    } finally {
      setMarking(false);
    }
  };

  const toggleBookmark = async () => {
    if (!me) return;
    const on = !bookmarked;
    void mutateMe((prev) => prev ? {
      ...prev,
      bookmarks: on ? [...prev.bookmarks.filter((s) => s !== slug), slug] : prev.bookmarks.filter((s) => s !== slug),
      counts: { ...prev.counts, bookmarks: Math.max(0, prev.counts.bookmarks + (on ? 1 : -1)) },
    } : prev, { revalidate: false });
    try {
      await grammarApi.bookmark(slug, on);
    } catch {
      void mutateMe();
      setNote({ tone: 'warn', text: vi ? 'Chưa lưu được bài này. Hãy thử lại.' : 'Could not save this lesson. Please try again.' });
    }
  };

  /* what is on the page */
  const blocksOf = (l: Layer): Block[] => (topic ? (l === 'lesson' ? topic.lesson : l === 'deep' ? topic.deep : []) : []);
  const used = useMemo(() => {
    if (!topic) return new Set<string>();
    const quick: Block = { type: 'examples', items: topic.quick.examples.map((e) => ({ en: e.en, vi: e.vi })) };
    return rolesInBlocks([quick, ...topic.lesson, ...topic.deep]);
  }, [topic]);
  const layerUsed = useMemo(() => {
    if (!topic) return new Set<string>();
    const quick: Block = { type: 'examples', items: topic.quick.examples.map((e) => ({ en: e.en, vi: e.vi })) };
    return rolesInBlocks(layer === 'quick' ? [quick] : blocksOf(layer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, layer]);
  const prefix = layer === 'quick' ? 'q' : layer === 'lesson' ? 'l' : 'd';
  const headings = useMemo(() => headingsOf(blocksOf(layer), prefix), // eslint-disable-line react-hooks/exhaustive-deps
    [topic, layer, prefix]);

  /* states: loading, missing, failed */
  if (isLoading && !topic) return <TopicSkeleton />;
  if (error || !topic) {
    const missing = apiFailure(error).status === 404;
    return (
      <div className={styles.stateBox} role={missing ? 'status' : 'alert'}>
        <span className={styles.stateIcon} aria-hidden="true">{missing ? <SearchX /> : <TriangleAlert />}</span>
        <h1 className={styles.stateTitle}>{missing ? (vi ? 'Không tìm thấy chủ đề này' : 'This topic was not found') : (vi ? 'Chưa tải được bài học' : 'The lesson could not be loaded')}</h1>
        <p className={styles.stateText}>
          {missing
            ? (vi ? 'Đường dẫn có thể đã cũ, hoặc chủ đề chưa được biên soạn.' : 'The link may be old, or the topic is not written yet.')
            : (vi ? 'Kết nối bị gián đoạn. Bài học của bạn không bị mất.' : 'The connection was interrupted. Nothing of yours is lost.')}
        </p>
        <div className={styles.stateActions}>
          {missing ? null : <button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={() => { void reload(); }}><RotateCcw aria-hidden="true" />{vi ? 'Thử lại' : 'Try again'}</button>}
          <Link href="/grammar/library" className={cx(styles.btn, styles.btnSoft)}><BookOpen aria-hidden="true" />{vi ? 'Mở thư viện' : 'Open the library'}</Link>
        </div>
      </div>
    );
  }

  const practice = topic.exercises;
  const hasRelated = (topic.related ?? []).some((r) => index.has(r.slug)) || (topic.prerequisites ?? []).some((q) => index.has(q));
  const toc = [
    ...headings,
    ...(practice.length ? [{ id: 'practice', text: vi ? 'Luyện tập' : 'Practice' }] : []),
    ...(topic.mistakes.length ? [{ id: 'mistakes', text: vi ? 'Lỗi thường gặp' : 'Common mistakes' }] : []),
    ...(topic.faq.length ? [{ id: 'faq', text: vi ? 'Câu hỏi thường gặp' : 'Questions' }] : []),
    { id: 'ask', text: vi ? 'Hỏi về bài này' : 'Ask about this lesson' },
    ...(hasRelated ? [{ id: 'related', text: vi ? 'Bài liên quan' : 'Related lessons' }] : []),
  ];

  return (
    <article className={cx(styles.topic, v.view)} data-roles={showRoles ? 'on' : 'off'}>
      <Masthead
        topic={topic}
        domainTitle={entry ? (vi ? entry.domain.title.vi : entry.domain.title.en) : null}
        domainId={entry?.domain.id ?? null}
        tone={entry?.domain.tone ?? null}
        basis={entry?.topic.levelBasis ?? topic.levelBasis}
        state={state}
        due={due}
        bookmarked={bookmarked}
        canBookmark={!!me}
        starting={starting}
        marking={marking}
        note={note}
        onCheck={startCheck}
        onStudied={markStudied}
        onBookmark={toggleBookmark}
      />

      <div ref={barRef} className={cx(styles.layerBar, v.layerNav)}>
        <LayerTabs layer={layer} onChange={setLayer} hasDeep={topic.deep.length > 0} />
        {used.size ? (
          <button type="button" className={cx(styles.switch, showRoles && styles.switchOn)} role="switch" aria-checked={showRoles} onClick={toggleRoles}>
            {showRoles ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
            <span className={styles.switchText}>{vi ? 'Hiện vai trò' : 'Show roles'}</span>
          </button>
        ) : null}
        {me ? (
          <Link href={`/knowledge-universe?grammar=${encodeURIComponent(slug)}`} className={styles.switch}>
            <span className={styles.switchText}>{vi ? 'Xem trong vũ trụ' : 'See in the universe'}</span>
          </Link>
        ) : null}
      </div>

      <div className={cx(styles.topicGrid, v.readingGrid)}>
        <div className={cx(styles.topicMain, v.readingMain, showRoles && styles.showRoles)}>
          {showRoles && layerUsed.size ? <RoleLegend only={layerUsed} className={styles.legendInline} /> : null}

          <section
            id={`panel-${layer}`}
            role="tabpanel"
            aria-labelledby={`tab-${layer}`}
            className={cx(styles.layerPanel, v.lessonPanel)}
            data-layer={layer}
            tabIndex={-1}
          >
            {layer === 'quick' ? <QuickLayer topic={topic} /> : null}
            {layer === 'lesson' ? (
              <>
                <Blocks blocks={topic.lesson} topic={slug} exercises={practice} idPrefix="l" />
                <LessonEnd topic={topic} due={due} starting={starting} marking={marking} studied={!!state?.studiedAt} onCheck={startCheck} onStudied={markStudied} />
              </>
            ) : null}
            {layer === 'deep' ? (
              topic.deep.length
                ? <Blocks blocks={topic.deep} topic={slug} exercises={practice} idPrefix="d" />
                : <p className={styles.emptyLine}>{vi ? 'Chủ đề này chưa có phần chuyên sâu.' : 'This topic has no deep layer yet.'}</p>
            ) : null}
          </section>

          {practice.length ? <PracticeRun key={slug} topic={topic} exercises={practice} onCheck={startCheck} starting={starting} /> : null}
          {topic.mistakes.length ? <MistakeList mistakes={topic.mistakes} /> : null}
          {topic.faq.length ? <FaqList faq={topic.faq} /> : null}
          <div id="ask" tabIndex={-1} className={styles.anchor}><Professor key={slug} topic={slug} faq={topic.faq} /></div>
          <RelatedSections topic={topic} index={index} me={me} />
          <SourcesAndReport topic={topic} />
        </div>

        <aside className={styles.rail} aria-label={vi ? 'Trong bài này' : 'On this page'}>
          <Toc items={toc} />
        </aside>
      </div>
    </article>
  );
}

/* ═══ masthead ═══════════════════════════════════════════════════════════════════════════════════════════════════════ */
function Masthead(props: {
  topic: Topic; domainTitle: string | null; domainId: string | null; tone: string | null; basis: string; state: TopicState | null; due: boolean;
  bookmarked: boolean; canBookmark: boolean; starting: boolean; marking: boolean; note: { tone: 'info' | 'warn' | 'good'; text: string } | null;
  onCheck: () => void; onStudied: () => void; onBookmark: () => void;
}) {
  const { topic, state, due } = props;
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const [ref, live] = useInView<HTMLElement>();
  const exam = [topic.exam?.ielts ? 'IELTS' : null, topic.exam?.toeic ? 'TOEIC' : null].filter(Boolean) as string[];
  const tone = statusTone(state?.status ?? 'OPENED');

  return (
    <header ref={ref} className={cx(styles.mast, v.lessonMast)} data-tone={props.tone ?? undefined} data-live={live ? 'true' : 'false'}>
      <MastArt level={levelLabel(topic.level)} />
      <div className={cx(styles.mastBody, v.lessonBody)}>
        <nav className={styles.crumbs} aria-label={vi ? 'Đường dẫn' : 'Breadcrumb'}>
          <Link href="/grammar">{vi ? 'Ngữ pháp' : 'Grammar'}</Link>
          <ChevronRight aria-hidden="true" />
          {props.domainTitle && props.domainId
            ? <Link href={`/grammar/library?domain=${encodeURIComponent(props.domainId)}`}>{props.domainTitle}</Link>
            : <Link href="/grammar/library">{vi ? 'Thư viện' : 'Library'}</Link>}
        </nav>

        <div className={styles.chips}>
          <span className={cx(styles.chip, styles.chipLevel)} title={vi ? 'Mức gợi ý để học, không phải kết quả đo' : 'A suggested level to study at, not a measured result'}>
            <Layers aria-hidden="true" />{suggestedLevel(topic.level, props.basis, vi)}
          </span>
          {topic.kind === 'application' ? <span className={styles.chip}>{vi ? 'Ứng dụng' : 'Application'}</span> : null}
          {exam.map((e) => <span key={e} className={styles.chip} title={vi ? 'Chủ đề này hay gặp khi luyện thi (chỉ là gợi ý luyện tập)' : 'Often met when preparing for this test (practice guidance only)'}>{e}</span>)}
          {state ? (
            <span className={styles.chip} data-state={tone}>
              {tone === 'good' ? <CircleCheck aria-hidden="true" /> : tone === 'due' ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}
              {statusLabel(state.status, vi)}
            </span>
          ) : null}
        </div>

        <h1 className={styles.mastTitle}><Vi text={topic.title.vi} /></h1>
        <p className={styles.mastEn} lang="en">{topic.title.en}</p>
        {topic.subtitle?.vi ? <p className={styles.mastSub}><Vi text={topic.subtitle.vi} /></p> : null}

        {topic.objectives.length ? (
          <div className={styles.objectives}>
            <p className={styles.eyebrow}>{vi ? 'Sau bài này bạn có thể' : 'After this lesson you can'}</p>
            <ol className={styles.objList}>
              {topic.objectives.map((o, i) => (
                <li key={i}><span className={styles.objNum} aria-hidden="true">{i + 1}</span><span><Vi text={o} /></span></li>
              ))}
            </ol>
          </div>
        ) : null}

        <div className={styles.mastActions}>
          <button type="button" className={cx(styles.btn, styles.btnPrimary, styles.btnLg)} onClick={props.onCheck} disabled={props.starting} data-guide="grammar-check">
            {props.starting ? <Loader2 className={styles.spin} aria-hidden="true" /> : due ? <RotateCcw aria-hidden="true" /> : <ClipboardCheck aria-hidden="true" />}
            {due ? (vi ? 'Ôn lại' : 'Review') : (vi ? 'Kiểm tra chủ đề này' : 'Check this topic')}
          </button>
          <button type="button" className={cx(styles.btn, styles.btnSoft)} onClick={props.onStudied} disabled={props.marking || !!state?.studiedAt}>
            {props.marking ? <Loader2 className={styles.spin} aria-hidden="true" /> : <Check aria-hidden="true" />}
            {state?.studiedAt ? (vi ? 'Đã đánh dấu đã học' : 'Marked as studied') : (vi ? 'Mình đã học xong' : 'I have studied this')}
          </button>
          <button type="button" className={cx(styles.btn, styles.btnQuiet)} aria-pressed={props.bookmarked} onClick={props.onBookmark} disabled={!props.canBookmark} data-guide="grammar-bookmark">
            {props.bookmarked ? <BookmarkCheck aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
            {props.bookmarked ? (vi ? 'Đã lưu' : 'Saved') : (vi ? 'Lưu bài' : 'Save')}
          </button>
        </div>
        <div className={styles.mastMsg} role="status" aria-live="polite">
          {props.note ? <p className={styles.callout} data-tone={props.note.tone}>{props.note.tone === 'warn' ? <TriangleAlert aria-hidden="true" /> : props.note.tone === 'good' ? <CircleCheck aria-hidden="true" /> : <Info aria-hidden="true" />}<span>{props.note.text}</span></p> : null}
        </div>
        <p className={styles.editorial}><ShieldAlert aria-hidden="true" />{editorialLabel(topic.editorial?.status, vi)}</p>
      </div>
    </header>
  );
}

function MastArt({ level }: { level: string }) {
  return (
    <div className={styles.mastArt} aria-hidden="true">
      <svg viewBox="0 0 360 260" className={styles.mastSvg} focusable="false">
        <g className={styles.mastWaves}>
          <path d="M-40 150 C 10 120, 60 180, 110 150 S 210 120, 260 150 S 360 180, 410 150" />
          <path d="M-40 178 C 10 148, 60 208, 110 178 S 210 148, 260 178 S 360 208, 410 178" />
          <path d="M-40 206 C 10 176, 60 236, 110 206 S 210 176, 260 206 S 360 236, 410 206" />
          <path d="M-40 234 C 10 204, 60 264, 110 234 S 210 204, 260 234 S 360 264, 410 234" />
        </g>
        <circle cx="268" cy="84" r="46" className={styles.mastSun} />
        <circle cx="268" cy="84" r="70" className={styles.mastRing} />
        <circle cx="268" cy="84" r="98" className={styles.mastRing2} />
      </svg>
      <span className={styles.mastLevel}>{level}</span>
    </div>
  );
}

/* ═══ layers ═════════════════════════════════════════════════════════════════════════════════════════════════════════ */
function LayerTabs({ layer, onChange, hasDeep }: { layer: Layer; onChange: (l: Layer) => void; hasDeep: boolean }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const meta: Record<Layer, { name: string; hint: string; icon: React.ReactNode }> = {
    quick: { name: vi ? 'Nhanh' : 'Quick', hint: vi ? 'Cốt lõi trong vài câu' : 'The core in a few lines', icon: <Zap aria-hidden="true" /> },
    lesson: { name: vi ? 'Bài học' : 'Lesson', hint: vi ? 'Giải thích đầy đủ' : 'The full explanation', icon: <BookOpen aria-hidden="true" /> },
    deep: { name: vi ? 'Chuyên sâu' : 'Deep', hint: vi ? 'Ngoại lệ và sắc thái' : 'Exceptions and nuance', icon: <Lightbulb aria-hidden="true" /> },
  };
  const move = (to: number) => {
    const next = (to + LAYERS.length) % LAYERS.length;
    onChange(LAYERS[next]);
    refs.current[next]?.focus();
  };
  return (
    <div className={styles.tabs} role="tablist" data-guide="grammar-layers" aria-label={vi ? 'Ba tầng của bài học' : 'The three layers of the lesson'}>
      {LAYERS.map((l, i) => (
        <button
          key={l}
          ref={(el) => { refs.current[i] = el; }}
          id={`tab-${l}`}
          type="button"
          role="tab"
          aria-selected={layer === l}
          aria-controls={`panel-${l}`}
          tabIndex={layer === l ? 0 : -1}
          className={cx(styles.tab, layer === l && styles.tabOn)}
          data-quiet={l === 'deep' && !hasDeep ? 'true' : 'false'}
          onClick={() => onChange(l)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') { e.preventDefault(); move(i + 1); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); move(i - 1); }
            else if (e.key === 'Home') { e.preventDefault(); move(0); }
            else if (e.key === 'End') { e.preventDefault(); move(LAYERS.length - 1); }
          }}
        >
          {meta[l].icon}
          <span className={styles.tabText}>
            <span className={styles.tabName}>{meta[l].name}</span>
            <span className={styles.tabHint}>{meta[l].hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function QuickLayer({ topic }: { topic: Topic }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const q = topic.quick;
  return (
    <div className={styles.quick}>
      <div className={styles.quickCards}>
        <div className={styles.quickCard} data-kind="what">
          <p className={styles.eyebrow}>{vi ? 'Đây là gì' : 'What it is'}</p>
          <p className={styles.quickLead}><Vi text={q.what} /></p>
        </div>
        <div className={styles.quickCard} data-kind="when">
          <p className={styles.eyebrow}>{vi ? 'Dùng khi nào' : 'When to use it'}</p>
          <p className={styles.quickText}><Vi text={q.when} /></p>
        </div>
      </div>
      <Blocks blocks={[{ type: 'examples', items: q.examples.map((e) => ({ en: e.en, vi: e.vi })) }]} idPrefix="q" />
      {q.remember ? (
        <p className={styles.remember}>
          <span className={styles.rememberMark} aria-hidden="true"><Lightbulb /></span>
          <span><span className={styles.rememberLabel}>{vi ? 'Một câu để nhớ' : 'One line to remember'}</span><Vi text={q.remember} /></span>
        </p>
      ) : null}
    </div>
  );
}

function LessonEnd({ topic, due, starting, marking, studied, onCheck, onStudied }: {
  topic: Topic; due: boolean; starting: boolean; marking: boolean; studied: boolean; onCheck: () => void; onStudied: () => void;
}) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const exam = [
    topic.exam?.ielts ? { name: 'IELTS', note: topic.exam.ielts } : null,
    topic.exam?.toeic ? { name: 'TOEIC', note: topic.exam.toeic } : null,
  ].filter(Boolean) as { name: string; note: string }[];
  return (
    <div className={styles.lessonEnd}>
      {topic.uses?.length ? (
        <section className={styles.spiral} aria-labelledby="spiral-t">
          <h2 id="spiral-t" className={styles.sectionTitle}>{vi ? 'Cùng một chủ đề, mỗi trình độ một tầng' : 'One topic, a new layer at each level'}</h2>
          <ol className={styles.spiralList}>
            {topic.uses.map((u, i) => (
              <li key={i} className={styles.spiralItem}>
                <span className={cx(styles.chip, styles.chipLevel)}>{levelLabel(u.level)}</span>
                <span className={styles.spiralText}><Vi text={u.vi} /></span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {exam.length ? (
        <section className={styles.examNotes} aria-labelledby="exam-t">
          <h2 id="exam-t" className={styles.sectionTitle}>{vi ? 'Khi luyện thi' : 'When preparing for a test'}</h2>
          <ul className={styles.examList}>
            {exam.map((e) => (
              <li key={e.name}><span className={styles.chip}>{e.name}</span><span className={styles.examText}><Vi text={e.note} /></span></li>
            ))}
          </ul>
          <p className={styles.fine}>{vi ? 'Đây là gợi ý để luyện tập, không phải thông tin về điểm số hay đề thi chính thức. IELTS và TOEIC là thương hiệu của các chủ sở hữu tương ứng; English Coach không liên kết.' : 'These are practice hints, not information about scores or official papers. IELTS and TOEIC are trademarks of their owners; English Coach is not affiliated.'}</p>
        </section>
      ) : null}
      <section className={styles.finish} aria-labelledby="finish-t">
        <h2 id="finish-t" className={styles.finishTitle}>{vi ? 'Xong bài này rồi?' : 'Finished this lesson?'}</h2>
        <p className={styles.finishText}>{vi ? 'Đánh dấu để Echo nhớ bạn đã học, rồi làm bài kiểm tra ngắn. Lịch sử giữ cả lần đạt và chưa đạt; trạng thái đã nắm cần đủ bằng chứng từ bài kiểm tra.' : 'Mark the lesson as studied, then take the short check. History keeps both passed and unsuccessful attempts; mastery requires enough check evidence.'}</p>
        <div className={styles.finishActions}>
          <button type="button" className={cx(styles.btn, styles.btnSoft)} onClick={onStudied} disabled={marking || studied}>
            {marking ? <Loader2 className={styles.spin} aria-hidden="true" /> : <Check aria-hidden="true" />}
            {studied ? (vi ? 'Đã đánh dấu đã học' : 'Marked as studied') : (vi ? 'Mình đã học xong' : 'I have studied this')}
          </button>
          <button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={onCheck} disabled={starting}>
            {starting ? <Loader2 className={styles.spin} aria-hidden="true" /> : due ? <RotateCcw aria-hidden="true" /> : <ClipboardCheck aria-hidden="true" />}
            {due ? (vi ? 'Ôn lại' : 'Review') : (vi ? 'Kiểm tra chủ đề này' : 'Check this topic')}
          </button>
        </div>
      </section>
    </div>
  );
}

/* ═══ practice ═══════════════════════════════════════════════════════════════════════════════════════════════════════ */
function PracticeRun({ topic, exercises, onCheck, starting }: { topic: Topic; exercises: Exercise[]; onCheck: () => void; starting: boolean }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const [at, setAt] = useState(0);
  const [done, setDone] = useState<Record<string, Outcome>>({});
  const total = exercises.length;
  const finished = at >= total;
  const answered = Object.keys(done).length;
  const right = Object.values(done).filter(isRight).length;
  const unrecognized = Object.values(done).filter((o) => o === 'UNRECOGNIZED').length;
  const ex = exercises[Math.min(at, total - 1)];

  const onResult = useCallback((v: Verdict) => {
    setDone((d) => ({ ...d, [v.exerciseId]: v.outcome }));
  }, []);

  const dotLabel = (e: Exercise, i: number) => {
    const o = done[e.id];
    const word = !o ? (vi ? 'chưa làm' : 'not done')
      : o === 'CORRECT' || o === 'ACCEPTABLE' ? (vi ? 'đúng' : 'right')
      : o === 'PARTIAL' ? (vi ? 'đúng một phần' : 'partly right')
      : o === 'WRONG' ? (vi ? 'chưa đúng' : 'not right')
      : o === 'UNRECOGNIZED' ? (vi ? 'hệ thống chưa nhận ra' : 'not recognised')
      : (vi ? 'tự đối chiếu' : 'self-review');
    return `${vi ? 'Câu' : 'Question'} ${i + 1}: ${word}`;
  };

  return (
    <section id="practice" tabIndex={-1} className={cx(styles.section, styles.anchor, v.lessonSection)} aria-labelledby="practice-t" data-guide="grammar-practice">
      <header className={styles.sectionHead}>
        <h2 id="practice-t" className={styles.sectionTitle}>{vi ? 'Luyện tập' : 'Practice'}</h2>
        <p className={styles.tally} aria-live="polite">
          {answered
            ? (vi ? `Đã trả lời ${answered} trên ${total} câu · ${right} đúng` : `Answered ${answered} of ${total} · ${right} right`)
            : (vi ? `${total} câu, làm lần lượt` : `${total} questions, one at a time`)}
          {unrecognized ? <span className={styles.tallyNote}>{vi ? ` · ${unrecognized} câu hệ thống chưa nhận ra, không tính` : ` · ${unrecognized} not recognised, not counted`}</span> : null}
        </p>
      </header>

      <ol className={styles.dots} aria-label={vi ? 'Các câu luyện tập' : 'Practice questions'}>
        {exercises.map((e, i) => {
          const o = done[e.id];
          return (
            <li key={e.id}>
              <button type="button" className={styles.dot} data-at={i === at ? 'true' : 'false'} data-outcome={o ?? 'none'} aria-label={dotLabel(e, i)} aria-current={i === at ? 'step' : undefined} onClick={() => setAt(i)}>
                {o === 'CORRECT' || o === 'ACCEPTABLE' ? <Check aria-hidden="true" /> : o === 'WRONG' ? <X aria-hidden="true" /> : o === 'PARTIAL' ? <Minus aria-hidden="true" /> : o === 'UNRECOGNIZED' ? <CircleHelp aria-hidden="true" /> : o ? <Eye aria-hidden="true" /> : <span aria-hidden="true">{i + 1}</span>}
              </button>
            </li>
          );
        })}
      </ol>

      {!finished && ex ? (
        <div className={styles.practiceCard}>
          <p className={styles.practiceCount}>{vi ? `Câu ${at + 1} trên ${total}` : `Question ${at + 1} of ${total}`}</p>
          <ExerciseCard key={ex.id} exercise={ex} topic={topic.slug} onResult={onResult} />
          <div className={styles.practiceNav}>
            <button type="button" className={cx(styles.btn, styles.btnQuiet)} onClick={() => setAt(Math.max(0, at - 1))} disabled={at === 0}>{vi ? 'Câu trước' : 'Previous'}</button>
            <button type="button" className={cx(styles.btn, styles.btnSoft)} onClick={() => setAt(at + 1)}>{at === total - 1 ? (vi ? 'Xong phần luyện tập' : 'Finish practice') : (vi ? 'Câu sau' : 'Next')}<ChevronRight aria-hidden="true" /></button>
          </div>
        </div>
      ) : (
        <div className={styles.practiceDone}>
          <h3 className={styles.finishTitle}>{vi ? 'Bạn đã đi hết các câu luyện tập' : 'You have been through all the practice questions'}</h3>
          <p className={styles.finishText}>
            {answered
              ? (vi ? `Bạn đã trả lời ${answered} trên ${total} câu, ${right} câu đúng. Luyện tập giúp bạn quen với chủ đề; kết quả chỉ được ghi là “đã nắm” sau bài kiểm tra.` : `You answered ${answered} of ${total}, ${right} right. Practice builds familiarity; a topic is recorded as mastered only after the check.`)
              : (vi ? 'Bạn chưa trả lời câu nào. Quay lại câu đầu để thử, hoặc làm bài kiểm tra.' : 'You have not answered any yet. Go back to the first question, or take the check.')}
          </p>
          <div className={styles.finishActions}>
            <button type="button" className={cx(styles.btn, styles.btnSoft)} onClick={() => setAt(0)}><RotateCcw aria-hidden="true" />{vi ? 'Làm lại từ câu đầu' : 'Back to the first question'}</button>
            <button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={onCheck} disabled={starting}><ClipboardCheck aria-hidden="true" />{vi ? 'Kiểm tra chủ đề này' : 'Check this topic'}</button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ═══ mistakes, FAQ ══════════════════════════════════════════════════════════════════════════════════════════════════ */
function MistakeList({ mistakes }: { mistakes: Topic['mistakes'] }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  return (
    <section id="mistakes" tabIndex={-1} className={cx(styles.section, styles.anchor, v.lessonSection)} aria-labelledby="mistakes-t">
      <header className={styles.sectionHead}>
        <h2 id="mistakes-t" className={styles.sectionTitle}>{vi ? 'Lỗi thường gặp' : 'Common mistakes'}</h2>
      </header>
      <ul className={styles.mistakes}>
        {mistakes.map((m) => (
          <li key={m.id} className={styles.mistake}>
            <div className={styles.mPair}>
              <p className={styles.mWrong}><X aria-hidden="true" /><span className={styles.mWrongText} lang="en">{m.wrong}</span><span className={styles.srOnly}>{vi ? ' (sai)' : ' (wrong)'}</span></p>
              <p className={styles.mRight}><Check aria-hidden="true" /><span lang="en">{m.right}</span><span className={styles.srOnly}>{vi ? ' (đúng)' : ' (right)'}</span></p>
            </div>
            <p className={styles.mWhy}><Vi text={m.why} /></p>
            {m.vn ? <p className={styles.mVn}><span>{vi ? 'Người Việt hay gặp' : 'Common for Vietnamese speakers'}</span><Vi text={m.vn} /></p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function FaqList({ faq }: { faq: Topic['faq'] }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  return (
    <section id="faq" tabIndex={-1} className={cx(styles.section, styles.anchor, v.lessonSection)} aria-labelledby="faq-t">
      <header className={styles.sectionHead}>
        <h2 id="faq-t" className={styles.sectionTitle}>{vi ? 'Câu hỏi thường gặp' : 'Frequently asked'}</h2>
      </header>
      <div className={styles.faq}>
        {faq.map((f, i) => (
          <details key={i} className={styles.faqItem}>
            <summary className={styles.faqQ}><CircleHelp aria-hidden="true" /><Vi text={f.q} /></summary>
            <p className={styles.faqA}><Vi text={f.a} /></p>
          </details>
        ))}
      </div>
    </section>
  );
}

/* ═══ related, prerequisites, sources, report ════════════════════════════════════════════════════════════════════════ */
function RelatedSections({ topic, index, me }: { topic: Topic; index: ReturnType<typeof topicIndex>; me: ReturnType<typeof useGrammarMe>['data'] }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const groups = REL_ORDER
    .map((rel) => ({ rel, items: (topic.related ?? []).filter((r) => r.rel === rel && index.has(r.slug)) }))
    .filter((g) => g.items.length);
  const prereq = (topic.prerequisites ?? []).filter((s) => index.has(s));
  const link = (slug: string, key: string) => {
    const e = index.get(slug);
    if (!e) return null;
    const title = vi ? e.topic.title.vi : e.topic.title.en;
    const st = stateOf(me, slug);
    const body = (
      <span className={styles.relBody}>
        <span className={styles.relTitle}>{title}</span>
        <span className={styles.relMeta}>
          <span className={styles.relLevel}>{levelLabel(e.topic.level)}</span>
          {e.topic.available ? (st ? <span className={styles.relState}>{statusLabel(st.status, vi)}</span> : null) : <span className={styles.relState}>{vi ? 'Đang biên soạn' : 'Being written'}</span>}
        </span>
      </span>
    );
    return e.topic.available
      ? <li key={key}><Link href={`/grammar/topics/${encodeURIComponent(slug)}`} className={styles.relCard}>{body}<ChevronRight aria-hidden="true" /></Link></li>
      : <li key={key}><span className={styles.relCard} data-muted="true" aria-disabled="true">{body}</span></li>;
  };
  if (!groups.length && !prereq.length) return null;
  return (
    <section id="related" tabIndex={-1} className={cx(styles.section, styles.anchor, v.lessonSection)} aria-labelledby="related-t">
      <header className={styles.sectionHead}>
        <h2 id="related-t" className={styles.sectionTitle}>{vi ? 'Bài liên quan' : 'Related lessons'}</h2>
      </header>
      {prereq.length ? (
        <div className={styles.relGroup}>
          <h3 className={styles.relHead}>{vi ? 'Nên học trước' : 'Best learned first'}</h3>
          <ul className={styles.relList}>{prereq.map((s) => link(s, `p-${s}`))}</ul>
        </div>
      ) : null}
      {groups.map((g) => (
        <div key={g.rel} className={styles.relGroup}>
          <h3 className={styles.relHead}>{relLabel(g.rel, vi)}</h3>
          <ul className={styles.relList}>{g.items.map((r) => link(r.slug, `${g.rel}-${r.slug}`))}</ul>
        </div>
      ))}
    </section>
  );
}

function SourcesAndReport({ topic }: { topic: Topic }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const send = async () => {
    const message = text.trim();
    if (!message || phase === 'sending') return;
    setPhase('sending');
    try {
      await grammarApi.report({ kind: 'CONTENT', topic: topic.slug, message });
      setPhase('sent');
      setText('');
    } catch {
      setPhase('failed');
    }
  };

  return (
    <section className={cx(styles.section, styles.sources)} aria-labelledby={`${uid}-t`}>
      <header className={styles.sectionHead}>
        <h2 id={`${uid}-t`} className={styles.sectionTitle}>{vi ? 'Nguồn tham khảo' : 'References'}</h2>
      </header>
      <p className={styles.fine}>{vi ? 'Tài liệu tham khảo cho mảng kiến thức này; nội dung bài do English Coach tự biên soạn.' : 'Works to read for this area of knowledge; the lesson itself was written by English Coach.'}</p>
      <ul className={styles.srcList}>
        {topic.sources.map((s, i) => (
          <li key={i}><span className={styles.srcName}>{sourceName(s.ref, vi)}</span>{s.note ? <span className={styles.srcNote}>{s.note}</span> : null}</li>
        ))}
      </ul>

      <div className={styles.report}>
        {!open ? (
          <button type="button" className={cx(styles.btn, styles.btnQuiet, styles.btnSm)} onClick={() => { setOpen(true); setPhase('idle'); }}>
            <Flag aria-hidden="true" />{vi ? 'Báo lỗi nội dung' : 'Report a content error'}
          </button>
        ) : (
          <div className={styles.reportBox}>
            <label htmlFor={`${uid}-r`} className={styles.fieldLabel}>{vi ? 'Bạn thấy điều gì chưa đúng trong bài này?' : 'What looks wrong in this lesson?'}</label>
            <textarea
              id={`${uid}-r`}
              className={styles.input}
              rows={3}
              maxLength={800}
              value={text}
              onChange={(e) => { setText(e.target.value); if (phase !== 'sending') setPhase('idle'); }}
              placeholder={vi ? 'Ví dụ: ví dụ thứ hai trong phần Bài học nghe chưa tự nhiên vì…' : 'For example: the second example in the Lesson sounds unnatural because…'}
            />
            <div className={styles.reportActions}>
              <button type="button" className={cx(styles.btn, styles.btnSoft, styles.btnSm)} onClick={send} disabled={!text.trim() || phase === 'sending'}>
                {phase === 'sending' ? <Loader2 className={styles.spin} aria-hidden="true" /> : <Flag aria-hidden="true" />}{vi ? 'Gửi báo lỗi' : 'Send report'}
              </button>
              <button type="button" className={cx(styles.btn, styles.btnQuiet, styles.btnSm)} onClick={() => { setOpen(false); setPhase('idle'); }}>{vi ? 'Đóng' : 'Close'}</button>
            </div>
            <p className={styles.reportMsg} role="status" aria-live="polite">
              {phase === 'sent' ? (vi ? 'Cảm ơn bạn. Báo lỗi đã được gửi để xem lại.' : 'Thank you. Your report was sent for review.') : null}
              {phase === 'failed' ? (vi ? 'Chưa gửi được. Hãy thử lại.' : 'Could not send. Please try again.') : null}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/* ═══ table of contents ══════════════════════════════════════════════════════════════════════════════════════════════ */
function Toc({ items }: { items: { id: string; text: string }[] }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const [active, setActive] = useState<string | null>(null);
  const key = items.map((i) => i.id).join('|');

  useEffect(() => {
    const main = scroller();
    const els = items.map((i) => document.getElementById(i.id)).filter(Boolean) as HTMLElement[];
    if (!els.length || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting) visible.add(e.target.id); else visible.delete(e.target.id); }
      const first = items.find((i) => visible.has(i.id));
      if (first) setActive(first.id);
    }, { root: main, rootMargin: '-96px 0px -62% 0px', threshold: 0 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const go = (id: string) => (e: React.MouseEvent) => {
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    const calm = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    if (el.hasAttribute('tabindex')) el.focus({ preventScroll: true });
    setActive(id);
  };

  if (items.length < 2) return null;
  return (
    <nav className={cx(styles.toc, v.contents)} aria-label={vi ? 'Trong bài này' : 'On this page'}>
      <p className={styles.eyebrow}>{vi ? 'Trong bài này' : 'On this page'}</p>
      <ol className={styles.tocList}>
        {items.map((i) => (
          <li key={i.id}>
            <a href={`#${i.id}`} className={styles.tocLink} data-on={active === i.id ? 'true' : 'false'} aria-current={active === i.id ? 'location' : undefined} onClick={go(i.id)}>{i.text}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/* ═══ loading ════════════════════════════════════════════════════════════════════════════════════════════════════════ */
function TopicSkeleton() {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  return (
    <div className={cx(styles.topic, v.view)} aria-busy="true" aria-label={vi ? 'Đang tải bài học' : 'Loading the lesson'}>
      <div className={cx(styles.mast, styles.mastSkeleton)}>
        <div className={cx(styles.mastBody, v.lessonBody)}>
          <span className={cx(styles.skel, styles.skelLine)} style={{ width: '9rem' }} />
          <span className={cx(styles.skel, styles.skelTitle)} />
          <span className={cx(styles.skel, styles.skelLine)} style={{ width: '60%' }} />
          <span className={cx(styles.skel, styles.skelLine)} style={{ width: '82%' }} />
          <span className={cx(styles.skel, styles.skelBtn)} />
        </div>
      </div>
      <div className={styles.skelBlocks}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={styles.skelBlock}>
            <span className={cx(styles.skel, styles.skelLine)} style={{ width: '90%' }} />
            <span className={cx(styles.skel, styles.skelLine)} style={{ width: '74%' }} />
            <span className={cx(styles.skel, styles.skelLine)} style={{ width: '55%' }} />
          </div>
        ))}
      </div>
      <span className={styles.srOnly}>{vi ? 'Đang tải…' : 'Loading…'}</span>
    </div>
  );
}

export default TopicPage;
