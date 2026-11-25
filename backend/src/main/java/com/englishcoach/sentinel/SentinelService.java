package com.englishcoach.sentinel;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

/**
 * Echo Sentinel: strict-focus attempts for ranked play (owner directive 2026-11-14).
 *
 * <p>An attempt is opened only after the learner acknowledged the rules ({@link #begin}); its secret lives in the page's
 * memory only, so a reload, a closed tab or a second tab cannot present it again. The page reports that the attempt is on
 * screen ({@link #heartbeat}) and reports leaving ({@link #violation}); the game binds the attempt to its contest
 * ({@link #bind}), counts accepted actions and asks for completion ({@link #complete}). A ranked result is written only
 * for a COMPLETED_VERIFIED attempt (V119 trigger). Browser reports are evidence, never proof: an automated browser can fake
 * them, and a missing report is treated as "continuity unverifiable", not as cheating.</p>
 *
 * <p>Single backend instance (as the games' rooms): live attempts are in memory; every decision is persisted.</p>
 */
@Service
public class SentinelService {
    public static class Refusal extends RuntimeException {
        public final String code; public final int status;
        public Refusal(String code, int status) { super(code); this.code = code; this.status = status; }
    }
    public record Begun(UUID id, String token, String activity, int policyVersion, long heartbeatMs, long continuityGraceMs, long blurGraceMs) {}

    private static final SecureRandom RANDOM = new SecureRandom();
    private final SentinelStore store;
    private final Clock clock;
    private final ConcurrentHashMap<UUID, SentinelAttempt> live = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long, ArrayDeque<Long>> begins = new ConcurrentHashMap<>();
    private final List<Consumer<SentinelAttempt>> voidListeners = new CopyOnWriteArrayList<>();
    private final ScheduledExecutorService sweeper = Executors.newSingleThreadScheduledExecutor(r -> {
        var t = new Thread(r, "sentinel-sweeper"); t.setDaemon(true); return t;
    });

    @Autowired public SentinelService(JdbcTemplate jdbc) { this(new SentinelStore(jdbc), Clock.systemUTC()); }
    public SentinelService(SentinelStore store, Clock clock) { this.store = store; this.clock = clock; }

    @PostConstruct public void init() {
        sweeper.scheduleWithFixedDelay(() -> { try { sweep(); } catch (Exception ignored) { /* next sweep */ } }, 2, 2, TimeUnit.SECONDS);
    }
    @PreDestroy public void close() { sweeper.shutdownNow(); store.close(); }

    /** A game asks to hear about voids decided outside its own commands (page reports, sweeper). Never holds a game lock. */
    public void onVoid(Consumer<SentinelAttempt> listener) { voidListeners.add(listener); }

