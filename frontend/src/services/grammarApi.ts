import { apiClient } from './api-client';
import type { Answer, Catalog, CheckKind, CheckResult, CheckSummary, CheckView, DetectiveCase, GrammarCapabilities, GrammarMe, LabExperiment, Level, MistakesView, PracticeSet, ProfessorAnswer, Story, Topic, Verdict } from '@/types/grammar';

const id = (value: string) => encodeURIComponent(value);

/** Echo Grammar Academy. Answers are judged on the server; nothing here calls AI except `askProfessor`, an explicit question. */
export const grammarApi = {
  capabilities: async (): Promise<GrammarCapabilities> => (await apiClient.get<GrammarCapabilities>('/grammar/capabilities')).data,
  catalog: async (): Promise<Catalog> => (await apiClient.get<Catalog>('/grammar/catalog')).data,
  topic: async (slug: string): Promise<Topic> => (await apiClient.get<Topic>(`/grammar/topics/${id(slug)}`)).data,
  me: async (): Promise<GrammarMe> => (await apiClient.get<GrammarMe>('/grammar/me')).data,
  setLevel: async (level: Level): Promise<void> => { await apiClient.put('/grammar/me/level', { level }); },
  open: async (slug: string): Promise<void> => { await apiClient.post(`/grammar/topics/${id(slug)}/open`); },
  studied: async (slug: string): Promise<void> => { await apiClient.post(`/grammar/topics/${id(slug)}/studied`); },
  /** One `requestId` per learner action: a retry of the same action stores nothing twice. */
  attempt: async (exerciseId: string, answer: Answer, requestId: string): Promise<Verdict> =>
    (await apiClient.post<Verdict>('/grammar/attempts', { requestId, exerciseId, answer })).data,
  practice: async (params: { kind?: 'mixed' | 'mistakes' | 'due'; domain?: string; level?: string; type?: string; size?: number }): Promise<PracticeSet> =>
    (await apiClient.get<PracticeSet>('/grammar/practice', { params })).data,
  startCheck: async (kind: CheckKind, scope?: string): Promise<CheckView> => (await apiClient.post<CheckView>('/grammar/checks', { kind, scope })).data,
  check: async (checkId: string): Promise<CheckView> => (await apiClient.get<CheckView>(`/grammar/checks/${id(checkId)}`)).data,
  checks: async (): Promise<CheckSummary[]> => (await apiClient.get<CheckSummary[]>('/grammar/checks')).data,
  submitCheck: async (checkId: string, answers: Record<string, Answer>): Promise<CheckResult> =>
    (await apiClient.post<CheckResult>(`/grammar/checks/${id(checkId)}/submit`, { answers })).data,
  mistakes: async (): Promise<MistakesView> => (await apiClient.get<MistakesView>('/grammar/mistakes')).data,
  bookmark: async (slug: string, on: boolean): Promise<void> => {
    if (on) await apiClient.put(`/grammar/bookmarks/${id(slug)}`);
    else await apiClient.delete(`/grammar/bookmarks/${id(slug)}`);
  },
  report: async (report: { kind: 'ANSWER' | 'CONTENT'; topic?: string; exerciseId?: string; answer?: string; message?: string }): Promise<void> => {
    await apiClient.post('/grammar/reports', report);
  },
  askProfessor: async (topic: string, question: string, sentence?: string, requestId?: string): Promise<ProfessorAnswer> =>
    (await apiClient.post<ProfessorAnswer>('/grammar/professor/ask', { topic, question, sentence },
      { headers: { 'X-Request-Id': requestId ?? crypto.randomUUID() } })).data,
  story: async (storyId: string): Promise<Story> => (await apiClient.get<Story>(`/grammar/stories/${id(storyId)}`)).data,
  lab: async (labId: string): Promise<LabExperiment> => (await apiClient.get<LabExperiment>(`/grammar/lab/${id(labId)}`)).data,
  detective: async (caseId: string): Promise<DetectiveCase> => (await apiClient.get<DetectiveCase>(`/grammar/detective/${id(caseId)}`)).data,
};
