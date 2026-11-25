package com.englishcoach.leaderboard.board;

import com.englishcoach.leaderboard.activity.ActivityScoringProperties;
import com.englishcoach.leaderboard.activity.rollup.ActivityRollupService;
import com.englishcoach.proficiency.board.ProficiencyBoardService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Leaderboard Phase 3 refresh (thin orchestrator). Every {@code app.leaderboard.refresh.interval-ms}
 * (default 10 min, fixedDelay, on the dedicated {@code leaderboardTaskScheduler} thread): upsert today +
 * yesterday + late (user, day) pairs past the watermark in leaderboard_activity_daily, then
 * REFRESH MATERIALIZED VIEW CONCURRENTLY mv_activity_rank and mv_proficiency_rank, then record the
 * success time. Single-flight: an in-JVM flag plus a transaction-scoped Postgres advisory lock (other
 * instances skip). Everything runs in ONE transaction: a failure rolls back and the previous view
 * data keeps being served; the error is recorded in a separate transaction. The query count of a
 * refresh is constant (no per-user calls).
 */
@Slf4j
@Component
public class LeaderboardRefreshJob {

    public enum Outcome { RAN, SKIPPED, FAILED }

    public record RefreshResult(Outcome outcome, int dailyRows, Integer durationMs, String message) {}

    private static final long MAX_IDLE_VIEW_SKIP_MINUTES = 60L;

    private final LeaderboardRefreshProperties props;
    private final LeaderboardProperties boardProps;
    private final ActivityScoringProperties activityProps;
    private final ActivityRollupService activityRollup;
    private final ProficiencyBoardService proficiencyBoard;
    private final LeaderboardRefreshStateRepository stateRepository;
    private final TransactionTemplate refreshTx;
    private final TransactionTemplate failureTx;
    private final AtomicBoolean running = new AtomicBoolean(false);

    @Autowired(required = false)
    private LeaderboardBoardService boardService;

