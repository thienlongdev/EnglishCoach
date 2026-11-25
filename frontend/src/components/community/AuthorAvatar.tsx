'use client'

import React from 'react'
import Image from 'next/image'
import { AuthorSummary } from '@/types/community'
import { AvatarWithFrame } from '@/components/common/frame/AvatarWithFrame'
import { useAvatarFrames } from '@/hooks/useAvatarFrames'
import { AvatarSize } from '@/types/avatarFrame'
import { echoSrc } from '@/lib/brand/echoCharacters';

interface AuthorAvatarProps {
    author: AuthorSummary
    size?: AvatarSize
    className?: string
}

export function AuthorAvatar({ author, size = 'sm', className = '' }: AuthorAvatarProps) {
    const { catalogue = [] } = useAvatarFrames()

    if (author.official) {
        const pxSize = size === 'xs' ? 24 : size === 'sm' ? 40 : size === 'md' ? 64 : 80
        return (
            <div
                className={`relative shrink-0 rounded-full p-0.5 bg-gradient-to-tr from-indigo-400 via-sky-300 to-blue-500 shadow-md shadow-indigo-500/25 ${className}`}
                style={{ width: pxSize, height: pxSize }}
            >
                {/* The official voice of the community: Echo the conversation character, on pale water in both themes */}
                <div className="w-full h-full rounded-full bg-gradient-to-b from-white to-sky-100 flex items-center justify-center overflow-hidden">
                    <Image
                        src={echoSrc('social', 40)}
                        alt="EnglishCoach Official"
                        width={pxSize}
                        height={pxSize}
                        unoptimized
                        className="object-contain"
                    />
                </div>
            </div>
        )
    }

    const frame = author.frame
        ? author.frame
        : author.equippedFrameId
        ? catalogue.find((f) => f.slug === author.equippedFrameId || f.id.toString() === author.equippedFrameId) || null
        : null

    return (
        <AvatarWithFrame
            avatarUrl={author.avatarUrl}
            frame={frame}
            size={size}
            context="card"
            fallbackName={author.displayName}
            className={className}
        />
    )
}
