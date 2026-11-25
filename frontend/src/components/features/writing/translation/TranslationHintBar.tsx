'use client';

import React, { useState, useMemo } from 'react';
import { Eye, EyeOff, BookOpen, KeyRound } from 'lucide-react';
import { TranslationUnit, TranslationToken } from '@/types/writing';

interface TranslationHintBarProps {
  unit: TranslationUnit;
  onHelperClick?: (helper: { text?: string; cue?: string; kind?: string }) => void;
  onWordClick?: (word: string) => void;
  disabled?: boolean;
}

export const TranslationHintBar: React.FC<TranslationHintBarProps> = ({
  unit,
  onHelperClick,
  onWordClick,
  disabled = false
}) => {
  // Completely local UI state: isolated per unitId
  const [revealedMap, setRevealedMap] = useState<Record<string, Set<number>>>({});

  const tokens: TranslationToken[] = unit.maskedTokens || [];
  const wordTokens = useMemo(() => tokens.filter((t) => !t.punctuationOnly && t.length > 0), [tokens]);

  const currentRevealed = useMemo(() => {
    return revealedMap[unit.unitId] || new Set<number>();
  }, [revealedMap, unit.unitId]);

  // Derived state: allRevealed = numberOfRevealedReferenceTokens === numberOfReferenceTokens
  const allRevealed = wordTokens.length > 0 && wordTokens.every((t) => currentRevealed.has(t.index));
  const revealedWordCount = wordTokens.filter((t) => currentRevealed.has(t.index)).length;
  const hasHelpers = unit.visibleHints && unit.visibleHints.length > 0;

  // Toggle individual token (masked -> revealed -> masked) - 100% local, zero network/AI/loading
  const handleToggleToken = (tokenIndex: number) => {
    if (disabled) return;
    setRevealedMap((prev) => {
      const existing = new Set(prev[unit.unitId] || []);
      if (existing.has(tokenIndex)) {
        existing.delete(tokenIndex);
      } else {
        existing.add(tokenIndex);
      }
      return { ...prev, [unit.unitId]: existing };
    });
  };

  // Toggle Show All / Hide All - 100% local
  const handleToggleAll = () => {
    if (disabled) return;
    setRevealedMap((prev) => {
      const nextSet = new Set<number>();
      if (!allRevealed) {
        // "Hiện tất cả" -> reveal all tokens
        wordTokens.forEach((t) => nextSet.add(t.index));
      }
      // If allRevealed == true -> nextSet is empty -> "Ẩn tất cả" -> hide all tokens
      return { ...prev, [unit.unitId]: nextSet };
    });
  };

  return (
    <div className="w-full flex flex-col gap-3.5 p-5 bg-surface-container-low border border-surface-container-high rounded-3xl shadow-xs">
      {/* Header and Toggle Action */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-label-md text-label-md font-bold text-on-surface">
            Câu mẫu — nhớ dùng để mở từ
          </span>
          {wordTokens.length > 0 && (
            <span className="text-[11px] text-on-surface-variant font-medium">
              Đã mở {revealedWordCount}/{wordTokens.length} từ
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {tokens.length > 0 && (
            <button
              type="button"
              onClick={handleToggleAll}
              disabled={disabled}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all cursor-pointer shadow-2xs ${
                allRevealed
                  ? 'border-secondary/30 bg-surface-container text-secondary hover:bg-surface-container-high'
                  : 'border-secondary/40 hover:bg-secondary/10 text-secondary'
              }`}
            >
              {allRevealed ? (
                <>
                  <EyeOff className="w-3.5 h-3.5" />
                  <span>Ẩn tất cả</span>
                </>
              ) : (
                <>
                  <Eye className="w-3.5 h-3.5" />
                  <span>Hiện tất cả</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Masked Reference Tokens Interactive Board */}
      <div className="p-3.5 bg-surface-container rounded-2xl border border-surface-container-high/70 space-y-2">
        <div className="text-[11px] font-semibold text-secondary uppercase tracking-wider">
          GỢI Ý CÂU MẪU TIẾNG ANH:
        </div>

        {tokens.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 pt-0.5 text-base font-sans leading-relaxed">
            {tokens.map((token) => {
              if (token.punctuationOnly) {
                return (
                  <span key={token.index} className="text-on-surface-variant font-medium select-none px-0.5">
                    {token.word}
                  </span>
                );
              }

              const isTokenRevealed = currentRevealed.has(token.index);

              return (
                <span key={token.index} className="inline-flex items-center select-none">
                  {token.leadingPunct && (
                    <span className="text-on-surface-variant font-medium mr-0.5">
                      {token.leadingPunct}
                    </span>
                  )}

                  {isTokenRevealed ? (
                    <button
                      type="button"
                      onClick={() => handleToggleToken(token.index)}
                      disabled={disabled}
                      className="inline-flex items-center px-2 py-0.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary font-bold text-sm border border-primary/20 shadow-2xs transition-all cursor-pointer hover:scale-105 active:scale-95"
                      title="Nhấp để ẩn lại từ này"
                    >
                      {token.word || `${token.firstChar}${'*'.repeat(Math.max(0, token.length - 1))}`}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleToggleToken(token.index)}
                      disabled={disabled}
                      className="inline-flex items-center px-2 py-0.5 rounded-lg bg-surface-container-lowest hover:bg-primary/5 hover:border-primary/40 border border-surface-container-high font-mono text-sm tracking-wider text-on-surface transition-all cursor-pointer shadow-2xs hover:scale-105 active:scale-95"
                      title="Nhấp để mở từ này"
                    >
                      <span className="font-bold text-primary">{token.firstChar}</span>
                      <span className="text-outline/70">
                        {'*'.repeat(Math.max(0, token.length - 1))}
                      </span>
                    </button>
                  )}

                  {token.trailingPunct && (
                    <span className="text-on-surface-variant font-medium ml-0.5">
                      {token.trailingPunct}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-on-surface-variant italic">
            Đang tải dữ liệu gợi ý...
          </div>
        )}
      </div>

      {/* Vocabulary / Collocation Helpers (Fully visible in full phrase, NO '(p...)' artifact) */}
      {hasHelpers && (
        <div className="flex flex-col gap-2 pt-1 border-t border-surface-container-high/60">
          <div className="text-[11px] font-semibold text-secondary uppercase tracking-wider flex items-center gap-1.5">
            <KeyRound className="w-3 h-3 text-secondary" />
            <span>CỤM TỪ VÀ TỪ VỰNG GỢI Ý:</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {unit.visibleHints.map((hint, idx) => {
              const phrase = hint.text || hint.cue || '';
              if (!phrase) return null;

              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    if (onHelperClick) {
                      onHelperClick(hint);
                    } else if (onWordClick) {
                      onWordClick(phrase);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold border border-surface-container-high/80 hover:border-primary/40 shadow-2xs transition-all cursor-pointer group"
                  title="Nhấp để xem chi tiết, tra từ và lưu Flashcard"
                >
                  <BookOpen className="w-3 h-3 text-secondary group-hover:text-primary transition-colors" />
                  <span className="font-sans text-primary group-hover:underline">
                    {phrase}
                  </span>
                  {hint.kind && (
                    <span className="text-[10px] uppercase font-normal text-outline px-1 rounded bg-surface-container-lowest">
                      {hint.kind}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
