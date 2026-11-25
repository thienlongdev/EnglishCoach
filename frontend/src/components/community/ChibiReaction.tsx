'use client'

import React from 'react'
import { ReactionType } from '@/types/community'

export type ChibiSize = 'sm' | 'md' | 'lg' | 'xl'

export interface ChibiReactionProps {
    type: ReactionType
    size?: ChibiSize
    animate?: boolean
    className?: string
}

export interface ReactionMetadata {
    type: ReactionType
    label: string
    vietnameseName: string
    fallbackEmoji: string
    colorClass: string
    activeBg: string
    badgeBg: string
}

export const DEFAULT_REACTION_TYPES: ReactionType[] = [
    'LOVE',
    'HAHA',
    'SUPPORT',
    'SAD',
    'USEFUL',
]

export const EXTENDED_REACTION_TYPES: ReactionType[] = [
    'WOW',
    'CONFUSED',
    'ANGRY',
    'CLAP',
    'FIRE',
    'THINKING',
    'CELEBRATE',
]

export const REACTION_METADATA: Record<string, ReactionMetadata> = {
    LOVE: {
        type: 'LOVE',
        label: 'Yêu thích',
        vietnameseName: 'Yêu thích',
        fallbackEmoji: '❤️',
        colorClass: 'text-rose-500',
        activeBg: 'hover:bg-rose-500/10 text-rose-600 dark:text-rose-400',
        badgeBg: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
    },
    HAHA: {
        type: 'HAHA',
        label: 'Haha',
        vietnameseName: 'Haha',
        fallbackEmoji: '😂',
        colorClass: 'text-amber-500',
        activeBg: 'hover:bg-amber-500/10 text-amber-600 dark:text-amber-400',
        badgeBg: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    },
    SUPPORT: {
        type: 'SUPPORT',
        label: 'Cố lên',
        vietnameseName: 'Cố lên',
        fallbackEmoji: '💪',
        colorClass: 'text-emerald-500',
        activeBg: 'hover:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        badgeBg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    },
    SAD: {
        type: 'SAD',
        label: 'Buồn',
        vietnameseName: 'Buồn',
        fallbackEmoji: '😢',
        colorClass: 'text-sky-500',
        activeBg: 'hover:bg-sky-500/10 text-sky-600 dark:text-sky-400',
        badgeBg: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
    },
    USEFUL: {
        type: 'USEFUL',
        label: 'Hữu ích',
        vietnameseName: 'Hữu ích',
        fallbackEmoji: '💡',
        colorClass: 'text-yellow-500',
        activeBg: 'hover:bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
        badgeBg: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20',
    },
    WOW: {
        type: 'WOW',
        label: 'Bất ngờ',
        vietnameseName: 'Bất ngờ',
        fallbackEmoji: '😮',
        colorClass: 'text-indigo-500',
        activeBg: 'hover:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
        badgeBg: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
    },
    CONFUSED: {
        type: 'CONFUSED',
        label: 'Khó hiểu',
        vietnameseName: 'Khó hiểu',
        fallbackEmoji: '😕',
        colorClass: 'text-purple-500',
        activeBg: 'hover:bg-purple-500/10 text-purple-600 dark:text-purple-400',
        badgeBg: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
    },
    ANGRY: {
        type: 'ANGRY',
        label: 'Tức giận',
        vietnameseName: 'Tức giận',
        fallbackEmoji: '😡',
        colorClass: 'text-red-500',
        activeBg: 'hover:bg-red-500/10 text-red-600 dark:text-red-400',
        badgeBg: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
    },
    CLAP: {
        type: 'CLAP',
        label: 'Hay quá',
        vietnameseName: 'Hay quá',
        fallbackEmoji: '👏',
        colorClass: 'text-amber-500',
        activeBg: 'hover:bg-amber-500/10 text-amber-600 dark:text-amber-400',
        badgeBg: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    },
    FIRE: {
        type: 'FIRE',
        label: 'Quá đỉnh',
        vietnameseName: 'Quá đỉnh',
        fallbackEmoji: '🔥',
        colorClass: 'text-orange-500',
        activeBg: 'hover:bg-orange-500/10 text-orange-600 dark:text-orange-400',
        badgeBg: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20',
    },
    THINKING: {
        type: 'THINKING',
        label: 'Suy ngẫm',
        vietnameseName: 'Suy ngẫm',
        fallbackEmoji: '🤔',
        colorClass: 'text-teal-500',
        activeBg: 'hover:bg-teal-500/10 text-teal-600 dark:text-teal-400',
        badgeBg: 'bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/20',
    },
    CELEBRATE: {
        type: 'CELEBRATE',
        label: 'Chúc mừng',
        vietnameseName: 'Chúc mừng',
        fallbackEmoji: '🎉',
        colorClass: 'text-pink-500',
        activeBg: 'hover:bg-pink-500/10 text-pink-600 dark:text-pink-400',
        badgeBg: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/20',
    },
    // Legacy Aliases
    LIKE: {
        type: 'LOVE',
        label: 'Yêu thích',
        vietnameseName: 'Yêu thích',
        fallbackEmoji: '❤️',
        colorClass: 'text-rose-500',
        activeBg: 'hover:bg-rose-500/10 text-rose-600 dark:text-rose-400',
        badgeBg: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
    },
    IDEA: {
        type: 'USEFUL',
        label: 'Hữu ích',
        vietnameseName: 'Hữu ích',
        fallbackEmoji: '💡',
        colorClass: 'text-yellow-500',
        activeBg: 'hover:bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
        badgeBg: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20',
    },
    STRONG: {
        type: 'SUPPORT',
        label: 'Cố lên',
        vietnameseName: 'Cố lên',
        fallbackEmoji: '💪',
        colorClass: 'text-emerald-500',
        activeBg: 'hover:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        badgeBg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    },
}

export function getReactionMeta(type?: ReactionType | null): ReactionMetadata {
    if (!type) return REACTION_METADATA.LOVE
    return REACTION_METADATA[type] || REACTION_METADATA.LOVE
}

export function ChibiReaction({
    type,
    size = 'md',
    animate = false,
    className = '',
}: ChibiReactionProps) {
    const canonicalType = (type === 'LIKE' ? 'LOVE' : type === 'IDEA' ? 'USEFUL' : type === 'STRONG' ? 'SUPPORT' : type) || 'LOVE'

    const sizePx = size === 'sm' ? 16 : size === 'md' ? 20 : size === 'lg' ? 28 : 36

    const animClass = animate
        ? 'motion-safe:animate-chibi-breathe motion-reduce:transform-none'
        : ''

    return (
        <span
            className={`inline-flex items-center justify-center shrink-0 select-none ${animClass} ${className}`}
            style={{ width: `${sizePx}px`, height: `${sizePx}px` }}
            title={REACTION_METADATA[canonicalType]?.vietnameseName || canonicalType}
        >
            {renderChibiSvg(canonicalType, sizePx, animate)}
        </span>
    )
}

function renderChibiSvg(type: string, size: number, animate: boolean) {
    switch (type) {
        case 'LOVE':
            return (
                <svg
                    viewBox="0 0 36 36"
                    width={size}
                    height={size}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={animate ? 'origin-center motion-safe:animate-[chibi-love_1.6s_ease-in-out_infinite]' : ''}
                >
                    <defs>
                        <linearGradient id="loveGrad" x1="6" y1="6" x2="30" y2="34" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#FF4D6D" />
                            <stop offset="0.6" stopColor="#E60039" />
                            <stop offset="1" stopColor="#A80026" />
                        </linearGradient>
                        <radialGradient id="loveShine" cx="12" cy="11" r="9" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#FFA3B5" stopOpacity="0.85" />
                            <stop offset="1" stopColor="#FF4D6D" stopOpacity="0" />
                        </radialGradient>
                    </defs>
                    {/* Shadow */}
                    <ellipse cx="18" cy="33" rx="10" ry="2.5" fill="#000000" fillOpacity="0.25" />
                    {/* Heart Body */}
                    <path
                        d="M18 31.5C18 31.5 4 22.8 4 13.5C4 8.5 7.8 4.5 12.8 4.5C15.6 4.5 17.2 5.8 18 6.9C18.8 5.8 20.4 4.5 23.2 4.5C28.2 4.5 32 8.5 32 13.5C32 22.8 18 31.5 18 31.5Z"
                        fill="url(#loveGrad)"
                        stroke="#80001D"
                        strokeWidth="1.2"
                    />
                    {/* Specular 3D Highlight */}
                    <path
                        d="M18 31.5C18 31.5 4 22.8 4 13.5C4 8.5 7.8 4.5 12.8 4.5C15.6 4.5 17.2 5.8 18 6.9C18.8 5.8 20.4 4.5 23.2 4.5C28.2 4.5 32 8.5 32 13.5C32 22.8 18 31.5 18 31.5Z"
                        fill="url(#loveShine)"
                    />
                    <ellipse cx="12" cy="11" rx="3.5" ry="2" transform="rotate(-30 12 11)" fill="#FFFFFF" fillOpacity="0.65" />
                    {/* Chibi Face Details */}
                    <circle cx="13" cy="15.5" r="1.5" fill="#2E020C" />
                    <circle cx="23" cy="15.5" r="1.5" fill="#2E020C" />
                    <circle cx="13.5" cy="15" r="0.6" fill="#FFFFFF" />
                    <circle cx="23.5" cy="15" r="0.6" fill="#FFFFFF" />
                    {/* Blushing cheeks */}
                    <ellipse cx="10" cy="17.5" rx="2" ry="1.2" fill="#FFA3B5" fillOpacity="0.8" />
                    <ellipse cx="26" cy="17.5" rx="2" ry="1.2" fill="#FFA3B5" fillOpacity="0.8" />
                    {/* Cute mouth */}
                    <path d="M16 18C16.8 19.2 19.2 19.2 20 18" stroke="#2E020C" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
            )

        case 'HAHA':
            return (
                <svg
                    viewBox="0 0 36 36"
                    width={size}
                    height={size}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={animate ? 'origin-center motion-safe:animate-[chibi-haha_1.4s_ease-in-out_infinite]' : ''}
                >
                    <defs>
                        <linearGradient id="hahaGrad" x1="4" y1="4" x2="32" y2="34" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#FFDE59" />
                            <stop offset="0.75" stopColor="#FF9F1C" />
                            <stop offset="1" stopColor="#E86E00" />
                        </linearGradient>
                        <radialGradient id="hahaShine" cx="13" cy="10" r="12" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#FFF2B2" stopOpacity="0.8" />
                            <stop offset="1" stopColor="#FFDE59" stopOpacity="0" />
                        </radialGradient>
                    </defs>
                    <ellipse cx="18" cy="33" rx="10" ry="2.5" fill="#000000" fillOpacity="0.25" />
                    <circle cx="18" cy="18" r="14" fill="url(#hahaGrad)" stroke="#B35500" strokeWidth="1.2" />
                    <circle cx="18" cy="18" r="14" fill="url(#hahaShine)" />
                    {/* Laughing closed eyes (crests) */}
                    <path d="M10 15C11 12 14 12 15 15" stroke="#4A2600" strokeWidth="2" strokeLinecap="round" />
                    <path d="M21 15C22 12 25 12 26 15" stroke="#4A2600" strokeWidth="2" strokeLinecap="round" />
                    {/* Rosy cheeks */}
                    <ellipse cx="9" cy="19" rx="2" ry="1.2" fill="#FF5964" fillOpacity="0.6" />
                    <ellipse cx="27" cy="19" rx="2" ry="1.2" fill="#FF5964" fillOpacity="0.6" />
                    {/* Open laughing mouth with tongue */}
                    <path d="M12 20C12 26 24 26 24 20Z" fill="#7A0014" stroke="#4A2600" strokeWidth="1" />
                    <path d="M15 24C16 22 20 22 21 24C19.5 25.8 16.5 25.8 15 24Z" fill="#FF6B8B" />
                    {/* Specular highlight */}
                    <ellipse cx="12" cy="9" rx="3.5" ry="1.8" transform="rotate(-30 12 9)" fill="#FFFFFF" fillOpacity="0.55" />
                </svg>
            )

        case 'SUPPORT':
            return (
                <svg
                    viewBox="0 0 36 36"
                    width={size}
                    height={size}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={animate ? 'origin-bottom motion-safe:animate-[chibi-punch_1.2s_ease-out_infinite]' : ''}
                >
                    <defs>
                        <linearGradient id="supportGrad" x1="6" y1="4" x2="30" y2="34" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#34D399" />
                            <stop offset="0.65" stopColor="#059669" />
                            <stop offset="1" stopColor="#065F46" />
                        </linearGradient>
                        <radialGradient id="supportGlow" cx="18" cy="14" r="14" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#A7F3D0" stopOpacity="0.7" />
                            <stop offset="1" stopColor="#059669" stopOpacity="0" />
                        </radialGradient>
                    </defs>
                    <ellipse cx="18" cy="33" rx="10" ry="2.5" fill="#000000" fillOpacity="0.25" />
                    {/* Flexed energetic arm / boxing fist shape */}
                    <path
                        d="M10 26C10 28.5 13.5 30 18 30C22.5 30 26 28.5 26 26C26 23 24 21 24 18C24 13.5 20.5 7 18 7C15.5 7 12 13.5 12 18C12 21 10 23 10 26Z"
                        fill="url(#supportGrad)"
                        stroke="#044E39"
                        strokeWidth="1.2"
                    />
                    <path
                        d="M10 26C10 28.5 13.5 30 18 30C22.5 30 26 28.5 26 26C26 23 24 21 24 18C24 13.5 20.5 7 18 7C15.5 7 12 13.5 12 18C12 21 10 23 10 26Z"
                        fill="url(#supportGlow)"
                    />
                    {/* Fist crest knuckles */}
                    <path d="M14 11C15 9.5 17 9.5 18 11C19 9.5 21 9.5 22 11" stroke="#A7F3D0" strokeWidth="1.8" strokeLinecap="round" />
                    {/* Determination eyes on fist */}
                    <circle cx="15.5" cy="18" r="1.3" fill="#044E39" />
                    <circle cx="20.5" cy="18" r="1.3" fill="#044E39" />
                    <circle cx="16" cy="17.6" r="0.5" fill="#FFFFFF" />
                    <circle cx="21" cy="17.6" r="0.5" fill="#FFFFFF" />
                    <path d="M16 21.5C17.2 22.5 18.8 22.5 20 21.5" stroke="#044E39" strokeWidth="1.2" strokeLinecap="round" />
                    {/* Power lines */}
                    <path d="M6 14L8 16" stroke="#10B981" strokeWidth="1.5" strokeLinecap="round" />
                    <path d="M30 14L28 16" stroke="#10B981" strokeWidth="1.5" strokeLinecap="round" />
                    <path d="M18 3L18 5" stroke="#34D399" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
            )

        case 'SAD':
            return (
                <svg
                    viewBox="0 0 36 36"
                    width={size}
                    height={size}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={animate ? 'origin-top motion-safe:animate-[chibi-sad_1.8s_ease-in-out_infinite]' : ''}
                >
                    <defs>
                        <linearGradient id="sadGrad" x1="4" y1="4" x2="32" y2="34" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#67E8F9" />
                            <stop offset="0.65" stopColor="#0284C7" />
                            <stop offset="1" stopColor="#0369A1" />
                        </linearGradient>
                        <radialGradient id="sadShine" cx="13" cy="10" r="12" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#BAE6FD" stopOpacity="0.8" />
                            <stop offset="1" stopColor="#67E8F9" stopOpacity="0" />
                        </radialGradient>
                    </defs>
                    <ellipse cx="18" cy="33" rx="10" ry="2.5" fill="#000000" fillOpacity="0.25" />
                    <circle cx="18" cy="18" r="14" fill="url(#sadGrad)" stroke="#075985" strokeWidth="1.2" />
                    <circle cx="18" cy="18" r="14" fill="url(#sadShine)" />
                    {/* Sad angled eyebrows */}
                    <path d="M10 13C12 11.5 14 13 15 14" stroke="#0C4A6E" strokeWidth="1.5" strokeLinecap="round" />
                    <path d="M26 13C24 11.5 22 13 21 14" stroke="#0C4A6E" strokeWidth="1.5" strokeLinecap="round" />
                    {/* Glistening big watery eyes */}
                    <ellipse cx="13.5" cy="17" rx="2.5" ry="3" fill="#0C4A6E" />
                    <ellipse cx="22.5" cy="17" rx="2.5" ry="3" fill="#0C4A6E" />
                    <circle cx="12.5" cy="15.5" r="1.2" fill="#FFFFFF" />
                    <circle cx="21.5" cy="15.5" r="1.2" fill="#FFFFFF" />
                    <circle cx="14.5" cy="18" r="0.6" fill="#FFFFFF" />
                    <circle cx="23.5" cy="18" r="0.6" fill="#FFFFFF" />
                    {/* Tear drop */}
                    <path
                        d="M24.5 19C24.5 19 23 22 23 23.5C23 24.5 23.8 25.5 25 25.5C26.2 25.5 27 24.5 27 23.5C27 22 24.5 19 24.5 19Z"
                        fill="#E0F2FE"
                        stroke="#0284C7"
                        strokeWidth="0.8"
                    />
                    {/* Sad downturned mouth */}
                    <path d="M15 24C16.5 22.5 19.5 22.5 21 24" stroke="#0C4A6E" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
            )

        case 'USEFUL':
            return (
                <svg
                    viewBox="0 0 36 36"
                    width={size}
                    height={size}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={animate ? 'origin-center motion-safe:animate-[chibi-bulb_1.5s_ease-in-out_infinite]' : ''}
                >
                    <defs>
                        <linearGradient id="bulbGrad" x1="8" y1="4" x2="28" y2="30" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#FEF08A" />
                            <stop offset="0.6" stopColor="#FACC15" />
                            <stop offset="1" stopColor="#CA8A04" />
                        </linearGradient>
                        <radialGradient id="bulbGlow" cx="18" cy="14" r="13" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#FEF9C3" stopOpacity="0.9" />
                            <stop offset="1" stopColor="#FACC15" stopOpacity="0" />
                        </radialGradient>
                    </defs>
                    <ellipse cx="18" cy="33" rx="8" ry="2" fill="#000000" fillOpacity="0.25" />
                    {/* Bulb Glass */}
                    <path
                        d="M18 4C11.5 4 8 9 8 15C8 19 11 21.5 12.5 24H23.5C25 21.5 28 19 28 15C28 9 24.5 4 18 4Z"
                        fill="url(#bulbGrad)"
                        stroke="#A16207"
                        strokeWidth="1.2"
                    />
                    <path
                        d="M18 4C11.5 4 8 9 8 15C8 19 11 21.5 12.5 24H23.5C25 21.5 28 19 28 15C28 9 24.5 4 18 4Z"
                        fill="url(#bulbGlow)"
                    />
                    {/* Screw Base */}
                    <path d="M13 24H23V27H13V24Z" fill="#94A3B8" stroke="#475569" strokeWidth="1" />
                    <path d="M14 27H22V29.5H14V27Z" fill="#64748B" stroke="#475569" strokeWidth="1" />
                    <path d="M16 29.5H20V31H16V29.5Z" fill="#334155" />
                    {/* Bulb Filament / Happy Face */}
                    <circle cx="14" cy="14" r="1.3" fill="#713F12" />
                    <circle cx="22" cy="14" r="1.3" fill="#713F12" />
                    <path d="M16 17C17 18.5 19 18.5 20 17" stroke="#713F12" strokeWidth="1.3" strokeLinecap="round" />
                    {/* Light Rays */}
                    <path d="M18 0.5L18 2.5" stroke="#FBBF24" strokeWidth="1.8" strokeLinecap="round" />
                    <path d="M5 6L7 7.5" stroke="#FBBF24" strokeWidth="1.8" strokeLinecap="round" />
                    <path d="M31 6L29 7.5" stroke="#FBBF24" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
            )

        case 'WOW':
            return (
                <svg
                    viewBox="0 0 36 36"
                    width={size}
                    height={size}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={animate ? 'origin-center motion-safe:animate-[chibi-wow_1.3s_ease-out_infinite]' : ''}
                >
                    <defs>
                        <linearGradient id="wowGrad" x1="4" y1="4" x2="32" y2="34" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#818CF8" />
                            <stop offset="0.7" stopColor="#4F46E5" />
                            <stop offset="1" stopColor="#3730A3" />
                        </linearGradient>
                    </defs>
                    <ellipse cx="18" cy="33" rx="10" ry="2.5" fill="#000000" fillOpacity="0.25" />
                    <circle cx="18" cy="18" r="14" fill="url(#wowGrad)" stroke="#312E81" strokeWidth="1.2" />
                    {/* High raised eyebrows */}
                    <path d="M10 10C11.5 8.5 14 9 15 10.5" stroke="#E0E7FF" strokeWidth="1.6" strokeLinecap="round" />
                    <path d="M26 10C24.5 8.5 22 9 21 10.5" stroke="#E0E7FF" strokeWidth="1.6" strokeLinecap="round" />
                    {/* Wide open round eyes */}
                    <circle cx="13" cy="15" r="3.2" fill="#FFFFFF" />
                    <circle cx="23" cy="15" r="3.2" fill="#FFFFFF" />
                    <circle cx="13.2" cy="15.2" r="1.8" fill="#1E1B4B" />
                    <circle cx="23.2" cy="15.2" r="1.8" fill="#1E1B4B" />
                    <circle cx="14" cy="14.2" r="0.8" fill="#FFFFFF" />
                    <circle cx="24" cy="14.2" r="0.8" fill="#FFFFFF" />
                    {/* Open O-shaped mouth */}
                    <ellipse cx="18" cy="23" rx="3.5" ry="4.5" fill="#1E1B4B" stroke="#E0E7FF" strokeWidth="1" />
                </svg>
            )

        case 'CONFUSED':
            return (
                <svg
                    viewBox="0 0 36 36"
                    width={size}
                    height={size}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={animate ? 'origin-center motion-safe:animate-[chibi-wobble_1.5s_ease-in-out_infinite]' : ''}
                >
                    <defs>
                        <linearGradient id="confusedGrad" x1="4" y1="4" x2="32" y2="34" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#C084FC" />
                            <stop offset="0.7" stopColor="#9333EA" />
                            <stop offset="1" stopColor="#6B21A8" />
                        </linearGradient>
                    </defs>
                    <ellipse cx="18" cy="33" rx="10" ry="2.5" fill="#000000" fillOpacity="0.25" />
                    <circle cx="18" cy="18" r="14" fill="url(#confusedGrad)" stroke="#581C87" strokeWidth="1.2" />
                    {/* One eyebrow raised, one lowered */}
                    <path d="M10 11C12 9 14.5 10 15 11.5" stroke="#F3E8FF" strokeWidth="1.6" strokeLinecap="round" />
                    <path d="M21 14C22.5 13 25 14 26 15" stroke="#F3E8FF" strokeWidth="1.6" strokeLinecap="round" />
                    {/* Eyes */}
                    <circle cx="13" cy="16" r="2.2" fill="#3B0764" />
                    <circle cx="23" cy="17.5" r="1.7" fill="#3B0764" />
                    <circle cx="13.5" cy="15.5" r="0.7" fill="#FFFFFF" />
                    {/* Wavy mouth */}
                    <path d="M13 23C15 22 17 24 19 22.5C21 21 23 23 24 23.5" stroke="#3B0764" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
            )

        case 'ANGRY':
            return (
                <svg
                    viewBox="0 0 36 36"
                    width={size}
                    height={size}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={animate ? 'origin-center motion-safe:animate-[chibi-shake_0.4s_ease-in-out_infinite]' : ''}
                >
                    <defs>
                        <linearGradient id="angryGrad" x1="4" y1="4" x2="32" y2="34" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#F87171" />
                            <stop offset="0.65" stopColor="#DC2626" />
                            <stop offset="1" stopColor="#991B1B" />
                        </linearGradient>
                    </defs>
                    <ellipse cx="18" cy="33" rx="10" ry="2.5" fill="#000000" fillOpacity="0.25" />
                    <circle cx="18" cy="18" r="14" fill="url(#angryGrad)" stroke="#7F1D1D" strokeWidth="1.2" />
                    {/* Furrowed steep eyebrows */}
                    <path d="M9 12L15 15.5" stroke="#450A0A" strokeWidth="2.2" strokeLinecap="round" />
                    <path d="M27 12L21 15.5" stroke="#450A0A" strokeWidth="2.2" strokeLinecap="round" />
                    {/* Angry squinting eyes */}
                    <circle cx="13" cy="17.5" r="1.5" fill="#450A0A" />
                    <circle cx="23" cy="17.5" r="1.5" fill="#450A0A" />
                    {/* Grimace / grit teeth mouth */}
                    <rect x="12" y="21" width="12" height="4" rx="2" fill="#FFFFFF" stroke="#450A0A" strokeWidth="1" />
                    <line x1="16" y1="21" x2="16" y2="25" stroke="#450A0A" strokeWidth="0.8" />
                    <line x1="20" y1="21" x2="20" y2="25" stroke="#450A0A" strokeWidth="0.8" />
                </svg>
            )

        case 'CLAP':
            return (
                <svg
                    viewBox="0 0 36 36"
                    width={size}
                    height={size}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={animate ? 'origin-bottom motion-safe:animate-[chibi-clap_1.2s_ease-out_infinite]' : ''}
                >
                    <defs>
                        <linearGradient id="clapGrad" x1="4" y1="4" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#FBBF24" />
                            <stop offset="0.75" stopColor="#D97706" />
                            <stop offset="1" stopColor="#B45309" />
                        </linearGradient>
                    </defs>
                    <ellipse cx="18" cy="33" rx="10" ry="2.5" fill="#000000" fillOpacity="0.25" />
                    {/* Left hand */}
                    <path
                        d="M12 28L6 20C4.5 18 5 15 7.5 14C9.5 13 11.5 14 13 16L18 22L12 28Z"
                        fill="url(#clapGrad)"
                        stroke="#78350F"
                        strokeWidth="1.2"
                    />
                    {/* Right hand */}
                    <path
                        d="M24 28L30 20C31.5 18 31 15 28.5 14C26.5 13 24.5 14 23 16L18 22L24 28Z"
                        fill="url(#clapGrad)"
                        stroke="#78350F"
                        strokeWidth="1.2"
                    />
                    {/* Impact ripples */}
                    <path d="M18 9L18 6" stroke="#F59E0B" strokeWidth="1.6" strokeLinecap="round" />
                    <path d="M12 11L10 9" stroke="#F59E0B" strokeWidth="1.6" strokeLinecap="round" />
                    <path d="M24 11L26 9" stroke="#F59E0B" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
            )

        case 'FIRE':
            return (
                <svg
                    viewBox="0 0 36 36"
                    width={size}
                    height={size}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={animate ? 'origin-bottom motion-safe:animate-[chibi-fire_1.2s_ease-in-out_infinite]' : ''}
                >
                    <defs>
                        <linearGradient id="fireOuter" x1="4" y1="4" x2="32" y2="34" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#FB923C" />
                            <stop offset="0.6" stopColor="#EA580C" />
                            <stop offset="1" stopColor="#C2410C" />
                        </linearGradient>
                        <linearGradient id="fireInner" x1="10" y1="12" x2="26" y2="32" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#FEF08A" />
                            <stop offset="0.8" stopColor="#FBBF24" />
                            <stop offset="1" stopColor="#F97316" />
                        </linearGradient>
                    </defs>
                    <ellipse cx="18" cy="33" rx="9" ry="2.2" fill="#000000" fillOpacity="0.25" />
                    {/* Outer flame */}
                    <path
                        d="M18 4C18 4 28 12 28 22C28 27.5 23.5 32 18 32C12.5 32 8 27.5 8 22C8 14 15 10 15 10C15 10 13 14 15 16C17 18 19 16 18 4Z"
                        fill="url(#fireOuter)"
                        stroke="#9A3412"
                        strokeWidth="1.2"
                    />
                    {/* Inner yellow core */}
                    <path
                        d="M18 14C18 14 23 18 23 24C23 27 21 29 18 29C15 29 13 27 13 24C13 19 16 17 16 17C16 17 15 19 16 20C17 21 18 20 18 14Z"
                        fill="url(#fireInner)"
                    />
                </svg>
            )

        case 'THINKING':
            return (
                <svg
                    viewBox="0 0 36 36"
                    width={size}
                    height={size}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={animate ? 'origin-center motion-safe:animate-[chibi-tilt_1.8s_ease-in-out_infinite]' : ''}
                >
                    <defs>
                        <linearGradient id="thinkGrad" x1="4" y1="4" x2="32" y2="34" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#2DD4BF" />
                            <stop offset="0.7" stopColor="#0D9488" />
                            <stop offset="1" stopColor="#115E59" />
                        </linearGradient>
                    </defs>
                    <ellipse cx="18" cy="33" rx="10" ry="2.5" fill="#000000" fillOpacity="0.25" />
                    <circle cx="18" cy="18" r="14" fill="url(#thinkGrad)" stroke="#134E4A" strokeWidth="1.2" />
                    {/* Eyebrows looking up */}
                    <path d="M10 11C12 9.5 14 11 15 12" stroke="#CCFBF1" strokeWidth="1.5" strokeLinecap="round" />
                    <path d="M21 12C22 11 24 9.5 26 11" stroke="#CCFBF1" strokeWidth="1.5" strokeLinecap="round" />
                    {/* Eyes looking up-right */}
                    <circle cx="14" cy="14" r="1.6" fill="#042F2E" />
                    <circle cx="23" cy="14" r="1.6" fill="#042F2E" />
                    <circle cx="14.6" cy="13.5" r="0.6" fill="#FFFFFF" />
                    <circle cx="23.6" cy="13.5" r="0.6" fill="#FFFFFF" />
                    {/* Pensive mouth */}
                    <path d="M14 21C16 20.5 19 20.5 21 21" stroke="#042F2E" strokeWidth="1.5" strokeLinecap="round" />
                    {/* Hand on chin */}
                    <path d="M12 28C14 26 18 25 21 26C21.5 27 20 28.5 18 29L12 28Z" fill="#5EEAD4" stroke="#134E4A" strokeWidth="1" />
                </svg>
            )

        case 'CELEBRATE':
            return (
                <svg
                    viewBox="0 0 36 36"
                    width={size}
                    height={size}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={animate ? 'origin-center motion-safe:animate-[chibi-celebrate_1.3s_ease-out_infinite]' : ''}
                >
                    <defs>
                        <linearGradient id="partyCone" x1="6" y1="28" x2="22" y2="12" gradientUnits="userSpaceOnUse">
                            <stop stopColor="#F43F5E" />
                            <stop offset="0.5" stopColor="#E11D48" />
                            <stop offset="1" stopColor="#BE123C" />
                        </linearGradient>
                    </defs>
                    <ellipse cx="18" cy="33" rx="9" ry="2.2" fill="#000000" fillOpacity="0.25" />
                    {/* Party horn cone */}
                    <path d="M6 30L12 16L24 24L10 32L6 30Z" fill="url(#partyCone)" stroke="#881337" strokeWidth="1.2" />
                    <path d="M12 16C16 19 20 21 24 24" stroke="#FFE4E6" strokeWidth="1.5" />
                    {/* Confetti geometric bursts (No sparkles, no asterisks) */}
                    <circle cx="26" cy="10" r="1.8" fill="#F59E0B" />
                    <circle cx="21" cy="7" r="1.4" fill="#06B6D4" />
                    <rect x="28" y="16" width="3" height="3" rx="0.8" fill="#10B981" transform="rotate(25 28 16)" />
                    <rect x="15" y="4" width="2.5" height="2.5" rx="0.6" fill="#8B5CF6" transform="rotate(-15 15 4)" />
                    <circle cx="31" cy="9" r="1.2" fill="#EC4899" />
                </svg>
            )

        default:
            return <span className="text-base select-none">{REACTION_METADATA.LOVE.fallbackEmoji}</span>
    }
}
