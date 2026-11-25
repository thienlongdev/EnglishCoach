'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Headphones, Pause, Play, Send, Volume2, X } from 'lucide-react';
import { IconArrowLeft, IconArrowRight, IconBars, IconBell, IconCheck, IconNotes, IconResize, IconWifi, IconWifiOff } from './CbtIcons';
import type { AttemptStateDto, PublicItemDto, PublicManifestDto, PublicPartDto, PublicSectionDto } from '@/types/exams';
import {
  addHighlight,
  annotationStorageKey,
  bannerInstruction,
  buildCbtParts,
  cbtText,
  cbtWordCount,
  CBT_SPLIT_DEFAULT,
  CBT_SPLIT_MAX,
  CBT_SPLIT_MIN,
  CBT_SPLIT_STEP,
  clampSplit,
  flatButtons,
  parseAnnotations,
  partIndexOf,
  removeHighlight,
  reviewPartLine,
  serializeAnnotations,
  setNote,
  splitFromPointer,
  timerLabel,
  type CbtHighlight,
  type CbtRange,
  type CbtSkill,
} from '@/lib/exams/ieltsCbt';
import { isImageAsset } from '@/lib/exams/media';
import { ExamAssetImage } from '../ExamAssetImage';
import { CbtQuestionGroup } from './CbtQuestionGroup';
import { CbtPassage } from './CbtPassage';
import { useCbtListeningAudio } from './useCbtListeningAudio';
import s from './ieltsCbt.module.css';

/**
 * IELTS computer-delivered exam room (owner brief 2026-11-13). Replaces the presentation of IELTS Reading, Listening
 * and Writing attempts with the reference CBT layout (REA research: British Council / IDP familiarisation tests). It is
 * a SHELL over the existing runtime: the attempt page still owns the server clock, autosave (revision, 409, recovery
 * copy), section completion, submit and redirects; this component only renders and calls the same callbacks.
 * Speaking and TOEIC keep their own workspaces. Interface copy is the reference's English wording.
 */

export interface IeltsCbtShellProps {
  attemptId: string;
  manifest: PublicManifestDto;
  attemptState: AttemptStateDto;
  section: PublicSectionDto;
  skill: CbtSkill;
  questionNumbers: Map<string, number>;
  responses: Record<string, any>;
  remainingSeconds: number;
  isSimulation: boolean;
  isUntimed: boolean;
  isLastSection: boolean;
  saveStatus: 'SAVED' | 'SAVING' | 'UNSAVED' | 'ERROR' | 'CLOSED';
  onAnswer: (placementId: string, value: any) => void;
  onRetrySave?: () => void;
  onSubmit: () => Promise<void>;
  onAdvanceSection?: () => Promise<void>;
  onCompleteListening?: () => void;
  onExit: () => void;
  /** Practice with more than one section: move to another section (simulation sections advance only forwards). */
  otherSections?: Array<{ id: string; label: string; onOpen: () => void }>;
}

const SPLIT_KEY = 'ec_ielts_cbt_split:v1';
const ZOOM_KEY = 'ec_ielts_cbt_zoom:v1';

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

