'use client';

import React, { useState, useEffect } from 'react';
import { DraftComparisonResult } from '@/types/writing';
import { writingApi } from '@/services/writingApi';

import { glass } from '../glass/WritingGlass';
interface DraftDiffProps {
  sessionId: string;
  onBackToFeedback?: () => void;
  onContinueRevising?: () => void;
}

export const DraftDiff: React.FC<DraftDiffProps> = ({
  sessionId,
  onBackToFeedback,
  onContinueRevising
}) => {
  const [comparison, setComparison] = useState<DraftComparisonResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified');

  useEffect(() => {
    async function loadDiff() {
      setLoading(true);
      setError(null);
      try {
        const res = await writingApi.compareDrafts(sessionId);
        setComparison(res);
      } catch (err: any) {
        console.error('Failed to load draft comparison', err);
        setError(
          err?.response?.data?.message ||
            'At least two submitted drafts are required to view revision diffs.'
        );
      } finally {
        setLoading(false);
      }
    }
    loadDiff();
  }, [sessionId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-16 space-y-4 rounded-2xl bg-surface-container-lowest border border-surface-variant/40 shadow-sm">
        <span className="material-symbols-outlined text-[32px] animate-spin text-primary">sync</span>
        <p className="font-body-md text-body-md text-on-surface-variant">Đang tính toán đối chiếu bản nháp...</p>
      </div>
    );
  }

  if (error || !comparison) {
    return (
      <div className="p-space-2xl text-center rounded-2xl bg-surface-container-lowest border border-surface-variant/40 shadow-sm space-y-space-md">
        <div className="w-12 h-12 rounded-2xl bg-surface-container flex items-center justify-center mx-auto text-outline">
          <span className="material-symbols-outlined text-[28px]">difference</span>
        </div>
        <h4 className="font-headline-sm text-headline-sm text-on-surface font-semibold">
          Chưa thể so sánh
        </h4>
        <p className="font-body-sm text-body-sm text-on-surface-variant max-w-sm mx-auto">
          {error || 'Cần ít nhất hai bản nháp đã nộp để xem sự khác biệt giữa các phiên bản.'}
        </p>
        {onBackToFeedback && (
          <button
            onClick={onBackToFeedback}
            className="px-4 py-2 min-h-[40px] rounded-xl bg-surface-container text-on-surface hover:bg-surface-container-high border border-outline-variant/60 font-semibold text-sm transition-colors cursor-pointer shadow-xs"
            type="button"
          >
            Quay lại bước Đánh giá
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full space-y-space-xl">
      {/* Section 1: Workflow Stage Tracker & Session Utilities Bar */}
      <div className={`${glass.panel} ${glass.toolbar}`}>
        <span className={`${glass.label} ${glass.labelInk}`}>Đối chiếu trực tiếp hai bản nháp</span>

        {/* Utilities & Actions */}
        <div className="flex items-center justify-between md:justify-end gap-space-sm w-full md:w-auto">
          <div className="flex items-center gap-space-xs text-on-surface-variant">
            <span className="w-2 h-2 rounded-full bg-tertiary-container"></span>
            <span className="font-body-sm text-body-sm">
              Bản nháp #{comparison.draft1Ordinal} &rarr; Bản nháp #{comparison.draft2Ordinal}
            </span>
          </div>
          <div className="flex items-center gap-space-xs">
            {onBackToFeedback && (
              <button
                onClick={onBackToFeedback}
                className={`${glass.btn} ${glass.btnSoft}`}
                type="button"
              >
                Quay lại bước Đánh giá
              </button>
            )}
            {onContinueRevising && (
              <button
                onClick={onContinueRevising}
                className={`${glass.btn} ${glass.btnPrimary}`}
                type="button"
              >
                <span>Tiếp tục chỉnh sửa</span>
                <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Section 2: Editorial Header & Taxonomy Legend */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-md">
        <div className="flex flex-col gap-1 max-w-2xl">
          <div className="flex items-center gap-space-xs">
            <span className="font-label-stamp text-label-stamp text-secondary uppercase tracking-widest">
              ĐÁNH GIÁ SỰ TIẾN BỘ VÀ NÂNG CẤP VĂN PHONG
            </span>
          </div>
          <h1 className="font-headline-lg text-headline-lg text-on-surface tracking-tight font-bold">
            Hành trình tiến bộ của bài viết
          </h1>
          <p className="font-body-md text-body-md text-on-surface-variant">
            Quan sát cách diễn đạt ban đầu được chuyển hóa thành văn phong học thuật chuẩn mực thông qua quá trình tái cấu trúc lập luận có định hướng.
          </p>
        </div>

        {/* Micro Legend Bar */}
        <div className="flex flex-wrap items-center gap-space-xs bg-surface-container-high/60 p-space-xs rounded-xl shadow-inner border border-surface-variant/30">
          <div className="flex items-center gap-1.5 px-space-xs py-1 rounded-lg bg-surface-container-lowest shadow-xs">
            <span className="w-2.5 h-2.5 rounded-full bg-error"></span>
            <span className="font-label-sm text-label-sm text-on-surface">Lỗi ban đầu</span>
          </div>
          <div className="flex items-center gap-1.5 px-space-xs py-1 rounded-lg bg-surface-container-lowest shadow-xs">
            <span className="w-2.5 h-2.5 rounded-full bg-tertiary"></span>
            <span className="font-label-sm text-label-sm text-on-surface">Nâng cấp cấu trúc</span>
          </div>
          <div className="flex items-center gap-1.5 px-space-xs py-1 rounded-lg bg-surface-container-lowest shadow-xs">
            <span className="w-2.5 h-2.5 rounded-full bg-secondary"></span>
            <span className="font-label-sm text-label-sm text-on-surface">Tính liên kết học thuật</span>
          </div>
        </div>
      </div>

      {/* Section 3: Dual Folio Spread (Side-by-Side Comparison) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-space-lg items-stretch">
        {/* LEFT FOLIO: Draft 1 (Original Thought) */}
        <div className="relative bg-surface-container-lowest rounded-xl shadow-md p-space-xl flex flex-col justify-between overflow-hidden border border-surface-variant/40">
          {/* Soft Red Semantic Accent Strip */}
          <div className="absolute top-0 bottom-0 left-0 w-1.5 bg-error"></div>
          <div className="flex flex-col">
            {/* Folio Header */}
            <div className="flex items-center justify-between pb-space-md mb-space-lg bg-surface-container-low/40 p-space-sm rounded-lg border-b border-surface-variant/30">
              <div className="flex items-center gap-space-xs">
                <span className="w-7 h-7 rounded-lg bg-error-container text-on-error-container flex items-center justify-center font-label-stamp text-label-stamp font-bold">
                  0{comparison.draft1Ordinal}
                </span>
                <div className="flex flex-col">
                  <span className="font-label-md text-label-md text-on-surface font-semibold">
                    Bản nháp {comparison.draft1Ordinal} — Ý tưởng ban đầu
                  </span>
                  <span className="font-label-sm text-label-sm text-on-surface-variant">
                    Bản nháp sơ khởi chưa qua chỉnh sửa
                  </span>
                </div>
              </div>
              <span className="inline-flex items-center font-label-stamp text-label-stamp uppercase px-2.5 py-1 rounded-md bg-surface-container-highest text-on-surface-variant shadow-2xs">
                Bản gốc
              </span>
            </div>

            {/* Ruled Paper Guideline & Manuscript Excerpt */}
            <div className="relative pl-space-md mb-space-xl">
              <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-error/20"></div>
              <p className="font-body-xl-editorial text-body-xl-editorial text-on-surface leading-loose">
                {comparison.diffChunks.map((chunk, idx) => {
                  if (chunk.type === 'DELETE') {
                    return (
                      <span key={idx} className="relative inline-block mx-0.5">
                        <del className="text-error dark:text-rose-300 bg-error-container/50 dark:bg-rose-950/60 px-1 py-0.5 rounded line-through decoration-error decoration-2 font-medium">
                          {chunk.text}
                        </del>
                      </span>
                    );
                  }
                  if (chunk.type === 'EQUAL') {
                    return <span key={idx}>{chunk.text}</span>;
                  }
                  return null;
                })}
              </p>
            </div>
          </div>

          {/* Folio Footer Note */}
          <div className="bg-error-container/20 rounded-xl p-space-md text-on-surface flex items-start gap-space-sm border border-error/10">
            <span className="material-symbols-outlined text-error text-[20px] shrink-0 mt-0.5">report_problem</span>
            <div className="flex flex-col gap-0.5">
              <span className="font-label-md text-label-md font-semibold text-error">Điểm chưa chuẩn ban đầu được đánh dấu</span>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                Các từ gạch ngang màu đỏ thể hiện ngữ pháp chưa hòa hợp, liên từ chưa chuẩn hoặc cách diễn đạt thiếu tự nhiên đã được thay thế trong quá trình chỉnh sửa.
              </p>
            </div>
          </div>
        </div>

        {/* RIGHT FOLIO: Draft 2 (Polished Synthesis) */}
        <div className="relative bg-surface-container-low rounded-xl shadow-md p-space-xl flex flex-col justify-between overflow-hidden border border-surface-variant/40">
          {/* Soft Indigo Accent Strip */}
          <div className="absolute top-0 bottom-0 left-0 w-1.5 bg-primary-container"></div>
          <div className="flex flex-col">
            {/* Folio Header */}
            <div className="flex items-center justify-between pb-space-md mb-space-lg bg-surface-container-lowest/80 p-space-sm rounded-lg shadow-xs border-b border-surface-variant/30">
              <div className="flex items-center gap-space-xs">
                <span className="w-7 h-7 rounded-lg bg-primary-fixed text-primary-container flex items-center justify-center font-label-stamp text-label-stamp font-bold">
                  0{comparison.draft2Ordinal}
                </span>
                <div className="flex flex-col">
                  <span className="font-label-md text-label-md text-on-surface font-semibold">
                    Bản nháp {comparison.draft2Ordinal} — Bản hoàn thiện nâng cao
                  </span>
                  <span className="font-label-sm text-label-sm text-primary">Đạt chuẩn văn phong học thuật</span>
                </div>
              </div>
              <span className="inline-flex items-center font-label-stamp text-label-stamp uppercase px-2.5 py-1 rounded-md bg-tertiary-fixed-dim/40 text-tertiary font-bold tracking-wider shadow-2xs">
                ĐÃ CHUẨN HÓA
              </span>
            </div>

            {/* Ruled Paper Guideline & Elevated Manuscript Excerpt */}
            <div className="relative pl-space-md mb-space-xl">
              <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary-container/20"></div>
              <p className="font-body-xl-editorial text-body-xl-editorial text-on-surface leading-loose">
                {comparison.diffChunks.map((chunk, idx) => {
                  if (chunk.type === 'INSERT') {
                    return (
                      <span key={idx} className="relative inline-block mx-0.5">
                        <mark className="bg-secondary-fixed dark:bg-secondary-container/60 text-secondary dark:text-on-secondary-container px-1.5 py-0.5 rounded font-medium shadow-xs not-italic">
                          {chunk.text}
                        </mark>
                      </span>
                    );
                  }
                  if (chunk.type === 'EQUAL') {
                    return <span key={idx}>{chunk.text}</span>;
                  }
                  return null;
                })}
              </p>
            </div>
          </div>

          {/* Folio Footer Note */}
          <div className="bg-tertiary-fixed/30 rounded-xl p-space-md text-on-surface flex items-start gap-space-sm border border-tertiary/20">
            <span className="material-symbols-outlined text-tertiary text-[20px] shrink-0 mt-0.5">verified</span>
            <div className="flex flex-col gap-0.5">
              <span className="font-label-md text-label-md font-semibold text-tertiary">Nâng cấp văn phong</span>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                Các điểm điều chỉnh bao gồm sự hòa hợp chủ ngữ - động từ chuẩn xác, tính chủ động trong văn phong học thuật và các từ nối liên kết mạch lạc.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Section 4: Pedagogical Impact & Growth Metrics (4 Bento Cards) */}
      <div>
        <div className="flex items-center justify-between mb-space-sm">
          <h2 className="font-headline-sm text-headline-sm text-on-surface font-semibold">
            Chẩn đoán tiến bộ học tập
          </h2>
          <span className="font-label-stamp text-label-stamp uppercase tracking-widest text-outline">
            KẾT QUẢ CHỈNH SỬA
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-space-md">
          {/* Metric Card 1 */}
          <div className="bg-surface-container-lowest p-space-md rounded-xl shadow-xs hover:shadow-md transition-shadow flex flex-col justify-between border border-surface-variant/30">
            <div className="flex items-center justify-between mb-space-sm">
              <div className="w-9 h-9 rounded-lg bg-surface-container-high text-primary flex items-center justify-center">
                <span className="material-symbols-outlined text-[20px]">spellcheck</span>
              </div>
              <span className="font-label-stamp text-label-stamp bg-tertiary-fixed text-tertiary px-space-xs py-0.5 rounded-full font-bold">
                ĐÃ KHẮC PHỤC
              </span>
            </div>
            <div>
              <span className="font-headline-md text-headline-md text-on-surface font-bold">
                {comparison.resolvedIssueCount} Lỗi
              </span>
              <h3 className="font-label-md text-label-md text-primary font-semibold mt-0.5">
                Điểm cần sửa đã được hoàn thiện
              </h3>
              <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
                Các lỗi về sự hòa hợp và cấu trúc câu đã được khắc phục thông qua quá trình tự tư duy.
              </p>
            </div>
            <div className="w-full bg-surface-container h-1.5 rounded-full mt-space-md overflow-hidden">
              <div
                className="bg-primary-container h-full rounded-full transition-all"
                style={{ width: `${Math.min(100, Math.max(0, comparison.resolvedIssueCount * 25))}%` }}
              />
            </div>
          </div>

          {/* Metric Card 2 */}
          <div className="bg-surface-container-lowest p-space-md rounded-xl shadow-xs hover:shadow-md transition-shadow flex flex-col justify-between border border-surface-variant/30">
            <div className="flex items-center justify-between mb-space-sm">
              <div className="w-9 h-9 rounded-lg bg-secondary-fixed text-secondary flex items-center justify-center">
                <span className="material-symbols-outlined text-[20px]">trending_up</span>
              </div>
              <span className="font-label-stamp text-label-stamp bg-secondary text-on-secondary px-space-xs py-0.5 rounded-full font-bold">
                DUNG LƯỢNG
              </span>
            </div>
            <div>
              <span className="font-headline-md text-headline-md text-on-surface font-bold">
                {comparison.wordCountChange >= 0 ? `+${comparison.wordCountChange}` : comparison.wordCountChange} Từ
              </span>
              <h3 className="font-label-md text-label-md text-secondary font-semibold mt-0.5">
                Độ chênh lệch số từ
              </h3>
              <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
                Sự phát triển từ độ dài bản nháp đầu tiên đến bản hoàn thiện.
              </p>
            </div>
            <div className="w-full bg-surface-container h-1.5 rounded-full mt-space-md overflow-hidden">
              <div
                className="bg-secondary h-full rounded-full transition-all"
                style={{ width: `${Math.min(100, Math.max(10, Math.abs(comparison.wordCountChange) * 2))}%` }}
              />
            </div>
          </div>

          {/* Metric Card 3 */}
          <div className="bg-surface-container-lowest p-space-md rounded-xl shadow-xs hover:shadow-md transition-shadow flex flex-col justify-between border border-surface-variant/30">
            <div className="flex items-center justify-between mb-space-sm">
              <div className="w-9 h-9 rounded-lg bg-tertiary-fixed text-tertiary flex items-center justify-center">
                <span className="material-symbols-outlined text-[20px]">auto_stories</span>
              </div>
              <span className="font-label-stamp text-label-stamp bg-surface-container-highest text-on-surface font-semibold px-space-xs py-0.5 rounded-full">
                ĐỐI CHIẾU
              </span>
            </div>
            <div>
              <span className="font-headline-md text-headline-md text-on-surface font-bold">
                {comparison.diffChunks.filter((c) => c.type !== 'EQUAL').length} Điểm sửa
              </span>
              <h3 className="font-label-md text-label-md text-tertiary font-semibold mt-0.5">
                Chuyển hóa cú pháp trọng tâm
              </h3>
              <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
                Tổng số thay đổi ở cấp độ cụm từ và mệnh đề giữa hai bản nháp.
              </p>
            </div>
            <div className="w-full bg-surface-container h-1.5 rounded-full mt-space-md overflow-hidden">
              <div
                className="bg-tertiary h-full rounded-full transition-all"
                style={{ width: `${Math.min(100, Math.max(10, comparison.diffChunks.filter((c) => c.type !== 'EQUAL').length * 10))}%` }}
              />
            </div>
          </div>

          {/* Metric Card 4 */}
          <div className="bg-surface-container-lowest p-space-md rounded-xl shadow-xs hover:shadow-md transition-shadow flex flex-col justify-between border border-surface-variant/30">
            <div className="flex items-center justify-between mb-space-sm">
              <div className="w-9 h-9 rounded-lg bg-surface-container-high text-on-surface flex items-center justify-center">
                <span className="material-symbols-outlined text-[20px]">psychology</span>
              </div>
              <span className="font-label-stamp text-label-stamp bg-primary-fixed text-primary px-space-xs py-0.5 rounded-full font-bold">
                CHUẨN XÁC
              </span>
            </div>
            <div>
              <span className="font-headline-md text-headline-md text-on-surface font-bold">
                Thuật toán Myers
              </span>
              <h3 className="font-label-md text-label-md text-on-surface font-semibold mt-0.5">
                Thuật toán Myers Diff
              </h3>
              <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">
                Căn chỉnh chính xác từng ký tự và từ vựng đối chiếu với dữ liệu hệ thống.
              </p>
            </div>
            <div className="w-full bg-surface-container h-1.5 rounded-full mt-space-md overflow-hidden">
              <div className="bg-primary h-full rounded-full" style={{ width: '100%' }}></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
