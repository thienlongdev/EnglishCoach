package com.englishcoach.premium.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.premium.config.PremiumProperties;
import com.englishcoach.premium.entity.PremiumPlan;
import com.englishcoach.premium.entity.PremiumSubscription;
import com.englishcoach.premium.repository.PremiumPlanRepository;
import com.englishcoach.premium.repository.PremiumSubscriptionRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Optional;

@Slf4j
@Service
public class PremiumSubscriptionService {

    public static final String USER_SUBSCRIPTION_LOCK_PREFIX = "premium_subscription:";

    public static String userSubscriptionLockKey(long userId) {
        return USER_SUBSCRIPTION_LOCK_PREFIX + userId;
    }

    private final PremiumSubscriptionRepository subscriptionRepository;
    private final PremiumPlanRepository planRepository;
    private final UserRepository userRepository;
    private final PremiumProperties properties;
    private final PremiumEntitlementCache entitlementCache;

    @Autowired(required = false)
    private JdbcTemplate jdbcTemplate;

    @Autowired
    public PremiumSubscriptionService(
            PremiumSubscriptionRepository subscriptionRepository,
            PremiumPlanRepository planRepository,
            UserRepository userRepository,
            PremiumProperties properties,
            PremiumEntitlementCache entitlementCache) {
        this.subscriptionRepository = subscriptionRepository;
        this.planRepository = planRepository;
        this.userRepository = userRepository;
        this.properties = properties;
        this.entitlementCache = entitlementCache;
    }

    public PremiumSubscriptionService(
            PremiumSubscriptionRepository subscriptionRepository,
            PremiumPlanRepository planRepository,
            UserRepository userRepository,
            PremiumProperties properties) {
        this(subscriptionRepository, planRepository, userRepository, properties, null);
    }

    private void invalidateEntitlementCache(Long userId) {
        if (userId == null || entitlementCache == null) return;
        entitlementCache.invalidateImmediateAndAfterCommit(userId);
    }

    private void acquireUserSubscriptionLock(Long userId) {
        if (jdbcTemplate == null || userId == null) return;
        try {
            jdbcTemplate.query("SELECT pg_advisory_xact_lock(hashtext(?))", rs -> { }, userSubscriptionLockKey(userId));
        } catch (Exception e) {
            log.debug("Subscription advisory lock skipped in current environment: {}", e.getMessage());
        }
    }

    /**
     * Internal activation/extension service for Payment and grant integration.
     * Enforces calendar-month extension semantics and serializes per-user subscription mutations on a shared
     * advisory lock namespace with {@code PromoPremiumService} and {@code PaymentReconciliationService}.
     * 
     * - If no active Premium or existing is expired: starts_at = now, expires_at = now + duration_months
     * - If active Premium: new starts_at = current expiry, new expires_at = current expiry + duration_months
     */
    @Transactional
    public PremiumSubscription extendOrActivateSubscription(Long userId, Long planId, String source, int purchasedMonths) {
        acquireUserSubscriptionLock(userId);

        User user = userRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found: " + userId));

        PremiumPlan plan = planRepository.findById(planId)
                .orElseThrow(() -> new IllegalArgumentException("Plan not found: " + planId));

        boolean isSettledPaymentOrder = source != null && source.startsWith("SEPAY:");
        if (!plan.isActive() && !isSettledPaymentOrder) {
            throw new IllegalStateException("Plan is inactive: " + plan.getCode());
        }
        if (!plan.isActive()) {
            log.info("Settling valid payment order against deactivated quoted plan {} for user {}", plan.getCode(), userId);
        }

        ZoneId zoneId = properties.getZoneId();
        Instant now = Instant.now();

        // Find active subscription with latest expiry (unexpired)
        Optional<PremiumSubscription> activeSubOpt = subscriptionRepository
                .findFirstByUserIdAndStatusAndExpiresAtAfterOrderByExpiresAtDesc(userId, "ACTIVE", now);

        Instant startsAt;
        Instant expiresAt;

        if (activeSubOpt.isPresent()) {
            PremiumSubscription currentActive = activeSubOpt.get();
            startsAt = currentActive.getExpiresAt();
            ZonedDateTime zdtCurrentExpiry = startsAt.atZone(zoneId);
            ZonedDateTime zdtNewExpiry = zdtCurrentExpiry.plusMonths(purchasedMonths);
            expiresAt = zdtNewExpiry.toInstant();
            log.info("Extending active subscription for user {}: current expiry={}, new expiry={}",
                    userId, startsAt, expiresAt);
        } else {
            startsAt = now;
            ZonedDateTime zdtNow = now.atZone(zoneId);
            ZonedDateTime zdtNewExpiry = zdtNow.plusMonths(purchasedMonths);
            expiresAt = zdtNewExpiry.toInstant();
            log.info("Activating fresh subscription for user {}: startsAt={}, expiresAt={}",
                    userId, startsAt, expiresAt);
        }

        PremiumSubscription sub = PremiumSubscription.builder()
                .user(user)
                .plan(plan)
                .startsAt(startsAt)
                .expiresAt(expiresAt)
                .status("ACTIVE")
                .source(source != null && !source.isBlank() ? source : "SYSTEM")
                .build();

        PremiumSubscription saved = subscriptionRepository.save(sub);
        invalidateEntitlementCache(userId);
        return saved;
    }

    @Transactional(readOnly = true)
    public Optional<Instant> getCoverageEnd(Long userId) {
        return subscriptionRepository.findFirstByUserIdAndStatusAndExpiresAtAfterOrderByExpiresAtDesc(userId, "ACTIVE", Instant.now())
                .map(PremiumSubscription::getExpiresAt);
    }

    @Transactional(readOnly = true)
    public Optional<PremiumSubscription> getActiveSubscription(Long userId) {
        return subscriptionRepository.findFirstActiveSubscription(userId, Instant.now());
    }

    @Transactional(readOnly = true)
    public List<PremiumPlan> getActivePlans() {
        return planRepository.findByActiveTrueOrderByDisplayOrderAsc();
    }

    @Transactional(readOnly = true)
    public List<PremiumSubscription> getUserSubscriptions(Long userId) {
        return subscriptionRepository.findByUserIdOrderByCreatedAtDesc(userId);
    }
}
