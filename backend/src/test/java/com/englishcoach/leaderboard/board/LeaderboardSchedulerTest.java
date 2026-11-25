package com.englishcoach.leaderboard.board;

import com.englishcoach.leaderboard.activity.ActivityScoringProperties;
import com.englishcoach.leaderboard.activity.rollup.ActivityRollupService;
import com.englishcoach.proficiency.ProficiencyEvidenceRepository;
import com.englishcoach.proficiency.ProficiencyIngestService;
import com.englishcoach.proficiency.ProficiencyNightlyJob;
import com.englishcoach.proficiency.ProficiencyProperties;
import com.englishcoach.proficiency.ProficiencyService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.MapPropertySource;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;

/**
 * Phase 3.1 A3: the leaderboard refresh and the Proficiency nightly job run on the dedicated
 * single-thread {@code leaderboardTaskScheduler}; every other {@code @Scheduled} method keeps the
 * default scheduler (here a stand-in for the STOMP broker's {@code messageBrokerTaskScheduler}).
 */
class LeaderboardSchedulerTest {

    static final AtomicReference<String> REFRESH_THREAD = new AtomicReference<>();
    static final AtomicReference<String> NIGHTLY_THREAD = new AtomicReference<>();
    static final AtomicReference<String> OTHER_THREAD = new AtomicReference<>();

    @Configuration
    @EnableScheduling
    static class Config {
    }

    /** Any other scheduled job of the application (no scheduler attribute). */
    public static class OtherJob {
        @Scheduled(fixedDelay = 50)
        public void tick() {
            OTHER_THREAD.compareAndSet(null, Thread.currentThread().getName());
        }
    }

    @Test
    @DisplayName("Refresh + nightly jobs run on leaderboard-scheduler-*; other @Scheduled jobs keep the broker scheduler")
    void jobsRunOnDedicatedThread() throws Exception {
        REFRESH_THREAD.set(null);
        NIGHTLY_THREAD.set(null);
        OTHER_THREAD.set(null);

        LeaderboardRefreshStateRepository state = Mockito.mock(LeaderboardRefreshStateRepository.class);
        Mockito.when(state.tryLock()).thenAnswer(i -> {
            REFRESH_THREAD.compareAndSet(null, Thread.currentThread().getName());
            return false; // SKIPPED: nothing else is touched
        });
        PlatformTransactionManager tm = Mockito.mock(PlatformTransactionManager.class);
        Mockito.when(tm.getTransaction(any())).thenReturn(new SimpleTransactionStatus());

        ProficiencyIngestService ingest = Mockito.mock(ProficiencyIngestService.class);
        Mockito.when(ingest.reconcileT1(any(Instant.class))).thenAnswer(i -> {
            NIGHTLY_THREAD.compareAndSet(null, Thread.currentThread().getName());
            return 0;
        });
        ProficiencyEvidenceRepository evidence = Mockito.mock(ProficiencyEvidenceRepository.class);
        Mockito.when(evidence.findUsersWithEvidenceSince(any())).thenReturn(List.of());

        try (AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext()) {
            ctx.getEnvironment().getPropertySources().addFirst(new MapPropertySource("test", Map.of(
                    "app.leaderboard.refresh.interval-ms", "50",
                    "app.leaderboard.refresh.initial-delay-ms", "0",
                    "app.proficiency.nightly.cron", "* * * * * *")));
            ctx.register(Config.class, LeaderboardSchedulerConfig.class);
            // stand-in for the STOMP broker scheduler (the only autowirable TaskScheduler, as in the app)
            ctx.registerBean("messageBrokerTaskScheduler", ThreadPoolTaskScheduler.class, () -> {
                ThreadPoolTaskScheduler s = new ThreadPoolTaskScheduler();
                s.setPoolSize(2);
                s.setThreadNamePrefix("MessageBroker-");
                return s;
            });
            ctx.registerBean(LeaderboardRefreshJob.class, () -> new LeaderboardRefreshJob(new LeaderboardRefreshProperties(), new LeaderboardProperties(),
                    new ActivityScoringProperties(), Mockito.mock(ActivityRollupService.class),
                    Mockito.mock(com.englishcoach.proficiency.board.ProficiencyBoardService.class), state, tm));
            ctx.registerBean(ProficiencyNightlyJob.class, () -> new ProficiencyNightlyJob(new ProficiencyProperties(),
                    ingest, Mockito.mock(ProficiencyService.class), evidence));
            ctx.registerBean(OtherJob.class);
            ctx.refresh();

            long deadline = System.currentTimeMillis() + 5_000;
            while ((REFRESH_THREAD.get() == null || NIGHTLY_THREAD.get() == null || OTHER_THREAD.get() == null)
                    && System.currentTimeMillis() < deadline) {
                Thread.sleep(25);
            }
        }

        System.out.println("[LeaderboardSchedulerTest] refresh thread = " + REFRESH_THREAD.get()
                + ", nightly thread = " + NIGHTLY_THREAD.get() + ", other job thread = " + OTHER_THREAD.get());
        assertNotNull(REFRESH_THREAD.get(), "refresh job never ran");
        assertNotNull(NIGHTLY_THREAD.get(), "nightly job never ran");
        assertTrue(REFRESH_THREAD.get().startsWith(LeaderboardSchedulerConfig.THREAD_PREFIX), REFRESH_THREAD.get());
        assertTrue(NIGHTLY_THREAD.get().startsWith(LeaderboardSchedulerConfig.THREAD_PREFIX), NIGHTLY_THREAD.get());
        assertEquals(REFRESH_THREAD.get(), NIGHTLY_THREAD.get(), "single thread shared by both jobs");
        assertNotNull(OTHER_THREAD.get(), "other job never ran");
        assertTrue(OTHER_THREAD.get().startsWith("MessageBroker-"),
                "default scheduler of other jobs must stay the broker scheduler: " + OTHER_THREAD.get());
    }

    @Test
    @DisplayName("STOMP broker scheduler configuration (WebSocketConfig) does not reference the leaderboard scheduler")
    void stompConfigUntouched() throws Exception {
        String ws = Files.readString(Path.of("src/main/java/com/englishcoach/flashcard/pvp/config/WebSocketConfig.java"));
        assertFalse(ws.contains("leaderboard"));
        assertTrue(ws.contains("taskScheduler.setPoolSize(2)"));
        assertTrue(ws.contains("setThreadNamePrefix(\"stomp-heartbeat-\")"));
    }
}
