// Contract for the Echo Glass sign-in pages, top bar, account menu and header music player (2026-10-22, 10 §AN).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const ok = (name) => console.log(`  -> PASS: ${name}`);

// 1. Music player: the round cover is the one fold control; no separate minimise button; folding never touches the engine.
const player = read('components/music/CompactMusicPlayer.tsx');
assert.ok(player.includes('data-testid="music-compact-toggle"') && player.includes('aria-expanded={expanded}'), 'the cover is a real toggle button');
assert.ok(!/Minimize2|music-compact-minimize|Thu nhỏ/.test(player), 'no separate minimise control');
assert.ok(player.includes('data-testid="music-compact-close"') && player.includes('engine?.dismiss()'), 'close (stop + hide) is kept as its own action');
const toggleBody = player.slice(player.indexOf('const toggle = () => {'), player.indexOf('const close = () => {'));
assert.ok(toggleBody && !/engine/.test(toggleBody), 'folding never calls the audio engine');
assert.equal((player.match(/inert=\{!expanded\}/g) || []).length, 3, 'every folded part is inert');
const playerCss = read('components/music/CompactMusicPlayer.module.css');
assert.ok(!/position:\s*fixed|position:\s*sticky/.test(playerCss), 'never fixed or sticky (the phone strip is absolute inside the header row)');
ok('music player: one circle opens and closes it; playback untouched');

// 2. Top bar + account menu: same controls and destinations, raised glass, no backdrop blur, the real shortcut only.
const topbar = read('components/layout/TopNavbar.tsx');
for (const s of ['<GlobalDictionarySearch', '<CompactMusicPlayer />', 'toggleTheme', 'NotificationPopover', 'href="/premium"', '<AccountMenu', 'useUnifiedStreak']) assert.ok(topbar.includes(s), s);
const dictionary = read('components/features/dictionary/GlobalDictionarySearch.tsx');
assert.ok(topbar.includes('Ctrl K') && /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key\.toLowerCase\(\) === 'k'/.test(dictionary), 'the Ctrl K hint matches the dialog shortcut');
const shell = read('components/layout/WorkspaceShell.module.css');
const bar = shell.slice(shell.indexOf('/* ─── Top bar'), shell.indexOf('/* ─── Hình nền'));
assert.ok(!/backdrop-filter/.test(bar), 'the top bar draws no backdrop blur (wallpaper rule)');
assert.ok(bar.includes('.raised') && bar.includes('var(--gx-shadow)'), 'raised glass objects');
const menu = read('components/layout/AccountMenu.tsx');
assert.equal((menu.match(/<(Link|button) role="menuitem"/g) || []).length, 3, 'exactly the three real menu actions');
assert.ok(menu.includes('href="/profile"') && menu.includes('href="/progress"') && menu.includes('void logout()'), 'profile, progress, the real logout');
ok('top bar + account menu: same actions, glass presentation');

// 3. Sign-in pages: real flows, no invented controls, Echo is the real model still.
const login = read('components/auth/LoginForm.tsx'), register = read('components/auth/RegisterForm.tsx'), authShell = read('components/auth/AuthShell.tsx');
assert.ok(login.includes("signIn('credentials'") && login.includes("signIn('google'") && login.includes('<TurnstileChallenge'), 'login keeps credentials, Google and Turnstile');
assert.ok(register.includes("fetch('/api/v1/auth/register'") && register.includes('<TurnstileChallenge') && register.includes('isMinLength = codePoints >= 15'), 'register keeps its request, Turnstile and policy');
assert.ok(!/remember|Ghi nhớ/i.test(login), 'no invented remember-me control');
assert.ok(!/setLocale|Toggle language/.test(authShell), 'no language switcher on the sign-in pages');
const authSources = ['components/auth/AuthShell.tsx', 'components/auth/AuthScene.tsx', 'components/auth/LoginForm.tsx', 'components/auth/RegisterForm.tsx', 'components/auth/AuthEchoMascot.tsx'].map(read).join('\n');
assert.ok(!/✨|Sparkles|protected by cloudflare/i.test(authSources), 'no sparkle icons or Cloudflare marketing text');
assert.ok(!/hàng ngàn|thousands of|\d+\s*(k|\+)\s*(học viên|learners)/i.test(authSources), 'no invented user counts');
const scene = read('components/auth/AuthScene.tsx');
for (const m of scene.matchAll(/'\/assets\/(echo-auth-[a-z]+-[0-9a-f]{8}\.webp)'/g)) assert.ok(fs.existsSync(path.join(root, '..', 'public', 'assets', m[1])), m[1]);
assert.ok(scene.includes('aria-hidden="true"'), 'the scene is decoration');
const authCss = read('components/auth/authGlass.module.css');
assert.ok(!/backdrop-filter/.test(authCss), 'no backdrop blur over the moving sea');
assert.ok(/prefers-reduced-motion: reduce/.test(authCss), 'reduced motion stills the scene');
assert.ok(!read('components/auth/TurnstileChallenge.tsx').includes('authGlass'), 'Turnstile component untouched by the re-skin');
ok('sign-in pages: real flows, honest copy, real Echo');

console.log('\nALL ECHO GLASS AUTH / HEADER / PLAYER CONTRACTS PASSED');
