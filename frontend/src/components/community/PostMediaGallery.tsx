'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, ZoomIn, ChevronLeft, ChevronRight, Loader2, AlertCircle } from 'lucide-react'
import { CommunityPostMedia } from '@/types/community'
import { PostVideoPlayer } from './PostVideoPlayer'

interface PostMediaGalleryProps {
    media: CommunityPostMedia[]
}

function isVideoMedia(item: CommunityPostMedia): boolean {
    const itemType = (item.type || '').toUpperCase()
    if (itemType === 'VIDEO') return true
    const type = (item.mediaType || '').toLowerCase()
    const url = (item.mediaUrl || '').toLowerCase()
    return type.startsWith('video/') || url.endsWith('.mp4') || url.endsWith('.webm')
}

export function PostMediaGallery({ media }: PostMediaGalleryProps) {
    const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
    const [imageLoading, setImageLoading] = useState(true)
    const [imageError, setImageError] = useState(false)
    const [failedGridImages, setFailedGridImages] = useState<Record<number, boolean>>({})
    const [gridRetryKeys, setGridRetryKeys] = useState<Record<number, number>>({})
    const [lightboxRetryKey, setLightboxRetryKey] = useState<number>(0)

    if (!media || media.length === 0) return null

    // Sort media by order / sortOrder so exact attachment sequence is respected
    const sortedMedia = [...media].sort((a, b) => {
        const orderA = a.order ?? a.sortOrder ?? 0
        const orderB = b.order ?? b.sortOrder ?? 0
        return orderA - orderB
    })

    const videos = sortedMedia.filter(isVideoMedia)
    const images = sortedMedia.filter((m) => !isVideoMedia(m))
    const imageCount = images.length

    // Helper to format retry-busting URL
    const getGridImageUrl = (url: string, idx: number) => {
        const key = gridRetryKeys[idx]
        if (!key) return url
        return url.includes('?') ? `${url}&retry=${key}` : `${url}?retry=${key}`
    }

    const handleRetryGridImage = (e: React.MouseEvent, idx: number) => {
        e.stopPropagation()
        setFailedGridImages((prev) => ({ ...prev, [idx]: false }))
        setGridRetryKeys((prev) => ({ ...prev, [idx]: Date.now() }))
    }

    const getLightboxImageUrl = (url: string) => {
        if (!lightboxRetryKey) return url
        return url.includes('?') ? `${url}&retry=${lightboxRetryKey}` : `${url}?retry=${lightboxRetryKey}`
    }

    const handleRetryLightbox = () => {
        setImageError(false)
        setImageLoading(true)
        setLightboxRetryKey(Date.now())
    }

    // Lightbox navigation handlers
    const closeLightbox = useCallback(() => {
        setLightboxIndex(null)
        setImageLoading(true)
        setImageError(false)
    }, [])

    const showPrevImage = useCallback(() => {
        if (imageCount <= 1 || lightboxIndex === null) return
        setImageLoading(true)
        setImageError(false)
        setLightboxIndex((prev) => (prev! > 0 ? prev! - 1 : imageCount - 1))
    }, [imageCount, lightboxIndex])

    const showNextImage = useCallback(() => {
        if (imageCount <= 1 || lightboxIndex === null) return
        setImageLoading(true)
        setImageError(false)
        setLightboxIndex((prev) => (prev! < imageCount - 1 ? prev! + 1 : 0))
    }, [imageCount, lightboxIndex])

    // Body scroll lock and keyboard navigation
    useEffect(() => {
        if (lightboxIndex === null) return

        const originalOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                closeLightbox()
            } else if (e.key === 'ArrowLeft') {
                showPrevImage()
            } else if (e.key === 'ArrowRight') {
                showNextImage()
            }
        }

        window.addEventListener('keydown', handleKeyDown)

        return () => {
            document.removeEventListener('keydown', handleKeyDown)
            document.body.style.overflow = originalOverflow
        }
    }, [lightboxIndex, closeLightbox, showPrevImage, showNextImage])

    const currentLightboxImage = lightboxIndex !== null ? images[lightboxIndex] : null

    const renderThumbnail = (
        item: CommunityPostMedia,
        idx: number,
        aspectClass: string,
        isLastSlot = false,
        remainingCount = 0
    ) => {
        const isFailed = failedGridImages[idx]

        return (
            <div
                key={item.id || idx}
                className={`relative w-full ${aspectClass} cursor-pointer overflow-hidden group bg-slate-950/20`}
                onClick={() => {
                    if (isFailed) return
                    setImageLoading(true)
                    setImageError(false)
                    setLightboxIndex(idx)
                }}
            >
                {isFailed ? (
                    <div className="w-full h-full min-h-[140px] flex flex-col items-center justify-center bg-slate-900/60 p-4 text-center gap-2">
                        <AlertCircle className="w-5 h-5 text-rose-400" />
                        <span className="text-[11px] font-medium text-slate-300">Không thể tải ảnh</span>
                        <button
                            type="button"
                            onClick={(e) => handleRetryGridImage(e, idx)}
                            className="px-3 py-1 rounded-lg text-[11px] font-semibold bg-white/10 hover:bg-white/20 active:scale-95 text-white transition cursor-pointer"
                        >
                            Thử lại
                        </button>
                    </div>
                ) : (
                    <>
                        <img
                            src={getGridImageUrl(item.mediaUrl, idx)}
                            alt="Ảnh đính kèm"
                            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-102"
                            loading="lazy"
                            onError={() => {
                                setFailedGridImages((prev) => ({ ...prev, [idx]: true }))
                            }}
                        />
                        {isLastSlot && remainingCount > 0 ? (
                            <div className="absolute inset-0 bg-black/60 hover:bg-black/50 transition-colors flex items-center justify-center">
                                <span className="text-white text-xl sm:text-2xl font-bold drop-shadow-md">
                                    +{remainingCount}
                                </span>
                            </div>
                        ) : (
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                                <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-md" />
                            </div>
                        )}
                    </>
                )}
            </div>
        )
    }

    return (
        <div className="mt-3 space-y-2">
            {/* 1. Video Attachments (Rendered seamlessly for mixed media) */}
            {videos.map((vid, idx) => (
                <div key={vid.id || `vid-${idx}`} className="w-full rounded-2xl overflow-hidden shadow-xs">
                    <PostVideoPlayer
                        src={vid.mediaUrl}
                        className="w-full"
                    />
                </div>
            ))}

            {/* 2. Image Gallery (Grid rendering with error fallback & direct safe media URLs) */}
            {imageCount > 0 && (
                <div className="rounded-2xl overflow-hidden border border-slate-200 dark:border-sky-900/30 bg-slate-900/5 dark:bg-black/20">
                    {imageCount === 1 && (
                        renderThumbnail(images[0], 0, 'aspect-video sm:aspect-[2/1]')
                    )}

                    {imageCount === 2 && (
                        <div className="grid grid-cols-2 gap-1.5 aspect-[16/10]">
                            {images.map((item, idx) => renderThumbnail(item, idx, 'h-full'))}
                        </div>
                    )}

                    {imageCount === 3 && (
                        <div className="grid grid-cols-2 gap-1.5 aspect-[16/10]">
                            {renderThumbnail(images[0], 0, 'h-full')}
                            <div className="grid grid-rows-2 gap-1.5">
                                {images.slice(1, 3).map((item, idx) => renderThumbnail(item, idx + 1, 'h-full'))}
                            </div>
                        </div>
                    )}

                    {imageCount >= 4 && (
                        <div className="grid grid-cols-2 grid-rows-2 gap-1.5 aspect-[16/10]">
                            {images.slice(0, 4).map((item, idx) => {
                                const isLastSlot = idx === 3
                                const remainingCount = imageCount - 4
                                return renderThumbnail(item, idx, 'h-full', isLastSlot, remainingCount)
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* 3. Authoritative Portal Lightbox Modal */}
            {lightboxIndex !== null && currentLightboxImage && typeof document !== 'undefined' && createPortal(
                <div
                    className="fixed inset-0 z-[200] bg-black/95 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-150 select-none"
                    onClick={closeLightbox}
                >
                    {/* Top Toolbar: Counter & Close button */}
                    <div className="absolute top-4 left-4 z-[210] px-3.5 py-1.5 rounded-full bg-white/10 text-white text-xs font-bold backdrop-blur-md pointer-events-none">
                        {lightboxIndex + 1} / {imageCount}
                    </div>

                    <button
                        type="button"
                        aria-label="Đóng"
                        onClick={(e) => {
                            e.stopPropagation()
                            closeLightbox()
                        }}
                        className="absolute top-4 right-4 z-[210] p-2.5 rounded-full bg-white/10 hover:bg-white/25 active:scale-95 text-white transition cursor-pointer pointer-events-auto shadow-lg backdrop-blur-md"
                    >
                        <X className="w-6 h-6" />
                    </button>

                    {/* Navigation Buttons for multiple images */}
                    {imageCount > 1 && (
                        <>
                            <button
                                type="button"
                                aria-label="Ảnh trước"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    showPrevImage()
                                }}
                                className="absolute left-3 sm:left-6 top-1/2 -translate-y-1/2 z-[210] p-2.5 sm:p-3 rounded-full bg-white/10 hover:bg-white/25 active:scale-90 text-white transition cursor-pointer pointer-events-auto shadow-xl backdrop-blur-md"
                            >
                                <ChevronLeft className="w-6 h-6 sm:w-7 sm:h-7" />
                            </button>
                            <button
                                type="button"
                                aria-label="Ảnh kế tiếp"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    showNextImage()
                                }}
                                className="absolute right-3 sm:right-6 top-1/2 -translate-y-1/2 z-[210] p-2.5 sm:p-3 rounded-full bg-white/10 hover:bg-white/25 active:scale-90 text-white transition cursor-pointer pointer-events-auto shadow-xl backdrop-blur-md"
                            >
                                <ChevronRight className="w-6 h-6 sm:w-7 sm:h-7" />
                            </button>
                        </>
                    )}

                    {/* Central Image Viewer Container */}
                    <div
                        className="relative max-w-5xl max-h-[85vh] w-full h-full flex items-center justify-center pointer-events-auto"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Loading State Spinner */}
                        {imageLoading && !imageError && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/70">
                                <Loader2 className="w-10 h-10 animate-spin text-cyan-400" />
                                <span className="text-xs font-medium">Đang tải hình ảnh...</span>
                            </div>
                        )}

                        {/* Error Fallback with Retry */}
                        {imageError ? (
                            <div className="flex flex-col items-center justify-center p-8 bg-slate-900/90 rounded-2xl border border-slate-800 text-slate-300 gap-3 max-w-sm text-center">
                                <AlertCircle className="w-10 h-10 text-rose-500" />
                                <p className="text-sm font-semibold">Không thể tải hình ảnh này</p>
                                <button
                                    type="button"
                                    onClick={handleRetryLightbox}
                                    className="px-4 py-2 rounded-xl text-xs font-bold bg-white/10 hover:bg-white/20 text-white transition cursor-pointer active:scale-95"
                                >
                                    Thử tải lại
                                </button>
                            </div>
                        ) : (
                            <img
                                key={currentLightboxImage.mediaUrl + (lightboxRetryKey ? `-${lightboxRetryKey}` : '')}
                                src={getLightboxImageUrl(currentLightboxImage.mediaUrl)}
                                alt={currentLightboxImage.fileName || 'Ảnh đính kèm'}
                                onLoad={() => setImageLoading(false)}
                                onError={() => {
                                    setImageLoading(false)
                                    setImageError(true)
                                }}
                                className={`max-h-[85vh] max-w-[90vw] w-auto h-auto object-contain rounded-xl shadow-2xl transition-opacity duration-200 ${
                                    imageLoading ? 'opacity-0' : 'opacity-100'
                                }`}
                            />
                        )}
                    </div>
                </div>,
                document.body
            )}
        </div>
    )
}
