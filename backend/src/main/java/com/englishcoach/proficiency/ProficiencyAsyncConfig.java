package com.englishcoach.proficiency;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;
import java.util.concurrent.ThreadPoolExecutor;

/**
 * Proficiency's own in-memory executor (no reuse of the Activity executor). Events in flight
 * during a restart are lost: T1 losses are repaired by the nightly reconciliation; T3 losses are
 * accepted (Proficiency Spec §9).
 */
@Configuration
@EnableAsync
public class ProficiencyAsyncConfig {

    public static final String EXECUTOR = "proficiencyExecutor";

    @Bean(name = EXECUTOR)
    public Executor proficiencyExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(1);
        executor.setMaxPoolSize(2);
        executor.setQueueCapacity(1000);
        executor.setThreadNamePrefix("proficiency-");
        executor.setRejectedExecutionHandler(new com.englishcoach.common.scheduling.ObservedCallerRunsPolicy(EXECUTOR));
        executor.initialize();
        return executor;
    }
}
