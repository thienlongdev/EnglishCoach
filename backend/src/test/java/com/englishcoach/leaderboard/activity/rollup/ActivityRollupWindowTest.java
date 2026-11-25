package com.englishcoach.leaderboard.activity.rollup;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** Recompute window of the Activity rollup (pure). */
class ActivityRollupWindowTest {

    private static final LocalDate START = LocalDate.of(2026, 9, 1);
    private static final LocalDate TODAY = LocalDate.of(2026, 10, 10);

    @Test
    @DisplayName("Steady state: last success today or yesterday ⇒ recompute yesterday + today only")
    void steadyState() {
        assertEquals(TODAY.minusDays(1), ActivityRollupService.windowStart(TODAY, START, TODAY));
        assertEquals(TODAY.minusDays(1), ActivityRollupService.windowStart(TODAY, START, TODAY.minusDays(1)));
    }

    @Test
    @DisplayName("Catch-up: first run starts at the start-at day; after downtime at the last successful day")
    void catchUp() {
        assertEquals(START, ActivityRollupService.windowStart(TODAY, START, null));
        assertEquals(LocalDate.of(2026, 10, 6), ActivityRollupService.windowStart(TODAY, START, LocalDate.of(2026, 10, 6)));
    }

    @Test
    @DisplayName("Never before start-at; a clock behind the last success still recomputes yesterday + today")
    void bounds() {
        assertEquals(START, ActivityRollupService.windowStart(START, START, null));
        assertEquals(START, ActivityRollupService.windowStart(START.plusDays(1), START, START.minusDays(5)));
        assertEquals(TODAY.minusDays(1), ActivityRollupService.windowStart(TODAY, START, TODAY.plusDays(3)));
    }
}
