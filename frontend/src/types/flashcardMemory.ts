/** Echo Memory Tides 2.0 (owner brief 2026-11-12) — shapes of `/flashcards/memory/**` and `/flashcards/studio/drafts`. */

/** Card Alchemy: a collectible look from persisted evidence, never the review schedule. */
export type MemoryTier = "RAW" | "SILVER" | "PRISM" | "PEARL";

export interface CardTier {
  flashcardId: number;
  tier: MemoryTier;
  loggedReviews: number;
  recallDays: number;
  pearlOn: string | null;
  /** Khó on at least two different days within 30 days and not found easy since. */
  weak: boolean;
}

export interface VaultCard {
  flashcardId: number;
  word: string;
  meaning: string | null;
  status: string;
  tier: MemoryTier;
  loggedReviews: number;
  recallDays: number;
  hardDays: number;
  pearlOn: string | null;
}

export interface FusionLink {
  id: number;
  firstCardId: number;
  secondCardId: number;
  firstWord: string;
  secondWord: string;
  sentence: string;
  feedbackVi: string | null;
  createdAt: string;
}

/** Which evidence a milestone rests on (never mixed). */
export type MilestoneEvidence = "REVIEW_HISTORY" | "SELF_RATED_RECALL" | "VERIFIED_USAGE";

export interface ReefMilestone {
  key: string;
  evidence: MilestoneEvidence;
  target: number;
  value: number;
  /** The local day the milestone was reached (computed from the data, so stable), or null. */
  reachedOn: string | null;
}

export interface MemoryOverview {
  tiers: { raw: number; silver: number; prism: number; pearl: number; total: number };
  reef: {
    reviewDays: number;
    loggedReviews: number;
    pearls: number;
    fusions: number;
    milestones: ReefMilestone[];
    firstLoggedDay: string | null;
  };
  vault: VaultCard[];
  weak: VaultCard[];
  synapses: FusionLink[];
  /** Cards with progress stored before the rating log existed (V116): kept as it is, no review days invented. */
  practisedBeforeLog?: number;
  today: string;
}

export interface FusionCandidate {
  firstCardId: number;
  firstWord: string;
  secondCardId: number;
  secondWord: string;
  relation: "SHARED_EXAMPLE";
  /** A real example sentence with both words — shown only after the learner's own attempt. */
  reference: string;
}

export interface FusionResult {
  verdict: "ACCEPTED" | "NEEDS_WORK" | "UNCERTAIN";
  accepted: boolean;
  newlyLinked: boolean;
  feedbackVi: string | null;
  suggestionEn: string | null;
}

export type ForgeMode = "EXPLAIN" | "EXAMPLE" | "MNEMONIC" | "BREAKDOWN";

export interface ForgeResult {
  flashcardId: number;
  word: string;
  storedMeaning: string;
  mode: ForgeMode;
  title: string | null;
  paragraphs: string[];
  prompts: Array<{ q: string; a: string }>;
  aiGenerated: true;
}

export type StudioLevel = "ANY" | "A2" | "B1" | "B2" | "C1";

export interface StudioCard {
  draftId: string;
  term: string;
  kind: "WORD" | "COLLOCATION" | "PHRASAL_VERB" | "IDIOM" | "PHRASE";
  partOfSpeech: string | null;
  sourceSentence: string;
  meaningVi: string;
  definitionEn: string | null;
  sentenceVi: string | null;
  /** From the shared dictionary only, else null (never generated). */
  ipa: string | null;
  cefr: string | null;
  dictionaryMeaningVi: string | null;
  alreadySaved: boolean;
}

export interface StudioResult {
  cards: StudioCard[];
  dropped: number;
}
