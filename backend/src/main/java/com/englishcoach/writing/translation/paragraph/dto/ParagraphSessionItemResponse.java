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
public class ParagraphSessionItemResponse {
    private UUID itemId;
    private UUID passageId;
    private Integer ordinal;
    private Integer contentVersion;
    private String sourceVi;
    private String referenceEn;
    private String sourceTitle;
    private String targetTitle;
    private String genre;
    private String topic;
    private String difficultyStatus;
    private String attributionText;
    private String licenseCode;
    private String sourceUrl;
    private String targetUrl;
    private String draftText;
    private Long draftRevision;
    private String progressState;
}
