import { onAuthWorkCancelled } from '@/lib/auth-lifecycle';

export const ECHO_TELEMETRY_METRICS = [
  'wakeToUiMs',
  'wakeToGreetingMs',
  'eouToSttMs',
  'sttToFirstTokenMs',
  'tokenToFirstAudioMs',
  'eouToFirstAudioMs',
  'bargeInStopMs',
  'actionExecMs',
] as const;

export type EchoTelemetryMetric = (typeof ECHO_TELEMETRY_METRICS)[number];

export interface MetricPercentileSummary {
  count: number;
  last: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface EchoSoakCounters {
  micFramesProcessed: number;
  nlmsActiveFrames: number;
  vadFramesProcessed: number;
  vadLastMs: number;
  owwStepsProcessed: number;
  owwLastMs: number;
  wakeDetections: number;
  singleBreathHandoffs: number;
  softDucks: number;
  falseInterruptResumes: number;
  hardBargeIns: number;
  echoLeaksFiltered: number;
  wsConnects: number;
  wsReconnects: number;
  httpFallbackTurns: number;
  staleAudioFramesDropped: number;
}

export interface EchoTelemetrySnapshot {
  capturedAtMs: number;
  metrics: Record<EchoTelemetryMetric, MetricPercentileSummary>;
  counters: EchoSoakCounters;
}

const DEFAULT_RING_CAPACITY = 256;

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

class FloatRingSeries {
  private readonly buf: Float64Array;
  private readonly sortScratch: Float64Array;
  private writeIdx = 0;
  private filled = 0;
  private totalCount = 0;
  private lastVal = 0;

  constructor(capacity = DEFAULT_RING_CAPACITY) {
    this.buf = new Float64Array(capacity);
    this.sortScratch = new Float64Array(capacity);
  }

  push(valueMs: number): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;
    this.lastVal = valueMs;
    this.buf[this.writeIdx] = valueMs;
    this.writeIdx = (this.writeIdx + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled += 1;
    this.totalCount += 1;
  }

  reset(): void {
    this.writeIdx = 0;
    this.filled = 0;
    this.totalCount = 0;
    this.lastVal = 0;
    this.buf.fill(0);
  }

  summarize(): MetricPercentileSummary {
    const n = this.filled;
    if (n === 0) {
      return { count: 0, last: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = this.buf[i];
      this.sortScratch[i] = v;
      sum += v;
    }
    const sub = this.sortScratch.subarray(0, n);
    sub.sort();

    const pick = (q: number): number => {
      if (n === 1) return sub[0];
      const rank = q * (n - 1);
      const lo = Math.floor(rank);
      const hi = Math.min(n - 1, lo + 1);
      const frac = rank - lo;
      return sub[lo] + (sub[hi] - sub[lo]) * frac;
    };

    const round2 = (v: number) => Math.round(v * 100) / 100;
    return {
      count: this.totalCount,
      last: round2(this.lastVal),
      min: round2(sub[0]),
      max: round2(sub[n - 1]),
      mean: round2(sum / n),
      p50: round2(pick(0.5)),
      p95: round2(pick(0.95)),
      p99: round2(pick(0.99)),
    };
  }
}

function emptyCounters(): EchoSoakCounters {
  return {
    micFramesProcessed: 0,
    nlmsActiveFrames: 0,
    vadFramesProcessed: 0,
    vadLastMs: 0,
    owwStepsProcessed: 0,
    owwLastMs: 0,
    wakeDetections: 0,
    singleBreathHandoffs: 0,
    softDucks: 0,
    falseInterruptResumes: 0,
    hardBargeIns: 0,
    echoLeaksFiltered: 0,
    wsConnects: 0,
    wsReconnects: 0,
    httpFallbackTurns: 0,
    staleAudioFramesDropped: 0,
  };
}

export class EchoTelemetryTracker {
  private readonly series: Record<EchoTelemetryMetric, FloatRingSeries>;
  private counters: EchoSoakCounters = emptyCounters();

  private wakeMarkMs: number | null = null;
  private eouMarkMs: number | null = null;
  private sttMarkMs: number | null = null;
  private firstTokenMarkMs: number | null = null;
  private firstAudioRecorded = false;
  private bargeInMarkMs: number | null = null;
  private readonly actionMarks = new Map<string, number>();

  constructor(ringCapacity = DEFAULT_RING_CAPACITY) {
    this.series = {
      wakeToUiMs: new FloatRingSeries(ringCapacity),
      wakeToGreetingMs: new FloatRingSeries(ringCapacity),
      eouToSttMs: new FloatRingSeries(ringCapacity),
      sttToFirstTokenMs: new FloatRingSeries(ringCapacity),
      tokenToFirstAudioMs: new FloatRingSeries(ringCapacity),
      eouToFirstAudioMs: new FloatRingSeries(ringCapacity),
      bargeInStopMs: new FloatRingSeries(ringCapacity),
      actionExecMs: new FloatRingSeries(ringCapacity),
    };
  }

  record(metric: EchoTelemetryMetric, durationMs: number): void {
    this.series[metric].push(durationMs);
  }

  incrementCounter<K extends keyof EchoSoakCounters>(key: K, delta = 1): void {
    this.counters[key] += delta;
  }

  setGauge<K extends 'vadLastMs' | 'owwLastMs'>(key: K, valueMs: number): void {
    this.counters[key] = Math.round(valueMs * 1000) / 1000;
  }

  markWake(atMs = nowMs()): void {
    this.wakeMarkMs = atMs;
    this.counters.wakeDetections += 1;
  }

