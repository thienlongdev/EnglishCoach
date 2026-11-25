import { apiClient } from './api-client';

export interface UnifiedStreakDto {
  currentStreakDays: number;
  longestStreakDays: number;
  activeToday: boolean;
}

export interface HeatmapDayDto {
  date: string; // YYYY-MM-DD
  activityCount: number;
  intensity: number; // 0..4
}

export interface HeatmapResponseDto {
  currentStreakDays: number;
  longestStreakDays: number;
  activeDaysThisYear: number;
  activitiesThisMonth: number;
  theme: string;
  days: HeatmapDayDto[];
}

export const progressApi = {
  getStreak: async (): Promise<UnifiedStreakDto> => {
    const res = await apiClient.get<UnifiedStreakDto>('/progress/streak');
    return res.data;
  },

  getHeatmap: async (days?: number): Promise<HeatmapResponseDto> => {
    const params = days ? { days } : undefined;
    const res = await apiClient.get<HeatmapResponseDto>('/progress/heatmap', { params });
    return res.data;
  },
};
