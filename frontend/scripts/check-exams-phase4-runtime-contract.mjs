/**
 * Exams Recovery Phase 4B — runner compatibility contract (frontend side).
 *  1. Executes the REAL pure runtime functions of src/lib/exams/groupPresentation.ts (types stripped):
 *     completion templates, choose-TWO selection (cardinality, uniqueness, resume), multi-document segmentation,
 *     word-limit label.
 *  2. Declared capabilities: src/lib/exams/runnerCapabilities.ts must equal the backend mirror
 *     backend/.../exams/release/ExamRunnerCapabilities.java entry for entry; every declared component exists; every
 *     SUPPORTED feature's data-capability marker is rendered by the component that claims it.
 *  3. Wiring: the manifest types carry presentation / delivery; runners resolve images through grants; the TOEIC
 *     runners store the option id (never the label); no hard-coded localhost media prefix in the listening runners.
 * Run: node scripts/check-exams-phase4-runtime-contract.mjs (also chained from check-exams-containment-contract.mjs).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripTypeScriptTypes } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const fe = path.join(here, '..');
const repo = path.join(fe, '..');
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const examsDir = path.join(fe, 'src', 'components', 'features', 'exams');

// ---- 1. pure runtime functions -------------------------------------------------------------------------------------
const gpSrc = read(path.join(fe, 'src', 'lib', 'exams', 'groupPresentation.ts'));
const gpJs = stripTypeScriptTypes(gpSrc).replace(/^export /gm, '');
const names = ['parseCompletionTemplate', 'itemQuestionNumber', 'optionIds', 'extractChoice', 'selectedFromResponses',
  'toggleChooseN', 'distributeSelection', 'wordLimitLabel', 'stimulusDocuments'];
const gp = new Function(`${gpJs}\nreturn { ${names.join(', ')} };`)();

// completion template: every blank maps 1:1 to the group's items
const tpl = gp.parseCompletionTemplate('Date opened (13) ______\nTour starts at (14) ______ every day', [13, 14]);
assert.strictEqual(tpl.complete, true);
assert.deepStrictEqual(tpl.lines[0].map((s) => s.type), ['text', 'blank']);
assert.strictEqual(tpl.lines[1][1].number, 14);
assert.strictEqual(gp.parseCompletionTemplate('only (13) ______', [13, 14]).complete, false, 'missing blank ⇒ items render individually');
assert.strictEqual(gp.parseCompletionTemplate('(13) ______ and (13) ______', [13]).complete, false, 'duplicate blank ⇒ not a template');
assert.strictEqual(gp.parseCompletionTemplate('(13) ______ (99) ______', [13]).complete, false, 'foreign blank ⇒ not a template');

// choose-TWO: cardinality 2, unique ids, limit enforced, resume lossless
const order = ['A', 'B', 'C', 'D', 'E'];
let sel = [];
sel = gp.toggleChooseN(sel, 'D', 2).selected;
sel = gp.toggleChooseN(sel, 'A', 2).selected;
const third = gp.toggleChooseN(sel, 'C', 2);
assert.strictEqual(third.rejected, true, 'a third choice is refused');
assert.deepStrictEqual(third.selected, ['D', 'A']);
assert.deepStrictEqual(gp.toggleChooseN(sel, 'D', 2).selected, ['A'], 'toggling a chosen option removes it');
assert.deepStrictEqual(gp.distributeSelection(sel, order, 2), ['A', 'D'], 'stored in option order, one id per question');
assert.deepStrictEqual(gp.distributeSelection(['A'], order, 2), ['A', ''], 'unfilled member stored blank');
assert.deepStrictEqual(gp.selectedFromResponses([{ value: 'A' }, 'A'], order), ['A'], 'a stored duplicate resumes as ONE selection');
assert.deepStrictEqual(gp.selectedFromResponses(['D', { value: 'A' }], order), ['A', 'D']);
assert.strictEqual(gp.itemQuestionNumber({ optionDefinitions: { questionNumber: 15 } }), 15);
assert.deepStrictEqual(gp.optionIds({ optionDefinitions: { options: [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }] } }), ['A', 'B']);

// multi-document Part 7: separated in source order only when proven
const docs = gp.stimulusDocuments('MULTI_DOC', {
  documentBoundaries: 'SEGMENTED',
  documents: [
    { declaredType: 'article', paragraphs: [{ text: 'p1' }, { text: 'p2' }] },
    { declaredType: 'e-mail', paragraphs: [{ text: 'p3' }] },
    { declaredType: 'form', paragraphs: [{ text: 'p4' }] },
  ],
});
assert.strictEqual(docs.segmented, true);
assert.deepStrictEqual(docs.documents.map((d) => d.label), ['article', 'e-mail', 'form']);
assert.deepStrictEqual(docs.documents[0].paragraphs, ['p1', 'p2']);
const unproven = gp.stimulusDocuments('MULTI_DOC', { documentBoundaries: 'NOT_SEGMENTED', documents: [{}, {}] });
assert.strictEqual(unproven.segmented, false, 'missing boundary proof ⇒ one block + review notice, never an invented split');

// word limit reaches the learner
assert.match(gp.wordLimitLabel(1, 'ONE WORD AND/OR', 'en'), /No more than 1 word per answer \(a number may be added\)/);
assert.match(gp.wordLimitLabel(3, 'NO MORE THAN THREE WORDS', 'vi'), /Tối đa 3 từ/);
assert.strictEqual(gp.wordLimitLabel(null, null, 'en'), null);

// ---- 2. declared capabilities: TS == Java, components + markers exist -----------------------------------------------
const capSrc = read(path.join(fe, 'src', 'lib', 'exams', 'runnerCapabilities.ts'));
function tsTable(name) {
  const start = capSrc.indexOf(`export const ${name}`);
  assert.ok(start >= 0, `${name} missing`);
  const body = capSrc.slice(start, capSrc.indexOf('};', start));
  const out = {};
  for (const m of body.matchAll(/^\s*([A-Z_]+):\s*\{\s*support:\s*'([A-Z]+)',\s*component:\s*'([^']+)'(?:,\s*marker:\s*'([A-Z_]+)')?/gm)) {
    out[m[1]] = { support: m[2], component: m[3], marker: m[4] };
  }
  return out;
}
const javaSrc = read(path.join(repo, 'backend', 'src', 'main', 'java', 'com', 'englishcoach', 'exams', 'release', 'ExamRunnerCapabilities.java'));
function javaTable(name) {
  const start = javaSrc.indexOf(`Map<String, Support> ${name} = Map.ofEntries(`);
  assert.ok(start >= 0, `java ${name} missing`);
  const body = javaSrc.slice(start, javaSrc.indexOf(');', start));
  const out = {};
  for (const m of body.matchAll(/entry\("([A-Z_]+)",\s*Support\.([A-Z]+)\)/g)) out[m[1]] = m[2];
  return out;
}
for (const table of ['RUNNER_INTERACTIONS', 'RUNNER_FEATURES']) {
  const ts = tsTable(table);
  const java = javaTable(table === 'RUNNER_INTERACTIONS' ? 'INTERACTIONS' : 'FEATURES');
  assert.ok(Object.keys(ts).length >= 8, `${table}: TS table not parsed (${Object.keys(ts).length})`);
  assert.deepStrictEqual(Object.keys(ts).sort(), Object.keys(java).sort(), `${table}: TS and Java declare different entries`);
  for (const [k, v] of Object.entries(ts)) {
    assert.strictEqual(v.support, java[k], `${table}.${k}: TS ${v.support} vs Java ${java[k]}`);
    const file = path.join(examsDir, v.component);
    assert.ok(fs.existsSync(file), `${table}.${k}: component ${v.component} missing`);
    if (v.support === 'SUPPORTED' && v.marker) {
      assert.ok(read(file).includes(`data-capability="${v.marker}"`), `${table}.${k}: ${v.component} lacks data-capability="${v.marker}"`);
    }
  }
}

// ---- 3. wiring ---------------------------------------------------------------------------------------------------
const types = read(path.join(fe, 'src', 'types', 'exams.ts'));
assert.ok(/presentation\?: GroupPresentation \| null;/.test(types), 'PublicGroupDto.presentation typed');
assert.ok(/delivery\?: 'PLAYBACK_GRANT'/.test(types), 'PublicAssetRefDto.delivery typed');
const shell = read(path.join(examsDir, 'ExamRuntimeShell.tsx'));
assert.ok(/<ToeicReadingWorkspace\s+attemptId=\{attemptId\}/.test(shell), 'TOEIC reading receives attemptId');
assert.ok(/<ReadingWorkspace\s+attemptId=\{attemptId\}/.test(shell), 'IELTS reading receives attemptId');
assert.ok(/<WritingEditor\s+attemptId=\{attemptId\}/.test(shell), 'Writing receives attemptId (Task 1 visual)');
for (const f of ['ExamRuntimeShell.tsx', 'ListeningPlayer.tsx']) {
  assert.ok(!read(path.join(examsDir, f)).includes('`http://localhost:8080${rawUrl}`'), `${f}: hard-coded media origin`);
}
for (const f of ['ToeicReadingWorkspace.tsx', 'ToeicListeningWorkspace.tsx']) {
  const src = read(path.join(examsDir, f));
  assert.ok(!src.includes("label: o.label || o.id"), `${f}: stores the option label instead of the option id (EXAM-AUD-012)`);
  assert.ok(src.includes('partNumberFromCode(part.partCode)'), `${f}: part number from partCode (EXAM-AUD-037)`);
}
const reading = read(path.join(examsDir, 'ReadingWorkspace.tsx'));
assert.ok(reading.includes('<GroupQuestionBlock'), 'IELTS reading renders printed groups');
const listening = read(path.join(examsDir, 'ListeningPlayer.tsx'));
assert.ok(listening.includes('<GroupQuestionBlock'), 'IELTS listening renders printed groups');
const writing = read(path.join(examsDir, 'WritingEditor.tsx'));
assert.ok(writing.includes('visualStimuli') && writing.includes('attemptId={attemptId}'), 'Writing Task 1 visual rendered via grant');
const toeicListening = read(path.join(examsDir, 'ToeicListeningWorkspace.tsx'));
assert.ok(/playlistMode/.test(toeicListening) && /handleAudioEnded/.test(toeicListening), 'TOEIC per-part playlist');
const stim = read(path.join(examsDir, 'StimulusRenderer.tsx'));
assert.ok(stim.includes("a.delivery === 'PLAYBACK_GRANT'"), 'StimulusRenderer resolves grant images');

console.log('exams Phase 4 runtime contract: OK');
