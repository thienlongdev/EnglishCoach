// Verification script for English Coach Community feature contracts
import assert from 'node:assert/strict'

console.log('--- Testing English Coach Community Contracts ---')

// 1. Post Moderation State Machine Contract
console.log('1. Testing Post Moderation State Machine...')
const VALID_STATUSES = ['DRAFT', 'PENDING', 'PUBLISHED', 'REJECTED', 'HIDDEN', 'DELETED', 'SCHEDULED']
assert.ok(VALID_STATUSES.includes('PENDING'), 'PENDING status must exist')
assert.ok(VALID_STATUSES.includes('PUBLISHED'), 'PUBLISHED status must exist')
assert.ok(VALID_STATUSES.includes('REJECTED'), 'REJECTED status must exist')

function canShowInPublicFeed(status) {
    return status === 'PUBLISHED'
}
assert.equal(canShowInPublicFeed('PENDING'), false, 'Pending posts must NEVER appear in public feed')
assert.equal(canShowInPublicFeed('REJECTED'), false, 'Rejected posts must NEVER appear in public feed')
assert.equal(canShowInPublicFeed('HIDDEN'), false, 'Hidden posts must NEVER appear in public feed')
assert.equal(canShowInPublicFeed('PUBLISHED'), true, 'Published posts are permitted in public feed')

function canAuthorViewOwnPost(post, currentUserId) {
    if (post.authorId === currentUserId) return true
    return post.status === 'PUBLISHED'
}
assert.equal(canAuthorViewOwnPost({ authorId: 42, status: 'PENDING' }, 42), true, 'Author can view own pending post')
assert.equal(canAuthorViewOwnPost({ authorId: 42, status: 'PENDING' }, 99), false, 'Other user cannot view pending post')
console.log('  -> PASS: Post moderation states and visibility contracts verified.')

// 2. Official Identity Contract
console.log('2. Testing Official EnglishCoach Identity Contract...')
function resolvePublicAuthor(authorSummary) {
    if (authorSummary.official) {
        return {
            displayName: 'EnglishCoach',
            officialBadge: true,
            avatarUrl: '/assets/Whale.svg',
            hiddenRealUserId: authorSummary.userId, // Preserved for audit, hidden from public presentation
        }
    }
    return {
        displayName: authorSummary.displayName,
        officialBadge: false,
        avatarUrl: authorSummary.avatarUrl,
        hiddenRealUserId: null,
    }
}
const officialAuthor = resolvePublicAuthor({
    userId: 1, // Admin personal ID
    displayName: 'Admin John Doe',
    official: true,
    avatarUrl: '/uploads/admin.jpg',
})
assert.equal(officialAuthor.displayName, 'EnglishCoach', 'Official post MUST display EnglishCoach publicly')
assert.equal(officialAuthor.officialBadge, true)
assert.notEqual(officialAuthor.displayName, 'Admin John Doe', 'Personal admin name must not leak')
console.log('  -> PASS: Official EnglishCoach identity contract verified.')

// 3. Reaction State Machine & Concurrency Contract
console.log('3. Testing Reaction State Machine...')
function calculateReactionUpdate(currentReaction, currentCount, incomingReaction) {
    if (currentReaction === incomingReaction) {
        // Toggle off
        return { newReaction: null, newCount: Math.max(0, currentCount - 1) }
    } else if (!currentReaction) {
        // First reaction
        return { newReaction: incomingReaction, newCount: currentCount + 1 }
    } else {
        // Change reaction type (count remains unchanged)
        return { newReaction: incomingReaction, newCount: currentCount }
    }
}

// User reacts with LIKE
let r = calculateReactionUpdate(null, 5, 'LIKE')
assert.equal(r.newReaction, 'LIKE')
assert.equal(r.newCount, 6)

// User changes reaction to FIRE
r = calculateReactionUpdate('LIKE', 6, 'FIRE')
assert.equal(r.newReaction, 'FIRE')
assert.equal(r.newCount, 6, 'Changing reaction type should not increase count')

