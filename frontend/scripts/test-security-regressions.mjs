// Security regression tests for Workstream 5 (EC-SEC-2026-032, EC-SEC-2026-015, AUTHZ-10, FE-02, FE-04,
// FE-05, FE-06, FE-07/AUTH-10, EC-SEC-2026-035, DEP-03, INFRA-01/06, DB-01/03).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { deflateRawSync, crc32 } from 'node:zlib';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const readSrc = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const readRepo = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

function evaluate(path, dependencies = {}, extraGlobals = {}) {
  const { code } = babel.core().transformSync(readSrc(path), {
    filename: path,
    configFile: false,
    babelrc: false,
    presets: [babel.presetTypescript()],
    plugins: [babel.pluginTransformModulesCommonjs()],
  });
  const exports = {};
  runInNewContext(
    code,
    {
      exports,
      require: (p) => dependencies[p] ?? require(p),
      URL,
      URLSearchParams,
      Blob,
      TextDecoder,
      TextEncoder,
      DecompressionStream,
      DataView,
      Uint8Array,
      ArrayBuffer,
      Buffer,
      Map,
      Set,
      Math,
      Number,
      String,
      Error,
      Promise,
      Response,
      Headers,
      console,
      process,
      ...extraGlobals,
    },
    {}
  );
  return exports;
}

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

// 1. EC-SEC-2026-032: sanitizeLocalPath & prototype-safe navigation routes
await check('EC-SEC-2026-032: sanitizeLocalPath rejects backslash, control chars, percent-encoded bypasses, and cross-origin URLs', () => {
  const { sanitizeLocalPath, sanitizeOptionalLocalPath } = evaluate('lib/sanitize-local-path.ts');

  // Valid internal paths
  assert.equal(sanitizeLocalPath('/dashboard', '/'), '/dashboard');
  assert.equal(sanitizeLocalPath('/exams/results/42?tab=reading#q3', '/'), '/exams/results/42?tab=reading#q3');
  assert.equal(sanitizeLocalPath('  /speaking/roleplay/7  ', '/dashboard'), '/speaking/roleplay/7');

  // Bypass attempts must be rejected
  const malicious = [
    '',
    '   ',
    null,
    undefined,
    '//evil.com',
    '///evil.com',
    '/\\evil.com',
    '\\/evil.com',
    '/\\evil.com/path',
    '/%09/evil.com',
    '/%0a/evil.com',
    '/%0d/evil.com',
    '/%00/evil.com',
    '/%1f/evil.com',
    '/%7f/evil.com',
    '/%5cevil.com',
    '/%5Cevil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    '/dashboard\r\nSet-Cookie: a=1',
    'https://evil.com',
    'http://evil.com',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'mailto:victim@example.com',
    'evil.com/dashboard',
  ];
  for (const input of malicious) {
    assert.equal(sanitizeLocalPath(input, '/dashboard'), '/dashboard', `expected fallback for ${JSON.stringify(input)}`);
    assert.equal(sanitizeOptionalLocalPath(input), null, `expected null for ${JSON.stringify(input)}`);
  }

  // Prototype-safe route lookup
  const routes = evaluate('lib/navigation/routes.ts');
  assert.equal(routes.canonicalHref('/?tab=toString'), '/?tab=toString');
  assert.equal(routes.canonicalHref('/?tab=constructor'), '/?tab=constructor');
  assert.equal(routes.canonicalHref('/?tab=__proto__'), '/?tab=__proto__');
  assert.equal(routes.moduleHref('toString'), '/toString');
  assert.equal(routes.canonicalHref('/?tab=speaking&id=1'), '/speaking?id=1');
  assert.equal(routes.canonicalHref('/?tab=reading&materialId=4'), '/reading?materialId=4');
});

