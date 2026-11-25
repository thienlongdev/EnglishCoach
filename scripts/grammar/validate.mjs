#!/usr/bin/env node
// Echo Grammar Academy content validator. Usage: node scripts/grammar/validate.mjs [--strict] [path-fragment]
// Structure, references, answer-key consistency. It cannot judge linguistic truth: that is the review pass's work.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.join(REPO, 'backend/src/main/resources/grammar');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const filter = args.find((a) => !a.startsWith('--'));

const LEVELS = new Set(['preA1', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
const BASES = new Set(['EGP', 'BC', 'editorial']);
const RELS = new Set(['contrast', 'confusion', 'more', 'special', 'alternative', 'application']);
const ROLES = new Set(['S', 'V', 'AUX', 'MOD', 'O', 'C', 'A', 'T', 'DET', 'N', 'ADJ', 'ADV', 'PREP', 'CL', 'SUB', 'COND', 'RES', 'FOCUS', 'NEG', 'Q', 'REF']);
const USES = new Set(['practice', 'check', 'both']);
const SKILLS = new Set(['form', 'meaning', 'use', 'production', 'recognition']);
const VERDICTS = new Set(['wrong', 'acceptable', 'awkward']);
const TAGS = new Set(['BrE', 'AmE', 'formal', 'informal', 'spoken', 'written']);
const NOTE_KINDS = new Set(['tip', 'warn', 'register', 'regional', 'vn']);
const DIAGRAMS = new Set(['timeline', 'tree', 'transform', 'branch', 'agent', 'reference', 'scale', 'slots', 'clauses', 'matrix', 'flow']);
const SCENES = new Set(['university', 'supermarket', 'interview', 'restaurant', 'airport', 'office', 'home', 'library-mystery', 'starship', 'lecture', 'station', 'newsroom']);
const SOURCE_REFS = new Set(['cgt', 'egp', 'bc', 'swan-peu', 'murphy-egu', 'murphy-essential', 'hewings-agu', 'eastwood-opg', 'cgel', 'quirk', 'lgswe', 'carter-cge', 'ielts-bd', 'ets-toeic', 'purdue-owl']);
const TYPES = new Set(['choice', 'multi', 'cloze', 'order', 'transform', 'error', 'match', 'classify', 'open']);

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

export const stripRoles = (s) => s.replace(/\[([A-Z]+)\|/g, '').replace(/\]/g, '');

function viText(where, v, field) {
  if (!isStr(v)) return err(where, `${field} must be non-empty text`);
  if (/&(?!&)/.test(v) && !v.includes('`')) err(where, `${field} uses "&": write "và"`);
  if (/✨|🎉|🔥|⭐/.test(v)) err(where, `${field} has an emoji`);
}

function enRole(where, s, field) {
  if (!isStr(s)) return err(where, `${field} must be non-empty English`);
  const stack = [];
  for (const m of s.matchAll(/\[([A-Za-z]*)\||\]/g)) {
    if (m[0] === ']') { if (!stack.length) err(where, `${field}: stray "]" in ${s}`); stack.pop(); } else {
      if (!ROLES.has(m[1])) err(where, `${field}: unknown role ${m[1]} in ${s}`);
      stack.push(m[1]);
    }
  }
  if (stack.length) err(where, `${field}: unclosed role in ${s}`);
}

function checkFlow(where, spec) {
  const nodes = spec.nodes || {};
  if (!nodes[spec.start]) return err(where, 'flow: start node missing');
  const seen = new Set();
  const stack = new Set();
  const walk = (id) => {
    if (stack.has(id)) return err(where, `flow: cycle at ${id}`);
    if (seen.has(id)) return;
    const n = nodes[id];
    if (!n) return err(where, `flow: node ${id} missing`);
    seen.add(id); stack.add(id);
    const next = n.end !== undefined ? [] : n.choices ? n.choices.map((c) => c.to) : [n.yes, n.no];
    if (n.end === undefined && !n.q) err(where, `flow: node ${id} has no q`);
    next.forEach(walk);
    stack.delete(id);
  };
  walk(spec.start);
  for (const id of Object.keys(nodes)) if (!seen.has(id)) err(where, `flow: node ${id} unreachable`);
}

function checkBracket(where, b) {
  if (!isStr(b)) return err(where, 'tree: bracket required');
  let d = 0;
  for (const c of b) { if (c === '[') d++; if (c === ']') { d--; if (d < 0) break; } }
  if (d !== 0) err(where, `tree: unbalanced bracket ${b}`);
  if (!/^\[[A-Za-z]+ /.test(b.trim())) err(where, `tree: must start with a label ${b}`);
}

function checkDiagram(where, spec) {
  if (!spec || !DIAGRAMS.has(spec.kind)) return err(where, `unknown diagram kind ${spec && spec.kind}`);
  switch (spec.kind) {
    case 'timeline':
      if (!isStr(spec.sentence)) err(where, 'timeline: sentence required');
      if (!Array.isArray(spec.events) || !spec.events.length) err(where, 'timeline: events required');
      for (const e of spec.events || []) {
        if (!['point', 'span', 'repeat', 'open'].includes(e.kind)) err(where, `timeline: bad event ${e.kind}`);
        if (e.kind === 'point' && !(e.at >= 0 && e.at <= 100)) err(where, 'timeline: point needs at 0-100');
        if (e.kind !== 'point' && !(e.from >= 0 && e.to <= 100 && e.from < e.to)) err(where, 'timeline: span needs from < to in 0-100');
        if (!isStr(e.label)) err(where, 'timeline: event label required');
      }
      break;
    case 'tree': checkBracket(where, spec.bracket); break;
    case 'transform':
      if (!Array.isArray(spec.steps) || spec.steps.length < 2) err(where, 'transform: 2+ steps');
      for (const s of spec.steps || []) { if (!isStr(s.sentence) || !isStr(s.label)) err(where, 'transform: step needs label + sentence'); }
      break;
    case 'branch':
      if (!Array.isArray(spec.branches) || !spec.branches.length) err(where, 'branch: branches');
      for (const b of spec.branches || []) { if (!isStr(b.cond) || !isStr(b.result) || !['real', 'unreal', 'past-unreal', 'mixed'].includes(b.world)) err(where, 'branch: cond, result, world'); }
      break;
    case 'agent': for (const f of ['agent', 'action', 'patient', 'active', 'passive']) if (!isStr(spec[f])) err(where, `agent: ${f}`); break;
    case 'reference': if (!isStr(spec.text) || !/\{[a-z]+:/.test(spec.text)) err(where, 'reference: text with {a:..} anchors'); break;
    case 'scale':
      if (!Array.isArray(spec.items) || spec.items.length < 2) err(where, 'scale: 2+ items');
      for (const i of spec.items || []) if (!(i.pos >= 0 && i.pos <= 100) || !isStr(i.t)) err(where, 'scale: pos + t');
      break;
    case 'slots': if (!Array.isArray(spec.slots) || !spec.slots.length) err(where, 'slots: slots'); break;
    case 'clauses': if (!spec.tree || !spec.tree.kind) err(where, 'clauses: tree'); break;
    case 'matrix':
      if (!Array.isArray(spec.rows) || !Array.isArray(spec.cols) || !Array.isArray(spec.cells)) err(where, 'matrix: rows, cols, cells');
      else if (spec.cells.length !== spec.rows.length || spec.cells.some((r) => r.length !== spec.cols.length)) err(where, 'matrix: cells shape must equal rows × cols');
      break;
    case 'flow': checkFlow(where, spec); break;
  }
}

function checkBlocks(where, blocks, exerciseIds) {
  if (!Array.isArray(blocks)) return err(where, 'blocks must be a list');
  blocks.forEach((b, i) => {
    const w = `${where}[${i}]`;
    switch (b.type) {
      case 'p': case 'h': viText(w, b.vi, 'vi'); break;
      case 'formula': {
        const lines = b.lines || [{ parts: b.parts }];
        for (const l of lines) {
          if (!Array.isArray(l.parts) || !l.parts.length) err(w, 'formula: parts');
          for (const p of l.parts || []) { if (!isStr(p.t)) err(w, 'formula: part t'); if (p.role && !ROLES.has(p.role)) err(w, `formula: role ${p.role}`); }
        }
        break;
      }
      case 'examples':
        if (!Array.isArray(b.items) || !b.items.length) err(w, 'examples: items');
        for (const it of b.items || []) { enRole(w, it.en, 'en'); viText(w, it.vi, 'vi'); if (it.tag && !TAGS.has(it.tag)) err(w, `examples: tag ${it.tag}`); }
        break;
      case 'contrast':
        if (!Array.isArray(b.items) || !b.items.length) err(w, 'contrast: items');
        for (const it of b.items || []) { enRole(w, it.a && it.a.en, 'a.en'); enRole(w, it.b && it.b.en, 'b.en'); viText(w, it.diff, 'diff'); }
        break;
      case 'table':
        if (!Array.isArray(b.head) || !Array.isArray(b.rows)) err(w, 'table: head + rows');
        for (const r of b.rows || []) if (r.length !== b.head.length) err(w, 'table: row length differs from head');
        break;
      case 'note': if (!NOTE_KINDS.has(b.kind)) err(w, `note: kind ${b.kind}`); viText(w, b.vi, 'vi'); break;
      case 'diagram': checkDiagram(w, b.spec); viText(w, b.caption, 'caption'); viText(w, b.alt, 'alt'); break;
      case 'try': if (!exerciseIds.has(b.exercise)) err(w, `try: unknown exercise ${b.exercise}`); break;
      default: err(w, `unknown block ${b.type}`);
    }
  });
}

const norm = (s, caseMatters = false, terminalPunctuationMatters = false) => {
  let value = s.normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  if (!terminalPunctuationMatters) value = value.replace(/[.!?]+$/, '').trim();
  return caseMatters ? value : value.toLowerCase();
};

function checkOptions(w, ex, multi) {
  if (!isStr(ex.stem) && !ex.turns) err(w, 'stem required');
  if (!Array.isArray(ex.options) || ex.options.length < 2) return err(w, 'options: 2+');
  const good = ex.options.filter((o) => o.ok);
  if (!good.length) err(w, 'no correct option');
  if (multi && good.length < 2) err(w, 'multi needs 2+ correct options (else use choice)');
  const seen = new Set();
  for (const o of ex.options) {
    if (!isStr(o.t) && !o.diagram) err(w, 'option text');
    if (isStr(o.t)) { const n = norm(o.t, ex.caseMatters === true, ex.terminalPunctuationMatters === true); if (seen.has(n)) err(w, `duplicate option ${o.t}`); seen.add(n); }
    if (!isStr(o.note)) err(w, `option "${o.t}" needs a note`);
    if (o.diagram) checkDiagram(w, o.diagram);
  }
  if (!multi && good.length === ex.options.length) err(w, 'every option is correct');
}

function checkKnown(w, list, accept, caseMatters = false, terminalPunctuationMatters = false) {
  for (const k of list || []) {
    if (!VERDICTS.has(k.verdict)) err(w, `known verdict ${k.verdict}`);
    if (!isStr(k.note)) err(w, 'known needs a note');
    const t = k.t ?? (k.seq && k.seq.join(' '));
    if (accept && accept.some((a) => norm(a, caseMatters, terminalPunctuationMatters) === norm(t, caseMatters, terminalPunctuationMatters)) ) err(w, `"${t}" is in both accept and known`);
  }
}

function checkExercise(where, ex, seenIds, slug) {
  const w = `${where} ${ex.id || '?'}`;
  if (!isStr(ex.id)) err(w, 'id');
  seenIds.add(ex.id);
  if (!TYPES.has(ex.type)) return err(w, `type ${ex.type}`);
  if (!LEVELS.has(ex.level)) err(w, `level ${ex.level}`);
  if (!USES.has(ex.use)) err(w, `use ${ex.use}`);
  if (!SKILLS.has(ex.skill)) err(w, `skill ${ex.skill}`);
  if (ex.caseMatters !== undefined && typeof ex.caseMatters !== 'boolean') err(w, 'caseMatters must be boolean');
  if (ex.terminalPunctuationMatters !== undefined && typeof ex.terminalPunctuationMatters !== 'boolean') err(w, 'terminalPunctuationMatters must be boolean');
  viText(w, ex.prompt, 'prompt');
  if (ex.type !== 'open') viText(w, ex.explain, 'explain');
  switch (ex.type) {
    case 'choice': checkOptions(w, ex, false); break;
    case 'multi': checkOptions(w, ex, true); break;
    case 'cloze': {
      if (!isStr(ex.stem)) err(w, 'stem');
      const ids = [...(ex.stem || '').matchAll(/\{(\d+)\}/g)].map((m) => m[1]);
      if (!ids.length) err(w, 'stem has no {1}');
      for (const id of ids) {
        const b = ex.blanks && ex.blanks[id];
        if (!b || !Array.isArray(b.accept) || !b.accept.length) { err(w, `blank ${id}: accept`); continue; }
        checkKnown(w, b.known, b.accept, ex.caseMatters === true, ex.terminalPunctuationMatters === true);
      }
      if (ex.blanks && Object.keys(ex.blanks).length !== new Set(ids).size) err(w, 'blanks differ from stem');
      break;
    }
    case 'order':
      if (!Array.isArray(ex.tokens) || ex.tokens.length < 2) err(w, 'tokens');
      if (!Array.isArray(ex.accept) || !ex.accept.length) err(w, 'accept');
      for (const seq of ex.accept || []) {
        if ([...seq].sort().join('\u0001') !== [...(ex.tokens || [])].sort().join('\u0001')) err(w, `accept order is not a permutation of tokens: ${seq.join(' ')}`);
      }
      for (const k of ex.known || []) {
        if ([...k.seq].sort().join('\u0001') !== [...(ex.tokens || [])].sort().join('\u0001')) err(w, 'known seq is not a permutation of tokens');
      }
      checkKnown(w, ex.known);
      break;
    case 'transform':
      if (!isStr(ex.source) && !ex.turns) err(w, 'source');
      viText(w, ex.instruction, 'instruction');
      if (!Array.isArray(ex.accept) || !ex.accept.length) err(w, 'accept');
      if (!isStr(ex.model)) err(w, 'model');
      else if (!(ex.accept || []).some((a) => norm(a, ex.caseMatters === true, ex.terminalPunctuationMatters === true) === norm(ex.model, ex.caseMatters === true, ex.terminalPunctuationMatters === true))) err(w, 'model must be in accept');
      checkKnown(w, ex.known, ex.accept, ex.caseMatters === true, ex.terminalPunctuationMatters === true);
      break;
    case 'error': {
      if (!Array.isArray(ex.segments) || ex.segments.length < 2) { err(w, 'segments'); break; }
      const bad = ex.segments.filter((s) => s.bad);
      if (ex.noError && bad.length) err(w, 'noError but has bad segments');
      if (!ex.noError && !bad.length) err(w, 'no bad segment and no noError');
      for (const s of bad) { if (!Array.isArray(s.fix) || !s.fix.length) err(w, 'bad segment needs fix'); if (!isStr(s.note)) err(w, 'bad segment needs note'); }
      break;
    }
    case 'match':
      if (!Array.isArray(ex.pairs) || ex.pairs.length < 3 || ex.pairs.length > 8) err(w, 'pairs: 3-8');
      else if (new Set(ex.pairs.map((p) => p.b)).size !== ex.pairs.length) err(w, 'match: duplicate right side would make it ambiguous');
      break;
    case 'classify':
      if (!Array.isArray(ex.cats) || ex.cats.length < 2) err(w, 'cats');
      for (const it of ex.items || []) if (!ex.cats.includes(it.cat)) err(w, `item cat ${it.cat} not in cats`);
      if (!Array.isArray(ex.items) || ex.items.length < 3) err(w, 'items: 3+');
      break;
    case 'open':
      viText(w, ex.task, 'task');
      if (!Array.isArray(ex.model) || !ex.model.length) err(w, 'model');
      if (!Array.isArray(ex.checklist) || !ex.checklist.length) err(w, 'checklist');
      if (ex.use !== 'practice') err(w, 'open exercises are never used in a check (use: practice)');
      break;
  }
}

function listJson(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJson(p));
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

const read = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { err(path.relative(REPO, file), `invalid JSON: ${e.message}`); return null; }
};

const curriculum = read(path.join(ROOT, 'curriculum.json'));
const planned = new Map();
const domainIds = new Set();
for (const d of curriculum?.domains || []) {
  domainIds.add(d.id);
  for (const t of d.topics || []) {
    if (planned.has(t.slug)) err(t.slug, 'duplicate canonical curriculum slug');
    if (!['core', 'advanced', 'reference', 'application'].includes(t.learningRole)) err(t.slug, 'missing/invalid learningRole');
    if ((d.kind === 'application') !== (t.learningRole === 'application')) err(t.slug, 'learningRole must agree with application domain');
    planned.set(t.slug, { ...t, domain: d.id });
  }
}

const topicFiles = listJson(path.join(ROOT, 'topics'));
const topics = new Map();
const seenIds = new Set();
for (const file of topicFiles) {
  const t = read(file);
  if (!t) continue;
  const slug = path.basename(file, '.json');
  if (topics.has(slug)) err(slug, 'duplicate slug');
  topics.set(slug, { t, file });
}

// Index the entire inventory before a filtered check. Otherwise a newly written file can
// appear before an existing collision and its scoped run would silently report PASS.
const exerciseOwners = new Map();
let authoredExerciseCount = 0;
for (const [slug, { t }] of topics) {
  for (const ex of t.exercises || []) {
    authoredExerciseCount++;
    if (!isStr(ex.id)) continue;
    const previous = exerciseOwners.get(ex.id);
    if (previous) err(`exercise ${ex.id}`, `duplicate exercise id in ${previous} and ${slug}`);
    else exerciseOwners.set(ex.id, slug);
  }
}

for (const [slug, { t, file }] of topics) {
  if (filter && !file.replace(/\\/g, '/').includes(filter)) { (t.exercises || []).forEach((e) => seenIds.add(e.id)); continue; }
  const w = slug;
  if (t.schema !== 1) err(w, 'schema must be 1');
  if (t.slug !== slug) err(w, `slug ${t.slug} differs from the file name`);
  if (!Number.isInteger(t.version) || t.version < 1) err(w, 'version');
  if (!domainIds.has(t.domain)) err(w, `domain ${t.domain} not in curriculum`);
  if (path.basename(path.dirname(file)) !== t.domain) err(w, 'file not in its domain folder');
  if (!planned.has(slug)) err(w, 'not in curriculum.json');
  if (!Number.isInteger(t.order)) err(w, 'order');
  if (!['grammar', 'application'].includes(t.kind)) err(w, `kind ${t.kind}`);
  if (!t.title || !isStr(t.title.vi) || !isStr(t.title.en)) err(w, 'title vi + en');
  if (!Array.isArray(t.aliases) || t.aliases.length < 2) err(w, 'aliases: 2+');
  if (!LEVELS.has(t.level)) err(w, `level ${t.level}`);
  if (!BASES.has(t.levelBasis)) err(w, `levelBasis ${t.levelBasis}`);
  if (!Array.isArray(t.objectives) || t.objectives.length < 2 || t.objectives.length > 6) err(w, 'objectives: 2-6');
  for (const r of t.related || []) { if (!RELS.has(r.rel)) err(w, `related rel ${r.rel}`); if (!planned.has(r.slug)) err(w, `related ${r.slug} not in curriculum`); }
  for (const p of t.prerequisites || []) { if (!planned.has(p)) err(w, `prerequisite ${p} not in curriculum`); if (p === slug) err(w, 'self prerequisite'); }
  if (!t.quick || !isStr(t.quick.what) || !isStr(t.quick.when) || !Array.isArray(t.quick.examples) || !t.quick.examples.length) err(w, 'quick: what, when, examples');
  for (const ex of t.quick?.examples || []) { enRole(w, ex.en, 'quick.en'); viText(w, ex.vi, 'quick.vi'); }
  const exIds = new Set((t.exercises || []).map((e) => e.id));
  checkBlocks(`${w} lesson`, t.lesson, exIds);
  checkBlocks(`${w} deep`, t.deep, exIds);
  if (!Array.isArray(t.lesson) || t.lesson.length < 4) err(w, 'lesson: 4+ blocks');
  if (!Array.isArray(t.deep) || t.deep.length < 2) err(w, 'deep: 2+ blocks');
  if (!Array.isArray(t.mistakes) || t.mistakes.length < 2) err(w, 'mistakes: 2+');
  for (const m of t.mistakes || []) { if (!isStr(m.id) || !isStr(m.wrong) || !isStr(m.right) || !isStr(m.why)) err(w, 'mistake fields'); }
  if (!Array.isArray(t.faq) || t.faq.length < 2) err(w, 'faq: 2+');
  for (const q of t.faq || []) { viText(w, q.q, 'faq.q'); viText(w, q.a, 'faq.a'); }
  for (const s of t.sources || []) if (!SOURCE_REFS.has(s.ref)) err(w, `source ref ${s.ref}`);
  if (!Array.isArray(t.sources) || !t.sources.length) err(w, 'sources');
  if (!t.editorial || !['drafted', 'reviewed'].includes(t.editorial.status)) err(w, 'editorial.status');
  const exercises = t.exercises || [];
  if (exercises.length < 10) err(w, `exercises: ${exercises.length} < 10`);
  for (const ex of exercises) checkExercise(`${w} ex`, ex, seenIds, slug);
  const types = new Set(exercises.map((e) => e.type));
  if (types.size < 4) err(w, `exercise types: ${types.size} < 4`);
  const check = exercises.filter((e) => e.use === 'check').length;
  if (check < 4) err(w, `check-only exercises: ${check} < 4`);
  if (['B1', 'B2', 'C1', 'C2'].includes(t.level) && !exercises.some(e => e.use === 'check'
      && ['cloze', 'transform', 'order'].includes(e.type) && e.skill !== 'recognition'))
    err(w, 'advanced assessment needs a held-out English construction item, not recognition only');
  const practice = exercises.filter((e) => e.use !== 'check').length;
  if (practice < 6) err(w, `practice exercises: ${practice} < 6`);
  if (exercises.filter((e) => e.level === t.level && e.type !== 'open' && e.use !== 'practice').length < 2) err(w, 'needs 2+ gradable exercises at the topic level (diagnostic)');
  for (const b of [...(t.lesson || []), ...(t.deep || [])]) if (b.type === 'try' && exercises.find((e) => e.id === b.exercise)?.use === 'check') err(w, `try points at a check-only exercise ${b.exercise}`);
  const prod = exercises.filter((e) => ['cloze', 'transform', 'order'].includes(e.type)).length;
  if (prod < 2) err(w, `production exercises: ${prod} < 2`);
  const hasDiagram = (t.lesson || []).some((b) => b.type === 'diagram');
  if (!hasDiagram) warn(w, 'lesson has no diagram');
}

// Prerequisite graph: no cycles among the topics that exist.
{
  const state = new Map();
  const walk = (slug, trail) => {
    if (state.get(slug) === 1) return err(slug, `prerequisite cycle: ${[...trail, slug].join(' -> ')}`);
    if (state.get(slug) === 2) return;
    state.set(slug, 1);
    const prereqs = planned.get(slug)?.prerequisites || topics.get(slug)?.t.prerequisites || [];
    for (const p of prereqs) walk(p, [...trail, slug]);
    state.set(slug, 2);
  };
  for (const slug of planned.keys()) walk(slug, []);
}

for (const file of listJson(path.join(ROOT, 'stories'))) {
  const s = read(file); if (!s) continue;
  const w = `story ${path.basename(file)}`;
  if (s.id !== path.basename(file, '.json')) err(w, 'id differs from the file name');
  if (!SCENES.has(s.scene)) err(w, `scene ${s.scene}`);
  for (const t of s.topics || []) if (!planned.has(t)) err(w, `topic ${t} not in curriculum`);
  if (!LEVELS.has(s.level)) err(w, `level ${s.level}`);
  const beats = new Map((s.beats || []).map((b) => [b.id, b]));
  if (!beats.size) err(w, 'beats');
  const cast = new Set((s.cast || []).map((c) => c.id));
  const seen = new Set(); const stack = new Set();
  const walk = (id) => {
    if (stack.has(id)) return err(w, `cycle at ${id}`);
    if (seen.has(id)) return;
    const b = beats.get(id);
    if (!b) return err(w, `beat ${id} missing`);
    seen.add(id); stack.add(id);
    for (const line of b.say || []) { if (!cast.has(line.who)) err(w, `beat ${id}: speaker ${line.who}`); if (!isStr(line.en) || !isStr(line.vi)) err(w, `beat ${id}: line needs en + vi`); }
    if (b.scene && !SCENES.has(b.scene)) err(w, `beat ${id}: scene ${b.scene}`);
    if (b.explain) checkBlocks(`${w} beat ${id}`, b.explain, new Set());
    const next = [];
    if (b.choice) {
      if (!b.choice.options?.some((o) => o.ok)) err(w, `beat ${id}: no ok option`);
      for (const o of b.choice.options || []) { if (!isStr(o.note)) err(w, `beat ${id}: option note`); if (o.next) next.push(o.next); }
      if (b.next) next.push(b.next);
      if (!b.next && (b.choice.options || []).some((o) => !o.next)) err(w, `beat ${id}: an option leads nowhere`);
    } else if (b.next) next.push(b.next);
    else if (!b.end) err(w, `beat ${id}: no next and not an end`);
    next.forEach(walk);
    stack.delete(id);
  };
  if (s.beats?.[0]) walk(s.beats[0].id);
  for (const id of beats.keys()) if (!seen.has(id)) err(w, `beat ${id} unreachable`);
}

for (const file of listJson(path.join(ROOT, 'lab'))) {
  const s = read(file); if (!s) continue;
  const w = `lab ${path.basename(file)}`;
  if (s.id !== path.basename(file, '.json')) err(w, 'id differs from the file name');
  for (const t of s.topics || []) if (!planned.has(t)) err(w, `topic ${t} not in curriculum`);
  if (s.kind === 'switchboard') {
    let keys = [''];
    for (const a of s.axes || []) keys = keys.flatMap((k) => a.values.map((v) => (k ? `${k}|${v.id}` : v.id)));
    for (const k of keys) {
      const r = s.results?.[k];
      if (!r) { err(w, `missing combination ${k}`); continue; }
      if (!['ok', 'odd', 'bad'].includes(r.verdict)) err(w, `${k}: verdict`);
      if (r.verdict !== 'bad' && !isStr(r.vi)) err(w, `${k}: vi`);
      if (!isStr(r.note)) err(w, `${k}: note`);
      if (r.timeline) checkDiagram(`${w} ${k}`, { kind: 'timeline', ...r.timeline });
    }
    if (Object.keys(s.results || {}).length !== keys.length) err(w, 'results has combinations no axis produces');
  } else if (s.kind === 'arrange') {
    for (const o of s.orders || []) {
      if ([...o.seq].sort().join('\u0001') !== [...s.tokens].sort().join('\u0001')) err(w, `order is not a permutation: ${o.seq.join(' ')}`);
      if (!['ok', 'odd', 'bad'].includes(o.verdict) || !isStr(o.note)) err(w, 'order verdict + note');
    }
    if (!(s.orders || []).some((o) => o.verdict === 'ok')) err(w, 'no valid order');
  } else err(w, `kind ${s.kind}`);
}

for (const file of listJson(path.join(ROOT, 'detective'))) {
  const s = read(file); if (!s) continue;
  const w = `detective ${path.basename(file)}`;
  if (s.id !== path.basename(file, '.json')) err(w, 'id differs from the file name');
  for (const t of s.topics || []) if (!planned.has(t)) err(w, `topic ${t} not in curriculum`);
  if (!Array.isArray(s.paragraph)) { err(w, 'paragraph'); continue; }
  for (const seg of s.paragraph) {
    if (!isStr(seg.t)) err(w, 'segment t');
    if (seg.bad && (!Array.isArray(seg.fix) || !seg.fix.length || !isStr(seg.note))) err(w, `segment "${seg.t}" needs fix + note`);
    if (seg.decoy && !isStr(seg.note)) err(w, `decoy "${seg.t}" needs a note`);
  }
  if (!s.paragraph.some((x) => x.decoy)) err(w, 'needs at least one decoy');
}

const written = topics.size;
console.log(`topics: ${written} written of ${planned.size} planned · exercises: ${authoredExerciseCount}${authoredExerciseCount !== seenIds.size ? ` (${seenIds.size} unique IDs)` : ''}`);
for (const w of warnings.slice(0, strict ? 1000 : 20)) console.log(`warn  ${w}`);
const fragment = filter ? filter.split('/').pop() : null;
const shown = fragment ? errors.filter((e) => e.includes(fragment)) : errors;
for (const e of shown.slice(0, 200)) console.log(`ERROR ${e}`);
if (shown.length) { console.log(`${shown.length} error(s)`); process.exit(1); }
console.log('Grammar content: PASS');
