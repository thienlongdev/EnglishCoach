package com.englishcoach.exams.config;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import lombok.Getter;
import org.springframework.stereotype.Component;

/**
 * STEP-111: Assessment operational and performance metrics.
 * Follows invariant: Candidate answers, transcripts, and credentials are strictly excluded from labels/tags.
 */
@Getter
@Component
public class ExamMetrics {

    private final Counter attemptsCreatedCounter;
    private final Counter attemptsStartedCounter;
    private final Counter attemptsSubmittedCounter;
    private final Counter scoringJobsCompletedCounter;
    private final Counter scoringJobsFailedCounter;
    private final Counter reviewRequiredCounter;
    private final Timer scoringLatencyTimer;
    private final Timer responseSaveLatencyTimer;

    public ExamMetrics(MeterRegistry registry) {
        this.attemptsCreatedCounter = Counter.builder("exams.attempts.created")
                .description("Total number of exam attempts created")
                .register(registry);

        this.attemptsStartedCounter = Counter.builder("exams.attempts.started")
                .description("Total number of exam attempts started")
                .register(registry);

        this.attemptsSubmittedCounter = Counter.builder("exams.attempts.submitted")
                .description("Total number of exam attempts submitted")
                .register(registry);

        this.scoringJobsCompletedCounter = Counter.builder("exams.scoring.jobs.completed")
                .description("Total number of durable scoring jobs completed")
                .register(registry);

        this.scoringJobsFailedCounter = Counter.builder("exams.scoring.jobs.failed")
                .description("Total number of durable scoring jobs failed")
                .register(registry);

        this.reviewRequiredCounter = Counter.builder("exams.scoring.review.required")
                .description("Total number of scoring cases queued for human review")
                .register(registry);

        this.scoringLatencyTimer = Timer.builder("exams.scoring.latency")
                .description("Duration of end-to-end exam scoring execution")
                .register(registry);

        this.responseSaveLatencyTimer = Timer.builder("exams.responses.save.latency")
                .description("Latency of batched student response saves")
                .register(registry);
    }
}
