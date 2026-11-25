'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Compass, BookOpen, DoorOpen, Layers } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { pointerLight } from '@/lib/ui/pointerLight';
import {
  ROUTINE_STEPS,
  evaluateSatisfiedSteps,
  greetingForHour,
  readRoutineState,
  studyRoutineKey,
  todayIso,
  writeRoutineState,
  type RoutineProgressState,
  type RoutineStepId,
  type StudyPlayStyle,
} from '@/lib/study-space/routine';
import { useAccount, useFocus, useFocusStats } from './data';
import s from './explorer.module.css';

interface StudyCompanionProps {
  spaceId: string;
  visible: boolean;
  locked: boolean;
  seated: boolean;
  atDeskAnchor: boolean;
  lampLit: boolean;
  windowFresh: boolean;
  careActivityCount: number;
  engagedLearning: boolean;
  onGoDesk: () => void;
  onOpenFocus: () => void;
  onOpenReading: () => void;
  onOpenFlashcards: () => void;
  onEnterArena: () => void;
  onOpenHelp: () => void;
  reducedMotion?: boolean;
  vi?: boolean;
}

function playGentleCompletionTone(disabled: boolean) {
  if (disabled || typeof window === 'undefined') return;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    if (ctx.state === 'suspended') {
      void ctx.close();
      return;
    }
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.035, now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    gain.connect(ctx.destination);

    const oscA = ctx.createOscillator();
    oscA.type = 'sine';
    oscA.frequency.setValueAtTime(587.33, now); // D5
    oscA.frequency.setValueAtTime(783.99, now + 0.11); // G5
    oscA.connect(gain);
    oscA.start(now);
    oscA.stop(now + 0.44);
    oscA.onended = () => {
      void ctx.close();
    };
  } catch {
    // Audio feedback is strictly optional polish.
  }
}

