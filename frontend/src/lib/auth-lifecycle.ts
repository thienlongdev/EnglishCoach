/** Shared auth epoch: asynchronous work may only publish into the epoch that started it. */
let epoch = 0;
let ending = false;
let controller = new AbortController();
const listeners = new Set<() => void>();
const cancellationListeners = new Set<() => void>();
export function onAuthWorkCancelled(listener: () => void) { cancellationListeners.add(listener); }
export function subscribeAuthLifecycle(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const authEpoch = () => epoch;
export const authEnding = () => ending;
export const authSignal = () => controller.signal;
export function cancelAuthenticatedWork() {
  epoch++;
  controller.abort();
  controller = new AbortController();
  cancellationListeners.forEach(listener => listener());
}
export function beginLogout() {
  ending = true;
  cancelAuthenticatedWork();
  listeners.forEach(listener => listener());
}
export function beginAuthenticatedSession() {
  ending = false;
  listeners.forEach(listener => listener());
}
/** The session is gone and the window is covered: the guest's page may mount. Only the sign-out passage calls this (10 §BK). */
export function endLogout() {
  ending = false;
  listeners.forEach(listener => listener());
}
export function assertAuthEpoch(started: number) {
  if (ending || started !== epoch) throw new Error('Authenticated request cancelled');
}

/** Revoke failure must never skip local termination. Kept independent for behavioral tests. */
export async function terminateSession(steps: {
  cancel: () => void; revoke: () => Promise<void>; clear: () => void;
  signOut: () => Promise<void>; report: (layer: string) => void;
}) {
  steps.cancel();
  try { await steps.revoke(); } catch { steps.report('backend-revocation'); }
  try { steps.clear(); } finally {
    try { await steps.signOut(); } catch { steps.report('nextauth-termination'); }
    steps.clear();
  }
}
