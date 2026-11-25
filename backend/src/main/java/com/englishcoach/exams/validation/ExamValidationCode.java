package com.englishcoach.exams.validation;

import static com.englishcoach.exams.validation.ExamValidationSeverity.*;

/**
 * Structured diagnostic codes of the authoritative exam content validator (Exams Recovery Phase 2).
 * Each code has a default severity; a diagnostic may override it (e.g. a TOEIC set that is too large is
 * BLOCKING, one that is too small is STANDARD). TOEIC codes carry a part number and render as
 * {@code TOEIC_PART_<n>_<SUFFIX>} (see {@link ExamValidationDiagnostic#qualifiedCode()}).
 */
public enum ExamValidationCode {
    // ── Form / scope ─────────────────────────────────────────────────────────────
    VALIDATION_UNAVAILABLE(BLOCKING),
    NO_SECTIONS(BLOCKING),
    FORM_SCOPE_UNKNOWN(STANDARD),
    FORM_SKILL_MISSING(STANDARD),
    SCORING_SCHEME_MISSING(STANDARD),
    // ── Operator restrictions (legacy columns: restrict-only, never grant) ──────────
    OPERATOR_FORM_DISABLED(BLOCKING),
    OPERATOR_SECTION_DISABLED(BLOCKING),
    OPERATOR_REVIEW_REQUIRED(STANDARD),
    // ── Section / structure ───────────────────────────────────────────────────────
    SECTION_TIMING_MISSING(BLOCKING),
    SECTION_DURATION_NONSTANDARD(WARNING),
    NO_ITEMS(BLOCKING),
    PART_CODE_UNKNOWN(BLOCKING),
    PART_SKILL_MISMATCH(BLOCKING),
    DUPLICATE_ITEM_ID(BLOCKING),
    DUPLICATE_ITEM_KEY(STANDARD),
    ITEM_ORDER_INVALID(STANDARD),
    // ── Item content ──────────────────────────────────────────────────────────────
    PROMPT_MISSING(BLOCKING),
    PLACEHOLDER_PROMPT_DETECTED(BLOCKING),
    INTERACTION_TYPE_UNSUPPORTED(BLOCKING),
    OPTIONS_MISSING(BLOCKING),
    PLACEHOLDER_OPTIONS(BLOCKING),
    OPTION_ID_MISSING(BLOCKING),
    DUPLICATE_OPTION_ID(BLOCKING),
    // ── Answer keys / scoring ─────────────────────────────────────────────────────
    ANSWER_KEY_MISSING(BLOCKING),
    ANSWER_KEY_EMPTY(BLOCKING),
    ANSWER_SPEC_DUPLICATE(BLOCKING),
    INVALID_OPTION_KEY(BLOCKING),
    INVALID_TOEIC_ANSWER_KEY(BLOCKING),
    PRODUCTIVE_RUBRIC_MISSING(STANDARD),
    WORD_LIMIT_MISSING(STANDARD),
    // ── Media ─────────────────────────────────────────────────────────────────────
    REQUIRED_AUDIO_MISSING(BLOCKING),
    UNVALIDATED_MEDIA(STANDARD),
    // ── TOEIC blueprint ───────────────────────────────────────────────────────────
    TOEIC_PART_MISSING(STANDARD),
    TOEIC_PART_ITEM_COUNT(STANDARD),
    TOEIC_PART_GROUP_COUNT(STANDARD),
    TOEIC_GROUP_SIZE(BLOCKING),
    TOEIC_PASSAGE_MISSING(BLOCKING),
    TOEIC_MULTI_PASSAGE_MISSING(STANDARD),
    TOEIC_IMAGE_MISSING(BLOCKING),
    TOEIC_PART_AUDIO_MISSING(STANDARD),
    TOEIC_OPTION_COUNT(STANDARD),
    TOEIC_TASK_COUNT(STANDARD),
    // ── IELTS blueprint ───────────────────────────────────────────────────────────
    IELTS_ITEM_COUNT(STANDARD),
    IELTS_LISTENING_PART_COUNT(STANDARD),
    IELTS_LISTENING_PART_AUDIO_MISSING(STANDARD),
    IELTS_READING_PASSAGE_MISSING(BLOCKING),
    IELTS_READING_PASSAGE_COUNT(STANDARD),
    IELTS_WRITING_TASK_COUNT(STANDARD),
    IELTS_WRITING_VISUAL_MISSING(STANDARD),
    SPEAKING_PROMPTS_RUNTIME_GENERATED(INFO);

    private final ExamValidationSeverity defaultSeverity;

    ExamValidationCode(ExamValidationSeverity defaultSeverity) {
        this.defaultSeverity = defaultSeverity;
    }

    public ExamValidationSeverity defaultSeverity() {
        return defaultSeverity;
    }
}
