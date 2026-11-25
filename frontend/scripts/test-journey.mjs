// Contract for the Echo Cinematic Journey (owner brief 2026-10-31, 10 §BK).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', 'src');
const pub = path.resolve(here, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const ok = (name) => console.log(`  -> PASS: ${name}`);

const store = read('lib/journey/journey.ts');
const host = read('components/journey/JourneyHost.tsx');
const bridge = read('components/journey/bridgeEngine.ts');
const css = read('components/journey/journey.module.css');
const providers = read('app/providers.tsx');
const layout = read('app/layout.tsx');
const landing = read('components/landing/ocean/oceanEngine.ts');
const auth = read('components/auth/ocean/authOceanEngine.ts');

// 1. The default bundle: no three.js in what every page loads; the bridge is its own chunk, and the workspace warms nothing.
assert.ok(!/from 'three'|from "three"/.test(store) && !/from 'three'/.test(host), 'the store and the host never import three.js');
assert.ok(!/^import [^t].*bridgeEngine/m.test(host) && /import type \{[^}]*\} from '\.\/bridgeEngine'/.test(host) && host.includes("import('./bridgeEngine')"), 'the bridge is a dynamic import; only its types are imported statically');
assert.ok(host.includes("scene === 'workspace'") && /if \(scene === 'workspace' \|\| media/.test(host), 'nothing is warmed on a workspace route');
assert.ok(providers.includes('<JourneyHost />') && providers.indexOf('<JourneyHost />') < providers.indexOf('ending && !held ?'), 'the host sits above the account key and the sign-out switch, so it survives them');
ok('default bundle: no graphics until a journey needs them');

// 2. Client only: no request but the whale model, and no AI.
for (const [name, src] of [['bridge', bridge], ['store', store], ['host', host]]) {
  assert.ok(!/\bfetch\(|axios|apiClient|\/api\//.test(src), `${name} makes no request of its own`);
}
assert.ok(bridge.includes('ECHO_MODEL_URL') && bridge.includes('loadWhaleRig'), 'the bridge carries the real, content-hashed model');
ok('client only: no server work, no request');

// 3. One whale: the tail beat, height, size and speed cross the passage; a scene never places Echo on its own during a journey.
assert.ok(/swimTime\(\)/.test(read('components/landing/ocean/whaleRig.ts')) && /setSwimTime\(/.test(read('components/landing/ocean/whaleRig.ts')), 'the rig exposes the swim clip time');
for (const [name, src] of [['landing', landing], ['auth', auth]]) {
  assert.ok(src.includes('setSwimTime(carry.tail)') && /swimTime\(\)/.test(src), `${name}: the same tail beat carries on`);
  assert.ok(src.includes('awaitArrival()') && /if \(reducedMotion \|\| !awaiting\) return;/.test(src), `${name}: Echo waits out of sight and arrive is a no-op where nothing waits`);
  assert.ok(/h00|h10|h01|h11/.test(src), `${name}: exits and entrances are Hermite paths from the body's real velocity (no teleport, no restart)`);
}
assert.ok(store.includes('crossingOf') && host.includes('crossingOf(vw, vh)'), 'source and destination use the same crossing');
assert.ok(store.includes('directionOf') && /RANK\[dest\] >= RANK\[from\] \? 1 : -1/.test(store), 'direction comes from the places, not from history');
ok('one whale: momentum, height, size and tail beat cross the passage');

// 4. Never stuck: a bound on the wait, a real link, a watchdog, a back-forward cache reset, a boot curtain that clears itself.
for (const s of ['SAY_AFTER_MS', 'LINK_AFTER_MS', 'GIVE_UP_MS', 'window.location.assign(to)', 'finish(id)', "addEventListener('pageshow'"]) assert.ok(host.includes(s), s);
assert.ok(/\.host \{[^}]*pointer-events: none;[^}]*display: none;/s.test(css) && css.includes('.host[data-active] { display: block; }'), 'the host is not displayed and takes no pointer at rest');
assert.ok(css.includes('.host[data-blocking] { pointer-events: auto; }') && /blocking: false/.test(host), 'it takes clicks only while the window is covered');
assert.ok(read('app/globals.css').includes('animation: ec-journey-boot-out 400ms ease 9s forwards'), 'the first-paint curtain clears itself even if the app never runs');
assert.ok(!/Math\.round\(.*progress|%<\/|percent/i.test(host), 'no invented progress number');
ok('never stuck: bounded, recoverable, clears itself');

// 5. Honest about the session: success-only, the guest hold never covers another account, and tokens hold no secret.
const login = read('components/auth/LoginForm.tsx');
assert.ok(login.indexOf('journeyGo(safeCallbackUrl)') > login.indexOf('} else if (res.ok) {'), 'the sign-in journey starts only after the server confirmed the session');
assert.ok(/held && shown\.current === 'guest'/.test(providers), 'only a guest view may be held');
assert.ok(host.includes("from === 'auth' && dest !== 'auth'"), 'the hold exists only for a sign-in leaving the sign-in page');
assert.ok(/JSON\.stringify\(\{ kind, at: Date\.now\(\) \}\)/.test(store), 'the token is a kind and a time, nothing else');
const boot = layout.match(/const JOURNEY_BOOT = '(.*)'/)[1];
assert.ok(boot.includes('sessionStorage.getItem(`ec_journey`)') && !/token|email|callback/i.test(boot), 'the boot script reads only the kind and the time');
for (const name of ['JOURNEY_BOOT', 'APPEARANCE_BOOT']) {
  const source = layout.match(new RegExp(`const ${name} = '(.*)'`))[1];
  assert.ok(!/[<>&"']/.test(source), `${name} survives as script text unchanged`);
  new Function(source);
}
assert.ok(/<script id="ec-appearance" nonce=\{nonce\}/.test(layout) && /<script id="ec-journey" nonce=\{nonce\}/.test(layout) && !layout.includes("from 'next/script'"), 'both boots run before the first paint, with the response nonce (next/script queues them after it)');
assert.ok(read('app/login/page.tsx').includes('!journeyActive()'), 'the authenticated redirect leaves the navigation to a running journey');
assert.ok(read('services/logout.ts').includes("writeJourneyToken('signout')"), 'without a passage, sign-out still opens the Landing on the same water');
assert.ok(!/bg-white|className="p-8 text-center">Đang đăng xuất/.test(providers), 'the white signing-out page is gone');
// Sign-out goes through the one passage: words only for screen readers, the session ended behind the cover, the guest's tree only on the destination.
const logoutSrc = read('services/logout.ts');
assert.ok(/<span className="sr-only">Đang đăng xuất/.test(providers) && !/\.leaving \{[^}]*color:/s.test(css), 'no words on screen, ever; the status is for screen readers');
assert.ok(/ending && !held \?/.test(providers), 'the page stays until the current covers it; requests already stopped');
assert.ok(logoutSrc.indexOf('journeySignOut(callbackUrl)') < logoutSrc.indexOf('terminateSession({') && /beginLogout\(\); if \(!passage\) clearUserScopedCaches\(\)/.test(logoutSrc), 'the passage starts in the frame of the press; requests stop at once; caches are emptied only once covered');
assert.ok(/finally \{\s*await covered\(\);/.test(logoutSrc), 'revocation does not wait for the animation; only the local teardown waits for the cover');
assert.ok(host.includes('signOut.covered()') && /signOut && movedAt === null\) endLogout\(\)/.test(host), 'the guest tree mounts only after the route left the protected page');
assert.ok(host.includes('SIGN_OUT_LIMIT_MS') && host.includes("window.location.replace(to)"), 'a stuck sign-out ends in a real load of the destination, never back on the account page');
assert.ok(bridge.includes('departEcho(') && bridge.includes('releaseEcho(') && host.includes('bridge.releaseEcho(carry'), 'one whale: from the companion to the edge, and out of the current before the next scene brings it in');
assert.ok(host.includes('journeyHeapDirty()') && host.includes("writeJourneyToken('fresh')") && /markJourneyHeapDirty\(\)/.test(host), 'after a sign-out without a page load the Workspace is entered only by a real load');
assert.ok(host.includes('registerJourneyWarm') && read('components/layout/AccountMenu.tsx').includes('journeyWarmSignOut()') && !read('components/layout/Sidebar.tsx').includes('logout('), 'the passage is warmed on the intent to sign out, never by itself on a workspace route');
assert.ok(read('lib/auth-cache-cleanup.ts').includes('sessionStorage.setItem("ec_journey"'), 'the account cleanup that follows sign-out keeps the token (a kind and a time, no account data)');
ok('session honesty: success only, no account view held, no secret in the token');

// 6. The first paint of the sign-in pages is a real frame of the sea, and only that.
const scene = read('components/auth/AuthScene.tsx');
const stills = read('lib/journey/stills.ts');
const authCss = read('components/auth/authGlass.module.css');
assert.ok(!/s\.clouds|s\.land|s\.ocean|s\.sky|s\.sun\b|s\.nearWave/.test(scene), 'the former drawn world is gone');
const inList = [...stills.matchAll(/'\/journey\/(auth-[a-z-]+-[0-9a-f]{8}\.webp)'/g)].map((m) => m[1]).sort();
const inCss = [...authCss.matchAll(/url\('\/journey\/(auth-[a-z-]+-[0-9a-f]{8}\.webp)'\)/g)].map((m) => m[1]).sort();
assert.equal(inList.length, 8, 'four skies, two lenses');
assert.deepEqual(inList, inCss, 'the warm-up list and the stylesheet name the same pictures');
for (const file of inList) assert.ok(fs.existsSync(path.join(pub, 'journey', file)), `${file} exists`);
assert.ok(authCss.includes("(max-aspect-ratio: 95/100), (max-width: 899.98px)") && auth.includes('aspect < 0.95 || width < 900') && stills.includes('< 0.95 || width < 900'), 'the picture follows the engine\'s own lens rule');
assert.ok(authCss.includes(".shell[data-ocean^='off-'] .echo { display: block; }"), 'the still Echo appears only where WebGL cannot run');
ok('first paint: one sea, real frames, one rule');

// 7. The owner's right-edge defect stays fixed; the headline is real Quicksand text.
const ripple = read('components/landing/ocean/WordRipple.tsx');
assert.ok(/ctx\.setTransform\(1, 0, 0, 1, 0, 0\);\s*ctx\.clearRect\(0, 0, canvas\.width, canvas\.height\);\s*ctx\.setTransform\(dpr, 0, 0, dpr, 0, 0\);/.test(ripple), 'the ripple clears in backing-store pixels at every browser zoom');
const hero = read('components/landing/LandingHero.tsx');
const landingCss = read('components/landing/landing.module.css');
assert.ok(!/Plus_Jakarta_Sans|font-hero/.test(hero + landingCss), 'no second typeface on the hero');
assert.ok(/\.heroTitle \{[^}]*font-family: var\(--font-quicksand\)/s.test(landingCss), 'the title is Quicksand');
assert.ok(hero.includes('<span className={styles.flow}>Hành trình tiếng Anh</span>') && (hero.match(/Hành trình tiếng Anh/g) || []).length === 1, 'one real text, no copy of the glyphs');
assert.ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.flow,[\s\S]*animation: none/.test(landingCss) && landingCss.includes('forced-colors: active') && hero.includes('IntersectionObserver'), 'stills under reduced motion, readable in forced colours, stops off screen');
assert.ok(!/(Sparkles|✨)/.test(host + bridge + css), 'no sparkle');
ok('landing: clear at every zoom, Quicksand, flowing real text');

// 8. No temporary QA page ships.
assert.ok(!fs.existsSync(path.join(root, 'app/login/qa-still')), 'the temporary still page is gone');
ok('no QA page in the build');

console.log('\nALL JOURNEY CONTRACTS PASSED');
