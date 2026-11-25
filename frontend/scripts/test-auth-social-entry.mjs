import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const read = path => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
function evaluate(path, dependencies = {}, globals = {}) {
  const { code } = babel.core().transformSync(read(path), { filename: path, configFile: false, babelrc: false,
    presets: [babel.presetTypescript(), ...(path.endsWith('.tsx') ? [babel.presetReact()] : [])], plugins: [babel.pluginTransformModulesCommonjs()] });
  const exports = {};
  runInNewContext(code, { exports, require: path => dependencies[path] ?? require(path), AbortController, AbortSignal, console,
    setTimeout, clearTimeout, Date, Buffer, ...globals });
  return exports;
}
const core = evaluate('lib/module-entry-core.ts');
const auth = evaluate('lib/auth-lifecycle.ts');
// Google creates ONE backend grant and copies that verified identity into the JWT.
// Server-to-server calls to the token-issuing endpoints are signed with the dedicated internal-service key; the
// frontend never holds the backend's token-signing secret.
const serverEnv = { APP_SECURITY_INTERNAL_SERVICE_KEY: 'unit-test-dedicated-internal-service-key-0123456789' };
const internalAuth = evaluate('lib/server/internal-auth.ts', {}, { process: { env: serverEnv } });
let nextAuthOptions, exchanges = 0, exchangeHeaders, exchangeUrl;
const authRoute = evaluate('app/api/auth/[...nextauth]/route.ts', {
  'next-auth': options => { nextAuthOptions = options; return () => {}; },
  'next-auth/providers/google': () => ({}), 'next-auth/providers/credentials': options => options,
  '@/lib/server/internal-auth': internalAuth,
}, { process: { env: serverEnv }, fetch: async (url, options) => { exchanges++; exchangeUrl = url; exchangeHeaders = options.headers; return { ok: true, json: async () => ({ user: { id: 42, name: 'Learner', role: 'ROLE_USER' }, accessToken: 'test-only', sessionGrant: 'test-only' }) }; } });
// Options are built per request: server-side sign-in calls carry the browser address Nginx reported (X-Real-IP).
const requestFrom = realIp => ({ headers: { get: name => (name === 'x-real-ip' ? realIp : null) } });
await authRoute.GET(requestFrom('203.0.113.7'), {});
const googleUser = { id: 'provider-id' }, googleAccount = { provider: 'google', id_token: 'test-only' };
assert.equal(await nextAuthOptions.callbacks.signIn({ user: googleUser, account: googleAccount }), true);
const jwt = await nextAuthOptions.callbacks.jwt({ token: {}, user: googleUser, account: googleAccount });
assert.equal(exchanges, 1); assert.equal(jwt.userId, '42'); assert.equal(jwt.sessionGrant, 'test-only');
assert.equal(exchangeHeaders['X-Real-IP'], '203.0.113.7');
// The encrypted session cookie keeps the grant and no application token; a cookie from before this release loses its token.
assert.equal(jwt.accessToken, undefined); assert.equal(jwt.id_token, undefined);
const legacyJwt = await nextAuthOptions.callbacks.jwt({ token: { userId: '7', sessionGrant: 'g', accessToken: 'old', id_token: 'old' }, account: null, user: null });
assert.equal(legacyJwt.accessToken, undefined); assert.equal(legacyJwt.id_token, undefined); assert.equal(legacyJwt.sessionGrant, 'g');
// What a page script can read from /api/auth/session: identity only, never a token or the grant.
const pageSession = await nextAuthOptions.callbacks.session({ session: { user: {} }, token: { ...jwt, accessToken: 'x' } });
assert.deepEqual(Object.keys(pageSession), ['user']); assert.equal(pageSession.user.id, '42');
assert.ok(!JSON.stringify(pageSession).includes('test-only'));
// The call is signed for exactly the endpoint and body it carries: v2.<seconds>.<32 hex nonce>.<64 hex>, and the
// MAC is the one the backend computes (InternalServiceAuthFilter#sign): HMAC(HMAC(key, label), canonical text).
assert.ok(exchangeUrl.endsWith('/api/v1/auth/google/exchange'));
assert.match(exchangeHeaders['X-EC-Internal'], /^v2\.\d{10}\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
{
  const crypto = require('node:crypto');
  const body = '{"idToken":"test-only"}';
  const [, seconds, nonce, mac] = internalAuth.internalAuthHeader('/api/v1/auth/google/exchange', body)['X-EC-Internal'].split('.');
  const key = crypto.createHmac('sha256', serverEnv.APP_SECURITY_INTERNAL_SERVICE_KEY).update('ec-internal-service-v1').digest();
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  assert.equal(mac, crypto.createHmac('sha256', key).update(`v2\n${seconds}\n${nonce}\nPOST\n/api/v1/auth/google/exchange\n${digest}`).digest('hex'));
  // a fresh nonce every call: two signatures for the same request differ
  assert.notEqual(internalAuth.internalAuthHeader('/api/v1/auth/login', body)['X-EC-Internal'],
    internalAuth.internalAuthHeader('/api/v1/auth/login', body)['X-EC-Internal']);
  // no key, no header (and no fallback to another secret)
  const keyless = evaluate('lib/server/internal-auth.ts', {}, { process: { env: { AUTH_JWT_SECRET: 'x'.repeat(48) } } });
  assert.equal(Object.keys(keyless.internalAuthHeader('/api/v1/auth/login', body)).length, 0);
}
for (const file of ['lib/server/internal-auth.ts', 'app/api/auth/refresh/route.ts', 'app/api/auth/logout/route.ts', 'app/api/auth/[...nextauth]/route.ts']) {
  assert.ok(!read(file).includes('AUTH_JWT_SECRET'), `${file} must not read the backend token-signing secret`);
}
// Linking Google to a password account happens on the server: ticket + password in, a session out, no grant to the page.
const credentials = nextAuthOptions.providers[1];
const linked = await credentials.authorize({ linkTicket: 'ticket', password: 'pw' });
assert.ok(exchangeUrl.endsWith('/api/v1/auth/google/link')); assert.equal(linked.id, '42'); assert.equal(linked.sessionGrant, 'test-only');
assert.equal(await credentials.authorize({ linkTicket: 'ticket' }), null);
assert.equal(credentials.credentials.sessionGrant, undefined, 'a raw grant is no longer a way to sign in');
// Anything that is not an address literal is never forwarded to the backend as a client address.
for (const notAnAddress of [null, '', 'evil.example.com', '1.2.3.4, 5.6.7.8', '<script>']) {
  await authRoute.POST(requestFrom(notAnAddress), {});
  await nextAuthOptions.callbacks.signIn({ user: { id: 'provider-id' }, account: googleAccount });
  assert.equal(exchangeHeaders['X-Real-IP'], undefined);
  assert.equal(exchangeHeaders['Content-Type'], 'application/json');
}
assert.equal((await nextAuthOptions.callbacks.jwt({ token: { email: 'unverified' }, account: null, user: null })).id_token, undefined);
for (const fail of [false, true]) {
  const calls = [];
  await auth.terminateSession({ cancel: () => calls.push('cancel'), revoke: async () => { calls.push('revoke'); if (fail) throw Error('offline'); },
    clear: () => calls.push('clear'), signOut: async () => calls.push('signOut'), report: layer => calls.push(layer) });
  assert.equal(calls[0], 'cancel'); assert.ok(calls.includes('revoke') && calls.includes('signOut'));
  assert.equal(calls.filter(x => x === 'clear').length, 2);
  assert.equal(calls.includes('backend-revocation'), fail);
}
const epoch = auth.authEpoch(); const signal = auth.authSignal(); auth.beginLogout();
assert.ok(signal.aborted && auth.authEnding()); assert.throws(() => auth.assertAuthEpoch(epoch)); auth.beginAuthenticatedSession();
// Actual API interceptor: the page holds no credential. A session renewal that resolves after logout cannot
// let the request through, tokens left in storage by an older release are removed, and nothing is stored.
const values = new Map([['auth_token', 'legacy'], ['ec_session_grant', 'legacy'], ['theme', 'dark']]);
const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), clear: () => values.clear() };
let resolveRefresh, requestInterceptor, refreshCalls = 0; const browserDocument = { cookie: '' };
const axios = { create: options => { assert.equal(options.withCredentials, true); return { interceptors: { request: { use: cb => { requestInterceptor = cb; } }, response: { use() {} } } }; }, CanceledError: Error };
const browserGlobals = { window: {}, document: browserDocument, localStorage: storage, process: { env: {} }, RegExp, decodeURIComponent, Promise,
  fetch: (url, options) => { refreshCalls++; assert.equal(url, '/api/auth/refresh'); assert.equal(options.method, 'POST'); return new Promise(resolve => { resolveRefresh = resolve; }); } };
