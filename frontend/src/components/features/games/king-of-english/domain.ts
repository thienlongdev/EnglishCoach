/** King domain only. No React, transport, storage, dictionary or cache ownership. */
export const KING_MODES = ['REFLEX', 'EXPLAIN', 'REORDER', 'CONQUEST'] as const;
export const PLAY_FLOWS = ['SOLO', 'ECHO', 'QUICK_MATCH', 'PRIVATE_ROOM'] as const;
export type KingMode = typeof KING_MODES[number];
export type PlayFlow = typeof PLAY_FLOWS[number];
export const CONTENT_STATES = ['DRAFT', 'AUTO_VALIDATED', 'REVIEW_REQUIRED', 'APPROVED', 'ACTIVE', 'REJECTED'] as const;
export type ContentStatus = typeof CONTENT_STATES[number];
export type AnswerPolicy = Readonly<{ case: 'INSENSITIVE' | 'EXACT'; punctuation: 'SENTENCE_MARKS' | 'EXACT' }>;
export type ReorderChallenge = Readonly<{
  id: string; mode: 'REORDER'; tokens: readonly string[]; canonicalAnswer: string;
  acceptedAnswers: readonly string[]; policy: AnswerPolicy; difficulty: number;
  cefr: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'; category: string;
  meaning: Readonly<{ vi: string; en: string }>; explanation: Readonly<{ vi: string; en: string }>;
  sourceKind: 'MANUALLY_AUTHORED_LOCAL_FIXTURE'; sourceRef: string; contentVersion: string;
  fingerprint: string; reviewStatus: ContentStatus;
  humanReview: Readonly<{ reviewer: string; reviewedAt: string }> | null;
}>;

