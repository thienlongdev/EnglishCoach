package com.englishcoach.speaking.dto;

public record CorrectionCategoryCountDto(
        String category, // "GRAMMAR", "VOCABULARY", "NATURALNESS"
        Long count
) {}
