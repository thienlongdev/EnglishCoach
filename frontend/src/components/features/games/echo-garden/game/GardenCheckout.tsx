"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { GardenCosmeticOrder } from "@/types/garden";
import type { PaymentOrderResponse } from "@/services/paymentApi";
import { gardenApi } from "@/services/gardenApi";
import { PaymentCheckoutModal, type CheckoutProduct } from "@/components/features/premium/PaymentCheckoutModal";
import type { EchoGardenGame } from "./useEchoGarden";
import { ActionButton, Chip } from "./gardenUi";
import { formatNumber } from "./gardenModel";

/**
 * Echo Garden Phase 3F — a cosmetic paid by bank transfer. This file adds NO payment UI of its own: it hands a garden
 * order to the existing Premium SePay sheet (`PaymentCheckoutModal`) and only tells it what the product is called and
 * where its order is polled. The QR, the receiving account, the amount and the transfer content are all values the
 * server returned from the payment module's configuration — nothing here knows a bank number.
 *
 * Paying is never decided on this screen: the sheet shows "paid" only when the server reports the order FULFILLED, i.e.
 * after the payment module verified the transfer and the garden delivered the item.
 */

const REVIEW_TEXT: Record<string, string> = {
  LATE_PAYMENT: "Đã nhận chuyển khoản sau khi mã hết hạn. Quản trị viên sẽ đối soát để giao hàng hoặc hoàn tiền cho bạn.",
  AMOUNT_MISMATCH: "Đã nhận một chuyển khoản không đúng số tiền; khoản đó sẽ được hoàn lại. Hãy chuyển đúng số tiền để nhận hàng.",
  ALREADY_OWNED: "Bạn đã có món này nên đơn được đóng. Khoản đã chuyển sẽ được hoàn lại.",
  ORDER_CLOSED: "Đơn đã đóng trước khi nhận chuyển khoản. Khoản đã chuyển sẽ được hoàn lại.",
  DUPLICATE_PAYMENT: "Đơn này nhận thêm một chuyển khoản trùng; khoản trùng sẽ được hoàn lại.",
  UNAVAILABLE: "Món này tạm thời chưa giao được. Quản trị viên sẽ xử lý khoản đã chuyển.",
};

/**
 * `skewMs` = this device's clock minus the server's. The sheet counts down against the device clock, so the deadline is
 * shifted by the skew: a wrong device clock can neither shorten nor extend what the buyer sees. The server alone decides
 * whether a transfer was in time.
 */
export function toPaymentOrder(o: GardenCosmeticOrder, skewMs = 0): PaymentOrderResponse {
  return {
    orderId: o.orderId,
    status: o.status === "FULFILLED" ? "PAID" : o.status === "REFUNDED" ? "CANCELLED" : o.status,
    planCode: `${o.kind}:${o.code}`,
    planName: o.productName,
    durationMonths: 0,
    amountVnd: o.amountVnd,
    currency: o.currency,
    transferCode: o.transferCode,
    bankCode: o.bankCode ?? undefined,
    accountNumber: o.accountNumber ?? undefined,
    accountName: o.accountName ?? undefined,
    expiresAt: new Date(Date.parse(o.expiresAt) + skewMs).toISOString(),
    qrImageUrl: o.qrImageUrl ?? undefined,
    createdAt: o.createdAt,
    paidAt: o.paidAt ?? undefined,
    notice: o.review ? REVIEW_TEXT[o.review] ?? "Khoản chuyển của bạn đang được đối soát." : "",
  };
}

/** The Premium payment sheet, showing one Echo Garden cosmetic order. */
export function GardenCheckout({ order: initial, game, onClose }: { order: GardenCosmeticOrder; game: EchoGardenGame; onClose: () => void }) {
  const [order, setOrder] = useState<GardenCosmeticOrder>(initial);
  const { startCheckout, refreshAfterPayment, serverNow } = game;
  const [skewMs] = useState(() => Date.now() - serverNow());
  const product: CheckoutProduct = useMemo(() => ({
    heading: "Thanh toán Skin Echo Garden",
    label: order.productName,
    fetchOrder: async (orderId: number) => toPaymentOrder(await gardenApi.cosmeticOrder(orderId), skewMs),
    successText: "đã có trong Tiệm Trang Trí của bạn.",
    successCta: "Về Tiệm Trang Trí",
    instruction: "Món trang trí được giao tự động ngay khi hệ thống xác nhận giao dịch; quét mã thôi chưa phải là đã thanh toán.",
    pollMs: 3000,
  }), [order.productName, skewMs]);
  // one stable object per server order: the sheet keeps what its own polling learned while the garden re-renders around it
  const sheetOrder = useMemo(() => toPaymentOrder(order, skewMs), [order, skewMs]);
  const renew = useCallback(async () => {
    const next = await startCheckout(order.kind, order.code);
    if (next) setOrder(next);
  }, [startCheckout, order.kind, order.code]);
  const close = useCallback(() => {
    void refreshAfterPayment();
    onClose();
  }, [refreshAfterPayment, onClose]);
  return (
    <div className="pointer-events-auto fixed inset-0 z-[300]" data-testid="garden-checkout">
      <PaymentCheckoutModal order={sheetOrder} product={product} onClose={close}
        onSuccess={() => void refreshAfterPayment()} onRenewOrder={renew} />
    </div>
  );
}

