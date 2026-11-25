// What a flashcard shows, from the card as stored (owner brief 2026-10-18).
// - The learner's own meaning / example saved with the card (V101 `customMeaning` / `customExample`) come first.
// - Old Anki imports stored a note number as the word ("2_29"), the word as the meaning ("scarf") and the
//   transcription as the example ("[skɑːf]"). They are shown as word / IPA here, without changing the stored data.
// - Filler some save paths wrote instead of leaving a field empty is never shown as content.

export interface CardFaceEntry {
  word?: string;
  ipa?: string;
  cefr?: string;
  generalTranslationVi?: string;
  meanings?: (string | null)[];
  examples?: (string | null)[];
}

/** The sense a curated topic deck teaches (V106): one meaning, one example and its Vietnamese translation. */
export interface CardFaceDeckSense {
  definitionEn?: string | null;
  sourceKind?: string | null;
  referenceLevel?: string | null;
  referenceIpa?: string | null;
  partOfSpeech?: string | null;
  meaningVi?: string | null;
  example?: string | null;
  exampleVi?: string | null;
}

export interface CardFaceSource {
  dictionaryEntry?: CardFaceEntry | null;
  customMeaning?: string | null;
  customExample?: string | null;
  /** The contextual sense approved in Echo AI Card Studio (V117). */
  customDefinition?: string | null;
  customPartOfSpeech?: string | null;
  customExampleVi?: string | null;
  deckSense?: CardFaceDeckSense | null;
}

export interface CardFace {
  word: string;
  ipa: string | null;
  cefr: string | null;
  /** The main meaning (the learner's, else Vietnamese, else the first English definition); null when none. */
  headline: string | null;
  /** True when the headline is a meaning (Vietnamese or the learner's own), false for an English definition. */
  headlineVi: boolean;
  /** Language of the headline when known ("vi" stored translation, "en" English definition); the learner's text: unknown. */
  headlineLang: "vi" | "en" | undefined;
  /** Further English definitions (at most 3). */
  definitions: string[];
  /** At most 2 example sentences. */
  examples: string[];
  /** The Vietnamese translation of each example (same index), null when none is stored. */
  exampleTranslations: (string | null)[];
  /** Part of speech of the taught sense (curated topic decks), e.g. "noun"; null when unknown. */
  partOfSpeech: string | null;
}

const IDENTIFIER = /^[0-9]+(?:[_.:/-][0-9]+)*$/;
const IPA_LIKE = /^[[/][^[\]/0-9]{1,60}[\]/]$/;
const WORD_LIKE = /^[A-Za-z][A-Za-z' -]{0,58}[A-Za-z.!?]?$/;
const FILLER = new Set(["no definition", "imported custom flashcard", "custom example", "imported from anki deck", "reading example"]);

export function looksLikeIpa(value: string): boolean {
  return IPA_LIKE.test(value.trim());
}

const clean = (values: (string | null | undefined)[] | undefined): string[] =>
  (values ?? []).map((v) => (v ?? "").trim()).filter((v) => v.length > 0 && !FILLER.has(v.toLowerCase()));

export function cardFace(card: CardFaceSource): CardFace {
  const entry = card.dictionaryEntry ?? {};
  let word = (entry.word ?? "").trim();
  let ipa = (entry.ipa ?? "").trim() || card.deckSense?.referenceIpa || null;
  let meanings = clean(entry.meanings);
  let examples = clean(entry.examples);

  // a transcription stored as an example is the IPA
  const ipaExample = examples.find(looksLikeIpa);
  if (ipaExample) {
    if (!ipa) ipa = ipaExample;
    examples = examples.filter((e) => !looksLikeIpa(e));
  }
  // legacy import: a note number in the word field and the real word as the first "meaning"
  if (IDENTIFIER.test(word) && meanings.length > 0 && WORD_LIKE.test(meanings[0])) {
    word = meanings[0];
    meanings = meanings.slice(1);
  }

  // a curated topic deck teaches ONE sense: its meaning, example and translation replace the dictionary row's senses,
  // which may describe other senses of the word (owner brief 2026-10-30)
  const sense = card.deckSense ?? null;
  const senseMeaning = (sense?.meaningVi ?? "").trim();
  const senseExample = (sense?.example ?? "").trim();
  const translations = new Map<string, string>();
  if (senseMeaning) {
    meanings = clean([sense?.definitionEn]);
    examples = senseExample ? [senseExample] : [];
    const senseExampleVi = (sense?.exampleVi ?? "").trim();
    if (senseExample && senseExampleVi) translations.set(senseExample, senseExampleVi);
  }

  const customMeaning = (card.customMeaning ?? "").trim();
  const customExample = (card.customExample ?? "").trim();
  // a contextual sense approved in Echo AI Card Studio (V117) is the whole card: its meaning, its definition, its example and
  // translation — the dictionary row's other senses (e.g. "struggle" as a noun next to a verb sense) are not shown
  const contextDefinition = (card.customDefinition ?? "").trim();
  const contextPos = (card.customPartOfSpeech ?? "").trim();
  const contextual = !!customMeaning && !FILLER.has(customMeaning.toLowerCase()) && !!(contextDefinition || contextPos);
  if (contextual) {
    meanings = contextDefinition ? [contextDefinition] : [];
    examples = [];
    translations.clear();
    const contextExampleVi = (card.customExampleVi ?? "").trim();
    if (customExample && contextExampleVi) translations.set(customExample, contextExampleVi);
  }
  if (customExample && !looksLikeIpa(customExample)) {
    examples = [customExample, ...examples.filter((e) => e !== customExample)];
  }

  const translationVi = senseMeaning || (entry.generalTranslationVi ?? "").trim();
  let headline: string | null;
  let headlineVi: boolean;
  let headlineLang: "vi" | "en" | undefined;
  let definitions: string[];
  if (customMeaning && !FILLER.has(customMeaning.toLowerCase())) {
    headline = customMeaning;
    headlineVi = true;
    headlineLang = undefined;
    definitions = meanings.filter((m) => m !== customMeaning);
  } else if (translationVi) {
    headline = translationVi;
    headlineVi = true;
    headlineLang = "vi";
    definitions = meanings;
  } else {
    headline = meanings[0] ?? null;
    headlineVi = false;
    headlineLang = "en";
    definitions = meanings.slice(1);
  }

  return {
    word,
    ipa,
    cefr: (sense?.sourceKind ? sense.referenceLevel : entry.cefr)?.trim() || null,
    headline,
    headlineVi,
    headlineLang,
    definitions: definitions.slice(0, 3),
    examples: examples.slice(0, 2),
    exampleTranslations: examples.slice(0, 2).map((e) => translations.get(e) ?? null),
    partOfSpeech: contextual ? contextPos || null : senseMeaning ? (sense?.partOfSpeech ?? "").trim() || null : null,
  };
}
