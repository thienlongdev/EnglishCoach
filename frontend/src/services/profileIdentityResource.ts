import { mutate } from 'swr';
import { apiClient } from './api-client';
import { createEntryRequestStore } from '../lib/module-entry-core';
import type { UserProfileDto } from './userProfileApi';
const requests = createEntryRequestStore();
export const clearProfileIdentityRequests = () => requests.clear();
export const profileKey = (user: string) => ['/users/me/profile', user] as const;
export const avatarKey = (user: string, version: string | null) => ['/users/me/avatar', user, version || 'default'] as const;
export function fetchIdentityProfile(user: string) {
  return requests.run(JSON.stringify(profileKey(user)), async signal =>
    (await apiClient.get<UserProfileDto>('/users/me/profile', { signal, timeout: 15000 })).data);
}
export function fetchIdentityAvatar(user: string, version: string | null) {
  return requests.run(JSON.stringify(avatarKey(user, version)), async signal =>
    (await apiClient.get<Blob>('/users/me/avatar', { signal, timeout: 15000, responseType: 'blob' })).data);
}
export async function prepareIdentity(user: string, cancelled: () => boolean) {
  const profile = await fetchIdentityProfile(user);
  if (cancelled()) return;
  await mutate(profileKey(user), profile, { revalidate: false });
  if (profile.avatarPresent) {
    const blob = await fetchIdentityAvatar(user, profile.avatarUpdatedAt);
    if (!cancelled()) await mutate(avatarKey(user, profile.avatarUpdatedAt), blob, { revalidate: false });
  }
}