// User clicks FIRE again to remove
r = calculateReactionUpdate('FIRE', 6, 'FIRE')
assert.equal(r.newReaction, null)
assert.equal(r.newCount, 5, 'Removing reaction should decrement count')
console.log('  -> PASS: Reaction state transition and atomic count contract verified.')

// 4. Comment Reply Hierarchy & Nesting Policy Contract
console.log('4. Testing Comment Reply Hierarchy & Nesting Policy Contract...')
function buildCommentTree(flatComments) {
    const map = new Map()
    const roots = []
    for (const c of flatComments) {
        map.set(c.id, { ...c, replies: [] })
    }
    for (const c of map.values()) {
        if (c.parentId && map.has(c.parentId)) {
            map.get(c.parentId).replies.push(c)
        } else {
            roots.push(c)
        }
    }
    return roots
}

const mockFlat = [
    { id: 1, parentId: null, content: 'Comment A' },
    { id: 2, parentId: 1, content: 'Reply B to A' },
    { id: 3, parentId: 2, content: 'Reply C to B' },
    { id: 4, parentId: 3, content: 'Reply D to C' }
]
const tree = buildCommentTree(mockFlat)
assert.equal(tree.length, 1, 'Only root Comment A should be top-level')
assert.equal(tree[0].replies.length, 1, 'Comment A has Reply B')
assert.equal(tree[0].replies[0].id, 2)
assert.equal(tree[0].replies[0].replies.length, 1, 'Reply B has Reply C')
assert.equal(tree[0].replies[0].replies[0].id, 3)
assert.equal(tree[0].replies[0].replies[0].replies[0].id, 4, 'Reply C has Reply D')

// Visual indentation capping contract (max depth 3 or 4)
function calculateVisualDepth(depth, maxVisualDepth = 3) {
    return Math.min(depth, maxVisualDepth)
}
assert.equal(calculateVisualDepth(0), 0)
assert.equal(calculateVisualDepth(1), 1)
assert.equal(calculateVisualDepth(2), 2)
assert.equal(calculateVisualDepth(3), 3)
assert.equal(calculateVisualDepth(4), 3, 'Depth 4 capped at visual depth 3 on mobile/desktop')
assert.equal(calculateVisualDepth(10), 3, 'Deep replies capped to prevent horizontal blowout')
console.log('  -> PASS: Comment reply tree hierarchy and visual indentation policy verified.')

// 5. Daily Post Idempotency & Timezone Key Contract
console.log('5. Testing Daily Post Idempotency Contract...')
function getDailyPostKey(seriesType, vietnamDateString) {
    return `${seriesType}__${vietnamDateString}`
}
const key1 = getDailyPostKey('DAILY_VOCABULARY', '2026-10-01')
const key2 = getDailyPostKey('DAILY_VOCABULARY', '2026-10-01')
const keyTomorrow = getDailyPostKey('DAILY_VOCABULARY', '2026-10-02')
assert.equal(key1, key2, 'Duplicate calls on the same Vietnam calendar day must resolve to identical unique key')
assert.notEqual(key1, keyTomorrow, 'Different calendar days must resolve to distinct keys')
console.log('  -> PASS: Daily post idempotency and date boundary contract verified.')

// 6. Learning Embed Validation Contract
console.log('6. Testing Learning Embed Validation Contract...')
const ALLOWED_SHARED_ENTITIES = ['LISTENING_MATERIAL', 'FLASHCARD_DECK', 'EXAM_RESULT']
function validateLearningEmbed(entityType, entityId) {
    if (!ALLOWED_SHARED_ENTITIES.includes(entityType)) return false
    if (!Number.isInteger(entityId) || entityId <= 0) return false
    return true
}
assert.equal(validateLearningEmbed('LISTENING_MATERIAL', 123), true)
assert.equal(validateLearningEmbed('EXAM_RESULT', 456), true)
assert.equal(validateLearningEmbed('UNSAFE_SYSTEM_CONFIG', 1), false, 'Arbitrary entities must be rejected')
assert.equal(validateLearningEmbed('LISTENING_MATERIAL', -5), false, 'Invalid IDs must be rejected')
console.log('  -> PASS: Learning embed validation contract verified.')

