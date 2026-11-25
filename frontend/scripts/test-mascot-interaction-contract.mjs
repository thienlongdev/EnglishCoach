import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function runAssertions() {
  console.log('🧪 Starting "Echo\'s Ocean" landing, 3D mascot & brand whale contract tests...\n');

  const rootDir = process.cwd();
  const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8').replace(/\r\n/g, '\n');
  const pagePath = 'src/components/landing/LandingPage.tsx';
  const heroPath = 'src/components/landing/LandingHero.tsx';
  const stagePath = 'src/components/landing/ocean/OceanStage.tsx';
  const enginePath = 'src/components/landing/ocean/oceanEngine.ts';
  const rigPath = 'src/components/landing/ocean/whaleRig.ts';
  const lanesPath = 'src/components/landing/ocean/lanes.ts';
  const ripplePath = 'src/components/landing/ocean/WordRipple.tsx';
  const footerPath = path.join(rootDir, 'src/components/landing/LandingFooter.tsx');

  const page = read(pagePath);
  const hero = read(heroPath);
  const stage = read(stagePath);
  const engine = read(enginePath);
  const rig = read(rigPath);
  const lanes = read(lanesPath);
  const ripple = read(ripplePath);

  // 1. One click-through WebGL layer in its own chunk. The server renders the empty layer so the HTML preloads that
  //    chunk (it used to be requested only after hydration — the whale's longest wait on a cold visit).
  if (!page.includes("dynamic(() => import('./ocean/OceanStage'), { loading: () => null })") || page.includes('ssr: false')) {
    throw new Error('FAIL: OceanStage must be a next/dynamic chunk rendered on the server (chunk preloaded with the HTML), with its own Suspense boundary.');
  }
  if (/^import[^\n]*(?:'three'|\.\/ocean\/OceanStage'|\.\/ocean\/oceanEngine')/m.test(page.replace(/^import type[^\n]*\n/gm, ''))) {
    throw new Error('FAIL: three.js and the engine must stay out of the landing chunk (no static import in LandingPage).');
  }
  if (!page.includes("preload(ECHO_MODEL_URL, { as: 'fetch', crossOrigin: 'anonymous', fetchPriority: 'low' })")) {
    throw new Error('FAIL: The whale model must be preloaded with the HTML, at low priority (after the app scripts).');
  }
  // Echo's files are content-versioned (year-long browser cache + Cloudflare edge cache): the name carries the first
  // 8 hex digits of the file's SHA-256, so a changed file can only ship under a new name.
  const assets = read('src/components/landing/ocean/echoAssets.ts');
  for (const [label, re] of [['model', /ECHO_MODEL_URL = '(\/models\/whale-([0-9a-f]{8})\.glb)'/], ['still', /src: '(\/assets\/echo-still-([0-9a-f]{8})\.webp)'/]]) {
    const match = assets.match(re);
    if (!match) throw new Error(`FAIL: Echo's ${label} URL must be content-versioned (name-<sha256:8>).`);
    const bytes = fs.readFileSync(path.join(rootDir, 'public', match[1]));
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!digest.startsWith(match[2])) throw new Error(`FAIL: ${match[1]} does not match its content hash (${digest.slice(0, 8)}): never change a versioned file in place.`);
  }
  if (!fs.existsSync(path.join(rootDir, 'public/models/whale.glb'))) {
    throw new Error('FAIL: /models/whale.glb must stay for pages loaded before the versioned name.');
  }
  if (!rig.includes('await fetch(url, { signal, credentials: \'same-origin\' })') || rig.includes('loadAsync(')) {
    throw new Error('FAIL: The model request must reuse the preload (same-origin fetch) and be cancellable.');
  }
  if (!stage.includes('aria-hidden="true"') || !stage.includes('pointer-events-none fixed inset-0')) {
    throw new Error('FAIL: The ocean stage must be a fixed, click-through, aria-hidden layer.');
  }
  if (!ripple.includes('pointer-events-none fixed inset-0') || !ripple.includes('aria-hidden="true"')) {
    throw new Error('FAIL: The word ripple canvas must be fixed, click-through and aria-hidden.');
  }
  console.log('✅ Ocean layers: dynamic, preloaded, fixed, click-through, hidden from assistive technology.');

  // 2. No placeholder whale that is swapped for the 3D one; a real fallback only when WebGL / the model fails.
  for (const [name, content] of [['OceanStage', stage], ['LandingPage', page], ['LandingHero', hero]]) {
    if (content.includes('MascotFallback') || content.includes('LandingMascotScene') || content.includes('HeroMascotViewport')) {
      throw new Error(`FAIL: ${name} still uses the old 2D-placeholder mascot pipeline.`);
    }
  }
  if (!page.includes('onFail={onOceanFail}') || !page.includes("if (reason !== 'model') setStageFailed(true)") || !hero.includes('{echoStill && <EchoStandby state={echoStill} />}')) {
    throw new Error('FAIL: WebGL / model failure must switch to the still hero illustration (a model failure keeps the water).');
  }
  // A late Echo: the still of the real model appears promptly (stall signal, or a deadline above the slowest healthy
  // cold load), the 3D Echo is drawn exactly under it and the still fades out over it. One state value, no flags.
  const standby = read('src/components/landing/EchoStandby.tsx');
  if (!page.includes("export type EchoView = 'pending' | 'standby' | 'handoff' | 'live' | 'still';") || !page.includes("useReducer(nextEchoView, 'pending')") || !page.includes('data-echo-view={view}')) {
    throw new Error("FAIL: Echo's presentation must be one reducer state (pending / standby / handoff / live / still), observable as data-echo-view.");
  }
  if (!page.includes('const STANDBY_AFTER_NAVIGATION_MS = 6000;') || !page.includes("else if (!echoReady.current) dispatch('late');") || !page.includes("preload(ECHO_STILL.src, { as: 'image', fetchPriority: 'low' })")) {
    throw new Error('FAIL: The standby still must be preloaded and shown on a stall or after the deadline, never once the model is ready.');
  }
  if (!standby.includes('aria-hidden="true"') || !standby.includes('pointer-events-none') || !standby.includes('data-echo-standby={anchor ? ECHO_STILL.unit : undefined}') || !standby.includes("state === 'handoff' ? 'opacity-0' : 'opacity-100'")) {
    throw new Error('FAIL: The still must be decorative, click-through, anchor the 3D handoff and fade out over the 3D Echo.');
  }
  if (!engine.includes("querySelector<HTMLElement>('[data-echo-standby]')") || !engine.includes('holding = true;') || !engine.includes("performance.mark?.('echo:shown')") || !stage.includes('liveAt + CANVAS_FADE_MS')) {
    throw new Error('FAIL: The engine must take over exactly at the still (hold until it is gone) and report its first drawn frame.');
  }
  if (!page.includes('class OceanBoundary') || !page.includes('getDerivedStateFromError') || !page.includes('<OceanBoundary onError={onChunkError}>')) {
    throw new Error('FAIL: A failed ocean chunk must fall back to the still whale, never take the landing page down.');
  }
  if (!engine.includes("options.onFail('webgl')") || !engine.includes("options.onFail('model')") || !engine.includes("'webglcontextlost'")) {
    throw new Error('FAIL: The engine must report WebGL, model and context-loss failures.');
  }
  // First-visit reliability: Echo never waits on an idle slot, a stalled model request is bounded (one retry, then the
  // still), shaders compile without blocking, and the lifecycle is observable without console output.
  if (stage.includes('requestIdleCallback') || !stage.includes('requestAnimationFrame(() => {')) {
    throw new Error('FAIL: The ocean must start right after the next paint, not on an idle callback.');
  }
  if (!engine.includes('const MODEL_STALL_MS = 2500;') || !engine.includes('const MODEL_IDLE_MS = 10000;') || !engine.includes('const MODEL_ATTEMPT_MS = 45000;') || !engine.includes('const MODEL_ATTEMPTS = 2;') || !engine.includes('window.setTimeout(cancel, MODEL_ATTEMPT_MS)') || !engine.includes('if (idle > MODEL_IDLE_MS) cancel();') || !rig.includes('onProgress(false);')) {
    throw new Error('FAIL: Model loading must be bounded by progress (stall signal, idle cancel, attempt ceiling, exactly one retry).');
  }
  if (!engine.includes('renderer.compileAsync(scene, camera)') || !engine.includes('renderer.compileAsync(loaded.root, camera, scene)') || !engine.includes('|| !live) return;')) {
    throw new Error('FAIL: Shaders must compile asynchronously before the first frame / before Echo joins the scene.');
  }
  for (const marker of ["dataset.echo = 'loading'", "dataset.echo = 'ready'", "dataset.echo = 'failed-model'"]) {
    if (!engine.includes(marker)) throw new Error(`FAIL: Echo's lifecycle marker ${marker} is missing.`);
  }
  if (!engine.includes('px = -Math.exp(pls) * 0.3;')) {
    throw new Error('FAIL: The swim-in must start just behind the screen edge (Echo visible within the first frames).');
  }
  console.log('✅ Echo swims in when on time; a late Echo shows the still of the real model and takes over under it; failures keep the still.');

  // 3. Motion is earned, bounded and accessible.
  if (!engine.includes('reducedMotion') || !stage.includes("'(prefers-reduced-motion: reduce)'")) {
    throw new Error('FAIL: prefers-reduced-motion must give a still portrait.');
  }
  if (!ripple.includes("'(prefers-reduced-motion: reduce)'")) {
    throw new Error('FAIL: Tap ripples must be off under prefers-reduced-motion.');
  }
  if (!engine.includes('running = false') || !engine.includes("addEventListener('visibilitychange'")) {
    throw new Error('FAIL: The render loop must sleep when nothing moves on screen.');
  }
  if (!engine.includes('dprLevels') || !engine.includes('renderer.dispose()') || engine.includes('forceContextLoss')) {
    throw new Error('FAIL: Adaptive pixel ratio and clean disposal (without forceContextLoss) are required.');
  }
  if (engine.includes('OrbitControls') || engine.includes('shadowMap.enabled = true')) {
    throw new Error('FAIL: The ocean whale is not an inspection viewer (no OrbitControls, no shadow pass).');
  }
  if (!rig.includes('CC BY 4.0')) {
    throw new Error('FAIL: The whale rig must name the licensed model.');
  }
  if (!lanes.includes('data-whale-lane') || !hero.includes('data-whale-lane="hero"')) {
    throw new Error('FAIL: Choreography must come from data-whale-lane elements in the page.');
  }
  console.log('✅ Reduced motion, sleeping loop, adaptive quality, disposal and DOM-driven swim lanes verified.');

  // 4. Hero copy, CTA and honest proof.
  if (!hero.includes('Hành trình tiếng Anh') || !hero.includes('từ bỡ ngỡ đến </span>') || !hero.includes('<span className={styles.shimmer}>bứt phá</span>')) {
    throw new Error('FAIL: The hero headline must keep its copy, with "bứt phá" as its strongest colour.');
  }
  if (!hero.includes('Nền tảng học tiếng Anh ứng dụng AI') || hero.includes('Hệ thống MDD') || hero.includes('Spaced Repetition SM-2')) {
    throw new Error('FAIL: Hero badge must be the single simplified Vietnamese badge.');
  }
  if (!hero.includes('Người bạn đồng hành AI dẫn lối hành trình làm chủ tiếng Anh toàn diện') || !hero.includes('TOEIC và IELTS') || /TOEIC (&amp;|&) IELTS/.test(hero)) {
    throw new Error('FAIL: Hero body copy does not match full platform scope.');
  }
  if (!hero.includes('id="hero-primary-cta"') || !hero.includes('Bắt đầu học thử miễn phí')) {
    throw new Error('FAIL: The primary hero CTA is missing.');
  }
  if (!hero.includes('grid-cols-3 divide-x divide-white/[0.08]')) {
    throw new Error('FAIL: The 3-column proof row is missing.');
  }
  if (hero.includes('98.4%')) {
    throw new Error('FAIL: The hero must not show an unsourced accuracy statistic.');
  }
  if (!stage.includes('data-purpose="whale-speech-bubble"') || !stage.includes('rotate-45 border-b border-r')) {
    throw new Error('FAIL: The whale speech bubble with its tail is missing.');
  }
  if (!hero.includes('data-whale-say="Rảnh rỗi thì cùng Echo học tiếng Anh nhé bạn!"')) {
    throw new Error('FAIL: Echo\'s hero line "Rảnh rỗi thì cùng Echo học tiếng Anh nhé bạn!" is missing.');
  }
  console.log('✅ Hero headline, badge, copy, CTA, honest proof row and Echo\'s line verified.');

  // 5. Ripples never steal controls or text; nothing in the ocean calls AI; no Sparkles.
  if (!ripple.includes('[role="button"]') || !ripple.includes('h1, h2, h3') || !ripple.includes('isCollapsed')) {
    throw new Error('FAIL: Tap ripples must ignore controls, text and active selections.');
  }
  const oceanDir = path.join(rootDir, 'src/components/landing/ocean');
  for (const file of fs.readdirSync(oceanDir)) {
    // The one request the ocean makes is the static model file (`whaleRig.ts`, URL passed in from OceanStage).
    const content = fs.readFileSync(path.join(oceanDir, file), 'utf8').replace("await fetch(url, { signal, credentials: 'same-origin' })", '');
    if (/\bfetch\(|apiClient|\/api\/|XMLHttpRequest/.test(content)) throw new Error(`FAIL: ${file} makes a network/API call; the ocean is presentation only.`);
  }
  if (!stage.includes('modelUrl: ECHO_MODEL_URL')) {
    throw new Error('FAIL: The only ocean request must be the static whale model.');
  }
  for (const rel of [pagePath, heroPath, stagePath, ripplePath, 'src/components/landing/EchoStandby.tsx', 'src/components/landing/FinalCTA.tsx']) {
    const content = read(rel);
    if (content.includes('Sparkles') || content.includes('✨')) throw new Error(`FAIL: ${rel} uses Sparkles / ✨ (forbidden).`);
  }
  console.log('✅ Ripples respect controls and text; no AI / API calls; no Sparkles.');

  // 5b. Phase 2 living ocean: water first, life as pure light, reef decorative, SSR-stable motion.
  const water = read('src/components/landing/ocean/waterBackdrop.ts');
  const life = read('src/components/landing/ocean/seaLife.ts');
  const reef = read('src/components/landing/ocean/OceanReef.tsx');
  const stories = read('src/components/landing/dive/DiveScenes.tsx');
  if (!water.includes('transparent: false') || !water.includes('quad.renderOrder = -10') || !engine.includes('water.render(renderer)')) {
    throw new Error('FAIL: The water must be drawn first (opaque list, lowest renderOrder) so it never washes Echo out.');
  }
  if (!water.includes('mod(p, 6.28318) - 250.0') || !rig.includes('mod(p, 6.28318) - 250.0')) {
    throw new Error('FAIL: The caustic function must keep its stable input range (unbounded values blow the screen to white).');
  }
  if (!life.includes('blendSrcAlpha: THREE.ZeroFactor') || !life.includes('blendDstAlpha: THREE.OneFactor')) {
    throw new Error('FAIL: Jellyfish glow must be pure light that leaves the canvas alpha alone.');
  }
  if (!reef.includes('aria-hidden="true"') || !reef.includes('pointer-events-none') || /Math\.random/.test(reef)) {
    throw new Error('FAIL: The reef must be decorative, click-through and deterministic (server and client draw the same).');
  }
  if (/initial=\{shouldReduceMotion/.test(stories) || !page.includes('<MotionConfig reducedMotion="user">')) {
    throw new Error('FAIL: Motion initial states must not depend on the media query (hydration mismatch); use MotionConfig.');
  }
  if (!engine.includes('calm =') || !engine.includes('frameCount++ % 2')) {
    throw new Error('FAIL: The always-alive water must drop to half rate when nothing interactive happens.');
  }
  console.log('✅ Living ocean: water drawn first, stable caustics, pure-light jellies, deterministic reef, SSR-stable motion, half-rate calm.');

  // 5c. The dive (learning journey below the hero): semantic HTML first, one WebGL owner, reversible scroll, no API.
  const diveDir = 'src/components/landing/dive';
  const dive = read(`${diveDir}/DiveJourney.tsx`);
  const scenes = read(`${diveDir}/DiveScenes.tsx`);
  const diveCss = read(`${diveDir}/dive.module.css`);
  const diveScroll = read(`${diveDir}/useDiveScroll.ts`);
  const diveLink = read(`${diveDir}/DiveLink.tsx`);
  const forms = read('src/components/landing/ocean/knowledgeForms.ts');
  if (!page.includes('<DiveJourney />') || page.includes('FeatureStories')) {
    throw new Error('FAIL: The landing must render the dive journey (the old feature cards are retired).');
  }
  if (!dive.includes('id="features-section"') || !dive.includes('<h2 id="dive-title"') || (scenes.match(/data-dive-scene/g) || []).length !== 5) {
    throw new Error('FAIL: The dive keeps the #features-section anchor, one h2 and exactly five depths.');
  }
  for (const id of ['tu-vung', 'nghe-noi', 'doc-viet', 'lo-trinh', 'the-gioi']) {
    if (!scenes.includes(`<section id="${id}"`) || !dive.includes(`id: '${id}'`)) throw new Error(`FAIL: Depth #${id} must exist and be linked from the gauge.`);
  }
  for (const [name, content] of [['DiveJourney', dive], ['DiveScenes', scenes], ['useDiveScroll', diveScroll], ['DiveLink', diveLink]]) {
    if (/\bfetch\(|apiClient|\/api\/|XMLHttpRequest|getUserMedia|from 'three'|<canvas|Sparkles|✨/.test(content)) {
      throw new Error(`FAIL: ${name} must stay presentation only (no request, microphone, canvas, three.js or Sparkles).`);
    }
  }
  // One renderer: the light forms live in the ocean engine's own scene, one draw call, read from the DOM like lanes.
  if (!engine.includes('const forms = createKnowledgeForms(coarse);') || !engine.includes('scene.add(forms.points);') || !engine.includes('forms.dispose();') || /WebGLRenderer|requestAnimationFrame|getBoundingClientRect\(\)[^;]*;[^}]*update\(/.test(forms.replace('const rect = form.el.getBoundingClientRect();', ''))) {
    throw new Error('FAIL: Knowledge forms must be one Points object inside the ocean engine (no renderer, loop or per-frame measuring of their own).');
  }
  for (const kind of ['ring', 'wave', 'lines', 'route', 'cluster']) {
    if (!scenes.includes(`data-ocean-form="${kind}"`)) throw new Error(`FAIL: The ${kind} light form has no anchor in the page.`);
  }
  // Scroll state is a pure function of the scroll position; without the script every scene is in its finished state.
  if (!/\.scene \{\s*--e: 1;\s*--s: 1;/.test(diveCss) || !diveScroll.includes("{ passive: true }") || /preventDefault|scrollTo|scrollIntoView|wheel|lenis|gsap/i.test(diveScroll)) {
    throw new Error('FAIL: The dive must default to its finished state and never take over scrolling.');
  }
  if (/backdrop-filter|!important|font-family/.test(diveCss) || !diveCss.includes('@media (prefers-reduced-motion: reduce)')) {
    throw new Error('FAIL: Dive surfaces are opaque pearl (no backdrop blur over the live ocean), Quicksand only, still under reduced motion.');
  }
  if (!diveLink.includes('<a href={to}') || !diveLink.includes('journeyGo(target)') || !diveLink.includes("`/login?callbackUrl=${encodeURIComponent(safe)}`")) {
    throw new Error('FAIL: Dive links must be real anchors to allow-listed module routes, going through sign-in for guests.');
  }
  for (const route of diveLink.match(/'\/[a-z-]+'/g) || []) {
    const rel = route.slice(2, -1);
    if (!fs.existsSync(path.join(rootDir, 'src/app', rel)) && !fs.existsSync(path.join(rootDir, 'src/app/(workspace)', rel))) {
      throw new Error(`FAIL: Dive destination /${rel} is not a route of the app.`);
    }
  }
  // The flashcard example must say what the scheduler does (10 §AA): Khó now, Tốt +3 days, Dễ mastered.
  if (!scenes.includes('quay lại ngay trong hôm nay') || !scenes.includes('sau 3 ngày') || !scenes.includes('đã thuộc') || (scenes.match(/Ví dụ minh họa/g) || []).length < 5) {
    throw new Error('FAIL: The flashcard example must match the real schedule, and every demonstration is labelled as an example.');
  }
  console.log('✅ Dive journey: five semantic depths, one renderer, reversible scroll, labelled local examples, real destinations.');

  // 6. Verify LandingFooter.tsx
  const footerContent = fs.readFileSync(footerPath, 'utf8');
  if (footerContent.includes('Linh vật AI Echo</h4>')) {
    throw new Error('FAIL: Footer still contains the Linh vật AI Echo column.');
  }
  // Owner decision 2026-10-02: no personal address / phone / e-mail on the public footer (patterns, not the values).
  if (/mailto:|tel:|@gmail\.com|Ngách|ngõ|\b0\d{9}\b|\bMapPin\b|\bPhone\b/.test(footerContent)) {
    throw new Error('FAIL: Footer exposes personal contact information (address / phone / e-mail).');
  }
  for (const group of ['"Học tập"', '"Sản phẩm"', '"Hỗ trợ"']) {
    if (!footerContent.includes(group)) throw new Error(`FAIL: Footer group ${group} missing.`);
  }
  const productBlock = footerContent.slice(footerContent.indexOf('PRODUCT_LINKS'), footerContent.indexOf('];', footerContent.indexOf('PRODUCT_LINKS')));
  if (!productBlock.includes("label: 'Premium'")) {
    throw new Error('FAIL: Premium must be listed under "Sản phẩm".');
  }
  console.log('✅ Footer: no personal contact data; Học tập / Sản phẩm / Hỗ trợ groups; Premium under Sản phẩm.');
  // 7. Verify Official Brand Whale Icon & Master Whale.svg Integrity
  const brandIconPath = path.join(rootDir, 'src/components/common/BrandWhaleIcon.tsx');
  const masterSvgPath = path.join(rootDir, 'public/assets/Whale.svg');
  const sidebarContent = fs.readFileSync(path.join(rootDir, 'src/components/layout/Sidebar.tsx'), 'utf8');
  const navbarContent = fs.readFileSync(path.join(rootDir, 'src/components/landing/LandingNavbar.tsx'), 'utf8');

  // The official mark is the owner's whale since 2026-10-31 (10 §BJ): one registry, content-hashed files, legacy addresses show the same mark.
  if (!fs.existsSync(masterSvgPath)) {
    throw new Error('FAIL: legacy address public/assets/Whale.svg must keep answering');
  }
  const brandIconContent = fs.readFileSync(brandIconPath, 'utf8');
  if (!brandIconContent.includes('echoSrc(') || brandIconContent.includes('/assets/Whale.svg')) {
    throw new Error('FAIL: BrandWhaleIcon must draw through the brand registry');
  }
  console.log('✅ Shared BrandWhaleIcon draws through the brand registry.');

  // Verify Sidebar & Navbar & Footer usage
  if (!sidebarContent.includes('<BrandWhaleIcon') || !sidebarContent.includes('BrandWhaleIcon')) {
    throw new Error('FAIL: Sidebar does not use BrandWhaleIcon');
  }
  if (!navbarContent.includes('<BrandWhaleIcon') || !navbarContent.includes('BrandWhaleIcon')) {
    throw new Error('FAIL: LandingNavbar does not use BrandWhaleIcon');
  }
  if (footerContent && (!footerContent.includes('<BrandWhaleIcon') || !footerContent.includes('BrandWhaleIcon'))) {
    throw new Error('FAIL: LandingFooter does not use BrandWhaleIcon');
  }
  console.log('✅ Sidebar, LandingNavbar, and LandingFooter all consistently use BrandWhaleIcon.');

  // Derived icons at their legacy addresses, transparent rasters, cache-safe names in the metadata
  for (const rel of ['public/icon.svg', 'public/favicon.ico', 'public/icon-192.png', 'public/icon-512.png', 'public/apple-icon.png']) {
    if (!fs.existsSync(path.join(rootDir, rel))) throw new Error(`FAIL: Derived icon asset ${rel} does not exist`);
  }
  for (const rel of ['src/app/icon.svg', 'src/app/favicon.ico']) {
    if (fs.existsSync(path.join(rootDir, rel))) throw new Error(`FAIL: ${rel} would add a competing icon link to every page`);
  }
  for (const rel of ['public/icon-192.png', 'public/icon-512.png']) {
    const png = fs.readFileSync(path.join(rootDir, rel));
    // PNG colour type 6 (RGBA) at byte 25: the mark keeps an alpha channel.
    if (png[25] !== 6) throw new Error(`FAIL: ${rel} is not an RGBA (transparent) PNG.`);
  }
  const layoutContent = fs.readFileSync(path.join(rootDir, 'src/app/layout.tsx'), 'utf8');
  if (!layoutContent.includes('ECHO_ICON.ico') || !layoutContent.includes('ECHO_ICON.touch')) throw new Error('FAIL: layout metadata must use the hashed Echo icons.');
  if (!hero.includes('<BrandWhaleIcon variant="clean"') || !footerContent.includes('<BrandWhaleIcon variant="clean"')) {
    throw new Error('FAIL: The landing header and footer must use the transparent whale mark, not the boxed app-icon frame.');
  }
  console.log('✅ Transparent brand mark: no badge in favicon sources, RGBA rasters, new cache-safe icon URLs, clean landing marks.');

  console.log('\n🎉 ALL LANDING OCEAN, 3D MASCOT & BRAND WHALE ICON TESTS PASSED!');
}

runAssertions();
