'use client';

import { useRef } from 'react';
import useSWR, { mutate } from 'swr';
import { apiClient } from './api-client';
import { useModuleEntryScope } from '@/hooks/useModuleEntryResource';
import { createEntryRequestStore } from '@/lib/module-entry-core';
import { registerUserScopedCleanup } from '@/lib/auth-cache-cleanup';
import type {
    SpeakingSessionDetail,
    SpeakingSentenceDetail,
    SpeakingShadowingAttemptResponse,
    SpeakingTurn,
    SpeakingTurnFeedback,
    QuickCheckResponse,
    PronunciationV2Response,
    SpeakingRecentImprovement,
    SpeakingIssueExample,
} from './speakingApi';

export type {
    SpeakingSessionDetail,
    SpeakingSentenceDetail,
    SpeakingShadowingAttemptResponse,
    SpeakingTurn,
    SpeakingTurnFeedback,
    QuickCheckResponse,
    PronunciationV2Response,
    SpeakingRecentImprovement,
    SpeakingIssueExample,
};

export type SpeakingProfileSubTab = 'overview' | 'pronunciation' | 'history';
export type SpeakingHistoryModeFilter = 'ALL' | 'SHADOWING' | 'ROLEPLAY' | 'QUICK_CHECK';
export type SpeakingHistoryStatusFilter = 'ALL' | 'COMPLETED' | 'ACTIVE';
export type SpeakingIssueStatus =
    | 'IMPROVING'
    | 'PRACTICING'
    | 'RECENTLY_STABLE'
    | 'NEEDS_ATTENTION'
    | 'INSUFFICIENT_DATA';
export type SpeakingSufficiencyStatus =
    | 'READY'
    | 'BUILDING_EVIDENCE'
    | 'LIMITED_EVIDENCE'
    | 'NO_RECURRING_ISSUES'
    | 'INSUFFICIENT_DATA';

export interface SpeakingActiveContinueSession {
    sessionId: number;
    status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
    mode: string;
    sourceType?: string | null;
    sourceId?: number | null;
    currentUnitIndex: number;
    completedUnitsCount: number;
    totalUnitsCount: number;
    materialTitle?: string | null;
    thumbnail?: string | null;
    youtubeVideoId?: string | null;
    cefrLevel?: string | null;
    createdAt?: string;
    updatedAt?: string;
}

export interface SpeakingHubEntry {
    currentStreakDays: number;
    activeTargetsCount: number;
    lifetimeCompletedSessions: number;
    activeSession?: SpeakingActiveContinueSession | null;
    activeSessionTitle?: string | null;
    activeSessionThumbnail?: string | null;
    activeSessionYoutubeVideoId?: string | null;
    generatedAt: string;
}

export interface SpeakingDataSufficiency {
    hasAnyPractice: boolean;
    strengthsStatus: SpeakingSufficiencyStatus;
    focusStatus: SpeakingSufficiencyStatus;
    trendStatus: SpeakingSufficiencyStatus;
    minScoredAttemptsForStrength: number;
    minDistinctSessionsForFocus: number;
    minScoredPointsForTrend: number;
}

export interface SpeakingLifetimeStats {
    completedSessions: number;
    inProgressSessions: number;
    totalSessions: number;
    qualifiedSpeakingSeconds: number;
    roleplayLearnerTurns: number;
    shadowingAttempts: number;
    quickCheckAttempts: number;
    targetVocabularyUsed: number;
    averageContentMatchScore?: number | null;
}

export interface SpeakingWindowActivity {
    currentStreakDays: number;
    longestStreakDays30d: number;
    practiceDays7d: number;
    practiceDays30d: number;
    sessionsCompleted7d: number;
    sessionsCompleted30d: number;
    sessionsStarted30d: number;
    sentencesPracticed7d: number;
    sentencesPracticed30d: number;
    roleplayTurns7d: number;
    roleplayTurns30d: number;
    quickChecks7d: number;
    quickChecks30d: number;
    speakingSeconds7d: number;
    speakingSeconds30d: number;
    totalAttempts30d: number;
    v2ScoredAttempts30d: number;
    sttOnlyOrAbstainedAttempts30d: number;
    retries30d: number;
    resolvedTargets30d: number;
    averagePronunciationScore30d?: number | null;
    averageContentMatchScore30d?: number | null;
}

