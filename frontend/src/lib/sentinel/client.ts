import { apiClient } from '@/services/api-client';
import { authFetch, csrfHeaders } from '@/lib/api-session';

/**
 * Echo Sentinel page client (owner directive 2026-11-14, rules 10 §BX). An attempt's secret is kept ONLY in the memory
 * of the page that opened it (never storage, never a URL): a reload, a closed tab or a second tab cannot present it again,
 * which is how the server tells a reload from a network blip. Reports from the page are evidence, not proof.
 */
export const SENTINEL_POLICY_VERSION = 1;

export type SentinelAttempt = {
  id: string; token: string; activity: string; policyVersion: number;
  heartbeatMs: number; continuityGraceMs: number; blurGraceMs: number;
};
export type SentinelStatus = { id: string; state: string; detail: string | null; ranked: boolean };
export type LeaveKind = 'HIDDEN' | 'BLUR' | 'PAGEHIDE' | 'NAVIGATION' | 'EXIT' | 'FULLSCREEN_EXIT';

export const TERMINAL = new Set(['COMPLETED_VERIFIED', 'PENDING_REVIEW', 'VOIDED_FOCUS_LOSS', 'VOIDED_ABANDONED', 'VOIDED_RELOAD',
  'VOIDED_CONTINUITY', 'VOIDED_INTEGRITY_FAILURE', 'EXPIRED']);
export const isVoided = (state?: string | null) => !!state && (state.startsWith('VOIDED_') || state === 'EXPIRED');

const activeStrict = new Map<string, number>();
const strictListeners = new Set<() => void>();
const pruneStrict = () => { const now = Date.now(); let changed = false; for (const [id, until] of activeStrict) if (until <= now) { activeStrict.delete(id); changed = true; } return changed; };
const notifyStrict = () => strictListeners.forEach(fn => { try { fn(); } catch { /* listener isolated */ } });
export const activeStrictSentinelCount = (): number => { if (pruneStrict()) notifyStrict(); return activeStrict.size; };
export const hasActiveStrictSentinelAttempt = (): boolean => activeStrictSentinelCount() > 0;
export const subscribeStrictSentinel = (listener: () => void): (() => void) => { strictListeners.add(listener); return () => { strictListeners.delete(listener); }; };
export const releaseStrictSentinelAttempt = (id?: string): void => { if (id ? activeStrict.delete(id) : (activeStrict.size > 0 && (activeStrict.clear(), true))) notifyStrict(); };

/** Opens an attempt after the learner pressed "Tôi đã hiểu — Bắt đầu". */
export async function beginAttempt(activity: string): Promise<SentinelAttempt> {
  const response = await apiClient.post('/sentinel/attempts', { activity, acknowledged: true, policyVersion: SENTINEL_POLICY_VERSION }, { timeout: 10000 });
  const data = response.data as SentinelAttempt;
  if (data?.id) { activeStrict.set(data.id, Date.now() + Math.max(30000, (data.continuityGraceMs || 20000) + 15000)); notifyStrict(); }
  return data;
}

/** The handle a game command carries: "id.secret". */
export const sentinelHandle = (a: SentinelAttempt) => `${a.id}.${a.token}`;

const url = (a: SentinelAttempt, what: 'heartbeat' | 'violation') => `/api/v1/sentinel/attempts/${encodeURIComponent(a.id)}/${what}`;

/** "Still on screen" report. Null when the server could not be reached (the server decides continuity, not the page). */
export async function heartbeat(a: SentinelAttempt, visible: boolean): Promise<SentinelStatus | null> {
  try {
    const response = await authFetch(url(a, 'heartbeat'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ token: a.token, visible }), signal: AbortSignal.timeout(8000),
    });
    const status = response.ok ? (await response.json()) as SentinelStatus : null;
    if (status && TERMINAL.has(status.state)) releaseStrictSentinelAttempt(a.id);
    else if (status && activeStrict.has(a.id)) activeStrict.set(a.id, Date.now() + Math.max(15000, (a.continuityGraceMs || 20000) + 5000));
    return status;
  } catch { return null; }
}

/**
 * Report of leaving. `keepalive` lets it leave with a closing / hidden page; it carries the CSRF header (a beacon could
 * not). Best effort only: the server also ends the attempt when the secret is missing on return or the reports stop.
 */
export function reportLeaving(a: SentinelAttempt, kind: LeaveKind): Promise<SentinelStatus | null> {
  releaseStrictSentinelAttempt(a.id);
  try {
    return fetch(url(a, 'violation'), {
      method: 'POST', keepalive: true, credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...csrfHeaders('POST') },
      body: JSON.stringify({ token: a.token, kind }),
    }).then(r => r.ok ? r.json() as Promise<SentinelStatus> : null).catch(() => null);
  } catch { return Promise.resolve(null); }
}

/** Exam simulation: binds the acknowledged attempt to the learner's running simulation (allowed once per exam attempt). */
export async function bindExam(a: SentinelAttempt, examAttemptId: string): Promise<SentinelStatus> {
  const response = await apiClient.post(`/sentinel/attempts/${encodeURIComponent(a.id)}/bind`, { token: a.token, subject: examAttemptId }, { timeout: 10000 });
  return response.data as SentinelStatus;
}

/** A page that opened a running simulation without its secret (reload, another tab): the server ends that attempt. */
export async function reopenExam(examAttemptId: string): Promise<{ state: string }> {
  const response = await apiClient.post(`/sentinel/subjects/EXAM_SIMULATION/${encodeURIComponent(examAttemptId)}/reopen`, {}, { timeout: 10000 });
  return response.data as { state: string };
}
