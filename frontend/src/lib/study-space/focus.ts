/**
 * Đồng hồ tập trung — one timer per account, shared by every view of it (room object, widget, the floating dock on
 * other pages, a separate window, Picture-in-Picture). Time is never counted by ticks: the state stores when the
 * running segment began (epoch ms) and what was already done, and every view computes the rest from the clock, so a
 * throttled background tab, a reload or a closed tab never makes it drift. Tabs share the state through localStorage
 * + BroadcastChannel; the server keeps the record of focused time and caps it by its own clock (V110).
 * This file is in the main bundle (the dock reads it on every page): no React, no three, no heavy imports.
 */

export type FocusMode = 'POMODORO' | 'COUNTDOWN' | 'STOPWATCH';
export type FocusPhase = 'focus' | 'short' | 'long';
export type FocusStatus = 'idle' | 'running' | 'paused';

export interface FocusSettings {
  focusMin: number;
  shortMin: number;
  longMin: number;
  cyclesBeforeLong: number;
  autoBreaks: boolean;
  autoFocus: boolean;
  sound: boolean;
  notify: boolean;
  countdownMin: number;
  dailyGoal: number;
}

export interface FocusEvent { id: string; kind: 'focus-done' | 'break-done' | 'slept'; at: number }

export interface FocusState {
  v: 1;
  sessionId: string | null;
  mode: FocusMode;
  phase: FocusPhase;
  status: FocusStatus;
  durationMs: number;
  accumulatedMs: number;
  segmentStart: number | null;
  cycle: number;
  settings: FocusSettings;
  taskId: string | null;
  blockId?: string | null;
  label: string | null;
  subject: string | null;
  lastSeenAt: number;
  updatedAt: number;
  lastEvent: FocusEvent | null;
}

export const PRESETS: { id: string; label: string; focus: number; short: number; long: number; cycles: number }[] = [
  { id: '25', label: '25 / 5', focus: 25, short: 5, long: 15, cycles: 4 },
  { id: '50', label: '50 / 10', focus: 50, short: 10, long: 20, cycles: 3 },
  { id: '90', label: '90 / 20', focus: 90, short: 20, long: 30, cycles: 2 },
];

const DEFAULT_SETTINGS: FocusSettings = {
  focusMin: 25, shortMin: 5, longMin: 15, cyclesBeforeLong: 4, autoBreaks: true, autoFocus: false, sound: true, notify: false, countdownMin: 30, dailyGoal: 4,
};

const initial = (): FocusState => ({
  v: 1, sessionId: null, mode: 'POMODORO', phase: 'focus', status: 'idle', durationMs: DEFAULT_SETTINGS.focusMin * 60_000,
  accumulatedMs: 0, segmentStart: null, cycle: 0, settings: { ...DEFAULT_SETTINGS }, taskId: null, label: null, subject: null,
  lastSeenAt: Date.now(), updatedAt: 0, lastEvent: null,
});

/** A gap this long without any tab of the account running the timer = the device slept or the browser was closed. */
const SLEEP_GAP_MS = 10 * 60_000;

export const elapsedMs = (s: FocusState, now = Date.now()) => s.accumulatedMs + (s.status === 'running' && s.segmentStart ? Math.max(0, now - s.segmentStart) : 0);
export const remainingMs = (s: FocusState, now = Date.now()) => (s.mode === 'STOPWATCH' ? 0 : Math.max(0, s.durationMs - elapsedMs(s, now)));
export const phaseLabel = (s: FocusState) =>
  s.mode === 'STOPWATCH' ? 'Bấm giờ' : s.mode === 'COUNTDOWN' ? 'Đếm ngược' : s.phase === 'focus' ? 'Phiên tập trung' : s.phase === 'short' ? 'Nghỉ ngắn' : 'Nghỉ dài';
