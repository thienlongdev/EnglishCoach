import { apiClient } from '@/services/api-client'
import {
    CommunityFeedPage,
    CommunityPost,
    Comment,
    CommunityUserProfile,
    CreatePostRequest,
    UpdatePostRequest,
    OfficialPublishRequest,
    ModeratePostRequest,
    ReactionType,
    ReportReason,
    PostStatus,
    ReportStatus,
    ReportItem,
    AuthorSummary,
    PostReactor,
    PostReactionSummary,
    TrendingTopic,
    CommunityUserRestriction,
    CreateRestrictionRequest,
    CommentReactionResponse,
} from '@/types/community'

export function normalizeAuthor(raw: any): AuthorSummary {
    if (!raw) {
        return {
            userId: null,
            displayName: 'Học viên',
            avatarUrl: null,
            equippedFrameId: null,
            streakDays: 0,
            cefrLevel: null,
            premium: false,
            official: false,
        }
    }
    const isOfficial = Boolean(raw.official ?? raw.isOfficial ?? (raw.authorType === 'OFFICIAL'))
    const displayName = isOfficial
        ? 'EnglishCoach'
        : (raw.displayName || raw.name || 'Học viên')
    const frameId = raw.equippedFrameId || (raw.frame?.slug || (raw.frame?.id ? String(raw.frame.id) : null)) || null

    return {
        id: raw.id ?? raw.userId ?? null,
        userId: raw.userId ?? raw.id ?? null,
        name: raw.name || displayName,
        displayName: displayName,
        avatarUrl: isOfficial ? '/assets/Whale.svg' : (raw.avatarUrl || null),
        equippedFrameId: frameId,
        frame: raw.frame || null,
        streakDays: Number(raw.streakDays) || 0,
        cefrLevel: raw.cefrLevel || null,
        premium: Boolean(raw.premium ?? raw.isPremium),
        official: isOfficial,
        followedByMe: Boolean(raw.followedByMe ?? raw.isFollowing),
    }
}

export function normalizePost(raw: any): CommunityPost {
    if (!raw) return raw
    const author = normalizeAuthor(raw.author)
    const mediaList = Array.isArray(raw.media)
        ? raw.media.map((m: any, idx: number) => {
            const mime = m.mimeType || m.mediaType || ''
            const isVid = (m.type === 'VIDEO') || mime.toLowerCase().startsWith('video/') || (m.url || m.mediaUrl || '').endsWith('.mp4') || (m.url || m.mediaUrl || '').endsWith('.webm')
            return {
                id: m.id || idx,
                mediaUrl: m.mediaUrl || m.url || '',
                mediaType: mime || (isVid ? 'video/mp4' : 'image/jpeg'),
                type: (m.type || (isVid ? 'VIDEO' : 'IMAGE')) as 'IMAGE' | 'VIDEO',
                sortOrder: m.sortOrder ?? m.displayOrder ?? m.order ?? idx,
                order: m.order ?? m.sortOrder ?? m.displayOrder ?? idx,
                fileName: m.fileName,
                fileSize: m.fileSize,
                width: m.width,
                height: m.height,
            }
        })
        : []

    return {
        id: Number(raw.id),
        author,
        postType: raw.postType || 'GENERAL',
        status: raw.status || 'PUBLISHED',
        content: raw.content || '',
        pinned: Boolean(raw.pinned ?? raw.isPinned),
        featured: Boolean(raw.featured ?? raw.isFeatured),
        seriesName: raw.seriesName || raw.seriesType,
        seriesType: raw.seriesType || raw.seriesName,
        reactionCount: Number(raw.reactionCount ?? raw.likeCount) || 0,
        likeCount: Number(raw.likeCount ?? raw.reactionCount) || 0,
        topReactions: Array.isArray(raw.topReactions) ? raw.topReactions : [],
        commentCount: Number(raw.commentCount) || 0,
        saveCount: Number(raw.saveCount) || 0,
        myReaction: raw.myReaction || null,
        savedByMe: Boolean(raw.savedByMe ?? raw.isSaved ?? raw.saved),
        isSaved: Boolean(raw.isSaved ?? raw.savedByMe ?? raw.saved),
        followedByMe: Boolean(raw.followedByMe ?? author.followedByMe),
        media: mediaList,
        sharedEmbed: raw.sharedEmbed || raw.learningEmbed || null,
        learningEmbed: raw.learningEmbed || raw.sharedEmbed || null,
        moderationNote: raw.moderationNote || raw.moderationReason,
        moderationReason: raw.moderationReason || raw.moderationNote,
        commentsDisabled: Boolean(raw.commentsDisabled ?? raw.commentsDisabledByOwner ?? raw.commentsLockedByAdmin),
        commentsDisabledByOwner: Boolean(raw.commentsDisabledByOwner),
        commentsLockedByAdmin: Boolean(raw.commentsLockedByAdmin),
        scheduledAt: raw.scheduledAt || (raw.scheduledFor ? String(raw.scheduledFor) : undefined),
        publishedAt: raw.publishedAt ? String(raw.publishedAt) : undefined,
        createdAt: raw.createdAt ? String(raw.createdAt) : new Date().toISOString(),
        updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined,
    }
}

