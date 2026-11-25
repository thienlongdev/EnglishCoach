package com.englishcoach.writing.translation.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.*;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationIssueAiDto {
    @JsonProperty("offset_start")
    private int offsetStart;

    @JsonProperty("offset_end")
    private int offsetEnd;

    @JsonProperty("flagged_text")
    private String flaggedText;

    @JsonProperty("category")
    private String category;

    @JsonProperty("message")
    private String message;

    @JsonProperty("suggestion")
    private String suggestion;
}
