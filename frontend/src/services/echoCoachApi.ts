import { apiClient } from './api-client';

export interface EchoCoachSessionDto {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface EchoCoachMessageDto {
  id: number;
  sessionId: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface SaveMessagePairRequest {
  userMessage?: string;
  assistantMessage?: string;
  role?: string;
  content?: string;
}

export const echoCoachApi = {
  getRecentSessions: async (): Promise<EchoCoachSessionDto[]> => {
    const res = await apiClient.get<EchoCoachSessionDto[]>('/echo-coach/sessions', { skipAuthRedirect: true } as any);
    return res.data;
  },

  createSession: async (title?: string): Promise<EchoCoachSessionDto> => {
    const res = await apiClient.post<EchoCoachSessionDto>('/echo-coach/sessions', {
      title: title || undefined,
    }, { skipAuthRedirect: true } as any);
    return res.data;
  },

  getSessionMessages: async (sessionId: number): Promise<EchoCoachMessageDto[]> => {
    const res = await apiClient.get<EchoCoachMessageDto[]>(`/echo-coach/sessions/${sessionId}/messages`, { skipAuthRedirect: true } as any);
    return res.data;
  },

  saveMessagePair: async (
    sessionId: number,
    userMessage: string,
    assistantMessage: string
  ): Promise<EchoCoachMessageDto[]> => {
    const res = await apiClient.post<EchoCoachMessageDto[]>(`/echo-coach/sessions/${sessionId}/messages`, {
      userMessage,
      assistantMessage,
    }, { skipAuthRedirect: true } as any);
    return res.data;
  },

  deleteSession: async (sessionId: number): Promise<void> => {
    await apiClient.delete(`/echo-coach/sessions/${sessionId}`, { skipAuthRedirect: true } as any);
  },
};
