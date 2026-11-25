package com.englishcoach.progress.service;

import com.englishcoach.progress.config.LearningProgressProperties;
import com.englishcoach.progress.dto.HeatmapDayDto;
import com.englishcoach.progress.dto.HeatmapResponseDto;
import com.englishcoach.progress.dto.UnifiedStreakDto;
import com.englishcoach.progress.repository.UnifiedProgressRepository;
import com.englishcoach.user.entity.UserProfile;
import com.englishcoach.user.repository.UserProfileRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import com.englishcoach.common.cache.BoundedTtlCache;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;

@Service
@RequiredArgsConstructor
@Slf4j
public class UnifiedProgressService {

    private final UnifiedProgressRepository unifiedProgressRepository;
    private final UserProfileRepository userProfileRepository;
    private final LearningProgressProperties properties;
    private final PlatformTransactionManager transactionManager;

    private static final int DEFAULT_HEATMAP_DAYS = 365;
    private static final int MIN_HEATMAP_DAYS = 7;
    private static final int MAX_HEATMAP_DAYS = 730;

    /** Heatmap key: owner + the CLAMPED window, so equivalent requests share one entry. */
    private record HeatmapKey(long userId, int windowDays) {}

    // Owner-scoped, bounded and really expiring (performance release 2026-11-16, PERF-05): an expired entry is dropped,
    // at most CACHE_MAX_ENTRIES accounts are kept, and concurrent misses of one key load once.
    private static final long CACHE_TTL_MS = 60_000L;
    private static final int CACHE_MAX_ENTRIES = 2_000;
    private final BoundedTtlCache<Long, UnifiedStreakDto> streakCache = new BoundedTtlCache<>(CACHE_MAX_ENTRIES, CACHE_TTL_MS);
    private final BoundedTtlCache<HeatmapKey, HeatmapResponseDto> heatmapCache = new BoundedTtlCache<>(CACHE_MAX_ENTRIES, CACHE_TTL_MS);

    public void invalidateCache(Long userId) {
        if (userId != null) {
            long id = userId;
            streakCache.invalidate(userId);
            heatmapCache.invalidateIf(k -> k.userId() == id);
        } else {
            streakCache.clear();
            heatmapCache.clear();
        }
    }

    /**
     * The cache is consulted OUTSIDE any transaction: a read-only transaction checks a pooled connection out (and may
     * validate it over the network) even when nothing is read. Only a miss opens one.
     */
    private <T> T readOnly(java.util.function.Supplier<T> work) {
        if (transactionManager == null) return work.get(); // a service built by hand in a unit test
        TransactionTemplate tx = new TransactionTemplate(transactionManager);
        tx.setReadOnly(true);
        return tx.execute(status -> work.get());
    }

    public UnifiedStreakDto getStreak(Long userId) {
        if (userId == null) {
            return new UnifiedStreakDto(0, 0, false);
        }
        return streakCache.get(userId, id -> readOnly(() -> computeStreak(id)));
    }

    private UnifiedStreakDto computeStreak(Long userId) {
        ZoneId zoneId = properties.getZoneId();
        LocalDate today = LocalDate.now(zoneId);

        List<LocalDate> activeDates = unifiedProgressRepository.getActiveDates(userId, properties.getTimeZone());
        Set<LocalDate> dateSet = new HashSet<>(activeDates);

        int currentStreak = calculateCurrentStreak(dateSet, today);
        int longestStreak = calculateLongestStreak(activeDates);
        boolean activeToday = dateSet.contains(today);

        UnifiedStreakDto result = UnifiedStreakDto.builder()
                .currentStreakDays(currentStreak)
                .longestStreakDays(longestStreak)
                .activeToday(activeToday)
                .build();
        return result;
    }

    public HeatmapResponseDto getHeatmap(Long userId, Integer requestedDays) {
        if (userId == null) {
            return HeatmapResponseDto.builder()
                    .currentStreakDays(0)
                    .longestStreakDays(0)
                    .activeDaysThisYear(0)
                    .activitiesThisMonth(0)
                    .theme("purple")
                    .days(Collections.emptyList())
                    .build();
        }

        int windowDays = DEFAULT_HEATMAP_DAYS;
        if (requestedDays != null) {
            windowDays = Math.max(MIN_HEATMAP_DAYS, Math.min(requestedDays, MAX_HEATMAP_DAYS));
        }
        return heatmapCache.get(new HeatmapKey(userId, windowDays), k -> readOnly(() -> computeHeatmap(k.userId(), k.windowDays())));
    }

