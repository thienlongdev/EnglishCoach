package com.englishcoach.reading;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.reading.dto.ContextualExplainRequest;
import com.englishcoach.reading.dto.ContextualVocabularyResponse;
import com.englishcoach.reading.entity.ReadingContextualExplanation;
import com.englishcoach.reading.entity.ReadingContextualVocabularyHistory;
import com.englishcoach.reading.entity.ReadingMaterial;
import com.englishcoach.reading.repository.ReadingContextualExplanationRepository;
import com.englishcoach.reading.repository.ReadingContextualVocabularyHistoryRepository;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.reading.service.ContextTranslationService;
import com.englishcoach.reading.service.ReadingContextualService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.RestTemplate;

import java.util.List;
import java.util.concurrent.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@SpringBootTest
class ReadingContextualConcurrencyIntegrationTest {

    @Autowired
    private ReadingContextualService contextualService;

    @Autowired
    private ReadingContextualExplanationRepository explanationRepo;

    @Autowired
    private ReadingContextualVocabularyHistoryRepository historyRepo;

    @Autowired
    private ReadingMaterialRepository readingMaterialRepo;

    @Autowired
    private UserRepository userRepo;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ObjectMapper objectMapper;

    private User userA;
    private User userB;
    private ReadingMaterial testMaterial;
    private ContextTranslationService originalTranslator;
    private final String testWord = "sacred_concurrent_test";
    private final String testSentence = "He later expressed deep regret for breaking the sacred_concurrent_test rules.";

    @BeforeEach
    void setUp() throws Exception {
        // Own every fixture row; never depend on or reuse ambient learner data.
        userA = fixtureUser();
        userB = fixtureUser();
        testMaterial = readingMaterialRepo.save(ReadingMaterial.builder()
                    .title("Balinese Traditions Concurrency Test")
                    .contentText("Passage with sacred_concurrent_test vocabulary. " + testSentence)
                    .difficultyLevel("B2")
                    .isSystem(true).ownerUserId(null)
                    .build());

        // 3. Clean any existing explanations / histories for this test word to ensure guaranteed cache miss
        cleanTestData();

        // 4. Mock the contextual translation model (no provider call in tests)
        ContextTranslationService mockTranslator = mock(ContextTranslationService.class);
        when(mockTranslator.translate(any())).thenAnswer(inv -> {
            // Introduce slight latency to amplify concurrency race
            Thread.sleep(50);
            return new ContextTranslationService.Result("thiêng liêng trong bối cảnh tôn giáo", null,
                    "Điều có ý nghĩa tôn giáo và cần được tôn trọng.", "WORD", null, "sacred", "tính từ", "B2", null, "HIGH", null, "test");
        });
        originalTranslator = (ContextTranslationService) org.springframework.test.util.ReflectionTestUtils.getField(contextualService, "contextTranslator");
        contextualService.setContextTranslationService(mockTranslator);
    }

    @AfterEach
    void tearDown() {
        contextualService.setContextTranslationService(originalTranslator);
        if (testMaterial != null) {
            cleanTestData();
            readingMaterialRepo.deleteById(testMaterial.getId());
        }
        if (userA != null) userRepo.deleteById(userA.getId());
        if (userB != null) userRepo.deleteById(userB.getId());
    }

    private User fixtureUser() {
        return userRepo.saveAndFlush(User.builder().email("reading-concurrency-" + java.util.UUID.randomUUID() + "@example.test")
                .name("Reading fixture").role(Role.ROLE_USER).build());
    }

    private void cleanTestData() {
        // Cascade deletes history rows referencing the explanation
        jdbcTemplate.update(
                "DELETE FROM public.reading_contextual_vocabulary_history WHERE reading_material_id = ?",
                testMaterial.getId()
        );
        jdbcTemplate.update(
                "DELETE FROM public.reading_contextual_explanations WHERE reading_material_id = ? AND normalized_text = ?",
                testMaterial.getId(), testWord
        );
    }

