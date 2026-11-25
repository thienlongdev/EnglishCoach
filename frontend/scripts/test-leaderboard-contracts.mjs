// Leaderboard Phase 4 UI contracts. Pure helpers are imported straight from the TypeScript source
// (Node >= 22.18 / 24 strips types natively); components are checked statically.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, '..');
const src = (...p) => path.join(frontendRoot, 'src', ...p);
const read = (...p) => fs.readFileSync(src(...p), 'utf-8');

const f = await import(new URL('../src/lib/leaderboard/format.ts', import.meta.url).href);

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  -> PASS: ${name}`);
}

console.log('=== Leaderboard UI contract tests ===\n');

// 1. Chips
test('Thi đua group chips have no "Đọc" / READING chip', () => {
  const labels = f.ACTIVITY_GROUPS.map((g) => g.vi);
  assert.deepEqual(labels, ['Tất cả', 'Từ vựng', 'Nghe', 'Nói', 'Viết', 'Thi thử']);
  assert.ok(!labels.includes('Đọc'));
  assert.ok(!f.ACTIVITY_GROUPS.some((g) => g.id === 'READING'));
});
test('periods, scopes, proficiency boards (no Vocabulary board) and divisions use the exact labels', () => {
  assert.deepEqual(f.ACTIVITY_PERIODS.map((p) => p.vi), ['Tuần', 'Tháng', 'Tổng']);
  assert.deepEqual(f.ACTIVITY_SCOPES.map((p) => p.vi), ['Bảng chung', 'Sơ cấp', 'Trung cấp', 'Cao cấp']);
  assert.deepEqual(f.PROFICIENCY_BOARDS.map((p) => p.vi), ['Tổng', 'Nghe', 'Đọc', 'Viết', 'Nói']);
  assert.ok(!f.PROFICIENCY_BOARDS.some((b) => b.id === 'VOCABULARY'));
  assert.deepEqual(f.DIVISIONS.map((p) => p.vi), ['Sơ cấp', 'Trung cấp', 'Cao cấp']);
});

// 2. Breakdown names
test('breakdown source names (Vietnamese) for all 11 scored sources', () => {
  const expected = {
    FLASHCARD_REVIEW: 'Ôn thẻ từ vựng', FLASHCARD_NEW: 'Học thẻ mới', FLASHCARD_MASTERED: 'Thẻ đã thuộc',
    CARD_BLAST_SOLO: 'Card Blast', CARD_BLAST_PVP: 'Đấu 1v1', DICTATION: 'Chép chính tả', SHADOWING: 'Nói nhại câu',
    ROLEPLAY: 'Hội thoại AI', WRITING: 'Viết', EXAM_SIMULATION: 'Thi thử mô phỏng', EXAM_PRACTICE: 'Luyện đề theo kỹ năng',
  };
  for (const [k, v] of Object.entries(expected)) assert.equal(f.sourceName(k), v, k);
  assert.equal(f.sourceName('UNKNOWN_X'), 'UNKNOWN_X');
});
test('breakdown footnote never calls it the dashboard streak', () => {
  assert.equal(f.TEXT.vi.breakdownFootnote,
    'Điểm thi đua có thưởng chuỗi ngày có điểm (tối đa +15%). Chuỗi này tính riêng cho bảng thi đua.');
  assert.ok(!/streak/i.test(f.TEXT.vi.breakdownFootnote));
});

// 3. Countdown + updated time
test('period-end countdown (weekly / monthly reset, never called a data refresh)', () => {
  const now = new Date('2026-10-01T10:00:00Z');
  assert.equal(f.formatCountdown('2026-10-03T15:00:00Z', now), 'Kỳ tuần kết thúc sau 2 ngày 5 giờ');
  assert.equal(f.formatCountdown('2026-10-01T15:12:00Z', now), 'Kỳ tuần kết thúc sau 5 giờ 12 phút');
  assert.equal(f.formatCountdown('2026-10-01T10:12:30Z', now), 'Kỳ tuần kết thúc sau 12 phút');
  assert.equal(f.formatCountdown('2026-10-01T10:00:20Z', now), 'Kỳ tuần kết thúc sau 1 phút');
  assert.equal(f.formatCountdown('2026-10-20T10:00:00Z', now, 'vi', 'MONTH'), 'Kỳ tháng kết thúc sau 19 ngày 0 giờ');
  assert.equal(f.formatCountdown('2026-10-01T09:00:00Z', now), 'Đang sang kỳ mới');
  assert.equal(f.formatCountdown(null, now), null);
  assert.equal(f.formatCountdown('2026-10-03T15:00:00Z', now, 'en'), 'Week ends in 2 days 5 h');
  const tab = read('components', 'features', 'leaderboard', 'ActivityBoardTab.tsx');
  assert.ok(!tab.includes('Làm mới sau') && !f.formatCountdown('2026-10-03T15:00:00Z', now).includes('Làm mới'),
    'the period countdown is not labelled as a refresh');
  assert.ok(f.TEXT.vi.liveHint.includes('trực tiếp') && tab.includes('t.liveHint'));
});
test('"Cập nhật lúc HH:mm" in Asia/Ho_Chi_Minh; null ⇒ "Chưa cập nhật"', () => {
  assert.equal(f.formatUpdatedAt('2026-10-01T07:20:00Z'), 'Cập nhật lúc 14:20');
  assert.equal(f.formatUpdatedAt('2026-09-30T17:05:00Z'), 'Cập nhật lúc 00:05');
  assert.equal(f.formatUpdatedAt(null), 'Chưa cập nhật');
});

// 4. Status / ineligibleReason labels
test('skill status labels', () => {
  assert.equal(f.skillStatusLabel('UNDETERMINED'), 'Chưa đủ dữ liệu');
  assert.equal(f.skillStatusLabel('PROVISIONAL'), 'Chưa xác thực bằng bài thi');
  assert.equal(f.skillStatusLabel('STALE'), 'Cần xác thực lại');
  assert.equal(f.skillStatusLabel('VERIFIED'), 'Đã xác thực');
  assert.equal(f.skillStatusLabel('UNSUPPORTED'), 'Chưa đủ dữ liệu — sẽ mở khi có bài đánh giá từ vựng');
});
test('mini L·R·W·S chip shows CEFR only when VERIFIED, "–" otherwise', () => {
  assert.equal(f.skillCellText({ cefr: 'C1', status: 'VERIFIED' }), 'C1');
  assert.equal(f.skillCellText({ cefr: 'B2', status: 'PROVISIONAL' }), '–');
  assert.equal(f.skillCellText({ cefr: null, status: 'UNDETERMINED' }), '–');
  assert.equal(f.skillCellText(undefined), '–');
});
test('Năng lực header per ineligibleReason', () => {
  const und = f.proficiencyHeaderState({ eligible: false, hidden: false, rank: null, ineligibleReason: 'UNDETERMINED' }, null);
  assert.equal(und.title, 'Trình độ chưa xác định');
  assert.equal(und.cta, null);
  assert.equal(und.placementQuiz, true, 'Stage 3: undetermined ⇒ "Bài xếp lớp nhanh" button');
  const und2 = f.proficiencyHeaderState({ eligible: false, hidden: false, rank: null, ineligibleReason: 'UNDETERMINED' }, null, 'vi', 'B1');
  assert.equal(und2.kind, 'PLACEMENT');
  assert.equal(und2.title, 'Trình độ: B1 · Theo bài xếp lớp');
  assert.deepEqual(und2.cta, { label: 'Xác thực bằng bài thi chuẩn hóa', href: '/exams' });
  assert.equal(und2.ctaSecondary, true, 'placement done ⇒ the standardized exam is optional (secondary action)');
  assert.ok(!und2.placementQuiz);
  const skill = f.proficiencyHeaderState({ eligible: false, hidden: false, rank: null, ineligibleReason: 'UNDETERMINED' }, null, 'vi', 'B1', true);
  assert.equal(skill.title, 'Kỹ năng này chưa được xác thực', 'skill board + placement ⇒ never "Làm bài xếp lớp nhanh" again');
  assert.ok(skill.note.includes('B1 · Theo bài xếp lớp') && !skill.placementQuiz);
  const prov = f.proficiencyHeaderState({ eligible: false, hidden: false, rank: null, ineligibleReason: 'PROVISIONAL' }, null);
  assert.equal(prov.title, 'Đang xác thực — hoàn thành một bài thi chính thức để lên bảng');
  assert.equal(prov.cta.href, '/exams');
  const stale = f.proficiencyHeaderState({ eligible: false, hidden: false, rank: null, ineligibleReason: 'STALE' }, null);
  assert.equal(stale.title, 'Cần xác thực lại — đã lâu chưa có bài thi mới');
  assert.equal(stale.cta.href, '/exams');
  assert.equal(f.proficiencyHeaderState({ eligible: false, hidden: false, rank: null, ineligibleReason: 'EXCLUDED' }, null), null,
    'EXCLUDED ⇒ header card hidden');
  const ranked = f.proficiencyHeaderState({ eligible: true, hidden: false, rank: 3, ineligibleReason: null }, null);
  assert.equal(ranked.title, 'Hạng #3');
  assert.equal(ranked.note, null);
});
test('hidden user header shows "Bạn đang ẩn khỏi bảng năng lực" with the would-be rank', () => {
  const h = f.proficiencyHeaderState({ eligible: true, hidden: true, rank: 2, ineligibleReason: null }, null);
  assert.equal(h.kind, 'HIDDEN');
  assert.equal(h.title, 'Hạng #2');
  assert.ok(h.note.includes('Bạn đang ẩn khỏi bảng năng lực'));
  assert.ok(h.note.includes('#2'));
});

// 5. Sticky bar, card line, widget
test('"Hạng của bạn" bar texts', () => {
  assert.deepEqual(f.myRankText({ rank: null, pointsToNextRank: null, nextRank: null }), { rank: 'Chưa có điểm trong kỳ này', toNext: null });
  assert.deepEqual(f.myRankText({ rank: 7, pointsToNextRank: 12, nextRank: 6 }), { rank: '#7', toNext: 'Còn 12 XP để vượt hạng 6' });
  assert.equal(f.myRankText({ rank: 3, pointsToNextRank: 1, nextRank: 1 }).toNext, 'Còn 1 XP để vượt hạng 1', 'tie: nextRank, not rank − 1');
  assert.equal(f.myRankText({ rank: 1, pointsToNextRank: null, nextRank: null }).toNext, null);
});
test('"Hiện tại … — Cao nhất …" line (peak part hidden without a peak)', () => {
  assert.equal(f.currentPeakLine({ rating: 658, currentCefr: 'B2', peakRating: 701, peakCefr: 'C1' }), 'Hiện tại: B2 · 658 — Cao nhất: C1 · 701');
  assert.equal(f.currentPeakLine({ rating: 658, currentCefr: 'B2', peakRating: null, peakCefr: null }), 'Hiện tại: B2 · 658');
  assert.equal(f.currentPeakLine({ rating: null, currentCefr: null, peakRating: 701, peakCefr: 'C1' }), null);
});
test('CEFR ticks and 0–1000 scale', () => {
  assert.deepEqual(f.CEFR_TICKS.map((t) => t.cefr), ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  assert.equal(f.ratingPercent(658), 65.8);
  assert.equal(f.ratingPercent(1200), 100);
  assert.equal(f.ratingPercent(null), 0);
});
test('dashboard widget lines', () => {
  assert.deepEqual(f.widgetLines({ rank: 4, scope: 'TRUNG_CAP' }, { status: 'VERIFIED', currentCefr: 'B2' }),
    { rank: 'Hạng tuần: #4 (Trung cấp)', level: 'B2 · Đã xác thực' });
  assert.equal(f.widgetLines({ rank: null, scope: 'GLOBAL', divisionCefr: 'A2', divisionSource: 'PLACEMENT' },
    { status: 'UNDETERMINED', currentCefr: null }).level, 'A2 · Theo bài xếp lớp');
  assert.deepEqual(f.widgetLines({ rank: null, scope: 'GLOBAL' }, { status: 'UNDETERMINED', currentCefr: null }),
    { rank: 'Chưa có điểm tuần này', level: 'Chưa xác định' });
});

// 6. Static component checks
const lbDir = src('components', 'features', 'leaderboard');
const uiFiles = [
  ...fs.readdirSync(lbDir).map((n) => path.join(lbDir, n)).filter((f) => fs.statSync(f).isFile()),
  ...fs.readdirSync(path.join(lbDir, 'hall')).map((n) => path.join(lbDir, 'hall', n)),
  src('lib', 'leaderboard', 'format.ts'), src('services', 'leaderboardApi.ts'), src('types', 'leaderboard.ts'),
  src('hooks', 'useLeaderboard.ts'), src('app', '(workspace)', 'leaderboard', 'page.tsx'),
];
test('UNSUPPORTED vocabulary row: no bar, fixed text', () => {
  const card = read('components', 'features', 'leaderboard', 'ProficiencyCard.tsx');
  assert.ok(card.includes('data-testid="skill-row-VOCABULARY"'));
  assert.ok(card.includes("skillStatusLabel('UNSUPPORTED', locale)"));
  const vocabBlock = card.slice(card.indexOf('skill-row-VOCABULARY'), card.indexOf('skill-row-VOCABULARY') + 400);
  assert.ok(!vocabBlock.includes('<SkillBar'), 'no bar for Từ vựng');
  assert.ok(!/confidence\.toFixed|weightSum|evidenceCount|weight_sum/.test(card), 'never shows raw confidence / weights / evidence counts');
});
test('no sparkle / AI-magic glyphs and no e-mail in leaderboard UI files', () => {
  for (const file of uiFiles) {
    const s = fs.readFileSync(file, 'utf-8');
    assert.ok(!/Sparkles|✨|WandSparkles|Wand2/.test(s), `sparkle glyph in ${file}`);
    assert.ok(!/\.email\b|userEmail|email:/.test(s) || file.endsWith('useLeaderboard.ts'), `e-mail rendered in ${file}`);
  }
});
test('chips/tabs are buttons with aria-selected; podium has text equivalents', () => {
  const chips = read('components', 'features', 'leaderboard', 'ChipGroup.tsx');
  assert.ok(chips.includes('role="tab"') && chips.includes('aria-selected={selected}') && chips.includes('type="button"'));
  const podium = read('components', 'features', 'leaderboard', 'Podium.tsx');
  assert.ok(podium.includes('<ol aria-label') && podium.includes('sr-only'));
});
test('integration: nav item, home tab, profile card, dashboard widget, vi/en label', () => {
  assert.ok(read('components', 'layout', 'Sidebar.tsx').includes('href="/leaderboard"'));
  assert.ok(read('components', 'layout', 'WorkspaceTabs.tsx').includes('activeTab === "leaderboard"'));
  // the proficiency card lives on Tiến trình học tập (/progress) since the Profile / Progress separation (2026-10-17)
  assert.ok(read('components', 'features', 'learning-path', 'LearningProgressPage.tsx').includes('<ProficiencyCard />'));
  assert.ok(read('components', 'dashboard', 'DashboardBento.tsx').includes('<LeaderboardWidget />'));
  assert.ok(read('components', 'dashboard', 'DashboardBento.tsx').includes('<TopLearnersWidget />'));
  const labels = read('lib', 'exams', 'labels.ts');
  assert.ok(labels.includes("leaderboard: 'Bảng xếp hạng'") && labels.includes("leaderboard: 'Leaderboard'"));
});
test('no dev fixture route under app/ (excluded from the production build) and nothing links to it', () => {
  assert.ok(!fs.existsSync(src('app', 'leaderboard', 'dev')), 'app/leaderboard/dev must not exist');
  for (const file of uiFiles.filter((f) => fs.existsSync(f))) {
    assert.ok(!fs.readFileSync(file, 'utf-8').includes('/leaderboard/dev'), `link to a dev route in ${file}`);
  }
});
test('live boards: open leaderboard re-reads every 5 s only while visible, on focus and mount; widgets once a minute', () => {
  const hooks = read('hooks', 'useLeaderboard.ts');
  assert.ok(/LIVE_REFRESH_MS = 5_000/.test(hooks) && /WIDGET_REFRESH_MS = 60_000/.test(hooks));
  // PERF-22: the live board polls at LIVE_REFRESH_MS while the viewer interacts, at the widget cadence once idle — never faster than 5 s.
  assert.ok(/refreshInterval: liveRefreshInterval/.test(hooks)
    && /viewerRecentlyActive\(VIEWER_IDLE_MS\) \? LIVE_REFRESH_MS : WIDGET_REFRESH_MS/.test(hooks), 'idle-aware live cadence');
  assert.ok(hooks.includes('refreshWhenHidden: false') && hooks.includes('revalidateOnFocus: true') && hooks.includes('revalidateOnMount: true'));
  assert.ok(/dedupingInterval: 2_000/.test(hooks), 'no 60 s dedupe that would serve stale XP on reopen');
  assert.ok(hooks.includes('keepPreviousData: false'), 'switching period / scope never shows another partition');
  for (const m of hooks.matchAll(/refreshInterval:\s*([\d_A-Z]+)/g)) {
    const raw = m[1];
    const v = raw === 'LIVE_REFRESH_MS' ? 5_000 : raw === 'WIDGET_REFRESH_MS' ? 60_000 : Number(raw.replace(/_/g, ''));
    assert.ok(v === 0 || v >= 5_000, `refreshInterval ${raw}`);
  }
  for (const w of ['LeaderboardWidget.tsx', 'TopLearnersWidget.tsx']) {
    assert.ok(read('components', 'features', 'leaderboard', w).includes('{ live: false }'), `${w} polls calmly`);
  }
  const blast = read('components', 'features', 'flashcard', 'card-blast', 'CardBlastModal.tsx');
  assert.ok(blast.includes('invalidateLeaderboardCaches()') && blast.includes('hits: results.hits'),
    'a finished Card Blast run sends its hits and invalidates the cached boards');
});


// 7. Stage 2 (prod pipeline)
test('podium visual order #2 – #1 – #3 with dashed placeholders below 3 entries', () => {
  const three = f.podiumSlots(['a', 'b', 'c', 'd']);
  assert.deepEqual(three.map((x) => [x.place, x.item]), [[2, 'b'], [1, 'a'], [3, 'c']]);
  const one = f.podiumSlots(['a']);
  assert.deepEqual(one.map((x) => [x.place, x.item]), [[2, null], [1, 'a'], [3, null]]);
  assert.deepEqual({ ...f.PODIUM_HEIGHTS }, { 1: 100, 2: 60, 3: 48 });
  const podium = read('components', 'features', 'leaderboard', 'Podium.tsx');
  assert.ok(podium.includes('data-testid="podium-placeholder"') && podium.includes('t.emptySlot'));
  assert.equal(f.TEXT.vi.emptySlot, 'Còn trống');
  assert.ok(podium.includes('<Crown'));
});
test('Vietnamese thousands separator: "1.240 XP"', () => {
  assert.equal(f.formatXp(1240), '1.240 XP');
  assert.equal(f.formatXp(38), '38 XP');
});
test('sidebar: Bảng xếp hạng is in CHIA SẺ directly above Cộng đồng, not in HỌC TẬP', () => {
  const sb = read('components', 'layout', 'Sidebar.tsx');
  const navConfig = sb.slice(sb.indexOf('const NAV_CONFIG'), sb.indexOf('function SidebarInner'));
  assert.ok(!navConfig.includes('leaderboard'), 'not in the learning NAV_CONFIG');
  const share = sb.indexOf('"CHIA SẺ"');
  const lb = sb.indexOf('href="/leaderboard"');
  const community = sb.indexOf('href="/community"');
  assert.ok(share > 0 && share < lb && lb < community, 'order: CHIA SẺ header → Bảng xếp hạng → Cộng đồng');
  const between = sb.slice(lb, community);
  assert.equal(between.split('<Link').length, 2, 'no other link between Bảng xếp hạng and Cộng đồng');
  assert.ok(between.includes('Trophy') && between.includes('navItemClass(activeTab === "leaderboard"'), 'icon and the shared active style kept');
});
test('default scope is Bảng chung (GLOBAL) and no-level users are never defaulted to a division', () => {
  assert.equal(f.ACTIVITY_SCOPES[0].id, 'GLOBAL');
  assert.equal(f.scopeName('GLOBAL'), 'Bảng chung');
  const tab = read('components', 'features', 'leaderboard', 'ActivityBoardTab.tsx');
  assert.ok(tab.includes('me.data.defaultScope') && tab.includes("setScope('GLOBAL')"));
  assert.ok(!/['"]A1['"]/.test(tab), 'no A1 default anywhere in the tab');
});
test('reduced motion: hero gradient and pedestal rise are static under prefers-reduced-motion', () => {
  const hero = read('components', 'common', 'ModuleHero.tsx');
  const podium = read('components', 'features', 'leaderboard', 'Podium.tsx');
  for (const src of [hero, podium]) {
    assert.ok(src.includes('useReducedMotion()'));
    assert.ok(/reduceMotion \? undefined : \{/.test(src), 'animate disabled when reduced motion');
  }
  assert.ok(/duration: loopSeconds/.test(hero) && /loopSeconds = 14/.test(hero), '~14 s gradient loop');
});
test('home widget: podium top 3 + rows #4 and #5, "Xem tất cả" → Bảng chung + the card period', () => {
  const w = f.widgetRows([1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(w.podium.map((x) => x.item), [2, 1, 3]);
  assert.deepEqual(w.rows, [4, 5]);
  assert.equal(f.WIDGET_SEE_ALL_HREF, '/leaderboard?lbPeriod=WEEK&lbScope=GLOBAL');
  assert.equal(f.widgetSeeAllHref('MONTH'), '/leaderboard?lbPeriod=MONTH&lbScope=GLOBAL');
  const widget = read('components', 'features', 'leaderboard', 'TopLearnersWidget.tsx');
  assert.ok(widget.includes("useActivityBoard(period, 'GLOBAL', 'ALL', { live: false })") && widget.includes('<Podium'));
  assert.ok(widget.includes("useActivityMe(period, 'GLOBAL', 'ALL', { live: false })"));
  assert.equal(f.TEXT.vi.topMonthTitle, 'Top học viên tháng này');
});
test('period consistency: dashboard card and full leaderboard both default to Tuần; title follows the requested period', () => {
  assert.equal(f.DEFAULT_COMPETITIVE_PERIOD, 'WEEK');
  const widget = read('components', 'features', 'leaderboard', 'TopLearnersWidget.tsx');
  assert.ok(widget.includes('useState<WidgetPeriod>(DEFAULT_COMPETITIVE_PERIOD)'), 'card starts on the shared default');
  assert.ok(!/useActivity(Board|Me)\('MONTH'/.test(widget), 'no hard-coded MONTH request');
  const page = read('components', 'features', 'leaderboard', 'LeaderboardPage.tsx');
  assert.ok(page.includes(': DEFAULT_COMPETITIVE_PERIOD;'), 'leaderboard falls back to the same default');
  assert.deepEqual(f.WIDGET_PERIODS.map((p) => p.id), ['WEEK', 'MONTH']);
  assert.equal(f.topLearnersTitle('WEEK'), 'Top học viên tuần này');
  assert.equal(f.topLearnersTitle('MONTH'), 'Top học viên tháng này');
  assert.equal(f.topLearnersTitle('WEEK', 'en'), 'Top learners this week');
  assert.ok(widget.includes('topLearnersTitle(period, l)') && !widget.includes('t.topMonthTitle'), 'no Tháng label on a Tuần request');
});
test('period range label from the API window (end exclusive, Asia/Ho_Chi_Minh)', () => {
  // WEEK of 2026-10-02 VN: Mon 28/09 00:00 +07 → next Mon 05/10 00:00 +07 (exclusive)
  assert.equal(f.periodRangeLabel('2026-09-27T17:00:00Z', '2026-10-04T17:00:00Z'), '28/09 – 04/10');
  // MONTH October
  assert.equal(f.periodRangeLabel('2026-09-30T17:00:00Z', '2026-10-31T17:00:00Z'), '01/10 – 31/10');
  assert.equal(f.periodRangeLabel(null, '2026-10-04T17:00:00Z'), null);
  assert.equal(f.periodRangeLabel('2026-09-27T17:00:00Z', null), null, 'ALL_TIME has no end');
  assert.equal(f.periodRangeLabel('bad', 'worse'), null);
});
test('dashboard card refreshes once after mount / period switch (no aggressive polling)', () => {
  const hooks = read('hooks', 'useLeaderboard.ts');
  assert.ok(/WIDGET_SETTLE_MS = 8_000/.test(hooks));
  const widget = read('components', 'features', 'leaderboard', 'TopLearnersWidget.tsx');
  assert.ok(widget.includes('window.setTimeout(') && widget.includes('WIDGET_SETTLE_MS') && widget.includes('window.clearTimeout(id)'));
  assert.ok(!widget.includes('setInterval'), 'one-shot, not a poll');
});
test('hero texts and chips', () => {
  assert.equal(f.TEXT.vi.heroSubtitle, 'Thi đua học tập mỗi tuần và xác thực trình độ qua bài thi chuẩn hóa.');
  assert.equal(f.yourRankChip(7), 'Hạng của bạn: #7');
  assert.equal(f.yourRankChip(null), 'Hạng của bạn: Chưa xếp hạng');
  const h = f.letterAvatarHue(42);
  assert.ok(h >= 0 && h < 360 && h === f.letterAvatarHue(42));
});
test('unranked list: "Chưa ghi điểm kỳ này", 30 per page, "Xem thêm"', () => {
  const tab = read('components', 'features', 'leaderboard', 'ActivityBoardTab.tsx');
  assert.ok(tab.includes('getActivityUnranked(period, scope, group, from, 30)') && tab.includes('t.loadMore'));
  assert.equal(f.TEXT.vi.unrankedTitle, 'Chưa ghi điểm kỳ này');
  assert.equal(f.TEXT.vi.loadMore, 'Xem thêm');
});

// 8. Stage 3 (placement quiz, source labels, Năng lực groups, promotion)
test('level source labels next to every level', () => {
  assert.equal(f.levelSourceLabel('VERIFIED'), 'Đã xác thực');
  assert.equal(f.levelSourceLabel('PROVISIONAL'), 'Đang xác thực');
  assert.equal(f.levelSourceLabel('STALE'), 'Cần xác thực lại');
  assert.equal(f.levelSourceLabel('PLACEMENT'), 'Theo bài xếp lớp');
  assert.equal(f.levelSourceLabel(null), null);
  assert.equal(f.levelWithSource('B1', 'PLACEMENT'), 'B1 · Theo bài xếp lớp');
  assert.equal(f.divisionLine({ division: 'TRUNG_CAP', divisionCefr: 'B1', divisionSource: 'PLACEMENT' }),
    'Giải của bạn: Trung cấp · B1 · Theo bài xếp lớp');
  assert.equal(f.divisionLine({ division: null, divisionCefr: null, divisionSource: null }), null, 'no level ⇒ no division, never A1');
});
test('placement quiz texts (model 2: vocabulary + grammar multiple choice, no fake words)', () => {
  const t = f.PLACEMENT_TEXT.vi;
  assert.equal(t.title, 'Bài xếp lớp nhanh');
  assert.equal(t.introLead(30), 'Khoảng 4 phút · 30 câu từ vựng và ngữ pháp');
  assert.equal(f.PLACEMENT_DEFAULT_ITEMS, 30, 'quick placement: 30 of the 80-question bank');
  assert.equal(f.placementMinutes(30), 4);
  assert.equal(f.placementMinutes(10), 3, 'never below 3 minutes');
  assert.ok(t.introNote.includes('không phải bài thi chứng chỉ'), 'quick placement, not a certification exam');
  assert.ok(!JSON.stringify(f.PLACEMENT_TEXT).includes('từ giả') && !JSON.stringify(f.PLACEMENT_TEXT).includes('fake'),
    'no pseudoword wording any more');
  assert.equal(t.skip, 'Tôi chưa biết');
  assert.equal(t.skillVocabulary, 'Từ vựng');
  assert.equal(t.skillGrammar, 'Ngữ pháp');
  assert.equal(t.progress(3, 40), 'Câu 3/40');
  assert.equal(f.placementSkillLine({ vocabulary: { correct: 14, total: 20 }, grammar: { correct: 12, total: 20 } }),
    'Từ vựng 14/20 · Ngữ pháp 12/20');
  assert.equal(f.placementSkillLine({}), null);
  assert.deepEqual(f.splitPrompt('She ___ a teacher.'), ['She ', ' a teacher.']);
  assert.equal(t.resultSource, 'Theo bài xếp lớp');
  assert.equal(t.verifyLink, 'Xác thực bằng bài thi chuẩn hóa');
  assert.equal(t.resultJoined, 'Bạn đã có thể tham gia bảng xếp hạng Thi đua.');
  assert.equal(t.ctaCardTitle, 'Vào giải theo trình độ');
  assert.equal(t.ctaCardBody, 'Làm bài xếp lớp nhanh để xác định trình độ ban đầu và tham gia bảng xếp hạng.');
  assert.equal(t.takeQuiz, 'Làm bài xếp lớp nhanh');
  assert.equal(t.divisionCta, 'Làm bài xếp lớp để vào giải theo trình độ');
  assert.equal(t.retakeOn('31/10/2026'), 'Làm lại từ ngày 31/10/2026');
  assert.equal(f.formatVnDate('2026-10-30T18:00:00Z'), '31/10/2026', 'Asia/Ho_Chi_Minh date');
  for (const k of Object.keys(f.PLACEMENT_TEXT.vi)) assert.ok(k in f.PLACEMENT_TEXT.en, `en label ${k}`);
});
test('placement quiz: keys 1–4 / a–d / 0, progress bar, one question per screen, server-side items', () => {
  assert.equal(f.placementKeyAnswer('1'), 0);
  assert.equal(f.placementKeyAnswer('4'), 3);
  assert.equal(f.placementKeyAnswer('c'), 2);
  assert.equal(f.placementKeyAnswer('0'), 'skip');
  assert.equal(f.placementKeyAnswer('5'), null);
  assert.equal(f.placementKeyAnswer('Enter'), null);
  assert.equal(f.placementKeyAnswer('ArrowRight'), null);
  assert.equal(f.placementProgress(10, 40), 25);
  assert.equal(f.placementProgress(0, 0), 0);
  const quiz = read('components', 'features', 'leaderboard', 'PlacementQuiz.tsx');
  for (const id of ['placement-intro', 'placement-question', 'placement-result', 'placement-invalid', 'placement-locked', 'placement-verify-link',
    'placement-option', 'placement-skip', 'placement-prompt', 'placement-skill', 'placement-outdated'])
    assert.ok(quiz.includes(`data-testid="${id}"`), id);
  assert.ok(quiz.includes('role="progressbar"') && quiz.includes('placementKeyAnswer(e.key)'));
  assert.ok(quiz.includes('href="/exams"'));
  const result = quiz.slice(quiz.indexOf("phase === 'result' && result"), quiz.indexOf("phase === 'invalid'"));
  assert.ok(result.includes('data-testid="placement-view-board"') && result.includes('<ResultDivision')
    && result.includes('t.resultJoined'), 'result: level + division + "you can now join the leaderboard"');
  assert.ok(!result.includes('className={PRIMARY_BTN} data-testid="placement-verify-link"'), 'exam link is not the primary action');
  const q = quiz.slice(quiz.indexOf("phase === 'question' && issue"), quiz.indexOf("phase === 'submitting'"));
  assert.ok(q.length > 0 && !/cefr|kind|PSEUDO|REAL|answerIndex|\.answer\b/.test(q), 'question screen never sees level / answer key');
  assert.ok(quiz.includes('motion-reduce:transition-none') && quiz.includes('motion-reduce:animate-none'), 'reduced motion');
  const api = read('services', 'leaderboardApi.ts');
  assert.ok(api.includes("'/proficiency/placement/start'") && api.includes('/proficiency/placement/${attemptId}/submit') && api.includes('{ answers }'));
});
test('entry points: leaderboard banner (PLACEMENT_REQUIRED, not dismissible), "Trình độ của bạn" button, division chip CTA, header button', () => {
  const card = read('components', 'features', 'leaderboard', 'PlacementCtaCard.tsx');
  assert.ok(card.includes('data-testid="placement-cta-card"') && card.includes('showPlacementBanner(me.data)'));
  assert.ok(!card.includes('localStorage') && !card.includes('hasDivisionLevel'), 'banner never hidden for good by a dismiss flag or an exam level');
  assert.equal(f.showPlacementBanner({ rank: null, points: 0, pointsToNextRank: null, eligibility: 'PLACEMENT_REQUIRED' }), true);
  for (const e of ['EXCLUDED', 'NO_POINTS', 'PENDING', 'OTHER_DIVISION'])
    assert.equal(f.showPlacementBanner({ rank: null, points: 0, pointsToNextRank: null, eligibility: e }), false, e);
  assert.equal(f.showPlacementBanner({ rank: 4, points: 9, pointsToNextRank: 1, eligibility: 'RANKED' }), false);
  assert.equal(f.showPlacementBanner(undefined), false, 'loading ⇒ no flash');
  const page = read('components', 'features', 'leaderboard', 'LeaderboardPage.tsx');
  assert.ok(page.includes('<PlacementCtaCard') && page.includes('divisionCta={<DivisionPlacementCta'));
  assert.ok(read('components', 'features', 'leaderboard', 'ProficiencyCard.tsx').includes('<PlacementSection'));
  assert.ok(read('components', 'features', 'leaderboard', 'ProficiencyHeaderCard.tsx').includes('state.placementQuiz'));
});
test('Năng lực empty board: no level ⇒ quick placement (never /exams); with a level ⇒ optional verification', () => {
  const und = f.proficiencyHeaderState({ eligible: false, hidden: false, rank: null, ineligibleReason: 'UNDETERMINED' }, null);
  assert.equal(f.proficiencyEmptyAction(und), 'PLACEMENT');
  const placed = f.proficiencyHeaderState({ eligible: false, hidden: false, rank: null, ineligibleReason: 'UNDETERMINED' }, null, 'vi', 'B1');
  assert.equal(f.proficiencyEmptyAction(placed), 'VERIFY');
  assert.equal(f.proficiencyEmptyAction(f.proficiencyHeaderState({ eligible: false, hidden: false, rank: null, ineligibleReason: 'PROVISIONAL' }, null)), 'VERIFY');
  assert.equal(f.proficiencyEmptyAction(null), null, 'EXCLUDED / loading ⇒ no action');
  const tab = read('components', 'features', 'leaderboard', 'ProficiencyBoardTab.tsx');
  assert.ok(tab.includes('<ProficiencyPathButtons mode={pathsMode}'), 'empty board offers both paths when there is no exam-based level');
  assert.ok(f.TEXT.vi.proficiencyEmptyCta === 'Xác thực bằng bài thi chuẩn hóa' && !JSON.stringify(f.TEXT.vi).includes('Thi thử để xác thực'));
});
// ---- Quick placement reliability + two-path Năng lực card (2026-10-02) ------------------------------------------------
test('placement attempt cannot be lost: backdrop disabled while active, X / ESC ask first ("Tiếp tục làm" default), page unload warns', () => {
  const quiz = read('components', 'features', 'leaderboard', 'PlacementQuiz.tsx');
  const modal = read('components', 'features', 'leaderboard', 'BoardStates.tsx');
  assert.ok(modal.includes('onClick={dismissOnBackdrop ? onClose : undefined}'), 'backdrop close is optional');
  assert.ok(quiz.includes('dismissOnBackdrop={!state.active && !state.outcome}'), 'no backdrop close during an attempt (nor on the result)');
  assert.ok(quiz.includes('data-testid="placement-exit-confirm"') && quiz.includes('data-testid="placement-exit-stay" autoFocus'),
    'confirmation with the safe action focused');
  assert.ok(quiz.includes('setConfirmExit(false); // ESC / X on the dialog = stay in the quiz'), 'ESC on the dialog keeps the learner in');
  assert.ok(quiz.includes("window.addEventListener('beforeunload'"), 'F5 / tab close warns');
  assert.ok(quiz.includes('paused={confirmExit}'), 'no keyboard answering under the dialog');
  const t = f.PLACEMENT_TEXT.vi;
  assert.equal(t.exitBody(28, 30), 'Bạn đang làm dở bài xếp lớp (28/30). Tiến độ của bạn đã được lưu. Bạn có chắc muốn thoát?');
  assert.equal(t.keepGoing, 'Tiếp tục làm');
  assert.equal(t.exitQuiz, 'Thoát bài');
});
test('autosave (debounced PUT /progress), "Đã lưu lúc HH:mm", resume (same questions + answers), no silent second attempt', () => {
  const quiz = read('components', 'features', 'leaderboard', 'PlacementQuiz.tsx');
  const api = read('services', 'leaderboardApi.ts');
  assert.ok(api.includes('/proficiency/placement/${attemptId}/progress') && api.includes("'/proficiency/placement/active'")
    && api.includes('/proficiency/placement/${attemptId}/abandon') && api.includes('params: { replace: true }'));
  assert.ok(quiz.includes('PLACEMENT_SAVE_DEBOUNCE_MS = 400') && quiz.includes('queueSave(issue.attemptId, next)'));
  assert.ok(quiz.includes('data-testid="placement-resume"') && quiz.includes('data-testid="placement-restart-confirm"'));
  assert.ok(quiz.includes("httpMessage(e).startsWith('ACTIVE_ATTEMPT')"), '409 ACTIVE_ATTEMPT ⇒ resume screen, never a new attempt');
  assert.ok(!/localStorage|sessionStorage/.test(quiz), 'progress lives on the server (no answer keys / answers in browser storage)');
  assert.equal(f.placementSavedLine('2026-10-02T08:42:00Z'), 'Đã lưu lúc 15:42', 'Asia/Ho_Chi_Minh');
  assert.equal(f.PLACEMENT_TEXT.vi.resumeTitle, 'Bạn có bài xếp lớp đang làm dở');
  assert.equal(f.PLACEMENT_TEXT.vi.resumeProgress(28, 30), 'Đã hoàn thành 28/30 câu');
  assert.ok(read('components', 'features', 'leaderboard', 'PlacementCtaCard.tsx').includes('data-testid="placement-resume-card"'));
});
test('submit failure keeps answers and offers "Gửi bài" again; result is an estimate, not a certificate', () => {
  const quiz = read('components', 'features', 'leaderboard', 'PlacementQuiz.tsx');
  assert.ok(quiz.includes("setPhase('submitPending')") && quiz.includes('data-testid="placement-resubmit"'));
  assert.equal(f.PLACEMENT_TEXT.vi.resultTitle, 'Ước lượng ban đầu');
  assert.ok(f.PLACEMENT_TEXT.vi.resultDisclaimer.includes('không phải chứng chỉ'));
  assert.ok(!JSON.stringify(f.PLACEMENT_TEXT.vi).includes('Trình độ chính xác'));
});
test('Năng lực card shows BOTH paths: quick placement primary, standardized exam optional', () => {
  const und = f.proficiencyHeaderState({ eligible: false, hidden: false, rank: null, ineligibleReason: 'UNDETERMINED' }, null);
  const placed = f.proficiencyHeaderState({ eligible: false, hidden: false, rank: null, ineligibleReason: 'UNDETERMINED' }, null, 'vi', 'B1');
  const verified = f.proficiencyHeaderState({ eligible: true, hidden: false, rank: 2, ineligibleReason: null }, null);
  assert.equal(f.proficiencyPathsMode(und), 'NONE');
  assert.equal(f.proficiencyPathsMode(placed), 'PLACEMENT');
  assert.equal(f.proficiencyPathsMode(verified), null, 'verified learners keep the authoritative rank card');
  assert.equal(f.proficiencyPathsMode(null), null, 'EXCLUDED / loading ⇒ nothing');
  const P = f.PATHS_TEXT.vi;
  assert.equal(P.quickMeta(30), 'Khoảng 4 phút · 30 câu');
  assert.equal(P.quickSkills, 'Từ vựng + Ngữ pháp');
  assert.equal(P.quickCta, 'Làm bài xếp lớp nhanh');
  assert.equal(P.quickRetake, 'Làm lại bài xếp lớp nhanh');
  assert.equal(P.stdCta, 'Thi để xác thực');
  assert.equal(P.stdVerifyCta, 'Xác thực bằng bài thi chuẩn hóa');
  assert.equal(P.optional, 'Tùy chọn');
  assert.equal(P.placementEstimate, 'Ước lượng ban đầu từ bài xếp lớp nhanh.');
  assert.equal(P.emptyPlaced('B1'), 'Bạn đang ở B1 theo bài xếp lớp nhanh.');
  for (const k of Object.keys(f.PATHS_TEXT.vi)) assert.ok(k in f.PATHS_TEXT.en, `en ${k}`);
  const card = read('components', 'features', 'leaderboard', 'ProficiencyPathsCard.tsx');
  assert.ok(card.includes('data-testid="paths-quick"') && card.includes('data-testid="paths-standardized"'));
  assert.ok(card.includes('grid grid-cols-1 gap-3 sm:grid-cols-2'), 'stacked on mobile, two columns on desktop');
  assert.ok(card.includes('border-2 border-cyan-400/60') && card.includes('{p.optional}'), 'quick = primary, standardized = optional');
  assert.ok(!/Sparkles|✨/.test(card));
  assert.ok(read('components', 'features', 'leaderboard', 'ProficiencyHeaderCard.tsx').includes('<ProficiencyPathsCard mode={pathsMode}'));
});
test('Năng lực groups below the ranked list: "Đang xác thực", "Theo bài xếp lớp", "N người chưa xác định trình độ"', () => {
  assert.equal(f.OTHERS_TEXT.vi.verifying, 'Đang xác thực');
  assert.equal(f.OTHERS_TEXT.vi.placement, 'Theo bài xếp lớp');
  assert.equal(f.undeterminedCountLine(1240), '1.240 người chưa xác định trình độ');
  const tab = read('components', 'features', 'leaderboard', 'ProficiencyBoardTab.tsx');
  assert.ok(tab.includes('useProficiencyOthers(board, division)') && tab.includes('others-verifying') && tab.includes('others-placement'));
  assert.ok(tab.includes('rank={null}'), 'groups have no rank');
  assert.ok(read('services', 'leaderboardApi.ts').includes("'/leaderboard/proficiency/others'"));
});
test('promotion notice when the anti-sandbagging rule raised the division', () => {
  assert.equal(f.promotionNotice('B2', 'TRUNG_CAP'),
    'Bạn đã được nâng lên B2 (giải Trung cấp) vì phần lớn điểm gần đây đến từ nội dung khó hơn trình độ xếp lớp.');
  assert.equal(f.promotionNotice(null, 'TRUNG_CAP'), null);
  const tab = read('components', 'features', 'leaderboard', 'ActivityBoardTab.tsx');
  assert.ok(tab.includes('<PromotionNotice me={me.data}') && tab.includes('data-testid="promotion-notice"'));
});

// 9. Gamification UX v2 (frontend only; data from the existing endpoints)
test('season badge = VN ISO week (Monday start), same boundary as the WEEK board', () => {
  assert.deepEqual(f.seasonWeek(new Date('2026-10-02T03:00:00Z')), { week: 40, year: 2026 });
  assert.deepEqual(f.seasonWeek(new Date('2026-10-04T16:59:00Z')), { week: 40, year: 2026 }, 'Sun 23:59 VN');
  assert.deepEqual(f.seasonWeek(new Date('2026-10-04T17:00:00Z')), { week: 41, year: 2026 }, 'Mon 00:00 VN');
  assert.deepEqual(f.seasonWeek(new Date('2027-01-01T05:00:00Z')), { week: 53, year: 2026 }, 'ISO year rollover');
  assert.equal(f.seasonLabel(new Date('2026-10-02T03:00:00Z')), 'Mùa giải · Tuần 40/2026');
});
test('next-rank progress derives only from /activity/me', () => {
  assert.equal(f.nextRankProgress({ rank: 7, points: 150, pointsToNextRank: 50 }), 75);
  assert.equal(f.nextRankProgress({ rank: 1, points: 900, pointsToNextRank: null }), 100);
  assert.equal(f.nextRankProgress({ rank: null, points: 0, pointsToNextRank: null }), 0);
  assert.equal(f.nextRankProgress(undefined), 0);
});
test('motivation line: rival name from the loaded list, never the "Người học" fallback, top group, leader, start', () => {
  const items = [
    { rank: 1, userId: 1, displayName: 'An' }, { rank: 2, userId: 2, displayName: 'Bình' },
    { rank: 5, userId: 5, displayName: 'Nguyễn A' }, { rank: 6, userId: 6, displayName: 'Người học' },
  ];
  assert.deepEqual(f.motivationLine({ userId: 9, rank: 6, pointsToNextRank: 12, nextRank: 5 }, items),
    { tone: 'chase', text: 'Còn 12 XP để vượt Nguyễn A' });
  assert.equal(f.motivationLine({ userId: 9, rank: 7, pointsToNextRank: 3, nextRank: 6 }, items).text, 'Còn 3 XP để vượt hạng 6');
  assert.equal(f.motivationLine({ userId: 9, rank: 30, pointsToNextRank: 4, nextRank: 29 }, items).text, 'Còn 4 XP để vượt hạng 29',
    'rival outside the loaded top list ⇒ rank number');
  assert.deepEqual(f.motivationLine({ userId: 2, rank: 2, pointsToNextRank: 8, nextRank: 1 }, items),
    { tone: 'top', text: 'Bạn đang ở nhóm dẫn đầu · Còn 8 XP để vượt An' });
  assert.deepEqual(f.motivationLine({ userId: 1, rank: 1, pointsToNextRank: null, nextRank: null }, items),
    { tone: 'lead', text: 'Bạn đang dẫn đầu bảng xếp hạng' });
  assert.equal(f.motivationLine({ userId: 9, rank: null, pointsToNextRank: null }, items).tone, 'start');
  assert.equal(f.motivationLine({ userId: 9, rank: null, pointsToNextRank: null, points: 0, eligibility: 'NO_POINTS' }, items).tone, 'start');
  assert.equal(f.motivationLine(undefined, items), null);
  assert.equal(f.FALLBACK_DISPLAY_NAME, 'Người học');
  assert.ok(f.isFallbackName('Học viên #664') && f.isFallbackName('Người học') && !f.isFallbackName('Lan'));
  assert.equal(f.motivationLine({ userId: 9, rank: 7, pointsToNextRank: 3, nextRank: 6 },
    [{ rank: 6, userId: 6, displayName: 'Học viên #6' }]).text, 'Còn 3 XP để vượt hạng 6', 'fallback names are never used as rivals');
});
test('"Hạng của bạn": zero state only when the selected period really has 0 points (277 XP ⇒ never "Chưa có điểm")', () => {
  const admin = { rank: null, points: 277, pointsToNextRank: null, eligibility: 'EXCLUDED' };
  assert.equal(f.myRankText(admin).rank, 'Không tham gia xếp hạng');
  assert.equal(f.motivationLine(admin, []), null, 'no "ghi điểm đầu tiên" next to existing XP (11 L35)');
  assert.ok(f.eligibilityNote(admin).includes('Điểm vẫn được ghi nhận'));
  const notPlaced = { rank: null, points: 120, pointsToNextRank: null, eligibility: 'PLACEMENT_REQUIRED' };
  assert.equal(f.myRankText(notPlaced).rank, 'Chưa vào bảng xếp hạng');
  assert.ok(f.eligibilityNote(notPlaced).includes('bài xếp lớp'));
  assert.equal(f.motivationLine(notPlaced, []), null);
  assert.equal(f.myRankText({ rank: null, points: 40, pointsToNextRank: null, eligibility: 'PENDING' }).rank, 'Đang cập nhật hạng…');
  assert.equal(f.myRankText({ rank: null, points: 40, pointsToNextRank: null }).rank, 'Đang cập nhật hạng…', 'older API: points decide');
  assert.equal(f.myRankText({ rank: null, points: 0, pointsToNextRank: null, eligibility: 'NO_POINTS' }).rank, 'Chưa có điểm trong kỳ này');
  assert.equal(f.myRankText({ rank: null, points: 30, pointsToNextRank: null, eligibility: 'OTHER_DIVISION' }).rank, 'Không thuộc giải này');
  assert.equal(f.myRankText({ rank: 4, points: 30, pointsToNextRank: 5, nextRank: 3 }).rank, '#4');
  assert.equal(f.widgetLines({ rank: null, scope: 'GLOBAL', points: 277, eligibility: 'EXCLUDED' }, null).rank, 'Không tham gia xếp hạng');
  assert.equal(f.widgetLines({ rank: null, scope: 'GLOBAL', points: 0, eligibility: 'PLACEMENT_REQUIRED' }, null).rank,
    'Làm bài xếp lớp để vào bảng xếp hạng');
  const bar = read('components', 'features', 'leaderboard', 'MyActivityBar.tsx');
  assert.ok(bar.includes('eligibilityNote(me, locale)') && bar.includes("status === 'PLACEMENT_REQUIRED'") && bar.includes('<PlacementQuizButton'));
});
test('ranked list continues after the podium (#4 …) with "Xem thêm", never repeating podium rows', () => {
  const tab = read('components', 'features', 'leaderboard', 'ActivityBoardTab.tsx');
  assert.ok(tab.includes('items.slice(0, 3)') && tab.includes('items.slice(3)'), 'podium 1–3, list from #4');
  assert.ok(tab.includes('data-testid="ranked-load-more"') && tab.includes('MAX_ROWS = 100'));
  assert.ok(read('services', 'leaderboardApi.ts').includes('limit'));
});
test('empty state: title / body / CTA, no fake rows; unranked list collapsed and lazy', () => {
  assert.equal(f.UX_TEXT.vi.emptyTitle, 'Bắt đầu hành trình xếp hạng');
  assert.equal(f.UX_TEXT.vi.emptyBody, 'Học tập để tên bạn xuất hiện trên bảng xếp hạng.');
  for (const k of Object.keys(f.UX_TEXT.vi)) assert.ok(k in f.UX_TEXT.en, `en label ${k}`);
  assert.equal(f.EMPTY_CTA_HREF, '/flashcards');
  const tab = read('components', 'features', 'leaderboard', 'ActivityBoardTab.tsx');
  assert.ok(tab.includes('UX_TEXT[locale].emptyTitle') && tab.includes('href={EMPTY_CTA_HREF}'));
  assert.ok(tab.includes('aria-expanded={open}') && tab.includes('setOpen(false)'), 'unranked list collapsed by default');
  assert.ok(!/load\(null, true\);\s*\/\/ eslint/.test(tab), 'unranked list is not fetched on mount');
  assert.ok(read('components', 'features', 'leaderboard', 'BoardStates.tsx').includes('data-testid="board-empty"'));
});
test('podium: 96 / 72 px showcase avatars via AvatarWithFrame (no new renderer); rows stay static LOD', () => {
  const podium = read('components', 'features', 'leaderboard', 'Podium.tsx');
  assert.ok(/AVATAR_PX[^=]*= \{ 1: 96, 2: 72, 3: 72 \}/.test(podium));
  assert.ok(podium.includes('showcasePx={compact ? undefined : px}'), 'showcase only on the full board podium');
  assert.ok(/initial=\{reduceMotion \? false : \{ scale: 0\.95/.test(podium), 'spring entrance from scale 0.95');
  const avatar = read('components', 'features', 'leaderboard', 'BoardAvatar.tsx');
  assert.ok(avatar.includes('<AvatarWithFrame') && avatar.includes('context="leaderboard"'));
  const row = read('components', 'features', 'leaderboard', 'BoardRowCard.tsx');
  assert.ok(!row.includes('showcasePx') && !row.includes('framer-motion'), 'list rows: no showcase, no JS animation');
  assert.ok(row.includes('motion-reduce:transition-none'));
});
test('hero + filters: reduced motion respected, icons on period / skill chips, rank card progress bar', () => {
  const hero = read('components', 'features', 'leaderboard', 'LeaderboardHero.tsx');
  assert.ok(hero.includes('useReducedMotion()') && /reduceMotion \? undefined : \{/.test(hero));
  assert.ok(read('components', 'features', 'leaderboard', 'LeaderboardPage.tsx').includes('<LeaderboardHero'));
  const chips = read('components', 'features', 'leaderboard', 'ChipGroup.tsx');
  assert.ok(chips.includes('useReducedMotion()') && chips.includes('layoutId'));
  const tab = read('components', 'features', 'leaderboard', 'ActivityBoardTab.tsx');
  assert.ok(tab.includes('PERIOD_ICONS[o.id]') && tab.includes('GROUP_ICONS[o.id]'));
  const bar = read('components', 'features', 'leaderboard', 'MyActivityBar.tsx');
  assert.ok(bar.includes('role="progressbar"') && bar.includes('nextRankProgress(me)') && bar.includes('motivationLine(me, items, locale)'));
});

// ---- Placement result lifecycle (UX hotfix 2026-10-02) ----------------------------------------------------------------
const store = (await import(new URL('../src/lib/leaderboard/placementQuizStore.ts', import.meta.url).href)).placementQuizStore;
test('placement modal lives in one app-wide host: the eligibility flip after a submit cannot unmount the result', () => {
  const quiz = read('components', 'features', 'leaderboard', 'PlacementQuiz.tsx');
  const btn = quiz.slice(quiz.indexOf('export function PlacementQuizButton'));
  assert.ok(btn.includes('placementQuizStore.open(locale)') && !btn.includes('<PlacementQuizModal') && !btn.includes('useState'),
    'entry buttons (hidden once placed) own no modal state');
  const host = read('components', 'features', 'leaderboard', 'PlacementQuizHost.tsx');
  assert.ok(host.includes('useSyncExternalStore(placementQuizStore.subscribe') && host.includes('<PlacementQuizModal')
    && host.includes('onViewLevel={placementQuizStore.showLevel}') && host.includes('<ProficiencyCardContent'));
  assert.ok(host.includes('placementQuizStore.close();') && host.includes('[pathname]'), 'route change closes it (as the old unmount did)');
  assert.ok(!/eligibilityOf|usePlacementMe|useActivityMe|useProficiencyMe|placementCompleted|resultCefr/.test(host),
    'host reads no eligibility / placement data, so a revalidation can never close it');
  assert.ok(read('app', 'providers.tsx').includes('<PlacementQuizHost />'), 'mounted once, outside every page tree');
  const submit = quiz.slice(quiz.indexOf('const submit = useCallback'), quiz.indexOf('const answer = useCallback'));
  assert.ok(submit.includes('revalidateLevelCaches()') && !/onClose|placementQuizStore/.test(submit),
    'submit refreshes the caches in the background and never closes the modal');
});
test('placement store: idempotent open, level view, explicit close only', () => {
  const seen = [];
  const off = store.subscribe(() => seen.push(store.getSnapshot()));
  store.open('vi');
  store.open('vi');
  assert.equal(seen.length, 1, 'double click opens once');
  assert.deepEqual(store.getSnapshot(), { open: true, view: 'quiz', locale: 'vi' });
  store.showLevel();
  assert.deepEqual(store.getSnapshot(), { open: true, view: 'level', locale: 'vi' });
  store.close();
  assert.deepEqual(store.getSnapshot(), { open: false, view: 'quiz', locale: 'vi' });
  store.showLevel();
  assert.equal(store.getSnapshot().open, false, 'level view never opens a closed modal');
  off();
});
test('result view: X / 30 câu đúng, CEFR, "Ước lượng ban đầu", "Theo bài xếp lớp", explicit actions only', () => {
  const r = { vocabulary: { correct: 13, total: 15 }, grammar: { correct: 11, total: 15 } };
  assert.equal(f.placementCorrectLine(r), '24 / 30 câu đúng');
  assert.equal(f.placementCorrectLine(r, 'en'), '24 / 30 correct');
  assert.equal(f.placementCorrectLine({ vocabulary: r.vocabulary }), null);
  const t = f.PLACEMENT_TEXT.vi;
  assert.equal(t.resultTitle, 'Ước lượng ban đầu');
  assert.equal(t.resultSource, 'Theo bài xếp lớp');
  assert.equal(t.viewBoard, 'Xem bảng xếp hạng');
  assert.equal(t.viewLevel, 'Xem trình độ của bạn');
  for (const k of Object.keys(f.PLACEMENT_TEXT.vi)) assert.ok(k in f.PLACEMENT_TEXT.en, `en ${k}`);
  const quiz = read('components', 'features', 'leaderboard', 'PlacementQuiz.tsx');
  const result = quiz.slice(quiz.indexOf("phase === 'result' && result"), quiz.indexOf("phase === 'invalid'"));
  for (const id of ['placement-result-cefr', 'placement-result-correct', 'placement-view-board', 'placement-view-level', 'placement-result-close'])
    assert.ok(result.includes(`data-testid="${id}"`), id);
  assert.ok(result.includes('t.resultDisclaimer') && result.includes('t.optionalVerify'), 'estimate from vocabulary + grammar; exam optional');
  assert.ok(!/setTimeout|useEffect/.test(result), 'no timer closes the result');
});

console.log(`\n=== ${passed} leaderboard UI contract tests PASSED ===`);
