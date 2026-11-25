"use client";

import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useMorphPresence } from '@/components/morph/useMorphPresence';
import { X, Loader2, AlertCircle, FileText, MonitorPlay } from "lucide-react";
import { getListeningMaterialById, revalidatePersonalListeningLibrary } from "@/services/listeningApi";
import { useSession } from 'next-auth/react';
import { activeYouTubeJob, createYouTubeJob, recentYouTubeJobs, getYouTubeJob, cancelYouTubeJob, youTubeStageLabel, type ListeningYouTubeJob } from '@/services/listeningYouTubeJobsApi';
import { DocumentImportForm } from "./DocumentImportForm";
import type { ListeningMaterialDetail } from "@/types/listening";
import { useLanguage } from "@/context/LanguageContext";
import { glass as s, categoryLabel } from "./glass/ListeningGlass";
import { echoSrc } from '@/lib/brand/echoCharacters';

interface ImportMaterialModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Receives the personal material created by the server (owner = authenticated user). */
    onSuccess: (created: ListeningMaterialDetail) => void;
}

const importingJob = (job: ListeningYouTubeJob | null) => !!job && activeYouTubeJob(job);

export function ImportMaterialModal({ isOpen, onClose, onSuccess }: ImportMaterialModalProps) {
    const { locale } = useLanguage();
    const { data: session } = useSession();
    const owner = (session?.user as { id?: string } | undefined)?.id;
    const [job, setJob] = useState<ListeningYouTubeJob | null>(null);
    const [recent, setRecent] = useState<ListeningYouTubeJob[]>([]);
    const [connectionLost, setConnectionLost] = useState(false);
    const busy = importingJob(job);
    const onSuccessRef = useRef(onSuccess);
    onSuccessRef.current = onSuccess;
    const [method, setMethod] = useState<"youtube" | "document">("youtube");
    const [documentBusy, setDocumentBusy] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [importUrl, setImportUrl] = useState("");
    const [importTitle, setImportTitle] = useState("");
    const [importCefr, setImportCefr] = useState("B1");
    const [importAccent, setImportAccent] = useState("American");
    const [importTopic, setImportTopic] = useState("General");
    const [importing, setImporting] = useState(false);
    const [importError, setImportError] = useState<string | null>(null);
    // Synchronous guard: a double-click can fire twice before `importing` re-renders the disabled button.
    const inFlightRef = useRef(false);
    const dialogRef = useRef<HTMLDivElement>(null);
    const presence = useMorphPresence(isOpen && mounted, dialogRef);

    useEffect(() => {
        if (!isOpen || !mounted) return;
        const previous = document.activeElement as HTMLElement | null;
        dialogRef.current?.focus();
        return () => previous?.focus();
    }, [isOpen, mounted]);

    useEffect(() => {
        setMounted(true);
    }, []);

    // Lock background page scroll when modal is open
    useEffect(() => {
        if (isOpen) {
            const originalOverflow = document.body.style.overflow;
            document.body.style.overflow = "hidden";
            return () => {
                document.body.style.overflow = originalOverflow;
            };
        }
    }, [isOpen]);

    // Receipts are recovered from the authenticated server, including after navigation/reload. No private storage pointer.
    useEffect(() => {
        if (!isOpen || !owner) return;
        let disposed = false;
        recentYouTubeJobs().then(jobs => {
            if (disposed) return;
            setRecent(jobs);
            const active = jobs.find(activeYouTubeJob);
            if (active) setJob(active);
        }).catch(() => { if (!disposed) setConnectionLost(true); });
        return () => { disposed = true; };
    }, [isOpen, owner]);

    useEffect(() => {
        if (!isOpen || !owner || !job || !activeYouTubeJob(job)) return;
        let disposed = false, attempts = 0, failures = 0;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            if (disposed) return;
            if (document.hidden) { timer = setTimeout(poll, 5000); return; }
            try {
                const next = await getYouTubeJob(job.id);
                if (disposed) return;
                failures = 0; setConnectionLost(false);
                if (next.status === 'READY' && next.materialId) {
                    const created = await getListeningMaterialById(next.materialId);
                    if (disposed) return;
                    void revalidatePersonalListeningLibrary();
                    setJob(next);
                    onSuccessRef.current(created);
                    return;
                }
                setJob(next);
                if (next.status === 'FAILED') setImportError(next.message);
                if (!activeYouTubeJob(next)) return;
            } catch { if (disposed) return; failures++; setConnectionLost(true); }
            if (++attempts < 600) timer = setTimeout(poll, Math.min(30000, 2000 * 2 ** Math.min(failures, 4)));
            else setConnectionLost(true);
        };
        timer = setTimeout(poll, 1500);
        return () => { disposed = true; clearTimeout(timer); };
    }, [isOpen, owner, job?.id, busy]);

    if (!presence.present || !mounted || typeof window === "undefined") return null;

    const resetForm = () => {
        setImportUrl("");
        setImportTitle("");
        setImportCefr("B1");
        setImportAccent("American");
        setImportTopic("General");
        setImportError(null);
    };

    const handleClose = () => {
        resetForm();
        setDocumentBusy(false);
        setMethod("youtube");
        onClose();
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!importUrl.trim() || inFlightRef.current) return;
        inFlightRef.current = true;
        setImporting(true);
        setImportError(null);
        try {
            const accepted = await createYouTubeJob({
                youtubeUrl: importUrl.trim(),
                title: importTitle.trim() || undefined,
                cefrLevel: importCefr,
                accent: importAccent,
                topic: importTopic,
            });
            setJob(accepted);
            setConnectionLost(false);
            if (accepted.status === 'READY' && accepted.materialId) {
                const created = await getListeningMaterialById(accepted.materialId);
                onSuccessRef.current(created);
                void revalidatePersonalListeningLibrary();
            }
        } catch (err: any) {
            console.error("YouTube import failed:", err);
            const status = err?.response?.status;
            let message =
                err?.response?.data?.message ||
                err?.response?.data?.detail;

            if (!message) {
                if (status === 503) {
                    message = "Không thể xử lý video lúc này. Dịch vụ xử lý âm thanh đang tạm thời không khả dụng. Vui lòng thử lại sau.";
                } else {
                    message = err?.message || "Không thể trích xuất video YouTube. Vui lòng kiểm tra lại URL hợp lệ và video có sẵn phụ đề/âm thanh rõ ràng.";
                }
            }
            setImportError(message);
        } finally {
            inFlightRef.current = false;
            setImporting(false);
        }
    };

    return createPortal(
        <div
            className="fixed inset-0 z-[100000] w-screen h-screen flex items-center justify-center p-3 sm:p-4 bg-slate-950/75 animate-in fade-in duration-200"
            style={{ position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh" }}
            onClick={handleClose}
        >
            <div
                className={`${s.modal} animate-in zoom-in-95 duration-200`}
                role="dialog" aria-modal="true" aria-labelledby="listening-import-title"
                {...presence.panelProps}
                ref={dialogRef} tabIndex={-1}
                onKeyDown={e => {
                    if (e.key === 'Escape') { e.preventDefault(); handleClose(); }
                    if (e.key !== 'Tab') return;
                    const items = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]');
                    if (!items?.length) return;
                    const first=items[0], last=items[items.length-1];
                    if (e.shiftKey && (document.activeElement===first || document.activeElement===dialogRef.current)) {e.preventDefault();last.focus();}
                    else if (!e.shiftKey && document.activeElement===last) {e.preventDefault();first.focus();}
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header band over the Kho Listening scene */}
                <div className={s.modalBand}>
                    <span className={s.modalGlyph} aria-hidden="true">
                        <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                            <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                        </svg>
                    </span>
                    <h2 id="listening-import-title">Import</h2>
                    <p>Trích xuất âm thanh và đồng bộ transcript tự động</p>
                    <button
                        type="button"
                        onClick={handleClose}
                        className={s.modalClose}
                        aria-label="Đóng"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className={s.methods} role="tablist" aria-label="Import" data-guide="li-methods">
                    <button type="button" role="tab" aria-selected={method === "youtube"} disabled={importing || busy || documentBusy} onClick={() => setMethod("youtube")} className={s.method}>
                        <MonitorPlay size={16} aria-hidden="true" />YouTube
                    </button>
                    <button type="button" role="tab" aria-selected={method === "document"} disabled={importing || busy || documentBusy} onClick={() => setMethod("document")} className={s.method}>
                        <FileText size={16} aria-hidden="true" />{locale === 'vi' ? 'Văn bản / Tài liệu' : 'Text / Document'}
                    </button>
                </div>
                {method === "document" ? <DocumentImportForm onSuccess={onSuccess} onBusy={setDocumentBusy}/> : <>
                {importError && (
                    <div className={s.notice} data-kind="error" role="alert">
                        <AlertCircle size={16} />
                        <span>{importError}</span>
                    </div>
                )}

                {(job || recent.length > 0 || connectionLost) && <div className={s.notice} role="status" aria-live="polite">
                    <div>
                        {job && <p>{youTubeStageLabel(job, locale === 'vi')}</p>}
                        {connectionLost && <p>{locale === 'vi' ? 'Đang thử kết nối lại. Tác vụ được giữ trên máy chủ.' : 'Reconnecting. Your job is retained on the server.'}</p>}
                        {job && busy && <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={async () => {
                            try { setJob(await cancelYouTubeJob(job.id)); }
                            catch { setConnectionLost(true); }
                        }}>{locale === 'vi' ? 'Hủy tác vụ' : 'Cancel import'}</button>}
                        {recent.filter(j => j.status === 'READY' && j.materialId).slice(0, 3).map(j => <p key={j.id}>
                            <a href={`/listening/${j.materialId}`}>{locale === 'vi' ? 'Mở bài nghe đã tạo' : 'Open completed lesson'} · #{j.materialId}</a>
                        </p>)}
                    </div>
                </div>}
                <form onSubmit={handleSubmit} className={s.form}>
                    <div>
                        <label htmlFor="listening-import-url" className={s.fieldLabel}>
                            YouTube URL <em>*</em>
                        </label>
                        <input
                            id="listening-import-url"
                            type="text"
                            required
                            placeholder="https://www.youtube.com/watch?v=..."
                            value={importUrl}
                            onChange={(e) => setImportUrl(e.target.value)}
                            disabled={importing || busy}
                            className={s.input}
                        />
                    </div>

                    <div>
                        <label htmlFor="listening-import-title-input" className={s.fieldLabel}>
                            TÊN BÀI NGHE (TÙY CHỌN) <small>(Để trống để dùng tên gốc của video YouTube.)</small>
                        </label>
                        <input
                            id="listening-import-title-input"
                            type="text"
                            placeholder="Nhập tên bạn muốn hiển thị..."
                            value={importTitle}
                            onChange={(e) => setImportTitle(e.target.value)}
                            disabled={importing || busy}
                            className={s.input}
                        />
                    </div>

                    <div className={s.formGrid}>
                        <div>
                            <label htmlFor="listening-import-cefr" className={s.fieldLabel}>
                                Cấp độ CEFR
                            </label>
                            <select
                                id="listening-import-cefr"
                                value={importCefr}
                                onChange={(e) => setImportCefr(e.target.value)}
                                disabled={importing || busy}
                                className={s.select}
                            >
                                <option value="A1">A1 Beginner</option>
                                <option value="A2">A2 Elementary</option>
                                <option value="B1">B1 Intermediate</option>
                                <option value="B2">B2 Upper-Int</option>
                                <option value="C1">C1 Advanced</option>
                                <option value="C2">C2 Mastery</option>
                            </select>
                        </div>

                        <div>
                            <label htmlFor="listening-import-accent" className={s.fieldLabel}>
                                Giọng bản xứ
                            </label>
                            <select
                                id="listening-import-accent"
                                value={importAccent}
                                onChange={(e) => setImportAccent(e.target.value)}
                                disabled={importing || busy}
                                className={s.select}
                            >
                                <option value="American">American</option>
                                <option value="British">British</option>
                                <option value="Australian">Australian</option>
                                <option value="Canadian">Canadian</option>
                            </select>
                        </div>

                        <div>
                            <label htmlFor="listening-import-topic" className={s.fieldLabel}>
                                Chủ đề
                            </label>
                            <select
                                id="listening-import-topic"
                                value={importTopic}
                                onChange={(e) => setImportTopic(e.target.value)}
                                disabled={importing || busy}
                                className={s.select}
                            >
                                <option value="Ideas & Talks">{categoryLabel("Ideas & Talks", locale === 'vi')}</option>
                                <option value="Everyday English">{categoryLabel("Everyday English", locale === 'vi')}</option>
                                <option value="Science & Tech">{categoryLabel("Science & Tech", locale === 'vi')}</option>
                                <option value="Work & Study">{categoryLabel("Work & Study", locale === 'vi')}</option>
                                <option value="Culture & Travel">{categoryLabel("Culture & Travel", locale === 'vi')}</option>
                                <option value="News & Podcasts">{categoryLabel("News & Podcasts", locale === 'vi')}</option>
                                <option value="General">{locale === 'vi' ? 'Tổng hợp (General)' : 'General'}</option>
                            </select>
                        </div>
                    </div>

                    <div className={s.modalFoot}>
                        <button
                            type="button"
                            onClick={handleClose}
                            className={`${s.btn} ${s.btnGhost}`}
                        >
                            {busy ? (locale === 'vi' ? 'Đóng cửa sổ' : 'Close window') : (locale === 'vi' ? 'Hủy bỏ' : 'Cancel')}
                        </button>
                        <button
                            type="submit"
                            disabled={importing || busy || !importUrl.trim()}
                            className={`${s.btn} ${s.btnPrimary}`}
                        >
                            {importing || busy ? (
                                <>
                                    <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />
                                    <span>{job && busy ? youTubeStageLabel(job, locale === 'vi') : (locale === 'vi' ? 'Đang gửi yêu cầu...' : 'Submitting...')}</span>
                                </>
                            ) : (
                                <>
                                    <img
                                        src={echoSrc('scholar', 24)}
                                        alt="Echo"
                                        width={16}
                                        height={16}
                                        className="w-4 h-4 object-contain shrink-0 select-none pointer-events-none brightness-0 invert"
                                    />
                                    <span>Bắt đầu Import</span>
                                </>
                            )}
                        </button>
                    </div>
                    {(importing || busy) && (
                        <p className={s.hint} role="status">
                            {locale === 'vi' ? 'Bạn có thể đóng cửa sổ hoặc chuyển trang. Mở Import để xem lại tác vụ.' : 'You can close this window or navigate away. Open Import to resume checking this job.'}
                        </p>
                    )}
                </form>
                </>}
            </div>
        </div>,
        document.body
    );
}
