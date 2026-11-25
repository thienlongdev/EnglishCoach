/**
 * Bounded local recovery buffer for Writing Coach working copies.
 * 
 * Safety rules:
 * - Scoped by confirmed userId and sessionId
 * - Max size bounded (100KB) to prevent storage quota exhaustion
 * - Stored in sessionStorage so it survives same-tab refresh but doesn't leak cross-session
 * - Never replays submissions or assessment requests
 */

export interface WritingRecoveryBuffer {
  userId: number;
  sessionId: string;
  workingText: string;
  workingPlan: string;
  baseServerRevision: number;
  localSequenceNumber: number;
  savedAt: number; // timestamp
}

const STORAGE_PREFIX = 'ec_writing_recovery_';
const MAX_BUFFER_BYTES = 102400; // 100 KB

function getStorageKey(userId: number, sessionId: string): string {
  return `${STORAGE_PREFIX}${userId}_${sessionId}`;
}

export function saveLocalRecoveryBuffer(
  userId: number,
  sessionId: string,
  workingText: string,
  workingPlan: string,
  baseServerRevision: number,
  localSequenceNumber: number
): boolean {
  if (typeof window === 'undefined' || !window.sessionStorage) return false;

  try {
    const buffer: WritingRecoveryBuffer = {
      userId,
      sessionId,
      workingText,
      workingPlan,
      baseServerRevision,
      localSequenceNumber,
      savedAt: Date.now()
    };

    const serialized = JSON.stringify(buffer);
    if (serialized.length > MAX_BUFFER_BYTES) {
      console.warn('[WritingRecovery] Working copy exceeds buffer capacity limit, skipping local recovery snapshot');
      return false;
    }

    window.sessionStorage.setItem(getStorageKey(userId, sessionId), serialized);
    return true;
  } catch (err) {
    console.error('[WritingRecovery] Failed to write recovery buffer to sessionStorage:', err);
    return false;
  }
}

export function loadLocalRecoveryBuffer(userId: number, sessionId: string): WritingRecoveryBuffer | null {
  if (typeof window === 'undefined' || !window.sessionStorage) return null;

  try {
    const item = window.sessionStorage.getItem(getStorageKey(userId, sessionId));
    if (!item) return null;

    const parsed: WritingRecoveryBuffer = JSON.parse(item);
    if (parsed.userId !== userId || parsed.sessionId !== sessionId) {
      // Identity mismatch guard
      return null;
    }
    return parsed;
  } catch (err) {
    console.error('[WritingRecovery] Failed to read recovery buffer:', err);
    return null;
  }
}

export function clearLocalRecoveryBuffer(userId: number, sessionId: string): void {
  if (typeof window === 'undefined' || !window.sessionStorage) return;

  try {
    window.sessionStorage.removeItem(getStorageKey(userId, sessionId));
  } catch (err) {
    console.error('[WritingRecovery] Failed to clear recovery buffer:', err);
  }
}
