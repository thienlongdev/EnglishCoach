import { apiClient } from '@/services/api-client';
import {
  CorpusPracticeReleaseReceipt,
  AnalysisReport,
  AdminFormSummary,
  AdminSourceSummary,
  CalibrationPackage,
  ExamContentPackage,
  EvaluationReport,
  GoldDataset,
  ImportResult,
  ItemStatistic,
  MeasurementEvent,
  RaterAssignment,
  RaterAssignmentView,
  RaterRatingSummary,
  RunView,
  ValidationResult,
  OpsOverview,
  OpsPackageDetail,
  OpsPersistedForm,
  OpsQaDecisionReceipt,
  OpsQaDecisionRequest,
} from '@/types/exam-admin';

const base = '/admin/exams';
const measurement = `${base}/measurement`;

export const examAdminApi = {
  async getToeicPublicationBatch() {
    const response = await apiClient.get<{ pending: {formId: string; hash: string}[]; progress: {
      total: number; published: number; failures: Record<string,string>; running: boolean
    } }>(`${base}/content-packages/toeic-publication-batch`);
    return response.data;
  },
  async publishToeicBatch(selected: {formId: string; hash: string}[]) {
    await apiClient.post(`${base}/content-packages/toeic-publication-batch`, selected);
  },
  async releaseQualifiedCorpusPractice(packageIndex = 0, pkg?: ExamContentPackage | string): Promise<CorpusPracticeReleaseReceipt[]> {
    const response = await apiClient.post<CorpusPracticeReleaseReceipt[]>(`${base}/content-packages/release-qualified-corpus-practice`, pkg, {
      params: { packageIndex }, headers: typeof pkg === 'string' ? { 'Content-Type': 'application/json' } : undefined,
    });
    return response.data;
  },
  async bootstrapOriginalPractice(): Promise<ImportResult[]> {
    const response = await apiClient.post<ImportResult[]>(`${base}/content-packages/bootstrap-original-practice`);
    return response.data;
  },
  async validatePackage(pkg: ExamContentPackage): Promise<ValidationResult> {
    const response = await apiClient.post<ValidationResult>(`${base}/content-packages/validate`, pkg);
    return response.data;
  },

  async importPackage(pkg: ExamContentPackage): Promise<ImportResult> {
    const response = await apiClient.post<ImportResult>(`${base}/content-packages/import`, pkg);
    return response.data;
  },

  async getImportStatus(packageId: string, packageVersion: number): Promise<Record<string, unknown>> {
    const response = await apiClient.get(`${base}/content-packages/${encodeURIComponent(packageId)}/${packageVersion}`);
    return response.data;
  },

  async listForms(params: { family?: string; lifecycleState?: string } = {}): Promise<AdminFormSummary[]> {
    const response = await apiClient.get<AdminFormSummary[]>(`${base}/content-packages/forms`, { params });
    return response.data;
  },

  async listSources(): Promise<AdminSourceSummary[]> {
    const response = await apiClient.get<AdminSourceSummary[]>(`${base}/content-packages/sources`);
    return response.data;
  },

  async submitReview(formId: string, body: { gate: string; decision: string; hash: string; notes: string }) {
    const response = await apiClient.post(`${base}/forms/${formId}/reviews`, body);
    return response.data;
  },

  async publishForm(formId: string) {
    const response = await apiClient.post(`${base}/forms/${formId}/publish`);
    return response.data;
  },

  async retireForm(formId: string) {
    const response = await apiClient.post(`${base}/forms/${formId}/retire`);
    return response.data;
  },

  async collectAttempt(attemptId: string): Promise<{ attemptId: string; eventIds: string[]; evidenceClass: string }> {
    const response = await apiClient.post(`${measurement}/attempts/${attemptId}/collect`);
    return response.data;
  },

  async getAttemptEvents(attemptId: string): Promise<MeasurementEvent[]> {
    const response = await apiClient.get<MeasurementEvent[]>(`${measurement}/attempts/${attemptId}/events`);
    return response.data;
  },

  async createRun(body: {
    family: 'IELTS' | 'TOEIC';
    skill?: string;
    formId?: string;
    attemptIds: string[];
    filter?: Record<string, unknown>;
    consentPolicyVersion: string;
  }): Promise<{ runId: string; status: string }> {
    const response = await apiClient.post(`${measurement}/runs`, body);
    return response.data;
  },

  async getRun(runId: string): Promise<RunView> {
    const response = await apiClient.get<RunView>(`${measurement}/runs/${runId}`);
    return response.data;
  },

  async getRunEvents(runId: string): Promise<MeasurementEvent[]> {
    const response = await apiClient.get<MeasurementEvent[]>(`${measurement}/runs/${runId}/events`);
    return response.data;
  },

  async calculateRun(runId: string): Promise<AnalysisReport> {
    const response = await apiClient.post<AnalysisReport>(`${measurement}/runs/${runId}/calculate`);
    return response.data;
  },

  async createCalibration(body: Record<string, unknown>): Promise<{ packageId: string; approvalState: string }> {
    const response = await apiClient.post(`${measurement}/calibration/packages`, body);
    return response.data;
  },

  async getCalibration(packageId: string): Promise<CalibrationPackage> {
    const response = await apiClient.get<CalibrationPackage>(`${measurement}/calibration/packages/${packageId}`);
    return response.data;
  },

  async approveCalibration(packageId: string): Promise<{ packageId: string; approvalState: string }> {
    const response = await apiClient.post(`${measurement}/calibration/packages/${packageId}/approve`);
    return response.data;
  },

  async createConsent(body: { status: 'GRANTED' | 'WITHDRAWN'; consentHash: string }, humanRating = false) {
    const response = await apiClient.post(`${measurement}/consent${humanRating ? '/human-rating' : ''}`, body);
    return response.data as { consentId: string; status: string };
  },

  async createGoldDataset(body: Record<string, unknown>): Promise<{ datasetId: string; status: string }> {
    const response = await apiClient.post(`${measurement}/gold/datasets`, body);
    return response.data;
  },

  async getGoldDataset(datasetId: string): Promise<GoldDataset> {
    const response = await apiClient.get<GoldDataset>(`${measurement}/gold/datasets/${datasetId}`);
    return response.data;
  },

  async addGoldMember(datasetId: string, body: Record<string, unknown>) {
    const response = await apiClient.post(`${measurement}/gold/datasets/${datasetId}/members`, body);
    return response.data as { memberId: string; datasetId: string };
  },

  async lockGoldDataset(datasetId: string) {
    const response = await apiClient.post(`${measurement}/gold/datasets/${datasetId}/lock`);
    return response.data;
  },

  async assignRater(datasetId: string, body: Record<string, unknown>) {
    const response = await apiClient.post(`${measurement}/gold/datasets/${datasetId}/assignments`, body);
    return response.data as { assignmentId: string; blind: boolean };
  },

  async getMyAssignments(datasetId: string): Promise<RaterAssignment[]> {
    const response = await apiClient.get<RaterAssignment[]>(`${measurement}/gold/datasets/${datasetId}/assignments`);
    return response.data;
  },

  async getAssignmentView(assignmentId: string): Promise<RaterAssignmentView> {
    const response = await apiClient.get<RaterAssignmentView>(`${measurement}/raters/assignments/${assignmentId}`);
    return response.data;
  },

  async getAdjudicationRatings(datasetId: string, responseId: string): Promise<RaterRatingSummary[]> {
    const response = await apiClient.get<RaterRatingSummary[]>(`${measurement}/gold/datasets/${datasetId}/responses/${responseId}/ratings`);
    return response.data;
  },

  async getAssignmentRecording(assignmentId: string): Promise<Blob> {
    const response = await apiClient.get<Blob>(`${measurement}/raters/assignments/${assignmentId}/recording`, { responseType: 'blob' });
    return response.data;
  },

  async submitRating(assignmentId: string, body: Record<string, unknown>) {
    const response = await apiClient.post(`${measurement}/raters/assignments/${assignmentId}/ratings`, body);
    return response.data;
  },

  async adjudicate(datasetId: string, body: Record<string, unknown>) {
    const response = await apiClient.post(`${measurement}/gold/datasets/${datasetId}/adjudications`, body);
    return response.data;
  },

  async evaluate(datasetId: string, body: Record<string, unknown>): Promise<EvaluationReport> {
    const response = await apiClient.post<EvaluationReport>(`${measurement}/gold/datasets/${datasetId}/evaluations`, body);
    return response.data;
  },

  // ─── Operations center (Exams Phase 8D) ──────────────────────────────────
  // Read-only canonical truth + ONE append-only action (a fingerprinted human QA decision; the server sets the reviewer
  // and the time). There is no import / publication / retirement call here.

  async getOperationsOverview(): Promise<OpsOverview> {
    const response = await apiClient.get<OpsOverview>(`${base}/operations/overview`);
    return response.data;
  },

  async getOperationsPackage(testId: string): Promise<OpsPackageDetail> {
    const response = await apiClient.get<OpsPackageDetail>(`${base}/operations/packages/detail`, { params: { testId } });
    return response.data;
  },

  async getOperationsMediaBlob(testId: string, sha256: string): Promise<Blob> {
    const response = await apiClient.get(`${base}/operations/packages/media`, { params: { testId, sha256 }, responseType: 'blob' });
    return response.data as Blob;
  },

  async recordQaDecision(body: OpsQaDecisionRequest): Promise<OpsQaDecisionReceipt> {
    const { testId, entryId, decision, fingerprint, correctedValue, note } = body;
    const response = await apiClient.post<OpsQaDecisionReceipt>(`${base}/operations/qa/decisions`,
      { testId, entryId, decision, fingerprint, correctedValue, note });
    return response.data;
  },

  async getOperationsForm(formId: string): Promise<OpsPersistedForm> {
    const response = await apiClient.get<OpsPersistedForm>(`${base}/operations/forms/${encodeURIComponent(formId)}`);
    return response.data;
  },
};

export function getApiErrorMessage(error: unknown): string {
  const candidate = error as { response?: { data?: { message?: string; code?: string; errors?: Array<{ message?: string }> } }; message?: string };
  const data = candidate?.response?.data;
  if (data?.errors?.length) return data.errors.map((entry) => entry.message || 'Validation error').join(' • ');
  return data?.message || data?.code || candidate?.message || 'Request failed';
}
