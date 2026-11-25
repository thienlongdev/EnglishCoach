package com.englishcoach.writing.translation.paragraph.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphCatalogResponse {
    private Boolean enabled;
    private Long totalEligiblePassages;
    private List<ParagraphGenreCountDto> availableGenres;
    private List<ParagraphTopicCountDto> topics;
    private ParagraphDifficultyDto difficulty;
    private ParagraphSessionSummaryDto activeSession;
}
