"use client";

import React, { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { EchoGardenGame } from "./useEchoGarden";
import { ActionButton, Chip } from "./gardenUi";
import { formatNumber } from "./gardenModel";

/**
 * Phase 4 — the official administrator's QA access, shown ONLY when the server said this account is the administrator
 * (`game.adminQa`; every other account has null and renders nothing). The bars only name an action: the server checks
 * the administrator again on every call, acts on the administrator's own garden and answers with the new picture.
 * Nothing here is a purchase: no Đồng Echo moves, no payment order exists, no learning fact is written. After "mở thử",
 * the ordinary shop / farm controls (preview, equip, place, restore, feed, water, collect) are used as they are.
 */

const BAR = "mt-3 rounded-[16px_13px_16px_14px] border border-[#8fd3ff]/35 bg-[#8fd3ff]/[0.08] p-3";

function Title({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-black text-[#cfeaff]">
      <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
      {children}
      <Chip tone="info">Chỉ quản trị viên</Chip>
    </p>
  );
}

/** "Admin QA — Tất cả Skin": one switch for the whole cosmetic catalogue (115 products), at the top of the shop. */
export function AdminQaCosmeticsBar({ game }: { game: EchoGardenGame }) {
  const [confirmOff, setConfirmOff] = useState(false);
  const qa = game.adminQa;
  if (!qa) return null;
  const on = qa.qaUnits > 0 || qa.qaSkins > 0;
  const busy = game.busy !== null;
  return (
    <section className={BAR} aria-label="Admin QA cho Tiệm Trang Trí" data-testid="garden-admin-qa-cosmetics">
      <Title>Admin QA — Tất cả Skin</Title>
      <p className="mt-1 text-[11.5px] leading-snug text-[#EEF3FF]/75" data-testid="garden-admin-qa-cosmetics-status">
        {on
          ? `Đang mở thử ${formatNumber(qa.qaUnits)} món trang trí và ${formatNumber(qa.qaSkins)} giống cây bằng quyền quản trị. Đây không phải hàng đã mua: không trừ Đồng Echo, không có đơn thanh toán, không ghi thành tích.`
          : "Mở toàn bộ danh mục để xem thử, mặc, đặt và cất như món đã có. Không trừ Đồng Echo, không tạo đơn thanh toán, không ghi thành tích; người chơi thường vẫn phải mua hoặc đạt điều kiện như cũ."}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <ActionButton tone="care" disabled={busy} onClick={() => void game.qaCosmetics(true)} testId="garden-admin-qa-unlock"
          className="min-h-[40px] px-3 py-1.5 text-[12px]">
          {on ? "Mở thêm món mới trong danh mục" : "Mở toàn bộ để thử"}
        </ActionButton>
        {on && (
          <ActionButton tone="quiet" disabled={busy} testId="garden-admin-qa-revoke" className="min-h-[40px] px-3 py-1.5 text-[12px]"
            onClick={() => {
              if (!confirmOff) return setConfirmOff(true);
              setConfirmOff(false);
              void game.qaCosmetics(false);
            }}>
            {confirmOff ? "Bấm lần nữa để tắt Admin QA" : "Tắt Admin QA"}
          </ActionButton>
        )}
      </div>
      {on && (
        <p className="mt-1.5 text-[11px] leading-snug text-[#EEF3FF]/55">
          Tắt Admin QA sẽ thu lại đúng những món mở thử (đang mặc thì trở về mặc định, đồ đang đặt được cất đi); món bạn đã mua hoặc đạt được
          vẫn giữ nguyên. Muốn mua thật một món, hãy tắt Admin QA trước.
        </p>
      )}
    </section>
  );
}

/** "Admin QA — Chuồng trại": houses, livestock and guardians without level or coins, and a care-time control. */
export function AdminQaAnimalsBar({ game }: { game: EchoGardenGame }) {
  const qa = game.adminQa;
  if (!qa) return null;
  const busy = game.busy !== null;
  const animals = game.state?.animals;
  const complete = !!animals && animals.houses.every((h) => h.built && h.animals.length >= h.capacity) && animals.guardians.every((g) => g.owned);
  const spans = [6, 24, 72].filter((h) => h <= qa.maxAdvanceHours);
  return (
    <section className={BAR} aria-label="Admin QA cho Chuồng trại" data-testid="garden-admin-qa-animals">
      <Title>Admin QA — Chuồng trại</Title>
      <p className="mt-1 text-[11.5px] leading-snug text-[#EEF3FF]/75">
        Dựng đủ bốn chuồng, đưa gà, vịt, lợn, cừu vào các chỗ còn trống và nhận nuôi chó, ngỗng, mèo, kèm cám và nước để thử. Không cần
        cấp độ, không trừ Đồng Echo. Vật nuôi mở thử là vật nuôi thật trên đảo của bạn và không bao giờ bị xoá.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <ActionButton tone="care" disabled={busy || complete} onClick={() => void game.qaAnimals(null)} testId="garden-admin-qa-provision"
          className="min-h-[40px] px-3 py-1.5 text-[12px]">
          {complete ? "Đã đủ chuồng và vật nuôi" : "Dựng đủ chuồng và vật nuôi"}
        </ActionButton>
        {spans.map((h) => (
          <ActionButton key={h} tone="quiet" disabled={busy || !animals?.livestock} onClick={() => void game.qaAnimals(h)}
            testId={`garden-admin-qa-advance-${h}`} className="min-h-[40px] px-3 py-1.5 text-[12px]" ariaLabel={`Chăm thêm ${h} giờ cho vật nuôi của tôi`}>
            +{h} giờ chăm sóc
          </ActionButton>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-[#EEF3FF]/55">
        “+ giờ chăm sóc” tính cho vật nuôi của riêng bạn đúng như được cho ăn uống đủ trong ngần ấy giờ (lớn lên trước, rồi cho sản phẩm,
        không vượt sức chứa). Đồng hồ máy chủ và đảo của người khác không đổi.
      </p>
    </section>
  );
}
