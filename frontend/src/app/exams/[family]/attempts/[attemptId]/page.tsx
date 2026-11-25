'use client';

import React, { useState, useEffect, useRef } from 'react';
import { notFound, useRouter, useParams } from 'next/navigation';
import { useExamAttempt } from '@/hooks/useExamAttempt';
import { useExamAutosave } from '@/hooks/useExamAutosave';
import { ExamPreflight } from '@/components/features/exams/ExamPreflight';
import { ExamRuntimeShell } from '@/components/features/exams/ExamRuntimeShell';
import { examsApi } from '@/services/examsApi';
import { practiceResultPath, practiceScopeLabel } from '@/lib/exams/practice';
import { durationText, toeicPartName } from '@/lib/exams/runnerModel';
import { AlertCircle } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { StrictModeGate, StrictExitConfirm, AttemptVoided } from '@/components/sentinel/StrictModeDialogs';
import { useFocusLockdown } from '@/components/sentinel/useFocusLockdown';
import { beginAttempt, bindExam, isVoided, reopenExam } from '@/lib/sentinel/client';
import type { SentinelAttempt } from '@/lib/sentinel/client';

/** Exams Phase 7: runner boot skeleton — layout-shaped, no fake questions or answer-shaped blocks. */
function RunnerBootSkeleton({ label }: { label: string }) {
  return (
    <div className="h-[100dvh] flex flex-col bg-background" role="status" aria-live="polite">
      <div className="h-14 border-b border-border bg-card/80 px-4 flex items-center gap-3">
        <div className="h-7 w-24 rounded-full bg-muted animate-pulse motion-reduce:animate-none" />
        <div className="h-4 w-48 rounded bg-muted animate-pulse motion-reduce:animate-none" />
        <div className="ml-auto h-8 w-24 rounded-lg bg-muted animate-pulse motion-reduce:animate-none" />
      </div>
      <div className="flex-1 flex flex-col md:flex-row gap-4 p-4">
        <div className="md:w-1/2 h-40 md:h-auto rounded-2xl bg-muted/50 animate-pulse motion-reduce:animate-none" />
        <div className="md:w-1/2 flex-1 rounded-2xl bg-muted/30 animate-pulse motion-reduce:animate-none" />
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export default function AttemptPage() {
  const routeParams = useParams();
  const router = useRouter();
  const { language } = useLanguage();
  const lang: 'vi' | 'en' = language === 'en' ? 'en' : 'vi';

  const rawFamily = ((routeParams?.family as string) || '').toLowerCase();
  const attemptId = (routeParams?.attemptId as string) || '';

  if (rawFamily && rawFamily !== 'ielts' && rawFamily !== 'toeic') {
    notFound();
  }
  const family = rawFamily === 'ielts' ? 'IELTS' : 'TOEIC';

  const handleTimeoutAdvance = useRef<((secId: string) => Promise<void>) | null>(null);

  const {
    attemptState,
    manifest,
    activeSectionId,
    setActiveSectionId,
    currentSection,
    remainingSeconds,
    isLoading,
    error: attemptError,
    submit,
    completeSection,
    refreshState,
  } = useExamAttempt(attemptId, {
    onSectionTimeout: async (secId) => {
      if (handleTimeoutAdvance.current) {
        await handleTimeoutAdvance.current(secId);
      }
    },
  });

  // Autosave hook
  const {
    saveBatch,
    saveStatus,
    localResponses,
    queueAnswer,
    flush,
    retry: retrySave,
  } = useExamAutosave(
    attemptId,
    attemptState?.revision || 0,
    attemptState?.responses || {},
    { examId: attemptState?.formId }
  );

  handleTimeoutAdvance.current = async (secId: string) => {
    const t0 = Date.now();
    console.info(`[AttemptPage][${new Date().toISOString()}] Section timeout triggered for ${secId}. Draining autosave...`);
    try {
      const receipt = await flush();
      const tFlush = Date.now();
      console.info(`[AttemptPage][${new Date().toISOString()}] Autosave flush completed in ${tFlush - t0}ms. Flushed: ${receipt?.flushedCount}, AckRev: ${receipt?.acknowledgedRevision}`);
      const rev =
        receipt && typeof receipt.acknowledgedRevision === 'number' && receipt.acknowledgedRevision > 0
          ? receipt.acknowledgedRevision
          : undefined;
      const res = await completeSection(secId, receipt?.flushToken, rev);
      console.info(`[AttemptPage][${new Date().toISOString()}] completeSection succeeded in ${Date.now() - tFlush}ms:`, res?.status);
    } catch (err) {
      console.warn(`[AttemptPage][${new Date().toISOString()}] Section timeout flush/advance error:`, err);
      try {
        console.info(`[AttemptPage][${new Date().toISOString()}] Reconciling completeSection without flush receipt...`);
        const res = await completeSection(secId);
        console.info(`[AttemptPage][${new Date().toISOString()}] Reconciled completeSection succeeded:`, res?.status);
      } catch (retryErr) {
        console.error(`[AttemptPage][${new Date().toISOString()}] Failed completeSection after retry:`, retryErr);
        await refreshState();
      }
    }
  };

  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Echo Sentinel (10 §BX): a simulation is an acknowledged strict attempt held by THIS page only.
  const [strictAttempt, setStrictAttempt] = useState<SentinelAttempt | null>(null);
  const [strictGate, setStrictGate] = useState(false);
  const [strictBusy, setStrictBusy] = useState(false);
  const [strictError, setStrictError] = useState<string | null>(null);
  const [strictVoid, setStrictVoid] = useState<string | null>(null);
  const [strictExitAsk, setStrictExitAsk] = useState(false);
  const reopened = useRef(false);
  const isRedirectingRef = useRef(false);
  const isSubmittingAttemptRef = useRef(false);

  const redirectToResult = () => {
    if (isRedirectingRef.current) return;
    isRedirectingRef.current = true;
    // Exams Phase 6: a practice-scoped attempt has its own raw-metrics result + review page.
    router.replace(manifest?.practiceScope ? practiceResultPath(rawFamily, attemptId) : `/exams/${rawFamily}/results/${attemptId}`);
  };

  // If already submitted, redirect to result cleanly without router race
  useEffect(() => {
    if ((attemptState?.status === 'SUBMITTED' || attemptState?.status === 'EXPIRED') && manifest) {
      redirectToResult();
    }
  }, [attemptState?.status, attemptId, rawFamily, manifest]);

  const isSimulation = attemptState?.mode === 'EXAM_SIMULATION';
  // A running simulation opened without its secret (reload, another tab, a new device): the server ends its strict
  // attempt; an attempt never bound (taken before Echo Sentinel) keeps its historical rules.
  useEffect(() => {
    if (!isSimulation || attemptState?.status !== 'IN_PROGRESS' || strictAttempt || reopened.current) return;
    reopened.current = true;
    reopenExam(attemptId).then(r => { if (isVoided(r.state) || r.state === 'PENDING_REVIEW') setStrictVoid(r.state); }).catch(() => {});
  }, [isSimulation, attemptState?.status, strictAttempt, attemptId]);
  const strictLive = isSimulation && attemptState?.status === 'IN_PROGRESS' && !!strictAttempt && !strictVoid;
  useFocusLockdown({ attempt: strictAttempt, active: strictLive, onStatus: (st) => { if (isVoided(st)) setStrictVoid(st); } });
  // Browser Back during the simulation asks first, like an in-app exit.
  useEffect(() => {
    if (!strictLive) return;
    window.history.pushState(window.history.state, '', window.location.href);
    const onPop = () => { window.history.pushState(window.history.state, '', window.location.href); setStrictExitAsk(true); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [strictLive]);
  const acceptStrictGate = async () => {
    setStrictBusy(true);
    setStrictError(null);
    try {
      const attempt = await beginAttempt('EXAM_SIMULATION');
      await bindExam(attempt, attemptId);
      setStrictAttempt(attempt);
      setStrictGate(false);
      await startAttemptNow();
    } catch {
      setStrictError(lang === 'vi' ? 'Chưa thể mở lượt thi có tính điểm lúc này. Hãy tải lại trang hoặc thử lại sau.' : 'The scored attempt cannot be opened right now. Reload or try again later.');
    } finally {
      setStrictBusy(false);
    }
  };
  const strictOverlays = <>
    {strictGate && <StrictModeGate vi={lang === 'vi'} busy={strictBusy} error={strictError} graceSeconds={20}
      onAccept={() => void acceptStrictGate()} onBack={() => setStrictGate(false)} />}
    {!strictGate && strictExitAsk && strictLive && <StrictExitConfirm vi={lang === 'vi'} onStay={() => setStrictExitAsk(false)}
      onLeave={() => { setStrictExitAsk(false); router.push(`/exams/${rawFamily}`); }} />}
    {strictVoid && <AttemptVoided vi={lang === 'vi'} state={strictVoid}
      onRestart={() => router.push(`/exams/${rawFamily}`)} onLobby={() => router.push(`/exams/${rawFamily}`)} />}
  </>;

  // Handle preflight ready -> start (a simulation asks for the strict acknowledgement first)
  const handlePreflightReady = async () => {
    if (attemptState?.mode === 'EXAM_SIMULATION' && !strictAttempt) { setStrictError(null); setStrictGate(true); return; }
    await startAttemptNow();
  };
  const startAttemptNow = async () => {
    setIsStarting(true);
    setStartError(null);
    try {
      await examsApi.readyAttempt(attemptId);
      await examsApi.startAttempt(attemptId);
      await refreshState();
    } catch (err: any) {
      setStartError(
        lang === 'vi'
          ? 'Chưa bắt đầu được bài làm. Kiểm tra kết nối rồi thử lại.'
          : 'The attempt could not be started. Check your connection and try again.'
      );
    } finally {
      setIsStarting(false);
    }
  };

  const bootLabel = lang === 'vi' ? 'Đang chuẩn bị bài làm…' : 'Preparing your attempt…';

  if (isLoading) {
    return <RunnerBootSkeleton label={bootLabel} />;
  }

  if (!attemptState || !manifest) {
    if (attemptError) {
      return (
        <div className="h-[100dvh] flex flex-col items-center justify-center gap-3 p-6 bg-background text-foreground text-center">
          <AlertCircle className="w-10 h-10 text-rose-600" aria-hidden />
          <h2 className="text-lg font-bold">{lang === 'vi' ? 'Không mở được bài làm' : 'This attempt could not be opened'}</h2>
          <p className="text-sm text-muted-foreground max-w-md">
            {lang === 'vi'
              ? 'Có thể kết nối đang gián đoạn hoặc bài làm này không thuộc tài khoản của bạn. Câu trả lời đã lưu không bị mất.'
              : 'The connection may be interrupted or this attempt does not belong to your account. Saved answers are not lost.'}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
            <button
              type="button"
              onClick={() => refreshState()}
              className="h-10 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90"
            >
              {lang === 'vi' ? 'Thử lại' : 'Try again'}
            </button>
            <button
              type="button"
              onClick={() => router.push(`/exams/${rawFamily}`)}
              className="h-10 px-4 rounded-xl border border-border text-sm font-semibold hover:bg-muted"
            >
              {lang === 'vi' ? 'Về kho đề' : 'Back to library'}
            </button>
          </div>
        </div>
      );
    }
    return <RunnerBootSkeleton label={bootLabel} />;
  }

  // Preflight state: CREATED or READY
  const isPreflight = attemptState.status === 'CREATED' || attemptState.status === 'READY';
  const hasSpeaking = manifest.sections.some((s) => s.skill.toUpperCase() === 'SPEAKING');

  if (isPreflight) {
    return (
      <div className="min-h-screen bg-background text-foreground py-10 px-4">
        {strictOverlays}
        {startError && (
          <div role="alert" className="max-w-3xl mx-auto mb-4 p-3 bg-destructive/10 border border-destructive/20 text-destructive text-xs rounded-xl">
            {startError}
          </div>
        )}
        <ExamPreflight
          family={family}
          formTitle={manifest.title}
          hasSpeaking={hasSpeaking}
          onReady={handlePreflightReady}
          lang={lang}
          mode={attemptState.mode}
          isStarting={isStarting}
          scopeLabel={
            manifest.practiceScope
              ? (() => {
                  const base = practiceScopeLabel(manifest.practiceScope, lang);
                  const name = manifest.practiceScope.scopeType === 'TOEIC_PART' ? toeicPartName(manifest.practiceScope.number, lang) : '';
                  return name ? `${base} · ${name}` : base;
                })()
              : null
          }
          questionCount={manifest.sections.reduce(
            (acc, sec) => acc + sec.parts.reduce((a, p) => a + p.groups.reduce((g, gr) => g + (gr.items?.length || 0), 0), 0),
            0
          )}
          durationText={
            attemptState.mode === 'EXAM_SIMULATION'
              ? durationText(Math.round(manifest.sections.reduce((acc, sec) => acc + (sec.durationSeconds || 0), 0) / 60), lang) || null
              : null
          }
        />
      </div>
    );
  }

  // Active examination state: IN_PROGRESS
  return (
    <>
    {strictOverlays}
    <ExamRuntimeShell
      attemptId={attemptId}
      manifest={manifest}
      attemptState={attemptState}
      activeSectionId={activeSectionId || manifest.sections[0]?.id || ''}
      remainingSeconds={remainingSeconds}
      saveStatus={saveStatus}
      responses={localResponses}
      onQueueAnswer={queueAnswer}
      onSaveBatch={saveBatch}
      onRetrySave={retrySave}
      onSubmit={async (reason = 'MANUAL') => {
        if (isSubmittingAttemptRef.current) {
          console.warn('[AttemptPage] Submit attempt already in progress, ignoring duplicate trigger');
          return;
        }
        isSubmittingAttemptRef.current = true;
        try {
          const receipt = await flush();
          if (activeSectionId) {
            try {
              await completeSection(activeSectionId, receipt?.flushToken);
            } catch (secErr) {
              console.warn('[AttemptPage] Complete active section before submit:', secErr);
            }
          }
          const effectiveReason = reason === 'USER_COMPLETED' ? 'MANUAL' : (reason || 'MANUAL');
          await submit(effectiveReason, receipt?.flushToken);
          redirectToResult();
        } catch (err: any) {
          isSubmittingAttemptRef.current = false;
          console.error('Submit blocked by failure:', err);
          throw err;
        }
      }}
      onSelectSection={async (secId) => {
        try {
          await flush();
        } catch (e) {
          console.warn('Autosave flush before section switch encountered error:', e);
        }
        setActiveSectionId(secId);
      }}
      onCompleteSection={async (secId) => {
        try {
          const receipt = await flush();
          const rev =
            receipt && typeof receipt.acknowledgedRevision === 'number' && receipt.acknowledgedRevision > 0
              ? receipt.acknowledgedRevision
              : undefined;
          await completeSection(secId, receipt?.flushToken, rev);
        } catch (e) {
          console.warn('Handling completeSection error with reconciliation:', e);
          try {
            await completeSection(secId);
          } catch (retryErr) {
            console.error('Failed to advance section after retry:', retryErr);
            await refreshState();
          }
        }
      }}
    />
    </>
  );
}
