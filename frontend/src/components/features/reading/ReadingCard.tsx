"use client";

import React from "react";
import { ArrowRight, BookOpen, Clock3, FileText, Mic, Trash2 } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import styles from "./glass/readingGlass.module.css";
import { ReadingCover, topicFamily } from "./glass/ReadingCover";

export interface ReadingMaterial {
    sourceName?: string | null;
    topic?: string;
    description?: string;
    licenseCode?: string;
    attribution?: string;
    readMinutes?: number;
    id: number;
    title: string;
    sourceUrl?: string | null;
    materialType: string;
    contentText?: string;
    wordCount: number;
    difficultyLevel: string;
    ownerUserId?: number | null;
    isSystem?: boolean;
    documentSchemaVersion?: string | null;
    sourceDocumentType?: string | null;
    sourceFileName?: string | null;
    hasDocumentRepresentation?: boolean;
    canonicalDocument?: CanonicalDocument | null;
}

export interface CanonicalDocument {
    schemaVersion: string;
    sourceType: string;
    source?: { fileName?: string | null };
    plainText: string;
    pages: Array<{
        pageNumber: number;
        width: number;
        height: number;
        sourceImage?: string;
        blocks: Array<{
            id: string;
            type: string;
            text: string;
            bbox: { x: number; y: number; width: number; height: number; xNorm: number; yNorm: number; widthNorm: number; heightNorm: number };
            confidence?: number | null;
            readingOrder: number;
            column?: number;
            children?: Array<{ text: string; bbox: Record<string, number> }>;
            rows?: Array<{ index: number; cells: Array<{ column: number; text: string; bbox: Record<string, number> }> }>;
        }>;
    }>;
    processing?: Record<string, unknown>;
}

interface ReadingCardProps {
    material: ReadingMaterial;
    onClick?: () => void;
    onSpeakingClick?: (material: ReadingMaterial) => void;
    onDelete?: (id: number) => void;
    canDelete?: boolean;
}

/** Standard CEFR label of a stored level, or null when the material has none (never an invented default). */
export function formatCefrLevel(level?: string | null): string | null {
    if (!level || !level.trim()) return null;
    const upper = level.trim().toUpperCase();
    if (upper === "BEGINNER") return "A1";
    if (upper === "ELEMENTARY") return "A2";
    if (upper === "INTERMEDIATE") return "B1";
    if (upper === "UPPER_INTERMEDIATE") return "B2";
    if (upper === "ADVANCED") return "C1";
    return upper;
}

/** CEFR badge: one hue per band, readable in both themes. */
export function cefrBadgeClass(cefr: string): string {
    if (cefr.startsWith("C")) return "bg-amber-50 text-amber-800 ring-amber-200/90 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-300/25";
    if (cefr === "B2") return "bg-indigo-50 text-indigo-700 ring-indigo-200/90 dark:bg-indigo-400/10 dark:text-indigo-200 dark:ring-indigo-300/25";
    if (cefr === "B1") return "bg-sky-50 text-sky-700 ring-sky-200/90 dark:bg-sky-400/10 dark:text-sky-200 dark:ring-sky-300/25";
    return "bg-emerald-50 text-emerald-700 ring-emerald-200/90 dark:bg-emerald-400/10 dark:text-emerald-200 dark:ring-emerald-300/25";
}

interface TopicAccent { chip: string; dot: string; bar: string }

/**
 * A quiet visual identity per topic family (presentation only; the topic text itself comes from the catalog).
 * Unknown topics and personal documents use the neutral slate accent.
 */
export function topicAccent(topic?: string | null): TopicAccent {
    const t = (topic || "").toLowerCase();
    const pick = (chip: string, dot: string, bar: string): TopicAccent => ({ chip, dot, bar });
    if (/psycholog|mind/.test(t)) return pick("bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-200", "bg-violet-500", "from-violet-500 to-fuchsia-400");
    if (/health|medic/.test(t)) return pick("bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-200", "bg-rose-500", "from-rose-500 to-orange-300");
    if (/earth|environment|nature/.test(t)) return pick("bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200", "bg-emerald-500", "from-emerald-500 to-teal-400");
    if (/space|science|technolog/.test(t)) return pick("bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-200", "bg-sky-500", "from-sky-500 to-cyan-400");
    if (/history|culture|society/.test(t)) return pick("bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200", "bg-amber-500", "from-amber-500 to-orange-400");
    if (/business|work/.test(t)) return pick("bg-indigo-50 text-indigo-700 dark:bg-indigo-400/10 dark:text-indigo-200", "bg-indigo-500", "from-indigo-500 to-blue-400");
    if (/education|language/.test(t)) return pick("bg-blue-50 text-blue-700 dark:bg-blue-400/10 dark:text-blue-200", "bg-blue-500", "from-blue-600 to-sky-400");
    if (/travel|outdoor/.test(t)) return pick("bg-cyan-50 text-cyan-800 dark:bg-cyan-400/10 dark:text-cyan-200", "bg-cyan-500", "from-cyan-500 to-teal-300");
    if (/everyday|life/.test(t)) return pick("bg-orange-50 text-orange-800 dark:bg-orange-400/10 dark:text-orange-200", "bg-orange-500", "from-orange-500 to-amber-300");
    return pick("bg-slate-100 text-slate-700 dark:bg-white/[0.06] dark:text-slate-200", "bg-slate-400", "from-slate-400 to-slate-300");
}

