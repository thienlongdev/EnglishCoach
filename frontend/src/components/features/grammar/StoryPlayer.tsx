'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { ArrowRight, Check, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { grammarApi } from '@/services/grammarApi';
import { useContentTitle } from '@/lib/brand/tabTitle';
import { apiFailure, cx, levelLabel } from '@/lib/grammar/format';
import { useGrammarCatalog, useTopicIndex } from '@/hooks/useGrammar';
import type { Story, StoryBeat } from '@/types/grammar';
import { Blocks } from './Blocks';
import { LessonShelf } from './LessonShelf';
import { CardsSkeleton, ChapterHead, Crumbs, EmptyState, ErrorState, pair, useVi } from './AcademyKit';
import { En, Vi } from './Inline';
import { SceneArt } from './SceneArt';
import { usePrefersReducedMotion } from './diagrams/shared';
import g from './grammar.module.css';
import v from './subviews.module.css';
import a from './academy.module.css';

const CAST_TONES = ['violet', 'ocean', 'meadow', 'ember', 'lagoon', 'sun', 'dawn', 'reef'];
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** `/grammar/stories` (the list) and `/grammar/stories/<id>` (one story). Everything here is client state: nothing is sent. */
export function StoryPlayer({ id }: { id?: string }) {
  return id ? <StoryRun id={id} /> : <StoryIndex />;
}

/* ═══ index ══════════════════════════════════════════════════════════════════════════════════════════════════════════ */
function StoryIndex() {
  const vi = useVi();
  const { data: catalog, error, isLoading, mutate } = useGrammarCatalog();
  const stories = catalog?.stories ?? [];
  return (
    <div className={cx(a.page, v.view)}>
      <ChapterHead
        eyebrow={vi ? 'Câu chuyện' : 'Stories'}
        title={vi ? 'Học ngữ pháp qua một tình huống' : 'Grammar through a situation'}
        lead={vi ? 'Đọc một đoạn hội thoại, chọn cách nói và xem điều gì xảy ra. Nhiều cách nói đều đúng nhưng mang nghĩa khác nhau, và truyện sẽ nói rõ điều đó.' : 'Read a dialogue, choose what to say and see what happens. Several ways of saying it can be right with different meanings, and the story says so.'}
        tone="dawn"
        motif="story"
      />
      <section className={a.sec} style={{ marginTop: '2rem' }} aria-label={vi ? 'Các câu chuyện' : 'Stories'}>
        {error && !catalog ? <ErrorState vi={vi} onRetry={() => { void mutate(); }} />
          : isLoading || !catalog ? <CardsSkeleton cards={3} />
          : !stories.length ? (
            <EmptyState
              title={vi ? 'Chưa có câu chuyện nào' : 'No stories yet'}
              text={vi ? 'Các câu chuyện đang được biên soạn. Mỗi truyện sẽ gắn với những chủ đề ngữ pháp cụ thể. Trong lúc chờ, hãy học theo chủ đề trong thư viện.' : 'The stories are being written. Each one will be tied to specific grammar topics. Meanwhile, study by topic in the library.'}
            >
              <Link href="/grammar/library" className={cx(g.btn, g.btnPrimary)}>{vi ? 'Mở thư viện' : 'Open the library'}</Link>
            </EmptyState>
          ) : (
            <LessonShelf cards={stories} vi={vi} className={cx(a.items, v.storyShelf)}>
              {(s, _ordinal, topic) => (
                <li key={s.id}>
                  <Link prefetch={false} href={`/grammar/stories/${encodeURIComponent(s.id)}`} className={cx(a.item, v.storyCard)} data-tone="dawn">
                    <div className={cx(a.itemThumb, v.cover)}><SceneArt scene={s.scene} vi={vi} size="thumb" /></div>
                    <span className={g.chips}><span className={g.chip}>{levelLabel(s.level)}</span><span className={g.chip}>{topic}</span></span>
                    <h2 className={a.itemTitle}>{s.title}</h2>
                    <p className={a.itemText}>{s.summary}</p>
                    <span className={a.itemFoot}><span>{vi ? 'Đọc truyện' : 'Read the story'}</span><ArrowRight aria-hidden="true" /></span>
                  </Link>
                </li>
              )}
            </LessonShelf>
          )}
      </section>
    </div>
  );
}

