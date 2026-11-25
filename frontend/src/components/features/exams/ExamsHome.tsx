'use client';

import React, { useMemo } from 'react';
import Link from 'next/link';
import { ArrowRight, Compass, GraduationCap, Headphones, BookOpen, PenLine, Mic, RotateCcw, ShieldCheck, TrendingUp, Infinity as InfinityIcon, Timer } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useExamAnalytics, useExamCatalog, useExamHistory } from '@/hooks/useExamCatalog';
import type { ExamFamily } from '@/types/exams';
import { ExamAttemptList, attemptHref, dedupeAttempts } from './ExamAttemptList';
import { ExamPracticeRecommendations } from './ExamPracticeRecommendations';
import { isFinishedStatus, isResumableStatus } from '@/lib/exams/runnerModel';
import { retiredToeicAttempt } from '@/lib/exams/productPolicy';
import { HeroScene, UniverseWorld, lightFollow, lightRest, ux } from './universe/ExamUniverse';

const FAMILY_META: Record<ExamFamily, { world: 'toeic' | 'ielts'; art: string; sub: { vi: string; en: string }; vi: string; en: string }> = {
  TOEIC: {
    world: 'toeic',
    art: '/assets/exams/exam-card-toeic-lr-dawn-1280-d6cc3948.webp',
    sub: { vi: 'Listening and Reading', en: 'Listening and Reading' },
    vi: 'Listening và Reading — luyện Part 1–7 hoặc thi đủ 200 câu.',
    en: 'Listening and Reading — practise Parts 1–7 or take the full 200-question test.',
  },
  IELTS: {
    world: 'ielts',
    art: '/assets/exams/exam-card-ielts-mixed-1280-d5d4ae4c.webp',
    sub: { vi: 'Listening · Reading · Writing · Speaking', en: 'Listening · Reading · Writing · Speaking' },
    vi: 'Listening, Reading, Writing, Speaking — luyện từng Section, Passage, Task, Part hoặc thi đầy đủ.',
    en: 'Listening, Reading, Writing, Speaking — practise each Section, Passage, Task, Part or take the full test.',
  },
};

/** The official structure of the family (the same facts as the "Cấu trúc đề" tab) — never availability. */
function FormatStrip({ family, lang }: { family: ExamFamily; lang: 'vi' | 'en' }) {
  if (family === 'TOEIC') {
    return (
      <div className={ux.format}>
        <span className={ux.formatLabel}>{lang === 'vi' ? 'Cấu trúc đề' : 'Test format'}</span>
        <span className={ux.partRail} role="img" aria-label={lang === 'vi' ? 'Listening Part 1–4, Reading Part 5–7' : 'Listening Parts 1–4, Reading Parts 5–7'}>
          {[1, 2, 3, 4].map((n) => <span key={n} data-band="L" aria-hidden>{n}</span>)}
          <em aria-hidden />
          {[5, 6, 7].map((n) => <span key={n} data-band="R" aria-hidden>{n}</span>)}
        </span>
      </div>
    );
  }
  const skills: Array<[string, React.ReactNode]> = [
    ['LISTENING', <Headphones key="l" aria-hidden />],
    ['READING', <BookOpen key="r" aria-hidden />],
    ['WRITING', <PenLine key="w" aria-hidden />],
    ['SPEAKING', <Mic key="s" aria-hidden />],
  ];
  return (
    <div className={ux.format}>
      <span className={ux.formatLabel}>{lang === 'vi' ? 'Cấu trúc đề' : 'Test format'}</span>
      <span className={ux.skillSigils} role="img" aria-label="Listening, Reading, Writing, Speaking">
        {skills.map(([k, icon]) => <span key={k} data-skill={k} title={k.charAt(0) + k.slice(1).toLowerCase()} aria-hidden>{icon}</span>)}
      </span>
    </div>
  );
}

