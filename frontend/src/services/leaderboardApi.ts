import { apiClient } from './api-client';
import type {
  ActivityBoardResponse,
  ActivityGroup,
  ActivityMeResponse,
  ActivityPeriod,
  ActivityScope,
  Division,
  ProficiencyBoard,
  ProficiencyBoardMeResponse,
  ProficiencyBoardResponse,
  PlacementActiveResponse,
  PlacementMeResponse,
  PlacementSaveResponse,
  PlacementStartResponse,
  PlacementSubmitResponse,
  ProficiencyMeResponse,
  ProficiencyOthersResponse,
  UnrankedResponse,
} from '@/types/leaderboard';

/** Read-only board API (Leaderboard Phase 3) + the caller's proficiency card. No AI calls. */
export const leaderboardApi = {
  getActivityBoard: async (period: ActivityPeriod, scope: ActivityScope, group: ActivityGroup, limit = 20) => {
    const res = await apiClient.get<ActivityBoardResponse>('/leaderboard/activity', {
      params: { period, scope, group, limit },
    });
    return res.data;
  },

  /** "Chưa ghi điểm kỳ này": learners not ranked in the partition, cursor = last userId. */
  getActivityUnranked: async (period: ActivityPeriod, scope: ActivityScope, group: ActivityGroup, cursor: number | null, limit = 30) => {
    const res = await apiClient.get<UnrankedResponse>('/leaderboard/activity/unranked', {
      params: { period, scope, group, limit, ...(cursor != null ? { cursor } : {}) },
    });
    return res.data;
  },

  /** scope omitted ⇒ the backend uses the caller's division (else GLOBAL) and returns it as defaultScope. */
  getActivityMe: async (period: ActivityPeriod, scope: ActivityScope | null, group: ActivityGroup) => {
    const res = await apiClient.get<ActivityMeResponse>('/leaderboard/activity/me', {
      params: { period, group, ...(scope ? { scope } : {}) },
    });
    return res.data;
  },

  /** division omitted ⇒ the caller's own division on that board, else TRUNG_CAP. */
  getProficiencyBoard: async (board: ProficiencyBoard, division: Division | null, limit = 20) => {
    const res = await apiClient.get<ProficiencyBoardResponse>('/leaderboard/proficiency', {
      params: { board, limit, ...(division ? { division } : {}) },
    });
    return res.data;
  },

  /** Năng lực: "Đang xác thực" + "Theo bài xếp lớp" groups (no rank) and the undetermined count. */
  getProficiencyOthers: async (board: ProficiencyBoard, division: Division) => {
    const res = await apiClient.get<ProficiencyOthersResponse>('/leaderboard/proficiency/others', { params: { board, division } });
    return res.data;
  },

  getProficiencyBoardMe: async (board: ProficiencyBoard) => {
    const res = await apiClient.get<ProficiencyBoardMeResponse>('/leaderboard/proficiency/me', { params: { board } });
    return res.data;
  },

  getProficiencyMe: async () => {
    const res = await apiClient.get<ProficiencyMeResponse>('/proficiency/me');
    return res.data;
  },

  setProficiencyVisibility: async (showOnProficiencyBoard: boolean) => {
    const res = await apiClient.patch<{ showOnProficiencyBoard: boolean }>('/proficiency/me/visibility', {
      showOnProficiencyBoard,
    });
    return res.data;
  },

  // "Bài xếp lớp nhanh": the server issues and scores the questions; the client only sends the chosen option index
  // per question (null = "Tôi chưa biết").
  getPlacementMe: async () => {
    const res = await apiClient.get<PlacementMeResponse>('/proficiency/placement/me');
    return res.data;
  },

  /** `replace` = "Làm lại từ đầu" (abandons the unfinished attempt); without it an unfinished attempt ⇒ 409 ACTIVE_ATTEMPT. */
  startPlacement: async (replace = false) => {
    const res = await apiClient.post<PlacementStartResponse>('/proficiency/placement/start', null,
      replace ? { params: { replace: true } } : undefined);
    return res.data;
  },

  /** Unfinished attempt (same questions, saved answers) or null (204). */
  getPlacementActive: async (): Promise<PlacementActiveResponse | null> => {
    const res = await apiClient.get<PlacementActiveResponse>('/proficiency/placement/active');
    return res.status === 204 || !res.data ? null : res.data;
  },

  /** Autosave of the answers given so far (prefix; null = "Tôi chưa biết"). */
  savePlacementProgress: async (attemptId: string, answers: (number | null)[]) => {
    const res = await apiClient.put<PlacementSaveResponse>(`/proficiency/placement/${attemptId}/progress`, { answers });
    return res.data;
  },

  /** Explicit discard of an unfinished attempt ("Làm lại từ đầu" confirmed). */
  abandonPlacement: async (attemptId: string) => {
    await apiClient.post(`/proficiency/placement/${attemptId}/abandon`);
  },

  submitPlacement: async (attemptId: string, answers: (number | null)[]) => {
    const res = await apiClient.post<PlacementSubmitResponse>(`/proficiency/placement/${attemptId}/submit`, { answers });
    return res.data;
  },
};
