/** Types for the vendored V3 skills module (verbatim copy, see ../PROVENANCE.tsv). */
import type { V3State } from '../game-core/index.mjs';
export function xpRequiredForPlayerLevel(level: number): number;
export function playerLevelFromXp(totalXp: number): number;
export function skillLevelFromXp(xp: number): number;
export function awardSkillXp(state: V3State, skillId: string, amount: number): unknown;
export function awardReputation(state: V3State, track: string, amount: number): void;
export function unlockAchievement(state: V3State, id: string): boolean;
export function getStoreDiscountRate(state: V3State): number;
