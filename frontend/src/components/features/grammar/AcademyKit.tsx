'use client';

import React, { useRef } from 'react';
import Link from 'next/link';
import { Bookmark, ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, Clock, RotateCcw, SearchX } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { isBookmarked, isDue, stateOf, type TopicEntry } from '@/hooks/useGrammar';
import { cx, levelLabel, statusLabel, statusTone } from '@/lib/grammar/format';
import { highlight, type Via } from '@/lib/grammar/search';
import type { GrammarMe, Level } from '@/types/grammar';
import g from './grammar.module.css';
import a from './academy.module.css';

/** The learner's language: every label in part C exists in Vietnamese and English. */
export function useVi(): boolean {
  return useLanguage().locale === 'vi';
}

/** A level's customary name. A teaching suggestion, never a certificate. */
const LEVEL_NAME: Record<Level, { vi: string; en: string }> = {
  preA1: { vi: 'Làm quen', en: 'Getting started' },
  A1: { vi: 'Sơ cấp', en: 'Beginner' },
  A2: { vi: 'Cơ bản', en: 'Elementary' },
  B1: { vi: 'Trung cấp', en: 'Intermediate' },
  B2: { vi: 'Trên trung cấp', en: 'Upper intermediate' },
  C1: { vi: 'Nâng cao', en: 'Advanced' },
  C2: { vi: 'Thành thạo', en: 'Mastery' },
};
export const levelName = (level: Level, vi: boolean): string => (vi ? LEVEL_NAME[level].vi : LEVEL_NAME[level].en);

/** The three application tracks: the route, the catalog domain behind it and the mixed practice it starts. */
export type TrackId = 'ielts' | 'toeic' | 'real-world';
export const TRACK_IDS: TrackId[] = ['ielts', 'toeic', 'real-world'];
export const TRACKS: Record<TrackId, {
  href: string; domain: string; tone: string; name: { vi: string; en: string }; not: { vi: string; en: string };
  check: { kind: 'IELTS' | 'TOEIC' | 'DOMAIN'; scope?: string };
}> = {
  ielts: {
    href: '/grammar/ielts', domain: 'ielts', tone: 'sun', name: { vi: 'IELTS', en: 'IELTS' },
    not: { vi: 'Không phải bài chấm band.', en: 'Not a band score.' }, check: { kind: 'IELTS' },
  },
  toeic: {
    href: '/grammar/toeic', domain: 'toeic', tone: 'harbor', name: { vi: 'TOEIC', en: 'TOEIC' },
    not: { vi: 'Không quy đổi thành điểm TOEIC.', en: 'No TOEIC score conversion.' }, check: { kind: 'TOEIC' },
  },
  'real-world': {
    href: '/grammar/real-world', domain: 'communication', tone: 'meadow', name: { vi: 'Đời thực', en: 'Real life' },
    not: { vi: 'Chỉ phần ngữ pháp, không phải khoá giao tiếp.', en: 'Grammar only, not a speaking course.' }, check: { kind: 'DOMAIN', scope: 'communication' },
  },
};

/** A server number: the value, "…" while it loads, "—" when it could not be read. Never a placeholder 0. */
export function num(value: number | null | undefined, wait: boolean): string {
  if (typeof value === 'number') return String(value);
  return wait ? '…' : '—';
}

/** The title in the learner's language first, the other one quieter. */
export const pair = (t: { vi: string; en: string }, vi: boolean) => (vi ? { main: t.vi, other: t.en } : { main: t.en, other: t.vi });

/* ── status ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */
const STATE_ICON = { good: CircleCheck, due: RotateCcw, progress: CircleDot, neutral: Circle } as const;

/** A topic's learning state in words AND an icon (never colour alone). The words are the server's; nothing is inferred. */
export function StateChip({ me, slug, vi }: { me: GrammarMe | undefined | null; slug: string; vi: boolean }) {
  const state = stateOf(me, slug);
  const due = isDue(me, slug);
  if (!state && !due) return null;
  const status = due ? 'REVIEW_DUE' : state!.status;
  const tone = statusTone(status);
  const Icon = STATE_ICON[tone];
  return (
    <span className={g.chip} data-state={tone === 'neutral' ? undefined : tone}>
      <Icon aria-hidden="true" />{statusLabel(status, vi)}
    </span>
  );
}