/** A destination gate: the family's own world, its server counts, one way in. */
function FamilyCard({ family, lang }: { family: ExamFamily; lang: 'vi' | 'en' }) {
  const { isLoading, error, counts } = useExamCatalog(family);
  const meta = FAMILY_META[family];
  return (
    <Link
      href={`/exams/${family.toLowerCase()}`}
      className={ux.gate}
      data-world={meta.world}
      onPointerMove={lightFollow}
      onPointerLeave={lightRest}
    >
      <div className={ux.gateArt} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={meta.art} alt="" decoding="async" draggable={false} />
      </div>
      <span className={ux.gateSheen} aria-hidden />
      <div className={ux.gateBody}>
        <div className={ux.gateHead}>
          <div>
            <h3 className={ux.gateName}>{family}</h3>
            <p className={ux.gateSub}>{lang === 'vi' ? meta.sub.vi : meta.sub.en}</p>
          </div>
        </div>
        <p className={ux.gateDesc}>{lang === 'vi' ? meta.vi : meta.en}</p>
        <FormatStrip family={family} lang={lang} />
        <div className={ux.gateCounts} aria-live="polite">
          {isLoading ? (
            <span className={ux.gateCountWait} aria-hidden />
          ) : error ? (
            <span className={ux.gateCount}>{lang === 'vi' ? 'Chưa tải được kho đề' : 'Library not loaded'}</span>
          ) : (
            <>
              <span className={ux.gateCount} data-tone="sim">
                <i aria-hidden><ShieldCheck /></i>
                <b>{counts.simulation}</b>
                {lang === 'vi' ? 'đề thi đầy đủ' : 'full tests'}
              </span>
              <span className={ux.gateCount} data-tone="practice">
                <i aria-hidden><GraduationCap /></i>
                <b>{counts.practice}</b>
                {lang === 'vi' ? 'đề có thể luyện' : 'tests to practise'}
              </span>
            </>
          )}
        </div>
        <div className={ux.gateFoot}>
          <span className={ux.gateGo}>
            {lang === 'vi' ? `Vào kho đề ${family}` : `Open ${family} library`}
            <ArrowRight aria-hidden />
          </span>
        </div>
      </div>
    </Link>
  );
}

/**
 * Exams Phase 7 — Exams home. Answers, in order: what do I want to take (TOEIC / IELTS), what am I in the middle of
 * (Tiếp tục), what did I just do (Gần đây). Counts come from the server catalog; nothing is invented.
 * Exams Phase 8: "Gợi ý luyện tập" — deterministic suggestions from the learner's own practice (families with history
 * first; neutral starters when data is insufficient). Suggestions never start anything by themselves.
 * Echo Exam Universe (2026-10-24): presentation only — the hero's one shortcut resumes the learner's latest unfinished
 * attempt (already read for "Tiếp tục"), the gates show the families' worlds; same data, same requests.
 */
