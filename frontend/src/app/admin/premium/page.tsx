'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { Crown, History, Loader2, Search, ShieldAlert, UserX } from 'lucide-react';
import { useCurrentRole } from '@/hooks/useCurrentRole';
import {
  adminPremiumApi,
  type AdminPremiumEntitlement,
  type AdminPremiumUserSummary,
} from '@/services/adminPremiumApi';

const DURATIONS: { value: string; label: string }[] = [
  { value: '1', label: '1 tháng' },
  { value: '3', label: '3 tháng' },
  { value: '6', label: '6 tháng' },
  { value: '12', label: '12 tháng' },
  { value: '24', label: '24 tháng' },
  { value: '36', label: '36 tháng' },
  { value: 'permanent', label: 'Vĩnh viễn' },
];

const SOURCE_LABEL: Record<string, string> = {
  ADMIN_GRANT: 'Quản trị viên cấp',
  SYSTEM: 'Hệ thống',
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  if (d.getUTCFullYear() >= 2099) return 'Vĩnh viễn';
  return new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

function sourceLabel(s: string | null | undefined): string {
  if (!s) return '–';
  return SOURCE_LABEL[s] ?? `Thanh toán (${s})`;
}

function errorText(e: unknown): string {
  const r = (e as { response?: { status?: number; data?: { message?: string } | string } })?.response;
  if (r?.status === 403) return 'Không có quyền (403).';
  if (r?.status === 409) return 'Người dùng không có Premium do quản trị cấp đang hiệu lực.';
  if (r?.status === 400) return 'Dữ liệu không hợp lệ: cần lý do và thời hạn 1–36 tháng hoặc vĩnh viễn.';
  return 'Không thể thực hiện. Vui lòng thử lại.';
}

/**
 * "Quản lý Premium" (official administrator only): grant / revoke Premium manually. A grant is an ADMIN_GRANT
 * entitlement — never a payment or bank transfer; paid subscriptions are shown but never changed. Every action needs a
 * reason and is written to the append-only audit (history below). The backend re-checks the administrator on each call.
 */
export default function AdminPremiumPage() {
  const { status } = useSession();
  const { isAdmin, isLoading: roleLoading } = useCurrentRole();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AdminPremiumUserSummary[] | null>(null);
  const [selected, setSelected] = useState<AdminPremiumEntitlement | null>(null);
  const [duration, setDuration] = useState('1');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  if (status === 'loading' || roleLoading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center">
        <Loader2 className="mb-3 h-8 w-8 animate-spin text-amber-500" />
        <p className="text-sm text-slate-500">Đang kiểm tra quyền truy cập...</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto my-16 max-w-md rounded-2xl border border-red-200 bg-white p-6 text-center shadow-xl dark:border-red-900/40 dark:bg-slate-900">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-red-500" />
        <h2 className="mb-2 text-lg font-bold text-slate-900 dark:text-white">Truy cập bị từ chối (403)</h2>
        <p className="mb-6 text-xs text-slate-500 dark:text-slate-400">Khu vực này chỉ dành cho quản trị viên.</p>
        <Link href="/" className="inline-flex rounded-xl bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
          Về trang chủ
        </Link>
      </div>
    );
  }

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      setResults(await adminPremiumApi.search(query.trim()));
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const open = async (userId: number) => {
    setBusy(true);
    setMessage(null);
    try {
      setSelected(await adminPremiumApi.view(userId));
      setReason('');
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const grant = async () => {
    if (!selected || !reason.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const body = duration === 'permanent'
        ? { permanent: true, reason: reason.trim() }
        : { months: Number(duration), reason: reason.trim() };
      setSelected(await adminPremiumApi.grant(selected.userId, body));
      setReason('');
      setMessage({ kind: 'ok', text: 'Đã cấp Premium (không tạo giao dịch thanh toán).' });
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!selected || !reason.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      setSelected(await adminPremiumApi.revoke(selected.userId, reason.trim()));
      setReason('');
      setMessage({ kind: 'ok', text: 'Đã thu hồi Premium do quản trị cấp. Gói đã thanh toán (nếu có) giữ nguyên.' });
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-3 py-6 sm:px-6 sm:py-8" data-testid="admin-premium-page">
      <header className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-500">
          <Crown className="h-6 w-6" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-xl font-black text-slate-900 dark:text-white">Quản lý Premium</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Cấp hoặc thu hồi Premium thủ công. Không tạo giao dịch thanh toán; mọi thao tác đều được ghi nhật ký.
          </p>
        </div>
      </header>

      <form onSubmit={search} className="flex gap-2">
        <label className="relative flex-1">
          <span className="sr-only">Tìm người dùng</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ID, email hoặc tên người dùng"
            className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            data-testid="admin-premium-search"
          />
        </label>
        <button type="submit" disabled={busy} className="rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
          Tìm
        </button>
      </form>

      {message && (
        <p role="status" className={`rounded-xl px-3 py-2 text-sm ${message.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-rose-500/10 text-rose-700 dark:text-rose-300'}`}>
          {message.text}
        </p>
      )}

      {results && (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800" data-testid="admin-premium-results">
          {results.length === 0 && <li className="px-4 py-3 text-sm text-slate-500">Không tìm thấy người dùng.</li>}
          {results.map((u) => (
            <li key={u.userId}>
              <button
                type="button"
                onClick={() => open(u.userId)}
                className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-slate-50 dark:hover:bg-white/[0.04] ${selected?.userId === u.userId ? 'bg-amber-500/5' : ''}`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-slate-900 dark:text-white">#{u.userId} · {u.displayName}</span>
                  <span className="block truncate text-xs text-slate-500">{u.email}{u.role === 'ROLE_ADMIN' ? ' · Quản trị viên' : ''}</span>
                </span>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold ${u.premium ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-slate-100 text-slate-500 dark:bg-white/10'}`}>
                  {u.premium ? 'Premium' : 'Miễn phí'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <section className="space-y-4 rounded-2xl border border-amber-400/30 bg-white p-4 dark:bg-slate-900 sm:p-5" data-testid="admin-premium-detail">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">#{selected.userId} · {selected.displayName}</h2>
            <p className="text-xs text-slate-500">{selected.email}</p>
          </div>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-slate-500">Trạng thái</dt><dd className="font-semibold">{selected.premium ? `Premium · ${selected.planName ?? ''}` : 'Miễn phí'}</dd></div>
            <div><dt className="text-xs text-slate-500">Hết hạn</dt><dd className="font-semibold">{fmt(selected.premiumExpiresAt)}</dd></div>
            <div><dt className="text-xs text-slate-500">Nguồn</dt><dd className="font-semibold">{sourceLabel(selected.premiumSource)}</dd></div>
            <div><dt className="text-xs text-slate-500">Premium do quản trị cấp</dt><dd className="font-semibold">{selected.adminGrantActive ? `Đang hiệu lực đến ${fmt(selected.adminGrantExpiresAt)}` : 'Không'}</dd></div>
          </dl>
          {selected.paidActive && (
            <p className="rounded-xl bg-sky-500/10 px-3 py-2 text-xs text-sky-800 dark:text-sky-200">
              Người dùng có gói đã thanh toán — công cụ này không thay đổi gói đó.
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-slate-500">Thời hạn</span>
              <select value={duration} onChange={(e) => setDuration(e.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" data-testid="admin-premium-duration">
                {DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs text-slate-500">Lý do (bắt buộc, ghi vào nhật ký)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Ví dụ: học bổng tháng 10"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900" data-testid="admin-premium-reason" />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={grant} disabled={busy || !reason.trim()} data-testid="admin-premium-grant"
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              <Crown className="h-4 w-4" aria-hidden="true" /> Cấp Premium
            </button>
            <button type="button" onClick={revoke} disabled={busy || !reason.trim() || !selected.adminGrantActive} data-testid="admin-premium-revoke"
              className="inline-flex items-center gap-2 rounded-xl border border-rose-400/50 px-4 py-2 text-sm font-semibold text-rose-700 disabled:opacity-40 dark:text-rose-300">
              <UserX className="h-4 w-4" aria-hidden="true" /> Thu hồi Premium do quản trị cấp
            </button>
          </div>

          <div>
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700 dark:text-slate-200">
              <History className="h-4 w-4" aria-hidden="true" /> Nhật ký cấp / thu hồi
            </h3>
            {selected.history.length === 0 ? (
              <p className="text-xs text-slate-500">Chưa có thao tác nào.</p>
            ) : (
              <ul className="space-y-1.5 text-xs" data-testid="admin-premium-history">
                {selected.history.map((h) => (
                  <li key={h.id} className="rounded-xl bg-slate-50 px-3 py-2 dark:bg-white/[0.04]">
                    <span className="font-bold">{h.action === 'GRANT' ? 'Cấp' : 'Thu hồi'}</span> · {fmt(h.createdAt)} · bởi #{h.adminUserId}
                    {' — '}{h.reason}
                    <span className="block text-slate-500">
                      Trước: {h.previousPremium ? `Premium đến ${fmt(h.previousExpiresAt)}` : 'Miễn phí'} → Sau: {h.newPremium ? `Premium đến ${fmt(h.newExpiresAt)}` : 'Miễn phí'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
