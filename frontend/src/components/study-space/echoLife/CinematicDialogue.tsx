'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Award, BookOpen, Briefcase, Coffee, Compass, Gift, Home, MessageSquare } from 'lucide-react';
import portraits from '@/lib/echo-life/game/portraits.json';
import { cleanDisplayCopy } from '@/lib/echo-life/game/session';
import type { ResidentDiaryEntry } from '@/lib/echo-life/game/playerMind';
import type { V3Option } from '@/lib/echo-life/v3/game-core/index.mjs';
import s from './echoLife.module.css';

export interface DialogueRelationship {
  friendship: number;
  romance?: number;
  trust: number;
  familiarity: number;
  respect: number;
  rivalry?: number;
  tier: string;
}

export interface DialoguePerkBadge {
  title: string;
  effect: string;
  unlocked: boolean;
}

export type SocialFilterCategory = 'all' | 'friendly' | 'funny' | 'thoughtful' | 'activity' | 'conflict';

const SOCIAL_CATEGORIES: readonly { id: SocialFilterCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'friendly', label: 'Friendly' },
  { id: 'funny', label: 'Funny' },
  { id: 'thoughtful', label: 'Thoughtful' },
  { id: 'activity', label: 'Activity' },
  { id: 'conflict', label: 'Conflict' },
];

interface Props {
  speaker: string;
  residentId?: string;
  role?: string;
  badge?: string;
  mood?: string | null;
  rel?: DialogueRelationship | null;
  perk?: DialoguePerkBadge | null;
  memory?: string;
  diary?: readonly ResidentDiaryEntry[] | null;
  extraContent?: ReactNode;
  text: string;
  options: V3Option[];
  onSpeechCue?: (char: string) => void;
  onChoose: (option: V3Option) => Promise<void> | void;
  onClose: () => void;
}

const PAGE_SIZE = 6;

const MOOD_LABELS: Record<string, string> = {
  cheerful: 'Cheerful',
  focused: 'Focused',
  relaxed: 'Relaxed',
  excited: 'Upbeat',
  tired: 'Tired',
  sheltering: 'Sheltering',
  cozy: 'Cozy',
  curious: 'Curious',
  neutral: 'Calm',
};

/** Removes repeated speaker name prefixes (e.g. "Linh: Linh: Hi" -> "Hi") so the header and log stay clean. */
function stripSpeakerPrefix(speaker: string, raw: string): string {
  const trimmed = cleanDisplayCopy(raw);
  const name = cleanDisplayCopy(speaker);
  if (!trimmed || !name) return trimmed;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixRe = new RegExp(`^(?:${escaped}\\s*[:—-]\\s*)+`, 'i');
  return trimmed.replace(prefixRe, '').trim() || trimmed;
}

function classifySocialOption(option: V3Option): Exclude<SocialFilterCategory, 'all'> {
  const k = (option.kind ?? '').toLowerCase();
  const key = (option.key ?? '').toLowerCase();
  const label = (option.label ?? '').toLowerCase();
  if (
    k === 'conflict' ||
    key === 'apologize' ||
    /apologize|clear the air|disagree|debate|rival|confront|challenge/.test(key + ' ' + label)
  ) {
    return 'conflict';
  }
  if (
    k === 'activity' ||
    k === 'invite' ||
    k === 'work' ||
    k === 'shop' ||
    key.startsWith('activity:') ||
    key.startsWith('invite') ||
    key.startsWith('job:') ||
    key.startsWith('open_store:')
  ) {
    return 'activity';
  }
  if (
    k === 'story' ||
    k === 'sidequest' ||
    key.startsWith('choice:') ||
    key.startsWith('sq:') ||
    key.includes('rumor') ||
    key.includes('advice') ||
    key.includes('mem_') ||
    /plan|goal|reflect|advice|story|charter|budget|dream|memory|reminisce|project|decision/.test(label)
  ) {
    return 'thoughtful';
  }
  if (
    key === 'say1' ||
    /joke|tease|banter|laugh|playful|witty|rhythm|combo|toss|funny|quip/.test(key + ' ' + label)
  ) {
    return 'funny';
  }
  return 'friendly';
}

