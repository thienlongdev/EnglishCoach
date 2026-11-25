'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Copy,
  Check,
  Clock,
  QrCode,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Crown,
  ArrowRight,
} from 'lucide-react';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import { PaymentOrderResponse, paymentApi } from '@/services/paymentApi';

/**
 * A one-time product paid through the SAME SePay bank-transfer sheet (for example an Echo Garden cosmetic). Only the
 * wording and where the order is polled differ; the QR, the receiving account, the transfer content, the countdown and
 * the status handling are this sheet's. Without it the sheet is the Premium checkout, exactly as before.
 */
export interface CheckoutProduct {
  /** Sheet title, e.g. "Thanh toán Skin Echo Garden". */
  heading: string;
  /** The product's own name (shown where the Premium plan name is shown). */
  label: string;
  /** Reads the order from the module that owns it. */
  fetchOrder: (orderId: number) => Promise<PaymentOrderResponse>;
  /** What the buyer is told once the server confirmed and delivered. */
  successText: string;
  successCta: string;
  /** The last line of the transfer instructions. */
  instruction: string;
  pollMs?: number;
}

interface PaymentCheckoutModalProps {
  order: PaymentOrderResponse;
  onClose: () => void;
  onSuccess: () => void;
  onRenewOrder: (planCode: string) => Promise<void>;
  product?: CheckoutProduct;
}

