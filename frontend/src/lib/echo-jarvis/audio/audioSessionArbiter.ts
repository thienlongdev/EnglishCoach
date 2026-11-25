import { authEnding, onAuthWorkCancelled, subscribeAuthLifecycle } from '@/lib/auth-lifecycle';
import { hasActiveStrictSentinelAttempt, subscribeStrictSentinel } from '@/lib/sentinel/client';

// Strict priority order (higher preempts lower immediately):
// 100: 'sentinel-lock'         -> Exam simulation / ranked strict lockdown (suspends JARVIS in 0 ms!)
//  80: 'module-mic'            -> Speaking Assessment, Shadowing, Roleplay, Speaking Arena LiveKit, Shared Study
//  60: 'echo-active-voice'     -> Active Echo JARVIS conversational voice turn
//  20: 'echo-hands-free-wake'  -> Passive local hands-free wake-word monitoring

export type AudioArbiterScope =
  | 'sentinel-lock'
  | 'module-mic'
  | 'echo-active-voice'
  | 'echo-hands-free-wake';

export const AUDIO_SCOPE_PRIORITY: Readonly<Record<AudioArbiterScope, number>> = {
  'sentinel-lock': 100,
  'module-mic': 80,
  'echo-active-voice': 60,
  'echo-hands-free-wake': 20,
};

export interface AudioLeaseCallbacks {
  /** Called immediately when a higher-priority scope (or cross-tab owner) preempts this lease. */
  onSuspend?: (reason: AudioArbiterScope | 'cross-tab' | 'logout') => void;
  /** Called when all higher-priority blockers release and this lease may safely resume. */
  onResume?: () => void;
  /** Called synchronously (0 ms) on logout or hard security lock to stop MediaStream tracks & TTS. */
  onForceTeardown?: (reason: 'logout' | 'sentinel-lock') => void;
  /** Called when hardware audio input/output topology changes (USB mic / AirPods plug or unplug). */
  onDeviceChange?: () => void;
}

export interface AudioLeaseHandle {
  readonly id: string;
  readonly scope: AudioArbiterScope;
  readonly ownerTag: string;
  isGranted: () => boolean;
  attachStream: (stream: MediaStream | null) => void;
  release: () => void;
}

export interface ArbiterSnapshot {
  activeScope: AudioArbiterScope | null;
  activeOwnerTag: string | null;
  sentinelLocked: boolean;
  crossTabRemoteActive: boolean;
  leaseCount: number;
}

interface InternalLease {
  id: string;
  scope: AudioArbiterScope;
  priority: number;
  ownerTag: string;
  suspended: boolean;
  stream: MediaStream | null;
  callbacks: AudioLeaseCallbacks;
}

interface CrossTabMessage {
  tabId: string;
  type: 'claim' | 'release' | 'teardown';
  scope: AudioArbiterScope;
  priority: number;
  at: number;
}

const ARBITER_CHANNEL_NAME = 'ec:mic-arbiter';

function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function stopMediaStreamNow(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  try {
    const tracks = stream.getTracks();
    for (let i = 0; i < tracks.length; i++) {
      try {
        tracks[i].stop();
      } catch {
        // Ignore already-stopped track
      }
    }
  } catch {
    // Ignore mock/closed stream errors
  }
}

/**
 * Single-Owner Microphone and Audio Focus Coordinator across English Coach modules and browser tabs.
 * Note: Strictly in-memory state only — never touches browser storage, cookies, or URL query parameters.
 */
export class AudioSessionArbiter {
  private readonly tabId = makeId('tab');
  private readonly leases = new Map<string, InternalLease>();
  private readonly listeners = new Set<(snap: ArbiterSnapshot) => void>();
  private readonly teardownCallbacks = new Set<() => void>();

  private channel: BroadcastChannel | null = null;
  private remoteTabOwner: { tabId: string; scope: AudioArbiterScope; priority: number; expiresAt: number } | null = null;
  private externalSentinelActive = false;
  private externalModuleOwners = new Set<string>();
  private deviceChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private unsubWindowEvents: (() => void) | null = null;
  private unsubAuth: (() => void) | null = null;

  constructor(options: { bindBrowserEvents?: boolean } = {}) {
    if (options.bindBrowserEvents !== false) {
      this.bindAuthLifecycle();
      if (typeof window !== 'undefined') {
        this.bindEnvironmentListeners();
      }
    }
  }

