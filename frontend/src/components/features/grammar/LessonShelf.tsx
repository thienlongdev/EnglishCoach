'use client';

import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTopicIndex } from '@/hooks/useGrammar';
import { cx } from '@/lib/grammar/format';
import { pair } from './AcademyKit';
import { PageJump } from '@/components/common/PageJump';
import g from './grammar.module.css';
import sh from './lessonShelf.module.css';

interface Card { id: string; level: string; title: string; topics: string[] }
const pageSize = 12;
const LEVEL_RANK = ['preA1', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const fold = (value: string) => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd');

export function LessonShelf<T extends Card>({ cards, vi, className, children }: {
  cards: T[];
  vi: boolean;
  className: string;
  children: (card: T, ordinal: number, topic: string) => ReactNode;
}) {
  const params = useSearchParams();
  const query = params.get('q') ?? '';
  const level = params.get('level') ?? '';
  const topicFilter = params.get('topic') ?? '';
  const { index } = useTopicIndex();
  const entries = useMemo(() => cards.map((card, ordinal) => {
    const labels = card.topics.map(slug => index.get(slug)?.topic.title);
    const topic = labels[0] ? pair(labels[0], vi).main : card.topics[0];
    const terms = fold([card.id, card.title, ...card.topics, ...labels.flatMap(label => label ? [label.vi, label.en] : [])].join(' '));
    return { card, ordinal, topic, terms };
  }), [cards, index, vi]);
  const levelOptions = useMemo(() => [...new Set(cards.map(card => card.level))].sort((a, b) => {
    const ra = LEVEL_RANK.indexOf(a);
    const rb = LEVEL_RANK.indexOf(b);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.localeCompare(b);
  }), [cards]);
  const topicOptions = useMemo(() => {
    const slugs = new Set<string>();
    for (const card of cards) for (const slug of card.topics) slugs.add(slug);
    return [...slugs].map((slug) => {
      const title = index.get(slug)?.topic.title;
      return { slug, label: title ? pair(title, vi).main : slug };
    }).sort((a, b) => a.label.localeCompare(b.label, vi ? 'vi' : 'en'));
  }, [cards, index, vi]);
  const needle = fold(query.trim());
  const matches = entries.filter(({ card, terms }) =>
    (!level || card.level === level)
    && (!topicFilter || card.topics.includes(topicFilter))
    && terms.includes(needle));
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const requested = Number(params.get('page'));
  const page = Number.isSafeInteger(requested) ? Math.min(pages, Math.max(1, requested)) : 1;
  const update = (key: string, value: string) => {
    const url = new URL(window.location.href);
    if (key !== 'page') url.searchParams.delete('page');
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    window.history.replaceState(null, '', url);
  };
  return (
    <>
      <div className={sh.tools}>
        <div className={sh.filters}>
        <input type="search" className={cx(g.input, sh.search)} value={query} onChange={e => update('q', e.target.value)}
          aria-label={vi ? 'Tìm theo tên hoặc chủ đề' : 'Search by title or topic'}
          placeholder={vi ? 'Tìm theo tên hoặc chủ đề' : 'Search by title or topic'} />
        <select className={g.btn} aria-label={vi ? 'Trình độ' : 'Level'} value={level} onChange={e => update('level', e.target.value)}>
          <option value="">{vi ? 'Mọi trình độ' : 'All levels'}</option>
          {levelOptions.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        {topicOptions.length > 1 ? (
          <select className={g.btn} style={{ maxWidth: 'min(18rem, 100%)' }} aria-label={vi ? 'Chủ đề' : 'Topic'} value={topicFilter} onChange={e => update('topic', e.target.value)}>
            <option value="">{vi ? 'Mọi chủ đề' : 'All topics'}</option>
            {topicOptions.map(t => <option key={t.slug} value={t.slug}>{t.label}</option>)}
          </select>
        ) : null}
        </div>
        {matches.length ? (
          <PageJump page={page} pages={pages} vi={vi} onPage={n => update('page', String(n))}
            label={vi ? 'Phân trang danh sách' : 'List pages'}
            summary={<span role="status">{vi ? `${matches.length} kết quả` : `${matches.length} results`}</span>} />
        ) : (
          <span role="status" className={sh.empty}>{vi ? 'Không có kết quả' : 'No results'}</span>
        )}
      </div>
      <ul className={className}>
        {matches.slice((page - 1) * pageSize, page * pageSize).map(({ card, ordinal, topic }) => children(card, ordinal, topic))}
      </ul>
    </>
  );
}
