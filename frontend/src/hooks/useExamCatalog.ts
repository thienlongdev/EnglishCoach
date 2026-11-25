'use client';

import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { useModuleEntryScope } from './useModuleEntryResource';
import { examsApi } from '@/services/examsApi';
import { activeLearnerForm } from '@/lib/exams/productPolicy';
import type { AttemptHistoryItemDto, ExamAnalyticsDto, ExamFamily } from '@/types/exams';

const SWR_OPTS = { dedupingInterval: 30000, revalidateOnFocus: false, keepPreviousData: true } as const;

export type CatalogMode = 'USABLE' | 'ALL' | 'SIMULATION' | 'PRACTICE' | 'BLOCKED';
export type CatalogFilters = { mode: CatalogMode; query: string; variant: string };
const libraryFilters = new Map<ExamFamily, CatalogFilters>();
export function rememberedCatalogFilters(family: ExamFamily): CatalogFilters {
  return libraryFilters.get(family) || { mode: 'USABLE', query: '', variant: 'ALL' };
}
export function rememberCatalogFilters(family: ExamFamily, filters: CatalogFilters) {
  libraryFilters.set(family, filters);
}

/** Shared learner-safe metadata. Pages are retained across tab/detail/result navigation in the native SWR cache. */
export function useExamCatalog(family: ExamFamily | null, filters: CatalogFilters = { mode: 'USABLE', query: '', variant: 'ALL' }, formId?: string) {
  const { data, error, isLoading, isValidating, mutate, size, setSize } = useSWRInfinite(
    (index, previous) => !family || (previous && !previous.hasMore) ? null :
      ['exams:catalog', family, filters.mode, filters.query, filters.variant, formId || '', index],
    async ([, fam, mode, query, variant, id, index]) => examsApi.getCatalog({
      family: fam as ExamFamily, availability: mode as string, query: query as string,
      variant: variant === 'ALL' ? undefined : variant as string, formId: id ? id as string : undefined,
      limit: 24, offset: Number(index) * 24,
    }),
    { ...SWR_OPTS, revalidateFirstPage: true, revalidateAll: false, persistSize: false }
  );
  const forms = (data || []).flatMap(page => page.forms).filter(activeLearnerForm);
  return { forms, error, isLoading: isLoading && !data, isValidating,
    reload: () => mutate(), loadMore: () => setSize(size + 1),
    hasMore: data?.[data.length - 1]?.hasMore || false, total: data?.[0]?.total || 0,
    variants: data?.[0]?.variants || [],
    counts: { simulation: data?.[0]?.simulationCount || 0, practice: data?.[0]?.practiceCount || 0 },
  };
}

/** Exams Phase 7: the learner's own attempts (owner-scoped by the server), newest first. */
export function useExamHistory(family: ExamFamily | null | 'ALL', limit: number = 50) {
  const scope = useModuleEntryScope();
  const { data, error, isLoading, mutate } = useSWR<AttemptHistoryItemDto[]>(
    family && scope ? ['exams:history', scope, family, limit] : null,
    async () => (await examsApi.getHistory(family === 'ALL' ? { limit } : { family: family as ExamFamily, limit })) || [],
    { ...SWR_OPTS, keepPreviousData: false }
  );
  return { items: data || [], error, isLoading: isLoading && !data, reload: () => mutate() };
}

/**
 * Exams Phase 8: the learner's own analytics + mistakes + recommended practice ('ALL' = both families). Read-only and
 * deterministic; fetched only when a screen that shows it is open (never on hover / focus). The SWR cache is purged on
 * account switch by clearUserScopedCaches().
 */
export function useExamAnalytics(family: ExamFamily | 'ALL' | null) {
  const scope = useModuleEntryScope();
  const { data, error, isLoading, mutate } = useSWR<ExamAnalyticsDto>(
    family && scope ? ['exams:analytics', scope, family] : null,
    async () => examsApi.getAnalytics(family === 'ALL' ? undefined : (family as ExamFamily)),
    { ...SWR_OPTS, keepPreviousData: false }
  );
  return { analytics: data || null, error, isLoading: isLoading && !data, reload: () => mutate() };
}
