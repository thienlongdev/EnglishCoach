package com.englishcoach.leaderboard.activity;

import com.englishcoach.leaderboard.activity.event.FlashcardReviewedEvent;
import com.englishcoach.leaderboard.activity.event.PvpMatchFinishedEvent;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Testcontainers;

import javax.sql.DataSource;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * A failing leaderboard listener never breaks the source module: the source transaction
 * commits, no exception reaches the publisher, and rolled-back work is never scored.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringJUnitConfig(ActivityListenerIsolationTest.Config.class)
class ActivityListenerIsolationTest {

    @Configuration
    @EnableTransactionManagement
    @Import(ActivityEventListener.class)
    static class Config {
        @Bean DataSource dataSource() { return LeaderboardTestPostgres.dataSource(); }
        @Bean JdbcTemplate jdbcTemplate(DataSource ds) { return new JdbcTemplate(ds); }
        @Bean PlatformTransactionManager transactionManager(DataSource ds) { return new DataSourceTransactionManager(ds); }
        @Bean TransactionTemplate transactionTemplate(PlatformTransactionManager tm) { return new TransactionTemplate(tm); }
        @Bean ActivityScoringService failingScoringService() { return Mockito.mock(ActivityScoringService.class); }
    }

    @Autowired ActivityScoringService scoring;
    @Autowired ApplicationEventPublisher publisher;
    @Autowired TransactionTemplate tx;
    @Autowired JdbcTemplate jdbc;

    private final FlashcardReviewedEvent event = new FlashcardReviewedEvent(
            300L, 1L, 1, "good", "NEW", "LEARNED", 1L, "B1", null, Instant.parse("2026-10-01T03:00:00Z"));

    @BeforeEach
    void failEverything() {
        reset(scoring);
        when(scoring.onFlashcardReviewed(any())).thenThrow(new IllegalStateException("leaderboard DB down"));
        when(scoring.onPvpMatchFinished(any())).thenThrow(new OutOfMemoryError("simulated"));
    }

    @Test
    @DisplayName("Listener throws after commit ⇒ source row stays committed, publisher sees no exception")
    void failingListenerDoesNotBreakSourceTransaction() {
        Long before = jdbc.queryForObject("SELECT COUNT(*) FROM public.lb_test_source", Long.class);
        assertDoesNotThrow(() -> tx.executeWithoutResult(s -> {
            jdbc.update("INSERT INTO public.lb_test_source (note) VALUES ('source module write')");
            publisher.publishEvent(event);
        }));
        Long after = jdbc.queryForObject("SELECT COUNT(*) FROM public.lb_test_source", Long.class);
        assertEquals(before + 1, after, "source transaction committed");
        verify(scoring, times(1)).onFlashcardReviewed(event);
    }

    @Test
    @DisplayName("Rolled-back source transaction ⇒ listener never invoked")
    void rolledBackSourceIsNeverScored() {
        tx.executeWithoutResult(s -> {
            publisher.publishEvent(event);
            s.setRollbackOnly();
        });
        verify(scoring, never()).onFlashcardReviewed(any());
    }

    @Test
    @DisplayName("Non-transactional publisher (PvP / exam worker) ⇒ fallback execution, errors swallowed")
    void nonTransactionalPublisherIsSafe() {
        PvpMatchFinishedEvent pvp = new PvpMatchFinishedEvent(1L, "HUMAN", 1L, 2L, "1", "KO", 60_000L, true, 1, 1, null, Instant.now());
        assertDoesNotThrow(() -> publisher.publishEvent(pvp));
        assertDoesNotThrow(() -> publisher.publishEvent(event));
        verify(scoring, times(1)).onPvpMatchFinished(pvp);
        verify(scoring, times(1)).onFlashcardReviewed(event);
    }
}
