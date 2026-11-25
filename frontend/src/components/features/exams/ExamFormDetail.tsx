'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, Clock, GraduationCap, Infinity as InfinityIcon, Layers, ListChecks, Lock, Play, RotateCcw, ShieldCheck } from 'lucide-react';
import type { ExamFamily } from '@/types/exams';
import { useLanguage } from '@/context/LanguageContext';
import { useExamCatalog, useExamHistory } from '@/hooks/useExamCatalog';
import { PracticeScopePicker } from './PracticeScopePicker';
import { SimulationStartDialog } from './SimulationStartDialog';
import { dedupeAttempts } from './ExamAttemptList';
import { CONTENT_UNDER_REVIEW_MESSAGE, getActiveRunnableSkills, isPracticeModeAvailable, isSimulationModeAvailable } from './ExamLibrary';
import { durationText, isResumableStatus, isScopedPractice, skillList } from '@/lib/exams/runnerModel';
import { CardArt, UniverseWorld, formArtKey, ux } from './universe/ExamUniverse';
import { useContentTitle } from '@/lib/brand/tabTitle';

interface ExamFormDetailProps {
  family: ExamFamily;
  formId: string;
}

/**
 * Exams Phase 7 — one test, two clearly separated paths:
 *  THI ĐẦY ĐỦ  — timed simulation (server totals only, continue if one is running);
 *  LUYỆN THEO PHẦN — untimed scopes from the server's scope readiness, with "Tiếp tục" per unfinished scope.
 * No source, validation, QA, package or import metadata is shown.
 * Echo Exam Universe (2026-10-24): the test's own world (chosen from its runnable skills) as the header; the two paths
 * keep their indigo (timed) / emerald (untimed) identity, their ids, handlers and the start dialog.
 */
