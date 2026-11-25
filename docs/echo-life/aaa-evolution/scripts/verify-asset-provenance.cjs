#!/usr/bin/env node
// Echo Life AAA evolution — asset provenance gate (Team O / Wave 11 Team E1, 2026-11-22). Read-only: never writes, never fetches.
// Usage (any CWD):  node docs/echo-life/aaa-evolution/scripts/verify-asset-provenance.cjs [--strict]
//  1. Verifies every row of docs/echo-life/total-rebuild/ASSET_PROVENANCE.tsv (file exists, bytes, SHA-256,
//     12-hex filename prefix, license allow-list, commercial_use boolean).
//  2. Validates docs/echo-life/aaa-evolution/ASSET_PROVENANCE_LEDGER.tsv against SECURITY_AND_LICENSE_AUDIT.md §6
//     (26 required columns, unique asset_id & repo_path, bytes, SHA-256, 12-hex filename rule with legacy whale allowlist,
//     SPDX allow-list, strict booleans, attribution_text, source_sha256, ledger_status === 'approved').
//  3. Coverage: every shipped file under frontend/public/echo-life and frontend/public/models must be covered.
//     In --strict mode, 100% of shipped files MUST have a matching row directly in ASSET_PROVENANCE_LEDGER.tsv
//     (zero fallback to legacy manifests).
//  4. Cross-checks frontend/public/echo-life/aaa-v2/manifest.json and wave11-manifest.json (if present).
// Exit 1 on any failure; --strict also fails on non-SPDX strings, non-boolean flags, or any file missing from the unified ledger.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '../../../..');
const strict = process.argv.includes('--strict');
const rel = (p) => path.join(root, p);
const failures = [];
const warnings = [];

const SPDX_ALLOW = new Set(['CC0-1.0', 'CC-BY-4.0', 'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Zlib', 'OFL-1.1',
  'LicenseRef-EnglishCoach-Original']);
const LEGACY_ALLOW = /^(CC0-1\.0|LicenseRef-EnglishCoach-Original|Project-Owned|Project-authored for English Coach.*)$/;
const SOURCE_KIND_ALLOW = new Set(['original', 'cc0', 'cc-by', 'mocap-cmu', 'npm-bundled', 'derived']);
const LEDGER_REQUIRED = ['asset_id', 'repo_path', 'output_sha256', 'bytes', 'category', 'format', 'source_kind', 'source_origin',
  'source_asset_id', 'author', 'license_spdx', 'license_url', 'commercial_use', 'modification_allowed', 'redistribution_allowed',
  'attribution_required', 'attribution_text', 'upstream_parts', 'source_sha256', 'toolchain', 'changes_made', 'generator',
  'ai_involvement', 'reviewer', 'review_date', 'ledger_status'];

// Preexisting pre-Echo-Life mascot GLBs under frontend/public/models/ (8-hex / unhashed legacy filenames);
// existence, exact SHA-256, exact bytes, CC-BY-4.0 SPDX, and attribution remain strictly verified.
const LEGACY_NON_HASH12_ALLOWLIST = new Set([
  'frontend/public/models/whale-e0569b41.glb',
  'frontend/public/models/whale.glb',
]);

const MANIFEST_JSON_EXCLUDES = new Set([
  'frontend/public/echo-life/aaa-v2/manifest.json',
  'frontend/public/echo-life/aaa-v2/wave11-manifest.json',
]);

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function readTsv(file) {
  const lines = fs.readFileSync(rel(file), 'utf8').split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split('\t');
  return { header, rows: lines.map((l, i) => ({ line: i + 2, o: Object.fromEntries(header.map((h, j) => [h, l.split('\t')[j] ?? ''])) })) };
}

function checkFile(id, repoPath, sha, bytes) {
  const rp = normPath(repoPath);
  const p = rel(rp);
  if (!fs.existsSync(p)) { failures.push(`${id}: missing ${rp}`); return; }
  const buf = fs.readFileSync(p);
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  if (h !== sha) failures.push(`${id}: sha256 mismatch (${h.slice(0, 12)} != ${String(sha).slice(0, 12)})`);
  if (String(buf.length) !== String(bytes)) failures.push(`${id}: bytes ${buf.length} != ${bytes}`);
  const requireHash12 = rp.startsWith('frontend/public/echo-life/') || !LEGACY_NON_HASH12_ALLOWLIST.has(rp);
  if (requireHash12 && !path.basename(rp).includes(String(sha).slice(0, 12))) {
    failures.push(`${id}: filename lacks 12-hex sha prefix (${rp})`);
  }
}

