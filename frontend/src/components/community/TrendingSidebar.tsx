'use client'

import React, { useState, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { TrendingUp, BadgeCheck, Headphones, Layers, Loader2 } from 'lucide-react'
import { TrendingTopic } from '@/types/community'
import { communityApi } from '@/services/communityApi'
import styles from './communityGlass.module.css'
import { echoSrc } from '@/lib/brand/echoCharacters';

interface TrendingSidebarProps {
    onSelectTag?: (tag: string) => void
    activeTag?: string | null
}

export function TrendingSidebar({ onSelectTag, activeTag }: TrendingSidebarProps) {
    const [topics, setTopics] = useState<TrendingTopic[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        let isCurrent = true
        communityApi
            .getTrendingTopics(6)
            .then((data) => {
                if (isCurrent) setTopics(data)
            })
            .catch((err) => {
                console.error('Failed to load trending topics', err)
            })
            .finally(() => {
                if (isCurrent) setLoading(false)
            })

        return () => {
            isCurrent = false
        }
    }, [])

    return (
        <>
            {/* Official EnglishCoach channel */}
            <section className={`${styles.panel} ${styles.official}`} aria-labelledby="community-official">
                <div className={styles.officialHead}>
                    <span className={styles.officialAvatar} aria-hidden="true">
                        <span>
                            <Image src={echoSrc('social', 30)} alt="" width={30} height={30} unoptimized className="object-contain" />
                        </span>
                    </span>
                    <div className="min-w-0">
                        <h2 id="community-official" className={styles.officialName}>
                            EnglishCoach
                            <BadgeCheck aria-label="Tài khoản chính thức" />
                        </h2>
                        <p className={styles.officialSub}>Kênh học tập chính thức</p>
                    </div>
                </div>

                <p className={styles.officialText}>
                    Theo dõi bài viết từ vựng, ngữ pháp và thử thách học tập hàng ngày từ đội ngũ chuyên môn.
                </p>

                <div className={styles.officialLinks}>
                    <Link href="/listening" className={styles.officialLink}>
                        <Headphones className="text-amber-500 dark:text-amber-400" aria-hidden="true" />
                        <span>Kho bài nghe</span>
                    </Link>
                    <Link href="/flashcards" className={styles.officialLink}>
                        <Layers className="text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
                        <span>Bộ flashcard</span>
                    </Link>
                </div>
            </section>

            {/* Trending tags (server ranking; a click filters the feed by that exact tag) */}
            <section className={`${styles.panel} ${styles.sideCard}`} aria-labelledby="community-trending">
                <h2 id="community-trending" className={styles.sideHead}>
                    <span aria-hidden="true"><TrendingUp /></span>
                    <span>Chủ đề nổi bật</span>
                </h2>

                {loading ? (
                    <div className={styles.sideEmpty} role="status">
                        <Loader2 className="inline w-4 h-4 mr-1.5 animate-spin text-cyan-500" aria-hidden="true" />
                        Đang cập nhật xu hướng...
                    </div>
                ) : topics.length === 0 ? (
                    <p className={styles.sideEmpty}>Chưa có chủ đề nổi bật.</p>
                ) : (
                    <div className={styles.topics}>
                        {topics.map((topic, i) => {
                            const isActive = activeTag?.toLowerCase() === topic.tag.toLowerCase()
                            return (
                                <button
                                    key={topic.tag}
                                    type="button"
                                    onClick={() => onSelectTag?.(topic.tag)}
                                    aria-pressed={isActive}
                                    className={styles.topic}
                                    title={`Lọc bảng tin theo #${topic.tag}`}
                                >
                                    <span className={styles.rank} aria-hidden="true">{i + 1}</span>
                                    <span className={styles.topicTag}>{topic.tag}</span>
                                    <span className={styles.topicMeta}>
                                        {topic.label || (topic.postCount ? `${topic.postCount} bài` : 'Nổi bật')}
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                )}
            </section>
        </>
    )
}
