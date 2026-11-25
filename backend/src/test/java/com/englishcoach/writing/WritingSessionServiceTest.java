package com.englishcoach.writing;

import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.dto.*;
import com.englishcoach.writing.entity.WritingSessionEntity;
import com.englishcoach.writing.enums.SubmissionKind;
import com.englishcoach.writing.enums.WritingSessionStage;
import com.englishcoach.writing.exception.WritingConflictException;
import com.englishcoach.writing.exception.WritingNotFoundException;
import com.englishcoach.writing.repository.WritingProfileRepository;
import com.englishcoach.writing.repository.WritingSessionRepository;
import com.englishcoach.writing.service.DeterministicGrammarValidator;
import com.englishcoach.writing.service.WritingCatalogService;
import com.englishcoach.writing.service.WritingSessionServiceImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
public class WritingSessionServiceTest {

    @Mock
    private WritingProperties writingProperties;

    @Mock
    private WritingProfileRepository profileRepository;

    @Mock
    private WritingSessionRepository sessionRepository;

    @Mock
    private WritingCatalogService catalogService;

    @Mock
    private com.englishcoach.writing.repository.WritingSubmissionRepository submissionRepository;

    @Mock
    private com.englishcoach.writing.repository.WritingAssessmentRepository assessmentRepository;

    @Mock
    private com.englishcoach.writing.repository.WritingFeedbackIssueRepository issueRepository;

    @Mock
    private com.englishcoach.writing.client.WritingAiClient writingAiClient;

    @Mock
    private com.englishcoach.writing.service.WritingErrorMemoryService errorMemoryService;

    @Mock
    private com.englishcoach.writing.repository.WritingLearningEvidenceRepository evidenceRepository;

    @Mock
    private com.englishcoach.writing.repository.WritingErrorMemoryRepository errorMemoryRepository;

    @Mock
    private com.englishcoach.writing.repository.WritingPracticeRepository practiceRepository;

    @org.mockito.Spy
    private DeterministicGrammarValidator grammarValidator = new DeterministicGrammarValidator();

    @Mock
    private org.springframework.transaction.PlatformTransactionManager gradingTransactionManager;
    @Mock
    private com.englishcoach.writing.service.WritingGradingBudget gradingBudget;

    @InjectMocks
    private WritingSessionServiceImpl writingSessionService;

    @BeforeEach
    void setUp() {
        var assessments = new java.util.HashMap<String, com.englishcoach.writing.entity.WritingAssessmentEntity>();
        lenient().when(assessmentRepository.save(any())).thenAnswer(inv -> {
            var a = (com.englishcoach.writing.entity.WritingAssessmentEntity) inv.getArgument(0);
            assessments.put(a.getId(), a);
            return a;
        });
        lenient().when(assessmentRepository.findById(anyString())).thenAnswer(inv -> Optional.ofNullable(assessments.get(inv.getArgument(0))));
        lenient().when(gradingBudget.reserve(anyLong())).thenReturn(new com.englishcoach.writing.service.WritingGradingBudget.Charge(1L, null));
        lenient().when(writingProperties.isEnabled()).thenReturn(true);
        lenient().when(writingProperties.isMutationsEnabled()).thenReturn(true);
        lenient().when(writingProperties.getMaxDraftChars()).thenReturn(25000);
    }

    @Test
    void testCreateSessionWithCatalogTask() {
        when(catalogService.getTaskById(10L, "task-everyday-01")).thenReturn(Optional.of(Map.of(
                "id", "task-everyday-01",
                "title", "Email to a Friend",
                "targetWordCountMin", 120
        )));

        when(sessionRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));

        CreateSessionRequest req = CreateSessionRequest.builder()
                .taskId("task-everyday-01")
                .clientMutationId("mut-1")
                .build();

        WritingSessionDto session = writingSessionService.createSession(10L, req);

