package com.englishcoach.writing.dto;

import com.englishcoach.writing.enums.PracticeMode;
import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PracticeStartRequest {
    private PracticeMode mode;
    private String targetPatternCode;
    private String exerciseId;
    private String sourceIssueId;
    private String sourceSessionId;
    private String clientMutationId;
}
