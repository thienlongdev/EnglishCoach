"use client";

import React from "react";
import {
  X,
  Target,
  Zap,
  Shield,
  Flame,
  Layers,
  Skull,
  HelpCircle,
} from "lucide-react";

interface PvPRulesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PvPRulesModal({ isOpen, onClose }: PvPRulesModalProps) {
  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pvp-rules-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-gradient-to-b from-slate-900 via-slate-900/95 to-slate-950 border border-slate-700/80 rounded-3xl p-5 sm:p-6 shadow-2xl relative overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <HelpCircle className="w-4 h-4" />
            </div>
            <div>
              <h3 id="pvp-rules-title" className="font-bold text-base sm:text-lg text-slate-100">
                Luật Thi Đấu và Cơ Chế PvP
              </h3>
              <p className="text-[11px] text-slate-400">Đấu trường Card Blast 1v1</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition cursor-pointer"
            aria-label="Đóng"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Rules Grid / List */}
        <div className="mt-4 space-y-3 max-h-[70vh] overflow-y-auto pr-1 text-xs sm:text-sm text-slate-300">
          {/* Rule 1: Cơ chế */}
          <div className="p-3 rounded-2xl bg-slate-950/60 border border-slate-800/80 flex items-start gap-3">
            <div className="p-2 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 shrink-0 mt-0.5">
              <Target className="w-4 h-4" />
            </div>
            <div>
              <span className="font-bold text-emerald-300">🎯 Cơ chế:</span>
              <p className="mt-0.5 text-slate-300 text-xs leading-relaxed">
                Gõ đúng từ tiếng Anh trước khi chạm vạch đỏ dưới đáy màn hình. Mỗi từ chạm đáy sẽ gây sát thương trừ máu (HP).
              </p>
            </div>
          </div>

          {/* Rule 2: Đòn phạt */}
          <div className="p-3 rounded-2xl bg-slate-950/60 border border-slate-800/80 flex items-start gap-3">
            <div className="p-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 shrink-0 mt-0.5">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <span className="font-bold text-amber-300">⚡ Đòn phạt:</span>
              <p className="mt-0.5 text-slate-300 text-xs leading-relaxed">
                Đạt chuỗi 3 từ đúng liên tiếp (Streak 3) sẽ tự động bắn 1 từ khó (từ phạt) sang làn rơi của đối thủ.
              </p>
            </div>
          </div>

          {/* Rule 3: Đỡ đòn */}
          <div className="p-3 rounded-2xl bg-slate-950/60 border border-slate-800/80 flex items-start gap-3">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400 shrink-0 mt-0.5">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <span className="font-bold text-cyan-300">🛡️ Đỡ đòn (Parry):</span>
              <p className="mt-0.5 text-slate-300 text-xs leading-relaxed">
                Gõ đúng 1 từ trong 2s cảnh báo để hóa giải đòn phạt, ngăn chặn từ phạt xuất hiện trên màn hình.
              </p>
            </div>
          </div>

          {/* Rule 4: Từ Vàng */}
          <div className="p-3 rounded-2xl bg-slate-950/60 border border-slate-800/80 flex items-start gap-3">
            <div className="p-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 shrink-0 mt-0.5">
              <Flame className="w-4 h-4" />
            </div>
            <div>
              <span className="font-bold text-amber-300">⚡ Từ Vàng:</span>
              <p className="mt-0.5 text-slate-300 text-xs leading-relaxed">
                Xuất hiện mỗi 18s. Người gõ trước nhận +3x điểm và kích hoạt đòn phản công tức thì sang đối thủ.
              </p>
            </div>
          </div>

          {/* Rule 5: Kỹ năng */}
          <div className="p-3 rounded-2xl bg-slate-950/60 border border-slate-800/80 flex items-start gap-3">
            <div className="p-2 rounded-xl bg-purple-500/15 border border-purple-500/30 text-purple-400 shrink-0 mt-0.5">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <span className="font-bold text-purple-300">🔮 5 Kỹ năng Chiến thuật:</span>
              <p className="mt-0.5 text-slate-300 text-xs leading-relaxed">
                Tích Mana qua từng từ gõ đúng để kích hoạt (phím 1, 2, 3): Kích nổ (Echo Chain), Làm chậm (Slow-Mo), Xung kích (EMP Blast), Mù Sương (Fog), Khiên Chắn (Shield).
              </p>
            </div>
          </div>

          {/* Rule 6: Sudden Death */}
          <div className="p-3 rounded-2xl bg-slate-950/60 border border-slate-800/80 flex items-start gap-3">
            <div className="p-2 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-400 shrink-0 mt-0.5">
              <Skull className="w-4 h-4" />
            </div>
            <div>
              <span className="font-bold text-rose-300">☠️ Sudden Death:</span>
              <p className="mt-0.5 text-slate-300 text-xs leading-relaxed">
                Sau 3 phút thi đấu, sát thương chạm vạch đỏ sẽ nhân đôi (2x), gia tăng nhịp độ và quyết định thắng bại nhanh chóng.
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-4 pt-3 border-t border-slate-800 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs transition cursor-pointer shadow-md shadow-indigo-600/30 active:scale-95"
          >
            Đã hiểu, sẵn sàng!
          </button>
        </div>
      </div>
    </div>
  );
}
