'use client';

import React, { useMemo, useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Award, BookOpen, GraduationCap, Headphones, History, Info, Mic, PenLine, RotateCcw, ShieldCheck, Timer, TrendingUp, Infinity as InfinityIcon } from 'lucide-react';
import { ExamFamily } from '@/types/exams';
import { ExamLibrary } from './ExamLibrary';
import { ExamAttemptList, dedupeAttempts } from './ExamAttemptList';
import { ExamLearnerProgress } from './ExamLearnerProgress';
import { useLanguage } from '@/context/LanguageContext';
import { useExamCatalog, useExamHistory, rememberedCatalogFilters, rememberCatalogFilters, CatalogFilters } from '@/hooks/useExamCatalog';
import { isResumableStatus } from '@/lib/exams/runnerModel';
import { HeroScene, UniverseWorld, ux } from './universe/ExamUniverse';

type FamilyTab = 'library' | 'progress' | 'history' | 'overview';

interface ExamsFamilyPageProps {
  family: ExamFamily;
  initialView?: FamilyTab;
}

/** "Cấu trúc đề": the official structure of the family and the two ways to take a test (facts only). */
function FormatAtlas({ family, lang }: { family: ExamFamily; lang: 'vi' | 'en' }) {
  const isIelts = family === 'IELTS';
  return (
    <div className={ux.atlas}>
      <section className={ux.panel} aria-labelledby="format-official">
        <h3 id="format-official" className={ux.atlasTitle}>{lang === 'vi' ? `Cấu trúc chính thức của ${family}` : `Official ${family} format`}</h3>
        {isIelts ? (
          <div className={ux.pillars}>
            {([
              ['LISTENING', <Headphones key="l" />, lang === 'vi' ? '4 Section, 40 câu.' : '4 sections, 40 questions.'],
              ['READING', <BookOpen key="r" />, lang === 'vi' ? '3 Passage (Academic), 40 câu.' : '3 passages (Academic), 40 questions.'],
              ['WRITING', <PenLine key="w" />, lang === 'vi' ? 'Task 1 và Task 2.' : 'Task 1 and Task 2.'],
              ['SPEAKING', <Mic key="s" />, lang === 'vi' ? '3 phần.' : '3 parts.'],
            ] as Array<[string, React.ReactNode, string]>).map(([skill, icon, text]) => (
              <div key={skill} className={ux.pillar} data-skill={skill}>
                <i aria-hidden>{icon}</i>
                <strong>{skill.charAt(0) + skill.slice(1).toLowerCase()}</strong>
                <span>{text}</span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className={ux.bands}>
              <div className={ux.band} data-band="L">
                <div className={ux.bandHead}>
                  <strong><Headphones aria-hidden />Listening</strong>
                  <span>{lang === 'vi' ? 'Part 1–4, 100 câu.' : 'Parts 1–4, 100 questions.'}</span>
                </div>
                <div className={ux.bandParts} aria-hidden>{[1, 2, 3, 4].map((n) => <span key={n}>{n}</span>)}</div>
              </div>
              <div className={ux.band} data-band="R">
                <div className={ux.bandHead}>
                  <strong><BookOpen aria-hidden />Reading</strong>
                  <span>{lang === 'vi' ? 'Part 5–7, 100 câu.' : 'Parts 5–7, 100 questions.'}</span>
                </div>
                <div className={ux.bandParts} aria-hidden>{[5, 6, 7].map((n) => <span key={n}>{n}</span>)}</div>
              </div>
            </div>
            <p className={ux.bandNote}>{lang === 'vi' ? 'TOEIC Listening và Reading là bài thi 2 kỹ năng.' : 'TOEIC Listening and Reading is a two-skill test.'}</p>
          </>
        )}
      </section>
      <section className={ux.panel} aria-labelledby="format-modes">
        <h3 id="format-modes" className={ux.atlasTitle}>{lang === 'vi' ? 'Thi đầy đủ và luyện theo phần' : 'Full simulation and practice'}</h3>
        <div className={ux.compare}>
          <div className={ux.compareRow} data-mode="sim">
            <i aria-hidden><Timer /></i>
            <p>{lang === 'vi' ? 'Thi đầy đủ: có đồng hồ, làm lần lượt từng phần, không xem đáp án trong lúc làm.' : 'Full simulation: timed, sections in order, no answers during the test.'}</p>
          </div>
          <div className={ux.compareRow} data-mode="practice">
            <i aria-hidden><InfinityIcon /></i>
            <p>{lang === 'vi' ? 'Luyện theo phần: không giới hạn thời gian, kết quả là số câu đúng, xem lại đáp án sau khi nộp.' : 'Practice by part: no time limit, raw correct counts, answers after you submit.'}</p>
          </div>
          <div className={ux.compareRow} data-mode="note">
            <i aria-hidden><Info /></i>
            <p>{lang === 'vi' ? 'Kết quả luyện tập không phải điểm TOEIC / band IELTS và không tính vào hồ sơ năng lực.' : 'Practice results are not a TOEIC score / IELTS band and never count toward the profile.'}</p>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Exams Phase 7 — one family (TOEIC / IELTS): continue strip, the test library, the learner's history, and the official
 * test format. History rows of practice scopes open the practice result + review page (`ExamAttemptList`).
 * Exams Phase 8: "Tiến độ" tab = the learner's own practice analytics, mistakes and suggested practice (fetched only
 * when the tab is open).
 * Echo Exam Universe (2026-10-24): the family's world (TOEIC Sapphire Meridian / IELTS Four-Skill Archipelago) as the hero,
 * whose numbers are the server's own family counts (the same metadata window the Exams home reads) and the learner's own
 * unfinished attempts; same tabs, filters and requests.
 */
export const ExamsFamilyPage: React.FC<ExamsFamilyPageProps> = ({ family, initialView = 'library' }) => {
  const { language } = useLanguage();
  const lang: 'vi' | 'en' = language === 'en' ? 'en' : 'vi';
  const searchParams = useSearchParams();
  const requestedView = searchParams.get('view') || initialView;
  const activeTab: FamilyTab = ['library', 'progress', 'history', 'overview'].includes(requestedView)
    ? requestedView as FamilyTab : 'library';
  const setActiveTab = (view: FamilyTab) => {
    if (view === activeTab) return;
    // A view tab is client state of this already-mounted page: native history (integrated with useSearchParams) switches
    // it in the same frame, without the server-component round trip router.replace made on every tab click.
    window.history.replaceState(null, '', `/exams/${family.toLowerCase()}?view=${view}`);
  };
  const isIelts = family === 'IELTS';
  const world = isIelts ? 'ielts' : 'toeic';

  const [filters, setFilters] = useState<CatalogFilters>(() => rememberedCatalogFilters(family));
  const [debouncedQuery, setDebouncedQuery] = useState(filters.query);
  useEffect(() => {
    rememberCatalogFilters(family, filters);
    const timer = setTimeout(() => setDebouncedQuery(filters.query), 300);
    return () => clearTimeout(timer);
  }, [family, filters]);
  const { forms, isLoading, error, reload, loadMore, hasMore, isValidating, total, variants } = useExamCatalog(family, { ...filters, query: debouncedQuery });
  // the hero's family counts: the default metadata window (same SWR key as the Exams home — no extra request when warm)
  const familyWindow = useExamCatalog(family);
  const { items, isLoading: historyLoading } = useExamHistory(family, 50);
  const attempts = useMemo(() => dedupeAttempts(items), [items]);
  const resumable = attempts.filter((a) => isResumableStatus(a.status));
  const inProgressFormIds = useMemo(() => new Set(resumable.map((a) => a.formId)), [resumable]);

  const tabs: Array<{ id: FamilyTab; label: string; icon: React.ReactNode }> = [
    { id: 'library', label: lang === 'vi' ? 'Kho đề' : 'Tests', icon: <BookOpen aria-hidden /> },
    { id: 'progress', label: lang === 'vi' ? 'Tiến độ' : 'Progress', icon: <TrendingUp aria-hidden /> },
    { id: 'history', label: lang === 'vi' ? 'Lịch sử' : 'History', icon: <History aria-hidden /> },
    { id: 'overview', label: lang === 'vi' ? 'Cấu trúc đề' : 'Test format', icon: <Info aria-hidden /> },
  ];
  const countText = (n: number) => (familyWindow.isLoading ? '…' : familyWindow.error ? '—' : String(n));

  return (
    <UniverseWorld world={world}>
      <div className={ux.topRow}>
        <Link href="/exams" className={ux.ghostLink}>
          <ArrowLeft aria-hidden />
          {lang === 'vi' ? 'Thi thử' : 'Exams'}
        </Link>
        <Link href={`/exams/profile?family=${family.toLowerCase()}`} className={ux.ghostLink}>
          <Award aria-hidden />
          {lang === 'vi' ? 'Hồ sơ năng lực' : 'Competency profile'}
        </Link>
      </div>

      <header className={ux.hero}>
        <HeroScene world={world} />
        <div className={ux.heroBody}>
          <span className={ux.eyebrow}>
            <BookOpen aria-hidden />
            {lang === 'vi' ? 'Kho đề luyện thi' : 'Test library'}
          </span>
          <h1 className={ux.familyName}>{family}</h1>
          <p className={ux.familyTag}>{isIelts ? 'Listening · Reading · Writing · Speaking' : 'Listening and Reading · Part 1–7'}</p>
          <p className={ux.heroLead}>
            {isIelts
              ? lang === 'vi'
                ? 'Chọn một đề để thi đầy đủ, hoặc luyện riêng từng Section, Passage, Task.'
                : 'Pick a test to take in full, or practise each Section, Passage or Task.'
              : lang === 'vi'
              ? 'Chọn một đề để thi đầy đủ Listening và Reading, hoặc luyện riêng từng Part 1–7.'
              : 'Pick a test to take the full Listening and Reading test, or practise each of Parts 1–7.'}
          </p>
          <div className={ux.stats} aria-live="polite">
            <div className={ux.stat} data-tone="sim">
              <span className={ux.statWell} aria-hidden><ShieldCheck /></span>
              <span className={ux.statText}>
                <strong>{countText(familyWindow.counts.simulation)}</strong>
                <span>{lang === 'vi' ? 'đề thi đầy đủ' : 'full tests'}</span>
              </span>
            </div>
            <div className={ux.stat} data-tone="practice">
              <span className={ux.statWell} aria-hidden><GraduationCap /></span>
              <span className={ux.statText}>
                <strong>{countText(familyWindow.counts.practice)}</strong>
                <span>{lang === 'vi' ? 'đề có thể luyện' : 'tests to practise'}</span>
              </span>
            </div>
            {resumable.length > 0 && (
              <div className={ux.stat} data-tone="resume">
                <span className={ux.statWell} aria-hidden><RotateCcw /></span>
                <span className={ux.statText}>
                  <strong>{resumable.length}</strong>
                  <span>{lang === 'vi' ? 'bài đang làm dở' : 'unfinished'}</span>
                </span>
              </div>
            )}
          </div>
        </div>
      </header>

      {resumable.length > 0 && (
        <section aria-labelledby="family-continue" className={ux.section}>
          <div className={ux.sectionHead}>
            <h2 id="family-continue" className={`${ux.sectionTitle} ec-wp-plate`}>
              {lang === 'vi' ? 'Tiếp tục bài đang làm' : 'Continue where you left off'}
            </h2>
          </div>
          <ExamAttemptList items={resumable.slice(0, 2)} lang={lang} variant="continue" />
        </section>
      )}

      <div role="tablist" aria-label={family} className={ux.tabs}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={ux.tab}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      <div hidden={activeTab !== 'library'}>
        <ExamLibrary family={family} forms={forms} isLoading={isLoading} loadError={!!error} onRetry={reload} inProgressFormIds={inProgressFormIds} lang={lang} filters={filters} onFiltersChange={setFilters} onLoadMore={loadMore} hasMore={hasMore} refreshing={isValidating} total={total} serverVariants={variants} />
      </div>

      {activeTab === 'progress' && <ExamLearnerProgress family={family} lang={lang} />}

      {activeTab === 'history' &&
        (historyLoading ? (
          <div className={ux.skeleton} style={{ minHeight: '10rem' }} role="status" aria-label={lang === 'vi' ? 'Đang tải lịch sử…' : 'Loading history…'} />
        ) : (
          <ExamAttemptList
            items={attempts}
            lang={lang}
            emptyText={lang === 'vi' ? `Bạn chưa làm bài ${family} nào.` : `You have no ${family} attempts yet.`}
          />
        ))}

      {activeTab === 'overview' && <FormatAtlas family={family} lang={lang} />}
    </UniverseWorld>
  );
};

export default ExamsFamilyPage;
