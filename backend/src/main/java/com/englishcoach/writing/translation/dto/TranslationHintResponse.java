package com.englishcoach.writing.translation.dto;

import lombok.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationHintResponse {
    private UUID sessionId;
    private short unitOrdinal;
    private String hintLevel;
    private boolean referenceRevealed;
    private List<Map<String, Object>> visibleHints;
    private List<TranslationTokenDto> maskedTokens;
    private String referenceEn; // Only populated if referenceRevealed=true
    private long sessionRevision;
}
