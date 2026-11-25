'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CatalogFormDto, ExamFamily } from '@/types/exams';
import { useLanguage } from '@/context/LanguageContext';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  ChevronDown,
  Clock3,
  FileText,
  GraduationCap,
  Headphones,
  ListChecks,
  Lock,
  Mic,
  PenLine,
  RotateCcw,
  RotateCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { CatalogFilters } from '@/hooks/useExamCatalog';
import { durationText, skillList } from '@/lib/exams/runnerModel';
import { CardArt, formArtKey, lightFollow, lightRest, ux } from './universe/ExamUniverse';

/*
 * Exams library (Exams Phase 7). The availability helpers below are the Phase 0 / Phase 2 containment contract
 * (executed by scripts/check-exams-containment-contract.mjs): server validation (`availableModes`, `runnableSkills`)
 * is authoritative; legacy logicalKey heuristics only serve payloads that predate those fields.
 */

/**
 * Authoritative physical audio availability.
 * Cambridge 1-9, Trainer 1-2, Barrons, Plus 1, ETS 2019/2023, ETS 2020/2021 have no physical audio tracks.
 * Collins 1-4, Cambridge 10-19, Plus 2-3, Economy 1-5, ETS 2026, YBM 1-3, Hackers 1 have physical audio.
 */
export function isAudioAvailable(form: CatalogFormDto): boolean {
  // Server runnableSkills is authoritative even when empty (Phase 0 content containment).
  if (Array.isArray(form.runnableSkills)) {
    return form.runnableSkills.includes('LISTENING');
  }
  const key = form.logicalKey.toUpperCase();
  const camMatch = key.match(/CAMBRIDGE_IELTS_VOL_0?([1-9])_/);
  if (camMatch && parseInt(camMatch[1], 10) < 10) return false;
  if (key.includes('TRAINER')) return false;
  if (key.includes('BARRON')) return false;
  if (key.includes('PLUS_1') || key.includes('PLUS_VOL_1')) return false;
  if (key.includes('ETS_2019')) return false;
  if (key.includes('ETS_2023')) return false;
  if (key.includes('ETS_2020') || key.includes('ETS_2021')) return false;
  return true;
}

/**
 * Authoritative reading physical availability.
 * Economy Vol 4 and Vol 5 are LC-only on disk (no RC questions/passages).
 */
export function isReadingAvailable(form: CatalogFormDto): boolean {
  if (Array.isArray(form.runnableSkills)) {
    return form.runnableSkills.includes('READING');
  }
  const key = form.logicalKey.toUpperCase();
  if (key.includes('ECONOMY_TOEIC_VOL_4')) return false;
  if (key.includes('ECONOMY_TOEIC_VOL_5')) return false;
  return true;
}

/**
 * Authoritative active and runnable skills.
 * Filters out LISTENING if audio is absent on disk, and READING if passages are absent.
 */
export function getActiveRunnableSkills(form: CatalogFormDto): string[] {
  if (form.fullExamRunnable && form.skills && form.skills.length > 0) {
    return form.skills;
  }
  const audioOk = isAudioAvailable(form);
  const readingOk = isReadingAvailable(form);

  if (Array.isArray(form.runnableSkills)) {
    return form.runnableSkills.filter((sk) => {
      const upper = sk.toUpperCase();
      if (upper === 'LISTENING' && !audioOk) return false;
      if (upper === 'READING' && !readingOk) return false;
      return true;
    });
  }

  const baseSkills =
    form.skills && form.skills.length > 0
      ? form.skills
      : form.family === 'IELTS'
      ? ['LISTENING', 'READING', 'WRITING', 'SPEAKING']
      : ['LISTENING', 'READING'];

  return baseSkills.filter((sk) => {
    const upper = sk.toUpperCase();
    if (upper === 'LISTENING' && !audioOk) return false;
    if (upper === 'READING' && !readingOk) return false;
    return true;
  });
}

/**
 * Label of the "full exam" badge. TOEIC L&R is a two-skill test and is never advertised as four skills;
 * the label is derived from the form's own skills.
 */
