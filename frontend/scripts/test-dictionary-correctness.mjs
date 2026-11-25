// Dictionary correctness repair (owner brief 2026-10-24, audit docs/audits/DICTIONARY_TRANSLATION_READ_ONLY_AUDIT_2026-10-19.md):
// the general meaning is never shadowed by a sense text paired by position, the bundled EN-VI senses are listed as the
// word's meanings, every "Lưu Flashcard" path saves the same meaning, GTX term lists never reach a sense (client
// fallback included), one request per word at a time. Runs the real modules (Babel, as the study tests do).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const read = (p) => readFileSync(new URL('../src/' + p, import.meta.url), 'utf8');
const readRepo = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
function evaluate(path, dependencies = {}, globals = {}) {
  const { code } = babel.core().transformSync(read(path), { filename: path, configFile: false, babelrc: false,
    presets: [babel.presetTypescript()], plugins: [babel.pluginTransformModulesCommonjs()] });
  const module = { exports: {} };
  runInNewContext(code, { exports: module.exports, module, require: (p) => dependencies[p] ?? require(p), console,
    setTimeout, clearTimeout, encodeURIComponent, Promise, ...globals });
  return module.exports;
}

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('  ok', name); };

const ranking = evaluate('services/dictionaryRanking.ts');

// Revision-2 payload shape of "excitement" (what the repaired backend returns)
const excitement = {
  query: 'excitement', normalizedQuery: 'excitement', entryType: 'WORD', headword: 'excitement', lexiconRevision: 2,
  generalTranslationVi: 'sự phấn khích',
  pronunciations: [{ ipa: '/ɪkˈsaɪtmənt/' }],
  partsOfSpeech: [{ partOfSpeech: 'noun', senses: [{ id: '1', definitionEn: 'The state of feeling or showing happiness and enthusiasm.', examples: [] }] }],
  vietnameseSenses: [{ partOfSpeech: 'noun', meanings: ['Sự kích thích, sự kích động; tình trạng bị kích thích, tình trạng bị kích động.', 'Sự nhộn nhịp, sự náo động, sự sôi nổi.'] }],
  synonyms: ['exhilaration', 'turmoil'],
};

await check('excitement: general meaning leads, never discomfort, dictionary senses listed', () => {
  const r = ranking.rankCanonicalEntry(excitement, { contextSentence: 'Excitement about the huge range of opportunities grew.' });
  assert.equal(r.vietnameseMeaning, 'sự phấn khích');
  assert.match(r.englishDefinition, /happiness and enthusiasm/);
  assert.ok(!JSON.stringify(r).includes('khó chịu'));
  assert.equal(r.additionalMeanings[0], 'sự phấn khích', 'index 0 is the primary (cards list slice(1))');
  assert.match(r.additionalMeanings[1], /^Sự kích thích/);
});

await check('old revision-1 payload in a browser cache: general still wins over a positional sense text', () => {
  const old = JSON.parse(JSON.stringify(excitement));
  delete old.vietnameseSenses; delete old.lexiconRevision;
  old.partsOfSpeech[0].senses[0].translationVi = 'khó chịu';
  assert.equal(ranking.rankCanonicalEntry(old).vietnameseMeaning, 'sự phấn khích');
});

const bank = {
  query: 'bank', normalizedQuery: 'bank', entryType: 'WORD', headword: 'bank', generalTranslationVi: 'ngân hàng / bờ sông', pronunciations: [],
  partsOfSpeech: [
    { partOfSpeech: 'noun', senses: [
      { id: '1', definitionEn: 'A financial institution licensed to receive deposits and make loans.', translationVi: 'Ngân hàng (tổ chức tài chính).' },
      { id: '2', definitionEn: 'The land alongside or sloping down to a river or lake.', translationVi: 'Bờ sông, bờ hồ.' }] },
    { partOfSpeech: 'verb', senses: [{ id: '3', definitionEn: 'To deposit money in a bank.', translationVi: 'Gửi tiền vào ngân hàng.' }] }],
};

await check('curated aligned senses: the sentence context picks the riverbank sense', () => {
  const r = ranking.rankCanonicalEntry(bank, { contextSentence: 'They rested on the bank in the shade by the river today' });
  assert.equal(r.vietnameseMeaning, 'Bờ sông, bờ hồ.');
  assert.match(r.englishDefinition, /river/);
  const noContext = ranking.rankCanonicalEntry(bank);
  assert.equal(noContext.vietnameseMeaning, 'ngân hàng / bờ sông', 'without context the general meaning leads');
});

await check('entry from the bundled dictionary alone (providers silent) is valid and shown in Vietnamese', () => {
  const engine = evaluate('services/dictionaryEngine.ts', { '@/services/api-client': { apiClient: { get: async () => ({}) } } });
  const localOnly = { query: 'engaged', normalizedQuery: 'engaged', entryType: 'WORD', headword: 'engaged', generalTranslationVi: 'Đã đính ước, đã hứa hôn',
    pronunciations: [], partsOfSpeech: [{ partOfSpeech: 'adjective', senses: [{ id: '1', translationVi: 'Đã đính ước, đã hứa hôn.' }, { id: '2', translationVi: 'Mắc bận, bận rộn.' }] }],
    vietnameseSenses: [{ partOfSpeech: 'adjective', meanings: ['Đã đính ước, đã hứa hôn.', 'Mắc bận, bận rộn.'] }] };
  assert.equal(engine.hasValidLexicalContent(localOnly), true);
  assert.equal(engine.hasValidLexicalContent({ ...localOnly, partsOfSpeech: [{ partOfSpeech: 'adjective', senses: [{ id: '1' }] }] }), false,
    'a shell with only a general translation is still rejected');
  const r = ranking.rankCanonicalEntry(localOnly);
  assert.equal(r.vietnameseMeaning, 'Đã đính ước, đã hứa hôn');
  assert.ok(r.additionalMeanings.includes('Mắc bận, bận rộn.'));
});

