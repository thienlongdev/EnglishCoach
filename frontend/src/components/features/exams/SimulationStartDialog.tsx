'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession, signIn } from 'next-auth/react';
import { AlertCircle, Crown, Loader2, Play, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import type { ActiveSimulationAttemptSummary, CatalogFormDto, ExamAttemptMode } from '@/types/exams';
import { examsApi } from '@/services/examsApi';
import { usePremiumEntitlement } from '@/hooks/usePremiumEntitlement';
import { PremiumUpgradeModal } from '@/components/premium/PremiumUpgradeModal';
import { ExamDialog } from './runner/ExamDialog';
import { CONTENT_UNDER_REVIEW_MESSAGE, getActiveRunnableSkills, isSimulationModeAvailable } from './ExamLibrary';
import { skillLabel, skillList } from '@/lib/exams/runnerModel';

interface SimulationStartDialogProps {
  open: boolean;
  onClose: () => void;
  form: CatalogFormDto;
  lang: 'vi' | 'en';
  /** EXAM_SIMULATION (default) or whole-skill PRACTICE (untimed only when the server says so). */
  mode?: ExamAttemptMode;
}

/** Learner-safe message for a failed start (never a raw server message or code). */
export function startErrorMessage(err: any, lang: 'vi' | 'en'): string {
  const status = err?.response?.status;
  const code = err?.response?.data?.code;
  if (status === 401) {
    return lang === 'vi' ? 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục.' : 'Your session expired. Please sign in again.';
  }
  if (err?.response?.data?.code === 'FORM_CONTENT_UNDER_REVIEW') {
    return CONTENT_UNDER_REVIEW_MESSAGE[lang === 'vi' ? 'vi' : 'en'];
  }
  if (status === 409 && (code === 'SCOPE_NOT_RUNNABLE' || code === 'PRACTICE_SCOPE_UNAVAILABLE')) {
    return lang === 'vi' ? 'Phần này đang được hoàn thiện nội dung và tạm thời chưa thể làm bài.' : 'This part is being prepared and cannot be started yet.';
  }
  if (status === 429 || code === 'RATE_LIMITED') {
    // Exams Phase 9: throttled by the server — natural copy, never the limiter details
    return lang === 'vi' ? 'Bạn thao tác hơi nhanh. Vui lòng đợi khoảng một phút rồi thử lại.' : 'Too many attempts in a short time. Please wait a minute and try again.';
  }
  if (code === 'RIGHTS_DENIED') {
    return lang === 'vi' ? 'Nội dung này hiện chưa được phép sử dụng.' : 'This content is not available for use yet.';
  }
  if (!err?.response) {
    return lang === 'vi' ? 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.' : 'Could not reach the server. Check your connection and try again.';
  }
  return lang === 'vi' ? 'Chưa bắt đầu được bài làm. Vui lòng thử lại sau.' : 'The attempt could not be started. Please try again later.';
}

/**
 * Exams Phase 7 — start a FULL simulation (or a whole-skill practice) from the test detail page. Owns the one-active-
 * simulation rule UX (continue or abandon the running attempt), the IELTS Listening + Reading vs four-skill choice
 * with its premium / trial state, and learner-safe error copy. The server stays authoritative for every rule.
 */
export function SimulationStartDialog({ open, onClose, form, lang, mode = 'EXAM_SIMULATION' }: SimulationStartDialogProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const { isPremium } = usePremiumEntitlement();
  const [consent, setConsent] = useState(false);
  const familySlug = form.family.toLowerCase();
  const isSim = mode === 'EXAM_SIMULATION';

  const [checking, setChecking] = useState(false);
  const [conflict, setConflict] = useState<ActiveSimulationAttemptSummary | null>(null);
  const [starting, setStarting] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [skillScope, setSkillScope] = useState<'TWO_SKILLS' | 'FOUR_SKILLS'>('FOUR_SKILLS');

  const runnable = getActiveRunnableSkills(form);
  const simulationAllowed = isSim ? isSimulationModeAvailable(form) : runnable.length > 0;
  const fourSkillChoice = useMemo(() => {
    if (form.family !== 'IELTS' || !isSim) return false;
    const skills = (form.simulationSkills && form.simulationSkills.length ? form.simulationSkills : runnable).map((s) => s.toUpperCase());
    return skills.includes('LISTENING') && skills.includes('READING') && (skills.includes('WRITING') || skills.includes('SPEAKING'));
  }, [form, isSim, runnable]);

  useEffect(() => {
    if (!open) {
      setConfirmAbandon(false);
      setConsent(false);
      setNotice(null);
      setError(null);
      return;
    }
    if (!session || !isSim) return;
    let alive = true;
    setChecking(true);
    examsApi
      .getActiveSimulation()
      .then((active) => alive && setConflict(active))
      .catch(() => undefined)
      .finally(() => alive && setChecking(false));
    return () => {
      alive = false;
    };
  }, [open, session, isSim]);

  const productive = fourSkillChoice ? skillScope === 'FOUR_SKILLS' : runnable.some(s => s === 'WRITING' || s === 'SPEAKING');
  const needsPremium = productive && !isPremium;

  const start = async () => {
    if (starting) return;
    if (!session) {
      signIn();
      return;
    }
    if (needsPremium) {
      setShowUpgrade(true);
      return;
    }
    setStarting(true);
    setError(null);
    setNotice(null);
    try {
      const skills = fourSkillChoice
        ? skillScope === 'TWO_SKILLS'
          ? ['LISTENING', 'READING']
          : ['LISTENING', 'READING', 'WRITING', 'SPEAKING']
        : !isSim && runnable.length > 0 && runnable.length < 4
        ? runnable
        : undefined;
      const attempt = await examsApi.createAttempt(form.id, mode, undefined, skills, productive && consent);
      router.push(`/exams/${familySlug}/attempts/${attempt.attemptId}`);
    } catch (err: any) {
      const data = err?.response?.data || {};
      if (err?.response?.status === 403 && (data.errorCode === 'PREMIUM_REQUIRED' || data.feature === 'EXAM_AI_SCORING' || data.featureKey === 'EXAM_AI_SCORING')) {
        setShowUpgrade(true);
      } else if (err?.response?.status === 409 && (data.code === 'ACTIVE_SIMULATION_CONFLICT' || String(data.message || '').includes('ACTIVE_SIMULATION_CONFLICT'))) {
        if (data.activeAttempt) setConflict(data.activeAttempt);
        else examsApi.getActiveSimulation().then(setConflict).catch(() => undefined);
      } else {
        setError(startErrorMessage(err, lang));
      }
      setStarting(false);
    }
  };

  const abandon = async () => {
    if (!conflict || abandoning) return;
    setAbandoning(true);
    setError(null);
    try {
      await examsApi.abandonAttempt(conflict.attemptId);
      setConflict(null);
      setConfirmAbandon(false);
      setNotice(lang === 'vi' ? 'Đã hủy bài thi đang dở. Bạn có thể bắt đầu bài mới.' : 'The running test was cancelled. You can start a new one.');
    } catch {
      setError(lang === 'vi' ? 'Chưa hủy được bài thi. Vui lòng thử lại.' : 'The test could not be cancelled. Please try again.');
    } finally {
      setAbandoning(false);
    }
  };

  const busy = starting || abandoning;
  const conflictSameForm = conflict && conflict.formId === form.id;

  return (
    <>
      <ExamDialog
        open={open}
        onClose={onClose}
        busy={busy}
        size="md"
        closeLabel={lang === 'vi' ? 'Đóng' : 'Close'}
        icon={
          <span className="inline-flex w-9 h-9 rounded-xl items-center justify-center bg-indigo-500/15 text-indigo-600 dark:text-indigo-300">
            <ShieldCheck className="w-4 h-4" aria-hidden />
          </span>
        }
        title={isSim ? (lang === 'vi' ? 'Bắt đầu thi đầy đủ' : 'Start full simulation') : lang === 'vi' ? 'Luyện cả kỹ năng' : 'Practise whole skills'}
        description={form.title}
        footer={
          conflict && isSim ? (
            <>
              {!confirmAbandon && (
                <button
                  type="button"
                  id="exam-modal-abandon-btn"
                  onClick={() => setConfirmAbandon(true)}
                  disabled={busy}
                  className="h-10 px-4 rounded-xl border border-rose-500/40 text-rose-700 dark:text-rose-300 text-sm font-semibold hover:bg-rose-500/10 inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  <Trash2 className="w-4 h-4" aria-hidden />
                  {lang === 'vi' ? 'Hủy bài đang làm' : 'Cancel running test'}
                </button>
              )}
              <button
                type="button"
                id="exam-modal-continue-btn"
                onClick={() => router.push(`/exams/${(conflict.family || form.family).toLowerCase()}/attempts/${conflict.attemptId}`)}
                disabled={busy}
                className="h-10 px-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <RotateCcw className="w-4 h-4" aria-hidden />
                {lang === 'vi' ? 'Tiếp tục bài đang làm' : 'Continue that test'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                id="exam-modal-cancel-btn"
                onClick={onClose}
                disabled={busy}
                className="h-10 px-4 rounded-xl border border-border text-sm font-semibold hover:bg-muted disabled:opacity-50"
              >
                {lang === 'vi' ? 'Để sau' : 'Not now'}
              </button>
              <button
                type="button"
                id="exam-modal-start-btn"
                onClick={start}
                disabled={busy || checking || !simulationAllowed || (!!session && productive && isPremium && !consent)}
                className={`h-10 px-5 rounded-xl text-white text-sm font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50 ${
                  needsPremium ? 'bg-amber-600 hover:bg-amber-500' : 'bg-indigo-600 hover:bg-indigo-500'
                }`}
              >
                {starting ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden /> : needsPremium ? <Crown className="w-4 h-4" aria-hidden /> : <Play className="w-4 h-4 fill-current" aria-hidden />}
                {!session
                  ? lang === 'vi' ? 'Đăng nhập để bắt đầu' : 'Sign in to start'
                  : starting
                  ? lang === 'vi' ? 'Đang tạo bài làm…' : 'Creating attempt…'
                  : needsPremium
                  ? lang === 'vi' ? 'Nâng cấp Premium' : 'Upgrade to Premium'
                  : lang === 'vi' ? 'Bắt đầu' : 'Start'}
              </button>
            </>
          )
        }
      >
        <div className="space-y-3 text-sm">
          {checking && (
            <p className="text-xs text-muted-foreground inline-flex items-center gap-2" role="status">
              <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              {lang === 'vi' ? 'Đang kiểm tra bài đang làm…' : 'Checking for a running test…'}
            </p>
          )}

          {conflict && isSim ? (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-1.5">
              <p className="font-semibold text-foreground">
                {conflictSameForm
                  ? lang === 'vi' ? 'Bạn đang làm dở đề này' : 'You already started this test'
                  : lang === 'vi' ? 'Bạn đang có một bài thi đầy đủ khác chưa nộp' : 'Another full simulation is still running'}
              </p>
              <p className="text-xs text-muted-foreground">
                {lang === 'vi' ? 'Mỗi lúc chỉ có một bài thi đầy đủ. Hãy tiếp tục hoặc hủy bài đó.' : 'Only one full simulation can run at a time. Continue or cancel it.'}
              </p>
              <p className="text-xs text-foreground/90">
                {conflict.formTitle}
                {conflict.currentSkill ? ` · ${skillLabel(conflict.currentSkill, lang)}` : ''}
                {conflict.startedAt
                  ? ` · ${new Date(conflict.startedAt).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}`
                  : ''}
              </p>
              {confirmAbandon && (
                <div className="pt-2 mt-1 border-t border-amber-500/30 space-y-2">
                  <p className="text-xs text-rose-700 dark:text-rose-300 font-semibold">
                    {lang === 'vi' ? 'Hủy bài đang làm? Bài này sẽ kết thúc và không được chấm.' : 'Cancel the running test? It ends and is not scored.'}
                  </p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setConfirmAbandon(false)} disabled={abandoning} className="h-9 px-3 rounded-lg border border-border text-xs font-semibold hover:bg-muted">
                      {lang === 'vi' ? 'Giữ lại' : 'Keep it'}
                    </button>
                    <button
                      type="button"
                      id="exam-modal-confirm-abandon-btn"
                      onClick={abandon}
                      disabled={abandoning}
                      className="h-9 px-3 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-60"
                    >
                      {abandoning ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Trash2 className="w-3.5 h-3.5" aria-hidden />}
                      {lang === 'vi' ? 'Xác nhận hủy' : 'Confirm'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <ul className="space-y-1.5 text-muted-foreground text-sm list-disc pl-5">
              {isSim ? (
                <>
                  <li>{lang === 'vi' ? 'Làm như thi thật: có đồng hồ, chuyển phần theo thứ tự, không xem đáp án trong lúc làm.' : 'Like the real test: timed, sections in order, no answers during the test.'}</li>
                  <li>{lang === 'vi' ? 'Mỗi lúc chỉ có một bài thi đầy đủ.' : 'One full simulation at a time.'}</li>
                </>
              ) : (
                <li>
                  {lang === 'vi'
                    ? `Luyện các kỹ năng hiện có của đề (${skillList(runnable)}). Kết quả không tính vào hồ sơ năng lực.`
                    : `Practise the available skills of this test (${skillList(runnable)}). Results are not part of the official profile.`}
                </li>
              )}
            </ul>
          )}

          {fourSkillChoice && !conflict && (
            <fieldset className="space-y-2" aria-label={lang === 'vi' ? 'Chọn phạm vi' : 'Choose scope'}>
              <legend className="text-xs font-semibold text-muted-foreground mb-1">{lang === 'vi' ? 'Phạm vi bài thi' : 'Test scope'}</legend>
              {(['TWO_SKILLS', 'FOUR_SKILLS'] as const).map((opt) => {
                const checked = skillScope === opt;
                return (
                  <label
                    key={opt}
                    id={opt === 'TWO_SKILLS' ? 'exam-modal-option-2skills' : 'exam-modal-option-4skills'}
                    className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer ${checked ? 'border-indigo-500 bg-indigo-500/10' : 'border-border hover:bg-muted/50'} has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring`}
                  >
                    <input type="radio" name="skill-scope" className="mt-1" checked={checked} onChange={() => setSkillScope(opt)} />
                    <span className="flex-1">
                      <span className="block font-semibold text-foreground">
                        {opt === 'TWO_SKILLS' ? 'Listening + Reading' : 'Listening · Reading · Writing · Speaking'}
                      </span>
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        {opt === 'TWO_SKILLS'
                          ? lang === 'vi' ? 'Chấm tự động theo đáp án.' : 'Scored automatically against the answer key.'
                          : lang === 'vi' ? 'Writing và Speaking được chấm bằng Echo Whale AI sau khi nộp.' : 'Writing and Speaking are scored by Echo Whale AI after you submit.'}
                      </span>
                    </span>
                    {opt === 'FOUR_SKILLS' && (
                      <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-muted text-foreground">
                        {isPremium ? (
                          <>
                            <Crown className="w-3 h-3" aria-hidden /> Premium
                          </>
                        ) : (
                          <>
                            <Crown className="w-3 h-3" aria-hidden />
                            {lang === 'vi' ? 'Cần Premium' : 'Premium'}
                          </>
                        )}
                      </span>
                    )}
                  </label>
                );
              })}
            </fieldset>
          )}

          {productive && !conflict && isPremium && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
              {lang === 'vi' ? 'Tôi đồng ý cho English Coach xử lý bản ghi âm và gửi bài viết, bản chép lời và nhận xét âm học đến nhà cung cấp AI để ước lượng điểm luyện tập.' : 'I agree to English Coach processing my recordings and sending my writing, transcripts and acoustic observations to its AI provider for a practice score estimate.'}
            </label>
          )}
          {!simulationAllowed && (
            <p className="text-xs text-muted-foreground flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              {form.contentReviewRequired
                ? CONTENT_UNDER_REVIEW_MESSAGE[lang === 'vi' ? 'vi' : 'en']
                : lang === 'vi' ? 'Đề này hiện chưa khả dụng ở chế độ này.' : 'This test is not available in this mode yet.'}
            </p>
          )}
          {notice && <p className="text-xs text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 rounded-lg p-2.5">{notice}</p>}
          {error && (
            <p role="alert" className="text-xs text-rose-700 dark:text-rose-300 bg-rose-500/10 rounded-lg p-2.5">
              {error}
            </p>
          )}
        </div>
      </ExamDialog>
      <PremiumUpgradeModal
        isOpen={showUpgrade}
        onClose={() => setShowUpgrade(false)}
        featureName="Chấm thi Speaking và Writing"
        customDescription="Chấm thi Speaking và Writing bằng AI cần Premium."
      />
    </>
  );
}

export default SimulationStartDialog;
