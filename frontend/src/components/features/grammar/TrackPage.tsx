'use client';

import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, CircleX, Shuffle, TriangleAlert } from 'lucide-react';
import { grammarApi } from '@/services/grammarApi';
import { apiFailure, cx } from '@/lib/grammar/format';
import { useGrammarMe, useTopicIndex, type TopicEntry } from '@/hooks/useGrammar';
import { ChapterHead, Crumbs, EmptyState, ErrorState, RowsSkeleton, TRACKS, TopicRow, pair, useVi, type TrackId } from './AcademyKit';
import g from './grammar.module.css';
import v from './subviews.module.css';
import a from './academy.module.css';

type Pair = { vi: string; en: string };
const COPY: Record<TrackId, { is: Pair[]; not: Pair[]; extra: Pair }> = {
  ielts: {
    is: [
      { vi: 'Ngữ pháp để viết và nói rõ ràng, chính xác trong bối cảnh IELTS: mô tả số liệu, lập luận, nêu giả định.', en: 'The grammar for writing and speaking clearly and accurately in an IELTS setting: describing data, arguing, supposing.' },
      { vi: 'Mỗi chủ đề có bài học, ví dụ và bài tập luyện đúng cấu trúc đó.', en: 'Each topic has a lesson, examples and exercises on exactly that structure.' },
      { vi: '“Luyện trộn” lấy câu từ các chủ đề của mục này.', en: '“Mixed practice” draws its questions from the topics of this track.' },
    ],
    not: [
      { vi: 'Không phải đề thi thật và không đoán đề.', en: 'Not a real test and not a guess at test questions.' },
      { vi: 'Không chấm và không quy đổi thành band IELTS. Đây là kết quả luyện tập, không quy đổi thành điểm IELTS.', en: 'No band score and no conversion to one. This is practice, not converted to an IELTS score.' },
      { vi: 'IELTS là thương hiệu của các đơn vị đồng sở hữu; English Coach không liên kết.', en: 'IELTS is a trademark of its co-owners; English Coach is not affiliated.' },
    ],
    extra: { vi: 'Chủ đề ngữ pháp nền có ghi chú cho IELTS', en: 'Core grammar topics with an IELTS note' },
  },
  toeic: {
    is: [
      { vi: 'Ngữ pháp hay cần ở Part 5 và Part 6 của phần Reading và trong tiếng Anh công việc: từ loại, thì, giới từ hay liên từ, đại từ quan hệ.', en: 'The grammar that Parts 5 and 6 of the Reading section and workplace English ask for: word class, tense, preposition or conjunction, relative pronouns.' },
      { vi: 'Mỗi chủ đề có bài học và bài tập luyện đúng điểm ngữ pháp đó.', en: 'Each topic has a lesson and exercises on exactly that point.' },
      { vi: '“Luyện trộn” lấy câu từ các chủ đề của mục này.', en: '“Mixed practice” draws its questions from the topics of this track.' },
    ],
    not: [
      { vi: 'Không phải đề TOEIC thật.', en: 'Not a real TOEIC test.' },
      { vi: 'Không quy đổi thành điểm TOEIC. Đây là kết quả luyện tập, không quy đổi thành điểm TOEIC.', en: 'No TOEIC score conversion. This is practice, not converted to a TOEIC score.' },
      { vi: 'TOEIC là thương hiệu của ETS; English Coach không liên kết với ETS.', en: 'TOEIC is a trademark of ETS; English Coach is not affiliated with ETS.' },
    ],
    extra: { vi: 'Chủ đề ngữ pháp nền có ghi chú cho TOEIC', en: 'Core grammar topics with a TOEIC note' },
  },
  'real-world': {
    is: [
      { vi: 'Ngữ pháp trong những việc bạn thật sự làm bằng tiếng Anh: thư công việc, phỏng vấn, thuyết trình, kể chuyện.', en: 'The grammar behind what you really do in English: work emails, interviews, presentations, telling stories.' },
      { vi: 'Mỗi chủ đề bắt đầu từ một tình huống và cho thấy cấu trúc nào làm được việc đó.', en: 'Each topic starts from a situation and shows which structure does the job.' },
      { vi: '“Luyện trộn” lấy câu từ các chủ đề của mục này.', en: '“Mixed practice” draws its questions from the topics of this track.' },
    ],
    not: [
      { vi: 'Không phải khoá luyện giao tiếp: chỉ phần ngữ pháp của tình huống.', en: 'Not a speaking course: only the grammar of the situation.' },
      { vi: 'Không chấm phát âm hay độ trôi chảy.', en: 'No scoring of pronunciation or fluency.' },
      { vi: 'Kết quả luyện tập không phải là chứng chỉ.', en: 'Practice results are not a certificate.' },
    ],
    extra: { vi: '', en: '' },
  },
};

