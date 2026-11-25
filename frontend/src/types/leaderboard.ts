// Types of /api/v1/leaderboard/** and /api/v1/proficiency/me (Leaderboard Phase 3 / 3.1 backend).
// Display name + avatar only — the API never returns e-mail.

export type ActivityPeriod = 'WEEK' | 'MONTH' | 'ALL_TIME';
export type ActivityScope = 'GLOBAL' | 'SO_CAP' | 'TRUNG_CAP' | 'CAO_CAP';
export type ActivityGroup = 'ALL' | 'VOCAB' | 'LISTENING' | 'SPEAKING' | 'READING' | 'WRITING' | 'EXAMS';
export type Division = 'SO_CAP' | 'TRUNG_CAP' | 'CAO_CAP';
export type ProficiencyBoard = 'OVERALL' | 'LISTENING' | 'READING' | 'WRITING' | 'SPEAKING';
export type SkillStatus = 'UNSUPPORTED' | 'STALE' | 'UNDETERMINED' | 'VERIFIED' | 'PROVISIONAL';
export type IneligibleReason = 'UNDETERMINED' | 'PROVISIONAL' | 'STALE' | 'UNSUPPORTED' | 'EXCLUDED';

export interface BoardAvatarFrame {
  slug: string;
  tier: string;
  renderType: string;
  posterAsset: string;
}

export interface ActivityItem {
  rank: number;
  userId: number;
  displayName: string;
  avatarUrl: string | null;
  avatarFrame: BoardAvatarFrame | null;
  points: number;
}

export interface ActivityBoardResponse {
  period: ActivityPeriod;
  scope: ActivityScope;
  group: ActivityGroup;
  items: ActivityItem[];
  /** Ranked learners in this period / scope / group (hero chip "Người tham gia tuần này"). */
  participants: number;
  periodStartsAt: string | null;
  periodEndsAt: string | null;
  updatedAt: string | null;
}

export interface UnrankedItem {
  userId: number;
  displayName: string;
  avatarUrl: string | null;
  avatarFrame: BoardAvatarFrame | null;
}

export interface UnrankedResponse {
  period: ActivityPeriod;
  scope: ActivityScope;
  group: ActivityGroup;
  items: UnrankedItem[];
  nextCursor: number | null;
}

export type DivisionSource = 'VERIFIED' | 'STALE' | 'PROVISIONAL' | 'PLACEMENT';

/**
 * Why the caller has (no) rank in the selected partition (backend-authoritative):
 * RANKED · NO_POINTS (eligible, 0 points this period) · PENDING (points recorded, rank catches up within seconds) ·
 * OTHER_DIVISION (a division chip that is not the caller's) · PLACEMENT_REQUIRED (no completed placement quiz) ·
 * EXCLUDED (admin / inactive / excluded account — points are still recorded).
 */
export type ActivityEligibility = 'RANKED' | 'NO_POINTS' | 'PENDING' | 'OTHER_DIVISION' | 'PLACEMENT_REQUIRED' | 'EXCLUDED';

export interface SourceBreakdown {
  sourceModule: string;
  points: number;
}

export interface ActivityMeResponse {
  userId: number;
  period: ActivityPeriod;
  scope: ActivityScope;
  group: ActivityGroup;
  rank: number | null;
  points: number;
  pointsToNextRank: number | null;
  nextRank: number | null;
  /** Always GLOBAL ("Bảng chung"). */
  defaultScope: ActivityScope;
  division: Division | null;
  divisionCefr: string | null;
  divisionSource: DivisionSource | null;
  /** Anti-sandbagging (Stage 3): division raised to this CEFR within the promotion window, else null. */
  promotedTo: string | null;
  promotedAt: string | null;
  breakdown: SourceBreakdown[];
  periodStartsAt: string | null;
  periodEndsAt: string | null;
  updatedAt: string | null;
  eligibility?: ActivityEligibility;
  placementCompleted?: boolean;
  /** Why the caller is EXCLUDED (null otherwise): ADMIN, EXCLUDED_TEST (configured test account) or INACTIVE. */
  excludedReason?: 'ADMIN' | 'EXCLUDED_TEST' | 'INACTIVE' | null;
}

export interface SkillCell {
  cefr: string | null;
  status: SkillStatus | string;
}

