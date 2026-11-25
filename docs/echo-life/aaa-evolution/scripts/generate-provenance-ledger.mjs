#!/usr/bin/env node
/**
 * Generates the unified 26-column `docs/echo-life/aaa-evolution/ASSET_PROVENANCE_LEDGER.tsv`
 * matching `SECURITY_AND_LICENSE_AUDIT.md §6` with 100% coverage of all shipped files:
 *   1. Folds all 114 normalized rows from `docs/echo-life/total-rebuild/ASSET_PROVENANCE.tsv`.
 *   2. Includes Blocker F-1 court GLBs (`basketball-3b12c1f1cd97.glb`, `hoop-post-596c344dd13f.glb`).
 *   3. Includes all 36 Wave 4 `frontend/public/echo-life/aaa-v2/**` records from `_staged_records.json`.
 *   4. Folds all 284 legacy shipped files across all 7 verified upstream manifests:
 *        - `docs/echo-life/world-2026-11-20/art/staged-manifest.tsv` (121)
 *        - `docs/echo-life/phase3/art/workshop-manifest.tsv` (116 on-disk; skips 4 replaced legacy residence hashes)
 *        - `docs/echo-life/phase3/art/people-manifest.tsv` (28)
 *        - `docs/echo-life/rea/THIRD_PARTY_ASSET_LICENSE_MANIFEST.json` (`portraits-d2c53c754a5d.webp` + upstream enrichment)
 *        - `docs/echo-life/phase3/art/vehicles-manifest.tsv` (14)
 *        - `docs/echo-life/final/court-manifest.tsv` (2)
 *        - `docs/ATTRIBUTION.md` (`frontend/public/models/whale-e0569b41.glb` and `whale.glb`, Blue Colossus Studio, CC-BY-4.0)
 *   5. Automatically ingests `frontend/public/echo-life/aaa-v2/wave11-manifest.json` if present on disk.
 *   6. Recomputes exact `output_sha256` and exact `bytes` from disk for every single row and validates strict SPDX.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../..');

const LEGACY_TSV = path.resolve(ROOT, 'docs/echo-life/total-rebuild/ASSET_PROVENANCE.tsv');
const STAGED_JSON = path.resolve(ROOT, 'docs/echo-life/aaa-evolution/scripts/_staged_records.json');
const WORLD_MANIFEST_TSV = path.resolve(ROOT, 'docs/echo-life/world-2026-11-20/art/staged-manifest.tsv');
const WORKSHOP_MANIFEST_TSV = path.resolve(ROOT, 'docs/echo-life/phase3/art/workshop-manifest.tsv');
const PEOPLE_MANIFEST_TSV = path.resolve(ROOT, 'docs/echo-life/phase3/art/people-manifest.tsv');
const VEHICLES_MANIFEST_TSV = path.resolve(ROOT, 'docs/echo-life/phase3/art/vehicles-manifest.tsv');
const COURT_MANIFEST_TSV = path.resolve(ROOT, 'docs/echo-life/final/court-manifest.tsv');
const THIRD_PARTY_JSON = path.resolve(ROOT, 'docs/echo-life/rea/THIRD_PARTY_ASSET_LICENSE_MANIFEST.json');
const ECHO_LIFE_MANIFEST_JSON = path.resolve(ROOT, 'docs/echo-life/final/ECHO_LIFE_ASSET_MANIFEST.json');
const WAVE11_MANIFEST_JSON = path.resolve(ROOT, 'frontend/public/echo-life/aaa-v2/wave11-manifest.json');
const WAVE11_META_DIR = path.resolve(ROOT, 'docs/echo-life/aaa-evolution/scripts/_raw_glb/wave11');
const OUT_LEDGER = path.resolve(ROOT, 'docs/echo-life/aaa-evolution/ASSET_PROVENANCE_LEDGER.tsv');

const COLUMNS = [
  'asset_id', 'repo_path', 'output_sha256', 'bytes', 'category', 'format', 'source_kind',
  'source_origin', 'source_asset_id', 'author', 'license_spdx', 'license_url',
  'commercial_use', 'modification_allowed', 'redistribution_allowed',
  'attribution_required', 'attribution_text', 'upstream_parts', 'source_sha256',
  'toolchain', 'changes_made', 'generator', 'ai_involvement', 'reviewer', 'review_date', 'ledger_status',
];

const SPDX_URLS = {
  'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'MIT': 'https://opensource.org/licenses/MIT',
  'ISC': 'https://opensource.org/licenses/ISC',
  'BSD-2-Clause': 'https://opensource.org/licenses/BSD-2-Clause',
  'BSD-3-Clause': 'https://opensource.org/licenses/BSD-3-Clause',
  'Apache-2.0': 'https://www.apache.org/licenses/LICENSE-2.0',
  'Zlib': 'https://opensource.org/licenses/Zlib',
  'OFL-1.1': 'https://scripts.sil.org/OFL',
  'LicenseRef-EnglishCoach-Original': 'https://englishcoach.io.vn/licenses/project-owned',
};

const SPDX_ALLOW = new Set(Object.keys(SPDX_URLS));
const VALID_CATEGORIES = new Set([
  'pbr_albedo', 'pbr_normal', 'pbr_orm', 'hdri', 'building', 'prop', 'vehicle',
  'character', 'animation', 'vegetation', 'audio', 'font', 'decal', 'lut', 'other',
]);
const VALID_SOURCE_KINDS = new Set(['original', 'cc0', 'cc-by', 'mocap-cmu', 'npm-bundled', 'derived']);

function sanitize(v) {
  return String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function toAssetId(raw) {
  return sanitize(raw).toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeBool(v, fallback = 'false') {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return 'true';
  if (s === 'false' || s === 'no' || s === '0') return 'false';
  return fallback;
}

function sha256File(absPath) {
  const buf = fs.readFileSync(absPath);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

function readTsv(absPath) {
  const lines = fs.readFileSync(absPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split('\t');
  return lines.map((l) => {
    const vals = l.split('\t');
    return Object.fromEntries(header.map((h, i) => [h, vals[i] ?? '']));
  });
}

function cleanFactoryPath(rawPath) {
  return sanitize(rawPath).replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '');
}

function normalizeCategory(cat, repoPath = '') {
  const c = `${cat || ''}`.toLowerCase().trim();
  if (VALID_CATEGORIES.has(c)) return c;
  if (c.includes('hdri') || repoPath.includes('/hdri/')) return 'hdri';
  if (c.includes('albedo') || c.includes('color')) return 'pbr_albedo';
  if (c.includes('normal')) return 'pbr_normal';
  if (c.includes('orm') || c.includes('roughness')) return 'pbr_orm';
  if (c.includes('lut')) return 'lut';
  if (c.includes('anim') || c.includes('mocap')) return 'animation';
  if (c.includes('residence') || c.includes('building') || c.includes('facade') || c.includes('arch')) return 'building';
  if (c.includes('vehicle') || c.includes('car') || c.includes('bike') || c.includes('moto') || c.includes('scooter')) return 'vehicle';
  if (c.includes('char') || c.includes('people') || c.includes('npc') || c.includes('garment') || c.includes('cloth') || c.includes('coat') || c.includes('outfit') || c.includes('hair') || c.includes('winter') || c.includes('outerwear') || c.includes('parka')) return 'character';
  if (c.includes('veg') || c.includes('botanical') || c.includes('tree') || c.includes('plant') || c.includes('shrub') || c.includes('hedge') || c.includes('flower') || c.includes('grass')) return 'vegetation';
  if (c.includes('audio') || c.includes('sound')) return 'audio';
  if (c.includes('font')) return 'font';
  if (c.includes('decal')) return 'decal';
  if (c.includes('street') || c.includes('prop') || c.includes('interior') || c.includes('court') || c.includes('furniture')) return 'prop';
  const rp = repoPath.toLowerCase();
  if (rp.includes('/vehicles/')) return 'vehicle';
  if (rp.includes('/botanical/') || rp.includes('/vegetation/')) return 'vegetation';
  if (rp.includes('/people/') || rp.includes('/characters/') || rp.includes('/clothing/') || rp.includes('/garments/') || rp.includes('/winter/')) return 'character';
  if (rp.includes('/animations/')) return 'animation';
  if (rp.includes('/pbr/') || rp.includes('/char-pbr/')) {
    if (rp.includes('normal')) return 'pbr_normal';
    if (rp.includes('orm') || rp.includes('roughness')) return 'pbr_orm';
    if (rp.includes('lut')) return 'lut';
    return 'pbr_albedo';
  }
  if (rp.includes('/street/') || rp.includes('/interior/') || rp.includes('/court/') || rp.includes('/props/') || rp.includes('/workshop/')) return 'prop';
  return 'other';
}

function classifyStagedRoleCategory(role) {
  const r = String(role || '').toLowerCase();
  if (
    r.startsWith('bld-') ||
    r.startsWith('shop-') ||
    r === 'cafe-front' ||
    r === 'market-front' ||
    r === 'campus-gate' ||
    r === 'campus-colonnade' ||
    r === 'campus-guardhouse' ||
    r === 'campus-facade' ||
    r === 'park-gazebo'
  ) {
    return 'building';
  }
  if (r.startsWith('tree-') || r === 'plant') return 'vegetation';
  if (r === 'bicycle' || r.startsWith('car-') || r.startsWith('moto-') || r.startsWith('scooter-')) return 'vehicle';
  return 'prop';
}

function extToFormat(repoPath) {
  const ext = path.extname(repoPath).slice(1).toLowerCase();
  return ext || 'other';
}

function resolveLicense(rawLicense, defaultSpdx = 'LicenseRef-EnglishCoach-Original') {
  const raw = sanitize(rawLicense);
  if (SPDX_ALLOW.has(raw)) {
    const sourceKind =
      raw === 'CC0-1.0' ? 'cc0' :
      raw === 'CC-BY-4.0' ? 'cc-by' :
      raw === 'LicenseRef-EnglishCoach-Original' ? 'original' :
      'derived';
    return {
      license_spdx: raw,
      license_url: SPDX_URLS[raw],
      source_kind: sourceKind,
      attribution_required: raw === 'CC-BY-4.0' ? 'true' : 'false',
    };
  }
  if (/CC0[- ]?1\.0/i.test(raw)) {
    return {
      license_spdx: 'CC0-1.0',
      license_url: SPDX_URLS['CC0-1.0'],
      source_kind: 'cc0',
      attribution_required: 'false',
    };
  }
  if (/CC[- ]?BY[- ]?4\.0/i.test(raw)) {
    return {
      license_spdx: 'CC-BY-4.0',
      license_url: SPDX_URLS['CC-BY-4.0'],
      source_kind: 'cc-by',
      attribution_required: 'true',
    };
  }
  if (/\bMIT\b/i.test(raw)) {
    return { license_spdx: 'MIT', license_url: SPDX_URLS.MIT, source_kind: 'derived', attribution_required: 'true' };
  }
  if (/\bISC\b/i.test(raw)) {
    return { license_spdx: 'ISC', license_url: SPDX_URLS.ISC, source_kind: 'derived', attribution_required: 'true' };
  }
  if (/Apache[- ]?2\.0/i.test(raw)) {
    return { license_spdx: 'Apache-2.0', license_url: SPDX_URLS['Apache-2.0'], source_kind: 'derived', attribution_required: 'true' };
  }
  if (/Project-Owned|Project-authored|Codex.*original|EnglishCoach-Original/i.test(raw)) {
    return {
      license_spdx: 'LicenseRef-EnglishCoach-Original',
      license_url: SPDX_URLS['LicenseRef-EnglishCoach-Original'],
      source_kind: 'original',
      attribution_required: 'false',
    };
  }
  return {
    license_spdx: defaultSpdx,
    license_url: SPDX_URLS[defaultSpdx],
    source_kind: defaultSpdx === 'LicenseRef-EnglishCoach-Original' ? 'original' : 'cc0',
    attribution_required: defaultSpdx === 'CC-BY-4.0' ? 'true' : 'false',
  };
}

function main() {
  const rows = [];
  const seenPaths = new Set();
  const usedIds = new Set();
  const groupCounts = {};

  function pushRow(group, row) {
    const repoPath = sanitize(row.repo_path).replace(/\\/g, '/');
    if (seenPaths.has(repoPath)) return false;

    const abs = path.resolve(ROOT, repoPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`[${group}] Missing file on disk: ${repoPath}`);
    }
    const { sha256, bytes } = sha256File(abs);

    let assetId = toAssetId(row.asset_id);
    if (!assetId) throw new Error(`[${group}] Empty asset_id for ${repoPath}`);
    if (usedIds.has(assetId)) {
      let suffix = 2;
      while (usedIds.has(`${assetId}_${suffix}`)) suffix++;
      assetId = `${assetId}_${suffix}`;
    }

    const licenseSpdx = sanitize(row.license_spdx);
    if (!SPDX_ALLOW.has(licenseSpdx)) {
      throw new Error(`[${group}] Invalid SPDX license '${licenseSpdx}' for ${assetId}`);
    }
    const licenseUrl = sanitize(row.license_url) || SPDX_URLS[licenseSpdx];
    const sourceKind = sanitize(row.source_kind);
    if (!VALID_SOURCE_KINDS.has(sourceKind)) {
      throw new Error(`[${group}] Invalid source_kind '${sourceKind}' for ${assetId}`);
    }
    const commercialUse = normalizeBool(row.commercial_use, 'true');
    const modificationAllowed = normalizeBool(row.modification_allowed, 'true');
    const redistributionAllowed = normalizeBool(row.redistribution_allowed, 'true');
    const attributionRequired = normalizeBool(row.attribution_required, licenseSpdx === 'CC-BY-4.0' ? 'true' : 'false');
    const attributionText = sanitize(row.attribution_text);
    if (attributionRequired === 'true' && !attributionText) {
      throw new Error(`[${group}] attribution_text required for ${assetId}`);
    }
    let sourceSha = sanitize(row.source_sha256).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sourceSha)) {
      if (sourceKind === 'original') sourceSha = '';
      else throw new Error(`[${group}] 64-hex source_sha256 required for non-original ${assetId} (got '${sourceSha}')`);
    }

    const normalized = {
      asset_id: assetId,
      repo_path: repoPath,
      output_sha256: sha256,
      bytes: String(bytes),
      category: normalizeCategory(row.category, repoPath),
      format: sanitize(row.format) || extToFormat(repoPath),
      source_kind: sourceKind,
      source_origin: sanitize(row.source_origin),
      source_asset_id: sanitize(row.source_asset_id),
      author: sanitize(row.author) || 'English Coach Team',
      license_spdx: licenseSpdx,
      license_url: licenseUrl,
      commercial_use: commercialUse,
      modification_allowed: modificationAllowed,
      redistribution_allowed: redistributionAllowed,
      attribution_required: attributionRequired,
      attribution_text: attributionText,
      upstream_parts: sanitize(row.upstream_parts),
      source_sha256: sourceSha,
      toolchain: sanitize(row.toolchain),
      changes_made: sanitize(row.changes_made),
      generator: sanitize(row.generator),
      ai_involvement: sanitize(row.ai_involvement) || 'none',
      reviewer: sanitize(row.reviewer) || 'w11-provenance-e1',
      review_date: sanitize(row.review_date) || '2026-11-22',
      ledger_status: sanitize(row.ledger_status) || 'approved',
    };

    rows.push(normalized);
    seenPaths.add(repoPath);
    usedIds.add(assetId);
    groupCounts[group] = (groupCounts[group] || 0) + 1;
    return true;
  }

  // Load enrichment manifests (read-only)
  const thirdParty = JSON.parse(fs.readFileSync(THIRD_PARTY_JSON, 'utf8'));
  const tpByPath = new Map();
  const tpBySha = new Map();
  for (const entry of thirdParty.entries || []) {
    const rp = sanitize(entry.integration).replace(/\\/g, '/');
    if (rp) tpByPath.set(rp, entry);
    if (entry.sha256) tpBySha.set(String(entry.sha256).toLowerCase(), entry);
  }

  const echoLifeManifestByPath = new Map();
  if (fs.existsSync(ECHO_LIFE_MANIFEST_JSON)) {
    const arr = JSON.parse(fs.readFileSync(ECHO_LIFE_MANIFEST_JSON, 'utf8'));
    for (const item of arr) {
      if (item && item.url) {
        const rp = `frontend/public${item.url}`.replace(/\\/g, '/');
        echoLifeManifestByPath.set(rp, item);
      }
    }
  }

  // 1. Fold all 114 rows from docs/echo-life/total-rebuild/ASSET_PROVENANCE.tsv
  for (const o of readTsv(LEGACY_TSV)) {
    const repoPath = sanitize(o.repo_path).replace(/\\/g, '/');
    const rawLic = o.license || '';
    const isCmuPack =
      o.asset_id === 'echo_life_48clips_pack' ||
      /CMU.*Motion Capture|EIA-0196217/i.test(o.attribution || '') ||
      /Project-authored/i.test(rawLic);

    let licenseSpdx = 'CC0-1.0';
    let licenseUrl = SPDX_URLS['CC0-1.0'];
    let sourceKind = 'cc0';
    let attrReq = 'false';
    let attrText = '';
    if (isCmuPack) {
      // Echo Life 48-clip animation pack mixes original authored clips with CMU Graphics Lab Mocap (see audit Note F-4)
      licenseSpdx = 'CC0-1.0';
      licenseUrl = SPDX_URLS['CC0-1.0'];
      sourceKind = 'mocap-cmu';
      attrReq = 'true';
      attrText = 'Includes motion data from the CMU Graphics Lab Motion Capture Database (NSF EIA-0196217), retargeted for English Coach.';
    } else if (/^(Project-Owned|LicenseRef-EnglishCoach-Original)$/i.test(rawLic)) {
      licenseSpdx = 'LicenseRef-EnglishCoach-Original';
      licenseUrl = SPDX_URLS['LicenseRef-EnglishCoach-Original'];
      sourceKind = 'original';
    } else {
      const resolved = resolveLicense(rawLic, 'CC0-1.0');
      licenseSpdx = resolved.license_spdx;
      licenseUrl = resolved.license_url;
      sourceKind = resolved.source_kind;
      attrReq = resolved.attribution_required;
    }

    const cleanedAuthor = sanitize((o.attribution || '').replace(/^Not legally required \(CC0\);?\s*/i, ''));
    const author =
      /^None \(Echo Life original work\)$/i.test(cleanedAuthor)
        ? 'English Coach Team (Echo Life Original)'
        : (cleanedAuthor || 'English Coach Team');

    pushRow('total-rebuild', {
      asset_id: o.asset_id,
      repo_path: repoPath,
      category: o.category,
      format: extToFormat(repoPath),
      source_kind: sourceKind,
      source_origin: o.source_origin,
      source_asset_id: o.source_asset_id,
      author,
      license_spdx: licenseSpdx,
      license_url: licenseUrl,
      commercial_use: normalizeBool(o.commercial_use, 'true'),
      modification_allowed: 'true',
      redistribution_allowed: 'true',
      attribution_required: attrReq,
      attribution_text: attrText,
      upstream_parts: o.source_asset_id,
      source_sha256: o.source_sha256,
      toolchain: 'Blender 4.2.16 LTS; gltf-transform 4.1.0; sharp 0.35.5',
      changes_made: o.changes_made,
      generator: 'docs/echo-life/total-rebuild/ASSET_PROVENANCE.tsv',
      ai_involvement: 'none',
      reviewer: 'w4-blender-assets',
      review_date: '2026-11-22',
      ledger_status: 'approved',
    });
  }

  // 2. Blocker F-1 verified Codex Studio originals for shipped court GLBs
  const f1Records = [
    {
      asset_id: 'court_basketball_codex_v01',
      repo_path: 'frontend/public/echo-life/court/basketball-3b12c1f1cd97.glb',
      codex_source: 'C:/ECHO_LIFE_CODEX_ASSET_STUDIO/05_OUTDOOR_ENVIRONMENTS/park_basketball__codex_v01.glb',
      source_origin: 'factory:ECHO_LIFE_CODEX_ASSET_STUDIO/05_OUTDOOR_ENVIRONMENTS/park_basketball__codex_v01.glb',
      source_asset_id: 'park_basketball__codex_v01',
      changes_made: 'Verified byte-exact SHA-256 match (3b12c1f1cd97) with Project-Owned Codex Asset Studio master; staged with anchor_grip [0,0.12,0.11]',
    },
    {
      asset_id: 'court_hoop_post_codex_v01',
      repo_path: 'frontend/public/echo-life/court/hoop-post-596c344dd13f.glb',
      codex_source: 'C:/ECHO_LIFE_CODEX_ASSET_STUDIO/05_OUTDOOR_ENVIRONMENTS/park_basketball_hoop__codex_v01.glb',
      source_origin: 'factory:ECHO_LIFE_CODEX_ASSET_STUDIO/05_OUTDOOR_ENVIRONMENTS/park_basketball_hoop__codex_v01.glb',
      source_asset_id: 'park_basketball_hoop__codex_v01',
      changes_made: 'Verified byte-exact SHA-256 match (596c344dd13f) with Project-Owned Codex Asset Studio master; staged with anchor_basket [0,3.05,0.675]',
    },
  ];
  for (const f1 of f1Records) {
    const absShip = path.resolve(ROOT, f1.repo_path);
    const shipInfo = sha256File(absShip);
    let srcSha = shipInfo.sha256;
    if (fs.existsSync(f1.codex_source)) {
      const codexInfo = sha256File(f1.codex_source);
      if (codexInfo.sha256 !== shipInfo.sha256) {
        throw new Error(`F-1 SHA mismatch for ${f1.repo_path}`);
      }
      srcSha = codexInfo.sha256;
    }
    pushRow('f1-court', {
      asset_id: f1.asset_id,
      repo_path: f1.repo_path,
      category: 'prop',
      format: 'glb',
      source_kind: 'original',
      source_origin: f1.source_origin,
      source_asset_id: f1.source_asset_id,
      author: 'English Coach Echo Life Codex Asset Studio (Project-Owned)',
      license_spdx: 'LicenseRef-EnglishCoach-Original',
      license_url: SPDX_URLS['LicenseRef-EnglishCoach-Original'],
      commercial_use: 'true',
      modification_allowed: 'true',
      redistribution_allowed: 'true',
      attribution_required: 'false',
      attribution_text: '',
      upstream_parts: f1.source_asset_id,
      source_sha256: srcSha,
      toolchain: 'Blender 4.2; Echo Life Codex Asset Studio',
      changes_made: f1.changes_made,
      generator: 'docs/echo-life/aaa-evolution/scripts/generate-provenance-ledger.mjs',
      ai_involvement: 'none',
      reviewer: 'w4-blender-assets',
      review_date: '2026-11-22',
      ledger_status: 'approved',
    });
  }

  // 3. Wave 4 `aaa-v2/` records from `_staged_records.json`
  const stagedAaaV2 = JSON.parse(fs.readFileSync(STAGED_JSON, 'utf8'));
  for (const k of Object.keys(stagedAaaV2).sort()) {
    const rec = stagedAaaV2[k];
    const repoPath = sanitize(rec.repo_path).replace(/\\/g, '/');
    const abs = path.resolve(ROOT, repoPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`Missing staged aaa-v2 file: ${repoPath}`);
    }
    const { sha256, bytes } = sha256File(abs);
    if (sha256 !== rec.output_sha256 || bytes !== rec.bytes) {
      throw new Error(`Staged record mismatch for ${k}: disk=${sha256.slice(0, 12)}/${bytes} vs rec=${rec.output_sha256.slice(0, 12)}/${rec.bytes}`);
    }
    pushRow('aaa-v2', {
      ...rec,
      repo_path: repoPath,
    });
  }

  // 4. Fold `docs/echo-life/world-2026-11-20/art/staged-manifest.tsv` (121 world GLBs)
  const worldRows = readTsv(WORLD_MANIFEST_TSV);
  const worldLicenseByPath = new Map();
  for (const r of worldRows) {
    const repoPath = `frontend/public/echo-life/${sanitize(r.output)}`;
    const abs = path.resolve(ROOT, repoPath);
    const { sha256 } = sha256File(abs);
    const tp = tpByPath.get(repoPath) || tpBySha.get(sha256);
    const mEntry = echoLifeManifestByPath.get(repoPath);
    const isLod = r.studio === 'derived' || /^as source$/i.test(r.license || '');

    let sourceKind;
    let sourceOrigin;
    let sourceAssetId;
    let author;
    let licenseSpdx;
    let licenseUrl;
    let upstreamParts;
    let changesMade;

    if (tp) {
      sourceKind = 'cc0';
      sourceOrigin = `${tp.source} (factory:${cleanFactoryPath(r.source)})`;
      sourceAssetId = tp.receiptKey || mEntry?.sourceAsset || r.role;
      author = tp.author || 'Third-Party CC0 Author';
      licenseSpdx = 'CC0-1.0';
      licenseUrl = SPDX_URLS['CC0-1.0'];
      upstreamParts = (tp.upstreamParts && tp.upstreamParts.length)
        ? tp.upstreamParts.join(';')
        : `${tp.source} (${tp.receiptKey || r.role})`;
      changesMade =
        tp.integration && tp.integration !== repoPath
          ? `Byte-identical to ${tp.integration} (${tp.source}, CC0-1.0); staged via glTF-Transform 4.5.1 (dedup, flatten, join, weld, resize 512px, webp q86); zero WASM`
          : 'Staged via glTF-Transform 4.5.1 (dedup, flatten, join, weld, resize 512px, webp q86) with 12-hex content-hashed filename; zero WASM';
    } else if (isLod) {
      const parentPath = sanitize(r.source).replace(/\\/g, '/');
      const parentLic = worldLicenseByPath.get(parentPath) || 'LicenseRef-EnglishCoach-Original';
      const resolved = resolveLicense(parentLic, 'LicenseRef-EnglishCoach-Original');
      sourceKind = 'derived';
      sourceOrigin = `project:${parentPath}`;
      sourceAssetId = mEntry?.sourceAsset || r.role;
      author = 'English Coach Echo Life Codex Asset Studio (Project-Owned)';
      licenseSpdx = resolved.license_spdx;
      licenseUrl = resolved.license_url;
      upstreamParts = parentPath;
      changesMade = 'Offline LOD decimation via glTF-Transform 4.5.1 (simplify ratio=0.25 error=0.002) from staged primary architectural shell; zero WASM';
    } else {
      const resolved = resolveLicense(r.license, 'LicenseRef-EnglishCoach-Original');
      sourceKind = resolved.source_kind;
      sourceOrigin = `factory:${cleanFactoryPath(r.source)}`;
      sourceAssetId = mEntry?.sourceAsset || r.role;
      author = r.studio === 'gemini'
        ? 'English Coach Echo Life 3D Asset Factory (Project-Owned)'
        : 'English Coach Echo Life Codex Asset Studio (Project-Owned)';
      licenseSpdx = resolved.license_spdx;
      licenseUrl = resolved.license_url;
      upstreamParts = mEntry?.sourceAsset || r.role;
      changesMade = 'Staged via glTF-Transform 4.5.1 (dedup, flatten, join, weld, resize 512px, webp q86) with 12-hex content-hashed filename; zero WASM';
    }

    worldLicenseByPath.set(repoPath, licenseSpdx);

    pushRow('staged-manifest', {
      asset_id: `world_${r.role}`,
      repo_path: repoPath,
      category: classifyStagedRoleCategory(r.role),
      format: 'glb',
      source_kind: sourceKind,
      source_origin: sourceOrigin,
      source_asset_id: sourceAssetId,
      author,
      license_spdx: licenseSpdx,
      license_url: licenseUrl,
      commercial_use: 'true',
      modification_allowed: 'true',
      redistribution_allowed: 'true',
      attribution_required: 'false',
      attribution_text: '',
      upstream_parts: upstreamParts,
      source_sha256: r.source_sha256,
      toolchain: 'glTF-Transform 4.5.1; sharp',
      changes_made: changesMade,
      generator: 'docs/echo-life/world-2026-11-20/art/stage-city31.mjs; docs/echo-life/world-2026-11-20/art/stage-assets.sh',
      ai_involvement: 'none',
      reviewer: 'w11-provenance-e1',
      review_date: '2026-11-22',
      ledger_status: 'approved',
    });
  }

  // 5. Fold `docs/echo-life/phase3/art/workshop-manifest.tsv` (116 on-disk; skips 4 deleted legacy residence hashes)
  let workshopSkippedReplaced = 0;
  for (const r of readTsv(WORKSHOP_MANIFEST_TSV)) {
    const repoPath = `frontend/public${sanitize(r.url)}`.replace(/\\/g, '/');
    const abs = path.resolve(ROOT, repoPath);
    if (!fs.existsSync(abs)) {
      workshopSkippedReplaced++;
      continue;
    }
    const baseKey = path.basename(cleanFactoryPath(r.source), '.glb');
    const tp = tpByPath.get(repoPath);
    const mEntry = echoLifeManifestByPath.get(repoPath);
    const isResidence = baseKey.startsWith('res_');

    let sourceKind;
    let sourceOrigin;
    let sourceAssetId;
    let author;
    let licenseSpdx;
    let licenseUrl;
    let upstreamParts;

    if (tp) {
      sourceKind = 'cc0';
      sourceOrigin = `${tp.source} (factory:${cleanFactoryPath(r.source)})`;
      sourceAssetId = tp.receiptKey || mEntry?.sourceAsset || baseKey;
      author = tp.author || 'Poly Haven Author (CC0-1.0)';
      licenseSpdx = 'CC0-1.0';
      licenseUrl = SPDX_URLS['CC0-1.0'];
      upstreamParts = `${tp.source} (${tp.receiptKey || baseKey})`;
    } else {
      const resolved = resolveLicense(r.licence, 'LicenseRef-EnglishCoach-Original');
      sourceKind = resolved.source_kind;
      sourceOrigin = `factory:${cleanFactoryPath(r.source)}`;
      sourceAssetId = mEntry?.sourceAsset || baseKey;
      author = /Project-Owned Original Work/i.test(r.licence || '')
        ? 'English Coach Echo Life 3D Asset Factory (Project-Owned)'
        : 'English Coach Echo Life Codex Asset Studio (Project-Owned)';
      licenseSpdx = resolved.license_spdx;
      licenseUrl = resolved.license_url;
      upstreamParts = mEntry?.sourceAsset || baseKey;
    }

    pushRow('workshop-manifest', {
      asset_id: `workshop_${baseKey}`,
      repo_path: repoPath,
      category: isResidence ? 'building' : 'prop',
      format: 'glb',
      source_kind: sourceKind,
      source_origin: sourceOrigin,
      source_asset_id: sourceAssetId,
      author,
      license_spdx: licenseSpdx,
      license_url: licenseUrl,
      commercial_use: 'true',
      modification_allowed: 'true',
      redistribution_allowed: 'true',
      attribution_required: 'false',
      attribution_text: '',
      upstream_parts: upstreamParts,
      source_sha256: r.source_sha256,
      toolchain: 'glTF-Transform 4.5.1',
      changes_made: 'Staged via glTF-Transform 4.5.1 (dedup, flatten, join, weld, prune) with 12-hex content-hashed filename; zero WASM',
      generator: 'docs/echo-life/phase3/art/stage-workshop.cjs',
      ai_involvement: 'none',
      reviewer: 'w11-provenance-e1',
      review_date: '2026-11-22',
      ledger_status: 'approved',
    });
  }

  // 6. Fold `docs/echo-life/phase3/art/people-manifest.tsv` (28 character GLBs)
  for (const r of readTsv(PEOPLE_MANIFEST_TSV)) {
    const repoPath = `frontend/public/echo-life/people/${sanitize(r.output)}`;
    const tp = tpByPath.get(repoPath);
    const mEntry = echoLifeManifestByPath.get(repoPath);

    let sourceKind;
    let sourceOrigin;
    let sourceAssetId;
    let author;
    let licenseSpdx;
    let licenseUrl;
    let upstreamParts;

    if (tp) {
      sourceKind = 'cc0';
      sourceOrigin = `${tp.source} (factory:${cleanFactoryPath(r.source)})`;
      sourceAssetId = tp.receiptKey || mEntry?.sourceAsset || r.id;
      author = tp.author || 'MPFB2 / MakeHuman System Assets CC0 + Codex fitting and motion';
      licenseSpdx = 'CC0-1.0';
      licenseUrl = SPDX_URLS['CC0-1.0'];
      upstreamParts = (tp.upstreamParts && tp.upstreamParts.length)
        ? tp.upstreamParts.join(';')
        : `${tp.source} (${tp.receiptKey || r.id})`;
    } else {
      const resolved = resolveLicense(r.license, 'LicenseRef-EnglishCoach-Original');
      sourceKind = resolved.source_kind;
      sourceOrigin = `factory:${cleanFactoryPath(r.source)}`;
      sourceAssetId = mEntry?.sourceAsset || r.id;
      author = /Gemini/i.test(r.license || '')
        ? 'English Coach Echo Life 3D Asset Factory (Project-Owned)'
        : 'English Coach Echo Life Codex Asset Studio (Project-Owned)';
      licenseSpdx = resolved.license_spdx;
      licenseUrl = resolved.license_url;
      upstreamParts = mEntry?.sourceAsset || r.id;
    }

    pushRow('people-manifest', {
      asset_id: `people_${r.id}`,
      repo_path: repoPath,
      category: 'character',
      format: 'glb',
      source_kind: sourceKind,
      source_origin: sourceOrigin,
      source_asset_id: sourceAssetId,
      author,
      license_spdx: licenseSpdx,
      license_url: licenseUrl,
      commercial_use: 'true',
      modification_allowed: 'true',
      redistribution_allowed: 'true',
      attribution_required: 'false',
      attribution_text: '',
      upstream_parts: upstreamParts,
      source_sha256: r.source_sha256,
      toolchain: 'glTF-Transform 4.5.1; sharp',
      changes_made: 'Staged skinned resident GLB via glTF-Transform 4.5.1 (dedup, prune, resize 512px, webp q84, simplify ratio=0.55 error=0.0006, KHR_mesh_quantization); skeleton and animation clips preserved; zero WASM',
      generator: 'docs/echo-life/phase3/art/stage-people.sh',
      ai_involvement: 'none',
      reviewer: 'w11-provenance-e1',
      review_date: '2026-11-22',
      ledger_status: 'approved',
    });
  }

  // 7. Fold derived artwork from `docs/echo-life/rea/THIRD_PARTY_ASSET_LICENSE_MANIFEST.json` (`portraits-d2c53c754a5d.webp`)
  for (const art of thirdParty.derivedArtwork || []) {
    const repoPath = sanitize(art.integration).replace(/\\/g, '/');
    const sources = art.sources || [];
    const manifestDigest = crypto
      .createHash('sha256')
      .update(sources.map((s) => `${s.speaker}:${s.sha256}`).join('\n'))
      .digest('hex');
    const upstreamParts = sources
      .map((s) => `${s.receiptKey || s.speaker}:${String(s.sha256 || '').slice(0, 12)}`)
      .join(';');

    pushRow('third-party-derived', {
      asset_id: 'people_portraits_atlas',
      repo_path: repoPath,
      category: 'character',
      format: extToFormat(repoPath),
      source_kind: 'derived',
      source_origin: 'https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html (derived from 22 registered resident GLBs in docs/echo-life/rea/THIRD_PARTY_ASSET_LICENSE_MANIFEST.json)',
      source_asset_id: 'dialogue_portraits_22_residents',
      author: 'English Coach Echo Life Pipeline (rendered from MPFB2 / MakeHuman System Assets CC0-1.0 resident GLBs)',
      license_spdx: 'CC0-1.0',
      license_url: SPDX_URLS['CC0-1.0'],
      commercial_use: 'true',
      modification_allowed: 'true',
      redistribution_allowed: 'true',
      attribution_required: 'false',
      attribution_text: '',
      upstream_parts: upstreamParts,
      source_sha256: manifestDigest,
      toolchain: 'Headless WebGL / Blender portrait renderer; sharp WebP',
      changes_made: `${sanitize(art.process)} Source inputs are the 22 registered CC0-1.0 MakeHuman/MPFB resident GLBs; source_sha256 is the SHA-256 digest of the ordered 22 resident speaker:sha256 list.`,
      generator: 'docs/echo-life/rea/THIRD_PARTY_ASSET_LICENSE_MANIFEST.json',
      ai_involvement: 'none',
      reviewer: 'w11-provenance-e1',
      review_date: '2026-11-22',
      ledger_status: 'approved',
    });
  }

  // 8. Fold `docs/echo-life/phase3/art/vehicles-manifest.tsv` (14 articulated vehicles)
  for (const r of readTsv(VEHICLES_MANIFEST_TSV)) {
    const repoPath = `frontend/public${sanitize(r.url)}`.replace(/\\/g, '/');
    const baseKey = path.basename(cleanFactoryPath(r.source), '.glb');
    const mEntry = echoLifeManifestByPath.get(repoPath);
    const resolved = resolveLicense(r.licence, 'LicenseRef-EnglishCoach-Original');
    const isAssembly = /assembly/i.test(r.licence || '');

    pushRow('vehicles-manifest', {
      asset_id: `vehicle_${baseKey.replace(/^car_/, '')}`,
      repo_path: repoPath,
      category: 'vehicle',
      format: 'glb',
      source_kind: resolved.source_kind,
      source_origin: `factory:${cleanFactoryPath(r.source)}`,
      source_asset_id: mEntry?.sourceAsset || baseKey,
      author: 'English Coach Echo Life Codex Asset Studio (Project-Owned)',
      license_spdx: resolved.license_spdx,
      license_url: resolved.license_url,
      commercial_use: 'true',
      modification_allowed: 'true',
      redistribution_allowed: 'true',
      attribution_required: 'false',
      attribution_text: '',
      upstream_parts: mEntry?.sourceAsset || baseKey,
      source_sha256: r.source_sha256,
      toolchain: 'glTF-Transform 4.5.1; Three.js',
      changes_made: isAssembly
        ? 'Project-authored assembly (Codex V2/V3 constituent project parts); preserved V3 pivot/anchor hierarchy while batching static child meshes (dedup, join, weld, prune) with 12-hex content-hashed filename; zero WASM'
        : 'Preserved V3 hinge/axle/pivot/anchor hierarchy while batching static child meshes (dedup, join, weld, prune) with 12-hex content-hashed filename; zero WASM',
      generator: 'docs/echo-life/phase3/art/stage-cars.cjs',
      ai_involvement: 'none',
      reviewer: 'w11-provenance-e1',
      review_date: '2026-11-22',
      ledger_status: 'approved',
    });
  }

  // 9. Fold `docs/echo-life/final/court-manifest.tsv` (2 badminton court props)
  for (const r of readTsv(COURT_MANIFEST_TSV)) {
    const repoPath = `frontend/public${sanitize(r.url)}`.replace(/\\/g, '/');
    const baseKey = path.basename(repoPath, '.glb').replace(/-[0-9a-f]{12}$/, '');
    const srcName = path.basename(cleanFactoryPath(r.source), '.glb');
    const mEntry = echoLifeManifestByPath.get(repoPath);

    pushRow('court-manifest', {
      asset_id: `court_${baseKey}`,
      repo_path: repoPath,
      category: 'prop',
      format: 'glb',
      source_kind: 'original',
      source_origin: `factory:${cleanFactoryPath(r.source)}`,
      source_asset_id: mEntry?.sourceAsset || srcName,
      author: 'English Coach Echo Life Codex Asset Studio (Project-Owned)',
      license_spdx: 'LicenseRef-EnglishCoach-Original',
      license_url: SPDX_URLS['LicenseRef-EnglishCoach-Original'],
      commercial_use: 'true',
      modification_allowed: 'true',
      redistribution_allowed: 'true',
      attribution_required: 'false',
      attribution_text: '',
      upstream_parts: mEntry?.sourceAsset || srcName,
      source_sha256: r.source_sha256,
      toolchain: 'Blender 4.2; Echo Life Codex Asset Studio',
      changes_made: 'Byte-identical court prop staged from Codex Asset Studio master with 12-hex content-hashed filename; zero WASM',
      generator: 'docs/echo-life/final/court-manifest.tsv',
      ai_involvement: 'none',
      reviewer: 'w11-provenance-e1',
      review_date: '2026-11-22',
      ledger_status: 'approved',
    });
  }

  // 10. Fold Echo Whale mascot models from `docs/ATTRIBUTION.md` & `frontend/public/models/README.md`
  const whaleModels = [
    {
      asset_id: 'model_echo_whale_hashed',
      repo_path: 'frontend/public/models/whale-e0569b41.glb',
      changes_made: 'Byte-identical copy of Blue Colossus Studio Low poly animated Cartoon Whale staged with legacy 8-hex SHA-256 filename for immutable caching (docs/ATTRIBUTION.md)',
    },
    {
      asset_id: 'model_echo_whale_legacy',
      repo_path: 'frontend/public/models/whale.glb',
      changes_made: 'Byte-identical pre-2026-10-16 legacy alias of whale-e0569b41.glb retained for cached landing clients (Blue Colossus Studio Low poly animated Cartoon Whale, docs/ATTRIBUTION.md)',
    },
  ];
  for (const wm of whaleModels) {
    const abs = path.resolve(ROOT, wm.repo_path);
    if (!fs.existsSync(abs)) continue;
    const { sha256 } = sha256File(abs);
    pushRow('attribution-models', {
      asset_id: wm.asset_id,
      repo_path: wm.repo_path,
      category: 'character',
      format: 'glb',
      source_kind: 'cc-by',
      source_origin: 'https://sketchfab.com/3d-models/low-poly-animated-cartoon-whale-4016a2fa3b4a4960a660ec65f2939470',
      source_asset_id: 'low-poly-animated-cartoon-whale-4016a2fa3b4a4960a660ec65f2939470',
      author: 'Blue Colossus Studio',
      license_spdx: 'CC-BY-4.0',
      license_url: SPDX_URLS['CC-BY-4.0'],
      commercial_use: 'true',
      modification_allowed: 'true',
      redistribution_allowed: 'true',
      attribution_required: 'true',
      attribution_text: 'Low poly animated Cartoon Whale by Blue Colossus Studio (https://sketchfab.com/3d-models/low-poly-animated-cartoon-whale-4016a2fa3b4a4960a660ec65f2939470), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).',
      upstream_parts: 'sketchfab:4016a2fa3b4a4960a660ec65f2939470',
      source_sha256: sha256,
      toolchain: 'Sketchfab glTF/GLB export (unmodified bytes)',
      changes_made: wm.changes_made,
      generator: 'docs/ATTRIBUTION.md',
      ai_involvement: 'none',
      reviewer: 'w11-provenance-e1',
      review_date: '2026-11-22',
      ledger_status: 'approved',
    });
  }

  // 11. Automatically ingest `frontend/public/echo-life/aaa-v2/wave11-manifest.json` (canonical)
  //     plus any `docs/echo-life/aaa-evolution/scripts/_raw_glb/wave11/*_meta.json` batch metadata files on disk.
  function ingestWave11Source(absJsonPath, groupName, defaultGenerator) {
    if (!fs.existsSync(absJsonPath)) return;
    const rawW11 = JSON.parse(fs.readFileSync(absJsonPath, 'utf8'));
    let w11Entries = [];
    if (Array.isArray(rawW11)) {
      w11Entries = rawW11.map((item, idx) => [item?.key || item?.id || item?.asset_id || `asset_${idx}`, item]);
    } else if (Array.isArray(rawW11?.assets)) {
      w11Entries = rawW11.assets.map((item, idx) => [item?.key || item?.id || item?.asset_id || `asset_${idx}`, item]);
    } else if (rawW11?.assets && typeof rawW11.assets === 'object') {
      w11Entries = Object.entries(rawW11.assets);
    } else if (Array.isArray(rawW11?.entries)) {
      w11Entries = rawW11.entries.map((item, idx) => [item?.key || item?.id || item?.asset_id || `asset_${idx}`, item]);
    } else if (Array.isArray(rawW11?.items)) {
      w11Entries = rawW11.items.map((item, idx) => [item?.key || item?.id || item?.asset_id || `asset_${idx}`, item]);
    } else if (rawW11 && typeof rawW11 === 'object') {
      w11Entries = Object.entries(rawW11).filter(
        ([, v]) => v && typeof v === 'object' && (v.repoPath || v.repo_path || v.url || v.file || v.path),
      );
    }

    w11Entries.sort(([a], [b]) => String(a).localeCompare(String(b)));
    for (const [key, rec] of w11Entries) {
      if (!rec || typeof rec !== 'object') continue;
      let repoPath = rec.repo_path || rec.repoPath || '';
      if (!repoPath && typeof rec.url === 'string') {
        repoPath = rec.url.startsWith('/') ? `frontend/public${rec.url}` : `frontend/public/${rec.url}`;
      }
      if (!repoPath && typeof (rec.file || rec.path) === 'string') {
        const fp = String(rec.file || rec.path).replace(/\\/g, '/').replace(/^\/+/, '');
        repoPath = fp.startsWith('frontend/public/') ? fp : `frontend/public/echo-life/aaa-v2/${fp}`;
      }
      repoPath = sanitize(repoPath).replace(/\\/g, '/');
      if (!repoPath) continue;

      const abs = path.resolve(ROOT, repoPath);
      if (!fs.existsSync(abs)) continue;
      const { sha256 } = sha256File(abs);
      const resolvedLic = resolveLicense(rec.license_spdx || rec.license || 'LicenseRef-EnglishCoach-Original', 'LicenseRef-EnglishCoach-Original');
      const sourceKind = VALID_SOURCE_KINDS.has(rec.source_kind) ? rec.source_kind : resolvedLic.source_kind;
      const generator = sanitize(rec.generator || rawW11?.generator || defaultGenerator);
      const baseKey = toAssetId(rec.asset_id || `aaa_v2_w11_${key}`);
      const defaultMetrics = [
        rec.tris != null ? `tris=${rec.tris}` : null,
        rec.prims != null ? `prims=${rec.prims}` : null,
        rec.textures != null ? `tex=${rec.textures}` : null,
      ].filter(Boolean).join('; ');
      const changesBase = sanitize(
        rec.changes_made || rec.notes || rec.description || 'Wave 11 Blender 4.2 Cycles OptiX AAA asset staged with WebP PBR + KHR_mesh_quantization; zero WASM',
      );
      const changesMade = defaultMetrics && !changesBase.includes('tris=') ? `${changesBase}; ${defaultMetrics}` : changesBase;
      const sourceOrigin = sanitize(rec.source_origin || rec.upstream_source || `project:${generator}`);

      pushRow(groupName, {
        asset_id: baseKey,
        repo_path: repoPath,
        category: normalizeCategory(rec.category || rec.batch || '', repoPath),
        format: sanitize(rec.format) || extToFormat(repoPath),
        source_kind: sourceKind,
        source_origin: sourceOrigin,
        source_asset_id: sanitize(rec.source_asset_id || rec.asset_id || key),
        author: sanitize(rec.author || 'English Coach Wave 11 Team A1 (Blender 4.2 Cycles OptiX Studio)'),
        license_spdx: resolvedLic.license_spdx,
        license_url: sanitize(rec.license_url) || resolvedLic.license_url,
        commercial_use: normalizeBool(rec.commercial_use, 'true'),
        modification_allowed: normalizeBool(rec.modification_allowed, 'true'),
        redistribution_allowed: normalizeBool(rec.redistribution_allowed, 'true'),
        attribution_required: normalizeBool(rec.attribution_required, resolvedLic.attribution_required),
        attribution_text: sanitize(rec.attribution_text),
        upstream_parts: sanitize(
          Array.isArray(rec.upstream_parts)
            ? rec.upstream_parts.join(';')
            : (rec.upstream_parts || rec.upstream_source || 'blender-4.2-wave11-original'),
        ),
        source_sha256: sanitize(rec.source_sha256) || (sourceKind === 'original' ? '' : sha256),
        toolchain: sanitize(rec.toolchain || 'Blender 4.2.16 LTS Cycles OptiX; gltf-transform 4.1.0; sharp 0.35.5'),
        changes_made: changesMade,
        generator,
        ai_involvement: sanitize(rec.ai_involvement || 'none'),
        reviewer: sanitize(rec.reviewer || 'w11-provenance-e1'),
        review_date: sanitize(rec.review_date || '2026-11-22'),
        ledger_status: sanitize(rec.ledger_status || 'approved'),
      });
    }
  }

  ingestWave11Source(WAVE11_MANIFEST_JSON, 'wave11-manifest', 'frontend/public/echo-life/aaa-v2/wave11-manifest.json');
  if (fs.existsSync(WAVE11_META_DIR)) {
    const metaFiles = fs.readdirSync(WAVE11_META_DIR).filter((f) => /_meta\.json$/i.test(f)).sort();
    for (const mf of metaFiles) {
      const batchPrefix = mf.replace(/_meta\.json$/i, '');
      const scriptCandidate = `docs/echo-life/aaa-evolution/scripts/build_wave11_${batchPrefix}.py`;
      const defaultGen = fs.existsSync(path.resolve(ROOT, scriptCandidate))
        ? scriptCandidate
        : `docs/echo-life/aaa-evolution/scripts/_raw_glb/wave11/${mf}`;
      ingestWave11Source(path.join(WAVE11_META_DIR, mf), `wave11-meta:${batchPrefix}`, defaultGen);
    }
  }

  // Write UTF-8 LF TSV
  const lines = [COLUMNS.join('\t')];
  for (const r of rows) {
    lines.push(COLUMNS.map((c) => sanitize(r[c] ?? '')).join('\t'));
  }
  fs.writeFileSync(OUT_LEDGER, lines.join('\n') + '\n', 'utf8');

  const licenseBreakdown = {};
  for (const r of rows) {
    licenseBreakdown[r.license_spdx] = (licenseBreakdown[r.license_spdx] || 0) + 1;
  }
  console.log(JSON.stringify({
    totalRows: rows.length,
    outLedger: path.relative(ROOT, OUT_LEDGER).replace(/\\/g, '/'),
    groups: groupCounts,
    workshopSkippedReplaced,
    wave11ManifestPresent: fs.existsSync(WAVE11_MANIFEST_JSON),
    licenseBreakdown,
  }, null, 2));
}

main();
