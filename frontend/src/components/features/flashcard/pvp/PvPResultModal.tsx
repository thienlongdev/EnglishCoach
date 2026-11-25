"use client";

import React, { useState, useEffect } from "react";
import {
  Trophy,
  Flame,
  Target,
  Shield,
  RotateCcw,
  LogOut,
  Clock,
  BookOpen,
  Zap,
  TrendingUp,
  TrendingDown,
  ChevronDown,
  ChevronUp,
  Award,
  AlertCircle
} from "lucide-react";
import { MatchResultData, MissedWordDetail } from "./useCardBlastPvP";

interface PvPResultModalProps {
  result: MatchResultData | null;
  currentUserId: string;
  isHost: boolean;
  rematchRequested: boolean;
  onRematch: () => void;
  onExit: () => void;
}

export function PvPResultModal({
  result,
  currentUserId,
  isHost,
  rematchRequested,
  onRematch,
  onExit,
}: PvPResultModalProps) {
  const [activeTab, setActiveTab] = useState<"summary" | "report">("summary");
  const [showWeakWords, setShowWeakWords] = useState<boolean>(false);
  const [fetchedMissedWords, setFetchedMissedWords] = useState<MissedWordDetail[] | null>(null);
  const [loadingMissed, setLoadingMissed] = useState<boolean>(false);

  if (!result) return null;

  const isWinner = result.winnerId != null && String(result.winnerId) === String(currentUserId);
  const isDraw = result.winnerId === "DRAW";
  const isForfeit = result.reason === "FORFEIT";

  let titleIcon = "🤝";
  let titleText = "HOÀ!";
  let titleColor = "text-amber-400";
  let bgGlow = "from-amber-500/20 via-slate-900 to-slate-950";

  if (isForfeit && !isWinner) {
    titleIcon = "🚪";
    titleText = "Trận đấu kết thúc";
    titleColor = "text-slate-400";
    bgGlow = "from-slate-700/20 via-slate-900 to-slate-950";
  } else if (isWinner) {
    titleIcon = "🏆";
    titleText = "CHIẾN THẮNG!";
    titleColor = "text-emerald-400";
    bgGlow = "from-emerald-500/25 via-slate-900 to-slate-950";
  } else if (!isDraw) {
    titleIcon = "💥";
    titleText = "THẤT BẠI!";
    titleColor = "text-rose-400";
    bgGlow = "from-rose-500/25 via-slate-900 to-slate-950";
  }

  const reasonText =
    result.reason === "KO"
      ? isWinner
        ? "Hạ gục đối thủ"
        : "Bạn đã bị đối thủ hạ gục"
      : result.reason === "WORDS_EXHAUSTED"
      ? "Hoàn thành tất cả các từ"
      : result.reason === "FORFEIT"
      ? isWinner
        ? "Đối thủ đã rút lui hoặc mất kết nối"
        : "Trận đấu kết thúc"
      : result.reason;

  const myStats =
    result.hostStats?.userId && String(result.hostStats.userId) === String(currentUserId)
      ? result.hostStats
      : result.guestStats?.userId && String(result.guestStats.userId) === String(currentUserId)
      ? result.guestStats
      : isHost
      ? result.hostStats
      : result.guestStats || result.hostStats;
  const oppStats = myStats === result.hostStats ? result.guestStats : result.hostStats;

  const totalMyWords = (myStats?.hits ?? 0) + (myStats?.misses ?? 0);
  const myAccuracy = totalMyWords > 0 ? Math.round(((myStats?.hits ?? 0) / totalMyWords) * 100) : (myStats?.accuracy ?? 100);
  const totalOppWords = (oppStats?.hits ?? 0) + (oppStats?.misses ?? 0);
  const oppAccuracy = totalOppWords > 0 ? Math.round(((oppStats?.hits ?? 0) / totalOppWords) * 100) : (oppStats?.accuracy ?? 100);

  // Missed words from payload or fetched
  const initialMissedWords = myStats?.missedWords || [];
  const missedWordsList = fetchedMissedWords || initialMissedWords;
  const missedCount = myStats?.misses ?? missedWordsList.length;

  const loadMissedWords = async () => {
    if (fetchedMissedWords !== null) {
      setShowWeakWords((prev) => !prev);
      return;
    }
    setLoadingMissed(true);
    try {
      const matchParam = result.matchId ? `?matchId=${result.matchId}` : "";
      const res = await fetch(`/api/v1/flashcards/pvp/missed-words${matchParam}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setFetchedMissedWords(data);
      } else {
        setFetchedMissedWords(initialMissedWords);
      }
    } catch {
      setFetchedMissedWords(initialMissedWords);
    } finally {
      setLoadingMissed(false);
      setShowWeakWords(true);
    }
  };

  // Rule-based deterministic pedagogical coaching tip
  const getCoachingTip = (): string => {
    const accuracy = myStats?.accuracy ?? 100;
    const avgReaction = myStats?.avgReactionMs ?? 0;
    const golden = myStats?.goldenCaptured ?? 0;

    if (accuracy < 60) {
      return "Độ chính xác hiện dưới 60%. Bạn nên giảm cấp độ tốc độ (Cấp 1 - Dễ) hoặc ôn lại bộ thẻ từ vựng này trước khi tái đấu PvP.";
    }
    if (missedCount >= 5) {
      return `Bạn đã bỏ lỡ ${missedCount} từ vựng. Hãy tận dụng kỹ năng phòng thủ như Slow-Mo hoặc EMP Blast để làm sạch màn hình khi nguy cấp!`;
    }
    if (avgReaction > 1800) {
      return "Thời gian phản xạ trung bình trên 1.8s. Hãy chú ý nhìn chữ gợi ý (hint mask) để phản xạ gõ ngay khi từ vừa xuất hiện!";
    }
    if (golden === 0 && (oppStats?.goldenCaptured ?? 0) > 0) {
      return "Từ Vàng xuất hiện từ giây thứ 18 mang lại 30 điểm và lá chắn phản đòn cực mạnh. Đừng bỏ lỡ trong trận tới!";
    }
    if (accuracy >= 90 && avgReaction > 0 && avgReaction < 1200) {
      return "Phản xạ xuất sắc và độ chính xác vượt trội! Bạn hoàn toàn sẵn sàng thử sức ở các cấp độ tốc độ cao hơn.";
    }
    return "Duy trì chuỗi gõ liên tiếp (Streak 3) để kích hoạt đòn tấn công áp lực dồn ép đối thủ!";
  };

  const ratingDelta = myStats?.ratingDelta ?? myStats?.ratingChange ?? 0;

  return (
    <div
      data-testid="pvp-result-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-md animate-fadeIn"
    >
      <div
        className={`w-full max-w-xl max-h-[92vh] flex flex-col bg-gradient-to-b ${bgGlow} border border-slate-700/80 rounded-3xl p-5 sm:p-7 shadow-2xl relative overflow-hidden`}
      >
        {/* Glow Header with true optical centering */}
        <div className="flex flex-col items-center justify-center text-center w-full mx-auto mb-4 flex-shrink-0">
          <h2 className={`text-2xl sm:text-3xl font-black tracking-tight flex items-center justify-center gap-2 w-full m-0 p-0 ${titleColor}`}>
            <span className="shrink-0 select-none" aria-hidden="true">{titleIcon}</span>
            <span>{titleText}</span>
            <span className="shrink-0 invisible select-none" aria-hidden="true">{titleIcon}</span>
          </h2>
          <p className="mt-1.5 text-xs sm:text-sm text-slate-400 font-medium text-center w-full m-0 p-0 block">
            {reasonText}
          </p>

          {/* Ranked Elo Badge if applicable */}
          {result.isRanked && (
            <div className="mt-2 inline-flex items-center justify-center gap-1.5 px-3 py-1 rounded-full bg-slate-900/90 border border-amber-500/30 text-xs font-bold shadow-sm">
              <Award className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-slate-300">Đấu Xếp Hạng:</span>
              <span
                className={`font-mono ${
                  ratingDelta > 0
                    ? "text-emerald-400 flex items-center gap-0.5"
                    : ratingDelta < 0
                    ? "text-rose-400 flex items-center gap-0.5"
                    : "text-slate-400"
                }`}
              >
                {ratingDelta > 0 ? (
                  <>
                    <TrendingUp className="w-3 h-3" /> +{ratingDelta}
                  </>
                ) : ratingDelta < 0 ? (
                  <>
                    <TrendingDown className="w-3 h-3" /> {ratingDelta}
                  </>
                ) : (
                  "0"
                )}{" "}
                Elo
              </span>
            </div>
          )}
        </div>

        {/* Tab Selection */}
        <div className="flex items-center justify-center gap-2 mb-4 p-1 bg-slate-950/60 rounded-xl border border-slate-800 flex-shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab("summary")}
            className={`flex-1 py-1.5 px-3 rounded-lg text-xs sm:text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
              activeTab === "summary"
                ? "bg-slate-800 text-white shadow-md border border-slate-700"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Trophy className="w-4 h-4 text-amber-400" />
            <span>Tổng quan</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("report")}
            className={`flex-1 py-1.5 px-3 rounded-lg text-xs sm:text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
              activeTab === "report"
                ? "bg-slate-800 text-white shadow-md border border-slate-700"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <span>📊 Báo cáo Trận đấu</span>
          </button>
        </div>

        {/* Tab Content Container */}
        <div className="overflow-y-auto flex-1 pr-1 custom-scrollbar mb-4 space-y-4">
          {activeTab === "summary" ? (
            /* Dual Stats Comparison Table */
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5">
              <div className="grid grid-cols-3 gap-2 pb-3 mb-3 border-b border-slate-800 text-center font-bold text-xs uppercase tracking-wider">
                <span className="text-indigo-400 truncate">
                  {myStats?.displayName || "Bạn"}
                </span>
                <span className="text-slate-500">Chỉ số</span>
                <span className="text-amber-400 truncate">
                  {oppStats?.displayName || "Đối thủ"}
                </span>
              </div>

              <div className="space-y-3 text-sm font-medium">
                <div className="grid grid-cols-3 gap-2 items-center text-center">
                  <span className="font-mono font-bold text-slate-200">
                    {myStats?.remainingHp ?? 0} HP
                  </span>
                  <span className="text-xs text-slate-400 flex items-center justify-center gap-1">
                    <Shield className="w-3.5 h-3.5 text-slate-400" /> HP còn lại
                  </span>
                  <span className="font-mono font-bold text-slate-200">
                    {oppStats?.remainingHp ?? 0} HP
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 items-center text-center">
                  <span className="font-mono font-bold text-indigo-400">
                    {myStats?.score ?? 0}
                  </span>
                  <span className="text-xs text-slate-400 flex items-center justify-center gap-1">
                    <Trophy className="w-3.5 h-3.5 text-slate-400" /> Điểm số
                  </span>
                  <span className="font-mono font-bold text-amber-400">
                    {oppStats?.score ?? 0}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 items-center text-center">
                  <span className="font-mono font-bold text-emerald-400">
                    {myAccuracy}%
                  </span>
                  <span className="text-xs text-slate-400 flex items-center justify-center gap-1">
                    <Target className="w-3.5 h-3.5 text-slate-400" /> Chính xác
                  </span>
                  <span className="font-mono font-bold text-emerald-400">
                    {oppAccuracy}%
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 items-center text-center">
                  <span className="font-mono font-bold text-orange-400">
                    🔥 {myStats?.maxStreak ?? 0}
                  </span>
                  <span className="text-xs text-slate-400 flex items-center justify-center gap-1">
                    <Flame className="w-3.5 h-3.5 text-slate-400" /> Chuỗi tối đa
                  </span>
                  <span className="font-mono font-bold text-orange-400">
                    🔥 {oppStats?.maxStreak ?? 0}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 items-center text-center">
                  <span className="font-mono text-xs text-slate-300">
                    {myStats?.hits ?? 0} / {myStats?.misses ?? 0}
                  </span>
                  <span className="text-[11px] text-slate-500">Trúng / Trượt</span>
                  <span className="font-mono text-xs text-slate-300">
                    {oppStats?.hits ?? 0} / {oppStats?.misses ?? 0}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            /* Echo Coach Post-Match Report Tab */
            <div className="space-y-4">
              {/* Detailed Performance Metrics Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 text-center">
                  <div className="text-[11px] text-slate-400 flex items-center justify-center gap-1 mb-1">
                    <Target className="w-3.5 h-3.5 text-emerald-400" /> Độ chính xác
                  </div>
                  <div className="text-lg font-black font-mono text-emerald-400">
                    {myAccuracy}%
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {myStats?.hits ?? 0} đúng / {missedCount} sai
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 text-center">
                  <div className="text-[11px] text-slate-400 flex items-center justify-center gap-1 mb-1">
                    <Clock className="w-3.5 h-3.5 text-cyan-400" /> Phản xạ TB
                  </div>
                  <div className="text-lg font-black font-mono text-cyan-400">
                    {myStats?.avgReactionMs && myStats.avgReactionMs > 0 ? `${myStats.avgReactionMs} ms` : "N/A"}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {myStats?.avgReactionMs && myStats.avgReactionMs > 0 ? `${(myStats.avgReactionMs / 1000).toFixed(2)}s` : "Chưa ghi nhận"}
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 text-center">
                  <div className="text-[11px] text-slate-400 flex items-center justify-center gap-1 mb-1">
                    <Trophy className="w-3.5 h-3.5 text-amber-400" /> Từ Vàng
                  </div>
                  <div className="text-lg font-black font-mono text-amber-400">
                    ◆ {myStats?.goldenCaptured ?? 0}
                  </div>
                  <div className="text-[10px] text-slate-500">Thu phục thành công</div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 text-center">
                  <div className="text-[11px] text-slate-400 flex items-center justify-center gap-1 mb-1">
                    <Zap className="w-3.5 h-3.5 text-purple-400" /> Tấn công gửi
                  </div>
                  <div className="text-lg font-black font-mono text-purple-400">
                    ⚔️ {myStats?.attacksSent ?? 0}
                  </div>
                  <div className="text-[10px] text-slate-500">Đòn áp lực gửi đi</div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 text-center">
                  <div className="text-[11px] text-slate-400 flex items-center justify-center gap-1 mb-1">
                    <Shield className="w-3.5 h-3.5 text-indigo-400" /> Đỡ / Hóa giải
                  </div>
                  <div className="text-lg font-black font-mono text-indigo-400">
                    🛡️ {myStats?.attacksDeflected ?? 0}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    Nhận: {myStats?.attacksReceived ?? 0}
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 text-center">
                  <div className="text-[11px] text-slate-400 flex items-center justify-center gap-1 mb-1">
                    <AlertCircle className="w-3.5 h-3.5 text-rose-400" /> Từ bỏ lỡ
                  </div>
                  <div className="text-lg font-black font-mono text-rose-400">
                    {missedCount}
                  </div>
                  <div className="text-[10px] text-slate-500">Cần củng cố</div>
                </div>
              </div>

              {/* Echo Coach Pedagogical Insight Card */}
              <div className="p-4 bg-gradient-to-r from-indigo-950/40 via-purple-950/40 to-slate-900/60 border border-indigo-500/30 rounded-2xl">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 rounded-lg bg-indigo-500/20 flex items-center justify-center text-indigo-300">
                    🤖
                  </div>
                  <span className="text-xs font-bold tracking-wide uppercase text-indigo-300">
                    Echo Coach - Lời khuyên sư phạm
                  </span>
                </div>
                <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                  {getCoachingTip()}
                </p>
              </div>

              {/* Targeted Weak Word Review Section */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-amber-400" />
                    <span className="text-xs sm:text-sm font-bold text-slate-200">
                      Ôn lại các từ đã sai
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">
                      {missedCount} từ
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={loadMissedWords}
                    disabled={loadingMissed || missedCount === 0}
                    className={`py-1.5 px-3 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                      missedCount === 0
                        ? "bg-slate-800/50 text-slate-500 cursor-not-allowed border border-slate-800"
                        : "bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 active:scale-95"
                    }`}
                  >
                    <span>{showWeakWords ? "Thu gọn" : "📚 Ôn lại các từ đã sai"}</span>
                    {showWeakWords ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                {/* Collapsible Flashcard List */}
                {showWeakWords && (
                  <div className="mt-3 pt-3 border-t border-slate-800 space-y-2 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
                    {missedWordsList.length === 0 ? (
                      <p className="text-xs text-slate-500 text-center py-3">
                        🎉 Tuyệt vời! Bạn không bỏ lỡ từ vựng nào trong trận đấu này.
                      </p>
                    ) : (
                      missedWordsList.map((mw, idx) => (
                        <div
                          key={mw.wordId || idx}
                          className="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80 hover:border-indigo-500/40 transition-colors flex items-center justify-between gap-3 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-sm text-slate-100 font-mono">
                                {mw.word}
                              </span>
                              {mw.ipa && (
                                <span className="text-[11px] text-cyan-400 font-mono">
                                  {mw.ipa}
                                </span>
                              )}
                            </div>
                            <p className="text-slate-400 truncate mt-0.5">
                              {mw.vietnamese || (mw.meanings && mw.meanings[0]) || "Từ vựng trong trận"}
                            </p>
                          </div>
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-950/40 text-rose-300 border border-rose-800/50 flex-shrink-0">
                            Cần ôn
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Action CTAs: Rematch and Leave */}
        <div className="flex flex-col sm:flex-row items-center gap-3 pt-2 border-t border-slate-800/80 flex-shrink-0">
          <button
            type="button"
            onClick={onRematch}
            disabled={!isForfeit && rematchRequested}
            className={`w-full flex-1 py-3 px-4 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer shadow-lg ${
              !isForfeit && rematchRequested
                ? "bg-slate-800 text-slate-400 cursor-not-allowed border border-slate-700"
                : isForfeit
                ? "bg-slate-800/90 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 active:scale-95 shadow-slate-900/50"
                : "bg-gradient-to-r from-indigo-500 to-cyan-500 hover:from-indigo-600 hover:to-cyan-600 text-white active:scale-95 shadow-indigo-500/25"
            }`}
          >
            {isForfeit ? (
              <>
                <RotateCcw className="w-4 h-4 opacity-70" />
                <span>Đấu lại (Đối thủ đã rời đi)</span>
              </>
            ) : rematchRequested ? (
              <>
                <Clock className="w-4 h-4 animate-spin text-amber-400" />
                <span>Đang chờ đối thủ đồng ý...</span>
              </>
            ) : (
              <>
                <RotateCcw className="w-4 h-4" />
                <span>Đấu lại</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onExit}
            className="w-full sm:w-auto py-3 px-5 rounded-xl font-semibold text-sm bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 hover:text-white transition-all border border-slate-700 cursor-pointer flex items-center justify-center gap-2"
          >
            <LogOut className="w-4 h-4" />
            <span>Rời phòng</span>
          </button>
        </div>
      </div>
    </div>
  );
}
