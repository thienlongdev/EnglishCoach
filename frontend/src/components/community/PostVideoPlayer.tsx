'use client'

import React, { useRef, useEffect, useState, useCallback } from 'react'
import {
    Play,
    Pause,
    Volume2,
    Volume1,
    VolumeX,
    Maximize2,
    Minimize2,
    RotateCcw,
    X,
} from 'lucide-react'

interface PostVideoPlayerProps {
    src: string
    poster?: string
    className?: string
}

function formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0) return '00:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
}

export function PostVideoPlayer({ src, poster, className = '' }: PostVideoPlayerProps) {
    const videoRef = useRef<HTMLVideoElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    const [isPlaying, setIsPlaying] = useState(false)
    const [isMuted, setIsMuted] = useState(true)
    const [volume, setVolume] = useState(1)
    const [currentTime, setCurrentTime] = useState(0)
    const [duration, setDuration] = useState(0)
    const [isDraggingSeek, setIsDraggingSeek] = useState(false)
    const [showControls, setShowControls] = useState(false)
    const [isFullscreen, setIsFullscreen] = useState(false)

    // Fullscreen event listener (syncs native fullscreen state)
    useEffect(() => {
        const handleFullscreenChange = () => {
            const isFs = Boolean(
                document.fullscreenElement === containerRef.current ||
                (document as any).webkitFullscreenElement === containerRef.current
            )
            setIsFullscreen(isFs)
        }
        document.addEventListener('fullscreenchange', handleFullscreenChange)
        document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
        return () => {
            document.removeEventListener('fullscreenchange', handleFullscreenChange)
            document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
        }
    }, [])

    // ESC key handler for fullscreen exit
    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isFullscreen) {
                if (document.fullscreenElement || (document as any).webkitFullscreenElement) {
                    if (document.exitFullscreen) document.exitFullscreen().catch(() => {})
                }
                setIsFullscreen(false)
            }
        }
        window.addEventListener('keydown', handleEsc)
        return () => window.removeEventListener('keydown', handleEsc)
    }, [isFullscreen])

    // IntersectionObserver to auto-pause when scrolled out of viewport (preserving position)
    useEffect(() => {
        const video = videoRef.current
        const container = containerRef.current
        if (!video || !container) return

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    // When video leaves visible area, pause it without resetting currentTime
                    if (!entry.isIntersecting && !video.paused && !isFullscreen) {
                        video.pause()
                        setIsPlaying(false)
                    }
                })
            },
            { threshold: 0.25 }
        )

        observer.observe(container)
        return () => observer.disconnect()
    }, [isFullscreen])

    const togglePlay = useCallback(() => {
        const video = videoRef.current
        if (!video) return

        if (video.paused) {
            video
                .play()
                .then(() => setIsPlaying(true))
                .catch((err) => {
                    console.debug('[PostVideoPlayer] Play interrupted', err)
                })
        } else {
            video.pause()
            setIsPlaying(false)
        }
    }, [])

    const toggleFullscreen = useCallback(async (e?: React.SyntheticEvent) => {
        if (e) {
            e.stopPropagation()
            if (e.preventDefault) e.preventDefault()
        }
        const container = containerRef.current
        if (!container) return

        try {
            if (document.fullscreenElement || (document as any).webkitFullscreenElement) {
                if (document.exitFullscreen) {
                    await document.exitFullscreen()
                } else if ((document as any).webkitExitFullscreen) {
                    await (document as any).webkitExitFullscreen()
                }
                setIsFullscreen(false)
            } else if (container.requestFullscreen) {
                await container.requestFullscreen()
                setIsFullscreen(true)
            } else if ((container as any).webkitRequestFullscreen) {
                await (container as any).webkitRequestFullscreen()
                setIsFullscreen(true)
            } else {
                setIsFullscreen((prev) => !prev)
            }
        } catch {
            setIsFullscreen((prev) => !prev)
        }
    }, [])

    const toggleMute = (e: React.MouseEvent) => {
        e.stopPropagation()
        const video = videoRef.current
        if (!video) return

        if (isMuted) {
            video.muted = false
            video.volume = volume > 0 ? volume : 1
            setIsMuted(false)
            if (volume === 0) setVolume(1)
        } else {
            video.muted = true
            setIsMuted(true)
        }
    }

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.stopPropagation()
        const video = videoRef.current
        if (!video) return

        const newVol = parseFloat(e.target.value)
        setVolume(newVol)
        video.volume = newVol

        if (newVol === 0) {
            video.muted = true
            setIsMuted(true)
        } else {
            video.muted = false
            setIsMuted(false)
        }
    }

    const handleTimeUpdate = () => {
        const video = videoRef.current
        if (!video || isDraggingSeek) return
        setCurrentTime(video.currentTime)
    }

    const handleLoadedMetadata = () => {
        const video = videoRef.current
        if (!video) return
        setDuration(video.duration || 0)
    }

    const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        e.stopPropagation()
        const newTime = parseFloat(e.target.value)
        setCurrentTime(newTime)
        const video = videoRef.current
        if (video) {
            video.currentTime = newTime
        }
    }

    const handleSeekMouseDown = (e: React.MouseEvent) => {
        e.stopPropagation()
        setIsDraggingSeek(true)
    }

    const handleSeekMouseUp = (e: React.MouseEvent) => {
        e.stopPropagation()
        setIsDraggingSeek(false)
    }

    // Keyboard accessibility
    const handleKeyDown = (e: React.KeyboardEvent) => {
        const video = videoRef.current
        if (!video) return

        switch (e.key.toLowerCase()) {
            case ' ':
            case 'k':
                e.preventDefault()
                togglePlay()
                break
            case 'm':
                e.preventDefault()
                toggleMute(e as any)
                break
            case 'f':
                e.preventDefault()
                toggleFullscreen(e as any)
                break
            case 'arrowleft':
                e.preventDefault()
                video.currentTime = Math.max(0, video.currentTime - 5)
                setCurrentTime(video.currentTime)
                break
            case 'arrowright':
                e.preventDefault()
                video.currentTime = Math.min(video.duration || 0, video.currentTime + 5)
                setCurrentTime(video.currentTime)
                break
        }
    }

    const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0

    return (
        <div
            ref={containerRef}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onMouseEnter={() => setShowControls(true)}
            onMouseLeave={() => setShowControls(false)}
            className={isFullscreen
                ? 'fixed inset-0 z-[99999] w-screen h-screen bg-black rounded-none border-0 flex items-center justify-center m-0 p-0 overflow-hidden outline-hidden select-none'
                : `relative rounded-2xl overflow-hidden bg-black/90 border border-slate-200 dark:border-sky-900/40 group select-none outline-hidden focus:ring-2 focus:ring-cyan-500/50 ${className}`
            }
            onClick={(e) => {
                e.stopPropagation()
                togglePlay()
            }}
        >
            <video
                ref={videoRef}
                src={src}
                poster={poster}
                preload="metadata"
                muted={isMuted}
                playsInline
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => {
                    setIsPlaying(false)
                    setCurrentTime(0)
                    if (videoRef.current) videoRef.current.currentTime = 0
                }}
                className={isFullscreen
                    ? 'w-full h-full max-h-none max-w-none object-contain block mx-auto cursor-pointer'
                    : 'w-full max-h-[520px] object-contain mx-auto cursor-pointer block'
                }
            />

            {/* Exit Fullscreen button on top-right when in fullscreen */}
            {isFullscreen && (
                <button
                    type="button"
                    onClick={toggleFullscreen}
                    className="absolute top-4 right-4 z-[100000] p-2.5 rounded-full bg-black/60 hover:bg-black/80 text-white border border-white/20 transition cursor-pointer"
                    title="Thoát toàn màn hình (ESC / F)"
                >
                    <X className="w-5 h-5" />
                </button>
            )}

            {/* Play/Pause center overlay when paused */}
            {!isPlaying && (
                <div className="absolute inset-0 bg-black/35 flex items-center justify-center pointer-events-none transition-opacity">
                    <div className="w-14 h-14 rounded-full bg-cyan-500/90 text-slate-950 flex items-center justify-center shadow-xl shadow-cyan-500/30 transform transition-transform group-hover:scale-110">
                        <Play className="w-6 h-6 fill-slate-950 ml-0.5" />
                    </div>
                </div>
            )}

            {/* Bottom Feed Control Bar */}
            <div
                className={`absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-3 pt-8 flex flex-col gap-2 transition-opacity duration-200 ${
                    isPlaying && !showControls ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'
                }`}
                onClick={(e) => e.stopPropagation()}
            >
                {/* 1. Timeline / Seek Bar (Draggable & Clickable) */}
                <div className="relative w-full flex items-center group/scrub">
                    <input
                        type="range"
                        min={0}
                        max={duration || 100}
                        step={0.1}
                        value={currentTime}
                        onChange={handleSeekChange}
                        onMouseDown={handleSeekMouseDown}
                        onMouseUp={handleSeekMouseUp}
                        onTouchStart={(e) => {
                            e.stopPropagation()
                            setIsDraggingSeek(true)
                        }}
                        onTouchEnd={(e) => {
                            e.stopPropagation()
                            setIsDraggingSeek(false)
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full h-1.5 bg-white/20 hover:bg-white/30 rounded-full appearance-none cursor-pointer accent-cyan-400 focus:outline-hidden transition-all duration-150"
                        title="Tua video"
                        aria-label="Tua video"
                    />
                </div>

                {/* 2. Control Buttons & Time */}
                <div className="flex items-center justify-between text-white text-xs">
                    {/* Left: Play/Pause + Time */}
                    <div className="flex items-center gap-2.5">
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation()
                                togglePlay()
                            }}
                            className="p-1 rounded-lg hover:bg-white/15 transition cursor-pointer text-white"
                            title={isPlaying ? 'Tạm dừng (Space / K)' : 'Phát (Space / K)'}
                        >
                            {isPlaying ? (
                                <Pause className="w-4 h-4 fill-white" />
                            ) : (
                                <Play className="w-4 h-4 fill-white ml-0.5" />
                            )}
                        </button>

                        <span className="font-mono text-[11px] text-white/90 tracking-tight">
                            {formatTime(currentTime)} / {formatTime(duration)}
                        </span>
                    </div>

                    {/* Right: Volume Slider + Mute + Fullscreen */}
                    <div className="flex items-center gap-2">
                        {/* Volume Control Group */}
                        <div
                            className="flex items-center gap-1.5 bg-black/40 px-2 py-0.5 rounded-lg border border-white/10"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <button
                                type="button"
                                onClick={toggleMute}
                                className="p-0.5 rounded hover:bg-white/10 transition cursor-pointer text-white"
                                title={isMuted ? 'Bật âm thanh (M)' : 'Tắt âm thanh (M)'}
                            >
                                {isMuted || volume === 0 ? (
                                    <VolumeX className="w-4 h-4 text-rose-400" />
                                ) : volume < 0.5 ? (
                                    <Volume1 className="w-4 h-4 text-cyan-400" />
                                ) : (
                                    <Volume2 className="w-4 h-4 text-cyan-400" />
                                )}
                            </button>

                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.05}
                                value={isMuted ? 0 : volume}
                                onChange={handleVolumeChange}
                                onClick={(e) => e.stopPropagation()}
                                className="w-14 sm:w-18 h-1 bg-white/30 rounded-full appearance-none cursor-pointer accent-cyan-400 focus:outline-hidden"
                                title="Âm lượng"
                                aria-label="Âm lượng"
                            />
                        </div>

                        {/* Fullscreen Button */}
                        <button
                            type="button"
                            onClick={toggleFullscreen}
                            className="p-1 rounded-lg hover:bg-white/15 transition cursor-pointer text-white"
                            title={isFullscreen ? 'Thu nhỏ (F / ESC)' : 'Toàn màn hình (F)'}
                        >
                            {isFullscreen ? (
                                <Minimize2 className="w-4 h-4" />
                            ) : (
                                <Maximize2 className="w-4 h-4" />
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