export interface SpeakingDailyActivityPoint {
    date: string;
    active: boolean;
    completedSessions: number;
    attemptsCount: number;
    speakingSeconds: number;
    averageScore?: number | null;
}

export interface SpeakingScoreTrendPoint {
    sessionId: number;
    mode: 'SHADOWING' | 'ROLEPLAY' | 'QUICK_CHECK' | string;
    title: string;
    timestamp: string;
    pronunciationScore?: number | null;
    contentMatchScore?: number | null;
    fluencyScore?: number | null;
    attemptCount: number;
}

export interface SpeakingStrengthItem {
    id: string;
    evidenceType: 'ACOUSTIC' | 'CONSISTENCY' | 'RETRY_RESOLUTION';
    metricKey: string;
    titleVi: string;
    titleEn: string;
    detailVi: string;
    detailEn: string;
    score?: number | null;
    unit: '/100' | '%' | 'days' | 'targets' | 'sessions';
    sampleSize: number;
    windowLabelVi: string;
    windowLabelEn: string;
}

export interface SpeakingProfileRecurringIssue {
    issueKey: string;
    category?: 'PRONUNCIATION' | 'STRESS' | 'GRAMMAR' | 'VOCABULARY' | 'NATURALNESS' | string;
    title?: string;
    issueType: string;
    targetWord?: string | null;
    targetPhone?: string | null;
    observedPhone?: string | null;
    averageQualityScore?: number | null;
    status: SpeakingIssueStatus;
    statusExplanation?: string;
    distinctSessionsObserved: number;
    totalOccurrences: number;
    resolvedSessionCount: number;
    lastObservedAt?: string;
    displayCue: string;
    evidenceWindow: string;
    recentExamples?: SpeakingIssueExample[];
    practiceAgainRoute?: string;
    practiceAgainLabel?: string;
}

export interface SpeakingProfileSessionSummary {
    sessionId: number;
    materialId?: number | null;
    materialTitle: string;
    mode: 'SHADOWING' | 'ROLEPLAY' | 'QUICK_CHECK' | string;
    status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED' | 'FAILED' | string;
    sentencesPracticed: number;
    totalSentences: number;
    attemptCount: number;
    retryCount: number;
    resolvedTargetCount: number;
    durationSeconds?: number | null;
    averagePronunciationScore?: number | null;
    averageAccuracyScore?: number | null;
    cefrLevel?: string | null;
    createdAt: string;
    updatedAt?: string;
}

export interface SpeakingProfileOverview {
    policyVersion: string;
    generatedAt: string;
    dataSufficiency: SpeakingDataSufficiency;
    lifetime: SpeakingLifetimeStats;
    recentWindow: SpeakingWindowActivity;
    activityRhythm30d: SpeakingDailyActivityPoint[];
    scoreTrend: SpeakingScoreTrendPoint[];
    strengths: SpeakingStrengthItem[];
    focusAreas: SpeakingProfileRecurringIssue[];
    recentImprovements: SpeakingRecentImprovement[];
    recentSessions: SpeakingProfileSessionSummary[];
}

export interface SpeakingProfilePronunciationMetrics {
    averagePronunciationScore?: number | null;
    averageContentMatchScore?: number | null;
    averagePhonemeScore?: number | null;
    averageStressScore?: number | null;
    averagePitchScore?: number | null;
    averageRhythmScore?: number | null;
    averageFluencyScore?: number | null;
    scoredAttemptsCount: number;
    totalAttemptsCount: number;
    abstainedAttemptsCount: number;
    sttOnlyAttemptsCount: number;
    lexicalStressMatchedWords: number;
    lexicalStressAssessedWords: number;
    lexicalStressAssessmentsCount: number;
    contentMatchAttemptsCount: number;
    shadowingScoredCount: number;
    quickCheckScoredCount: number;
    roleplayScoredCount: number;
}

export interface SpeakingStrongPhonemePattern {
    phone: string;
    ipaDisplay: string;
    categoryLabelVi: string;
    categoryLabelEn: string;
    observationsCount: number;
    acceptableCount: number;
    acceptableRate: number;
    averageQualityScore: number;
    exampleWords: string[];
}

export interface SpeakingProfilePronunciation {
    policyVersion: string;
    windowDays: number;
    windowLabelVi: string;
    windowLabelEn: string;
    generatedAt: string;
    sufficiencyStatus: SpeakingSufficiencyStatus;
    minScoredAttemptsRequired: number;
    minDistinctSessionsForRecurring: number;
    distinctAssessedSessionsCount: number;
    metrics: SpeakingProfilePronunciationMetrics;
    recurringIssues: SpeakingProfileRecurringIssue[];
    singleSessionObservations: SpeakingProfileRecurringIssue[];
    strongPatterns: SpeakingStrongPhonemePattern[];
}

