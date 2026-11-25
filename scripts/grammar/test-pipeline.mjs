// Exercise the publishing gate in an isolated copy; never alter the working content.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-grammar-pipeline-'));
const scripts = path.join(sandbox, 'scripts/grammar');
const resources = path.join(sandbox, 'backend/src/main/resources/grammar');
fs.mkdirSync(scripts, { recursive: true });
fs.mkdirSync(path.dirname(resources), { recursive: true });
for (const name of ['build-catalog.mjs', 'validate.mjs']) fs.copyFileSync(path.join(repo, 'scripts/grammar', name), path.join(scripts, name));
fs.cpSync(path.join(repo, 'backend/src/main/resources/grammar'), resources, { recursive: true });
const run = () => spawnSync(process.execPath, [path.join(scripts, 'build-catalog.mjs')], { encoding: 'utf8' });
const validateOnly = fragment => spawnSync(process.execPath, [path.join(scripts, 'validate.mjs'), fragment], { encoding: 'utf8' });
const readCatalog = () => JSON.parse(fs.readFileSync(path.join(resources, 'catalog.json'), 'utf8'));
assert.equal(run().status, 0, 'valid content builds');
const initial = readCatalog();
const entries = initial.domains.flatMap(d => d.topics);
assert.equal(entries.length, initial.counts.planned, 'reference inventory stays complete');
assert.ok(entries.some(t => t.learningRole === 'reference' && t.available), 'reference is authored and accessible');
assert.ok(entries.filter(t => t.learningRole === 'reference').every(t => t.path === undefined), 'reference is not mandatory guided study');
assert.ok(entries.filter(t => ['core', 'advanced'].includes(t.learningRole)).every(t => Number.isInteger(t.path)), 'both guided tracks are ordered');
assert.equal(new Set(entries.map(t => t.slug)).size, entries.length, 'no duplicate canonical entries');
const before = readCatalog().revision;
const curriculumFile = path.join(resources, 'curriculum.json');
const curriculum = JSON.parse(fs.readFileSync(curriculumFile, 'utf8'));
curriculum.domains[0].title.vi += ' (kiểm thử)';
fs.writeFileSync(curriculumFile, JSON.stringify(curriculum));
assert.equal(run().status, 0);
assert.notEqual(readCatalog().revision, before, 'a curriculum change invalidates the ETag revision');
const caseFile = path.join(resources, 'topics/punctuation/semicolons-colons-dashes.json');
if (fs.existsSync(caseFile)) {
  const topic = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
  const item = topic.exercises.find(e => e.id === 'scd-10');
  assert.equal(item.caseMatters, true);
  const unchangedCatalog = fs.readFileSync(path.join(resources, 'catalog.json'), 'utf8');
  item.caseMatters = false;
  fs.writeFileSync(caseFile, JSON.stringify(topic));
  assert.notEqual(run().status, 0, 'folding case would make this known error collide with the key');
  assert.equal(fs.readFileSync(path.join(resources, 'catalog.json'), 'utf8'), unchangedCatalog);
  item.caseMatters = true;
  fs.writeFileSync(caseFile, JSON.stringify(topic));
  assert.equal(run().status, 0, 'case-aware known alternatives are distinct and valid');
}
const snapshot = fs.readFileSync(path.join(resources, 'catalog.json'), 'utf8');
const punctuationFile = path.join(resources, 'topics/tense-aspect/past-perfect.json');
if (fs.existsSync(punctuationFile)) {
  const topic = JSON.parse(fs.readFileSync(punctuationFile, 'utf8'));
  const item = topic.exercises.find(e => e.id === 'ppf-11');
  assert.equal(item.terminalPunctuationMatters, true);
  item.terminalPunctuationMatters = false;
  fs.writeFileSync(punctuationFile, JSON.stringify(topic));
  assert.notEqual(run().status, 0, 'punctuation folding must not collapse question and known period errors');
  assert.equal(fs.readFileSync(path.join(resources, 'catalog.json'), 'utf8'), snapshot);
  item.terminalPunctuationMatters = true;
  fs.writeFileSync(punctuationFile, JSON.stringify(topic));
  assert.equal(run().status, 0);
}
const finalSnapshot = fs.readFileSync(path.join(resources, 'catalog.json'), 'utf8');
const collisionFile = path.join(resources, 'topics/clauses/parallelism.json');
if (fs.existsSync(collisionFile)) {
  const raw = fs.readFileSync(collisionFile, 'utf8');
  const copy = JSON.parse(raw);
  copy.exercises[0].id = 'par-01';
  fs.writeFileSync(collisionFile, JSON.stringify(copy));
  assert.notEqual(validateOnly('clauses/parallelism').status, 0, 'scoped check catches collision with a later topic');
  assert.notEqual(validateOnly('modality/permission-and-requests').status, 0, 'either owner identifies the conflict');
  assert.notEqual(run().status, 0, 'global collisions block catalog generation');
  assert.equal(fs.readFileSync(path.join(resources, 'catalog.json'), 'utf8'), finalSnapshot);
  fs.writeFileSync(collisionFile, raw);
}
const topicFile = path.join(resources, 'topics/nouns/countable-uncountable.json');
const topic = JSON.parse(fs.readFileSync(topicFile, 'utf8'));
topic.exercises[0].options = [];
fs.writeFileSync(topicFile, JSON.stringify(topic));
const refused = run();
assert.notEqual(refused.status, 0, 'invalid answer options block publication');
assert.equal(fs.readFileSync(path.join(resources, 'catalog.json'), 'utf8'), finalSnapshot, 'failed publication preserves the previous catalog byte for byte');
console.log('PASS: full inventory, guided/reference separation, case/punctuation-aware keys, valid build, curriculum revision, invalid-content rejection, prior-catalog preservation.');
console.log(`Isolated evidence directory: ${sandbox}`);
