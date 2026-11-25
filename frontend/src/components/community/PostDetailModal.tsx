'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
    X,
    Send,
    MessageSquare,
    Loader2,
    RotateCcw,
    CheckCircle2,
    Lock,
    ShieldAlert,
    AlertCircle,
    Image as ImageIcon,
    Video as VideoIcon,
    Smile,
} from 'lucide-react'
import { CommunityPost, Comment, CommunityUserRestriction } from '@/types/community'
import { communityApi, buildCommentTree } from '@/services/communityApi'
import {
    patchCommentCountInAllCaches,
    getCachedCommentTree,
    setCachedCommentTree,
    patchCachedCommentReply,
    patchCachedCommentDelete,
    subscribeToPostUpdates,
} from '@/services/communityCache'
import { AuthorAvatar } from './AuthorAvatar'
import { UserAvatar } from '@/components/common/UserAvatar'
import { CommentItem, renderCommentTree } from './CommentItem'
import { PostMediaGallery } from './PostMediaGallery'
import { SharedLearningCard } from './SharedLearningCard'
import { ReactionBar } from './ReactionBar'
import { ShareSheet } from './ShareSheet'
import { LinkifiedText } from './LinkifiedText'
import { ComposerEmojiPicker } from './ComposerEmojiPicker'
import { useSession } from 'next-auth/react'
import { useCurrentRole } from '@/hooks/useCurrentRole'
import { useLanguage } from '@/context/LanguageContext'
import styles from './communityGlass.module.css'

interface CommentMediaAttachment {
    file: File
    previewUrl: string
    type: 'IMAGE' | 'VIDEO'
    stagedUrl?: string
    stagedType?: string
}

interface PostDetailModalProps {
    post: CommunityPost
    isOpen: boolean
    onClose: () => void
    onPostUpdated?: (updated: CommunityPost) => void
}

function insertReplyRecursively(
    list: Comment[],
    targetParentId: number,
    newReply: Comment
): Comment[] {
    return list.map((item) => {
        if (item.id === targetParentId) {
            return {
                ...item,
                replyCount: (item.replyCount || 0) + 1,
                replies: [...(item.replies || []), newReply],
            }
        }
        if (item.replies && item.replies.length > 0) {
            return {
                ...item,
                replies: insertReplyRecursively(item.replies, targetParentId, newReply),
            }
        }
        return item
    })
}

function deleteCommentRecursively(list: Comment[], targetId: number): Comment[] {
    return list
        .filter((item) => item.id !== targetId)
        .map((item) => ({
            ...item,
            replies: item.replies ? deleteCommentRecursively(item.replies, targetId) : [],
        }))
}