export function getFullExamLabel(form: CatalogFormDto, lang: 'en' | 'vi' = 'vi'): string {
  const skills = (form.skills || []).map((s) => s.toUpperCase());
  const allFour = ['LISTENING', 'READING', 'WRITING', 'SPEAKING'].every((s) => skills.includes(s));
  if (allFour) {
    return lang === 'vi' ? 'Đủ 4 kỹ năng / Full' : 'Full Exam Ready';
  }
  if (skills.length === 2 && skills.includes('LISTENING') && skills.includes('READING')) {
    return lang === 'vi' ? 'Đủ Listening + Reading' : 'Listening + Reading Ready';
  }
  const list = formatSkillList(skills, lang);
  return lang === 'vi' ? `Đủ đề: ${list}` : `Full test: ${list}`;
}

/**
 * Exams Phase 2: start modes come from the server's authoritative content validation (`availableModes`).
 * The fallback only serves legacy payloads that predate that field.
 */
export function isSimulationModeAvailable(form: CatalogFormDto): boolean {
  if (Array.isArray(form.availableModes)) {
    return form.availableModes.includes('EXAM_SIMULATION');
  }
  if (form.fullExamRunnable !== undefined) {
    return form.fullExamRunnable;
  }
  return (
    (form.skills?.length || 0) >= (form.family === 'IELTS' ? 4 : 2) &&
    isAudioAvailable(form) &&
    isReadingAvailable(form) &&
    form.primaryHealthStatus !== 'NEEDS_REVIEW'
  );
}

export function isPracticeModeAvailable(form: CatalogFormDto): boolean {
  if (Array.isArray(form.practiceScopeCodes)) return form.practiceScopeCodes.length > 0;
  if (Array.isArray(form.availableModes)) {
    return form.availableModes.includes('PRACTICE');
  }
  return form.primaryHealthStatus !== 'DISABLED' && getActiveRunnableSkills(form).length > 0;
}

export const CONTENT_UNDER_REVIEW_MESSAGE = {
  vi: 'Đề này đang được kiểm tra lại nội dung và tạm thời chưa thể làm ở chế độ thi mô phỏng.',
  en: 'This test is being re-checked and is temporarily unavailable in simulation mode.',
};

/**
 * Format active skills into localized, readable text.
 */
export function formatSkillList(skills: string[], lang: 'en' | 'vi' = 'vi'): string {
  if (!skills || skills.length === 0) {
    return lang === 'vi' ? 'Không có' : 'None';
  }
  const skillLabels: Record<string, { vi: string; en: string }> = {
    LISTENING: { vi: 'Listening', en: 'Listening' },
    READING: { vi: 'Reading', en: 'Reading' },
    WRITING: { vi: 'Writing', en: 'Writing' },
    SPEAKING: { vi: 'Speaking', en: 'Speaking' },
  };
  return skills.map((s) => skillLabels[s.toUpperCase()]?.[lang] || s).join(', ');
}


// ─── Exams Phase 7: test grid ─────────────────────────────────────────────────────────────────────────────────────

type ModeFilter = 'USABLE' | 'ALL' | 'SIMULATION' | 'PRACTICE' | 'BLOCKED';

interface ExamLibraryProps {
  family: ExamFamily;
  filters?: CatalogFilters;
  onFiltersChange?: (filters: CatalogFilters) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  refreshing?: boolean;
  total?: number;
  serverVariants?: string[];
  forms: CatalogFormDto[];
  isLoading?: boolean;
  /** Catalog request failed — show a retry instead of an empty library. */
  loadError?: boolean;
  onRetry?: () => void;
  /** Forms with an unfinished attempt of the learner (shown as "Đang làm dở"). */
  inProgressFormIds?: Set<string>;
  lang?: 'en' | 'vi';
}

const PAGE = 24;

