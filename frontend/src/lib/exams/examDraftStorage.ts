/**
 * Exam Draft LocalStorage Persistence & Drift Recovery
 *
 * Persists every answer selection, text input change, and countdown timer tick to localStorage with a 500ms
 * debounce. Restores exact draft answers and timer state on refresh / network disconnect. Cleans up draft only after
 * authoritative HTTP 200 exam submission.
 *
 * Exams Phase 6: drafts are ATTEMPT-scoped (`exam_draft_{attemptId}_{userId}`). A form can have many attempts (Practice
 * Again, a new simulation), so a form-keyed draft would leak the answers of an older attempt into a new one. The legacy
 * form-keyed slot (`exam_draft_{examId}_{userId}`) is never written any more; it is read back only when its stored
 * `attemptId` equals the requested attempt, and is otherwise ignored.
 */

export interface ExamDraftData {
  examId: string;
  attemptId: string;
  userId: string;
  responses: Record<string, any>;
  remainingSeconds: number;
  activeSectionId?: string | null;
  savedAt: number;
}

const DEBOUNCE_DELAY_MS = 500;
const debounceTimers: Record<string, NodeJS.Timeout> = {};

function safeUserId(userId: string): string {
  return userId || 'anonymous';
}

/** Keys this module WRITES for a draft: the attempt slot (or the form slot only when no attempt is known). */
export function getExamDraftKeys(examId: string, userId: string, attemptId?: string): string[] {
  const user = safeUserId(userId);
  return attemptId ? [`exam_draft_${attemptId}_${user}`] : [`exam_draft_${examId}_${user}`];
}

function legacyFormKey(examId: string, userId: string): string {
  return `exam_draft_${examId}_${safeUserId(userId)}`;
}

function parseDraft(raw: string | null, key: string): ExamDraftData | null {
  if (!raw) return null;
  try {
    const parsed: ExamDraftData = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    console.warn(`[ExamDraft] Corrupt draft in ${key}:`, err);
    return null;
  }
}

/** Pure guard (exported for the contract test): a draft is usable only by the attempt that wrote it. */
export function draftBelongsToAttempt(draft: ExamDraftData | null, attemptId?: string): boolean {
  if (!draft) return false;
  if (!attemptId) return true;
  return draft.attemptId === attemptId;
}

function writeDraft(examId: string, userId: string, draftUpdates: Partial<ExamDraftData>, attemptId?: string) {
  const existing = loadExamDraft(examId, userId, attemptId);
  const merged: ExamDraftData = {
    examId,
    attemptId: attemptId || existing?.attemptId || examId,
    userId: safeUserId(userId),
    responses: { ...(existing?.responses || {}), ...(draftUpdates.responses || {}) },
    remainingSeconds:
      typeof draftUpdates.remainingSeconds === 'number'
        ? draftUpdates.remainingSeconds
        : (existing?.remainingSeconds ?? 0),
    activeSectionId:
      draftUpdates.activeSectionId !== undefined ? draftUpdates.activeSectionId : existing?.activeSectionId,
    savedAt: Date.now(),
  };
  const serialized = JSON.stringify(merged);
  for (const k of getExamDraftKeys(examId, userId, attemptId)) {
    localStorage.setItem(k, serialized);
  }
}

export function saveExamDraftDebounced(
  examId: string,
  userId: string,
  draftUpdates: Partial<ExamDraftData>,
  attemptId?: string
) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const primaryKey = getExamDraftKeys(examId, userId, attemptId)[0];

  if (debounceTimers[primaryKey]) {
    clearTimeout(debounceTimers[primaryKey]);
  }

  debounceTimers[primaryKey] = setTimeout(() => {
    try {
      writeDraft(examId, userId, draftUpdates, attemptId);
    } catch (err) {
      console.warn('[ExamDraft] Failed to write draft to localStorage:', err);
    }
  }, DEBOUNCE_DELAY_MS);
}

export function saveExamDraftImmediate(
  examId: string,
  userId: string,
  draftUpdates: Partial<ExamDraftData>,
  attemptId?: string
) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const primaryKey = getExamDraftKeys(examId, userId, attemptId)[0];

  if (debounceTimers[primaryKey]) {
    clearTimeout(debounceTimers[primaryKey]);
    delete debounceTimers[primaryKey];
  }

  try {
    writeDraft(examId, userId, draftUpdates, attemptId);
  } catch (err) {
    console.warn('[ExamDraft] Failed to write draft immediately to localStorage:', err);
  }
}

export function loadExamDraft(
  examId: string,
  userId: string,
  attemptId?: string
): ExamDraftData | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  for (const k of getExamDraftKeys(examId, userId, attemptId)) {
    const draft = parseDraft(localStorage.getItem(k), k);
    if (draftBelongsToAttempt(draft, attemptId)) return draft;
  }
  // Legacy form-keyed slot: accepted only when it was written by this very attempt.
  if (attemptId && examId && examId !== attemptId) {
    const key = legacyFormKey(examId, userId);
    const legacy = parseDraft(localStorage.getItem(key), key);
    if (draftBelongsToAttempt(legacy, attemptId)) return legacy;
  }
  return null;
}

export function clearExamDraft(
  examId: string,
  userId: string,
  attemptId?: string
) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  for (const k of getExamDraftKeys(examId, userId, attemptId)) {
    if (debounceTimers[k]) {
      clearTimeout(debounceTimers[k]);
      delete debounceTimers[k];
    }
    localStorage.removeItem(k);
  }
  if (attemptId && examId && examId !== attemptId) {
    const key = legacyFormKey(examId, userId);
    if (draftBelongsToAttempt(parseDraft(localStorage.getItem(key), key), attemptId)) {
      localStorage.removeItem(key);
    }
  }
}
