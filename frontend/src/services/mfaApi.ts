import { apiClient } from './api-client';

/**
 * The administrator's second factor (`/api/v1/mfa`, official administrator account only; the backend decides).
 * A secret or a recovery code appears in exactly one answer and is never stored by this client.
 */
export type AdminAccess = 'GRANTED' | 'MFA_REQUIRED' | 'ENROLLMENT_REQUIRED';
export type MfaMethod = 'WEBAUTHN' | 'TOTP' | 'RECOVERY_CODE';

export interface MfaPasskey {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  syncedPasskey: boolean;
}

export interface MfaStatus {
  enrolled: boolean;
  required: boolean;
  adminAccess: AdminAccess;
  sessionVerified: boolean;
  stepUpFresh: boolean;
  stepUpMinutes: number;
  canEnrollFirstFactor: boolean;
  webauthn: MfaPasskey[];
  totpEnrolled: boolean;
  recoveryCodesRemaining: number;
}

export interface WebAuthnOptions {
  challengeId: string;
  publicKey: Record<string, unknown>;
}

export interface EnrollResult {
  enrolled: boolean;
  method: MfaMethod;
  /** Present once, at the very first enrolment. */
  recoveryCodes?: string[];
}

/** These calls answer 403 by design while a factor is missing: never treat that as "signed out". */
const quiet = { skipAuthRedirect: true, skipStepUp: true } as Record<string, unknown>;

export const mfaApi = {
  status: async () => (await apiClient.get<MfaStatus>('/mfa/status', quiet)).data,
  startTotp: async () =>
    (await apiClient.post<{ secret: string; otpauthUri: string }>('/mfa/totp/enroll', {}, quiet)).data,
  confirmTotp: async (code: string) =>
    (await apiClient.post<EnrollResult>('/mfa/totp/confirm', { code }, quiet)).data,
  removeTotp: async () => { await apiClient.delete('/mfa/totp', quiet); },
  registerOptions: async () =>
    (await apiClient.post<WebAuthnOptions>('/mfa/webauthn/register/options', {}, quiet)).data,
  registerVerify: async (challengeId: string, label: string, credential: unknown) =>
    (await apiClient.post<EnrollResult>('/mfa/webauthn/register/verify', { challengeId, label, credential }, quiet)).data,
  removePasskey: async (id: string) => { await apiClient.delete(`/mfa/webauthn/${encodeURIComponent(id)}`, quiet); },
  assertOptions: async () =>
    (await apiClient.post<WebAuthnOptions>('/mfa/webauthn/assert/options', {}, quiet)).data,
  verifyCode: async (method: 'TOTP' | 'RECOVERY_CODE', code: string) =>
    (await apiClient.post<{ verified: boolean; recoveryCodesRemaining: number }>('/mfa/verify', { method, code }, quiet)).data,
  verifyPasskey: async (challengeId: string, credential: unknown) =>
    (await apiClient.post<{ verified: boolean }>('/mfa/verify', { method: 'WEBAUTHN', challengeId, credential }, quiet)).data,
  regenerateRecoveryCodes: async () =>
    (await apiClient.post<{ recoveryCodes: string[] }>('/mfa/recovery-codes/regenerate', {}, quiet)).data,
};

/** The backend's refusal code of a failed call (`STEP_UP_REQUIRED`, `INVALID_CODE`, `MFA_LOCKED`, ...), if any. */
export function mfaErrorCode(error: unknown): string | null {
  const data = (error as { response?: { data?: { code?: unknown } } })?.response?.data;
  return typeof data?.code === 'string' ? data.code : null;
}