export interface SpeakingHistoryFilterCounts {
    all: number;
    completed: number;
    active: number;
    shadowing: number;
    roleplay: number;
    quickCheck: number;
}

export interface SpeakingProfileHistoryParams {
    page?: number;
    size?: number;
    mode?: SpeakingHistoryModeFilter;
    status?: SpeakingHistoryStatusFilter;
}

export interface SpeakingProfileHistoryPage {
    content: SpeakingProfileSessionSummary[];
    page: number;
    size: number;
    totalElements: number;
    totalPages: number;
    hasNext: boolean;
    modeFilter?: SpeakingHistoryModeFilter | string;
    statusFilter?: SpeakingHistoryStatusFilter | string;
    counts?: SpeakingHistoryFilterCounts | null;
}

const SPEAKING_PROFILE_SWR_NAMESPACE = 'speaking-profile';
const ENTRY_PATH = '/speaking/profile/entry';
const OVERVIEW_PATH = '/speaking/profile/overview';
const PRONUNCIATION_PATH = '/speaking/profile/pronunciation';
const HISTORY_PATH = '/speaking/profile/history';

const requests = createEntryRequestStore();
let generation = 0;

export function clearSpeakingProfileRequests(): void {
    generation++;
    requests.clear();
}

registerUserScopedCleanup(clearSpeakingProfileRequests);

export function speakingProfileKey(path: string, scope: string) {
    return [SPEAKING_PROFILE_SWR_NAMESPACE, path, scope] as const;
}

function normalizeHistoryPath(params?: SpeakingProfileHistoryParams): string {
    const safePage = Math.max(0, Math.floor(params?.page ?? 0));
    const safeSize = Math.max(1, Math.min(50, Math.floor(params?.size ?? 10)));
    const mode = (params?.mode ?? 'ALL').toUpperCase();
    const status = (params?.status ?? 'ALL').toUpperCase();
    const query = new URLSearchParams();
    query.set('page', String(safePage));
    query.set('size', String(safeSize));
    query.set('mode', mode);
    query.set('status', status);
    return `${HISTORY_PATH}?${query.toString()}`;
}

function runScopedGet<T>(path: string, scope: string): Promise<T> {
    const startedGeneration = generation;
    return requests.run(JSON.stringify(speakingProfileKey(path, scope)), async (signal) => {
        const { data } = await apiClient.get<T>(path, { signal, timeout: 20000 });
        if (signal.aborted || startedGeneration !== generation) {
            throw new Error('Speaking profile request cancelled');
        }
        return data;
    });
}

export async function fetchSpeakingHubEntry(scope = 'direct'): Promise<SpeakingHubEntry> {
    return runScopedGet<SpeakingHubEntry>(ENTRY_PATH, scope);
}

export async function fetchSpeakingProfileOverview(scope = 'direct'): Promise<SpeakingProfileOverview> {
    return runScopedGet<SpeakingProfileOverview>(OVERVIEW_PATH, scope);
}

export async function fetchSpeakingProfilePronunciation(scope = 'direct'): Promise<SpeakingProfilePronunciation> {
    return runScopedGet<SpeakingProfilePronunciation>(PRONUNCIATION_PATH, scope);
}

export async function fetchSpeakingProfileHistory(
    params?: SpeakingProfileHistoryParams,
    scope = 'direct',
): Promise<SpeakingProfileHistoryPage> {
    return runScopedGet<SpeakingProfileHistoryPage>(normalizeHistoryPath(params), scope);
}

export async function fetchSpeakingProfileSessionDetail(
    sessionId: number,
    scope = 'direct',
): Promise<SpeakingSessionDetail> {
    return runScopedGet<SpeakingSessionDetail>(`${HISTORY_PATH}/${encodeURIComponent(String(sessionId))}`, scope);
}

/**
 * Lightweight Hub Entry summary for `/speaking` ("Luyện tập" streak, active targets, continue card).
 * Triggers zero heavy pronunciation JSON parsing and zero full history scans.
 */
