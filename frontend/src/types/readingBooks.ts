/** My Books selected-text contextual explanation (POST /api/v1/reading/books/explain-selection). */

export interface BookSelectionExplainRequest {
    /** The exact selected text (≤ 300 characters). */
    text: string;
    /** The complete sentence that contains it (≤ 1,200 characters). */
    sentence: string;
    /** A bounded amount of nearby text (≤ 2,000 characters). Never the whole book. */
    context?: string;
    bookTitle?: string;
    bookAuthor?: string;
}

export interface ContextTranslation {
    meaningInContext: string;
    sentenceTranslation: string | null;
    explanation: string | null;
    expressionType: "WORD" | "PHRASE" | "IDIOM" | "PHRASAL_VERB" | "COLLOCATION" | "FIGURATIVE" | "SENTENCE" | string | null;
    literalMeaning: string | null;
    lemma: string | null;
    partOfSpeech: string | null;
    cefr: string | null;
    register: string | null;
    confidence: "HIGH" | "MEDIUM" | "LOW" | string | null;
    ambiguityNote: string | null;
}
