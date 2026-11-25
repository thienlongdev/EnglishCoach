import { apiClient } from '@/services/api-client';
import type { TopicBand, TopicDraw, TopicItem, TopicRound, TopicStyle } from '@/types/speakingTopic';

/**
 * "Nói theo chủ đề" — curated question draws and honest practice facts. Deliberately has NO call to any AI,
 * transcription, pronunciation or Premium endpoint, and never uploads audio: recordings stay in the browser.
 */
export const TOPIC_CATALOG_PATH = '/speaking/topics/catalog';
export const TOPIC_SUMMARY_PATH = '/speaking/topics/summary';

/** UUID request ids make a retried draw idempotent on the server. */
export const newTopicRequestId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export interface DrawOptions {
  style: TopicStyle;
  category?: string | null;
  band?: TopicBand | null;
  previousDrawId?: number | null;
  replayItemId?: string | null;
  allowReplay?: boolean;
}

export const speakingTopicApi = {
  draw: (o: DrawOptions) =>
    apiClient.post<TopicDraw>('/speaking/topics/draws', {
      requestId: newTopicRequestId(),
      style: o.style,
      category: o.category || null,
      band: o.band || null,
      previousDrawId: o.previousDrawId ?? null,
      replayItemId: o.replayItemId ?? null,
      allowReplay: Boolean(o.allowReplay),
    }).then(r => r.data),
  start: (drawId: number, targetSeconds: number) =>
    apiClient.post<TopicRound>(`/speaking/topics/draws/${drawId}/start`, { targetSeconds }).then(r => r.data),
  finish: (drawId: number, spokenSeconds: number, recorded: boolean) =>
    apiClient.post<TopicRound>(`/speaking/topics/draws/${drawId}/finish`, { spokenSeconds, recorded }).then(r => r.data),
  item: (itemId: string) => apiClient.get<TopicItem>(`/speaking/topics/items/${itemId}`).then(r => r.data),
  favorite: (itemId: string, on: boolean) =>
    (on ? apiClient.put(`/speaking/topics/favorites/${itemId}`) : apiClient.delete(`/speaking/topics/favorites/${itemId}`)).then(() => undefined),
};
