package com.englishcoach.writing.translation.paragraph;

import com.englishcoach.writing.client.WritingAiClient;
import com.englishcoach.writing.translation.paragraph.dto.*;
import com.englishcoach.writing.translation.paragraph.entity.*;
import com.englishcoach.writing.translation.paragraph.repository.*;
import com.englishcoach.writing.translation.paragraph.service.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.server.ResponseStatusException;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ParagraphAttemptServiceTest {

    @Mock
    private TranslationParagraphSessionRepository sessionRepository;

    @Mock
    private TranslationParagraphSessionItemRepository itemRepository;

    @Mock
    private TranslationParagraphAttemptRepository attemptRepository;

    @Mock
    private TranslationParagraphGradeCacheRepository cacheRepository;

    @Mock
    private TranslationParagraphInFlightRepository inFlightRepository;

    @Mock
    private WritingAiClient writingAiClient;

    private ParagraphDeterministicGrader deterministicGrader;
    private ParagraphGradeCacheService cacheService;
    private ParagraphSingleFlightCoordinator singleFlightCoordinator;
    private ParagraphAttemptService attemptService;
    private ObjectMapper objectMapper;

    private Long userId;
    private UUID sessionId;
    private UUID itemId;
    private UUID passageId;
    private TranslationParagraphSessionEntity session;
    private TranslationParagraphSessionItemEntity item;
    private TranslationParagraphPassageEntity passage;

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();
        deterministicGrader = new ParagraphDeterministicGrader();
        cacheService = new ParagraphGradeCacheService(cacheRepository, deterministicGrader, objectMapper);
        singleFlightCoordinator = new ParagraphSingleFlightCoordinator(inFlightRepository);
        attemptService = new ParagraphAttemptService(
                sessionRepository,
                itemRepository,
                attemptRepository,
                deterministicGrader,
                cacheService,
                singleFlightCoordinator,
                writingAiClient,
                objectMapper
        );

        userId = 100L;
        sessionId = UUID.randomUUID();
        itemId = UUID.randomUUID();
        passageId = UUID.randomUUID();

        session = TranslationParagraphSessionEntity.builder()
                .id(sessionId)
                .userId(userId)
                .status("ACTIVE")
                .currentIndex(0)
                .sessionRevision(1L)
                .totalItems(1)
                .build();

        passage = TranslationParagraphPassageEntity.builder()
                .id(passageId)
                .sourceVi("Đoạn văn tiếng Việt.")
                .referenceEn("This is the reference English paragraph.")
                .sourceHash(deterministicGrader.sha256("Đoạn văn tiếng Việt."))
                .referenceHash(deterministicGrader.sha256("This is the reference English paragraph."))
                .bilingualPairHash("bilingual_hash")
                .genre("GENERAL")
                .topic("GENERAL")
                .contentVersion(1)
                .rightsEligible(true)
                .publicationState("STAGED")
                .build();

        item = TranslationParagraphSessionItemEntity.builder()
                .id(itemId)
                .session(session)
                .passage(passage)
                .contentVersion(1)
                .ordinal(0)
                .draftText("")
                .draftRevision(0L)
                .progressState("NOT_STARTED")
                .build();

        lenient().when(sessionRepository.findById(sessionId)).thenReturn(Optional.of(session));
        lenient().when(itemRepository.findBySessionIdAndOrdinal(sessionId, 0)).thenReturn(Optional.of(item));
        lenient().when(itemRepository.findBySessionIdOrderByOrdinalAsc(sessionId)).thenReturn(List.of(item));
        lenient().when(attemptRepository.save(any(TranslationParagraphAttemptEntity.class)))
                .thenAnswer(inv -> inv.getArgument(0));
    }

    @Test
    void testExactReferenceMatch_YieldsZeroAiCalls() {
        ParagraphAttemptRequest request = ParagraphAttemptRequest.builder()
                .ordinal(0)
                .action("SUBMIT")
                .clientMutationId("mut-exact-1")
                .submittedText("This is the reference English paragraph.") // Exact match
                .build();

        ParagraphAttemptResponse response = attemptService.processAttempt(userId, sessionId, request);

        assertNotNull(response);
        assertTrue(response.getAccepted());
        assertEquals("ACCEPTED", response.getEvaluationStatus());
        assertEquals(0, response.getFeedback().getGenerationCount());
        assertEquals("deterministic/exact-match", response.getFeedback().getModelId());
        assertEquals("PASS", response.getFeedback().getMeaningVerdict());
        assertEquals("ACCEPTED", item.getProgressState());
        assertEquals("COMPLETED", session.getStatus());

        // Zero AI calls
        verifyNoInteractions(writingAiClient);
    }

    @Test
    void testCacheHit_YieldsZeroAiCalls() throws Exception {
        String submitted = "A very good alternative translation.";
        String normalizedAnswer = deterministicGrader.normalize(submitted);
        String normHash = deterministicGrader.sha256(normalizedAnswer);

        String fp = cacheService.computeFingerprint(
                userId, passageId, 1, passage.getSourceHash(), passage.getReferenceHash(),
                normHash, ParagraphDeterministicGrader.GRADER_VERSION, ParagraphDeterministicGrader.PROMPT_VERSION, "GENERAL"
        );

        ParagraphFeedbackDto cachedFeedback = ParagraphFeedbackDto.builder()
                .accepted(true)
                .evaluationStatus("ACCEPTED")
                .overallSummary("Bản dịch tốt từ cache.")
                .meaningVerdict("PASS")
                .grammarVerdict("PASS")
                .naturalnessVerdict("PASS")
                .vocabularyVerdict("PASS")
                .cohesionVerdict("PASS")
                .modelId("openai/gpt-5.6-luna")
                .build();

        TranslationParagraphGradeCacheEntity cacheEntity = TranslationParagraphGradeCacheEntity.builder()
                .userId(userId)
                .passageId(passageId)
                .contentVersion(1)
                .cacheFingerprint(fp)
                .sourceHash(passage.getSourceHash())
                .referenceHash(passage.getReferenceHash())
                .normalizedAnswerHash(normHash)
                .graderVersion(ParagraphDeterministicGrader.GRADER_VERSION)
                .promptVersion(ParagraphDeterministicGrader.PROMPT_VERSION)
                .feedbackJson(objectMapper.writeValueAsString(cachedFeedback))
                .accepted(true)
                .evaluationStatus("ACCEPTED")
                .build();

        when(cacheRepository.findByUserIdAndCacheFingerprint(userId, fp)).thenReturn(Optional.of(cacheEntity));

        ParagraphAttemptRequest request = ParagraphAttemptRequest.builder()
                .ordinal(0)
                .action("SUBMIT")
                .clientMutationId("mut-cache-1")
                .submittedText(submitted)
                .build();

        ParagraphAttemptResponse response = attemptService.processAttempt(userId, sessionId, request);

        assertNotNull(response);
        assertTrue(response.getAccepted());
        assertEquals("ACCEPTED", response.getEvaluationStatus());
        assertEquals(0, response.getFeedback().getGenerationCount());
        assertTrue(response.getFeedback().getCached());

        // Zero AI calls
        verifyNoInteractions(writingAiClient);
    }

    @Test
    void testCacheMissSuccess_ExactlyOneAiCall() {
        String submitted = "An alternative translation requiring model grading.";

        ParagraphGradeAiResponse aiResponse = ParagraphGradeAiResponse.builder()
                .accepted(true)
                .evaluationStatus("ACCEPTED")
                .overallSummary("Bản dịch chính xác và tự nhiên.")
                .meaningVerdict("PASS")
                .meaningScore(90)
                .grammarVerdict("PASS")
                .grammarScore(95)
                .naturalnessVerdict("PASS")
                .naturalnessScore(88)
                .vocabularyVerdict("PASS")
                .vocabularyScore(92)
                .cohesionVerdict("PASS")
                .cohesionScore(85)
                .issues(Collections.emptyList())
                .suggestedCorrection("An alternative translation requiring model grading.")
                .naturalAlternative("An alternative translation requiring model evaluation.")
                .modelId("openai/gpt-5.6-luna")
                .generationCount(1)
                .build();

        when(writingAiClient.gradeParagraphTranslation(any())).thenReturn(aiResponse);

        ParagraphAttemptRequest request = ParagraphAttemptRequest.builder()
                .ordinal(0)
                .action("SUBMIT")
                .clientMutationId("mut-miss-1")
                .submittedText(submitted)
                .build();

        ParagraphAttemptResponse response = attemptService.processAttempt(userId, sessionId, request);

        assertNotNull(response);
        assertTrue(response.getAccepted());
        assertEquals("ACCEPTED", response.getEvaluationStatus());
        assertEquals(1, response.getFeedback().getGenerationCount());
        assertEquals("openai/gpt-5.6-luna", response.getFeedback().getModelId());

        // Exactly 1 AI call
        verify(writingAiClient, times(1)).gradeParagraphTranslation(any());
        // Saved into cache
        verify(cacheRepository, times(1)).save(any());
    }

    @Test
    void testSingleFlightConcurrentSubmission_ReusesLeaderResult() throws Exception {
        String submitted = "Concurrent duplicate submission paragraph.";
        String normalizedAnswer = deterministicGrader.normalize(submitted);
        String normHash = deterministicGrader.sha256(normalizedAnswer);
        String flightKey = deterministicGrader.sha256(userId + ":" + passageId + ":" + normHash);

        // Simulate flight lease already owned by another concurrent thread
        TranslationParagraphInFlightEntity existingInFlight = TranslationParagraphInFlightEntity.builder()
                .flightKey(flightKey)
                .userId(userId)
                .sessionId(sessionId)
                .expiresAt(java.time.Instant.now().plusSeconds(60))
                .build();
        when(inFlightRepository.findByFlightKey(flightKey)).thenReturn(Optional.of(existingInFlight));

        String fp = cacheService.computeFingerprint(
                userId, passageId, 1, passage.getSourceHash(), passage.getReferenceHash(),
                normHash, ParagraphDeterministicGrader.GRADER_VERSION, ParagraphDeterministicGrader.PROMPT_VERSION, "GENERAL"
        );

        ParagraphFeedbackDto leaderFeedback = ParagraphFeedbackDto.builder()
                .accepted(true)
                .evaluationStatus("ACCEPTED")
                .overallSummary("Result from leader thread.")
                .modelId("openai/gpt-5.6-luna")
                .build();

        TranslationParagraphGradeCacheEntity cacheEntity = TranslationParagraphGradeCacheEntity.builder()
                .userId(userId)
                .passageId(passageId)
                .contentVersion(1)
                .cacheFingerprint(fp)
                .sourceHash(passage.getSourceHash())
                .referenceHash(passage.getReferenceHash())
                .normalizedAnswerHash(normHash)
                .graderVersion(ParagraphDeterministicGrader.GRADER_VERSION)
                .promptVersion(ParagraphDeterministicGrader.PROMPT_VERSION)
                .feedbackJson(objectMapper.writeValueAsString(leaderFeedback))
                .accepted(true)
                .evaluationStatus("ACCEPTED")
                .build();

        // When follower polls cache, leader's result is present
        when(cacheRepository.findByUserIdAndCacheFingerprint(userId, fp))
                .thenReturn(Optional.empty()) // Initial check miss
                .thenReturn(Optional.of(cacheEntity)); // Polling hit

        ParagraphAttemptRequest request = ParagraphAttemptRequest.builder()
                .ordinal(0)
                .action("SUBMIT")
                .clientMutationId("mut-follower-1")
                .submittedText(submitted)
                .build();

        ParagraphAttemptResponse response = attemptService.processAttempt(userId, sessionId, request);

        assertNotNull(response);
        assertTrue(response.getAccepted());
        // Follower does NOT invoke AI
        verifyNoInteractions(writingAiClient);
    }

    @Test
    void testTechnicalFailure_ReturnsUncertain_NotIncorrect() {
        String submitted = "Some draft text.";

        ParagraphGradeAiResponse aiResponse = ParagraphGradeAiResponse.builder()
                .accepted(null)
                .evaluationStatus("UNCERTAIN")
                .overallSummary("AI provider timeout.")
                .meaningVerdict("UNCERTAIN")
                .grammarVerdict("UNCERTAIN")
                .naturalnessVerdict("UNCERTAIN")
                .vocabularyVerdict("UNCERTAIN")
                .cohesionVerdict("UNCERTAIN")
                .issues(Collections.emptyList())
                .modelId(null)
                .generationCount(0)
                .build();

        when(writingAiClient.gradeParagraphTranslation(any())).thenReturn(aiResponse);

        ParagraphAttemptRequest request = ParagraphAttemptRequest.builder()
                .ordinal(0)
                .action("SUBMIT")
                .clientMutationId("mut-tech-fail")
                .submittedText(submitted)
                .build();

        ParagraphAttemptResponse response = attemptService.processAttempt(userId, sessionId, request);

        assertNotNull(response);
        assertNull(response.getAccepted());
        assertEquals("UNCERTAIN", response.getEvaluationStatus());
        // Must NOT mark as failed/incorrect, progress remains IN_PROGRESS
        assertEquals("IN_PROGRESS", item.getProgressState());
        assertNotEquals("COMPLETED", session.getStatus());

        // Cache must NOT store UNCERTAIN
        verify(cacheRepository, never()).save(any());
    }

    @Test
    void testStyleOnlyIssue_DoesNotBlockAcceptance() {
        String submitted = "Acceptable sentence structure with minor stylistic improvement.";

        ParagraphGradeAiResponse.ParagraphIssueItemAiDto styleIssue = ParagraphGradeAiResponse.ParagraphIssueItemAiDto.builder()
                .dimension("NATURALNESS")
                .issueType("STYLE")
                .severity("SUGGESTION")
                .learnerSpan("minor stylistic improvement")
                .spanStart(31)
                .spanEnd(59)
                .message("Consider phrasing slightly more concisely.")
                .suggestion("stylistic conciseness")
                .build();

        ParagraphGradeAiResponse aiResponse = ParagraphGradeAiResponse.builder()
                .accepted(true) // Style only -> accepted
                .evaluationStatus("ACCEPTED")
                .overallSummary("Bản dịch tốt, có thể cải thiện chút văn phong.")
                .meaningVerdict("PASS")
                .grammarVerdict("PASS")
                .naturalnessVerdict("PASS")
                .vocabularyVerdict("PASS")
                .cohesionVerdict("PASS")
                .issues(List.of(styleIssue))
                .modelId("openai/gpt-5.6-luna")
                .generationCount(1)
                .build();

        when(writingAiClient.gradeParagraphTranslation(any())).thenReturn(aiResponse);

        ParagraphAttemptRequest request = ParagraphAttemptRequest.builder()
                .ordinal(0)
                .action("SUBMIT")
                .clientMutationId("mut-style-1")
                .submittedText(submitted)
                .build();

        ParagraphAttemptResponse response = attemptService.processAttempt(userId, sessionId, request);

        assertNotNull(response);
        assertTrue(response.getAccepted());
        assertEquals("ACCEPTED", response.getEvaluationStatus());
        assertEquals("ACCEPTED", item.getProgressState());
        assertEquals(1, response.getFeedback().getIssues().size());
        assertEquals("STYLE", response.getFeedback().getIssues().get(0).getIssueType());
    }

    @Test
    void testInvalidOffsets_UnanchorsLocally() {
        String submitted = "Short text.";

        ParagraphGradeAiResponse.ParagraphIssueItemAiDto invalidOffsetIssue = ParagraphGradeAiResponse.ParagraphIssueItemAiDto.builder()
                .dimension("GRAMMAR")
                .issueType("ERROR")
                .severity("MAJOR")
                .learnerSpan("fabricated quotation")
                .spanStart(50) // Out of range! Text is only 11 chars
                .spanEnd(70)
                .message("Invalid range issue.")
                .suggestion("fix")
                .build();

        ParagraphGradeAiResponse aiResponse = ParagraphGradeAiResponse.builder()
                .accepted(false)
                .evaluationStatus("NEEDS_REVISION")
                .overallSummary("Có lỗi ngữ pháp.")
                .meaningVerdict("PASS")
                .grammarVerdict("NEEDS_ATTENTION")
                .naturalnessVerdict("PASS")
                .vocabularyVerdict("PASS")
                .cohesionVerdict("PASS")
                .issues(List.of(invalidOffsetIssue))
                .modelId("openai/gpt-5.6-luna")
                .generationCount(1)
                .build();

        when(writingAiClient.gradeParagraphTranslation(any())).thenReturn(aiResponse);

        ParagraphAttemptRequest request = ParagraphAttemptRequest.builder()
                .ordinal(0)
                .action("SUBMIT")
                .clientMutationId("mut-bad-offset")
                .submittedText(submitted)
                .build();

        ParagraphAttemptResponse response = attemptService.processAttempt(userId, sessionId, request);

        assertNotNull(response);
        assertFalse(response.getAccepted());
        ParagraphIssueDto issue = response.getFeedback().getIssues().get(0);
        // Offsets set to null to avoid wrong highlight
        assertNull(issue.getSpanStart());
        assertNull(issue.getSpanEnd());
    }

    @Test
    void testOwnershipEnforced() {
        Long attackerId = 999L;
        ParagraphAttemptRequest request = ParagraphAttemptRequest.builder()
                .ordinal(0)
                .action("SUBMIT")
                .clientMutationId("mut-evil")
                .submittedText("Hack text.")
                .build();

        assertThrows(AccessDeniedException.class, () ->
                attemptService.processAttempt(attackerId, sessionId, request)
        );
    }

    @Test
    void testWithdrawnIneligiblePassage_CannotBeGraded() {
        passage.setRightsEligible(false); // Passage withdrawn / ineligible

        ParagraphAttemptRequest request = ParagraphAttemptRequest.builder()
                .ordinal(0)
                .action("SUBMIT")
                .clientMutationId("mut-ineligible")
                .submittedText("Text.")
                .build();

        ResponseStatusException ex = assertThrows(ResponseStatusException.class, () ->
                attemptService.processAttempt(userId, sessionId, request)
        );
        assertTrue(ex.getReason().contains("Passage is no longer eligible"));
    }
}