function numberField(defs: any, field: string): number | null {
  const v = defs && !Array.isArray(defs) ? Number(defs[field]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function uniqueStimuli(part: PublicPartDto | undefined) {
  const out: NonNullable<PublicPartDto['groups'][number]['stimuli']> = [];
  const seen = new Set<string>();
  for (const g of part?.groups || []) {
    for (const st of g.stimuli || []) {
      const key = st.id || st.title;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(st);
    }
  }
  return out;
}

/** Passage stimuli of a Reading part: text (and its figures); label-assignment figures stay with their group. */
function passageStimuli(part: PublicPartDto | undefined) {
  return uniqueStimuli(part).filter((st) => {
    const body: any = st.bodyPayload || {};
    const hasText = !!(body.text || body.content || body.paragraphs || (Array.isArray(body.documents) && body.documents.length));
    return hasText || (st.assets || []).some(isImageAsset);
  });
}

/** One view part per Writing item, numbered by the printed "Task n" label, else by order. */
export function writingTaskParts(parts: PublicPartDto[]): PublicPartDto[] {
  const out: PublicPartDto[] = [];
  for (const part of parts) {
    for (const group of part.groups || []) {
      for (const item of group.items || []) {
        const printed = /Task\s*([12])/i.exec(group.displayNumbering || '')?.[1] ?? /(?:TASK|PART)_?([12])\s*$/i.exec(part.partCode || '')?.[1];
        const n = (group.items || []).length > 1 ? out.length + 1 : Number(printed) || out.length + 1;
        out.push({ ...part, id: `${part.id}:${item.placementId}`, partCode: `WRITING_TASK_${n}`, groups: [{ ...group, items: [item] }] });
      }
    }
  }
  return out;
}

export function IeltsCbtShell(props: IeltsCbtShellProps) {
  const {
    attemptId,
    section,
    skill,
    questionNumbers,
    responses,
    remainingSeconds,
    isSimulation,
    isUntimed,
    isLastSection,
    saveStatus,
    onAnswer,
    onRetrySave,
    onSubmit,
    onAdvanceSection,
    onCompleteListening,
    onExit,
    otherSections,
  } = props;

  // Writing: one navigation part per TASK. Some packages put Task 1 and Task 2 in one part (two items); the reference
  // shows "Part 1" / "Part 2" for the two tasks, so each item becomes its own view part (data unchanged).
  const parts = useMemo(() => (skill === 'WRITING' ? writingTaskParts(section.parts || []) : section.parts || []), [skill, section.parts]);
  const model = useMemo(() => buildCbtParts(parts, questionNumbers, responses || {}), [parts, questionNumbers, responses]);
  const flat = useMemo(() => flatButtons(model), [model]);
  const timeUp = !isUntimed && remainingSeconds <= 0;
  const locked = timeUp || saveStatus === 'CLOSED';

  const [current, setCurrent] = useState<string | null>(() => flat[0]?.button.placementIds[0] ?? null);
  const [partIdx, setPartIdx] = useState(0);
  const [view, setView] = useState<'exam' | 'review'>('exam');
  const [menu, setMenu] = useState<null | 'options' | 'messages' | 'connection'>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'submit' | 'advance' | 'exit'>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [timerHidden, setTimerHidden] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [split, setSplit] = useState(CBT_SPLIT_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState<'regular' | 'large' | 'xlarge'>('regular');
  const [highlights, setHighlights] = useState<CbtHighlight[]>([]);
  const [focusNote, setFocusNote] = useState<string | null>(null);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const leftScroll = useRef(new Map<number, number>());
  const warned = useRef(new Set<number>());

  // Device preferences (layout only — never answers).
  useEffect(() => {
    const v = Number(readLocal(SPLIT_KEY));
    if (Number.isFinite(v) && v > 0) setSplit(clampSplit(v));
    const z = readLocal(ZOOM_KEY);
    if (z === 'large' || z === 'xlarge') setZoom(z);
  }, []);
  // Annotations of this attempt (device-local; cleared with localStorage at sign-out).
  useEffect(() => {
    setHighlights(parseAnnotations(readLocal(annotationStorageKey(attemptId))));
  }, [attemptId]);
  const saveHighlights = useCallback(
    (next: CbtHighlight[]) => {
      setHighlights(next);
      writeLocal(annotationStorageKey(attemptId), serializeAnnotations(next));
    },
    [attemptId]
  );

  // Section change ⇒ first question of the section.
  useEffect(() => {
    setPartIdx(0);
    setView('exam');
    setCurrent(flat[0]?.button.placementIds[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.id]);

  // Reference time notices (10 / 5 minutes) — shown once each, simulation only.
  useEffect(() => {
    if (isUntimed || !isSimulation) return;
    for (const mark of [600, 300]) {
      if (remainingSeconds > 0 && remainingSeconds <= mark && remainingSeconds > mark - 30 && !warned.current.has(mark)) {
        warned.current.add(mark);
        setToast(`${mark / 60} minutes remaining`);
        window.setTimeout(() => setToast(null), 5000);
      }
    }
  }, [remainingSeconds, isUntimed, isSimulation]);

  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const goToPart = useCallback(
    (idx: number, focusFirst = true) => {
      if (idx < 0 || idx >= model.length) return;
      if (leftRef.current) leftScroll.current.set(partIdx, leftRef.current.scrollTop);
      setPartIdx(idx);
      setView('exam');
      if (focusFirst) setCurrent(model[idx]?.buttons[0]?.placementIds[0] ?? null);
      window.requestAnimationFrame(() => {
        if (rightRef.current) rightRef.current.scrollTop = 0;
        if (leftRef.current) leftRef.current.scrollTop = leftScroll.current.get(idx) ?? 0;
      });
    },
    [model, partIdx]
  );

  const select = useCallback(
    (placementId: string, scroll = false) => {
      const idx = partIndexOf(model, placementId);
      if (idx >= 0 && idx !== partIdx) goToPart(idx, false);
      setCurrent(placementId);
      setView('exam');
      if (scroll) {
        window.requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>(`[data-cbt-question="${CSS.escape(placementId)}"]`);
          el?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
          const input = document.getElementById(`cbt-input-${placementId}`) as HTMLInputElement | null;
          if (input && document.activeElement !== input) input.focus({ preventScroll: true });
        });
      }
    },
    [model, partIdx, goToPart, reduceMotion]
  );

  const flatIndex = flat.findIndex((f) => current && f.button.placementIds.includes(current));
  const canPrev = view === 'review' ? flat.length > 0 : flatIndex > 0;
  const goPrev = () => {
    if (view === 'review') {
      const last = flat[flat.length - 1];
      if (last) select(last.button.key, true);
      return;
    }
    const t = flat[flatIndex - 1];
    if (t) select(t.button.key, true);
  };
  const goNext = () => {
    const t = flat[flatIndex + 1];
    if (t) select(t.button.key, true);
    else setView('review');
  };

  // ── Splitter ────────────────────────────────────────────────────────────────────────────────────────────────
  const onSplitPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onSplitPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragging || !workspaceRef.current) return;
    const r = workspaceRef.current.getBoundingClientRect();
    setSplit(splitFromPointer(e.clientX, r.left, r.width));
  };
  const endDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragging) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    setDragging(false);
    writeLocal(SPLIT_KEY, String(split));
  };
  const onSplitKey = (e: React.KeyboardEvent) => {
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = split - CBT_SPLIT_STEP;
    else if (e.key === 'ArrowRight') next = split + CBT_SPLIT_STEP;
    else if (e.key === 'Home') next = CBT_SPLIT_MIN;
    else if (e.key === 'End') next = CBT_SPLIT_MAX;
    if (next === null) return;
    e.preventDefault();
    const v = clampSplit(next);
    setSplit(v);
    writeLocal(SPLIT_KEY, String(v));
  };

  // ── Listening audio ─────────────────────────────────────────────────────────────────────────────────────────
  const audio = useCbtListeningAudio({
    enabled: skill === 'LISTENING',
    parts: skill === 'LISTENING' ? parts : [],
    attemptId,
    isSimulation,
    remainingSeconds: isUntimed ? undefined : remainingSeconds,
    onComplete: onCompleteListening,
  });

  // ── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────
  const unanswered = model.reduce((acc, p) => acc + (p.total - p.attempted), 0);
  const proceedFromReview = () => {
    setActionError(null);
    setDialog(isSimulation && !isLastSection && onAdvanceSection ? 'advance' : 'submit');
  };
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      if (dialog === 'advance' && onAdvanceSection) await onAdvanceSection();
      else await onSubmit();
      setDialog(null);
    } catch {
      setActionError('Your answers could not be sent. They are kept on this device — check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  // ── Rendering helpers ───────────────────────────────────────────────────────────────────────────────────────
  const part = parts[partIdx];
  const partModel = model[partIdx];
  const numberOf = useCallback((it: PublicItemDto) => questionNumbers.get(it.placementId) ?? 0, [questionNumbers]);
  const writingItem = skill === 'WRITING' ? part?.groups?.flatMap((g) => g.items || [])[0] : undefined;
  const writingDefs: any = writingItem?.optionDefinitions || writingItem?.options || null;
  const banner = partModel
    ? bannerInstruction(skill, partModel, {
        recommendedMinutes: numberField(writingDefs, 'recommendedMinutes'),
        minimumWords: numberField(writingDefs, 'minimumWords'),
      })
    : '';
  const isSplit = skill !== 'LISTENING';
  const timerTone = !isUntimed && remainingSeconds <= 300 ? 'critical' : 'normal';
  const offline = saveStatus === 'ERROR';

  const questionGroups = (p: PublicPartDto | undefined, figures: boolean) =>
    (p?.groups || []).map((g) => (
      <CbtQuestionGroup
        key={g.id}
        group={g}
        numberOf={numberOf}
        responses={responses}
        onAnswer={onAnswer}
        activePlacementId={current ?? undefined}
        onSelect={(pid) => setCurrent(pid)}
        disabled={locked}
        attemptId={attemptId}
        showFigures={figures}
      />
    ));

  const header = (
    <header className={s.header} role="banner">
      <div className={s.logo} aria-label="English Coach — IELTS practice test">
        English Coach
      </div>
      <div className={s.candidate}>
        <span className={s.candidateId}>Test taker ID</span>
        {skill === 'LISTENING' && (audio.phase === 'playing' || audio.phase === 'paused') && (
          <span className={s.audioStatus} data-testid="cbt-audio-status">
            <Volume2 aria-hidden />
            {audio.phase === 'playing' ? 'Audio is Playing' : 'Audio is Paused'}
          </span>
        )}
        {skill === 'LISTENING' && audio.phase === 'review' && (
          <span className={s.audioStatus}>Check your answers: {timerLabel(audio.reviewRemaining)}</span>
        )}
      </div>
      {isUntimed ? (
        <span className={`${s.timer} ${s.timerHidden}`} data-testid="cbt-timer">
          Practice · no time limit
        </span>
      ) : (
        <button
          type="button"
          className={s.timer}
          data-tone={timerTone}
          data-testid="cbt-timer"
          aria-live="off"
          onClick={() => setTimerHidden((v) => (remainingSeconds <= 600 ? false : !v))}
          title={timerHidden ? 'Show time' : 'Hide time'}
        >
          {timerHidden && remainingSeconds > 600 ? <span className={s.timerHidden}>Show time</span> : timerLabel(remainingSeconds)}
        </button>
      )}
      <div className={s.headerTools}>
        {skill === 'LISTENING' && !isSimulation && audio.phase !== 'ended' && (
          <button type="button" className={s.tool} onClick={() => (audio.phase === 'waiting' ? audio.start() : audio.togglePause())} aria-label={audio.phase === 'playing' ? 'Pause audio' : 'Play audio'} data-testid="cbt-practice-play">
            {audio.phase === 'playing' ? <Pause aria-hidden /> : <Play aria-hidden />}
          </button>
        )}
        <button type="button" className={s.tool} style={{ width: 58 }} aria-label={offline ? 'Not connected' : 'Connected'} title={offline ? 'Not connected' : 'Connected'} onClick={() => setMenu(menu === 'connection' ? null : 'connection')}>
          {offline ? <IconWifiOff /> : <IconWifi />}
        </button>
        <button type="button" className={s.tool} style={{ width: 53 }} aria-label="Messages" title="Messages" onClick={() => setMenu(menu === 'messages' ? null : 'messages')}>
          <IconBell />
        </button>
        <button type="button" className={s.tool} style={{ width: 55 }} aria-label="Options" title="Options" aria-haspopup="menu" aria-expanded={menu === 'options'} onClick={() => setMenu(menu === 'options' ? null : 'options')} data-testid="cbt-options">
          <IconBars />
        </button>
        <button type="button" className={s.tool} aria-label={drawerOpen ? 'Hide notes' : 'Show notes'} title={drawerOpen ? 'Hide notes' : 'Show notes'} aria-pressed={drawerOpen} onClick={() => setDrawerOpen((v) => !v)} data-testid="cbt-notes-toggle">
          <IconNotes />
        </button>
      </div>
      {menu === 'connection' && (
        <div className={s.menu} role="dialog" aria-label="Connection">
          <p className={s.menuText}>
            {offline
              ? 'Your latest answers have not reached the server yet. They are kept on this device.'
              : saveStatus === 'SAVING'
              ? 'Saving your answers…'
              : 'Connected. Your answers are saved automatically.'}
          </p>
          {offline && onRetrySave && (
            <button type="button" className={s.menuItem} onClick={() => onRetrySave()}>
              Try again
            </button>
          )}
        </div>
      )}
      {menu === 'messages' && (
        <div className={s.menu} role="dialog" aria-label="Messages">
          <p className={s.menuTitle}>Messages</p>
          <p className={s.menuText}>You have no messages.</p>
        </div>
      )}
      {menu === 'options' && (
        <div className={s.menu} role="menu" aria-label="Options">
          <p className={s.menuTitle}>Text size</p>
          {(['regular', 'large', 'xlarge'] as const).map((z) => (
            <button
              key={z}
              type="button"
              role="menuitemradio"
              aria-checked={zoom === z}
              className={s.menuItem}
              onClick={() => {
                setZoom(z);
                writeLocal(ZOOM_KEY, z);
              }}
            >
              {z === 'regular' ? 'Regular' : z === 'large' ? 'Large' : 'Extra large'}
            </button>
          ))}
          {skill === 'LISTENING' && (
            <>
              <p className={s.menuTitle}>Volume</p>
              <div className={s.volume}>
                <Volume2 aria-hidden width={20} />
                <input type="range" min={0} max={1} step={0.05} value={audio.volume} aria-label="Volume" onChange={(e) => audio.setVolume(Number(e.target.value))} />
              </div>
            </>
          )}
          {otherSections && otherSections.length > 0 && (
            <>
              <p className={s.menuTitle}>Sections</p>
              {otherSections.map((o) => (
                <button key={o.id} type="button" role="menuitem" className={s.menuItem} onClick={() => { setMenu(null); o.onOpen(); }}>
                  {o.label}
                </button>
              ))}
            </>
          )}
          <button type="button" role="menuitem" className={s.menuItem} onClick={() => { setMenu(null); setView('review'); }}>
            Review answers
          </button>
          <button type="button" role="menuitem" className={s.menuItem} onClick={() => { setMenu(null); setDialog('exit'); }} data-testid="cbt-leave">
            Leave test
          </button>
        </div>
      )}
    </header>
  );

  const footer = (
    <footer className={s.footer} role="contentinfo" aria-label="Question navigation" data-skill={skill}>
      <nav className={s.footerParts} aria-label="Parts and questions">
        {model.map((p) => {
          const active = view === 'exam' && p.index === partIdx;
          return (
            <div key={p.index} className={s.footerPart} data-active={active}>
              <button
                type="button"
                className={s.partTab}
                data-active={active}
                aria-current={active ? 'step' : undefined}
                onClick={() => !active && goToPart(p.index)}
                aria-label={active ? `Part ${p.number}` : `Part ${p.number}, ${p.attempted} of ${p.total} questions attempted`}
                data-testid={`cbt-part-${p.number}`}
              >
                <span>Part {p.number}</span>
                {!active && <span className={s.partCount}>{p.attempted} of {p.total}</span>}
              </button>
              {active && skill !== 'WRITING' && (
                <div className={s.qButtons}>
                  {p.buttons.map((b) => (
                    <button
                      key={b.key}
                      type="button"
                      className={s.qBtn}
                      data-question-id={`q${b.numbers[0]}`}
                      data-active={!!current && b.placementIds.includes(current)}
                      data-attempted={b.attempted}
                      aria-label={`Question ${b.label}${b.attempted ? ', attempted' : ', not attempted'}`}
                      aria-current={!!current && b.placementIds.includes(current) ? 'true' : undefined}
                      onClick={() => select(b.key, true)}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <button
        type="button"
        id="deliver-button"
        className={s.deliver}
        data-ready={view === 'review'}
        aria-label="Review and submit"
        title="Review and submit"
        onClick={() => (view === 'review' ? proceedFromReview() : setView('review'))}
        data-testid="cbt-deliver"
      >
        <IconCheck />
      </button>
    </footer>
  );

  const workspaceBody = () => {
    if (skill === 'READING') {
      return (
        <>
          <div ref={leftRef} className={`${s.pane} ${s.leftPane} ${s.scalable}`} data-cbt-pane data-testid="reading-passage-container" style={{ ['--cbt-left' as any]: `${split}%` }}>
            <CbtPassage
              stimuli={passageStimuli(part)}
              highlights={highlights}
              attemptId={attemptId}
              emptyText="The text for this part is not available."
              onHighlight={(ranges: CbtRange[], excerpt: string, withNote: boolean) => {
                const id = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
                saveHighlights(addHighlight(highlights, ranges, { id, excerpt: excerpt.slice(0, 160), note: withNote ? '' : null, part: partModel?.number, createdAt: Date.now() }));
                if (withNote) {
                  setDrawerOpen(true);
                  setFocusNote(ranges.length > 1 ? `${id}:0` : id);
                }
              }}
              onDeleteHighlight={(id) => saveHighlights(removeHighlight(highlights, id))}
              onOpenNote={(id) => {
                setDrawerOpen(true);
                setFocusNote(id);
              }}
            />
          </div>
          {splitter}
          <div ref={rightRef} className={`${s.pane} ${s.rightPane} ${s.scalable}`} data-cbt-pane data-testid="reading-questions-container">
            <div className={s.questions}>{questionGroups(part, false)}</div>
          </div>
        </>
      );
    }
    if (skill === 'LISTENING') {
      return (
        <div ref={rightRef} className={`${s.pane} ${s.singlePane} ${s.scalable}`} data-cbt-pane data-testid="listening-questions-container">
          <div className={s.questions}>{questionGroups(part, true)}</div>
          {audio.phase === 'unavailable' && <p className={s.unavailable}>The recording for this part is not available.</p>}
        </div>
      );
    }
    // WRITING
    const item = writingItem;
    const text = item ? cbtText(responses[item.placementId]) : '';
    const visuals = (part?.groups || []).flatMap((g) => g.stimuli || []).flatMap((st) =>
      (st.assets || []).filter((a) => isImageAsset(a) && a.delivery === 'PLAYBACK_GRANT' && a.assetId).map((a) => ({ a, alt: (st.bodyPayload as any)?.altText || st.title || 'Task visual' }))
    );
    const stimulusPrompt = (part?.groups || []).flatMap((g) => g.stimuli || []).map((st: any) => st.bodyPayload?.prompt).find((p) => typeof p === 'string' && p.trim());
    return (
      <>
        <div ref={leftRef} className={`${s.pane} ${s.leftPane} ${s.scalable}`} data-cbt-pane data-testid="writing-prompt-container" style={{ ['--cbt-left' as any]: `${split}%` }}>
          <div className={s.taskPrompt}>{item?.prompt || 'The task for this part is not available.'}</div>
          {stimulusPrompt && stimulusPrompt !== item?.prompt && <div className={s.taskPrompt}>{stimulusPrompt}</div>}
          {visuals.map(({ a, alt }) => (
            <div key={a.assetId} className={s.taskFigure}>
              <ExamAssetImage className={s.figureImg} attemptId={attemptId} asset={a} alt={alt} />
            </div>
          ))}
        </div>
        {splitter}
        <div ref={rightRef} className={`${s.pane} ${s.rightPane}`} data-cbt-pane>
          {item && (
            <div className={s.editorWrap}>
              <label htmlFor={`cbt-editor-${item.placementId}`} className="sr-only">
                Your answer for Part {partModel?.number}
              </label>
              <textarea
                id={`cbt-editor-${item.placementId}`}
                className={s.editor}
                data-testid="writing-editor"
                value={text}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                autoComplete="off"
                disabled={locked}
                onFocus={() => setCurrent(item.placementId)}
                onChange={(e) => onAnswer(item.placementId, e.target.value)}
              />
              <div className={s.wordCount} data-testid="word-counter" aria-live="polite">
                Words: {cbtWordCount(text)}
              </div>
            </div>
          )}
        </div>
      </>
    );
  };

  const splitter = (
    <div className={s.splitter} data-active={dragging} data-testid="splitter-line">
      <div
        className={s.splitterTarget}
        data-testid="splitter-handle"
        onPointerDown={onSplitPointerDown}
        onPointerMove={onSplitPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      <button
        type="button"
        className={s.splitterHandle}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        aria-valuemin={CBT_SPLIT_MIN}
        aria-valuemax={CBT_SPLIT_MAX}
        aria-valuenow={Math.round(split)}
        onPointerDown={onSplitPointerDown}
        onPointerMove={onSplitPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onSplitKey}
      >
        <IconResize />
      </button>
    </div>
  );

  const review = (
    <div className={s.review} data-testid="cbt-review">
      <div className={s.reviewTop}>
        <p>Click next to continue</p>
        <button type="button" className={s.reviewNext} onClick={proceedFromReview} data-testid="cbt-review-next">
          <Send aria-hidden />
          Next
        </button>
      </div>
      <div className={s.reviewBody}>
        <p className={s.reviewPartTitle}>Table of contents</p>
        {model.map((p) => (
          <div key={p.index} className={s.reviewPart}>
            <p className={s.reviewPartTitle}>{reviewPartLine(p)}</p>
            {skill !== 'WRITING' ? (
              <div className={s.reviewGrid}>
                {p.buttons.map((b) => (
                  <button key={b.key} type="button" className={s.reviewQ} data-attempted={b.attempted} onClick={() => select(b.key, true)} aria-label={`Question ${b.label}${b.attempted ? ', attempted' : ', not attempted'}`}>
                    {b.label}
                  </button>
                ))}
              </div>
            ) : (
              <button type="button" className={s.reviewQ} data-attempted={p.attempted > 0} onClick={() => goToPart(p.index)}>
                Part {p.number}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  const noteCards = highlights.filter((h) => h.note != null && (!h.id.includes(':') || h.id.endsWith(':0')));

  return (
    <div className={s.room} data-zoom={zoom} data-testid="ielts-cbt-room" data-skill={skill} data-mode={isSimulation ? 'simulation' : 'practice'} translate="no">
      <div className={s.main}>
        {header}
        {view === 'exam' ? (
          <>
            <section className={s.banner} data-skill={skill} data-testid="instruction-banner" aria-label="Instructions">
              <p className={s.bannerPart}>Part {partModel?.number ?? partIdx + 1}</p>
              {banner && <p className={s.bannerText}>{banner}</p>}
            </section>
            <div
              ref={workspaceRef}
              className={s.workspace}
              data-skill={skill}
              data-split={isSplit}
              data-dragging={dragging}
              onPointerMove={dragging ? onSplitPointerMove : undefined}
            >
              {workspaceBody()}
              <div className={s.floatingNav} data-testid="floating-nav-group">
                <button type="button" className={s.navBtn} data-dir="prev" data-testid="nav-prev" aria-label="Previous" disabled={!canPrev} onClick={goPrev}>
                  <IconArrowLeft />
                </button>
                <button type="button" className={s.navBtn} data-dir="next" data-testid="nav-next" aria-label="Next" onClick={goNext}>
                  <IconArrowRight />
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {review}
            <div className={s.floatingNav} data-testid="floating-nav-group" style={{ position: 'absolute' }}>
              <button type="button" className={s.navBtn} data-dir="prev" data-testid="nav-prev" aria-label="Previous" disabled={!canPrev} onClick={goPrev}>
                <IconArrowLeft />
              </button>
              <button type="button" className={s.navBtn} data-dir="next" data-testid="nav-next" aria-label="Next" disabled>
                <IconArrowRight />
              </button>
            </div>
          </>
        )}
        {footer}

        {skill === 'LISTENING' && <audio ref={audio.audioRef} preload="auto" controlsList="nodownload" className="hidden" data-testid="cbt-audio" />}

        {skill === 'LISTENING' && isSimulation && audio.needsGesture && audio.phase !== 'review' && audio.phase !== 'unavailable' && (
          <div className={s.overlay} role="dialog" aria-modal="true" aria-labelledby="cbt-sound-text" data-testid="cbt-sound-check">
            <div className={s.overlayInner}>
              <Headphones className="headphones" aria-hidden strokeWidth={2.5} style={{ width: 106, height: 92, marginBottom: 18 }} />
              <p id="cbt-sound-text">You will be listening to an audio clip during this test. You will not be permitted to pause or rewind the audio while answering the questions.</p>
              <p>To continue, click Play.</p>
              <button type="button" className={s.playBtn} onClick={() => audio.start()} autoFocus>
                <Play aria-hidden fill="currentColor" />
                Play
              </button>
            </div>
          </div>
        )}

        {toast && (
          <div className={s.toast} role="status">
            {toast}
          </div>
        )}
        {(saveStatus === 'ERROR' || saveStatus === 'CLOSED') && (
          <div className={s.saveError} role="alert" data-testid="cbt-save-error">
            {saveStatus === 'CLOSED' ? 'This test is closed. New answers can no longer be saved.' : 'Answers not saved yet. They are kept on this device.'}
            {saveStatus === 'ERROR' && onRetrySave && (
              <button type="button" onClick={() => onRetrySave()}>
                Try again
              </button>
            )}
          </div>
        )}

        {dialog && (
          <div className={s.overlay} role="dialog" aria-modal="true" aria-labelledby="cbt-dialog-title" data-testid="cbt-dialog">
            <div className={s.dialog}>
              {dialog === 'exit' ? (
                <>
                  <h2 id="cbt-dialog-title">Leave the test?</h2>
                  <p>{!isUntimed ? 'The test time keeps running on the server. You can come back to this test from the library.' : 'Your saved answers are kept. You can continue this test later.'}</p>
                  <div className={s.dialogActions}>
                    <button type="button" className={s.btn} onClick={() => setDialog(null)} autoFocus>Stay</button>
                    <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={onExit}>Leave</button>
                  </div>
                </>
              ) : (
                <>
                  <h2 id="cbt-dialog-title">{dialog === 'advance' ? 'Finish this section?' : isSimulation ? 'Submit your test?' : 'Submit your answers?'}</h2>
                  {skill !== 'WRITING' ? (
                    <p>{unanswered > 0 ? `You have ${unanswered} unanswered question${unanswered === 1 ? '' : 's'}.` : 'You have answered every question.'}</p>
                  ) : (
                    <p>{model.map((p) => `Part ${p.number}: ${cbtWordCount(cbtText(responses[(parts[p.index]?.groups || []).flatMap((g) => g.items || [])[0]?.placementId || '']))} words`).join(' · ')}</p>
                  )}
                  <p>{dialog === 'advance' ? 'You will not be able to return to this section.' : isSimulation ? (isLastSection ? 'This ends the test. You cannot change your answers after submitting.' : 'You cannot change your answers after submitting.') : 'You cannot change your answers after submitting.'}</p>
                  {actionError && <p className={s.reviewError} role="alert">{actionError}</p>}
                  <div className={s.dialogActions}>
                    <button type="button" className={s.btn} onClick={() => setDialog(null)} disabled={busy} autoFocus>Cancel</button>
                    <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={confirm} disabled={busy} data-testid="cbt-confirm">
                      {busy ? 'Sending…' : dialog === 'advance' ? 'Finish section' : 'Submit'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {drawerOpen && (
        <aside className={s.drawer} data-testid="notes-drawer" aria-label="Notes">
          <div className={s.drawerHead}>
            <span>Notes</span>
            <button type="button" className={s.drawerClose} aria-label="Close notes" onClick={() => setDrawerOpen(false)}>
              <X aria-hidden strokeWidth={4} />
            </button>
          </div>
          <div className={s.drawerBody}>
            {noteCards.length === 0 ? (
              <div className={s.drawerEmpty}>
                <p className={s.drawerEmptyTitle}>Your private notes will show here</p>
                <p className={s.drawerEmptyText}>Select text to highlight or create a note.</p>
              </div>
            ) : (
              noteCards.map((h) => (
                <div key={h.id} className={s.noteCard} data-testid="note-card">
                  <p className={s.noteHead}>
                    <b>Part {h.part ?? ''}</b>
                    <i>{h.excerpt}</i>
                  </p>
                  <textarea
                    className={s.noteInput}
                    placeholder="Start typing your note"
                    value={h.note || ''}
                    autoFocus={focusNote === h.id}
                    aria-label={`Note on: ${h.excerpt || ''}`}
                    onChange={(e) => saveHighlights(setNote(highlights, h.id, e.target.value))}
                  />
                  <button type="button" className={s.noteDelete} onClick={() => saveHighlights(removeHighlight(highlights, h.id))}>
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
