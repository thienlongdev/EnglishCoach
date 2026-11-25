package com.englishcoach.writing.translation.paragraph.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphAttemptResponse {
    private UUID attemptId;
    private UUID sessionId;
    private UUID sessionItemId;
    private UUID passageId;
    private Integer ordinal;
    private Integer attemptOrdinal;
    private String action;
    private String clientMutationId;
    private String submittedText;
    private String evaluationStatus;
    private Boolean accepted;
    private ParagraphFeedbackDto feedback;
    private String sessionProgressState;
    private String itemProgressState;
    private Instant createdAt;
}
