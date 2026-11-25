"use client";

import React, { useState, useEffect, useRef } from "react";
import { useMorphPresence } from '@/components/morph/useMorphPresence';
import { createPortal } from "react-dom";
import { useLanguage } from "@/context/LanguageContext";

interface AddFlashcardModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (front: string, back: string, example: string) => Promise<void>;
  isSaving: boolean;
}

export function AddFlashcardModal({
  isOpen,
  onClose,
  onSave,
  isSaving,
}: AddFlashcardModalProps) {
  const { t, locale } = useLanguage();
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [example, setExample] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const presence = useMorphPresence(isOpen, panelRef);

  useEffect(() => {
    if (!presence.present) {
      setFront("");
      setBack("");
      setExample("");
    }
  }, [presence.present]);

  if (!presence.present || typeof window === "undefined") return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!front.trim() || !back.trim() || isSaving) return;
    await onSave(front.trim(), back.trim(), example.trim());
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        backgroundColor: "rgba(15, 23, 42, 0.6)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 99999,
      }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        {...presence.panelProps}
        className="bg-white dark:bg-slate-900 rounded-3xl p-6 sm:p-8 shadow-2xl relative max-w-lg w-full mx-4 border border-slate-200 dark:border-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
              <span className="material-symbols-outlined text-[20px]">add_card</span>
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-900 dark:text-white leading-tight">
                {t.modalAddFlashcard}
              </h3>
              <p className="text-xs text-slate-500">
                {locale === "vi" ? "Thêm vào bộ từ vựng chủ động của bạn" : "Add to your active vocabulary deck"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider mb-1.5 text-slate-700 dark:text-slate-300">
              {t.wordInputLabel} <span className="text-rose-500">*</span>
            </label>
            <input
              id="card-input-word"
              type="text"
              required
              autoFocus
              value={front}
              onChange={(e) => setFront(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white border border-slate-200 dark:border-slate-700 px-4 py-2.5 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 text-sm font-medium transition"
              placeholder="e.g. chronic, epidemic, alleviate"
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider mb-1.5 text-slate-700 dark:text-slate-300">
              {t.meaningsInputLabel} <span className="text-rose-500">*</span>
            </label>
            <input
              id="card-input-meanings"
              type="text"
              required
              value={back}
              onChange={(e) => setBack(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white border border-slate-200 dark:border-slate-700 px-4 py-2.5 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 text-sm font-medium transition"
              placeholder={locale === "vi" ? "Ví dụ: Mãn tính, kéo dài khó dứt điểm" : "e.g. Long-lasting, persisting for a long time"}
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider mb-1.5 text-slate-700 dark:text-slate-300">
              {locale === "vi" ? "Câu ví dụ (Tùy chọn)" : "Example Sentence (Optional)"}
            </label>
            <textarea
              id="card-input-examples"
              value={example}
              onChange={(e) => setExample(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white border border-slate-200 dark:border-slate-700 px-4 py-2.5 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 text-sm font-medium resize-none h-24 transition"
              placeholder="e.g. The patient suffered from chronic pain for years."
            />
          </div>

          <div className="flex gap-3 pt-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 rounded-xl text-slate-600 dark:text-slate-300 font-semibold text-sm hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
            >
              {t.cancel}
            </button>
            <button
              id="card-submit-btn"
              type="submit"
              disabled={!front.trim() || !back.trim() || isSaving}
              className="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold text-sm shadow-md transition-all active:translate-y-0.5 cursor-pointer flex items-center gap-1.5"
            >
              {isSaving ? t.saving : (locale === "vi" ? "Lưu Flashcard" : "Save Flashcard")}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
