// Free daily allowances, Reading import limits, Premium page wording and the Learning Path practice milestones:
// every number the UI shows must be the backend's own (owner policy 2026-10-18).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fe = (p) => readFileSync(path.join(root, 'src', p), 'utf8');
const be = (p) => readFileSync(path.join(root, '..', 'backend', 'src', 'main', 'java', 'com', 'englishcoach', p), 'utf8');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const props = be('premium/config/PremiumProperties.java');
const javaInt = (src, name) => Number(new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(src)?.[1]?.replaceAll('_', ''));
const api = fe('services/premiumApi.ts');
const page = fe('app/premium/page.tsx');
const guard = be('reading/service/ReadingImportGuard.java');
const modal = fe('components/features/reading/ImportMaterialModal.tsx');

check('the published free daily limits equal the server defaults', () => {
  const m = /FREE_DAILY_LIMITS[^=]*=\s*\{\s*AI:\s*(\d+),\s*COACH:\s*(\d+),\s*BOOK:\s*(\d+)\s*\}/.exec(api);
  assert.ok(m, 'FREE_DAILY_LIMITS present');
  assert.equal(Number(m[1]), javaInt(props, 'freeDailyAiLimit'));
  assert.equal(Number(m[2]), javaInt(props, 'freeDailyCoachMessages'));
  assert.equal(Number(m[3]), javaInt(props, 'freeDailyBookImports'));
  assert.equal(Number(m[1]), 3); assert.equal(Number(m[2]), 10); assert.equal(Number(m[3]), 1);
});

check('no stale "5 free uses" wording anywhere the learner reads it', () => {
  for (const p of ['app/premium/page.tsx', 'components/premium/PremiumUpgradeModal.tsx', 'components/premium/PremiumFeatureBadge.tsx']) {
    assert.doesNotMatch(fe(p), /5 lượt thử|5 lượt dùng thử|hết 5 lượt/, p);
  }
  assert.doesNotMatch(be('premium/exception/PremiumRequiredException.java'), /5 lượt/);
});

check('the Premium page keeps Echo Coach separate, states the shared document limits and claims no unlimited AI', () => {
  assert.match(page, /tính riêng, không trừ vào lượt AI/);
  assert.match(page, /Premium không thay đổi các giới hạn này/);
  assert.doesNotMatch(page, /không giới hạn AI|AI không giới hạn|unlimited AI/i);
  assert.doesNotMatch(page, /Sparkles|✨/);
  assert.match(page, /formatVnd\(plan.priceVnd\)/);
});

check('the Reading import limits shown are the guard limits (every account)', () => {
  assert.equal(javaInt(guard, 'MAX_WORDS'), 10000);
  assert.match(guard, /MAX_PDF_BYTES = 6L \* 1024 \* 1024/);
  assert.match(guard, /MAX_IMAGE_BYTES = 5L \* 1024 \* 1024/);
  assert.match(guard, /MAX_PDF_PAGES = 30, MAX_OCR_PAGES = 15/);
  assert.match(guard, /DAILY_UPLOADS = 20/);
  assert.match(modal, /MAX_PDF_BYTES = 6 \* 1024 \* 1024/);
  assert.match(modal, /MAX_IMAGE_BYTES = 5 \* 1024 \* 1024/);
  assert.match(modal, /PDF tối đa 30 trang, 6 MB \(bản scan tối đa 15 trang\)/);
  assert.match(page, /PDF tối đa 30 trang và 6 MB \(bản scan tối đa 15 trang cần nhận dạng\)[\s\S]*10\.000 từ[\s\S]*20 tài liệu mỗi ngày/);
  assert.doesNotMatch(be('reading/service/ReadingService.java'), /isPremium|PremiumEntitlement/, 'no Premium bypass of the import limits');
});

