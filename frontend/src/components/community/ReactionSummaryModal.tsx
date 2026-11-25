'use client'

import React, { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, Award, Flame, CheckCircle2 } from 'lucide-react'
import { ReactionType, PostReactionSummary, PostReactor } from '@/types/community'
import { communityApi } from '@/services/communityApi'
import { AuthorAvatar } from './AuthorAvatar'
import { ChibiReaction, REACTION_METADATA } from './ChibiReaction'
import styles from './communityGlass.module.css'
import { useMorphPresence } from '@/components/morph/useMorphPresence'

interface ReactionSummaryModalProps {
    postId: number
    isOpen: boolean
    onClose: () => void
    initialCount?: number
}

const ORDERED_REACTION_KEYS: ReactionType[] = [
    'LOVE',
    'HAHA',
    'SUPPORT',
    'SAD',
    'USEFUL',
    'WOW',
    'CONFUSED',
    'ANGRY',
    'CLAP',
    'FIRE',
    'THINKING',
    'CELEBRATE',
]

export function ReactionSummaryModal({
    postId,
    isOpen,
    onClose,
    initialCount = 0,
}: ReactionSummaryModalProps) {
    const [activeTab, setActiveTab] = useState<ReactionType | 'ALL'>('ALL')
    const [summary, setSummary] = useState<PostReactionSummary | null>(null)
    const [loading, setLoading] = useState(false)
    const [mounted, setMounted] = useState(false)
    const panelRef = React.useRef<HTMLDivElement>(null)
    const presence = useMorphPresence(isOpen && mounted, panelRef)

    // Keep stable authoritative counts across tab switches to prevent tab flashing
    const stableCountsRef = useRef<Record<string, number>>({})

    useEffect(() => {
        setMounted(true)
    }, [])

    // Reset tab and summary state when modal opens
    useEffect(() => {
        if (!presence.present) {
            setActiveTab('ALL')
            setSummary(null)
            stableCountsRef.current = {}
        }
    }, [presence.present])

    // Fetch reactor list on demand when modal opens or tab changes
    useEffect(() => {
        if (!isOpen) return

        let isCurrent = true
        setLoading(true)

        const filterType = activeTab === 'ALL' ? undefined : activeTab
        communityApi
            .getPostReactions(postId, filterType, 0, 50)
            .then((data) => {
                if (isCurrent) {
                    if (data?.countsByType && Object.keys(data.countsByType).length > 0) {
                        stableCountsRef.current = {
                            ...stableCountsRef.current,
                            ...data.countsByType,
                        }
                    }
                    setSummary(data)
                }
            })
            .catch((err) => {
                console.error('Failed to load post reactions', err)
            })
            .finally(() => {
                if (isCurrent) setLoading(false)
            })

        return () => {
            isCurrent = false
        }
    }, [postId, isOpen, activeTab])

    // Close on Escape key
    useEffect(() => {
        if (!isOpen) return
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [isOpen, onClose])

    const counts = summary?.countsByType || stableCountsRef.current
    const reactors: PostReactor[] = summary?.reactors || []
    const totalCount = summary?.totalCount ?? initialCount

    // Authoritative visible tabs: ALL is always visible, specific reaction tabs ONLY if count > 0
    const visibleTabs = useMemo(() => {
        const tabs: { key: ReactionType | 'ALL'; count: number }[] = [
            { key: 'ALL', count: totalCount },
        ]

        for (const key of ORDERED_REACTION_KEYS) {
            const count = counts[key] || 0
            if (count > 0) {
                tabs.push({ key, count })
            }
        }

        return tabs
    }, [counts, totalCount])

    if (!presence.present || !mounted) return null

    const modalContent = (
        <div
            className={`${styles.world} fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 animate-in fade-in duration-150`}
            onClick={onClose}
        >
            <div
                ref={panelRef}
                {...presence.panelProps}
                className="w-full max-w-md bg-card dark:bg-card border border-border dark:border-border/80 rounded-3xl shadow-2xl text-slate-900 dark:text-slate-100 overflow-hidden flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-150"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-border dark:border-sky-900/30">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-slate-900 dark:text-white">
                            Người đã bày tỏ cảm xúc
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
                            {totalCount}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1.5 rounded-xl text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition cursor-pointer"
                        title="Đóng"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Filter Tabs — Only non-zero reaction types, zero flash */}
                <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border/80 dark:border-sky-900/20 overflow-x-auto scrollbar-none bg-surface-container-low/40">
                    {visibleTabs.map((tab) => {
                        const isActive = activeTab === tab.key
                        const meta = tab.key === 'ALL' ? null : REACTION_METADATA[tab.key]

                        return (
                            <button
                                key={tab.key}
                                type="button"
                                onClick={() => setActiveTab(tab.key)}
                                className={[
                                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer shrink-0',
                                    isActive
                                        ? 'bg-cyan-500 text-slate-950 font-bold shadow-xs'
                                        : 'bg-card text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10',
                                ].join(' ')}
                            >
                                {tab.key === 'ALL' ? (
                                    <span>Tất cả</span>
                                ) : (
                                    <ChibiReaction type={tab.key} size="sm" animate={isActive} />
                                )}
                                <span className="text-[11px] font-mono opacity-90">
                                    {tab.count}
                                </span>
                            </button>
                        )
                    })}
                </div>

                {/* Reactors List Body */}
                <div className="flex-1 overflow-y-auto p-3 space-y-1 divide-y divide-border/40 dark:divide-white/[0.04]">
                    {loading && reactors.length === 0 ? (
                        <div className="py-12 flex flex-col items-center justify-center gap-2 text-slate-400">
                            <Loader2 className="w-6 h-6 animate-spin text-cyan-500" />
                            <span className="text-xs">Đang tải danh sách...</span>
                        </div>
                    ) : reactors.length === 0 ? (
                        <div className="py-12 text-center text-xs text-slate-400">
                            Chưa có lượt bày tỏ cảm xúc nào cho mục này.
                        </div>
                    ) : (
                        reactors.map((reactor, idx) => {
                            const reactorMeta = REACTION_METADATA[reactor.reactionType] || REACTION_METADATA.LOVE
                            return (
                                <div
                                    key={idx}
                                    className="flex items-center justify-between p-2 rounded-2xl hover:bg-slate-50 dark:hover:bg-white/[0.04] transition"
                                >
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="relative shrink-0">
                                            <AuthorAvatar author={reactor.user} size="sm" />
                                            <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-card dark:bg-card border border-border flex items-center justify-center shadow-xs">
                                                <ChibiReaction type={reactor.reactionType} size="sm" />
                                            </div>
                                        </div>

                                        <div className="min-w-0">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <span className="font-bold text-xs text-slate-900 dark:text-white truncate">
                                                    {reactor.user.displayName}
                                                </span>
                                                {reactor.user.official && (
                                                    <CheckCircle2 className="w-3.5 h-3.5 text-cyan-500 fill-cyan-500/20 shrink-0" />
                                                )}
                                                <span className="text-[10px] text-slate-400 dark:text-slate-500">
                                                    • {reactorMeta.vietnameseName}
                                                </span>
                                            </div>

                                            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                                                {reactor.user.cefrLevel && (
                                                    <span className="inline-flex items-center gap-0.5 font-semibold text-sky-700 dark:text-cyan-400">
                                                        <Award className="w-2.5 h-2.5" />
                                                        {reactor.user.cefrLevel}
                                                    </span>
                                                )}
                                                {reactor.user.streakDays > 0 && (
                                                    <span className="inline-flex items-center gap-0.5 font-semibold text-amber-500">
                                                        <Flame className="w-2.5 h-2.5 fill-amber-500" />
                                                        {reactor.user.streakDays}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )
                        })
                    )}
                </div>
            </div>
        </div>
    )

    return createPortal(modalContent, document.body)
}
