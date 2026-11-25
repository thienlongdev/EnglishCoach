import { apiClient } from './api-client';

export type WordAlignmentStatus =
    | 'EXACT_MATCH'
    | 'MATCH'
    | 'MISSING_WORD'
    | 'EXTRA_WORD'
    | 'WRONG_WORD'
    | 'NEAR_MATCH'
    | 'MINOR_SPELLING';

export interface WordAlignmentItem {
    word: string;
    spokenWord?: string;
    status: WordAlignmentStatus;
    expectedWord?: string;
}

export interface TranscriptInfo {
    text: string;
    confidence?: number | null;
}

export interface SpeakingAnalysisResponse {
    transcript?: TranscriptInfo;
    transcription: string;
    accuracyScore?: number | null;
    pronunciationScore?: number | null;
    fluencyScore?: number | null;
    feedback?: string | null;
    wordAlignment?: WordAlignmentItem[];
    isMocked?: boolean;
}

export interface SpeakingResultResponse {
    id: number;
    transcription: string;
    accuracyScore?: number | null;
    pronunciationScore?: number | null;
    fluencyScore?: number | null;
    feedback?: string | null;
    createdAt: string;
}

export interface SpeakingSessionCreateRequest {
    mode: 'SHADOWING' | 'ROLEPLAY';
    scenarioId?: number;
    sourceType?: string;
    sourceId?: number;
    voiceId?: string;
}

export interface SpeakingSessionUpdateRequest {
    status?: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
    durationSeconds?: number;
}

export interface SpeakingSessionResponse {
    id: number;
    mode: string;
    status: string;
    scenarioId?: number;
    sourceType?: string;
    sourceId?: number;
    durationSeconds: number;
    voiceId?: string;
    createdAt: string;
    updatedAt?: string;
}

export type CefrLevelType = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export type ScenarioCategoryType = 'TRAVEL' | 'DAILY_LIFE' | 'BUSINESS' | 'WORK' | 'ACADEMIC' | 'CASUAL';

export interface SpeakingScenarioSummary {
    id: number;
    title: string;
    description: string;
    cefrLevel: CefrLevelType;
    category: ScenarioCategoryType;
    learnerRole: string;
    aiRole: string;
    estimatedMinutes: number;
    createdAt: string;
    isCustom?: boolean;
    defaultVoiceId?: string;
}

export interface SpeakingScenario extends SpeakingScenarioSummary {
    learnerGoal: string;
    targetVocabulary: string[];
    targetGrammar: string[];
    initialAiMessage: string;
    successCriteria: string[];
    completionConditions?: string;
    evaluationRubric?: string;
    optionalHints: string[];
}

export interface SpeakingContext {
    sourceType: string;
    sourceId: number;
    sourceTitle: string;
    cefrLevel?: string;
    topic?: string;
    targetVocabulary: string[];
    targetPhrases: string[];
}

export interface SpeakingTurn {
    id: number;
    sessionId: number;
    clientTurnId?: string;
    sequenceNumber: number;
    speaker: 'LEARNER' | 'ASSISTANT';
    text: string;
    detectedVocabulary: string[];
    isMocked?: boolean;
    durationSeconds?: number;
    pronunciationScore?: number | null;
    segmentalScore?: number | null;
    fluencyScore?: number | null;
    stressScore?: number | null;
    intonationScore?: number | null;
    rhythmScore?: number | null;
    engineVersion?: string | null;
    pronunciationResultJson?: string | null;
    audioRef?: string | null;
    synthesizedAudioRef?: string | null;
    feedback?: SpeakingTurnFeedback | null;
    createdAt: string;
}

