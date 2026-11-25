"use client";

import React, { useMemo } from 'react';
import { FeedbackIssue } from '@/types/writing';
import { AlertTriangle, Lightbulb, HelpCircle } from 'lucide-react';

interface EvidenceTextProps {
  text: string;
  issues: FeedbackIssue[];
  selectedIssueId?: string | null;
  onSelectIssue?: (issue: FeedbackIssue) => void;
  className?: string;
}

interface TextSegment {
  start: number;
  end: number;
  text: string;
  issue?: FeedbackIssue;
}

export const EvidenceText: React.FC<EvidenceTextProps> = ({
  text,
  issues,
  selectedIssueId,
  onSelectIssue,
  className = ''
}) => {
  // Sort and segment text by issue offsets without overlapping corruption
  const segments = useMemo(() => {
    if (!text) return [];
    if (!issues || issues.length === 0) {
      return [{ start: 0, end: text.length, text }];
    }

    // Sort valid issues by startOffset
    const sortedIssues = [...issues]
      .filter(i => i.startOffset >= 0 && i.endOffset <= text.length && i.startOffset < i.endOffset)
      .sort((a, b) => a.startOffset - b.startOffset);

    const result: TextSegment[] = [];
    let currentPos = 0;

    for (const issue of sortedIssues) {
      // If there is unhighlighted text before this issue
      if (issue.startOffset > currentPos) {
        result.push({
          start: currentPos,
          end: issue.startOffset,
          text: text.substring(currentPos, issue.startOffset)
        });
        currentPos = issue.startOffset;
      }

      // If this issue starts after or at currentPos, include it
      if (issue.startOffset >= currentPos) {
        result.push({
          start: issue.startOffset,
          end: issue.endOffset,
          text: text.substring(issue.startOffset, issue.endOffset),
          issue
        });
        currentPos = issue.endOffset;
      }
    }

    // Trailing unhighlighted text
    if (currentPos < text.length) {
      result.push({
        start: currentPos,
        end: text.length,
        text: text.substring(currentPos)
      });
    }

    return result;
  }, [text, issues]);

  return (
    <div className={`leading-[1.7] text-[1.3rem] md:text-[1.6rem] font-semibold tracking-[-0.01em] text-gray-900 dark:text-gray-100 ${className}`}>
      {segments.map((seg, idx) => {
        if (!seg.issue) {
          return <span key={`plain-${idx}`}>{seg.text}</span>;
        }

        const issue = seg.issue;
        const isSelected = selectedIssueId === issue.id;
        const isError = issue.kind === 'ERROR';
        const isImprovement = issue.kind === 'IMPROVEMENT';

        return (
          <span
            key={`issue-${issue.id || idx}`}
            onClick={() => onSelectIssue && onSelectIssue(issue)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                onSelectIssue && onSelectIssue(issue);
              }
            }}
            className={`
              relative inline-flex items-baseline px-1 py-0.5 rounded cursor-pointer transition-all duration-150 mx-0.5
              ${isError
                ? 'bg-rose-100 dark:bg-rose-950/50 border-b-2 border-rose-500 text-rose-900 dark:text-rose-200'
                : isImprovement
                ? 'bg-amber-100 dark:bg-amber-950/50 border-b-2 border-amber-500 text-amber-900 dark:text-amber-200'
                : 'bg-gray-100 dark:bg-gray-800 border-b-2 border-gray-400 text-gray-800 dark:text-gray-300'
              }
              ${isSelected ? 'ring-2 ring-indigo-500 shadow-sm font-medium' : 'hover:opacity-90'}
            `}
            title={`${issue.title}: ${issue.explanation}`}
          >
            <span className="underline decoration-dotted underline-offset-4">{seg.text}</span>
            <span className="ml-1 inline-flex items-center text-xs opacity-70">
              {isError && <AlertTriangle className="w-3 h-3 text-rose-600 inline" />}
              {isImprovement && <Lightbulb className="w-3 h-3 text-amber-600 inline" />}
              {!isError && !isImprovement && <HelpCircle className="w-3 h-3 text-gray-500 inline" />}
            </span>
          </span>
        );
      })}
    </div>
  );
};
