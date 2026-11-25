package com.englishcoach.reading.dto;

import java.util.List;

public record ReadingCatalogResponse(String catalogRevision, long totalElements, int page, int size,
                                     int totalPages, List<String> topics, List<Card> content) {
    public record Card(Long id, String title, String sourceUrl, String sourceName, String materialType,
                       int wordCount, String difficultyLevel, boolean isSystem, String topic,
                       int readMinutes, String description, String licenseCode, String attribution) {}
    public record Progress(Long materialId, int scrollPercentage, String lastReadAt, Card material) {}
}
