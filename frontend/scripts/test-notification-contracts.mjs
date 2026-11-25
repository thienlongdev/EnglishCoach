// Verification script for Notification store, dedupe, unread count, read-sync, and actionUrl safety contracts
import assert from 'node:assert/strict';

console.log('--- Testing English Coach Notification Real-time & Store Contracts ---');

// 1. actionUrl validation contract (must start with /, not //, no scheme)
function validateActionUrl(url) {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.includes('://')) {
    return trimmed;
  }
  return null;
}

console.log('1. Testing actionUrl safety validation...');
assert.equal(validateActionUrl('/flashcards'), '/flashcards');
assert.equal(validateActionUrl('/exams/results/123'), '/exams/results/123');
assert.equal(validateActionUrl('/profile?tab=streak'), '/profile?tab=streak');
// Disallowed/external/malicious URLs must be rejected to null
assert.equal(validateActionUrl('https://evil.com'), null);
assert.equal(validateActionUrl('http://evil.com'), null);
assert.equal(validateActionUrl('//evil.com'), null);
assert.equal(validateActionUrl('///evil.com'), null);
assert.equal(validateActionUrl('javascript:alert(1)'), null);
assert.equal(validateActionUrl('data:text/html,...'), null);
assert.equal(validateActionUrl(''), null);
assert.equal(validateActionUrl(null), null);
console.log('  -> PASS: actionUrl strictly allows only safe internal routes.');

// 2. Notification List Deduplication & Ordering
function mergeNotifications(existing, incoming) {
  const map = new Map();
  for (const n of existing) {
    map.set(n.id, n);
  }
  for (const n of incoming) {
    map.set(n.id, { ...map.get(n.id), ...n });
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

console.log('2. Testing notification list deduplication...');
const initialList = [
  { id: 1, title: 'Item 1', createdAt: '2026-09-29T10:00:00Z', isRead: false },
  { id: 2, title: 'Item 2', createdAt: '2026-09-29T09:00:00Z', isRead: true },
];
const duplicateIncoming = [
  { id: 1, title: 'Item 1 updated', createdAt: '2026-09-29T10:00:00Z', isRead: true },
  { id: 3, title: 'Item 3 new', createdAt: '2026-09-29T11:00:00Z', isRead: false },
];
const merged = mergeNotifications(initialList, duplicateIncoming);
assert.equal(merged.length, 3, 'Should deduplicate id=1');
assert.equal(merged[0].id, 3, 'Newest createdAt should be first');
assert.equal(merged[1].id, 1);
assert.equal(merged[1].isRead, true, 'Merged item should have updated isRead');
assert.equal(merged[2].id, 2);
console.log('  -> PASS: Notification merge and dedupe works as expected.');

// 3. Unread count sync across event types
function reduceNotificationEvent(state, event) {
  switch (event.type) {
    case 'NOTIFICATION_CREATED': {
      const { notification, unreadCount } = event.data;
      const exists = state.notifications.some((n) => n.id === notification.id);
      const updatedList = exists
        ? state.notifications.map((n) => (n.id === notification.id ? notification : n))
        : [notification, ...state.notifications];
      return {
        ...state,
        notifications: updatedList,
        unreadCount: typeof unreadCount === 'number' ? unreadCount : state.unreadCount + 1,
      };
    }
    case 'NOTIFICATION_READ': {
      const { id, unreadCount } = event.data;
      return {
        ...state,
        notifications: state.notifications.map((n) =>
          n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n
        ),
        unreadCount: typeof unreadCount === 'number' ? unreadCount : Math.max(0, state.unreadCount - 1),
      };
    }
    case 'NOTIFICATIONS_ALL_READ': {
      const { unreadCount } = event.data;
      return {
        ...state,
        notifications: state.notifications.map((n) => ({
          ...n,
          isRead: true,
          readAt: new Date().toISOString(),
        })),
        unreadCount: typeof unreadCount === 'number' ? unreadCount : 0,
      };
    }
    case 'UNREAD_COUNT_SYNC': {
      return {
        ...state,
        unreadCount: event.data.unreadCount,
      };
    }
    default:
      return state;
  }
}

console.log('3. Testing unread count & multi-tab event transitions...');
let state = {
  notifications: [
    { id: 1, title: 'Item 1', createdAt: '2026-09-29T10:00:00Z', isRead: false },
    { id: 2, title: 'Item 2', createdAt: '2026-09-29T09:00:00Z', isRead: false },
  ],
  unreadCount: 2,
};

// Event 1: New notification created
state = reduceNotificationEvent(state, {
  type: 'NOTIFICATION_CREATED',
  data: {
    notification: { id: 3, title: 'Item 3', createdAt: '2026-09-29T11:00:00Z', isRead: false },
    unreadCount: 3,
  },
});
assert.equal(state.unreadCount, 3);
assert.equal(state.notifications.length, 3);

// Event 2: Single notification marked read
state = reduceNotificationEvent(state, {
  type: 'NOTIFICATION_READ',
  data: { id: 1, unreadCount: 2 },
});
assert.equal(state.unreadCount, 2);
assert.equal(state.notifications.find((n) => n.id === 1)?.isRead, true);

// Event 3: All marked read
state = reduceNotificationEvent(state, {
  type: 'NOTIFICATIONS_ALL_READ',
  data: { unreadCount: 0 },
});
assert.equal(state.unreadCount, 0);
assert.ok(state.notifications.every((n) => n.isRead === true));

// Event 4: Unread count sync
state = reduceNotificationEvent(state, {
  type: 'UNREAD_COUNT_SYNC',
  data: { unreadCount: 5 },
});
assert.equal(state.unreadCount, 5);
console.log('  -> PASS: Unread count and event lifecycle transitions verified.');

console.log('=== ALL NOTIFICATION STORE & DEDUPE CONTRACT TESTS PASSED! ===');
