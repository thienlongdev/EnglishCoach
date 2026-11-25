package com.englishcoach.leaderboard.activity;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;
import java.util.concurrent.ThreadPoolExecutor;

/**
 * Dedicated in-memory executor for Activity scoring. Events in flight during a restart are lost
 * (acceptable for Activity; see features/leaderboard.md "Notes for Phase 2").
 * When the queue is full the task runs on the caller thread (the listener still swallows errors).
 */
@Configuration
@EnableAsync
public class LeaderboardActivityAsyncConfig {

    public static final String EXECUTOR = "leaderboardActivityExecutor";

    @Bean(name = EXECUTOR)
    public Executor leaderboardActivityExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(1);
        executor.setMaxPoolSize(4);
        executor.setQueueCapacity(1000);
        executor.setThreadNamePrefix("leaderboard-activity-");
        executor.setRejectedExecutionHandler(new com.englishcoach.common.scheduling.ObservedCallerRunsPolicy(EXECUTOR));
        executor.initialize();
        return executor;
    }
}
