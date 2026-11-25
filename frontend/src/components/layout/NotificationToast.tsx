'use client';

import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Flame, Trophy, Bell } from 'lucide-react';
import { LearnerNotification, NotificationCategory } from '@/types/notification';

export interface ActiveToast {
  id: string | number;
  notification: LearnerNotification;
  remainingMs: number;
}

interface NotificationToastContainerProps {
  toasts: ActiveToast[];
  onDismiss: (id: string | number) => void;
  onSelect: (notification: LearnerNotification) => void;
  isPopoverOpen: boolean;
}

export function NotificationToastContainer({
  toasts,
  onDismiss,
  onSelect,
  isPopoverOpen,
}: NotificationToastContainerProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || isPopoverOpen || toasts.length === 0) {
    return null;
  }

  // Display at most 3 toasts stacked, newest on top
  const visibleToasts = toasts.slice(0, 3);

  return createPortal(
    <aside
      data-echo-clear=""
      className="fixed bottom-5 right-5 z-[9999] flex flex-col-reverse gap-2.5 max-w-sm w-full pointer-events-none px-3 sm:px-0"
      aria-label="Thông báo thời gian thực"
    >
      {visibleToasts.map((toast) => (
        <NotificationToastItem
          key={toast.id}
          toast={toast}
          onDismiss={onDismiss}
          onSelect={onSelect}
        />
      ))}
    </aside>,
    document.body
  );
}

function NotificationToastItem({
  toast,
  onDismiss,
  onSelect,
}: {
  toast: ActiveToast;
  onDismiss: (id: string | number) => void;
  onSelect: (notification: LearnerNotification) => void;
}) {
  const [isPaused, setIsPaused] = useState(false);
  const [timeLeft, setTimeLeft] = useState(toast.remainingMs || 4000);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isPaused) return;

    const interval = 100;
    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= interval) {
          clearInterval(timerRef.current!);
          onDismiss(toast.id);
          return 0;
        }
        return prev - interval;
      });
    }, interval);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isPaused, toast.id, onDismiss]);

  const category = toast.notification.category || 'SYSTEM';

  const getCategoryIcon = () => {
    switch (category) {
      case 'STREAK':
        return (
          <div className="w-8 h-8 rounded-lg bg-orange-100 dark:bg-orange-950/60 text-orange-600 dark:text-orange-400 flex items-center justify-center shrink-0 border border-orange-200/60 dark:border-orange-800/40">
            <Flame className="w-4 h-4 fill-orange-500/20" aria-hidden="true" />
          </div>
        );
      case 'MILESTONE':
        return (
          <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0 border border-amber-200/60 dark:border-amber-800/40">
            <Trophy className="w-4 h-4 fill-amber-500/20" aria-hidden="true" />
          </div>
        );
      case 'SYSTEM':
      default:
        return (
          <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0 border border-indigo-200/60 dark:border-indigo-800/40">
            <Bell className="w-4 h-4 fill-indigo-500/20" aria-hidden="true" />
          </div>
        );
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      tabIndex={0}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
      onClick={() => onSelect(toast.notification)}
      className="pointer-events-auto group relative w-full bg-white dark:bg-[#111625] text-slate-900 dark:text-slate-100 rounded-xl p-3.5 shadow-xl shadow-slate-900/15 border border-slate-200/80 dark:border-slate-800/80 hover:border-indigo-400/60 dark:hover:border-indigo-600/60 transition-all duration-200 cursor-pointer overflow-hidden transform animate-in slide-in-from-bottom-3 fade-in duration-300"
    >
      {/* Progress line */}
      <div
        className="absolute bottom-0 left-0 h-[2.5px] bg-gradient-to-r from-indigo-500 to-amber-500 transition-all duration-100"
        style={{ width: `${(timeLeft / 4000) * 100}%` }}
      />

      <div className="flex items-start gap-3">
        {getCategoryIcon()}
        <div className="flex-1 min-w-0 pr-4">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {category === 'STREAK' ? 'Chuỗi học tập' : category === 'MILESTONE' ? 'Cột mốc' : 'Hệ thống'}
            </span>
            <span className="text-[10px] text-slate-400 dark:text-slate-500">•</span>
            <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
              {toast.notification.sender || 'EnglishCoach Hệ thống'}
            </span>
          </div>
          <h4 className="text-xs font-bold text-slate-900 dark:text-white line-clamp-1 leading-snug">
            {toast.notification.title}
          </h4>
          <p className="text-[11px] text-slate-600 dark:text-slate-300 line-clamp-2 mt-0.5 leading-relaxed">
            {toast.notification.body}
          </p>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss(toast.id);
          }}
          className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition"
          aria-label="Đóng thông báo"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
