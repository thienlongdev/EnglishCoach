import { apiClient } from './api-client';
import {
  CreateFeedbackPayload,
  FeedbackMessage,
  FeedbackMessagePayload,
  FeedbackThread,
  FeedbackUnreadCount,
} from '@/types/feedback';

export const feedbackApi = {
  // Regular User
  createFeedback: async (payload: CreateFeedbackPayload): Promise<FeedbackThread> => {
    const res = await apiClient.post<FeedbackThread>('/feedback', payload);
    return res.data;
  },

  getMyFeedbacks: async (): Promise<FeedbackThread[]> => {
    const res = await apiClient.get<FeedbackThread[]>('/feedback/mine');
    return res.data;
  },

  getMyUnreadCount: async (): Promise<FeedbackUnreadCount> => {
    const res = await apiClient.get<FeedbackUnreadCount>('/feedback/mine/unread-count');
    return res.data;
  },

  userFollowUp: async (
    id: number,
    payload: FeedbackMessagePayload
  ): Promise<FeedbackMessage> => {
    const res = await apiClient.post<FeedbackMessage>(`/feedback/${id}/follow-up`, payload);
    return res.data;
  },

  // Admin
  getAdminInbox: async (): Promise<FeedbackThread[]> => {
    const res = await apiClient.get<FeedbackThread[]>('/feedback/admin/inbox');
    return res.data;
  },

  getAdminUnreadCount: async (): Promise<FeedbackUnreadCount> => {
    const res = await apiClient.get<FeedbackUnreadCount>('/feedback/admin/unread-count');
    return res.data;
  },

  adminReply: async (
    id: number,
    payload: FeedbackMessagePayload
  ): Promise<FeedbackMessage> => {
    const res = await apiClient.post<FeedbackMessage>(`/feedback/admin/${id}/reply`, payload);
    return res.data;
  },

  closeThread: async (id: number): Promise<FeedbackThread> => {
    const res = await apiClient.patch<FeedbackThread>(`/feedback/admin/${id}/close`);
    return res.data;
  },

  // Shared
  getThreadMessages: async (id: number): Promise<FeedbackMessage[]> => {
    const res = await apiClient.get<FeedbackMessage[]>(`/feedback/${id}/messages`);
    return res.data;
  },
};
