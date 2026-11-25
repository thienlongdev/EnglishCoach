// Verification script for Phase B.2 Streak Accuracy & UI Polish Contracts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');

console.log('--- Testing English Coach Phase B.2 Unified Streak & UI Polish Contracts ---');

// ─── 1. Profile Section Order Invariant ──────────────────────────────────────
console.log('1. Testing Profile Section Order Invariant...');

const profilePageSource = fs.readFileSync(path.join(frontendRoot, 'src/app/profile/page.tsx'), 'utf-8');

const headerCardIndex = profilePageSource.indexOf('Profile Header Card');
const heatmapCardIndex = profilePageSource.indexOf('<LearningHeatmapCard');
const personalInfoIndex = profilePageSource.indexOf('Thông tin cá nhân');
const accountInfoIndex = profilePageSource.indexOf('Thông tin tài khoản');
const securityIndex = profilePageSource.indexOf('Bảo mật & Mật khẩu');

assert.ok(headerCardIndex !== -1, 'Profile Header Card must exist');
assert.ok(heatmapCardIndex !== -1, 'LearningHeatmapCard must be mounted in profile/page.tsx');
assert.ok(personalInfoIndex !== -1, 'Personal Information section must exist');
assert.ok(accountInfoIndex !== -1, 'Account Information section must exist');
assert.ok(securityIndex !== -1, 'Security section must exist');

assert.ok(
  headerCardIndex < heatmapCardIndex,
  'LearningHeatmapCard must be placed AFTER Profile Header'
);
assert.ok(
  heatmapCardIndex < personalInfoIndex,
  'LearningHeatmapCard must be placed BEFORE Personal Information'
);
assert.ok(
  personalInfoIndex < accountInfoIndex,
  'Personal Information must be placed BEFORE Account Information'
);
assert.ok(
  accountInfoIndex < securityIndex,
  'Account Information must be placed BEFORE Security'
);

console.log('  -> PASS: Profile section order is verified: Header -> Heatmap -> Personal -> Account -> Security');

// ─── 2. TopNavbar Compact Streak Label Invariant ─────────────────────────────
console.log('2. Testing TopNavbar Compact Streak Label Invariants...');

const topNavbarSource = fs.readFileSync(path.join(frontendRoot, 'src/components/layout/TopNavbar.tsx'), 'utf-8');

assert.ok(topNavbarSource.includes('useUnifiedStreak'), 'TopNavbar must use useUnifiedStreak');
assert.ok(topNavbarSource.includes('currentStreak'), 'TopNavbar must reference currentStreak');

// Verify removal of verbose text in TopNavbar streak pill
assert.ok(
  !topNavbarSource.includes('ngày streak'),
  'TopNavbar must NOT render "ngày streak"'
);
assert.ok(
  !topNavbarSource.includes('-day streak'),
  'TopNavbar must NOT render "-day streak"'
);
assert.ok(
  !topNavbarSource.includes('days streak'),
  'TopNavbar must NOT render "days streak"'
);

// Verify compact dynamic rendering
assert.ok(
  topNavbarSource.includes('<span>{currentStreak}</span>'),
  'TopNavbar must dynamically render numeric streak in <span>{currentStreak}</span>'
);
assert.ok(
  topNavbarSource.includes('🔥'),
  'TopNavbar must render flame icon'
);

console.log('  -> PASS: TopNavbar streak pill renders compact "🔥 {currentStreak}" without verbose text');

// ─── 3. Unified Streak Hook & Contract Verification ──────────────────────────
console.log('3. Testing Unified Streak Hook Contract...');

const hookSource = fs.readFileSync(path.join(frontendRoot, 'src/hooks/useUnifiedStreak.ts'), 'utf-8');
assert.ok(hookSource.includes('/progress/streak'), 'useUnifiedStreak must call /progress/streak');
assert.ok(hookSource.includes('progressApi.getStreak'), 'useUnifiedStreak must use progressApi.getStreak');

const apiSource = fs.readFileSync(path.join(frontendRoot, 'src/services/progressApi.ts'), 'utf-8');
assert.ok(apiSource.includes('/progress/streak'), 'progressApi must define /progress/streak endpoint');
assert.ok(apiSource.includes('/progress/heatmap'), 'progressApi must define /progress/heatmap endpoint');
assert.ok(apiSource.includes('currentStreakDays: number;'), 'DTO must define currentStreakDays');
assert.ok(apiSource.includes('longestStreakDays: number;'), 'DTO must define longestStreakDays');
assert.ok(apiSource.includes('activeDaysThisYear: number;'), 'DTO must define activeDaysThisYear');
assert.ok(apiSource.includes('activitiesThisMonth: number;'), 'DTO must define activitiesThisMonth');

console.log('  -> PASS: Unified streak service contract and hook bindings verified');

// ─── 4. LearningHeatmapCard Invariants ────────────────────────────────────────
console.log('4. Testing LearningHeatmapCard Invariants...');

const heatmapCardSource = fs.readFileSync(path.join(frontendRoot, 'src/components/features/profile/LearningHeatmapCard.tsx'), 'utf-8');
assert.ok(heatmapCardSource.includes('Hoạt động học tập'), 'Card must have title "Hoạt động học tập"');
assert.ok(heatmapCardSource.includes('currentStreakDays'), 'Card must render currentStreakDays');
assert.ok(heatmapCardSource.includes('longestStreakDays'), 'Card must render longestStreakDays');
assert.ok(heatmapCardSource.includes('activeDaysThisYear'), 'Card must render activeDaysThisYear');
assert.ok(heatmapCardSource.includes('activitiesThisMonth'), 'Card must render activitiesThisMonth');
assert.ok(heatmapCardSource.includes('HEATMAP_THEMES'), 'Card must support 6 themes');
assert.ok(heatmapCardSource.includes('defaultEmptyDays'), 'Card must have fallback for 365 empty days');

console.log('  -> PASS: LearningHeatmapCard invariants verified');

console.log('\nALL PHASE B.2 FRONTEND CONTRACT TESTS PASSED SUCCESSFULLY!');
