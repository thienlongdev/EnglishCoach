'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  PublicManifestDto,
  AttemptStateDto,
  PublicGroupDto,
  PublicItemDto,
  ResponseBatchItem,
  SpeakingRuntimeStateDto,
} from '@/types/exams';
import { ReadingWorkspace } from './ReadingWorkspace';
import { ListeningPlayer } from './ListeningPlayer';
import { WritingEditor } from './WritingEditor';
import { SpeakingWorkspace } from './SpeakingWorkspace';
import { ToeicWritingWorkspace } from './ToeicWritingWorkspace';
import { ToeicListeningWorkspace } from './ToeicListeningWorkspace';
import { ToeicReadingWorkspace } from './ToeicReadingWorkspace';
import { QuestionRendererRegistry } from './QuestionRenderers';
import { StimulusRenderer } from './StimulusRenderer';
import { examsApi } from '@/services/examsApi';
import { resolveExamMediaUrl } from '@/lib/exams/media';
import { practiceScopeLabel } from '@/lib/exams/practice';
import {
  buildNavigator,
  buildQuestionNumbers,
  partNumberOf,
  runnerModeOf,
  skillLabel,
  summarizeNavigator,
  toeicPartName,
  type NavigatorEntry,
} from '@/lib/exams/runnerModel';
import { ExamRunnerHeader } from './runner/ExamRunnerHeader';
import { ExamNavigator } from './runner/ExamNavigator';
import { ExamSubmitDialog } from './runner/ExamSubmitDialog';
import { ExamDialog } from './runner/ExamDialog';
import { IeltsCbtShell } from './ielts-cbt/IeltsCbtShell';
import { ToeicIigShell } from './toeic-iig/ToeicIigShell';
import { ArrowRight, Check, Lock, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLanguage } from '@/context/LanguageContext';

interface ExamRuntimeShellProps {
  attemptId: string;
  manifest: PublicManifestDto;
  attemptState: AttemptStateDto;
  activeSectionId: string;
  remainingSeconds: number;
  saveStatus: 'SAVED' | 'SAVING' | 'UNSAVED' | 'ERROR' | 'CLOSED';
  responses?: Record<string, any>;
  onQueueAnswer?: (placementId: string, payload: any, itemId?: string) => void;
  onSaveBatch: (items: ResponseBatchItem[]) => void;
  onSubmit: (reason?: string) => Promise<void>;
  onSelectSection: (sectionId: string) => void;
  onCompleteSection?: (sectionId: string) => Promise<any>;
  /** Exams Phase 7: retries a failed autosave batch (answers stay in the local draft meanwhile). */
  onRetrySave?: () => void;
  lang?: 'en' | 'vi';
}

/**
 * Exam runner shell. Exams Phase 7: one chrome for every interaction type — header (mode, scope, timer or
 * "Không giới hạn thời gian", truthful save state, submit), a content-adaptive workspace per skill / family, and one
 * navigator (printed question numbers, answered / unanswered / current / marked, set context kept).
 */
