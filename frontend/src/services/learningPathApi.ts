import { apiClient } from './api-client';
import type { DnaProposal, GoalInput, ProgressSummary, TodayView } from '@/types/learningPath';

/** Echo Learning Path. State-changing calls are POST / PUT (CSRF via apiClient); none of them calls AI. */
export const learningPathApi = {
  /** Today's tasks: created on the first visit of the day (then stable); links newly finished learning. */
  today: async (): Promise<TodayView> => (await apiClient.post<TodayView>('/learning-path/today')).data,
  setGoal: async (input: GoalInput): Promise<TodayView> => (await apiClient.put<TodayView>('/learning-path/goal', input)).data,
  summary: async (): Promise<ProgressSummary> => (await apiClient.get<ProgressSummary>('/learning-path/summary')).data,
  /** Explicit "Cập nhật bằng Learner DNA": returns a proposal only. */
  proposeDna: async (): Promise<DnaProposal> => (await apiClient.post<DnaProposal>('/learning-path/dna-proposals')).data,
  applyDna: async (id: number): Promise<TodayView> =>
    (await apiClient.post<TodayView>(`/learning-path/dna-proposals/${encodeURIComponent(String(id))}/apply`)).data,
  cancelDna: async (id: number): Promise<void> => {
    await apiClient.post(`/learning-path/dna-proposals/${encodeURIComponent(String(id))}/cancel`);
  },
};
