'use client';

import { useEffect, useState } from 'react';
import { examsApi } from '@/services/examsApi';
import { apiClient } from '@/services/api-client';
import type { PublicAssetRefDto } from '@/types/exams';

/**
 * Exams Phase 4B.6 / 4B.8 — runtime media resolution. Every exam asset (part audio, derived TOEIC part segment,
 * Part 1 photo, Part 3/4 graphic, IELTS map, Writing Task 1 visual) is resolved through a playback grant for its
 * assetId. Nothing is derived from object keys or static storage paths. A refused grant (asset not VALIDATED, no
 * rights) resolves to `null`: the runner shows the asset as unavailable, never a guessed file.
 */

/** Turns a grant stream path into a URL the browser can load (relative paths follow the API base URL). */
export function resolveExamMediaUrl(rawUrl: string | undefined | null): string | null {
  if (!rawUrl) return null;
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  const base = String(apiClient.defaults.baseURL || '');
  if (/^https?:\/\//i.test(base)) {
    try {
      return new URL(rawUrl, base).toString();
    } catch {
      return rawUrl;
    }
  }
  return rawUrl;
}

const grantCache = new Map<string, Promise<string | null>>();

/** One grant per (attempt, asset) for the page lifetime; grants live for two hours server-side. */
export function getExamAssetUrl(attemptId: string, assetId: string, purpose = 'SIMULATION_LISTENING'): Promise<string | null> {
  const key = `${attemptId}:${assetId}`;
  let pending = grantCache.get(key);
  if (!pending) {
    pending = examsApi
      .createPlaybackGrant(attemptId, assetId, purpose)
      .then((grant) => resolveExamMediaUrl(grant.mediaStreamUrl || grant.streamUrl))
      .catch(() => {
        grantCache.delete(key);
        return null;
      });
    grantCache.set(key, pending);
  }
  return pending;
}

export function isImageAsset(asset: PublicAssetRefDto | undefined | null): boolean {
  return !!asset && (asset.mimeType || '').toLowerCase().startsWith('image/');
}

export function isAudioAsset(asset: PublicAssetRefDto | undefined | null): boolean {
  return !!asset && (asset.mimeType || '').toLowerCase().startsWith('audio/');
}

export type AssetUrlState = { status: 'idle' | 'loading' | 'ready' | 'unavailable'; url: string | null };

/** React hook resolving one asset reference to a loadable URL. */
export function useExamAssetUrl(attemptId: string | undefined, asset: PublicAssetRefDto | undefined | null): AssetUrlState {
  const [state, setState] = useState<AssetUrlState>({ status: 'idle', url: null });
  const assetId = asset?.assetId;
  useEffect(() => {
    let cancelled = false;
    if (!attemptId || !assetId) {
      setState({ status: 'unavailable', url: null });
      return;
    }
    setState({ status: 'loading', url: null });
    getExamAssetUrl(attemptId, assetId).then((url) => {
      if (!cancelled) setState(url ? { status: 'ready', url } : { status: 'unavailable', url: null });
    });
    return () => {
      cancelled = true;
    };
  }, [attemptId, assetId]);
  return state;
}

/** Printed part number from a part code ("READING_PART_7" → 7, "PART_3" → 3); null when the code has none. */
export function partNumberFromCode(partCode: string | undefined | null): number | null {
  const m = /(\d+)\s*$/.exec(partCode || '');
  return m ? Number(m[1]) : null;
}