function computeRomanceScore(rel: DialogueRelationship): number {
  if (typeof rel.romance === 'number' && Number.isFinite(rel.romance)) {
    return Math.max(0, Math.min(100, Math.round(rel.romance)));
  }
  const base = rel.friendship >= 25
    ? Math.round(rel.friendship * 0.55 + rel.trust * 0.45 - 15)
    : Math.round(rel.familiarity * 0.35);
  return Math.max(0, Math.min(100, base));
}

function optionIcon(option: V3Option) {
  const k = option.kind ?? '';
  const key = option.key ?? '';
  if (k === 'story' || k === 'sidequest' || key.startsWith('sq:') || key.startsWith('choice:')) {
    return <Compass size={13} aria-hidden="true" className={s.optIcon} />;
  }
  if (k === 'work' || key.startsWith('job:')) {
    return <Briefcase size={13} aria-hidden="true" className={s.optIcon} />;
  }
  if (k === 'gift' || key.startsWith('gift:')) {
    return <Gift size={13} aria-hidden="true" className={s.optIcon} />;
  }
  if (k === 'invite' || key.startsWith('invite')) {
    return <Home size={13} aria-hidden="true" className={s.optIcon} />;
  }
  if (key.startsWith('activity:') || key.includes('tea') || key.includes('bistro')) {
    return <Coffee size={13} aria-hidden="true" className={s.optIcon} />;
  }
  return <MessageSquare size={13} aria-hidden="true" className={s.optIcon} />;
}

