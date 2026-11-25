"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import { AudioLines, Baby, BookOpen, Brain, Briefcase, Clapperboard, Compass, Cpu, Globe, GraduationCap, Layers, Lightbulb, MessageCircle, MessagesSquare, Radio, Sprout } from "lucide-react";
import styles from "./listeningGlass.module.css";

export { styles as glass };

export type ListeningWorld = "library" | "personal" | "stats";

/*
 * The two Listening heroes are rendered stills of scenes built in code (Blender, CPU; `docs/listening/echo-glass-2026-10-23/art/`):
 * headphones over a night sea crossed by ribbons of light, and a private night studio. 4.8 : 1 panoramas whose extra width
 * continues the scene to the LEFT, every ribbon entering beyond the left edge and rising out of the dark: the picture covers
 * the whole hero (anchored right), so no image edge and no strand end can land inside it at any width. Content-hashed names
 * (a changed picture ships under a new name: the edge caches images for a year). Decorative: alt="" and aria-hidden. The
 * stats hero is CSS + SVG.
 */
const ART: Partial<Record<ListeningWorld, { small: string; large: string }>> = {
    library: { small: "/assets/listening/listening-library-1920-18374005.webp", large: "/assets/listening/listening-library-3840-9064bd38.webp" },
    personal: { small: "/assets/listening/listening-personal-1920-7767265f.webp", large: "/assets/listening/listening-personal-3840-9b84845d.webp" },
};
export const LISTENING_ART = ART;

export interface HeroStat { value: ReactNode; label: string; icon: ReactNode }

export function ListeningHero({ world, eyebrow, eyebrowIcon, title, lead, stats, actions, titleId }: {
    world: ListeningWorld;
    eyebrow: string;
    eyebrowIcon: ReactNode;
    title: string;
    lead: string;
    stats: HeroStat[];
    actions?: ReactNode;
    titleId: string;
}) {
    const art = ART[world];
    return (
        <section className={styles.hero} data-world={world} aria-labelledby={titleId}>
            {art ? (
                <div className={styles.heroArt} aria-hidden="true">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={art.small} srcSet={`${art.small} 1920w, ${art.large} 3840w`} sizes="(min-width: 768px) 100vw, 230vw" alt="" decoding="async" draggable={false} />
                    {/* light travelling along the ribbons: the same picture, its darks crushed, seen through a soft moving band
                        (the band and its picture move in opposite directions, so the picture stays in register) */}
                    <span className={styles.heroSheen}>
                        <span>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={art.small} srcSet={`${art.small} 1920w, ${art.large} 3840w`} sizes="(min-width: 768px) 100vw, 230vw" alt="" decoding="async" draggable={false} />
                        </span>
                    </span>
                </div>
            ) : (
                <div className={styles.heroGraph} aria-hidden="true"><Observatory /></div>
            )}
            <div className={styles.heroShade} aria-hidden="true" />
            <div className={styles.heroBody}>
                <span className={styles.eyebrow}>{eyebrowIcon}{eyebrow}</span>
                <h1 id={titleId} className={styles.heroTitle}>{title}</h1>
                <p className={styles.heroLead}>{lead}</p>
                {stats.length > 0 && (
                    <dl className={styles.stats}>
                        {stats.map((s) => (
                            <div key={s.label} className={styles.stat}>
                                <span className={styles.statIcon} aria-hidden="true">{s.icon}</span>
                                <div className="flex flex-col-reverse">
                                    <dt>{s.label}</dt>
                                    <dd>{s.value}</dd>
                                </div>
                            </div>
                        ))}
                    </dl>
                )}
                {actions && <div className={styles.heroActions}>{actions}</div>}
            </div>
        </section>
    );
}

/** Stats hero art: concentric listening rings and an orbit of nodes (pure decoration — it plots no data). */
function Observatory() {
    return (
        <svg viewBox="0 0 400 300" fill="none" aria-hidden="true">
            <defs>
                <linearGradient id="ls-obs-a" x1="0" y1="0" x2="400" y2="300" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#67e8f9" /><stop offset="0.55" stopColor="#a78bfa" /><stop offset="1" stopColor="#fcd34d" />
                </linearGradient>
            </defs>
            {[40, 72, 104, 136].map((r, i) => (
                <circle key={r} cx="230" cy="150" r={r} stroke="url(#ls-obs-a)" strokeOpacity={0.55 - i * 0.1} strokeWidth={i === 0 ? 2 : 1.2} strokeDasharray={i % 2 ? "2 7" : undefined} />
            ))}
            <path d="M60 150 C 110 90, 150 210, 200 150 S 290 90, 340 150" stroke="url(#ls-obs-a)" strokeWidth="2.2" strokeLinecap="round" opacity="0.9" />
            <path d="M60 160 C 110 120, 150 200, 200 160 S 290 120, 340 160" stroke="#c4b5fd" strokeWidth="1.2" strokeLinecap="round" opacity="0.45" />
            {[[230, 46], [334, 150], [230, 254], [126, 150], [302, 78], [158, 222]].map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r={i < 4 ? 4 : 2.6} fill={i % 2 ? "#fcd34d" : "#67e8f9"} opacity="0.95" />
            ))}
            <circle cx="230" cy="150" r="16" fill="url(#ls-obs-a)" opacity="0.9" />
        </svg>
    );
}