/* ── states of a list or a page ─────────────────────────────────────────────────────────────────────────────────────── */
export function ErrorState({ vi, onRetry, title, text }: { vi: boolean; onRetry?: () => void; title?: string; text?: string }) {
  return (
    <div className={g.stateBox} role="alert">
      <span className={g.stateIcon} aria-hidden="true"><CircleAlert /></span>
      <h2 className={g.stateTitle}>{title ?? (vi ? 'Chưa tải được dữ liệu' : 'Could not load this')}</h2>
      <p className={g.stateText}>{text ?? (vi ? 'Kết nối bị gián đoạn. Dữ liệu học của bạn không bị mất.' : 'The connection was interrupted. Nothing of yours is lost.')}</p>
      {onRetry ? (
        <div className={g.stateActions}>
          <button type="button" className={cx(g.btn, g.btnPrimary)} onClick={onRetry}><RotateCcw aria-hidden="true" />{vi ? 'Thử lại' : 'Try again'}</button>
        </div>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, text, children, icon }: { title: string; text: string; children?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className={g.stateBox} role="status">
      <span className={g.stateIcon} aria-hidden="true">{icon ?? <SearchX />}</span>
      <h2 className={g.stateTitle}>{title}</h2>
      <p className={g.stateText}>{text}</p>
      {children ? <div className={g.stateActions}>{children}</div> : null}
    </div>
  );
}

export function RowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', marginTop: '1.5rem' }}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className={cx(g.skel, g.skelLine)} style={{ height: '2.6rem', width: `${92 - (i % 3) * 9}%` }} />
      ))}
    </div>
  );
}

export function CardsSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div className={a.items} aria-hidden="true">
      {Array.from({ length: cards }, (_, i) => <span key={i} className={g.skel} style={{ height: '9.5rem', borderRadius: '1.4rem' }} />)}
    </div>
  );
}

/* ── a segmented control with radio semantics (arrow keys move the choice) ───────────────────────────────────────────── */
export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { id: T; label: React.ReactNode; text?: string }[]; onChange: (id: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, step: number) => {
    const n = options.length;
    const to = (from + step + n) % n;
    onChange(options[to].id);
    refs.current[to]?.focus();
  };
  return (
    <div className={a.seg} role="radiogroup" aria-label={label}>
      {options.map((o, i) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.text}
            tabIndex={on ? 0 : -1}
            className={a.segBtn}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(i, 1); }
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(i, -1); }
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── matched words marked ───────────────────────────────────────────────────────────────────────────────────────────── */
export function Hl({ text, tokens }: { text: string; tokens?: string[] }) {
  if (!tokens?.length) return <>{text}</>;
  return (
    <>
      {highlight(text, tokens).map((p, i) => (p.hit ? <mark key={i} className={a.hl}>{p.t}</mark> : <React.Fragment key={i}>{p.t}</React.Fragment>))}
    </>
  );
}

/* ── one topic as a line of the book's index ─────────────────────────────────────────────────────────────────────────── */
export function TopicRow({ entry, me, tokens, via, viaText, vi, showTone = true }: {
  entry: TopicEntry; me?: GrammarMe | null; tokens?: string[]; via?: Via; viaText?: string | null; vi: boolean; showTone?: boolean;
}) {
  const { topic, domain } = entry;
  const t = pair(topic.title, vi);
  const off = !topic.available;
  const body = (
    <>
      <span className={a.idxLevel}>{levelLabel(topic.level)}</span>
      <span className={a.idxMain}>
        <span className={a.idxTitle} lang={vi ? 'vi' : 'en'}><Hl text={t.main} tokens={tokens} /></span>
        <span className={a.idxSub} lang={vi ? 'en' : 'vi'}><Hl text={t.other} tokens={tokens} /></span>
        {viaText && (via === 'alias' || via === 'mistake') ? (
          <span className={a.idxVia}>{via === 'alias' ? (vi ? 'Khớp với từ khoá: ' : 'Matches the keyword: ') : (vi ? 'Khớp với lỗi hay gặp: ' : 'Matches a common mistake: ')}<span lang="en"><Hl text={viaText} tokens={tokens} /></span></span>
        ) : null}
      </span>
      <span className={a.idxLeader} aria-hidden="true" />
      <span className={a.idxMeta}>
        {off ? <span className={g.chip}><Clock aria-hidden="true" />{vi ? 'Đang biên soạn' : 'In preparation'}</span> : <StateChip me={me} slug={topic.slug} vi={vi} />}
        {topic.exam?.ielts ? <span className={g.chip}>IELTS</span> : null}
        {topic.exam?.toeic ? <span className={g.chip}>TOEIC</span> : null}
        {isBookmarked(me, topic.slug) ? <span className={g.chip}><Bookmark aria-hidden="true" />{vi ? 'Đã lưu' : 'Saved'}</span> : null}
      </span>
    </>
  );
  return (
    <li className={a.idxRow} data-tone={showTone ? domain.tone : undefined} data-off={off ? 'true' : undefined}>
      {off ? <div className={a.idxPlain}>{body}</div> : <Link href={`/grammar/topics/${encodeURIComponent(topic.slug)}`} className={a.idxLink}>{body}</Link>}
    </li>
  );
}

