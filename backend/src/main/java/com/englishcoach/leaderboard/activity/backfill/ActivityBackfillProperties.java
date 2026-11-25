package com.englishcoach.leaderboard.activity.backfill;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.time.Instant;

/**
 * One-off Activity backfill ({@code app.leaderboard.backfill.*}; env {@code APP_LEADERBOARD_BACKFILL_ENABLED},
 * {@code APP_LEADERBOARD_BACKFILL_FROM}). Default OFF. Runs once at startup when enabled; idempotent through
 * UNIQUE(user_id, source_module, source_ref). Turn it off again after the run.
 */
@Data
@Configuration
@ConfigurationProperties(prefix = "app.leaderboard.backfill")
public class ActivityBackfillProperties {

    private boolean enabled = false;

    /** ISO-8601 instant; events before it are not rebuilt (start-at still gates every event). */
    private String from = "";

    public Instant fromInstant() {
        return from == null || from.isBlank() ? null : java.time.OffsetDateTime.parse(from.trim()).toInstant();
    }
}