/* ── categories: identity of the real SYSTEM topics (unknown topics get the neutral identity) ───────────────────────── */
export type CategoryTone = "talks" | "everyday" | "science" | "work" | "culture" | "news" | "story" | "animated" | "beginner" | "kids" | "vocab" | "exam" | "movies" | "other";
export interface CategoryIdentity {
    tone: CategoryTone;
    icon: ComponentType<{ size?: number; className?: string }>;
    /** Learner-facing names (owner rule: never "&" in display copy). The record key is the stored topic. */
    label: string;
    labelEn: string;
    description: string;
    sources: string;
}

/** Display order of the topic gallery: entry-level and animated worlds first, then the established topics. */
export const CATEGORY_IDENTITY: Record<string, CategoryIdentity> = {
    "Animated Stories": { tone: "story", icon: BookOpen, label: "Truyện hoạt hình và cổ tích", labelEn: "Animated stories and fairy tales", description: "Truyện ngụ ngôn, cổ tích và thần thoại có hình minh họa chuyển động, kể chậm và rõ.", sources: "The Fable Cottage, TED-Ed" },
    "Animated Conversations": { tone: "animated", icon: MessagesSquare, label: "Hội thoại hoạt hình", labelEn: "Animated conversations", description: "Loạt phim hoạt hình về một văn phòng: phỏng vấn, giới thiệu bản thân, gọi điện, góp ý và viết email.", sources: "BBC Learning English · English at Work" },
    "Beginner English": { tone: "beginner", icon: Sprout, label: "Tiếng Anh chậm cho người mới", labelEn: "Slow English for beginners", description: "Giọng nói chậm, câu ngắn và từ vựng quen thuộc: giới thiệu bản thân, quê hương, thói quen và thời gian.", sources: "BBC Learning English, VOA Learning English" },
    "Kids and Family": { tone: "kids", icon: Baby, label: "Trẻ em và Gia đình", labelEn: "Kids and family", description: "Sách tranh thiếu nhi được các diễn viên đọc to, từng trang minh họa hiện lên theo lời kể.", sources: "Storyline Online" },
    "Everyday English": { tone: "everyday", icon: MessageCircle, label: "Tiếng Anh giao tiếp hằng ngày", labelEn: "Everyday English", description: "Hội thoại đời sống thường nhật, giao tiếp thực tế và bài giảng giáo viên bản ngữ.", sources: "BBC Learning English, English teachers" },
    "Vocabulary and Pronunciation": { tone: "vocab", icon: AudioLines, label: "Từ vựng và Phát âm", labelEn: "Vocabulary and pronunciation", description: "Luyện nhại giọng, âm cuối, nhịp điệu câu và những cụm từ người bản ngữ dùng mỗi ngày.", sources: "BBC Learning English · Pronunciation, The English We Speak" },
    "IELTS Preparation": { tone: "exam", icon: GraduationCap, label: "Luyện thi IELTS", labelEn: "IELTS preparation", description: "Cấu trúc bài thi, câu hỏi Speaking mẫu và chiến lược làm bài từ kênh chính thức của IELTS.", sources: "TakeIELTS Official" },
    "Movies and TV": { tone: "movies", icon: Clapperboard, label: "Tiếng Anh qua phim và truyền hình", labelEn: "English through movies and TV", description: "Nói về phim và rạp chiếu, luyện giọng và cách nói tự nhiên qua loạt phim truyền hình Friends.", sources: "BBC Learning English, Rachel's English" },
    "Ideas & Talks": { tone: "talks", icon: Lightbulb, label: "Ý tưởng và Diễn thuyết", labelEn: "Ideas and talks", description: "Các bài diễn thuyết truyền cảm hứng, ý tưởng đột phá và bài giảng tư duy.", sources: "TED, TED-Ed" },
    "Science & Tech": { tone: "science", icon: Cpu, label: "Khoa học và Công nghệ", labelEn: "Science and technology", description: "Khám phá vũ trụ, khoa học tự nhiên, trí tuệ nhân tạo và tương lai công nghệ.", sources: "TED-Ed, Kurzgesagt, Veritasium, SciShow, Vox" },
    "Work & Study": { tone: "work", icon: Briefcase, label: "Công việc và Học tập", labelEn: "Work and study", description: "Kỹ năng công việc, phỏng vấn, thuyết trình chuyên nghiệp và phát triển sự nghiệp.", sources: "Business, interviews, productivity" },
    "Culture & Travel": { tone: "culture", icon: Globe, label: "Văn hóa và Du lịch", labelEn: "Culture and travel", description: "Văn hóa các nước, trải nghiệm du lịch, sân bay, khách sạn và những câu chuyện lịch sử.", sources: "Rick Steves, TED-Ed, BBC Learning English" },
    "News & Podcasts": { tone: "news", icon: Radio, label: "Tin tức và Podcast", labelEn: "News and podcasts", description: "Bản tin quốc tế, phân tích thời sự và các podcast học tiếng Anh thực tế.", sources: "BBC Learning English, Vox" },
    Psychology: { tone: "talks", icon: Brain, label: "Tâm lý học", labelEn: "Psychology", description: "Cảm xúc, sự tổn thương và những điều làm nên con người.", sources: "TED" },
    Education: { tone: "exam", icon: GraduationCap, label: "Giáo dục và Luyện thi", labelEn: "Education and exam practice", description: "Bài nghe theo định dạng thi và chủ đề học đường.", sources: "" },
    Activities: { tone: "culture", icon: Compass, label: "Đời sống và Hoạt động", labelEn: "Life and activities", description: "Con người đã sống, làm việc và vui chơi như thế nào qua các thời kỳ.", sources: "" },
    General: { tone: "other", icon: Layers, label: "Chủ đề tổng hợp", labelEn: "General topics", description: "Chủ đề luyện nghe tiếng Anh chọn lọc.", sources: "" },
};
export const OTHER_CATEGORY: CategoryIdentity = { tone: "other", icon: Layers, label: "", labelEn: "", description: "Chủ đề luyện nghe tiếng Anh chọn lọc.", sources: "" };
export const categoryIdentity = (topic?: string | null) => (topic && CATEGORY_IDENTITY[topic]) || OTHER_CATEGORY;
/** The learner-facing name of a stored topic; an unknown topic shows its own words with any "&" spelled out. */
export function categoryLabel(topic: string | null | undefined, vi: boolean): string {
    if (!topic) return "";
    const known = CATEGORY_IDENTITY[topic];
    if (known) return vi ? known.label : known.labelEn;
    return topic.replace(/\s*&\s*/g, vi ? " và " : " and ");
}
const CATEGORY_RANK = Object.keys(CATEGORY_IDENTITY);
/** Topic gallery order (stable; topics without an identity keep their server order after the known ones). */
export function sortCategories<T extends { topic: string }>(list: T[]): T[] {
    const rank = (t: string) => { const i = CATEGORY_RANK.indexOf(t); return i === -1 ? CATEGORY_RANK.length : i; };
    return list.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.topic) - rank(b.c.topic) || a.i - b.i).map(x => x.c);
}

