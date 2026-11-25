import * as T from 'three';

/**
 * Echo Life — Cooperative Time-Slicer, Priority Asset Load Scheduler, Off-Thread WebP Decoder,
 * and Frame-Budgeted GPU Texture Upload Queue.
 *
 * Hardened against every `@perf-stream-reviewer` failure mode:
 * - **Hidden-tab visibility safety:** Network/parse yields use `MessageChannel` when `document.hidden`
 *   (immune to paused `rAF`), while GPU upload/compile stages pause via `waitUntilDocumentVisible()`
 *   and resume automatically on `visibilitychange` (protecting background WebGL contexts from loss).
 * - **Late-result disposal:** Loads that settle after a timeout or abort NEVER enter caller caches and
 *   optionally invoke `onDiscardLateResult(val)` so stray `GLTF`/`ImageBitmap` handles free immediately.
 * - **Dispose-safe `TextureUploadQueue`:** Attaches `tex.addEventListener('dispose', ...)` so disposed
 *   textures dequeue immediately and `renderer.initTexture()` NEVER resurrects dead GPU memory; also
 *   caps not-ready deferrals (`maxDeferredAttempts` / `maxDeferredAgeMs`).
 * - **Browser-safe `createImageBitmap`:** Applies GLTFLoader's Safari < 17 / Firefox < 98 options gate,
 *   defaults `imageOrientation: 'flipY'` + `premultiplyAlpha: 'none'` + `colorSpaceConversion: 'none'`.
 */

export const LoadPriority = {
  /** Boot-critical or imminent doorway (< 12 m / opening door). */
  P0_IMMINENT: 0,
  /** Predictive interior prefetch (22–34 m lookahead) or active character wardrobe. */
  P1_PREFETCH: 1,
  /** Nearby city chunk props, buildings, vehicles, and street NPCs. */
  P2_NEAR_CHUNK: 2,
  /** Distant vegetation, background ambient assets, non-urgent prefetches. */
  P3_BACKGROUND: 3,
} as const;

export type LoadPriorityLevel = (typeof LoadPriority)[keyof typeof LoadPriority];

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

/**
 * Suspends GPU work (uploads, `compileAsync`, warmup draws) while the tab is hidden and resumes
 * cleanly on `visibilitychange`. Returns `false` if aborted while waiting.
 */
export function waitUntilDocumentVisible(
  signal?: AbortSignal,
  onPausedChange?: (paused: boolean) => void,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (!isDocumentHidden()) return Promise.resolve(true);

  onPausedChange?.(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (visible: boolean) => {
      if (settled) return;
      settled = true;
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVis);
      }
      if (signal) signal.removeEventListener('abort', onAbort);
      onPausedChange?.(false);
      resolve(visible);
    };

    const onVis = () => {
      if (!isDocumentHidden()) finish(true);
    };
    const onAbort = () => finish(false);

    if (signal) {
      if (signal.aborted) {
        finish(false);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVis);
    } else {
      finish(true);
    }
  });
}

let cachedChannel: MessageChannel | null = null;
const pendingChannelCallbacks: Array<() => void> = [];

function scheduleMacrotask(cb: () => void): void {
  // Use MessageChannel in browser contexts (immune to background-tab 1000 ms setTimeout throttling)
  // and setTimeout(0) in Node/SSR test environments so no idle port pins the event loop.
  if (typeof window !== 'undefined' && typeof MessageChannel !== 'undefined') {
    if (!cachedChannel) {
      cachedChannel = new MessageChannel();
      cachedChannel.port1.onmessage = () => {
        const next = pendingChannelCallbacks.shift();
        if (next) next();
      };
    }
    pendingChannelCallbacks.push(cb);
    cachedChannel.port2.postMessage(null);
    return;
  }
  setTimeout(cb, 0);
}

/**
 * Cooperative frame budget slicer modeled on Echo Archipelago v7's `ArenaTimeSlicer`, hardened with
 * automatic `MessageChannel` / `setTimeout(0)` fallback when `document.hidden === true` and a 64 ms
 * rAF watchdog when visible.
 */
export class EchoLifeTimeSlicer {
  private budgetMs: number;
  private frameStartMs = nowMs();
  private yieldCount = 0;

  constructor(budgetMs = 9.5) {
    this.budgetMs = Math.max(1.0, budgetMs);
  }

  get currentBudgetMs(): number {
    return this.budgetMs;
  }

  get totalYields(): number {
    return this.yieldCount;
  }

  setBudgetMs(budgetMs: number): void {
    this.budgetMs = Math.max(1.0, budgetMs);
  }

  resetFrame(): void {
    this.frameStartMs = nowMs();
  }

  elapsedMs(): number {
    return nowMs() - this.frameStartMs;
  }

