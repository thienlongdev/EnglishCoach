'use client';

import React, { useLayoutEffect, useRef, useState } from 'react';
import { FlaskConical, FolderOpen, Keyboard, Languages, PenLine } from 'lucide-react';
import { WritingView } from '@/types/writing';
import { useLanguage } from '@/context/LanguageContext';
import { glass } from './glass/WritingGlass';

interface WritingNavigationProps {
  activeView: WritingView;
  onSelectView: (view: WritingView) => void;
}

export const WritingNavigation: React.FC<WritingNavigationProps> = ({ activeView, onSelectView }) => {
  const { t, locale } = useLanguage();
  const tabs: { id: WritingView; label: string; icon: typeof Languages }[] = [
    { id: 'translation', label: locale === 'vi' ? 'Luyện dịch' : 'Translation', icon: Languages },
    { id: 'sentence-lab', label: t.sentenceLabTab || 'Sentence Lab', icon: FlaskConical },
    { id: 'typing', label: locale === 'vi' ? 'Luyện gõ' : 'Typing Practice', icon: Keyboard },
    { id: 'coach', label: t.coachTab || 'Writing Coach', icon: PenLine },
    { id: 'portfolio', label: t.portfolioTab || 'Hồ sơ bài viết', icon: FolderOpen }
  ];
  // 'for-you' is an alias of the translation view (route-state): the translation tab is the one shown.
  const shown: WritingView = activeView === 'for-you' ? 'translation' : activeView;

  // The lit capsule slides to the active tab: measured from the real button (labels change width with the language).
  const nav = useRef<HTMLElement>(null);
  const [glow, setGlow] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const host = nav.current;
    if (!host) return;
    const measure = () => {
      const active = host.querySelector<HTMLElement>('[aria-current="page"]');
      if (active) setGlow({ x: active.offsetLeft, w: active.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [shown, locale]);

  return (
    <nav
      ref={nav}
      className={glass.tabs}
      aria-label={locale === 'vi' ? 'Các phòng của Phòng viết' : 'Writing studio navigation'}
      data-measured={glow ? '' : undefined}
      style={glow ? ({ '--tx': `${glow.x}px`, '--tw': `${glow.w}px`, '--to': 1 } as React.CSSProperties) : undefined}
    >
      <span className={glass.tabGlow} aria-hidden="true" />
      {tabs.map((tab) => {
        const isActive = shown === tab.id;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelectView(tab.id)}
            aria-current={isActive ? 'page' : undefined}
            className={glass.tab}
            data-testid={`writing-tab-${tab.id}`}
            aria-label={tab.label}
            title={tab.label}
          >
            <Icon aria-hidden="true" />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
};
