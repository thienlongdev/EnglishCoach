"use client";

import React from "react";
import { CloudRain, CloudSnow, Rainbow, Sun, X } from "lucide-react";
import type { GardenState, GardenWeather } from "@/types/garden";
import { Chip, EASE, FOCUS_RING, GardenSheet } from "./gardenUi";
import {
  SEASON_LABEL, SEASON_OF_THEME, THEME_LABEL, clockTime, formatDuration, seasonTitle, weatherEffect, weatherLabel,
} from "./gardenModel";

function CloseButton({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button type="button" onClick={onClose} aria-label={label}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,color,transform] duration-200 ${EASE} hover:bg-white/20 hover:text-white active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}>
      <X className="h-4 w-4" />
    </button>
  );
}

export function WeatherIcon({ w, className = "h-4 w-4" }: { w: Pick<GardenWeather, "kind" | "theme">; className?: string }) {
  if (w.kind === "RAINBOW") return <Rainbow className={className} aria-hidden />;
  if (w.kind === "RAIN") return w.theme === "THANH_NGU" ? <CloudSnow className={className} aria-hidden /> : <CloudRain className={className} aria-hidden />;
  return <Sun className={className} aria-hidden />;
}

/** Season (theme week) + weather forecast: what each means for the farm right now. */
export function SeasonPanel({ state, serverNowMs, onClose }: { state: GardenState; serverNowMs: number; onClose: () => void }) {
  const w = state.world;
  const left = Math.max(0, (Date.parse(w.themeEndsAt) - serverNowMs) / 1000);
  const inSeason = state.crops.filter((c) => c.season === w.theme);
  const nextSeason = state.crops.filter((c) => c.season === w.nextTheme);
  return (
    <GardenSheet labelledBy="garden-season-title" onClose={onClose} testId="garden-season-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold text-[#FFD978]/90">Mùa trên đảo</p>
          <h2 id="garden-season-title" className="mt-0.5 text-lg font-black text-[#EEF3FF]">{seasonTitle(w.theme)}</h2>
        </div>
        <CloseButton onClose={onClose} label="Đóng bảng mùa và thời tiết" />
      </div>
      <p className="mt-2 text-[13px] text-[#EEF3FF]/80">
        Còn {formatDuration(left)} đến {SEASON_LABEL[SEASON_OF_THEME[w.nextTheme]]} · {THEME_LABEL[w.nextTheme]}.
        Cây đúng mùa lớn nhanh ×1,25 và đạt chất lượng cao hơn; cây trái mùa lớn chậm ×0,7; cây thường lớn đều quanh năm.
      </p>
      <div className="mt-3 rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 p-3">
        <p className="text-[12px] font-bold text-[#EEF3FF]">Hợp mùa này</p>
        <p className="mt-0.5 text-[12px] text-[#EEF3FF]/70">{inSeason.length ? inSeason.map((c) => `${c.nameVi}${c.unlocked ? "" : ` (Cấp ${c.unlockLevel})`}`).join(", ") : "Mùa này dành cho cây thường."}</p>
        {nextSeason.length > 0 && (
          <p className="mt-1 text-[11px] text-[#EEF3FF]/55">Mùa sau hợp: {nextSeason.map((c) => c.nameVi).join(", ")}. Cây gieo trong mùa vẫn tính đúng mùa khi chín sang tuần mới.</p>
        )}
      </div>
      <p className="mt-3 text-[12px] font-bold text-[#EEF3FF]">Dự báo 12 giờ tới</p>
      <ul className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4" data-testid="garden-forecast">
        {w.forecast.map((f, i) => (
          <li key={f.startsAt} className={`rounded-[14px] border px-2 py-2 text-center ${i === 0 ? "border-[#FFE2A0]/40 bg-[#FFE2A0]/10" : "border-white/10 bg-black/20"}`}>
            <p className="text-[10px] text-[#EEF3FF]/55">{i === 0 ? "Bây giờ" : clockTime(Date.parse(f.startsAt))}</p>
            <p className="mt-1 flex items-center justify-center gap-1 text-[12px] font-bold text-[#EEF3FF]"><WeatherIcon w={f} />{weatherLabel(f)}</p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-[#EEF3FF]/75">{weatherEffect(w.weather, w.rainbowMutation)}.</p>
      <p className="mt-1 text-[11px] leading-relaxed text-[#EEF3FF]/55">
        Mưa (mùa Đông là tuyết) giúp mọi cây đang lớn nhanh hơn {Math.round((w.forecast.find((f) => f.kind === "RAIN")?.growthFactor ?? 1.2) * 100 - 100)}%, nhưng không thay cho việc tưới.
        Cầu vồng chỉ xuất hiện ngay sau mưa và không báo trước; thu hoạch lúc có cầu vồng dễ ra dạng đột biến.
      </p>
    </GardenSheet>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  DICTATION: "Chép chính tả (một lượt nghe hoàn tất)",
  SHADOWING: "Luyện nói Shadowing (≥ 3 câu được chấm)",
  WRITING: "Phòng viết (bài được chấm xong)",
  EXAM: "Thi thử / luyện đề (bài đã nộp)",
  CARD_BLAST: "Card Blast (lượt chơi đạt điểm)",
  WORD_CHAIN: "Nối từ (ván có từ hợp lệ)",
  READING: "Đọc",
  ROLEPLAY: "Hội thoại Role-play",
  LISTENING_WATCH: "Xem / nghe video",
  CARD_BLAST_PVP: "Card Blast đấu 1v1",
};

/** What the learning modules give the garden today (only modules that store a verifiable completion count). */
export function LearningPanel({ state, onClose, onStudy }: { state: GardenState; onClose: () => void; onStudy: () => void }) {
  const l = state.learning;
  const g = state.today.goal;
  return (
    <GardenSheet labelledBy="garden-learning-title" onClose={onClose} testId="garden-learning-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold text-[#a6e6b3]">Học để vườn lớn</p>
          <h2 id="garden-learning-title" className="mt-0.5 text-lg font-black text-[#EEF3FF]">Hôm nay</h2>
        </div>
        <CloseButton onClose={onClose} label="Đóng bảng học tập" />
      </div>
      <ul className="mt-3 flex flex-col gap-1.5 text-[12px] text-[#EEF3FF]/80">
        <li className="flex items-center justify-between rounded-[12px] border border-white/10 bg-black/20 px-2.5 py-2">
          <span>Ôn thẻ: mỗi 5 thẻ = 1 nước, 2 XP/thẻ</span><b className="tabular-nums">{Math.floor(g.effectiveUnits)} thẻ</b>
        </li>
        <li className="flex items-center justify-between rounded-[12px] border border-white/10 bg-black/20 px-2.5 py-2">
          <span>Bài kỹ năng: +{l.skillXp} XP, {l.fertilizerFirst} bài đầu tặng phân bón</span><b className="tabular-nums">{l.skillsToday}/{l.skillCap}</b>
        </li>
        <li className="flex items-center justify-between rounded-[12px] border border-white/10 bg-black/20 px-2.5 py-2">
          <span>Trò chơi từ vựng: +{l.gameXp} XP</span><b className="tabular-nums">{l.gamesToday}/{l.gameCap}</b>
        </li>
        <li className="flex items-center justify-between rounded-[12px] border border-white/10 bg-black/20 px-2.5 py-2">
          <span>Xua Sâu Lãng Quên: +5 XP</span><b className="tabular-nums">{l.pestCuresToday}/{l.pestCureCap}</b>
        </li>
      </ul>
      <p className="mt-3 text-[12px] text-[#EEF3FF]/80">
        Mục tiêu ngày (Phúc Lành Echo, giá bán ×{String(state.today.blessingMultiplier).replace(".", ",")}): {g.targetUnits} thẻ,
        hoặc {g.mixUnits} thẻ + {g.mixSkills} bài kỹ năng, hoặc ôn hết thẻ đến hạn. {g.done ? "Đã đạt hôm nay." : ""}
      </p>
      <p className="mt-2 text-[12px] text-[#EEF3FF]/65">
        XP thu hoạch trong ngày giảm dần sau {l.harvestFullUntil} XP đầu (hôm nay: {Math.floor(l.harvestXpRawToday)}), Đồng Echo bán nông sản không đổi.
      </p>
      <p className="mt-3 text-[12px] font-bold text-[#EEF3FF]">Nguồn học được tính</p>
      <ul className="mt-1 flex flex-col gap-1" data-testid="garden-learning-sources">
        {l.sources.map((s) => (
          <li key={s.code} className="flex items-center justify-between gap-2 text-[12px] text-[#EEF3FF]/75">
            <span>{SOURCE_LABEL[s.code] ?? s.code}</span>
            {s.enabled ? <Chip tone="good">{s.category === "SKILL" ? "Bài kỹ năng" : "Trò chơi"}</Chip> : <Chip>Chưa tính</Chip>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-[#EEF3FF]/50">“Chưa tính”: mô-đun đó chưa lưu kết quả hoàn thành có thể kiểm chứng, nên khu vườn không tự đoán.</p>
      <button type="button" onClick={onStudy} className={`mt-3 w-full rounded-[16px_13px_16px_14px] border border-[#74C98B]/30 bg-[#74C98B]/15 py-2.5 text-[13px] font-bold text-[#a6e6b3] hover:bg-[#74C98B]/25 ${FOCUS_RING} cursor-pointer`}>
        Đi ôn thẻ
      </button>
    </GardenSheet>
  );
}
