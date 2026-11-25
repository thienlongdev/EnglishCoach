'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  X,
  Calendar,
  Flame,
  BookOpen,
  Info,
  Crown,
  CreditCard,
  ArrowRight,
  Bell,
} from 'lucide-react';
import { LearnerNotification, NotificationType } from '@/types/notification';
import { sanitizeOptionalLocalPath } from '@/lib/sanitize-local-path';

interface NotificationDetailModalProps {
  isOpen: boolean;
  notification: LearnerNotification | null;
  onClose: () => void;
  locale?: string;
}

export function NotificationDetailModal({
  isOpen,
  notification,
  onClose,
  locale = 'vi',
}: NotificationDetailModalProps) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !mounted || !notification) return null;

  const getTypeBadge = (type: NotificationType) => {
    switch (type) {
      case 'SYSTEM_UPDATE':
        return {
          icon: <Info className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />,
          label: locale === 'vi' ? 'Hệ thống' : 'System Update',
          className:
            'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border-blue-200/60 dark:border-blue-800/60',
        };
      case 'EVENT':
        return {
          icon: <Calendar className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />,
          label: locale === 'vi' ? 'Sự kiện' : 'Event',
          className:
            'bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 border-purple-200/60 dark:border-purple-800/60',
        };
      case 'LEARNING_REMINDER':
        return {
          icon: <Bell className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />,
          label: locale === 'vi' ? 'Nhắc nhở học tập' : 'Reminder',
          className:
            'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 border-indigo-200/60 dark:border-indigo-800/60',
        };
      case 'REVIEW_DUE':
        return {
          icon: <BookOpen className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />,
          label: locale === 'vi' ? 'Ôn tập từ vựng' : 'Vocabulary Review',
          className:
            'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200/60 dark:border-amber-800/60',
        };
      case 'STREAK':
        return {
          icon: <Flame className="w-3.5 h-3.5 text-orange-600 dark:text-orange-400" />,
          label: locale === 'vi' ? 'Chuỗi học tập' : 'Streak',
          className:
            'bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300 border-orange-200/60 dark:border-orange-800/60',
        };
      case 'PREMIUM':
        return {
          icon: <Crown className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />,
          label: locale === 'vi' ? 'Gói Premium' : 'Premium',
          className:
            'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200/60 dark:border-amber-800/60',
        };
      case 'PAYMENT':
        return {
          icon: <CreditCard className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />,
          label: locale === 'vi' ? 'Thanh toán' : 'Payment',
          className:
            'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-800/60',
        };
      default:
        return {
          icon: <Info className="w-3.5 h-3.5 text-slate-600 dark:text-slate-400" />,
          label: locale === 'vi' ? 'Thông báo' : 'Notification',
          className:
            'bg-slate-50 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700',
        };
    }
  };

  const badge = getTypeBadge(notification.type);

  const formatFullDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
    } catch {
      return dateString;
    }
  };

  const safeActionUrl = sanitizeOptionalLocalPath(notification.actionUrl);

  const handleAction = () => {
    if (safeActionUrl) {
      onClose();
      router.push(safeActionUrl);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      data-notification-modal="true"
    >
      <div
        className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
        role="dialog"
        aria-modal="true"
        aria-labelledby="notification-detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-6 pb-4 border-b border-slate-100 dark:border-slate-800 relative bg-slate-50/50 dark:bg-slate-900/50">
          <button
            type="button"
            onClick={onClose}
            className="absolute top-5 right-5 p-2 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition cursor-pointer"
            aria-label={locale === 'vi' ? 'Đóng' : 'Close'}
          >
            <X className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2 mb-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${badge.className}`}
            >
              {badge.icon}
              <span>{badge.label}</span>
            </span>
            <span className="text-[11px] text-slate-400 font-medium">
              {formatFullDate(notification.publishedAt)}
            </span>
          </div>

          <h2
            id="notification-detail-title"
            className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white leading-snug break-words pr-8"
          >
            {notification.title}
          </h2>
        </div>

        {/* Body: Untruncated full content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="p-4 sm:p-5 rounded-2xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800">
            <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap leading-relaxed break-words font-normal">
              {notification.body}
            </p>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 sm:px-6 sm:py-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            {locale === 'vi' ? 'Đóng' : 'Close'}
          </button>

          {safeActionUrl && (
            <button
              type="button"
              onClick={handleAction}
              className="inline-flex items-center gap-2 px-5 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-md shadow-indigo-600/25 transition cursor-pointer active:scale-98"
            >
              <span>{locale === 'vi' ? 'Truy cập liên kết' : 'Open Link'}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
