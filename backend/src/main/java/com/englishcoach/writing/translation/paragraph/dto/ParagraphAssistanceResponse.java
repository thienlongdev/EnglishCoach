package com.englishcoach.writing.translation.paragraph.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphAssistanceResponse {
    private UUID sessionId;
    private Integer ordinal;
    private UUID passageId;
    private Boolean fullReferenceRevealed;
    private String fullReferenceEn; // populated only when fullReferenceRevealed is true

    @Builder.Default
    private List<ParagraphAssistanceSegmentDto> segments = new ArrayList<>();
}
