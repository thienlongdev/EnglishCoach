"use client";

import React, { useState, useRef, useEffect } from "react";
import { Play, Loader2, Volume2, Check, AlertCircle } from "lucide-react";
import { CANONICAL_VOICES, VoiceMeta } from "@/services/speakingApi";
import { apiClient } from "@/services/api-client";

export interface VoiceSelectorProps {
    labelLocale?: string;
    selectedVoiceId: string;
    onSelectVoice: (voiceId: string) => void;
    disabled?: boolean;
    compact?: boolean;
    onPlaybackStateChange?: (isPlaying: boolean) => void;
}

export function VoiceSelector({
    labelLocale,
    selectedVoiceId,
    onSelectVoice,
    disabled = false,
    compact = false,
    onPlaybackStateChange,
}: VoiceSelectorProps) {
    const [previewState, setPreviewState] = useState<{
        voiceId: string | null;
        status: "idle" | "loading" | "playing" | "error";
    }>({ voiceId: null, status: "idle" });

    const currentAudioRef = useRef<HTMLAudioElement | null>(null);
    const requestIdRef = useRef(0);
    const blobUrlRef = useRef<string | null>(null);

    const stopPlayback = () => {
        requestIdRef.current += 1;
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
        if (currentAudioRef.current) {
            currentAudioRef.current.pause();
            currentAudioRef.current.currentTime = 0;
            currentAudioRef.current = null;
        }
        setPreviewState({ voiceId: null, status: "idle" });
        onPlaybackStateChange?.(false);
    };

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            requestIdRef.current += 1;
            if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
            if (currentAudioRef.current) {
                currentAudioRef.current.pause();
                currentAudioRef.current = null;
            }
        };
    }, []);

    const handleTogglePreview = async (e: React.MouseEvent, voiceId: string) => {
        e.stopPropagation();

        if (disabled) return;

        // If clicking currently active voice while loading or playing, stop it
        if (previewState.voiceId === voiceId && (previewState.status === "playing" || previewState.status === "loading")) {
            stopPlayback();
            return;
        }

        stopPlayback();
        const requestId = requestIdRef.current;
        setPreviewState({ voiceId, status: "loading" });
        onPlaybackStateChange?.(true);

        try {
            const response = await apiClient.get<Blob>(
                `/speaking/tts/preview?voiceId=${encodeURIComponent(voiceId)}`,
                { responseType: "blob", timeout: 35000 }
            );
            if (requestId !== requestIdRef.current) return;
            if (!response.data.size || !/^(audio\/|application\/octet-stream)/i.test(response.data.type)) {
                throw new Error("Invalid preview audio response");
            }
            const previewUrl = URL.createObjectURL(response.data);
            blobUrlRef.current = previewUrl;
            const audio = new Audio(previewUrl);
            currentAudioRef.current = audio;

            audio.oncanplaythrough = () => {
                if (currentAudioRef.current !== audio) return;
                audio.play().then(() => {
                    if (currentAudioRef.current !== audio) return;
                    setPreviewState({ voiceId, status: "playing" });
                }).catch((err) => {
                    if (currentAudioRef.current !== audio) return;
                    console.warn("OmniVoice preview audio play blocked:", err);
                    setPreviewState({ voiceId, status: "error" });
                    onPlaybackStateChange?.(false);
                });
            };

            audio.onplay = () => {
                if (currentAudioRef.current === audio) {
                    setPreviewState({ voiceId, status: "playing" });
                }
            };

            audio.onended = () => {
                if (currentAudioRef.current === audio) {
                    stopPlayback();
                }
            };

            audio.onerror = () => {
                console.warn("OmniVoice preview failed to load audio for voice:", voiceId);
                if (currentAudioRef.current === audio) {
                    stopPlayback();
                    setPreviewState({ voiceId, status: "error" });
                    onPlaybackStateChange?.(false);
                }
            };

            // Safety timeout
            setTimeout(() => {
                if (currentAudioRef.current === audio && audio.paused && audio.readyState < 2) {
                    stopPlayback();
                    setPreviewState({ voiceId, status: "error" });
                }
            }, 8000);
        } catch (err) {
            if (requestId !== requestIdRef.current) return;
            console.error("Failed to initialize audio preview:", err);
            setPreviewState({ voiceId, status: "error" });
            onPlaybackStateChange?.(false);
        }
    };

    return (
        <div className="w-full" role="radiogroup" aria-label={labelLocale === "en" ? "Choose a voice" : "Chọn giọng đọc"}>
            <div className={`grid ${compact ? (labelLocale ? "grid-cols-1 sm:grid-cols-2 gap-2" : "grid-cols-2 gap-2") : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5"}`}>
                {CANONICAL_VOICES.map((v: VoiceMeta) => {
                    const displayName = labelLocale === "vi" ? `Giọng ${v.gender === "male" ? "nam" : "nữ"} ${v.accent === "US" ? "Mỹ" : "Anh"}` : v.displayName;
                    const isSelected = selectedVoiceId === v.voiceId;
                    const isPreviewing = previewState.voiceId === v.voiceId;
                    const previewStatus = isPreviewing ? previewState.status : "idle";

                    return (
                        <div
                            key={v.voiceId}
                            data-voice-id={v.voiceId}
                            onClick={() => !disabled && onSelectVoice(v.voiceId)}
                            role="radio"
                            aria-checked={isSelected}
                            tabIndex={0}
                            onKeyDown={(e) => {
                                if (e.target !== e.currentTarget) return;
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    if (!disabled) onSelectVoice(v.voiceId);
                                }
                            }}
                            className={`relative group flex items-center justify-between p-3 rounded-2xl border transition-all duration-200 cursor-pointer select-none text-left ${
                                isSelected
                                    ? "bg-purple-500/10 dark:bg-purple-950/50 border-purple-500/80 dark:border-purple-400 shadow-sm shadow-purple-500/20 ring-2 ring-purple-500/30 dark:ring-purple-400/30"
                                    : "bg-white/80 dark:bg-gray-800/80 border-gray-200/90 dark:border-gray-700/80 hover:border-purple-300 dark:hover:border-purple-700/70 hover:bg-purple-50/30 dark:hover:bg-gray-800"
                            } ${disabled ? "opacity-60 cursor-not-allowed pointer-events-none" : ""}`}
                        >
                            {/* Voice Details with Radio indicator */}
                            <div className="flex items-center gap-2.5 min-w-0 pr-2">
                                <div
                                    className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-all ${
                                        isSelected
                                            ? "border-purple-600 bg-purple-600 dark:border-purple-400 dark:bg-purple-500 shadow-xs"
                                            : "border-gray-300 dark:border-gray-600 bg-transparent group-hover:border-purple-400"
                                    }`}
                                >
                                    {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-white block" />}
                                </div>
                                <div className="min-w-0">
                                    <p className="text-xs font-bold text-gray-900 dark:text-white truncate">
                                        {displayName}
                                    </p>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        <span
                                            className={`inline-block px-1.5 py-0.5 rounded-md text-[10px] font-bold tracking-wider ${
                                                v.accent === "US"
                                                    ? "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300"
                                                    : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300"
                                            }`}
                                        >
                                            {v.accent}
                                        </span>
                                        <span className="text-[10px] font-medium text-gray-500 dark:text-gray-400">
                                            {v.gender === "female" ? "Nữ" : "Nam"}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            {/* Preview Button */}
                            <button
                                type="button"
                                data-voice-preview={v.voiceId}
                                onClick={(e) => handleTogglePreview(e, v.voiceId)}
                                disabled={disabled}
                                title={
                                    previewStatus === "playing"
                                        ? "Dừng nghe thử"
                                        : previewStatus === "loading"
                                        ? "Đang tải mẫu giọng..."
                                        : `Nghe thử giọng ${displayName}`
                                }
                                aria-label={`Nghe thử ${displayName}`}
                                className={`shrink-0 min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center transition-all cursor-pointer ${
                                    previewStatus === "playing"
                                        ? "bg-rose-500 text-white shadow-xs hover:bg-rose-600 scale-105"
                                        : previewStatus === "loading"
                                        ? "bg-purple-100 dark:bg-purple-900/80 text-purple-600 dark:text-purple-300"
                                        : previewStatus === "error"
                                        ? "bg-amber-100 dark:bg-amber-900/80 text-amber-700 dark:text-amber-300 hover:bg-amber-200"
                                        : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-purple-100 hover:text-purple-600 dark:hover:bg-purple-900/50"
                                }`}
                            >
                                {previewStatus === "loading" ? (
                                    <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
                                ) : previewStatus === "playing" ? (
                                    <div className="flex items-center justify-center gap-0.5">
                                        <span className="w-1 h-3 bg-white rounded-full animate-pulse motion-reduce:animate-none" style={{ animationDelay: "0ms" }} />
                                        <span className="w-1 h-3 bg-white rounded-full animate-pulse motion-reduce:animate-none" style={{ animationDelay: "150ms" }} />
                                        <span className="w-1 h-3 bg-white rounded-full animate-pulse motion-reduce:animate-none" style={{ animationDelay: "300ms" }} />
                                    </div>
                                ) : previewStatus === "error" ? (
                                    <AlertCircle size={12} />
                                ) : (
                                    <Play size={12} className="fill-current translate-x-0.5" />
                                )}
                            </button>
                        </div>
                    );
                })}
            </div>
            {previewState.status === "error" && <p role="alert" className="mt-2 text-xs text-amber-600">{labelLocale === "en" ? "Could not play the sample. Try again." : "Chưa thể nghe thử. Vui lòng thử lại."}</p>}
        </div>
    );
}