// 1. Legacy ledger (total-rebuild/ASSET_PROVENANCE.tsv)
const legacy = readTsv('docs/echo-life/total-rebuild/ASSET_PROVENANCE.tsv');
for (const { o } of legacy.rows) {
  checkFile(o.asset_id, o.repo_path, o.output_sha256, o.bytes);
  if (strict) {
    if (o.commercial_use !== 'true') failures.push(`${o.asset_id}: commercial_use='${o.commercial_use}' (strict requires 'true')`);
  } else if (!/^(yes|true)$/i.test(o.commercial_use)) {
    failures.push(`${o.asset_id}: commercial_use='${o.commercial_use}'`);
  }
  if (!SPDX_ALLOW.has(o.license) && !LEGACY_ALLOW.test(o.license)) {
    failures.push(`${o.asset_id}: license '${o.license}' not allowed`);
  } else if (!SPDX_ALLOW.has(o.license)) {
    (strict ? failures : warnings).push(`${o.asset_id}: non-SPDX license '${o.license}'`);
  }
}

// 2. Unified ledger (docs/echo-life/aaa-evolution/ASSET_PROVENANCE_LEDGER.tsv)
const ledgerPath = 'docs/echo-life/aaa-evolution/ASSET_PROVENANCE_LEDGER.tsv';
const ledgerPaths = new Set();
const ledgerIds = new Set();
let ledgerRowCount = 0;

if (!fs.existsSync(rel(ledgerPath))) {
  if (strict) failures.push(`ledger: missing ${ledgerPath}`);
} else {
  const led = readTsv(ledgerPath);
  ledgerRowCount = led.rows.length;
  for (const c of LEDGER_REQUIRED) if (!led.header.includes(c)) failures.push(`ledger: missing column ${c}`);
  for (const { line, o } of led.rows) {
    const id = o.asset_id || `line ${line}`;
    const rp = normPath(o.repo_path);
    if (!/^[a-z0-9_.-]+$/.test(id)) failures.push(`${id}: asset_id must match [a-z0-9_.-]+`);
    if (ledgerIds.has(id)) failures.push(`${id}: duplicate asset_id in ledger`);
    ledgerIds.add(id);
    if (ledgerPaths.has(rp)) failures.push(`${id}: duplicate repo_path '${rp}' in ledger`);
    ledgerPaths.add(rp);

    checkFile(id, rp, o.output_sha256, o.bytes);
    if (!SPDX_ALLOW.has(o.license_spdx)) failures.push(`${id}: license_spdx '${o.license_spdx}' not on allow-list`);
    if (!SOURCE_KIND_ALLOW.has(o.source_kind)) failures.push(`${id}: source_kind '${o.source_kind}' not allowed`);
    for (const k of ['commercial_use', 'modification_allowed', 'redistribution_allowed']) {
      if (o[k] !== 'true') failures.push(`${id}: ${k} must be true`);
    }
    if (!['true', 'false'].includes(o.attribution_required)) failures.push(`${id}: attribution_required must be true or false`);
    if (o.attribution_required === 'true' && !o.attribution_text) failures.push(`${id}: attribution_text required`);
    if (!['approved', 'pending', 'blocked'].includes(o.ledger_status)) failures.push(`${id}: ledger_status '${o.ledger_status}'`);
    if (o.ledger_status !== 'approved') failures.push(`${id}: ledger_status=${o.ledger_status} (only approved rows may ship)`);
    if (!/^[0-9a-f]{64}$/.test(o.source_sha256) && o.source_kind !== 'original') {
      failures.push(`${id}: source_sha256 required for non-original sources`);
    }
    if (LEGACY_NON_HASH12_ALLOWLIST.has(rp)) {
      if (o.license_spdx !== 'CC-BY-4.0') failures.push(`${id}: legacy whale model must be CC-BY-4.0 (got '${o.license_spdx}')`);
      if (o.attribution_required !== 'true' || !o.attribution_text) failures.push(`${id}: legacy whale model requires attribution`);
    }
  }
}

// 3. Coverage over all shipped files under frontend/public/echo-life and frontend/public/models
const manifests = ['docs/echo-life/ASSET_SOURCE_MAP.md', 'docs/echo-life/final/ECHO_LIFE_ASSET_MANIFEST.json',
  'docs/echo-life/final/ECHO_LIFE_UNIFIED_ASSET_CATALOG.json', 'docs/echo-life/phase3/art/workshop-manifest.tsv',
  'docs/echo-life/world-2026-11-20/art/staged-manifest.tsv', 'docs/echo-life/total-rebuild/ASSET_PROVENANCE.tsv',
  'docs/echo-life/rea/THIRD_PARTY_ASSET_LICENSE_MANIFEST.json', 'docs/echo-life/total-rebuild/ANIMATION_PROVENANCE_FRAGMENT.tsv',
  'docs/echo-life/total-rebuild/VEGETATION_PROVENANCE_FRAGMENT.tsv', 'docs/ATTRIBUTION.md'];
