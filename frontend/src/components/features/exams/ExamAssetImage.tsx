'use client';

import React from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import type { PublicAssetRefDto } from '@/types/exams';
import { useExamAssetUrl } from '@/lib/exams/media';

interface ExamAssetImageProps {
  attemptId?: string;
  asset: PublicAssetRefDto;
  alt: string;
  className?: string;
}

/**
 * Exams Phase 4B.6 — renders an exam image asset (TOEIC Part 1 photo, Part 3/4 graphic, IELTS map / diagram, Writing
 * Task 1 visual) through its playback grant. A refused grant (asset still PENDING crop QA, no rights) shows an
 * explicit "unavailable" state instead of a guessed static path.
 */
export function ExamAssetImage({ attemptId, asset, alt, className }: ExamAssetImageProps) {
  const { status, url } = useExamAssetUrl(attemptId, asset);

  if (status === 'ready' && url) {
    return (
      <img
        src={url}
        alt={alt}
        data-capability="IMAGE_STIMULUS_GRANT"
        className={className || 'w-full max-w-2xl h-auto max-h-[680px] object-contain rounded-lg border border-border/80 shadow-xs bg-white'}
      />
    );
  }
  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground" role="status">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Đang tải hình ảnh… / Loading image…</span>
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-2 p-4 rounded-lg border border-dashed border-border text-xs text-muted-foreground"
      role="img"
      aria-label={alt}
    >
      <ImageOff className="w-4 h-4 shrink-0" />
      <span>Hình ảnh chưa sẵn sàng / Image not available</span>
    </div>
  );
}
