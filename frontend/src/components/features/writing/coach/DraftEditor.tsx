'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { WritingSession } from '@/types/writing';
import { writingApi } from '@/services/writingApi';
import { SaveStatus } from '../shared/WritingStatus';
import { saveLocalRecoveryBuffer, loadLocalRecoveryBuffer, clearLocalRecoveryBuffer } from '@/lib/writing/recovery';
import { TaskVisualChart } from './TaskVisualChart';

import { glass } from '../glass/WritingGlass';
interface DraftEditorProps {
  session: WritingSession;
  userId: number;
  onSessionUpdated: (updated: WritingSession) => void;
  onSubmitForReview: (content: string, saved: WritingSession) => Promise<void>;
  onViewDiff?: () => void;
  submitting?: boolean;
}

export const DraftEditor: React.FC<DraftEditorProps> = ({
  session,
  userId,
  onSessionUpdated,
  onSubmitForReview,
  onViewDiff,
  submitting = false
}) => {
  const isRevising = session.stage === 'REVISING';
  const [text, setText] = useState<string>(session.workingText || '');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('SAVED');
  const [lastSavedTime, setLastSavedTime] = useState<number | null>(Date.now());
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [isZen, setIsZen] = useState<boolean>(false);

  // Keep track of local revision & sequence
  const revisionRef = useRef<number>(session.currentRevision);
  const textRef = useRef<string>(text);
  textRef.current = text;
  revisionRef.current = session.currentRevision;

  const sequenceRef = useRef<number>(0);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const saveInFlightRef = useRef<Promise<WritingSession | undefined> | null>(null);
  const submitInFlightRef = useRef(false);

  // Check sessionStorage recovery on mount if session text was empty or older
  useEffect(() => {
    const recovery = loadLocalRecoveryBuffer(userId, session.id);
    if (recovery && recovery.workingText && recovery.workingText !== session.workingText) {
      if (recovery.baseServerRevision >= session.currentRevision) {
        console.log('[DraftEditor] Restoring uncommitted local recovery buffer');
        setText(recovery.workingText);
        setSaveStatus('UNSAVED');
      }
    }
  }, [session.id, userId]);

  // Deterministic word counter (whitespace-separated words)
  const computeWordCount = (val: string): number => {
    const trimmed = val.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).filter(Boolean).length;
  };

  const wordCount = computeWordCount(text);
  const charCount = text.length;

  const targetMin = session.taskSnapshot?.targetWordCountMin || 180;
  const targetMax = session.taskSnapshot?.targetWordCountMax || 250;
  const progressPct = Math.min(100, Math.round((wordCount / targetMin) * 100));

  // Lexical telemetry calculated from genuine learner text
  const lexicalTelemetry = useMemo(() => {
    const words = text.toLowerCase().match(/\b[a-z]{2,}\b/g) || [];
    if (words.length === 0) return { diversityPct: 0, transitionsDetected: 0, hasConcession: false };
    const unique = new Set(words);
    const diversityPct = Math.min(100, Math.round((unique.size / words.length) * 100));

    const transitions = ['however', 'furthermore', 'nevertheless', 'consequently', 'therefore', 'moreover', 'although', 'while', 'in addition'];
    let transitionsDetected = 0;
    let hasConcession = false;
    for (const t of transitions) {
      if (text.toLowerCase().includes(t)) {
        transitionsDetected += 1;
        if (t === 'while' || t === 'although' || t === 'nevertheless') hasConcession = true;
      }
    }
    return { diversityPct, transitionsDetected, hasConcession };
  }, [text]);

  const performSave = useCallback(
    async (contentToSave: string) => {
      if (saveInFlightRef.current) await saveInFlightRef.current;

      setSaveStatus('SAVING');
      setConflictError(null);

      const pending = (async () => {
      try {
        const updated = await writingApi.updateWorkingCopy(
          session.id,
          contentToSave,
          session.workingPlan,
          revisionRef.current
        );

        revisionRef.current = updated.currentRevision;
        setSaveStatus('SAVED');
        setLastSavedTime(Date.now());
        clearLocalRecoveryBuffer(userId, session.id);
        onSessionUpdated(updated);
        return updated;
      } catch (err: any) {
        if (err?.response?.status === 409) {
          setSaveStatus('CONFLICT');
          setConflictError('Another tab or device updated this draft. Please copy your edits and refresh.');
        } else {
          setSaveStatus('OFFLINE');
          setConflictError('Không thể lưu bản nháp. Vui lòng thử lại trước khi nộp bài.');
        }
      }
      })();
      saveInFlightRef.current = pending;
      try {
        return await pending;
      } finally {
        if (saveInFlightRef.current === pending) saveInFlightRef.current = null;
      }
    },
    [session.id, session.workingPlan, userId, onSessionUpdated, saveStatus]
  );

  // Free practice submission (no AI, no Premium): saves, then the server checks and records the saved draft once.
  const [practice, setPractice] = useState<{ state: 'idle' | 'sending' | 'done' | 'error'; text?: string; id?: number }>({ state: 'idle' });
  const handlePracticeSubmit = async () => {
    if (practice.state === 'sending' || submitInFlightRef.current) return;
    setPractice({ state: 'sending' });
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    const saved = await performSave(textRef.current);
    if (!saved) { setPractice({ state: 'error', text: 'Chưa lưu được bản nháp. Vui lòng thử lại.' }); return; }
    try {
      const r = await writingApi.submitPractice(session.id);
      setPractice({ state: 'done', text: `Đã nộp bài luyện tập (${r.wordCount} từ).`, id: r.id });
    } catch (err: any) {
      const msg = err?.response?.data?.message;
      setPractice({ state: 'error', text: typeof msg === 'string' && msg.length < 200 ? msg : 'Chưa nộp được bài luyện tập. Vui lòng thử lại.' });
    }
  };

  const handleSubmit = async () => {
    if (submitInFlightRef.current || submitting) return;
    submitInFlightRef.current = true;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    try {
      const saved = await performSave(textRef.current);
      if (saved) await onSubmitForReview(saved.workingText || '', saved);
    } finally {
      submitInFlightRef.current = false;
    }
  };

  useEffect(() => () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  }, []);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setText(newText);
    setSaveStatus('UNSAVED');
    setConflictError(null);

    sequenceRef.current += 1;
    saveLocalRecoveryBuffer(
      userId,
      session.id,
      newText,
      session.workingPlan,
      revisionRef.current,
      sequenceRef.current
    );

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      performSave(newText);
    }, 1500);
  };

  const handleBlur = () => {
    if (saveStatus === 'UNSAVED') {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      performSave(text);
    }
  };

  const handleInsertSpark = (spark: string) => {
    setText((prev) => {
      const next = prev.endsWith(' ') || prev.length === 0 ? `${prev}${spark} ` : `${prev} ${spark} `;
      handleTextChange({ target: { value: next } } as any);
      return next;
    });
  };

  // Outline checklist parsed from plan
  const planItems = useMemo(() => {
    if (!session.workingPlan || !session.workingPlan.trim()) {
      return [
        { label: 'Mở bài và Luận điểm chính', desc: 'Khẳng định lập trường và định hướng bài viết' },
        { label: 'Thân bài đoạn 1', desc: 'Luận điểm bổ trợ cốt lõi và dẫn chứng' },
        { label: 'Thân bài đoạn 2', desc: 'Nhượng bộ, phản biện hoặc lý lẽ thứ hai' },
        { label: 'Kết luận', desc: 'Đúc kết và suy ngẫm mở rộng' }
      ];
    }

    // Try parsing as structured JSON
    const trimmed = session.workingPlan.trim();
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        const items: { label: string; desc: string }[] = [];
        if (obj.thesis) items.push({ label: 'Mở bài / Luận điểm chính', desc: obj.thesis });
        if (obj.propA || obj.counterargument) {
          items.push({ label: 'Thân bài 1: Nhượng bộ và Phản biện', desc: obj.propA || obj.counterargument });
        }
        if (obj.propB || (obj.bodyArguments && obj.bodyArguments[0])) {
          items.push({ label: 'Thân bài 2: Bác bỏ và Khẳng định', desc: obj.propB || (Array.isArray(obj.bodyArguments) ? obj.bodyArguments[0] : obj.bodyArguments) });
        }
        if (obj.propC || obj.conclusion) {
          items.push({ label: 'Kết luận và Giải pháp', desc: obj.propC || obj.conclusion });
        }
        if (items.length > 0) return items;
      } catch (e) {
        // Fallback to text lines
      }
    }

    const lines = session.workingPlan.split('\n').filter((l) => l.trim().length > 0 && !l.trim().startsWith('['));
    if (lines.length >= 2) {
      return lines.slice(0, 4).map((line, idx) => ({
        label: `Phần ${idx + 1}`,
        desc: line.replace(/^[0-9\.\-\*\#\s•]+/, '').trim()
      }));
    }
    return [
      { label: 'Luận điểm và Dàn ý', desc: session.workingPlan.slice(0, 80) },
      { label: 'Phát triển thân bài', desc: 'Khai triển các luận cứ chính' },
      { label: 'Kết luận', desc: 'Tổng kết và đúc kết nhận định' }
    ];
  }, [session.workingPlan]);


  return (
    <div className="flex flex-col w-full">
      {/* Top Studio Control Bar & Workflow Breadcrumb */}
      <div className="w-full flex flex-wrap items-center justify-between gap-3 mb-4">
        <span className={`${glass.label} ${glass.labelInk}`}>
          {isRevising ? 'Bước 4 · Chỉnh sửa và hoàn thiện bản nháp' : 'Bước 2 · Viết bản nháp'}
        </span>

        {/* Status & Utility Controls */}
        <div className="flex items-center gap-space-sm">
          <button
            onClick={() => setIsZen(!isZen)}
            aria-pressed={isZen}
            className={`${glass.btn} ${glass.btnSm} ${isZen ? glass.btnPrimary : glass.btnSoft}`}
            type="button"
          >
            <span className="material-symbols-outlined text-[18px]">
              {isZen ? 'close_fullscreen' : 'fit_screen'}
            </span>
            <span className="font-label-sm text-label-sm">
              {isZen ? 'Giao diện chuẩn' : 'Chế độ tập trung'}
            </span>
          </button>
        </div>
      </div>

      {conflictError && (
        <div className={`${glass.verdict} mb-4 text-sm`} data-v="bad" role="alert">
          <span className="material-symbols-outlined text-[20px] shrink-0">error</span>
          <span>{conflictError}</span>
        </div>
      )}

      {/* 3-Column Immersive Writing Studio */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-lg items-start w-full">
        {/* ================================================================= */}
        {/* LEFT COLUMN (Collapsible Task & Outline Guide - 25% / col-span-3) */}
        {/* ================================================================= */}
        {!isZen && (
          <aside className="xl:col-span-3 flex flex-col gap-space-md order-2 xl:order-1">
            {/* Essay Prompt Card */}
            <section className={`${glass.panel} p-4`}>
              <div className="flex items-center justify-between mb-space-xs">
                <span className="font-label-stamp text-label-stamp uppercase text-secondary tracking-wider font-bold">
                  {session.taskSnapshot?.category || 'Academic'} • Đề bài
                </span>
                {session.taskSnapshot?.targetCefr && (
                  <span className="inline-flex items-center font-label-stamp text-label-stamp px-2.5 py-1 rounded-md bg-tertiary-fixed/40 text-tertiary font-bold shadow-2xs">
                    Mục tiêu {session.taskSnapshot.targetCefr}
                  </span>
                )}
              </div>
              <h2 className="font-headline-sm text-headline-sm text-on-surface font-semibold leading-snug">
                {session.taskSnapshot?.title || 'Không gian viết nháp'}
              </h2>
              <p className="font-body-sm text-body-sm text-on-surface-variant mt-space-xs italic">
                “{session.taskSnapshot?.prompt}”
              </p>
            </section>

            {/* Task Visual Chart (IELTS Task 1 / Visual Data) */}
            {session.taskSnapshot?.visualData && (
              <section className={`${glass.panel} p-3`}>
                <TaskVisualChart visualData={session.taskSnapshot.visualData} />
              </section>
            )}

            {/* Word Count Target Widget */}
            <section className={`${glass.panel} p-4 flex flex-col gap-space-xs`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-space-2xs text-on-surface">
                  <span className="material-symbols-outlined text-[18px] text-primary">text_snippet</span>
                  <span className="font-label-md text-label-md">Độ dài bài viết</span>
                </div>
                <span className="font-label-stamp text-label-stamp text-outline">
                  Mục tiêu: {targetMin}–{targetMax} từ
                </span>
              </div>
              <div className="flex items-baseline justify-between mt-space-2xs">
                <span className="font-display-hero text-[30px] leading-tight text-on-surface font-medium">
                  {wordCount} <span className="font-body-sm text-body-sm text-outline">từ</span>
                </span>
                <span className="font-label-stamp text-label-stamp text-tertiary-container font-semibold">
                  {progressPct}% mức tối thiểu
                </span>
              </div>
              {/* Custom Gauge Visualization */}
              <div
                className={`${glass.gauge} mt-space-2xs`}
                role="meter"
                aria-label="Độ dài bài viết so với mục tiêu"
                aria-valuemin={0}
                aria-valuemax={targetMax}
                aria-valuenow={Math.min(wordCount, targetMax)}
                style={{ ['--p' as string]: `${Math.min(100, (wordCount / targetMax) * 100)}%`, ['--m' as string]: `${Math.min(100, (targetMin / targetMax) * 100)}%` }}
              >
                <i />
                <b aria-hidden="true" />
              </div>
              <div className="flex justify-between items-center text-outline-variant font-label-stamp text-label-stamp pt-space-2xs">
                <span>0 từ</span>
                <span>{targetMin} (Tối thiểu)</span>
                <span>{targetMax} (Tối đa)</span>
              </div>
            </section>

            {/* Argument Architecture Checklist */}
            <section className={`${glass.panel} p-4`}>
              <div className="flex items-center justify-between mb-space-sm">
                <span className="font-label-md text-label-md text-on-surface font-semibold">
                  Cấu trúc các luận điểm
                </span>
                <span className={glass.chip}>
                  {session.workingPlan && session.workingPlan.trim() ? 'Từ dàn ý của bạn' : 'Khung gợi ý'}
                </span>
              </div>
              <div className="space-y-space-xs">
                {planItems.map((item, idx) => {
                  return (
                    <div
                      key={idx}
                      className="flex items-start gap-space-xs p-space-xs rounded-lg text-on-surface"
                    >
                      <span className="mt-0.5 grid place-items-center w-5 h-5 shrink-0 rounded-full bg-primary/10 text-primary text-[11px] font-bold">
                        {idx + 1}
                      </span>
                      <div className="flex flex-col min-w-0">
                        <span className="font-label-sm text-label-sm font-semibold">
                          {item.label}
                        </span>
                        <span className="font-body-sm text-body-sm text-on-surface-variant truncate">
                          {item.desc}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Curated Lexicon Bank (Target Words) */}
            {session.taskSnapshot?.targetWords && session.taskSnapshot.targetWords.length > 0 && (
              <section className={`${glass.panel} p-4`}>
                <div className="flex items-center justify-between mb-space-xs">
                  <div className="flex items-center gap-space-2xs text-on-surface">
                    <span className="material-symbols-outlined text-secondary text-[18px]">lightbulb</span>
                    <span className="font-label-md text-label-md font-semibold">Từ vựng mục tiêu</span>
                  </div>
                  <span className="font-label-stamp text-label-stamp text-outline-variant uppercase">Nhấn để chèn từ</span>
                </div>
                <div className="flex flex-wrap gap-space-xs">
                  {session.taskSnapshot.targetWords.map((spark: string) => {
                    const used = text.toLowerCase().includes(spark.toLowerCase());
                    return (
                      <button
                        key={spark}
                        onClick={() => handleInsertSpark(spark)}
                        type="button"
                        className={`inline-flex items-center gap-space-2xs px-space-xs py-1 rounded-full font-label-sm text-label-sm transition-colors shadow-xs cursor-pointer ${
                          used
                            ? 'bg-surface-container text-tertiary'
                            : 'bg-surface-container-high hover:bg-secondary-fixed text-on-surface'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${used ? 'bg-tertiary' : 'bg-secondary'}`}></span>
                        <span>{spark}</span>
                        {used && <span className="material-symbols-outlined text-[12px]">check</span>}
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </aside>
        )}

        {/* ================================================================= */}
        {/* CENTER COLUMN (Dominant Digital-Paper Writing Canvas)              */}
        {/* ================================================================= */}
        <main
          className={`${
            isZen
              ? 'xl:col-span-12 max-w-3xl mx-auto'
              : 'xl:col-span-6'
          } flex flex-col items-center order-1 xl:order-2 w-full`}
        >
          {/* Elevated Paper Slab */}
          <article className={`${glass.paper} w-full min-h-[740px] flex flex-col justify-between overflow-hidden`}>
            {/* margin rule of a writing sheet */}
            <div className={glass.paperMargin} aria-hidden="true"></div>

            {/* Paper Body Content */}
            <div className="px-space-md md:px-space-2xl pt-space-xl pb-space-lg flex-1 pl-14 md:pl-20 flex flex-col">
              {/* Document Formal Metadata Header */}
              <header className="mb-space-lg pb-space-sm flex flex-wrap gap-2 items-baseline justify-between text-outline border-b border-outline-variant/40">
                <span className="font-label-stamp text-label-stamp uppercase tracking-widest text-on-surface-variant font-semibold">
                  Bài luận {session.taskSnapshot?.category || 'Academic'} • Bản nháp #{session.draftCount || 1}
                </span>
                {session.taskSnapshot?.targetCefr && (
                  <span className="font-label-stamp text-label-stamp text-outline-variant">
                    Tiêu chuẩn CEFR: Trọng tâm {session.taskSnapshot.targetCefr}
                  </span>
                )}
              </header>

              {/* Essay Title (Newsreader Display Editorial) */}
              <h2 className="text-[1.65rem] md:text-[2rem] leading-tight text-on-surface mb-space-lg font-bold tracking-tight">
                {session.taskSnapshot?.title || 'Bài viết của bạn'}
              </h2>

              {/* Real Plain-Text Draft Editor seamlessly styled as manuscript prose */}
              <textarea
                id="draft-editor-textarea"
                disabled={submitting}
                value={text}
                onChange={handleTextChange}
                onBlur={handleBlur}
                placeholder="Bắt đầu viết bài luận của bạn tại đây. Nội dung được tự động lưu an toàn trong quá trình viết..."
                aria-label="Bài viết của bạn"
                lang="en"
                spellCheck
                style={{ boxShadow: 'none' }}
                className="w-full flex-1 min-h-[480px] p-0 text-on-surface font-body-xl-editorial text-body-xl-editorial leading-[1.8] placeholder:text-outline/70 bg-transparent border-none outline-none resize-y selection:bg-secondary-fixed"
              />
            </div>

          </article>

          {/* Tactile Footnote hint */}
          <p className="font-body-sm text-body-sm text-outline mt-space-sm text-center">
            Mẹo: Tạm dừng 1.5 giây hoặc bấm ra ngoài màn hình sẽ tự động đồng bộ bài viết của bạn vào cơ sở dữ liệu an toàn.
          </p>
        </main>

        {/* ================================================================= */}
        {/* RIGHT COLUMN (Quiet AI Writing Coach Atelier - 25% / col-span-3)   */}
        {/* ================================================================= */}
        {!isZen && (
          <aside className="xl:col-span-3 flex flex-col gap-space-md order-3">
            {/* Real-time Draft Pulse Metrics */}
            <section className={`${glass.panel} p-4`}>
              <div className="flex items-center justify-between mb-space-sm">
                <span className="font-label-md text-label-md text-on-surface font-semibold">Chỉ số bài nháp</span>
                <span className="font-label-stamp text-label-stamp text-outline uppercase">Thời gian thực</span>
              </div>
              <div className="space-y-space-sm">
                {/* Metric 1 */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-label-sm text-label-sm text-on-surface-variant">Độ phong phú từ vựng</span>
                    <span className="font-label-sm text-label-sm text-tertiary-container font-bold">
                      {lexicalTelemetry.diversityPct > 0 ? `${lexicalTelemetry.diversityPct}%` : 'Đang tính...'}
                    </span>
                  </div>
                  <div className="w-full bg-surface-container rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-tertiary-container h-full rounded-full transition-all duration-300"
                      style={{ width: `${lexicalTelemetry.diversityPct}%` }}
                    ></div>
                  </div>
                </div>

                {/* Metric 2 */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-label-sm text-label-sm text-on-surface-variant">Mạch lập luận</span>
                    <span className="font-label-sm text-label-sm text-primary font-semibold">
                      {lexicalTelemetry.transitionsDetected > 0 ? `${lexicalTelemetry.transitionsDetected} Từ nối` : 'Đang phát triển'}
                    </span>
                  </div>
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    {lexicalTelemetry.hasConcession
                      ? 'Đã phát hiện lập luận nhượng bộ trong bài'
                      : 'Nên thêm từ nối để liên kết các luận điểm'}
                  </p>
                </div>

                {/* Metric 3 */}
                <div className="flex items-center justify-between pt-space-xs border-t border-surface-variant/30">
                  <div className="flex items-center gap-space-2xs">
                    <span className="material-symbols-outlined text-outline-variant text-[16px]">speed</span>
                    <span className="font-label-sm text-label-sm text-on-surface-variant">Ký tự</span>
                  </div>
                  <span className="font-label-md text-label-md text-on-surface font-bold">
                    {charCount} <span className="font-label-stamp text-label-stamp text-outline font-normal">ký tự</span>
                  </span>
                </div>
              </div>
            </section>

            {/* Action: Stage Promotion / Finalize Card */}
            <section className={`${glass.panel} p-4 flex flex-col gap-space-sm`}>
              <div>
                <span className="font-headline-sm text-headline-sm text-on-surface font-semibold block leading-tight">
                  {isRevising ? 'Giai đoạn 4: Hoàn tất bài viết' : 'Sẵn sàng nhận đánh giá?'}
                </span>
                <span className="font-body-sm text-body-sm text-on-surface-variant">
                  {isRevising
                    ? 'Bạn đang ở bước hoàn thiện. Sau khi tinh chỉnh văn phong và sửa lỗi, nộp bài để nhận đánh giá 4 tiêu chí và lưu vào Portfolio.'
                    : 'Sau khi hoàn thành các đoạn văn, gửi bài để mở khóa đánh giá chi tiết về cú pháp và văn phong.'}
                </span>
              </div>

              {isRevising && onViewDiff && (
                <button
                  onClick={onViewDiff}
                  className={`${glass.btn} ${glass.btnSm} ${glass.btnSoft} w-full`}
                  type="button"
                >
                  <span className="material-symbols-outlined text-[16px]">difference</span>
                  <span>Đối chiếu với bản nháp trước</span>
                </button>
              )}

              <button
                onClick={handleSubmit}
                disabled={submitting || wordCount < 10 || saveStatus === 'CONFLICT'}
                className={`${glass.btn} ${glass.btnPrimary} w-full`}
                type="button"
              >
                <span>
                  {isRevising
                    ? submitting
                      ? 'Đang nộp bài hoàn chỉnh...'
                      : 'Nộp bài hoàn chỉnh'
                    : submitting
                    ? 'Đang phân tích bài...'
                    : 'Chuyển sang bước Đánh giá'}
                </span>
                <span className="material-symbols-outlined text-[18px]">
                  {isRevising ? 'verified' : 'arrow_forward'}
                </span>
              </button>

              {!isRevising && (
                <>
                  <button
                    onClick={handlePracticeSubmit}
                    disabled={practice.state === 'sending' || practice.state === 'done' || wordCount < targetMin || saveStatus === 'CONFLICT'}
                    className={`${glass.btn} ${glass.btnSoft} w-full whitespace-normal text-center`}
                    type="button"
                  >
                    {practice.state === 'sending' ? 'Đang nộp bài luyện tập...' : 'Nộp bài luyện tập (không chấm điểm)'}
                  </button>
                  {practice.text ? (
                    <span role={practice.state === 'error' ? 'alert' : 'status'} className={`font-body-sm text-body-sm text-center ${practice.state === 'error' ? 'text-error' : 'text-tertiary'}`}>
                      {practice.text}
                      {practice.state === 'done' && practice.id ? <> <a className="underline" href={`/knowledge-universe?source=WRITING:${practice.id}`}>Xem từ bạn đã dùng trong vũ trụ</a></> : null}
                    </span>
                  ) : wordCount < targetMin ? (
                    <span className="font-body-sm text-body-sm text-outline text-center">Cần ít nhất {targetMin} từ để nộp bài luyện tập.</span>
                  ) : null}
                </>
              )}

              <button
                onClick={() => performSave(text)}
                disabled={saveStatus === 'SAVING' || saveStatus === 'SAVED'}
                className={`${glass.btn} ${glass.btnGhost} ${glass.btnSm} w-full`}
                type="button"
              >
                {saveStatus === 'SAVING' ? 'Đang lưu...' : saveStatus === 'SAVED' ? 'Đã lưu tất cả thay đổi' : 'Lưu thủ công'}
              </button>

              <span className="font-body-sm text-body-sm text-outline text-center">
                {isRevising
                  ? 'Đánh giá 4 tiêu chí chuẩn hóa và lưu trữ bài viết lâu dài.'
                  : 'Mở khóa nhận xét cấu trúc, kiểm tra tính tự nhiên và hướng dẫn tự chỉnh sửa.'}
              </span>
            </section>
          </aside>
        )}
      </div>
    </div>
  );
};
