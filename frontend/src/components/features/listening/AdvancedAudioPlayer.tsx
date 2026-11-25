"use client";

import React, { useRef, useEffect, forwardRef, useImperativeHandle, useMemo, useCallback, useState } from 'react';
import { PrivateAudioPlayer } from "./PrivateAudioPlayer";
import YouTube, { YouTubeProps } from 'react-youtube';
import { AlertTriangle, ExternalLink } from 'lucide-react';

export interface AdvancedAudioPlayerProps {
    audioUrl: string; // YouTube URL or 11-char video ID
    onTimeUpdate?: (currentTime: number, isPlaying?: boolean) => void;
    onPlaybackStateChange?: (isPlaying: boolean) => void;
    onEnded?: () => void;
    isRecording?: boolean;
    repeatCount?: number;
    /** When enabled, native YouTube controls are constrained to this segment. */
    lockToSegment?: boolean;
    segmentStart?: number;
    segmentEnd?: number;
    /** Listening workspace only: native scrubbing cancels a replay and selects a new sentence. */
    allowFreeSeek?: boolean;
    onUserSeek?: (time: number) => void;
    onReady?: () => void;
    onPlaybackRateChange?: (rate: number) => void;
}

export interface AdvancedAudioPlayerRef {
    seekTo: (time: number) => void;
    setLoop: (start: number, end: number, autoPlay?: boolean, maxRepeats?: number, gapSeconds?: number) => void;
    clearLoop: () => void;
    play: () => void;
    pause: () => void;
    getCurrentTime: () => number;
    setPlaybackRate: (rate: number) => void;
    getCycleCount?: () => number;
    resetCycleCount?: () => void;
}

/**
 * Extracts an 11-character YouTube video ID from any YouTube URL format,
 * markdown links, shortlinks, or raw video ID strings.
 */
