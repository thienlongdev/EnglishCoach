'use client';

import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLanguage } from '@/context/LanguageContext';
import { LeaderboardHero, type BoardTab, type HallSlots } from './LeaderboardHero';
import { ActivityBoardTab } from './ActivityBoardTab';
import { ProficiencyBoardTab } from './ProficiencyBoardTab';
import { DivisionPlacementCta, PlacementCtaCard } from './PlacementCtaCard';
import { DEFAULT_COMPETITIVE_PERIOD, TEXT, type Locale } from '@/lib/leaderboard/format';
import type { ActivityPeriod, ActivityScope } from '@/types/leaderboard';
import styles from './hall/hall.module.css';

const PERIODS: ActivityPeriod[] = ['WEEK', 'MONTH', 'ALL_TIME'];
const SCOPES: ActivityScope[] = ['GLOBAL', 'SO_CAP', 'TRUNG_CAP', 'CAO_CAP'];
const NO_SLOTS: HallSlots = { meta: null, podium: null, aside: null };

/**
 * "Bảng xếp hạng" (/leaderboard) — Echo Hall of Champions: the hall (season, mode switch Thi đua / Năng lực, trophy,
 * podium, "Thành tích của bạn") over two independent boards. The active board owns its data and fills the hall's slots.
 */
export function LeaderboardPage() {
  const { locale } = useLanguage();
  const l: Locale = locale === 'en' ? 'en' : 'vi';
  const t = TEXT[l];
  const params = useSearchParams();
  const qp = params?.get('lbPeriod')?.toUpperCase() as ActivityPeriod | undefined;
  const qs = params?.get('lbScope')?.toUpperCase() as ActivityScope | undefined;
  const initialPeriod: ActivityPeriod = qp && PERIODS.includes(qp) ? qp : DEFAULT_COMPETITIVE_PERIOD;
  const initialScope: ActivityScope | null = qs && SCOPES.includes(qs) ? qs : null;
  const [tab, setTab] = useState<BoardTab>('activity');
  const [slots, setSlots] = useState<HallSlots>(NO_SLOTS);
  const onSlots = useCallback((s: HallSlots) => setSlots(s), []);

  return (
    <div className={`${styles.world} ${styles.page}`} data-testid="leaderboard-hall">
      <div className={styles.inner}>
        <LeaderboardHero locale={l} tab={tab} onTabChange={setTab} onSlots={onSlots} />
        <PlacementCtaCard locale={l} />
        <div role="tabpanel" aria-label={tab === 'activity' ? t.tabActivity : t.tabProficiency}>
          {tab === 'activity' ? (
            <ActivityBoardTab locale={l} initialPeriod={initialPeriod} initialScope={initialScope} slots={slots}
              divisionCta={<DivisionPlacementCta locale={l} />} />
          ) : (
            <ProficiencyBoardTab locale={l} slots={slots} />
          )}
        </div>
      </div>
    </div>
  );
}