const COVER_TONES: Record<string, [string, string]> = {
    document: ["#a855f7", "#db2777"], youtube: ["#06b6d4", "#6366f1"], talks: ["#8b5cf6", "#db2777"], everyday: ["#f59e0b", "#ea580c"],
    science: ["#06b6d4", "#2563eb"], work: ["#3b82f6", "#6366f1"], culture: ["#10b981", "#0d9488"], news: ["#f43f5e", "#c026d3"], other: ["#6366f1", "#0891b2"],
    story: ["#f97316", "#e11d48"], animated: ["#ec4899", "#8b5cf6"], beginner: ["#84cc16", "#059669"], kids: ["#facc15", "#f97316"],
    vocab: ["#14b8a6", "#6366f1"], exam: ["#6366f1", "#0ea5e9"], movies: ["#ef4444", "#f59e0b"],
};

/** YouTube thumbnail of a stored video id / URL (the item's own picture), else null. */
export function youtubeThumb(id?: string | null, url?: string | null): string | null {
    if (id && /^[\w-]{11}$/.test(id)) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    const m = url?.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|shorts\/|live\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
    return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
}

/**
 * The item's own picture, or — when it has none (documents, audio-only) or it fails to load — a typographic cover built
 * from the item's own words (label + title) over a decorative wave. Never another item's picture or stock art.
 * The frame has fixed geometry (16:9) so a failed image never shifts the layout.
 */
