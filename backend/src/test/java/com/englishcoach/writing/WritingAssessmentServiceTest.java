package com.englishcoach.writing;

import com.englishcoach.writing.client.WritingAiClient;
import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.dto.*;
import com.englishcoach.writing.entity.WritingAssessmentEntity;
import com.englishcoach.writing.entity.WritingFeedbackIssueEntity;
import com.englishcoach.writing.entity.WritingSubmissionEntity;
import com.englishcoach.writing.enums.*;
import com.englishcoach.writing.exception.WritingNotFoundException;
import com.englishcoach.writing.repository.WritingAssessmentRepository;
import com.englishcoach.writing.repository.WritingFeedbackIssueRepository;
import com.englishcoach.writing.repository.WritingSubmissionRepository;
import com.englishcoach.writing.service.DeterministicGrammarValidator;
import com.englishcoach.writing.service.WritingAssessmentServiceImpl;
import com.englishcoach.writing.service.WritingCatalogService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class WritingAssessmentServiceTest {

    @Mock
    private WritingProperties writingProperties;

    @Mock
    private WritingSubmissionRepository submissionRepository;

    @Mock
    private WritingAssessmentRepository assessmentRepository;

    @Mock
    private WritingFeedbackIssueRepository issueRepository;

    @Mock
    private WritingAiClient writingAiClient;

    @Mock
    private com.englishcoach.writing.service.WritingErrorMemoryService errorMemoryService;

    @Mock
    private WritingCatalogService catalogService;

    private ObjectMapper objectMapper = new ObjectMapper();
    private com.englishcoach.writing.service.cache.SentenceCheckAnalysisCache sentenceCheckCache;

    private WritingAssessmentServiceImpl assessmentService;

    @BeforeEach
    void setUp() {
        sentenceCheckCache = new com.englishcoach.writing.service.cache.SentenceCheckAnalysisCache();
        DeterministicGrammarValidator grammarValidator = new DeterministicGrammarValidator();
        assessmentService = new WritingAssessmentServiceImpl(
                writingProperties,
                submissionRepository,
                assessmentRepository,
                issueRepository,
                writingAiClient,
                errorMemoryService,
                catalogService,
                grammarValidator,
                sentenceCheckCache,
                objectMapper
        );
        lenient().when(writingProperties.isEnabled()).thenReturn(true);
        lenient().when(writingProperties.isMutationsEnabled()).thenReturn(true);
        lenient().when(writingProperties.getMaxSentenceChars()).thenReturn(2000);
    }

    @Test
    void testSubmitSentenceCheck_Success() {
        Long userId = 10L;
        String text = "She don't like apples.";

        when(submissionRepository.save(any(WritingSubmissionEntity.class))).thenAnswer(invocation -> {
            WritingSubmissionEntity entity = invocation.getArgument(0);
            return entity;
        });

        when(assessmentRepository.save(any(WritingAssessmentEntity.class))).thenAnswer(invocation -> {
            WritingAssessmentEntity entity = invocation.getArgument(0);
            return entity;
        });

        FeedbackIssueDto issue = FeedbackIssueDto.builder()
                .kind(IssueKind.ERROR)
                .severity(IssueSeverity.MAJOR)
                .category("Grammar")
                .patternCode("THIRD_PERSON_SINGULAR_AUXILIARY")
                .title("Third Person Auxiliary")
                .sourceQuote("She don't")
                .startOffset(0)
                .endOffset(9)
                .replacement("She doesn't")
                .build();

        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(false)
                .issues(List.of(issue))
                .explanation("Error detected in auxiliary verb.")
                .build();

        when(writingAiClient.analyzeSentence(eq(text), anyString(), any())).thenReturn(aiResponse);
        when(issueRepository.save(any(WritingFeedbackIssueEntity.class))).thenAnswer(i -> i.getArgument(0));

        SentenceCheckSubmissionRequest req = SentenceCheckSubmissionRequest.builder()
                .text(text)
                .targetRegister("formal")
                .build();

        SentenceCheckResultDto result = assessmentService.submitSentenceCheck(userId, req);

        assertNotNull(result);
        assertFalse(result.getGrammaticallyCorrect());
        assertEquals(1, result.getIssues().size());
        assertEquals("THIRD_PERSON_SINGULAR_AUXILIARY", result.getIssues().get(0).getPatternCode());
        assertEquals("She doesn't", result.getIssues().get(0).getReplacement());
        assertEquals(AssessmentStatus.READY, result.getStatus());
    }

    @Test
    void testSubmitSentenceCheck_CorrectSentence() {
        Long userId = 10L;
        String text = "The meeting was productive and concise.";

        when(submissionRepository.save(any())).thenAnswer(i -> i.getArgument(0));
        when(assessmentRepository.save(any())).thenAnswer(i -> i.getArgument(0));

        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(true)
                .issues(Collections.emptyList())
                .explanation("The sentence is completely correct.")
                .build();

        when(writingAiClient.analyzeSentence(eq(text), anyString(), any())).thenReturn(aiResponse);

        SentenceCheckSubmissionRequest req = SentenceCheckSubmissionRequest.builder()
                .text(text)
                .build();

        SentenceCheckResultDto result = assessmentService.submitSentenceCheck(userId, req);

        assertNotNull(result);
        assertTrue(result.getGrammaticallyCorrect());
        assertTrue(result.getIssues().isEmpty());
    }

    @Test
    void testGetAssessment_ForbiddenForDifferentUser() {
        Long ownerId = 10L;
        Long otherUserId = 99L;
        String assessmentId = "assess-123";
        String submissionId = "sub-123";

        WritingAssessmentEntity assessment = WritingAssessmentEntity.builder()
                .id(assessmentId)
                .submissionId(submissionId)
                .status(AssessmentStatus.READY)
                .dimensionVerdicts("[]")
                .build();

        WritingSubmissionEntity submission = WritingSubmissionEntity.builder()
                .id(submissionId)
                .userId(ownerId)
                .build();

        when(assessmentRepository.findById(assessmentId)).thenReturn(Optional.of(assessment));
        when(submissionRepository.findById(submissionId)).thenReturn(Optional.of(submission));

        assertThrows(WritingNotFoundException.class, () -> {
            assessmentService.getAssessment(otherUserId, assessmentId);
        });
    }

    @Test
    void testSubmitSentenceCheck_RejectsEmptyText() {
        SentenceCheckSubmissionRequest req = SentenceCheckSubmissionRequest.builder()
                .text("   ")
                .build();

        assertThrows(IllegalArgumentException.class, () -> {
            assessmentService.submitSentenceCheck(10L, req);
        });
    }

    @Test
    void testSubmitSentenceCheck_AiFailure_NullGrammaticallyCorrect_DoesNotRecordMistake() {
        Long userId = 10L;
        String text = "Unanalyzable sentence during network timeout.";

        when(submissionRepository.save(any())).thenAnswer(i -> i.getArgument(0));
        when(assessmentRepository.save(any())).thenAnswer(i -> i.getArgument(0));

        // When AI fails or returns inconclusive, grammaticallyCorrect is null
        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(null)
                .analysisStatus("ANALYSIS_UNAVAILABLE")
                .dimensionVerdicts(List.of(
                        DimensionVerdictDto.builder()
                                .dimension("Grammar")
                                .status(DimensionStatus.UNAVAILABLE)
                                .summary("Grammar analysis unavailable.")
                                .build()
                ))
                .issues(Collections.emptyList())
                .explanation("AI analysis is temporarily unavailable.")
                .build();

        when(writingAiClient.analyzeSentence(eq(text), anyString(), any())).thenReturn(aiResponse);

        SentenceCheckSubmissionRequest req = SentenceCheckSubmissionRequest.builder()
                .text(text)
                .build();

        SentenceCheckResultDto result = assessmentService.submitSentenceCheck(userId, req);

        assertNotNull(result);
        assertNull(result.getGrammaticallyCorrect(), "grammaticallyCorrect must be null when AI analysis is unavailable");
        assertEquals("ANALYSIS_UNAVAILABLE", result.getAnalysisStatus());
        assertEquals(AssessmentStatus.READY, result.getStatus());

        // CRITICAL SEMANTIC HARDENING: Must NEVER record mistake observation to Error Memory on failure/inconclusive!
        verify(errorMemoryService, never()).recordMistakeObservation(any(), any(), any(), any(), any());
    }

    @Test
    void testSubmitSentenceCheck_InconclusiveContext_DoesNotRecordMistake() {
        Long userId = 10L;
        String text = "Although having many ideas";

        when(submissionRepository.save(any())).thenAnswer(i -> i.getArgument(0));
        when(assessmentRepository.save(any())).thenAnswer(i -> i.getArgument(0));

        FeedbackIssueDto uncertainIssue = FeedbackIssueDto.builder()
                .kind(IssueKind.UNCERTAIN)
                .severity(IssueSeverity.MINOR)
                .category("Grammar")
                .patternCode("AMBIGUOUS_FRAGMENT")
                .title("Ambiguous Fragment")
                .sourceQuote("Although having many ideas")
                .startOffset(0)
                .endOffset(26)
                .build();

        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(null)
                .analysisStatus("INCONCLUSIVE")
                .dimensionVerdicts(List.of(
                        DimensionVerdictDto.builder()
                                .dimension("Grammar")
                                .status(DimensionStatus.UNCERTAIN)
                                .summary("Ambiguous context.")
                                .build()
                ))
                .issues(List.of(uncertainIssue))
                .explanation("Context is ambiguous.")
                .build();

        when(writingAiClient.analyzeSentence(eq(text), anyString(), any())).thenReturn(aiResponse);
        when(issueRepository.save(any())).thenAnswer(i -> i.getArgument(0));

        SentenceCheckSubmissionRequest req = SentenceCheckSubmissionRequest.builder()
                .text(text)
                .build();

        SentenceCheckResultDto result = assessmentService.submitSentenceCheck(userId, req);

        assertNotNull(result);
        assertNull(result.getGrammaticallyCorrect(), "grammaticallyCorrect must be null when inconclusive");
        verify(errorMemoryService, never()).recordMistakeObservation(any(), any(), any(), any(), any());
    }

    @Test
    void testSubmitSentenceCheck_CollocationError_PreservesGrammaticallyCorrectTrue_AndRecordsVocabularyMemory() {
        Long userId = 10L;
        String text = "I do a decision.";

        when(submissionRepository.save(any(WritingSubmissionEntity.class))).thenAnswer(i -> i.getArgument(0));
        when(assessmentRepository.save(any(WritingAssessmentEntity.class))).thenAnswer(i -> i.getArgument(0));

        FeedbackIssueDto collocationIssue = FeedbackIssueDto.builder()
                .kind(IssueKind.ERROR)
                .severity(IssueSeverity.MAJOR)
                .category("Vocabulary")
                .patternCode("COLLOCATION_VERB_NOUN")
                .title("Collocation: Make a Decision")
                .sourceQuote("do a decision")
                .startOffset(2)
                .endOffset(15)
                .replacement("make a decision")
                .build();

        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(true)
                .analysisStatus("COMPLETED")
                .dimensionVerdicts(List.of(
                        DimensionVerdictDto.builder().dimension("Grammar").status(DimensionStatus.CORRECT).summary("Grammar is sound.").build(),
                        DimensionVerdictDto.builder().dimension("Vocabulary").status(DimensionStatus.NEEDS_WORK).summary("Collocation needs attention.").build()
                ))
                .issues(List.of(collocationIssue))
                .explanation("Grammar is sound, but vocabulary/collocation needs correction.")
                .build();

        when(writingAiClient.analyzeSentence(eq(text), anyString(), any())).thenReturn(aiResponse);
        when(issueRepository.save(any(WritingFeedbackIssueEntity.class))).thenAnswer(i -> i.getArgument(0));

        SentenceCheckSubmissionRequest req = SentenceCheckSubmissionRequest.builder()
                .text(text)
                .build();

        SentenceCheckResultDto result = assessmentService.submitSentenceCheck(userId, req);

        assertNotNull(result);
        assertTrue(result.getGrammaticallyCorrect(), "grammaticallyCorrect must remain TRUE when only collocation error exists!");
        assertEquals(1, result.getIssues().size());
        assertEquals("Vocabulary", result.getIssues().get(0).getCategory());

        // Confirmed vocabulary/collocation error enters its vocabulary memory
        verify(errorMemoryService, times(1)).recordMistakeObservation(
                eq(userId),
                any(),
                any(),
                eq("COLLOCATION_VERB_NOUN"),
                any()
        );
    }

    @Test
    void testSubmitSentenceCheck_NaturalnessImprovement_PreservesGrammaticallyCorrectTrue_DoesNotRecordMemory() {
        Long userId = 10L;
        String text = "I strongly like this movie.";

        when(submissionRepository.save(any(WritingSubmissionEntity.class))).thenAnswer(i -> i.getArgument(0));
        when(assessmentRepository.save(any(WritingAssessmentEntity.class))).thenAnswer(i -> i.getArgument(0));

        FeedbackIssueDto naturalnessIssue = FeedbackIssueDto.builder()
                .kind(IssueKind.IMPROVEMENT)
                .severity(IssueSeverity.SUGGESTION)
                .category("Naturalness")
                .patternCode(null)
                .title("Naturalness: Adverb Collocation with 'Like'")
                .sourceQuote("strongly like")
                .startOffset(2)
                .endOffset(15)
                .replacement("really like")
                .build();

        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(true)
                .analysisStatus("COMPLETED")
                .dimensionVerdicts(List.of(
                        DimensionVerdictDto.builder().dimension("Grammar").status(DimensionStatus.CORRECT).summary("Grammar is sound.").build(),
                        DimensionVerdictDto.builder().dimension("Naturalness").status(DimensionStatus.NEEDS_WORK).summary("Phrasing could be more idiomatic.").build()
                ))
                .issues(List.of(naturalnessIssue))
                .explanation("Grammar is sound, but phrasing could be more idiomatic.")
                .build();

        when(writingAiClient.analyzeSentence(eq(text), anyString(), any())).thenReturn(aiResponse);
        when(issueRepository.save(any(WritingFeedbackIssueEntity.class))).thenAnswer(i -> i.getArgument(0));

        SentenceCheckSubmissionRequest req = SentenceCheckSubmissionRequest.builder()
                .text(text)
                .build();

        SentenceCheckResultDto result = assessmentService.submitSentenceCheck(userId, req);

        assertNotNull(result);
        assertTrue(result.getGrammaticallyCorrect(), "grammaticallyCorrect must remain TRUE for naturalness improvements!");
        verify(errorMemoryService, never()).recordMistakeObservation(any(), any(), any(), any(), any());
    }

    @Test
    void testSubmitSentenceCheck_PastAdverbPresentVerbMismatch_CatchesGrammarErrorDeterministically() {
        Long userId = 10L;
        String text = "Yesterday I go to the cinema with my friend.";

        when(submissionRepository.save(any(WritingSubmissionEntity.class))).thenAnswer(i -> i.getArgument(0));
        when(assessmentRepository.save(any(WritingAssessmentEntity.class))).thenAnswer(i -> i.getArgument(0));
        when(issueRepository.save(any(WritingFeedbackIssueEntity.class))).thenAnswer(i -> i.getArgument(0));

        // Simulate AI incorrectly claiming it's grammatically correct or proposing an unchanged replacement
        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(true)
                .analysisStatus("COMPLETED")
                .dimensionVerdicts(List.of(
                        DimensionVerdictDto.builder().dimension("Grammar").status(DimensionStatus.CORRECT).summary("Looks fine").build()
                ))
                .issues(Collections.emptyList())
                .explanation("Looks fine")
                .build();

        when(writingAiClient.analyzeSentence(eq(text), anyString(), any())).thenReturn(aiResponse);

        SentenceCheckSubmissionRequest req = SentenceCheckSubmissionRequest.builder()
                .text(text)
                .build();

        SentenceCheckResultDto result = assessmentService.submitSentenceCheck(userId, req);

        assertNotNull(result);
        assertFalse(result.getGrammaticallyCorrect(), "Deterministic engine must reject grammaticallyCorrect=true when past adverb + present verb mismatch exists!");
        assertNotNull(result.getIssues());
        assertFalse(result.getIssues().isEmpty());

        FeedbackIssueDto issue = result.getIssues().get(0);
        assertEquals("PAST_TENSE_REGULAR_IRREGULAR", issue.getPatternCode());
        assertEquals("went", issue.getReplacement());
        assertEquals("go", issue.getSourceQuote());
        assertNotNull(issue.getTeachingRule());
    }

    @Test
    void testSubmitSentenceCheck_CacheMissThenCacheHit_SkipsAiOnSecondCall() {
        Long userId = 10L;
        String text = "She doesn't like apples.";

        when(submissionRepository.save(any(WritingSubmissionEntity.class))).thenAnswer(i -> i.getArgument(0));
        when(assessmentRepository.save(any(WritingAssessmentEntity.class))).thenAnswer(i -> i.getArgument(0));

        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(true)
                .analysisStatus("COMPLETED")
                .dimensionVerdicts(List.of(
                        DimensionVerdictDto.builder().dimension("Grammar").status(DimensionStatus.CORRECT).summary("Accurate").build()
                ))
                .issues(Collections.emptyList())
                .explanation("Accurate sentence")
                .build();

        when(writingAiClient.analyzeSentence(eq(text), anyString(), any())).thenReturn(aiResponse);

        SentenceCheckSubmissionRequest req = SentenceCheckSubmissionRequest.builder().text(text).build();

        // 1st Call: Cache MISS -> Calls AI
        SentenceCheckResultDto result1 = assessmentService.submitSentenceCheck(userId, req);
        assertNotNull(result1);
        assertTrue(result1.getGrammaticallyCorrect());
        verify(writingAiClient, times(1)).analyzeSentence(eq(text), anyString(), any());

        // 2nd Call: Exact same sentence -> Cache HIT -> Must NOT call AI again!
        SentenceCheckResultDto result2 = assessmentService.submitSentenceCheck(userId, req);
        assertNotNull(result2);
        assertTrue(result2.getGrammaticallyCorrect());
        // Verify AI was still called exactly ONCE, NOT twice!
        verify(writingAiClient, times(1)).analyzeSentence(eq(text), anyString(), any());
    }

    @Test
    void testSubmitSentenceCheck_CacheHit_DoesNotRecordMistakeObservation() {
        Long userId = 10L;
        String text = "She don't like apples.";

        when(submissionRepository.save(any(WritingSubmissionEntity.class))).thenAnswer(i -> i.getArgument(0));
        when(assessmentRepository.save(any(WritingAssessmentEntity.class))).thenAnswer(i -> i.getArgument(0));
        when(issueRepository.save(any(WritingFeedbackIssueEntity.class))).thenAnswer(i -> i.getArgument(0));

        FeedbackIssueDto issue = FeedbackIssueDto.builder()
                .kind(IssueKind.ERROR)
                .severity(IssueSeverity.MAJOR)
                .category("Grammar")
                .patternCode("THIRD_PERSON_SINGULAR_AUXILIARY")
                .title("Third-Person Singular Auxiliary")
                .sourceQuote("don't")
                .startOffset(4)
                .endOffset(9)
                .replacement("doesn't")
                .build();

        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(false)
                .analysisStatus("COMPLETED")
                .dimensionVerdicts(List.of(
                        DimensionVerdictDto.builder().dimension("Grammar").status(DimensionStatus.NEEDS_WORK).summary("Grammar errors detected.").build()
                ))
                .issues(List.of(issue))
                .explanation("Grammar errors detected.")
                .build();

        when(writingAiClient.analyzeSentence(eq(text), anyString(), any())).thenReturn(aiResponse);

        SentenceCheckSubmissionRequest req = SentenceCheckSubmissionRequest.builder().text(text).build();

        // 1st Call: Cache MISS -> Records mistake observation once
        SentenceCheckResultDto result1 = assessmentService.submitSentenceCheck(userId, req);
        assertNotNull(result1);
        verify(errorMemoryService, times(1)).recordMistakeObservation(eq(userId), any(), any(), eq("THIRD_PERSON_SINGULAR_AUXILIARY"), any());

        // 2nd Call: Cache HIT -> Must NOT record mistake observation again!
        SentenceCheckResultDto result2 = assessmentService.submitSentenceCheck(userId, req);
        assertNotNull(result2);
        // Error memory service must still have been called exactly ONCE, NOT twice!
        verify(errorMemoryService, times(1)).recordMistakeObservation(any(), any(), any(), any(), any());
    }

    @Test
    void testSubmitSentenceCheck_ConcurrentSubmissions_SingleFlightDeduplication() throws Exception {
        Long user1 = 10L;
        Long user2 = 20L;
        String text = "He go to school every day.";

        when(submissionRepository.save(any(WritingSubmissionEntity.class))).thenAnswer(i -> i.getArgument(0));
        when(assessmentRepository.save(any(WritingAssessmentEntity.class))).thenAnswer(i -> i.getArgument(0));
        when(issueRepository.save(any(WritingFeedbackIssueEntity.class))).thenAnswer(i -> i.getArgument(0));

        FeedbackIssueDto issue = FeedbackIssueDto.builder()
                .kind(IssueKind.ERROR)
                .severity(IssueSeverity.MAJOR)
                .category("Grammar")
                .patternCode("SUBJECT_VERB_AGREEMENT")
                .title("Subject-Verb Agreement")
                .sourceQuote("go")
                .startOffset(3)
                .endOffset(5)
                .replacement("goes")
                .build();

        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(false)
                .analysisStatus("COMPLETED")
                .dimensionVerdicts(List.of(
                        DimensionVerdictDto.builder().dimension("Grammar").status(DimensionStatus.NEEDS_WORK).summary("Grammar error").build()
                ))
                .issues(List.of(issue))
                .explanation("Subject-verb agreement error.")
                .build();

        // Simulate AI call taking 200ms
        when(writingAiClient.analyzeSentence(eq(text), anyString(), any())).thenAnswer(inv -> {
            Thread.sleep(200);
            return aiResponse;
        });

        SentenceCheckSubmissionRequest req1 = SentenceCheckSubmissionRequest.builder().text(text).build();
        SentenceCheckSubmissionRequest req2 = SentenceCheckSubmissionRequest.builder().text(text).build();

        java.util.concurrent.ExecutorService executor = java.util.concurrent.Executors.newFixedThreadPool(2);
        java.util.concurrent.Future<SentenceCheckResultDto> future1 = executor.submit(() -> assessmentService.submitSentenceCheck(user1, req1));
        // Slight offset so thread 2 definitely joins the in-flight execution of thread 1
        Thread.sleep(30);
        java.util.concurrent.Future<SentenceCheckResultDto> future2 = executor.submit(() -> assessmentService.submitSentenceCheck(user2, req2));

        SentenceCheckResultDto res1 = future1.get(5, java.util.concurrent.TimeUnit.SECONDS);
        SentenceCheckResultDto res2 = future2.get(5, java.util.concurrent.TimeUnit.SECONDS);
        executor.shutdown();

        assertNotNull(res1);
        assertNotNull(res2);
        assertFalse(res1.getGrammaticallyCorrect());
        assertFalse(res2.getGrammaticallyCorrect());

        // CRITICAL SINGLE-FLIGHT INVARIANT: AI client was invoked EXACTLY ONCE across both concurrent requests!
        verify(writingAiClient, times(1)).analyzeSentence(eq(text), anyString(), any());
    }
}
