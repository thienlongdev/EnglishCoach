'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowRight, BookOpenText, ChevronRight, Clock, Compass, FlaskConical, RotateCcw, ScanSearch, Search, TriangleAlert,
} from 'lucide-react';
import { grammarApi } from '@/services/grammarApi';
import { GRAMMAR_ART } from '@/lib/grammar/art';
import { buildSearchIndex, search } from '@/lib/grammar/search';
import { LEVELS, apiFailure, cx, levelLabel } from '@/lib/grammar/format';
import { topicIndex, useGrammarCatalog, useGrammarMe, type TopicEntry } from '@/hooks/useGrammar';
import type { Catalog, GrammarMe, Level, RecommendationReason } from '@/types/grammar';
import { CardsSkeleton, ErrorState, Segmented, StateChip, TRACKS, TRACK_IDS, levelName, num, pair, useVi } from './AcademyKit';
import { En } from './Inline';
import { useInView } from './diagrams/shared';
import g from './grammar.module.css';
import a from './academy.module.css';

/** Sort key of the path: the catalog's own `path` number, topics without one after, in domain order. */
const pathKey = (e: TopicEntry): number => e.topic.path ?? 100_000 + e.domain.order * 1000 + (e.topic.order ?? 0);

const REASON: Record<RecommendationReason, { vi: string; en: string; go: { vi: string; en: string } }> = {
  REVIEW_DUE: { vi: 'Đến hạn ôn lại', en: 'Due for review', go: { vi: 'Ôn lại chủ đề này', en: 'Review this topic' } },
  READY_FOR_CHECK: { vi: 'Sẵn sàng kiểm tra', en: 'Ready for a check', go: { vi: 'Mở bài và kiểm tra', en: 'Open it and check' } },
  CONTINUE: { vi: 'Đang học dở', en: 'Pick up where you left off', go: { vi: 'Học tiếp', en: 'Continue' } },
  NEXT_ON_PATH: { vi: 'Bước tiếp theo trên lộ trình', en: 'Next on your path', go: { vi: 'Bắt đầu bài này', en: 'Start this topic' } },
};

