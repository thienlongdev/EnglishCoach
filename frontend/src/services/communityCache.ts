/**
 * Community Social UX V3 — Safe User-Scoped Persistent Cache Engine
 * 
 * Features & Invariants:
 * 1. PERSISTENT HYDRATION: Uses localStorage for safe, public/published feeds (Discover, Following, Saved)
 *    to survive F5, tab closures, and browser restarts (0ms render + 30s background revalidate).
 * 2. PRIVACY & SENSITIVE DATA ISOLATION:
 *    - "My Posts" (`feed_my-posts_*`) often contains PENDING, REJECTED, and moderation feedback.
 *      It is strictly MEMORY- and SESSION-SCOPED. It is NEVER written to 24h localStorage.
 *    - Any post with status !== 'PUBLISHED' is stripped before writing to long-lived localStorage.
 *    - Admin and moderation payloads are strictly excluded from long-lived localStorage.
 * 3. STRICTLY USER-SCOPED: Keys follow `ec_comm_v3_u<userId>_<feedKey>`. No cross-account leakage.
 * 4. COMPLETE LOGOUT PURGE: Cleared on logout / account switch via clearCommunityUserCache() and
 *    auth-cache-cleanup.ts across all storage layers.
 * 5. MUTATION-SYNCHRONIZED: Optimistic reactions, saves, comments, and deletes patch BOTH in-memory
 *    state and persistent localStorage. No resurrection of stale state on reload.
 * 6. VERSION MIGRATION: Incompatible v1, v2, and any stale private keys are purged automatically on initialization.
 */

import { CommunityPost, CommunityFeedPage, ReactionType, Comment } from '@/types/community'
import { buildCommentTree } from './communityApi'

export interface CachedFeedState {
    posts: CommunityPost[]
    page: number
    hasMore: boolean
    timestamp: number
    scrollPosition?: number
    isStale?: boolean
}

const CACHE_PREFIX = 'ec_comm_v3'
const LEGACY_PREFIXES = ['ec_comm_v1', 'ec_comm_v2']
const IN_MEMORY_FEED_CACHE = new Map<string, CachedFeedState>()
const IN_FLIGHT_REQUESTS = new Map<string, Promise<CommunityFeedPage>>()
let requestGeneration = 0

// Freshness & Usability thresholds
export const STALE_REVALIDATE_TTL_MS = 30 * 1000 // 30 seconds stale window before background revalidation
export const USABLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours usable window for public instant hydration

const TAB_STORAGE_KEY = 'ec_comm_v3_tab'
const SCROLL_STORAGE_KEY = 'ec_comm_v3_scroll'
const SCROLL_Y_KEY = 'ec_comm_v3_scrollY'

/**
 * Determines whether a feed is private/author-specific (such as My Posts, moderation, or draft).
 * Private feeds must NEVER be stored in long-lived localStorage to prevent stale PENDING/REJECTED
 * states from leaking across sessions. They are strictly memory/session-scoped.
 */
export function isPrivateFeedKey(feedKey: string): boolean {
    return feedKey.includes('my-posts') || feedKey.includes('moderation') || feedKey.includes('admin')
}

/**
 * Safe localStorage accessor.
 */
function safeGetLocalStorage(): Storage | null {
    if (typeof window === 'undefined') return null
    try {
        const testKey = '__ec_ls_test__'
        window.localStorage.setItem(testKey, '1')
        window.localStorage.removeItem(testKey)
        return window.localStorage
    } catch {
        return null
    }
}

/**
 * Safe sessionStorage accessor.
 */
function safeGetSessionStorage(): Storage | null {
    if (typeof window === 'undefined') return null
    try {
        const testKey = '__ec_ss_test__'
        window.sessionStorage.setItem(testKey, '1')
        window.sessionStorage.removeItem(testKey)
        return window.sessionStorage
    } catch {
        return null
    }
}

/**
 * Safe storage accessor returning best available persistent storage.
 */
function safeGetStorage(): Storage | null {
    return safeGetLocalStorage() || safeGetSessionStorage()
}

/**
 * Automatically sweeps and removes legacy/incompatible v1 & v2 cache entries,
 * and ensures no private 'my-posts' keys remain in long-lived localStorage.
 */
