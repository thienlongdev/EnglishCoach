'use client';

import useSWR, { mutate as globalMutate, SWRConfiguration } from 'swr';
import { useSession } from 'next-auth/react';
import { leaderboardApi } from '@/services/leaderboardApi';
import { boardKey, meKey, readBoardSnapshot, fetchBoardSnapshot } from '@/services/leaderboardSnapshots';
import { viewerRecentlyActive } from '@/lib/ui/viewerActivity';
import type {
  ActivityBoardResponse,
  ActivityMeResponse,
  ActivityGroup,
  ActivityPeriod,
  ActivityScope,
  Division,
  ProficiencyBoard,
} from '@/types/leaderboard';

// Keys are user-scoped (AGENTS §21.5) and cleared with the SWR cache by clearUserScopedCaches().
// The backend refreshes the boards within seconds of a scored activity (live refresh). An OPEN leaderboard re-reads
// every LIVE_REFRESH_MS while the browser tab is visible (SWR pauses when hidden / offline), on focus and on mount;
// nothing polls once the leaderboard is closed. Dashboard widgets re-read once a minute.
export const LIVE_REFRESH_MS = 5_000;
export const WIDGET_REFRESH_MS = 60_000;
/**
 * An open board nobody has touched for VIEWER_IDLE_MS re-reads at the widget cadence instead (performance release
 * 2026-11-16, PERF-22: a board left open on a screen cost two reads every five seconds forever). Any pointer, key or
 * wheel input restores the live cadence on the next read; returning to the tab re-reads at once (revalidateOnFocus).
 */
export const VIEWER_IDLE_MS = 120_000;
export const liveRefreshInterval = (): number => (viewerRecentlyActive(VIEWER_IDLE_MS) ? LIVE_REFRESH_MS : WIDGET_REFRESH_MS);
/** Dashboard cards: ONE extra read this long after mount / period switch (backend live refresh ≈ 2–8 s); not a poll. */
export const WIDGET_SETTLE_MS = 8_000;

const LIVE_SWR: SWRConfiguration = {
  revalidateOnFocus: true,
  revalidateOnMount: true,
  focusThrottleInterval: 2_000,
  dedupingInterval: 2_000,
  refreshInterval: liveRefreshInterval,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
  // false: switching period / scope / group never shows another partition's numbers while loading
  keepPreviousData: false,
  shouldRetryOnError: false,
};

const WIDGET_SWR: SWRConfiguration = { ...LIVE_SWR, refreshInterval: WIDGET_REFRESH_MS };

/** Proficiency data changes only with exams / placement: no interval, revalidate on focus and mount. */
const LEVEL_SWR: SWRConfiguration = { ...LIVE_SWR, refreshInterval: 0 };

export interface BoardHookOptions {
  /** false for dashboard widgets (one re-read per minute instead of every few seconds). */
  live?: boolean;
  /** Thi đua rows to load (20 per "Xem thêm", max 100). */
  limit?: number;
}

function useUserKey(): string | null {
  const { data: session, status } = useSession();
  const email = session?.user?.email;
  return status === 'authenticated' && email ? email : null;
}
export function usePreparedDefaultScope(period: ActivityPeriod): ActivityScope | null {
  const user = useUserKey();
  return user ? readBoardSnapshot(meKey(period, null, 'ALL', user))?.defaultScope ?? null : null;
}

export function useActivityBoard(period: ActivityPeriod, scope: ActivityScope | null, group: ActivityGroup,
  options: BoardHookOptions = {}) {
  const user = useUserKey();
  const limit = options.limit ?? 20;
  const key = user && scope ? boardKey(period, scope, group, limit, user) : null;
  const resource = useSWR<ActivityBoardResponse>(
    key,
    () => fetchBoardSnapshot(key!, () => leaderboardApi.getActivityBoard(period, scope as ActivityScope, group, limit)),
    { ...(options.live === false ? WIDGET_SWR : LIVE_SWR), fallbackData: key ? readBoardSnapshot(key) : undefined },
  );
  const snapshot: ActivityBoardResponse | undefined = key ? readBoardSnapshot(key) : undefined;
  // SWR may retain a closed board indefinitely. A newly opened live view may only use the bounded snapshot.
  // The mounted board retains its own last rows during connection loss; widgets keep their 60-second cadence.
  return { ...resource, data: options.live === false ? resource.data : snapshot,
    isLoading: resource.isLoading || (options.live !== false && !snapshot && resource.isValidating) };
}

export function useActivityMe(period: ActivityPeriod, scope: ActivityScope | null, group: ActivityGroup,
  options: BoardHookOptions = {}) {
  const user = useUserKey();
  const key = user ? meKey(period, scope, group, user) : null;
  return useSWR<ActivityMeResponse>(
    key,
    () => fetchBoardSnapshot(key!, () => leaderboardApi.getActivityMe(period, scope, group)),
    { ...(options.live === false ? WIDGET_SWR : LIVE_SWR), fallbackData: key ? readBoardSnapshot(key) : undefined },
  );
}

export function useProficiencyBoard(board: ProficiencyBoard, division: Division | null) {
  const user = useUserKey();
  return useSWR(
    user && division ? ['/leaderboard/proficiency', board, division, user] : null,
    () => leaderboardApi.getProficiencyBoard(board, division),
    LEVEL_SWR,
  );
}

export function useProficiencyBoardMe(board: ProficiencyBoard) {
  const user = useUserKey();
  return useSWR(
    user ? ['/leaderboard/proficiency/me', board, user] : null,
    () => leaderboardApi.getProficiencyBoardMe(board),
    LEVEL_SWR,
  );
}

export const PROFICIENCY_ME_KEY = '/proficiency/me';

export function useProficiencyMe() {
  const user = useUserKey();
  return useSWR(
    user ? [PROFICIENCY_ME_KEY, user] : null,
    () => leaderboardApi.getProficiencyMe(),
    LEVEL_SWR,
  );
}

export function useProficiencyOthers(board: ProficiencyBoard, division: Division | null) {
  const user = useUserKey();
  return useSWR(
    user && division ? ['/leaderboard/proficiency/others', board, division, user] : null,
    () => leaderboardApi.getProficiencyOthers(board, division as Division),
    LEVEL_SWR,
  );
}

export const PLACEMENT_ME_KEY = '/proficiency/placement/me';

export function usePlacementMe() {
  const user = useUserKey();
  return useSWR(
    user ? [PLACEMENT_ME_KEY, user] : null,
    () => leaderboardApi.getPlacementMe(),
    LEVEL_SWR,
  );
}

/**
 * After an activity that scores points (e.g. a Card Blast run): mark every cached board / "me" entry of the current
 * session stale so no screen keeps the old XP; mounted views re-read immediately, others on their next mount.
 */
export function invalidateLeaderboardCaches(): void {
  // no data argument: revalidate only (an explicit `undefined` would wipe the cache and flash skeletons)
  void globalMutate((key) => Array.isArray(key) && typeof key[0] === 'string' && key[0].startsWith('/leaderboard'));
}