export function normalizeAnswer(text: string, policy: AnswerPolicy): string {
  let value = text.trim().replace(/\s+/g, ' ');
  // Only sentence stops/commas are optional. Apostrophes and hyphens remain significant.
  if (policy.punctuation === 'SENTENCE_MARKS') value = value.replace(/[.,!?]/g, '').replace(/\s+/g, ' ').trim();
  return policy.case === 'INSENSITIVE' ? value.toLowerCase() : value;
}
function multiset(text: string, policy: AnswerPolicy) {
  return normalizeAnswer(text, policy).split(' ').sort().join('\u0000');
}
/** Non-security content checksum; contentVersion and sourceRef remain authoritative provenance. */
export function contentFingerprint(item: Pick<ReorderChallenge, 'tokens' | 'canonicalAnswer' | 'acceptedAnswers' | 'policy'>): string {
  const text = JSON.stringify([item.tokens, item.canonicalAnswer, item.acceptedAnswers, item.policy]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
export function validateBank(bank: readonly ReorderChallenge[]): readonly string[] {
  const errors: string[] = []; const ids = new Set<string>(); const semantics = new Set<string>();
  for (const item of bank) {
    const fail = (code: string) => errors.push(`${item.id || '?'}:${code}`);
    if (!item.id?.trim() || ids.has(item.id)) fail('DUPLICATE_OR_EMPTY_ID');
    ids.add(item.id);
    if (item.mode !== 'REORDER') fail('INVALID_MODE');
    if (!item.policy || !['INSENSITIVE', 'EXACT'].includes(item.policy.case) || !['SENTENCE_MARKS', 'EXACT'].includes(item.policy.punctuation)) { fail('INVALID_POLICY'); continue; }
    if (!Array.isArray(item.tokens) || item.tokens.length < 2 || item.tokens.length > 24 || item.tokens.some(t => typeof t !== 'string' || !t.trim())) { fail('MISSING_TOKENS'); continue; }
    if (typeof item.canonicalAnswer !== 'string' || !normalizeAnswer(item.canonicalAnswer, item.policy)) { fail('EMPTY_CANONICAL'); continue; }
    if (!['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(item.cefr)) fail('INVALID_CEFR');
    if (!Number.isInteger(item.difficulty) || item.difficulty < 1 || item.difficulty > 5) fail('INVALID_DIFFICULTY');
    if (!CONTENT_STATES.includes(item.reviewStatus)) fail('INVALID_STATUS');
    if (!item.sourceRef?.trim() || item.sourceKind !== 'MANUALLY_AUTHORED_LOCAL_FIXTURE' || !item.contentVersion?.trim()) fail('MISSING_PROVENANCE');
    if (!item.category?.trim() || !item.meaning?.vi?.trim() || !item.meaning?.en?.trim() || !item.explanation?.vi?.trim() || !item.explanation?.en?.trim()) fail('MISSING_LEARNING_CONTEXT');
    const tokens = multiset(item.tokens.join(' '), item.policy);
    if (multiset(item.canonicalAnswer, item.policy) !== tokens) fail('BROKEN_CANONICAL_TOKENS');
    const semantic = normalizeAnswer(item.canonicalAnswer, { case: 'INSENSITIVE', punctuation: 'SENTENCE_MARKS' });
    if (semantics.has(semantic)) fail('DUPLICATE_SEMANTIC'); semantics.add(semantic);
    if (!Array.isArray(item.acceptedAnswers) || item.acceptedAnswers.some(a => typeof a !== 'string' || !a.trim())) fail('MALFORMED_ACCEPTED_ANSWERS');
    else {
      const answers = new Set([normalizeAnswer(item.canonicalAnswer, item.policy)]);
      for (const answer of item.acceptedAnswers) {
        const normalized = normalizeAnswer(answer, item.policy);
        if (answers.has(normalized)) fail('DUPLICATE_ACCEPTED_ANSWER'); answers.add(normalized);
        if (multiset(answer, item.policy) !== tokens) fail('BROKEN_ACCEPTED_TOKENS');
      }
      if (item.fingerprint !== contentFingerprint(item)) fail('STALE_FINGERPRINT');
    }
    if (['APPROVED', 'ACTIVE'].includes(item.reviewStatus) && (!item.humanReview?.reviewer?.trim() || !item.humanReview.reviewedAt || !Number.isFinite(Date.parse(item.humanReview.reviewedAt)))) fail('MISSING_HUMAN_REVIEW');
    if (['APPROVED', 'ACTIVE'].includes(item.reviewStatus) && item.sourceKind === 'MANUALLY_AUTHORED_LOCAL_FIXTURE') fail('FIXTURE_CANNOT_BE_APPROVED');
  }
  return errors;
}
export function createContentProvider(bank: readonly ReorderChallenge[], kind: 'PRODUCTION' | 'LOCAL_FIXTURE', environment: string) {
  const errors = validateBank(bank);
  if (errors.length) throw new Error(`Invalid King content: ${errors.join(', ')}`);
  if (kind === 'LOCAL_FIXTURE' && environment !== 'development' && environment !== 'test') throw new Error('Local King fixtures are unavailable outside development/test');
  // Single immutable shared bank, lookup by ID; no per-session copy or mutable registry.
  const eligible = (item: ReorderChallenge) => kind === 'PRODUCTION'
    ? item.reviewStatus === 'ACTIVE' && item.humanReview !== null
    : item.reviewStatus === 'AUTO_VALIDATED';
  return Object.freeze({
    ids: Object.freeze(bank.filter(eligible).map(item => item.id)),
    get: (id: string) => bank.find(item => item.id === id && eligible(item)),
  });
}
export type ContentProvider = ReturnType<typeof createContentProvider>;
export function isPlayable(mode: KingMode, flow: PlayFlow, localPreview: boolean) {
  return localPreview && KING_MODES.includes(mode) && PLAY_FLOWS.includes(flow);
}

export type SoloSession = Readonly<{
  mode: 'REORDER'; flow: 'SOLO'; status: 'PLAYING' | 'FINISHED'; challengeIds: readonly string[];
  seed: number; index: number; selected: readonly number[]; score: number;
  feedback: 'NONE' | 'WRONG' | 'CORRECT' | 'REVEALED';
  results: readonly Readonly<{ challengeId: string; correct: boolean }>[];
}>;
export type SoloAction = { type: 'PLACE' | 'UNDO'; token: number } | { type: 'CLEAR' | 'SUBMIT' | 'REVEAL' | 'NEXT' };
export function startSession(provider: ContentProvider, seed: number): SoloSession {
  if (!provider.ids.length) throw new Error('No eligible King challenges');
  const start = (seed >>> 0) % provider.ids.length;
  const challengeIds = Object.freeze(Array.from({ length: Math.min(5, provider.ids.length) }, (_, i) => provider.ids[(start + i) % provider.ids.length]));
  return { mode: 'REORDER', flow: 'SOLO', status: 'PLAYING', challengeIds, seed: seed >>> 0, index: 0, selected: [], score: 0, feedback: 'NONE', results: [] };
}
export function shuffledTokenIds(item: ReorderChallenge, seed: number, index: number): readonly number[] {
  const ids = item.tokens.map((_, i) => i); let value = (seed ^ Math.imul(index + 1, 2654435761)) >>> 0;
  for (let i = ids.length - 1; i > 0; i--) { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; const j = value % (i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  // A rotation may itself be an explicit alternative. Try deterministic swaps.
  if (validateAnswer(item, ids)) {
    let found = false;
    for (let a = 0; a < ids.length && !found; a++) for (let b = a + 1; b < ids.length && !found; b++) {
      [ids[a], ids[b]] = [ids[b], ids[a]];
      if (!validateAnswer(item, ids)) found = true;
      else [ids[a], ids[b]] = [ids[b], ids[a]];
    }
  }
  return ids;
}
export function validateAnswer(item: ReorderChallenge, tokenIds: readonly number[]) {
  if (tokenIds.length !== item.tokens.length || new Set(tokenIds).size !== item.tokens.length || tokenIds.some(id => !Number.isInteger(id) || id < 0 || id >= item.tokens.length)) return false;
  const answer = normalizeAnswer(tokenIds.map(id => item.tokens[id]).join(' '), item.policy);
  return [item.canonicalAnswer, ...item.acceptedAnswers].some(candidate => normalizeAnswer(candidate, item.policy) === answer);
}
export function transitionSession(state: SoloSession, action: SoloAction, item: ReorderChallenge): SoloSession {
  if (state.status !== 'PLAYING' || item.id !== state.challengeIds[state.index]) return state;
  const settled = state.feedback === 'CORRECT' || state.feedback === 'REVEALED';
  if (action.type === 'NEXT') {
    if (!settled) return state;
    const index = state.index + 1;
    return { ...state, index, status: index === state.challengeIds.length ? 'FINISHED' : 'PLAYING', selected: [], feedback: 'NONE' };
  }
  if (settled) return state;
  if (action.type === 'PLACE') {
    if (!Number.isInteger(action.token) || action.token < 0 || action.token >= item.tokens.length || state.selected.includes(action.token)) return state;
    return { ...state, selected: [...state.selected, action.token], feedback: 'NONE' };
  }
  if (action.type === 'UNDO') return { ...state, selected: state.selected.filter(id => id !== action.token), feedback: 'NONE' };
  if (action.type === 'CLEAR') return { ...state, selected: [], feedback: 'NONE' };
  if (action.type === 'REVEAL') return { ...state, feedback: 'REVEALED', results: [...state.results, { challengeId: item.id, correct: false }] };
  if (state.selected.length !== item.tokens.length) return state;
  if (!validateAnswer(item, state.selected)) return { ...state, feedback: 'WRONG' };
  return { ...state, feedback: 'CORRECT', score: state.score + 10, results: [...state.results, { challengeId: item.id, correct: true }] };
}
