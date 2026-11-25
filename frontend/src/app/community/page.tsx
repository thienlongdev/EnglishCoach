'use client'

import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import {
    Users,
    Compass,
    Bookmark,
    FileText,
    RefreshCw,
    Loader2,
    Hash,
    X,
    ChevronDown,
} from 'lucide-react'
import { useSession } from 'next-auth/react'
import { CommunityPost, PostType } from '@/types/community'
import { communityApi } from '@/services/communityApi'
import {
    getCachedFeed,
    setCachedFeed,
    deduplicateRequest,
    saveScrollPosition,
    restoreScrollPosition,
    getActiveCommunityTab,
    saveActiveCommunityTab,
} from '@/services/communityCache'
import { CommunityUserCard } from '@/components/community/CommunityUserCard'
import { PostComposer } from '@/components/community/PostComposer'
import { PostCard } from '@/components/community/PostCard'
import { PostDetailModal } from '@/components/community/PostDetailModal'
import { CommunityRulesCard } from '@/components/community/CommunityRulesCard'
import { TrendingSidebar } from '@/components/community/TrendingSidebar'
import { useCurrentRole } from '@/hooks/useCurrentRole'
import { AuthGuard } from '@/components/common/AuthGuard'
import { cg, CommunityHero, FeedSkeleton, FeedState } from '@/components/community/CommunityGlass'

// Each feed view as the toolbar presents it (title, what it contains, its icon).
const VIEW_COPY = {
    public: { title: 'Bảng tin cộng đồng', note: 'Bài viết đã được duyệt từ mọi người học English Coach.', icon: Compass },
    following: { title: 'Đang theo dõi', note: 'Bảng tin từ những người bạn theo dõi.', icon: Users },
    'my-posts': { title: 'Bài viết của tôi', note: 'Bao gồm cả bài đang chờ duyệt.', icon: FileText },
    saved: { title: 'Đã lưu', note: 'Những bài viết bạn đã lưu riêng tư để xem lại.', icon: Bookmark },
} as const

const FILTER_TONE: Record<string, string> = { ALL: '#0ea5e9', GENERAL: '#0ea5e9', QUESTION: '#8b5cf6', CORRECTION_REQUEST: '#f59e0b', ACHIEVEMENT: '#10b981', LEARNING: '#06b6d4' }

const POST_TYPE_FILTERS: { key: string; label: string }[] = [
    { key: 'ALL', label: 'Tất cả' },
    { key: 'GENERAL', label: 'Chia sẻ' },
    { key: 'QUESTION', label: 'Hỏi đáp' },
    { key: 'CORRECTION_REQUEST', label: 'Nhờ sửa câu' },
    { key: 'ACHIEVEMENT', label: 'Thành tích' },
    { key: 'LEARNING', label: 'Bài học' },
]

