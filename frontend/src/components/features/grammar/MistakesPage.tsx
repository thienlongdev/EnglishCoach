'use client';

import React from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { BookOpen, CircleAlert, Dumbbell, RotateCcw, TriangleAlert } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { grammarApi } from '@/services/grammarApi';
import { findTopic, useGrammarCatalog, useGrammarUserId } from '@/hooks/useGrammar';
import { apiFailure, cx, formatDate } from '@/lib/grammar/format';
import { labelOf } from '@/lib/grammar/misconceptions';
import type { MistakesView } from '@/types/grammar';
import { langOf } from './exercises/answer';
import styles from './grammar.module.css';
import v from './subviews.module.css';
import x from './exercises/exercises.module.css';

/** The server stops reading at this many wrong answers (`recentWrong(..., 600)`): above it the count is "at least". */
const READ_LIMIT = 600;

/**
 * Lỗi của tôi: wrong answers gathered by the pattern behind them. A group exists only because the author tagged the wrong option,
 * so this is a list of recognised patterns, not of every slip. The window it counts over is told on the page.
 */
export function MistakesPage() {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const userId = useGrammarUserId();
  const { data: catalog } = useGrammarCatalog();
  const { data, error, isLoading, mutate } = useSWR<MistakesView>(
    userId ? ['grammar-mistakes', userId] : null,
    () => grammarApi.mistakes(),
    { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 5_000 },
  );

  return (
    <div className={cx(x.page, v.view, v.focusPage)}>
      <header className={cx(x.pageHead, v.focusHead)}>
        <p className={styles.eyebrow}>{vi ? 'Học từ chỗ vấp' : 'Learn from slips'}</p>
        <h1 className={x.pageTitle}>{vi ? 'Lỗi của tôi' : 'My mistakes'}</h1>
        <p className={x.pageLead}>
          {data
            ? (vi
              ? `Các lượt trả lời chưa đúng trong ${data.windowDays} ngày gần đây, gom theo kiểu nhầm đứng sau chúng. Mỗi nhóm cho bạn biết lỗi lặp lại bao nhiêu lần và nên xem lại bài nào.`
              : `Answers that were not right in the last ${data.windowDays} days, grouped by the pattern behind them. Each group shows how often it repeats and which lesson to revisit.`)
            : (vi ? 'Các lượt trả lời chưa đúng gần đây, gom theo kiểu nhầm đứng sau chúng.' : 'Recent answers that were not right, grouped by the pattern behind them.')}
        </p>
      </header>

      {!userId || (isLoading && !data) ? (
        <div className={cx(x.groupList, v.mistakeList)} aria-busy="true" aria-label={vi ? 'Đang tải lỗi của bạn' : 'Loading your mistakes'}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={cx(x.group, v.mistakeCard)}>
              <span className={cx(styles.skel, styles.skelLine)} style={{ width: '55%' }} />
              <span className={cx(styles.skel, styles.skelLine)} style={{ width: '35%', marginTop: '0.6rem' }} />
              <span className={cx(styles.skel, styles.skelLine)} style={{ width: '70%', marginTop: '0.6rem' }} />
            </div>
          ))}
          <span className={styles.srOnly}>{vi ? 'Đang tải…' : 'Loading…'}</span>
        </div>
      ) : null}

      {userId && error && !data ? (
        <div className={styles.stateBox} role="alert">
          <span className={styles.stateIcon} aria-hidden="true"><TriangleAlert /></span>
          <h2 className={styles.stateTitle}>{vi ? 'Chưa tải được danh sách lỗi' : 'Your mistakes could not be loaded'}</h2>
          <p className={styles.stateText}>{apiFailure(error).status === 401 ? (vi ? 'Phiên đăng nhập có vấn đề. Hãy đăng nhập lại.' : 'There is a problem with your sign-in. Please sign in again.') : (vi ? 'Kết nối bị gián đoạn. Dữ liệu của bạn không bị mất.' : 'The connection was interrupted. Nothing of yours is lost.')}</p>
          <div className={styles.stateActions}><button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={() => { void mutate(); }}><RotateCcw aria-hidden="true" />{vi ? 'Thử lại' : 'Try again'}</button></div>
        </div>
      ) : null}

      {data ? <Body data={data} vi={vi} find={(slug) => findTopic(catalog, slug)?.topic.title ?? null} /> : null}
    </div>
  );
}

