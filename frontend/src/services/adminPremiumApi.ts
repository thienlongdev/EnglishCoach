import { apiClient } from './api-client';

/** Admin-only manual Premium entitlement (`/api/v1/admin/premium`, official administrator only — backend enforced). */

export interface AdminPremiumUserSummary {
  userId: number;
  displayName: string;
  email: string;
  role: string;
  premium: boolean;
  premiumExpiresAt: string | null;
  premiumSource: string | null;
}

export interface AdminPremiumEvent {
  id: number;
  action: 'GRANT' | 'REVOKE';
  reason: string;
  adminUserId: number;
  permanent: boolean;
  previousPremium: boolean;
  previousExpiresAt: string | null;
  previousSource: string | null;
  newPremium: boolean;
  newExpiresAt: string | null;
  newSource: string | null;
  createdAt: string;
}

export interface AdminPremiumEntitlement {
  userId: number;
  displayName: string;
  email: string;
  role: string;
  premium: boolean;
  premiumExpiresAt: string | null;
  premiumSource: string | null;
  planName: string | null;
  adminGrantActive: boolean;
  adminGrantExpiresAt: string | null;
  paidActive: boolean;
  history: AdminPremiumEvent[];
}

export const adminPremiumApi = {
  search: async (query: string): Promise<AdminPremiumUserSummary[]> =>
    (await apiClient.get<AdminPremiumUserSummary[]>('/admin/premium/users', { params: { query } })).data,
  view: async (userId: number): Promise<AdminPremiumEntitlement> =>
    (await apiClient.get<AdminPremiumEntitlement>(`/admin/premium/users/${userId}`)).data,
  grant: async (userId: number, body: { months?: number; permanent?: boolean; reason: string }): Promise<AdminPremiumEntitlement> =>
    (await apiClient.post<AdminPremiumEntitlement>(`/admin/premium/users/${userId}/grant`, body)).data,
  revoke: async (userId: number, reason: string): Promise<AdminPremiumEntitlement> =>
    (await apiClient.post<AdminPremiumEntitlement>(`/admin/premium/users/${userId}/revoke`, { reason })).data,
};
