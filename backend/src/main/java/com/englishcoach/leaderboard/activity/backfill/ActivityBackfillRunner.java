package com.englishcoach.leaderboard.activity.backfill;

import com.englishcoach.leaderboard.activity.ActivityScoringProperties;
import com.englishcoach.leaderboard.activity.ActivityScoringService;
import com.englishcoach.leaderboard.activity.ScoreEventRow;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Supplier;

/**
 * One-off Activity backfill (owner decision DC), {@code app.leaderboard.backfill.enabled} (default OFF). Rebuilds
 * historical events since {@code app.leaderboard.backfill.from} and feeds them, in occurred_at order, through the
 * SAME scoring handlers as the live listener (no publishEvent): same formulas, caps per historical VN day and
 * source_ref ⇒ idempotent (UNIQUE + ON CONFLICT DO NOTHING) and never double counted with live events.
 * relativeMult uses the learner's current PROVISIONAL / VERIFIED / STALE level (approximation; undetermined ⇒ 1.0).
 * Runs after the Proficiency backfill runner. The refresh job rolls the new rows up through the created_at watermark.
 */
@Slf4j
@Component
@Order(200)
@RequiredArgsConstructor
public class ActivityBackfillRunner implements ApplicationRunner {

    private final ActivityBackfillProperties props;
    private final ActivityScoringProperties scoringProps;
    private final ActivityBackfillSourceRepository source;
    private final ActivityScoringService scoring;

    private record Job(Instant at, String module, Supplier<List<ScoreEventRow>> call) {}

    public record Summary(int events, int rowsWritten, int failures, Map<String, int[]> perModule) {}

    @Override
    public void run(ApplicationArguments args) {
        if (!props.isEnabled()) {
            return;
        }
        try {
            Summary s = runOnce();
            log.info("[Leaderboard] Activity backfill finished: {} source events, {} score_events rows written, {} failures",
                    s.events(), s.rowsWritten(), s.failures());
            s.perModule().forEach((m, c) -> log.info("[Leaderboard] Activity backfill {}: {} events, {} rows", m, c[0], c[1]));
        } catch (Exception ex) {
            log.warn("[Leaderboard] Activity backfill failed (non-fatal): {}", ex.getMessage(), ex);
        }
    }

    public Summary runOnce() {
        Instant from = props.fromInstant();
        Instant startAt = scoringProps.startAtInstant();
        if (from == null || startAt == null) {
            throw new IllegalStateException("backfill needs app.leaderboard.backfill.from and app.leaderboard.activity.start-at");
        }
        if (from.isBefore(startAt)) {
            from = startAt; // events before start-at are never recorded
        }
        List<Job> jobs = new ArrayList<>();
        source.flashcards(from).forEach(e -> jobs.add(new Job(e.occurredAt(), "FLASHCARD", () -> scoring.onFlashcardReviewed(e))));
        source.cardBlastRuns(from).forEach(e -> jobs.add(new Job(e.occurredAt(), "CARD_BLAST_SOLO", () -> scoring.onCardBlastRunFinished(e))));
        source.pvpMatches(from).forEach(e -> jobs.add(new Job(e.occurredAt(), "CARD_BLAST_PVP", () -> scoring.onPvpMatchFinished(e))));
        source.dictationAttempts(from).forEach(e -> jobs.add(new Job(e.occurredAt(), "DICTATION", () -> scoring.onDictationAttemptSubmitted(e))));
        source.shadowingAttempts(from).forEach(e -> jobs.add(new Job(e.occurredAt(), "SHADOWING", () -> scoring.onShadowingAttemptRecorded(e))));
        source.roleplaySessions(from).forEach(e -> jobs.add(new Job(e.occurredAt(), "ROLEPLAY", () -> scoring.onRoleplayTurnRecorded(e))));
        source.writingAssessments(from).forEach(e -> jobs.add(new Job(e.occurredAt(), "WRITING", () -> scoring.onWritingAssessmentCompleted(e))));
        source.examResults(from).forEach(e -> jobs.add(new Job(e.occurredAt(), "EXAM", () -> scoring.onExamScored(e))));
        jobs.removeIf(j -> j.at() == null);
        jobs.sort(Comparator.comparing(Job::at));

        Map<String, int[]> perModule = new TreeMap<>();
        int written = 0;
        int failures = 0;
        for (Job j : jobs) {
            int[] c = perModule.computeIfAbsent(j.module(), k -> new int[2]);
            c[0]++;
            try {
                List<ScoreEventRow> rows = j.call().get();
                int n = rows == null ? 0 : rows.size();
                c[1] += n;
                written += n;
            } catch (Exception ex) {
                failures++;
                log.warn("[Leaderboard] Activity backfill event failed ({} at {}): {}", j.module(), j.at(), ex.getMessage());
            }
        }
        return new Summary(jobs.size(), written, failures, perModule);
    }
}