  markWakeUiReady(atMs = nowMs()): number | null {
    if (this.wakeMarkMs === null) return null;
    const dt = Math.max(0, atMs - this.wakeMarkMs);
    this.record('wakeToUiMs', dt);
    return dt;
  }

  markWakeGreetingStart(atMs = nowMs()): number | null {
    if (this.wakeMarkMs === null) return null;
    const dt = Math.max(0, atMs - this.wakeMarkMs);
    this.record('wakeToGreetingMs', dt);
    return dt;
  }

  markEou(atMs = nowMs()): void {
    this.eouMarkMs = atMs;
    this.sttMarkMs = null;
    this.firstTokenMarkMs = null;
    this.firstAudioRecorded = false;
  }

  markSttFinal(atMs = nowMs()): number | null {
    this.sttMarkMs = atMs;
    if (this.eouMarkMs === null) return null;
    const dt = Math.max(0, atMs - this.eouMarkMs);
    this.record('eouToSttMs', dt);
    return dt;
  }

  markFirstToken(atMs = nowMs()): number | null {
    if (this.firstTokenMarkMs !== null) return null;
    this.firstTokenMarkMs = atMs;
    const anchor = this.sttMarkMs ?? this.eouMarkMs;
    if (anchor === null) return null;
    const dt = Math.max(0, atMs - anchor);
    this.record('sttToFirstTokenMs', dt);
    return dt;
  }

  markFirstAudio(atMs = nowMs()): { tokenToAudioMs: number | null; eouToAudioMs: number | null } {
    if (this.firstAudioRecorded) {
      return { tokenToAudioMs: null, eouToAudioMs: null };
    }
    this.firstAudioRecorded = true;
    let tokenToAudioMs: number | null = null;
    let eouToAudioMs: number | null = null;
    if (this.firstTokenMarkMs !== null) {
      tokenToAudioMs = Math.max(0, atMs - this.firstTokenMarkMs);
      this.record('tokenToFirstAudioMs', tokenToAudioMs);
    }
    if (this.eouMarkMs !== null) {
      eouToAudioMs = Math.max(0, atMs - this.eouMarkMs);
      this.record('eouToFirstAudioMs', eouToAudioMs);
    }
    return { tokenToAudioMs, eouToAudioMs };
  }

  markBargeInStart(atMs = nowMs()): void {
    this.bargeInMarkMs = atMs;
  }

  markBargeInStopped(atMs = nowMs()): number | null {
    this.counters.hardBargeIns += 1;
    if (this.bargeInMarkMs === null) return null;
    const dt = Math.max(0, atMs - this.bargeInMarkMs);
    this.bargeInMarkMs = null;
    this.record('bargeInStopMs', dt);
    return dt;
  }

  markActionStart(actionId: string, atMs = nowMs()): void {
    if (this.actionMarks.size > 64) {
      const oldest = this.actionMarks.keys().next().value;
      if (oldest !== undefined) this.actionMarks.delete(oldest);
    }
    this.actionMarks.set(actionId, atMs);
  }

  markActionDone(actionId: string, atMs = nowMs()): number | null {
    const started = this.actionMarks.get(actionId);
    if (started === undefined) return null;
    this.actionMarks.delete(actionId);
    const dt = Math.max(0, atMs - started);
    this.record('actionExecMs', dt);
    return dt;
  }

  snapshot(): EchoTelemetrySnapshot {
    return {
      capturedAtMs: nowMs(),
      metrics: {
        wakeToUiMs: this.series.wakeToUiMs.summarize(),
        wakeToGreetingMs: this.series.wakeToGreetingMs.summarize(),
        eouToSttMs: this.series.eouToSttMs.summarize(),
        sttToFirstTokenMs: this.series.sttToFirstTokenMs.summarize(),
        tokenToFirstAudioMs: this.series.tokenToFirstAudioMs.summarize(),
        eouToFirstAudioMs: this.series.eouToFirstAudioMs.summarize(),
        bargeInStopMs: this.series.bargeInStopMs.summarize(),
        actionExecMs: this.series.actionExecMs.summarize(),
      },
      counters: { ...this.counters },
    };
  }

  reset(): void {
    for (const metric of ECHO_TELEMETRY_METRICS) {
      this.series[metric].reset();
    }
    this.counters = emptyCounters();
    this.wakeMarkMs = null;
    this.eouMarkMs = null;
    this.sttMarkMs = null;
    this.firstTokenMarkMs = null;
    this.firstAudioRecorded = false;
    this.bargeInMarkMs = null;
    this.actionMarks.clear();
  }
}

export const echoTelemetry = new EchoTelemetryTracker();

declare global {
  interface Window {
    __echoJarvisTelemetry?: {
      snapshot: () => EchoTelemetrySnapshot;
      reset: () => void;
      tracker: EchoTelemetryTracker;
    };
  }
}

export function attachDevEchoTelemetry(targetWindow?: Window): void {
  const win = targetWindow ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win) return;
  const isDevOrTest =
    typeof process === 'undefined' ||
    process.env.NODE_ENV !== 'production' ||
    Boolean((win as unknown as { __ENABLE_ECHO_TELEMETRY__?: boolean }).__ENABLE_ECHO_TELEMETRY__);
  if (!isDevOrTest) return;
  win.__echoJarvisTelemetry = {
    snapshot: () => echoTelemetry.snapshot(),
    reset: () => echoTelemetry.reset(),
    tracker: echoTelemetry,
  };
}

if (typeof window !== 'undefined') {
  attachDevEchoTelemetry(window);
}
onAuthWorkCancelled(() => {
  echoTelemetry.reset();
});
