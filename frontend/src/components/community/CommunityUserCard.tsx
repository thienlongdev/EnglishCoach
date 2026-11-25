'use client'

import React from 'react'
import { useSession } from 'next-auth/react'
import { Flame, Crown, Compass, Users, Bookmark, FileText, ArrowRight } from 'lucide-react'
import { UserAvatar } from '@/components/common/UserAvatar'
import { useCurrentUserProfile } from '@/hooks/useCurrentUserProfile'
import { usePremiumEntitlement } from '@/hooks/usePremiumEntitlement'
import { useUnifiedStreak } from '@/hooks/useUnifiedStreak'
import Link from 'next/link'
import styles from './communityGlass.module.css'

interface CommunityUserCardProps {
    activeTab: 'public' | 'following' | 'my-posts' | 'saved'
    onSelectTab: (tab: 'public' | 'following' | 'my-posts' | 'saved') => void
}

const NAV_ITEMS = [
    { id: 'public' as const, label: 'Dành cho bạn', icon: Compass, tone: 'public' },
    { id: 'following' as const, label: 'Đang theo dõi', icon: Users, tone: 'following' },
    { id: 'my-posts' as const, label: 'Bài viết của tôi', icon: FileText, tone: 'mine' },
    { id: 'saved' as const, label: 'Đã lưu', icon: Bookmark, tone: 'saved' },
]

export function CommunityUserCard({ activeTab, onSelectTab }: CommunityUserCardProps) {
    const { data: session } = useSession()
    const { profile } = useCurrentUserProfile()
    const { isPremium } = usePremiumEntitlement()
    // The streak is the top bar's own cached value (same SWR key): no extra request, never a placeholder number.
    const { streak } = useUnifiedStreak()

    const user = session?.user
    const displayName = profile?.displayName || user?.name || 'Học viên'
    const streakDays = streak?.currentStreakDays

    return (
        <div className={`${styles.panel} ${styles.navCard}`}>
            {/* Identity: the learner's own avatar and equipped frame */}
            <div className={styles.identity}>
                <UserAvatar
                    className="w-12 h-12 rounded-2xl shrink-0"
                    fallbackName={displayName}
                    showFrame={true}
                    context="card"
                />
                <div className={styles.identityText}>
                    <div className={styles.identityName}>
                        <span title={displayName}>{displayName}</span>
                        {isPremium && (
                            <span className={styles.pro}>
                                <Crown aria-hidden="true" />
                                PRO
                            </span>
                        )}
                    </div>
                    {streakDays !== undefined && (
                        <div className={styles.identityMeta}>
                            <Flame aria-hidden="true" />
                            <span>Chuỗi học <b>{streakDays} ngày</b></span>
                        </div>
                    )}
                </div>
            </div>

            <div className={styles.divider} />

            {/* Feed views */}
            <nav className={styles.navList} aria-label="Bảng tin cộng đồng">
                {NAV_ITEMS.map((item) => {
                    const Icon = item.icon
                    const isActive = activeTab === item.id
                    return (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => onSelectTab(item.id)}
                            className={styles.navItem}
                            data-tone={item.tone}
                            aria-current={isActive ? 'page' : undefined}
                        >
                            <span className={styles.navIcon} aria-hidden="true"><Icon /></span>
                            <span className={styles.navLabel}>{item.label}</span>
                            {isActive && <span className={styles.navDot} aria-hidden="true" />}
                        </button>
                    )
                })}
            </nav>

            <Link href="/profile" className={styles.profileLink} title="Hồ sơ cá nhân của bạn" aria-label="Hồ sơ cá nhân">
                <span>Hồ sơ cá nhân</span>
                <ArrowRight aria-hidden="true" />
            </Link>

            <p className={styles.navNote}>Cùng chia sẻ hành trình học và tiến bộ mỗi ngày.</p>
        </div>
    )
}
