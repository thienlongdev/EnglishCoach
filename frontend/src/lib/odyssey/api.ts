import { apiClient } from '@/services/api-client';
import type { World, RegionDetail, Exploration, Navigation, LaunchMode, LaunchView, Reward, ViewMode } from './types';
const BASE = '/learning-path/odyssey';
export const odysseyApi = {
  world: async () => (await apiClient.post<World>(`${BASE}/world`)).data,
  region: async (id: string) => (await apiClient.get<RegionDetail>(`${BASE}/regions/${encodeURIComponent(id)}`)).data,
  discover: async (regionId: string, activateBeacon = false) => (await apiClient.post<Exploration[]>(`${BASE}/discover`, { regionId, activateBeacon })).data,
  navigate: async (regionId: string, stationId: string | null, viewMode: ViewMode) => (await apiClient.put<Navigation>(`${BASE}/navigation`, { regionId, stationId, viewMode })).data,
  preferences: async (input: Pick<Navigation, 'targetDate' | 'weeklyMinutes' | 'examVariant'>) => (await apiClient.put<Navigation>(`${BASE}/preferences`, input)).data,
  launch: async (requestId: string, stationId: string, mode: LaunchMode) => (await apiClient.post<LaunchView>(`${BASE}/launch`, { requestId, stationId, mode })).data,
  active: async () => (await apiClient.get<LaunchView | null>(`${BASE}/active`)).data,
  launchById: async (id: string) => (await apiClient.get<LaunchView>(`${BASE}/launches/${encodeURIComponent(id)}`)).data,
  journal: async (offset: number) => (await apiClient.get<Reward[]>(`${BASE}/journal`, { params: { offset } })).data,
};
