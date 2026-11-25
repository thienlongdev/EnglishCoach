import { apiClient } from "@/services/api-client";
import {
    CanonicalDictionaryEntry,
    CollocationsResponse,
    PhrasesResponse,
    PartOfSpeechGroup,
    Sense,
    Pronunciation,
    Collocation,
    EntryType
} from "./dictionary/types";

// In-memory session caches for sub-millisecond warm lookups
const sessionCache = new Map<string, CanonicalDictionaryEntry>();
const collocationsCache = new Map<string, CollocationsResponse>();
const phrasesCache = new Map<string, PhrasesResponse>();
const inFlightLookups = new Map<string, Promise<CanonicalDictionaryEntry | null>>();

export function clearDictionaryEngineCache(): void {
    sessionCache.clear();
    inFlightLookups.clear();
    collocationsCache.clear();
    phrasesCache.clear();
}

/**
 * Checks whether an entry possesses trusted, non-empty lexical content: an English definition, or a sense the
 * backend took from its bundled EN–VI dictionary (an entry answered from that dictionary alone has Vietnamese senses
 * only). A shell with only a general translation or a pronunciation fails this check.
 */
export function hasValidLexicalContent(entry: CanonicalDictionaryEntry | null | undefined): boolean {
    if (!entry || !entry.partsOfSpeech || entry.partsOfSpeech.length === 0) {
        return false;
    }
    return entry.partsOfSpeech.some(pos =>
        pos.senses && pos.senses.some(s =>
            (typeof s.definitionEn === "string" && s.definitionEn.trim().length > 0) ||
            (typeof s.translationVi === "string" && s.translationVi.trim().length > 0)
        )
    );
}

/**
 * Normalizes query string: trims, collapses whitespace, lowercase.
 */
