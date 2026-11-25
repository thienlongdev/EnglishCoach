#!/usr/bin/env node
// Coverage report and work queue, from repository files only. `--next N` prints the next N batches of unfinished topics, in teaching priority.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.join(REPO, 'backend/src/main/resources/grammar');
const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'curriculum.json'), 'utf8'));
const LEVEL = { preA1: 0, A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
const rows = [];
const domainCounts = [];
const missing = [];
let done = 0, reviewed = 0, exercises = 0, bytes = 0, total = 0;
for (const d of c.domains) {
  let have = 0, rev = 0;
  for (const t of d.topics) {
    total++;
    const f = path.join(ROOT, 'topics', d.id, `${t.slug}.json`);
    if (!fs.existsSync(f)) { missing.push({ ...t, domain: d.id }); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    have++; done++; bytes += fs.statSync(f).size; exercises += j.exercises.length;
    if (j.editorial?.status === 'reviewed') { rev++; reviewed++; }
  }
  rows.push(`${d.id.padEnd(24)} ${String(have).padStart(3)}/${String(d.topics.length).padEnd(3)} reviewed ${rev}`);
  domainCounts.push({ domain: d.id, authored: have, planned: d.topics.length, editorialAccepted: rev });
}
const currentReview = new Set(), staleReview = new Set();
const reviewFile = path.join(REPO, 'docs/grammar/REVIEW-QUEUE.json');
if (fs.existsSync(reviewFile)) {
  const reviews = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
  for (const job of reviews.jobs || []) {
    if (job.state !== 'model-reviewed') continue;
    for (const [name, proof] of Object.entries(job.reviewedVersions || {})) {
      if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(name)) throw new Error('Invalid review topic path');
      const file = path.join(ROOT, 'topics', `${name}.json`);
      const hash = fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
      (hash === proof.sha256 ? currentReview : staleReview).add(name);
    }
  }
}
for (const name of currentReview) staleReview.delete(name); // an old proof is superseded when the current bytes have a newer review
const validation = process.argv.includes('--validate')
  ? spawnSync(process.execPath, [path.join(REPO, 'scripts/grammar/validate.mjs'), '--strict'], {encoding:'utf8'}) : null;
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({planned:total, authored:done, structurallyValid:validation?.status===0?done:null,
    structuralGate:validation?validation.status===0?'PASS':'FAIL':'NOT_RUN',editorialAccepted:reviewed,
    modelReviewedCurrent:currentReview.size,staleModelReviews:[...staleReview],
    sourceChecks:'bounded in individual review reports;not inferred from bibliography IDs',humanReviewed:0,
    exercises,bytes,domains:domainCounts,missing:missing.map(t=>`${t.domain}/${t.slug}`)},null,2));
  if (validation && validation.status !== 0) process.exitCode=1;
} else {
const next = process.argv.indexOf('--next');
if (next > 0) {
  const n = Number(process.argv[next + 1] || 3);
  const size = Number(process.argv[next + 2] || 4);
  // Lowest level first; keep a domain together inside a batch.
  missing.sort((a, b) => LEVEL[a.level] - LEVEL[b.level] || a.domain.localeCompare(b.domain));
  for (let i = 0; i < n; i++) {
    const batch = missing.splice(0, size);
    if (!batch.length) break;
    console.log(batch.map((t) => `${t.domain}/${t.slug} [${t.level}] pos=${c.domains.find((d) => d.id === t.domain).topics.findIndex((x) => x.slug === t.slug) + 1} prereq=${(t.prerequisites || []).join(',') || '-'}${t.includes ? ` includes=${t.includes.map((x) => x.en).join(' + ')}` : ''}`).join('\n'));
    console.log('---');
  }
} else {
  console.log(rows.join('\n'));
  console.log(`\nauthored ${done}/${total} · reviewed ${reviewed} · exercises ${exercises} · ${(bytes / 1048576).toFixed(1)} MB`);
  console.log(`model-reviewed at current file hash: ${currentReview.size} · stale review snapshots: ${staleReview.size} · editorial accepted: ${reviewed}`);
  if (validation) { console.log(`strict structural gate: ${validation.status===0?'PASS':'FAIL'}`); if(validation.status!==0)process.exitCode=1; }
}
}
