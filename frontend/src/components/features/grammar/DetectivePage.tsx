'use client';

import React, { useId, useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { ArrowRight, CircleAlert, CircleCheck, CircleX, Eye, RotateCcw, ScanSearch } from 'lucide-react';
import { grammarApi } from '@/services/grammarApi';
import { useContentTitle } from '@/lib/brand/tabTitle';
import { apiFailure, cx, levelLabel } from '@/lib/grammar/format';
import { useGrammarCatalog, useTopicIndex } from '@/hooks/useGrammar';
import type { DetectiveCase } from '@/types/grammar';
import { LessonShelf } from './LessonShelf';
import { CardsSkeleton, ChapterHead, Crumbs, EmptyState, ErrorState, pair, useVi } from './AcademyKit';
import { Vi } from './Inline';
import g from './grammar.module.css';
import v from './subviews.module.css';
import a from './academy.module.css';

type Seg = DetectiveCase['paragraph'][number];
type Kind = 'caught' | 'missed' | 'false' | 'decoy' | 'style';

const CAT: Record<string, { vi: string; en: string }> = {
  tense: { vi: 'Thì', en: 'Tense' }, agreement: { vi: 'Hoà hợp chủ ngữ và động từ', en: 'Agreement' }, article: { vi: 'Mạo từ', en: 'Article' },
  preposition: { vi: 'Giới từ', en: 'Preposition' }, 'word-order': { vi: 'Trật tự từ', en: 'Word order' }, punctuation: { vi: 'Dấu câu', en: 'Punctuation' },
  pronoun: { vi: 'Đại từ', en: 'Pronoun' }, modal: { vi: 'Động từ khuyết thiếu', en: 'Modal verb' }, plural: { vi: 'Số nhiều', en: 'Plural' },
  'word-form': { vi: 'Dạng từ', en: 'Word form' }, conjunction: { vi: 'Liên từ', en: 'Conjunction' }, collocation: { vi: 'Kết hợp từ', en: 'Collocation' },
};
const catLabel = (cat: string, vi: boolean) => (CAT[cat] ? (vi ? CAT[cat].vi : CAT[cat].en) : cat.replace(/-/g, ' '));

/** A space between two segments that do not carry their own (authors may or may not put it in the text). */
const gap = (prev: string | undefined, next: string): boolean =>
  !!prev && !/[\s(\[“‘"']$/.test(prev) && !/^[\s.,;:!?)\]”’"'%…]/.test(next);

/** `/grammar/detective` (the cases) and `/grammar/detective/<id>` (one case). The browser judges the case: no credit, no mastery. */
export function DetectivePage({ id }: { id?: string }) {
  return id ? <CaseRun id={id} /> : <CaseIndex />;
}

function CaseIndex() {
  const vi = useVi();
  const { data: catalog, error, isLoading, mutate } = useGrammarCatalog();
  const cases = catalog?.detective ?? [];
  return (
    <div className={cx(a.page, v.view)}>
      <ChapterHead
        eyebrow={vi ? 'Thám tử Ngữ pháp' : 'Grammar Detective'}
        title={vi ? 'Tìm chỗ sai, đừng tố nhầm' : 'Find what is wrong, accuse no one by mistake'}
        lead={vi ? 'Mỗi vụ án là một đoạn văn. Chạm vào những chỗ bạn cho là sai rồi kết luận. Có chỗ trông sai mà đúng, và có chỗ chỉ là văn phong.' : 'Each case is a paragraph. Tap what you think is wrong, then close the case. Some things look wrong and are right, and some are only style.'}
        tone="violet"
        motif="detective"
      />
      <section className={a.sec} style={{ marginTop: '2rem' }} aria-label={vi ? 'Các vụ án' : 'Cases'}>
        {error && !catalog ? <ErrorState vi={vi} onRetry={() => { void mutate(); }} />
          : isLoading || !catalog ? <CardsSkeleton cards={3} />
          : !cases.length ? (
            <EmptyState
              icon={<ScanSearch />}
              title={vi ? 'Chưa có vụ án nào' : 'No cases yet'}
              text={vi ? 'Các vụ án đang được biên soạn. Trong lúc chờ, bạn có thể luyện lỗi sai theo chủ đề ở phần Luyện tập.' : 'The cases are being written. Meanwhile you can practise mistakes by topic in Practice.'}
            >
              <Link href="/grammar/practice" className={cx(g.btn, g.btnPrimary)}>{vi ? 'Mở Luyện tập' : 'Open Practice'}</Link>
            </EmptyState>
          ) : (
            <LessonShelf cards={cases} vi={vi} className={cx(a.items, v.caseShelf)}>
              {(c, i, topic) => (
                <li key={c.id}>
                  <Link prefetch={false} href={`/grammar/detective/${encodeURIComponent(c.id)}`} className={cx(a.item, v.caseCard)} data-tone="violet">
                    <span className={v.instrument}><ScanSearch aria-hidden="true" /><span>{vi ? 'HỒ SƠ' : 'CASE FILE'} {String(i + 1).padStart(2, '0')}</span></span>
                    <span className={g.chips}><span className={g.chip}>{levelLabel(c.level)}</span><span className={g.chip}>{topic}</span></span>
                    <h2 className={a.itemTitle}>{c.title}</h2>
                    <p className={a.itemText}>{c.brief}</p>
                    <span className={a.itemFoot}><span>{vi ? 'Mở hồ sơ' : 'Open the file'}</span><ArrowRight aria-hidden="true" /></span>
                  </Link>
                </li>
              )}
            </LessonShelf>
          )}
      </section>
    </div>
  );
}

function CaseRun({ id }: { id: string }) {
  const vi = useVi();
  const { data: c, error, isLoading, mutate } = useSWR<DetectiveCase>(['grammar-detective', id], () => grammarApi.detective(id), { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 60_000 });
  useContentTitle(c?.title);
  const crumbs = [{ href: '/grammar', label: vi ? 'Ngữ pháp' : 'Grammar' }, { href: '/grammar/detective', label: vi ? 'Thám tử' : 'Detective' }];

  if (error || !c) {
    if (isLoading && !error) return <div className={cx(a.page, v.view)}><Crumbs vi={vi} items={[...crumbs, { label: '…' }]} /><span className={g.skel} aria-hidden="true" style={{ display: 'block', height: '16rem', borderRadius: '1.9rem' }} /></div>;
    const missing = apiFailure(error).status === 404;
    return (
      <div className={cx(a.page, v.view)}>
        <Crumbs vi={vi} items={[...crumbs, { label: vi ? 'Không tìm thấy' : 'Not found' }]} />
        {missing
          ? <EmptyState title={vi ? 'Không tìm thấy vụ án này' : 'This case was not found'} text={vi ? 'Đường dẫn có thể đã cũ, hoặc vụ án chưa được công bố.' : 'The link may be old, or the case is not published yet.'}><Link href="/grammar/detective" className={cx(g.btn, g.btnPrimary)}>{vi ? 'Về danh sách vụ án' : 'Back to the cases'}</Link></EmptyState>
          : <ErrorState vi={vi} onRetry={() => { void mutate(); }} />}
      </div>
    );
  }
  return (
    <div className={cx(a.page, v.view)}>
      <Crumbs vi={vi} items={[...crumbs, { label: c.title }]} />
      <ChapterHead eyebrow={vi ? 'Thám tử Ngữ pháp' : 'Grammar Detective'} title={c.title} tone="violet" motif="detective">
        <div className={a.chapterFacts}><span className={g.chip}>{levelLabel(c.level)}</span></div>
      </ChapterHead>
      <Case key={c.id} c={c} vi={vi} />
    </div>
  );
}

function Case({ c, vi }: { c: DetectiveCase; vi: boolean }) {
  const { index } = useTopicIndex();
  const [accused, setAccused] = useState<Set<number>>(() => new Set());
  const [closed, setClosed] = useState(false);
  const segs = c.paragraph;

  const kindOf = (s: Seg, i: number): Kind | null => {
    const on = accused.has(i);
    if (s.bad) return on ? 'caught' : 'missed';
    if (s.decoy) return 'decoy';
    if (s.style) return 'style';
    return on ? 'false' : null;
  };

  const report = useMemo(() => {
    let n = 0;
    return segs.map((s, i) => {
      const k = kindOf(s, i);
      return k ? { i, s, kind: k, num: ++n } : null;
    }).filter((x): x is { i: number; s: Seg; kind: Kind; num: number } => !!x);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segs, accused]);
  const numOf = new Map(report.map((r) => [r.i, r.num]));

  const bad = segs.filter((s) => s.bad).length;
  const caught = segs.filter((s, i) => s.bad && accused.has(i)).length;
  const wrong = segs.filter((s, i) => !s.bad && accused.has(i)).length;

  const toggle = (i: number) => setAccused((cur) => { const n = new Set(cur); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const reset = () => { setAccused(new Set()); setClosed(false); };

  const LABEL: Record<Kind, { vi: string; en: string; icon: typeof CircleCheck }> = {
    caught: { vi: 'Bạn bắt đúng', en: 'You caught it', icon: CircleCheck },
    missed: { vi: 'Bạn bỏ sót', en: 'You missed it', icon: CircleX },
    false: { vi: 'Chỗ này không sai', en: 'This is not wrong', icon: CircleAlert },
    decoy: { vi: 'Trông sai nhưng đúng', en: 'Looks wrong but is right', icon: CircleAlert },
    style: { vi: 'Không sai, chỉ là văn phong', en: 'Not wrong, only style', icon: CircleAlert },
  };

  return (
    <section className={cx(a.dossier, v.dossier)} aria-label={vi ? 'Hồ sơ vụ án' : 'Case file'}>
      <p className={cx(a.brief, v.caseBrief)}><b>{vi ? 'Hồ sơ vụ án' : 'Case file'}</b>{c.brief}</p>
      <p className={g.fine} style={{ margin: '0 0 0.9rem' }}>
        {closed
          ? (vi ? 'Vụ án đã khép. Các số nhỏ trong đoạn văn trỏ tới phần kết luận bên dưới.' : 'The case is closed. The small numbers in the paragraph point to the findings below.')
          : (vi ? 'Chạm vào từng chỗ bạn cho là sai. Chạm lại để bỏ. Khi xong, kết luận vụ án.' : 'Tap each place you think is wrong. Tap again to undo. When you are done, close the case.')}
      </p>
      <p className={cx(a.paper, v.evidence)} lang="en">
        {segs.map((s, i) => {
          const space = gap(segs[i - 1]?.t, s.t) ? ' ' : '';
          if (!s.t.trim()) return <React.Fragment key={i}>{space}{s.t}</React.Fragment>;
          const kind = closed ? kindOf(s, i) : null;
          return (
            <React.Fragment key={i}>
              {space}
              <button
                type="button"
                className={a.sus}
                aria-pressed={accused.has(i)}
                data-v={kind ?? undefined}
                disabled={closed}
                onClick={() => toggle(i)}
              >
                {s.t}
                {closed && numOf.has(i) ? <sup className={a.susMark} aria-hidden="true">{numOf.get(i)}</sup> : null}
              </button>
            </React.Fragment>
          );
        })}
      </p>

      {!closed ? (
        <div className={a.caseBar}>
          <p aria-live="polite">{accused.size ? (vi ? `Bạn đang tố ${accused.size} chỗ.` : `You are accusing ${accused.size} place${accused.size === 1 ? '' : 's'}.`) : (vi ? 'Bạn chưa tố chỗ nào.' : 'You have not accused anything yet.')}</p>
          <button type="button" className={cx(g.btn, g.btnQuiet, g.btnSm)} disabled={!accused.size} onClick={() => setAccused(new Set())}>{vi ? 'Bỏ hết' : 'Clear'}</button>
          <button type="button" className={cx(g.btn, g.btnPrimary)} onClick={() => setClosed(true)}><Eye aria-hidden="true" />{vi ? 'Kết luận vụ án' : 'Close the case'}</button>
        </div>
      ) : (
        <>
          <div className={a.score} role="status">
            <strong>
              {caught === bad && wrong === 0 ? (vi ? 'Phá án trọn vẹn' : 'A clean solve') : (vi ? 'Kết quả của vụ này' : 'This case’s result')}
            </strong>
            <p>
              {vi
                ? `Bạn bắt đúng ${caught} trong ${bad} lỗi và tố nhầm ${wrong} chỗ không sai. Vụ án chỉ để luyện mắt: không ghi nhận mức độ thành thạo.`
                : `You caught ${caught} of ${bad} errors and accused ${wrong} place${wrong === 1 ? '' : 's'} that were not wrong. A case is for training your eye: no mastery is recorded.`}
            </p>
          </div>
          {report.length ? (
            <ol className={cx(a.verdicts, v.findings)} aria-label={vi ? 'Kết luận từng chỗ' : 'Findings'}>
              {report.map(({ i, s, kind, num }) => {
                const L = LABEL[kind];
                const Icon = L.icon;
                return (
                  <li key={num} className={a.vd} data-v={kind}>
                    <span className={a.vdNum} aria-hidden="true">{num}</span>
                    <div className={a.vdHead}>
                      <Icon aria-hidden="true" />{vi ? L.vi : L.en}
                      {kind === 'decoy' ? <span className={g.chip}>{accused.has(i) ? (vi ? 'Bạn đã tố nhầm' : 'You accused it') : (vi ? 'Bạn không bị lừa' : 'You were not fooled')}</span> : null}
                      {s.cat ? <span className={g.chip}>{catLabel(s.cat, vi)}</span> : null}
                    </div>
                    {s.bad && s.fix?.length ? <Repair segment={s} before={segs.slice(0, i).map(x => x.t).join(' ')} after={segs.slice(i + 1).map(x => x.t).join(' ')} vi={vi} /> : (
                      <>
                        <p className={a.vdText} lang="en">{s.t.trim()}</p>
                        {s.note ? <p className={a.vdNote}><Vi text={s.note} /></p> : null}
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : null}
          <div className={a.caseBar}>
            <button type="button" className={cx(g.btn, g.btnPrimary)} onClick={reset}><RotateCcw aria-hidden="true" />{vi ? 'Điều tra lại' : 'Investigate again'}</button>
            <Link href="/grammar/detective" className={cx(g.btn, g.btnSoft)}>{vi ? 'Các vụ án khác' : 'More cases'}</Link>
            {c.topics.map((s) => {
              const e = index.get(s);
              return e?.topic.available ? <Link key={s} href={`/grammar/topics/${encodeURIComponent(s)}`} className={cx(g.btn, g.btnQuiet, g.btnSm)}>{pair(e.topic.title, vi).main}</Link> : null;
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** Local comparison only. An unlisted repair is uncertain, never a wrong answer or mastery evidence. */
function Repair({ segment, before, after, vi }: { segment: Seg; before: string; after: string; vi: boolean }) {
  const id = useId();
  const [text, setText] = useState('');
  const [remove, setRemove] = useState(false);
  const [compared, setCompared] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // Preserve case and punctuation: these may be the very grammatical distinction being repaired.
  const normalize = (value: string) => value.normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  const matches = segment.fix?.some(value => normalize(value) === normalize(remove ? '' : text));
  const canCompare = remove || text.trim().length > 0;
  const compare = () => { if (canCompare) { setCompared(true); setRevealed(true); } };
  return (
    <div className={a.repair}>
      <p className={a.vdText} lang="en"><s>{segment.t.trim()}</s></p>
      <label htmlFor={id} className={g.fieldLabel}>{vi ? `Cách sửa cho “${segment.t.trim()}”` : `Your repair for “${segment.t.trim()}”`}</label>
      <input id={id} className={g.input} lang="en" maxLength={400} value={text} disabled={remove}
        autoComplete="off" autoCorrect="off" spellCheck={false}
        onChange={e => { setText(e.target.value); setCompared(false); }}
        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); compare(); } }} />
      <label className={a.repairRemove}>
        <input type="checkbox" checked={remove} onChange={e => { setRemove(e.target.checked); setCompared(false); }} />
        {vi ? 'Xóa đoạn này, không thay bằng từ khác' : 'Remove this segment without replacing it'}
      </label>
      <div className={a.repairActions}>
        <button type="button" className={cx(g.btn, g.btnSoft, g.btnSm)} disabled={!canCompare} onClick={compare}>{vi ? 'Đối chiếu cách sửa' : 'Compare your repair'}</button>
        <button type="button" className={cx(g.btn, g.btnQuiet, g.btnSm)} onClick={() => setRevealed(v => !v)} aria-expanded={revealed} aria-controls={`${id}-model`}>{revealed ? (vi ? 'Ẩn gợi ý' : 'Hide suggestions') : (vi ? 'Xem gợi ý' : 'Show suggestions')}</button>
      </div>
      <div role="status">
        {compared ? <p className={a.vdNote}>{matches
          ? (vi ? 'Khớp một cách sửa trong bài. Hãy đọc lại cả câu để kiểm tra nghĩa.' : 'This matches a suggested repair. Read the full sentence again to check the meaning.')
          : (vi ? 'Cách sửa này chưa có trong gợi ý, chưa thể kết luận sai. Đối chiếu cấu trúc, người thực hiện và ý nghĩa với các cách bên dưới.' : 'This repair is not in the suggestions; that does not establish an error. Compare its structure, participants and meaning with the suggestions below.')}</p> : null}
      </div>
      <div id={`${id}-model`} hidden={!revealed} className={a.repairModel}>
        <p className={a.vdText}>{vi ? 'Gợi ý: ' : 'Suggestions: '}<span lang="en">{segment.fix?.map(value => value || (vi ? '(xóa đoạn này)' : '(remove this segment)')).join(' / ')}</span></p>
        {segment.note ? <p className={a.vdNote}><Vi text={segment.note} /></p> : null}
      </div>
      {compared ? <details><summary>{vi ? 'Đọc lại đoạn với cách sửa của bạn' : 'Read the passage with your repair'}</summary><p lang="en" className={a.vdNote}>{before}{' '}<mark>{remove ? '' : text}</mark>{' '}{after}</p></details> : null}
    </div>
  );
}

export default DetectivePage;
