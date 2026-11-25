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
public class ParagraphDraftResponse {
    private UUID sessionId;
    private Integer ordinal;
    private Long draftRevision;
    private String progressState;
    private Instant updatedAt;
}
