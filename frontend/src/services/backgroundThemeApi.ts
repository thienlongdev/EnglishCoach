import type { AxiosRequestConfig } from 'axios';
import { apiClient } from '@/services/api-client';
import {
  BG_STUDIO_SCHEMA_VERSION,
  type BackgroundPreferencesResponse,
  type BackgroundPreferencesState,
} from '@/lib/background-studio/types';

/**
 * Echo Background Studio — account-scoped background theme preferences (`/api/v1/users/me/background-preferences`).
 *
 * Every call is scoped strictly to the signed-in principal via the HttpOnly session cookie (with CSRF protection on
 * writes); no `userId` parameter exists anywhere. Pure local persistence: zero AI calls, zero external requests.
 */
const BASE = '/users/me/background-preferences';

export interface BackgroundThemeRequestOptions {
  signal?: AbortSignal;
  /** Suppresses automatic logout redirect on 401 during passive hydration. */
  skipAuthRedirect?: boolean;
}

export interface SaveBackgroundPreferencesPayload {
  schemaVersion: typeof BG_STUDIO_SCHEMA_VERSION;
  state: BackgroundPreferencesState;
}

type ExtendedRequestConfig = AxiosRequestConfig & { skipAuthRedirect?: boolean };

function buildConfig(options?: BackgroundThemeRequestOptions): ExtendedRequestConfig | undefined {
  if (!options) return undefined;
  const config: ExtendedRequestConfig = {};
  if (options.signal) config.signal = options.signal;
  if (options.skipAuthRedirect) config.skipAuthRedirect = true;
  return config;
}

export const backgroundThemeApi = {
  /** Fetches the signed-in learner's saved background preferences (or canonical empty defaults when unset). */
  get: (options?: BackgroundThemeRequestOptions): Promise<BackgroundPreferencesResponse> =>
    apiClient.get<BackgroundPreferencesResponse>(BASE, buildConfig(options)).then((r) => r.data),

  /** Validates and atomically persists the learner's background preferences state. */
  save: (
    state: BackgroundPreferencesState,
    options?: BackgroundThemeRequestOptions,
  ): Promise<BackgroundPreferencesResponse> => {
    const payload: SaveBackgroundPreferencesPayload = {
      schemaVersion: state.schemaVersion ?? BG_STUDIO_SCHEMA_VERSION,
      state: {
        ...state,
        schemaVersion: BG_STUDIO_SCHEMA_VERSION,
      },
    };
    return apiClient
      .put<BackgroundPreferencesResponse>(BASE, payload, buildConfig(options))
      .then((r) => r.data);
  },

  /** Resets (deletes) the signed-in learner's saved background preferences row (idempotent 204). */
  reset: (options?: BackgroundThemeRequestOptions): Promise<void> =>
    apiClient.delete(BASE, buildConfig(options)).then(() => undefined),
};
