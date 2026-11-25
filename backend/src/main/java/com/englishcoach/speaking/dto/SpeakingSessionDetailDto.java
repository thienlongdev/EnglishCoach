package com.englishcoach.speaking.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SpeakingSessionDetailDto {
    private Long sessionId;
    private Long materialId;
    private String materialTitle;
    private String mode;
    private String status;
    private Integer currentUnitIndex;
    private Integer completedUnitsCount;
    private Integer totalUnitsCount;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;
    private List<SpeakingSentenceDetailDto> sentences;
    private Long scenarioId;
    private String scenarioTitle;
    private String learnerRole;
    private String aiRole;
    private String learnerGoal;
    private List<String> targetVocabulary;
    private List<SpeakingTurnDto> turns;
    private QuickCheckResponseDto quickCheck;
}
