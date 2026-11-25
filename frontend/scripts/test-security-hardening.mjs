// Security release 2026-10: build and edge contracts that must not silently regress.
// Static checks only (no network, no server): run with `npm run test:security`.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
};

const pkg = JSON.parse(read('../package.json'));
const lock = JSON.parse(read('../package-lock.json'));
const installed = (name) => lock.packages[`node_modules/${name}`]?.version;
const atLeast = (version, minimum) => {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
};

check('every dependency is pinned to an exact version (no "latest", no range)', () => {
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      assert.notEqual(range, 'latest', `${name} must not be "latest"`);
      // Exact means exact: "^1.2.3" and "~1.2.3" are ranges too (the earlier form of this check let them through).
      assert.match(String(range), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} is not an exact version: ${range}`);
      assert.equal(installed(name), range, `${name}: lockfile and manifest disagree`);
    }
  }
  for (const name of ['next', 'react', 'react-dom', 'next-auth', 'axios']) {
    assert.match(pkg.dependencies[name], /^\d+\.\d+\.\d+$/, `${name} must be an exact version`);
    assert.equal(installed(name), pkg.dependencies[name], `${name}: lockfile and manifest disagree`);
  }
});

check('build-only packages do not ship: the Tailwind / PostCSS toolchain and type packages are development dependencies', () => {
  for (const name of ['tailwindcss', 'postcss', 'autoprefixer', 'typescript']) {
    assert.ok(pkg.devDependencies?.[name], `${name} must be a devDependency`);
    assert.equal(pkg.dependencies?.[name], undefined, `${name} must not be a runtime dependency`);
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) assert.doesNotMatch(name, /^@types\//, `${name} is a type package`);
  // what `npm ci --omit=dev` leaves out of the runtime image, according to the lockfile
  for (const name of ['tailwindcss', 'braces', 'chokidar', 'micromatch', 'fast-glob', 'postcss-selector-parser']) {
    assert.equal(lock.packages[`node_modules/${name}`]?.dev, true, `${name} would be installed in the runtime image`);
  }
});

check('Next.js is past the 2026-09 / 2026-10 advisories (fixed in 16.3.8) and sharp past its two (fixed in 0.35.5)', () => {
  assert.ok(atLeast(installed('next'), '16.3.8'), `next ${installed('next')}`);
  assert.ok(atLeast(installed('sharp'), '0.35.5'), `sharp ${installed('sharp')}`);
  assert.ok(atLeast(installed('axios'), '1.20.0'), `axios ${installed('axios')}`);
  assert.equal(existsSync(new URL('../pnpm-lock.yaml', import.meta.url)), false,
    'stale frontend/pnpm-lock.yaml must not exist alongside package-lock.json');
});

check('production image: lockfile install, no development dependency, unprivileged user', () => {
  const dockerfile = read('../Dockerfile.prod');
  assert.match(dockerfile, /RUN npm ci /);
  assert.doesNotMatch(dockerfile, /RUN npm install\b/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm /, 'the package managers do not ship (runtime starts node directly)');
  assert.match(dockerfile, /CMD \["node", /);
  assert.doesNotMatch(dockerfile, /FROM node:20/);
  // the Turnstile guards of docs/AGENTS.md section 6 are still there
  assert.match(dockerfile, /Turnstile Production Build Guard/);
  assert.match(dockerfile, /Turnstile Post-Build Guard/);
});

check('build keeps the type gate and hides the framework banner', () => {
  const config = read('../next.config.ts');
  assert.doesNotMatch(config, /ignoreBuildErrors/);
  assert.match(config, /poweredByHeader:\s*false/);
});

check('anonymous lookup proxies: fixed upstream hosts, bounded time, size and concurrency', () => {
  const helper = read('../src/lib/server/public-proxy.ts');
  assert.match(helper, /AbortSignal\.timeout/);
  assert.match(helper, /MAX_CONCURRENT_UPSTREAM_CALLS/);
  assert.match(helper, /MAX_CONCURRENT_PER_ROUTE/);
  for (const route of ['translate', 'tts', 'dictionary']) {
    const source = read(`../src/app/api/${route}/route.ts`);
    assert.match(source, /withUpstreamSlot/, `${route}: no concurrency bound`);
    assert.match(source, /fetchUpstream\(/, `${route}: unbounded fetch`);
    assert.doesNotMatch(source, /await fetch\(/, `${route}: raw fetch`);
    assert.match(source, /readBounded(Json)?\(/, `${route}: unbounded body`);
    // the destination host never comes from the request
    for (const url of source.match(/https?:\/\/[^`'"\s]+/g) ?? []) {
      assert.match(url, /^https:\/\/(translate\.googleapis\.com|clients5\.google\.com|translate\.google\.com|api\.dictionaryapi\.dev)\//, url);
    }
  }
  const tts = read('../src/app/api/tts/route.ts');
  assert.match(tts, /contentType\.startsWith\('audio\/'\)/, 'tts validates upstream audio Content-Type');
  assert.match(read('../src/app/api/translate/route.ts'), /MAX_QUERY_CHARS/);
  assert.match(read('../src/app/api/dictionary/route.ts'), /REQUEST_BUDGET_MS/);
});