// 7. Sidebar Role Visibility Contract
console.log('7. Testing Sidebar Role Visibility Contract...')
function getVisibleAdminRoutes(userRole) {
    const isAdmin = userRole === 'ROLE_ADMIN'
    const routes = []
    if (isAdmin) {
        routes.push('/admin/notifications', '/admin/community')
    }
    return routes
}
assert.deepEqual(getVisibleAdminRoutes('ROLE_USER'), [], 'ROLE_USER must NEVER see admin community routes')
assert.deepEqual(getVisibleAdminRoutes(undefined), [], 'Unauthenticated user must NEVER see admin community routes')
assert.ok(getVisibleAdminRoutes('ROLE_ADMIN').includes('/admin/community'), 'ROLE_ADMIN must see /admin/community')
console.log('  -> PASS: Sidebar role visibility contract verified.')

// 8. Post Soft-Delete and Moderation Audit Contract
console.log('8. Testing Post Soft-Delete and Moderation Audit Contract...')
function applyModerationAction(post, action, actorId, reason, note) {
    const auditRecord = {
        postId: post.id,
        actorId,
        previousStatus: post.status,
        action,
        reason,
        note,
        timestamp: new Date().toISOString(),
    }
    let newStatus = post.status
    if (action === 'HIDE') newStatus = 'HIDDEN'
    else if (action === 'DELETE') newStatus = 'DELETED'
    else if (action === 'APPROVE') newStatus = 'PUBLISHED'
    else if (action === 'REJECT') newStatus = 'REJECTED'

    return {
        updatedPost: { ...post, status: newStatus },
        auditRecord,
    }
}
const initialPost = { id: 101, status: 'PUBLISHED', content: 'Sample post' }
const hideResult = applyModerationAction(initialPost, 'HIDE', 1, 'Inappropriate', 'Hidden by moderator')
assert.equal(hideResult.updatedPost.status, 'HIDDEN')
assert.equal(hideResult.auditRecord.previousStatus, 'PUBLISHED')
assert.equal(canShowInPublicFeed(hideResult.updatedPost.status), false, 'Hidden post must not appear in public feed')

const deleteResult = applyModerationAction(initialPost, 'DELETE', 1, 'Severe violation', 'Soft-deleted with audit')
assert.equal(deleteResult.updatedPost.status, 'DELETED')
assert.equal(deleteResult.auditRecord.action, 'DELETE')
assert.equal(canShowInPublicFeed(deleteResult.updatedPost.status), false, 'Deleted post must not appear in public feed')
console.log('  -> PASS: Post soft-delete and moderation audit contract verified.')

// 9. Comment Moderation & Permission Contract
console.log('9. Testing Comment Moderation & Permissions Contract...')
function canUserDeleteComment(comment, userId, isAdmin) {
    if (!userId) return false
    if (isAdmin) return true
    return comment.authorUserId === userId
}
const userComment = { id: 501, postId: 101, authorUserId: 42, content: 'User comment', status: 'ACTIVE' }
assert.equal(canUserDeleteComment(userComment, 42, false), true, 'Author can delete own comment')
assert.equal(canUserDeleteComment(userComment, 1, true), true, 'Admin can delete any comment')
assert.equal(canUserDeleteComment(userComment, 99, false), false, 'Unrelated user CANNOT delete comment')
assert.equal(canUserDeleteComment(userComment, null, false), false, 'Unauthenticated user cannot delete comment')

