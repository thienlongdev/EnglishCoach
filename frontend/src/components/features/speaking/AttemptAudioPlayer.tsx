"use client";

import React, { useEffect, useState, useRef } from "react";
import { apiClient } from "@/services/api-client";
import { Loader2, AlertCircle, Play, Pause } from "lucide-react";
import { finiteDurationOrNull, formatAudioTime } from "@/lib/audioDuration.mjs";

interface AttemptAudioPlayerProps {
    clientAttemptId: string;
}

export function AttemptAudioPlayer({ clientAttemptId }: AttemptAudioPlayerProps) {
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState<number | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const activeUrlRef = useRef<string | null>(null);
    const blobRef = useRef<Blob | null>(null);
    const decodedRef = useRef<boolean>(false);

    useEffect(() => {
        let isSubscribed = true;
        decodedRef.current = false;
        blobRef.current = null;

        const loadAudioBlob = async () => {
            if (!clientAttemptId) return;
            try {
                setLoading(true);
                setError(false);
                setDuration(null);
                setCurrentTime(0);
                setIsPlaying(false);
                const response = await apiClient.get<Blob>(
                    `/speaking/attempts/${encodeURIComponent(clientAttemptId)}/audio`,
                    { responseType: "blob" }
                );
                if (!isSubscribed) return;

                const blob = response.data;
                if (!blob || blob.size === 0) {
                    setError(true);
                    return;
                }

                blobRef.current = blob;

                // Revoke old object URL if any before creating and setting new URL
                if (activeUrlRef.current) {
                    URL.revokeObjectURL(activeUrlRef.current);
                    activeUrlRef.current = null;
                }
                const newUrl = URL.createObjectURL(blob);
                activeUrlRef.current = newUrl;
                setAudioUrl(newUrl);
            } catch (err) {
                if (isSubscribed) {
                    console.warn(`Could not load audio for attempt ${clientAttemptId}:`, err);
                    setError(true);
                }
            } finally {
                if (isSubscribed) {
                    setLoading(false);
                }
            }
        };

        loadAudioBlob();

        return () => {
            isSubscribed = false;
            blobRef.current = null;
            if (activeUrlRef.current) {
                URL.revokeObjectURL(activeUrlRef.current);
                activeUrlRef.current = null;
            }
        };
    }, [clientAttemptId]);

    const handleLoadedMetadata = () => {
        if (!audioRef.current) return;
        const audio = audioRef.current;
        const metaDuration = finiteDurationOrNull(audio.duration);
        if (metaDuration != null) {
            setDuration(metaDuration);
        } else if (duration == null) {
            // Chromium trick for WebM streams: seeking to a huge offset forces duration calculation
            const prevTime = audio.currentTime;
            audio.currentTime = 1e101;
            audio.ontimeupdate = () => {
                audio.ontimeupdate = null;
                const calcDuration = finiteDurationOrNull(audio.duration);
                if (calcDuration != null) {
                    setDuration(calcDuration);
                }
                audio.currentTime = prevTime;
            };
        }
    };

    const handleTimeUpdate = () => {
        if (audioRef.current && Number.isFinite(audioRef.current.currentTime)) {
            setCurrentTime(audioRef.current.currentTime);
        }
    };

    const handleEnded = () => {
        setIsPlaying(false);
        setCurrentTime(0);
        if (audioRef.current) {
            audioRef.current.currentTime = 0;
        }
    };

    const decodeDurationLazily = async () => {
        if (decodedRef.current || duration != null || !blobRef.current) return;
        decodedRef.current = true;
        try {
            const AudioCtxClass =
                window.AudioContext ||
                (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AudioCtxClass) return;
            const arrayBuffer = await blobRef.current.arrayBuffer();
            const audioCtx = new AudioCtxClass();
            try {
                const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
                if (decodedBuffer && Number.isFinite(decodedBuffer.duration) && decodedBuffer.duration > 0) {
                    setDuration(decodedBuffer.duration);
                }
            } finally {
                audioCtx.close().catch(() => {});
            }
        } catch (decodeErr) {
            console.debug("Web Audio lazy decodeAudioData fallback:", decodeErr);
        }
    };

    const togglePlay = () => {
        if (!audioRef.current) return;
        if (isPlaying) {
            audioRef.current.pause();
            setIsPlaying(false);
        } else {
            if (duration == null) {
                void decodeDurationLazily();
            }
            audioRef.current.play().then(() => {
                setIsPlaying(true);
            }).catch((e) => {
                console.warn("Audio play prevented:", e);
                setIsPlaying(false);
            });
        }
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newTime = parseFloat(e.target.value);
        setCurrentTime(newTime);
        if (audioRef.current) {
            audioRef.current.currentTime = newTime;
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500 py-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-600" />
                <span>Đang tải âm thanh...</span>
            </div>
        );
    }

    if (error || !audioUrl) {
        return (
            <div className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500 py-1 italic">
                <AlertCircle className="w-3.5 h-3.5 text-gray-400" />
                <span>Không có tệp ghi âm hoặc không thể phát</span>
            </div>
        );
    }

    const safeDuration = duration && duration > 0 ? duration : 0;

    return (
        <div className="flex items-center gap-2.5 p-1.5 px-3 rounded-2xl bg-purple-50/60 dark:bg-purple-950/40 border border-purple-200/50 dark:border-purple-900/40 max-w-sm">
            <audio
                ref={audioRef}
                src={audioUrl}
                preload="metadata"
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                onEnded={handleEnded}
                onPause={() => setIsPlaying(false)}
                onPlay={() => setIsPlaying(true)}
                className="hidden"
            />

            <button
                type="button"
                onClick={togglePlay}
                className="w-7 h-7 rounded-xl bg-purple-600 hover:bg-purple-700 text-white flex items-center justify-center shrink-0 transition-all duration-200 active:scale-95 shadow-xs cursor-pointer"
                aria-label={isPlaying ? "Tạm dừng" : "Nghe lại"}
            >
                {isPlaying ? <Pause size={13} className="fill-current" /> : <Play size={13} className="fill-current ml-0.5" />}
            </button>

            <div className="flex-1 flex flex-col justify-center">
                <input
                    type="range"
                    min={0}
                    max={safeDuration > 0 ? safeDuration : 100}
                    step={0.05}
                    value={currentTime}
                    onChange={handleSeek}
                    disabled={safeDuration <= 0}
                    className="w-full h-1 bg-purple-200 dark:bg-purple-800 rounded-lg appearance-none cursor-pointer accent-purple-600"
                    aria-label="Tiến trình âm thanh"
                />
            </div>

            <span className="text-[11px] font-mono font-medium text-purple-700 dark:text-purple-300 shrink-0">
                {formatAudioTime(currentTime, "0:00")} / {formatAudioTime(duration, "--:--")}
            </span>
        </div>
    );
}