function cleanupLegacyCaches(): void {
    if (typeof window === 'undefined') return
    const ls = safeGetLocalStorage()
    const ss = safeGetSessionStorage()

    if (ls) {
        try {
            const keysToRemove: string[] = []
            for (let i = 0; i < ls.length; i++) {
                const k = ls.key(i)
                if (k) {
                    if (
                        LEGACY_PREFIXES.some((p) => k.startsWith(p)) ||
                        k === 'ec_comm_active_tab' ||
                        k === 'ec_comm_session_scroll' ||
                        // CRITICAL: Ensure no private 'my-posts' keys linger in long-lived localStorage
                        (k.startsWith(CACHE_PREFIX) && isPrivateFeedKey(k))
                    ) {
                        keysToRemove.push(k)
                    }
                }
            }
            keysToRemove.forEach((k) => ls.removeItem(k))
        } catch (e) {
            console.debug('[CommunityCache] localStorage cleanup error', e)
        }
    }

    if (ss) {
        try {
            const keysToRemove: string[] = []
            for (let i = 0; i < ss.length; i++) {
                const k = ss.key(i)
                if (k && (LEGACY_PREFIXES.some((p) => k.startsWith(p)) || k === 'ec_comm_active_tab' || k === 'ec_comm_session_scroll')) {
                    keysToRemove.push(k)
                }
            }
            keysToRemove.forEach((k) => ss.removeItem(k))
        } catch (e) {
            console.debug('[CommunityCache] sessionStorage cleanup error', e)
        }
    }
}

// Run legacy cleanup once on client load
if (typeof window !== 'undefined') {
    try {
        cleanupLegacyCaches()
    } catch {}
}

/**
 * Builds a strictly user-scoped cache key.
 */
export function buildUserScopeKey(userScope: string | number | null | undefined, feedKey: string): string {
    const u = userScope != null ? String(userScope) : 'guest'
    return `${CACHE_PREFIX}_u${u}_${feedKey}`
}

/**
 * Retrieves cached feed state.
 * - For private feeds (My Posts): reads from memory or sessionStorage only (never 24h localStorage).
 * - For public feeds (Discover, Following, Saved): hydrates from localStorage for 0ms reopen render.
 */
export function getCachedFeed(
    userScope: string | number | null | undefined,
    feedKey: string
): CachedFeedState | null {
    const fullKey = buildUserScopeKey(userScope, feedKey)
    const now = Date.now()
    const isPrivate = isPrivateFeedKey(feedKey)

    // 1. Check in-memory fast cache first
    const mem = IN_MEMORY_FEED_CACHE.get(fullKey)
    if (mem) {
        const maxAge = isPrivate ? STALE_REVALIDATE_TTL_MS : USABLE_CACHE_TTL_MS
        if (now - mem.timestamp < maxAge) {
            return {
                ...mem,
                isStale: now - mem.timestamp > STALE_REVALIDATE_TTL_MS,
            }
        }
    }

    // 2. For private feeds (My Posts): read from sessionStorage only (within active tab session)
    if (isPrivate) {
        const ss = safeGetSessionStorage()
        if (ss) {
            try {
                const raw = ss.getItem(fullKey)
                if (raw) {
                    const parsed = JSON.parse(raw) as CachedFeedState
                    if (parsed && Array.isArray(parsed.posts)) {
                        const stateWithStale: CachedFeedState = {
                            ...parsed,
                            isStale: now - parsed.timestamp > STALE_REVALIDATE_TTL_MS,
                        }
                        IN_MEMORY_FEED_CACHE.set(fullKey, parsed)
                        return stateWithStale
                    }
                }
            } catch {}
        }
        return mem || null
    }

    // 3. For public feeds (Discover, Following, Saved): hydrate from localStorage
    const ls = safeGetLocalStorage()
    if (!ls) {
        return mem || null
    }

    try {
        const raw = ls.getItem(fullKey)
        if (!raw) return mem || null
        const parsed = JSON.parse(raw) as CachedFeedState
        if (parsed && Array.isArray(parsed.posts)) {
            // Check usability window
            if (now - parsed.timestamp > USABLE_CACHE_TTL_MS) {
                ls.removeItem(fullKey)
                return null
            }

            // Defensively ensure only PUBLISHED posts are hydrated from persistent storage
            const verifiedPosts = parsed.posts.filter((p) => p.status === 'PUBLISHED')
            const stateWithStale: CachedFeedState = {
                ...parsed,
                posts: verifiedPosts,
                isStale: now - parsed.timestamp > STALE_REVALIDATE_TTL_MS,
            }
            IN_MEMORY_FEED_CACHE.set(fullKey, stateWithStale)
            return stateWithStale
        }
    } catch (e) {
        console.debug('[CommunityCache] Read error', e)
    }

    return mem || null
}

