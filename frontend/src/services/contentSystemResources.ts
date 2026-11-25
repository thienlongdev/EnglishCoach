import { mutate } from 'swr';
import { apiClient } from './api-client';
import { createEntryRequestStore } from '../lib/module-entry-core';
import { cardMetadata, validContentCards, saveContentSnapshot, readContentSnapshots, todayContentDate } from '../lib/content-system-snapshots';
const requests = createEntryRequestStore();
export const clearContentRequests = () => requests.clear();
export const contentKey = (path: string) => ['content-system-v1', path, todayContentDate()] as const;
export const contentSnapshot = (path: string) => readContentSnapshots()?.data[path];
export function fetchContentCards<T>(path: string): Promise<T> {
  return requests.run(JSON.stringify(contentKey(path)), async signal => {
    const response = await apiClient.get(path, { signal, timeout: 15000 });
    const data = cardMetadata(path, response.status === 204 ? null : response.data);
    if (signal.aborted) throw new Error('Content request cancelled');
    if (!validContentCards(path, data)) throw new Error('Invalid SYSTEM card metadata');
    saveContentSnapshot(path, data);
    return data as T;
  });
}
export async function prepareContentCards(path: string, cancelled: () => boolean) {
  const data = await fetchContentCards(path);
  if (!cancelled()) await mutate(contentKey(path), data, { revalidate: false });
}
