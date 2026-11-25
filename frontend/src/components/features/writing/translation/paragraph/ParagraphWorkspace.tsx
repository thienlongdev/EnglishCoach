'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ParagraphSession,
  ParagraphSessionItem,
  ParagraphFeedback,
  ParagraphAttemptResponse
} from '@/types/paragraphTranslation';
import { paragraphTranslationApi } from '@/services/paragraphTranslationApi';
import { ParagraphHintAccordion } from './ParagraphHintAccordion';
import { ParagraphFeedbackPanel } from './ParagraphFeedbackPanel';
import { QuickDictionaryPopover } from '@/components/features/dictionary/QuickDictionaryPopover';
import { getTextareaSelectionAnchor } from '@/lib/writing/textarea-caret';
import { getLexicalTokens } from '@/services/dictionaryService';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Send,
  Loader2,
  CheckCircle,
  AlertCircle,
  Search,
  Info,
  ExternalLink
} from 'lucide-react';

export type ParagraphSaveStatus = 'CLEAN_SAVED' | 'DIRTY' | 'SAVING' | 'ERROR' | 'CONFLICT';

import { glass } from '../../glass/WritingGlass';
interface ParagraphWorkspaceProps {
  session: ParagraphSession;
  userId: number;
  onBackToHome: () => void;
  onSessionUpdated: (session: ParagraphSession) => void;
}