export function Crumbs({ items, vi }: { items: { href?: string; label: string }[]; vi: boolean }) {
  return (
    <nav className={a.crumbs} aria-label={vi ? 'Đường dẫn' : 'Breadcrumb'}>
      {items.map((it, i) => (
        <React.Fragment key={it.label}>
          {i > 0 ? <ChevronRight aria-hidden="true" /> : null}
          {it.href ? <Link href={it.href}>{it.label}</Link> : <span aria-current="page">{it.label}</span>}
        </React.Fragment>
      ))}
    </nav>
  );
}

/* ── the chapter header every index page opens with (a motif at the right, never decoration the page depends on) ─────── */
type MotifKind = 'lab' | 'story' | 'detective' | 'library' | 'track';

function Motif({ kind }: { kind: MotifKind }) {
  return (
    <svg className={a.motif} viewBox="0 0 220 150" aria-hidden="true" focusable="false">
      {kind === 'lab' ? (
        <g>
          {[28, 68, 108].map((y, i) => (
            <g key={y}>
              <rect className={a.mSoft} x="14" y={y} width="190" height="26" rx="13" />
              <rect className={a.mStroke} x="14" y={y} width="190" height="26" rx="13" />
              <circle className={a.mFill} cx={[46, 150, 98][i]} cy={y + 13} r="10" />
              <circle className={a.mStroke} cx={[46, 150, 98][i]} cy={y + 13} r="10" />
            </g>
          ))}
        </g>
      ) : null}
      {kind === 'story' ? (
        <g>
          <path className={a.mSoft} d="M24 26h104a14 14 0 0 1 14 14v34a14 14 0 0 1-14 14H64l-22 18V88H24a14 14 0 0 1-14-14V40a14 14 0 0 1 14-14z" />
          <path className={a.mStroke} d="M24 26h104a14 14 0 0 1 14 14v34a14 14 0 0 1-14 14H64l-22 18V88H24a14 14 0 0 1-14-14V40a14 14 0 0 1 14-14z" />
          <path className={a.mFill} d="M104 76h84a14 14 0 0 1 14 14v26a14 14 0 0 1-14 14h-10v14l-18-14h-56a14 14 0 0 1-14-14V90a14 14 0 0 1 14-14z" />
          <path className={a.mStroke} d="M104 76h84a14 14 0 0 1 14 14v26a14 14 0 0 1-14 14h-10v14l-18-14h-56a14 14 0 0 1-14-14V90a14 14 0 0 1 14-14z" />
          <path className={a.mStroke} d="M30 48h80M30 64h52" />
        </g>
      ) : null}
      {kind === 'detective' ? (
        <g>
          <path className={a.mStroke} d="M16 112h120M16 132h80" />
          <path className={a.mStroke} d="M16 24h70M16 44h96M16 64h54" />
          <circle className={a.mSoft} cx="148" cy="62" r="40" />
          <circle className={a.mStroke} cx="148" cy="62" r="40" />
          <path className={a.mStroke} d="M178 92l28 34" strokeWidth="7" />
          <path className={a.mStroke} d="M132 62q8 14 32 0" />
        </g>
      ) : null}
      {kind === 'library' ? (
        <g>
          {[[18, 60, 26], [48, 36, 30], [82, 52, 22], [108, 24, 34], [146, 44, 26], [176, 66, 24]].map(([x, y, w], i) => (
            <g key={x}>
              <rect className={i % 2 ? a.mSoft : a.mFill} x={x} y={y} width={w} height={140 - y} rx="5" />
              <rect className={a.mStroke} x={x} y={y} width={w} height={140 - y} rx="5" />
            </g>
          ))}
        </g>
      ) : null}
      {kind === 'track' ? (
        <g>
          <circle className={a.mSoft} cx="110" cy="75" r="62" />
          <circle className={a.mStroke} cx="110" cy="75" r="62" />
          <circle className={a.mStroke} cx="110" cy="75" r="38" />
          <circle className={a.mFill} cx="110" cy="75" r="14" />
          <path className={a.mStroke} d="M110 75l52-46M150 29h14v14" />
        </g>
      ) : null}
    </svg>
  );
}

export function ChapterHead({ eyebrow, title, lead, tone, motif, children }: {
  eyebrow: string; title: string; lead?: string; tone: string; motif: MotifKind; children?: React.ReactNode;
}) {
  return (
    <header className={a.chapter} data-tone={tone}>
      <Motif kind={motif} />
      <div className={a.chapterBody}>
        <p className={g.eyebrow} style={{ margin: 0 }}>{eyebrow}</p>
        <h1 className={a.chapterTitle}>{title}</h1>
        {lead ? <p className={a.chapterLead}>{lead}</p> : null}
        {children}
      </div>
    </header>
  );
}
