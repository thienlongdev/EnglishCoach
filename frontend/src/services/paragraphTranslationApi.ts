import { apiClient } from './api-client';
import {
  ParagraphCatalog,
  ParagraphSession,
  ParagraphStartRequest,
  ParagraphDraftRequest,
  ParagraphDraftResponse,
  ParagraphAttemptResponse,
  ParagraphAssistanceRequest,
  ParagraphAssistanceResponse,
  ParagraphPassageSummary
} from '@/types/paragraphTranslation';

export const paragraphTranslationApi = {
  async getCatalog(): Promise<ParagraphCatalog> {
    const res = await apiClient.get<ParagraphCatalog>('/writing/translation/paragraphs/catalog');
    return res.data;
  },

  async getPassages(genre?: string, topic?: string, page = 0, size = 20): Promise<{ content: ParagraphPassageSummary[]; totalElements: number }> {
    const params: Record<string, any> = { page, size };
    if (genre) params.genre = genre;
    if (topic) params.topic = topic;
    const res = await apiClient.get<{ content: ParagraphPassageSummary[]; totalElements: number }>('/writing/translation/paragraphs', { params });
    return res.data;
  },

  async startSession(request: ParagraphStartRequest): Promise<ParagraphSession> {
    const res = await apiClient.post<ParagraphSession>('/writing/translation/paragraphs/sessions', request, { timeout: 30000, signal: AbortSignal.timeout(30000) });
    return res.data;
  },

  async getActiveSession(): Promise<ParagraphSession | null> {
    const res = await apiClient.get<ParagraphSession | null>('/writing/translation/paragraphs/sessions/active');
    if (res.status === 204 || !res.data) {
      return null;
    }
    return res.data;
  },

  async getSession(sessionId: string): Promise<ParagraphSession> {
    const res = await apiClient.get<ParagraphSession>(`/writing/translation/paragraphs/sessions/${sessionId}`, { timeout: 30000, signal: AbortSignal.timeout(30000) });
    return res.data;
  },

  async saveDraft(sessionId: string, request: ParagraphDraftRequest): Promise<ParagraphDraftResponse> {
    const res = await apiClient.post<ParagraphDraftResponse>(`/writing/translation/paragraphs/sessions/${sessionId}/draft`, request);
    return res.data;
  },

  async navigateSession(sessionId: string, targetOrdinal: number): Promise<ParagraphSession> {
    const res = await apiClient.post<ParagraphSession>(`/writing/translation/paragraphs/sessions/${sessionId}/navigate`, { targetOrdinal });
    return res.data;
  },

  async skipItem(sessionId: string, ordinal: number): Promise<ParagraphSession> {
    const res = await apiClient.post<ParagraphSession>(`/writing/translation/paragraphs/sessions/${sessionId}/skip`, { ordinal });
    return res.data;
  },

  async submitAttempt(
    sessionId: string,
    request: { ordinal: number; action: string; clientMutationId: string; submittedText?: string }
  ): Promise<ParagraphAttemptResponse> {
    const res = await apiClient.post<ParagraphAttemptResponse>(`/writing/translation/paragraphs/sessions/${sessionId}/attempts`, request);
    return res.data;
  },

  async getAssistance(
    sessionId: string,
    request: ParagraphAssistanceRequest
  ): Promise<ParagraphAssistanceResponse> {
    const res = await apiClient.post<ParagraphAssistanceResponse>(`/writing/translation/paragraphs/sessions/${sessionId}/assistance`, request);
    return res.data;
  },

  async getAttemptsForItem(sessionId: string, itemId: string): Promise<ParagraphAttemptResponse[]> {
    const res = await apiClient.get<ParagraphAttemptResponse[]>(`/writing/translation/paragraphs/sessions/${sessionId}/items/${itemId}/attempts`);
    return res.data;
  }
};
