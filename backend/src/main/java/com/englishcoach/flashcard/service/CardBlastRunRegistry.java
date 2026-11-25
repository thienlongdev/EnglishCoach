package com.englishcoach.flashcard.service;

import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The solo Card Blast runs the server has started and not yet finished.
 *
 * <p>The game itself runs in the browser, so the server cannot watch a learner type. What it can do is refuse a
 * result it never asked for: a result counts only for a run this registry issued to the same learner, once, and only
 * for as many words as the time since the start allows (see {@link #plausibleWords}). The words are the learner's own
 * vocabulary, which the browser legitimately holds, so a program that plays at human speed is not distinguishable
 * from a learner; the daily caps of the Activity Points engine bound what that can earn.
 *
 * <p>Runs live in memory (one backend instance; no table, no cache server). A restart drops the runs in progress:
 * their results are then not counted, which is the safe direction.
 */
@Component
public class CardBlastRunRegistry {

    /** A learner may hold this many started runs (two tabs and a restart); starting another drops the oldest. */
    static final int MAX_OPEN_RUNS_PER_USER = 3;
    /** Upper bound of the whole registry; beyond it the oldest runs are dropped. */
    static final int MAX_OPEN_RUNS = 5_000;
    /** A run that was not finished within this time can no longer be finished. */
    static final Duration RUN_LIFETIME = Duration.ofHours(2);
    /** No learner clears words faster than this on average over a run (chain clears included). */
    static final double MAX_WORDS_PER_SECOND = 2.0;
    /** A learner may start a run this often; a faster start reuses nothing and is refused. */
    static final Duration MIN_START_INTERVAL = Duration.ofSeconds(2);

    public record IssuedRun(String runId, long userId, Long deckId, Instant issuedAt) {}

    /** A verified decision survives a transaction rollback until the same run is retried or expires. */
    static final class Finish {
        final IssuedRun run;
        final int wordLimit;
        com.englishcoach.sentinel.SentinelAttempt.Change decision;
        boolean busy;
        Finish(IssuedRun run, int wordLimit) { this.run = run; this.wordLimit = wordLimit; }
    }
    private final java.util.Map<String, Finish> finishes = new java.util.HashMap<>();

    private final ConcurrentHashMap<String, IssuedRun> runs = new ConcurrentHashMap<>();
    private final Clock clock;

    public CardBlastRunRegistry() {
        this(Clock.systemUTC());
    }

    CardBlastRunRegistry(Clock clock) {
        this.clock = clock;
    }

    /** Starts a run for the learner. Empty when the learner started another one a moment ago. */
    public synchronized Optional<IssuedRun> issue(long userId, Long deckId) {
        Instant now = clock.instant();
        runs.values().removeIf(run -> expired(run, now) && !protectedFinish(run));

        finishes.entrySet().removeIf(e -> !e.getValue().busy && !runs.containsKey(e.getKey()));

        List<IssuedRun> own = runs.values().stream()
                .filter(run -> run.userId() == userId)
                .sorted(Comparator.comparing(IssuedRun::issuedAt))
                .toList();
        if (!own.isEmpty()
                && Duration.between(own.get(own.size() - 1).issuedAt(), now).compareTo(MIN_START_INTERVAL) < 0) {
            return Optional.empty();
        }
        if (own.size() >= MAX_OPEN_RUNS_PER_USER && !evictOldest(own)) return Optional.empty();
        if (runs.size() >= MAX_OPEN_RUNS && !evictOldest(runs.values())) return Optional.empty();

        IssuedRun run = new IssuedRun(UUID.randomUUID().toString(), userId, deckId, now);
        runs.put(run.runId(), run);
        return Optional.of(run);
    }

    private boolean protectedFinish(IssuedRun run) {
        Finish finish = finishes.get(run.runId());
        return finish != null && finish.busy;
    }

    private boolean evictOldest(java.util.Collection<IssuedRun> candidates) {
        return candidates.stream().filter(run -> !protectedFinish(run)).min(Comparator.comparing(IssuedRun::issuedAt))
                .map(run -> {
                    finishes.remove(run.runId());
                    return runs.remove(run.runId(), run);
                }).orElse(false);
    }

    /**
     * Ends a run: the run is returned once, to the learner it was issued to, while it is still alive. Every later or
     * foreign call gets nothing, so a result cannot be counted twice.
     */
    public Optional<IssuedRun> redeem(long userId, String runId) {
        if (runId == null || runId.isBlank() || runId.length() > 64) {
            return Optional.empty();
        }
        IssuedRun run = runs.get(runId);
        if (run == null || run.userId() != userId) {
            return Optional.empty();
        }
        if (!runs.remove(runId, run)) {
            return Optional.empty();
        }
        return expired(run, clock.instant()) ? Optional.empty() : Optional.of(run);
    }

    synchronized Optional<Finish> reserve(long user, String key) {
        if (key == null || key.isBlank() || key.length() > 64) return Optional.empty();
        var run = runs.get(key);
        if (run == null || run.userId() != user || expired(run, clock.instant())) return Optional.empty();
        var finish = finishes.computeIfAbsent(key, k -> new Finish(run, plausibleWords(run)));
        if (finish.busy) return Optional.empty();
        finish.busy = true;
        return Optional.of(finish);
    }

    synchronized void release(Finish finish, boolean committed) {
        if (committed) {
            runs.remove(finish.run.runId(), finish.run);
            finishes.remove(finish.run.runId(), finish);
        }
        finish.busy = false;
    }

    /** The most words a run started at {@code issuedAt} can have cleared by now. */
    public int plausibleWords(IssuedRun run) {
        long millis = Math.max(0, Duration.between(run.issuedAt(), clock.instant()).toMillis());
        return (int) Math.min(Integer.MAX_VALUE, (long) Math.floor(millis / 1000.0 * MAX_WORDS_PER_SECOND));
    }

    int openRuns() {
        return runs.size();
    }

    private static boolean expired(IssuedRun run, Instant now) {
        return Duration.between(run.issuedAt(), now).compareTo(RUN_LIFETIME) > 0;
    }
}
