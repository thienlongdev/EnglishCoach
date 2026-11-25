/**
 * Dictionary Service for English Coach.
 *
 * Provides:
 * 1. Lexical tokenization & word count determination (preserving meaningful internal hyphens and apostrophes).
 * 2. 1-2 word detection for dictionary routing vs. >= 3 words translation routing.
 * 3. In-memory session caching for near-instant repeat lookups.
 * 4. Fast, non-AI dictionary lookup reusing existing project dictionary endpoints.
 */

import { lookupCanonical, hasValidLexicalContent } from "./dictionaryEngine";
import { rankCanonicalEntry, detectContextualPos } from "./dictionaryRanking";

export interface DictionaryLookupResult {
    word: string;
    ipa?: string;
    partOfSpeech?: string;
    vietnameseMeaning: string;
    additionalMeanings?: string[];
    englishDefinition?: string;
    example?: string;
    candidateTokens?: string[];
    isPhraseNotFound?: boolean;
}

// In-memory session cache for dictionary lookups
const dictionarySessionCache = new Map<string, DictionaryLookupResult>();

/**
 * Normalizes text to extract lexical tokens:
 * - Trims whitespace
 * - Strips outer surrounding punctuation (e.g. quotes, parentheses, brackets, periods, commas, exclamation/question marks)
 * - Preserves meaningful internal hyphens ("hard-to-defend") and apostrophes ("don't")
 * - Splits into whitespace-delimited tokens
 */
export function getLexicalTokens(text: string): string[] {
    if (!text) return [];
    const trimmed = text.trim();
    if (!trimmed) return [];

    // Split by whitespace
    const rawTokens = trimmed.split(/\s+/).filter(Boolean);

    // Clean outer leading and trailing punctuation while preserving internal hyphens and apostrophes
    const cleanedTokens = rawTokens
        .map((token) => {
            return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        })
        .filter(Boolean);

    return cleanedTokens;
}

/**
 * Returns true if the selected text contains 1 to 5 lexical words.
 */
export function isLexicalDictionaryTarget(text: string): boolean {
    const tokens = getLexicalTokens(text);
    return tokens.length >= 1 && tokens.length <= 5;
}

/**
 * Returns the normalized lowercase lexical lookup target.
 */
export function getNormalizedLexicalLookupTarget(text: string): string {
    const tokens = getLexicalTokens(text);
    return tokens.join(" ").toLowerCase();
}

/**
 * Clears the in-memory dictionary session cache (useful for testing or cache reset).
 */
export function clearDictionarySessionCache(): void {
    dictionarySessionCache.clear();
}

/**
 * Looks up a word or multi-word phrase in the dictionary.
 * STRICT CONTRACT:
 * - DO NOT call AI or LLMs.
 * - Deterministic context-aware ranking using syntactic sentence context.
 * - Normal lexical senses are preferred over obscure symbols/proper-names.
 * - Single word -> normal word lookup.
 * - Multi-word (2-5 words) -> try exact phrase lookup first.
 *   If no phrase entry exists -> DO NOT fabricate meanings. Return tokens for individual word inspection.
 * - Checks in-memory session cache first for instant response.
 * - Returns null if the word/phrase is not found.
 */
export interface LookupDictionaryOptions {
    signal?: AbortSignal;
    contextSentence?: string;
    selectionStart?: number;
    selectionEnd?: number;
    onSecondaryData?: (updated: DictionaryLookupResult) => void;
}

export async function lookupDictionary(
    rawText: string,
    options?: LookupDictionaryOptions
): Promise<DictionaryLookupResult | null> {
    const tokens = getLexicalTokens(rawText);
    if (tokens.length === 0 || tokens.length > 5) {
        return null;
    }

    const cleanWord = tokens.join(" ").toLowerCase();
    if (!cleanWord) return null;

    // Determine cache key incorporating detected POS if contextual
    let cacheKey = cleanWord;
    if (tokens.length === 1 && options?.contextSentence) {
        const { expectedPos } = detectContextualPos(
            cleanWord,
            options.contextSentence,
            options.selectionStart,
            options.selectionEnd
        );
        if (expectedPos) {
            cacheKey = `${cleanWord}:${expectedPos}`;
        }
    }

    // 1. Session Cache Check
    const cached = dictionarySessionCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    // 2. Query unified Dictionary Engine V2
    try {
        const canonical = await lookupCanonical(cleanWord, "en-vi", { signal: options?.signal });
        if (canonical && hasValidLexicalContent(canonical)) {
            const ranked = rankCanonicalEntry(canonical, {
                contextSentence: options?.contextSentence,
                selectionStart: options?.selectionStart,
                selectionEnd: options?.selectionEnd,
            });

            if (ranked) {
                dictionarySessionCache.set(cacheKey, ranked);
                return ranked;
            }
        }
    } catch (e) {
        console.warn("[dictionaryService] lookupCanonical failed:", e);
    }

    // 3. Multi-word phrase fallback:
    // If a multi-word expression (2-5 words) was queried and has no exact dictionary entry,
    // DO NOT fabricate a fake phrase meaning.
    // Return a structured result with candidateTokens so the learner can inspect individual words!
    if (tokens.length > 1) {
        return {
            word: cleanWord,
            vietnameseMeaning: "",
            candidateTokens: tokens,
            isPhraseNotFound: true,
        };
    }

    return null;
}

