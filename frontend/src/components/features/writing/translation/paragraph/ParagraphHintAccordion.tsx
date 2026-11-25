'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ParagraphAssistanceResponse,
  ParagraphAssistanceSegment
} from '@/types/paragraphTranslation';
import { paragraphTranslationApi } from '@/services/paragraphTranslationApi';
import {
  HelpCircle,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Loader2
} from 'lucide-react';

interface ParagraphHintAccordionProps {
  sessionId: string;
  ordinal: number;
}

export const ParagraphHintAccordion: React.FC<ParagraphHintAccordionProps> = ({
  sessionId,
  ordinal
}) => {
  const [loading, setLoading] = useState<boolean>(false);
  const [assistanceData, setAssistanceData] = useState<ParagraphAssistanceResponse | null>(null);

  // Multi-sentence expansion state: Set of expanded sentence indices
  const [expandedSentences, setExpandedSentences] = useState<Set<number>>(new Set());

  // 100% local token reveal state: Set of "${segIdx}_${tokIdx}" keys
  const [revealedTokens, setRevealedTokens] = useState<Set<string>>(new Set());

  // Fetch initial structure once per item
  const fetchAssistance = useCallback(async () => {
    setLoading(true);
    try {
      const data = await paragraphTranslationApi.getAssistance(sessionId, {
        ordinal,
        action: 'GET_SEGMENTS'
      });
      setAssistanceData(data);
    } catch (err) {
      console.warn('Failed to load paragraph assistance:', err);
    } finally {
      setLoading(false);
    }
  }, [sessionId, ordinal]);

  useEffect(() => {
    // Reset state on ordinal change
    setExpandedSentences(new Set());
    setRevealedTokens(new Set());
    fetchAssistance();
  }, [sessionId, ordinal, fetchAssistance]);

  // Toggle sentence expansion (multiple sentences can be expanded simultaneously)
  const toggleSentenceExpand = (idx: number) => {
    setExpandedSentences(prev => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  // Toggle individual token (masked -> revealed -> masked) - 100% local, zero network delay
  const handleToggleToken = (segIdx: number, tokIdx: number) => {
    const key = `${segIdx}_${tokIdx}`;
    setRevealedTokens(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Toggle all tokens in a single sentence (Mở cả câu / Ẩn cả câu) - 100% local
  const handleToggleSentence = (segIdx: number) => {
    const seg = assistanceData?.segments[segIdx];
    if (!seg || seg.tokens.length === 0) return;

    const isAllRevealed = seg.tokens.every((_, tokIdx) => revealedTokens.has(`${segIdx}_${tokIdx}`));

    setRevealedTokens(prev => {
      const next = new Set(prev);
      if (!isAllRevealed) {
        // "Mở cả câu" -> reveal every token in this sentence
        seg.tokens.forEach((_, tokIdx) => next.add(`${segIdx}_${tokIdx}`));
      } else {
        // "Ẩn cả câu" -> hide every token in this sentence
        seg.tokens.forEach((_, tokIdx) => next.delete(`${segIdx}_${tokIdx}`));
      }
      return next;
    });
  };

  // Paragraph-level stats
  const totalParagraphTokens = useMemo(() => {
    if (!assistanceData?.segments) return 0;
    return assistanceData.segments.reduce((acc, s) => acc + (s.tokens?.length || 0), 0);
  }, [assistanceData]);

  // Derived state: Is the entire paragraph revealed?
  const isFullParagraphRevealed = useMemo(() => {
    if (!assistanceData?.segments || totalParagraphTokens === 0) return false;
    return assistanceData.segments.every((seg, sIdx) =>
      seg.tokens.every((_, tokIdx) => revealedTokens.has(`${sIdx}_${tokIdx}`))
    );
  }, [assistanceData, totalParagraphTokens, revealedTokens]);

  // Toggle all tokens across full paragraph (Xem cả đoạn mẫu / Ẩn đoạn mẫu) - 100% local
  const handleToggleFullParagraph = () => {
    if (!assistanceData?.segments) return;

    setRevealedTokens(prev => {
      if (!isFullParagraphRevealed) {
        // "Xem cả đoạn mẫu" -> reveal all tokens in all sentences
        const next = new Set<string>();
        assistanceData.segments.forEach((seg, sIdx) => {
          seg.tokens.forEach((_, tokIdx) => next.add(`${sIdx}_${tokIdx}`));
        });
        return next;
      } else {
        // "Ẩn đoạn mẫu" -> hide all tokens across all sentences
        return new Set<string>();
      }
    });
  };

  if (loading && !assistanceData) {
    return (
      <div className="rounded-2xl border border-surface-container-high bg-surface-container-lowest/80 p-4 space-y-3 shadow-xs">
        <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Đang tải gợi ý đoạn văn...</span>
        </div>
      </div>
    );
  }

  if (!assistanceData || assistanceData.segments.length === 0) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-surface-container-high bg-surface-container-lowest/80 p-4 space-y-3 shadow-xs">
      {/* Top Header Row with Paragraph Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider">
          <HelpCircle className="w-4 h-4" />
          <span>Gợi ý theo từng câu ({assistanceData.segments.length} câu)</span>
        </div>

        <button
          type="button"
          onClick={handleToggleFullParagraph}
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-semibold transition-all cursor-pointer shadow-2xs ${
            isFullParagraphRevealed
              ? 'border-secondary/30 bg-surface-container text-secondary hover:bg-surface-container-high'
              : 'border-secondary/40 text-secondary hover:bg-secondary/10'
          }`}
        >
          {isFullParagraphRevealed ? (
            <>
              <EyeOff className="w-3.5 h-3.5" />
              <span>Ẩn đoạn mẫu</span>
            </>
          ) : (
            <>
              <Eye className="w-3.5 h-3.5" />
              <span>Xem cả đoạn mẫu</span>
            </>
          )}
        </button>
      </div>

      {/* Full Reference Box (shown when all tokens are revealed or full toggle active) */}
      {isFullParagraphRevealed && assistanceData.fullReferenceEn && (
        <div className="p-3.5 rounded-xl bg-secondary-container/20 border border-secondary-container text-xs text-on-surface leading-relaxed animate-in fade-in">
          <span className="font-bold block text-secondary mb-1">Bản dịch mẫu toàn đoạn:</span>
          {assistanceData.fullReferenceEn}
        </div>
      )}

      {/* Sentences List */}
      <div className="space-y-2">
        {assistanceData.segments.map((seg, sIdx) => {
          const isExpanded = expandedSentences.has(sIdx);
          const isSentenceAllRevealed =
            seg.tokens.length > 0 &&
            seg.tokens.every((_, tokIdx) => revealedTokens.has(`${sIdx}_${tokIdx}`));
          const revealedInSentenceCount = seg.tokens.filter((_, tokIdx) =>
            revealedTokens.has(`${sIdx}_${tokIdx}`)
          ).length;

          return (
            <div
              key={sIdx}
              className={`rounded-xl border transition-all ${
                isExpanded
                  ? 'border-primary/40 bg-surface-container-low'
                  : 'border-surface-container hover:border-surface-container-high bg-surface-container-lowest'
              }`}
            >
              {/* Sentence Accordion Header */}
              <button
                type="button"
                onClick={() => toggleSentenceExpand(sIdx)}
                className="w-full flex items-center justify-between p-2.5 text-left text-xs font-semibold text-on-surface cursor-pointer select-none"
              >
                <div className="flex items-center gap-2 truncate pr-2">
                  <span className="w-5 h-5 rounded-full bg-surface-container-high text-outline text-[10px] font-bold flex items-center justify-center shrink-0">
                    {sIdx + 1}
                  </span>
                  <span className="truncate text-on-surface-variant font-normal">
                    {seg.sourceVi}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-outline shrink-0">
                  <span className="text-[10px]">
                    {revealedInSentenceCount > 0
                      ? `${revealedInSentenceCount}/${seg.tokens.length} từ`
                      : `${seg.tokens.length} từ`}
                  </span>
                  {isExpanded ? (
                    <ChevronUp className="w-3.5 h-3.5 text-primary" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                </div>
              </button>

              {/* Expanded Sentence Content */}
              {isExpanded && (
                <div className="p-3 pt-0 border-t border-surface-container-high/40 mt-1 space-y-2.5 animate-in fade-in duration-150">
                  {/* Vietnamese Context */}
                  <div className="text-[11px] text-on-surface-variant italic">
                    &quot;{seg.sourceVi}&quot;
                  </div>

                  {/* Masked Tokens Board (Sentence Mode interaction model) */}
                  <div className="flex flex-wrap items-center gap-1.5 p-2 bg-surface-container rounded-lg">
                    {seg.tokens.map((tok, tokIdx) => {
                      const key = `${sIdx}_${tokIdx}`;
                      const isWordRevealed = revealedTokens.has(key);

                      // Token parsing: separate punctuation and core word
                      const match = tok.match(/^([^\w]*)(.*?)([^\w]*)$/);
                      const leadingPunct = match ? match[1] : '';
                      const cleanWord = match ? match[2] : tok;
                      const trailingPunct = match ? match[3] : '';
                      const firstChar = cleanWord.length > 0 ? cleanWord[0] : tok[0] || '';
                      const maskLength = Math.max(0, cleanWord.length - 1);

                      return (
                        <span key={tokIdx} className="inline-flex items-center select-none">
                          {isWordRevealed ? (
                            <button
                              type="button"
                              onClick={() => handleToggleToken(sIdx, tokIdx)}
                              title="Nhấp để ẩn lại từ này"
                              className="inline-flex items-center px-2 py-0.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary font-bold text-xs border border-primary/20 shadow-2xs transition-all cursor-pointer hover:scale-105 active:scale-95"
                            >
                              {leadingPunct}{cleanWord || tok}{trailingPunct}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleToggleToken(sIdx, tokIdx)}
                              title="Nhấp để mở từ này"
                              className="inline-flex items-center px-2 py-0.5 rounded-lg bg-surface-container-lowest hover:bg-primary/5 hover:border-primary/40 border border-surface-container-high font-mono text-xs tracking-wider text-on-surface transition-all cursor-pointer shadow-2xs hover:scale-105 active:scale-95"
                            >
                              {leadingPunct && (
                                <span className="text-on-surface-variant font-medium mr-0.5">
                                  {leadingPunct}
                                </span>
                              )}
                              <span className="font-bold text-primary">{firstChar}</span>
                              <span className="text-outline/70">
                                {'*'.repeat(maskLength)}
                              </span>
                              {trailingPunct && (
                                <span className="text-on-surface-variant font-medium ml-0.5">
                                  {trailingPunct}
                                </span>
                              )}
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </div>

                  {/* Actions for this sentence: Mở cả câu / Ẩn cả câu */}
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[10px] text-on-surface-variant">
                      Đã mở {revealedInSentenceCount}/{seg.tokens.length} từ
                    </span>

                    <button
                      type="button"
                      onClick={() => handleToggleSentence(sIdx)}
                      className={`inline-flex items-center gap-1 text-[11px] font-bold transition-all cursor-pointer ${
                        isSentenceAllRevealed
                          ? 'text-outline hover:text-on-surface hover:underline'
                          : 'text-primary hover:underline'
                      }`}
                    >
                      {isSentenceAllRevealed ? (
                        <>
                          <EyeOff className="w-3 h-3" />
                          <span>Ẩn cả câu</span>
                        </>
                      ) : (
                        <>
                          <Eye className="w-3 h-3" />
                          <span>Mở cả câu</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
