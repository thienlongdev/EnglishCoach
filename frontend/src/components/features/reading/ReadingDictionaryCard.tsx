"use client";

import React from "react";
import { DictionaryLookupResult } from "@/services/dictionaryService";
import { QuickDictionaryCard } from "@/components/features/dictionary/QuickDictionaryCard";

export interface ReadingDictionaryCardProps {
    status: "loading" | "success" | "not_found" | "error";
    data: DictionaryLookupResult | null;
    word: string;
    onRetry: () => void;
    onSpeak: (word: string) => void;
    onAddFlashcard?: (word: string, meaning: string, example?: string) => void;
}

/**
 * Reading Dictionary Card.
 * Wraps the shared QuickDictionaryCard with variant="reading" to guarantee
 * 100% preservation of the production Reading presentation, styling, and behavior.
 */
export const ReadingDictionaryCard: React.FC<ReadingDictionaryCardProps> = ({
    status,
    data,
    word,
    onRetry,
    onSpeak,
    onAddFlashcard,
}) => {
    return (
        <QuickDictionaryCard
            variant="reading"
            status={status}
            data={data}
            word={word}
            onRetry={onRetry}
            onSpeak={onSpeak}
            onAddFlashcard={onAddFlashcard}
        />
    );
};
