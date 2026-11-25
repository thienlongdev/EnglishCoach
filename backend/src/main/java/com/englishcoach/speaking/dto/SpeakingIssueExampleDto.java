package com.englishcoach.speaking.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SpeakingIssueExampleDto {
    private String targetWord;
    private String sentenceSnippet;
    private String originalPhrase;
    private String suggestedPhrase;
    private String explanation;
    private String sourceTitle;
    private Long sourceId;
    private String mode; // "SHADOWING", "ROLEPLAY", "QUICK_CHECK"
    private LocalDateTime timestamp;
}
