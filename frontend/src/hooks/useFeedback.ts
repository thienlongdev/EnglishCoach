'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import useSWR from 'swr';
import { useSession } from 'next-auth/react';
import { useCurrentRole } from '@/hooks/useCurrentRole';
import { feedbackApi } from '@/services/feedbackApi';
import { isRealtimeConnected, subscribeRealtimeConnection } from '@/services/stompClient';
import { FeedbackThread, FeedbackUnreadCount } from '@/types/feedback';

export const USER_FEEDBACK_UNREAD_URL = '/api/v1/feedback/mine/unread-count';
export const ADMIN_FEEDBACK_UNREAD_URL = '/api/v1/feedback/admin/unread-count';
export const MY_FEEDBACK_LIST_PREFIX = '/api/v1/feedback/mine/list';
export const ADMIN_FEEDBACK_INBOX_PREFIX = '/api/v1/feedback/admin/inbox/list';

function useRealtimeConnected(): boolean {
  return useSyncExternalStore(subscribeRealtimeConnection, isRealtimeConnected, () => false);
}

function useRevalidateOnRealtimeReconnect(enabled: boolean, revalidate: () => void) {
  const connected = useRealtimeConnected();
  const mountedAtRef = useRef<number>(Date.now());
  const everConnectedRef = useRef<boolean>(connected);
  const prevConnectedRef = useRef<boolean>(connected);

  useEffect(() => {
    const wasConnected = prevConnectedRef.current;
    prevConnectedRef.current = connected;

    if (connected) {
      const shouldRevalidate =
        enabled &&
        !wasConnected &&
        (everConnectedRef.current || Date.now() - mountedAtRef.current >= 5000);
      everConnectedRef.current = true;
      if (shouldRevalidate) {
        revalidate();
      }
    }
  }, [connected, enabled, revalidate]);

  return connected;
}

export function useUserFeedbackUnreadCount() {
  const { data: session, status } = useSession();
  const user = session?.user as any;
  const userId = user?.id || user?.sub || user?.email;
  const { isAdmin, isLoading: isRoleLoading, error: roleError } = useCurrentRole(); // live backend role, not the login-time session copy

  // Do not guess ROLE_USER while /auth/me is unresolved. An administrator would otherwise issue one
  // learner-only unread-count request during shell hydration and correctly receive a noisy 403.
  const shouldFetch = status === 'authenticated' && userId && !isRoleLoading && !roleError && !isAdmin;
  const key = shouldFetch ? [USER_FEEDBACK_UNREAD_URL, userId, 'feedback'] : null;
  const realtimeConnected = useRealtimeConnected();

  const { data, error, isLoading, mutate } = useSWR<FeedbackUnreadCount>(
    key,
    () => feedbackApi.getMyUnreadCount(),
    {
      revalidateOnFocus: true,
      refreshInterval: realtimeConnected ? 0 : 60000,
      dedupingInterval: 10000,
      keepPreviousData: true,
    }
  );

  useRevalidateOnRealtimeReconnect(Boolean(shouldFetch), mutate);

  return {
    unreadCount: data?.unreadCount ?? 0,
    isLoading: shouldFetch && (isLoading && !data),
    error,
    mutateUnreadCount: mutate,
  };
}

export function useAdminFeedbackUnreadCount() {
  const { data: session, status } = useSession();
  const user = session?.user as any;
  const userId = user?.id || user?.sub || user?.email;
  const { isAdmin } = useCurrentRole(); // live backend role, not the login-time session copy

  const shouldFetch = status === 'authenticated' && userId && isAdmin;
  const key = shouldFetch ? [ADMIN_FEEDBACK_UNREAD_URL, userId, 'admin-feedback'] : null;
  const realtimeConnected = useRealtimeConnected();

  const { data, error, isLoading, mutate } = useSWR<FeedbackUnreadCount>(
    key,
    () => feedbackApi.getAdminUnreadCount(),
    {
      revalidateOnFocus: true,
      refreshInterval: realtimeConnected ? 0 : 30000,
      dedupingInterval: 5000,
      keepPreviousData: true,
    }
  );

  useRevalidateOnRealtimeReconnect(Boolean(shouldFetch), mutate);

  return {
    unreadCount: data?.unreadCount ?? 0,
    isLoading: shouldFetch && (isLoading && !data),
    error,
    mutateUnreadCount: mutate,
  };
}

export function useMyFeedbackList(enabled: boolean = true) {
  const { data: session, status } = useSession();
  const user = session?.user as any;
  const userId = user?.id || user?.sub || user?.email;
  const { isAdmin } = useCurrentRole(); // live backend role, not the login-time session copy

  const shouldFetch = status === 'authenticated' && userId && !isAdmin && enabled;
  const key = shouldFetch ? [MY_FEEDBACK_LIST_PREFIX, userId] : null;

  const { data, error, isLoading, mutate } = useSWR<FeedbackThread[]>(
    key,
    () => feedbackApi.getMyFeedbacks(),
    {
      revalidateOnFocus: false,
      dedupingInterval: 5000,
    }
  );

  return {
    threads: data ?? [],
    isLoading: shouldFetch && (isLoading && !data),
    error,
    mutateThreads: mutate,
  };
}

export function useAdminFeedbackInbox(enabled: boolean = true) {
  const { data: session, status } = useSession();
  const user = session?.user as any;
  const userId = user?.id || user?.sub || user?.email;
  const { isAdmin } = useCurrentRole(); // live backend role, not the login-time session copy

  const shouldFetch = status === 'authenticated' && userId && isAdmin && enabled;
  const key = shouldFetch ? [ADMIN_FEEDBACK_INBOX_PREFIX, userId] : null;

  const { data, error, isLoading, mutate } = useSWR<FeedbackThread[]>(
    key,
    () => feedbackApi.getAdminInbox(),
    {
      revalidateOnFocus: true,
      dedupingInterval: 5000,
    }
  );

  return {
    inbox: data ?? [],
    isLoading: shouldFetch && (isLoading && !data),
    error,
    mutateInbox: mutate,
  };
}