/* ═══ one story ══════════════════════════════════════════════════════════════════════════════════════════════════════ */
function StoryRun({ id }: { id: string }) {
  const vi = useVi();
  const { data: story, error, isLoading, mutate } = useSWR<Story>(['grammar-story', id], () => grammarApi.story(id), { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 60_000 });
  useContentTitle(story?.title);
  const crumbs = [{ href: '/grammar', label: vi ? 'Ngữ pháp' : 'Grammar' }, { href: '/grammar/stories', label: vi ? 'Câu chuyện' : 'Stories' }];

  if (error || !story) {
    if (isLoading && !error) return <div className={cx(a.page, v.view)}><Crumbs vi={vi} items={[...crumbs, { label: '…' }]} /><span className={g.skel} aria-hidden="true" style={{ display: 'block', height: '16rem', borderRadius: '1.9rem' }} /></div>;
    const missing = apiFailure(error).status === 404;
    return (
      <div className={cx(a.page, v.view)}>
        <Crumbs vi={vi} items={[...crumbs, { label: vi ? 'Không tìm thấy' : 'Not found' }]} />
        {missing
          ? <EmptyState title={vi ? 'Không tìm thấy câu chuyện này' : 'This story was not found'} text={vi ? 'Đường dẫn có thể đã cũ, hoặc truyện chưa được công bố.' : 'The link may be old, or the story is not published yet.'}><Link href="/grammar/stories" className={cx(g.btn, g.btnPrimary)}>{vi ? 'Về danh sách truyện' : 'Back to the stories'}</Link></EmptyState>
          : <ErrorState vi={vi} onRetry={() => { void mutate(); }} />}
      </div>
    );
  }
  return (
    <div className={cx(a.page, v.view)}>
      <Crumbs vi={vi} items={[...crumbs, { label: story.title }]} />
      <ChapterHead eyebrow={vi ? 'Câu chuyện' : 'Story'} title={story.title} lead={story.summary} tone="dawn" motif="story">
        <div className={a.chapterFacts}><span className={g.chip}>{levelLabel(story.level)}</span></div>
        {story.cast.length ? (
          <ul className={a.cast} aria-label={vi ? 'Nhân vật' : 'Cast'}>
            {story.cast.map((c, i) => (
              <li key={c.id} className={a.castItem} data-tone={CAST_TONES[i % CAST_TONES.length]}>
                <span className={a.avatar} style={{ width: '1.9rem', height: '1.9rem', fontSize: '0.8rem' }} aria-hidden="true">{c.name.slice(0, 1).toUpperCase()}</span>
                {c.name}<small>{c.role}</small>
              </li>
            ))}
          </ul>
        ) : null}
      </ChapterHead>
      <Player key={story.id} story={story} vi={vi} />
    </div>
  );
}

interface Step { id: string; pick: number | null }

