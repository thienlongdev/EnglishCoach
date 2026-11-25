import { apiClient } from './api-client';

/**
 * Sign-in sessions of the current account (`/api/v1/account/sessions`) and, for the verified administrator, of
 * another account (`/api/v1/admin/security/sessions/*`). Answers carry a coarse device label and times only: never
 * an address, a raw User-Agent or any part of a credential.
 */
export interface AccountSession {
  id: string;
  device: string | null;
  method: 'CREDENTIALS' | 'GOOGLE' | string | null;
  signedInAt: string | null;
  lastSeenAt: string | null;
  secondFactor: boolean;
  current: boolean;
}

export interface AdminSessionLookup {
  userId: number;
  email: string;
  name: string | null;
  sessions: AccountSession[];
}

/** The backend answers 403 REAUTH_REQUIRED when ending OTHER sessions without a recent sign-in. */
export function needsReauth(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { message?: string; code?: string } } })?.response;
  if (response?.status !== 403) return false;
  const text = `${response.data?.message ?? ''} ${response.data?.code ?? ''}`;
  return text.includes('REAUTH_REQUIRED');
}

export const accountSessionsApi = {
  list: async () => (await apiClient.get<{ sessions: AccountSession[] }>('/account/sessions')).data.sessions,
  end: async (id: string) =>
    (await apiClient.delete<{ revoked: number; currentEnded: boolean }>(`/account/sessions/${encodeURIComponent(id)}`)).data,
  endOthers: async () => (await apiClient.post<{ revoked: number }>('/account/sessions/revoke-others', {})).data,
  adminLookup: async (email: string) =>
    (await apiClient.post<AdminSessionLookup>('/admin/security/sessions/lookup', { email })).data,
  adminRevokeAll: async (userId: number) =>
    (await apiClient.post<{ revoked: number }>('/admin/security/sessions/revoke', { userId })).data,
};