/**
 * Saves feed state into memory and persistent user-scoped storage.
 * - Private feeds (My Posts): Stored in memory and sessionStorage only. NEVER written to localStorage.
 * - Public feeds (Discover, Following, Saved): Filtered to include ONLY published posts before writing to localStorage.
 */
export function setCachedFeed(
    userScope: string | number | null | undefined,
    feedKey: string,
    state: { posts: CommunityPost[]; page: number; hasMore: boolean; scrollPosition?: number }
): void {
    const fullKey = buildUserScopeKey(userScope, feedKey)
    const entry: CachedFeedState = {
        posts: state.posts,
        page: state.page,
        hasMore: state.hasMore,
        timestamp: Date.now(),
        scrollPosition: state.scrollPosition ?? 0,
        isStale: false,
    }

    // 1. Always update active in-memory cache
    IN_MEMORY_FEED_CACHE.set(fullKey, entry)

    // 2. Storage persistence routing
    const isPrivate = isPrivateFeedKey(feedKey)
    const ls = safeGetLocalStorage()
    const ss = safeGetSessionStorage()

    if (isPrivate) {
        // Enforce private data policy: NEVER persist in long-lived localStorage
        if (ls) {
            try {
                ls.removeItem(fullKey)
            } catch {}
        }
        // Save into sessionStorage for smooth in-session tab switching / F5 within the tab
        if (ss) {
            try {
                const compactEntry: CachedFeedState = {
                    ...entry,
                    posts: entry.posts.slice(0, 40),
                }
                ss.setItem(fullKey, JSON.stringify(compactEntry))
            } catch (e) {
                console.debug('[CommunityCache] SessionStorage write error', e)
            }
        }
    } else {
        // Public feeds (Discover, Following, Saved):
        // Only persist safe, published posts. Filter out any PENDING, REJECTED, or HIDDEN items.
        const safePublicPosts = entry.posts
            .filter((p) => p.status === 'PUBLISHED')
            .slice(0, 40)

        const compactEntry: CachedFeedState = {
            ...entry,
            posts: safePublicPosts,
        }

        if (ls) {
            try {
                ls.setItem(fullKey, JSON.stringify(compactEntry))
            } catch (e) {
                console.debug('[CommunityCache] LocalStorage write error', e)
            }
        }
        if (ss) {
            try {
                ss.setItem(fullKey, JSON.stringify(compactEntry))
            } catch {}
        }
    }
}

/**
 * Deduplicates in-flight fetch requests so concurrent fetches share one network call.
 */
export function deduplicateRequest<T>(
    key: string,
    factory: () => Promise<T>
): Promise<T> {
    const existing = IN_FLIGHT_REQUESTS.get(key) as Promise<T> | undefined
    if (existing) {
        return existing
    }

    const started = requestGeneration
    const promise = factory().then(data => {
        if (started !== requestGeneration) throw new Error('Community request cancelled')
        return data
    }).finally(() => {
        if (IN_FLIGHT_REQUESTS.get(key) === promise) IN_FLIGHT_REQUESTS.delete(key)
    })

    IN_FLIGHT_REQUESTS.set(key, promise as any)
    return promise
}

/**
 * Synchronously patches a post across all active in-memory and persistent storage feeds.
 */
