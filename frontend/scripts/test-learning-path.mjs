// Echo Learning Path + Profile / Progress separation contract (owner brief 2026-10-17).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const m = await import(new URL('../src/lib/learning-path/model.ts', import.meta.url).href);

// 1. destinations: a fixed table; only positive integer ids / enumerated keys reach a URL
const t = (kind, targetId = null, targetKey = null) => ({ kind, targetId, targetKey });
assert.equal(m.taskHref(t('VOCAB_REVIEW')), '/flashcards?review=due', 'straight into the due-card study');
assert.equal(m.taskHref(t('DICTATION', 42)), '/listening/42/practice');
assert.equal(m.taskHref(t('DICTATION', -1)), null);
assert.equal(m.taskHref(t('DICTATION', 1.5)), null);
assert.equal(m.taskHref(t('DICTATION', '42/../../admin')), null);
assert.equal(m.taskHref(t('READING', 7)), '/reading?materialId=7');
assert.equal(m.taskHref(t('TOPIC_SPEAKING', null, 'QUICK')), '/speaking?mode=topic');
// Writing: the task's own Writing Coach prompt (fixed key table), opened in the editor; unknown keys lead nowhere
assert.equal(m.taskHref(t('WRITING', null, 'GENPARA')), '/writing?view=coach&taskId=gen-paragraph-01&start=draft');
assert.equal(m.taskHref(t('WRITING')), null);
assert.equal(m.taskHref(t('WRITING', null, 'gen-paragraph-01')), null);
assert.equal(m.taskTitle({ ...t('WRITING', null, 'GENPARA'), title: '', goalCount: 1, progress: 0, status: 'OPEN' }, 'vi'), 'Viết bài từ 80 từ');
// Exam practice: the exact form + part; anything not exactly "<uuid>/<objective part>" of the same family is refused
const ref = '0b7d6c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const ex = (key, targetRef) => ({ ...t('EXAM_PRACTICE', null, key), targetRef });
assert.equal(m.taskHref(ex('TOEIC', `${ref}/TOEIC_PART_5`)), `/exams/toeic/tests/${ref}?part=TOEIC_PART_5#practice`);
assert.equal(m.taskHref(ex('IELTS', `${ref}/IELTS_LISTENING_SECTION_1`)), `/exams/ielts/tests/${ref}?part=IELTS_LISTENING_SECTION_1#practice`);
assert.equal(m.taskHref(ex('TOEIC', `${ref}/IELTS_READING_PASSAGE_1`)), null, 'family and part must agree');
assert.equal(m.taskHref(ex('IELTS', `${ref}/IELTS_WRITING_TASK_2`)), null, 'AI-graded parts are never a path destination');
assert.equal(m.taskHref(ex('TOEIC', `${ref}/TOEIC_PART_5/../../admin`)), null);
assert.equal(m.taskHref(ex('TOEIC', null)), null, 'a family-only exam task has no destination');
assert.equal(m.taskHref(ex('javascript:alert(1)', `${ref}/TOEIC_PART_5`)), null);
assert.equal(m.taskTitle({ ...ex('TOEIC', `${ref}/TOEIC_PART_5`), title: 'Economy TOEIC Test 1', goalCount: 1, progress: 0, status: 'OPEN' }, 'vi'), 'Luyện đề TOEIC Part 5');
assert.equal(m.examPartLabel('IELTS_READING_PASSAGE_2'), 'IELTS Reading Passage 2');
assert.equal(m.taskHref(t('PLACEMENT')), null, 'placement opens the in-page quiz');
assert.equal(m.taskHref(t('UNKNOWN', 1)), null);

// 2. one primary action: start → continue → none when the day is complete
const task = (status, progress = 0) => ({ kind: 'WRITING', targetId: null, targetKey: null, title: '', goalCount: 1, progress, status });
assert.equal(m.primaryAction([task('OPEN'), task('OPEN')], 'vi').label, 'Bắt đầu học');
assert.equal(m.primaryAction([task('DONE'), task('OPEN')], 'vi').label, 'Tiếp tục học');
assert.equal(m.primaryAction([task('DONE')], 'vi'), null);
assert.equal(m.primaryAction([], 'vi'), null);

