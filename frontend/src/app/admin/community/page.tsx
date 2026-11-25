'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import {
    ShieldCheck,
    CheckCircle,
    XCircle,
    EyeOff,
    Trash2,
    AlertTriangle,
    Pin,
    Send,
    BookOpenCheck,
    Calendar,
    RefreshCw,
    Loader2,
    CheckCircle2,
    Image as ImageIcon,
    Video as VideoIcon,
    Clock,
    User,
    RotateCcw,
    ShieldAlert,
    X,
    Play,
    Lock,
    Unlock,
    History,
    UserX,
    Shield,
    AlertCircle,
    Star,
    Smile,
} from 'lucide-react'
import {
    CommunityPost,
    PostStatus,
    ReportItem,
    PostType,
    OfficialPublishRequest,
    CommunityRestrictionType,
    CommunityUserRestriction,
    CreateRestrictionRequest,
    ModerationRecord,
} from '@/types/community'
import { communityApi } from '@/services/communityApi'
import { AuthorAvatar } from '@/components/community/AuthorAvatar'
import { PostMediaGallery } from '@/components/community/PostMediaGallery'
import { SharedLearningCard } from '@/components/community/SharedLearningCard'
import { LinkifiedText } from '@/components/community/LinkifiedText'
import { ComposerEmojiPicker } from '@/components/community/ComposerEmojiPicker'
import { useCurrentRole } from '@/hooks/useCurrentRole'
import { echoSrc } from '@/lib/brand/echoCharacters';

const REJECTION_REASONS = [
    'Spam',
    'Nội dung không phù hợp',
    'Quảng cáo',
    'Link đáng ngờ',
    'Ngôn từ không phù hợp',
    'Sai chủ đề',
    'Khác',
]

interface AdminMediaAttachment {
    file: File
    previewUrl: string
    type: 'IMAGE' | 'VIDEO'
    stagedUrl?: string
}

