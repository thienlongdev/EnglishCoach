package com.englishcoach.premium.repository;

import com.englishcoach.premium.entity.PremiumAiUsage;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import org.springframework.data.jpa.repository.Modifying;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

@Repository
public interface PremiumAiUsageRepository extends JpaRepository<PremiumAiUsage, Long> {

    Optional<PremiumAiUsage> findByUserIdAndFeatureKeyAndRequestId(Long userId, String featureKey, String requestId);

    /** Rows of one feature in one state created since an instant (My Books: imports given back today). */
    int countByUserIdAndFeatureKeyAndStatusAndCreatedAtGreaterThanEqual(Long userId, String featureKey, String status, Instant since);

    int countByUserIdAndFeatureKeyAndUsageKindAndStatusIn(
            Long userId,
            String featureKey,
            String usageKind,
            Collection<String> statuses
    );

    /** Premium Echo messages since the local day start (the Premium daily Echo allowance, owner 2026-11-20). */
    int countByUserIdAndFeatureKeyAndUsageKindAndStatusInAndCreatedAtGreaterThanEqual(
            Long userId, String featureKey, String usageKind, Collection<String> statuses, java.time.Instant since);

    int countByUserIdAndFeatureKeyAndUsageKindAndBillingCycleMonthAndStatusIn(
            Long userId,
            String featureKey,
            String usageKind,
            String billingCycleMonth,
            Collection<String> statuses
    );

    /**
     * The two counts above for every feature of one user in one statement (rows: feature key, count). The entitlement
     * summary of {@code GET /premium/me} needs them for all features at once; one query per feature cost a database
     * round trip each (≈ 90 ms in production) on a request every page makes.
     */
    @Query("""
            SELECT u.featureKey, COUNT(u) FROM PremiumAiUsage u
            WHERE u.userId = :userId AND u.usageKind = :usageKind AND u.status IN :statuses
            GROUP BY u.featureKey""")
    List<Object[]> countPerFeature(@Param("userId") Long userId, @Param("usageKind") String usageKind,
                                   @Param("statuses") Collection<String> statuses);

    @Query("""
            SELECT u.featureKey, COUNT(u) FROM PremiumAiUsage u
            WHERE u.userId = :userId AND u.usageKind = :usageKind AND u.billingCycleMonth = :billingCycleMonth
              AND u.status IN :statuses
            GROUP BY u.featureKey""")
    List<Object[]> countPerFeatureInMonth(@Param("userId") Long userId, @Param("usageKind") String usageKind,
                                          @Param("billingCycleMonth") String billingCycleMonth,
                                          @Param("statuses") Collection<String> statuses);

    /**
     * Free daily allowances: TRIAL rows of one user created since the start of the local day, per feature key
     * (rows: feature key, count). One statement for every allowance.
     */
    @Query("""
            SELECT u.featureKey, COUNT(u) FROM PremiumAiUsage u
            WHERE u.userId = :userId AND u.usageKind = 'TRIAL' AND u.status IN :statuses AND u.createdAt >= :since
            GROUP BY u.featureKey""")
    List<Object[]> countTrialPerFeatureSince(@Param("userId") Long userId, @Param("statuses") Collection<String> statuses,
                                             @Param("since") Instant since);

    /**
     * A released reservation used again (same request id, e.g. a retried turn): back to RESERVED with a fresh creation
     * time, so it counts against the day it is used in. The unique (user, feature, request) row is reused, never duplicated.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = """
            UPDATE public.premium_ai_usage SET status = 'RESERVED', usage_kind = :usageKind, billing_cycle_month = :month,
                   created_at = now(), completed_at = NULL
            WHERE id = :id AND status = 'RELEASED'""", nativeQuery = true)
    int reactivate(@Param("id") Long id, @Param("usageKind") String usageKind, @Param("month") String month);

    /**
     * Releases orphaned {@code RESERVED} rows belonging strictly to allowlisted synchronous
     * {@code @RequirePremiumAi} interceptor features older than {@code cutoff}.
     * Uses {@code UPDATE} only (never {@code DELETE}, which V137 audit triggers forbid).
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("""
            UPDATE PremiumAiUsage u
            SET u.status = 'RELEASED'
            WHERE u.status = 'RESERVED'
              AND u.createdAt < :cutoff
              AND u.featureKey IN :featureKeys""")
    int releaseStaleSyncReservations(@Param("cutoff") Instant cutoff,
                                     @Param("featureKeys") Collection<String> featureKeys);
}
