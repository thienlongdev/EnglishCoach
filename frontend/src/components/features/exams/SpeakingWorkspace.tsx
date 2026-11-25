'use client';

import React from 'react';
import { PublicGroupDto, PublicItemDto } from '@/types/exams';
import { SpeakingExaminerRuntime } from './SpeakingExaminerRuntime';

export interface SpeakingWorkspaceProps {
  attemptId: string;
  group?: PublicGroupDto;
  item?: PublicItemDto;
  partOrdinal?: number;
  allSpeakingItems?: Array<{
    item: PublicItemDto;
    group: PublicGroupDto;
    partOrdinal: number;
    globalIndex: number;
  }>;
  savedResponses?: Record<string, any>;
  onSelectSpeakingItem?: (placementId: string) => void;
  onSectionCompleted?: () => void;
  lang?: 'en' | 'vi';
}

/**
 * Server-authoritative IELTS Speaking Workspace.
 * Replaces the legacy client-side all-item switcher with the current-turn examiner flow.
 */
export const SpeakingWorkspace: React.FC<SpeakingWorkspaceProps> = ({
  attemptId,
  onSectionCompleted,
  lang = 'vi',
}) => {
  // completeSpeakingTurn persists the recording on the authoritative response.
  // Re-saving it through generic autosave targets the shell's stale active item
  // and is rejected once the Speaking section has completed.
  return (
    <SpeakingExaminerRuntime
      attemptId={attemptId}
      lang={lang}
      onSectionCompleted={onSectionCompleted}
    />
  );
};