    private HeatmapResponseDto computeHeatmap(Long userId, int windowDays) {
        ZoneId zoneId = properties.getZoneId();
        LocalDate today = LocalDate.now(zoneId);

        LocalDate startDate = today.minusDays(windowDays - 1);
        LocalDate endDate = today;

        // 1. Fetch daily activity counts within the bounded window
        Map<LocalDate, Integer> dailyCounts = unifiedProgressRepository.getDailyActivityCounts(
                userId, properties.getTimeZone(), startDate, endDate
        );

        // 2. Fetch all active dates for streak and year stats
        List<LocalDate> allActiveDates = unifiedProgressRepository.getActiveDates(userId, properties.getTimeZone());
        Set<LocalDate> allDateSet = new HashSet<>(allActiveDates);

        int currentStreak = calculateCurrentStreak(allDateSet, today);
        int longestStreak = calculateLongestStreak(allActiveDates);

        // 3. activeDaysThisYear: distinct active calendar dates in current calendar year
        int activeDaysThisYear = (int) allActiveDates.stream()
                .filter(d -> d.getYear() == today.getYear())
                .distinct()
                .count();

        // 4. activitiesThisMonth: sum of canonical activity counts in current calendar month
        // Since windowDays >= 7 and default is 365, query dailyCounts for current month
        int activitiesThisMonth = dailyCounts.entrySet().stream()
                .filter(e -> e.getKey().getYear() == today.getYear() && e.getKey().getMonth() == today.getMonth())
                .mapToInt(Map.Entry::getValue)
                .sum();

        // 5. Generate deterministic grid from startDate through today
        List<HeatmapDayDto> dayList = new ArrayList<>(windowDays);
        LocalDate cursor = startDate;
        while (!cursor.isAfter(endDate)) {
            int count = dailyCounts.getOrDefault(cursor, 0);
            int intensity = calculateIntensity(count);
            dayList.add(new HeatmapDayDto(cursor, count, intensity));
            cursor = cursor.plusDays(1);
        }

        // 6. User theme preference
        String theme = "purple";
        try {
            UserProfile profile = userProfileRepository.findById(userId).orElse(null);
            if (profile != null && profile.getHeatmapTheme() != null && !profile.getHeatmapTheme().isBlank()) {
                theme = profile.getHeatmapTheme().toLowerCase();
            }
        } catch (Exception ex) {
            log.warn("Failed to load user profile theme for user {}: {}", userId, ex.getMessage());
        }

        HeatmapResponseDto result = HeatmapResponseDto.builder()
                .currentStreakDays(currentStreak)
                .longestStreakDays(longestStreak)
                .activeDaysThisYear(activeDaysThisYear)
                .activitiesThisMonth(activitiesThisMonth)
                .theme(theme)
                .days(dayList)
                .build();

        // Also update streakCache so getStreak is pre-warmed
        streakCache.put(userId, UnifiedStreakDto.builder()
                .currentStreakDays(currentStreak)
                .longestStreakDays(longestStreak)
                .activeToday(allDateSet.contains(today))
                .build());

        return result;
    }

    public static int calculateCurrentStreak(Set<LocalDate> activeDateSet, LocalDate today) {
        if (activeDateSet == null || activeDateSet.isEmpty()) {
            return 0;
        }
        LocalDate yesterday = today.minusDays(1);
        LocalDate checkDate;
        if (activeDateSet.contains(today)) {
            checkDate = today;
        } else if (activeDateSet.contains(yesterday)) {
            checkDate = yesterday;
        } else {
            return 0;
        }

        int streak = 0;
        while (activeDateSet.contains(checkDate)) {
            streak++;
            checkDate = checkDate.minusDays(1);
        }
        return streak;
    }

    public static int calculateLongestStreak(Collection<LocalDate> activeDates) {
        if (activeDates == null || activeDates.isEmpty()) {
            return 0;
        }
        List<LocalDate> sorted = activeDates.stream().distinct().sorted().toList();
        int maxStreak = 0;
        int currentRun = 0;
        LocalDate prev = null;
        for (LocalDate d : sorted) {
            if (prev == null) {
                currentRun = 1;
            } else if (d.equals(prev.plusDays(1))) {
                currentRun++;
            } else {
                currentRun = 1;
            }
            if (currentRun > maxStreak) {
                maxStreak = currentRun;
            }
            prev = d;
        }
        return maxStreak;
    }

    public static int calculateIntensity(int count) {
        if (count <= 0) return 0;
        if (count == 1) return 1;
        if (count <= 3) return 2;
        if (count <= 7) return 3;
        return 4;
    }
}
