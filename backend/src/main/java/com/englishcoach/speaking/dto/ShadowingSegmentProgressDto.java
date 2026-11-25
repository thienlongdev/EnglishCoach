package com.englishcoach.speaking.dto;

public record ShadowingSegmentProgressDto(
        Long unitId,
        Long attemptCount,
        Double bestAccuracy
) {
    public boolean isPracticed() {
        return attemptCount != null && attemptCount > 0;
    }
}