    static byte[] hash(String token) {
        try { return MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
    private long now() { return clock.millis(); }

    /** Opens an attempt after the learner acknowledged the rules of this policy version. Any other open attempt of the learner ends. */
    public Begun begin(long user, String activity, boolean acknowledged, Integer policyVersion) {
        if (user <= 0) throw new Refusal("AUTH_REQUIRED", 401);
        if (!SentinelPolicy.strict(Objects.toString(activity, ""))) throw new Refusal("ACTIVITY_NOT_STRICT", 400);
        if (!acknowledged) throw new Refusal("RULES_NOT_ACKNOWLEDGED", 400);
        if (policyVersion == null || policyVersion != SentinelPolicy.POLICY_VERSION) throw new Refusal("POLICY_CHANGED", 409);
        long t = now();
        // Bounded memory under abuse (many accounts opening attempts): refuse, never grow without limit.
        if (live.size() >= SentinelPolicy.MAX_LIVE_ATTEMPTS) throw new Refusal("SENTINEL_BUSY", 503);
        var recent = begins.computeIfAbsent(user, k -> new ArrayDeque<>());
        synchronized (recent) {
            while (!recent.isEmpty() && t - recent.peekFirst() > 60_000) recent.pollFirst();
            if (recent.size() >= SentinelPolicy.BEGIN_PER_MINUTE) throw new Refusal("RATE_LIMITED", 429);
            recent.addLast(t);
        }
        // One open strict attempt per learner: a new one supersedes (ends) the others, so two contests cannot run at once.
        for (var other : live.values())
            if (other.user == user && !other.terminal()) end(other, SentinelAttempt.State.VOIDED_ABANDONED, "SUPERSEDED", "NEW_ATTEMPT_OPENED", true);
        byte[] raw = new byte[32]; RANDOM.nextBytes(raw);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        var instant = Instant.ofEpochMilli(t);
        var attempt = new SentinelAttempt(UUID.randomUUID(), user, activity, hash(token), instant, t);
        try {
            store.write(new SentinelAttempt.Change(attempt, null, SentinelAttempt.State.READY, "CREATED", "ACKNOWLEDGED_V" + SentinelPolicy.POLICY_VERSION, instant));
        } catch (Exception e) {
            // No durable acknowledgement, no ranked attempt: fail closed.
            throw new Refusal("SENTINEL_UNAVAILABLE", 503);
        }
        live.put(attempt.id, attempt);
        return new Begun(attempt.id, token, activity, SentinelPolicy.POLICY_VERSION, SentinelPolicy.HEARTBEAT_MS,
            SentinelPolicy.CONTINUITY_GRACE_MS, SentinelPolicy.BLUR_GRACE_MS);
    }

    /** "id.token" as sent inside a game command; null when absent or malformed. */
    public static String[] parse(String handle) {
        if (handle == null || handle.length() > 200) return null;
        int dot = handle.indexOf('.');
        if (dot != 36) return null;
        return new String[]{handle.substring(0, dot), handle.substring(dot + 1)};
    }

    /** The attempt this learner presents (id + secret), or null. Never throws for a forged handle: it simply does not match. */
    public SentinelAttempt resolve(long user, String handle) {
        var parts = parse(handle);
        if (parts == null) return null;
        UUID id;
        try { id = UUID.fromString(parts[0]); } catch (IllegalArgumentException e) { return null; }
        var a = live.get(id);
        return a != null && a.owns(user, parts[1]) ? a : null;
    }

    /** Game side (memory only, safe under a game lock): READY → ACTIVE for this activity. Null when the attempt cannot be used. */
    public SentinelAttempt bind(long user, String handle, String activity, String subject) {
        var a = resolve(user, handle);
        if (a == null || !a.activity.equals(activity)) return null;
        if (a.state() == SentinelAttempt.State.ACTIVE) return a;
        var change = a.activate(subject, Instant.ofEpochMilli(now()), now());
        if (change == null) return null;
        store.writeLater(change);
        return a;
    }
    /** Game side: the contest's clock started. */
    public void playStarted(SentinelAttempt a, String subject) { if (a != null) a.playStarted(subject, now()); }
    /** Game side: an accepted scoring action. */
    public void action(SentinelAttempt a) { if (a != null) a.action(now()); }

    /**
     * Game side: completion of a contest that ended normally. Returns the decided state; the durable write is the caller's
     * ({@link #persist}) when a ranked row follows it, so the row is written only after its attempt is stored as verified.
     */
    public SentinelAttempt.Change complete(SentinelAttempt a) {
        if (a == null) return null;
        long t = now();
        return a.complete(Instant.ofEpochMilli(t), t);
    }
    public void persist(SentinelAttempt.Change change) { store.write(change); }
    public void persistLater(SentinelAttempt.Change change) { store.writeLater(change); }

    /** Game side (memory first, durable write queued; no listener call: the game applies it itself). */
    public SentinelAttempt.Change voidFromGame(SentinelAttempt a, SentinelAttempt.State to, String kind, String detail) {
        if (a == null) return null;
        return end(a, to, kind, detail, false);
    }

    private SentinelAttempt.Change end(SentinelAttempt a, SentinelAttempt.State to, String kind, String detail, boolean notify) {
        return end(a, to, kind, detail, notify, false);
    }
    /** Ends an attempt for a game rule (e.g. a PvP forfeit decided elsewhere), with listeners. */
    public SentinelAttempt.Change voidAndNotify(SentinelAttempt a, SentinelAttempt.State to, String kind, String detail) {
        return a == null ? null : end(a, to, kind, detail, true);
    }
    /** {@code durableNow}: written on the caller's thread (the learner's own report), queued only if that write fails. */
    private SentinelAttempt.Change end(SentinelAttempt a, SentinelAttempt.State to, String kind, String detail, boolean notify, boolean durableNow) {
        var change = a.end(to, kind, detail, Instant.ofEpochMilli(now()));
        if (change == null) return null;
        if (durableNow) {
            try { store.write(change); } catch (Exception e) { store.writeLater(change); }
        } else store.writeLater(change);
        if (notify && to.voided()) for (var l : voidListeners) try { l.accept(a); } catch (Exception ignored) { /* listener isolation */ }
        return change;
    }

    public record Status(UUID id, String state, String detail, boolean ranked) {}
    private static Status status(SentinelAttempt a) {
        var s = a.state();
        return new Status(a.id, s.name(), a.detail(), s == SentinelAttempt.State.COMPLETED_VERIFIED);
    }

    /** Page report: the attempt is on screen ({@code visible}) or not. Unknown id / wrong secret / other learner ⇒ 404. */
    public Status heartbeat(long user, UUID id, String token, boolean visible) {
        var a = owned(user, id, token);
        if (!visible) return violation(user, id, token, "HIDDEN");
        a.heartbeat(now());
        return status(a);
    }

    /** Page report of leaving: tab hidden, window left, page closing / reloading, navigation, explicit exit. */
    public Status violation(long user, UUID id, String token, String kind) {
        var a = owned(user, id, token);
        String k = Objects.toString(kind, "").toUpperCase(Locale.ROOT);
        var to = switch (k) {
            case "HIDDEN", "BLUR", "FULLSCREEN_EXIT" -> SentinelAttempt.State.VOIDED_FOCUS_LOSS;
            case "PAGEHIDE", "RELOAD" -> SentinelAttempt.State.VOIDED_RELOAD;
            case "NAVIGATION", "EXIT" -> SentinelAttempt.State.VOIDED_ABANDONED;
            default -> throw new Refusal("INVALID_REPORT", 400);
        };
        end(a, to, "PAGE_REPORT", k, true, true);
        return status(a);
    }

    public Status status(long user, UUID id, String token) { return status(owned(user, id, token)); }

    private SentinelAttempt owned(long user, UUID id, String token) {
        var a = id == null ? null : live.get(id);
        if (a == null || !a.owns(user, token)) throw new Refusal("ATTEMPT_NOT_FOUND", 404);
        return a;
    }

    /** Expires unbound attempts, ends attempts whose page went silent during play, forgets ended ones after a while. */
    public void sweep() {
        long t = now();
        for (var a : live.values()) {
            var s = a.state();
            if (s == SentinelAttempt.State.READY && t - a.createdAt.toEpochMilli() > SentinelPolicy.READY_TTL_MS)
                end(a, SentinelAttempt.State.EXPIRED, "EXPIRED", "NOT_STARTED", true);
            else if (s == SentinelAttempt.State.ACTIVE && a.playing() && a.silentFor(t) > SentinelPolicy.CONTINUITY_GRACE_MS)
                end(a, SentinelAttempt.State.VOIDED_CONTINUITY, "CONTINUITY_UNVERIFIED", "SILENT_" + a.silentFor(t), true);
            else if (s == SentinelAttempt.State.ACTIVE && !a.playing() && a.silentFor(t) > SentinelPolicy.READY_TTL_MS)
                end(a, SentinelAttempt.State.EXPIRED, "EXPIRED", "LOBBY_SILENT", true);
            else if (s.terminal() && a.endedAt() != null && t - a.endedAt().toEpochMilli() > SentinelPolicy.KEEP_ENDED_MS)
                live.remove(a.id, a);
        }
        begins.entrySet().removeIf(e -> { synchronized (e.getValue()) { return e.getValue().isEmpty() || t - e.getValue().peekLast() > 120_000; } });
    }

    public int liveCount() { return live.size(); }

    // ── Subjects: a contest object of another module (exam attempt, Card Blast run, PvP room) ─────────────────────────
    /** The learner's live attempt of this activity bound to this subject, newest first; null when none. */
    public SentinelAttempt findLive(long user, String activity, String subject) {
        SentinelAttempt best = null;
        for (var a : live.values())
            if (a.user == user && a.activity.equals(activity) && Objects.equals(a.subject(), subject)
                && (best == null || a.createdAt.isAfter(best.createdAt))) best = a;
        return best;
    }

    /**
     * READY → ACTIVE bound to {@code subject}, play starting now, written synchronously: for exams the database allows ONE
     * attempt per exam attempt (V120 unique index), so a reloaded page can never bind the same exam again.
     */
    public SentinelAttempt bindSubject(long user, String handle, String activity, String subject) {
        var a = resolve(user, handle);
        if (a == null || !a.activity.equals(activity) || a.state() != SentinelAttempt.State.READY) return null;
        long t = now();
        var change = a.activate(subject, Instant.ofEpochMilli(t), t);
        if (change == null) return null;
        try { store.write(change); }
        catch (Exception e) { end(a, SentinelAttempt.State.VOIDED_INTEGRITY_FAILURE, "BIND_REFUSED", "SUBJECT_ALREADY_BOUND", false); return null; }
        a.playStarted(subject, t);
        return a;
    }

    /**
     * A page opened a running subject without its secret (reload, new tab): a running attempt ends as VOIDED_RELOAD. Returns
     * the subject's attempt state (live, else stored) or null when no attempt was ever bound to it.
     */
    public Status reopen(long user, String activity, String subject) {
        var a = findLive(user, activity, subject);
        if (a != null) {
            if (!a.terminal()) end(a, SentinelAttempt.State.VOIDED_RELOAD, "REOPEN", "SECRET_ABSENT", true, true);
            return status(a);
        }
        var stored = store.stateOf(user, activity, subject);
        return stored == null ? null : new Status(stored.id(), stored.state(), stored.detail(), "COMPLETED_VERIFIED".equals(stored.state()));
    }

    /** Normal end of a subject's contest: completes the learner's running attempt and writes it now. Null when none ran. */
    public SentinelAttempt.Change completeSubject(long user, String activity, String subject) {
        var a = findLive(user, activity, subject);
        if (a == null) return null;
        var change = complete(a);
        if (change != null) {
            try { store.write(change); } catch (Exception e) { store.writeLater(change); }
        }
        return change;
    }
}
