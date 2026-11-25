package com.englishcoach.speaking.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SpeakingSessionHistoryPageDto {
    private List<SpeakingSessionSummaryDto> content;
    private int page;
    private int size;
    private long totalElements;
    private int totalPages;
    private boolean hasNext;
    private String modeFilter;
    private String statusFilter;
    private FilterCounts counts;

    public SpeakingSessionHistoryPageDto(
            List<SpeakingSessionSummaryDto> content,
            int page,
            int size,
            long totalElements,
            int totalPages,
            boolean hasNext
    ) {
        this(content, page, size, totalElements, totalPages, hasNext, null, null, null);
    }

    public record FilterCounts(
            long all,
            long completed,
            long active,
            long shadowing,
            long roleplay,
            long quickCheck
    ) {}
}