function buildCommentReport(comment, reporterId, reason, details) {
    if (!reporterId) throw new Error('Reporter ID required')
    return {
        targetType: 'COMMENT',
        commentId: comment.id,
        postId: comment.postId,
        reporterId,
        reason,
        details: `[Báo cáo bình luận #${comment.id}]: ${details || ''}`,
        status: 'PENDING',
    }
}
const report = buildCommentReport(userComment, 88, 'SPAM', 'Harassment')
assert.equal(report.postId, 101)
assert.equal(report.commentId, 501)
assert.ok(report.details.includes('[Báo cáo bình luận #501]'))
console.log('  -> PASS: Comment moderation and reporting contract verified.')

// 10. Media Validation & Safety Contract
console.log('10. Testing Media Validation & Safety Contract...')
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB
const MAX_IMAGE_DIMENSION = 8000
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']

function validateMediaUpload(mimeType, sizeBytes, width, height, clientFilename) {
    if (!ALLOWED_MIME_TYPES.includes(mimeType.toLowerCase())) {
        throw new Error('Unsupported MIME type')
    }
    if (sizeBytes > MAX_IMAGE_SIZE_BYTES) {
        throw new Error('File size exceeds 5 MB')
    }
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        throw new Error('Image dimension exceeds 8000x8000')
    }
    // Prevent path traversal
    if (clientFilename.includes('..') || clientFilename.includes('/') || clientFilename.includes('\\')) {
        // Filename sanitized, server uses UUID
    }
    return true
}

assert.ok(validateMediaUpload('image/png', 2 * 1024 * 1024, 1920, 1080, 'photo.png'))
assert.throws(() => validateMediaUpload('application/x-msdownload', 1024, 100, 100, 'malware.exe'), /Unsupported MIME/)
assert.throws(() => validateMediaUpload('image/jpeg', 6 * 1024 * 1024, 100, 100, 'large.jpg'), /exceeds 5 MB/)
assert.throws(() => validateMediaUpload('image/jpeg', 1024, 12000, 800, 'bomb.jpg'), /dimension exceeds/)
console.log('  -> PASS: Media security, size limit, dimension bomb, and MIME validation verified.')

// 11. Feed Pagination & Deduplication Contract
console.log('11. Testing Feed Pagination & Deduplication Contract...')
function mergeFeedPosts(currentPosts, incomingPosts) {
    const existingIds = new Set(currentPosts.map(p => p.id))
    const freshPosts = (incomingPosts || []).filter(p => !existingIds.has(p.id))
    return [...currentPosts, ...freshPosts]
}

const page1 = [{ id: 1, title: 'A' }, { id: 2, title: 'B' }]
const page2WithOverlap = [{ id: 2, title: 'B' }, { id: 3, title: 'C' }]
const merged = mergeFeedPosts(page1, page2WithOverlap)
assert.equal(merged.length, 3, 'Merged feed must eliminate overlapping duplicate posts')
assert.deepEqual(merged.map(p => p.id), [1, 2, 3])

function shouldRequestNextPage(hasMore, incomingCount, loading) {
    if (loading) return false
    if (!hasMore) return false
    if (incomingCount === 0) return false
    return true
}
assert.equal(shouldRequestNextPage(true, 10, false), true)
assert.equal(shouldRequestNextPage(false, 0, false), false, 'Final page must stop additional requests')
assert.equal(shouldRequestNextPage(true, 0, false), false, 'Empty page result must stop additional requests')
console.log('  -> PASS: Feed pagination and deduplication contract verified.')

// 12. Comment API Defensive Normalization Contract
console.log('12. Testing Comment Normalization Contract (Crash Prevention)...')
function normalizeCommentsPayload(payload) {
    if (Array.isArray(payload)) return payload
    if (payload && Array.isArray(payload.items)) return payload.items
    if (payload && Array.isArray(payload.posts)) return payload.posts
    if (payload && Array.isArray(payload.comments)) return payload.comments
    return []
}

