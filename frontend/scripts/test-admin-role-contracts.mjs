// Single official admin + live role contracts (owner policy 2026-10-02). Static checks + pure helpers from format.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(srcRoot, ...p), 'utf-8');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  -> PASS: ${name}`);
}

console.log('=== Admin role contract tests ===\n');

test('no UI reads the login-time session role (stale after a role change); only the live hook decides', () => {
  const offenders = [];
  for (const f of walk(srcRoot)) {
    const rel = path.relative(srcRoot, f).replaceAll('\\', '/');
    if (rel === 'hooks/useCurrentRole.ts' || rel.startsWith('app/api/auth/')) continue;
    const s = fs.readFileSync(f, 'utf-8');
    if (/(session\?\.user as any\)\?\.role|session\?\.user\?\.role|user\??\.role === ['"]ROLE_ADMIN['"])/.test(s)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `stale role reads: ${offenders.join(', ')}`);
});

test('useCurrentRole reads GET /auth/me with a user-scoped key, revalidates on focus and at most once a minute', () => {
  const h = read('hooks', 'useCurrentRole.ts');
  assert.ok(h.includes("apiClient.get<AuthMe>('/auth/me')"));
  assert.ok(h.includes('[CURRENT_ROLE_CACHE_KEY_PREFIX, email]'), 'key carries the user identity (AGENTS §21.5)');
  assert.ok(h.includes('revalidateOnFocus: true') && h.includes('CURRENT_ROLE_REFRESH_MS = 60_000'));
  assert.ok(h.includes("isAdmin: role === 'ROLE_ADMIN'"));
  assert.ok(read('lib', 'auth-cache-cleanup.ts').includes('mutate(() => true, undefined'), 'account switch purges every SWR key');
});

test('every admin-aware surface uses the live hook', () => {
  for (const f of [
    ['components', 'layout', 'Sidebar.tsx'], ['components', 'layout', 'TopNavbar.tsx'], ['components', 'layout', 'NotificationPopover.tsx'],
    ['app', 'admin', 'community', 'page.tsx'], ['app', 'admin', 'notifications', 'page.tsx'], ['app', 'admin', 'premium', 'page.tsx'],
    ['app', 'community', 'page.tsx'], ['app', 'listening', 'page.tsx'], ['components', 'community', 'PostDetailModal.tsx'],
    ['components', 'features', 'reading', 'ReadingDashboard.tsx'], ['hooks', 'useFeedback.ts'],
  ]) assert.ok(read(...f).includes('useCurrentRole()'), f.join('/'));
  for (const f of [['app', 'admin', 'community', 'page.tsx'], ['app', 'admin', 'notifications', 'page.tsx'], ['app', 'admin', 'premium', 'page.tsx']])
    assert.ok(read(...f).includes('roleLoading'), `${f.join('/')} waits for the live role instead of flashing 403`);
});

test('Sidebar: "Quản lý Premium" only inside the admin section; learner navigation untouched', () => {
  const s = read('components', 'layout', 'Sidebar.tsx');
  const admin = s.slice(s.indexOf('{isAdmin && ('), s.indexOf('User Profile Bar'));
  assert.ok(admin.includes('href="/admin/premium"') && admin.includes('href="/admin/community"') && admin.includes('href="/admin/notifications"'));
  assert.equal(s.split('href="/admin/premium"').length - 1, 1, 'no Premium admin link outside the admin section');
});

test('Premium admin page: manual entitlement only (no payment wording), reason required, revoke only admin grants', () => {
  const p = read('app', 'admin', 'premium', 'page.tsx');
  assert.ok(p.includes('Quản lý Premium') && p.includes('Không tạo giao dịch thanh toán'));
  assert.ok(p.includes('disabled={busy || !reason.trim()}'), 'grant needs a reason');
  assert.ok(p.includes('!selected.adminGrantActive'), 'revoke only when an admin grant is active');
  assert.ok(!/Sparkles|✨/.test(p), 'no sparkle icon');
  const api = read('services', 'adminPremiumApi.ts');
  for (const u of ["'/admin/premium/users'", '`/admin/premium/users/${userId}`', '/grant`', '/revoke`']) assert.ok(api.includes(u), u);
  assert.ok(!/payment|sepay|transfer/i.test(api));
});

const f = await import(new URL('../src/lib/leaderboard/format.ts', import.meta.url).href);

test('Leaderboard: explicit exclusion reasons; a learner without placement is never called admin / test', () => {
  const me = (excludedReason) => ({ rank: null, points: 10, pointsToNextRank: null, eligibility: 'EXCLUDED', excludedReason });
  assert.equal(f.eligibilityNote(me('ADMIN')), 'Tài khoản quản trị không tham gia bảng xếp hạng. Điểm vẫn được ghi nhận.');
  assert.equal(f.eligibilityNote(me('EXCLUDED_TEST')), 'Tài khoản thử nghiệm không tham gia bảng xếp hạng. Điểm vẫn được ghi nhận.');
  assert.equal(f.eligibilityNote(me('INACTIVE')), 'Tài khoản chưa kích hoạt không tham gia bảng xếp hạng.');
  const learner = { rank: null, points: 0, pointsToNextRank: null, eligibility: 'PLACEMENT_REQUIRED', excludedReason: null };
  assert.ok(!f.eligibilityNote(learner).includes('quản trị') && !f.eligibilityNote(learner).includes('thử nghiệm'));
  assert.equal(f.showPlacementBanner(learner), true, 'normal learner without placement ⇒ quick placement CTA');
  assert.equal(f.showPlacementBanner(me('ADMIN')), false);
  for (const k of ['excludedAdminNote', 'excludedTestNote', 'excludedInactiveNote']) assert.ok(k in f.TEXT.en, `en ${k}`);
});

console.log(`\n=== ${passed} admin role contract tests PASSED ===`);
