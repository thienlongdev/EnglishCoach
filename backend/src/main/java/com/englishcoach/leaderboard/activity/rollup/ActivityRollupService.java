package com.englishcoach.leaderboard.activity.rollup;

import com.englishcoach.leaderboard.activity.ActivityScoringProperties;
import com.englishcoach.leaderboard.activity.ActivitySource;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;

/**
 * Activity rollup (Phase 3 + 3.1). Each refresh recomputes today and yesterday (Asia/Ho_Chi_Minh)
 * plus every older (user, day) that received a score event committed after the watermark
 * ({@code leaderboard_refresh_state.last_processed_created_at}; late events). Catch-up: when the last
 * successful refresh is older than yesterday (first run, downtime), the window starts at that
 * refresh's day (first run: the start-at day), so no day since start-at is ever skipped. Must run
 * inside the caller's refresh transaction (the caller stores the returned watermark in it).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ActivityRollupService {

    private final ActivityScoringProperties props;
    private final ActivityRollupRepository repository;

    /** {@code watermark} = newest score_events.created_at seen by this run (the previous one if none). */
    public record RollupResult(LocalDate fromDay, LocalDate today, int rows, Instant watermark) {}

    /**
     * @param now             logical clock of this refresh
     * @param lastSuccessAt   previous successful refresh (null = never)
     * @param watermark       newest score_events.created_at processed so far (null = none: every event
     *                        since start-at counts as new)
     * @param overlap         re-read window before the watermark (covers a transaction that committed
     *                        after a newer one; recomputing a day is idempotent)
     * @return null when start-at is not configured (nothing is rolled up)
     */
    public RollupResult rollup(Instant now, Instant lastSuccessAt, Instant watermark, Duration overlap) {
        Instant startAt = props.startAtInstant();
        if (startAt == null || now.isBefore(startAt)) {
            return null;
        }
        ZoneId zone = ZoneId.of(props.getTimeZone());
        LocalDate today = now.atZone(zone).toLocalDate();
        LocalDate startDay = startAt.atZone(zone).toLocalDate();
        LocalDate fromDay = windowStart(today, startDay,
                lastSuccessAt == null ? null : lastSuccessAt.atZone(zone).toLocalDate());
        Instant newest = repository.maxCreatedAtAfter(watermark);
        Instant lateSince = watermark == null ? null : watermark.minus(overlap);
        int rows = repository.upsertDays(new ActivityRollupRepository.RollupParams(
                startAt, props.getTimeZone(), fromDay, today,
                ActivitySource.CARD_BLAST_SOLO.name(),
                props.getCardBlastSolo().getTopRunsPerDay(), props.getCardBlastSolo().getDailyCap(),
                props.getStreak().getStepPerDay(), props.getStreak().getMaxDays(), lateSince, now));
        return new RollupResult(fromDay, today, rows, newest == null ? watermark : newest);
    }

    /** min(lastSuccessDay, yesterday), never before the start-at day. */
    static LocalDate windowStart(LocalDate today, LocalDate startDay, LocalDate lastSuccessDay) {
        LocalDate yesterday = today.minusDays(1);
        LocalDate from = lastSuccessDay == null ? startDay
                : (lastSuccessDay.isBefore(yesterday) ? lastSuccessDay : yesterday);
        return from.isBefore(startDay) ? startDay : from;
    }

    /** Anti-sandbagging promotions of placement-based divisions (inside the refresh transaction). */
    public int promoteDivisions(Instant now, int windowDays, double minShare, int minSteps) {
        return repository.promoteDivisions(now, now.minus(Duration.ofDays(windowDays)), minShare, minSteps);
    }

    public void refreshRankView() {
        repository.refreshRankView();
    }
}