const StudyCompanion = memo(function StudyCompanion(p: StudyCompanionProps) {
  const { locale } = useLanguage();
  const vi = p.vi ?? (locale === 'vi');
  const account = useAccount();
  const storageKey = useMemo(() => studyRoutineKey(account), [account]);

  // Subscribed inside this isolated child so timer ticks never re-render StudySpace.tsx
  const { state: focusState } = useFocus();
  const { data: focusStats } = useFocusStats(7);

  const [routine, setRoutine] = useState<RoutineProgressState>(() => readRoutineState(storageKey));
  const [expandedList, setExpandedList] = useState(false);
  const [celebrateStep, setCelebrateStep] = useState<RoutineStepId | null>(null);
  const [baseline, setBaseline] = useState(() => ({
    spaceId: p.spaceId,
    lampLit: p.lampLit,
    windowFresh: p.windowFresh,
    careActivityCount: p.careActivityCount,
  }));
  const visitedSessionRef = useRef(false);

  // Sync per-space baseline in an effect rather than mutating refs during render (React 19 StrictMode clean).
  useEffect(() => {
    if (baseline.spaceId === p.spaceId) return;
    setBaseline({
      spaceId: p.spaceId,
      lampLit: p.lampLit,
      windowFresh: p.windowFresh,
      careActivityCount: p.careActivityCount,
    });
  }, [baseline.spaceId, p.spaceId, p.lampLit, p.windowFresh, p.careActivityCount]);

  // Reload per-account state if account changes
  useEffect(() => {
    const loaded = readRoutineState(storageKey);
    if (!visitedSessionRef.current) {
      visitedSessionRef.current = true;
      const bumped: RoutineProgressState = {
        ...loaded,
        visits: loaded.visits + 1,
        lastSeenAt: Date.now(),
      };
      setRoutine(bumped);
      writeRoutineState(storageKey, bumped);
    } else {
      setRoutine(loaded);
    }
  }, [storageKey]);

  const effectiveBaseline = baseline.spaceId === p.spaceId
    ? baseline
    : { lampLit: p.lampLit, windowFresh: p.windowFresh, careActivityCount: p.careActivityCount };

  const completedTodayCount = focusStats?.days?.[focusStats.days.length - 1]?.completed ?? 0;
  const focusActiveOrDone = focusState.status === 'running' || completedTodayCount > 0;
  const lampChangedOrSeated = p.seated || p.atDeskAnchor || (p.lampLit && !effectiveBaseline.lampLit);
  const windowChanged = p.windowFresh && !effectiveBaseline.windowFresh;
  const didCare = p.careActivityCount > effectiveBaseline.careActivityCount;

  useEffect(() => {
    if (baseline.spaceId !== p.spaceId) return;
    const satisfied = evaluateSatisfiedSteps({
      atDesk: lampChangedOrSeated,
      lampLit: p.lampLit && !baseline.lampLit,
      windowFresh: windowChanged,
      didCareAction: didCare,
      focusActiveOrDone,
      engagedLearning: p.engagedLearning,
    });
    if (!satisfied.length) return;

    const today = todayIso();
    const baseCompleted = routine.day === today ? routine.completed : [];
    const newlyAdded = satisfied.filter((id) => !baseCompleted.includes(id));
    if (!newlyAdded.length && routine.day === today) return;

    const next: RoutineProgressState = {
      ...routine,
      day: today,
      completed: [...baseCompleted, ...newlyAdded],
      lastSeenAt: Date.now(),
    };
    setRoutine(next);
    writeRoutineState(storageKey, next);
    if (newlyAdded.length > 0) {
      setCelebrateStep(newlyAdded[0]);
      playGentleCompletionTone(!!p.reducedMotion);
    }
  }, [
    baseline.spaceId,
    baseline.lampLit,
    p.spaceId,
    lampChangedOrSeated,
    p.lampLit,
    windowChanged,
    didCare,
    focusActiveOrDone,
    p.engagedLearning,
    routine,
    storageKey,
    p.reducedMotion,
  ]);

  useEffect(() => {
    if (!celebrateStep) return;
    const timer = window.setTimeout(() => setCelebrateStep(null), 4200);
    return () => window.clearTimeout(timer);
  }, [celebrateStep]);

  const setPlayStyle = (style: StudyPlayStyle, markOnboarded = true) => {
    const next: RoutineProgressState = {
      ...routine,
      onboarded: markOnboarded ? true : routine.onboarded,
      playStyle: style,
      lastSeenAt: Date.now(),
    };
    setRoutine(next);
    writeRoutineState(storageKey, next);
  };

  const doneSet = useMemo(() => new Set(routine.completed), [routine.completed]);

  if (!p.visible) return null;

  const doneCount = routine.completed.length;
  const totalCount = ROUTINE_STEPS.length;
  const allDone = doneCount >= totalCount;
  const nextStep = ROUTINE_STEPS.find((st) => !doneSet.has(st.id)) ?? null;
  const celebratedDef = celebrateStep ? ROUTINE_STEPS.find((st) => st.id === celebrateStep) : null;
  const hour = new Date().getHours();
  const isFirstVisit = !routine.onboarded;

  const runStepAction = (id: RoutineStepId) => {
    if (id === 'workspace') p.onGoDesk();
    else if (id === 'focus') p.onOpenFocus();
    else if (id === 'learn') p.onOpenReading();
  };

  // During active mouse-look or when learner chose Free Exploration, render a whisper-quiet compact pill
  if (p.locked || (routine.onboarded && routine.playStyle === 'free')) {
    return (
      <div className={s.companionDock} data-testid="study-companion" data-mode={routine.playStyle} data-locked={p.locked || undefined}>
        {celebratedDef && (
          <div className={s.companionToast} role="status" data-testid="study-routine-toast">
            <span className={s.companionCheck} aria-hidden="true"><Check size={13} /></span>
            <span>{vi ? `Hoàn thành: ${celebratedDef.titleVi}` : `Completed: ${celebratedDef.titleEn}`}</span>
          </div>
        )}
        <button
          type="button"
          className={s.companionPill}
          data-testid="study-companion-expand"
          onClick={() => setPlayStyle('guided', true)}
          title={vi ? 'Mở gợi ý nhịp học hôm nay' : 'Open today study routine'}
          {...pointerLight}
        >
          <Compass size={15} className={s.companionAccentIcon} aria-hidden="true" />
          <span>
            {allDone
              ? (vi ? 'Đã hoàn thành nhịp học' : 'Daily routine complete')
              : nextStep
                ? (vi ? `Tiếp theo: ${nextStep.titleVi}` : `Next: ${nextStep.titleEn}`)
                : (vi ? 'Nhịp học hôm nay' : 'Daily routine')}
          </span>
          <span className={s.companionCounter}>{doneCount}/{totalCount}</span>
        </button>
      </div>
    );
  }

  return (
    <aside
      className={s.companionDock}
      aria-label={vi ? 'Hướng dẫn và nhịp học hôm nay' : 'Orientation and daily study routine'}
      data-testid="study-companion"
      data-mode={isFirstVisit ? 'onboarding' : 'guided'}
    >
      {celebratedDef && (
        <div className={s.companionToast} role="status" data-testid="study-routine-toast">
          <span className={s.companionCheck} aria-hidden="true"><Check size={13} /></span>
          <span>{vi ? `Hoàn thành: ${celebratedDef.titleVi}` : `Completed: ${celebratedDef.titleEn}`}</span>
        </div>
      )}

      <div className={s.companionCard} {...pointerLight}>
        <div className={s.companionHeader}>
          <div className={s.companionHeadingWrap}>
            <span className={s.companionEyebrow}>
              {greetingForHour(hour, vi, !isFirstVisit)}
            </span>
            <strong className={s.companionTitle}>
              {isFirstVisit
                ? (vi ? 'Góc sống và tự học cá nhân của bạn' : 'Your personal living and study space')
                : allDone
                  ? (vi ? 'Bạn đã hoàn tất nhịp học hôm nay' : 'Today’s study rhythm is complete')
                  : nextStep
                    ? (vi ? nextStep.titleVi : nextStep.titleEn)
                    : (vi ? 'Nhịp học hôm nay' : 'Today’s routine')}
            </strong>
          </div>
          <span className={s.companionCounter} aria-label={vi ? `Đã hoàn thành ${doneCount} trên ${totalCount}` : `${doneCount} of ${totalCount} completed`}>
            {doneCount}/{totalCount}
          </span>
        </div>

        {isFirstVisit ? (
          <>
            <p className={s.companionBody}>
              {vi
                ? 'Khám phá căn phòng của riêng bạn, chuẩn bị bàn học và kết nối trực tiếp vào phiên Tập trung, Đọc sách hoặc Luyện nói.'
                : 'Explore your own room, prepare your desk, and launch directly into Focus sessions, Reading, or Speaking.'}
            </p>
            <div className={s.companionKeyStrip} aria-label={vi ? 'Phím điều khiển cơ bản' : 'Essential controls'}>
              <span><kbd>WASD</kbd>{vi ? 'Di chuyển' : 'Move'}</span>
              <span><kbd>Shift</kbd>{vi ? 'Chạy' : 'Run'}</span>
              <span><kbd>E</kbd>{vi ? 'Tương tác' : 'Interact'}</span>
              <button type="button" className={s.companionInlineLink} onClick={p.onOpenHelp} data-testid="study-companion-keys">
                <kbd>K</kbd>{vi ? 'Đổi phím' : 'All keys'}
              </button>
            </div>
            <div className={s.companionActions}>
              <button
                type="button"
                className={s.companionPrimaryBtn}
                data-testid="study-onboarding-guided"
                onClick={() => setPlayStyle('guided', true)}
              >
                {vi ? 'Theo gợi ý hôm nay' : 'Start guided routine'}
              </button>
              <button
                type="button"
                className={s.companionSecondaryBtn}
                data-testid="study-onboarding-free"
                onClick={() => setPlayStyle('free', true)}
              >
                {vi ? 'Tự do khám phá' : 'Explore freely'}
              </button>
            </div>
          </>
        ) : allDone ? (
          <>
            <p className={s.companionBody}>
              {vi
                ? 'Không gian đã gọn gàng và phiên học đã khởi động. Tiếp tục học sâu hơn hoặc thư giãn tự do trong phòng.'
                : 'Your room is ready and your study habit is active. Continue learning or relax freely in your space.'}
            </p>
            <div className={s.companionContinueRow}>
              <button type="button" className={s.companionChipBtn} onClick={p.onOpenReading} data-testid="study-continue-reading">
                <BookOpen size={14} aria-hidden="true" />
                <span>{vi ? 'Đọc tiếp' : 'Reading'}</span>
              </button>
              <button type="button" className={s.companionChipBtn} onClick={p.onOpenFlashcards} data-testid="study-continue-flashcards">
                <Layers size={14} aria-hidden="true" />
                <span>{vi ? 'Thẻ từ vựng' : 'Flashcards'}</span>
              </button>
              <button type="button" className={s.companionChipBtn} onClick={p.onEnterArena} data-testid="study-continue-arena">
                <DoorOpen size={14} aria-hidden="true" />
                <span>Speaking Arena</span>
              </button>
            </div>
            <div className={s.companionFooter}>
              <button type="button" className={s.companionTextBtn} onClick={() => setPlayStyle('free', true)} data-testid="study-companion-minimize">
                {vi ? 'Thu gọn để tự do khám phá' : 'Minimize for free exploration'}
              </button>
            </div>
          </>
        ) : (
          <>
            {nextStep && (
              <p className={s.companionBody}>
                {vi ? nextStep.hintVi : nextStep.hintEn}
              </p>
            )}

            <div className={s.companionProgressTrack} aria-hidden="true">
              <div className={s.companionProgressFill} style={{ width: `${Math.round((doneCount / totalCount) * 100)}%` }} />
            </div>

            {expandedList && (
              <ul className={s.companionStepList} data-testid="study-routine-list">
                {ROUTINE_STEPS.map((step) => {
                  const done = doneSet.has(step.id);
                  return (
                    <li key={step.id} className={s.companionStepItem} data-done={done || undefined} data-testid={`study-routine-${step.id}`}>
                      <span className={s.companionStepDot} aria-hidden="true">
                        {done ? <Check size={11} /> : null}
                      </span>
                      <div className={s.companionStepText}>
                        <span>{vi ? step.titleVi : step.titleEn}</span>
                        <small>{vi ? step.benefitVi : step.benefitEn}</small>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className={s.companionActions}>
              {nextStep && (nextStep.actionLabelVi || nextStep.actionLabelEn) && (
                <button
                  type="button"
                  className={s.companionPrimaryBtn}
                  data-testid="study-routine-act"
                  onClick={() => runStepAction(nextStep.id)}
                >
                  {vi ? nextStep.actionLabelVi : nextStep.actionLabelEn}
                </button>
              )}
              <button
                type="button"
                className={s.companionSecondaryBtn}
                data-testid="study-routine-toggle-list"
                aria-expanded={expandedList}
                onClick={() => setExpandedList((v) => !v)}
              >
                <span>{expandedList ? (vi ? 'Ẩn danh sách' : 'Hide steps') : (vi ? 'Tất cả mục' : 'All steps')}</span>
                {expandedList ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              </button>
              <button
                type="button"
                className={s.companionTextBtn}
                data-testid="study-companion-minimize"
                onClick={() => setPlayStyle('free', true)}
              >
                {vi ? 'Tự do' : 'Free play'}
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
});

export default StudyCompanion;