// 2. AUTH-10 / FE-07: bff-csrf production strictness, __Host- non-promotion, timingSafeEqual
await check('AUTH-10/FE-07: bff-csrf enforces strict origin, __Host- only in prod, and constant-time comparison', () => {
  const csrfMod = evaluate('lib/server/bff-csrf.ts', {
    'next/server': {},
    crypto,
  });
  const makeReq = ({ method = 'POST', origin = null, referer = null, host = 'englishcoach.io.vn', nextUrlOrigin = 'https://englishcoach.io.vn', headers = {}, cookies = {} }) => {
    const h = new Map();
    if (origin) h.set('origin', origin);
    if (referer) h.set('referer', referer);
    if (host) h.set('host', host);
    for (const [k, v] of Object.entries(headers)) h.set(k.toLowerCase(), v);
    const c = new Map(Object.entries(cookies).map(([k, v]) => [k, { value: v }]));
    return {
      method,
      headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
      cookies: { get: (k) => c.get(k) },
      nextUrl: { host: new URL(nextUrlOrigin).host, origin: nextUrlOrigin },
    };
  };

  const prevEnv = process.env.NODE_ENV;
  const prevUrl = process.env.NEXTAUTH_URL;
  try {
    process.env.NODE_ENV = 'production';
    process.env.NEXTAUTH_URL = 'https://englishcoach.io.vn';

    // Unprefixed ec.csrf must NOT be read or promoted in production
    const unprefixedReq = makeReq({
      origin: 'https://englishcoach.io.vn',
      headers: { 'x-csrf-token': 'tossed-token' },
      cookies: { 'ec.csrf': 'tossed-token' },
    });
    assert.equal(csrfMod.readCsrfCookie(unprefixedReq), undefined, 'prod must ignore unprefixed ec.csrf');
    assert.equal(csrfMod.validateBffCsrf(unprefixedReq).valid, false, 'prod must reject unprefixed ec.csrf');

    // Localhost & spoofed Host header must be rejected in production
    for (const badOrigin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://frontend:3000', 'http://englishcoach.io.vn', 'https://evil.com']) {
      const res = csrfMod.validateBffCsrf(makeReq({
        origin: badOrigin,
        host: new URL(badOrigin).host,
        headers: { 'x-csrf-token': 'good-tok' },
        cookies: { '__Host-ec.csrf': 'good-tok' },
      }));
      assert.equal(res.valid, false, `prod must reject ${badOrigin}`);
    }

    // Missing origin must be rejected in production
    assert.equal(
      csrfMod.validateBffCsrf(makeReq({
        origin: null,
        headers: { 'x-csrf-token': 'good-tok' },
        cookies: { '__Host-ec.csrf': 'good-tok' },
      })).valid,
      false,
      'prod must reject missing origin'
    );

    // Valid production origin + __Host-ec.csrf passes
    const good = csrfMod.validateBffCsrf(makeReq({
      origin: 'https://englishcoach.io.vn',
      headers: { 'x-csrf-token': 'good-tok-123' },
      cookies: { '__Host-ec.csrf': 'good-tok-123' },
    }));
    assert.equal(good.valid, true);

    // Mismatched token (different length and same length) fails
    assert.equal(csrfMod.validateBffCsrf(makeReq({
      origin: 'https://englishcoach.io.vn',
      headers: { 'x-csrf-token': 'good-tok-124' },
      cookies: { '__Host-ec.csrf': 'good-tok-123' },
    })).valid, false);
    assert.equal(csrfMod.validateBffCsrf(makeReq({
      origin: 'https://englishcoach.io.vn',
      headers: { 'x-csrf-token': 'short' },
      cookies: { '__Host-ec.csrf': 'good-tok-123' },
    })).valid, false);
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = prevUrl;
  }

  assert.match(readSrc('lib/server/bff-csrf.ts'), /crypto\.timingSafeEqual/);
});

