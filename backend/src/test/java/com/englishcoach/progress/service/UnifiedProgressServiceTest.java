package com.englishcoach.progress.service;

import com.englishcoach.progress.config.LearningProgressProperties;
import com.englishcoach.progress.dto.HeatmapDayDto;
import com.englishcoach.progress.dto.HeatmapResponseDto;
import com.englishcoach.progress.dto.UnifiedStreakDto;
import com.englishcoach.progress.repository.UnifiedProgressRepository;
import com.englishcoach.user.entity.UserProfile;
import com.englishcoach.user.repository.UserProfileRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class UnifiedProgressServiceTest {

    @Mock
    private UnifiedProgressRepository unifiedProgressRepository;

    @Mock
    private UserProfileRepository userProfileRepository;

    @Mock
    private LearningProgressProperties properties;

    @InjectMocks
    private UnifiedProgressService unifiedProgressService;

    private final ZoneId vnZone = ZoneId.of("Asia/Ho_Chi_Minh");
    private final Long userId = 1L;

    @BeforeEach
    void setUp() {
        org.mockito.Mockito.lenient().when(properties.getZoneId()).thenReturn(vnZone);
        org.mockito.Mockito.lenient().when(properties.getTimeZone()).thenReturn("Asia/Ho_Chi_Minh");
    }

    // --- STREAK TESTS (Criteria 15 - 21) ---

    @Test
    @DisplayName("Criteria 21: No activity -> streak 0, longest 0, activeToday false")
    void testNoActivity_ReturnsZero() {
        when(unifiedProgressRepository.getActiveDates(eq(userId), anyString()))
                .thenReturn(Collections.emptyList());

        UnifiedStreakDto streak = unifiedProgressService.getStreak(userId);

        assertThat(streak.currentStreakDays()).isZero();
        assertThat(streak.longestStreakDays()).isZero();
        assertThat(streak.activeToday()).isFalse();
    }

    @Test
    @DisplayName("Criteria 15: Today only -> streak 1, longest 1, activeToday true")
    void testTodayOnly_ReturnsStreak1() {
        LocalDate today = LocalDate.now(vnZone);
        when(unifiedProgressRepository.getActiveDates(eq(userId), anyString()))
                .thenReturn(List.of(today));

        UnifiedStreakDto streak = unifiedProgressService.getStreak(userId);

        assertThat(streak.currentStreakDays()).isEqualTo(1);
        assertThat(streak.longestStreakDays()).isEqualTo(1);
        assertThat(streak.activeToday()).isTrue();
    }

    @Test
    @DisplayName("Criteria 16: Yesterday only -> streak 1, longest 1, activeToday false")
    void testYesterdayOnly_ReturnsStreak1() {
        LocalDate today = LocalDate.now(vnZone);
        LocalDate yesterday = today.minusDays(1);
        when(unifiedProgressRepository.getActiveDates(eq(userId), anyString()))
                .thenReturn(List.of(yesterday));

        UnifiedStreakDto streak = unifiedProgressService.getStreak(userId);

        assertThat(streak.currentStreakDays()).isEqualTo(1);
        assertThat(streak.longestStreakDays()).isEqualTo(1);
        assertThat(streak.activeToday()).isFalse();
    }

    @Test
    @DisplayName("Criteria 17: Today + previous 3 consecutive days -> streak 4, longest 4")
    void testTodayAndPreviousConsecutiveDays_ReturnsCorrectCount() {
        LocalDate today = LocalDate.now(vnZone);
        List<LocalDate> dates = List.of(
                today,
                today.minusDays(1),
                today.minusDays(2),
                today.minusDays(3)
        );
        when(unifiedProgressRepository.getActiveDates(eq(userId), anyString()))
                .thenReturn(dates);

        UnifiedStreakDto streak = unifiedProgressService.getStreak(userId);

        assertThat(streak.currentStreakDays()).isEqualTo(4);
        assertThat(streak.longestStreakDays()).isEqualTo(4);
        assertThat(streak.activeToday()).isTrue();
    }

    @Test
    @DisplayName("Criteria 18: Yesterday + previous consecutive days with no today -> streak 3")
    void testYesterdayAndPreviousConsecutive_NoToday_ReturnsCorrectCount() {
        LocalDate today = LocalDate.now(vnZone);
        List<LocalDate> dates = List.of(
                today.minusDays(1),
                today.minusDays(2),
                today.minusDays(3)
        );
        when(unifiedProgressRepository.getActiveDates(eq(userId), anyString()))
                .thenReturn(dates);

        UnifiedStreakDto streak = unifiedProgressService.getStreak(userId);

        assertThat(streak.currentStreakDays()).isEqualTo(3);
        assertThat(streak.longestStreakDays()).isEqualTo(3);
        assertThat(streak.activeToday()).isFalse();
    }

    @Test
    @DisplayName("Criteria 19: Gap between today and older dates -> current streak stops at 1")
    void testGap_StreakStops() {
        LocalDate today = LocalDate.now(vnZone);
        // Active today, skipped yesterday, active 2 and 3 days ago
        List<LocalDate> dates = List.of(
                today,
                today.minusDays(2),
                today.minusDays(3)
        );
        when(unifiedProgressRepository.getActiveDates(eq(userId), anyString()))
                .thenReturn(dates);

        UnifiedStreakDto streak = unifiedProgressService.getStreak(userId);

        assertThat(streak.currentStreakDays()).isEqualTo(1);
        assertThat(streak.longestStreakDays()).isEqualTo(2); // days -2 and -3 form streak 2
        assertThat(streak.activeToday()).isTrue();
    }

    @Test
    @DisplayName("Criteria 20: Longest streak correct across distinct historical periods")
    void testLongestStreakCalculation() {
        LocalDate today = LocalDate.now(vnZone);
        // Historical 5-day streak 20 days ago, current 2-day streak
        List<LocalDate> dates = List.of(
                today,
                today.minusDays(1),
                today.minusDays(20),
                today.minusDays(21),
                today.minusDays(22),
                today.minusDays(23),
                today.minusDays(24)
        );
        when(unifiedProgressRepository.getActiveDates(eq(userId), anyString()))
                .thenReturn(dates);

        UnifiedStreakDto streak = unifiedProgressService.getStreak(userId);

        assertThat(streak.currentStreakDays()).isEqualTo(2);
        assertThat(streak.longestStreakDays()).isEqualTo(5);
    }

    // --- INTENSITY MAPPING (Criterion 26) ---

    @Test
    @DisplayName("Criteria 26: Intensity product rules: 0->0, 1->1, 2-3->2, 4-7->3, 8+->4")
    void testIntensityMapping() {
        assertThat(UnifiedProgressService.calculateIntensity(0)).isZero();
        assertThat(UnifiedProgressService.calculateIntensity(-1)).isZero();

        assertThat(UnifiedProgressService.calculateIntensity(1)).isEqualTo(1);

        assertThat(UnifiedProgressService.calculateIntensity(2)).isEqualTo(2);
        assertThat(UnifiedProgressService.calculateIntensity(3)).isEqualTo(2);

        assertThat(UnifiedProgressService.calculateIntensity(4)).isEqualTo(3);
        assertThat(UnifiedProgressService.calculateIntensity(7)).isEqualTo(3);

        assertThat(UnifiedProgressService.calculateIntensity(8)).isEqualTo(4);
        assertThat(UnifiedProgressService.calculateIntensity(25)).isEqualTo(4);
    }

    // --- HEATMAP (Criteria 23, 24, 25, activeDaysThisYear, activitiesThisMonth) ---

    @Test
    @DisplayName("Criteria 23 & 24: Heatmap returns exactly 365 days with zero-activity days deterministic")
    void testHeatmap_365DaysRangeAndDeterministicZeroDays() {
        LocalDate today = LocalDate.now(vnZone);
        Map<LocalDate, Integer> sampleCounts = new HashMap<>();
        sampleCounts.put(today, 5);
        sampleCounts.put(today.minusDays(10), 2);

        when(unifiedProgressRepository.getDailyActivityCounts(eq(userId), anyString(), any(LocalDate.class), any(LocalDate.class)))
                .thenReturn(sampleCounts);
        when(unifiedProgressRepository.getActiveDates(eq(userId), anyString()))
                .thenReturn(List.of(today, today.minusDays(10)));
        when(userProfileRepository.findById(userId))
                .thenReturn(Optional.of(UserProfile.builder().userId(userId).heatmapTheme("blue").build()));

        HeatmapResponseDto response = unifiedProgressService.getHeatmap(userId, 365);

        assertThat(response.days()).hasSize(365);
        assertThat(response.theme()).isEqualTo("blue");

        // First day is today - 364
        assertThat(response.days().get(0).date()).isEqualTo(today.minusDays(364));
        // Last day is today
        assertThat(response.days().get(364).date()).isEqualTo(today);
        assertThat(response.days().get(364).activityCount()).isEqualTo(5);
        assertThat(response.days().get(364).intensity()).isEqualTo(3);

        // Day with 0 activity
        HeatmapDayDto zeroDay = response.days().get(363); // today - 1
        assertThat(zeroDay.activityCount()).isZero();
        assertThat(zeroDay.intensity()).isZero();
    }

    @Test
    @DisplayName("Summary Stats: activeDaysThisYear and activitiesThisMonth calculated accurately")
    void testSummaryStats() {
        LocalDate today = LocalDate.now(vnZone);
        LocalDate earlierThisMonth = today.withDayOfMonth(1);
        LocalDate lastYear = today.minusYears(1);

        Map<LocalDate, Integer> sampleCounts = new HashMap<>();
        sampleCounts.put(today, 3);
        if (!today.equals(earlierThisMonth)) {
            sampleCounts.put(earlierThisMonth, 4);
        }

        when(unifiedProgressRepository.getDailyActivityCounts(eq(userId), anyString(), any(LocalDate.class), any(LocalDate.class)))
                .thenReturn(sampleCounts);
        when(unifiedProgressRepository.getActiveDates(eq(userId), anyString()))
                .thenReturn(List.of(today, earlierThisMonth, lastYear));

        HeatmapResponseDto response = unifiedProgressService.getHeatmap(userId, null);

        int expectedThisMonth = sampleCounts.values().stream().mapToInt(Integer::intValue).sum();
        assertThat(response.activitiesThisMonth()).isEqualTo(expectedThisMonth);

        // activeDaysThisYear excludes lastYear
        long distinctThisYear = List.of(today, earlierThisMonth).stream().distinct().count();
        assertThat(response.activeDaysThisYear()).isEqualTo((int) distinctThisYear);
    }
}
