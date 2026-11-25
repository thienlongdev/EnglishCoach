'use client';

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import {
  Bell,
  CheckCheck,
  X,
  Loader2,
  AlertCircle,
  ChevronRight,
  MessageSquare,
  Flame,
  Trophy,
  Layers,
} from 'lucide-react';
import { apiClient } from '@/services/api-client';
import { useNotifications } from '@/hooks/useNotifications';
import { useRealtimeNotifications } from '@/context/NotificationRealtimeContext';
import { LearnerNotification, NotificationType } from '@/types/notification';
import {
  useUserFeedbackUnreadCount,
  useAdminFeedbackUnreadCount,
} from '@/hooks/useFeedback';
import { useCurrentRole } from '@/hooks/useCurrentRole';
import { echoSrc } from '@/lib/brand/echoCharacters';
import { sanitizeOptionalLocalPath } from '@/lib/sanitize-local-path';

/** True when the instant falls on today's local calendar date. */
function isTodayLocal(iso: string | undefined | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function NotificationWhaleIcon() {
  const [hasError, setHasError] = useState(false);

  if (hasError) {
    return <Bell className="w-4 h-4 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />;
  }

  return (
    <img
      src={echoSrc('official', 24)}
      alt=""
      aria-hidden="true"
      width={20}
      height={20}
      className="w-5 h-5 object-contain pointer-events-none select-none shrink-0"
      onError={() => setHasError(true)}
      loading="lazy"
    />
  );
}

interface NotificationPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenFeedback: () => void;
  onSelectNotification: (notif: LearnerNotification) => void;
  locale?: string;
  unreadCount: number;
  triggerRef?: React.RefObject<HTMLElement | null>;
}

