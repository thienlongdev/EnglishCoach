import { apiClient } from './api-client';
import type { ArenaConfig, ArenaTicket } from '@/types/speakingArena';

export const getArenaConfig = (signal?: AbortSignal) => apiClient.get<ArenaConfig>('/speaking/arena/config', { signal }).then(r => r.data);
export const getArenaVoice = (roomId: string, signal?: AbortSignal) => apiClient.post<ArenaTicket>('/speaking/arena/voice', { roomId }, { signal }).then(r => r.data);
