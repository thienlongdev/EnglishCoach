package com.englishcoach.premium.promo;

import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumSubscriptionService;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;

/**
 * A time-bounded promotional Premium entitlement — a real {@code premium_subscriptions} row on an inactive plan that is
 * never listed or sold (the pattern of the administrator's manual grant, V68). It is never a payment: no
 * {@code payment_orders} / {@code payment_transactions} row is written and no billing history changes.
 *
 * <p>Entitlement checks are unchanged — any ACTIVE subscription whose window contains "now" counts — so the reward
 * unlocks exactly what a paid month unlocks and ends by its own {@code expires_at}. It is independent of every other
 * row: its expiry revokes nothing else, and a plan bought later starts when the latest active window ends
 * ({@code PremiumSubscriptionService#extendOrActivateSubscription}), so paid time is never shortened.</p>
 *
 * <p>Plain JDBC on purpose: the caller (the garden's redemption) runs one transaction that also debits Echo Coins and
 * reserves the issuance budget; this insert joins it and rolls back with it.</p>
 */
@Service
public class PromoPremiumService {

    private final JdbcTemplate jdbc;

    @Autowired(required = false)
    private ObjectProvider<PremiumEntitlementService> entitlementService;

    public PromoPremiumService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private void invalidateEntitlementCache(long userId) {
        if (entitlementService == null) return;
        Runnable evict = () -> {
            PremiumEntitlementService svc = entitlementService.getIfAvailable();
            if (svc != null) svc.invalidatePremiumCache(userId);
        };
        evict.run();
        if (TransactionSynchronizationManager.isActualTransactionActive()
                && TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() { evict.run(); }
            });
        }
    }

    /** Any Premium window that is active now or still to come, whatever its source (paid, admin grant, reward). */
    public boolean hasActiveOrUpcomingEntitlement(long userId, Instant now) {
        Integer n = jdbc.queryForObject("""
                SELECT count(*) FROM public.premium_subscriptions
                WHERE user_id = ? AND status = 'ACTIVE' AND expires_at > ?
                """, Integer.class, userId, Timestamp.from(now));
        return n != null && n > 0;
    }

    /**
     * Grants {@code hours} of Premium starting at {@code startsAt} on the inactive plan {@code planCode}.
     *
     * @return the id of the subscription row
     * @throws IllegalStateException when the plan is missing or — wrongly — purchasable
     */
    public long grant(long userId, String planCode, String source, Instant startsAt, int hours) {
        // Share the exact per-user subscription advisory lock namespace with PremiumSubscriptionService and SePay settlement
        jdbc.query("SELECT pg_advisory_xact_lock(hashtext(?))", rs -> { },
                PremiumSubscriptionService.userSubscriptionLockKey(userId));
        if (hasActiveOrUpcomingEntitlement(userId, startsAt)) {
            throw new IllegalStateException("PREMIUM_ACTIVE");
        }
        var plans = jdbc.queryForList("SELECT id FROM public.premium_plans WHERE code = ? AND active = FALSE", Long.class, planCode);
        if (plans.isEmpty()) throw new IllegalStateException("promotional plan unavailable: " + planCode);
        Instant expiresAt = startsAt.plus(Duration.ofHours(hours));
        Long id = jdbc.queryForObject("""
                INSERT INTO public.premium_subscriptions(user_id, plan_id, starts_at, expires_at, status, source, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'ACTIVE', ?, now(), now()) RETURNING id
                """, Long.class, userId, plans.getFirst(), Timestamp.from(startsAt), Timestamp.from(expiresAt), source);
        if (id == null) throw new IllegalStateException("promotional subscription was not created");
        invalidateEntitlementCache(userId);
        return id;
    }
}
