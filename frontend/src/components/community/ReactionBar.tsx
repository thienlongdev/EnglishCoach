'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
    Heart,
    MessageSquare,
    Share2,
    Bookmark,
    Plus,
    Loader2,
} from 'lucide-react'
import { CommunityPost, ReactionType, PostReactor } from '@/types/community'
import { communityApi } from '@/services/communityApi'
import { useLanguage } from '@/context/LanguageContext'
import {
    patchReactionInAllCaches,
    patchSaveStateInAllCaches,
    subscribeToPostUpdates,
} from '@/services/communityCache'
import { ShareSheet } from './ShareSheet'
import { ReactionSummaryModal } from './ReactionSummaryModal'
import {
    ChibiReaction,
    DEFAULT_REACTION_TYPES,
    EXTENDED_REACTION_TYPES,
    REACTION_METADATA,
    getReactionMeta,
} from './ChibiReaction'
import styles from './communityGlass.module.css'

interface ReactionBarProps {
    post: CommunityPost
    currentUserId?: number | null
    onOpenComments?: () => void
    onCommentClick?: () => void
    onShareClick?: () => void
}

export function ReactionBar({
    post,
    currentUserId,
    onOpenComments,
    onCommentClick,
    onShareClick,
}: ReactionBarProps) {
    const { locale } = useLanguage()
    const [reactionCount, setReactionCount] = useState(post.reactionCount || 0)
    const [myReaction, setMyReaction] = useState<ReactionType | null>(post.myReaction || null)
    const [saved, setSaved] = useState(Boolean(post.savedByMe || post.isSaved))
    const [showPicker, setShowPicker] = useState(false)
    const [showExtendedPalette, setShowExtendedPalette] = useState(false)
    const [pickerCoords, setPickerCoords] = useState<{ top: number; left: number } | null>(null)
    const [isSummaryOpen, setIsSummaryOpen] = useState(false)
    const [isShareOpen, setIsShareOpen] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [popAnim, setPopAnim] = useState(false)
    const [mounted, setMounted] = useState(false)

    // Quick hover preview state
    const [previewOpen, setPreviewOpen] = useState(false)
    const [previewHovered, setPreviewHovered] = useState(false)
    const [previewCoords, setPreviewCoords] = useState<{ top: number; left: number } | null>(null)
    const [previewReactors, setPreviewReactors] = useState<PostReactor[]>([])
    const [previewTotal, setPreviewTotal] = useState(0)
    const [previewLoading, setPreviewLoading] = useState(false)
    const [previewFilterType, setPreviewFilterType] = useState<ReactionType | undefined>(undefined)

    const hidePickerTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const hidePreviewTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const triggerRef = useRef<HTMLDivElement>(null)
    const pickerRef = useRef<HTMLDivElement>(null)
    const summaryBtnRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        setMounted(true)
    }, [])

    // Sync with external post updates
    useEffect(() => {
        setReactionCount(post.reactionCount || 0)
        setMyReaction(post.myReaction || null)
        setSaved(Boolean(post.savedByMe || post.isSaved))
    }, [post.reactionCount, post.myReaction, post.savedByMe, post.isSaved])

    // Unified reaction state: subscribe to updates from all other instances (feed & modal)
    useEffect(() => {
        const unsubscribe = subscribeToPostUpdates((event) => {
            if (event.postId === post.id) {
                if (event.reactionCount !== undefined) {
                    setReactionCount(event.reactionCount)
                }
                if (event.myReaction !== undefined) {
                    setMyReaction(event.myReaction)
                }
                if (event.savedByMe !== undefined) {
                    setSaved(event.savedByMe)
                }
            }
        })
        return unsubscribe
    }, [post.id])

    // Cleanup timeouts on unmount
    useEffect(() => {
        return () => {
            if (hidePickerTimeoutRef.current) clearTimeout(hidePickerTimeoutRef.current)
            if (hidePreviewTimeoutRef.current) clearTimeout(hidePreviewTimeoutRef.current)
        }
    }, [])

    // ── PICKER POSITIONING & VIEWPORT COLLISION FLIPPING ──
    const updatePickerPosition = useCallback(() => {
        if (triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect()
            const pickerWidth = showExtendedPalette ? 320 : 252
            const pickerHeight = showExtendedPalette ? 96 : 48
            const gap = 6

            const spaceAbove = rect.top
            const spaceBelow = window.innerHeight - rect.bottom
            const placeAbove = spaceAbove >= pickerHeight + 10 || spaceAbove >= spaceBelow

            let top: number
            if (placeAbove) {
                // Attached directly above button with 6px gap
                top = Math.max(8, rect.top - pickerHeight - gap)
            } else {
                // Flip below button with 6px gap
                top = Math.min(window.innerHeight - pickerHeight - 8, rect.bottom + gap)
            }

            const left = Math.max(8, Math.min(window.innerWidth - pickerWidth - 8, rect.left - 4))
            setPickerCoords({ top, left })
        }
    }, [showExtendedPalette])

    // Dynamic scroll and resize tracking
    useEffect(() => {
        if (!showPicker) return
        updatePickerPosition()
        const handleScrollOrResize = () => updatePickerPosition()
        window.addEventListener('scroll', handleScrollOrResize, true)
        window.addEventListener('resize', handleScrollOrResize)
        return () => {
            window.removeEventListener('scroll', handleScrollOrResize, true)
            window.removeEventListener('resize', handleScrollOrResize)
        }
    }, [showPicker, updatePickerPosition])

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
                triggerRef.current &&
                !triggerRef.current.contains(target) &&
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

    // Smooth hover behavior with 220ms grace delay
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

    // ── REACTION MUTATION (OPTIMISTIC + IMMEDIATE CLOSE) ──
    const handleSelectReaction = async (type: ReactionType) => {
        if (hidePickerTimeoutRef.current) clearTimeout(hidePickerTimeoutRef.current)
        setShowPicker(false)
        setShowExtendedPalette(false)
        const prevReaction = myReaction
        const prevCount = reactionCount

        let newReaction: ReactionType | null = null
        let newCount = prevCount

        if (prevReaction === type) {
            // Un-react
            newReaction = null
            newCount = Math.max(0, prevCount - 1)
        } else if (!prevReaction) {
            // First react
            newReaction = type
            newCount = prevCount + 1
        } else {
            // Change reaction type
            newReaction = type
        }

        // Trigger micro-spring animation
        setPopAnim(true)
        setTimeout(() => setPopAnim(false), 350)

        // Optimistic local update
        setMyReaction(newReaction)
        setReactionCount(newCount)

        // Patch all caches and notify all active UI subscribers immediately
        patchReactionInAllCaches(post.id, newReaction, newCount)

        try {
            const res = await communityApi.reactToPost(post.id, newReaction)
            setReactionCount(res.reactionCount)
            setMyReaction(res.myReaction || null)
            patchReactionInAllCaches(post.id, res.myReaction, res.reactionCount)
        } catch (err) {
            console.error('Failed to react to post', err)
            // Rollback
            setMyReaction(prevReaction)
            setReactionCount(prevCount)
            patchReactionInAllCaches(post.id, prevReaction, prevCount)
        }
    }

    // ── QUICK PREVIEW HOVER ──
    const loadQuickPreview = useCallback((filterType?: ReactionType) => {
        if (!summaryBtnRef.current) return
        const rect = summaryBtnRef.current.getBoundingClientRect()
        setPreviewCoords({
            top: Math.max(12, rect.top - 120),
            left: Math.max(12, Math.min(window.innerWidth - 240, rect.left)),
        })
        setPreviewFilterType(filterType)
        setPreviewOpen(true)
        setPreviewLoading(true)

        communityApi
            .getPostReactions(post.id, filterType, 0, 5)
            .then((data) => {
                setPreviewReactors(data.reactors || [])
                setPreviewTotal(data.totalCount || 0)
            })
            .catch(() => {
                setPreviewReactors([])
            })
            .finally(() => {
                setPreviewLoading(false)
            })
    }, [post.id])

    const handleMouseEnterSummary = (filterType?: ReactionType) => {
        if (hidePreviewTimeoutRef.current) clearTimeout(hidePreviewTimeoutRef.current)
        loadQuickPreview(filterType)
    }

    const handleMouseLeaveSummary = () => {
        hidePreviewTimeoutRef.current = setTimeout(() => {
            if (!previewHovered) {
                setPreviewOpen(false)
            }
        }, 250)
    }

    const handleToggleSave = async () => {
        if (isSaving) return
        const prev = saved
        const next = !prev

        // Optimistic update
        setSaved(next)
        setIsSaving(true)
        patchSaveStateInAllCaches(currentUserId, post, next)

        try {
            if (next) {
                await communityApi.savePost(post.id)
            } else {
                await communityApi.unsavePost(post.id)
            }
        } catch (err) {
            console.error('Failed to toggle save post', err)
            // Rollback
            setSaved(prev)
            patchSaveStateInAllCaches(currentUserId, post, prev)
        } finally {
            setIsSaving(false)
        }
    }

    const activeMeta = myReaction ? getReactionMeta(myReaction) : null

    // ── AUTHORITATIVE UNIQUE REACTION ICONS FOR SUMMARY (FIX DUPLICATE HEART BUG) ──
    // Rule:
    // If 1 user reacted LOVE: render exactly 1 LOVE icon + "1"
    // If 2 users reacted LOVE: render 1 or representative unique icon + "2"
    // Never render duplicate icons for one reactor or duplicates in the icon cluster
    const uniqueReactionTypes = React.useMemo(() => {
        if (reactionCount === 0) return []
        const types: ReactionType[] = []
        if (myReaction) types.push(myReaction)
        if (post.topReactions && Array.isArray(post.topReactions)) {
            for (const t of post.topReactions) {
                if (t && !types.includes(t)) {
                    types.push(t)
                }
            }
        }
        if (types.length === 0) {
            types.push('LOVE')
        }
        // At most show min(reactionCount, 3) unique icons
        return types.slice(0, Math.min(reactionCount, 3))
    }, [reactionCount, myReaction, post.topReactions])

    const hasReactionSummary = Boolean(reactionCount > 0)
    const hasCommentSummary = Boolean(post.commentCount && post.commentCount > 0)
    const hasSummaryRow = hasReactionSummary || hasCommentSummary || Boolean(saved)

    return (
        <div className="mt-3.5 space-y-1.5 select-none">
            {/* ── 1. SOCIAL REACTION & COMMENT SUMMARY ROW ── */}
            {hasSummaryRow ? (
                <div className="flex items-center justify-between px-1 text-xs text-slate-500 dark:text-slate-400">
                    {/* Left: Reaction unique cluster + count */}
                    <div className="flex items-center gap-1.5">
                        {hasReactionSummary ? (
                            <button
                                ref={summaryBtnRef}
                                type="button"
                                onClick={() => setIsSummaryOpen(true)}
                                onMouseEnter={() => handleMouseEnterSummary()}
                                onMouseLeave={handleMouseLeaveSummary}
                                className="flex items-center gap-1.5 hover:opacity-90 transition cursor-pointer group"
                                title="Xem những ai đã bày tỏ cảm xúc"
                            >
                                <div className="flex -space-x-1 items-center">
                                    {uniqueReactionTypes.map((type, idx) => (
                                        <span
                                            key={`${type}-${idx}`}
                                            onMouseEnter={(e) => {
                                                e.stopPropagation()
                                                handleMouseEnterSummary(type)
                                            }}
                                            className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white dark:bg-slate-800 shadow-xs border border-slate-100 dark:border-slate-700/60 p-0.5"
                                        >
                                            <ChibiReaction type={type} size="sm" />
                                        </span>
                                    ))}
                                </div>
                                <span className="font-semibold text-slate-700 dark:text-slate-300 group-hover:underline underline-offset-2 ml-0.5">
                                    {reactionCount}
                                </span>
                            </button>
                        ) : null}
                    </div>

                    {/* Right: Comments count & Saved indicator */}
                    <div className="flex items-center gap-3">
                        {hasCommentSummary && (
                            <button
                                type="button"
                                onClick={onCommentClick || onOpenComments}
                                className="rounded-md hover:underline underline-offset-2 transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                            >
                                {post.commentCount} {locale === 'vi' ? 'bình luận' : 'comments'}
                            </button>
                        )}
                        {saved && (
                            <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                <Bookmark className="w-3 h-3 fill-amber-500 text-amber-500" />
                                Đã lưu
                            </span>
                        )}
                    </div>
                </div>
            ) : null}

            {/* ── 2. FULL-WIDTH SOCIAL ACTION BAR ── */}
            <div data-cg="actions" className="relative pt-1 border-t border-slate-200 dark:border-sky-900/30 grid grid-cols-4 gap-1 text-xs">
                {/* 1. Like / Reaction Action */}
                <div
                    ref={triggerRef}
                    className="relative col-span-1"
                    onMouseEnter={handleMouseEnterTrigger}
                    onMouseLeave={handleMouseLeaveTrigger}
                >
                    <button
                        type="button"
                        onClick={() => handleSelectReaction(myReaction ? myReaction : 'LOVE')}
                        className={[
                            'w-full flex items-center justify-center gap-1.5 py-2 rounded-xl font-bold transition-all duration-150 cursor-pointer',
                            activeMeta
                                ? activeMeta.activeBg
                                : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05]',
                            popAnim ? 'scale-105 motion-reduce:scale-100' : 'scale-100',
                        ].join(' ')}
                    >
                        {activeMeta ? (
                            <span className="inline-flex items-center justify-center animate-in zoom-in-75 duration-150">
                                <ChibiReaction type={activeMeta.type} size="sm" animate={popAnim} />
                            </span>
                        ) : (
                            <Heart className="w-4 h-4 text-slate-500 group-hover:text-rose-500 transition-colors" />
                        )}
                        <span className="truncate">
                            {activeMeta ? activeMeta.label : 'Thích'}
                        </span>
                    </button>
                </div>

                {/* 2. Comment Action */}
                <button
                    type="button"
                    onClick={onCommentClick || onOpenComments}
                    className="col-span-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05] font-bold transition-all duration-150 cursor-pointer"
                >
                    <MessageSquare className="w-4 h-4 text-slate-500" />
                    <span className="truncate">Bình luận</span>
                </button>

                {/* 3. Share Action */}
                <button
                    type="button"
                    onClick={onShareClick || (() => setIsShareOpen(true))}
                    className="col-span-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05] font-bold transition-all duration-150 cursor-pointer"
                >
                    <Share2 className="w-4 h-4 text-slate-500" />
                    <span className="truncate">Chia sẻ</span>
                </button>

                {/* 4. Save Bookmark Action */}
                <button
                    type="button"
                    onClick={handleToggleSave}
                    disabled={isSaving}
                    title={saved ? 'Bỏ lưu bài viết' : 'Lưu bài viết vào danh sách riêng tư'}
                    className={[
                        'col-span-1 flex items-center justify-center gap-1.5 py-2 rounded-xl font-bold transition-all duration-150 cursor-pointer',
                        saved
                            ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/15'
                            : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.05]',
                    ].join(' ')}
                >
                    <Bookmark
                        className={`w-4 h-4 transition-colors ${
                            saved ? 'fill-amber-500 text-amber-500' : 'text-slate-500'
                        }`}
                    />
                    <span className="truncate">{saved ? 'Đã lưu' : 'Lưu'}</span>
                </button>
            </div>

            {/* ── 3. FLOATING CHIBI REACTION PICKER IN DOCUMENT PORTAL (NO CLIPPING) ── */}
            {showPicker && mounted && pickerCoords && createPortal(
                <div
                    ref={pickerRef}
                    onMouseEnter={handleMouseEnterToolbar}
                    onMouseLeave={handleMouseLeaveToolbar}
                    style={{
                        position: 'fixed',
                        top: `${pickerCoords.top}px`,
                        left: `${pickerCoords.left}px`,
                    }}
                    className={`${styles.world} z-[100] bg-card dark:bg-card border border-border/80 dark:border-sky-900/40 rounded-3xl p-1.5 shadow-2xl shadow-black/25 flex flex-col gap-1.5 animate-in fade-in slide-in-from-bottom-2 duration-150`}
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

                        {/* Plus button to open expanded reaction palette */}
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

            {/* ── 4. QUICK PREVIEW TOOLTIP POPOVER (HOVER SUMMARY) ── */}
            {previewOpen && mounted && previewCoords && createPortal(
                <div
                    onMouseEnter={() => {
                        if (hidePreviewTimeoutRef.current) clearTimeout(hidePreviewTimeoutRef.current)
                        setPreviewHovered(true)
                    }}
                    onMouseLeave={() => {
                        setPreviewHovered(false)
                        setPreviewOpen(false)
                    }}
                    onClick={() => {
                        setPreviewOpen(false)
                        setIsSummaryOpen(true)
                    }}
                    style={{
                        position: 'fixed',
                        top: `${previewCoords.top}px`,
                        left: `${previewCoords.left}px`,
                    }}
                    className={`${styles.world} z-[100] w-56 bg-card dark:bg-card border border-border/80 dark:border-sky-900/40 rounded-2xl p-2.5 shadow-xl shadow-black/20 text-xs animate-in fade-in zoom-in-95 duration-150 cursor-pointer hover:border-cyan-500/40`}
                >
                    <div className="font-bold text-[11px] text-slate-500 dark:text-slate-400 mb-1.5 flex items-center justify-between">
                        <span>Cảm xúc gần đây</span>
                        {previewFilterType && (
                            <span className="text-[10px] font-semibold text-cyan-600 dark:text-cyan-400">
                                {REACTION_METADATA[previewFilterType]?.vietnameseName}
                            </span>
                        )}
                    </div>

                    {previewLoading ? (
                        <div className="py-3 flex items-center justify-center gap-1.5 text-slate-400 text-xs">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-500" />
                            <span>Đang tải...</span>
                        </div>
                    ) : previewReactors.length === 0 ? (
                        <div className="py-2 text-slate-400 text-center">Chưa có ai</div>
                    ) : (
                        <div className="space-y-1">
                            {previewReactors.slice(0, 4).map((r, idx) => {
                                const meta = REACTION_METADATA[r.reactionType] || REACTION_METADATA.LOVE
                                return (
                                    <div
                                        key={idx}
                                        className="flex items-center justify-between py-0.5 text-slate-700 dark:text-slate-200"
                                    >
                                        <span className="font-medium truncate max-w-[130px]">
                                            {r.user.displayName}
                                        </span>
                                        <span className="flex items-center gap-1 text-[11px] text-slate-400 shrink-0">
                                            <ChibiReaction type={r.reactionType} size="sm" />
                                            <span>{meta.vietnameseName}</span>
                                        </span>
                                    </div>
                                )
                            })}

                            {previewTotal > 4 && (
                                <div className="pt-1 text-[11px] text-cyan-600 dark:text-cyan-400 font-semibold text-center">
                                    +{previewTotal - 4} người khác
                                </div>
                            )}
                        </div>
                    )}

                    <div className="mt-1.5 pt-1 border-t border-border/40 text-[10px] text-slate-400 text-center">
                        Nhấp để xem danh sách đầy đủ
                    </div>
                </div>,
                document.body
            )}

            {/* Reaction Summary Modal (Who reacted) */}
            <ReactionSummaryModal
                postId={post.id}
                isOpen={isSummaryOpen}
                onClose={() => setIsSummaryOpen(false)}
                initialCount={reactionCount}
            />

            {/* Share Sheet Modal */}
            <ShareSheet
                post={post}
                isOpen={isShareOpen}
                onClose={() => setIsShareOpen(false)}
            />
        </div>
    )
}


