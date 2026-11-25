package com.englishcoach.reading.dto;

import java.util.List;

public record BilingualReadingCatalogResponse(String catalogRevision, long totalElements,
        long articleCount, long storyCount, List<Card> content) {
    public record Card(Long id, String contentType, String titleEn, String titleVi,
            String difficultyLevel, int wordCount, int estimatedMinutes) {}
}
