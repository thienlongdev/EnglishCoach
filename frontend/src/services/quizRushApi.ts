import { apiClient } from '@/services/api-client';
import type { RushConfig, RushFeedback, RushSession, RushSetup } from '@/types/quizRush';
import type { CompetitiveState } from '@/types/quizRushCompetitive';
const base = '/games/echo-quiz-rush';
const options = (signal?: AbortSignal) => ({ signal, timeout: 12000 });
export const quizRushApi = {
  competitiveHistory: (signal?: AbortSignal) => apiClient.get<CompetitiveState[]>(`${base}/competitive/history`, options(signal)).then(r => r.data),
  competitiveRoom: (id:string, signal?: AbortSignal) => apiClient.get<CompetitiveState>(`${base}/competitive/rooms/${id}`, options(signal)).then(r => r.data),
  config: (signal?: AbortSignal) => apiClient.get<RushConfig>(`${base}/config`, options(signal)).then(r => r.data),
  active: (signal?: AbortSignal) => apiClient.get<RushSession | null>(`${base}/active`, options(signal)).then(r => r.data || null),
  history: (signal?: AbortSignal) => apiClient.get<RushSession[]>(`${base}/history`, options(signal)).then(r => r.data),
  get: (id: string, signal?: AbortSignal) => apiClient.get<RushSession>(`${base}/sessions/${id}`, options(signal)).then(r => r.data),
  start: (setup: RushSetup, requestId: string, signal?: AbortSignal) => apiClient.post<RushSession>(`${base}/sessions`, { ...setup, requestId }, options(signal)).then(r => r.data),
  answer: (id: string, questionId: string, optionId: string, requestId: string, signal?: AbortSignal) =>
    apiClient.post<RushFeedback>(`${base}/sessions/${id}/answers`, { questionId, optionId, requestId }, options(signal)).then(r => r.data),
  finish: (id: string, signal?: AbortSignal) => apiClient.post<RushSession>(`${base}/sessions/${id}/finish`, {}, options(signal)).then(r => r.data),
  abandon: (id: string, signal?: AbortSignal) => apiClient.post<RushSession>(`${base}/sessions/${id}/abandon`, {}, options(signal)).then(r => r.data),
};
