package com.englishcoach.writing.translation.dto;

import lombok.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationUnitResponse {
    private UUID unitId;
    private short ordinal;
    private String sourceVi;
    private String hintLevel;
    private boolean referenceRevealed;
    private String draftText;
    private String terminalStatus;
    private List<Map<String, Object>> visibleHints;
    private List<TranslationTokenDto> maskedTokens;
    private String referenceEn; // NULL unless referenceRevealed=true or terminalStatus='ACCEPTED'
}
