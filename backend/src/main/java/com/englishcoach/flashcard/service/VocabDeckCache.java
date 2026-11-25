package com.englishcoach.flashcard.service;

import com.englishcoach.common.cache.BoundedTtlCache;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * Split Two-Tier In-Memory Cache for Vocabulary Decks:
 * <ol>
 *   <li>A single shared immutable {@link SystemDeckCatalog} snapshot (15-minute TTL, single-flight loaded) containing
 *       ONLY {@code isSystem = true} decks and grouped {@code deck_dictionary_entries} counts, with zero per-user stats.</li>
 *   <li>A compact per-user {@link UserProgressOverlay} cache (hard bound {@value #MAX_USERS} users, 10-minute TTL)
 *       storing only numeric counters for decks the learner actually has cards in — never duplicating 294
 *       {@code VocabDeckSummaryResponse} DTOs per account.</li>
 * </ol>
 * Fresh {@code VocabDeckSummaryResponse} DTOs are composed per request with visibility flags applied at read time.
 */
@Slf4j
@Component
public class VocabDeckCache {

    public static final long TTL_MILLIS = 10 * 60 * 1000L; // 10 minutes per-user progress overlay
    public static final long CATALOG_TTL_MILLIS = 15 * 60 * 1000L; // 15 minutes shared SYSTEM catalog
    public static final int MAX_USERS = 2048;

    private static final String SYSTEM_CATALOG_KEY = "system-decks";

    public record SystemDeckEntry(
            Long id,
            String slug,
            String title,
            String description,
            String category,
            String themeColor,
            String icon,
            int totalWords,
            boolean isSystem,
            int sortOrder
    ) {}

    public record SystemDeckCatalog(List<SystemDeckEntry> decks) {
        public SystemDeckCatalog {
            decks = decks == null ? List.of() : List.copyOf(decks);
        }
    }

    public record UserDeckProgress(
            long totalCards,
            long masteredCount,
            long reviewedCount,
            long learningCount,
            long dueCount
    ) {
        public static final UserDeckProgress EMPTY = new UserDeckProgress(0L, 0L, 0L, 0L, 0L);
    }

    public record UserProgressOverlay(
            UserDeckProgress personal,
            Map<Long, UserDeckProgress> byDeckId
    ) {
        public UserProgressOverlay {
            personal = personal != null ? personal : UserDeckProgress.EMPTY;
            byDeckId = (byDeckId == null || byDeckId.isEmpty()) ? Map.of() : Map.copyOf(byDeckId);
        }

        public static final UserProgressOverlay EMPTY = new UserProgressOverlay(UserDeckProgress.EMPTY, Map.of());
    }

    private final BoundedTtlCache<String, SystemDeckCatalog> systemCatalogCache;
    private final BoundedTtlCache<Long, UserProgressOverlay> userProgressCache;

    public VocabDeckCache() {
        this(System::currentTimeMillis);
    }

    VocabDeckCache(LongSupplier clock) {
        this.systemCatalogCache = new BoundedTtlCache<>(1, CATALOG_TTL_MILLIS, 0L, clock);
        this.userProgressCache = new BoundedTtlCache<>(MAX_USERS, TTL_MILLIS, 0L, clock);
    }

    public SystemDeckCatalog getSystemCatalog() {
        return systemCatalogCache.getIfPresent(SYSTEM_CATALOG_KEY);
    }

    public SystemDeckCatalog getOrLoadSystemCatalog(Supplier<SystemDeckCatalog> loader) {
        if (loader == null) {
            return getSystemCatalog();
        }
        return systemCatalogCache.get(SYSTEM_CATALOG_KEY, ignored -> loader.get());
    }

    public void putSystemCatalog(SystemDeckCatalog catalog) {
        if (catalog == null) {
            return;
        }
        systemCatalogCache.put(SYSTEM_CATALOG_KEY, catalog);
    }

    public void evictSystemCatalog() {
        systemCatalogCache.clear();
        log.debug("Evicted shared SYSTEM vocab deck catalog snapshot");
    }

    public UserProgressOverlay getUserProgress(Long userId) {
        if (userId == null) {
            return null;
        }
        return userProgressCache.getIfPresent(userId);
    }

    public void putUserProgress(Long userId, UserProgressOverlay overlay) {
        if (userId == null || overlay == null) {
            return;
        }
        userProgressCache.put(userId, overlay);
    }

    public UserProgressOverlay getOrLoadUserProgress(Long userId, Function<Long, UserProgressOverlay> loader) {
        if (userId == null) {
            return UserProgressOverlay.EMPTY;
        }
        if (loader == null) {
            return getUserProgress(userId);
        }
        return userProgressCache.get(userId, loader);
    }

    public void evict(Long userId) {
        if (userId == null) {
            return;
        }
        userProgressCache.invalidate(userId);
        log.debug("Evicted vocab deck progress overlay for userId: {}", userId);
    }

    public void evictAll() {
        userProgressCache.clear();
        systemCatalogCache.clear();
        log.debug("Evicted all vocab deck caches (user overlays + shared SYSTEM catalog)");
    }

    public int size() {
        return userProgressCache.size();
    }
}
