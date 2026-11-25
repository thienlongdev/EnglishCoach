package com.englishcoach.premium.voucher;

import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;

/**
 * The account-wide AI voucher wallet (V87 {@code ai_voucher_grant} / {@code ai_voucher_use}).
 *
 * <p>A voucher is used only AFTER the included quota of a feature (free trial or Premium monthly limit) is exhausted:
 * the gating interceptor asks the existing quota first and comes here only when that refuses. One logical request
 * ({@code user, feature, request id}) holds at most one voucher: a retry with the same id finds its own row, whatever
 * its state, and takes no second credit. The credit is taken from the grant that expires first, held while the AI
 * request runs, kept when it produced a result and returned when it did not.</p>
 *
 * <p>Every method serialises on a per-user advisory lock, so two tabs cannot spend the same last credit.</p>
 */
@Slf4j
@Service
public class AiVoucherService {

    public record Grant(long id, int credits, int remaining, String source, Instant issuedAt, Instant expiresAt) {}

    public record Use(long id, String featureKey, String status, Instant createdAt, Instant completedAt) {}

    public record Wallet(int balance, Instant nextExpiry, List<Grant> grants, List<Use> recent, List<String> eligibleFeatures,
                         boolean spendingEnabled) {}

    /** Outcome of a voucher reservation distinguishing a newly held credit from an idempotent replay. */
    public record VoucherReservation(Long useId, boolean idempotentReplay) {}

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final AiVoucherProperties properties;
    private final Clock clock;

    @org.springframework.beans.factory.annotation.Autowired
    public AiVoucherService(JdbcTemplate jdbc, PlatformTransactionManager transactions, AiVoucherProperties properties) {
        this(jdbc, transactions, properties, Clock.systemUTC());
    }

    public AiVoucherService(JdbcTemplate jdbc, PlatformTransactionManager transactions, AiVoucherProperties properties, Clock clock) {
        this.jdbc = jdbc;
        this.tx = new TransactionTemplate(transactions);
        this.properties = properties;
        this.clock = clock;
    }

    private Instant now() {
        return clock.instant().truncatedTo(ChronoUnit.MICROS);
    }

