'use client';

import React, { useState, useMemo } from 'react';
import {
  TranslationCatalog,
  TranslationStartRequest,
} from '@/types/writing';
import {
  BookOpen,
  ArrowRight,
  Filter,
  Play,
  RotateCcw,
  Layers,
  FileText,
  AlertCircle,
  Languages,
  Library,
  Tags,
} from 'lucide-react';
import { WritingHero, Glyph, StatePanel, topicIdentity, glass } from '../glass/WritingGlass';
import {
  ALL_TRANSLATION_DIFFICULTIES_LABEL,
  formatTranslationDifficultyLabel,
} from './translationDifficultyLabel';

interface TranslationHomeProps {
  catalog: TranslationCatalog | null;
  loading: boolean;
  onStartSession: (request: TranslationStartRequest) => void;
  onResumeSession: (sessionId: string) => void;
  onSelectMode?: (mode: 'SENTENCE' | 'PARAGRAPH') => void;
}

export const TranslationHome: React.FC<TranslationHomeProps> = ({
  catalog,
  loading,
  onStartSession,
  onResumeSession,
  onSelectMode
}) => {
  const [selectedMode, setSelectedMode] = useState<'SENTENCE' | 'PARAGRAPH'>('SENTENCE');
  const [selectedTopic, setSelectedTopic] = useState<string>('ALL');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('ALL');

  // Filter collections by topic and difficulty
  const filteredCollections = useMemo(() => {
    if (!catalog?.collections) return [];
    return catalog.collections.filter((col) => {
      if (selectedMode === 'SENTENCE' && col.mode !== 'SENTENCE') return false;
      if (selectedMode === 'PARAGRAPH' && col.mode !== 'PARAGRAPH') return false;
      if (selectedTopic !== 'ALL' && col.topicCode !== selectedTopic) return false;
      if (selectedDifficulty !== 'ALL' && col.difficultyBucket !== selectedDifficulty) return false;
      return true;
    });
  }, [catalog, selectedMode, selectedTopic, selectedDifficulty]);

  // Hero facts: the catalog's own sentence collections (never an estimate)
  const sentenceCollections = useMemo(() => (catalog?.collections || []).filter((c) => c.mode === 'SENTENCE'), [catalog]);
  const sentenceTotal = sentenceCollections.reduce((sum, c) => sum + (c.sentenceCount || c.exerciseCount || 0), 0);

  const isParagraphEnabled = Boolean(catalog?.paragraphModeEnabled || process.env.NEXT_PUBLIC_TRANSLATION_PARAGRAPH_ENABLED === 'true');

  const active = catalog?.activeSession || null;
  const activeTopicName = active ? (catalog?.topics?.find((t) => t.code === active.topicCode)?.displayName || active.topicCode) : '';
  const activeDifficultyLabel = active?.difficultyBucket ? formatTranslationDifficultyLabel(active.difficultyBucket) : '';
  const activeShare = active && active.totalUnits > 0 ? Math.min(100, Math.round((active.currentOrdinal / active.totalUnits) * 100)) : 0;

  const modeSwitch = (
    <div className={`${glass.seg} ${glass.segDark}`} role="group" aria-label="Chế độ luyện dịch">
      <button
        type="button"
        onClick={() => setSelectedMode('SENTENCE')}
        aria-pressed={selectedMode === 'SENTENCE'}
        className={glass.segBtn}
      >
        <BookOpen aria-hidden="true" />
        <span>Câu đơn</span>
      </button>
      <button
        type="button"
        disabled={!isParagraphEnabled}
        onClick={() => {
          if (isParagraphEnabled) {
            setSelectedMode('PARAGRAPH');
            onSelectMode?.('PARAGRAPH');
          }
        }}
        aria-pressed={selectedMode === 'PARAGRAPH'}
        title={!isParagraphEnabled ? 'Chưa khả dụng - Đang kiểm duyệt ngữ liệu mạch lạc' : 'Luyện dịch đoạn văn'}
        className={glass.segBtn}
      >
        <Layers aria-hidden="true" />
        <span>Đoạn văn</span>
        {!isParagraphEnabled && <span className={glass.segBadge}>Sắp mở</span>}
      </button>
    </div>
  );

  if (loading) {
    return (
      <div className={glass.stack} aria-busy="true">
        <div className={glass.skeleton} style={{ minHeight: '15rem', borderRadius: '1.75rem' }} />
        <div className={glass.skeleton} style={{ minHeight: '4rem' }} />
        <div className={glass.grid}>
          {[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className={glass.skeleton} />)}
        </div>
      </div>
    );
  }

  return (
    <div className={`${glass.stack} pb-6`}>
      <WritingHero
        world="translation"
        titleId="translation-hero-title"
        eyebrow="Việt → Anh · Luyện dịch"
        eyebrowIcon={<Languages aria-hidden="true" />}
        title="Luyện dịch"
        accent="Việt → Anh"
        lead="Đọc câu tiếng Việt, viết tiếng Anh, nhận phản hồi chuẩn xác theo ngữ cảnh và tự nhiên."
        stats={catalog ? [
          { value: sentenceCollections.length, label: 'Bộ câu đơn', icon: <Library aria-hidden="true" /> },
          { value: catalog.topics?.length ?? 0, label: 'Chủ đề', icon: <Tags aria-hidden="true" /> },
          { value: sentenceTotal.toLocaleString('vi-VN'), label: 'Câu luyện dịch', icon: <FileText aria-hidden="true" /> },
        ] : []}
        side={modeSwitch}
      />

      {/* Resume Active Session Row (Only if real active session exists) */}
      {active && (
        <div className={`${glass.panel} ${glass.resume}`}>
          <div className="flex items-center gap-3.5 min-w-[min(100%,16rem)] flex-1">
            <span className={glass.resumeOrb} aria-hidden="true"><RotateCcw className="w-5 h-5" /></span>
            <div className="flex flex-col min-w-0 gap-1 flex-1">
              <span className={`${glass.label} ${glass.labelInk}`}>Tiếp tục phiên đang làm dở</span>
              <h3 className="text-base sm:text-lg font-bold text-on-surface truncate">
                {activeTopicName}{activeDifficultyLabel ? ` · ${activeDifficultyLabel}` : ''} · Đang ở câu {active.currentOrdinal} / {active.totalUnits}
              </h3>
              <div className={`${glass.meter} max-w-md`} aria-hidden="true"><i style={{ ['--p' as string]: `${activeShare}%` }} /></div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onResumeSession(active.sessionId)}
            className={`${glass.btn} ${glass.btnPrimary}`}
          >
            <span>Tiếp tục ngay</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Filter Row: Topic & Difficulty */}
      <div className={`${glass.panel} ${glass.toolbar}`}>
        <div className={glass.toolbarGroup}>
          <span className="flex items-center gap-2 text-xs font-bold text-on-surface-variant pl-0.5">
            <Filter className="w-3.5 h-3.5 text-secondary" aria-hidden="true" />
            <span>Bộ lọc</span>
          </span>

          <select
            value={selectedTopic}
            onChange={(e) => setSelectedTopic(e.target.value)}
            aria-label="Chủ đề"
            className={glass.select}
          >
            <option value="ALL">Tất cả chủ đề</option>
            {catalog?.topics?.map((topic) => (
              <option key={topic.code} value={topic.code}>
                {topic.displayName} ({topic.count})
              </option>
            ))}
          </select>

          <select
            value={selectedDifficulty}
            onChange={(e) => setSelectedDifficulty(e.target.value)}
            aria-label="Trình độ"
            className={glass.select}
          >
            <option value="ALL">{ALL_TRANSLATION_DIFFICULTIES_LABEL}</option>
            {catalog?.difficulties?.map((diff) => (
              <option key={diff.code} value={diff.code}>
                {formatTranslationDifficultyLabel(diff.code, diff.displayName)} ({diff.count})
              </option>
            ))}
          </select>
        </div>

        <span className={glass.chip} aria-live="polite">
          {filteredCollections.length} bộ bài tập sẵn sàng
        </span>
      </div>

      {/* Collections Grid */}
      {filteredCollections.length > 0 ? (
        <div className={glass.grid}>
          {filteredCollections.map((col, idx) => {
            const isCurrentActive = catalog?.activeSession && (catalog.activeSession.exerciseId === col.exerciseId || (!col.exerciseId && catalog.activeSession.topicCode === col.topicCode));
            const sentenceCount = col.sentenceCount || col.exerciseCount;
            const identity = topicIdentity(col.topicCode);
            const difficultyLabel = formatTranslationDifficultyLabel(col.difficultyBucket, col.difficultyDisplayName);

            return (
              <article
                key={`${col.topicCode}-${col.difficultyBucket}-${idx}`}
                className={`${glass.card} ${isCurrentActive ? glass.cardActive : ''}`}
                data-tone={identity.tone}
              >
                <div className={glass.cardHead}>
                  <Glyph tone={identity.tone} icon={identity.icon} />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className={glass.cardMeta}>
                      <span className={glass.chip}>{col.topicCode}</span>
                      <span className={`${glass.chip} ${glass.chipInk}`}>{difficultyLabel}</span>
                    </div>
                    <h3 className={glass.cardTitle}>{col.topicDisplayName}</h3>
                  </div>
                </div>

                <div className={glass.cardFoot}>
                  <span className={glass.cardCount}>
                    <FileText aria-hidden="true" />
                    <span>{sentenceCount} câu</span>
                    {col.exerciseCount > 1 && (
                      <span className="text-[11px] text-outline font-medium">
                        ({col.exerciseCount} bộ)
                      </span>
                    )}
                  </span>

                  <button
                    type="button"
                    data-guide="tr-start"
                    onClick={() =>
                      isCurrentActive
                        ? onResumeSession(catalog!.activeSession!.sessionId)
                        : onStartSession({
                            exerciseId: col.exerciseId,
                            topicCode: col.topicCode,
                            difficultyBucket: col.difficultyBucket,
                            mode: 'SENTENCE',
                            clientMutationId: crypto.randomUUID()
                          })
                    }
                    className={`${glass.btn} ${glass.btnSm} ${glass.btnPrimary}`}
                    aria-label={`${isCurrentActive ? 'Tiếp tục' : 'Bắt đầu'}: ${col.topicDisplayName} · ${difficultyLabel}`}
                  >
                    <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                    <span>{isCurrentActive ? 'Tiếp tục' : 'Bắt đầu'}</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <StatePanel
          icon={<AlertCircle />}
          title="Chưa có bộ bài tập phù hợp"
          text="Vui lòng thử chọn bộ lọc khác hoặc kiểm tra lại các chủ đề đang có sẵn."
          actions={
            <button
              type="button"
              onClick={() => {
                setSelectedTopic('ALL');
                setSelectedDifficulty('ALL');
              }}
              className={`${glass.btn} ${glass.btnSoft}`}
            >
              Đặt lại bộ lọc
            </button>
          }
        />
      )}
    </div>
  );
};
