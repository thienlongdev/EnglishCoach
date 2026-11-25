'use client'

import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Clock, Smile, Heart, Frown, Flame, Award, ThumbsUp, BookOpen, X } from 'lucide-react'
import styles from './communityGlass.module.css'

export interface ComposerEmojiPickerProps {
    isOpen: boolean
    onClose: () => void
    onSelectEmoji: (emoji: string) => void
    anchorRect?: DOMRect | null
    anchorRef?: React.RefObject<HTMLElement | null>
}

interface EmojiCategory {
    id: string
    label: string
    icon: React.ReactNode
    emojis: string[]
}

const EMOJI_CATEGORIES: EmojiCategory[] = [
    {
        id: 'emotions',
        label: 'Cảm xúc',
        icon: <Smile className="w-3.5 h-3.5" />,
        emojis: [
            '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '🥲', '🥹',
            '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😋',
            '😛', '😜', '🤪', '🤓', '😎', '🥳', '🤩', '🤠', '😏', '🧐',
        ],
    },
    {
        id: 'love',
        label: 'Tình cảm',
        icon: <Heart className="w-3.5 h-3.5" />,
        emojis: [
            '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
            '❤️‍🔥', '❤️‍🩹', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝',
        ],
    },
    {
        id: 'sad',
        label: 'Buồn',
        icon: <Frown className="w-3.5 h-3.5" />,
        emojis: [
            '😢', '😭', '🥺', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣',
            '😖', '😫', '😩', '🥱', '😤', '😮‍💨', '😓', '😥', '😰', '😨',
        ],
    },
    {
        id: 'angry',
        label: 'Tức giận',
        icon: <Flame className="w-3.5 h-3.5" />,
        emojis: [
            '😡', '😠', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '🫣', '🤐',
            '🤫', '🫠', '🫡', '🤥', '🤢', '🤮', '🤧', '😷', '🤒', '🤕',
        ],
    },
    {
        id: 'celebrate',
        label: 'Chúc mừng',
        icon: <Award className="w-3.5 h-3.5" />,
        emojis: [
            '🎉', '🎊', '🎈', '🎁', '🏆', '🥇', '🥈', '🥉', '🎖️', '🏅',
            '🥂', '🍾', '🥳', '👏', '🙌', '🎇', '🎆', '🏮', '🌟', '⭐',
        ],
    },
    {
        id: 'gestures',
        label: 'Cử chỉ',
        icon: <ThumbsUp className="w-3.5 h-3.5" />,
        emojis: [
            '👍', '👎', '👏', '🙌', '👐', '🤲', '🤝', '🤜', '🤛', '✊',
            '👊', '✌️', '🤞', '🫰', '🤟', '🤘', '👌', '🤌', '🤏', '👈',
            '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋', '🤙',
            '💪', '🦾', '🙏',
        ],
    },
    {
        id: 'study',
        label: 'Học tập',
        icon: <BookOpen className="w-3.5 h-3.5" />,
        emojis: [
            '📚', '📖', '📕', '📗', '📘', '📙', '📝', '✏️', '✒️', '🖋️',
            '🎓', '🏫', '🎒', '🧠', '💡', '🔍', '🔎', '📌', '📍', '🎯',
            '🗣️', '👂', '🎧', '💬', '💭', '📜', '📑', '📊', '📈', '📋',
        ],
    },
]

const STORAGE_KEY_RECENT = 'ec_recent_emojis'
const DEFAULT_RECENTS = ['❤️', '😂', '👍', '💪', '💡', '📚', '👏', '🎉']