const apiSession = evaluate('lib/api-session.ts', { './auth-lifecycle': auth }, browserGlobals);
evaluate('services/api-client.ts', { axios, '../lib/auth-lifecycle': auth, '../lib/api-session': apiSession, '../lib/step-up': { requestStepUp: async () => false } }, browserGlobals);
const request = requestInterceptor({ url: '/users/me/profile', method: 'post', headers: {} });
await Promise.resolve(); assert.equal(refreshCalls, 1);
auth.beginLogout(); resolveRefresh({ ok: true, status: 200 });
await assert.rejects(request, /cancelled/); assert.deepEqual([...values.keys()], ['theme']); auth.beginAuthenticatedSession();
// With a fresh session the request goes out with the cookie (withCredentials), the CSRF header and no Authorization.
browserDocument.cookie = 'theme=dark; __Host-ec_csrf=csrf-value';
const sent = await requestInterceptor({ url: '/flashcards', method: 'post', headers: {} });
assert.equal(sent.headers['X-CSRF-Token'], 'csrf-value'); assert.equal(sent.headers.Authorization, undefined); assert.equal(sent.withCredentials, true);
assert.equal((await requestInterceptor({ url: '/flashcards', method: 'get', headers: {} })).headers['X-CSRF-Token'], undefined);
assert.equal(refreshCalls, 1, 'a fresh session is not renewed again'); browserDocument.cookie = '';
const clientSource = read('services/api-client.ts') + read('lib/api-session.ts') + read('services/stompClient.ts');
assert.ok(!/localStorage\.setItem\(|Bearer |getSession/.test(clientSource), 'no token is read from the session, stored, or sent in a header');
// Actual server logout handler: successful and failed revoke both expire chunked session cookies.
for (const fail of [false, true]) {
  const expired = []; let revokedCalls = 0;
  const nextServer = { NextResponse: { json: data => ({ data, cookies: { set: (name, value, options) => expired.push({ name, value, options }) } }) } };
  const httpsEnv = { NEXTAUTH_URL: 'https://englishcoach.io.vn' };
  const route = evaluate('app/api/auth/logout/route.ts', {
    'next/server': nextServer,
    'next-auth/jwt': { getToken: async () => ({ sessionGrant: 'test-only', accessToken: 'test-only' }) },
    '@/lib/server/bff-csrf': { validateBffCsrf: () => ({ valid: true }) },
    '@/lib/server/internal-auth': internalAuth,
    '@/lib/server/session-cookies': evaluate('lib/server/session-cookies.ts', { 'next/server': nextServer }, { process: { env: httpsEnv } }),
  }, { process: { env: httpsEnv }, fetch: async (_url, options) => {
    revokedCalls++;
    // Expired cookie bearer must not cause Spring to reject grant-authenticated logout.
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(JSON.parse(options.body).sessionGrant, 'test-only');
    if (fail) throw Error('offline'); return { ok: true };
  } });
  const response = await route.POST({ headers: { get: () => null }, cookies: { getAll: () => [{ name: '__Secure-next-auth.session-token.0' }, { name: '__Secure-next-auth.session-token.1' }, { name: 'theme' }] } });
  assert.equal(revokedCalls, 1); assert.equal(response.data.revoked, !fail);
  // Both chunks of the NextAuth cookie and both API session cookies are expired, whatever the backend said.
  assert.deepEqual(expired.map(cookie => cookie.name).sort(), ['__Host-ec_at', '__Host-ec_csrf', '__Secure-next-auth.session-token.0', '__Secure-next-auth.session-token.1']);
  assert.ok(expired.every(cookie => cookie.options.maxAge === 0 && cookie.value === '' && cookie.options.path === '/'));
  assert.ok(expired.filter(cookie => cookie.name !== '__Host-ec_csrf').every(cookie => cookie.options.httpOnly && cookie.options.secure));
}
// Actual refresh route: the grant stays on the server, the token goes out only as an HttpOnly cookie, the answer
// carries neither; a foreign origin is refused; an ended session expires every cookie; an outage signs nobody out.
{
  const httpsEnv = { NEXTAUTH_URL: 'https://englishcoach.io.vn', APP_SECURITY_INTERNAL_SERVICE_KEY: serverEnv.APP_SECURITY_INTERNAL_SERVICE_KEY };
  const makeResponse = (data, init) => { const cookies = []; return { data, status: init?.status ?? 200, cookies: { set: (name, value, options) => cookies.push({ name, value, options }) }, set: cookies }; };
  const nextServer = { NextResponse: { json: makeResponse } };
  let backend, backendCall;
  const refreshRoute = evaluate('app/api/auth/refresh/route.ts', {
    'next/server': nextServer, 'next-auth/jwt': { getToken: async () => ({ sessionGrant: 'grant-on-server' }) },
    '@/lib/server/internal-auth': evaluate('lib/server/internal-auth.ts', {}, { process: { env: httpsEnv } }),
    '@/lib/server/session-cookies': evaluate('lib/server/session-cookies.ts', { 'next/server': nextServer }, { process: { env: httpsEnv }, URL }),
  }, { process: { env: httpsEnv }, Number, fetch: async (url, options) => { backendCall = { url, options }; return backend; } });
  const browser = (headers, cookies = []) => ({ headers: { get: name => headers[name] ?? null }, cookies: { getAll: () => cookies } });
  const sameOrigin = { origin: 'https://englishcoach.io.vn', host: 'englishcoach.io.vn', 'sec-fetch-site': 'same-origin', 'x-real-ip': '203.0.113.9' };
  backend = { ok: true, status: 200, json: async () => ({ accessToken: 'app-token', csrfToken: 'csrf-token', expiresIn: 1800, sessionGrant: 'grant-on-server', user: { id: 5, role: 'ROLE_USER', email: 'a@b.c' } }) };
  const renewed = await refreshRoute.POST(browser(sameOrigin));
  assert.equal(renewed.status, 200); assert.ok(!/app-token|grant-on-server|a@b\.c/.test(JSON.stringify(renewed.data)));
  const access = renewed.set.find(c => c.name === '__Host-ec_at'), csrf = renewed.set.find(c => c.name === '__Host-ec_csrf');
  assert.deepEqual([access.value, access.options.httpOnly, access.options.secure, access.options.sameSite, access.options.path], ['app-token', true, true, 'strict', '/']);
  assert.deepEqual([csrf.value, csrf.options.httpOnly, csrf.options.secure, csrf.options.sameSite], ['csrf-token', false, true, 'strict']);
  assert.ok(csrf.options.maxAge < access.options.maxAge && access.options.maxAge < 1800);
  assert.equal(JSON.parse(backendCall.options.body).sessionGrant, 'grant-on-server');
  assert.match(backendCall.options.headers['X-EC-Internal'], /^v2\./); assert.equal(backendCall.options.headers['X-Real-IP'], '203.0.113.9');
  for (const foreign of [{ ...sameOrigin, origin: 'https://evil.example' }, { ...sameOrigin, 'sec-fetch-site': 'cross-site' }, { host: 'englishcoach.io.vn' }]) {
    backendCall = null; assert.equal((await refreshRoute.POST(browser(foreign))).status, 403); assert.equal(backendCall, null);
  }
  backend = { ok: false, status: 401, json: async () => ({ code: 'INVALID_REFRESH_TOKEN' }) };
  const ended = await refreshRoute.POST(browser(sameOrigin, [{ name: '__Secure-next-auth.session-token' }]));
  assert.equal(ended.status, 401); assert.equal(ended.set.filter(c => c.options.maxAge === 0).length, 3);
  for (const outage of [{ ok: false, status: 503, json: async () => ({}) }, { ok: false, status: 401, json: async () => ({ code: 'INTERNAL_AUTH_REQUIRED' }) }]) {
    backend = outage; const unavailable = await refreshRoute.POST(browser(sameOrigin, [{ name: '__Secure-next-auth.session-token' }]));
    assert.equal(unavailable.status, 503); assert.equal(unavailable.set.length, 0);
  }
}
// Actual avatar consumer first paint: skeleton when unknown, actual image when warm, initials only when no custom avatar.
for (const state of [{ isLoading: true, hasAvatar: false, avatarUrl: null }, { isLoading: false, hasAvatar: true, avatarUrl: 'blob:warm-avatar' }, { isLoading: false, hasAvatar: false, avatarUrl: null }]) {
  const component = evaluate('components/common/UserAvatar.tsx', { react: React,
    '@/hooks/useCurrentUserAvatar': { useCurrentUserAvatar: () => state },
    '@/hooks/useCurrentUserProfile': { useCurrentUserProfile: () => ({ effectiveDisplayName: 'Alice User', initials: 'AU' }) },
    '@/hooks/useAvatarFrames': { useAvatarFrames: () => ({ equippedFrame: null }) }, '@/components/common/frame/AvatarWithFrame': { AvatarWithFrame: () => null } });
  const html = renderToString(React.createElement(component.UserAvatar));
  assert.equal(html.includes('Loading avatar'), state.isLoading);
  assert.equal(html.includes('blob:warm-avatar'), state.hasAvatar);
  if (state.isLoading) assert.ok(!html.includes('AU'));
}
const revokedUrls = [];
const avatar = evaluate('hooks/useCurrentUserAvatar.ts', { react: { useEffect() {} }, swr: () => ({ data: new Blob(['img']) }),
  'next-auth/react': { useSession: () => ({ data: { user: { email: 'B' } } }) },
  '@/services/userProfileApi': {}, '@/services/profileIdentityResource': {},
  './useCurrentUserProfile': { useCurrentUserProfile: () => ({ profile: {}, avatarPresent: true, avatarUpdatedAt: 'v2', isLoading: false }) },
}, { window: {}, URL: { createObjectURL: () => 'blob:B', revokeObjectURL: url => revokedUrls.push(url) } });
avatar.getOrCreateAvatarObjectUrl('A:v1', new Blob(['A'])); const first = avatar.useCurrentUserAvatar();
assert.equal(first.avatarUrl, 'blob:B'); assert.equal(revokedUrls.length, 1); avatar.revokeCurrentAvatarObjectUrl(); assert.equal(revokedUrls.length, 2);
// Actual Community cache dedupes prefetch/mount, isolates accounts and rejects late responses after purge.
const communityValues = new Map();
const communityStorage = { ...storage, getItem: key => communityValues.get(key) ?? null, setItem: (key, value) => communityValues.set(key, value), removeItem: key => communityValues.delete(key), get length() { return communityValues.size; }, key: i => [...communityValues.keys()][i] };
const community = evaluate('services/communityCache.ts', { './communityApi': { buildCommentTree: rows => rows } }, { window: { localStorage: communityStorage, sessionStorage: communityStorage } });
let loads = 0, finish;
const load = () => { loads++; return new Promise(resolve => { finish = resolve; }); };
const prefetch = community.deduplicateRequest('req_A_feed_public_ALL_p0', load);
const mount = community.deduplicateRequest('req_A_feed_public_ALL_p0', load);
assert.equal(prefetch, mount); assert.equal(loads, 1);
finish({ posts: [], page: 0, hasMore: false }); await prefetch;
community.setCachedFeed('A', 'feed_public_ALL', { posts: [], page: 0, hasMore: false });
assert.ok(community.getCachedFeed('A', 'feed_public_ALL')); assert.equal(community.getCachedFeed('B', 'feed_public_ALL'), null);
const late = community.deduplicateRequest('req_A_feed_public_ALL_p0', load); community.clearCommunityUserCache();
finish({ posts: ['late-A'] }); await assert.rejects(late, /cancelled/); assert.equal(community.getCachedFeed('A', 'feed_public_ALL'), null);
// Actual board resource: dedupe, timestamp reconciliation, bounded snapshot and no late A cache after logout.
const boardCore = evaluate('lib/leaderboard-snapshots.ts'); const snapshot = boardCore.createBoardSnapshots(); const key = ['board', 'A'];
snapshot.accept(key, { items: ['new-rank'], updatedAt: '2026-10-03T12:00:05Z' }, 100);
assert.deepEqual([...snapshot.accept(key, { items: ['old-rank'], updatedAt: '2026-10-03T12:00:01Z' }, 101).items], ['new-rank']);
assert.ok(snapshot.read(key, 150)); assert.equal(snapshot.read(key, 30101), undefined);
const boards = evaluate('services/leaderboardSnapshots.ts', { '../lib/leaderboard-snapshots': boardCore, '../lib/module-entry-core': core, './leaderboardApi': {}, swr: { mutate() {} } });
loads = 0;
const boardA = boards.fetchBoardSnapshot(key, load), boardMount = boards.fetchBoardSnapshot(key, load);
await Promise.resolve(); assert.equal(loads, 1); finish({ items: ['A'], updatedAt: '2026-10-03T12:00:05Z' }); await Promise.all([boardA, boardMount]);
assert.ok(boards.readBoardSnapshot(key));
const lateBoard = boards.fetchBoardSnapshot(key, load); await Promise.resolve(); boards.clearBoardSnapshots();
finish({ items: ['lateA'], updatedAt: '2026-10-03T12:00:06Z' }); await assert.rejects(lateBoard); assert.equal(boards.readBoardSnapshot(key), undefined);
// Strict SYSTEM metadata snapshot validation: no private saved/reaction fields, version/date/corruption handling.
const content = evaluate('lib/content-system-snapshots.ts', {}, { window: { localStorage: storage } });
const card = { id: 1, title: 'News', source: 'BBC', url: 'https://example.com' };
assert.ok(content.validContentCards('/content/feed', [card]));
assert.equal(content.validContentCards('/content/feed', [{ ...card, savedByMe: true }]), false);
assert.equal(content.validContentCards('/content/reading/1', card), false);
content.saveContentSnapshot('/content/feed', [card]); assert.ok(content.readContentSnapshots());
for (const raw of ['{', JSON.stringify({ version: 99, date: content.todayContentDate(), cachedAt: Date.now(), data: { '/content/feed': [card] } }), JSON.stringify({ version: 1, date: '2000-01-01', cachedAt: Date.now(), data: {} })]) {
  storage.setItem(content.CONTENT_SYSTEM_CACHE_KEY, raw); assert.equal(content.readContentSnapshots(), undefined);
}
assert.equal(content.readContentSnapshots({ getItem() { throw Error('denied'); } }), undefined);
// Actual guards render authentication requirement on protected navigation/back; stale local aliases grant nothing.
const guard = evaluate('components/common/AuthGuard.tsx', { react: React, 'next-auth/react': { useSession: () => ({ data: null, status: 'unauthenticated' }) },
  'lucide-react': { Loader2: () => null }, './AuthRequired': { AuthRequired: () => React.createElement('div', null, 'authentication-required') },
  '@/context/LanguageContext': { useLanguage: () => ({ locale: 'en' }) } }, { window: {}, localStorage: { getItem: () => 'old-A' } });
const html = renderToString(React.createElement(guard.AuthGuard, null, 'private-A'));
assert.ok(html.includes('authentication-required') && !html.includes('private-A'));
assert.ok(read('app/community/page.tsx').includes('<AuthGuard>'));
assert.ok(read('components/layout/WorkspaceTabs.tsx').includes('<AuthGuard><main'));
assert.ok(read('components/landing/LandingHero.tsx').includes('Bắt đầu học thử miễn phí'));
console.log('Auth/social behavior: PASS — cookie-only API session (no page-held token, signed server calls, refresh route), revoke success/failure, cookie chunk expiry, late session fallback, guarded private routes, avatar first paint/revocation, Community dedupe/isolation, leaderboard race/TTL/purge, SYSTEM content validation.');
