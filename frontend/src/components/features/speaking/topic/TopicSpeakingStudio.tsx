"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AlertTriangle, BookOpen, Check, ChevronRight, Dices, Download, Heart, History, Mic, MicOff, Pause, Play,
    RotateCcw, SkipForward, Square, Volume2, VolumeX,
} from "lucide-react";
import { useLanguage } from "@/context/LanguageContext";
import { useModuleEntryResource } from "@/hooks/useModuleEntryResource";
import { speakingTopicApi, TOPIC_CATALOG_PATH, TOPIC_SUMMARY_PATH } from "@/services/speakingTopicApi";
import type { TopicBand, TopicCatalog, TopicDraw, TopicItem, TopicStyle, TopicSummary } from "@/types/speakingTopic";
import {
    buildPlan, canPause, DEFAULT_SETTINGS, elapsedMs, formatCountdown, formatElapsed, isDone, pauseClock, PRESETS,
    remainingMs, resumeClock, startClock, targetSeconds,
} from "@/lib/speaking/topicClock.mjs";
import type { Clock, PlanStep, TopicSettings } from "@/lib/speaking/topicClock.mjs";
import { CapsuleMachine, capsuleColor, MachineState } from "./CapsuleMachine";
import { useTopicRecorder } from "./useTopicRecorder";
import { playCue } from "./topicSounds";
import styles from "./topicStudio.module.css";

type Family = "QUICK" | "DEEP" | "IELTS";
type Phase = "idle" | "drawing" | "revealed" | "mic" | "running" | "interrupted" | "finishing" | "finished" | "exhausted" | "empty" | "error";

interface Prefs {
    family: Family;
    part: "IELTS1" | "IELTS2" | "IELTS3";
    category: string | null;
    band: TopicBand | null;
    record: boolean;
    muted: boolean;
    settings: TopicSettings;
}

interface Result {
    spokenSeconds: number;
    targetSeconds: number;
    reachedTarget: boolean;
    stoppedEarly: boolean;
    audioUrl: string | null;
    audioType: string | null;
    recordingFailed: boolean;
    savedOnServer: boolean;
}

const PREFS_KEY = "ec.speakingTopic.prefs.v1";
const DEFAULT_PREFS: Prefs = { family: "QUICK", part: "IELTS1", category: null, band: null, record: true, muted: false, settings: { ...DEFAULT_SETTINGS } };

function readPrefs(): Prefs {
    try {
        const raw = window.localStorage.getItem(PREFS_KEY);
        if (!raw) return DEFAULT_PREFS;
        const p = JSON.parse(raw) as Partial<Prefs>;
        return { ...DEFAULT_PREFS, ...p, settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) } };
    } catch {
        return DEFAULT_PREFS;
    }
}

const styleOf = (p: Prefs): TopicStyle => (p.family === "IELTS" ? p.part : p.family);
const familyOf = (s: TopicStyle): Family => (s === "QUICK" || s === "DEEP" ? s : "IELTS");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
const secondsLabel = (s: number, vi: boolean) => (s < 60 || s % 60 !== 0 ? `${s}${vi ? " giây" : "s"}` : `${s / 60} ${vi ? "phút" : "min"}`);

