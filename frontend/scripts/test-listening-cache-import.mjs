/**
 * Test Suite: Listening revisit cache + personal YouTube import isolation (UI contract)
 *
 * Verifies (static source inspection, same style as the other scripts/*.mjs contracts):
 * 1. Exactly one import CTA on /listening (the Hero "+ Import YouTube Video")
 * 2. SYSTEM categories use an approved global hook; personal lists stay account scoped
 * 3. Blocking loaders only when no cached data exists; no window.location.reload
 * 4. Import success: switch to "Bai nghe cua toi", update personal cache only, never the SYSTEM cache
 * 5. Modal passes the server-created item, revalidates the personal library, guards double-submit
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('--- Running Listening Cache + Personal Import Contract Suite ---');

const modalCode = fs.readFileSync(path.resolve(__dirname, '../src/components/features/listening/ImportMaterialModal.tsx'), 'utf-8');
const pagePath = path.resolve(__dirname, '../src/app/listening/page.tsx');
const pageCode = fs.readFileSync(pagePath, 'utf-8');
const apiCode = fs.readFileSync(path.resolve(__dirname, '../src/services/listeningApi.ts'), 'utf-8');

assert.strictEqual(
    (pageCode.match(/setIsImportOpen\(true\)/g) || []).length, 1,
    'Listening page must expose exactly one import CTA (the Hero "+ Import YouTube Video")'
);
assert.ok(!pageCode.includes('Import video mới'), 'Redundant "Import video mới" CTA must be removed from "Bài nghe của tôi"');
assert.ok(!pageCode.includes('Import ngay'), 'Redundant empty-state import CTA must be removed');
console.log('✓ PASS: Exactly one import CTA (Hero)');

assert.ok(pageCode.includes("from 'swr'") && pageCode.includes('useListeningSystemCategories()') && pageCode.includes('useSWR<ListeningMaterialSummary[]>'),
    'Listening page must read categories and personal materials through the shared SWR cache');
assert.ok(pageCode.includes('useListeningSystemCategories()') && pageCode.includes('[personalPath, userScope]'),
    'SYSTEM uses the approved SYSTEM hook; personal keys remain account scoped');
assert.ok(pageCode.includes('personalData === undefined && personalFetching') && pageCode.includes('categoriesData === undefined && categoriesFetching'),
    'Blocking loaders must only show when there is no cached data');
assert.ok(!/window\.location\.reload/.test(pageCode), 'Listening page must never full-reload');
console.log('✓ PASS: SYSTEM/account cache taxonomy and non-blocking revalidation');

assert.ok(pageCode.includes('onSuccess={handleImportSuccess}'), 'Import success must go through handleImportSuccess');
assert.ok(pageCode.includes("setActiveTab('personal')"), 'Import success must switch to "Bài nghe của tôi"');
assert.ok(pageCode.includes('[buildPersonalListeningPath(), userScope]'), 'Import success must update the unfiltered personal-library cache');
const importHandler = pageCode.slice(pageCode.indexOf('const handleImportSuccess'), pageCode.indexOf('// Active Category Object'));
assert.ok(!importHandler.includes('LISTENING_CATEGORIES_PATH'), 'Personal import must never touch the SYSTEM catalogue cache');
assert.ok(modalCode.includes('onSuccessRef.current(created)') && modalCode.includes('revalidatePersonalListeningLibrary()'),
    'Modal must pass the server-created item and revalidate the personal library');
assert.ok(modalCode.includes('inFlightRef.current') , 'Modal must guard against double-submit');
assert.ok(apiCode.includes("'/listening/materials?personalOnly=true'"), 'Personal-library keys must be recognised by the personalOnly prefix');
console.log('✓ PASS: Post-import personal cache update, tab switch, SYSTEM cache untouched, double-submit guard');

console.log('--- All Listening Cache + Personal Import Contract Tests PASSED! ---');
