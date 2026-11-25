#!/usr/bin/env node
// Generates backend/src/main/resources/grammar/catalog.json: the small index the backend keeps in memory and the
// browser searches locally. Topic bodies stay in their own files and load on demand. Run after any content change.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.join(REPO, 'backend/src/main/resources/grammar');
// Never replace a usable index with content that fails the academy's structural gate.
const validation = spawnSync(process.execPath, [path.join(REPO, 'scripts/grammar/validate.mjs')], { encoding: 'utf8' });
if (validation.status !== 0) {
  process.stderr.write(validation.stdout || '');
  process.stderr.write(validation.stderr || '');
  throw new Error('Grammar validation failed; catalog was not changed.');
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)) : []);

const curriculum = read(path.join(ROOT, 'curriculum.json'));
const LEVEL_RANK = { preA1: 0, A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
const planned = new Map();
for (const d of curriculum.domains) for (const t of d.topics) planned.set(t.slug, { ...t, domain: d.id });

const hash = crypto.createHash('sha256');
hash.update(JSON.stringify(curriculum));
const domains = [];
const exerciseIndex = {};
const topics = [];
let exerciseCount = 0;

for (const d of curriculum.domains) {
  const entries = [];
  for (const plan of d.topics) {
    const file = path.join(ROOT, 'topics', d.id, `${plan.slug}.json`);
    if (!fs.existsSync(file)) {
      entries.push({ slug: plan.slug, title: { vi: plan.vi, en: plan.en }, aliases: (plan.includes || []).flatMap((x) => [x.vi, x.en]), level: plan.level, learningRole: plan.learningRole, available: false, prerequisites: plan.prerequisites || [] });
      continue;
    }
    const raw = fs.readFileSync(file, 'utf8');
    hash.update(raw);
    const t = JSON.parse(raw);
    const types = {};
    let checkItems = 0;
    for (const ex of t.exercises) {
      exerciseIndex[ex.id] = t.slug;
      types[ex.type] = (types[ex.type] || 0) + 1;
      if (ex.use === 'check') checkItems++;
      exerciseCount++;
    }
    const diagrams = [...new Set([...t.lesson, ...t.deep].filter((b) => b.type === 'diagram').map((b) => b.spec.kind))];
    const entry = {
      slug: t.slug, version: t.version, order: t.order, kind: t.kind,
      title: t.title, subtitle: t.subtitle ?? null,
      aliases: [...t.aliases, ...(plan.includes || []).flatMap((x) => [x.vi, x.en])],
      level: t.level, levelBasis: t.levelBasis,
      learningRole: plan.learningRole,
      uses: t.uses ?? [],
      prerequisites: t.prerequisites ?? [],
      related: t.related ?? [],
      exam: { ielts: !!t.exam?.ielts, toeic: !!t.exam?.toeic },
      mistakes: t.mistakes.map((m) => m.wrong),
      exerciseCount: t.exercises.length, checkItems, types, diagrams,
      status: t.editorial.status,
      available: true,
    };
    entries.push(entry);
    topics.push(entry);
  }
  domains.push({ id: d.id, order: d.order, tone: d.tone, kind: d.kind ?? 'grammar', title: d.title, summary: d.summary, topics: entries });
}

// Guided study excludes specialist reference entries. All topics remain searchable and directly addressable.
// Prerequisites order suggestions; they never lock a lesson or require mastery of the entire reference library.
const orderOf = new Map();
{
  const grammar = domains.filter((d) => d.kind === 'grammar').flatMap((d, di) => d.topics.filter(t => t.learningRole !== 'reference').map((t, ti) => ({ t, di, ti })));
  const key = (x) => LEVEL_RANK[x.t.level] * 10000 + x.di * 100 + x.ti;
  const bySlug = new Map(grammar.map((x) => [x.t.slug, x]));
  const done = new Set();
  const list = [...grammar].sort((a, b) => key(a) - key(b));
  const visit = (x) => {
    if (done.has(x.t.slug)) return;
    done.add(x.t.slug);
    for (const p of [...(x.t.prerequisites || [])].map((s) => bySlug.get(s)).filter(Boolean).sort((a, b) => key(a) - key(b))) visit(p);
    orderOf.set(x.t.slug, orderOf.size);
  };
  list.forEach(visit);
}
for (const d of domains) for (const t of d.topics) if (orderOf.has(t.slug)) t.path = orderOf.get(t.slug);

const section = (dir, map) => files(path.join(ROOT, dir)).sort().map((f) => {
  const raw = fs.readFileSync(f, 'utf8');
  hash.update(raw);
  return map(JSON.parse(raw));
});
const stories = section('stories', (s) => ({ id: s.id, title: s.title, summary: s.summary, level: s.level, topics: s.topics, scene: s.scene }));
const lab = section('lab', (s) => ({ id: s.id, title: s.title, summary: s.summary, level: s.level, topics: s.topics, kind: s.kind }));
const detective = section('detective', (s) => ({ id: s.id, title: s.title, level: s.level, topics: s.topics, brief: s.brief }));

const levels = {};
for (const t of topics) levels[t.level] = (levels[t.level] || 0) + 1;
const planned_total = planned.size;
const catalog = {
  schema: 1,
  revision: hash.digest('hex').slice(0, 16),
  counts: { planned: planned_total, topics: topics.length, reviewed: topics.filter((t) => t.status === 'reviewed').length, exercises: exerciseCount, stories: stories.length, lab: lab.length, detective: detective.length, levels },
  domains, stories, lab, detective, exerciseIndex,
};
fs.writeFileSync(path.join(ROOT, 'catalog.json'), JSON.stringify(catalog));
console.log(`catalog ${catalog.revision}: ${topics.length}/${planned_total} topics, ${exerciseCount} exercises, ${stories.length} stories, ${lab.length} lab, ${detective.length} detective, ${(fs.statSync(path.join(ROOT, 'catalog.json')).size / 1024).toFixed(0)} KB`);