    @Test
    @DisplayName("Real Concurrency: Two simultaneous cache misses create exactly ONE shared explanation row with NO rollback-only failures")
    void testConcurrentCacheMisses_SingleSharedRow_BothUsersSucceed() throws Exception {
        ContextualExplainRequest request = new ContextualExplainRequest(
                testWord,
                testSentence,
                testMaterial.getId(),
                "Concurrency Test Passage"
        );

        try (ExecutorService executor = Executors.newFixedThreadPool(2)) {
        CountDownLatch readyLatch = new CountDownLatch(2);
        CountDownLatch startLatch = new CountDownLatch(1);

        Callable<ContextualVocabularyResponse> taskA = () -> {
            readyLatch.countDown();
            startLatch.await(5, TimeUnit.SECONDS);
            return contextualService.explainAndSave(userA.getId(), request);
        };

        Callable<ContextualVocabularyResponse> taskB = () -> {
            readyLatch.countDown();
            startLatch.await(5, TimeUnit.SECONDS);
            return contextualService.explainAndSave(userB.getId(), request);
        };

        Future<ContextualVocabularyResponse> futureA = executor.submit(taskA);
        Future<ContextualVocabularyResponse> futureB = executor.submit(taskB);

        // Wait for both threads to be ready, then release them simultaneously
        assertThat(readyLatch.await(5, TimeUnit.SECONDS)).isTrue();
        startLatch.countDown();

        // Await responses - both must complete without exception
        ContextualVocabularyResponse responseA = futureA.get(10, TimeUnit.SECONDS);
        ContextualVocabularyResponse responseB = futureB.get(10, TimeUnit.SECONDS);

        executor.shutdown();

        // 1. Both requests succeeded without rollback-only or 500
        assertThat(responseA).isNotNull();
        assertThat(responseB).isNotNull();
        assertThat(responseA.getText()).isEqualTo(testWord);
        assertThat(responseB.getText()).isEqualTo(testWord);
        assertThat(responseA.getMeaningInContext()).contains("thiêng liêng");
        assertThat(responseB.getMeaningInContext()).contains("thiêng liêng");

        // 2. Query PostgreSQL directly: EXACTLY ONE shared explanation row was created
        Integer explanationCount = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM public.reading_contextual_explanations WHERE reading_material_id = ? AND normalized_text = ?",
                Integer.class,
                testMaterial.getId(),
                testWord
        );
        assertThat(explanationCount).as("Must be exactly 1 shared explanation row created").isEqualTo(1);

        // 3. Both users received valid personal history links pointing to the SAME shared explanation
        Long sharedExplanationId = jdbcTemplate.queryForObject(
                "SELECT id FROM public.reading_contextual_explanations WHERE reading_material_id = ? AND normalized_text = ?",
                Long.class,
                testMaterial.getId(),
                testWord
        );
        assertThat(sharedExplanationId).isNotNull();

        List<ReadingContextualVocabularyHistory> historyA = historyRepo
                .findByUserIdAndReadingMaterialIdOrderByCreatedAtDesc(userA.getId(), testMaterial.getId());
        List<ReadingContextualVocabularyHistory> historyB = historyRepo
                .findByUserIdAndReadingMaterialIdOrderByCreatedAtDesc(userB.getId(), testMaterial.getId());

        assertThat(historyA).hasSize(1);
        assertThat(historyB).hasSize(1);
        assertThat(historyA.get(0).getExplanation().getId()).isEqualTo(sharedExplanationId);
        assertThat(historyB.get(0).getExplanation().getId()).isEqualTo(sharedExplanationId);
        assertThat(historyA.get(0).getId()).isNotEqualTo(historyB.get(0).getId());
        assertThat(historyA.get(0).getUserId()).isEqualTo(userA.getId());
        assertThat(historyB.get(0).getUserId()).isEqualTo(userB.getId());
        }
    }
}
