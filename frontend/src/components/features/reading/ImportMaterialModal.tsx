"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { X, UploadCloud, FileText, Loader2, Image as ImageIcon, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/services/api-client";
import { useLanguage } from "@/context/LanguageContext";

interface ImportMaterialModalProps {
    initialTab?: "upload" | "text";
    onClose: () => void;
    onSuccess: () => void;
}

// Import limits for every account (Premium too): server-safety limits of text recognition (ReadingImportGuard)
const MAX_PDF_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_WORDS = 10000;
const countWords = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
const ALLOWED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg"];

export function ImportMaterialModal({ initialTab = "upload", onClose, onSuccess }: ImportMaterialModalProps) {
    const { locale } = useLanguage();
    const [activeTab, setActiveTab] = useState<"upload" | "text">(initialTab);
    const [title, setTitle] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [clipboardFeedback, setClipboardFeedback] = useState<string | null>(null);
    const [contentText, setContentText] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const feedbackTimerRef = useRef<NodeJS.Timeout | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    // Clean up preview URL when unmounting or changing
    const revokePreview = useCallback(() => {
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
            setPreviewUrl(null);
        }
    }, [previewUrl]);

    useEffect(() => {
        return () => {
            if (previewUrl) {
                URL.revokeObjectURL(previewUrl);
            }
            if (feedbackTimerRef.current) {
                clearTimeout(feedbackTimerRef.current);
            }
        };
    }, [previewUrl]);

    useEffect(() => {
        setActiveTab(initialTab);
    }, [initialTab]);

    const resetForm = useCallback(() => {
        setTitle("");
        revokePreview();
        setFile(null);
        setContentText("");
        setError(null);
        setClipboardFeedback(null);
        setIsDragging(false);
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    }, [revokePreview]);

    const currentClose = useCallback(() => {
        resetForm();
        onClose();
    }, [resetForm, onClose]);

    const applySelectedFile = useCallback((selectedFile: File, fromClipboard = false) => {
        setError(null);
        setClipboardFeedback(null);

        // Validate extension / MIME
        const ext = "." + (selectedFile.name.split(".").pop()?.toLowerCase() || "");
        const mime = (selectedFile.type || "").toLowerCase();
        const isPdf = ext === ".pdf" || mime === "application/pdf";
        const isImage = ext === ".png" || ext === ".jpg" || ext === ".jpeg" || mime.startsWith("image/");

        if (!isPdf && !isImage) {
            setError("Định dạng tệp không được hỗ trợ. Vui lòng chọn PDF, PNG hoặc JPG.");
            return false;
        }

        // Validate size (the server checks again)
        if (selectedFile.size > (isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) {
            setError(isPdf ? "Tệp quá lớn để xử lý (PDF tối đa 6 MB)." : "Tệp quá lớn để xử lý (ảnh tối đa 5 MB).");
            return false;
        }

        // Revoke previous preview if any
        revokePreview();

        setFile(selectedFile);

        // Generate thumbnail preview if image
        if (isImage) {
            try {
                const url = URL.createObjectURL(selectedFile);
                setPreviewUrl(url);
            } catch (err) {
                console.warn("Could not generate object URL for preview:", err);
            }
        }

        // Pre-fill title if currently empty
        setTitle((prev) => {
            if (!prev.trim()) {
                return selectedFile.name.replace(/\.[^/.]+$/, "");
            }
            return prev;
        });

        if (fromClipboard) {
            setClipboardFeedback("Đã nhận ảnh từ clipboard");
            if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
            feedbackTimerRef.current = setTimeout(() => {
                setClipboardFeedback(null);
            }, 3000);
        }

        return true;
    }, [revokePreview]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            applySelectedFile(e.target.files[0], false);
        }
    };

    const handleRemoveFile = useCallback(() => {
        revokePreview();
        setFile(null);
        setClipboardFeedback(null);
        setError(null);
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    }, [revokePreview]);

    // Drag & drop handlers
    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            applySelectedFile(e.dataTransfer.files[0], false);
        }
    };

    // Global clipboard paste handler active only when modal is open & upload tab is active
    useEffect(() => {
        if (activeTab !== "upload") return;

        const handlePaste = (e: ClipboardEvent) => {
            // Do NOT intercept if typing/pasting in an active text input or textarea
            const target = e.target as HTMLElement | null;
            if (target) {
                const tagName = target.tagName.toUpperCase();
                if (tagName === "INPUT" || tagName === "TEXTAREA" || target.isContentEditable) {
                    return;
                }
            }

            const items = e.clipboardData?.items;
            if (!items || items.length === 0) return;

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.type && item.type.startsWith("image/")) {
                    const blob = item.getAsFile();
                    if (blob) {
                        e.preventDefault();
                        const ext = item.type.includes("jpeg") || item.type.includes("jpg") ? "jpg" : "png";
                        const filename = `reading-screenshot-${Date.now()}.${ext}`;
                        const pastedFile = new File([blob], filename, { type: item.type });
                        applySelectedFile(pastedFile, true);
                        break;
                    }
                }
            }
        };

        window.addEventListener("paste", handlePaste);
        return () => {
            window.removeEventListener("paste", handlePaste);
        };
    }, [activeTab, applySelectedFile]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim()) {
            setError("Vui lòng nhập tiêu đề cho tài liệu.");
            return;
        }

        setIsSubmitting(true);
        setError(null);

        try {
            if (activeTab === "upload") {
                if (!file) {
                    setError("Vui lòng chọn tệp PDF hoặc ảnh để tải lên.");
                    setIsSubmitting(false);
                    return;
                }

                const formData = new FormData();
                formData.append("title", title);
                formData.append("file", file);

                await apiClient.post("/reading/materials/upload", formData, {
                    headers: { "Content-Type": "multipart/form-data" },
                });
            } else {
                if (!contentText.trim()) {
                    setError("Vui lòng dán nội dung bài viết.");
                    setIsSubmitting(false);
                    return;
                }
                if (countWords(contentText) > MAX_WORDS) {
                    setError("Nội dung vượt quá 10.000 từ. Hãy chia tài liệu thành nhiều phần.");
                    setIsSubmitting(false);
                    return;
                }

                await apiClient.post("/reading/materials", {
                    title,
                    contentText,
                    materialType: "CUSTOM",
                });
            }

            resetForm();
            onSuccess();
        } catch (err: any) {
            console.error(err);
            setError(
                err.response?.data?.message || err.message || "Đã xảy ra lỗi khi nhập tài liệu. Vui lòng thử lại."
            );
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
            onClick={currentClose}
        >
            <div
                className="relative w-full max-w-lg rounded-3xl bg-white dark:bg-[#0c121e] shadow-2xl shadow-emerald-950/25 border border-emerald-500/20 overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header with Radiant Emerald / Oceanic Aura */}
                <div className="flex items-center justify-between border-b border-emerald-500/15 p-5 bg-gradient-to-r from-emerald-500/10 via-teal-500/5 to-transparent dark:from-emerald-950/40 dark:via-teal-950/20 dark:to-transparent">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center font-bold text-sm shadow-xs border border-emerald-500/20">
                            <UploadCloud className="w-5 h-5" />
                        </div>
                        <div>
                            <h3 className="text-base font-bold text-slate-900 dark:text-white">
                                {locale === 'vi' ? 'Nhập tài liệu đọc' : 'Import Reading Material'}
                            </h3>
                            <p className="text-xs text-emerald-700/80 dark:text-emerald-400/80">
                                Import Material to Active Library
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={currentClose}
                        className="rounded-xl p-1.5 text-stone-400 hover:text-stone-700 dark:hover:text-slate-200 hover:bg-stone-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                        title="Đóng"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {/* Segmented Tabs */}
                <div className="flex border-b border-emerald-500/15 bg-stone-50/50 dark:bg-slate-900/40 px-5 pt-3 gap-6">
                    <button
                        type="button"
                        className={`pb-3 text-sm font-semibold transition-colors flex items-center gap-2 relative cursor-pointer ${
                            activeTab === "upload"
                                ? "text-emerald-600 dark:text-emerald-400 border-b-2 border-emerald-500"
                                : "text-stone-500 dark:text-slate-400 hover:text-emerald-700 dark:hover:text-emerald-300"
                        }`}
                        onClick={() => {
                            setActiveTab("upload");
                            setError(null);
                        }}
                    >
                        <UploadCloud className="h-4 w-4" />
                        <span>{locale === 'vi' ? 'Tải tệp lên' : 'Upload File'}</span>
                    </button>
                    <button
                        type="button"
                        className={`pb-3 text-sm font-semibold transition-colors flex items-center gap-2 relative cursor-pointer ${
                            activeTab === "text"
                                ? "text-emerald-600 dark:text-emerald-400 border-b-2 border-emerald-500"
                                : "text-stone-500 dark:text-slate-400 hover:text-emerald-700 dark:hover:text-emerald-300"
                        }`}
                        onClick={() => {
                            setActiveTab("text");
                            setError(null);
                        }}
                    >
                        <FileText className="h-4 w-4" />
                        <span>{locale === 'vi' ? 'Dán văn bản' : 'Paste Text'}</span>
                    </button>
                </div>

                {/* Body Form */}
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    {/* Common Title Input */}
                    <div>
                        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-stone-600 dark:text-slate-300">
                            Tiêu đề bài đọc <span className="text-rose-500">*</span>
                        </label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="Ví dụ: The Ethics of AI in Healthcare"
                            className="w-full rounded-xl border border-stone-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2.5 text-sm text-slate-900 dark:text-white placeholder:text-stone-400 dark:placeholder:text-slate-500 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 transition-all font-sans"
                            required
                        />
                    </div>

                    {/* Upload File Specifics */}
                    {activeTab === "upload" && (
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <label className="block text-xs font-bold uppercase tracking-wider text-stone-600 dark:text-slate-300">
                                    Tài liệu đính kèm (PDF, PNG, JPG) <span className="text-rose-500">*</span>
                                </label>
                                {clipboardFeedback && (
                                    <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium animate-in fade-in">
                                        <CheckCircle2 className="w-3.5 h-3.5" />
                                        {clipboardFeedback}
                                    </span>
                                )}
                            </div>

                            {/* Dropzone with Soft Emerald Gradients & Subtle Dashed Borders */}
                            <div
                                className="flex w-full items-center justify-center"
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                                onDrop={handleDrop}
                            >
                                <label
                                    className={`flex h-36 w-full cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed transition-all p-4 text-center group ${
                                        isDragging
                                            ? "border-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/50 scale-[0.99] shadow-inner"
                                            : "border-emerald-500/30 dark:border-emerald-500/25 bg-emerald-500/[0.03] dark:bg-emerald-950/20 hover:bg-emerald-500/[0.07] dark:hover:bg-emerald-950/40 hover:border-emerald-500/60"
                                    }`}
                                >
                                    <div className="flex flex-col items-center justify-center">
                                        <div className="w-10 h-10 rounded-full bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-2 group-hover:scale-110 transition-transform">
                                            <UploadCloud className="h-5 w-5" />
                                        </div>
                                        <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                                            Bấm để chọn tệp, kéo thả hoặc Ctrl+V ảnh vào đây
                                        </p>
                                        <p className="text-xs text-stone-400 dark:text-slate-500 mt-1">
                                            PDF tối đa 30 trang, 6 MB (bản scan tối đa 15 trang) • PNG, JPG tối đa 5 MB • tối đa 10.000 từ
                                        </p>
                                    </div>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        className="hidden"
                                        accept=".pdf,.png,.jpg,.jpeg"
                                        onChange={handleFileChange}
                                    />
                                </label>
                            </div>

                            {/* Selected File Card with Preview */}
                            {file && (
                                <div className="mt-2.5 flex items-center gap-3 p-2.5 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 text-xs font-medium text-emerald-900 dark:text-emerald-200 animate-in fade-in">
                                    {previewUrl ? (
                                        <div className="w-12 h-12 rounded-lg overflow-hidden border border-emerald-200 dark:border-emerald-800 shrink-0 bg-stone-100 dark:bg-slate-800 flex items-center justify-center">
                                            <img
                                                src={previewUrl}
                                                alt="Preview"
                                                className="w-full h-full object-cover"
                                            />
                                        </div>
                                    ) : (
                                        <div className="w-10 h-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/80 text-emerald-600 dark:text-emerald-300 flex items-center justify-center shrink-0">
                                            <FileText className="w-5 h-5" />
                                        </div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <p className="truncate font-semibold text-slate-800 dark:text-slate-100">
                                            {file.name}
                                        </p>
                                        <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
                                            {(file.size / 1024 / 1024).toFixed(2)} MB
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={handleRemoveFile}
                                        className="p-1.5 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors shrink-0 cursor-pointer"
                                        title="Xóa tệp đã chọn"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Paste Text Specifics */}
                    {activeTab === "text" && (
                        <div>
                            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-stone-600 dark:text-slate-300">
                                Nội dung văn bản <span className="text-rose-500">*</span>
                            </label>
                            <textarea
                                value={contentText}
                                onChange={(e) => setContentText(e.target.value)}
                                placeholder="Dán nội dung bài viết tiếng Anh bạn muốn luyện đọc tại đây..."
                                rows={6}
                                className="w-full resize-none rounded-xl border border-stone-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-3.5 text-sm text-slate-900 dark:text-white placeholder:text-stone-400 dark:placeholder:text-slate-500 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 transition-all font-sans leading-relaxed custom-scrollbar"
                                required
                            />
                            <div className="flex justify-between text-[11px] text-stone-400 dark:text-slate-500 mt-1">
                                <span className={countWords(contentText) > MAX_WORDS ? "text-rose-500 font-semibold" : undefined}>{countWords(contentText)} / 10.000 từ</span>
                                <span>{contentText.length} ký tự</span>
                            </div>
                        </div>
                    )}

                    {/* Error message */}
                    {error && (
                        <div className="rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200/80 dark:border-rose-900/60 p-3 text-xs text-rose-700 dark:text-rose-300">
                            {error}
                        </div>
                    )}

                    {/* Footer Actions */}
                    <div className="pt-3 border-t border-stone-100 dark:border-slate-800 flex items-center justify-end gap-3">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={currentClose}
                            disabled={isSubmitting}
                            className="rounded-xl border-stone-300 dark:border-slate-700 hover:bg-stone-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-semibold px-4 py-2 cursor-pointer"
                        >
                            Hủy
                        </Button>
                        <Button
                            type="submit"
                            disabled={isSubmitting}
                            className="rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold px-5 py-2.5 shadow-md shadow-emerald-600/25 active:scale-[0.98] transition-all cursor-pointer"
                        >
                            {isSubmitting ? (
                                <span className="flex items-center gap-2">
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    {activeTab === "upload" ? "Đang quét OCR..." : "Đang lưu..."}
                                </span>
                            ) : (
                                "Nhập tài liệu"
                            )}
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
