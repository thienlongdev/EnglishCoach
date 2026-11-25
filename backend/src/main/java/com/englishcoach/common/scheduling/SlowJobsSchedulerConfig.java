package com.englishcoach.common.scheduling;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/**
 * Dedicated scheduler for the scheduled jobs that may run for seconds or minutes: exam scoring (an AI judge call can
 * wait up to its timeout) and the RSS refresh (remote feeds). Performance release 2026-11-16, PERF-10.
 * <p>
 * Every other {@code @Scheduled} method shares Spring's default single-thread scheduler, among them the Card Blast PvP
 * game tick, the payment webhook sweep and order expiry: one slow scoring job used to delay all of them. Each job keeps
 * its own fixed delay / cron and never overlaps itself; exam scoring stays one job at a time with its database leases.
 * <p>
 * {@code autowireCandidate = false} (same pattern as {@code LeaderboardSchedulerConfig}): reachable only by name, so the
 * default scheduler that every other {@code @Scheduled} method resolves by type is unchanged.
 */
@Configuration
public class SlowJobsSchedulerConfig {

    public static final String SCHEDULER_BEAN = "slowJobsTaskScheduler";

    @Bean(name = SCHEDULER_BEAN, autowireCandidate = false)
    public ThreadPoolTaskScheduler slowJobsTaskScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(2);
        scheduler.setThreadNamePrefix("slow-jobs-");
        scheduler.setWaitForTasksToCompleteOnShutdown(false);
        return scheduler;
    }
}