    @Autowired
    public LeaderboardRefreshJob(LeaderboardRefreshProperties props, LeaderboardProperties boardProps,
                                 ActivityScoringProperties activityProps,
                                 ActivityRollupService activityRollup, ProficiencyBoardService proficiencyBoard,
                                 LeaderboardRefreshStateRepository stateRepository,
                                 PlatformTransactionManager transactionManager) {
        this.props = props;
        this.boardProps = boardProps;
        this.activityProps = activityProps;
        this.activityRollup = activityRollup;
        this.proficiencyBoard = proficiencyBoard;
        this.stateRepository = stateRepository;
        this.refreshTx = new TransactionTemplate(transactionManager);
        this.refreshTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.failureTx = new TransactionTemplate(transactionManager);
        this.failureTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    @Scheduled(fixedDelayString = "${app.leaderboard.refresh.interval-ms:600000}",
            initialDelayString = "${app.leaderboard.refresh.initial-delay-ms:60000}",
            scheduler = LeaderboardSchedulerConfig.SCHEDULER_BEAN)
    public void scheduled() {
        if (!props.isEnabled()) {
            return;
        }
        RefreshResult r = run(Instant.now());
        if (r.outcome() == Outcome.RAN) {
            log.info("[Leaderboard] Refresh done: {} daily rows upserted in {} ms", r.dailyRows(), r.durationMs());
        } else {
            log.info("[Leaderboard] Refresh {}: {}", r.outcome(), r.message());
        }
    }

    /** Entry point with an explicit clock (tests simulate days). Never throws. */
    public RefreshResult run(Instant now) {
        if (!running.compareAndSet(false, true)) {
            return new RefreshResult(Outcome.SKIPPED, 0, null, "refresh already running in this instance");
        }
        long started = System.nanoTime();
        try {
            return refreshTx.execute(status -> {
                if (!stateRepository.tryLock()) {
                    return new RefreshResult(Outcome.SKIPPED, 0, null, "refresh lock held by another run");
                }
                Optional<LeaderboardRefreshStateRepository.State> previous = stateRepository.find();
                Instant lastSuccess = previous.map(LeaderboardRefreshStateRepository.State::lastSuccessAt).orElse(null);
                Instant watermark = previous.map(LeaderboardRefreshStateRepository.State::lastProcessedCreatedAt).orElse(null);
                String currentExcluded = boardProps.excludedUserIdsArrayLiteral();
                boolean currentRequirePlacement = boardProps.isRequirePlacement();
                Instant currentStartAt = activityProps.startAtInstant();
                String currentTz = activityProps.getTimeZone();

                stateRepository.prepare(now, currentStartAt, currentTz, now,
                        currentExcluded, currentRequirePlacement);
                ActivityRollupService.RollupResult rollup = activityRollup.rollup(now, lastSuccess, watermark,
                        Duration.ofMillis(props.getWatermarkOverlapMs()));
                if (rollup != null) {
                    stateRepository.advanceWatermark(rollup.watermark());
                }
                int promoted = 0;
                LeaderboardProperties.Division division = boardProps.getDivision();
                if (division.isPromotionEnabled()) {
                    promoted = activityRollup.promoteDivisions(now, division.getPromotionWindowDays(),
                            division.getPromotionMinShare(), division.getPromotionMinSteps());
                }

                boolean needsViewRefresh = shouldRefreshViews(
                        previous, lastSuccess, now, currentStartAt, currentTz,
                        currentExcluded, currentRequirePlacement, rollup, promoted
                );
                if (needsViewRefresh) {
                    activityRollup.refreshRankView();
                    proficiencyBoard.refreshView();
                    invalidateBoardsAfterCommit();
                } else {
                    log.debug("[Leaderboard] Skipping concurrent materialized view refresh: no data/config changes since {}", lastSuccess);
                }

                int ms = (int) ((System.nanoTime() - started) / 1_000_000L);
                stateRepository.markSuccess(now, ms);
                return new RefreshResult(Outcome.RAN, rollup == null ? 0 : rollup.rows(), ms,
                        rollup == null ? "activity start-at not configured: no rollup" : null);
            });
        } catch (RuntimeException ex) {
            log.warn("[Leaderboard] Refresh failed (previous view data kept): {}", ex.getMessage(), ex);
            try {
                failureTx.executeWithoutResult(s -> stateRepository.markFailure(now, ex.getMessage()));
            } catch (RuntimeException inner) {
                log.warn("[Leaderboard] Could not record refresh failure: {}", inner.getMessage());
            }
            return new RefreshResult(Outcome.FAILED, 0, null, ex.getMessage());
        } finally {
            running.set(false);
        }
    }

    private boolean shouldRefreshViews(
            Optional<LeaderboardRefreshStateRepository.State> previousOpt,
            Instant lastSuccess,
            Instant now,
            Instant currentStartAt,
            String currentTz,
            String currentExcluded,
            boolean currentRequirePlacement,
            ActivityRollupService.RollupResult rollup,
            int promoted
    ) {
        if (lastSuccess == null || previousOpt.isEmpty()) {
            return true;
        }
        LeaderboardRefreshStateRepository.State prev = previousOpt.get();
        if (prev.asOf() == null) {
            return true;
        }
        if (!Objects.equals(prev.activityStartAt(), currentStartAt)
                || !Objects.equals(prev.timeZone(), currentTz)
                || !Objects.equals(prev.excludedUserIds(), currentExcluded)
                || prev.requirePlacement() != currentRequirePlacement) {
            return true;
        }
        if ((rollup != null && rollup.rows() > 0) || promoted > 0) {
            return true;
        }
        ZoneId zone = ZoneId.of(currentTz);
        LocalDate prevDay = prev.asOf().atZone(zone).toLocalDate();
        LocalDate currDay = now.atZone(zone).toLocalDate();
        if (!prevDay.equals(currDay)) {
            return true;
        }
        if (Duration.between(lastSuccess, now).toMinutes() >= MAX_IDLE_VIEW_SKIP_MINUTES) {
            return true;
        }
        return stateRepository.hasViewInputChangesSince(lastSuccess);
    }

    private void invalidateBoardsAfterCommit() {
        if (boardService == null) {
            return;
        }
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    boardService.invalidateBoardCache();
                }
            });
        } else {
            boardService.invalidateBoardCache();
        }
    }
}
