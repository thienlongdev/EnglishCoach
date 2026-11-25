'use client'

import React from 'react'
import { Shield, BookOpenCheck, MessageCircle, HeartHandshake } from 'lucide-react'
import styles from './communityGlass.module.css'

const RULES = [
    { icon: HeartHandshake, title: 'Tôn trọng và khích lệ', text: 'Mọi thắc mắc về tiếng Anh đều đáng được giải đáp tích cực.' },
    { icon: BookOpenCheck, title: 'Học qua thực hành', text: 'Khuyến khích viết caption, đặt câu ví dụ và sửa lỗi giúp nhau.' },
    { icon: MessageCircle, title: 'Nội dung chất lượng', text: 'Bài viết được ban quản trị duyệt để giữ môi trường học tập trong sạch.' },
]

export function CommunityRulesCard() {
    return (
        <section className={`${styles.panel} ${styles.sideCard}`} aria-labelledby="community-rules" style={{ ['--h1' as string]: '#10b981', ['--h2' as string]: '#0ea5e9' }}>
            <h2 id="community-rules" className={styles.sideHead}>
                <span aria-hidden="true"><Shield /></span>
                <span>Văn hóa cộng đồng</span>
            </h2>
            <ul className={styles.rules}>
                {RULES.map(({ icon: Icon, title, text }) => (
                    <li key={title} className={styles.rule}>
                        <span aria-hidden="true"><Icon /></span>
                        <div>
                            <strong>{title}</strong>
                            <p>{text}</p>
                        </div>
                    </li>
                ))}
            </ul>
        </section>
    )
}
