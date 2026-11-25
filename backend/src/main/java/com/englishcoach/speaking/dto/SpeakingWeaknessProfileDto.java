package com.englishcoach.speaking.dto;

import lombok.Builder;
import java.util.List;

@Builder
public record SpeakingWeaknessProfileDto(
        List<SpeakingRecurringIssueDto> issues,
        List<CorrectionCategoryCountDto> topCorrectionCategories,
        List<AlignmentIssueCountDto> topAlignmentIssues
) {
    public SpeakingWeaknessProfileDto(
            List<CorrectionCategoryCountDto> topCorrectionCategories,
            List<AlignmentIssueCountDto> topAlignmentIssues
    ) {
        this(
                List.of(),
                topCorrectionCategories != null ? topCorrectionCategories : List.of(),
                topAlignmentIssues != null ? topAlignmentIssues : List.of()
        );
    }
}
