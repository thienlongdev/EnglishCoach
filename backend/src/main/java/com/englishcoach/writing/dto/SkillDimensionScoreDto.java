package com.englishcoach.writing.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SkillDimensionScoreDto {
    private String dimension;
    private String name;
    private Integer score;
    private int evidenceCount;
    private String trend;
    private String guidance;
}