export function NotificationPopover({
  isOpen,
  onClose,
  onOpenFeedback,
  onSelectNotification,
  locale = 'vi',
  unreadCount,
  triggerRef,
}: NotificationPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number }>({ top: 72, right: 16 });

  const { data: session } = useSession();
  const router = useRouter();
  const { isAdmin } = useCurrentRole();
  const { unreadCount: userFeedbackUnread } = useUserFeedbackUnreadCount();
  const { unreadCount: adminFeedbackUnread } = useAdminFeedbackUnreadCount();

  useEffect(() => {
    setMounted(true);
  }, []);

  const updatePosition = () => {
    if (triggerRef?.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setCoords({
        top: Math.round(rect.bottom + 8),
        right: Math.max(12, Math.round(window.innerWidth - rect.right)),
      });
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    updatePosition();

    const handleResize = () => updatePosition();
    const handleScroll = () => updatePosition();

    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen]);

  const realtime = useRealtimeNotifications();
  const {
    notifications,
    isLoading,
    error,
    reconcileWithRest,
    markAsRead,
    markAllAsRead,
    dismissNotification,
    loadMore,
    hasMore,
    isLoadingMore,
  } = realtime;

  // The Flashcards reminder keeps its words as history; next to it the popover shows the LIVE number of words still
  // due (one count request when the popover opens with such a reminder), so an old "20 từ" never looks current.
  const hasReviewReminder = notifications.some((n) => n.type === 'REVIEW_DUE');
  const [liveReviewDue, setLiveReviewDue] = useState<number | null>(null);
  useEffect(() => {
    if (!isOpen || !hasReviewReminder) return;
    let alive = true;
    apiClient
      .get('/flashcards/due-count')
      .then((res) => {
        if (alive && typeof res.data?.reviewDueCount === 'number') setLiveReviewDue(res.data.reviewDueCount);
      })
      .catch(() => {
        if (alive) setLiveReviewDue(null);
      });
    return () => {
      alive = false;
    };
  }, [isOpen, hasReviewReminder]);

  // Close on Escape or click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // Ignore clicks inside any modal (Feedback modal, Detail modal, etc.)
      if (
        target.closest?.('[data-feedback-modal="true"]') ||
        target.closest?.('[data-notification-modal="true"]') ||
        target.closest?.('[role="dialog"]:not([aria-label="Thông báo"]):not([aria-label="Notifications"])')
      ) {
        return;
      }

      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        (!triggerRef?.current || !triggerRef.current.contains(target))
      ) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose, triggerRef]);

  if (!isOpen || !mounted) return null;

  const handleItemClick = async (notif: LearnerNotification) => {
    if (!notif.read) {
      try {
        await markAsRead(notif.id);
      } catch (err) {
        console.error('Failed to mark notification read:', err);
      }
    }
    onClose();
    // the due-review reminder opens the review itself (its link is an internal route set by the server)
    const safeReviewActionUrl = notif.type === 'REVIEW_DUE' ? sanitizeOptionalLocalPath(notif.actionUrl) : null;
    if (safeReviewActionUrl) {
      router.push(safeReviewActionUrl);
      return;
    }
    onSelectNotification(notif);
  };

  const handleDismiss = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    try {
      await dismissNotification(id);
    } catch (err) {
      console.error('Failed to dismiss notification:', err);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllAsRead();
    } catch (err) {
      console.error('Failed to mark all notifications read:', err);
    }
  };

  const renderTypeIcon = (notif: LearnerNotification) => {
    if (notif.type === 'REVIEW_DUE') {
      return <Layers className="w-4 h-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
    }
    if (notif.category === 'STREAK' || notif.type === 'STREAK') {
      return <Flame className="w-4 h-4 text-orange-500 fill-orange-500/20" aria-hidden="true" />;
    }
    if (notif.category === 'MILESTONE') {
      return <Trophy className="w-4 h-4 text-amber-500 fill-amber-500/20" aria-hidden="true" />;
    }
    return <NotificationWhaleIcon />;
  };

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={locale === 'vi' ? 'Thông báo' : 'Notifications'}
      aria-modal="true"
      style={{
        position: 'fixed',
        top: `${coords.top}px`,
        right: `${coords.right}px`,
      }}
      className="w-[calc(100vw-1.5rem)] sm:w-96 max-w-sm max-h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl z-[9999] overflow-hidden animate-in fade-in zoom-in-95 duration-150"
    >
      {/* Popover Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/70 backdrop-blur-xs">
        {/* Left Side: Title & Unread Count */}
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">
            {locale === 'vi' ? 'Thông báo' : 'Notifications'}
          </h3>
          {unreadCount > 0 && (
            <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
              {unreadCount > 99 ? '99+' : unreadCount} {locale === 'vi' ? 'mới' : 'new'}
            </span>
          )}
        </div>

        {/* Right Side: Inline Góp ý Button and Mark All Read */}
        <div className="flex items-center gap-1.5">
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer"
              title={locale === 'vi' ? 'Đánh dấu tất cả đã đọc' : 'Mark all as read'}
            >
              <CheckCheck className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
              <span className="hidden sm:inline text-[11px]">{locale === 'vi' ? 'Đã đọc' : 'Read all'}</span>
            </button>
          )}

          {/* Strict Role Guard: Only visible to non-admin accounts */}
          {!isAdmin && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenFeedback();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full border border-purple-200 dark:border-purple-800/80 bg-purple-50/90 hover:bg-purple-100 dark:bg-purple-950/50 dark:hover:bg-purple-900/70 text-purple-700 dark:text-purple-300 hover:border-purple-300 dark:hover:border-purple-700 shadow-2xs transition-all duration-150 cursor-pointer active:scale-95"
              title={locale === 'vi' ? 'Góp ý cho EnglishCoach' : 'Send feedback'}
            >
              <MessageSquare className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
              <span>{locale === 'vi' ? 'Góp ý' : 'Feedback'}</span>
              {userFeedbackUnread > 0 && (
                <span className="w-1.5 h-1.5 rounded-full bg-purple-600 dark:bg-purple-400 animate-pulse" />
              )}
            </button>
          )}

          {/* Admin Inbox link */}
          {isAdmin && adminFeedbackUnread > 0 && (
            <Link
              href="/admin/notifications?tab=inbox"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-full border border-amber-200 dark:border-amber-800/80 bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/40 dark:hover:bg-amber-900/60 text-amber-700 dark:text-amber-300 transition cursor-pointer"
              title="Hộp thư góp ý"
            >
              <span>📥</span>
              <span>{adminFeedbackUnread}</span>
            </Link>
          )}
        </div>
      </div>

      {/* Notification Content Area */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/60 max-h-[60vh]">
        {isLoading && notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin text-indigo-500 mb-2" />
            <p className="text-xs">{locale === 'vi' ? 'Đang tải thông báo...' : 'Loading notifications...'}</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
            <AlertCircle className="w-6 h-6 text-red-500 mb-2" />
            <p className="text-xs text-slate-600 dark:text-slate-400 mb-3">
              {locale === 'vi' ? 'Không thể tải thông báo.' : 'Unable to load notifications.'}
            </p>
            <button
              type="button"
              onClick={() => reconcileWithRest()}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-300 hover:bg-indigo-100 transition cursor-pointer"
            >
              {locale === 'vi' ? 'Thử lại' : 'Retry'}
            </button>
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 px-4 text-center">
            <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800/80 flex items-center justify-center mb-3 text-slate-400">
              <Bell className="w-5 h-5" />
            </div>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
              {locale === 'vi' ? 'Bạn chưa có thông báo nào.' : 'You have no notifications.'}
            </p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
              {locale === 'vi'
                ? 'Các thông báo hệ thống và học tập sẽ xuất hiện ở đây.'
                : 'System and learning updates will appear here.'}
            </p>
          </div>
        ) : (
          notifications.map((notif) => (
            <div
              key={notif.id}
              onClick={() => handleItemClick(notif)}
              className={`group relative flex items-start gap-3 p-3.5 transition cursor-pointer select-none ${
                !notif.read
                  ? 'bg-indigo-50/40 dark:bg-indigo-950/20 hover:bg-indigo-50/70 dark:hover:bg-indigo-950/35'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
              }`}
            >
              {/* Type Icon Badge */}
              <div
                className={`mt-0.5 shrink-0 w-8 h-8 rounded-xl flex items-center justify-center ${
                  !notif.read
                    ? 'bg-white dark:bg-slate-800 shadow-xs ring-1 ring-indigo-200 dark:ring-indigo-900/50'
                    : 'bg-slate-100 dark:bg-slate-800/60'
                }`}
              >
                {renderTypeIcon(notif)}
              </div>

              {/* Text Content */}
              <div className="flex-1 min-w-0 pr-5">
                <div className="flex items-center gap-1.5 mb-1">
                  <h4
                    className={`text-xs truncate ${
                      !notif.read
                        ? 'font-bold text-slate-900 dark:text-white'
                        : 'font-semibold text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {notif.title}
                  </h4>
                  {!notif.read && (
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 shrink-0" />
                  )}
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 leading-relaxed break-words">
                  {notif.body}
                </p>
                {notif.type === 'REVIEW_DUE' && liveReviewDue !== null && isTodayLocal(notif.publishedAt) && (
                  <p className={`mt-1 text-[11px] font-semibold ${liveReviewDue > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
                    {liveReviewDue > 0
                      ? (locale === 'vi' ? `Hiện còn ${liveReviewDue} từ cần ôn` : `${liveReviewDue} words still due`)
                      : (locale === 'vi' ? 'Bạn đã ôn xong các từ đến hạn hôm nay' : 'You reviewed every due word today')}
                  </p>
                )}

                <div className="flex items-center justify-between gap-2 mt-2">
                  <span className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">
                    {formatRelativeTime(notif.publishedAt, locale)}
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 group-hover:underline">
                    <span>{locale === 'vi' ? 'Xem chi tiết' : 'View details'}</span>
                    <ChevronRight className="w-2.5 h-2.5" />
                  </span>
                </div>
              </div>

              {/* Dismiss Button */}
              <button
                type="button"
                onClick={(e) => handleDismiss(e, notif.id)}
                className="absolute top-2.5 right-2.5 p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 opacity-60 group-hover:opacity-100 transition cursor-pointer"
                title={locale === 'vi' ? 'Bỏ qua' : 'Dismiss'}
                aria-label={locale === 'vi' ? 'Bỏ qua thông báo' : 'Dismiss notification'}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))
        )}

        {hasMore && notifications.length > 0 && (
          <div className="p-3 text-center border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
            <button
              type="button"
              onClick={() => loadMore()}
              disabled={isLoadingMore}
              className="px-4 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded-lg transition disabled:opacity-50 cursor-pointer"
            >
              {isLoadingMore ? (
                <span className="inline-flex items-center justify-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>{locale === 'vi' ? 'Đang tải...' : 'Loading...'}</span>
                </span>
              ) : (
                locale === 'vi' ? 'Xem thêm thông báo' : 'Load more'
              )}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function formatRelativeTime(dateString: string, locale: string): string {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diffSeconds < 60) {
      return locale === 'vi' ? 'Vừa xong' : 'Just now';
    }
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) {
      return locale === 'vi' ? `${diffMinutes} phút trước` : `${diffMinutes}m ago`;
    }
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
      return locale === 'vi' ? `${diffHours} giờ trước` : `${diffHours}h ago`;
    }
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
      return locale === 'vi' ? `${diffDays} ngày trước` : `${diffDays}d ago`;
    }
    return date.toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-US', {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}
