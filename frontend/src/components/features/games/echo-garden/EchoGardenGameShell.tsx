"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import { useRouter } from "next/navigation";
import { Maximize2, LogOut, X, AlertCircle } from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";

export interface EchoGardenGameContextValue {
  isFullscreen: boolean;
  isExiting: boolean;
  requestExit: () => void;
  reenterFullscreen: () => Promise<void>;
}

const EchoGardenGameContext = createContext<EchoGardenGameContextValue | null>(
  null
);

export function useEchoGardenGame() {
  const context = useContext(EchoGardenGameContext);
  if (!context) {
    throw new Error(
      "useEchoGardenGame must be used within an EchoGardenGameShell"
    );
  }
  return context;
}

interface EchoGardenGameShellProps {
  children: React.ReactNode;
}

export function EchoGardenGameShell({ children }: EchoGardenGameShellProps) {
  const router = useRouter();
  const { locale } = useLanguage();
  const vi = locale === "vi";

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showFullscreenNotice, setShowFullscreenNotice] = useState(false);
  const [showExitModal, setShowExitModal] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  // Monitor Native Fullscreen State and Handle ESC key exit
  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = Boolean(
        document.fullscreenElement ||
          (document as unknown as { webkitFullscreenElement?: Element })
            .webkitFullscreenElement
      );
      setIsFullscreen(active);
      if (!active) {
        // User exited native fullscreen (e.g. pressed ESC)
        // Keep game in 100dvw x 100dvh immersive mode and show unobtrusive notice
        setShowFullscreenNotice(true);
      } else {
        setShowFullscreenNotice(false);
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

    // Initial check
    setIsFullscreen(
      Boolean(
        document.fullscreenElement ||
          (document as unknown as { webkitFullscreenElement?: Element })
            .webkitFullscreenElement
      )
    );

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener(
        "webkitfullscreenchange",
        handleFullscreenChange
      );
    };
  }, []);

  const reenterFullscreen = useCallback(async () => {
    try {
      if (typeof document !== "undefined") {
        const el = document.documentElement;
        if (el.requestFullscreen) {
          await el.requestFullscreen().catch(() => {});
        } else if (
          (el as unknown as { webkitRequestFullscreen?: () => Promise<void> })
            .webkitRequestFullscreen
        ) {
          await (
            el as unknown as { webkitRequestFullscreen: () => Promise<void> }
          )
            .webkitRequestFullscreen()
            .catch(() => {});
        }
      }
    } catch {
      // Safe fallback - continue in immersive 100dvw x 100dvh mode
    }
    setShowFullscreenNotice(false);
  }, []);

  const requestExit = useCallback(() => {
    setShowExitModal(true);
  }, []);

  const handleConfirmExit = useCallback(async () => {
    setIsExiting(true);
    setShowExitModal(false);

    try {
      if (
        typeof document !== "undefined" &&
        (document.fullscreenElement ||
          (document as unknown as { webkitFullscreenElement?: Element })
            .webkitFullscreenElement)
      ) {
        if (document.exitFullscreen) {
          await document.exitFullscreen().catch(() => {});
        } else if (
          (document as unknown as { webkitExitFullscreen?: () => Promise<void> })
            .webkitExitFullscreen
        ) {
          await (
            document as unknown as { webkitExitFullscreen: () => Promise<void> }
          )
            .webkitExitFullscreen()
            .catch(() => {});
        }
      }
    } catch {
      // Exit fullscreen failure must never block navigation
    }

    // Explicitly navigate to /games
    router.push("/games");
  }, [router]);

  return (
    <EchoGardenGameContext.Provider
      value={{
        isFullscreen,
        isExiting,
        requestExit,
        reenterFullscreen,
      }}
    >
      <div
        id="echo-garden-root"
        data-testid="echo-garden-shell"
        className="fixed inset-0 h-[100dvh] w-[100dvw] overflow-hidden bg-[#0c142b] text-slate-100 antialiased font-sans select-none z-0"
        style={{
          paddingTop: "env(safe-area-inset-top, 0px)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          paddingLeft: "env(safe-area-inset-left, 0px)",
          paddingRight: "env(safe-area-inset-right, 0px)",
        }}
      >
        {/* Standalone Viewport */}
        {!isExiting && children}

        {/* Unobtrusive Notice when Native Fullscreen Exits (e.g. User Pressed ESC) */}
        {showFullscreenNotice && !isFullscreen && !showExitModal && (
          <aside
            role="status"
            aria-live="polite"
            className="pointer-events-auto absolute top-3 sm:top-5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 rounded-full border border-sky-400/30 bg-[#0e172a]/95 px-4 py-2 text-xs font-medium text-slate-200 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2 duration-200"
          >
            <AlertCircle className="h-4 w-4 text-sky-400 shrink-0" />
            <span>
              {vi
                ? "Bạn đã thoát chế độ toàn màn hình"
                : "You exited full-screen mode"}
            </span>
            <button
              type="button"
              onClick={reenterFullscreen}
              className="inline-flex items-center gap-1 rounded-full bg-sky-500/20 px-2.5 py-1 text-[11px] font-bold text-sky-300 hover:bg-sky-500/30 hover:text-white transition-all cursor-pointer"
            >
              <Maximize2 className="h-3 w-3" />
              <span>{vi ? "Toàn màn hình lại" : "Full Screen Again"}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowFullscreenNotice(false)}
              className="rounded-full p-1 text-slate-400 hover:text-white transition-colors cursor-pointer"
              aria-label={vi ? "Đóng thông báo" : "Dismiss notice"}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </aside>
        )}

        {/* Exit Game Confirmation Modal */}
        {showExitModal && (
          <div
            role="presentation"
            data-testid="echo-garden-exit-modal"
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="exit-garden-title"
              className="w-full max-w-sm rounded-3xl border border-white/15 bg-gradient-to-b from-[#151a3f] to-[#0c142b] p-6 shadow-2xl text-slate-100 space-y-5"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-500/15 text-rose-400 border border-rose-500/30">
                  <LogOut className="h-5 w-5" />
                </div>
                <div>
                  <h2
                    id="exit-garden-title"
                    className="text-lg font-black tracking-tight text-white"
                  >
                    {vi ? "Rời Đảo Ký Ức?" : "Leave Memory Island?"}
                  </h2>
                  <p className="text-xs text-slate-300/70 mt-0.5">
                    {vi
                      ? "Trở về Thư viện trò chơi"
                      : "Return to Games Library"}
                  </p>
                </div>
              </div>

              <p className="text-xs sm:text-sm text-slate-300/90 leading-relaxed border-t border-white/10 pt-3">
                {vi
                  ? "Cảnh quan và nông sản trên Đảo Ký Ức luôn được lưu giữ. Bạn có chắc muốn thoát và trở về Thư viện trò chơi không?"
                  : "Your island state and crops are automatically saved. Are you sure you want to exit and return to the Games Hub?"}
              </p>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowExitModal(false)}
                  className="rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-bold text-slate-200 hover:bg-white/10 transition-all cursor-pointer"
                >
                  {vi ? "Ở lại" : "Stay"}
                </button>
                <button
                  type="button"
                  data-testid="confirm-exit-garden-btn"
                  data-exit-confirm="true"
                  id="confirm-exit-garden-btn"
                  onClick={handleConfirmExit}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 px-4 py-2.5 text-xs font-bold text-white shadow-lg shadow-rose-600/30 hover:brightness-110 active:scale-95 transition-all cursor-pointer"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>
                    {vi ? "Thoát về Thư viện" : "Exit to Games Hub"}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </EchoGardenGameContext.Provider>
  );
}