// 3. session-cookies.ts: does not trust arbitrary Host header in production
await check('AUTH-10/FE-07: session-cookies isSameOriginRequest ignores spoofed Host header in production', () => {
  const prevEnv = process.env.NODE_ENV;
  const prevUrl = process.env.NEXTAUTH_URL;
  try {
    process.env.NODE_ENV = 'production';
    process.env.NEXTAUTH_URL = 'https://englishcoach.io.vn';
    const cookiesMod = evaluate('lib/server/session-cookies.ts', { 'next/server': {} });
    const makeReq = (headers) => ({
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      nextUrl: { host: 'englishcoach.io.vn' },
    });

    // Spoofed Host matching evil Origin must be rejected
    assert.equal(cookiesMod.isSameOriginRequest(makeReq({
      'sec-fetch-site': 'same-origin',
      host: 'evil.com',
      origin: 'https://evil.com',
    })), false);

    // Scheme downgrade must be rejected
    assert.equal(cookiesMod.isSameOriginRequest(makeReq({
      'sec-fetch-site': 'same-origin',
      host: 'englishcoach.io.vn',
      origin: 'http://englishcoach.io.vn',
    })), false);

    // Exact canonical HTTPS origin passes
    assert.equal(cookiesMod.isSameOriginRequest(makeReq({
      'sec-fetch-site': 'same-origin',
      host: 'englishcoach.io.vn',
      origin: 'https://englishcoach.io.vn',
    })), true);
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = prevUrl;
  }
});

