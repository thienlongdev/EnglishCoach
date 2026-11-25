import { apiClient } from './api-client';
import {
  WritingCapabilities,
  WritingProfile,
  WritingTask,
  WritingSession,
  WritingSessionDetail,
  WritingSessionStage,
  SentenceCheckResult,
  SentenceCheckRequest,
  LearnerErrorMemory,
  PlanOrganizationResult,
  DocumentAssessmentResult,
  DraftComparisonResult,
  PortfolioSummaryItem,
  ForYouDashboard,
  WritingSourceType,
  WritingSourceContext,
  WeeklyWritingReport,
  LongitudinalProgress,
  SkillDimensionScore,
  AdaptiveTaskRequest,
  AdaptiveTaskResponse,
  SocraticPlanRequest,
  SocraticPlanResponse,
  ModelAnswerComparisonRequest,
  ModelAnswerComparisonResponse,
  TranslationCatalog,
  TranslationStartRequest,
  TranslationSession,
  TranslationDraftRequest,
  TranslationDraftResponse,
  TranslationHintRequest,
  TranslationHintResponse,
  TranslationAttemptRequest,
  TranslationAttemptResponse
} from '@/types/writing';
import type { TypingWritingCategory, TypingWritingSource, TypingWritingSourcePage } from '@/types/writing';

