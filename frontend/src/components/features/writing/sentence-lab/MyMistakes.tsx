'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { writingApi } from '@/services/writingApi';
import { LearnerErrorMemory, ErrorOccurrence } from '@/types/writing';
import { formatPatternCode, getCategoryLabel, getPatternDisplayTitle } from '@/lib/writing/labels';

import { glass, StudioLoading } from '../glass/WritingGlass';
interface MyMistakesProps {
  initialPatternCode?: string;
  onNavigateCheck?: () => void;
}

export const MyMistakes: React.FC<MyMistakesProps> = ({ initialPatternCode, onNavigateCheck }) => {
  const [mistakes, setMistakes] = useState<LearnerErrorMemory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [selectedPatternCode, setSelectedPatternCode] = useState<string | null>(initialPatternCode || null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [visibleOccurrenceCount, setVisibleOccurrenceCount] = useState<number>(5);

  const fetchMistakes = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await writingApi.getMyMistakes();
      setMistakes(data);
      if (initialPatternCode && data.some((m) => m.patternCode === initialPatternCode)) {
        setSelectedPatternCode(initialPatternCode);
      } else if (data.length > 0 && !selectedPatternCode) {
        setSelectedPatternCode(data[0].patternCode);
      }
    } catch (err: any) {
      console.error('Failed to load error notebook:', err);
      setError('Không thể tải dữ liệu sổ tay lỗi sai.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMistakes();
  }, []);

  useEffect(() => {
    if (initialPatternCode) {
      setSelectedPatternCode(initialPatternCode);
      setVisibleOccurrenceCount(5);
    }
  }, [initialPatternCode]);

  const handleToggleMute = async (patternCode: string, currentMuted: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await writingApi.setMistakeMuted(patternCode, !currentMuted);
      setMistakes((prev) =>
        prev.map((m) => (m.patternCode === patternCode ? { ...m, isMuted: !currentMuted } : m))
      );
    } catch (err) {
      console.error('Failed to toggle mute:', err);
    }
  };

  const categories = useMemo(() => {
    return ['ALL', ...Array.from(new Set(mistakes.map((m) => m.category || 'Grammar')))];
  }, [mistakes]);

  const filtered = useMemo(() => {
    if (selectedCategory === 'ALL') return mistakes;
    return mistakes.filter((m) => (m.category || 'Grammar') === selectedCategory);
  }, [mistakes, selectedCategory]);

  const selectedItem = useMemo(() => {
    return (
      filtered.find((m) => m.patternCode === selectedPatternCode) ||
      filtered[0] ||
      mistakes[0] ||
      null
    );
  }, [filtered, selectedPatternCode, mistakes]);

  // Reset pagination when selected pattern changes
  useEffect(() => {
    setVisibleOccurrenceCount(5);
  }, [selectedItem?.patternCode]);

  const formatDate = (isoDate?: string): string => {
    if (!isoDate) return 'Gần đây';
    try {
      return new Date(isoDate).toLocaleDateString('vi-VN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
    } catch {
      return 'Gần đây';
    }
  };

  const formatDateTime = (isoDate?: string): string => {
    if (!isoDate) return 'Gần đây';
    try {
      const d = new Date(isoDate);
      const dateStr = d.toLocaleDateString('vi-VN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
      const timeStr = d.toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit'
      });
      return `${dateStr} lúc ${timeStr}`;
    } catch {
      return 'Gần đây';
    }
  };

  const renderHighlightedSentence = (
    originalText?: string,
    wrongSpan?: string,
    startOffset?: number,
    endOffset?: number
  ) => {
    if (!originalText) {
      return <span className="text-on-surface-variant italic">Chưa lưu câu gốc cho lần ghi nhận này.</span>;
    }

    if (
      startOffset !== undefined &&
      endOffset !== undefined &&
      startOffset >= 0 &&
      endOffset <= originalText.length &&
      startOffset < endOffset
    ) {
      const before = originalText.substring(0, startOffset);
      const target = originalText.substring(startOffset, endOffset);
      const after = originalText.substring(endOffset);
      return (
        <span className="font-body-md text-on-surface leading-relaxed break-words">
          {before}
          <mark className="bg-error/15 text-error px-1.5 py-0.5 rounded font-semibold underline decoration-error decoration-2">
            {target}
          </mark>
          {after}
        </span>
      );
    }

    if (wrongSpan && originalText.includes(wrongSpan)) {
      const idx = originalText.indexOf(wrongSpan);
      const before = originalText.substring(0, idx);
      const after = originalText.substring(idx + wrongSpan.length);
      return (
        <span className="font-body-md text-on-surface leading-relaxed break-words">
          {before}
          <mark className="bg-error/15 text-error px-1.5 py-0.5 rounded font-semibold underline decoration-error decoration-2">
            {wrongSpan}
          </mark>
          {after}
        </span>
      );
    }

    return <span className="font-body-md text-on-surface leading-relaxed break-words">{originalText}</span>;
  };

  const renderCorrectedSentence = (correctedSentence?: string, replacement?: string) => {
    if (!correctedSentence) return null;
    if (replacement && correctedSentence.includes(replacement)) {
      const idx = correctedSentence.indexOf(replacement);
      const before = correctedSentence.substring(0, idx);
      const after = correctedSentence.substring(idx + replacement.length);
      return (
        <span className="font-body-md text-on-surface leading-relaxed break-words">
          {before}
          <span className="bg-tertiary-fixed text-on-tertiary-fixed px-1.5 py-0.5 rounded font-semibold">
            {replacement}
          </span>
          {after}
        </span>
      );
    }
    return <span className="font-body-md text-on-surface leading-relaxed break-words">{correctedSentence}</span>;
  };

  return (
    <div className="space-y-6">
      {/* Notebook Header Ribbon */}
      <div className={`${glass.panel} p-5 sm:p-7 overflow-hidden`}>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-space-md relative z-10">
          <div>
            <div className="flex items-center gap-space-xs mb-space-2xs flex-wrap">
              <span className="inline-flex items-center gap-1 font-label-stamp text-label-stamp px-2.5 py-1 rounded-md bg-primary-fixed text-on-primary-fixed font-bold uppercase tracking-wider">
                <span className="material-symbols-outlined text-[14px]">menu_book</span>
                Sổ tay lỗi cá nhân
              </span>
              <span className="text-body-sm font-body-sm text-on-surface-variant">
                {mistakes.length > 0 ? `${mistakes.length} dạng lỗi đã xác nhận` : 'Chưa có lỗi ghi nhận'}
              </span>
            </div>
            <h2 className="text-2xl md:text-[1.9rem] text-on-surface font-bold leading-tight tracking-tight">
              Sổ tay lỗi sai và Quy tắc ngữ pháp
            </h2>
            <p className="font-body-md text-on-surface-variant mt-1 max-w-2xl leading-relaxed">
              Mỗi ghi nhận được lưu lại từ câu thực tế bạn đã kiểm tra hoặc viết bài. Đối chiếu câu gốc, lỗi sai, gợi ý sửa và quy tắc để xây dựng phản xạ chuẩn xác.
            </p>

            {/* Category Filter Pills */}
            {categories.length > 1 && (
              <div className="flex flex-wrap gap-1.5 pt-space-sm">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    type="button"
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer border ${
                      selectedCategory === cat
                        ? 'bg-primary text-white dark:text-on-primary border-primary shadow-xs'
                        : 'bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high border-outline-variant/60'
                    }`}
                  >
                    {cat === 'ALL' ? 'Tất cả' : getCategoryLabel(cat)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-space-sm shrink-0">
            <div className={`${glass.well} px-4 py-2.5 flex flex-col min-w-[120px]`}>
              <span className="font-label-stamp text-label-stamp text-on-surface-variant uppercase">
                Tổng dạng lỗi
              </span>
              <div className="flex items-baseline gap-1 mt-0.5">
                <span className="font-headline-md text-[22px] text-on-surface font-bold">
                  {mistakes.length}
                </span>
                <span className="font-body-sm text-xs text-on-surface-variant">dạng</span>
              </div>
            </div>

            {onNavigateCheck && (
              <button
                onClick={onNavigateCheck}
                type="button"
                className={`${glass.btn} ${glass.btnPrimary}`}
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                <span>Kiểm tra câu mới</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-error-container text-on-error-container text-sm flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px]">error</span>
          <span>{error}</span>
        </div>
      )}

      {/* Main Content Layout */}
      {isLoading ? (
        <div className={glass.panel}>
          <StudioLoading text="Đang tải sổ tay lỗi sai..." />
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-16 rounded-3xl bg-surface-container-lowest border border-surface-container-high text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-tertiary-fixed/40 text-tertiary flex items-center justify-center mx-auto">
            <span className="material-symbols-outlined text-[24px]">verified</span>
          </div>
          <h4 className="font-headline-sm text-headline-sm font-bold text-on-surface">
            Chưa có lỗi nào được ghi nhận
          </h4>
          <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md mx-auto">
            Khi bạn kiểm tra câu trong Sentence Lab hoặc làm bài viết trong Writing Coach, các lỗi ngữ pháp được xác nhận sẽ tự động lưu vào sổ tay này.
          </p>
          {onNavigateCheck && (
            <div className="pt-2">
              <button
                onClick={onNavigateCheck}
                type="button"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-white font-medium text-sm shadow-xs hover:opacity-95 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">spellcheck</span>
                <span>Kiểm tra câu đầu tiên</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-space-xl items-start">
          {/* LEFT COLUMN: Error Patterns List (5 Cols) */}
          <div className="xl:col-span-5 flex flex-col gap-space-sm">
            <div className="flex items-center justify-between px-space-xs pb-1">
              <span className="font-label-stamp text-label-stamp text-on-surface-variant uppercase tracking-wider font-bold">
                Danh sách dạng lỗi ({filtered.length})
              </span>
              <span className="text-xs text-on-surface-variant">
                Chọn để xem chi tiết
              </span>
            </div>

            <div className="flex flex-col gap-2.5">
              {filtered.map((item) => {
                const isSelected = selectedItem?.patternCode === item.patternCode;
                const friendlyTitle = getPatternDisplayTitle(item.title, item.patternCode);
                const occurrencesCount = item.occurrences?.length ?? item.occurrenceCount ?? 0;

                return (
                  <div
                    key={item.patternCode}
                    onClick={() => setSelectedPatternCode(item.patternCode)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedPatternCode(item.patternCode); } }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    className={`relative bg-surface-container-lowest rounded-xl p-3.5 cursor-pointer transition-all hover:scale-[1.005] group border ${
                      isSelected
                        ? 'border-primary ring-2 ring-primary/20 shadow-sm bg-surface-container-low/40'
                        : 'border-surface-container-high/60 shadow-xs hover:border-outline'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-col gap-1 min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-label-stamp text-[10px] px-2 py-0.5 rounded font-bold uppercase bg-surface-container-high text-on-surface-variant">
                            {getCategoryLabel(item.category)}
                          </span>
                          {item.isMuted && (
                            <span className="font-label-stamp text-[10px] px-1.5 py-0.5 rounded font-bold uppercase bg-surface-container text-on-surface-variant flex items-center gap-0.5">
                              <span className="material-symbols-outlined text-[10px]">notifications_off</span>
                              Đã ẩn
                            </span>
                          )}
                        </div>

                        <h3 className="font-headline-sm text-sm text-on-surface font-semibold group-hover:text-primary transition-colors break-words leading-snug">
                          {friendlyTitle}
                        </h3>

                        <div className="flex items-center gap-3 text-xs text-on-surface-variant mt-0.5">
                          <span className="font-medium text-primary">
                            {occurrencesCount} lần gặp
                          </span>
                          <span>•</span>
                          <span>
                            Gần nhất: {formatDate(item.lastSeenAt)}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          onClick={(e) => handleToggleMute(item.patternCode, item.isMuted, e)}
                          className="text-on-surface-variant hover:text-on-surface p-1.5 rounded-lg hover:bg-surface-container cursor-pointer transition-colors"
                          title={item.isMuted ? 'Bỏ ẩn dạng lỗi' : 'Ẩn dạng lỗi'}
                          type="button"
                        >
                          <span className="material-symbols-outlined text-[16px]">
                            {item.isMuted ? 'notifications_off' : 'notifications'}
                          </span>
                        </button>
                        <span className="material-symbols-outlined text-on-surface-variant text-[18px] group-hover:text-primary transition-colors">
                          chevron_right
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* RIGHT COLUMN: Real Occurrences & Learning Detail (7 Cols) */}
          <div className="xl:col-span-7 flex flex-col gap-space-md">
            {selectedItem ? (
              <div className="bg-surface-container-lowest rounded-2xl p-space-lg md:p-space-xl shadow-xs border border-surface-container-high/60 space-y-6">
                {/* Pattern Header */}
                <div className="pb-space-md border-b border-surface-container-high/60">
                  <div className="flex items-center gap-2 flex-wrap mb-1.5">
                    <span className="font-label-stamp text-label-stamp px-2 py-0.5 rounded font-bold uppercase bg-surface-container-high text-on-surface-variant">
                      {getCategoryLabel(selectedItem.category)}
                    </span>
                    <span className="text-xs text-on-surface-variant">
                      {selectedItem.occurrences?.length ?? selectedItem.occurrenceCount ?? 0} lần gặp đã xác nhận
                    </span>
                    <span className="text-xs text-on-surface-variant">•</span>
                    <span className="text-xs text-on-surface-variant">
                      Gần nhất: {formatDate(selectedItem.lastSeenAt)}
                    </span>
                  </div>

                  <h2 className="font-headline-lg text-[22px] md:text-headline-lg text-on-surface font-bold tracking-tight">
                    {getPatternDisplayTitle(selectedItem.title, selectedItem.patternCode)}
                  </h2>

                  {/* Core Teaching Rule */}
                  {selectedItem.teachingRule && (
                    <div className="mt-3 bg-surface-container-low/70 p-3.5 rounded-xl border border-surface-container-high/40 flex items-start gap-2.5">
                      <span className="material-symbols-outlined text-primary text-[20px] shrink-0 mt-0.5">
                        school
                      </span>
                      <div className="space-y-0.5">
                        <span className="font-label-stamp text-[11px] text-primary uppercase font-bold tracking-wider block">
                          Quy tắc cần nhớ
                        </span>
                        <p className="font-body-md text-sm text-on-surface leading-relaxed">
                          {selectedItem.teachingRule}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Section: Những lần bạn đã mắc lỗi này */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-secondary text-[20px]">
                        history_edu
                      </span>
                      <h3 className="font-headline-sm text-base font-bold text-on-surface">
                        Những lần bạn đã mắc lỗi này
                      </h3>
                    </div>
                    <span className="text-xs text-on-surface-variant">
                      {selectedItem.occurrences && selectedItem.occurrences.length > 0
                        ? `${selectedItem.occurrences.length} lần ghi nhận thực tế`
                        : 'Không có chi tiết lịch sử'}
                    </span>
                  </div>

                  {selectedItem.occurrences && selectedItem.occurrences.length > 0 ? (
                    <div className="space-y-3.5">
                      {selectedItem.occurrences
                        .slice(0, visibleOccurrenceCount)
                        .map((occ, idx) => {
                          const hasDetails = Boolean(occ.originalText || occ.wrongSpan || occ.explanation);

                          return (
                            <div
                              key={occ.id || `occ-${idx}`}
                              className="bg-surface-container-low/50 rounded-xl p-4 border border-surface-container-high/60 space-y-3 transition-colors hover:bg-surface-container-low"
                            >
                              {/* Meta: Source & Time */}
                              <div className="flex items-center justify-between text-xs text-on-surface-variant pb-2 border-b border-surface-container-high/40">
                                <div className="flex items-center gap-1.5 font-medium">
                                  <span className="material-symbols-outlined text-[14px]">
                                    {occ.sourceFeature === 'Writing Coach' ? 'edit_note' : 'spellcheck'}
                                  </span>
                                  <span>{occ.sourceFeature || 'Sentence Lab'}</span>
                                  {occ.severity && (
                                    <span className="font-label-stamp text-[9px] px-1.5 py-0.5 rounded bg-surface-container uppercase font-bold text-on-surface-variant">
                                      {occ.severity}
                                    </span>
                                  )}
                                </div>
                                <span>{formatDateTime(occ.recordedAt)}</span>
                              </div>

                              {hasDetails ? (
                                <>
                                  {/* Câu gốc & Highlight span */}
                                  <div className="space-y-1">
                                    <span className="font-label-stamp text-[10px] uppercase font-bold text-on-surface-variant tracking-wider block">
                                      Ngữ cảnh / Câu gốc bạn đã viết
                                    </span>
                                    <div className="p-3 rounded-lg bg-surface-container-lowest border border-surface-container-high/40">
                                      {renderHighlightedSentence(
                                        occ.originalText,
                                        occ.wrongSpan,
                                        occ.startOffset,
                                        occ.endOffset
                                      )}
                                    </div>
                                  </div>

                                  {/* Wrong span vs Replacement */}
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                                    <div className="p-2.5 rounded-lg bg-error/5 border border-error/20 flex flex-col gap-0.5">
                                      <span className="font-label-stamp text-[10px] text-error font-bold uppercase">
                                        Bạn đã viết
                                      </span>
                                      <span className="font-mono text-sm font-semibold text-error line-through break-words">
                                        {occ.wrongSpan || '(chưa lưu vị trí cụ thể)'}
                                      </span>
                                    </div>

                                    <div className="p-2.5 rounded-lg bg-tertiary-fixed/30 border border-tertiary/20 flex flex-col gap-0.5">
                                      <span className="font-label-stamp text-[10px] text-tertiary font-bold uppercase">
                                        Sửa thành
                                      </span>
                                      <span className="font-mono text-sm font-semibold text-tertiary break-words">
                                        {occ.replacement || '(xem gợi ý)'}
                                      </span>
                                    </div>
                                  </div>

                                  {/* Vì sao sai (AI Explanation) */}
                                  {occ.explanation && (
                                    <div className="space-y-1 pt-0.5">
                                      <span className="font-label-stamp text-[10px] uppercase font-bold text-on-surface-variant tracking-wider block">
                                        Vì sao sai
                                      </span>
                                      <div className="p-3 rounded-lg bg-surface-container-lowest border border-surface-container-high/40 flex items-start gap-2">
                                        <span className="material-symbols-outlined text-secondary text-[16px] shrink-0 mt-0.5">
                                          lightbulb
                                        </span>
                                        <p className="font-body-md text-xs text-on-surface leading-relaxed">
                                          {occ.explanation}
                                        </p>
                                      </div>
                                    </div>
                                  )}

                                  {/* Câu sau khi sửa */}
                                  {occ.correctedSentence && (
                                    <div className="space-y-1 pt-0.5">
                                      <span className="font-label-stamp text-[10px] uppercase font-bold text-on-surface-variant tracking-wider block">
                                        Câu sau khi sửa
                                      </span>
                                      <div className="p-3 rounded-lg bg-tertiary-fixed/15 border border-tertiary/20">
                                        {renderCorrectedSentence(occ.correctedSentence, occ.replacement)}
                                      </div>
                                    </div>
                                  )}

                                  {/* Quy tắc riêng của lần ghi nhận nếu có */}
                                  {occ.teachingRule && occ.teachingRule !== selectedItem.teachingRule && (
                                    <div className="text-xs text-on-surface-variant pt-1 flex items-start gap-1.5">
                                      <span className="material-symbols-outlined text-[14px] text-primary shrink-0 mt-0.5">
                                        auto_stories
                                      </span>
                                      <span>
                                        <strong>Ghi nhớ:</strong> {occ.teachingRule}
                                      </span>
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div className="py-2 text-center text-on-surface-variant text-xs italic">
                                  Chưa lưu đủ chi tiết cho lần ghi nhận này.
                                </div>
                              )}
                            </div>
                          );
                        })}

                      {/* Pagination: Load more occurrences */}
                      {selectedItem.occurrences.length > visibleOccurrenceCount && (
                        <div className="text-center pt-2">
                          <button
                            onClick={() => setVisibleOccurrenceCount((prev) => prev + 5)}
                            type="button"
                            className="px-4 py-2 rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer border border-outline-variant"
                          >
                            Xem thêm lần ghi nhận cũ hơn ({selectedItem.occurrences.length - visibleOccurrenceCount} còn lại)
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-6 rounded-xl bg-surface-container-low text-center text-on-surface-variant text-sm">
                      Chưa lưu đủ chi tiết cho lần ghi nhận này.
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
