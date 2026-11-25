'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { ArrowRight, FlaskConical, SlidersHorizontal, CircleCheck, CircleX, RotateCcw, TriangleAlert } from 'lucide-react';
import { grammarApi } from '@/services/grammarApi';
import { useContentTitle } from '@/lib/brand/tabTitle';
import { apiFailure, cx, levelLabel } from '@/lib/grammar/format';
import { useGrammarCatalog, useTopicIndex } from '@/hooks/useGrammar';
import type { LabExperiment } from '@/types/grammar';
import { ChapterHead, CardsSkeleton, Crumbs, EmptyState, ErrorState, Segmented, pair, useVi } from './AcademyKit';
import { LessonShelf } from './LessonShelf';
import { DiagramBody, WordMorph } from './diagrams';
import g from './grammar.module.css';
import v from './subviews.module.css';
import a from './academy.module.css';

type Verdict = 'ok' | 'odd' | 'bad';
const VERDICT: Record<Verdict, { vi: string; en: string; icon: typeof CircleCheck }> = {
  ok: { vi: 'Tự nhiên', en: 'Natural', icon: CircleCheck },
  odd: { vi: 'Lạ, cần ngữ cảnh', en: 'Unusual, needs a context', icon: TriangleAlert },
  bad: { vi: 'Sai', en: 'Not correct', icon: CircleX },
};
const KIND = {
  switchboard: { vi: 'Bảng điều khiển', en: 'Switchboard' },
  arrange: { vi: 'Xếp từ', en: 'Arrange' },
} as const;

/** `/grammar/lab` (the experiments) and `/grammar/lab/<id>` (one experiment). */
export function LabPage({ id }: { id?: string }) {
  return id ? <LabRun id={id} /> : <LabIndex />;
}

