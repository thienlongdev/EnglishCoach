import { useState, useEffect, useCallback, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { examsApi } from '@/services/examsApi';
import {
  AttemptStateDto,
  PublicManifestDto,
  PublicSectionDto,
  ExamAttemptStatus,
} from '@/types/exams';
import { getLocalResponses } from '@/lib/exams/recovery';
import {
  saveExamDraftDebounced,
  loadExamDraft,
  clearExamDraft,
} from '@/lib/exams/examDraftStorage';

export function useExamAttempt(
  attemptId: string,
  options?: {
    onSectionTimeout?: (sectionId: string) => Promise<void>;
    examId?: string;
    userId?: string;
  }
) {
  const { data: session } = useSession();
  const resolvedUserId = options?.userId || (session?.user as any)?.id || (session as any)?.user?.sub || 'anonymous';

  const [attemptState, setAttemptState] = useState<AttemptStateDto | null>(null);
  const [manifest, setManifest] = useState<PublicManifestDto | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const serverClockOffsetRef = useRef<number>(0);
  const onTimeoutRef = useRef(options?.onSectionTimeout);
  useEffect(() => {
    onTimeoutRef.current = options?.onSectionTimeout;
  }, [options?.onSectionTimeout]);

  // 1. Initial load of attempt and manifest
  const refreshState = useCallback(async () => {
    try {
      const [state, mf] = await Promise.all([
        examsApi.getAttemptState(attemptId),
        examsApi.getManifest(attemptId),
      ]);

      const clientNow = Date.now();
      const serverNow = new Date(state.serverTime).getTime();
      serverClockOffsetRef.current = serverNow - clientNow;

      setAttemptState(state);
      setManifest(mf);

      if (state.status === 'SUBMITTED' || state.status === 'EXPIRED') {
        setSubmitted(true);
      }

      // Default active section
      if (!activeSectionId && state.sections && state.sections.length > 0) {
        const active = state.sections.find((s) => s.state === 'ACTIVE');
        if (active) {
          setActiveSectionId(active.sectionId);
        } else {
          const completed = state.sections.filter((s) => s.state === 'COMPLETED');
          const target = completed.length > 0 ? completed[completed.length - 1] : state.sections[0];
          setActiveSectionId(target.sectionId);
        }
      }

      // Merge local recovery responses if server responses are empty or missing
      const local = await getLocalResponses(attemptId);
      const targetExamId = state.formId || options?.examId || attemptId;
      const draft = loadExamDraft(targetExamId, resolvedUserId, attemptId);
      const draftResponses = draft?.responses || {};

      const combinedLocal = { ...draftResponses, ...local };
      if (Object.keys(combinedLocal).length > 0) {
        setAttemptState((prev) => {
          if (!prev) return prev;
          const currentResp = prev.responses || {};
          return { ...prev, responses: { ...combinedLocal, ...currentResp } };
        });
      }

      // Resilient Recovery: If draft answers exist and time has not expired, restore exact state
      if (draft && typeof draft.remainingSeconds === 'number' && draft.remainingSeconds > 0) {
        if (state.status === 'IN_PROGRESS') {
          setRemainingSeconds(draft.remainingSeconds);
          if (draft.activeSectionId && !activeSectionId) {
            setActiveSectionId(draft.activeSectionId);
          }
        }
      }

      setIsLoading(false);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to load examination attempt');
      setIsLoading(false);
    }
  }, [attemptId, activeSectionId, options?.examId, resolvedUserId]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  const timeoutTriggeredSectionsRef = useRef<Record<string, boolean>>({});
  const inFlightSectionCompleteRef = useRef<Record<string, Promise<AttemptStateDto> | undefined>>({});
  const latestRevisionRef = useRef<number>(0);

  useEffect(() => {
    if (attemptState?.revision) {
      latestRevisionRef.current = attemptState.revision;
    }
  }, [attemptState?.revision]);

  const currentSection: PublicSectionDto | undefined = manifest?.sections.find(
    (s) => s.id === activeSectionId
  );

  // 2. Authoritative countdown timer
  useEffect(() => {
    if (!attemptState || attemptState.status !== 'IN_PROGRESS') return;

    const interval = setInterval(() => {
      const adjustedNow = Date.now() + serverClockOffsetRef.current;
      const activeSecState = attemptState.sections.find((s) => s.sectionId === activeSectionId);
      const deadlineStr = activeSecState?.deadlineAt || attemptState.scheduledEndAt;

      if (deadlineStr) {
        const deadlineMs = new Date(deadlineStr).getTime();
        const diffSec = Math.max(0, Math.floor((deadlineMs - adjustedNow) / 1000));
        setRemainingSeconds(diffSec);

        // Every remaining timer tick written to localStorage under exam_draft_{examId}_{userId} with debounce (500ms)
        saveExamDraftDebounced(
          attemptState.formId || options?.examId || attemptId,
          resolvedUserId,
          { remainingSeconds: diffSec, activeSectionId },
          attemptId
        );

        // If authoritative time expired on current section:
        if (diffSec <= 0 && !isSubmitting && !submitted) {
          const isSpeakingSection =
            Boolean(activeSectionId?.toLowerCase().includes('speaking')) ||
            Boolean(currentSection?.skill?.toLowerCase() === 'speaking');

          const isLastSection = Boolean(
            manifest?.sections &&
            manifest.sections.length > 0 &&
            manifest.sections[manifest.sections.length - 1].id === activeSectionId
          );

          if (isLastSection) {
            // In Speaking, individual turns handle speech time. Never auto-submit incomplete speaking interview.
            if (!isSpeakingSection) {
              submit('TIME_LIMIT');
            }
          } else if (activeSectionId && !timeoutTriggeredSectionsRef.current[activeSectionId]) {
            timeoutTriggeredSectionsRef.current[activeSectionId] = true;
            console.info(`[useExamAttempt] Authoritative timeout reached for section ${activeSectionId}. Initiating section advance.`);
            if (onTimeoutRef.current) {
              onTimeoutRef.current(activeSectionId).catch((e) => {
                console.error('[useExamAttempt] Timeout section transition failed:', e);
                // Allow retry after 5s if still active
                setTimeout(() => {
                  if (timeoutTriggeredSectionsRef.current) {
                    delete timeoutTriggeredSectionsRef.current[activeSectionId];
                  }
                }, 5000);
              });
            } else {
              completeSection(activeSectionId).catch((e) => {
                console.error('[useExamAttempt] Fallback completeSection failed on timeout:', e);
                setTimeout(() => {
                  if (timeoutTriggeredSectionsRef.current) {
                    delete timeoutTriggeredSectionsRef.current[activeSectionId];
                  }
                }, 5000);
              });
            }
          }
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [attemptState, activeSectionId, isSubmitting, submitted, manifest, currentSection, options?.examId, resolvedUserId, attemptId]);

  // 3. Submit handler
  const submit = async (reason: string = 'MANUAL', flushToken?: string, expectedRevision?: number) => {
    if (isSubmitting || submitted) return;
    setIsSubmitting(true);
    try {
      const effectiveReason = reason === 'USER_COMPLETED' ? 'MANUAL' : (reason || 'MANUAL');
      const rev = (typeof expectedRevision === 'number' && expectedRevision > 0)
        ? expectedRevision
        : (latestRevisionRef.current > 0 ? latestRevisionRef.current : (attemptState?.revision && attemptState.revision > 0 ? attemptState.revision : undefined));
      try {
        await examsApi.submitAttempt(attemptId, rev ?? 0, effectiveReason, undefined, flushToken);
      } catch (submitErr: any) {
        const isConflict =
          submitErr?.response?.status === 409 || submitErr?.response?.data?.code === 'ATTEMPT_REVISION_CONFLICT';
        if (isConflict) {
          console.info('ATTEMPT_REVISION_CONFLICT on submitAttempt. Fetching fresh authoritative revision...');
          const fresh = await examsApi.getAttemptState(attemptId);
          if (fresh.status === 'SUBMITTED' || fresh.status === 'EXPIRED') {
            setSubmitted(true);
            setAttemptState(fresh);
            clearExamDraft(fresh.formId || options?.examId || attemptId, resolvedUserId, attemptId);
            return;
          }
          await examsApi.submitAttempt(attemptId, fresh.revision, effectiveReason, undefined, flushToken);
        } else {
          throw submitErr;
        }
      }
      setSubmitted(true);
      setAttemptState((prev) => (prev ? { ...prev, status: 'SUBMITTED' as ExamAttemptStatus } : prev));
      // Authoritative HTTP 200 submit accepted: remove draft
      clearExamDraft(attemptState?.formId || options?.examId || attemptId, resolvedUserId, attemptId);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to submit exam');
      throw err;
    } finally {
      setIsSubmitting(false);
    }
  };

  // 4. Complete Section and Advance (Idempotent & Self-Reconciling)
  const completeSection = async (sectionId: string, flushToken?: string, expectedRevision?: number): Promise<AttemptStateDto | undefined> => {
    if (isSubmitting || submitted) {
      console.warn('[useExamAttempt] completeSection call ignored: already submitted');
      return;
    }

    // Reuse in-flight promise if section is already advancing to prevent duplicate network requests
    if (inFlightSectionCompleteRef.current[sectionId]) {
      console.info(`[useExamAttempt] Section ${sectionId} completion is already in flight. Sharing promise.`);
      return inFlightSectionCompleteRef.current[sectionId];
    }

    const completePromise = (async (): Promise<AttemptStateDto> => {
      try {
        const rev = (typeof expectedRevision === 'number' && expectedRevision > 0)
          ? expectedRevision
          : (latestRevisionRef.current > 0 ? latestRevisionRef.current : (attemptState?.revision && attemptState.revision > 0 ? attemptState.revision : undefined));
        let updated: AttemptStateDto;

        try {
          updated = await examsApi.completeSection(attemptId, sectionId, {
            commandId: `cmd-complete-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            expectedAttemptRevision: rev,
            flushToken,
          });
        } catch (err: any) {
          const isConflict = err?.response?.status === 409 || err?.response?.data?.code === 'ATTEMPT_REVISION_CONFLICT';
          if (isConflict) {
            console.info('ATTEMPT_REVISION_CONFLICT on completeSection. Fetching authoritative state to reconcile...');
            const fresh = await examsApi.getAttemptState(attemptId);
            latestRevisionRef.current = fresh.revision;

            // Check if target section is already COMPLETED on server
            const targetSec = fresh.sections.find((s) => s.sectionId === sectionId);
            const activeSec = fresh.sections.find((s) => s.state === 'ACTIVE');

            if (targetSec && targetSec.state === 'COMPLETED' && activeSec) {
              console.info(`Section ${sectionId} is already COMPLETED on server. Reconciled to active section ${activeSec.sectionId}.`);
              setAttemptState(fresh);
              setActiveSectionId(activeSec.sectionId);
              setError(null);
              return fresh;
            }

            // If target section is still ACTIVE, retry completeSection with fresh revision
            if (targetSec && targetSec.state === 'ACTIVE') {
              console.info(`Target section ${sectionId} still ACTIVE. Retrying completeSection with fresh revision ${fresh.revision}...`);
              updated = await examsApi.completeSection(attemptId, sectionId, {
                commandId: `cmd-complete-retry-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
                expectedAttemptRevision: fresh.revision,
                flushToken,
              });
            } else {
              setAttemptState(fresh);
              if (activeSec) setActiveSectionId(activeSec.sectionId);
              return fresh;
            }
          } else {
            // If server reports error because section already transitioned
            try {
              const fresh = await examsApi.getAttemptState(attemptId);
              const activeSec = fresh.sections.find((s) => s.state === 'ACTIVE');
              if (activeSec && activeSec.sectionId !== sectionId) {
                console.info(`Section ${sectionId} already advanced to ${activeSec.sectionId} on server.`);
                setAttemptState(fresh);
                setActiveSectionId(activeSec.sectionId);
                setError(null);
                return fresh;
              }
            } catch (freshErr) {
              console.warn('Failed to fetch fresh state after completeSection error:', freshErr);
            }
            throw err;
          }
        }

        setAttemptState(updated);
        latestRevisionRef.current = updated.revision;
        setError(null);
        const active = updated.sections.find((s) => s.state === 'ACTIVE');
        if (active) {
          setActiveSectionId(active.sectionId);
        }
        return updated;
      } catch (err: any) {
        console.error('Failed to advance section:', err);
        throw err;
      } finally {
        delete inFlightSectionCompleteRef.current[sectionId];
      }
    })();

    inFlightSectionCompleteRef.current[sectionId] = completePromise;
    return completePromise;
  };

  return {
    attemptState,
    manifest,
    activeSectionId,
    setActiveSectionId,
    currentSection,
    remainingSeconds,
    isLoading,
    error,
    isSubmitting,
    submitted,
    refreshState,
    submit,
    completeSection,
  };
}
