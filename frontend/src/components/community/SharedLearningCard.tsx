'use client'

import React, { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Headphones, Layers, Award, ExternalLink, BookmarkPlus, Check, GraduationCap } from 'lucide-react'
import { SharedLearningEmbed } from '@/types/community'
import { apiClient } from '@/services/api-client'

interface SharedLearningCardProps {
    embed: SharedLearningEmbed
}

export function SharedLearningCard({ embed }: SharedLearningCardProps) {
    const [savedFlashcard, setSavedFlashcard] = useState(false)
    const [saving, setSaving] = useState(false)

    const handleSaveFlashcard = async (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (savedFlashcard || saving) return

        try {
            setSaving(true)
            const word = embed.metadata?.word || embed.title
            const definition = embed.metadata?.definition || embed.subtitle || ''
            const example = embed.metadata?.example || ''

            await apiClient.post('/flashcards', {
                front: word,
                back: definition,
                example: example,
            })
            setSavedFlashcard(true)
        } catch (err: any) {
            // never shown as saved when the server did not store it (a word already saved answers 200, not an error)
            console.error('Failed to save flashcard', err?.response?.status ?? err?.message)
            const reason = typeof err?.response?.data?.message === 'string' && err.response.status < 500 ? err.response.data.message : ''
            window.alert(reason ? `Chưa lưu được Flashcard: ${reason}` : 'Chưa lưu được Flashcard. Hãy thử lại.')
        } finally {
            setSaving(false)
        }
    }

    if (embed.entityType === 'LISTENING_MATERIAL') {
        return (
            <div className="mt-3 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-gradient-to-r from-amber-50 to-amber-100/50 dark:from-amber-950/30 dark:to-amber-900/10 p-3.5 flex flex-col sm:flex-row items-start sm:items-center gap-3.5 transition-all hover:border-amber-400 dark:hover:border-amber-500/50 shadow-xs">
                {embed.thumbnailUrl ? (
                    <div className="relative w-full sm:w-28 h-20 rounded-xl overflow-hidden shrink-0 bg-slate-900/10 dark:bg-black/40">
                        <Image
                            src={embed.thumbnailUrl}
                            alt={embed.title}
                            fill
                            sizes="112px"
                            className="object-cover"
                        />
                        <div className="absolute inset-0 bg-black/20 flex items-center justify-center">
                            <Headphones className="w-6 h-6 text-white drop-shadow" />
                        </div>
                    </div>
                ) : (
                    <div className="w-12 h-12 rounded-xl bg-amber-100 dark:bg-amber-500/20 border border-amber-200 dark:border-amber-500/40 flex items-center justify-center shrink-0 text-amber-700 dark:text-amber-400">
                        <Headphones className="w-6 h-6" />
                    </div>
                )}
                <div className="min-w-0 flex-1">
                    <div className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wider">
                        <Headphones className="w-3 h-3" />
                        Luyện Nghe
                    </div>
                    <h4 className="font-bold text-slate-900 dark:text-white text-sm tracking-tight truncate mt-0.5">
                        {embed.title}
                    </h4>
                    {embed.subtitle && (
                        <p className="text-xs text-slate-600 dark:text-slate-300/80 truncate mt-0.5">
                            {embed.subtitle}
                        </p>
                    )}
                </div>
                <Link
                    href={embed.actionUrl}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-400 text-slate-950 transition-all shadow-md shadow-amber-500/20 shrink-0"
                >
                    {embed.actionLabel || 'Luyện nghe ngay'}
                    <ExternalLink className="w-3.5 h-3.5" />
                </Link>
            </div>
        )
    }

    if (embed.entityType === 'FLASHCARD_DECK') {
        const hasWordData = embed.metadata?.word
        return (
            <div className="mt-3 rounded-2xl border border-cyan-200 dark:border-cyan-500/30 bg-gradient-to-r from-cyan-50 to-sky-100/50 dark:from-cyan-950/30 dark:to-sky-900/10 p-3.5 flex flex-col sm:flex-row items-start sm:items-center gap-3.5 transition-all hover:border-cyan-400 dark:hover:border-cyan-500/50 shadow-xs">
                <div className="w-12 h-12 rounded-xl bg-cyan-100 dark:bg-cyan-500/20 border border-cyan-200 dark:border-cyan-500/40 flex items-center justify-center shrink-0 text-cyan-700 dark:text-cyan-400">
                    <Layers className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="inline-flex items-center gap-1 text-[11px] font-bold text-cyan-700 dark:text-cyan-400 uppercase tracking-wider">
                        <Layers className="w-3 h-3" />
                        Thẻ Từ Vựng
                    </div>
                    <h4 className="font-bold text-slate-900 dark:text-white text-sm tracking-tight truncate mt-0.5">
                        {embed.title}
                    </h4>
                    {embed.subtitle && (
                        <p className="text-xs text-slate-600 dark:text-slate-300/80 truncate mt-0.5">
                            {embed.subtitle}
                        </p>
                    )}
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
                    {hasWordData && (
                        <button
                            type="button"
                            onClick={handleSaveFlashcard}
                            disabled={savedFlashcard || saving}
                            className={`flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all shadow-xs cursor-pointer ${
                                savedFlashcard
                                    ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-500/40'
                                    : 'bg-white dark:bg-white/10 hover:bg-slate-100 dark:hover:bg-white/20 text-slate-800 dark:text-white border border-slate-300 dark:border-white/20'
                            }`}
                        >
                            {savedFlashcard ? (
                                <>
                                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                                    Đã lưu
                                </>
                            ) : (
                                <>
                                    <BookmarkPlus className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400" />
                                    {saving ? 'Đang lưu...' : 'Lưu Flashcard'}
                                </>
                            )}
                        </button>
                    )}
                    <Link
                        href={embed.actionUrl}
                        className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition-all shadow-md shadow-cyan-500/20"
                    >
                        {embed.actionLabel || 'Xem bộ thẻ'}
                        <ExternalLink className="w-3.5 h-3.5" />
                    </Link>
                </div>
            </div>
        )
    }

    if (embed.entityType === 'EXAM_RESULT') {
        return (
            <div className="mt-3 rounded-2xl border border-purple-200 dark:border-purple-500/30 bg-gradient-to-r from-purple-50 to-indigo-100/50 dark:from-purple-950/30 dark:to-indigo-900/10 p-3.5 flex flex-col sm:flex-row items-start sm:items-center gap-3.5 transition-all hover:border-purple-400 dark:hover:border-purple-500/50 shadow-xs">
                <div className="w-12 h-12 rounded-xl bg-purple-100 dark:bg-purple-500/20 border border-purple-200 dark:border-purple-500/40 flex items-center justify-center shrink-0 text-purple-700 dark:text-purple-400">
                    <Award className="w-6 h-6" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="inline-flex items-center gap-1 text-[11px] font-bold text-purple-700 dark:text-purple-400 uppercase tracking-wider">
                        <GraduationCap className="w-3.5 h-3.5" />
                        Kết Quả Thi Thử
                    </div>
                    <h4 className="font-bold text-slate-900 dark:text-white text-sm tracking-tight truncate mt-0.5">
                        {embed.title}
                    </h4>
                    {embed.subtitle && (
                        <p className="text-xs text-slate-600 dark:text-slate-300/80 truncate mt-0.5">
                            {embed.subtitle}
                        </p>
                    )}
                </div>
                <Link
                    href={embed.actionUrl}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold bg-purple-500 hover:bg-purple-400 text-white transition-all shadow-md shadow-purple-500/20 shrink-0"
                >
                    {embed.actionLabel || 'Xem bài thi'}
                    <ExternalLink className="w-3.5 h-3.5" />
                </Link>
            </div>
        )
    }

    return null
}
