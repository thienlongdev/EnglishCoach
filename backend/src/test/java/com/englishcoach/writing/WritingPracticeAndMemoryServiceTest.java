package com.englishcoach.writing;

import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.dto.*;
import com.englishcoach.writing.entity.WritingFeedbackIssueEntity;
import com.englishcoach.writing.entity.WritingLearningEvidenceEntity;
import com.englishcoach.writing.entity.WritingPracticeEntity;
import com.englishcoach.writing.enums.EvidenceType;
import com.englishcoach.writing.enums.IssueDisposition;
import com.englishcoach.writing.enums.PracticeMode;
import com.englishcoach.writing.enums.PracticeEvaluationStatus;
import com.englishcoach.writing.enums.DimensionStatus;
import com.englishcoach.writing.exception.WritingNotFoundException;
import com.englishcoach.writing.repository.WritingErrorMemoryRepository;
import com.englishcoach.writing.repository.WritingFeedbackIssueRepository;
import com.englishcoach.writing.repository.WritingLearningEvidenceRepository;
import com.englishcoach.writing.repository.WritingPracticeRepository;
import com.englishcoach.writing.repository.WritingSubmissionRepository;
import com.englishcoach.writing.service.WritingCatalogService;
import com.englishcoach.writing.service.WritingErrorMemoryServiceImpl;
import com.englishcoach.writing.service.WritingPracticeServiceImpl;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class WritingPracticeAndMemoryServiceTest {

    @Mock
    private WritingProperties writingProperties;

    @Mock
    private WritingPracticeRepository practiceRepository;

    @Mock
    private WritingSubmissionRepository submissionRepository;

    @Mock
    private WritingCatalogService catalogService;

    @Mock
    private WritingErrorMemoryRepository errorMemoryRepository;

    @Mock
    private WritingLearningEvidenceRepository learningEvidenceRepository;

    @Mock
    private WritingFeedbackIssueRepository issueRepository;

    @Mock
    private com.englishcoach.writing.client.WritingAiClient writingAiClient;

    private ObjectMapper objectMapper = new ObjectMapper();

    private WritingErrorMemoryServiceImpl errorMemoryService;
    private WritingPracticeServiceImpl practiceService;

    @BeforeEach
    void setUp() {
        errorMemoryService = new WritingErrorMemoryServiceImpl(
                errorMemoryRepository,
                learningEvidenceRepository,
                issueRepository,
                catalogService
        );

        practiceService = new WritingPracticeServiceImpl(
                writingProperties,
                practiceRepository,
                submissionRepository,
                catalogService,
                errorMemoryService,
                writingAiClient,
                objectMapper
        );

        lenient().when(writingProperties.isEnabled()).thenReturn(true);
        lenient().when(writingProperties.isMutationsEnabled()).thenReturn(true);
    }

    @Test
    void testStartPractice_DoesNotLeakModelAnswer() {
        Long userId = 10L;

        Map<String, Object> exercise = new HashMap<>();
        exercise.put("id", "ex-repair-1");
        exercise.put("mode", "REPAIR");
        exercise.put("pattern_code", "THIRD_PERSON_SINGULAR_AUXILIARY");
        exercise.put("prompt", "Fix the verb error.");
        exercise.put("original_context", "She don't like apples.");
        exercise.put("target_sentence", "She doesn't like apples.");
        exercise.put("constraints", List.of("Use doesn't"));
        exercise.put("hints", List.of(
                Map.of("level", 1, "text", "Use does/doesn't with third person singular."),
                Map.of("level", 2, "text", "Replace don't with doesn't."),
                Map.of("level", 3, "text", "Model answer: She doesn't like apples.")
        ));
        exercise.put("accepted_answers", List.of("She doesn't like apples."));

        when(catalogService.getExercisesByPatternCode("THIRD_PERSON_SINGULAR_AUXILIARY")).thenReturn(List.of(exercise));
        when(practiceRepository.save(any(WritingPracticeEntity.class))).thenAnswer(i -> i.getArgument(0));

        PracticeStartRequest req = PracticeStartRequest.builder()
                .targetPatternCode("THIRD_PERSON_SINGULAR_AUXILIARY")
                .build();

        PracticeEpisodeDto dto = practiceService.startPractice(userId, req);

        assertNotNull(dto);
        assertEquals(PracticeMode.REPAIR, dto.getMode());
        assertTrue(dto.getRevealedHints().isEmpty(), "Initial revealed hints must be empty");
        assertFalse(dto.getModelAnswerRevealed(), "Model answer must NOT be revealed initially");
    }

    @Test
    void testSubmitAttempt_AcceptsAlternativeAnswer() {
        Long userId = 10L;
        String practiceId = "prac-123";

        Map<String, Object> exercise = new HashMap<>();
        exercise.put("id", "ex-repair-1");
        exercise.put("mode", "REPAIR");
        exercise.put("target_sentence", "She doesn't understand.");
        exercise.put("accepted_answers", List.of("She doesn't understand.", "She does not understand."));

        WritingPracticeEntity practice = WritingPracticeEntity.builder()
                .id(practiceId)
                .userId(userId)
                .mode(PracticeMode.REPAIR)
                .exerciseSnapshot(assertDoesNotThrow(() -> objectMapper.writeValueAsString(exercise)))
                .currentAttemptOrdinal(0)
                .maxAttempts(3)
                .revealedHints("[]")
                .isCompleted(false)
                .isSuccess(false)
                .build();

        when(practiceRepository.findByIdAndUserId(practiceId, userId)).thenReturn(Optional.of(practice));
        when(submissionRepository.save(any())).thenAnswer(i -> i.getArgument(0));
        when(practiceRepository.save(any())).thenAnswer(i -> i.getArgument(0));

        PracticeAttemptRequest req = PracticeAttemptRequest.builder()
                .answer("She does not understand.")
                .build();

        PracticeAttemptResultDto result = practiceService.submitAttempt(userId, practiceId, req);

        assertNotNull(result);
        assertTrue(result.getIsSuccess(), "Should accept alternative valid answer 'She does not understand.'");
        assertTrue(result.getIsCompleted());
    }

    @Test
    void testDisputeIssue_MarksDisputedAndRecordsRetraction() {
        Long userId = 10L;
        String issueId = "issue-123";
        String patternCode = "THIRD_PERSON_SINGULAR_AUXILIARY";

        WritingFeedbackIssueEntity issue = WritingFeedbackIssueEntity.builder()
                .id(issueId)
                .assessmentId("assess-1")
                .patternCode(patternCode)
                .disposition(IssueDisposition.ACTIVE)
                .build();

        WritingLearningEvidenceEntity evEntity = WritingLearningEvidenceEntity.builder()
                .id("ev-1")
                .userId(userId)
                .sourceIssueId(issueId)
                .build();
        when(learningEvidenceRepository.findFirstBySourceIssueId(issueId)).thenReturn(Optional.of(evEntity));
        when(issueRepository.findById(issueId)).thenReturn(Optional.of(issue));
        when(issueRepository.save(any())).thenAnswer(i -> i.getArgument(0));
        when(learningEvidenceRepository.save(any())).thenAnswer(i -> i.getArgument(0));
        when(learningEvidenceRepository.findByUserIdAndPatternCodeOrderByRecordedAtDesc(userId, patternCode))
                .thenReturn(Collections.emptyList());

        errorMemoryService.disputeIssue(userId, issueId, "Not an error in this dialect");

        assertEquals(IssueDisposition.DISPUTED, issue.getDisposition());
        verify(learningEvidenceRepository, times(1)).save(argThat(ev ->
                ev.getEvidenceType() == EvidenceType.RETRACTION &&
                ev.getSourceIssueId().equals(issueId)
        ));
    }

    @Test
    void testDisputeIssue_ForeignUser_ThrowsWritingNotFoundException() {
        Long userId = 10L;
        String issueId = "issue-foreign";

        WritingFeedbackIssueEntity issue = WritingFeedbackIssueEntity.builder()
                .id(issueId)
                .assessmentId("assess-1")
                .patternCode("THIRD_PERSON_SINGULAR_AUXILIARY")
                .disposition(IssueDisposition.ACTIVE)
                .build();

        WritingLearningEvidenceEntity foreignEvidence = WritingLearningEvidenceEntity.builder()
                .id("ev-foreign")
                .userId(999L) // foreign user
                .sourceIssueId(issueId)
                .build();

        when(issueRepository.findById(issueId)).thenReturn(Optional.of(issue));
        when(learningEvidenceRepository.findFirstBySourceIssueId(issueId)).thenReturn(Optional.of(foreignEvidence));

        // Foreign resource enumeration protection: Must return 404 WritingNotFoundException, NOT 403
        assertThrows(WritingNotFoundException.class, () -> {
            errorMemoryService.disputeIssue(userId, issueId, "Unauthorized dispute attempt");
        });
    }

    @Test
    void testOpenEndedPractice_ValidOutsideCatalog_AcceptedViaAi() {
        Long userId = 10L;
        String practiceId = "prac-combine";

        Map<String, Object> exercise = new HashMap<>();
        exercise.put("id", "ex-combine-1");
        exercise.put("mode", "COMBINE");
        exercise.put("prompt", "Combine these two sentences into one fluent sentence.");
        exercise.put("original_context", "The weather was bad. We decided to stay home.");
        exercise.put("target_sentence", "Because the weather was bad, we decided to stay home.");
        exercise.put("accepted_answers", List.of("Because the weather was bad, we decided to stay home."));

        WritingPracticeEntity practice = WritingPracticeEntity.builder()
                .id(practiceId)
                .userId(userId)
                .mode(PracticeMode.COMBINE)
                .exerciseSnapshot(assertDoesNotThrow(() -> objectMapper.writeValueAsString(exercise)))
                .currentAttemptOrdinal(0)
                .maxAttempts(3)
                .revealedHints("[]")
                .isCompleted(false)
                .isSuccess(false)
                .build();

        when(practiceRepository.findByIdAndUserId(practiceId, userId)).thenReturn(Optional.of(practice));
        when(submissionRepository.save(any())).thenAnswer(i -> i.getArgument(0));
        when(practiceRepository.save(any())).thenAnswer(i -> i.getArgument(0));

        // Learner submits a genuinely valid alternative formulation not in the catalog
        String novelValidAnswer = "Since the weather conditions were unfavorable, we chose to remain indoors.";

        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(true)
                .issues(Collections.emptyList())
                .dimensionVerdicts(List.of(
                        DimensionVerdictDto.builder().dimension("Grammar").status(DimensionStatus.CORRECT).score(95).build()
                ))
                .explanation("The combined sentence is grammatically sound and clearly expresses the causal relationship.")
                .build();

        when(writingAiClient.analyzeSentence(eq(novelValidAnswer), eq("general"), any())).thenReturn(aiResponse);

        PracticeAttemptRequest req = PracticeAttemptRequest.builder()
                .answer(novelValidAnswer)
                .build();

        PracticeAttemptResultDto result = practiceService.submitAttempt(userId, practiceId, req);

        assertNotNull(result);
        assertTrue(result.getIsSuccess(), "Valid English formulation outside catalog model must be accepted");
        assertEquals(PracticeEvaluationStatus.VALID, result.getEvaluationStatus());
        assertTrue(result.getIsCompleted());
    }

    @Test
    void testOpenEndedPractice_GrammarError_ClassifiedAsInvalid() {
        Long userId = 10L;
        String practiceId = "prac-expand";

        Map<String, Object> exercise = new HashMap<>();
        exercise.put("id", "ex-expand-1");
        exercise.put("mode", "EXPAND");
        exercise.put("target_sentence", "Although the project faced severe delays, the team completed all deliverables.");
        exercise.put("accepted_answers", List.of("Although the project faced severe delays, the team completed all deliverables."));

        WritingPracticeEntity practice = WritingPracticeEntity.builder()
                .id(practiceId)
                .userId(userId)
                .mode(PracticeMode.EXPAND)
                .exerciseSnapshot(assertDoesNotThrow(() -> objectMapper.writeValueAsString(exercise)))
                .currentAttemptOrdinal(0)
                .maxAttempts(3)
                .revealedHints("[]")
                .isCompleted(false)
                .isSuccess(false)
                .build();

        when(practiceRepository.findByIdAndUserId(practiceId, userId)).thenReturn(Optional.of(practice));
        when(submissionRepository.save(any())).thenAnswer(i -> i.getArgument(0));
        when(practiceRepository.save(any())).thenAnswer(i -> i.getArgument(0));

        String invalidAnswer = "Although the project face delays, the team complete it.";

        FeedbackIssueDto grammarIssue = FeedbackIssueDto.builder()
                .kind(com.englishcoach.writing.enums.IssueKind.ERROR)
                .category("Grammar")
                .explanation("Past tense requires 'faced' and 'completed'.")
                .build();

        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(false)
                .issues(List.of(grammarIssue))
                .dimensionVerdicts(List.of(
                        DimensionVerdictDto.builder().dimension("Grammar").status(DimensionStatus.NEEDS_WORK).score(55).build()
                ))
                .explanation("Grammar errors detected in verb inflection.")
                .build();

        when(writingAiClient.analyzeSentence(eq(invalidAnswer), eq("general"), any())).thenReturn(aiResponse);

        PracticeAttemptRequest req = PracticeAttemptRequest.builder()
                .answer(invalidAnswer)
                .build();

        PracticeAttemptResultDto result = practiceService.submitAttempt(userId, practiceId, req);

        assertNotNull(result);
        assertFalse(result.getIsSuccess());
        assertEquals(PracticeEvaluationStatus.INVALID, result.getEvaluationStatus());
        assertFalse(practice.getModelAnswerRevealed(), "Model answer must NOT be leaked on failed attempt");
        assertNull(result.getUnlockedHint());
    }

    @Test
    void testOpenEndedPractice_AiUnavailable_ClassifiedAsUncertain() {
        Long userId = 10L;
        String practiceId = "prac-rewrite";

        Map<String, Object> exercise = new HashMap<>();
        exercise.put("id", "ex-rewrite-1");
        exercise.put("mode", "REWRITE_NATURALLY");
        exercise.put("target_sentence", "I look forward to hearing from you soon.");
        exercise.put("accepted_answers", List.of("I look forward to hearing from you soon."));

        WritingPracticeEntity practice = WritingPracticeEntity.builder()
                .id(practiceId)
                .userId(userId)
                .mode(PracticeMode.REWRITE_NATURALLY)
                .exerciseSnapshot(assertDoesNotThrow(() -> objectMapper.writeValueAsString(exercise)))
                .currentAttemptOrdinal(0)
                .maxAttempts(3)
                .revealedHints("[]")
                .isCompleted(false)
                .isSuccess(false)
                .build();

        when(practiceRepository.findByIdAndUserId(practiceId, userId)).thenReturn(Optional.of(practice));
        when(submissionRepository.save(any())).thenAnswer(i -> i.getArgument(0));
        when(practiceRepository.save(any())).thenAnswer(i -> i.getArgument(0));

        String unverifiedAnswer = "I eagerly anticipate your timely response.";

        SentenceAnalysisAiResponse aiResponse = SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(false)
                .issues(Collections.emptyList())
                .dimensionVerdicts(List.of(
                        DimensionVerdictDto.builder().dimension("Grammar").status(DimensionStatus.UNAVAILABLE).build()
                ))
                .explanation("AI analysis is temporarily unavailable or inconclusive.")
                .build();

        when(writingAiClient.analyzeSentence(eq(unverifiedAnswer), eq("general"), any())).thenReturn(aiResponse);

        PracticeAttemptRequest req = PracticeAttemptRequest.builder()
                .answer(unverifiedAnswer)
                .build();

        PracticeAttemptResultDto result = practiceService.submitAttempt(userId, practiceId, req);

        assertNotNull(result);
        assertFalse(result.getIsSuccess());
        assertEquals(PracticeEvaluationStatus.UNCERTAIN, result.getEvaluationStatus());
        assertFalse(practice.getModelAnswerRevealed(), "Model answer must NOT be leaked when evaluation is uncertain");
        assertNull(result.getUnlockedHint());
    }
}