/* ═══ index ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
function LabIndex() {
  const vi = useVi();
  const { data: catalog, error, isLoading, mutate } = useGrammarCatalog();
  const labs = catalog?.lab ?? [];
  return (
    <div className={cx(a.page, v.view)}>
      <ChapterHead
        eyebrow={vi ? 'Phòng thí nghiệm' : 'Grammar Lab'}
        title={vi ? 'Thử một câu, đổi một thứ' : 'Change one thing in a sentence'}
        lead={vi ? 'Đổi một công tắc hoặc xếp lại từ, rồi so sánh nghĩa và ngữ cảnh. Mỗi kết quả có giải thích riêng; một câu đúng cấu trúc vẫn có thể không hợp tình huống.' : 'Change a switch or arrange the words, then compare meaning and context. Each result has its own explanation; a grammatical sentence can still be unsuitable for a situation.'}
        tone="lagoon"
        motif="lab"
      />
      <section className={a.sec} style={{ marginTop: '2rem' }} aria-label={vi ? 'Các thí nghiệm' : 'Experiments'}>
        {error && !catalog ? <ErrorState vi={vi} onRetry={() => { void mutate(); }} />
          : isLoading || !catalog ? <CardsSkeleton cards={3} />
          : !labs.length ? (
            <EmptyState
              title={vi ? 'Chưa có thí nghiệm nào' : 'No experiments yet'}
              text={vi ? 'Các thí nghiệm đang được biên soạn và kiểm chứng. Trong lúc chờ, bạn có thể học theo chủ đề trong thư viện.' : 'The experiments are being written and checked. Meanwhile you can study by topic in the library.'}
            >
              <Link href="/grammar/library" className={cx(g.btn, g.btnPrimary)}>{vi ? 'Mở thư viện' : 'Open the library'}</Link>
            </EmptyState>
          ) : (
            <LessonShelf cards={labs} vi={vi} className={cx(a.items, v.experimentShelf)}>
              {(l, i, topic) => (
                <li key={l.id}>
                  <Link prefetch={false} href={`/grammar/lab/${encodeURIComponent(l.id)}`} className={cx(a.item, v.experimentCard)} data-tone="lagoon">
                    <span className={v.instrument}><FlaskConical aria-hidden="true" /><span>{vi ? 'THÍ NGHIỆM' : 'EXPERIMENT'} {String(i + 1).padStart(2, '0')}</span></span>
                    <span className={g.chips}>
                      <span className={g.chip}>{levelLabel(l.level)}</span>
                      <span className={g.chip}>{vi ? KIND[l.kind].vi : KIND[l.kind].en}</span>
                      {topic ? <span className={g.chip}>{topic}</span> : null}
                    </span>
                    <h2 className={a.itemTitle}>{l.title}</h2>
                    <p className={a.itemText}>{l.summary}</p>
                    <span className={a.itemFoot}><span>{vi ? 'Mở thí nghiệm' : 'Open the experiment'}</span><ArrowRight aria-hidden="true" /></span>
                  </Link>
                </li>
              )}
            </LessonShelf>
          )}
      </section>
    </div>
  );
}

/* ═══ one experiment ═════════════════════════════════════════════════════════════════════════════════════════════════ */
function LabRun({ id }: { id: string }) {
  const vi = useVi();
  const { data: lab, error, isLoading, mutate } = useSWR<LabExperiment>(['grammar-lab', id], () => grammarApi.lab(id), { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 60_000 });
  const { index } = useTopicIndex();
  useContentTitle(lab?.title);

  const crumbs = [{ href: '/grammar', label: vi ? 'Ngữ pháp' : 'Grammar' }, { href: '/grammar/lab', label: vi ? 'Phòng thí nghiệm' : 'Lab' }];
  if (error || !lab) {
    if (isLoading && !error) return <div className={cx(a.page, v.view)}><Crumbs vi={vi} items={[...crumbs, { label: '…' }]} /><span className={g.skel} aria-hidden="true" style={{ display: 'block', height: '16rem', borderRadius: '1.9rem' }} /></div>;
    const missing = apiFailure(error).status === 404;
    return (
      <div className={cx(a.page, v.view)}>
        <Crumbs vi={vi} items={[...crumbs, { label: vi ? 'Không tìm thấy' : 'Not found' }]} />
        {missing
          ? <EmptyState title={vi ? 'Không tìm thấy thí nghiệm này' : 'This experiment was not found'} text={vi ? 'Đường dẫn có thể đã cũ, hoặc thí nghiệm chưa được công bố.' : 'The link may be old, or the experiment is not published yet.'}><Link href="/grammar/lab" className={cx(g.btn, g.btnPrimary)}>{vi ? 'Về phòng thí nghiệm' : 'Back to the lab'}</Link></EmptyState>
          : <ErrorState vi={vi} onRetry={() => { void mutate(); }} />}
      </div>
    );
  }

  const topics = lab.topics.map((s) => index.get(s)).filter((e): e is NonNullable<typeof e> => !!e);
  return (
    <div className={cx(a.page, v.view)}>
      <Crumbs vi={vi} items={[...crumbs, { label: lab.title }]} />
      <ChapterHead eyebrow={vi ? KIND[lab.kind].vi : KIND[lab.kind].en} title={lab.title} lead={lab.summary} tone="lagoon" motif="lab">
        <div className={a.chapterFacts}><span className={g.chip}>{levelLabel(lab.level)}</span></div>
      </ChapterHead>
      {lab.kind === 'switchboard' ? <Switchboard key={lab.id} lab={lab} vi={vi} /> : <Arrange key={lab.id} lab={lab} vi={vi} />}
      {topics.length ? (
        <section className={a.sec} aria-labelledby="gr-lab-topics">
          <h2 id="gr-lab-topics" className={a.secTitle} style={{ fontSize: '1.25rem' }}>{vi ? 'Bài học liên quan' : 'Related lessons'}</h2>
          <ul className={cx(g.chips)} style={{ margin: '0.8rem 0 0', padding: 0, listStyle: 'none' }}>
            {topics.map((e) => (
              <li key={e.topic.slug}>
                {e.topic.available
                  ? <Link href={`/grammar/topics/${encodeURIComponent(e.topic.slug)}`} className={cx(g.btn, g.btnSoft, g.btnSm)}>{pair(e.topic.title, vi).main}</Link>
                  : <span className={cx(g.btn, g.btnQuiet, g.btnSm)} aria-disabled="true">{pair(e.topic.title, vi).main} · {vi ? 'đang biên soạn' : 'in preparation'}</span>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function VerdictChip({ v, vi }: { v: Verdict; vi: boolean }) {
  const Icon = VERDICT[v].icon;
  return <span className={a.verdict} data-v={v}><Icon aria-hidden="true" />{vi ? VERDICT[v].vi : VERDICT[v].en}</span>;
}

/* ═══ switchboard: axes as switches, a hand-checked table behind them ════════════════════════════════════════════════ */
function Switchboard({ lab, vi }: { lab: LabExperiment; vi: boolean }) {
  const axes = useMemo(() => lab.axes ?? [], [lab.axes]);
  const initialSel = useMemo(() => Object.fromEntries(axes.map((ax) => [ax.id, ax.values[0]?.id ?? ''])), [axes]);
  const [sel, setSel] = useState<Record<string, string>>(initialSel);
  const key = axes.map((ax) => sel[ax.id]).join('|');
  const res = lab.results?.[key];
  const isInitial = axes.every((ax) => sel[ax.id] === initialSel[ax.id]);

  const label = (k: string) => k.split('|').map((vid, i) => axes[i]?.values.find((v) => v.id === vid)?.label ?? vid).join(' · ');
  const choose = (k: string) => {
    const ids = k.split('|');
    if (ids.length !== axes.length) return;
    setSel(Object.fromEntries(axes.map((ax, i) => [ax.id, ids[i]])));
  };

  if (!axes.length) return <EmptyState title={vi ? 'Thí nghiệm này chưa có công tắc' : 'This experiment has no switches yet'} text={vi ? 'Nội dung đang được hoàn thiện.' : 'The content is being finished.'} />;
  return (
    <div className={cx(a.labGrid, v.workbench)}>
      <section className={cx(a.board, v.controls)} aria-label={vi ? 'Công tắc' : 'Switches'}>
        <h2 className={v.panelLabel}><SlidersHorizontal aria-hidden="true" />{vi ? 'Bàn điều khiển' : 'Control panel'}</h2>
        {axes.map((ax) => (
          <div key={ax.id}>
            <p className={a.axisName}>{ax.label}</p>
            <Segmented<string> label={ax.label} value={sel[ax.id]} options={ax.values.map((v) => ({ id: v.id, label: v.label }))} onChange={(v) => setSel((s) => ({ ...s, [ax.id]: v }))} />
          </div>
        ))}
        <div className={a.arrActions} style={{ marginTop: '0.5rem' }}>
          <button type="button" className={cx(g.btn, g.btnQuiet, g.btnSm)} disabled={isInitial} onClick={() => setSel(initialSel)}>
            <RotateCcw aria-hidden="true" />{vi ? 'Đặt lại' : 'Reset'}
          </button>
        </div>
      </section>
      <div style={{ minWidth: 0 }}>
        <section className={cx(a.specimen, v.specimen)} data-tone="lagoon" data-spatial-owner="" aria-label={vi ? 'Kết quả' : 'Result'}>
          {res ? (
            <>
              <WordMorph sentence={res.en} live />
              <VerdictChip v={res.verdict} vi={vi} />
              {res.vi ? <p className={a.specVi}>{res.vi}</p> : null}
              <p className={a.specNote}>{res.note}</p>
              {res.timeline ? <div className={a.specTimeline}><DiagramBody key={key} spec={{ kind: 'timeline', ...res.timeline }} /></div> : null}
            </>
          ) : (
            <>
              <span className={a.verdict} data-v="none">{vi ? 'Chưa có trong bảng đã kiểm chứng' : 'Not in the verified table'}</span>
              <p className={a.specNote}>{vi ? 'Tổ hợp này chưa có kết quả được kiểm chứng. Hãy thử một tổ hợp khác.' : 'This combination has no verified result yet. Try another one.'}</p>
            </>
          )}
        </section>
        <details className={a.planned} style={{ marginTop: '1rem' }}>
          <summary>{vi ? 'Xem bảng các tổ hợp' : 'See all combinations'}</summary>
          <ul className={a.table} style={{ marginTop: '0.75rem' }}>
            {Object.entries(lab.results ?? {}).map(([k, r]) => {
              const Icon = VERDICT[r.verdict].icon;
              return (
                <li key={k}>
                  <button type="button" className={a.tableBtn} data-v={r.verdict} aria-current={k === key ? 'true' : undefined} onClick={() => choose(k)}>
                    <Icon aria-hidden="true" /><span lang="en">{r.en}</span><small>{label(k)} · {vi ? VERDICT[r.verdict].vi : VERDICT[r.verdict].en}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      </div>
    </div>
  );
}

/* ═══ arrange: move the words, read what the verified list says ══════════════════════════════════════════════════════ */
function Arrange({ lab, vi }: { lab: LabExperiment; vi: boolean }) {
  const tokens = useMemo(() => lab.tokens ?? [], [lab.tokens]);
  const orders = useMemo(() => lab.orders ?? [], [lab.orders]);
  const [placed, setPlaced] = useState<number[]>([]);
  const [open, setOpen] = useState(false);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusPos = useRef<number | null>(null);
  useEffect(() => {
    if (focusPos.current == null) return;
    refs.current[focusPos.current]?.focus();
    focusPos.current = null;
  });

  const bank = tokens.map((_, i) => i).filter((i) => !placed.includes(i));
  const full = tokens.length > 0 && placed.length === tokens.length;
  const seq = placed.map((i) => tokens[i]);
  const found = full ? orders.find((o) => o.seq.length === seq.length && o.seq.every((w, i) => w === seq[i])) : undefined;

  const move = (pos: number, to: number) => {
    if (to < 0 || to >= placed.length) return;
    const next = placed.slice();
    [next[pos], next[to]] = [next[to], next[pos]];
    focusPos.current = to;
    setPlaced(next);
  };
  const remove = (pos: number) => setPlaced((p) => p.filter((_, i) => i !== pos));
  const tryOrder = (words: string[]) => {
    const used = new Set<number>();
    const out: number[] = [];
    for (const w of words) {
      const at = tokens.findIndex((t, i) => t === w && !used.has(i));
      if (at < 0) return;
      used.add(at); out.push(at);
    }
    setPlaced(out);
  };

  if (!tokens.length) return <EmptyState title={vi ? 'Thí nghiệm này chưa có từ để xếp' : 'This experiment has no words to arrange yet'} text={vi ? 'Nội dung đang được hoàn thiện.' : 'The content is being finished.'} />;
  return (
    <div className={cx(a.labGrid, v.workbench)} style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <section className={cx(a.specimen, v.specimen)} data-tone="lagoon" data-spatial-owner="">
        <p className={g.fine} style={{ margin: 0 }}>{vi ? 'Chạm một từ để đưa nó vào câu, chạm lại để bỏ ra. Với từ đang ở trong câu, dùng phím mũi tên trái và phải để đổi chỗ.' : 'Tap a word to put it into the sentence, tap again to take it out. For a word in the sentence, use the left and right arrow keys to move it.'}</p>
        <div className={a.well} data-full={full ? 'true' : 'false'} role="list" aria-label={vi ? 'Câu của bạn' : 'Your sentence'}>
          {placed.length ? placed.map((ti, pos) => (
            <button
              key={`${ti}`}
              ref={(el) => { refs.current[pos] = el; }}
              type="button"
              role="listitem"
              className={a.tile}
              data-placed="true"
              lang="en"
              aria-label={vi ? `${tokens[ti]}, vị trí ${pos + 1} trên ${placed.length}. Chạm để bỏ ra, mũi tên để đổi chỗ.` : `${tokens[ti]}, position ${pos + 1} of ${placed.length}. Tap to remove, arrow keys to move.`}
              onClick={() => remove(pos)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') { e.preventDefault(); move(pos, pos - 1); }
                else if (e.key === 'ArrowRight') { e.preventDefault(); move(pos, pos + 1); }
                else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); remove(pos); }
              }}
            >
              {tokens[ti]}
            </button>
          )) : <span className={a.wellHint}>{vi ? 'Câu của bạn sẽ nằm ở đây' : 'Your sentence will appear here'}</span>}
        </div>
        <div className={a.bank} role="group" aria-label={vi ? 'Các từ còn lại' : 'Remaining words'}>
          {bank.map((ti) => (
            <button key={ti} type="button" className={a.tile} lang="en" onClick={() => setPlaced((p) => [...p, ti])}>{tokens[ti]}</button>
          ))}
        </div>
        <div className={a.arrActions}>
          <button type="button" className={cx(g.btn, g.btnQuiet, g.btnSm)} disabled={!placed.length} onClick={() => setPlaced([])}><RotateCcw aria-hidden="true" />{vi ? 'Xếp lại từ đầu' : 'Start over'}</button>
        </div>
        <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          {!full ? (
            <p className={a.specNote}>{vi ? `Đã xếp ${placed.length} / ${tokens.length} từ. Xếp đủ để xem nhận xét.` : `${placed.length} of ${tokens.length} words placed. Place them all to see the verdict.`}</p>
          ) : found ? (
            <>
              <VerdictChip v={found.verdict} vi={vi} />
              <p className={a.specNote}>{found.note}</p>
              {found.effect ? <p className={a.effect}>{found.effect}</p> : null}
            </>
          ) : (
            <>
              <span className={a.verdict} data-v="none">{vi ? 'Thứ tự này không có trong danh sách đã kiểm chứng' : 'This order is not in the verified list'}</span>
              <p className={a.specNote}>{vi ? 'Điều đó không có nghĩa là sai: chỉ là chúng tôi chưa kiểm chứng thứ tự này. Mở danh sách bên dưới để xem những thứ tự đã kiểm chứng.' : 'That does not mean it is wrong: this order simply has not been checked. Open the list below to see the orders that have.'}</p>
            </>
          )}
        </div>
      </section>
      {orders.length ? (
        <details className={a.planned} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>{vi ? `Các thứ tự đã kiểm chứng (${orders.length})` : `Verified orders (${orders.length})`}</summary>
          <ul className={a.table} style={{ marginTop: '0.75rem' }}>
            {orders.map((o, i) => {
              const Icon = VERDICT[o.verdict].icon;
              return (
                <li key={i}>
                  <button type="button" className={a.tableBtn} data-v={o.verdict} onClick={() => tryOrder(o.seq)}>
                    <Icon aria-hidden="true" /><span lang="en">{o.seq.join(' ')}</span><small>{vi ? VERDICT[o.verdict].vi : VERDICT[o.verdict].en}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export default LabPage;
