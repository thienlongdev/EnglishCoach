package com.englishcoach.common.scheduling;

import lombok.extern.slf4j.Slf4j;

import java.util.concurrent.RejectedExecutionHandler;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicLong;

/**
 * {@link ThreadPoolExecutor.CallerRunsPolicy} that says so (performance release 2026-11-16, PERF-23): when an event
 * executor's queue is full the task still runs on the publishing thread (nothing accepted is ever dropped), and a warning
 * with the queue depth and the number of such runs is logged at most once a minute. Use it to see a saturated scoring
 * queue instead of only feeling slower requests.
 */
@Slf4j
public final class ObservedCallerRunsPolicy implements RejectedExecutionHandler {

    private static final long LOG_EVERY_MS = 60_000L;

    private final String name;
    private final ThreadPoolExecutor.CallerRunsPolicy delegate = new ThreadPoolExecutor.CallerRunsPolicy();
    private final AtomicLong callerRuns = new AtomicLong();
    private final AtomicLong lastLog = new AtomicLong();

    public ObservedCallerRunsPolicy(String name) {
        this.name = name;
    }

    @Override
    public void rejectedExecution(Runnable task, ThreadPoolExecutor executor) {
        long runs = callerRuns.incrementAndGet();
        long now = System.currentTimeMillis();
        long last = lastLog.get();
        if (now - last >= LOG_EVERY_MS && lastLog.compareAndSet(last, now)) {
            log.warn("[Executor] {} saturated: queue {} / active {} — task runs on the caller thread ({} time(s) since start)",
                    name, executor.getQueue().size(), executor.getActiveCount(), runs);
        }
        delegate.rejectedExecution(task, executor);
    }

    public long callerRuns() {
        return callerRuns.get();
    }
}
