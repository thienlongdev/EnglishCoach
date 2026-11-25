import type { Pos } from './inflect';
import type { Category, Method, RelationType, Status } from './ontology';

/** GET /api/v1/cosmos/overlay — the learner's own evidence (times: epoch ms). */
export interface Overlay {
  extractorVersion: number; generatedAt: number;
  words: { cardId: number; word: string; status: string; createdAt: number; meaning: string | null; partOfSpeech: string | null;
    definition: string | null; deckSlug: string | null; deckTitle: string | null; deckCategory: string | null; reviewCount?: number;
    /** The card's next review as the Flashcards scheduler stored it (absent from older servers, null when none). */
    dueAt?: number | null }[];
  wordsTruncated: boolean;
  reviews: { cardId: number; q: 'hard' | 'good' | 'easy'; at: number }[];
  reviewsTruncated: boolean;
  grammar: { slug: string; firstOpenedAt: number; studiedAt: number | null; bestCheckPct: number | null; masteredAt: number | null; needsReview: boolean }[];
  sources: { kind: SourceKind; id: number | string; title: string; at: number; system: boolean; tokens: string }[];
}
/** MY_BOOKS is added on the device from the account's own IndexedDB (highlighted passages); it never reaches the server. */
export type SourceKind = 'READING' | 'LISTENING' | 'WRITING' | 'SPEAKING' | 'MY_BOOKS';

/** What the builder needs from the Grammar Academy catalog. */
export interface GrammarTopicLite { slug: string; domain: string; vi: string; en: string; level: string; prerequisites: string[]; related: { slug: string; rel: string }[] }
export interface GrammarDomainLite { id: string; vi: string; en: string }

export const SKILL = { flashcard: 1, reading: 2, listening: 4, writing: 8, speaking: 16, grammar: 32 } as const;

export type NodeKind = 'word' | 'grammar' | 'source' | 'concept';

export interface CosmosNode {
  i: number; id: string; kind: NodeKind; label: string;
  /** Vietnamese meaning on the card / topic title / source title / concept gloss. */
  sub: string;
  galaxy: number; constellation: number; system: number;
  x: number; y: number; z: number; size: number;
  /** First server-recorded encounter (card created, topic opened, source completed). Concepts: first member's time. */
  discoveredAt: number;
  skills: number;
  /** Card status (best of the word's cards) or grammar state; '' for sources / concepts. */
  status: string;
  /**
   * Learning stage from recorded evidence only (never inferred from absence): discovered (grammar topic opened), saved (own card,
   * not studied yet), studied (rated / reviewed / status above NEW; grammar lesson studied), practiced (the word occurs in your
   * own writing or speech — not a correctness judgement), mastered (card status MASTERED from your own "Dễ"; grammar mastered by
   * the Academy's check). "Demonstrated" is never claimed: no recorded evidence says a use was correct. '' for sources / concepts.
   */
  stage: '' | 'discovered' | 'saved' | 'studied' | 'practiced' | 'mastered';
  /** Source evidence of a word [time, skill bit]: completed reading / listening / My Books, own writing / speech (oldest first). */
  touches: [number, number][];
  /** Ratings [time, 0 hard | 1 good | 2 easy], oldest first (only since V116 logging). */
  ratings: [number, number][];
  weak: boolean; gap: boolean;
  pos: Pos[]; anchorSense: number;
  cardIds: number[]; decks: string[];
  /**
   * Memory Tides schedule (the authoritative scheduler, read as stored): the earliest next review among the word's studied,
   * not-mastered cards (0 = none stored), and the cards' total review counter. Never predicted here.
   */
  dueAt: number; reviewCount: number;
  frontier: { lemma: string; type: RelationType; sense: number; via: number }[];
  ref: string; // deep-link reference: word, grammar slug, source kind:id, concept synset
  degree: number;
}

export interface CosmosEdge {
  i: number; id: string; s: number; t: number; type: RelationType; status: Status; method: Method; category: Category;
  /** Sense pairs [source sense, target sense] for lexical edges (best first). */
  scopes: [number, number][];
  /** True when a scope matches the part of speech on both words' cards (or a card has none). */
  posMatch: boolean;
  /** True when some scope uses one of the 3 most common senses (per part of speech) of BOTH words. Rare-sense relations stay
   *  in the graph but are shown only on request ("Mọi nghĩa"): true, yet rarely what a learner means. */
  common: boolean;
  steps: number;            // hypernym chain length for a concept link (1 = direct)
  forms: string[];          // matched word forms (source edges)
  words: number[];          // transfer: the words carried through the wormhole
  note: string;             // grammar catalog relation name, suggestion path
  at: number;               // when both ends were known
}

export interface Community {
  i: number; kind: 'galaxy' | 'constellation' | 'system'; key: string; vi: string; en: string;
  galaxy: number; constellation: number; color: string;
  x: number; y: number; z: number; radius: number; count: number; createdAt: number;
  center: number; // node index or -1
}

export interface CosmosEvent {
  t: number;
  type: 'NODE_DISCOVERED' | 'EVIDENCE_ADDED' | 'MASTERY_CHANGED' | 'EDGE_VERIFIED' | 'CLUSTER_CREATED';
  node: number; edge: number; community: number; detail: string;
}

export interface CosmosGraph {
  lexiconVersion: string; extractorVersion: number; generatedAt: number;
  nodes: CosmosNode[]; edges: CosmosEdge[];
  galaxies: Community[]; constellations: Community[]; systems: Community[];
  events: CosmosEvent[];
  truncated: { words: boolean; reviews: boolean };
  /** Edges suppressed by the precision rules, with counts (so a test or the legend can show they exist). */
  withheld: Record<string, number>;
}
