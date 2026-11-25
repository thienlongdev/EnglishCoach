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
public class SpeakingRecentImprovementDto {
    private Long sessionId;
    private String materialTitle;
    private String targetWord;
    private String targetPhone;
    private String issueType;
    private Integer retryCount;
    private LocalDateTime resolvedAt;
    private String note;
}
