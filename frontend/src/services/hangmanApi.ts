import { apiClient } from '@/services/api-client';
import type { HangmanBootstrap, HangmanDifficulty, HangmanRound } from '@/types/hangman';

/** UUID request ids are part of the server idempotency contract. */
export const newHangmanRequestId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const hangmanApi = {
  bootstrap: () => apiClient.get<HangmanBootstrap>('/games/hangman/bootstrap').then(r => r.data),
  start: (difficulty: HangmanDifficulty, levelNumber?: number) =>
    apiClient.post<HangmanRound>('/games/hangman/rounds', { difficulty, levelNumber, requestId: newHangmanRequestId() }).then(r => r.data),
  get: (roundId: string) => apiClient.get<HangmanRound>(`/games/hangman/rounds/${roundId}`).then(r => r.data),
  guess: (round: HangmanRound, letter: string, requestId: string) =>
    apiClient.post<HangmanRound>(`/games/hangman/rounds/${round.roundId}/guesses`, { letter, requestId, expectedVersion: round.version }).then(r => r.data),
  hint: (round: HangmanRound, requestId: string) =>
    apiClient.post<HangmanRound>(`/games/hangman/rounds/${round.roundId}/hints`, { requestId, expectedVersion: round.version }).then(r => r.data),
  retry: (roundId: string) => apiClient.post<HangmanRound>(`/games/hangman/rounds/${roundId}/retry`, { requestId: newHangmanRequestId() }).then(r => r.data),
};
