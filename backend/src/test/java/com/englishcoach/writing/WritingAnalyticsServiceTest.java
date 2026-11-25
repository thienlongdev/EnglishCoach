package com.englishcoach.writing;

import com.englishcoach.writing.client.WritingAiClient;
import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.dto.*;
import com.englishcoach.writing.entity.*;
import com.englishcoach.writing.enums.EvidenceType;
import com.englishcoach.writing.enums.SubmissionKind;
import com.englishcoach.writing.enums.WritingSessionStage;
import com.englishcoach.writing.exception.WritingDisabledException;
import com.englishcoach.writing.repository.*;
import com.englishcoach.writing.service.WritingAnalyticsServiceImpl;
import com.englishcoach.writing.service.WritingCatalogService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class WritingAnalyticsServiceTest {

    @Mock
    private WritingProperties writingProperties;

    @Mock
    private WritingAiClient aiClient;

    @Mock
    private WritingCatalogService catalogService;

    @Mock
    private WritingSessionRepository sessionRepository;

    @Mock
    private WritingSubmissionRepository submissionRepository;

    @Mock
    private WritingAssessmentRepository assessmentRepository;

    @Mock
    private WritingPracticeRepository practiceRepository;

    @Mock
    private WritingErrorMemoryRepository errorMemoryRepository;

    @Mock
    private WritingLearningEvidenceRepository evidenceRepository;

    @Mock
    private WritingFeedbackIssueRepository issueRepository;

    @Mock
    private com.englishcoach.writing.service.WritingReferenceAnswerCacheService referenceAnswerCacheService;

    @Spy
    private ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks
    private WritingAnalyticsServiceImpl analyticsService;

    private final Long userId = 42L;

    @BeforeEach
    void setUp() {
        lenient().when(writingProperties.isEnabled()).thenReturn(true);
        // The service reads bounded / batched queries (performance release 2026-11-16, PERF-03). Each one is answered here
        // from the same per-item fixtures the tests stub, with exactly the filters the old Java loops applied, so every
        // assertion below still checks the report against unchanged inputs.
        lenient().when(sessionRepository.findByUserIdAndStageAndCompletedAtAfter(anyLong(), any(), any())).thenAnswer(inv -> {
            WritingSessionStage stage = inv.getArgument(1);
            Instant after = inv.getArgument(2);
            return sessionRepository.findByUserIdOrderByUpdatedAtDesc(inv.getArgument(0)).stream()
                    .filter(s -> s.getStage() == stage)
                    .filter(s -> s.getCompletedAt() != null && s.getCompletedAt().isAfter(after)).toList();
        });
        lenient().when(submissionRepository.findByUserIdAndKindAndCreatedAtAfterOrderByCreatedAtDesc(anyLong(), any(), any())).thenAnswer(inv -> {
            Instant after = inv.getArgument(2);
            return submissionRepository.findByUserIdAndKindOrderByCreatedAtDesc(inv.getArgument(0), inv.getArgument(1)).stream()
                    .filter(s -> s.getCreatedAt().isAfter(after)).toList();
        });
        lenient().when(submissionRepository.findSessionIdsWithSubmissionsAfter(anyLong(), any())).thenAnswer(inv -> {
            Instant after = inv.getArgument(1);
            List<String> ids = new ArrayList<>();
            for (WritingSessionEntity s : sessionRepository.findByUserIdOrderByUpdatedAtDesc(inv.getArgument(0))) {
                if (submissionRepository.findBySessionIdOrderByOrdinalAsc(s.getId()).stream()
                        .anyMatch(d -> d.getCreatedAt() != null && d.getCreatedAt().isAfter(after))) ids.add(s.getId());
            }
            return ids;
        });
        lenient().when(submissionRepository.findBySessionIdInOrderBySessionIdAscOrdinalAsc(anyCollection())).thenAnswer(inv -> {
            List<WritingSubmissionEntity> out = new ArrayList<>();
            for (Object id : new TreeSet<>(inv.<Collection<String>>getArgument(0))) {
                out.addAll(submissionRepository.findBySessionIdOrderByOrdinalAsc((String) id));
            }
            return out;
        });
        lenient().when(assessmentRepository.findBySubmissionIdIn(anyCollection())).thenAnswer(inv -> {
            List<WritingAssessmentEntity> out = new ArrayList<>();
            for (String id : inv.<Collection<String>>getArgument(0)) assessmentRepository.findBySubmissionId(id).ifPresent(out::add);
            return out;
        });
        lenient().when(assessmentRepository.findAllById(anyIterable())).thenAnswer(inv -> {
            List<WritingAssessmentEntity> out = new ArrayList<>();
            for (String id : inv.<Iterable<String>>getArgument(0)) assessmentRepository.findById(id).ifPresent(out::add);
            return out;
        });
        lenient().when(issueRepository.findByAssessmentIdInOrderByPriorityRankAsc(anyCollection())).thenAnswer(inv -> {
            List<WritingFeedbackIssueEntity> out = new ArrayList<>();
            for (String id : inv.<Collection<String>>getArgument(0)) {
                List<WritingFeedbackIssueEntity> ranked = issueRepository.findByAssessmentIdOrderByPriorityRankAsc(id);
                out.addAll(ranked.isEmpty() ? issueRepository.findByAssessmentId(id) : ranked);
            }
            return out;
        });
        lenient().when(practiceRepository.countByUserIdAndIsCompletedTrueAndUpdatedAtAfter(anyLong(), any())).thenAnswer(inv -> {
            Instant after = inv.getArgument(1);
            return practiceRepository.findByUserIdOrderByCreatedAtDesc(inv.getArgument(0)).stream()
                    .filter(WritingPracticeEntity::getIsCompleted)
                    .filter(p -> p.getUpdatedAt() != null && p.getUpdatedAt().isAfter(after)).count();
        });
        lenient().when(practiceRepository.countByUserIdAndIsCompletedTrue(anyLong())).thenAnswer(inv ->
                practiceRepository.findByUserIdOrderByCreatedAtDesc(inv.getArgument(0)).stream().filter(WritingPracticeEntity::getIsCompleted).count());
        lenient().when(evidenceRepository.findByUserIdAndRecordedAtAfter(anyLong(), any())).thenAnswer(inv -> {
            Instant after = inv.getArgument(1);
            return evidenceRepository.findByUserIdOrderByRecordedAtDesc(inv.getArgument(0)).stream()
                    .filter(e -> e.getRecordedAt() != null && e.getRecordedAt().isAfter(after)).toList();
        });
    }

    @Test
    void testWritingDisabled_throwsException() {
        when(writingProperties.isEnabled()).thenReturn(false);
        assertThrows(WritingDisabledException.class, () -> analyticsService.getWeeklyReport(userId));
        assertThrows(WritingDisabledException.class, () -> analyticsService.getLongitudinalProgress(userId));
        assertThrows(WritingDisabledException.class, () -> analyticsService.getSkillDimensionScores(userId));
    }

    @Test
    void testGetWeeklyReport_emptyActivity_returnsZeroMetricsWithoutFabrication() {
        when(sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId)).thenReturn(Collections.emptyList());
        when(submissionRepository.findByUserIdAndKindOrderByCreatedAtDesc(userId, SubmissionKind.COACH_DRAFT)).thenReturn(Collections.emptyList());
        when(practiceRepository.findByUserIdOrderByCreatedAtDesc(userId)).thenReturn(Collections.emptyList());
        when(evidenceRepository.findByUserIdOrderByRecordedAtDesc(userId)).thenReturn(Collections.emptyList());
        when(errorMemoryRepository.findByUserIdAndIsMutedFalseOrderByOccurrenceCountDesc(userId)).thenReturn(Collections.emptyList());

        WeeklyWritingReportDto report = analyticsService.getWeeklyReport(userId);

        assertNotNull(report);
        assertEquals(0, report.getTotalWordsWritten());
        assertEquals(0, report.getCompletedSessions());
        assertEquals(0, report.getDraftsComposed());
        assertEquals(0, report.getPracticesCompleted());
        assertTrue(report.getConstructiveSummary().contains("No writing activity recorded"));
        // Skill dimensions must have null scores when no data exists (no fabricated mastery!)
        for (SkillDimensionScoreDto dim : report.getSkillDimensionScores()) {
            assertNull(dim.getScore());
            assertEquals("INSUFFICIENT_DATA", dim.getTrend());
        }
    }

    @Test
    void testGetWeeklyReport_withActivity_computesVelocityAndTotals() {
        Instant now = Instant.now();
        Instant threeDaysAgo = now.minus(3, ChronoUnit.DAYS);

        // 1 completed session
        WritingSessionEntity session = WritingSessionEntity.builder()
                .id("sess-1")
                .userId(userId)
                .stage(WritingSessionStage.COMPLETED)
                .completedAt(threeDaysAgo)
                .workingText("This is a test draft with exactly ten different words.")
                .taskSnapshot("{\"title\":\"Essay 1\"}")
                .build();
        when(sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId)).thenReturn(List.of(session));

        // 1 submission
        WritingSubmissionEntity sub = WritingSubmissionEntity.builder()
                .id("sub-1")
                .userId(userId)
                .sessionId("sess-1")
                .kind(SubmissionKind.COACH_DRAFT)
                .content("This is a test draft with exactly ten different words.")
                .createdAt(threeDaysAgo)
                .build();
        when(submissionRepository.findByUserIdAndKindOrderByCreatedAtDesc(userId, SubmissionKind.COACH_DRAFT))
                .thenReturn(List.of(sub));

        // 1 practice completed
        WritingPracticeEntity practice = WritingPracticeEntity.builder()
                .id("prac-1")
                .userId(userId)
                .isCompleted(true)
                .updatedAt(threeDaysAgo)
                .build();
        when(practiceRepository.findByUserIdOrderByCreatedAtDesc(userId)).thenReturn(List.of(practice));

        // Learning evidences: 3 positive, 1 negative (75% velocity)
        List<WritingLearningEvidenceEntity> evidences = List.of(
                WritingLearningEvidenceEntity.builder().userId(userId).isPositive(true).recordedAt(threeDaysAgo).skillCode("GRAMMAR").build(),
                WritingLearningEvidenceEntity.builder().userId(userId).isPositive(true).recordedAt(threeDaysAgo).skillCode("GRAMMAR").build(),
                WritingLearningEvidenceEntity.builder().userId(userId).isPositive(true).recordedAt(threeDaysAgo).skillCode("GRAMMAR").build(),
                WritingLearningEvidenceEntity.builder().userId(userId).isPositive(false).recordedAt(threeDaysAgo).skillCode("GRAMMAR").build()
        );
        when(evidenceRepository.findByUserIdOrderByRecordedAtDesc(userId)).thenReturn(evidences);

        // Error memory: 1 pattern with 85% mastery
        WritingErrorMemoryEntity mem = WritingErrorMemoryEntity.builder()
                .userId(userId)
                .patternCode("SUBJECT_VERB_AGREEMENT")
                .title("Subject Verb Agreement")
                .category("Grammar")
                .occurrenceCount(3)
                .contextCount(2)
                .estimatedMastery(85)
                .build();
        when(errorMemoryRepository.findByUserIdAndIsMutedFalseOrderByOccurrenceCountDesc(userId)).thenReturn(List.of(mem));

        WeeklyWritingReportDto report = analyticsService.getWeeklyReport(userId);

        assertNotNull(report);
        assertEquals(1, report.getCompletedSessions());
        assertEquals(1, report.getDraftsComposed());
        assertEquals(1, report.getPracticesCompleted());
        assertEquals(10, report.getTotalWordsWritten());
        assertEquals(75.0, report.getErrorResolutionVelocity());
        assertEquals(1, report.getTopMasteredPatterns().size());
        assertEquals("RESOLVED", report.getTopMasteredPatterns().get(0).getStatus());
        assertTrue(report.getConstructiveSummary().contains("You produced 10 words"));
    }

    @Test
    void testGetLongitudinalProgress_computesTimelineAndRevisions() {
        Instant completedTime = Instant.now().minus(2, ChronoUnit.DAYS);

        WritingSessionEntity session = WritingSessionEntity.builder()
                .id("sess-10")
                .userId(userId)
                .stage(WritingSessionStage.COMPLETED)
                .completedAt(completedTime)
                .workingText("Draft content for longitudinal test.")
                .activeAssessmentId("assess-2")
                .taskSnapshot("{\"title\":\"Longitudinal Essay\"}")
                .build();

        when(sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId)).thenReturn(List.of(session));

        // Submissions: draft 1 and draft 2
        WritingSubmissionEntity d1 = WritingSubmissionEntity.builder().id("sub-d1").sessionId("sess-10").ordinal(1).build();
        WritingSubmissionEntity d2 = WritingSubmissionEntity.builder().id("sub-d2").sessionId("sess-10").ordinal(2).build();
        when(submissionRepository.findBySessionIdOrderByOrdinalAsc("sess-10")).thenReturn(List.of(d1, d2));

        // Assessments: draft 1 had 70, draft 2 (active) had 90
        WritingAssessmentEntity assess1 = WritingAssessmentEntity.builder().id("assess-1").submissionId("sub-d1").overallScore(70).build();
        WritingAssessmentEntity assess2 = WritingAssessmentEntity.builder().id("assess-2").submissionId("sub-d2").overallScore(90).build();
        when(assessmentRepository.findBySubmissionId("sub-d1")).thenReturn(Optional.of(assess1));
        when(assessmentRepository.findById("assess-2")).thenReturn(Optional.of(assess2));

        LongitudinalProgressDto progress = analyticsService.getLongitudinalProgress(userId);

        assertNotNull(progress);
        assertEquals(1, progress.getCompletedSessionsCount());
        assertEquals(5, progress.getTotalWordsCumulative());
        assertEquals(90.0, progress.getAverageScore());
        assertEquals(1, progress.getTimeline().size());

        WritingTimelinePointDto pt = progress.getTimeline().get(0);
        assertEquals("sess-10", pt.getSessionId());
        assertEquals(70, pt.getDraft1Score());
        assertEquals(90, pt.getFinalScore());
        assertEquals(20, pt.getRevisionGain()); // 90 - 70 = +20 gain!
    }

    @Test
    void testGetSkillDimensionScores_fourCanonicalDimensions() {
        when(sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId)).thenReturn(List.of());
        List<SkillDimensionScoreDto> scores = analyticsService.getSkillDimensionScores(userId);

        assertEquals(4, scores.size());
        for (SkillDimensionScoreDto s : scores) {
            assertNull(s.getScore());
            assertEquals("INSUFFICIENT_DATA", s.getTrend());
        }

        WritingSessionEntity session = WritingSessionEntity.builder()
                .id("sess-dim-1")
                .userId(userId)
                .activeAssessmentId("assess-dim-1")
                .createdAt(Instant.now())
                .build();
        when(sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId)).thenReturn(List.of(session));

        String verdictsJson = """
            [
                {"dimension":"TASK_FULFILLMENT","score":75,"status":"CORRECT","feedback":"Clear"},
                {"dimension":"COHERENCE_COHESION","score":80,"status":"CORRECT","feedback":"Fluid"},
                {"dimension":"LEXICAL_RESOURCE","score":70,"status":"CORRECT","feedback":"Varied"},
                {"dimension":"GRAMMATICAL_RANGE_ACCURACY","score":85,"status":"CORRECT","feedback":"Accurate"}
            ]
            """;
        WritingAssessmentEntity assess = WritingAssessmentEntity.builder()
                .id("assess-dim-1")
                .dimensionVerdicts(verdictsJson)
                .build();
        when(assessmentRepository.findById("assess-dim-1")).thenReturn(Optional.of(assess));

        List<SkillDimensionScoreDto> scored = analyticsService.getSkillDimensionScores(userId);
        assertEquals(4, scored.size());

        SkillDimensionScoreDto task = scored.stream().filter(s -> "TASK_FULFILLMENT".equals(s.getDimension())).findFirst().orElseThrow();
        assertEquals(75, task.getScore());
        assertEquals("STEADY", task.getTrend());

        SkillDimensionScoreDto grammar = scored.stream().filter(s -> "GRAMMATICAL_RANGE_ACCURACY".equals(s.getDimension())).findFirst().orElseThrow();
        assertEquals(85, grammar.getScore());
        assertEquals("STEADY", grammar.getTrend());
    }

    @Test
    void testGenerateAdaptiveTask_registersDynamicTask() {
        AdaptiveTaskAiResponse aiResp = AdaptiveTaskAiResponse.builder()
                .title("Workplace Email")
                .prompt("Write an update")
                .guidance("Clear points")
                .audience("Manager")
                .targetRegister("formal")
                .targetWordCountMin(100)
                .targetWordCountMax(180)
                .requirements(List.of("Point 1", "Point 2"))
                .elicitedPatterns(List.of("SUBJECT_VERB_AGREEMENT"))
                .build();

        when(aiClient.generateAdaptiveTask(anyString(), anyList(), anyString(), anyString())).thenReturn(aiResp);

        AdaptiveTaskRequestDto req = AdaptiveTaskRequestDto.builder()
                .cefrLevel("B2")
                .category("Work")
                .register("formal")
                .focusPatternCodes(List.of("SUBJECT_VERB_AGREEMENT"))
                .build();

        AdaptiveTaskAiResponse result = analyticsService.generateAdaptiveTask(userId, req);

        assertNotNull(result);
        assertEquals("Workplace Email", result.getTitle());
        verify(catalogService, times(1)).registerDynamicTask(eq(userId), argThat(task ->
                "Workplace Email".equals(task.get("title")) && "B2".equals(task.get("level"))
        ));
    }

    @Test
    void testSocraticGuidanceAndModelAnswerComparison() {
        SocraticPlanAiResponse socraticResp = SocraticPlanAiResponse.builder()
                .probingQuestions(List.of("What is your thesis?"))
                .structuralPrompts(List.of("Outline paragraph 1"))
                .encouragement("Great start!")
                .build();
        when(aiClient.getSocraticGuidance(anyString(), anyString(), anyString())).thenReturn(socraticResp);

        SocraticPlanAiResponse sResult = analyticsService.getSocraticGuidance(userId, SocraticPlanRequestDto.builder().taskPrompt("Test").build());
        assertEquals(1, sResult.getProbingQuestions().size());

        ModelAnswerComparisonAiResponse modelResp = ModelAnswerComparisonAiResponse.builder()
                .exemplarModelAnswer("Exemplar text")
                .structuralObservations(List.of("Obs 1"))
                .lexicalAlternatives(List.of("Alt 1"))
                .coachingSummary("Summary")
                .build();
        when(aiClient.compareModelAnswer(anyString(), anyString(), anyString(), anyString())).thenReturn(modelResp);

        ModelAnswerComparisonAiResponse mResult = analyticsService.compareModelAnswer(userId, ModelAnswerComparisonRequestDto.builder().taskPrompt("Test").learnerDraft("Draft").learnerLevel("B1").build());
        assertEquals("Exemplar text", mResult.getExemplarModelAnswer());
        verifyNoInteractions(referenceAnswerCacheService);
    }

    @Test
    void testWeeklyReport_Exact7DayBoundaryAndZeroAiCalls() {
        Instant now = Instant.now();
        Instant withinWindow = now.minus(5, ChronoUnit.DAYS);
        Instant outsideWindow = now.minus(8, ChronoUnit.DAYS);

        // 1. Session completed within window (counted)
        WritingSessionEntity validSession = WritingSessionEntity.builder()
                .id("sess-valid")
                .userId(userId)
                .stage(WritingSessionStage.COMPLETED)
                .completedAt(withinWindow)
                .workingText("Ten words written in this completed session for weekly report.")
                .taskSnapshot("{\"title\":\"Valid Essay\"}")
                .build();

        // 2. Session completed 8 days ago (excluded by 7-day filter)
        WritingSessionEntity oldSession = WritingSessionEntity.builder()
                .id("sess-old")
                .userId(userId)
                .stage(WritingSessionStage.COMPLETED)
                .completedAt(outsideWindow)
                .workingText("Old words written eight days ago.")
                .taskSnapshot("{\"title\":\"Old Essay\"}")
                .build();

        // 3. Incomplete session (excluded from completed count)
        WritingSessionEntity incompleteSession = WritingSessionEntity.builder()
                .id("sess-incomplete")
                .userId(userId)
                .stage(WritingSessionStage.DRAFTING)
                .completedAt(null)
                .workingText("Incomplete draft text.")
                .taskSnapshot("{\"title\":\"Incomplete Essay\"}")
                .build();

        when(sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId))
                .thenReturn(List.of(validSession, oldSession, incompleteSession));

        // Submissions: 2 drafts for validSession (within window), 1 draft for oldSession (outside window)
        WritingSubmissionEntity sub1 = WritingSubmissionEntity.builder()
                .id("sub-v1").userId(userId).sessionId("sess-valid").kind(SubmissionKind.COACH_DRAFT)
                .content("First draft with five words.").createdAt(withinWindow.minus(2, ChronoUnit.HOURS)).build();
        WritingSubmissionEntity sub2 = WritingSubmissionEntity.builder()
                .id("sub-v2").userId(userId).sessionId("sess-valid").kind(SubmissionKind.COACH_DRAFT)
                .content("Ten words written in this completed session for weekly report.").createdAt(withinWindow).build();
        WritingSubmissionEntity subOld = WritingSubmissionEntity.builder()
                .id("sub-old").userId(userId).sessionId("sess-old").kind(SubmissionKind.COACH_DRAFT)
                .content("Old draft words.").createdAt(outsideWindow).build();

        when(submissionRepository.findByUserIdAndKindOrderByCreatedAtDesc(userId, SubmissionKind.COACH_DRAFT))
                .thenReturn(List.of(sub2, sub1, subOld));

        // Practices: 1 completed within window, 1 completed outside window
        WritingPracticeEntity pracValid = WritingPracticeEntity.builder()
                .id("p-val").userId(userId).isCompleted(true).updatedAt(withinWindow).build();
        WritingPracticeEntity pracOld = WritingPracticeEntity.builder()
                .id("p-old").userId(userId).isCompleted(true).updatedAt(outsideWindow).build();
        when(practiceRepository.findByUserIdOrderByCreatedAtDesc(userId))
                .thenReturn(List.of(pracValid, pracOld));

        // Evidences: 2 within window (both positive = 100% velocity), 1 outside window
        WritingLearningEvidenceEntity ev1 = WritingLearningEvidenceEntity.builder()
                .userId(userId).isPositive(true).recordedAt(withinWindow).skillCode("GRAMMAR").build();
        WritingLearningEvidenceEntity ev2 = WritingLearningEvidenceEntity.builder()
                .userId(userId).isPositive(true).recordedAt(withinWindow).skillCode("GRAMMAR").build();
        WritingLearningEvidenceEntity evOld = WritingLearningEvidenceEntity.builder()
                .userId(userId).isPositive(false).recordedAt(outsideWindow).skillCode("GRAMMAR").build();
        when(evidenceRepository.findByUserIdOrderByRecordedAtDesc(userId))
                .thenReturn(List.of(ev1, ev2, evOld));

        WeeklyWritingReportDto report = analyticsService.getWeeklyReport(userId);

        assertNotNull(report);
        // Completed sessions strictly 1 (old & incomplete excluded)
        assertEquals(1, report.getCompletedSessions());
        // Drafts composed strictly 2 within window (old excluded)
        assertEquals(2, report.getDraftsComposed());
        // Practices completed strictly 1 within window (old excluded)
        assertEquals(1, report.getPracticesCompleted());
        // Total words: 5 + 10 = 15 words from the 2 drafts within window
        assertEquals(15, report.getTotalWordsWritten());
        // Error resolution velocity: 2 / 2 positive within window = 100.0%
        assertEquals(100.0, report.getErrorResolutionVelocity());

        // CRITICAL: Verify ZERO AI calls on report reads!
        verifyNoInteractions(aiClient);
    }

    @Test
    void testAdvancedPortfolio_RecomputedReferenceValues() {
        Instant t1 = Instant.now().minus(4, ChronoUnit.DAYS);
        Instant t2 = Instant.now().minus(1, ChronoUnit.DAYS);

        // Session A: 2 drafts (gain = 85 - 65 = +20), 10 words
        WritingSessionEntity sessA = WritingSessionEntity.builder()
                .id("sess-a")
                .userId(userId)
                .stage(WritingSessionStage.COMPLETED)
                .completedAt(t1)
                .workingText("One two three four five six seven eight nine ten.")
                .activeAssessmentId("assess-a2")
                .taskSnapshot("{\"title\":\"Essay A\"}")
                .build();

        // Session B: 1 draft (no revision, gain = null), 6 words
        WritingSessionEntity sessB = WritingSessionEntity.builder()
                .id("sess-b")
                .userId(userId)
                .stage(WritingSessionStage.COMPLETED)
                .completedAt(t2)
                .workingText("One two three four five six.")
                .activeAssessmentId("assess-b1")
                .taskSnapshot("{\"title\":\"Essay B\"}")
                .build();

        when(sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId))
                .thenReturn(List.of(sessB, sessA));

        // Submissions for Session A
        WritingSubmissionEntity subA1 = WritingSubmissionEntity.builder().id("sub-a1").sessionId("sess-a").ordinal(1).build();
        WritingSubmissionEntity subA2 = WritingSubmissionEntity.builder().id("sub-a2").sessionId("sess-a").ordinal(2).build();
        when(submissionRepository.findBySessionIdOrderByOrdinalAsc("sess-a")).thenReturn(List.of(subA1, subA2));

        // Submissions for Session B
        WritingSubmissionEntity subB1 = WritingSubmissionEntity.builder().id("sub-b1").sessionId("sess-b").ordinal(1).build();
        when(submissionRepository.findBySessionIdOrderByOrdinalAsc("sess-b")).thenReturn(List.of(subB1));

        // Assessments
        WritingAssessmentEntity assessA1 = WritingAssessmentEntity.builder().id("assess-a1").submissionId("sub-a1").overallScore(65).build();
        WritingAssessmentEntity assessA2 = WritingAssessmentEntity.builder().id("assess-a2").submissionId("sub-a2").overallScore(85).build();
        WritingAssessmentEntity assessB1 = WritingAssessmentEntity.builder().id("assess-b1").submissionId("sub-b1").overallScore(75).build();

        when(assessmentRepository.findBySubmissionId("sub-a1")).thenReturn(Optional.of(assessA1));
        when(assessmentRepository.findById("assess-a2")).thenReturn(Optional.of(assessA2));
        when(assessmentRepository.findBySubmissionId("sub-b1")).thenReturn(Optional.of(assessB1));
        when(assessmentRepository.findById("assess-b1")).thenReturn(Optional.of(assessB1));

        LongitudinalProgressDto progress = analyticsService.getLongitudinalProgress(userId);

        assertNotNull(progress);
        assertEquals(2, progress.getCompletedSessionsCount());
        // Words: 10 + 6 = 16 words
        assertEquals(16, progress.getTotalWordsCumulative());
        // Average score: (85 + 75) / 2.0 = 80.0
        assertEquals(80.0, progress.getAverageScore());

        // Timeline check (chronological order)
        assertEquals(2, progress.getTimeline().size());
        WritingTimelinePointDto ptA = progress.getTimeline().get(0);
        assertEquals("sess-a", ptA.getSessionId());
        assertEquals(65, ptA.getDraft1Score());
        assertEquals(85, ptA.getFinalScore());
        assertEquals(20, ptA.getRevisionGain()); // 85 - 65 = 20

        WritingTimelinePointDto ptB = progress.getTimeline().get(1);
        assertEquals("sess-b", ptB.getSessionId());
        assertEquals(75, ptB.getDraft1Score());
        assertEquals(75, ptB.getFinalScore());
        assertEquals(0, ptB.getRevisionGain()); // single draft: final (75) - d1 (75) = 0 gain

        // CRITICAL: Zero AI calls on portfolio read!
        verifyNoInteractions(aiClient);
    }
}
