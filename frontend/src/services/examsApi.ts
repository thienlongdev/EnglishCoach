import { apiClient } from '@/services/api-client';
import {
  CatalogFormDto,
  CatalogWindowDto,
  PublicManifestDto,
  AttemptStateDto,
  ResponseBatchItem,
  ResponseSaveReceiptDto,
  ExamResultDto,
  ScoringProgressDto,
  AttemptReviewDto,
  SpeakingAttemptReviewDto,
  IeltsProfileDto,
  ToeicProfileDto,
  RecommendationDto,
  AttemptHistoryItemDto,
  ExamFamily,
  ExamAttemptMode,
  SpeakingRuntimeStateDto,
  SpeakingTurnDto,
  StartPreparationCommand,
  StartRecordingCommand,
  StopRecordingCommand,
  CompleteTurnCommand,
  ActiveSimulationAttemptSummary,
  PracticeCatalogDto,
  PracticeAttemptDto,
  PracticeResultDto,
  PracticeReviewDto,
  ExamAnalyticsDto,
} from '@/types/exams';

export const examsApi = {
  // ─── Catalog ─────────────────────────────────────────────────────────────

  async getCatalog(params: {
    family?: ExamFamily;
    variant?: string;
    scope?: string;
    page?: number;
    offset?: number;
    availability?: string;
    query?: string;
    formId?: string;
    limit?: number;
  }): Promise<CatalogWindowDto> {
    const res = await apiClient.get('/exams/catalog', { params });
    if (Array.isArray(res.data)) {
      return {
        forms: res.data,
        total: res.data.length,
        page: 1,
        totalPages: 1,
      };
    }
    return res.data;
  },

  async getCapabilities(): Promise<{ supportedFamilies: string[]; ready: boolean }> {
    const res = await apiClient.get('/exams/capabilities');
    return res.data;
  },

  async getFormDetails(formId: string): Promise<CatalogFormDto> {
    const res = await apiClient.get(`/exams/forms/${formId}`);
    return res.data;
  },

  // ─── Attempt Lifecycle ───────────────────────────────────────────────────

  async createAttempt(
    formId: string,
    mode: ExamAttemptMode = 'EXAM_SIMULATION',
    commandId?: string,
    selectedSkills?: string[],
    aiAssessmentConsent = false
  ): Promise<{ attemptId: string; status: string; scheduledEndAt: string }> {
    const cmdId = commandId || `cmd-create-${Date.now()}`;
    const payload = { formId, mode, selectedSkills, aiAssessmentConsent, clientMutationId: cmdId };
    const res = await apiClient.post(
      '/exams/attempts',
      payload,
      { headers: { 'X-Command-Id': cmdId } }
    );
    return res.data;
  },

  async readyAttempt(
    attemptId: string,
    commandId?: string
  ): Promise<{ attemptId: string; status: string; readyAt: string }> {
    const cmdId = commandId || `cmd-ready-${Date.now()}`;
    const res = await apiClient.post(
      `/exams/attempts/${attemptId}/ready`,
      {},
      { headers: { 'X-Command-Id': cmdId } }
    );
    return res.data;
  },

  async startAttempt(
    attemptId: string,
    commandId?: string
  ): Promise<{ attemptId: string; status: string; startedAt: string; deadlineAt: string }> {
    const cmdId = commandId || `cmd-start-${Date.now()}`;
    const res = await apiClient.post(
      `/exams/attempts/${attemptId}/start`,
      {},
      { headers: { 'X-Command-Id': cmdId } }
    );
    return res.data;
  },

  async getAttemptState(attemptId: string): Promise<AttemptStateDto> {
    const res = await apiClient.get(`/exams/attempts/${attemptId}`);
    return res.data;
  },

  async getActiveSimulation(): Promise<ActiveSimulationAttemptSummary | null> {
    try {
      const res = await apiClient.get('/exams/attempts/active-simulation');
      if (res.status === 204 || !res.data) {
        return null;
      }
      return res.data;
    } catch {
      return null;
    }
  },

  async abandonAttempt(attemptId: string): Promise<{ attemptId: string; status: string; message: string }> {
    const res = await apiClient.post(`/exams/attempts/${attemptId}/abandon`);
    return res.data;
  },

  async getManifest(attemptId: string): Promise<PublicManifestDto> {
    const res = await apiClient.get(`/exams/attempts/${attemptId}/manifest`);
    return res.data;
  },

  async saveResponses(
    attemptId: string,
    baseRevision: number,
    responses: ResponseBatchItem[],
    commandId?: string
  ): Promise<ResponseSaveReceiptDto> {
    const cmdId = commandId || `cmd-save-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const res = await apiClient.put(
      `/exams/attempts/${attemptId}/responses`,
      { expectedAttemptRevision: baseRevision, clientMutationId: cmdId, responses },
      { headers: { 'X-Command-Id': cmdId } }
    );
    return res.data;
  },

  async submitAttempt(
    attemptId: string,
    expectedAttemptRevision: number = 0,
    reason: string = 'MANUAL',
    commandId?: string,
    flushToken?: string
  ): Promise<{ submissionId: string; status: string; submittedAt: string }> {
    const cmdId = commandId || `cmd-submit-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const res = await apiClient.post(
      `/exams/attempts/${attemptId}/submit`,
      { reason, clientMutationId: cmdId, expectedAttemptRevision, flushToken },
      { headers: { 'X-Command-Id': cmdId } }
    );
    return res.data;
  },

  async completeSection(
    attemptId: string,
    sectionId: string,
    body?: { commandId?: string; expectedAttemptRevision?: number; flushToken?: string }
  ): Promise<AttemptStateDto> {
    const res = await apiClient.post(`/exams/attempts/${attemptId}/sections/${sectionId}/complete`, body || {});
    return res.data;
  },

  async takeoverSession(
    attemptId: string,
    commandId?: string
  ): Promise<{ attemptId: string; token: string; epoch: number }> {
    const cmdId = commandId || `cmd-takeover-${Date.now()}`;
    const res = await apiClient.post(
      `/exams/attempts/${attemptId}/takeover`,
      {},
      { headers: { 'X-Command-Id': cmdId } }
    );
    return res.data;
  },

  async getHistory(params?: {
    family?: ExamFamily;
    limit?: number;
    offset?: number;
  }): Promise<AttemptHistoryItemDto[]> {
    const res = await apiClient.get('/exams/history', { params });
    return res.data;
  },

  // ─── Results & Review ────────────────────────────────────────────────────

  async getResult(attemptId: string, signal?: AbortSignal): Promise<ExamResultDto | ScoringProgressDto> {
    const res = await apiClient.get(`/exams/results/${attemptId}`, { signal, timeout: 10000 });
    return res.data;
  },

  async getReview(attemptId: string): Promise<AttemptReviewDto> {
    const res = await apiClient.get(`/exams/results/${attemptId}/review`);
    return res.data;
  },

  async getSpeakingReview(attemptId: string): Promise<SpeakingAttemptReviewDto> {
    const res = await apiClient.get(`/exams/results/${attemptId}/speaking-review`);
    return res.data;
  },

  // ─── Competency Profiles ─────────────────────────────────────────────────

  async getIeltsProfile(): Promise<IeltsProfileDto> {
    const res = await apiClient.get('/exams/profiles/ielts');
    return res.data;
  },

  async getToeicProfile(): Promise<ToeicProfileDto> {
    const res = await apiClient.get('/exams/profiles/toeic');
    return res.data;
  },

  async createPlaybackGrant(
    attemptId: string,
    assetId: string,
    purpose: string = 'SIMULATION_LISTENING'
  ): Promise<{ grantToken: string; assetId: string; streamUrl: string; mediaStreamUrl?: string; maxPlays: number; expiresAt: string }> {
    const res = await apiClient.post(`/exams/attempts/${attemptId}/playback-grants`, {
      assetId,
      purpose,
    });
    const mediaStreamUrl = res.data.mediaStreamUrl || res.data.streamUrl;
    return {
      ...res.data,
      mediaStreamUrl,
      streamUrl: mediaStreamUrl,
    };
  },

  // ─── Practice + Review (Exams Phase 6) ───────────────────────────────────
  // The client names a form and a canonical scope code only; the server resolves the content.

  async getPracticeScopes(formId: string): Promise<PracticeCatalogDto> {
    const res = await apiClient.get(`/exams/forms/${formId}/practice-scopes`);
    return res.data;
  },

  async createPracticeAttempt(formId: string, scopeCode: string, clientMutationId?: string): Promise<PracticeAttemptDto> {
    const cmdId = clientMutationId || `cmd-practice-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const res = await apiClient.post('/exams/practice/attempts', { formId, scopeCode, clientMutationId: cmdId });
    return res.data;
  },

  async practiceAgain(attemptId: string, clientMutationId?: string): Promise<PracticeAttemptDto> {
    const cmdId = clientMutationId || `cmd-practice-again-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const res = await apiClient.post(`/exams/practice/attempts/${attemptId}/again`, { clientMutationId: cmdId });
    return res.data;
  },

  async getPracticeResult(attemptId: string): Promise<PracticeResultDto> {
    const res = await apiClient.get(`/exams/practice/attempts/${attemptId}/result`);
    return res.data;
  },

  async getPracticeReview(attemptId: string): Promise<PracticeReviewDto> {
    const res = await apiClient.get(`/exams/practice/attempts/${attemptId}/review`);
    return res.data;
  },

  // ─── Learner analytics + recommended practice (Exams Phase 8) ─────────────
  // Read-only, owner-scoped by the server (no user id parameter), deterministic, no AI.

  async getAnalytics(family?: ExamFamily): Promise<ExamAnalyticsDto> {
    const res = await apiClient.get('/exams/analytics', { params: family ? { family } : {} });
    return res.data;
  },

  async getRecommendations(): Promise<RecommendationDto[]> {
    const res = await apiClient.get('/exams/profiles/recommendations');
    return res.data;
  },

  // ─── Speaking Runtime Flow ────────────────────────────────────────────────

  async getSpeakingState(attemptId: string): Promise<SpeakingRuntimeStateDto> {
    const res = await apiClient.get(`/exams/attempts/${attemptId}/speaking/state`);
    return res.data;
  },

  async getSpeakingTurn(attemptId: string, turnKey: string): Promise<SpeakingTurnDto> {
    const res = await apiClient.get(`/exams/attempts/${attemptId}/speaking/turns/${turnKey}`);
    return res.data;
  },

  async startSpeakingPreparation(
    attemptId: string,
    cmd?: StartPreparationCommand
  ): Promise<SpeakingRuntimeStateDto> {
    const res = await apiClient.post(`/exams/attempts/${attemptId}/speaking/prepare`, cmd || {});
    return res.data;
  },

  async startSpeakingRecording(
    attemptId: string,
    cmd?: StartRecordingCommand
  ): Promise<SpeakingRuntimeStateDto> {
    const res = await apiClient.post(`/exams/attempts/${attemptId}/speaking/start-recording`, cmd || {});
    return res.data;
  },

  async stopSpeakingRecording(
    attemptId: string,
    cmd?: StopRecordingCommand
  ): Promise<SpeakingRuntimeStateDto> {
    const res = await apiClient.post(`/exams/attempts/${attemptId}/speaking/stop-recording`, cmd || {});
    return res.data;
  },

  async completeSpeakingTurn(
    attemptId: string,
    cmd: CompleteTurnCommand
  ): Promise<SpeakingRuntimeStateDto> {
    const res = await apiClient.post(`/exams/attempts/${attemptId}/speaking/complete-turn`, cmd);
    return res.data;
  },
};
