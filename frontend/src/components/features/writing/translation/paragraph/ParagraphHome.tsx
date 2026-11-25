'use client';

import React, { useState } from 'react';
import {
  ParagraphCatalog,
  ParagraphStartRequest
} from '@/types/paragraphTranslation';
import {
  BookOpen,
  ArrowRight,
  RotateCcw,
  Layers,
  FileText,
  CheckCircle2,
  Languages,
  Library,
  Tags
} from 'lucide-react';
import { WritingHero, Glyph, topicIdentity, glass } from '../../glass/WritingGlass';
import { formatTranslationDifficultyLabel } from '../translationDifficultyLabel';

interface ParagraphHomeProps {
  catalog: ParagraphCatalog | null;
  loading: boolean;
  onStartSession: (request: ParagraphStartRequest) => void;
  onResumeSession: (sessionId: string) => void;
  onSelectSentenceMode: () => void;
}

const TOPIC_VN_NAMES: Record<string, string> = {
  ALL: 'Tất cả',
  TECHNOLOGY: 'Công nghệ',
  GENERAL: 'Tổng hợp',
  SOCIETY: 'Xã hội',
  CULTURE: 'Văn hóa',
  WORK: 'Công việc',
  EDUCATION: 'Giáo dục',
  ENVIRONMENT: 'Môi trường',
  FAMILY: 'Gia đình',
  URBAN_LIFE: 'Đời sống đô thị',
  HEALTH: 'Sức khỏe',
  TRAVEL: 'Du lịch'
};

const getTopicDisplayName = (topic: string): string => {
  return TOPIC_VN_NAMES[topic] || topic;
};

