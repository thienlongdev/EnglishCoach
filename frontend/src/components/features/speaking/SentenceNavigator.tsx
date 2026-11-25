"use client";

import React, { useState, useMemo, useRef, useEffect } from "react";
import { CheckCircle2, Search } from "lucide-react";
import { SpeakingShadowingUnit } from "@/services/speakingApi";
import { echoSrc } from '@/lib/brand/echoCharacters';

export interface UnitProgressInfo {
    attemptCount: number;
    bestAccuracy?: number | null;
    bestPronunciation?: number | null;
    isPracticed?: boolean;
}

interface SentenceNavigatorProps {
    units: SpeakingShadowingUnit[];
    currentIndex: number;
    onSelectUnit: (index: number) => void;
    progressMap?: Record<number, UnitProgressInfo>;
    className?: string;
}

function formatTimestamp(ms: number): string {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}

interface NavigatorRowProps {
    unit: SpeakingShadowingUnit;
    index: number;
    isCurrent: boolean;
    progress?: UnitProgressInfo;
    onSelect: (index: number) => void;
}

const NavigatorRow = React.memo(function NavigatorRow({
    unit,
    index,
    isCurrent,
    progress,
    onSelect,
}: NavigatorRowProps) {
    const isPracticed = unit.isPracticed || progress?.isPracticed || (unit.attemptCount > 0) || (progress?.attemptCount != null && progress.attemptCount > 0);
    const bestAccuracy = progress?.bestAccuracy ?? unit.bestAccuracy;

    return (
        <button
            type="button"
            id={`nav-unit-${index}`}
            onClick={() => onSelect(index)}
            className={`w-full text-left p-3.5 rounded-2xl transition-all duration-150 flex items-start gap-3 border cursor-pointer ${
                isCurrent
                    ? "bg-blue-50/90 dark:bg-blue-950/50 border-blue-400 dark:border-blue-600 shadow-sm ring-1 ring-blue-400/50"
                    : isPracticed
                    ? "bg-emerald-50/40 dark:bg-emerald-950/20 border-emerald-200/60 dark:border-emerald-900/40 hover:bg-emerald-50/70 dark:hover:bg-emerald-950/40"
                    : "bg-white dark:bg-gray-800/80 border-gray-100 dark:border-gray-700/60 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            }`}
            aria-current={isCurrent ? "true" : undefined}
            aria-label={`Câu số ${index + 1}: ${unit.displayText}`}
        >
            {/* Sequence & Status Badge */}
            <div className="shrink-0 flex flex-col items-center gap-1 mt-0.5">
                <span
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${
                        isCurrent
                            ? "bg-blue-600 text-white shadow-xs"
                            : isPracticed
                            ? "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300"
                            : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                    }`}
                >
                    {index + 1}
                </span>
                {isPracticed ? (
                    <CheckCircle2 size={14} className="text-emerald-600 dark:text-emerald-400" />
                ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600"></span>
                )}
            </div>

            {/* Unit Content */}
            <div className="flex-1 min-w-0">
                <p
                    className={`text-xs sm:text-sm leading-relaxed line-clamp-2 ${
                        isCurrent
                            ? "font-bold text-blue-900 dark:text-blue-100"
                            : isPracticed
                            ? "font-medium text-gray-800 dark:text-gray-200"
                            : "text-gray-600 dark:text-gray-400"
                    }`}
                >
                    {unit.displayText}
                </p>

                <div className="flex items-center justify-between gap-2 mt-1.5 text-[11px]">
                    <span className="font-mono text-gray-400 dark:text-gray-500">
                        {formatTimestamp(unit.startTimeMs)} - {formatTimestamp(unit.endTimeMs)}
                    </span>

                    {isPracticed && bestAccuracy != null && (() => {
                        const acc = Math.round(bestAccuracy);
                        const badgeColor = acc >= 80
                          ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30'
                          : acc >= 60
                            ? 'bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-500/30'
                            : 'bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30';
                        return (
                            <span className={`inline-flex items-center gap-1 font-bold text-[10px] px-1.5 py-0.5 rounded-md ${badgeColor}`}>
                                <img src={echoSrc('social', 24)} alt="Echo" className="w-2.5 h-2.5 object-contain" />
                                Khớp {acc}%
                            </span>
                        );
                    })()}
                </div>
            </div>
        </button>
    );
});

export function SentenceNavigator({
    units,
    currentIndex,
    onSelectUnit,
    progressMap = {},
    className = "",
}: SentenceNavigatorProps) {
    const [searchQuery, setSearchQuery] = useState("");
    const listContainerRef = useRef<HTMLDivElement>(null);

    // Filter units based on search query
    const filteredUnits = useMemo(() => {
        if (!searchQuery.trim()) {
            return units.map((u, idx) => ({ unit: u, originalIndex: idx }));
        }
        const q = searchQuery.toLowerCase().trim();
        return units
            .map((u, idx) => ({ unit: u, originalIndex: idx }))
            .filter(({ unit, originalIndex }) =>
                unit.displayText.toLowerCase().includes(q) || String(originalIndex + 1).includes(q)
            );
    }, [units, searchQuery]);

    // Calculate practiced statistics
    const practicedCount = useMemo(() => {
        let count = 0;
        units.forEach((u) => {
            const prog = progressMap[u.id];
            if (u.isPracticed || u.attemptCount > 0 || prog?.isPracticed || (prog?.attemptCount != null && prog.attemptCount > 0)) {
                count++;
            }
        });
        return count;
    }, [units, progressMap]);

    const completionPercent = units.length > 0
        ? Math.round((practicedCount / units.length) * 100)
        : 0;

    // Auto-scroll active row into view when currentIndex changes
    useEffect(() => {
        const activeElem = document.getElementById(`nav-unit-${currentIndex}`);
        if (activeElem && listContainerRef.current) {
            const container = listContainerRef.current;
            const elemTop = activeElem.offsetTop - container.offsetTop;
            const elemBottom = elemTop + activeElem.clientHeight;
            const containerTop = container.scrollTop;
            const containerBottom = containerTop + container.clientHeight;

            if (elemTop < containerTop || elemBottom > containerBottom) {
                activeElem.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
        }
    }, [currentIndex]);

    return (
        <div
            className={`flex flex-col h-full lg:h-[calc(100vh-6.5rem)] max-h-[calc(100vh-6.5rem)] bg-white dark:bg-gray-800/90 rounded-3xl border border-gray-200/80 dark:border-gray-700/80 shadow-lg overflow-hidden ${className}`}
        >
            {/* ── Navigator Header ── */}
            <div className="shrink-0 p-4 sm:p-5 border-b border-gray-100 dark:border-gray-700/60 space-y-3 bg-gray-50/50 dark:bg-gray-900/30">
                <div className="flex items-center justify-between gap-2">
                    <div>
                        <h2 className="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2">
                            <span>Danh sách câu Shadowing</span>
                            <span className="px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-[11px] font-extrabold">
                                {units.length}
                            </span>
                        </h2>
                    </div>
                    <div className="text-right">
                        <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">
                            {practicedCount}/{units.length} ({completionPercent}%)
                        </span>
                    </div>
                </div>

                {/* Mini Progress Bar */}
                <div className="w-full bg-gray-200 dark:bg-gray-700 h-1.5 rounded-full overflow-hidden">
                    <div
                        className="bg-gradient-to-r from-blue-500 to-emerald-500 h-full transition-all duration-300 rounded-full"
                        style={{ width: `${completionPercent}%` }}
                    ></div>
                </div>

                {/* Search / Filter Input */}
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Tìm kiếm câu, từ vựng..."
                        className="w-full pl-8 pr-3 py-1.5 text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/40 text-gray-800 dark:text-gray-200 placeholder-gray-400"
                    />
                </div>
            </div>

            {/* ── Scrollable Unit List ── */}
            <div
                ref={listContainerRef}
                className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 focus:outline-none scroll-smooth"
                tabIndex={0}
                role="list"
                aria-label="Danh sách câu thoại trong bài nghe"
            >
                {filteredUnits.length === 0 ? (
                    <div className="py-8 text-center text-xs text-gray-400 dark:text-gray-500">
                        Không tìm thấy câu phù hợp với từ khóa.
                    </div>
                ) : (
                    filteredUnits.map(({ unit, originalIndex }) => (
                        <NavigatorRow
                            key={unit.id || originalIndex}
                            unit={unit}
                            index={originalIndex}
                            isCurrent={originalIndex === currentIndex}
                            progress={progressMap[unit.id]}
                            onSelect={onSelectUnit}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