export function ComposerEmojiPicker({
    isOpen,
    onClose,
    onSelectEmoji,
    anchorRect,
    anchorRef,
}: ComposerEmojiPickerProps) {
    const [recentEmojis, setRecentEmojis] = useState<string[]>([])
    const [activeTab, setActiveTab] = useState<string>('recent')
    const [mounted, setMounted] = useState(false)
    const [pickerStyle, setPickerStyle] = useState<React.CSSProperties>({
        position: 'fixed',
        left: 20,
        top: 100,
        width: 320,
        zIndex: 9999,
    })
    const pickerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        setMounted(true)
        try {
            const raw = localStorage.getItem(STORAGE_KEY_RECENT)
            if (raw) {
                const parsed = JSON.parse(raw)
                if (Array.isArray(parsed) && parsed.length > 0) {
                    setRecentEmojis(parsed)
                    return
                }
            }
        } catch {
            // fallback
        }
        setRecentEmojis(DEFAULT_RECENTS)
    }, [])

    const handleSelect = (emoji: string) => {
        onSelectEmoji(emoji)
        // Update recent list
        setRecentEmojis((prev) => {
            const next = [emoji, ...prev.filter((e) => e !== emoji)].slice(0, 16)
            try {
                localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(next))
            } catch {
                // Ignore storage quota
            }
            return next
        })
    }

    // Dynamic attached positioning calculation with collision detection & zero-gap anchoring
    const updatePosition = React.useCallback(() => {
        let rect: DOMRect | null = null
        if (anchorRef?.current) {
            rect = anchorRef.current.getBoundingClientRect()
        } else if (anchorRect) {
            rect = anchorRect
        }
        if (!rect) return

        const pickerWidth = Math.min(320, typeof window !== 'undefined' ? window.innerWidth - 16 : 320)
        const gap = 6

        // Space above and below anchor button
        const spaceAbove = rect.top
        const spaceBelow = window.innerHeight - rect.bottom

        // If space above is >= 200px or greater than space below: place directly attached ABOVE button
        const placeAbove = spaceAbove >= 200 || spaceAbove >= spaceBelow

        // Horizontal alignment: align to button edge and clamp inside viewport with 8px margin
        let left: number
        if (rect.left + rect.width / 2 > window.innerWidth / 2) {
            left = rect.right - pickerWidth
        } else {
            left = rect.left
        }
        left = Math.max(8, Math.min(window.innerWidth - pickerWidth - 8, left))

        if (placeAbove) {
            // Attached directly above button with exactly 6px gap
            const bottom = Math.max(8, window.innerHeight - rect.top + gap)
            const maxHeight = Math.max(160, Math.min(320, rect.top - gap - 12))
            setPickerStyle({
                position: 'fixed',
                left: `${left}px`,
                bottom: `${bottom}px`,
                top: 'auto',
                width: `${pickerWidth}px`,
                maxHeight: `${maxHeight}px`,
                zIndex: 9999,
            })
        } else {
            // Flip directly below button with exactly 6px gap
            const top = Math.min(window.innerHeight - 100, rect.bottom + gap)
            const maxHeight = Math.max(160, Math.min(320, window.innerHeight - rect.bottom - gap - 12))
            setPickerStyle({
                position: 'fixed',
                left: `${left}px`,
                top: `${top}px`,
                bottom: 'auto',
                width: `${pickerWidth}px`,
                maxHeight: `${maxHeight}px`,
                zIndex: 9999,
            })
        }
    }, [anchorRect, anchorRef])

    // Update position on open, scroll (capture true for modal scroll), and resize
    useEffect(() => {
        if (!isOpen) return
        updatePosition()

        window.addEventListener('scroll', updatePosition, true)
        window.addEventListener('resize', updatePosition)
        return () => {
            window.removeEventListener('scroll', updatePosition, true)
            window.removeEventListener('resize', updatePosition)
        }
    }, [isOpen, updatePosition])

    // Close on escape key
    useEffect(() => {
        if (!isOpen) return
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [isOpen, onClose])

    // Close when clicking outside
    useEffect(() => {
        if (!isOpen) return
        const handleClickOutside = (e: MouseEvent) => {
            if (
                pickerRef.current &&
                !pickerRef.current.contains(e.target as Node) &&
                (!anchorRef?.current || !anchorRef.current.contains(e.target as Node))
            ) {
                onClose()
            }
        }
        const timer = setTimeout(() => {
            window.addEventListener('click', handleClickOutside)
        }, 10)
        return () => {
            clearTimeout(timer)
            window.removeEventListener('click', handleClickOutside)
        }
    }, [isOpen, onClose, anchorRef])

    if (!isOpen || !mounted) return null

    return createPortal(
        <div
            ref={pickerRef}
            style={pickerStyle}
            className={`${styles.world} z-[9999] bg-card dark:bg-card border border-border dark:border-border/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-slate-800 dark:text-slate-100 animate-in fade-in zoom-in-95 duration-150`}
            onClick={(e) => e.stopPropagation()}
        >
            {/* Header / Category Tabs */}
            <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border/80 dark:border-sky-900/30 bg-surface-container-low/40">
                <div className="flex items-center gap-1 overflow-x-auto scrollbar-none py-0.5">
                    <button
                        type="button"
                        onClick={() => setActiveTab('recent')}
                        className={`p-1.5 rounded-lg text-xs transition cursor-pointer ${
                            activeTab === 'recent'
                                ? 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 font-bold'
                                : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                        }`}
                        title="Gần đây"
                    >
                        <Clock className="w-3.5 h-3.5" />
                    </button>
                    {EMOJI_CATEGORIES.map((cat) => (
                        <button
                            key={cat.id}
                            type="button"
                            onClick={() => setActiveTab(cat.id)}
                            className={`p-1.5 rounded-lg text-xs transition cursor-pointer ${
                                activeTab === cat.id
                                    ? 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 font-bold'
                                    : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                            }`}
                            title={cat.label}
                        >
                            {cat.icon}
                        </button>
                    ))}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-white transition cursor-pointer"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            {/* Emoji Grid */}
            <div className="p-2.5 max-h-[220px] overflow-y-auto">
                {activeTab === 'recent' && (
                    <div>
                        <div className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 mb-1.5 px-1">
                            Gần đây
                        </div>
                        <div className="grid grid-cols-8 gap-1">
                            {recentEmojis.map((emoji, idx) => (
                                <button
                                    key={idx}
                                    type="button"
                                    onClick={() => handleSelect(emoji)}
                                    className="w-8 h-8 rounded-lg flex items-center justify-center text-lg hover:bg-slate-100 dark:hover:bg-white/10 active:scale-90 transition-transform cursor-pointer"
                                >
                                    {emoji}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {EMOJI_CATEGORIES.map((cat) => {
                    if (activeTab !== cat.id) return null
                    return (
                        <div key={cat.id}>
                            <div className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 mb-1.5 px-1">
                                {cat.label}
                            </div>
                            <div className="grid grid-cols-8 gap-1">
                                {cat.emojis.map((emoji, idx) => (
                                    <button
                                        key={idx}
                                        type="button"
                                        onClick={() => handleSelect(emoji)}
                                        className="w-8 h-8 rounded-lg flex items-center justify-center text-lg hover:bg-slate-100 dark:hover:bg-white/10 active:scale-90 transition-transform cursor-pointer"
                                    >
                                        {emoji}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>,
        document.body
    )
}
