'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { useCurrentRole } from '@/hooks/useCurrentRole';
import { adminGardenCommerceApi, type AdminGardenCommerceQueue, type AdminGardenIssue, type AdminGardenRefund } from '@/services/adminGardenCommerceApi';

const ISSUE_LABEL: Record<string, string> = {
  LATE_PAYMENT: 'Chuyển khoản sau khi mã hết hạn',
  AMOUNT_MISMATCH: 'Sai số tiền',
  ALREADY_OWNED: 'Khách đã có món này',
  ORDER_CLOSED: 'Đơn đã đóng',
  DUPLICATE_PAYMENT: 'Chuyển khoản trùng',
  UNAVAILABLE: 'Món không còn trong danh mục',
};

const REFUND_KIND: Record<string, string> = {
  CUSTOMER_REQUEST: 'Khách yêu cầu', DELIVERY_FAILURE: 'Giao hàng lỗi', DUPLICATE_CHARGE: 'Trừ tiền trùng',
  UNAUTHORIZED: 'Giao dịch không được phép', DEFECT: 'Sản phẩm lỗi', CHARGEBACK: 'Tra soát ngân hàng',
};

const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(n)}đ`;
const when = (iso: string) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

function errorText(err: unknown): string {
  const r = (err as { response?: { status?: number; data?: { code?: string } } })?.response;
  if (r?.status === 403) return 'Không có quyền (403).';
  if (r?.data?.code === 'BANK_REFERENCE_REQUIRED') return 'Cần mã giao dịch chuyển khoản hoàn tiền.';
  if (r?.data?.code === 'NOTE_REQUIRED') return 'Cần ghi chú lý do từ chối.';
  if (r?.data?.code === 'ISSUE_NOT_DELIVERABLE') return 'Khoản này không thể giao hàng (sai số tiền, khách đã có món, hoặc đơn không ở trạng thái hết hạn). Hãy hoàn tiền thủ công.';
  if (r?.data?.code) return `Không thực hiện được (${r.data.code}).`;
  return 'Không thể thực hiện. Vui lòng thử lại.';
}

/**
 * "Đối soát Skin Echo Garden" (official administrator only). Two queues: refund requests, and verified SePay transfers
 * that could not be delivered automatically. Nothing here sends money: a refund is completed AFTER the administrator
 * transferred the amount back by hand and enters that transfer's reference; the backend then takes the item back.
 */
export default function AdminGardenCommercePage() {
  const { status } = useSession();
  const { isAdmin, isLoading: roleLoading } = useCurrentRole();
  const [queue, setQueue] = useState<AdminGardenCommerceQueue | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const run = useCallback(async (work: () => Promise<AdminGardenCommerceQueue>, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      setQueue(await work());
      if (done) setMessage({ kind: 'ok', text: done });
    } catch (err) {
      setMessage({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void run(() => adminGardenCommerceApi.queue());
  }, [isAdmin, run]);

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
        <Link href="/" className="inline-flex rounded-xl bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">Về trang chủ</Link>
      </div>
    );
  }

  const input = 'min-h-[40px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white';
  const button = 'inline-flex min-h-[40px] items-center justify-center rounded-xl px-3 text-xs font-bold text-white disabled:opacity-50 cursor-pointer';

  const refundRow = (r: AdminGardenRefund) => {
    const k = `r${r.id}`;
    return (
      <li key={r.id} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900" data-testid={`admin-garden-refund-${r.id}`}>
        <p className="text-sm font-bold text-slate-900 dark:text-white">Đơn #{r.orderId} · {r.itemCode} · {vnd(r.amountVnd)}</p>
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">Người dùng #{r.userId} · {REFUND_KIND[r.kind] ?? r.kind} · {when(r.requestedAt)} · mã {r.transferCode}</p>
        <p className="mt-1 text-xs text-slate-700 dark:text-slate-300">Lý do: {r.reason}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input className={input} placeholder="Mã giao dịch hoàn tiền (ngân hàng)" value={refs[k] ?? ''} onChange={(e) => setRefs({ ...refs, [k]: e.target.value })} aria-label="Mã giao dịch hoàn tiền" />
          <input className={input} placeholder="Ghi chú" value={notes[k] ?? ''} onChange={(e) => setNotes({ ...notes, [k]: e.target.value })} aria-label="Ghi chú" />
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button type="button" disabled={busy} className={`${button} bg-slate-500 hover:bg-slate-400`}
            onClick={() => void run(() => adminGardenCommerceApi.rejectRefund(r.id, notes[k] ?? ''), 'Đã từ chối yêu cầu hoàn tiền.')}>Từ chối (cần ghi chú)</button>
          <button type="button" disabled={busy} className={`${button} bg-emerald-600 hover:bg-emerald-500`}
            onClick={() => void run(() => adminGardenCommerceApi.completeRefund(r.id, refs[k] ?? '', notes[k] ?? ''), 'Đã ghi nhận hoàn tiền và thu lại món.')}>Đã chuyển khoản hoàn · hoàn tất</button>
        </div>
      </li>
    );
  };

  const issueRow = (i: AdminGardenIssue) => {
    const k = `i${i.id}`;
    return (
      <li key={i.id} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900" data-testid={`admin-garden-issue-${i.id}`}>
        <p className="text-sm font-bold text-slate-900 dark:text-white">{ISSUE_LABEL[i.kind] ?? i.kind} · đơn #{i.orderId} · {i.itemCode}</p>
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
          Người dùng #{i.userId} · nhận {vnd(i.paidAmountVnd)} (đơn {vnd(i.orderAmountVnd)}) · giao dịch {i.providerTransactionId} · {when(i.createdAt)} · đơn đang {i.orderStatus}
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input className={input} placeholder="Mã giao dịch hoàn tiền (nếu hoàn)" value={refs[k] ?? ''} onChange={(e) => setRefs({ ...refs, [k]: e.target.value })} aria-label="Mã giao dịch hoàn tiền" />
          <input className={input} placeholder="Ghi chú" value={notes[k] ?? ''} onChange={(e) => setNotes({ ...notes, [k]: e.target.value })} aria-label="Ghi chú" />
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {i.kind === 'LATE_PAYMENT' && i.paidAmountVnd === i.orderAmountVnd && (
            <button type="button" disabled={busy} className={`${button} bg-indigo-600 hover:bg-indigo-500`}
              onClick={() => void run(() => adminGardenCommerceApi.resolveIssue(i.id, 'DELIVERED', '', notes[k] ?? ''), 'Đã giao món cho khách.')}>Giao hàng cho khách</button>
          )}
          <button type="button" disabled={busy} className={`${button} bg-emerald-600 hover:bg-emerald-500`}
            onClick={() => void run(() => adminGardenCommerceApi.resolveIssue(i.id, 'REFUNDED_MANUALLY', refs[k] ?? '', notes[k] ?? ''), 'Đã ghi nhận hoàn tiền thủ công.')}>Đã chuyển khoản hoàn</button>
        </div>
      </li>
    );
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-black text-slate-900 dark:text-white">Đối soát Skin Echo Garden</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Thanh toán chuyển khoản qua SePay: {queue ? (queue.checkoutEnabled ? 'ĐANG MỞ' : 'ĐANG ĐÓNG') : '…'}. Hoàn tiền luôn là chuyển khoản thủ công; nhập mã giao dịch để hoàn tất.
          </p>
        </div>
        <button type="button" disabled={busy} onClick={() => void run(() => adminGardenCommerceApi.queue())}
          className="inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-slate-300 px-3 text-xs font-bold text-slate-700 dark:border-slate-700 dark:text-slate-200 cursor-pointer">
          <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> Tải lại
        </button>
      </header>
      {message && (
        <p role="status" className={`rounded-xl px-4 py-3 text-sm font-semibold ${message.kind === 'ok' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'}`}>
          {message.text}
        </p>
      )}
      <section aria-label="Yêu cầu hoàn tiền">
        <h2 className="mb-2 text-sm font-bold text-slate-800 dark:text-slate-200">Yêu cầu hoàn tiền ({queue?.refunds.length ?? 0})</h2>
        {queue && queue.refunds.length === 0 && <p className="text-xs text-slate-500">Không có yêu cầu nào đang chờ.</p>}
        <ul className="space-y-3">{queue?.refunds.map(refundRow)}</ul>
      </section>
      <section aria-label="Chuyển khoản cần đối soát">
        <h2 className="mb-2 text-sm font-bold text-slate-800 dark:text-slate-200">Chuyển khoản cần đối soát ({queue?.issues.length ?? 0})</h2>
        {queue && queue.issues.length === 0 && <p className="text-xs text-slate-500">Không có khoản nào đang chờ.</p>}
        <ul className="space-y-3">{queue?.issues.map(issueRow)}</ul>
      </section>
    </div>
  );
}
