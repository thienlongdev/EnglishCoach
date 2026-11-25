package com.englishcoach.writing.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class WritingCapabilitiesDto {
    private boolean enabled;
    private boolean mutationsEnabled;
    private boolean assessmentsEnabled;
    private boolean workerEnabled;
    private int maxSentenceChars;
    private int maxDraftWords;
    private int maxDraftChars;
}
