package com.englishcoach.writing.translation.paragraph.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphSessionSummaryDto {
    private UUID sessionId;
    private Integer currentIndex;
    private Integer totalItems;
    private String filterGenre;
    private String filterTopic;
    private Instant updatedAt;
}
