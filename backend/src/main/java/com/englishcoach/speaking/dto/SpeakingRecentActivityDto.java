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
public class SpeakingRecentActivityDto {
    private Long sessionId;
    private String mode; // "SHADOWING", "ROLEPLAY", "QUICK_CHECK"
    private String title;
    private String contentTitle;
    private String summary;
    private String status;
    private Integer durationSeconds;
    private String targetWord;
    private Long sourceId;
    private Integer completedUnits;
    private Integer totalUnits;
    private LocalDateTime createdAt;
}