export function ExamsHome() {
  const { language } = useLanguage();
  const lang: 'vi' | 'en' = language === 'en' ? 'en' : 'vi';
  const { items, isLoading: historyLoading } = useExamHistory('ALL', 40);
  const attempts = useMemo(() => dedupeAttempts(items), [items]);
  const resumable = attempts.filter((a) => isResumableStatus(a.status)).slice(0, 4);
  const recent = attempts.filter((a) => isFinishedStatus(a.status)).slice(0, 5);
  const { analytics } = useExamAnalytics('ALL');
  // a family the learner has practised comes first; with no practice at all, the TOEIC starters are enough
  const suggested = useMemo(() => {
    const fams = analytics?.families || [];
    const practised = fams.filter((f) => f.practice.attempts > 0)
      .sort((a, b) => String(b.practice.lastPracticedAt || '').localeCompare(String(a.practice.lastPracticedAt || '')));
    return (practised.length > 0 ? practised : fams.slice(0, 1)).filter((f) => f.recommendations.items.length > 0
      || f.recommendations.status === 'INSUFFICIENT_DATA');
  }, [analytics]);
  const resumeFirst = resumable.find((a) => !retiredToeicAttempt(a)) || null;
  const resumeHref = resumeFirst ? attemptHref(resumeFirst) : null;

  return (
    <UniverseWorld world="nexus">
      <section className={ux.hero} aria-labelledby="exams-hero-title">
        <HeroScene world="nexus" />
        <div className={ux.heroBody}>
          <span className={ux.eyebrow}>
            <Compass aria-hidden />
            {lang === 'vi' ? 'Thi thử' : 'Exams'}
          </span>
          <h1 id="exams-hero-title" className={ux.heroTitle}>
            <span>{lang === 'vi' ? 'Bước vào' : 'Step into'}</span>
            <span className={ux.heroTitleGlow}>{lang === 'vi' ? 'thế giới đề thi' : 'the world of exams'}</span>
          </h1>
          <p className={ux.heroLead}>
            {lang === 'vi'
              ? 'Thi đầy đủ có đồng hồ như phòng thi thật. Luyện theo phần không giới hạn thời gian và xem lại đáp án ngay sau khi nộp.'
              : 'Full tests are timed like the real exam. Practice by part has no time limit and shows the answers right after you submit.'}
          </p>
          <div className={ux.modeKey}>
            <span data-mode="sim"><i aria-hidden><Timer /></i>{lang === 'vi' ? 'Thi đầy đủ · có đồng hồ' : 'Full test · timed'}</span>
            <span data-mode="practice"><i aria-hidden><InfinityIcon /></i>{lang === 'vi' ? 'Luyện theo phần · không giới hạn giờ' : 'Practice by part · untimed'}</span>
          </div>
          <div className={ux.heroActions}>
            {resumeHref && resumeFirst ? (
              <Link href={resumeHref} className={ux.cta}>
                <RotateCcw aria-hidden />
                {lang === 'vi' ? 'Tiếp tục bài đang làm' : 'Continue your attempt'}
              </Link>
            ) : (
              <a href="#exams-choose" className={ux.cta}>
                {lang === 'vi' ? 'Chọn kỳ thi' : 'Choose an exam'}
                <ArrowRight aria-hidden />
              </a>
            )}
            <Link href="/exams/profile" className={ux.ctaQuiet} data-guide="ex-profile">
              <TrendingUp aria-hidden />
              {lang === 'vi' ? 'Hồ sơ năng lực' : 'Competency profile'}
            </Link>
          </div>
          {resumeFirst && <p className={ux.resumeNote}>{resumeFirst.family} · {resumeFirst.formTitle}</p>}
        </div>
      </section>

      <section aria-labelledby="exams-choose" className={ux.section} id="exams-choose">
        <div className={ux.sectionHead}>
          <h2 id="exams-choose" className={`${ux.sectionTitle} ec-wp-plate`}>{lang === 'vi' ? 'Bạn muốn luyện gì?' : 'What do you want to work on?'}</h2>
        </div>
        <div className={ux.gates} data-guide="ex-gates">
          <FamilyCard family="TOEIC" lang={lang} />
          <FamilyCard family="IELTS" lang={lang} />
        </div>
      </section>

      {suggested.length > 0 && <ExamPracticeRecommendations families={suggested} lang={lang} showFamily headingId="exams-home-recommendations" />}

      {(historyLoading || resumable.length > 0) && (
        <section aria-labelledby="exams-continue" className={ux.section}>
          <div className={ux.sectionHead}>
            <h2 id="exams-continue" className={`${ux.sectionTitle} ec-wp-plate`}>
              {lang === 'vi' ? 'Tiếp tục bài đang làm' : 'Continue where you left off'}
            </h2>
          </div>
          {historyLoading ? (
            <div className={ux.voyages} aria-hidden>
              {[0, 1].map((i) => <div key={i} className={ux.skeleton} style={{ minHeight: '5.5rem' }} />)}
            </div>
          ) : (
            <ExamAttemptList items={resumable} lang={lang} variant="continue" showFamily />
          )}
        </section>
      )}

      <section aria-labelledby="exams-recent" className={ux.section}>
        <div className={ux.sectionHead}>
          <h2 id="exams-recent" className={`${ux.sectionTitle} ec-wp-plate`}>
            {lang === 'vi' ? 'Gần đây' : 'Recent'}
          </h2>
          <Link href="/exams/profile" className={ux.sectionLink}>
            <TrendingUp aria-hidden />
            {lang === 'vi' ? 'Hồ sơ năng lực' : 'Competency profile'}
          </Link>
        </div>
        {historyLoading ? (
          <div className={ux.skeleton} style={{ minHeight: '8rem' }} aria-hidden />
        ) : (
          <ExamAttemptList
            items={recent}
            lang={lang}
            showFamily
            emptyText={
              lang === 'vi'
                ? 'Chưa có bài nào hoàn thành. Hãy bắt đầu với một đề TOEIC hoặc IELTS.'
                : 'No finished attempts yet. Start with a TOEIC or IELTS test.'
            }
          />
        )}
        <p className={ux.footnote}>
          {lang === 'vi'
            ? 'Chỉ bài thi đầy đủ hợp lệ mới được ghi nhận vào hồ sơ năng lực; kết quả luyện tập không được tính.'
            : 'Only valid full simulations count toward the competency profile; practice results never do.'}
        </p>
      </section>
    </UniverseWorld>
  );
}

export default ExamsHome;
