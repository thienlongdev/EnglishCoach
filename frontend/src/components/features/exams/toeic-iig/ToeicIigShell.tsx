'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttemptStateDto, PublicGroupDto, PublicItemDto, PublicManifestDto, PublicPartDto, PublicSectionDto, PublicStimulusDto } from '@/types/exams';
import {
  buildListeningUnits,
  buildReadingScreens,
  iigAnswered,
  iigClock,
  iigCounts,
  iigEntries,
  iigHeaderTitle,
  iigOptions,
  iigQuestionLine,
  iigSelected,
  iigSubmitMessage,
  iigTileParts,
  readingNav,
  screenIndexOf,
  type IigEntry,
  type IigSkill,
  type IigTilePart,
} from '@/lib/exams/toeicIig';
import { stimulusDocuments } from '@/lib/exams/groupPresentation';
import { isImageAsset } from '@/lib/exams/media';
import { ExamAssetImage } from '../ExamAssetImage';
import { useToeicListeningAudio } from './useToeicListeningAudio';
import s from './toeicIig.module.css';

/**
 * TOEIC computer-based exam room — IIG-style simulation (owner brief 2026-11-16; REA package
 * C:\REA\artifacts\toeic-iig-real-exam-reference; policies in src/lib/exams/toeicIig.ts and docs/toeic-exam/IIG_ROOM.md).
 *
 * A SHELL over the existing runtime, exactly like the IELTS CBT room: the attempt page keeps the server clock, autosave
 * (revision, 409, recovery copy), section completion, submit, redirects and Echo Sentinel; this component renders the
 * room and calls the same callbacks. Interface copy is the mock's English wording; English Coach notices follow `lang`.
 *  - Listening: header (no footer), recordings play once in order, the screen follows the recording; no Back / Next /
 *    jump / pause / replay / seek in a simulation; Submit is not available until Listening is over (it never ends
 *    Listening early); the end of the last recording completes the section (no break before Reading).
 *  - Reading: two panes + footer (Mark item for review, question overview, Previous / Next by screen), Submit opens the
 *    mock's notification (Review / Finish test); the server deadline submits automatically when time is up.
 */

export interface ToeicIigShellProps {
  attemptId: string;
  manifest: PublicManifestDto;
  attemptState: AttemptStateDto;
  section: PublicSectionDto;
  skill: IigSkill;
  questionNumbers: Map<string, number>;
  responses: Record<string, any>;
  flaggedPlacements: Set<string>;
  onToggleFlag: (placementId: string) => void;
  remainingSeconds: number;
  isSimulation: boolean;
  isUntimed: boolean;
  isLastSection: boolean;
  saveStatus: 'SAVED' | 'SAVING' | 'UNSAVED' | 'ERROR' | 'CLOSED';
  onAnswer: (placementId: string, value: any) => void;
  onRetrySave?: () => void;
  /** Finalizes the attempt (runtime: flush, complete section, submit once, redirect). Rejects on failure. */
  onSubmit: () => Promise<void>;
  /** Simulation: end of the last Listening recording (runtime completes the section). */
  onCompleteListening?: () => void;
  /** Practice: leave the room (saved answers are kept). Not offered in a simulation. */
  onExit?: () => void;
  lang: 'vi' | 'en';
}

interface ItemRef {
  item: PublicItemDto;
  group: PublicGroupDto;
  part: PublicPartDto;
  entry: IigEntry;
}

