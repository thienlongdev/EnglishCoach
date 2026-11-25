"use client";

import { useState, useRef, useCallback, useEffect } from "react";

export type RecordingState =
    | "IDLE"
    | "REQUESTING_PERMISSION"
    | "RECORDING"
    | "REVIEWING"
    | "PROCESSING"
    | "ERROR";

export interface UseAudioRecorderOptions {
    maxDurationSeconds?: number;
    mimeType?: string;
    onMaxDurationReached?: () => void;
    onError?: (error: string) => void;
    onDataAvailable?: (chunk: Blob) => void;
    deviceId?: string;
    timeSliceMs?: number;
    /** Invalidates late MediaRecorder callbacks when the owning unit changes. */
    resetKey?: string | number;
    /**
     * When true, disables browser WebRTC DSP (AEC/NS/AGC), requests mono capture,
     * and sets 128 kbps bitrate when supported so high-frequency fricatives, final
     * stops, F0 pitch, and inter-syllabic stress energy are preserved for scoring.
     */
    assessmentMode?: boolean;
}

export interface UseAudioRecorderReturn {
    state: RecordingState;
    isRecording: boolean;
    isReviewing: boolean;
    isProcessing: boolean;
    isPlaying: boolean;
    duration: number; // recording duration in seconds
    formattedDuration: string; // "00:05"
    playbackCurrentTime: number; // current playback position in seconds
    playbackDuration: number; // duration of recorded audio in seconds
    playbackProgress: number; // 0.0 - 1.0
    audioBlob: Blob | null;
    audioUrl: string | null;
    error: string | null;
    /** Live normalized RMS microphone input level (0..1) while recording. */
    inputLevel: number;
    /** True if clipping was detected during the current/last recording. */
    isClipping: boolean;
    /** True once speech-level signal energy was detected in the current/last recording. */
    hasSpeechSignal: boolean;
    /** True only when the Web Audio AnalyserNode actually sampled in running state (not autoplay-suspended). */
    isMeteringActive: boolean;
    /** Peak normalized input level (0..1) observed in the current/last recording. */
    peakLevel: number;
    startRecording: () => Promise<void>;
    stopRecording: () => void;
    stopRecordingAsync: () => Promise<Blob | null>;
    cancelRecording: () => void;
    reset: () => void;
    setProcessing: (processing: boolean) => void;
    playAudio: () => void;
    pauseAudio: () => void;
    togglePlayback: () => void;
    seekPlayback: (seconds: number) => void;
}

export const MEDIA_RECORDER_MIME_CANDIDATES = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/webm",
    "audio/ogg",
] as const;