  private bindAuthLifecycle(): void {
    onAuthWorkCancelled(() => {
      this.teardownAllForLogout();
    });
    const unsubLifecycle = subscribeAuthLifecycle(() => {
      if (authEnding()) {
        this.teardownAllForLogout();
      }
    });
    const unsubSentinel = subscribeStrictSentinel(() => {
      this.setSentinelLock(hasActiveStrictSentinelAttempt());
    });
    this.unsubAuth = () => {
      unsubLifecycle();
      unsubSentinel();
    };
  }

  private bindEnvironmentListeners(): void {
    // 1. Cross-tab coordination via BroadcastChannel('ec:mic-arbiter')
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(ARBITER_CHANNEL_NAME);
        this.channel.onmessage = (event: MessageEvent<CrossTabMessage>) => {
          const msg = event?.data;
          if (!msg || typeof msg !== 'object' || msg.tabId === this.tabId) return;
          this.handleCrossTabMessage(msg);
        };
      } catch {
        this.channel = null;
      }
    }

    // 2. Module mic & Sentinel CustomEvents ('ec:module-mic', 'ec:sentinel-lock')
    const onModuleMic = (ev: Event) => {
      const detail = (ev as CustomEvent<{ active?: boolean; owner?: string; source?: string }>).detail;
      const owner = detail?.owner || detail?.source || 'module';
      if (detail?.active) {
        this.externalModuleOwners.add(owner);
      } else {
        this.externalModuleOwners.delete(owner);
      }
      this.reconcile('module-mic');
    };

    const onSentinelEvent = (ev: Event) => {
      const detail = (ev as CustomEvent<{ active?: boolean }>).detail;
      const next = Boolean(detail?.active);
      this.setSentinelLock(next);
    };

    window.addEventListener('ec:module-mic', onModuleMic as EventListener);
    window.addEventListener('ec:sentinel-lock', onSentinelEvent as EventListener);

    // 3. Hardware hot-plug / unplug recovery ('devicechange')
    let removeDeviceListener: (() => void) | null = null;
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      const onDeviceChange = () => {
        if (this.deviceChangeTimer !== null) clearTimeout(this.deviceChangeTimer);
        this.deviceChangeTimer = setTimeout(() => {
          this.deviceChangeTimer = null;
          this.notifyDeviceChange();
        }, 250);
      };
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
      removeDeviceListener = () => {
        navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
      };
    }

    this.unsubWindowEvents = () => {
      window.removeEventListener('ec:module-mic', onModuleMic as EventListener);
      window.removeEventListener('ec:sentinel-lock', onSentinelEvent as EventListener);
      removeDeviceListener?.();
    };
  }

  /**
   * Explicitly toggle in-memory Sentinel strict-focus lock (Priority 100).
   * Immediately stops & suspends any JARVIS mic/TTS activity in 0 ms!
   */
  setSentinelLock(locked: boolean): void {
    if (this.externalSentinelActive === locked) return;
    this.externalSentinelActive = locked;
    if (locked) {
      for (const lease of this.leases.values()) {
        if (lease.scope === 'echo-active-voice' || lease.scope === 'echo-hands-free-wake') {
          stopMediaStreamNow(lease.stream);
          lease.stream = null;
          lease.callbacks.onForceTeardown?.('sentinel-lock');
        }
      }
      this.broadcast('claim', 'sentinel-lock');
    } else {
      this.broadcast('release', 'sentinel-lock');
    }
    this.reconcile('sentinel-lock');
  }

  /**
   * Register an auxiliary synchronous 0 ms teardown hook (e.g. EchoStreamingPlayback.hardCancel) for logout.
   */
  registerInstantLogoutTeardown(fn: () => void): () => void {
    this.teardownCallbacks.add(fn);
    return () => {
      this.teardownCallbacks.delete(fn);
    };
  }

  /**
   * Request a priority-governed audio session lease.
   */
  acquire(
    scope: AudioArbiterScope,
    ownerTag: string,
    callbacks: AudioLeaseCallbacks = {},
  ): AudioLeaseHandle {
    if (authEnding()) {
      callbacks.onForceTeardown?.('logout');
      return {
        id: 'rejected-logout',
        scope,
        ownerTag,
        isGranted: () => false,
        attachStream: (s) => stopMediaStreamNow(s),
        release: () => {},
      };
    }

    const id = makeId(scope);
    const priority = AUDIO_SCOPE_PRIORITY[scope];
    const lease: InternalLease = {
      id,
      scope,
      priority,
      ownerTag,
      suspended: false,
      stream: null,
      callbacks,
    };

    // If sentinel-lock is acquired directly as a lease, immediately tear down lower JARVIS scopes
    if (scope === 'sentinel-lock') {
      for (const other of this.leases.values()) {
        if (other.priority < priority) {
          stopMediaStreamNow(other.stream);
          other.stream = null;
          other.callbacks.onForceTeardown?.('sentinel-lock');
        }
      }
    }

    this.leases.set(id, lease);
    this.broadcast('claim', scope);
    this.reconcile(scope);

    return {
      id,
      scope,
      ownerTag,
      isGranted: () => {
        const current = this.leases.get(id);
        return Boolean(current && !current.suspended);
      },
      attachStream: (stream: MediaStream | null) => {
        const current = this.leases.get(id);
        if (!current || authEnding()) {
          stopMediaStreamNow(stream);
          return;
        }
        current.stream = stream;
        if (current.suspended && current.scope !== 'echo-hands-free-wake') {
          stopMediaStreamNow(stream);
          current.stream = null;
        }
      },
      release: () => {
        const removed = this.leases.get(id);
        if (!removed) return;
        this.leases.delete(id);
        stopMediaStreamNow(removed.stream);
        removed.stream = null;
        this.broadcast('release', scope);
        this.reconcile(scope);
      },
    };
  }

  canJarvisOperate(scope: 'echo-active-voice' | 'echo-hands-free-wake' = 'echo-active-voice'): boolean {
    if (authEnding()) return false;
    if (this.isSentinelLocked()) return false;
    const reqPrio = AUDIO_SCOPE_PRIORITY[scope];
    if (this.externalModuleOwners.size > 0 && AUDIO_SCOPE_PRIORITY['module-mic'] > reqPrio) {
      return false;
    }
    for (const lease of this.leases.values()) {
      if (lease.priority > reqPrio) return false;
    }
    if (this.remoteTabOwner && this.remoteTabOwner.expiresAt > Date.now()) {
      if (this.remoteTabOwner.priority >= reqPrio && scope === 'echo-hands-free-wake') {
        return false;
      }
      if (this.remoteTabOwner.priority > reqPrio) {
        return false;
      }
    }
    return true;
  }

  isSentinelLocked(): boolean {
    if (this.externalSentinelActive || hasActiveStrictSentinelAttempt()) return true;
    for (const lease of this.leases.values()) {
      if (lease.scope === 'sentinel-lock') return true;
    }
    if (typeof window !== 'undefined' && window.location?.pathname) {
      const p = window.location.pathname;
      if (/^\/exams\/[^/]+\/attempts\/[^/]+/.test(p)) {
        return true;
      }
    }
    return false;
  }

  getSnapshot(): ArbiterSnapshot {
    const winning = this.computeWinningPriority();
    return {
      activeScope: winning.scope,
      activeOwnerTag: winning.ownerTag,
      sentinelLocked: this.isSentinelLocked(),
      crossTabRemoteActive: Boolean(this.remoteTabOwner && this.remoteTabOwner.expiresAt > Date.now()),
      leaseCount: this.leases.size,
    };
  }

  subscribe(listener: (snap: ArbiterSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 0 ms Synchronous Logout Teardown: stops all tracks, cancels TTS, clears leases.
   */
  teardownAllForLogout(): void {
    for (const lease of this.leases.values()) {
      stopMediaStreamNow(lease.stream);
      lease.stream = null;
      lease.suspended = true;
      try {
        lease.callbacks.onForceTeardown?.('logout');
      } catch {
        // Continue teardown
      }
    }
    this.leases.clear();
    this.externalModuleOwners.clear();
    this.externalSentinelActive = false;

    for (const fn of this.teardownCallbacks) {
      try {
        fn();
      } catch {
        // Continue teardown
      }
    }

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore
      }
    }

    this.broadcast('teardown', 'sentinel-lock');
    this.emitSnapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.deviceChangeTimer !== null) {
      clearTimeout(this.deviceChangeTimer);
      this.deviceChangeTimer = null;
    }
    this.unsubWindowEvents?.();
    this.unsubAuth?.();
    try {
      this.channel?.close();
    } catch {
      // Ignore
    }
    this.channel = null;
  }

  private computeWinningPriority(): { priority: number; scope: AudioArbiterScope | null; ownerTag: string | null } {
    if (this.isSentinelLocked()) {
      return { priority: AUDIO_SCOPE_PRIORITY['sentinel-lock'], scope: 'sentinel-lock', ownerTag: 'sentinel' };
    }
    let bestPrio = -1;
    let bestScope: AudioArbiterScope | null = null;
    let bestOwner: string | null = null;

    if (this.externalModuleOwners.size > 0) {
      bestPrio = AUDIO_SCOPE_PRIORITY['module-mic'];
      bestScope = 'module-mic';
      bestOwner = Array.from(this.externalModuleOwners)[0] ?? 'module';
    }

    for (const lease of this.leases.values()) {
      if (lease.priority >= bestPrio) {
        bestPrio = lease.priority;
        bestScope = lease.scope;
        bestOwner = lease.ownerTag;
      }
    }
    return { priority: bestPrio, scope: bestScope, ownerTag: bestOwner };
  }

  private reconcile(triggerReason: AudioArbiterScope | 'cross-tab'): void {
    const winning = this.computeWinningPriority();
    const now = Date.now();
    const remoteActive = this.remoteTabOwner && this.remoteTabOwner.expiresAt > now ? this.remoteTabOwner : null;

    // Identify the latest lease at the winning priority so single-owner invariant holds within the same scope
    let winningLeaseId: string | null = null;
    for (const lease of this.leases.values()) {
      if (lease.priority === winning.priority) {
        winningLeaseId = lease.id;
      }
    }

    for (const lease of this.leases.values()) {
      let shouldSuspend = false;
      let reason: AudioArbiterScope | 'cross-tab' = triggerReason;

      if (lease.priority < winning.priority && winning.scope) {
        shouldSuspend = true;
        reason = winning.scope;
      } else if (lease.priority === winning.priority && winningLeaseId && lease.id !== winningLeaseId) {
        shouldSuspend = true;
        reason = lease.scope;
      } else if (remoteActive) {
        // Another tab claimed active voice, module mic, or sentinel lock -> suspend background wake / lower scopes
        if (remoteActive.priority > lease.priority || (remoteActive.priority >= AUDIO_SCOPE_PRIORITY['echo-active-voice'] && lease.scope === 'echo-hands-free-wake')) {
          shouldSuspend = true;
          reason = 'cross-tab';
        }
      }

      if (shouldSuspend && !lease.suspended) {
        lease.suspended = true;
        lease.callbacks.onSuspend?.(reason);
      } else if (!shouldSuspend && lease.suspended) {
        lease.suspended = false;
        lease.callbacks.onResume?.();
      }
    }

    this.emitSnapshot();
  }

  private handleCrossTabMessage(msg: CrossTabMessage): void {
    if (msg.type === 'claim' && msg.priority >= AUDIO_SCOPE_PRIORITY['echo-active-voice']) {
      this.remoteTabOwner = {
        tabId: msg.tabId,
        scope: msg.scope,
        priority: msg.priority,
        expiresAt: Date.now() + 60_000,
      };
      this.reconcile('cross-tab');
    } else if (msg.type === 'release' || msg.type === 'teardown') {
      if (this.remoteTabOwner?.tabId === msg.tabId) {
        this.remoteTabOwner = null;
        this.reconcile('cross-tab');
      }
    }
  }

  private notifyDeviceChange(): void {
    for (const lease of this.leases.values()) {
      if (!lease.suspended) {
        try {
          lease.callbacks.onDeviceChange?.();
        } catch {
          // Ignore callback error
        }
      }
    }
  }

  private broadcast(type: CrossTabMessage['type'], scope: AudioArbiterScope): void {
    if (!this.channel) return;
    try {
      const payload: CrossTabMessage = {
        tabId: this.tabId,
        type,
        scope,
        priority: AUDIO_SCOPE_PRIORITY[scope],
        at: Date.now(),
      };
      this.channel.postMessage(payload);
    } catch {
      // Ignore closed channel
    }
  }

  private emitSnapshot(): void {
    if (this.listeners.size === 0) return;
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        // Ignore
      }
    }
  }
}

export const audioSessionArbiter = new AudioSessionArbiter();
