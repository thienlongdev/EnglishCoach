"use client";

import React, { useEffect, useState } from "react";
import {
  Sun,
  Sunset,
  Moon,
  ZoomIn,
  ZoomOut,
  Home,
  LogOut,
  X,
  Droplets,
  TreePine,
  Sprout,
  Trees,
  House,
  Maximize2,
  Minimize2,
  CircleHelp,
} from "lucide-react";
import type { TimeOfDay, InspectableTarget } from "./EchoGardenCanvas";
import { useEchoGardenGame } from "./EchoGardenGameShell";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import VfxSettings from '@/components/vfx/VfxSettings';
import { useLanguage } from '@/context/LanguageContext';
import { EASE, FOCUS_RING, PANEL } from "./game/gardenUi";

interface EchoGardenHUDProps {
  timeOfDay: TimeOfDay;
  onTimeOfDayChange: (time: TimeOfDay) => void;
  cameraZoom: number;
  onZoom: (direction: "in" | "out") => void;
  onResetCamera: () => void;
  selectedTarget: InspectableTarget | null;
  onCloseInspect: () => void;
  onQuickFocus: (targetId: string) => void;
  /** Gameplay: live player status shown instead of the "Bản xem trước" badge. */
  status?: React.ReactNode;
  /** Gameplay: the selected target is handled by a gameplay panel (no preview inspect card). */
  suppressInspect?: boolean;
  /**
   * Gameplay on the player's own island: the permanent "Hướng dẫn" entry (Echo's guides). It lives with the view
   * controls — in the bar on larger screens, last in the rail on phones — so it never crowds the bottom row or the dock.
   */
  onHelp?: () => void;
  helpOpen?: boolean;
}

/*
 * HUD art direction (GDD 04 §2, cozy-fantasy pass): Chàm Đêm night-indigo surfaces like smooth river
 * stones — softly translucent over the moving sky, a warm lantern-gold hairline on top, pebble radii,
 * one motion language (EASE, 200–320 ms, no spring). Readable over day, sunset and night skies. The tokens live in
 * game/gardenUi.tsx and are shared with the gameplay panels.
 */
const TIMES: Array<{ id: TimeOfDay; label: string; aria: string; Icon: typeof Sun; pill: string; icon: string }> = [
  { id: "day", label: "Ban ngày", aria: "Chuyển chế độ ban ngày", Icon: Sun, pill: "from-[#FFD978] to-[#F4B63F]", icon: "text-[#3a2a0a]" },
  { id: "sunset", label: "Hoàng hôn", aria: "Chuyển chế độ hoàng hôn", Icon: Sunset, pill: "from-[#FFB27A] to-[#E9784F]", icon: "text-[#3a1608]" },
  { id: "night", label: "Ban đêm", aria: "Chuyển chế độ ban đêm", Icon: Moon, pill: "from-[#A897FF] to-[#7360E0]", icon: "text-white" },
];

const DISTRICTS: Array<{ id: string; label: string; short: string; Icon: typeof Sun; color: string; match: (id: string) => boolean }> = [
  { id: "farm_zone", label: "Nông trại", short: "Nông trại", Icon: Sprout, color: "text-[#8fd18f]", match: (id) => id === "farm_zone" || id.startsWith("plot_") || id === "prop_scarecrow" },
  { id: "farmhouse", label: "Nhà gỗ", short: "Nhà", Icon: House, color: "text-[#f3b07a]", match: (id) => id === "farmhouse" || id === "shed" },
  { id: "pond", label: "Ao Ký Ức", short: "Ao", Icon: Droplets, color: "text-[#7fd3f5]", match: (id) => id === "pond" },
  { id: "knowledge_tree", label: "Cây Tri Thức", short: "Tri Thức", Icon: TreePine, color: "text-[#7fe0d0]", match: (id) => id === "knowledge_tree" },
  { id: "forest_zone", label: "Rừng Ký Ức", short: "Rừng", Icon: Trees, color: "text-[#9fd47e]", match: (id) => id === "forest_zone" || id === "orchard_zone" },
];

