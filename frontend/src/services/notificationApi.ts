import { apiClient } from './api-client';
import {
  AdminCreateNotificationRequest,
  AdminNotification,
  LearnerNotification,
  UnreadCountResponse,
} from '@/types/notification';

export const notificationApi = {
  getNotifications: async (limit?: number): Promise<LearnerNotification[]> => {
    const res = await apiClient.get<LearnerNotification[]>('/notifications', {
      params: limit ? { limit } : undefined,
    });
    return res.data;
  },

  getUnreadCount: async (): Promise<UnreadCountResponse> => {
    const res = await apiClient.get<UnreadCountResponse>('/notifications/unread-count');
    return res.data;
  },

  markAsRead: async (id: number): Promise<void> => {
    await apiClient.post(`/notifications/${id}/read`);
  },

  markAllAsRead: async (): Promise<void> => {
    await apiClient.post('/notifications/read-all');
  },

  dismissNotification: async (id: number): Promise<void> => {
    await apiClient.post(`/notifications/${id}/dismiss`);
  },

  getAdminNotifications: async (page = 0, size = 50): Promise<AdminNotification[]> => {
    const res = await apiClient.get<AdminNotification[]>('/admin/notifications', {
      params: { page, size },
    });
    return res.data;
  },

  createAdminNotification: async (
    payload: AdminCreateNotificationRequest
  ): Promise<AdminNotification> => {
    const res = await apiClient.post<AdminNotification>('/admin/notifications', payload);
    return res.data;
  },
};
