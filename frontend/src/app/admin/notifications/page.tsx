'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSession } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  Bell,
  Send,
  Calendar,
  Globe,
  User as UserIcon,
  Clock,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Loader2,
  ShieldAlert,
  ChevronRight,
  ExternalLink,
  Inbox,
  Eye,
} from 'lucide-react';
import { notificationApi } from '@/services/notificationApi';
import {
  AdminNotification,
  AdminCreateNotificationRequest,
  NotificationScope,
  NotificationType,
} from '@/types/notification';
import { AdminFeedbackInbox } from '@/components/feedback/AdminFeedbackInbox';
import { useAdminFeedbackUnreadCount } from '@/hooks/useFeedback';
import { useCurrentRole } from '@/hooks/useCurrentRole';
import { echoSrc } from '@/lib/brand/echoCharacters';

function AdminNotificationsPageContent() {
  const { data: session, status } = useSession();
  // live backend role (users.role), never the login-time session copy
  const { isAdmin, isLoading: roleLoading } = useCurrentRole();
  const searchParams = useSearchParams();
  const [adminTab, setAdminTab] = useState<'BROADCAST' | 'INBOX'>(
    searchParams.get('tab') === 'inbox' ? 'INBOX' : 'BROADCAST'
  );
  const { unreadCount: adminUnreadCount } = useAdminFeedbackUnreadCount();

  // Composer Form State
  const [scope, setScope] = useState<NotificationScope>('GLOBAL');
  const [targetEmail, setTargetEmail] = useState('');
  const [type, setType] = useState<'SYSTEM_UPDATE' | 'EVENT'>('SYSTEM_UPDATE');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [actionUrl, setActionUrl] = useState('');
  const [publishMode, setPublishMode] = useState<'NOW' | 'SCHEDULED'>('NOW');
  const [publishAt, setPublishAt] = useState('');
  const [hasExpiresAt, setHasExpiresAt] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');

  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null);

  // History State
  const [history, setHistory] = useState<AdminNotification[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const fetchHistory = async () => {
    if (!isAdmin) return;
    setIsLoadingHistory(true);
    setHistoryError(null);
    try {
      const data = await notificationApi.getAdminNotifications(0, 50);
      setHistory(data || []);
    } catch (err: any) {
      setHistoryError(err?.response?.data?.message || 'Không thể tải lịch sử thông báo');
    } finally {
      setIsLoadingHistory(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      fetchHistory();
    }
  }, [isAdmin]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitSuccess(null);

    // Validation
    if (!title.trim()) {
      setSubmitError('Vui lòng nhập tiêu đề thông báo.');
      return;
    }
    if (!body.trim()) {
      setSubmitError('Vui lòng nhập nội dung thông báo.');
      return;
    }
    if (scope === 'USER' && !targetEmail.trim()) {
      setSubmitError('Vui lòng nhập email người nhận khi chọn phạm vi Một người dùng.');
      return;
    }

    if (actionUrl.trim()) {
      const cleanUrl = actionUrl.trim();
      if (!cleanUrl.startsWith('/') || cleanUrl.startsWith('//') || cleanUrl.includes('://')) {
        setSubmitError('Đường dẫn hành động phải là đường dẫn nội bộ bắt đầu bằng "/" (VD: /profile, /flashcards).');
        return;
      }
    }

    let publishInstant: string | null = null;
    if (publishMode === 'SCHEDULED' && publishAt) {
      publishInstant = new Date(publishAt).toISOString();
    }

    let expiresInstant: string | null = null;
    if (hasExpiresAt && expiresAt) {
      expiresInstant = new Date(expiresAt).toISOString();
      const pTime = publishInstant ? new Date(publishInstant).getTime() : Date.now();
      if (new Date(expiresInstant).getTime() <= pTime) {
        setSubmitError('Thời gian hết hạn phải sau thời gian phát hành.');
        return;
      }
    }

    const payload: AdminCreateNotificationRequest = {
      scope,
      type,
      title: title.trim(),
      body: body.trim(),
      actionUrl: actionUrl.trim() ? actionUrl.trim() : null,
      publishAt: publishInstant,
      expiresAt: expiresInstant,
      targetEmail: scope === 'USER' ? targetEmail.trim() : null,
    };

    setIsSubmitting(true);
    try {
      const created = await notificationApi.createAdminNotification(payload);
      setSubmitSuccess(
        `Đã tạo thành công thông báo #${created.id} (${created.scope === 'GLOBAL' ? 'Toàn hệ thống' : 'Người dùng ' + created.targetEmail})!`
      );
      // Reset form
      setTitle('');
      setBody('');
      setActionUrl('');
      setTargetEmail('');
      setPublishMode('NOW');
      setPublishAt('');
      setHasExpiresAt(false);
      setExpiresAt('');
      // Refresh history
      fetchHistory();
    } catch (err: any) {
      setSubmitError(
        err?.response?.data?.message ||
        err?.response?.data?.detail ||
        'Đã có lỗi xảy ra khi tạo thông báo. Vui lòng kiểm tra lại.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (status === 'loading' || roleLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600 mb-3" />
        <p className="text-sm text-slate-500">Đang kiểm tra quyền truy cập...</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="max-w-md mx-auto my-16 p-6 rounded-2xl bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/40 shadow-xl text-center">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 flex items-center justify-center mb-4">
          <ShieldAlert className="w-8 h-8" />
        </div>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
          Truy cập bị từ chối (403)
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-6">
          Khu vực này yêu cầu quyền quản trị viên (ROLE_ADMIN). Tài khoản hiện tại của bạn không có quyền truy cập trang này.
        </p>
        <Link
          href="/dashboard"
          className="inline-flex items-center justify-center px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold transition"
        >
          Quay lại Bảng điều khiển
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2.5 py-0.5 text-xs font-bold rounded-md bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300">
              Quản trị viên
            </span>
          </div>
          <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">
            Quản lý thông báo
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Soạn và phát hành thông báo toàn hệ thống hoặc gửi thông báo riêng đến tài khoản học viên.
          </p>
        </div>
      </div>

      {/* Top Tab Navigation */}
      <div className="flex items-center gap-3 border-b border-slate-200 dark:border-slate-800 pb-4 mb-8">
        <button
          type="button"
          onClick={() => setAdminTab('BROADCAST')}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer ${
            adminTab === 'BROADCAST'
              ? 'bg-purple-600 text-white shadow-md shadow-purple-600/25'
              : 'bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
          }`}
        >
          <Send className="w-3.5 h-3.5" />
          <span>Phát hành thông báo</span>
        </button>

        <button
          type="button"
          onClick={() => setAdminTab('INBOX')}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold transition cursor-pointer ${
            adminTab === 'INBOX'
              ? 'bg-purple-600 text-white shadow-md shadow-purple-600/25'
              : 'bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
          }`}
        >
          <span>📥</span>
          <span>Hộp thư góp ý</span>
          {adminUnreadCount > 0 && (
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-black ${
                adminTab === 'INBOX' ? 'bg-white text-purple-700' : 'bg-red-500 text-white'
              }`}
            >
              {adminUnreadCount > 99 ? '99+' : adminUnreadCount}
            </span>
          )}
        </button>
      </div>

      {adminTab === 'INBOX' ? (
        <AdminFeedbackInbox />
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Composer Form */}
        <div className="lg:col-span-7">
          <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
            <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-5">
              <Send className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span>Soạn thông báo mới</span>
            </h2>

            {submitError && (
              <div className="mb-5 p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 flex items-start gap-2.5 text-red-700 dark:text-red-300 text-xs">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{submitError}</span>
              </div>
            )}

            {submitSuccess && (
              <div className="mb-5 p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 flex items-start gap-2.5 text-emerald-700 dark:text-emerald-300 text-xs">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{submitSuccess}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Scope Selection */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">
                  Phạm vi người nhận
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setScope('GLOBAL')}
                    className={`flex items-center justify-center gap-2 p-3 rounded-xl border text-xs font-bold transition cursor-pointer ${
                      scope === 'GLOBAL'
                        ? 'border-indigo-600 bg-indigo-50/70 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-500 shadow-xs'
                        : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <Globe className="w-4 h-4" />
                    <span>Toàn hệ thống (Global)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setScope('USER')}
                    className={`flex items-center justify-center gap-2 p-3 rounded-xl border text-xs font-bold transition cursor-pointer ${
                      scope === 'USER'
                        ? 'border-indigo-600 bg-indigo-50/70 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-500 shadow-xs'
                        : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <UserIcon className="w-4 h-4" />
                    <span>Một người dùng (User)</span>
                  </button>
                </div>
              </div>

              {/* Target Email (Only if USER scope) */}
              {scope === 'USER' && (
                <div className="animate-in fade-in duration-200">
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                    Email tài khoản người nhận <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    value={targetEmail}
                    onChange={(e) => setTargetEmail(e.target.value)}
                    placeholder="user@example.com"
                    required
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 text-slate-800 dark:text-slate-100 text-xs focus:outline-hidden focus:ring-2 focus:ring-indigo-500 transition"
                  />
                  <p className="text-[11px] text-slate-400 mt-1">
                    Nhập chính xác địa chỉ email tài khoản đã đăng ký trên hệ thống.
                  </p>
                </div>
              )}

              {/* Type Selection */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  Loại thông báo
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setType('SYSTEM_UPDATE')}
                    className={`flex items-center gap-2 p-2.5 rounded-xl border text-xs font-semibold transition cursor-pointer ${
                      type === 'SYSTEM_UPDATE'
                        ? 'border-purple-600 bg-purple-50/60 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300 dark:border-purple-500'
                        : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                    }`}
                  >
                    <Bell className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                    <span>Cập nhật hệ thống</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setType('EVENT')}
                    className={`flex items-center gap-2 p-2.5 rounded-xl border text-xs font-semibold transition cursor-pointer ${
                      type === 'EVENT'
                        ? 'border-blue-600 bg-blue-50/60 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-500'
                        : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                    }`}
                  >
                    <Calendar className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <span>Sự kiện</span>
                  </button>
                </div>
              </div>

              {/* Title */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
                    Tiêu đề <span className="text-red-500">*</span>
                  </label>
                  <span className="text-[10px] text-slate-400">{title.length}/255</span>
                </div>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={255}
                  placeholder="VD: Ra mắt tính năng Luyện dịch nâng cao"
                  required
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 text-slate-800 dark:text-slate-100 text-xs focus:outline-hidden focus:ring-2 focus:ring-indigo-500 transition"
                />
              </div>

              {/* Body */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
                    Nội dung thông báo <span className="text-red-500">*</span>
                  </label>
                  <span className="text-[10px] text-slate-400">{body.length}/2000</span>
                </div>
                <textarea
                  rows={4}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={2000}
                  placeholder="Nhập nội dung ngắn gọn giải thích thông báo..."
                  required
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 text-slate-800 dark:text-slate-100 text-xs focus:outline-hidden focus:ring-2 focus:ring-indigo-500 transition resize-none"
                />
              </div>

              {/* Internal Action Path */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  Đường dẫn chuyển tiếp nội bộ (Tùy chọn)
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={actionUrl}
                    onChange={(e) => setActionUrl(e.target.value)}
                    placeholder="/profile hoặc /flashcards hoặc /writing"
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 text-slate-800 dark:text-slate-100 text-xs focus:outline-hidden focus:ring-2 focus:ring-indigo-500 transition"
                  />
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  Chỉ cho phép đường dẫn nội bộ bắt đầu bằng "/" (không chấp nhận link bên ngoài để bảo vệ an toàn).
                </p>
              </div>

              {/* Publish Schedule */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                    Thời điểm phát hành
                  </label>
                  <div className="flex items-center gap-2 mb-2">
                    <button
                      type="button"
                      onClick={() => setPublishMode('NOW')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                        publishMode === 'NOW'
                          ? 'bg-indigo-600 text-white shadow-xs'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      Ngay bây giờ
                    </button>
                    <button
                      type="button"
                      onClick={() => setPublishMode('SCHEDULED')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                        publishMode === 'SCHEDULED'
                          ? 'bg-indigo-600 text-white shadow-xs'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      Hẹn giờ
                    </button>
                  </div>
                  {publishMode === 'SCHEDULED' && (
                    <input
                      type="datetime-local"
                      value={publishAt}
                      onChange={(e) => setPublishAt(e.target.value)}
                      required
                      className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 text-slate-800 dark:text-slate-100 text-xs"
                    />
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-bold text-slate-700 dark:text-slate-300">
                      Thời hạn hiển thị
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={hasExpiresAt}
                        onChange={(e) => setHasExpiresAt(e.target.checked)}
                        className="rounded-sm text-indigo-600"
                      />
                      <span>Có hạn</span>
                    </label>
                  </div>
                  {hasExpiresAt && (
                    <input
                      type="datetime-local"
                      value={expiresAt}
                      onChange={(e) => setExpiresAt(e.target.value)}
                      required
                      className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 text-slate-800 dark:text-slate-100 text-xs"
                    />
                  )}
                  {!hasExpiresAt && (
                    <p className="text-[11px] text-slate-400 mt-2">
                      Thông báo sẽ hiển thị vĩnh viễn cho đến khi người dùng bỏ qua.
                    </p>
                  )}
                </div>
              </div>

              {/* Submit Button */}
              <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex justify-end">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold shadow-sm transition cursor-pointer"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Đang phát hành...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      <span>Phát hành thông báo</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Right Column: Live Popover Preview & Summary */}
        <div className="lg:col-span-5 space-y-6">
          {/* Live Preview Card */}
          <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5 text-indigo-500" />
              <span>Xem trước hiển thị (Live Preview)</span>
            </h3>
            <p className="text-[11px] text-slate-500 mb-4">
              Đây là hình ảnh thông báo sẽ hiển thị trong thanh chuông của học viên:
            </p>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/80 p-3.5">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0 w-8 h-8 rounded-xl bg-white dark:bg-slate-800 shadow-xs ring-1 ring-indigo-200 dark:ring-indigo-900/50 flex items-center justify-center">
                  <img
                    src={echoSrc('official', 32)}
                    alt=""
                    aria-hidden="true"
                    width={20}
                    height={20}
                    className="w-5 h-5 object-contain pointer-events-none select-none shrink-0"
                  />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-1">
                    <h4 className="text-xs font-bold text-slate-900 dark:text-white truncate">
                      {title.trim() || 'Tiêu đề thông báo mẫu'}
                    </h4>
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 shrink-0" />
                  </div>

                  <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 leading-relaxed break-words">
                    {body.trim() || 'Nội dung thông báo chi tiết sẽ xuất hiện ở đây...'}
                  </p>

                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[10px] text-slate-400 font-medium">Vừa xong</span>
                    {actionUrl.trim() && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-indigo-600 dark:text-indigo-400">
                        <span>Xem chi tiết</span>
                        <ChevronRight className="w-2.5 h-2.5" />
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Guidance Box */}
          <div className="rounded-2xl bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 p-5">
            <h4 className="text-xs font-bold text-indigo-900 dark:text-indigo-200 mb-2">
              Quy tắc phát thông báo hệ thống
            </h4>
            <ul className="text-[11px] text-indigo-700/80 dark:text-indigo-300/80 space-y-1.5 leading-relaxed list-disc list-inside">
              <li>Thông báo <strong>Toàn hệ thống</strong> chỉ lưu 1 bản ghi duy nhất, tối ưu 100% dung lượng.</li>
              <li>Thông báo <strong>Một người dùng</strong> yêu cầu nhập chính xác email học viên.</li>
              <li>Trạng thái Đã đọc / Bỏ qua được lưu riêng biệt cho từng người dùng.</li>
              <li>Hẹn giờ phát hành tự động hiển thị sau thời gian đã định.</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Section 2: Recent Notifications History */}
      <div className="mt-12">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Lịch sử thông báo đã phát hành
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              50 thông báo gần đây nhất được tạo bởi các quản trị viên.
            </p>
          </div>
          <button
            type="button"
            onClick={fetchHistory}
            disabled={isLoadingHistory}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${isLoadingHistory ? 'animate-spin' : ''}`} />
            <span>Làm mới</span>
          </button>
        </div>

        {isLoadingHistory && history.length === 0 ? (
          <div className="p-8 text-center bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-indigo-500 mb-2" />
            <p className="text-xs">Đang tải lịch sử...</p>
          </div>
        ) : historyError ? (
          <div className="p-6 text-center bg-white dark:bg-slate-900 rounded-2xl border border-red-200 dark:border-red-900/40 text-red-600 text-xs">
            {historyError}
          </div>
        ) : history.length === 0 ? (
          <div className="p-10 text-center bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 text-slate-400">
            <Bell className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-700 mb-2" />
            <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">Chưa có thông báo nào</p>
            <p className="text-xs text-slate-400 mt-1">Các thông báo do quản trị viên tạo sẽ xuất hiện ở bảng này.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
            <table className="w-full text-left text-xs text-slate-600 dark:text-slate-300">
              <thead className="bg-slate-50/75 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                <tr>
                  <th className="py-3 px-4">ID</th>
                  <th className="py-3 px-4">Phạm vi</th>
                  <th className="py-3 px-4">Loại</th>
                  <th className="py-3 px-4">Tiêu đề và Nội dung</th>
                  <th className="py-3 px-4">Đối tượng</th>
                  <th className="py-3 px-4">Thời gian</th>
                  <th className="py-3 px-4 text-right">Trạng thái</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-medium">
                {history.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition">
                    <td className="py-3 px-4 font-mono text-slate-400">#{item.id}</td>
                    <td className="py-3 px-4">
                      {item.scope === 'GLOBAL' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-[10px] font-bold">
                          <Globe className="w-2.5 h-2.5" />
                          <span>Hệ thống</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 text-[10px] font-bold">
                          <UserIcon className="w-2.5 h-2.5" />
                          <span>Người dùng</span>
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[10px] font-semibold">
                        {item.type}
                      </span>
                    </td>
                    <td className="py-3 px-4 max-w-xs">
                      <div className="font-bold text-slate-800 dark:text-slate-100 truncate mb-0.5">
                        {item.title}
                      </div>
                      <div className="text-[11px] text-slate-500 line-clamp-1">
                        {item.body}
                      </div>
                      {item.actionUrl && (
                        <div className="text-[10px] font-mono text-indigo-500 mt-0.5">
                          {item.actionUrl}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {item.scope === 'USER' ? (
                        <span className="text-[11px] font-mono text-slate-700 dark:text-slate-300">
                          {item.targetEmail || 'N/A'}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[11px]">Tất cả học viên</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-[11px] text-slate-500 whitespace-nowrap">
                      <div>Phát: {new Date(item.publishAt).toLocaleString('vi-VN')}</div>
                      {item.expiresAt && (
                        <div className="text-[10px] text-slate-400">
                          Hạn: {new Date(item.expiresAt).toLocaleString('vi-VN')}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {item.state === 'PUBLISHED' && (
                        <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">
                          Đã phát hành
                        </span>
                      )}
                      {item.state === 'SCHEDULED' && (
                        <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300">
                          Đã lên lịch
                        </span>
                      )}
                      {item.state === 'EXPIRED' && (
                        <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                          Hết hạn
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
        </>
      )}
    </div>
  );
}

export default function AdminNotificationsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col items-center justify-center min-h-[60vh]">
          <Loader2 className="w-8 h-8 animate-spin text-purple-600 mb-3" />
          <p className="text-sm text-slate-500">Đang tải...</p>
        </div>
      }
    >
      <AdminNotificationsPageContent />
    </Suspense>
  );
}