export function normalizeComment(raw: any): Comment {
    if (!raw) return raw
    const author = normalizeAuthor(raw.author)
    const rawReplies = Array.isArray(raw.replies)
        ? raw.replies
        : Array.isArray(raw.children)
        ? raw.children
        : []
    const replies = rawReplies.map(normalizeComment)

    const parentId = raw.parentId !== undefined && raw.parentId !== null
        ? Number(raw.parentId)
        : raw.parentCommentId !== undefined && raw.parentCommentId !== null
        ? Number(raw.parentCommentId)
        : null

    const replyCount = Number(raw.replyCount ?? raw.childrenCount ?? replies.length) || 0

    return {
        id: Number(raw.id),
        postId: Number(raw.postId),
        parentId,
        parentCommentId: parentId,
        author,
        replyToAuthorName: raw.replyToAuthorName || null,
        content: raw.content || '',
        mediaUrl: raw.mediaUrl || (Array.isArray(raw.media) && raw.media[0] ? raw.media[0].mediaUrl : null),
        mediaType: raw.mediaType || (Array.isArray(raw.media) && raw.media[0] ? raw.media[0].mediaType : null),
        media: Array.isArray(raw.media) && raw.media.length > 0
            ? raw.media.map((m: any, idx: number) => ({
                id: m.id ? Number(m.id) : undefined,
                mediaUrl: String(m.mediaUrl),
                mediaType: String(m.mediaType || 'image/jpeg'),
                displayOrder: m.displayOrder !== undefined ? Number(m.displayOrder) : idx,
            }))
            : raw.mediaUrl
            ? [{
                id: undefined,
                mediaUrl: raw.mediaUrl,
                mediaType: raw.mediaType || 'image/jpeg',
                displayOrder: 0,
            }]
            : [],
        reactionCount: Number(raw.reactionCount ?? raw.likeCount) || 0,
        likeCount: Number(raw.likeCount ?? raw.reactionCount) || 0,
        replyCount,
        childrenCount: replyCount,
        myReaction: raw.myReaction || (raw.isLiked ? 'LIKE' : null),
        isLiked: Boolean(raw.isLiked ?? (raw.myReaction === 'LIKE')),
        reactionCounts: raw.reactionCounts || {},
        topReactors: Array.isArray(raw.topReactors) ? raw.topReactors : [],
        replies,
        children: replies,
        createdAt: raw.createdAt ? String(raw.createdAt) : new Date().toISOString(),
    }
}

/**
 * Authoritatively builds a permanent hierarchical comment tree from any collection
 * of comments. Preserves parent-child relation permanently across modal close/reopen and page refreshes.
 */
export function buildCommentTree(comments: Comment[]): Comment[] {
    if (!Array.isArray(comments) || comments.length === 0) return []

    // 1. Flatten all comments (in case some were already partially nested) to re-index cleanly
    const flatMap = new Map<number, Comment>()

    function collectFlat(items: Comment[]) {
        for (const item of items) {
            const existing = flatMap.get(item.id)
            if (!existing) {
                flatMap.set(item.id, {
                    ...item,
                    replies: [],
                    children: [],
                })
            }
            if (item.replies && item.replies.length > 0) {
                collectFlat(item.replies)
            }
            if (item.children && item.children.length > 0) {
                collectFlat(item.children)
            }
        }
    }
    collectFlat(comments)

    // 2. Build authoritative tree using parentId / parentCommentId
    const rootComments: Comment[] = []
    
    // Sort items chronologically before building
    const allItems = Array.from(flatMap.values()).sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )

    for (const item of allItems) {
        const parentId = item.parentId ?? item.parentCommentId
        if (parentId != null && flatMap.has(parentId)) {
            const parent = flatMap.get(parentId)!
            if (!parent.replies.some((r) => r.id === item.id)) {
                parent.replies.push(item)
                parent.children = parent.replies
                parent.replyCount = parent.replies.length
                parent.childrenCount = parent.replies.length
            }
        } else {
            rootComments.push(item)
        }
    }

    return rootComments
}

