package com.englishcoach.writing.dto;

import lombok.*;

import java.time.Instant;
import java.util.List;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ErrorMemoryDto {
    private String id;
    private String patternCode;
    private String category;
    private String title;
    private Integer occurrenceCount;
    private Integer contextCount;
    private Instant lastSeenAt;
    private Integer estimatedMastery;
    private Boolean hasSufficientEvidence;
    private Boolean dueForPractice;
    private Instant nextPracticeDueAt;
    private Boolean isMuted;
    private String teachingRule;
    private String defaultPracticeMode;
    private List<ErrorOccurrenceDto> occurrences;
}

