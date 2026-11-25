import { apiClient } from './api-client';

export interface UserProfileDto {
  email: string;
  accountName: string;
  displayName: string;
  phone: string | null;
  city: string | null;
  province: string | null;
  dateOfBirth: string | null;
  accountCreatedAt: string | null;
  avatarPresent: boolean;
  avatarUpdatedAt: string | null;
  authMethods: string[];
  canChangePassword: boolean;
  heatmapTheme?: string | null;
}

export interface UpdateUserProfileRequest {
  displayName?: string;
  phone?: string;
  city?: string;
  province?: string;
  dateOfBirth?: string | null;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export const userProfileApi = {
  getProfile: async (): Promise<UserProfileDto> => {
    const res = await apiClient.get<UserProfileDto>('/users/me/profile');
    return res.data;
  },

  updateProfile: async (payload: UpdateUserProfileRequest): Promise<UserProfileDto> => {
    const res = await apiClient.put<UserProfileDto>('/users/me/profile', payload);
    return res.data;
  },

  uploadAvatar: async (file: File): Promise<UserProfileDto> => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await apiClient.post<UserProfileDto>('/users/me/avatar', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return res.data;
  },

  deleteAvatar: async (): Promise<void> => {
    await apiClient.delete('/users/me/avatar');
  },

  getAvatarBlob: async (): Promise<Blob> => {
    const res = await apiClient.get('/users/me/avatar', {
      responseType: 'blob',
    });
    return res.data;
  },

  changePassword: async (payload: ChangePasswordRequest): Promise<void> => {
    await apiClient.post('/auth/change-password', payload);
  },

  updateHeatmapTheme: async (theme: string): Promise<UserProfileDto> => {
    const res = await apiClient.patch<UserProfileDto>('/users/me/profile/heatmap-theme', { theme });
    return res.data;
  },
};
