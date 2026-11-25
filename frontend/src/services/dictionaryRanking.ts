/**
 * Generic Deterministic Context-Aware Lexical Ranking for English Coach.
 *
 * ZERO AI / LLM calls.
 * ZERO hardcoded vocabulary / per-word maps.
 *
 * Algorithm:
 * 1. Analyzes sentence context to determine expected POS of the selected token.
 *    Rule 0 (highest priority): closed-class identity — if the token is itself a known
 *    determiner, subject pronoun, or preposition it is guaranteed that POS regardless of
 *    surrounding context, because those word classes have near-zero polysemy in function.
 * 2. Ranks candidate PartOfSpeechGroups from CanonicalDictionaryEntry:
 *    - Matching contextual POS receives a strong bonus (+150 × confidence).
 *    - All standard lexical POS (noun, verb, adjective, adverb, determiner, pronoun,
 *      preposition, conjunction) receive equal base priority (+60). No function-word
 *      penalty — base-score asymmetry was RC1 causing article/preposition groups to
 *      always lose to noun/verb groups when context was absent.
 *    - Obscure / technical tags (symbol, letter, proper noun, prefix, suffix, code)
 *      receive a strong penalty (-120).
 * 3. Ranks senses within the best group:
 *    - Valid Vietnamese translation (+40)
 *    - Non-empty English definition (+25)
 *    - Examples (+15)
 *    - Penalizes archaic, obsolete, slang, or circular cross-references (-60).
 * 4. Fallback: If contextual POS is uncertain or context is absent, normal/common lexical
 *    senses are ALWAYS preferred over obscure technical/symbol/proper-name senses.
 */

import { CanonicalDictionaryEntry, PartOfSpeechGroup, Sense } from "./dictionary/types";
import { DictionaryLookupResult } from "./dictionaryService";

export type ExpectedPosCategory =
  | "VERB"
  | "NOUN"
  | "ADJECTIVE"
  | "ADVERB"
  | "DETERMINER"
  | "PREPOSITION"
  | "PRONOUN"
  | "CONJUNCTION";

interface TokenInfo {
  text: string;
  lower: string;
  start: number;
  end: number;
}

// Common determiners / articles
const DETERMINERS = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "my", "your", "his", "her", "our", "their", "its",
  "each", "every", "some", "any", "no", "either", "neither",
  "another", "much", "many", "few", "little", "all", "both"
]);

// Common subject pronouns
const SUBJECT_PRONOUNS = new Set([
  "i", "you", "he", "she", "it", "we", "they", "who", "whoever"
]);

// Common auxiliary and modal verbs
const MODAL_AND_AUXILIARY_VERBS = new Set([
  "can", "could", "may", "might", "must", "shall", "should", "will", "would",
  "do", "does", "did", "have", "has", "had", "am", "is", "are", "was", "were", "be", "been", "being"
]);

// Common prepositions
const PREPOSITIONS = new Set([
  "in", "on", "at", "by", "for", "with", "about", "against", "between", "into",
  "through", "during", "before", "after", "above", "below", "to", "from",
  "up", "down", "off", "over", "under", "again", "further", "then", "once",
  "across", "behind", "beyond", "without", "inside", "outside", "upon", "toward", "towards"
]);

// Common linking verbs
const LINKING_VERBS = new Set([
  "is", "am", "are", "was", "were", "be", "been", "being",
  "seem", "seems", "seemed", "appear", "appears", "appeared",
  "become", "becomes", "became", "feel", "feels", "felt",
  "look", "looks", "looked", "taste", "tastes", "tasted",
  "sound", "sounds", "sounded", "remain", "remains", "remained"
]);

// Common adverbs / intensifiers
const ADVERB_INTENSIFIERS = new Set([
  "very", "quite", "really", "extremely", "too", "so", "fairly", "rather", "pretty",
  "always", "never", "often", "sometimes", "seldom", "rarely", "already", "still", "well"
]);

