'use client';

import React from 'react';
import { FlaskConical } from 'lucide-react';
import { SentenceLabSubView } from '@/types/writing';
import { SentenceCheck } from './SentenceCheck';
import { MyMistakes } from './MyMistakes';
import { WritingHero, glass } from '../glass/WritingGlass';

interface SentenceLabProps {
  activeSubView: SentenceLabSubView;
  initialPatternCode?: string;
  onSelectSubView: (subView: SentenceLabSubView, patternCode?: string) => void;
}

export const SentenceLab: React.FC<SentenceLabProps> = ({ activeSubView, initialPatternCode, onSelectSubView }) => {
  const SUB_TABS = [
    { id: 'check' as SentenceLabSubView, label: 'Kiểm tra câu', icon: 'spellcheck' },
    { id: 'mistakes' as SentenceLabSubView, label: 'Sổ tay lỗi sai', icon: 'history_edu' }
  ];

  return (
    <div className={`${glass.stack} pb-6`}>
      <WritingHero
        world="lab"
        titleId="sentence-lab-title"
        eyebrow="Sentence Lab · Ngữ pháp và diễn đạt"
        eyebrowIcon={<FlaskConical aria-hidden="true" />}
        title="Phòng thí nghiệm"
        accent="câu"
        lead="Phân tích ngữ pháp chuyên sâu, chuẩn hóa cấu trúc câu và quản lý sổ tay lỗi sai để nâng tầm diễn đạt."
        side={
          <div className={`${glass.seg} ${glass.segDark}`} role="tablist" aria-label="Sentence Lab">
            {SUB_TABS.map((tab) => {
              const isActive = activeSubView === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => onSelectSubView(tab.id)}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={glass.segBtn}
                >
                  <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{tab.icon}</span>
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        }
      />

      {/* Sub-view Content Panels */}
      {activeSubView === 'check' && (
        <SentenceCheck
          onNavigateMistakes={(patternCode) => onSelectSubView('mistakes', patternCode)}
        />
      )}

      {activeSubView === 'mistakes' && (
        <MyMistakes
          initialPatternCode={initialPatternCode}
          onNavigateCheck={() => onSelectSubView('check')}
        />
      )}
    </div>
  );
};
