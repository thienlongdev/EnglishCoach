package com.englishcoach.premium.service;

import com.englishcoach.premium.dto.PremiumFeatureEntitlementDto;
import com.englishcoach.premium.dto.PremiumMeResponseDto;
import com.englishcoach.premium.dto.PremiumPlanDto;
import com.englishcoach.premium.entity.PremiumFeatureDefinition;
import com.englishcoach.premium.entity.PremiumPlan;
import com.englishcoach.premium.entity.PremiumSubscription;
import com.englishcoach.premium.repository.PremiumFeatureDefinitionRepository;
import com.englishcoach.premium.repository.PremiumPlanRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Slf4j
@Service
public class PremiumEntitlementService {

    private final PremiumSubscriptionService subscriptionService;
    private final PremiumUsageService usageService;
    private final PremiumPlanRepository planRepository;
    private final PremiumFeatureDefinitionRepository featureDefinitionRepository;
    private final PremiumEntitlementCache entitlementCache;

    @Autowired
    public PremiumEntitlementService(
            PremiumSubscriptionService subscriptionService,
            PremiumUsageService usageService,
            PremiumPlanRepository planRepository,
            PremiumFeatureDefinitionRepository featureDefinitionRepository,
            PremiumEntitlementCache entitlementCache) {
        this.subscriptionService = subscriptionService;
        this.usageService = usageService;
        this.planRepository = planRepository;
        this.featureDefinitionRepository = featureDefinitionRepository;
        this.entitlementCache = entitlementCache != null ? entitlementCache : new PremiumEntitlementCache();
    }

    public PremiumEntitlementService(
            PremiumSubscriptionService subscriptionService,
            PremiumUsageService usageService,
            PremiumPlanRepository planRepository,
            PremiumFeatureDefinitionRepository featureDefinitionRepository) {
        this(subscriptionService, usageService, planRepository, featureDefinitionRepository, new PremiumEntitlementCache());
    }

