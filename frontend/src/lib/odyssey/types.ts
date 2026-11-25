import type { LearningTask, ProgressSummary, TodayView } from '@/types/learningPath';
export type Words = { vi: string; en: string };
export type ViewMode = 'ATLAS' | 'REGION' | 'LIST';
export type LaunchMode = 'LEARN' | 'CHECK' | 'REVIEW' | 'ADVANCE';
export interface Region { id: string; name: Words; purpose: Words; skill: string; theme: string; x: number; z: number; neighbors: string[]; competencies: string[] }
export interface Station { id: string; regionId: string; title: Words; kind: string; skill: string; level: string | null; domain: string | null;
  status: string; gate: { state: string; required: string[]; missing: string[]; evidenceBasis: string; remediation: string | null };
  checkAvailable: boolean; learningRole: string; prerequisites: string[]; task: LearningTask | null; reviewedAt: string | null }
export interface Exploration { regionId: string; discoveredAt: string; beaconAt: string | null }
export interface Navigation { regionId: string; stationId: string | null; viewMode: ViewMode; targetDate: string | null; weeklyMinutes: number | null; examVariant: string | null; revision: number }
export interface Launch { requestId: string; stationId: string; regionId: string; mode: LaunchMode; taskId: number | null; topicSlug: string | null; checkId: string | null; createdAt: string }
export interface LaunchView { launch: Launch; href: string }
export interface Reward { sourceKind: string; sourceRef: string; regionId: string; grantedAt: string }
export interface World { version: string; grammarRevision: string; regions: { region: Region; stations: number; passed: number; reviewDue: number }[];
  explored: Exploration[]; navigation: Navigation; journal: Reward[]; rewardCount: number; newlyGranted: Reward[];
  today: TodayView; progress: ProgressSummary; recommendations: Station[]; evidence: { skill: string; status: string; cefr: string | null; currentVerified: boolean }[]; activeLaunch: Launch | null }
export interface RegionDetail { version: string; region: Region; stations: Station[] }
export interface WorldMetrics { fps: number; frameP95: number; calls: number; triangles: number; geometries: number; textures: number; samples: number }
