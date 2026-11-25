/** Types for the vendored V3 progression state module (verbatim copy, see ../PROVENANCE.tsv). */
import type { V3State, V3Progression, V3OwnedObject } from '../game-core/index.mjs';
export function createStarterOwnedObjects(owner: string): V3OwnedObject[];
export function createProgression(owner?: string, startingCredits?: number): V3Progression;
export function syncCredits(state: V3State): void;
export function resetDailyEconomyIfNeeded(state: V3State): void;
