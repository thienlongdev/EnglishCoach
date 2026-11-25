import { apiClient } from './api-client';
import type { Overlay } from '@/lib/cosmos/types';

/** Echo Neural Cosmos. Reads of the learner's own evidence; no AI, no write of learning data. */
export const cosmosApi = {
  overlay: async (signal?: AbortSignal): Promise<Overlay> => (await apiClient.get<Overlay>('/cosmos/overlay', { signal })).data,
  /** Sentences of the caller's own visible sources where a concept's forms occur (deterministic, owner-scoped, no AI). */
  passages: async (body: { refs: string[]; groups: string[][]; limit?: number }): Promise<{ passages: { kind: string; id: number; title: string; at: number; system: boolean;
    segmentId: number; startMs: number | null; index: number; text: string; spans: number[][] }[]; more: boolean }> =>
    (await apiClient.post('/cosmos/passages', body)).data,
};
