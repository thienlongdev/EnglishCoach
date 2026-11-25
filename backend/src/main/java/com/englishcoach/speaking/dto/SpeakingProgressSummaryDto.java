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
public class SpeakingProgressSummaryDto {
    @Builder.Default
    private String policyVersion = "SPEAKING_PROGRESS_POLICY_v1";
    private ShadowingSessionStateDto activeSession;
    private SpeakingPracticeSummaryDto practiceSummary;
    private List<SpeakingSessionSummaryDto> recentSessions;
    private List<SpeakingRecurringIssueDto> recurringIssues;
    private List<SpeakingRecentImprovementDto> recentImprovements;
    private SpeakingPronunciationMetricsDto pronunciationMetrics;
    private LocalDateTime generatedAt;
}
