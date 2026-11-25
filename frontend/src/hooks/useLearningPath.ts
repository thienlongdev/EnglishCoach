'use client';

import useSWR from 'swr';
import { useSession } from 'next-auth/react';
import { learningPathApi } from '@/services/learningPathApi';
import type { ProgressSummary, TodayView } from '@/types/learningPath';

export const LEARNING_PATH_TODAY_KEY = '/learning-path/today';
export const LEARNING_PATH_SUMMARY_KEY = '/learning-path/summary';

/**
 * Today's plan. User-scoped key (cleared by clearUserScopedCaches). Re-checked when the learner comes back to the tab
 * (at most every 30 s) so finished activities show up; never polled.
 */
export function useLearningPathToday() {
  const { data: session, status } = useSession();
  const email = session?.user?.email;
  const key = status === 'authenticated' && email ? [LEARNING_PATH_TODAY_KEY, email] : null;
  return useSWR<TodayView>(key, () => learningPathApi.today(), {
    revalidateOnFocus: true,
    focusThrottleInterval: 30_000,
    dedupingInterval: 5_000,
    keepPreviousData: true,
    shouldRetryOnError: false,
  });
}

/** Read-only summary for Tiến trình học tập. */
export function useLearningPathSummary() {
  const { data: session, status } = useSession();
  const email = session?.user?.email;
  const key = status === 'authenticated' && email ? [LEARNING_PATH_SUMMARY_KEY, email] : null;
  return useSWR<ProgressSummary>(key, () => learningPathApi.summary(), {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
    shouldRetryOnError: false,
  });
}
