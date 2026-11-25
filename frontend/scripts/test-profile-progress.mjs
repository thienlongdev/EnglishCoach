// Hồ sơ cá nhân + Tiến trình học tập "Echo Glass" (2026-10-22) and the sidebar overflow repair: presentation contracts.
// The pages are redesigned; their data and actions must stay the server's. Run: node scripts/test-profile-progress.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf-8');
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok ${name}`); };

const profile = read('app', 'profile', 'page.tsx');
const cabinet = read('components', 'features', 'profile', 'FrameCabinet.tsx');
const sessions = read('components', 'features', 'profile', 'ActiveSessionsCard.tsx');
const heatmap = read('components', 'features', 'profile', 'LearningHeatmapCard.tsx');
const proficiency = read('components', 'features', 'leaderboard', 'ProficiencyCard.tsx');
const progress = read('components', 'features', 'learning-path', 'LearningProgressPage.tsx');
const shellCss = read('components', 'layout', 'WorkspaceShell.module.css');
const uiFiles = [profile, cabinet, sessions, heatmap, progress, read('components', 'features', 'avatar-frame', 'AvatarFrameWardrobeModal.tsx')];

test('profile keeps every existing action on its existing API call', () => {
  for (const call of ['userProfileApi.uploadAvatar(file)', 'userProfileApi.deleteAvatar()', 'userProfileApi.updateProfile({', 'userProfileApi.changePassword({',
    'await equipFrame(slug)', 'await unequipFrame()', 'reconcileFrames()', "logout('/login?passwordChanged=true')"]) {
    assert.ok(profile.includes(call), `missing ${call}`);
  }
  assert.ok(profile.includes('profile.canChangePassword ?'), 'password form only for accounts that can change it');
  assert.ok(profile.includes('<AvatarFrameWardrobeModal') && profile.includes('<AvatarFrameUnlockCeremony'));
});

test('the hero avatar is drawn at its real 120 px size (UserAvatar defaulted to 32 px before)', () => {
  assert.match(profile, /<UserAvatar\s+className="w-\[120px\] h-\[120px\] rounded-full"/);
});

test('frame cabinet shows server ownership / progress only and reuses the page handlers', () => {
  assert.ok(cabinet.includes('f.ownership?.equipped') && cabinet.includes("f.progress?.status === 'ELIGIBLE'"));
  assert.ok(cabinet.includes('formatAvatarFrameRequirement(') && cabinet.includes('onEquip(frame.slug)') && cabinet.includes('onClick={onUnequip}'));
  assert.ok(!/Math\.random|percent:\s*\d|ownerCount/.test(cabinet), 'no invented rarity, percentages or counts');
  assert.ok(cabinet.includes('context="leaderboard"'), 'dense tiles use the static LOD');
});

test('session rows keep confirmations, re-auth handling and test ids', () => {
  assert.ok(sessions.includes("window.confirm(t('Đăng xuất khỏi thiết bị này?'") && sessions.includes("window.confirm(t('Đăng xuất khỏi tất cả thiết bị khác?'"));
  assert.ok(sessions.includes('needsReauth(e)') && sessions.includes('data-testid="active-sessions-list"') && sessions.includes('data-testid="active-sessions-end-others"'));
});

test('heatmap: weekday rows, real values, no number before the server answers', () => {
  assert.ok(heatmap.includes('function weekdayIndex') && heatmap.includes('weekdayIndex(list[0].date)'), 'first column padded to the weekday');
  for (const key of ['currentStreakDays', 'longestStreakDays', 'activeDaysThisYear', 'activitiesThisMonth']) assert.ok(heatmap.includes(`data?.${key}`));
  assert.ok(heatmap.includes("value ?? '—'") && !/\?\?\s*0\b/.test(heatmap), 'a missing value is "—", never 0');
  assert.ok(heatmap.includes('userProfileApi.updateHeatmapTheme(themeKey)'), 'colour preference persists as before');
  assert.ok(heatmap.includes('tabIndex={last ? 0 : -1}') && heatmap.includes('handleGridKey'), 'one tab stop, arrow keys inside');
});

test('observatory tracks fill only for a determined server rating; dialogs keep the card view', () => {
  assert.ok(proficiency.includes("export type ProficiencyVariant = 'card' | 'observatory'"));
  assert.ok(/determined && <span className=\{glass\.trackFill\}/.test(proficiency));
  assert.ok(proficiency.includes('<ProficiencyCardContent locale={l} variant="observatory" />'));
  assert.ok(read('components', 'features', 'leaderboard', 'PlacementQuizHost.tsx').includes('<ProficiencyCardContent locale={s.locale} />'), 'placement dialog unchanged');
  assert.ok(progress.includes('<LearningHeatmapCard />') && progress.includes('<ProficiencyCard />') && progress.includes('href="/learning-path"'));
});

test('no sparkle glyphs, no markup sinks, no font-family in the new surfaces', () => {
  for (const s of uiFiles) {
    assert.ok(!/Sparkles|✨|dangerouslySetInnerHTML/.test(s));
  }
  for (const css of ['components/features/profile/profileGlass.module.css', 'components/features/learning-path/progressGlass.module.css']) {
    const c = read(...css.split('/'));
    assert.ok(!/font-family|backdrop-filter|!important/.test(c), `${css}: no font-family / backdrop blur / !important`);
  }
});

test('sidebar: entries shrink before the rail scrolls; real overflow still scrolls; nothing hidden', () => {
  assert.match(shellCss, /\.nav \{[^}]*display: flex; flex-direction: column;[^}]*min-height: 0;/);
  assert.match(shellCss, /\.nav \.item \{ flex-shrink: 1; min-height: 2rem; \}/);
  assert.match(shellCss, /\.nav \.sectionLabel \{ flex-shrink: 0; \}/);
  // the space between groups shrinks too (a fixed margin cannot): the 16-entry administrator rail fits at 864 px
  assert.match(shellCss, /\.nav \.divider \{ flex: 0 1\.5 [^;]+; height: [^;]+; min-height: 0\.5rem; margin: 0 0\.4rem;/);
  assert.match(shellCss, /\.nav\.navOpen \.divider \{ flex-basis: 0\.95rem; height: 0\.95rem; min-height: 0; margin: 0;/);
  assert.match(shellCss, /\.adminZone \{ display: contents; \}/);
  assert.ok(!/\.nav[^{]*\{[^}]*overflow-y: hidden/.test(shellCss), 'the nav never hides overflow');
  const sidebar = read('components', 'layout', 'Sidebar.tsx');
  assert.ok(sidebar.includes('overflow-y-auto overflow-x-hidden'), 'the nav stays the one scrolling region');
  // the expanded panel clips horizontally but is never a scroll container: `overflow-x: hidden` makes overflow-y auto,
  // and the equipped frame's canvas (a few px below the identity dock) then gave the whole panel a scrollbar (2026-10-22)
  assert.ok(sidebar.includes('`w-[252px] overflow-x-clip ${styles.drawerOpen}`'), 'expanded panel: overflow-x clip');
  assert.ok(!/w-\[252px\] overflow-x-hidden/.test(sidebar), 'expanded panel: never overflow-x hidden');
});

console.log(`Profile / Progress / sidebar overflow: ${passed} contract groups passed`);