// Obscure / technical POS labels that should not take precedence over real lexical words
const OBSCURE_POS_TAGS = new Set([
  "symbol", "symbols", "letter", "letters", "character", "characters",
  "proper noun", "proper-noun", "proper_noun", "proper noun.",
  "prefix", "suffix", "affix", "combining form", "combining-form",
  "abbreviation", "initialism", "acronym", "code", "punctuation",
  "numeral", "particle"
]);

/**
 * Splits text into tokens while preserving character offsets.
 */
function tokenizeWithOffsets(text: string): TokenInfo[] {
  const tokens: TokenInfo[] = [];
  const regex = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    tokens.push({
      text: match[0],
      lower: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return tokens;
}

/**
 * Detects the syntactic role / expected POS of a target token inside contextSentence.
 *
 * Evaluation order:
 *   Rule 0 — closed-class identity (DETERMINER / PRONOUN / PREPOSITION): highest priority.
 *            These word classes are functionally monosemous; their identity in a sentence
 *            is determined by what they ARE, not what surrounds them.
 *   Rules 1-8 — syntactic context heuristics for open-class words.
 */
export function detectContextualPos(
  word: string,
  contextSentence?: string,
  selectionStart?: number,
  selectionEnd?: number
): { expectedPos: ExpectedPosCategory | null; confidence: number } {
  if (!contextSentence || !contextSentence.trim()) {
    return { expectedPos: null, confidence: 0 };
  }

  const cleanWord = word.trim().toLowerCase();
  const tokens = tokenizeWithOffsets(contextSentence);
  if (tokens.length === 0) {
    return { expectedPos: null, confidence: 0 };
  }

  // 1. Locate the target token in the token sequence
  let targetIndex = -1;

  if (selectionStart !== undefined && selectionEnd !== undefined && selectionStart >= 0) {
    // Overlap matching by character offsets
    targetIndex = tokens.findIndex(
      (t) => (t.start >= selectionStart && t.start < selectionEnd) || (t.end > selectionStart && t.end <= selectionEnd) || (t.start <= selectionStart && t.end >= selectionEnd)
    );
  }

  if (targetIndex === -1) {
    // Fallback: match by token surface text
    targetIndex = tokens.findIndex((t) => t.lower === cleanWord);
  }

  if (targetIndex === -1) {
    return { expectedPos: null, confidence: 0 };
  }

  const prevToken = targetIndex > 0 ? tokens[targetIndex - 1] : null;
  const prev2Token = targetIndex > 1 ? tokens[targetIndex - 2] : null;
  const nextToken = targetIndex < tokens.length - 1 ? tokens[targetIndex + 1] : null;
  const targetToken = tokens[targetIndex];

  // ─────────────────────────────────────────────────────────────────────────
  // Rule 0 (RC3 fix): Closed-class identity — evaluated BEFORE all other rules.
  //
  // Determiners, subject pronouns, and prepositions are closed-class word sets
  // with near-zero polysemy in typical in-context usage. If the selected token
  // IS one of these, its grammatical identity is fixed regardless of surroundings.
  //
  // This prevents downstream rules (especially Rule 4, which classifies any token
  // after a modal/auxiliary as VERB) from overriding the correct POS.
  // ─────────────────────────────────────────────────────────────────────────
  if (DETERMINERS.has(targetToken.lower)) {
    return { expectedPos: "DETERMINER", confidence: 0.97 };
  }
  if (SUBJECT_PRONOUNS.has(targetToken.lower)) {
    return { expectedPos: "PRONOUN", confidence: 0.97 };
  }
  if (PREPOSITIONS.has(targetToken.lower)) {
    return { expectedPos: "PREPOSITION", confidence: 0.90 };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Open-class syntactic heuristics (Rules 1–8)
  // Only reached when the target token is NOT in a closed-class set.
  // ─────────────────────────────────────────────────────────────────────────

  // Syntactic Rule 1: Target IS a modal / auxiliary verb
  // e.g. selecting "can" in "I can swim", "will" in "She will go"
  if (MODAL_AND_AUXILIARY_VERBS.has(targetToken.lower)) {
    if (prevToken && (SUBJECT_PRONOUNS.has(prevToken.lower) || DETERMINERS.has(prev2Token?.lower || ""))) {
      return { expectedPos: "VERB", confidence: 0.95 };
    }
    if (targetIndex === 0 && nextToken && SUBJECT_PRONOUNS.has(nextToken.lower)) {
      // Question inversion: "Can you help?"
      return { expectedPos: "VERB", confidence: 0.9 };
    }
  }

  // Syntactic Rule 2: Infinitive marker "to" immediately before target
  // e.g. "want to defend", "to achieve"
  if (prevToken && prevToken.lower === "to") {
    // Exclude gerund-style fixed prepositional phrases like "look forward to running"
    if (!targetToken.lower.endsWith("ing")) {
      return { expectedPos: "VERB", confidence: 0.9 };
    }
  }

  // Syntactic Rule 3: Subject pronoun / modal immediately before target
  // e.g. "I write", "they know", "you should leave"
  //
  // RC2 fix: Guard against the target being a known closed-class non-verb token.
  // Without this guard, "She is [in] the park" would classify "in" as VERB because
  // prevToken="is" ∈ MODAL_AND_AUXILIARY_VERBS.
  // Rule 0 already handles DETERMINERS/PRONOUNS/PREPOSITIONS before reaching here,
  // but the guard is kept explicitly for safety and self-documentation.
  if (prevToken) {
    if (SUBJECT_PRONOUNS.has(prevToken.lower) || MODAL_AND_AUXILIARY_VERBS.has(prevToken.lower)) {
      // Only infer VERB if target is not itself a known closed-class non-verb word
      if (
        !DETERMINERS.has(targetToken.lower) &&
        !PREPOSITIONS.has(targetToken.lower) &&
        !SUBJECT_PRONOUNS.has(targetToken.lower)
      ) {
        return { expectedPos: "VERB", confidence: 0.85 };
      }
    }
  }

  // Syntactic Rule 4: Determiner / possessive immediately before target
  // e.g. "a can", "the book", "my decision"
  if (prevToken && DETERMINERS.has(prevToken.lower)) {
    if (!nextToken || PREPOSITIONS.has(nextToken.lower) || MODAL_AND_AUXILIARY_VERBS.has(nextToken.lower)) {
      return { expectedPos: "NOUN", confidence: 0.85 };
    }
    // "a [target] book" -> likely adjective modifying following noun
    return { expectedPos: "ADJECTIVE", confidence: 0.65 };
  }

  // Syntactic Rule 5: Preposition immediately before target
  // e.g. "in the room", "at night", "for peace"
  if (prevToken && PREPOSITIONS.has(prevToken.lower)) {
    if (!nextToken || PREPOSITIONS.has(nextToken.lower)) {
      return { expectedPos: "NOUN", confidence: 0.8 };
    }
  }

  // Syntactic Rule 6: Linking verb before target
  // e.g. "is beautiful", "seems tired"
  if (prevToken && LINKING_VERBS.has(prevToken.lower)) {
    if (targetToken.lower.endsWith("ly")) {
      return { expectedPos: "ADVERB", confidence: 0.75 };
    }
    return { expectedPos: "ADJECTIVE", confidence: 0.75 };
  }

  // Syntactic Rule 7: Suffix-based morphological hints (open class)
  if (targetToken.lower.endsWith("ly") && targetToken.lower.length > 3) {
    return { expectedPos: "ADVERB", confidence: 0.8 };
  }
  if (
    targetToken.lower.endsWith("tion") ||
    targetToken.lower.endsWith("ment") ||
    targetToken.lower.endsWith("ness") ||
    targetToken.lower.endsWith("ity") ||
    targetToken.lower.endsWith("ship")
  ) {
    return { expectedPos: "NOUN", confidence: 0.85 };
  }
  if (
    targetToken.lower.endsWith("able") ||
    targetToken.lower.endsWith("ible") ||
    targetToken.lower.endsWith("ful") ||
    targetToken.lower.endsWith("less") ||
    targetToken.lower.endsWith("ous")
  ) {
    return { expectedPos: "ADJECTIVE", confidence: 0.85 };
  }

  return { expectedPos: null, confidence: 0 };
}

/**
 * Maps a dictionary POS string (from Wiktionary, DictionaryApiDev, Kaikki, etc.)
 * to normalized ExpectedPosCategory values used by the ranking engine.
 *
 * RC4 fix: Added coverage for Wiktionary labels "Contraction", "Particle",
 * and "Interjection" which previously fell through to "OTHER".
 */
function normalizePosString(rawPos: string): ExpectedPosCategory | "OBSCURE" | "OTHER" {
  const p = (rawPos || "").trim().toLowerCase();

  // Obscure / technical POS labels — strongly penalized in ranking
  if (OBSCURE_POS_TAGS.has(p) || p.includes("symbol") || p.includes("proper noun") || p.includes("initialism") || p.includes("abbreviation")) {
    return "OBSCURE";
  }

  // Content-word POS ("adverb" contains "verb": it is tested first)
  if (p.includes("adv")) {
    return "ADVERB";
  }
  if (p.includes("verb") || p === "v." || p === "vi" || p === "vt") {
    return "VERB";
  }
  if (p.includes("noun") || p === "n.") {
    return "NOUN";
  }
  if (p.includes("adj") || p.includes("participle")) {
    return "ADJECTIVE";
  }
  if (p.includes("adv")) {
    return "ADVERB";
  }

  // Function-word POS
  if (p.includes("determiner") || p.includes("article")) {
    return "DETERMINER";
  }
  if (p.includes("pronoun") || p === "pron.") {
    return "PRONOUN";
  }
  if (p.includes("prep") || p.includes("preposition")) {
    return "PREPOSITION";
  }
  // Conjunctions and contractions are function words
  if (p.includes("conj") || p.includes("conjunction") || p === "contraction") {
    return "CONJUNCTION";
  }

  // Particles and interjections: not OBSCURE, but not a primary lexical category.
  // Leave as OTHER (+10) so they are preferred over OBSCURE (-120) but do not
  // displace real content-word or function-word groups (+60).
  // (e.g. Wiktionary "Particle", "Interjection" for words like "not", "oh", "well")
  if (p === "particle" || p === "interjection") {
    return "OTHER";
  }

  return "OTHER";
}

/**
 * Evaluates the quality score of a dictionary sense.
 */
function scoreSenseQuality(sense: Sense, contextSentence?: string): number {
  let score = 0;

  // 1. Vietnamese translation quality
  if (sense.translationVi && sense.translationVi.trim().length > 0) {
    const vi = sense.translationVi.trim();
    if (!vi.startsWith("{") && !vi.startsWith("<") && !vi.includes("mw-parser-output")) {
      score += 40;
    }
  }

  // 2. English definition quality
  if (sense.definitionEn && sense.definitionEn.trim().length >= 5) {
    const def = sense.definitionEn.trim();
    score += 25;

    // Penalize circular / dictionary meta stubs
    if (
      def.startsWith("Alternative form of") ||
      def.startsWith("Abbreviation of") ||
      def.startsWith("Initialism of") ||
      def.startsWith("Acronym of") ||
      def.startsWith("Symbol for") ||
      def.startsWith("Clipping of") ||
      def.startsWith("Misspelling of") ||
      def.startsWith("Eye dialect") ||
      def.includes("obsolete") ||
      def.includes("archaic")
    ) {
      score -= 60;
    }
  }

  // 3. Examples
  if (sense.examples && sense.examples.length > 0) {
    score += 15;
  }

  // 4. Register / labels penalty for archaic/slang/vulgar
  if (sense.labels && sense.labels.length > 0) {
    for (const label of sense.labels) {
      const l = label.toLowerCase();
      if (l.includes("archaic") || l.includes("obsolete") || l.includes("historical") || l.includes("slang") || l.includes("rare") || l.includes("vulgar")) {
        score -= 40;
      }
    }
  }

  // 5. Context lexical overlap (if contextSentence provided)
  if (contextSentence && sense.definitionEn) {
    const defWords = sense.definitionEn.toLowerCase().split(/\s+/);
    const ctxWords = new Set(contextSentence.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    let overlaps = 0;
    for (const dw of defWords) {
      if (dw.length > 3 && ctxWords.has(dw)) {
        overlaps++;
      }
    }
    if (overlaps > 0) {
      score += Math.min(25, overlaps * 8);
    }
  }

  return score;
}

/**
 * Context-aware deterministic sense and POS ranking.
 */
export function rankCanonicalEntry(
  canonical: CanonicalDictionaryEntry,
  options?: {
    contextSentence?: string;
    selectionStart?: number;
    selectionEnd?: number;
  }
): DictionaryLookupResult | null {
  if (!canonical || !canonical.partsOfSpeech || canonical.partsOfSpeech.length === 0) {
    return null;
  }

  const headword = canonical.headword || canonical.query;
  const { expectedPos, confidence } = detectContextualPos(
    headword,
    options?.contextSentence,
    options?.selectionStart,
    options?.selectionEnd
  );

  // Score each PartOfSpeechGroup
  interface ScoredGroup {
    group: PartOfSpeechGroup;
    score: number;
    bestSense: Sense | null;
    bestSenseScore: number;
  }

  const scoredGroups: ScoredGroup[] = [];

  for (const group of canonical.partsOfSpeech) {
    const rawPos = group.partOfSpeech || "";
    const normalizedPos = normalizePosString(rawPos);

    let groupScore = 0;

    // RC1 fix: All standard lexical POS receive equal base priority (+60).
    // Previously function-word POS (DETERMINER/PRONOUN/PREPOSITION/CONJUNCTION)
    // received only +50, causing them to always lose to content-word POS when
    // context was absent — even for words like "a", "the", "in" which are
    // overwhelmingly used in their function-word sense.
    if (
      normalizedPos === "NOUN" ||
      normalizedPos === "VERB" ||
      normalizedPos === "ADJECTIVE" ||
      normalizedPos === "ADVERB" ||
      normalizedPos === "DETERMINER" ||
      normalizedPos === "PRONOUN" ||
      normalizedPos === "PREPOSITION" ||
      normalizedPos === "CONJUNCTION"
    ) {
      groupScore += 60;
    } else if (normalizedPos === "OBSCURE") {
      // Obscure / symbol / proper-noun tags are strongly penalized
      groupScore -= 120;
    } else {
      groupScore += 10;
    }

    // Contextual POS boost
    if (expectedPos && normalizedPos === expectedPos) {
      groupScore += Math.round(150 * (confidence || 0.8));
    }

    // Evaluate senses within this group
    let bestSense: Sense | null = null;
    let bestSenseScore = -999;

    if (group.senses && group.senses.length > 0) {
      for (const sense of group.senses) {
        const sScore = scoreSenseQuality(sense, options?.contextSentence);
        if (sScore > bestSenseScore) {
          bestSenseScore = sScore;
          bestSense = sense;
        }
      }
    }

    groupScore += bestSenseScore > 0 ? bestSenseScore : 0;

    scoredGroups.push({
      group,
      score: groupScore,
      bestSense,
      bestSenseScore,
    });
  }

  // Sort groups descending by total score
  scoredGroups.sort((a, b) => b.score - a.score);

  const winning = scoredGroups[0];
  if (!winning || !winning.group) {
    return null;
  }

  const primaryGroup = winning.group;
  const primarySense = winning.bestSense || primaryGroup.senses?.[0];

  // Meaning precedence (owner brief 2026-10-24). A sense's own translationVi is now set only when a source wrote it
  // for that sense, so it wins when the sentence context picked that sense; otherwise the word's general meaning
  // leads (it used to be shadowed by a sense text paired by position: "excitement → khó chịu"), then the bundled
  // dictionary's first meaning of the chosen part of speech, then the English definition.
  const senseVi = cleanMeaning(primarySense?.translationVi);
  const contextual = !!expectedPos && confidence >= 0.75;
  const localVi = vietnameseMeaningsFor(canonical, primaryGroup.partOfSpeech);
  const primaryMeaning =
    (contextual && senseVi) ||
    cleanMeaning(canonical.generalTranslationVi) ||
    senseVi ||
    localVi[0] ||
    primarySense?.definitionEn ||
    "";

  // Other meanings: the dictionary's Vietnamese senses (chosen part of speech first), else aligned sense texts, else
  // English definitions. Index 0 is the primary meaning itself: the cards list `additionalMeanings.slice(1)`.
  const additionalMeanings: string[] = [primaryMeaning];
  const addMeaning = (candidate: string | undefined) => {
    const c = cleanMeaning(candidate);
    if (c && !c.startsWith("{") && !c.startsWith("<") && !additionalMeanings.some((m) => sameMeaning(m, c))) {
      additionalMeanings.push(c);
    }
  };
  localVi.forEach(addMeaning);
  for (const sg of scoredGroups) {
    for (const s of sg.group.senses || []) addMeaning(s.translationVi);
  }
  if (additionalMeanings.length === 1) {
    for (const sg of scoredGroups) {
      for (const s of sg.group.senses || []) addMeaning(s.definitionEn);
    }
  }

  // Clean formatted part of speech label
  const posDisplay = primaryGroup.partOfSpeech
    ? primaryGroup.partOfSpeech.trim().toLowerCase()
    : undefined;

  // Best pronunciation
  const ipa = canonical.pronunciations?.[0]?.ipa;

  return {
    word: headword,
    ipa: ipa ? (ipa.startsWith("/") ? ipa : `/${ipa}/`) : undefined,
    partOfSpeech: posDisplay,
    vietnameseMeaning: primaryMeaning,
    additionalMeanings: additionalMeanings.length > 1 ? additionalMeanings.slice(0, 6) : undefined,
    englishDefinition: primarySense?.definitionEn,
    example: primarySense?.examples?.[0],
  };
}

function cleanMeaning(value: string | undefined | null): string {
  return (value ?? "").trim();
}

function sameMeaning(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[.;,\s]+$/u, "").trim();
  return norm(a) === norm(b);
}

/**
 * The bundled dictionary's Vietnamese senses of an entry: those of `partOfSpeech` first (matched by its normalized
 * category), then the other parts of speech, in the dictionary's own order. Empty when the entry carries none.
 */
export function vietnameseMeaningsFor(entry: CanonicalDictionaryEntry, partOfSpeech?: string): string[] {
  const groups = entry.vietnameseSenses ?? [];
  if (groups.length === 0) return [];
  const wanted = partOfSpeech ? normalizePosString(partOfSpeech) : null;
  const matching = wanted && wanted !== "OTHER" && wanted !== "OBSCURE"
    ? groups.filter((g) => normalizePosString(g.partOfSpeech) === wanted)
    : [];
  const ordered = [...matching, ...groups.filter((g) => !matching.includes(g))];
  return ordered.flatMap((g) => g.meanings ?? []).map((m) => m.trim()).filter((m) => m.length > 0);
}

/**
 * The Vietnamese meaning a "Lưu Flashcard" button saves for an entry (one rule for every save button): the word's
 * general meaning, else a sense text the source wrote for the first sense, else the dictionary's first meaning. Null
 * when the entry has no Vietnamese meaning (the caller then saves its English definition, as before).
 */
export function flashcardMeaningVi(entry: CanonicalDictionaryEntry): string | null {
  const first = entry.partsOfSpeech?.[0];
  return (
    cleanMeaning(entry.generalTranslationVi) ||
    cleanMeaning(first?.senses?.[0]?.translationVi) ||
    vietnameseMeaningsFor(entry, first?.partOfSpeech)[0] ||
    null
  );
}
