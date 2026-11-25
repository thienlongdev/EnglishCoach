'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  TranslationSession,
  TranslationUnit,
  TranslationFeedback as ITranslationFeedback,
  TranslationAttemptResponse,
  TranslationDraftResponse
} from '@/types/writing';
import { writingApi } from '@/services/writingApi';
import { apiClient } from '@/services/api-client';
import { getLexicalTokens } from '@/services/dictionaryService';
import { getTextareaSelectionAnchor } from '@/lib/writing/textarea-caret';
import { WritingStatusBadge, SaveStatus } from '../shared/WritingStatus';
import { TranslationHintBar } from './TranslationHintBar';
import { TranslationFeedback } from './TranslationFeedback';
import { QuickDictionaryPopover } from '@/components/features/dictionary/QuickDictionaryPopover';
import { DictionaryPopup } from '@/components/features/dictionary/DictionaryPopup';
import { glass, topicIdentity, Glyph } from '../glass/WritingGlass';
import { formatTranslationDifficultyLabel } from './translationDifficultyLabel';
import {
  ArrowLeft,
  Send,
  Loader2,
  BookOpen,
  AlertCircle,
  Search,
  Layers,
  CheckCircle2,
  X,
  BookmarkPlus,
  Check,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

interface TranslationWorkspaceProps {
  session: TranslationSession;
  userId: number;
  onBackToHome: () => void;
  onSessionUpdated: (updatedSession: TranslationSession) => void;
}

export const TranslationWorkspace: React.FC<TranslationWorkspaceProps> = ({
  session,
  userId,
  onBackToHome,
  onSessionUpdated
}) => {
  const currentUnit: TranslationUnit = session.currentUnit;

  // Local draft state
  const [draftText, setDraftText] = useState<string>(currentUnit.draftText || '');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('SAVED');
  const [lastSavedRevision, setLastSavedRevision] = useState<number>(session.sessionRevision);

  // Navigation state
  const [navigating, setNavigating] = useState<boolean>(false);

  // Grading / Attempt state
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [attemptResponse, setAttemptResponse] = useState<TranslationAttemptResponse | null>(null);
  const [feedback, setFeedback] = useState<ITranslationFeedback | null>(null);
  const [referenceEn, setReferenceEn] = useState<string | null>(currentUnit.referenceEn || null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Hints state
  const [loadingHint, setLoadingHint] = useState<boolean>(false);

  // Helper Detail Modal state (for collocations & multi-word vocab)
  const [selectedHelper, setSelectedHelper] = useState<{ text?: string; cue?: string; kind?: string } | null>(null);
  const [savingFlashcard, setSavingFlashcard] = useState<boolean>(false);
  const [flashcardSaved, setFlashcardSaved] = useState<boolean>(false);
  const [flashcardMsg, setFlashcardMsg] = useState<string | null>(null);

  // Floating Contextual "Dịch" Action State
  const [floatingAction, setFloatingAction] = useState<{
    word: string;
    x: number;
    y: number;
    anchorY: number;
    contextSentence?: string;
    startOffset?: number;
    endOffset?: number;
  } | null>(null);

  // Compact Anchored Dictionary Popover State
  const [popoverState, setPopoverState] = useState<{
    word: string;
    anchor: { x: number; y: number; anchorY?: number };
    contextSentence?: string;
    selectionOffsets?: { start: number; end: number };
  } | null>(null);

  // Global Full Dictionary Popup (secondary action)
  const [dictWord, setDictWord] = useState<string | null>(null);

  // Progression List Pagination State (10 units per page for scalable UI)
  const pageSize = 10;
  const totalUnits = session.totalUnits || (session.units ? session.units.length : 1);
  const totalPages = Math.max(1, Math.ceil(totalUnits / pageSize));
  const [listPage, setListPage] = useState<number>(() => {
    return Math.floor((session.currentOrdinal - 1) / pageSize);
  });
  const [jumpOrdinal, setJumpOrdinal] = useState<string>('');

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // LocalStorage recovery key
  const storageKey = `ec_trans_draft_${userId}_${session.sessionId}_${currentUnit.ordinal}`;

  // Initialize draft text when unit changes
  useEffect(() => {
    let initialText = currentUnit.draftText || '';
    if (!initialText && typeof window !== 'undefined') {
      const local = localStorage.getItem(storageKey);
      if (local) {
        initialText = local;
      }
    }
    setDraftText(initialText);
    setSaveStatus('SAVED');
    setAttemptResponse(null);
    setFeedback(null);
    setReferenceEn(currentUnit.referenceEn || null);
    setErrorMessage(null);
    setFloatingAction(null);
    setPopoverState(null);

    // Auto-sync list pagination page with current ordinal
    const targetPage = Math.floor((currentUnit.ordinal - 1) / pageSize);
  }, [currentUnit.ordinal, currentUnit.draftText, currentUnit.referenceEn, storageKey]);

  // Close floating "Dịch" action when clicking outside or pressing Escape
  useEffect(() => {
    if (!floatingAction) return;

    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-floating-action]')) return;
      setFloatingAction(null);
    };

    const handleEscapeKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFloatingAction(null);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscapeKey);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscapeKey);
    };
  }, [floatingAction]);

  // Debounced server draft save
  const persistDraft = useCallback(
    async (text: string) => {
      setSaveStatus('SAVING');
      try {
        const res: TranslationDraftResponse = await writingApi.saveTranslationDraft(session.sessionId, {
          clientMutationId: crypto.randomUUID(),
          expectedRevision: session.sessionRevision,
          draftText: text
        });
        setLastSavedRevision(res.sessionRevision);
        setSaveStatus('SAVED');
        if (typeof window !== 'undefined') {
          localStorage.setItem(storageKey, text);
        }
      } catch (err) {
        console.warn('Draft auto-save failed, saved locally', err);
        setSaveStatus('OFFLINE');
        if (typeof window !== 'undefined') {
          localStorage.setItem(storageKey, text);
        }
      }
    },
    [session.sessionId, session.sessionRevision, storageKey]
  );

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setDraftText(val);
    setSaveStatus('UNSAVED');

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      persistDraft(val);
    }, 1200);
  };

  // Submit attempt
  const handleSubmitAttempt = async () => {
    if (!draftText.trim() || submitting) return;

    setSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await writingApi.submitTranslationAttempt(session.sessionId, {
        clientMutationId: crypto.randomUUID(),
        expectedRevision: session.sessionRevision,
        answerText: draftText.trim(),
        action: 'SUBMIT'
      });

      setAttemptResponse(res);
      if (res.feedback) {
        setFeedback(res.feedback);
      }
      if (res.referenceEn) {
        setReferenceEn(res.referenceEn);
      }

      // If accepted, clear localStorage draft
      if (res.accepted && typeof window !== 'undefined') {
        localStorage.removeItem(storageKey);
      }
    } catch (err: any) {
      console.error('Submit attempt error:', err);
      const detail =
        err?.response?.data?.message ||
        'Không thể nộp bài dịch vào lúc này. Bản thảo của bạn vẫn được lưu giữ an toàn.';
      setErrorMessage(detail);
    } finally {
      setSubmitting(false);
    }
  };

  // Explicit Reference Reveal (Hiện tất cả)
  const handleRevealReference = async () => {
    if (loadingHint) return;
    setLoadingHint(true);
    try {
      const res = await writingApi.requestTranslationHint(session.sessionId, {
        clientMutationId: crypto.randomUUID(),
        expectedRevision: session.sessionRevision,
        action: 'REVEAL_REFERENCE'
      });
      if (res.referenceEn) {
        setReferenceEn(res.referenceEn);
      }
      const updatedUnit: TranslationUnit = {
        ...currentUnit,
        hintLevel: 'REFERENCE',
        referenceRevealed: true,
        visibleHints: res.visibleHints,
        maskedTokens: res.maskedTokens || currentUnit.maskedTokens,
        referenceEn: res.referenceEn
      };
      onSessionUpdated({
        ...session,
        sessionRevision: res.sessionRevision,
        currentUnit: updatedUnit
      });
    } catch (err) {
      console.error('Failed to reveal reference:', err);
    } finally {
      setLoadingHint(false);
    }
  };

  // Direct Sentence Navigation across progression list
  const handleNavigateToOrdinal = async (targetOrdinal: number) => {
    if (targetOrdinal === session.currentOrdinal || navigating || submitting) return;
    if (targetOrdinal < 1 || targetOrdinal > totalUnits) return;

    setNavigating(true);
    setErrorMessage(null);

    // 1. Flush pending debounced draft save if any
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (draftText !== (currentUnit.draftText || '')) {
      try {
        await writingApi.saveTranslationDraft(session.sessionId, {
          clientMutationId: crypto.randomUUID(),
          expectedRevision: session.sessionRevision,
          draftText,
          unitOrdinal: currentUnit.ordinal
        });
        if (typeof window !== 'undefined') {
          localStorage.setItem(storageKey, draftText);
        }
      } catch (err) {
        console.warn('Failed to save draft before navigating', err);
      }
    }

    // 2. Navigate to target sentence
    try {
      const updatedSession = await writingApi.navigateTranslationSession(session.sessionId, targetOrdinal);
      onSessionUpdated(updatedSession);
    } catch (err: any) {
      console.error('Failed to navigate sentence:', err);
      setErrorMessage(err?.response?.data?.message || 'Không thể chuyển câu lúc này.');
    } finally {
      setNavigating(false);
    }
  };

  // Helper Detail Modal Handlers
  const handleHelperClick = (helper: { text?: string; cue?: string; kind?: string }) => {
    setSelectedHelper(helper);
    setFlashcardSaved(false);
    setFlashcardMsg(null);
  };

  const handleSaveFlashcard = async () => {
    if (!selectedHelper?.text || savingFlashcard) return;
    setSavingFlashcard(true);
    setFlashcardMsg(null);
    try {
      await apiClient.post('/flashcards', {
        front: selectedHelper.text,
        back: selectedHelper.cue || '',
        example: currentUnit.sourceVi || ''
      });
      setFlashcardSaved(true);
      setFlashcardMsg('Đã lưu vào bộ thẻ Flashcard thành công!');
    } catch (err: any) {
      console.error('Save flashcard error:', err);
      setFlashcardMsg(err?.response?.data?.message || 'Không thể lưu flashcard lúc này.');
    } finally {
      setSavingFlashcard(false);
    }
  };

  // Continue to next unit or complete set
  const handleContinue = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await writingApi.submitTranslationAttempt(session.sessionId, {
        clientMutationId: crypto.randomUUID(),
        expectedRevision: session.sessionRevision,
        answerText: '',
        action: 'CONTINUE'
      });
      // Refresh session from server to advance to next unit
      const refreshed = await writingApi.getTranslationSession(session.sessionId);
      onSessionUpdated(refreshed);
      setAttemptResponse(null);
      setFeedback(null);
      setErrorMessage(null);
      if (typeof window !== 'undefined') {
        localStorage.removeItem(storageKey);
      }
    } catch (err) {
      console.error('Failed to continue session:', err);
    } finally {
      setSubmitting(false);
    }
  };

  // Revise current answer
  const handleRevise = () => {
    setAttemptResponse(null);
    setFeedback(null);
    textareaRef.current?.focus();
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd + Enter -> Submit
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmitAttempt();
    }
  };

  // Dedicated selection handler for textarea using mirror element coordinate calculation
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

  // Text selection handler for standard DOM elements (feedback, reference, etc.)
  const handleGenericTextSelection = (e: React.MouseEvent) => {
    if (e.target === textareaRef.current) return;
    if (typeof window === 'undefined') return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      return;
    }

    const rawText = sel.toString().trim();
    if (!rawText) return;

    const tokens = getLexicalTokens(rawText);
    if (tokens.length === 0 || tokens.length > 5) return;

    const cleanWord = tokens.join(' ').toLowerCase();

    let posX = e.clientX;
    let posY = e.clientY - 35;
    let anchorY = e.clientY;

    try {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.top > 0 && rect.left > 0) {
        posX = rect.left + rect.width / 2;
        posY = rect.top - 35;
        anchorY = rect.bottom;
      }
    } catch {
      // fallback
    }

    const pillX = Math.max(50, Math.min(window.innerWidth - 50, posX));
    const pillY = posY < 12 ? anchorY + 8 : posY;

    // Determine surrounding context sentence if selection is in a sentence element
    let surroundingSentence: string | undefined;
    try {
      const range = sel.getRangeAt(0);
      const containerText = range.commonAncestorContainer.textContent || '';
      if (containerText.length > 5) {
        surroundingSentence = containerText;
      }
    } catch {
      // fallback
    }

    setFloatingAction({
      word: cleanWord,
      x: pillX,
      y: pillY,
      anchorY,
      contextSentence: surroundingSentence || currentUnit.referenceEn || draftText
    });
  };

  const isCompleted = currentUnit.terminalStatus === 'ACCEPTED' || attemptResponse?.sessionCompleted;
  const canContinue = attemptResponse?.evaluationStatus === 'ACCEPTED' || currentUnit.referenceRevealed || !!attemptResponse;

  // Paged items in progression list
  const pagedUnits = (session.units || []).slice(listPage * pageSize, (listPage + 1) * pageSize);

  const handleJumpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const ord = parseInt(jumpOrdinal, 10);
    if (!isNaN(ord) && ord >= 1 && ord <= totalUnits) {
      handleNavigateToOrdinal(ord);
      setJumpOrdinal('');
    }
  };

  return (
    <div className="w-full flex flex-col gap-6 pb-20">
      {/* Top Workspace Bar */}
      <div className={`${glass.panel} ${glass.toolbar}`}>
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBackToHome}
            className={glass.back}
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Quay lại</span>
          </button>

          <Glyph tone={topicIdentity(session.topicCode).tone} icon={topicIdentity(session.topicCode).icon} small />
          <div className="flex flex-wrap items-center gap-2">
            <span className={glass.chip}>{session.topicCode}</span>
            <span className={`${glass.chip} ${glass.chipInk}`}>{formatTranslationDifficultyLabel(session.difficultyBucket)}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <WritingStatusBadge status={saveStatus} />

          <div className="flex flex-col gap-1 min-w-[8.5rem]">
            <span className="text-xs font-bold text-on-surface tabular-nums text-right">
              Câu {session.currentOrdinal} / {totalUnits}
            </span>
            <div className={glass.meter} aria-hidden="true">
              <i style={{ ['--p' as string]: `${totalUnits > 0 ? Math.min(100, Math.round((session.currentOrdinal / totalUnits) * 100)) : 0}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* Workspace Dual-Panel Layout or Completion State */}
      {session.status === 'COMPLETED' ? (
        <div className={`${glass.panel} ${glass.state} max-w-lg mx-auto my-8 animate-in fade-in zoom-in-95`}>
          <div className={glass.verdictIcon} style={{ ['--vc' as string]: 'var(--ok)', width: '4rem', height: '4rem', borderRadius: '1.35rem' }}>
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <div className="space-y-1">
            <h2 className="font-headline-sm text-headline-sm font-bold text-on-surface">
              Hoàn thành bộ bài tập!
            </h2>
            <p className="font-body-md text-body-md text-on-surface-variant leading-relaxed">
              Bạn đã hoàn thành trọn vẹn toàn bộ {totalUnits} câu của chủ đề {session.topicCode}.
            </p>
          </div>
          <div className="pt-3">
            <button
              type="button"
              onClick={onBackToHome}
              className={`${glass.btn} ${glass.btnPrimary}`}
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Quay lại danh sách bài tập</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="w-full grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Source Vietnamese Sentence + Hints */}
        <div className="lg:col-span-5 flex flex-col gap-5">
          {/* Vietnamese Source Card - Permanent dictionary button removed per requirement B1 */}
          <div className={`${glass.panel} ${glass.sourceCard} space-y-4`}>
            <div className="relative flex items-center justify-between">
              <span className={`${glass.langTag} text-on-surface-variant`}>
                <span className={`${glass.langDot} ${glass.langVi}`} aria-hidden="true">VI</span>
                Câu tiếng Việt cần dịch
              </span>
            </div>

            <p className={`${glass.sourceText} select-text`} lang="vi">
              {currentUnit.sourceVi}
            </p>
          </div>

          {/* Progressive Word-Hint & Helper Bar */}
          <TranslationHintBar
            unit={currentUnit}
            onHelperClick={handleHelperClick}
            disabled={submitting}
          />

          {/* Multi-Sentence Set Direct-Navigable Progression with Scalable Pagination */}
          {session.units && session.units.length > 1 && (
            <div className={`${glass.panel} ${glass.panelLow} p-4 space-y-3`}>
              <div className="flex items-center justify-between text-xs font-semibold text-on-surface">
                <span className="flex items-center gap-1.5 text-secondary">
                  <Layers className="w-3.5 h-3.5" />
                  <span>Trình tự bài tập</span>
                </span>
                <span className="text-on-surface-variant font-medium">
                  {session.units.filter((u) => u.terminalStatus === 'ACCEPTED').length} / {totalUnits} hoàn thành
                </span>
              </div>

              {/* Paged Sentence List */}
              <div className="space-y-1.5">
                {pagedUnits.map((u) => {
                  const isCurrent = u.ordinal === session.currentOrdinal;
                  const isAccepted = u.terminalStatus === 'ACCEPTED';

                  let statusText = 'Chờ';
                  let statusBadgeStyle = 'bg-surface-container text-on-surface-variant';
                  let rowStyle = 'bg-surface-container/40 border-surface-container-high/40 text-on-surface-variant hover:bg-surface-container/70 hover:border-surface-container-high';
                  let iconBadgeStyle = 'bg-surface-container-high text-on-surface-variant';

                  if (isCurrent) {
                    statusText = 'Đang làm';
                    statusBadgeStyle = 'bg-primary/10 text-primary border border-primary/20 font-bold';
                    rowStyle = 'bg-surface-container-lowest border-primary shadow-xs ring-1 ring-primary/25 text-on-surface font-medium';
                    iconBadgeStyle = 'bg-primary text-white';
                  } else if (isAccepted) {
                    statusText = 'Hoàn thành';
                    statusBadgeStyle = 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 font-bold';
                    rowStyle = 'bg-emerald-500/5 border-emerald-500/25 text-on-surface hover:bg-emerald-500/10';
                    iconBadgeStyle = 'bg-emerald-500 text-white';
                  }

                  return (
                    <button
                      key={u.unitId}
                      type="button"
                      onClick={() => handleNavigateToOrdinal(u.ordinal)}
                      disabled={navigating || submitting}
                      className={`w-full flex items-center justify-between p-2.5 rounded-xl border text-xs text-left transition-all cursor-pointer ${rowStyle}`}
                      title={`Chuyển tới câu ${u.ordinal}`}
                    >
                      <div className="flex items-center gap-2 min-w-0 pr-2">
                        <span
                          className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] shrink-0 ${iconBadgeStyle}`}
                        >
                          {isAccepted ? '✓' : u.ordinal}
                        </span>
                        <span className="truncate font-sans font-medium text-on-surface">
                          {u.sourceVi}
                        </span>
                      </div>

                      <span className={`shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${statusBadgeStyle}`}>
                        {statusText}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Pagination Controls for Scalable Corpus Navigation */}
              {totalPages > 1 && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-surface-container-high/60 text-xs">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setListPage((p) => Math.max(0, p - 1))}
                      disabled={listPage === 0}
                      className="p-1 rounded-lg border border-surface-container-high hover:bg-surface-container disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      title="Trang trước"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>

                    <span className="px-1 text-[11px] font-medium text-on-surface-variant">
                      Trang {listPage + 1} / {totalPages}
                    </span>

                    <button
                      type="button"
                      onClick={() => setListPage((p) => Math.min(totalPages - 1, p + 1))}
                      disabled={listPage >= totalPages - 1}
                      className="p-1 rounded-lg border border-surface-container-high hover:bg-surface-container disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                      title="Trang sau"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Quick Jump Input */}
                  <form onSubmit={handleJumpSubmit} className="flex items-center gap-1">
                    <span className="text-[11px] text-outline">Tới câu:</span>
                    <input
                      type="number"
                      min={1}
                      max={totalUnits}
                      value={jumpOrdinal}
                      onChange={(e) => setJumpOrdinal(e.target.value)}
                      placeholder={`${session.currentOrdinal}`}
                      className="w-12 px-1.5 py-0.5 rounded border border-surface-container-high bg-surface-container-lowest text-xs text-center font-mono focus:outline-none focus:border-primary"
                    />
                    <button
                      type="submit"
                      disabled={!jumpOrdinal}
                      className="px-2 py-0.5 rounded bg-surface-container hover:bg-surface-container-high text-xs font-semibold text-on-surface disabled:opacity-40 cursor-pointer"
                    >
                      Đi
                    </button>
                  </form>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column: English Input + Actions + Feedback */}
        <div className="lg:col-span-7 flex flex-col gap-5">
          {/* Translation Editor Card */}
          <div className={`${glass.panel} ${glass.answerCard} space-y-4`}>
            <div className="flex items-center justify-between">
              <span className={`${glass.langTag} text-on-surface-variant`}>
                <span className={`${glass.langDot} ${glass.langEn}`} aria-hidden="true">EN</span>
                Bản dịch tiếng Anh của bạn
              </span>
              <span className={glass.chip}>
                {draftText.trim().split(/\s+/).filter(Boolean).length} từ
              </span>
            </div>

            {/* Answer Text Area: readOnly after submission to allow text selection per requirement B2 */}
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={draftText}
                onChange={handleTextChange}
                onKeyDown={handleKeyDown}
                onSelect={handleTextareaSelection}
                onMouseUp={handleTextareaSelection}
                onKeyUp={handleTextareaSelection}
                onScroll={() => setFloatingAction(null)}
                readOnly={submitting || (!!feedback && feedback.overallStatus === 'ACCEPTED')}
                placeholder="Type your English translation here... (Nhấn Ctrl + Enter để nộp bài)"
                rows={4}
                lang="en"
                aria-label="Bản dịch tiếng Anh của bạn"
                className={`${glass.answerField} select-text cursor-text disabled:opacity-75`}
              />
            </div>

            {/* Error Message if submit failed */}
            {errorMessage && (
              <div className="p-3 bg-error-container/40 border border-error-container rounded-xl flex items-start gap-2 text-xs text-on-surface">
                <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Submit Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                <kbd className={glass.kbd}>
                  Ctrl + Enter
                </kbd>
                <span>để nộp bài</span>
              </div>

              <button
                type="button"
                onClick={handleSubmitAttempt}
                disabled={!draftText.trim() || submitting || (!!feedback && feedback.overallStatus === 'ACCEPTED')}
                className={`${glass.btn} ${glass.btnPrimary}`}
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Đang chấm điểm...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    <span>Nộp bài dịch</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Feedback Slot */}
          {feedback && (
            <div onMouseUp={handleGenericTextSelection}>
              <TranslationFeedback
                feedback={feedback}
                referenceEn={referenceEn}
                onRevise={handleRevise}
                onContinue={handleContinue}
                onRevealReference={handleRevealReference}
                canContinue={canContinue}
                isLastUnit={session.currentOrdinal >= totalUnits}
              />
            </div>
          )}
        </div>
      </div>
    )}

      {/* Helper / Collocation Detail Modal */}
      {selectedHelper && (
        <div className={`${glass.dialogScrim} animate-in fade-in duration-150`}>
          <div role="dialog" aria-modal="true" aria-label={selectedHelper.kind === 'collocation' ? 'Cụm từ gợi ý' : 'Từ vựng gợi ý'} className={`${glass.panel} max-w-md w-full p-6 space-y-5 animate-in zoom-in-95 duration-150`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-secondary">
                <BookOpen className="w-4 h-4" />
                <span className="font-label-md text-xs font-bold uppercase tracking-wider">
                  {selectedHelper.kind === 'collocation' ? 'Cụm từ gợi ý (Collocation)' : 'Từ vựng và Cụm từ gợi ý'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedHelper(null)}
                className="p-1 rounded-lg hover:bg-surface-container text-outline hover:text-on-surface transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 bg-surface-container rounded-2xl border border-surface-container-high/60 space-y-1.5">
              <div className="text-xl font-bold text-primary font-sans">
                {selectedHelper.text}
              </div>
              {selectedHelper.cue && (
                <div className="text-sm font-medium text-on-surface-variant">
                  {selectedHelper.cue}
                </div>
              )}
            </div>

            {/* Individual word lookups anchored above modal without backdrop conflict per requirement PART D */}
            {selectedHelper.text && getLexicalTokens(selectedHelper.text).length > 1 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-outline">
                  Tra từ điển từng từ trong cụm:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {getLexicalTokens(selectedHelper.text).map((token, tIdx) => (
                    <button
                      key={tIdx}
                      type="button"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setPopoverState({
                          word: token,
                          anchor: { x: rect.left + rect.width / 2, y: rect.bottom + 4 }
                        });
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface-container-lowest hover:bg-primary/10 hover:text-primary hover:border-primary/30 border border-surface-container-high text-xs font-medium text-on-surface transition-all cursor-pointer shadow-2xs"
                    >
                      <Search className="w-3 h-3 text-secondary" />
                      <span>{token}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Flashcard Action */}
            <div className="flex flex-col gap-2 pt-1 border-t border-surface-container-high/60">
              {flashcardMsg && (
                <div
                  className={`p-2.5 rounded-xl text-xs flex items-center gap-1.5 ${
                    flashcardSaved
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'
                      : 'bg-error-container/40 text-error border border-error-container'
                  }`}
                >
                  {flashcardSaved ? <Check className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                  <span>{flashcardMsg}</span>
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedHelper(null)}
                  className="px-4 py-2 rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-all cursor-pointer"
                >
                  Đóng
                </button>

                <button
                  type="button"
                  onClick={handleSaveFlashcard}
                  disabled={savingFlashcard || flashcardSaved}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white text-xs font-bold shadow-2xs hover:opacity-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {savingFlashcard ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Đang lưu...</span>
                    </>
                  ) : flashcardSaved ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Đã lưu Flashcard</span>
                    </>
                  ) : (
                    <>
                      <BookmarkPlus className="w-3.5 h-3.5" />
                      <span>Lưu vào Flashcard</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating Contextual "Dịch" Action Pill - anchored next to user selection per requirement B3 */}
      {floatingAction && (
        <button
          type="button"
          data-floating-action="true"
          onMouseDown={(e) => e.preventDefault()} // prevent clearing selection before click
          onClick={() => {
            setPopoverState({
              word: floatingAction.word,
              anchor: { x: floatingAction.x, y: floatingAction.anchorY, anchorY: floatingAction.anchorY },
              contextSentence: floatingAction.contextSentence,
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
          className="fixed z-50 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary text-white text-xs font-bold shadow-lg hover:scale-105 active:scale-95 transition-all cursor-pointer animate-in fade-in zoom-in-95"
        >
          <Search className="w-3 h-3" />
          <span>Dịch</span>
        </button>
      )}

      {/* Compact Anchored Dictionary Popover - NO full-screen dark overlay per requirement B4 */}
      {popoverState && (
        <QuickDictionaryPopover
          word={popoverState.word}
          anchor={popoverState.anchor}
          contextSentence={popoverState.contextSentence}
          selectionOffsets={popoverState.selectionOffsets}
          onClose={() => setPopoverState(null)}
          onOpenFullDictionary={(w) => {
            setPopoverState(null);
            setDictWord(w);
          }}
        />
      )}

      {/* Global Full Dictionary Popup (optional secondary view) */}
      {dictWord && (
        <div
          className="fixed inset-0 z-[80] bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setDictWord(null);
            }
          }}
        >
          <div className="relative z-[81] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <DictionaryPopup
              word={dictWord}
              onClose={() => setDictWord(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
};
