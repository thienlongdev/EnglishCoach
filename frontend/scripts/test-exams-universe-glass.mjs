// Thi thử "Echo Exam Universe" (2026-10-24): presentation contract + active-attempt isolation guard.
// The attempt route (preflight + runtime), runner chrome, renderers, workspaces, hooks, API, types and exam libs are
// FROZEN for this redesign: their contents are pinned below (CRLF-normalised SHA-256, first 24 hex). Changing one is an
// owner decision (the active exam UI is a separate, not yet commissioned redesign) — update the pin in the same change.
// Re-pinned 2026-10-30 (owner rule: no "&" in display copy): display strings only ("và" / "and"), no logic change.
// Re-pinned 2026-11-13 (owner brief: IELTS computer-delivered exam room): ExamRuntimeShell routes IELTS Reading / Listening /
// Writing to components/features/exams/ielts-cbt over the same runtime callbacks; guarded by scripts/test-ielts-cbt.mjs.
// Re-pinned 2026-11-16 (owner brief: TOEIC IIG-style computer-based room): ExamRuntimeShell routes TOEIC Listening / Reading to
// components/features/exams/toeic-iig over the same runtime callbacks; guarded by scripts/test-toeic-iig.mjs.
// Previously released results and exam-client updates were reconciled with main and the exam runtime contracts on 2026-11-21.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8').split('\r\n').join('\n');
const PINNED = {
  'src/app/exams/[family]/attempts/[attemptId]/page.tsx': '1d37a486a8bc8198764abe93', // re-pinned 2026-11-14: Echo Sentinel strict attempt (owner directive, 10 §BX)
  'src/components/features/exams/BackButton.tsx': '65f9472469177188119785c6',
  'src/components/features/exams/ExamAssetImage.tsx': 'da325ee6f098d372566422fe',
  'src/components/features/exams/ExamLearnerProgress.tsx': '55ad73f731972f84eaebc880',
  'src/components/features/exams/ExamPracticeRecommendations.tsx': '1b8a7493e7a9c5342e521f81',
  'src/components/features/exams/ExamPreflight.tsx': '866beeeffb92ec280eb19ffb',
  'src/components/features/exams/ExamProfileView.tsx': '81ce96929e5c087e9d0d65cb',
  'src/components/features/exams/ExamResultView.tsx': 'ff7f7209e26344dfdae5f517',
  'src/components/features/exams/ExamRuntimeShell.tsx': 'fbfc9547352310056cc5748a', // TOEIC Speaking retired; IELTS speaking keeps its own workspace.
  'src/components/features/exams/GroupQuestionBlock.tsx': '4c33023ea3f6a94029d25105',
  'src/components/features/exams/ListeningPlayer.tsx': 'b7d4472b2067aebc5f5ef452',
  'src/components/features/exams/PracticeResultReview.tsx': '17c146e107d3842f620b7ca1',
  'src/components/features/exams/PracticeScopePicker.tsx': 'ffaba0e0ad83dd760b10b1a7',
  'src/components/features/exams/QuestionRenderers.tsx': '0355aabcf8271280cf42ff95',
  'src/components/features/exams/ReadingWorkspace.tsx': '51d4aff32df83cb13591d9c3',
  'src/components/features/exams/SimulationStartDialog.tsx': 'a9badbb1792b9af26995bdf9',
  'src/components/features/exams/SpeakingExaminerRuntime.tsx': 'acb70f66cab81a0f1220711c',
  'src/components/features/exams/SpeakingResultReview.tsx': '1708d32b9f9d08c550e47fec',
  'src/components/features/exams/SpeakingWorkspace.tsx': 'a1193e4ec607b1277840768a',
  'src/components/features/exams/StimulusRenderer.tsx': '0a653815763a5305c719d9f0',
  'src/components/features/exams/ToeicListeningWorkspace.tsx': 'bff5c73d8c847598e1f161c8',
  'src/components/features/exams/ToeicReadingWorkspace.tsx': '71adf42efe501fafdde51a46',
  'src/components/features/exams/ToeicSpeakingWorkspace.tsx': '21c17c2d298c98778f676f99',
  'src/components/features/exams/ToeicWritingWorkspace.tsx': '264ca71f7fb435b39b993abb',
  'src/components/features/exams/WritingEditor.tsx': '978b4e59032eba8091a81301',
  'src/components/features/exams/exams-runtime.test.tsx': '7c094355dc8422a5d26d0df6',
  'src/components/features/exams/renderers/ExamRendererRegistry.tsx': 'a01f03096adf960a474002ab',
  'src/components/features/exams/renderers/ListeningFormRenderer.tsx': '8b92f6f05d9718de7daddb02',
  'src/components/features/exams/runner/ChoiceOptions.tsx': 'e248af35e6c67dc9ceb1a1ef',
  'src/components/features/exams/runner/ExamDialog.tsx': '712654c221294e72a095e300',
  'src/components/features/exams/runner/ExamNavigator.tsx': '17a3a8d4a90a0fe185413024',
  'src/components/features/exams/runner/ExamRunnerHeader.tsx': '23d18962883327556b6b8d19',
  'src/components/features/exams/runner/ExamSubmitDialog.tsx': '3b29a31d481db5f9179654ae',
  'src/components/features/exams/runner/FlagToggle.tsx': '811c4576693f13f139c42d2b',
  'src/components/features/exams/runner/SaveStatusIndicator.tsx': '015b60c3ab449d2fae8bc2b9',
  'src/hooks/useExamAttempt.ts': '3884e4bdacb6560f5d6ec356',
  'src/hooks/useExamAutosave.ts': '682b9b60bcb88820113b3926',
  'src/hooks/useExamCatalog.ts': '21fcb465faf0402bf3a5a4e6',
  'src/hooks/useExamMedia.ts': 'cf129ce7d4a47d5dbd39e317',
  'src/lib/exams/analytics.ts': 'e3dbbbaaeb107a4125e1a961',
  'src/lib/exams/contentBatch.ts': '5de8073f9fc9f3b479810a76',
  'src/lib/exams/examDraftStorage.ts': '95071a4f61d2721b331e4889',
  'src/lib/exams/groupPresentation.ts': '35dd2f2987950f0c50192966',
  'src/lib/exams/labels.ts': 'abc9f2d05c0729e3299ab940',
  'src/lib/exams/media.ts': 'be7c86cc0da370c2c8a1fb0a',
  'src/lib/exams/practice.ts': '8d08689bffb316bbfb8860f0',
  'src/lib/exams/productPolicy.ts': 'f75afa811a5ddc5f8ce45403',
  'src/lib/exams/recovery.ts': '646f8461bcb92c21178b8fea',
  'src/lib/exams/resultLifecycle.ts': '8488a8671ea9e2ebd9109f96',
  'src/lib/exams/runnerCapabilities.ts': 'ab1fec7a7863f25c9277b972',
  'src/lib/exams/runnerModel.ts': 'cf679156cfa848ea127b3b24',
  'src/services/examsApi.ts': 'e9fce5a4cfe4953f17c11b77',
  'src/types/exams.ts': '6f461f1cbe5adfe4dbb5aff7'
};
assert.ok(Object.keys(PINNED).length > 40, 'pins present');
for (const [file, pin] of Object.entries(PINNED)) {
  const got = createHash('sha256').update(read(file)).digest('hex').slice(0, 24);
  assert.equal(got, pin, `${file} is pinned (active exam UI / logic must not change in the Exams presentation work)`);
}