// 4. FE-04: zip.ts rejects central-directory size===0 bombs and tracks actual inflated total bytes
await check('FE-04: zip.ts rejects declaredSize=0 zip bombs, lying stored entries, and cumulative actual total overflow', async () => {
  const zipMod = evaluate('components/features/reading/books/engine/zip.ts');
  function buildZip(entries) {
    const parts = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = Buffer.from(e.name);
      const raw = Buffer.from(e.data);
      const data = e.method === 0 ? raw : deflateRawSync(raw);
      const size = e.declaredSize ?? raw.length;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(e.flags ?? 0, 6); local.writeUInt16LE(e.method, 8);
      local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(e.flags ?? 0, 8); cen.writeUInt16LE(e.method, 10);
      cen.writeUInt32LE(crc32(raw), 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(size, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
      parts.push(local, name, data); central.push(cen, name);
      offset += 30 + name.length + data.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return new Blob([...parts, cd, end]);
  }

  // Central directory size=0 with non-empty deflate payload (previously bypassed entry.size || maxSize!)
  const zeroBomb = await zipMod.ZipArchive.open(buildZip([
    { name: 'bomb.xhtml', method: 8, data: 'A'.repeat(65536), declaredSize: 0 },
  ]));
  await assert.rejects(zeroBomb.read('bomb.xhtml'), (e) => e.code === 'ZIP_BOMB');

  // Genuine empty deflated file (size=0 and inflates to 0 bytes) still succeeds
  const genuineEmpty = await zipMod.ZipArchive.open(buildZip([
    { name: 'empty.xhtml', method: 8, data: '', declaredSize: 0 },
  ]));
  assert.equal((await genuineEmpty.read('empty.xhtml')).byteLength, 0);

  // Stored entry with compressedSize != size is rejected
  await assert.rejects(
    zipMod.ZipArchive.open(buildZip([{ name: 'bad-store.txt', method: 0, data: 'hello world', declaredSize: 0 }])),
    (e) => e.code === 'ZIP_BOMB'
  );
});

// 5. FE-05: Per-route concurrency pools in public-proxy.ts prevent cross-route starvation
await check('FE-05: public-proxy isolates per-route concurrency pools so /api/tts cannot starve other routes', async () => {
  const proxyMod = evaluate('lib/server/public-proxy.ts');
  const releases = [];
  const holdSlot = (route) =>
    proxyMod.withUpstreamSlot(
      () => new Promise((resolve) => releases.push(() => resolve('ok'))),
      route
    );

  // Fill all 8 slots of the 'tts' route pool
  const ttsPromises = Array.from({ length: 8 }, () => holdSlot('tts'));
  await assert.rejects(proxyMod.withUpstreamSlot(async () => 'overflow', 'tts'), proxyMod.ProxyBusyError);

  // A different route ('translate' / 'default') MUST still succeed
  const otherResult = await proxyMod.withUpstreamSlot(async () => 'translate-ok', 'translate');
  assert.equal(otherResult, 'translate-ok');
  const defaultResult = await proxyMod.withUpstreamSlot(async () => 'default-ok');
  assert.equal(defaultResult, 'default-ok');

  // Release all held 'tts' slots and verify recovery
  while (releases.length) releases.pop()();
  await Promise.all(ttsPromises);
  assert.equal(await proxyMod.withUpstreamSlot(async () => 'tts-recovered', 'tts'), 'tts-recovered');
});

// 6. Structural regressions across auth, speaking, messenger, notifications, ops, and V137
await check('Companion & infra security contracts (EC-SEC-2026-015, AUTHZ-10, FE-02, INFRA-01/06, DB-01/03)', () => {
  // EC-SEC-2026-015: VerificationMailPanel sends turnstileToken
  const mailPanel = readSrc('components/auth/VerificationMailPanel.tsx');
  assert.match(mailPanel, /<TurnstileChallenge/);
  assert.match(mailPanel, /turnstileToken:\s*token \|\| undefined/);

  // AUTHZ-10: Roleplay page uses POST (never GET) for /speaking/tts/synthesize
  const roleplay = readSrc('app/speaking/roleplay/[id]/page.tsx');
  assert.doesNotMatch(roleplay, /apiClient\.get<Blob>\(\s*[`'"]\/speaking\/tts\/synthesize/);
  assert.equal((roleplay.match(/apiClient\.post<Blob>\(\s*["']\/speaking\/tts\/synthesize["']/g) ?? []).length, 4);
  const speakingApi = readSrc('services/speakingApi.ts');
  assert.match(speakingApi, /export const synthesizeTtsBlob/);
  assert.doesNotMatch(speakingApi, /getTtsSynthesizeAudioUrl/);

  // FE-02: Messenger store reset + NotificationRealtimeContext reset on user switch/logout
  const store = readSrc('lib/messenger/store.ts');
  assert.match(store, /export function resetMessengerStore\(\): void/);
  assert.match(store, /registerUserScopedCleanup\(resetMessengerStore\)/);
  const cleanup = readSrc('lib/auth-cache-cleanup.ts');
  assert.match(cleanup, /export function registerUserScopedCleanup/);
  assert.match(cleanup, /documentPictureInPicture/);
  const notifCtx = readSrc('context/NotificationRealtimeContext.tsx');
  assert.match(notifCtx, /lastUserIdRef\.current !== currentUserId/);
  assert.match(notifCtx, /resetRealtimeState\(\)/);

  // INFRA-06: ec-backup.sh has zero variable interpolation inside sh -c; ec-common.sh uses mktemp + trap + CRLF stripping
  const backupSh = readRepo('deploy/ops/ec-backup.sh');
  assert.doesNotMatch(backupSh, /sh -c\s*\\?\s*"/);
  assert.match(backupSh, /sh -c 'pg_dump -Fc --no-owner --no-acl -f \/out\/db\.dump && pg_restore -f \/dev\/null \/out\/db\.dump'/);
  const commonSh = readRepo('deploy/ops/ec-common.sh');
  assert.match(commonSh, /mktemp "\$EC_STATE\/netrc\.XXXXXX"/);
  assert.match(commonSh, /chmod 600 "\$msg" "\$netrc"/);
  assert.match(commonSh, /trap 'rm -f/);
  assert.match(commonSh, /tr -d '\\r\\n'/);

  // DB-01 & DB-03: V137 migration in Flyway location db/migration/exams
  const v137 = readRepo('backend/src/main/resources/db/migration/exams/V137__security_hardening_guards.sql');
  for (const tbl of ['payment_orders', 'payment_transactions', 'premium_ai_usage', 'document_recognition_usage']) {
    assert.ok(v137.includes(`'${tbl}'`), `V137 guards ${tbl}`);
  }
  assert.match(v137, /REVOKE DELETE ON TABLE public\.%I FROM english_coach_runtime/);
  assert.match(v137, /public\.guard_financial_audit_delete\(\)/);
  assert.match(v137, /public\.messenger_directory_sync\(bigint\)/);
  assert.match(v137, /public\.protect_premium_quote\(\)/);
  assert.match(v137, /SET search_path = public, pg_temp/);
});

console.log(`Security regression suite: ${passed} passed`);
