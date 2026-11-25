// Echo Sentinel page contract (owner directive 2026-11-14, rules 10 §BX). Static checks over the source.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (p) => readFileSync(join(root, p), 'utf8');
const client = read('lib/sentinel/client.ts');
const hook = read('components/sentinel/useFocusLockdown.ts');
const dialogs = read('components/sentinel/StrictModeDialogs.tsx');
const arena = read('components/features/games/king-of-english/KingArena.tsx');
const realtime = read('components/features/games/king-of-english/useKingRealtime.ts');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

check('the attempt secret stays in page memory: no storage, cookie or URL', () => {
  for (const [name, src] of [['client', client], ['hook', hook], ['realtime', realtime], ['arena', arena]]) {
    const sentinelLines = src.split('\n').filter(l => /sentinel|attempt|token/i.test(l));
    for (const l of sentinelLines) {
      assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|searchParams\.set\(['"](sentinel|token|attempt)/.test(l), `${name}: ${l.trim()}`);
    }
  }
});
check('leaving reports carry the CSRF header (keepalive fetch, never sendBeacon)', () => {
  assert.match(client, /keepalive:\s*true/);
  assert.match(client, /csrfHeaders\('POST'\)/);
  assert.ok(!/sendBeacon/.test(client + hook));
});
check('focus lockdown listens to every leave signal a page can observe', () => {
  for (const e of ["'visibilitychange'", "'blur'", "'focus'", "'pagehide'", "'beforeunload'"]) assert.ok(hook.includes(e), e);
  assert.match(hook, /hasFocus\(\)/, 'blur counts only after the grace and when the page really lost focus');
  assert.match(hook, /blurGraceMs/);
  assert.match(hook, /'NAVIGATION'/, 'unmount while active reports navigation');
});
check('the strict warning text is the owner wording, with explicit acknowledgement', () => {
  for (const t of ['CHẾ ĐỘ THI NGHIÊM NGẶT', 'Trong suốt quá trình làm bài hoặc thi đấu, bạn phải ở lại màn hình hiện tại.',
    'Nếu chuyển tab, chuyển sang ứng dụng khác, thu nhỏ trình duyệt, tải lại trang hoặc thoát khỏi phiên thi, lượt hiện tại sẽ bị hủy và không được tính điểm.',
    'Để nhận điểm và được xếp hạng, bạn phải bắt đầu một lượt mới từ đầu.', 'Hãy chuẩn bị mọi thứ cần thiết trước khi bắt đầu.',
    'Tôi đã hiểu — Bắt đầu', 'Quay lại', 'LƯỢT THI ĐÃ BỊ HỦY', 'Bắt đầu lượt mới', 'Ở lại tiếp tục', 'Thoát và hủy lượt thi',
    'Bạn đang trong phiên thi có tính điểm. Nếu rời khỏi lúc này, lượt thi sẽ bị hủy và không được tính điểm. Bạn có chắc muốn thoát?'])
    assert.ok(dialogs.includes(t), t);
  assert.match(client, /acknowledged:\s*true/);
  assert.ok(!/Sparkles|✨|&amp;|\s&\s/.test(dialogs), 'no sparkle, no "&" in copy');
});
check('ranked Soán ngôi launches only after the gate; recovered rooms never invent an attempt', () => {
  assert.match(arena, /const strictLaunch=launch\.mode==='CONQUEST'&&!launch\.recover/);
  assert.match(arena, /\(!strictLaunch\|\|attempt\)/);
  assert.match(arena, /beginAttempt\('KING_CONQUEST'\)/);
  assert.match(arena, /setGate\('rematch'\)/, 'a rematch is a new acknowledged attempt');
});
check('the handle travels on launch, join and every rejoin, not on each word', () => {
  assert.equal((realtime.match(/\/rejoin',body:JSON\.stringify\(\{roomCode:room\.current\|\|'',sentinel:sentinel\.current\?\?undefined\}\)/g) || []).length, 3);
  assert.match(realtime, /sentinel:sentinel\.current\?\?undefined,\.\.\.payload/);
  assert.ok(!/destination:'\/app\/king-of-english\/move',body:JSON\.stringify\(\{[^}]*sentinel/.test(realtime));
});
console.log(`echo-sentinel: ${passed} checks passed`);

// Coverage beyond Soán ngôi (Card Blast solo + 1v1, exam simulations).
const cardBlast = read('components/features/flashcard/card-blast/CardBlastModal.tsx');
const pvpHook = read('components/features/flashcard/pvp/useCardBlastPvP.ts');
const exam = read('app/exams/[family]/attempts/[attemptId]/page.tsx');
check('Card Blast: solo run and a 1v1 against a person open the strict warning; bots do not', () => {
  assert.match(cardBlast, /setStrictGate\("solo"\)/);
  assert.match(cardBlast, /ready && pvp\.room\?\.mode === "HUMAN"/);
  assert.match(cardBlast, /beginAttempt\(kind === "solo" \? "CARD_BLAST_SOLO" : "CARD_BLAST_PVP"\)/);
  assert.match(cardBlast, /requestRun\(sentinelHandle\(attempt\)\)/);
  assert.match(pvpHook, /ready, skills, sentinel \}/);
  assert.ok(!/requestRun\(\);/.test(cardBlast), 'no run is issued without a new acknowledgement');
});
check('Exams: a simulation asks first, binds the attempt, and a reopened page cannot resume it', () => {
  assert.match(exam, /attemptState\?\.mode === 'EXAM_SIMULATION' && !strictAttempt\) \{ setStrictError\(null\); setStrictGate\(true\); return; \}/);
  assert.match(exam, /await bindExam\(attempt, attemptId\)/);
  assert.match(exam, /reopenExam\(attemptId\)/);
  assert.match(exam, /useFocusLockdown\(\{ attempt: strictAttempt, active: strictLive/);
});
console.log(`echo-sentinel coverage: ${passed} checks passed`);
