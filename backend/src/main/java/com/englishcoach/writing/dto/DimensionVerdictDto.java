package com.englishcoach.writing.dto;

import com.englishcoach.writing.enums.DimensionStatus;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
@JsonIgnoreProperties(ignoreUnknown = true)
public class DimensionVerdictDto {
    private String dimension;
    private DimensionStatus status;
    private String summary;
    private Integer score;
}