// 3. honest wording
assert.equal(m.taskProgress({ ...task('OPEN', 3), goalCount: 8 }), '3/8');
assert.equal(m.taskProgress({ ...task('DONE', 8), goalCount: 8 }), null);
assert.equal(m.reasonLabel('LITTLE_DATA', 'vi'), null, 'generic reasons are not repeated on every card');
assert.equal(m.reasonLabel('GOAL_CORE', 'vi'), null);
assert.equal(m.reasonLabel('REVIEW_DUE', 'vi'), 'Đến hạn ôn');
assert.equal(m.bandLabel('UNKNOWN', 'vi'), 'Chưa đủ dữ liệu');
assert.equal(m.bandLabel('NOT_MEASURED', 'vi'), 'Chưa đo được');
assert.equal(m.levelLabel('A2', 'PROVISIONAL', 'vi'), 'Chưa xác định trình độ · bắt đầu với nội dung A2', 'a provisional start is never shown as the level');
assert.equal(m.levelLabel('B1', 'PLACEMENT', 'vi'), 'Trình độ B1 · theo bài xếp lớp');
assert.equal(m.reasonLabel('SKILL_BALANCE', 'vi'), 'Cân bằng kỹ năng');
assert.equal(m.stageLabel(9, 'vi'), 'Sẵn sàng mục tiêu');
assert.equal(m.goalLabel('IELTS', '6.5', 'vi'), 'IELTS 6.5');
assert.ok(m.needsTarget('TOEIC') && !m.needsTarget('GENERAL'));