export function PostDetailModal({
    post,
    isOpen,
    onClose,
    onPostUpdated,
}: PostDetailModalProps) {
    const { locale } = useLanguage()
    const [currentPost, setCurrentPost] = useState(post)

    useEffect(() => {
        setCurrentPost(post)
    }, [post])

    // Unified reaction & post update sync across feed and modal
    useEffect(() => {
        const unsubscribe = subscribeToPostUpdates((event) => {
            if (event.postId === post.id) {
                setCurrentPost((prev) => {
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

    const { data: session } = useSession()
    const currentUserId = (session?.user as any)?.id ? Number((session?.user as any)?.id) : null
    const currentUserName = session?.user?.name || undefined
    const { isAdmin } = useCurrentRole()

    const [comments, setComments] = useState<Comment[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [commentText, setCommentText] = useState('')
    const [commentMediaList, setCommentMediaList] = useState<CommentMediaAttachment[]>([])
    const [showEmojiPicker, setShowEmojiPicker] = useState(false)
    const [emojiAnchorRect, setEmojiAnchorRect] = useState<DOMRect | null>(null)
    const [uploadingMedia, setUploadingMedia] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [commentError, setCommentError] = useState<string | null>(null)
    const [replyingTo, setReplyingTo] = useState<Comment | null>(null)
    const [shareOpen, setShareOpen] = useState(false)
    const [restriction, setRestriction] = useState<CommunityUserRestriction | null>(null)

    const inputRef = useRef<HTMLInputElement>(null)
    const imageInputRef = useRef<HTMLInputElement>(null)
    const videoInputRef = useRef<HTMLInputElement>(null)
    const emojiBtnRef = useRef<HTMLButtonElement>(null)
    const commentsEndRef = useRef<HTMLDivElement>(null)

    const imageCount = commentMediaList.filter((m) => m.type === 'IMAGE').length
    const videoCount = commentMediaList.filter((m) => m.type === 'VIDEO').length

    // Check restriction
    useEffect(() => {
        if (session?.user) {
            communityApi.getMyRestriction()
                .then((r) => {
                    if (r && r.active) setRestriction(r)
                    else setRestriction(null)
                })
                .catch(() => setRestriction(null))
        }
    }, [session?.user])

    const isCommentsDisabled = Boolean(
        post.commentsDisabled || post.commentsDisabledByOwner || post.commentsLockedByAdmin
    )
    const isCommentRestricted = Boolean(restriction && !restriction.canComment)

    useEffect(() => {
        if (isOpen && !isCommentsDisabled && !isCommentRestricted) inputRef.current?.focus()
    }, [isOpen, isCommentsDisabled, isCommentRestricted])

    // Body scroll lock & ESC key listener
    useEffect(() => {
        if (!isOpen) return

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', handleKeyDown)
        const originalOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'

        return () => {
            document.removeEventListener('keydown', handleKeyDown)
            document.body.style.overflow = originalOverflow
        }
    }, [isOpen, onClose])

    // Load comments with safe unwrapping & isolated error state
    const fetchComments = useCallback(async () => {
        const cached = getCachedCommentTree(post.id)
        if (cached && cached.length > 0) {
            setComments(cached)
            setLoading(false)
        } else {
            setLoading(true)
        }
        setError(null)
        try {
            const data = await communityApi.getComments(post.id)
            const list = Array.isArray(data) ? data : ((data as any)?.items || (data as any)?.posts || [])
            const tree = buildCommentTree(list)
            setComments(tree)
            setCachedCommentTree(post.id, tree)
        } catch (err) {
            console.error('Failed to load comments', err)
            if (!cached || cached.length === 0) {
                setError('Không thể tải bình luận. Vui lòng thử lại.')
            }
        } finally {
            setLoading(false)
        }
    }, [post.id])

    useEffect(() => {
        if (!isOpen) return
        fetchComments()
    }, [isOpen, fetchComments])

    const handleReply = (targetComment: Comment) => {
        setReplyingTo(targetComment)
        inputRef.current?.focus()
    }

    const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || [])
        if (files.length === 0) return

        const currentImages = commentMediaList.filter((m) => m.type === 'IMAGE').length
        if (currentImages >= 5) {
            setCommentError('Bình luận tối đa 5 hình ảnh')
            e.target.value = ''
            return
        }

        const allowedCount = 5 - currentImages
        const filesToAdd = files.slice(0, allowedCount)
        if (files.length > allowedCount) {
            setCommentError(`Chỉ có thể thêm thêm ${allowedCount} ảnh (tối đa 5 ảnh)`)
        } else {
            setCommentError(null)
        }

        const newAttachments: CommentMediaAttachment[] = []
        for (const file of filesToAdd) {
            if (!file.type.startsWith('image/')) {
                setCommentError('Chỉ hỗ trợ file ảnh (JPG, PNG, WebP, GIF)')
                continue
            }
            if (file.size > 10 * 1024 * 1024) {
                setCommentError('Mỗi ảnh không được vượt quá 10MB')
                continue
            }
            newAttachments.push({
                file,
                previewUrl: URL.createObjectURL(file),
                type: 'IMAGE',
            })
        }

        if (newAttachments.length > 0) {
            setCommentMediaList((prev) => [...prev, ...newAttachments])
        }
        e.target.value = ''
    }

    const handleVideoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return

        const currentVideos = commentMediaList.filter((m) => m.type === 'VIDEO').length
        if (currentVideos >= 1) {
            setCommentError('Bình luận tối đa 1 video')
            e.target.value = ''
            return
        }

        if (!file.type.startsWith('video/')) {
            setCommentError('Chỉ hỗ trợ file video (MP4, WebM)')
            e.target.value = ''
            return
        }
        if (file.size > 30 * 1024 * 1024) {
            setCommentError('Video không được vượt quá 30MB')
            e.target.value = ''
            return
        }

        setCommentMediaList((prev) => [
            ...prev,
            {
                file,
                previewUrl: URL.createObjectURL(file),
                type: 'VIDEO',
            },
        ])
        setCommentError(null)
        e.target.value = ''
    }

    const handleRemoveMediaItem = (index: number) => {
        setCommentMediaList((prev) => {
            const target = prev[index]
            if (target?.previewUrl) {
                URL.revokeObjectURL(target.previewUrl)
            }
            return prev.filter((_, i) => i !== index)
        })
    }

    const handleToggleEmojiPicker = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation()
        if (!showEmojiPicker && emojiBtnRef.current) {
            setEmojiAnchorRect(emojiBtnRef.current.getBoundingClientRect())
            setShowEmojiPicker(true)
        } else {
            setShowEmojiPicker(false)
        }
    }

    const handleInsertEmoji = (emoji: string) => {
        if (inputRef.current) {
            const start = inputRef.current.selectionStart ?? commentText.length
            const end = inputRef.current.selectionEnd ?? commentText.length
            const nextText = commentText.slice(0, start) + emoji + commentText.slice(end)
            setCommentText(nextText)
            setTimeout(() => {
                if (inputRef.current) {
                    inputRef.current.focus()
                    inputRef.current.setSelectionRange(start + emoji.length, start + emoji.length)
                }
            }, 0)
        } else {
            setCommentText((prev) => prev + emoji)
        }
    }

    const handleSendComment = async (e: React.FormEvent) => {
        e.preventDefault()
        const text = commentText.trim()
        if ((!text && commentMediaList.length === 0) || submitting) return

        const currentImages = commentMediaList.filter((m) => m.type === 'IMAGE').length
        const currentVideos = commentMediaList.filter((m) => m.type === 'VIDEO').length
        if (currentImages > 5) {
            setCommentError('Bình luận tối đa 5 hình ảnh')
            return
        }
        if (currentVideos > 1) {
            setCommentError('Bình luận tối đa 1 video')
            return
        }

        setSubmitting(true)
        setCommentError(null)

        // Snapshot current attachments and staged state
        const attachmentsSnapshot = [...commentMediaList]
        const tempId = -Date.now()
        const targetParentId = replyingTo ? replyingTo.id : null
        const replyToName = replyingTo ? replyingTo.author.displayName : null

        const optimisticMediaItems = attachmentsSnapshot.map((m, idx) => ({
            id: -idx - 1,
            mediaUrl: m.stagedUrl || m.previewUrl,
            mediaType: m.stagedType || (m.type === 'VIDEO' ? 'video/mp4' : 'image/jpeg'),
            displayOrder: idx,
        }))

        const optimisticComment: Comment = {
            id: tempId,
            postId: post.id,
            author: {
                userId: currentUserId || 0,
                displayName: currentUserName || 'Bạn',
                avatarUrl: session?.user?.image || null,
                equippedFrameId: null,
                streakDays: 0,
                cefrLevel: null,
                premium: false,
                official: isAdmin,
            },
            parentCommentId: targetParentId,
            parentId: targetParentId,
            replyToAuthorName: replyToName,
            content: text,
            media: optimisticMediaItems,
            mediaUrl: optimisticMediaItems[0]?.mediaUrl,
            mediaType: optimisticMediaItems[0]?.mediaType,
            reactionCount: 0,
            replyCount: 0,
            replies: [],
            children: [],
            createdAt: new Date().toISOString(),
        }

        // 1. Optimistic Update: insert under correct parent immediately
        if (targetParentId) {
            setComments((prev) => insertReplyRecursively(prev, targetParentId, optimisticComment))
            patchCachedCommentReply(post.id, targetParentId, optimisticComment)
        } else {
            setComments((prev) => [...prev, optimisticComment])
            patchCachedCommentReply(post.id, null, optimisticComment)
        }
        patchCommentCountInAllCaches(post.id, 1)
        onPostUpdated?.({
            ...post,
            commentCount: post.commentCount + 1,
        })

        // Clear composer state immediately for smooth UX
        setCommentText('')
        setCommentMediaList([])
        setReplyingTo(null)
        setShowEmojiPicker(false)

        setTimeout(() => {
            commentsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
        }, 100)

        try {
            // 2. Upload any unstaged media attachments
            const uploadedMediaPayload: { mediaUrl: string; mediaType: string }[] = []
            if (attachmentsSnapshot.length > 0) {
                setUploadingMedia(true)
                for (const item of attachmentsSnapshot) {
                    if (item.stagedUrl) {
                        uploadedMediaPayload.push({
                            mediaUrl: item.stagedUrl,
                            mediaType: item.stagedType || (item.type === 'VIDEO' ? 'video/mp4' : 'image/jpeg'),
                        })
                    } else {
                        const uploaded = await communityApi.uploadMedia(item.file)
                        item.stagedUrl = uploaded.mediaUrl
                        item.stagedType = uploaded.mediaType
                        uploadedMediaPayload.push({
                            mediaUrl: uploaded.mediaUrl,
                            mediaType: uploaded.mediaType,
                        })
                    }
                }
            }

            // 3. Create comment on backend
            const authoritativeComment = await communityApi.createComment(
                post.id,
                text,
                targetParentId,
                uploadedMediaPayload[0]?.mediaUrl,
                uploadedMediaPayload[0]?.mediaType,
                uploadedMediaPayload
            )

            // 4. Replace temporary optimistic comment with authoritative comment
            function replaceTempComment(list: Comment[]): Comment[] {
                return list.map((c) => {
                    if (c.id === tempId) {
                        return {
                            ...authoritativeComment,
                            replies: c.replies || [],
                            children: c.replies || [],
                        }
                    }
                    if (c.replies && c.replies.length > 0) {
                        const nextReplies = replaceTempComment(c.replies)
                        return {
                            ...c,
                            replies: nextReplies,
                            children: nextReplies,
                        }
                    }
                    return c
                })
            }

            setComments((prev) => {
                const replaced = replaceTempComment(prev)
                setCachedCommentTree(post.id, replaced)
                return replaced
            })

            // Revoke temporary object URLs
            attachmentsSnapshot.forEach((m) => {
                if (m.previewUrl) URL.revokeObjectURL(m.previewUrl)
            })
        } catch (err: unknown) {
            console.error('Failed to post comment', err)
            // Rollback optimistic comment on error
            setComments((prev) => {
                const rolledBack = deleteCommentRecursively(prev, tempId)
                setCachedCommentTree(post.id, rolledBack)
                return rolledBack
            })
            patchCommentCountInAllCaches(post.id, -1)
            onPostUpdated?.({
                ...post,
                commentCount: Math.max(0, post.commentCount),
            })

            // Restore text & attachments so user doesn't lose their input
            setCommentText(text)
            setCommentMediaList(attachmentsSnapshot)

            const msg =
                err instanceof Error && err.message
                    ? err.message
                    : 'Không thể gửi bình luận. Vui lòng thử lại.'
            setCommentError(msg)
        } finally {
            setSubmitting(false)
            setUploadingMedia(false)
        }
    }

    const handleDeleteComment = (commentId: number) => {
        setComments((prev) => {
            const next = deleteCommentRecursively(prev, commentId)
            patchCachedCommentDelete(post.id, commentId)
            return next
        })
        // Patch cache and callback
        patchCommentCountInAllCaches(post.id, -1)
        onPostUpdated?.({
            ...post,
            commentCount: Math.max(0, post.commentCount - 1),
        })
    }

    if (!isOpen) return null

    const modalContent = (
        <div
            className={`${styles.world} fixed inset-0 z-50 bg-black/60 dark:bg-black/80 flex items-center justify-center p-2 sm:p-4 animate-in fade-in duration-200`}
            onClick={onClose}
        >
            <div
                className={`${styles.dialog} w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 text-on-surface dark:text-slate-200`}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Modal Header */}
                <div className="px-5 py-3.5 border-b border-border dark:border-sky-900/40 flex items-center justify-between bg-surface-container-low/50 dark:bg-white/[0.02]">
                    <div className="flex items-center gap-2">
                        <MessageSquare className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
                        <h3 className="font-bold text-slate-900 dark:text-white text-base tracking-tight">
                            Bài viết
                        </h3>
                    </div>
                    <button
                        type="button"
                        aria-label="Đóng"
                        onClick={onClose}
                        className="p-1.5 rounded-xl text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition cursor-pointer"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Modal Scrollable Body */}
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                    {/* Original Post Header */}
                    <div className="flex items-start gap-3">
                        <AuthorAvatar author={currentPost.author} size="sm" />
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-bold text-slate-900 dark:text-white text-sm">
                                    {currentPost.author.displayName}
                                </span>
                                {currentPost.author.official && (
                                    <CheckCircle2 className="w-4 h-4 text-cyan-500 dark:text-cyan-400 fill-cyan-500/20 flex-shrink-0" />
                                )}
                                {currentPost.pinned && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border border-cyan-500/30">
                                        📌 Đã ghim
                                    </span>
                                )}
                                {currentPost.featured && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/30">
                                        ⭐ Nổi bật
                                    </span>
                                )}
                            </div>
                            <span className="text-xs text-slate-500 dark:text-slate-400">
                                {new Date(currentPost.createdAt).toLocaleDateString('vi-VN', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    day: '2-digit',
                                    month: '2-digit',
                                })}
                            </span>
                        </div>
                    </div>

                    {/* Content */}
                    <p className="text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap leading-relaxed">
                        <LinkifiedText text={currentPost.content} />
                    </p>

                    {/* Attachments */}
                    {currentPost.media && currentPost.media.length > 0 && (
                        <PostMediaGallery media={currentPost.media} />
                    )}

                    {currentPost.sharedEmbed && (
                        <SharedLearningCard embed={currentPost.sharedEmbed} />
                    )}

                    {/* Reaction Bar */}
                    <ReactionBar
                        post={currentPost}
                        currentUserId={currentUserId ?? undefined}
                        onCommentClick={() => inputRef.current?.focus()}
                        onShareClick={() => setShareOpen(true)}
                    />

                    {/* Comments Divider */}
                    <div className="pt-2">
                        <div className="h-px bg-slate-200 dark:bg-sky-900/30 mb-3" />
                        <h4 className="font-bold text-xs text-cyan-700 dark:text-sky-400/80 uppercase tracking-wider mb-3">
                            Bình luận ({comments.length})
                        </h4>

                        {loading ? (
                            <div className="py-8 flex items-center justify-center text-slate-500 dark:text-slate-400 gap-2">
                                <Loader2 className="w-5 h-5 animate-spin text-cyan-500 dark:text-cyan-400" />
                                <span>Đang tải bình luận...</span>
                            </div>
                        ) : error ? (
                            <div className="py-8 text-center space-y-2.5">
                                <p className="text-xs text-rose-500 dark:text-rose-400">{error}</p>
                                <button
                                    type="button"
                                    onClick={fetchComments}
                                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-300 border border-rose-500/30 transition cursor-pointer"
                                >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    <span>Thử lại</span>
                                </button>
                            </div>
                        ) : comments.length === 0 ? (
                            <div className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
                                Chưa có bình luận nào. Hãy là người đầu tiên chia sẻ cảm nghĩ!
                            </div>
                        ) : (
                            <div className="space-y-3.5">
                                {comments.map((comment) =>
                                    renderCommentTree(comment, {
                                        currentUserId,
                                        currentUserName,
                                        isAdmin,
                                        commentsDisabled: isCommentsDisabled,
                                        depth: 0,
                                        onReply: handleReply,
                                        onDelete: handleDeleteComment,
                                    })
                                )}
                                <div ref={commentsEndRef} />
                            </div>
                        )}
                    </div>
                </div>

                {/* Sticky Comment Composer / Disabled State */}
                <div className="p-3.5 border-t border-border dark:border-border/60 bg-surface-container-low dark:bg-surface-container-lowest shrink-0">
                    {isCommentsDisabled ? (
                        <div className="py-2 flex items-center justify-center gap-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
                            <Lock className="w-4 h-4 text-slate-400" />
                            <span>
                                {post.commentsLockedByAdmin
                                    ? 'Bình luận đã bị khóa bởi quản trị viên.'
                                    : 'Bình luận đã tắt cho bài viết này.'}
                            </span>
                        </div>
                    ) : isCommentRestricted ? (
                        <div className="py-2 flex items-center justify-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
                            <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0" />
                            <span>
                                {restriction?.userMessage || 'Tài khoản của bạn tạm thời không thể bình luận trong Cộng đồng.'}
                            </span>
                        </div>
                    ) : (
                        <>
                            {commentError && (
                                <div className="mb-2 p-2 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-300 text-xs flex items-center justify-between gap-2 animate-in fade-in duration-150">
                                    <div className="flex items-center gap-1.5">
                                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                                        <span>{commentError}</span>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setCommentError(null)}
                                        className="text-slate-400 hover:text-slate-600 cursor-pointer"
                                        title="Đóng"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </div>
                            )}

                            {replyingTo && (
                                <div className="flex items-center justify-between px-3 py-1.5 mb-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-xs text-cyan-700 dark:text-cyan-300">
                                    <span>
                                        Đang trả lời <strong>@{replyingTo.author.displayName}</strong>
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setReplyingTo(null)}
                                        className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white text-xs font-semibold cursor-pointer"
                                    >
                                        Hủy
                                    </button>
                                </div>
                            )}

                            {/* Multi-Attachment Preview Box */}
                            {commentMediaList.length > 0 && (
                                <div className="mb-2.5 flex items-center gap-2 overflow-x-auto py-1 scrollbar-thin">
                                    {commentMediaList.map((item, idx) => (
                                        <div
                                            key={idx}
                                            className="relative group w-16 h-16 rounded-xl overflow-hidden bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700/80 shrink-0 shadow-xs"
                                        >
                                            {item.type === 'IMAGE' ? (
                                                <img
                                                    src={item.previewUrl}
                                                    alt="Preview"
                                                    className="w-full h-full object-cover"
                                                />
                                            ) : (
                                                <div className="w-full h-full relative bg-black flex items-center justify-center">
                                                    <video
                                                        src={item.previewUrl}
                                                        className="w-full h-full object-cover opacity-80"
                                                    />
                                                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                                        <VideoIcon className="w-4 h-4 text-white drop-shadow" />
                                                    </div>
                                                </div>
                                            )}
                                            {uploadingMedia && (
                                                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                                                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                                                </div>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => handleRemoveMediaItem(idx)}
                                                disabled={submitting}
                                                className="absolute top-1 right-1 p-1 rounded-full bg-black/70 hover:bg-rose-600 text-white transition cursor-pointer"
                                                title="Xóa đính kèm"
                                            >
                                                <X className="w-3 h-3" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Soft composer surface owns the focus ring; native input stays borderless. */}
                            <form onSubmit={handleSendComment} className="flex items-center gap-2 sm:gap-3">
                                <UserAvatar
                                    className="hidden sm:block w-8 h-8 rounded-full shrink-0"
                                    fallbackName={session?.user?.name}
                                />

                                <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-3xl bg-surface-container-high/70 dark:bg-surface-container-high px-4 py-2 ring-1 ring-outline-variant/30 focus-within:ring-2 focus-within:ring-primary/60 transition-shadow">
                                    <input
                                        ref={inputRef}
                                        type="text"
                                        value={commentText}
                                        onChange={(e) => setCommentText(e.target.value)}
                                        placeholder={
                                            replyingTo
                                                ? `${locale === 'vi' ? 'Trả lời' : 'Reply to'} @${replyingTo.author.displayName}...`
                                                : (locale === 'vi' ? 'Viết bình luận...' : 'Write a comment...')
                                        }
                                        aria-label={locale === 'vi' ? 'Viết bình luận' : 'Write a comment'}
                                        maxLength={2000}
                                        className="min-w-[100px] flex-1 border-0 bg-transparent p-0 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/70 [outline:none] focus:ring-0"
                                    />

                                    {/* Action Buttons: Emoji 😊, Photo 📷, Video 🎥 */}
                                    <div className="flex items-center gap-0.5 shrink-0 text-slate-400">
                                        <button
                                            ref={emojiBtnRef}
                                            type="button"
                                            onClick={handleToggleEmojiPicker}
                                            className="p-2 rounded-full hover:text-amber-500 hover:bg-surface-container transition cursor-pointer"
                                            title="Thêm biểu tượng cảm xúc"
                                        >
                                            <Smile className="w-4 h-4" />
                                        </button>

                                        <button
                                            type="button"
                                            onClick={() => imageInputRef.current?.click()}
                                            disabled={submitting || imageCount >= 5}
                                            className="p-2 rounded-full hover:text-cyan-500 hover:bg-surface-container transition cursor-pointer disabled:opacity-40"
                                            title={imageCount >= 5 ? 'Đã đạt giới hạn 5 ảnh' : 'Đính kèm hình ảnh (tối đa 5)'}
                                        >
                                            <ImageIcon className="w-4 h-4" />
                                        </button>

                                        <button
                                            type="button"
                                            onClick={() => videoInputRef.current?.click()}
                                            disabled={submitting || videoCount >= 1}
                                            className="p-2 rounded-full hover:text-blue-500 hover:bg-surface-container transition cursor-pointer disabled:opacity-40"
                                            title={videoCount >= 1 ? 'Đã đạt giới hạn 1 video' : 'Đính kèm video (tối đa 1)'}
                                        >
                                            <VideoIcon className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>

                                <button
                                    type="submit"
                                    disabled={(!commentText.trim() && commentMediaList.length === 0) || submitting}
                                    className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-on-primary font-bold transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-40 cursor-pointer shrink-0"
                                    title={locale === 'vi' ? 'Gửi bình luận' : 'Send comment'}
                                >
                                    {submitting ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                        <Send className="w-4 h-4" />
                                    )}
                                </button>
                            </form>

                            {/* Hidden file inputs */}
                            <input
                                ref={imageInputRef}
                                type="file"
                                multiple
                                accept="image/png,image/jpeg,image/webp,image/gif"
                                className="hidden"
                                onChange={handleImageSelect}
                            />
                            <input
                                ref={videoInputRef}
                                type="file"
                                accept="video/mp4,video/webm"
                                className="hidden"
                                onChange={handleVideoSelect}
                            />

                            {/* Authoritative Emoji Picker */}
                            <ComposerEmojiPicker
                                isOpen={showEmojiPicker}
                                onClose={() => setShowEmojiPicker(false)}
                                onSelectEmoji={handleInsertEmoji}
                                anchorRect={emojiAnchorRect}
                                anchorRef={emojiBtnRef}
                            />
                        </>
                    )}
                </div>
            </div>

            {/* Share Sheet */}
            <ShareSheet
                post={currentPost}
                isOpen={shareOpen}
                onClose={() => setShareOpen(false)}
            />
        </div>
    )

    if (typeof window === 'undefined') return null
    return createPortal(modalContent, document.body)
}
