package com.englishcoach.writing.translation.dto;

import lombok.*;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationFeedbackDto {
    private String meaningVerdict;      // ACCURATE, PARTIAL, INACCURATE, UNCERTAIN
    private String grammarVerdict;      // ACCURATE, MINOR_ISSUES, INCORRECT, UNCERTAIN
    private String naturalnessVerdict;  // NATURAL, ACCEPTABLE, AWKWARD, UNCERTAIN
    private String overallStatus;       // ACCEPTED, NEEDS_REVISION, INCORRECT, UNCERTAIN
    private String headlineSummary;     // Vietnamese learner-facing summary
    private String naturalSuggestion;   // Refined natural English alternative
    private List<TranslationIssueDto> issues;
}
