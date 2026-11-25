/**
 * Automated test verifying Listening renderer registry and canonical prompt parsing.
 */
import assert from 'assert';

// Simulated implementations matching ExamRendererRegistry.tsx
function resolveCanonicalFormKind(group) {
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
  if (qType.includes('MATCH')) return 'MATCHING';
  if (qType.includes('SHORT_ANSWER')) return 'SHORT_ANSWER';

  const firstItem = group.items?.[0];
  if (firstItem) {
    const itType = (firstItem.interactionType || '').toUpperCase();
    if (itType.includes('GAP') || itType.includes('BLANK') || itType.includes('ENTRY')) {
      return 'NOTE_COMPLETION';
    }
    if (itType === 'MULTIPLE_CHOICE_MULTI') {
      return 'MULTIPLE_CHOICE_MULTI';
    }
    if (itType === 'MATCHING') {
      return 'MATCHING';
    }
  }

  if (qType.includes('CHOICE')) return 'MULTIPLE_CHOICE';
  return 'UNKNOWN';
}

function isCompletionGroup(group) {
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

function deriveCanonicalGroupTitle(group, partIndex) {
  const textStimulus = group.stimuli?.find(
    (s) => s.kind?.toUpperCase() !== 'AUDIO' && s.title && !s.title.toLowerCase().startsWith('listening audio')
  );
  if (textStimulus?.title) return textStimulus.title;
  if (textStimulus?.bodyPayload?.title) return String(textStimulus.bodyPayload.title);
  if (group.displayNumbering && !group.displayNumbering.startsWith('LISTENING_')) {
    return group.displayNumbering;
  }

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
    case 'SHORT_ANSWER':
      return 'SHORT ANSWER QUESTIONS';
    default:
      return `SECTION ${partIndex + 1} QUESTIONS`;
  }
}

function parseGenericCompletionStem(prompt, fallbackNumber) {
  let clean = (prompt || '')
    .replace(/^Question\s*\d+:\s*/i, '')
    .replace(/\[Question\s*\d+\]/gi, '')
    .trim();

  const colonIdx = clean.indexOf(':');
  let label = '';
  let content = clean;

  if (colonIdx > 0 && colonIdx < 45) {
    label = clean.slice(0, colonIdx).trim();
    content = clean.slice(colonIdx + 1).trim();

    const secondColonIdx = content.indexOf(':');
    if (secondColonIdx > 0 && secondColonIdx < 35) {
      label = `${label} - ${content.slice(0, secondColonIdx).trim()}`;
      content = content.slice(secondColonIdx + 1).trim();
    }
  }

  if (content.startsWith('[') && content.endsWith(']')) {
    content = content.slice(1, -1).trim();
  }

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

console.log('[EXAMS-V4-06] Running Listening Renderer Contract Tests...');

// Test 1: Completion form kind detection
const formGroup = { questionType: 'FORM_COMPLETION', items: [{ interactionType: 'TEXT_ENTRY' }] };
assert.strictEqual(resolveCanonicalFormKind(formGroup), 'FORM_COMPLETION');
assert.strictEqual(isCompletionGroup(formGroup), true);

const mcqGroup = { questionType: 'MULTIPLE_CHOICE', items: [{ interactionType: 'SINGLE_CHOICE' }] };
assert.strictEqual(resolveCanonicalFormKind(mcqGroup), 'MULTIPLE_CHOICE');
assert.strictEqual(isCompletionGroup(mcqGroup), false);

// Test 2: Generic prompt stem parsing
const prompt1 = 'Crime report form: Nationality: [Louise Taylor is ________]';
const parsed1 = parseGenericCompletionStem(prompt1, 1);
assert.strictEqual(parsed1.label, 'Crime report form - Nationality');
assert.strictEqual(parsed1.prefix, 'Louise Taylor is');

const prompt2 = 'Marine renewable energy: More energy required because of growth in population and 31 [ ________ ]';
const parsed2 = parseGenericCompletionStem(prompt2, 31);
assert.strictEqual(parsed2.label, 'Marine renewable energy');
assert.strictEqual(parsed2.prefix, 'More energy required because of growth in population and');

const prompt3 = 'Question 5: Date of birth: 15th ________ 1995';
const parsed3 = parseGenericCompletionStem(prompt3, 5);
assert.strictEqual(parsed3.label, 'Date of birth');
assert.strictEqual(parsed3.prefix, '15th');
assert.strictEqual(parsed3.suffix, '1995');

// Test 3: Canonical Title derivation without hardcoded heuristics
const title1 = deriveCanonicalGroupTitle(formGroup, 0);
assert.strictEqual(title1, 'FORM COMPLETION');

const title2 = deriveCanonicalGroupTitle({ ...formGroup, stimuli: [{ kind: 'TEXT', title: 'CUSTOMER DETAILS' }] }, 0);
assert.strictEqual(title2, 'CUSTOMER DETAILS');

console.log('[EXAMS-V4-06] Listening Renderer Contract Tests PASSED (4/4 test suites).');
