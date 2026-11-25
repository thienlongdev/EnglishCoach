// Gói Premium "Echo Glass · Crown" + Dashboard streak flame / Echo swim + Learning Path hero sizing (owner brief
// 2026-10-22): presentation only — every price, plan, benefit, quota and action stays the page's / server's own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, 'src', p), 'utf8');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const page = read('app/premium/page.tsx');
const scene = read('components/features/premium/PremiumScene.tsx');
const css = read('components/features/premium/premiumGlass.module.css');
const bento = read('components/dashboard/DashboardBento.tsx');
const flame = read('components/dashboard/StreakFlame.tsx');
const hero = read('components/dashboard/DashboardHeroScene.tsx');
const dash = read('components/dashboard/dashboard.module.css');
const lp = read('components/features/learning-path/learningPath.module.css');
const ascent = read('components/features/learning-path/AscentScene.tsx');

test('Premium cards use the server catalog including during loading and errors', () => {
  assert.match(page, /const displayPlans = plans \?\? \[\]/);
  assert.doesNotMatch(page, /priceVnd:\s*\d+/);
  assert.match(page, /formatVnd\(plan.priceVnd\)/);
  assert.match(page, /getSavingsLabel\(plan.priceVnd, plan.durationMonths\)/);
  assert.match(page, /\{displayPlans\.map\(\(plan\) =>/, 'server order, no re-sorting');
});

test('Premium: checkout, renewal and entitlement refresh are the same handlers', () => {
  assert.match(page, /window\.location\.href = `\/login\?callbackUrl=\$\{encodeURIComponent\('\/premium'\)\}`/);
  assert.match(page, /const order = await paymentApi\.createPaymentOrder\(planCode\);\s*setCurrentOrder\(order\);/);
  assert.match(page, /onClick=\{\(\) => handleCtaClick\(plan\.code\)\}/);
  assert.match(page, /\{isPremium \? 'Gia hạn gói này' : 'Nâng cấp Premium'\}/);
  assert.match(page, /<PaymentCheckoutModal\s+order=\{currentOrder\}\s+onClose=\{\(\) => setCurrentOrder\(null\)\}\s+onSuccess=\{handlePaymentSuccess\}\s+onRenewOrder=\{handleRenewOrder\}/);
  assert.match(page, /await mutateEntitlement\(\);/);
});

test('Premium: plan status keeps its exact semantics; free counts are the server allowances', () => {
  assert.match(page, /\{isPremium && entitlement\?\.plan && \(/);
  assert.match(page, /entitlement\.daysRemaining > 0\s*\? `Còn lại \$\{entitlement\.daysRemaining\} ngày sử dụng`\s*: 'Gói hết hạn hôm nay'/);
  assert.match(page, /new Date\(entitlement\.expiresAt\)\.toLocaleDateString\('vi-VN'/);
  assert.match(page, /\{entitlement\.plan\.name\}/);
  assert.match(page, /const signedInFree = Boolean\(session\?\.user\) && Boolean\(entitlement\) && !isPremium;/);
  assert.match(page, /còn \{t\.a!\.remaining\}\/\{t\.a!\.limit\} \{POOL_LABEL\[t\.pool\]\}/);
});

test('Premium: AI quota rows are server values; the meter is remaining / limit only', () => {
  assert.match(page, /`Còn \$\{full\.premiumMonthlyRemaining\}\/\$\{feat\.premiumMonthlyLimit\} tháng này`/);
  assert.match(page, /`\$\{feat\.premiumMonthlyLimit\} lượt\/tháng`/);
  assert.match(page, /full\.premiumMonthlyRemaining! \/ feat\.premiumMonthlyLimit/);
  assert.match(page, /entitlement\?\.featureEntitlements\?\.filter\(\(f\) => f\.premiumRequired\)/);
});

test('Premium: no invented claims, no sparkles, decoration hidden from assistive tech', () => {
  for (const s of [page, scene]) {
    assert.doesNotMatch(s, /Sparkles|✨|dangerouslySetInnerHTML/);
    assert.doesNotMatch(s, /không giới hạn AI|AI không giới hạn|unlimited|học viên tin dùng|người dùng|ưu đãi|giảm giá|chỉ hôm nay|hôm nay duy nhất/i);
  }
  assert.doesNotMatch(page, /\d+[.,]?\d*\s*%\s*(người|học viên)/);
  assert.match(scene, /className=\{styles\.backdrop\} aria-hidden="true"/);
  assert.match(scene, /className=\{styles\.art\} aria-hidden="true"/);
  assert.match(scene, /className=\{styles\.calendar\} aria-hidden="true"/);
  assert.ok(!/font-family|backdrop-filter|!important/.test(css), 'no font-family / backdrop blur / !important');
  assert.match(css, /\.plan\[data-tone="royal"\] \{ --a:/, 'tone tokens declared on the element carrying data-tone');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.crown[\s\S]*animation: none;/);
});

test('Dashboard: the streak flame is its own layered flame, upright, from the real streak only', () => {
  assert.doesNotMatch(dash, /\.ring svg \{/, '.ring svg also caught the flame icon and laid it on its side');
  assert.match(dash, /\.ringArc \{ width: 100%; height: 100%; transform: rotate\(-90deg\); \}/);
  assert.match(bento, /<svg viewBox="0 0 44 44" className=\{styles\.ringArc\}>/);
  assert.match(bento, /<StreakFlame lit=\{currentStreakDays > 0\} \/>/);
  assert.match(bento, /const currentStreakDays = unifiedStreak\?\.currentStreakDays \?\? 0;/);
  assert.match(flame, /aria-hidden="true"/);
  assert.match(dash, /\.flame\[data-lit="false"\] :is\(\.flameGlow, \.flameOuter, \.flameMid, \.flameCore, \.flameRoot\) \{ animation: none; \}/);
  assert.match(dash, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.flameGlow, \.flameOuter, \.flameMid, \.flameCore, \.flameRoot, \.embers circle \{ animation: none; \}/);
});

test('Dashboard: Echo swims without a render loop or WebGL, and is still under reduced motion', () => {
  assert.match(hero, /className=\{styles\.echoTail\}/);
  assert.match(hero, /className=\{styles\.echoTrunk\}/);
  // 10 §Y: no WebGL or render loop in the workspace. Echo Ocean (2026-11-14) adds only a pre-rendered loop of the real rig,
  // fetched after the hero is visible and the page idle, muted, proven by its own clock, released on unmount.
  assert.doesNotMatch(hero, /requestAnimationFrame|WebGL|getContext|from ['"]three/);
  assert.match(hero, /<video ref=\{videoRef\}[^>]*\bmuted\b[^>]*\bloop\b[^>]*\bplaysInline\b[^>]*preload="none"/);
  assert.match(hero, /new IntersectionObserver/);
  assert.match(hero, /video\.muted = true;/);
  assert.match(hero, /prefers-reduced-motion: reduce\)"\)\.matches\) return false;/);
  assert.match(hero, /video\.removeAttribute\("src"\);\s*video\.load\(\);/);
  assert.match(dash, /\.echo\[data-live\] \.echoVideo \{ opacity: 1; \}/);
  assert.match(dash, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.echoVideo \{ display: none; \}/);
  assert.match(dash, /\.echoBody \{ position: relative; aspect-ratio: 640 \/ 400;[^}]*rotate: calc\(var\(--ty, 0\) \* 13deg\)/);
  assert.match(dash, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.echoSwim, \.echoBody img\.echoTail, \.echoTrunk[\s\S]*\.bubbles, \.echoWake, \.echoSpout, \.embers \{ display: none; \}/);
});

test('Learning Path: the hero art is sized by the hero height (never cropped from the top)', () => {
  assert.match(lp, /\.sceneSvg \{ position: absolute; right: 0; bottom: 0; height: 100%; width: auto; aspect-ratio: 1600 \/ 600; overflow: visible; \}/);
  assert.match(ascent, /d="M-1600 410 /, 'far ridge drawn west of the viewBox');
  assert.match(ascent, /d="M-1600 516 /, 'near ridge drawn west of the viewBox');
  assert.match(ascent, /\[\.\.\.STARS_WEST, \.\.\.STARS\]/);
});

console.log(`Premium glass / flame / Echo / Learning Path hero: ${passed} contract groups passed`);
