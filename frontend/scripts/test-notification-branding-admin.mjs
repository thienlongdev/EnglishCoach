// Verification script for Phase C.0.1 Notification Branding + Admin Entry Contracts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');

console.log('--- Testing English Coach Phase C.0.1 Notification Branding & Admin Navigation Contracts ---');

// ─── 1. Admin Navigation Entry in Sidebar ──────────────────────────────────────
console.log('1. Testing Admin Navigation Entry in Sidebar...');

const sidebarSource = fs.readFileSync(path.join(frontendRoot, 'src/components/layout/Sidebar.tsx'), 'utf-8');

// A. Check isAdmin role check
assert.ok(
  sidebarSource.includes('(user as any)?.role === "ROLE_ADMIN"') || sidebarSource.includes("(user as any)?.role === 'ROLE_ADMIN'"),
  'Sidebar must check authenticated user role for ROLE_ADMIN'
);

// B. Check Admin section is conditional on isAdmin
assert.ok(
  sidebarSource.includes('{isAdmin && ('),
  'Admin navigation section must be strictly gated by {isAdmin && (...)}'
);

// C. Check Admin navigation text and link
assert.ok(
  sidebarSource.includes('href="/admin/notifications"'),
  'Admin navigation link must point to /admin/notifications'
);
assert.ok(
  sidebarSource.includes('Quản trị'),
  'Admin navigation must have section label "Quản trị"'
);
assert.ok(
  sidebarSource.includes('Thông báo'),
  'Admin navigation link text must be "Thông báo"'
);

console.log('  -> PASS: Sidebar admin navigation is correctly role-gated to ROLE_ADMIN and points to /admin/notifications');

// ─── 2. Notification Whale Branding & Fallback in Popover ────────────────────
console.log('2. Testing Notification Whale Branding & Fallback in Popover...');

const popoverSource = fs.readFileSync(path.join(frontendRoot, 'src/components/layout/NotificationPopover.tsx'), 'utf-8');

// A. Check NotificationWhaleIcon component exists
assert.ok(
  popoverSource.includes('function NotificationWhaleIcon()'),
  'NotificationPopover must declare NotificationWhaleIcon'
);

// B. Check Whale SVG asset is referenced
assert.ok(
  popoverSource.includes("src={echoSrc('official'"),
  'NotificationWhaleIcon must render the official Echo mark from the brand registry'
);

// C. Check accessibility
assert.ok(
  popoverSource.includes('alt=""') && popoverSource.includes('aria-hidden="true"'),
  'Whale icon must have empty alt and aria-hidden="true" for decorative accessibility inside notification item'
);

// D. Check fallback handling
assert.ok(
  popoverSource.includes('onError={() => setHasError(true)}'),
  'NotificationWhaleIcon must set error state onError'
);
assert.ok(
  popoverSource.includes('if (hasError)'),
  'NotificationWhaleIcon must render safe fallback if error occurs'
);

// E. Check renderTypeIcon uses Whale icon
assert.ok(
  popoverSource.includes('renderTypeIcon = (_type: NotificationType) => {') &&
  popoverSource.includes('return <NotificationWhaleIcon />;'),
  'renderTypeIcon must return NotificationWhaleIcon for notifications'
);

console.log('  -> PASS: Notification item uses official Whale asset with graceful Bell fallback');

// ─── 3. Admin Notification Page Composer & Preview ────────────────────────────
console.log('3. Testing Admin Notification Page Composer & Preview...');

const adminPageSource = fs.readFileSync(path.join(frontendRoot, 'src/app/admin/notifications/page.tsx'), 'utf-8');

// A. Role protection
assert.ok(
  adminPageSource.includes("const isAdmin = (session?.user as any)?.role === 'ROLE_ADMIN'"),
  'Admin notifications page must check ROLE_ADMIN'
);
assert.ok(
  adminPageSource.includes('Truy cập bị từ chối (403)'),
  'Admin notifications page must show 403 Access Denied when !isAdmin'
);

// B. Composer controls
assert.ok(
  adminPageSource.includes('setScope') && adminPageSource.includes('GLOBAL') && adminPageSource.includes('USER'),
  'Admin page must include scope control (GLOBAL / USER)'
);
assert.ok(
  adminPageSource.includes('setTitle') && adminPageSource.includes('setBody'),
  'Admin page must include title and body inputs'
);

// C. Preview includes Whale branding
assert.ok(
  adminPageSource.includes("src={echoSrc('official'"),
  'Live preview card on admin notifications page must display the official Echo mark'
);

console.log('  -> PASS: Admin notifications page contains complete composer, 403 guard, and whale preview');

console.log('\nALL NOTIFICATION BRANDING & ADMIN ENTRY CONTRACT TESTS PASSED! [OK]');