check('Echo Coach tells the daily limit apart from the per-minute throttle and keeps history readable', () => {
  const w = fe('components/features/coach/CoachWidget.tsx');
  assert.match(w, /echoLimit === 'COACH_DAILY' \|\| echoLimit === 'COACH_PREMIUM_DAILY' \|\| echoLimit === 'COACH_PREMIUM_MONTHLY'/);
  assert.match(w, /disabled=\{!input\.trim\(\) \|\| loading \|\| exhausted\}/);
  const limit = be('ai/service/CoachDailyLimitException.java');
  assert.match(limit, /FREE_DAILY = "COACH_DAILY", PREMIUM_DAILY = "COACH_PREMIUM_DAILY", PREMIUM_MONTHLY = "COACH_PREMIUM_MONTHLY"/);
  assert.match(limit, /headers\.set\("X-Echo-Limit", kind\)/);
  // the allowance is reserved before any provider call (prepare), the provider is called only in complete()
  const svc = be('ai/service/OpenRouterChatServiceImpl.java');
  assert.ok(svc.indexOf('Long reservation = reserveMessage(userId);') > 0 && svc.indexOf('Long reservation = reserveMessage(userId);') < svc.indexOf('private AiChatResponse complete('));
  assert.ok(svc.indexOf('restTemplate.postForEntity') > svc.indexOf('private AiChatResponse complete('));
  // Premium Echo is metered (daily + monthly), never unlimited (owner 2026-11-20)
  const usage = be('premium/service/PremiumUsageService.java');
  assert.match(usage, /if \(pool == Pool\.BOOK && isPremium\) \{\s*return (?:null|new ReservationResult\(null, false\));/);
  assert.match(usage, /throw new PremiumDailyLimitReachedException\(featureKey, dailyLimit, nextReset\(\)\)/);
});

check('the Premium page states the enforced Echo policy (free 10 a day; Premium daily and monthly)', () => {
  const api = fe('services/premiumApi.ts');
  assert.match(api, /free: \{ perDay: 10, deepPerDay: 1 \}/);
  assert.match(api, /premium: \{ perDay: 60, perMonth: 500, deepPerDay: 3, deepPerMonth: 40 \}/);
  assert.match(be('premium/config/PremiumProperties.java'), /premiumDailyCoachMessages = 60;/);
  assert.match(page, /data-echo-limits/);
  assert.doesNotMatch(page, /120 tin nhắn/);
});

check('My Books asks the server before a book is stored, and settles the grant', () => {
  const t = fe('components/features/reading/books/MyBooksTab.tsx');
  const ask = t.indexOf('await requestBookImports([fp])'), store = t.indexOf('await store.addBook(prepared.meta');
  assert.ok(ask > 0 && store > ask, 'grant before storing');
  assert.match(t, /settleBookImports\(\[fp\], false\)/);
  assert.match(t, /settleBookImports\(\[fp\], true\)/);
  assert.match(fe('components/features/reading/books/store/backup.ts'), /if \(allowed && !allowed\.has\(raw\.fingerprint\)\) \{ refused\+\+; continue; \}/);
  // keeping a book opened with "Đọc ngay" is an import too: the same grant before the reader stores it
  const r = fe('components/features/reading/books/BookReader.tsx');
  const save = r.slice(r.indexOf('const saveToShelf'), r.indexOf('const pct ='));
  const rAsk = save.indexOf('await requestBookImports([fp])'), rStore = save.indexOf('await store.addBook(');
  assert.ok(rAsk > 0 && rStore > rAsk, 'reader save: grant before storing');
  assert.match(save, /if \(!grant\.granted\.includes\(fp\)\) \{[\s\S]*?return;/, 'reader save: a refused grant stores nothing');
  assert.match(save, /settleBookImports\(\[fp\], false\)/);
  assert.match(save, /settleBookImports\(\[fp\], true\)/);
  assert.equal((t.match(/store\.addBook\(/g) || []).length + (r.match(/store\.addBook\(/g) || []).length, 2, 'no other path stores a book');
  // the server bounds give-backs (a released grant): one a day, right after the grant
  const u = be('premium/service/PremiumUsageService.java');
  assert.match(u, /static final int BOOK_RELEASES_PER_DAY = 1;/);
  assert.match(u, /static final int BOOK_RELEASE_WINDOW_MINUTES = 30;/);
});

check('document recognition: durable daily count, one budget for Reading and Listening documents, sizes agree', () => {
  const g = be('reading/service/ReadingImportGuard.java');
  assert.match(g, /ledger\.reserve\(userId, DAILY_UPLOADS\)/, 'the daily count is the database ledger');
  assert.match(be('reading/service/DocumentRecognitionLedger.java'), /pg_advisory_xact_lock\(hashtext\(\?\)\)/);
  assert.match(be('reading/service/ReadingService.java'), /permit\.notSent\(\);/, 'a document that never reached the host is not counted');
  const l = be('listening/service/ListeningDocumentService.java');
  assert.match(l, /ReadingImportGuard\.MAX_PDF_BYTES : ReadingImportGuard\.MAX_IMAGE_BYTES/);
  assert.doesNotMatch(l, /10 \* 1024 \* 1024/);
  const form = fe('components/features/listening/DocumentImportForm.tsx');
  assert.match(form, /next\.size>\(next\.type==='application\/pdf'\?6:5\)\*1024\*1024/, 'the Listening form advertises what the server accepts');
  assert.doesNotMatch(form, /10 MB/);
});

check('Learning Path practice milestones are labelled as participation, never as a score', () => {
  const model = fe('lib/learning-path/model.ts');
  assert.match(model, /case 'PRACTICE_WRITING'/);
  assert.match(model, /case 'PRACTICE_READING'/);
  assert.match(be('learningpath/LearningPathEngine.java'), /"PRACTICE_" \+ s\.name\(\)/);
});

console.log(`Free allowances / import limits / Premium copy PASS (${passed} checks)`);
