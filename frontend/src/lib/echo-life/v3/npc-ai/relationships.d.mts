/** Types for the vendored V3 relationships module (verbatim copy, see ../PROVENANCE.tsv). */
import type { V3State, V3Rel } from '../game-core/index.mjs';
export function createRelationship(npcId: string): V3Rel;
export function ensureRelationship(s: V3State, npcId: string): V3Rel;
export function getRelationshipTier(rel: V3Rel): string;
export function adjustRelationship(s: V3State, npcId: string, deltas?: Record<string, number>, memory?: unknown): void;
export function checkExpiredInvites(s: V3State): void;
export function latestMemoryNote(rel: V3Rel): { type: string; detail: string } | null;