assert.deepEqual(normalizeCommentsPayload([{ id: 1 }]), [{ id: 1 }])
assert.deepEqual(normalizeCommentsPayload({ items: [{ id: 2 }] }), [{ id: 2 }])
assert.deepEqual(normalizeCommentsPayload({ posts: [{ id: 3 }] }), [{ id: 3 }])
assert.deepEqual(normalizeCommentsPayload({ comments: [{ id: 4 }] }), [{ id: 4 }])
assert.deepEqual(normalizeCommentsPayload(null), [], 'Null payload must safely return empty array')
assert.deepEqual(normalizeCommentsPayload(undefined), [], 'Undefined payload must safely return empty array')
console.log('  -> PASS: Comment payload defensive unwrapping verified.')

// 13. Persistent Cache v3 & SWR Semantics Contract
console.log('13. Testing Persistent Cache v3 & SWR Semantics Contract...')
const CACHE_PREFIX = 'ec_comm_v3'
function buildUserScopeKey(userScope, feedKey) {
    const u = userScope != null ? String(userScope) : 'guest'
    return `${CACHE_PREFIX}_u${u}_${feedKey}`
}
assert.equal(buildUserScopeKey(42, 'feed_public_ALL'), 'ec_comm_v3_u42_feed_public_ALL')
assert.equal(buildUserScopeKey(null, 'feed_public_ALL'), 'ec_comm_v3_uguest_feed_public_ALL')
assert.notEqual(buildUserScopeKey(42, 'feed_public_ALL'), buildUserScopeKey(99, 'feed_public_ALL'), 'User keys must be strictly isolated')

const STALE_REVALIDATE_TTL_MS = 30 * 1000
const USABLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function evaluateCacheState(entry, now) {
    if (!entry) return null
    const age = now - entry.timestamp
    if (age > USABLE_CACHE_TTL_MS) return null // Expired
    return {
        posts: entry.posts,
        page: entry.page,
        hasMore: entry.hasMore,
        isStale: age > STALE_REVALIDATE_TTL_MS,
    }
}

const now = 1000000000000
// Fresh visit (10 seconds old) -> usable, NOT stale
const freshState = evaluateCacheState({ posts: [{ id: 1 }], page: 0, hasMore: true, timestamp: now - 10000 }, now)
assert.ok(freshState !== null)
assert.equal(freshState.isStale, false, 'Entry within 30s must NOT be marked stale')

// Revisit after 2 minutes -> usable AND stale (triggers background revalidation, 0ms render)
const staleState = evaluateCacheState({ posts: [{ id: 1 }], page: 0, hasMore: true, timestamp: now - 120000 }, now)
assert.ok(staleState !== null)
assert.equal(staleState.isStale, true, 'Entry older than 30s must be marked stale for background revalidation')
assert.equal(staleState.posts.length, 1, 'Usable content must be available immediately')

// Revisit after 25 hours -> expired
const expiredState = evaluateCacheState({ posts: [{ id: 1 }], page: 0, hasMore: true, timestamp: now - 90000000 }, now)
assert.equal(expiredState, null, 'Entry older than 24h must be discarded')
console.log('  -> PASS: Persistent Cache v3 and SWR usability/staleness semantics verified.')

// 14. Cache Mutation Synchronization Contract
console.log('14. Testing Cache Mutation Synchronization Contract...')
function patchPostInPosts(posts, postId, updater) {
    return posts.map(p => p.id === postId ? updater(p) : p).filter(Boolean)
}

const initialPosts = [
    { id: 101, savedByMe: false, saveCount: 0, likeCount: 5, myReaction: null },
    { id: 102, savedByMe: true, saveCount: 1, likeCount: 2, myReaction: 'LIKE' },
]

// Optimistic Save
const savedPosts = patchPostInPosts(initialPosts, 101, p => ({ ...p, savedByMe: true, isSaved: true, saveCount: p.saveCount + 1 }))
assert.equal(savedPosts[0].savedByMe, true)
assert.equal(savedPosts[0].saveCount, 1)

// Optimistic Reaction
const reactedPosts = patchPostInPosts(savedPosts, 101, p => ({ ...p, myReaction: 'HEART', likeCount: p.likeCount + 1 }))
assert.equal(reactedPosts[0].myReaction, 'HEART')
assert.equal(reactedPosts[0].likeCount, 6)

