package com.englishcoach.premium.interceptor;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;

/**
 * Upper bound on AI requests ({@code @RequirePremiumAi} endpoints) in progress at the same time (capacity release
 * 2026-10). Such a request waits seconds to minutes for the AI worker on the GPU PC or the model provider, and for that
 * whole time it holds one of the server's request threads (server.tomcat.threads.max, 128). Without a bound, a slow or
 * stalled AI worker plus a burst of AI clicks could occupy every thread and stop the whole site; with it, at most
 * {@code max} threads wait on AI work and every other screen keeps its share. (The capacity test showed that the pooled
 * database connection is NOT held during the AI call: 40 slow AI calls left ordinary reads unaffected.) A request that
 * cannot enter within {@code waitMs} is answered at once with 503 AI_BUSY: no quota is reserved, nothing is charged.
 * The worker serves only a few jobs at a time, so admitting more requests would only make each of them slower.
 */
@Component
public class AiRequestBulkhead {

    private final Semaphore permits;
    private final int max;
    private final long waitMs;

    public AiRequestBulkhead(@Value("${app.ai.max-concurrent-requests:24}") int max,
                             @Value("${app.ai.bulkhead-wait-ms:2000}") long waitMs) {
        this.max = Math.max(1, max);
        this.waitMs = Math.max(0, waitMs);
        this.permits = new Semaphore(this.max, true);
    }

    /** True when the caller may start its AI request; it must then call {@link #leave()} exactly once. */
    public boolean tryEnter() {
        try {
            return permits.tryAcquire(waitMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    public void leave() {
        permits.release();
    }

    public int max() {
        return max;
    }

    public int inUse() {
        return max - permits.availablePermits();
    }
}
