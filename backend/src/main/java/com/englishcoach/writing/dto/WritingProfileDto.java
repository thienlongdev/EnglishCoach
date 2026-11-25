package com.englishcoach.writing.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class WritingProfileDto {
    private Long userId;
    private String cefrLevel;
    private String preferredRegister;
    private List<String> goals;
    private List<String> interests;
    private String explanationLocale;
    private String provenance;
    private Long version;
    private Instant updatedAt;
}
