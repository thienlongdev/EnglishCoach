package com.englishcoach.exams.validation;

import com.englishcoach.exams.model.ExamTypes.SkillType;

import java.util.Locale;

/**
 * The ONE official-evidence eligibility rule for an exam score component (Exams Recovery Phase 2, snapshot-safe since
 * Phase 4.1D). Shared by {@code ExamJobWorker} (exams.profile_evidence) and {@code proficiency.EvidenceMapper}
 * (live listener, nightly reconciliation and backfill all go through the mapper), so no caller invents its own.
 *
 * <p>Order (first failure wins, all fail closed):
 * <ol>
 *   <li>attempt mode is EXAM_SIMULATION (PRACTICE never creates official evidence);</li>
 *   <li>result status is COMPLETED (scoring finished, nothing pending review);</li>
 *   <li>the component was not produced by an AI fallback rubric;</li>
 *   <li>the metric is a skill (FULL_OVERALL / LR_TOTAL never) and has a non-negative score;</li>
 *   <li>the attempt carries a PINNED evidence basis ({@link ExamAttemptEvidenceBasis}) for its own form and mode —
 *       legacy attempts without one are {@link Reason#LEGACY_VALIDATION_UNAVAILABLE} (no new authoritative evidence;
 *       historical validation is never reconstructed from current content), a contradictory basis is
 *       {@link Reason#SNAPSHOT_BASIS_MISMATCH};</li>
 *   <li>the skill is in the basis' evidence-eligible skills (simulation-grade at attempt creation, in scope).</li>
 * </ol>
 * The CURRENT form validation is never consulted: a later version, retirement, validator change or operator flag
 * cannot change the decision for an attempt that has already been taken.
 * Consumer-specific tiering stays with the consumer and also uses the pinned lifecycle: profile evidence additionally
 * needs a form that was PUBLISHED at attempt time (plus the V7 backstop); Proficiency maps PUBLISHED → T1, PILOT → T2.
 */
public final class ExamEvidenceEligibilityPolicy {

    private ExamEvidenceEligibilityPolicy() {}

    public enum Reason {
        ELIGIBLE,
        PRACTICE_MODE,
        MODE_UNKNOWN,
        NOT_COMPLETED,
        AI_FALLBACK,
        UNCALIBRATED_ESTIMATE,
        NOT_A_SKILL_METRIC,
        NO_SCORE,
        LEGACY_VALIDATION_UNAVAILABLE,
        SNAPSHOT_BASIS_MISMATCH,
        CONTENT_NOT_ELIGIBLE
    }

    public record Decision(boolean eligible, Reason reason, SkillType skill) {}

    public static Decision decide(String attemptMode, String resultStatus, String metric, double scaledScore,
                                  boolean aiFallback, ExamAttemptEvidenceBasis.Resolution basis) {
        String mode = attemptMode == null ? "" : attemptMode.trim().toUpperCase(Locale.ROOT);
        if ("PRACTICE".equals(mode)) return new Decision(false, Reason.PRACTICE_MODE, null);
        if (!"EXAM_SIMULATION".equals(mode)) return new Decision(false, Reason.MODE_UNKNOWN, null);
        if (resultStatus == null || !"COMPLETED".equalsIgnoreCase(resultStatus.trim())) {
            return new Decision(false, Reason.NOT_COMPLETED, null);
        }
        if (aiFallback) return new Decision(false, Reason.AI_FALLBACK, null);
        SkillType skill = skillOf(metric);
        if (skill == null) return new Decision(false, Reason.NOT_A_SKILL_METRIC, null);
        if (Double.isNaN(scaledScore) || scaledScore < 0) return new Decision(false, Reason.NO_SCORE, skill);
        if (basis == null || basis.kind() == ExamAttemptEvidenceBasis.Kind.LEGACY_VALIDATION_UNAVAILABLE) {
            return new Decision(false, Reason.LEGACY_VALIDATION_UNAVAILABLE, skill);
        }
        if (!basis.pinned()) return new Decision(false, Reason.SNAPSHOT_BASIS_MISMATCH, skill);
        return basis.basis().evidenceSkills().contains(skill)
                ? new Decision(true, Reason.ELIGIBLE, skill)
                : new Decision(false, Reason.CONTENT_NOT_ELIGIBLE, skill);
    }

    /** LISTENING / READING / WRITING / SPEAKING metric → skill; FULL_OVERALL, LR_TOTAL, unknown → null. */
    public static SkillType skillOf(String metric) {
        if (metric == null) return null;
        return switch (metric.trim().toUpperCase(Locale.ROOT)) {
            case "LISTENING" -> SkillType.LISTENING;
            case "READING" -> SkillType.READING;
            case "WRITING" -> SkillType.WRITING;
            case "SPEAKING" -> SkillType.SPEAKING;
            default -> null;
        };
    }
}
