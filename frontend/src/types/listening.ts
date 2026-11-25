export interface WordTimestamp {
    word: string;
    start: number; // in seconds
    end: number;   // in seconds
}

export interface ListeningSentenceState {
    draft: string;
    status: 'draft' | 'evaluated' | 'completed' | 'revealed';
    evaluation?: Pick<ExerciseAttemptResponse, 'id' | 'isCorrect' | 'accuracyPercentage' | 'primaryErrorCategory'>;
}
export interface ListeningWorkspaceState {
    entries: Record<string, ListeningSentenceState>;
    selectedSegmentId?: number;
    position?: number;
    preferences?: { repeatCount: number; replayGap: number; speed: number };
}
export interface ListeningCheckpoint {
    contentVersion: string;
    revision: number;
    state: ListeningWorkspaceState;
    savedAt: string | null;
}

export interface TranscriptSegment {
    id: number;
    startTimeMs: number;
    endTimeMs: number;
    speakerName: string;
    text: string;
    difficultyScore: number;
    words?: WordTimestamp[];
}

export interface ListeningLibraryItem {
    id: number;
    title: string;
    channel: string;
    topic: string;
    level: string;
    accent: string;
    durationSeconds?: number | null;
    thumbnail?: string | null;
    youtubeVideoId?: string | null;
    practiceAvailable: boolean;
    hasTranscript: boolean;
}

export interface ListeningMaterialSummary {
    sourceType?: 'VIDEO' | 'DOCUMENT';
    voiceId?: string | null;
    id: number;
    title: string;
    audioUrl: string;
    durationSeconds: number;
    cefrLevel: string;
    topic: string;
    accent: string;
    speakerCount?: number;
    ownerUserId?: number | null;
    isSystem?: boolean;
    channel?: string;
    thumbnail?: string | null;
    youtubeVideoId?: string | null;
    practiceAvailable?: boolean;
    hasTranscript?: boolean;
}

export interface ListeningDocumentJob {
    id: string;
    status: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED';
    materialId: number | null;
    message: string | null;
}

export interface ListeningMaterialDetail extends ListeningMaterialSummary {
    speechRate?: number;
    backgroundNoiseLevel?: number;
    vocabularyDifficulty?: number;
    connectedSpeechDifficulty?: number;
    inferenceDifficulty?: number;
    segments: TranscriptSegment[];
}

export type ExerciseType = 'DICTATION' | 'MCQ' | 'FILL_BLANK' | 'SENTENCE_RECONSTRUCTION';

export interface ListeningExercise {
    id: number;
    listeningMaterialId: number;
    transcriptSegmentId: number | null;
    exerciseType: ExerciseType;
    questionText: string;
    difficultyScore: number;
}

export interface ExerciseAttemptRequest {
    listeningSessionId?: number | null;
    rawUserAnswer: string;
}

export type ErrorCategory = 'EXACT_MATCH' | 'MINOR_SPELLING' | 'MISSING_WORD' | 'EXTRA_WORD' | 'WRONG_WORD' | 'PHONETIC_CONFUSION' | 'PUNCTUATION_ERROR';

export interface AiDiagnosticResponse {
    source: 'TOKEN_ALIGNMENT_RULE';
    errorCategory: ErrorCategory;
    explanation: string;
}

export interface ExerciseAttemptResponse {
    id: number;
    listeningSessionId?: number;
    isCorrect: boolean;
    accuracyPercentage: number;
    primaryErrorCategory: ErrorCategory;
    expectedAnswer: string;
    rawUserAnswer: string;
    diagnosticFeedback?: AiDiagnosticResponse;
}

export interface SegmentHeatmapDto {
    segmentId: number;
    averageAccuracy: number;
}

export interface WordErrorItem {
    word: string;
    count: number;
}

export interface WordSubstitutionItem {
    expectedWord: string;
    userWord: string;
    count: number;
}

export interface AlignedDiffItem {
    expectedWord: string | null;
    userWord: string | null;
    type: string; // MISSING, EXTRA, SUBSTITUTION, SPELLING, MATCH
    label: string; // BỎ SÓT, VIẾT THỪA, NGHE NHẦM, LỖI CHÍNH TẢ, ĐÚNG
}

export interface RepresentativeErrorItem {
    exerciseId: number;
    expectedSentence: string;
    rawUserAnswer: string;
    alignedDiffs: AlignedDiffItem[];
}

export interface ErrorDNADto {
    overallAccuracy: number | null;
    totalAttempts?: number;
    errorBreakdownPercentage: Record<string, number>;
    topMissingWords?: WordErrorItem[];
    topExtraWords?: WordErrorItem[];
    topSubstitutions?: WordSubstitutionItem[];
    topSpellingErrors?: WordSubstitutionItem[];
    representativeErrors?: RepresentativeErrorItem[];
    practicePriorities?: string[];
}

export interface ListeningCategory {
    topic: string;
    count: number;
    items: ListeningLibraryItem[];
}

export interface ImportListeningRequest {
    youtubeUrl: string;
    title?: string;
    cefrLevel?: string;
    topic?: string;
    accent?: string;
    channel?: string;
}

