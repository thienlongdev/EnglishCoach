import { apiClient } from './api-client';
import { AvatarFrameDto } from '@/types/avatarFrame';

export const avatarFrameApi = {
  /**
   * Fetches the complete avatar frame catalogue with user-specific ownership state and real server progress.
   */
  getCatalogue: async (): Promise<AvatarFrameDto[]> => {
    const res = await apiClient.get<AvatarFrameDto[]>('/frames/catalogue');
    return res.data;
  },

  /**
   * Fetches the user's inventory of owned frames.
   */
  getInventory: async (): Promise<AvatarFrameDto[]> => {
    const res = await apiClient.get<AvatarFrameDto[]>('/frames/inventory');
    return res.data;
  },

  /**
   * Fetches details and progress for a single frame by slug.
   */
  getFrameBySlug: async (slug: string): Promise<AvatarFrameDto> => {
    const res = await apiClient.get<AvatarFrameDto>(`/frames/${slug}`);
    return res.data;
  },

  /**
   * Authoritatively equips an owned, non-expired frame by slug.
   */
  equipFrame: async (slug: string): Promise<AvatarFrameDto> => {
    const res = await apiClient.post<AvatarFrameDto>(`/frames/${slug}/equip`);
    return res.data;
  },

  /**
   * Authoritatively unequips the user's equipped frame (idempotent).
   */
  unequipFrame: async (): Promise<void> => {
    await apiClient.post('/frames/unequip');
  },

  /**
   * Explicitly triggers eligibility reconciliation and auto-unlock.
   */
  reconcile: async (): Promise<AvatarFrameDto[]> => {
    const res = await apiClient.post<AvatarFrameDto[]>('/frames/reconcile');
    return res.data;
  },
};