function CommunityContent() {
    const { data: session } = useSession()
    const currentUserId = (session?.user as any)?.id ? Number((session?.user as any)?.id) : null
    const { isAdmin } = useCurrentRole()

    const searchParams = useSearchParams()
    const router = useRouter()
    const deepPostId = searchParams.get('post')

    // Deep link modal state
    const [deepPost, setDeepPost] = useState<CommunityPost | null>(null)
    const [isDeepPostOpen, setIsDeepPostOpen] = useState(false)
    const [deepLoading, setDeepLoading] = useState(false)

    // Tab state (restored from persistent user cache if available)
    const [activeFeedTab, setActiveFeedTab] = useState<'public' | 'following' | 'my-posts' | 'saved'>(() => {
        if (typeof window !== 'undefined') {
            const saved = getActiveCommunityTab()
            if (saved && ['public', 'following', 'my-posts', 'saved'].includes(saved)) {
                return saved as any
            }
        }
        return 'public'
    })
    const [selectedTypeFilter, setSelectedTypeFilter] = useState<string>('ALL')
    const [selectedHashtag, setSelectedHashtag] = useState<string>(() => {
        return searchParams.get('hashtag') || ''
    })

    // A new hashtag partition excludes snapshots produced by the old substring query.
    const initialFeedKey = `feed_${activeFeedTab}${selectedHashtag ? '_tag_exact_' + selectedHashtag : ''}_ALL`
    const initialFeed = useRef(getCachedFeed(currentUserId, initialFeedKey)).current
    const displayedFeedKey = useRef(initialFeedKey)
    const [posts, setPosts] = useState<CommunityPost[]>(() => initialFeed?.posts ?? [])
    const [page, setPage] = useState(() => initialFeed?.page ?? 0)
    const [hasMore, setHasMore] = useState(() => initialFeed?.hasMore ?? true)
    const [loading, setLoading] = useState(() => !initialFeed)
    const feedGeneration = useRef(0)
    useEffect(() => () => { feedGeneration.current++ }, [])
    const [loadingMore, setLoadingMore] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    // A failed first page is shown as a failure (with Retry), never as "no posts".
    const [loadFailed, setLoadFailed] = useState(false)
    // Hero shortcuts open the composer with a chosen post type (nonce: the same type twice still focuses it).
    const [composePreset, setComposePreset] = useState<{ type: PostType; nonce: number } | null>(null)

    // Save active tab persistently
    useEffect(() => {
        saveActiveCommunityTab(activeFeedTab)
    }, [activeFeedTab])

    // Handle deep link ?post=<id>
    useEffect(() => {
        if (!deepPostId) return
        const postId = Number(deepPostId)
        if (isNaN(postId)) return

        let isMounted = true
        setDeepLoading(true)

        communityApi
            .getPost(postId)
            .then((post) => {
                if (!isMounted) return
                // Enforce Requirement 13: Do NOT allow public sharing of PENDING, REJECTED, HIDDEN
                if (post.status === 'PUBLISHED' || isAdmin || (currentUserId && post.author.userId === currentUserId)) {
                    setDeepPost(post)
                    setIsDeepPostOpen(true)
                } else {
                    alert('Bài viết này chưa được phê duyệt công khai hoặc đã bị gỡ.')
                }
            })
            .catch((err) => {
                console.error('Failed to load deep link post', err)
            })
            .finally(() => {
                if (isMounted) setDeepLoading(false)
            })

        return () => {
            isMounted = false
        }
    }, [deepPostId, isAdmin, currentUserId])

    const getFeedKey = useCallback(
        (targetPage: number) => {
            return `feed_${activeFeedTab}${selectedHashtag ? '_tag_exact_' + selectedHashtag : ''}_${selectedTypeFilter}_p${targetPage}`
        },
        [activeFeedTab, selectedTypeFilter, selectedHashtag]
    )

    // SWR Feed Fetcher
    const fetchFeed = useCallback(
        async (targetPage = 0, isRefresh = false) => {
            const started = ++feedGeneration.current
            const feedKey = `feed_${activeFeedTab}${selectedHashtag ? '_tag_exact_' + selectedHashtag : ''}_${selectedTypeFilter}`
            const sameFeed = displayedFeedKey.current === feedKey
            displayedFeedKey.current = feedKey
            if (!sameFeed) {
                setPosts([])
                setPage(0)
                setHasMore(true)
                setLoadingMore(false)
                setRefreshing(false)
            }

            // Stale-While-Revalidate: Check cache for initial page
            if (targetPage === 0 && !isRefresh) {
                const cached = getCachedFeed(currentUserId, feedKey)
                if (cached) {
                    setPosts(cached.posts)
                    setPage(cached.page)
                    setHasMore(cached.hasMore)
                    setLoading(false)
                    // If cached data is fresh (< 30s), skip unnecessary network call
                    if (!cached.isStale) {
                        return
                    }
                } else {
                    setLoading(true)
                }
            } else if (targetPage === 0 && isRefresh) {
                setRefreshing(true)
            } else {
                setLoadingMore(true)
            }

            if (targetPage === 0) setLoadFailed(false)
            try {
                const dedupKey = `req_${currentUserId}_${feedKey}_p${targetPage}`
                const data = await deduplicateRequest(dedupKey, async () => {
                    if (activeFeedTab === 'following') {
                        return communityApi.getFollowingFeed(targetPage, 10)
                    } else if (activeFeedTab === 'my-posts') {
                        return communityApi.getMyPosts(targetPage, 10)
                    } else if (activeFeedTab === 'saved') {
                        return communityApi.getSavedPosts(targetPage, 10)
                    } else {
                        return communityApi.getPublicFeed(
                            targetPage,
                            10,
                            selectedTypeFilter !== 'ALL' ? selectedTypeFilter : undefined,
                            selectedHashtag ? selectedHashtag : undefined
                        )
                    }
                })

                if (started !== feedGeneration.current) return

                if (targetPage === 0) {
                    const freshPosts = data.posts || []
                    setPosts((prev) => {
                        if (started !== feedGeneration.current) return prev
                        // If we already loaded subsequent pages and are revalidating in background, preserve older items
                        if (sameFeed && prev.length > freshPosts.length && !isRefresh) {
                            const freshIds = new Set(freshPosts.map((p) => p.id))
                            const remainingOlder = prev.filter((p) => !freshIds.has(p.id))
                            const merged = [...freshPosts, ...remainingOlder]
                            setCachedFeed(currentUserId, feedKey, {
                                posts: merged,
                                page: Math.max(data.page, Math.floor(merged.length / 10) - 1),
                                hasMore: Boolean(data.hasMore && freshPosts.length > 0),
                            })
                            return merged
                        }
                        setCachedFeed(currentUserId, feedKey, {
                            posts: freshPosts,
                            page: data.page,
                            hasMore: Boolean(data.hasMore && freshPosts.length > 0),
                        })
                        return freshPosts
                    })
                } else {
                    setPosts((prev) => {
                        if (started !== feedGeneration.current) return prev
                        const existingIds = new Set(prev.map((p) => p.id))
                        const newPosts = (data.posts || []).filter((p: CommunityPost) => !existingIds.has(p.id))
                        const merged = [...prev, ...newPosts]
                        setCachedFeed(currentUserId, feedKey, {
                            posts: merged,
                            page: data.page,
                            hasMore: Boolean(data.hasMore && data.posts && data.posts.length > 0),
                        })
                        return merged
                    })
                }
                setPage(data.page)
                setHasMore(Boolean(data.hasMore && data.posts && data.posts.length > 0))
            } catch (err) {
                console.error('Failed to load community feed', err)
                if (started === feedGeneration.current && targetPage === 0) setLoadFailed(true)
            } finally {
                if (started === feedGeneration.current) {
                    setLoading(false)
                    setLoadingMore(false)
                    setRefreshing(false)
                }
            }
        },
        [activeFeedTab, selectedTypeFilter, selectedHashtag, currentUserId]
    )

    // Sync URL ?hashtag=<tag> with selectedHashtag state
    useEffect(() => {
        const tagFromUrl = searchParams.get('hashtag') || ''
        if (tagFromUrl !== selectedHashtag) {
            setSelectedHashtag(tagFromUrl)
        }
    }, [searchParams, selectedHashtag])

    const handleSelectHashtag = (tag: string) => {
        const nextTag = selectedHashtag.toLowerCase() === tag.toLowerCase() ? '' : tag
        setSelectedHashtag(nextTag)
        setActiveFeedTab('public')
        if (typeof window !== 'undefined') {
            const url = new URL(window.location.href)
            if (nextTag) {
                url.searchParams.set('hashtag', nextTag)
            } else {
                url.searchParams.delete('hashtag')
            }
            window.history.pushState({}, '', url.toString())
        }
    }

    const handleClearHashtag = () => {
        setSelectedHashtag('')
        if (typeof window !== 'undefined') {
            const url = new URL(window.location.href)
            url.searchParams.delete('hashtag')
            window.history.pushState({}, '', url.toString())
        }
    }

    useEffect(() => {
        setPage(0)
        fetchFeed(0)
    }, [fetchFeed])

    const handleLoadMore = () => {
        if (!loadingMore && hasMore) {
            fetchFeed(page + 1)
        }
    }

    const handlePostCreated = (newPost: CommunityPost) => {
        if (selectedTypeFilter !== 'ALL' && newPost.postType !== selectedTypeFilter) return
        if (selectedHashtag && !(newPost.content.match(/#[a-zA-Z0-9_\u00C0-\u024F\u1EA0-\u1EF9]+/g) || [])
            .some(tag => tag.slice(1).toLowerCase() === selectedHashtag.toLowerCase())) return
        // Optimistically add to top of feed
        setPosts((prev) => [newPost, ...prev])
        const feedKey = `feed_${activeFeedTab}${selectedHashtag ? '_tag_exact_' + selectedHashtag : ''}_${selectedTypeFilter}`
        setCachedFeed(currentUserId, feedKey, {
            posts: [newPost, ...posts],
            page: page,
            hasMore: hasMore,
        })
    }

    const handlePostDeleted = (deletedId: number) => {
        setPosts((prev) => prev.filter((p) => p.id !== deletedId))
    }

    const handlePostUpdated = (updated: CommunityPost) => {
        setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
    }

    const handleCloseDeepPost = () => {
        setIsDeepPostOpen(false)
        setDeepPost(null)
        // Clean URL parameter without reloading page
        if (typeof window !== 'undefined') {
            const url = new URL(window.location.href)
            url.searchParams.delete('post')
            window.history.replaceState({}, '', url.toString())
        }
    }

    const view = VIEW_COPY[activeFeedTab]
    const ViewIcon = view.icon

    return (
        <div className={`${cg.world} ${cg.page}`} data-world="community">
            <div className={cg.frame}>
                <CommunityHero onCompose={(type) => setComposePreset((prev) => ({ type, nonce: (prev?.nonce ?? 0) + 1 }))} />

                <div className={cg.layout}>
                    {/* Identity + feed views: a column from 1280 px, a bar above the feed below it */}
                    <div className={cg.navArea}>
                        <CommunityUserCard
                            activeTab={activeFeedTab}
                            onSelectTab={(tab) => {
                                setActiveFeedTab(tab)
                                setSelectedTypeFilter('ALL')
                                if (tab !== 'public' && selectedHashtag) {
                                    handleClearHashtag()
                                }
                            }}
                        />
                    </div>

                    <section className={cg.feedArea} aria-labelledby="community-feed-title">
                        <PostComposer onPostCreated={handlePostCreated} preset={composePreset} />

                        {/* What is shown below: the view, its filters, refresh */}
                        <div className={`${cg.panel} ${cg.toolbar}`}>
                            <div className={cg.toolbarTop}>
                                <span className={cg.viewIcon} aria-hidden="true"><ViewIcon /></span>
                                <div className={cg.viewText}>
                                    <h2 id="community-feed-title" className={cg.viewTitle}>{view.title}</h2>
                                    <p className={cg.viewNote}>{view.note}</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => fetchFeed(0, true)}
                                    disabled={refreshing}
                                    className={cg.refresh}
                                    data-busy={refreshing}
                                    title="Làm mới bảng tin"
                                >
                                    <RefreshCw aria-hidden="true" />
                                    <span>Làm mới</span>
                                </button>
                            </div>

                            {activeFeedTab === 'public' && (
                                <div className={cg.filters} role="group" aria-label="Lọc theo loại bài viết">
                                    {POST_TYPE_FILTERS.map((f) => (
                                        <button
                                            key={f.key}
                                            type="button"
                                            onClick={() => setSelectedTypeFilter(f.key)}
                                            aria-pressed={selectedTypeFilter === f.key}
                                            className={cg.chip}
                                            style={{ ['--tone' as string]: FILTER_TONE[f.key] }}
                                        >
                                            {f.label}
                                        </button>
                                    ))}
                                </div>
                            )}

                            {selectedHashtag && activeFeedTab === 'public' && (
                                <div className={cg.tagBanner}>
                                    <Hash aria-hidden="true" />
                                    <span className="min-w-0 truncate">
                                        Đang lọc theo chủ đề <strong>#{selectedHashtag}</strong>
                                    </span>
                                    <button type="button" onClick={handleClearHashtag} title="Bỏ lọc theo chủ đề">
                                        <X aria-hidden="true" />
                                        <span>Bỏ lọc</span>
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Posts stream */}
                        {loading && posts.length === 0 ? (
                            <FeedSkeleton />
                        ) : posts.length === 0 && loadFailed ? (
                            <FeedState
                                tone="error"
                                title="Chưa tải được bảng tin"
                                text="Kết nối tới máy chủ không thành công. Hãy kiểm tra mạng rồi thử lại."
                                action={{ label: 'Thử lại', onClick: () => fetchFeed(0, true), busy: refreshing }}
                            />
                        ) : posts.length === 0 ? (
                            <FeedState
                                tone="empty"
                                title="Chưa có bài viết nào"
                                text={
                                    activeFeedTab === 'my-posts'
                                        ? 'Bạn chưa đăng bài viết nào. Hãy chia sẻ cảm nghĩ hoặc câu hỏi học tập đầu tiên của bạn ở trên!'
                                        : activeFeedTab === 'saved'
                                        ? 'Bạn chưa lưu bài viết nào. Hãy bấm Lưu trên bài viết bạn yêu thích để xem lại sau.'
                                        : activeFeedTab === 'following'
                                        ? 'Những người bạn theo dõi chưa có bài viết mới. Hãy tìm thêm bạn bè hoặc quay lại Dành cho bạn!'
                                        : 'Hãy là người đầu tiên đặt câu hỏi hoặc chia sẻ kiến thức hôm nay!'
                                }
                            />
                        ) : (
                            <div className="flex flex-col gap-4">
                                {posts.map((post) => (
                                    <PostCard
                                        key={post.id}
                                        post={post}
                                        currentUserId={currentUserId}
                                        isAdmin={isAdmin}
                                        onPostDeleted={handlePostDeleted}
                                        onPostUpdated={handlePostUpdated}
                                        onHashtagClick={handleSelectHashtag}
                                    />
                                ))}

                                {hasMore && (
                                    <div className={cg.more}>
                                        <button type="button" onClick={handleLoadMore} disabled={loadingMore} className={cg.moreBtn}>
                                            {loadingMore ? (
                                                <>
                                                    <Loader2 className="animate-spin" aria-hidden="true" />
                                                    <span>Đang tải thêm...</span>
                                                </>
                                            ) : (
                                                <>
                                                    <ChevronDown aria-hidden="true" />
                                                    <span>Xem thêm bài viết</span>
                                                </>
                                            )}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </section>

                    <aside className={cg.sideArea} aria-label="Khám phá cộng đồng">
                        <TrendingSidebar activeTag={selectedHashtag} onSelectTag={handleSelectHashtag} />
                        <CommunityRulesCard />
                    </aside>
                </div>
            </div>

            {/* Deep link Post Detail Modal */}
            {deepPost && (
                <PostDetailModal
                    post={deepPost}
                    isOpen={isDeepPostOpen}
                    onClose={handleCloseDeepPost}
                    onPostUpdated={(updated) => {
                        setDeepPost(updated)
                        handlePostUpdated(updated)
                    }}
                />
            )}
        </div>
    )
}

export default function CommunityPage() {
    const { data: session } = useSession()
    return (
        <Suspense
            fallback={
                <div className={`${cg.world} ${cg.page} min-h-screen py-16 text-center space-y-3`}>
                    <Loader2 className="w-8 h-8 animate-spin text-cyan-500 dark:text-cyan-400 mx-auto" />
                    <p className="text-xs text-slate-500 dark:text-slate-400">Đang tải cộng đồng...</p>
                </div>
            }
        >
            <AuthGuard><CommunityContent key={(session?.user as any)?.id ?? 'guest'} /></AuthGuard>
        </Suspense>
    )
}
