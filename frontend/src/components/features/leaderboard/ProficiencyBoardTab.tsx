'use client';

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { GraduationCap, ScrollText } from 'lucide-react';
import { ChipGroup } from './ChipGroup';
import { HallPodium } from './hall/HallPodium';
import { HallRow } from './hall/HallRow';
import { BoardError, BoardSkeleton, LeaderboardModal } from './BoardStates';
import type { HallSlots } from './LeaderboardHero';
import { ProficiencyHeaderCard } from './ProficiencyHeaderCard';
import { ProficiencyCardContent } from './ProficiencyCard';
import { ProficiencyPathButtons } from './ProficiencyPathsCard';
import {
  usePlacementMe,
  useProficiencyBoard,
  useProficiencyBoardMe,
  useProficiencyMe,
  useProficiencyOthers,
} from '@/hooks/useLeaderboard';
import {
  DIVISIONS,
  formatUpdatedAt,
  HALL_TEXT,
  optionLabel,
  levelSourceLabel,
  OTHERS_TEXT,
  proficiencyHeaderState,
  proficiencyPathsMode,
  PROFICIENCY_BOARDS,
  skillCellText,
  TEXT,
  undeterminedCountLine,
  type Locale,
} from '@/lib/leaderboard/format';
import type { Division, OtherLevelItem, ProficiencyBoard, ProficiencyItem } from '@/types/leaderboard';
import styles from './hall/hall.module.css';

const SKILL_KEYS: ('L' | 'R' | 'W' | 'S')[] = ['L', 'R', 'W', 'S'];

/** L · R · W · S mini chips (CEFR only when VERIFIED). */
export function SkillChips({ item }: { item: ProficiencyItem }) {
  return (
    <div className="flex w-full justify-end gap-1 sm:w-auto" aria-label="L · R · W · S">
      {SKILL_KEYS.map((k) => {
        const text = skillCellText(item.skills?.[k]);
        return (
          <span
            key={k}
            title={k}
            className={`rounded-md px-1.5 py-0.5 text-[11px] font-bold ${
              text === '–' ? 'bg-slate-100 dark:bg-white/[0.04] text-slate-400' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
            }`}
          >
            {k} {text}
          </span>
        );
      })}
    </div>
  );
}

/** One unranked group below the ranked rows ("Đang xác thực" / "Theo bài xếp lớp"): level + source label, no rank. */
function OthersGroup({ title, items, meId, locale, testId }: {
  title: string; items: OtherLevelItem[]; meId: number | null; locale: Locale; testId: string;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title} className="space-y-2" data-testid={testId}>
      <h3 className="px-1 pt-2 text-sm font-bold text-slate-500 dark:text-slate-400">
        {title} <span className="font-semibold">({items.length})</span>
      </h3>
      <ul className={styles.rows}>
        {items.map((u) => (
          <HallRow key={u.userId} rank={null} userId={u.userId} displayName={u.displayName} avatarUrl={u.avatarUrl}
            avatarFrame={u.avatarFrame} value={u.cefr} subValue={levelSourceLabel(u.source, locale) ?? undefined}
            muted isMe={u.userId === meId} youLabel={TEXT[locale].you} />
        ))}
      </ul>
    </section>
  );
}

