package com.englishcoach.writing.translation.dto;

import lombok.*;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationIssueDto {
    private int offsetStart;
    private int offsetEnd;
    private String flaggedText;
    private String category;
    private String message;
    private String suggestion;
}