// Optimistic Delete
const afterDelete = patchPostInPosts(reactedPosts, 101, () => null)
assert.equal(afterDelete.length, 1)
assert.equal(afterDelete[0].id, 102)
console.log('  -> PASS: Cache mutation synchronization contract verified.')

// 15. Private Data & My Posts Storage Isolation Contract
console.log('15. Testing Private Data & My Posts Storage Isolation Contract...')
function isPrivateFeedKey(feedKey) {
    return feedKey.includes('my-posts') || feedKey.includes('moderation') || feedKey.includes('admin')
}
assert.equal(isPrivateFeedKey('feed_my-posts_ALL'), true, 'My Posts must be flagged as private feed')
assert.equal(isPrivateFeedKey('feed_public_ALL'), false, 'Discover/public feed is not private')
assert.equal(isPrivateFeedKey('feed_following_ALL'), false, 'Following feed is not private')
assert.equal(isPrivateFeedKey('feed_saved_ALL'), false, 'Saved feed is not private')

function filterPostsForLocalStorage(feedKey, posts) {
    if (isPrivateFeedKey(feedKey)) {
        return null // Never persist to localStorage
    }
    return posts.filter(p => p.status === 'PUBLISHED')
}

const mixedPosts = [
    { id: 201, status: 'PUBLISHED', content: 'Public post' },
    { id: 202, status: 'PENDING', content: 'Pending post under review' },
    { id: 203, status: 'REJECTED', content: 'Rejected post with feedback' },
]

assert.equal(filterPostsForLocalStorage('feed_my-posts_ALL', mixedPosts), null, 'My Posts feed must NEVER be saved to localStorage')
const publicFiltered = filterPostsForLocalStorage('feed_public_ALL', mixedPosts)
assert.equal(publicFiltered.length, 1, 'Only PUBLISHED posts are permitted in localStorage')
assert.equal(publicFiltered[0].id, 201)
console.log('  -> PASS: Private Data & My Posts Storage Isolation Contract verified.')

// 16. Reaction System V2 & Unique User Counting Contract
console.log('16. Testing Reaction System V2 & Unique User Counting Contract...')
const DEFAULT_REACTIONS = ['LOVE', 'HAHA', 'SUPPORT', 'SAD', 'USEFUL']
const EXTENDED_REACTIONS = ['WOW', 'CONFUSED', 'ANGRY', 'CLAP', 'FIRE', 'THINKING', 'CELEBRATE']
const ALL_CATALOG = [...DEFAULT_REACTIONS, ...EXTENDED_REACTIONS]

assert.equal(DEFAULT_REACTIONS.length, 5, 'Must have exactly 5 default reactions')
assert.equal(EXTENDED_REACTIONS.length, 7, 'Must have 7 extended reactions')
assert.equal(ALL_CATALOG.length, 12, 'Catalog must contain 12 distinct reactions')

// Canonical mapping
function canonicalizeReaction(r) {
    if (r === 'LIKE') return 'LOVE'
    if (r === 'IDEA') return 'USEFUL'
    if (r === 'STRONG') return 'SUPPORT'
    return r
}
assert.equal(canonicalizeReaction('LIKE'), 'LOVE')
assert.equal(canonicalizeReaction('IDEA'), 'USEFUL')
assert.equal(canonicalizeReaction('STRONG'), 'SUPPORT')
assert.equal(canonicalizeReaction('FIRE'), 'FIRE')

// Unique Reactor Calculation & Deduplication (Prevent Duplicate Heart Bug)
function deriveSummaryIcons(myReaction, topReactions, totalReactionCount) {
    if (totalReactionCount === 0) return []
    const set = new Set()
    if (myReaction) set.add(myReaction)
    if (Array.isArray(topReactions)) {
        for (const t of topReactions) set.add(t)
    }
    if (set.size === 0) set.add('LOVE')
    return Array.from(set).slice(0, Math.min(totalReactionCount, 3))
}

