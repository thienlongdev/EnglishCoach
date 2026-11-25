package com.englishcoach.writing.translation.paragraph.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphIssueDto {
    private String dimension;       // MEANING, GRAMMAR, NATURALNESS, VOCABULARY, COHESION
    private String issueType;       // ERROR, IMPROVEMENT, STYLE
    private String severity;        // MAJOR, MINOR, SUGGESTION
    private String learnerSpan;
    private Integer spanStart;
    private Integer spanEnd;
    private String message;
    private String suggestion;
}
