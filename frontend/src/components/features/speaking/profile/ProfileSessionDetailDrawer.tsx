"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
    AlertCircle,
    Bot,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    RefreshCw,
    Target,
    User,
    X,
} from "lucide-react";
import type { SpeakingSessionDetail } from "@/services/speakingApi";
import { AttemptAudioPlayer } from "../AttemptAudioPlayer";
import { getLearnerIssueLabel } from "./profileViewModel";
import glass from "./speakingProfileGlass.module.css";

export interface ProfileSessionDetailDrawerProps {
    sessionId: number | null;
    detail: SpeakingSessionDetail | null;
    isLoading: boolean;
    error: unknown;
    onRetry: () => void;
    onClose: () => void;
    vi?: boolean;
}

export function ProfileSessionDetailDrawer({
    sessionId,
    detail,
    isLoading,
    error,
    onRetry,
    onClose,
    vi = true,
}: ProfileSessionDetailDrawerProps) {
    const [expandedAttempts, setExpandedAttempts] = useState<Record<string, boolean>>({});

    useEffect(() => {
        setExpandedAttempts({});
    }, [sessionId]);

    useEffect(() => {
        if (sessionId == null) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [sessionId, onClose]);

    if (sessionId == null) return null;

    const toggleAttemptExpanded = (attemptId: string) => {
        setExpandedAttempts((prev) => ({
            ...prev,
            [attemptId]: !prev[attemptId],
        }));
    };

    const modeUpper = (detail?.mode || "").toUpperCase();
    const headerTitle =
        modeUpper === "QUICK_CHECK"
            ? `Quick Check #${sessionId}`
            : modeUpper === "ROLEPLAY"
            ? `${vi ? "Hội thoại AI Role-play" : "AI Role-play"} #${sessionId}`
            : `${vi ? "Chi tiết buổi tập Shadowing" : "Shadowing Session"} #${sessionId}`;

    const drawerNode = (
        <div
            className={`${glass.workspace} ${glass.drawerScrim}`}
            onClick={onClose}
            role="presentation"
            data-testid="speaking-session-detail-drawer"
        >
            <div
                className={glass.drawerPanel}
                role="dialog"
                aria-modal="true"
                aria-labelledby="sp-drawer-title"
                onClick={(e) => e.stopPropagation()}
            >
                <div className={glass.drawerHeader}>
                    <div className="min-w-0">
                        <span className={glass.eyebrow}>
                            {vi ? "Hồ sơ bản ghi đã lưu · 0 gọi lại AI" : "Saved session record · 0 AI calls"}
                        </span>
                        <h3 id="sp-drawer-title" className={glass.title} style={{ fontSize: "1.18rem" }}>
                            {headerTitle}
                        </h3>
                        <p className={glass.issueMeta}>
                            {detail?.scenarioTitle || detail?.materialTitle || (vi ? "Đang đồng bộ thông tin..." : "Loading...")}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className={glass.actionBtnGhost}
                        aria-label={vi ? "Đóng ngăn chi tiết" : "Close detail drawer"}
                    >
                        <X />
                    </button>
                </div>

                <div className={glass.drawerBody}>
                    {isLoading && !detail ? (
                        <div className="space-y-3" role="status">
                            <div className={glass.skeletonBlock} style={{ height: "6rem" }} />
                            <div className={glass.skeletonBlock} style={{ height: "8rem" }} />
                            <div className={glass.skeletonBlock} style={{ height: "8rem" }} />
                        </div>
                    ) : error && !detail ? (
                        <div className={glass.stateCard} role="alert">
                            <span className={glass.stateIcon} data-tone="rose" aria-hidden="true">
                                <AlertCircle />
                            </span>
                            <h4 className={glass.stateTitle}>
                                {vi ? "Không thể tải chi tiết buổi tập" : "Could not load session detail"}
                            </h4>
                            <button type="button" onClick={onRetry} className={glass.actionBtnPrimary}>
                                <RefreshCw />
                                <span>{vi ? "Thử lại" : "Retry"}</span>
                            </button>
                        </div>
                    ) : detail && (modeUpper === "QUICK_CHECK" || detail.quickCheck) ? (
                        /* ── QUICK CHECK DETAIL VIEW ── */
                        <div className="space-y-3.5">
                            {detail.quickCheck?.clientAttemptId && (
                                <div className={glass.detailBlock}>
                                    <span className={glass.filterGroupLabel}>
                                        {vi ? "Bản thu âm của bạn" : "Your recording"}
                                    </span>
                                    <AttemptAudioPlayer clientAttemptId={detail.quickCheck.clientAttemptId} />
                                </div>
                            )}

                            <div className={glass.detailBlock}>
                                <span className={glass.filterGroupLabel}>
                                    {vi ? "English Coach nghe được" : "Recognized transcript"}
                                </span>
                                <p className="text-base font-extrabold leading-relaxed">
                                    &ldquo;
                                    {detail.quickCheck?.intendedTranscript ||
                                        detail.quickCheck?.whisperTranscript ||
                                        detail.materialTitle}
                                    &rdquo;
                                </p>
                                {detail.quickCheck?.intendedTranscript &&
                                    detail.quickCheck?.whisperTranscript &&
                                    detail.quickCheck.intendedTranscript !== detail.quickCheck.whisperTranscript && (
                                        <p className={glass.issueMeta}>
                                            (Whisper ban đầu: &ldquo;{detail.quickCheck.whisperTranscript}&rdquo;)
                                        </p>
                                    )}
                            </div>

                            {(() => {
                                const qc = detail.quickCheck;
                                const pronReady = !qc?.pronunciationStatus || qc.pronunciationStatus === "SUCCESS";
                                const fmt = (v?: number | null) =>
                                    pronReady && typeof v === "number" && Number.isFinite(v)
                                        ? String(Math.round(v))
                                        : "—";
                                return (
                                    <div className={glass.detailBlock}>
                                        <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-500/15">
                                            <span className={glass.filterGroupLabel}>
                                                {vi ? "Phát âm (Pronunciation Engine V2.2)" : "Pronunciation V2.2"}
                                            </span>
                                            <span className={`text-lg font-extrabold ${glass.mono}`}>
                                                {pronReady && qc?.overallScore != null
                                                    ? `${Math.round(qc.overallScore)}/100`
                                                    : "—"}
                                            </span>
                                        </div>
                                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center text-xs">
                                            {[
                                                [vi ? "Âm vị" : "Phonemes", fmt(qc?.phonemeScore)],
                                                [vi ? "Trọng âm" : "Stress", fmt(qc?.stressScore)],
                                                [vi ? "Ngữ điệu" : "Pitch", fmt(qc?.pitchScore)],
                                                [vi ? "Nhịp điệu" : "Rhythm", fmt(qc?.rhythmScore)],
                                                [vi ? "Trôi chảy" : "Fluency", fmt(qc?.fluencyScore)],
                                            ].map(([lbl, val], idx) => (
                                                <div
                                                    key={String(lbl)}
                                                    className={`${glass.kpiTile} items-center ${idx === 4 ? "col-span-2 sm:col-span-1" : ""}`}
                                                >
                                                    <div className="text-[10px] opacity-75 font-bold">{lbl}</div>
                                                    <div className={`text-sm font-extrabold ${glass.mono}`}>{val}</div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })()}

                            {detail.quickCheck?.languageFeedback && (
                                <div className={glass.detailBlock}>
                                    <span className={glass.filterGroupLabel}>
                                        {vi ? "Cách diễn đạt" : "Language feedback"}
                                    </span>
                                    {detail.quickCheck.languageFeedback.corrections.length === 0 ? (
                                        <div className="flex items-center gap-2 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                                            <CheckCircle2 size={15} />
                                            <span>{vi ? "Câu này đúng và tự nhiên." : "Accurate and natural."}</span>
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {detail.quickCheck.languageFeedback.corrections.map((c, cIdx) => (
                                                <div key={cIdx} className={glass.cueCallout}>
                                                    <div className="text-xs">
                                                        <span className="opacity-70 mr-1.5">{vi ? "Gốc:" : "Original:"}</span>
                                                        <span className="line-through text-rose-600 dark:text-rose-400 font-semibold">
                                                            &ldquo;{c.original}&rdquo;
                                                        </span>
                                                    </div>
                                                    <div className="text-xs mt-1">
                                                        <span className="font-bold text-emerald-700 dark:text-emerald-300 mr-1.5">
                                                            {vi ? "Nên dùng:" : "Better:"}
                                                        </span>
                                                        <span className="font-extrabold text-emerald-700 dark:text-emerald-300">
                                                            &ldquo;{c.suggestion}&rdquo;
                                                        </span>
                                                    </div>
                                                    {c.explanationVi && (
                                                        <p className={`${glass.issueMeta} mt-1`}>{c.explanationVi}</p>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {detail.quickCheck?.languageFeedback?.naturalVersion && (
                                <div className={glass.detailBlock}>
                                    <span className={glass.filterGroupLabel}>
                                        {vi ? "Cách nói tự nhiên hơn" : "More natural phrasing"}
                                    </span>
                                    <p className="text-sm font-extrabold">
                                        &ldquo;{detail.quickCheck.languageFeedback.naturalVersion}&rdquo;
                                    </p>
                                    {detail.quickCheck.languageFeedback.meaningNoteVi && (
                                        <p className={glass.issueMeta}>
                                            {detail.quickCheck.languageFeedback.meaningNoteVi}
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    ) : detail && (modeUpper === "ROLEPLAY" || (detail.turns && detail.turns.length > 0)) ? (
                        /* ── ROLE-PLAY AI DETAIL VIEW ── */
                        <div className="space-y-3.5">
                            <div className={glass.detailBlock}>
                                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                    <span className="font-extrabold">
                                        {vi ? "Vai của bạn:" : "Your role:"}{" "}
                                        <span className="underline">{detail.learnerRole || "Học viên"}</span>
                                    </span>
                                    <span className="opacity-80">
                                        AI: <strong>{detail.aiRole || "AI Coach"}</strong>
                                    </span>
                                </div>
                                {detail.learnerGoal && (
                                    <div className="text-xs flex items-start gap-1.5 pt-1.5 border-t border-slate-500/15">
                                        <Target size={14} className="shrink-0 mt-0.5" />
                                        <span>
                                            <strong>{vi ? "Mục tiêu:" : "Goal:"}</strong> {detail.learnerGoal}
                                        </span>
                                    </div>
                                )}
                                {detail.targetVocabulary && detail.targetVocabulary.length > 0 && (
                                    <div className={glass.exampleChips}>
                                        <span className={glass.sectionSubnote}>
                                            {vi ? "Từ vựng mục tiêu:" : "Target vocabulary:"}
                                        </span>
                                        {detail.targetVocabulary.map((v, vIdx) => (
                                            <span key={vIdx} className={glass.exampleChip}>
                                                {v}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="space-y-3">
                                {detail.turns?.map((turn, tIdx) => {
                                    const isLearner = turn.speaker === "LEARNER";
                                    return (
                                        <div key={turn.id || tIdx} className={glass.detailBlock}>
                                            <div className="flex items-center justify-between text-xs">
                                                <span className="inline-flex items-center gap-1.5 font-extrabold">
                                                    {isLearner ? <User size={13} /> : <Bot size={13} />}
                                                    <span>
                                                        {isLearner
                                                            ? `${vi ? "Bạn" : "You"} (${detail.learnerRole || "Learner"})`
                                                            : detail.aiRole || "AI Coach"}
                                                    </span>
                                                    <span className={`opacity-60 ${glass.mono}`}>
                                                        #{turn.sequenceNumber}
                                                    </span>
                                                </span>
                                                {turn.createdAt && (
                                                    <span className={`text-[11px] opacity-65 ${glass.mono}`}>
                                                        {new Date(turn.createdAt).toLocaleTimeString("vi-VN", {
                                                            hour: "2-digit",
                                                            minute: "2-digit",
                                                        })}
                                                    </span>
                                                )}
                                            </div>

                                            <p className="text-sm leading-relaxed font-medium">{turn.text}</p>

                                            {isLearner && (
                                                <div className="space-y-2 pt-2 border-t border-slate-500/15">
                                                    {Boolean(turn.audioRef) && turn.clientTurnId && (
                                                        <AttemptAudioPlayer clientAttemptId={turn.clientTurnId} />
                                                    )}

                                                    {(turn.pronunciationScore != null ||
                                                        turn.segmentalScore != null ||
                                                        turn.intonationScore != null) && (
                                                        <div className={glass.exampleChips}>
                                                            {turn.pronunciationScore != null && (
                                                                <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                                                    Phát âm: {Math.round(turn.pronunciationScore)}/100
                                                                </span>
                                                            )}
                                                            {turn.segmentalScore != null && (
                                                                <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                                                    Âm vị: {Math.round(turn.segmentalScore)}
                                                                </span>
                                                            )}
                                                            {turn.stressScore != null && (
                                                                <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                                                    Trọng âm: {Math.round(turn.stressScore)}
                                                                </span>
                                                            )}
                                                            {turn.intonationScore != null && (
                                                                <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                                                    Ngữ điệu: {Math.round(turn.intonationScore)}
                                                                </span>
                                                            )}
                                                            {turn.rhythmScore != null && (
                                                                <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                                                    Nhịp điệu: {Math.round(turn.rhythmScore)}
                                                                </span>
                                                            )}
                                                            {turn.fluencyScore != null && (
                                                                <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                                                    Lưu loát: {Math.round(turn.fluencyScore)}
                                                                </span>
                                                            )}
                                                        </div>
                                                    )}

                                                    {turn.feedback && (
                                                        <div className={glass.cueCallout}>
                                                            {turn.feedback.positiveFeedback && (
                                                                <div className="font-bold text-emerald-700 dark:text-emerald-300 mb-1">
                                                                    {turn.feedback.positiveFeedback}
                                                                </div>
                                                            )}
                                                            {turn.feedback.summary && <div>{turn.feedback.summary}</div>}
                                                            {turn.feedback.corrections &&
                                                                turn.feedback.corrections.length > 0 && (
                                                                    <div className="space-y-1 mt-1.5 pt-1.5 border-t border-slate-500/15">
                                                                        {turn.feedback.corrections.map((corr, cIdx) => (
                                                                            <div key={cIdx} className="text-xs">
                                                                                <strong className="uppercase text-[10px] mr-1.5">
                                                                                    [{corr.type}]
                                                                                </strong>
                                                                                <span className="line-through text-rose-500 mr-1">
                                                                                    {corr.original}
                                                                                </span>
                                                                                <span className="font-bold text-emerald-600 dark:text-emerald-400 mr-1">
                                                                                    {"->"} {corr.suggestion}
                                                                                </span>
                                                                                <span className="opacity-75">
                                                                                    ({corr.explanation})
                                                                                </span>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                        </div>
                                                    )}

                                                    {turn.detectedVocabulary && turn.detectedVocabulary.length > 0 && (
                                                        <div className={glass.exampleChips}>
                                                            <span className={glass.sectionSubnote}>
                                                                {vi ? "Từ vựng đã dùng:" : "Used vocabulary:"}
                                                            </span>
                                                            {turn.detectedVocabulary.map((word, wIdx) => (
                                                                <span key={wIdx} className={glass.exampleChip}>
                                                                    {word}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ) : detail && detail.sentences && detail.sentences.length > 0 ? (
                        /* ── SHADOWING SENTENCE-BY-SENTENCE DETAIL VIEW ── */
                        <div className="space-y-3.5">
                            {detail.sentences.map((sent, idx) => (
                                <div key={sent.unitId || idx} className={glass.detailBlock}>
                                    <div className="flex items-start justify-between gap-2">
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <span className={`${glass.eyebrow} ${glass.mono}`}>
                                                    {vi ? `Câu ${idx + 1}` : `Sentence ${idx + 1}`}
                                                </span>
                                                <span className={glass.sectionSubnote}>
                                                    ({sent.attempts?.length || 0} {vi ? "lần thu" : "takes"})
                                                </span>
                                            </div>
                                            <p className="text-sm font-bold mt-1">{sent.text || "—"}</p>
                                        </div>
                                        <span
                                            className={glass.statusBadge}
                                            data-status={
                                                sent.unitState === "RESOLVED_THIS_SESSION"
                                                    ? "RECENTLY_STABLE"
                                                    : sent.unitState === "ATTEMPTED"
                                                    ? "PRACTICING"
                                                    : "INSUFFICIENT_DATA"
                                            }
                                        >
                                            {sent.unitState === "RESOLVED_THIS_SESSION"
                                                ? vi
                                                    ? "Đã sửa thành công"
                                                    : "Resolved"
                                                : sent.unitState === "ATTEMPTED"
                                                ? vi
                                                    ? "Đã thực hiện"
                                                    : "Attempted"
                                                : vi
                                                ? "Chưa luyện"
                                                : "Not started"}
                                        </span>
                                    </div>

                                    {sent.attempts && sent.attempts.length > 0 && (
                                        <div className="space-y-2.5 pt-2 border-t border-slate-500/15">
                                            {sent.attempts.map((att, aIdx) => {
                                                let parsedV2: Record<string, any> | null = null;
                                                if (att.productSafeResultJson) {
                                                    try {
                                                        parsedV2 = JSON.parse(att.productSafeResultJson);
                                                    } catch {
                                                        parsedV2 = null;
                                                    }
                                                }
                                                const phonemeScore =
                                                    parsedV2?.overall?.segmentalScore ??
                                                    parsedV2?.overall?.phonemeScore ??
                                                    parsedV2?.phonemeScore ??
                                                    null;
                                                const stressScore =
                                                    parsedV2?.lexicalStress?.status === "ASSESSED"
                                                        ? parsedV2.overall?.stressScore
                                                        : null;
                                                const pitchScore =
                                                    parsedV2?.overall?.intonationScore ??
                                                    parsedV2?.overall?.pitchScore ??
                                                    parsedV2?.pitchScore ??
                                                    null;
                                                const rhythmScore =
                                                    parsedV2?.overall?.rhythmScore ?? parsedV2?.rhythmScore ?? null;
                                                const fluencyScore =
                                                    parsedV2?.overall?.fluencyScore ??
                                                    parsedV2?.fluencyScore ??
                                                    att.fluencyScore ??
                                                    null;
                                                const primaryFocusDesc =
                                                    parsedV2?.priorities?.[0]?.instructionVi ??
                                                    parsedV2?.priorities?.[0]?.instructionEn ??
                                                    parsedV2?.priorities?.[0]?.description;
                                                const primaryFocusWord =
                                                    parsedV2?.priorities?.[0]?.word || att.targetWord;
                                                const primaryIssue = att.primaryIssueType
                                                    ? getLearnerIssueLabel(att.primaryIssueType)
                                                    : null;

                                                return (
                                                    <div key={att.clientAttemptId || aIdx} className={glass.cueCallout}>
                                                        <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                                                            <span className="font-extrabold text-xs">
                                                                {vi ? "Lần thu" : "Take"}{" "}
                                                                {att.retryIndex != null ? att.retryIndex + 1 : aIdx + 1}
                                                            </span>
                                                            <span
                                                                className={glass.statusBadge}
                                                                data-status={
                                                                    att.resolvedThisSession
                                                                        ? "RECENTLY_STABLE"
                                                                        : att.retryComparisonState === "IMPROVED"
                                                                        ? "IMPROVING"
                                                                        : "PRACTICING"
                                                                }
                                                            >
                                                                {att.resolvedThisSession
                                                                    ? vi
                                                                        ? "Đã sửa đúng"
                                                                        : "Resolved"
                                                                    : att.retryComparisonState === "IMPROVED"
                                                                    ? vi
                                                                        ? "Tiến bộ"
                                                                        : "Improved"
                                                                    : vi
                                                                    ? "Đã phân tích"
                                                                    : "Analyzed"}
                                                            </span>
                                                        </div>

                                                        {att.learnerTranscript && (
                                                            <p className="text-xs italic opacity-85 mb-2">
                                                                Whisper: &ldquo;{att.learnerTranscript}&rdquo;
                                                            </p>
                                                        )}

                                                        <div className={`${glass.exampleChips} mb-2`}>
                                                            {att.accuracyScore != null && (
                                                                <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                                                    Khớp nội dung: {Math.round(att.accuracyScore)}%
                                                                </span>
                                                            )}
                                                            {att.pronunciationScore != null && (
                                                                <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                                                    Phát âm V2.2: {Math.round(att.pronunciationScore)}/100
                                                                </span>
                                                            )}
                                                            {att.fluencyScore != null && (
                                                                <span className={`${glass.kpiSubPill} ${glass.mono}`}>
                                                                    Lưu loát: {Math.round(att.fluencyScore)}
                                                                </span>
                                                            )}
                                                        </div>

                                                        {att.clientAttemptId && (
                                                            <div className="mb-2">
                                                                <AttemptAudioPlayer clientAttemptId={att.clientAttemptId} />
                                                            </div>
                                                        )}

                                                        {parsedV2 && (
                                                            <>
                                                                <button
                                                                    type="button"
                                                                    onClick={() =>
                                                                        toggleAttemptExpanded(att.clientAttemptId)
                                                                    }
                                                                    className="inline-flex items-center gap-1 text-[11px] font-extrabold text-indigo-600 dark:text-indigo-300 cursor-pointer"
                                                                >
                                                                    <span>
                                                                        {expandedAttempts[att.clientAttemptId]
                                                                            ? vi
                                                                                ? "Thu gọn chỉ số V2.2"
                                                                                : "Hide V2.2 breakdown"
                                                                            : vi
                                                                            ? "Xem 5 chỉ số V2.2 đã lưu"
                                                                            : "Show V2.2 breakdown"}
                                                                    </span>
                                                                    {expandedAttempts[att.clientAttemptId] ? (
                                                                        <ChevronUp size={12} />
                                                                    ) : (
                                                                        <ChevronDown size={12} />
                                                                    )}
                                                                </button>

                                                                {expandedAttempts[att.clientAttemptId] && (
                                                                    <div className="mt-2 pt-2 border-t border-slate-500/15 space-y-2">
                                                                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 text-center text-xs">
                                                                            {[
                                                                                ["Âm vị", phonemeScore],
                                                                                ["Trọng âm", stressScore],
                                                                                ["Cao độ", pitchScore],
                                                                                ["Nhịp điệu", rhythmScore],
                                                                                ["Lưu loát", fluencyScore],
                                                                            ].map(([lbl, val]) => (
                                                                                <div
                                                                                    key={String(lbl)}
                                                                                    className="p-1.5 rounded-lg bg-black/[0.03] dark:bg-white/[0.05]"
                                                                                >
                                                                                    <div className="text-[10px] opacity-70">
                                                                                        {lbl}
                                                                                    </div>
                                                                                    <div className={`font-extrabold ${glass.mono}`}>
                                                                                        {val != null
                                                                                            ? Math.round(Number(val))
                                                                                            : "—"}
                                                                                    </div>
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                        {(primaryFocusDesc ||
                                                                            primaryFocusWord ||
                                                                            primaryIssue) && (
                                                                            <p className="text-[11px] opacity-85">
                                                                                <strong>Trọng tâm: </strong>
                                                                                {primaryFocusDesc || primaryIssue || ""}
                                                                                {primaryFocusWord
                                                                                    ? ` (Từ: "${primaryFocusWord}")`
                                                                                    : ""}
                                                                            </p>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className={glass.stateCard}>
                            <p className={glass.stateDesc}>
                                {vi
                                    ? "Phiên luyện nói này chưa có lượt thu âm nào được lưu."
                                    : "No recorded turns or attempts found in this session."}
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );

    return typeof document !== "undefined" ? createPortal(drawerNode, document.body) : drawerNode;
}
