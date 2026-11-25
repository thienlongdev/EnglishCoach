package com.englishcoach.speaking.dto;

public record SpeakingSessionUpdateRequest(
        String status,
        Integer durationSeconds
) {}
