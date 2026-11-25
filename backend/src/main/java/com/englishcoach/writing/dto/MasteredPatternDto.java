package com.englishcoach.writing.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class MasteredPatternDto {
    private String patternCode;
    private String title;
    private String category;
    private int occurrenceCount;
    private int contextCount;
    private Integer masteryPercentage;
    private String status;
}