export interface TurnCorrection {
    type: 'GRAMMAR' | 'VOCABULARY' | 'NATURALNESS';
    original: string;
    suggestion: string;
    explanation: string;
    priority?: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface SpeakingTurnFeedback {
    id: number;
    turnId: number;
    summary: string;
    positiveFeedback?: string;
    corrections: TurnCorrection[];
    isMocked: boolean;
    createdAt: string;
}

export interface RoleplayTurnResponse {
    sessionId: number;
    learnerTurn: SpeakingTurn;
    assistantTurn: SpeakingTurn;
    detectedVocabularyThisTurn: string[];
    allDetectedVocabularySoFar: string[];
    isTaskCompleted: boolean;
    isIdempotentReplay: boolean;
    isMocked?: boolean;
    pronunciationFeedback?: PronunciationV2Response | null;
}

/**
 * Forward recorded voice blob to Spring Boot API gateway (/api/v1/speaking/analyze)
 * with optional referenceText for Shadowing accuracy scoring and word-level alignment.
 */
export const analyzeSpeakingAudio = async (
    audioBlob: Blob,
    referenceText?: string
): Promise<SpeakingAnalysisResponse> => {
    const formData = new FormData();
    const filename = getAudioUploadFilename(audioBlob.type, 'recording');

    formData.append('file', audioBlob, filename);
    if (referenceText && referenceText.trim()) {
        formData.append('referenceText', referenceText.trim().replace(/^["']|["']$/g, ''));
    }

    const response = await apiClient.post<SpeakingAnalysisResponse>('/speaking/analyze', formData, {
        headers: {
            'Content-Type': 'multipart/form-data',
        },
    });
    return response.data;
};

/**
 * Retrieve user's historical speaking practice results
 */
export const getSpeakingResults = async (): Promise<SpeakingResultResponse[]> => {
    const response = await apiClient.get<SpeakingResultResponse[]>('/speaking/results');
    return response.data;
};

/**
 * Create or initialize a new Speaking practice session
 */
export const createSpeakingSession = async (
    request: SpeakingSessionCreateRequest
): Promise<SpeakingSessionResponse> => {
    const response = await apiClient.post<SpeakingSessionResponse>('/speaking/sessions', request);
    return response.data;
};

/**
 * Update an existing Speaking practice session status or duration
 */
export const updateSpeakingSession = async (
    sessionId: number,
    request: SpeakingSessionUpdateRequest
): Promise<SpeakingSessionResponse> => {
    const response = await apiClient.put<SpeakingSessionResponse>(`/speaking/sessions/${sessionId}`, request);
    return response.data;
};

/**
 * Retrieve catalog of structured speaking scenarios for AI Role-play (lightweight summary DTO)
 */
export const getSpeakingScenarios = async (
    cefrLevel?: string,
    category?: string
): Promise<SpeakingScenarioSummary[]> => {
    const params = new URLSearchParams();
    if (cefrLevel && cefrLevel !== 'ALL') params.append('cefrLevel', cefrLevel);
    if (category && category !== 'ALL') params.append('category', category);

    const queryString = params.toString() ? `?${params.toString()}` : '';
    const response = await apiClient.get<SpeakingScenarioSummary[]>('/speaking/scenarios' + queryString);
    return response.data;
};

export interface FilterCount {
    key: string;
    label?: string;
    count: number;
}

export interface ScenarioCatalogMetadata {
    levels: FilterCount[];
    categories: FilterCount[];
    totalCount: number;
}

export interface CreateCustomScenarioRequest {
    topic: string;
    cefrLevel: string;
    context: string;
    learnerRole: string;
    aiRole: string;
    mission: string;
    targetVocabulary?: string[];
    targetTurns?: number;
    estimatedDuration?: string;
    voiceId?: string;
    // Optional compatibility aliases
    learnerGoal?: string;
    desiredTurns?: number;
    estimatedMinutes?: number;
}

/**
 * Retrieve metadata (available levels, categories, counts) for Role-play scenario catalog
 */
export const getSpeakingScenarioMetadata = async (): Promise<ScenarioCatalogMetadata> => {
    const response = await apiClient.get<ScenarioCatalogMetadata>('/speaking/scenarios/metadata');
    return response.data;
};

/**
 * Create a new user-custom scenario generated via structured AI
 */
export const createCustomScenario = async (
    request: CreateCustomScenarioRequest
): Promise<SpeakingScenario> => {
    const canonicalMission = (request.mission || request.learnerGoal || "").trim();
    const payload = {
        topic: request.topic.trim(),
        cefrLevel: request.cefrLevel,
        context: request.context.trim(),
        learnerRole: request.learnerRole.trim(),
        aiRole: request.aiRole.trim(),
        mission: canonicalMission,
        targetVocabulary: request.targetVocabulary,
        targetTurns: request.targetTurns ?? request.desiredTurns,
        estimatedDuration: request.estimatedDuration ?? (request.estimatedMinutes ? `${request.estimatedMinutes} phút` : undefined),
        voiceId: request.voiceId,
    };
    const response = await apiClient.post<SpeakingScenario>('/speaking/scenarios/custom', payload);
    return response.data;
};

/**
 * Update an existing user-custom scenario
 */
export const updateCustomScenario = async (
    id: number,
    request: CreateCustomScenarioRequest
): Promise<SpeakingScenario> => {
    const canonicalMission = (request.mission || request.learnerGoal || "").trim();
    const payload = {
        topic: request.topic.trim(),
        cefrLevel: request.cefrLevel,
        context: request.context.trim(),
        learnerRole: request.learnerRole.trim(),
        aiRole: request.aiRole.trim(),
        mission: canonicalMission,
        targetVocabulary: request.targetVocabulary,
        targetTurns: request.targetTurns ?? request.desiredTurns,
        estimatedDuration: request.estimatedDuration ?? (request.estimatedMinutes ? `${request.estimatedMinutes} phút` : undefined),
        voiceId: request.voiceId,
    };
    const response = await apiClient.put<SpeakingScenario>(`/speaking/scenarios/${id}`, payload);
    return response.data;
};

/**
 * Delete a user-custom scenario
 */
export const deleteCustomScenario = async (id: number): Promise<void> => {
    await apiClient.delete(`/speaking/scenarios/${id}`);
};

/**
 * Retrieve single speaking scenario detail by ID (full instructional contract)
 */
export const getSpeakingScenarioById = async (id: number): Promise<SpeakingScenario> => {
    const response = await apiClient.get<SpeakingScenario>(`/speaking/scenarios/${id}`);
    return response.data;
};

/**
 * Resolve canonical curriculum context (Vocabulary Course, Reading Material, Listening Material)
 * for seamless cross-module Speaking handoff.
 */
export const getSpeakingContext = async (
    sourceType: string,
    sourceId: number
): Promise<SpeakingContext> => {
    const response = await apiClient.get<SpeakingContext>('/speaking/context', {
        params: {
            sourceType,
            sourceId,
        },
    });
    return response.data;
};

/**
 * Submit spoken audio turn for an active AI Role-play conversation session.
 * Includes idempotent clientTurnId to safely prevent duplicate turn generation on retry.
 */
export const submitRoleplayTurn = async (
    sessionId: number,
    audioBlob: Blob,
    clientTurnId: string,
    signal?: AbortSignal
): Promise<RoleplayTurnResponse> => {
    const formData = new FormData();
    const filename = getAudioUploadFilename(audioBlob.type, 'turn');

    formData.append('file', audioBlob, filename);
    formData.append('clientTurnId', clientTurnId);

    const response = await apiClient.post<RoleplayTurnResponse>(
        `/speaking/sessions/${sessionId}/turns`,
        formData,
        {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
            timeout: 90000,
            signal,
        }
    );
    return response.data;
};

/**
 * Retrieve the full chronological conversation turns for a speaking session.
 */
export const getRoleplayTurns = async (sessionId: number): Promise<SpeakingTurn[]> => {
    const response = await apiClient.get<SpeakingTurn[]>(`/speaking/sessions/${sessionId}/turns`);
    return response.data;
};

/**
 * Retrieve or on-demand generate evidence-based post-turn feedback (max 1-2 corrections) for a learner turn.
 */
export const getTurnFeedback = async (
    sessionId: number,
    turnId: number
): Promise<SpeakingTurnFeedback> => {
    const response = await apiClient.post<SpeakingTurnFeedback>(
        `/speaking/sessions/${sessionId}/turns/${turnId}/feedback`
    );
    return response.data;
};

/**
 * Retrieve turn-specific acoustic pronunciation metrics evaluated by V2.2.
 */
export const getTurnPronunciation = async (
    sessionId: number,
    turnId: number
): Promise<PronunciationV2Response> => {
    const response = await apiClient.get<PronunciationV2Response>(
        `/speaking/sessions/${sessionId}/turns/${turnId}/pronunciation`
    );
    return response.data;
};

export interface CorrectionCategoryCount {
    category: string;
    count: number;
}

export interface AlignmentIssueCount {
    issue: string;
    count: number;
}

export type SpeakingProgress = SpeakingProgressResponse;

/**
 * Fetch aggregated speaking progress, qualified speaking time, and learner weakness profile.
 */
export const getSpeakingProgress = async (): Promise<SpeakingProgress> => {
    const response = await apiClient.get<SpeakingProgress>('/speaking/progress');
    return response.data;
};

export interface SpeakingShadowingUnit {
    id: number;
    materialId: number;
    sequenceNumber: number;
    startTimeMs: number;
    endTimeMs: number;
    displayText: string;
    attemptCount: number;
    bestAccuracy?: number | null;
    isPracticed: boolean;
    ipa?: string | null;
    wordIpaJson?: string | null;
    translation?: string | null;
}

export interface SpeakingShadowingAttemptRequest {
    clientAttemptId: string;
    unitId: number;
    durationSeconds?: number;
}

export interface SpeakingShadowingAttemptResponse {
    id: number;
    sessionId: number;
    unitId?: number;
    segmentId?: number;
    clientAttemptId: string;
    learnerTranscript?: string;
    accuracyScore?: number | null;
    pronunciationScore?: number | null;
    fluencyScore?: number | null;
    durationSeconds?: number;
    isMocked: boolean;
    parentAttemptId?: string | null;
    retryIndex?: number;
    activeTargetId?: string | null;
    primaryIssueType?: string | null;
    targetWord?: string | null;
    retryComparisonState?: string | null;
    resolvedThisSession?: boolean;
    analysisStatus?: string;
    productSafeResultJson?: string;
    productContractVersion?: string;
    artifactSetId?: string;
    audioRef?: string | null;
    createdAt: string;
}

export interface ShadowingAnalysisResponse {
    clientAttemptId: string;
    learnerTranscript: string;
    transcription?: string; // alias for compatibility
    accuracyScore: number | null; // Content match score (0-100)
    pronunciationScore: number | null; // Real V2.2 acoustic score (0-100), or null
    fluencyScore: number | null; // Real V2.2 fluency score (0-100), or null
    wordAlignment?: WordAlignmentItem[];
    pronunciationV2?: PronunciationV2Response | null;
    isMocked?: boolean;
    feedback?: string | null;
    durationSeconds?: number;
    primaryIssueType?: string | null;
    targetWord?: string | null;
    productSafeResultJson?: string | null;
    audioRef?: string | null;
}

export interface ShadowingSegmentProgress {
    unitId?: number;
    segmentId?: number;
    attemptCount: number;
    bestAccuracy?: number | null;
    isPracticed?: boolean;
}

export interface EcsmWordAssessment {
    word_index: number;
    word: string;
    status: 'NO_SAFE_ISSUE' | 'HIGH_CONFIDENCE_ISSUE' | 'POSSIBLE_ISSUE' | 'VALID_VARIANT' | 'UNCERTAIN' | 'NOT_ASSESSED';
    phones?: Array<{
        phone: string;
        observed_phone: string | null;
        error_probability: number;
        trust_status: string;
        is_variant: boolean;
    }>;
    primary_issue?: {
        issue_id: string;
        category: string;
        severity: string;
        priority: string;
        evidence: string;
    } | null;
}

export interface EcsmPrimaryTarget {
    target_id: string;
    target_level: string;
    entity_index: number;
    entity_label: string;
    issue_category: string;
    expected_phone?: string | null;
    observed_phone?: string | null;
    articulatory_cue?: string | null;
}

export interface EcsmDrillPlan {
    drill_id: string;
    drill_type: string;
    target_id: string;
    cue: string;
    minimal_pair?: {
        target_word: string;
        contrast_word: string;
        target_phone: string;
        contrast_phone: string;
    } | null;
    scaffold_level: string;
    next_action: string;
}

export interface EcsmRetryComparison {
    comparison_state: 'IMPROVED' | 'INCONCLUSIVE' | 'UNCHANGED' | 'WORSENED' | 'TARGET_NOT_FOUND' | 'AUDIO_QUALITY_INVALID';
    target_id: string;
    message: string;
    resolved_this_session: boolean;
    next_action: string;
}

export interface EcsmAnalysisResponse {
    requestId: string;
    status: 'COMPLETE' | 'PARTIAL_SUCCESS' | 'INSUFFICIENT_AUDIO' | 'FAILED';
    assessmentStatus?: 'NO_ISSUE_DETECTED' | 'ISSUE_DETECTED' | 'INSUFFICIENT_EVIDENCE' | 'ASSESSMENT_UNAVAILABLE' | 'PARTIAL';
    evidenceCoverage?: number;
    targetWordCoverage?: number;
    targetPhoneCoverage?: number;
    alignmentCoverage?: number;
    contentMatchPercentage?: number;
    contentMatchRatio?: number;
    contentGateMinMatch?: number;
    recognizedTranscript?: string | null;
    matchedTargetWordIndices?: number[];
    sameAudioVerified?: boolean;
    audioIdentity?: string;
    attemptId?: string;
    caseId?: string;
    errorCode: string;
    errorMessage?: string | null;
    retryable?: boolean;
    quality?: {
        durationSec: number;
        rmsEnergyDb: number;
        snrEstimateDb: number;
        isClipping: boolean;
        isSilent: boolean;
        qualityStatus: string;
    };
    segmentalAvailable: boolean;
    prosodyAvailable: boolean;
    assessment?: {
        utterance_id: string;
        overall_score: null;
        words: EcsmWordAssessment[];
        top_issues: Array<{
            issue_id: string;
            category: string;
            severity: string;
            evidence: string;
        }>;
        product_safety_tier: string;
    };
    retryPlan?: {
        primary_target: EcsmPrimaryTarget;
        drill: EcsmDrillPlan;
        session_state?: {
            session_id: string;
            active_target_id?: string;
            target_state: string;
        };
    };
    retryComparison?: EcsmRetryComparison | null;
    warnings?: string[];
    gatingReasons?: string[];
    failureStage?: string | null;
    exceptionType?: string | null;
    internalReasonCode?: string | null;
    auditTrace?: Record<string, unknown> | null;
}

/**
 * Executes unified ECSM acoustic pronunciation analysis with zero score hallucination.
 */
export const analyzeEcsmSpeech = async (
    audioBlob: Blob,
    options?: {
        expectedText?: string;
        unitId?: number;
        referenceMode?: string;
        sessionId?: string;
        attemptId?: string;
        caseId?: string;
        parentAttemptId?: string;
        activeTargetId?: string;
    }
): Promise<EcsmAnalysisResponse> => {
    const formData = new FormData();
    const filename = getAudioUploadFilename(audioBlob.type, 'recording');
    formData.append('file', audioBlob, filename);
    console.debug('shadowing_audio_upload', {
        filename,
        blobType: audioBlob.type || 'application/octet-stream',
        blobSize: audioBlob.size,
    });
    if (options?.expectedText) formData.append('expectedText', options.expectedText);
    if (options?.unitId != null) formData.append('unitId', options.unitId.toString());
    if (options?.referenceMode) formData.append('referenceMode', options.referenceMode);
    if (options?.sessionId) formData.append('sessionId', options.sessionId);
    if (options?.attemptId) formData.append('attemptId', options.attemptId);
    if (options?.caseId) formData.append('caseId', options.caseId);
    if (options?.parentAttemptId) formData.append('parentAttemptId', options.parentAttemptId);
    if (options?.activeTargetId) formData.append('activeTargetId', options.activeTargetId);

    const response = await apiClient.post<EcsmAnalysisResponse>(
        '/speaking/ecsm/analyze',
        formData,
        {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: 25000,
        }
    );
    return response.data;
};

export interface PronunciationV2WordPhone {
    phoneIndex: number;
    wordIndex: number;
    expectedPhone: string;
    acceptedRealizations: string[];
    qualityClass: 'ACCEPTABLE' | 'WEAK' | 'UNCERTAIN' | 'ERROR';
    qualityScore: number;
    qualityConfidence: number;
    alignmentConfidence: number;
    observedPhone?: string | null;
    observedPhoneConfidence?: number | null;
    diagnosisType: string;
    actionable: boolean;
    abstentionReason?: string | null;
    startTimeMs?: number | null;
    endTimeMs?: number | null;
}

export interface PronunciationV2Word {
    wordIndex: number;
    word: string;
    status: 'GOOD' | 'NEEDS_WORK' | 'UNCERTAIN' | 'OFF_SCRIPT' | 'OMITTED' | 'NOT_SCORED';
    accuracyScore?: number | null;
    stressAccuracy?: number | null;
    expectedStress?: number | null;
    observedStress?: number | null;
    phones: PronunciationV2WordPhone[];
    actionable?: boolean;
    startTimeMs?: number | null;
    endTimeMs?: number | null;
}

export interface PronunciationV2Priority {
    priorityRank: number;
    targetType: 'PHONE' | 'STRESS' | 'INTONATION' | 'RHYTHM' | 'CONNECTED_SPEECH' | string;
    targetUnit: string;
    word: string;
    phone?: string | null;
    observed?: string | null;
    issue: string;
    instructionVi: string;
    instructionEn: string;
    evidence?: Record<string, unknown>;
}

export interface PronunciationV2AudioQuality {
    durationSec?: number;
    rmsEnergyDb?: number;
    snrEstimateDb?: number;
    snrDb?: number;
    isClipping?: boolean;
    clippingRatio?: number;
    isSilent?: boolean;
    silenceRatio?: number;
    speechRatio?: number;
    qualityStatus?: 'GOOD' | 'ACCEPTABLE' | 'POOR' | 'UNUSABLE' | string;
    warnings?: string[];
}

export interface PronunciationV2ContentFidelity {
    fidelityStatus?: 'MATCHED' | 'PASS' | 'PARTIAL' | 'OFF_SCRIPT' | 'QUARANTINED' | string;
    matchPercentage?: number | null;
    wordMatchRatio?: number | null;
    matchedWordsCount?: number | null;
    totalExpectedWords?: number | null;
    // Legacy fallback fields preserved for older stored history rows
    status?: 'MATCHED' | 'PASS' | 'PARTIAL' | 'OFF_SCRIPT' | 'QUARANTINED' | string;
    contentMatchPercentage?: number | null;
    contentMatchRatio?: number | null;
    freeTranscript?: string | null;
    expectedText?: string | null;
    alignedWords?: Array<{
        targetIndex?: number | null;
        targetWord?: string | null;
        recognizedWord?: string | null;
        status: string;
        startTimeSec?: number | null;
        endTimeSec?: number | null;
        confidence?: number | null;
    }>;
    matchedIslands?: Array<{
        islandIndex?: number;
        targetStartIdx?: number;
        targetEndIdx?: number;
        words?: string[];
        startTimeSec?: number;
        endTimeSec?: number;
    }>;
}

export interface PronunciationV2ConnectedSpeech {
    finalStopReleaseRate?: number | null;
    preFortisVowelRatio?: number | null;
    cvLinkingContinuity?: number | null;
    linkingScore?: number | null;
    linkingCount?: number | null;
    finalStopsAssessed?: number | null;
    finalStopsReleased?: number | null;
    summaryVi?: string | null;
    summaryEn?: string | null;
    notesVi?: string[];
    [key: string]: unknown;
}

export interface PronunciationV2Response {
    requestId: string;
    engineVersion: string;
    status: 'COMPLETED' | 'ABSTAINED' | 'FAILED';
    abstentionReason?: string | null;
    lexicalStress?: {
        method: string;
        status: 'ASSESSED' | 'INSUFFICIENT_EVIDENCE';
        assessed: number;
        matched: number;
        words: { word: string; expectedSyllable: number; observedSyllable: number; matched: boolean }[];
    };
    overall?: {
        overallScore?: number | null;
        segmentalScore?: number | null;
        stressScore?: number | null;
        intonationScore?: number | null;
        rhythmScore?: number | null;
        fluencyScore?: number | null;
        passed?: boolean;
        feedbackCategory?: string;
    } | null;
    audioQuality?: PronunciationV2AudioQuality | null;
    contentFidelity?: PronunciationV2ContentFidelity | null;
    connectedSpeech?: PronunciationV2ConnectedSpeech | null;
    words: PronunciationV2Word[];
    phones: PronunciationV2WordPhone[];
    prosody?: {
        speechRate?: number;
        articulationRate?: number;
        pauseDuration?: number;
        pauseCount?: number;
        phonationRatio?: number;
        meanF0?: number;
        medianF0?: number;
        f0Contour?: number[];
        f0ContourCorrelation?: number;
        humanHolisticFluencyScore?: number;
        taskConfidence?: number;
        terminalSlope?: number | string | null;
        terminalContour?: string | null;
        nPviV?: number | null;
        varcoV?: number | null;
        abstentionReason?: string | null;
    } | null;
    strengths: string[];
    priorities: PronunciationV2Priority[];
    abstentions: Array<{
        level: string;
        scope: string;
        reason: string;
    }>;
    timing: Record<string, number>;
}

/**
 * Executes canonical Pronunciation Engine V2 assessment.
 */
export const analyzePronunciationV2Speech = async (
    audioBlob: Blob,
    options: {
        expectedText: string;
        freeTranscript?: string;
        sessionId?: string;
        attemptId?: string;
    }
): Promise<PronunciationV2Response> => {
    const formData = new FormData();
    const filename = getAudioUploadFilename(audioBlob.type, 'recording');
    formData.append('file', audioBlob, filename);
    formData.append('expectedText', options.expectedText);
    formData.append('expected_text', options.expectedText);
    if (options.freeTranscript) {
        formData.append('freeTranscript', options.freeTranscript);
        formData.append('free_transcript', options.freeTranscript);
    }
    if (options.sessionId) {
        formData.append('sessionId', options.sessionId);
        formData.append('session_id', options.sessionId);
    }
    if (options.attemptId) {
        formData.append('attemptId', options.attemptId);
        formData.append('attempt_id', options.attemptId);
    }

    const response = await apiClient.post<PronunciationV2Response>(
        '/speaking/v2/pronunciation/analyze',
        formData,
        {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: 25000,
        }
    );
    return response.data;
};

export const getAudioUploadFilename = (mimeType: string | undefined, stem: string): string => {
    const normalized = (mimeType || '').toLowerCase();
    if (normalized.includes('webm')) return `${stem}.webm`;
    if (normalized.includes('ogg')) return `${stem}.ogg`;
    if (normalized.includes('mp4') || normalized.includes('m4a')) return `${stem}.mp4`;
    if (normalized.includes('wav') || normalized.includes('wave')) return `${stem}.wav`;
    if (normalized.includes('mpeg') || normalized.includes('mp3')) return `${stem}.mp3`;
    return `${stem}.bin`;
};

/**
 * Canonical single-submission Shadowing analysis.
 * Uploads audio exactly once to Spring Boot gateway (/api/v1/speaking/shadowing/analyze),
 * which orchestrates Whisper STT for content match and Pronunciation V2.2 for acoustic scoring.
 */
export const analyzeShadowingAudio = async (
    audioBlob: Blob,
    params: {
        expectedText: string;
        unitId?: number;
        sessionId?: string | number;
        attemptId?: string;
        parentAttemptId?: string;
        activeTargetId?: string;
        signal?: AbortSignal;
    }
): Promise<ShadowingAnalysisResponse> => {
    const formData = new FormData();
    const filename = getAudioUploadFilename(audioBlob.type, 'recording');
    formData.append('file', audioBlob, filename);
    formData.append('expectedText', params.expectedText.trim().replace(/^["']|["']$/g, ''));
    if (params.unitId != null) formData.append('unitId', params.unitId.toString());
    if (params.sessionId != null) formData.append('sessionId', params.sessionId.toString());
    if (params.attemptId) formData.append('attemptId', params.attemptId);
    if (params.parentAttemptId) formData.append('parentAttemptId', params.parentAttemptId);
    if (params.activeTargetId) formData.append('activeTargetId', params.activeTargetId);

    const response = await apiClient.post<ShadowingAnalysisResponse>(
        '/speaking/shadowing/analyze',
        formData,
        {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: 90000,
            signal: params.signal,
        }
    );
    return response.data;
};

/**
 * Lazy load or generate IPA for a shadowing unit with DB persistence
 */
export const getOrGenerateUnitIpa = async (
    unitId: number,
    signal?: AbortSignal
): Promise<{ unitId: number; ipa?: string | null; wordIpaJson?: string | null }> => {
    const response = await apiClient.post<{ unitId: number; ipa?: string | null; wordIpaJson?: string | null }>(
        `/speaking/shadowing/units/${unitId}/ipa`,
        null,
        { signal }
    );
    return response.data;
};

/**
 * Lazy load or generate natural Vietnamese translation for a shadowing unit with DB persistence
 */
export const getOrGenerateUnitTranslation = async (
    unitId: number,
    signal?: AbortSignal
): Promise<{ unitId: number; translation?: string | null }> => {
    const response = await apiClient.post<{ unitId: number; translation?: string | null }>(
        `/speaking/shadowing/units/${unitId}/translation`,
        null,
        { signal }
    );
    return response.data;
};

/**
 * Fetch or idempotently generate clean, non-overlapping ShadowingPracticeUnits for a material
 */
export const getShadowingUnits = async (
    materialId: number
): Promise<SpeakingShadowingUnit[]> => {
    const response = await apiClient.get<SpeakingShadowingUnit[]>(
        `/speaking/shadowing/materials/${materialId}/units`
    );
    return response.data;
};

/**
 * Record a genuine shadowing attempt with 3NF persistence and idempotency
 */
export const recordShadowingAttempt = async (
    sessionId: number,
    request: SpeakingShadowingAttemptRequest
): Promise<SpeakingShadowingAttemptResponse> => {
    const response = await apiClient.post<SpeakingShadowingAttemptResponse>(
        `/speaking/sessions/${sessionId}/shadowing-attempts`,
        request
    );
    return response.data;
};

/**
 * Retrieve user's shadowing progress across all units for a specific listening material
 */
export const getMaterialShadowingProgress = async (
    materialId: number
): Promise<ShadowingSegmentProgress[]> => {
    const response = await apiClient.get<ShadowingSegmentProgress[]>(
        `/speaking/materials/${materialId}/shadowing-progress`
    );
    return response.data;
};

/**
 * Retrieve user's shadowing progress across all units for an active session
 */
export const getSessionShadowingProgress = async (
    sessionId: number
): Promise<ShadowingSegmentProgress[]> => {
    const response = await apiClient.get<ShadowingSegmentProgress[]>(
        `/speaking/sessions/${sessionId}/shadowing-progress`
    );
    return response.data;
};

export interface ShadowingSessionState {
    sessionId: number;
    status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
    mode: string;
    sourceType?: string;
    sourceId?: number;
    currentUnitIndex: number;
    completedUnitsCount: number;
    totalUnitsCount: number;
    activeUnitId?: number | null;
    activeTargetId?: string | null;
    activeAttempt?: SpeakingShadowingAttemptResponse | null;
    unitStates?: Record<number, string>;
    rehydratedEcsmResult?: EcsmAnalysisResponse | null;
    recentAttempts?: SpeakingShadowingAttemptResponse[];
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Hydrates or creates the authoritative backend Shadowing session for a material.
 */
export const getOrCreateActiveShadowingSession = async (
    materialId: number
): Promise<ShadowingSessionState> => {
    const response = await apiClient.get<ShadowingSessionState>(
        `/speaking/shadowing/sessions/active?materialId=${materialId}`
    );
    return response.data;
};

/**
 * Retrieves the complete durable state of a Shadowing session.
 */
export const getShadowingSessionState = async (
    sessionId: number
): Promise<ShadowingSessionState> => {
    const response = await apiClient.get<ShadowingSessionState>(
        `/speaking/shadowing/sessions/${sessionId}/state`
    );
    return response.data;
};

/**
 * Advances the session progression to the next sentence unit and marks completion.
 */
export const advanceShadowingSession = async (
    sessionId: number,
    unitId?: number,
    action: 'COMPLETE' | 'SKIP' | 'NEXT' = 'COMPLETE'
): Promise<ShadowingSessionState> => {
    const response = await apiClient.post<ShadowingSessionState>(
        `/speaking/shadowing/sessions/${sessionId}/advance`,
        null,
        {
            params: { unitId, action }
        }
    );
    return response.data;
};

// =====================================================================
// P14 SPEAKING LEARNING / PROGRESS / HISTORY TYPES & API
// =====================================================================

export interface SpeakingPracticeSummary {
    sessionsCompleted7d: number;
    sessionsCompleted30d: number;
    sentencesPracticed7d: number;
    sentencesPracticed30d: number;
    practiceDays7d: number;
    practiceDays30d: number;
    retries30d: number;
    resolvedThisSessionCount30d: number;
}

export interface SpeakingIssueExample {
    targetWord?: string;
    sentenceSnippet?: string;
    originalPhrase?: string;
    suggestedPhrase?: string;
    explanation?: string;
    sourceTitle?: string;
    sourceId?: number;
    mode?: 'SHADOWING' | 'ROLEPLAY' | 'QUICK_CHECK';
    timestamp?: string;
}

export interface SpeakingRecurringIssue {
    issueKey: string;
    category?: 'PRONUNCIATION' | 'GRAMMAR' | 'VOCABULARY' | 'NATURALNESS' | 'STRESS';
    title?: string;
    issueType: string;
    targetWord?: string | null;
    targetPhone?: string | null;
    status?: 'INSUFFICIENT_DATA' | 'NEEDS_ATTENTION' | 'PRACTICING' | 'IMPROVING' | 'RECENTLY_STABLE';
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

export interface SpeakingRecentActivity {
    sessionId: number;
    mode: 'SHADOWING' | 'ROLEPLAY' | 'QUICK_CHECK' | string;
    title: string;
    contentTitle?: string;
    summary?: string;
    status: string;
    durationSeconds: number;
    targetWord?: string;
    sourceId?: number;
    completedUnits?: number;
    totalUnits?: number;
    createdAt: string;
}

export interface SpeakingWeaknessProfile {
    issues?: SpeakingRecurringIssue[];
    topCorrectionCategories: Array<{ category: string; count: number }>;
    topAlignmentIssues?: Array<{ issueType: string; count: number }>;
}

export interface SpeakingProgressResponse {
    totalQualifiedSpeakingSeconds: number;
    totalCompletedSessions: number;
    totalRoleplayTurns: number;
    averageWordAccuracy?: number | null;
    targetVocabularyUsed: number;
    currentStreakDays: number;
    activeRecurringTargetsCount?: number;
    recentImprovementsCount?: number;
    weaknessProfile: SpeakingWeaknessProfile;
    recentActivity: SpeakingRecentActivity[];
}

export interface SpeakingRecentImprovement {
    sessionId: number;
    materialTitle: string;
    targetWord?: string | null;
    targetPhone?: string | null;
    issueType: string;
    retryCount: number;
    resolvedAt: string;
    note: string;
}

export interface SpeakingSessionSummary {
    sessionId: number;
    materialId?: number | null;
    materialTitle: string;
    mode: string;
    status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
    sentencesPracticed: number;
    totalSentences: number;
    attemptCount: number;
    retryCount: number;
    resolvedTargetCount: number;
    createdAt: string;
    updatedAt?: string;
}

export interface SpeakingSessionHistoryPage {
    content: SpeakingSessionSummary[];
    page: number;
    size: number;
    totalElements: number;
    totalPages: number;
    hasNext: boolean;
}

export interface SpeakingSentenceDetail {
    unitId: number;
    unitIndex: number;
    text: string;
    unitState: string;
    lockedTargetId?: string | null;
    targetWord?: string | null;
    primaryIssueType?: string | null;
    attempts: SpeakingShadowingAttemptResponse[];
}

export interface SpeakingSessionDetail {
    sessionId: number;
    materialId?: number | null;
    materialTitle: string;
    mode: string;
    status: string;
    currentUnitIndex: number;
    completedUnitsCount: number;
    totalUnitsCount: number;
    createdAt: string;
    updatedAt?: string;
    sentences: SpeakingSentenceDetail[];
    scenarioId?: number | null;
    scenarioTitle?: string | null;
    learnerRole?: string | null;
    aiRole?: string | null;
    learnerGoal?: string | null;
    targetVocabulary?: string[];
    turns?: SpeakingTurn[];
    quickCheck?: QuickCheckResponse | null;
}

export interface QuickCheckCorrection {
    type: 'GRAMMAR' | 'NATURALNESS' | 'WORD_CHOICE' | 'COLLOCATION' | string;
    original: string;
    suggestion: string;
    explanationVi: string;
}

export interface QuickCheckLanguageFeedback {
    status: 'CORRECT' | 'NEEDS_IMPROVEMENT' | string;
    positiveFeedback?: string | null;
    corrections: QuickCheckCorrection[];
    naturalVersion?: string | null;
    meaningNoteVi?: string | null;
}

export interface QuickCheckResponse {
    clientAttemptId: string;
    whisperTranscript: string;
    intendedTranscript?: string | null;
    sttStatus: string;
    pronunciationStatus: string;
    languageStatus: string;
    overallScore?: number | null;
    phonemeScore?: number | null;
    stressScore?: number | null;
    pitchScore?: number | null;
    rhythmScore?: number | null;
    fluencyScore?: number | null;
    pronunciation?: PronunciationV2Response | null;
    languageFeedback?: QuickCheckLanguageFeedback | null;
    pronunciationError?: string | null;
    languageError?: string | null;
    audioRef?: string | null;
    createdAt?: string;
}

export interface SpeakingPronunciationMetrics {
    averagePronunciationScore?: number | null;
    averageContentMatchScore?: number | null;
    averagePhonemeScore?: number | null;
    averageStressScore?: number | null;
    averagePitchScore?: number | null;
    averageRhythmScore?: number | null;
    averageFluencyScore?: number | null;
    scoredAttemptsCount: number;
    totalAttemptsCount: number;
}

export interface SpeakingProgressSummary {
    policyVersion: string;
    activeSession?: ShadowingSessionState | null;
    practiceSummary: SpeakingPracticeSummary;
    recentSessions: SpeakingSessionSummary[];
    recurringIssues: SpeakingRecurringIssue[];
    recentImprovements: SpeakingRecentImprovement[];
    pronunciationMetrics?: SpeakingPronunciationMetrics | null;
    generatedAt: string;
}

export const getAttemptAudioUrl = (clientAttemptId: string): string => {
    return `/api/v1/speaking/attempts/${encodeURIComponent(clientAttemptId)}/audio`;
};

/**
 * Retrieves the comprehensive Speaking Progress & Longitudinal Evidence Summary.
 */
export const getSpeakingProgressSummary = async (): Promise<SpeakingProgressSummary> => {
    const response = await apiClient.get<SpeakingProgressSummary>('/speaking/progress/summary');
    return response.data;
};

/**
 * Retrieves paginated Speaking practice session history.
 */
export const getSpeakingSessionHistory = async (
    page: number = 0,
    size: number = 10,
    mode?: string
): Promise<SpeakingSessionHistoryPage> => {
    const params: Record<string, any> = { page, size };
    if (mode && mode !== 'ALL') params.mode = mode;
    const response = await apiClient.get<SpeakingSessionHistoryPage>('/speaking/history', {
        params
    });
    return response.data;
};

/**
 * Retrieves full sentence-by-sentence attempt and retry timeline detail for a session.
 */
export const getSpeakingSessionDetail = async (
    sessionId: number
): Promise<SpeakingSessionDetail> => {
    const response = await apiClient.get<SpeakingSessionDetail>(`/speaking/history/${sessionId}`);
    return response.data;
};

/**
 * Retrieves distinct-session recurring pronunciation target issues.
 */
export const getSpeakingRecurringIssues = async (): Promise<SpeakingRecurringIssue[]> => {
    const response = await apiClient.get<SpeakingRecurringIssue[]>('/speaking/recurring-issues');
    return response.data;
};

/**
 * Submits learner audio for Quick Check: Whisper STT + Pronunciation V2.2 + Llama structured language check.
 */
export const analyzeQuickCheck = async (
    audioBlob: Blob,
    clientAttemptId: string,
    intendedText?: string,
    signal?: AbortSignal
): Promise<QuickCheckResponse> => {
    const formData = new FormData();
    const filename = getAudioUploadFilename(audioBlob.type, 'quick_check');
    formData.append('file', audioBlob, filename);
    formData.append('clientAttemptId', clientAttemptId);
    if (intendedText && intendedText.trim()) {
        formData.append('intendedText', intendedText.trim());
    }
    const response = await apiClient.post<QuickCheckResponse>(
        '/speaking/quick-check/analyze',
        formData,
        {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: 120000,
            signal,
        }
    );
    return response.data;
};

/**
 * Re-checks Quick Check using previously stored audio with edited transcript.
 * Zero Whisper calls, reuses existing audio from server storage.
 */
export const recheckQuickCheck = async (
    clientAttemptId: string,
    intendedText: string,
    signal?: AbortSignal
): Promise<QuickCheckResponse> => {
    const response = await apiClient.post<QuickCheckResponse>(
        '/speaking/quick-check/recheck',
        new URLSearchParams({
            clientAttemptId,
            intendedText: intendedText.trim(),
        }),
        { timeout: 120000, signal }
    );
    return response.data;
};

/**
 * Retrieves persisted Quick Check attempt result (0 Whisper, 0 Pronunciation, 0 Llama calls).
 */
export const getQuickCheckDetail = async (
    clientAttemptId: string
): Promise<QuickCheckResponse> => {
    const response = await apiClient.get<QuickCheckResponse>(
        `/speaking/quick-check/${encodeURIComponent(clientAttemptId)}`
    );
    return response.data;
};

export interface VoiceMeta {
    voiceId: 'us_male' | 'us_female' | 'uk_male' | 'uk_female' | string;
    displayName: string;
    accent: string;
    gender: 'male' | 'female' | string;
}

export const CANONICAL_VOICES: VoiceMeta[] = [
    { voiceId: 'us_male', displayName: 'American Male', accent: 'US', gender: 'male' },
    { voiceId: 'us_female', displayName: 'American Female', accent: 'US', gender: 'female' },
    { voiceId: 'uk_male', displayName: 'British Male', accent: 'UK', gender: 'male' },
    { voiceId: 'uk_female', displayName: 'British Female', accent: 'UK', gender: 'female' },
];

export const getTtsVoices = async (): Promise<VoiceMeta[]> => {
    try {
        const response = await apiClient.get<VoiceMeta[]>('/speaking/tts/voices');
        return response.data;
    } catch {
        return CANONICAL_VOICES;
    }
};

export const getTtsPreviewAudioUrl = (voiceId: string): string => {
    return `/speaking/tts/preview?voiceId=${encodeURIComponent(voiceId)}`;
};

export const getTurnAudioUrl = (sessionId: number, turnId: number): string => {
    return `/speaking/sessions/${sessionId}/turns/${turnId}/audio`;
};

export const getTtsAudioByRefUrl = (ref: string): string => {
    return `/speaking/tts/audio?ref=${encodeURIComponent(ref)}`;
};

export const synthesizeTtsBlob = async (
    voiceId: string,
    text: string,
    options?: { timeout?: number; signal?: AbortSignal }
): Promise<Blob> => {
    const response = await apiClient.post<Blob>(
        '/speaking/tts/synthesize',
        null,
        {
            params: { voiceId, text },
            responseType: 'blob',
            timeout: options?.timeout ?? 35000,
            signal: options?.signal,
        }
    );
    return response.data;
};

export const generateTurnTts = async (
    sessionId: number,
    turnId: number
): Promise<{ turnId: number; synthesizedAudioRef: string; audioUrl: string }> => {
    const response = await apiClient.post<{ turnId: number; synthesizedAudioRef: string; audioUrl: string }>(
        `/speaking/sessions/${sessionId}/turns/${turnId}/tts`
    );
    return response.data;
};
