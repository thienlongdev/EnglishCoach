export type EntryType = 'WORD' | 'PHRASAL_VERB' | 'IDIOM' | 'COLLOCATION' | 'EXPRESSION';

export interface Pronunciation {
    ipa?: string;
    region?: string; // 'UK' | 'US' | 'AU' | 'General'
    audioUrl?: string;
}

export interface Sense {
    id: string;
    definitionEn?: string;
    translationVi?: string;
    register?: string;
    labels?: string[];
    examples?: string[];
    synonyms?: string[];
    antonyms?: string[];
}

export interface PartOfSpeechGroup {
    partOfSpeech: string;
    senses: Sense[];
}

export interface Collocation {
    phrase: string;
    pattern?: string; // 'verb + noun', 'adj + noun', etc.
    score?: number;
    source?: string;
    example?: string;
    translationVi?: string;
    hasExactEntry?: boolean;
}

export interface PhrasalVerbItem {
    phrase: string;
    shortMeaning?: string;
    senses?: Sense[];
}

export interface IdiomItem {
    phrase: string;
    shortMeaning?: string;
    translationVi?: string;
    examples?: string[];
}

export interface CanonicalDictionaryEntry {
    query: string;
    normalizedQuery: string;
    entryType: EntryType;
    headword: string;
    cefr?: string;
    source?: string;
    generalTranslationVi?: string;
    searchedForm?: string;
    inflectionNote?: string;
    pronunciations: Pronunciation[];
    partsOfSpeech: PartOfSpeechGroup[];
    forms?: string[];
    collocations?: Collocation[];
    phrasalVerbs?: PhrasalVerbItem[];
    idioms?: IdiomItem[];
    expressions?: IdiomItem[];
    relatedWords?: string[];
    /** Build revision of the backend payload (2 = senses never paired with Vietnamese text by position). */
    lexiconRevision?: number;
    /**
     * The word's Vietnamese senses from the bundled EN–VI dictionary, by part of speech in its own order. NOT aligned
     * with `partsOfSpeech`: a sense's own `translationVi` is set only when a source wrote it for that sense.
     */
    vietnameseSenses?: VietnameseSenseGroup[];
    /** Attribution of `vietnameseSenses`. */
    vietnameseSource?: string;
    /** Word-level synonyms / antonyms (never tied to one sense). */
    synonyms?: string[];
    antonyms?: string[];
}

export interface VietnameseSenseGroup {
    partOfSpeech: string;
    meanings: string[];
}

export interface CollocationGroup {
    pattern: string;
    items: Collocation[];
}

export interface CollocationsResponse {
    word: string;
    groups: CollocationGroup[];
}

export interface PhrasesResponse {
    word: string;
    phrasalVerbs: PhrasalVerbItem[];
    idioms: IdiomItem[];
    expressions?: IdiomItem[];
}
