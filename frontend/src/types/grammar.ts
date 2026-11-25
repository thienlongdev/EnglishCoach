/** Echo Grammar Academy. Shapes mirror backend `GrammarDtos` and the content schema (docs/grammar/CONTENT-SCHEMA.md). */
export type Level = 'preA1' | 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export interface GrammarCapabilities { professorAvailable: boolean }
export type Bilingual = { vi: string; en: string };
export type LearningRole = 'core' | 'advanced' | 'reference' | 'application';
export type RoleTag = 'S' | 'V' | 'AUX' | 'MOD' | 'O' | 'C' | 'A' | 'T' | 'DET' | 'N' | 'ADJ' | 'ADV' | 'PREP' | 'CL' | 'SUB' | 'COND' | 'RES' | 'FOCUS' | 'NEG' | 'Q' | 'REF';

export interface CatalogTopic {
  slug: string; title: Bilingual; level: Level; available: boolean; prerequisites: string[];
  learningRole?: LearningRole;
  version?: number; order?: number; kind?: 'grammar' | 'application'; subtitle?: Bilingual | null; aliases?: string[];
  levelBasis?: 'EGP' | 'BC' | 'editorial'; uses?: { level: Level; vi: string }[];
  related?: { slug: string; rel: string }[]; exam?: { ielts: boolean; toeic: boolean }; mistakes?: string[];
  exerciseCount?: number; checkItems?: number; types?: Record<string, number>; diagrams?: string[]; status?: 'drafted' | 'reviewed'; path?: number;
}
export interface CatalogDomain { id: string; order: number; tone: string; kind: 'grammar' | 'application'; title: Bilingual; summary: Bilingual; topics: CatalogTopic[] }
export interface Catalog {
  schema: number; revision: string;
  counts: { planned: number; topics: number; reviewed: number; exercises: number; stories: number; lab: number; detective: number; levels: Record<string, number> };
  domains: CatalogDomain[];
  stories: { id: string; title: string; summary: string; level: Level; topics: string[]; scene: string }[];
  lab: { id: string; title: string; summary: string; level: Level; topics: string[]; kind: 'switchboard' | 'arrange' }[];
  detective: { id: string; title: string; level: Level; topics: string[]; brief: string }[];
}

export type DiagramSpec =
  | { kind: 'timeline'; sentence: string; now?: number; events: { kind: 'point' | 'span' | 'repeat' | 'open'; at?: number; from?: number; to?: number; label: string; role?: 'main' | 'ref' | 'ghost' }[] }
  | { kind: 'tree'; bracket: string }
  | { kind: 'transform'; steps: { label: string; sentence: string }[]; changed?: string[] }
  | { kind: 'branch'; root: string; branches: { cond: string; result: string; world: 'real' | 'unreal' | 'past-unreal' | 'mixed'; note?: string }[] }
  | { kind: 'agent'; agent: string; action: string; patient: string; active: string; passive: string; note?: string }
  | { kind: 'reference'; text: string; wrong?: boolean; note?: string }
  | { kind: 'scale'; from: string; to: string; items: { pos: number; t: string; en?: string; vi?: string }[] }
  | { kind: 'slots'; slots: { label: string; items: string[] }[]; sentence?: string; fixedOrder?: boolean }
  | { kind: 'clauses'; tree: ClauseNode }
  | { kind: 'matrix'; rows: string[]; cols: string[]; cells: { t: string; note?: string; off?: boolean }[][] }
  | { kind: 'flow'; start: string; nodes: Record<string, FlowNode> };
export interface ClauseNode { t?: string | null; kind: 'main' | 'sub' | 'rel' | 'noun' | 'cond'; label?: string; children?: ClauseNode[] }
export type FlowNode =
  | { q: string; yes: string; no: string }
  | { q: string; choices: { t: string; to: string }[] }
  | { end: string; note?: string };

export interface ExampleItem { en: string; vi: string; note?: string; tag?: 'BrE' | 'AmE' | 'formal' | 'informal' | 'spoken' | 'written' }
export type Block =
  | { type: 'p' | 'h'; vi: string }
  | { type: 'formula'; parts?: { t: string; role?: RoleTag }[]; lines?: { label?: string; parts: { t: string; role?: RoleTag }[] }[]; note?: string }
  | { type: 'examples'; items: ExampleItem[] }
  | { type: 'contrast'; labelA?: string; labelB?: string; items: { a: { en: string; vi: string }; b: { en: string; vi: string }; diff: string; aBad?: boolean; bBad?: boolean }[] }
  | { type: 'table'; head: string[]; rows: string[][]; caption?: string }
  | { type: 'note'; kind: 'tip' | 'warn' | 'register' | 'regional' | 'vn'; vi: string }
  | { type: 'diagram'; spec: DiagramSpec; caption: string; alt: string }
  | { type: 'try'; exercise: string };

export interface Topic {
  slug: string; version: number; domain: string; kind: string; title: Bilingual; subtitle?: Bilingual;
  aliases: string[]; level: Level; levelBasis: string; uses?: { level: Level; vi: string }[]; objectives: string[];
  prerequisites?: string[]; related?: { slug: string; rel: string }[]; exam?: { ielts?: string | null; toeic?: string | null };
  quick: { what: string; when: string; examples: { en: string; vi: string }[]; remember?: string };
  lesson: Block[]; deep: Block[];
  mistakes: { id: string; wrong: string; right: string; why: string; vn?: string }[];
  faq: { q: string; a: string }[];
  exercises: Exercise[];
  sources: { ref: string; note?: string }[];
  editorial: { status: 'drafted' | 'reviewed' };
}

