'use client';

import React from 'react';
import Link from 'next/link';
import { ChevronRight, GraduationCap, History, RotateCcw, ShieldCheck } from 'lucide-react';
import { ux } from './universe/ExamUniverse';
import type { AttemptHistoryItemDto } from '@/types/exams';
import {
  attemptStatusLabel,
  historyModeLabel,
  historyScoreText,
  isFinishedStatus,
  isResumableStatus,
  isScopedPractice,
  scopeLabelFromCode,
} from '@/lib/exams/runnerModel';
import { practiceResultPath } from '@/lib/exams/practice';
import { retiredToeicAttempt } from '@/lib/exams/productPolicy';

interface ExamAttemptListProps {
  items: AttemptHistoryItemDto[];
  lang: 'vi' | 'en';
  /** 'continue' = resumable cards with a strong "Tiếp tục"; 'history' = compact rows. */
  variant?: 'continue' | 'history';
  showFamily?: boolean;
  emptyText?: string;
}

/** One row per attempt (the history query can repeat an attempt when it has several score rows). */
export function dedupeAttempts(items: AttemptHistoryItemDto[]): AttemptHistoryItemDto[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.attemptId) ? false : (seen.add(i.attemptId), true)));
}

/** Route of an attempt's next useful screen (resume, practice result + review, simulation result). */
export function attemptHref(item: AttemptHistoryItemDto): string | null {
  const fam = String(item.family || '').toLowerCase();
  if (isResumableStatus(item.status)) return retiredToeicAttempt(item) ? null : `/exams/${fam}/attempts/${item.attemptId}`;
  if (isFinishedStatus(item.status)) {
    return isScopedPractice(item) ? practiceResultPath(fam, item.attemptId) : `/exams/${fam}/results/${item.attemptId}`;
  }
  return null;
}

function formatWhen(iso: string | undefined, lang: 'vi' | 'en'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Exams Phase 7 — learner attempt list. Full simulation and practice are always distinguishable (chip + icon + text);
 * practice rows never show a standardized score; status codes are mapped to learner words.
 * Echo Exam Universe (2026-10-24): 'continue' rows are voyage cards, 'history' rows a timeline; same rows, links, words.
 */
export function ExamAttemptList({ items, lang, variant = 'history', showFamily = false, emptyText }: ExamAttemptListProps) {
  const rows = dedupeAttempts(items).filter((item) => variant !== 'continue' || !retiredToeicAttempt(item));
  if (rows.length === 0) {
    return emptyText ? (
      <div className={ux.empty}>
        <span className={ux.emptyIcon} aria-hidden><History /></span>
        <p>{emptyText}</p>
      </div>
    ) : null;
  }

  return (
    <ul className={variant === 'continue' ? ux.voyages : ux.timeline}>
      {rows.map((item) => {
        const sim = item.mode === 'EXAM_SIMULATION';
        const scope = scopeLabelFromCode(item.practiceScopeCode, lang);
        const href = attemptHref(item);
        const score = historyScoreText(item, lang);
        const resumable = isResumableStatus(item.status);
        const when = formatWhen(item.completedAt || item.startedAt, lang);
        const chip = (
          <span className={ux.pill} data-mode={sim ? 'sim' : 'practice'}>
            {sim ? <ShieldCheck aria-hidden /> : <GraduationCap aria-hidden />}
            {historyModeLabel(item, lang)}
          </span>
        );
        const title = scope || item.formTitle;
        const subtitle = [scope ? item.formTitle : null, when].filter(Boolean).join(' · ');

        if (variant === 'continue') {
          return (
            <li key={item.attemptId} className={ux.voyage} data-mode={sim ? 'sim' : 'practice'}>
              <span className={ux.voyageGlyph} aria-hidden>{sim ? <ShieldCheck /> : <GraduationCap />}</span>
              <div className={ux.voyageText}>
                <div className={ux.voyageMeta}>
                  {showFamily && <span className={ux.pill} data-family="">{item.family}</span>}
                  {chip}
                  <span className={ux.pill} data-status="resumable">{attemptStatusLabel(item.status, lang)}</span>
                </div>
                <p className={ux.voyageTitle} title={title}>{title}</p>
                {subtitle && <p className={ux.voyageSub} title={subtitle}>{subtitle}</p>}
              </div>
              {href && (
                <Link href={href} className={ux.voyageGo}>
                  <RotateCcw aria-hidden />
                  {lang === 'vi' ? 'Tiếp tục' : 'Continue'}
                </Link>
              )}
            </li>
          );
        }

        return (
          <li key={item.attemptId} className={ux.tlItem} data-mode={sim ? 'sim' : 'practice'}>
            <span className={ux.tlDot} aria-hidden />
            <div className={ux.tlCard}>
              <div className={ux.tlText}>
                <div className={ux.voyageMeta}>
                  {showFamily && <span className={ux.pill} data-family="">{item.family}</span>}
                  {chip}
                  <span className={ux.pill} data-status={resumable ? 'resumable' : item.status === 'SUBMITTED' ? 'done' : 'attention'}>
                    {attemptStatusLabel(item.status, lang)}
                  </span>
                </div>
                <p className={ux.tlTitle} title={title}>{title}</p>
                {subtitle && <p className={ux.tlSub} title={subtitle}>{subtitle}</p>}
              </div>
              <div className={ux.tlEnd}>
                {score && (
                  <span className={ux.tlScore} title={lang === 'vi' ? 'Điểm bài thi đầy đủ' : 'Full simulation score'}>
                    {score}
                    <small>{lang === 'vi' ? 'Thi đầy đủ' : 'Full test'}</small>
                  </span>
                )}
                {href && (
                  <Link href={href} className={ux.tlOpen}>
                    {resumable
                      ? lang === 'vi' ? 'Tiếp tục' : 'Continue'
                      : isScopedPractice(item)
                      ? lang === 'vi' ? 'Kết quả và xem lại' : 'Result and review'
                      : lang === 'vi' ? 'Xem kết quả' : 'View result'}
                    <ChevronRight aria-hidden />
                  </Link>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default ExamAttemptList;
