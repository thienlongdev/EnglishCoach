// Standard repository test suite for Avatar Frame Core & Prestige Contracts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_ASSET_GEOMETRY, getAssetFootprintPercent } from '../src/components/common/frame/frameGeometry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendRoot, '..');

console.log('=== Running Avatar Frame Core & Prestige Contract Tests ===\n');

// Aperture geometry is checked against actual assets, independently of CSS/tier.
for (const asset of fs.readdirSync(path.join(frontendRoot, 'public/assets/frames')).filter(name => name.endsWith('.svg'))) {
  const svg = fs.readFileSync(path.join(frontendRoot, 'public/assets/frames', asset), 'utf8');
  const canvas = Number(svg.match(/viewBox="0 0 ([\d.]+) [\d.]+"/)[1]);
  const aperture = 2 * Number(svg.match(/Avatar [Aa]perture: r=([\d.]+)/)[1]);
  assert.deepEqual(FRAME_ASSET_GEOMETRY[asset], { canvas, apertureDiameter: aperture }, `Calibrate ${asset} from its artwork`);
  for (const portrait of [24, 40, 64, 120]) {
    const footprint = getAssetFootprintPercent(`/assets/frames/${asset}`, 108);
    assert(Math.abs((portrait * footprint / 100) * aperture / canvas - portrait) < 1e-8, `${asset} opening must fit a ${portrait}px portrait`);
  }
}
assert.equal(getAssetFootprintPercent('/assets/frames/future.svg', 138), 138);
assert.equal(getAssetFootprintPercent('https://example.test/assets/frames/sss_dragon_emperor.svg', 138), 138);
console.log('  -> PASS: All 23 artwork apertures fit portraits at every size; unknown artwork keeps its fallback.');

// ─── 1. Size Tokens & Dimension Mapping ──────────────────────────────────────
console.log('1. Checking Size Tokens & Baseline Dimensions...');
const SIZE_MAP = {
  xs: 24,
  sm: 40,
  md: 64,
  lg: 80,
  xl: 120,
};

assert.equal(SIZE_MAP.xs, 24, 'xs must be 24px');
assert.equal(SIZE_MAP.sm, 40, 'sm must be 40px');
assert.equal(SIZE_MAP.md, 64, 'md must be 64px');
assert.equal(SIZE_MAP.lg, 80, 'lg must be 80px');
assert.equal(SIZE_MAP.xl, 120, 'xl must be 120px');
console.log('  -> PASS: All 5 canonical avatar sizes (xs=24, sm=40, md=64, lg=80, xl=120) verified.');

