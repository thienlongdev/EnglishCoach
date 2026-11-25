package com.englishcoach.writing.dto;

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
public class DraftComparisonResultDto {
    private String draft1Id;
    private String draft2Id;
    private Integer draft1Ordinal;
    private Integer draft2Ordinal;

    @Builder.Default
    private List<DraftDiffChunkDto> diffChunks = new ArrayList<>();

    @Builder.Default
    private Integer resolvedIssueCount = 0;

    @Builder.Default
    private Integer unresolvedIssueCount = 0;

    @Builder.Default
    private Integer wordCountChange = 0;
}
