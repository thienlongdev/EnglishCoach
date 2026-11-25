package com.englishcoach.writing.translation.dto;

import lombok.*;

import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationAttemptResponse {
    private UUID attemptId;
    private UUID sessionId;
    private short unitOrdinal;
    private int attemptOrdinal;
    private String action;
    private String evaluationStatus; // ACCEPTED, NEEDS_REVISION, INCORRECT, UNCERTAIN, SKIPPED, CONTINUED, UNAVAILABLE
    private Boolean accepted;
    private long sessionRevision;
    private TranslationFeedbackDto feedback;
    private String referenceEn; // NULL unless accepted=true or referenceRevealed=true
    private Short nextOrdinal;
    private boolean sessionCompleted;
}
