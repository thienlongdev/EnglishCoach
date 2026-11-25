'use client';
import { signOut } from 'next-auth/react';
import { beginLogout, terminateSession } from '../lib/auth-lifecycle';
import { clearUserScopedCaches } from '../lib/auth-cache-cleanup';
import { journeySignOut, setJourneyHoldsAccount, writeJourneyToken } from '../lib/journey/journey';

/** However the opening fares (a hidden tab draws no frames), private state does not wait for it for longer than this. */
const COVER_LIMIT_MS = 3200;

let pending: Promise<void> | null = null;
export function logout(callbackUrl = '/') {
  if (pending) return pending;
  // Echo swims out in the frame of the press and the current covers the window. The session is ended at once all the same: requests stop now,
  // revocation does not wait for any animation. Only what would visibly tear the page apart (emptied caches, the session change) waits for the cover.
  const passage = journeySignOut(callbackUrl);
  const covered = async () => {
    if (!passage) return;
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([passage.covered, new Promise<void>((resolve) => { timer = setTimeout(resolve, COVER_LIMIT_MS); })]);
    clearTimeout(timer!);
    setJourneyHoldsAccount(false);
  };
  pending = terminateSession({
    cancel: () => { beginLogout(); if (!passage) clearUserScopedCaches(); },
    revoke: async () => {
      try {
        // BFF resolves the HttpOnly session; no bearer/session grant is exposed in this request.
        let csrf = document.cookie.match(/(?:^|;\s*)(?:__Host-)?ec\.csrf=([^;]+)/)?.[1];
        if (!csrf) {
          const context = await fetch('/api/auth/csrf-context', { signal: AbortSignal.timeout(5000) });
          csrf = (await context.json()).csrfToken;
        }
        const response = await fetch('/api/auth/logout', {
          method: 'POST', headers: { 'X-CSRF-Token': csrf || '' },
          signal: AbortSignal.timeout(12000),
        });
        if (!response.ok || !(await response.json()).revoked) throw new Error('Revocation failed');
      } finally {
        await covered();
      }
    },
    clear: clearUserScopedCaches,
    signOut: async () => {
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          signOut({ redirect: false, callbackUrl }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Sign out timeout')), 5000); }),
        ]);
      } finally { clearTimeout(timer!); }
    },
    report: layer => console.warn(`[Logout] ${layer} failed; local private state cleared`),
  }).finally(() => {
    pending = null;
    if (passage) { passage.finish(); return; }
    // No passage could start: the next page opens on the same water as the leaving screen (`leaving`), not on a white one.
    writeJourneyToken('signout');
    window.location.replace(callbackUrl);
  });
  return pending;
}