    private void lock(long userId) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtext(?))", rs -> { }, "ai_voucher:" + userId);
    }

    private static Timestamp ts(Instant i) {
        return Timestamp.from(i);
    }

    public boolean eligible(String featureKey) {
        return properties.eligible(featureKey);
    }

    // ------------------------------------------------------------------ issuing (called inside the issuer's transaction)

    /** Credits of this source issued to the user since {@code since} (the rolling purchase cap of the issuer). */
    public int issuedSince(long userId, String source, Instant since) {
        Integer n = jdbc.queryForObject("""
                SELECT COALESCE(sum(credits), 0) FROM public.ai_voucher_grant WHERE user_id = ? AND source = ? AND issued_at > ?
                """, Integer.class, userId, source, ts(since));
        return n == null ? 0 : n;
    }

    /**
     * Issues one grant. Joins the caller's transaction (the garden debits Echo Coins in the same one). Idempotent on
     * {@code (user, source, sourceRef)}: a repeated issue returns the stored grant's id and adds nothing.
     */
    public long issue(long userId, int credits, String source, String sourceRef, Instant issuedAt, Duration validity) {
        var ids = jdbc.queryForList("""
                INSERT INTO public.ai_voucher_grant(user_id, credits, remaining, source, source_ref, issued_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, source, source_ref) DO NOTHING RETURNING id
                """, Long.class, userId, credits, credits, source, sourceRef, ts(issuedAt), ts(issuedAt.plus(validity)));
        if (!ids.isEmpty()) return ids.getFirst();
        return jdbc.queryForObject("SELECT id FROM public.ai_voucher_grant WHERE user_id = ? AND source = ? AND source_ref = ?",
                Long.class, userId, source, sourceRef);
    }

    // ------------------------------------------------------------------ wallet

    public int balance(long userId) {
        return balance(userId, now());
    }

    private int balance(long userId, Instant at) {
        Integer n = jdbc.queryForObject("""
                SELECT COALESCE(sum(remaining), 0) FROM public.ai_voucher_grant WHERE user_id = ? AND remaining > 0 AND expires_at > ?
                """, Integer.class, userId, ts(at));
        return n == null ? 0 : n;
    }

    public Wallet wallet(long userId) {
        Instant at = now();
        List<Grant> grants = jdbc.query("""
                SELECT id, credits, remaining, source, issued_at, expires_at FROM public.ai_voucher_grant
                WHERE user_id = ? ORDER BY expires_at DESC, id DESC LIMIT 30
                """, (rs, n) -> new Grant(rs.getLong(1), rs.getInt(2), rs.getInt(3), rs.getString(4),
                rs.getTimestamp(5).toInstant(), rs.getTimestamp(6).toInstant()), userId);
        List<Use> uses = jdbc.query("""
                SELECT id, feature_key, status, created_at, completed_at FROM public.ai_voucher_use
                WHERE user_id = ? ORDER BY id DESC LIMIT 30
                """, (rs, n) -> new Use(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getTimestamp(4).toInstant(),
                rs.getTimestamp(5) == null ? null : rs.getTimestamp(5).toInstant()), userId);
        Instant next = grants.stream().filter(g -> g.remaining() > 0 && g.expiresAt().isAfter(at)).map(Grant::expiresAt)
                .min(Instant::compareTo).orElse(null);
        return new Wallet(balance(userId, at), next, grants, uses, List.copyOf(properties.getEligibleFeatures()), properties.isSpendingEnabled());
    }

    // ------------------------------------------------------------------ spending

    /** A retried request may run again on the voucher it already holds this many times, this soon after its first attempt. */
    static final int MAX_REPLAYS = 2;
    static final Duration REPLAY_WINDOW = Duration.ofMinutes(10);

    /**
     * Holds one voucher for a request whose included quota is exhausted.
     *
     * @return the id of the use row, or {@code null} when no voucher may pay (feature not eligible, spending off, no
     * unexpired credit).
     *
     * <p>An in-flight {@code RESERVED} row for the same {@code (user, feature, requestId)} always fails closed with
     * {@code 409 Conflict (AI_REQUEST_IN_FLIGHT)} so a concurrent request can never release another request's credit.</p>
     */
    public Long reserve(long userId, String featureKey, String requestId) {
        return reserveInternal(userId, featureKey, requestId, MAX_REPLAYS).useId();
    }

    /**
     * Holds one fresh voucher for an interceptor-managed HTTP request (EC-SEC-2026-002): zero free replays on
     * unverified client request IDs, and fails closed with {@code 409 Conflict (AI_REQUEST_IN_FLIGHT)} if an in-flight
     * {@code RESERVED} row already exists.
     */
    public VoucherReservation reserveForInterceptor(long userId, String featureKey, String requestId) {
        return reserveInternal(userId, featureKey, requestId, 0);
    }

    private VoucherReservation reserveInternal(long userId, String featureKey, String requestId, int maxReplays) {
        if (!properties.eligible(featureKey)) return new VoucherReservation(null, false);
        String rid = requestId == null || requestId.isBlank() ? UUID.randomUUID().toString() : requestId.trim();
        final String key = rid.length() > 100 ? rid.substring(0, 100) : rid;
        return tx.execute(status -> {
            lock(userId);
            Instant at = now();
            releaseStale(userId, at);
            var existing = jdbc.query("""
                    SELECT id, status, replays, created_at FROM public.ai_voucher_use WHERE user_id = ? AND feature_key = ? AND request_id = ?
                    """, (rs, n) -> new Object[]{rs.getLong(1), rs.getString(2), rs.getInt(3), rs.getTimestamp(4).toInstant()},
                    userId, featureKey, key);
            String useKey = key;
            Long reuse = null;
            if (!existing.isEmpty()) {
                Object[] e = existing.getFirst();
                String existingStatus = (String) e[1];
                if ("RESERVED".equals(existingStatus)) {
                    log.warn("[AiVoucher] Rejecting concurrent in-flight voucher reservation conflict for user={}, feature={}", userId, featureKey);
                    throw new ResponseStatusException(HttpStatus.CONFLICT, "AI_REQUEST_IN_FLIGHT");
                }
                if ("RELEASED".equals(existingStatus)) {
                    reuse = (Long) e[0];
                } else if (maxReplays > 0 && (Integer) e[2] < maxReplays && ((Instant) e[3]).isAfter(at.minus(REPLAY_WINDOW))) {
                    jdbc.update("UPDATE public.ai_voucher_use SET replays = replays + 1 WHERE id = ?", e[0]);
                    return new VoucherReservation((Long) e[0], true);
                } else {
                    // Beyond replay bound (or interceptor-managed zero-replay policy): a new operation requiring a new credit
                    String suffix = "~" + UUID.randomUUID().toString().substring(0, 8);
                    useKey = (key.length() > 119 ? key.substring(0, 119) : key) + suffix;
                }
            }
            var grant = jdbc.queryForList("""
                    UPDATE public.ai_voucher_grant SET remaining = remaining - 1
                    WHERE id = (SELECT id FROM public.ai_voucher_grant WHERE user_id = ? AND remaining > 0 AND expires_at > ?
                                ORDER BY expires_at, id LIMIT 1)
                      AND remaining > 0
                    RETURNING id
                    """, Long.class, userId, ts(at));
            if (grant.isEmpty()) return new VoucherReservation(null, false);
            if (reuse != null) {
                jdbc.update("""
                        UPDATE public.ai_voucher_use SET grant_id = ?, status = 'RESERVED', replays = 0, created_at = ?, completed_at = NULL WHERE id = ?
                        """, grant.getFirst(), ts(at), reuse);
                return new VoucherReservation(reuse, false);
            }
            Long id = jdbc.queryForObject("""
                    INSERT INTO public.ai_voucher_use(user_id, grant_id, feature_key, request_id, status, created_at)
                    VALUES (?, ?, ?, ?, 'RESERVED', ?) RETURNING id
                    """, Long.class, userId, grant.getFirst(), featureKey, useKey, ts(at));
            return new VoucherReservation(id, false);
        });
    }

    /** The AI request produced a result: the held voucher is spent. Idempotent. */
    public void consume(Long useId) {
        if (useId == null) return;
        jdbc.update("UPDATE public.ai_voucher_use SET status = 'CONSUMED', completed_at = ? WHERE id = ? AND status = 'RESERVED'", ts(now()), useId);
    }

    /** The AI request produced nothing: the held voucher goes back to its grant. Idempotent. */
    public void release(Long useId) {
        if (useId == null) return;
        tx.executeWithoutResult(status -> {
            var rows = jdbc.queryForList("SELECT user_id FROM public.ai_voucher_use WHERE id = ?", Long.class, useId);
            if (rows.isEmpty()) return;
            lock(rows.getFirst());
            giveBack(useId, now());
        });
    }

    private void giveBack(long useId, Instant at) {
        var grant = jdbc.queryForList("""
                UPDATE public.ai_voucher_use SET status = 'RELEASED', completed_at = ? WHERE id = ? AND status = 'RESERVED' RETURNING grant_id
                """, Long.class, ts(at), useId);
        if (!grant.isEmpty()) {
            jdbc.update("UPDATE public.ai_voucher_grant SET remaining = remaining + 1 WHERE id = ? AND remaining < credits", grant.getFirst());
        }
    }

    /** A request that crashed between reserving and reporting must not keep the player's voucher for ever. */
    private void releaseStale(long userId, Instant at) {
        Instant cutoff = at.minus(Duration.ofMinutes(Math.max(5, properties.getStaleReservationMinutes())));
        for (Long id : jdbc.queryForList("SELECT id FROM public.ai_voucher_use WHERE user_id = ? AND status = 'RESERVED' AND created_at < ?",
                Long.class, userId, ts(cutoff))) {
            log.info("[AiVoucher] releasing stale reservation #{} of user {}", id, userId);
            giveBack(id, at);
        }
    }
}
