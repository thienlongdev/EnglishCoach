package com.englishcoach.ai.service;

import com.englishcoach.ai.service.LearnerDnaAggregatorService.LearnerDnaProfile;
import com.englishcoach.exams.model.ExamProfileRecords.IeltsProfileDto;
import com.englishcoach.exams.model.ExamProfileRecords.MetricSummaryDto;
import com.englishcoach.exams.service.ExamProfileService;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.listening.entity.ExerciseAttempt;
import com.englishcoach.listening.entity.ListeningExercise;
import com.englishcoach.listening.entity.enums.ErrorCategory;
import com.englishcoach.listening.entity.enums.ExerciseType;
import com.englishcoach.listening.repository.ExerciseAttemptRepository;
import com.englishcoach.speaking.entity.SpeakingShadowingAttempt;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import com.englishcoach.writing.entity.WritingAssessmentEntity;
import com.englishcoach.writing.entity.WritingErrorMemoryEntity;
import com.englishcoach.writing.entity.WritingSubmissionEntity;
import com.englishcoach.writing.repository.WritingAssessmentRepository;
import com.englishcoach.writing.repository.WritingErrorMemoryRepository;
import com.englishcoach.writing.repository.WritingSubmissionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.Pageable;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class LearnerDnaAggregatorServiceTest {

    @Mock
    private SpeakingShadowingAttemptRepository shadowingAttemptRepository;

    @Mock
    private SpeakingTurnRepository speakingTurnRepository;

    @Mock
    private WritingErrorMemoryRepository writingErrorMemoryRepository;

    @Mock
    private WritingSubmissionRepository writingSubmissionRepository;

    @Mock
    private WritingAssessmentRepository writingAssessmentRepository;

    @Mock
    private ExerciseAttemptRepository exerciseAttemptRepository;

    @Mock
    private FlashcardRepository flashcardRepository;

    @Mock
    private ExamProfileService examProfileService;

    private ObjectMapper objectMapper;
    private LearnerDnaAggregatorService service;

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();
        service = new LearnerDnaAggregatorService(
                shadowingAttemptRepository,
                speakingTurnRepository,
                writingErrorMemoryRepository,
                writingSubmissionRepository,
                writingAssessmentRepository,
                exerciseAttemptRepository,
                flashcardRepository,
                examProfileService,
                objectMapper
        );
    }

    @Test
    void testLearnerDnaAggregation_AndCompactPayloadUnder1KB() {
        Long userId = 42L;

        // 1. Mock Speaking
        SpeakingShadowingAttempt att = SpeakingShadowingAttempt.builder()
                .id(1L)
                .fluencyScore(55.0)
                .productSafeResultJson("{\"priorities\":[{\"phone\":\"s\",\"issue\":\"MISSING\"}],\"prosody\":{\"speechRate\":92.0}}")
                .build();
        when(shadowingAttemptRepository.findRecentAttemptsByUserId(eq(userId), any(LocalDateTime.class), any(Pageable.class)))
                .thenReturn(List.of(att));

        SpeakingTurn turn = SpeakingTurn.builder()
                .id(10L)
                .fluencyScore(60)
                .pronunciationResultJson("{\"priorities\":[{\"phone\":\"ed\",\"issue\":\"DELETION\"},{\"phone\":\"t\",\"issue\":\"MISSING\"}],\"prosody\":{\"speechRate\":88.0}}")
                .build();
        when(speakingTurnRepository.findRecentLearnerTurnsByUserId(eq(userId), any(LocalDateTime.class), any(Pageable.class)))
                .thenReturn(List.of(turn));

        // 2. Mock Writing
        WritingErrorMemoryEntity mem1 = WritingErrorMemoryEntity.builder()
                .patternCode("run_on_sentence")
                .title("Run-on Sentence")
                .occurrenceCount(5)
                .build();
        WritingErrorMemoryEntity mem2 = WritingErrorMemoryEntity.builder()
                .patternCode("tense_shift")
                .title("Tense Inconsistency")
                .occurrenceCount(3)
                .build();
        when(writingErrorMemoryRepository.findByUserIdAndIsMutedFalseOrderByOccurrenceCountDesc(userId))
                .thenReturn(List.of(mem1, mem2));

        WritingSubmissionEntity sub = WritingSubmissionEntity.builder()
                .id("sub-1")
                .userId(userId)
                .build();
        when(writingSubmissionRepository.findTop10ByUserIdOrderByCreatedAtDesc(userId))
                .thenReturn(List.of(sub));

        WritingAssessmentEntity assess = WritingAssessmentEntity.builder()
                .id("assess-1")
                .submissionId("sub-1")
                .dimensionVerdicts("[{\"dimension\":\"cohesion\",\"score\":5.5},{\"dimension\":\"task_achievement\",\"score\":6.0}]")
                .build();
        when(writingAssessmentRepository.findBySubmissionIdIn(List.of("sub-1")))
                .thenReturn(List.of(assess));

        // 3. Mock Listening
        ListeningExercise ex1 = ListeningExercise.builder()
                .id(101L)
                .questionText("Section 3 Discussion on marine biology")
                .expectedAnswer("whales")
                .exerciseType(ExerciseType.MCQ)
                .build();
        ExerciseAttempt att1 = ExerciseAttempt.builder()
                .id(201L)
                .isCorrect(false)
                .rawUserAnswer("whale")
                .listeningExercise(ex1)
                .primaryErrorCategory(ErrorCategory.MINOR_SPELLING)
                .build();
        when(exerciseAttemptRepository.findRecentAttemptsWithExerciseByUserId(eq(userId), any(Pageable.class)))
                .thenReturn(List.of(att1));

        // 4. Mock Reading (Strict invariant: detailed_dna_available = false)
        MetricSummaryDto readingSummary = new MetricSummaryDto(6.5, 7.0, Instant.now(), Instant.now(), 0.0, "STABLE");
        IeltsProfileDto ieltsProfile = new IeltsProfileDto(null, null, readingSummary, null, null, List.of(), null, null, List.of());
        when(examProfileService.getIeltsProfile(userId)).thenReturn(ieltsProfile);

        // 5. Mock Vocabulary
        when(flashcardRepository.countCriticalForgettingByUserId(userId)).thenReturn(14L);

        // Execute
        long startTime = System.currentTimeMillis();
        String json = service.getLearnerDnaJson(userId);
        long fetchDuration = System.currentTimeMillis() - startTime;

        // Verify Performance & Compression (< 1KB = 1024 bytes)
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        assertThat(bytes.length)
                .as("JSON payload must be strictly under 1KB (1024 bytes)")
                .isLessThan(1024);
        assertThat(fetchDuration).isLessThan(500);

        // Verify Contents
        assertThat(json).contains("\"user_id\":42");
        assertThat(json).contains("\"detailed_dna_available\":false");
        assertThat(json).contains("\"estimated_band_score\":6.5");
        assertThat(json).contains("\"critical_forgetting_count\":14");
        assertThat(json).contains("\"run-on sentences\"");
        assertThat(json).contains("\"tense inconsistency\"");
        assertThat(json).contains("\"/s/\"");
        assertThat(json).contains("\"cohesion\":5.5");

        // Verify Caching (< 30ms TTL fetch)
        long cacheStartTime = System.currentTimeMillis();
        String cachedJson = service.getLearnerDnaJson(userId);
        long cacheDuration = System.currentTimeMillis() - cacheStartTime;

        assertThat(cacheDuration)
                .as("In-memory cache retrieval must be under 30ms")
                .isLessThan(30);
        assertThat(cachedJson).isEqualTo(json);

        // Verify repository methods were not called again due to cache hit
        verify(flashcardRepository, times(1)).countCriticalForgettingByUserId(userId);
    }

    @Test
    void testGuestLearnerDna() {
        String json = service.getLearnerDnaJson(null);
        assertThat(json.getBytes(StandardCharsets.UTF_8).length).isLessThan(1024);
        assertThat(json).contains("\"detailed_dna_available\":false");
        assertThat(json).contains("\"critical_forgetting_count\":0");
    }
}