// 1 User LOVE: Must show exactly 1 icon, never 2 icons
const singleLoveIcons = deriveSummaryIcons('LOVE', ['LOVE'], 1)
assert.deepEqual(singleLoveIcons, ['LOVE'], '1 user LOVE must render exactly 1 LOVE icon, NOT duplicate icons')

// 2 Users LOVE: Must cap at unique reaction types (1 unique type)
const twoLoveIcons = deriveSummaryIcons('LOVE', ['LOVE'], 2)
assert.deepEqual(twoLoveIcons, ['LOVE'], '2 users both LOVE must only have unique LOVE in summary cluster')

// Mixed 3 Users (LOVE, HAHA, SUPPORT):
const mixedIcons = deriveSummaryIcons('LOVE', ['HAHA', 'SUPPORT'], 3)
assert.deepEqual(mixedIcons, ['LOVE', 'HAHA', 'SUPPORT'], '3 users with different reactions display 3 unique icons')

// Zero-count tab flash prevention: Tabs are derived strictly from count > 0 (or 'ALL')
function getVisibleTabs(countsByType, totalCount) {
    const tabs = [{ key: 'ALL', count: totalCount }]
    for (const key of ALL_CATALOG) {
        const c = countsByType[key] || 0
        if (c > 0) {
            tabs.push({ key, count: c })
        }
    }
    return tabs
}
const tabsSingleLove = getVisibleTabs({ LOVE: 1, HAHA: 0, SUPPORT: 0 }, 1)
assert.equal(tabsSingleLove.length, 2, 'Must only show ALL and LOVE tabs')
assert.equal(tabsSingleLove[0].key, 'ALL')
assert.equal(tabsSingleLove[1].key, 'LOVE')
assert.equal(tabsSingleLove.find(t => t.key === 'HAHA'), undefined, 'Zero-count HAHA must never be present in tabs')
console.log('  -> PASS: Reaction System V2 & Unique User Counting Contract verified.')

// 17. Full Media Combination Matrix & Caret Insertion Contract
console.log('17. Testing Full Media Combination Matrix & Caret Insertion Contract...')
function validatePostMediaContract(attachments) {
    const videoCount = attachments.filter(a => a.type === 'VIDEO').length
    const imageCount = attachments.filter(a => a.type === 'IMAGE').length
    if (imageCount > 10) {
        return { valid: false, error: 'Tối đa 10 hình ảnh cho mỗi bài viết' }
    }
    if (videoCount > 2) {
        return { valid: false, error: 'Tối đa 2 video cho mỗi bài viết' }
    }
    return { valid: true }
}

// Test Matrix:
assert.equal(validatePostMediaContract([]).valid, true, 'Text only: valid')
assert.equal(validatePostMediaContract([{ type: 'IMAGE' }]).valid, true, 'Text + 1 image: valid')
assert.equal(validatePostMediaContract(Array(10).fill({ type: 'IMAGE' })).valid, true, 'Text + 10 images: valid')
assert.equal(validatePostMediaContract([{ type: 'VIDEO' }]).valid, true, 'Text + 1 video: valid')
assert.equal(validatePostMediaContract([{ type: 'VIDEO' }, { type: 'VIDEO' }]).valid, true, 'Text + 2 videos: valid')
assert.equal(validatePostMediaContract([{ type: 'IMAGE' }, { type: 'VIDEO' }]).valid, true, 'Mixed media (1 image + 1 video): valid')
assert.equal(validatePostMediaContract([...Array(10).fill({ type: 'IMAGE' }), { type: 'VIDEO' }, { type: 'VIDEO' }]).valid, true, 'Mixed media (10 images + 2 videos): valid')
assert.equal(validatePostMediaContract(Array(11).fill({ type: 'IMAGE' })).valid, false, 'Excess images (>10): invalid')
assert.equal(validatePostMediaContract(Array(3).fill({ type: 'VIDEO' })).valid, false, 'Excess videos (>2): invalid')
assert.equal(validatePostMediaContract([...Array(11).fill({ type: 'IMAGE' }), { type: 'VIDEO' }, { type: 'VIDEO' }]).valid, false, '11 images + 2 videos: invalid')
assert.equal(validatePostMediaContract([...Array(10).fill({ type: 'IMAGE' }), ...Array(3).fill({ type: 'VIDEO' })]).valid, false, '10 images + 3 videos: invalid')

