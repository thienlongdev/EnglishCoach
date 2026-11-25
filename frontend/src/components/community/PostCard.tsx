'use client'

import React, { useState, useEffect } from 'react'
import {
    MoreHorizontal,
    Bookmark,
    AlertTriangle,
    Trash2,
    CheckCircle2,
    Crown,
    Flame,
    Award,
    Clock,
    UserPlus,
    UserCheck,
    Lock,
    MessageSquareOff,
    MessageSquare,
    Star,
    Pin,
} from 'lucide-react'
import { CommunityPost } from '@/types/community'
import { AuthorAvatar } from './AuthorAvatar'
import { PostMediaGallery } from './PostMediaGallery'
import { SharedLearningCard } from './SharedLearningCard'
import { ReactionBar } from './ReactionBar'
import { PostDetailModal } from './PostDetailModal'
import { ReportModal } from './ReportModal'
import { LinkifiedText } from './LinkifiedText'
import { communityApi } from '@/services/communityApi'
import dynamic from 'next/dynamic'
import { subscribeToPostUpdates } from '@/services/communityCache'
import styles from './communityGlass.module.css'

interface PostCardProps {
    post: CommunityPost
    currentUserId?: number | null
    isAdmin?: boolean
    onPostDeleted?: (postId: number) => void
    onPostUpdated?: (updated: CommunityPost) => void
    onHashtagClick?: (tag: string) => void
}

function formatRelativeTime(dateString?: string): string {
    if (!dateString) return ''
    const diff = Date.now() - new Date(dateString).getTime()
    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return 'Vừa xong'
    if (minutes < 60) return `${minutes} phút trước`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} giờ trước`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days} ngày trước`
    return new Date(dateString).toLocaleDateString('vi-VN')
}

// The colour family of each post type (card current, type chip): presentation only.
const POST_TONE: Record<string, string> = { GENERAL: 'general', QUESTION: 'question', CORRECTION_REQUEST: 'correction', ACHIEVEMENT: 'achievement', LEARNING: 'learning', OFFICIAL: 'official' }

