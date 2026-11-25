package com.englishcoach.exams.model;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.ResultStatus;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class ExamSpeakingReviewRecords {

    private ExamSpeakingReviewRecords() {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SpeakingTurnReviewDto(
            int turnOrder,
            String turnKey,
            String partKey,
            String promptSourceId,
            String promptText,
            UUID recordingId,
            String playbackUrl,
            Integer durationSeconds,
            String transcriptText,
            String transcriptStatus,
            Map<String, Object> acousticEvidence,
            String missingReason,
            Map<String, Object> turnFeedback
    ) {
        public int turnSequence() {
            return turnOrder;
        }

        public SpeakingTurnReviewDto(
                int turnOrder,
                String partKey,
                String promptSourceId,
                String promptText,
                UUID recordingId,
                String playbackUrl,
                Integer durationSeconds,
                String transcriptText,
                String transcriptStatus,
                Map<String, Object> acousticEvidence,
                String missingReason,
                Map<String, Object> turnFeedback
        ) {
            this(turnOrder, promptSourceId, partKey, promptSourceId, promptText, recordingId, playbackUrl,
                 durationSeconds, transcriptText, transcriptStatus, acousticEvidence, missingReason, turnFeedback);
        }

        public SpeakingTurnReviewDto(
                int turnOrder,
                String partKey,
                String promptSourceId,
                String promptText,
                UUID recordingId,
                String playbackUrl,
                Integer durationSeconds,
                String transcriptText,
                String transcriptStatus,
                Map<String, Object> acousticEvidence,
                String missingReason
        ) {
            this(turnOrder, promptSourceId, partKey, promptSourceId, promptText, recordingId, playbackUrl,
                 durationSeconds, transcriptText, transcriptStatus, acousticEvidence, missingReason, null);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SpeakingCriterionReviewDto(
            String rubricCriterion,
            Double estimatedBand,
            String bandDescriptor,
            List<String> evidenceHighlights,
            Map<String, Object> confidenceMeta,
            String status
    ) {
        public String criterion() {
            return rubricCriterion;
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SpeakingAttemptReviewDto(
            UUID attemptId,
            ExamFamily family,
            ResultStatus status,
            Double overallSpeakingBand,
            List<SpeakingTurnReviewDto> turns,
            List<SpeakingCriterionReviewDto> criteria,
            String examinerFeedback,
            String abstentionReason,
            Map<String, Object> sessionSummary
    ) {
        public Double overallBand() {
            return overallSpeakingBand;
        }

        public SpeakingAttemptReviewDto(
                UUID attemptId,
                ExamFamily family,
                ResultStatus status,
                Double overallSpeakingBand,
                List<SpeakingTurnReviewDto> turns,
                List<SpeakingCriterionReviewDto> criteria,
                String examinerFeedback,
                String abstentionReason
        ) {
            this(attemptId, family, status, overallSpeakingBand, turns, criteria, examinerFeedback, abstentionReason, null);
        }
    }
}