export function normalizeQuery(query: string): string {
    if (!query) return "";
    return query.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Main lexical lookup function.
 * Deterministic, ZERO AI.
 * 1. Checks in-memory session cache.
 * 2. Calls unified backend Dictionary Engine V2 (/api/v1/dictionary/v2/lookup).
 * 3. Gracefully falls back to Next.js dictionary proxy + GTX if backend is unavailable.
 */
export async function lookupCanonical(
    rawQuery: string,
    mode: "en-en" | "en-vi" = "en-en",
    options?: { signal?: AbortSignal }
): Promise<CanonicalDictionaryEntry | null> {
    const cleanQuery = normalizeQuery(rawQuery);
    if (!cleanQuery) return null;

    // The backend payload is the same for both modes (2026-10-24: every entry carries its Vietnamese layer)
    const cacheKey = cleanQuery;
    const cached = sessionCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    // One request per word at a time: popups opened together share it. A caller's abort only stops its own wait.
    let pending = inFlightLookups.get(cacheKey);
    if (!pending) {
        pending = fetchCanonical(cleanQuery, mode, cacheKey).finally(() => inFlightLookups.delete(cacheKey));
        inFlightLookups.set(cacheKey, pending);
    }
    const signal = options?.signal;
    if (!signal) return pending;
    if (signal.aborted) return null;
    return new Promise((resolve) => {
        const onAbort = () => resolve(null);
        signal.addEventListener("abort", onAbort, { once: true });
        pending!.then(resolve, () => resolve(null)).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

async function fetchCanonical(
    cleanQuery: string,
    mode: "en-en" | "en-vi",
    cacheKey: string
): Promise<CanonicalDictionaryEntry | null> {
    // 1. Try unified Backend Dictionary Engine V2
    try {
        const res = await apiClient.get<CanonicalDictionaryEntry>(
            `/dictionary/v2/lookup?word=${encodeURIComponent(cleanQuery)}&mode=${mode}`
        );
        if (res.data && res.data.headword && hasValidLexicalContent(res.data)) {
            // an entry answered from the bundled EN-VI dictionary alone (no English definition: providers slow or
            // silent) is not kept: the next lookup asks again and may get the full entry
            const hasEnglish = res.data.partsOfSpeech.some(g => g.senses?.some(s => !!s.definitionEn?.trim()));
            if (hasEnglish) sessionCache.set(cacheKey, res.data);
            return res.data;
        }
    } catch (backendErr: any) {
        if (backendErr?.response?.status === 404) {
            // Lexical existence gate explicitly determined the query does not exist
            return null;
        }
        // Fall through to resilient client fallback only if backend 5xx/network failure
        console.warn("[DictionaryEngine] Backend lookup failed, trying fallback:", backendErr?.message);
    }

    // 2. Resilient Client Fallback: Next.js proxy + Google GTX
    try {
        const fallback = await clientFallbackLookup(cleanQuery, mode);
        if (fallback && hasValidLexicalContent(fallback)) {
            sessionCache.set(cacheKey, fallback);
            return fallback;
        }
    } catch (fallbackErr: any) {
        console.error("[DictionaryEngine] All dictionary providers failed:", fallbackErr);
    }

    return null;
}

/**
 * Progressive fetch for Collocations grouped by pattern.
 */
export async function fetchCollocations(word: string): Promise<CollocationsResponse> {
    const cleanWord = normalizeQuery(word);
    if (!cleanWord) return { word: "", groups: [] };

    const cached = collocationsCache.get(cleanWord);
    if (cached) return cached;

    try {
        const res = await apiClient.get<CollocationsResponse>(
            `/dictionary/v2/collocations?word=${encodeURIComponent(cleanWord)}`
        );
        if (res.data) {
            const hasItems = res.data.groups && res.data.groups.some(g => g.items && g.items.length > 0);
            if (hasItems) {
                collocationsCache.set(cleanWord, res.data);
            }
            return res.data;
        }
    } catch (e) {
        console.warn("[DictionaryEngine] Backend collocations failed, using Datamuse fallback:", e);
    }

    // Datamuse client-side fallback
    try {
        const [jjbRes, bgbRes] = await Promise.all([
            fetch(`https://api.datamuse.com/words?rel_jjb=${encodeURIComponent(cleanWord)}&max=10`).then(r => r.json()),
            fetch(`https://api.datamuse.com/words?rel_bgb=${encodeURIComponent(cleanWord)}&max=15`).then(r => r.json())
        ]);

        const adjItems: Collocation[] = Array.isArray(jjbRes)
            ? jjbRes.map(i => ({ phrase: `${i.word} ${cleanWord}`, pattern: "adjective + noun", score: i.score, source: "Datamuse" }))
            : [];

        const verbItems: Collocation[] = Array.isArray(bgbRes)
            ? bgbRes.filter(i => i.word.length > 2 && !['the', 'a', 'of', 'in', 'to', 'for'].includes(i.word))
                .slice(0, 10)
                .map(i => ({ phrase: `${i.word} ${cleanWord}`, pattern: "verb + noun", score: i.score, source: "Datamuse" }))
            : [];

        const groups = [];
        if (verbItems.length > 0) groups.push({ pattern: "Verb + Noun", items: verbItems });
        if (adjItems.length > 0) groups.push({ pattern: "Adjective + Noun", items: adjItems });

        const result: CollocationsResponse = { word: cleanWord, groups };
        if (groups.length > 0) {
            collocationsCache.set(cleanWord, result);
        }
        return result;
    } catch {
        return { word: cleanWord, groups: [] };
    }
}

/**
 * Progressive fetch for Phrasal Verbs & Idioms.
 */
export async function fetchPhrases(word: string): Promise<PhrasesResponse> {
    const cleanWord = normalizeQuery(word);
    if (!cleanWord) return { word: "", phrasalVerbs: [], idioms: [], expressions: [] };

    const cached = phrasesCache.get(cleanWord);
    if (cached) return cached;

    try {
        const res = await apiClient.get<PhrasesResponse>(
            `/dictionary/v2/phrases?word=${encodeURIComponent(cleanWord)}`
        );
        if (res.data) {
            const hasData = ((res.data.phrasalVerbs?.length || 0) +
                (res.data.idioms?.length || 0) +
                (res.data.expressions?.length || 0)) > 0;
            if (hasData) {
                phrasesCache.set(cleanWord, res.data);
            }
            return res.data;
        }
    } catch (e) {
        console.warn("[DictionaryEngine] Backend phrases fetch failed:", e);
    }

    return { word: cleanWord, phrasalVerbs: [], idioms: [], expressions: [] };
}

/**
 * Resilient client fallback synthesizing DictionaryAPI + Google GTX data.
 */
async function clientFallbackLookup(
    word: string,
    mode: "en-en" | "en-vi",
    signal?: AbortSignal
): Promise<CanonicalDictionaryEntry | null> {
    // Parallel fetch: Dictionary definition + Google translation
    const dictPromise = fetch(`/api/dictionary?word=${encodeURIComponent(word)}`, { signal })
        .then(async res => (res.ok ? await res.json() : null))
        .catch(() => null);

    const gtxPromise = fetch(
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&dt=bd&dt=rm&q=${encodeURIComponent(word)}`,
        { signal }
    )
        .then(async res => (res.ok ? await res.json() : null))
        .catch(() => null);

    const [dictData, gtxData] = await Promise.all([dictPromise, gtxPromise]);

    // Translation alone is NOT sufficient evidence for a lexical entry
    if (!dictData || !Array.isArray(dictData) || dictData.length === 0) return null;

    let headword = word;
    const pronunciations: Pronunciation[] = [];
    const posGroups: PartOfSpeechGroup[] = [];
    let generalTranslationVi: string | undefined;
    const isMultiWord = word.trim().includes(" ");

    // 1. Process Google GTX data: the general meaning only. Its bilingual term lists (dt=bd) are not aligned with the
    // English senses, so they are never placed under one (the "excitement → khó chịu" defect, audit 2026-10-19).
    if (gtxData && Array.isArray(gtxData)) {
        if (gtxData[0] && gtxData[0][0] && gtxData[0][0][0]) {
            generalTranslationVi = gtxData[0][0][0].toString().trim();
        }

        // IPA from GTX transcription
        if (gtxData[0] && gtxData[0].length > 1 && gtxData[0][1] && gtxData[0][1][3]) {
            pronunciations.push({
                ipa: `/${gtxData[0][1][3]}/`,
                region: "General"
            });
        }
    }

    // 2. Process DictionaryAPI data
    const first = dictData[0];
    headword = first.word || word;

    if (first.phonetics && Array.isArray(first.phonetics)) {
        for (const p of first.phonetics) {
            const ipa = p.text;
            const audio = p.audio;
            let region = "General";
            if (audio) {
                if (audio.includes("-uk.") || audio.includes("uk/")) region = "UK";
                else if (audio.includes("-us.") || audio.includes("us/")) region = "US";
            }
            if (ipa || audio) {
                pronunciations.push({ ipa, audioUrl: audio, region });
            }
        }
    }

    if (first.meanings && Array.isArray(first.meanings)) {
        let senseCount = 1;
        for (const m of first.meanings) {
            const pos = (m.partOfSpeech || "general").toLowerCase();
            const senses: Sense[] = [];

            if (m.definitions && Array.isArray(m.definitions)) {
                for (let dIdx = 0; dIdx < m.definitions.length; dIdx++) {
                    const d = m.definitions[dIdx];
                    if (!d.definition) continue;

                    senses.push({
                        id: String(senseCount++),
                        definitionEn: d.definition,
                        examples: d.example ? [d.example] : [],
                        synonyms: Array.isArray(d.synonyms) ? d.synonyms : [],
                        antonyms: Array.isArray(d.antonyms) ? d.antonyms : []
                    });
                }
            }

            if (senses.length > 0) {
                posGroups.push({ partOfSpeech: pos, senses });
            }
        }
    }

    if (posGroups.length === 0) {
        return null;
    }

    const entry: CanonicalDictionaryEntry = {
        query: word,
        normalizedQuery: word,
        entryType: isMultiWord ? "PHRASAL_VERB" : "WORD",
        headword,
        generalTranslationVi: isMultiWord ? undefined : generalTranslationVi,
        pronunciations,
        partsOfSpeech: posGroups,
        source: "English Coach Lexical Fallback"
    };

    return hasValidLexicalContent(entry) ? entry : null;
}
