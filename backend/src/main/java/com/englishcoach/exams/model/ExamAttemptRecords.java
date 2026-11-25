package com.englishcoach.exams.model;

import com.englishcoach.exams.model.ExamTypes.*;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ExamAttemptRecords {

    private ExamAttemptRecords() {}

    // ─── Database Projections ─────────────────────────────────────────────────

    public record AttemptRecord(
            UUID id,
            Long userId,
            UUID formId,
            ExamFamily family,
            String variant,
            String scope,
            ExamAttemptMode attemptMode,
            UUID parentSuiteId,
            UUID originalFullAttemptId,
            ExamAttemptStatus status,
            long revision,
            long writerEpoch,
            String activeTokenHash,
            Instant leaseExpiresAt,
            String pinnedManifestHash,
            Map<String, Object> clientSessionMeta,
            Instant readyAt,
            Instant startedAt,
            Instant scheduledEndAt,
            Instant submittedAt,
            Instant invalidatedAt,
            List<String> integrityFlags,
            Instant createdAt,
            Instant updatedAt,
            Map<String, Object> manifestSnapshot,
            String manifestSnapshotVersion,
            ExamSnapshotState snapshotState
    ) {
        public AttemptRecord(
                UUID id,
                Long userId,
                UUID formId,
                ExamFamily family,
                String variant,
                String scope,
                ExamAttemptMode attemptMode,
                UUID parentSuiteId,
                UUID originalFullAttemptId,
                ExamAttemptStatus status,
                long revision,
                long writerEpoch,
                String activeTokenHash,
                Instant leaseExpiresAt,
                String pinnedManifestHash,
                Map<String, Object> clientSessionMeta,
                Instant readyAt,
                Instant startedAt,
                Instant scheduledEndAt,
                Instant submittedAt,
                Instant invalidatedAt,
                List<String> integrityFlags,
                Instant createdAt,
                Instant updatedAt
        ) {
            this(
                    id, userId, formId, family, variant, scope, attemptMode, parentSuiteId, originalFullAttemptId,
                    status, revision, writerEpoch, activeTokenHash, leaseExpiresAt, pinnedManifestHash,
                    clientSessionMeta, readyAt, startedAt, scheduledEndAt, submittedAt, invalidatedAt,
                    integrityFlags, createdAt, updatedAt, null, null, ExamSnapshotState.LEGACY_UNSNAPSHOTTED
            );
        }
    }

    public record AttemptSectionRecord(
            UUID id,
            UUID attemptId,
            UUID sectionId,
            ExamSectionState state,
            String phase,
            Instant startedAt,
            Instant deadlineAt,
            Instant sealedAt,
            Map<String, Object> timingPolicySnapshot,
            Instant createdAt,
            String currentTurnPlacementId,
            String currentTurnKey,
            int turnCursor,
            long turnRevision
    ) {
        public AttemptSectionRecord(
                UUID id,
                UUID attemptId,
                UUID sectionId,
                ExamSectionState state,
                String phase,
                Instant startedAt,
                Instant deadlineAt,
                Instant sealedAt,
                Map<String, Object> timingPolicySnapshot,
                Instant createdAt
        ) {
            this(id, attemptId, sectionId, state, phase, startedAt, deadlineAt, sealedAt, timingPolicySnapshot, createdAt, null, null, 0, 0L);
        }
    }

    public record ResponseRecord(
            UUID id,
            UUID attemptId,
            UUID sectionId,
            String placementId,
            UUID itemId,
            Map<String, Object> answerPayload,
            String textResponse,
            UUID recordingId,
            boolean flagged,
            long revision,
            String lastCommandId,
            Instant updatedAt,
            String turnKey,
            Integer turnSequence,
            String responseKind,
            String turnState,
            Map<String, Object> sourceSnapshot,
            String exposureHash
    ) {
        public ResponseRecord(
                UUID id,
                UUID attemptId,
                UUID sectionId,
                String placementId,
                UUID itemId,
                Map<String, Object> answerPayload,
                String textResponse,
                UUID recordingId,
                boolean flagged,
                long revision,
                String lastCommandId,
                Instant updatedAt
        ) {
            this(id, attemptId, sectionId, placementId, itemId, answerPayload, textResponse, recordingId, flagged, revision, lastCommandId, updatedAt, null, null, "ITEM", "LOCKED", null, null);
        }
    }

    public record SubmissionRecord(
            UUID id,
            UUID attemptId,
            SubmissionReason reason,
            Instant cutoffTime,
            Map<String, Object> responseSnapshot,
            String manifestHash,
            Map<String, Object> recordingManifest,
            String submissionHash,
            Instant createdAt
    ) {}

    public record CommandReceiptRecord(
            UUID id,
            Long userId,
            UUID attemptId,
            String commandId,
            String operation,
            String requestHash,
            String resultReference,
            String status,
            Instant createdAt
    ) {}

    // ─── Command Requests ─────────────────────────────────────────────────────

    public record CreateAttemptRequest(
            UUID formId,
            ExamAttemptMode mode,
            UUID parentSuiteId,
            UUID originalFullAttemptId,
            String clientMutationId,
            List<String> selectedSkills,
            boolean aiAssessmentConsent
    ) {
        public CreateAttemptRequest(UUID formId, ExamAttemptMode mode, UUID parentSuiteId, UUID originalFullAttemptId,
                                    String clientMutationId, List<String> selectedSkills) {
            this(formId, mode, parentSuiteId, originalFullAttemptId, clientMutationId, selectedSkills, false);
        }

        public CreateAttemptRequest(
                UUID formId,
                ExamAttemptMode mode,
                UUID parentSuiteId,
                UUID originalFullAttemptId,
                String clientMutationId
        ) {
            this(formId, mode, parentSuiteId, originalFullAttemptId, clientMutationId, null);
        }
    }

    public record ResponseItemCommand(
            String placementId,
            UUID itemId,
            Map<String, Object> answerPayload,
            String textResponse,
            UUID recordingId,
            boolean flagged,
            Long expectedRevision
    ) {}

    public record SaveResponseBatchRequest(
            String clientMutationId,
            long expectedAttemptRevision,
            List<ResponseItemCommand> responses
    ) {}

    public record SubmitAttemptRequest(
            String clientMutationId,
            long expectedAttemptRevision,
            SubmissionReason reason,
            List<ResponseItemCommand> finalResponses,
            String flushToken
    ) {
        public SubmitAttemptRequest(
                String clientMutationId,
                long expectedAttemptRevision,
                SubmissionReason reason,
                List<ResponseItemCommand> finalResponses
        ) {
            this(clientMutationId, expectedAttemptRevision, reason, finalResponses, null);
        }
    }

    public record AdvanceSectionRequest(
            String clientMutationId,
            long expectedAttemptRevision,
            UUID targetSectionId
    ) {}

    public record CompleteSectionRequest(
            String commandId,
            Long expectedAttemptRevision,
            Long expectedSectionRevision,
            String clientSessionId,
            String flushToken
    ) {
        public CompleteSectionRequest(String commandId, Long expectedAttemptRevision, Long expectedSectionRevision, String clientSessionId) {
            this(commandId, expectedAttemptRevision, expectedSectionRevision, clientSessionId, null);
        }
    }

    public record SyncTimingRequest(
            long sessionEpoch,
            Instant clientTimestamp
    ) {}

    // ─── Response DTOs ────────────────────────────────────────────────────────

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record AttemptStateDto(
            UUID attemptId,
            UUID formId,
            ExamFamily family,
            String variant,
            String scope,
            ExamAttemptMode mode,
            ExamAttemptStatus status,
            long revision,
            long writerEpoch,
            String sessionToken,
            Instant serverTime,
            Instant startedAt,
            Instant scheduledEndAt,
            UUID currentSectionId,
            List<SectionStateDto> sections,
            Map<String, SavedResponseDto> responses,
            List<String> integrityFlags
    ) {}

    public record SectionStateDto(
            UUID sectionId,
            SkillType skill,
            int ordinal,
            ExamSectionState state,
            String phase,
            Instant startedAt,
            Instant deadlineAt,
            Long remainingSeconds
    ) {}

    public record SavedResponseDto(
            String placementId,
            UUID itemId,
            Map<String, Object> answerPayload,
            String textResponse,
            UUID recordingId,
            boolean flagged,
            long revision,
            Instant updatedAt
    ) {}

    public record SaveReceiptDto(
            String commandId,
            long attemptRevision,
            Map<String, Long> acceptedRevisions,
            Instant serverTime
    ) {}

    public record SyncTimingResponseDto(
            Instant serverTime,
            long sessionEpoch,
            UUID currentSectionId,
            Long remainingSeconds,
            Map<UUID, Instant> sectionDeadlines,
            ExamAttemptStatus status
    ) {}

    public record ActiveSimulationAttemptSummary(
            UUID attemptId,
            UUID formId,
            ExamFamily family,
            String variant,
            String formTitle,
            ExamAttemptMode mode,
            ExamAttemptStatus status,
            String currentSkill,
            Instant startedAt,
            boolean resumable
    ) {}
}