check('there is one path from the browser to the API: the token-forwarding proxy is gone', () => {
  const bff = read('../src/app/api/v1/[...path]/route.ts');
  // The file answers 404 to every method, in every environment, and forwards nothing.
  assert.match(bff, /status: 404/);
  assert.doesNotMatch(bff, /fetch\(|getToken|Authorization|BFF_PROXY_ENABLED|process\.env/);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.match(bff, new RegExp(`export const ${method} = notFound`));
});

check('API session: HttpOnly cookie only; no token or grant reaches, or rests in, page script', () => {
  const walk = dir => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(`${dir}${entry.name}/`) : /\.(ts|tsx)$/.test(entry.name) ? [`${dir}${entry.name}`] : []);
  const client = walk('../src/').filter(file => !file.includes('/app/api/') && !file.includes('/lib/server/'));
  assert.ok(client.length > 300, 'client sources found');
  const backendOrigin = read('../src/lib/server/backend-origin.ts');
  assert.doesNotMatch(backendOrigin, /APP_SECURITY_INTERNAL_SERVICE_KEY|NEXTAUTH_SECRET|crypto|cookies|internalAuthHeader/,
    'backend-origin.ts must stay strictly non-secret');
  for (const file of client) {
    const source = read(file);
    assert.doesNotMatch(source, /Authorization:\s*`Bearer|\(session as any\)\?\.(accessToken|id_token|sessionGrant)|setItem\(\s*['"](auth_token|ec_session_grant|sessionGrant)['"]/,
      `${file}: page code must not hold or send an application token`);
    const isClientModule = /^\s*['"]use client['"]\s*;?/m.test(source);
    const serverImports = [...source.matchAll(/from ['"](@\/lib\/server\/[^'"]+)['"]/g)].map(m => m[1]);
    for (const mod of serverImports) {
      assert.ok(!isClientModule && mod === '@/lib/server/backend-origin',
        `${file}: server-only module (${mod}) imported by page/client code`);
    }
  }
  const nextAuth = read('../src/app/api/auth/[...nextauth]/route.ts');
  const sessionCallback = nextAuth.slice(nextAuth.indexOf('async session('), nextAuth.indexOf('session: {'));
  assert.doesNotMatch(sessionCallback, /accessToken|sessionGrant|id_token/, '/api/auth/session exposes identity only');
  assert.doesNotMatch(nextAuth, /session\/exchange|sessionGrant: \{ label/, 'a raw grant is not a sign-in credential');
  const cookies = read('../src/lib/server/session-cookies.ts');
  assert.match(cookies, /"__Host-ec_at"/); assert.match(cookies, /httpOnly: true, secure: SECURE, sameSite: SECURE \? "strict"/);
  const refresh = read('../src/app/api/auth/refresh/route.ts');
  assert.match(refresh, /isSameOriginRequest\(request\)/); assert.match(refresh, /backendPostHeaders\(REFRESH_PATH/);
  assert.doesNotMatch(refresh, /accessToken: data|sessionGrant: data|json\(data/, 'the refresh answer carries no token');
  const client2 = read('../src/services/api-client.ts');
  assert.match(client2, /withCredentials: true/); assert.match(client2, /csrfHeaders\(/);
});

check('Card Blast solo: the result carries the run id the server issued', () => {
  const modal = read('../src/components/features/flashcard/card-blast/CardBlastModal.tsx');
  assert.match(modal, /\/flashcards\/card-blast\/start-run/);
  assert.match(modal, /runId,\s*\n\s*deckId/);
});

check('edge: version hidden, headers on, bodies scoped, lookups and account actions limited', () => {
  const nginx = read('../../deploy/nginx/default.conf');
  assert.match(nginx, /^server_tokens off;/m);
  assert.match(nginx, /add_header_inherit merge;/);
  for (const header of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy',
    'Permissions-Policy', 'Content-Security-Policy']) {
    assert.match(nginx, new RegExp(`add_header ${header} "[^"]+" always;`), header);
  }
  assert.match(nginx, /add_header Strict-Transport-Security "max-age=\d+" always;/, 'HSTS: this host only, no preload');
  assert.match(nginx, /microphone=\(self\)/);
  assert.doesNotMatch(nginx, /client_max_body_size 600M/i);
  assert.match(nginx, /client_max_body_size 40m;/);
  assert.match(nginx, /location = \/api\/v1\/flashcards\/upload-apkg \{[\s\S]*?client_max_body_size 500m;[\s\S]*?limit_conn apkg_site 2;/);
  assert.equal((nginx.match(/limit_req zone=public_proxy/g) ?? []).length, 4, 'three lookup proxies + the CSP report sink');
  assert.match(nginx, /limit_req zone=auth_actions/);
  // Only the separate Cloudflare allowlist can establish the client address; no caller-supplied chain passes on.
  assert.doesNotMatch(nginx, /proxy_add_x_forwarded_for/);
  assert.doesNotMatch(nginx, /real_ip_header|set_real_ip_from|CF-Connecting-IP/i);
  assert.match(nginx, /^include \/etc\/nginx\/cloudflare-realip\.conf;$/m);
  const realip = read('../../deploy/nginx/cloudflare-realip.conf');
  assert.match(realip, /^real_ip_header CF-Connecting-IP;$/m);
  assert.match(realip, /^real_ip_recursive off;$/m);
  assert.equal((realip.match(/^set_real_ip_from /gm) ?? []).length, 22);
  assert.doesNotMatch(realip, /^set_real_ip_from (?:0\.0\.0\.0\/0|::\/0|100\.64\.|127\.|172\.18\.)/m);
  const origin = read('../../deploy/ops/ec-origin-allowlist.sh');
  assert.match(origin, /DOCKER-USER/);
  assert.match(origin, /PREROUTING/);
  assert.match(origin, /ip6tables/);
  assert.match(origin, /english-coach-origin-enabled/);
  assert.equal((nginx.match(/proxy_set_header X-Real-IP \$remote_addr;/g) ?? []).length,
    (nginx.match(/proxy_pass /g) ?? []).length);
  assert.match(nginx, /"443|listen 443 ssl/);
});

check('script policy: per-request nonce with strict-dynamic, no eval anywhere, every page rendered per request', () => {
  const nginx = read('../../deploy/nginx/default.conf');
  assert.doesNotMatch(nginx, /'unsafe-eval'/, 'no eval in the edge policy (wasm-unsafe-eval is WebAssembly only)');
  assert.doesNotMatch(nginx, /Content-Security-Policy-Report-Only/);
  assert.match(nginx, /location = \/api\/csp-report \{[\s\S]*?limit_req zone=public_proxy[\s\S]*?client_max_body_size 16k;/);
  const proxy = read('../src/proxy.ts');
  assert.match(proxy, /script-src 'nonce-\$\{nonce\}' 'strict-dynamic'/);
  assert.match(proxy, /crypto\.randomUUID\(\)/, 'nonce from a CSPRNG, fresh per request');
  assert.match(proxy, /requestHeaders\.set\('Content-Security-Policy', policy\)/, 'Next.js reads the nonce from the request');
  assert.match(proxy, /process\.env\.NODE_ENV === 'production'\s*\?\s*buildPagePolicy\(nonce\)/, 'eval only in development');
  assert.doesNotMatch(proxy, /next-router-prefetch|value:\s*'prefetch'/, 'prefetch requests must not bypass per-request nonce CSP');
  const layout = read('../src/app/layout.tsx');
  assert.match(layout, /await connection\(\)/, 'pages are rendered per request (a static page would have no nonce)');
  assert.match(read('../src/components/features/games/echo-garden/EchoGardenCanvas.tsx'), /import "pixi\.js\/unsafe-eval";/,
    'the game renderer uses its eval-free build');
  const report = read('../src/app/api/csp-report/route.ts');
  assert.match(report, /MAX_BYTES = 8 \* 1024/);
  assert.doesNotMatch(report, /\['script-sample'\]|\.sample\b/, 'the script sample of a report is never read');
});

check('nothing developer-only or dead reaches production; credentials stay where they belong', () => {
  for (const dir of [
    '../src/app/landing-preview',
    '../src/app/speaking/shadowing/dev',
    '../src/app/ielts-cbt-preview',
    '../src/app/toeic-iig-preview',
  ]) {
    assert.match(read(`${dir}/layout.tsx`), /process\.env\.NODE_ENV === 'production'\) notFound\(\)/, dir);
  }
  const nginx = read('../../deploy/nginx/default.conf');
  assert.match(nginx, /location \^~ \/speaking\/shadowing\/dev\/ \{ return 404; \}/);
  assert.match(nginx, /location = \/landing-preview \{ return 404; \}/);
  for (const path of ['login', 'refresh', 'session/refresh', 'session/exchange', 'google/exchange', 'google/link']) {
    assert.match(nginx, new RegExp(`location = /api/v1/auth/${path.replace('/', '\\/')} \\{ default_type application/json; return 404`), path);
  }
  assert.match(read('../next.config.ts'), /if \(process\.env\.NODE_ENV === "production"\) return \[\];/, 'no dev rewrite in production');
  assert.match(read('../src/services/api-client.ts'), /if \(process\.env\.NODE_ENV === 'production'\) return process\.env\.NEXT_PUBLIC_API_URL \|\| '\/api\/v1';/,
    'storage cannot redirect the API in production');
  const securityTxt = read('../public/.well-known/security.txt');
  assert.match(securityTxt, /^Contact: mailto:/m); assert.match(securityTxt, /^Expires: \d{4}-/m);
  const walk = dir => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : /\.(ts|tsx)$/.test(entry.name) ? [`${dir}/${entry.name}`] : []);
  for (const file of walk('../src')) {
    assert.doesNotMatch(read(file), /AUTH_JWT_SECRET|APP_SECURITY_JWT_SECRET|APP_SECURITY_MFA_ENCRYPTION_KEY/,
      `${file}: the frontend never reads the backend's signing or encryption secrets`);
  }
});

check('no markup sink in page code: text is rendered as text, and saved reader markup passes its allow-list', () => {
  const walk = dir => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : /\.(ts|tsx)$/.test(entry.name) ? [`${dir}/${entry.name}`] : []);
  const sink = /dangerouslySetInnerHTML|\.(?:inner|outer)HTML\s*=|insertAdjacentHTML|document\.write\(|createContextualFragment|\bnew Function\(|[^.\w]eval\(/;
  const allowed = '../src/lib/reading/saved-reader-markup.ts';
  const sources = walk('../src');
  assert.ok(sources.length > 400 && sources.includes(allowed), 'page sources found');
  for (const file of sources) {
    if (file === allowed) continue;
    assert.doesNotMatch(read(file), sink, `${file} writes markup or evaluates text`);
  }
  // the one place that parses stored markup does it into an inert template and keeps only what the reader builds
  const markup = read(allowed);
  assert.match(markup, /document\.createElement\('template'\)/);
  assert.equal((markup.match(/innerHTML\s*=/g) ?? []).length, 1, 'only the inert template is assigned markup');
  assert.match(markup, /attribute\.name !== 'class'\) element\.removeAttribute/);
  assert.match(markup, /READER_ELEMENTS\.has\(element\.tagName\)/);
  for (const tag of ['SCRIPT', 'IMG', 'IFRAME', 'SVG', 'A', 'STYLE', 'FORM', 'INPUT']) {
    assert.doesNotMatch(markup, new RegExp(`'${tag}'`), `${tag} must not be restored`);
  }
  assert.match(read('../src/components/features/reading/InteractiveReader.tsx'), /replaceChildren\(savedReaderMarkup\(savedHtml\)\)/);
});

console.log(`Security hardening contracts: ${passed} passed`);