export function normalizeFeedPage(data: any): CommunityFeedPage {
    const rawList = Array.isArray(data)
        ? data
        : Array.isArray(data?.posts)
        ? data.posts
        : Array.isArray(data?.items)
        ? data.items
        : []
    const posts = rawList.map(normalizePost)
    return {
        posts,
        items: posts,
        page: Number(data?.page) || 0,
        size: Number(data?.size) || (posts.length || 10),
        totalElements: Number(data?.totalElements) || posts.length,
        totalPages: Number(data?.totalPages) || (posts.length > 0 ? 1 : 0),
        hasMore: Boolean(data?.hasMore ?? (data?.page + 1 < data?.totalPages)),
    }
}

export const communityApi = {
    // ─── Feed ────────────────────────────────────────────────────────
    async getPublicFeed(page = 0, size = 10, postType?: string, hashtag?: string): Promise<CommunityFeedPage> {
        const params: Record<string, any> = { page, size }
        if (postType && postType !== 'ALL') {
            params.postType = postType
        }
        if (hashtag) {
            params.hashtag = hashtag
        }
        const res = await apiClient.get<any>('/community/feed', { params })
        return normalizeFeedPage(res.data)
    },

    async getFollowingFeed(page = 0, size = 10): Promise<CommunityFeedPage> {
        const res = await apiClient.get<any>('/community/feed/following', {
            params: { page, size },
        })
        return normalizeFeedPage(res.data)
    },

    async getMyPosts(page = 0, size = 10): Promise<CommunityFeedPage> {
        const res = await apiClient.get<any>('/community/feed/me', {
            params: { page, size },
        })
        return normalizeFeedPage(res.data)
    },

    async getSavedPosts(page = 0, size = 10): Promise<CommunityFeedPage> {
        const res = await apiClient.get<any>('/community/feed/saved', {
            params: { page, size },
        })
        return normalizeFeedPage(res.data)
    },

    async getUserFeed(userId: number, page = 0, size = 10): Promise<CommunityFeedPage> {
        const res = await apiClient.get<any>(`/community/feed/user/${userId}`, {
            params: { page, size },
        })
        return normalizeFeedPage(res.data)
    },

    async getUserProfile(userId: number): Promise<CommunityUserProfile> {
        const res = await apiClient.get<any>(`/community/feed/profile/${userId}`)
        const d = res.data
        return {
            userId: d.userId ?? d.id,
            displayName: d.displayName ?? d.name ?? 'Học viên',
            avatarUrl: d.avatarUrl || null,
            equippedFrameId: d.equippedFrameId || d.frame?.slug || null,
            streakDays: Number(d.streakDays) || 0,
            cefrLevel: d.cefrLevel || null,
            premium: Boolean(d.premium ?? d.isPremium),
            postCount: Number(d.postCount) || 0,
            followerCount: Number(d.followerCount) || 0,
            followingCount: Number(d.followingCount) || 0,
            followedByMe: Boolean(d.followedByMe ?? d.isFollowing),
        }
    },

    // ─── Post CRUD ───────────────────────────────────────────────────
    async getPost(id: number): Promise<CommunityPost> {
        const res = await apiClient.get<any>(`/community/posts/${id}`)
        return normalizePost(res.data)
    },

    async createPost(req: CreatePostRequest): Promise<CommunityPost> {
        const res = await apiClient.post<any>('/community/posts', req)
        return normalizePost(res.data)
    },

    async updatePost(id: number, req: UpdatePostRequest): Promise<CommunityPost> {
        const res = await apiClient.put<any>(`/community/posts/${id}`, req)
        return normalizePost(res.data)
    },

    async deletePost(id: number): Promise<void> {
        await apiClient.delete(`/community/posts/${id}`)
    },

    // ─── Interactions ────────────────────────────────────────────────
    async reactToPost(
        postId: number,
        reactionType?: ReactionType | null
    ): Promise<{ reactionCount: number; myReaction?: ReactionType | null }> {
        const res = await apiClient.post(`/community/posts/${postId}/react`, {
            reactionType: reactionType || null,
        })
        return {
            reactionCount: Number(res.data?.reactionCount ?? res.data?.likeCount) || 0,
            myReaction: res.data?.myReaction || null,
        }
    },

    async getPostReactions(
        postId: number,
        type?: ReactionType | null,
        page = 0,
        size = 50
    ): Promise<PostReactionSummary> {
        const params: Record<string, any> = { page, size }
        if (type && type !== ('ALL' as any)) {
            params.reactionType = type
        }
        const res = await apiClient.get<any>(`/community/posts/${postId}/reactions`, { params })
        const data = res.data || {}
        const rawReactors = Array.isArray(data.reactors) ? data.reactors : []
        const reactors: PostReactor[] = rawReactors.map((r: any) => ({
            user: normalizeAuthor(r.user),
            reactionType: r.reactionType,
            createdAt: r.createdAt ? String(r.createdAt) : new Date().toISOString(),
        }))
        return {
            totalCount: Number(data.totalCount) || 0,
            countsByType: data.countsByType || {},
            reactors,
        }
    },

    async getTrendingTopics(limit = 10): Promise<TrendingTopic[]> {
        try {
            const res = await apiClient.get<any>('/community/feed/trending', {
                params: { limit },
            })
            const list = Array.isArray(res.data) ? res.data : []
            return list.map((item: any) => ({
                tag: String(item.tag || ''),
                label: String(item.label || ''),
                postCount: Number(item.postCount) || 0,
                reactionCount: Number(item.reactionCount) || 0,
                commentCount: Number(item.commentCount) || 0,
                score: Number(item.score) || 0,
            }))
        } catch (err) {
            console.error('Failed to load trending topics', err)
            return []
        }
    },

    async savePost(postId: number): Promise<void> {
        await apiClient.post(`/community/posts/${postId}/save`)
    },

    async unsavePost(postId: number): Promise<void> {
        await apiClient.delete(`/community/posts/${postId}/save`)
    },

    async followUser(targetUserId: number): Promise<void> {
        await apiClient.post(`/community/users/${targetUserId}/follow`)
    },

    async unfollowUser(targetUserId: number): Promise<void> {
        await apiClient.delete(`/community/users/${targetUserId}/follow`)
    },

    async reportPost(postId: number, reason: ReportReason, details?: string): Promise<void> {
        await apiClient.post(`/community/posts/${postId}/report`, { reason, details })
    },

    // ─── Comments ────────────────────────────────────────────────────
    async getComments(postId: number, page = 0, size = 50): Promise<Comment[]> {
        const res = await apiClient.get<any>(`/community/posts/${postId}/comments`, {
            params: { page, size },
        })
        const data = res.data
        let rawList: any[] = []
        if (Array.isArray(data)) rawList = data
        else if (data && Array.isArray(data.items)) rawList = data.items
        else if (data && Array.isArray(data.posts)) rawList = data.posts
        else if (data && Array.isArray(data.comments)) rawList = data.comments
        const normalized = rawList.map(normalizeComment)
        return buildCommentTree(normalized)
    },

    async createComment(
        postId: number,
        content: string,
        parentId?: number | null,
        mediaUrl?: string | null,
        mediaType?: string | null,
        media?: { mediaUrl: string; mediaType?: string }[]
    ): Promise<Comment> {
        const pId = parentId !== undefined && parentId !== null ? Number(parentId) : null
        const payload: any = {
            content,
            parentId: pId,
            parentCommentId: pId,
            mediaUrl: mediaUrl || (media && media[0] ? media[0].mediaUrl : null),
            mediaType: mediaType || (media && media[0] ? media[0].mediaType : null),
        }
        if (media && media.length > 0) {
            payload.media = media.map((m) => ({
                mediaUrl: m.mediaUrl,
                mediaType: m.mediaType || (m.mediaUrl.endsWith('.mp4') || m.mediaUrl.endsWith('.webm') ? 'video/mp4' : 'image/jpeg'),
            }))
        }
        const res = await apiClient.post<any>(`/community/posts/${postId}/comments`, payload)
        return normalizeComment(res.data)
    },

    async deleteComment(commentId: number): Promise<void> {
        await apiClient.delete(`/community/comments/${commentId}`)
    },

    async reactToComment(
        commentId: number,
        reactionType?: ReactionType | null
    ): Promise<CommentReactionResponse> {
        const res = await apiClient.post(`/community/comments/${commentId}/react`, {
            reactionType: reactionType || null,
        })
        const d = res.data || {}
        return {
            commentId,
            reactionCount: Number(d.reactionCount ?? d.likeCount) || 0,
            myReaction: d.myReaction || null,
            reactionCounts: d.reactionCounts || {},
            topReactors: Array.isArray(d.topReactors) ? d.topReactors : [],
        }
    },

    async togglePostComments(postId: number, disabled: boolean): Promise<CommunityPost> {
        const res = await apiClient.post<any>(`/community/posts/${postId}/comments/toggle`, { disabled })
        return normalizePost(res.data)
    },

    async getMyRestriction(): Promise<CommunityUserRestriction | null> {
        try {
            const res = await apiClient.get<CommunityUserRestriction | null>('/community/users/me/restriction')
            return res.data || null
        } catch {
            return null
        }
    },

    async reportComment(
        commentId: number,
        reason: ReportReason,
        details?: string
    ): Promise<void> {
        await apiClient.post(`/community/comments/${commentId}/report`, { reason, details })
    },

    // ─── Media Upload ────────────────────────────────────────────────
    async uploadMedia(file: File): Promise<{ id?: number; mediaUrl: string; mediaType: string }> {
        const formData = new FormData()
        formData.append('file', file)
        const res = await apiClient.post<{ id?: number; url?: string; mediaUrl?: string; mediaType?: string; mimeType?: string }>(
            '/community/media/upload',
            formData,
            {
                headers: {
                    'Content-Type': 'multipart/form-data',
                },
            }
        )
        const d = res.data
        return {
            id: d.id,
            mediaUrl: d.mediaUrl || d.url || '',
            mediaType: d.mediaType || d.mimeType || 'image/jpeg',
        }
    },

    // ─── Admin Moderation ────────────────────────────────────────────
    async getModerationPosts(
        status?: PostStatus,
        page = 0,
        size = 10
    ): Promise<CommunityFeedPage> {
        const params: Record<string, any> = { page, size }
        if (status) {
            params.status = status
        }
        const res = await apiClient.get<any>('/admin/community/posts', { params })
        return normalizeFeedPage(res.data)
    },

    async getReports(status?: ReportStatus, page = 0, size = 20): Promise<ReportItem[]> {
        const params: Record<string, any> = { page, size }
        if (status) {
            params.status = status
        }
        const res = await apiClient.get<ReportItem[]>('/admin/community/reports', { params })
        return res.data
    },

    async moderatePost(postId: number, req: ModeratePostRequest): Promise<CommunityPost> {
        const res = await apiClient.post<any>(
            `/admin/community/posts/${postId}/moderate`,
            req
        )
        return normalizePost(res.data)
    },

    async publishOfficial(req: OfficialPublishRequest): Promise<CommunityPost> {
        const res = await apiClient.post<any>('/admin/community/official/publish', req)
        return normalizePost(res.data)
    },

    async pinPost(postId: number, pinned: boolean): Promise<CommunityPost> {
        const res = await apiClient.post<any>(
            `/admin/community/posts/${postId}/pin?pinned=${pinned}`,
            { pinned, isPinned: pinned }
        )
        return normalizePost(res.data)
    },

    async togglePin(postId: number, pinned: boolean): Promise<CommunityPost> {
        return this.pinPost(postId, pinned)
    },

    async featurePost(postId: number, featured: boolean): Promise<CommunityPost> {
        const res = await apiClient.post<any>(
            `/admin/community/posts/${postId}/feature?featured=${featured}`,
            { featured, isFeatured: featured }
        )
        return normalizePost(res.data)
    },

    async toggleFeature(postId: number, featured: boolean): Promise<CommunityPost> {
        return this.featurePost(postId, featured)
    },

    async lockComments(postId: number, reason?: string): Promise<CommunityPost> {
        const res = await apiClient.post<any>(`/admin/community/posts/${postId}/comments/lock`, { reason })
        return normalizePost(res.data)
    },

    async unlockComments(postId: number, reason?: string): Promise<CommunityPost> {
        const res = await apiClient.post<any>(`/admin/community/posts/${postId}/comments/unlock`, { reason })
        return normalizePost(res.data)
    },

    async createRestriction(req: CreateRestrictionRequest): Promise<CommunityUserRestriction> {
        const res = await apiClient.post<CommunityUserRestriction>('/admin/community/restrictions', req)
        return res.data
    },

    async revokeRestriction(restrictionId: number): Promise<CommunityUserRestriction> {
        const res = await apiClient.post<CommunityUserRestriction>(`/admin/community/restrictions/${restrictionId}/revoke`)
        return res.data
    },

    async getUserActiveRestriction(userId: number): Promise<CommunityUserRestriction | null> {
        try {
            const res = await apiClient.get<CommunityUserRestriction | null>(`/admin/community/users/${userId}/restrictions/active`)
            return res.data || null
        } catch {
            return null
        }
    },

    async getUserRestrictionHistory(userId: number): Promise<CommunityUserRestriction[]> {
        const res = await apiClient.get<CommunityUserRestriction[]>(`/admin/community/users/${userId}/restrictions/history`)
        return res.data || []
    },

    async getModerationHistory(postId: number): Promise<any[]> {
        const res = await apiClient.get<any[]>(`/admin/community/posts/${postId}/history`)
        return res.data || []
    },
}