export function PaymentCheckoutModal({
  order: initialOrder,
  onClose,
  onSuccess,
  onRenewOrder,
  product,
}: PaymentCheckoutModalProps) {
  const fetchOrderRef = useRef(product?.fetchOrder ?? paymentApi.getPaymentOrder);
  useEffect(() => {
    fetchOrderRef.current = product?.fetchOrder ?? paymentApi.getPaymentOrder;
  }, [product]);
  const [order, setOrder] = useState<PaymentOrderResponse>(initialOrder);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [timeLeftSeconds, setTimeLeftSeconds] = useState<number>(() => {
    if (!initialOrder.expiresAt) return 0;
    const diff = Math.floor((new Date(initialOrder.expiresAt).getTime() - Date.now()) / 1000);
    return Math.max(0, diff);
  });
  const [isRenewing, setIsRenewing] = useState<boolean>(false);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const isFetchingRef = useRef<boolean>(false);
  const onSuccessRef = useRef(onSuccess);
  const hasNotifiedSuccessRef = useRef(false);

  // Keep onSuccessRef updated with latest callback
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  // Sync state if initialOrder changes
  useEffect(() => {
    setOrder(initialOrder);
  }, [initialOrder]);

  // Countdown timer derived strictly from expiresAt; stops immediately when PAID
  useEffect(() => {
    if (order.status === 'PAID') {
      return;
    }

    const updateCountdown = () => {
      if (!order.expiresAt) return;
      const expiresMs = new Date(order.expiresAt).getTime();
      const nowMs = Date.now();
      const diff = Math.max(0, Math.floor((expiresMs - nowMs) / 1000));
      setTimeLeftSeconds(diff);

    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [order.expiresAt, order.status]);

  // Status polling: bounded 1.5s interval while PENDING; stops immediately on terminal states
  useEffect(() => {
    const isTerminal = order.status === 'PAID' || order.status === 'EXPIRED' || order.status === 'CANCELLED';
    if (isTerminal) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      if (order.status === 'PAID' && !hasNotifiedSuccessRef.current) {
        hasNotifiedSuccessRef.current = true;
        onSuccessRef.current();
      }
      return;
    }

    let isMounted = true;

    const poll = async () => {
      if (isFetchingRef.current || !isMounted) return;
      isFetchingRef.current = true;
      try {
        const latest = await fetchOrderRef.current(order.orderId);
        if (!isMounted || !latest) return;
        if (latest.status === 'PENDING' && latest.notice !== undefined) {
          setOrder((prev) => (prev.notice === latest.notice ? prev : { ...prev, notice: latest.notice }));
        }
        if (latest.status !== 'PENDING') {
          setOrder(latest);
          if (latest.status === 'PAID' && !hasNotifiedSuccessRef.current) {
            hasNotifiedSuccessRef.current = true;
            if (pollingRef.current) {
              clearInterval(pollingRef.current);
              pollingRef.current = null;
            }
            onSuccessRef.current();
          }
        }
      } catch (err) {
        console.error('[PaymentCheckout] Polling error:', err);
      } finally {
        isFetchingRef.current = false;
      }
    };

    // Immediate poll on mount / order transition
    poll();

    // Fast 1.5s polling interval
    pollingRef.current = setInterval(poll, product?.pollMs ?? 1500);

    return () => {
      isMounted = false;
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [order.orderId, order.status]);

  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Clipboard copy failed:', err);
    }
  };

  const formatVnd = (amount: number) => {
    return new Intl.NumberFormat('vi-VN').format(amount) + 'đ';
  };

  const formatCountdown = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const handleRenew = async () => {
    setIsRenewing(true);
    try {
      await onRenewOrder(order.planCode);
    } finally {
      setIsRenewing(false);
    }
  };

  const isPaid = order.status === 'PAID';
  // a product order the server closed (for example the item was bought another way meanwhile)
  const isClosed = order.status === 'CANCELLED';
  const isExpired = !isClosed && (order.status === 'EXPIRED' || timeLeftSeconds <= 0);

  // Normalize plan label to guarantee single 'Gói' prefix
  const displayPlanName = product
    ? product.label
    : order.planName
    ? (order.planName.trim().startsWith('Gói') ? order.planName.trim() : `Gói ${order.planName.trim()}`)
    : 'Gói Premium';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto bg-white dark:bg-[#0c101d] border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl animate-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        data-testid="payment-checkout-modal"
      >
        {/* Header */}
        <div className="px-6 py-4.5 border-b border-slate-100 dark:border-slate-800/80 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900/40">
          <div className="flex items-center gap-3">
            <BrandWhaleIcon size="sm" priority />
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                {product ? product.heading : 'Thanh toán English Coach Premium'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Chuyển khoản VietQR tự động qua SePay
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            aria-label="Đóng cửa sổ thanh toán"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-6">
          {/* PAID SUCCESS SCREEN */}
          {isPaid && product ? (
            <div className="text-center py-8 space-y-5" data-testid="checkout-paid">
              <div className="w-16 h-16 mx-auto rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shadow-lg shadow-emerald-500/10">
                <CheckCircle2 className="w-9 h-9" />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-2xl font-black text-slate-900 dark:text-white">Thanh toán thành công!</h3>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  <strong className="text-indigo-600 dark:text-indigo-400">{displayPlanName}</strong> {product.successText}
                </p>
              </div>
              <div className="pt-4">
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm shadow-md cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-2 dark:focus:ring-offset-slate-900"
                >
                  <span>{product.successCta}</span>
                  <ArrowRight className="w-4 h-4 text-white/90 shrink-0" />
                </button>
              </div>
            </div>
          ) : isClosed ? (
            <div className="text-center py-8 space-y-4" data-testid="checkout-closed">
              <div className="w-16 h-16 mx-auto rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-300 flex items-center justify-center shadow-md">
                <AlertCircle className="w-9 h-9" />
              </div>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Đơn thanh toán đã đóng</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                Đơn này không còn nhận thanh toán. Vui lòng không chuyển khoản theo mã cũ.
                {order.notice ? ` ${order.notice}` : ''}
              </p>
              <button type="button" onClick={onClose} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-md transition cursor-pointer">
                Đóng
              </button>
            </div>
          ) : isPaid ? (
            <div className="text-center py-8 space-y-5">
              <div className="w-16 h-16 mx-auto rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shadow-lg shadow-emerald-500/10 animate-bounce">
                <CheckCircle2 className="w-9 h-9" />
              </div>

              <div className="space-y-1.5">
                <h3 className="text-2xl font-black text-slate-900 dark:text-white">
                  Thanh toán thành công!
                </h3>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  <strong className="text-indigo-600 dark:text-indigo-400">{displayPlanName}</strong> của bạn đã được kích hoạt.
                </p>
              </div>

              {order.premiumExpiresAt && (
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-500/20 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                  <span>Có hiệu lực đến:</span>
                  <strong>{new Date(order.premiumExpiresAt).toLocaleDateString('vi-VN')}</strong>
                </div>
              )}

              <div className="pt-4">
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl text-white font-bold text-sm shadow-md cursor-pointer premium-nav-btn focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-2 dark:focus:ring-offset-slate-900"
                >
                  <Crown className="w-4 h-4 text-amber-300 drop-shadow-xs shrink-0" />
                  <span>Bắt đầu học ngay với Premium</span>
                  <ArrowRight className="w-4 h-4 text-white/90 shrink-0" />
                </button>
              </div>
            </div>
          ) : isExpired ? (
            /* EXPIRED SCREEN */
            <div className="text-center py-8 space-y-5">
              <div className="w-16 h-16 mx-auto rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center shadow-md">
                <AlertCircle className="w-9 h-9" />
              </div>

              <div className="space-y-1.5">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white">
                  Đơn thanh toán đã hết hạn
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                  Mã QR và nội dung chuyển khoản trước đó không còn hiệu lực. Vui lòng tạo đơn mới để nhận mã thanh toán mới.
                </p>
                {order.notice && (
                  <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 max-w-sm mx-auto" data-testid="checkout-notice">
                    {order.notice}
                  </p>
                )}
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  disabled={isRenewing}
                  onClick={handleRenew}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-md shadow-indigo-600/20 transition cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRenewing ? 'animate-spin' : ''}`} />
                  <span>{isRenewing ? 'Đang tạo đơn...' : 'Tạo đơn mới'}</span>
                </button>
              </div>
            </div>
          ) : (
            /* ACTIVE CHECKOUT STATE */
            <div className="space-y-5">
              {/* Order Info & Timer Banner */}
              <div className="p-4 rounded-2xl bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="text-xs text-indigo-700 dark:text-indigo-300 font-semibold">
                    {displayPlanName}
                  </div>
                  <div className="text-xl sm:text-2xl font-black text-indigo-950 dark:text-indigo-100">
                    {formatVnd(order.amountVnd)}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {/* Countdown Badge */}
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white dark:bg-slate-800 border border-indigo-200/60 dark:border-indigo-800/60 text-xs font-bold text-indigo-600 dark:text-indigo-300 shadow-xs">
                    <Clock className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
                    <span>Còn {formatCountdown(timeLeftSeconds)}</span>
                  </div>

                  {/* Status Indicator */}
                  <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                    <span>Đang chờ thanh toán...</span>
                  </div>
                </div>
              </div>

              {/* QR and Transfer Details Split Grid */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-center">
                {/* VietQR Display (Left Column) */}
                <div className="md:col-span-5 flex flex-col items-center justify-center p-3.5 bg-slate-50 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 rounded-2xl">
                  {order.qrImageUrl ? (
                    <div className="relative w-full max-w-[220px] aspect-square rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-white shadow-xs">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={order.qrImageUrl}
                        alt="Dynamic VietQR Code"
                        className="w-full h-full object-contain"
                      />
                    </div>
                  ) : (
                    <div className="w-48 h-48 rounded-xl bg-slate-200 dark:bg-slate-800 flex flex-col items-center justify-center text-slate-400 text-xs p-4 text-center">
                      <QrCode className="w-10 h-10 mb-2 opacity-50" />
                      <span>Thông tin tài khoản đang cập nhật</span>
                    </div>
                  )}
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 text-center mt-2.5 font-medium">
                    Quét bằng ứng dụng ngân hàng bất kỳ
                  </p>
                </div>

                {/* Transfer Information List (Right Column) */}
                <div className="md:col-span-7 space-y-2.5">
                  {/* Bank */}
                  <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/70 dark:border-slate-800 flex items-center justify-between text-xs">
                    <div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                        Ngân hàng
                      </div>
                      <div className="font-bold text-slate-900 dark:text-white">
                        {order.bankCode || (product ? '—' : 'MB (Ngân hàng Quân Đội)')}
                      </div>
                    </div>
                  </div>

                  {/* Account Number */}
                  <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/70 dark:border-slate-800 flex items-center justify-between text-xs">
                    <div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                        Số tài khoản
                      </div>
                      <div className="font-mono font-bold text-slate-900 dark:text-white text-sm">
                        {order.accountNumber || (product ? '—' : '0987654321')}
                      </div>
                    </div>
                    {order.accountNumber && (
                      <button
                        type="button"
                        onClick={() => copyToClipboard(order.accountNumber!, 'account')}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition cursor-pointer"
                        title="Sao chép số tài khoản"
                      >
                        {copiedField === 'account' ? (
                          <Check className="w-4 h-4 text-emerald-500" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </button>
                    )}
                  </div>

                  {/* Account Name */}
                  <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/70 dark:border-slate-800 flex items-center justify-between text-xs">
                    <div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                        Chủ tài khoản
                      </div>
                      <div className="font-bold text-slate-900 dark:text-white uppercase">
                        {order.accountName || (product ? '—' : 'ENGLISH COACH')}
                      </div>
                    </div>
                  </div>

                  {/* Exact Amount */}
                  <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/70 dark:border-slate-800 flex items-center justify-between text-xs">
                    <div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 uppercase font-semibold">
                        Số tiền chính xác
                      </div>
                      <div className="font-bold text-indigo-600 dark:text-indigo-400 text-sm">
                        {formatVnd(order.amountVnd)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(String(order.amountVnd), 'amount')}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition cursor-pointer"
                      title="Sao chép số tiền"
                    >
                      {copiedField === 'amount' ? (
                        <Check className="w-4 h-4 text-emerald-500" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  </div>

                  {/* Transfer Code / Memo (High emphasis) */}
                  <div className="p-3 rounded-xl bg-gradient-to-r from-amber-500/10 via-indigo-500/10 to-transparent border-2 border-indigo-500/40 dark:border-indigo-500/30 flex items-center justify-between text-xs">
                    <div>
                      <div className="text-[10px] text-indigo-700 dark:text-indigo-300 uppercase font-extrabold flex items-center gap-1">
                        <span>Nội dung chuyển khoản (bắt buộc)</span>
                      </div>
                      <div className="font-mono font-black text-indigo-600 dark:text-indigo-400 text-base tracking-wider mt-0.5">
                        {order.transferCode}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(order.transferCode, 'memo')}
                      className="px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center gap-1 shadow-xs transition cursor-pointer"
                    >
                      {copiedField === 'memo' ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-white" />
                          <span>Đã chép</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Sao chép</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Crucial Instruction Notice */}
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800/80 text-[11px] text-slate-600 dark:text-slate-400 space-y-1">
                <div className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-indigo-500" />
                  <span>Hướng dẫn chuyển khoản:</span>
                </div>
                <p className="leading-relaxed">
                  Quét mã QR bằng ứng dụng ngân hàng và chuyển đúng số tiền với nội dung chuyển khoản hiển thị bên trên. {product ? product.instruction : 'Hệ thống sẽ tự động kích hoạt gói Premium ngay khi nhận được giao dịch.'}
                </p>
                {order.notice && (
                  <p className="font-semibold text-amber-700 dark:text-amber-300" data-testid="checkout-notice">{order.notice}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
