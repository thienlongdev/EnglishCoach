import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const sidebar = source('components/layout/Sidebar.tsx');
const hub = source('components/features/games/GamesHub.tsx');
const flashcards = source('components/features/flashcard/FlashcardUI.tsx');
const modal = source('components/features/flashcard/card-blast/CardBlastModal.tsx');
const route = source('app/games/page.tsx');
const labels = source('lib/exams/labels.ts');

assert.match(sidebar, /tab: "flashcards"[\s\S]*tab: "games"[\s\S]*tab: "reading"/);
assert.match(sidebar, /tab: "games",\s*labelKey: "games" as const,\s*icon: Gamepad2,[\s\S]*?href: "\/games"/);
assert.match(sidebar, /pathname === "\/games" \|\| pathname.startsWith\("\/games\/"\)/);
assert.match(sidebar, /aria-label=\{label\}/);
assert.match(sidebar, /aria-current=\{isActive \? "page" : undefined\}/);
assert.match(labels, /games: 'Trò chơi'/);
assert.match(labels, /games: 'Games'/);
assert.match(route, /<AuthGuard>[\s\S]*<Suspense[\s\S]*<GamesHub/);
assert.match(hub, /HeroArenaMascotArtwork/);
assert.doesNotMatch(hub, /BrandWhaleIcon/);
assert.doesNotMatch(hub, /Sparkles/);
assert.match(hub, /<h1[^>]*>/);
assert.match(hub, /useState\(""\)/);
assert.doesNotMatch(hub, /decks\[0\]|setDeckKey\(decks/);
assert.match(hub, /userScope \? \["\/flashcards\/decks", userScope\] : null/);
assert.match(hub, /cardsUrl && userScope \? \[cardsUrl, userScope\] : null/);
assert.match(hub, /selectedDeck.id != null \? `deckId=\$\{selectedDeck.id\}&` : ""/);
assert.match(hub, /page=0&size=50/);
assert.match(hub, /keepPreviousData: false/);
assert.match(hub, /disabled=\{!selectedDeck \|\| cardsLoading \|\| !!cardsError \|\| !!decksError\}/);
assert.match(hub, /<CardBlastModal[\s\S]*deck=\{selectedDeck\}[\s\S]*availableCards=\{availableCards\}[\s\S]*allDecks=\{decks\}[\s\S]*initialPvpCode=\{pvpCode \|\| undefined\}/);
assert.doesNotMatch(hub, /CardBlastEngine|finish-run|\/app\/pvp|localStorage|sessionStorage/);
assert.match(hub, /if \(pvpCode\) setIsOpen\(true\)/);
assert.match(hub, /url.searchParams.delete\("pvp"\)/);
assert.match(hub, /launchButton.current\?\.focus\(\)/);
assert.match(source('components/features/flashcard/pvp/PvPLobby.tsx'), /\/games\?pvp=\$\{cleanRoomCode\}/);
assert.doesNotMatch(flashcards, /topbar-card-blast-btn|Game Bắn chữ|onOpenCardBlast/);
assert.match(flashcards, /id="topbar-quiz-btn"/);
// Preserve the old invite URL's original auto-open and modal inputs; no redirect required.
assert.match(flashcards, /searchParams\?\.get\("pvp"\)/);
assert.match(flashcards, /if \(pvpParam\) \{\s*setShowCardBlastModal\(true\)/);
assert.match(flashcards, /initialPvpCode=\{pvpParam \|\| undefined\}/);
assert.match(modal, /\/flashcards\?deckId=\$\{deck.id\}&page=0&size=100/);
assert.match(modal, /rawCards = availableCards/);
assert.match(modal, /\/flashcards\/card-blast\/finish-run/);
assert.match(modal, /deckId: deck\?\.id \|\| null/);
assert.match(modal, /invalidateLeaderboardCaches\(\)/);

// --- Echo Garden Contracts ---
// World composition is data-driven: one layout file shared by the PixiJS runtime and the
// Blender world builder. The contracts validate that data geometrically.
const gardenView = source('components/features/games/echo-garden/EchoGardenView.tsx');
const gardenCanvas = source('components/features/games/echo-garden/EchoGardenCanvas.tsx');
const gardenShell = source('components/features/games/echo-garden/EchoGardenGameShell.tsx');
const gardenWorldData = source('components/features/games/echo-garden/world/worldData.ts');
const layout = JSON.parse(source('components/features/games/echo-garden/world/echoGardenLayout.json'));

// 1. Echo Garden remains lazy-loaded
assert.match(gardenView, /dynamic\(\s*\(\)\s*=>\s*import\("\.\/EchoGardenCanvas"\)/);
assert.match(gardenView, /ssr:\s*false/);

// 2. Logical map unchanged: 25 x 27 grid
assert.equal(layout.grid.width, 25, 'Logical grid width must stay 25');
assert.equal(layout.grid.height, 27, 'Logical grid height must stay 27');

// 3. Exactly 6 starter plots, unique, whole cells in the 2x3 arrangement
assert.equal(layout.starterPlots.length, 6, 'Must have exactly 6 starter plots');
const plotCoords = layout.starterPlots.map((p) => `${p.gx},${p.gy}`);
const uniqueCoords = new Set(plotCoords);
assert.equal(uniqueCoords.size, 6, 'Starter plots must have 6 unique coordinates');
assert.ok(layout.starterPlots.every((p) => Number.isInteger(p.gx) && Number.isInteger(p.gy)), 'Starter plots must be whole cells');
assert.equal(new Set(layout.starterPlots.map((p) => p.gx)).size, 3, 'Starter plots span 3 columns');
assert.equal(new Set(layout.starterPlots.map((p) => p.gy)).size, 2, 'Starter plots span 2 rows');
// the runtime renders the six crops from this data, one per plot
assert.match(gardenCanvas, /LAYOUT\.starterPlots\.forEach/);

// 4. No path (sampled Catmull-Rom centre line + half width) and no walkway touches an active plot
const catmull = (points, n = 24) => {
  const pts = [points[0], ...points, points[points.length - 1]];
  const out = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
};
for (const path of layout.paths) {
  for (const [x, y] of catmull(path.points)) {
    for (const plot of layout.starterPlots) {
      const dx = Math.max(0, Math.abs(x - plot.gx) - 0.5);
      const dy = Math.max(0, Math.abs(y - plot.gy) - 0.5);
      assert.ok(Math.hypot(dx, dy) > path.width / 2, `Path ${path.id} at (${x.toFixed(2)}, ${y.toFixed(2)}) must not touch plot (${plot.gx}, ${plot.gy})`);
    }
  }
}
assert.ok(layout.farmWalkways.length > 0, 'farm walkways must exist');
for (const [wgx, wgy] of layout.farmWalkways) {
  assert.ok(!uniqueCoords.has(`${wgx},${wgy}`), `Walkway cell (${wgx}, ${wgy}) must not overlap any active plot`);
}
// future fields never overlap an active plot cell
for (const f of layout.futureFields) {
  const [x0, y0, x1, y1] = f.rect;
  for (const p of layout.starterPlots) {
    const overlap = p.gx + 0.5 > x0 && p.gx - 0.5 < x1 && p.gy + 0.5 > y0 && p.gy - 0.5 < y1;
    assert.ok(!overlap, `Future field ${f.id} must not overlap plot (${p.gx}, ${p.gy})`);
  }
}

// 4b. Farm storytelling props never block expansion: not on a plot, walkway or future-field cell
assert.ok(Array.isArray(layout.farmProps) && layout.farmProps.length > 0, 'farm props are layout data');
for (const fp of layout.farmProps) {
  for (const p of layout.starterPlots) {
    assert.ok(Math.max(Math.abs(fp.gx - p.gx), Math.abs(fp.gy - p.gy)) > 0.5, `Prop ${fp.key} must not sit on plot (${p.gx}, ${p.gy})`);
  }
  for (const [wgx, wgy] of layout.farmWalkways) {
    assert.ok(Math.max(Math.abs(fp.gx - wgx), Math.abs(fp.gy - wgy)) > 0.5, `Prop ${fp.key} must not block walkway (${wgx}, ${wgy})`);
  }
  for (const f of layout.futureFields) {
    const [x0, y0, x1, y1] = f.rect;
    assert.ok(!(fp.gx > x0 && fp.gx < x1 && fp.gy > y0 && fp.gy < y1), `Prop ${fp.key} must not occupy future field ${f.id}`);
  }
}
// 4c. Every starter plot shows one of the four visual growth stages (art only, no game state)
assert.ok(layout.starterPlots.every((p) => [1, 2, 3, 4].includes(p.stage ?? 4)), 'plot stage is 1..4');

// 4d. Dynamic art architecture: entity shadows are composed at runtime, never baked into the terrain
const shadowLayer = source('components/features/games/echo-garden/world/shadowLayer.ts');
assert.match(shadowLayer, /blendMode = "min"/, 'overlapping shadows compose with MIN (no double darkening)');
// the composed factor is converted once into a darkness layer (black, alpha = 1 - factor): over the island
// this equals multiplying by the factor; over transparent sky in the graded scene it adds nothing
assert.match(shadowLayer, /-1, 0, 0, 0, 1\]/, 'shadow composition darkens the ground by the composed factor');
assert.match(gardenCanvas, /new ShadowLayer\(/);
assert.match(gardenCanvas, /groundObjects/, 'raised beds are separate ground sprites');
const terrainBuilderUrl = new URL('../../imports/sources-assets/owner-authored/echo-garden-world-v2/scripts/build_terrain.py', import.meta.url);
const terrainBuilder = existsSync(terrainBuilderUrl) ? readFileSync(terrainBuilderUrl, 'utf8') : null;
if (terrainBuilder !== null) {
  assert.doesNotMatch(terrainBuilder, /def import_shadow_casters/, 'terrain bake must not contain entity shadow casters');
  assert.doesNotMatch(terrainBuilder, /EG_BedFrames/, 'starter beds are never baked into the terrain');
}

// 4e. Echo Whale is the pre-rendered 3D character (heading views), never a flipped flat card
const gardenWhale = source('components/features/games/echo-garden/world/echoWhale.ts');
assert.doesNotMatch(gardenWhale, /MeshRope/);
assert.doesNotMatch(gardenWhale, /scale\.x\s*=\s*-|scale\.set\(\s*-/, 'whale is never mirrored');
assert.match(gardenWhale, /worldHeading/);
// 4e1. On WebGL the whale is real-time 3D: continuous heading + bank, never an atlas view or a mirror
const gardenWhale3D = source('components/features/games/echo-garden/world/echoWhale3D.ts');
const gardenWhaleModel = source('components/features/games/echo-garden/world/whaleModel.ts');
assert.match(gardenCanvas, /new EchoWhale3D\(/, 'canvas uses the real-time 3D whale on WebGL');
assert.match(gardenCanvas, /RendererType\.WEBGL/);
assert.match(gardenWhale3D, /new Mesh\(/);
assert.match(gardenWhale3D, /Shader\.from\(/);
assert.match(gardenWhale3D, /this\.bank \+=/, 'the body banks with the turn rate');
assert.doesNotMatch(gardenWhale3D, /scale\.x\s*=\s*-|scale\.set\(\s*-/, 'whale is never mirrored');
assert.doesNotMatch(gardenWhale3D, /Math\.(floor|round)\([^)]*heading/, 'heading is continuous (never quantized to views)');
assert.match(gardenWhaleModel, /function spine\(/, 'swim cycle articulates the spine');

// 4e1b. Farm fences, gate and future-plot markers are separate runtime sprites (gameplay-managed),
//       never baked into the terrain
if (terrainBuilder !== null) {
  assert.doesNotMatch(terrainBuilder, /EG_Fences|EG_FieldStakes/, 'fences / plot stakes are never baked into the terrain');
}
assert.match(gardenCanvas, /fenceBays\(LAYOUT\)/);
assert.match(gardenCanvas, /field_marker_\$\{f\.id\}/);
assert.match(gardenWorldData, /export function fenceBays/);
assert.ok(Array.isArray(layout.fences) && layout.fences.length > 0 && Array.isArray(layout.farmGate), 'fence lines + gate in layout');

// 4e2. Decorative display objects never take part in hit testing (the stage is interactive, so
//      Pixi would otherwise let any sprite above a plot swallow the tap)
assert.match(gardenCanvas, /s\.eventMode = "none"; \/\/ decorative/);
assert.match(gardenCanvas, /hit\.hitArea = new Polygon\(poly\)/, 'each plot is tapped through its whole cell diamond');
assert.match(gardenCanvas, /\[sky\.root, terrainLayer, groundObjects, fxLayer\]\.forEach\(\(c\) => \(c\.eventMode = "none"\)\)/);

// 4f. QA / validation hooks exist only in development builds
assert.match(gardenCanvas, /process\.env\.NODE_ENV !== "production"[\s\S]*__echoGarden = \{/);

// 5. Exactly one Knowledge Tree
assert.equal(layout.sprites.filter((s) => s.id === 'knowledge_tree').length, 1, 'Must have exactly one Knowledge Tree');
assert.equal(layout.trees.filter((t) => t.key === 'knowledge_tree').length, 0, 'The Knowledge Tree is never a forest tree');

// 6. No source-pack path imported at runtime
assert.doesNotMatch(gardenCanvas, /sources-assets/);
assert.doesNotMatch(gardenView, /sources-assets/);
assert.doesNotMatch(gardenWorldData, /sources-assets/);

// 7. Fullscreen contracts preserved
assert.match(gardenShell, /document\.fullscreenElement/);
assert.match(gardenShell, /requestFullscreen/);
assert.match(gardenShell, /exitFullscreen/);

console.log('Games & Echo Garden migration contracts passed (navigation, explicit deck, modal reuse, legacy invites, Flashcards removal, 25x27 grid, 6 starter plots, path/walkway/field exclusion, single Knowledge Tree, farm props off expansion cells, runtime-composed shadows, 3D whale, dev-only QA hooks, lazy-loading, asset compliance, fullscreen).');

