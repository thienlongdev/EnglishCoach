import { createBoardSnapshots } from '../lib/leaderboard-snapshots';
import { createEntryRequestStore } from '../lib/module-entry-core';
import { leaderboardApi } from './leaderboardApi';
import { mutate } from 'swr';
const snapshots = createBoardSnapshots();
const requests = createEntryRequestStore();
let generation = 0;
export const boardKey = (period: string, scope: string, group: string, limit: number, user: string) => ['/leaderboard/activity', period, scope, group, limit, user] as const;
export const meKey = (period: string, scope: string | null, group: string, user: string) => ['/leaderboard/activity/me', period, scope ?? 'DEFAULT', group, user] as const;
export const readBoardSnapshot = (key: readonly unknown[]) => snapshots.read(key);
export function fetchBoardSnapshot<T extends { updatedAt?: string | null }>(key: readonly unknown[], loader: () => Promise<T>) {
  const started = generation;
  return requests.run(JSON.stringify(key), loader).then(data => {
    if (started !== generation) throw new Error('Leaderboard request cancelled');
    return snapshots.accept(key, data);
  });
}
export function clearBoardSnapshots() { generation++; requests.clear(); snapshots.clear(); }
export async function prepareWeeklyBoard(user: string, cancelled: () => boolean) {
  const ownKey = meKey('WEEK', null, 'ALL', user);
  const me = await fetchBoardSnapshot(ownKey, () => leaderboardApi.getActivityMe('WEEK', null, 'ALL'));
  if (cancelled()) return;
  await mutate(ownKey, me, { revalidate: false });
  const scope = me.defaultScope || 'GLOBAL';
  await mutate(meKey('WEEK', scope, 'ALL', user), me, { revalidate: false });
  const key = boardKey('WEEK', scope, 'ALL', 20, user);
  const data = await fetchBoardSnapshot(key, () => leaderboardApi.getActivityBoard('WEEK', scope, 'ALL', 20));
  if (!cancelled()) await mutate(key, data, { revalidate: false });
}
