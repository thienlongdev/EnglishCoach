package com.englishcoach.sentinel;

import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

/**
 * One live strict-focus attempt. Every transition is decided here, under this object's lock, in a fixed order: the first
 * terminal transition wins and nothing ever leaves a terminal state (a completion racing a void, or a void arriving after
 * the completion, cannot change the outcome). Persistence follows the decision ({@link SentinelStore}).
 */
public final class SentinelAttempt {
    public enum State {
        READY, ACTIVE, COMPLETED_VERIFIED, PENDING_REVIEW,
        VOIDED_FOCUS_LOSS, VOIDED_ABANDONED, VOIDED_RELOAD, VOIDED_CONTINUITY, VOIDED_INTEGRITY_FAILURE, EXPIRED;
        public boolean terminal() { return this != READY && this != ACTIVE; }
        public boolean voided() { return name().startsWith("VOIDED_") || this == EXPIRED; }
    }
    /** What a transition decided, for the store and the listeners. */
    public record Change(SentinelAttempt attempt, State from, State to, String kind, String detail, Instant at) {}

    final UUID id; final long user; final String activity; final byte[] tokenHash; final Instant acknowledgedAt, createdAt;
    private State state = State.READY;
    private String subject, detail;
    private Instant activatedAt, endedAt;
    /** Monotonic times (ms) of the page's reports and of the contest's accepted actions. */
    private long lastSeen, maxGap, playStartedAt;
    private int heartbeats, violations;
    private final long[] actions = new long[256];
    private int actionCount;
    private final Map<String, Object> evidence = new LinkedHashMap<>();

    SentinelAttempt(UUID id, long user, String activity, byte[] tokenHash, Instant now, long nowMs) {
        this.id = id; this.user = user; this.activity = activity; this.tokenHash = tokenHash;
        this.acknowledgedAt = now; this.createdAt = now; this.lastSeen = nowMs;
    }

    public UUID id() { return id; }
    public long user() { return user; }
    public String activity() { return activity; }
    public synchronized State state() { return state; }
    public synchronized String subject() { return subject; }
    public synchronized String detail() { return detail; }
    public synchronized Instant activatedAt() { return activatedAt; }
    public synchronized Instant endedAt() { return endedAt; }
    public synchronized boolean terminal() { return state.terminal(); }
    public synchronized boolean voided() { return state.voided(); }
    public synchronized Map<String, Object> evidence() { return new LinkedHashMap<>(evidence); }

    /** Constant-time check of the attempt secret (only its SHA-256 is kept). */
    boolean owns(long user, String token) {
        if (user != this.user || token == null || token.isEmpty() || token.length() > 128) return false;
        return MessageDigest.isEqual(tokenHash, SentinelService.hash(token));
    }

    synchronized Change activate(String subject, Instant now, long nowMs) {
        if (state != State.READY) return null;
        state = State.ACTIVE; activatedAt = now; this.subject = subject; lastSeen = nowMs;
        return new Change(this, State.READY, State.ACTIVE, "ACTIVATED", subject, now);
    }
    /** The contest itself began (the match clock started): continuity counts from here. */
    synchronized void playStarted(String subject, long nowMs) {
        if (state != State.ACTIVE) return;
        if (subject != null) this.subject = subject;
        playStartedAt = nowMs; lastSeen = nowMs; maxGap = 0;
    }
    synchronized boolean playing() { return state == State.ACTIVE && playStartedAt > 0; }

    /** A report from the page. Returns the gap since the previous one (monotonic). */
    synchronized long heartbeat(long nowMs) {
        if (state.terminal()) return 0;
        long gap = Math.max(0, nowMs - lastSeen);
        if (playStartedAt > 0) maxGap = Math.max(maxGap, gap);
        lastSeen = nowMs; heartbeats++;
        return gap;
    }
    synchronized long silentFor(long nowMs) { return Math.max(0, nowMs - lastSeen); }

    /** An accepted scoring action (bounded memory: only the first {@code actions.length} are timed). */
    synchronized void action(long nowMs) {
        if (state != State.ACTIVE) return;
        if (actionCount < actions.length) actions[actionCount] = nowMs;
        actionCount++;
    }

    synchronized Change end(State to, String kind, String detail, Instant now) {
        if (!to.terminal() || state.terminal()) return null;
        var from = state; state = to; endedAt = now; this.detail = detail;
        if (to.voided()) violations++;
        return new Change(this, from, to, kind, detail, now);
    }

    /**
     * Completion of a contest that ended normally. Verified only if the page kept reporting during the play (no gap above
     * the disclosed grace, last report within it) and the timing is not mechanical; otherwise the attempt ends as
     * VOIDED_CONTINUITY (continuity unverifiable, not an accusation) or PENDING_REVIEW (kept out of rankings until reviewed).
     */
    synchronized Change complete(Instant now, long nowMs) {
        if (state != State.ACTIVE || playStartedAt == 0) return null;
        long finalGap = Math.max(0, nowMs - lastSeen);
        long gap = Math.max(maxGap, finalGap);
        var timing = timing();
        evidence.put("heartbeats", heartbeats);
        evidence.put("maxGapMs", gap);
        evidence.put("playMs", Math.max(0, nowMs - playStartedAt));
        evidence.put("timing", timing);
        if (gap > SentinelPolicy.CONTINUITY_GRACE_MS) return end(State.VOIDED_CONTINUITY, "CONTINUITY_UNVERIFIED", "GAP_" + gap, now);
        if (Boolean.TRUE.equals(timing.get("mechanical"))) return end(State.PENDING_REVIEW, "TIMING_REVIEW", "MECHANICAL_INTERVALS", now);
        return end(State.COMPLETED_VERIFIED, "COMPLETED", null, now);
    }

    /**
     * Inter-action timing summary. "mechanical" is a deliberately conservative rule (≥ 30 intervals with a coefficient of
     * variation below 0.12, i.e. near-metronomic input that people do not produce while searching a board); it is not
     * calibrated on production data and never decides alone that a learner cheated: the attempt only waits for review.
     */
    Map<String, Object> timing() {
        int n = Math.min(actionCount, actions.length);
        var out = new LinkedHashMap<String, Object>();
        out.put("actions", actionCount);
        if (n < 2) { out.put("mechanical", false); return out; }
        double[] d = new double[n - 1];
        for (int i = 1; i < n; i++) d[i - 1] = Math.max(0, actions[i] - actions[i - 1]);
        double mean = Arrays.stream(d).average().orElse(0), var = 0;
        for (double x : d) var += (x - mean) * (x - mean);
        double sd = Math.sqrt(var / d.length), cv = mean == 0 ? 0 : sd / mean;
        double[] s = d.clone(); Arrays.sort(s);
        out.put("intervals", d.length);
        out.put("meanMs", Math.round(mean));
        out.put("medianMs", Math.round(s[s.length / 2]));
        out.put("minMs", Math.round(s[0]));
        out.put("cv", Math.round(cv * 1000) / 1000.0);
        out.put("mechanical", d.length >= 30 && cv < 0.12);
        return out;
    }
}
