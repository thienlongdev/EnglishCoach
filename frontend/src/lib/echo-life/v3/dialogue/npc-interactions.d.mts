/** Types for the vendored V3 NPC dialogue & interactions module (verbatim copy, see ../PROVENANCE.tsv). */
import type { V3State, V3Option, V3Result, V3StoryChoice, V3SideQuest } from '../game-core/index.mjs';
export function buildNpcInteractionOptions(s: V3State, npcId: string): V3Option[];
export function executeNpcInteraction(s: V3State, npcId: string, choiceKey: string): V3Result;
export function getNpcHeaderBadge(s: V3State, npcId: string): string;
export function getActiveStoryChoiceForNpc(s: V3State, npcId: string): V3StoryChoice | null;
export function getSideQuestPromptForNpc(s: V3State, npcId: string): { quest: V3SideQuest; stageObj: { id: string; label: string; event: string }; stageIndex: number } | null;
