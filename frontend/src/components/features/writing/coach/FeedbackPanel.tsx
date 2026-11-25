'use client';

import React, { useState, useMemo } from 'react';
import { DocumentAssessmentResult, FeedbackIssue, IssueSeverity } from '@/types/writing';
import { writingApi } from '@/services/writingApi';
import { getDimensionLabel, getSeverityLabel, getPatternDisplayTitle } from '@/lib/writing/labels';

import { glass } from '../glass/WritingGlass';
interface FeedbackPanelProps {
  assessment: DocumentAssessmentResult;
  workingText?: string;
  onUpdateWorkingText?: (newText: string) => void;
  onBeginRevision: () => void;
  onRetryEvaluation?: () => void;
  onCompleteSession?: () => void;
  onViewDiff?: () => void;
  isCompleted?: boolean;
}

export const FeedbackPanel: React.FC<FeedbackPanelProps> = ({
  assessment,
  workingText = '',
  onUpdateWorkingText,
  onBeginRevision,
  onRetryEvaluation,
  onCompleteSession,
  onViewDiff,
  isCompleted = false
}) => {
  const issues = useMemo(() => {
    return assessment.prioritizedIssues && assessment.prioritizedIssues.length > 0
      ? assessment.prioritizedIssues
      : assessment.allIssues || [];
  }, [assessment]);

  const [activeIssueIndex, setActiveIssueIndex] = useState<number>(0);
  const [learnerRewrites, setLearnerRewrites] = useState<Record<string, string>>({});
  const [revealedHintLevels, setRevealedHintLevels] = useState<Record<string, number>>({});
  const [resolvedIssueIds, setResolvedIssueIds] = useState<Set<string>>(new Set());
  const [disputedIds, setDisputedIds] = useState<Set<string>>(new Set());
  const [showAllIssues, setShowAllIssues] = useState<boolean>(false);
  const [staleOffsetError, setStaleOffsetError] = useState<string | null>(null);

  const activeIssue: FeedbackIssue | undefined = issues[activeIssueIndex];

  const handleDispute = async (issueId: string) => {
    try {
      await writingApi.disputeIssue(issueId);
      setDisputedIds((prev) => new Set(prev).add(issueId));
    } catch (err) {
      console.error('Failed to dispute issue', err);
    }
  };

  const handleRevealNextHint = (issueId: string) => {
    setRevealedHintLevels((prev) => ({
      ...prev,
      [issueId]: (prev[issueId] || 0) + 1
    }));
  };

  const handleApplyCorrection = (issue: FeedbackIssue) => {
    const rewrite = (learnerRewrites[issue.id] || '').trim() || issue.replacement || '';
    if (!rewrite) return;

    if (issue.sourceQuote && !workingText.includes(issue.sourceQuote)) {
      setStaleOffsetError(`Đoạn văn gốc "${issue.sourceQuote}" đã thay đổi trong bản nháp. Vui lòng chỉnh sửa thủ công để tránh ghi đè sai lệch.`);
      return;
    }

    if (issue.sourceQuote && workingText.includes(issue.sourceQuote)) {
      const updated = workingText.replace(issue.sourceQuote, rewrite);
      if (onUpdateWorkingText) {
        onUpdateWorkingText(updated);
      }
      setResolvedIssueIds((prev) => new Set(prev).add(issue.id));
      setStaleOffsetError(null);
    } else if (!issue.sourceQuote) {
      setResolvedIssueIds((prev) => new Set(prev).add(issue.id));
      setStaleOffsetError(null);
    }
  };

  const words = workingText.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const paragraphs = useMemo(() => {
    if (!workingText) return ['Không có văn bản nào cho bản nháp này.'];
    return workingText.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  }, [workingText]);

  if (assessment.status && assessment.status !== 'READY') {
    return (
      <div className={`${glass.panel} ${glass.state} max-w-xl mx-auto my-8`} data-kind="error" role="alert">
        <div className={glass.stateIcon}>
          <span className="material-symbols-outlined text-[28px]">error</span>
        </div>
        <h3 className={glass.stateTitle}>
          Đánh giá bài viết chưa hoàn tất
        </h3>
        <p className="font-body-md text-body-md text-on-surface-variant leading-relaxed">
          Hệ thống AI không thể tạo kết quả đánh giá cho bản nháp này do sự cố kết nối hoặc lỗi dịch vụ. Bài viết của bạn vẫn được lưu an toàn.
        </p>
        <div className="flex items-center gap-3 pt-2">
          {onRetryEvaluation && (
            <button
              onClick={onRetryEvaluation}
              type="button"
              className={`${glass.btn} ${glass.btnPrimary}`}
            >
              <span className="material-symbols-outlined text-[18px]">sync</span>
              <span>Thử lại đánh giá</span>
            </button>
          )}
          <button
            onClick={onBeginRevision}
            type="button"
            className={`${glass.btn} ${glass.btnSoft}`}
          >
            Tiếp tục chỉnh sửa
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full">
      {/* Progress Tracker & Metadata Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <span className={`${glass.label} ${glass.labelInk}`}>
          {isCompleted ? 'Đã hoàn thành · Kết quả đánh giá' : 'Bước 3 · Đánh giá và gợi ý cho bản nháp'}
        </span>

        <div className="flex items-center gap-space-sm self-start lg:self-auto">
          <div className={`${glass.chip} min-h-9 px-3`}>
            <span className="material-symbols-outlined text-[16px] text-primary">analytics</span>
            <span className="font-label-md text-label-md">
              Đánh giá bản nháp #{assessment.draftOrdinal} • {wordCount} từ •{' '}
              <strong className="text-on-surface font-semibold">
                {issues.length > 0 ? `${issues.length} điểm cần lưu ý` : 'Đã phân tích toàn diện'}
              </strong>
            </span>
          </div>
        </div>
      </div>

      {/* Studio Split Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-xl items-start">
        {/* ================================================================= */}
        {/* LEFT COLUMN: Dominant Manuscript Workspace (col-span-7)           */}
        {/* ================================================================= */}
        <div className="xl:col-span-7 flex flex-col gap-space-md">
          {/* Paper Desk Canvas */}
          <div className={`${glass.paper} overflow-hidden`}>
            {/* margin rule of a writing sheet */}
            <div className={glass.paperMargin} aria-hidden="true"></div>

            {/* Header / Document Bar */}
            <div className="relative z-[2] pl-16 pr-5 sm:pr-7 pt-5 pb-3 flex flex-wrap gap-2 items-center justify-between border-b border-outline-variant/40">
              <div className="flex items-center gap-space-sm">
                <span className="material-symbols-outlined text-primary text-[20px]">article</span>
                <span className="text-base font-bold text-on-surface">
                  Rà soát bản nháp #{assessment.draftOrdinal}
                </span>
              </div>
              <div className="flex items-center gap-space-xs">
                {assessment.overallScore !== undefined && assessment.overallScore !== null ? (
                  <span className={`${glass.chip} ${glass.chipInk}`}>
                    Điểm: {assessment.overallScore}/100
                  </span>
                ) : (
                  <span className={glass.chip}>
                    Chưa có điểm
                  </span>
                )}
              </div>
            </div>

            {/* Manuscript Body Content */}
            <div className="relative z-[2] pl-16 pr-5 sm:pr-8 py-6 flex flex-col gap-space-lg" lang="en">
              {paragraphs.map((para, pIdx) => {
                const containsActiveQuote = activeIssue?.sourceQuote && para.includes(activeIssue.sourceQuote);
                return (
                  <div
                    key={pIdx}
                    className={`relative rounded-xl transition-all ${
                      containsActiveQuote
                        ? 'p-space-md -ml-space-md bg-surface-container-low/80 shadow-xs'
                        : ''
                    }`}
                  >
                    {containsActiveQuote && (
                      <div className="absolute -left-2 top-3 w-1.5 h-7 rounded-full bg-primary"></div>
                    )}

                    <p className="font-body-xl-editorial text-body-xl-editorial text-on-surface leading-loose select-text">
                      {para.split(activeIssue?.sourceQuote || '___NEVER_MATCH___').map((segment, sIdx, arr) => {
                        if (sIdx === arr.length - 1) return <span key={sIdx}>{segment}</span>;
                        const isResolved = resolvedIssueIds.has(activeIssue!.id);
                        return (
                          <React.Fragment key={sIdx}>
                            <span>{segment}</span>
                            <span
                              onClick={() => {
                                const el = document.getElementById(`issue-card-${activeIssue!.id || activeIssueIndex}`);
                                el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                              }}
                              className={`relative inline-block mx-1 font-medium px-1.5 py-0.5 rounded cursor-pointer shadow-xs group ${
                                isResolved
                                  ? 'text-tertiary-container bg-tertiary-fixed-dim/30'
                                  : 'text-error bg-error-container/30 underline decoration-error decoration-wavy decoration-2 underline-offset-4'
                              }`}
                            >
                              <span>{learnerRewrites[activeIssue!.id] || activeIssue!.sourceQuote}</span>
                              <span className="absolute -top-7 left-1/2 -translate-x-1/2 hidden group-hover:flex items-center gap-1 bg-inverse-surface text-inverse-on-surface text-label-sm font-label-sm px-2 py-0.5 rounded shadow-lg whitespace-nowrap z-20">
                                <span className="material-symbols-outlined text-[13px] text-error">priority_high</span>
                                <span>Trọng tâm: {getDimensionLabel(activeIssue!.category)}</span>
                              </span>
                            </span>
                          </React.Fragment>
                        );
                      })}
                    </p>

                    {containsActiveQuote && (
                      <div className="mt-space-sm flex items-center justify-between text-on-surface-variant">
                        <span className="font-label-stamp text-label-stamp uppercase text-primary font-bold flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-primary animate-pulse"></span>
                          Vùng rà soát hiện tại • Đoạn {pIdx + 1}
                        </span>
                        <span className="font-label-sm text-label-sm opacity-70">
                          Điểm ưu tiên #{activeIssueIndex + 1}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Assessment Strengths and Dimensions Strip */}
            {assessment.strengths && assessment.strengths.length > 0 && (
              <div className="relative z-[2] pl-16 pr-5 sm:pr-8 py-4 border-t border-outline-variant/40 flex flex-col gap-space-xs">
                <span className="font-label-stamp text-label-stamp uppercase text-tertiary tracking-wider font-bold flex items-center gap-1">
                  <span className="material-symbols-outlined text-[16px]">check_circle</span>
                  Điểm sáng trong bài viết
                </span>
                <div className="flex flex-wrap gap-space-xs">
                  {assessment.strengths.map((str, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1 px-space-xs py-0.5 rounded-full bg-surface-container text-on-surface font-body-sm text-body-sm"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-tertiary"></span>
                      {str}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ================================================================= */}
        {/* RIGHT COLUMN: Interactive Self-Correction Desk (col-span-5)        */}
        {/* ================================================================= */}
        <div className="xl:col-span-5 flex flex-col gap-space-md">
          {/* Desk Header with Micro Status */}
          <div className="flex items-center justify-between pb-space-xs">
            <div>
              <h2 className="font-headline-sm text-headline-sm text-on-surface font-bold">
                {issues.length > 0
                  ? `${issues.length} điểm gợi ý tiếp theo cho bạn`
                  : assessment.status === 'READY'
                  ? 'Không phát hiện lỗi nghiêm trọng'
                  : 'Chưa có phân tích lỗi'}
              </h2>
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                Các điểm tinh chỉnh ngữ pháp và nâng cấp văn phong
              </span>
            </div>
            {issues.length > 0 && (
              <div className="px-space-sm py-1 rounded-full bg-secondary-fixed text-on-secondary-fixed-variant font-label-stamp text-label-stamp uppercase tracking-wider font-bold">
                {activeIssueIndex + 1} / {issues.length} Đang chọn
              </div>
            )}
          </div>

          {/* Issue Cards Stack */}
          {issues.map((issue, idx) => {
            const isActive = idx === activeIssueIndex;
            const isResolved = resolvedIssueIds.has(issue.id);
            const isDisputed = disputedIds.has(issue.id);
            const hintLevel = revealedHintLevels[issue.id] || 0;
            const currentVal = learnerRewrites[issue.id] !== undefined ? learnerRewrites[issue.id] : (issue.replacement || '');

            if (!isActive) {
              return (
                <div
                  key={issue.id || idx}
                  onClick={() => setActiveIssueIndex(idx)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveIssueIndex(idx); } }}
                  role="button"
                  tabIndex={0}
                  className={`${glass.panel} p-4 flex items-center justify-between transition-colors cursor-pointer group hover:brightness-[1.03]`}
                >
                  <div className="flex items-center gap-space-sm min-w-0">
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                        isResolved
                          ? 'bg-tertiary-fixed text-tertiary'
                          : 'bg-surface-container-highest text-on-surface-variant group-hover:text-primary'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[18px]">
                        {isResolved ? 'check' : 'alt_route'}
                      </span>
                    </div>
                    <div className="flex flex-col min-w-0">
                      <div className="flex items-center gap-space-xs">
                        <span className="font-label-stamp text-label-stamp uppercase tracking-widest text-on-surface-variant font-bold">
                          Ưu tiên {idx + 1} • {getDimensionLabel(issue.category)}
                        </span>
                        <span
                          className={`font-label-stamp text-label-stamp px-1 rounded ${
                            isResolved
                              ? 'bg-tertiary-fixed/40 text-tertiary font-bold'
                              : 'bg-surface-container-highest text-on-surface-variant'
                          }`}
                        >
                          {isResolved ? 'Đã sửa' : 'Chờ xử lý'}
                        </span>
                      </div>
                      <span className="font-headline-sm text-headline-sm text-on-surface font-semibold truncate">
                        {getPatternDisplayTitle(issue.title, issue.patternCode)}
                      </span>
                    </div>
                  </div>
                  <span className="material-symbols-outlined text-outline-variant group-hover:text-on-surface transition-colors shrink-0">
                    expand_more
                  </span>
                </div>
              );
            }

            return (
              <div
                key={issue.id || idx}
                id={`issue-card-${issue.id || idx}`}
                className={`${glass.panel} flex flex-col p-5 sm:p-6 overflow-hidden`}
              >
                {/* Left Semantic Indicator Accent */}
                <div
                  className={`absolute left-0 top-0 bottom-0 w-1.5 ${
                    isResolved ? 'bg-tertiary' : 'bg-error'
                  }`}
                ></div>

                {/* Tag & CEFR Metadata */}
                <div className="flex items-center justify-between mb-space-sm">
                  <span
                    className={`font-label-stamp text-label-stamp uppercase tracking-widest font-bold flex items-center gap-1 ${
                      isResolved ? 'text-tertiary' : 'text-error'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[15px]">
                      {isResolved ? 'check_circle' : 'report_problem'}
                    </span>
                    {getDimensionLabel(issue.category)} • {getSeverityLabel(issue.severity).label}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleDispute(issue.id)}
                      disabled={isDisputed}
                      title="Phản hồi lại nhận xét này"
                      aria-label={isDisputed ? 'Đã gửi phản hồi về nhận xét này' : 'Phản hồi lại nhận xét này'}
                      className={glass.iconBtn}
                      type="button"
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        {isDisputed ? 'flag_circle' : 'outlined_flag'}
                      </span>
                    </button>
                  </div>
                </div>

                {/* Diagnostic Explanation */}
                <p className="font-body-md text-body-md text-on-surface mb-space-md">
                  {issue.explanation}
                </p>

                {/* Progressive Hint Drawer */}
                <div className="p-space-sm rounded-xl bg-surface-container-low mb-space-md flex flex-col gap-space-2xs border border-surface-variant/30">
                  <div className="flex items-center justify-between text-on-surface">
                    <div className="flex items-center gap-space-xs font-label-md text-label-md font-semibold">
                      <span className="material-symbols-outlined text-[18px] text-secondary">lightbulb</span>
                      <span>Gợi ý tư duy</span>
                    </div>
                    {hintLevel < 2 ? (
                      <button
                        onClick={() => handleRevealNextHint(issue.id)}
                        className="font-label-stamp text-label-stamp uppercase text-secondary hover:underline font-bold cursor-pointer"
                        type="button"
                      >
                        Mở gợi ý ({hintLevel + 1}/2)
                      </button>
                    ) : (
                      <span className="font-label-stamp text-label-stamp uppercase text-on-surface-variant">
                        Đã mở tối đa gợi ý
                      </span>
                    )}
                  </div>
                  <p className="font-body-sm text-body-sm text-on-surface-variant italic pl-6">
                    {hintLevel === 0
                      ? '“Hãy xem xét sự hòa hợp ngữ pháp, độ chính xác của giới từ hoặc tính liên kết văn phong trong cụm từ này.”'
                      : hintLevel === 1
                      ? issue.teachingRule
                        ? `“Quy tắc: ${issue.teachingRule}”`
                        : '“Hãy chú ý đến số ít/số nhiều của chủ ngữ và từ đi kèm có cần biến đổi tương ứng hay không.”'
                      : issue.replacement
                      ? `“Cách viết đề xuất: '${issue.replacement}'”`
                      : '“Viết lại với sự hòa hợp chủ - vị rõ ràng và các từ nối trang trọng.”'}
                  </p>
                </div>

                {/* Active Self-Correction Workbench */}
                <div className="flex flex-col gap-space-sm mb-space-md">
                  {issue.sourceQuote && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="font-label-stamp text-label-stamp uppercase tracking-widest text-on-surface-variant">
                          Đoạn văn gốc cần chỉnh sửa
                        </span>
                        <span className="font-label-sm text-label-sm text-error flex items-center gap-0.5">
                          <span className="material-symbols-outlined text-[14px]">cancel</span> Đã phát hiện điểm chưa chuẩn
                        </span>
                      </div>
                      <div className="p-space-xs px-space-sm rounded-lg bg-surface-container text-on-surface-variant line-through font-body-sm text-body-sm select-none">
                        {issue.sourceQuote}
                      </div>
                    </>
                  )}

                  {/* Rewrite Interactive Input */}
                  <div className="flex flex-col gap-space-2xs mt-space-xs">
                    <div className="flex items-center justify-between">
                      <label
                        className="font-label-md text-label-md text-on-surface font-semibold"
                        htmlFor={`rewrite-${issue.id}`}
                      >
                        Câu viết lại chuẩn xác của bạn:
                      </label>
                      <span className="font-label-sm text-label-sm text-tertiary-container font-semibold flex items-center gap-1">
                        <span className="material-symbols-outlined text-[15px]">auto_fix_high</span>
                        {isResolved ? 'Đã hoàn thành' : 'Sẵn sàng sửa'}
                      </span>
                    </div>
                    <div className="relative">
                      <textarea
                        id={`rewrite-${issue.id}`}
                        rows={2}
                        value={currentVal}
                        onChange={(e) =>
                          setLearnerRewrites((prev) => ({
                            ...prev,
                            [issue.id]: e.target.value
                          }))
                        }
                        placeholder="Nhập câu hoặc mệnh đề đã chỉnh sửa của bạn tại đây..."
                        className="w-full px-space-sm py-space-xs rounded-xl bg-surface-container-low text-on-surface font-body-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary shadow-inner resize-none transition border border-surface-variant/40"
                      />
                    </div>
                  </div>

                  {/* Stale Offset Error Alert */}
                  {staleOffsetError && (
                    <div className="p-space-xs px-space-sm rounded-lg bg-error-container text-on-error-container text-xs flex items-center gap-1.5 border border-error/30 animate-in fade-in">
                      <span className="material-symbols-outlined text-[16px] text-error">warning</span>
                      <span>{staleOffsetError}</span>
                    </div>
                  )}

                  {/* Validate / Apply Button */}
                  <button
                    onClick={() => handleApplyCorrection(issue)}
                    disabled={isResolved || !currentVal.trim()}
                    className={`mt-space-2xs w-full ${glass.btn} ${isResolved ? `${glass.chipOk} cursor-default` : glass.btnPrimary}`}
                    type="button"
                  >
                    <span>{isResolved ? 'Đã áp dụng chỉnh sửa ✓' : 'Áp dụng sửa vào bài viết'}</span>
                    <span className="material-symbols-outlined text-[18px]">
                      {isResolved ? 'done_all' : 'arrow_forward'}
                    </span>
                  </button>
                </div>

                {/* Success Feedback Container */}
                {isResolved && (
                  <div className="p-space-sm rounded-xl bg-tertiary-fixed/30 flex items-start gap-space-sm text-tertiary shadow-xs">
                    <div className="w-6 h-6 rounded-full bg-tertiary text-on-tertiary flex items-center justify-center shrink-0 mt-0.5">
                      <span className="material-symbols-outlined text-[16px]">check</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="font-label-md text-label-md font-bold text-on-tertiary-fixed">
                        Đã áp dụng
                      </span>
                      <p className="font-body-sm text-body-sm text-on-tertiary-fixed mt-0.5 leading-snug">
                        Đoạn chỉnh sửa đã được cập nhật trực tiếp vào bản nháp của bạn.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Bottom Studio Actions */}
          <div className="mt-space-xs pt-space-xs flex flex-col gap-space-sm">
            {isCompleted ? (
              <div className={`${glass.verdict} justify-center text-sm font-semibold`} data-v="ok">
                <span className="material-symbols-outlined text-[20px] text-emerald-600">verified</span>
                <span>Bài viết đã hoàn thành và Đã lưu vào Portfolio</span>
              </div>
            ) : (
              <button
                onClick={onBeginRevision}
                className={`${glass.btn} ${glass.btnPrimary} w-full whitespace-normal`}
                type="button"
              >
                <span className="material-symbols-outlined text-[20px]">task_alt</span>
                <span>Chỉnh sửa trong trình soạn thảo (Bản nháp #{assessment.draftOrdinal + 1}) →</span>
              </button>
            )}

            <div className="flex items-center justify-between gap-space-sm">
              {assessment.draftOrdinal > 1 && onViewDiff && (
                <button
                  onClick={onViewDiff}
                  className={`${glass.btn} ${glass.btnSoft} flex-1`}
                  type="button"
                >
                  <span className="material-symbols-outlined text-[16px]">difference</span>
                  <span>Đối chiếu bản nháp</span>
                </button>
              )}
              {isCompleted ? (
                <button
                  onClick={onBeginRevision}
                  className={`${glass.btn} ${glass.btnSoft} flex-1`}
                  type="button"
                >
                  <span className="material-symbols-outlined text-[16px]">edit_note</span>
                  <span>Tạo thêm bản sửa đổi</span>
                </button>
              ) : (
                onCompleteSession && (
                  <button
                    onClick={onCompleteSession}
                    disabled={isCompleted}
                    className={`${glass.btn} ${glass.btnSoft} flex-1`}
                    type="button"
                  >
                    <span className="material-symbols-outlined text-[16px]">archive</span>
                    <span>Lưu vào Portfolio</span>
                  </button>
                )
              )}
            </div>

            <p className="text-center font-label-sm text-label-sm text-on-surface-variant/70 mt-space-2xs">
              Bản nháp #{assessment.draftOrdinal + 1} sẽ tích hợp các điểm sửa mới của bạn và mở khóa hướng dẫn nâng cao văn phong học thuật.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
