import { apiClient } from './api-client';

export interface PremiumPlanDto {
  id: number;
  code: string;
  name: string;
  durationMonths: number;
  priceVnd: number;
  displayOrder: number;
  badge?: string;
  active: boolean;
}

export interface PremiumFeatureEntitlementDto {
  featureKey: string;
  displayName: string;
  description: string;
  premiumRequired: boolean;
  trialLimit: number;
  trialUsed: number;
  trialRemaining: number;
  isPremium: boolean;
  premiumAllowed: boolean;
  premiumMonthlyLimit: number;
  premiumMonthlyUsed: number;
  premiumMonthlyRemaining: number;
  /** An AI voucher may pay for this feature once the included quota is used up (server fact). */
  voucherEligible?: boolean;
}

export interface PremiumMeResponseDto {
  isPremium: boolean;
  plan?: {
    code: string;
    name: string;
    durationMonths: number;
    badge?: string;
  };
  startsAt?: string;
  expiresAt?: string;
  daysRemaining: number;
  /** Unexpired AI voucher credits of the account. */
  aiVoucherBalance?: number;
  featureEntitlements: PremiumFeatureEntitlementDto[];
  /** Free daily allowances (server facts, renew at local midnight); a Premium account is not limited by them. */
  freeDaily?: DailyAllowanceDto[];
}

/** AI = shared by every gated AI feature, COACH = Echo Coach messages, BOOK = new My Books imports. */
export type DailyPool = 'AI' | 'COACH' | 'BOOK';

export interface DailyAllowanceDto {
  pool: DailyPool;
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
}

/** Free daily allowances as published on the Premium page before the account's own numbers load. */
export const FREE_DAILY_LIMITS: Record<DailyPool, number> = { AI: 3, COACH: 10, BOOK: 1 };

/**
 * Echo message policy (owner 2026-11-20; enforced on the server in PremiumUsageService / EchoModels). Every answered Echo
 * message counts, typed or spoken, instant answers included; deep analyses are part of the message allowance.
 */
export const ECHO_LIMITS = {
  free: { perDay: 10, deepPerDay: 1 },
  premium: { perDay: 60, perMonth: 500, deepPerDay: 3, deepPerMonth: 40 },
} as const;

export function dailyAllowance(me: PremiumMeResponseDto | undefined, pool: DailyPool): DailyAllowanceDto | undefined {
  return me?.freeDaily?.find((a) => a.pool === pool);
}

/**
 * The backend serializes its `boolean isPremium` fields as `premium` (Java bean naming of `isPremium()`), so reading
 * `isPremium` alone showed every active subscriber as not Premium. Accept either spelling; never invent one.
 */
export function normalizeEntitlement(raw: PremiumMeResponseDto): PremiumMeResponseDto {
  const r = raw as PremiumMeResponseDto & { premium?: boolean };
  const features = Array.isArray(r.featureEntitlements) ? r.featureEntitlements : [];
  return {
    ...r,
    isPremium: Boolean(r.isPremium ?? r.premium),
    featureEntitlements: features.map((f) => {
      const g = f as PremiumFeatureEntitlementDto & { premium?: boolean };
      return { ...g, isPremium: Boolean(g.isPremium ?? g.premium) };
    }),
  };
}

export const premiumApi = {
  getPlans: async (): Promise<PremiumPlanDto[]> => {
    const res = await apiClient.get<PremiumPlanDto[]>('/premium/plans');
    return res.data;
  },

  getEntitlementMe: async (): Promise<PremiumMeResponseDto> => {
    const res = await apiClient.get<PremiumMeResponseDto>('/premium/me');
    return normalizeEntitlement(res.data);
  },
};
