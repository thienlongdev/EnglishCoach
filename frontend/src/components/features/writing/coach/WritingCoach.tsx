'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  WritingSession,
  WritingTask,
  WritingSessionStage,
  DocumentAssessmentResult,
  ModelAnswerComparisonResponse
} from '@/types/writing';
import { writingApi } from '@/services/writingApi';
import { TaskPicker } from './TaskPicker';
import { StageRail, StudioLoading, glass, type CoachStep } from '../glass/WritingGlass';
import { PlanningForm } from './PlanningForm';
import { DraftEditor } from './DraftEditor';
import { FeedbackPanel } from './FeedbackPanel';
import { DraftDiff } from './DraftDiff';
import { echoSrc } from '@/lib/brand/echoCharacters';

interface WritingCoachProps {
  initialSessionId?: string;
  initialTaskId?: string;
  userId: number;
}

export const WritingCoach: React.FC<WritingCoachProps> = ({
  initialSessionId,
  initialTaskId,
  userId
}) => {
  const [session, setSession] = useState<WritingSession | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [creating, setCreating] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [assessment, setAssessment] = useState<DocumentAssessmentResult | null>(null);
  const [showDiff, setShowDiff] = useState<boolean>(false);

  // Model Answer Comparison state
  const [comparingModel, setComparingModel] = useState<boolean>(false);
  const [modelComparisonResult, setModelComparisonResult] = useState<ModelAnswerComparisonResponse | null>(null);
  const [loadingModelComparison, setLoadingModelComparison] = useState<boolean>(false);
  const [modelComparisonError, setModelComparisonError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // `start=draft` (Lộ trình học): a new session of the given task opens straight in the editor (planning stays optional)
  const startDraft = useSearchParams()?.get('start') === 'draft';
  // A late session response must not replace the address after an Odyssey/sidebar navigation starts.
  // Keep the server-created session; only discard stale UI/address writes. No navigation is held or intercepted.
  const navigationEpoch = useRef(0);
  const isWritingLocation = () => typeof window !== 'undefined' && (window.location.pathname === '/writing'
    || window.location.pathname === '/' && new URLSearchParams(window.location.search).get('tab') === 'writing');
  useEffect(() => {
    const leave = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.target && anchor.target !== '_self') return;
      const destination = new URL(anchor.href, window.location.href);
      const writing = destination.origin === window.location.origin && (destination.pathname === '/writing'
        || destination.pathname === '/' && destination.searchParams.get('tab') === 'writing');
      if (!writing) navigationEpoch.current += 1;
    };
    document.addEventListener('click', leave, true);
    return () => { navigationEpoch.current += 1; document.removeEventListener('click', leave, true); };
  }, [userId]);

  useEffect(() => {
    if (!isWritingLocation()) return;
    let live = true;
    const epoch = navigationEpoch.current;
    const current = () => live && epoch === navigationEpoch.current && isWritingLocation();
    async function init() {
      setLoading(true);
      try {
        if (initialSessionId) {
          const sess = await writingApi.getSession(initialSessionId);
          if (!current()) return;
          setSession(sess);
          if (sess.activeAssessmentId && (sess.stage === 'FEEDBACK_READY' || sess.stage === 'COMPLETED')) {
            try {
              const assess = await writingApi.getSessionAssessment(sess.id, sess.activeAssessmentId);
              if (!current()) return;
              setAssessment(assess);
            } catch (aErr) {
              console.warn('Failed to load active assessment for session', aErr);
            }
          }
        } else if (initialTaskId) {
          setCreating(true);
          let newSess = await writingApi.createSession(initialTaskId);
          if (!current()) return;
          if (startDraft && newSess.stage === 'UNDERSTANDING') {
            newSess = await writingApi.advanceStage(newSess.id, 'DRAFTING', newSess.currentRevision);
            if (!current()) return;
          }
          setSession(newSess);
          if (typeof window !== 'undefined') {
            const params = new URLSearchParams(window.location.search);
            params.set('sessionId', newSess.id);
            window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
          }
        }
      } catch (err) {
        console.error('Failed to initialize WritingCoach session', err);
      } finally {
        if (current()) { setLoading(false); setCreating(false); }
      }
    }
    init();
    return () => { live = false; };
  }, [initialSessionId, initialTaskId, startDraft, userId]);

  const handleSelectTask = async (task: WritingTask) => {
    if (creating) return;
    setCreating(true);
    const epoch = navigationEpoch.current;
    try {
      const newSess = await writingApi.createSession(task.id);
      if (epoch !== navigationEpoch.current || !isWritingLocation()) return;
      setSession(newSess);
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search);
        params.set('sessionId', newSess.id);
        window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
      }
    } catch (err) {
      console.error('Failed to create writing session', err);
    } finally {
      if (epoch === navigationEpoch.current) setCreating(false);
    }
  };

  const handleCompleteSession = async () => {
    if (!session) return;
    try {
      const updated = await writingApi.completeSession(
        session.id,
        session.finalDraftId,
        session.currentRevision
      );
      setSession(updated);
    } catch (err) {
      console.error('Failed to complete writing session', err);
    }
  };

  const handleAdvanceStage = async (targetStage: WritingSessionStage) => {
    if (!session) return;
    try {
      const updated = await writingApi.advanceStage(session.id, targetStage, session.currentRevision);
      setSession(updated);
    } catch (err) {
      console.error('Failed to advance session stage', err);
    }
  };

  const handleCompareModelAnswer = async () => {
    if (!session || loadingModelComparison) return;
    setModelComparisonError(null);
    setModelComparisonResult(null);
    setLoadingModelComparison(true);
    setComparingModel(true);
    try {
      const explicitLevel = session.taskSnapshot?.level || session.taskSnapshot?.cefrLevel;
      const res = await writingApi.compareModelAnswer({
        taskId: session.taskId,
        sessionId: session.id,
        taskPrompt: session.taskSnapshot?.prompt || session.taskSnapshot?.title || 'Writing Task',
        learnerDraft: session.workingText || '',
        targetRegister: session.taskSnapshot?.targetRegister || 'formal',
        learnerLevel: explicitLevel ? String(explicitLevel) : undefined
      });
      setModelComparisonResult(res);
    } catch (err) {
      console.error('Failed to compare model answer', err);
      setModelComparisonError('Không thể tạo bài viết mẫu lúc này. Vui lòng thử lại.');
    } finally {
      setLoadingModelComparison(false);
    }
  };

  const handleSubmitDraft = async (content: string, saved?: WritingSession) => {
    if (!session || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setAssessment(null); // Invariant 19: eliminate stale assessment while new draft is being assessed
    try {
      saved = saved || await writingApi.updateWorkingCopy(session.id, content, session.workingPlan, session.currentRevision);
      // The editor has flushed pending autosaves and received this revision's ACK.
      setSession(saved);

      // If in Stage 4 (REVISING), execute final submission pipeline
      if (session.stage === 'REVISING') {
        const completed = await writingApi.completeSession(session.id, undefined, saved.currentRevision);
        setSession(completed);
        if (completed.activeAssessmentId) {
          const assess = await writingApi.getSessionAssessment(completed.id, completed.activeAssessmentId);
          setAssessment(assess);
        }
        return;
      }

      // 2. Submit draft to assessment pipeline
      const result = await writingApi.submitDraft(session.id, saved.currentRevision);
      setAssessment(result);

      // 3. Refresh session state
      const refreshed = await writingApi.getSession(session.id);
      setSession(refreshed);
    } catch (err: any) {
      console.error('Failed to submit draft for review', err);
      setSubmitError('Đánh giá bài viết chưa hoàn tất. Bản nháp đã được lưu; hãy bấm nộp bài để thử lại.');
      try {
        const refreshed = await writingApi.getSession(session.id);
        setSession(refreshed);
        if (refreshed.activeAssessmentId) {
          const assess = await writingApi.getSessionAssessment(refreshed.id, refreshed.activeAssessmentId);
          setAssessment(assess);
        }
      } catch (rErr) {
        console.error('Failed to reload session after assessment error', rErr);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || creating) {
    return (
      <div className={glass.panel}>
        <StudioLoading text="Đang mở không gian viết..." />
      </div>
    );
  }

  if (!session) {
    return <TaskPicker onSelectTask={handleSelectTask} creating={creating} />;
  }

  // The server's session stage, shown as the four learner steps (UNDERSTANDING/PLANNING → DRAFTING → ANALYZING/FEEDBACK_READY
  // → REVISING; COMPLETED = all done). Never a progress estimate.
  const stageIndex: Record<string, number> = { UNDERSTANDING: 0, PLANNING: 0, DRAFTING: 1, ANALYZING: 2, FEEDBACK_READY: 2, REVISING: 3, COMPLETED: 4 };
  const at = stageIndex[session.stage] ?? 0;
  const steps: CoachStep[] = ['Đọc hiểu và Lập dàn ý', 'Viết nháp', 'Đánh giá và Gợi ý', 'Chỉnh sửa và Hoàn thiện']
    .map((label, i) => ({ label, state: i < at ? 'done' : i === at ? 'current' : 'todo' }));

  return (
    <div className="flex flex-col w-full gap-4">
      {/* Session strip: change task, the stage rail, the model-answer comparison */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <button
            onClick={() => {
              setSession(null);
              setAssessment(null);
            }}
            className={glass.back}
            type="button"
          >
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
            <span>Đổi đề bài khác</span>
          </button>
          <StageRail steps={steps} label="Các bước của phiên viết" />
        </div>

        <div className="flex items-center gap-2">
          {session.workingText && session.workingText.trim().length > 20 && (
            <button
              onClick={handleCompareModelAnswer}
              className={`${glass.btn} ${glass.btnSm} ${glass.btnSoft}`}
              type="button"
            >
              <span className="material-symbols-outlined text-[16px] text-secondary">auto_stories</span>
              <span>Bài mẫu tham khảo</span>
            </button>
          )}
        </div>
      </div>

      {/* Stage 1 & 2: UNDERSTANDING & PLANNING (Unified Atelier Planning Studio) */}
      {(session.stage === 'UNDERSTANDING' || session.stage === 'PLANNING') && (
        <PlanningForm
          session={session}
          onBackToTask={() => {
            setSession(null);
            setAssessment(null);
          }}
          onSessionUpdated={(updated) => {
            setSession(updated);
          }}
          onProceedToDrafting={async (planOrSession) => {
            if (typeof planOrSession !== 'string') {
              setSession(planOrSession);
              return;
            }
            try {
              const updated = await writingApi.updateWorkingCopy(
                session.id,
                session.workingText,
                planOrSession,
                session.currentRevision
              );
              setSession(updated);
              const advanced = await writingApi.advanceStage(session.id, 'DRAFTING', updated.currentRevision);
              setSession(advanced);
            } catch (err) {
              console.error('Failed to proceed to drafting', err);
            }
          }}
        />
      )}


      {/* Stage 3/4: DRAFTING / REVISING */}
      {(session.stage === 'DRAFTING' || session.stage === 'REVISING') && (
        showDiff ? (
          <DraftDiff
            sessionId={session.id}
            onBackToFeedback={() => setShowDiff(false)}
            onContinueRevising={() => setShowDiff(false)}
          />
        ) : (
          <DraftEditor
            session={session}
            userId={userId}
            submitting={submitting}
            onSessionUpdated={(updated) => setSession(updated)}
            onSubmitForReview={handleSubmitDraft}
            onViewDiff={() => setShowDiff(true)}
          />
        )
      )}

      {/* Stage 4: ANALYZING (Processing State) */}
      {session.stage === 'ANALYZING' && (
        <div className={`${glass.panel} ${glass.state} max-w-2xl mx-auto my-8`} role="status">
          <span className={glass.quill} aria-hidden="true"><i /><b /></span>
          <h3 className="text-xl text-on-surface font-bold">
            Đang phân tích bài viết của bạn...
          </h3>
          <p className="font-body-md text-body-md text-on-surface-variant max-w-md mx-auto leading-relaxed">
            Bản nháp của bạn đã được ghi nhận. Huấn luyện viên AI đang đánh giá tính liên kết ý tưởng, ngữ pháp và vốn từ học thuật theo tiêu chuẩn của đề bài.
          </p>
          <div className="pt-2">
            <button
              onClick={() => handleAdvanceStage('DRAFTING')}
              className={`${glass.btn} ${glass.btnSoft}`}
              type="button"
            >
              Quay lại soạn thảo
            </button>
          </div>
        </div>
      )}

      {/* Stage 5: FEEDBACK_READY / COMPLETED */}
      {(session.stage === 'FEEDBACK_READY' || session.stage === 'COMPLETED') && assessment && (
        <div className="space-y-space-md">
          {session.stage === 'COMPLETED' && (
            <div className={`${glass.verdict} flex-col sm:flex-row sm:items-center justify-between`} data-v="ok">
              <div className="flex items-center gap-space-sm">
                <span className="material-symbols-outlined text-tertiary text-[24px]">verified</span>
                <div>
                  <h4 className="font-label-md text-label-md font-bold text-on-surface">
                    Bài viết đã hoàn thành và Lưu vào Portfolio
                  </h4>
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    Bài viết đã được lưu vào hồ sơ học tập của bạn. Bạn có thể xem lại điểm số, lịch sử sửa đổi và bài mẫu đối chiếu.
                  </p>
                </div>
              </div>
              <button
                onClick={handleCompareModelAnswer}
                className={`${glass.btn} ${glass.btnSm} ${glass.btnSoft} self-start sm:self-auto`}
                type="button"
              >
                <span className="material-symbols-outlined text-[16px]">menu_book</span>
                <span>So sánh với bài mẫu</span>
              </button>
            </div>
          )}

          {showDiff ? (
            <DraftDiff
              sessionId={session.id}
              onBackToFeedback={() => setShowDiff(false)}
              onContinueRevising={() => {
                setShowDiff(false);
                handleAdvanceStage('REVISING');
              }}
            />
          ) : (
            <FeedbackPanel
              assessment={assessment}
              workingText={session.workingText}
              onUpdateWorkingText={async (newText) => {
                try {
                  const updated = await writingApi.updateWorkingCopy(
                    session.id,
                    newText,
                    session.workingPlan,
                    session.currentRevision
                  );
                  setSession(updated);
                } catch (err) {
                  console.error('Failed to update working draft with correction', err);
                }
              }}
              onViewDiff={() => setShowDiff(true)}
              onBeginRevision={() => handleAdvanceStage('REVISING')}
              onRetryEvaluation={() => handleSubmitDraft(session.workingText)}
              onCompleteSession={handleCompleteSession}
              isCompleted={session.stage === 'COMPLETED'}
            />
          )}
        </div>
      )}

      {/* Stage 5 Fallback: FEEDBACK_READY / COMPLETED when assessment could not be loaded */}
      {(session.stage === 'FEEDBACK_READY' || session.stage === 'COMPLETED') && !assessment && (
        <div className={`${glass.panel} ${glass.state} max-w-lg mx-auto my-8`}>
          <span className={glass.stateIcon} aria-hidden="true"><span className="material-symbols-outlined text-[28px]">description</span></span>
          <h3 className={glass.stateTitle}>
            Chưa có kết quả đánh giá
          </h3>
          <p className="font-body-md text-body-md text-on-surface-variant">
            Bạn có thể thử yêu cầu đánh giá lại hoặc quay lại tiếp tục chỉnh sửa bài viết.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => handleSubmitDraft(session.workingText)}
              disabled={submitting}
              className={`${glass.btn} ${glass.btnPrimary}`}
              type="button"
            >
              <span className="material-symbols-outlined text-[18px]">sync</span>
              <span>{submitting ? 'Đang phân tích...' : 'Đánh giá bài viết'}</span>
            </button>
            <button
              onClick={() => handleAdvanceStage('REVISING')}
              className={`${glass.btn} ${glass.btnSoft}`}
              type="button"
            >
              Tiếp tục chỉnh sửa
            </button>
          </div>
        </div>
      )}

      {/* Model Answer Comparison Modal */}
      {submitError && <p role="alert" className={glass.verdict} data-v="bad">{submitError}</p>}
      {comparingModel && (
        <div className={glass.dialogScrim}>
          <div role="dialog" aria-modal="true" aria-label="Đối chiếu bài viết mẫu" className={`${glass.panel} w-full max-w-2xl max-h-[85vh] overflow-y-auto overscroll-contain p-6 sm:p-7 space-y-space-md animate-in fade-in zoom-in-95 duration-150`}>
            <div className="flex items-center justify-between border-b border-surface-variant/30 pb-space-sm">
              <div className="flex items-center gap-space-xs">
                <span className="material-symbols-outlined text-primary text-[22px]">auto_stories</span>
                <h3 className="font-headline-sm text-headline-sm text-on-surface font-semibold flex items-center gap-2">
                  <span>Đối chiếu bài viết mẫu</span>
                  {Boolean(session.taskSnapshot?.level || session.taskSnapshot?.cefrLevel) && modelComparisonResult?.calibrated_level && (
                    <span className="font-label-stamp text-label-stamp px-2 py-0.5 rounded-full bg-primary-fixed text-primary font-bold">
                      Mục tiêu: {modelComparisonResult.calibrated_level}
                    </span>
                  )}
                </h3>
              </div>
              <button
                onClick={() => setComparingModel(false)}
                className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors cursor-pointer"
                type="button"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            {loadingModelComparison ? (
              <div className="p-12 text-center space-y-space-sm">
                <span className="material-symbols-outlined text-[32px] animate-spin text-primary">sync</span>
                <p className="font-body-sm text-body-sm text-on-surface-variant">Đang tạo bài viết mẫu đối chiếu...</p>
              </div>
            ) : modelComparisonResult ? (
              <div className="space-y-space-md">
                <div className="p-space-md rounded-xl bg-surface-container-low border border-surface-variant/30 space-y-space-xs">
                  <span className="font-label-stamp text-label-stamp uppercase tracking-wider text-primary font-bold block">
                    Bài viết mẫu tham khảo{Boolean(session.taskSnapshot?.level || session.taskSnapshot?.cefrLevel) && modelComparisonResult?.calibrated_level ? ` (${modelComparisonResult.calibrated_level})` : ''}
                  </span>
                  <div className="font-body-xl-editorial text-body-xl-editorial leading-relaxed text-on-surface whitespace-pre-wrap">
                    {modelComparisonResult.exemplar_model_answer}
                  </div>
                </div>

                <div className="space-y-space-xs">
                  <span className="font-label-md text-label-md text-on-surface font-semibold block">
                    Nhận xét về cấu trúc và Lập luận
                  </span>
                  <ul className="space-y-1 font-body-sm text-body-sm text-on-surface-variant">
                    {modelComparisonResult.structural_observations.map((obs, idx) => (
                      <li key={idx} className="flex items-start gap-2 p-space-xs rounded-lg bg-surface-container">
                        <span className="text-primary font-bold">•</span>
                        <span>{obs}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="space-y-space-xs">
                  <span className="font-label-md text-label-md text-on-surface font-semibold block">
                    Gợi ý từ vựng và Cụm từ nâng cao
                  </span>
                  <ul className="space-y-1 font-body-sm text-body-sm text-on-surface-variant">
                    {modelComparisonResult.lexical_alternatives.map((alt, idx) => (
                      <li key={idx} className="flex items-start gap-2 p-space-xs rounded-lg bg-surface-container">
                        <img src={echoSrc('scholar', 24)} alt="Echo" width={16} height={16} className="w-4 h-4 object-contain shrink-0 mt-0.5 select-none pointer-events-none" />
                        <span>{alt}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="p-space-md rounded-xl bg-tertiary-fixed/30 border border-tertiary/20 font-body-sm text-body-sm text-tertiary">
                  <strong className="font-bold">Lời khuyên từ Huấn luyện viên: </strong>
                  {modelComparisonResult.coaching_summary}
                </div>
              </div>
            ) : (
              <div role="alert" className="text-center py-6 space-y-3">
                <p>{modelComparisonError || 'Không thể tạo bài viết mẫu lúc này.'}</p>
                <button type="button" onClick={handleCompareModelAnswer} className={`${glass.btn} ${glass.btnPrimary}`}>Thử lại</button>
              </div>
            )}

            <div className="flex justify-end pt-space-xs border-t border-surface-variant/30">
              <button
                onClick={() => setComparingModel(false)}
                className="px-space-md py-2 min-h-[38px] rounded-xl bg-surface-container text-on-surface hover:bg-surface-container-high border border-outline-variant/60 font-semibold text-sm transition-colors cursor-pointer shadow-xs"
                type="button"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