export function extractYouTubeVideoId(url: string): string {
    if (!url) return '';
    let cleanUrl = url.trim();

    // Unwrap markdown syntax e.g. [url](url)
    const mdMatch = cleanUrl.match(/\[.*?\]\((.*?)\)/);
    if (mdMatch && mdMatch[1]) {
        cleanUrl = mdMatch[1].trim();
    }

    // 1. Direct 11-character Video ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(cleanUrl)) {
        return cleanUrl;
    }

    // 2. Comprehensive YouTube URL regex
    // Supports:
    // - youtube.com/watch?v=ID
    // - youtube.com/embed/ID
    // - youtube.com/v/ID
    // - youtube.com/shorts/ID
    // - youtube.com/live/ID
    // - youtu.be/ID
    const regex = /(?:youtube(?:-nocookie)?\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?|shorts|live)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;
    const match = cleanUrl.match(regex);
    if (match && match[1]) {
        return match[1];
    }

    // 3. Fallback regex to find any 11-char token after common delimiters
    const fallbackMatch = cleanUrl.match(/(?:v=|youtu\.be\/|embed\/|\/)([a-zA-Z0-9_-]{11})(?:[&?/#\s]|$)/);
    if (fallbackMatch && fallbackMatch[1]) {
        return fallbackMatch[1];
    }

    return cleanUrl;
}

const YouTubeAudioPlayer = React.memo(forwardRef<AdvancedAudioPlayerRef, AdvancedAudioPlayerProps>(({
    audioUrl,
    onTimeUpdate,
    onPlaybackStateChange,
    onEnded,
    isRecording = false,
    repeatCount,
    lockToSegment = false,
    segmentStart,
    segmentEnd,
    allowFreeSeek = false,
    onUserSeek,
    onReady: readyCallback,
    onPlaybackRateChange,
}, ref) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const playerRef = useRef<any>(null);
    const [playerError, setPlayerError] = useState<number | null>(null);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const loopARef = useRef<number | null>(null);
    const loopBRef = useRef<number | null>(null);
    const isSeekingRef = useRef<boolean>(false);
    const lastSeekTimeRef = useRef<number>(0);
    const currentCycleRef = useRef<number>(0);
    const maxRepeatsRef = useRef<number>(repeatCount ?? Infinity);
    const isRecordingRef = useRef<boolean>(isRecording);
    const loopGapSecondsRef = useRef<number>(0.5);
    const loopGapTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const loopGenerationRef = useRef<number>(0);
    const systemPauseRef = useRef<boolean>(false);
    const lockToSegmentRef = useRef<boolean>(lockToSegment);
    const segmentStartRef = useRef<number | null>(segmentStart ?? null);
    const segmentEndRef = useRef<number | null>(segmentEnd ?? null);
    const repeatCountRef = useRef<number | undefined>(repeatCount);
    const segmentPropsRef = useRef({ lockToSegment, segmentStart, segmentEnd, repeatCount });
    const freeSeekRef = useRef(false);
    const userSeekRef = useRef(onUserSeek);
    const readyCallbackRef = useRef(readyCallback);
    const rateCallbackRef=useRef(onPlaybackRateChange);rateCallbackRef.current=onPlaybackRateChange;
    const previousSample = useRef<{time:number;at:number}|null>(null);
    const programTarget = useRef<number|null>(null);
    const pendingCommand = useRef<{time:number;play:boolean}|null>(null);
    const desiredRate=useRef<number|null>(null);
    freeSeekRef.current = allowFreeSeek;
    userSeekRef.current = onUserSeek;
    readyCallbackRef.current = readyCallback;

    const commandSeek = useCallback((time:number, play=false) => {
        programTarget.current=time;previousSample.current=null;
        if (!playerRef.current) { pendingCommand.current={time,play};return; }
        playerRef.current.seekTo(time,true);
        if(play&&!isRecordingRef.current)playerRef.current.playVideo?.();
    },[]);

    const observeTime = useCallback((time:number) => {
        if(!freeSeekRef.current)return false;
        const now=performance.now();const previous=previousSample.current;
        previousSample.current={time,at:now};
        if(programTarget.current!==null){
            if(Math.abs(time-programTarget.current)<.6){programTarget.current=null;isSeekingRef.current=false;}
            else return true; // Wait for the player's acknowledgement, never enforce an obsolete sample.
        } else if(previous) {
            const elapsed=Math.max(0,(now-previous.at)/1000);
            const rate=playerRef.current?.getPlaybackRate?.()||1;
            if(Math.abs(time-previous.time)>Math.max(.25,elapsed*rate*1.8+.15)){
                if(loopGapTimeoutRef.current)clearTimeout(loopGapTimeoutRef.current);
                loopGapTimeoutRef.current=null;loopGenerationRef.current++;systemPauseRef.current=false;
                loopARef.current=null;loopBRef.current=null;isSeekingRef.current=false;
                userSeekRef.current?.(time);
                return true;
            }
        }
        return false;
    },[]);

    const onTimeUpdateRef = useRef(onTimeUpdate);
    const onPlaybackStateChangeRef = useRef(onPlaybackStateChange);
    const onEndedRef = useRef(onEnded);

    useEffect(() => {
        onTimeUpdateRef.current = onTimeUpdate;
    }, [onTimeUpdate]);

    useEffect(() => {
        onPlaybackStateChangeRef.current = onPlaybackStateChange;
    }, [onPlaybackStateChange]);

    useEffect(() => {
        onEndedRef.current = onEnded;
    }, [onEnded]);

    // Keep repeat count configuration in sync
    useEffect(() => {
        if (repeatCount !== undefined) {
            maxRepeatsRef.current = repeatCount;
        }
        repeatCountRef.current = repeatCount;
    }, [repeatCount]);

    useEffect(() => {
        const previousProps = segmentPropsRef.current;
        const segmentChanged = previousProps.lockToSegment !== lockToSegment
            || previousProps.segmentStart !== segmentStart
            || previousProps.segmentEnd !== segmentEnd;
        const repeatChanged = previousProps.repeatCount !== repeatCount;
        segmentPropsRef.current = { lockToSegment, segmentStart, segmentEnd, repeatCount };

        lockToSegmentRef.current = lockToSegment;
        segmentStartRef.current = typeof segmentStart === 'number' && Number.isFinite(segmentStart) ? segmentStart : null;
        segmentEndRef.current = typeof segmentEnd === 'number' && Number.isFinite(segmentEnd) ? segmentEnd : null;

        if (segmentChanged || repeatChanged) {
            if (loopGapTimeoutRef.current) {
                clearTimeout(loopGapTimeoutRef.current);
                loopGapTimeoutRef.current = null;
            }
            loopGenerationRef.current += 1;
            systemPauseRef.current = false;
        }

        // Keep an active segment available for a native YouTube Play event,
        // even before the page's imperative sync callback runs. Do not seek or
        // autoplay here; that remains the page's explicit playback policy.
        if (
            lockToSegment
            && segmentStartRef.current !== null
            && segmentEndRef.current !== null
            && segmentEndRef.current > segmentStartRef.current
        ) {
            if (segmentChanged || loopARef.current === null || loopBRef.current === null) {
                loopARef.current = segmentStartRef.current;
                loopBRef.current = segmentEndRef.current;
                currentCycleRef.current = 0;
                isSeekingRef.current = false;
            }
            maxRepeatsRef.current = repeatCount ?? Infinity;
            if (repeatChanged) currentCycleRef.current = 0;
        }
    }, [lockToSegment, segmentStart, segmentEnd, repeatCount]);

    const videoId = useMemo(() => extractYouTubeVideoId(audioUrl), [audioUrl]);

    const stopPolling = useCallback((preserveScheduledReplay: boolean = false, dispose: boolean = false) => {
        if (intervalRef.current && (!freeSeekRef.current || dispose)) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        if (!preserveScheduledReplay && loopGapTimeoutRef.current) {
            clearTimeout(loopGapTimeoutRef.current);
            loopGapTimeoutRef.current = null;
        }
        onPlaybackStateChangeRef.current?.(false);
    }, []);

    // Strict recording exclusivity guard: immediately pause and silence on recording trigger
    useEffect(() => {
        isRecordingRef.current = isRecording;
        if (isRecording) {
            if (playerRef.current && typeof playerRef.current.pauseVideo === 'function') {
                try {
                    playerRef.current.pauseVideo();
                } catch {}
            }
            stopPolling();
            onPlaybackStateChangeRef.current?.(false);
        }
    }, [isRecording, stopPolling]);

    const ensureConfiguredSegment = useCallback(() => {
        if (
            !lockToSegmentRef.current
            || loopARef.current !== null
            || loopBRef.current !== null
            || segmentStartRef.current === null
            || segmentEndRef.current === null
            || segmentEndRef.current <= segmentStartRef.current
        ) return;

        loopARef.current = segmentStartRef.current;
        loopBRef.current = segmentEndRef.current;
        currentCycleRef.current = 0;
        maxRepeatsRef.current = repeatCountRef.current ?? Infinity;
        isSeekingRef.current = false;
    }, []);

    const startPolling = useCallback(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }

        // High-precision polling keeps native YouTube controls inside the
        // active sentence segment as well as the custom replay button.
        intervalRef.current = setInterval(() => {
            if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
                try {
                    if (isRecordingRef.current) {
                        if (typeof playerRef.current.pauseVideo === 'function') {
                            playerRef.current.pauseVideo();
                        }
                        stopPolling();
                        return;
                    }

                    ensureConfiguredSegment();
                    const state = typeof playerRef.current.getPlayerState === 'function'
                        ? playerRef.current.getPlayerState()
                        : -1;
                    const isPlaying = state === 1;
                    onPlaybackStateChangeRef.current?.(isPlaying);

                    const currentTime = playerRef.current.getCurrentTime();
                    if (typeof currentTime !== 'number' || isNaN(currentTime)) return;
                    const navigated=observeTime(currentTime);
                    if(programTarget.current!==null)return;
                    onTimeUpdateRef.current?.(currentTime, isPlaying);
                    if(navigated)return;

                    const loopA = loopARef.current;
                    const loopB = loopBRef.current;
                    if (!isPlaying || loopA === null || loopB === null) return;

                    const now = Date.now();

                    // A native seek or a YouTube buffer can move outside the
                    // active sentence. Re-anchor immediately at its start.
                    if (currentTime < loopA && !freeSeekRef.current) {
                        currentCycleRef.current = 0;
                        isSeekingRef.current = true;
                        lastSeekTimeRef.current = now;
                        commandSeek(loopA);
                        return;
                    }

                    if (isSeekingRef.current && currentTime >= loopA && currentTime < loopB) {
                        isSeekingRef.current = false;
                    }

                    if (isSeekingRef.current || currentTime < loopB) return;

                    if (isRecordingRef.current) {
                        playerRef.current.pauseVideo?.();
                        stopPolling();
                        return;
                    }

                    // currentCycle counts completed passes. A 1x segment
                    // therefore pauses at the first boundary; 2x/3x seek
                    // only until their exact total is complete.
                    const nextCycle = currentCycleRef.current + 1;
                    currentCycleRef.current = nextCycle;
                    if (nextCycle < maxRepeatsRef.current) {
                        isSeekingRef.current = true;
                        lastSeekTimeRef.current = now;
                        const generation = loopGenerationRef.current;

                        if (loopGapSecondsRef.current > 0) {
                            if (loopGapTimeoutRef.current) {
                                clearTimeout(loopGapTimeoutRef.current);
                            }
                            systemPauseRef.current = true;
                            playerRef.current.pauseVideo?.();
                            loopGapTimeoutRef.current = setTimeout(() => {
                                loopGapTimeoutRef.current = null;
                                if (
                                    generation !== loopGenerationRef.current
                                    || isRecordingRef.current
                                    || loopARef.current !== loopA
                                    || loopBRef.current !== loopB
                                    || !playerRef.current
                                ) {
                                    systemPauseRef.current = false;
                                    return;
                                }
                                systemPauseRef.current = false;
                                isSeekingRef.current = true;
                                lastSeekTimeRef.current = Date.now();
                                commandSeek(loopA);
                                playerRef.current.playVideo?.();
                            }, loopGapSecondsRef.current * 1000);
                            // onPause/onStateChange must not cancel the
                            // scheduled internal replay.
                            stopPolling(true);
                        } else {
                            commandSeek(loopA);
                            playerRef.current.playVideo?.();
                        }
                    } else {
                        systemPauseRef.current = false;
                        playerRef.current.pauseVideo?.();
                        stopPolling();
                        onPlaybackStateChangeRef.current?.(false);
                    }
                } catch {
                    // Ignore transient YouTube API/polling exceptions.
                }
            }
        }, 50);
    }, [ensureConfiguredSegment, stopPolling, observeTime]);

    // Provide methods via ref
    useImperativeHandle(ref, () => ({
        seekTo: (time: number) => {
            isSeekingRef.current = true;
            lastSeekTimeRef.current = Date.now();
            commandSeek(time);
        },
        setLoop: (start: number, end: number, autoPlay: boolean = true, maxRepeats?: number, gapSeconds?: number) => {
            if (loopGapTimeoutRef.current) {
                clearTimeout(loopGapTimeoutRef.current);
                loopGapTimeoutRef.current = null;
            }
            loopGenerationRef.current += 1;
            systemPauseRef.current = false;
            loopARef.current = start;
            loopBRef.current = end;
            currentCycleRef.current = 0;
            if (maxRepeats !== undefined) {
                maxRepeatsRef.current = maxRepeats;
            } else if (repeatCountRef.current !== undefined) {
                maxRepeatsRef.current = repeatCountRef.current;
            } else {
                maxRepeatsRef.current = 5;
            }
            if (gapSeconds !== undefined) {
                loopGapSecondsRef.current = gapSeconds;
            }
            isSeekingRef.current = true;
            lastSeekTimeRef.current = Date.now();
            startPolling();
            commandSeek(start,autoPlay);
        },
        clearLoop: () => {
            pendingCommand.current=null;
            programTarget.current=null;
            if (loopGapTimeoutRef.current) {
                clearTimeout(loopGapTimeoutRef.current);
                loopGapTimeoutRef.current = null;
            }
            loopGenerationRef.current += 1;
            systemPauseRef.current = false;
            loopARef.current = null;
            loopBRef.current = null;
            currentCycleRef.current = 0;
            maxRepeatsRef.current = 0;
            isSeekingRef.current = false;
            stopPolling();
        },
        play: () => {
            if (isRecordingRef.current) return;
            ensureConfiguredSegment();
            const loopA = loopARef.current;
            const loopB = loopBRef.current;
            if (lockToSegmentRef.current && loopA !== null && loopB !== null && playerRef.current?.getCurrentTime) {
                const currentTime = playerRef.current.getCurrentTime();
                if (currentTime < loopA || currentTime >= loopB || currentCycleRef.current >= maxRepeatsRef.current) {
                    currentCycleRef.current = 0;
                    isSeekingRef.current = true;
                    lastSeekTimeRef.current = Date.now();
                    commandSeek(loopA);
                }
            }
            if (playerRef.current && typeof playerRef.current.playVideo === 'function') {
                playerRef.current.playVideo();
            }
        },
        pause: () => {
            if(pendingCommand.current)pendingCommand.current.play=false;
            if (playerRef.current && typeof playerRef.current.pauseVideo === 'function') {
                playerRef.current.pauseVideo();
            }
        },
        getCurrentTime: () => {
            if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
                return playerRef.current.getCurrentTime() || 0;
            }
            return 0;
        },
        setPlaybackRate: (rate: number) => {
            desiredRate.current=rate;
            if (playerRef.current && typeof playerRef.current.setPlaybackRate === 'function') {
                playerRef.current.setPlaybackRate(rate);
            }
        },
        getCycleCount: () => currentCycleRef.current,
        resetCycleCount: () => {
            currentCycleRef.current = 0;
        },
    }), [ensureConfiguredSegment, commandSeek, startPolling, stopPolling]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onReady: YouTubeProps['onReady'] = (event) => {
        playerRef.current = event.target;
        if(desiredRate.current!==null)playerRef.current.setPlaybackRate?.(desiredRate.current);
        if(pendingCommand.current){const command=pendingCommand.current;pendingCommand.current=null;commandSeek(command.time,command.play);}
        if(freeSeekRef.current)startPolling();
        readyCallbackRef.current?.();
    };

    const onPlay: YouTubeProps['onPlay'] = () => {
        if (isRecordingRef.current) {
            if (playerRef.current && typeof playerRef.current.pauseVideo === 'function') {
                playerRef.current.pauseVideo();
            }
            stopPolling();
            onPlaybackStateChangeRef.current?.(false);
            return;
        }

        // Native YouTube Play is an explicit learner intent. Re-anchor it to
        // the selected sentence when it starts outside that segment or after
        // a finite loop has completed.
        ensureConfiguredSegment();
        const loopA = loopARef.current;
        const loopB = loopBRef.current;
        if (lockToSegmentRef.current && loopA !== null && loopB !== null && playerRef.current?.getCurrentTime) {
            const currentTime = playerRef.current.getCurrentTime();
            if (currentTime < loopA || currentTime >= loopB || currentCycleRef.current >= maxRepeatsRef.current) {
                currentCycleRef.current = 0;
                isSeekingRef.current = true;
                lastSeekTimeRef.current = Date.now();
                commandSeek(loopA);
            }
        }
        startPolling();
    };

    const onPause: YouTubeProps['onPause'] = () => {
        // A boundary replay intentionally pauses while its gap timer waits;
        // a learner/native pause must cancel polling but never restart later.
        stopPolling(systemPauseRef.current);
        if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
            try {
                const currentTime = playerRef.current.getCurrentTime();
                if (typeof currentTime === 'number' && !isNaN(currentTime)) {
                    onTimeUpdateRef.current?.(currentTime, false);
                }
            } catch {}
        }
        onPlaybackStateChangeRef.current?.(false);
    };

    const onStateChange: YouTubeProps['onStateChange'] = (event) => {
        // 1 = PLAYING, 2 = PAUSED, 0 = ENDED, 3 = BUFFERING
        if (event.data === 1) {
            if (isRecordingRef.current) {
                if (playerRef.current && typeof playerRef.current.pauseVideo === 'function') {
                    playerRef.current.pauseVideo();
                }
                stopPolling();
                onPlaybackStateChangeRef.current?.(false);
                return;
            }
            ensureConfiguredSegment();
            onPlaybackStateChangeRef.current?.(true);
            startPolling();
        } else if (event.data === 2 || event.data === 3) {
            stopPolling(systemPauseRef.current);
            onPlaybackStateChangeRef.current?.(false);
            if (playerRef.current && typeof playerRef.current.getCurrentTime === 'function') {
                try {
                    const currentTime = playerRef.current.getCurrentTime();
                    if (typeof currentTime === 'number' && !isNaN(currentTime)) {
                        onTimeUpdateRef.current?.(currentTime, false);
                    }
                } catch {}
            }
        } else if (event.data === 0) {
            stopPolling();
            onPlaybackStateChangeRef.current?.(false);
            if (!isRecordingRef.current && onEndedRef.current) {
                onEndedRef.current();
            }
        }
    };

    useEffect(() => {
        return () => {
            stopPolling(false,true);
        };
    }, [stopPolling]);

    useEffect(() => {
        setPlayerError(null);
    }, [videoId]);

    const onError: YouTubeProps['onError'] = (event) => {
        setPlayerError(event.data);
    };

    // Stable options to prevent iframe reload glitches on re-renders
    const youtubeOpts: YouTubeProps['opts'] = useMemo(() => ({
        width: '100%',
        height: '100%',
        playerVars: {
            autoplay: 0,
            controls: 1,
            disablekb: 0,
            modestbranding: 1,
            rel: 0,
            enablejsapi: 1,
        },
    }), []);

    return (
        <div className="w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-lg border border-gray-800 relative flex items-center justify-center">
            {videoId ? (
                <YouTube
                    videoId={videoId}
                    opts={youtubeOpts}
                    onReady={onReady}
                    onPlay={onPlay}
                    onPause={onPause}
                    onStateChange={onStateChange}
                    onPlaybackRateChange={(event)=>rateCallbackRef.current?.(event.data)}
                    onError={onError}
                    className="w-full h-full"
                    iframeClassName="w-full h-full aspect-video border-0"
                />
            ) : (
                <div className="text-gray-400 text-sm">No valid YouTube Video found</div>
            )}
            {playerError !== null && videoId && (
                <div className="absolute inset-0 bg-slate-950/95 flex flex-col items-center justify-center p-6 text-center z-20">
                    <AlertTriangle size={36} className="text-amber-400 mb-3" />
                    <h4 className="text-white font-bold text-base mb-1">
                        {playerError === 101 || playerError === 150
                            ? "Video này bị chặn phát nhúng theo yêu cầu của chủ sở hữu"
                            : "Không thể phát video này trên trình duyệt"}
                    </h4>
                    <p className="text-slate-400 text-xs max-w-md mb-4 leading-relaxed">
                        Bạn vẫn có thể tiếp tục nghe bài này bằng cách mở xem trực tiếp video gốc trên YouTube.
                    </p>
                    <a
                        href={`https://www.youtube.com/watch?v=${videoId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold shadow-md transition-all cursor-pointer"
                    >
                        <ExternalLink size={14} />
                        <span>Xem trên YouTube</span>
                    </a>
                </div>
            )}
        </div>
    );
}));

YouTubeAudioPlayer.displayName = "YouTubeAudioPlayer";
export const AdvancedAudioPlayer = forwardRef<AdvancedAudioPlayerRef, AdvancedAudioPlayerProps>(function AdvancedAudioPlayer(props, ref) {
    return /^\/api\/v1\/listening\/materials\/\d+\/audio$/.test(props.audioUrl)
        ? <PrivateAudioPlayer {...props} ref={ref}/> : <YouTubeAudioPlayer {...props} ref={ref}/>;
});