export const writingApi = {
  async getTypingSources(category: TypingWritingCategory, page: number, signal: AbortSignal): Promise<TypingWritingSourcePage> {
    const res = await apiClient.get<TypingWritingSourcePage>('/writing/typing/sources', { params: { category, page }, signal, timeout: 15000 });
    return res.data;
  },
  async getTypingSource(category: TypingWritingCategory, id: string, signal: AbortSignal): Promise<TypingWritingSource> {
    const res = await apiClient.get<TypingWritingSource>(`/writing/typing/sources/${encodeURIComponent(id)}`, { params: { category }, signal, timeout: 15000 });
    return res.data;
  },
  async getCapabilities(): Promise<WritingCapabilities> {
    const res = await apiClient.get<WritingCapabilities>('/writing/capabilities');
    return res.data;
  },

  async getProfile(): Promise<WritingProfile> {
    const res = await apiClient.get<WritingProfile>('/writing/profile');
    return res.data;
  },

  async updateProfile(profile: Partial<WritingProfile>): Promise<WritingProfile> {
    const res = await apiClient.patch<WritingProfile>('/writing/profile', profile);
    return res.data;
  },

  async getTasks(category?: string): Promise<WritingTask[]> {
    const params = category ? { category } : {};
    const res = await apiClient.get<WritingTask[]>('/writing/tasks', { params });
    return res.data;
  },

  async createSession(taskId: string, clientMutationId?: string): Promise<WritingSession> {
    const res = await apiClient.post<WritingSession>('/writing/sessions', {
      taskId,
      clientMutationId: clientMutationId || crypto.randomUUID()
    });
    return res.data;
  },

  /** Free practice submission of the session's saved draft (no AI, no Premium): the server checks and records it once. */
  async submitPractice(sessionId: string): Promise<{ id: number; wordCount: number; minWords: number; alreadySubmitted: boolean }> {
    const res = await apiClient.post(`/writing/sessions/${encodeURIComponent(sessionId)}/practice-submission`);
    return res.data;
  },

  async getSession(sessionId: string): Promise<WritingSession> {
    const res = await apiClient.get<WritingSession>(`/writing/sessions/${sessionId}`);
    return res.data;
  },

  async getSessionDetail(sessionId: string): Promise<WritingSessionDetail> {
    const res = await apiClient.get<WritingSessionDetail>(`/writing/sessions/${sessionId}/detail`);
    return res.data;
  },

  async updateWorkingCopy(
    sessionId: string,
    workingTextOrPayload: string | { workingPlan?: string; workingText?: string; clientMutationId?: string },
    workingPlan?: string,
    expectedRevision?: number,
    clientMutationId?: string
  ): Promise<WritingSession> {
    let body: any;
    if (typeof workingTextOrPayload === 'object' && workingTextOrPayload !== null) {
      body = {
        ...workingTextOrPayload,
        clientMutationId: workingTextOrPayload.clientMutationId || crypto.randomUUID()
      };
    } else {
      body = {
        workingText: workingTextOrPayload,
        workingPlan: workingPlan || '',
        expectedRevision,
        clientMutationId: clientMutationId || crypto.randomUUID()
      };
    }
    const res = await apiClient.patch<WritingSession>(`/writing/sessions/${sessionId}/working-copy`, body, { timeout: 30000, signal: AbortSignal.timeout(30000) });
    return res.data;
  },

  async advanceStage(
    sessionId: string,
    targetStage: WritingSessionStage,
    expectedRevision?: number
  ): Promise<WritingSession> {
    const res = await apiClient.patch<WritingSession>(`/writing/sessions/${sessionId}/stage`, {
      targetStage,
      expectedRevision
    });
    return res.data;
  },

  async listSessions(stage?: WritingSessionStage, completed?: boolean): Promise<WritingSession[]> {
    const params: Record<string, any> = {};
    if (stage) params.stage = stage;
    if (completed !== undefined) params.completed = completed;
    const res = await apiClient.get<WritingSession[]>('/writing/sessions', { params });
    return res.data;
  },

  async deleteSession(sessionId: string): Promise<void> {
    await apiClient.delete(`/writing/sessions/${sessionId}`);
  },

  async submitSentenceCheck(
    text: string,
    targetRegister: string = 'formal',
    contextNote?: string,
    clientMutationId?: string
  ): Promise<SentenceCheckResult> {
    const res = await apiClient.post<SentenceCheckResult>('/writing/sentence-checks', {
      text,
      targetRegister,
      contextNote,
      clientMutationId: clientMutationId || crypto.randomUUID()
    });
    return {
      ...res.data,
      originalText: text
    };
  },

  async checkSentence(payload: SentenceCheckRequest): Promise<SentenceCheckResult> {
    return this.submitSentenceCheck(payload.text, payload.targetRegister, payload.contextNote, payload.clientMutationId);
  },

  async getAssessment(id: string): Promise<SentenceCheckResult> {
    const res = await apiClient.get<SentenceCheckResult>(`/writing/assessments/${id}`);
    return res.data;
  },

  async retryAssessment(id: string): Promise<SentenceCheckResult> {
    const res = await apiClient.post<SentenceCheckResult>(`/writing/assessments/${id}/retry`);
    return res.data;
  },

  async getMyMistakes(): Promise<LearnerErrorMemory[]> {
    const res = await apiClient.get<LearnerErrorMemory[]>('/writing/mistakes');
    return res.data;
  },

  async setMistakeMuted(patternCode: string, muted: boolean): Promise<void> {
    await apiClient.patch(`/writing/mistakes/${patternCode}/mute?muted=${muted}`);
  },

  async setMuted(patternCode: string, muted: boolean): Promise<void> {
    return this.setMistakeMuted(patternCode, muted);
  },

  async disputeIssue(issueId: string, reason?: string): Promise<void> {
    const url = reason
      ? `/writing/issues/${issueId}/dispute?reason=${encodeURIComponent(reason)}`
      : `/writing/issues/${issueId}/dispute`;
    await apiClient.post(url);
  },

  async organizePlan(sessionId: string): Promise<PlanOrganizationResult> {
    const res = await apiClient.post<PlanOrganizationResult>(`/writing/sessions/${sessionId}/plan/organize`);
    return res.data;
  },

  async submitDraft(
    sessionId: string,
    expectedRevision?: number,
    clientMutationId?: string
  ): Promise<DocumentAssessmentResult> {
    const res = await apiClient.post<DocumentAssessmentResult>(`/writing/sessions/${sessionId}/drafts`, {
      expectedRevision,
      clientMutationId: clientMutationId || crypto.randomUUID()
    }, { timeout: 150000, signal: AbortSignal.timeout(150000) });
    return res.data;
  },

  async getSessionAssessment(sessionId: string, assessmentId: string): Promise<DocumentAssessmentResult> {
    const res = await apiClient.get<DocumentAssessmentResult>(
      `/writing/sessions/${sessionId}/assessments/${assessmentId}`
    );
    return res.data;
  },

  async compareDrafts(
    sessionId: string,
    draft1Id?: string,
    draft2Id?: string
  ): Promise<DraftComparisonResult> {
    const params: Record<string, string> = {};
    if (draft1Id) params.draft1Id = draft1Id;
    if (draft2Id) params.draft2Id = draft2Id;
    const res = await apiClient.get<DraftComparisonResult>(`/writing/sessions/${sessionId}/comparison`, {
      params
    });
    return res.data;
  },

  async getDraftComparison(
    sessionId: string,
    draft1Id?: string,
    draft2Id?: string
  ): Promise<DraftComparisonResult> {
    return this.compareDrafts(sessionId, draft1Id, draft2Id);
  },

  async completeSession(
    sessionId: string,
    finalDraftId?: string,
    expectedRevision?: number
  ): Promise<WritingSession> {
    const res = await apiClient.post<WritingSession>(`/writing/sessions/${sessionId}/complete`, {
      finalDraftId,
      expectedRevision
    }, { timeout: 150000, signal: AbortSignal.timeout(150000) });
    return res.data;
  },

  async setFavorite(sessionId: string, isFavorite: boolean): Promise<WritingSession> {
    const res = await apiClient.patch<WritingSession>(
      `/writing/sessions/${sessionId}/favorite?isFavorite=${isFavorite}`
    );
    return res.data;
  },

  async getPortfolio(state?: string, favorite?: boolean): Promise<PortfolioSummaryItem[]> {
    const params: Record<string, any> = {};
    if (state) params.state = state;
    if (favorite !== undefined) params.favorite = favorite;
    const res = await apiClient.get<PortfolioSummaryItem[]>('/writing/portfolio', { params });
    return res.data;
  },

  async getForYou(): Promise<ForYouDashboard> {
    const res = await apiClient.get<ForYouDashboard>('/writing/for-you');
    return res.data;
  },

  // Phase 8: Cross-module Source Adapters
  async getAvailableSources(sourceType?: WritingSourceType): Promise<WritingSourceContext[]> {
    const params: Record<string, any> = {};
    if (sourceType) params.sourceType = sourceType;
    const res = await apiClient.get<WritingSourceContext[]>('/writing/sources/available', { params });
    return res.data;
  },

  async getSourceContext(sourceType: WritingSourceType, sourceId?: string): Promise<WritingSourceContext> {
    const params: Record<string, any> = { sourceType };
    if (sourceId) params.sourceId = sourceId;
    const res = await apiClient.get<WritingSourceContext>('/writing/sources/context', { params });
    return res.data;
  },

  async createSessionFromSource(sourceType: WritingSourceType, sourceId: string): Promise<WritingSession> {
    const res = await apiClient.post<WritingSession>('/writing/sources/create-session', {
      sourceType,
      sourceId
    });
    return res.data;
  },

  // Phase 9: Intelligence and Analytics
  async getWeeklyReport(): Promise<WeeklyWritingReport> {
    const res = await apiClient.get<WeeklyWritingReport>('/writing/analytics/weekly-report');
    return res.data;
  },

  async getLongitudinalProgress(): Promise<LongitudinalProgress> {
    const res = await apiClient.get<LongitudinalProgress>('/writing/analytics/longitudinal');
    return res.data;
  },

  async getSkillDimensionScores(): Promise<SkillDimensionScore[]> {
    const res = await apiClient.get<SkillDimensionScore[]>('/writing/analytics/skills');
    return res.data;
  },

  async generateAdaptiveTask(request?: AdaptiveTaskRequest): Promise<AdaptiveTaskResponse> {
    const res = await apiClient.post<AdaptiveTaskResponse>('/writing/intelligence/task-generate', request || {});
    return res.data;
  },

  async getSocraticGuidance(request: SocraticPlanRequest): Promise<SocraticPlanResponse> {
    const res = await apiClient.post<SocraticPlanResponse>('/writing/intelligence/socratic-plan', request);
    return res.data;
  },

  async compareModelAnswer(request: ModelAnswerComparisonRequest): Promise<ModelAnswerComparisonResponse> {
    const res = await apiClient.post<ModelAnswerComparisonResponse>('/writing/intelligence/compare-model', request, { timeout: 90000, signal: AbortSignal.timeout(90000) });
    return res.data;
  },

  // Translation Practice
  async getTranslationCatalog(): Promise<TranslationCatalog> {
    const res = await apiClient.get<TranslationCatalog>('/writing/translation/catalog');
    return res.data;
  },

  async startTranslationSession(request: TranslationStartRequest): Promise<TranslationSession> {
    const res = await apiClient.post<TranslationSession>('/writing/translation/sessions', request);
    return res.data;
  },

  async getTranslationSession(sessionId: string): Promise<TranslationSession> {
    const res = await apiClient.get<TranslationSession>(`/writing/translation/sessions/${sessionId}`);
    return res.data;
  },

  async saveTranslationDraft(sessionId: string, request: TranslationDraftRequest): Promise<TranslationDraftResponse> {
    const res = await apiClient.post<TranslationDraftResponse>(`/writing/translation/sessions/${sessionId}/draft`, request);
    return res.data;
  },

  async requestTranslationHint(sessionId: string, request: TranslationHintRequest): Promise<TranslationHintResponse> {
    const res = await apiClient.post<TranslationHintResponse>(`/writing/translation/sessions/${sessionId}/hint`, request);
    return res.data;
  },

  async submitTranslationAttempt(sessionId: string, request: TranslationAttemptRequest): Promise<TranslationAttemptResponse> {
    const res = await apiClient.post<TranslationAttemptResponse>(`/writing/translation/sessions/${sessionId}/attempts`, request);
    return res.data;
  },

  async navigateTranslationSession(sessionId: string, ordinal: number): Promise<TranslationSession> {
    const res = await apiClient.post<TranslationSession>(`/writing/translation/sessions/${sessionId}/navigate`, { ordinal });
    return res.data;
  }
};
