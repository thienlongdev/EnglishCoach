/**
 * Types for the vendored Echo Life V3 game core (Codex `23_OPEN_WORLD_GAMEPLAY_STORY_V3/game-core/index.mjs`, copied verbatim
 * — see `../PROVENANCE.tsv`). Hand-written for the English Coach host: only what the integration reads is typed; the V3 state
 * tree stays open (`[key: string]: unknown`) because the vendored modules own it.
 */
export interface V3Zone {
  id: string; label: string; size: number; depth?: number; outdoors: boolean; district: string;
  props: { id: string; model: string; x: number; z: number; action: string | null; width: number; depth: number; angle: number }[];
  doors: { id: string; to: string; x: number; z: number }[];
  storeId?: string; openHours?: { open: number; close: number } | null; hiddenUntilDiscovered?: boolean; roadCapable?: boolean;
  requiresPropertyRoom?: string;
}
export interface V3Rel {
  friendship: number; trust: number; familiarity: number; respect: number; rivalry: number;
  memories: { type: string; detail: string; day?: number; clock?: number }[];
  dialogueSeen: string[]; pendingInvite?: { label: string; zone: string; accepted?: boolean } | null;
  conflictState?: { active: boolean } | null; [key: string]: unknown;
}
export interface V3Npc {
  id: string; zone: string; x: number; z: number; yaw: number; activity: string; scheduleNote: string;
  path: unknown[]; target: string | null; rel: V3Rel; [key: string]: unknown;
}
export interface V3Player { zone: string; x: number; y: number; z: number; yaw: number; riding?: boolean; driving?: boolean; [key: string]: unknown }
export interface V3Skill { xp: number; level: number }
export interface V3Progression {
  activeVehicleId: string;
  activeCarId?: string;
  playerLevel: number; totalXp: number;
  economy: { credits: number; dailyEarnings: number; lifetimeEarned: number; lifetimeSpent: number; minigameWinsToday: number; [key: string]: unknown };
  skills: Record<string, V3Skill>; materials: Record<string, number>; ownedObjects: V3OwnedObject[];
  reputation: Record<string, number>; achievements: string[]; unlockedOutfits: string[];
  properties: { activePropertyId: string; [key: string]: unknown }; [key: string]: unknown;
}
export interface V3OwnedObject {
  instanceId: string; ownerAccountId: string; assetFamilyId: string; selectedVariantId: string; category: string;
  upgradeLevel: number; condition: number; revision: number; location: { zoneId?: string; inStorage?: boolean; [key: string]: unknown };
  placement: { x: number; y: number; z: number; yaw: number }; interactionState: Record<string, unknown>; [key: string]: unknown;
}
export interface V3Tutorial { active: boolean; completed: boolean; skipped: boolean; stepIndex: number; completedSteps: string[]; flags: Record<string, number | boolean> }
export interface V3World {
  tutorial: V3Tutorial; storyChoices: Record<string, string>; endingId: string | null;
  sideQuests: Record<string, { started: boolean; stage: number; done: boolean }>;
  exploration: { discoveredZones: string[]; discoveredLandmarks: string[]; collectibles: string[]; loreRead: string[] };
  photos: { id: string; zone: string; title: string; subjects: string[]; day: number }[];
  eventsAttended: string[]; activeSocialScenes: string[]; hostedGuest: { npcId: string; zone: string; untilClock: number } | null;
  activeDelivery: unknown; recentFeed: string[]; activityCounts: Record<string, number>; [key: string]: unknown;
}
export interface V3State {
  version: number; saveRevision: number; owner: string; clock: number; elapsed: number; day: number;
  player: V3Player; avatar: string; settings: Record<string, unknown>; cash: number;
  bag: Record<string, number>; pantry: Record<string, number>; basket: string[]; stock: Record<string, number>;
  needs: Record<string, number>; done: string[]; progress: Record<string, number>; sandbox: boolean;
  npcs: Record<string, V3Npc>; flags: Record<string, unknown>; held: string | null;
  prepared: string | null; pot: { meal: string; at: number; ready: boolean } | null; served: string | null; dirty: boolean;
  posture: string; busy: { clip: string; until: number } | null;
  challenge: { type: string; start: number; sequence: number[]; index: number } | null;
  progression: V3Progression; worldV3: V3World; seed: number; npcTime: number; [key: string]: unknown;
}
export interface V3Result { ok: boolean; msg: string; openPanel?: string; storeId?: string; targetInstanceId?: string; workActivity?: string; [key: string]: unknown }
export interface V3Option { key: string; label: string; kind?: string }
export interface V3Entity { id: string; action: string; x: number; z: number; name?: string; model?: string; [key: string]: unknown }
export interface V3Character {
  id: string; name: string; model: string; role: string; archetype: string; personality: string[]; bio: string; goal: string;
  interests: string[]; favoriteGifts: string[]; connections: string[]; homeZone: string; workZone: string; rainFallback: string;
  personalArcId?: string; voiceStyle: string;
  weekdaySchedule: { from: number; to: number; zone: string; activity: string; note: string }[];
  weekendSchedule: { from: number; to: number; zone: string; activity: string; note: string }[];
}
export interface V3Quest { id: string; chapter: number; title: string; zone: string; steps: string[]; requires: string[]; hint: string; storyNote: string; reward: number; skill: string }
export interface V3SideQuest {
  id: string; title: string; leadNpc: string; supportingNpcs: string[]; category: string; summary: string;
  stages: { id: string; label: string; event: string }[];
  rewards: { credits: number; skill: string; skillXp: number; rep?: [string, number]; materials?: Record<string, number> };
}
export interface V3StoryChoice { id: string; chapter: number; title: string; prompt?: string; npc?: string; options: { key: string; label: string; [key: string]: unknown }[]; [key: string]: unknown }
export interface V3Ending { id: string; title: string; summary?: string; [key: string]: unknown }
export interface V3Activity { id: string; category: string; title: string; zone: string; mechanic: string }
export interface V3TutorialStep { id: string; index: number; title: string; desktopHint: string; mobileHint: string; goalLabel: string }
export interface V3Landmark { id: string; zone: string; name: string; secret?: boolean; [key: string]: unknown }
export interface V3Collectible { id: string; zone: string; x: number; z: number; model: string; name: string; reward: number; [key: string]: unknown }
export interface V3WorldEvent { id: string; title: string; zone: string; participants: string[]; rewardCredits?: number; [key: string]: unknown }
export interface V3Calendar { dayIndex: number; weekday: string; hour: number; minute: number; isWeekend: boolean; phase: string; [key: string]: unknown }
export interface V3Weather { id: string; label: string; rain: boolean; [key: string]: unknown }
export interface V3SocialScene { id: string; participants: [string, string]; zones: string[]; pose: string[]; caption: string; joinPrompt: string; rewardSkill: string; joinReply: string }