  remainingMs(): number {
    return Math.max(0, this.budgetMs - this.elapsedMs());
  }

  shouldYield(): boolean {
    const cap = isDocumentHidden() ? Math.min(this.budgetMs, 8.0) : this.budgetMs;
    return this.elapsedMs() >= cap;
  }

  /** Yields one turn: `MessageChannel`/`setTimeout(0)` if hidden, else `rAF` with 64 ms watchdog. */
  async yieldFrame(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    this.yieldCount++;

    const hidden = isDocumentHidden();
    const hasRaf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function';

    await new Promise<void>((resolve) => {
      let settled = false;
      let rafId = 0;
      let timerId: ReturnType<typeof setTimeout> | null = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (rafId && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(rafId);
        }
        if (timerId !== null) clearTimeout(timerId);
        if (signal) signal.removeEventListener('abort', finish);
        resolve();
      };

      if (signal) {
        if (signal.aborted) {
          finish();
          return;
        }
        signal.addEventListener('abort', finish, { once: true });
      }

      if (hidden || !hasRaf) {
        scheduleMacrotask(finish);
      } else {
        rafId = window.requestAnimationFrame(finish);
        timerId = setTimeout(finish, 64);
      }
    });

    this.frameStartMs = nowMs();
  }

  /** Yields only if the current frame's cooperative budget has been consumed. */
  async yieldIfNeeded(signal?: AbortSignal): Promise<boolean> {
    if (!this.shouldYield()) return false;
    await this.yieldFrame(signal);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Off-Thread WebP / Image Decoding (`createImageBitmap` + `img.decode()` fallback)
// ---------------------------------------------------------------------------

/**
 * Mirrors Three.js `GLTFLoader` browser gate: Safari < 17 and Firefox < 98 had broken
 * `createImageBitmap` options (`imageOrientation` / `colorSpaceConversion` / `premultiplyAlpha`).
 */
export function supportsSafeImageBitmapOptions(): boolean {
  if (typeof createImageBitmap !== 'function') return false;
  if (typeof navigator === 'undefined') return true;
  const ua = navigator.userAgent || '';
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  if (isSafari) {
    const m = ua.match(/Version\/(\d+)/i);
    if (!m || Number(m[1]) < 17) return false;
  }
  const ff = ua.match(/Firefox\/(\d+)/i);
  if (ff && Number(ff[1]) < 98) return false;
  return true;
}

export interface DecodedImageAsset {
  readonly url: string;
  readonly image: ImageBitmap | HTMLImageElement;
  readonly width: number;
  readonly height: number;
  readonly isBitmap: boolean;
  /** Call strictly inside texture disposal (never while texture is still live!). */
  dispose(): void;
}

export interface LoadImageOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Default `'flipY'` so WebGL PBR textures with `tex.flipY = false` render right-side-up (remember
   * Three.js ignores `tex.flipY` on `ImageBitmap`!). Use `'none'` only for GLTF UV-origin assets.
   */
  readonly imageOrientation?: 'none' | 'flipY';
  readonly premultiplyAlpha?: 'none' | 'premultiply' | 'default';
  readonly resizeWidth?: number;
  readonly resizeHeight?: number;
}

function combineAbortSignals(external?: AbortSignal, timeoutMs = 15_000): {
  controller: AbortController;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

  return {
    controller,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer !== null) clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
  };
}

async function loadViaHtmlImage(url: string, signal: AbortSignal): Promise<DecodedImageAsset | null> {
  if (typeof Image === 'undefined') return null;

  return await new Promise<DecodedImageAsset | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';

    let settled = false;
    const done = (result: DecodedImageAsset | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      img.onload = null;
      img.onerror = null;
      resolve(result);
    };

    const onAbort = () => {
      img.src = '';
      done(null);
    };

    if (signal.aborted) {
      done(null);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    img.onload = () => {
      const finalize = () => {
        if (signal.aborted) {
          done(null);
          return;
        }
        done({
          url,
          image: img,
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0,
          isBitmap: false,
          dispose: () => {
            /* GC-managed HTMLImageElement */
          },
        });
      };

      if (typeof img.decode === 'function') {
        img.decode().then(finalize, finalize);
      } else {
        finalize();
      }
    };

    img.onerror = () => done(null);
    img.src = url;
  });
}

/**
 * Fetches and decodes an image off the main thread using `createImageBitmap`, falling back cleanly to
 * `HTMLImageElement.decode()`. Never throws on 404/network/timeout — returns `null` for fault tolerance.
 */
