'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
  ReactNode,
} from 'react';
import { useSession } from 'next-auth/react';
import {
  disconnectRealtimeClient,
  isRealtimeConnected,
  publish as publishRealtimeMessage,
  realtimeSocket,
  subscribeRealtimeConnection,
  subscribeRealtimeTopic,
} from '@/services/stompClient';
import { notificationApi } from '@/services/notificationApi';
import {
  LearnerNotification,
  NotificationEnvelope,
} from '@/types/notification';
import { ActiveToast } from '@/components/layout/NotificationToast';
import {
  invalidateStreakAndDashboardCaches,
  broadcastStreakUpdate,
  initCrossTabSync,
} from '@/lib/cross-tab-sync';
import { setUnreadTitle } from '@/lib/brand/tabTitle';
import { emitMessenger, setMessengerPublisher } from '@/lib/messenger/bus';

interface NotificationRealtimeContextValue {
  unreadCount: number;
  notifications: LearnerNotification[];
  isLoading: boolean;
  error: string | null;
  isBellRinging: boolean;
  isPopoverOpen: boolean;
  setIsPopoverOpen: (open: boolean) => void;
  selectedNotification: LearnerNotification | null;
  setSelectedNotification: (notif: LearnerNotification | null) => void;
  markAsRead: (id: number) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  dismissNotification: (id: number) => Promise<void>;
  loadMore: () => Promise<void>;
  hasMore: boolean;
  isLoadingMore: boolean;
  reconcileWithRest: () => Promise<void>;
  toasts: ActiveToast[];
  dismissToast: (id: string | number) => void;
}

const NotificationRealtimeContext = createContext<NotificationRealtimeContextValue | null>(null);

export function useRealtimeNotifications(): NotificationRealtimeContextValue {
  const context = useContext(NotificationRealtimeContext);
  if (!context) {
    throw new Error('useRealtimeNotifications must be used within a NotificationRealtimeProvider');
  }
  return context;
}

const PAGE_LIMIT = 20;