export const ExamRuntimeShell: React.FC<ExamRuntimeShellProps> = ({
  attemptId,
  manifest,
  attemptState,
  activeSectionId,
  remainingSeconds,
  saveStatus,
  responses,
  onQueueAnswer,
  onSaveBatch,
  onSubmit,
  onSelectSection,
  onCompleteSection,
  onRetrySave,
  lang: propLang,
}) => {
  const router = useRouter();
  const { language } = useLanguage();
  const lang: 'vi' | 'en' = (propLang || language) === 'en' ? 'en' : 'vi';

  const [showExitModal, setShowExitModal] = useState(false);
  const [showAdvanceModal, setShowAdvanceModal] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [isAdvancing, setIsAdvancing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isSimulation = attemptState.mode === 'EXAM_SIMULATION';
  const runnerMode = runnerModeOf(attemptState.mode);
  // Exams Phase 6: a practice scope is UNTIMED (server sets no deadline): no countdown, answers stay editable, and no
  // audio / timer event may complete the section on the learner's behalf.
  const practiceScope = manifest.practiceScope || null;
  const activeSectionState = (attemptState.sections || []).find((s: any) => s.sectionId === activeSectionId) as any;
  const isUntimed =
    !isSimulation &&
    (practiceScope?.timingMode === 'UNTIMED' || (!activeSectionState?.deadlineAt && !attemptState.scheduledEndAt));

  const activeSectionIndex = useMemo(() => {
    const idx = manifest.sections.findIndex((s) => s.id === activeSectionId);
    return idx >= 0 ? idx : 0;
  }, [manifest, activeSectionId]);

  const activeSection = manifest.sections[activeSectionIndex] || manifest.sections[0];
  const isLastSection = activeSectionIndex === manifest.sections.length - 1;
  const nextSection = !isLastSection ? manifest.sections[activeSectionIndex + 1] : null;

  const skill = activeSection?.skill?.toUpperCase();
  const isToeic =
    manifest.family?.toUpperCase() === 'TOEIC' ||
    attemptState?.family?.toUpperCase() === 'TOEIC' ||
    (manifest as any)?.logicalKey?.toUpperCase().includes('TOEIC') ||
    manifest.title?.toUpperCase().includes('TOEIC');
  const isObjectiveSkill = skill === 'READING' || skill === 'LISTENING';

  // Printed question numbers (canonical `questionNumber`); legacy TOEIC Reading payloads fall back to 101–200.
  const questionNumbers = useMemo(
    () => buildQuestionNumbers(activeSection?.parts || [], isToeic && skill === 'READING' ? 101 : 1),
    [activeSection, isToeic, skill]
  );

  // Flatten all items in the active section for navigation
  const allSectionItems = useMemo(() => {
    const items: Array<{
      item: PublicItemDto;
      group: PublicGroupDto;
      partOrdinal: number;
      partCode: string;
      globalIndex: number;
    }> = [];
    activeSection?.parts.forEach((part) => {
      part.groups.forEach((group) => {
        group.items.forEach((item) => {
          items.push({
            item,
            group,
            partOrdinal: part.ordinal,
            partCode: part.partCode,
            globalIndex: questionNumbers.get(item.placementId) ?? items.length + 1,
          });
        });
      });
    });
    return items;
  }, [activeSection, questionNumbers]);

  const [currentItemIndex, setCurrentItemIndex] = useState<number>(0);

  useEffect(() => {
    setCurrentItemIndex(0);
  }, [activeSectionId]);

  const activeEntry = allSectionItems[currentItemIndex] || allSectionItems[0];
  const activeItem = activeEntry?.item;
  const activeGroup = activeEntry?.group;

  // Marks come back from the server on each saved response (`flagged`); `flaggedPlacements` is kept for older payloads.
  // (2026-11-16: the state endpoint never sent `flaggedPlacements`, so a reload used to lose every mark.)
  const [flaggedPlacements, setFlaggedPlacements] = useState<Set<string>>(() => {
    const marks = new Set<string>(attemptState.flaggedPlacements || []);
    Object.entries(attemptState.responses || {}).forEach(([pid, saved]: [string, any]) => {
      if (saved && typeof saved === 'object' && saved.flagged === true) marks.add(pid);
    });
    return marks;
  });

  // Audio grant for listening (section-wide recording; per-part recordings are resolved inside the workspaces)
  const [listeningAudioUrl, setListeningAudioUrl] = useState<string | undefined>(undefined);
    const listeningAudioAssetId = skill === 'LISTENING' ? activeSection?.parts
      ?.flatMap((p) => p.groups)
      ?.flatMap((g) => g.stimuli)
      ?.flatMap((s) => s.assets)
      ?.find((a) => a.mimeType?.startsWith('audio') || a.role === 'PRIMARY')?.assetId : undefined;

  useEffect(() => {
      let cancelled = false;
      setListeningAudioUrl(undefined);
      if (listeningAudioAssetId) {
        examsApi
          .createPlaybackGrant(attemptId, listeningAudioAssetId)
          .then((grant) => {
            if (cancelled) return;
            const rawUrl = grant.streamUrl || (grant as any).mediaStreamUrl || '';
            if (rawUrl) {
              const fullUrl = resolveExamMediaUrl(rawUrl) || rawUrl;
              setListeningAudioUrl(fullUrl);
            }
          })
          .catch((e) => console.warn('Failed to obtain audio playback grant', e));
      }
      return () => { cancelled = true; };
    }, [listeningAudioAssetId, attemptId]);

  const [speakingRuntimeState, setSpeakingRuntimeState] = useState<SpeakingRuntimeStateDto | null>(null);

  useEffect(() => {
    if (skill === 'SPEAKING' || (showSubmitModal && skill === 'SPEAKING')) {
      examsApi
        .getSpeakingState(attemptId)
        .then(setSpeakingRuntimeState)
        .catch((e) => console.warn('Failed to load speaking state for submit summary', e));
    }
  }, [skill, showSubmitModal, attemptId]);

  const speakingSummary = useMemo(() => {
    const part = practiceScope?.scopeType === 'IELTS_SPEAKING_PART' ? practiceScope.number : 0;
    const p1Total = !part || part === 1 ? 4 : 0;
    const p2Total = !part || part === 2 ? 1 : 0;
    const p3Total = !part || part === 3 ? 4 : 0;
    if (!speakingRuntimeState) {
      return {
        p1: { completed: 0, total: p1Total },
        p2: { completed: 0, total: p2Total },
        p3: { completed: 0, total: p3Total },
        totalCompleted: 0,
        totalExpected: p1Total + p2Total + p3Total,
      };
    }
    const completed = speakingRuntimeState.completedTurns || [];
    const p1Count = completed.filter((t) => t.partCode?.includes('1') || t.turnKey?.toLowerCase().includes('p1')).length;
    const p2Count = completed.filter((t) => t.partCode?.includes('2') || t.turnKey?.toLowerCase().includes('p2')).length;
    const p3Count = completed.filter((t) => t.partCode?.includes('3') || t.turnKey?.toLowerCase().includes('p3')).length;
    return {
      p1: { completed: Math.min(p1Total, p1Count), total: p1Total },
      p2: { completed: Math.min(p2Total, p2Count), total: p2Total },
      p3: { completed: Math.min(p3Total, p3Count), total: p3Total },
      totalCompleted: completed.length,
      totalExpected: speakingRuntimeState.totalTurns || 9,
    };
  }, [speakingRuntimeState, practiceScope]);

  const currentResponses = responses || attemptState.responses;

  const toggleFlag = (placementId: string) => {
    setFlaggedPlacements((prev) => {
      const next = new Set(prev);
      const isFlagged = !next.has(placementId);
      if (isFlagged) {
        next.add(placementId);
      } else {
        next.delete(placementId);
      }
      onSaveBatch([
        {
          placementId,
          flagged: isFlagged,
        },
      ]);
      return next;
    });
  };

  const handleAnswerChange = (placementId: string, answerValue: any) => {
    if (!isUntimed && remainingSeconds <= 0) {
      console.warn('[ExamRuntimeShell] Answer edit ignored: section time expired');
      return;
    }
    if (onQueueAnswer) {
      onQueueAnswer(placementId, answerValue);
    } else {
      onSaveBatch([
        {
          placementId,
          answerPayload: typeof answerValue === 'object' ? answerValue : { value: answerValue },
          textResponse: typeof answerValue === 'string' ? answerValue : undefined,
        },
      ]);
    }
  };

  useEffect(() => {
    if (remainingSeconds <= 0 && showAdvanceModal) {
      setShowAdvanceModal(false);
    }
  }, [remainingSeconds, showAdvanceModal]);

  const handleAdvanceSection = async () => {
    if (!onCompleteSection || isAdvancing) return;
    setIsAdvancing(true);
    try {
      await onCompleteSection(activeSection.id);
      setShowAdvanceModal(false);
      setCurrentItemIndex(0);
    } catch (err) {
      console.error('Failed to advance section:', err);
      setShowAdvanceModal(false);
    } finally {
      setIsAdvancing(false);
    }
  };

  const handleConfirmSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit('MANUAL');
      setShowSubmitModal(false);
    } catch (err) {
      console.error('Submission failed:', err);
      setSubmitError(
        lang === 'vi'
          ? 'Chưa nộp được bài. Câu trả lời của bạn vẫn được giữ — kiểm tra kết nối rồi bấm "Nộp bài" lại.'
          : 'Your test was not submitted yet. Your answers are kept — check the connection and press "Submit" again.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectPlacement = useCallback(
    (pid: string, scroll: boolean = false) => {
      const idx = allSectionItems.findIndex((e) => e.item.placementId === pid);
      if (idx < 0) return;
      setCurrentItemIndex(idx);
      if (scroll && typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          const el = document.getElementById(`item-${pid}`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
    },
    [allSectionItems]
  );

  // Navigator model (printed numbers, set context, answered / marked / current)
  const navigatorParts = useMemo(
    () =>
      buildNavigator({
        family: manifest.family,
        skill: skill || '',
        parts: activeSection?.parts || [],
        numbers: questionNumbers,
        responses: currentResponses || {},
        flagged: flaggedPlacements,
        currentPlacementId: activeItem?.placementId,
      }),
    [manifest.family, skill, activeSection, questionNumbers, currentResponses, flaggedPlacements, activeItem]
  );
  const answerSummary = useMemo(() => summarizeNavigator(navigatorParts), [navigatorParts]);

  // TOEIC Listening simulation follows the recording: other parts are not jump targets.
  const placementPart = useMemo(() => {
    const m = new Map<string, string>();
    allSectionItems.forEach((e) => m.set(e.item.placementId, e.partCode || String(e.partOrdinal)));
    return m;
  }, [allSectionItems]);
  const isLockedEntry = useCallback(
    (entry: NavigatorEntry) =>
      isSimulation && isToeic && skill === 'LISTENING' && placementPart.get(entry.placementId) !== (activeEntry?.partCode || String(activeEntry?.partOrdinal)),
    [isSimulation, isToeic, skill, placementPart, activeEntry]
  );

  const scopeLabel = useMemo(() => {
    if (!practiceScope) return null;
    const base = practiceScopeLabel(practiceScope, lang);
    if (practiceScope.scopeType === 'TOEIC_PART') {
      const name = toeicPartName(practiceScope.number, lang);
      return name ? `${base} · ${name}` : base;
    }
    return base;
  }, [practiceScope, lang]);

  const sectionStrip =
    manifest.sections.length > 1 ? (
      <div
        className="px-2 sm:px-4 pb-2 flex items-center gap-1 overflow-x-auto"
        role={isSimulation ? 'list' : 'tablist'}
        aria-label={lang === 'vi' ? 'Các phần thi' : 'Sections'}
      >
        {manifest.sections.map((sec, idx) => {
          const isActive = sec.id === activeSectionId;
          const isPast = idx < activeSectionIndex;
          const isFuture = idx > activeSectionIndex;
          const label = skillLabel(sec.skill, lang);
          if (isSimulation) {
            return (
              <div
                key={sec.id}
                role="listitem"
                id={`section-tab-${sec.skill.toLowerCase()}`}
                aria-current={isActive ? 'step' : undefined}
                className={`shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-semibold ${
                  isActive
                    ? 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-200 border border-indigo-500/40'
                    : isPast
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-muted-foreground/70'
                }`}
              >
                {isPast && <Check className="w-3.5 h-3.5" aria-hidden />}
                {isFuture && <Lock className="w-3 h-3" aria-hidden />}
                <span>
                  {idx + 1}. {label}
                </span>
                <span className="sr-only">
                  {isPast
                    ? lang === 'vi' ? '(đã hoàn thành)' : '(completed)'
                    : isFuture
                    ? lang === 'vi' ? '(chưa đến lượt)' : '(locked)'
                    : lang === 'vi' ? '(đang làm)' : '(current)'}
                </span>
              </div>
            );
          }
          return (
            <button
              key={sec.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              id={`section-tab-${sec.skill.toLowerCase()}`}
              onClick={() => {
                onSelectSection(sec.id);
                setCurrentItemIndex(0);
              }}
              className={`shrink-0 h-7 px-3 rounded-md text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isActive ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200 border border-emerald-500/40' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    ) : null;

  const sectionTitle = (() => {
    if (!activeSection) return null;
    if (isToeic && isObjectiveSkill && activeEntry) {
      const n = partNumberOf(activeEntry.partCode) ?? activeEntry.partOrdinal;
      return `${skillLabel(activeSection.skill, lang)} · Part ${n}`;
    }
    return skillLabel(activeSection.skill, lang);
  })();

  const workspaceKey = activeSection?.id || 'section';

  // IELTS computer-delivered exam room (owner brief 2026-11-13): IELTS Reading / Listening / Writing attempts render the
  // reference CBT shell over the SAME runtime callbacks (autosave, server clock, section completion, submit). `?ui=legacy`
  // keeps the previous runner for side-by-side checks. Speaking and TOEIC are unchanged.
  const [legacyUi, setLegacyUi] = useState(false);
  useEffect(() => {
    try {
      setLegacyUi(new URLSearchParams(window.location.search).get('ui') === 'legacy');
    } catch {
      setLegacyUi(false);
    }
  }, []);
  const cbtSkill = !isToeic && !legacyUi && (skill === 'READING' || skill === 'LISTENING' || skill === 'WRITING') ? (skill as 'READING' | 'LISTENING' | 'WRITING') : null;
  if (cbtSkill && activeSection) {
    return (
      <IeltsCbtShell
        key={activeSection.id}
        attemptId={attemptId}
        manifest={manifest}
        attemptState={attemptState}
        section={activeSection}
        skill={cbtSkill}
        questionNumbers={questionNumbers}
        responses={currentResponses || {}}
        remainingSeconds={remainingSeconds}
        isSimulation={isSimulation}
        isUntimed={isUntimed}
        isLastSection={isLastSection}
        saveStatus={saveStatus}
        onAnswer={handleAnswerChange}
        onRetrySave={onRetrySave}
        onSubmit={() => onSubmit('MANUAL')}
        onAdvanceSection={onCompleteSection ? async () => { await onCompleteSection(activeSection.id); } : undefined}
        onCompleteListening={isSimulation ? () => { if (onCompleteSection && activeSectionId) onCompleteSection(activeSectionId); } : undefined}
        onExit={() => router.push(`/exams/${manifest.family.toLowerCase()}`)}
        otherSections={
          !isSimulation && manifest.sections.length > 1
            ? manifest.sections
                .filter((sec) => sec.id !== activeSection.id)
                .map((sec) => ({ id: sec.id, label: skillLabel(sec.skill, 'en'), onOpen: () => onSelectSection(sec.id) }))
            : undefined
        }
      />
    );
  }

  // TOEIC computer-based exam room, IIG-style (owner brief 2026-11-16): TOEIC Listening / Reading attempts render the
  // IIG mock-informed shell over the SAME runtime callbacks (autosave, server clock, flags, section completion, submit).
  // `?ui=legacy` keeps the previous runner; TOEIC Speaking / Writing are unchanged.
  const iigSkill = isToeic && !legacyUi && (skill === 'LISTENING' || skill === 'READING') ? (skill as 'LISTENING' | 'READING') : null;
  if (iigSkill && activeSection) {
    return (
      <ToeicIigShell
        key={activeSection.id}
        attemptId={attemptId}
        manifest={manifest}
        attemptState={attemptState}
        section={activeSection}
        skill={iigSkill}
        questionNumbers={questionNumbers}
        responses={currentResponses || {}}
        flaggedPlacements={flaggedPlacements}
        onToggleFlag={toggleFlag}
        remainingSeconds={remainingSeconds}
        isSimulation={isSimulation}
        isUntimed={isUntimed}
        isLastSection={isLastSection}
        saveStatus={saveStatus}
        onAnswer={handleAnswerChange}
        onRetrySave={onRetrySave}
        onSubmit={() => onSubmit('MANUAL')}
        onCompleteListening={isSimulation ? () => { if (onCompleteSection && activeSectionId) onCompleteSection(activeSectionId); } : undefined}
        onExit={isSimulation ? undefined : () => router.push(`/exams/${manifest.family.toLowerCase()}`)}
        lang={lang}
      />
    );
  }

  return (
    <div className="flex flex-col h-[100dvh] bg-background text-foreground overflow-hidden">
      <ExamRunnerHeader
        lang={lang}
        mode={runnerMode}
        scopeLabel={scopeLabel}
        title={manifest.title}
        sectionLabel={sectionTitle}
        isUntimed={isUntimed}
        remainingSeconds={remainingSeconds}
        saveStatus={saveStatus}
        onRetrySave={onRetrySave}
        onExit={() => setShowExitModal(true)}
        sectionStrip={sectionStrip}
        action={
          isSimulation && !isLastSection
            ? {
                kind: 'advance',
                busy: isAdvancing,
                onClick: () => {
                  if (remainingSeconds > 0) {
                    setShowAdvanceModal(true);
                  } else if (onCompleteSection) {
                    handleAdvanceSection();
                  }
                },
              }
            : {
                kind: 'submit',
                busy: isSubmitting,
                onClick: () => {
                  setSubmitError(null);
                  setShowSubmitModal(true);
                },
              }
        }
      />

      {/* Content-adaptive workspace per skill / family */}
      <main className="flex-1 min-h-0 overflow-hidden relative" key={workspaceKey}>
        {skill === 'READING' && (
          isToeic ? (
            <ToeicReadingWorkspace
              attemptId={attemptId}
              parts={activeSection?.parts}
              groups={activeSection?.parts.flatMap((p) => p.groups) || []}
              responses={currentResponses}
              onAnswerChange={handleAnswerChange}
              flaggedPlacements={Array.from(flaggedPlacements)}
              onToggleFlag={toggleFlag}
              activePlacementId={activeItem?.placementId}
              onSelectPlacement={(pid) => selectPlacement(pid)}
              questionNumbers={questionNumbers}
              lang={lang}
            />
          ) : (
            <ReadingWorkspace
              attemptId={attemptId}
              parts={activeSection?.parts}
              groups={activeSection?.parts.flatMap((p) => p.groups) || []}
              responses={currentResponses}
              onAnswerChange={handleAnswerChange}
              flaggedPlacements={Array.from(flaggedPlacements)}
              onToggleFlag={toggleFlag}
              activePlacementId={activeItem?.placementId}
              onSelectPlacement={(pid) => selectPlacement(pid)}
              questionNumbers={questionNumbers}
              lang={lang}
            />
          )
        )}

        {skill === 'LISTENING' && (
          isToeic ? (
            <ToeicListeningWorkspace
              parts={activeSection?.parts}
              groups={activeSection?.parts.flatMap((p) => p.groups) || []}
              audioUrl={listeningAudioUrl}
              attemptId={attemptId}
              responses={currentResponses}
              onAnswerChange={handleAnswerChange}
              flaggedPlacements={Array.from(flaggedPlacements)}
              onToggleFlag={toggleFlag}
              activePlacementId={activeItem?.placementId}
              onSelectPlacement={(pid) => selectPlacement(pid)}
              questionNumbers={questionNumbers}
              lang={lang}
              isSimulation={isSimulation}
              remainingSeconds={remainingSeconds}
              onCompleteListening={isSimulation ? () => {
                if (onCompleteSection && activeSectionId) {
                  onCompleteSection(activeSectionId);
                }
              } : undefined}
            />
          ) : (
            <ListeningPlayer
              parts={activeSection?.parts}
              groups={activeSection?.parts.flatMap((p) => p.groups) || []}
              audioUrl={listeningAudioUrl}
              attemptId={attemptId}
              responses={currentResponses}
              onAnswerChange={handleAnswerChange}
              flaggedPlacements={Array.from(flaggedPlacements)}
              onToggleFlag={toggleFlag}
              activePlacementId={activeItem?.placementId}
              onSelectPlacement={(pid) => selectPlacement(pid)}
              questionNumbers={questionNumbers}
              lang={lang}
              isSimulation={isSimulation}
              remainingSeconds={remainingSeconds}
              onCompleteListening={isSimulation ? () => {
                if (onCompleteSection && activeSectionId) {
                  onCompleteSection(activeSectionId);
                }
              } : undefined}
            />
          )
        )}

        {skill === 'WRITING' && (
          isToeic ? (
            <ToeicWritingWorkspace
              groups={activeSection?.parts.flatMap((p) => p.groups) || []}
              responses={currentResponses}
              onAnswerChange={(placementId: string, text: string) => handleAnswerChange(placementId, text)}
              saveStatus={saveStatus}
            />
          ) : (
            <WritingEditor
              attemptId={attemptId}
              groups={activeSection?.parts.flatMap((p) => p.groups) || []}
              parts={activeSection?.parts}
              responses={currentResponses}
              onAnswerChange={(placementId: string, text: string) => handleAnswerChange(placementId, text)}
              saveStatus={saveStatus}
              lang={lang}
              isPractice={!isSimulation}
            />
          )
        )}

        {skill === 'SPEAKING' && (
          isToeic ? (
            <p role="status" className="p-6">
              {lang === 'vi' ? 'Phần thi TOEIC Speaking đã ngừng hỗ trợ.' : 'TOEIC Speaking has been retired.'}
            </p>
          ) : (
            <SpeakingWorkspace
              key={activeSection?.id ? `speaking-workspace-${activeSection.id}` : 'speaking-workspace'}
              attemptId={attemptId}
              group={activeGroup || undefined}
              item={activeItem || undefined}
              partOrdinal={activeEntry?.partOrdinal || 1}
              allSpeakingItems={allSectionItems}
              savedResponses={currentResponses}
              onSelectSpeakingItem={(pid) => selectPlacement(pid)}
              onSectionCompleted={() => {
                if (onSubmit) {
                  onSubmit('MANUAL');
                } else if (onCompleteSection && activeSectionId) {
                  onCompleteSection(activeSectionId);
                }
              }}
              lang={lang}
            />
          )
        )}

        {/* Fallback general item rendering */}
        {skill !== 'READING' && skill !== 'LISTENING' && skill !== 'WRITING' && skill !== 'SPEAKING' && activeItem && activeGroup && (
          <div className="h-full overflow-y-auto p-6 max-w-4xl mx-auto space-y-6">
            {activeGroup.stimuli && activeGroup.stimuli.length > 0 && (
              <div className="bg-card border border-border rounded-lg p-5">
                <StimulusRenderer stimuli={activeGroup.stimuli} attemptId={attemptId} />
              </div>
            )}
            <div className="bg-card border border-border rounded-lg p-6">
              <QuestionRendererRegistry
                item={activeItem}
                value={currentResponses[activeItem.placementId]}
                onChange={(val) => handleAnswerChange(activeItem.placementId, val)}
              />
            </div>
          </div>
        )}
      </main>

      {/* One navigator for every objective workspace (IELTS + TOEIC) */}
      {isObjectiveSkill && allSectionItems.length > 0 && (
        <ExamNavigator
          parts={navigatorParts}
          lang={lang}
          onSelect={(pid) => selectPlacement(pid, true)}
          isLocked={isLockedEntry}
          onPrev={() => {
            const target = allSectionItems[currentItemIndex - 1];
            if (target && !isLockedEntry({ placementId: target.item.placementId } as NavigatorEntry)) selectPlacement(target.item.placementId, true);
          }}
          onNext={() => {
            const target = allSectionItems[currentItemIndex + 1];
            if (target) selectPlacement(target.item.placementId, true);
          }}
          canPrev={currentItemIndex > 0}
          canNext={currentItemIndex < allSectionItems.length - 1}
        />
      )}

      {/* Advance section (simulation) */}
      <ExamDialog
        open={showAdvanceModal && !!nextSection}
        onClose={() => setShowAdvanceModal(false)}
        busy={isAdvancing}
        closeLabel={lang === 'vi' ? 'Đóng' : 'Close'}
        icon={
          <span className="inline-flex w-9 h-9 rounded-xl items-center justify-center bg-indigo-500/15 text-indigo-600 dark:text-indigo-300">
            <ArrowRight className="w-4 h-4" aria-hidden />
          </span>
        }
        title={
          lang === 'vi'
            ? `Chuyển sang phần ${nextSection ? skillLabel(nextSection.skill, lang) : ''}?`
            : `Move on to ${nextSection ? skillLabel(nextSection.skill, lang) : ''}?`
        }
        description={
          lang === 'vi'
            ? 'Theo quy chế thi, bạn sẽ không quay lại sửa câu trả lời của phần hiện tại sau khi chuyển.'
            : 'Under exam rules you cannot return to this section after moving on.'
        }
        footer={
          <>
            <button
              type="button"
              onClick={() => setShowAdvanceModal(false)}
              disabled={isAdvancing}
              className="h-10 px-4 rounded-xl border border-border text-sm font-semibold hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {lang === 'vi' ? 'Ở lại phần này' : 'Stay here'}
            </button>
            <button
              type="button"
              id="modal-confirm-advance-btn"
              onClick={handleAdvanceSection}
              disabled={isAdvancing}
              className="h-10 px-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {isAdvancing ? (lang === 'vi' ? 'Đang chuyển…' : 'Moving on…') : lang === 'vi' ? 'Chuyển phần' : 'Move on'}
            </button>
          </>
        }
      >
        {isObjectiveSkill && (
          <p className="text-xs text-muted-foreground">
            {lang === 'vi'
              ? `Phần hiện tại: đã trả lời ${answerSummary.answered}/${answerSummary.total} câu.`
              : `This section: ${answerSummary.answered}/${answerSummary.total} answered.`}
          </p>
        )}
      </ExamDialog>

      {/* Submit */}
      <ExamSubmitDialog
        open={showSubmitModal}
        onClose={() => setShowSubmitModal(false)}
        onConfirm={handleConfirmSubmit}
        mode={runnerMode}
        lang={lang}
        summary={isObjectiveSkill ? answerSummary : null}
        submitting={isSubmitting}
        error={submitError}
        blocked={skill === 'SPEAKING' && speakingSummary.totalCompleted < speakingSummary.totalExpected}
        wholeAttemptNote={
          isSimulation && manifest.sections.length > 1
            ? lang === 'vi'
              ? 'Đây là phần cuối — nộp bài sẽ kết thúc toàn bộ bài thi.'
              : 'This is the last section — submitting ends the whole test.'
            : null
        }
        extra={
          skill === 'SPEAKING' ? (
            <div className="p-3 bg-muted/40 rounded-xl space-y-2 text-xs">
              <div className="font-semibold text-foreground flex justify-between">
                <span>{lang === 'vi' ? 'Tiến độ phần Nói' : 'Speaking progress'}</span>
                <span className="tabular-nums">
                  {speakingSummary.totalCompleted} / {speakingSummary.totalExpected}
                </span>
              </div>
              {(['p1', 'p2', 'p3'] as const).map((k, i) => (
                <div key={k} className="flex justify-between text-muted-foreground">
                  <span>Part {i + 1}</span>
                  <span className="font-semibold text-foreground tabular-nums">
                    {speakingSummary[k].completed} / {speakingSummary[k].total}
                  </span>
                </div>
              ))}
              {speakingSummary.totalCompleted < speakingSummary.totalExpected && (
                <p className="text-rose-700 dark:text-rose-300 font-medium leading-relaxed">
                  {lang === 'vi'
                    ? 'Cần hoàn thành tất cả lượt nói trước khi nộp bài.'
                    : 'Complete every speaking turn before submitting.'}
                </p>
              )}
            </div>
          ) : null
        }
      />

      {/* Exit */}
      <ExamDialog
        open={showExitModal}
        onClose={() => setShowExitModal(false)}
        closeLabel={lang === 'vi' ? 'Đóng' : 'Close'}
        icon={
          <span className="inline-flex w-9 h-9 rounded-xl items-center justify-center bg-muted text-foreground">
            <LogOut className="w-4 h-4" aria-hidden />
          </span>
        }
        title={lang === 'vi' ? 'Tạm rời bài làm?' : 'Leave for now?'}
        description={
          !isUntimed && remainingSeconds > 0
            ? lang === 'vi'
              ? 'Đồng hồ do máy chủ quản lý vẫn tiếp tục chạy. Bạn có thể quay lại bài này từ Kho đề hoặc Lịch sử.'
              : 'The server clock keeps running. You can come back to this test from the library or history.'
            : lang === 'vi'
            ? 'Câu trả lời đã lưu vẫn được giữ. Bạn có thể tiếp tục bài này bất cứ lúc nào.'
            : 'Saved answers are kept. You can continue this attempt any time.'
        }
        footer={
          <>
            <button
              type="button"
              onClick={() => setShowExitModal(false)}
              className="h-10 px-4 rounded-xl border border-border text-sm font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {lang === 'vi' ? 'Làm tiếp' : 'Keep working'}
            </button>
            <button
              type="button"
              onClick={() => router.push(`/exams/${manifest.family.toLowerCase()}`)}
              className="h-10 px-5 rounded-xl bg-foreground text-background text-sm font-bold hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {lang === 'vi' ? 'Về kho đề' : 'Back to library'}
            </button>
          </>
        }
      >
        {saveStatus === 'ERROR' || saveStatus === 'UNSAVED' ? (
          <p className="text-xs text-amber-800 dark:text-amber-200 bg-amber-500/10 rounded-lg p-2.5">
            {lang === 'vi'
              ? 'Một số câu trả lời mới chưa lên máy chủ; chúng vẫn được giữ trên thiết bị này và sẽ được gửi khi bạn quay lại.'
              : 'Some new answers have not reached the server yet; they stay on this device and are sent when you return.'}
          </p>
        ) : null}
      </ExamDialog>
    </div>
  );
};
