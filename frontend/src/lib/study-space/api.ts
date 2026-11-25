import { apiClient } from '@/services/api-client';
import type {
  Annotation, FocusSessionRecord, FocusStats, Layout, ResearchItem, SnapshotSummary, SpaceRecord, SpaceSummary, StudyNote, StudyTask,
} from './types';

/**
 * Không gian học tập — `/api/v1/study-space/**`. The server scopes every call to the signed-in learner; nothing here
 * names a user. Layouts carry catalogue ids and tool settings only; documents and media never leave the browser.
 */
const B = '/study-space';
/** The label mark of a room the learner saved by name: the server never lets the rolling version history replace these. */
export const NAMED_ROOM = '★ ';
const d = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);

export const studySpaceApi = {
  list: () => d(apiClient.get<{ items: SpaceSummary[]; active: SpaceRecord | null; limit: number }>(`${B}/spaces`)),
  get: (id: string) => d(apiClient.get<SpaceRecord>(`${B}/spaces/${id}`)),
  create: (name: string, layout: Layout | null, copyFrom?: string, activate = true) =>
    d(apiClient.post<SpaceRecord>(`${B}/spaces`, { name, layout, copyFrom: copyFrom ?? null, activate })),
  rename: (id: string, name: string) => d(apiClient.put<SpaceRecord>(`${B}/spaces/${id}/name`, { name })),
  activate: (id: string) => d(apiClient.post<SpaceRecord>(`${B}/spaces/${id}/activate`)),
  saveLayout: (id: string, layout: Layout, revision: number | null, reason: 'NONE' | 'CLEAR' | 'RESTORE' | 'TEMPLATE' = 'NONE') =>
    d(apiClient.put<SpaceRecord>(`${B}/spaces/${id}/layout`, { layout, revision, reason })),
  saveDefault: (id: string, layout: Layout) => d(apiClient.put<SpaceRecord>(`${B}/spaces/${id}/default`, { layout })),
  remove: (id: string) => apiClient.delete(`${B}/spaces/${id}`),
  snapshots: (id: string) => d(apiClient.get<SnapshotSummary[]>(`${B}/spaces/${id}/snapshots`)),
  snapshot: (id: string, snapshotId: string) => d(apiClient.get<SnapshotSummary & { layout: unknown }>(`${B}/spaces/${id}/snapshots/${snapshotId}`)),
  createSnapshot: (id: string, label: string, layout: Layout) => d(apiClient.post<SnapshotSummary[]>(`${B}/spaces/${id}/snapshots`, { label, layout })),
  removeSnapshot: (id: string, snapshotId: string) => apiClient.delete(`${B}/spaces/${id}/snapshots/${snapshotId}`),

  tasks: () => d(apiClient.get<StudyTask[]>(`${B}/tasks`)),
  createTask: (t: Partial<StudyTask>) => d(apiClient.post<StudyTask>(`${B}/tasks`, t)),
  updateTask: (id: string, t: Partial<StudyTask> & { clearDue?: boolean }) => d(apiClient.put<StudyTask>(`${B}/tasks/${id}`, t)),
  deleteTask: (id: string) => apiClient.delete(`${B}/tasks/${id}`),

  notes: () => d(apiClient.get<StudyNote[]>(`${B}/notes`)),
  createNote: (n: Partial<StudyNote>) => d(apiClient.post<StudyNote>(`${B}/notes`, n)),
  updateNote: (id: string, n: Partial<StudyNote>) => d(apiClient.put<StudyNote>(`${B}/notes/${id}`, n)),
  deleteNote: (id: string) => apiClient.delete(`${B}/notes/${id}`),

  reportFocus: (id: string, r: { mode: FocusSessionRecord['mode']; status: FocusSessionRecord['status']; plannedSeconds: number; focusedSeconds: number; taskId: string | null; label: string | null; subject: string | null }) =>
    d(apiClient.put<FocusSessionRecord>(`${B}/focus/sessions/${id}`, r)),
  focusStats: (days = 7) => d(apiClient.get<FocusStats>(`${B}/focus/stats`, { params: { days } })),
  linkBlockSession: (id:string,session:string) => apiClient.put(`${B}/time-blocks/${id}/sessions/${session}`),

  research: () => d(apiClient.get<ResearchItem[]>(`${B}/research`)),
  createResearch: (r: Partial<ResearchItem>) => d(apiClient.post<ResearchItem>(`${B}/research`, r)),
  updateResearch: (id: string, r: Partial<ResearchItem> & { annotations?: Annotation[] }) => d(apiClient.put<ResearchItem>(`${B}/research/${id}`, r)),
  deleteResearch: (id: string) => apiClient.delete(`${B}/research/${id}`),
};

export const SWR_KEYS = {
  tasks: (u: string) => ['study-space/tasks', u] as const,
  notes: (u: string) => ['study-space/notes', u] as const,
  research: (u: string) => ['study-space/research', u] as const,
  stats: (u: string, days: number) => ['study-space/focus-stats', u, days] as const,
};

/** Who the player is, from their active space: for a place outside the Study Space, on a device that has no record of the choice yet. */
export async function activeStudyCharacter(): Promise<{ model?: unknown; look?: unknown; lookAt?: unknown } | null> {
  const list = await studySpaceApi.list();
  const layout = list.active?.layout as { character?: { model?: unknown; look?: unknown; lookAt?: unknown } } | null | undefined;
  return layout?.character ?? null;
}