function IconButton({
  onClick,
  label,
  children,
  disabled,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-11 w-11 items-center justify-center rounded-[14px] text-[#EEF3FF]/80 transition-[background-color,color,transform] duration-200 ${EASE} hover:bg-white/10 hover:text-white active:scale-[0.94] ${FOCUS_RING} disabled:opacity-35 disabled:active:scale-100 cursor-pointer disabled:cursor-default sm:h-9 sm:w-9 sm:rounded-xl`}
    >
      {children}
    </button>
  );
}

/** Segmented sunlight control: the lit pill glides to the chosen time (one motion, no jump). */
function TimeOfDayControl({ value, onChange }: { value: TimeOfDay; onChange: (t: TimeOfDay) => void }) {
  const index = Math.max(0, TIMES.findIndex((t) => t.id === value));
  return (
    <div role="radiogroup" aria-label="Thời điểm trong ngày" data-guide="time" className="relative grid grid-cols-3 rounded-[14px] bg-black/20 p-0.5 sm:rounded-xl">
      <span
        aria-hidden
        className={`pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 w-[calc((100%-4px)/3)] rounded-[12px] bg-gradient-to-b shadow-[0_4px_12px_-4px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.45)] transition-[transform,background-image] duration-300 ${EASE} motion-reduce:transition-none sm:rounded-[10px] ${TIMES[index].pill}`}
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {TIMES.map(({ id, label, aria, Icon, icon }) => {
        const on = value === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={aria}
            title={label}
            onClick={() => onChange(id)}
            className={`relative z-10 flex h-11 w-11 items-center justify-center rounded-[12px] transition-colors duration-300 ${EASE} active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9 sm:rounded-[10px] ${
              on ? icon : "text-[#EEF3FF]/60 hover:text-white"
            }`}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}

export function EchoGardenHUD({
  timeOfDay,
  onTimeOfDayChange,
  cameraZoom,
  onZoom,
  onResetCamera,
  selectedTarget,
  onCloseInspect,
  onQuickFocus,
  status,
  suppressInspect = false,
  onHelp,
  helpOpen = false,
}: EchoGardenHUDProps) {
  const { requestExit, isFullscreen, reenterFullscreen } = useEchoGardenGame();
  const { locale } = useLanguage();
  const activeId = selectedTarget?.id ?? "";

  // the inspector eases out instead of vanishing: keep the last target for the exit transition
  const inspectTarget = suppressInspect ? null : selectedTarget;
  const [shown, setShown] = useState<InspectableTarget | null>(inspectTarget);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (inspectTarget) {
      setShown(inspectTarget);
      setClosing(false);
      return;
    }
    if (!shown) return;
    setClosing(true);
    const id = window.setTimeout(() => {
      setShown(null);
      setClosing(false);
    }, 220);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectTarget]);

  const cameraButtons = (
    <>
      <IconButton onClick={() => onZoom("in")} label="Phóng to camera">
        <ZoomIn className="h-4 w-4" />
      </IconButton>
      <IconButton onClick={() => onZoom("out")} label="Thu nhỏ camera">
        <ZoomOut className="h-4 w-4" />
      </IconButton>
      <IconButton onClick={onResetCamera} label="Góc nhìn mặc định">
        <Home className="h-4 w-4" />
      </IconButton>
      <IconButton onClick={reenterFullscreen} label={isFullscreen ? "Đang ở chế độ toàn màn hình" : "Mở toàn màn hình"} disabled={isFullscreen}>
        {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
      </IconButton>
    </>
  );

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 flex flex-col justify-between select-none overflow-hidden"
      style={{
        paddingTop: "calc(env(safe-area-inset-top, 0px) + 0.75rem)",
        paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)",
        paddingLeft: "calc(env(safe-area-inset-left, 0px) + 0.75rem)",
        paddingRight: "calc(env(safe-area-inset-right, 0px) + 0.75rem)",
      }}
    >
      <style>{`@keyframes eg-sheet-in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@keyframes eg-sheet-out{from{opacity:1;transform:none}to{opacity:0;transform:translateY(16px)}}
@media (min-width:640px){@keyframes eg-sheet-in{from{opacity:0;transform:translate(12px,-50%)}to{opacity:1;transform:translate(0,-50%)}}
@keyframes eg-sheet-out{from{opacity:1;transform:translate(0,-50%)}to{opacity:0;transform:translate(12px,-50%)}}}`}</style>
      {/* TOP BAR */}
      {/* phones: the view controls are taken out of the row (top right corner), so the status under the exit button may
          use the whole width instead of pushing them off the screen; the camera rail then starts below the status */}
      <header className="relative flex items-start justify-between gap-2">
        <div className="pointer-events-auto flex min-w-0 flex-col items-start gap-1.5 max-sm:max-w-full sm:flex-row sm:items-center sm:gap-2">
          <button
            type="button"
            data-testid="echo-garden-exit-btn"
            onClick={requestExit}
            className={`${PANEL} inline-flex h-11 items-center gap-1.5 rounded-[18px_14px_18px_16px] px-4 text-xs font-bold text-[#EEF3FF] transition-[background-color,border-color,color,transform] duration-200 ${EASE} active:scale-[0.96] hover:border-rose-300/45 hover:text-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/70 cursor-pointer sm:h-10`}
            aria-label="Thoát Đảo Ký Ức"
          >
            <LogOut className="h-3.5 w-3.5 text-rose-300" />
            <span>Thoát</span>
          </button>
          {status ?? (
            <>
              {/* phones: the preview status stays visible as a compact badge */}
              <span className="rounded-full border border-[#F4C35A]/35 bg-[#1F2257]/85 px-2.5 py-1 text-[11px] font-bold text-[#FFD978] shadow-[inset_0_1px_0_rgba(255,226,160,0.12)] backdrop-blur sm:hidden">
                Bản xem trước
              </span>
              <div className={`${PANEL} hidden h-10 items-center gap-2.5 rounded-[16px_20px_16px_18px] px-3.5 sm:flex`}>
                <span className="text-sm font-black tracking-tight text-[#EEF3FF]">Đảo Ký Ức</span>
                <span className="rounded-full border border-[#F4C35A]/30 bg-[#F4C35A]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#FFD978]">
                  Bản xem trước
                </span>
              </div>
            </>
          )}
        </div>

        <div className="pointer-events-auto flex flex-col items-end gap-2 max-sm:absolute max-sm:right-0 max-sm:top-0">
          <details className={`${PANEL} max-w-[180px] rounded-xl px-3 py-2 text-xs text-[#EEF3FF]`}><summary className="cursor-pointer min-h-11 flex items-center">{locale === 'vi' ? 'Hiệu ứng điện ảnh' : 'Cinematic effects'}</summary><VfxSettings compact /></details>
          <div className={`${PANEL} flex items-center gap-1 rounded-[20px_16px_20px_18px] p-1`}>
            <TimeOfDayControl value={timeOfDay} onChange={onTimeOfDayChange} />
            {/* desktop: camera controls share the bar */}
            <div className="mx-0.5 hidden h-5 w-px bg-white/10 sm:block" />
            <div className="hidden items-center gap-1 sm:flex" data-guide="camera">{cameraButtons}</div>
            {onHelp && (
              <>
                <div className="mx-0.5 hidden h-5 w-px bg-white/10 sm:block" />
                <button
                  type="button"
                  onClick={onHelp}
                  data-testid="garden-help-btn"
                  data-guide="help"
                  aria-pressed={helpOpen}
                  aria-label="Hướng dẫn"
                  title="Hướng dẫn"
                  className={`hidden h-9 items-center gap-1.5 rounded-xl px-2.5 text-xs font-bold text-[#EEF3FF]/90 transition-[background-color,color,transform] duration-200 ${EASE} hover:bg-white/10 hover:text-white active:scale-[0.96] ${FOCUS_RING} cursor-pointer sm:flex ${helpOpen ? "bg-white/15 text-white" : ""}`}
                >
                  <CircleHelp className="h-4 w-4 text-[#FFD978]" aria-hidden />
                  <span className="hidden lg:inline">Hướng dẫn</span>
                </button>
              </>
            )}
          </div>
          {/* phones: a slim vertical rail, clear of the island and the dock */}
          <div className={`flex flex-col items-end gap-2 sm:hidden ${status ? "mt-[5.5rem]" : ""}`}>
            <div data-guide="camera" className={`${PANEL} flex flex-col items-center gap-0.5 rounded-[18px] p-1`}>{cameraButtons}</div>
            {onHelp && (
              <div className={`${PANEL} rounded-[18px] p-1`}>
                <button
                  type="button"
                  onClick={onHelp}
                  data-testid="garden-help-btn-phone"
                  data-guide="help"
                  aria-pressed={helpOpen}
                  aria-label="Hướng dẫn"
                  title="Hướng dẫn"
                  className={`flex h-11 w-11 items-center justify-center rounded-[14px] text-[#EEF3FF]/90 transition-[background-color,transform] duration-200 ${EASE} hover:bg-white/10 active:scale-[0.94] ${FOCUS_RING} cursor-pointer ${helpOpen ? "bg-white/15" : ""}`}
                >
                  <CircleHelp className="h-5 w-5 text-[#FFD978]" aria-hidden />
                </button>
              </div>
            )}
          </div>
          <span className="sr-only" aria-live="polite">{`Thu phóng ${Math.round(cameraZoom * 100)}%`}</span>
        </div>
      </header>

      {/* INSPECT CARD (desktop) / BOTTOM SHEET (mobile) */}
      {shown && (
        <aside
          role="dialog"
          aria-modal="false"
          aria-labelledby="inspect-target-title"
          aria-hidden={closing}
          key={shown.id}
          className={`pointer-events-auto ${PANEL} max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-40 max-sm:max-h-[52dvh] max-sm:overflow-y-auto max-sm:rounded-t-[26px] max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] sm:absolute sm:right-3 sm:top-1/2 sm:max-h-[calc(100dvh-9rem)] sm:w-[320px] sm:-translate-y-1/2 sm:overflow-y-auto sm:rounded-[26px_22px_28px_24px] p-4 ${
            closing
              ? "pointer-events-none motion-safe:animate-[eg-sheet-out_220ms_cubic-bezier(0.22,1,0.36,1)_forwards] motion-reduce:opacity-0"
              : "motion-safe:animate-[eg-sheet-in_320ms_cubic-bezier(0.22,1,0.36,1)]"
          }`}
        >
          <div className="mx-auto mb-3 h-1.5 w-11 rounded-full bg-white/25 sm:hidden" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#FFD978]/90">{shown.subtitle}</p>
              <h2 id="inspect-target-title" className="mt-0.5 text-lg font-black leading-tight text-[#EEF3FF]">
                {shown.title}
              </h2>
              {shown.stage && (
                <span className="mt-1.5 inline-block rounded-full border border-[#74C98B]/25 bg-[#74C98B]/15 px-2.5 py-0.5 text-[11px] font-bold text-[#a6e6b3]">
                  {shown.stage}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={onCloseInspect}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,color,transform] duration-200 ${EASE} hover:bg-white/20 hover:text-white active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}
              aria-label="Đóng bảng chi tiết"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-3 border-t border-white/10 pt-3 text-[13px] leading-relaxed text-[#EEF3FF]/85">
            {shown.description}
          </p>
          {shown.stats && shown.stats.length > 0 && (
            <dl className="mt-3 grid grid-cols-2 gap-2">
              {shown.stats.map((st) => (
                <div key={st.label} className="rounded-[14px] border border-white/10 bg-black/20 px-2.5 py-2">
                  <dt className="text-[10px] text-[#EEF3FF]/55">{st.label}</dt>
                  <dd className="mt-0.5 text-xs font-bold text-[#EEF3FF]">{st.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </aside>
      )}

      {/* DISTRICT DOCK */}
      <footer className="pointer-events-auto flex justify-center">
        <nav
          aria-label="Điều hướng nhanh Đảo Ký Ức"
          data-guide="dock"
          className={`${PANEL} flex max-w-full items-center gap-0.5 overflow-x-auto rounded-[22px_18px_22px_20px] p-1 [scrollbar-width:none] sm:gap-1 ${selectedTarget ? "max-sm:hidden" : ""}`}
        >
          {DISTRICTS.map(({ id, label, short, Icon, color, match }) => {
            const on = activeId !== "" && match(activeId);
            return (
              <button
                key={id}
                type="button"
                onClick={() => onQuickFocus(id)}
                aria-pressed={on}
                className={`flex min-h-[44px] min-w-[44px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-[14px] px-2 py-1.5 text-[11px] font-bold transition-[background-color,color,box-shadow,transform] duration-200 ${EASE} active:scale-[0.96] ${FOCUS_RING} cursor-pointer sm:min-h-0 sm:flex-row sm:gap-1.5 sm:rounded-xl sm:px-3 sm:py-2 sm:text-xs ${
                  on ? "bg-white/15 text-white shadow-[inset_0_1px_0_rgba(255,226,160,0.25)]" : "text-[#EEF3FF]/90 hover:bg-white/10 hover:text-white"
                }`}
              >
                <Icon className={`h-4 w-4 ${color}`} />
                <span className="hidden sm:inline">{label}</span>
                <span className="sm:hidden">{short}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => onQuickFocus("echo_whale")}
            aria-pressed={activeId === "echo_whale"}
            className={`flex min-h-[44px] min-w-[44px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-[14px] px-2 py-1.5 text-[11px] font-bold transition-[background-color,color,box-shadow,transform] duration-200 ${EASE} active:scale-[0.96] ${FOCUS_RING} cursor-pointer sm:min-h-0 sm:flex-row sm:gap-1.5 sm:rounded-xl sm:px-3 sm:py-2 sm:text-xs ${
              activeId === "echo_whale" ? "bg-white/15 text-white shadow-[inset_0_1px_0_rgba(255,226,160,0.25)]" : "text-[#EEF3FF]/90 hover:bg-white/10 hover:text-white"
            }`}
          >
            <BrandWhaleIcon variant="clean" size="xs" className="h-4 w-4" />
            <span>Echo</span>
          </button>
        </nav>
      </footer>
    </div>
  );
}
