package com.englishcoach.writing.translation.dto;

import lombok.*;

import java.util.List;
import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationSessionResponse {
    private UUID sessionId;
    private UUID exerciseId;
    private String mode;
    private String topicCode;
    private String difficultyBucket;
    private String cefrBand;
    private int contentVersion;
    private short currentOrdinal;
    private int totalUnits;
    private long sessionRevision;
    private String status;
    private TranslationUnitResponse currentUnit;
    private List<TranslationUnitResponse> units;
}