export function patchPostInAllCaches(
    postId: number,
    updater: (post: CommunityPost) => CommunityPost | null
): void {
    const ls = safeGetLocalStorage()
    const ss = safeGetSessionStorage()

    // 1. Update in-memory cache
    IN_MEMORY_FEED_CACHE.forEach((state, key) => {
        let changed = false
        const nextPosts: CommunityPost[] = []

        for (const p of state.posts) {
            if (p.id === postId) {
                const updated = updater(p)
                if (updated !== null) {
                    nextPosts.push(updated)
                }
                changed = true
            } else {
                nextPosts.push(p)
            }
        }

        if (changed) {
            state.posts = nextPosts
            IN_MEMORY_FEED_CACHE.set(key, state)
            
            const isPrivate = isPrivateFeedKey(key)
            if (isPrivate) {
                if (ss) {
                    try {
                        ss.setItem(key, JSON.stringify({ ...state, posts: nextPosts.slice(0, 40) }))
                    } catch {}
                }
            } else {
                const safePosts = nextPosts.filter((p) => p.status === 'PUBLISHED').slice(0, 40)
                if (ls) {
                    try {
                        ls.setItem(key, JSON.stringify({ ...state, posts: safePosts }))
                    } catch {}
                }
                if (ss) {
                    try {
                        ss.setItem(key, JSON.stringify({ ...state, posts: safePosts }))
                    } catch {}
                }
            }
        }
    })

    // 2. Also patch persistent storage for public feeds not currently loaded in memory
    if (ls) {
        try {
            for (let i = 0; i < ls.length; i++) {
                const key = ls.key(i)
                if (key && key.startsWith(CACHE_PREFIX) && !isPrivateFeedKey(key) && !IN_MEMORY_FEED_CACHE.has(key)) {
                    const raw = ls.getItem(key)
                    if (raw) {
                        const parsed = JSON.parse(raw) as CachedFeedState
                        if (parsed && Array.isArray(parsed.posts)) {
                            let changed = false
                            const nextPosts: CommunityPost[] = []
                            for (const p of parsed.posts) {
                                if (p.id === postId) {
                                    const updated = updater(p)
                                    if (updated !== null && updated.status === 'PUBLISHED') {
                                        nextPosts.push(updated)
                                    }
                                    changed = true
                                } else if (p.status === 'PUBLISHED') {
                                    nextPosts.push(p)
                                }
                            }
                            if (changed) {
                                parsed.posts = nextPosts.slice(0, 40)
                                ls.setItem(key, JSON.stringify(parsed))
                            }
                        }
                    }
                }
            }
        } catch {}
    }
}

/**
 * Optimistically patches post save/unsave across all feeds in memory and persistent storage.
 */
export function patchSaveStateInAllCaches(
    userScope: string | number | null | undefined,
    post: CommunityPost,
    isSaved: boolean
): void {
    // 1. Patch the savedByMe flag in all post instances
    patchPostInAllCaches(post.id, (p) => ({
        ...p,
        savedByMe: isSaved,
        isSaved: isSaved,
        saveCount: Math.max(0, (p.saveCount || 0) + (isSaved ? 1 : -1)),
    }))

    // 2. Update user's "saved" feed cache directly (only if PUBLISHED)
    if (post.status !== 'PUBLISHED') return

    const targetSubstrings = ['feed_saved_ALL', 'feed_saved']
    const ls = safeGetLocalStorage()
    const ss = safeGetSessionStorage()

    for (const sub of targetSubstrings) {
        const savedKey = buildUserScopeKey(userScope, sub)
        let savedFeed = IN_MEMORY_FEED_CACHE.get(savedKey)
        if (!savedFeed && ls) {
            try {
                const raw = ls.getItem(savedKey)
                if (raw) savedFeed = JSON.parse(raw)
            } catch {}
        }

        if (savedFeed) {
            if (isSaved) {
                const exists = savedFeed.posts.some((p) => p.id === post.id)
                if (!exists) {
                    savedFeed.posts = [{ ...post, savedByMe: true, isSaved: true }, ...savedFeed.posts]
                }
            } else {
                savedFeed.posts = savedFeed.posts.filter((p) => p.id !== post.id)
            }
            IN_MEMORY_FEED_CACHE.set(savedKey, savedFeed)
            const safePosts = savedFeed.posts.filter((p) => p.status === 'PUBLISHED').slice(0, 40)
            if (ls) {
                try {
                    ls.setItem(savedKey, JSON.stringify({ ...savedFeed, posts: safePosts }))
                } catch {}
            }
            if (ss) {
                try {
                    ss.setItem(savedKey, JSON.stringify({ ...savedFeed, posts: safePosts }))
                } catch {}
            }
        }
    }

    // Notify active UI subscribers (Feed cards, Detail modal, Reaction bar)
    notifyPostUpdate({
        postId: post.id,
        savedByMe: isSaved,
        isSaved: isSaved,
    })
}

