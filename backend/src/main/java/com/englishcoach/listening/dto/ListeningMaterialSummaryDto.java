package com.englishcoach.listening.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ListeningMaterialSummaryDto {
    private Long id;
    private String title;
    private String audioUrl;

    private String sourceType;
    private String voiceId;
    private Integer durationSeconds;
    private String cefrLevel;
    private String topic;
    private String accent;
    private Integer speakerCount;
    private Long ownerUserId;
    private Boolean isSystem;
}
