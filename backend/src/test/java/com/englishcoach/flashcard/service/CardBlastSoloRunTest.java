package com.englishcoach.flashcard.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.dto.CardBlastFinishRunRequest;
import com.englishcoach.flashcard.entity.CardBlastRun;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.repository.CardBlastRunRepository;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import com.englishcoach.leaderboard.activity.event.CardBlastRunFinishedEvent;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.domain.PageImpl;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * A solo Card Blast result counts only for a run the server started for the same learner, once, and only within what
 * the elapsed time allows. Everything else (no run, another learner's run, a replay, impossible numbers) earns nothing.
 */
class CardBlastSoloRunTest {

    private static final long USER = 42L;
    private static final long OTHER_USER = 43L;

    /** A clock the test moves by hand. */
    private static final class TestClock extends Clock {
        private Instant now = Instant.parse("2026-10-14T03:00:00Z");

        void advance(Duration by) {
            now = now.plus(by);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }

    private TestClock clock;
    private CardBlastRunRegistry registry;
    private FlashcardRepository flashcardRepository;
    private CardBlastRunRepository runRepository;
    private VocabDeckRepository deckRepository;
    private ApplicationEventPublisher events;
    private FlashcardService service;

    @BeforeEach
    void setUp() {
        clock = new TestClock();
        registry = new CardBlastRunRegistry(clock);
        flashcardRepository = mock(FlashcardRepository.class);
        runRepository = mock(CardBlastRunRepository.class);
        deckRepository = mock(VocabDeckRepository.class);
        events = mock(ApplicationEventPublisher.class);
        UserRepository userRepository = mock(UserRepository.class);
        when(userRepository.findById(USER)).thenReturn(Optional.of(User.builder().id(USER).email("a@example.com").build()));
        when(userRepository.findById(OTHER_USER)).thenReturn(Optional.of(User.builder().id(OTHER_USER).email("b@example.com").build()));
        when(flashcardRepository.findByUserId(any(), any())).thenReturn(new PageImpl<>(List.of()));

        service = new FlashcardService(flashcardRepository, userRepository, mock(DictionaryRepository.class),
                new AnkiNoteParser(), deckRepository, null, null, null, runRepository);
        ReflectionTestUtils.setField(service, "cardBlastRunRegistry", registry);
        ReflectionTestUtils.setField(service, "eventPublisher", events);
    }

    private static CardBlastFinishRunRequest result(String runId, int score, int hits, int attempts) {
        return new CardBlastFinishRunRequest(null, score, 100.0, List.of(), hits, attempts, runId);
    }

    @Test
    @DisplayName("A result without a server-issued run is not stored, not scored and not an activity")
    void resultWithoutRunCountsNothing() {
        boolean counted = service.recordCardBlastRun(USER, result(null, 9_999, 60, 60));

        assertThat(counted).isFalse();
        verify(runRepository, never()).save(any());
        verify(events, never()).publishEvent(any());
    }

    @Test
    @DisplayName("A made-up run id and another learner's run id count nothing")
    void foreignOrInventedRunCountsNothing() {
        String othersRun = service.startCardBlastRun(OTHER_USER, null).orElseThrow();
        clock.advance(Duration.ofMinutes(2));

        assertThat(service.recordCardBlastRun(USER, result("11111111-2222-3333-4444-555555555555", 500, 20, 20))).isFalse();
        assertThat(service.recordCardBlastRun(USER, result(othersRun, 500, 20, 20))).isFalse();
        verify(runRepository, never()).save(any());

        // the attempt did not burn the other learner's run
        assertThat(service.recordCardBlastRun(OTHER_USER, result(othersRun, 500, 20, 20))).isTrue();
    }

    @Test
    @DisplayName("A run counts once: the replay of the same result is ignored")
    void runCountsExactlyOnce() {
        String runId = service.startCardBlastRun(USER, null).orElseThrow();
        clock.advance(Duration.ofMinutes(1));

        assertThat(service.recordCardBlastRun(USER, result(runId, 400, 20, 22))).isTrue();
        assertThat(service.recordCardBlastRun(USER, result(runId, 400, 20, 22))).isFalse();

        verify(runRepository, times(1)).save(any(CardBlastRun.class));
        verify(events, times(1)).publishEvent(any(CardBlastRunFinishedEvent.class));
    }

    @Test
    void databaseFailureLeavesRunAvailableForRetry() {
        String key = service.startCardBlastRun(USER, null).orElseThrow();
        clock.advance(Duration.ofMinutes(1));
        when(runRepository.save(any(CardBlastRun.class))).thenThrow(new IllegalStateException("database unavailable"))
                .thenAnswer(inv -> inv.getArgument(0));
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.recordCardBlastRun(USER, result(key, 100, 4, 5)))
                .isInstanceOf(IllegalStateException.class);
        assertThat(service.recordCardBlastRun(USER, result(key, 100, 4, 5))).isTrue();
        assertThat(service.recordCardBlastRun(USER, result(key, 100, 4, 5))).isFalse();
    }

    @Test
    @DisplayName("Concurrent submissions of one run: exactly one is counted")
    void concurrentReplayCountsOnce() throws Exception {
        String runId = service.startCardBlastRun(USER, null).orElseThrow();
        clock.advance(Duration.ofMinutes(1));

        int callers = 16;
        ExecutorService pool = Executors.newFixedThreadPool(callers);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<Boolean>> answers = new ArrayList<>();
        for (int i = 0; i < callers; i++) {
            answers.add(pool.submit(() -> {
                go.await();
                return service.recordCardBlastRun(USER, result(runId, 400, 20, 20));
            }));
        }
        go.countDown();
        int counted = 0;
        for (Future<Boolean> answer : answers) {
            if (answer.get()) counted++;
        }
        pool.shutdown();

        assertThat(counted).isEqualTo(1);
        verify(runRepository, times(1)).save(any(CardBlastRun.class));
    }

    @Test
    @DisplayName("Numbers are bounded by the time since the start; accuracy is computed on the server")
    void impossibleNumbersAreBounded() {
        String runId = service.startCardBlastRun(USER, null).orElseThrow();
        clock.advance(Duration.ofSeconds(10)); // at most 20 words in 10 s

        assertThat(service.recordCardBlastRun(USER, result(runId, 1_000_000, 500, 500))).isTrue();

        ArgumentCaptor<CardBlastRun> stored = ArgumentCaptor.forClass(CardBlastRun.class);
        verify(runRepository).save(stored.capture());
        assertThat(stored.getValue().getScore()).isEqualTo(20 * FlashcardService.CARD_BLAST_MAX_SCORE_PER_WORD);

        ArgumentCaptor<CardBlastRunFinishedEvent> event = ArgumentCaptor.forClass(CardBlastRunFinishedEvent.class);
        verify(events).publishEvent(event.capture());
        assertThat(event.getValue().hits()).isEqualTo(20);
        assertThat(event.getValue().accuracyPct()).isEqualTo(100.0);
    }

    @Test
    @DisplayName("A result sent the moment the run started earns nothing")
    void instantResultEarnsNothing() {
        String runId = service.startCardBlastRun(USER, null).orElseThrow();

        assertThat(service.recordCardBlastRun(USER, result(runId, 5_000, 60, 60))).isTrue();

        ArgumentCaptor<CardBlastRun> stored = ArgumentCaptor.forClass(CardBlastRun.class);
        verify(runRepository).save(stored.capture());
        assertThat(stored.getValue().getScore()).isZero();
    }

    @Test
    @DisplayName("Accuracy comes from hits and attempts, never from the client's own figure")
    void accuracyIsRecomputed() {
        String runId = service.startCardBlastRun(USER, null).orElseThrow();
        clock.advance(Duration.ofMinutes(5));

        service.recordCardBlastRun(USER, new CardBlastFinishRunRequest(null, 300, 100.0, List.of(), 10, 40, runId));

        ArgumentCaptor<CardBlastRun> stored = ArgumentCaptor.forClass(CardBlastRun.class);
        verify(runRepository).save(stored.capture());
        assertThat(stored.getValue().getAccuracy()).isEqualTo(25.0);
    }

    @Test
    @DisplayName("The deck of a run is the one bound at the start, not the one named in the result")
    void deckIsBoundAtStart() {
        when(deckRepository.existsById(7L)).thenReturn(true);
        when(deckRepository.existsById(999L)).thenReturn(false);

        assertThat(registryDeckOf(service.startCardBlastRun(USER, 999L).orElseThrow())).isNull();
        clock.advance(Duration.ofSeconds(5));
        assertThat(registryDeckOf(service.startCardBlastRun(USER, 7L).orElseThrow())).isEqualTo(7L);
    }

    private Long registryDeckOf(String runId) {
        return registry.redeem(USER, runId).orElseThrow().deckId();
    }

    @Test
    @DisplayName("Weak words of an uncounted result still only touch the learner's own cards via targeted bulk update")
    @SuppressWarnings("unchecked")
    void weakWordsStayWithinOwnCards() {
        List<Long> ids = new ArrayList<>(List.of(101L, 555_555L));
        for (long i = 0; i < 5_000; i++) ids.add(1_000_000L + i);
        service.recordCardBlastRun(USER, new CardBlastFinishRunRequest(null, 0, 0.0, ids, 0, 0, null));

        ArgumentCaptor<java.util.Collection<Long>> weakIdsCaptor = ArgumentCaptor.forClass(java.util.Collection.class);
        ArgumentCaptor<LocalDateTime> dueAtCaptor = ArgumentCaptor.forClass(LocalDateTime.class);
        ArgumentCaptor<LocalDateTime> nowCaptor = ArgumentCaptor.forClass(LocalDateTime.class);
        verify(flashcardRepository).prioritizeWeakFlashcards(eq(USER), weakIdsCaptor.capture(), dueAtCaptor.capture(), nowCaptor.capture());
        assertThat(weakIdsCaptor.getValue()).hasSize(FlashcardService.CARD_BLAST_MAX_WEAK_WORDS);
        assertThat(weakIdsCaptor.getValue()).contains(101L, 555_555L);
        assertThat(dueAtCaptor.getValue()).isBefore(nowCaptor.getValue());
        verify(flashcardRepository, never()).findByUserId(any(), any());
        verify(flashcardRepository, never()).saveAll(any());
        verify(runRepository, never()).save(any());
    }

    @Test
    @DisplayName("Registry: runs expire, are capped per learner, and cannot be started in a burst")
    void registryLimits() {
        CardBlastRunRegistry.IssuedRun first = registry.issue(USER, null).orElseThrow();
        assertThat(registry.issue(USER, null)).as("second start within the minimum interval").isEmpty();

        clock.advance(Duration.ofSeconds(3));
        registry.issue(USER, null).orElseThrow();
        clock.advance(Duration.ofSeconds(3));
        registry.issue(USER, null).orElseThrow();
        clock.advance(Duration.ofSeconds(3));
        registry.issue(USER, null).orElseThrow();

        assertThat(registry.openRuns()).isEqualTo(CardBlastRunRegistry.MAX_OPEN_RUNS_PER_USER);
        assertThat(registry.redeem(USER, first.runId())).as("oldest run was dropped").isEmpty();

        CardBlastRunRegistry.IssuedRun late = registry.issue(OTHER_USER, null).orElseThrow();
        clock.advance(CardBlastRunRegistry.RUN_LIFETIME.plusSeconds(1));
        assertThat(registry.redeem(OTHER_USER, late.runId())).as("expired run").isEmpty();
    }
}
