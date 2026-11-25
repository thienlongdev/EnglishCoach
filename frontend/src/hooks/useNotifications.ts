'use client';

import useSWR, { mutate } from 'swr';
import { useSession } from 'next-auth/react';
import { notificationApi } from '@/services/notificationApi';
import { LearnerNotification, UnreadCountResponse } from '@/types/notification';

export const NOTIFICATION_UNREAD_COUNT_PREFIX = '/notifications/unread-count';
export const NOTIFICATION_LIST_PREFIX = '/notifications/list';

export function useNotificationUnreadCount() {
  const { data: session, status } = useSession();
  const userEmail = session?.user?.email;

  const key =
    status === 'authenticated' && userEmail
      ? [NOTIFICATION_UNREAD_COUNT_PREFIX, userEmail]
      : null;

  const { data, error, isLoading, mutate: mutateUnreadCount } = useSWR<UnreadCountResponse>(
    key,
    () => notificationApi.getUnreadCount(),
    {
      revalidateOnFocus: false,
      refreshInterval: 60000, // Refresh unread count every 60s
      dedupingInterval: 30000,
      keepPreviousData: true,
    }
  );

  return {
    unreadCount: data?.unreadCount ?? 0,
    isLoading: status === 'loading' || (isLoading && !data),
    error,
    mutateUnreadCount,
  };
}

export function useNotifications(isOpen: boolean) {
  const { data: session, status } = useSession();
  const userEmail = session?.user?.email;

  const unreadKey =
    status === 'authenticated' && userEmail
      ? [NOTIFICATION_UNREAD_COUNT_PREFIX, userEmail]
      : null;

  const listKey =
    status === 'authenticated' && userEmail && isOpen
      ? [NOTIFICATION_LIST_PREFIX, userEmail]
      : null;

  const {
    data: notifications,
    error,
    isLoading,
    mutate: mutateList,
  } = useSWR<LearnerNotification[]>(
    listKey,
    () => notificationApi.getNotifications(20),
    {
      revalidateOnFocus: false,
      dedupingInterval: 5000,
    }
  );

  const markAsRead = async (id: number) => {
    if (!userEmail) return;

    // Check if target notification was unread
    const target = notifications?.find((n) => n.id === id);
    const wasUnread = target && !target.read;

    // Optimistically update list
    if (notifications) {
      const updatedList = notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n
      );
      mutateList(updatedList, false);
    }

    // Optimistically decrement unread count if it was unread
    if (wasUnread && unreadKey) {
      mutate<UnreadCountResponse>(
        unreadKey,
        (current) => ({
          unreadCount: Math.max(0, (current?.unreadCount ?? 1) - 1),
        }),
        false
      );
    }

    try {
      await notificationApi.markAsRead(id);
    } catch (e) {
      // Rollback on failure
      mutateList();
      if (unreadKey) mutate(unreadKey);
      throw e;
    }
  };

  const markAllAsRead = async () => {
    if (!userEmail) return;

    // Optimistically update list
    if (notifications) {
      const updatedList = notifications.map((n) => ({ ...n, read: true }));
      mutateList(updatedList, false);
    }

    // Optimistically set unread count to 0
    if (unreadKey) {
      mutate<UnreadCountResponse>(unreadKey, { unreadCount: 0 }, false);
    }

    try {
      await notificationApi.markAllAsRead();
    } catch (e) {
      mutateList();
      if (unreadKey) mutate(unreadKey);
      throw e;
    }
  };

  const dismissNotification = async (id: number) => {
    if (!userEmail) return;

    const target = notifications?.find((n) => n.id === id);
    const wasUnread = target && !target.read;

    // Optimistically remove item from list
    if (notifications) {
      const updatedList = notifications.filter((n) => n.id !== id);
      mutateList(updatedList, false);
    }

    // Optimistically decrement unread count if it was unread
    if (wasUnread && unreadKey) {
      mutate<UnreadCountResponse>(
        unreadKey,
        (current) => ({
          unreadCount: Math.max(0, (current?.unreadCount ?? 1) - 1),
        }),
        false
      );
    }

    try {
      await notificationApi.dismissNotification(id);
    } catch (e) {
      mutateList();
      if (unreadKey) mutate(unreadKey);
      throw e;
    }
  };

  return {
    notifications: notifications ?? [],
    isLoading: status === 'loading' || (isLoading && !notifications),
    error,
    mutateList,
    markAsRead,
    markAllAsRead,
    dismissNotification,
  };
}
