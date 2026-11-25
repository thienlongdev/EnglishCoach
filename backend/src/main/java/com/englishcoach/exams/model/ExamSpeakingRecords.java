package com.englishcoach.exams.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ExamSpeakingRecords {

    private ExamSpeakingRecords() {}

    public enum SpeakingTurnState {
        LOCKED,
        CURRENT,
        PREPARING,
        READY_TO_RECORD,
        RECORDING,
        UPLOADING,
        RECORDED,
        COMPLETED,
        FAILED_UPLOAD
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SpeakingTurnDto(
            String turnKey,
            int turnSequence,
            String partCode,
            String placementId,
            UUID itemId,
            String turnState,
            String prompt,
            Integer preparationSeconds,
            Integer maxResponseSeconds,
            Instant preparationDeadline,
            Instant responseDeadline,
            Long remainingSeconds,
            UUID recordingId,
            Instant completedAt,
            String transitionToken,
            String mediaUrl
    ) {
        public SpeakingTurnDto(
                String turnKey, int turnSequence, String partCode, String placementId,
                UUID itemId, String turnState, String prompt, Integer preparationSeconds,
                Integer maxResponseSeconds, Instant preparationDeadline, Instant responseDeadline,
                Long remainingSeconds, UUID recordingId, Instant completedAt, String transitionToken
        ) {
            this(turnKey, turnSequence, partCode, placementId, itemId, turnState, prompt,
                 preparationSeconds, maxResponseSeconds, preparationDeadline, responseDeadline,
                 remainingSeconds, recordingId, completedAt, transitionToken, null);
        }

        public SpeakingTurnDto(
                String turnKey, int turnSequence, String partCode, String placementId,
                UUID itemId, String turnState, String prompt, Integer preparationSeconds,
                Integer maxResponseSeconds, Instant preparationDeadline, Instant responseDeadline,
                Long remainingSeconds, UUID recordingId, Instant completedAt
        ) {
            this(turnKey, turnSequence, partCode, placementId, itemId, turnState, prompt,
                 preparationSeconds, maxResponseSeconds, preparationDeadline, responseDeadline,
                 remainingSeconds, recordingId, completedAt, null, null);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SpeakingTurnSummaryDto(
            String turnKey,
            int turnSequence,
            String partCode,
            UUID recordingId,
            String state
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SpeakingRuntimeStateDto(
            UUID attemptId,
            UUID sectionId,
            int currentTurnCursor,
            long turnRevision,
            SpeakingTurnDto currentTurn,
            int totalTurns,
            int lockedTurnCount,
            List<SpeakingTurnSummaryDto> completedTurns,
            boolean sectionCompleted,
            String activePartCode,
            String transitionToken
    ) {
        public SpeakingRuntimeStateDto(
                UUID attemptId, UUID sectionId, int currentTurnCursor, long turnRevision,
                SpeakingTurnDto currentTurn, int totalTurns, List<SpeakingTurnSummaryDto> completedTurns,
                boolean sectionCompleted, String activePartCode
        ) {
            this(attemptId, sectionId, currentTurnCursor, turnRevision, currentTurn,
                 totalTurns, Math.max(0, totalTurns - currentTurnCursor), completedTurns,
                 sectionCompleted, activePartCode, null);
        }
    }

    public record StartPreparationCommand(
            String clientMutationId,
            long expectedTurnRevision,
            String turnKey,
            String transitionToken
    ) {
        public StartPreparationCommand(String clientMutationId, long expectedTurnRevision) {
            this(clientMutationId, expectedTurnRevision, null, null);
        }
    }

    public record StartRecordingCommand(
            String clientMutationId,
            long expectedTurnRevision,
            String turnKey,
            String transitionToken
    ) {
        public StartRecordingCommand(String clientMutationId, long expectedTurnRevision) {
            this(clientMutationId, expectedTurnRevision, null, null);
        }
    }

    public record StopRecordingCommand(
            String clientMutationId,
            long expectedTurnRevision,
            String turnKey,
            String transitionToken
    ) {
        public StopRecordingCommand(String clientMutationId, long expectedTurnRevision) {
            this(clientMutationId, expectedTurnRevision, null, null);
        }
    }

    public record CompleteTurnCommand(
            String clientMutationId,
            long expectedTurnRevision,
            UUID recordingId,
            Integer durationMs,
            String turnKey,
            String transitionToken
    ) {
        public CompleteTurnCommand(String clientMutationId, long expectedTurnRevision, UUID recordingId, Integer durationMs) {
            this(clientMutationId, expectedTurnRevision, recordingId, durationMs, null, null);
        }
    }
}
