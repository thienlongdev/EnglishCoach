package com.englishcoach.speaking.dto;

public record AlignmentIssueCountDto(
        String issue, // "MISSING_WORD", "WRONG_WORD"
        Long count
) {}
