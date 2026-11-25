/** Types for the vendored V3 residents module (verbatim copy, see ../PROVENANCE.tsv); only the schedule planner is used. */
import type { V3State, V3Npc } from '../game-core/index.mjs';
export const residents: Record<string, [string, string, string, string, string, string, string]>;
export function newResidents(): Record<string, V3Npc>;
export function nextZone(from: string, to: string): string | null;
export function desiredScheduleFor(s: V3State, id: string): { zone: string; activity: string; note: string };
export function stepResidents(s: V3State, dt: number): void;
