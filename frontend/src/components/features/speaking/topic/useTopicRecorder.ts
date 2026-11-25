"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { selectSupportedRecorderMimeType } from "@/hooks/useAudioRecorder";

export type TopicRecorderStatus =
    | "off"
    | "requesting"
    | "ready"
    | "recording"
    | "paused"
    | "denied"
    | "unsupported"
    | "lost";

/**
 * Self-recording for "Nói theo chủ đề". The audio never leaves the browser: no upload, no transcription, no analysis.
 * The microphone is opened only by an explicit learner action ({@link prepare}). The level meter reads the real input
 * amplitude (RMS of the live signal) — it is never a decorative animation.
 */
export function useTopicRecorder() {
    const [status, setStatus] = useState<TopicRecorderStatus>("off");
    const levelRef = useRef(0);
    const [level, setLevel] = useState(0);
    const streamRef = useRef<MediaStream | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<BlobPart[]>([]);
    const contextRef = useRef<AudioContext | null>(null);
    const frameRef = useRef<number | null>(null);
    const stopResolveRef = useRef<((blob: Blob | null) => void) | null>(null);
    const micClaimedRef = useRef(false);
    const notifyModuleMic = useCallback((active: boolean) => {
        if (micClaimedRef.current === active) return;
        micClaimedRef.current = active;
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("ec:module-mic", { detail: { active, owner: "speaking" } }));
        }
    }, []);

    const stopMeter = useCallback(() => {
        if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
        levelRef.current = 0;
        setLevel(0);
    }, []);

    const release = useCallback(() => {
        stopMeter();
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== "inactive") {
            try { recorder.stop(); } catch { /* already stopped */ }
        }
        recorderRef.current = null;
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        void contextRef.current?.close().catch(() => undefined);
        contextRef.current = null;
        notifyModuleMic(false);
        setStatus((s) => (s === "denied" || s === "unsupported" ? s : "off"));
    }, [stopMeter, notifyModuleMic]);

    useEffect(() => release, [release]);

    /** Asks for the microphone (one explicit user action). Resolves true when recording can start. */
    const prepare = useCallback(async (): Promise<boolean> => {
        if (streamRef.current) return true;
        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
            setStatus("unsupported");
            return false;
        }
        setStatus("requesting");
        notifyModuleMic(true);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            streamRef.current = stream;
            stream.getAudioTracks().forEach((track) => {
                track.onended = () => {
                    notifyModuleMic(false);
                    setStatus((s) => (s === "recording" || s === "paused" ? "lost" : s));
                };
            });
            setStatus("ready");
            return true;
        } catch {
            notifyModuleMic(false);
            setStatus("denied");
            return false;
        }
    }, [notifyModuleMic]);

    const startMeter = useCallback((stream: MediaStream) => {
        try {
            const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            const ctx = new Ctx();
            contextRef.current = ctx;
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            ctx.createMediaStreamSource(stream).connect(analyser);
            const data = new Float32Array(analyser.fftSize);
            let last = 0;
            const tick = (t: number) => {
                analyser.getFloatTimeDomainData(data);
                let sum = 0;
                for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
                const rms = Math.sqrt(sum / data.length);
                // perceptual scale: quiet speech ≈ 0.02 RMS, loud ≈ 0.3
                levelRef.current = Math.min(1, Math.max(0, (Math.log10(rms + 1e-4) + 3.2) / 2.6));
                if (t - last > 66) { last = t; setLevel(levelRef.current); }
                frameRef.current = requestAnimationFrame(tick);
            };
            frameRef.current = requestAnimationFrame(tick);
        } catch {
            // the meter is optional; recording still works without it
        }
    }, []);

    const start = useCallback(() => {
        const stream = streamRef.current;
        if (!stream) return false;
        const mimeType = selectSupportedRecorderMimeType();
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
        recorder.onstop = () => {
            const blob = chunksRef.current.length ? new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" }) : null;
            stopResolveRef.current?.(blob && blob.size > 0 ? blob : null);
            stopResolveRef.current = null;
        };
        recorder.start(1000);
        recorderRef.current = recorder;
        startMeter(stream);
        setStatus("recording");
        return true;
    }, [startMeter]);

    const pause = useCallback(() => {
        const r = recorderRef.current;
        if (r && r.state === "recording") { r.pause(); setStatus("paused"); }
    }, []);

    const resume = useCallback(() => {
        const r = recorderRef.current;
        if (r && r.state === "paused") { r.resume(); setStatus("recording"); }
    }, []);

    /** Starts the recording on the first speaking step, or resumes it after a pause (no-op without a microphone). */
    const startOrResume = useCallback(() => {
        const r = recorderRef.current;
        if (r && r.state === "paused") { r.resume(); setStatus("recording"); return true; }
        if (!r && streamRef.current) return start();
        return Boolean(r);
    }, [start]);

    /** Stops and returns the recording; null when nothing was captured (never an empty "successful" file). */
    const stop = useCallback((): Promise<Blob | null> => {
        const r = recorderRef.current;
        if (!r || r.state === "inactive") {
            release();
            return Promise.resolve(chunksRef.current.length ? new Blob(chunksRef.current) : null);
        }
        return new Promise<Blob | null>((resolve) => {
            stopResolveRef.current = (blob) => {
                resolve(blob);
                release();
            };
            try { r.stop(); } catch { resolve(null); release(); }
        });
    }, [release]);

    return { status, level, prepare, start, startOrResume, pause, resume, stop, release };
}
