"use client";

/**
 * Echo Lexicon Mini (owner brief 2026-10-24): small pieces shared by every contextual dictionary card. Presentation
 * only — each card keeps its own lookup, audio and save handlers.
 */
import React from "react";
import { BookmarkPlus, Check, Loader2, Volume2, X } from "lucide-react";
import styles from "./mini.module.css";

export { styles as miniStyles };

export function MiniHeader({ word, pos, kind, cefr, ipa, onSpeak, onClose, speakLabel = "Phát âm từ" }: {
    word: string;
    pos?: string;
    kind?: string;
    cefr?: string;
    ipa?: string;
    onSpeak?: () => void;
    onClose?: () => void;
    speakLabel?: string;
}) {
    return (
        <div className={styles.head}>
            <div className={styles.word}>
                <p className={styles.headword} lang="en">{word}</p>
                {pos && pos.toLowerCase() !== "general" && <span className={styles.pos}>{pos}</span>}
                {kind && <span className={`${styles.pos} ${styles.kind}`}>{kind}</span>}
                {cefr && <span className={`${styles.pos} ${styles.cefr}`}>{cefr}</span>}
                {ipa && <span className={styles.ipa}>{ipa}</span>}
            </div>
            <div className={styles.tools}>
                {onSpeak && (
                    <button type="button" onClick={onSpeak} className={styles.speak} title={speakLabel} aria-label={speakLabel}>
                        <Volume2 />
                    </button>
                )}
                {onClose && (
                    <button type="button" onClick={onClose} className={styles.close} aria-label="Đóng">
                        <X />
                    </button>
                )}
            </div>
        </div>
    );
}

export function MiniLoading({ text }: { text: string }) {
    return (
        <div className={styles.loading} role="status">
            <i style={{ width: "45%" }} />
            <i />
            <i style={{ width: "72%" }} />
            <p className={styles.loadingText}><Loader2 className={styles.spin} aria-hidden="true" />{text}</p>
        </div>
    );
}

/** The one save control of a card: its words are the caller's (they describe what the server did). */
export function MiniSave({ state, idle, saving = "Đang lưu...", saved = "Đã lưu", error, onClick, full = false }: {
    state: "idle" | "saving" | "saved" | "error";
    idle: string;
    saving?: string;
    saved?: string;
    error?: string;
    onClick: () => void;
    full?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={state === "saving" || state === "saved"}
            className={`${styles.save} ${full ? styles.full : ""}`}
            data-state={state}
        >
            {state === "saving" ? <Loader2 className={styles.spin} /> : state === "saved" ? <Check /> : <BookmarkPlus />}
            <span>{state === "saving" ? saving : state === "saved" ? saved : state === "error" && error ? error : idle}</span>
        </button>
    );
}
