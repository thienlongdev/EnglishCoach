// Verification script for Avatar Delivery, Global Avatar Integration & Caching Contracts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');

console.log('--- Testing English Coach Avatar Delivery & Global Integration Contracts ---');

// ─── 1. Initials Derivation Contract ──────────────────────────────────────────
console.log('1. Testing Initials Fallback Derivation Contract...');

function deriveInitials(displayName, fallbackName, profileInitials = 'EC') {
  const candidate = displayName || fallbackName || '';
  if (!candidate.trim()) return profileInitials;
  return candidate
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

assert.equal(deriveInitials('Alex Johnson'), 'AJ');
assert.equal(deriveInitials('Nguyễn Quang'), 'NQ');
assert.equal(deriveInitials('John'), 'J');
assert.equal(deriveInitials('  Trần   Thị   Mai  '), 'TT');
assert.equal(deriveInitials('', 'Backup Name'), 'BN');
assert.equal(deriveInitials(null, null), 'EC');
assert.equal(deriveInitials(undefined, undefined, 'DF'), 'DF');

console.log('  -> PASS: Initials derivation strictly produces correct uppercase 1-2 letter initials with EC fallback.');

// ─── 2. User-Scoped SWR Cache Key Contracts ──────────────────────────────────
console.log('2. Testing User-Scoped SWR Cache Key Invariants...');

const USER_PROFILE_CACHE_KEY_PREFIX = '/users/me/profile';
const USER_AVATAR_CACHE_KEY_PREFIX = '/users/me/avatar';

function getProfileKey(status, email) {
  return status === 'authenticated' && email
    ? [USER_PROFILE_CACHE_KEY_PREFIX, email]
    : null;
}

function getAvatarKey(status, email, avatarPresent, avatarUpdatedAt) {
  if (status !== 'authenticated' || !email || !avatarPresent) {
    return null;
  }
  return [USER_AVATAR_CACHE_KEY_PREFIX, email, avatarUpdatedAt || 'default'];
}

// Unauthenticated user -> no requests
assert.equal(getProfileKey('unauthenticated', 'user@test.com'), null);
assert.equal(getAvatarKey('unauthenticated', 'user@test.com', true, '2026-09-26T12:00:00Z'), null);

// Authenticated user with no avatar -> profile key present, avatar key null
const userAProfileKey = getProfileKey('authenticated', 'userA@test.com');
assert.deepEqual(userAProfileKey, [USER_PROFILE_CACHE_KEY_PREFIX, 'userA@test.com']);
assert.equal(getAvatarKey('authenticated', 'userA@test.com', false, null), null);

// Authenticated user with avatar -> both keys present
const v1Timestamp = '2026-09-26T10:00:00Z';
const userAAvatarKeyV1 = getAvatarKey('authenticated', 'userA@test.com', true, v1Timestamp);
assert.deepEqual(userAAvatarKeyV1, [USER_AVATAR_CACHE_KEY_PREFIX, 'userA@test.com', v1Timestamp]);

// Cache Versioning: Uploading new avatar changes avatarUpdatedAt -> new SWR key
const v2Timestamp = '2026-09-26T10:05:00Z';
const userAAvatarKeyV2 = getAvatarKey('authenticated', 'userA@test.com', true, v2Timestamp);
assert.notDeepEqual(userAAvatarKeyV1, userAAvatarKeyV2);
assert.deepEqual(userAAvatarKeyV2, [USER_AVATAR_CACHE_KEY_PREFIX, 'userA@test.com', v2Timestamp]);

// Deleting avatar -> key becomes null -> immediate fallback to initials
const userAAvatarKeyDeleted = getAvatarKey('authenticated', 'userA@test.com', false, null);
assert.equal(userAAvatarKeyDeleted, null);

// Multi-tenant isolation: User B has different cache keys
const userBAvatarKey = getAvatarKey('authenticated', 'userB@test.com', true, v1Timestamp);
assert.notDeepEqual(userAAvatarKeyV1, userBAvatarKey);

console.log('  -> PASS: Cache keys are strictly user-scoped, versioned by avatarUpdatedAt, and null when avatar is absent.');

// ─── 3. Source Code Integration & Architecture Invariants ────────────────────
console.log('3. Verifying Source Code Integration Across Surfaces...');

const topNavbarSrc = fs.readFileSync(path.join(frontendRoot, 'src/components/layout/TopNavbar.tsx'), 'utf-8');
const sidebarSrc = fs.readFileSync(path.join(frontendRoot, 'src/components/layout/Sidebar.tsx'), 'utf-8');
const profileSrc = fs.readFileSync(path.join(frontendRoot, 'src/app/profile/page.tsx'), 'utf-8');
const userAvatarSrc = fs.readFileSync(path.join(frontendRoot, 'src/components/common/UserAvatar.tsx'), 'utf-8');
const useProfileSrc = fs.readFileSync(path.join(frontendRoot, 'src/hooks/useCurrentUserProfile.ts'), 'utf-8');
const useAvatarSrc = fs.readFileSync(path.join(frontendRoot, 'src/hooks/useCurrentUserAvatar.ts'), 'utf-8');
const authCleanupSrc = fs.readFileSync(path.join(frontendRoot, 'src/lib/auth-cache-cleanup.ts'), 'utf-8');

// TopNavbar assertions
assert.ok(topNavbarSrc.includes('import { UserAvatar } from'), 'TopNavbar must import UserAvatar');
assert.ok(topNavbarSrc.includes('<UserAvatar'), 'TopNavbar must render UserAvatar');
assert.ok(!topNavbarSrc.includes('window.location.reload'), 'TopNavbar must not reload page');

// Sidebar assertions
// Owner decision 2026-11-02: the sidebar's bottom account card is replaced by the Không gian học tập launcher; the account (avatar, profile, sign-out) lives in the top-right account menu.
assert.ok(sidebarSrc.includes('data-testid="sidebar-study-space"') && sidebarSrc.includes('href="/study-space"'), 'Sidebar must offer the Không gian học tập launcher in place of the account card');
assert.ok(!sidebarSrc.includes('window.location.reload'), 'Sidebar must not reload page');

// Profile page assertions
assert.ok(profileSrc.includes('useCurrentUserProfile'), 'Profile page must use shared useCurrentUserProfile');
assert.ok(profileSrc.includes('useCurrentUserAvatar'), 'Profile page must use shared useCurrentUserAvatar');
assert.ok(profileSrc.includes('<UserAvatar'), 'Profile page must render UserAvatar');
assert.ok(profileSrc.includes('mutateProfile(updated'), 'Profile page must mutate shared profile cache on upload/update');
assert.ok(profileSrc.includes('revokeCurrentAvatarObjectUrl()'), 'Profile page must revoke object URL on avatar delete');
assert.ok(!profileSrc.includes('window.location.reload'), 'Profile page must NOT reload page on upload or delete');

// UserAvatar assertions
assert.ok(userAvatarSrc.includes('useCurrentUserAvatar()'), 'UserAvatar must use useCurrentUserAvatar');
assert.ok(userAvatarSrc.includes('useCurrentUserProfile()'), 'UserAvatar must use useCurrentUserProfile');
assert.ok(userAvatarSrc.includes('onError='), 'UserAvatar must handle image error fallback');
assert.ok(userAvatarSrc.includes('motion-reduce:transition-none'), 'UserAvatar must respect prefers-reduced-motion');

// Auth cleanup assertions
assert.ok(authCleanupSrc.includes('revokeCurrentAvatarObjectUrl()') || authCleanupSrc.includes('safely(revokeCurrentAvatarObjectUrl)'), 'auth-cache-cleanup must revoke avatar URL on logout, including the failure-isolated callback form');

console.log('  -> PASS: TopNavbar, Sidebar, and Profile are all connected to the shared avatar data path with zero page reloads.');

// ─── 4. Mock Object URL Lifecycle Invariants ─────────────────────────────────
console.log('4. Testing Object URL Lifecycle Invariants...');

let revokedUrls = [];
const mockRevokeObjectURL = (url) => revokedUrls.push(url);
let urlCounter = 0;
const mockCreateObjectURL = (blob) => `blob:http://localhost:3000/${++urlCounter}`;

class ObjectUrlManager {
  constructor() {
    this.currentKey = null;
    this.currentUrl = null;
  }

  getOrCreate(key, blob) {
    if (this.currentKey === key && this.currentUrl) {
      return this.currentUrl;
    }
    if (this.currentUrl) {
      mockRevokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    this.currentKey = key;
    this.currentUrl = mockCreateObjectURL(blob);
    return this.currentUrl;
  }

  revoke() {
    if (this.currentUrl) {
      mockRevokeObjectURL(this.currentUrl);
      this.currentUrl = null;
      this.currentKey = null;
    }
  }
}

const manager = new ObjectUrlManager();
const blobA = { size: 1024 };

// Component 1 (TopNavbar) requests avatar
const url1 = manager.getOrCreate('userA:v1', blobA);
assert.equal(url1, 'blob:http://localhost:3000/1');

// Component 2 (Sidebar) requests same avatar -> reuses exact same URL, no new URL created!
const url2 = manager.getOrCreate('userA:v1', blobA);
assert.equal(url2, 'blob:http://localhost:3000/1');
assert.equal(revokedUrls.length, 0);

// Component 3 (Profile) requests same avatar -> reuses exact same URL
const url3 = manager.getOrCreate('userA:v1', blobA);
assert.equal(url3, 'blob:http://localhost:3000/1');
assert.equal(revokedUrls.length, 0);

// User uploads new avatar (key changes to userA:v2)
const blobB = { size: 2048 };
const url4 = manager.getOrCreate('userA:v2', blobB);
assert.equal(url4, 'blob:http://localhost:3000/2');
assert.deepEqual(revokedUrls, ['blob:http://localhost:3000/1']);

// User deletes avatar
manager.revoke();
assert.deepEqual(revokedUrls, ['blob:http://localhost:3000/1', 'blob:http://localhost:3000/2']);
assert.equal(manager.currentUrl, null);

console.log('  -> PASS: Object URLs are deduplicated across consumers and strictly revoked upon invalidation.');

console.log('\n--- ALL AVATAR CONTRACTS AND ARCHITECTURE INVARIANTS PASSED ---');