export function NotificationRealtimeProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const { data: session, status } = useSession();
  const isAuthenticated = enabled && status === 'authenticated' && !!session?.user;
  const currentUserId =
    (session?.user as { id?: string | number } | undefined)?.id ??
    session?.user?.email ??
    null;

  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [notifications, setNotifications] = useState<LearnerNotification[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isBellRinging, setIsBellRinging] = useState<boolean>(false);
  const [isPopoverOpen, setIsPopoverOpen] = useState<boolean>(false);
  const [selectedNotification, setSelectedNotification] = useState<LearnerNotification | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ActiveToast[]>([]);

  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bellRingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const broadcastJitterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPopoverOpenRef = useRef<boolean>(isPopoverOpen);
  const lastUserIdRef = useRef<string | number | null>(null);
  const reconcileEpochRef = useRef<number>(0);
  const reconcileInFlightRef = useRef<boolean>(false);
  const lastReconcileCompletedAtRef = useRef<number>(0);

  const resetRealtimeState = useCallback(() => {
    reconcileEpochRef.current += 1;
    reconcileInFlightRef.current = false;
    lastReconcileCompletedAtRef.current = 0;
    if (bellRingTimeoutRef.current) {
      clearTimeout(bellRingTimeoutRef.current);
      bellRingTimeoutRef.current = null;
    }
    if (broadcastJitterTimerRef.current) {
      clearTimeout(broadcastJitterTimerRef.current);
      broadcastJitterTimerRef.current = null;
    }
    if (fallbackPollTimerRef.current) {
      clearInterval(fallbackPollTimerRef.current);
      fallbackPollTimerRef.current = null;
    }
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    setMessengerPublisher(null);
    setUnreadCount(0);
    setNotifications([]);
    setError(null);
    setIsBellRinging(false);
    setIsPopoverOpen(false);
    setSelectedNotification(null);
    setHasMore(true);
    setIsLoadingMore(false);
    setToasts([]);
  }, []);

  useEffect(() => {
    isPopoverOpenRef.current = isPopoverOpen;
  }, [isPopoverOpen]);

  // Trigger bell swing animation (1.2s restartable)
  const triggerBellRing = useCallback(() => {
    setIsBellRinging(false);
    if (bellRingTimeoutRef.current) {
      clearTimeout(bellRingTimeoutRef.current);
    }
    // Small rAF tick so React remounts class for consecutive events
    requestAnimationFrame(() => {
      setIsBellRinging(true);
      bellRingTimeoutRef.current = setTimeout(() => {
        setIsBellRinging(false);
      }, 1200);
    });
  }, []);

  const dismissToast = useCallback((id: string | number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((notif: LearnerNotification) => {
    // Suppress toast if popover is currently open
    if (isPopoverOpenRef.current) return;

    setToasts((prev) => {
      // Dedupe by id if already present in toast queue
      if (prev.some((t) => t.notification.id === notif.id)) return prev;
      const newToast: ActiveToast = {
        id: notif.id || `toast-${Date.now()}-${Math.random()}`,
        notification: notif,
        remainingMs: 4000,
      };
      return [newToast, ...prev];
    });
  }, []);

  // REST Reconcile: fetch source of truth unread count + first page and merge
  const reconcileWithRest = useCallback(async () => {
    if (!isAuthenticated) return;
    const epoch = reconcileEpochRef.current;
    reconcileInFlightRef.current = true;
    try {
      setError(null);
      const [countResp, notifs] = await Promise.all([
        notificationApi.getUnreadCount(),
        notificationApi.getNotifications(PAGE_LIMIT),
      ]);
      if (epoch !== reconcileEpochRef.current) return;

      lastReconcileCompletedAtRef.current = Date.now();
      setUnreadCount(countResp.unreadCount);
      setNotifications(notifs);
      setHasMore(notifs.length >= PAGE_LIMIT);
    } catch (err: any) {
      if (epoch !== reconcileEpochRef.current) return;
      console.warn('[Notification Realtime] REST reconcile failed:', err);
      setError(err?.message || 'Failed to load notifications');
    } finally {
      if (epoch === reconcileEpochRef.current) {
        reconcileInFlightRef.current = false;
        setIsLoading(false);
      }
    }
  }, [isAuthenticated]);

  // Handle incoming live WebSocket envelope
  const handleEnvelope = useCallback(
    (envelope: NotificationEnvelope) => {
      if (!envelope || !envelope.type) return;

      switch (envelope.type) {
        case 'NOTIFICATION_CREATED': {
          const payload = envelope.data;
          if (!payload) return;

          const newNotif: LearnerNotification = {
            id: payload.id || Date.now(),
            type: (payload.category === 'STREAK'
              ? 'STREAK'
              : payload.category === 'MILESTONE'
              ? 'LEARNING_REMINDER'
              : 'SYSTEM_UPDATE') as any,
            category: payload.category || 'SYSTEM',
            title: payload.title || 'Thông báo mới',
            body: payload.content || '',
            actionUrl: payload.actionUrl || null,
            publishedAt: payload.createdAt || new Date().toISOString(),
            read: false,
            sender: 'EnglishCoach Hệ thống',
          };

          // Update unread count
          if (typeof payload.unreadCount === 'number') {
            setUnreadCount(payload.unreadCount);
          } else {
            setUnreadCount((prev) => prev + 1);
          }

          // Prepend to list with dedupe
          setNotifications((prev) => {
            const exists = prev.some((n) => n.id === newNotif.id);
            if (exists) return prev;
            return [newNotif, ...prev];
          });

          // Visual triggers: golden bell ring + corner toast
          triggerBellRing();
          addToast(newNotif);

          // Real-time multi-tab streak and dashboard cache invalidation
          if (payload.category === 'STREAK' || payload.type === 'STREAK') {
            invalidateStreakAndDashboardCaches();
            broadcastStreakUpdate();
          }
          break;
        }

        case 'NOTIFICATION_READ': {
          const readId = envelope.data?.id;
          if (readId) {
            setNotifications((prev) =>
              prev.map((n) => (n.id === readId ? { ...n, read: true } : n))
            );
          }
          if (typeof envelope.data?.unreadCount === 'number') {
            setUnreadCount(envelope.data.unreadCount);
          } else {
            setUnreadCount((prev) => Math.max(0, prev - 1));
          }
          break;
        }

        case 'NOTIFICATIONS_ALL_READ': {
          setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
          setUnreadCount(0);
          break;
        }

        case 'UNREAD_COUNT_SYNC': {
          if (typeof envelope.data?.unreadCount === 'number') {
            setUnreadCount(envelope.data.unreadCount);
          }
          break;
        }

        default:
          break;
      }
    },
    [triggerBellRing, addToast]
  );

  // Mark single as read
  const markAsRead = useCallback(
    async (id: number) => {
      // Optimistic update
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));

      try {
        await notificationApi.markAsRead(id);
      } catch (e) {
        // Rollback on error via REST reconcile
        reconcileWithRest();
        throw e;
      }
    },
    [reconcileWithRest]
  );

  // Mark all as read
  const markAllAsRead = useCallback(async () => {
    // Optimistic update
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);

    try {
      await notificationApi.markAllAsRead();
    } catch (e) {
      reconcileWithRest();
      throw e;
    }
  }, [reconcileWithRest]);

  // Dismiss notification
  const dismissNotification = useCallback(
    async (id: number) => {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      try {
        await notificationApi.dismissNotification(id);
      } catch (e) {
        console.warn('[Notification Realtime] Failed to dismiss:', e);
        reconcileWithRest();
      }
    },
    [reconcileWithRest]
  );

  // Load more pagination
  const loadMore = useCallback(async () => {
    if (isLoadingMore || !hasMore || !isAuthenticated) return;
    const epoch = reconcileEpochRef.current;
    setIsLoadingMore(true);
    try {
      const nextPage = await notificationApi.getNotifications(notifications.length + PAGE_LIMIT);
      if (epoch !== reconcileEpochRef.current) return;
      if (nextPage.length <= notifications.length) {
        setHasMore(false);
      }
      setNotifications(nextPage);
    } catch (e) {
      if (epoch !== reconcileEpochRef.current) return;
      console.warn('[Notification Realtime] Failed loading more:', e);
    } finally {
      if (epoch === reconcileEpochRef.current) {
        setIsLoadingMore(false);
      }
    }
  }, [isLoadingMore, hasMore, isAuthenticated, notifications.length]);

  // Tab visibility reconciliation (if tab was hidden >30s)
  useEffect(() => {
    let hiddenTimestamp: number | null = null;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        hiddenTimestamp = Date.now();
      } else {
        if (hiddenTimestamp && Date.now() - hiddenTimestamp > 30000) {
          reconcileWithRest();
        }
        hiddenTimestamp = null;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [reconcileWithRest]);

  // Cross-tab instant streak & dashboard stats synchronization (BroadcastChannel + storage fallback)
  useEffect(() => {
    return initCrossTabSync();
  }, []);

  // Document title prefix (N) when unread > 0 (P2): composed by the one title writer (lib/brand/tabTitle)
  useEffect(() => {
    setUnreadTitle(unreadCount);
  }, [unreadCount]);

  // Share the single application STOMP socket (zero duplicate WebSocket per tab) with jittered broadcast sync
  useEffect(() => {
    if (!isAuthenticated) {
      lastUserIdRef.current = null;
      resetRealtimeState();
      disconnectRealtimeClient();
      setIsLoading(false);
      return;
    }

    if (lastUserIdRef.current !== null && lastUserIdRef.current !== currentUserId) {
      resetRealtimeState();
      realtimeSocket.resetConnection();
      setIsLoading(true);
    }
    lastUserIdRef.current = currentUserId;

    // Initial REST reconcile on mount
    void reconcileWithRest();

    const startGracefulDegradationPolling = () => {
      if (fallbackPollTimerRef.current) return;
      fallbackPollTimerRef.current = setInterval(() => {
        notificationApi
          .getUnreadCount()
          .then((res) => setUnreadCount(res.unreadCount))
          .catch(() => {});
      }, 60000);
    };

    const stopGracefulDegradationPolling = () => {
      if (fallbackPollTimerRef.current) {
        clearInterval(fallbackPollTimerRef.current);
        fallbackPollTimerRef.current = null;
      }
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
    };

    const scheduleDegradationTimer = () => {
      if (!disconnectTimerRef.current) {
        disconnectTimerRef.current = setTimeout(() => {
          disconnectTimerRef.current = null;
          startGracefulDegradationPolling();
        }, 20000);
      }
    };

    const handleConnectionChange = (connected: boolean) => {
      if (connected) {
        stopGracefulDegradationPolling();
        setMessengerPublisher((destination, body) => {
          publishRealtimeMessage(destination, body);
        });
        emitMessenger({ type: 'CONNECTED' });

        // Skip duplicate boot reconcile when initial REST fetch is in-flight or completed <5s ago
        if (!reconcileInFlightRef.current && Date.now() - lastReconcileCompletedAtRef.current >= 5000) {
          void reconcileWithRest();
        }
      } else {
        setMessengerPublisher(null);
        scheduleDegradationTimer();
      }
    };

    // 1. Subscribe to private user notification queue
    const unsubUser = subscribeRealtimeTopic<NotificationEnvelope>('/user/queue/notifications', (env) => {
      handleEnvelope(env);
    });

    // 2. Messenger private queue shares this one socket
    const unsubMessenger = subscribeRealtimeTopic('/user/queue/messenger', (payload) => {
      emitMessenger(payload);
    });

    // 3. Public broadcast headlines (0-15s random jitter avoids thundering-herd REST spikes)
    const unsubBroadcast = subscribeRealtimeTopic('/topic/system-announcements', () => {
      if (broadcastJitterTimerRef.current) return;
      const delayMs = Math.floor(Math.random() * 15000);
      broadcastJitterTimerRef.current = setTimeout(() => {
        broadcastJitterTimerRef.current = null;
        void reconcileWithRest();
      }, delayMs);
    });

    const unsubConn = subscribeRealtimeConnection(handleConnectionChange);

    if (isRealtimeConnected()) {
      handleConnectionChange(true);
    } else {
      scheduleDegradationTimer();
    }

    return () => {
      stopGracefulDegradationPolling();
      if (broadcastJitterTimerRef.current) {
        clearTimeout(broadcastJitterTimerRef.current);
        broadcastJitterTimerRef.current = null;
      }
      setMessengerPublisher(null);
      unsubConn();
      unsubUser();
      unsubMessenger();
      unsubBroadcast();
    };
  }, [isAuthenticated, currentUserId, reconcileWithRest, handleEnvelope, resetRealtimeState]);

  const value = useMemo<NotificationRealtimeContextValue>(
    () => ({
      unreadCount,
      notifications,
      isLoading,
      error,
      isBellRinging,
      isPopoverOpen,
      setIsPopoverOpen,
      selectedNotification,
      setSelectedNotification,
      markAsRead,
      markAllAsRead,
      dismissNotification,
      loadMore,
      hasMore,
      isLoadingMore,
      reconcileWithRest,
      toasts,
      dismissToast,
    }),
    [
      unreadCount,
      notifications,
      isLoading,
      error,
      isBellRinging,
      isPopoverOpen,
      selectedNotification,
      markAsRead,
      markAllAsRead,
      dismissNotification,
      loadMore,
      hasMore,
      isLoadingMore,
      reconcileWithRest,
      toasts,
      dismissToast,
    ]
  );

  return (
    <NotificationRealtimeContext.Provider value={value}>
      {children}
    </NotificationRealtimeContext.Provider>
  );
}
