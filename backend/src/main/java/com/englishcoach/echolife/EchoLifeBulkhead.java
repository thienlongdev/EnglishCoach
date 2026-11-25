package com.englishcoach.echolife;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

/**
 * Concurrency bulkhead protecting the shared PostgreSQL connection pool (28 connections against remote Azure PG) from
 * Echo Life save/economy bursts so core English Coach modules (Auth, Reading, Listening, Flashcards, Exams) always keep
 * dedicated DB capacity. Mirrors Echo Garden's proven bulkhead pattern (10-rules §Q).
 */
@Component
public class EchoLifeBulkhead {

    public record Stats(int maxConcurrent, int inFlight, long accepted, long rejected) {}

    private final int maxConcurrent;
    private final long busyWaitMs;
    private final Semaphore permits;
    private final AtomicLong accepted = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();

    public EchoLifeBulkhead(
            @Value("${app.echo-life.max-concurrent-db-ops:10}") int maxConcurrent,
            @Value("${app.echo-life.busy-wait-ms:2500}") long busyWaitMs) {
        this.maxConcurrent = Math.max(0, maxConcurrent);
        this.busyWaitMs = Math.max(100L, busyWaitMs);
        this.permits = this.maxConcurrent > 0 ? new Semaphore(this.maxConcurrent, true) : null;
    }

    /** Unbounded instance for standalone controller unit tests. */
    static EchoLifeBulkhead unbounded() {
        return new EchoLifeBulkhead(0, 1000L);
    }

    public <T> T execute(Supplier<T> work) {
        if (permits == null) {
            accepted.incrementAndGet();
            return work.get();
        }
        boolean acquired;
        try {
            acquired = permits.tryAcquire(busyWaitMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            rejected.incrementAndGet();
            throw new EchoLifeException(503, "ECHO_LIFE_BUSY");
        }
        if (!acquired) {
            rejected.incrementAndGet();
            throw new EchoLifeException(503, "ECHO_LIFE_BUSY");
        }
        accepted.incrementAndGet();
        try {
            return work.get();
        } finally {
            permits.release();
        }
    }

    public Stats stats() {
        int inFlight = permits == null ? 0 : Math.max(0, maxConcurrent - permits.availablePermits());
        return new Stats(maxConcurrent, inFlight, accepted.get(), rejected.get());
    }
}