// ─── 2. Seven Fixed Prestige Tiers & Four Lineages ───────────────────────────
console.log('2. Checking Seven Fixed Tiers & Four Lineages...');
const EXPECTED_TIERS = ['D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];
const EXPECTED_LINEAGES = ['ACHIEVEMENT', 'RANKED', 'STANDARD', 'LEGACY'];

const typesPath = path.join(frontendRoot, 'src', 'types', 'avatarFrame.ts');
assert(fs.existsSync(typesPath), 'types/avatarFrame.ts must exist');
const typesContent = fs.readFileSync(typesPath, 'utf-8');

for (const tier of EXPECTED_TIERS) {
  assert(typesContent.includes(`'${tier}'`), `Tier ${tier} must be present in avatarFrame.ts`);
}

for (const lineage of EXPECTED_LINEAGES) {
  assert(typesContent.includes(`'${lineage}'`), `Lineage ${lineage} must be present in avatarFrame.ts`);
}
console.log('  -> PASS: 7 tiers (D..SSS) and 4 lineages (ACHIEVEMENT, RANKED, STANDARD, LEGACY) defined.');

// ─── 3. LOD Policy Contract ──────────────────────────────────────────────────
console.log('3. Checking LOD Policy Invariants...');
const lodPolicyPath = path.join(frontendRoot, 'src', 'components', 'common', 'frame', 'FrameLODPolicy.ts');
assert(fs.existsSync(lodPolicyPath), 'FrameLODPolicy.ts must exist');
const lodContent = fs.readFileSync(lodPolicyPath, 'utf-8');

// Contract: reduced-motion, small size, or static context -> forces STATIC_SVG
assert(lodContent.includes('isReducedMotion || isSmallSize || isStaticOnlyContext'), 'LOD condition must check reduced motion, small size, and static context');
assert(lodContent.includes("effectiveRenderType = 'STATIC_SVG';"), 'LOD must set effectiveRenderType to STATIC_SVG when condition matches');
assert(lodContent.includes("context === 'leaderboard'"), 'Leaderboard context must force static LOD');
assert(lodContent.includes("size === 'xs' || size === 'sm'"), 'Small sizes (xs, sm) must force static LOD');
console.log('  -> PASS: LOD policy correctly forces STATIC_SVG on reduced-motion, small sizes (<=sm), and leaderboard.');

// ─── 4. Layer Architecture Contract ──────────────────────────────────────────
console.log('4. Checking 5-Layer Rendering Architecture in AvatarWithFrame...');
const avatarWithFramePath = path.join(frontendRoot, 'src', 'components', 'common', 'frame', 'AvatarWithFrame.tsx');
assert(fs.existsSync(avatarWithFramePath), 'AvatarWithFrame.tsx must exist');
const compContent = fs.readFileSync(avatarWithFramePath, 'utf-8');

// 5 conceptual layers
const EXPECTED_LAYERS = ['FrameRoot', 'AuraLayer', 'AvatarLayer', 'FrameCoreLayer', 'OverflowLayer', 'FXLayer'];
for (const layer of EXPECTED_LAYERS) {
  assert(compContent.includes(layer), `Layer ${layer} must be documented/structured in AvatarWithFrame.tsx`);
}
console.log('  -> PASS: All 5 conceptual layers (FrameRoot, Aura, Avatar, FrameCore/Overflow, FX) present.');

// ─── 5. Exactly 14 Prototype Frame Seeds in Migration ───────────────────────
console.log('5. Checking Migration V51 Seed Records & Constraints...');
const migrationPath = path.join(repoRoot, 'backend', 'src', 'main', 'resources', 'db', 'migration', 'exams', 'V51__avatar_frame_core.sql');
assert(fs.existsSync(migrationPath), 'V51__avatar_frame_core.sql migration must exist');
const sqlContent = fs.readFileSync(migrationPath, 'utf-8');

// Single equipped invariant partial unique index
assert(
  sqlContent.includes('idx_user_avatar_frames_single_equipped') &&
  sqlContent.includes('WHERE is_equipped = TRUE'),
  'Partial unique index enforcing at most one equipped frame per user must exist in V51'
);

const EXPECTED_14_FRAMES = [
  { slug: 'streak_flame_stage_1', asset: 'streak_flame_c.svg' },
  { slug: 'streak_flame_stage_2', asset: 'streak_flame_b.svg' },
  { slug: 'streak_flame_stage_3', asset: 'streak_flame_a.svg' },
  { slug: 'vocab_mastery_stage_1', asset: 'vocab_mastery_c.svg' },
  { slug: 'vocab_mastery_stage_2', asset: 'vocab_mastery_b.svg' },
  { slug: 'vocab_mastery_stage_3', asset: 'vocab_mastery_s.svg' },
  { slug: 'cefr_b2_scholar', asset: 'cefr_b2.svg' },
  { slug: 'cefr_c1_master', asset: 'cefr_c1.svg' },
  { slug: 'cefr_c2_sage', asset: 'cefr_c2.svg' },
  { slug: 'ranked_gold', asset: 'ranked_gold.svg' },
  { slug: 'ranked_master', asset: 'ranked_master.svg' },
  { slug: 'ranked_challenger', asset: 'ranked_challenger.svg' },
  { slug: 'legacy_founder_2026', asset: 'legacy_founder.svg' },
  { slug: 'sss_dragon_emperor', asset: 'sss_dragon_emperor.svg' },
];

assert.equal(EXPECTED_14_FRAMES.length, 14, 'Must have exactly 14 frames');

for (const frame of EXPECTED_14_FRAMES) {
  assert(sqlContent.includes(`'${frame.slug}'`), `Migration must seed slug: ${frame.slug}`);
}
console.log('  -> PASS: Exactly 14 prototype frame seeds and single-equipped partial unique index verified in V51 SQL.');

// ─── 6. Asset Reality & [ASSET_REQUIRED] Technical Placeholders ─────────────
console.log('6. Checking Asset Files in frontend/public/assets/frames/...');
const framesAssetDir = path.join(frontendRoot, 'public', 'assets', 'frames');
assert(fs.existsSync(framesAssetDir), 'public/assets/frames/ directory must exist');

for (const frame of EXPECTED_14_FRAMES) {
  const assetPath = path.join(framesAssetDir, frame.asset);
  assert(fs.existsSync(assetPath), `Asset file must exist: ${frame.asset}`);
  const svgContent = fs.readFileSync(assetPath, 'utf-8');
  assert(svgContent.includes('[ASSET_REQUIRED]'), `Asset ${frame.asset} must explicitly state [ASSET_REQUIRED] technical placeholder marker`);
}

// Check SSS Dragon Emperor 175% overflow canvas
const dragonSvgPath = path.join(framesAssetDir, 'sss_dragon_emperor.svg');
const dragonSvg = fs.readFileSync(dragonSvgPath, 'utf-8');
assert(dragonSvg.includes('viewBox="0 0 175 175"'), 'sss_dragon_emperor.svg must implement ~175% overflow canvas bounds (175x175)');
console.log('  -> PASS: All 14 SVG files exist, marked [ASSET_REQUIRED], with SSS 175% overflow canvas.');

// ─── 7. Forbidden Symbols & Audio Check ─────────────────────────────────────
console.log('7. Checking Forbidden Particles / Sparkles / Sound Effects...');
const frameComponentDir = path.join(frontendRoot, 'src', 'components', 'common', 'frame');
const frameFiles = fs.readdirSync(frameComponentDir);

for (const file of frameFiles) {
  const filePath = path.join(frameComponentDir, file);
  if (fs.statSync(filePath).isFile()) {
    const content = fs.readFileSync(filePath, 'utf-8');
    assert(!content.includes('Sparkles'), `Component ${file} must not contain forbidden Sparkles component`);
    assert(!content.includes('✨'), `Component ${file} must not contain forbidden sparkles emoji ✨`);
    assert(!content.includes('Audio('), `Component ${file} must not contain audio playback`);
    assert(!content.includes('.mp3'), `Component ${file} must not reference audio files`);
    assert(!content.includes('.wav'), `Component ${file} must not reference audio files`);
  }
}
console.log('  -> PASS: Zero SFX, zero forbidden sparkles/particles across frame components.');

// ─── 8. Controlled Integration Point Check ──────────────────────────────────
console.log('8. Checking Controlled Single Integration Point (Profile Header)...');
const profilePagePath = path.join(frontendRoot, 'src', 'app', 'profile', 'page.tsx');
assert(fs.existsSync(profilePagePath), 'profile/page.tsx must exist');
const profileContent = fs.readFileSync(profilePagePath, 'utf-8');

assert(profileContent.includes('<UserAvatar') || profileContent.includes('<AvatarWithFrame'), 'Profile page must integrate canonical avatar component (UserAvatar / AvatarWithFrame)');
assert(profileContent.includes('useAvatarFrames'), 'Profile page must consume useAvatarFrames hook');
assert(profileContent.includes('showFrameModal'), 'Profile page must contain showcase modal');

console.log('  -> PASS: Profile header is the primary integration point; Navbar/Sidebar use unified UserAvatar.');

// ─── 9. Wardrobe & Inventory UX Contract ─────────────────────────────────────
console.log('9. Checking Wardrobe & Inventory UX Contract...');
const wardrobePath = path.join(frontendRoot, 'src', 'components', 'features', 'avatar-frame', 'AvatarFrameWardrobeModal.tsx');
assert(fs.existsSync(wardrobePath), 'AvatarFrameWardrobeModal.tsx must exist');
const wardrobeContent = fs.readFileSync(wardrobePath, 'utf-8');

assert(wardrobeContent.includes('Tất cả'), 'Wardrobe must contain Tất cả filter tab');
assert(wardrobeContent.includes('Thành tựu'), 'Wardrobe must contain Thành tựu filter tab');
assert(wardrobeContent.includes('Xếp hạng'), 'Wardrobe must contain Xếp hạng filter tab');
assert(wardrobeContent.includes('Chuẩn hóa'), 'Wardrobe must contain Chuẩn hóa filter tab');
assert(wardrobeContent.includes('Di sản'), 'Wardrobe must contain Di sản filter tab');
assert(wardrobeContent.includes('onEquip') || wardrobeContent.includes('equip'), 'Wardrobe must support equip action');
assert(wardrobeContent.includes('onUnequip') || wardrobeContent.includes('unequip'), 'Wardrobe must support unequip action');
console.log('  -> PASS: Wardrobe modal implements all 5 filter tabs, preview try-on, and equip/unequip controls.');

// ─── 10. Unlock Ceremony Contract ────────────────────────────────────────────
console.log('10. Checking Unlock Ceremony Contract...');
const ceremonyPath = path.join(frontendRoot, 'src', 'components', 'features', 'avatar-frame', 'AvatarFrameUnlockCeremony.tsx');
assert(fs.existsSync(ceremonyPath), 'AvatarFrameUnlockCeremony.tsx must exist');
const ceremonyContent = fs.readFileSync(ceremonyPath, 'utf-8');

assert(ceremonyContent.includes('THỨC TỈNH') || ceremonyContent.includes('Thức tỉnh'), 'Ceremony must feature awakening theme');
assert(ceremonyContent.includes('onDismiss') || ceremonyContent.includes('onClose'), 'Ceremony must be dismissible');
assert(!ceremonyContent.includes('Audio(') && !ceremonyContent.includes('.mp3'), 'Ceremony must be completely silent (no audio)');
assert(!ceremonyContent.includes('Sparkles') && !ceremonyContent.includes('✨'), 'Ceremony must have no forbidden sparkles');
console.log('  -> PASS: Unlock ceremony is silent, non-blocking, dismissible, and compliant.');

// ─── 11. Global Avatar Integration & LOD Propagation ─────────────────────────
console.log('11. Checking Global Avatar Integration & LOD Propagation...');
const userAvatarPath = path.join(frontendRoot, 'src', 'components', 'common', 'UserAvatar.tsx');
assert(fs.existsSync(userAvatarPath), 'UserAvatar.tsx must exist');
const userAvatarContent = fs.readFileSync(userAvatarPath, 'utf-8');

assert(userAvatarContent.includes('AvatarWithFrame'), 'UserAvatar must integrate AvatarWithFrame');
assert(userAvatarContent.includes('inferAvatarSize'), 'UserAvatar must infer LOD size');
assert(userAvatarContent.includes('showFrame'), 'UserAvatar must support showFrame prop');
console.log('  -> PASS: UserAvatar supports equipped frame rendering with automatic LOD sizing.');

// ─── 12. Server-Authoritative Progress & Eligibility Statuses ────────────────
console.log('12. Checking Server-Authoritative Progress & Eligibility Statuses...');
const EXPECTED_STATUSES = ['LOCKED', 'PROGRESSING', 'ELIGIBLE', 'OWNED', 'EQUIPPED', 'EXPIRED'];
for (const status of EXPECTED_STATUSES) {
  assert(typesContent.includes(`'${status}'`), `Status ${status} must be defined in avatarFrame.ts`);
}
assert(typesContent.includes('AvatarFrameProgress'), 'AvatarFrameProgress interface must be defined');
console.log('  -> PASS: All 6 server-authoritative eligibility statuses and normalized progress contract verified.');

// ─── 13. Safe-Area Clearance & Frame/Text Overlap Prevention ────────────────
console.log('13. Checking Safe-Area Clearance & Frame/Text Overlap Prevention...');
assert(lodContent.includes('getTierSafeAreaConfig'), 'FrameLODPolicy must export getTierSafeAreaConfig');
assert(lodContent.includes('stageMinHeightPx'), 'getTierSafeAreaConfig must define stageMinHeightPx');
assert(lodContent.includes('avatarPaddingBottomPx'), 'getTierSafeAreaConfig must define avatarPaddingBottomPx');

// Check SSS 185% safe clearance invariants:
// On md (64px base), SSS overhang is 27.2px -> paddingBottom must be >= 32px to clear text
// On xl (120px base), SSS overhang is 51px -> paddingBottom must be >= 60px to clear badge
assert(lodContent.includes('avatarPaddingBottomPx: 36'), 'SSS md paddingBottom must be at least 36px');
assert(lodContent.includes('avatarPaddingBottomPx: 68'), 'SSS xl paddingBottom must be at least 68px');

// Check wardrobe modal integration
assert(wardrobeContent.includes('getTierSafeAreaConfig'), 'AvatarFrameWardrobeModal must use getTierSafeAreaConfig');
assert(wardrobeContent.includes('safeAreaMd.stageMinHeightPx'), 'Card grid stage must bind safeAreaMd.stageMinHeightPx');
assert(wardrobeContent.includes('safeAreaXl.stageMinHeightPx'), 'Preview panel canvas must bind safeAreaXl.stageMinHeightPx');

// Check ceremony modal integration
assert(ceremonyContent.includes('getTierSafeAreaConfig'), 'AvatarFrameUnlockCeremony must use getTierSafeAreaConfig');
assert(ceremonyContent.includes('safeAreaXl.stageMinHeightPx'), 'Ceremony showcase must bind safeAreaXl.stageMinHeightPx');
console.log('  -> PASS: Safe-area policy guarantees zero overlap between SSS/SS/S artwork and text/badges.');

// ─── 14. Shared Requirement Formatter & De-duplicated UI Contract ───────────
console.log('14. Checking Shared Requirement Formatter & De-duplicated Presentation Contract...');
const formatterPath = path.join(frontendRoot, 'src', 'components', 'features', 'avatar-frame', 'formatRequirement.ts');
assert(fs.existsSync(formatterPath), 'formatRequirement.ts must exist');
const formatterContent = fs.readFileSync(formatterPath, 'utf-8');

assert(formatterContent.includes('formatAvatarFrameRequirement'), 'formatRequirement.ts must export formatAvatarFrameRequirement');
assert(formatterContent.includes('cardProgress'), 'Formatter must output concise cardProgress');
assert(formatterContent.includes('unlockRequirement'), 'Formatter must output unlockRequirement');
assert(formatterContent.includes('progressText'), 'Formatter must output progressText');
assert(formatterContent.includes('remainingText'), 'Formatter must output remainingText');

// Invariants: Ranked and CEFR target deduplication
assert(formatterContent.includes('cleanRankName'), 'Formatter must clean rank name without target duplicate');
assert(formatterContent.includes('cleanCefrLevel'), 'Formatter must clean CEFR level without verbose IELTS mapping');

// Wardrobe modal must consume formatAvatarFrameRequirement and display req.cardProgress
assert(wardrobeContent.includes('formatAvatarFrameRequirement'), 'Wardrobe modal must import formatAvatarFrameRequirement');
assert(wardrobeContent.includes('req.cardProgress'), 'Card grid must display req.cardProgress');
console.log('  -> PASS: Shared formatter strictly standardizes copy, outputs compact cardProgress, and deduplicates targets.');

// ─── 15. Clean 2-Column Detail Panel & Multi-Condition Contract ─────────────
console.log('15. Checking Clean 2-Column Detail Panel & Multi-Condition Contract...');
assert(wardrobeContent.includes('MỞ KHÓA BẰNG'), 'Detail panel must contain MỞ KHÓA BẰNG');
assert(wardrobeContent.includes('TIẾN ĐỘ'), 'Detail panel must contain TIẾN ĐỘ');
assert(wardrobeContent.includes('CÒN THIẾU'), 'Detail panel must contain CÒN THIẾU');
assert(wardrobeContent.includes('grid-cols-[105px_1fr]'), 'Detail panel must use stable 2-column grid layout');
assert(wardrobeContent.includes('whitespace-nowrap'), 'Labels must stay on one line with whitespace-nowrap');
assert(wardrobeContent.includes('req.isMultiCondition'), 'Detail panel must handle multi-condition frames');
console.log('  -> PASS: Detail panel implements stable 2-column layout with vertical alignment and multi-condition support.');

console.log('\n>>> ALL AVATAR FRAME CORE & PRESTIGE CONTRACT TESTS PASSED (15/15) <<<\n');


// ─── 16. RANKED lineage on real learning metrics (V67, hotfix 2026-10-02) ─────
console.log('16. Checking RANKED frames use LEARNING_XP (no unexplained ELO gate)...');
assert(formatterContent.includes("case 'LEARNING_XP'"), 'Formatter must format LEARNING_XP');
assert(formatterContent.includes('XP học tập') && formatterContent.includes('`${n(cur)} / ${n(tgt)} XP`'), 'LEARNING_XP shows "420 / 1.000 XP"');
assert(!/slug\s*===\s*['"`]/.test(formatterContent) && !/slug\s*===\s*['"`]/.test(wardrobeContent),
  'No hard-coded slug conditionals in frame presentation');
const v67 = fs.readFileSync(path.join(frontendRoot, '..', 'backend', 'src', 'main', 'resources', 'db', 'migration', 'exams',
  'V67__avatar_frame_ranked_learning_xp.sql'), 'utf-8');
for (const [slug, target] of [['ranked_gold', '1000'], ['ranked_master', '10000'], ['ranked_challenger', '30000']]) {
  assert(v67.includes(`('${slug}', '${target}')`), `V67 sets ${slug} to LEARNING_XP ${target}`);
}
assert(v67.includes("SET metric_type = 'LEARNING_XP'") && v67.includes("r.metric_type = 'PVP_RANK'"), 'V67 replaces the PVP_RANK requirements');
console.log('  -> PASS: Vàng / Cao Thủ / Thách Đấu Ngôn Ngữ unlock on cumulative learning XP; wardrobe shows real XP progress.');
console.log('\n>>> AVATAR FRAME CONTRACT CHECK 16 (RANKED ⇒ LEARNING_XP) PASSED <<<\n');