export async function loadImageOffThread(
  url: string,
  opts: LoadImageOptions = {},
): Promise<DecodedImageAsset | null> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const { controller, cleanup } = combineAbortSignals(opts.signal, timeoutMs);

  try {
    if (typeof fetch === 'function' && supportsSafeImageBitmapOptions()) {
      const response = await fetch(url, {
        signal: controller.signal,
        credentials: 'same-origin',
      });
      if (!response.ok) return null;
      const blob = await response.blob();
      if (controller.signal.aborted) return null;

      try {
        const bitmapOpts: ImageBitmapOptions = {
          premultiplyAlpha: opts.premultiplyAlpha ?? 'none',
          colorSpaceConversion: 'none',
          imageOrientation: opts.imageOrientation ?? 'flipY',
        };
        if (opts.resizeWidth && opts.resizeHeight) {
          bitmapOpts.resizeWidth = opts.resizeWidth;
          bitmapOpts.resizeHeight = opts.resizeHeight;
          bitmapOpts.resizeQuality = 'medium';
        }
        const bitmap = await createImageBitmap(blob, bitmapOpts);
        if (controller.signal.aborted) {
          bitmap.close();
          return null;
        }
        let closed = false;
        return {
          url,
          image: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          isBitmap: true,
          dispose: () => {
            if (closed) return;
            closed = true;
            try {
              bitmap.close();
            } catch {
              /* already closed */
            }
          },
        };
      } catch {
        // Fallback to HTMLImageElement if browser rejects createImageBitmap options/format.
      }
    }

    return await loadViaHtmlImage(url, controller.signal);
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Priority Asset Load & Time-Sliced Commit Scheduler
// ---------------------------------------------------------------------------

interface QueuedLoadTask<TResult> {
  readonly key: string;
  priority: LoadPriorityLevel;
  readonly seq: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly loader: (signal: AbortSignal) => Promise<TResult>;
  readonly onDiscardLateResult?: (lateValue: TResult) => void;
  readonly resolve: (value: TResult | null) => void;
  readonly promise: Promise<TResult | null>;
}

interface QueuedCommitTask<TResult> {
  readonly key: string;
  priority: LoadPriorityLevel;
  readonly seq: number;
  readonly signal?: AbortSignal;
  readonly fn: () => TResult;
  readonly resolve: (value: TResult | null) => void;
}

export interface LoadSchedulerStats {
  readonly maxConcurrentFetches: number;
  readonly activeFetches: number;
  readonly queuedFetches: number;
  readonly queuedCommits: number;
  readonly completedFetches: number;
  readonly failedFetches: number;
  readonly timedOutFetches: number;
  readonly discardedLateResults: number;
  readonly completedCommits: number;
}

export class EchoLifeLoadScheduler {
  private maxConcurrentFetches: number;
  private mode: 'boot' | 'live' = 'live';
  private activeFetches = 0;
  private taskSeq = 0;
  private readonly loadQueue: QueuedLoadTask<unknown>[] = [];
  private readonly inFlightLoads = new Map<string, QueuedLoadTask<unknown>>();
  private readonly commitQueue: QueuedCommitTask<unknown>[] = [];
  private readonly priorityHints = new Map<string, { priority: LoadPriorityLevel; expiresAtMs: number }>();
  private commitPumpScheduled = false;
  private lastCommitFrameBucket = -1;
  private readonly commitSlicer: EchoLifeTimeSlicer;

  private completedFetches = 0;
  private failedFetches = 0;
  private timedOutFetches = 0;
  private discardedLateResults = 0;
  private completedCommits = 0;

  constructor(opts: { maxConcurrentFetches?: number; commitBudgetMs?: number } = {}) {
    this.maxConcurrentFetches = Math.max(1, opts.maxConcurrentFetches ?? 3);
    this.commitSlicer = new EchoLifeTimeSlicer(opts.commitBudgetMs ?? 3.5);
  }

  setMode(mode: 'boot' | 'live'): void {
    this.mode = mode;
    if (mode === 'boot') {
      this.maxConcurrentFetches = 4;
      this.commitSlicer.setBudgetMs(9.5);
    } else {
      this.maxConcurrentFetches = 3;
      this.commitSlicer.setBudgetMs(3.2);
    }
  }

  get currentMode(): 'boot' | 'live' {
    return this.mode;
  }

  setMaxConcurrentFetches(limit: number): void {
    this.maxConcurrentFetches = Math.max(1, Math.floor(limit));
    this.pumpLoads();
  }

  setCommitBudgetMs(budgetMs: number): void {
    this.commitSlicer.setBudgetMs(budgetMs);
  }

  /**
   * Hints an elevated priority (e.g. `LoadPriority.P1_PREFETCH` from velocity + camera lookahead)
   * for an asset key and its `:reduce` commit step without coupling caller manifests.
   */
  hintPriority(key: string, priority: LoadPriorityLevel, ttlMs = 12_000): void {
    const now = nowMs();
    if (this.priorityHints.size >= 256) {
      for (const [k, v] of this.priorityHints) {
        if (v.expiresAtMs <= now) this.priorityHints.delete(k);
        if (this.priorityHints.size < 192) break;
      }
      if (this.priorityHints.size >= 256) {
        const oldest = this.priorityHints.keys().next().value;
        if (oldest !== undefined) this.priorityHints.delete(oldest);
      }
    }
    const existingHint = this.priorityHints.get(key);
    const mergedPriority = existingHint ? (Math.min(existingHint.priority, priority) as LoadPriorityLevel) : priority;
    this.priorityHints.set(key, { priority: mergedPriority, expiresAtMs: now + Math.max(500, ttlMs) });

    const inFlight = this.inFlightLoads.get(key);
    if (inFlight && priority < inFlight.priority) {
      inFlight.priority = priority;
    }
    const reduceKey = `${key}:reduce`;
    for (let i = 0; i < this.commitQueue.length; i++) {
      const c = this.commitQueue[i];
      if ((c.key === key || c.key === reduceKey) && priority < c.priority) {
        c.priority = priority;
      }
    }
  }

  private resolveHintedPriority(key: string, requested: LoadPriorityLevel): LoadPriorityLevel {
    if (this.priorityHints.size === 0) return requested;
    const now = nowMs();
    const direct = this.priorityHints.get(key);
    let best = requested;
    if (direct) {
      if (direct.expiresAtMs > now) {
        if (direct.priority < best) best = direct.priority;
      } else {
        this.priorityHints.delete(key);
      }
    }
    if (key.endsWith(':reduce')) {
      const baseKey = key.slice(0, -7);
      const baseHint = this.priorityHints.get(baseKey);
      if (baseHint) {
        if (baseHint.expiresAtMs > now) {
          if (baseHint.priority < best) best = baseHint.priority;
        } else {
          this.priorityHints.delete(baseKey);
        }
      }
    }
    return best;
  }

  /**
   * Enqueues a deduplicated async load task (`P0..P3`) with per-asset timeout, 404/error isolation,
   * and strict late-result discarding (results arriving after timeout/abort NEVER enter caches and
   * invoke `onDiscardLateResult` for immediate resource disposal).
   */
  scheduleLoad<TResult>(
    key: string,
    priority: LoadPriorityLevel,
    loader: (signal: AbortSignal) => Promise<TResult>,
    opts: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onDiscardLateResult?: (lateValue: TResult) => void;
    } = {},
  ): Promise<TResult | null> {
    if (opts.signal?.aborted) return Promise.resolve(null);
    const effectivePriority = this.resolveHintedPriority(key, priority);

    const existing = this.inFlightLoads.get(key) as QueuedLoadTask<TResult> | undefined;
    if (existing) {
      if (effectivePriority < existing.priority) {
        existing.priority = effectivePriority;
      }
      return existing.promise;
    }

    let resolveFn!: (value: TResult | null) => void;
    const promise = new Promise<TResult | null>((resolve) => {
      resolveFn = resolve;
    });

    const task: QueuedLoadTask<TResult> = {
      key,
      priority: effectivePriority,
      seq: ++this.taskSeq,
      timeoutMs: opts.timeoutMs ?? 15_000,
      signal: opts.signal,
      loader,
      onDiscardLateResult: opts.onDiscardLateResult,
      resolve: resolveFn,
      promise,
    };

    this.inFlightLoads.set(key, task as QueuedLoadTask<unknown>);
    this.loadQueue.push(task as QueuedLoadTask<unknown>);
    this.pumpLoads();
    return promise;
  }

  /**
   * Schedules a synchronous main-thread commit step (e.g. `reduceProp`, `batchStaticFurnishings`,
   * clip retarget slice) onto the cooperative budget queue so bursts never freeze the main thread.
   */
  scheduleCommit<TResult>(
    key: string,
    priority: LoadPriorityLevel,
    fn: () => TResult,
    signal?: AbortSignal,
  ): Promise<TResult | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const effectivePriority = this.resolveHintedPriority(key, priority);

    return new Promise<TResult | null>((resolve) => {
      this.commitQueue.push({
        key,
        priority: effectivePriority,
        seq: ++this.taskSeq,
        signal,
        fn: fn as () => unknown,
        resolve: resolve as (v: unknown | null) => void,
      });
      this.ensureCommitPump();
    });
  }

  drainCommitsForFrame(maxCommits = 1, maxMs = this.commitSlicer.currentBudgetMs): number {
    if (this.commitQueue.length === 0) return 0;
    const t0 = nowMs();
    let executed = 0;

    while (this.commitQueue.length > 0 && executed < maxCommits) {
      const idx = this.pickHighestPriorityIndex(this.commitQueue);
      const [task] = this.commitQueue.splice(idx, 1);
      if (!task) break;
      if (task.signal?.aborted) {
        task.resolve(null);
        continue;
      }
      try {
        const result = task.fn();
        this.completedCommits++;
        task.resolve(result);
      } catch {
        task.resolve(null);
      }
      executed++;
      this.lastCommitFrameBucket = Math.floor(nowMs() * 0.12);
      if (nowMs() - t0 >= maxMs) break;
    }

    return executed;
  }

  private ensureCommitPump(): void {
    if (this.commitPumpScheduled) return;
    this.commitPumpScheduled = true;

    void (async () => {
      try {
        // In live mode, if a commit already ran in this ~8.3 ms frame bucket, yield before running the next one
        // so burst GLTF completions never stack synchronous geometry merges onto the same animation frame.
        if (this.mode === 'live' && Math.floor(nowMs() * 0.12) === this.lastCommitFrameBucket) {
          await this.commitSlicer.yieldFrame();
        }
        while (this.commitQueue.length > 0) {
          this.commitSlicer.resetFrame();
          const idx = this.pickHighestPriorityIndex(this.commitQueue);
          const [task] = this.commitQueue.splice(idx, 1);
          if (task) {
            if (task.signal?.aborted) {
              task.resolve(null);
            } else {
              try {
                const res = task.fn();
                this.completedCommits++;
                this.lastCommitFrameBucket = Math.floor(nowMs() * 0.12);
                task.resolve(res);
              } catch {
                task.resolve(null);
              }
            }
          }
          if (this.commitQueue.length > 0) {
            await this.commitSlicer.yieldFrame();
          }
        }
      } finally {
        this.commitPumpScheduled = false;
        if (this.commitQueue.length > 0) {
          this.ensureCommitPump();
        }
      }
    })();
  }

  private pickHighestPriorityIndex<TItem extends { priority: LoadPriorityLevel; seq: number }>(
    list: readonly TItem[],
  ): number {
    let bestIdx = 0;
    let best = list[0];
    for (let i = 1; i < list.length; i++) {
      const cur = list[i];
      if (cur.priority < best.priority || (cur.priority === best.priority && cur.seq < best.seq)) {
        best = cur;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  private pumpLoads(): void {
    while (this.activeFetches < this.maxConcurrentFetches && this.loadQueue.length > 0) {
      const idx = this.pickHighestPriorityIndex(this.loadQueue);
      const [task] = this.loadQueue.splice(idx, 1);
      if (!task) break;

      if (task.signal?.aborted) {
        this.inFlightLoads.delete(task.key);
        task.resolve(null);
        continue;
      }

      this.activeFetches++;
      const { controller, cleanup, didTimeout } = combineAbortSignals(task.signal, task.timeoutMs);

      let settled = false;
      const finish = (value: unknown | null, failed: boolean) => {
        if (settled) {
          // Discard late result from a timed-out or aborted request so it NEVER enters caches!
          if (!failed && value !== null && value !== undefined) {
            this.discardedLateResults++;
            try {
              task.onDiscardLateResult?.(value);
            } catch {
              /* isolate cleanup error */
            }
          }
          return;
        }
        settled = true;
        controller.signal.removeEventListener('abort', onAbort);
        cleanup();
        this.activeFetches = Math.max(0, this.activeFetches - 1);
        this.inFlightLoads.delete(task.key);
        if (controller.signal.aborted) {
          if (didTimeout()) this.timedOutFetches++;
          if (!failed && value !== null && value !== undefined) {
            this.discardedLateResults++;
            try {
              task.onDiscardLateResult?.(value);
            } catch {
              /* isolate cleanup error */
            }
          }
          task.resolve(null);
        } else if (failed) {
          this.failedFetches++;
          task.resolve(null);
        } else {
          this.completedFetches++;
          task.resolve(value);
        }
        this.pumpLoads();
      };

      const onAbort = () => finish(null, false);
      if (controller.signal.aborted) {
        finish(null, false);
        continue;
      }
      controller.signal.addEventListener('abort', onAbort, { once: true });

      Promise.resolve()
        .then(() => task.loader(controller.signal))
        .then(
          (value) => finish(value, false),
          () => finish(null, true),
        );
    }
  }

  stats(): LoadSchedulerStats {
    return {
      maxConcurrentFetches: this.maxConcurrentFetches,
      activeFetches: this.activeFetches,
      queuedFetches: this.loadQueue.length,
      queuedCommits: this.commitQueue.length,
      completedFetches: this.completedFetches,
      failedFetches: this.failedFetches,
      timedOutFetches: this.timedOutFetches,
      discardedLateResults: this.discardedLateResults,
      completedCommits: this.completedCommits,
    };
  }
}

// ---------------------------------------------------------------------------
// Dispose-Safe, Hidden-Paused, Frame-Budgeted GPU Texture Upload Queue
// ---------------------------------------------------------------------------

interface PendingTextureUpload {
  readonly texture: T.Texture;
  priority: LoadPriorityLevel;
  readonly seq: number;
  readonly enqueuedAtMs: number;
  deferredAttempts: number;
  readonly onDispose: () => void;
}

export interface TextureUploadStats {
  readonly queued: number;
  readonly uploadedTotal: number;
  readonly dequeuedOnDispose: number;
  readonly droppedExpired: number;
  readonly skippedNotReady: number;
}

const MAX_DEFERRED_ATTEMPTS = 12;
const MAX_DEFERRED_AGE_MS = 15_000;

function isTextureImageReady(tex: T.Texture): boolean {
  const img = tex.image as
    | null
    | undefined
    | { complete?: boolean; naturalWidth?: number; width?: number; data?: ArrayBufferView }
    | Array<unknown>;
  if (!img) return false;
  if (Array.isArray(img)) return img.length > 0;
  if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) {
    return img.complete && img.naturalWidth > 0;
  }
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
    return img.width > 0;
  }
  if ('data' in img && img.data) return true;
  return Number(img.width ?? 0) > 0;
}