export function ProficiencyBoardTab({ locale, slots }: { locale: Locale; slots: HallSlots }) {
  const t = TEXT[locale];
  const h = HALL_TEXT[locale];
  const [board, setBoard] = useState<ProficiencyBoard>('OVERALL');
  const [override, setOverride] = useState<Partial<Record<ProficiencyBoard, Division>>>({});
  const [levelOpen, setLevelOpen] = useState(false);

  const me = useProficiencyBoardMe(board);
  const profile = useProficiencyMe();
  const placement = usePlacementMe();
  // default: the user's own division on this board if known, otherwise Trung cấp
  const division: Division | null =
    override[board] ?? (me.data ? me.data.division ?? 'TRUNG_CAP' : me.error ? 'TRUNG_CAP' : null);
  const list = useProficiencyBoard(board, division);
  const others = useProficiencyOthers(board, division);
  const verifiedLabel = levelSourceLabel('VERIFIED', locale);
  const rowSub = (i: ProficiencyItem) => `${verifiedLabel} · ${i.confidenceLabel}`;
  const items = list.data?.items ?? [];
  const meId = me.data?.userId ?? null;
  const loading = division == null || (list.isLoading && !list.data);
  // Wait for the placement state so a placed learner never sees the "Làm bài xếp lớp nhanh" button flash.
  const levelMe = placement.data || placement.error ? me.data : undefined;
  const placementCefr = placement.data?.latestStatus != null ? placement.data.resultCefr : null;
  const skillBoard = board !== 'OVERALL';
  const headerState = proficiencyHeaderState(levelMe, profile.data?.placementCta, locale, placementCefr, skillBoard);
  // no level / quick level only ⇒ both paths; exam-based level ⇒ optional verification link; EXCLUDED / loading ⇒ nothing
  const pathsMode = proficiencyPathsMode(headerState);

  const opt = <T extends string>(l: { id: T; vi: string; en: string }[]) => l.map((o) => ({ id: o.id, label: o[locale] }));

  const emptyAction = pathsMode ? (
    <ProficiencyPathButtons mode={pathsMode} locale={locale} />
  ) : headerState ? (
    <Link
      href="/exams"
      data-testid="empty-verify-link"
      className="inline-flex items-center rounded-xl border border-sky-400/50 px-4 py-2 text-sm font-semibold text-sky-700 hover:bg-sky-500/10 dark:text-sky-200"
    >
      {t.proficiencyEmptyCta}
    </Link>
  ) : undefined;

  const podium = list.error ? (
    <BoardError message={t.loadError} retryLabel={t.retry} onRetry={() => { list.mutate(); me.mutate(); }} />
  ) : (
    <HallPodium
      locale={locale}
      ariaLabel={t.podium}
      loading={loading}
      entries={loading ? [] : items.slice(0, 3).map((i) => ({ ...i, value: `${i.cefr} · ${i.rating}`, subValue: rowSub(i), isMe: i.userId === meId }))}
      empty={
        <div className={styles.emptyCall} data-testid="board-empty">
          <h3>{h.emptyHall}</h3>
          <p>{t.proficiencyEmpty}</p>
          {/* the hall panel is always dark: its Tailwind content reads the dark variant */}
          {emptyAction && <div className="dark">{emptyAction}</div>}
        </div>
      }
    />
  );

  const aside = (
    <section className={styles.achieve} aria-label={t.yourLevel} data-testid="hall-level-panel">
      <h2 className={styles.achieveHead}><GraduationCap className="h-5 w-5" aria-hidden="true" />{t.yourLevel}</h2>
      <div className={styles.stats}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{h.rank}</span>
          <span className={styles.statValue} data-rank={me.data?.rank != null ? 'true' : undefined} data-muted={me.data?.rank == null ? 'true' : undefined}>
            {me.data ? (me.data.rank != null ? `#${me.data.rank}` : '—') : '…'}
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{h.colLevel}</span>
          <span className={styles.statValue}>{me.data ? (me.data.cefr ?? placementCefr ?? '—') : '…'}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{h.levelBoard}</span>
          <span className={styles.statValue} data-muted="true">{optionLabel(PROFICIENCY_BOARDS, board, locale)}</span>
        </div>
      </div>
      {headerState && <p className={styles.note}>{headerState.title}{headerState.note ? ` · ${headerState.note}` : ''}</p>}
      <button type="button" onClick={() => setLevelOpen(true)} className={styles.ghostBtn}>{t.viewMyLevel}</button>
    </section>
  );

  return (
    <div className="space-y-5">
      {slots.meta && createPortal(
        <span className={styles.metaChip} data-tone="gold">
          {optionLabel(PROFICIENCY_BOARDS, board, locale)}{division ? ` · ${optionLabel(DIVISIONS, division, locale)}` : ''}
        </span>,
        slots.meta,
      )}
      {slots.podium && createPortal(podium, slots.podium)}
      {slots.aside && createPortal(aside, slots.aside)}

      <div className={styles.deck} role="group" aria-label={h.filters}>
        <div className={styles.deckGroup}>
          <ChipGroup variant="tabs" ariaLabel={locale === 'vi' ? 'Bảng' : 'Board'} options={opt(PROFICIENCY_BOARDS)} value={board} onChange={setBoard} />
        </div>
        <span className={styles.deckSep} aria-hidden="true" />
        <div className={styles.deckGroup}>
          <ChipGroup
            ariaLabel={locale === 'vi' ? 'Hạng' : 'Division'}
            options={opt(DIVISIONS)}
            value={division}
            onChange={(d) => setOverride((o) => ({ ...o, [board]: d }))}
          />
        </div>
      </div>
      <p className="ec-wp-plate w-fit text-sm text-slate-600 dark:text-slate-300">{t.proficiencyHint}</p>

      <ProficiencyHeaderCard
        me={levelMe}
        placementCta={profile.data?.placementCta}
        placementCefr={placementCefr}
        skillBoard={skillBoard}
        locale={locale}
        onOpenLevel={() => setLevelOpen(true)}
      />

      <section className={styles.roll} aria-labelledby="roll-title-p">
        <div className={styles.rollHead}>
          <h2 id="roll-title-p" className={styles.rollTitle}><ScrollText className="h-5 w-5" aria-hidden="true" />{h.rollTitle}</h2>
        </div>
        {list.error ? (
          <p className="px-2 text-sm text-rose-600 dark:text-rose-300">{t.loadError}</p>
        ) : loading ? (
          <BoardSkeleton rows={5} label={locale === 'vi' ? 'Đang tải bảng năng lực' : 'Loading proficiency board'} />
        ) : items.length > 3 ? (
          <>
            <div className={styles.cols} aria-hidden="true"><span>{h.colRank}</span><span>{h.colLearner}</span><span>{h.colLevel}</span></div>
            <ol className={styles.rows} aria-label={t.tabProficiency} start={4}>
              {items.slice(3).map((i) => (
                <HallRow key={i.userId} rank={i.rank} userId={i.userId} displayName={i.displayName} avatarUrl={i.avatarUrl}
                  avatarFrame={i.avatarFrame} value={`${i.cefr} · ${i.rating}`} subValue={rowSub(i)}
                  isMe={i.userId === meId} youLabel={t.you} extra={<SkillChips item={i} />} />
              ))}
            </ol>
          </>
        ) : (
          <p className="px-2 pb-1 text-sm text-slate-500 dark:text-slate-400">{items.length === 0 ? t.proficiencyEmpty : h.rollEmpty}</p>
        )}
      </section>

      {others.data && (
        <div className={`${styles.card} space-y-3`} data-testid="proficiency-others">
          <OthersGroup title={OTHERS_TEXT[locale].verifying} items={others.data.verifying} meId={meId} locale={locale} testId="others-verifying" />
          <OthersGroup title={OTHERS_TEXT[locale].placement} items={others.data.placement} meId={meId} locale={locale} testId="others-placement" />
          {others.data.undeterminedCount > 0 && (
            <p className="px-1 text-sm text-slate-500 dark:text-slate-400" data-testid="others-undetermined">
              {undeterminedCountLine(others.data.undeterminedCount, locale)}
            </p>
          )}
        </div>
      )}

      <p className="text-center text-xs text-slate-500 dark:text-slate-400">{formatUpdatedAt(list.data?.updatedAt ?? me.data?.updatedAt, locale)}</p>

      <LeaderboardModal open={levelOpen} title={t.yourLevel} closeLabel={t.close} onClose={() => setLevelOpen(false)} wide>
        <ProficiencyCardContent locale={locale} />
      </LeaderboardModal>
    </div>
  );
}
