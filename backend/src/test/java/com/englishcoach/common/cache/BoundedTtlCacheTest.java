package com.englishcoach.common.cache;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** PERF-05: bounded, really expiring, single-flight. */
class BoundedTtlCacheTest {

    @Test
    void expiredEntriesAreRemovedNotOnlyIgnored() {
        AtomicLong now = new AtomicLong(1_000);
        BoundedTtlCache<String, String> cache = new BoundedTtlCache<>(10, 100, now::get);
        cache.put("a", "1");
        assertThat(cache.getIfPresent("a")).isEqualTo("1");
        now.addAndGet(100);
        assertThat(cache.getIfPresent("a")).isNull();
        assertThat(cache.size()).isZero();
    }

    @Test
    void neverHoldsMoreThanTheBoundAndEvictsTheLeastRecentlyUsed() {
        AtomicLong now = new AtomicLong(0);
        BoundedTtlCache<Integer, Integer> cache = new BoundedTtlCache<>(3, 10_000, now::get);
        cache.put(1, 1); cache.put(2, 2); cache.put(3, 3);
        cache.getIfPresent(1);          // 1 becomes most recently used
        cache.put(4, 4);                 // evicts 2
        assertThat(cache.size()).isEqualTo(3);
        assertThat(cache.getIfPresent(2)).isNull();
        assertThat(cache.getIfPresent(1)).isEqualTo(1);
        for (int i = 10; i < 1_000; i++) cache.put(i, i);
        assertThat(cache.size()).isEqualTo(3);
    }

    @Test
    void concurrentMissesOfOneKeyLoadOnce() throws Exception {
        BoundedTtlCache<String, Integer> cache = new BoundedTtlCache<>(10, 60_000);
        AtomicInteger loads = new AtomicInteger();
        CountDownLatch gate = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            Future<?>[] futures = new Future<?>[8];
            for (int i = 0; i < 8; i++) {
                futures[i] = pool.submit(() -> cache.get("k", k -> {
                    loads.incrementAndGet();
                    try { gate.await(2, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    return 42;
                }));
            }
            Thread.sleep(200);
            gate.countDown();
            for (Future<?> f : futures) assertThat(f.get(5, TimeUnit.SECONDS)).isEqualTo(42);
        } finally {
            pool.shutdownNow();
        }
        assertThat(loads.get()).isEqualTo(1);
    }

    @Test
    void aFailedLoadIsNotCachedAndReachesTheCaller() {
        BoundedTtlCache<String, Integer> cache = new BoundedTtlCache<>(10, 60_000);
        assertThatThrownBy(() -> cache.get("k", k -> { throw new IllegalStateException("boom"); })).hasMessage("boom");
        assertThat(cache.get("k", k -> 7)).isEqualTo(7);
    }

    @Test
    void invalidationByOwnerKeepsOtherOwners() {
        record Key(long owner, int days) {}
        BoundedTtlCache<Key, String> cache = new BoundedTtlCache<>(10, 60_000);
        cache.put(new Key(1, 7), "a"); cache.put(new Key(1, 365), "b"); cache.put(new Key(2, 7), "c");
        cache.invalidateIf(k -> k.owner() == 1);
        assertThat(cache.getIfPresent(new Key(1, 7))).isNull();
        assertThat(cache.getIfPresent(new Key(2, 7))).isEqualTo("c");
    }

    @Test
    void negativeCachingUsesShortTtlAndRecordsHitsAndMisses() {
        AtomicLong now = new AtomicLong(1_000);
        BoundedTtlCache<String, String> cache = new BoundedTtlCache<>(10, 10_000, 500, now::get);
        AtomicInteger loads = new AtomicInteger();

        assertThat(cache.getOrNull("missing", k -> {
            loads.incrementAndGet();
            return null;
        })).isNull();
        assertThat(loads.get()).isEqualTo(1);
        assertThat(cache.misses()).isEqualTo(1);

        // Cached negative sentinel prevents re-hitting loader before negative TTL expires
        assertThat(cache.getOrNull("missing", k -> {
            loads.incrementAndGet();
            return "late";
        })).isNull();
        assertThat(loads.get()).isEqualTo(1);
        assertThat(cache.hits()).isEqualTo(1);

        // Expires after negativeTtlMillis (500ms), well before positive ttlMillis (10_000ms)
        now.addAndGet(500);
        assertThat(cache.getOrNull("missing", k -> {
            loads.incrementAndGet();
            return "found";
        })).isEqualTo("found");
        assertThat(loads.get()).isEqualTo(2);
        assertThat(cache.evictions()).isGreaterThanOrEqualTo(1);
    }

    @Test
    void opportunisticPruningRemovesExpiredEntriesOnSubsequentPut() {
        AtomicLong now = new AtomicLong(1_000);
        BoundedTtlCache<String, String> cache = new BoundedTtlCache<>(100, 100, 0, now::get);
        cache.put("old1", "v1");
        cache.put("old2", "v2");
        assertThat(cache.size()).isEqualTo(2);

        now.addAndGet(100);
        cache.put("fresh", "v3");
        assertThat(cache.size()).isEqualTo(1);
        assertThat(cache.getIfPresent("fresh")).isEqualTo("v3");
        assertThat(cache.evictions()).isEqualTo(2);
    }

    @Test
    void springCacheManagerEnforcesBoundsExpiryAndSingleFlight() {
        AtomicLong now = new AtomicLong(5_000);
        BoundedTtlCacheManager manager = new BoundedTtlCacheManager(
                java.util.Map.of("feed", BoundedTtlCacheManager.CacheSpec.of(2, java.time.Duration.ofSeconds(10), java.time.Duration.ofSeconds(2))),
                now::get
        );
        org.springframework.cache.Cache feed = manager.getCache("feed");
        assertThat(feed).isNotNull();
        assertThat(manager.getCache("unknown")).isNull();

        feed.put("a", "alpha");
        feed.put("b", "beta");
        feed.put("c", "gamma"); // evicts "a"
        assertThat(feed.get("a")).isNull();
        assertThat(feed.get("b", String.class)).isEqualTo("beta");

        feed.put("nil", null);
        assertThat(feed.get("nil")).isNotNull();
        assertThat(feed.get("nil").get()).isNull();

        now.addAndGet(2_000);
        assertThat(feed.get("nil")).isNull();
    }
}
