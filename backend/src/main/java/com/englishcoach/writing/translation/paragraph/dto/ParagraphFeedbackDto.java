package com.englishcoach.writing.translation.paragraph.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphFeedbackDto {
    private Boolean accepted;
    private String evaluationStatus;     // ACCEPTED, NEEDS_REVISION, UNCERTAIN
    private String overallSummary;

    // 5 Grading dimensions
    private String meaningVerdict;       // PASS, NEEDS_ATTENTION, UNCERTAIN
    private Integer meaningScore;
    private String grammarVerdict;
    private Integer grammarScore;
    private String naturalnessVerdict;
    private Integer naturalnessScore;
    private String vocabularyVerdict;
    private Integer vocabularyScore;
    private String cohesionVerdict;
    private Integer cohesionScore;

    @Builder.Default
    private List<ParagraphIssueDto> issues = new ArrayList<>();

    private String suggestedCorrection;
    private String naturalAlternative;
    private String referenceEn;

    private String modelId;
    private Integer generationCount;
    private Boolean cached;
    private Long latencyMs;
}
