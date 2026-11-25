'use client';

import useSWR from 'swr';
import { useSession } from 'next-auth/react';
import { useSyncExternalStore } from 'react';
import { apiClient } from '@/services/api-client';
import { studySpaceApi, SWR_KEYS } from '@/lib/study-space/api';
import { getFocusEngine, type FocusState } from '@/lib/study-space/focus';
import type { StudyNote, StudyTask } from '@/lib/study-space/types';

/** Shared, account-keyed data of the study tools: one record list per kind, read by every widget and panel. */

export function useAccount(): string {
  const { data } = useSession();
  return data?.user ? String((data.user as { id?: string | number }).id ?? '') : '';
}

export function useTasks() {
  const account = useAccount();
  const swr = useSWR(account ? SWR_KEYS.tasks(account) : null, () => studySpaceApi.tasks(), { revalidateOnFocus: true, dedupingInterval: 4000 });
  const tasks = swr.data ?? [];
  const replace = (t: StudyTask) => swr.mutate((list = []) => list.map((x) => (x.id === t.id ? t : x)), { revalidate: false });
  return {
    tasks,
    loading: swr.isLoading,
    error: swr.error,
    create: async (t: Partial<StudyTask>) => { const made = await studySpaceApi.createTask(t); await swr.mutate((list = []) => [...list, made], { revalidate: false }); return made; },
    update: async (id: string, t: Partial<StudyTask> & { clearDue?: boolean }) => {
      swr.mutate((list = []) => list.map((x) => (x.id === id ? { ...x, ...t } as StudyTask : x)), { revalidate: false });
      const saved = await studySpaceApi.updateTask(id, t).catch((e) => { void swr.mutate(); throw e; });
      await replace(saved);
      return saved;
    },
    remove: async (id: string) => { await studySpaceApi.deleteTask(id); await swr.mutate((list = []) => list.filter((x) => x.id !== id), { revalidate: false }); },
    refresh: () => swr.mutate(),
  };
}

export function useNotes() {
  const account = useAccount();
  const swr = useSWR(account ? SWR_KEYS.notes(account) : null, () => studySpaceApi.notes(), { revalidateOnFocus: true, dedupingInterval: 4000 });
  return {
    notes: swr.data ?? [],
    loading: swr.isLoading,
    create: async (n: Partial<StudyNote>) => { const made = await studySpaceApi.createNote(n); await swr.mutate((list = []) => [made, ...list], { revalidate: false }); return made; },
    update: async (id: string, n: Partial<StudyNote>) => {
      const saved = await studySpaceApi.updateNote(id, n);
      await swr.mutate((list = []) => list.map((x) => (x.id === id ? saved : x)), { revalidate: false });
      return saved;
    },
    remove: async (id: string) => { await studySpaceApi.deleteNote(id); await swr.mutate((list = []) => list.filter((x) => x.id !== id), { revalidate: false }); },
  };
}

export function useFocusStats(days = 7) {
  const account = useAccount();
  return useSWR(account ? SWR_KEYS.stats(account, days) : null, () => studySpaceApi.focusStats(days), { refreshInterval: 60_000, revalidateOnFocus: true });
}

export function useDueCards() {
  const account = useAccount();
  return useSWR(account ? ['study-space/due', account] : null, async () => {
    const r = await apiClient.get<{ dueCount?: number }>('/flashcards/due-count', { params: { limit: 20 } });
    return typeof r.data?.dueCount === 'number' ? r.data.dueCount : null;
  }, { refreshInterval: 120_000 });
}

export function useFocus(): { state: FocusState; engine: ReturnType<typeof getFocusEngine> } {
  const account = useAccount();
  const engine = getFocusEngine(account);
  const state = useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);
  return { state, engine };
}
