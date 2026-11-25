package com.englishcoach.writing.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ErrorDensityPointDto {
    private String date;
    private double errorsPerHundredWords;
    private int totalWords;
    private int totalErrors;
}
