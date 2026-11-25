package com.englishcoach.writing.translation.dto;

import lombok.*;

import java.time.Instant;
import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationSessionSummaryDto {
    private UUID sessionId;
    private UUID exerciseId;
    private String mode;
    private String topicCode;
    private String difficultyBucket;
    private short currentOrdinal;
    private int totalUnits;
    private long sessionRevision;
    private Instant updatedAt;
}