/* ═══ page ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
export function GrammarHome() {
  const vi = useVi();
  const { data: catalog, error, mutate } = useGrammarCatalog();
  const meQ = useGrammarMe();
  const me = meQ.data;
  const meWait = !me && !meQ.error;
  const index = useMemo(() => topicIndex(catalog), [catalog]);

  return (
    <div className={a.page}>
      <Hero catalog={catalog} failed={!!error && !catalog} index={index} vi={vi} />
      {error && !catalog ? (
        <ErrorState vi={vi} onRetry={() => { void mutate(); }} title={vi ? 'Chưa tải được danh mục Ngữ pháp' : 'The grammar catalog could not be loaded'} />
      ) : !catalog ? (
        <div className={a.sec} aria-hidden="true"><CardsSkeleton cards={4} /></div>
      ) : (
        <>
          <section className={a.desk} aria-label={vi ? 'Bàn học của bạn' : 'Your desk'}>
            <div className={a.deskCol}>
              <NextSteps me={me} wait={meWait} failed={!!meQ.error} retry={() => { void meQ.mutate(); }} index={index} vi={vi} />
            </div>
            <div className={a.deskCol}>
              <StartPanel me={me} wait={meWait} failed={!!meQ.error} onChanged={async () => { await meQ.mutate(); }} vi={vi} />
              <Stats me={me} wait={meWait} vi={vi} />
            </div>
          </section>
          <WaysSection catalog={catalog} vi={vi} />
          <PathSection catalog={catalog} me={me} wait={meWait} vi={vi} />
          <DomainsSection catalog={catalog} vi={vi} />
          <TracksSection catalog={catalog} vi={vi} />
          <p className={a.foot}>
            {vi
              ? `Nội dung do English Coach tự biên soạn. Đã hoàn tất nghiệm thu biên tập: ${catalog.counts.reviewed} / ${catalog.counts.topics} chủ đề có bài.${catalog.counts.reviewed < catalog.counts.topics ? ' Các chủ đề còn lại vẫn đang biên tập, kể cả khi đã được rà soát từng phần.' : ''} Trạng thái nội bộ không phải chứng nhận của chuyên gia độc lập. Mức độ từ Pre-A1 đến C2 là gợi ý biên soạn, không phải chứng nhận.`
              : `All content is written by English Coach. Editorial acceptance completed: ${catalog.counts.reviewed} of ${catalog.counts.topics} topics with a lesson.${catalog.counts.reviewed < catalog.counts.topics ? ' The others remain in editing, including topics with partial review passes.' : ''} Internal status is not independent expert certification. Levels from Pre-A1 to C2 are editorial suggestions, not certificates.`}
          </p>
        </>
      )}
    </div>
  );
}

/* ═══ hero ═══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
function Hero({ catalog, failed, index, vi }: { catalog: Catalog | undefined; failed: boolean; index: Map<string, TopicEntry>; vi: boolean }) {
  const [ref, live] = useInView<HTMLElement>();
  const dawn = GRAMMAR_ART.hero.dawn || GRAMMAR_ART.hero.night;
  const night = GRAMMAR_ART.hero.night || GRAMMAR_ART.hero.dawn;
  const hasArt = !!(dawn || night);
  const wait = !catalog && !failed;
  const counts = catalog?.counts;
  const artVars = hasArt
    ? ({ '--hero-dawn': `url("${dawn}")`, '--hero-night': `url("${night}")` } as React.CSSProperties)
    : undefined;

  return (
    <section ref={ref} className={a.hero} data-morph-hero="media" data-spatial-owner="grammar-hero" data-art={hasArt ? 'true' : 'false'} data-live={live ? 'true' : 'false'} aria-labelledby="gr-home-title">
      {hasArt ? <div className={a.heroArt} style={artVars} aria-hidden="true" /> : (
        <svg className={a.waves} viewBox="0 0 800 88" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <g>
            <path d="M-60 30q50-22 100 0t100 0t100 0t100 0t100 0t100 0t100 0t100 0t100 0t100 0" />
            <path d="M-60 52q50-22 100 0t100 0t100 0t100 0t100 0t100 0t100 0t100 0t100 0t100 0" />
            <path d="M-60 74q50-22 100 0t100 0t100 0t100 0t100 0t100 0t100 0t100 0t100 0t100 0" />
          </g>
        </svg>
      )}
      <div className={a.heroOrbit} aria-hidden="true" />
      <div className={a.heroGrid}>
        <div className={a.heroCopy}>
          <p className={a.heroEyebrow}>{vi ? 'Học viện Ngữ pháp Echo' : 'Echo Grammar Academy'}</p>
          <h1 id="gr-home-title" className={a.heroTitle}>
            {vi ? <>Mở trang sách.<em>Mở cả thế giới.</em></> : <>Turn a page.<em>Open a world.</em></>}
          </h1>
          <p className={a.heroLead}>
            {vi
              ? 'Khám phá ngữ pháp cùng Echo. Hiểu từng cấu trúc, thử trong câu chuyện và luyện tập theo nhịp của riêng bạn.'
              : 'Explore grammar with Echo. Understand each structure, try it in a story and practise at your own pace.'}
          </p>
          <HeroSearch index={index} ready={!!catalog} vi={vi} />
          <ul className={a.heroFacts}>
            <li className={a.fact}>
              <span className={a.factNum}>{num(counts?.topics, wait)}<small> / {num(counts?.planned, wait)}</small></span>
              <span className={a.factLabel}>{vi ? 'chủ đề đã có bài' : 'topics with a lesson'}</span>
            </li>
            <li className={a.fact}>
              <span className={a.factNum}>{num(counts?.exercises, wait)}</span>
              <span className={a.factLabel}>{vi ? 'bài tập luyện' : 'practice exercises'}</span>
            </li>
            <li className={a.fact}>
              <span className={a.factNum}>{counts ? Object.keys(counts.levels).length : (wait ? '…' : '—')}</span>
              <span className={a.factLabel}>{vi ? 'cấp độ đã có bài' : 'levels with lessons'}</span>
            </li>
          </ul>
        </div>
        {!hasArt ? (
          <aside className={a.plate} aria-hidden="true">
            <div className={g.showRoles}>
              <p className={a.plateLine}><En text="[S|The tide] [AUX|has] [V|turned] [T|since noon]." /></p>
            </div>
            <ul className={a.plateTags}>
              {(['S', 'AUX', 'V', 'T'] as const).map((r) => <li key={r}><span className={g.chip}>{r}</span></li>)}
            </ul>
            <p className={a.plateNote}>
              {vi ? 'Mỗi vai trò trong câu có một màu, một kiểu gạch và một tên riêng: không bao giờ chỉ dựa vào màu.' : 'Every role in a sentence has its own colour, underline style and name: never colour alone.'}
            </p>
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function HeroSearch({ index, ready, vi }: { index: Map<string, TopicEntry>; ready: boolean; vi: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const docs = useMemo(() => buildSearchIndex(index.values()), [index]);
  const trimmed = q.trim();
  const all = useMemo(() => (trimmed ? (search(docs, trimmed) ?? []) : []), [docs, trimmed]);
  const hits = all.slice(0, 5);
  const total = all.length;
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    router.push(trimmed ? `/grammar/library?q=${encodeURIComponent(trimmed)}` : '/grammar/library');
  };
  return (
    <form className={a.heroSearch} onSubmit={go} role="search" aria-label={vi ? 'Tìm trong thư viện Ngữ pháp' : 'Search the grammar library'}>
      <div className={a.heroField} data-guide="grammar-search">
        <Search aria-hidden="true" />
        <label htmlFor="gr-home-q" className={g.srOnly}>{vi ? 'Tìm một chủ đề ngữ pháp' : 'Find a grammar topic'}</label>
        <input
          id="gr-home-q"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={vi ? 'Thử “since for”, “mạo từ”, “đã từng”…' : 'Try “since for”, “articles”, “đã từng”…'}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        <button type="submit" className={cx(g.btn, g.btnPrimary, g.btnSm)}>{vi ? 'Tìm' : 'Search'}</button>
      </div>
      <span className={g.srOnly} aria-live="polite">{trimmed && ready ? (vi ? `${total} kết quả` : `${total} results`) : ''}</span>
      {trimmed && ready ? (
        hits.length ? (
          <ul className={a.heroHits}>
            {hits.map((h) => {
              const t = pair(h.entry.topic.title, vi).main;
              return (
                <li key={h.entry.topic.slug} className={a.heroHit}>
                  {h.entry.topic.available ? (
                    <Link href={`/grammar/topics/${encodeURIComponent(h.entry.topic.slug)}`}>{t}<small>{levelLabel(h.entry.topic.level)}</small></Link>
                  ) : (
                    <div className={a.idxPlain}><span className={a.idxTitle} style={{ fontWeight: 700 }}>{t}</span><small className={a.idxSub} style={{ marginLeft: 'auto' }}>{vi ? 'Đang biên soạn' : 'In preparation'}</small></div>
                  )}
                </li>
              );
            })}
            <li className={a.heroHit}>
              <Link href={`/grammar/library?q=${encodeURIComponent(trimmed)}`}>
                {vi ? `Xem cả ${total} kết quả trong Thư viện` : `See all ${total} results in the Library`}<ArrowRight aria-hidden="true" style={{ width: '1rem', height: '1rem', marginLeft: 'auto' }} />
              </Link>
            </li>
          </ul>
        ) : (
          <p className={g.fine}>{vi ? 'Không có chủ đề nào khớp. Thử một từ ngắn hơn, hoặc gõ không dấu.' : 'No topic matches. Try a shorter word.'}</p>
        )
      ) : null}
    </form>
  );
}

/* ═══ desk: what to do next, where to start, the numbers ═════════════════════════════════════════════════════════════ */
function NextSteps({ me, wait, failed, retry, index, vi }: {
  me: GrammarMe | undefined; wait: boolean; failed: boolean; retry: () => void; index: Map<string, TopicEntry>; vi: boolean;
}) {
  const steps = (me?.next ?? [])
    .map((n) => ({ n, entry: index.get(n.slug) }))
    .filter((x): x is { n: GrammarMe['next'][number]; entry: TopicEntry } => !!x.entry && x.entry.topic.available);
  const [first, ...rest] = steps;
  const due = (me?.dueReviews ?? []).map((s) => index.get(s)).filter((e): e is TopicEntry => !!e);

  return (
    <>
      <div>
        <p className={a.secKicker}>{vi ? 'Cho riêng bạn' : 'For you'}</p>
        <h2 className={a.secTitle}>{vi ? 'Việc tiếp theo' : 'What to do next'}</h2>
      </div>
      {wait ? (
        <span className={g.skel} aria-hidden="true" style={{ height: '11rem', borderRadius: '1.7rem' }} />
      ) : failed ? (
        <div className={a.panel} role="alert">
          <p className={a.panelText}>{vi ? 'Chưa tải được tiến độ của bạn. Danh mục bên dưới vẫn dùng được.' : 'Your progress could not be loaded. The catalog below still works.'}</p>
          <button type="button" className={cx(g.btn, g.btnSoft, g.btnSm)} onClick={retry}><RotateCcw aria-hidden="true" />{vi ? 'Thử lại' : 'Try again'}</button>
        </div>
      ) : (
        <>
          {due.length ? (
            <div className={a.dueBand}>
              <div className={a.dueText}>
                <strong>{vi ? `${due.length} chủ đề đến hạn ôn lại` : `${due.length} topic${due.length === 1 ? '' : 's'} due for review`}</strong>
                <ul className={a.dueLinks}>
                  {due.slice(0, 4).map((e) => (
                    <li key={e.topic.slug}><Link href={`/grammar/topics/${encodeURIComponent(e.topic.slug)}`}>{pair(e.topic.title, vi).main}</Link></li>
                  ))}
                </ul>
              </div>
              <Link href="/grammar/practice?kind=due" className={cx(g.btn, g.btnPrimary)}>{vi ? 'Ôn ngay' : 'Review now'}</Link>
            </div>
          ) : null}
          {first ? (
            <FeatCard step={first.n.reason} entry={first.entry} vi={vi} />
          ) : (
            <div className={a.panel}>
              <h3 className={a.panelTitle}>{me?.startLevel ? (vi ? 'Chưa có gợi ý lúc này' : 'No suggestion right now') : (vi ? 'Chọn chỗ bắt đầu' : 'Choose where to start')}</h3>
              <p className={a.panelText} style={{ marginBottom: 0 }}>
                {me?.startLevel
                  ? (vi ? 'Mở con đường bên dưới và chọn một chủ đề đã có bài. Gợi ý sẽ xuất hiện khi bạn học và luyện.' : 'Open the path below and pick a topic that has a lesson. Suggestions appear as you study and practise.')
                  : (vi ? 'Làm bài chẩn đoán ngắn hoặc tự chọn một mức ở bên cạnh để có gợi ý chủ đề đầu tiên.' : 'Take the short diagnostic or choose a level next to this to get a first topic.')}
              </p>
            </div>
          )}
          {rest.length ? (
            <ul className={a.nextRest}>
              {rest.slice(0, 4).map(({ n, entry }) => (
                <li key={entry.topic.slug}>
                  <Link href={`/grammar/topics/${encodeURIComponent(entry.topic.slug)}`} className={a.nextMini} data-tone={entry.domain.tone}>
                    <span className={a.nextReason} style={{ alignSelf: 'flex-start' }}>{(REASON[n.reason] ?? REASON.NEXT_ON_PATH)[vi ? 'vi' : 'en']}</span>
                    <strong>{pair(entry.topic.title, vi).main}</strong>
                    <span className={g.chip} style={{ alignSelf: 'flex-start' }}>{levelLabel(entry.topic.level)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </>
  );
}

function FeatCard({ step, entry, vi }: { step: RecommendationReason; entry: TopicEntry; vi: boolean }) {
  const r = REASON[step] ?? REASON.NEXT_ON_PATH;
  const t = pair(entry.topic.title, vi);
  const sub = entry.topic.subtitle ? pair(entry.topic.subtitle, vi).main : null;
  return (
    <Link href={`/grammar/topics/${encodeURIComponent(entry.topic.slug)}`} className={cx(a.nextFeat, g.livingCard)} data-grammar-card data-spatial-owner="grammar-card" data-morph-source={entry.topic.slug} data-tone={entry.domain.tone} data-guide="grammar-next">
      <span className={a.nextReason}>{vi ? r.vi : r.en}</span>
      <h3 className={a.nextTitle}>{t.main}</h3>
      {sub ? <p className={a.nextSub}>{sub}</p> : null}
      <div className={g.chips}>
        <span className={g.chip}>{levelLabel(entry.topic.level)}</span>
        <span className={g.chip}>{pair(entry.domain.title, vi).main}</span>
      </div>
      <span className={a.nextGo}>{vi ? r.go.vi : r.go.en}<ArrowRight aria-hidden="true" /></span>
    </Link>
  );
}

function StartPanel({ me, wait, failed, onChanged, vi }: {
  me: GrammarMe | undefined; wait: boolean; failed: boolean; onChanged: () => Promise<void>; vi: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (wait) return <span className={g.skel} aria-hidden="true" style={{ height: '14rem', borderRadius: '1.5rem' }} />;
  if (failed || !me) return null;

  const pick = async (level: Level) => {
    setBusy(level); setNote(null);
    try { await grammarApi.setLevel(level); await onChanged(); setChanging(false); }
    catch { setNote(vi ? 'Chưa lưu được mức của bạn. Hãy thử lại.' : 'Your level could not be saved. Please try again.'); }
    finally { setBusy(null); }
  };
  const diagnostic = async () => {
    setBusy('diag'); setNote(null);
    try {
      const view = await grammarApi.startCheck('DIAGNOSTIC');
      router.push(`/grammar/check/${encodeURIComponent(view.id)}`);
    } catch (err) {
      setBusy(null);
      setNote(apiFailure(err).code === 'NOT_ENOUGH_ITEMS'
        ? (vi ? 'Bài chẩn đoán chưa đủ câu vì nội dung vẫn đang được biên soạn. Bạn có thể tự chọn mức.' : 'The diagnostic does not have enough questions yet because the content is still being written. You can choose a level yourself.')
        : (vi ? 'Chưa bắt đầu được bài chẩn đoán. Hãy thử lại sau.' : 'The diagnostic could not start. Please try again later.'));
    }
  };

  const levels = (
    <div className={a.levelGrid} role="group" aria-label={vi ? 'Chọn mức bắt đầu' : 'Choose a starting level'}>
      {LEVELS.map((l) => (
        <button key={l} type="button" className={a.levelBtn} aria-pressed={me.startLevel === l} disabled={busy !== null} onClick={() => { void pick(l); }}>
          {busy === l ? '…' : levelLabel(l)}
        </button>
      ))}
    </div>
  );
  const diagnosticText = vi
    ? 'Một bài ngắn với vài câu ở nhiều mức. Kết quả chỉ là ước lượng tạm thời để gợi ý chỗ bắt đầu, không phải điểm số hay chứng nhận.'
    : 'A short set of questions across several levels. The result is only a provisional estimate to suggest where to begin, not a score or a certificate.';

  return (
    <section className={a.panel} aria-labelledby="gr-start-title">
      {me.startLevel ? (
        <>
          <h2 id="gr-start-title" className={a.panelTitle}>{vi ? 'Chỗ bắt đầu của bạn' : 'Where you begin'}</h2>
          <div className={a.startNow}>
            <span className={a.startLevel}>{levelLabel(me.startLevel)}</span>
            <p className={a.startWhy}>
              {levelName(me.startLevel, vi)}
              {' · '}
              {me.startBasis === 'DIAGNOSTIC' ? (vi ? 'từ bài chẩn đoán, chỉ là ước lượng' : 'from the diagnostic, only an estimate') : (vi ? 'do bạn tự chọn' : 'chosen by you')}
            </p>
          </div>
          {changing ? levels : null}
          <div className={a.startActions}>
            <button type="button" className={cx(g.btn, g.btnSoft, g.btnSm)} onClick={() => setChanging((v) => !v)} aria-expanded={changing}>{vi ? 'Đổi mức' : 'Change level'}</button>
            <button type="button" className={cx(g.btn, g.btnQuiet, g.btnSm)} disabled={busy !== null} onClick={() => { void diagnostic(); }} data-guide="grammar-diagnostic">
              <Compass aria-hidden="true" />{busy === 'diag' ? '…' : (vi ? 'Làm lại bài chẩn đoán' : 'Retake the diagnostic')}
            </button>
          </div>
          <p className={g.fine}>{diagnosticText}</p>
        </>
      ) : (
        <>
          <h2 id="gr-start-title" className={a.panelTitle}>{vi ? 'Bắt đầu từ đâu?' : 'Where should you start?'}</h2>
          <p className={a.panelText}>{vi ? 'Chọn một trong hai cách. Bạn có thể đổi lại bất cứ lúc nào.' : 'Pick either way. You can change it at any time.'}</p>
          <div className={a.startPick}>
            <div className={a.startOpt}>
              <h3>{vi ? 'Làm bài chẩn đoán ngắn' : 'Take the short diagnostic'}</h3>
              <p>{diagnosticText}</p>
              <div>
                <button type="button" className={cx(g.btn, g.btnPrimary)} disabled={busy !== null} onClick={() => { void diagnostic(); }} data-guide="grammar-diagnostic">
                  <Compass aria-hidden="true" />{busy === 'diag' ? '…' : (vi ? 'Bắt đầu chẩn đoán' : 'Start the diagnostic')}
                </button>
              </div>
            </div>
            <div className={a.startOpt}>
              <h3>{vi ? 'Tự chọn mức' : 'Choose a level yourself'}</h3>
              <p>{vi ? 'Chọn mức bạn nghĩ mình đang ở. Mức chỉ dùng để gợi ý chủ đề đầu tiên.' : 'Pick the level you think you are at. It only suggests the first topic.'}</p>
              {levels}
            </div>
          </div>
        </>
      )}
      {note ? <p className={g.callout} data-tone="warn" role="alert"><TriangleAlert aria-hidden="true" />{note}</p> : null}
    </section>
  );
}

function Stats({ me, wait, vi }: { me: GrammarMe | undefined; wait: boolean; vi: boolean }) {
  const c = me?.counts;
  const items: [string, number | undefined, string][] = [
    ['opened', c?.opened, vi ? 'Đã mở' : 'Opened'],
    ['studied', c?.studied, vi ? 'Đã học' : 'Studied'],
    ['mastered', c?.mastered, vi ? 'Đã nắm' : 'Mastered'],
    ['due', c?.due, vi ? 'Đến hạn ôn' : 'Due for review'],
  ];
  return (
    <section className={a.panel} aria-label={vi ? 'Con số của bạn' : 'Your numbers'}>
      <h2 className={a.panelTitle}>{vi ? 'Bàn học của bạn' : 'Your desk'}</h2>
      <ul className={a.stats}>
        {items.map(([k, v, label]) => (
          <li key={k} className={a.stat}><span className={a.statNum}>{num(v, wait)}</span><span className={a.statLabel}>{label}</span></li>
        ))}
      </ul>
      <p className={g.fine}>
        {c ? (vi ? `${c.attempts30d} lượt làm bài trong 30 ngày qua.` : `${c.attempts30d} attempt${c.attempts30d === 1 ? '' : 's'} in the last 30 days.`) : ''}
      </p>
      <div className={a.statLinks}>
        <Link href="/grammar/practice" className={cx(g.btn, g.btnSoft, g.btnSm)}>{vi ? 'Luyện tập' : 'Practice'}</Link>
        <Link href="/grammar/mistakes" className={cx(g.btn, g.btnQuiet, g.btnSm)}>{vi ? 'Lỗi của tôi' : 'My mistakes'}</Link>
        <Link href="/grammar/library?bm=1" className={cx(g.btn, g.btnQuiet, g.btnSm)}>{vi ? `Đã lưu${c ? ` (${c.bookmarks})` : ''}` : `Saved${c ? ` (${c.bookmarks})` : ''}`}</Link>
      </div>
    </section>
  );
}

/* ═══ the path: seven stations, Pre-A1 to C2 ═════════════════════════════════════════════════════════════════════════ */
function PathSection({ catalog, me, wait, vi }: { catalog: Catalog; me: GrammarMe | undefined; wait: boolean; vi: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const requested = sp.get('focus');
  const focus = requested === 'core' || requested === 'advanced' ? requested
    : me?.startLevel && ['B2', 'C1', 'C2'].includes(me.startLevel) ? 'advanced' : 'core';
  const chooseFocus = (value: string) => {
    const next = new URLSearchParams(sp.toString());
    next.set('focus', value);
    router.push(`/grammar?${next.toString()}`, { scroll: false });
  };
  const stations = useMemo(() => {
    const by = new Map<Level, TopicEntry[]>(LEVELS.map((l) => [l, []]));
    for (const domain of catalog.domains) {
      if (domain.kind !== 'grammar') continue;
      for (const topic of domain.topics) {
        if ((topic.learningRole ?? 'core') === focus) by.get(topic.level)?.push({ topic, domain });
      }
    }
    return LEVELS.map((level) => {
      const all = (by.get(level) ?? []).slice().sort((x, y) => pathKey(x) - pathKey(y));
      return { level, ready: all.filter((e) => e.topic.available), planned: all.filter((e) => !e.topic.available) };
    }).filter((s) => s.ready.length + s.planned.length > 0);
  }, [catalog, focus]);
  const mastered = useMemo(() => new Set((me?.states ?? []).filter((s) => s.status === 'MASTERED').map((s) => s.slug)), [me]);

  return (
    <section className={a.sec} aria-labelledby="gr-path-title">
      <div className={a.secHead}>
        <div>
          <p className={a.secKicker}>{vi ? 'Lộ trình' : 'The path'}</p>
          <h2 id="gr-path-title" className={a.secTitle}>{vi ? 'Học theo điều bạn cần' : 'Study what you need'}</h2>
          <p className={a.secLead}>
            {vi
              ? 'Chọn kiến thức trọng tâm hoặc mở rộng theo nhu cầu. Bạn có thể mở bất kỳ bài nào, làm kiểm tra để bỏ qua điều đã biết và quay lại phần còn yếu. Cấp độ và nhóm học là gợi ý biên soạn; không cần hoàn thành cả thư viện.'
              : 'Choose core knowledge or useful extensions. Open any topic, take a check to skip what you know and return to weaker areas. Levels and groups are editorial suggestions; the whole reference library is never a compulsory course.'}
          </p>
          <Segmented<string>
            label={vi ? 'Trọng tâm lộ trình' : 'Path focus'}
            value={focus}
            options={[{ id: 'core', label: vi ? 'Kiến thức trọng tâm' : 'Essential core' }, { id: 'advanced', label: vi ? 'Mở rộng hữu ích' : 'Useful advanced study' }]}
            onChange={chooseFocus}
          />
          <p className={g.fine}>{vi ? 'Vòng tròn chỉ thể hiện kết quả kiểm tra trong nhóm đang chọn, không chứng nhận cấp độ CEFR.' : 'Rings show check evidence within the selected group, not CEFR certification.'}</p>
        </div>
        <Link href="/grammar/library" className={cx(g.btn, g.btnQuiet, g.btnSm)}>{vi ? 'Tra cứu toàn bộ thư viện' : 'Browse the full reference'}</Link>
      </div>
      <ol className={a.path} data-guide="grammar-path">
        {stations.map(({ level, ready, planned }) => {
          const m = ready.filter((e) => mastered.has(e.topic.slug)).length;
          const here = me?.startLevel === level;
          const pct = ready.length ? Math.round((m / ready.length) * 100) : 0;
          return (
            <li key={level} className={a.station} data-here={here ? 'true' : 'false'} data-empty={ready.length ? 'false' : 'true'}>
              <div className={a.node} style={{ '--p': pct } as React.CSSProperties} aria-hidden="true"><span>{levelLabel(level)}</span></div>
              <div className={a.stationBody}>
                <div className={a.stationHead}>
                  <h3 className={a.stationName}><span lang="en">{levelLabel(level)}</span> · {levelName(level, vi)}</h3>
                  {here ? <span className={a.stationHere}><Compass aria-hidden="true" style={{ width: '0.9rem', height: '0.9rem' }} />{vi ? 'Bạn bắt đầu ở đây' : 'You start here'}</span> : null}
                  <p className={a.stationMeta}>
                    {vi ? `${ready.length} / ${ready.length + planned.length} chủ đề đã có bài` : `${ready.length} of ${ready.length + planned.length} topics have a lesson`}
                    {ready.length ? ` · ${vi ? 'đã nắm' : 'mastered'} ${num(me ? m : undefined, wait)}` : ''}
                  </p>
                </div>
                {ready.length ? (
                  <ul className={a.stones}>
                    {ready.map((e) => (
                      <li key={e.topic.slug}>
                        <Link href={`/grammar/topics/${encodeURIComponent(e.topic.slug)}`} className={cx(a.stone, g.livingCard)} data-grammar-card data-spatial-owner="grammar-card" data-morph-source={e.topic.slug} data-tone={e.domain.tone}>
                          <span className={a.stoneDomain}>{pair(e.domain.title, vi).main}</span>
                          <span className={a.stoneTitle}>{pair(e.topic.title, vi).main}</span>
                          <span className={g.chips}>
                            <StateChip me={me} slug={e.topic.slug} vi={vi} />
                            {typeof e.topic.exerciseCount === 'number' ? <span className={g.chip}>{vi ? `${e.topic.exerciseCount} bài tập` : `${e.topic.exerciseCount} exercises`}</span> : null}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={a.stationNone}>{vi ? 'Các chủ đề của chặng này đang được biên soạn.' : 'The topics of this stage are being written.'}</p>
                )}
                {planned.length ? (
                  <details className={a.planned}>
                    <summary><ChevronRight aria-hidden="true" />{vi ? `Đang biên soạn: ${planned.length} chủ đề` : `In preparation: ${planned.length} topics`}</summary>
                    <ul className={a.plannedList}>
                      {planned.map((e) => (
                        <li key={e.topic.slug} className={a.plannedItem} data-tone={e.domain.tone}>
                          <Clock aria-hidden="true" style={{ width: '0.85rem', height: '0.85rem', alignSelf: 'center' }} />
                          <span>{pair(e.topic.title, vi).main}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ═══ domains ════════════════════════════════════════════════════════════════════════════════════════════════════════ */
function DomainsSection({ catalog, vi }: { catalog: Catalog; vi: boolean }) {
  const domains = catalog.domains.filter((d) => d.kind === 'grammar');
  if (!domains.length) return null;
  return (
    <section className={a.sec} aria-labelledby="gr-domains-title">
      <div className={a.secHead}>
        <div>
          <p className={a.secKicker}>{vi ? 'Các mảng kiến thức' : 'Areas of grammar'}</p>
          <h2 id="gr-domains-title" className={a.secTitle}>{vi ? 'Đi theo chủ đề' : 'Browse by area'}</h2>
        </div>
        <Link href="/grammar/library" className={cx(g.btn, g.btnQuiet, g.btnSm)}>{vi ? 'Mở cả thư viện' : 'Open the whole library'}</Link>
      </div>
      <ul className={a.domains}>
        {domains.map((d, i) => {
          const ready = d.topics.filter((t) => t.available).length;
          return (
            <li key={d.id}>
              <Link href={`/grammar/library?domain=${encodeURIComponent(d.id)}`} className={cx(a.spine, g.livingCard)} data-grammar-card data-spatial-owner="grammar-card" data-morph-source={d.id} data-tone={d.tone}>
                <span className={a.spineNum} aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                <h3 className={a.spineTitle}>{pair(d.title, vi).main}</h3>
                <p className={a.spineText}>{pair(d.summary, vi).main}</p>
                <span className={a.spineFoot}>
                  <span>{vi ? `${ready} / ${d.topics.length} chủ đề đã có bài` : `${ready} of ${d.topics.length} with a lesson`}</span>
                  <ArrowRight aria-hidden="true" />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ═══ tracks and other ways to learn ═════════════════════════════════════════════════════════════════════════════════ */
function TracksSection({ catalog, vi }: { catalog: Catalog; vi: boolean }) {
  return (
    <section className={a.sec} aria-labelledby="gr-tracks-title">
      <div className={a.secHead}>
        <div>
          <p className={a.secKicker}>{vi ? 'Ứng dụng' : 'Applied grammar'}</p>
          <h2 id="gr-tracks-title" className={a.secTitle}>{vi ? 'Ngữ pháp cho mục tiêu của bạn' : 'Grammar for your goal'}</h2>
        </div>
      </div>
      <ul className={a.tracks}>
        {TRACK_IDS.map((id) => {
          const def = TRACKS[id];
          const domain = catalog.domains.find((d) => d.id === def.domain);
          const ready = domain?.topics.filter((t) => t.available).length;
          return (
            <li key={id}>
              <Link href={def.href} className={a.track} data-track={id} data-tone={domain?.tone ?? def.tone}>
                <h3 className={a.trackName}>{vi ? def.name.vi : def.name.en}</h3>
                <p className={a.trackText}>{domain ? pair(domain.summary, vi).main : ''}</p>
                <p className={a.trackNot}>{vi ? def.not.vi : def.not.en}</p>
                <span className={a.itemFoot}>
                  <span>{domain ? (vi ? `${ready} / ${domain.topics.length} chủ đề đã có bài` : `${ready} of ${domain.topics.length} with a lesson`) : ''}</span>
                  <ArrowRight aria-hidden="true" />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function WaysSection({ catalog, vi }: { catalog: Catalog; vi: boolean }) {
  const ways = [
    { href: '/grammar/lab', tone: 'lagoon', icon: FlaskConical, n: catalog.counts.lab, one: vi ? 'thí nghiệm' : 'experiment', many: vi ? 'thí nghiệm' : 'experiments',
      title: vi ? 'Phòng thí nghiệm' : 'Grammar Lab', text: vi ? 'Bật tắt từng yếu tố của một câu và xem nghĩa thay đổi thế nào.' : 'Switch one part of a sentence at a time and watch the meaning change.' },
    { href: '/grammar/stories', tone: 'dawn', icon: BookOpenText, n: catalog.counts.stories, one: vi ? 'câu chuyện' : 'story', many: vi ? 'câu chuyện' : 'stories',
      title: vi ? 'Câu chuyện' : 'Stories', text: vi ? 'Đọc một tình huống, chọn cách nói và xem điều gì xảy ra tiếp theo.' : 'Read a situation, choose what to say and see what happens next.' },
    { href: '/grammar/detective', tone: 'violet', icon: ScanSearch, n: catalog.counts.detective, one: vi ? 'vụ án' : 'case', many: vi ? 'vụ án' : 'cases',
      title: vi ? 'Thám tử Ngữ pháp' : 'Grammar Detective', text: vi ? 'Đọc một đoạn văn, chỉ ra chỗ sai, và đừng tố nhầm câu trông sai mà đúng.' : 'Read a paragraph, point at what is wrong, and do not accuse what only looks wrong.' },
  ];
  return (
    <section className={a.sec} aria-labelledby="gr-ways-title">
      <div className={a.secHead}>
        <div>
          <p className={a.secKicker}>{vi ? 'Học bằng cách khác' : 'Learn another way'}</p>
          <h2 id="gr-ways-title" className={a.secTitle}>{vi ? 'Thử, đọc và điều tra' : 'Try, read and investigate'}</h2>
        </div>
      </div>
      <ul className={a.ways}>
        {ways.map((w) => {
          const Icon = w.icon;
          return (
            <li key={w.href}>
              <Link href={w.href} className={cx(a.way, g.livingCard)} data-grammar-card data-spatial-owner="grammar-card" data-morph-source={w.href} data-tone={w.tone}>
                <Icon className={a.wayDecor} aria-hidden="true" strokeWidth={0.7} />
                <span className={a.wayIcon} aria-hidden="true"><Icon /></span>
                <h3 className={a.wayTitle}>{w.title}</h3>
                <p className={a.wayText}>{w.text}</p>
                <span className={a.wayCount}><span>{w.n > 0 ? `${w.n} ${w.n === 1 ? w.one : w.many}` : (vi ? 'Đang biên soạn' : 'In preparation')}</span><ArrowRight aria-hidden="true" /></span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default GrammarHome;
