package com.englishcoach.reading.dto;

import java.util.List;

public record BilingualReadingDetailResponse(Long id, String contentType, String titleEn,
        String titleVi, String difficultyLevel, int wordCount, int estimatedMinutes,
        List<Segment> segments) {
    public record Segment(int position, String en, String vi, String sourceReference) {}
}