/** What a learner sees before answering: no keys, notes or explanations. */
export interface Exercise {
  id: string; type: 'choice' | 'multi' | 'cloze' | 'order' | 'transform' | 'error' | 'match' | 'classify' | 'open';
  level: Level; use: 'practice' | 'check' | 'both'; skill: string; prompt: string; context?: string; turns?: { who: string; t: string }[];
  stem?: string; end?: string; source?: string; instruction?: string; task?: string;
  options?: { i: number; t?: string; diagram?: DiagramSpec }[];
  blanks?: Record<string, { hint?: string }>;
  tokens?: string[];
  segments?: { t: string }[];
  left?: string[]; right?: string[];
  cats?: string[]; items?: { i: number; t: string }[];
}
export type Answer =
  | { choice: number } | { choices: number[] } | { blanks: Record<string, string> } | { seq: string[] } | { text: string }
  | { picked: number[]; none?: boolean } | { pairs: Record<string, string> } | { cats: Record<string, string> };

export type Outcome = 'CORRECT' | 'ACCEPTABLE' | 'PARTIAL' | 'WRONG' | 'UNRECOGNIZED' | 'SELF_REVIEW';
export interface Reveal {
  options?: { i: number; ok: boolean; note: string }[];
  parts?: { key: string; outcome: Outcome; note?: string; expected: string[] }[];
  accept?: string[] | string[][]; note?: string; model?: string | string[]; checklist?: string[];
  noError?: boolean; segments?: { i: number; bad: boolean; style?: boolean; note?: string; fix?: string[] }[];
  pairs?: { i: number; ok: boolean; b: string }[]; items?: { i: number; ok: boolean; cat: string }[]; unanswered?: boolean;
}
export interface Verdict { exerciseId: string; outcome: Outcome; score: number | null; explain: string; reveal: Reveal; tags: string[] }

export type TopicStatus = 'OPENED' | 'STUDIED' | 'PRACTISING' | 'READY' | 'MASTERED' | 'REVIEW_DUE' | 'NEEDS_REVIEW';
export interface TopicState {
  slug: string; status: TopicStatus; firstOpenedAt: string; studiedAt: string | null; practiceScored: number; practiceCorrectPct: number | null;
  lastCheckPct: number | null; bestCheckPct: number | null; lastCheckAt: string | null; masteredAt: string | null; reviewDueAt: string | null; needsReview: boolean; reviewStage: number;
}
export type RecommendationReason = 'REVIEW_DUE' | 'READY_FOR_CHECK' | 'CONTINUE' | 'NEXT_ON_PATH';
export interface GrammarMe {
  startLevel: Level | null; startBasis: 'DIAGNOSTIC' | 'SELF' | null; states: TopicState[]; bookmarks: string[];
  next: { slug: string; reason: RecommendationReason }[]; dueReviews: string[];
  counts: { opened: number; studied: number; practising: number; mastered: number; due: number; attempts30d: number; bookmarks: number };
}
export type CheckKind = 'TOPIC' | 'REVIEW' | 'DIAGNOSTIC' | 'DOMAIN' | 'IELTS' | 'TOEIC';
export interface CheckItemResult { exerciseId: string; topic: string; outcome: Outcome; score: number | null; explain: string; reveal: Reveal; answer?: Answer | null }
export interface CheckResult {
  pct: number; scoredItems: number; unscoredItems: number; enoughEvidence: boolean;
  mastery: 'MASTERED' | 'NOT_YET' | 'NEEDS_REVIEW' | 'KEPT' | 'INSUFFICIENT' | null; nextReviewAt: string | null;
  suggestedLevel: Level | null; levels: { level: Level; scored: number; pct: number }[]; items: CheckItemResult[];
  productionScored?: number; productionCorrect?: number; productionRequired?: number;
}
export interface CheckView { id: string; kind: CheckKind; scope: string | null; startedAt: string; exercises: Exercise[]; submitted: boolean; result: CheckResult | null }
export interface CheckSummary { id: string; kind: CheckKind; scope: string | null; startedAt: string; submittedAt: string | null; pct: number | null; scoredItems: number | null }
export interface MistakeGroup { tag: string; count: number; lastAt: string; topic: string; exerciseId: string; lastAnswer: string | null; recent30d: number }
export interface MistakesView { groups: MistakeGroup[]; windowDays: number; totalWrong: number }
export interface PracticeSet { exercises: Exercise[]; note: 'NO_MISTAKES' | 'NO_ITEMS' | null }
export interface ProfessorAnswer { answer: string; examples: { en: string; vi: string }[]; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; ai: boolean }

export interface StoryBeat {
  id: string; scene?: string; narrate?: string; say?: { who: string; en: string; vi: string }[];
  choice?: { prompt: string; options: { t: string; note: string; ok?: boolean; next?: string; consequence?: string }[] };
  explain?: Block[]; next?: string; end?: boolean;
}
export interface Story { id: string; title: string; summary: string; level: Level; topics: string[]; scene: string; cast: { id: string; name: string; role: string }[]; beats: StoryBeat[] }
export interface LabExperiment {
  id: string; title: string; summary: string; level: Level; topics: string[]; kind: 'switchboard' | 'arrange';
  axes?: { id: string; label: string; values: { id: string; label: string }[] }[];
  results?: Record<string, { en: string; vi?: string; note: string; verdict: 'ok' | 'odd' | 'bad'; timeline?: Omit<Extract<DiagramSpec, { kind: 'timeline' }>, 'kind'> }>;
  tokens?: string[]; orders?: { seq: string[]; verdict: 'ok' | 'odd' | 'bad'; note: string; effect?: string }[];
}
export interface DetectiveCase {
  id: string; title: string; level: Level; topics: string[]; brief: string;
  paragraph: { t: string; bad?: boolean; fix?: string[]; cat?: string; note?: string; tag?: string; style?: boolean; decoy?: boolean }[];
}