export type PostUpdateEvent = {
    postId: number
    myReaction?: ReactionType | null
    reactionCount?: number
    likeCount?: number
    savedByMe?: boolean
    isSaved?: boolean
    commentCount?: number
}

type PostUpdateListener = (event: PostUpdateEvent) => void
const postUpdateListeners = new Set<PostUpdateListener>()

export function subscribeToPostUpdates(listener: PostUpdateListener): () => void {
    postUpdateListeners.add(listener)
    return () => {
        postUpdateListeners.delete(listener)
    }
}

export function notifyPostUpdate(event: PostUpdateEvent): void {
    postUpdateListeners.forEach((fn) => {
        try {
            fn(event)
        } catch (e) {
            console.error('[CommunityCache] Post update listener error', e)
        }
    })
}

/**
 * Optimistically patches post reaction across all feeds in memory and persistent storage.
 */
export function patchReactionInAllCaches(
    postId: number,
    newReaction: ReactionType | null | undefined,
    reactionCount: number
): void {
    patchPostInAllCaches(postId, (p) => ({
        ...p,
        myReaction: newReaction || null,
        reactionCount: reactionCount,
        likeCount: reactionCount,
    }))
    notifyPostUpdate({
        postId,
        myReaction: newReaction || null,
        reactionCount: reactionCount,
        likeCount: reactionCount,
    })
}

/**
 * Optimistically patches comment count increment.
 */
export function patchCommentCountInAllCaches(postId: number, delta = 1): void {
    let updatedCount: number | undefined
    patchPostInAllCaches(postId, (p) => {
        const next = Math.max(0, (p.commentCount || 0) + delta)
        updatedCount = next
        return {
            ...p,
            commentCount: next,
        }
    })
    if (updatedCount !== undefined) {
        notifyPostUpdate({
            postId,
            commentCount: updatedCount,
        })
    }
}

/**
 * Removes deleted post from all feeds in memory and persistent storage.
 */
export function removePostFromAllCaches(postId: number): void {
    patchPostInAllCaches(postId, () => null)
}

/**
 * Persistent Active Tab Management
 */
export function saveActiveCommunityTab(tab: string): void {
    const storage = safeGetStorage()
    if (!storage) return
    try {
        storage.setItem(TAB_STORAGE_KEY, tab)
    } catch {}
}

export function getActiveCommunityTab(): string | null {
    const storage = safeGetStorage()
    if (!storage) return null
    try {
        const tab = storage.getItem(TAB_STORAGE_KEY)
        if (tab && ['public', 'following', 'my-posts', 'saved'].includes(tab)) {
            return tab
        }
    } catch {}
    return null
}

/**
 * Preserves scroll position and active tab for instant restoration.
 */
export function saveCommunitySession(tab: string, filter: string, scrollY: number): void {
    const storage = safeGetStorage()
    if (!storage) return
    try {
        storage.setItem(SCROLL_STORAGE_KEY, JSON.stringify({ tab, filter, scrollY, timestamp: Date.now() }))
    } catch {}
}

export function saveScrollPosition(scrollY: number): void {
    const storage = safeGetStorage()
    if (!storage) return
    try {
        storage.setItem(SCROLL_Y_KEY, String(scrollY))
    } catch {}
}

export function restoreScrollPosition(): number {
    const storage = safeGetStorage()
    if (!storage) return 0
    try {
        const v = storage.getItem(SCROLL_Y_KEY)
        return v ? Number(v) : 0
    } catch {
        return 0
    }
}

