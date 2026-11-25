package com.englishcoach.reading.dto;

import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ReadingMaterialResponse {

    private String sourceName;
    private String licenseCode;
    private String attribution;
    private String topic;
    private Long id;
    private String title;
    private String sourceUrl;
    private String materialType;
    private String contentText;
    private Integer wordCount;
    private String difficultyLevel;
    private Long ownerUserId;
    private Boolean isSystem;
    private String documentSchemaVersion;
    private String sourceDocumentType;
    private String sourceFileName;
    private Boolean hasDocumentRepresentation;
    private Object canonicalDocument;
}
