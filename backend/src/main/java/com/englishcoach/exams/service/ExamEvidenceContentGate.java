package com.englishcoach.exams.service;

import com.englishcoach.exams.model.ExamTypes.SkillType;

import java.util.UUID;

/**
 * Is this skill of this form simulation-grade according to the CURRENT authoritative content validation?
 * Implemented by {@link com.englishcoach.exams.validation.ExamContentValidationService}; fails closed (false) on any
 * doubt, including an unknown validation state.
 *
 * <p>Exams Recovery Phase 4.1D: this is NOT an official-evidence gate any more. Evidence for an attempt is decided
 * from the basis pinned to that attempt ({@link com.englishcoach.exams.validation.ExamAttemptEvidenceBasis} via
 * {@link com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy}); consulting current validation for an
 * already-taken attempt would let a later form version rewrite history.
 */
@FunctionalInterface
public interface ExamEvidenceContentGate {

    boolean isSkillContentValid(UUID formId, SkillType skill);
}
