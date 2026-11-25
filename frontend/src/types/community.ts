export type AuthorType = 'USER' | 'OFFICIAL'

export type PostStatus =
    | 'DRAFT'
    | 'PENDING'
    | 'PUBLISHED'
    | 'REJECTED'
    | 'HIDDEN'
    | 'DELETED'
    | 'SCHEDULED'

export type PostType =
    | 'GENERAL'
    | 'QUESTION'
    | 'LEARNING'
    | 'ACHIEVEMENT'
    | 'CORRECTION_REQUEST'
    | 'OFFICIAL'

export type ReactionType =
    // 5 Default primary reactions
    | 'LOVE'
    | 'HAHA'
    | 'SUPPORT'
    | 'SAD'
    | 'USEFUL'
    // Extended reactions
    | 'WOW'
    | 'CONFUSED'
    | 'ANGRY'
    | 'CLAP'
    | 'FIRE'
    | 'THINKING'
    | 'CELEBRATE'
    // Legacy backward-compatible types
    | 'LIKE'
    | 'IDEA'
    | 'STRONG'

export type SharedEntityType = 'LISTENING_MATERIAL' | 'FLASHCARD_DECK' | 'EXAM_RESULT'

export type ReportReason =
    | 'SPAM'
    | 'HARASSMENT'
    | 'INAPPROPRIATE'
    | 'MISINFORMATION'
    | 'ADVERTISEMENT'
    | 'OTHER'

export type ReportStatus = 'PENDING' | 'RESOLVED' | 'DISMISSED'

export type ModerationAction = 'APPROVE' | 'REJECT' | 'HIDE' | 'DELETE' | 'RESTORE' | 'LOCK_COMMENTS' | 'UNLOCK_COMMENTS'

export interface AuthorSummary {
    id?: number | null
    userId: number | null
    name?: string
    displayName: string
    avatarUrl: string | null
    equippedFrameId: string | null
    frame?: any
    streakDays: number
    cefrLevel: string | null
    premium: boolean
    official: boolean
    isPremium?: boolean
    isOfficial?: boolean
    followedByMe?: boolean
    isFollowing?: boolean
}

export interface CommunityPostMedia {
    id: number
    mediaUrl: string
    mediaType: string
    type?: 'IMAGE' | 'VIDEO'
    sortOrder: number
    order?: number
    fileName?: string
    fileSize?: number
    width?: number | null
    height?: number | null
}

export interface SharedLearningEmbed {
    entityType: SharedEntityType
    entityId: number | string
    title: string
    subtitle?: string
    thumbnailUrl?: string
    actionUrl: string
    actionLabel: string
    metadata?: Record<string, any>
}

export interface CommunityPost {
    id: number
    author: AuthorSummary
    postType: PostType
    status: PostStatus
    content: string
    pinned: boolean
    isPinned?: boolean
    featured: boolean
    isFeatured?: boolean
    seriesName?: string
    seriesType?: string
    reactionCount: number
    likeCount?: number
    topReactions?: ReactionType[]
    commentCount: number
    saveCount?: number
    myReaction?: ReactionType | null
    savedByMe: boolean
    isSaved?: boolean
    followedByMe: boolean
    isFollowing?: boolean
    media: CommunityPostMedia[]
    sharedEmbed?: SharedLearningEmbed | null
    learningEmbed?: SharedLearningEmbed | null
    moderationNote?: string
    moderationReason?: string
    commentsDisabled?: boolean
    commentsDisabledByOwner?: boolean
    commentsLockedByAdmin?: boolean
    scheduledAt?: string
    publishedAt?: string
    createdAt: string
    updatedAt?: string
}

export interface CommentReactorPreview {
    userId?: number
    displayName: string
    reactionType: ReactionType
}

export interface CommentMediaItem {
    id?: number
    mediaUrl: string
    mediaType: string
    displayOrder?: number
}

export interface Comment {
    id: number
    postId: number
    parentId?: number | null
    parentCommentId?: number | null
    author: AuthorSummary
    replyToAuthorName?: string | null
    content: string
    mediaUrl?: string | null
    mediaType?: string | null
    media?: CommentMediaItem[]
    reactionCount: number
    likeCount?: number
    replyCount: number
    childrenCount?: number
    myReaction?: ReactionType | null
    isLiked?: boolean
    reactionCounts?: Record<string, number>
    topReactors?: CommentReactorPreview[]
    replies: Comment[]
    children?: Comment[]
    createdAt: string
}

export type CommunityRestrictionType = 'SUSPEND_COMMUNITY' | 'READ_ONLY' | 'NO_POST' | 'NO_COMMENT'

export interface CommunityUserRestriction {
    id: number
    targetUserId: number
    targetUserName?: string
    restrictionType: CommunityRestrictionType
    reason: string
    createdByAdminId: number
    createdByAdminName?: string
    createdAt: string
    expiresAt: string | null
    revokedAt: string | null
    active: boolean
    canPost?: boolean
    canComment?: boolean
    canReact?: boolean
    userMessage?: string
}

export interface CreateRestrictionRequest {
    targetUserId: number
    restrictionType: CommunityRestrictionType
    reason: string
    duration?: '1_DAY' | '3_DAYS' | '7_DAYS' | '30_DAYS' | 'CUSTOM' | 'PERMANENT'
    durationDays?: number
    permanent?: boolean
    customExpiresAt?: string
}

export interface ModerationRecord {
    id: number
    postId: number
    moderatorId: number
    action: ModerationAction
    reason?: string | null
    note?: string | null
    createdAt: string
}

export interface CommentReactionResponse {
    commentId: number
    reactionCount: number
    myReaction: ReactionType | null
    reactionCounts: Record<string, number>
    topReactors: CommentReactorPreview[]
}

export interface CommunityUserProfile {
    userId: number
    displayName: string
    avatarUrl: string | null
    equippedFrameId: string | null
    streakDays: number
    cefrLevel: string | null
    premium: boolean
    postCount: number
    followerCount: number
    followingCount: number
    followedByMe: boolean
}

export interface CommunityFeedPage {
    posts: CommunityPost[]
    items?: CommunityPost[]
    page: number
    size: number
    totalElements: number
    totalPages: number
    hasMore: boolean
}

export interface CreatePostRequest {
    content: string
    postType?: PostType
    mediaIds?: number[]
    mediaUrls?: string[]
    sharedEntityType?: SharedEntityType
    sharedEntityId?: number | string
}

export interface UpdatePostRequest {
    content: string
    mediaIds?: number[]
    mediaUrls?: string[]
}

export interface OfficialPublishRequest {
    content: string
    postType?: PostType
    pinned?: boolean
    isPinned?: boolean
    featured?: boolean
    isFeatured?: boolean
    seriesName?: string
    seriesType?: string
    scheduledAt?: string
    scheduledFor?: string
    mediaIds?: number[]
    mediaUrls?: string[]
    sharedEntityType?: SharedEntityType
    sharedEntityId?: number | string
}

export interface ModeratePostRequest {
    action: ModerationAction
    reason?: string
    note?: string
}

export interface ReportItem {
    id: number
    postId: number
    reporterId: number
    reason: ReportReason
    details?: string
    status: ReportStatus
    createdAt: string
    post?: CommunityPost
}

export interface PostReactor {
    user: AuthorSummary
    reactionType: ReactionType
    createdAt: string
}

export interface PostReactionSummary {
    totalCount: number
    countsByType: Record<string, number>
    reactors: PostReactor[]
}

export interface TrendingTopic {
    tag: string
    label: string
    postCount: number
    reactionCount: number
    commentCount: number
    score: number
}
