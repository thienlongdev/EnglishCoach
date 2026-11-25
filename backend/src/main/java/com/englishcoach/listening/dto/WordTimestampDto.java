package com.englishcoach.listening.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WordTimestampDto {
    private String word;
    private Double start;
    private Double end;
}
