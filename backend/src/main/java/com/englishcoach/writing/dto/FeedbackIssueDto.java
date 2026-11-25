package com.englishcoach.writing.dto;

import com.englishcoach.writing.enums.IssueDisposition;
import com.englishcoach.writing.enums.IssueKind;
import com.englishcoach.writing.enums.IssueSeverity;
import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class FeedbackIssueDto {
    private String id;
    private IssueKind kind;
    private IssueSeverity severity;
    private String category;

    @JsonProperty("patternCode")
    @JsonAlias({"pattern_code", "patternCode"})
    private String patternCode;

    private String title;
    private String explanation;

    @JsonProperty("sourceQuote")
    @JsonAlias({"source_quote", "sourceQuote"})
    private String sourceQuote;

    @JsonProperty("startOffset")
    @JsonAlias({"start_offset", "startOffset"})
    private Integer startOffset;

    @JsonProperty("endOffset")
    @JsonAlias({"end_offset", "endOffset"})
    private Integer endOffset;

    private String replacement;

    @JsonProperty("teachingRule")
    @JsonAlias({"teaching_rule", "teachingRule"})
    private String teachingRule;

    @JsonProperty("suggestedPracticeMode")
    @JsonAlias({"suggested_practice_mode", "suggestedPracticeMode"})
    private String suggestedPracticeMode;

    @Builder.Default
    private IssueDisposition disposition = IssueDisposition.ACTIVE;

    @Builder.Default
    private Integer priorityRank = 99;

    @JsonProperty("pattern_code")
    public String getPatternCodeSnake() {
        return patternCode;
    }

    @JsonProperty("source_quote")
    public String getSourceQuoteSnake() {
        return sourceQuote;
    }

    @JsonProperty("start_offset")
    public Integer getStartOffsetSnake() {
        return startOffset;
    }

    @JsonProperty("end_offset")
    public Integer getEndOffsetSnake() {
        return endOffset;
    }
}