        assertNotNull(session);
        assertEquals(10L, session.getUserId());
        assertEquals("task-everyday-01", session.getTaskId());
        assertEquals(WritingSessionStage.UNDERSTANDING, session.getStage());
        assertEquals(1L, session.getCurrentRevision());
        assertNotNull(session.getTaskSnapshot());
        assertEquals("Email to a Friend", session.getTaskSnapshot().get("title"));
    }

    @Test
    void testGetSessionOwnerIsolation() {
        WritingSessionEntity entity = WritingSessionEntity.builder()
                .id("sess-1")
                .userId(10L)
                .taskId("task-everyday-01")
                .taskSnapshot("{\"id\":\"task-everyday-01\"}")
                .stage(WritingSessionStage.DRAFTING)
                .currentRevision(2L)
                .build();

        when(sessionRepository.findByIdAndUserId("sess-1", 10L)).thenReturn(Optional.of(entity));
        when(sessionRepository.findByIdAndUserId("sess-1", 999L)).thenReturn(Optional.empty());

        WritingSessionDto owned = writingSessionService.getSession(10L, "sess-1");
        assertEquals("sess-1", owned.getId());

        assertThrows(WritingNotFoundException.class, () -> {
            writingSessionService.getSession(999L, "sess-1");
        });
    }

    @Test
    void testUpdateWorkingCopyOptimisticConcurrency() {
        WritingSessionEntity entity = WritingSessionEntity.builder()
                .id("sess-1")
                .userId(10L)
                .taskId("task-everyday-01")
                .taskSnapshot("{}")
                .stage(WritingSessionStage.DRAFTING)
                .workingText("Initial text")
                .currentRevision(3L)
                .build();

        when(sessionRepository.findOwnedForCompletion("sess-1", 10L)).thenReturn(Optional.of(entity));
        when(sessionRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));

        // 1. Matching revision succeeds and increments revision
        UpdateWorkingCopyRequest validReq = UpdateWorkingCopyRequest.builder()
                .workingText("Revised text")
                .expectedRevision(3L)
                .build();

        WritingSessionDto updated = writingSessionService.updateWorkingCopy(10L, "sess-1", validReq);
        assertEquals("Revised text", updated.getWorkingText());
        assertEquals(4L, updated.getCurrentRevision());

        // 2. Stale revision triggers 409 WritingConflictException
        UpdateWorkingCopyRequest staleReq = UpdateWorkingCopyRequest.builder()
                .workingText("Stale text")
                .expectedRevision(2L) // stale!
                .build();

        assertThrows(WritingConflictException.class, () -> {
            writingSessionService.updateWorkingCopy(10L, "sess-1", staleReq);
        });
    }

    @Test
    void testAdvanceStageSuccessAndConflict() {
        WritingSessionEntity entity = WritingSessionEntity.builder()
                .id("sess-1")
                .userId(10L)
                .taskId("task-everyday-01")
                .taskSnapshot("{}")
                .stage(WritingSessionStage.UNDERSTANDING)
                .currentRevision(1L)
                .build();

        when(sessionRepository.findOwnedForCompletion("sess-1", 10L)).thenReturn(Optional.of(entity));
        when(sessionRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));

        AdvanceStageRequest req = AdvanceStageRequest.builder()
                .targetStage(WritingSessionStage.PLANNING)
                .expectedRevision(1L)
                .build();

        WritingSessionDto res = writingSessionService.advanceStage(10L, "sess-1", req);
        assertEquals(WritingSessionStage.PLANNING, res.getStage());
        assertEquals(2L, res.getCurrentRevision());
    }

    @Test
    void testOrganizePlan() {
        WritingSessionEntity entity = WritingSessionEntity.builder()
                .id("sess-1")
                .userId(10L)
                .taskId("task-1")
                .taskSnapshot("{\"prompt\":\"Write an email inviting a friend.\"}")
                .workingPlan("Say hello\nAsk about their weekend\nInvite them to dinner")
                .stage(WritingSessionStage.PLANNING)
                .currentRevision(1L)
                .build();

        when(sessionRepository.findByIdAndUserId("sess-1", 10L)).thenReturn(Optional.of(entity));

        PlanOrganizationResultDto mockResult = PlanOrganizationResultDto.builder()
                .organizedSections(java.util.List.of(
                        PlanSectionDto.builder().sectionTitle("Greeting").points(java.util.List.of("Say hello")).build(),
                        PlanSectionDto.builder().sectionTitle("Body").points(java.util.List.of("Ask about weekend", "Invite to dinner")).build()
                ))
                .suggestions(java.util.List.of("Clear 2-part structure."))
                .build();

        when(writingAiClient.organizePlan(anyString(), anyList())).thenReturn(mockResult);

        PlanOrganizationResultDto result = writingSessionService.organizePlan(10L, "sess-1");
        assertNotNull(result);
        assertEquals(2, result.getOrganizedSections().size());
        assertEquals("Greeting", result.getOrganizedSections().get(0).getSectionTitle());
    }

    @Test
    void testSubmitDraftSuccess() {
        WritingSessionEntity entity = WritingSessionEntity.builder()
                .id("sess-1")
                .userId(10L)
                .taskId("task-1")
                .taskSnapshot("{\"prompt\":\"Write an email.\"}")
                .workingText("Dear friend, I hope you are well. Would you like to have dinner together tomorrow?")
                .currentRevision(2L)
                .stage(WritingSessionStage.DRAFTING)
                .build();

        when(sessionRepository.findOwnedForCompletion("sess-1", 10L)).thenReturn(Optional.of(entity));
        when(submissionRepository.findBySessionIdOrderByOrdinalAsc("sess-1")).thenReturn(java.util.Collections.emptyList());
        when(submissionRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(sessionRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));

        DocumentAnalysisAiResponse mockAi = DocumentAnalysisAiResponse.builder()
                .overallScore(82)
                .strengths(java.util.List.of("Polite tone", "Clear invitation"))
                .prioritizedIssueIndices(java.util.List.of(0))
                .summary("Good first draft with minor improvements possible.")
                .issues(java.util.List.of(
                        FeedbackIssueDto.builder()
                                .kind(com.englishcoach.writing.enums.IssueKind.IMPROVEMENT)
                                .category("Cohesion")
                                .title("Add friendly closing")
                                .sourceQuote("Dear friend")
                                .startOffset(0).endOffset(11)
                                .explanation("Add a warm sign-off.")
                                .priorityRank(1)
                                .build()
                ))
                .build();

        when(writingAiClient.analyzeDocument(any(), any(), any(), any(), any(), anyInt())).thenReturn(mockAi);
        var persistedIssues = new java.util.ArrayList<com.englishcoach.writing.entity.WritingFeedbackIssueEntity>();
        when(issueRepository.save(any())).thenAnswer(inv -> { var issue = (com.englishcoach.writing.entity.WritingFeedbackIssueEntity) inv.getArgument(0); persistedIssues.add(issue); return issue; });
        when(issueRepository.findByAssessmentIdOrderByPriorityRankAsc(anyString())).thenAnswer(inv -> persistedIssues);

        DocumentAssessmentResultDto result = writingSessionService.submitDraft(10L, "sess-1", 2L, "mut-1");

        assertNotNull(result);
        assertEquals(82, result.getOverallScore());
        assertEquals(1, result.getPrioritizedIssues().size());
        assertEquals("Add friendly closing", result.getPrioritizedIssues().get(0).getTitle());
        assertEquals(WritingSessionStage.FEEDBACK_READY, entity.getStage());
    }

    @Test
    void testSubmitDraftWithTargetWords_recordsWritingOwnedProductiveUseEvidence() {
        WritingSessionEntity entity = WritingSessionEntity.builder()
                .id("sess-vocab-prod")
                .userId(10L)
                .taskId("src-vocabulary-101")
                .taskSnapshot("{\"prompt\":\"Use target words.\",\"targetWords\":[\"articulate\",\"perspective\"]}")
                .workingText("The candidate was able to articulate a nuanced perspective on the economic policy.")
                .currentRevision(1L)
                .stage(WritingSessionStage.DRAFTING)
                .build();

        when(sessionRepository.findOwnedForCompletion("sess-vocab-prod", 10L)).thenReturn(Optional.of(entity));
        when(submissionRepository.findBySessionIdOrderByOrdinalAsc("sess-vocab-prod")).thenReturn(java.util.Collections.emptyList());
        when(submissionRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(sessionRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));

        DocumentAnalysisAiResponse mockAi = DocumentAnalysisAiResponse.builder()
                .overallScore(90)
                .strengths(java.util.List.of("Excellent lexical choice"))
                .prioritizedIssueIndices(java.util.List.of())
                .summary("Great usage of target vocabulary.")
                .issues(java.util.List.of())
                .build();

        when(writingAiClient.analyzeDocument(any(), any(), any(), any(), any(), anyInt())).thenReturn(mockAi);

        DocumentAssessmentResultDto result = writingSessionService.submitDraft(10L, "sess-vocab-prod", 1L, "mut-vocab");
        assertNotNull(result);

        // Verify Writing-owned productive-use evidence saved for both target words used in production
        verify(evidenceRepository, times(2)).save(argThat(ev ->
                ev.getUserId().equals(10L) &&
                "VOCABULARY".equals(ev.getSkillCode()) &&
                ev.getIsPositive() &&
                ev.getEvidenceType() == com.englishcoach.writing.enums.EvidenceType.INDEPENDENT_DRAFT &&
                "sess-vocab-prod".equals(ev.getContextId())
        ));
    }

    @Test
    void testCompareDrafts() {
        WritingSessionEntity session = WritingSessionEntity.builder()
                .id("sess-1")
                .userId(10L)
                .build();

        com.englishcoach.writing.entity.WritingSubmissionEntity d1 = com.englishcoach.writing.entity.WritingSubmissionEntity.builder()
                .id("draft-1")
                .sessionId("sess-1")
                .ordinal(1)
                .content("I has an apple.")
                .wordCount(4)
                .build();

        com.englishcoach.writing.entity.WritingSubmissionEntity d2 = com.englishcoach.writing.entity.WritingSubmissionEntity.builder()
                .id("draft-2")
                .sessionId("sess-1")
                .ordinal(2)
                .content("I have an apple.")
                .wordCount(4)
                .build();

        com.englishcoach.writing.entity.WritingAssessmentEntity assess1 = com.englishcoach.writing.entity.WritingAssessmentEntity.builder()
                .id("assess-1")
                .submissionId("draft-1")
                .build();

        com.englishcoach.writing.entity.WritingFeedbackIssueEntity issue1 = com.englishcoach.writing.entity.WritingFeedbackIssueEntity.builder()
                .id("issue-1")
                .assessmentId("assess-1")
                .sourceQuote("has")
                .priorityRank(1)
                .build();

        when(sessionRepository.findByIdAndUserId("sess-1", 10L)).thenReturn(Optional.of(session));
        when(submissionRepository.findBySessionIdOrderByOrdinalAsc("sess-1")).thenReturn(java.util.List.of(d1, d2));
        when(assessmentRepository.findBySubmissionId("draft-1")).thenReturn(Optional.of(assess1));
        when(issueRepository.findByAssessmentIdOrderByPriorityRankAsc("assess-1")).thenReturn(java.util.List.of(issue1));

        DraftComparisonResultDto comparison = writingSessionService.compareDrafts(10L, "sess-1", "draft-1", "draft-2");

        assertNotNull(comparison);
        assertEquals("draft-1", comparison.getDraft1Id());
        assertEquals("draft-2", comparison.getDraft2Id());
        assertEquals(1, comparison.getResolvedIssueCount());
        assertFalse(comparison.getDiffChunks().isEmpty());
    }

    @Test
    void testCompleteSession() {
        WritingSessionEntity session = WritingSessionEntity.builder()
                .id("sess-1")
                .userId(10L)
                .stage(WritingSessionStage.FEEDBACK_READY)
                .currentRevision(3L)
                .workingText("An unchanged evaluated essay.")
                .activeAssessmentId("assessment-2")
                .build();

        when(sessionRepository.findOwnedForCompletion("sess-1", 10L)).thenReturn(Optional.of(session));
        var draft = com.englishcoach.writing.entity.WritingSubmissionEntity.builder()
                .id("draft-2").sessionId("sess-1").userId(10L)
                .content("An unchanged evaluated essay.").build();
        when(submissionRepository.findBySessionIdOrderByOrdinalAsc("sess-1")).thenReturn(java.util.List.of(draft));
        when(assessmentRepository.findBySubmissionId("draft-2")).thenReturn(Optional.of(
                com.englishcoach.writing.entity.WritingAssessmentEntity.builder()
                        .id("assessment-2").submissionId("draft-2")
                        .status(com.englishcoach.writing.enums.AssessmentStatus.READY).overallScore(80).build()));
        when(sessionRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));

        CompleteSessionRequest req = CompleteSessionRequest.builder()
                .finalDraftId("draft-2")
                .expectedRevision(3L)
                .build();

        WritingSessionDto res = writingSessionService.completeSession(10L, "sess-1", req);
        assertEquals(WritingSessionStage.COMPLETED, res.getStage());
        assertEquals("draft-2", res.getFinalDraftId());
        assertNotNull(res.getCompletedAt());
        assertEquals(4L, res.getCurrentRevision());
        verifyNoInteractions(writingAiClient);
    }

    @Test
    void testCompleteSessionIdempotent() {
        WritingSessionEntity session = WritingSessionEntity.builder()
                .id("sess-1")
                .userId(10L)
                .stage(WritingSessionStage.COMPLETED)
                .finalDraftId("draft-2")
                .completedAt(java.time.Instant.now())
                .currentRevision(4L)
                .build();

        when(sessionRepository.findOwnedForCompletion("sess-1", 10L)).thenReturn(Optional.of(session));

        CompleteSessionRequest req = CompleteSessionRequest.builder()
                .finalDraftId("draft-2")
                .expectedRevision(3L)
                .build();

        WritingSessionDto res = writingSessionService.completeSession(10L, "sess-1", req);
        assertEquals(WritingSessionStage.COMPLETED, res.getStage());
        assertEquals("draft-2", res.getFinalDraftId());
        verify(sessionRepository, never()).save(any());
        verifyNoInteractions(writingAiClient);
    }

    @Test
    void aRevisionDuringInferenceReleasesTheReservation() {
        var original = WritingSessionEntity.builder().id("s").userId(10L).currentRevision(3L)
                .stage(WritingSessionStage.DRAFTING).workingText("This is my original draft.").build();
        var edited = WritingSessionEntity.builder().id("s").userId(10L).currentRevision(4L)
                .stage(WritingSessionStage.DRAFTING).workingText("This is the updated draft.").build();
        when(sessionRepository.findOwnedForCompletion("s", 10L))
                .thenReturn(Optional.of(original), Optional.of(edited));
        when(submissionRepository.save(any())).thenAnswer(i -> i.getArgument(0));
        when(writingAiClient.analyzeDocument(any(), any(), any(), any(), any(), anyInt()))
                .thenReturn(DocumentAnalysisAiResponse.builder().overallScore(80).build());
        assertThrows(WritingConflictException.class, () -> writingSessionService.submitDraft(10L, "s", 3L, "mutation"));
        verify(gradingBudget).settle(new com.englishcoach.writing.service.WritingGradingBudget.Charge(1L, null), false);
        verify(sessionRepository, never()).save(any());
        assertNull(edited.getActiveAssessmentId());
    }

    @Test
    void failedFinalEvaluationCannotComplete() {
        WritingSessionEntity session = WritingSessionEntity.builder()
                .id("sess-1").userId(10L).stage(WritingSessionStage.REVISING)
                .workingText("This draft must remain available after a provider failure.")
                .currentRevision(3L).build();
        when(sessionRepository.findOwnedForCompletion("sess-1", 10L)).thenReturn(Optional.of(session));
        when(submissionRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
        when(writingAiClient.analyzeDocument(any(), any(), any(), any(), any(), anyInt()))
                .thenThrow(new RuntimeException("Provider unavailable"));
        assertThrows(com.englishcoach.writing.exception.WritingAiServiceException.class,
                () -> writingSessionService.completeSession(10L, "sess-1", null));
        assertNotEquals(WritingSessionStage.COMPLETED, session.getStage());
        assertNull(session.getCompletedAt());
    }

    @Test
    void testSetFavorite() {
        WritingSessionEntity session = WritingSessionEntity.builder()
                .id("sess-1")
                .userId(10L)
                .isFavorite(false)
                .build();

        when(sessionRepository.findByIdAndUserId("sess-1", 10L)).thenReturn(Optional.of(session));
        when(sessionRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));

        WritingSessionDto res = writingSessionService.setFavorite(10L, "sess-1", true);
        assertTrue(res.getIsFavorite());
    }

    @Test
    void testGetPortfolio() {
        WritingSessionEntity session = WritingSessionEntity.builder()
                .id("sess-1")
                .userId(10L)
                .taskId("task-1")
                .taskSnapshot("{\"title\":\"My Essay\",\"category\":\"Academic\"}")
                .stage(WritingSessionStage.COMPLETED)
                .workingText("This is an essay.")
                .isFavorite(true)
                .build();

        when(sessionRepository.findByUserIdOrderByUpdatedAtDesc(10L)).thenReturn(java.util.List.of(session));
        when(submissionRepository.findBySessionIdInOrderBySessionIdAscOrdinalAsc(java.util.List.of("sess-1")))
                .thenReturn(java.util.Collections.emptyList());

        java.util.List<PortfolioSummaryItemDto> items = writingSessionService.getPortfolio(10L, "all", false);
        assertEquals(1, items.size());
        assertEquals("My Essay", items.get(0).getTaskTitle());
        assertEquals(4, items.get(0).getWordCount());
        verify(submissionRepository, never()).findBySessionIdOrderByOrdinalAsc(anyString());
    }

    @Test
    void testGetForYou() {
        WritingSessionEntity session = WritingSessionEntity.builder()
                .id("sess-1")
                .userId(10L)
                .stage(WritingSessionStage.DRAFTING)
                .taskSnapshot("{\"title\":\"Draft in progress\"}")
                .build();

        when(sessionRepository.findByUserIdOrderByUpdatedAtDesc(10L)).thenReturn(java.util.List.of(session));
        when(errorMemoryRepository.findByUserIdAndDueForPracticeTrueOrderByNextPracticeDueAtAsc(10L))
                .thenReturn(java.util.Collections.emptyList());
        when(errorMemoryRepository.findByUserIdAndIsMutedFalseOrderByOccurrenceCountDesc(10L))
                .thenReturn(java.util.Collections.emptyList());
        when(catalogService.getTasks()).thenReturn(java.util.List.of(Map.of("id", "task-1", "title", "Starter Task")));
        when(evidenceRepository.countByUserIdAndRecordedAtAfter(eq(10L), any())).thenReturn(5L);
        when(practiceRepository.findByUserIdOrderByCreatedAtDesc(10L)).thenReturn(java.util.Collections.emptyList());
        when(submissionRepository.findByUserIdAndKindOrderByCreatedAtDesc(eq(10L), eq(SubmissionKind.COACH_DRAFT)))
                .thenReturn(java.util.Collections.emptyList());

        ForYouDashboardDto forYou = writingSessionService.getForYou(10L);
        assertNotNull(forYou);
        assertNotNull(forYou.getContinueSession());
        assertEquals("sess-1", forYou.getContinueSession().getId());
        assertEquals(5L, forYou.getWeeklyEvidenceCount());
        assertNotNull(forYou.getRecommendedDuePractice());
        assertEquals(0, forYou.getWeeklyWordsWritten());
        assertEquals(1500, forYou.getWeeklyTargetWords());
        assertEquals(7, forYou.getDailyWordCounts().size());
        assertTrue(forYou.getIsCurriculumRecommendation());
    }
}
