import { useState, useRef, useCallback, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { examsApi } from '@/services/examsApi';
import { ResponseBatchItem } from '@/types/exams';
import { saveLocalResponse } from '@/lib/exams/recovery';
import { saveExamDraftDebounced, loadExamDraft } from '@/lib/exams/examDraftStorage';

export type SaveStatus = 'SAVED' | 'SAVING' | 'UNSAVED' | 'ERROR' | 'CLOSED';

/** Exams Phase 9: server codes that close an attempt for writes (terminal; see backend ExamDeadlinePolicy). */
export const CLOSED_WRITE_CODES = ['ATTEMPT_NOT_WRITABLE', 'ATTEMPT_DEADLINE_PASSED', 'SECTION_DEADLINE_PASSED'] as const;

export function isClosedWriteCode(code: unknown): boolean {
  return typeof code === 'string' && (CLOSED_WRITE_CODES as readonly string[]).includes(code);
}

export interface FlushReceipt {
  flushedCount: number;
  acknowledgedRevision: number;
  flushToken: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(id?: string): boolean {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

/**
 * Exams Phase 7: one pending batch entry per placement carries BOTH the latest answer and the latest review flag.
 * Before, a flag toggle replaced a still-pending answer of the same placement (and vice versa), so one of them never
 * reached the server. `incoming` wins for the fields it carries; fields it does not carry are kept.
 */
export function mergePendingItem(previous: ResponseBatchItem | undefined, incoming: ResponseBatchItem): ResponseBatchItem {
  if (!previous) return incoming;
  const merged: ResponseBatchItem = { ...previous };
  (Object.keys(incoming) as Array<keyof ResponseBatchItem>).forEach((k) => {
    if (incoming[k] !== undefined) (merged as any)[k] = incoming[k];
  });
  return merged;
}

/** True when a batch item carries answer content (a flag-only toggle carries none). */
export function carriesAnswer(item: ResponseBatchItem): boolean {
  return item.answerPayload !== undefined || item.textResponse !== undefined || item.recordingId !== undefined;
}

export function normalizeResponseValue(val: any): any {
  if (val === null || val === undefined) return undefined;
  if (typeof val !== 'object' || Array.isArray(val)) return val;

  // Handle SavedResponseDto from backend: { placementId, itemId, answerPayload, textResponse, ... }
  if ('answerPayload' in val || 'textResponse' in val) {
    if (val.textResponse !== null && val.textResponse !== undefined && val.textResponse !== '') {
      return val.textResponse;
    }
    if (val.answerPayload !== null && val.answerPayload !== undefined) {
      const p = val.answerPayload;
      if (typeof p === 'object' && !Array.isArray(p)) {
        if ('value' in p) return p.value;
        if ('choiceId' in p) return p.choiceId;
        if ('selectedChoices' in p) return p.selectedChoices;
        if ('choices' in p) return p.choices;
        if ('pairs' in p) return p.pairs;
      }
      return p;
    }
  }

  // Handle { value: ... } or { choiceId: ... }
  if ('value' in val && Object.keys(val).length === 1) return val.value;
  if ('choiceId' in val && Object.keys(val).length === 1) return val.choiceId;

  return val;
}

export function normalizeResponsesMap(raw?: Record<string, any>): Record<string, any> {
  if (!raw) return {};
  const normalized: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    normalized[k] = normalizeResponseValue(v);
  }
  return normalized;
}

export function useExamAutosave(
  attemptId: string,
  initialRevision: number = 0,
  initialResponses: Record<string, any> = {},
  options?: { examId?: string; userId?: string }
) {
  const { data: session } = useSession();
  const resolvedUserId = options?.userId || (session?.user as any)?.id || (session as any)?.user?.sub || 'anonymous';
  const resolvedExamId = options?.examId || attemptId;

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('SAVED');
  const [currentRevision, setCurrentRevision] = useState(initialRevision);
  const currentRevisionRef = useRef(initialRevision);
  const [lastSavedTime, setLastSavedTime] = useState<Date | null>(null);
  const [localResponses, setLocalResponses] = useState<Record<string, any>>(() =>
    normalizeResponsesMap(initialResponses)
  );
  const [pendingCount, setPendingCount] = useState<number>(0);
  /** Kind of the last failed save: network / server errors are retried automatically, a rejected batch is not. */
  const lastFailureRef = useRef<'NETWORK' | 'SERVER' | 'REJECTED' | 'CLOSED' | null>(null);
  const [flushToken, setFlushToken] = useState<string | null>(null);
  const flushTokenRef = useRef<string | null>(null);

  const updateRevision = useCallback((newRev: number) => {
    currentRevisionRef.current = newRev;
    setCurrentRevision(newRev);
  }, []);

  useEffect(() => {
    const draft = loadExamDraft(resolvedExamId, resolvedUserId, attemptId);
    const draftResponses = draft?.responses ? normalizeResponsesMap(draft.responses) : {};

    if (initialResponses && Object.keys(initialResponses).length > 0) {
      const normalized = normalizeResponsesMap(initialResponses);
      setLocalResponses((prev) => ({ ...draftResponses, ...normalized, ...prev }));
    } else if (Object.keys(draftResponses).length > 0) {
      setLocalResponses((prev) => ({ ...draftResponses, ...prev }));
    }
  }, [initialResponses, attemptId, resolvedExamId, resolvedUserId]);

  useEffect(() => {
    if (typeof initialRevision === 'number' && initialRevision > 0) {
      updateRevision(initialRevision);
    }
  }, [initialRevision, updateRevision]);

  const pendingBatchRef = useRef<Map<string, ResponseBatchItem>>(new Map());
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isFlushingRef = useRef(false);
  const inFlightFlushRef = useRef<Promise<FlushReceipt> | null>(null);

  // Authoritative flush returning a FlushReceipt with bounded timeout and guaranteed drain
  const flush = useCallback(async (): Promise<FlushReceipt> => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    // If a flush is already in flight, await it first
    if (inFlightFlushRef.current) {
      try {
        await inFlightFlushRef.current;
      } catch (_) {}
    }

    if (pendingBatchRef.current.size === 0) {
      setSaveStatus((prev) => (prev === 'SAVING' ? 'SAVED' : prev));
      const token = flushTokenRef.current || `flush_${currentRevisionRef.current}_${Date.now()}`;
      flushTokenRef.current = token;
      setFlushToken(token);
      return {
        flushedCount: 0,
        acknowledgedRevision: currentRevisionRef.current,
        flushToken: token,
      };
    }

    const flushExecution = (async () => {
      isFlushingRef.current = true;
      setSaveStatus('SAVING');

      let attemptCount = 0;
      const MAX_RETRIES = 3;

      try {
        while (attemptCount < MAX_RETRIES) {
          attemptCount++;
          const itemsToSave = Array.from(pendingBatchRef.current.values());
          if (itemsToSave.length === 0) {
            setSaveStatus('SAVED');
            const token = `flush_${currentRevisionRef.current}_${Date.now()}`;
            return {
              flushedCount: 0,
              acknowledgedRevision: currentRevisionRef.current,
              flushToken: token,
            };
          }

          const targetRev = currentRevisionRef.current;

          try {
            const receipt = await examsApi.saveResponses(attemptId, targetRev, itemsToSave);

            updateRevision(receipt.acknowledgedRevision);
            setLastSavedTime(new Date(receipt.serverTime));
            lastFailureRef.current = null;
            setSaveStatus('SAVED');

            for (const item of itemsToSave) {
              if (pendingBatchRef.current.get(item.placementId) === item) {
                pendingBatchRef.current.delete(item.placementId);
              }
            }
            setPendingCount(pendingBatchRef.current.size);

            const token = `flush_${receipt.acknowledgedRevision}_${Date.now()}`;
            flushTokenRef.current = token;
            setFlushToken(token);

            return {
              flushedCount: itemsToSave.length,
              acknowledgedRevision: receipt.acknowledgedRevision,
              flushToken: token,
            };
          } catch (err: any) {
            // Exams Phase 9: the server closed the attempt (deadline passed / submitted) — terminal, never retried. The
            // answers stay in the local recovery copy; nothing is re-sent.
            if (isClosedWriteCode(err?.response?.data?.code)) {
              console.warn('Autosave refused: attempt closed by the server', err?.response?.data?.code);
              lastFailureRef.current = 'CLOSED';
              pendingBatchRef.current.clear();
              setPendingCount(0);
              setSaveStatus('CLOSED');
              throw err;
            }
            const is409 = err?.response?.data?.code === 'ATTEMPT_REVISION_CONFLICT'
              || (err?.response?.status === 409 && !err?.response?.data?.code);
            const isPlacementNotCurrent =
              err?.response?.data?.message?.includes('PLACEMENT_NOT_CURRENT') ||
              err?.response?.data?.code === 'PLACEMENT_NOT_CURRENT';

            if (isPlacementNotCurrent) {
              console.warn('Dropping answers for inactive placements:', err?.response?.data);
              for (const item of itemsToSave) {
                pendingBatchRef.current.delete(item.placementId);
              }
              setPendingCount(pendingBatchRef.current.size);
              setSaveStatus('SAVED');
              return {
                flushedCount: 0,
                acknowledgedRevision: currentRevisionRef.current,
                flushToken: `flush_${currentRevisionRef.current}_${Date.now()}`,
              };
            }

            if (is409) {
              console.info(`Autosave revision conflict (client: ${targetRev}). Reconciling with server...`);
              const serverRev = err?.response?.data?.currentRevision;
              if (typeof serverRev === 'number' && serverRev > currentRevisionRef.current) {
                updateRevision(serverRev);
              }
              try {
                const freshState = await examsApi.getAttemptState(attemptId);
                if (freshState && typeof freshState.revision === 'number') {
                  updateRevision(freshState.revision);
                  if (freshState.responses) {
                    setLocalResponses((prev) => ({ ...normalizeResponsesMap(freshState.responses), ...prev }));
                  }
                }
              } catch (syncErr) {
                console.warn('Failed to resynchronize attempt state after revision conflict', syncErr);
              }
              // Retry with updated revision in next iteration
              continue;
            }

            console.warn('Exam autosave to server failed; buffered locally', err);
            const isTrueNetworkOffline =
              (typeof navigator !== 'undefined' && !navigator.onLine) ||
              err?.code === 'ERR_NETWORK' ||
              err?.code === 'ECONNABORTED' ||
              !err?.response;

            // Exams Phase 7: every failure is shown as ERROR (never left as a silent "not saved"); network and
            // server errors retry automatically, a rejected batch waits for the learner's "Thử lại".
            if (isTrueNetworkOffline) {
              lastFailureRef.current = 'NETWORK';
            } else if (err?.response?.status >= 500) {
              console.error('Server error during autosave, retrying locally:', err?.response?.data);
              lastFailureRef.current = 'SERVER';
            } else {
              lastFailureRef.current = 'REJECTED';
            }
            setSaveStatus('ERROR');
            throw err;
          }
        }

        // If loop exhausted without return
        setSaveStatus(pendingBatchRef.current.size === 0 ? 'SAVED' : 'UNSAVED');
        return {
          flushedCount: 0,
          acknowledgedRevision: currentRevisionRef.current,
          flushToken: `flush_${currentRevisionRef.current}_${Date.now()}`,
        };
      } finally {
        isFlushingRef.current = false;
        inFlightFlushRef.current = null;
        setSaveStatus((prev) => {
          if (prev === 'SAVING') {
            return pendingBatchRef.current.size === 0 ? 'SAVED' : 'UNSAVED';
          }
          return prev;
        });
      }
    })();

    // Bounded timeout: flush must not block for more than 10,000ms
    const boundedFlushPromise = Promise.race([
      flushExecution,
      new Promise<FlushReceipt>((_, reject) =>
        setTimeout(() => {
          isFlushingRef.current = false;
          inFlightFlushRef.current = null;
          setSaveStatus((prev) => (prev === 'SAVING' ? 'UNSAVED' : prev));
          reject(new Error('AUTOSAVE_FLUSH_TIMEOUT: Autosave flush timed out after 10000ms'));
        }, 10000)
      ),
    ]);

    inFlightFlushRef.current = boundedFlushPromise;
    return boundedFlushPromise;
  }, [attemptId, updateRevision]);

  // Non-throwing batch flush for debouncer and lifecycle events
  const flushBatch = useCallback(() => {
    flush().catch(() => {});
  }, [flush]);

  // Queue an answer change
  const queueAnswer = useCallback(
    (placementId: string, payload: any, itemId?: string, debounceMs: number = 800) => {
      setLocalResponses((prev) => ({ ...prev, [placementId]: payload }));
      setSaveStatus('UNSAVED');

      const resolvedItemId = itemId && isValidUuid(itemId) ? itemId : undefined;
      const batchItem: ResponseBatchItem = {
        placementId,
        itemId: resolvedItemId,
        answerPayload: typeof payload === 'object' ? payload : { value: payload },
        textResponse: typeof payload === 'string' ? payload : undefined,
      };

      pendingBatchRef.current.set(placementId, mergePendingItem(pendingBatchRef.current.get(placementId), batchItem));
      setPendingCount(pendingBatchRef.current.size);

      // Also persist to IndexedDB immediately for instant crash/refresh recovery
      saveLocalResponse(attemptId, placementId, payload, currentRevision);

      // Persist to localStorage draft under exam_draft_{examId}_{userId} with 500ms debounce
      saveExamDraftDebounced(
        resolvedExamId,
        resolvedUserId,
        { responses: { [placementId]: payload } },
        attemptId
      );

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        flushBatch();
      }, debounceMs);
    },
    [attemptId, currentRevision, flushBatch, resolvedExamId, resolvedUserId]
  );

  // Flush before unmount or tab switch
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (pendingBatchRef.current.size > 0) {
        flushBatch();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [flushBatch]);

  // Automatic retry on failure when items remain in pending queue
  useEffect(() => {
    if (saveStatus === 'ERROR' && pendingBatchRef.current.size > 0 && lastFailureRef.current !== 'REJECTED'
      && lastFailureRef.current !== 'CLOSED') {
      const retryTimer = setTimeout(() => {
        flushBatch();
      }, 3000);
      return () => clearTimeout(retryTimer);
    }
  }, [saveStatus, flushBatch]);

  // Queue a batch of answers
  const saveBatch = useCallback(
    (items: ResponseBatchItem[]) => {
      setLocalResponses((prev) => {
        const next = { ...prev };
        items.forEach((item) => {
          const val = item.textResponse ?? item.answerPayload?.value ?? item.answerPayload;
          if (val !== undefined) {
            next[item.placementId] = val;
          }
        });
        return next;
      });

      items.forEach((item) => {
        const cleanedItem: ResponseBatchItem = {
          ...item,
          itemId: item.itemId && isValidUuid(item.itemId) ? item.itemId : undefined,
        };
        pendingBatchRef.current.set(item.placementId, mergePendingItem(pendingBatchRef.current.get(item.placementId), cleanedItem));
        // A flag-only toggle must never overwrite the locally recovered answer with an empty payload.
        if (carriesAnswer(item)) {
          const payload =
            item.answerPayload ||
            item.textResponse ||
            (item.recordingId ? { recordingId: item.recordingId } : {});
          saveLocalResponse(attemptId, item.placementId, payload, currentRevision);
        }
      });
      setPendingCount(pendingBatchRef.current.size);
      setSaveStatus('UNSAVED');
      flushBatch();
    },
    [attemptId, currentRevision, flushBatch]
  );

  return {
    saveStatus,
    currentRevision,
    lastAcknowledgedRevision: currentRevision,
    pendingCount,
    flushToken,
    lastSavedTime,
    localResponses,
    setLocalResponses,
    queueAnswer,
    saveBatch,
    flushBatch,
    flush,
    /** Exams Phase 7: explicit "Thử lại" after a failed save. */
    retry: flushBatch,
  };
}
