'use client';

import useSWR, { KeyedMutator } from 'swr';
import { useSession } from 'next-auth/react';
import {
  FREE_DAILY_LIMITS,
  premiumApi,
  PremiumFeatureEntitlementDto,
  PremiumMeResponseDto,
  PremiumPlanDto,
} from '@/services/premiumApi';

export const PREMIUM_ENTITLEMENT_CACHE_KEY_PREFIX = '/premium/me';
export const PREMIUM_PLANS_CACHE_KEY = '/premium/plans';

export interface UsePremiumEntitlementReturn {
  entitlement: PremiumMeResponseDto | undefined;
  plans: PremiumPlanDto[] | undefined;
  plansError: unknown;
  isPremium: boolean;
  isLoading: boolean;
  error: any;
  mutateEntitlement: KeyedMutator<PremiumMeResponseDto>;
  getFeatureEntitlement: (featureKey: string) => PremiumFeatureEntitlementDto | undefined;
  isFeatureAllowed: (featureKey: string) => boolean;
  getTrialRemaining: (featureKey: string) => number;
}

export interface UsePremiumEntitlementOptions {
  includePlans?: boolean;
}

export function usePremiumEntitlement(
  options?: UsePremiumEntitlementOptions
): UsePremiumEntitlementReturn {
  const includePlans = options?.includePlans ?? true;
  const { data: session, status } = useSession();
  const userEmail = session?.user?.email;

  // Cache key is strictly user-scoped to prevent cross-account leakage (Section 21 AGENTS.md)
  const meSwrKey =
    status === 'authenticated' && userEmail
      ? [PREMIUM_ENTITLEMENT_CACHE_KEY_PREFIX, userEmail]
      : null;

  const {
    data: entitlement,
    error: meError,
    isLoading: isMeLoading,
    mutate: mutateEntitlement,
  } = useSWR<PremiumMeResponseDto>(
    meSwrKey,
    async () => {
      return await premiumApi.getEntitlementMe();
    },
    {
      revalidateOnFocus: false,
      dedupingInterval: 30000,
      keepPreviousData: true,
    }
  );

  const { data: plans, error: plansError } = useSWR<PremiumPlanDto[]>(
    includePlans ? PREMIUM_PLANS_CACHE_KEY : null,
    async () => {
      return await premiumApi.getPlans();
    },
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000,
    }
  );

  const isPremium = Boolean(entitlement?.isPremium);

  const getFeatureEntitlement = (featureKey: string): PremiumFeatureEntitlementDto | undefined => {
    return entitlement?.featureEntitlements?.find((f) => f.featureKey === featureKey);
  };

  const isFeatureAllowed = (featureKey: string): boolean => {
    if (!entitlement) return true; // optimistic default while loading
    const feat = getFeatureEntitlement(featureKey);
    if (!feat) return true;
    if (!feat.premiumRequired) return true;
    // an unexpired AI voucher pays for one more request of an eligible feature (the server spends it, never the client)
    if (feat.voucherEligible && (entitlement.aiVoucherBalance ?? 0) > 0) return true;
    if (isPremium) return feat.premiumMonthlyRemaining > 0;
    return feat.trialRemaining > 0;
  };

  // free accounts: AI features share one daily allowance (server value; the published default while loading)
  const getTrialRemaining = (featureKey: string): number => {
    const feat = getFeatureEntitlement(featureKey);
    return feat ? feat.trialRemaining : FREE_DAILY_LIMITS.AI;
  };

  return {
    entitlement,
    plans,
    plansError,
    isPremium,
    isLoading: status === 'loading' || (isMeLoading && !entitlement),
    error: meError,
    mutateEntitlement,
    getFeatureEntitlement,
    isFeatureAllowed,
    getTrialRemaining,
  };
}
