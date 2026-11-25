'use client';

import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { TEXT } from '@/lib/leaderboard/format';
import { placementQuizStore } from '@/lib/leaderboard/placementQuizStore';

const LeaderboardModal = dynamic(() => import('./BoardStates').then((m) => m.LeaderboardModal), { ssr: false });
const PlacementQuizModal = dynamic(() => import('./PlacementQuiz').then((m) => m.PlacementQuizModal), { ssr: false });
const ProficiencyCardContent = dynamic(() => import('./ProficiencyCard').then((m) => m.ProficiencyCardContent), { ssr: false });

/**
 * The single placement quiz modal of the app (mounted once in `app/providers.tsx`). It sits outside every page tree, so
 * the result screen stays open while the submit revalidation flips eligibility and the entry buttons disappear; it
 * closes only on an explicit learner action (Đóng / Xem bảng xếp hạng / a link) or when the route changes.
 */
export function PlacementQuizHost() {
  const s = useSyncExternalStore(placementQuizStore.subscribe, placementQuizStore.getSnapshot, placementQuizStore.getSnapshot);
  const pathname = usePathname();
  const lastPath = useRef(pathname);

  // Leaving the page (browser back, a link outside the modal) closes it, as the old per-page modal did by unmounting.
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    placementQuizStore.close();
  }, [pathname]);

  if (!s.open) return null;

  return (
    <>
      {s.view === 'quiz' && (
        <PlacementQuizModal
          open={s.open && s.view === 'quiz'}
          onClose={placementQuizStore.close}
          onViewLevel={placementQuizStore.showLevel}
          locale={s.locale}
        />
      )}
      {s.view === 'level' && (
        <LeaderboardModal
          open={s.open && s.view === 'level'}
          title={TEXT[s.locale].yourLevel}
          closeLabel={TEXT[s.locale].close}
          onClose={placementQuizStore.close}
          wide
        >
          <ProficiencyCardContent locale={s.locale} />
        </LeaderboardModal>
      )}
    </>
  );
}