const ORDER_STATUS: Record<GardenCosmeticOrder["status"], { label: string; tone: "good" | "warn" | "info" | "quiet" }> = {
  PENDING: { label: "Chờ chuyển khoản", tone: "info" },
  FULFILLED: { label: "Đã thanh toán · đã giao", tone: "good" },
  EXPIRED: { label: "Hết hạn", tone: "quiet" },
  CANCELLED: { label: "Đã đóng", tone: "quiet" },
  REFUNDED: { label: "Đã hoàn tiền", tone: "warn" },
};

const REFUND_STATUS: Record<string, string> = { REQUESTED: "Đang chờ hoàn tiền", COMPLETED: "Đã hoàn tiền", REJECTED: "Yêu cầu hoàn tiền bị từ chối" };

const dateTime = (iso: string | null) => (iso
  ? new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) : "");

/** The player's own bank-transfer orders: continue an open one, or ask for a refund of a paid, unused item. */
export function GardenOrderList({ game, onPay, version }: { game: EchoGardenGame; onPay: (o: GardenCosmeticOrder) => void; version: number }) {
  const [orders, setOrders] = useState<GardenCosmeticOrder[] | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const { requestCosmeticRefund } = game;
  const load = useCallback(async () => {
    try {
      setOrders((await gardenApi.cosmeticOrders()).orders);
    } catch {
      setOrders([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, version]);
  if (!orders || orders.length === 0) return null;
  return (
    <section className="mt-3 rounded-[18px_15px_18px_16px] border border-white/10 bg-black/20 p-2.5" aria-label="Đơn chuyển khoản của bạn" data-testid="garden-vnd-orders">
      <h3 className="text-[12px] font-black text-[#EEF3FF]">Đơn chuyển khoản của bạn</h3>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {orders.map((o) => (
          <li key={o.orderId} className="rounded-[12px] bg-white/[0.04] px-2.5 py-2 text-[11px] text-[#EEF3FF]/80" data-testid={`garden-vnd-order-${o.orderId}`}>
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <span className="font-bold text-[#EEF3FF]">{o.productName} · {formatNumber(o.amountVnd)}đ</span>
              <Chip tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Chip>
            </div>
            <p className="mt-0.5 text-[#EEF3FF]/60">
              Mã {o.transferCode} · {dateTime(o.createdAt)}
              {o.review && ` · ${REVIEW_TEXT[o.review] ?? "Đang đối soát"}`}
              {o.refundStatus && ` · ${REFUND_STATUS[o.refundStatus]}`}
            </p>
            <div className="mt-1 flex flex-wrap justify-end gap-2">
              {o.status === "PENDING" && <ActionButton tone="reward" onClick={() => onPay(o)} testId={`garden-vnd-continue-${o.orderId}`}>Tiếp tục thanh toán</ActionButton>}
              {o.refundable && asking !== o.orderId && (
                <ActionButton tone="quiet" onClick={() => { setAsking(o.orderId); setReason(""); }} testId={`garden-vnd-refund-${o.orderId}`}>
                  Yêu cầu hoàn tiền (đến {dateTime(o.refundDeadline)})
                </ActionButton>
              )}
            </div>
            {asking === o.orderId && (
              <div className="mt-1.5 flex flex-col gap-1.5" role="group" aria-label="Lý do hoàn tiền">
                <label className="text-[11px] text-[#EEF3FF]/70" htmlFor={`refund-reason-${o.orderId}`}>Lý do (tối thiểu 5 ký tự). Món chưa dùng sẽ được thu lại sau khi hoàn tiền.</label>
                <input id={`refund-reason-${o.orderId}`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)}
                  className="min-h-[44px] rounded-[12px] border border-white/15 bg-black/30 px-3 text-[13px] text-[#EEF3FF] outline-none focus:border-[#FFD978]/60" />
                <div className="flex justify-end gap-2">
                  <ActionButton tone="quiet" onClick={() => setAsking(null)}>Thôi</ActionButton>
                  <ActionButton tone="care" disabled={reason.trim().length < 5 || game.busy !== null} testId={`garden-vnd-refund-send-${o.orderId}`}
                    onClick={() => void requestCosmeticRefund(o.orderId, reason.trim()).then((r) => { if (r) { setAsking(null); void load(); } })}>
                    Gửi yêu cầu
                  </ActionButton>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[10px] leading-relaxed text-[#EEF3FF]/50">
        Hoàn tiền: trong 7 ngày kể từ khi thanh toán, với món chưa từng dùng, đặt hay gieo. Tiền được chuyển khoản lại thủ công bởi quản trị viên.
      </p>
    </section>
  );
}
