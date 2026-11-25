export type WordSense = { pos: string; meaning: string };
export type WordMetadata = {
  normalizedWord: string; displayWord: string; ipa: string | null; partOfSpeech: string | null; meaningVi: string | null;
  cefr: string | null; senses?: WordSense[];
};
export type ChainMove = { moveId: number; playerId: number; word: WordMetadata; acceptedAt: number };
export type ChainPlayer = {
  id: number; name: string; avatarUrl?: string | null; bot?: boolean; score: number; words?: number;
  ready: boolean; rematch: boolean; connected: boolean;
};
export type BotLevel = 'EASY' | 'MEDIUM' | 'HARD';
export type ChainState = {
  roomCode: string; matchId: string; mode: 'SOLO' | 'BOT' | 'PRIVATE' | 'QUICK'; difficulty: string; botLevel?: BotLevel | null;
  status: 'WAITING' | 'ACTIVE' | 'FINISHED'; revision: number; youId: number; turnPlayerId: number | null;
  currentWord: WordMetadata | null; requiredLetter: string | null; startLetter?: string | null; serverTimestamp: number; deadline: number;
  turnStartedAt?: number; turnSeconds?: number;
  winnerId: number | null; endReason: string | null; resultSaved: boolean; chainLength: number;
  acceptedCount: number; rejectedCount: number; averageResponseMs: number | null; moves: ChainMove[];
  players: ChainPlayer[];
};
export type HistoryRow = { matchId: string; mode: string; acceptedCount: number; finishedAt: string };
