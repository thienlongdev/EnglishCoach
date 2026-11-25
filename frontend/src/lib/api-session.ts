import { authEnding, subscribeAuthLifecycle } from './auth-lifecycle';

/**
 * The browser's API session. The application token lives in an HttpOnly cookie that only the server writes
 * (/api/auth/refresh); no script, this one included, ever sees a token or a session grant. What the page can see
 * is the session's CSRF token, in a readable cookie that lapses a minute before the token does: its presence means
 * "the API session is fresh", its value goes into X-CSRF-Token on every state-changing request.
 */
const CSRF_COOKIES = ['__Host-ec_csrf', 'ec_csrf'];
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Storage keys of the releases that kept tokens in the page; removed on sight. */
const LEGACY_TOKEN_KEYS = ['auth_token', 'ec_session_grant', 'sessionGrant', 'token', 'accessToken', 'english_coach_access_token'];

let refreshing: Promise<'ok' | 'ended' | 'unavailable'> | null = null;
let anonymousUntil = 0;
let legacyPurged = false;

if (typeof window !== 'undefined') {
  // A sign-in (or a sign-out) changes who is asking: forget "nobody is signed in".
  subscribeAuthLifecycle(() => { anonymousUntil = 0; });
}

export function csrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  for (const name of CSRF_COOKIES) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

/** Headers a state-changing request to the API must carry. */
export function csrfHeaders(method?: string): Record<string, string> {
  if (!UNSAFE.has((method || 'GET').toUpperCase())) return {};
  const token = csrfToken();
  return token ? { 'X-CSRF-Token': token } : {};
}

export function purgeLegacyTokens() {
  if (legacyPurged || typeof window === 'undefined') return;
  legacyPurged = true;
  try { for (const key of LEGACY_TOKEN_KEYS) localStorage.removeItem(key); } catch { /* storage denied */ }
}

export type RefreshOutcome = 'ok' | 'ended' | 'unavailable';

/**
 * Asks the server to (re)issue the session cookies. One request at a time however many callers wait.
 * 'ended': nobody is signed in or the session is over (remembered briefly, so a signed-out page does not ask again
 * for every request it makes). 'unavailable': the server could not answer; the session itself may be fine.
 */
export function refreshApiSessionOutcome(): Promise<RefreshOutcome> {
  if (typeof window === 'undefined' || authEnding()) return Promise.resolve('unavailable');
  if (refreshing) return refreshing;
  if (Date.now() < anonymousUntil) return Promise.resolve('ended');
  refreshing = (async (): Promise<RefreshOutcome> => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
      });
      if (response.ok) { anonymousUntil = 0; return 'ok'; }
      if (response.status === 401) { anonymousUntil = Date.now() + 60_000; return 'ended'; }
      return 'unavailable';
    } catch {
      return 'unavailable';
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function refreshApiSession(): Promise<boolean> {
  return (await refreshApiSessionOutcome()) === 'ok';
}

/** True when the API session cookie is (now) fresh. Never throws. */
export async function ensureApiSession(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  purgeLegacyTokens();
  if (csrfToken()) return true;
  if (Date.now() < anonymousUntil) return false;
  return refreshApiSession();
}

/**
 * fetch() for the API with the session cookie: fresh session first, CSRF header on writes, and one retry after a
 * 401 (the token lapsed between the check and the request, or the session was renewed elsewhere).
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  await ensureApiSession();
  const send = () => fetch(input, {
    ...init,
    credentials: 'include',
    headers: { ...(init.headers as Record<string, string> | undefined), ...csrfHeaders(init.method) },
  });
  const response = await send();
  if (response.status !== 401 || authEnding()) return response;
  return (await refreshApiSession()) ? send() : response;
}
