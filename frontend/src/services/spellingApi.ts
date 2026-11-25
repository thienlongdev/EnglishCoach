import { apiClient } from './api-client';
import type { SpellingConfig,SpellingRecords,SpellingDifficulty } from '@/types/spelling';
export const spellingApi={
  config:async()=>(await apiClient.get<SpellingConfig>('/spelling/config')).data,
  records:async()=>(await apiClient.get<SpellingRecords>('/spelling/records')).data,
  leaderboard:async(difficulty:SpellingDifficulty)=>(await apiClient.get<{user_id:number;name:string;wins:number;correct:number;score:number;wpm:number}[]>('/spelling/leaderboard',{params:{difficulty}})).data,
};