export interface ProficiencyItem {
  rank: number;
  userId: number;
  displayName: string;
  avatarUrl: string | null;
  avatarFrame: BoardAvatarFrame | null;
  cefr: string;
  rating: number;
  confidenceLabel: string;
  skills: Record<'L' | 'R' | 'W' | 'S', SkillCell>;
}

export interface ProficiencyBoardResponse {
  board: ProficiencyBoard;
  division: Division;
  items: ProficiencyItem[];
  updatedAt: string | null;
}

export interface ProficiencyBoardMeResponse {
  userId: number;
  board: ProficiencyBoard;
  rank: number | null;
  rating: number | null;
  cefr: string | null;
  status: SkillStatus | string;
  division: Division | null;
  hidden: boolean;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
  updatedAt: string | null;
}

export interface ProficiencyOverall {
  rating: number | null;
  currentCefr: string | null;
  peakRating: number | null;
  peakCefr: string | null;
  confidence: number;
  status: SkillStatus | string;
  confidenceLabel: string;
}

export interface ProficiencySkill {
  skill: 'LISTENING' | 'READING' | 'WRITING' | 'SPEAKING' | 'VOCABULARY' | string;
  rating: number | null;
  cefr: string | null;
  confidence: number;
  status: SkillStatus | string;
  lastEvidenceAt: string | null;
}

export interface ProficiencyMeResponse {
  overall: ProficiencyOverall;
  skills: ProficiencySkill[];
  placementCta: string | null;
  placementFormIds: Record<string, string>;
  showOnProficiencyBoard: boolean;
}

// ---- Placement quiz "Bài xếp lớp nhanh" (model 2: vocabulary + grammar multiple choice) + Năng lực groups -----

export type PlacementStatus = 'VALID' | 'INVALID';

/** GET /proficiency/placement/me — resultCefr / takenAt come from the latest VALID attempt. */
export interface PlacementMeResponse {
  latestStatus: PlacementStatus | null;
  resultCefr: string | null;
  lowConfidence: boolean;
  takenAt: string | null;
  canRetake: boolean;
  retakeAvailableAt: string | null;
  itemCount: number;
  /** The latest result comes from the retired word-list quiz: a retake is open now. */
  outdated?: boolean;
  /** Unfinished, autosaved attempt that can be resumed (null when none). */
  activeAttempt?: PlacementActiveSummary | null;
}

export interface PlacementActiveSummary {
  attemptId: string;
  answered: number;
  total: number;
  updatedAt: string;
  expiresAt: string;
}

/** GET /proficiency/placement/active — same questions (no keys) + answers saved so far. */
export interface PlacementActiveResponse {
  attemptId: string;
  items: PlacementQuestion[];
  answers: (number | null)[];
  answered: number;
  total: number;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
}

/** PUT /proficiency/placement/{id}/progress */
export interface PlacementSaveResponse {
  attemptId: string;
  answered: number;
  total: number;
  savedAt: string;
}

export type PlacementSkill = 'VOCABULARY' | 'GRAMMAR';

/** One question: a sentence with one blank (___) and four options. No level, no answer key. */
export interface PlacementQuestion {
  index: number;
  skill: PlacementSkill;
  prompt: string;
  options: string[];
}

/** POST /proficiency/placement/start */
export interface PlacementStartResponse {
  attemptId: string;
  items: PlacementQuestion[];
  expiresAt: string;
}

export interface PlacementSkillScore {
  correct: number;
  total: number;
}

export interface PlacementSubmitResponse {
  status: PlacementStatus;
  resultCefr: string | null;
  lowConfidence: boolean;
  retakeAvailableAt: string | null;
  vocabulary?: PlacementSkillScore;
  grammar?: PlacementSkillScore;
}

export interface OtherLevelItem {
  userId: number;
  displayName: string;
  avatarUrl: string | null;
  avatarFrame: BoardAvatarFrame | null;
  cefr: string;
  source: DivisionSource;
}

/** GET /leaderboard/proficiency/others */
export interface ProficiencyOthersResponse {
  board: ProficiencyBoard;
  division: Division;
  verifying: OtherLevelItem[];
  placement: OtherLevelItem[];
  undeterminedCount: number;
}
