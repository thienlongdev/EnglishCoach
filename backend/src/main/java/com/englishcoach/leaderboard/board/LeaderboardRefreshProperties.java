package com.englishcoach.leaderboard.board;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/** Leaderboard Phase 3 refresh job ({@code app.leaderboard.refresh.*}). */
@Data
@Configuration
@ConfigurationProperties(prefix = "app.leaderboard.refresh")
public class LeaderboardRefreshProperties {

    /** Master switch for the scheduled rollup + materialized view refresh. */
    private boolean enabled = true;

    /** Delay between the end of one refresh and the start of the next (fixedDelay, ms). */
    private long intervalMs = 600_000L;

    /** Delay after startup before the first refresh (ms). */
    private long initialDelayMs = 60_000L;

    /**
     * Late-event re-read window before the watermark (ms): score events whose created_at is at most this
     * much older than the newest one already processed are looked at again (a scoring transaction may
     * commit after a newer one). Re-processing a day is idempotent.
     */
    private long watermarkOverlapMs = 300_000L;

    /**
     * Live refresh (hotfix 2026-10-02): a committed score event or placement result schedules one extra refresh
     * after {@code liveDebounceMs} (bursts coalesce into one run), never sooner than {@code liveMinIntervalMs} after
     * the previous live run. The periodic refresh above stays as the safety net.
     */
    private boolean liveEnabled = true;
    private long liveDebounceMs = 1_500L;
    private long liveMinIntervalMs = 3_000L;
}
