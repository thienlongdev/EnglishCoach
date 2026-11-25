import { apiClient } from './api-client';

/** Echo Intelligence 7.0 surfaces next to the chat. Every call is scoped by the server to the signed-in learner. */
export interface EchoMemoryItem { id: number; kind: string; value: string; updatedAt: string }
export interface EchoSuggestion { key: string; text: string; href: string; label: string }
export interface EchoDecision { status: 'APPLIED' | 'CANCELLED'; plan: Record<string, unknown> }

export const echoIntelligenceApi = {
  memory: async (): Promise<EchoMemoryItem[]> =>
    (await apiClient.get<EchoMemoryItem[]>('/echo/memory', { skipAuthRedirect: true } as any)).data,
  forget: async (id: number): Promise<void> => { await apiClient.delete(`/echo/memory/${id}`, { skipAuthRedirect: true } as any); },
  forgetAll: async (): Promise<void> => { await apiClient.delete('/echo/memory', { skipAuthRedirect: true } as any); },
  suggestions: async (locale: 'vi' | 'en'): Promise<EchoSuggestion[]> =>
    (await apiClient.get<EchoSuggestion[]>(`/echo/suggestions?locale=${locale}`, { skipAuthRedirect: true } as any)).data,
  decide: async (token: string, decision: 'CONFIRM' | 'CANCEL'): Promise<EchoDecision> =>
    (await apiClient.post<EchoDecision>(`/echo/confirmations/${encodeURIComponent(token)}`, { decision }, { skipAuthRedirect: true } as any)).data,
};
