package com.englishcoach.speaking.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SpeakingPracticeSummaryDto {
    private Long sessionsCompleted7d;
    private Long sessionsCompleted30d;
    private Long sentencesPracticed7d;
    private Long sentencesPracticed30d;
    private Integer practiceDays7d;
    private Integer practiceDays30d;
    private Long retries30d;
    private Long resolvedThisSessionCount30d;
    private Long roleplayTurns7d;
    private Long roleplayTurns30d;
    private Long quickChecks7d;
    private Long quickChecks30d;
    private Long speakingSeconds7d;
    private Long speakingSeconds30d;
    private Long inProgressSessionsCount;

    public SpeakingPracticeSummaryDto(
            Long sessionsCompleted7d,
            Long sessionsCompleted30d,
            Long sentencesPracticed7d,
            Long sentencesPracticed30d,
            Integer practiceDays7d,
            Integer practiceDays30d,
            Long retries30d,
            Long resolvedThisSessionCount30d
    ) {
        this(
                sessionsCompleted7d,
                sessionsCompleted30d,
                sentencesPracticed7d,
                sentencesPracticed30d,
                practiceDays7d,
                practiceDays30d,
                retries30d,
                resolvedThisSessionCount30d,
                null,
                null,
                null,
                null,
                null,
                null,
                null
        );
    }
}
