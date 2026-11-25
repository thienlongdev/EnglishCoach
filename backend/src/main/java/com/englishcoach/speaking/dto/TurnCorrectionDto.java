package com.englishcoach.speaking.dto;

public record TurnCorrectionDto(
        String type, // "GRAMMAR", "VOCABULARY", "NATURALNESS"
        String original,
        String suggestion,
        String explanation,
        String priority // "HIGH", "MEDIUM", "LOW"
) {}