export const ParagraphHome: React.FC<ParagraphHomeProps> = ({
  catalog,
  loading,
  onStartSession,
  onResumeSession,
  onSelectSentenceMode
}) => {
  const [selectedTopic, setSelectedTopic] = useState<string>('ALL');

  if (loading && !catalog) {
    return (
      <div className={glass.stack} aria-busy="true">
        <div className={glass.skeleton} style={{ minHeight: '15rem', borderRadius: '1.75rem' }} />
        <div className={glass.grid}>
          {[1, 2, 3].map((i) => <div key={i} className={glass.skeleton} />)}
        </div>
      </div>
    );
  }

  // Filter topics with count > 0 only (hide empty categories)
  const availableTopics = (catalog?.topics || []).filter(t => t.count > 0);
  const allCount = catalog?.totalEligiblePassages ?? catalog?.totalPassages ?? 0;

  // Selected topic object and selectable count
  const selectedTopicItem = availableTopics.find(t => t.topic === selectedTopic);
  const selectableCount = selectedTopic === 'ALL'
    ? allCount
    : (selectedTopicItem?.count ?? 0);

  // Active session
  const activeSession = catalog?.activeSession;

  const handleStart = () => {
    const topic = selectedTopic !== 'ALL' ? selectedTopic : undefined;
    onStartSession({
      clientMutationId: `start-para-${Date.now()}`,
      topic
    });
  };

  return (
    <div className={`${glass.stack} pb-6`}>
      <WritingHero
        world="translation"
        titleId="paragraph-hero-title"
        eyebrow="Việt → Anh · Đoạn văn"
        eyebrowIcon={<Languages aria-hidden="true" />}
        title="Luyện dịch"
        accent="đoạn văn mạch lạc"
        lead="Chấm điểm đồng thời 5 khía cạnh: Ngữ nghĩa, Ngữ pháp, Tự nhiên, Từ vựng và Tính liên kết."
        stats={catalog ? [
          { value: allCount.toLocaleString('vi-VN'), label: 'Đoạn văn', icon: <Library aria-hidden="true" /> },
          { value: availableTopics.length, label: 'Chủ đề', icon: <Tags aria-hidden="true" /> },
        ] : []}
        side={
          <div className={`${glass.seg} ${glass.segDark}`} role="group" aria-label="Chế độ luyện dịch">
            <button type="button" onClick={onSelectSentenceMode} aria-pressed={false} className={glass.segBtn}>
              <BookOpen aria-hidden="true" />
              <span>Câu đơn</span>
            </button>
            <button type="button" aria-pressed={true} className={glass.segBtn}>
              <Layers aria-hidden="true" />
              <span>Đoạn văn</span>
            </button>
          </div>
        }
      />

      {/* Resume Active Session Row */}
      {activeSession && (
        <div className={`${glass.panel} ${glass.resume} animate-in fade-in`}>
          <div className="flex items-center gap-3.5 min-w-0">
            <span className={glass.resumeOrb} aria-hidden="true"><RotateCcw className="w-5 h-5" /></span>
            <div className="flex flex-col min-w-0">
              <span className={`${glass.label} ${glass.labelInk}`}>
                Tiếp tục phiên đoạn văn đang làm dở
              </span>
              <h3 className="text-base sm:text-lg font-bold text-on-surface">
                {getTopicDisplayName(activeSession.filterTopic || 'ALL')} · Đang ở đoạn {(activeSession.currentIndex ?? 0) + 1} / {activeSession.totalItems?.toLocaleString('vi-VN')}
              </h3>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onResumeSession(activeSession.sessionId)}
            className={`${glass.btn} ${glass.btnPrimary}`}
          >
            <span>Tiếp tục làm</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Real Inventory Card */}
      <div className={`${glass.panel} p-5 sm:p-6 space-y-6`}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-outline-variant/40">
          <div className="flex items-center gap-3">
            <h2 className="font-title-lg text-title-lg font-bold text-on-surface">
              Kho ngữ liệu đoạn văn
            </h2>
            <span className={glass.chip}>
              {allCount.toLocaleString('vi-VN')}
            </span>
          </div>

          <button
            type="button"
            disabled={selectableCount === 0}
            onClick={handleStart}
            className={`${glass.btn} ${glass.btnPrimary}`}
          >
            <span>Bắt đầu phiên luyện tập ({selectableCount.toLocaleString('vi-VN')})</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>

        {/* Section: CHỌN CHỦ ĐỀ (Large Cards matching Sentence Translation collection cards) */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className={glass.label}>
              Chọn chủ đề
            </span>
            <span className="text-xs text-on-surface-variant font-medium">
              {availableTopics.length + 1} chủ đề có sẵn
            </span>
          </div>

          <div className={glass.grid}>
            {/* Card: Tất cả */}
            <button
              type="button"
              onClick={() => setSelectedTopic('ALL')}
              aria-pressed={selectedTopic === 'ALL'}
              data-tone="general"
              className={`group ${glass.card} ${selectedTopic === 'ALL' ? glass.cardActive : ''} text-left cursor-pointer`}
            >
              <div className="space-y-3 w-full">
                <div className="flex items-center justify-between">
                  <Glyph tone="general" icon={Layers} small />
                  {selectedTopic === 'ALL' && (
                    <CheckCircle2 className="w-5 h-5 text-primary" />
                  )}
                </div>
                <h3 className={`text-lg font-bold transition-colors ${
                  selectedTopic === 'ALL' ? 'text-primary' : 'text-on-surface group-hover:text-primary'
                }`}>
                  Tất cả chủ đề
                </h3>
              </div>

              <div className={`${glass.cardFoot} w-full`}>
                <span className={glass.cardCount}>
                  <FileText aria-hidden="true" />
                  <span>{allCount.toLocaleString('vi-VN')} đoạn</span>
                </span>
                <span className="text-xs font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                  Chọn chủ đề &rarr;
                </span>
              </div>
            </button>

            {/* Topic Cards */}
            {availableTopics.map(t => {
              const isSelected = selectedTopic === t.topic;
              const vnName = getTopicDisplayName(t.topic);
              return (
                <button
                  key={t.topic}
                  type="button"
                  onClick={() => setSelectedTopic(t.topic)}
                  aria-pressed={isSelected}
                  data-tone={topicIdentity(t.topic).tone}
                  className={`group ${glass.card} ${isSelected ? glass.cardActive : ''} text-left cursor-pointer`}
                >
                  <div className="space-y-3 w-full">
                    <div className="flex items-center justify-between">
                      <Glyph tone={topicIdentity(t.topic).tone} icon={topicIdentity(t.topic).icon} small />
                      {isSelected && (
                        <CheckCircle2 className="w-5 h-5 text-primary" />
                      )}
                    </div>
                    <h3 className={`text-lg font-bold transition-colors ${
                      isSelected ? 'text-primary' : 'text-on-surface group-hover:text-primary'
                    }`}>
                      {vnName}
                    </h3>
                  </div>

                  <div className={`${glass.cardFoot} w-full`}>
                    <span className={glass.cardCount}>
                      <FileText aria-hidden="true" />
                      <span>{t.count.toLocaleString('vi-VN')} đoạn</span>
                    </span>
                    <span className={glass.chip}>
                      {formatTranslationDifficultyLabel(
                        t.difficultyLabel || catalog?.difficulty?.status,
                        catalog?.difficulty?.label || 'Chưa hiệu chuẩn'
                      )}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