const MATERIAL_TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'alphaMap',
  'bumpMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'specularColorMap',
  'specularIntensityMap',
] as const;

export class TextureUploadQueue {
  private readonly queue: PendingTextureUpload[] = [];
  private readonly queuedMap = new Map<T.Texture, PendingTextureUpload>();
  private readonly uploadedVersions = new WeakMap<T.Texture, number>();
  private readonly deferredScratch: PendingTextureUpload[] = [];
  private seq = 0;
  private uploadedTotal = 0;
  private dequeuedOnDispose = 0;
  private droppedExpired = 0;
  private skippedNotReady = 0;

  private livePacing = false;
  private activeMotion = false;
  private motionSpeedMps = 0;
  private cameraTurnRateRad = 0;
  private boundRenderer: T.WebGLRenderer | null = null;
  private trickleRafId = 0;
  private uploadFrameBucket = -1;
  private uploadsInFrameBucket = 0;
  private lastCallQuotaCapped = false;

  /**
   * Enables strict live-gameplay GPU `initTexture` pacing (`<= 1` texture/frame during fast cycling,
   * sprinting, doorway crossings, or rapid 360° camera pans; `<= 2` textures/frame when calm).
   * Disabled (`false`) during pre-entry boot warmup so `G0`/`G1` flush at full boot throughput.
   */
  setLivePacing(enabled: boolean): void {
    this.livePacing = enabled;
    if (enabled) {
      this.scheduleTrickleIfNeeded();
    } else {
      this.cancelTrickle();
    }
  }

