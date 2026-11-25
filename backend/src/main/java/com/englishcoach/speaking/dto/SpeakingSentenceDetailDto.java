package com.englishcoach.speaking.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SpeakingSentenceDetailDto {
    private Long unitId;
    private Integer unitIndex;
    private String text;
    private String unitState; // e.g. "RESOLVED_THIS_SESSION", "ATTEMPTED", "SKIPPED", "NOT_STARTED"
    private String lockedTargetId;
    private String targetWord;
    private String primaryIssueType;
    private List<SpeakingShadowingAttemptDto> attempts;
}
