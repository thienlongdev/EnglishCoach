'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Bookmark, RotateCcw, Search, X } from 'lucide-react';
import { LEVELS, cx, levelLabel } from '@/lib/grammar/format';
import { buildSearchIndex, search, tokenize, type SearchHit } from '@/lib/grammar/search';
import { isBookmarked, isDue, stateOf, useGrammarMe, useTopicIndex, type TopicEntry } from '@/hooks/useGrammar';
import type { CatalogDomain, GrammarMe, Level, LearningRole } from '@/types/grammar';
import { ChapterHead, EmptyState, ErrorState, RowsSkeleton, Segmented, TopicRow, pair, useVi } from './AcademyKit';
import g from './grammar.module.css';
import v from './subviews.module.css';
import a from './academy.module.css';

const PAGE = 60;
const STATUSES = ['any', 'new', 'learning', 'mastered', 'due'] as const;
const ROLES: LearningRole[] = ['core', 'advanced', 'reference', 'application'];
type StatusId = (typeof STATUSES)[number];
type ExamId = '' | 'ielts' | 'toeic';
const LEARNING = new Set(['OPENED', 'STUDIED', 'PRACTISING', 'READY']);

function matchesStatus(me: GrammarMe | undefined, slug: string, status: StatusId): boolean {
  if (status === 'any') return true;
  const st = stateOf(me, slug);
  const due = isDue(me, slug);
  if (status === 'due') return due || st?.status === 'NEEDS_REVIEW';
  if (status === 'mastered') return !due && st?.status === 'MASTERED';
  if (status === 'new') return !st;
  return !!st && !due && LEARNING.has(st.status);
}

interface Row { entry: TopicEntry; via?: SearchHit['via']; viaText?: string | null }

/**
 * `/grammar/library`: the whole reference as the index of a book. Search is local and instant (no request): diacritics and case
 * are folded, Vietnamese and English both work, and matched words are marked. Every filter lives in the query string (`q`,
 * `domain`, `level`, `exam`, `status`, `bm`, `lessons`) so a view can be shared, refreshed and walked with Back and Forward.
 */
