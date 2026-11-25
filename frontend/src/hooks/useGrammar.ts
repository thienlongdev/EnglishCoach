'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { useSession } from 'next-auth/react';
import { grammarApi } from '@/services/grammarApi';
import type { Catalog, CatalogDomain, CatalogTopic, GrammarMe, Topic, TopicState } from '@/types/grammar';

/**
 * Echo Grammar Academy data. The catalog and a topic are shared content (one key for everybody, revalidated by the server's
 * own ETag); what belongs to a learner is keyed with the signed-in account (`['grammar-me', userId]`) so one account never
 * sees another's state. Nothing here revalidates on focus and nothing polls.
 */
const STABLE = { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 60_000 } as const;

export function useGrammarCatalog() {
  return useSWR<Catalog>(['grammar-catalog'], () => grammarApi.catalog(), STABLE);
}

export function useGrammarTopic(slug: string | null | undefined) {
  return useSWR<Topic>(slug ? ['grammar-topic', slug] : null, () => grammarApi.topic(slug as string), STABLE);
}

/** The signed-in account's id, or null while the session is not known. */
export function useGrammarUserId(): string | null {
  const { data, status } = useSession();
  const id = (data?.user as { id?: string | number } | undefined)?.id;
  return status === 'authenticated' && id != null ? String(id) : null;
}

export function useGrammarMe() {
  const userId = useGrammarUserId();
  return useSWR<GrammarMe>(userId ? ['grammar-me', userId] : null, () => grammarApi.me(), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    dedupingInterval: 5_000,
  });
}

export interface TopicEntry { topic: CatalogTopic; domain: CatalogDomain }

const indexCache = new WeakMap<Catalog, Map<string, TopicEntry>>();

/** slug → topic and its domain, built once per catalog object. */
export function topicIndex(catalog: Catalog | undefined | null): Map<string, TopicEntry> {
  if (!catalog) return new Map();
  let index = indexCache.get(catalog);
  if (!index) {
    index = new Map();
    for (const domain of catalog.domains) for (const topic of domain.topics) index.set(topic.slug, { topic, domain });
    indexCache.set(catalog, index);
  }
  return index;
}

export function findTopic(catalog: Catalog | undefined | null, slug: string): TopicEntry | null {
  return topicIndex(catalog).get(slug) ?? null;
}

export function useTopicIndex(): { index: Map<string, TopicEntry>; catalog: Catalog | undefined; error: unknown; isLoading: boolean; mutate: () => void } {
  const { data, error, isLoading, mutate } = useGrammarCatalog();
  const index = useMemo(() => topicIndex(data), [data]);
  return { index, catalog: data, error, isLoading, mutate: () => { void mutate(); } };
}

export function stateOf(me: GrammarMe | undefined | null, slug: string): TopicState | null {
  return me?.states.find((s) => s.slug === slug) ?? null;
}

export function isBookmarked(me: GrammarMe | undefined | null, slug: string): boolean {
  return !!me?.bookmarks.includes(slug);
}

export function isDue(me: GrammarMe | undefined | null, slug: string): boolean {
  if (!me) return false;
  if (me.dueReviews.includes(slug)) return true;
  const s = stateOf(me, slug);
  return s?.status === 'REVIEW_DUE';
}