function Body({ data, vi, find }: { data: MistakesView; vi: boolean; find: (slug: string) => { vi: string; en: string } | null }) {
  const atLeast = data.totalWrong >= READ_LIMIT;
  if (!data.groups.length) {
    return (
      <div className={styles.stateBox} role="status">
        <span className={styles.stateIcon} aria-hidden="true"><CircleAlert /></span>
        <h2 className={styles.stateTitle}>
          {data.totalWrong
            ? (vi ? 'Chưa có kiểu lỗi nào để gom nhóm' : 'No mistake pattern to group yet')
            : (vi ? 'Chưa có lỗi nào được ghi nhận' : 'No mistakes recorded')}
        </h2>
        <p className={styles.stateText}>
          {data.totalWrong
            ? (vi
              ? `Trong ${data.windowDays} ngày gần đây có ${atLeast ? 'ít nhất ' : ''}${data.totalWrong} lượt trả lời chưa đúng, nhưng chúng chưa thuộc kiểu nhầm nào đã được nhận diện nên chưa thể gom nhóm.`
              : `In the last ${data.windowDays} days there were ${atLeast ? 'at least ' : ''}${data.totalWrong} answers that were not right, but none belongs to a recognised pattern yet, so there is nothing to group.`)
            : (vi
              ? `Trong ${data.windowDays} ngày gần đây bạn chưa có câu nào chưa đúng, hoặc chưa làm câu luyện tập nào. Khi bạn làm bài, các kiểu nhầm sẽ hiện ở đây.`
              : `In the last ${data.windowDays} days you have no answer that was not right, or you have not practised yet. Patterns will show up here as you work.`)}
        </p>
        <div className={styles.stateActions}>
          <Link href="/grammar/practice" className={cx(styles.btn, styles.btnPrimary)}><Dumbbell aria-hidden="true" />{vi ? 'Vào phòng luyện tập' : 'Open the practice studio'}</Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={cx(x.mistakesTop, v.mistakesSummary)}>
        <p className={x.mistakesCount}>
          {vi
            ? `${atLeast ? 'Ít nhất ' : ''}${data.totalWrong} lượt chưa đúng trong ${data.windowDays} ngày, ${data.groups.length} kiểu nhầm đã nhận diện.`
            : `${atLeast ? 'At least ' : ''}${data.totalWrong} answers not right in ${data.windowDays} days, ${data.groups.length} recognised patterns.`}
        </p>
        <Link href="/grammar/practice?kind=mistakes" className={cx(styles.btn, styles.btnPrimary)}><Dumbbell aria-hidden="true" />{vi ? 'Luyện lại những câu chưa đúng' : 'Practise what was not right'}</Link>
      </div>
      <p className={styles.fine}>
        {vi
          ? '“Luyện lại” mở những câu bạn làm chưa đúng gần đây, không chỉ riêng một kiểu nhầm. Mỗi lượt đếm một câu trả lời chưa đúng; một câu có thể thuộc nhiều kiểu.'
          : '“Practise” opens the questions you recently got wrong, not only one pattern. Each count is one answer that was not right; one answer can fall under more than one pattern.'}
      </p>
      <ul className={cx(x.groupList, v.mistakeList)}>
        {data.groups.map((g) => {
          const title = find(g.topic);
          const topicName = title ? (vi ? title.vi : title.en) : null;
          const label = labelOf(g.tag, vi);
          const heading = label ?? topicName ?? (vi ? 'Một kiểu nhầm trong chủ đề này' : 'A mistake pattern in this topic');
          const last = g.lastAnswer && g.lastAnswer.length <= 140 ? g.lastAnswer : null;
          return (
            <li key={`${g.tag}:${g.topic}`} className={cx(x.group, v.mistakeCard)}>
              <div className={x.groupMain}>
                <h2 className={x.groupTitle} lang={label ? (vi ? 'vi' : 'en') : undefined}>{heading}</h2>
                <p className={x.groupMeta}>
                  <span className={x.groupCount}>{vi ? `${g.count} lần` : `${g.count} time${g.count === 1 ? '' : 's'}`}</span>
                  <span>{vi ? `${g.recent30d} lần trong 30 ngày qua` : `${g.recent30d} in the last 30 days`}</span>
                  <span>{vi ? `Gần nhất: ${formatDate(g.lastAt, vi)}` : `Latest: ${formatDate(g.lastAt, vi)}`}</span>
                </p>
                {topicName && label ? <p className={x.groupTopic}>{vi ? 'Trong chủ đề: ' : 'In topic: '}<span>{topicName}</span></p> : null}
                {last ? <p className={x.groupLast}><span>{vi ? 'Câu trả lời gần nhất của bạn:' : 'Your latest answer:'}</span> <q lang={langOf(last)}>{last}</q></p> : null}
              </div>
              <div className={x.groupActions}>
                <Link href={`/grammar/topics/${encodeURIComponent(g.topic)}`} className={cx(styles.btn, styles.btnSoft, styles.btnSm)}><BookOpen aria-hidden="true" />{vi ? 'Xem bài học' : 'Open the lesson'}</Link>
                <Link href="/grammar/practice?kind=mistakes" className={cx(styles.btn, styles.btnQuiet, styles.btnSm)}><Dumbbell aria-hidden="true" />{vi ? 'Luyện lại' : 'Practise'}</Link>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