/** One quiet colour + icon per skill, the same in every card (labels match `formatSkillList`). */
const SKILL_STYLE: Record<string, { label: string; icon: React.ReactElement }> = {
  LISTENING: { label: 'Listening', icon: <Headphones aria-hidden /> },
  READING: { label: 'Reading', icon: <BookOpen aria-hidden /> },
  WRITING: { label: 'Writing', icon: <PenLine aria-hidden /> },
  SPEAKING: { label: 'Speaking', icon: <Mic aria-hidden /> },
};

function scopeSummary(codes: string[]): string {
  return codes.map((code) => {
    const n = code.match(/_(\d+)$/)?.[1] || '';
    if (code.startsWith('TOEIC_PART_')) return `Part ${n}`;
    if (code.startsWith('IELTS_LISTENING_SECTION_')) return `Listening Section ${n}`;
    if (code.startsWith('IELTS_READING_PASSAGE_')) return `Reading Passage ${n}`;
    if (code.startsWith('IELTS_WRITING_TASK_')) return `Writing Task ${n}`;
    if (code.startsWith('IELTS_SPEAKING_PART_')) return `Speaking Part ${n}`;
    return '';
  }).filter(Boolean).join(', ');
}

function variantLabel(variant: string, lang: 'vi' | 'en'): string | null {
  switch (String(variant || '').toUpperCase()) {
    case 'ACADEMIC':
      return 'Academic';
    case 'GENERAL_TRAINING':
      return 'General Training';
    case 'LR':
      return 'Listening and Reading';
    case 'SPEAKING':
      return 'Speaking';
    case 'WRITING':
      return 'Writing';
    case 'SUITE':
      return lang === 'vi' ? '4 kỹ năng' : 'Four skills';
    default:
      return null;
  }
}

/**
 * Exams Phase 7 — the library of one family: search, an availability filter and test cards that state only what the
 * server validated (modes, and — for full simulations — the server's question count / duration). The card opens the
 * test detail page where "Thi đầy đủ" and "Luyện theo phần" are chosen; no modal maze, no source-origin badges.
 * Echo Exam Universe (2026-10-24): each card is a glass boarding pass to its world — the art is chosen from the form's
 * own runnable skills (`cardArtKey`), never from its source; facts, badges, filters and the one link are unchanged.
 */
