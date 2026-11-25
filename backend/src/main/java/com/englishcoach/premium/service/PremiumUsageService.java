package com.englishcoach.premium.service;

import com.englishcoach.common.cache.BoundedTtlCache;
import com.englishcoach.common.scheduling.SlowJobsSchedulerConfig;
import com.englishcoach.premium.config.PremiumProperties;
import com.englishcoach.premium.entity.PremiumAiUsage;
import com.englishcoach.premium.entity.PremiumFeatureDefinition;
import com.englishcoach.premium.exception.PremiumDailyLimitReachedException;
import com.englishcoach.premium.exception.PremiumLimitReachedException;
import com.englishcoach.premium.exception.PremiumRequiredException;
import com.englishcoach.premium.repository.PremiumAiUsageRepository;
import com.englishcoach.premium.repository.PremiumFeatureDefinitionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

/**
 * The one usage ledger ({@code premium_ai_usage}) of every metered feature.
 *
 * <p>Free accounts (owner policy 2026-10-18) have three daily allowances that renew at local midnight
 * ({@code app.premium.time-zone}, Asia/Ho_Chi_Minh) — no reset job: an allowance counts the ledger rows created since the
 * start of the local day, so history is never deleted or rewritten:
 * <ul>
 *   <li>{@link Pool#AI} — {@code app.premium.free-daily-ai-limit} (3) uses a day SHARED by every gated AI feature;</li>
 *   <li>{@link Pool#COACH} — {@code free-daily-coach-messages} (10) Echo Coach messages, separate from the AI pool;</li>
 *   <li>{@link Pool#BOOK} — {@code free-daily-book-imports} (1) new My Books imports.</li>
 * </ul>
 * Premium accounts keep their existing rules: each AI feature's monthly fair-use limit; no daily Coach or book cap.
 *
 * <p>Reservation is atomic per account and pool (JVM lock + transaction-scoped advisory lock), so parallel requests
 * from several tabs or devices cannot overspend. A reservation is RESERVED, then COMPLETED (charged) or RELEASED (given
 * back); RESERVED counts as used. The same request id is one charge (idempotent replay); a released request id that is
 * used again is re-reserved in place (counted on the day of its new use).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PremiumUsageService {

    public static final String EXAM_AI_SCORING = "EXAM_AI_SCORING";

    public boolean hasExamReservation(long userId, long reservationId) {
        return usageRepository.findById(reservationId).filter(row -> Objects.equals(row.getUserId(), userId)
                && EXAM_AI_SCORING.equals(row.getFeatureKey()) && "PREMIUM".equals(row.getUsageKind())
                && "RESERVED".equals(row.getStatus())).isPresent();
    }

    public static final String COACH_CHAT = "COACH_CHAT";
    public static final String MY_BOOKS_IMPORT = "MY_BOOKS_IMPORT";

    /** The free daily allowances. */
    public enum Pool { AI, COACH, BOOK }

    /** A free daily allowance as the account sees it now. */
    public record DailyAllowance(Pool pool, int limit, int used, Instant resetsAt) {
        public int remaining() { return Math.max(0, limit - used); }
    }

    /** Outcome of a My Books import request: which book fingerprints may be added now. */
    public record BookGrant(List<String> granted, List<String> refused, DailyAllowance allowance, boolean unlimited) {}

    /** Outcome of a usage reservation distinguishing a newly created RESERVED hold from a settled COMPLETED replay. */
    public record ReservationResult(Long reservationId, boolean idempotentReplay) {}

    /** My Books' own book fingerprint ("<bytes>:<40 hex of SHA-256 over head + tail>") or a plain hex digest. */
    private static final Pattern FINGERPRINT = Pattern.compile("[0-9a-f]{16,120}|[0-9]{1,15}:[0-9a-f]{40}");

    private final PremiumAiUsageRepository usageRepository;
    private final PremiumFeatureDefinitionRepository featureDefinitionRepository;
    private final PremiumProperties properties;

    @Autowired(required = false)
    private JdbcTemplate jdbcTemplate;

    // Fixed-size striped locks for JVM thread serialization (zero heap growth across accounts/features).
    private static final int LOCK_STRIPES = 256;
    private static final int ADVISORY_LOCK_NAMESPACE = 92133;
    private final ReentrantLock[] lockStripes = createLockStripes();

    // Static feature catalog (~15 rows): cached 10 minutes (2-min negative TTL) to avoid 1 DB RTT per gated AI call.
    private final BoundedTtlCache<String, PremiumFeatureDefinition> featureDefinitionCache =
            new BoundedTtlCache<>(64, Duration.ofMinutes(10).toMillis(), Duration.ofMinutes(2).toMillis());

    /**
     * Strict allowlist of synchronous {@code @RequirePremiumAi} interceptor-managed features eligible for
     * stale {@code RESERVED} recovery after {@value #STALE_RESERVATION_MINUTES} minutes.
     * Async / durable-receipt / client-held features ({@code MY_BOOKS_IMPORT}, {@code EXAM_AI_SCORING},
     * {@code LISTENING_YOUTUBE_IMPORT}, {@code LISTENING_DOCUMENT_IMPORT}, {@code WRITING_ASSESSMENT},
     * {@code GRAMMAR_PROFESSOR}, {@code ECHO_ANYWHERE}, {@code COACH_CHAT}) are strictly EXCLUDED.
     */
    static final List<String> SYNC_REAPABLE_FEATURES = List.of(
            "SPEAKING_ROLEPLAY",
            "SPEAKING_PRONUNCIATION",
            "SPEAKING_SHADOWING",
            "SPEAKING_QUICK_CHECK",
            "WRITING_AI_FEEDBACK",
            "READING_CONTEXT_EXPLANATION",
            "TRANSLATION_AI_GRADING",
            "FLASHCARD_FUSION_CHECK",
            "FLASHCARD_MEMORY_FORGE",
            "FLASHCARD_AI_STUDIO"
    );
    static final int STALE_RESERVATION_MINUTES = 15;

    private static final List<String> ACTIVE_STATUSES = List.of("RESERVED", "COMPLETED");

    private static ReentrantLock[] createLockStripes() {
        ReentrantLock[] stripes = new ReentrantLock[LOCK_STRIPES];
        for (int i = 0; i < LOCK_STRIPES; i++) {
            stripes[i] = new ReentrantLock();
        }
        return stripes;
    }

    private ReentrantLock stripeLock(String lockKey) {
        return lockStripes[Math.floorMod(lockKey.hashCode(), LOCK_STRIPES)];
    }

    public PremiumFeatureDefinition getFeatureDefinition(String featureKey) {
        if (featureKey == null || featureKey.isBlank()) {
            return null;
        }
        return featureDefinitionCache.getOrNull(
                featureKey,
                key -> featureDefinitionRepository.findByFeatureKey(key).orElse(null)
        );
    }

    public void evictFeatureDefinitionCache() {
        featureDefinitionCache.clear();
    }

    public static Pool poolOf(String featureKey) {
        if (COACH_CHAT.equals(featureKey)) return Pool.COACH;
        if (MY_BOOKS_IMPORT.equals(featureKey)) return Pool.BOOK;
        return Pool.AI;
    }

    public int dailyLimit(Pool pool) {
        return switch (pool) {
            case AI -> Math.max(0, properties.getFreeDailyAiLimit());
            case COACH -> Math.max(0, properties.getFreeDailyCoachMessages());
            case BOOK -> Math.max(0, properties.getFreeDailyBookImports());
        };
    }

    public String getCurrentBillingCycleMonth() {
        ZoneId zoneId = properties.getZoneId();
        return LocalDate.now(zoneId).format(DateTimeFormatter.ofPattern("yyyy-MM"));
    }

    /** Start of the current local day (the allowance boundary). */
    public Instant dayStart() {
        ZoneId zone = properties.getZoneId();
        return LocalDate.now(zone).atStartOfDay(zone).toInstant();
    }

    /** Next local midnight: when the free daily allowances renew. */
    public Instant nextReset() {
        ZoneId zone = properties.getZoneId();
        return LocalDate.now(zone).plusDays(1).atStartOfDay(zone).toInstant();
    }

    /** The three free daily allowances of one account (one statement). */
    @Transactional(readOnly = true)
    public Map<Pool, DailyAllowance> dailyAllowances(Long userId) {
        Map<Pool, Integer> used = new EnumMap<>(Pool.class);
        if (userId != null) {
            for (Object[] row : usageRepository.countTrialPerFeatureSince(userId, ACTIVE_STATUSES, dayStart())) {
                used.merge(poolOf((String) row[0]), ((Number) row[1]).intValue(), Integer::sum);
            }
        }
        Instant reset = nextReset();
        Map<Pool, DailyAllowance> out = new EnumMap<>(Pool.class);
        for (Pool p : Pool.values()) out.put(p, new DailyAllowance(p, dailyLimit(p), used.getOrDefault(p, 0), reset));
        return out;
    }

    /**
     * Atomically reserves a usage unit (TRIAL or PREMIUM) before an expensive operation.
     *
     * @return reservation id, or null when the request is not metered (a feature that needs no Premium, or a Premium
     *         account on the Coach / book allowance, which keep their existing rules)
     */
    @Transactional(isolation = Isolation.READ_COMMITTED, noRollbackFor = PremiumLimitReachedException.class)
    public Long reserveUsage(Long userId, String featureKey, String clientRequestId, boolean isPremium) {
        return doReserveUsage(userId, featureKey, clientRequestId, isPremium).reservationId();
    }

    /**
     * Atomically reserves a usage unit and reports whether the returned id is a replay of an already COMPLETED row.
     * An in-flight {@code RESERVED} row for the same {@code (userId, featureKey, requestId)} is never returned as a
     * replay; it fails closed with {@code 409 Conflict (AI_REQUEST_IN_FLIGHT)} so a concurrent request can never
     * release another request's active reservation.
     */
    @Transactional(isolation = Isolation.READ_COMMITTED, noRollbackFor = PremiumLimitReachedException.class)
    public ReservationResult reserveUsageWithReplayStatus(Long userId, String featureKey, String clientRequestId, boolean isPremium) {
        return doReserveUsage(userId, featureKey, clientRequestId, isPremium);
    }

    private ReservationResult doReserveUsage(Long userId, String featureKey, String clientRequestId, boolean isPremium) {
        if (userId == null) {
            throw new IllegalArgumentException("User ID cannot be null for usage reservation");
        }
        if (EXAM_AI_SCORING.equals(featureKey) && !isPremium) {
            throw new PremiumRequiredException(featureKey, 0, "/premium", "Chấm bài thi bằng AI cần Premium.", null);
        }
        Pool pool = poolOf(featureKey);
        if (pool == Pool.BOOK && isPremium) {
            return new ReservationResult(null, false); // Premium: My Books has no daily cap (Echo messages ARE metered: daily + monthly, owner 2026-11-20)
        }

        PremiumFeatureDefinition feature = getFeatureDefinition(featureKey);
        // A feature that does not need Premium (e.g. speech synthesis) is not metered; the Coach and book allowances are
        if (pool == Pool.AI && feature != null && !feature.isPremiumRequired()) {
            return new ReservationResult(null, false);
        }

        String effectiveRequestId = (clientRequestId != null && !clientRequestId.isBlank())
                ? clientRequestId.trim()
                : UUID.randomUUID().toString();

        // Unified per-user pool lock key so both Free and Premium reservations (and Free->Premium upgrade races) serialize cleanly.
        String lockKey = userId + ":pool:" + pool;
        ReentrantLock threadLock = stripeLock(lockKey);
        threadLock.lock();
        try {
            advisoryLock(lockKey);

            // 1. Idempotency & in-flight conflict protection (EC-SEC-2026-002)
            Optional<PremiumAiUsage> existingOpt = usageRepository
                    .findByUserIdAndFeatureKeyAndRequestId(userId, featureKey, effectiveRequestId);
            if (existingOpt.isPresent()) {
                String existingStatus = existingOpt.get().getStatus();
                if ("RESERVED".equals(existingStatus)) {
                    log.warn("Rejecting concurrent in-flight reservation conflict for user={}, feature={}", userId, featureKey);
                    throw new ResponseStatusException(HttpStatus.CONFLICT, "AI_REQUEST_IN_FLIGHT");
                }
                if ("COMPLETED".equals(existingStatus)) {
                    log.info("Idempotent replay detected for user={}, feature={}, status=COMPLETED", userId, featureKey);
                    return new ReservationResult(existingOpt.get().getId(), true);
                }
            }

            String currentMonth = getCurrentBillingCycleMonth();
            String kind;
            if (isPremium) {
                if (pool == Pool.COACH) {
                    int dailyLimit = premiumDailyCoachLimit();
                    int dailyUsed = premiumCoachUsedToday(userId);
                    if (dailyUsed >= dailyLimit) {
                        log.info("Premium user {} used the daily Echo allowance ({}/{})", userId, dailyUsed, dailyLimit);
                        throw new PremiumDailyLimitReachedException(featureKey, dailyLimit, nextReset());
                    }
                }
                int monthlyLimit = (feature != null) ? feature.getPremiumMonthlyLimit() : (pool == Pool.COACH ? 500 : 300);
                int monthlyUsed = usageRepository.countByUserIdAndFeatureKeyAndUsageKindAndBillingCycleMonthAndStatusIn(
                        userId, featureKey, "PREMIUM", currentMonth, ACTIVE_STATUSES);
                if (monthlyUsed >= monthlyLimit) {
                    log.warn("Premium user {} reached monthly limit of {} for feature {}", userId, monthlyLimit, featureKey);
                    throw new PremiumLimitReachedException(featureKey, monthlyLimit, 0);
                }
                kind = "PREMIUM";
            } else {
                int limit = dailyLimit(pool);
                int used = usedToday(userId, pool);
                if (used >= limit) {
                    log.info("Free user {} used the daily {} allowance ({}/{}) — feature {}", userId, pool, used, limit, featureKey);
                    throw exhausted(pool, featureKey, limit);
                }
                kind = "TRIAL";
            }

            // 2. A released request id used again is re-reserved in place (one row per user + feature + request)
            if (existingOpt.isPresent()) {
                if (usageRepository.reactivate(existingOpt.get().getId(), kind, currentMonth) == 1) {
                    return new ReservationResult(existingOpt.get().getId(), false);
                }
                // lost a race with another state change of that row: read it again
                PremiumAiUsage reloaded = usageRepository.findByUserIdAndFeatureKeyAndRequestId(userId, featureKey, effectiveRequestId)
                        .orElseThrow(() -> exhausted(pool, featureKey, dailyLimit(pool)));
                if ("RESERVED".equals(reloaded.getStatus())) {
                    throw new ResponseStatusException(HttpStatus.CONFLICT, "AI_REQUEST_IN_FLIGHT");
                }
                if ("COMPLETED".equals(reloaded.getStatus())) {
                    return new ReservationResult(reloaded.getId(), true);
                }
                throw exhausted(pool, featureKey, dailyLimit(pool));
            }
            PremiumAiUsage saved = usageRepository.save(PremiumAiUsage.builder()
                    .userId(userId)
                    .featureKey(featureKey)
                    .usageKind(kind)
                    .requestId(effectiveRequestId)
                    .status("RESERVED")
                    .billingCycleMonth(currentMonth)
                    .build());
            log.info("Reserved {} usage #{} for user={}, feature={}", kind, saved.getId(), userId, featureKey);
            return new ReservationResult(saved.getId(), false);
        } finally {
            threadLock.unlock();
        }
    }

    public int premiumDailyCoachLimit() { return Math.max(0, properties.getPremiumDailyCoachMessages()); }

    /** A feature's Premium monthly allowance from its catalogue row (Echo: 500 since V36). */
    public int premiumMonthlyLimit(String featureKey) {
        PremiumFeatureDefinition def = getFeatureDefinition(featureKey);
        return def != null ? def.getPremiumMonthlyLimit() : (COACH_CHAT.equals(featureKey) ? 500 : 300);
    }

    /** Premium Echo messages counted today (reserved or completed), for the daily Premium cap and the account's view. */
    public int premiumCoachUsedToday(Long userId) {
        if (userId == null) return 0;
        return usageRepository.countByUserIdAndFeatureKeyAndUsageKindAndStatusInAndCreatedAtGreaterThanEqual(
                userId, COACH_CHAT, "PREMIUM", ACTIVE_STATUSES, dayStart());
    }

    /** The account's allowances; for a Premium account the COACH entry is its Premium daily Echo allowance. */
    @Transactional(readOnly = true)
    public Map<Pool, DailyAllowance> dailyAllowances(Long userId, boolean premium) {
        Map<Pool, DailyAllowance> out = dailyAllowances(userId);
        if (premium && userId != null) {
            out = new EnumMap<>(out);
            out.put(Pool.COACH, new DailyAllowance(Pool.COACH, premiumDailyCoachLimit(), premiumCoachUsedToday(userId), nextReset()));
        }
        return out;
    }

    private int usedToday(Long userId, Pool pool) {
        int used = 0;
        for (Object[] row : usageRepository.countTrialPerFeatureSince(userId, ACTIVE_STATUSES, dayStart())) {
            if (poolOf((String) row[0]) == pool) used += ((Number) row[1]).intValue();
        }
        return used;
    }

    private PremiumRequiredException exhausted(Pool pool, String featureKey, int limit) {
        String message = switch (pool) {
            case AI -> "Bạn đã dùng hết " + limit + " lượt AI miễn phí hôm nay. Lượt miễn phí làm mới vào 0:00; "
                    + "nâng cấp Premium nếu muốn dùng thêm.";
            case COACH -> "Bạn đã dùng hết " + limit + " tin nhắn Echo Coach miễn phí hôm nay. Lượt mới có vào 0:00.";
            case BOOK -> "Tài khoản miễn phí nhập được " + limit + " cuốn sách mỗi ngày. Bạn có thể nhập tiếp vào ngày mai.";
        };
        return new PremiumRequiredException(featureKey, 0, "/premium", message, nextReset());
    }

    private void advisoryLock(String lockKey) {
        // PostgreSQL transactional advisory lock for cross-process concurrency (Docker containers).
        // Skipped only when jdbcTemplate is unwired (pure Mockito unit tests); on PostgreSQL any lock failure fails closed.
        if (jdbcTemplate == null) return;
        jdbcTemplate.query("SELECT pg_advisory_xact_lock(?, hashtext(?))", rs -> null, ADVISORY_LOCK_NAMESPACE, lockKey);
    }

    /**
     * Periodically releases orphaned {@code RESERVED} rows for strictly allowlisted synchronous
     * {@code @RequirePremiumAi} features whose HTTP requests crashed or timed out before {@code afterCompletion}.
     * Uses {@code UPDATE ... SET status = 'RELEASED'} only (V137 forbids {@code DELETE}).
     */
    @Scheduled(fixedDelay = 300_000L, initialDelay = 120_000L, scheduler = SlowJobsSchedulerConfig.SCHEDULER_BEAN)
    @Transactional
    public int releaseStaleSyncReservations() {
        Instant cutoff = Instant.now().minusSeconds(STALE_RESERVATION_MINUTES * 60L);
        int released = usageRepository.releaseStaleSyncReservations(cutoff, SYNC_REAPABLE_FEATURES);
        if (released > 0) {
            log.warn("Released {} stale RESERVED sync AI usage rows older than {} minutes",
                    released, STALE_RESERVATION_MINUTES);
        }
        return released;
    }

    // ── My Books (the books stay on the device; the server only counts new imports) ──────────────────────────────

    /**
     * Grants new My Books imports. A book is identified by the library's own content fingerprint of its file (size +
     * SHA-256 of its first and last 64 KiB; renaming changes nothing). A fingerprint already granted to this account (any day, also when the book was deleted since) is granted
     * again without a new charge: it is the same book, never an extra one. A new fingerprint takes one unit of the free
     * daily allowance, as a RESERVATION that the client completes after the book was stored or releases when storing
     * failed (a failed import does not cost the day's import; see {@link #releaseBookImports} for the bounds). The
     * books are on the device: a modified client can skip these calls or reuse a known fingerprint, which no server
     * check can see; this is product policy for the normal app, not a resource guard. Premium accounts have no daily cap (their imports are still
     * recorded, so a book stays "known" if Premium ends). One lock per account: two tabs cannot both take the last unit.
     */
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public BookGrant grantBookImports(Long userId, List<String> fingerprints, boolean isPremium) {
        if (userId == null) throw new IllegalArgumentException("User ID cannot be null for a book import");
        List<String> wanted = normalized(fingerprints);
        String lockKey = userId + ":pool:" + Pool.BOOK;
        ReentrantLock threadLock = stripeLock(lockKey);
        threadLock.lock();
        try {
            advisoryLock(lockKey);
            List<String> granted = new ArrayList<>(), refused = new ArrayList<>();
            int limit = dailyLimit(Pool.BOOK);
            int used = isPremium ? 0 : usedToday(userId, Pool.BOOK);
            String month = getCurrentBillingCycleMonth();
            for (String fp : wanted) {
                String requestId = "fp:" + fp;
                Optional<PremiumAiUsage> existing = usageRepository.findByUserIdAndFeatureKeyAndRequestId(userId, MY_BOOKS_IMPORT, requestId);
                if (existing.isPresent() && ACTIVE_STATUSES.contains(existing.get().getStatus())) {
                    granted.add(fp);
                    continue;
                }
                if (!isPremium && used >= limit) {
                    refused.add(fp);
                    continue;
                }
                String kind = isPremium ? "PREMIUM" : "TRIAL";
                if (existing.isPresent()) {
                    if (usageRepository.reactivate(existing.get().getId(), kind, month) != 1) { refused.add(fp); continue; }
                } else {
                    usageRepository.save(PremiumAiUsage.builder().userId(userId).featureKey(MY_BOOKS_IMPORT).usageKind(kind)
                            .requestId(requestId).status("RESERVED").billingCycleMonth(month).build());
                }
                if (!isPremium) used++;
                granted.add(fp);
            }
            DailyAllowance allowance = new DailyAllowance(Pool.BOOK, limit, isPremium ? 0 : used, nextReset());
            return new BookGrant(granted, refused, allowance, isPremium);
        } finally {
            threadLock.unlock();
        }
    }

    /** The client stored these granted books: their reservations become COMPLETED (deleting a book later gives nothing back). */
    @Transactional
    public int completeBookImports(Long userId, List<String> fingerprints) {
        return settleBooks(userId, fingerprints, "COMPLETED");
    }

    /**
     * Storing these granted books failed on the device: their open reservations are given back — but only as the app
     * does it (right after the failed store) and only {@value #BOOK_RELEASES_PER_DAY} a day: a reservation older than
     * {@value #BOOK_RELEASE_WINDOW_MINUTES} minutes, or beyond today's give-backs, is kept as used (COMPLETED). A
     * client that "releases" every book it stored therefore gains at most one extra book a day; a real storage failure
     * still costs nothing, and the same book is granted again for free once its reservation is kept.
     */
    @Transactional
    public int releaseBookImports(Long userId, List<String> fingerprints) {
        return settleBooks(userId, fingerprints, "RELEASED");
    }

    static final int BOOK_RELEASES_PER_DAY = 1;
    static final int BOOK_RELEASE_WINDOW_MINUTES = 30;

    private int settleBooks(Long userId, List<String> fingerprints, String status) {
        if (userId == null) return 0;
        List<String> fps = normalized(fingerprints);
        boolean release = "RELEASED".equals(status);
        ReentrantLock threadLock = null;
        String lockKey = null;
        if (release) { // give-backs are counted per account: the same lock as the grants
            lockKey = userId + ":pool:" + Pool.BOOK;
            threadLock = stripeLock(lockKey);
            threadLock.lock();
        }
        try {
            if (lockKey != null) {
                advisoryLock(lockKey);
            }
            int changed = 0;
            int givenBack = release ? usageRepository.countByUserIdAndFeatureKeyAndStatusAndCreatedAtGreaterThanEqual(
                    userId, MY_BOOKS_IMPORT, "RELEASED", dayStart()) : 0;
            Instant oldest = Instant.now().minusSeconds(BOOK_RELEASE_WINDOW_MINUTES * 60L);
            for (String fp : fps) {
                Optional<PremiumAiUsage> row = usageRepository.findByUserIdAndFeatureKeyAndRequestId(userId, MY_BOOKS_IMPORT, "fp:" + fp);
                if (row.isEmpty() || !"RESERVED".equals(row.get().getStatus())) continue;
                PremiumAiUsage usage = row.get();
                boolean giveBack = release && givenBack < BOOK_RELEASES_PER_DAY
                        && usage.getCreatedAt() != null && usage.getCreatedAt().isAfter(oldest);
                if (giveBack) {
                    usage.setStatus("RELEASED");
                    givenBack++;
                    changed++;
                } else {
                    usage.setStatus("COMPLETED"); // stored, or a give-back the rules above do not allow: kept as used
                    usage.setCompletedAt(Instant.now());
                    if (!release) changed++;
                }
                usageRepository.save(usage);
            }
            return changed;
        } finally {
            if (threadLock != null) threadLock.unlock();
        }
    }

    private static List<String> normalized(List<String> fingerprints) {
        if (fingerprints == null) return List.of();
        LinkedHashSet<String> out = new LinkedHashSet<>();
        for (String fp : fingerprints) {
            String v = fp == null ? "" : fp.trim().toLowerCase(Locale.ROOT);
            if (!FINGERPRINT.matcher(v).matches()) throw new IllegalArgumentException("INVALID_FINGERPRINT");
            out.add(v);
            if (out.size() > 50) throw new IllegalArgumentException("TOO_MANY_BOOKS");
        }
        return List.copyOf(out);
    }

    /**
     * Commits a reserved usage unit after the AI operation successfully completes.
     */
    @Transactional
    public void commitReservation(Long reservationId) {
        if (reservationId == null) return;
        usageRepository.findById(reservationId).ifPresent(usage -> {
            if ("RESERVED".equals(usage.getStatus())) {
                usage.setStatus("COMPLETED");
                usage.setCompletedAt(Instant.now());
                usageRepository.save(usage);
                log.info("Committed reservation #{} for user={}, feature={}",
                        reservationId, usage.getUserId(), usage.getFeatureKey());
            }
        });
    }

    /**
     * Releases a reserved usage unit if the AI operation fails or aborts.
     * Idempotent: safe to call multiple times.
     */
    @Transactional
    public void releaseReservation(Long reservationId) {
        if (reservationId == null) return;
        usageRepository.findById(reservationId).ifPresent(usage -> {
            if ("RESERVED".equals(usage.getStatus())) {
                usage.setStatus("RELEASED");
                usageRepository.save(usage);
                log.info("Released reservation #{} for user={}, feature={}",
                        reservationId, usage.getUserId(), usage.getFeatureKey());
            }
        });
    }

    /** Completed lifetime trial uses of one user, per feature key (a feature without any is absent), in one statement. */
    @Transactional(readOnly = true)
    public Map<String, Integer> getLifetimeTrialUsedByFeature(Long userId) {
        return perFeature(usageRepository.countPerFeature(userId, "TRIAL", List.of("COMPLETED")));
    }

    /** Completed Premium uses of one user in one billing month, per feature key, in one statement. */
    @Transactional(readOnly = true)
    public Map<String, Integer> getMonthlyPremiumUsedByFeature(Long userId, String billingCycleMonth) {
        return perFeature(usageRepository.countPerFeatureInMonth(userId, "PREMIUM", billingCycleMonth, List.of("COMPLETED")));
    }

    private static Map<String, Integer> perFeature(List<Object[]> rows) {
        Map<String, Integer> counts = new HashMap<>();
        for (Object[] row : rows) {
            counts.put((String) row[0], ((Number) row[1]).intValue());
        }
        return counts;
    }
}
