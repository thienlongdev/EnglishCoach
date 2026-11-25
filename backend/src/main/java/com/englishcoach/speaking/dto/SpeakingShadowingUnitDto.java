package com.englishcoach.speaking.dto;

import com.englishcoach.speaking.entity.ShadowingTimingQuality;
import com.englishcoach.speaking.entity.ShadowingTimingStrategy;

public record SpeakingShadowingUnitDto(
        Long id,
        Long materialId,
        Integer sequenceNumber,
        Integer startTimeMs,
        Integer endTimeMs,
        String displayText,
        Integer generationVersion,
        ShadowingTimingQuality timingQuality,
        ShadowingTimingStrategy timingStrategy,
        Long attemptCount,
        Double bestAccuracy,
        Boolean isPracticed,
        String ipa,
        String wordIpaJson,
        String translation
) {
    public SpeakingShadowingUnitDto(
            Long id,
            Long materialId,
            Integer sequenceNumber,
            Integer startTimeMs,
            Integer endTimeMs,
            String displayText,
            Integer generationVersion,
            ShadowingTimingQuality timingQuality,
            ShadowingTimingStrategy timingStrategy,
            Long attemptCount,
            Double bestAccuracy,
            Boolean isPracticed
    ) {
        this(id, materialId, sequenceNumber, startTimeMs, endTimeMs, displayText, generationVersion,
                timingQuality, timingStrategy, attemptCount, bestAccuracy, isPracticed, null, null, null);
    }
}