await check('dictionary senses: the chosen part of speech first; "adverb" is not a verb', () => {
  const entry = { vietnameseSenses: [{ partOfSpeech: 'verb', meanings: ['Chạy.'] }, { partOfSpeech: 'adverb', meanings: ['Nhanh.'] }] };
  assert.deepEqual([...ranking.vietnameseMeaningsFor(entry, 'Adverb')], ['Nhanh.', 'Chạy.']);
  assert.deepEqual([...ranking.vietnameseMeaningsFor(entry, 'verb')], ['Chạy.', 'Nhanh.']);
});

await check('one Flashcard meaning rule: general → aligned first sense → dictionary first meaning', () => {
  assert.equal(ranking.flashcardMeaningVi(excitement), 'sự phấn khích');
  const noGeneral = { ...excitement, generalTranslationVi: undefined };
  assert.match(ranking.flashcardMeaningVi(noGeneral), /^Sự kích thích/);
  assert.equal(ranking.flashcardMeaningVi({ ...bank, generalTranslationVi: '' }), 'Ngân hàng (tổ chức tài chính).');
  assert.equal(ranking.flashcardMeaningVi({ partsOfSpeech: [{ partOfSpeech: 'noun', senses: [{ id: '1', definitionEn: 'x' }] }] }), null);
});

await check('every save button uses the one rule (no sense text before the general meaning)', () => {
  const global = read('components/features/dictionary/GlobalDictionarySearch.tsx');
  const popup = read('components/features/dictionary/DictionaryPopup.tsx');
  assert.match(global, /flashcardMeaningVi\(result\)/);
  assert.match(popup, /flashcardMeaningVi\(data\) \|\| s\.definitionEn/);
  assert.doesNotMatch(popup, /back = s\.translationVi \|\| s\.definitionEn/);
  assert.doesNotMatch(global, /dictMode === 'en-vi' && firstSense\.translationVi\) \{\s*back = firstSense\.translationVi/);
  // the ranked cards save `vietnameseMeaning` (the general meaning first)
  assert.match(read('components/features/dictionary/QuickDictionaryCard.tsx'), /onAddFlashcard\(data\.word, data\.vietnameseMeaning/);
  assert.match(read('components/dashboard/WordLookupPopover.tsx'), /data\?\.vietnameseMeaning/);
});

await check('one request per word at a time; an aborted caller only stops its own wait', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const apiClient = { get: async () => { calls++; await gate; return { data: excitement }; } };
  const engine = evaluate('services/dictionaryEngine.ts', { '@/services/api-client': { apiClient } });
  const controller = new AbortController();
  const a = engine.lookupCanonical('Excitement', 'en-vi');
  const b = engine.lookupCanonical('excitement', 'en-en', { signal: controller.signal });
  controller.abort();
  release();
  assert.equal(await b, null);
  assert.equal((await a).headword, 'excitement');
  assert.equal(calls, 1);
  await engine.lookupCanonical('excitement', 'en-vi');
  assert.equal(calls, 1, 'served from the session cache');
});

await check('query normalisation: NFC, case, spacing (one cache entry per word)', () => {
  const engine = evaluate('services/dictionaryEngine.ts', { '@/services/api-client': { apiClient: { get: async () => ({}) } } });
  assert.equal(engine.normalizeQuery('  CAFÉ   Au  Lait '), 'café au lait');
});

await check('client fallback: GTX term lists never become sense translations', async () => {
  const fetchStub = async (url) => ({
    ok: true,
    json: async () => String(url).startsWith('/api/dictionary')
      ? [{ word: 'interest', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'The feeling of wanting to know about something.' }, { definition: 'Money paid for the use of money.' }] }] }]
      : [[['quan tâm', 'interest']], [['noun', ['lãi', 'quyền lợi', 'sự quan tâm']]]],
  });
  const apiClient = { get: async () => { const e = new Error('down'); e.response = { status: 502 }; throw e; } };
  const engine = evaluate('services/dictionaryEngine.ts', { '@/services/api-client': { apiClient } }, { fetch: fetchStub });
  const entry = await engine.lookupCanonical('interest', 'en-vi');
  assert.equal(entry.generalTranslationVi, 'quan tâm');
  for (const s of entry.partsOfSpeech[0].senses) assert.equal(s.translationVi, undefined, s.definitionEn);
});

await check('backend contract: no positional GTX mapping, no Datamuse synonyms on sense 0, versioned payloads', () => {
  const gtx = readRepo('backend/src/main/java/com/englishcoach/dictionary/provider/GoogleGtxTranslationProvider.java');
  const engine = readRepo('backend/src/main/java/com/englishcoach/dictionary/service/DictionaryEngine.java');
  assert.doesNotMatch(gtx, /mapTranslationsToSenses|setTranslationVi\(/);
  assert.doesNotMatch(engine, /senses\.get\(0\)\.setSynonyms/);
  assert.match(engine, /public static final int LEXICON_REVISION = \d+;/);
  assert.match(engine, /lookupEntry\(/, 'single words read the bundled EN-VI dictionary');
  assert.doesNotMatch(engine, /if \(sense\.getTranslationVi\(\) != null\) meanings\.add/, 'legacy meanings hold English definitions only');
});

console.log(`dictionary correctness: ${passed} checks passed`);
