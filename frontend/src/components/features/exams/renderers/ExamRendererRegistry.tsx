'use client';

import React from 'react';
import { PublicGroupDto, PublicItemDto } from '@/types/exams';

export type CanonicalFormKind =
  | 'FORM_COMPLETION'
  | 'NOTE_COMPLETION'
  | 'TABLE_COMPLETION'
  | 'FLOWCHART_COMPLETION'
  | 'SUMMARY_COMPLETION'
  | 'SENTENCE_COMPLETION'
  | 'SHORT_ANSWER'
  | 'MULTIPLE_CHOICE'
  | 'MULTIPLE_CHOICE_MULTI'
  | 'MATCHING'
  | 'HEADING_MATCHING'
  | 'TRUE_FALSE_NOT_GIVEN'
  | 'YES_NO_NOT_GIVEN'
  | 'MAP_LABELLING'
  | 'DIAGRAM_LABELLING'
  | 'UNKNOWN';

export type CanonicalInteractionType =
  | 'SINGLE_CHOICE'
  | 'MULTIPLE_CHOICE'
  | 'MULTIPLE_CHOICE_MULTI'
  | 'TEXT_ENTRY'
  | 'TEXT_GAP'
  | 'FILL_IN_BLANK'
  | 'SHORT_ANSWER'
  | 'MATCHING'
  | 'TRUTH_CLASSIFICATION'
  | 'HEADING_MATCHING'
  | 'UNKNOWN';

/**
 * Resolves the canonical formKind for a group based on explicit content metadata,
 * falling back to questionType / interactionType compatibility without prompt heuristics.
 */
export function resolveCanonicalFormKind(group: PublicGroupDto): CanonicalFormKind {
  if (group.formKind) {
    const fk = group.formKind.toUpperCase();
    if (fk.includes('FORM')) return 'FORM_COMPLETION';
    if (fk.includes('NOTE')) return 'NOTE_COMPLETION';
    if (fk.includes('TABLE')) return 'TABLE_COMPLETION';
    if (fk.includes('FLOW')) return 'FLOWCHART_COMPLETION';
    if (fk.includes('SUMMARY')) return 'SUMMARY_COMPLETION';
    if (fk.includes('SENTENCE')) return 'SENTENCE_COMPLETION';
    if (fk.includes('SHORT')) return 'SHORT_ANSWER';
    if (fk.includes('MAP')) return 'MAP_LABELLING';
    if (fk.includes('DIAGRAM')) return 'DIAGRAM_LABELLING';
    if (fk.includes('HEADING')) return 'HEADING_MATCHING';
    if (fk.includes('TRUE_FALSE') || fk.includes('TFNG')) return 'TRUE_FALSE_NOT_GIVEN';
    if (fk.includes('YES_NO') || fk.includes('YNNG')) return 'YES_NO_NOT_GIVEN';
    if (fk.includes('MATCH')) return 'MATCHING';
    if (fk.includes('CHOICE') || fk.includes('MCQ')) return 'MULTIPLE_CHOICE';
  }

  const qType = (group.questionType || '').toUpperCase();
  if (qType.includes('FORM')) return 'FORM_COMPLETION';
  if (qType.includes('NOTE')) return 'NOTE_COMPLETION';
  if (qType.includes('TABLE')) return 'TABLE_COMPLETION';
  if (qType.includes('FLOW')) return 'FLOWCHART_COMPLETION';
  if (qType.includes('SUMMARY')) return 'SUMMARY_COMPLETION';
  if (qType.includes('GAP') || qType.includes('COMPLETION') || qType.includes('BLANK')) return 'NOTE_COMPLETION';
  if (qType.includes('HEADING')) return 'HEADING_MATCHING';
  if (qType.includes('TRUE_FALSE') || qType.includes('TFNG')) return 'TRUE_FALSE_NOT_GIVEN';
  if (qType.includes('YES_NO') || qType.includes('YNNG')) return 'YES_NO_NOT_GIVEN';
  if (qType.includes('MATCH')) return 'MATCHING';
  if (qType.includes('SHORT_ANSWER')) return 'SHORT_ANSWER';

  // Check first item interaction type
  const firstItem = group.items?.[0];
  if (firstItem) {
    const itType = (firstItem.interactionType || '').toUpperCase();
    if (itType.includes('GAP') || itType.includes('BLANK') || itType.includes('ENTRY')) {
      return 'NOTE_COMPLETION';
    }
    if (itType === 'MULTIPLE_CHOICE_MULTI') {
      return 'MULTIPLE_CHOICE_MULTI';
    }
    if (itType === 'HEADING_MATCHING') {
      return 'HEADING_MATCHING';
    }
    if (itType === 'TRUTH_CLASSIFICATION') {
      const opts = firstItem.options || firstItem.optionDefinitions;
      const optList = Array.isArray(opts) ? opts : (opts as any)?.options || [];
      const hasYes = optList.some((o: any) => String(o.label || o.text || o.id || o).toUpperCase() === 'YES');
      return hasYes ? 'YES_NO_NOT_GIVEN' : 'TRUE_FALSE_NOT_GIVEN';
    }
    if (itType === 'MATCHING') {
      return 'MATCHING';
    }
    if (itType.includes('SHORT')) {
      return 'SHORT_ANSWER';
    }
  }

  if (qType.includes('CHOICE')) return 'MULTIPLE_CHOICE';

  return 'UNKNOWN';
}

