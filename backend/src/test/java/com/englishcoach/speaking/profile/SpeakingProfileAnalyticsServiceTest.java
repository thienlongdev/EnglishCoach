package com.englishcoach.speaking.profile;

import com.englishcoach.auth.entity.User;
import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.*;
import com.englishcoach.speaking.entity.enums.CefrLevel;
import com.englishcoach.speaking.profile.SpeakingProfileDtos.*;
import com.englishcoach.speaking.profile.SpeakingProfileQueryRepository.*;
import com.englishcoach.speaking.repository.SpeakingQuickCheckRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingTurnFeedbackRepository;
import com.englishcoach.speaking.service.SpeakingProgressAggregationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingProfileAnalyticsServiceTest {

    @Mock
    private SpeakingProfileQueryRepository queryRepository;

    @Mock
    private SpeakingShadowingAttemptRepository attemptRepository;

    @Mock
    private SpeakingQuickCheckRepository quickCheckRepository;

    @Mock
    private SpeakingTurnFeedbackRepository feedbackRepository;

    @Mock
    private SpeakingProgressAggregationService legacyAggregationService;

    private SpeakingProfileAnalyticsService service;
    private User userA;

    @BeforeEach
    void setUp() {
        service = new SpeakingProfileAnalyticsService(
                queryRepository,
                attemptRepository,
                quickCheckRepository,
                feedbackRepository,
                legacyAggregationService,
                new ObjectMapper()
        );
        userA = User.builder().id(101L).email("user-a@englishcoach.io.vn").name("User A").build();
    }

    @Test
    @DisplayName("1. Honest Zero/Null Semantics: New learner gets INSUFFICIENT_DATA and null scores, never fabricated 0s")
    void emptyLearnerReturnsHonestInsufficientDataAndNullScores() {
        when(queryRepository.findDistinctActiveDates(101L)).thenReturn(Set.of());
        when(queryRepository.findShadowingIssueMarkersSince(eq(101L), any())).thenReturn(List.of());
        when(queryRepository.findFeedbackCorrectionMarkersSince(eq(101L), any())).thenReturn(List.of());
        when(queryRepository.getSessionStatusAndModeCounts(101L)).thenReturn(List.of());
        when(queryRepository.findActiveShadowingHeader(101L)).thenReturn(Optional.empty());

        SpeakingHubEntryDto entry = service.getHubEntry(101L);
        assertThat(entry.currentStreakDays()).isZero();
        assertThat(entry.activeTargetsCount()).isZero();
        assertThat(entry.lifetimeCompletedSessions()).isZero();
        assertThat(entry.activeSession()).isNull();

        when(queryRepository.getLifetimeAggregateStats(101L)).thenReturn(
                new LifetimeAggregateStats(0, 0, 0, 0, 0, 0, 0, null));
        when(queryRepository.findSessionsSince(eq(101L), any())).thenReturn(List.of());
        when(attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any())).thenReturn(List.of());
        when(quickCheckRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any())).thenReturn(List.of());
        when(queryRepository.findLearnerTurnsSince(eq(101L), any())).thenReturn(List.of());
        when(feedbackRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any())).thenReturn(List.of());
        when(queryRepository.findVisibleMaterialsByIds(eq(101L), any())).thenReturn(Map.of());
        when(queryRepository.findPaginatedSessions(101L, "ALL", "ALL", 0, 5)).thenReturn(List.of());

        SpeakingProfileOverviewDto overview = service.getOverview(101L);
        assertThat(overview.dataSufficiency().hasAnyPractice()).isFalse();
        assertThat(overview.dataSufficiency().strengthsStatus()).isEqualTo("INSUFFICIENT_DATA");
        assertThat(overview.dataSufficiency().focusStatus()).isEqualTo("INSUFFICIENT_DATA");
        assertThat(overview.dataSufficiency().trendStatus()).isEqualTo("INSUFFICIENT_DATA");
        assertThat(overview.lifetime().averageContentMatchScore()).isNull();
        assertThat(overview.recentWindow().averagePronunciationScore30d()).isNull();
        assertThat(overview.recentWindow().averageContentMatchScore30d()).isNull();
        assertThat(overview.strengths()).isEmpty();
        assertThat(overview.focusAreas()).isEmpty();
        assertThat(overview.scoreTrend()).isEmpty();
        assertThat(overview.activityRhythm30d()).hasSize(30);
        assertThat(overview.activityRhythm30d()).allMatch(p -> !p.active() && p.averageScore() == null);

        SpeakingProfilePronunciationDto pron = service.getPronunciation(101L);
        assertThat(pron.sufficiencyStatus()).isEqualTo("INSUFFICIENT_DATA");
        assertThat(pron.metrics().getScoredAttemptsCount()).isZero();
        assertThat(pron.metrics().getAveragePronunciationScore()).isNull();
        assertThat(pron.metrics().getAverageStressScore()).isNull();
        assertThat(pron.recurringIssues()).isEmpty();
        assertThat(pron.strongPatterns()).isEmpty();
    }

    @Test
    @DisplayName("2. Lightweight Hub Entry: Does not load attempt/QuickCheck/feedback entities and blocks quarantined material titles")
    void hubEntryIsLightweightAndQuarantineSafe() {
        LocalDate today = LocalDate.now();
        LocalDateTime now = LocalDateTime.now();

        when(queryRepository.findDistinctActiveDates(101L)).thenReturn(Set.of(today, today.minusDays(1)));
        when(queryRepository.findShadowingIssueMarkersSince(eq(101L), any())).thenReturn(List.of(
                new ShadowingIssueMarkerRow(10L, "PHONE_SUBSTITUTION", "think"),
                new ShadowingIssueMarkerRow(11L, "PHONE_SUBSTITUTION", "think"),
                new ShadowingIssueMarkerRow(10L, "VALID_VARIANT", "water"),
                new ShadowingIssueMarkerRow(11L, "VALID_VARIANT", "water")
        ));
        when(queryRepository.findFeedbackCorrectionMarkersSince(eq(101L), any())).thenReturn(List.of());
        when(queryRepository.getSessionStatusAndModeCounts(101L)).thenReturn(List.of(
                new SessionStatusModeRow("COMPLETED", "SHADOWING", 4L),
                new SessionStatusModeRow("ACTIVE", "SHADOWING", 1L)
        ));
        // Active session references quarantined material 999 -> findVisibleMaterialsByIds returns empty map
        when(queryRepository.findActiveShadowingHeader(101L)).thenReturn(Optional.of(
                new ActiveShadowingHeader(55L, "ACTIVE", "SHADOWING", "LISTENING", 999L, 2, 2, 8, now.minusHours(1), now)
        ));
        when(queryRepository.findVisibleMaterialsByIds(101L, List.of(999L))).thenReturn(Map.of());

        SpeakingHubEntryDto entry = service.getHubEntry(101L);

        assertThat(entry.currentStreakDays()).isEqualTo(2);
        assertThat(entry.activeTargetsCount()).isEqualTo(1L); // VALID_VARIANT excluded
        assertThat(entry.lifetimeCompletedSessions()).isEqualTo(4L);
        assertThat(entry.activeSession()).isNotNull();
        assertThat(entry.activeSession().sessionId()).isEqualTo(55L);
        assertThat(entry.activeSession().completedUnitsCount()).isEqualTo(2);
        assertThat(entry.activeSession().totalUnitsCount()).isEqualTo(8);
        assertThat(entry.activeSession().materialTitle()).isNull();
        assertThat(entry.activeSessionTitle()).isNull();

        // Zero heavy table entity loads on Hub Entry!
        verifyNoInteractions(attemptRepository, quickCheckRepository, feedbackRepository);
    }

    @Test
    @DisplayName("3. Pronunciation V2.2 Integrity: Scored vs Abstained vs STT-only, Lexical Stress ratio, Strong Patterns & Statuses")
    void pronunciationReconcilesV2MetricsLexicalStressStatusesAndStrongPatterns() {
        LocalDateTime now = LocalDateTime.now();

        SpeakingSession s1 = SpeakingSession.builder().id(1L).user(userA).mode("SHADOWING").status("COMPLETED").sourceId(200L).createdAt(now.minusDays(5)).build();
        SpeakingSession s2 = SpeakingSession.builder().id(2L).user(userA).mode("SHADOWING").status("COMPLETED").sourceId(200L).createdAt(now.minusDays(4)).build();
        SpeakingSession s3 = SpeakingSession.builder().id(3L).user(userA).mode("SHADOWING").status("COMPLETED").sourceId(200L).createdAt(now.minusDays(2)).build();
        SpeakingSession s4 = SpeakingSession.builder().id(4L).user(userA).mode("ROLEPLAY").status("COMPLETED")
                .scenario(SpeakingScenario.builder().id(30L).title("Job Interview").cefrLevel(CefrLevel.B2).build())
                .createdAt(now.minusDays(1)).build();

        String v2JsonErr1 = """
                {
                  "status": "COMPLETED",
                  "overall": { "overallScore": 78, "segmentalScore": 80, "stressScore": 75, "intonationScore": 82, "rhythmScore": 79, "fluencyScore": 84 },
                  "lexicalStress": { "method": "ALIGNED_VOWEL_PROMINENCE_V1", "status": "ASSESSED", "assessed": 4, "matched": 3 },
                  "priorities": [{ "priorityRank": 1, "targetType": "PHONE", "targetUnit": "PHONE_SUBSTITUTION", "word": "think", "phone": "TH", "observed": "T", "instructionVi": "Đặt đầu lưỡi giữa hai hàm răng cho âm /θ/." }],
                  "words": [
                    { "wordIndex": 0, "word": "student", "status": "GOOD", "accuracyScore": 92 },
                    { "wordIndex": 1, "word": "system", "status": "GOOD", "accuracyScore": 90 }
                  ],
                  "phones": [
                    { "phoneIndex": 0, "wordIndex": 0, "expectedPhone": "S", "qualityClass": "ACCEPTABLE", "qualityScore": 91.0 },
                    { "phoneIndex": 1, "wordIndex": 1, "expectedPhone": "S", "qualityClass": "ACCEPTABLE", "qualityScore": 89.0 },
                    { "phoneIndex": 2, "wordIndex": 1, "expectedPhone": "S", "qualityClass": "ACCEPTABLE", "qualityScore": 88.0 }
                  ]
                }
                """;

        String v2JsonErr2 = """
                {
                  "status": "COMPLETED",
                  "overall": { "overallScore": 82, "segmentalScore": 84, "stressScore": 100, "intonationScore": 85, "rhythmScore": 83, "fluencyScore": 86 },
                  "lexicalStress": { "method": "ALIGNED_VOWEL_PROMINENCE_V1", "status": "ASSESSED", "assessed": 2, "matched": 2 },
                  "priorities": [
                    { "priorityRank": 1, "targetType": "PHONE", "targetUnit": "PHONE_SUBSTITUTION", "word": "think", "phone": "TH", "observed": "T" }
                  ],
                  "words": [
                    { "wordIndex": 0, "word": "speak", "status": "GOOD", "accuracyScore": 93 }
                  ],
                  "phones": [
                    { "phoneIndex": 0, "wordIndex": 0, "expectedPhone": "S", "qualityClass": "ACCEPTABLE", "qualityScore": 94.0 },
                    { "phoneIndex": 1, "wordIndex": 0, "expectedPhone": "S", "qualityClass": "ACCEPTABLE", "qualityScore": 92.0 }
                  ]
                }
                """;

        // Clean later sessions where "think" & "TH" were pronounced cleanly -> transitions "think" to RECENTLY_STABLE!
        String v2JsonClean3 = """
                {
                  "status": "COMPLETED",
                  "overall": { "overallScore": 90, "segmentalScore": 91, "fluencyScore": 89 },
                  "lexicalStress": { "method": "ALIGNED_VOWEL_PROMINENCE_V1", "status": "INSUFFICIENT_EVIDENCE", "assessed": 0, "matched": 0 },
                  "priorities": [{ "priorityRank": 1, "targetType": "STRESS", "targetUnit": "PRIMARY_STRESS", "word": "comfortable" }],
                  "words": [{ "wordIndex": 0, "word": "think", "status": "GOOD", "accuracyScore": 94 }],
                  "phones": [{ "phoneIndex": 0, "wordIndex": 0, "expectedPhone": "TH", "qualityClass": "ACCEPTABLE", "qualityScore": 92.0 }]
                }
                """;

        String v2JsonClean4 = """
                {
                  "status": "COMPLETED",
                  "overall": { "overallScore": 92, "segmentalScore": 93, "fluencyScore": 90 },
                  "words": [{ "wordIndex": 0, "word": "think", "status": "GOOD", "accuracyScore": 95 }],
                  "phones": [{ "phoneIndex": 0, "wordIndex": 0, "expectedPhone": "TH", "qualityClass": "ACCEPTABLE", "qualityScore": 95.0 }]
                }
                """;

        String v2AbstainedJson = """
                {
                  "status": "ABSTAINED",
                  "abstentionReason": "LOW_SNR"
                }
                """;

        SpeakingShadowingAttempt a1 = SpeakingShadowingAttempt.builder()
                .id(1L).user(userA).session(s1).accuracyScore(88.0).pronunciationScore(78.0).fluencyScore(84.0)
                .primaryIssueType("PHONE_SUBSTITUTION").targetWord("think").analysisStatus("COMPLETED")
                .productSafeResultJson(v2JsonErr1).createdAt(now.minusDays(5)).build();
        SpeakingShadowingAttempt a2 = SpeakingShadowingAttempt.builder()
                .id(2L).user(userA).session(s2).accuracyScore(91.0).pronunciationScore(82.0).fluencyScore(86.0)
                .primaryIssueType("PHONE_SUBSTITUTION").targetWord("think").analysisStatus("COMPLETED")
                .productSafeResultJson(v2JsonErr2).createdAt(now.minusDays(4)).build();
        SpeakingShadowingAttempt a3 = SpeakingShadowingAttempt.builder()
                .id(3L).user(userA).session(s3).accuracyScore(95.0).pronunciationScore(90.0).fluencyScore(89.0)
                .primaryIssueType("PRIMARY_STRESS").targetWord("comfortable").analysisStatus("COMPLETED")
                .productSafeResultJson(v2JsonClean3).createdAt(now.minusDays(2)).build();
        SpeakingShadowingAttempt a4Abstained = SpeakingShadowingAttempt.builder()
                .id(4L).user(userA).session(s3).accuracyScore(80.0).pronunciationScore(null).fluencyScore(null)
                .analysisStatus("ABSTAINED").productSafeResultJson(v2AbstainedJson).createdAt(now.minusDays(2)).build();
        SpeakingShadowingAttempt a5SttOnly = SpeakingShadowingAttempt.builder()
                .id(5L).user(userA).session(s3).accuracyScore(76.0).pronunciationScore(null).fluencyScore(null)
                .analysisStatus("ASR_ONLY").productSafeResultJson(null).createdAt(now.minusDays(2)).build();

        SpeakingTurn rpTurn = SpeakingTurn.builder()
                .id(10L).session(s4).speaker("LEARNER").text("I think this system works well.")
                .pronunciationScore(92).segmentalScore(93).fluencyScore(90)
                .pronunciationResultJson(v2JsonClean4).createdAt(now.minusDays(1)).build();

        when(attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any()))
                .thenReturn(List.of(a1, a2, a3, a4Abstained, a5SttOnly));
        when(quickCheckRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any()))
                .thenReturn(List.of());
        when(queryRepository.findLearnerTurnsSince(eq(101L), any()))
                .thenReturn(List.of(rpTurn));
        when(queryRepository.findVisibleMaterialsByIds(eq(101L), any()))
                .thenReturn(Map.of(200L, new VisibleMaterialMeta(200L, "Tech Talk", null, "abc123xyz", "B2")));

        SpeakingProfilePronunciationDto pron = service.getPronunciation(101L);

        assertThat(pron.sufficiencyStatus()).isEqualTo("READY");
        assertThat(pron.distinctAssessedSessionsCount()).isEqualTo(4);
        assertThat(pron.metrics().getTotalAttemptsCount()).isEqualTo(6L);
        assertThat(pron.metrics().getScoredAttemptsCount()).isEqualTo(4L);
        assertThat(pron.metrics().getAbstainedAttemptsCount()).isEqualTo(1L);
        assertThat(pron.metrics().getSttOnlyAttemptsCount()).isEqualTo(1L);
        assertThat(pron.metrics().getShadowingScoredCount()).isEqualTo(3L);
        assertThat(pron.metrics().getRoleplayScoredCount()).isEqualTo(1L);

        // Lexical stress numerator = 3 + 2 = 5, denominator = 4 + 2 = 6 (INSUFFICIENT_EVIDENCE attempt excluded!)
        assertThat(pron.metrics().getLexicalStressMatchedWords()).isEqualTo(5L);
        assertThat(pron.metrics().getLexicalStressAssessedWords()).isEqualTo(6L);
        assertThat(pron.metrics().getLexicalStressAssessmentsCount()).isEqualTo(2L);
        assertThat(pron.metrics().getAverageStressScore()).isEqualTo(87.5); // (75 + 100) / 2

        // Multi-session "think" (/θ/) followed by 2 subsequent clean sessions -> RECENTLY_STABLE!
        assertThat(pron.recurringIssues()).hasSize(1);
        SpeakingRecurringIssueDto thinkIssue = pron.recurringIssues().getFirst();
        assertThat(thinkIssue.getTargetWord()).isEqualTo("think");
        assertThat(thinkIssue.getTargetPhone()).isEqualTo("TH");
        assertThat(thinkIssue.getObservedPhone()).isEqualTo("T");
        assertThat(thinkIssue.getStatus()).isEqualTo("RECENTLY_STABLE");

        // Single-session "comfortable" stress observation stays strictly in singleSessionObservations as INSUFFICIENT_DATA
        assertThat(pron.singleSessionObservations()).hasSize(1);
        assertThat(pron.singleSessionObservations().getFirst().getTargetWord()).isEqualTo("comfortable");
        assertThat(pron.singleSessionObservations().getFirst().getCategory()).isEqualTo("STRESS");
        assertThat(pron.singleSessionObservations().getFirst().getStatus()).isEqualTo("INSUFFICIENT_DATA");

        // Strong phoneme pattern /s/ (5 observations across 2 attempts & 3 distinct words, 100% acceptable, avg > 80)
        assertThat(pron.strongPatterns()).hasSize(1);
        SpeakingStrongPhonemePatternDto sPattern = pron.strongPatterns().getFirst();
        assertThat(sPattern.phone()).isEqualTo("S");
        assertThat(sPattern.ipaDisplay()).isEqualTo("/s/");
        assertThat(sPattern.observationsCount()).isEqualTo(5);
        assertThat(sPattern.acceptableRate()).isEqualTo(100.0);
        assertThat(sPattern.exampleWords()).containsExactly("student", "system", "speak");
    }

    @Test
    @DisplayName("4. Overview Thresholds: Sample-size < 3 withholds acoustic strength; >= 3 emits honest strength & chronological trend")
    void overviewEnforcesStrengthSampleThresholdAndChronologicalScoreTrend() {
        LocalDateTime now = LocalDateTime.now();
        SpeakingSession sOld = SpeakingSession.builder().id(10L).user(userA).mode("SHADOWING").status("COMPLETED").sourceId(200L).completedUnitsCount(4).totalUnitsCount(4).createdAt(now.minusDays(3)).build();
        SpeakingSession sNew = SpeakingSession.builder().id(11L).user(userA).mode("ROLEPLAY").status("ACTIVE").createdAt(now.minusDays(1)).build();

        SpeakingShadowingAttempt a1 = SpeakingShadowingAttempt.builder().id(1L).user(userA).session(sOld).accuracyScore(92.0).pronunciationScore(85.0).durationSeconds(8).createdAt(now.minusDays(3)).build();
        SpeakingShadowingAttempt a2 = SpeakingShadowingAttempt.builder().id(2L).user(userA).session(sOld).accuracyScore(94.0).pronunciationScore(88.0).durationSeconds(7).createdAt(now.minusDays(3)).build();

        when(queryRepository.getSessionStatusAndModeCounts(101L)).thenReturn(List.of(
                new SessionStatusModeRow("COMPLETED", "SHADOWING", 1L),
                new SessionStatusModeRow("ACTIVE", "ROLEPLAY", 1L)
        ));
        when(queryRepository.getLifetimeAggregateStats(101L)).thenReturn(
                new LifetimeAggregateStats(2, 15, 12, 1, 10, 0, 3, 93.0));
        when(queryRepository.findDistinctActiveDates(101L)).thenReturn(Set.of(now.toLocalDate().minusDays(1), now.toLocalDate().minusDays(3)));
        when(queryRepository.findSessionsSince(eq(101L), any())).thenReturn(List.of(sNew, sOld)); // desc from DB
        when(attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any())).thenReturn(List.of(a1, a2));
        when(quickCheckRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any())).thenReturn(List.of());
        when(queryRepository.findLearnerTurnsSince(eq(101L), any())).thenReturn(List.of());
        when(feedbackRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any())).thenReturn(List.of());
        when(queryRepository.findVisibleMaterialsByIds(eq(101L), any())).thenReturn(
                Map.of(200L, new VisibleMaterialMeta(200L, "Daily News", null, null, "B1")));
        when(queryRepository.aggregateShadowingStatsBySessionIds(any())).thenReturn(
                Map.of(10L, new ShadowingSessionBatchStats(10L, 2, 0, 0, 86.5, 93.0, 15)));
        when(queryRepository.aggregateRoleplayStatsBySessionIds(any())).thenReturn(
                Map.of(11L, new RoleplaySessionBatchStats(11L, 1, 89.0, 10)));
        when(queryRepository.findQuickCheckSummariesBySessionIds(any())).thenReturn(Map.of());

        // Only 2 scored attempts (< MIN_SCORED_ATTEMPTS_FOR_STRENGTH = 3) -> 0 acoustic strengths!
        SpeakingProfileOverviewDto ovUnderThreshold = service.getOverview(101L);
        assertThat(ovUnderThreshold.strengths()).isEmpty();
        assertThat(ovUnderThreshold.dataSufficiency().strengthsStatus()).isEqualTo("BUILDING_EVIDENCE");
        assertThat(ovUnderThreshold.lifetime().completedSessions()).isEqualTo(1L);
        assertThat(ovUnderThreshold.lifetime().inProgressSessions()).isEqualTo(1L);
        assertThat(ovUnderThreshold.lifetime().totalSessions()).isEqualTo(2L);
        assertThat(ovUnderThreshold.lifetime().qualifiedSpeakingSeconds()).isEqualTo(25L); // 10 + max(12, 15)

        // Score trend is chronological (oldest session 10 -> newest session 11)
        assertThat(ovUnderThreshold.scoreTrend()).hasSize(2);
        assertThat(ovUnderThreshold.scoreTrend().get(0).sessionId()).isEqualTo(10L);
        assertThat(ovUnderThreshold.scoreTrend().get(1).sessionId()).isEqualTo(11L);
        assertThat(ovUnderThreshold.dataSufficiency().trendStatus()).isEqualTo("READY");

        // Add 3rd scored attempt -> crosses sample-size threshold 3 -> emits acoustic strengths!
        SpeakingShadowingAttempt a3 = SpeakingShadowingAttempt.builder().id(3L).user(userA).session(sOld).accuracyScore(90.0).pronunciationScore(86.0).durationSeconds(6).createdAt(now.minusDays(3)).build();
        when(attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(101L), any())).thenReturn(List.of(a1, a2, a3));

        SpeakingProfileOverviewDto ovReady = service.getOverview(101L);
        assertThat(ovReady.dataSufficiency().strengthsStatus()).isEqualTo("READY");
        assertThat(ovReady.strengths()).extracting(SpeakingStrengthItemDto::id)
                .contains("content_match", "overall_pronunciation");
    }

    @Test
    @DisplayName("5. Paginated History: Supports mode & status filters, returns exact facet counts, rejects bad filters & cross-user detail")
    void historyPaginationFilterCountsAndCrossUserRejection() {
        LocalDateTime now = LocalDateTime.now();
        SpeakingSession rpCompleted = SpeakingSession.builder()
                .id(301L).user(userA).mode("ROLEPLAY").status("COMPLETED")
                .scenario(SpeakingScenario.builder().id(9L).title("Airport Check-in").cefrLevel(CefrLevel.B1).build())
                .createdAt(now).build();

        when(queryRepository.getSessionStatusAndModeCounts(101L)).thenReturn(List.of(
                new SessionStatusModeRow("COMPLETED", "SHADOWING", 3L),
                new SessionStatusModeRow("ACTIVE", "SHADOWING", 1L),
                new SessionStatusModeRow("COMPLETED", "ROLEPLAY", 2L),
                new SessionStatusModeRow("COMPLETED", "QUICK_CHECK", 1L)
        ));
        when(queryRepository.findPaginatedSessions(101L, "ROLEPLAY", "COMPLETED", 0, 10))
                .thenReturn(List.of(rpCompleted));
        when(queryRepository.aggregateShadowingStatsBySessionIds(List.of(301L))).thenReturn(Map.of());
        when(queryRepository.aggregateRoleplayStatsBySessionIds(List.of(301L)))
                .thenReturn(Map.of(301L, new RoleplaySessionBatchStats(301L, 5, 84.2, 42)));
        when(queryRepository.findQuickCheckSummariesBySessionIds(List.of())).thenReturn(Map.of());
        when(queryRepository.findVisibleMaterialsByIds(101L, Set.of())).thenReturn(Map.of());

        SpeakingSessionHistoryPageDto page = service.getHistory(101L, "roleplay", "completed", 0, 10);

        assertThat(page.getTotalElements()).isEqualTo(2L);
        assertThat(page.getTotalPages()).isEqualTo(1);
        assertThat(page.isHasNext()).isFalse();
        assertThat(page.getModeFilter()).isEqualTo("ROLEPLAY");
        assertThat(page.getStatusFilter()).isEqualTo("COMPLETED");
        assertThat(page.getCounts().all()).isEqualTo(7L);
        assertThat(page.getCounts().completed()).isEqualTo(6L);
        assertThat(page.getCounts().active()).isEqualTo(1L);
        assertThat(page.getCounts().shadowing()).isEqualTo(4L);
        assertThat(page.getCounts().roleplay()).isEqualTo(2L);
        assertThat(page.getCounts().quickCheck()).isEqualTo(1L);
        assertThat(page.getContent()).hasSize(1);
        assertThat(page.getContent().getFirst().getMaterialTitle()).isEqualTo("Airport Check-in");
        assertThat(page.getContent().getFirst().getAveragePronunciationScore()).isEqualTo(84.2);
        assertThat(page.getContent().getFirst().getDurationSeconds()).isEqualTo(42);
        assertThat(page.getContent().getFirst().getCefrLevel()).isEqualTo("B1");

        // Invalid filter rejected with 400
        assertThatThrownBy(() -> service.getHistory(101L, "INVALID_MODE", "ALL", 0, 10))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));

        // Cross-user session detail throws 403 via owner-checked legacyAggregationService
        when(legacyAggregationService.getSpeakingSessionDetail(101L, 999L))
                .thenThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "Access denied"));
        assertThatThrownBy(() -> service.getSessionDetail(101L, 999L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }
}
