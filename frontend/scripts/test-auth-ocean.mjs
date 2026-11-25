// Contract for the living sign-in ocean + verification mail honesty (2026-10-23, 10 §AS).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const ok = (name) => console.log(`  -> PASS: ${name}`);

// 1. The ocean is decoration: no request but the model, no AI, no pointer capture, sleeps when hidden, cleans up.
const engine = read('components/auth/ocean/authOceanEngine.ts');
const host = read('components/auth/ocean/AuthOcean.tsx');
const shaders = read('components/auth/ocean/authOceanShaders.ts');
assert.ok(!/fetch\(|axios|apiClient|\/api\//.test(engine + host + shaders), 'the ocean makes no request of its own (the model loads through loadWhaleRig)');
assert.ok(engine.includes('ECHO_MODEL_URL') && engine.includes('loadWhaleRig'), 'Echo is the real, content-hashed landing model');
assert.ok(host.includes('aria-hidden="true"') && !/onClick=/.test(host), 'the canvas layer is aria-hidden and has no click handler of its own');
assert.ok(/closest\('a, button, input, label, select, textarea, iframe, \[data-purpose="auth-card"\]/.test(host), 'taps on the card, links and controls never reach the water');
assert.ok(engine.includes("document.addEventListener('visibilitychange'") && engine.includes('cancelAnimationFrame'), 'the loop sleeps in a hidden tab');
assert.ok(engine.includes('renderer.forceContextLoss()') && engine.includes('abort.abort()') && engine.includes("removeEventListener('pointermove'"), 'dispose releases the context, the download and every listener');
assert.ok(engine.includes('reducedMotion') && engine.includes('frame(performance.now(), true)'), 'reduced motion draws still frames only');
assert.ok(host.includes("getContext('webgl2')") && host.includes('saveData'), 'no WebGL 2 or Save-Data keeps the CSS world');
assert.ok(host.includes("import('./authOceanEngine')"), 'three.js loads in its own chunk after hydration (the form never waits)');
assert.ok(!/useState/.test(host), 'no React state per frame');
assert.ok(engine.includes("setCalm") && host.includes("'focusin'"), 'the camera holds still while the learner types');
assert.ok(/ecHorizonAt/.test(shaders) && (shaders.match(/ecSkyGradient\(/g) || []).length >= 3, 'water, land and sky share one horizon colour (no seam)');
ok('living ocean: decoration only, one horizon, lifecycle and fallbacks');

// 2. Turnstile: Cloudflare's own supported options, the real token flow untouched.
const ts = read('components/auth/TurnstileChallenge.tsx');
assert.ok(!ts.includes("theme: 'dark'"), 'no hard-coded dark widget on a light card');
assert.ok(/size = containerRef\.current\.clientWidth >= 300 \? 'flexible' : 'compact'/.test(ts), 'flexible width, compact when narrower than Cloudflare allows');
for (const s of ["'error-callback'", "'expired-callback'", "'timeout-callback'", 'turnstile.reset', 'onVerifyRef.current(token)']) assert.ok(ts.includes(s), s);
assert.ok(!/iframe|contentDocument|::part/.test(ts), 'never reaches into the challenge frame');
ok('turnstile: theme follows the page, verification unchanged');

// 3. Mail honesty: no "sent" without the server's answer, a real resend with a cooldown, no enumeration in copy.
const panel = read('components/auth/VerificationMailPanel.tsx');
const register = read('components/auth/RegisterForm.tsx');
const login = read('components/auth/LoginForm.tsx');
const nextauth = read('app/api/auth/[...nextauth]/route.ts');
assert.ok(register.includes("data?.delivery") && register.includes("answer === 'FAILED'"), 'registration shows what the mail provider answered');
assert.ok(!/Yêu cầu đã được tiếp nhận/.test(register), 'the old vague "request accepted" notice is gone');
assert.ok(panel.includes("fetch('/api/v1/auth/resend-verification'") && panel.includes('COOLDOWN_SECONDS') && panel.includes('res.status === 503'), 'resend is real, cooled down, and reports a failing provider');
assert.ok(/Nếu địa chỉ này có tài khoản/.test(panel), 'resend copy never says whether the address has an account');
assert.ok(nextauth.includes('EMAIL_VERIFICATION_REQUIRED') && /res\.status === 403/.test(nextauth), 'a pending account with the right password learns why, not "wrong password"');
assert.ok(login.includes('<VerificationMailPanel'), 'and can resend from the sign-in form');
ok('verification mail: honest states, real resend');

console.log('\nALL AUTH OCEAN + VERIFICATION MAIL CONTRACTS PASSED');
