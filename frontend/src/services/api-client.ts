import axios from "axios";
import { authEpoch, authEnding, authSignal, assertAuthEpoch, onAuthWorkCancelled } from "../lib/auth-lifecycle";
import { csrfHeaders, ensureApiSession, refreshApiSessionOutcome, type RefreshOutcome } from "../lib/api-session";
import { requestStepUp } from "../lib/step-up";

const IS_SERVER = typeof window === 'undefined';
// Inside Docker network, Next.js server must use the container name 'backend'
// Browser clients should continue using localhost unless overridden by runtime test environment
export function getBaseUrl() {
    if (IS_SERVER) {
        return 'http://backend:8080/api/v1';
    }
    // A stored override is a development aid only: in production the API base is fixed at build time, so nothing
    // written to the page's storage can redirect API calls (and their CSRF header) elsewhere.
    if (process.env.NODE_ENV === 'production') return process.env.NEXT_PUBLIC_API_URL || '/api/v1';
    return (window as any).__API_URL__ || localStorage.getItem('ec_api_url') || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api/v1';
}

/**
 * The API client of the browser. It holds no credential: the application token travels in an HttpOnly cookie the
 * browser attaches by itself (`withCredentials`), a state-changing request adds the session's CSRF token, and a 401
 * is answered by asking the server to renew the cookie once and repeating the request.
 */
export const apiClient = axios.create({ baseURL: getBaseUrl(), withCredentials: true });

let pendingRefresh: Promise<RefreshOutcome> | null = null;
onAuthWorkCancelled(() => { pendingRefresh = null; });

const isPublicCatalog = (url?: string) => !!url && (url === '/premium/plans' || url.includes('/exams/catalog') || url.includes('/exams/capabilities'));

apiClient.interceptors.request.use(async (config) => {
    if (typeof window !== "undefined") {
        const started = authEpoch();
        if (authEnding()) throw new axios.CanceledError("Session ended");
        (config as any)._authEpoch = started;
        const signals = [authSignal(), config.signal].filter(Boolean) as AbortSignal[];
        config.signal = AbortSignal.any(signals);
        config.baseURL = getBaseUrl();
        config.withCredentials = true;
        const allowTestUser = process.env.NEXT_PUBLIC_ENABLE_TEST_USER === 'true';
        const testUser = allowTestUser ? ((window as any).__TEST_USER__ || localStorage.getItem('ec_test_user')) : null;
        if (testUser) {
            config.headers['X-Test-User'] = testUser;
        }

        // Public catalog requests need no session; everything else makes sure the session cookie is fresh first
        // (a no-op while it is, one server round trip when it has lapsed).
        if (!isPublicCatalog(config.url)) {
            await ensureApiSession();
            assertAuthEpoch(started);
        }
        for (const [name, value] of Object.entries(csrfHeaders(config.method))) {
            config.headers[name] = value;
        }
    }
    return config;
});

apiClient.interceptors.response.use(
    (response) => {
        if (typeof window !== "undefined") {
            assertAuthEpoch((response.config as any)._authEpoch);
            learningEvidencePulse(response.config.method, response.config.url);
        }
        return response;
    },
    async (error) => {
        const originalRequest = error.config;
        if (!originalRequest || typeof window === "undefined") {
            return Promise.reject(error);
        }

        if (authEnding() || (originalRequest._authEpoch !== undefined && originalRequest._authEpoch !== authEpoch())) return Promise.reject(error);

        // A sensitive administrator action whose second-factor proof is no longer fresh: ask for the factor (the
        // dialog of the admin layout), then repeat the request once. Declined or no dialog: the refusal stands.
        if (error.response?.status === 403 && error.response.data?.code === 'STEP_UP_REQUIRED'
            && !originalRequest._stepUp && !originalRequest.skipStepUp) {
            originalRequest._stepUp = true;
            const confirmed = await requestStepUp();
            if (confirmed && originalRequest._authEpoch === authEpoch() && !authEnding()) return apiClient(originalRequest);
            return Promise.reject(error);
        }

        if (!error.response || error.response.status !== 401 || originalRequest._retry) {
            return Promise.reject(error);
        }
        originalRequest._retry = true;

        // One renewal for every request that failed together.
        pendingRefresh = pendingRefresh || refreshApiSessionOutcome().finally(() => { pendingRefresh = null; });
        const outcome = await pendingRefresh;
        if (originalRequest._authEpoch !== authEpoch() || authEnding()) return Promise.reject(error);

        if (outcome === 'ok') {
            // The CSRF token belongs to the session, not to the token: re-read it in case the session is new.
            originalRequest.headers = originalRequest.headers || {};
            for (const [name, value] of Object.entries(csrfHeaders(originalRequest.method))) {
                originalRequest.headers[name] = value;
            }
            return apiClient(originalRequest);
        }
        if (outcome === 'ended') {
            // Nobody is signed in any more. A public catalog read simply stays anonymous; exam screens handle the
            // 401 themselves; everywhere else the private UI is closed.
            const quiet = isPublicCatalog(originalRequest.url) || originalRequest.url?.includes("/exams") || originalRequest.skipAuthRedirect;
            if (!quiet) void import("./logout").then(({ logout }) => logout());
        }
        // 'unavailable': the server could not renew now; the session itself is untouched.
        return Promise.reject(error);
    }
);

/**
 * A stored learning action (a card saved or rated, a lesson completed, writing or speech submitted, a grammar step) tells the
 * open knowledge universe in this tab and in the account's other tabs to rebuild from the server's evidence. Only the kind of
 * action is sent, never its content; the universe re-reads its own evidence. No request, no polling.
 */
const EVIDENCE_PATHS = /^\/?(flashcards(\/|$)|grammar\/|reading\/materials\/\d+\/(complete|session)|listening\/|writing\/|speaking\/)/;
let evidenceChannel: BroadcastChannel | null = null;
function learningEvidencePulse(method?: string, url?: string) {
    try {
        const m = (method || "get").toLowerCase();
        if (m === "get" || m === "head" || m === "options" || !url) return;
        const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1/, "").split("?")[0];
        if (!EVIDENCE_PATHS.test(path)) return;
        const detail = { kind: path.replace(/^\//, "").split("/")[0], at: Date.now() };
        window.dispatchEvent(new CustomEvent("ec:learning-evidence", { detail }));
        if (typeof BroadcastChannel !== "undefined") (evidenceChannel ??= new BroadcastChannel("ec-learning-evidence")).postMessage(detail);
    } catch { /* optional */ }
}
