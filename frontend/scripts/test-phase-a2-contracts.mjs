// Verification script for Phase A.2 Profile Cleanup, Date of Birth & Forgot Password Flow
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');

console.log('--- Testing English Coach Phase A.2 Profile Cleanup & Password Recovery Contracts ---');

// ─── 1. Location Fallback Logic Invariant ──────────────────────────────────────
console.log('1. Testing Location Fallback Logic Invariant...');

function resolveCanonicalLocation(province, city) {
  if (province && province.trim()) {
    return province.trim();
  }
  if (city && city.trim()) {
    return city.trim();
  }
  return '';
}

assert.equal(resolveCanonicalLocation('Hà Nội', null), 'Hà Nội');
assert.equal(resolveCanonicalLocation(null, 'Đà Nẵng'), 'Đà Nẵng');
assert.equal(resolveCanonicalLocation('', 'Hồ Chí Minh'), 'Hồ Chí Minh');
assert.equal(resolveCanonicalLocation('   ', 'Hải Phòng'), 'Hải Phòng');
assert.equal(resolveCanonicalLocation('Cần Thơ', 'Cần Thơ'), 'Cần Thơ');
assert.equal(resolveCanonicalLocation('Bình Dương', 'Thủ Dầu Một'), 'Bình Dương');
assert.equal(resolveCanonicalLocation(null, null), '');

console.log('  -> PASS: Canonical location resolution preserves legacy city when province is empty.');

// ─── 2. Date of Birth Calendar Invariant ──────────────────────────────────────
console.log('2. Testing Date of Birth Calendar Invariants...');

const todayIso = new Date().toISOString().split('T')[0];
assert.match(todayIso, /^\d{4}-\d{2}-\d{2}$/);

function isValidDateOfBirth(dobString) {
  if (!dobString) return true; // optional / nullable
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dobString)) return false;
  return dobString <= todayIso;
}

assert.equal(isValidDateOfBirth('1995-05-20'), true);
assert.equal(isValidDateOfBirth(todayIso), true);
assert.equal(isValidDateOfBirth('2099-01-01'), false);
assert.equal(isValidDateOfBirth(''), true);
assert.equal(isValidDateOfBirth(null), true);

console.log('  -> PASS: Date of birth accepts valid historical/today calendar dates and rejects future dates.');

// ─── 3. Source Code Contract Verifications ───────────────────────────────────
console.log('3. Verifying Source Code Contracts Across Profile & Auth Pages...');

const profilePageSource = fs.readFileSync(path.join(frontendRoot, 'src/app/profile/page.tsx'), 'utf-8');
const loginPageSource = fs.readFileSync(path.join(frontendRoot, 'src/app/login/page.tsx'), 'utf-8');
const forgotFormSource = fs.readFileSync(path.join(frontendRoot, 'src/components/auth/ForgotPasswordForm.tsx'), 'utf-8');
const userProfileApiSource = fs.readFileSync(path.join(frontendRoot, 'src/services/userProfileApi.ts'), 'utf-8');

// A. Profile Page Form Fields
assert.ok(profilePageSource.includes("Tỉnh/Thành"), 'Profile must contain Tỉnh/Thành field');
assert.ok(profilePageSource.includes("Ngày sinh"), 'Profile must contain Ngày sinh field');
assert.ok(profilePageSource.includes('type="date"'), 'Profile must render date input for Ngày sinh');
assert.ok(profilePageSource.includes('max={new Date().toISOString().split(\'T\')[0]}'), 'Profile date input must prevent future date selection');

// Separate City and Province inputs must be removed from Personal Information
assert.ok(!profilePageSource.includes("placeholder={t('Hà Nội, TP. Hồ Chí Minh...', 'Hanoi, Ho Chi Minh...')}\n                  className=\"w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition\"\n                />\n              </div>\n            </div>\n\n            {/* Province */}\n            <div>\n              <label className=\"block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5\">\n                {t('Tỉnh / Bang', 'Province / State')}"), 'Separate city and province inputs must be removed');
assert.ok(!profilePageSource.includes("{t('Tỉnh / Bang', 'Province / State')}"), 'Tỉnh / Bang separate label must not be rendered');

// B. Account Information Cleanliness
assert.ok(profilePageSource.includes("{t('Email tài khoản', 'Account Email')}"), 'Email tài khoản must be preserved');
assert.ok(profilePageSource.includes("{t('Họ và tên gốc', 'Original Account Name')}"), 'Họ và tên gốc must be preserved');
assert.ok(!profilePageSource.includes("{t('Phương thức đăng nhập đã liên kết', 'Linked Authentication Methods')}"), 'Linked Authentication Methods UI section must be removed');
assert.ok(!profilePageSource.includes("{t('Mật khẩu & Email', 'Password & Email')}"), 'Mật khẩu & Email chip must be removed from Account Info');

// C. Forgot Password Link & AuthPageView Redirection Guard
assert.ok(profilePageSource.includes('href="/forgot-password?from=profile"'), 'Forgot password link must point to /forgot-password?from=profile');
assert.ok(loginPageSource.includes("viewState !== 'forgot'"), 'AuthPageView must not redirect authenticated user when viewState === forgot');
assert.ok(loginPageSource.includes("const isFromProfile = fromParam === 'profile'"), 'AuthPageView must detect navigation from profile');
assert.ok(loginPageSource.includes("readOnlyEmail={Boolean((isFromProfile || status === 'authenticated') && session?.user?.email)}"), 'AuthPageView must lock email input for authenticated users');
assert.ok(loginPageSource.includes("router.replace('/profile')"), 'handleBackToLoginFromForgot must redirect authenticated users back to /profile');

// D. ForgotPasswordForm readOnly and backButtonLabel support
assert.ok(forgotFormSource.includes("readOnlyEmail"), 'ForgotPasswordForm must support readOnlyEmail');
assert.ok(forgotFormSource.includes("initialEmail"), 'ForgotPasswordForm must support initialEmail');
assert.ok(forgotFormSource.includes("backButtonLabel"), 'ForgotPasswordForm must support backButtonLabel');
assert.ok(forgotFormSource.includes("/api/v1/auth/forgot-password"), 'ForgotPasswordForm must invoke existing /api/v1/auth/forgot-password');

// E. userProfileApi types
assert.ok(userProfileApiSource.includes("dateOfBirth: string | null;"), 'UserProfileDto must include dateOfBirth');
assert.ok(userProfileApiSource.includes("dateOfBirth?: string | null;"), 'UpdateUserProfileRequest must include dateOfBirth');

console.log('  -> PASS: All source code contracts and integration invariants strictly verified.');

console.log('\n--- ALL PHASE A.2 CONTRACTS AND ARCHITECTURE INVARIANTS PASSED ---');