export function CinematicDialogue({
  speaker,
  residentId,
  role,
  badge,
  mood,
  rel,
  perk,
  memory,
  diary,
  extraContent,
  text,
  options,
  onSpeechCue,
  onChoose,
  onClose,
}: Props) {
  const [count, setCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const [page, setPage] = useState(0);
  const [category, setCategory] = useState<SocialFilterCategory>('all');
  const [waiting, setWaiting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showRel, setShowRel] = useState(false);
  const [showDiary, setShowDiary] = useState(false);
  const [history, setHistory] = useState<{ speaker: string; text: string }[]>([]);
  const [relDeltaText, setRelDeltaText] = useState<string | null>(null);
  const busy = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const prevRelRef = useRef<{ id?: string; rel: DialogueRelationship | null }>({ id: residentId, rel: rel ?? null });
  const deltaTimerRef = useRef<number | null>(null);
  const speechCounterRef = useRef(0);

  const safeSpeaker = useMemo(() => cleanDisplayCopy(speaker), [speaker]);
  const safeRole = useMemo(() => (role ? cleanDisplayCopy(role) : ''), [role]);
  const safeBadge = useMemo(() => (badge ? cleanDisplayCopy(badge) : ''), [badge]);
  const safeMemory = useMemo(() => (memory ? cleanDisplayCopy(memory) : ''), [memory]);
  const moodLabel = mood ? (MOOD_LABELS[mood.toLowerCase()] ?? mood.charAt(0).toUpperCase() + mood.slice(1)) : null;

  const cleanText = useMemo(() => stripSpeakerPrefix(safeSpeaker, text), [safeSpeaker, text]);
  const letters = useMemo(() => Array.from(cleanText), [cleanText]);
  const portrait = residentId ? portraits.speakers.indexOf(residentId) : -1;

  const categoryCounts = useMemo(() => {
    const counts: Record<SocialFilterCategory, number> = {
      all: options.length,
      friendly: 0,
      funny: 0,
      thoughtful: 0,
      activity: 0,
      conflict: 0,
    };
    for (const o of options) {
      counts[classifySocialOption(o)]++;
    }
    return counts;
  }, [options]);

  const filteredOptions = useMemo(() => {
    if (!residentId || category === 'all') return options;
    return options.filter(o => classifySocialOption(o) === category);
  }, [residentId, category, options]);

  const visible = useMemo(
    () => filteredOptions.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [filteredOptions, page],
  );

  useEffect(() => {
    const before = document.activeElement;
    dialog.current?.focus();
    return () => { if (before instanceof HTMLElement && before.isConnected) before.focus(); };
  }, []);

  // Reset history, filter & delta baseline when speaking with a different resident/target.
  useEffect(() => {
    setHistory([]);
    setShowHistory(false);
    setShowRel(false);
    setShowDiary(false);
    setCategory('all');
    setPage(0);
    setRelDeltaText(null);
    prevRelRef.current = { id: residentId, rel: rel ?? null };
    return () => {
      if (deltaTimerRef.current !== null) {
        window.clearTimeout(deltaTimerRef.current);
        deltaTimerRef.current = null;
      }
    };
  }, [residentId, safeSpeaker]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track relationship changes after choices and show a clean 2.4 s delta badge in the header.
  useEffect(() => {
    const prev = prevRelRef.current;
    if (rel && prev.id === residentId && prev.rel) {
      const parts: string[] = [];
      const add = (label: string, nextVal: number, oldVal: number) => {
        const diff = Math.round(nextVal) - Math.round(oldVal);
        if (diff !== 0) parts.push(`${diff > 0 ? '+' : ''}${diff} ${label}`);
      };
      add('Friendship', rel.friendship, prev.rel.friendship);
      add('Romance', computeRomanceScore(rel), computeRomanceScore(prev.rel));
      add('Respect', rel.respect, prev.rel.respect);
      add('Trust', rel.trust, prev.rel.trust);
      if (parts.length > 0) {
        setRelDeltaText(parts.slice(0, 2).join(' · '));
        if (deltaTimerRef.current !== null) window.clearTimeout(deltaTimerRef.current);
        deltaTimerRef.current = window.setTimeout(() => {
          setRelDeltaText(null);
          deltaTimerRef.current = null;
        }, 2400);
      }
    }
    prevRelRef.current = { id: residentId, rel: rel ?? null };
  }, [residentId, rel]);

  // Append newly delivered lines to the conversation history log.
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setCount(reduced ? Infinity : 0);
    setPaused(false);
    setPage(0);
    speechCounterRef.current = 0;
    if (reduced && cleanText) {
      onSpeechCue?.(cleanText.charAt(0));
    }
    if (!cleanText) return;
    setHistory(prev => {
      const last = prev.at(-1);
      if (last && last.speaker === safeSpeaker && last.text === cleanText) return prev;
      return [...prev.slice(-19), { speaker: safeSpeaker, text: cleanText }];
    });
  }, [safeSpeaker, cleanText]); // eslint-disable-line react-hooks/exhaustive-deps

  const previous = letters[count - 1] ?? '';
  useEffect(() => {
    if (paused || count >= letters.length) return;
    const ch = letters[count] ?? '';
    const timer = window.setTimeout(() => {
      if (ch && /\S/.test(ch)) {
        speechCounterRef.current++;
        if (speechCounterRef.current === 1 || speechCounterRef.current % 4 === 0 || ch === '?' || ch === '!') {
          onSpeechCue?.(ch);
        }
      }
      setCount(n => n + 1);
    }, /[.!?]/u.test(previous) ? 210 : /[,—]/u.test(previous) ? 95 : 20);
    return () => clearTimeout(timer);
  }, [count, paused, previous, letters, onSpeechCue]);

  const choose = useCallback(async (option: V3Option) => {
    if (busy.current) return;
    busy.current = true;
    setWaiting(true);
    try { await onChoose(option); }
    finally { busy.current = false; setWaiting(false); }
  }, [onChoose]);

  // Keep a single capture-phase keyboard listener mounted strictly while dialogue is open.
  const keyState = useRef({
    onClose,
    choose,
    visible,
    revealing: count < letters.length,
    hasHistory: history.length > 0,
  });

  useEffect(() => {
    keyState.current = {
      onClose,
      choose,
      visible,
      revealing: count < letters.length,
      hasHistory: history.length > 0,
    };
  }, [onClose, choose, visible, count, letters.length, history.length]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const st = keyState.current;
      if (e.key === 'Escape') {
        st.onClose();
      } else if (e.code === 'Space' && st.revealing) {
        setCount(Infinity);
      } else if ((e.key === 'h' || e.key === 'H') && st.hasHistory) {
        setShowHistory(v => !v);
      } else if (/^[1-9]$/.test(e.key)) {
        const picked = st.visible[Number(e.key) - 1];
        if (!picked) return;
        if (!e.repeat) void st.choose(picked);
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const expanded = showHistory || showRel || showDiary || Boolean(extraContent);
  const romanceVal = rel ? computeRomanceScore(rel) : 0;

  return (
    <>
      <div
        className={s.vignette}
        aria-hidden="true"
        style={{
          background: 'linear-gradient(to top, rgb(6 14 24 / 0.52) 0%, rgb(6 14 24 / 0.14) 26%, transparent 50%)',
        }}
      />
      <section
        ref={dialog}
        tabIndex={-1}
        className={s.dialog}
        role="dialog"
        aria-label={safeSpeaker}
        data-testid="echo-life-dialog"
        style={{
          bottom: 'max(18px, env(safe-area-inset-bottom))',
          width: 'min(720px, calc(100% - 28px))',
          maxHeight: expanded ? 'min(58vh, 460px)' : '310px',
          padding: '10px 14px 11px',
        }}
      >
        <header style={{ alignItems: 'center', gap: 10 }}>
          <div className={s.speaker} style={{ gap: '0.6rem' }}>
            {portrait >= 0 && (
              <span
                aria-hidden="true"
                className={s.portrait}
                style={{
                  width: 38,
                  height: 38,
                  backgroundImage: `url(${portraits.image})`,
                  backgroundSize: `${portraits.columns * 100}% ${portraits.rows * 100}%`,
                  backgroundPosition: `${(portrait % portraits.columns) * 100 / (portraits.columns - 1)}% ${Math.floor(portrait / portraits.columns) * 100 / (portraits.rows - 1)}%`,
                }}
              />
            )}
            <div className={s.dialogMeta}>
              <div className={s.dialogTitleRow}>
                <h2 style={{ fontSize: 16, lineHeight: 1.2 }}>{safeSpeaker}</h2>
                {moodLabel && (
                  <span className={s.moodBadge} data-mood={mood?.toLowerCase()} data-testid="echo-life-dialog-mood">
                    {moodLabel}
                  </span>
                )}
                {safeBadge && !rel && <span className={s.dialogBadge}>{safeBadge}</span>}
                {rel && (
                  <button
                    type="button"
                    className={s.relPill}
                    aria-expanded={showRel}
                    data-testid="echo-life-rel-toggle"
                    onClick={() => { setShowRel(v => !v); setShowDiary(false); }}
                  >
                    {cleanDisplayCopy(rel.tier)}
                  </button>
                )}
                {relDeltaText && (
                  <span className={s.relDelta} role="status" data-testid="echo-life-rel-delta">
                    {relDeltaText}
                  </span>
                )}
              </div>
              {safeRole && <p className={s.dialogRole} style={{ fontSize: 11.5 }}>{safeRole}</p>}
              {safeMemory && (
                <p className={s.dialogMemoryLine} data-testid="echo-life-dialog-memory">
                  Remembers: {safeMemory}
                </p>
              )}
            </div>
          </div>
          <div className={s.dialogHeaderTools}>
            {diary && diary.length > 0 && (
              <button
                type="button"
                className={s.toolBtn}
                aria-pressed={showDiary}
                data-testid="echo-life-dialog-diary-toggle"
                onClick={() => { setShowDiary(v => !v); setShowRel(false); }}
                title="Read resident daily diary"
              >
                <BookOpen size={12} aria-hidden="true" />
                <span>Diary</span>
              </button>
            )}
            {history.length > 0 && (
              <button type="button" className={s.toolBtn} aria-pressed={showHistory} onClick={() => setShowHistory(v => !v)} title="Conversation log (H)">
                Log <kbd>H</kbd>
              </button>
            )}
            <button type="button" className={s.close} onClick={onClose} aria-label="Close dialogue">×</button>
          </div>
        </header>

        {showRel && rel && (
          <div className={s.relPopover} data-testid="echo-life-rel-popover">
            <div className={s.relTracks}>
              {([
                ['friendship', 'Friendship', Math.round(rel.friendship)],
                ['romance', 'Romance', romanceVal],
                ['respect', 'Respect', Math.round(rel.respect)],
                ['trust', 'Trust', Math.round(rel.trust)],
              ] as const).map(([key, label, val]) => (
                <div key={key} className={s.relTrackRow} data-track={key}>
                  <span>{label}</span>
                  <span className={s.relTrackBar}><i style={{ width: `${Math.max(4, Math.min(100, val))}%` }} /></span>
                  <b>{val}</b>
                </div>
              ))}
            </div>
            {perk && (
              <p className={s.relPerk}>
                <Award size={12} aria-hidden="true" />
                <span>
                  <b>{cleanDisplayCopy(perk.title)}</b> ({perk.unlocked ? 'Active' : 'Close Friend perk'}) — {cleanDisplayCopy(perk.effect)}
                </span>
              </p>
            )}
            {safeMemory && <p className={s.relMemory}>“{safeMemory}”</p>}
          </div>
        )}

        {showDiary && diary && diary.length > 0 && (
          <div className={s.diaryDrawer} data-testid="echo-life-dialog-diary" aria-label="Resident Diary">
            {diary.map(entry => (
              <article key={entry.period} className={s.diaryEntry}>
                <div className={s.diaryHead}>
                  <span className={s.diaryPeriod}>{entry.period}</span>
                  <b>{cleanDisplayCopy(entry.headline)}</b>
                  <span className={s.diaryMood}>{cleanDisplayCopy(entry.moodTag)}</span>
                </div>
                <p>{cleanDisplayCopy(entry.body)}</p>
              </article>
            ))}
          </div>
        )}

        {showHistory && history.length > 0 && (
          <div className={s.historyDrawer} data-testid="echo-life-dialog-history" aria-label="Conversation history">
            {history.map((item, idx) => (
              <p key={idx}><b>{item.speaker}:</b> {item.text}</p>
            ))}
          </div>
        )}

        {cleanText && (
          <div data-testid="echo-life-reply">
            <span className={s.screenReader} role="status">{cleanText}</span>
            <p
              aria-hidden="true"
              className={s.subtitle}
              onClick={() => setCount(Infinity)}
              style={{
                margin: '7px 0 8px',
                fontSize: 'clamp(14px, 1.22vw, 16px)',
                lineHeight: 1.42,
                maxHeight: '4.35em',
                overflowY: 'auto',
              }}
            >
              {letters.slice(0, count).join('')}
            </p>
            {count < letters.length && (
              <div className={s.dialogTools} style={{ fontSize: 12, marginBottom: 4 }}>
                <button type="button" onClick={() => setPaused(v => !v)}>{paused ? 'Resume' : 'Pause'}</button>
                <button type="button" onClick={() => setCount(Infinity)}>Show full line</button>
              </div>
            )}
          </div>
        )}

        {extraContent}

        {residentId && options.length > 1 && (
          <div className={s.dialogCatBar} role="tablist" aria-label="Social response categories" data-testid="dialog-cat-bar">
            {SOCIAL_CATEGORIES.map(cat => {
              const cnt = categoryCounts[cat.id];
              return (
                <button
                  key={cat.id}
                  type="button"
                  role="tab"
                  className={s.dialogCatPill}
                  aria-selected={category === cat.id}
                  data-empty={cnt === 0 ? '1' : undefined}
                  data-testid={`dialog-cat-${cat.id}`}
                  onClick={() => { setCategory(cat.id); setPage(0); }}
                >
                  <span>{cat.label}</span>
                  {cat.id !== 'all' && cnt > 0 && <em>{cnt}</em>}
                </button>
              );
            })}
          </div>
        )}

        <div
          className={s.options}
          style={{
            marginTop: 6,
            gap: 5,
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))',
          }}
        >
          {visible.length === 0 ? (
            <p className={s.dialogEmptyCat}>No responses in this category right now. Switch back to All to view every topic.</p>
          ) : (
            visible.map((o, i) => (
              <button
                type="button"
                key={o.key}
                disabled={waiting}
                data-key={o.key}
                data-kind={o.kind ?? 'act'}
                onClick={() => void choose(o)}
                className={s.optBtn}
                style={{ padding: '6px 10px', fontSize: 13, lineHeight: 1.25 }}
              >
                <kbd>{i + 1}</kbd>
                {optionIcon(o)}
                <span>{cleanDisplayCopy(o.label)}</span>
              </button>
            ))
          )}
        </div>

        {filteredOptions.length > PAGE_SIZE && (
          <div className={s.dialogTools} style={{ fontSize: 12, marginTop: 6 }}>
            <button type="button" disabled={!page} onClick={() => setPage(v => v - 1)}>Previous</button>
            <button type="button" disabled={(page + 1) * PAGE_SIZE >= filteredOptions.length} onClick={() => setPage(v => v + 1)}>More responses</button>
          </div>
        )}
      </section>
    </>
  );
}
