'use client';
import { useLayoutEffect, useState } from 'react';
import useSWR from 'swr';
import { useModuleEntryScope } from './useModuleEntryResource';
import { apiClient } from '@/services/api-client';
import { BILINGUAL_READING_SWR_KEY, readBilingualSnapshot, saveBilingualSnapshot, validBilingualCatalog } from '@/lib/bilingual-reading-cache';
import type { BilingualReadingCatalog, BilingualReadingDetail } from '@/types/bilingualReading';

export const BILINGUAL_READING_PATH = '/reading/bilingual/catalog';
let catalogRequest: Promise<BilingualReadingCatalog> | undefined;
async function fetchBilingualCatalog() {
  const cached = readBilingualSnapshot()?.data;
  if (catalogRequest) return catalogRequest;
  catalogRequest = apiClient.get<BilingualReadingCatalog>(BILINGUAL_READING_PATH, {
    timeout: 15000, params: cached ? { revision: cached.catalogRevision } : undefined,
    validateStatus: status => status === 200 || status === 304,
  }).then(response => {
    const data = response.status === 304 ? cached : response.data;
    if (!validBilingualCatalog(data)) throw new Error('Invalid bilingual Reading catalog');
    saveBilingualSnapshot(data);
    return data;
  }).finally(() => { catalogRequest = undefined; });
  return catalogRequest;
}

export function useBilingualReadingCatalog(enabled = true) {
  const scope = useModuleEntryScope();
  const [snapshot, setSnapshot] = useState<BilingualReadingCatalog>();
  useLayoutEffect(() => { setSnapshot(readBilingualSnapshot()?.data); }, []);
  return useSWR<BilingualReadingCatalog>(scope && enabled ? BILINGUAL_READING_SWR_KEY : null, fetchBilingualCatalog, { fallbackData: snapshot, revalidateOnMount: true, revalidateOnFocus: false, dedupingInterval: 60000, refreshInterval: 300000, shouldRetryOnError: false });
}

const detailCache = new Map<number, BilingualReadingDetail>();
const detailInflight = new Map<number, Promise<BilingualReadingDetail>>();
const DETAIL_CACHE_LIMIT = 8;
export async function getBilingualReadingDetail(id: number) {
  const cached = detailCache.get(id);
  if (cached) return cached;
  const running = detailInflight.get(id);
  if (running) return running;
  const request = apiClient.get<BilingualReadingDetail>(`/reading/bilingual/materials/${id}`, { timeout: 15000 }).then(({ data }) => {
    if (!data || data.id !== id || !Array.isArray(data.segments) || data.segments.length === 0 || data.segments.some(segment => !segment.en?.trim() || !segment.vi?.trim())) throw new Error('Invalid bilingual Reading detail');
    detailCache.set(id, data);
    while (detailCache.size > DETAIL_CACHE_LIMIT) detailCache.delete(detailCache.keys().next().value!);
    return data;
  }).finally(() => detailInflight.delete(id));
  detailInflight.set(id, request);
  return request;
}
