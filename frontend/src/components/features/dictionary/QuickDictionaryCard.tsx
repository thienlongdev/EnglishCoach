"use client";

import React from "react";
import { BookOpen, Quote, RefreshCw } from "lucide-react";
import { DictionaryLookupResult } from "@/services/dictionaryService";
import { MiniHeader, MiniLoading, MiniSave, miniStyles as s } from "./lexicon/LexiconMini";

export interface QuickDictionaryCardProps {
    variant?: "popover" | "reading";
    status: "loading" | "success" | "not_found" | "error";
    data: DictionaryLookupResult | null;
    word: string;
    tokens?: string[];
    savingFlashcard?: boolean;
    flashcardSaved?: boolean;
    /** A save the server refused: told on the card, the button offers the save again. */
    flashcardError?: string;
    className?: string;
    onRetry: () => void;
    onSpeak: (word: string) => void;
    onAddFlashcard?: (word: string, meaning: string, example?: string) => void;
    onOpenFullDictionary?: (word: string) => void;
    onSelectWord?: (word: string) => void;
}

/**
 * Echo Lexicon Mini: the quick dictionary card of a selection (Reading, My Books, Translation / Writing popovers).
 * The meaning comes first, then the English definition and one example; every action is the caller's.
 */
export const QuickDictionaryCard: React.FC<QuickDictionaryCardProps> = ({
    variant = "popover",
    status,
    data,
    word,
    tokens,
    savingFlashcard = false,
    flashcardSaved = false,
    flashcardError = "",
    className,
    onRetry,
    onSpeak,
    onAddFlashcard,
    onOpenFullDictionary,
    onSelectWord,
}) => {
    const isReading = variant === "reading";
    const candidateTokens = tokens || data?.candidateTokens;
    const isMultiWordNotFound = !isReading && status === "not_found" && candidateTokens && candidateTokens.length > 1;
    const saveState = savingFlashcard ? "saving" : flashcardSaved ? "saved" : flashcardError ? "error" : "idle";

    return (
        <div
            className={`${s.mini} ${isReading ? s.attached : ""} ${className || ""}`}
            onClick={(e) => e.stopPropagation()}
            aria-live="polite"
        >
            {/* 1. LOADING STATE */}
            {status === "loading" && <MiniLoading text={isReading ? "Đang tra nghĩa..." : "Đang tra từ điển..."} />}

            {/* 2. NOT FOUND STATE */}
            {status === "not_found" && (
                <div className={s.state}>
                    {isReading ? (
                        <>
                            <p className={s.stateText}>Không tìm thấy từ <b>"{word}"</b> trong từ điển.</p>
                            <p className={s.note}>Bạn có thể chọn <b>"Giải nghĩa ngữ cảnh"</b> trên thanh công cụ để phân tích chi tiết.</p>
                        </>
                    ) : isMultiWordNotFound ? (
                        <>
                            <p className={s.stateText}>Không tìm thấy cụm từ <b>"{word}"</b> trong từ điển.</p>
                            <p className={s.note}>Tra cứu từng từ:</p>
                            <div className={s.tokens}>
                                {candidateTokens.map((tok, idx) => (
                                    <button key={idx} type="button" onClick={() => onSelectWord?.(tok)} className={s.token}>
                                        {tok}
                                    </button>
                                ))}
                            </div>
                        </>
                    ) : (
                        <>
                            <p className={s.stateText}>Không tìm thấy từ <b>"{word}"</b> trong từ điển.</p>
                            {onOpenFullDictionary && (
                                <button type="button" onClick={() => onOpenFullDictionary(word)} className={s.link}>
                                    <BookOpen aria-hidden="true" />
                                    <span>Tra từ điển mở rộng</span>
                                </button>
                            )}
                        </>
                    )}
                </div>
            )}

            {/* 3. ERROR STATE */}
            {status === "error" && (
                <div className={s.state}>
                    <p className={`${s.stateText} ${s.stateError}`}>Lỗi kết nối từ điển.</p>
                    <button type="button" onClick={onRetry} className={s.retry}>
                        <RefreshCw aria-hidden="true" />
                        <span>Thử lại</span>
                    </button>
                </div>
            )}

            {/* 4. SUCCESS STATE */}
            {status === "success" && data && (
                <>
                    <MiniHeader word={data.word} pos={data.partOfSpeech} ipa={data.ipa} onSpeak={() => onSpeak(data.word)} />

                    <div className={s.body}>
                        {/* Primary Vietnamese meaning, then the other meanings of the word */}
                        <p className={s.meaning}>{data.vietnameseMeaning}</p>
                        {data.additionalMeanings && data.additionalMeanings.length > 1 && (
                            <div className={s.alts}>
                                {data.additionalMeanings.slice(1, 4).map((alt, idx) => <span key={idx}>{alt}</span>)}
                            </div>
                        )}

                        {data.englishDefinition && (
                            <p className={s.def}>
                                <span className={s.tag}>EN</span>
                                <span>{data.englishDefinition}</span>
                            </p>
                        )}

                        {data.example && (
                            <p className={s.example}>
                                <Quote className={s.exampleMark} aria-hidden="true" />
                                <span>"{data.example}"</span>
                            </p>
                        )}
                    </div>

                    {/* Actions */}
                    {isReading ? (
                        onAddFlashcard && (
                            <div className={s.actions}>
                                <MiniSave
                                    full
                                    state={saveState}
                                    idle="Thêm vào Flashcard"
                                    onClick={() => onAddFlashcard(data.word, data.vietnameseMeaning, data.example)}
                                />
                            </div>
                        )
                    ) : (
                        <div className={s.actions}>
                            {onOpenFullDictionary ? (
                                <button type="button" onClick={() => onOpenFullDictionary(data.word)} className={s.link}>
                                    <BookOpen aria-hidden="true" />
                                    <span>Từ điển đầy đủ</span>
                                </button>
                            ) : (
                                <span />
                            )}
                            {onAddFlashcard && (
                                <MiniSave
                                    state={saveState}
                                    idle="Lưu Flashcard"
                                    error="Lưu lại"
                                    onClick={() => onAddFlashcard(data.word, data.vietnameseMeaning, data.example)}
                                />
                            )}
                        </div>
                    )}
                    {flashcardError && <p className={s.note} role="alert">{flashcardError}</p>}
                </>
            )}
        </div>
    );
};