function Player({ story, vi }: { story: Story; vi: boolean }) {
  const { index } = useTopicIndex();
  const reduced = usePrefersReducedMotion();
  const byId = useMemo(() => new Map<string, StoryBeat>(story.beats.map((b) => [b.id, b])), [story]);
  const cast = useMemo(() => new Map(story.cast.map((c, i) => [c.id, { ...c, i }])), [story]);
  const [trail, setTrail] = useState<Step[]>(() => [{ id: story.beats[0]?.id ?? '', pick: null }]);
  const [showVi, setShowVi] = useState(false);
  const lastRef = useRef<HTMLElement | null>(null);
  const moved = useRef(false);

  useEffect(() => {
    if (!moved.current) return;
    lastRef.current?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  }, [trail.length, reduced]);

  if (!story.beats.length) return <EmptyState title={vi ? 'Câu chuyện này chưa có nội dung' : 'This story has no content yet'} text={vi ? 'Nội dung đang được hoàn thiện.' : 'The content is being finished.'} />;

  const sceneAt = (i: number) => byId.get(trail[i].id)?.scene ?? story.scene;
  const current = trail[trail.length - 1];
  const beat = byId.get(current.id);
  const option = beat?.choice && current.pick != null ? beat.choice.options[current.pick] : null;
  const nextId = option?.next ?? beat?.next;
  const waiting = !!beat?.choice && current.pick == null;
  const canGo = !!beat && !beat.end && !!nextId && byId.has(nextId) && !waiting;
  const finished = !beat || (!waiting && !canGo);

  const pick = (oi: number) => setTrail((t) => t.map((s, i) => (i === t.length - 1 ? { ...s, pick: oi } : s)));
  const go = () => { if (!nextId) return; moved.current = true; setTrail((t) => [...t, { id: nextId, pick: null }]); };
  const restart = () => { moved.current = false; setTrail([{ id: story.beats[0].id, pick: null }]); window.scrollTo?.({ top: 0 }); };

  return (
    <>
      <div className={cx(a.storyBar, v.storyToolbar)}>
        <p aria-live="polite">{vi ? `Đoạn ${trail.length}` : `Part ${trail.length}`}{finished ? (vi ? ' · kết thúc' : ' · the end') : ''}</p>
        <div>
          <button type="button" className={cx(g.switch, showVi && g.switchOn)} aria-pressed={showVi} onClick={() => setShowVi((v) => !v)}>
            {showVi ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}{vi ? 'Hiện tiếng Việt' : 'Show Vietnamese'}
          </button>
          <button type="button" className={cx(g.btn, g.btnQuiet, g.btnSm)} onClick={restart}><RotateCcw aria-hidden="true" />{vi ? 'Đọc lại từ đầu' : 'Start again'}</button>
        </div>
      </div>

      <div className={cx(a.log, v.storyLog)}>
        {trail.map((step, i) => {
          const b = byId.get(step.id);
          const last = i === trail.length - 1;
          if (!b) return null;
          const plate = i === 0 || sceneAt(i) !== sceneAt(i - 1);
          const picked = b.choice && step.pick != null ? b.choice.options[step.pick] : null;
          const showExplain = !!b.explain?.length && (!b.choice || step.pick != null);
          return (
            <article key={`${step.id}-${i}`} ref={last ? lastRef : undefined} className={cx(a.beat, v.storyBeat)} data-past={last ? undefined : 'true'} aria-label={vi ? `Đoạn ${i + 1}` : `Part ${i + 1}`}>
              {plate ? <SceneArt scene={sceneAt(i)} vi={vi} size={i === 0 ? 'hero' : 'plate'} parallax={i === 0} /> : null}
              {b.narrate ? <Vi as="p" className={a.narrate} text={b.narrate} /> : null}
              {b.say?.map((line, li) => {
                const c = cast.get(line.who);
                const ci = c?.i ?? 0;
                return (
                  <div key={li} className={cx(a.line, v.dialogue)} data-side={ci % 2 === 0 ? 'l' : 'r'} data-tone={CAST_TONES[ci % CAST_TONES.length]}>
                    <span className={a.avatar} aria-hidden="true">{(c?.name ?? line.who).slice(0, 1).toUpperCase()}</span>
                    <div className={cx(a.bubble, v.speech)}>
                      <span className={a.who}>{c?.name ?? line.who}{c?.role ? ` · ${c.role}` : ''}</span>
                      <En as="p" className={a.sayEn} text={line.en} />
                      {showVi && line.vi ? <p className={a.sayVi}>{line.vi}</p> : null}
                    </div>
                  </div>
                );
              })}

              {b.choice && !last ? (
                <div className={cx(a.line, v.dialogue)} data-side="r">
                  <div className={cx(a.bubble, v.speech)}>
                    <span className={a.who}>{vi ? 'Bạn đã chọn' : 'You chose'}</span>
                    {picked ? <En as="p" className={a.sayEn} text={picked.t} /> : null}
                  </div>
                </div>
              ) : null}
              {b.choice && last ? (
                <div className={cx(a.choice, v.choices)}>
                  <p className={a.choicePrompt}>{b.choice.prompt}</p>
                  <ul className={a.opts}>
                    {b.choice.options.map((o, oi) => (
                      <li key={oi}>
                        <button type="button" className={a.opt} aria-pressed={step.pick === oi} onClick={() => pick(oi)}>
                          <span className={a.optMark} aria-hidden="true">{step.pick === oi ? <Check /> : LETTERS[oi] ?? oi + 1}</span>
                          <span lang="en">{o.t}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {option ? <Reply option={option} okCount={b.choice.options.filter((o) => o.ok).length} vi={vi} /> : <p className={g.fine}>{vi ? 'Chọn một cách nói để đi tiếp. Bạn có thể thử từng cách và đọc nhận xét trước khi tiếp tục.' : 'Choose what to say to go on. You can try each one and read the comment before continuing.'}</p>}
                </div>
              ) : null}

              {showExplain ? (
                last ? (
                  <aside className={a.explain}>
                    <h3>{vi ? 'Vì sao?' : 'Why?'}</h3>
                    <Blocks blocks={b.explain!} idPrefix={`st-${i}`} />
                  </aside>
                ) : (
                  <details className={a.planned}>
                    <summary>{vi ? 'Xem lại phần giải thích' : 'Read the explanation again'}</summary>
                    <aside className={a.explain} style={{ marginTop: '0.6rem' }}><Blocks blocks={b.explain!} idPrefix={`st-${i}`} /></aside>
                  </details>
                )
              ) : null}

              {last && canGo ? (
                <div><button type="button" className={cx(g.btn, g.btnPrimary, g.btnLg)} onClick={go}>{b.choice ? (vi ? 'Tiếp tục theo lựa chọn này' : 'Continue with this choice') : (vi ? 'Tiếp tục' : 'Continue')}<ArrowRight aria-hidden="true" /></button></div>
              ) : null}
            </article>
          );
        })}

        {finished ? (
          <section className={a.ending} aria-labelledby="gr-story-end">
            <h2 id="gr-story-end">{vi ? 'Hết truyện' : 'The end'}</h2>
            <p>{vi ? 'Nếu muốn, hãy đọc lại và chọn một cách nói khác để xem nghĩa thay đổi thế nào. Truyện chỉ chạy trên máy bạn: không có gì được gửi đi và không ghi nhận mức độ thành thạo.' : 'If you like, read it again and choose another way of saying it to see how the meaning changes. The story runs only on your device: nothing is sent and no mastery is recorded.'}</p>
            {story.topics.length ? (
              <ul className={a.endTopics} aria-label={vi ? 'Chủ đề liên quan' : 'Related topics'}>
                {story.topics.map((s) => {
                  const e = index.get(s);
                  const title = e ? pair(e.topic.title, vi).main : s;
                  return <li key={s}>{e?.topic.available ? <Link href={`/grammar/topics/${encodeURIComponent(s)}`}>{title}</Link> : <span>{title}{e ? (vi ? ' · đang biên soạn' : ' · in preparation') : ''}</span>}</li>;
                })}
              </ul>
            ) : null}
            <div className={a.endActions}>
              <button type="button" className={cx(g.btn, g.btnPrimary)} onClick={restart}><RotateCcw aria-hidden="true" />{vi ? 'Đọc lại từ đầu' : 'Read it again'}</button>
              <Link href="/grammar/stories" className={cx(g.btn, g.btnSoft)}>{vi ? 'Các câu chuyện khác' : 'More stories'}</Link>
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}

/** What a choice means. A valid alternative is told as a different meaning, never as simply wrong. */
function Reply({ option, okCount, vi }: { option: NonNullable<StoryBeat['choice']>['options'][number]; okCount: number; vi: boolean }) {
  const kind = option.ok === true ? 'ok' : option.ok === false ? 'no' : undefined;
  const head = option.ok === true
    ? (okCount > 1 ? (vi ? 'Cũng đúng, với nghĩa khác' : 'Also right, with a different meaning') : (vi ? 'Đúng ngữ pháp' : 'Grammatical'))
    : option.ok === false ? (vi ? 'Chưa phù hợp ở đây' : 'Not a fit here') : (vi ? 'Nhận xét' : 'Comment');
  return (
    <div className={a.optReply} data-kind={kind} role="status">
      <b>{head}</b>
      <Vi text={option.note} />
      {option.consequence ? <i><Vi text={option.consequence} /></i> : null}
    </div>
  );
}

export default StoryPlayer;