export function Library() {
  const vi = useVi();
  const router = useRouter();
  const pathname = usePathname() || '/grammar/library';
  const sp = useSearchParams();
  const { index, catalog, error, isLoading, mutate } = useTopicIndex();
  const { data: me, error: meError } = useGrammarMe();
  const meWait = !me && !meError;
  const docs = useMemo(() => buildSearchIndex(index.values()), [index]);

  /* the query string is the source of truth for every filter; the text box keeps its own copy so typing is instant */
  const domainRaw = sp.get('domain') ?? '';
  const domain = catalog?.domains.some((d) => d.id === domainRaw) ? domainRaw : '';
  const levelRaw = sp.get('level') ?? '';
  const level = (LEVELS as string[]).includes(levelRaw) ? (levelRaw as Level) : '';
  const examRaw = sp.get('exam');
  const exam: ExamId = examRaw === 'ielts' || examRaw === 'toeic' ? examRaw : '';
  const statusRaw = sp.get('status') as StatusId | null;
  const status: StatusId = statusRaw && (STATUSES as readonly string[]).includes(statusRaw) ? statusRaw : 'any';
  const bm = sp.get('bm') === '1';
  const lessons = sp.get('lessons') === '1';
  const roleRaw = sp.get('role') as LearningRole | null;
  const role = roleRaw && ROLES.includes(roleRaw) ? roleRaw : '';
  const urlQ = sp.get('q') ?? '';

  const setParams = useCallback((patch: Record<string, string | null>, mode: 'push' | 'replace' = 'push') => {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    const qs = next.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    if (mode === 'replace') router.replace(url, { scroll: false }); else router.push(url, { scroll: false });
  }, [pathname, router]);

  const [q, setQ] = useState(urlQ);
  const written = useRef(urlQ);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { if (urlQ !== written.current) { written.current = urlQ; setQ(urlQ); } }, [urlQ]);
  useEffect(() => {
    if (q === written.current) return;
    searchTimer.current = setTimeout(() => { searchTimer.current = null; written.current = q; setParams({ q: q.trim() ? q : null }, 'replace'); }, 350);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [q, setParams]);

  // A result can be clicked before the debounce fires. Cancel it before Next/Morph starts the trip;
  // waiting for unmount would let a stale library URL replace the destination during the transition.
  const leavingLibrary = (event: React.MouseEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest('a[href]')) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = null;
    written.current = q;
  };

  const searching = tokenize(q).length > 0;
  const tokens = useMemo(() => tokenize(q), [q]);
  const needsMe = status !== 'any' || bm;

  const rows = useMemo<Row[]>(() => {
    const ok = (e: TopicEntry) =>
      (!domain || e.domain.id === domain)
      && (!level || e.topic.level === level)
      && (!exam || !!e.topic.exam?.[exam])
      && (!lessons || e.topic.available)
      && (!role || e.topic.learningRole === role)
      && (!bm || isBookmarked(me, e.topic.slug))
      && matchesStatus(me, e.topic.slug, status);
    const hits = search(docs, q);
    if (hits) return hits.filter((h) => ok(h.entry)).map((h) => ({ entry: h.entry, via: h.via, viaText: h.viaText }));
    return docs.filter((d) => ok(d.entry)).map((d) => ({ entry: d.entry }));
  }, [docs, q, domain, level, exam, lessons, role, bm, status, me]);

  const [limit, setLimit] = useState(PAGE);
  const signature = [q, domain, level, exam, status, bm, lessons, role].join('|');
  useEffect(() => { setLimit(PAGE); }, [signature]);

  const groups = useMemo(() => {
    if (searching) return null;
    const by = new Map<string, Row[]>();
    for (const r of rows) { const list = by.get(r.entry.domain.id); if (list) list.push(r); else by.set(r.entry.domain.id, [r]); }
    return (catalog?.domains ?? []).filter((d) => by.has(d.id)).map((d) => ({ domain: d, rows: by.get(d.id) as Row[] }));
  }, [rows, searching, catalog]);

  const active = !!(q.trim() || domain || level || exam || status !== 'any' || bm || lessons || role);
  const clearAll = () => { written.current = ''; setQ(''); setParams({ q: null, domain: null, level: null, exam: null, status: null, bm: null, lessons: null, role: null }); };
  const ready = rows.filter((r) => r.entry.topic.available).length;

  const statusLabels: Record<StatusId, string> = vi
    ? { any: 'Mọi trạng thái', new: 'Chưa mở', learning: 'Đang học', mastered: 'Đã nắm', due: 'Cần ôn lại' }
    : { any: 'Any status', new: 'Not opened', learning: 'Studying', mastered: 'Mastered', due: 'Needs review' };

  return (
    <div className={cx(a.page, v.view)} onClickCapture={leavingLibrary}>
      <ChapterHead
        eyebrow={vi ? 'Thư viện' : 'Library'}
        title={vi ? 'Mục lục Ngữ pháp' : 'The grammar index'}
        lead={vi ? 'Mọi chủ đề trong một mục lục. Việc tìm diễn ra ngay trên máy bạn: gõ có dấu hay không dấu, tiếng Việt hay tiếng Anh đều được.' : 'Every topic in one index. Searching happens right on your device: with or without Vietnamese accents, in Vietnamese or English.'}
        tone="pearl"
        motif="library"
      />

      <section className={cx(a.lbBar, v.filterPanel)} aria-label={vi ? 'Tìm và lọc' : 'Search and filter'}>
        <div className={cx(a.lbSearch, v.search)} role="search" data-guide="grammar-search">
          <Search aria-hidden="true" />
          <label htmlFor="gr-lib-q" className={g.srOnly}>{vi ? 'Tìm trong thư viện Ngữ pháp' : 'Search the grammar library'}</label>
          <input
            id="gr-lib-q"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={vi ? 'Tìm “since for”, “mạo từ”, “đã từng”, một lỗi hay gặp…' : 'Search “since for”, “articles”, “đã từng”, a common mistake…'}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
          />
          {q ? (
            <button type="button" className={a.lbClear} aria-label={vi ? 'Xoá từ khoá' : 'Clear the search'} onClick={() => { written.current = ''; setQ(''); setParams({ q: null }, 'replace'); }}><X aria-hidden="true" /></button>
          ) : null}
        </div>

        <div className={cx(a.lbFilters, v.filters)}>
          <div className={a.lbField}>
            <label htmlFor="gr-lib-role">{vi ? 'Mục đích học' : 'Study focus'}</label>
            <select id="gr-lib-role" className={a.lbSelect} value={role} onChange={(e) => setParams({ role: e.target.value || null })}>
              <option value="">{vi ? 'Toàn bộ thư viện' : 'Full reference library'}</option>
              <option value="core">{vi ? 'Kiến thức trọng tâm' : 'Essential core'}</option>
              <option value="advanced">{vi ? 'Mở rộng hữu ích' : 'Useful advanced study'}</option>
              <option value="reference">{vi ? 'Tra cứu chuyên biệt' : 'Specialist reference'}</option>
              <option value="application">{vi ? 'Ứng dụng theo mục tiêu' : 'Goal-based application'}</option>
            </select>
          </div>
          <div className={a.lbField}>
            <label htmlFor="gr-lib-domain">{vi ? 'Mảng kiến thức' : 'Area'}</label>
            <select id="gr-lib-domain" className={a.lbSelect} value={domain} onChange={(e) => setParams({ domain: e.target.value || null })}>
              <option value="">{vi ? 'Tất cả các mảng' : 'All areas'}</option>
              {(catalog?.domains ?? []).map((d: CatalogDomain) => <option key={d.id} value={d.id}>{pair(d.title, vi).main}</option>)}
            </select>
          </div>
          <div className={a.lbField}>
            <span id="gr-lib-level">{vi ? 'Cấp độ gợi ý' : 'Suggested level'}</span>
            <Segmented<string>
              label={vi ? 'Cấp độ gợi ý' : 'Suggested level'}
              value={level}
              options={[{ id: '', label: vi ? 'Tất cả' : 'All' }, ...LEVELS.map((l) => ({ id: l as string, label: levelLabel(l) }))]}
              onChange={(v) => setParams({ level: v || null })}
            />
          </div>
          <div className={a.lbField}>
            <span>{vi ? 'Kỳ thi' : 'Exam'}</span>
            <Segmented<ExamId>
              label={vi ? 'Lọc theo kỳ thi' : 'Filter by exam'}
              value={exam}
              options={[{ id: '', label: vi ? 'Tất cả' : 'All' }, { id: 'ielts', label: 'IELTS' }, { id: 'toeic', label: 'TOEIC' }]}
              onChange={(v) => setParams({ exam: v || null })}
            />
          </div>
          <div className={a.lbField}>
            <label htmlFor="gr-lib-status">{vi ? 'Trạng thái của bạn' : 'Your status'}</label>
            <select id="gr-lib-status" className={a.lbSelect} value={status} disabled={!!meError} onChange={(e) => setParams({ status: e.target.value === 'any' ? null : e.target.value })}>
              {STATUSES.map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}
            </select>
          </div>
          <div className={a.lbField}>
            <span>{vi ? 'Hiển thị' : 'Show'}</span>
            <div className={a.lbToggles}>
              <button type="button" className={cx(g.btn, g.btnQuiet, g.btnSm)} aria-pressed={bm} disabled={!!meError} onClick={() => setParams({ bm: bm ? null : '1' })}>
                <Bookmark aria-hidden="true" />{vi ? 'Đã lưu' : 'Saved'}
              </button>
              <button type="button" className={cx(g.btn, g.btnQuiet, g.btnSm)} aria-pressed={lessons} onClick={() => setParams({ lessons: lessons ? null : '1' })}>
                {vi ? 'Chỉ bài đã có' : 'With a lesson'}
              </button>
              {active ? (
                <button type="button" className={cx(g.btn, g.btnSoft, g.btnSm)} onClick={clearAll}><RotateCcw aria-hidden="true" />{vi ? 'Xoá bộ lọc' : 'Clear filters'}</button>
              ) : null}
            </div>
          </div>
        </div>
        {meError && needsMe ? <p className={g.callout} data-tone="warn" role="alert">{vi ? 'Chưa tải được tiến độ của bạn nên chưa lọc theo trạng thái và mục đã lưu được.' : 'Your progress could not be loaded, so status and saved filters cannot apply yet.'}</p> : null}
      </section>

      {error && !catalog ? (
        <ErrorState vi={vi} onRetry={mutate} title={vi ? 'Chưa tải được thư viện' : 'The library could not be loaded'} />
      ) : isLoading || !catalog || (needsMe && meWait) ? (
        <RowsSkeleton rows={8} />
      ) : (
        <>
          <p className={cx(a.lbSummary, v.resultCount)} aria-live="polite">
            <span>
              <strong>{rows.length}</strong> {vi ? 'chủ đề' : rows.length === 1 ? 'topic' : 'topics'}
              {searching ? (vi ? ` khớp “${q.trim()}”` : ` match “${q.trim()}”`) : ''}
              {' · '}{vi ? `${ready} đã có bài` : `${ready} with a lesson`}
            </span>
            {searching ? <span>{vi ? 'Xếp theo độ khớp' : 'Best match first'}</span> : <span>{vi ? 'Gom theo mảng kiến thức' : 'Grouped by area'}</span>}
          </p>

          {!rows.length ? (
            <EmptyState
              title={searching ? (vi ? 'Không có chủ đề nào khớp' : 'No topic matches') : (vi ? 'Chưa có chủ đề nào ở bộ lọc này' : 'Nothing under these filters')}
              text={searching
                ? (vi ? 'Thử một từ ngắn hơn, hoặc gõ không dấu. Bạn cũng có thể tìm theo một câu sai hay gặp, ví dụ “I have seen him yesterday”.' : 'Try a shorter word. You can also search for a common mistaken sentence, such as “I have seen him yesterday”.')
                : (vi ? 'Nới bớt bộ lọc để thấy nhiều chủ đề hơn.' : 'Loosen a filter to see more topics.')}
            >
              {active ? <button type="button" className={cx(g.btn, g.btnPrimary)} onClick={clearAll}><RotateCcw aria-hidden="true" />{vi ? 'Xoá bộ lọc' : 'Clear filters'}</button> : null}
            </EmptyState>
          ) : groups ? (
            <Grouped groups={groups} limit={limit} me={me} vi={vi} />
          ) : (
            <ul className={cx(a.rows, v.topicShelf)} style={{ marginTop: '1rem' }}>
              {rows.slice(0, limit).map((r) => <TopicRow key={r.entry.topic.slug} entry={r.entry} me={me} tokens={tokens} via={r.via} viaText={r.viaText} vi={vi} />)}
            </ul>
          )}

          {rows.length > limit ? (
            <div className={a.more}>
              <button type="button" className={cx(g.btn, g.btnSoft)} onClick={() => setLimit((n) => n + PAGE)}>
                {vi ? `Hiện thêm (còn ${rows.length - limit})` : `Show more (${rows.length - limit} left)`}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Rows grouped by area, cut at `limit` rows in all (the groups keep their order). */
function Grouped({ groups, limit, me, vi }: { groups: { domain: CatalogDomain; rows: Row[] }[]; limit: number; me: GrammarMe | undefined; vi: boolean }) {
  let left = limit;
  return (
    <>
      {groups.map(({ domain, rows }) => {
        if (left <= 0) return null;
        const shown = rows.slice(0, left);
        left -= shown.length;
        const t = pair(domain.title, vi);
        return (
          <section key={domain.id} className={cx(a.group, v.catalogGroup)} data-tone={domain.tone} aria-labelledby={`gr-grp-${domain.id}`}>
            <div className={cx(a.groupHead, v.groupHeading)}>
              <span className={a.groupSwatch} aria-hidden="true" />
              <div>
                <h2 id={`gr-grp-${domain.id}`} className={a.groupName}>{t.main}</h2>
                <p className={a.groupSub}>{pair(domain.summary, vi).main}</p>
              </div>
              <span className={a.groupCount}>{rows.length}</span>
            </div>
            <ul className={cx(a.rows, v.topicShelf)}>
              {shown.map((r) => <TopicRow key={r.entry.topic.slug} entry={r.entry} me={me} vi={vi} showTone={false} />)}
            </ul>
          </section>
        );
      })}
    </>
  );
}

export default Library;
