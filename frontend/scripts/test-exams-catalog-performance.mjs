import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync('src/hooks/useExamCatalog.ts', 'utf8');
let captured;
let requests = [];
let scope = 'user-A';
let response = { forms: [{ id: 'shared', family: 'IELTS', skills: ['WRITING'], state: 'PILOT' }], total: 30, hasMore: true, variants: ['ACADEMIC'] };
let cacheState = { data: [response], error: undefined, isLoading: false, isValidating: true, size: 1, mutate: () => {}, setSize: n => n };
const modules = {
  swr: { default: (key, fetcher, options) => { captured = { key, fetcher, options }; return { data: undefined, isLoading: true, mutate: () => {} }; } },
  'swr/infinite': { default: (key, fetcher, options) => { captured = { key, fetcher, options }; return cacheState; } },
  './useModuleEntryResource': { useModuleEntryScope: () => scope },
  '@/lib/exams/productPolicy': { activeLearnerForm: () => true },
  '@/services/examsApi': { examsApi: { getCatalog: async params => { requests.push(params); return response; } } },
};
const exports = {};
const executable = stripTypeScriptTypes(source)
  .replace(/import (\w+) from '([^']+)';/g, "const $1 = require('$2').default;")
  .replace(/import \{([^}]+)\} from '([^']+)';/g, "const {$1} = require('$2');")
  .replace(/export function (\w+)/g, 'exports.$1 = function $1');
vm.runInNewContext(executable,
  { exports, require: name => modules[name], Map, Set });
let catalog = exports.useExamCatalog('IELTS');
assert.equal(catalog.forms.length, 1);
assert.equal(catalog.isLoading, false, 'cached cards remain during revalidation');
await captured.fetcher(captured.key(0, null));
assert.equal(requests.length, 1, 'one initial window request, no corpus loop');
assert.equal(requests[0].limit, 24);
assert.equal(requests[0].availability, 'USABLE');
await captured.fetcher(captured.key(1, response));
assert.equal(requests[1].offset, 24);
assert.equal(captured.key(2, { hasMore: false }), null);
assert.equal(captured.options.revalidateOnFocus, false);
assert.equal(captured.options.keepPreviousData, true);
cacheState = { ...cacheState, error: new Error('refresh failed'), isLoading: true };
catalog = exports.useExamCatalog('IELTS');
assert.equal(catalog.forms.length, 1);
assert.equal(catalog.isLoading, false, 'failed refresh retains known-good cards');
exports.useExamHistory('IELTS'); const aKey = captured.key.join(':');
assert.equal(captured.options.keepPreviousData, false);
scope = 'user-B'; exports.useExamHistory('IELTS');
assert.notEqual(aKey, captured.key.join(':'), 'private overlays scoped across users');
exports.useExamAnalytics('IELTS'); assert(captured.key.includes('user-B'));
assert(!source.includes('await examsApi.getAnalytics') || !source.slice(source.indexOf('export function useExamCatalog'), source.indexOf('export function useExamHistory')).includes('getAnalytics'));
const family = fs.readFileSync('src/components/features/exams/ExamsFamilyPage.tsx', 'utf8');
assert(family.includes("hidden={activeTab !== 'library'}"), 'tab switches retain mounted catalog');
assert(family.includes("activeTab === 'progress' && <ExamLearnerProgress"), 'analytics lazy and independent');
exports.rememberCatalogFilters('IELTS', { mode: 'ALL', query: 'cambridge', variant: 'ACADEMIC' });
assert.equal(exports.rememberedCatalogFilters('IELTS').query, 'cambridge', 'back navigation retains search');
const lib = fs.readFileSync('src/components/features/exams/ExamLibrary.tsx', 'utf8');
assert(lib.includes('isLoading && forms.length === 0'));
assert(lib.includes('loadError && forms.length === 0'));
console.log('Exams catalog performance: paging, retained refresh/error, account isolation, lazy analytics and tab/back retention PASS');