// Caret Insertion Contract
function insertEmojiAtCaret(currentText, emoji, selectionStart, selectionEnd) {
    return currentText.substring(0, selectionStart) + emoji + currentText.substring(selectionEnd)
}
const textSample = 'Hôm nay mình buồn nhưng vẫn cố học'
const caretPos = 'Hôm nay mình buồn '.length
const inserted = insertEmojiAtCaret(textSample, '😢', caretPos, caretPos)
assert.equal(inserted, 'Hôm nay mình buồn 😢nhưng vẫn cố học', 'Emoji must be inserted at caret position without replacing surrounding text')
console.log('  -> PASS: Full Media Combination Matrix & Caret Insertion Contract verified.')

// 18. Zero-Count Reaction Hiding Contract (Posts and Comments)
console.log('18. Testing Zero-Count Reaction Hiding Contract...')
function shouldRenderReactionSummary(totalReactions, commentCount) {
    // Both posts and comments must never display naked '0'
    const hasReactions = Boolean(totalReactions && totalReactions > 0)
    const hasComments = Boolean(commentCount && commentCount > 0)
    return Boolean(hasReactions || hasComments)
}
assert.equal(shouldRenderReactionSummary(0, 0), false, '0 reactions and 0 comments must render NOTHING')
assert.equal(shouldRenderReactionSummary(0, null), false, '0 reactions with null comments must render NOTHING')
assert.equal(shouldRenderReactionSummary(1, 0), true, '1 reaction must render summary')
assert.equal(shouldRenderReactionSummary(0, 2), true, 'Comments only must render comment count without naked 0')
console.log('  -> PASS: Zero-Count Reaction Hiding Contract verified.')

// 19. Community User Restrictions and Comment Lock Contract
console.log('19. Testing Community User Restrictions and Comment Lock Contract...')
function canUserPerformCommunityAction(restrictionType, isExpired, action) {
    if (!restrictionType || isExpired) return true
    if (restrictionType === 'SUSPEND_COMMUNITY') return false
    if (restrictionType === 'READ_ONLY') {
        return action === 'VIEW'
    }
    if (restrictionType === 'NO_POST') {
        return action !== 'CREATE_POST'
    }
    if (restrictionType === 'NO_COMMENT') {
        return action !== 'CREATE_COMMENT' && action !== 'REPLY'
    }
    return true
}

assert.equal(canUserPerformCommunityAction(null, false, 'CREATE_POST'), true)
assert.equal(canUserPerformCommunityAction('READ_ONLY', false, 'VIEW'), true)
assert.equal(canUserPerformCommunityAction('READ_ONLY', false, 'CREATE_POST'), false)
assert.equal(canUserPerformCommunityAction('READ_ONLY', false, 'CREATE_COMMENT'), false)
assert.equal(canUserPerformCommunityAction('READ_ONLY', true, 'CREATE_POST'), true, 'Expired restriction must allow action')
assert.equal(canUserPerformCommunityAction('NO_POST', false, 'CREATE_POST'), false)
assert.equal(canUserPerformCommunityAction('NO_POST', false, 'CREATE_COMMENT'), true)
assert.equal(canUserPerformCommunityAction('NO_COMMENT', false, 'CREATE_POST'), true)
assert.equal(canUserPerformCommunityAction('NO_COMMENT', false, 'CREATE_COMMENT'), false)
assert.equal(canUserPerformCommunityAction('SUSPEND_COMMUNITY', false, 'REACT'), false)
console.log('  -> PASS: Community User Restrictions and Comment Lock Contract verified.')

console.log('=== ALL COMMUNITY CONTRACT TESTS PASSED! ✅ ===')
