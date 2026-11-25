'use client'

import React, { useState } from 'react'
import { X, AlertTriangle, ShieldCheck } from 'lucide-react'
import { ReportReason } from '@/types/community'
import { communityApi } from '@/services/communityApi'
import styles from './communityGlass.module.css'
import { useMorphPresence } from '@/components/morph/useMorphPresence'

interface ReportModalProps {
    postId: number
    isOpen: boolean
    onClose: () => void
}

const REPORT_REASONS: { key: ReportReason; label: string; desc: string }[] = [
    { key: 'SPAM', label: 'Spam', desc: 'Nội dung rác, lặp lại nhiều lần hoặc tin giả' },
    { key: 'HARASSMENT', label: 'Quấy rối', desc: 'Công kích cá nhân, xúc phạm hoặc đe dọa' },
    { key: 'INAPPROPRIATE', label: 'Nội dung không phù hợp', desc: 'Ngôn từ phản cảm, đồi trụy hoặc thô tục' },
    { key: 'MISINFORMATION', label: 'Thông tin sai lệch', desc: 'Sai kiến thức ngữ pháp/từ vựng nghiêm trọng' },
    { key: 'ADVERTISEMENT', label: 'Quảng cáo trái phép', desc: 'Quảng cáo dịch vụ, khóa học ngoài hoặc link lừa đảo' },
    { key: 'OTHER', label: 'Khác', desc: 'Lý do vi phạm tiêu chuẩn cộng đồng khác' },
]

export function ReportModal({ postId, isOpen, onClose }: ReportModalProps) {
    const [selectedReason, setSelectedReason] = useState<ReportReason>('SPAM')
    const [details, setDetails] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [submitted, setSubmitted] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const panelRef = React.useRef<HTMLDivElement>(null)
    const presence = useMorphPresence(isOpen, panelRef)

    if (!presence.present) return null

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setSubmitting(true)
        setError(null)
        try {
            await communityApi.reportPost(postId, selectedReason, details.trim() || undefined)
            setSubmitted(true)
            setTimeout(() => {
                onClose()
                setSubmitted(false)
            }, 1500)
        } catch (err: any) {
            console.error('Failed to submit report', err)
            setError(err?.response?.data?.message || 'Không thể gửi báo cáo. Vui lòng thử lại.')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className={`${styles.world} fixed inset-0 z-50 bg-black/60 dark:bg-black/80 flex items-center justify-center p-4 animate-in fade-in duration-200`}>
            <div
                ref={panelRef}
                {...presence.panelProps}
                className="bg-card dark:bg-card border border-border dark:border-border/80 rounded-2xl max-w-md w-full p-5 shadow-2xl text-slate-800 dark:text-slate-200 relative animate-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-border dark:border-border/60 pb-3 mb-4">
                    <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 font-bold text-base">
                        <AlertTriangle className="w-5 h-5" />
                        Báo cáo bài viết
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {submitted ? (
                    <div className="py-8 text-center space-y-3">
                        <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto border border-emerald-300 dark:border-emerald-500/40">
                            <ShieldCheck className="w-6 h-6" />
                        </div>
                        <h4 className="font-bold text-slate-900 dark:text-white text-base">Đã ghi nhận báo cáo</h4>
                        <p className="text-xs text-slate-600 dark:text-slate-300">
                            Cảm ơn bạn đã chung tay bảo vệ môi trường học tập lành mạnh tại EnglishCoach.
                        </p>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block">
                                Chọn lý do báo cáo:
                            </label>
                            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                                {REPORT_REASONS.map((r) => (
                                    <label
                                        key={r.key}
                                        className={[
                                            'flex items-start gap-3 p-2.5 rounded-xl border cursor-pointer transition-all',
                                            selectedReason === r.key
                                                ? 'bg-rose-50 border-rose-400 text-rose-950 dark:bg-rose-500/10 dark:border-rose-500/50 dark:text-white'
                                                : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100 dark:bg-white/[0.02] dark:border-sky-900/30 dark:text-slate-300 dark:hover:bg-white/[0.05]',
                                        ].join(' ')}
                                    >
                                        <input
                                            type="radio"
                                            name="reason"
                                            value={r.key}
                                            checked={selectedReason === r.key}
                                            onChange={() => setSelectedReason(r.key)}
                                            className="mt-0.5 accent-rose-500"
                                        />
                                        <div className="min-w-0">
                                            <div className="text-xs font-bold">{r.label}</div>
                                            <div className="text-[11px] text-slate-500 dark:text-slate-400">{r.desc}</div>
                                        </div>
                                    </label>
                                ))}
                            </div>
                        </div>

                        <div>
                            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1">
                                Chi tiết bổ sung (tùy chọn):
                            </label>
                            <textarea
                                value={details}
                                onChange={(e) => setDetails(e.target.value)}
                                rows={2}
                                maxLength={500}
                                placeholder="Mô tả cụ thể vấn đề để ban quản trị xử lý nhanh hơn..."
                                className="w-full bg-surface-container-low dark:bg-surface-container-lowest border border-border dark:border-border/60 rounded-xl p-2.5 text-xs text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-hidden focus:border-rose-500"
                            />
                        </div>

                        {error && (
                            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 p-2 rounded-xl">
                                {error}
                            </div>
                        )}

                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border dark:border-border/60">
                            <button
                                type="button"
                                onClick={onClose}
                                disabled={submitting}
                                className="px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition cursor-pointer"
                            >
                                Hủy
                            </button>
                            <button
                                type="submit"
                                disabled={submitting}
                                className="px-4 py-2 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-500 text-white transition shadow-md shadow-rose-600/30 disabled:opacity-50 cursor-pointer"
                            >
                                {submitting ? 'Đang gửi...' : 'Gửi báo cáo'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    )
}
