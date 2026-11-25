import { apiClient } from '@/services/api-client';
import type { WorldApi, WorldRecord, WorldState } from './save';

/**
 * Echo Life — `/api/v1/echo-life/world` (V129). The server scopes it to the signed-in learner; nothing here names a user.
 * A stale write rejects with `{ status: 409, current }` so `WorldSaver` can merge; any other failure keeps its HTTP status.
 */
export const echoLifeApi: WorldApi = {
  get: () => apiClient.get<WorldRecord>('/echo-life/world').then(r => r.data),
  put: (state: WorldState, revision: number) => apiClient.put<WorldRecord>('/echo-life/world', { state, revision }).then(r => r.data)
    .catch((e: { response?: { status?: number; data?: { current?: WorldRecord } } }) => {
      throw { status: e.response?.status ?? 0, current: e.response?.data?.current };
    }),
};