// ─── Icons (drawn here; generic shapes, no third-party artwork) ─────────────────────────────────────────────────
const IconSpeaker = () => (
  <svg width="46%" height="46%" viewBox="0 0 24 24" aria-hidden fill="currentColor">
    <path d="M3 9v6h4l5 4V5L7 9H3z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
const IconClock = () => (
  <svg width="1.05em" height="1.05em" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" strokeLinecap="round" />
  </svg>
);
const IconGrid = () => (
  <svg width="34%" height="34%" viewBox="0 0 24 24" aria-hidden fill="currentColor">
    <rect x="2" y="3" width="4" height="4" />
    <rect x="8" y="3" width="14" height="4" />
    <rect x="2" y="10" width="4" height="4" />
    <rect x="8" y="10" width="14" height="4" />
    <rect x="2" y="17" width="4" height="4" />
    <rect x="8" y="17" width="14" height="4" />
  </svg>
);
const IconChevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg width="36%" height="36%" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    {dir === 'left' ? <path d="M15 4l-8 8 8 8" /> : <path d="M9 4l8 8-8 8" />}
  </svg>
);
const IconCheck = () => (
  <svg width="70%" height="70%" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

// ─── Stimulus helpers ────────────────────────────────────────────────────────────────────────────────────────────
function paragraphsOf(st: PublicStimulusDto): string[] {
  const body = st.bodyPayload || {};
  const raw = body.text || body.content || body.paragraphs || body.prompt || '';
  if (Array.isArray(raw)) return raw.map((p: any) => String(p?.text ?? p ?? '').trim()).filter(Boolean);
  if (typeof raw !== 'string') return [];
  let text = raw.trim();
  if (st.title) {
    const escaped = st.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`^(#{1,4}\\s*)?${escaped}\\s*\\n+`, 'i'), '').trim();
  } else {
    text = text.replace(/^#{1,3}\s+[^\n]+\n+/, '').trim();
  }
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function textStimuli(group: PublicGroupDto | undefined): PublicStimulusDto[] {
  return (group?.stimuli || []).filter((st) => String(st.kind || '').toUpperCase() !== 'AUDIO');
}

function imageAssets(group: PublicGroupDto | undefined) {
  return (group?.stimuli || []).flatMap((st) => (st.assets || []).filter((a) => isImageAsset(a) && !!a.assetId));
}

/** Directions printed for a set (group presentation) or its part; never invented. */
function directionsOf(group: PublicGroupDto | undefined, part: PublicPartDto | undefined): string[] {
  const lines = (group?.presentation?.instructions || []).map((l) => String(l || '').trim()).filter(Boolean);
  if (lines.length) return lines;
  const p = String(part?.instructions || '').trim();
  return p ? p.split(/\n+/).map((l) => l.trim()).filter(Boolean) : [];
}

function Directions({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <>
      <p className={s.directions}>{lines[0]}</p>
      {lines.slice(1).map((l, i) => (
        <p key={i} className={s.directionsMore}>
          {l}
        </p>
      ))}
    </>
  );
}

/** Part 6 / 7 documents: boxed, in source order, labelled "Passage n" when a set has several. */
function Passages({ group, attemptId }: { group: PublicGroupDto | undefined; attemptId: string }) {
  const blocks: Array<{ key: string; title?: string; paragraphs: string[]; images: ReturnType<typeof imageAssets> }> = [];
  for (const st of textStimuli(group)) {
    const docs = stimulusDocuments(st.kind, st.bodyPayload || {});
    const imgs = (st.assets || []).filter((a) => isImageAsset(a) && !!a.assetId);
    if (docs.segmented) {
      docs.documents.forEach((d, i) => blocks.push({ key: `${st.id}:${i}`, paragraphs: d.paragraphs, images: i === docs.documents.length - 1 ? imgs : [] }));
    } else {
      const paragraphs = paragraphsOf(st);
      if (paragraphs.length || imgs.length) blocks.push({ key: st.id, title: st.title || undefined, paragraphs, images: imgs });
    }
  }
  const labelled = blocks.length > 1;
  return (
    <>
      {blocks.map((b, i) => (
        <section key={b.key} aria-label={labelled ? `Passage ${i + 1}` : 'Passage'}>
          {labelled && <h3 className={s.passageLabel}>Passage {i + 1}</h3>}
          {(b.title || b.paragraphs.length > 0) && (
            <div className={s.passageBox}>
              {b.title && <p className={s.passageTitle}>{b.title}</p>}
              {b.paragraphs.map((p, k) => (
                <p key={k}>{p}</p>
              ))}
            </div>
          )}
          {b.images.map((a) => (
            <div key={a.assetId} className={s.figure}>
              <ExamAssetImage attemptId={attemptId} asset={a} alt={b.title || `Passage ${i + 1} image`} className={s.figureImg} />
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

// ─── Option list ─────────────────────────────────────────────────────────────────────────────────────────────────
function OptionList({
  refItem,
  value,
  disabled,
  onChoose,
}: {
  refItem: ItemRef;
  value: string;
  disabled: boolean;
  onChoose: (optionId: string) => void;
}) {
  const pid = refItem.item.placementId;
  const options = iigOptions(refItem.item, refItem.entry.partNumber);
  if (options.length === 0) {
    return <p className={s.muted}>No answer options are available for this question.</p>;
  }
  return (
    <div className={s.options} role="radiogroup" aria-labelledby={`iig-q-${pid}`}>
      {options.map((o) => {
        const selected = value === o.id;
        return (
          <label key={o.id} className={s.option} data-selected={selected ? 'true' : 'false'} data-disabled={disabled ? 'true' : 'false'}>
            <input
              type="radio"
              name={`iig-${pid}`}
              value={o.id}
              checked={selected}
              disabled={disabled}
              onChange={() => onChoose(o.id)}
            />
            <span className={s.radio} aria-hidden />
            <span className={s.optLetter}>({o.letter})</span>
            {o.text && <span className={s.optText}>{o.text}</span>}
          </label>
        );
      })}
    </div>
  );
}

// ─── Dialog ──────────────────────────────────────────────────────────────────────────────────────────────────────
function Dialog({
  labelledBy,
  onEscape,
  children,
}: {
  labelledBy: string;
  onEscape?: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus="true"]') || el?.querySelector<HTMLElement>('button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onEscape) {
        e.preventDefault();
        onEscape();
      }
      if (e.key === 'Tab' && el) {
        const nodes = Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled])'));
        if (!nodes.length) return;
        const firstN = nodes[0];
        const lastN = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === firstN) {
          e.preventDefault();
          lastN.focus();
        } else if (!e.shiftKey && document.activeElement === lastN) {
          e.preventDefault();
          firstN.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onEscape]);
  return (
    <div className={s.backdrop} role="presentation">
      <div ref={ref} className={s.dialog} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>
  );
}

function TileGrid({
  sectionLabel,
  parts,
  currentPid,
  onPick,
}: {
  sectionLabel: string;
  parts: IigTilePart[];
  currentPid?: string;
  onPick?: (placementId: string) => void;
}) {
  return (
    <>
      <div className={s.sectionBar}>{sectionLabel}</div>
      <div className={s.timeline}>
        {parts.map((p) => (
          <div key={p.partNumber} className={s.tPart}>
            <p className={s.tPartName}>Part {p.partNumber}</p>
            <div className={s.tiles}>
              {p.tiles.map((t) => {
                const label = `Question ${t.number}: ${t.status === 'answered' ? 'answered' : t.status === 'marked' ? 'marked for review' : 'unanswered'}`;
                return onPick ? (
                  <button
                    key={t.placementId}
                    type="button"
                    className={s.tile}
                    data-status={t.status}
                    data-current={t.placementId === currentPid ? 'true' : 'false'}
                    aria-label={label}
                    onClick={() => onPick(t.placementId)}
                  >
                    {t.number}
                  </button>
                ) : (
                  <span key={t.placementId} className={s.tile} data-status={t.status} role="img" aria-label={label}>
                    {t.number}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function playTestTone(volume: number) {
  try {
    const Ctx: typeof AudioContext | undefined = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return false;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    gain.gain.value = 0.22 * Math.max(0, Math.min(1, volume));
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.9);
    osc.onended = () => void ctx.close().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

// ─── Shell ───────────────────────────────────────────────────────────────────────────────────────────────────────
export function ToeicIigShell(props: ToeicIigShellProps) {
  const {
    attemptId,
    manifest,
    section,
    skill,
    questionNumbers,
    responses,
    flaggedPlacements,
    onToggleFlag,
    remainingSeconds,
    isSimulation,
    isUntimed,
    isLastSection,
    saveStatus,
    onAnswer,
    onRetrySave,
    onSubmit,
    onCompleteListening,
    onExit,
    lang,
  } = props;
  const vi = lang === 'vi';
  const parts = section.parts || [];

  const entries = useMemo(() => iigEntries(parts, questionNumbers, skill), [parts, questionNumbers, skill]);
  const refs = useMemo(() => {
    const m = new Map<string, ItemRef>();
    let k = 0;
    parts.forEach((part) =>
      (part.groups || []).forEach((group) =>
        (group.items || []).forEach((item) => {
          const entry = entries[k++];
          if (entry) m.set(item.placementId, { item, group, part, entry });
        })
      )
    );
    return m;
  }, [parts, entries]);

  // Whole-attempt totals for the header ("of 200", answered badge).
  const allPids = useMemo(
    () => manifest.sections.flatMap((sec) => sec.parts.flatMap((p) => p.groups.flatMap((g) => (g.items || []).map((i) => i.placementId)))),
    [manifest]
  );
  const answeredAll = allPids.filter((pid) => iigAnswered(responses[pid])).length;
  const timeUp = !isUntimed && remainingSeconds <= 0;
  const questionPaneRef = useRef<HTMLDivElement | null>(null);
  const stimulusPaneRef = useRef<HTMLDivElement | null>(null);
  const pendingScroll = useRef<string | null>(null);

  // ── Listening ──
  const units = useMemo(() => (skill === 'LISTENING' ? buildListeningUnits(parts) : []), [skill, parts]);
  const audio = useToeicListeningAudio({ enabled: skill === 'LISTENING', units, attemptId, isSimulation, onComplete: onCompleteListening });
  const unit = units[audio.unitIndex] || units[0];
  const unitEntries = useMemo(
    () => (skill === 'LISTENING' && unit ? entries.filter((e) => unit.partIndexes.includes(e.partIndex) && (!unit.groupIds || unit.groupIds.includes(e.groupId))) : []),
    [skill, unit, entries]
  );
  const listeningVisible = skill === 'LISTENING' && (!isSimulation || audio.started || audio.phase === 'ended' || audio.phase === 'playing');
  const listeningLocked = isSimulation && audio.phase === 'ended';
  const [focusPid, setFocusPid] = useState<string | null>(null);
  useEffect(() => {
    setFocusPid(unitEntries[0]?.placementId || null);
    questionPaneRef.current?.scrollTo({ top: 0 });
  }, [unit?.index]); // eslint-disable-line react-hooks/exhaustive-deps

  const cues = useMemo(() => unitEntries.map(entry => {
    const item = refs.get(entry.placementId)?.item;
    const defs = item?.optionDefinitions ?? item?.options;
    const ms = Array.isArray(defs) ? undefined : defs?.audioCueMs;
    return { pid: entry.placementId, ms };
  }), [refs, unitEntries]);
  const cue = listeningVisible && audio.phase === 'playing' && audio.time.unitIndex === unit?.index
    && cues.every((c, i) => Number.isInteger(c.ms) && c.ms >= 0 && c.ms < audio.time.duration * 1000 && (!i || c.ms > cues[i - 1].ms))
    ? cues.filter(c => c.ms <= audio.time.current * 1000).at(-1)?.pid : undefined;
  useEffect(() => {
    if (!cue) return;
    setFocusPid(cue);
    document.getElementById(`iig-block-${cue}`)?.scrollIntoView({ block: 'nearest' });
  }, [cue]);

  // ── Reading ──
  const screens = useMemo(() => (skill === 'READING' ? buildReadingScreens(entries) : []), [skill, entries]);
  const [screenIdx, setScreenIdx] = useState(0);
  const [currentPid, setCurrentPid] = useState<string | null>(null);
  const screen = screens[Math.min(screenIdx, Math.max(0, screens.length - 1))];
  const nav = readingNav(screens, screenIdx);

  const goToScreen = useCallback(
    (idx: number, targetPid?: string) => {
      const target = screens[idx];
      if (!target) return;
      setScreenIdx(idx);
      setCurrentPid(targetPid && target.placementIds.includes(targetPid) ? targetPid : target.placementIds[0]);
      pendingScroll.current = targetPid || null;
    },
    [screens]
  );
  useEffect(() => {
    if (skill !== 'READING') return;
    // [simulation choice] a new screen opens at the top of both panes; a jump to one question scrolls it into view.
    stimulusPaneRef.current?.scrollTo({ top: 0 });
    const pid = pendingScroll.current;
    pendingScroll.current = null;
    if (pid) {
      window.requestAnimationFrame(() => document.getElementById(`iig-block-${pid}`)?.scrollIntoView({ block: 'start' }));
    } else {
      questionPaneRef.current?.scrollTo({ top: 0 });
    }
  }, [skill, screenIdx]);
  useEffect(() => {
    if (skill === 'READING' && screen && (!currentPid || !screen.placementIds.includes(currentPid))) setCurrentPid(screen.placementIds[0]);
  }, [skill, screen, currentPid]);

  // ── Header pieces ──
  const titleNumbers = useMemo(() => {
    if (skill === 'READING') return screen?.numbers || [];
    if (!listeningVisible) return [];
    const ref = focusPid ? refs.get(focusPid) : undefined;
    if (!ref) return unitEntries.slice(0, 1).map((e) => e.number);
    if (ref.entry.partNumber >= 3) return entries.filter((e) => e.groupId === ref.entry.groupId).map((e) => e.number);
    return [ref.entry.number];
  }, [skill, screen, listeningVisible, focusPid, refs, unitEntries, entries]);
  const title = iigHeaderTitle(skill, titleNumbers, allPids.length);

  const [volumeOpen, setVolumeOpen] = useState(false);
  const volumeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!volumeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (volumeRef.current && !volumeRef.current.contains(e.target as Node)) setVolumeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setVolumeOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [volumeOpen]);

  // Submit is a Reading action in a simulation (it never ends Listening early); practice may always submit.
  const submitEnabled = !isSimulation || skill === 'READING' || (isLastSection && audio.phase === 'ended');
  const [dialog, setDialog] = useState<null | 'submit' | 'review' | 'exit'>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const counts = iigCounts(entries, responses, flaggedPlacements);

  const finish = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit();
    } catch {
      setSubmitError(
        vi
          ? 'Chưa nộp được bài. Câu trả lời vẫn được giữ — kiểm tra kết nối rồi bấm "Finish test" lại.'
          : 'The test was not submitted yet. Your answers are kept — check the connection and press "Finish test" again.'
      );
      setSubmitting(false);
    }
  };

  const choose = (pid: string, optionId: string) => {
    if (timeUp) return;
    onAnswer(pid, { value: optionId });
  };

  // ── Listening focus follows the question pane (view sync only; it never moves the recording) ──
  const onQuestionScroll = () => {
    if (skill !== 'LISTENING') return;
    const pane = questionPaneRef.current;
    if (!pane) return;
    const top = pane.getBoundingClientRect().top;
    const blocks = Array.from(pane.querySelectorAll<HTMLElement>('[data-iig-block]'));
    const first = blocks.find((b) => b.getBoundingClientRect().bottom > top + 24);
    const pid = first?.dataset.iigBlock;
    if (pid && pid !== focusPid) setFocusPid(pid);
  };

  const renderQuestion = (pid: string, current: boolean, disabled: boolean) => {
    const ref = refs.get(pid);
    if (!ref) return null;
    return (
      <div
        key={pid}
        id={`iig-block-${pid}`}
        data-iig-block={pid}
        data-part={ref.entry.partNumber}
        className={s.question}
        data-current={current ? 'true' : 'false'}
        onFocusCapture={() => (skill === 'READING' ? setCurrentPid(pid) : setFocusPid(pid))}
        onMouseDown={() => (skill === 'READING' ? setCurrentPid(pid) : setFocusPid(pid))}
      >
        <p id={`iig-q-${pid}`} className={s.qline}>
          {iigQuestionLine(ref.entry.number, ref.entry.partNumber, ref.item.prompt)}
        </p>
        <OptionList refItem={ref} value={iigSelected(responses[pid])} disabled={disabled} onChoose={(id) => choose(pid, id)} />
      </div>
    );
  };

  // ── Panes ──
  let stimulusPane: React.ReactNode = null;
  let questionPane: React.ReactNode = null;

  if (skill === 'READING' && screen) {
    const ref = refs.get(screen.placementIds[0]);
    const lines = directionsOf(ref?.group, ref?.part);
    stimulusPane = (
      <>
        <Directions lines={lines} />
        {screen.partNumber !== 5 && <Passages group={ref?.group} attemptId={attemptId} />}
        {screen.partNumber === 5 && lines.length === 0 && <span className={s.srOnly}>Part 5</span>}
      </>
    );
    questionPane = screen.placementIds.map((pid) => renderQuestion(pid, pid === currentPid && screen.placementIds.length > 1, timeUp));
  }

  if (skill === 'LISTENING' && listeningVisible) {
    const ref = (focusPid && refs.get(focusPid)) || (unitEntries[0] && refs.get(unitEntries[0].placementId));
    const imgs = imageAssets(ref?.group);
    const practiceBar = !isSimulation ? (
      <div className={s.audioBar}>
        <button
          type="button"
          className={s.playBtn}
          onClick={audio.togglePause}
          disabled={audio.phase === 'ended' || audio.phase === 'unavailable' || audio.phase === 'loading'}
          aria-label={audio.phase === 'playing' ? 'Pause' : 'Play'}
        >
          {audio.phase === 'playing' ? 'Pause' : 'Play'}
        </button>
        <span className={s.track} aria-hidden>
          <span style={{ width: `${audio.time.duration > 0 ? (audio.time.current / audio.time.duration) * 100 : 0}%` }} />
        </span>
        <span role="status" aria-live="polite" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {audio.phase === 'unavailable'
            ? vi
              ? 'Chưa tải được âm thanh'
              : 'Audio unavailable'
            : audio.phase === 'ended'
            ? vi
              ? 'Đã phát xong'
              : 'Finished'
            : `${iigClock(audio.time.current).slice(3)} / ${iigClock(audio.time.duration).slice(3)}`}
        </span>
      </div>
    ) : null;
    stimulusPane = (
      <>
        {practiceBar}
        {!isSimulation && (
          <p className={s.notice}>
            {vi ? 'Luyện tập: có thể tạm dừng bản ghi; bản ghi phát một lượt, không tua lại.' : 'Practice: you may pause the recording. It plays once and cannot be rewound.'}
          </p>
        )}
        {audio.phase === 'unavailable' && (
          <p className={s.notice} data-tone="error">
            {vi ? 'Không tải được bản ghi. ' : 'The recording could not be loaded. '}
            <button type="button" className={s.btnSecondary} onClick={audio.retry}>
              {vi ? 'Thử lại' : 'Try again'}
            </button>
          </p>
        )}
        <Directions lines={directionsOf(ref?.group, ref?.part)} />
        {imgs.map((a) => (
          <div key={a.assetId} className={s.figure}>
            <ExamAssetImage
              attemptId={attemptId}
              asset={a}
              alt={ref && ref.entry.partNumber === 1 ? `Photograph for question ${ref.entry.number}` : `Graphic for questions ${titleNumbers.join(', ')}`}
              className={s.figureImg}
            />
          </div>
        ))}
        {listeningLocked && (
          <p className={s.notice}>
            {isLastSection
              ? vi
                ? 'Phần Nghe đã kết thúc. Bấm Submit để nộp bài.'
                : 'The Listening test has ended. Press Submit to finish.'
              : vi
              ? 'Phần Nghe đã kết thúc. Phần Đọc đang mở…'
              : 'The Listening test has ended. The Reading test is opening…'}
          </p>
        )}
      </>
    );
    let lastGroup = '';
    questionPane = unitEntries.map((e) => {
      const block = renderQuestion(e.placementId, false, timeUp || listeningLocked);
      const ref2 = refs.get(e.placementId);
      const groupItems = ref2 ? (ref2.group.items || []).length : 1;
      const newSet = e.partNumber >= 3 && groupItems > 1 && e.groupId !== lastGroup;
      lastGroup = e.groupId;
      if (!newSet) return block;
      const nums = entries.filter((x) => x.groupId === e.groupId).map((x) => x.number);
      return (
        <React.Fragment key={`set-${e.groupId}`}>
          <p className={s.setHead}>Questions {nums.length > 1 ? `${Math.min(...nums)} - ${Math.max(...nums)}` : nums[0]}</p>
          {block}
        </React.Fragment>
      );
    });
  }

  const currentMarked = !!(currentPid && flaggedPlacements.has(currentPid));
  const currentNumber = currentPid ? refs.get(currentPid)?.entry.number : undefined;
  const submitMsg = iigSubmitMessage(counts.unanswered, counts.marked);
  const attentionParts = iigTileParts(entries, responses, flaggedPlacements, true);
  const sectionLabel = skill === 'LISTENING' ? 'Listening' : 'Reading';

  return (
    <div className={s.room} data-skill={skill} data-mode={isSimulation ? 'simulation' : 'practice'} translate="no" data-morph="off" data-testid="toeic-iig-room">
      <audio ref={audio.audioRef} preload="auto" hidden />

      <header className={s.header}>
        <div className={s.identity}>
          <span className={s.brand} aria-label="English Coach TOEIC simulation">
            <span className={s.brandName}>English Coach</span>
            <span className={s.brandSub}>{isSimulation ? 'TOEIC simulation' : 'TOEIC practice'}</span>
          </span>
          {!isSimulation && onExit && (
            <button type="button" className={s.exitBtn} onClick={() => setDialog('exit')}>
              Exit
            </button>
          )}
        </div>
        <h1 className={s.title} data-testid="iig-title">
          {title}
        </h1>
        <div className={s.cluster}>
          {(saveStatus === 'ERROR' || saveStatus === 'CLOSED') && (
            saveStatus === 'ERROR' && onRetrySave ? (
              <button type="button" className={s.saveError} onClick={onRetrySave} title={vi ? 'Câu trả lời mới chưa lên máy chủ' : 'New answers have not reached the server'}>
                {vi ? 'Chưa lưu · Thử lại' : 'Not saved · Retry'}
              </button>
            ) : (
              <span className={s.saveError} data-static="true">
                {saveStatus === 'CLOSED' ? (vi ? 'Bài đã đóng' : 'Closed') : vi ? 'Chưa lưu' : 'Not saved'}
              </span>
            )
          )}
          <div ref={volumeRef} style={{ display: 'contents' }}>
            <button
              type="button"
              className={s.speaker}
              aria-label="Volume"
              aria-expanded={skill === 'LISTENING' ? volumeOpen : undefined}
              aria-disabled={skill !== 'LISTENING' ? 'true' : undefined}
              title={skill !== 'LISTENING' ? 'No audio in the Reading test' : 'Volume'}
              onClick={() => skill === 'LISTENING' && setVolumeOpen((v) => !v)}
              data-testid="iig-speaker"
            >
              <IconSpeaker />
            </button>
            {volumeOpen && skill === 'LISTENING' && (
              <div className={s.volumePop} role="group" aria-label="Volume">
                <label htmlFor="iig-volume">Volume</label>
                <input
                  id="iig-volume"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(audio.volume * 100)}
                  onChange={(e) => audio.setVolume(Number(e.target.value) / 100)}
                  data-testid="iig-volume"
                />
                <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: '3ch' }}>{Math.round(audio.volume * 100)}</span>
              </div>
            )}
          </div>
          <span className={s.badge} aria-label={`Answered ${answeredAll} of ${allPids.length}`} data-testid="iig-count">
            {answeredAll}/{allPids.length}
          </span>
          <span className={s.clock} role="timer" aria-label={isUntimed ? 'No time limit' : `Time remaining ${iigClock(remainingSeconds)}`} data-testid="iig-clock">
            <IconClock />
            {isUntimed ? (vi ? 'Không giới hạn' : 'No limit') : iigClock(remainingSeconds)}
          </span>
          <button
            type="button"
            className={s.submit}
            disabled={!submitEnabled}
            title={!submitEnabled ? (vi ? 'Nộp bài có ở phần Đọc' : 'Submit is available in the Reading test') : undefined}
            onClick={() => {
              setSubmitError(null);
              setDialog('submit');
            }}
            data-testid="iig-submit"
          >
            Submit
          </button>
        </div>
      </header>

      {skill === 'LISTENING' && !listeningVisible ? (
        <div className={s.gate}>
          <div className={s.gateCard} data-testid="iig-listening-gate">
            <h2>Listening Test</h2>
            <p>
              {vi
                ? 'Phần Nghe phát một lượt duy nhất, lần lượt từ Part 1 đến Part 4, như bài thi trên máy tính. Sau khi bắt đầu, bạn không thể tạm dừng, tua lại hay quay lại câu trước; câu hỏi đổi theo bản ghi.'
                : 'The Listening test plays once, from Part 1 to Part 4, as in the computer-based test. Once it starts you cannot pause, rewind or go back; the questions change with the recording.'}
            </p>
            <p>
              {vi
                ? 'Kiểm tra tai nghe: bấm "Test sound" để nghe một âm thử và chỉnh âm lượng trước khi bắt đầu.'
                : 'Check your headphones: press "Test sound" to hear a test tone and set the volume before you start.'}
            </p>
            <div className={s.gateRow}>
              <button type="button" className={s.btnSecondary} onClick={() => playTestTone(audio.volume)} data-testid="iig-test-sound">
                Test sound
              </button>
              <label htmlFor="iig-gate-volume" className={s.muted}>
                Volume
              </label>
              <input
                id="iig-gate-volume"
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(audio.volume * 100)}
                onChange={(e) => audio.setVolume(Number(e.target.value) / 100)}
              />
            </div>
            {audio.phase === 'unavailable' ? (
              <p className={s.notice} data-tone="error">
                {vi ? 'Chưa tải được bản ghi của phần Nghe. ' : 'The Listening recording could not be loaded. '}
                <button type="button" className={s.btnSecondary} onClick={audio.retry} data-testid="iig-audio-retry">
                  {vi ? 'Tải lại âm thanh' : 'Reload audio'}
                </button>
              </p>
            ) : null}
            <div className={s.gateRow}>
              <button
                type="button"
                className={s.btnPrimary}
                onClick={() => void audio.start()}
                disabled={audio.phase === 'unavailable' || audio.phase === 'loading' || timeUp}
                data-testid="iig-start-listening"
              >
                {audio.unitIndex > 0 ? (vi ? 'Tiếp tục phần Nghe' : 'Continue Listening') : vi ? 'Bắt đầu phần Nghe' : 'Start Listening'}
              </button>
              {audio.phase === 'loading' && <span className={s.muted}>{vi ? 'Đang tải âm thanh…' : 'Loading audio…'}</span>}
            </div>
          </div>
        </div>
      ) : (
        <div className={s.body}>
          <section className={s.pane} aria-label={skill === 'LISTENING' ? 'Directions and picture' : 'Passage'}>
            <div ref={stimulusPaneRef} className={s.scroll} style={{ paddingTop: 'calc(var(--iig-pad) * 0.9)' }} data-testid="iig-stimulus-pane">
              {stimulusPane}
            </div>
          </section>
          <section className={s.pane} aria-label="Questions">
            <h2 className={s.paneHead}>Question</h2>
            <div ref={questionPaneRef} className={s.scroll} onScroll={onQuestionScroll} data-testid="iig-question-pane">
              {questionPane}
            </div>
          </section>
        </div>
      )}

      {skill === 'READING' && screen && (
        <footer className={s.footer} data-testid="iig-footer">
          <label className={s.mark} data-checked={currentMarked ? 'true' : 'false'}>
            <input
              type="checkbox"
              checked={currentMarked}
              onChange={() => currentPid && onToggleFlag(currentPid)}
              aria-label={currentNumber ? `Mark item ${currentNumber} for review` : 'Mark item for review'}
              data-testid="iig-mark"
            />
            <span className={s.markBox} aria-hidden>
              {currentMarked && <IconCheck />}
            </span>
            Mark item for review
          </label>
          <span className={s.footSpacer} />
          <button type="button" className={s.gridBtn} aria-label="Review questions" onClick={() => setDialog('review')} data-testid="iig-review">
            <IconGrid />
          </button>
          <button type="button" className={s.navBtn} aria-label="Previous" disabled={!nav.canPrev} onClick={() => goToScreen(screenIdx - 1)} data-testid="iig-prev">
            <IconChevron dir="left" />
          </button>
          <button type="button" className={s.navBtn} aria-label="Next" disabled={!nav.canNext} onClick={() => goToScreen(screenIdx + 1)} data-testid="iig-next">
            <IconChevron dir="right" />
          </button>
        </footer>
      )}

      {dialog === 'submit' && (
        <Dialog labelledBy="iig-submit-title" onEscape={submitting ? undefined : () => setDialog(null)}>
          <div className={s.dialogBody} data-testid="iig-submit-dialog">
            <h2 id="iig-submit-title" className={s.alertHead}>
              {submitMsg.heading}
            </h2>
            <p className={s.alertMsg}>{submitMsg.message}</p>
            {attentionParts.length > 0 && (
              <>
                <TileGrid
                  sectionLabel={sectionLabel}
                  parts={attentionParts}
                  onPick={
                    skill === 'READING'
                      ? (pid) => {
                          setDialog(null);
                          goToScreen(screenIndexOf(screens, pid), pid);
                        }
                      : undefined
                  }
                />
                <div className={s.legend} aria-hidden>
                  <span>
                    <i style={{ background: '#dcdcdc' }} /> Unanswered
                  </span>
                  <span>
                    <i style={{ background: '#f28221' }} /> Marked for review
                  </span>
                </div>
              </>
            )}
          </div>
          {submitError && (
            <p className={s.dialogError} role="alert">
              {submitError}
            </p>
          )}
          <div className={s.dialogFoot}>
            <button type="button" className={s.btnSecondary} onClick={() => setDialog(null)} disabled={submitting} data-testid="iig-dialog-review">
              Review
            </button>
            <button type="button" className={s.btnPrimary} onClick={() => void finish()} disabled={submitting} data-testid="iig-finish">
              {submitting ? 'Submitting…' : 'Finish test'}
            </button>
          </div>
        </Dialog>
      )}

      {dialog === 'review' && skill === 'READING' && (
        <Dialog labelledBy="iig-review-title" onEscape={() => setDialog(null)}>
          <div className={s.dialogBody} data-testid="iig-review-dialog">
            <h2 id="iig-review-title" className={s.alertHead} style={{ color: 'var(--iig-review)' }}>
              REVIEW
            </h2>
            <p className={s.alertMsg}>
              {counts.answered}/{counts.total} answered · {counts.marked} marked for review
            </p>
            <TileGrid
              sectionLabel={sectionLabel}
              parts={iigTileParts(entries, responses, flaggedPlacements, false)}
              currentPid={currentPid || undefined}
              onPick={(pid) => {
                setDialog(null);
                goToScreen(screenIndexOf(screens, pid), pid);
              }}
            />
            <div className={s.legend} aria-hidden>
              <span>
                <i style={{ background: '#0a4d8d' }} /> Answered
              </span>
              <span>
                <i style={{ background: '#dcdcdc' }} /> Unanswered
              </span>
              <span>
                <i style={{ background: '#f28221' }} /> Marked for review
              </span>
            </div>
          </div>
          <div className={s.dialogFoot}>
            <button type="button" className={s.btnPrimary} onClick={() => setDialog(null)} data-autofocus="true">
              Return
            </button>
          </div>
        </Dialog>
      )}

      {dialog === 'exit' && onExit && (
        <Dialog labelledBy="iig-exit-title" onEscape={() => setDialog(null)}>
          <div className={`${s.dialogBody} ${s.plainDialog}`}>
            <h2 id="iig-exit-title" className={s.alertHead} style={{ color: 'var(--iig-review)' }}>
              EXIT
            </h2>
            <p className={s.alertMsg}>
              {vi
                ? 'Rời bài luyện tập? Câu trả lời đã lưu vẫn được giữ; bạn có thể quay lại làm tiếp.'
                : 'Leave this practice? Saved answers are kept and you can continue later.'}
            </p>
            {(saveStatus === 'ERROR' || saveStatus === 'UNSAVED') && (
              <p className={s.notice}>
                {vi
                  ? 'Một số câu trả lời mới chưa lên máy chủ; chúng được giữ trên thiết bị này và sẽ được gửi khi bạn quay lại.'
                  : 'Some new answers have not reached the server yet; they stay on this device and are sent when you return.'}
              </p>
            )}
          </div>
          <div className={s.dialogFoot}>
            <button type="button" className={s.btnSecondary} onClick={() => setDialog(null)}>
              {vi ? 'Làm tiếp' : 'Keep working'}
            </button>
            <button type="button" className={s.btnPrimary} onClick={onExit}>
              {vi ? 'Về kho đề' : 'Back to library'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export default ToeicIigShell;
