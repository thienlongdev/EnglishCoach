package com.englishcoach.writing.dto;

import lombok.*;

import java.time.Instant;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ErrorOccurrenceDto {
    private String id;
    private String issueId;
    private String assessmentId;
    private String submissionId;
    private String patternCode;
    private String title;
    private String sourceFeature; // "Sentence Lab" | "Writing Coach"
    private String originalText;
    private String wrongSpan;
    private Integer startOffset;
    private Integer endOffset;
    private String replacement;
    private String correctedSentence;
    private String explanation;
    private String teachingRule;
    private String category;
    private String severity;
    private Instant recordedAt;
}
