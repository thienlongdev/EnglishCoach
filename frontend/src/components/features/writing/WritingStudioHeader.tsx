'use client';

import React from 'react';
import { WritingNavigation } from './WritingNavigation';
import { WritingView } from '@/types/writing';
import { useLanguage } from '@/context/LanguageContext';
import { glass } from './glass/WritingGlass';

interface WritingStudioHeaderProps {
  activeView: WritingView;
  onSelectView: (view: WritingView) => void;
}

export const WritingStudioHeader: React.FC<WritingStudioHeaderProps> = ({
  activeView,
  onSelectView,
}) => {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  return (
    <header className={glass.header}>
      <div className={glass.brand}>
        <span className={glass.brandWell} aria-hidden="true">
          <svg className="relative z-10 w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className={glass.brandTitle}>Phòng viết</p>
          <p className={glass.brandLead}>
            {vi ? 'Luyện ý tưởng rõ ràng hơn. Viết tiếng Anh tốt hơn.' : 'Clearer ideas. Better English writing.'}
          </p>
        </div>
      </div>

      <WritingNavigation activeView={activeView} onSelectView={onSelectView} />
    </header>
  );
};