export function getCommunitySession(): { tab: string; filter: string; scrollY: number } | null {
    const storage = safeGetStorage()
    if (!storage) return null
    try {
        const raw = storage.getItem(SCROLL_STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        // Valid within 30 minutes of leaving
        if (parsed && Date.now() - parsed.timestamp < 30 * 60 * 1000) {
            return parsed
        }
    } catch {}
    return null
}

/**
 * Complete user-scoped cache cleanup on logout or account switch.
 * Purges memory cache and all ec_comm_* entries from BOTH localStorage and sessionStorage.
 */
export function clearCommunityUserCache(): void {
    requestGeneration++
    IN_MEMORY_FEED_CACHE.clear()
    IN_FLIGHT_REQUESTS.clear()

    const ls = safeGetLocalStorage()
    const ss = safeGetSessionStorage()

    if (ls) {
        try {
            const keysToRemove: string[] = []
            for (let i = 0; i < ls.length; i++) {
                const k = ls.key(i)
                if (k && (k.startsWith('ec_comm_') || k.startsWith(CACHE_PREFIX) || LEGACY_PREFIXES.some((p) => k.startsWith(p)))) {
                    keysToRemove.push(k)
                }
            }
            keysToRemove.forEach((k) => ls.removeItem(k))
        } catch (e) {
            console.debug('[CommunityCache] Error clearing localStorage', e)
        }
    }

    if (ss) {
        try {
            const keysToRemove: string[] = []
            for (let i = 0; i < ss.length; i++) {
                const k = ss.key(i)
                if (k && (k.startsWith('ec_comm_') || k.startsWith(CACHE_PREFIX) || LEGACY_PREFIXES.some((p) => k.startsWith(p)))) {
                    keysToRemove.push(k)
                }
            }
            keysToRemove.forEach((k) => ss.removeItem(k))
        } catch (e) {
            console.debug('[CommunityCache] Error clearing sessionStorage', e)
        }
    }

    IN_MEMORY_COMMENT_CACHE.clear()
    console.debug('[CommunityCache] Cleared all user community cache entries')
}

// ─── Comment Tree Cache (Hierarchical V3) ───────────────────────────

const COMMENT_CACHE_PREFIX = 'ec_comm_v3_comments_'
const IN_MEMORY_COMMENT_CACHE = new Map<number, { tree: Comment[]; timestamp: number }>()

export function getCachedCommentTree(postId: number): Comment[] | null {
    const now = Date.now()
    const mem = IN_MEMORY_COMMENT_CACHE.get(postId)
    if (mem && now - mem.timestamp < USABLE_CACHE_TTL_MS) {
        return mem.tree
    }

    const storage = safeGetSessionStorage() || safeGetLocalStorage()
    if (!storage) return null
    try {
        const raw = storage.getItem(`${COMMENT_CACHE_PREFIX}${postId}`)
        if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed?.tree)) {
                const authoritativeTree = buildCommentTree(parsed.tree)
                IN_MEMORY_COMMENT_CACHE.set(postId, { tree: authoritativeTree, timestamp: parsed.timestamp || now })
                return authoritativeTree
            }
        }
    } catch {}
    return null
}

export function setCachedCommentTree(postId: number, comments: Comment[]): void {
    const authoritativeTree = buildCommentTree(comments)
    const entry = { tree: authoritativeTree, timestamp: Date.now() }
    IN_MEMORY_COMMENT_CACHE.set(postId, entry)

    const storage = safeGetSessionStorage() || safeGetLocalStorage()
    if (storage) {
        try {
            storage.setItem(`${COMMENT_CACHE_PREFIX}${postId}`, JSON.stringify(entry))
        } catch {}
    }
}

export function patchCachedCommentReply(postId: number, parentId: number | null, newComment: Comment): void {
    const current = getCachedCommentTree(postId) || []

    function insertIntoTree(list: Comment[]): Comment[] {
        if (!parentId) {
            return [...list, newComment]
        }
        return list.map((item) => {
            if (item.id === parentId) {
                const replies = [...(item.replies || []), newComment]
                return {
                    ...item,
                    replyCount: replies.length,
                    childrenCount: replies.length,
                    replies,
                    children: replies,
                }
            }
            if (item.replies && item.replies.length > 0) {
                const updatedReplies = insertIntoTree(item.replies)
                return {
                    ...item,
                    replies: updatedReplies,
                    children: updatedReplies,
                }
            }
            return item
        })
    }

    const updated = insertIntoTree(current)
    setCachedCommentTree(postId, updated)
}

export function patchCachedCommentDelete(postId: number, commentId: number): void {
    const current = getCachedCommentTree(postId) || []

    function removeFromTree(list: Comment[]): Comment[] {
        return list
            .filter((c) => c.id !== commentId)
            .map((c) => {
                if (c.replies && c.replies.length > 0) {
                    const nextReplies = removeFromTree(c.replies)
                    return {
                        ...c,
                        replies: nextReplies,
                        children: nextReplies,
                        replyCount: nextReplies.length,
                        childrenCount: nextReplies.length,
                    }
                }
                return c
            })
    }

    const updated = removeFromTree(current)
    setCachedCommentTree(postId, updated)
}
