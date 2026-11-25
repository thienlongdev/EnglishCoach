package com.englishcoach.flashcard.service;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class VocabDeckCacheBoundTest {

    @Test
    void accountIsolationSharedCatalogAndInvalidationPreserveWarmCatalogs() {
        var cache = new VocabDeckCache();
        var sharedEntry = new VocabDeckCache.SystemDeckEntry(
                1L, "oxford-3000", "Oxford 3000", "Core", "OXFORD", "blue", "book", 3000, true, 1);
        var catalog = new VocabDeckCache.SystemDeckCatalog(List.of(sharedEntry));
        AtomicInteger catalogLoads = new AtomicInteger();
        assertThat(cache.getOrLoadSystemCatalog(() -> {
            catalogLoads.incrementAndGet();
            return catalog;
        })).isSameAs(catalog);
        assertThat(cache.getOrLoadSystemCatalog(() -> {
            catalogLoads.incrementAndGet();
            return new VocabDeckCache.SystemDeckCatalog(List.of());
        })).isSameAs(catalog);
        assertThat(catalogLoads.get()).isEqualTo(1);
        assertThatThrownBy(() -> cache.getSystemCatalog().decks().add(sharedEntry))
                .isInstanceOf(UnsupportedOperationException.class);

        var p10 = new VocabDeckCache.UserDeckProgress(10, 7, 8, 3, 2);
        var p20 = new VocabDeckCache.UserDeckProgress(5, 3, 4, 2, 1);
        var mutableMap = new HashMap<Long, VocabDeckCache.UserDeckProgress>();
        mutableMap.put(1L, p10);
        cache.putUserProgress(10L, new VocabDeckCache.UserProgressOverlay(VocabDeckCache.UserDeckProgress.EMPTY, mutableMap));
        cache.putUserProgress(20L, new VocabDeckCache.UserProgressOverlay(VocabDeckCache.UserDeckProgress.EMPTY, Map.of(2L, p20)));
        mutableMap.clear();

        assertThat(cache.getUserProgress(10L).byDeckId()).containsEntry(1L, p10);
        assertThat(cache.getUserProgress(20L).byDeckId()).containsEntry(2L, p20);
        assertThatThrownBy(() -> cache.getUserProgress(10L).byDeckId().put(99L, p10))
                .isInstanceOf(UnsupportedOperationException.class);

        cache.evict(10L);
        assertThat(cache.getUserProgress(10L)).isNull();
        assertThat(cache.getUserProgress(20L).byDeckId()).containsEntry(2L, p20);
        // Per-user eviction must NOT drop the shared SYSTEM catalog
        assertThat(cache.getSystemCatalog()).isSameAs(catalog);

        cache.putUserProgress(null, VocabDeckCache.UserProgressOverlay.EMPTY);
        cache.putUserProgress(30L, null);
        assertThat(cache.getUserProgress(null)).isNull();
        assertThat(cache.getUserProgress(30L)).isNull();
    }

    @Test
    void expiredEntriesAreReclaimedBeforeEvictingLiveAccountAtCapacity() {
        AtomicLong clock = new AtomicLong(10_000L);
        var cache = new VocabDeckCache(clock::get);

        // Put user 0 at t=10_000, user 1 at t=10_000, rest at t=10_500 so 0 and 1 expire first
        cache.putUserProgress(0L, VocabDeckCache.UserProgressOverlay.EMPTY);
        cache.putUserProgress(1L, VocabDeckCache.UserProgressOverlay.EMPTY);
        clock.addAndGet(500L);
        for (long user = 2; user < VocabDeckCache.MAX_USERS; user++) {
            cache.putUserProgress(user, VocabDeckCache.UserProgressOverlay.EMPTY);
        }
        assertThat(cache.size()).isEqualTo(VocabDeckCache.MAX_USERS);

        // Advance past user 0 & 1 TTL (10_000 + TTL_MILLIS), while users 2..MAX_USERS-1 are still live
        clock.set(10_000L + VocabDeckCache.TTL_MILLIS);
        cache.putUserProgress((long) VocabDeckCache.MAX_USERS, VocabDeckCache.UserProgressOverlay.EMPTY);

        assertThat(cache.getUserProgress(0L)).isNull();
        assertThat(cache.getUserProgress(1L)).isNull();
        assertThat(cache.getUserProgress(2L)).isNotNull();
        assertThat(cache.getUserProgress((long) VocabDeckCache.MAX_USERS)).isNotNull();
        assertThat(cache.size()).isEqualTo(VocabDeckCache.MAX_USERS - 1);
    }

    @Test
    void retainsRecentlyReadAccountAndStrictCapacityUnderConcurrentWrites() throws Exception {
        VocabDeckCache cache = new VocabDeckCache();
        for (long i = 0; i < VocabDeckCache.MAX_USERS; i++) {
            cache.putUserProgress(i, VocabDeckCache.UserProgressOverlay.EMPTY);
        }
        assertThat(cache.getUserProgress(0L)).isNotNull();
        cache.putUserProgress((long) VocabDeckCache.MAX_USERS, VocabDeckCache.UserProgressOverlay.EMPTY);
        assertThat(cache.getUserProgress(0L)).isNotNull();
        assertThat(cache.getUserProgress(1L)).isNull();

        try (ExecutorService workers = Executors.newFixedThreadPool(8)) {
            var writes = new java.util.ArrayList<Future<?>>();
            for (long i = 10000; i < 11000; i++) {
                long user = i;
                writes.add(workers.submit(() -> cache.putUserProgress(user, VocabDeckCache.UserProgressOverlay.EMPTY)));
            }
            for (var write : writes) {
                write.get(10, TimeUnit.SECONDS);
            }
        }
        assertThat(cache.size()).isEqualTo(VocabDeckCache.MAX_USERS);
        cache.evict(10999L);
        assertThat(cache.getUserProgress(10999L)).isNull();
        cache.evictAll();
        assertThat(cache.size()).isZero();
        assertThat(cache.getSystemCatalog()).isNull();
    }
}
