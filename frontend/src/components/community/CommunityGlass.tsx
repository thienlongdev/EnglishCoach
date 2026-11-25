'use client'

import React from 'react'
import { AlertTriangle, CircleHelp, Loader2, MessageSquare, PenLine, RotateCcw, Trophy, Users } from 'lucide-react'
import type { PostType } from '@/types/community'
import styles from './communityGlass.module.css'

export { styles as cg }

/*
 * The Community hero is a rendered still of a scene built in code (Blender, CPU; `docs/community/echo-glass-2026-10-23/art/`):
 * Echo — the real English Coach whale model — leads a small pod over a glowing reef through shafts of light. A 4.8 : 1
 * panorama that covers the whole hero anchored right (calm water behind the text). Content-hashed names (a changed picture
 * ships under a new name: the edge caches images for a year). Decorative: alt="" and aria-hidden.
 */
export const COMMUNITY_ART = {
    small: '/assets/community/community-hero-1920-4addd029.webp',
    large: '/assets/community/community-hero-3840-7da86a5b.webp',
}

// Rising bubbles: deterministic (same on server and client), decorative only.
const BUBBLES = [
    { x: '58%', s: '9px', d: '11s', delay: '0s', sway: '-14px' }, { x: '66%', s: '6px', d: '9s', delay: '-3s', sway: '10px' },
    { x: '74%', s: '12px', d: '13s', delay: '-6s', sway: '-8px' }, { x: '81%', s: '7px', d: '10s', delay: '-1.5s', sway: '12px' },
    { x: '88%', s: '10px', d: '12s', delay: '-8s', sway: '-10px' }, { x: '93%', s: '5px', d: '8s', delay: '-4.5s', sway: '6px' },
    { x: '48%', s: '6px', d: '12s', delay: '-9.5s', sway: '8px' },
]

/** The three hero shortcuts open the composer with a real post type (the same types the composer offers). */
export const HERO_PURPOSES: { type: PostType; tone: string; title: string; hint: string; icon: React.ReactNode }[] = [
    { type: 'QUESTION', tone: 'question', title: 'Đặt câu hỏi', hint: 'Nhờ cộng đồng giải đáp', icon: <CircleHelp aria-hidden="true" /> },
    { type: 'CORRECTION_REQUEST', tone: 'correction', title: 'Nhờ sửa câu', hint: 'Viết câu, nhận góp ý', icon: <PenLine aria-hidden="true" /> },
    { type: 'ACHIEVEMENT', tone: 'achievement', title: 'Chia sẻ thành tích', hint: 'Truyền động lực cho nhau', icon: <Trophy aria-hidden="true" /> },
]

export function CommunityHero({ onCompose }: { onCompose: (type: PostType) => void }) {
    return (
        <section className={styles.hero} aria-labelledby="community-hero-title">
            <div className={styles.heroArt} aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src={COMMUNITY_ART.small}
                    srcSet={`${COMMUNITY_ART.small} 1920w, ${COMMUNITY_ART.large} 3840w`}
                    sizes="(min-width: 768px) 100vw, 260vw"
                    alt=""
                    decoding="async"
                    draggable={false}
                />
            </div>
            <div className={styles.heroShade} aria-hidden="true" />
            <div className={styles.heroBubbles} aria-hidden="true">
                {BUBBLES.map((b, i) => (
                    <i key={i} style={{ ['--x' as string]: b.x, ['--s' as string]: b.s, ['--d' as string]: b.d, ['--delay' as string]: b.delay, ['--sway' as string]: b.sway }} />
                ))}
            </div>
            <div className={styles.heroBody}>
                <span className={styles.eyebrow}><Users aria-hidden="true" />Cộng đồng English Coach</span>
                <h1 id="community-hero-title" className={styles.heroTitle}>
                    <span>Kết nối<i aria-hidden="true">·</i></span> <span>Học hỏi<i aria-hidden="true">·</i></span> <span>Cùng tiến bộ</span>
                </h1>
                <p className={styles.heroLead}>
                    Nơi người học tiếng Anh chia sẻ kiến thức, hỏi đáp, nhờ sửa câu và truyền động lực cho nhau mỗi ngày.
                </p>
                <div className={styles.purposes}>
                    {HERO_PURPOSES.map((p) => (
                        <button key={p.type} type="button" className={styles.purpose} data-tone={p.tone} onClick={() => onCompose(p.type)}>
                            <span className={styles.purposeIcon}>{p.icon}</span>
                            <span className="min-w-0">
                                <strong>{p.title}</strong>
                                <small>{p.hint}</small>
                            </span>
                        </button>
                    ))}
                </div>
            </div>
        </section>
    )
}

/** Feed placeholder while the first page loads: the shape of a post card, no numbers. */
export function FeedSkeleton({ count = 3 }: { count?: number }) {
    return (
        <div className="flex flex-col gap-4" role="status" aria-live="polite">
            <span className="sr-only">Đang tải bảng tin cộng đồng…</span>
            {Array.from({ length: count }, (_, i) => (
                <div key={i} className={`${styles.panel} ${styles.skeleton}`} aria-hidden="true">
                    <div className={styles.skelRow}>
                        <div className={styles.bone} style={{ width: 40, height: 40, borderRadius: 999 }} />
                        <div className="flex-1 space-y-2">
                            <div className={styles.bone} style={{ width: '38%', height: 11 }} />
                            <div className={styles.bone} style={{ width: '22%', height: 9 }} />
                        </div>
                    </div>
                    <div className="mt-4 space-y-2">
                        <div className={styles.bone} style={{ width: '96%', height: 10 }} />
                        <div className={styles.bone} style={{ width: '88%', height: 10 }} />
                        <div className={styles.bone} style={{ width: i % 2 ? '52%' : '70%', height: 10 }} />
                    </div>
                    <div className="mt-5 grid grid-cols-4 gap-2">
                        {[0, 1, 2, 3].map((k) => <div key={k} className={styles.bone} style={{ height: 26 }} />)}
                    </div>
                </div>
            ))}
        </div>
    )
}

export function FeedState({ tone, title, text, action }: { tone: 'empty' | 'error'; title: string; text: string; action?: { label: string; onClick: () => void; busy?: boolean } }) {
    return (
        <div className={`${styles.panel} ${styles.state}`} data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
            <span className={styles.stateIcon} aria-hidden="true">{tone === 'error' ? <AlertTriangle /> : <MessageSquare />}</span>
            <h3 className={styles.stateTitle}>{title}</h3>
            <p className={styles.stateText}>{text}</p>
            {action && (
                <button type="button" className={styles.moreBtn} onClick={action.onClick} disabled={action.busy}>
                    {action.busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
                    <span>{action.label}</span>
                </button>
            )}
        </div>
    )
}
