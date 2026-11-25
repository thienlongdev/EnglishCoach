package com.englishcoach.writing.translation.paragraph.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphPassageSummaryDto {
    private UUID id;
    private String genre;
    private String topic;
    private String difficultyStatus;
    private String sourceViExcerpt;
    private String referenceEnExcerpt;
    private String sourceTitle;
    private String attributionText;
    private String licenseCode;
}