/**
 * Checks if a group is a completion-style question (Form, Note, Table, Gap, Blank).
 */
export function isCompletionGroup(group: PublicGroupDto): boolean {
  const kind = resolveCanonicalFormKind(group);
  return (
    kind === 'FORM_COMPLETION' ||
    kind === 'NOTE_COMPLETION' ||
    kind === 'TABLE_COMPLETION' ||
    kind === 'FLOWCHART_COMPLETION' ||
    kind === 'SUMMARY_COMPLETION' ||
    kind === 'SENTENCE_COMPLETION' ||
    kind === 'SHORT_ANSWER'
  );
}

/**
 * Derives a clean canonical title for a group or section from metadata.
 * Never uses hardcoded exam titles.
 */
export function deriveCanonicalGroupTitle(group: PublicGroupDto, partIndex: number): string {
  // 1. Check if group stimuli contains an explicit non-audio title
  const textStimulus = group.stimuli?.find(
    (s) => s.kind?.toUpperCase() !== 'AUDIO' && s.title && !s.title.toLowerCase().startsWith('listening audio')
  );
  if (textStimulus?.title) {
    return textStimulus.title;
  }

  // 2. Check stimulus body title
  if (textStimulus?.bodyPayload?.title) {
    return String(textStimulus.bodyPayload.title);
  }

  // 3. Check group's displayNumbering or logicalGroupKey
  if (group.displayNumbering && !group.displayNumbering.startsWith('LISTENING_')) {
    return group.displayNumbering;
  }

  // 4. Derive from canonical formKind
  const kind = resolveCanonicalFormKind(group);
  switch (kind) {
    case 'FORM_COMPLETION':
      return 'FORM COMPLETION';
    case 'NOTE_COMPLETION':
      return 'EXAMINATION NOTES';
    case 'TABLE_COMPLETION':
      return 'TABLE COMPLETION';
    case 'FLOWCHART_COMPLETION':
      return 'FLOWCHART COMPLETION';
    case 'SUMMARY_COMPLETION':
      return 'SUMMARY COMPLETION';
    case 'SENTENCE_COMPLETION':
      return 'SENTENCE COMPLETION';
    case 'MATCHING':
      return 'MATCHING QUESTIONS';
    case 'HEADING_MATCHING':
      return 'LIST OF HEADINGS';
    case 'TRUE_FALSE_NOT_GIVEN':
      return 'TRUE / FALSE / NOT GIVEN';
    case 'YES_NO_NOT_GIVEN':
      return 'YES / NO / NOT GIVEN';
    case 'SHORT_ANSWER':
      return 'SHORT ANSWER QUESTIONS';
    default:
      return `SECTION ${partIndex + 1} QUESTIONS`;
  }
}

/**
 * Formats completion prompt stems generically without hardcoded exam names.
 */
export function parseGenericCompletionStem(prompt: string, fallbackNumber: number) {
  let clean = (prompt || '')
    .replace(/^Question\s*\d+:\s*/i, '')
    .replace(/\[Question\s*\d+\]/gi, '')
    .trim();

  // Check for leading topic/context prefix before first colon
  const colonIdx = clean.indexOf(':');
  let label = '';
  let content = clean;

  if (colonIdx > 0 && colonIdx < 45) {
    label = clean.slice(0, colonIdx).trim();
    content = clean.slice(colonIdx + 1).trim();

    // If there is a second colon: e.g. "Nationality: Louise Taylor is ________"
    const secondColonIdx = content.indexOf(':');
    if (secondColonIdx > 0 && secondColonIdx < 35) {
      label = `${label} - ${content.slice(0, secondColonIdx).trim()}`;
      content = content.slice(secondColonIdx + 1).trim();
    }
  }

  if (content.startsWith('[') && content.endsWith(']')) {
    content = content.slice(1, -1).trim();
  }

  // Regex to detect standard blank marker: ________ or [ ________ ] or 31 [ ________ ]
  const blankRegex = /(\d+\s*)?\[?\s*_{2,}\s*\]?/;
  const match = content.match(blankRegex);

  let prefix = content;
  let suffix = '';
  if (match && match.index !== undefined) {
    prefix = content.slice(0, match.index).trim();
    suffix = content.slice(match.index + match[0].length).trim();
  }

  return { label, prefix, suffix, rawPrompt: clean };
}
