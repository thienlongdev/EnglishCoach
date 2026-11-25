/**
 * Exams Recovery Phase 4B.9 — declared runtime capabilities of the CURRENT learner runner.
 *
 * The backend gate (`BE/exams/release/ExamRunnerCapabilities.java`) mirrors this table exactly and
 * `scripts/check-exams-phase4-runtime-contract.mjs` fails when the two drift, when a declared component file is missing,
 * or when a SUPPORTED feature's `data-capability` marker is absent from the component that claims it. A capability is
 * listed SUPPORTED only when the renderer actually implements it; everything else stays PARTIAL / UNSUPPORTED so import
 * readiness fails closed.
 */

export type RunnerSupport = 'SUPPORTED' | 'PARTIAL' | 'UNSUPPORTED';

export interface RunnerCapability {
  support: RunnerSupport;
  /** Component (relative to src/components/features/exams) that implements the capability. */
  component: string;
  /** data-capability marker rendered by that component (features only). */
  marker?: string;
}

/** Interaction types × answer payload the runner stores (one option id / one text / recording). */
export const RUNNER_INTERACTIONS: Record<string, RunnerCapability> = {
  SINGLE_CHOICE: { support: 'SUPPORTED', component: 'QuestionRenderers.tsx' },
  TRUTH_CLASSIFICATION: { support: 'SUPPORTED', component: 'QuestionRenderers.tsx' },
  MATCHING: { support: 'SUPPORTED', component: 'QuestionRenderers.tsx' },
  HEADING_MATCHING: { support: 'SUPPORTED', component: 'QuestionRenderers.tsx' },
  TEXT_GAP: { support: 'SUPPORTED', component: 'QuestionRenderers.tsx' },
  SHORT_ANSWER: { support: 'SUPPORTED', component: 'QuestionRenderers.tsx' },
  MULTIPLE_CHOICE_MULTI: { support: 'SUPPORTED', component: 'QuestionRenderers.tsx' },
  WRITING_RESPONSE: { support: 'SUPPORTED', component: 'WritingEditor.tsx' },
  // Original-bank prompts are pinned in the attempt; scoped Parts use their own recording/completion requirements.
  SPEAKING_RESPONSE: { support: 'SUPPORTED', component: 'SpeakingExaminerRuntime.tsx' },
  // Exams Phase 6: label the map / plan / diagram — one select per printed target over the canonical option pool; the
  // figure is rendered once by GroupQuestionBlock (playback grant). No drag-and-drop required.
  LABEL_ASSIGNMENT: { support: 'SUPPORTED', component: 'QuestionRenderers.tsx' },
};

/** Presentation / media features a package may require. */
export const RUNNER_FEATURES: Record<string, RunnerCapability> = {
  GROUP_INSTRUCTIONS: { support: 'SUPPORTED', component: 'GroupQuestionBlock.tsx', marker: 'GROUP_INSTRUCTIONS' },
  COMPLETION_TEMPLATE: { support: 'SUPPORTED', component: 'GroupQuestionBlock.tsx', marker: 'COMPLETION_TEMPLATE' },
  CHOOSE_N_SELECTION: { support: 'SUPPORTED', component: 'GroupQuestionBlock.tsx', marker: 'CHOOSE_N_SELECTION' },
  WORD_LIMIT_DISPLAY: { support: 'SUPPORTED', component: 'GroupQuestionBlock.tsx', marker: 'WORD_LIMIT_DISPLAY' },
  MULTI_DOC_SEGMENTED: { support: 'SUPPORTED', component: 'StimulusRenderer.tsx', marker: 'MULTI_DOC_SEGMENTED' },
  IMAGE_STIMULUS_GRANT: { support: 'SUPPORTED', component: 'ExamAssetImage.tsx', marker: 'IMAGE_STIMULUS_GRANT' },
  PER_PART_AUDIO_PLAYLIST: { support: 'SUPPORTED', component: 'ToeicListeningWorkspace.tsx', marker: 'PER_PART_AUDIO_PLAYLIST' },
  // Playing a [start, end] range of one parent recording is NOT supported: segments must be explicit derived assets.
  VIRTUAL_AUDIO_RANGE: { support: 'UNSUPPORTED', component: 'ToeicListeningWorkspace.tsx' },
};