export function selectSupportedRecorderMimeType(preferred?: string): string {
    if (typeof MediaRecorder === "undefined") return "";
    const candidates = preferred
        ? [preferred, ...MEDIA_RECORDER_MIME_CANDIDATES.filter((value) => value !== preferred)]
        : [...MEDIA_RECORDER_MIME_CANDIDATES];
    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

/**
 * Format numeric seconds to MM:SS string
 */
export function formatTime(seconds: number): string {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || isNaN(seconds)) {
        return "00:00";
    }
    const totalSeconds = Math.floor(seconds);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

const getMonotonicNowMs = (): number =>
    typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();

export function useAudioRecorder(options: UseAudioRecorderOptions = {}): UseAudioRecorderReturn {
    const {
        maxDurationSeconds = 120,
        mimeType,
        onMaxDurationReached,
        onError,
        onDataAvailable,
        deviceId,
        timeSliceMs = 100,
        resetKey,
        assessmentMode = false,
    } = options;

    const [state, setState] = useState<RecordingState>("IDLE");
    const [duration, setDuration] = useState<number>(0);
    const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Live input metering state
    const [inputLevel, setInputLevel] = useState<number>(0);
    const [isClipping, setIsClipping] = useState<boolean>(false);
    const [hasSpeechSignal, setHasSpeechSignal] = useState<boolean>(false);
    const [isMeteringActive, setIsMeteringActive] = useState<boolean>(false);
    const [peakLevel, setPeakLevel] = useState<number>(0);

    // Playback review state
    const [isPlaying, setIsPlaying] = useState<boolean>(false);
    const [playbackCurrentTime, setPlaybackCurrentTime] = useState<number>(0);
    const [playbackDuration, setPlaybackDuration] = useState<number>(0);

    // Internal references
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<BlobPart[]>([]);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const startTimeRef = useRef<number>(0);
    const audioElementRef = useRef<HTMLAudioElement | null>(null);
    const createdUrlRef = useRef<string | null>(null);
    const recorderGenerationRef = useRef(0);
    const lastResetKeyRef = useRef(resetKey);
    const latestBlobRef = useRef<Blob | null>(null);
    const isStoppingRef = useRef<boolean>(false);
    const pendingStopResolversRef = useRef<Array<(blob: Blob | null) => void>>([]);

    // Metering references
    const audioContextRef = useRef<AudioContext | null>(null);
    const mediaSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const meterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const clipFramesRef = useRef<number>(0);
    const peakLevelRef = useRef<number>(0);
    const hasSpeechSignalRef = useRef<boolean>(false);
    const meteringActiveRef = useRef<boolean>(false);

    // Keep callback refs fresh so stop/max-duration always see latest closures
    const onMaxDurationReachedRef = useRef(onMaxDurationReached);
    const onErrorRef = useRef(onError);
    const onDataAvailableRef = useRef(onDataAvailable);
    useEffect(() => {
        onMaxDurationReachedRef.current = onMaxDurationReached;
    }, [onMaxDurationReached]);
    useEffect(() => {
        onErrorRef.current = onError;
    }, [onError]);
    useEffect(() => {
        onDataAvailableRef.current = onDataAvailable;
    }, [onDataAvailable]);

    const flushPendingStopResolvers = useCallback((blob: Blob | null) => {
        const resolvers = pendingStopResolversRef.current;
        if (resolvers.length === 0) return;
        pendingStopResolversRef.current = [];
        for (const resolve of resolvers) {
            try {
                resolve(blob);
            } catch {
                // Ignore resolver callback errors
            }
        }
    }, []);

    // Helper: stop Web Audio metering cleanly without audio feedback
    const stopMetering = useCallback(() => {
        if (meterTimerRef.current) {
            clearInterval(meterTimerRef.current);
            meterTimerRef.current = null;
        }
        if (mediaSourceRef.current) {
            try {
                mediaSourceRef.current.disconnect();
            } catch {
                // Ignore disconnect errors
            }
            mediaSourceRef.current = null;
        }
        if (analyserRef.current) {
            try {
                analyserRef.current.disconnect();
            } catch {
                // Ignore disconnect errors
            }
            analyserRef.current = null;
        }
        if (audioContextRef.current) {
            const ctx = audioContextRef.current;
            audioContextRef.current = null;
            try {
                if (ctx.state !== "closed") {
                    void ctx.close().catch(() => undefined);
                }
            } catch {
                // Ignore close errors
            }
        }
        setInputLevel(0);
    }, []);

    const resetMeteringMetrics = useCallback(() => {
        clipFramesRef.current = 0;
        peakLevelRef.current = 0;
        hasSpeechSignalRef.current = false;
        meteringActiveRef.current = false;
        setInputLevel(0);
        setIsClipping(false);
        setHasSpeechSignal(false);
        setIsMeteringActive(false);
        setPeakLevel(0);
    }, []);

    const startMetering = useCallback(
        (stream: MediaStream) => {
            stopMetering();
            resetMeteringMetrics();
            if (typeof window === "undefined") return;
            const AudioCtx =
                window.AudioContext ||
                (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AudioCtx) return;

            try {
                const ctx = new AudioCtx();
                if (ctx.state === "suspended" && typeof ctx.resume === "function") {
                    void ctx.resume().catch(() => undefined);
                }
                const source = ctx.createMediaStreamSource(stream);
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 256;
                analyser.smoothingTimeConstant = 0.25;
                source.connect(analyser);

                audioContextRef.current = ctx;
                mediaSourceRef.current = source;
                analyserRef.current = analyser;

                const floatBuf = new Float32Array(analyser.fftSize);
                const byteBuf = new Uint8Array(analyser.fftSize);

                meterTimerRef.current = setInterval(() => {
                    const currentCtx = audioContextRef.current;
                    const currentAnalyser = analyserRef.current;
                    if (!currentAnalyser || !currentCtx) return;

                    // If browser autoplay/permission prompt left AudioContext suspended, do NOT sample zeros
                    // as silence and do NOT mark metering active (avoiding false client-side silence blocks).
                    if (currentCtx.state !== "running") {
                        if (currentCtx.state === "suspended" && typeof currentCtx.resume === "function") {
                            void currentCtx.resume().catch(() => undefined);
                        }
                        return;
                    }
                    if (!meteringActiveRef.current) {
                        meteringActiveRef.current = true;
                        setIsMeteringActive(true);
                    }

                    let sumSq = 0;
                    let maxAbs = 0;
                    let consecutiveClip = 0;
                    let maxConsecutiveClip = 0;

                    if (typeof currentAnalyser.getFloatTimeDomainData === "function") {
                        currentAnalyser.getFloatTimeDomainData(floatBuf);
                        for (let i = 0; i < floatBuf.length; i++) {
                            const sample = Math.abs(floatBuf[i]);
                            sumSq += sample * sample;
                            if (sample > maxAbs) maxAbs = sample;
                            if (sample >= 0.985) {
                                consecutiveClip += 1;
                                if (consecutiveClip > maxConsecutiveClip) {
                                    maxConsecutiveClip = consecutiveClip;
                                }
                            } else {
                                consecutiveClip = 0;
                            }
                        }
                    } else {
                        currentAnalyser.getByteTimeDomainData(byteBuf);
                        for (let i = 0; i < byteBuf.length; i++) {
                            const sample = Math.abs((byteBuf[i] - 128) / 128);
                            sumSq += sample * sample;
                            if (sample > maxAbs) maxAbs = sample;
                            if (sample >= 0.985) {
                                consecutiveClip += 1;
                                if (consecutiveClip > maxConsecutiveClip) {
                                    maxConsecutiveClip = consecutiveClip;
                                }
                            } else {
                                consecutiveClip = 0;
                            }
                        }
                    }

                    const rms = Math.sqrt(sumSq / floatBuf.length);
                    const normalized = Math.min(1, rms * 4.5);
                    setInputLevel(normalized);

                    if (normalized > peakLevelRef.current) {
                        peakLevelRef.current = normalized;
                        setPeakLevel(normalized);
                    }

                    if (!hasSpeechSignalRef.current && rms >= 0.004) {
                        hasSpeechSignalRef.current = true;
                        setHasSpeechSignal(true);
                    }

                    const frameClipped = maxConsecutiveClip >= 3 || maxAbs >= 0.995;
                    if (frameClipped) {
                        clipFramesRef.current += 1;
                        if (clipFramesRef.current >= 2) {
                            setIsClipping(true);
                        }
                    }
                }, 60);
            } catch {
                // Metering is best-effort; never fail recording if Web Audio is unavailable.
                stopMetering();
            }
        },
        [stopMetering, resetMeteringMetrics]
    );

    // Helper: stop all microphone media tracks to turn off recording indicator
    const micClaimedRef = useRef<boolean>(false);
    const notifyModuleMic = useCallback((active: boolean) => {
        if (micClaimedRef.current === active) return;
        micClaimedRef.current = active;
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("ec:module-mic", { detail: { active, owner: "speaking" } }));
        }
    }, []);

    const releaseMediaStream = useCallback(() => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => {
                try {
                    track.stop();
                } catch {
                    // Ignore track stopping errors
                }
            });
            streamRef.current = null;
        }
        notifyModuleMic(false);
    }, [notifyModuleMic]);

    // Helper: revoke object URL to prevent memory leaks
    const revokeAudioUrl = useCallback(() => {
        if (createdUrlRef.current) {
            try {
                URL.revokeObjectURL(createdUrlRef.current);
            } catch {
                // Ignore URL revoking errors
            }
            createdUrlRef.current = null;
        }
        setAudioUrl(null);
    }, []);

    // Helper: stop playback audio element
    const stopAudioPlayback = useCallback(() => {
        if (audioElementRef.current) {
            audioElementRef.current.pause();
            audioElementRef.current.currentTime = 0;
            audioElementRef.current = null;
        }
        setIsPlaying(false);
        setPlaybackCurrentTime(0);
    }, []);

    // Helper: stop timer
    const stopTimer = useCallback(() => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    // Clean up on component unmount
    useEffect(() => {
        return () => {
            recorderGenerationRef.current += 1;
            isStoppingRef.current = false;
            flushPendingStopResolvers(null);
            stopTimer();
            stopMetering();
            stopAudioPlayback();
            releaseMediaStream();
            revokeAudioUrl();
        };
    }, [flushPendingStopResolvers, stopTimer, stopMetering, stopAudioPlayback, releaseMediaStream, revokeAudioUrl]);

    // Stop recording and transition to REVIEWING
    const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            isStoppingRef.current = true;
            try {
                mediaRecorderRef.current.stop();
            } catch {
                isStoppingRef.current = false;
            }
        }
        stopTimer();
    }, [stopTimer]);

    // Start recording function
    const startRecording = useCallback(async () => {
        // Prevent starting if already recording or processing
        if (state === "RECORDING" || state === "PROCESSING") return;

        // A new recording supersedes every previous MediaRecorder callback.
        const recorderGeneration = ++recorderGenerationRef.current;
        isStoppingRef.current = false;
        flushPendingStopResolvers(null);

        // Reset previous state
        stopTimer();
        stopMetering();
        resetMeteringMetrics();
        stopAudioPlayback();
        releaseMediaStream();
        revokeAudioUrl();

        setError(null);
        latestBlobRef.current = null;
        setAudioBlob(null);
        setDuration(0);
        setPlaybackDuration(0);
        chunksRef.current = [];

        setState("REQUESTING_PERMISSION");

        try {
            if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
                throw new Error("Trình duyệt không hỗ trợ ghi âm audio.");
            }

            const audioConstraints: MediaTrackConstraints = assessmentMode
                ? {
                      deviceId: deviceId ? { exact: deviceId } : undefined,
                      echoCancellation: false,
                      noiseSuppression: false,
                      autoGainControl: false,
                      channelCount: 1,
                  }
                : {
                      deviceId: deviceId ? { exact: deviceId } : undefined,
                      echoCancellation: true,
                      noiseSuppression: true,
                      autoGainControl: true,
                  };

            const stream = (notifyModuleMic(true), await navigator.mediaDevices.getUserMedia({
                audio: audioConstraints,
            }));

            // Permission prompts can resolve after navigation/unmount. Do not
            // attach a late stream or revive recorder state for a stale unit.
            if (recorderGeneration !== recorderGenerationRef.current) {
                stream.getTracks().forEach((track) => {
                    try {
                        track.stop();
                    } catch {
                        // Ignore cleanup failures for an invalidated stream.
                    }
                });
                if (!streamRef.current) notifyModuleMic(false);
                return;
            }

            streamRef.current = stream;
            startMetering(stream);

            const support = Object.fromEntries(
                MEDIA_RECORDER_MIME_CANDIDATES.map((candidate) => [candidate, MediaRecorder.isTypeSupported(candidate)])
            );
            const selectedMime = selectSupportedRecorderMimeType(mimeType);

            const baseRecorderOptions: MediaRecorderOptions = selectedMime ? { mimeType: selectedMime } : {};
            const recorderOptions: MediaRecorderOptions = assessmentMode
                ? { ...baseRecorderOptions, audioBitsPerSecond: 128000 }
                : baseRecorderOptions;

            let recorder: MediaRecorder;
            try {
                recorder = new MediaRecorder(stream, recorderOptions);
            } catch {
                // Fallback if the browser rejects audioBitsPerSecond for the selected container
                recorder = new MediaRecorder(stream, baseRecorderOptions);
            }
            const recorderMimeType = recorder.mimeType || selectedMime;
            console.debug("shadowing_media_recorder", {
                supportedCandidates: support,
                selectedMimeType: selectedMime || "browser-default",
                recorderMimeType,
                assessmentMode,
            });

            recorder.ondataavailable = (event: BlobEvent) => {
                if (recorderGeneration !== recorderGenerationRef.current) return;
                if (event.data && event.data.size > 0) {
                    chunksRef.current.push(event.data);
                    onDataAvailableRef.current?.(event.data);
                }
            };

            recorder.onstop = () => {
                isStoppingRef.current = false;
                if (recorderGeneration !== recorderGenerationRef.current) {
                    flushPendingStopResolvers(null);
                    return;
                }
                stopTimer();
                stopMetering();
                releaseMediaStream();

                const finalElapsed = startTimeRef.current > 0 ? (getMonotonicNowMs() - startTimeRef.current) / 1000 : 0;
                const recordedSeconds = Number.isFinite(finalElapsed) && finalElapsed > 0 ? finalElapsed : 0;
                setDuration(recordedSeconds);
                setPlaybackDuration(recordedSeconds);

                if (chunksRef.current.length > 0) {
                    const chunkMimeType = chunksRef.current.find(
                        (chunk): chunk is Blob => chunk instanceof Blob && Boolean(chunk.type)
                    )?.type;
                    const blobType = recorderMimeType || chunkMimeType || "application/octet-stream";
                    const finalBlob = new Blob(chunksRef.current, { type: blobType });
                    console.debug("shadowing_audio_blob", {
                        blobType: finalBlob.type,
                        blobSize: finalBlob.size,
                        recorderMimeType,
                    });
                    const url = URL.createObjectURL(finalBlob);

                    createdUrlRef.current = url;
                    latestBlobRef.current = finalBlob;
                    setAudioBlob(finalBlob);
                    setAudioUrl(url);
                    setState("REVIEWING");
                    flushPendingStopResolvers(finalBlob);
                } else {
                    latestBlobRef.current = null;
                    setState("IDLE");
                    flushPendingStopResolvers(null);
                }
            };

            recorder.onerror = () => {
                isStoppingRef.current = false;
                if (recorderGeneration !== recorderGenerationRef.current) {
                    flushPendingStopResolvers(null);
                    return;
                }
                stopTimer();
                stopMetering();
                releaseMediaStream();
                const errText = "Lỗi khi đang ghi âm microphone.";
                setError(errText);
                setState("ERROR");
                flushPendingStopResolvers(null);
                onErrorRef.current?.(errText);
            };

            mediaRecorderRef.current = recorder;
            const effectiveTimeSliceMs =
                typeof timeSliceMs === "number" && Number.isFinite(timeSliceMs) && timeSliceMs > 0
                    ? Math.round(timeSliceMs)
                    : 100;
            recorder.start(effectiveTimeSliceMs);

            startTimeRef.current = getMonotonicNowMs();
            setState("RECORDING");

            // Setup timer interval with monotonic clock
            timerRef.current = setInterval(() => {
                if (recorderGeneration !== recorderGenerationRef.current) {
                    stopTimer();
                    return;
                }
                const elapsedSeconds = (getMonotonicNowMs() - startTimeRef.current) / 1000;
                setDuration(elapsedSeconds);

                if (elapsedSeconds >= maxDurationSeconds) {
                    stopTimer();
                    stopRecording();
                    onMaxDurationReachedRef.current?.();
                }
            }, 100);
        } catch (err: any) {
            // A permission prompt may reject after the owning sentence or
            // component has already been invalidated. Do not clean up or
            // publish that stale failure against the next recording.
            if (recorderGeneration !== recorderGenerationRef.current) return;
            isStoppingRef.current = false;
            stopTimer();
            stopMetering();
            releaseMediaStream();
            flushPendingStopResolvers(null);

            let friendlyMessage = "Không thể truy cập microphone.";
            if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
                friendlyMessage = "Quyền truy cập microphone bị từ chối. Vui lòng cấp quyền trong cài đặt trình duyệt để tiếp tục.";
            } else if (err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError") {
                friendlyMessage = "Không tìm thấy thiết bị microphone nào được kết nối.";
            } else if (err?.name === "NotReadableError" || err?.name === "TrackStartError") {
                friendlyMessage = "Microphone đang được ứng dụng khác sử dụng.";
            } else if (err?.message) {
                friendlyMessage = err.message;
            }

            setError(friendlyMessage);
            setState("ERROR");
            onErrorRef.current?.(friendlyMessage);
        }
    }, [
        state,
        mimeType,
        maxDurationSeconds,
        deviceId,
        timeSliceMs,
        assessmentMode,
        flushPendingStopResolvers,
        stopTimer,
        stopMetering,
        resetMeteringMetrics,
        startMetering,
        stopAudioPlayback,
        releaseMediaStream,
        revokeAudioUrl,
        stopRecording,
        notifyModuleMic,
    ]);

    const stopRecordingAsync = useCallback((): Promise<Blob | null> => {
        return new Promise((resolve) => {
            const recorder = mediaRecorderRef.current;
            if (recorder && recorder.state === "recording") {
                pendingStopResolversRef.current.push(resolve);
                isStoppingRef.current = true;
                stopTimer();
                try {
                    recorder.stop();
                } catch {
                    isStoppingRef.current = false;
                    flushPendingStopResolvers(null);
                }
                return;
            }
            if (isStoppingRef.current) {
                // Stop is already in flight (e.g. triggered by maxDurationSeconds);
                // wait for the canonical onstop handler to emit the exact Blob.
                pendingStopResolversRef.current.push(resolve);
                return;
            }
            stopTimer();
            resolve(latestBlobRef.current);
        });
    }, [flushPendingStopResolvers, stopTimer]);

    // Cancel recording and reset to IDLE immediately
    const cancelRecording = useCallback(() => {
        // Invalidate the onstop/onerror callbacks before stopping the native
        // recorder; browsers may dispatch those callbacks asynchronously.
        recorderGenerationRef.current += 1;
        isStoppingRef.current = false;
        flushPendingStopResolvers(null);
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            try {
                mediaRecorderRef.current.stop();
            } catch {
                // Ignore stop error
            }
        }
        stopTimer();
        stopMetering();
        resetMeteringMetrics();
        stopAudioPlayback();
        releaseMediaStream();
        revokeAudioUrl();
        chunksRef.current = [];
        latestBlobRef.current = null;
        setAudioBlob(null);
        setDuration(0);
        setPlaybackDuration(0);
        setError(null);
        setState("IDLE");
    }, [
        flushPendingStopResolvers,
        stopTimer,
        stopMetering,
        resetMeteringMetrics,
        stopAudioPlayback,
        releaseMediaStream,
        revokeAudioUrl,
    ]);

    // Reset everything back to IDLE
    const reset = useCallback(() => {
        cancelRecording();
    }, [cancelRecording]);

    // Shadowing changes its owning sentence without remounting this hook.
    // Reset the native recorder on that identity change so an old onstop event
    // cannot put a prior sentence's blob into the new sentence's review UI.
    useEffect(() => {
        if (lastResetKeyRef.current === resetKey) return;
        lastResetKeyRef.current = resetKey;
        cancelRecording();
    }, [cancelRecording, resetKey]);

    // Set processing state (e.g. while sending to backend AI gateway)
    const setProcessing = useCallback((processing: boolean) => {
        if (processing) {
            stopAudioPlayback();
            setState("PROCESSING");
        } else {
            setState((prev) => (prev === "PROCESSING" ? "REVIEWING" : prev));
        }
    }, [stopAudioPlayback]);

    // Audio Playback Controls for Review
    const playAudio = useCallback(() => {
        if (!audioUrl) return;

        if (!audioElementRef.current) {
            const audio = new Audio(audioUrl);

            audio.onloadedmetadata = () => {
                const dur = audio.duration;
                if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) {
                    setPlaybackDuration(dur);
                } else if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
                    setPlaybackDuration(duration);
                }
            };

            audio.ondurationchange = () => {
                const dur = audio.duration;
                if (typeof dur === "number" && Number.isFinite(dur) && dur > 0) {
                    setPlaybackDuration(dur);
                }
            };

            audio.ontimeupdate = () => {
                if (typeof audio.currentTime === "number" && Number.isFinite(audio.currentTime) && audio.currentTime >= 0) {
                    setPlaybackCurrentTime(audio.currentTime);
                }
            };

            audio.onended = () => {
                setIsPlaying(false);
                setPlaybackCurrentTime(0);
            };

            audio.onpause = () => {
                setIsPlaying(false);
            };

            audio.onplay = () => {
                setIsPlaying(true);
            };

            audioElementRef.current = audio;
        }

        audioElementRef.current.play().catch(() => {
            setIsPlaying(false);
        });
    }, [audioUrl, duration]);

    const pauseAudio = useCallback(() => {
        if (audioElementRef.current) {
            audioElementRef.current.pause();
            setIsPlaying(false);
        }
    }, []);

    const togglePlayback = useCallback(() => {
        if (isPlaying) {
            pauseAudio();
        } else {
            playAudio();
        }
    }, [isPlaying, pauseAudio, playAudio]);

    const seekPlayback = useCallback((seconds: number) => {
        if (audioElementRef.current && typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
            audioElementRef.current.currentTime = seconds;
            setPlaybackCurrentTime(seconds);
        }
    }, []);

    const safePlaybackDuration = (typeof playbackDuration === "number" && Number.isFinite(playbackDuration) && playbackDuration > 0)
        ? playbackDuration
        : 0;

    const safeRecordedDuration = (typeof duration === "number" && Number.isFinite(duration) && duration > 0)
        ? duration
        : 0;

    const effectiveDuration = safePlaybackDuration > 0 ? safePlaybackDuration : safeRecordedDuration;

    const safeCurrentTime = (typeof playbackCurrentTime === "number" && Number.isFinite(playbackCurrentTime) && playbackCurrentTime >= 0)
        ? playbackCurrentTime
        : 0;

    const playbackProgress = effectiveDuration > 0
        ? Math.min(1.0, safeCurrentTime / effectiveDuration)
        : 0;

    return {
        state,
        isRecording: state === "RECORDING",
        isReviewing: state === "REVIEWING",
        isProcessing: state === "PROCESSING",
        isPlaying,
        duration,
        formattedDuration: formatTime(duration),
        playbackCurrentTime,
        playbackDuration: effectiveDuration,
        playbackProgress,
        audioBlob,
        audioUrl,
        error,
        inputLevel,
        isClipping,
        hasSpeechSignal,
        isMeteringActive,
        peakLevel,
        startRecording,
        stopRecording,
        stopRecordingAsync,
        cancelRecording,
        reset,
        setProcessing,
        playAudio,
        pauseAudio,
        togglePlayback,
        seekPlayback,
    };
}
