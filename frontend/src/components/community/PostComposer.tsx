'use client'

import React, { useState, useRef, useEffect } from 'react'
import Image from 'next/image'
import {
    Image as ImageIcon,
    Video as VideoIcon,
    Smile,
    Send,
    X,
    Loader2,
    CheckCircle2,
    Play,
    AlertCircle,
    ShieldAlert,
} from 'lucide-react'
import { useSession } from 'next-auth/react'
import { UserAvatar } from '@/components/common/UserAvatar'
import { useCurrentUserProfile } from '@/hooks/useCurrentUserProfile'
import { communityApi } from '@/services/communityApi'
import { CommunityPost, PostType, CommunityUserRestriction } from '@/types/community'
import { ComposerEmojiPicker } from './ComposerEmojiPicker'
import styles from './communityGlass.module.css'

interface PostComposerProps {
    onPostCreated?: (post: CommunityPost) => void
    /** A shortcut (the page hero) asked to write a post of this type: select it and bring the composer into view. */
    preset?: { type: PostType; nonce: number } | null
}

interface MediaAttachment {
    file: File
    previewUrl: string
    type: 'IMAGE' | 'VIDEO'
    stagedUrl?: string // Preserved on failed post creation for duplicate-free retry
}

const POST_TYPES: { type: PostType; label: string }[] = [
    { type: 'GENERAL', label: 'Chia sẻ' },
    { type: 'QUESTION', label: 'Hỏi đáp' },
    { type: 'CORRECTION_REQUEST', label: 'Nhờ sửa câu' },
    { type: 'ACHIEVEMENT', label: 'Thành tích' },
    { type: 'LEARNING', label: 'Bài học' },
]

const TYPE_TONE: Record<string, string> = { GENERAL: '#0ea5e9', QUESTION: '#8b5cf6', CORRECTION_REQUEST: '#f59e0b', ACHIEVEMENT: '#10b981', LEARNING: '#06b6d4' }