const dir = 'src/components/features/exams/';
const universe = read(dir + 'universe/ExamUniverse.tsx');
const css = read(dir + 'universe/examUniverse.module.css').replace(/\/\*[\s\S]*?\*\//g, '');
const home = read(dir + 'ExamsHome.tsx');
const family = read(dir + 'ExamsFamilyPage.tsx');
const library = read(dir + 'ExamLibrary.tsx');
const detail = read(dir + 'ExamFormDetail.tsx');
const list = read(dir + 'ExamAttemptList.tsx');
const attemptPage = read('src/app/exams/[family]/attempts/[attemptId]/page.tsx');
const layout = read('src/app/exams/layout.tsx');

// the active attempt never renders inside the Exams world (no wrapper in its page or in the shared layout)
assert.doesNotMatch(attemptPage, /universe|UniverseWorld/);
assert.doesNotMatch(layout, /universe|UniverseWorld|data-world/);
// the result / practice result / profile pages only WRAP their unchanged views
for (const p of ['src/app/exams/[family]/results/[attemptId]/page.tsx', 'src/app/exams/[family]/practice/result/[attemptId]/page.tsx', 'src/app/exams/profile/page.tsx']) {
  assert.match(read(p), /<UniverseWorld world=/, p);
}

// no generic AI star / sparkle, no invented progress or rating on the redesigned screens
for (const s of [universe, home, family, library, detail, list]) {
  assert.doesNotMatch(s, /Sparkles|WandSparkles|✨/);
  assert.doesNotMatch(s, /% hoàn thành|% complete|★/);
}
// numbers come from the server: family counts from the catalog window, "…" / "—" while unknown, never a placeholder 0
assert.match(family, /familyWindow\.isLoading \? '…' : familyWindow\.error \? '—'/);
assert.match(home, /counts\.simulation/);
// question count / duration only for a server-validated full simulation (Phase 7 rule kept)
assert.match(library, /const facts = sim/);
// card art follows the form's own runnable skills, never its source / title
assert.match(library, /formArtKey\(form, runnable\)/);
assert.doesNotMatch(universe, /collectionTitle|logicalKey|publisher/);
// every referenced still exists (content-hashed names)
for (const m of universe.matchAll(/'(exam-(?:hero|card)-[a-z-]+-\d+-[0-9a-f]{8}\.webp)'/g)) {
  assert.ok(existsSync(new URL('public/assets/exams/' + m[1], root)), m[1]);
}
for (const m of home.matchAll(/assets\/exams\/(exam-card-[a-z-]+-\d+-[0-9a-f]{8}\.webp)/g)) {
  assert.ok(existsSync(new URL('public/assets/exams/' + m[1], root)), m[1]);
}
// material rules: no backdrop blur, no !important, no own typeface; .world sets no position / isolation / transform
assert.doesNotMatch(css, /backdrop-filter|!important|font-family/);
const start = css.indexOf('.world {');
const worldBlock = css.slice(start, css.indexOf('}', start));
assert.doesNotMatch(worldBlock, /position:|isolation:|transform:|contain:/);
// theme only from the explicit .dark class; reduced motion stops the module's animations
assert.doesNotMatch(css, /prefers-color-scheme/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
console.log('exams universe glass: OK (' + Object.keys(PINNED).length + ' protected files pinned)');
