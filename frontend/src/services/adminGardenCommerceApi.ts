import { apiClient } from './api-client';

/**
 * Echo Garden cosmetic commerce — the administrator's reconciliation queue (`/api/v1/admin/garden/commerce`, official
 * administrator only; the backend re-checks on every call). Refund requests and verified transfers that could not be
 * delivered automatically. A bank refund is always a manual transfer by the administrator; its reference is recorded.
 */

export interface AdminGardenRefund {
  id: number;
  orderId: number;
  userId: number;
  kind: string;
  status: string;
  reason: string;
  amountVnd: number;
  requestedAt: string;
  itemKind: string;
  itemCode: string;
  orderStatus: string;
  transferCode: string;
}

export interface AdminGardenIssue {
  id: number;
  kind: 'LATE_PAYMENT' | 'AMOUNT_MISMATCH' | 'ALREADY_OWNED' | 'ORDER_CLOSED' | 'DUPLICATE_PAYMENT' | 'UNAVAILABLE';
  orderId: number;
  userId: number;
  providerTransactionId: string;
  paidAmountVnd: number;
  orderAmountVnd: number;
  itemKind: string;
  itemCode: string;
  orderStatus: string;
  createdAt: string;
}

export interface AdminGardenCommerceQueue {
  checkoutEnabled: boolean;
  refunds: AdminGardenRefund[];
  issues: AdminGardenIssue[];
}

const BASE = '/admin/garden/commerce';

export const adminGardenCommerceApi = {
  queue: () => apiClient.get<AdminGardenCommerceQueue>(BASE).then((r) => r.data),
  completeRefund: (refundId: number, bankReference: string, note: string) =>
    apiClient.post<AdminGardenCommerceQueue>(`${BASE}/refunds/${refundId}/complete`, { bankReference, note }).then((r) => r.data),
  rejectRefund: (refundId: number, note: string) =>
    apiClient.post<AdminGardenCommerceQueue>(`${BASE}/refunds/${refundId}/reject`, { note }).then((r) => r.data),
  openRefund: (orderId: number, kind: string, reason: string, bankReference: string) =>
    apiClient.post<AdminGardenCommerceQueue>(`${BASE}/orders/${orderId}/refund`, { kind, reason, bankReference }).then((r) => r.data),
  resolveIssue: (issueId: number, resolution: 'DELIVERED' | 'REFUNDED_MANUALLY', bankReference: string, note: string) =>
    apiClient.post<AdminGardenCommerceQueue>(`${BASE}/issues/${issueId}/resolve`, { resolution, bankReference, note }).then((r) => r.data),
};
