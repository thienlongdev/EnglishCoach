// "Nói theo chủ đề" — pure timing model. Time is always derived from a monotonic timestamp (performance.now()),
// never from counting ticks, so throttled timers in a hidden tab or a slow device cannot make the clock drift.

/** Duration presets offered by each practice style (seconds). */
export const PRESETS = Object.freeze({
  quickSpeak: [30, 60, 120],
  deepPrep: [0, 30, 60, 180, 300],
  deepSpeak: [60, 120, 180, 300],
  part1Answer: [20, 30, 45],
  part3Answer: [45, 60, 90],
  readyMs: 3000,
  // IELTS Part 2 format: one minute to prepare, then speak for one to two minutes
  part2PrepMs: 60000,
  part2SpeakMs: 120000,
  part2MinMs: 60000,
});

export const DEFAULT_SETTINGS = Object.freeze({
  quickSeconds: 60,
  readyCountdown: true,
  deepPrepSeconds: 60,
  deepSpeakSeconds: 120,
  part1Seconds: 30,
  part3Seconds: 60,
});

/** A stopwatch that counts down from durationMs; paused time does not count. */
export function startClock(durationMs, now) {
  return { durationMs, startedAt: now, pausedAt: null, pausedTotal: 0 };
}

export function elapsedMs(clock, now) {
  const end = clock.pausedAt ?? now;
  return Math.min(clock.durationMs, Math.max(0, end - clock.startedAt - clock.pausedTotal));
}

export function remainingMs(clock, now) {
  return Math.max(0, clock.durationMs - elapsedMs(clock, now));
}

export function isDone(clock, now) {
  return remainingMs(clock, now) <= 0;
}

export function pauseClock(clock, now) {
  return clock.pausedAt == null ? { ...clock, pausedAt: now } : clock;
}

export function resumeClock(clock, now) {
  return clock.pausedAt == null ? clock : { ...clock, pausedTotal: clock.pausedTotal + (now - clock.pausedAt), pausedAt: null };
}

/** Countdown label: whole seconds rounded UP, so "0:01" is shown until the very end and "0:00" only when done. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Elapsed label: whole seconds rounded DOWN (never claims time that has not passed). */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The ordered steps of one round. kind: 'ready' (short get-set countdown), 'prep' (silent thinking time) or 'speak'.
 * question: index of the question shown during that step (IELTS Part 1 / 3 step through their linked questions).
 */
export function buildPlan(style, settings, questionCount) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  switch (style) {
    case 'QUICK':
      return [
        ...(s.readyCountdown ? [{ kind: 'ready', ms: PRESETS.readyMs, question: 0 }] : []),
        { kind: 'speak', ms: s.quickSeconds * 1000, question: 0 },
      ];
    case 'DEEP':
      return [
        ...(s.deepPrepSeconds > 0 ? [{ kind: 'prep', ms: s.deepPrepSeconds * 1000, question: 0 }] : []),
        { kind: 'speak', ms: s.deepSpeakSeconds * 1000, question: 0 },
      ];
    case 'IELTS2':
      return [
        { kind: 'prep', ms: PRESETS.part2PrepMs, question: 0 },
        { kind: 'speak', ms: PRESETS.part2SpeakMs, question: 0, minMs: PRESETS.part2MinMs },
      ];
    case 'IELTS1':
    case 'IELTS3': {
      const each = (style === 'IELTS1' ? s.part1Seconds : s.part3Seconds) * 1000;
      return Array.from({ length: Math.max(1, questionCount) }, (_, i) => ({ kind: 'speak', ms: each, question: i }));
    }
    default:
      throw new Error(`unknown style ${style}`);
  }
}

/**
 * The speaking target recorded with the round. IELTS Part 2 asks for one to two minutes, so reaching one minute
 * meets the format; every other style targets its full speaking time.
 */
export function targetSeconds(style, plan) {
  if (style === 'IELTS2') return PRESETS.part2MinMs / 1000;
  return Math.round(plan.filter(step => step.kind === 'speak').reduce((sum, step) => sum + step.ms, 0) / 1000);
}

/** Whether a learner may pause: free practice yes, IELTS-format rounds no (only an interruption pauses them). */
export function canPause(style) {
  return style === 'QUICK' || style === 'DEEP';
}
