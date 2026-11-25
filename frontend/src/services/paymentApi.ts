import { apiClient } from './api-client';

export interface PaymentOrderResponse {
  orderId: number;
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  planCode: string;
  planName: string;
  durationMonths: number;
  amountVnd: number;
  currency: string;
  transferCode: string;
  bankCode?: string;
  accountNumber?: string;
  accountName?: string;
  expiresAt: string;
  qrImageUrl?: string;
  createdAt: string;
  paidAt?: string;
  premiumExpiresAt?: string;
  /** A product checkout may attach one server-derived status line (for example a transfer waiting for reconciliation). */
  notice?: string;
}

export interface CreatePaymentOrderRequest {
  planCode: string;
}

export const paymentApi = {
  createPaymentOrder: async (planCode: string): Promise<PaymentOrderResponse> => {
    const res = await apiClient.post<PaymentOrderResponse>('/payments/orders', { planCode });
    return res.data;
  },

  getPaymentOrder: async (orderId: number): Promise<PaymentOrderResponse> => {
    const res = await apiClient.get<PaymentOrderResponse>(`/payments/orders/${orderId}`);
    return res.data;
  },
};
