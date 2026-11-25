'use client'

import React from 'react'
import Link from 'next/link'

interface LinkifiedTextProps {
    text: string
    className?: string
    onHashtagClick?: (tag: string) => void
}

// Regex to safely identify URLs or hashtags (with full Unicode/Vietnamese support)
const TOKEN_REGEX = /(https?:\/\/[^\s<>"'{}|\\^`]+|#[a-zA-Z0-9_\u00C0-\u024F\u1EA0-\u1EF9]+)/g

export function LinkifiedText({ text, className = '', onHashtagClick }: LinkifiedTextProps) {
    if (!text) return null

    // Split text into tokens: URLs, hashtags, and plain text
    const parts = text.split(TOKEN_REGEX)

    return (
        <span className={className}>
            {parts.map((part, index) => {
                if (part.match(/^https?:\/\//i)) {
                    return (
                        <a
                            key={index}
                            href={part}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-cyan-600 dark:text-cyan-400 font-semibold underline decoration-cyan-500/40 hover:decoration-cyan-500 hover:text-cyan-700 dark:hover:text-cyan-300 break-all transition cursor-pointer"
                        >
                            {part}
                        </a>
                    )
                }

                if (part.startsWith('#') && part.length > 1) {
                    const tag = part.slice(1)
                    return (
                        <Link
                            key={index}
                            href={`/community?hashtag=${encodeURIComponent(tag)}`}
                            onClick={(e) => {
                                e.stopPropagation()
                                if (onHashtagClick) {
                                    e.preventDefault()
                                    onHashtagClick(tag)
                                }
                            }}
                            className="text-cyan-600 dark:text-cyan-400 font-semibold hover:underline decoration-cyan-500/40 hover:text-cyan-700 dark:hover:text-cyan-300 transition cursor-pointer"
                        >
                            {part}
                        </Link>
                    )
                }

                return <React.Fragment key={index}>{part}</React.Fragment>
            })}
        </span>
    )
}
