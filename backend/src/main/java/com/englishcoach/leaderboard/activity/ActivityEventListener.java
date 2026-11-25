package com.englishcoach.leaderboard.activity;

import com.englishcoach.common.event.DictationAttemptSubmittedEvent;
import com.englishcoach.common.event.ExamScoredEvent;
import com.englishcoach.common.event.RoleplayTurnRecordedEvent;
import com.englishcoach.leaderboard.activity.event.CardBlastRunFinishedEvent;
import com.englishcoach.leaderboard.activity.event.FlashcardReviewedEvent;
import com.englishcoach.leaderboard.activity.event.PvpMatchFinishedEvent;
import com.englishcoach.leaderboard.activity.event.ShadowingAttemptRecordedEvent;
import com.englishcoach.leaderboard.activity.event.WritingAssessmentCompletedEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

import java.util.function.Supplier;

/**
 * Activity listener. Runs only AFTER the source transaction COMMITS (or immediately for
 * non-transactional publishers such as the PvP match persister and the exam job worker —
 * {@code fallbackExecution = true}), on the leaderboard executor. Every exception is caught and
 * logged: the leaderboard can never break or roll back a source module.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ActivityEventListener {

    private final ActivityScoringService scoringService;
    /** Optional live refresh (leaderboard.board); asked only when a handler wrote at least one row. */
    private final ObjectProvider<LeaderboardRefreshTrigger> refreshTrigger;

    @Async(LeaderboardActivityAsyncConfig.EXECUTOR)
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void on(FlashcardReviewedEvent event) {
        safely("FlashcardReviewed", () -> scoringService.onFlashcardReviewed(event));
    }

    @Async(LeaderboardActivityAsyncConfig.EXECUTOR)
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void on(CardBlastRunFinishedEvent event) {
        safely("CardBlastRunFinished", () -> scoringService.onCardBlastRunFinished(event));
    }

    @Async(LeaderboardActivityAsyncConfig.EXECUTOR)
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void on(PvpMatchFinishedEvent event) {
        safely("PvpMatchFinished", () -> scoringService.onPvpMatchFinished(event));
    }

    @Async(LeaderboardActivityAsyncConfig.EXECUTOR)
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void on(DictationAttemptSubmittedEvent event) {
        safely("DictationAttemptSubmitted", () -> scoringService.onDictationAttemptSubmitted(event));
    }

    @Async(LeaderboardActivityAsyncConfig.EXECUTOR)
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void on(ShadowingAttemptRecordedEvent event) {
        safely("ShadowingAttemptRecorded", () -> scoringService.onShadowingAttemptRecorded(event));
    }

    @Async(LeaderboardActivityAsyncConfig.EXECUTOR)
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void on(RoleplayTurnRecordedEvent event) {
        safely("RoleplayTurnRecorded", () -> scoringService.onRoleplayTurnRecorded(event));
    }

    @Async(LeaderboardActivityAsyncConfig.EXECUTOR)
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void on(WritingAssessmentCompletedEvent event) {
        safely("WritingAssessmentCompleted", () -> scoringService.onWritingAssessmentCompleted(event));
    }

    @Async(LeaderboardActivityAsyncConfig.EXECUTOR)
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void on(ExamScoredEvent event) {
        safely("ExamScored", () -> scoringService.onExamScored(event));
    }

    private void safely(String name, Supplier<?> action) {
        Object written;
        try {
            written = action.get();
        } catch (Throwable ex) {
            log.warn("[Leaderboard] Non-fatal: failed to score {} event: {}", name, ex.getMessage(), ex);
            return;
        }
        // The scoring transaction (REQUIRES_NEW) has committed here: the new rows are visible to a refresh.
        if (written instanceof java.util.Collection<?> rows && !rows.isEmpty()) {
            try {
                refreshTrigger.ifAvailable(t -> t.requestRefresh(name));
            } catch (Throwable ex) {
                log.warn("[Leaderboard] Non-fatal: live refresh request failed after {}: {}", name, ex.getMessage());
            }
        }
    }
}