/** `/grammar/ielts`, `/grammar/toeic`, `/grammar/real-world`: an application track, said plainly (what it is and what it is not). */
export function TrackPage({ track }: { track: TrackId }) {
  const vi = useVi();
  const router = useRouter();
  const def = TRACKS[track];
  const copy = COPY[track];
  const { catalog, index, error, isLoading, mutate } = useTopicIndex();
  const { data: me } = useGrammarMe();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const domain = catalog?.domains.find((d) => d.id === def.domain);
  const own = useMemo<TopicEntry[]>(() => (domain ? domain.topics.map((topic) => ({ topic, domain })) : []), [domain]);
  const ownReady = own.filter((e) => e.topic.available).length;
  const related = useMemo<TopicEntry[]>(() => {
    if (track === 'real-world') return [];
    const key: 'ielts' | 'toeic' = track === 'ielts' ? 'ielts' : 'toeic';
    return [...index.values()].filter((e) => e.domain.kind === 'grammar' && !!e.topic.exam?.[key]);
  }, [index, track]);

  const name = vi ? def.name.vi : def.name.en;
  const mix = async () => {
    setBusy(true); setNote(null);
    try {
      const view = await grammarApi.startCheck(def.check.kind, def.check.scope);
      router.push(`/grammar/check/${encodeURIComponent(view.id)}`);
    } catch (err) {
      setBusy(false);
      setNote(apiFailure(err).code === 'NOT_ENOUGH_ITEMS'
        ? (vi ? 'Chưa đủ câu để ghép một bài trộn vì các chủ đề của mục này đang được biên soạn. Bạn vẫn luyện được từng chủ đề đã có bài.' : 'There are not enough questions for a mixed set yet because the topics of this track are still being written. You can still practise each topic that has a lesson.')
        : (vi ? 'Chưa bắt đầu được bài luyện trộn. Hãy thử lại sau.' : 'The mixed practice could not start. Please try again later.'));
    }
  };

  return (
    <div className={cx(a.page, v.view)}>
      <Crumbs vi={vi} items={[{ href: '/grammar', label: vi ? 'Ngữ pháp' : 'Grammar' }, { label: name }]} />
      <ChapterHead
        eyebrow={vi ? 'Ngữ pháp ứng dụng' : 'Applied grammar'}
        title={domain ? pair(domain.title, vi).main : (vi ? `Ngữ pháp cho ${name}` : `Grammar for ${name}`)}
        lead={domain ? pair(domain.summary, vi).main : undefined}
        tone={domain?.tone ?? def.tone}
        motif="track"
      >
        {domain ? <div className={a.chapterFacts}><span className={g.chip}>{vi ? `${ownReady} / ${own.length} chủ đề đã có bài` : `${ownReady} of ${own.length} topics with a lesson`}</span></div> : null}
      </ChapterHead>

      <div className={cx(a.twoCol, v.trackIntro)}>
        <section className={cx(a.isNot, v.trackNote)} data-kind="is" aria-labelledby={`gr-${track}-is`}>
          <h2 id={`gr-${track}-is`}><CircleCheck aria-hidden="true" />{vi ? 'Đây là gì' : 'What this is'}</h2>
          <ul>{copy.is.map((p) => <li key={p.en}>{vi ? p.vi : p.en}</li>)}</ul>
        </section>
        <section className={cx(a.isNot, v.trackNote)} data-kind="not" aria-labelledby={`gr-${track}-not`}>
          <h2 id={`gr-${track}-not`}><CircleX aria-hidden="true" />{vi ? 'Đây không phải là gì' : 'What this is not'}</h2>
          <ul>{copy.not.map((p) => <li key={p.en}>{vi ? p.vi : p.en}</li>)}</ul>
        </section>
      </div>

      <section className={cx(a.practiceBand, v.trackPractice)} data-tone={domain?.tone ?? def.tone} aria-label={vi ? 'Luyện trộn' : 'Mixed practice'}>
        <p>
          <strong>{vi ? 'Luyện trộn' : 'Mixed practice'}</strong>
          {ownReady
            ? (vi ? 'Một bài ngắn gồm câu từ các chủ đề của mục này. Kết quả là kết quả luyện tập, không quy đổi thành điểm thi.' : 'A short set with questions from the topics of this track. The result is practice only, not converted to a test score.')
            : (vi ? 'Mở ra khi mục này có chủ đề đã có bài. Các chủ đề đang được biên soạn.' : 'Opens once this track has topics with a lesson. They are being written.')}
        </p>
        <button type="button" className={cx(g.btn, g.btnPrimary, g.btnLg)} disabled={busy || !ownReady} onClick={() => { void mix(); }}>
          <Shuffle aria-hidden="true" />{busy ? '…' : (vi ? 'Luyện trộn' : 'Start mixed practice')}
        </button>
      </section>
      {note ? <p className={g.callout} data-tone="warn" role="alert"><TriangleAlert aria-hidden="true" />{note}</p> : null}

      <section className={a.sec} aria-labelledby={`gr-${track}-topics`}>
        <div className={a.secHead}>
          <div>
            <p className={a.secKicker}>{vi ? 'Các chủ đề' : 'Topics'}</p>
            <h2 id={`gr-${track}-topics`} className={a.secTitle}>{vi ? `Chủ đề của mục ${name}` : `${name} topics`}</h2>
          </div>
        </div>
        {error && !catalog ? <ErrorState vi={vi} onRetry={mutate} />
          : isLoading || !catalog ? <RowsSkeleton rows={6} />
          : !own.length ? (
            <EmptyState title={vi ? 'Mục này đang được biên soạn' : 'This track is being written'} text={vi ? 'Chưa có chủ đề nào được công bố ở đây. Hãy xem thư viện để biết những gì đã có bài.' : 'No topic has been published here yet. Open the library to see what already has a lesson.'} />
          ) : (
            <ul className={cx(a.rows, v.topicShelf)}>{own.map((e) => <TopicRow key={e.topic.slug} entry={e} me={me} vi={vi} />)}</ul>
          )}
      </section>

      {related.length ? (
        <section className={a.sec} aria-labelledby={`gr-${track}-rel`}>
          <div className={a.secHead}>
            <div>
              <h2 id={`gr-${track}-rel`} className={a.secTitle}>{vi ? copy.extra.vi : copy.extra.en}</h2>
              <p className={a.secLead}>{vi ? 'Những bài của phần Ngữ pháp chung có nêu cách dùng trong kỳ thi này.' : 'Lessons of the general grammar sections that note how they are used in this exam.'}</p>
            </div>
          </div>
          <ul className={cx(a.rows, v.topicShelf)}>{related.map((e) => <TopicRow key={e.topic.slug} entry={e} me={me} vi={vi} />)}</ul>
        </section>
      ) : null}
    </div>
  );
}

export default TrackPage;
