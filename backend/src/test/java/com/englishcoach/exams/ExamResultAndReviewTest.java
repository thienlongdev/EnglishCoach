package com.englishcoach.exams;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.controller.ExamResultController;
import com.englishcoach.exams.job.ExamJobService;
import com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.ResponseRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.SubmissionRecord;
import com.englishcoach.exams.model.ExamContentRecords.AnswerSpecRecord;
import com.englishcoach.exams.model.ExamContentRecords.ItemVersionRecord;
import com.englishcoach.exams.model.ExamMediaRecords.RecordingRecord;
import com.englishcoach.exams.model.ExamScoringRecords.*;
import com.englishcoach.exams.model.ExamSpeakingReviewRecords.SpeakingAttemptReviewDto;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.repository.ExamScoringRepository;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.service.ExamResultService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ExamResultAndReviewTest {

    @Mock
    private ExamAttemptRepository attemptRepository;
    @Mock
    private ExamScoringRepository scoringRepository;
    @Mock
    private ExamContentRepository contentRepository;
    @Mock
    private ExamMediaRepository mediaRepository;
    @Mock
    private ExamJobService jobService;
    @Mock
    private ExamResultService mockResultService;

    private ExamResultService resultService;
    private ExamResultController resultController;

    private final UUID attemptId = UUID.randomUUID();
    private final UUID formId = UUID.randomUUID();
    private final UUID submissionId = UUID.randomUUID();
    private final UUID artifactId = UUID.randomUUID();
    private final Long userId = 664L;

    private AttemptRecord createAttempt(ExamAttemptStatus status, long revision) {
        return new AttemptRecord(
                attemptId, userId, formId, ExamFamily.IELTS, "ACADEMIC", "FULL",
                ExamAttemptMode.EXAM_SIMULATION, null, null, status,
                revision, 1L, "token", Instant.now().plus(1, ChronoUnit.HOURS),
                "pinned_hash_abc", Map.of(), null, Instant.now().minus(10, ChronoUnit.MINUTES),
                Instant.now(), Instant.now(), null, List.of(), Instant.now(), Instant.now()
        );
    }

    @BeforeEach
    void setUp() {
        ExamAnswerNormalizer normalizer = new ExamAnswerNormalizer();
        ExamObjectiveScorer objectiveScorer = new ExamObjectiveScorer(normalizer);
        resultService = new ExamResultService(
                attemptRepository,
                scoringRepository,
                contentRepository,
                mediaRepository,
                objectiveScorer
        );
        resultController = new ExamResultController(mockResultService, jobService);
    }

    @Test
    @DisplayName("Review Shell: Speaking and Writing items NEVER leak objective answer keys or explanations")
    void testSubjectiveItemsNeverLeakAnswerKeys() {
        AttemptRecord attempt = createAttempt(ExamAttemptStatus.SUBMITTED, 5L);
        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(attempt));

        UUID readingItemId = UUID.randomUUID();
        UUID speakingItemId = UUID.randomUUID();
        UUID writingItemId = UUID.randomUUID();

        ItemVersionRecord readingItem = new ItemVersionRecord(
                readingItemId, UUID.randomUUID(), "R-01", 1, "Reading question prompt",
                "MULTIPLE_CHOICE", Map.of(), "construct", null, "hash-r", Instant.now(), 1
        );
        ItemVersionRecord speakingItem = new ItemVersionRecord(
                speakingItemId, UUID.randomUUID(), "S-01", 1, "Describe your hometown",
                "SPEAKING", Map.of(), "construct", null, "hash-s", Instant.now(), 2
        );
        ItemVersionRecord writingItem = new ItemVersionRecord(
                writingItemId, UUID.randomUUID(), "W-01", 1, "Write an essay about environment",
                "ESSAY", Map.of(), "construct", null, "hash-w", Instant.now(), 3
        );

        when(contentRepository.findItemsByFormId(formId)).thenReturn(List.of(readingItem, speakingItem, writingItem));
        when(contentRepository.findItemSkillsByFormId(formId)).thenReturn(Map.of(
                readingItemId, SkillType.READING,
                speakingItemId, SkillType.SPEAKING,
                writingItemId, SkillType.WRITING
        ));

        AnswerSpecRecord readingSpec = new AnswerSpecRecord(
                UUID.randomUUID(), readingItemId, Map.of("variants", List.of("B")),
                Map.of(), 1, null, 1.0, "Reading explanation text", null, Instant.now()
        );
        // Even if database has stray answer specs for speaking/writing, they must be suppressed!
        AnswerSpecRecord speakingSpec = new AnswerSpecRecord(
                UUID.randomUUID(), speakingItemId, Map.of("variants", List.of("Stray Key")),
                Map.of(), 1, null, 1.0, "Stray Speaking Explanation", null, Instant.now()
        );
        AnswerSpecRecord writingSpec = new AnswerSpecRecord(
                UUID.randomUUID(), writingItemId, Map.of("variants", List.of("Stray Key")),
                Map.of(), 1, null, 1.0, "Stray Writing Explanation", null, Instant.now()
        );
        when(contentRepository.findAnswerSpecsByFormId(formId)).thenReturn(Map.of(
                readingItemId, readingSpec,
                speakingItemId, speakingSpec,
                writingItemId, writingSpec
        ));

        UUID recId = UUID.randomUUID();
        ResponseRecord readingResp = new ResponseRecord(
                UUID.randomUUID(), attemptId, null, "placement-r1", readingItemId,
                Map.of("value", "B"), null, null, false, 1L, "cmd-1", Instant.now()
        );
        ResponseRecord speakingResp = new ResponseRecord(
                UUID.randomUUID(), attemptId, null, "placement-s1", speakingItemId,
                null, "Candidate spoken transcript text", recId, false, 1L, "cmd-2", Instant.now()
        );
        ResponseRecord writingResp = new ResponseRecord(
                UUID.randomUUID(), attemptId, null, "placement-w1", writingItemId,
                null, "Candidate essay text about environment", null, false, 1L, "cmd-3", Instant.now()
        );
        when(attemptRepository.findResponsesByAttemptId(attemptId)).thenReturn(List.of(readingResp, speakingResp, writingResp));

        RecordingRecord recording = new RecordingRecord(
                recId, attemptId, speakingResp.id(), "placement-s1", Instant.now().minusSeconds(120),
                Instant.now().minusSeconds(60), "audio/webm", Map.of(), RecordingState.SEALED,
                3, 48000L, List.of(), null, null, Map.of("snr", 28.5), Instant.now()
        );
        when(mediaRepository.findRecordingsByAttemptId(attemptId)).thenReturn(List.of(recording));

        // Act
        AttemptReviewDto review = resultService.getAttemptReview(attemptId, userId, false);

        // Assert
        assertNotNull(review);
        assertEquals(3, review.items().size());

        // 1. Reading item (Objective)
        ItemReviewDto rItem = review.items().stream().filter(i -> i.itemId().equals(readingItemId)).findFirst().orElseThrow();
        assertEquals(SkillType.READING, rItem.skill());
        assertFalse(rItem.isSubjective());
        // Exams Phase 9B: correct values only — never the raw answer-spec map (keySource / policies / rejected answers)
        assertEquals(Map.of("values", List.of("B")), rItem.acceptedAnswers());
        assertEquals("Reading explanation text", rItem.explanation());
        assertTrue(rItem.isCorrect());
        assertEquals(1.0, rItem.creditAwarded());

        // 2. Speaking item (Subjective) - MUST NEVER LEAK ANSWER KEY OR EXPLANATION
        ItemReviewDto sItem = review.items().stream().filter(i -> i.itemId().equals(speakingItemId)).findFirst().orElseThrow();
        assertEquals(SkillType.SPEAKING, sItem.skill());
        assertTrue(sItem.isSubjective());
        assertNull(sItem.acceptedAnswers(), "Speaking review must NEVER expose acceptedAnswers");
        assertNull(sItem.explanation(), "Speaking review must NEVER expose objective explanation");
        assertFalse(sItem.isCorrect(), "Speaking item must not be marked correct/incorrect");
        assertEquals(0.0, sItem.creditAwarded());
        assertEquals(0.0, sItem.maxCredit());

        // 3. Writing item (Subjective) - MUST NEVER LEAK ANSWER KEY OR EXPLANATION
        ItemReviewDto wItem = review.items().stream().filter(i -> i.itemId().equals(writingItemId)).findFirst().orElseThrow();
        assertEquals(SkillType.WRITING, wItem.skill());
        assertTrue(wItem.isSubjective());
        assertNull(wItem.acceptedAnswers(), "Writing review must NEVER expose acceptedAnswers");
        assertNull(wItem.explanation(), "Writing review must NEVER expose objective explanation");
        assertFalse(wItem.isCorrect());
        assertEquals(0.0, wItem.creditAwarded());
        assertEquals(0.0, wItem.maxCredit());

        // 4. Speaking Attempt Review structure
        assertNotNull(review.speakingReview());
        SpeakingAttemptReviewDto spkReview = review.speakingReview();
        assertEquals(1, spkReview.turns().size());
        assertEquals("Describe your hometown", spkReview.turns().get(0).promptText());
        assertEquals(recId, spkReview.turns().get(0).recordingId());
        assertEquals(3, spkReview.turns().get(0).durationSeconds()); // 48000 / 16000
        assertFalse(spkReview.criteria().isEmpty());
    }

    @Test
    @DisplayName("Result Processing: Pending subjective score never renders scaledScore as 0.0 or overallScore as deflated zero")
    void testPendingSubjectiveScoreDoesNotDeflateOverall() {
        AttemptRecord attempt = createAttempt(ExamAttemptStatus.SUBMITTED, 5L);
        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(attempt));

        SubmissionRecord submission = new SubmissionRecord(
                submissionId, attemptId, SubmissionReason.MANUAL, Instant.now(),
                Map.of(), "payload-hash", Map.of(), "evidence-hash", Instant.now()
        );
        when(attemptRepository.findSubmissionByAttemptId(attemptId)).thenReturn(Optional.of(submission));

        // Artifact is PARTIAL because Speaking & Writing are awaiting evaluation
        ScoreArtifactRecord artifact = new ScoreArtifactRecord(
                artifactId, submissionId, 1, null, Map.of("pipeline", "v4"),
                "hash", ResultStatus.PARTIAL, Map.of(), Instant.now()
        );
        when(scoringRepository.findLatestArtifactBySubmissionId(submissionId)).thenReturn(Optional.of(artifact));

        List<ScoreComponentRecord> components = List.of(
                new ScoreComponentRecord(UUID.randomUUID(), artifactId, ExamFamily.IELTS, ScoreMetric.LISTENING, null, null, 32.0, 7.5, "IELTS_BAND", Map.of(), null, Instant.now()),
                new ScoreComponentRecord(UUID.randomUUID(), artifactId, ExamFamily.IELTS, ScoreMetric.READING, null, null, 30.0, 7.0, "IELTS_BAND", Map.of(), null, Instant.now()),
                // Speaking is pending (rawScore null, scaledScore 0.0)
                new ScoreComponentRecord(UUID.randomUUID(), artifactId, ExamFamily.IELTS, ScoreMetric.SPEAKING, null, null, null, 0.0, "IELTS_BAND", Map.of(), null, Instant.now()),
                // Writing is pending (rawScore null, scaledScore 0.0)
                new ScoreComponentRecord(UUID.randomUUID(), artifactId, ExamFamily.IELTS, ScoreMetric.WRITING, null, null, null, 0.0, "IELTS_BAND", Map.of(), null, Instant.now()),
                // Full overall placeholder in database is 0.0 or deflated
                new ScoreComponentRecord(UUID.randomUUID(), artifactId, ExamFamily.IELTS, ScoreMetric.FULL_OVERALL, null, null, null, 3.6, "IELTS_BAND", Map.of(), null, Instant.now())
        );
        when(scoringRepository.findComponentsByArtifactId(artifactId)).thenReturn(components);
        when(scoringRepository.findCriteriaByArtifactId(artifactId)).thenReturn(List.of());

        // Act
        Optional<ExamResultDto> resultOpt = resultService.getAttemptResult(attemptId, userId, false);

        // Assert
        assertTrue(resultOpt.isPresent());
        ExamResultDto result = resultOpt.get();

        // Overall score MUST be null while subjective sections are pending!
        assertNull(result.overallScore(), "Overall score must be null when subjective skills are pending evaluation");

        // Speaking component must be marked pending and not reported as a final 0.0
        ComponentScoreDto spkComp = result.components().stream().filter(c -> c.metric() == ScoreMetric.SPEAKING).findFirst().orElseThrow();
        assertTrue(spkComp.isPending());
        assertEquals("PENDING_AI_EVALUATION", spkComp.status());

        ComponentScoreDto wrtComp = result.components().stream().filter(c -> c.metric() == ScoreMetric.WRITING).findFirst().orElseThrow();
        assertTrue(wrtComp.isPending());
        assertEquals("PENDING_AI_EVALUATION", wrtComp.status());

        // Full IELTS uses atomic readiness: every numeric skill stays hidden until all four skills are ready.
        assertTrue(result.skillScores().isEmpty());
        assertTrue(result.components().stream().allMatch(c -> c.scaledScore() == null));
    }

    @Test
    @DisplayName("Controller: 401 on unauthenticated, 202 on in-progress scoring, 200 on ready result")
    void testControllerStatusDiscrimination() {
        // 1. Unauthenticated -> 401
        ResponseEntity<?> resp401 = resultController.getResult(attemptId, null);
        assertEquals(HttpStatus.UNAUTHORIZED, resp401.getStatusCode());

        UserDetailsImpl user = new UserDetailsImpl(userId, "learner@englishcoach.app", "pass", List.of(new SimpleGrantedAuthority("ROLE_USER")));

        // 2. In progress -> 202 Accepted
        when(mockResultService.getAttemptResult(attemptId, userId, false)).thenReturn(Optional.empty());
        ScoringProgressDto progress = new ScoringProgressDto(
                attemptId, ResultStatus.PARTIAL, false, List.of(), null, Instant.now().plusSeconds(60)
        );
        when(jobService.getAttemptScoringProgress(attemptId)).thenReturn(Optional.of(progress));

        ResponseEntity<?> resp202 = resultController.getResult(attemptId, user);
        assertEquals(HttpStatus.ACCEPTED, resp202.getStatusCode());
        assertEquals(progress, resp202.getBody());

        // 3. Completed -> 200 OK
        ExamResultDto completedResult = new ExamResultDto(
                artifactId, attemptId, ExamFamily.IELTS, "ACADEMIC", "FULL",
                ExamAttemptMode.EXAM_SIMULATION, ResultStatus.COMPLETED, 7.5,
                Map.of("LISTENING", 8.0, "READING", 7.5, "WRITING", 7.0, "SPEAKING", 7.5),
                List.of(), List.of(), Map.of(), Instant.now()
        );
        when(mockResultService.getAttemptResult(attemptId, userId, false)).thenReturn(Optional.of(completedResult));

        ResponseEntity<?> resp200 = resultController.getResult(attemptId, user);
        assertEquals(HttpStatus.OK, resp200.getStatusCode());
        assertEquals(completedResult, resp200.getBody());
    }

    @Test
    @DisplayName("Speaking Review Endpoint: Returns SpeakingAttemptReviewDto or 404 when no speaking section")
    void testSpeakingReviewDedicatedEndpoint() {
        // 1. Unauthenticated -> 401
        ResponseEntity<?> resp401 = resultController.getSpeakingReview(attemptId, null);
        assertEquals(HttpStatus.UNAUTHORIZED, resp401.getStatusCode());

        UserDetailsImpl user = new UserDetailsImpl(userId, "learner@englishcoach.app", "pass", List.of(new SimpleGrantedAuthority("ROLE_USER")));

        // 2. Review exists with speakingReview
        SpeakingAttemptReviewDto spkReview = new SpeakingAttemptReviewDto(
                attemptId, ExamFamily.IELTS, ResultStatus.PARTIAL, null,
                List.of(), List.of(), "Feedback", null
        );
        AttemptReviewDto fullReview = new AttemptReviewDto(attemptId, ExamFamily.IELTS, List.of(), true, spkReview);
        when(mockResultService.getAttemptReview(attemptId, userId, false)).thenReturn(fullReview);

        ResponseEntity<SpeakingAttemptReviewDto> resp200 = resultController.getSpeakingReview(attemptId, user);
        assertEquals(HttpStatus.OK, resp200.getStatusCode());
        assertNotNull(resp200.getBody());
        assertEquals(attemptId, resp200.getBody().attemptId());

        // 3. Review without speakingReview -> 404
        AttemptReviewDto noSpkReview = new AttemptReviewDto(attemptId, ExamFamily.IELTS, List.of(), true, null);
        when(mockResultService.getAttemptReview(attemptId, userId, false)).thenReturn(noSpkReview);

        ResponseEntity<SpeakingAttemptReviewDto> resp404 = resultController.getSpeakingReview(attemptId, user);
        assertEquals(HttpStatus.NOT_FOUND, resp404.getStatusCode());
    }
}