const POST_TYPE_LABELS: Record<string, { label: string; color: string }> = {
    GENERAL: { label: 'Chia sẻ', color: 'bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20' },
    QUESTION: { label: 'Hỏi đáp', color: 'bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20' },
    LEARNING: { label: 'Bài học', color: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20' },
    ACHIEVEMENT: { label: 'Thành tích', color: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20' },
    CORRECTION_REQUEST: { label: 'Nhờ sửa câu', color: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20' },
    OFFICIAL: { label: 'Chính thức', color: 'bg-gradient-to-r from-cyan-500/15 to-blue-600/15 dark:from-cyan-500/20 dark:to-blue-600/20 text-cyan-700 dark:text-cyan-300 border-cyan-400/30 font-bold' },
}

const PersonCard = dynamic(() => import('@/components/messenger/PersonCard'), { ssr: false })

export function PostCard({
    post,
    currentUserId,
    isAdmin,
    onPostDeleted,
    onPostUpdated,
    onHashtagClick,
}: PostCardProps) {
    const [postState, setPostState] = useState(post)
    const [isDetailOpen, setIsDetailOpen] = useState(false)
    const [isReportOpen, setIsReportOpen] = useState(false)
    const [showMenu, setShowMenu] = useState(false)
    const [followed, setFollowed] = useState(post.followedByMe)
    const [showPerson, setShowPerson] = useState(false)
    const [isFollowLoading, setIsFollowLoading] = useState(false)

    useEffect(() => {
        setPostState(post)
    }, [post])

    // Keep postState in sync with all reaction / save / comment updates across feed and modal
    useEffect(() => {
        const unsubscribe = subscribeToPostUpdates((event) => {
            if (event.postId === post.id) {
                setPostState((prev) => {
                    const next = {
                        ...prev,
                        ...(event.myReaction !== undefined ? { myReaction: event.myReaction } : {}),
                        ...(event.reactionCount !== undefined ? { reactionCount: event.reactionCount, likeCount: event.reactionCount } : {}),
                        ...(event.savedByMe !== undefined ? { savedByMe: event.savedByMe, isSaved: event.savedByMe } : {}),
                        ...(event.commentCount !== undefined ? { commentCount: event.commentCount } : {}),
                    }
                    onPostUpdated?.(next)
                    return next
                })
            }
        })
        return unsubscribe
    }, [post.id, onPostUpdated])

    const isAuthor = currentUserId != null && post.author.userId === currentUserId
    const canDelete = isAuthor || isAdmin

    const handleFollowToggle = async () => {
        if (!post.author.userId || isFollowLoading) return
        setIsFollowLoading(true)
        const prev = followed
        setFollowed(!prev)
        try {
            if (prev) {
                await communityApi.unfollowUser(post.author.userId)
            } else {
                await communityApi.followUser(post.author.userId)
            }
        } catch (err) {
            console.error('Failed to toggle follow', err)
            setFollowed(prev)
        } finally {
            setIsFollowLoading(false)
        }
    }

    const handleToggleComments = async () => {
        const nextState = !post.commentsDisabledByOwner
        try {
            const updated = await communityApi.togglePostComments(post.id, nextState)
            onPostUpdated?.(updated)
        } catch (err: unknown) {
            console.error('Failed to toggle comments', err)
        }
    }

    const handleDelete = async () => {
        if (!confirm('Bạn có chắc chắn muốn xóa bài viết này?')) return
        try {
            await communityApi.deletePost(post.id)
            onPostDeleted?.(post.id)
        } catch (err) {
            console.error('Failed to delete post', err)
        }
    }

    const typeMeta = POST_TYPE_LABELS[post.postType] || POST_TYPE_LABELS.GENERAL

    return (
        <>
            <article
                className={`${styles.panel} ${styles.post}`}
                data-tone={post.author.official ? 'official' : POST_TONE[post.postType] || 'general'}
                data-official={post.author.official ? 'true' : undefined}
            >
                {/* Pinned banner if pinned */}
                {post.pinned && (
                    <div className={styles.postBanner}>
                        <Pin aria-hidden="true" />
                        <span>Đã ghim</span>
                    </div>
                )}

                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <AuthorAvatar author={post.author} size="sm" />

                        <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-bold text-slate-900 dark:text-white text-sm tracking-tight truncate max-w-[180px] sm:max-w-none">
                                    {post.author.displayName}
                                </span>

                                {/* Official EnglishCoach Verified Icon (No redundant pill) */}
                                {post.author.official && (
                                    <span title="EnglishCoach Official" className="inline-flex items-center">
                                        <CheckCircle2 className="w-4 h-4 text-cyan-500 fill-cyan-500/20 shrink-0" />
                                    </span>
                                )}

                                {/* Premium badge */}
                                {post.author.premium && !post.author.official && (
                                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-full text-[9px] font-extrabold bg-gradient-to-r from-amber-500 to-yellow-400 text-slate-950">
                                        <Crown className="w-2.5 h-2.5" />
                                        PRO
                                    </span>
                                )}

                                {/* CEFR badge */}
                                {post.author.cefrLevel && !post.author.official && (
                                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-md text-[9px] font-bold bg-sky-100 dark:bg-sky-900/60 text-sky-800 dark:text-cyan-300 border border-sky-300 dark:border-sky-700/40">
                                        <Award className="w-2.5 h-2.5" />
                                        {post.author.cefrLevel}
                                    </span>
                                )}

                                {/* Streak badge */}
                                {post.author.streakDays > 0 && !post.author.official && (
                                    <span className="inline-flex items-center gap-0.5 text-[11px] font-bold text-amber-500 dark:text-amber-400">
                                        <Flame className="w-3 h-3 fill-amber-500 dark:fill-amber-400" />
                                        {post.author.streakDays}
                                    </span>
                                )}
                            </div>

                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 [&>span]:whitespace-nowrap">
                                <span>{formatRelativeTime(post.createdAt)}</span>
                                {post.postType && post.postType !== 'GENERAL' && typeMeta && (
                                    <>
                                        <span>•</span>
                                        <span className={styles.typeChip}>
                                            {typeMeta.label}
                                        </span>
                                    </>
                                )}
                                {post.featured && (
                                    <>
                                        <span>•</span>
                                        <span className="inline-flex items-center gap-1 px-2 py-0.2 rounded-md font-bold border text-[10px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30">
                                            <Star className="w-3 h-3 fill-amber-400 text-amber-500" aria-hidden="true" />
                                            Nổi bật
                                        </span>
                                    </>
                                )}

                                {/* Moderation state badge for owner */}
                                {post.status === 'PENDING' && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.2 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/40 text-[10px] font-bold animate-pulse">
                                        <Clock className="w-3 h-3" />
                                        Đang chờ duyệt
                                    </span>
                                )}
                                {post.status === 'REJECTED' && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.2 rounded-md bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/40 text-[10px] font-bold">
                                        <AlertTriangle className="w-3 h-3" />
                                        Bị từ chối
                                    </span>
                                )}

                                {/* Comment status badge */}
                                {Boolean(post.commentsDisabled || post.commentsDisabledByOwner || post.commentsLockedByAdmin) && (
                                    <span
                                        className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700/60 text-[10px] font-semibold"
                                        title={
                                            post.commentsLockedByAdmin
                                                ? 'Bình luận đã bị khóa bởi quản trị viên'
                                                : 'Bình luận đã tắt cho bài viết này'
                                        }
                                    >
                                        <Lock className="w-2.5 h-2.5" />
                                        <span>Tắt bình luận</span>
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Actions Menu */}
                    <div className="relative">
                        <button
                            type="button"
                            onClick={() => setShowMenu(!showMenu)}
                            className={styles.menuBtn}
                            aria-label="Tùy chọn bài viết"
                            aria-haspopup="menu"
                            aria-expanded={showMenu}
                        >
                            <MoreHorizontal className="w-4 h-4" />
                        </button>

                        {showMenu && (
                            <div
                                className={`${styles.menu} space-y-1 animate-in fade-in zoom-in-95 duration-150`}
                                onMouseLeave={() => setShowMenu(false)}
                            >
                                {/* Author toggle comments */}
                                {isAuthor && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowMenu(false)
                                            handleToggleComments()
                                        }}
                                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition cursor-pointer text-left"
                                    >
                                        {post.commentsDisabledByOwner ? (
                                            <>
                                                <MessageSquare className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
                                                <span>Bật bình luận</span>
                                            </>
                                        ) : (
                                            <>
                                                <MessageSquareOff className="w-4 h-4 text-amber-500 dark:text-amber-400" />
                                                <span>Tắt bình luận</span>
                                            </>
                                        )}
                                    </button>
                                )}

                                {!isAuthor && !post.author.official && post.author.userId && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowMenu(false)
                                            setShowPerson(true)
                                        }}
                                        data-testid="post-open-person"
                                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors text-left"
                                    >
                                        <UserCheck className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                                        <span>Xem hồ sơ và nhắn tin</span>
                                    </button>
                                )}

                                {!isAuthor && !post.author.official && post.author.userId && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowMenu(false)
                                            handleFollowToggle()
                                        }}
                                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10 transition cursor-pointer text-left"
                                    >
                                        {followed ? (
                                            <>
                                                <UserCheck className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
                                                <span>Bỏ theo dõi</span>
                                            </>
                                        ) : (
                                            <>
                                                <UserPlus className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                                                <span>Theo dõi tác giả</span>
                                            </>
                                        )}
                                    </button>
                                )}

                                {!isAuthor && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowMenu(false)
                                            setIsReportOpen(true)
                                        }}
                                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer text-left"
                                    >
                                        <AlertTriangle className="w-4 h-4" />
                                        <span>Báo cáo bài viết</span>
                                    </button>
                                )}

                                {isAdmin && (
                                    <>
                                        <button
                                            type="button"
                                            onClick={async () => {
                                                setShowMenu(false)
                                                try {
                                                    const updated = await communityApi.pinPost(post.id, !post.pinned)
                                                    onPostUpdated?.(updated)
                                                } catch (e) {
                                                    console.error('Failed to toggle pin', e)
                                                }
                                            }}
                                            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10 transition cursor-pointer text-left"
                                        >
                                            <Pin className="w-4 h-4" />
                                            <span>{post.pinned ? 'Bỏ ghim bài viết' : 'Ghim bài viết'}</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={async () => {
                                                setShowMenu(false)
                                                try {
                                                    const updated = await communityApi.featurePost(post.id, !post.featured)
                                                    onPostUpdated?.(updated)
                                                } catch (e) {
                                                    console.error('Failed to toggle feature', e)
                                                }
                                            }}
                                            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 transition cursor-pointer text-left"
                                        >
                                            <Star className="w-4 h-4" />
                                            <span>{post.featured ? 'Bỏ đánh dấu nổi bật' : 'Đánh dấu nổi bật'}</span>
                                        </button>
                                    </>
                                )}

                                {canDelete && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowMenu(false)
                                            handleDelete()
                                        }}
                                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer text-left"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        <span>{isAdmin && !isAuthor ? 'Quản trị viên xóa' : 'Xóa bài viết'}</span>
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Rejection Note if rejected */}
                {post.status === 'REJECTED' && post.moderationNote && (
                    <div className="mt-3 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-700 dark:text-rose-300">
                        <strong>Lý do từ chối:</strong> {post.moderationNote}
                    </div>
                )}

                {/* Post Text Content */}
                <div className={styles.postBody}>
                    <LinkifiedText text={post.content} onHashtagClick={onHashtagClick} />
                </div>

                {/* Media Gallery */}
                {post.media && post.media.length > 0 && (
                    <PostMediaGallery media={post.media} />
                )}

                {/* Shared Learning Embed */}
                {post.sharedEmbed && (
                    <SharedLearningCard embed={post.sharedEmbed} />
                )}

                {/* Reaction Bar */}
                <ReactionBar
                    post={postState}
                    currentUserId={currentUserId ?? undefined}
                    onCommentClick={() => setIsDetailOpen(true)}
                />
            </article>

            {/* Post Detail Modal */}
            <PostDetailModal
                post={postState}
                isOpen={isDetailOpen}
                onClose={() => setIsDetailOpen(false)}
                onPostUpdated={onPostUpdated}
            />

            {showPerson && post.author.userId && <PersonCard userId={post.author.userId} name={post.author.name} onClose={() => setShowPerson(false)} />}

            {/* Report Modal */}
            <ReportModal
                postId={post.id}
                isOpen={isReportOpen}
                onClose={() => setIsReportOpen(false)}
            />
        </>
    )
}
