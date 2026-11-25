'use client'

import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
    Copy,
    Check,
    Share2,
    X,
    Send,
    MessageCircle,
    Globe,
    AlertCircle,
} from 'lucide-react'
import { CommunityPost } from '@/types/community'
import styles from './communityGlass.module.css'
import { useMorphPresence } from '@/components/morph/useMorphPresence'

interface ShareSheetProps {
    post: CommunityPost
    isOpen: boolean
    onClose: () => void
}

export function ShareSheet({ post, isOpen, onClose }: ShareSheetProps) {
    const [copied, setCopied] = useState(false)
    const [mounted, setMounted] = useState(false)
    const panelRef = React.useRef<HTMLDivElement>(null)
    const presence = useMorphPresence(isOpen && mounted, panelRef, { onDismiss: onClose })

    useEffect(() => {
        setMounted(true)
    }, [])

    if (!presence.present || !mounted) return null

    const isPublished = post.status === 'PUBLISHED'
    const permalink = typeof window !== 'undefined'
        ? `${window.location.origin}/community?post=${post.id}`
        : `/community?post=${post.id}`

    const shareTitle = `English Coach — Bài viết của ${post.author.displayName}`
    const shareText = post.content.slice(0, 100) + (post.content.length > 100 ? '...' : '')

    const handleCopyLink = async () => {
        try {
            await navigator.clipboard.writeText(permalink)
            setCopied(true)
            setTimeout(() => setCopied(false), 2500)
        } catch {
            // Fallback
            const el = document.createElement('textarea')
            el.value = permalink
            document.body.appendChild(el)
            el.select()
            document.execCommand('copy')
            document.body.removeChild(el)
            setCopied(true)
            setTimeout(() => setCopied(false), 2500)
        }
    }

    const handleNativeShare = async () => {
        if (typeof navigator !== 'undefined' && navigator.share) {
            try {
                await navigator.share({
                    title: shareTitle,
                    text: shareText,
                    url: permalink,
                })
                onClose()
            } catch (err) {
                // User cancelled or share failed
            }
        } else {
            handleCopyLink()
        }
    }

    const handleShareFacebook = () => {
        const url = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(permalink)}`
        window.open(url, '_blank', 'noopener,noreferrer,width=600,height=500')
    }

    const handleShareX = () => {
        const url = `https://twitter.com/intent/tweet?url=${encodeURIComponent(permalink)}&text=${encodeURIComponent(shareText)}`
        window.open(url, '_blank', 'noopener,noreferrer,width=600,height=500')
    }

    const handleShareTelegram = () => {
        const url = `https://t.me/share/url?url=${encodeURIComponent(permalink)}&text=${encodeURIComponent(shareText)}`
        window.open(url, '_blank', 'noopener,noreferrer,width=600,height=500')
    }

    const handleShareWhatsApp = () => {
        const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(`${shareText} ${permalink}`)}`
        window.open(url, '_blank', 'noopener,noreferrer,width=600,height=500')
    }

    const content = (
        <div
            className={`${styles.world} fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center sm:p-4 p-0 animate-in fade-in duration-150`}
            onClick={onClose}
        >
            <div
                ref={panelRef}
                {...presence.panelProps}
                className="w-full max-w-lg sm:max-w-md bg-card dark:bg-card border border-border dark:border-border/80 rounded-t-3xl sm:rounded-3xl p-5 shadow-2xl text-slate-900 dark:text-slate-100 space-y-4 animate-in slide-in-from-bottom sm:zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                <button type="button" className="ec-morph-handle" aria-label="Đóng chia sẻ" {...presence.handleProps} />
                {/* Header */}
                <div className="flex items-center justify-between border-b border-border dark:border-sky-900/40 pb-3">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-xl bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 flex items-center justify-center">
                            <Share2 className="w-4 h-4" />
                        </div>
                        <h3 className="font-bold text-sm text-slate-900 dark:text-white">
                            Chia sẻ bài viết
                        </h3>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1 rounded-xl text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition cursor-pointer"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {!isPublished ? (
                    <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-300 text-xs flex items-start gap-2.5">
                        <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                        <span>
                            Bài viết chưa được xuất bản công khai nên không thể tạo liên kết chia sẻ.
                        </span>
                    </div>
                ) : (
                    <>
                        {/* Copy Link input box */}
                        <div className="space-y-1.5">
                            <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                Liên kết trực tiếp
                            </label>
                            <div className="flex items-center gap-1.5 p-1.5 bg-slate-100 dark:bg-black/30 border border-border dark:border-sky-900/40 rounded-2xl">
                                <span className="text-xs text-slate-600 dark:text-slate-300 truncate px-2 flex-1 font-mono">
                                    {permalink}
                                </span>
                                <button
                                    type="button"
                                    onClick={handleCopyLink}
                                    className={[
                                        'inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer shrink-0 shadow-xs',
                                        copied
                                            ? 'bg-emerald-500 text-slate-950 font-extrabold'
                                            : 'bg-cyan-500 hover:bg-cyan-400 text-slate-950',
                                    ].join(' ')}
                                >
                                    {copied ? (
                                        <>
                                            <Check className="w-3.5 h-3.5" />
                                            <span>Đã sao chép</span>
                                        </>
                                    ) : (
                                        <>
                                            <Copy className="w-3.5 h-3.5" />
                                            <span>Sao chép</span>
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>

                        {/* Social Target Grid */}
                        <div className="space-y-1.5 pt-1">
                            <label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                Chia sẻ qua ứng dụng
                            </label>
                            <div className="grid grid-cols-4 gap-2 pt-1 text-center">
                                {/* Native share button if supported */}
                                {typeof navigator !== 'undefined' && 'share' in navigator && (
                                    <button
                                        type="button"
                                        onClick={handleNativeShare}
                                        className="flex flex-col items-center gap-1.5 p-2 rounded-2xl hover:bg-slate-100 dark:hover:bg-white/[0.06] transition cursor-pointer group"
                                    >
                                        <div className="w-10 h-10 rounded-2xl bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 flex items-center justify-center group-hover:scale-105 transition-transform">
                                            <Globe className="w-5 h-5" />
                                        </div>
                                        <span className="text-[10px] font-medium text-slate-600 dark:text-slate-300">Hệ thống</span>
                                    </button>
                                )}

                                <button
                                    type="button"
                                    onClick={handleShareFacebook}
                                    className="flex flex-col items-center gap-1.5 p-2 rounded-2xl hover:bg-slate-100 dark:hover:bg-white/[0.06] transition cursor-pointer group"
                                >
                                    <div className="w-10 h-10 rounded-2xl bg-blue-600/15 text-blue-600 dark:text-blue-400 flex items-center justify-center group-hover:scale-105 transition-transform font-bold text-sm">
                                        f
                                    </div>
                                    <span className="text-[10px] font-medium text-slate-600 dark:text-slate-300">Facebook</span>
                                </button>

                                <button
                                    type="button"
                                    onClick={handleShareX}
                                    className="flex flex-col items-center gap-1.5 p-2 rounded-2xl hover:bg-slate-100 dark:hover:bg-white/[0.06] transition cursor-pointer group"
                                >
                                    <div className="w-10 h-10 rounded-2xl bg-slate-800/15 dark:bg-white/10 text-slate-900 dark:text-white flex items-center justify-center group-hover:scale-105 transition-transform font-bold text-xs">
                                        𝕏
                                    </div>
                                    <span className="text-[10px] font-medium text-slate-600 dark:text-slate-300">X</span>
                                </button>

                                <button
                                    type="button"
                                    onClick={handleShareTelegram}
                                    className="flex flex-col items-center gap-1.5 p-2 rounded-2xl hover:bg-slate-100 dark:hover:bg-white/[0.06] transition cursor-pointer group"
                                >
                                    <div className="w-10 h-10 rounded-2xl bg-sky-500/15 text-sky-500 flex items-center justify-center group-hover:scale-105 transition-transform">
                                        <Send className="w-4 h-4 ml-0.5" />
                                    </div>
                                    <span className="text-[10px] font-medium text-slate-600 dark:text-slate-300">Telegram</span>
                                </button>

                                <button
                                    type="button"
                                    onClick={handleShareWhatsApp}
                                    className="flex flex-col items-center gap-1.5 p-2 rounded-2xl hover:bg-slate-100 dark:hover:bg-white/[0.06] transition cursor-pointer group"
                                >
                                    <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 text-emerald-500 flex items-center justify-center group-hover:scale-105 transition-transform">
                                        <MessageCircle className="w-4 h-4" />
                                    </div>
                                    <span className="text-[10px] font-medium text-slate-600 dark:text-slate-300">WhatsApp</span>
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    )

    return createPortal(content, document.body)
}
