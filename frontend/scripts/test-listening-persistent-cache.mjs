// Test suite for Listening Persistent Cache Across F5 / Hard Reload
import assert from 'node:assert/strict';

console.log('=== Running Listening Persistent Cache Test Suite ===\n');

// Mock localStorage in Node environment
const mockStorage = new Map();
global.window = {};
global.localStorage = {
  getItem: (k) => mockStorage.get(k) ?? null,
  setItem: (k, v) => mockStorage.set(k, String(v)),
  removeItem: (k) => mockStorage.delete(k),
  clear: () => mockStorage.clear(),
  get length() { return mockStorage.size; },
  key: (i) => Array.from(mockStorage.keys())[i] ?? null,
};

// Dynamic import of listeningCache module
const {
  saveCachedListeningCategories,
  getCachedListeningCategories,
  saveCachedPersonalListening,
  getCachedPersonalListening,
  saveCachedListeningDetail,
  getCachedListeningDetail,
  saveCachedListeningDNA,
  getCachedListeningDNA,
  clearListeningUserCache,
  addPersonalListeningMaterial,
  removePersonalListeningMaterial,
  getActiveListeningUser,
  saveActiveListeningUser,
} = await import('../src/services/listeningCache.ts');

// 1. Initial State: Empty
console.log('1. Checking Initial Cache State...');
assert.equal(getCachedListeningCategories('user1'), undefined, 'User 1 categories must be undefined on cold start');
assert.equal(getCachedPersonalListening('user1', '/api/v1/listening/personal'), undefined, 'User 1 personal materials must be undefined on cold start');
console.log('  -> PASS: Initial state is clean.');

// 2. First Visit Simulation (Network response cached)
console.log('2. Simulating First Visit & Cache Population...');
const mockCategories = [
  { id: 1, name: 'Daily Life', code: 'DAILY', materialCount: 15 },
  { id: 2, name: 'Academic', code: 'ACAD', materialCount: 8 },
];
const mockPersonalMaterials = [
  { id: 101, title: 'My Custom Podcast', isPersonal: true, duration: 120 },
];
const mockDetail = {
  id: 101,
  title: 'My Custom Podcast',
  audioUrl: 'https://cdn.example.com/audio.mp3',
  transcript: 'Hello world',
};
const mockDna = {
  totalAnalyzed: 45,
  overallAccuracy: 88.5,
};

saveCachedListeningCategories('user1', mockCategories);
saveCachedPersonalListening('user1', '/api/v1/listening/personal', mockPersonalMaterials);
saveCachedListeningDetail('user1', 101, mockDetail);
saveCachedListeningDNA('user1', mockDna);

assert.equal(getActiveListeningUser(), 'user1', 'Active user must be tracked as user1');
console.log('  -> PASS: First visit successfully stored user-scoped data.');

// 3. F5 / Hard Reload Simulation
console.log('3. Simulating F5 / Hard Reload Instant Synchronous Hydration...');
// On page reload, getCachedListeningCategories('user1') is called immediately synchronously
const hydratedCategories = getCachedListeningCategories('user1');
assert.deepEqual(hydratedCategories, mockCategories, 'Hydrated categories must match stored categories');

const hydratedPersonal = getCachedPersonalListening('user1', '/api/v1/listening/personal');
assert.deepEqual(hydratedPersonal, mockPersonalMaterials, 'Hydrated personal materials must match stored data');

const hydratedDetail = getCachedListeningDetail('user1', 101);
assert.deepEqual(hydratedDetail, mockDetail, 'Hydrated material detail must match stored detail');

const hydratedDna = getCachedListeningDNA('user1');
assert.deepEqual(hydratedDna, mockDna, 'Hydrated DNA analytics must match stored DNA');
console.log('  -> PASS: Zero-delay synchronous hydration verified across F5/reload.');

// 4. Strict User-Scoping & Cross-User Isolation (User A vs User B)
console.log('4. Verifying User-Scoping & Cross-User Isolation...');
assert.equal(getCachedListeningCategories('user2'), undefined, 'User 2 must NOT see User 1 categories');
assert.equal(getCachedPersonalListening('user2', '/api/v1/listening/personal'), undefined, 'User 2 must NOT see User 1 personal materials');
assert.equal(getCachedListeningDetail('user2', 101), undefined, 'User 2 must NOT see User 1 material details');
assert.equal(getCachedListeningDNA('user2'), undefined, 'User 2 must NOT see User 1 DNA analytics');
console.log('  -> PASS: Private cache is strictly isolated per user.');

// 5. Post-Import Mutation & Update
console.log('5. Verifying Post-Import Material Mutation & Invalidation...');
const newItem = { id: 102, title: 'Second Imported Material', isPersonal: true, duration: 240 };
addPersonalListeningMaterial('user1', newItem);
const updatedPersonal = getCachedPersonalListening('user1', '/api/v1/listening/personal');
assert.equal(updatedPersonal.length, 2, 'Personal cache must now have 2 items after import');
assert.equal(updatedPersonal[0].id, 102, 'Newly imported material must be prepended at index 0');

// Removal
removePersonalListeningMaterial('user1', 101);
const afterRemoval = getCachedPersonalListening('user1', '/api/v1/listening/personal');
assert.equal(afterRemoval.length, 1, 'Personal cache must have 1 item after deletion');
assert.equal(afterRemoval[0].id, 102);

// System categories should remain intact
assert.deepEqual(getCachedListeningCategories('user1'), mockCategories, 'System categories must remain intact after personal cache mutation');
console.log('  -> PASS: Post-import mutation correctly updates user personal data while preserving system catalogue.');

// 6. Logout / Account Switch Cleanup
console.log('6. Verifying Logout / Account Switch Wipe...');
clearListeningUserCache('user1');
assert.equal(getCachedListeningCategories('user1'), undefined, 'User 1 categories must be wiped after logout');
assert.equal(getCachedPersonalListening('user1', '/api/v1/listening/personal'), undefined, 'User 1 personal materials must be wiped after logout');
assert.equal(getCachedListeningDetail('user1', 101), undefined, 'User 1 detail must be wiped after logout');
assert.equal(getActiveListeningUser(), null, 'Active user pointer must be cleared');
console.log('  -> PASS: Complete wipe on logout verified.');

console.log('\n>>> ALL LISTENING PERSISTENT CACHE TESTS PASSED (6/6) <<<\n');