const corpus = strict
  ? ''
  : manifests.filter((m) => fs.existsSync(rel(m))).map((m) => fs.readFileSync(rel(m), 'utf8')).join('\n');

const walk = (d) => fs.existsSync(rel(d)) ? fs.readdirSync(rel(d), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.posix.join(d, e.name)) : [path.posix.join(d, e.name)]) : [];

const shipped = [...walk('frontend/public/echo-life'), ...walk('frontend/public/models')].filter(
  (f) => !/README\.md$/i.test(f) && !MANIFEST_JSON_EXCLUDES.has(f),
);

const ledgerCovered = shipped.filter((f) => ledgerPaths.has(f));
const uncovered = strict
  ? shipped.filter((f) => !ledgerPaths.has(f))
  : shipped.filter((f) => !ledgerPaths.has(f) && !corpus.includes(path.basename(f)));

for (const f of uncovered) {
  failures.push(strict
    ? `coverage(strict): ${f} missing from ASSET_PROVENANCE_LEDGER.tsv`
    : `coverage: no provenance record names ${f}`);
}

// 4. Verify aaa-v2 manifests (manifest.json & optional wave11-manifest.json) against disk and unified ledger
function extractManifestPaths(raw) {
  const results = [];
  const pushEntry = (k, entry) => {
    if (!entry || typeof entry !== 'object') return;
    let rp = entry.repo_path || entry.repoPath || '';
    if (!rp && typeof entry.url === 'string') rp = entry.url.startsWith('/') ? `frontend/public${entry.url}` : `frontend/public/${entry.url}`;
    if (!rp && typeof (entry.file || entry.path) === 'string') {
      const fp = normPath(entry.file || entry.path);
      rp = fp.startsWith('frontend/public/') ? fp : `frontend/public/echo-life/aaa-v2/${fp}`;
    }
    if (rp) results.push([k, normPath(rp)]);
  };
  if (Array.isArray(raw)) raw.forEach((e, i) => pushEntry(e?.key || e?.id || e?.asset_id || `#${i}`, e));
  else if (Array.isArray(raw?.assets)) raw.assets.forEach((e, i) => pushEntry(e?.key || e?.id || e?.asset_id || `#${i}`, e));
  else if (raw?.assets && typeof raw.assets === 'object') Object.entries(raw.assets).forEach(([k, e]) => pushEntry(k, e));
  else if (Array.isArray(raw?.entries)) raw.entries.forEach((e, i) => pushEntry(e?.key || e?.id || e?.asset_id || `#${i}`, e));
  else if (Array.isArray(raw?.items)) raw.items.forEach((e, i) => pushEntry(e?.key || e?.id || e?.asset_id || `#${i}`, e));
  else if (raw && typeof raw === 'object') Object.entries(raw).forEach(([k, e]) => pushEntry(k, e));
  return results;
}

for (const mfPath of MANIFEST_JSON_EXCLUDES) {
  if (!fs.existsSync(rel(mfPath))) continue;
  const parsed = JSON.parse(fs.readFileSync(rel(mfPath), 'utf8'));
  for (const [k, rp] of extractManifestPaths(parsed)) {
    if (!rp || !fs.existsSync(rel(rp))) failures.push(`manifest(${path.basename(mfPath)}): ${k} missing ${rp}`);
    else if (!ledgerPaths.has(rp)) failures.push(`manifest(${path.basename(mfPath)}): ${k} (${rp}) missing from ASSET_PROVENANCE_LEDGER.tsv`);
  }
}

console.log(JSON.stringify({
  strict,
  legacyRows: legacy.rows.length,
  unifiedLedger: fs.existsSync(rel(ledgerPath)),
  ledgerRows: ledgerRowCount,
  shippedFiles: shipped.length,
  ledgerCovered: ledgerCovered.length,
  uncovered: uncovered.length,
  warnings: warnings.length,
  failures: failures.length,
}, null, 1));
for (const w of warnings.slice(0, 40)) console.log('WARN ' + w);
for (const f of failures.slice(0, 80)) console.log('FAIL ' + f);
process.exit(failures.length ? 1 : 0);
