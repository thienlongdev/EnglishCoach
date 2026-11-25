package com.englishcoach.exams.operations;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Exams Phase 8D — admin Exams operations center contracts (ADMIN only; never a learner payload).
 *
 * <p>Everything here is DERIVED from canonical truth at request time (staged packages + the unchanged Phase 2 validator,
 * runtime compatibility audit, media plan, release gate, rights policy, practice readiness, import planner, QA review
 * report + fingerprinted decision ledger; persisted forms + validation service + rights service). Nothing is a stored
 * admin flag and there is no force / skip / override field anywhere. Codes, ids, hashes and counts only — no exam text,
 * no answer keys.
 */
public final class ExamOperationsRecords {

    private ExamOperationsRecords() {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record OperationsOverviewDto(
            Instant generatedAt,
            boolean stagingConfigured,
            String stagingNote,
            Map<String, Integer> gateTotals,
            Map<String, Integer> dispositionTotals,
            Map<String, Integer> practiceScopeTotals,
            LedgerSummaryDto ledger,
            List<PackageRowDto> packages,
            Map<String, String> versions
    ) {}

    public record LedgerSummaryDto(boolean present, int validDecisions, int invalidRecords, int recordedViaAdminCenter,
                                   int pendingApplication) {}

    /** One staged canonical package (LOCAL staging; never production). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PackageRowDto(
            String testId,
            String packageId,
            int packageVersion,
            String sourceKey,
            String family,
            String collection,
            String book,
            String test,
            String semanticFingerprint,
            String manifestContentHash,
            String phase2Status,
            Map<String, Boolean> gate,
            boolean importReady,
            boolean readyExceptHumanQa,
            String disposition,
            boolean dispositionReportStale,
            Map<String, Integer> openQaByPriority,
            int mediaAssets,
            int mediaReady,
            int imagesAwaitingHumanApproval,
            Map<String, Integer> practiceScopes,
            String projectAuthorization,
            String publisherLicence,
            boolean provenanceComplete,
            String localImportOperation,
            String productionImportOperation
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PackageDetailDto(
            PackageRowDto summary,
            String validatorVersion,
            List<String> phase2BlockingCodes,
            List<String> gateReasons,
            List<String> runnerBlocking,
            List<String> scoringBlocking,
            List<String> reviewCodes,
            List<Map<String, Object>> compatibilityDiagnostics,
            List<QaEntryDto> qaEntries,
            List<QaEntryDto> cropUnits,
            List<MediaAssetDto> media,
            List<PracticeScopeOpsDto> practiceScopes,
            String practiceBasisNote,
            RightsDto rights,
            ProvenanceDto provenance,
            List<ImportPlanDto> importPlans,
            List<LegacyMappingDto> legacyMappings,
            LifecyclePlanDto lifecycle,
            List<String> dispositionReasonCodes,
            String nextAction
    ) {}

    /**
     * One QA queue entry or crop review unit of the canonical QA review report. {@code reportCurrent} is false when the
     * report was built for different package content (re-run qa-review before deciding). {@code status} is the report's
     * status; {@code latestDecision} is the newest valid ledger record for the entry (decisions take effect on the next
     * qa-review run: {@code decisionPendingApplication}).
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record QaEntryDto(
            String entryId,
            String kind,
            String type,
            String subtype,
            String severity,
            String releasePriority,
            String status,
            String fingerprint,
            Integer page,
            Object questions,
            String cropSha256,
            String technical,
            List<String> technicalCodes,
            boolean reportCurrent,
            LedgerDecisionDto latestDecision,
            boolean decisionPendingApplication,
            boolean decidable
    ) {}

    public record LedgerDecisionDto(String decision, String reviewer, String reviewedAt, boolean fingerprintCurrent,
                                    String recordedVia) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record MediaAssetDto(
            String assetId,
            String sha256,
            String mimeType,
            Set<String> roles,
            Set<String> stimulusKinds,
            String validationState,
            String sourceKind,
            String fileStatus,
            boolean ready,
            boolean bound,
            int bindingCount,
            String cropTechnical,
            boolean cropHumanApproved,
            boolean waitingOnlyForHuman,
            boolean previewable
    ) {}

    public record PracticeScopeOpsDto(String scopeCode, String scopeType, int number, String learnerState, boolean ready,
                                      List<String> reasonCodes, int questionCount) {}

    /** Rights shown as SEPARATE concepts — never one "licensed" flag. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RightsDto(
            Map<String, Object> projectAuthorization,
            List<Map<String, Object>> publisherLicences,
            List<String> publisherLicenceGapCodes,
            List<RightsDecisionDto> decisions,
            String policyVersion
    ) {}

    public record RightsDecisionDto(String basis, String operation, boolean allowed, String reason, String grantedBy,
                                    Set<String> unclearedCodes) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ProvenanceDto(boolean complete, List<String> gaps, String rawSourcePath, String rawSourceSha256,
                                String pageRange, int audioReferences, String extractorName, String extractorVersion,
                                String reviewStatus, Map<String, Object> sourceIdentity) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ImportPlanDto(String target, String operation, String contentOperation, List<String> blockers,
                                List<String> notes, String planId, String planVersion, int plannedPackageVersion,
                                int plannedFormVersion, int changedPlacements, int reusedPlacements,
                                List<Map<String, Object>> retireConsiderations, boolean executable) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record LegacyMappingDto(String legacyLogicalKey, String legacyPackageId, String status, String proposedAction,
                                   boolean executed, boolean replacementReady) {}

    /** Publication / retirement are PLANS here: nothing is executed by the operations center. */
    public record LifecyclePlanDto(String executionMode, boolean publicationAllowed, List<String> publicationBlockers,
                                   boolean retirementPending, List<String> retirementNotes) {}

    /** Human QA decision request: the reviewer and the timestamp are NEVER taken from the client. */
    public record QaDecisionRequest(String testId, String entryId, String decision, String fingerprint, Object correctedValue,
                                    String note) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record QaDecisionReceipt(String testId, String entryId, String decision, String reviewer, String reviewedAt,
                                    String fingerprint, String previousStatus, String previousDecision, int ledgerRecords,
                                    String effect) {}

    /** Persisted (database) form, operator view. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record PersistedFormOpsDto(
            UUID formId,
            String logicalKey,
            int version,
            String family,
            String title,
            String lifecycleState,
            Map<String, Object> validation,
            List<PracticeScopeOpsDto> practiceScopes,
            RightsDto rights,
            Map<String, Object> recordedPackageIdentity,
            LifecyclePlanDto lifecycle
    ) {}
}
