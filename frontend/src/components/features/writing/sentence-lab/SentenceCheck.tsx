'use client';

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { writingApi } from '@/services/writingApi';
import { SentenceCheckResult, FeedbackIssue } from '@/types/writing';
import { EvidenceText } from '../shared/EvidenceText';
import { formatPatternCode, getCategoryLabel, getPatternDisplayTitle } from '@/lib/writing/labels';
import { glass } from '../glass/WritingGlass';
import { echoSrc } from '@/lib/brand/echoCharacters';

interface SentenceCheckProps {
  onNavigateMistakes?: (patternCode?: string) => void;
}

export const SentenceCheck: React.FC<SentenceCheckProps> = ({ onNavigateMistakes }) => {
  const [inputText, setInputText] = useState(() => {
    if (typeof window !== 'undefined') {
      return sessionStorage.getItem('ec_sentence_lab_draft') || '';
    }
    return '';
  });
  const [targetRegister, setTargetRegister] = useState<'standard' | 'formal' | 'casual'>('standard');
  const [contextNote, setContextNote] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<SentenceCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<FeedbackIssue | null>(null);
  const [copied, setCopied] = useState(false);

  // In-flight request cancellation & fingerprint tracking
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRequestIdRef = useRef<string>('');
  const activeInputFingerprintRef = useRef<string>('');

  // Save draft text so it survives errors, retries, and tab switches
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.setItem('ec_sentence_lab_draft', inputText);
      } catch {
        // Safe fallback
      }
    }
  }, [inputText]);

  // Cleanup pending request on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const realErrorsCount = useMemo(() => {
    return result?.issues?.filter((i) => i.kind === 'ERROR').length || 0;
  }, [result]);

  const improvementsCount = useMemo(() => {
    return result?.issues?.filter((i) => (i.kind === 'IMPROVEMENT' || i.kind === 'UNCERTAIN') && i.category !== 'Style' && i.severity !== 'SUGGESTION').length || 0;
  }, [result]);

  const styleCount = useMemo(() => {
    return result?.issues?.filter((i) => i.kind !== 'ERROR' && (i.category === 'Style' || i.severity === 'SUGGESTION')).length || 0;
  }, [result]);

  const totalIssuesCount = result?.issues?.length || 0;

  const selectedIndex = useMemo(() => {
    if (!result?.issues || result.issues.length === 0 || !selectedIssue) return 0;
    const idx = result.issues.findIndex((i) => (i.id && i.id === selectedIssue.id) || (i.startOffset === selectedIssue.startOffset && i.sourceQuote === selectedIssue.sourceQuote));
    return idx >= 0 ? idx : 0;
  }, [result, selectedIssue]);

  const activeIssue = useMemo(() => {
    if (!result?.issues || result.issues.length === 0) return null;
    return result.issues[selectedIndex] || result.issues[0];
  }, [result, selectedIndex]);

  const handlePrevIssue = () => {
    if (!result?.issues || result.issues.length === 0) return;
    const newIdx = selectedIndex > 0 ? selectedIndex - 1 : result.issues.length - 1;
    setSelectedIssue(result.issues[newIdx]);
  };

  const handleNextIssue = () => {
    if (!result?.issues || result.issues.length === 0) return;
    const newIdx = selectedIndex < result.issues.length - 1 ? selectedIndex + 1 : 0;
    setSelectedIssue(result.issues[newIdx]);
  };

  const handleSelectIssueByIndex = (idx: number) => {
    if (!result?.issues || !result.issues[idx]) return;
    setSelectedIssue(result.issues[idx]);
  };

  const canonicalCorrectedSentence = useMemo(() => {
    if (result?.correctedSentence) {
      return result.correctedSentence;
    }
    const orig = result?.originalText || inputText;
    if (!orig || !result?.issues) return null;
    const errorEdits = result.issues
      .filter((i) => i.kind === 'ERROR' && i.replacement && i.replacement.trim())
      .filter((i) => i.startOffset != null && i.endOffset != null && i.startOffset >= 0 && i.endOffset <= orig.length && i.startOffset <= i.endOffset)
      .slice()
      .sort((a, b) => b.startOffset - a.startOffset);
    if (errorEdits.length === 0) return null;
    let res = orig;
    let lastStart = Infinity;
    for (const edit of errorEdits) {
      if (edit.endOffset <= lastStart && edit.startOffset <= res.length && edit.endOffset <= res.length) {
        res = res.slice(0, edit.startOffset) + edit.replacement + res.slice(edit.endOffset);
        lastStart = edit.startOffset;
      }
    }
    return res;
  }, [result, inputText]);

  // Inspection desk interactive self-fix state
  const [userFixInputs, setUserFixInputs] = useState<Record<string, string>>({});
  const [fixValidations, setFixValidations] = useState<Record<string, { isValid: boolean; message: string }>>({});
  const [openHints, setOpenHints] = useState<Record<string, boolean>>({});

  const QUICK_EXAMPLES = [
    { chip: '"She don\'t like apples."', text: "She don't like apples." },
    { chip: '"You must to submit the report."', text: "You must to submit the report." },
    { chip: '"Success depend of continuous practice."', text: "Success depend of continuous practice." },
    { chip: '"The comprehensive analysis yielded reliable conclusions."', text: "The comprehensive analysis yielded reliable conclusions." }
  ];

  const handleCheck = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isLoading) return;
    const clean = inputText.trim();
    if (!clean) return;
    if (result && result.originalText === clean && !error) return;

    // Abort previous in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const currentReqId = Math.random().toString(36).substring(2) + Date.now();
    activeRequestIdRef.current = currentReqId;
    activeInputFingerprintRef.current = clean;

    setIsLoading(true);
    setResult(null); // Clear previous result immediately: no stale result rendered while pending
    setError(null);
    setSelectedIssue(null);
    setUserFixInputs({});
    setFixValidations({});
    setOpenHints({});

    try {
      const data = await writingApi.submitSentenceCheck(
        clean,
        targetRegister,
        contextNote || undefined
      );
      if (!controller.signal.aborted && activeRequestIdRef.current === currentReqId && activeInputFingerprintRef.current === clean) {
        setResult(data);
        if (data.issues && data.issues.length > 0) {
          setSelectedIssue(data.issues[0]);
        }
      }
    } catch (err: any) {
      if (controller.signal.aborted || activeRequestIdRef.current !== currentReqId) return;
      console.error('Sentence check error:', err);
      setError(
        err.response?.data?.message ||
        'Không thể phân tích câu. Vui lòng kiểm tra kết nối và thử lại.'
      );
    } finally {
      if (!controller.signal.aborted && activeRequestIdRef.current === currentReqId) {
        setIsLoading(false);
      }
    }
  };

  const handleReset = () => {
    setResult(null);
    setError(null);
    setSelectedIssue(null);
    setUserFixInputs({});
    setFixValidations({});
    setOpenHints({});
  };

  const handleCopySentence = () => {
    const textToCopy = result?.originalText || inputText;
    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleValidateFix = (issueId: string, expectedReplacement?: string) => {
    const input = userFixInputs[issueId]?.trim().toLowerCase();
    if (!input) return;

    const expected = expectedReplacement?.trim().toLowerCase();
    if (expected && (input === expected || expected.includes(input))) {
      setFixValidations((prev) => ({
        ...prev,
        [issueId]: { isValid: true, message: '✓ Chính xác! Bạn đã sửa lỗi rất chuẩn.' }
      }));
    } else {
      setFixValidations((prev) => ({
        ...prev,
        [issueId]: { isValid: false, message: 'Chưa chính xác. Hãy xem gợi ý quy tắc bên dưới nhé.' }
      }));
    }
  };

  const toggleHint = (issueId: string) => {
    setOpenHints((prev) => ({ ...prev, [issueId]: !prev[issueId] }));
  };

  const wordCount = (result?.originalText || inputText).split(/\s+/).filter(Boolean).length;
  const charCount = (result?.originalText || inputText).length;

  return (
    <div className="space-y-6">
      {/* Analysis canvas (left) + inspection desk (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 xl:gap-6 items-start">
        {/* LEFT: Dominant Central Learning Canvas (Oversized White Tactile Card) */}
        <div className="lg:col-span-7 xl:col-span-8 flex flex-col gap-space-lg">
          {/* The Dominant Flashcard Canvas Container */}
          <div className={`${glass.panel} overflow-hidden`} style={{ borderRadius: '1.6rem' }}>
            {/* lit top edge: the lab's prism light */}
            <div className="h-1 w-full bg-gradient-to-r from-primary via-secondary-container to-tertiary-fixed-dim" aria-hidden="true" />

            {/* Tactile Paper Margin Cue: Faint Left Ochre Rule Line */}
            <div className="absolute top-0 bottom-0 left-12 w-[1px] bg-amber-500/20 pointer-events-none hidden sm:block" aria-hidden="true" />

            <div className="p-space-xl sm:pl-16 flex flex-col gap-space-lg">
              {/* Top Card Meta & Status Strip */}
              <div className="flex flex-wrap items-center justify-between gap-space-xs pb-space-sm border-b border-surface-container-high/60">
                <div className="flex items-center gap-space-xs">
                  <span className={glass.statusDot} data-state={isLoading ? 'busy' : result ? 'done' : 'idle'} aria-hidden="true" />
                  <span className="font-label-stamp text-label-stamp text-on-surface-variant tracking-wider uppercase">
                    {isLoading ? 'Đang phân tích cú pháp...' : result ? 'Đã phân tích' : 'Sẵn sàng kiểm tra'}
                  </span>
                  <span className="text-outline-variant font-label-stamp text-label-stamp">•</span>
                  <span className="font-label-stamp text-label-stamp text-on-surface-variant font-semibold">
                    {wordCount} từ
                  </span>
                  <span className="text-outline-variant font-label-stamp text-label-stamp">•</span>
                  <span className="font-label-stamp text-label-stamp text-on-surface-variant font-semibold">
                    {charCount} ký tự
                  </span>
                </div>

                <div className="flex items-center gap-space-xs">
                  <span className="font-label-stamp text-label-stamp px-space-xs py-0.5 rounded bg-surface-container-high text-primary font-bold tracking-wider uppercase">
                    {targetRegister === 'formal' ? 'VĂN PHONG TRANG TRỌNG' : targetRegister === 'casual' ? 'VĂN PHONG THÂN MẬT' : 'TIÊU CHUẨN'}
                  </span>
                  <button
                    onClick={handleCopySentence}
                    className="text-on-surface-variant hover:text-primary transition-colors p-1 cursor-pointer"
                    title="Sao chép câu"
                    type="button"
                  >
                    <span className="material-symbols-outlined text-[18px]">
                      {copied ? 'check' : 'content_copy'}
                    </span>
                  </button>
                </div>
              </div>

              {/* Main Sentence Canvas or Interactive Input */}
              {!result ? (
                <div className="relative py-space-md sm:py-space-lg space-y-4">
                  <div className="flex justify-between items-center mb-1">
                    <label
                      htmlFor="sentence-input"
                      className="font-label-stamp text-label-stamp uppercase tracking-widest text-on-surface-variant font-semibold"
                    >
                      Nhập câu tiếng Anh cần kiểm tra
                    </label>
                    <span className={`text-xs ${inputText.length > 1800 ? 'text-error font-bold' : 'text-on-surface-variant'}`}>
                      {`${inputText.length} / 2000 ký tự`}
                    </span>
                  </div>

                  <textarea
                    id="sentence-input"
                    rows={4}
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder="Nhập hoặc dán câu tiếng Anh để kiểm tra ngữ pháp, mức độ tự nhiên và cách dùng từ..."
                    maxLength={2000}
                    disabled={isLoading}
                    lang="en"
                    className={`${glass.answerField} font-body-xl-editorial text-body-xl-editorial`}
                  />

                  {/* Quick Examples with natural sample sentences */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="font-label-stamp text-label-stamp text-on-surface-variant uppercase tracking-wider">
                      Ví dụ câu mẫu:
                    </span>
                    {QUICK_EXAMPLES.map((ex, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setInputText(ex.text)}
                        disabled={isLoading}
                        title={`Chèn câu: "${ex.text}"`}
                        className={`${glass.chip} ${glass.chipInk} italic cursor-pointer hover:brightness-110`}
                      >
                        {ex.chip}
                      </button>
                    ))}
                  </div>

                  {/* Register & Context Options */}
                  <div className="pt-2 border-t border-surface-container-high/60">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className="font-label-stamp text-label-stamp text-on-surface-variant hover:text-on-surface flex items-center gap-1.5 transition-colors cursor-pointer uppercase tracking-wider"
                    >
                      <span className="material-symbols-outlined text-[16px]">tune</span>
                      <span>{showAdvanced ? 'Ẩn tùy chọn văn phong và ngữ cảnh' : 'Tùy chỉnh văn phong và ngữ cảnh'}</span>
                    </button>

                    {showAdvanced && (
                      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 p-4 rounded-xl bg-surface-container-low border border-surface-container-high">
                        <div>
                          <label className="block font-label-stamp text-label-stamp uppercase tracking-wider text-on-surface-variant mb-1">
                            Văn phong mục tiêu
                          </label>
                          <select
                            value={targetRegister}
                            onChange={(e) => setTargetRegister(e.target.value as any)}
                            className="w-full text-xs p-2 rounded-lg border border-surface-container-high bg-surface-container-lowest text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
                          >
                            <option value="formal">Trang trọng (Học thuật / Công việc)</option>
                            <option value="neutral">Trung tính (Tiếng Anh chuẩn)</option>
                            <option value="casual">Thân mật (Giao tiếp đời thường)</option>
                          </select>
                        </div>
                        <div>
                          <label className="block font-label-stamp text-label-stamp uppercase tracking-wider text-on-surface-variant mb-1">
                            Ghi chú ngữ cảnh (Tùy chọn)
                          </label>
                          <input
                            type="text"
                            value={contextNote}
                            onChange={(e) => setContextNote(e.target.value)}
                            placeholder="Ví dụ: Email gửi giáo viên hướng dẫn"
                            maxLength={300}
                            className="w-full text-xs p-2 rounded-lg border border-surface-container-high bg-surface-container-lowest text-on-surface placeholder:text-outline-variant focus:outline-none focus:ring-1 focus:ring-primary"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="relative py-space-md sm:py-space-lg space-y-4">
                  {/* Top-Level Explicit Verdict Banner */}
                  <div className={`p-3.5 rounded-xl border flex items-center gap-3 ${
                    realErrorsCount > 0
                      ? 'bg-rose-50/80 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900/40 text-rose-800 dark:text-rose-200'
                      : improvementsCount > 0
                      ? 'bg-amber-50/80 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/40 text-amber-800 dark:text-amber-200'
                      : result.grammaticallyCorrect === true
                      ? 'bg-emerald-50/80 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900/40 text-emerald-800 dark:text-emerald-200'
                      : 'bg-surface-container-low border-surface-container-high text-on-surface'
                  }`}>
                    <span className="shrink-0 flex items-center justify-center">
                      {realErrorsCount > 0 ? (
                        <span className="material-symbols-outlined text-[22px] text-rose-600">error</span>
                      ) : improvementsCount > 0 ? (
                        <img src={echoSrc('scholar', 24)} alt="Echo" width={22} height={22} className="w-[22px] h-[22px] object-contain shrink-0 select-none pointer-events-none" />
                      ) : result.grammaticallyCorrect === true ? (
                        <span className="material-symbols-outlined text-[22px] text-emerald-600">check_circle</span>
                      ) : (
                        <span className="material-symbols-outlined text-[22px] text-outline">help_outline</span>
                      )}
                    </span>
                    <div className="flex flex-col">
                      <span className="font-semibold text-sm">
                        {realErrorsCount > 0
                          ? `Phát hiện ${realErrorsCount} lỗi cần sửa`
                          : improvementsCount > 0
                          ? 'Câu đúng ngữ pháp. Có điểm cần làm rõ để diễn đạt tự nhiên hơn.'
                          : result.grammaticallyCorrect === true
                          ? 'Câu của bạn đúng.'
                          : 'Câu này có thể phụ thuộc vào ngữ cảnh.'}
                      </span>
                      {realErrorsCount > 0 && improvementsCount > 0 && (
                        <span className="text-xs opacity-90">
                          {realErrorsCount} lỗi ngữ pháp • {improvementsCount} gợi ý cải thiện
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="font-headline-lg text-headline-lg sm:text-display-hero text-on-surface leading-relaxed sm:leading-tight tracking-tight select-text selection:bg-primary-fixed">
                    <EvidenceText
                      text={result.originalText}
                      issues={result.issues}
                      selectedIssueId={selectedIssue?.id}
                      onSelectIssue={(issue) => setSelectedIssue(issue)}
                    />
                  </div>

                  {/* Contextual Quick Floating Cues Tagged to Selected Mistakes */}
                  {result.issues && result.issues.length > 0 && (
                    <div className="mt-space-lg flex flex-wrap items-center gap-space-xs pt-2">
                      <span className="font-label-stamp text-label-stamp text-on-surface-variant uppercase tracking-wider">
                        Điểm cần lưu ý:
                      </span>
                      {result.issues.map((issue, idx) => {
                        const isSelected = selectedIssue?.id === issue.id;
                        const isErr = issue.kind === 'ERROR';
                        return (
                          <button
                            key={issue.id || idx}
                            onClick={() => setSelectedIssue(issue)}
                            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full font-label-md text-label-sm shadow-xs transition-all cursor-pointer ${
                              isSelected
                                ? isErr
                                  ? 'bg-rose-200 text-error ring-2 ring-error font-bold'
                                  : 'bg-amber-200 text-on-background ring-2 ring-amber-600 font-bold'
                                : isErr
                                ? 'bg-rose-50 hover:bg-rose-100 text-error'
                                : 'bg-amber-50 hover:bg-amber-100 text-on-background'
                            }`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isErr ? 'bg-error' : 'bg-amber-600'}`} />
                            <span className="truncate max-w-[240px]">
                              {getPatternDisplayTitle(issue.title, issue.patternCode)} (Lỗi #{idx + 1})
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Restrained Pedagogic Insight Callout */}
                  <div className="flex items-start gap-space-md p-space-md rounded-xl bg-surface-container-low shadow-xs mt-space-md">
                    <div className="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-primary shrink-0 shadow-inner">
                      <span className="material-symbols-outlined text-[20px]">lightbulb</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-headline-sm text-label-md text-on-surface font-semibold">
                        Nguyên tắc tự sửa lỗi
                      </span>
                      <p className="font-body-md text-body-md text-on-surface-variant leading-relaxed">
                        Tự sửa lỗi giúp bạn ghi nhớ cấu trúc ngữ pháp sâu hơn. Hãy thử tự điền đáp án đúng ở bảng bên phải trước khi xem gợi ý hoàn chỉnh.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="p-3 rounded-xl bg-error-container text-on-error-container text-xs flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px]">error</span>
                  <span>{error}</span>
                </div>
              )}

              {/* Bottom Master Canvas Toolbar */}
              <div className="pt-space-md flex flex-col sm:flex-row items-center justify-between gap-space-md border-t border-surface-container-high/60">
                <div className="flex items-center gap-space-xs" role="status" aria-live="polite">
                  <span className={glass.statusDot} data-state={isLoading ? 'busy' : result ? 'done' : 'idle'} aria-hidden="true" />
                  <span className={glass.label}>
                    {isLoading ? 'Đang phân tích...' : result ? 'Đã phân tích' : 'Nhập câu rồi bấm Kiểm tra câu'}
                  </span>
                </div>

                <div className="flex items-center gap-space-sm w-full sm:w-auto justify-end">
                  {result ? (
                    <button
                      onClick={handleReset}
                      className={`${glass.btn} ${glass.btnSoft}`}
                      type="button"
                    >
                      Làm mới
                    </button>
                  ) : null}

                  <button
                    data-guide="sl-check"
                    onClick={handleCheck}
                    disabled={isLoading || !inputText.trim() || (result?.originalText === inputText.trim() && !error)}
                    className={`${glass.btn} ${glass.btnPrimary}`}
                    type="button"
                  >
                    {isLoading ? (
                      <span className="material-symbols-outlined text-[18px] animate-spin">sync</span>
                    ) : (
                      <img src={echoSrc('scholar', 24)} alt="Echo" width={18} height={18} className="w-[18px] h-[18px] object-contain shrink-0 select-none pointer-events-none" />
                    )}
                    <span>{isLoading ? 'Đang phân tích...' : 'Kiểm tra câu'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: Contextual Deck / Inspection Desk (Single Compact Inspector Rail) */}
        <div className="lg:col-span-5 xl:col-span-4 flex flex-col gap-space-md">
          {/* Rail Header */}
          <div className={`${glass.panel} ${glass.inspector} flex flex-col gap-2`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-space-xs">
                <span className="material-symbols-outlined text-primary text-[20px]">biotech</span>
                <span className="font-headline-sm text-label-md text-on-surface font-semibold tracking-tight">
                  Bàn kiểm tra chi tiết
                </span>
              </div>
              {totalIssuesCount > 0 ? (
                <span className="font-label-stamp text-label-stamp px-2 py-0.5 rounded-full bg-primary/10 text-primary font-bold tracking-wider">
                  {`[${selectedIndex + 1} / ${totalIssuesCount}]`}
                </span>
              ) : (
                <span className="font-label-stamp text-label-stamp px-2 py-0.5 rounded-full bg-secondary-container/20 text-secondary font-bold uppercase tracking-wider">
                  Sẵn sàng kiểm tra
                </span>
              )}
            </div>

            {/* Type-based breakdown counts */}
            {totalIssuesCount > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="px-2 py-0.5 rounded-md bg-rose-50 text-error font-semibold border border-error/20">
                  {realErrorsCount} lỗi cần sửa
                </span>
                <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 font-semibold border border-amber-200">
                  {improvementsCount} gợi ý cải thiện
                </span>
                {styleCount > 0 && (
                  <span className="px-2 py-0.5 rounded-md bg-sky-50 text-sky-800 font-semibold border border-sky-200">
                    {styleCount} phong cách
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Active Issue Inspector */}
          {activeIssue ? (() => {
            const issue = activeIssue;
            const issueId = issue.id || `issue-${selectedIndex}`;
            const isError = issue.kind === 'ERROR';
            const userFix = userFixInputs[issueId] || '';
            const validation = fixValidations[issueId];

            return (
              <div className={`${glass.panel} ${glass.inspector} flex flex-col gap-space-md`}>
                {/* Navigation Bar between issues */}
                <div className="flex items-center justify-between gap-2 pb-3 border-b border-surface-container-high/60">
                  <button
                    onClick={handlePrevIssue}
                    disabled={totalIssuesCount <= 1}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface text-xs font-semibold disabled:opacity-30 cursor-pointer transition-colors"
                    type="button"
                    title="Vấn đề trước"
                  >
                    <span className="material-symbols-outlined text-[16px]">chevron_left</span>
                    <span>Trước</span>
                  </button>

                  <div className="flex items-center gap-1.5 min-w-0 px-1 text-center">
                    <span
                      className={`font-label-stamp text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider shrink-0 ${
                        isError ? 'bg-rose-50 text-error border border-error/20' : 'bg-amber-50 text-amber-800 border border-amber-200'
                      }`}
                    >
                      {getCategoryLabel(issue.category) || (isError ? 'Lỗi ngữ pháp' : 'Gợi ý')}
                    </span>
                    <span className="font-label-stamp text-xs text-on-surface-variant font-bold">
                      #{selectedIndex + 1}
                    </span>
                  </div>

                  <button
                    onClick={handleNextIssue}
                    disabled={totalIssuesCount <= 1}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface text-xs font-semibold disabled:opacity-30 cursor-pointer transition-colors"
                    type="button"
                    title="Vấn đề kế tiếp"
                  >
                    <span>Tiếp</span>
                    <span className="material-symbols-outlined text-[16px]">chevron_right</span>
                  </button>
                </div>

                {/* Direct Issue Selector Chips */}
                {totalIssuesCount > 1 && (
                  <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5 scrollbar-thin">
                    {result!.issues.map((iss, idx) => {
                      const isSel = idx === selectedIndex;
                      const isErr = iss.kind === 'ERROR';
                      return (
                        <button
                          key={iss.id || idx}
                          onClick={() => handleSelectIssueByIndex(idx)}
                          className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                            isSel
                              ? isErr
                                ? 'bg-rose-600 text-white font-bold shadow-xs'
                                : 'bg-amber-600 text-white font-bold shadow-xs'
                              : isErr
                              ? 'bg-rose-50 text-error hover:bg-rose-100 border border-error/20'
                              : 'bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200'
                          }`}
                          type="button"
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${isSel ? 'bg-white' : isErr ? 'bg-error' : 'bg-amber-600'}`} />
                          <span>{isErr ? `Lỗi ${idx + 1}` : `Gợi ý ${idx + 1}`}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Internal Scroll Container for Issue Details */}
                <div className="max-h-[640px] overflow-y-auto overscroll-contain space-y-4 pr-1">
                  {/* Source span / affected phrase */}
                  {issue.sourceQuote && (
                    <div className={`flex items-center gap-2 p-2.5 rounded-xl border ${
                      isError
                        ? 'bg-rose-50/70 dark:bg-rose-950/20 border-error/25'
                        : 'bg-amber-50/70 dark:bg-amber-950/20 border-amber-200'
                    }`}>
                      <span className={`font-label-stamp text-label-stamp uppercase font-bold shrink-0 ${
                        isError ? 'text-error' : 'text-amber-800 dark:text-amber-300'
                      }`}>
                        {isError ? 'Vị trí sai:' : 'Cụm từ cần lưu ý:'}
                      </span>
                      <span className={`font-mono text-body-sm font-semibold ${
                        isError ? 'text-error underline decoration-wavy' : 'text-amber-900 dark:text-amber-200'
                      }`}>
                        &ldquo;{issue.sourceQuote}&rdquo;
                      </span>
                    </div>
                  )}

                  {/* Linguistic Rationale */}
                  <div className="flex flex-col gap-space-xs">
                    <div className="font-headline-sm text-headline-sm text-on-surface leading-snug break-words">
                      {getPatternDisplayTitle(issue.title, issue.patternCode)}
                    </div>
                    <p className="font-body-md text-body-md text-on-surface-variant leading-relaxed">
                      {issue.explanation}
                    </p>
                  </div>

                  {/* Concise Grammatical Rule */}
                  {issue.teachingRule && (
                    <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container-high/60">
                      <div className="flex items-center gap-1.5 font-label-stamp text-label-stamp uppercase text-primary font-bold mb-1">
                        <span className="material-symbols-outlined text-[16px]">menu_book</span>
                        <span>{isError ? 'Quy tắc ngữ pháp' : 'Lưu ý diễn đạt'}</span>
                      </div>
                      <p className="font-body-sm text-body-sm text-on-surface leading-relaxed font-medium">
                        {issue.teachingRule}
                      </p>
                    </div>
                  )}

                  {/* Contextual Temporal Consistency */}
                  {!isError && issue.patternCode === 'TEMPORAL_CONSISTENCY' && (
                    <div className="p-3.5 rounded-xl bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200 space-y-2">
                      <div className="flex items-center gap-1.5 font-label-stamp text-label-stamp uppercase text-amber-800 dark:text-amber-300 font-bold">
                        <img src={echoSrc('scholar', 24)} alt="Echo" width={16} height={16} className="w-4 h-4 object-contain shrink-0" />
                        <span>Lựa chọn ngữ nghĩa cần làm rõ</span>
                      </div>
                      <p className="text-xs text-on-surface-variant leading-relaxed">
                        Trạng từ tần suất mô tả hành vi lặp lại, trong khi mốc thời gian tương lai xác định mô tả một sự kiện đơn lẻ. Hãy làm rõ ý định diễn đạt của bạn:
                      </p>
                      <div className="grid grid-cols-1 gap-2 pt-1 text-body-sm">
                        <div className="p-2.5 rounded-lg bg-surface-container-lowest border border-amber-200/60">
                          <span className="font-bold text-on-surface block mb-0.5">Phương án A: Thói quen / Hành vi lặp lại</span>
                          <span className="text-on-surface-variant text-xs">Diễn tả hành vi thường xuyên lặp lại. Bỏ mốc thời gian tương lai cụ thể để giữ câu diễn đạt đúng nghĩa thói quen.</span>
                        </div>
                        <div className="p-2.5 rounded-lg bg-surface-container-lowest border border-amber-200/60">
                          <span className="font-bold text-on-surface block mb-0.5">Phương án B: Kế hoạch tương lai cụ thể</span>
                          <span className="text-on-surface-variant text-xs">Diễn tả một sự kiện đơn lẻ sắp diễn ra. Bỏ trạng từ chỉ tần suất hoặc dùng cấu trúc thì tương lai phù hợp cho thời điểm đó.</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Interactive Exercise Step: Try Fixing It Yourself */}
                  {isError && issue.replacement && (
                    <div className="p-space-md rounded-xl bg-surface-container-low flex flex-col gap-space-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-label-stamp text-label-stamp text-secondary font-bold uppercase">
                          Tự sửa lỗi này
                        </span>
                        <span className="font-label-stamp text-[10px] text-on-surface-variant">
                          Luyện tập chủ động
                        </span>
                      </div>

                      <div className="flex flex-col gap-space-xs">
                        <div className="flex flex-wrap items-center gap-1.5 font-headline-sm text-body-md text-on-surface bg-surface-container-lowest p-space-sm rounded-lg shadow-inner">
                          <span className="line-through text-outline font-body-sm">
                            {issue.sourceQuote}
                          </span>
                          <span className="text-on-surface-variant">→</span>
                          <input
                            className="flex-1 min-w-[120px] px-2 py-1 bg-surface-container-high rounded text-primary font-headline-sm text-body-sm focus:outline-hidden focus:bg-surface-bright placeholder:text-outline-variant font-semibold text-center"
                            placeholder="nhập từ sửa tại đây"
                            type="text"
                            value={userFix}
                            onChange={(e) =>
                              setUserFixInputs((prev) => ({ ...prev, [issueId]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                handleValidateFix(issueId, issue.replacement);
                              }
                            }}
                          />
                        </div>

                        {validation && (
                          <div
                            className={`font-body-sm text-body-sm px-1 py-0.5 font-medium ${
                              validation.isValid ? 'text-tertiary font-bold' : 'text-error'
                            }`}
                          >
                            {validation.message}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          className={`${glass.btn} ${glass.btnPrimary} ${glass.btnSm} flex-1`}
                          onClick={() => handleValidateFix(issueId, issue.replacement)}
                          type="button"
                        >
                          <span className="material-symbols-outlined text-[16px]">verified</span>
                          <span>Kiểm tra đáp án</span>
                        </button>

                        {issue.patternCode && onNavigateMistakes && (
                          <button
                            onClick={() => onNavigateMistakes(issue.patternCode)}
                            className="px-3 py-2 min-h-[38px] rounded-xl bg-surface-container hover:bg-surface-container-high text-primary border border-primary/25 font-semibold text-xs transition-colors flex items-center gap-1 cursor-pointer shadow-xs"
                            title="Xem trong Sổ tay lỗi sai"
                            type="button"
                          >
                            <span>Sổ tay lỗi</span>
                            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Recommended Replacements Selector */}
                  {isError && issue.replacement && (
                    <div className="flex flex-col gap-space-xs">
                      <span className="font-label-stamp text-label-stamp text-on-surface-variant uppercase">
                        Sửa thành:
                      </span>
                      <button
                        onClick={() =>
                          setUserFixInputs((prev) => ({ ...prev, [issueId]: issue.replacement || '' }))
                        }
                        className="group flex items-center justify-between p-space-sm rounded-xl bg-surface-container-low hover:bg-surface-container-high transition-colors text-left cursor-pointer"
                        type="button"
                      >
                        <div className="flex flex-col">
                          <span className="font-headline-sm text-body-md text-on-surface font-semibold">
                            {issue.replacement}
                          </span>
                          <span className="font-body-sm text-body-sm text-tertiary">
                            Gợi ý chuẩn xác cho vị trí này
                          </span>
                        </div>
                        <span className="font-label-stamp text-label-stamp px-2 py-0.5 rounded bg-tertiary-fixed/30 text-tertiary font-bold uppercase">
                          Áp dụng
                        </span>
                      </button>
                    </div>
                  )}

                  {/* Coherent Full Sentence Applying ALL Validated Error Replacements */}
                  {canonicalCorrectedSentence && (
                    <div className="p-3.5 rounded-xl bg-tertiary-fixed/20 border border-tertiary/30">
                      <div className="flex items-center gap-1.5 font-label-stamp text-label-stamp uppercase text-tertiary font-bold mb-1">
                        <span className="material-symbols-outlined text-[16px]">check_circle</span>
                        <span>Câu hoàn chỉnh đã sửa chuẩn xác:</span>
                      </div>
                      <p className="font-body-md text-body-md text-on-surface leading-relaxed font-semibold">
                        &ldquo;{canonicalCorrectedSentence}&rdquo;
                      </p>
                    </div>
                  )}

                  {/* Optional More Natural Version */}
                  {result?.suggestedImprovement && (
                    <div className="p-3 rounded-xl bg-surface-container-low border border-surface-container-high/60">
                      <div className="flex items-center gap-1.5 font-label-stamp text-label-stamp uppercase text-secondary font-bold mb-1">
                        <img src={echoSrc('scholar', 24)} alt="Echo" width={16} height={16} className="w-4 h-4 object-contain shrink-0" />
                        <span>Gợi ý diễn đạt tự nhiên hơn (tham khảo):</span>
                      </div>
                      <p className="font-body-sm text-body-sm text-on-surface-variant italic">
                        &ldquo;{result.suggestedImprovement}&rdquo;
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          })() : result?.grammaticallyCorrect === true ? (
            <div className="bg-surface-container-lowest rounded-2xl p-space-lg shadow-md space-y-4 border border-tertiary-fixed-dim/40">
                <div className="flex items-center gap-2 text-tertiary">
                  <span className="material-symbols-outlined text-[24px]">verified</span>
                  <span className="font-headline-sm text-headline-sm font-bold">
                    Ngữ pháp chuẩn xác!
                  </span>
                </div>
                <p className="font-body-md text-body-md text-on-surface-variant leading-relaxed">
                  Không phát hiện lỗi cấu trúc hay sự hòa hợp ngữ pháp. Câu của bạn có cú pháp rõ ràng, chia từ chuẩn xác và liên kết tự nhiên.
                </p>
                {result.suggestedImprovement && (
                  <div className="p-space-md rounded-xl bg-surface-container-low space-y-1">
                    <span className="font-label-stamp text-label-stamp uppercase text-primary font-bold">
                      Gợi ý cách diễn đạt nâng cao
                    </span>
                    <p className="font-body-md text-body-md text-on-surface font-medium italic">
                      &ldquo;{result.suggestedImprovement}&rdquo;
                    </p>
                  </div>
                )}
              </div>
            ) : result?.grammaticallyCorrect === false ? (
              <div className="bg-surface-container-lowest rounded-2xl p-space-lg shadow-md space-y-4 border border-error/30 bg-error/5">
                <div className="flex items-center gap-2 text-error">
                  <span className="material-symbols-outlined text-[24px]">error</span>
                  <span className="font-headline-sm text-headline-sm font-bold">
                    Phát hiện điểm ngữ pháp cần lưu ý
                  </span>
                </div>
                <p className="font-body-md text-body-md text-on-surface-variant leading-relaxed">
                  {result.explanation || result.grammarFeedback || 'Câu có cấu trúc chưa chuẩn xác. Vui lòng xem câu sửa đề xuất.'}
                </p>
                {result.suggestedImprovement && (
                  <div className="p-space-md rounded-xl bg-surface-container-low space-y-1">
                    <span className="font-label-stamp text-label-stamp uppercase text-primary font-bold">
                      Câu sửa đề xuất
                    </span>
                    <p className="font-body-md text-body-md text-on-surface font-medium">
                      &ldquo;{result.suggestedImprovement}&rdquo;
                    </p>
                  </div>
                )}
              </div>
            ) : result ? (
              <div className="bg-surface-container-lowest rounded-2xl p-space-lg shadow-md space-y-4 border border-amber-500/30 bg-amber-500/5">
                <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                  <span className="material-symbols-outlined text-[24px]">help_outline</span>
                  <span className="font-headline-sm text-headline-sm font-bold">
                    Chưa đủ dữ liệu kết luận
                  </span>
                </div>
                <p className="font-body-md text-body-md text-on-surface-variant leading-relaxed">
                  {result.grammarFeedback ||
                    'Câu văn có thể thiếu ngữ cảnh hoặc chưa đủ thành phần mệnh đề để xác định tính chuẩn xác ngữ pháp. Bạn có thể bổ sung thêm ngữ cảnh ở phần tùy chỉnh để phân tích sâu hơn.'}
                </p>
                {result.suggestedImprovement && (
                  <div className="p-space-md rounded-xl bg-surface-container-low space-y-1">
                    <span className="font-label-stamp text-label-stamp uppercase text-primary font-bold">
                      Gợi ý diễn đạt đầy đủ hơn
                    </span>
                    <p className="font-body-md text-body-md text-on-surface font-medium italic">
                      &ldquo;{result.suggestedImprovement}&rdquo;
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-surface-container-lowest rounded-2xl p-space-lg shadow-xs space-y-3 border border-surface-container-high/60">
                <div className="flex items-center gap-2 text-on-surface">
                  <span className="material-symbols-outlined text-[20px] text-primary">draw</span>
                  <span className="font-headline-sm text-label-md font-bold">
                    Đang chờ câu tiếng Anh
                  </span>
                </div>
                <p className="font-body-sm text-body-sm text-on-surface-variant leading-relaxed">
                  Nhập câu ở khung bên trái và bấm Kiểm tra. Bảng phân tích sẽ khoanh vùng lỗi, xếp thứ tự ưu tiên và hướng dẫn bạn tự sửa.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
  );
};
