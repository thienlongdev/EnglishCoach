package com.englishcoach.writing.dto;

import com.englishcoach.writing.enums.WritingSourceType;
import lombok.*;

import java.util.ArrayList;
import java.util.List;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WritingSourceContextDto {
    private WritingSourceType sourceType;
    private String sourceId;
    private String sourceTitle;
    private String sourceExcerpt;

    @Builder.Default
    private List<String> targetWords = new ArrayList<>();

    private String suggestedCategory;
    private String suggestedRegister;
    private String suggestedPrompt;

    @Builder.Default
    private List<String> suggestedRequirements = new ArrayList<>();

    private Integer targetWordCountMin;
    private Integer targetWordCountMax;
}
