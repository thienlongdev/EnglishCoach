// Echo Anywhere contracts (features/echo-anywhere): website entry points, honest install links, extension guards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const ext = path.join(here, '..', '..', 'extension', 'echo-anywhere');
const read = (p) => fs.readFileSync(path.join(src, p), 'utf8');
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };

// 1. Top bar: Help (?) → Echo Anywhere → Messages, exactly once
const nav = read('components/layout/TopNavbar.tsx');
const iHelp = nav.indexOf('data-guide="topbar-help"');
const iEcho = nav.indexOf('<EchoAnywhereEntry');
const iMsg = nav.indexOf('data-testid="topbar-messages"');
ok(iHelp > 0 && iEcho > iHelp && iMsg > iEcho, 'Echo Anywhere sits after Hướng dẫn and before Tin nhắn');
ok(nav.split('<EchoAnywhereEntry').length === 2, 'one top-bar entry');

// 2. Install links: never invented
const client = read('lib/echoAnywhere/client.ts');
const stores = /ECHO_ANYWHERE_STORES[^=]*=\s*\{([^}]*)\}/s.exec(client)?.[1] || '';
for (const m of stores.matchAll(/(chrome|edge):\s*([^,\n]+)/g)) {
  const v = m[2].trim();
  ok(v === 'null' || (m[1] === 'chrome' ? /^'https:\/\/chromewebstore\.google\.com\/detail\//.test(v) : /^'https:\/\/microsoftedge\.microsoft\.com\/addons\/detail\//.test(v)),
    `${m[1]} store link is null or a real listing URL`);
}
ok(/detectEchoAnywhere/.test(client) && /extension\/config/.test(client), 'installed state comes from the extension answering an allowed id');
const entry = read('components/echoAnywhere/EchoAnywhereEntry.tsx');
ok(/hintSeen\(\)/.test(entry) && /markHintSeen\(\)/.test(entry), 'the tip is shown once and remembered');
ok(/QUIET/.test(entry) && /exams/.test(entry), 'the tip never appears on exams');
ok(read('lib/auth-cache-cleanup.ts').includes('ec_echo_anywhere_hint:v1'), 'the dismissal survives sign-out');

// 3. Pages and routing
ok(fs.existsSync(path.join(src, 'app/echo-anywhere/page.tsx')) && fs.existsSync(path.join(src, 'app/echo-anywhere/connect/page.tsx')), 'public page and connect page exist');
ok(read('components/layout/ApplicationFrame.tsx').includes("pathname.startsWith('/echo-anywhere/')"), 'standalone route');
ok(read('lib/brand/pageTitle.ts').includes("'/echo-anywhere'"), 'tab title row');
const connect = read('app/echo-anywhere/connect/page.tsx');
ok(/allowedExtensionIds\(\)/.test(connect) && /ids\.includes\(ext\)/.test(connect), 'connect page hands codes only to allowed ids');
ok(!/localStorage|sessionStorage/.test(connect), 'the pairing code is never stored by the page');
const pageCopy = read('components/echoAnywhere/EchoAnywherePage.tsx') + read('components/echoAnywhere/InstallPanel.tsx');
ok(!/Install now|Cài ngay/i.test(pageCopy), 'no claim of immediate installation');
ok(!/<main[s>]/.test(pageCopy + connect), 'one main landmark: the standalone shell already renders <main>');

// 4. Extension guards
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.base.json'), 'utf8'));
ok(manifest.manifest_version === 3, 'Manifest V3');
ok(JSON.stringify(manifest.host_permissions) === JSON.stringify(['__SITE__/*']), 'only the English Coach origin is a required host permission');
ok(!manifest.permissions.includes('tabs') && !manifest.permissions.includes('history') && !manifest.permissions.includes('cookies') && !manifest.permissions.includes('webRequest'),
  'no tabs / history / cookies / webRequest permission');
ok(!manifest.content_scripts, 'no static content script on every site (injected on demand or for granted sites only)');
ok(/script-src 'self'/.test(manifest.content_security_policy.extension_pages), 'no remote code in extension pages');
const jsFiles = fs.readdirSync(path.join(ext, 'src')).filter((f) => f.endsWith('.js'));
for (const f of jsFiles) {
  const s = fs.readFileSync(path.join(ext, 'src', f), 'utf8');
  ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(/.test(s), `${f}: no markup sink or eval`);
  ok(!/https?:\/\/(?!englishcoach\.io\.vn)[a-z0-9.-]+\/[^'"`\s]*\.js/i.test(s), `${f}: no remote script`);
}
const bg = fs.readFileSync(path.join(ext, 'src', 'background.js'), 'utf8');
ok(/credentials: 'omit'/.test(bg), 'the extension never sends the website cookies');
ok(/excludeMatches: \[`\$\{SITE\}\/\*`/.test(bg), 'automatic script never runs on English Coach (exams, Sentinel)');
ok(/origin !== SITE/.test(bg), 'external messages only from the English Coach origin');
const content = fs.readFileSync(path.join(ext, 'src', 'content.js'), 'utf8');
ok(/const SHADOW_MODE = 'closed';/.test(content) && /attachShadow\(\{ mode: SHADOW_MODE \}\)/.test(content), 'page UI lives in a closed shadow root (only local test builds open it)');
ok(/\[type=password\]/.test(content), 'selections inside fields (passwords, messages being typed) are ignored');

// Distribution routing stays disabled until a real listing is public; no guessed link from the assigned ID.
const { browserKind, installDestination, internalReturnDelta } = await import(pathToFileURL(path.join(src, 'lib/echoAnywhere/client.ts')));
const origin = 'https://englishcoach.io.vn';
for (const ua of ['Chrome/157.0.0.0 Safari/537.36', 'Chrome/157.0.0.0 Brave/1.90', 'Chrome/120.0.0.0 coc_coc_browser/125.0']) {
  ok(browserKind(ua) === 'chrome', 'compatible desktop Chromium routes to Chrome store');
  ok(installDestination(browserKind(ua))?.url.endsWith('/gohhmbiobjnfnkagkklffajggkmgegod'), 'official published Chrome item');
}
ok(browserKind('Chrome/157.0.0.0 Edg/157.0') === 'edge', 'Edge keeps its store preference');
ok(installDestination('edge')?.url === installDestination('chrome')?.url, 'compatible Edge uses the published item');
ok(browserKind('Android Chrome/157.0 Mobile') === 'mobile', 'mobile never gets a desktop install route');
ok(browserKind('Chrome/115.0.0.0') === 'other' && browserKind('Version/19.0 Safari/605.1') === 'other', 'unsupported engine/version has no install claim');
const links = { chrome: 'https://chromewebstore.google.com/detail/verified-item', edge: null };
ok(installDestination('edge', links)?.store === 'chrome', 'Edge falls back to a public Chrome listing');
ok(installDestination('edge', { ...links, edge: 'https://microsoftedge.microsoft.com/addons/detail/verified-item' })?.store === 'edge', 'Edge listing takes precedence when available');
ok(installDestination('chrome', { chrome: null, edge: null }) === null && installDestination('mobile', links) === null, 'pending review and mobile never produce an install URL');
ok(internalReturnDelta([{ index: 0, url: origin + '/reading?book=4#paragraph-8' }, { index: 1, url: origin + '/echo-anywhere' }, { index: 2, url: origin + '/echo-anywhere#cai-dat' }], 2, origin) === -2, 'Back skips page anchors and returns to the full original history entry');
ok(internalReturnDelta([{ index: 0, url: 'https://external.example/' }], 1, origin) === null, 'Back never sends a learner to an external predecessor');
ok(internalReturnDelta([], 1, origin) === null, 'unknown history uses the safe session-aware fallback');

// Website release behavior: real numeric versions, publication gate and browser-local one-time preference.
const clientUrl = pathToFileURL(path.join(src, 'lib/echoAnywhere/client.ts')).href;
const releaseSource = stripTypeScriptTypes(read('lib/echoAnywhere/release.ts')).replace("'./client'", JSON.stringify(clientUrl));
const { ECHO_ANYWHERE_RELEASE: release, releaseVersionState, publishedReleaseAvailable } = await import(`data:text/javascript;base64,${Buffer.from(releaseSource).toString('base64')}`);
const { HINT_KEY, claimReleaseNotice, dismissReleaseNotice, hintSeen, markHintSeen, detectEchoAnywhere } = await import(clientUrl);
for (const [a, b, result] of [['1.0.0','1.0.1','older'], ['1.0.1','1.0.1','current'], ['1.0.1.0','1.0.1','current'], ['1.0.10','1.0.9','newer'], ['', '1.0.1','unknown'], ['1.bad','1.0.1','unknown']]) {
  ok(releaseVersionState(a, b) === result, `version ${a} vs ${b}: ${result}`);
}
ok(release.chromeWebStoreUrl === installDestination('chrome').url, 'release metadata reuses canonical store URL');
ok(!publishedReleaseAvailable({...release, status:'pending'}), 'pending review cannot be announced');
ok(!publishedReleaseAvailable({...release, publishedAt:'2099-01-01'}), 'future-dated release cannot be announced');
const pref = new Map();
globalThis.localStorage = { getItem: (key) => pref.get(key) ?? null, setItem: (key, value) => pref.set(key, value) };
pref.set(HINT_KEY, '1');
ok(hintSeen(), 'legacy tip preference remains valid');
ok(claimReleaseNotice('1.0.1'), 'legacy tip does not hide a newly published release');
ok(!claimReleaseNotice('1.0.1'), 'refresh/navigation cannot repeat an already displayed release');
dismissReleaseNotice('1.0.1'); markHintSeen();
ok(!claimReleaseNotice('1.0.1'), 'dismissal and tip writes preserve release history');
ok(claimReleaseNotice('1.0.2'), 'next published version can be announced once');
ok(hintSeen(), 'release notice suppresses the old introductory tip');
globalThis.localStorage = { getItem() { throw Error('denied'); } };
ok(!claimReleaseNotice('1.0.3'), 'storage denied: no repeated automatic announcement');
const notice = read('components/echoAnywhere/ReleaseAnnouncement.tsx');
ok(notice.includes("pathname !== '/dashboard'") && notice.includes('document.fullscreenElement'), 'announcement confined to ordinary Dashboard');
ok(!notice.includes('createPortal') && !notice.includes('fetch('), 'notice in flow, without server requests');
ok((read('components/echoAnywhere/InstallPanel.tsx').match(/>Cài Echo Anywhere<\/a>/g) || []).length === 1, 'product has exactly one store installation CTA');

// Simulate the existing external-message protocol, never infer installation from an absent reply.
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Chrome/157.0.0.0' } });
let reply = null;
globalThis.window = { chrome: { runtime: { sendMessage: (_id, _message, callback) => callback(reply) } } };
globalThis.fetch = async () => ({ ok: true, json: async () => ({extensionIds:['gohhmbiobjnfnkagkklffajggkmgegod']}) });
ok((await detectEchoAnywhere()).kind === 'not-detected', 'no reply is unknown installation, never installed');
reply = { installed: true, version: '1.0.0', connected: false };
ok((await detectEchoAnywhere()).connected === false, 'installed but disconnected remains distinct');
reply = { installed: true, version: '1.0.1', connected: true };
ok((await detectEchoAnywhere()).version === '1.0.1', 'version comes only from extension reply');
reply = { installed: 'yes', version: '1.0.1', connected: 'yes' };
ok((await detectEchoAnywhere()).kind === 'not-detected', 'malformed response cannot claim installed/connected');
console.log(`Echo Anywhere contracts: ${passed} passed`);
