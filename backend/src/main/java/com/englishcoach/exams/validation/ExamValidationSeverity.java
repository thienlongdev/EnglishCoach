package com.englishcoach.exams.validation;

/**
 * Effect of one validation diagnostic on mode eligibility (Exams Recovery Phase 2).
 * <ul>
 *   <li>{@link #BLOCKING}: the section is unusable in every mode (broken / placeholder / unscorable content).</li>
 *   <li>{@link #STANDARD}: the section still works for Practice, but is not a standardized simulation and never
 *       yields official evidence (blueprint counts, unvalidated audio, missing rubric, operator review…).</li>
 *   <li>{@link #WARNING} / {@link #INFO}: reported only; no effect on eligibility.</li>
 * </ul>
 */
public enum ExamValidationSeverity {
    BLOCKING,
    STANDARD,
    WARNING,
    INFO
}
