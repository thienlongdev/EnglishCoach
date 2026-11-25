package com.englishcoach.premium.service;

import com.englishcoach.common.cache.BoundedTtlCache;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.function.Function;

/**
 * Leaf cache component shared by {@link PremiumEntitlementService} and {@link PremiumSubscriptionService}
 * to eliminate the circular bean dependency while preserving immediate and post-commit cache invalidation.
 */
@Component
public class PremiumEntitlementCache {

    /** Bounded 30 s entitlement cache explicitly invalidated on every subscription grant/extension/revocation. */
    private final BoundedTtlCache<Long, Boolean> premiumStatusCache = new BoundedTtlCache<>(10_000, 30_000);

    public Boolean getIfPresent(Long userId) {
        if (userId == null) {
            return null;
        }
        return premiumStatusCache.getIfPresent(userId);
    }

    public boolean getOrLoad(Long userId, Function<Long, Boolean> loader) {
        if (userId == null) {
            return false;
        }
        Boolean active = premiumStatusCache.get(userId, id -> Boolean.TRUE.equals(loader.apply(id)));
        return Boolean.TRUE.equals(active);
    }

    public void put(Long userId, boolean active) {
        if (userId != null) {
            premiumStatusCache.put(userId, active);
        }
    }

    public void invalidate(Long userId) {
        if (userId != null) {
            premiumStatusCache.invalidate(userId);
        }
    }

    /**
     * Evicts immediately (for callers reading inside the current transaction or non-transactional tests)
     * and registers an {@code afterCommit()} eviction when a transaction is active so concurrent readers
     * cannot repopulate a stale pre-commit value.
     */
    public void invalidateImmediateAndAfterCommit(Long userId) {
        if (userId == null) {
            return;
        }
        invalidate(userId);
        if (TransactionSynchronizationManager.isActualTransactionActive()
                && TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    invalidate(userId);
                }
            });
        }
    }

    public void invalidateAll() {
        premiumStatusCache.clear();
    }
}
