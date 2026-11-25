package com.englishcoach.leaderboard.board;

import com.englishcoach.leaderboard.activity.LeaderboardRefreshTrigger;
import com.englishcoach.proficiency.placement.PlacementCompletionListener;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.BeanFactory;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Instant;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Near-realtime boards (hotfix 2026-10-02). A committed score event (via {@link LeaderboardRefreshTrigger}) or a
 * stored placement result (via {@link PlacementCompletionListener}) schedules ONE extra run of the normal
 * {@link LeaderboardRefreshJob} on the dedicated {@code leaderboardTaskScheduler}: after {@code live-debounce-ms}
 * (a burst of events coalesces into one run) and never sooner than {@code live-min-interval-ms} after the previous
 * live run. The refresh itself is unchanged (single-flight, one transaction, constant statement count), so the cost is
 * bounded to one refresh per few seconds under any load; the periodic refresh stays as the safety net. In-memory:
 * a lost request (restart) is covered by the periodic run.
 */
@Slf4j
@Component
public class LeaderboardLiveRefresh implements LeaderboardRefreshTrigger, PlacementCompletionListener {

    private final LeaderboardRefreshJob job;
    private final LeaderboardRefreshProperties props;
    private final BeanFactory beanFactory;
    private final AtomicBoolean scheduled = new AtomicBoolean(false);
    private volatile long lastRunStartedAtMs;
    private volatile TaskScheduler scheduler;

    public LeaderboardLiveRefresh(LeaderboardRefreshJob job, LeaderboardRefreshProperties props, BeanFactory beanFactory) {
        this.job = job;
        this.props = props;
        this.beanFactory = beanFactory;
    }

    @Override
    public void requestRefresh(String reason) {
        if (!props.isEnabled() || !props.isLiveEnabled()) {
            return;
        }
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            // e.g. placement submit: refresh only after the caller's transaction commits
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    schedule();
                }
            });
            return;
        }
        schedule();
    }

    @Override
    public void placementCompleted(long userId) {
        requestRefresh("placement");
    }

    /** True while a live run is queued (tests). */
    boolean isScheduled() {
        return scheduled.get();
    }

    private void schedule() {
        if (!scheduled.compareAndSet(false, true)) {
            return; // a queued run will pick this event up
        }
        try {
            long now = System.currentTimeMillis();
            long delay = Math.max(props.getLiveDebounceMs(), lastRunStartedAtMs + props.getLiveMinIntervalMs() - now);
            scheduler().schedule(this::runNow, Instant.ofEpochMilli(now + Math.max(0, delay)));
        } catch (RuntimeException ex) {
            scheduled.set(false);
            log.warn("[Leaderboard] Live refresh not scheduled (periodic refresh still runs): {}", ex.getMessage());
        }
    }

    private void runNow() {
        // cleared before the run: an event committed during the run queues the next pass
        scheduled.set(false);
        lastRunStartedAtMs = System.currentTimeMillis();
        LeaderboardRefreshJob.RefreshResult r = job.run(Instant.now());
        if (r.outcome() == LeaderboardRefreshJob.Outcome.RAN) {
            log.debug("[Leaderboard] Live refresh done in {} ms ({} daily rows)", r.durationMs(), r.dailyRows());
        } else if (r.outcome() == LeaderboardRefreshJob.Outcome.SKIPPED) {
            schedule(); // another run held the lock: try again after the min interval
        } else {
            log.info("[Leaderboard] Live refresh {}: {}", r.outcome(), r.message());
        }
    }

    private TaskScheduler scheduler() {
        TaskScheduler s = scheduler;
        if (s == null) {
            s = beanFactory.getBean(LeaderboardSchedulerConfig.SCHEDULER_BEAN, TaskScheduler.class);
            scheduler = s;
        }
        return s;
    }
}