export function ExamFormDetail({ family, formId }: ExamFormDetailProps) {
  const { language } = useLanguage();
  const lang: 'vi' | 'en' = language === 'en' ? 'en' : 'vi';
  const familySlug = family.toLowerCase();
  const world = family === 'IELTS' ? 'ielts' : 'toeic';
  const { forms, isLoading, error, reload } = useExamCatalog(family, { mode: 'ALL', query: '', variant: 'ALL' }, formId);
  const { items } = useExamHistory(family, 50);
  const [dialog, setDialog] = useState<null | 'EXAM_SIMULATION' | 'PRACTICE'>(null);

  const form = forms.find((f) => f.id === formId) || null;
  useContentTitle(form?.title);

  const mine = useMemo(() => dedupeAttempts(items).filter((a) => a.formId === formId && isResumableStatus(a.status)), [items, formId]);
  const simResume = mine.find((a) => a.mode === 'EXAM_SIMULATION') || null;
  const wholePracticeResume = mine.find((a) => a.mode === 'PRACTICE' && !isScopedPractice(a)) || null;
  const resumeByScope = useMemo(() => {
    const map: Record<string, string> = {};
    mine.forEach((a) => {
      if (isScopedPractice(a) && a.practiceScopeCode && !map[a.practiceScopeCode]) map[a.practiceScopeCode] = a.attemptId;
    });
    return map;
  }, [mine]);

  const back = (
    <div className={ux.topRow}>
      <Link href={`/exams/${familySlug}`} className={ux.ghostLink}>
        <ArrowLeft aria-hidden />
        {lang === 'vi' ? `Kho đề ${family}` : `${family} library`}
      </Link>
    </div>
  );

  if (isLoading) {
    return (
      <UniverseWorld world={world} narrow>
        <div role="status" aria-live="polite" className={ux.section}>
          <span className="sr-only">{lang === 'vi' ? 'Đang tải đề…' : 'Loading test…'}</span>
          {back}
          <div className={ux.skeleton} style={{ minHeight: '15rem' }} />
          <div className={ux.paths}>
            <div className={ux.skeleton} style={{ minHeight: '16rem' }} />
            <div className={ux.skeleton} style={{ minHeight: '20rem' }} />
          </div>
        </div>
      </UniverseWorld>
    );
  }

  if (!form) {
    return (
      <UniverseWorld world={world} narrow>
        {back}
        <div className={ux.empty}>
          <span className={ux.emptyIcon} aria-hidden><AlertCircle /></span>
          <h1 className={ux.atlasTitle} style={{ margin: 0 }}>
            {error ? (lang === 'vi' ? 'Chưa tải được đề' : 'The test could not be loaded') : lang === 'vi' ? 'Không tìm thấy đề này' : 'Test not found'}
          </h1>
          <div className={ux.heroActions}>
            {error && (
              <button type="button" onClick={reload} className={ux.emptyAction}>
                {lang === 'vi' ? 'Thử lại' : 'Try again'}
              </button>
            )}
            <Link href={`/exams/${familySlug}`} className={ux.emptyAction}>
              {lang === 'vi' ? 'Về kho đề' : 'Back to library'}
            </Link>
          </div>
        </div>
      </UniverseWorld>
    );
  }

  const simAvailable = isSimulationModeAvailable(form);
  const practiceAvailable = form.availableModes?.includes('PRACTICE') ?? isPracticeModeAvailable(form);
  const simSkills = form.simulationSkills && form.simulationSkills.length ? form.simulationSkills : form.skills;
  const duration = simAvailable ? durationText(form.totalDurationMinutes, lang) : '';
  const runnable = getActiveRunnableSkills(form).map((s) => s.toUpperCase());

  return (
    <UniverseWorld world={world} narrow>
      {back}

      <header className={ux.detailHero} data-world={world}>
        <div className={ux.detailArt} aria-hidden>
          <CardArt artKey={formArtKey(form, runnable)} eager />
        </div>
        <div className={ux.detailBody}>
          <div className={ux.detailChips}>
            <span className={ux.chip} data-kind="family">{family}</span>
            {runnable.map((s) => (
              <span key={s} className={ux.chip} data-skill={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</span>
            ))}
          </div>
          <h1 className={ux.detailTitle}>{form.title}</h1>
          {form.logicalKey?.startsWith('BANK_TOEIC_') && <a className={ux.detailSub} href="/licenses/toeic-practice.txt">
            {lang === 'vi' ? 'Nguồn nội dung và giấy phép' : 'Sources and licences'}
          </a>}
          {form.collectionTitle && <p className={ux.detailSub}>{form.logicalKey?.startsWith('EC_ORIGINAL_') ? 'EnglishCoach Original Practice' : form.collectionTitle}</p>}
        </div>
      </header>

      {form.id === 'ecc3704f-d512-5509-98dd-02444c328883' && !runnable.includes('READING') && (
        <div className={ux.section}>
          <p className={ux.pathNote}>
            {lang === 'vi'
              ? 'Phần Reading của phiên bản Cambridge này đã đóng do lỗi đáp án. Đề thay thế có 40 câu trong 3 passage.'
              : 'Reading is closed on this Cambridge edition because of an answer-key error. The replacement has 40 questions across three passages.'}
          </p>
          <Link href="/exams/ielts/tests/42c8aa02-dad6-577b-a870-14ec407dc51a" className={ux.pathAltBtn}>
            {lang === 'vi' ? 'Mở đề Reading thay thế' : 'Open replacement Reading test'} · EnglishCoach Original
          </Link>
        </div>
      )}

      <div className={ux.paths}>
        {/* THI ĐẦY ĐỦ */}
        <section aria-labelledby="full-sim-title" className={ux.path} data-mode="sim">
          <div className={ux.pathInner}>
            <div className={ux.pathHead}>
              <span className={ux.pathGlyph} aria-hidden><ShieldCheck /></span>
              <div>
                <h2 id="full-sim-title" className={ux.pathTitle}>{lang === 'vi' ? 'Thi đầy đủ' : 'Full simulation'}</h2>
                <p className={ux.pathSub}>{lang === 'vi' ? 'Như phòng thi thật' : 'Like the real exam'}</p>
              </div>
            </div>

            {simAvailable ? (
              <>
                <ul className={ux.pathFacts}>
                  {skillList(simSkills) && (
                    <li>
                      <small><Layers aria-hidden />{lang === 'vi' ? 'Kỹ năng' : 'Skills'}</small>
                      <b>{skillList(simSkills)}</b>
                    </li>
                  )}
                  {form.totalItems > 0 && (
                    <li>
                      <small><ListChecks aria-hidden />{lang === 'vi' ? 'Số câu' : 'Questions'}</small>
                      <b>{lang === 'vi' ? `${form.totalItems} câu hỏi` : `${form.totalItems} questions`}</b>
                    </li>
                  )}
                  {duration && (
                    <li>
                      <small><Clock aria-hidden />{lang === 'vi' ? 'Thời gian' : 'Time'}</small>
                      <b>{duration}</b>
                    </li>
                  )}
                </ul>
                <p className={ux.pathNote}>
                  {form.state === 'PILOT' ? (lang === 'vi'
                    ? 'Bài thi có đồng hồ. Kết quả là điểm ước tính của đề thử nghiệm.'
                    : 'This test is timed. Results are estimates for a pilot edition.') : lang === 'vi'
                    ? 'Có đồng hồ, làm lần lượt từng phần, không xem đáp án trong lúc làm. Bài hợp lệ được ghi nhận vào hồ sơ năng lực.'
                    : 'Timed, sections in order, no answers during the test. Valid attempts count toward the competency profile.'}
                </p>
                {simResume ? (
                  <Link href={`/exams/${familySlug}/attempts/${simResume.attemptId}`} className={`${ux.cta} ${ux.pathWide}`} data-mode="sim">
                    <RotateCcw aria-hidden />
                    {lang === 'vi' ? 'Tiếp tục bài thi' : 'Continue the test'}
                  </Link>
                ) : (
                  <button type="button" id="exam-sim-btn" onClick={() => setDialog('EXAM_SIMULATION')} className={`${ux.cta} ${ux.pathWide}`} data-mode="sim">
                    <Play className="fill-current" aria-hidden />
                    {lang === 'vi' ? 'Bắt đầu thi đầy đủ' : 'Start full simulation'}
                  </button>
                )}
              </>
            ) : (
              <div className={ux.pathClosed}>
                <strong><Lock aria-hidden />{lang === 'vi' ? 'Chưa thi đầy đủ được' : 'Full simulation not available'}</strong>
                <span>
                  {form.contentReviewRequired
                    ? CONTENT_UNDER_REVIEW_MESSAGE[lang === 'vi' ? 'vi' : 'en']
                    : lang === 'vi'
                    ? 'Đề này hiện chỉ dùng để luyện tập.'
                    : 'This test is currently for practice only.'}
                </span>
              </div>
            )}

            {practiceAvailable && (
              <div className={ux.pathAlt}>
                {wholePracticeResume ? (
                  <Link href={`/exams/${familySlug}/attempts/${wholePracticeResume.attemptId}`} className={ux.pathAltBtn} data-mode="practice">
                    <RotateCcw aria-hidden />
                    {lang === 'vi' ? 'Tiếp tục bài luyện cả kỹ năng' : 'Continue whole-skill practice'}
                  </Link>
                ) : (
                  <button type="button" id="exam-practice-btn" onClick={() => setDialog('PRACTICE')} className={ux.pathAltBtn}>
                    <GraduationCap aria-hidden />
                    {lang === 'vi'
                      ? `Luyện cả kỹ năng (${skillList(getActiveRunnableSkills(form))})`
                      : `Practise whole skills (${skillList(getActiveRunnableSkills(form))})`}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        {/* LUYỆN THEO PHẦN */}
        <section id="practice" aria-labelledby="practice-title" className={ux.path} data-mode="practice">
          <div className={ux.pathInner}>
            <div className={ux.pathHead}>
              <span className={ux.pathGlyph} aria-hidden><GraduationCap /></span>
              <div>
                <h2 id="practice-title" className={ux.pathTitle}>{lang === 'vi' ? 'Luyện theo phần' : 'Practice by part'}</h2>
                <p className={ux.pathSub}>
                  <span>
                    <InfinityIcon aria-hidden />
                    {lang === 'vi' ? 'Không giới hạn thời gian' : 'No time limit'}
                  </span>
                  <span aria-hidden>·</span>
                  <span>{lang === 'vi' ? 'Xem đáp án sau khi nộp' : 'Answers after you submit'}</span>
                  <span aria-hidden>·</span>
                  <span>{lang === 'vi' ? 'Không tính vào hồ sơ năng lực' : 'Not in the official profile'}</span>
                </p>
              </div>
            </div>
            <PracticeScopePicker family={family} formId={formId} embedded resumeByScope={resumeByScope} />
          </div>
        </section>
      </div>

      {dialog && <SimulationStartDialog open onClose={() => setDialog(null)} form={form} lang={lang} mode={dialog} />}
    </UniverseWorld>
  );
}

export default ExamFormDetail;
