"use client";

import React from "react";
import { useLanguage } from "@/context/LanguageContext";

interface EmptyDeckViewProps {
  onAddCard: () => void;
  onImportApkg: () => void;
}

export function EmptyDeckView({ onAddCard, onImportApkg }: EmptyDeckViewProps) {
  const { t } = useLanguage();

  return (
    <div className="w-full max-w-4xl mx-auto flex flex-col items-center">
      <div className="relative w-full rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl p-8 sm:p-12 overflow-hidden flex flex-col items-center text-center">
        {/* Tactile Ambient Glows */}
        <div className="absolute -top-24 -left-20 w-80 h-80 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -right-16 w-96 h-96 rounded-full bg-amber-400/15 blur-3xl pointer-events-none" />

        {/* Mascot & Card Stack Vector Illustration */}
        <div className="relative w-64 h-52 mb-4 flex items-center justify-center">
          <svg className="w-full h-full drop-shadow-sm select-none" fill="none" viewBox="0 0 280 220" xmlns="http://www.w3.org/2000/svg">
            <ellipse cx="140" cy="190" fill="#E4E2DE" opacity="0.65" rx="90" ry="14" />
            {/* Card Layer 3 */}
            <g transform="rotate(-6 140 145)">
              <rect fill="#EFE8DC" height="105" rx="14" width="176" x="52" y="85" />
              <rect fill="#DDD5C7" height="6" rx="3" width="60" x="68" y="102" />
              <rect fill="#E4DDD0" height="4" rx="2" width="110" x="68" y="116" />
            </g>
            {/* Card Layer 2 */}
            <g transform="rotate(4 140 135)">
              <rect fill="#F7F3EB" height="105" rx="14" width="176" x="52" y="70" />
              <rect fill="#E2DDD2" height="6" rx="3" width="70" x="68" y="87" />
              <rect fill="#ECE7DC" height="4" rx="2" width="120" x="68" y="101" />
            </g>
            {/* Top Card Layer */}
            <g transform="rotate(-1 140 125)">
              <rect fill="#FFFFFF" height="110" rx="16" width="176" x="52" y="55" stroke="#E2E8F0" strokeWidth="1" />
              <rect fill="#F1EFEA" height="14" rx="7" width="36" x="66" y="70" />
              <rect fill="#4338CA" height="10" rx="5" width="90" x="66" y="96" />
              <rect fill="#B45309" fillOpacity="0.75" height="6" rx="3" width="60" x="66" y="112" />
            </g>
            {/* Sun Mascot Floating Top Right */}
            <g transform="translate(182, 22)">
              <path d="M28 6V0M28 56V50M6 28H0M56 28H50M12 12L7.8 7.8M48.2 48.2L44 44M12 44L7.8 48.2M48.2 7.8L44 12" stroke="#FFB95F" strokeLinecap="round" strokeWidth="3" />
              <circle cx="28" cy="28" fill="#FFB95F" r="18" />
              <circle cx="28" cy="28" fill="#FFDDB8" r="15" />
              <circle cx="23" cy="26" fill="#2A1700" r="2.2" />
              <circle cx="33" cy="26" fill="#2A1700" r="2.2" />
              <path d="M24 31C25.5 33.2 30.5 33.2 32 31" stroke="#2A1700" strokeLinecap="round" strokeWidth="2" />
            </g>
          </svg>
        </div>

        {/* Headings & Explainer */}
        <div className="max-w-md flex flex-col items-center gap-2 mb-8">
          <span className="text-[11px] text-indigo-600 dark:text-indigo-400 uppercase font-bold tracking-wider">
            Workspace Ready
          </span>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            {t.emptyDeckTitle}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            {t.emptyDeckDesc}
          </p>
        </div>

        {/* Primary Action Buttons */}
        <div className="flex flex-wrap items-center justify-center gap-3 w-full max-w-md">
          <button
            type="button"
            id="empty-add-card-btn"
            onClick={onAddCard}
            className="flex-1 min-w-[160px] flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm shadow-md transition-all active:translate-y-0.5 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[20px]">add_circle</span>
            <span>{t.addFlashcard}</span>
          </button>

          <button
            type="button"
            id="empty-import-apkg-btn"
            onClick={onImportApkg}
            className="flex-1 min-w-[160px] flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-white font-semibold text-sm transition-all cursor-pointer"
          >
            <span className="material-symbols-outlined text-[20px] text-indigo-600 dark:text-indigo-400">upload_file</span>
            <span>{t.importApkg}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
