"use client";

import React, { useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import { ActionButton, EASE, FOCUS_RING, GardenSheet } from "../gardenUi";
import { readRevealPref, writeRevealPref } from "../entryReveal";
import { STARTER_ID, STARTER_STEPS, TOPICS } from "./guideScripts";
import type { GardenGuideApi } from "./useGardenGuide";

/**
 * "Hướng dẫn": the permanent way into Echo's guides. Opening it starts nothing: the player picks the starter guide
 * (start, continue where they left, or again) or one short topic about a system that already exists. The one display
 * preference of the game entry lives here too.
 */
export function HelpPanel({ guide, onClose }: { guide: GardenGuideApi; onClose: () => void }) {
  const [reveal, setReveal] = useState(() => readRevealPref());
  const record = guide.record;
  const unfinished = !!record && (record.status === "STARTED" || record.status === "EXITED") && record.step > 0 && record.step < STARTER_STEPS;
  const completed = record?.status === "COMPLETED";
  const begin = (topicId: string, mode: "resume" | "restart") => {
    onClose();
    guide.start(topicId, mode);
  };
  return (
    <GardenSheet labelledBy="garden-help-title" onClose={onClose} testId="garden-help-panel" wide>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandWhaleIcon variant="clean" size="md" className="h-10 w-10 shrink-0" />
          <div className="min-w-0">
            <h2 id="garden-help-title" className="text-lg font-black leading-tight text-[#EEF3FF]">Hướng dẫn</h2>
            <p className="text-[11px] text-[#EEF3FF]/60">Echo chỉ cho bạn từng mục ngay trên đảo.</p>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Đóng hướng dẫn"
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,transform] duration-200 ${EASE} hover:bg-white/20 active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 rounded-[18px_15px_18px_16px] border border-[#F4C35A]/25 bg-[#F4C35A]/[0.07] p-3" data-testid="garden-help-starter">
        <p className="text-sm font-bold text-[#EEF3FF]">Bắt đầu chơi</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[#EEF3FF]/70">
          {completed ? "Bạn đã đi hết một vòng cùng Echo. Bạn có thể xem lại bất cứ lúc nào."
            : unfinished ? `Bạn đang ở bước ${Math.min(record!.step + 1, STARTER_STEPS)}/${STARTER_STEPS}.`
              : "Một vòng quanh đảo: ô đất, gieo hạt, tưới nước, ôn từ, Kho. Khoảng 2 phút, dừng lúc nào cũng được."}
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {unfinished ? (
            <>
              <ActionButton tone="reward" className="min-h-[40px] px-3.5 text-xs" onClick={() => begin(STARTER_ID, "resume")} testId="garden-help-resume">Tiếp tục hướng dẫn</ActionButton>
              <ActionButton tone="quiet" className="min-h-[40px] px-3 text-xs" onClick={() => begin(STARTER_ID, "restart")} testId="garden-help-restart">Bắt đầu lại</ActionButton>
            </>
          ) : (
            <ActionButton tone="reward" className="min-h-[40px] px-3.5 text-xs" onClick={() => begin(STARTER_ID, "restart")} testId="garden-help-start">
              {completed ? "Hướng dẫn lại" : "Bắt đầu hướng dẫn"}
            </ActionButton>
          )}
        </div>
      </div>

      <p className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-[#FFD978]/90">Chủ đề</p>
      <ul className="mt-2 flex flex-col gap-1.5" data-testid="garden-help-topics">
        {TOPICS.filter((t) => t.id !== STARTER_ID).map((t, i) => (
          <li key={t.id}>
            <button type="button" onClick={() => begin(t.id, "restart")} data-testid={`garden-help-topic-${t.id}`}
              className={`flex min-h-[48px] w-full items-center gap-2.5 rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 px-3 py-2 text-left transition-[background-color,transform] duration-200 ${EASE} hover:bg-white/[0.08] active:scale-[0.99] ${FOCUS_RING} cursor-pointer`}>
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-black tabular-nums text-[#EEF3FF]/80">{i + 2}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-bold text-[#EEF3FF]">{t.title}</span>
                <span className="block text-[11px] text-[#EEF3FF]/55">{t.hint}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-[#EEF3FF]/45" aria-hidden />
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/10 pt-3">
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-[#EEF3FF]" id="garden-reveal-label">Hiệu ứng mở đảo</p>
          <p className="text-[11px] text-[#EEF3FF]/55">Mây tách ra mỗi khi bạn vào đảo. Lưu trên thiết bị này.</p>
        </div>
        <button type="button" role="switch" aria-checked={reveal} aria-labelledby="garden-reveal-label" data-testid="garden-reveal-toggle"
          onClick={() => {
            writeRevealPref(!reveal);
            setReveal(!reveal);
          }}
          className={`relative h-8 w-[60px] shrink-0 rounded-full border transition-colors duration-200 ${EASE} ${FOCUS_RING} cursor-pointer ${reveal ? "border-[#74C98B]/50 bg-[#74C98B]/30" : "border-white/15 bg-white/[0.06]"}`}>
          <span className={`absolute top-1 h-[22px] w-[22px] rounded-full bg-[#EEF3FF] shadow transition-[left] duration-200 ${EASE} motion-reduce:transition-none ${reveal ? "left-[33px]" : "left-1"}`} />
          <span className="sr-only">{reveal ? "Bật" : "Tắt"}</span>
        </button>
      </div>
      <p className="mt-1 text-right text-[11px] font-semibold text-[#EEF3FF]/60" aria-hidden>{reveal ? "Bật" : "Tắt"}</p>
    </GardenSheet>
  );
}
