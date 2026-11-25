'use client'

import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
    Heart,
    Reply,
    Trash2,
    AlertTriangle,
    CheckCircle2,
    Plus,
    Loader2,
    CornerDownRight,
    ChevronUp,
    X,
} from 'lucide-react'
import {
    Comment,
    ReactionType,
    ReportReason,
    CommentReactorPreview,
} from '@/types/community'
import { AuthorAvatar } from './AuthorAvatar'
import { LinkifiedText } from './LinkifiedText'
import { communityApi } from '@/services/communityApi'
import {
    ChibiReaction,
    DEFAULT_REACTION_TYPES,
    EXTENDED_REACTION_TYPES,
    REACTION_METADATA,
} from './ChibiReaction'
import { PostVideoPlayer } from './PostVideoPlayer'
import styles from './communityGlass.module.css'

interface CommentItemProps {
    comment: Comment
    currentUserId?: number | null
    currentUserName?: string
    isAdmin?: boolean
    commentsDisabled?: boolean
    depth?: number
    onReply: (comment: Comment) => void
    onDelete?: (commentId: number) => void
}

function formatRelativeTime(dateString: string): string {
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

export function CommentItem({
    comment,
    currentUserId,
    currentUserName,
    isAdmin,
    commentsDisabled = false,
    depth = 0,
    onReply,
    onDelete,
}: CommentItemProps) {
    const [reactionCount, setReactionCount] = useState(comment.reactionCount || 0)
    const [myReaction, setMyReaction] = useState<ReactionType | null | undefined>(comment.myReaction)
    const [topReactors, setTopReactors] = useState<CommentReactorPreview[]>(comment.topReactors || [])
    const [isDeleting, setIsDeleting] = useState(false)
    const [showReportDialog, setShowReportDialog] = useState(false)
    const [reporting, setReporting] = useState(false)
    const [reportStatus, setReportStatus] = useState<string | null>(null)
    const [actionError, setActionError] = useState<string | null>(null)
    const [previewImage, setPreviewImage] = useState<string | null>(null)
    const [isExpanded, setIsExpanded] = useState(false)
    const prevRepliesLengthRef = useRef((comment.replies || []).length)

    // Auto-expand if a new reply is added to this comment
    useEffect(() => {
        const currentLength = (comment.replies || []).length
        if (currentLength > prevRepliesLengthRef.current) {
            setIsExpanded(true)
        }
        prevRepliesLengthRef.current = currentLength
    }, [comment.replies])

    // Reaction Picker states
    const [showPicker, setShowPicker] = useState(false)
    const [showExtendedPalette, setShowExtendedPalette] = useState(false)
    const [pickerCoords, setPickerCoords] = useState<{ top: number; left: number } | null>(null)

    // Hover Tooltip states for reaction summary badge
    const [showReactorTooltip, setShowReactorTooltip] = useState(false)
    const [tooltipCoords, setTooltipCoords] = useState<{ top: number; left: number } | null>(null)

    const hidePickerTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const hideTooltipTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const longPressTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const reactionTriggerRef = useRef<HTMLDivElement>(null)
    const pickerRef = useRef<HTMLDivElement>(null)
    const summaryBadgeRef = useRef<HTMLDivElement>(null)

    const isAuthor = currentUserId != null && comment.author.userId === currentUserId
    const canDelete = isAuthor || isAdmin

    // Sync external props if comment changes
    useEffect(() => {
        setReactionCount(comment.reactionCount || 0)
        setMyReaction(comment.myReaction)
        if (comment.topReactors) {
            setTopReactors(comment.topReactors)
        }
    }, [comment.reactionCount, comment.myReaction, comment.topReactors])

    // Cleanup timeouts
    useEffect(() => {
        return () => {
            if (hidePickerTimeoutRef.current) clearTimeout(hidePickerTimeoutRef.current)
            if (hideTooltipTimeoutRef.current) clearTimeout(hideTooltipTimeoutRef.current)
            if (longPressTimeoutRef.current) clearTimeout(longPressTimeoutRef.current)
        }
    }, [])

    // ── PICKER POSITIONING & PORTAL ──
    const updatePickerPosition = () => {
        if (reactionTriggerRef.current) {
            const rect = reactionTriggerRef.current.getBoundingClientRect()
            const pickerWidth = showExtendedPalette ? 320 : 250
            const pickerHeight = showExtendedPalette ? 96 : 48
            const gap = 6

            // Horizontal positioning: align near trigger left, clamped to viewport bounds
            const left = Math.max(8, Math.min(window.innerWidth - pickerWidth - 8, rect.left - 10))

            // Vertical collision: if space above is less than pickerHeight + gap + 8, flip below
            let top: number
            if (rect.top - pickerHeight - gap < 8) {
                // Flip below button
                top = rect.bottom + gap
            } else {
                // Position directly attached above button
                top = rect.top - pickerHeight - gap
            }

            setPickerCoords({ top, left })
        }
    }

    // Scroll & resize tracking to keep picker attached inside scrollable modals/replies
    useEffect(() => {
        if (!showPicker) return
        const handleScrollOrResize = () => {
            updatePickerPosition()
        }
        window.addEventListener('scroll', handleScrollOrResize, true)
        window.addEventListener('resize', handleScrollOrResize)
        return () => {
            window.removeEventListener('scroll', handleScrollOrResize, true)
            window.removeEventListener('resize', handleScrollOrResize)
        }
    }, [showPicker, showExtendedPalette])

    // Close on Escape key
    useEffect(() => {
        if (!showPicker) return
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setShowPicker(false)
                setShowExtendedPalette(false)
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [showPicker])

    // Close on click outside
    useEffect(() => {
        if (!showPicker) return
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node
            if (
                reactionTriggerRef.current &&
                !reactionTriggerRef.current.contains(target) &&
                pickerRef.current &&
                !pickerRef.current.contains(target)
            ) {
                setShowPicker(false)
                setShowExtendedPalette(false)
            }
        }
        const timer = setTimeout(() => {
            window.addEventListener('click', handleClickOutside)
        }, 10)
        return () => {
            clearTimeout(timer)
            window.removeEventListener('click', handleClickOutside)
        }
    }, [showPicker])

    // Hover handlers with 220ms grace window
    const handleMouseEnterTrigger = () => {
        if (hidePickerTimeoutRef.current) clearTimeout(hidePickerTimeoutRef.current)
        updatePickerPosition()
        setShowPicker(true)
    }

    const handleMouseLeaveTrigger = () => {
        if (hidePickerTimeoutRef.current) clearTimeout(hidePickerTimeoutRef.current)
        hidePickerTimeoutRef.current = setTimeout(() => {
            setShowPicker(false)
            setShowExtendedPalette(false)
        }, 220)
    }

    const handleMouseEnterToolbar = () => {
        if (hidePickerTimeoutRef.current) clearTimeout(hidePickerTimeoutRef.current)
    }

    const handleMouseLeaveToolbar = () => {
        if (hidePickerTimeoutRef.current) clearTimeout(hidePickerTimeoutRef.current)
        hidePickerTimeoutRef.current = setTimeout(() => {
            setShowPicker(false)
            setShowExtendedPalette(false)
        }, 220)
    }

    // ── REACTION SUMMARY TOOLTIP POSITIONING ──
    const handleMouseEnterSummary = () => {
        if (hideTooltipTimeoutRef.current) clearTimeout(hideTooltipTimeoutRef.current)
        if (summaryBadgeRef.current) {
            const rect = summaryBadgeRef.current.getBoundingClientRect()
            const top = rect.bottom + 6
            const left = Math.max(8, Math.min(window.innerWidth - 220, rect.left - 10))
            setTooltipCoords({ top, left })
            setShowReactorTooltip(true)
        }
    }

    const handleMouseLeaveSummary = () => {
        hideTooltipTimeoutRef.current = setTimeout(() => {
            setShowReactorTooltip(false)
        }, 150)
    }

    // ── REACTION SELECTION (V2 OPTIMISTIC) ──
    const handleSelectReaction = async (type: ReactionType) => {
        if (hidePickerTimeoutRef.current) clearTimeout(hidePickerTimeoutRef.current)
        setShowPicker(false)
        setShowExtendedPalette(false)

        const prevReaction = myReaction
        const prevCount = reactionCount
        const prevReactors = [...topReactors]

        let newReaction: ReactionType | null = null
        let newCount = prevCount

        if (prevReaction === type) {
            // Remove reaction
            newReaction = null
            newCount = Math.max(0, prevCount - 1)
        } else if (!prevReaction) {
            // First reaction
            newReaction = type
            newCount = prevCount + 1
        } else {
            // Switch reaction
            newReaction = type
        }

        // Optimistically update reactor list
        const updatedReactors = [...prevReactors]
        const userName = currentUserName || 'Bạn'
        const existingIdx = currentUserId
            ? updatedReactors.findIndex((r) => r.userId === currentUserId)
            : -1

        if (newReaction) {
            if (existingIdx >= 0) {
                updatedReactors[existingIdx] = {
                    ...updatedReactors[existingIdx],
                    reactionType: newReaction,
                }
            } else if (currentUserId) {
                updatedReactors.unshift({
                    userId: currentUserId,
                    displayName: userName,
                    reactionType: newReaction,
                })
            }
        } else {
            if (existingIdx >= 0) {
                updatedReactors.splice(existingIdx, 1)
            }
        }

        // Apply optimistic updates immediately
        setMyReaction(newReaction)
        setReactionCount(newCount)
        setTopReactors(updatedReactors)

        try {
            const res = await communityApi.reactToComment(comment.id, newReaction || undefined)
            setReactionCount(res.reactionCount)
            setMyReaction(res.myReaction || null)
            if (res.topReactors) {
                setTopReactors(res.topReactors)
            }
        } catch (err) {
            console.error('Failed to react to comment', err)
            // Rollback
            setMyReaction(prevReaction)
            setReactionCount(prevCount)
            setTopReactors(prevReactors)
            setActionError('Không thể bày tỏ cảm xúc. Vui lòng thử lại.')
            setTimeout(() => setActionError(null), 3000)
        }
    }

    const handleDelete = async () => {
        if (!confirm('Bạn có chắc chắn muốn xóa bình luận này?')) return
        setIsDeleting(true)
        setActionError(null)
        try {
            await communityApi.deleteComment(comment.id)
            onDelete?.(comment.id)
        } catch (err: unknown) {
            console.error('Failed to delete comment', err)
            setActionError(
                err instanceof Error && err.message ? err.message : 'Không thể xóa bình luận.'
            )
            setIsDeleting(false)
        }
    }

    const handleReport = async (reason: ReportReason) => {
        setReporting(true)
        setActionError(null)
        try {
            await communityApi.reportComment(
                comment.id,
                reason,
                `Báo cáo nội dung bình luận vi phạm: "${comment.content.slice(0, 100)}"`
            )
            setShowReportDialog(false)
            setReportStatus('Đã gửi báo cáo cho quản trị viên.')
            setTimeout(() => setReportStatus(null), 4000)
        } catch (err: unknown) {
            console.error('Failed to report comment', err)
            setActionError(
                err instanceof Error && err.message
                    ? err.message
                    : 'Không thể gửi báo cáo bình luận. Vui lòng thử lại.'
            )
        } finally {
            setReporting(false)
        }
    }

    // Determine representative reaction types for the summary badge
    const representativeTypes: ReactionType[] = []
    if (myReaction) representativeTypes.push(myReaction)
    topReactors.forEach((r) => {
        if (!representativeTypes.includes(r.reactionType)) {
            representativeTypes.push(r.reactionType)
        }
    })
    if (representativeTypes.length === 0 && reactionCount > 0) {
        representativeTypes.push('LOVE')
    }
    const displayIcons = representativeTypes.slice(0, 3)

    // Indentation capped at level 3
    const indentStyles =
        depth === 0
            ? ''
            : depth === 1
            ? 'pl-3 sm:pl-4 border-l-2 border-slate-200 dark:border-sky-900/50 mt-2.5'
            : depth === 2
            ? 'pl-2.5 sm:pl-3 border-l-2 border-slate-200/80 dark:border-sky-900/40 mt-2'
            : 'pl-2 border-l border-slate-200/60 dark:border-sky-900/30 mt-2'

    const activeMeta = myReaction ? REACTION_METADATA[myReaction] : null

    return (
        <div className={`text-xs text-on-surface dark:text-slate-200 ${indentStyles}`}>
            <div className="flex gap-2.5 items-start">
                <AuthorAvatar author={comment.author} size="xs" className="mt-0.5 shrink-0" />

                <div className="flex-1 min-w-0">
                    <div className="bg-surface-container-low dark:bg-surface-container-low border border-border/80 dark:border-border/60 rounded-2xl px-3.5 py-2.5 inline-block max-w-full shadow-xs">
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-bold text-slate-900 dark:text-white tracking-tight">
                                {comment.author.displayName}
                            </span>
                            {comment.author.official && (
                                <CheckCircle2 className="w-3.5 h-3.5 text-cyan-500 fill-cyan-500/20 shrink-0" />
                            )}
                            <span className="text-[10px] text-slate-500 dark:text-slate-400">
                                {formatRelativeTime(comment.createdAt)}
                            </span>
                        </div>

                        {comment.content && (
                            <div className="mt-1 text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words leading-relaxed text-xs">
                                {/* Display reply context target if applicable */}
                                {comment.replyToAuthorName && (
                                    <span className="font-semibold text-cyan-600 dark:text-cyan-400 mr-1.5 select-none">
                                        @{comment.replyToAuthorName}
                                    </span>
                                )}
                                <LinkifiedText text={comment.content} />
                            </div>
                        )}

                        {/* Comment media attachments rendering (Multi-media: up to 5 images + 1 video) */}
                        {(() => {
                            const mediaList =
                                comment.media && comment.media.length > 0
                                    ? comment.media
                                    : comment.mediaUrl
                                    ? [{ mediaUrl: comment.mediaUrl, mediaType: comment.mediaType || 'IMAGE' }]
                                    : []
                            if (mediaList.length === 0) return null

                            const imageAttachments = mediaList.filter(
                                (m) =>
                                    !m.mediaType?.toLowerCase().startsWith('video/') &&
                                    !m.mediaUrl.endsWith('.mp4') &&
                                    !m.mediaUrl.endsWith('.webm')
                            )
                            const videoAttachments = mediaList.filter(
                                (m) =>
                                    m.mediaType?.toLowerCase().startsWith('video/') ||
                                    m.mediaUrl.endsWith('.mp4') ||
                                    m.mediaUrl.endsWith('.webm')
                            )

                            return (
                                <div className="mt-2 space-y-2 max-w-xs sm:max-w-sm">
                                    {/* Single image */}
                                    {imageAttachments.length === 1 && (
                                        <div className="rounded-xl overflow-hidden">
                                            <img
                                                src={imageAttachments[0].mediaUrl}
                                                alt="Đính kèm bình luận"
                                                className="w-full max-h-60 object-cover rounded-xl border border-border/40 cursor-pointer hover:opacity-95 transition shadow-xs"
                                                onClick={() => setPreviewImage(imageAttachments[0].mediaUrl)}
                                                loading="lazy"
                                            />
                                        </div>
                                    )}

                                    {/* 2 images */}
                                    {imageAttachments.length === 2 && (
                                        <div className="grid grid-cols-2 gap-1.5 rounded-xl overflow-hidden">
                                            {imageAttachments.map((img, idx) => (
                                                <img
                                                    key={idx}
                                                    src={img.mediaUrl}
                                                    alt={`Đính kèm bình luận ${idx + 1}`}
                                                    className="w-full h-32 object-cover rounded-lg border border-border/40 cursor-pointer hover:opacity-95 transition shadow-xs"
                                                    onClick={() => setPreviewImage(img.mediaUrl)}
                                                    loading="lazy"
                                                />
                                            ))}
                                        </div>
                                    )}

                                    {/* 3 to 5 images */}
                                    {imageAttachments.length >= 3 && (
                                        <div className={`grid ${imageAttachments.length === 3 ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-3'} gap-1.5 rounded-xl overflow-hidden`}>
                                            {imageAttachments.map((img, idx) => (
                                                <img
                                                    key={idx}
                                                    src={img.mediaUrl}
                                                    alt={`Đính kèm bình luận ${idx + 1}`}
                                                    className="w-full h-24 object-cover rounded-lg border border-border/40 cursor-pointer hover:opacity-95 transition shadow-xs"
                                                    onClick={() => setPreviewImage(img.mediaUrl)}
                                                    loading="lazy"
                                                />
                                            ))}
                                        </div>
                                    )}

                                    {/* Video attachment */}
                                    {videoAttachments.map((vid, idx) => (
                                        <div key={idx} className="rounded-xl overflow-hidden">
                                            <PostVideoPlayer
                                                src={vid.mediaUrl}
                                                className="w-full max-h-60 rounded-xl"
                                            />
                                        </div>
                                    ))}
                                </div>
                            )
                        })()}
                    </div>

                    {/* Inline error or report success notices */}
                    {actionError && (
                        <div className="mt-1 text-[11px] text-rose-500 font-medium">
                            {actionError}
                        </div>
                    )}
                    {reportStatus && (
                        <div className="mt-1 text-[11px] text-emerald-500 font-medium">
                            {reportStatus}
                        </div>
                    )}

                    {/* Comment actions row */}
                    <div className="flex items-center gap-2.5 mt-1 ml-1 text-[11px] text-slate-500 dark:text-slate-400 font-semibold select-none flex-wrap">
                        {/* 1. Reaction Trigger & Picker */}
                        <div
                            ref={reactionTriggerRef}
                            className="relative inline-flex items-center"
                            onMouseEnter={handleMouseEnterTrigger}
                            onMouseLeave={handleMouseLeaveTrigger}
                        >
                            <button
                                type="button"
                                onClick={() => handleSelectReaction(myReaction ? myReaction : 'LOVE')}
                                onTouchStart={() => {
                                    longPressTimeoutRef.current = setTimeout(() => {
                                        updatePickerPosition()
                                        setShowPicker(true)
                                    }, 350)
                                }}
                                onTouchEnd={() => {
                                    if (longPressTimeoutRef.current) {
                                        clearTimeout(longPressTimeoutRef.current)
                                        longPressTimeoutRef.current = null
                                    }
                                }}
                                onContextMenu={(e) => {
                                    e.preventDefault()
                                    updatePickerPosition()
                                    setShowPicker(true)
                                }}
                                className={[
                                    'inline-flex items-center gap-1 py-0.5 px-1.5 rounded-lg transition-all cursor-pointer font-bold',
                                    activeMeta
                                        ? activeMeta.activeBg
                                        : 'hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05]',
                                ].join(' ')}
                            >
                                {activeMeta ? (
                                    <>
                                        <ChibiReaction type={activeMeta.type} size="sm" />
                                        <span className="truncate">{activeMeta.label}</span>
                                    </>
                                ) : (
                                    <>
                                        <Heart className="w-3.5 h-3.5 text-slate-400 group-hover:text-rose-500 transition-colors" />
                                        <span>Thích</span>
                                    </>
                                )}
                            </button>
                        </div>

                        {/* 2. Reaction Summary Badge (Rendered ONLY if reactionCount > 0, NO naked 0) */}
                        {reactionCount > 0 ? (
                            <div
                                ref={summaryBadgeRef}
                                onMouseEnter={handleMouseEnterSummary}
                                onMouseLeave={handleMouseLeaveSummary}
                                onClick={() => handleSelectReaction(myReaction ? myReaction : 'LOVE')}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700/60 shadow-2xs cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700/80 transition"
                                title="Những người đã bày tỏ cảm xúc"
                            >
                                <div className="flex -space-x-1 items-center">
                                    {displayIcons.map((type, idx) => (
                                        <span
                                            key={`${type}-${idx}`}
                                            className="w-3.5 h-3.5 flex items-center justify-center rounded-full bg-white dark:bg-slate-900"
                                        >
                                            <ChibiReaction type={type} size="sm" />
                                        </span>
                                    ))}
                                </div>
                                <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300 ml-0.5">
                                    {reactionCount}
                                </span>
                            </div>
                        ) : null}

                        {/* 3. Reply Action (Visible on ANY depth, unless post comments are disabled) */}
                        {!commentsDisabled && (
                            <button
                                type="button"
                                onClick={() => onReply(comment)}
                                className="inline-flex items-center gap-1 py-0.5 px-1.5 rounded-lg hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05] transition cursor-pointer"
                            >
                                <Reply className="w-3 h-3" />
                                <span>Trả lời</span>
                            </button>
                        )}

                        {/* 4. Report Action */}
                        {!isAuthor && !reportStatus && (
                            <button
                                type="button"
                                onClick={() => setShowReportDialog(!showReportDialog)}
                                className="inline-flex items-center gap-1 py-0.5 px-1 rounded-lg text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 transition cursor-pointer"
                                title="Báo cáo bình luận"
                            >
                                <AlertTriangle className="w-3 h-3" />
                                <span>Báo cáo</span>
                            </button>
                        )}

                        {/* 5. Delete Action */}
                        {canDelete && (
                            <button
                                type="button"
                                onClick={handleDelete}
                                disabled={isDeleting}
                                className="inline-flex items-center gap-1 py-0.5 px-1 rounded-lg text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition cursor-pointer"
                                title={isAdmin && !isAuthor ? 'Quản trị viên xóa bình luận' : 'Xóa bình luận'}
                            >
                                {isDeleting ? (
                                    <Loader2 className="w-3 h-3 animate-spin text-rose-500" />
                                ) : (
                                    <Trash2 className="w-3 h-3" />
                                )}
                            </button>
                        )}
                    </div>

                    {/* Report Quick Dialog */}
                    {showReportDialog && (
                        <div className="mt-2 p-3 rounded-xl bg-card dark:bg-surface-container-lowest border border-border dark:border-border/60 shadow-lg space-y-2 max-w-sm">
                            <div className="flex items-center justify-between text-xs font-bold text-slate-900 dark:text-white">
                                <span>Lý do báo cáo bình luận:</span>
                                <button
                                    type="button"
                                    onClick={() => setShowReportDialog(false)}
                                    className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                                >
                                    Đóng
                                </button>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {(['SPAM', 'INAPPROPRIATE', 'HARASSMENT', 'OTHER'] as ReportReason[]).map((r) => (
                                    <button
                                        key={r}
                                        type="button"
                                        onClick={() => handleReport(r)}
                                        disabled={reporting}
                                        className="px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-300 border border-rose-500/30 transition cursor-pointer disabled:opacity-50"
                                    >
                                        {r === 'SPAM'
                                            ? 'Spam'
                                            : r === 'INAPPROPRIATE'
                                            ? 'Phản cảm'
                                            : r === 'HARASSMENT'
                                            ? 'Quấy rối'
                                            : 'Khác'}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Recursive nested replies with Facebook-style collapse UX */}
                    {comment.replies && comment.replies.length > 0 && (
                        <div className="mt-1 space-y-1.5">
                            {!isExpanded ? (
                                <button
                                    type="button"
                                    onClick={() => setIsExpanded(true)}
                                    className="inline-flex items-center gap-1.5 py-1 px-2 rounded-lg text-xs font-bold text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10 transition cursor-pointer select-none"
                                >
                                    <CornerDownRight className="w-3.5 h-3.5" />
                                    <span>Xem {comment.replies.length} câu trả lời</span>
                                </button>
                            ) : (
                                <div className="space-y-1.5">
                                    <button
                                        type="button"
                                        onClick={() => setIsExpanded(false)}
                                        className="inline-flex items-center gap-1 py-0.5 px-2 rounded-lg text-[11px] font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/5 transition cursor-pointer select-none"
                                    >
                                        <ChevronUp className="w-3 h-3" />
                                        <span>Ẩn câu trả lời</span>
                                    </button>
                                    <div className="space-y-1.5">
                                        {comment.replies.map((reply) => (
                                            <CommentItem
                                                key={reply.id}
                                                comment={reply}
                                                currentUserId={currentUserId}
                                                currentUserName={currentUserName}
                                                isAdmin={isAdmin}
                                                commentsDisabled={commentsDisabled}
                                                depth={depth + 1}
                                                onReply={onReply}
                                                onDelete={onDelete}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* ── FLOATING COMMENT REACTION PICKER IN DOCUMENT PORTAL ── */}
            {showPicker && typeof document !== 'undefined' && pickerCoords && createPortal(
                <div
                    ref={pickerRef}
                    onMouseEnter={handleMouseEnterToolbar}
                    onMouseLeave={handleMouseLeaveToolbar}
                    style={{
                        position: 'fixed',
                        top: `${pickerCoords.top}px`,
                        left: `${pickerCoords.left}px`,
                    }}
                    className={`${styles.world} z-[120] bg-card dark:bg-card border border-border/80 dark:border-sky-900/40 rounded-3xl p-1.5 shadow-2xl shadow-black/25 flex flex-col gap-1.5 animate-in fade-in slide-in-from-bottom-2 duration-150`}
                >
                    {/* Primary Toolbar: 5 Default Reactions + Plus Button */}
                    <div className="flex items-center gap-1">
                        {DEFAULT_REACTION_TYPES.map((type) => {
                            const meta = REACTION_METADATA[type]
                            const isSelected = myReaction === type
                            return (
                                <button
                                    key={type}
                                    type="button"
                                    onClick={() => handleSelectReaction(type)}
                                    className={[
                                        'p-1.5 rounded-2xl hover:scale-125 active:scale-95 transition-all motion-reduce:transform-none duration-150 cursor-pointer',
                                        isSelected
                                            ? 'bg-cyan-500/20 ring-1 ring-cyan-500/50'
                                            : 'hover:bg-slate-100 dark:hover:bg-white/10',
                                    ].join(' ')}
                                    title={meta.vietnameseName}
                                >
                                    <ChibiReaction type={type} size="md" animate />
                                </button>
                            )
                        })}

                        {/* Plus button to toggle expanded reaction palette */}
                        <button
                            type="button"
                            onClick={() => {
                                setShowExtendedPalette((prev) => !prev)
                                updatePickerPosition()
                            }}
                            className={[
                                'w-8 h-8 rounded-2xl flex items-center justify-center transition-all cursor-pointer text-slate-500 hover:text-cyan-500 hover:scale-110 active:scale-95 motion-reduce:transform-none',
                                showExtendedPalette
                                    ? 'bg-cyan-500 text-slate-950 font-bold'
                                    : 'hover:bg-slate-100 dark:hover:bg-white/10',
                            ].join(' ')}
                            title="Thêm cảm xúc khác"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Extended Reaction Palette: 7 Additional Reactions */}
                    {showExtendedPalette && (
                        <div className="pt-1.5 border-t border-border/60 dark:border-sky-900/30 flex items-center gap-1 animate-in fade-in zoom-in-95 duration-100">
                            {EXTENDED_REACTION_TYPES.map((type) => {
                                const meta = REACTION_METADATA[type]
                                const isSelected = myReaction === type
                                return (
                                    <button
                                        key={type}
                                        type="button"
                                        onClick={() => handleSelectReaction(type)}
                                        className={[
                                            'p-1.5 rounded-2xl hover:scale-125 active:scale-95 transition-all motion-reduce:transform-none duration-150 cursor-pointer',
                                            isSelected
                                                ? 'bg-cyan-500/20 ring-1 ring-cyan-500/50'
                                                : 'hover:bg-slate-100 dark:hover:bg-white/10',
                                        ].join(' ')}
                                        title={meta.vietnameseName}
                                    >
                                        <ChibiReaction type={type} size="md" animate />
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </div>,
                document.body
            )}

            {/* ── LIGHTWEIGHT HOVER TOOLTIP FOR REACTOR SUMMARY ── */}
            {showReactorTooltip && typeof document !== 'undefined' && tooltipCoords && topReactors.length > 0 && createPortal(
                <div
                    style={{
                        position: 'fixed',
                        top: `${tooltipCoords.top}px`,
                        left: `${tooltipCoords.left}px`,
                    }}
                    className="z-[130] bg-slate-900/95 dark:bg-slate-950/95 text-white border border-slate-700/80 dark:border-sky-900/50 rounded-xl px-2.5 py-2 shadow-xl text-xs backdrop-blur-md pointer-events-none animate-in fade-in zoom-in-95 duration-100 max-w-[240px]"
                >
                    <div className="space-y-1">
                        {topReactors.map((r, i) => {
                            const meta = REACTION_METADATA[r.reactionType] || REACTION_METADATA.LOVE
                            return (
                                <div key={i} className="flex items-center justify-between gap-2.5">
                                    <span className="font-medium truncate max-w-[130px] text-slate-100">
                                        {r.displayName}
                                    </span>
                                    <span className="flex items-center gap-1 text-[10px] text-slate-300 shrink-0">
                                        <ChibiReaction type={r.reactionType} size="sm" />
                                        <span>{meta.vietnameseName}</span>
                                    </span>
                                </div>
                            )
                        })}
                        {reactionCount > topReactors.length && (
                            <div className="text-[10px] text-cyan-400 pt-0.5 border-t border-slate-800 text-center font-semibold">
                                +{reactionCount - topReactors.length} người khác
                            </div>
                        )}
                    </div>
                </div>,
                document.body
            )}

            {/* Comment Image Full Preview Lightbox */}
            {previewImage && typeof document !== 'undefined' && createPortal(
                <div
                    className="fixed inset-0 z-[300] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150 select-none"
                    onClick={() => setPreviewImage(null)}
                >
                    <button
                        type="button"
                        onClick={() => setPreviewImage(null)}
                        className="absolute top-4 right-4 z-[310] p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition cursor-pointer"
                        title="Đóng"
                    >
                        <X className="w-6 h-6" />
                    </button>
                    <img
                        src={previewImage}
                        alt="Ảnh phóng to"
                        className="max-h-[85vh] max-w-[90vw] object-contain rounded-xl shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    />
                </div>,
                document.body
            )}
        </div>
    )
}

/**
 * Authoritatively renders a comment tree recursively.
 */
export function renderCommentTree(
    comment: Comment,
    props: {
        currentUserId?: number | null
        currentUserName?: string
        isAdmin?: boolean
        commentsDisabled?: boolean
        depth?: number
        onReply: (comment: Comment) => void
        onDelete?: (commentId: number) => void
    }
) {
    return <CommentItem key={comment.id} comment={comment} {...props} />
}