export function useSpeakingHubEntry(enabled = true) {
    const scope = useModuleEntryScope();
    return useSWR<SpeakingHubEntry>(
        scope && enabled ? speakingProfileKey(ENTRY_PATH, scope) : null,
        () => fetchSpeakingHubEntry(scope!),
        {
            keepPreviousData: false,
            revalidateOnFocus: false,
            dedupingInterval: 30_000,
            shouldRetryOnError: false,
        },
    );
}

/**
 * Lazy Speaking Profile Overview ("Tổng quan"). Makes 0 requests when `enabled === false`.
 */
export function useSpeakingProfileOverview(enabled: boolean) {
    const scope = useModuleEntryScope();
    return useSWR<SpeakingProfileOverview>(
        scope && enabled ? speakingProfileKey(OVERVIEW_PATH, scope) : null,
        () => fetchSpeakingProfileOverview(scope!),
        {
            keepPreviousData: false,
            revalidateOnFocus: false,
            dedupingInterval: 30_000,
            shouldRetryOnError: false,
        },
    );
}

/**
 * Lazy Speaking Profile Pronunciation ("Phát âm"). Makes 0 requests when `enabled === false`.
 */
export function useSpeakingProfilePronunciation(enabled: boolean) {
    const scope = useModuleEntryScope();
    return useSWR<SpeakingProfilePronunciation>(
        scope && enabled ? speakingProfileKey(PRONUNCIATION_PATH, scope) : null,
        () => fetchSpeakingProfilePronunciation(scope!),
        {
            keepPreviousData: false,
            revalidateOnFocus: false,
            dedupingInterval: 30_000,
            shouldRetryOnError: false,
        },
    );
}

/**
 * Lazy Paginated Speaking History ("Lịch sử"). Makes 0 requests when `enabled === false`.
 * Preserves smooth pagination within the SAME authenticated account scope while strictly blocking cross-account retention.
 */
export function useSpeakingProfileHistory(
    params: SpeakingProfileHistoryParams = {},
    enabled: boolean,
) {
    const scope = useModuleEntryScope();
    const lastScopeRef = useRef<string | null>(null);
    const sameAuthenticatedScope = Boolean(scope && lastScopeRef.current === scope);
    lastScopeRef.current = scope;

    const path = normalizeHistoryPath(params);
    return useSWR<SpeakingProfileHistoryPage>(
        scope && enabled ? speakingProfileKey(path, scope) : null,
        () => runScopedGet<SpeakingProfileHistoryPage>(path, scope!),
        {
            keepPreviousData: sameAuthenticatedScope && enabled,
            revalidateOnFocus: false,
            dedupingInterval: 15_000,
            shouldRetryOnError: false,
        },
    );
}

/**
 * Lazy Session Detail drill-down. Makes 0 requests when `sessionId == null` or `enabled === false`.
 */
export function useSpeakingSessionDetail(
    sessionId: number | null | undefined,
    enabled = true,
) {
    const scope = useModuleEntryScope();
    const validId = typeof sessionId === 'number' && Number.isFinite(sessionId) && sessionId > 0;
    const path = validId ? `${HISTORY_PATH}/${sessionId}` : '';
    return useSWR<SpeakingSessionDetail>(
        scope && enabled && validId ? speakingProfileKey(path, scope) : null,
        () => fetchSpeakingProfileSessionDetail(sessionId!, scope!),
        {
            keepPreviousData: false,
            revalidateOnFocus: false,
            dedupingInterval: 60_000,
            shouldRetryOnError: false,
        },
    );
}

/**
 * Revalidates only already-loaded Speaking Hub Entry / Profile SWR keys for the signed-in learner
 * after practice completion (Quick Check, Shadowing, Role-play) without prefetching unvisited tabs.
 */
export function revalidateSpeakingProfile(scope?: string | null) {
    return mutate(
        (key) =>
            Array.isArray(key) &&
            key[0] === SPEAKING_PROFILE_SWR_NAMESPACE &&
            (scope == null || key[2] === scope),
        undefined,
        { revalidate: true },
    );
}

export function getSpeakingAttemptAudioUrl(clientAttemptId: string): string {
    return `/api/v1/speaking/attempts/${encodeURIComponent(clientAttemptId)}/audio`;
}

export function getSpeakingTurnAudioUrl(sessionId: number, turnId: number): string {
    return `/api/v1/speaking/sessions/${encodeURIComponent(String(sessionId))}/turns/${encodeURIComponent(String(turnId))}/audio`;
}