/** Readable label of a personal document's stored type (no type ⇒ no label). */
function documentTypeLabel(type: string | undefined, vi: boolean): string | null {
    const upper = (type || "").toUpperCase();
    if (!upper) return null;
    if (upper.includes("PDF")) return "PDF";
    if (upper.includes("IMAGE") || upper.includes("PNG") || upper.includes("JPG") || upper.includes("JPEG")) return vi ? "Ảnh" : "Image";
    if (upper.includes("ARTICLE") || upper.includes("FEED")) return vi ? "Bài báo" : "Article";
    if (upper.includes("TEXT") || upper.includes("CUSTOM")) return vi ? "Văn bản" : "Text";
    return upper;
}

const INTERACTIVE_ACTION_SELECTOR = 'button, a, input, select, textarea, summary, [role="button"], [role="link"]';

/*
 * Reading library card (Echo Glass 2026-10-23; editorial rules of 2026-10-15 kept). Every value is catalog data — topic,
 * source, CEFR (stored level only; SYSTEM levels are marked as an estimate), server reading time and word count. The cover
 * is typographic art of the topic family (the corpus has no pictures of its own). The title is the card's one primary
 * control (a real button whose hit area covers the card, including the "Đọc ngay" open cue); "Luyện nói" and "Xóa" stay
 * separate buttons above it, so nothing is nested and the keyboard reaches all three.
 */
export default function ReadingCard({ material, onClick, onSpeakingClick, onDelete, canDelete }: ReadingCardProps) {
    const { locale } = useLanguage();
    const vi = locale === "vi";
    const cefr = formatCefrLevel(material.difficultyLevel);
    const isSystem = material.isSystem === true;
    const topic = material.topic && material.topic !== "Other" ? material.topic : null;
    const family = isSystem ? topicFamily(topic) : "personal";
    const typeLabel = isSystem ? null : documentTypeLabel(material.materialType, vi);
    const origin = isSystem ? material.sourceName : (vi ? "Tài liệu của bạn" : "Your document");
    const minutes = Number.isFinite(material.readMinutes) && (material.readMinutes ?? 0) > 0 ? material.readMinutes : null;
    const words = Number.isFinite(material.wordCount) && material.wordCount > 0 ? material.wordCount : null;

    const handleOpen = () => {
        onClick?.();
    };

    const handleCardClick = (e: React.MouseEvent<HTMLElement>) => {
        if (e.defaultPrevented) return;
        const target = e.target as Element | null;
        if (typeof target?.closest === "function" && target.closest(INTERACTIVE_ACTION_SELECTOR)) {
            return;
        }
        handleOpen();
    };

    const handleSpeak = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        onSpeakingClick?.(material);
    };

    const handleDelete = (e: React.MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        if (onDelete) {
            onDelete(material.id);
        }
    };

    return (
        <article data-reading-card={material.id} onClick={handleCardClick} className={styles.card} data-tone="library">
            <div className={styles.cardCover}>
                <ReadingCover family={family} seed={material.id} word={isSystem ? material.sourceName : typeLabel} />
                <div className={styles.coverBadges}>
                    <span className={styles.coverTopic} data-tone="library">
                        <span aria-hidden="true" className={styles.coverDot} />
                        <span>{topic ?? typeLabel ?? (vi ? "Bài đọc" : "Reading")}</span>
                    </span>
                    {cefr && (
                        <span
                            className={styles.coverLevel}
                            title={isSystem ? (vi ? `CEFR ${cefr} (ước tính)` : `CEFR ${cefr} (estimate)`) : `CEFR ${cefr}`}
                        >
                            {cefr}
                            {isSystem && <span className="sr-only">{vi ? " (ước tính)" : " (estimate)"}</span>}
                        </span>
                    )}
                </div>
            </div>

            <div className={styles.cardBody}>
                <h3 className={styles.cardTitle}>
                    <button type="button" onClick={handleOpen} className={styles.cardOpen}>
                        {material.title}
                    </button>
                </h3>
                {origin && (
                    <p className={styles.cardSource}>
                        {isSystem ? <BookOpen aria-hidden="true" /> : <FileText aria-hidden="true" />}
                        <span>{origin}{!isSystem && typeLabel ? ` · ${typeLabel}` : ""}</span>
                    </p>
                )}
                {material.description && <p className={styles.cardDesc}>{material.description}</p>}

                <div className={styles.cardFoot}>
                    <span className={styles.cardFacts}>
                        {minutes != null && (
                            <span>
                                <Clock3 aria-hidden="true" />
                                {vi ? `${minutes} phút đọc` : `${minutes} min read`}
                            </span>
                        )}
                        {words != null && <span className="tabular-nums">{words.toLocaleString(vi ? "vi-VN" : "en-US")} {vi ? "từ" : "words"}</span>}
                    </span>
                    <span className={styles.cardActions}>
                        {canDelete && onDelete && (
                            <button
                                type="button"
                                onClick={handleDelete}
                                title={vi ? "Xóa bài đọc" : "Delete material"}
                                aria-label={vi ? `Xóa bài đọc ${material.title}` : `Delete material ${material.title}`}
                                className={styles.iconBtn}
                            >
                                <Trash2 size={15} aria-hidden="true" />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={handleSpeak}
                            className={styles.speakBtn}
                            title={vi ? `Luyện nói với bài đọc: ${material.title}` : `Practice speaking with: ${material.title}`}
                            aria-label={vi ? `Luyện nói với bài đọc ${material.title}` : `Practice speaking with ${material.title}`}
                        >
                            <Mic className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>{vi ? "Luyện nói" : "Speak"}</span>
                        </button>
                        <span data-reading-open-cue className={styles.openCue} aria-hidden="true">{vi ? "Đọc ngay" : "Read"}<ArrowRight data-reading-open-arrow className="h-3.5 w-3.5" aria-hidden="true" /></span>
                    </span>
                </div>
            </div>
        </article>
    );
}
