package com.englishcoach.speaking.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SpeakingRecurringIssueDto {
    private String issueKey;
    private String category; // "PRONUNCIATION", "GRAMMAR", "VOCABULARY", "NATURALNESS", "STRESS"
    private String title;
    private String issueType;
    private String targetWord;
    private String targetPhone;
    private String observedPhone;
    private Double averageQualityScore;
    private String status; // "INSUFFICIENT_DATA", "NEEDS_ATTENTION", "PRACTICING", "IMPROVING", "RECENTLY_STABLE"
    private String statusExplanation;
    private Integer distinctSessionsObserved;
    private Integer totalOccurrences;
    private Integer resolvedSessionCount;
    private LocalDateTime lastObservedAt;
    private String displayCue;
    private String evidenceWindow;
    @Builder.Default
    private List<SpeakingIssueExampleDto> recentExamples = new ArrayList<>();
    private String practiceAgainRoute;
    private String practiceAgainLabel;

    public SpeakingRecurringIssueDto(
            String issueKey,
            String category,
            String title,
            String issueType,
            String targetWord,
            String targetPhone,
            String status,
            String statusExplanation,
            Integer distinctSessionsObserved,
            Integer totalOccurrences,
            Integer resolvedSessionCount,
            LocalDateTime lastObservedAt,
            String displayCue,
            String evidenceWindow,
            List<SpeakingIssueExampleDto> recentExamples,
            String practiceAgainRoute,
            String practiceAgainLabel
    ) {
        this(
                issueKey,
                category,
                title,
                issueType,
                targetWord,
                targetPhone,
                null,
                null,
                status,
                statusExplanation,
                distinctSessionsObserved,
                totalOccurrences,
                resolvedSessionCount,
                lastObservedAt,
                displayCue,
                evidenceWindow,
                recentExamples != null ? recentExamples : new ArrayList<>(),
                practiceAgainRoute,
                practiceAgainLabel
        );
    }
}
