'use client';

import React, { useState, useEffect } from 'react';
import { notFound, useRouter, useParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { examsApi } from '@/services/examsApi';
import type { ExamResultDto, AttemptReviewDto, ScoringProgressDto } from '@/types/exams';
import { ExamResultView } from '@/components/features/exams/ExamResultView';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { resultPhase, resultWaitExpired, retryableResultError, RESULT_WAIT_MS } from '@/lib/exams/resultLifecycle';
import { UniverseStage, UniverseWorld, ux } from '@/components/features/exams/universe/ExamUniverse';

export default function ResultPage() {
  const router = useRouter();
  const params = useParams();
  const { status: authStatus } = useSession();
  const { language } = useLanguage();
  const vi = language !== 'en';
  const rawFamily = String(params?.family || '').toLowerCase();
  const attemptId = String(params?.attemptId || '');
  if (rawFamily && rawFamily !== 'ielts' && rawFamily !== 'toeic') notFound();

  const [result, setResult] = useState<ExamResultDto | null>(null);
  const [review, setReview] = useState<AttemptReviewDto | null>(null);
  const [progress, setProgress] = useState<ScoringProgressDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!attemptId || authStatus === 'loading') return;
    let disposed = false;
    let requests = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const startedAt = Date.now();
    setResult(null);
    setReview(null);
    setProgress(null);
    setError(null);
    setLoading(true);
    const finish = (message: string) => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      setError(message);
      setLoading(false);
    };
    const timeoutMessage = vi
      ? 'Kết quả chưa sẵn sàng. Hãy kiểm tra lịch sử bài làm hoặc thử lại sau.'
      : 'Results are not ready. Check your attempt history or try again later.';
    // Wall-clock bound also closes a request stalled in auth refresh or transport.
    const deadline = setTimeout(() => { finish(timeoutMessage); controller.abort(); }, RESULT_WAIT_MS);
    const schedule = () => {
      if (disposed) return;
      if (resultWaitExpired(requests, Date.now() - startedAt)) {
        clearTimeout(deadline);
        finish(timeoutMessage);
      } else timer = setTimeout(fetchResult, 3000);
    };
    async function fetchResult() {
      if (disposed) return;
      requests++;
      try {
        const value = await examsApi.getResult(attemptId, controller.signal);
        if (disposed || controller.signal.aborted) return;
        const phase = resultPhase(value);
        if (phase === 'PROCESSING') {
          setProgress(value as ScoringProgressDto);
          schedule();
          return;
        }
        clearTimeout(deadline);
        if (phase === 'TERMINAL_WITHOUT_ARTIFACT') {
          setProgress(value as ScoringProgressDto);
          finish(vi
            ? 'Bài đã được nộp. Hiện chưa có kết quả chấm khả dụng. Bạn có thể kiểm tra lại hoặc trở về lịch sử.'
            : 'Your submission is saved. No scoring result is currently available. Check again or return to history.');
          return;
        }
        setResult(value as ExamResultDto);
        setLoading(false);
        // Optional review never holds the result shell open and never starts scoring.
        examsApi.getReview(attemptId).then((data) => {
          if (!disposed) setReview(data);
        }).catch(() => {});
      } catch (err: any) {
        if (disposed || controller.signal.aborted) return;
        if (retryableResultError(err?.response?.status)) schedule();
        else {
          clearTimeout(deadline);
          finish(vi ? 'Không thể mở kết quả này. Hãy kiểm tra tài khoản hoặc trở về lịch sử.' : 'This result could not be opened. Check your account or return to history.');
        }
      }
    }
    if (authStatus === 'unauthenticated') {
      clearTimeout(deadline);
      finish(vi ? 'Đăng nhập để xem kết quả của bạn.' : 'Sign in to view your result.');
    } else void fetchResult();
    return () => { disposed = true; controller.abort(); clearTimeout(deadline); if (timer) clearTimeout(timer); };
  }, [attemptId, authStatus, retry, vi]);

  // Echo Exam Universe (2026-10-24): the result screens live in the family's world (token wrapper only; the views inside
  // and the result lifecycle above are unchanged).
  const world = rawFamily === 'ielts' ? 'ielts' : 'toeic';
  if (authStatus === 'loading' || loading) return (
    <UniverseWorld world={world} narrow>
      <div className={ux.stateShell} id="exam-result-loading-shell" role="status">
        <span className={ux.stateOrb} aria-hidden><Loader2 className={ux.spin} /></span>
        <h1>{vi ? 'Đang tải kết quả bài thi…' : 'Loading your result…'}</h1>
        {progress?.stages?.map((stage) => <p key={stage.stageKey} className="text-xs text-muted-foreground">{stage.stageKey}: {stage.status}</p>)}
      </div>
    </UniverseWorld>
  );
  if (error || !result) return (
    <UniverseWorld world={world} narrow>
      <div className={ux.stateShell}>
        <span className={ux.stateOrb} data-tone="warn" aria-hidden><AlertCircle /></span>
        <h1>{vi ? 'Kết quả bài thi' : 'Exam result'}</h1>
        <p role="alert">{error}</p>
        <div className={ux.heroActions} style={{ justifyContent: 'center' }}>
          <button type="button" onClick={() => setRetry((value) => value + 1)} className={ux.cta}>
            <RefreshCw aria-hidden />{vi ? 'Kiểm tra lại' : 'Check again'}
          </button>
          <button type="button" onClick={() => router.push(`/exams/${rawFamily}?view=history`)} className={ux.emptyAction} style={{ marginTop: 0 }}>{vi ? 'Lịch sử bài làm' : 'Attempt history'}</button>
        </div>
      </div>
    </UniverseWorld>
  );
  return (
    <UniverseWorld world={world} narrow>
      <UniverseStage world={world}>
        <ExamResultView result={result} review={review} />
      </UniverseStage>
    </UniverseWorld>
  );
}