export function MediaPicture({ src, alt, label, title, tone, priority = false }: { src: string | null; alt: string; label: string; title: string; tone: string; priority?: boolean }) {
    const [failed, setFailed] = useState(false);
    // YouTube answers a missing video with a 120×90 grey placeholder (status 200): treat it as no picture.
    const usable = src && !failed;
    if (usable) {
        return (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={alt} loading={priority ? "eager" : "lazy"} decoding="async" draggable={false}
                onError={() => setFailed(true)}
                onLoad={(e) => { if (e.currentTarget.naturalWidth > 0 && e.currentTarget.naturalWidth <= 120) setFailed(true); }} />
        );
    }
    const [c1, c2] = COVER_TONES[tone] ?? COVER_TONES.other;
    return (
        <div className={styles.cover} style={{ ["--c1" as string]: c1, ["--c2" as string]: c2 }} role="img" aria-label={alt}>
            <svg className={styles.coverWave} viewBox="0 0 320 80" preserveAspectRatio="none" aria-hidden="true">
                {Array.from({ length: 40 }, (_, i) => {
                    const h = 6 + Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.21)) * 58;
                    return <rect key={i} x={i * 8 + 2} y={40 - h / 2} width="3.2" height={h} rx="1.6" fill="white" opacity={0.18 + (i % 5) * 0.06} />;
                })}
            </svg>
            <span className={styles.coverLabel}>{label}</span>
            <span className={styles.coverTitle}>{title}</span>
        </div>
    );
}

export function LoadingState({ text }: { text: string }) {
    return (
        <div className={styles.loading} role="status" aria-live="polite">
            <span className={styles.loadingBars} aria-hidden="true"><i /><i /><i /><i /><i /></span>
            <span>{text}</span>
        </div>
    );
}

export function SkeletonGrid({ count = 6 }: { count?: number }) {
    return (
        <div className={styles.mediaGrid} aria-hidden="true">
            {Array.from({ length: count }, (_, i) => (
                <div key={i} className={`${styles.panel} ${styles.skeletonCard}`}>
                    <div className={styles.shimmer} />
                    <div className="flex flex-col gap-2 p-4">
                        <div className={`${styles.shimmer} h-3 w-1/3 rounded-full`} />
                        <div className={`${styles.shimmer} h-4 w-5/6 rounded-full`} />
                        <div className={`${styles.shimmer} h-4 w-2/3 rounded-full`} />
                    </div>
                </div>
            ))}
        </div>
    );
}

export function StatePanel({ icon, title, text, actions, kind = "empty" }: { icon: ReactNode; title: string; text?: ReactNode; actions?: ReactNode; kind?: "empty" | "error" }) {
    return (
        <div className={`${styles.panel} ${styles.state}`} data-kind={kind} role={kind === "error" ? "alert" : undefined}>
            <span className={styles.stateIcon} aria-hidden="true">{icon}</span>
            <h3 className={styles.stateTitle}>{title}</h3>
            {text && <p className={styles.stateText}>{text}</p>}
            {actions && <div className={styles.stateActions}>{actions}</div>}
        </div>
    );
}

export const formatClock = (seconds?: number | null) => {
    if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return null;
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
};

/** Learner wording of the server's dictation error categories (`ErrorCategory`). */
export const ERROR_LABEL: Record<string, { vi: string; en: string }> = {
    EXACT_MATCH: { vi: 'Khớp chính xác', en: 'Exact match' },
    MINOR_SPELLING: { vi: 'Chính tả nhẹ', en: 'Minor spelling' },
    MISSING_WORD: { vi: 'Bỏ sót từ', en: 'Missing word' },
    EXTRA_WORD: { vi: 'Thừa từ', en: 'Extra word' },
    WRONG_WORD: { vi: 'Sai từ vựng', en: 'Wrong word' },
    PHONETIC_CONFUSION: { vi: 'Nhầm lẫn âm thanh', en: 'Phonetic confusion' },
    PUNCTUATION_ERROR: { vi: 'Lỗi dấu câu', en: 'Punctuation error' },
};
export const errorLabel = (category: string, vi: boolean) => ERROR_LABEL[category]?.[vi ? 'vi' : 'en'] ?? category.replace(/_/g, ' ');

export const VOICE_LABEL:Record<string, string> = { us_male: "Giọng nam Mỹ", us_female: "Giọng nữ Mỹ", uk_male: "Giọng nam Anh", uk_female: "Giọng nữ Anh" };
