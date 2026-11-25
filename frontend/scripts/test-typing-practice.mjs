import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TypingEngine, graphemes, normalizeTypingText, typingSections, eligibleEnglish, randomTypingText } from '../src/lib/writing/typing-engine.ts';
import { readTypingHistory, readLegacyTypingHistory, saveTypingSummary } from '../src/lib/writing/typing-history.ts';
import { readTypingLines } from '../src/lib/writing/typing-preferences.ts';
let passed = 0;
const test = (name, run) => { run(); console.log(`PASS ${++passed}: ${name}`); };
const type = (e, text, start = 0, interval = 100) => { for (const [i, c] of graphemes(text).entries()) e.enter(c, start + i * interval); };
test('first character starts; idle opening does not; fixed elapsed deadline and frozen result', () => {
  const e = new TypingEngine('hello world', 30); e.tick(100000); assert.equal(e.phase, 'READY');
  e.enter('h', 100000); assert.equal(e.startedAt, 100000); e.tick(131000);
  assert.equal(e.phase, 'FINISHED'); assert.equal(e.result.seconds, 30); assert.equal(e.result.wpm, .4); assert.equal(e.result.inactive, true);
  const result = e.result; e.enter('e', 132000); e.backspace(133000); e.finish(140000); assert.equal(e.result, result); assert.equal(e.entries, 1);
});
test('corrected words recover accuracy; Backspace never increases raw entries', () => {
  const e = new TypingEngine('abc', 0); e.enter('x', 0); e.backspace(100); type(e, 'abc', 200, 200);
  assert.equal(e.phase, 'FINISHED'); assert.equal(e.result.correct, 3); assert.equal(e.result.incorrect, 0);
  assert.equal(e.result.accuracy, 100); assert.equal(e.result.errors, 1); assert.equal(e.result.corrections, 1);
  assert.equal(e.result.wpm, 60); assert.equal(e.result.raw, 80); assert.ok(e.historicalErrors.has(0));
});
test('wrong letter stays in its slot and subsequent words stay aligned', () => {
  const e = new TypingEngine('cat dog', 0); type(e, 'cxt dog'); assert.equal(e.cells.join(''), 'cxt dog');
  assert.equal(e.result.incorrect, 1); assert.equal(e.result.correct, 6); assert.equal(e.position, 7);
});
test('extra letters at separator do not shift target; each Backspace undoes one entry', () => {
  const e = new TypingEngine('cat dog', 0); type(e, 'catX', 0); assert.equal(e.position, 3); assert.deepEqual(e.extras.get(3), ['X']);
  e.backspace(500); assert.equal(e.extras.size, 0); assert.equal(e.position, 3);
  type(e, ' dog', 600); assert.equal(e.result.incorrect, 0); assert.equal(e.result.errors, 1);
});
test('missing letters via early space stay in same word; undo restores whole skipped range', () => {
  const e = new TypingEngine('hello world', 0); type(e, 'he '); assert.equal(e.position, 6); assert.equal(e.metrics().incorrect, 3);
  e.backspace(400); assert.equal(e.position, 2); assert.equal(e.cells[5], undefined); type(e, 'llo world', 500);
  assert.equal(e.result.incorrect, 0); assert.equal(e.result.accuracy, 100);
});
test('extra initial spaces do not skip a word; unresolved extras count as remaining errors', () => {
  const e = new TypingEngine('cat', 0); type(e, ' cat'); assert.equal(e.result.incorrect, 1); assert.equal(e.result.correct, 3); assert.equal(e.result.accuracy, 0);
});
test('punctuation, newlines, numbers, case and composed graphemes have stable positions', () => {
  const target = 'Hi! (42) “café”\nYes.'; const e = new TypingEngine(target, 0); type(e, target);
  assert.equal(e.result.accuracy, 100); assert.equal(e.result.correct, graphemes(target).length);
  assert.equal(graphemes('e\u0301').length, 1); assert.equal(normalizeTypingText(' a\t b\r\n c '), ' a\t b\n c ');
});
test('random timed target extends without premature completion; untimed target ends', () => {
  const e = new TypingEngine('cat', 60, true); type(e, 'cat'); assert.equal(e.phase, 'RUNNING'); assert.ok(e.target.length > 100); assert.equal(e.position, 3);
  const fixed = new TypingEngine('cat', 0, true); type(fixed, 'cat'); assert.equal(fixed.phase, 'FINISHED');
  assert.notEqual(randomTypingText(), randomTypingText()); assert.equal(randomTypingText(300).split(' ').length, 300);
});
test('delayed input after deadline is not credited; restart is independent; aborted sessions cannot finish', () => {
  const e = new TypingEngine('hello', 30); e.enter('h', 0); e.enter('e', 30001); assert.equal(e.entries, 1); assert.equal(e.result.seconds, 30);
  const fresh = new TypingEngine('hello', 30); assert.equal(fresh.entries, 0); assert.equal(fresh.samples.length, 0);
  fresh.abort(); fresh.enter('h', 1000); assert.equal(fresh.finish(2000), null);
});
test('chart error/correction markers derive from actual events; stable speed windows and short samples', () => {
  const e = new TypingEngine('word '.repeat(500), 30); type(e, 'word ', 0); e.tick(1000); e.enter('X', 1100); e.backspace(1200); e.tick(2000);
  assert.equal(e.samples.reduce((a,s) => a + s.errors, 0), 1); assert.equal(e.samples.reduce((a,s) => a + s.corrections, 0), 1);
  assert.equal(e.metrics().consistency, null); e.tick(30000); assert.ok(e.result.consistency >= 0 && e.result.consistency <= 100);
  assert.ok(e.result.inactive); assert.ok(e.samples.every(s => Number.isFinite(s.wpm) && Number.isFinite(s.raw)));
  const fast = new TypingEngine('abc', 0); type(fast, 'abc', 0, 1); assert.equal(fast.wordSpeed(fast.words[0]), null);
});
test('bounded chart for long passages; Unicode source normalization and English eligibility', () => {
  const e = new TypingEngine('word '.repeat(2000), 0); e.enter('w', 0); for (let i = 1; i <= 3600; i++) e.tick(i * 1000);
  assert.equal(e.phase, 'FINISHED'); assert.ok(e.samples.length <= 600);
  const delayed = new TypingEngine('long passage', 0); delayed.enter('l', 0); delayed.tick(3610000); assert.equal(delayed.result.seconds, 3600);
  assert.deepEqual(typingSections('First paragraph.\n\nSecond paragraph.'), ['First paragraph.', 'Second paragraph.']);
  assert.equal(eligibleEnglish('Hãy viết một bài văn tiếng Việt.'), false); assert.equal(eligibleEnglish('Write about your favourite place.'), true);
  assert.equal(eligibleEnglish(''), false);
});
test('bounded same-tab summaries dedupe and reject another account or passage payload', () => {
  const map = new Map(); const storage = { getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v) };
  const e = new TypingEngine('abc', 0); type(e,'abc'); const summary = { ...e.result, id:'one', source:'random', finishedAt:1, duration:0 };
  saveTypingSummary(1, summary, storage); saveTypingSummary(1, summary, storage); assert.equal(readTypingHistory(1,storage).length, 1); assert.equal(readTypingHistory(2, storage).length, 0);
  assert.equal(saveTypingSummary(1, { ...summary, text:'private text' }, storage).length, 1);
  for (let i = 0; i < 25; i++) saveTypingSummary(1,{ ...summary,id:String(i) },storage);
  assert.equal(readTypingHistory(1,storage).length,20); assert.ok(![...map.values()].join('').includes('private text'));
  map.set('ec_typing_history_v2:2', map.get('ec_typing_history_v2:1')); assert.deepEqual(readTypingHistory(2,storage), []);
});
test('integration uses authorized read-only APIs; input blocks paste/drop; lazy Writing tab order', () => {
  const read = path => fs.readFileSync(new URL(`../src/${path}`, import.meta.url),'utf8');
  const navigation = read('components/features/writing/WritingNavigation.tsx');
  assert.ok(navigation.indexOf("id: 'sentence-lab'") < navigation.indexOf("id: 'typing'")); assert.ok(navigation.indexOf("id: 'typing'") < navigation.indexOf("id: 'coach'"));
  const sources = read('components/features/writing/typing/TypingSources.tsx');
  for (const path of ['/reading/catalog','/reading/materials/',]) assert.ok(sources.includes(path));
  assert.ok(!/apiClient\.(post|patch|put|delete)/.test(sources)); assert.ok(sources.includes('controller.signal.aborted'));
  const practice = read('components/features/writing/typing/TypingPractice.tsx'); assert.ok(practice.includes('onPaste={e => { e.preventDefault()')); assert.ok(practice.includes('onDrop={e => { e.preventDefault()'));
  assert.ok(read('lib/writing/route-state.ts').includes("'typing'")); assert.ok(read('lib/auth-cache-cleanup.ts').includes('sessionStorage.clear()'));
  const reading = fs.readFileSync(new URL('../../backend/src/main/java/com/englishcoach/reading/repository/ReadingMaterialRepository.java',import.meta.url),'utf8');
  assert.ok(reading.includes('ownerUserId = :userId')); assert.ok(reading.includes('ownerUserId IS NULL'));
  const writing = fs.readFileSync(new URL('../../backend/src/main/java/com/englishcoach/writing/service/WritingSessionServiceImpl.java',import.meta.url),'utf8');
  assert.ok(writing.includes('findByUserIdOrderByUpdatedAtDesc(userId)')); assert.ok(writing.includes('getSessionDetail(Long userId'));
});
test('word accuracy: four completed words, multiple errors in one word, untouched suffix', () => {
  for (const answer of ['I love leXrning English', 'I love lXXXning English']) {
    const e = new TypingEngine('I love learning English', 0); type(e, answer);
    assert.equal(e.result.accuracy, 75); assert.equal(e.result.evaluatedWords, 4); assert.equal(e.result.correctWords, 3);
  }
  const e = new TypingEngine('one two three four five six seven eight nine ten untouched later', 30);
  type(e, 'one two three four five six seven eight nine ten '); e.tick(30000);
  assert.equal(e.result.accuracy, 100); assert.equal(e.result.evaluatedWords, 10);
});
test('incomplete prefixes, unresolved errors and erased attempts never become completed correct words', () => {
  assert.equal(new TypingEngine('one two', 30).metrics().accuracy, null);
  for (const input of ['one t', 'one X']) {
    const e = new TypingEngine('one two three', 30); type(e,input); e.tick(30000);
    assert.equal(e.result.accuracy, 50); assert.equal(e.result.incompleteWords, 1);
  }
  const e = new TypingEngine('one two', 30); e.enter('X',0); e.backspace(100); e.tick(30000);
  assert.equal(e.result.accuracy, 0); assert.equal(e.result.correctWords, 0); assert.equal(e.result.incompleteWords, 1);
  assert.equal(e.result.correctedErrors, 1);
});
test('word boundaries preserve repeated spaces, apostrophes, hyphens, punctuation and newlines', () => {
  const target = "Don't  re-write!\n\nYes, please.";
  const e = new TypingEngine(target,0); type(e,target);
  assert.equal(e.result.accuracy,100); assert.equal(e.result.evaluatedWords,4); assert.equal(e.target.join(''),target);
  const extra = new TypingEngine('one  two three',0); type(extra,'oneX  two three');
  assert.equal(extra.result.correctWords,2); assert.equal(extra.result.evaluatedWords,3);
});
test('visible-line preferences default safely and validate saved 2/3/4', () => {
  for (const raw of [null,'','1','5','old','NaN']) assert.equal(readTypingLines({getItem:()=>raw}),2);
  for (const n of [2,3,4]) assert.equal(readTypingLines({getItem:()=>String(n)}),n);
  assert.equal(readTypingLines({getItem:()=>{throw new Error('blocked')}}),2);
});
test('legacy history stays accessible without changing its historical accuracy definition', () => {
  const e=new TypingEngine('abc',0); type(e,'abc');
  const {correctWords,evaluatedWords,incompleteWords,correctedErrors,...old}=e.result;
  const item={...old,accuracy:75,id:'legacy',source:'writing',duration:0,finishedAt:1};
  const storage={getItem:()=>JSON.stringify({userId:1,items:[item]})};
  assert.equal(readLegacyTypingHistory(1,storage)[0].accuracy,75);
  assert.equal('evaluatedWords' in readLegacyTypingHistory(1,storage)[0],false);
  assert.deepEqual(readLegacyTypingHistory(2,storage),[]);
  assert.deepEqual(readTypingHistory(1,storage),[]);
});
console.log(`${passed} focused typing tests passed.`);