export function createGame(owner?: string): V3State;
export function createWorldV3(returningPlayer?: boolean): V3World;
export function tick(s: V3State, input: Record<string, unknown>, dt: number): void;
export function interact(s: V3State, id: string, choice: string): V3Result;
export function choices(s: V3State, e: V3Entity): V3Option[];
export function nearby(s: V3State): V3Entity[];
export function entities(s: V3State): V3Entity[];
export function release(s: V3State, storage?: boolean): boolean;
export function challengeInput(s: V3State, i: number): boolean | null | false;
export const meals: Record<string, { name: string; model: string; items: Record<string, number>; hunger: number }>;
export const products: Record<string, { name: string; price: number; items: Record<string, number> }>;
export const zones: Record<string, V3Zone>;
export const LANDMARKS: V3Landmark[];
export const COLLECTIBLES: V3Collectible[];
export const LORE_SPOTS: Record<string, { title: string; [key: string]: unknown }>;
export function discoverZone(s: V3State, zoneId: string): V3Landmark | null;
export function collectRelic(s: V3State, id: string): V3Result;
export function inspectLore(s: V3State, id: string): V3Result;
export const WEEKDAYS: string[];
export const WEATHER_STATES: Record<string, V3Weather>;
export const WORLD_EVENTS: V3WorldEvent[];
export function getCalendar(clock: number): V3Calendar;
export function getWeather(s: V3State): V3Weather;
export function getActiveEvents(s: V3State): V3WorldEvent[];
export function isZoneOpen(zone: V3Zone | undefined, clock: number): { open: boolean; [key: string]: unknown };
export const CHARACTERS: Record<string, V3Character>;
export const CHARACTER_IDS: string[];
export const CORE_FIVE_IDS: string[];
export function ensureRelationship(s: V3State, npcId: string): V3Rel;
export function getRelationshipTier(rel: V3Rel): string;
export function adjustRelationship(s: V3State, npcId: string, deltas?: Record<string, number>, memory?: unknown): void;
export const SOCIAL_SCENES: V3SocialScene[];
export function detectZoneSocialScenes(s: V3State, zoneId: string): (V3SocialScene & { actors: [V3Npc, V3Npc]; names: [string, string] })[];
export const quests: V3Quest[];
export function active(s: V3State): V3Quest[];
export const chapters: string[];
export function record(s: V3State, event: string): string[];
export const STORY_CHOICES: Record<string, V3StoryChoice>;
export const ENDINGS: Record<string, V3Ending>;
export function makeStoryChoice(s: V3State, choiceId: string, optionKey: string): V3Result;
export function resolveEnding(s: V3State): string;
export const SIDE_QUESTS: V3SideQuest[];
export function initSideQuestsState(): V3World['sideQuests'];
export function advanceSideQuests(s: V3State, event: string): string[];
export function getSideQuest(id: string): V3SideQuest | undefined;
export const FREE_ROAM_ACTIVITY_CATALOG: V3Activity[];
export function performFreeRoamAction(s: V3State, action: string, choice?: string | null): V3Result;
export const TUTORIAL_STEPS: V3TutorialStep[];
export const CONTROLS_REFERENCE: unknown[];
export function createTutorialState(returningPlayer?: boolean): V3Tutorial;
export function getCurrentTutorialStep(s: V3State): V3TutorialStep | null;
export function recordTutorialSignal(s: V3State, signal: string, amount?: number): { completedAll?: boolean; msg?: string } | null;
export function skipTutorial(s: V3State): void;
export function replayTutorial(s: V3State): void;
export function decode(raw: string, owner: string): V3State;
export const MATERIAL_FINISHES: Record<string,{id:string;name:string;primaryColor:string;accentColor:string;roughness:number;metalness:number}>;
export const CATALOG: {
  economy: { currency: { startingBalance: number; maxSafeBalance: number; [key: string]: unknown }; [key: string]: unknown };
  skills: { skills: Record<string, { name: string; [key: string]: unknown }>; [key: string]: unknown };
  shops: Record<string, { id: string; name: string; zone: string; vendorName: string; category: string; description: string; items: V3ShopItem[] }>;
  [key: string]: unknown;
};
export interface V3ShopItem { sku: string; name: string; price: number; itemType: string; reqLevel?: number; reqSkill?: Record<string, number>; [key: string]: unknown }
export const ACHIEVEMENTS: Record<string, { name: string; [key: string]: unknown }>;
export function getStore(id: string): (typeof CATALOG)['shops'][string] | undefined;
export function getActiveVehiclePhysics(state: {progression: V3Progression}): {
  model: string; paintHex: string | null; maxSpeed: number; acceleration: number; braking: number; handling: number;
};
export function createProgression(owner: string, credits?: number): V3Progression;
export function syncCredits(s: V3State): void;
export function awardSkillXp(s: V3State, skill: string, amount: number): unknown;
export function playerLevelFromXp(totalXp: number): number;
export function skillLevelFromXp(xp: number): number;
export function getStoreDiscountRate(s: V3State): number;
export function executeProgressionAction(s: V3State, action: Record<string, unknown>, owner: string): V3Result & { code?: number; instance?: V3OwnedObject };
export function buyShopItem(s: V3State, storeId: string, sku: string, owner: string, opts?: Record<string, unknown>): V3Result & { code?: number; instance?: V3OwnedObject };
export function sellOwnedObject(s: V3State, instanceId: string, owner: string): V3Result;
export function performWorkActivity(s: V3State, activityId: string, owner: string): V3Result;
