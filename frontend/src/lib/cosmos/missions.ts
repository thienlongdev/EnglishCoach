/**
 * Constellation Reconstruction: some verified relations of a star system are hidden; the learner joins pairs and names the
 * relation. Validation uses the typed graph only (never distance on screen). Practice: it records nothing and grants nothing.
 */
import type { RelationType } from './ontology';
import type { CosmosGraph } from './types';

export interface Puzzle { system: number; words: number[]; answers: { s: number; t: number; type: RelationType; edge: number }[] }
const PLAYABLE: RelationType[] = ['SYNONYM_OF', 'SIMILAR_TO', 'ANTONYM_OF', 'HYPERNYM_OF', 'PART_OF', 'DERIVED_FORM'];

export function puzzles(graph: CosmosGraph, limit = 12): Puzzle[] {
  const bySystem = new Map<number, Puzzle>();
  for (const e of graph.edges) {
    if (e.status !== 'VERIFIED' || !PLAYABLE.includes(e.type) || e.note === 'concept') continue;
    const s = graph.nodes[e.s], t = graph.nodes[e.t];
    if (s.kind !== 'word' || t.kind !== 'word') continue;
    const key = s.constellation === t.constellation ? s.system : -1 - s.constellation;
    let p = bySystem.get(key);
    if (!p) { p = { system: s.system, words: [], answers: [] }; bySystem.set(key, p); }
    p.answers.push({ s: e.s, t: e.t, type: e.type, edge: e.i });
    for (const w of [e.s, e.t]) if (!p.words.includes(w)) p.words.push(w);
  }
  return [...bySystem.values()].filter(p => p.answers.length >= 2 && p.words.length <= 10)
    .sort((a, b) => b.answers.length - a.answers.length).slice(0, limit);
}

/** Checks one learner link: correct only if that exact typed relation exists (direction matters for directed types). */
export function check(p: Puzzle, s: number, t: number, type: RelationType): 'correct' | 'wrong-type' | 'no-relation' {
  // Two words can have several relations (e.g. synonyms in one sense AND one family): any exact match is correct.
  const hits = p.answers.filter(a => (a.s === s && a.t === t) || (a.s === t && a.t === s));
  if (!hits.length) return 'no-relation';
  const directed = type === 'HYPERNYM_OF' || type === 'PART_OF';
  return hits.some(h => h.type === type && (!directed || h.s === s)) ? 'correct' : 'wrong-type';
}

/**
 * Cross-skill missions: use a word you studied in a skill where it has no evidence yet. A mission is DONE only when the
 * server's evidence shows it: a source of the target kind recorded AFTER the mission started contains a form of the word
 * (your writing / speech for WRITING / SPEAKING, a completed lesson for READING / LISTENING). Opening an activity completes
 * nothing; there is no reward, score or mastery change. The start time is kept per account on this device only.
 */
export type MissionTarget = 'WRITING' | 'SPEAKING' | 'LISTENING' | 'READING';
export interface SkillMission { word: string; target: MissionTarget; startedAt: number }
export interface MissionState { mission: SkillMission; node: number; done: boolean; evidence: number }

const TARGET_BIT: Record<MissionTarget, number> = { WRITING: 8, SPEAKING: 16, LISTENING: 4, READING: 2 };

/** Words studied (not just saved) with no evidence yet in the target skill, most practised first. */
export function missionCandidates(graph: CosmosGraph, target: MissionTarget, limit = 6): number[] {
  return graph.nodes.filter(n => n.kind === 'word' && n.cardIds.length > 0 && n.stage !== 'saved' && (n.skills & TARGET_BIT[target]) === 0)
    .sort((a, b) => b.ratings.length - a.ratings.length || a.label.localeCompare(b.label)).slice(0, limit).map(n => n.i);
}

/** Evidence check: the newest source of the target kind, recorded after the start, containing the word (or -1). */
export function missionState(graph: CosmosGraph, m: SkillMission): MissionState {
  const node = graph.nodes.findIndex(n => n.kind === 'word' && n.label === m.word);
  let evidence = -1;
  if (node >= 0) for (const e of graph.edges) {
    if ((e.type !== 'APPEARS_IN_SOURCE' && e.type !== 'LEARNER_USED_IN') || e.t !== node) continue;
    const src = graph.nodes[e.s];
    if (src.sub === m.target && src.discoveredAt > m.startedAt && (evidence < 0 || src.discoveredAt > graph.nodes[evidence].discoveredAt)) evidence = e.s;
  }
  return { mission: m, node, done: evidence >= 0, evidence };
}

export function missionKey(userId: string) { return `ec_cosmos_missions:v1:u${userId}`; }
export function readMissions(userId: string): SkillMission[] {
  try {
    const raw = JSON.parse(localStorage.getItem(missionKey(userId)) || '[]');
    return Array.isArray(raw) ? raw.filter((m: SkillMission) => typeof m?.word === 'string' && TARGET_BIT[m.target] && Number.isFinite(m.startedAt)).slice(-12) : [];
  } catch { return []; }
}
export function writeMissions(userId: string, list: SkillMission[]) {
  try { localStorage.setItem(missionKey(userId), JSON.stringify(list.slice(-12))); } catch { /* optional */ }
}