export const ParagraphWorkspace: React.FC<ParagraphWorkspaceProps> = ({
  session,
  userId,
  onBackToHome,
  onSessionUpdated
}) => {
  const currentIndex = session.currentIndex ?? 0;
  const currentItem: ParagraphSessionItem | undefined =
    session.items?.find((it) => it.ordinal === currentIndex) || session.items?.[0];

  const [navigating, setNavigating] = useState<boolean>(false);
  const [inputOrdinal, setInputOrdinal] = useState<string>(String(currentIndex + 1));

  // Synchronize numeric input whenever currentIndex changes (via prev/next, direct jump, back/forward, reload)
  useEffect(() => {
    setInputOrdinal(String(currentIndex + 1));
  }, [currentIndex]);

  const [draftText, setDraftText] = useState<string>(currentItem?.draftText || '');
  const [draftRevision, setDraftRevision] = useState<number>(currentItem?.draftRevision || 0);
  const [saveStatus, setSaveStatus] = useState<ParagraphSaveStatus>('CLEAN_SAVED');

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<ParagraphFeedback | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Quick dictionary popover state
  const [popoverState, setPopoverState] = useState<{
    word: string;
    anchor: { x: number; y: number; anchorY?: number };
    contextSentence?: string;
    selectionOffsets?: { start: number; end: number };
  } | null>(null);

  const [floatingAction, setFloatingAction] = useState<{
    word: string;
    x: number;
    y: number;
    anchorY: number;
    contextSentence?: string;
    startOffset?: number;
    endOffset?: number;
  } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const draftTextRef = useRef<string>(currentItem?.draftText || '');
  const ackTextRef = useRef<string>(currentItem?.draftText || '');
  const draftRevisionRef = useRef<number>(currentItem?.draftRevision || 0);
  const saveRequestIdRef = useRef<number>(0);
  const latestAckReqIdRef = useRef<number>(0);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize draft when passage changes
  useEffect(() => {
    if (currentItem) {
      const initialText = currentItem.draftText || '';
      const initialRev = currentItem.draftRevision || 0;
      setDraftText(initialText);
      draftTextRef.current = initialText;
      ackTextRef.current = initialText;
      draftRevisionRef.current = initialRev;
      setDraftRevision(initialRev);
      setSaveStatus('CLEAN_SAVED');
      setFeedback(null);
      setErrorMessage(null);
      setFloatingAction(null);
      setPopoverState(null);

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      // Check if item already has attempts
      paragraphTranslationApi.getAttemptsForItem(session.sessionId, currentItem.itemId)
        .then(attempts => {
          if (attempts && attempts.length > 0 && attempts[0].feedback) {
            setFeedback(attempts[0].feedback);
          }
        })
        .catch(err => console.warn('Could not fetch item attempts:', err));
    }
  }, [session.sessionId, currentItem?.itemId, currentItem?.ordinal]);

  // Clean up debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, []);

  // Truthful CAS autosave with stale and out-of-order response protection
  const persistDraft = useCallback(async (textToSave: string) => {
    if (!currentItem) return;

    // Skip redundant save if this exact text is already acknowledged and revision is established
    if (textToSave === ackTextRef.current && draftRevisionRef.current > 0) {
      if (draftTextRef.current === ackTextRef.current) {
        setSaveStatus('CLEAN_SAVED');
      }
      return;
    }

    const reqId = ++saveRequestIdRef.current;
    const currentExpectedRev = draftRevisionRef.current;
    setSaveStatus('SAVING');

    try {
      const res = await paragraphTranslationApi.saveDraft(session.sessionId, {
        ordinal: currentItem.ordinal,
        draftText: textToSave,
        expectedRevision: currentExpectedRev,
        clientMutationId: `draft-${session.sessionId}-${currentItem.ordinal}-${Date.now()}`
      });

      // Out-of-order response protection: ignore responses older than our latest acknowledged request
      if (reqId < latestAckReqIdRef.current) {
        return;
      }
      latestAckReqIdRef.current = reqId;

      // Update internal revision monotonically
      if (res.draftRevision >= draftRevisionRef.current) {
        draftRevisionRef.current = res.draftRevision;
        setDraftRevision(res.draftRevision);
      }
      ackTextRef.current = textToSave;

      // Truthful check: ONLY show green "Đã lưu" if acknowledged text matches CURRENT editor text
      if (draftTextRef.current === textToSave) {
        setSaveStatus('CLEAN_SAVED');
      } else {
        // User typed newer text while this save was in flight (STALE RESPONSE PROTECTION)
        setSaveStatus('DIRTY');
        // Ensure pending edits get debounced and saved
        if (!debounceTimerRef.current) {
          debounceTimerRef.current = setTimeout(() => {
            debounceTimerRef.current = null;
            persistDraft(draftTextRef.current);
          }, 600);
        }
      }
    } catch (err: any) {
      if (reqId < latestAckReqIdRef.current) {
        return;
      }
      if (err?.response?.status === 409) {
        console.warn('Draft CAS conflict detected');
        setSaveStatus('CONFLICT');
      } else {
        console.warn('Failed to save draft:', err);
        setSaveStatus('ERROR');
      }
    }
  }, [session.sessionId, currentItem]);

  const handleDraftChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    setDraftText(newText);
    draftTextRef.current = newText;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    // If edited back to the acknowledged content:
    if (newText === ackTextRef.current) {
      setSaveStatus('CLEAN_SAVED');
      return;
    }

    // Immediately leave green saved state:
    setSaveStatus('DIRTY');

    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      persistDraft(newText);
    }, 600);
  };

  // Submit attempt with single-flight & duplicate protection
  const handleSubmit = async () => {
    if (!currentItem || submitting || !draftText.trim()) return;

    // Flush any pending draft save before submission
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (draftTextRef.current !== ackTextRef.current) {
      try {
        await persistDraft(draftTextRef.current);
      } catch (e) {
        // non-blocking for submission
      }
    }

    setSubmitting(true);
    setErrorMessage(null);

    const clientMutationId = `sub-${session.sessionId}-${currentItem.ordinal}-${Date.now()}`;

    try {
      const response = await paragraphTranslationApi.submitAttempt(session.sessionId, {
        ordinal: currentItem.ordinal,
        action: 'SUBMIT',
        clientMutationId,
        submittedText: draftText.trim()
      });

      if (response.feedback) {
        setFeedback(response.feedback);
      }

      // Refresh session state
      const updatedSession = await paragraphTranslationApi.getSession(session.sessionId);
      onSessionUpdated(updatedSession);
    } catch (err: any) {
      console.error('Submission failed:', err);
      setErrorMessage(
        err?.response?.data?.message ||
        'Hệ thống chấm AI tạm thời gián đoạn. Bản dịch của bạn đã được lưu an toàn, vui lòng thử lại.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Navigate ordinal
  const handleNavigate = async (targetOrdinal: number) => {
    if (targetOrdinal < 0 || targetOrdinal >= session.totalItems || navigating) return;

    // Flush any pending draft save before navigating away
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (draftTextRef.current !== ackTextRef.current) {
      try {
        await persistDraft(draftTextRef.current);
      } catch (e) {
        // non-blocking for navigation
      }
    }

    setNavigating(true);
    try {
      const updated = await paragraphTranslationApi.navigateSession(session.sessionId, targetOrdinal);
      onSessionUpdated(updated);
    } catch (err) {
      console.error('Failed to navigate paragraph session:', err);
    } finally {
      setNavigating(false);
    }
  };

  // Direct jump ordinal commit (Enter or Blur)
  const handleCommitOrdinal = () => {
    const raw = inputOrdinal.trim();
    const parsed = parseInt(raw, 10);
    if (!raw || isNaN(parsed)) {
      setInputOrdinal(String(currentIndex + 1));
      return;
    }

    let target1Based = parsed;
    if (target1Based < 1) {
      target1Based = 1;
    } else if (target1Based > session.totalItems) {
      target1Based = session.totalItems;
    }

    setInputOrdinal(String(target1Based));
    const target0Based = target1Based - 1;
    if (target0Based !== currentIndex) {
      handleNavigate(target0Based);
    }
  };

  // Skip passage
  const handleSkip = async () => {
    if (!currentItem) return;
    if (window.confirm('Bạn có muốn bỏ qua đoạn văn này để chuyển sang đoạn tiếp theo không?')) {
      try {
        const updated = await paragraphTranslationApi.skipItem(session.sessionId, currentItem.ordinal);
        onSessionUpdated(updated);
      } catch (err) {
        console.error('Failed to skip item:', err);
      }
    }
  };

  // Dismiss floating action on outside click or Escape
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-floating-action="true"]') || target === textareaRef.current) {
        return;
      }
      setFloatingAction(null);
    };

    const handleKeyEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFloatingAction(null);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyEscape);
    };
  }, []);

  // Text selection handler for Quick Dictionary
  const handleTextareaSelection = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === null || end === null || start === end) {
      setFloatingAction(null);
      return;
    }

    const rawText = textarea.value.substring(start, end).trim();
    if (!rawText) {
      setFloatingAction(null);
      return;
    }

    const tokens = getLexicalTokens(rawText);
    if (tokens.length === 0 || tokens.length > 5) {
      setFloatingAction(null);
      return;
    }

    const cleanWord = tokens.join(' ').toLowerCase();
    const anchor = getTextareaSelectionAnchor(textarea, start, end);

    setFloatingAction({
      word: cleanWord,
      x: anchor.x,
      y: anchor.y,
      anchorY: anchor.anchorY,
      contextSentence: textarea.value,
      startOffset: start,
      endOffset: end
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  const wordCount = draftText.trim() ? draftText.trim().split(/\s+/).length : 0;

  if (!currentItem) {
    return (
      <div className={`${glass.panel} ${glass.state} max-w-lg mx-auto my-8`}>
        <p className={glass.stateText}>Đoạn văn không khả dụng hoặc đã hoàn thành.</p>
        <button
          type="button"
          onClick={onBackToHome}
          className={`${glass.btn} ${glass.btnPrimary}`}
        >
          Quay về danh mục
        </button>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col gap-6 pb-20">
      {/* Top Header Bar */}
      <header className={`${glass.panel} ${glass.toolbar}`}>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBackToHome}
            className={glass.iconBtn}
            title="Quay lại danh mục"
            aria-label="Quay lại danh mục"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className={`${glass.label} ${glass.labelInk}`}>
                Luyện dịch đoạn văn
              </span>
              <span className="text-outline text-xs">•</span>
              <span className="text-xs font-semibold text-secondary px-2 py-0.5 rounded-md bg-surface-container font-mono">
                {currentItem.topic || 'GENERAL'}
              </span>
            </div>
            <h2 className="font-title-md text-title-md font-bold text-on-surface truncate max-w-md">
              {currentItem.sourceTitle || 'Bài văn chuẩn ngữ liệu'}
            </h2>
          </div>
        </div>

        {/* Navigation & Progress */}
        <div className="flex items-center gap-2 self-end sm:self-auto">
          {saveStatus === 'SAVING' && (
            <span className="text-[11px] text-outline flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Đang lưu...</span>
            </span>
          )}
          {saveStatus === 'CLEAN_SAVED' && (
            <span className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-medium">
              <CheckCircle className="w-3 h-3" />
              <span>Đã lưu</span>
            </span>
          )}
          {saveStatus === 'ERROR' && (
            <span className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1 font-medium">
              <AlertCircle className="w-3 h-3" />
              <span>Chưa lưu</span>
            </span>
          )}
          {saveStatus === 'CONFLICT' && (
            <span className="text-[11px] text-error flex items-center gap-1 font-medium">
              <AlertCircle className="w-3 h-3" />
              <span>Xung đột bản nháp</span>
            </span>
          )}

          <div className="flex items-center gap-1.5 border-l border-surface-container-high pl-2 ml-1">
            <button
              type="button"
              disabled={currentIndex <= 0 || navigating}
              onClick={() => handleNavigate(currentIndex - 1)}
              className="p-1.5 rounded-lg border border-surface-container-high disabled:opacity-30 cursor-pointer hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-colors"
              title="Đoạn trước"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-1 px-2 py-1 rounded-xl bg-surface-container border border-surface-container-high text-xs font-medium text-on-surface shadow-2xs">
              <span className="text-[11px] text-outline select-none hidden sm:inline">Đoạn</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={inputOrdinal}
                disabled={navigating}
                onChange={(e) => setInputOrdinal(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.currentTarget.blur();
                  } else if (e.key === 'Escape') {
                    setInputOrdinal(String(currentIndex + 1));
                    e.currentTarget.blur();
                  }
                }}
                onBlur={handleCommitOrdinal}
                aria-label="Số thứ tự đoạn văn"
                className="w-14 text-center py-0.5 px-1 bg-surface-container-lowest border border-surface-container-high rounded-md font-bold font-mono text-xs text-primary focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all disabled:opacity-50"
              />
              <span className="text-outline select-none">/</span>
              <span className="font-mono text-xs text-on-surface-variant select-none">
                {session.totalItems.toLocaleString('vi-VN')}
              </span>
              {navigating && (
                <Loader2 className="w-3 h-3 animate-spin text-primary ml-0.5" />
              )}
            </div>

            <button
              type="button"
              disabled={currentIndex >= session.totalItems - 1 || navigating}
              onClick={() => handleNavigate(currentIndex + 1)}
              className="p-1.5 rounded-lg border border-surface-container-high disabled:opacity-30 cursor-pointer hover:bg-surface-container text-on-surface-variant hover:text-on-surface transition-colors"
              title="Đoạn sau"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Workspace 2-Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN: Vietnamese Source Passage & Hints */}
        <div className="lg:col-span-6 space-y-4">
          <div className={`${glass.panel} ${glass.sourceCard} space-y-4`}>
            <div className="relative flex items-center justify-between text-xs text-outline pb-2 border-b border-outline-variant/40">
              <span className={`${glass.langTag} text-on-surface-variant`}>
                <span className={`${glass.langDot} ${glass.langVi}`} aria-hidden="true">VI</span>
                <span>Văn bản gốc tiếng Việt</span>
              </span>
              <span className="text-[11px] px-2 py-0.5 rounded-md bg-surface-container font-medium">
                {currentItem.genre || 'GENERAL'}
              </span>
            </div>

            {/* Passage Text */}
            <div className="relative text-base sm:text-lg leading-relaxed font-medium text-on-surface whitespace-pre-line select-text" lang="vi">
              {currentItem.sourceVi}
            </div>

            {/* Provenance attribution badge */}
            <div className="pt-3 text-[11px] text-outline border-t border-surface-container/60 space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-on-surface-variant">
                  Nguồn: Wikipedia · Wikimedia ContentTranslation{' '}
                  <span className="text-[10px] text-outline font-normal">
                    ({currentItem.licenseCode === 'CC_BY_SA_4_0' || !currentItem.licenseCode ? 'CC BY-SA 4.0' : currentItem.licenseCode.replace(/_/g, ' ')})
                  </span>
                </span>
                <div className="flex items-center gap-2 text-[10px]">
                  {currentItem.sourceUrl && (
                    <a
                      href={currentItem.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-primary hover:underline cursor-pointer"
                    >
                      <span>Bài viết gốc (EN)</span>
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  )}
                  {currentItem.sourceUrl && currentItem.targetUrl && (
                    <span className="text-outline-variant">•</span>
                  )}
                  {currentItem.targetUrl && (
                    <a
                      href={currentItem.targetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-primary hover:underline cursor-pointer"
                    >
                      <span>Bản dịch (VI)</span>
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  )}
                </div>
              </div>
              {(currentItem.sourceTitle || currentItem.targetTitle) && (
                <div className="text-[11px] text-on-surface-variant truncate">
                  {currentItem.sourceTitle && <span>{currentItem.sourceTitle}</span>}
                  {currentItem.sourceTitle && currentItem.targetTitle && <span className="mx-1 text-outline">→</span>}
                  {currentItem.targetTitle && <span className="font-medium">{currentItem.targetTitle}</span>}
                </div>
              )}
            </div>
          </div>

          {/* Reference Hints Accordion (scalable, collapsed segments) */}
          <ParagraphHintAccordion
            sessionId={session.sessionId}
            ordinal={currentItem.ordinal}
          />
        </div>

        {/* RIGHT COLUMN: Translation Editor & Feedback */}
        <div className="lg:col-span-6 space-y-4">
          <div className={`${glass.panel} ${glass.answerCard} space-y-4`}>
            <div className="flex items-center justify-between text-xs text-outline pb-2 border-b border-outline-variant/40">
              <span className={`${glass.langTag} text-on-surface-variant`}>
                <span className={`${glass.langDot} ${glass.langEn}`} aria-hidden="true">EN</span>
                <span>Bản dịch tiếng Anh của bạn</span>
              </span>
              <span className={glass.chip}>
                {wordCount} từ
              </span>
            </div>

            {/* Textarea Editor */}
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={draftText}
                onChange={handleDraftChange}
                onSelect={handleTextareaSelection}
                onMouseUp={handleTextareaSelection}
                onKeyUp={handleTextareaSelection}
                onKeyDown={handleKeyDown}
                placeholder="Nhập toàn bộ đoạn văn tiếng Anh của bạn tại đây... (Nhấn Ctrl + Enter để chấm điểm)"
                rows={9}
                lang="en"
                aria-label="Bản dịch tiếng Anh của bạn"
                className={glass.answerField}
              />
            </div>

            {/* Floating Quick Dictionary action button */}
            {floatingAction && (
              <button
                type="button"
                data-floating-action="true"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setPopoverState({
                    word: floatingAction.word,
                    anchor: { x: floatingAction.x, y: floatingAction.anchorY, anchorY: floatingAction.anchorY },
                    contextSentence: floatingAction.contextSentence || draftText,
                    selectionOffsets: floatingAction.startOffset !== undefined && floatingAction.endOffset !== undefined
                      ? { start: floatingAction.startOffset, end: floatingAction.endOffset }
                      : undefined
                  });
                  setFloatingAction(null);
                }}
                style={{
                  top: `${Math.max(10, floatingAction.y)}px`,
                  left: `${floatingAction.x}px`,
                  transform: 'translateX(-50%)'
                }}
                className="fixed z-50 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary text-white text-xs font-bold shadow-lg hover:scale-105 active:scale-95 transition-all cursor-pointer animate-in fade-in"
              >
                <Search className="w-3 h-3" />
                <span>Tra từ: &quot;{floatingAction.word}&quot;</span>
              </button>
            )}

            {/* Editor Bottom Actions */}
            <div className="flex items-center justify-between gap-3 pt-2">
              <button
                type="button"
                onClick={handleSkip}
                className="text-xs text-outline hover:text-on-surface hover:underline cursor-pointer"
              >
                Bỏ qua đoạn này
              </button>

              <div className="flex items-center gap-3">
                <span className="text-[11px] text-outline hidden sm:inline">
                  Ctrl + Enter
                </span>
                <button
                  type="button"
                  disabled={submitting || !draftText.trim()}
                  onClick={handleSubmit}
                  className={`${glass.btn} ${glass.btnPrimary}`}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Đang chấm bài...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      <span>Chấm bản dịch</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {errorMessage && (
              <div className="p-3.5 rounded-xl bg-error/10 border border-error/20 text-xs text-error leading-relaxed">
                {errorMessage}
              </div>
            )}
          </div>

          {/* Feedback Panel */}
          {feedback && (
            <ParagraphFeedbackPanel
              feedback={feedback}
              onRevise={() => {
                textareaRef.current?.focus();
              }}
              onContinue={() => {
                if (currentIndex + 1 < session.totalItems) {
                  handleNavigate(currentIndex + 1);
                } else {
                  onBackToHome();
                }
              }}
              isLastItem={currentIndex === session.totalItems - 1}
            />
          )}
        </div>
      </div>

      {/* Quick Dictionary Popover */}
      {popoverState && (
        <QuickDictionaryPopover
          word={popoverState.word}
          anchor={popoverState.anchor}
          contextSentence={popoverState.contextSentence}
          selectionOffsets={popoverState.selectionOffsets}
          onClose={() => setPopoverState(null)}
        />
      )}
    </div>
  );
};
