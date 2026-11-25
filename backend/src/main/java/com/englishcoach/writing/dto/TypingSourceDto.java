package com.englishcoach.writing.dto;

import java.time.Instant;
import java.util.List;

public record TypingSourceDto(String id, String title, Instant savedAt, String text) {
    public record Page(List<TypingSourceDto> content, boolean hasNext) {}
}