export default function AdminCommunityPage() {
    const { data: session, status } = useSession()
    // live backend role (users.role), never the login-time session copy
    const { isAdmin, isLoading: roleLoading } = useCurrentRole()

    const [activeTab, setActiveTab] = useState<
        'PENDING' | 'PUBLISHED' | 'REJECTED' | 'REPORTS' | 'HIDDEN' | 'PUBLISHER'
    >('PENDING')

    const [posts, setPosts] = useState<CommunityPost[]>([])
    const [reports, setReports] = useState<ReportItem[]>([])
    const [loading, setLoading] = useState(true)
    const [actionLoading, setActionLoading] = useState<number | null>(null)
    const [notification, setNotification] = useState<{ text: string; type: 'success' | 'error' } | null>(null)

    // In-memory tab caching for instantaneous tab switching (SWR)
    const adminPostsCache = useRef<Record<string, CommunityPost[]>>({})
    const adminReportsCache = useRef<ReportItem[] | null>(null)

    // Rejection modal state
    const [rejectingPostId, setRejectingPostId] = useState<number | null>(null)
    const [selectedReason, setSelectedReason] = useState(REJECTION_REASONS[0])
    const [rejectNote, setRejectNote] = useState('')

    // Official Publisher State
    const [pubContent, setPubContent] = useState('')
    const [pubType, setPubType] = useState<PostType>('OFFICIAL')
    const [pubPinned, setPubPinned] = useState(false)
    const [pubFeatured, setPubFeatured] = useState(false)
    const [pubSeriesName, setPubSeriesName] = useState('')
    const [pubScheduledAt, setPubScheduledAt] = useState('')
    const [pubAttachments, setPubAttachments] = useState<AdminMediaAttachment[]>([])
    const [pubSubmitting, setPubSubmitting] = useState(false)
    const [pubSuccess, setPubSuccess] = useState(false)
    const [pubError, setPubError] = useState<string | null>(null)
    const [showPubEmojiPicker, setShowPubEmojiPicker] = useState(false)
    const [pubEmojiAnchorRect, setPubEmojiAnchorRect] = useState<DOMRect | null>(null)
    const pubEmojiBtnRef = useRef<HTMLButtonElement>(null)
    const pubTextareaRef = useRef<HTMLTextAreaElement>(null)

    // User Restriction Modal State
    const [restrictingUser, setRestrictingUser] = useState<{ userId: number; displayName: string } | null>(null)
    const [restrictionType, setRestrictionType] = useState<CommunityRestrictionType>('READ_ONLY')
    const [durationOption, setDurationOption] = useState<'1' | '3' | '7' | '30' | 'CUSTOM' | 'PERMANENT'>('7')
    const [customDays, setCustomDays] = useState('14')
    const [restrictionReason, setRestrictionReason] = useState('')
    const [submittingRestriction, setSubmittingRestriction] = useState(false)
    const [activeUserRestriction, setActiveUserRestriction] = useState<CommunityUserRestriction | null>(null)
    const [userRestrictionHistory, setUserRestrictionHistory] = useState<CommunityUserRestriction[]>([])
    const [loadingRestrictionData, setLoadingRestrictionData] = useState(false)

    // Post Moderation History Modal State
    const [historyPostId, setHistoryPostId] = useState<number | null>(null)
    const [postModerationHistory, setPostModerationHistory] = useState<ModerationRecord[]>([])
    const [loadingHistory, setLoadingHistory] = useState(false)

    const imageInputRef = useRef<HTMLInputElement>(null)
    const videoInputRef = useRef<HTMLInputElement>(null)

    const showNotification = (text: string, type: 'success' | 'error' = 'success') => {
        setNotification({ text, type })
        setTimeout(() => setNotification(null), 4500)
    }

    const loadData = useCallback(async (isRefresh = false) => {
        if (!isAdmin) return

        if (activeTab === 'REPORTS') {
            if (!isRefresh && adminReportsCache.current) {
                setReports(adminReportsCache.current)
                setLoading(false)
            } else {
                setLoading(true)
            }

            try {
                const reportList = await communityApi.getReports('PENDING', 0, 50)
                setReports(reportList)
                adminReportsCache.current = reportList
            } catch (err) {
                console.error('Failed to load reports', err)
            } finally {
                setLoading(false)
            }
        } else if (activeTab !== 'PUBLISHER') {
            const cached = adminPostsCache.current[activeTab]
            if (!isRefresh && cached && cached.length > 0) {
                setPosts(cached)
                setLoading(false)
            } else {
                setLoading(true)
            }

            try {
                const data = await communityApi.getModerationPosts(
                    activeTab as PostStatus,
                    0,
                    50
                )
                setPosts(data.posts)
                adminPostsCache.current[activeTab] = data.posts
            } catch (err) {
                console.error('Failed to load moderation posts', err)
            } finally {
                setLoading(false)
            }
        }
    }, [activeTab, isAdmin])

    useEffect(() => {
        loadData()
    }, [loadData])

    // Optimistic Moderation Actions with Rollback
    const handleApprove = async (postId: number) => {
        const prevPosts = [...posts]
        const next = prevPosts.filter((p) => p.id !== postId)
        setPosts(next)
        adminPostsCache.current[activeTab] = next
        setActionLoading(postId)

        try {
            await communityApi.moderatePost(postId, { action: 'APPROVE' })
            showNotification(`Đã duyệt bài viết #${postId}`)
        } catch (err: unknown) {
            console.error('Failed to approve post, rolling back', err)
            setPosts(prevPosts)
            adminPostsCache.current[activeTab] = prevPosts
            showNotification('Không thể duyệt bài viết. Đã hoàn tác thay đổi.', 'error')
        } finally {
            setActionLoading(null)
        }
    }

    const handleConfirmReject = async () => {
        if (!rejectingPostId) return
        const targetId = rejectingPostId
        const prevPosts = [...posts]
        const next = prevPosts.filter((p) => p.id !== targetId)
        setPosts(next)
        adminPostsCache.current[activeTab] = next
        setRejectingPostId(null)
        setActionLoading(targetId)

        try {
            await communityApi.moderatePost(targetId, {
                action: 'REJECT',
                reason: selectedReason,
                note: rejectNote.trim() || undefined,
            })
            setRejectNote('')
            showNotification(`Đã từ chối bài viết #${targetId}`)
        } catch (err: unknown) {
            console.error('Failed to reject post, rolling back', err)
            setPosts(prevPosts)
            adminPostsCache.current[activeTab] = prevPosts
            showNotification('Không thể từ chối bài viết. Đã hoàn tác thay đổi.', 'error')
        } finally {
            setActionLoading(null)
        }
    }

    const handleHide = async (postId: number) => {
        const prevPosts = [...posts]
        const next = prevPosts.filter((p) => p.id !== postId)
        setPosts(next)
        adminPostsCache.current[activeTab] = next
        setActionLoading(postId)

        try {
            await communityApi.moderatePost(postId, { action: 'HIDE' })
            showNotification(`Đã ẩn bài viết #${postId}`)
        } catch (err: unknown) {
            console.error('Failed to hide post, rolling back', err)
            setPosts(prevPosts)
            adminPostsCache.current[activeTab] = prevPosts
            showNotification('Không thể ẩn bài viết. Đã hoàn tác thay đổi.', 'error')
        } finally {
            setActionLoading(null)
        }
    }

    const handleDelete = async (postId: number) => {
        if (!confirm('Xóa vĩnh viễn bài viết này?')) return
        const prevPosts = [...posts]
        const next = prevPosts.filter((p) => p.id !== postId)
        setPosts(next)
        adminPostsCache.current[activeTab] = next
        setActionLoading(postId)

        try {
            await communityApi.moderatePost(postId, { action: 'DELETE' })
            showNotification(`Đã xóa bài viết #${postId}`)
        } catch (err: unknown) {
            console.error('Failed to delete post, rolling back', err)
            setPosts(prevPosts)
            adminPostsCache.current[activeTab] = prevPosts
            showNotification('Không thể xóa bài viết. Đã hoàn tác thay đổi.', 'error')
        } finally {
            setActionLoading(null)
        }
    }

    const handleRestore = async (postId: number) => {
        const prevPosts = [...posts]
        const next = prevPosts.filter((p) => p.id !== postId)
        setPosts(next)
        adminPostsCache.current[activeTab] = next
        setActionLoading(postId)

        try {
            await communityApi.moderatePost(postId, { action: 'RESTORE' })
            showNotification(`Đã khôi phục bài viết #${postId}`)
        } catch (err: unknown) {
            console.error('Failed to restore post, rolling back', err)
            setPosts(prevPosts)
            adminPostsCache.current[activeTab] = prevPosts
            showNotification('Không thể khôi phục bài viết. Đã hoàn tác thay đổi.', 'error')
        } finally {
            setActionLoading(null)
        }
    }

    const handleTogglePin = async (postId: number, currentPinned: boolean) => {
        try {
            const updated = await communityApi.pinPost(postId, !currentPinned)
            setPosts((prev) => prev.map((p) => (p.id === postId ? updated : p)))
            if (adminPostsCache.current[activeTab]) {
                adminPostsCache.current[activeTab] = adminPostsCache.current[activeTab].map((p) =>
                    p.id === postId ? updated : p
                )
            }
            showNotification(currentPinned ? 'Đã bỏ ghim bài viết' : 'Đã ghim bài viết lên đầu')
        } catch (err) {
            console.error('Failed to toggle pin', err)
            showNotification('Không thể ghim bài viết', 'error')
        }
    }

    const handleToggleFeatured = async (postId: number, currentFeatured: boolean) => {
        try {
            const updated = await communityApi.featurePost(postId, !currentFeatured)
            setPosts((prev) => prev.map((p) => (p.id === postId ? updated : p)))
            if (adminPostsCache.current[activeTab]) {
                adminPostsCache.current[activeTab] = adminPostsCache.current[activeTab].map((p) =>
                    p.id === postId ? updated : p
                )
            }
            showNotification(currentFeatured ? 'Đã bỏ đánh dấu nổi bật' : 'Đã đánh dấu bài viết nổi bật')
        } catch (err) {
            console.error('Failed to toggle featured', err)
            showNotification('Không thể thay đổi trạng thái nổi bật', 'error')
        }
    }

    // Admin comment lock / unlock
    const handleToggleCommentLock = async (postId: number, currentLocked: boolean) => {
        setActionLoading(postId)
        try {
            if (currentLocked) {
                await communityApi.unlockComments(postId)
                showNotification(`Đã mở khóa bình luận cho bài viết #${postId}`)
            } else {
                await communityApi.lockComments(postId, 'Quản trị viên khóa bình luận')
                showNotification(`Đã khóa bình luận bài viết #${postId}`)
            }
            setPosts((prev) =>
                prev.map((p) =>
                    p.id === postId
                        ? {
                              ...p,
                              commentsLockedByAdmin: !currentLocked,
                              commentsDisabled: !currentLocked || Boolean(p.commentsDisabledByOwner),
                          }
                        : p
                )
            )
        } catch (err) {
            console.error('Failed to toggle comment lock', err)
            showNotification('Không thể thay đổi trạng thái khóa bình luận', 'error')
        } finally {
            setActionLoading(null)
        }
    }

    // Official Publisher Handlers (Support max 10 images, max 2 videos, mixed media)
    const handleAddImages = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files
        if (!files || files.length === 0) return

        setPubError(null)
        const currentImgs = pubAttachments.filter((a) => a.type === 'IMAGE').length
        if (currentImgs + files.length > 10) {
            setPubError('Mỗi bài viết chỉ có thể đính kèm tối đa 10 hình ảnh.')
            return
        }

        const newAtts: AdminMediaAttachment[] = []
        for (let i = 0; i < files.length; i++) {
            const f = files[i]
            if (f.size > 5 * 1024 * 1024) {
                setPubError(`Hình ảnh "${f.name}" vượt quá dung lượng tối đa 5MB.`)
                continue
            }
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
                setPubError(`Định dạng của "${f.name}" không hợp lệ. Chỉ chấp nhận JPG, PNG, WEBP.`)
                continue
            }
            newAtts.push({
                file: f,
                previewUrl: URL.createObjectURL(f),
                type: 'IMAGE',
            })
        }
        setPubAttachments((prev) => [...prev, ...newAtts])
        if (imageInputRef.current) imageInputRef.current.value = ''
    }

    const handleAddVideo = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files
        if (!files || files.length === 0) return

        setPubError(null)
        const currentVideos = pubAttachments.filter((a) => a.type === 'VIDEO').length
        if (currentVideos + files.length > 2) {
            setPubError('Mỗi bài viết chỉ có thể đính kèm tối đa 2 video.')
            return
        }

        const newAtts: AdminMediaAttachment[] = []
        for (let i = 0; i < files.length; i++) {
            const f = files[i]
            if (f.size > 30 * 1024 * 1024) {
                setPubError(`Video "${f.name}" vượt quá dung lượng tối đa 30MB.`)
                continue
            }
            if (!['video/mp4', 'video/webm'].includes(f.type) && !f.name.match(/\.(mp4|webm)$/i)) {
                setPubError(`Định dạng của "${f.name}" không hợp lệ. Chỉ chấp nhận MP4 hoặc WebM.`)
                continue
            }
            newAtts.push({
                file: f,
                previewUrl: URL.createObjectURL(f),
                type: 'VIDEO',
            })
        }
        setPubAttachments((prev) => [...prev, ...newAtts])
        if (videoInputRef.current) videoInputRef.current.value = ''
    }

    const handleRemoveAttachment = (idx: number) => {
        setPubAttachments((prev) => {
            const item = prev[idx]
            if (item) URL.revokeObjectURL(item.previewUrl)
            return prev.filter((_, i) => i !== idx)
        })
    }

    const handleTogglePubEmoji = () => {
        if (!showPubEmojiPicker && pubEmojiBtnRef.current) {
            setPubEmojiAnchorRect(pubEmojiBtnRef.current.getBoundingClientRect())
            setShowPubEmojiPicker(true)
        } else {
            setShowPubEmojiPicker(false)
        }
    }

    const handleInsertPubEmoji = (emoji: string) => {
        const textarea = pubTextareaRef.current
        if (!textarea) {
            setPubContent((prev) => prev + emoji)
            return
        }
        const start = textarea.selectionStart ?? pubContent.length
        const end = textarea.selectionEnd ?? pubContent.length
        const nextContent = pubContent.slice(0, start) + emoji + pubContent.slice(end)
        setPubContent(nextContent)
        requestAnimationFrame(() => {
            textarea.focus()
            const newCursor = start + emoji.length
            textarea.setSelectionRange(newCursor, newCursor)
        })
    }

    const handleOfficialPublish = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!pubContent.trim() || pubSubmitting) return

        setPubSubmitting(true)
        setPubError(null)

        try {
            const mediaUrls: string[] = []
            const updatedAttachments = [...pubAttachments]

            for (let i = 0; i < updatedAttachments.length; i++) {
                const att = updatedAttachments[i]
                if (att.stagedUrl) {
                    mediaUrls.push(att.stagedUrl)
                } else {
                    const res = await communityApi.uploadMedia(att.file)
                    att.stagedUrl = res.mediaUrl
                    mediaUrls.push(res.mediaUrl)
                }
            }
            setPubAttachments(updatedAttachments)

            const req: OfficialPublishRequest = {
                content: pubContent.trim(),
                postType: pubType,
                pinned: pubPinned,
                featured: pubFeatured,
                isPinned: pubPinned,
                isFeatured: pubFeatured,
                seriesName: pubSeriesName.trim() || undefined,
                scheduledAt: pubScheduledAt ? new Date(pubScheduledAt).toISOString() : undefined,
                mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
            }

            await communityApi.publishOfficial(req)

            setPubSuccess(true)
            setPubContent('')
            setPubSeriesName('')
            setPubScheduledAt('')
            setPubPinned(false)
            setPubFeatured(false)
            pubAttachments.forEach((a) => URL.revokeObjectURL(a.previewUrl))
            setPubAttachments([])
            setTimeout(() => setPubSuccess(false), 5000)
            showNotification('Bài viết chính thức đã được xuất bản thành công!')
        } catch (err: unknown) {
            console.error('Failed to publish official post', err)
            const errMsg =
                err instanceof Error && err.message
                    ? err.message
                    : 'Không thể xuất bản bài viết chính thức. Vui lòng kiểm tra lại.'
            setPubError(errMsg)
        } finally {
            setPubSubmitting(false)
        }
    }

    // User Restriction Handlers
    const handleOpenRestrictionModal = async (userId: number, displayName: string) => {
        setRestrictingUser({ userId, displayName })
        setRestrictionType('READ_ONLY')
        setDurationOption('7')
        setCustomDays('14')
        setRestrictionReason('')
        setLoadingRestrictionData(true)

        try {
            const [active, history] = await Promise.all([
                communityApi.getUserActiveRestriction(userId),
                communityApi.getUserRestrictionHistory(userId),
            ])
            setActiveUserRestriction(active)
            setUserRestrictionHistory(history)
        } catch (err) {
            console.error('Failed to load user restriction data', err)
        } finally {
            setLoadingRestrictionData(false)
        }
    }

    const handleCreateRestriction = async () => {
        if (!restrictingUser) return
        if (!restrictionReason.trim()) {
            showNotification('Vui lòng nhập lý do áp dụng giới hạn.', 'error')
            return
        }

        setSubmittingRestriction(true)
        try {
            let durationDays: number | undefined = undefined
            let permanent = false

            if (durationOption === 'PERMANENT') {
                permanent = true
            } else if (durationOption === 'CUSTOM') {
                durationDays = parseInt(customDays, 10) || 7
            } else {
                durationDays = parseInt(durationOption, 10)
            }

            const req: CreateRestrictionRequest = {
                targetUserId: restrictingUser.userId,
                restrictionType,
                reason: restrictionReason.trim(),
                durationDays,
                permanent,
            }

            await communityApi.createRestriction(req)
            showNotification(`Đã áp dụng giới hạn cho người dùng ${restrictingUser.displayName}`)

            // Reload active restriction & history
            const [active, history] = await Promise.all([
                communityApi.getUserActiveRestriction(restrictingUser.userId),
                communityApi.getUserRestrictionHistory(restrictingUser.userId),
            ])
            setActiveUserRestriction(active)
            setUserRestrictionHistory(history)
            setRestrictionReason('')
        } catch (err: unknown) {
            console.error('Failed to create restriction', err)
            const msg =
                err instanceof Error && err.message
                    ? err.message
                    : 'Không thể áp dụng giới hạn cho học viên.'
            showNotification(msg, 'error')
        } finally {
            setSubmittingRestriction(false)
        }
    }

    const handleRevokeRestriction = async (restrictionId: number) => {
        if (!confirm('Gỡ bỏ sớm giới hạn này cho học viên?')) return

        try {
            await communityApi.revokeRestriction(restrictionId)
            showNotification('Đã gỡ bỏ giới hạn thành công')

            if (restrictingUser) {
                const [active, history] = await Promise.all([
                    communityApi.getUserActiveRestriction(restrictingUser.userId),
                    communityApi.getUserRestrictionHistory(restrictingUser.userId),
                ])
                setActiveUserRestriction(active)
                setUserRestrictionHistory(history)
            }
        } catch (err) {
            console.error('Failed to revoke restriction', err)
            showNotification('Không thể gỡ bỏ giới hạn', 'error')
        }
    }

    // Post Moderation History
    const handleOpenHistoryModal = async (postId: number) => {
        setHistoryPostId(postId)
        setLoadingHistory(true)
        try {
            const hist = await communityApi.getModerationHistory(postId)
            setPostModerationHistory(hist)
        } catch (err) {
            console.error('Failed to load moderation history', err)
            setPostModerationHistory([])
        } finally {
            setLoadingHistory(false)
        }
    }

    if (status === 'loading' || roleLoading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
                <Loader2 className="w-8 h-8 animate-spin text-cyan-600 mb-3" />
                <p className="text-sm text-slate-500">Đang kiểm tra quyền truy cập...</p>
            </div>
        )
    }

    if (!isAdmin) {
        return (
            <div className="max-w-md mx-auto my-16 p-6 rounded-2xl bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900/40 shadow-xl text-center">
                <div className="w-14 h-14 mx-auto rounded-2xl bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 flex items-center justify-center mb-4">
                    <ShieldAlert className="w-8 h-8" />
                </div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
                    Truy cập bị từ chối (403)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-6">
                    Khu vực này yêu cầu quyền quản trị viên (ROLE_ADMIN). Tài khoản hiện tại của bạn không có quyền truy cập trang này.
                </p>
                <Link
                    href="/community"
                    className="inline-flex items-center justify-center px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold transition"
                >
                    Quay lại Cộng đồng
                </Link>
            </div>
        )
    }

    const imageCount = pubAttachments.filter((a) => a.type === 'IMAGE').length
    const videoCount = pubAttachments.filter((a) => a.type === 'VIDEO').length
    const hasReachedMaxImages = imageCount >= 10
    const hasReachedMaxVideos = videoCount >= 2

    return (
        <div className="min-h-screen py-6 px-3 sm:px-6 max-w-7xl mx-auto space-y-6 text-slate-900 dark:text-slate-100">
            {/* Notification Banner */}
            {notification && (
                <div
                    className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-2xl shadow-xl border text-xs font-semibold flex items-center gap-2 animate-in fade-in slide-in-from-top-4 duration-200 ${
                        notification.type === 'success'
                            ? 'bg-emerald-500 text-white border-emerald-400'
                            : 'bg-rose-600 text-white border-rose-500'
                    }`}
                >
                    {notification.type === 'success' ? (
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                    ) : (
                        <AlertCircle className="w-4 h-4 shrink-0" />
                    )}
                    <span>{notification.text}</span>
                    <button
                        type="button"
                        onClick={() => setNotification(null)}
                        className="ml-2 hover:opacity-80 cursor-pointer"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {/* Header */}
            <div className="bg-gradient-to-r from-amber-50 via-sky-50 to-indigo-50 dark:from-card/95 dark:to-surface-container-low/95 border border-border dark:border-border/60 rounded-3xl p-5 sm:p-6 shadow-sm dark:shadow-xl dark:shadow-cyan-950/20 backdrop-blur-md flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                    <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        Quản Trị Cộng Đồng
                    </div>
                    <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight">
                        Trung tâm kiểm duyệt và Official Publisher
                    </h1>
                    <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300/80">
                        Kiểm duyệt bài viết học viên, xử lý vi phạm, quản lý khóa bình luận và xuất bản bài viết chính thức từ EnglishCoach.
                    </p>
                </div>

                <button
                    type="button"
                    onClick={() => loadData(true)}
                    disabled={loading}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-white dark:bg-white/[0.06] hover:bg-slate-100 dark:hover:bg-white/[0.1] text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-sky-800/30 transition cursor-pointer self-start sm:self-auto shrink-0 shadow-xs"
                >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-cyan-500 dark:text-cyan-400' : ''}`} />
                    <span>Làm mới</span>
                </button>
            </div>

            {/* Navigation Tabs */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none border-b border-border dark:border-border/60">
                {[
                    { key: 'PENDING', label: 'Chờ duyệt', icon: Clock, color: 'text-amber-500 dark:text-amber-400' },
                    { key: 'PUBLISHED', label: 'Đã duyệt', icon: CheckCircle, color: 'text-emerald-500 dark:text-emerald-400' },
                    { key: 'REJECTED', label: 'Bị từ chối', icon: XCircle, color: 'text-rose-500 dark:text-rose-400' },
                    { key: 'REPORTS', label: 'Bị báo cáo', icon: AlertTriangle, color: 'text-red-500 dark:text-red-400' },
                    { key: 'HIDDEN', label: 'Đã ẩn', icon: EyeOff, color: 'text-slate-500 dark:text-slate-400' },
                    { key: 'PUBLISHER', label: 'Official Publisher', icon: BookOpenCheck, color: 'text-cyan-600 dark:text-cyan-400' },
                ].map((t) => {
                    const Icon = t.icon
                    const isActive = activeTab === t.key
                    return (
                        <button
                            key={t.key}
                            type="button"
                            onClick={() => setActiveTab(t.key as any)}
                            className={[
                                'inline-flex items-center gap-2 px-4 py-2.5 rounded-t-xl text-xs font-bold transition whitespace-nowrap cursor-pointer',
                                isActive
                                    ? 'bg-card dark:bg-card text-cyan-700 dark:text-cyan-300 border-t-2 border-cyan-500 shadow-md'
                                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.03]',
                            ].join(' ')}
                        >
                            <Icon className={`w-4 h-4 ${t.color}`} />
                            <span>{t.label}</span>
                        </button>
                    )
                })}
            </div>

            {/* TAB: Official Publisher */}
            {activeTab === 'PUBLISHER' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                    {/* Publisher Composer */}
                    <div className="lg:col-span-7 bg-card dark:bg-card/90 border border-border dark:border-border/60 rounded-2xl p-5 shadow-sm dark:shadow-xl space-y-4">
                        <div className="flex items-center justify-between border-b border-border dark:border-border/60 pb-3">
                            <h2 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                <BookOpenCheck className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                                <span>Soạn thảo bài viết Official EnglishCoach</span>
                            </h2>
                            <span className="text-[11px] text-slate-500 dark:text-slate-400">
                                Xuất bản trực tiếp / Ghim / Đặt lịch
                            </span>
                        </div>

                        {pubSuccess && (
                            <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-800 dark:text-emerald-300 text-xs flex items-center gap-2">
                                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                                <span>Bài viết đã được xuất bản thành công tới toàn bộ cộng đồng!</span>
                            </div>
                        )}

                        {pubError && (
                            <div className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-800 dark:text-rose-300 text-xs flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                    <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
                                    <span>{pubError}</span>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setPubError(null)}
                                    className="text-rose-600 hover:text-rose-900"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        )}

                        <form onSubmit={handleOfficialPublish} className="space-y-4">
                            <div>
                                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
                                    Nội dung thông báo / bài học:
                                </label>
                                <textarea
                                    ref={pubTextareaRef}
                                    value={pubContent}
                                    onChange={(e) => setPubContent(e.target.value)}
                                    placeholder="Nội dung bài viết chính thức từ EnglishCoach (hỗ trợ #hashtag, link tự động nhận diện)..."
                                    rows={5}
                                    maxLength={5000}
                                    className="w-full bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 rounded-xl p-3 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-hidden focus:border-cyan-500 resize-none leading-relaxed"
                                />
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
                                        Loại bài viết:
                                    </label>
                                    <select
                                        value={pubType}
                                        onChange={(e) => setPubType(e.target.value as PostType)}
                                        className="w-full bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-hidden focus:border-cyan-500"
                                    >
                                        <option value="OFFICIAL">Chính thức (OFFICIAL)</option>
                                        <option value="LEARNING">Bài học (LEARNING)</option>
                                        <option value="GENERAL">Chia sẻ chung (GENERAL)</option>
                                    </select>
                                </div>

                                <div>
                                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
                                        Tên chuyên mục / Series:
                                    </label>
                                    <input
                                        type="text"
                                        value={pubSeriesName}
                                        onChange={(e) => setPubSeriesName(e.target.value)}
                                        placeholder="VD: Từ vựng mỗi ngày, Mini Grammar..."
                                        className="w-full bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-hidden focus:border-cyan-500"
                                    />
                                </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-700 dark:text-slate-300">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={pubPinned}
                                        onChange={(e) => setPubPinned(e.target.checked)}
                                        className="accent-cyan-500"
                                    />
                                    <span>Ghim lên đầu bảng tin</span>
                                </label>

                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={pubFeatured}
                                        onChange={(e) => setPubFeatured(e.target.checked)}
                                        className="accent-cyan-500"
                                    />
                                    <span>Đánh dấu nổi bật</span>
                                </label>
                            </div>

                            {/* Media Attachment (Images <= 10, Videos <= 2, Mixed media supported) */}
                            <div>
                                <input
                                    ref={imageInputRef}
                                    type="file"
                                    multiple
                                    accept=".jpg,.jpeg,.png,.webp"
                                    onChange={handleAddImages}
                                    className="hidden"
                                />
                                <input
                                    ref={videoInputRef}
                                    type="file"
                                    multiple
                                    accept=".mp4,.webm,video/mp4,video/webm"
                                    onChange={handleAddVideo}
                                    className="hidden"
                                />
                                <div className="flex items-center gap-2 flex-wrap">
                                    <button
                                        ref={pubEmojiBtnRef}
                                        type="button"
                                        onClick={handleTogglePubEmoji}
                                        disabled={pubSubmitting}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-sky-800/30 transition cursor-pointer disabled:opacity-40"
                                        title="Chèn biểu tượng cảm xúc"
                                    >
                                        <Smile className="w-3.5 h-3.5 text-amber-500" />
                                        <span>Biểu cảm</span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => imageInputRef.current?.click()}
                                        disabled={hasReachedMaxImages || pubSubmitting}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-sky-800/30 transition cursor-pointer disabled:opacity-40"
                                        title={
                                            hasReachedMaxImages
                                                ? 'Đã đạt tối đa 10 ảnh'
                                                : 'Đính kèm ảnh (tối đa 10 ảnh, 5MB/ảnh)'
                                        }
                                    >
                                        <ImageIcon className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
                                        <span>Ảnh ({imageCount}/10)</span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => videoInputRef.current?.click()}
                                        disabled={hasReachedMaxVideos || pubSubmitting}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-sky-800/30 transition cursor-pointer disabled:opacity-40"
                                        title={
                                            hasReachedMaxVideos
                                                ? 'Đã đạt tối đa 2 video'
                                                : 'Đính kèm video (tối đa 2 video, 30MB/video)'
                                        }
                                    >
                                        <VideoIcon className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                                        <span>Video ({videoCount}/2)</span>
                                    </button>
                                </div>

                                {pubAttachments.length > 0 && (
                                    <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2 mt-2.5">
                                        {pubAttachments.map((att, idx) => (
                                            <div
                                                key={idx}
                                                className="relative aspect-square rounded-xl overflow-hidden border border-slate-200 dark:border-sky-800/40 bg-slate-900/10 dark:bg-black/40 group"
                                            >
                                                {att.type === 'IMAGE' ? (
                                                    <Image
                                                        src={att.previewUrl}
                                                        alt="Preview"
                                                        fill
                                                        className="object-cover"
                                                    />
                                                ) : (
                                                    <div className="w-full h-full bg-slate-900 flex items-center justify-center">
                                                        <video
                                                            src={att.previewUrl}
                                                            className="w-full h-full object-cover"
                                                            muted
                                                        />
                                                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                                                            <Play className="w-5 h-5 text-white/90 fill-white" />
                                                        </div>
                                                        <span className="absolute bottom-1 left-1 px-1 py-0.2 rounded text-[8px] font-bold bg-black/70 text-white">
                                                            Video
                                                        </span>
                                                    </div>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => handleRemoveAttachment(idx)}
                                                    className="absolute top-1 right-1 p-1 rounded-full bg-black/70 hover:bg-rose-600 text-white transition cursor-pointer z-10"
                                                    title="Xóa"
                                                >
                                                    <X className="w-3 h-3" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="pt-2 border-t border-slate-200 dark:border-sky-900/30 flex justify-end">
                                <button
                                    type="submit"
                                    disabled={!pubContent.trim() || pubSubmitting}
                                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white dark:text-slate-950 transition shadow-md shadow-cyan-500/25 cursor-pointer disabled:opacity-40"
                                >
                                    {pubSubmitting ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            <span>Đang xuất bản...</span>
                                        </>
                                    ) : (
                                        <>
                                            <Send className="w-4 h-4" />
                                            <span>Xuất bản ngay với tư cách EnglishCoach</span>
                                        </>
                                    )}
                                </button>
                            </div>

                            {/* Official Publisher Emoji Picker */}
                            <ComposerEmojiPicker
                                isOpen={showPubEmojiPicker}
                                onClose={() => setShowPubEmojiPicker(false)}
                                onSelectEmoji={handleInsertPubEmoji}
                                anchorRect={pubEmojiAnchorRect}
                                anchorRef={pubEmojiBtnRef}
                            />
                        </form>
                    </div>

                    {/* Live Preview Box */}
                    <div className="lg:col-span-5 bg-card dark:bg-card/80 border border-border dark:border-border/60 rounded-2xl p-5 shadow-sm dark:shadow-xl space-y-3">
                        <div className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                            Xem trước bài đăng công khai
                        </div>
                        <div className="p-4 rounded-2xl bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 space-y-3">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-full p-0.5 bg-gradient-to-tr from-cyan-400 to-blue-500">
                                    <div className="w-full h-full rounded-full bg-slate-100 dark:bg-slate-900 flex items-center justify-center overflow-hidden">
                                        <Image
                                            src={echoSrc('official', 24)}
                                            alt="EnglishCoach"
                                            width={32}
                                            height={32}
                                            className="p-0.5 object-contain"
                                        />
                                    </div>
                                </div>
                                <div>
                                    <div className="flex items-center gap-1.5">
                                        <span className="font-extrabold text-slate-900 dark:text-white text-sm">
                                            EnglishCoach
                                        </span>
                                        <CheckCircle2 className="w-4 h-4 text-cyan-500 dark:text-cyan-400 fill-cyan-500/20 flex-shrink-0" />
                                    </div>
                                    <span className="text-[11px] text-slate-500 dark:text-slate-400">Vừa xong</span>
                                </div>
                            </div>

                            <p className="text-xs text-slate-700 dark:text-slate-200 whitespace-pre-wrap leading-relaxed">
                                <LinkifiedText text={pubContent.trim() || 'Nội dung bài viết sẽ hiển thị ở đây...'} />
                            </p>

                            {/* Media Preview in Box */}
                            {pubAttachments.length > 0 && (
                                <div className="grid grid-cols-2 gap-2">
                                    {pubAttachments.map((att, idx) => (
                                        <div
                                            key={idx}
                                            className="relative aspect-video rounded-xl overflow-hidden bg-slate-900/10 dark:bg-black/40 border border-slate-200 dark:border-sky-800/40"
                                        >
                                            {att.type === 'IMAGE' ? (
                                                <Image src={att.previewUrl} alt="Preview" fill className="object-cover" />
                                            ) : (
                                                <video src={att.previewUrl} className="w-full h-full object-cover" controls playsInline muted />
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* TAB: Reports List */}
            {activeTab === 'REPORTS' && (
                <div className="space-y-4">
                    {loading ? (
                        <div className="py-12 text-center text-xs text-slate-500 dark:text-slate-400 flex items-center justify-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin text-cyan-500 dark:text-cyan-400" />
                            <span>Đang tải danh sách báo cáo...</span>
                        </div>
                    ) : reports.length === 0 ? (
                        <div className="p-10 text-center bg-card dark:bg-card/80 border border-border dark:border-border/60 rounded-2xl text-xs text-slate-500 dark:text-slate-400 shadow-xs">
                            Không có báo cáo vi phạm nào cần xử lý.
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {reports.map((report) => (
                                <div
                                    key={report.id}
                                    className="p-4 rounded-2xl bg-card dark:bg-card/90 border border-rose-200 dark:border-rose-900/30 shadow-xs space-y-2"
                                >
                                    <div className="flex items-center justify-between text-xs">
                                        <span className="font-bold text-rose-600 dark:text-rose-400 flex items-center gap-1.5">
                                            <AlertTriangle className="w-4 h-4" />
                                            Lý do: {report.reason}
                                        </span>
                                        <span className="text-slate-500 dark:text-slate-400">
                                            {new Date(report.createdAt).toLocaleDateString('vi-VN')}
                                        </span>
                                    </div>
                                    {report.details && (
                                        <p className="text-xs text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-black/20 p-2 rounded-xl">
                                            {report.details}
                                        </p>
                                    )}
                                    <div className="text-xs text-slate-500 dark:text-slate-400">
                                        Post ID: #{report.postId} | Người báo cáo: User #{report.reporterId}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* TAB: Posts Moderation Stream (PENDING, PUBLISHED, REJECTED, HIDDEN) */}
            {activeTab !== 'PUBLISHER' && activeTab !== 'REPORTS' && (
                <div className="space-y-4">
                    {loading ? (
                        <div className="py-12 text-center text-xs text-slate-500 dark:text-slate-400 flex items-center justify-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin text-cyan-500 dark:text-cyan-400" />
                            <span>Đang tải danh sách bài viết...</span>
                        </div>
                    ) : posts.length === 0 ? (
                        <div className="p-10 text-center bg-card dark:bg-card/80 border border-border dark:border-border/60 rounded-2xl text-xs text-slate-500 dark:text-slate-400 shadow-xs">
                            Không có bài viết nào trong mục này.
                        </div>
                    ) : (
                        posts.map((post) => (
                            <div
                                key={post.id}
                                className="bg-card dark:bg-card/90 border border-border dark:border-border/60 rounded-2xl p-4 sm:p-5 shadow-xs dark:shadow-xl space-y-3"
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex items-center gap-3">
                                        <AuthorAvatar author={post.author} size="sm" />
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <span className="font-bold text-slate-900 dark:text-white text-sm">
                                                    {post.author.displayName || 'Học viên'}
                                                </span>
                                                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                                                    (ID: {post.author.userId})
                                                </span>
                                                {post.author.official && (
                                                    <CheckCircle2 className="w-4 h-4 text-cyan-500 fill-cyan-500/20" />
                                                )}
                                                {/* Author restriction shortcut button */}
                                                {post.author.userId && !post.author.official && (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            handleOpenRestrictionModal(
                                                                post.author.userId!,
                                                                post.author.displayName
                                                            )
                                                        }
                                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30 transition cursor-pointer"
                                                        title="Giới hạn tương tác học viên"
                                                    >
                                                        <Shield className="w-3 h-3" />
                                                        <span>Giới hạn</span>
                                                    </button>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                                                <span>
                                                    {new Date(post.createdAt).toLocaleDateString('vi-VN', {
                                                        hour: '2-digit',
                                                        minute: '2-digit',
                                                        day: '2-digit',
                                                        month: '2-digit',
                                                    })}
                                                </span>
                                                {Boolean(post.pinned) && (
                                                    <span className="inline-flex items-center gap-0.5 px-2 py-0.2 rounded-full text-[10px] font-bold bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30">
                                                        📌 Đã ghim
                                                    </span>
                                                )}
                                                {Boolean(post.featured) && (
                                                    <span className="inline-flex items-center gap-0.5 px-2 py-0.2 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                                                        ⭐ Nổi bật
                                                    </span>
                                                )}
                                                {Boolean(post.commentsLockedByAdmin) && (
                                                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[10px] font-bold bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/30">
                                                        <Lock className="w-2.5 h-2.5" />
                                                        Khóa bình luận
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Action Buttons */}
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        {post.status === 'PENDING' && (
                                            <>
                                                <button
                                                    type="button"
                                                    disabled={actionLoading === post.id}
                                                    onClick={() => handleApprove(post.id)}
                                                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition cursor-pointer shadow-xs"
                                                >
                                                    <CheckCircle className="w-3.5 h-3.5" />
                                                    <span>Duyệt</span>
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={actionLoading === post.id}
                                                    onClick={() => setRejectingPostId(post.id)}
                                                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-500 text-white transition cursor-pointer shadow-xs"
                                                >
                                                    <XCircle className="w-3.5 h-3.5" />
                                                    <span>Từ chối</span>
                                                </button>
                                            </>
                                        )}

                                        {post.status === 'PUBLISHED' && (
                                            <>
                                                {/* Toggle pin */}
                                                <button
                                                    type="button"
                                                    onClick={() => handleTogglePin(post.id, Boolean(post.pinned))}
                                                    className={`p-1.5 rounded-xl border text-xs font-semibold transition cursor-pointer ${
                                                        post.pinned
                                                            ? 'bg-cyan-50 dark:bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 border-cyan-300 dark:border-cyan-400/40'
                                                            : 'bg-slate-100 dark:bg-white/[0.04] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border-slate-200 dark:border-sky-800/30'
                                                    }`}
                                                    title={post.pinned ? 'Bỏ ghim' : 'Ghim bài'}
                                                >
                                                    <Pin className="w-4 h-4" />
                                                </button>

                                                {/* Toggle featured */}
                                                <button
                                                    type="button"
                                                    onClick={() => handleToggleFeatured(post.id, Boolean(post.featured))}
                                                    className={`p-1.5 rounded-xl border text-xs font-semibold transition cursor-pointer ${
                                                        post.featured
                                                            ? 'bg-amber-50 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-400/40'
                                                            : 'bg-slate-100 dark:bg-white/[0.04] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border-slate-200 dark:border-sky-800/30'
                                                    }`}
                                                    title={post.featured ? 'Bỏ nổi bật' : 'Đánh dấu nổi bật'}
                                                >
                                                    <Star className="w-4 h-4" />
                                                </button>

                                                {/* Lock / Unlock comments */}
                                                <button
                                                    type="button"
                                                    disabled={actionLoading === post.id}
                                                    onClick={() =>
                                                        handleToggleCommentLock(
                                                            post.id,
                                                            Boolean(post.commentsLockedByAdmin)
                                                        )
                                                    }
                                                    className={`p-1.5 rounded-xl border text-xs font-semibold transition cursor-pointer ${
                                                        post.commentsLockedByAdmin
                                                            ? 'bg-rose-50 dark:bg-rose-500/20 text-rose-600 dark:text-rose-300 border-rose-300 dark:border-rose-500/40'
                                                            : 'bg-slate-100 dark:bg-white/[0.04] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border-slate-200 dark:border-sky-800/30'
                                                    }`}
                                                    title={
                                                        post.commentsLockedByAdmin
                                                            ? 'Mở khóa bình luận'
                                                            : 'Khóa bình luận'
                                                    }
                                                >
                                                    {post.commentsLockedByAdmin ? (
                                                        <Unlock className="w-4 h-4" />
                                                    ) : (
                                                        <Lock className="w-4 h-4" />
                                                    )}
                                                </button>

                                                {/* Hide post */}
                                                <button
                                                    type="button"
                                                    disabled={actionLoading === post.id}
                                                    onClick={() => handleHide(post.id)}
                                                    className="p-1.5 rounded-xl border border-slate-200 dark:border-sky-800/30 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-amber-600 dark:hover:text-amber-400 transition cursor-pointer"
                                                    title="Ẩn bài viết"
                                                >
                                                    <EyeOff className="w-4 h-4" />
                                                </button>
                                            </>
                                        )}

                                        {post.status === 'HIDDEN' && (
                                            <button
                                                type="button"
                                                disabled={actionLoading === post.id}
                                                onClick={() => handleRestore(post.id)}
                                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-600 dark:text-cyan-300 border border-cyan-500/30 transition cursor-pointer"
                                            >
                                                <RotateCcw className="w-3.5 h-3.5" />
                                                <span>Khôi phục</span>
                                            </button>
                                        )}

                                        {/* Moderation History Audit */}
                                        <button
                                            type="button"
                                            onClick={() => handleOpenHistoryModal(post.id)}
                                            className="p-1.5 rounded-xl border border-slate-200 dark:border-sky-800/30 text-xs font-semibold text-slate-500 hover:text-cyan-600 dark:hover:text-cyan-400 transition cursor-pointer"
                                            title="Xem lịch sử kiểm duyệt"
                                        >
                                            <History className="w-4 h-4" />
                                        </button>

                                        {/* Soft / Permanent Delete */}
                                        <button
                                            type="button"
                                            disabled={actionLoading === post.id}
                                            onClick={() => handleDelete(post.id)}
                                            className="p-1.5 rounded-xl border border-slate-200 dark:border-sky-800/30 text-xs font-semibold text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition cursor-pointer"
                                            title="Xóa bài viết"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>

                                {/* Post Body */}
                                <div className="text-xs text-slate-800 dark:text-slate-200 whitespace-pre-wrap leading-relaxed">
                                    <LinkifiedText text={post.content} />
                                </div>

                                {/* Post Media */}
                                {post.media && post.media.length > 0 && (
                                    <PostMediaGallery media={post.media} />
                                )}

                                {/* Shared Embed */}
                                {post.sharedEmbed && (
                                    <SharedLearningCard embed={post.sharedEmbed} />
                                )}

                                {/* Moderation record / rejection info if available */}
                                {post.moderationNote && (
                                    <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/40 text-[11px] text-rose-700 dark:text-rose-300">
                                        <strong>Ghi chú kiểm duyệt:</strong> {post.moderationNote}
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
            )}

            {/* Rejection Reason Modal */}
            {rejectingPostId && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-card dark:bg-card border border-border dark:border-border/80 rounded-3xl w-full max-w-md p-5 space-y-4 shadow-2xl">
                        <div className="flex items-center justify-between border-b border-border dark:border-border/60 pb-3">
                            <h3 className="font-bold text-slate-900 dark:text-white text-sm">
                                Từ chối bài viết #{rejectingPostId}
                            </h3>
                            <button
                                type="button"
                                onClick={() => setRejectingPostId(null)}
                                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-xs font-bold"
                            >
                                Đóng
                            </button>
                        </div>

                        <div className="space-y-3">
                            <div>
                                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
                                    Lý do từ chối:
                                </label>
                                <select
                                    value={selectedReason}
                                    onChange={(e) => setSelectedReason(e.target.value)}
                                    className="w-full bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-hidden focus:border-cyan-500"
                                >
                                    {REJECTION_REASONS.map((r) => (
                                        <option key={r} value={r}>
                                            {r}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
                                    Ghi chú bổ sung (tùy chọn):
                                </label>
                                <textarea
                                    value={rejectNote}
                                    onChange={(e) => setRejectNote(e.target.value)}
                                    placeholder="Hướng dẫn học viên cách chỉnh sửa để được duyệt..."
                                    rows={3}
                                    maxLength={500}
                                    className="w-full bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 rounded-xl p-2.5 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-hidden focus:border-cyan-500"
                                />
                            </div>
                        </div>

                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border dark:border-border/60">
                            <button
                                type="button"
                                onClick={() => setRejectingPostId(null)}
                                className="px-3.5 py-1.5 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition"
                            >
                                Hủy
                            </button>
                            <button
                                type="button"
                                disabled={actionLoading === rejectingPostId}
                                onClick={handleConfirmReject}
                                className="px-4 py-1.5 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-500 text-white transition shadow-sm"
                            >
                                Xác nhận từ chối
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* User Restriction Modal */}
            {restrictingUser && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
                    <div className="bg-card dark:bg-card border border-border dark:border-border/80 rounded-3xl w-full max-w-xl max-h-[90vh] flex flex-col p-5 space-y-4 shadow-2xl overflow-y-auto">
                        <div className="flex items-center justify-between border-b border-border dark:border-border/60 pb-3">
                            <div>
                                <h3 className="font-bold text-slate-900 dark:text-white text-sm flex items-center gap-2">
                                    <Shield className="w-4 h-4 text-amber-500" />
                                    <span>Giới hạn tương tác học viên: {restrictingUser.displayName}</span>
                                </h3>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                    User ID: #{restrictingUser.userId} (Chỉ áp dụng trong Cộng đồng, không khóa toàn bộ tài khoản)
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setRestrictingUser(null)}
                                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {loadingRestrictionData ? (
                            <div className="py-8 flex items-center justify-center gap-2 text-xs text-slate-500">
                                <Loader2 className="w-4 h-4 animate-spin text-cyan-500" />
                                <span>Đang tải thông tin giới hạn...</span>
                            </div>
                        ) : (
                            <div className="space-y-4 text-xs">
                                {/* Current Active Restriction */}
                                {activeUserRestriction && activeUserRestriction.active ? (
                                    <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-900 dark:text-amber-200 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <span className="font-bold flex items-center gap-1.5">
                                                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                                                Đang bị giới hạn: {activeUserRestriction.restrictionType}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => handleRevokeRestriction(activeUserRestriction.id)}
                                                className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-rose-600 hover:bg-rose-500 text-white transition cursor-pointer"
                                            >
                                                Gỡ bỏ giới hạn sớm
                                            </button>
                                        </div>
                                        <p className="text-[11px] text-slate-700 dark:text-slate-300">
                                            <strong>Lý do:</strong> {activeUserRestriction.reason}
                                        </p>
                                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                            <strong>Thời hạn:</strong>{' '}
                                            {activeUserRestriction.expiresAt
                                                ? `Đến ${new Date(activeUserRestriction.expiresAt).toLocaleString('vi-VN')}`
                                                : 'Vĩnh viễn'}
                                        </p>
                                    </div>
                                ) : (
                                    <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-800 dark:text-emerald-300">
                                        Học viên hiện không có giới hạn nào đang hoạt động.
                                    </div>
                                )}

                                {/* Apply New Restriction Form */}
                                <div className="space-y-3 pt-2 border-t border-border dark:border-border/60">
                                    <h4 className="font-bold text-slate-900 dark:text-white">
                                        Áp dụng giới hạn mới
                                    </h4>

                                    <div>
                                        <label className="font-semibold text-slate-700 dark:text-slate-300 block mb-1">
                                            Loại hình giới hạn:
                                        </label>
                                        <select
                                            value={restrictionType}
                                            onChange={(e) =>
                                                setRestrictionType(e.target.value as CommunityRestrictionType)
                                            }
                                            className="w-full bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 rounded-xl px-3 py-2 text-slate-900 dark:text-white focus:outline-hidden focus:border-cyan-500"
                                        >
                                            <option value="READ_ONLY">
                                                READ_ONLY: Chỉ xem (không đăng bài, không bình luận)
                                            </option>
                                            <option value="NO_POST">
                                                NO_POST: Chặn đăng bài (vẫn được bình luận)
                                            </option>
                                            <option value="NO_COMMENT">
                                                NO_COMMENT: Chặn bình luận (vẫn được đăng bài)
                                            </option>
                                            <option value="SUSPEND_COMMUNITY">
                                                SUSPEND_COMMUNITY: Đình chỉ toàn bộ tương tác Cộng đồng
                                            </option>
                                        </select>
                                    </div>

                                    <div className="grid grid-cols-2 gap-2">
                                        <div>
                                            <label className="font-semibold text-slate-700 dark:text-slate-300 block mb-1">
                                                Thời hạn giới hạn:
                                            </label>
                                            <select
                                                value={durationOption}
                                                onChange={(e) => setDurationOption(e.target.value as any)}
                                                className="w-full bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 rounded-xl px-3 py-2 text-slate-900 dark:text-white focus:outline-hidden focus:border-cyan-500"
                                            >
                                                <option value="1">1 ngày</option>
                                                <option value="3">3 ngày</option>
                                                <option value="7">7 ngày</option>
                                                <option value="30">30 ngày</option>
                                                <option value="CUSTOM">Tùy chỉnh số ngày</option>
                                                <option value="PERMANENT">Vĩnh viễn (Permanent)</option>
                                            </select>
                                        </div>

                                        {durationOption === 'CUSTOM' && (
                                            <div>
                                                <label className="font-semibold text-slate-700 dark:text-slate-300 block mb-1">
                                                    Số ngày:
                                                </label>
                                                <input
                                                    type="number"
                                                    min="1"
                                                    max="365"
                                                    value={customDays}
                                                    onChange={(e) => setCustomDays(e.target.value)}
                                                    className="w-full bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 rounded-xl px-3 py-2 text-slate-900 dark:text-white focus:outline-hidden focus:border-cyan-500"
                                                />
                                            </div>
                                        )}
                                    </div>

                                    <div>
                                        <label className="font-semibold text-slate-700 dark:text-slate-300 block mb-1">
                                            Lý do áp dụng (bắt buộc):
                                        </label>
                                        <textarea
                                            value={restrictionReason}
                                            onChange={(e) => setRestrictionReason(e.target.value)}
                                            placeholder="Ghi rõ lý do vi phạm (VD: Spam bình luận bán hàng, ngôn từ công kích...)"
                                            rows={2}
                                            maxLength={500}
                                            className="w-full bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 rounded-xl p-2.5 text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-hidden focus:border-cyan-500"
                                        />
                                    </div>

                                    <div className="flex justify-end pt-1">
                                        <button
                                            type="button"
                                            disabled={!restrictionReason.trim() || submittingRestriction}
                                            onClick={handleCreateRestriction}
                                            className="px-4 py-2 rounded-xl font-bold bg-amber-600 hover:bg-amber-500 text-white transition shadow-sm disabled:opacity-40 cursor-pointer"
                                        >
                                            {submittingRestriction ? 'Đang lưu...' : 'Xác nhận áp dụng giới hạn'}
                                        </button>
                                    </div>
                                </div>

                                {/* Audit History */}
                                {userRestrictionHistory.length > 0 && (
                                    <div className="pt-3 border-t border-border dark:border-border/60 space-y-2">
                                        <h4 className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                                            <History className="w-3.5 h-3.5 text-slate-500" />
                                            <span>Lịch sử các lần giới hạn trước đây</span>
                                        </h4>
                                        <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                                            {userRestrictionHistory.map((item) => (
                                                <div
                                                    key={item.id}
                                                    className="p-2 rounded-xl bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 text-[11px] space-y-0.5"
                                                >
                                                    <div className="flex items-center justify-between font-semibold">
                                                        <span>{item.restrictionType}</span>
                                                        <span
                                                            className={
                                                                item.active ? 'text-amber-500' : 'text-slate-400'
                                                            }
                                                        >
                                                            {item.active
                                                                ? 'Đang hiệu lực'
                                                                : item.revokedAt
                                                                ? 'Đã gỡ bỏ'
                                                                : 'Đã hết hạn'}
                                                        </span>
                                                    </div>
                                                    <div className="text-slate-600 dark:text-slate-300">
                                                        {item.reason}
                                                    </div>
                                                    <div className="text-[10px] text-slate-400">
                                                        Tạo lúc: {new Date(item.createdAt).toLocaleString('vi-VN')}
                                                        {item.expiresAt &&
                                                            ` • Hết hạn: ${new Date(item.expiresAt).toLocaleDateString('vi-VN')}`}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Post Moderation History Modal */}
            {historyPostId && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-card dark:bg-card border border-border dark:border-border/80 rounded-3xl w-full max-w-md p-5 space-y-4 shadow-2xl">
                        <div className="flex items-center justify-between border-b border-border dark:border-border/60 pb-3">
                            <h3 className="font-bold text-slate-900 dark:text-white text-sm flex items-center gap-2">
                                <History className="w-4 h-4 text-cyan-500" />
                                <span>Lịch sử kiểm duyệt bài viết #{historyPostId}</span>
                            </h3>
                            <button
                                type="button"
                                onClick={() => setHistoryPostId(null)}
                                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {loadingHistory ? (
                            <div className="py-8 flex items-center justify-center gap-2 text-xs text-slate-500">
                                <Loader2 className="w-4 h-4 animate-spin text-cyan-500" />
                                <span>Đang tải lịch sử...</span>
                            </div>
                        ) : postModerationHistory.length === 0 ? (
                            <div className="py-6 text-center text-xs text-slate-500">
                                Chưa có ghi nhận kiểm duyệt nào cho bài viết này.
                            </div>
                        ) : (
                            <div className="space-y-2 max-h-60 overflow-y-auto">
                                {postModerationHistory.map((rec) => (
                                    <div
                                        key={rec.id}
                                        className="p-2.5 rounded-xl bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 text-xs space-y-1"
                                    >
                                        <div className="flex items-center justify-between font-bold">
                                            <span className="text-cyan-700 dark:text-cyan-300">
                                                {rec.action}
                                            </span>
                                            <span className="text-[10px] text-slate-400">
                                                {new Date(rec.createdAt).toLocaleString('vi-VN')}
                                            </span>
                                        </div>
                                        {rec.reason && (
                                            <div className="text-slate-700 dark:text-slate-300 text-[11px]">
                                                <strong>Lý do:</strong> {rec.reason}
                                            </div>
                                        )}
                                        {rec.note && (
                                            <div className="text-slate-500 text-[11px]">
                                                <strong>Ghi chú:</strong> {rec.note}
                                            </div>
                                        )}
                                        <div className="text-[10px] text-slate-400">
                                            Thực hiện bởi Admin #{rec.moderatorId}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