// 4. page: the onboarding heading with no filler paragraph, no sparkle, DNA only from its button, real controls
const page = read('src/components/features/learning-path/LearningPathPage.tsx');
assert.match(page, /'Tạo lộ trình của bạn'/);
assert.match(page, /'Tạo lộ trình'/);
assert.doesNotMatch(page, /Bạn có thể thay đổi sau|Chọn mục tiêu và thời gian/);
assert.doesNotMatch(page, /Sparkles|✨/);
const proposeCalls = page.match(/proposeDna\(/g) ?? [];
assert.equal(proposeCalls.length, 1, 'one call site');
assert.match(page, /\{dnaOpen && <DnaDialog/, 'the analysis runs only after the explicit button opened the dialog');
assert.match(page, /type="radio"/, 'native radio controls');
assert.match(page, /role="dialog" aria-modal="true"/);
for (const f of ['src/components/features/learning-path/LearningProgressPage.tsx', 'src/hooks/useLearningPath.ts', 'src/services/learningPathApi.ts'])
  assert.doesNotMatch(read(f), /Sparkles|✨|openrouter|\/ai\//i, f);
// the daily read is a POST (it may create the day); the summary GET writes nothing
const api = read('src/services/learningPathApi.ts');
assert.match(api, /post<TodayView>\('\/learning-path\/today'\)/);
assert.match(api, /get<ProgressSummary>\('\/learning-path\/summary'\)/);
// user-scoped SWR keys, no polling interval
const hook = read('src/hooks/useLearningPath.ts');
assert.match(hook, /\[LEARNING_PATH_TODAY_KEY, email\]/);
assert.doesNotMatch(hook, /refreshInterval/);

// 5. Profile = account only; Progress = learning; the account menu goes to two different pages
const profile = read('src/app/profile/page.tsx');
assert.doesNotMatch(profile, /LearningHeatmapCard|ProficiencyCard|learning-progress/);
assert.match(profile, /ActiveSessionsCard/, 'sessions stay on the profile');
const progress = read('src/components/features/learning-path/LearningProgressPage.tsx');
assert.match(progress, /<LearningHeatmapCard \/>/);
assert.match(progress, /<ProficiencyCard \/>/);
const menu = read('src/components/layout/AccountMenu.tsx');
assert.match(menu, /href="\/profile"/);
assert.match(menu, /href="\/progress"/);

// 6. navigation: "Lộ trình học" right below "Trang chủ"; dashboard CTA opens it; routes exist
const sidebar = read('src/components/layout/Sidebar.tsx');
const dash = sidebar.indexOf('tab: "dashboard"'), path = sidebar.indexOf('tab: "learningPath"'), cards = sidebar.indexOf('tab: "flashcards"');
assert.ok(dash > 0 && dash < path && path < cards, 'learning path follows the dashboard entry');
assert.match(sidebar, /href: "\/learning-path\?view=list"/);
const labels = read('src/lib/exams/labels.ts');
assert.match(labels, /learningPath: 'Lộ trình học'/);
assert.match(read('src/components/dashboard/DashboardBento.tsx'), /href="\/learning-path"/);
assert.match(read('src/app/learning-path/page.tsx'), /<AuthGuard>/);
assert.match(read('src/app/progress/page.tsx'), /<AuthGuard>/);
assert.match(read('src/components/features/coach/echo-window.ts'), /'\[Lộ trình học -> Hôm nay\]'.*route: '\/learning-path'/);
assert.match(read('src/app/speaking/page.tsx'), /searchParams\.get\("mode"\)/);

// 7. Reading completion is a server fact (2026-10-17 repair): no browser "completed" flag, explicit server calls only
const reader = read('src/components/features/reading/InteractiveReader.tsx');
assert.doesNotMatch(reader, /ec_reading_completed_/, 'no local completion flag');
assert.match(reader, /openReadingSession\(material\.id\)/);
assert.match(reader, /await completeReading\(material\.id\)/);
assert.match(reader, /READING_TOO_FAST/);
assert.match(reader, /key\[0\] === LEARNING_PATH_TODAY_KEY/, 'the path re-reads after a finished reading');
const readingApi = read('src/services/readingApi.ts');
assert.match(readingApi, /post<ReadingCompletionState>\(`\/reading\/materials\/\$\{encodeURIComponent\(String\(id\)\)\}\/session`\)/);
assert.match(readingApi, /\/complete`/);
assert.doesNotMatch(readingApi, /\/(session|complete)`,/, 'no request body: the client never sends a percentage or a flag');
// content identity: title + its CEFR on the task line; a goal / DNA change says it applies from tomorrow
assert.equal(m.taskSubtitle({ ...t('READING', 7, 'B1'), title: 'Partners in Crime' }), 'Partners in Crime · B1');
assert.equal(m.taskSubtitle({ ...t('READING', 7, 'javascript'), title: 'X' }), 'X');
assert.match(page, /Áp dụng từ ngày mai\. Bài hôm nay giữ nguyên\./);
// page order (Echo Glass · Ascension, owner brief 2026-10-20): hero (goal + starting level, the one goal-edit control, the one
// primary action) → the four-stage journey → today's tasks → Learner DNA
const order = ['Lộ trình học của bạn', 'levelLabel(plan.level', 'onClick={() => setEditing(true)}', '<PrimaryButton', '<StageTrack current', "'Hôm nay học gì?'", '<TaskRow key', "'Cập nhật bằng Learner DNA'"]
  .map((s) => page.indexOf(s));
assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `page order ${order}`);
assert.equal((page.match(/onClick=\{\(\) => setEditing\(true\)\}/g) ?? []).length, 1, 'one goal-edit control');
assert.equal((page.match(/<PrimaryButton /g) ?? []).length, 1, 'one primary action');
// the goal ring shows the goal the learner SET: a closed rim, never a progress fraction; decoration is aria-hidden
const ring = read('src/components/features/learning-path/GoalEnergyRing.tsx');
assert.match(ring, /<div className=\{styles\.ringArt\} aria-hidden="true">/);
assert.doesNotMatch(ring, /\b(progress|percent|pct|ratio)\b\??:|strokeDashoffset|dashoffset/i, 'the ring takes no fill fraction');
assert.doesNotMatch(page, /<GoalEnergyRing[^>]*(progress|percent)/, 'no progress handed to the ring');
assert.match(read('src/components/features/learning-path/AscentScene.tsx'), /<div className=\{styles\.scene\} aria-hidden="true">/);
// no invented metric: no radar / percentages / target date / XP on the page
assert.doesNotMatch(page, /radar|\bXP\b|ngày mục tiêu|target date|\}\s*%\s*</i, 'no radar, XP, target date or shown percentage');
const lpCss = read('src/components/features/learning-path/learningPath.module.css');
assert.match(lpCss, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(lpCss, /\.pauseScope\[data-paused\] \* \{ animation-play-state: paused; \}/, 'off-screen sections pause');
assert.doesNotMatch(lpCss, /backdrop-filter|!important/, 'no blur over a wallpaper, no !important');

// 8. Writing: a free practice submission (no AI / Premium) exists next to the optional AI review; the editor opens directly
const editor = read('src/components/features/writing/coach/DraftEditor.tsx');
assert.match(editor, /writingApi\.submitPractice\(session\.id\)/);
assert.match(editor, /Nộp bài luyện tập \(không chấm điểm\)/);
assert.match(read('src/services/writingApi.ts'), /\/practice-submission`\)/);
assert.doesNotMatch(read('src/services/writingApi.ts'), /practice-submission`, /, 'no client text or flag: the server reads its saved draft');
assert.match(read('src/components/features/writing/coach/WritingCoach.tsx'), /get\('start'\) === 'draft'/);
// Flashcards: the due-review entry opens the study of every due card
assert.match(read('src/components/features/flashcard/FlashcardUI.tsx'), /reviewParam !== "due"/);
// Exams: the assigned part is marked on the test page
assert.match(read('src/components/features/exams/PracticeScopePicker.tsx'), /get\('part'\)/);

console.log('learning-path contract: OK');