  get isLivePacing(): boolean {
    return this.livePacing;
  }

  /**
   * Updates live player/vehicle linear speed (m/s) and camera angular speed (rad/s) so GPU texture
   * uploads throttle down to `1` upload/frame (`<= 1.4 ms`) during fast motion or 360° camera sweeps.
   */
  setMotionState(speedMps: number, cameraTurnRateRad = 0): void {
    const safeSpeed = Number.isFinite(speedMps) ? Math.max(0, speedMps) : 0;
    const safeTurn = Number.isFinite(cameraTurnRateRad) ? Math.max(0, cameraTurnRateRad) : 0;
    this.motionSpeedMps = safeSpeed;
    this.cameraTurnRateRad = safeTurn;
    this.activeMotion = safeSpeed > 1.65 || safeTurn > 1.05;
  }

  get liveMaxTexturesPerFrame(): number {
    if (!this.livePacing) return 6;
    return this.activeMotion ? 1 : 2;
  }

  get liveMaxMsPerFrame(): number {
    if (!this.livePacing) return 6.0;
    return this.activeMotion ? 1.35 : 2.0;
  }

  private cancelTrickle(): void {
    if (this.trickleRafId && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(this.trickleRafId);
    }
    this.trickleRafId = 0;
  }

  private scheduleTrickleIfNeeded(): void {
    if (
      !this.livePacing ||
      !this.boundRenderer ||
      this.queue.length === 0 ||
      this.trickleRafId !== 0 ||
      isDocumentHidden() ||
      typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function'
    ) {
      return;
    }
    this.trickleRafId = window.requestAnimationFrame(() => {
      this.trickleRafId = 0;
      if (!this.livePacing || !this.boundRenderer || this.queue.length === 0 || isDocumentHidden()) {
        return;
      }
      const gl = this.boundRenderer.getContext?.();
      if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) {
        this.boundRenderer = null;
        return;
      }
      // Proactively trickle 1 prefetched texture per rAF while WARM chunks approach so HOT mount needs 0 sync uploads.
      this.processFrame(this.boundRenderer, 1, 1.35);
      if (this.queue.length > 0) {
        this.scheduleTrickleIfNeeded();
      }
    });
  }

  enqueue(tex: T.Texture | null | undefined, priority: LoadPriorityLevel = LoadPriority.P1_PREFETCH): boolean {
    if (!tex) return false;
    if (this.uploadedVersions.get(tex) === tex.version && tex.version > 0) return false;

    const existing = this.queuedMap.get(tex);
    if (existing) {
      if (priority < existing.priority) existing.priority = priority;
      this.scheduleTrickleIfNeeded();
      return false;
    }

    const onDispose = () => {
      if (this.removeQueuedTexture(tex)) {
        this.dequeuedOnDispose++;
      }
    };

    const item: PendingTextureUpload = {
      texture: tex,
      priority,
      seq: ++this.seq,
      enqueuedAtMs: nowMs(),
      deferredAttempts: 0,
      onDispose,
    };

    if (typeof tex.addEventListener === 'function') {
      tex.addEventListener('dispose', onDispose);
    }

    this.queuedMap.set(tex, item);
    this.queue.push(item);
    this.scheduleTrickleIfNeeded();
    return true;
  }

  private detachDisposeListener(item: PendingTextureUpload): void {
    if (typeof item.texture.removeEventListener === 'function') {
      item.texture.removeEventListener('dispose', item.onDispose);
    }
  }

  private removeQueuedTexture(tex: T.Texture): boolean {
    const item = this.queuedMap.get(tex);
    if (!item) return false;
    this.queuedMap.delete(tex);
    this.detachDisposeListener(item);
    const idx = this.queue.indexOf(item);
    if (idx >= 0) this.queue.splice(idx, 1);
    return true;
  }

  /** Collects every material texture in an `Object3D` subtree and enqueues them for GPU upload. */
  enqueueFromObject(root: T.Object3D, priority: LoadPriorityLevel = LoadPriority.P1_PREFETCH): number {
    let added = 0;
    root.traverse((obj) => {
      const mesh = obj as T.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (let mIdx = 0; mIdx < mats.length; mIdx++) {
        const mat = mats[mIdx];
        if (!mat) continue;
        const rec = mat as unknown as Record<string, unknown>;
        for (let i = 0; i < MATERIAL_TEXTURE_SLOTS.length; i++) {
          const val = rec[MATERIAL_TEXTURE_SLOTS[i]];
          if (val instanceof T.Texture) {
            if (this.enqueue(val, priority)) added++;
          }
        }
      }
    });
    return added;
  }

  /**
   * Uploads up to `maxTextures` queued textures within `maxMs` during a live gameplay frame.
   * Automatically pauses when `document.hidden === true` to protect background WebGL contexts,
   * and strictly enforces per-frame upload caps (`<= 1–2 textures/frame`) when `livePacing` is active.
   */
  processFrame(renderer: T.WebGLRenderer, maxTextures = 2, maxMs = 2.5): number {
    this.lastCallQuotaCapped = false;
    if (this.queue.length === 0 || maxTextures <= 0 || isDocumentHidden()) return 0;
    const gl = renderer.getContext?.();
    if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) {
      if (this.boundRenderer === renderer) this.boundRenderer = null;
      return 0;
    }
    if (typeof renderer.initTexture !== 'function') {
      this.clear();
      return 0;
    }
    this.boundRenderer = renderer;

    const t0 = nowMs();
    let effectiveCap = maxTextures;
    let effectiveMaxMs = maxMs;

    if (this.livePacing) {
      const bucket = Math.floor(t0 * 0.125); // ~8 ms frame bucket
      if (bucket !== this.uploadFrameBucket) {
        this.uploadFrameBucket = bucket;
        this.uploadsInFrameBucket = 0;
      }
      const frameCap = this.liveMaxTexturesPerFrame;
      const remainingQuota = frameCap - this.uploadsInFrameBucket;
      if (remainingQuota <= 0) {
        this.lastCallQuotaCapped = true;
        return 0;
      }
      effectiveCap = Math.min(maxTextures, remainingQuota);
      effectiveMaxMs = Math.min(maxMs, this.liveMaxMsPerFrame);
    }

    let uploaded = 0;
    const deferred = this.deferredScratch;
    deferred.length = 0;

    while (this.queue.length > 0 && uploaded < effectiveCap) {
      let bestIdx = 0;
      let best = this.queue[0];
      for (let i = 1; i < this.queue.length; i++) {
        const cur = this.queue[i];
        if (cur.priority < best.priority || (cur.priority === best.priority && cur.seq < best.seq)) {
          best = cur;
          bestIdx = i;
        }
      }
      const [item] = this.queue.splice(bestIdx, 1);
      if (!item) break;
      this.queuedMap.delete(item.texture);

      if (!isTextureImageReady(item.texture)) {
        item.deferredAttempts++;
        this.skippedNotReady++;
        if (
          item.deferredAttempts < MAX_DEFERRED_ATTEMPTS &&
          t0 - item.enqueuedAtMs < MAX_DEFERRED_AGE_MS
        ) {
          deferred.push(item);
        } else {
          this.detachDisposeListener(item);
          this.droppedExpired++;
        }
        continue;
      }

      this.detachDisposeListener(item);
      try {
        renderer.initTexture(item.texture);
        this.uploadedVersions.set(item.texture, item.texture.version);
        this.uploadedTotal++;
        uploaded++;
        if (this.livePacing) {
          this.uploadsInFrameBucket++;
        }
      } catch {
        /* isolate single malformed texture */
      }

      if (nowMs() - t0 >= effectiveMaxMs) break;
    }

    for (let i = 0; i < deferred.length; i++) {
      const item = deferred[i];
      this.queuedMap.set(item.texture, item);
      this.queue.push(item);
    }
    deferred.length = 0;

    return uploaded;
  }

  /**
   * Cooperative flush: pauses GPU uploads while `document.hidden === true` (resuming on `visibilitychange`),
   * paces live uploads to `<= 1–2 textures/frame` when `livePacing` is active so fast cycling and 360° pans
   * never hit `> 33 ms` D3D11 upload stalls, and drops unready textures after 2 stagnant visible frames.
   */
  async flushAll(
    renderer: T.WebGLRenderer,
    slicer: EchoLifeTimeSlicer,
    opts: {
      maxPerFrame?: number;
      signal?: AbortSignal;
      onProgress?: (uploaded: number, total: number) => void;
      onPausedChange?: (paused: boolean) => void;
    } = {},
  ): Promise<number> {
    const requestedMax = Math.max(1, opts.maxPerFrame ?? 6);
    const total = this.queue.length;
    if (total === 0) {
      this.boundRenderer = renderer;
      opts.onProgress?.(1, 1);
      return 0;
    }

    let uploadedNow = 0;
    let stagnantFrames = 0;

    while (this.queue.length > 0) {
      if (opts.signal?.aborted) break;

      const visible = await waitUntilDocumentVisible(opts.signal, opts.onPausedChange);
      if (!visible || opts.signal?.aborted) break;

      const gl = renderer.getContext?.();
      if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) break;

      const perFrame = this.livePacing ? Math.min(requestedMax, this.liveMaxTexturesPerFrame) : requestedMax;
      const budgetMs = this.livePacing
        ? Math.min(this.liveMaxMsPerFrame, Math.max(1.2, slicer.remainingMs()))
        : Math.max(2.5, slicer.remainingMs());

      const batch = this.processFrame(renderer, perFrame, budgetMs);
      uploadedNow += batch;
      opts.onProgress?.(Math.min(total, uploadedNow), total);

      if (batch === 0) {
        if (!this.lastCallQuotaCapped) {
          stagnantFrames++;
          if (stagnantFrames >= 2) break;
        }
      } else {
        stagnantFrames = 0;
      }

      if (this.queue.length > 0) {
        await slicer.yieldFrame(opts.signal);
        if (this.livePacing) {
          this.uploadFrameBucket = -1;
          this.uploadsInFrameBucket = 0;
        }
      }
    }

    return uploadedNow;
  }

  clear(): void {
    this.cancelTrickle();
    for (let i = 0; i < this.queue.length; i++) {
      this.detachDisposeListener(this.queue[i]);
    }
    this.queue.length = 0;
    this.queuedMap.clear();
    this.deferredScratch.length = 0;
  }

  stats(): TextureUploadStats {
    return {
      queued: this.queue.length,
      uploadedTotal: this.uploadedTotal,
      dequeuedOnDispose: this.dequeuedOnDispose,
      droppedExpired: this.droppedExpired,
      skippedNotReady: this.skippedNotReady,
    };
  }
}

let sharedLoadScheduler: EchoLifeLoadScheduler | null = null;
let sharedTextureUploadQueue: TextureUploadQueue | null = null;

export function getEchoLifeLoadScheduler(): EchoLifeLoadScheduler {
  if (!sharedLoadScheduler) {
    sharedLoadScheduler = new EchoLifeLoadScheduler();
  }
  return sharedLoadScheduler;
}

export function getEchoLifeTextureUploadQueue(): TextureUploadQueue {
  if (!sharedTextureUploadQueue) {
    sharedTextureUploadQueue = new TextureUploadQueue();
  }
  return sharedTextureUploadQueue;
}