export function clockText(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

type Reporter = (s: FocusState, status: 'RUNNING' | 'COMPLETED' | 'INTERRUPTED', focusedMs: number) => void;
type Listener = () => void;

const rid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export class FocusEngine {
  private state: FocusState;
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBeat = 0;
  private reporter: Reporter | null = null;
  private eventHandlers = new Set<(e: FocusEvent, s: FocusState) => void>();
  readonly key: string;

  constructor(readonly account: string) {
    this.key = `ec_focus:v1:${account ? `u${account}` : 'guest'}`;
    this.state = this.read();
    if (typeof window === 'undefined') return;
    try { this.channel = new BroadcastChannel(`${this.key}:bc`); this.channel.onmessage = () => this.reload(); } catch { /* old browser: storage events only */ }
    window.addEventListener('storage', this.onStorage);
    document.addEventListener('visibilitychange', this.tick);
    this.timer = setInterval(this.tick, 500);
    this.tick();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.channel?.close();
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.onStorage);
      document.removeEventListener('visibilitychange', this.tick);
    }
    this.listeners.clear();
  }

  setReporter(r: Reporter | null) { this.reporter = r; }
  onEvent(h: (e: FocusEvent, s: FocusState) => void) { this.eventHandlers.add(h); return () => { this.eventHandlers.delete(h); }; }
  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  snapshot = () => this.state;

  private onStorage = (e: StorageEvent) => { if (e.key === this.key) this.reload(); };

  private read(): FocusState {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return initial();
      const parsed = JSON.parse(raw) as FocusState;
      if (parsed?.v !== 1) return initial();
      return { ...initial(), ...parsed, settings: { ...DEFAULT_SETTINGS, ...parsed.settings } };
    } catch {
      return initial();
    }
  }

  private reload() {
    const next = this.read();
    if (next.updatedAt === this.state.updatedAt) return;
    this.state = next;
    this.emit();
  }

  private emit() { this.listeners.forEach((l) => l()); }

  private write(next: FocusState, broadcast = true) {
    this.state = { ...next, updatedAt: Date.now() };
    try { localStorage.setItem(this.key, JSON.stringify(this.state)); } catch { /* storage denied: this tab still works */ }
    if (broadcast) this.channel?.postMessage(1);
    this.emit();
  }

  private phaseMs(phase: FocusPhase, s = this.state.settings) {
    return (phase === 'focus' ? s.focusMin : phase === 'short' ? s.shortMin : s.longMin) * 60_000;
  }

  private report(status: 'RUNNING' | 'COMPLETED' | 'INTERRUPTED', s = this.state, at = Date.now()) {
    if (!s.sessionId || (s.mode === 'POMODORO' && s.phase !== 'focus')) return;
    this.reporter?.(s, status, Math.min(elapsedMs(s, at), s.mode === 'STOPWATCH' ? 12 * 3_600_000 : s.durationMs));
  }

  start(opts: { mode?: FocusMode; taskId?: string | null; blockId?: string | null; label?: string | null; subject?: string | null; minutes?: number } = {}) {
    const s = this.state;
    if (s.status !== 'idle') this.stop();
    const mode = opts.mode ?? s.mode;
    const durationMs = mode === 'STOPWATCH' ? 0 : mode === 'COUNTDOWN' ? (opts.minutes ?? s.settings.countdownMin) * 60_000 : this.phaseMs('focus');
    const next: FocusState = {
      ...this.state, sessionId: rid(), mode, phase: 'focus', status: 'running', durationMs, accumulatedMs: 0, segmentStart: Date.now(),
      taskId: opts.taskId === undefined ? s.taskId : opts.taskId, label: opts.label === undefined ? s.label : opts.label,
      subject: opts.subject === undefined ? s.subject : opts.subject, lastSeenAt: Date.now(),
      blockId: opts.blockId ?? null,
    };
    this.write(next);
    this.report('RUNNING');
  }

  /** The main button: resumes, starts a waiting break, or starts a new focus phase. */
  begin(opts: Parameters<FocusEngine['start']>[0] = {}) {
    const s = this.state;
    if (s.status === 'paused') return this.resume();
    if (s.status === 'running') return;
    if (s.mode === 'POMODORO' && s.phase !== 'focus') {
      this.write({ ...s, status: 'running', accumulatedMs: 0, segmentStart: Date.now(), lastSeenAt: Date.now() });
      return;
    }
    this.start(opts);
  }

  pause() {
    const s = this.state;
    if (s.status !== 'running') return;
    const now = Date.now();
    this.write({ ...s, status: 'paused', accumulatedMs: elapsedMs(s, now), segmentStart: null });
    this.report('RUNNING');
  }

  resume() {
    const s = this.state;
    if (s.status !== 'paused') return;
    this.write({ ...s, status: 'running', segmentStart: Date.now(), lastSeenAt: Date.now() });
  }

  /** Ends the current phase early: a focus phase is recorded as interrupted; the cycle does not advance. */
  stop() {
    const s = this.state;
    if (s.status === 'idle') return;
    this.report(s.mode === 'STOPWATCH' ? 'COMPLETED' : 'INTERRUPTED');
    this.write({ ...s, status: 'idle', accumulatedMs: 0, segmentStart: null, sessionId: null, phase: 'focus', durationMs: this.phaseMs('focus') });
  }

  /** Resets the cycle count too. */
  reset() {
    this.stop();
    this.write({ ...this.state, cycle: 0 });
  }

  /** Skips a break (or a focus phase, recorded as interrupted) and moves to the next phase. */
  skip() {
    const s = this.state;
    if (s.mode !== 'POMODORO') return this.stop();
    if (s.phase === 'focus' && s.status !== 'idle') this.report('INTERRUPTED');
    this.advance(s.phase === 'focus' ? false : true, false);
  }

  setTask(taskId: string | null, label: string | null) { this.write({ ...this.state, taskId, label }); }
  setSubject(subject: string | null) { this.write({ ...this.state, subject }); }

  setSettings(patch: Partial<FocusSettings>) {
    const settings = { ...this.state.settings, ...patch };
    const s = this.state;
    const durationMs = s.status === 'idle' && s.mode === 'POMODORO' ? (s.phase === 'focus' ? settings.focusMin : s.phase === 'short' ? settings.shortMin : settings.longMin) * 60_000 : s.durationMs;
    this.write({ ...s, settings, durationMs });
  }

  setMode(mode: FocusMode) {
    if (this.state.status !== 'idle') return;
    const durationMs = mode === 'STOPWATCH' ? 0 : mode === 'COUNTDOWN' ? this.state.settings.countdownMin * 60_000 : this.phaseMs('focus');
    this.write({ ...this.state, mode, phase: 'focus', durationMs });
  }

  /** Moves to the next phase. `completedFocus`: the focus phase just reached its end. */
  private advance(fromBreak: boolean, completedFocus: boolean) {
    const s = this.state;
    const st = s.settings;
    let cycle = s.cycle;
    let phase: FocusPhase;
    if (!fromBreak) {
      if (completedFocus) cycle += 1;
      phase = cycle > 0 && cycle % st.cyclesBeforeLong === 0 && completedFocus ? 'long' : 'short';
    } else {
      phase = 'focus';
      if (s.phase === 'long') cycle = 0;
    }
    const auto = phase === 'focus' ? st.autoFocus : st.autoBreaks;
    const now = Date.now();
    this.write({
      ...s, phase, cycle, durationMs: this.phaseMs(phase), accumulatedMs: 0, segmentStart: auto ? now : null,
      status: auto ? 'running' : 'idle', sessionId: phase === 'focus' && auto ? rid() : phase === 'focus' ? null : s.sessionId, lastSeenAt: now,
    });
    if (phase === 'focus' && auto) this.report('RUNNING');
  }

  private fire(kind: FocusEvent['kind']) {
    const e: FocusEvent = { id: rid(), kind, at: Date.now() };
    this.write({ ...this.state, lastEvent: e });
    this.eventHandlers.forEach((h) => h(e, this.state));
  }

  /** Called twice a second by every tab: notices a finished phase, a slept device, and sends the minute heartbeat. */
  tick = () => {
    const s = this.state;
    const now = Date.now();
    if (s.status !== 'running') return;
    if (now - s.lastSeenAt > SLEEP_GAP_MS) {
      // Nobody ran the timer for a long while (device asleep, browser closed): stop counting where it was last seen.
      const at = s.lastSeenAt;
      const done = elapsedMs(s, at);
      const finished = s.mode !== 'STOPWATCH' && done >= s.durationMs;
      if (!finished) {
        this.write({ ...s, status: 'paused', accumulatedMs: done, segmentStart: null, lastSeenAt: now });
        this.report('RUNNING', { ...s, status: 'paused', accumulatedMs: done, segmentStart: null }, at);
        this.fire('slept');
        return;
      }
    }
    if (now - s.lastSeenAt > 15_000) this.write({ ...s, lastSeenAt: now }, false);
    if (s.mode !== 'STOPWATCH' && remainingMs(s, now) <= 0) {
      // Re-read the shared state first: another tab may already have finished this phase.
      const latest = this.read();
      if (latest.sessionId !== s.sessionId || latest.phase !== s.phase || latest.status !== 'running' || latest.segmentStart !== s.segmentStart) {
        this.state = latest;
        this.emit();
        return;
      }
      const ended = { ...s, accumulatedMs: s.durationMs, segmentStart: null };
      if (s.mode === 'COUNTDOWN') {
        this.report('COMPLETED', ended);
        this.write({ ...ended, status: 'idle', sessionId: null, accumulatedMs: 0 });
        this.fire('focus-done');
        return;
      }
      if (s.phase === 'focus') {
        this.report('COMPLETED', ended);
        this.state = ended;
        this.advance(false, true);
        this.fire('focus-done');
      } else {
        this.advance(true, false);
        this.fire('break-done');
      }
      return;
    }
    if (s.phase === 'focus' && now - this.lastBeat > 60_000 && s.mode !== undefined) {
      this.lastBeat = now;
      this.report('RUNNING');
    }
  };
}

const engines = new Map<string, FocusEngine>();
export function getFocusEngine(account: string): FocusEngine {
  let e = engines.get(account);
  if (!e) { e = new FocusEngine(account); engines.set(account, e); }
  return e;
}
export function disposeFocusEngines() { engines.forEach((e) => e.dispose()); engines.clear(); }

/** A short two-note chime made in the browser (no file, no request). */
export function chime(kind: 'focus-done' | 'break-done' | 'slept') {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const notes = kind === 'focus-done' ? [660, 880, 1320] : [880, 660];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 1);
    });
    setTimeout(() => void ctx.close(), 1800);
  } catch { /* audio unavailable */ }
}