export function PostComposer({ onPostCreated, preset }: PostComposerProps) {
    const { data: session } = useSession()
    const { profile } = useCurrentUserProfile()
    const displayName = profile?.displayName || session?.user?.name || 'Học viên'

    const [content, setContent] = useState('')
    const [postType, setPostType] = useState<PostType>('GENERAL')
    const [attachments, setAttachments] = useState<MediaAttachment[]>([])
    const [submitting, setSubmitting] = useState(false)
    const [uploadingMedia, setUploadingMedia] = useState(false)
    const [pendingNotice, setPendingNotice] = useState(false)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [restriction, setRestriction] = useState<CommunityUserRestriction | null>(null)

    // Check user restriction on mount
    useEffect(() => {
        if (session?.user) {
            communityApi.getMyRestriction()
                .then((res) => {
                    if (res && res.active) {
                        setRestriction(res)
                    } else {
                        setRestriction(null)
                    }
                })
                .catch(() => setRestriction(null))
        }
    }, [session?.user])

    const isPostingRestricted = Boolean(restriction && !restriction.canPost)

    // Emoji picker state
    const [showEmojiPicker, setShowEmojiPicker] = useState(false)
    const [emojiAnchorRect, setEmojiAnchorRect] = useState<DOMRect | null>(null)

    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const imageInputRef = useRef<HTMLInputElement>(null)
    const videoInputRef = useRef<HTMLInputElement>(null)
    const emojiBtnRef = useRef<HTMLButtonElement>(null)
    const rootRef = useRef<HTMLDivElement>(null)
    const [focused, setFocused] = useState(false)

    // Hero shortcut: choose the post type, bring the composer into view and put the caret in the text field.
    useEffect(() => {
        if (!preset) return
        setPostType(preset.type)
        const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        rootRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
        textareaRef.current?.focus({ preventScroll: true })
    }, [preset])

    const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files
        if (!files || files.length === 0) return

        setErrorMessage(null)
        const currentImages = attachments.filter((a) => a.type === 'IMAGE').length
        if (currentImages + files.length > 10) {
            setErrorMessage('Bạn chỉ có thể đính kèm tối đa 10 hình ảnh cho mỗi bài viết.')
            return
        }

        const newAttachments: MediaAttachment[] = []
        for (let i = 0; i < files.length; i++) {
            const f = files[i]
            if (f.size > 5 * 1024 * 1024) {
                setErrorMessage(`Hình ảnh "${f.name}" vượt quá dung lượng tối đa 5MB.`)
                continue
            }
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
                setErrorMessage(`Định dạng của "${f.name}" không hợp lệ. Chỉ chấp nhận JPG, PNG, WEBP.`)
                continue
            }
            newAttachments.push({
                file: f,
                previewUrl: URL.createObjectURL(f),
                type: 'IMAGE',
            })
        }

        setAttachments((prev) => [...prev, ...newAttachments])
        if (imageInputRef.current) imageInputRef.current.value = ''
    }

    const handleVideoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files
        if (!files || files.length === 0) return

        setErrorMessage(null)
        const currentVideos = attachments.filter((a) => a.type === 'VIDEO').length
        if (currentVideos + files.length > 2) {
            setErrorMessage('Bạn chỉ có thể đính kèm tối đa 2 video cho mỗi bài viết.')
            return
        }

        const newAttachments: MediaAttachment[] = []
        for (let i = 0; i < files.length; i++) {
            const f = files[i]
            if (f.size > 30 * 1024 * 1024) {
                setErrorMessage(`Video "${f.name}" vượt quá dung lượng tối đa 30MB.`)
                continue
            }
            if (!['video/mp4', 'video/webm'].includes(f.type) && !f.name.match(/\.(mp4|webm)$/i)) {
                setErrorMessage(`Định dạng của "${f.name}" không hợp lệ. Chỉ chấp nhận MP4 hoặc WebM.`)
                continue
            }
            newAttachments.push({
                file: f,
                previewUrl: URL.createObjectURL(f),
                type: 'VIDEO',
            })
        }

        setAttachments((prev) => [...prev, ...newAttachments])
        if (videoInputRef.current) videoInputRef.current.value = ''
    }

    const handleRemoveAttachment = (index: number) => {
        setAttachments((prev) => {
            const item = prev[index]
            if (item) URL.revokeObjectURL(item.previewUrl)
            return prev.filter((_, i) => i !== index)
        })
    }

    // Insert emoji at CURRENT caret / selection position in textarea
    const handleInsertEmoji = (emoji: string) => {
        const textarea = textareaRef.current
        if (!textarea) {
            setContent((prev) => prev + emoji)
            return
        }

        const start = textarea.selectionStart ?? content.length
        const end = textarea.selectionEnd ?? content.length
        const newContent = content.substring(0, start) + emoji + content.substring(end)
        setContent(newContent)

        // Restore caret right after inserted emoji
        requestAnimationFrame(() => {
            if (textareaRef.current) {
                const nextPos = start + emoji.length
                textareaRef.current.selectionStart = nextPos
                textareaRef.current.selectionEnd = nextPos
                textareaRef.current.focus()
            }
        })
    }

    const handleOpenEmojiPicker = () => {
        if (emojiBtnRef.current) {
            setEmojiAnchorRect(emojiBtnRef.current.getBoundingClientRect())
        }
        setShowEmojiPicker((prev) => !prev)
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        const text = content.trim()
        if ((!text && attachments.length === 0) || submitting) return

        setSubmitting(true)
        setErrorMessage(null)

        try {
            // 1. Upload new media files or reuse previously staged URLs (Retry-safe)
            const finalMediaUrls: string[] = []
            if (attachments.length > 0) {
                setUploadingMedia(true)
                const updatedAttachments = [...attachments]

                for (let i = 0; i < updatedAttachments.length; i++) {
                    const att = updatedAttachments[i]
                    if (att.stagedUrl) {
                        // Already staged from previous attempt, reuse directly!
                        finalMediaUrls.push(att.stagedUrl)
                    } else {
                        // Upload now and cache stagedUrl
                        const uploaded = await communityApi.uploadMedia(att.file)
                        att.stagedUrl = uploaded.mediaUrl
                        finalMediaUrls.push(uploaded.mediaUrl)
                    }
                }

                setAttachments(updatedAttachments)
                setUploadingMedia(false)
            }

            // 2. Submit post to backend (creates PENDING post for learners)
            const created = await communityApi.createPost({
                content: text,
                postType: postType,
                mediaUrls: finalMediaUrls.length > 0 ? finalMediaUrls : undefined,
            })

            // Clean up previews and reset composer ONLY on success
            attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl))
            setAttachments([])
            setContent('')
            setPostType('GENERAL')

            // Show pending notice
            setPendingNotice(true)
            setTimeout(() => setPendingNotice(false), 5000)

            onPostCreated?.(created)
        } catch (err: unknown) {
            console.error('Failed to create post', err)
            // PRESERVE user input (content, postType, attachments with staged URLs) on failure
            const errMsg =
                err instanceof Error && err.message
                    ? err.message
                    : 'Không thể tạo bài viết. Vui lòng kiểm tra kết nối và thử lại.'
            setErrorMessage(errMsg)
        } finally {
            setSubmitting(false)
            setUploadingMedia(false)
        }
    }

    const currentImages = attachments.filter((a) => a.type === 'IMAGE').length
    const currentVideos = attachments.filter((a) => a.type === 'VIDEO').length
    const hasReachedMaxImages = currentImages >= 10
    const hasReachedMaxVideos = currentVideos >= 2

    return (
        <div ref={rootRef} className={`${styles.panel} ${styles.composer}`} data-focus={focused}>
            {/* Active User Restriction Notice */}
            {isPostingRestricted && (
                <div className={styles.notice} data-tone="warn" role="status">
                    <ShieldAlert aria-hidden="true" />
                    <div>
                        <p className="font-semibold">Bạn đang bị giới hạn tương tác trong Cộng đồng</p>
                        <p className="mt-0.5 opacity-90">
                            {restriction?.userMessage || 'Tài khoản của bạn tạm thời không thể tạo bài viết mới.'}
                        </p>
                    </div>
                </div>
            )}

            {/* Success / Pending Moderation Banner */}
            {pendingNotice && (
                <div className={styles.notice} data-tone="warn" role="status">
                    <CheckCircle2 aria-hidden="true" />
                    <span>
                        Bài viết đã được gửi và <strong>đang chờ duyệt</strong> bởi quản trị viên. Bạn có thể xem trong mục &quot;Bài viết của tôi&quot;.
                    </span>
                </div>
            )}

            {/* Inline Error Notice (Replacing window.alert) */}
            {errorMessage && (
                <div className={styles.notice} data-tone="bad" role="alert">
                    <AlertCircle aria-hidden="true" />
                    <span>{errorMessage}</span>
                    <button
                        type="button"
                        onClick={() => setErrorMessage(null)}
                        title="Đóng thông báo"
                        aria-label="Đóng thông báo"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            <form onSubmit={handleSubmit} data-guide="cm-compose">
                <div className={styles.composerRow}>
                    <div className="shrink-0 mt-0.5">
                        <UserAvatar
                            className="w-11 h-11 rounded-2xl"
                            fallbackName={displayName}
                            showFrame={true}
                            context="card"
                        />
                    </div>
                    <div className="flex-1 min-w-0">
                        <label htmlFor="community-composer" className="sr-only">Nội dung bài viết</label>
                        <textarea
                            id="community-composer"
                            ref={textareaRef}
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            onFocus={() => setFocused(true)}
                            onBlur={() => setFocused(false)}
                            disabled={isPostingRestricted || submitting}
                            placeholder={
                                isPostingRestricted
                                    ? 'Bạn không thể đăng bài do tài khoản đang bị giới hạn.'
                                    : 'Hôm nay bạn đang học gì? (Chia sẻ, đặt câu hỏi, gắn #hashtag...)'
                            }
                            rows={3}
                            maxLength={5000}
                            className={styles.field}
                        />
                        {content.length > 0 && (
                            <div className={styles.fieldMeta} aria-live="polite">{content.length.toLocaleString('vi-VN')} / 5.000 ký tự</div>
                        )}

                        {/* Media Previews */}
                        {attachments.length > 0 && (
                            <div className={styles.attachGrid}>
                                {attachments.map((att, idx) => (
                                    <div key={idx} className={`${styles.attach} group`}>
                                        {att.type === 'IMAGE' ? (
                                            <Image
                                                src={att.previewUrl}
                                                alt="Preview"
                                                fill
                                                className="object-cover"
                                            />
                                        ) : (
                                            <div className="relative w-full h-full bg-slate-900 flex items-center justify-center">
                                                <video
                                                    src={att.previewUrl}
                                                    className="w-full h-full object-cover"
                                                    muted
                                                    playsInline
                                                    controls={false}
                                                />
                                                <div className="absolute inset-0 bg-black/30 flex items-center justify-center pointer-events-none">
                                                    <Play className="w-6 h-6 text-white/90 fill-white/80" />
                                                </div>
                                                <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-black/70 text-white">
                                                    Video
                                                </span>
                                            </div>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => handleRemoveAttachment(idx)}
                                            className="absolute top-1 right-1 p-1 rounded-full bg-black/70 hover:bg-rose-600 text-white transition cursor-pointer z-10"
                                            title="Xóa tệp đính kèm"
                                            aria-label="Xóa tệp đính kèm"
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Categories & Actions */}
                <div className={styles.composerBar}>
                    {/* Post Type Chips */}
                    <div className={styles.typeRow} role="group" aria-label="Loại bài viết">
                        <span className={styles.typeLabel}>Loại bài</span>
                        {POST_TYPES.map((t) => (
                            <button
                                key={t.type}
                                type="button"
                                disabled={isPostingRestricted || submitting}
                                onClick={() => setPostType(t.type)}
                                aria-pressed={postType === t.type}
                                className={styles.chip}
                                style={{ ['--tone' as string]: TYPE_TONE[t.type] }}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>

                    {/* Media attach + Emoji + Post CTA */}
                    <div className={styles.tools}>
                        {/* 1. Image Upload */}
                        <input
                            ref={imageInputRef}
                            type="file"
                            multiple
                            accept=".jpg,.jpeg,.png,.webp"
                            onChange={handleImageSelect}
                            className="hidden"
                        />
                        <button
                            type="button"
                            onClick={() => imageInputRef.current?.click()}
                            disabled={hasReachedMaxImages || submitting || isPostingRestricted}
                            className={styles.tool}
                            title={
                                hasReachedMaxImages
                                    ? 'Đã đạt tối đa 10 ảnh'
                                    : 'Đính kèm ảnh (tối đa 10 ảnh, 5MB/ảnh)'
                            }
                        >
                            <ImageIcon className="text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
                            <span>Ảnh</span>
                            {currentImages > 0 && <span className={styles.toolCount}>{currentImages}/10</span>}
                        </button>

                        {/* 2. Video Upload */}
                        <input
                            ref={videoInputRef}
                            type="file"
                            multiple
                            accept=".mp4,.webm,video/mp4,video/webm"
                            onChange={handleVideoSelect}
                            className="hidden"
                        />
                        <button
                            type="button"
                            onClick={() => videoInputRef.current?.click()}
                            disabled={hasReachedMaxVideos || submitting || isPostingRestricted}
                            className={styles.tool}
                            title={
                                hasReachedMaxVideos
                                    ? 'Đã đạt tối đa 2 video'
                                    : 'Đính kèm video (tối đa 2 video, 30MB/video)'
                            }
                        >
                            <VideoIcon className="text-violet-600 dark:text-violet-400" aria-hidden="true" />
                            <span>Video</span>
                            {currentVideos > 0 && <span className={styles.toolCount} style={{ background: '#8b5cf6' }}>{currentVideos}/2</span>}
                        </button>

                        {/* 3. Composer Emoji Button */}
                        <button
                            ref={emojiBtnRef}
                            type="button"
                            onClick={handleOpenEmojiPicker}
                            disabled={submitting || isPostingRestricted}
                            className={styles.tool}
                            title="Chèn biểu tượng cảm xúc vào văn bản"
                        >
                            <Smile className="text-amber-500" aria-hidden="true" />
                            <span>Emoji</span>
                        </button>

                        {/* 4. Submit CTA */}
                        <button
                            type="submit"
                            disabled={(!content.trim() && attachments.length === 0) || submitting || isPostingRestricted}
                            className={styles.publish}
                        >
                            {submitting ? (
                                <>
                                    <Loader2 className="animate-spin" aria-hidden="true" />
                                    <span>{uploadingMedia ? 'Đang tải media...' : 'Đang gửi...'}</span>
                                </>
                            ) : (
                                <>
                                    <Send aria-hidden="true" />
                                    <span>Đăng bài</span>
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </form>

            {/* Composer Emoji Picker Portal */}
            <ComposerEmojiPicker
                isOpen={showEmojiPicker}
                onClose={() => setShowEmojiPicker(false)}
                onSelectEmoji={handleInsertEmoji}
                anchorRect={emojiAnchorRect}
                anchorRef={emojiBtnRef}
            />
        </div>
    )
}
