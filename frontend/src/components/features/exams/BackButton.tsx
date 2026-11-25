'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

interface BackButtonProps {
  href: string;
  label?: string;
  fallbackToExams?: boolean;
}

export const BackButton: React.FC<BackButtonProps> = ({
  href,
  label,
  fallbackToExams = true,
}) => {
  const { t } = useLanguage();
  const displayLabel = label || (fallbackToExams ? t.backToExams : t.backToLibrary);

  return (
    <Link
      id="exam-back-button"
      href={href}
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground text-xs font-semibold border border-border/60 transition-all shadow-xs group"
    >
      <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
      <span>{displayLabel}</span>
    </Link>
  );
};

export default BackButton;
