package com.englishcoach.leaderboard.board;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/**
 * Dedicated single-thread scheduler for the leaderboard refresh and the Proficiency nightly job
 * (Phase 3.1). Both bind to it explicitly with {@code @Scheduled(scheduler = "leaderboardTaskScheduler")},
 * so a slow refresh never delays the other {@code @Scheduled} jobs or the STOMP broker scheduler.
 * <p>
 * {@code autowireCandidate = false}: the bean is reachable only by name. Spring resolves the default
 * scheduler of every other {@code @Scheduled} method by type; a second autowirable TaskScheduler would
 * change that default. The STOMP / WebSocket configuration ({@code WebSocketConfig}) is untouched.
 */
@Configuration
public class LeaderboardSchedulerConfig {

    /** Referenced as a string literal by {@code proficiency.ProficiencyNightlyJob} (no import into proficiency). */
    public static final String SCHEDULER_BEAN = "leaderboardTaskScheduler";

    public static final String THREAD_PREFIX = "leaderboard-scheduler-";

    @Bean(name = SCHEDULER_BEAN, autowireCandidate = false)
    public ThreadPoolTaskScheduler leaderboardTaskScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(1);
        scheduler.setThreadNamePrefix(THREAD_PREFIX);
        scheduler.setWaitForTasksToCompleteOnShutdown(false);
        return scheduler;
    }
}