    /** The shared AI voucher wallet (absent in slim unit tests: entitlements are then exactly as before). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.premium.voucher.AiVoucherService voucherService;

    public void invalidatePremiumCache(Long userId) {
        entitlementCache.invalidate(userId);
    }

    public void invalidateAllPremiumCache() {
        entitlementCache.invalidateAll();
    }

    @Transactional(readOnly = true)
    public boolean isUserPremium(Long userId) {
        if (userId == null) return false;
        return entitlementCache.getOrLoad(userId, id -> subscriptionService.getActiveSubscription(id).isPresent());
    }

    @Transactional(readOnly = true)
    public Optional<PremiumSubscription> getActiveSubscription(Long userId) {
        if (userId == null) return Optional.empty();
        return subscriptionService.getActiveSubscription(userId);
    }

    @Transactional(readOnly = true)
    public List<PremiumPlanDto> getActivePlans() {
        List<PremiumPlan> plans = planRepository.findByActiveTrueOrderByDisplayOrderAsc();
        return plans.stream()
                .map(p -> PremiumPlanDto.builder()
                        .id(p.getId())
                        .code(p.getCode())
                        .name(p.getName())
                        .durationMonths(p.getDurationMonths())
                        .priceVnd(p.getPriceVnd())
                        .displayOrder(p.getDisplayOrder())
                        .badge(p.getBadge())
                        .active(p.isActive())
                        .build())
                .toList();
    }

    @Transactional(readOnly = true)
    public PremiumMeResponseDto getPremiumMe(Long userId) {
        Instant now = Instant.now();
        Optional<PremiumSubscription> activeSubOpt = (userId != null)
                ? subscriptionService.getActiveSubscription(userId)
                : Optional.empty();

        boolean isPremium = activeSubOpt.isPresent();
        if (userId != null) {
            entitlementCache.put(userId, isPremium);
        }
        PremiumSubscription activeSub = activeSubOpt.orElse(null);

        PremiumMeResponseDto.PlanSummaryDto planSummary = null;
        Instant startsAt = null;
        Instant expiresAt = null;
        long daysRemaining = 0;

        if (activeSub != null) {
            PremiumPlan plan = activeSub.getPlan();
            planSummary = PremiumMeResponseDto.PlanSummaryDto.builder()
                    .code(plan.getCode())
                    .name(plan.getName())
                    .durationMonths(plan.getDurationMonths())
                    .badge(plan.getBadge())
                    .build();
            startsAt = activeSub.getStartsAt();
            expiresAt = activeSub.getExpiresAt();
            daysRemaining = Math.max(0, Duration.between(now, expiresAt).toDays());
        }

        List<PremiumFeatureDefinition> definitions = featureDefinitionRepository.findByEnabledTrueOrderBySortOrderAsc();
        String currentMonth = usageService.getCurrentBillingCycleMonth();

        List<PremiumFeatureEntitlementDto> entitlements = new ArrayList<>();
        int voucherBalance = (userId != null && voucherService != null) ? voucherService.balance(userId) : 0;
        // one statement each for all features (was one per feature: ≈ 90 ms of database round trip apiece in production)
        // a Premium account's COACH entry is its Premium daily Echo allowance (owner 2026-11-20: Premium Echo is limited)
        Map<PremiumUsageService.Pool, PremiumUsageService.DailyAllowance> daily = usageService.dailyAllowances(userId, isPremium);
        Map<String, Integer> monthlyUsedByFeature = (userId != null && isPremium)
                ? usageService.getMonthlyPremiumUsedByFeature(userId, currentMonth)
                : Map.of();
        for (PremiumFeatureDefinition def : definitions) {
            String fKey = def.getFeatureKey();
            // free accounts: the feature's daily allowance (the AI one is shared by every gated AI feature)
            PremiumUsageService.DailyAllowance allowance = daily.get(PremiumUsageService.poolOf(fKey));
            int trialLimit = allowance.limit();
            int trialUsed = allowance.used();
            int trialRemaining = allowance.remaining();

            if (PremiumUsageService.EXAM_AI_SCORING.equals(fKey)) {
                trialLimit = trialUsed = trialRemaining = 0;
            }

            int monthlyLimit = def.getPremiumMonthlyLimit();
            int monthlyUsed = monthlyUsedByFeature.getOrDefault(fKey, 0);
            int monthlyRemaining = Math.max(0, monthlyLimit - monthlyUsed);

            boolean allowed;
            if (!def.isPremiumRequired()) {
                allowed = true;
            } else if (isPremium) {
                allowed = (monthlyRemaining > 0);
            } else {
                allowed = (trialRemaining > 0);
            }
            // an unexpired AI voucher pays for one more request of an eligible feature once the included quota is used up
            boolean voucherEligible = voucherService != null && voucherService.eligible(fKey);
            if (!allowed && voucherBalance > 0 && voucherEligible && (isPremium || !PremiumUsageService.EXAM_AI_SCORING.equals(fKey))) {
                allowed = true;
            }

            entitlements.add(PremiumFeatureEntitlementDto.builder()
                    .featureKey(fKey)
                    .displayName(def.getDisplayName() == null ? null : def.getDisplayName().replace(" & ", " và ")) // owner rule: no "&" in display copy
                    .description(def.getDescription())
                    .premiumRequired(def.isPremiumRequired())
                    .trialLimit(trialLimit)
                    .trialUsed(trialUsed)
                    .trialRemaining(trialRemaining)
                    .isPremium(isPremium)
                    .premiumAllowed(allowed)
                    .premiumMonthlyLimit(monthlyLimit)
                    .premiumMonthlyUsed(monthlyUsed)
                    .premiumMonthlyRemaining(monthlyRemaining)
                    .voucherEligible(voucherEligible)
                    .build());
        }

        return PremiumMeResponseDto.builder()
                .isPremium(isPremium)
                .plan(planSummary)
                .startsAt(startsAt)
                .expiresAt(expiresAt)
                .daysRemaining(daysRemaining)
                .featureEntitlements(entitlements)
                .aiVoucherBalance(voucherBalance)
                .freeDaily(daily.values().stream().map(a -> PremiumMeResponseDto.DailyAllowanceDto.builder()
                        .pool(a.pool().name()).limit(a.limit()).used(a.used()).remaining(a.remaining())
                        .resetsAt(a.resetsAt()).build()).toList())
                .build();
    }
}
