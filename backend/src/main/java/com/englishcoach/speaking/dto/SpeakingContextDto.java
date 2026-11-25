package com.englishcoach.speaking.dto;

import java.util.List;

public record SpeakingContextDto(
        String sourceType,
        Long sourceId,
        String sourceTitle,
        String cefrLevel,
        String topic,
        List<String> targetVocabulary,
        List<String> targetPhrases
) {}