export default function TopicSpeakingStudio() {
    const { locale } = useLanguage();
    const vi = locale === "vi";
    const L = (v: string, e: string) => (vi ? v : e);

    const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
    useEffect(() => { setPrefs(readPrefs()); }, []);
    const updatePrefs = (patch: Partial<Prefs>) => setPrefs((p) => {
        const next = { ...p, ...patch, settings: { ...p.settings, ...(patch.settings ?? {}) } };
        try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
        return next;
    });
    const style = styleOf(prefs);

    const { data: catalog } = useModuleEntryResource<TopicCatalog>(TOPIC_CATALOG_PATH);
    const { data: summary, mutate: mutateSummary } = useModuleEntryResource<TopicSummary>(TOPIC_SUMMARY_PATH);
    const styleCatalog = catalog?.styles.find((s) => s.style === style);
    // a category chosen under another style may not exist here: never send a filter the list does not show
    const category = styleCatalog?.categories.some((c) => c.key === prefs.category) ? prefs.category : null;

    const [phase, setPhase] = useState<Phase>("idle");
    const [machine, setMachine] = useState<MachineState>("idle");
    const [draw, setDraw] = useState<TopicDraw | null>(null);
    const [exhaustedPool, setExhaustedPool] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [micNotice, setMicNotice] = useState<"denied" | "unsupported" | null>(null);
    const [interruption, setInterruption] = useState<"paused" | "hidden" | null>(null);
    const [showDefinition, setShowDefinition] = useState(false);
    const [result, setResult] = useState<Result | null>(null);
    const [drawingLabel, setDrawingLabel] = useState("");
    const [announce, setAnnounce] = useState("");
    const [favBusy, setFavBusy] = useState(false);

    // round engine (refs: the clock is read on every frame without re-rendering the world)
    const planRef = useRef<PlanStep[]>([]);
    const [stepIndex, setStepIndex] = useState(0);
    const clockRef = useRef<Clock | null>(null);
    const spokenMsRef = useRef(0);
    const lastTickRef = useRef<number | null>(null);
    const startedRef = useRef(false);
    const recordingRoundRef = useRef(false);
    const pendingSkipRef = useRef<number | null>(null);
    const busyRef = useRef(false);
    const [now, setNow] = useState(0);
    const questionRef = useRef<HTMLHeadingElement>(null);

    const recorder = useTopicRecorder();
    const item = draw?.item ?? null;
    const favorites = useMemo(() => new Set((summary?.favorites ?? []).map((f) => f.id)), [summary]);

    // release the previous recording's memory when a new one replaces it or the studio closes
    useEffect(() => () => { if (result?.audioUrl) URL.revokeObjectURL(result.audioUrl); }, [result?.audioUrl]);

    const reset = useCallback(() => {
        clockRef.current = null;
        planRef.current = [];
        spokenMsRef.current = 0;
        startedRef.current = false;
        setStepIndex(0);
        setInterruption(null);
        setShowDefinition(false);
        setResult(null);
    }, []);

    // ── drawing ───────────────────────────────────────────────
    const runDraw = useCallback(async (opts: { replayItemId?: string; allowReplay?: boolean; animate?: boolean }) => {
        if (busyRef.current) return; // one draw at a time (the server serialises too)
        busyRef.current = true;
        const animate = opts.animate !== false && !reducedMotion();
        const previous = draw && !startedRef.current ? draw.drawId : pendingSkipRef.current;
        pendingSkipRef.current = null;
        reset();
        recorder.release();
        setError(null);
        setMicNotice(null);
        setPhase("drawing");
        setMachine(animate ? "spinning" : "idle");
        if (animate) playCue("spin", prefs.muted);
        const labels = (styleCatalog?.categories ?? []).map((c) => (vi ? c.vi : c.en));
        let cycle: ReturnType<typeof setInterval> | null = null;
        if (animate && labels.length) {
            let i = Math.floor(Math.random() * labels.length);
            cycle = setInterval(() => { i = (i + 1) % labels.length; setDrawingLabel(labels[i]); }, 110);
        }
        try {
            const [res] = await Promise.all([
                speakingTopicApi.draw({
                    style, category, band: prefs.band,
                    previousDrawId: previous, replayItemId: opts.replayItemId, allowReplay: opts.allowReplay,
                }),
                wait(animate ? 1300 : 150),
            ]);
            if (cycle) clearInterval(cycle);
            if (res.outcome === "DRAWN" && res.item) {
                if (familyOf(res.item.style) !== prefs.family || (res.item.style !== "QUICK" && res.item.style !== "DEEP" && res.item.style !== prefs.part)) {
                    // a replay may switch practice style; keep the controls truthful
                    updatePrefs(res.item.style === "QUICK" || res.item.style === "DEEP"
                        ? { family: res.item.style }
                        : { family: "IELTS", part: res.item.style });
                }
                if (animate) {
                    setMachine("dropping");
                    await wait(520);
                    setMachine("opened");
                }
                setDraw(res);
                setPhase("revealed");
                playCue("reveal", prefs.muted);
                setAnnounce(L("Câu hỏi mới: ", "New question: ") + (res.item.title ? `${res.item.title}. ` : "") + res.item.questions[0]);
                requestAnimationFrame(() => questionRef.current?.focus({ preventScroll: true }));
            } else if (res.outcome === "EXHAUSTED") {
                setMachine("idle");
                setDraw(null);
                setExhaustedPool(res.poolSize);
                setPhase("exhausted");
            } else {
                setMachine("idle");
                setDraw(null);
                setPhase("empty");
            }
        } catch (e: unknown) {
            if (cycle) clearInterval(cycle);
            const status = (e as { response?: { status?: number } })?.response?.status;
            setMachine("idle");
            setError(status === 429
                ? L("Bạn đang rút câu hơi nhanh. Chờ một chút rồi thử lại nhé.", "You are drawing very quickly. Wait a moment and try again.")
                : status === 503
                    ? L("Hệ thống đang bận. Vui lòng thử lại sau vài giây.", "The service is busy. Please try again in a few seconds.")
                    : L("Không rút được câu hỏi. Kiểm tra kết nối rồi thử lại.", "Could not draw a question. Check your connection and try again."));
            setPhase("error");
        } finally {
            busyRef.current = false;
        }
    }, [draw, prefs, style, category, styleCatalog, vi, recorder.release, reset]);

    const changeFamily = (family: Family) => {
        if (phase === "running" || phase === "interrupted" || phase === "mic" || phase === "finishing" || phase === "drawing") return;
        if (draw && !startedRef.current && draw.drawId) pendingSkipRef.current = draw.drawId;
        setDraw(null);
        reset();
        setMachine("idle");
        setPhase("idle");
        updatePrefs({ family, band: family === "DEEP" && prefs.band === "BASIC" ? null : prefs.band });
    };

    // ── running a round ───────────────────────────────────────
    const startStep = useCallback((index: number) => {
        const step = planRef.current[index];
        clockRef.current = startClock(step.ms, performance.now());
        lastTickRef.current = null;
        setStepIndex(index);
        if (step.kind === "speak") {
            if (recordingRoundRef.current) recorder.startOrResume();
            playCue("go", prefs.muted);
        }
        setNow(performance.now());
    }, [recorder.startOrResume, prefs.muted]);

    const finishRound = useCallback(async (stoppedEarly: boolean) => {
        if (!draw?.drawId || !item) return;
        setPhase("finishing");
        const plan = planRef.current;
        const target = targetSeconds(item.style, plan);
        const recorded = recordingRoundRef.current;
        const blob = recorded ? await recorder.stop() : (recorder.release(), null);
        const spoken = Math.floor(spokenMsRef.current / 1000);
        const local: Result = {
            spokenSeconds: spoken, targetSeconds: target, reachedTarget: spoken >= target - 1, stoppedEarly,
            audioUrl: blob ? URL.createObjectURL(blob) : null, audioType: blob?.type ?? null,
            recordingFailed: recorded && !blob, savedOnServer: false,
        };
        setResult(local);
        setPhase("finished");
        playCue("end", prefs.muted);
        setAnnounce(L(`Kết thúc. Bạn đã nói ${formatElapsed(spoken * 1000)}.`, `Finished. You spoke for ${formatElapsed(spoken * 1000)}.`));
        try {
            const round = await speakingTopicApi.finish(draw.drawId, spoken, Boolean(blob));
            setResult((r) => r && { ...r, spokenSeconds: round.spokenSeconds ?? r.spokenSeconds, reachedTarget: Boolean(round.reachedTarget), savedOnServer: true });
            void mutateSummary();
        } catch {
            // the local result stays visible; it is simply not counted in the history
        }
    }, [draw, item, prefs.muted, recorder.stop, recorder.release, mutateSummary, vi]);

    const advance = useCallback(() => {
        const clock = clockRef.current;
        const step = planRef.current[stepIndex];
        if (clock && step?.kind === "speak") spokenMsRef.current += elapsedMs(clock, performance.now());
        if (stepIndex + 1 < planRef.current.length) {
            const next = planRef.current[stepIndex + 1];
            if (step?.kind === "speak" && next.kind === "speak") setAnnounce(L(`Câu ${next.question + 1}`, `Question ${next.question + 1}`));
            startStep(stepIndex + 1);
        } else {
            clockRef.current = null;
            void finishRound(false);
        }
    }, [stepIndex, startStep, finishRound, vi]);

    const finishEarly = () => {
        const clock = clockRef.current;
        const step = planRef.current[stepIndex];
        if (clock && step?.kind === "speak") spokenMsRef.current += elapsedMs(clock, performance.now());
        clockRef.current = null;
        void finishRound(true);
    };

    const beginRound = useCallback(async (withRecording: boolean) => {
        if (!item || !draw?.drawId) return;
        setMicNotice(null);
        if (withRecording) {
            setPhase("mic");
            const ok = await recorder.prepare();
            if (!ok) {
                setMicNotice(typeof MediaRecorder === "undefined" ? "unsupported" : "denied");
                setPhase("revealed");
                return;
            }
        }
        recordingRoundRef.current = withRecording;
        const plan = buildPlan(item.style, prefs.settings, item.questions.length);
        planRef.current = plan;
        spokenMsRef.current = 0;
        startedRef.current = true;
        setPhase("running");
        setInterruption(null);
        startStep(0);
        speakingTopicApi.start(draw.drawId, targetSeconds(item.style, plan)).catch(() => undefined);
    }, [item, draw, prefs.settings, recorder.prepare, startStep]);

    const interrupt = useCallback((reason: "paused" | "hidden") => {
        if (!clockRef.current) return;
        clockRef.current = pauseClock(clockRef.current, performance.now());
        recorder.pause();
        setInterruption(reason);
        setPhase("interrupted");
    }, [recorder.pause]);

    const resume = () => {
        if (!clockRef.current) return;
        clockRef.current = resumeClock(clockRef.current, performance.now());
        if (planRef.current[stepIndex]?.kind === "speak" && recordingRoundRef.current) recorder.startOrResume();
        setInterruption(null);
        setPhase("running");
    };

    // the frame clock: rAF while visible plus a coarse interval, both only READ the monotonic clock
    useEffect(() => {
        if (phase !== "running") return;
        let frame = 0;
        const tick = () => {
            const t = performance.now();
            const clock = clockRef.current;
            if (clock) {
                const left = Math.ceil(remainingMs(clock, t) / 1000);
                const step = planRef.current[stepIndex];
                if (left <= 3 && left > 0 && lastTickRef.current !== left && step?.kind !== "prep") {
                    lastTickRef.current = left;
                    playCue("tick", prefs.muted);
                }
                if (isDone(clock, t)) { advance(); return; }
            }
            setNow(t);
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        const coarse = setInterval(() => setNow(performance.now()), 250);
        return () => { cancelAnimationFrame(frame); clearInterval(coarse); };
    }, [phase, stepIndex, advance, prefs.muted]);

    // leaving the tab interrupts the round instead of letting a hidden timer finish it silently
    useEffect(() => {
        const onVisibility = () => { if (document.hidden && phase === "running") interrupt("hidden"); };
        document.addEventListener("visibilitychange", onVisibility);
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, [phase, interrupt]);

    // a microphone that disappears mid-round: keep the round, tell the truth about the recording
    const recorderLost = recorder.status === "lost";

    const toggleFavorite = async (target: TopicItem) => {
        if (favBusy) return;
        setFavBusy(true);
        const on = !favorites.has(target.id);
        try {
            await speakingTopicApi.favorite(target.id, on);
            await mutateSummary();
        } catch { /* unchanged */ } finally {
            setFavBusy(false);
        }
    };

    // ── derived view values ───────────────────────────────────
    const step = planRef.current[stepIndex];
    const clock = clockRef.current;
    const remaining = clock ? remainingMs(clock, now || performance.now()) : 0;
    const progress = clock ? remaining / clock.durationMs : 1;
    const focusMode = phase === "running" || phase === "interrupted" || phase === "finishing";
    const currentQuestion = item ? item.questions[Math.min(step?.question ?? 0, item.questions.length - 1)] : "";
    const part2SpeakElapsed = step?.minMs && clock ? elapsedMs(clock, now || performance.now()) : 0;

    const familyTabs: { key: Family; vi: string; en: string; hintVi: string; hintEn: string }[] = [
        { key: "QUICK", vi: "Nói ngay", en: "Speak now", hintVi: "Rút câu, nói liền", hintEn: "Draw and speak at once" },
        { key: "DEEP", vi: "Tư duy sâu", en: "Deep thinking", hintVi: "Chủ đề khó, có thời gian nghĩ", hintEn: "Harder topics, thinking time" },
        { key: "IELTS", vi: "IELTS Speaking", en: "IELTS Speaking", hintVi: "Part 1 · 2 · 3", hintEn: "Part 1 · 2 · 3" },
    ];
    const bandOptions: { key: TopicBand | null; vi: string; en: string }[] = [
        { key: null, vi: "Mọi trình độ", en: "All levels" },
        ...(prefs.family === "QUICK" ? [{ key: "BASIC" as TopicBand, vi: "Cơ bản", en: "Basic" }] : []),
        { key: "INTERMEDIATE", vi: "Trung cấp", en: "Intermediate" },
        { key: "ADVANCED", vi: "Nâng cao", en: "Advanced" },
    ];
    const locked = phase === "drawing" || focusMode || phase === "mic";

    const pill = (active: boolean) =>
        `px-3 py-1.5 rounded-full text-xs font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 ${
            active ? "bg-amber-200 text-slate-900 shadow-sm" : "bg-white/8 text-indigo-100 hover:bg-white/15 border border-white/10"}`;
    const selectCls = "rounded-full bg-white/10 border border-white/15 text-indigo-50 text-xs font-semibold px-3 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50 cursor-pointer";
    const primaryBtn = "inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-b from-amber-200 to-amber-300 text-slate-900 font-bold px-6 py-3 min-h-11 shadow-[0_10px_30px_-10px_rgba(243,212,139,0.8)] hover:from-amber-100 hover:to-amber-200 active:scale-[0.98] transition cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";
    const ghostBtn = "inline-flex items-center justify-center gap-2 rounded-full border border-white/20 bg-white/5 text-indigo-50 font-semibold px-5 py-3 min-h-11 hover:bg-white/12 transition cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300";

    return (
        <section className="space-y-6" aria-labelledby="topic-studio-heading">
            {/* heading + honest practice facts */}
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
                <div>
                    <h2 id="topic-studio-heading" className="text-2xl sm:text-3xl font-extrabold tracking-tight text-gray-900 dark:text-white">
                        {L("Nói theo chủ đề", "Topic Speaking")}
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1.5 max-w-2xl leading-relaxed">
                        {L("Rút một câu hỏi bất ngờ, tự suy nghĩ và nói tiếng Anh theo thời gian. Không gợi ý, không câu mẫu — chỉ có bạn và chiếc đồng hồ.",
                            "Draw a surprise question, think for yourself and speak English against the clock. No hints, no model answers — just you and the timer.")}
                    </p>
                </div>
                {summary && (
                    <dl className="grid grid-cols-3 gap-2 text-center shrink-0" aria-label={L("Thống kê luyện tập", "Practice statistics")}>
                        {[
                            { v: summary.roundsFinished, l: L("lượt đã nói", "rounds spoken") },
                            { v: summary.distinctTopicsSpoken, l: L("chủ đề khác nhau", "distinct topics") },
                            { v: formatElapsed(summary.spokenSeconds * 1000), l: L("thời gian đã nói", "time spoken") },
                        ].map((s) => (
                            <div key={s.l} className="rounded-2xl bg-slate-50 dark:bg-gray-900/60 border border-gray-200/80 dark:border-gray-800 px-3 py-2 min-w-[86px]">
                                <dd className="text-lg font-extrabold text-indigo-700 dark:text-indigo-300 tabular-nums">{s.v}</dd>
                                <dt className="text-[11px] text-gray-500 dark:text-gray-400 leading-tight">{s.l}</dt>
                            </div>
                        ))}
                    </dl>
                )}
            </div>

            <div className={`${styles.stage} p-3.5 sm:p-6 lg:p-8`} data-testid="topic-stage" data-phase={phase}>
                <p className="sr-only" aria-live="polite">{announce}</p>

                {/* controls */}
                <div className="relative flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div role="tablist" aria-label={L("Kiểu luyện", "Practice style")} className="flex flex-wrap gap-1.5 rounded-full bg-black/20 p-1 border border-white/10">
                            {familyTabs.map((t) => (
                                <button
                                    key={t.key}
                                    role="tab"
                                    aria-selected={prefs.family === t.key}
                                    disabled={locked && prefs.family !== t.key}
                                    onClick={() => changeFamily(t.key)}
                                    title={vi ? t.hintVi : t.hintEn}
                                    className={`rounded-full px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-bold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 ${
                                        prefs.family === t.key ? "bg-white text-indigo-950 shadow" : "text-indigo-100 hover:bg-white/10"}`}
                                >
                                    {vi ? t.vi : t.en}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => updatePrefs({ record: !prefs.record })}
                                disabled={locked}
                                aria-pressed={prefs.record}
                                className={`${pill(prefs.record)} inline-flex items-center gap-1.5`}
                            >
                                {prefs.record ? <Mic size={14} /> : <MicOff size={14} />}
                                {prefs.record ? L("Ghi âm để tự nghe lại", "Record to replay") : L("Không ghi âm", "No recording")}
                            </button>
                            <button
                                type="button"
                                onClick={() => updatePrefs({ muted: !prefs.muted })}
                                aria-pressed={!prefs.muted}
                                aria-label={prefs.muted ? L("Bật âm hiệu", "Turn sound cues on") : L("Tắt âm hiệu", "Turn sound cues off")}
                                className={`${pill(!prefs.muted)} inline-flex items-center`}
                            >
                                {prefs.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                            </button>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        {prefs.family === "IELTS" && (
                            <div role="radiogroup" aria-label="IELTS part" className="flex gap-1.5">
                                {(["IELTS1", "IELTS2", "IELTS3"] as const).map((p, i) => (
                                    <button key={p} role="radio" aria-checked={prefs.part === p} disabled={locked}
                                        onClick={() => { if (draw && !startedRef.current && draw.drawId) pendingSkipRef.current = draw.drawId; setDraw(null); reset(); setPhase("idle"); setMachine("idle"); updatePrefs({ part: p }); }}
                                        className={pill(prefs.part === p)}>
                                        Part {i + 1}
                                    </button>
                                ))}
                            </div>
                        )}
                        <label className="sr-only" htmlFor="topic-category">{L("Chủ đề", "Topic")}</label>
                        <select id="topic-category" className={selectCls} disabled={locked} value={category ?? ""}
                            onChange={(e) => updatePrefs({ category: e.target.value || null })}>
                            <option value="" className="text-slate-900">{L("Tổng hợp mọi chủ đề", "All topics (mixed)")}</option>
                            {(styleCatalog?.categories ?? []).map((c) => (
                                <option key={c.key} value={c.key} className="text-slate-900">{vi ? c.vi : c.en} ({c.count})</option>
                            ))}
                        </select>
                        {(prefs.family === "QUICK" || prefs.family === "DEEP") && (
                            <div role="radiogroup" aria-label={L("Độ khó", "Difficulty")} className="flex flex-wrap gap-1.5">
                                {bandOptions.map((b) => (
                                    <button key={b.key ?? "all"} role="radio" aria-checked={prefs.band === b.key} disabled={locked}
                                        onClick={() => updatePrefs({ band: b.key })} className={pill(prefs.band === b.key)}>
                                        {vi ? b.vi : b.en}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs text-indigo-200/90">
                        {prefs.family === "QUICK" && (
                            <>
                                <span className="font-semibold">{L("Thời gian nói", "Speaking time")}:</span>
                                {PRESETS.quickSpeak.map((s) => (
                                    <button key={s} disabled={locked} onClick={() => updatePrefs({ settings: { ...prefs.settings, quickSeconds: s } })}
                                        className={pill(prefs.settings.quickSeconds === s)} aria-pressed={prefs.settings.quickSeconds === s}>
                                        {secondsLabel(s, vi)}
                                    </button>
                                ))}
                                <label className="inline-flex items-center gap-1.5 ml-1 cursor-pointer">
                                    <input type="checkbox" className="accent-amber-300 w-4 h-4" disabled={locked}
                                        checked={prefs.settings.readyCountdown}
                                        onChange={(e) => updatePrefs({ settings: { ...prefs.settings, readyCountdown: e.target.checked } })} />
                                    {L("Đếm ngược 3 giây", "3-second countdown")}
                                </label>
                            </>
                        )}
                        {prefs.family === "DEEP" && (
                            <>
                                <label htmlFor="deep-prep" className="font-semibold">{L("Chuẩn bị", "Thinking time")}</label>
                                <select id="deep-prep" className={selectCls} disabled={locked} value={prefs.settings.deepPrepSeconds}
                                    onChange={(e) => updatePrefs({ settings: { ...prefs.settings, deepPrepSeconds: Number(e.target.value) } })}>
                                    {PRESETS.deepPrep.map((s) => <option key={s} value={s} className="text-slate-900">{s === 0 ? L("Không chuẩn bị", "None") : secondsLabel(s, vi)}</option>)}
                                </select>
                                <label htmlFor="deep-speak" className="font-semibold ml-1">{L("Thời gian nói", "Speaking time")}</label>
                                <select id="deep-speak" className={selectCls} disabled={locked} value={prefs.settings.deepSpeakSeconds}
                                    onChange={(e) => updatePrefs({ settings: { ...prefs.settings, deepSpeakSeconds: Number(e.target.value) } })}>
                                    {PRESETS.deepSpeak.map((s) => <option key={s} value={s} className="text-slate-900">{secondsLabel(s, vi)}</option>)}
                                </select>
                            </>
                        )}
                        {prefs.family === "IELTS" && prefs.part === "IELTS2" && (
                            <span>{L("Định dạng Part 2: 1 phút chuẩn bị, nói 1–2 phút.", "Part 2 format: 1 minute to prepare, speak for 1–2 minutes.")}</span>
                        )}
                        {prefs.family === "IELTS" && prefs.part !== "IELTS2" && (
                            <>
                                <span className="font-semibold">{L("Mỗi câu trả lời", "Per answer")}:</span>
                                {(prefs.part === "IELTS1" ? PRESETS.part1Answer : PRESETS.part3Answer).map((s) => {
                                    const key = prefs.part === "IELTS1" ? "part1Seconds" : "part3Seconds";
                                    return (
                                        <button key={s} disabled={locked} aria-pressed={prefs.settings[key] === s}
                                            onClick={() => updatePrefs({ settings: { ...prefs.settings, [key]: s } })} className={pill(prefs.settings[key] === s)}>
                                            {secondsLabel(s, vi)}
                                        </button>
                                    );
                                })}
                            </>
                        )}
                    </div>
                </div>

                {/* stage body */}
                <div className={`relative mt-6 grid gap-6 items-center ${focusMode || phase === "finished" ? "grid-cols-1" : "md:grid-cols-[minmax(200px,260px)_1fr]"}`}>
                    {!(focusMode || phase === "finished") && (
                        <div className="flex flex-col items-center gap-4">
                            <div className={`${phase === "idle" || phase === "drawing" ? "w-[150px] min-[420px]:w-[190px]" : "w-[112px] min-[420px]:w-[150px]"} sm:w-[230px] transition-[width] duration-300`}>
                                <CapsuleMachine state={machine} color={capsuleColor(item?.category)} width={230} />
                            </div>
                        </div>
                    )}

                    <div className="min-w-0">
                        {phase === "idle" && (
                            <div className="text-center md:text-left space-y-5">
                                <p className="text-[11px] font-bold tracking-[0.3em] text-amber-200/80 uppercase">{L("Sẵn sàng", "Ready")}</p>
                                <p className={`${styles.display} text-3xl min-[420px]:text-4xl sm:text-5xl font-semibold leading-tight text-white`}>
                                    {L("Hôm nay bạn sẽ nói về điều gì?", "What will you talk about today?")}
                                </p>
                                <p className="text-sm text-indigo-200/80 max-w-xl">
                                    {prefs.family === "QUICK" && L("Câu hỏi xuất hiện — bạn nói ngay. Không cần chuẩn bị, chỉ cần bắt đầu.", "The question appears — you speak right away. No preparation, just begin.")}
                                    {prefs.family === "DEEP" && L("Chủ đề khó hơn, có thời gian suy nghĩ. Ứng dụng không đưa luận điểm hay dàn ý — bạn tự xây dựng câu trả lời.", "Harder topics with thinking time. The app gives no arguments or outlines — you build the answer yourself.")}
                                    {prefs.family === "IELTS" && L("Luyện tập theo định dạng IELTS Speaking. Đây là bài tự luyện, không phải bài thi chính thức và không chấm điểm.", "Practice in the IELTS Speaking format. This is self-practice, not an official test, and nothing is scored.")}
                                </p>
                                <button type="button" onClick={() => void runDraw({})} className={primaryBtn} data-testid="topic-spin">
                                    <Dices size={18} /> {L("Quay chủ đề", "Spin a topic")}
                                </button>
                            </div>
                        )}

                        {phase === "drawing" && (
                            <div className="text-center md:text-left space-y-5" aria-busy="true">
                                <p className="text-[11px] font-bold tracking-[0.3em] text-amber-200/80 uppercase">{L("Đang rút…", "Drawing…")}</p>
                                <p className={`${styles.display} ${styles.drawingWord} text-4xl sm:text-5xl font-semibold text-white/90 min-h-[3.5rem]`}>
                                    {drawingLabel || "…"}
                                </p>
                                <button type="button" disabled className={primaryBtn}><Dices size={18} /> {L("Đang quay…", "Spinning…")}</button>
                            </div>
                        )}

                        {(phase === "revealed" || phase === "mic") && item && (
                            <div className={`${styles.reveal} space-y-5`}>
                                <QuestionCard item={item} vi={vi} questionRef={questionRef} showDefinition={showDefinition}
                                    onToggleDefinition={() => setShowDefinition((s) => !s)} questionIndex={0} />
                                {micNotice && (
                                    <div role="alert" className="rounded-2xl border border-amber-300/40 bg-amber-300/10 p-4 text-sm text-amber-50 flex gap-3">
                                        <AlertTriangle size={18} className="shrink-0 mt-0.5 text-amber-300" />
                                        <div className="space-y-2">
                                            <p>{micNotice === "unsupported"
                                                ? L("Trình duyệt này không hỗ trợ ghi âm. Bạn vẫn có thể luyện nói theo thời gian mà không ghi âm.", "This browser cannot record. You can still do the timed round without recording.")
                                                : L("Chưa có quyền dùng micro. Bạn có thể cho phép micro trong cài đặt trình duyệt, hoặc nói không ghi âm.", "Microphone access was not granted. Allow it in your browser settings, or speak without recording.")}</p>
                                            <div className="flex flex-wrap gap-2">
                                                <button type="button" className={ghostBtn} onClick={() => void beginRound(false)}><Play size={15} /> {L("Nói không ghi âm", "Speak without recording")}</button>
                                                {micNotice === "denied" && <button type="button" className={ghostBtn} onClick={() => void beginRound(true)}><RotateCcw size={15} /> {L("Thử lại micro", "Try the microphone again")}</button>}
                                            </div>
                                        </div>
                                    </div>
                                )}
                                <div className="flex flex-wrap gap-3">
                                    <button type="button" className={primaryBtn} data-testid="topic-start" disabled={phase === "mic"}
                                        onClick={() => void beginRound(prefs.record)}>
                                        {phase === "mic" ? <Mic size={18} className="animate-pulse" /> : <Play size={18} />}
                                        {phase === "mic" ? L("Đang mở micro…", "Opening microphone…")
                                            : item.style === "IELTS2" ? L("Bắt đầu 1 phút chuẩn bị", "Start 1-minute preparation")
                                            : item.style === "DEEP" && prefs.settings.deepPrepSeconds > 0 ? L("Bắt đầu suy nghĩ", "Start thinking time")
                                            : L("Bắt đầu nói", "Start speaking")}
                                    </button>
                                    <button type="button" className={ghostBtn} onClick={() => void runDraw({})} disabled={phase === "mic"}>
                                        <Dices size={16} /> {L("Đổi chủ đề", "Change topic")}
                                    </button>
                                    <FavoriteButton on={favorites.has(item.id)} busy={favBusy} vi={vi} onClick={() => void toggleFavorite(item)} />
                                </div>
                                {draw && draw.poolSize > 1 && (
                                    <p className="text-[11px] text-indigo-200/70">
                                        {L(`Còn ${draw.unseenRemaining} câu bạn chưa gặp trong lựa chọn này.`, `${draw.unseenRemaining} questions you have not seen remain in this selection.`)}
                                    </p>
                                )}
                            </div>
                        )}

                        {focusMode && item && step && (
                            <FocusView
                                item={item} vi={vi} step={step} stepIndex={stepIndex} plan={planRef.current}
                                question={currentQuestion} remaining={remaining} progress={progress} paused={phase === "interrupted"}
                                interruption={interruption} finishing={phase === "finishing"} level={recorder.level}
                                recording={recorder.status === "recording"} recorderLost={recorderLost} recordWanted={recordingRoundRef.current}
                                part2Elapsed={part2SpeakElapsed}
                                onPause={canPause(item.style) ? () => interrupt("paused") : undefined}
                                onResume={resume} onAdvance={advance} onFinish={finishEarly}
                            />
                        )}

                        {phase === "finished" && item && result && (
                            <ResultView
                                item={item} vi={vi} result={result} favorite={favorites.has(item.id)} favBusy={favBusy}
                                onFavorite={() => void toggleFavorite(item)}
                                onRetry={() => void runDraw({ replayItemId: item.id, animate: false })}
                                onNext={() => void runDraw({})}
                                onFollowUp={item.followUpId ? () => void runDraw({ replayItemId: item.followUpId!, animate: false }) : undefined}
                            />
                        )}

                        {phase === "exhausted" && (
                            <Notice title={L("Bạn đã rút hết câu trong lựa chọn này", "You have drawn every question in this selection")}
                                body={L(`Tất cả ${exhaustedPool} câu phù hợp với bộ lọc hiện tại đều đã xuất hiện gần đây. Hãy mở rộng chủ đề hoặc độ khó, hoặc chủ động cho phép lặp lại các câu cũ nhất.`,
                                    `All ${exhaustedPool} questions matching the current filters appeared recently. Broaden the topic or level, or choose to repeat the oldest ones.`)}>
                                <button type="button" className={primaryBtn} onClick={() => { updatePrefs({ category: null, band: null }); setPhase("idle"); }}>
                                    {L("Mở rộng sang mọi chủ đề", "Broaden to all topics")}
                                </button>
                                <button type="button" className={ghostBtn} onClick={() => void runDraw({ allowReplay: true })}>
                                    <RotateCcw size={15} /> {L("Cho phép lặp lại câu cũ", "Allow repeats")}
                                </button>
                            </Notice>
                        )}
                        {phase === "empty" && (
                            <Notice title={L("Chưa có câu hỏi cho lựa chọn này", "No questions for this selection")}
                                body={L("Không có câu nào khớp với chủ đề và độ khó đã chọn. Hãy chọn chủ đề hoặc độ khó khác.", "No question matches this topic and level. Pick another topic or level.")}>
                                <button type="button" className={primaryBtn} onClick={() => { updatePrefs({ category: null, band: null }); setPhase("idle"); }}>
                                    {L("Đặt lại bộ lọc", "Reset filters")}
                                </button>
                            </Notice>
                        )}
                        {phase === "error" && (
                            <Notice title={L("Có lỗi xảy ra", "Something went wrong")} body={error ?? ""}>
                                <button type="button" className={primaryBtn} onClick={() => void runDraw({})}><RotateCcw size={16} /> {L("Thử lại", "Try again")}</button>
                            </Notice>
                        )}
                    </div>
                </div>

                <p className="relative mt-6 text-[11px] text-indigo-200/60 flex flex-wrap gap-x-4 gap-y-1">
                    <span>{L("Không dùng AI · không chấm điểm · không gợi ý câu trả lời", "No AI · no scoring · no answer hints")}</span>
                    <span>{L("Bản ghi âm chỉ nằm trong trình duyệt này và mất khi bạn rời trang", "Recordings stay in this browser and are gone when you leave the page")}</span>
                </p>
            </div>

            <HistoryPanel summary={summary ?? null} vi={vi} disabled={locked}
                onPractice={(it) => void runDraw({ replayItemId: it.id, animate: false })} />
        </section>
    );
}

// ── pieces ─────────────────────────────────────────────────────

function Chip({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "gold" }) {
    return (
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide ${
            tone === "gold" ? "bg-amber-200/15 text-amber-200 border border-amber-200/30" : "bg-white/10 text-indigo-100 border border-white/10"}`}>
            {children}
        </span>
    );
}

function styleLabel(style: TopicStyle, vi: boolean) {
    switch (style) {
        case "QUICK": return vi ? "Nói ngay" : "Speak now";
        case "DEEP": return vi ? "Tư duy sâu" : "Deep thinking";
        case "IELTS1": return "IELTS Part 1";
        case "IELTS2": return "IELTS Part 2";
        case "IELTS3": return "IELTS Part 3";
    }
}

function QuestionCard({ item, vi, questionRef, showDefinition, onToggleDefinition, questionIndex, compact = false }: {
    item: TopicItem; vi: boolean; questionRef?: React.RefObject<HTMLHeadingElement | null>; showDefinition: boolean;
    onToggleDefinition?: () => void; questionIndex: number; compact?: boolean;
}) {
    const isSet = item.style === "IELTS1" || item.style === "IELTS3";
    const text = item.questions[Math.min(questionIndex, item.questions.length - 1)];
    const chips = (
        <div className="flex flex-wrap gap-1.5">
            <Chip tone="gold">{styleLabel(item.style, vi)}</Chip>
            <Chip>{vi ? item.categoryVi : item.categoryEn}</Chip>
            {(item.style === "QUICK" || item.style === "DEEP") && <Chip>{vi ? `Ước lượng ${item.level}` : `Est. ${item.level}`}</Chip>}
            {isSet && <Chip>{vi ? `Câu ${questionIndex + 1}/${item.questions.length}` : `Question ${questionIndex + 1}/${item.questions.length}`}</Chip>}
        </div>
    );
    if (item.style === "IELTS2") {
        return (
            <div className="space-y-3">
                {chips}
                <article className="rounded-3xl bg-[#fbf6e9] text-slate-900 p-5 sm:p-7 shadow-[0_24px_50px_-28px_rgba(0,0,0,0.8)] border border-amber-100">
                    <p className="text-[10px] font-bold tracking-[0.25em] uppercase text-amber-700/80 mb-2">{vi ? "Thẻ chủ đề" : "Cue card"}</p>
                    <h3 ref={questionRef} tabIndex={-1} lang="en" className={`${styles.display} ${compact ? "text-xl sm:text-2xl" : "text-2xl sm:text-3xl"} font-semibold leading-snug focus:outline-none`}>
                        {text}
                    </h3>
                    <p className="mt-4 text-sm font-semibold text-slate-600" lang="en">You should say:</p>
                    <ul className="mt-1.5 space-y-1 text-[15px] sm:text-base leading-relaxed" lang="en">
                        {item.bullets.map((b) => <li key={b} className="flex gap-2"><span className="text-amber-600">•</span>{b}</li>)}
                    </ul>
                    {item.explain && <p className="mt-2 text-[15px] sm:text-base" lang="en">{item.explain}</p>}
                </article>
            </div>
        );
    }
    return (
        <div className={`${styles.card} p-5 sm:p-7 space-y-4`}>
            {chips}
            {isSet && item.title && <p className="text-sm font-semibold text-amber-200/90" lang="en">{item.title}</p>}
            <h3 ref={questionRef} tabIndex={-1} lang="en"
                className={`${styles.display} ${compact ? "text-xl min-[420px]:text-2xl sm:text-3xl" : "text-2xl min-[420px]:text-3xl sm:text-4xl"} font-semibold leading-tight text-white focus:outline-none break-words`}>
                {text}
            </h3>
            {item.definition && onToggleDefinition && (
                <div>
                    <button type="button" onClick={onToggleDefinition} aria-expanded={showDefinition}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-200 hover:text-white cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 rounded">
                        <BookOpen size={14} /> {vi ? `Giải thích thuật ngữ: ${item.definition.term}` : `Explain the term: ${item.definition.term}`}
                    </button>
                    {showDefinition && (
                        <div className="mt-2 rounded-2xl bg-black/25 border border-white/10 p-3.5 text-sm space-y-1.5">
                            <p lang="en" className="text-indigo-50"><strong>{item.definition.term}</strong> — {item.definition.en}</p>
                            <p lang="vi" className="text-indigo-200/90">{item.definition.vi}</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function TimerRing({ remaining, progress, label, tone, size = 180, marker }: {
    remaining: number; progress: number; label: string; tone: "speak" | "prep" | "ready" | "warn"; size?: number; marker?: number;
}) {
    const r = 46;
    const c = 2 * Math.PI * r;
    const stroke = tone === "warn" ? "#fbbf24" : tone === "prep" ? "#a5b4fc" : tone === "ready" ? "#f3d48b" : "#f3d48b";
    return (
        <div className={`relative ${tone === "warn" ? styles.pulse : ""}`} style={{ width: size, height: size }} role="timer" aria-label={`${label} ${formatCountdown(remaining)}`}>
            <svg viewBox="0 0 100 100" className={`${styles.ring} w-full h-full -rotate-90`} aria-hidden="true">
                <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="6" />
                <circle cx="50" cy="50" r={r} fill="none" stroke={stroke} strokeWidth="6" strokeLinecap="round"
                    strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, progress)))} />
                {marker != null && (
                    <line x1="50" y1="2" x2="50" y2="10" stroke="#ffffff" strokeWidth="2"
                        transform={`rotate(${marker * 360} 50 50)`} opacity="0.8" />
                )}
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true">
                <span className="text-[10px] font-bold tracking-[0.2em] uppercase text-indigo-200/80">{label}</span>
                <span className="font-mono tabular-nums font-bold text-white" style={{ fontSize: size * 0.22 }}>{formatCountdown(remaining)}</span>
            </div>
        </div>
    );
}

function LevelMeter({ level, active }: { level: number; active: boolean }) {
    const bars = 14;
    return (
        <div className="flex items-end gap-[3px] h-8" aria-hidden="true">
            {Array.from({ length: bars }, (_, i) => {
                // a centred bar shape; heights follow the real input level
                const weight = 1 - Math.abs(i - (bars - 1) / 2) / bars;
                const h = active ? Math.max(8, Math.min(100, level * 100 * (0.55 + weight))) : 8;
                return <span key={i} className={`${styles.meterBar} w-[4px] rounded-full bg-amber-200`} style={{ height: `${h}%`, opacity: active ? 0.9 : 0.3 }} />;
            })}
        </div>
    );
}

function FocusView(p: {
    item: TopicItem; vi: boolean; step: PlanStep; stepIndex: number; plan: PlanStep[]; question: string; remaining: number;
    progress: number; paused: boolean; interruption: "paused" | "hidden" | null; finishing: boolean; level: number; recording: boolean;
    recorderLost: boolean; recordWanted: boolean; part2Elapsed: number;
    onPause?: () => void; onResume: () => void; onAdvance: () => void; onFinish: () => void;
}) {
    const { item, vi, step } = p;
    const L = (v: string, e: string) => (vi ? v : e);
    const speaking = step.kind === "speak";
    const label = step.kind === "ready" ? L("Sẵn sàng", "Get set") : step.kind === "prep" ? L("Suy nghĩ", "Think") : L("Đang nói", "Speaking");
    const warn = speaking && p.remaining <= 10000;
    const isSet = item.style === "IELTS1" || item.style === "IELTS3";
    const lastStep = p.stepIndex === p.plan.length - 1;
    const minReached = !step.minMs || p.part2Elapsed >= step.minMs;
    const panelRef = useRef<HTMLDivElement>(null);
    // the timer must be on screen when a round begins (phones: the question card can push it away)
    useEffect(() => {
        panelRef.current?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    }, []);
    return (
        <div className="grid gap-6 lg:grid-cols-[1fr_auto] items-start">
            <div className="order-2 lg:order-1 min-w-0">
                <QuestionCard item={item} vi={vi} showDefinition={false} questionIndex={step.question} compact />
                {step.kind === "prep" && (
                    <p className="mt-3 text-sm text-indigo-200/80">
                        {item.style === "IELTS2"
                            ? L("Dùng 1 phút để tự suy nghĩ (có thể ghi chú ra giấy). Hết giờ, phần nói bắt đầu.", "Use the minute to think (paper notes are allowed). When it ends, speaking starts.")
                            : L("Tự suy nghĩ — ứng dụng không đưa gợi ý. Hết giờ, phần nói bắt đầu.", "Think on your own — no hints are given. When time is up, speaking starts.")}
                    </p>
                )}
            </div>
            <div ref={panelRef} className="order-1 lg:order-2 sticky top-2 lg:top-4 z-10 flex flex-col sm:flex-row lg:flex-col items-center gap-3 sm:gap-4 lg:gap-5 rounded-3xl bg-[#161238]/95 backdrop-blur border border-white/10 p-3 sm:p-5 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.8)]">
                <div className="shrink-0">
                    <div className="hidden sm:block">
                        <TimerRing remaining={p.remaining} progress={p.progress} label={label} tone={warn ? "warn" : step.kind === "speak" ? "speak" : step.kind}
                            marker={step.minMs ? step.minMs / step.ms : undefined} />
                    </div>
                    <div className="sm:hidden">
                        <TimerRing remaining={p.remaining} progress={p.progress} label={label} tone={warn ? "warn" : step.kind === "speak" ? "speak" : step.kind} size={112}
                            marker={step.minMs ? step.minMs / step.ms : undefined} />
                    </div>
                </div>
                <div className="flex flex-col gap-2.5 items-center sm:items-stretch min-w-0 w-full sm:w-auto sm:flex-1 lg:flex-none lg:w-full">
                    <div className="flex items-center justify-center sm:justify-start gap-2 text-xs text-indigo-100 min-h-8">
                        {p.recordWanted && !p.recorderLost && (
                            <>
                                <span className={`inline-block w-2.5 h-2.5 rounded-full ${p.recording ? "bg-rose-500 animate-pulse" : "bg-white/30"}`} aria-hidden="true" />
                                <span>{p.recording ? L("Đang ghi âm", "Recording") : speaking ? L("Ghi âm tạm dừng", "Recording paused") : L("Ghi âm khi bắt đầu nói", "Records when speaking starts")}</span>
                                <LevelMeter level={p.level} active={p.recording} />
                            </>
                        )}
                        {p.recorderLost && <span className="text-amber-200 flex items-center gap-1"><MicOff size={14} /> {L("Micro bị ngắt — vòng nói vẫn tiếp tục", "Microphone lost — the round continues")}</span>}
                        {!p.recordWanted && <span className="text-indigo-200/70">{L("Không ghi âm", "Not recording")}</span>}
                    </div>
                    {step.minMs && speaking && (
                        <p className="text-[11px] text-indigo-200/80">{minReached ? L("Đã nói đủ 1 phút — có thể kết thúc hoặc nói tiếp đến 2 phút.", "One minute reached — finish now or continue up to two minutes.") : L("Hãy cố nói ít nhất 1 phút.", "Try to speak for at least one minute.")}</p>
                    )}
                    {p.paused && (
                        <p role="status" className="text-xs text-amber-100 bg-amber-300/10 border border-amber-300/30 rounded-xl px-3 py-2">
                            {p.interruption === "hidden" ? L("Đã tạm dừng vì bạn rời khỏi trang. Thời gian không chạy khi bạn vắng mặt.", "Paused because you left the page. Time does not run while you are away.") : L("Đã tạm dừng.", "Paused.")}
                        </p>
                    )}
                    <div className="flex flex-wrap justify-center sm:justify-start gap-2">
                        {p.paused ? (
                            <button type="button" onClick={p.onResume} className="inline-flex items-center gap-1.5 rounded-full bg-amber-200 text-slate-900 font-bold px-4 py-2.5 min-h-11 whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
                                <Play size={15} /> {L("Tiếp tục", "Resume")}
                            </button>
                        ) : p.onPause && (
                            <button type="button" onClick={p.onPause} disabled={p.finishing} className="inline-flex items-center gap-1.5 rounded-full border border-white/20 text-indigo-50 font-semibold px-3.5 py-2.5 min-h-11 whitespace-nowrap hover:bg-white/10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">
                                <Pause size={15} /> {L("Tạm dừng", "Pause")}
                            </button>
                        )}
                        {step.kind !== "speak" && !p.paused && (
                            <button type="button" onClick={p.onAdvance} className="inline-flex items-center gap-1.5 rounded-full border border-white/20 text-indigo-50 font-semibold px-3.5 py-2.5 min-h-11 whitespace-nowrap hover:bg-white/10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">
                                <SkipForward size={15} /> {step.kind === "ready" ? L("Nói luôn", "Start now") : L("Nói ngay bây giờ", "Speak now")}
                            </button>
                        )}
                        {isSet && speaking && !lastStep && !p.paused && (
                            <button type="button" onClick={p.onAdvance} className="inline-flex items-center gap-1.5 rounded-full border border-white/20 text-indigo-50 font-semibold px-3.5 py-2.5 min-h-11 whitespace-nowrap hover:bg-white/10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">
                                {L("Câu tiếp", "Next question")} <ChevronRight size={15} />
                            </button>
                        )}
                        <button type="button" onClick={p.onFinish} disabled={p.finishing} data-testid="topic-finish"
                            className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/90 hover:bg-rose-500 text-white font-bold px-4 py-2.5 min-h-11 whitespace-nowrap cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
                            <Square size={14} className="fill-current" /> {p.finishing ? L("Đang lưu…", "Saving…") : L("Kết thúc", "Finish")}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function FavoriteButton({ on, busy, vi, onClick }: { on: boolean; busy: boolean; vi: boolean; onClick: () => void }) {
    return (
        <button type="button" onClick={onClick} disabled={busy} aria-pressed={on}
            aria-label={on ? (vi ? "Bỏ khỏi yêu thích" : "Remove from favourites") : (vi ? "Lưu vào yêu thích" : "Save to favourites")}
            className="inline-flex items-center justify-center w-11 h-11 rounded-full border border-white/20 bg-white/5 hover:bg-white/12 transition cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">
            <Heart size={17} className={on ? "fill-rose-400 text-rose-400" : "text-indigo-100"} />
        </button>
    );
}

function ResultView({ item, vi, result, favorite, favBusy, onFavorite, onRetry, onNext, onFollowUp }: {
    item: TopicItem; vi: boolean; result: Result; favorite: boolean; favBusy: boolean;
    onFavorite: () => void; onRetry: () => void; onNext: () => void; onFollowUp?: () => void;
}) {
    const L = (v: string, e: string) => (vi ? v : e);
    const ext = result.audioType?.includes("mp4") ? "m4a" : result.audioType?.includes("ogg") ? "ogg" : "webm";
    return (
        <div className={`${styles.reveal} space-y-6`} data-testid="topic-result">
            <div className="text-center space-y-2">
                <div className={`mx-auto w-14 h-14 rounded-full bg-amber-200/15 border border-amber-200/40 flex items-center justify-center ${styles.finishGlow}`}>
                    <Check size={26} className="text-amber-200" />
                </div>
                <p className={`${styles.display} text-3xl sm:text-4xl font-semibold text-white`}>
                    {result.reachedTarget ? L("Bạn đã nói trọn vòng!", "You spoke the whole round!") : L("Vòng nói đã kết thúc", "Round finished")}
                </p>
                <p className="text-sm text-indigo-200/80">
                    {result.reachedTarget
                        ? L("Mỗi lần tự nói là một lần tư duy mạnh hơn.", "Every round you speak on your own makes thinking on your feet easier.")
                        : L("Bạn dừng trước thời gian mục tiêu — lần sau thử nói lâu hơn một chút.", "You stopped before the target time — try speaking a little longer next time.")}
                </p>
            </div>
            <dl className="grid grid-cols-3 gap-2 sm:gap-3 max-w-xl mx-auto">
                {[
                    { l: L("Thời gian nói", "Time spoken"), v: formatElapsed(result.spokenSeconds * 1000) },
                    { l: L("Mục tiêu", "Target"), v: formatElapsed(result.targetSeconds * 1000) },
                    { l: L("Trạng thái", "Status"), v: result.reachedTarget ? L("Đủ giờ", "Reached") : L("Dừng sớm", "Stopped early") },
                ].map((s) => (
                    <div key={s.l} className="rounded-2xl bg-white/6 border border-white/10 px-2 py-3 text-center">
                        <dd className="text-lg sm:text-xl font-bold text-white tabular-nums">{s.v}</dd>
                        <dt className="text-[11px] text-indigo-200/80">{s.l}</dt>
                    </div>
                ))}
            </dl>
            <div className="max-w-xl mx-auto">
                <QuestionCard item={item} vi={vi} showDefinition={false} questionIndex={0} compact />
            </div>
            <div className="max-w-xl mx-auto rounded-2xl bg-black/20 border border-white/10 p-4 space-y-3">
                {result.audioUrl ? (
                    <>
                        <p className="text-xs font-semibold text-indigo-100">{L("Nghe lại giọng của bạn", "Listen to yourself")}</p>
                        <audio controls src={result.audioUrl} className="w-full" preload="metadata" />
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-indigo-200/70">
                            <span>{L("Bản ghi chỉ lưu tạm trên trình duyệt này, không gửi lên máy chủ.", "This recording stays in this browser only; it is not uploaded.")}</span>
                            <a href={result.audioUrl} download={`english-coach-speaking-${item.id.toLowerCase()}.${ext}`}
                                className="inline-flex items-center gap-1 font-semibold text-amber-200 hover:text-amber-100">
                                <Download size={13} /> {L("Tải về", "Download")}
                            </a>
                        </div>
                    </>
                ) : (
                    <p className="text-xs text-indigo-200/80">
                        {result.recordingFailed
                            ? L("Không thu được âm thanh trong vòng này (micro không gửi tín hiệu). Vòng nói vẫn được tính theo thời gian.", "No audio was captured in this round (the microphone sent nothing). The round still counts by time.")
                            : L("Vòng này không ghi âm.", "This round was not recorded.")}
                    </p>
                )}
            </div>
            <div className="flex flex-wrap justify-center gap-3">
                <button type="button" onClick={onNext} className="inline-flex items-center gap-2 rounded-full bg-gradient-to-b from-amber-200 to-amber-300 text-slate-900 font-bold px-6 py-3 min-h-11 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
                    <Dices size={17} /> {L("Rút câu mới", "Draw a new question")}
                </button>
                <button type="button" onClick={onRetry} className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 text-indigo-50 font-semibold px-5 py-3 min-h-11 hover:bg-white/12 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">
                    <RotateCcw size={16} /> {L("Nói lại câu này", "Try this question again")}
                </button>
                {onFollowUp && (
                    <button type="button" onClick={onFollowUp} className="inline-flex items-center gap-2 rounded-full border border-amber-200/40 bg-amber-200/10 text-amber-100 font-semibold px-5 py-3 min-h-11 hover:bg-amber-200/20 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">
                        {L("Sang Part 3 cùng chủ đề", "Continue to Part 3")} <ChevronRight size={16} />
                    </button>
                )}
                <FavoriteButton on={favorite} busy={favBusy} vi={vi} onClick={onFavorite} />
            </div>
            {!result.savedOnServer && (
                <p className="text-center text-[11px] text-indigo-200/60">{L("Đang lưu vào lịch sử luyện tập…", "Saving to your practice history…")}</p>
            )}
        </div>
    );
}

function Notice({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
    return (
        <div role="status" className="rounded-3xl border border-white/12 bg-white/5 p-6 space-y-3">
            <p className={`${styles.display} text-2xl font-semibold text-white`}>{title}</p>
            <p className="text-sm text-indigo-200/85 max-w-xl">{body}</p>
            <div className="flex flex-wrap gap-3 pt-1">{children}</div>
        </div>
    );
}

function HistoryPanel({ summary, vi, disabled, onPractice }: {
    summary: TopicSummary | null; vi: boolean; disabled: boolean; onPractice: (item: TopicItem) => void;
}) {
    const L = (v: string, e: string) => (vi ? v : e);
    const [tab, setTab] = useState<"recent" | "favorites">("recent");
    const rows = tab === "recent"
        ? (summary?.recent ?? []).map((r) => ({ key: `r${r.drawId}`, item: r.item, meta: r.spokenSeconds != null ? formatElapsed(r.spokenSeconds * 1000) : L("Chưa kết thúc", "Not finished") }))
        : (summary?.favorites ?? []).map((f) => ({ key: `f${f.id}`, item: f, meta: "" }));
    return (
        <div className="rounded-3xl border border-gray-200 dark:border-gray-800 bg-slate-50/70 dark:bg-gray-900/50 p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h3 className="text-base font-bold text-gray-900 dark:text-white flex items-center gap-2"><History size={17} /> {L("Lịch sử luyện nói", "Your speaking history")}</h3>
                <div role="tablist" className="flex gap-1 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-1">
                    {(["recent", "favorites"] as const).map((t) => (
                        <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                            className={`px-3 py-1.5 rounded-full text-xs font-semibold cursor-pointer ${tab === t ? "bg-indigo-600 text-white" : "text-gray-600 dark:text-gray-300"}`}>
                            {t === "recent" ? L("Gần đây", "Recent") : L("Yêu thích", "Favourites")}
                        </button>
                    ))}
                </div>
            </div>
            {summary == null ? (
                <p className="text-sm text-gray-400">{L("Đang tải…", "Loading…")}</p>
            ) : rows.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                    {tab === "recent" ? L("Chưa có vòng nói nào. Quay một chủ đề và bắt đầu nhé!", "No rounds yet. Spin a topic and start!") : L("Chưa có câu yêu thích. Nhấn ♥ trên một câu hỏi để lưu lại.", "No favourites yet. Tap ♥ on a question to save it.")}
                </p>
            ) : (
                <ul className="divide-y divide-gray-200 dark:divide-gray-800">
                    {rows.map((r) => (
                        <li key={r.key} className="py-2.5 flex items-center gap-3">
                            <span className="shrink-0 rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-[10px] font-bold px-2 py-0.5">{styleLabel(r.item.style, vi)}</span>
                            <span className="flex-1 min-w-0 text-sm text-gray-800 dark:text-gray-200 truncate" lang="en">{r.item.title ? `${r.item.title} — ` : ""}{r.item.questions[0]}</span>
                            {r.meta && <span className="shrink-0 text-xs text-gray-500 tabular-nums">{r.meta}</span>}
                            <button type="button" disabled={disabled} onClick={() => onPractice(r.item)}
                                className="shrink-0 inline-flex items-center gap-1 rounded-full border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-xs font-semibold text-gray-700 dark:text-gray-200 hover:border-indigo-400 cursor-pointer disabled:opacity-50">
                                <RotateCcw size={12} /> {L("Luyện lại", "Practise")}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {summary && summary.roundsFinished > 0 && (
                <p className="mt-3 text-[11px] text-gray-500 dark:text-gray-400">
                    {L(`${summary.roundsReachedTarget}/${summary.roundsFinished} vòng nói đủ thời gian mục tiêu · đã rút ${summary.topicsDrawn} chủ đề`,
                        `${summary.roundsReachedTarget}/${summary.roundsFinished} rounds reached their target time · ${summary.topicsDrawn} topics drawn`)}
                </p>
            )}
        </div>
    );
}
