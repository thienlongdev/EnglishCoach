'use client';

import React, { useState, useMemo } from 'react';
import { PublicGroupDto, PublicItemDto } from '@/types/exams';
import {
  PenTool,
  Clock,
  CheckCircle2,
  AlertCircle,
  FileText,
  Mail,
  BookOpen,
  Image as ImageIcon,
  Check,
} from 'lucide-react';

export interface ToeicWritingWorkspaceProps {
  groups: PublicGroupDto[];
  responses?: Record<string, any>;
  onAnswerChange: (placementId: string, text: string) => void;
  saveStatus?: 'SAVED' | 'SAVING' | 'UNSAVED' | 'ERROR' | 'CLOSED';
}

export const ToeicWritingWorkspace: React.FC<ToeicWritingWorkspaceProps> = ({
  groups = [],
  responses = {},
  onAnswerChange,
  saveStatus = 'SAVED',
}) => {
  // Flatten all items across groups
  const allItems = useMemo(() => {
    const items: Array<{
      item: PublicItemDto;
      group: PublicGroupDto;
      qNumber: number;
    }> = [];
    let count = 0;
    for (const g of groups) {
      for (const it of g.items || []) {
        count++;
        items.push({ item: it, group: g, qNumber: count });
      }
    }
    return items;
  }, [groups]);

  const [activeQIndex, setActiveQIndex] = useState<number>(0);
  const current = allItems[activeQIndex] || allItems[0];
  const activeItem = current?.item;
  const qNum = current?.qNumber || 1;

  const currentAnswer = (activeItem?.placementId && responses[activeItem.placementId]) || '';

  // Helper metadata per question type
  const getTaskInfo = (num: number) => {
    if (num <= 5) {
      return {
        part: 'Part 1 (Questions 1–5)',
        title: 'Write a Sentence Based on a Picture',
        desc: 'Write one sentence based on the picture using both given words. You may change the forms of the words and you may use the words in any order.',
        type: 'PICTURE_SENTENCE' as const,
      };
    }
    if (num <= 7) {
      return {
        part: 'Part 2 (Questions 6–7)',
        title: 'Respond to a Written Request',
        desc: 'Read the email below. Show that you can understand the request and write an appropriate response.',
        type: 'EMAIL_RESPONSE' as const,
      };
    }
    return {
      part: 'Part 3 (Question 8)',
      title: 'Write an Opinion Essay',
      desc: 'Plan, write, and revise an essay in response to the topic below. A typical response includes at least 300 words.',
      type: 'OPINION_ESSAY' as const,
    };
  };

  const taskInfo = getTaskInfo(qNum);

  // Picture sentence mandatory words
  const getMandatoryWords = (num: number) => {
    switch (num) {
      case 1:
        return ['scanner', 'shelf'];
      case 2:
        return ['agreement', 'sign'];
      case 3:
        return ['inspect', 'roof'];
      case 4:
        return ['ready', 'table'];
      case 5:
        return ['payment', 'complete'];
      default:
        return [];
    }
  };
  const mandatoryWords = getMandatoryWords(qNum);

  // Image source for Q1-5
  const getPictureSrc = (num: number) => {
    switch (num) {
      case 1:
        return '/assets/toeic_wrt_q01_scanner.svg';
      case 2:
        return '/assets/toeic_wrt_q02_agreement.svg';
      case 3:
        return '/assets/toeic_wrt_q03_roof.svg';
      case 4:
        return '/assets/toeic_wrt_q04_table.svg';
      case 5:
        return '/assets/toeic_wrt_q05_payment.svg';
      default:
        return null;
    }
  };
  const pictureSrc = getPictureSrc(qNum);

  // Word count calculation
  const wordCount = useMemo(() => {
    if (typeof currentAnswer !== 'string') return 0;
    return currentAnswer.trim().split(/\s+/).filter(Boolean).length;
  }, [currentAnswer]);

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* 1. Header Banner & Question Navigation Bar */}
      <div className="bg-card border border-border rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold px-2.5 py-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                TOEIC WRITING
              </span>
              <span className="text-xs text-muted-foreground font-medium">
                {taskInfo.part}
              </span>
            </div>
            <h2 className="text-xl font-extrabold text-foreground mt-1">
              {taskInfo.title}
            </h2>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto">
            <span className="text-xs text-muted-foreground">
              {saveStatus === 'SAVING' ? 'Đang lưu...' : saveStatus === 'SAVED' ? 'Đã lưu' : 'Chưa lưu'}
            </span>
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                saveStatus === 'SAVED'
                  ? 'bg-emerald-500'
                  : saveStatus === 'SAVING'
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-muted-foreground'
              }`}
            />
          </div>
        </div>

        {/* Question Selector Tabs 1-8 */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 border-t border-border/60 pt-3">
          {allItems.map((e, idx) => {
            const hasAns = (responses[e.item.placementId] || '').trim().length > 0;
            const isSel = idx === activeQIndex;
            return (
              <button
                key={e.item.placementId}
                onClick={() => setActiveQIndex(idx)}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  isSel
                    ? 'bg-primary text-primary-foreground shadow-xs'
                    : hasAns
                    ? 'bg-muted text-foreground hover:bg-muted/80'
                    : 'bg-background text-muted-foreground border border-border hover:border-foreground/40'
                }`}
              >
                <span>Q{e.qNumber}</span>
                {hasAns && !isSel && <Check className="w-3 h-3 text-emerald-500" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. Workspace Body */}
      <div className="bg-card border border-border rounded-2xl p-6 sm:p-8 space-y-6 shadow-sm">
        {/* Instructions */}
        <div className="p-4 rounded-xl bg-muted/30 border border-border text-xs text-muted-foreground leading-relaxed">
          <p className="font-medium text-foreground">{taskInfo.desc}</p>
        </div>

        {/* Task Specific Presentation */}
        {taskInfo.type === 'PICTURE_SENTENCE' && (
          <div className="space-y-6">
            {/* Picture Stimulus */}
            {pictureSrc && (
              <div className="rounded-xl overflow-hidden border border-border bg-muted/20 flex items-center justify-center p-2 max-h-96">
                <img
                  src={pictureSrc}
                  alt={`Writing Picture ${qNum}`}
                  className="max-h-80 w-auto object-contain rounded-lg shadow-sm"
                />
              </div>
            )}

            {/* Mandatory Word Badges with dynamic checkmark */}
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">
                Từ bắt buộc phải sử dụng:
              </span>
              {mandatoryWords.map((word) => {
                const isIncluded =
                  typeof currentAnswer === 'string' &&
                  currentAnswer.toLowerCase().includes(word.toLowerCase());
                return (
                  <span
                    key={word}
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-bold border transition-all ${
                      isIncluded
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                        : 'bg-muted text-foreground border-border'
                    }`}
                  >
                    <span>{word}</span>
                    {isIncluded ? (
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <span className="text-[10px] text-muted-foreground font-normal">(chưa có)</span>
                    )}
                  </span>
                );
              })}
            </div>

            {/* Sentence Input */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-foreground block">
                Câu văn của bạn (Write one complete sentence):
              </label>
              <textarea
                rows={3}
                value={currentAnswer}
                onChange={(e) => {
                  if (activeItem?.placementId) {
                    onAnswerChange(activeItem.placementId, e.target.value);
                  }
                }}
                placeholder="Type your sentence here..."
                className="w-full p-4 rounded-xl border border-input bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 leading-relaxed resize-none"
              />
            </div>
          </div>
        )}

        {taskInfo.type === 'EMAIL_RESPONSE' && (
          <div className="space-y-6">
            {/* Incoming Email Prompt */}
            <div className="bg-muted/40 border border-border rounded-xl p-5 space-y-3 text-xs">
              <div className="flex items-center gap-2 font-bold text-primary">
                <Mail className="w-4 h-4" />
                <span>INCOMING EMAIL</span>
              </div>
              <div className="border-t border-border/60 pt-2 space-y-1 text-muted-foreground">
                <p><strong className="text-foreground">From:</strong> {qNum === 6 ? 'Mira Patel (Event Coordinator)' : 'Marcus Vance (Symposium Committee)'}</p>
                <p><strong className="text-foreground">Subject:</strong> {qNum === 6 ? 'Inquiry regarding November workshop venue' : 'Preparation for Annual Symposium'}</p>
              </div>
              <p className="border-t border-border/60 pt-3 text-foreground leading-relaxed whitespace-pre-wrap">
                {activeItem?.prompt || 'Please review the email inquiry and provide a professional reply addressing all points requested.'}
              </p>
            </div>

            {/* Reply Editor */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-foreground">
                  Phản hồi email của bạn (Your Email Response):
                </label>
                <span className="text-xs text-muted-foreground font-mono">
                  {wordCount} words
                </span>
              </div>
              <textarea
                rows={8}
                value={currentAnswer}
                onChange={(e) => {
                  if (activeItem?.placementId) {
                    onAnswerChange(activeItem.placementId, e.target.value);
                  }
                }}
                placeholder="Dear..."
                className="w-full p-4 rounded-xl border border-input bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 leading-relaxed"
              />
            </div>
          </div>
        )}

        {taskInfo.type === 'OPINION_ESSAY' && (
          <div className="space-y-6">
            {/* Essay Topic Prompt */}
            <div className="bg-muted/30 border border-border rounded-xl p-5 space-y-2">
              <span className="text-xs font-bold uppercase tracking-wider text-primary">
                Chủ đề bài luận (Essay Topic):
              </span>
              <p className="text-sm font-medium text-foreground leading-relaxed whitespace-pre-wrap">
                {activeItem?.prompt ||
                  'Do you agree or disagree with the following statement? Companies should provide paid time for employees to participate in professional development courses. Use specific reasons and examples to support your position.'}
              </p>
            </div>

            {/* Essay Editor */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-foreground">
                  Nội dung bài luận (Your Essay):
                </label>
                <span
                  className={`text-xs font-mono font-bold px-2 py-0.5 rounded-md border ${
                    wordCount >= 300
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                      : 'bg-muted text-muted-foreground border-border'
                  }`}
                >
                  {wordCount} / 300+ words
                </span>
              </div>
              <textarea
                rows={14}
                value={currentAnswer}
                onChange={(e) => {
                  if (activeItem?.placementId) {
                    onAnswerChange(activeItem.placementId, e.target.value);
                  }
                }}
                placeholder="Write your opinion essay here..."
                className="w-full p-4 rounded-xl border border-input bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 leading-relaxed font-sans"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
