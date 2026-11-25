// Echo Garden Phase 3E — deterministic cosmetic catalogue / asset audit.
//
//   node scripts/audit-garden-cosmetics.mjs [--json out.json]
//
// Joins the three sources of the catalogue and reports what is really usable:
//   * the reviewed catalogue (backend/src/test/resources/garden/phase3e_catalogue.json — the source V86 was generated from),
//   * the V86 seed (every code must be seeded: an item without a server row cannot be owned),
//   * the runtime manifest + the files on disk (every item needs its own real art, every crop skin all four stages).
// A thumbnail, a shadow, a glow pass or an alias of another file never counts as an item: sprites are compared by
// content hash, so two keys pointing at the same picture are reported as duplicates.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = new URL('.', import.meta.url);
const WORLD = new URL('../public/garden/world/', here);
const read = (u) => readFileSync(u, 'utf8');

export function auditCosmetics() {
  const catalogue = JSON.parse(read(new URL('../../backend/src/test/resources/garden/phase3e_catalogue.json', here)));
  const sql = read(new URL('../../backend/src/main/resources/db/migration/exams/V86__echo_garden_phase3e_cosmetics.sql', here));
  const manifest = JSON.parse(read(new URL('world_manifest.json', WORLD)));
  const sprites = manifest.sprites;
  const missing = [];
  const invalid = [];
  const hashes = new Map();
  const usable = (key) => {
    const e = sprites[key];
    if (!e) {
      missing.push(key);
      return false;
    }
    let ok = true;
    for (const f of [e.file, e.glow, e.shadow?.file].filter(Boolean)) {
      const u = new URL(f, WORLD);
      // a soft shadow of a seedling or a post is honestly ~100 bytes of WebP; an absent or truncated file is not
      if (!existsSync(u) || statSync(u).size < 60) {
        invalid.push(`${key}: ${f}`);
        ok = false;
      }
    }
    if (ok) {
      if (!(e.w > 8 && e.h > 8 && e.ax >= 0 && e.ax <= e.w && e.ay >= 0 && e.ay <= e.h + 2 && e.scale > 0)) invalid.push(`${key}: metadata`);
      const h = createHash('sha1').update(readFileSync(new URL(e.file, WORLD))).digest('hex');
      hashes.set(h, [...(hashes.get(h) ?? []), key]);
    }
    return ok;
  };
  const seeded = (code) => sql.includes(`('${code}',`);

  // ---- crop skins: four growth stages each, by species
  const crops = {};
  let stageSprites = 0;
  for (const s of catalogue.skins) {
    const stages = [1, 2, 3, 4].filter((st) => usable(`cskin_${s.artKey}_s${st}`));
    stageSprites += stages.length;
    const row = { code: s.code, art: s.artKey, stages: stages.length, seeded: seeded(s.code), shadow: [1, 2, 3, 4].every((st) => !!sprites[`cskin_${s.artKey}_s${st}`]?.shadow) };
    (crops[s.cropCode] ??= []).push(row);
  }
  const completeSkins = Object.values(crops).flat().filter((r) => r.stages === 4 && r.seeded).length;

  // ---- cosmetics by category
  const parts = {
    HOUSE: (a) => [0, 1, 2, 3].map((l) => `house_${a}_l${l}`),
    TREE: (a) => [`veg_tree_${a}_a`, `veg_tree_${a}_b`],
    SHRUB: (a) => [`veg_shrub_${a}_a`, `veg_shrub_${a}_b`],
    FLOWER: (a) => [`veg_flower_${a}_a`, `veg_flower_${a}_b`],
    MONUMENT: (a) => [`kt_cos_${a}_base`, `kt_cos_${a}_a`, `kt_cos_${a}_b`],
    FENCE: (a) => ['x_a', 'x_b', 'x_long', 'y_a', 'y_b', 'post', 'gate'].map((p) => `fence_${a}_${p}`),
    PATH: (a) => ['a', 'b', 'c'].map((f) => `path_${a}_${f}`),
    BED: (a) => [`bedframe_${a}`],
    DECOR: (a) => [`decor_${a}`],
  };
  const categories = {};
  const families = {};
  for (const c of catalogue.cosmetics) {
    const keys = parts[c.category](c.artKey);
    const ok = keys.map(usable).every(Boolean) && seeded(c.code);
    const row = { code: c.code, art: c.artKey, sprites: keys.length, usable: ok, unlock: c.unlockKind, price: c.coinPrice, maxOwned: c.maxOwned };
    (categories[c.category] ??= []).push(row);
    if (c.category === 'DECOR') (families[c.family] ??= []).push(row);
  }
  // the island's own cottage: the approved sprite at level 0 and the classic architecture above it
  const classic = ['cottage', 'house_classic_l1', 'house_classic_l2', 'house_classic_l3'].map(usable).every(Boolean);
  const houseMeta = Object.keys(manifest.houses ?? {});
  // a cultivar must not be the plain crop's picture either: the species' own sprites join the comparison
  const checked = new Set([...hashes.values()].flat());
  for (const [key, e] of Object.entries(sprites)) {
    if (!/^(crop_|cskin_|fence_|decor_|plot_bed)/.test(key) || checked.has(key) || !existsSync(new URL(e.file, WORLD))) continue;
    const h = createHash('sha1').update(readFileSync(new URL(e.file, WORLD))).digest('hex');
    if (hashes.has(h)) hashes.get(h).push(key);
  }
  const duplicates = [...hashes.values()].filter((keys) => keys.length > 1);
  const count = (list) => list.filter((r) => r.usable).length;
  return {
    catalogue, manifest,
    summary: {
      cropSkins: { total: catalogue.skins.length, complete: completeSkins, stageSprites, perCrop: Object.fromEntries(Object.entries(crops).map(([k, v]) => [k, v.filter((r) => r.stages === 4 && r.seeded).length])) },
      houses: { themes: count(categories.HOUSE ?? []), levelsPerTheme: 4, classicLevels: classic ? 4 : 0, chimneyMeta: houseMeta.length },
      vegetation: { TREE: count(categories.TREE ?? []), SHRUB: count(categories.SHRUB ?? []), FLOWER: count(categories.FLOWER ?? []) },
      monumentSets: count(categories.MONUMENT ?? []),
      cosmeticSockets: manifest.monument?.cosmeticSockets?.length ?? 0,
      decorations: Object.fromEntries(Object.entries(families).map(([k, v]) => [k, count(v)])),
      fences: count(categories.FENCE ?? []),
      paths: count(categories.PATH ?? []),
      beds: count(categories.BED ?? []),
      storeProducts: catalogue.skins.length + catalogue.cosmetics.length,
      usableProducts: completeSkins + Object.values(categories).flat().filter((r) => r.usable).length,
      collections: catalogue.collections.length,
      missingAssets: missing.length,
      invalidReferences: invalid.length,
      duplicateArt: duplicates.length,
    },
    crops, categories, families, missing, invalid, duplicates,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = auditCosmetics();
  const s = a.summary;
  console.log('Echo Garden Phase 3E — cosmetic catalogue audit');
  console.log(`crop skins: ${s.cropSkins.complete}/${s.cropSkins.total} complete (four stages + seeded), ${s.cropSkins.stageSprites} stage sprites`);
  for (const [crop, n] of Object.entries(s.cropSkins.perCrop)) console.log(`  ${crop.padEnd(15)} ${n} new skins`);
  console.log(`house themes: ${s.houses.themes} (x${s.houses.levelsPerTheme} levels) + classic levels ${s.houses.classicLevels}; chimney metadata for ${s.houses.chimneyMeta} sprites`);
  console.log(`vegetation: TREE ${s.vegetation.TREE}, SHRUB ${s.vegetation.SHRUB}, FLOWER ${s.vegetation.FLOWER} (two forms each)`);
  console.log(`monument sets: ${s.monumentSets} (root ring + two charms), cosmetic sockets ${s.cosmeticSockets}`);
  console.log(`decorations: ${Object.entries(s.decorations).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`fences ${s.fences} (seven bay sprites each), paths ${s.paths} (three stamps each), bed frames ${s.beds}`);
  console.log(`store products: ${s.usableProducts}/${s.storeProducts} usable in ${s.collections} collections`);
  console.log(`missing assets ${s.missingAssets}, invalid references ${s.invalidReferences}, duplicated art ${s.duplicateArt}`);
  if (a.missing.length) console.log('missing:', a.missing.join(', '));
  if (a.invalid.length) console.log('invalid:', a.invalid.join(', '));
  if (a.duplicates.length) console.log('duplicates:', JSON.stringify(a.duplicates));
  const out = process.argv.indexOf('--json');
  if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify({ summary: s, crops: a.crops, categories: a.categories, missing: a.missing, invalid: a.invalid, duplicates: a.duplicates }, null, 1));
  process.exit(s.missingAssets || s.invalidReferences || s.duplicateArt || s.usableProducts !== s.storeProducts ? 1 : 0);
}
