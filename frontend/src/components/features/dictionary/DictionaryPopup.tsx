"use client";
import React, { useEffect, useState, useRef } from "react";
import { Info } from "lucide-react";
import { apiClient } from "@/services/api-client";
import { lookupCanonical, normalizeQuery, hasValidLexicalContent } from "@/services/dictionaryEngine";
import { CanonicalDictionaryEntry } from "@/services/dictionary/types";
import { flashcardMeaningVi, vietnameseMeaningsFor } from "@/services/dictionaryRanking";
import { entryTypeLabel, sanitizeLexicalText } from "./lexicon/lexiconText";
import { MiniHeader, MiniLoading, MiniSave, miniStyles as s } from "./lexicon/LexiconMini";

export { InteractiveText } from "./InteractiveText";

export interface DictionaryPopupProps {
    word: string;
    onClose: () => void;
}

/** Echo Lexicon Mini: a word card with the entry's senses by part of speech (Speaking, Translation, interactive text). */
export function DictionaryPopup({ word, onClose }: DictionaryPopupProps) {
    const [data, setData] = useState<CanonicalDictionaryEntry | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [saveError, setSaveError] = useState("");
    const [expandedPos, setExpandedPos] = useState<Record<number, boolean>>({});
    const audioRef = useRef<HTMLAudioElement | null>(null);

    useEffect(() => {
        if (!word) return;

        setLoading(true);
        setError(false);
        setSaved(false);
        setSaveError("");
        setExpandedPos({});
        const clean = normalizeQuery(word);
        let alive = true;

        lookupCanonical(clean, "en-en")
            .then((entry) => {
                if (!alive) return;
                if (entry && hasValidLexicalContent(entry)) {
                    setData(entry);
                } else {
                    setError(true);
                }
            })
            .catch(() => { if (alive) setError(true); })
            .finally(() => { if (alive) setLoading(false); });

        return () => {
            alive = false;
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
            if (typeof window !== "undefined" && "speechSynthesis" in window) {
                window.speechSynthesis.cancel();
            }
        };
    }, [word]);

    const playAudio = () => {
        if (!data) return;
        window.dispatchEvent(new Event('ec:music-pause'));

        // Try genuine audio URL first
        const audioUrl = data.pronunciations?.find(p => p.audioUrl)?.audioUrl;
        if (audioUrl) {
            try {
                if (audioRef.current) audioRef.current.pause();
                const audio = new Audio(audioUrl);
                audioRef.current = audio;
                audio.play().catch(() => fallbackTts());
                return;
            } catch {
                fallbackTts();
                return;
            }
        }
        fallbackTts();
    };

    const fallbackTts = () => {
        if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
        try {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(data?.headword || word);
            utterance.lang = "en-US";
            window.speechSynthesis.speak(utterance);
        } catch {
            // Ignore speech synthesis errors
        }
    };

    const addToFlashcards = async () => {
        if (!data || saving || saved) return;
        setSaving(true);
        setSaveError("");
        try {
            const front = data.headword;
            let back = data.generalTranslationVi || "";
            let example = "";

            if (data.partsOfSpeech?.length && data.partsOfSpeech[0].senses?.length) {
                const s = data.partsOfSpeech[0].senses[0];
                // one rule for every save button: the general meaning leads, never an English definition before it
                back = flashcardMeaningVi(data) || s.definitionEn || back;
                if (s.examples?.length) example = s.examples[0];
            }

            await apiClient.post("/flashcards", {
                front,
                back: back || "No definition",
                example
            });
            setSaved(true);
        } catch {
            setSaveError("Chưa lưu được vào Flashcards. Hãy thử lại.");
        } finally {
            setSaving(false);
        }
    };

    const primaryIpa = data?.pronunciations?.find(p => p.ipa)?.ipa;
    const others = data
        ? vietnameseMeaningsFor(data, data.partsOfSpeech?.[0]?.partOfSpeech)
            .filter(m => m.replace(/\.$/, "") !== (data.generalTranslationVi || "").replace(/\.$/, ""))
            .slice(0, 4)
        : [];
    const englishSenses = !!data?.partsOfSpeech?.some(g => g.senses?.some(x => !!x.definitionEn));

    return (
        <div className={`${s.mini} ${s.wide}`} role="dialog" aria-label={`Từ điển: ${data?.headword || word}`}>
            {loading && (
                <>
                    <MiniHeader word={word} onClose={onClose} />
                    <MiniLoading text="Đang tra từ điển..." />
                </>
            )}

            {error && !loading && (
                <>
                    <MiniHeader word={word} onClose={onClose} />
                    <div className={s.state}>
                        <p className={s.stateText}>Không tìm thấy từ <b>"{word}"</b> trong từ điển.</p>
                    </div>
                </>
            )}

            {data && !loading && (
                <>
                    <MiniHeader
                        word={data.headword}
                        kind={data.entryType && data.entryType !== "WORD" ? entryTypeLabel(data.entryType) : undefined}
                        cefr={data.cefr}
                        ipa={primaryIpa}
                        onSpeak={playAudio}
                        onClose={onClose}
                    />
                    <div className={s.body}>
                        {/* Inflection / Lemma Note */}
                        {data.searchedForm && data.searchedForm.toLowerCase() !== data.headword.toLowerCase() && (
                            <p className={s.def}>
                                <Info className={s.exampleMark} aria-hidden="true" />
                                <span>Tra từ <b>"{data.searchedForm}"</b> ({data.inflectionNote || 'Dạng biến thể của ' + data.headword})</span>
                            </p>
                        )}

                        {/* Vietnamese general translation if present */}
                        {data.generalTranslationVi && <p className={s.meaning}>{sanitizeLexicalText(data.generalTranslationVi)}</p>}

                        {/* Other Vietnamese meanings of the word (bundled EN-VI dictionary; not translations of the senses below) */}
                        {others.length > 0 && englishSenses && (
                            <p className={s.note} data-testid="dictionary-popup-vi-senses">
                                Nghĩa khác: {others.map(m => sanitizeLexicalText(m)).join(" · ")}
                            </p>
                        )}

                        {/* Senses grouped by Part of Speech */}
                        <div className={s.senses}>
                            {data.partsOfSpeech?.map((posGroup, pIdx) => {
                                const isExpanded = !!expandedPos[pIdx];
                                const allSenses = posGroup.senses || [];
                                const visibleSenses = isExpanded ? allSenses : allSenses.slice(0, 2);
                                const remaining = allSenses.length - 2;

                                return (
                                    <div key={pIdx} className={s.group}>
                                        <div className={s.groupHead}>
                                            <span className={s.pos}>{posGroup.partOfSpeech}</span>
                                            <span className={s.groupCount}>{allSenses.length} nghĩa</span>
                                        </div>
                                        <ol className={s.senseList}>
                                            {visibleSenses.map((sense, sIdx) => (
                                                <li key={sIdx} className={s.sense}>
                                                    <span className={s.senseNo}>{sIdx + 1}.</span>
                                                    <div>
                                                        {sense.definitionEn && <p className={s.senseDef}>{sanitizeLexicalText(sense.definitionEn)}</p>}
                                                        {sense.translationVi && <p className={s.senseVi}>{sanitizeLexicalText(sense.translationVi)}</p>}
                                                        {sense.examples && sense.examples.length > 0 && (
                                                            <p className={s.senseEx}>"{sanitizeLexicalText(sense.examples[0])}"</p>
                                                        )}
                                                    </div>
                                                </li>
                                            ))}
                                        </ol>
                                        {remaining > 0 && (
                                            <button
                                                type="button"
                                                onClick={() => setExpandedPos(prev => ({ ...prev, [pIdx]: !prev[pIdx] }))}
                                                className={s.more}
                                                aria-expanded={isExpanded}
                                            >
                                                {isExpanded ? 'Thu gọn' : `Xem thêm ${remaining} nghĩa`}
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Add to Flashcards */}
                    <div className={s.actions}>
                        <MiniSave
                            full
                            state={saving ? "saving" : saved ? "saved" : saveError ? "error" : "idle"}
                            idle="Thêm vào Flashcards"
                            saved="Đã lưu vào Flashcards"
                            error="Lưu lại"
                            onClick={addToFlashcards}
                        />
                    </div>
                    {saveError && <p className={s.note} role="alert">{saveError}</p>}
                </>
            )}
        </div>
    );
}
