package com.englishcoach.writing.translation.paragraph.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphSessionResponse {
    private UUID sessionId;
    private String status;
    private Integer currentIndex;
    private Long sessionRevision;
    private Integer totalItems;
    private String clientMutationId;
    private String filterGenre;
    private String filterTopic;
    private List<ParagraphSessionItemResponse> items;
    private Instant createdAt;
    private Instant updatedAt;
}