export const ExamLibrary: React.FC<ExamLibraryProps> = ({
  family,
  forms,
  isLoading = false,
  loadError = false,
  onRetry,
  inProgressFormIds,
  lang: propLang,
  filters, onFiltersChange, onLoadMore, hasMore, refreshing, total, serverVariants,
}) => {
  const { language } = useLanguage();
  const lang: 'vi' | 'en' = (propLang || language) === 'en' ? 'en' : 'vi';
  const familySlug = family.toLowerCase();
  const world = family === 'IELTS' ? 'ielts' : 'toeic';

  const [localQuery, setLocalQuery] = useState('');
  const [localMode, setLocalMode] = useState<ModeFilter>('USABLE');
  const [localVariant, setLocalVariant] = useState<string>('ALL');
  const query = filters?.query ?? localQuery;
  const modeFilter = filters?.mode ?? localMode;
  const variant = filters?.variant ?? localVariant;
  const setQuery = (value: string) => onFiltersChange && filters ? onFiltersChange({ ...filters, query: value }) : setLocalQuery(value);
  const setModeFilter = (value: ModeFilter) => onFiltersChange && filters ? onFiltersChange({ ...filters, mode: value }) : setLocalMode(value);
  const setVariant = (value: string) => onFiltersChange && filters ? onFiltersChange({ ...filters, variant: value }) : setLocalVariant(value);
  const [visible, setVisible] = useState(PAGE);

  const variants = useMemo(() => {
    if (serverVariants) return serverVariants.filter(v => variantLabel(v, lang));
    const set = new Set<string>();
    forms.forEach((f) => {
      if (variantLabel(String(f.variant), lang)) set.add(String(f.variant).toUpperCase());
    });
    return Array.from(set);
  }, [forms, lang, serverVariants]);

  const filtered = useMemo(() => {
    const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return forms
      .filter((f) => {
        if (variant !== 'ALL' && String(f.variant).toUpperCase() !== variant) return false;
        if (modeFilter === 'USABLE' && !isSimulationModeAvailable(f) && !isPracticeModeAvailable(f)) return false;
        if (modeFilter === 'BLOCKED' && (isSimulationModeAvailable(f) || isPracticeModeAvailable(f))) return false;
        if (modeFilter === 'SIMULATION' && !isSimulationModeAvailable(f)) return false;
        if (modeFilter === 'PRACTICE' && !isPracticeModeAvailable(f)) return false;
        if (tokens.length) {
          const hay = `${f.title} ${f.collectionTitle || ''}`.toLowerCase();
          if (!tokens.every((t) => hay.includes(t))) return false;
        }
        return true;
      })
      .map((f, i) => ({ f, i, rank: isSimulationModeAvailable(f) ? 0 : isPracticeModeAvailable(f) ? 1 : 2 }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((x) => x.f);
  }, [forms, query, modeFilter, variant]);

  useEffect(() => setVisible(PAGE), [query, modeFilter, variant]);

  const renderCard = (form: CatalogFormDto, index: number) => {
    const sim = isSimulationModeAvailable(form);
    const practice = isPracticeModeAvailable(form);
    const usable = sim || practice;
    const inProgress = inProgressFormIds?.has(form.id);
    // Question count / duration are shown ONLY for a server-validated full simulation (never derived for practice).
    const simFacts = sim
      ? [
          form.totalItems > 0 ? { icon: <ListChecks aria-hidden />, text: lang === 'vi' ? `${form.totalItems} câu` : `${form.totalItems} questions` } : null,
          durationText(form.totalDurationMinutes, lang) ? { icon: <Clock3 aria-hidden />, text: durationText(form.totalDurationMinutes, lang) } : null,
        ].filter((x): x is { icon: React.ReactElement; text: string } => Boolean(x))
      : [];
    const facts = sim
      ? simFacts.map((f) => f.text).join(' · ')
      : practice
      ? lang === 'vi'
        ? `Luyện được: ${scopeSummary(form.practiceScopeCodes || []) || skillList(getActiveRunnableSkills(form)) || '—'}`
        : `Practice: ${scopeSummary(form.practiceScopeCodes || []) || skillList(getActiveRunnableSkills(form)) || '—'}`
      : '';
    const vLabel = variantLabel(String(form.variant), lang);
    const runnable = getActiveRunnableSkills(form).map((s) => s.toUpperCase());
    const skills = runnable.filter((s) => SKILL_STYLE[s]);
    const subtitle = form.logicalKey?.startsWith('EC_ORIGINAL_') ? 'EnglishCoach Original Practice' : form.collectionTitle;
    const state = sim ? 'sim' : practice ? 'practice' : 'blocked';

    const inner = (
      <div className={ux.ticketFrame}>
        <div className={ux.ticketArt}>
          <CardArt artKey={formArtKey(form, runnable)} eager={index < 4} />
          <div className={ux.ticketChips}>
            <div className={ux.ticketChipRow}>
              {vLabel && <span className={ux.chip} data-kind="family">{vLabel}</span>}
              {skills.map((s) => {
                const style = SKILL_STYLE[s];
                return (
                  <span key={s} className={ux.chip} data-skill={s} title={style.label}>
                    {style.icon}
                    <span>{style.label}</span>
                  </span>
                );
              })}
            </div>
            {inProgress && (
              <span className={ux.chip} data-kind="progress">
                <RotateCcw aria-hidden />
                {lang === 'vi' ? 'Đang làm dở' : 'In progress'}
              </span>
            )}
          </div>
        </div>
        <span className={ux.ticketSheen} aria-hidden />

        <div className={ux.ticketBody}>
          <div>
            <h3 className={ux.ticketTitle} title={form.title}>{form.title}</h3>
            {subtitle && <p className={ux.ticketSub} title={subtitle}>{subtitle}</p>}
          </div>
          <div className={ux.badges}>
            {sim ? (
              <span className={ux.badge} data-kind="sim">
                <ShieldCheck aria-hidden />
                {getFullExamLabel(form, lang)}
              </span>
            ) : (
              <span className={ux.badge} data-kind="none">
                <Lock aria-hidden />
                {lang === 'vi' ? 'Chưa thi đầy đủ được' : 'No full simulation yet'}
              </span>
            )}
            {practice && (
              <span className={ux.badge} data-kind="practice">
                <GraduationCap aria-hidden />
                {lang === 'vi' ? 'Luyện theo phần' : 'Practice by part'}
              </span>
            )}
          </div>
          {form.contentReviewRequired && (
            <p data-testid="exam-content-under-review" className={ux.reviewNote}>
              <AlertCircle aria-hidden />
              {CONTENT_UNDER_REVIEW_MESSAGE[lang === 'vi' ? 'vi' : 'en']}
            </p>
          )}
        </div>

        <div className={ux.perf} aria-hidden />
        <div className={ux.stub}>
          {sim ? (
            <span className={ux.facts} aria-label={facts}>
              {simFacts.map((f) => (
                <span key={f.text}>{f.icon}{f.text}</span>
              ))}
            </span>
          ) : (
            <span className={ux.factsPractice}>{facts}</span>
          )}
          {usable ? (
            <span className={ux.ticketGo}>
              {lang === 'vi' ? 'Xem đề' : 'Open'}
              <ArrowRight aria-hidden />
            </span>
          ) : (
            <span className={ux.ticketClosed}>{lang === 'vi' ? 'Chưa khả dụng' : 'Not available'}</span>
          )}
        </div>
      </div>
    );

    return usable ? (
      <li key={form.id}>
        <Link
          id={`exam-card-${form.id}`}
          data-guide="ex-test"
          href={`/exams/${familySlug}/tests/${form.id}`}
          className={ux.ticket}
          data-world={world}
          data-state={state}
          style={{ '--i': index } as React.CSSProperties}
          onPointerMove={lightFollow}
          onPointerLeave={lightRest}
        >
          {inner}
        </Link>
      </li>
    ) : (
      <li key={form.id}>
        <div id={`exam-card-${form.id}`} aria-disabled="true" className={ux.ticket} data-world={world} data-state={state} style={{ '--i': index } as React.CSSProperties}>
          {inner}
        </div>
      </li>
    );
  };

  const filterLabel = (f: ModeFilter) =>
    f === 'USABLE' ? (lang === 'vi' ? 'Có thể làm' : 'Available')
      : f === 'BLOCKED' ? (lang === 'vi' ? 'Đang hoàn thiện' : 'In progress')
      : f === 'ALL'
      ? lang === 'vi' ? 'Tất cả' : 'All'
      : f === 'SIMULATION'
      ? lang === 'vi' ? 'Thi đầy đủ được' : 'Full simulation'
      : lang === 'vi' ? 'Luyện được' : 'Practice';

  return (
    <div className={ux.section}>
      <div className={ux.controls}>
        <div className={ux.search}>
          <Search className={ux.searchIcon} aria-hidden />
          <label htmlFor={`exam-search-${familySlug}`} className="sr-only">
            {lang === 'vi' ? 'Tìm đề' : 'Search tests'}
          </label>
          <input
            id={`exam-search-${familySlug}`}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={lang === 'vi' ? 'Tìm theo tên đề…' : 'Search by test name…'}
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label={lang === 'vi' ? 'Xóa tìm kiếm' : 'Clear search'} className={ux.searchClear}>
              <X aria-hidden />
            </button>
          )}
        </div>
        <div role="radiogroup" data-guide="ex-filters" aria-label={lang === 'vi' ? 'Lọc theo chế độ' : 'Filter by mode'} className={ux.modes}>
          {(['USABLE', 'SIMULATION', 'PRACTICE', 'BLOCKED', 'ALL'] as ModeFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={modeFilter === f}
              onClick={() => setModeFilter(f)}
              className={ux.mode}
            >
              {filterLabel(f)}
            </button>
          ))}
        </div>
        {variants.length > 1 && (
          <div className={ux.select}>
            <select value={variant} onChange={(e) => setVariant(e.target.value)} aria-label={lang === 'vi' ? 'Dạng đề' : 'Test type'}>
              <option value="ALL">{lang === 'vi' ? 'Mọi dạng đề' : 'All types'}</option>
              {variants.map((v) => (
                <option key={v} value={v}>
                  {variantLabel(v, lang)}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden />
          </div>
        )}
      </div>

      {(refreshing || (loadError && forms.length > 0)) && forms.length > 0 && (
        <div className={ux.refresh} role="status">
          {loadError ? (lang === 'vi' ? 'Chưa cập nhật được kho đề.' : 'Could not refresh tests.') : (lang === 'vi' ? 'Đang cập nhật…' : 'Refreshing…')}
          {loadError && onRetry && <button type="button" onClick={onRetry}>{lang === 'vi' ? 'Thử lại' : 'Retry'}</button>}
        </div>
      )}
      {isLoading && forms.length === 0 ? (
        <ul className={ux.grid} aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => <li key={i} className={ux.skeleton} />)}
          <span className="sr-only" role="status">{lang === 'vi' ? 'Đang tải kho đề…' : 'Loading tests…'}</span>
        </ul>
      ) : loadError && forms.length === 0 ? (
        <div className={ux.empty}>
          <span className={ux.emptyIcon} aria-hidden><AlertCircle /></span>
          <p>{lang === 'vi' ? 'Chưa tải được kho đề.' : 'The test library could not be loaded.'}</p>
          {onRetry && (
            <button type="button" onClick={onRetry} className={ux.emptyAction}>
              <RotateCw aria-hidden />
              {lang === 'vi' ? 'Thử lại' : 'Try again'}
            </button>
          )}
        </div>
      ) : forms.length === 0 ? (
        <div className={ux.empty}>
          <span className={ux.emptyIcon} aria-hidden><FileText /></span>
          <h3>{lang === 'vi' ? 'Kho đề đang được chuẩn bị' : 'Tests are being prepared'}</h3>
          <p>{lang === 'vi' ? 'Hiện chưa có đề nào sẵn sàng.' : 'No test is ready yet.'}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className={ux.empty}>
          <span className={ux.emptyIcon} aria-hidden><Search /></span>
          <p>{lang === 'vi' ? 'Không có đề phù hợp với bộ lọc.' : 'No test matches the filters.'}</p>
          <button
            type="button"
            onClick={() => {
              if (onFiltersChange) onFiltersChange({ query: '', mode: 'ALL', variant: 'ALL' });
              else { setQuery(''); setModeFilter('ALL'); setVariant('ALL'); }
            }}
            className={ux.emptyAction}
          >
            {lang === 'vi' ? 'Xóa bộ lọc' : 'Clear filters'}
          </button>
        </div>
      ) : (
        <>
          <div className={ux.collectionHead}>
            <p className={ux.collectionCount} aria-live="polite">
              <b>{total ?? filtered.length}</b> {lang === 'vi' ? 'đề' : 'tests'}
            </p>
          </div>
          <ul className={ux.grid}>{(onLoadMore ? filtered : filtered.slice(0, visible)).map(renderCard)}</ul>
          {(onLoadMore ? hasMore : visible < filtered.length) && (
            <div className={ux.more}>
              <button
                type="button"
                onClick={() => onLoadMore ? onLoadMore() : setVisible((v) => v + PAGE)}
                disabled={!!refreshing}
                className={ux.moreBtn}
              >
                {lang === 'vi' ? `Xem thêm (${(total ?? filtered.length) - (onLoadMore ? forms.length : visible)})` : `Show more (${(total ?? filtered.length) - (onLoadMore ? forms.length : visible)})`}
                <ChevronDown aria-hidden />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ExamLibrary;
