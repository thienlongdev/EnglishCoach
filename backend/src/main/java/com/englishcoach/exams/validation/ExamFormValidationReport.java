package com.englishcoach.exams.validation;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.fasterxml.jackson.annotation.JsonIgnore;

import java.time.Instant;
import java.util.*;

/**
 * The authoritative content validation result of one form (Exams Recovery Phase 2). Catalog, attempt creation,
 * publication and official evidence all read THIS object; nothing else decides runnability.
 *
 * <ul>
 *   <li>{@link #practiceSkills}: every section of the skill is VALID or PRACTICE_ONLY.</li>
 *   <li>{@link #simulationSkills}: every section of the skill is VALID (simulation-grade). Also the content
 *       condition for official evidence ({@link #officialEvidenceSkills()}).</li>
 *   <li>{@link #fullSimulationEligible}: all sections VALID, every skill the family/scope blueprint expects is
 *       present, and no form-level STANDARD/BLOCKING finding.</li>
 * </ul>
 * An {@link ExamContentValidationStatus#UNKNOWN} report grants nothing.
 */
public record ExamFormValidationReport(
        UUID formId,
        String validatorVersion,
        String contentFingerprint,
        Instant evaluatedAt,
        ExamFamily family,
        String scope,
        String blueprintId,
        ExamContentValidationStatus status,
        boolean fullSimulationEligible,
        Set<SkillType> expectedSkills,
        Set<SkillType> practiceSkills,
        Set<SkillType> simulationSkills,
        List<SectionValidation> sections,
        List<ExamValidationDiagnostic> formDiagnostics
) {

    public static final String MODE_PRACTICE = "PRACTICE";
    public static final String MODE_EXAM_SIMULATION = "EXAM_SIMULATION";

    public ExamFormValidationReport {
        expectedSkills = immutableSkills(expectedSkills);
        practiceSkills = immutableSkills(practiceSkills);
        simulationSkills = immutableSkills(simulationSkills);
        sections = sections == null ? List.of() : List.copyOf(sections);
        formDiagnostics = formDiagnostics == null ? List.of() : List.copyOf(formDiagnostics);
        if (status == null) status = ExamContentValidationStatus.UNKNOWN;
        if (status == ExamContentValidationStatus.UNKNOWN) {
            fullSimulationEligible = false;
            practiceSkills = Set.of();
            simulationSkills = Set.of();
        }
    }

    public record SectionValidation(
            UUID sectionId,
            UUID sectionFormId,
            SkillType skill,
            int itemCount,
            ExamContentValidationStatus status,
            List<ExamValidationDiagnostic> diagnostics
    ) {
        public SectionValidation {
            diagnostics = diagnostics == null ? List.of() : List.copyOf(diagnostics);
        }
    }

    /** Fail-closed placeholder used whenever no trustworthy validation exists (errors, missing service, …). */
    public static ExamFormValidationReport unknown(UUID formId, String reason, Instant now) {
        ExamValidationDiagnostic d = new ExamValidationDiagnostic(ExamValidationCode.VALIDATION_UNAVAILABLE,
                ExamValidationSeverity.BLOCKING, null, null, null, null, null, null, 1, reason);
        return new ExamFormValidationReport(formId, ExamFormValidator.VALIDATOR_VERSION, null, now, null, null, null,
                ExamContentValidationStatus.UNKNOWN, false, Set.of(), Set.of(), Set.of(), List.of(), List.of(d));
    }

    // ─── Mode eligibility (the only questions consumers may ask) ───────────────────────────

    public boolean isPracticeRunnable(SkillType skill) {
        return skill != null && practiceSkills.contains(skill);
    }

    public boolean isSimulationReady(SkillType skill) {
        return skill != null && simulationSkills.contains(skill);
    }

    /** Content condition of official evidence: the skill is simulation-grade. Mode/status/scoring are checked by
     *  {@link ExamEvidenceEligibilityPolicy}. */
    @JsonIgnore
    public Set<SkillType> officialEvidenceSkills() {
        return simulationSkills;
    }

    public boolean isOfficialEvidenceEligible(SkillType skill) {
        return isSimulationReady(skill);
    }

    public boolean contentReviewRequired() {
        return status != ExamContentValidationStatus.VALID;
    }

    /** Modes a learner may start: PRACTICE when any skill is practice-runnable, EXAM_SIMULATION when the full form is. */
    public List<String> availableModes() {
        List<String> modes = new ArrayList<>(2);
        if (!practiceSkills.isEmpty()) modes.add(MODE_PRACTICE);
        if (fullSimulationEligible) modes.add(MODE_EXAM_SIMULATION);
        return modes;
    }

    /** Distinct qualified codes of STANDARD/BLOCKING findings, for logs and audit (no content text). */
    public List<String> blockingCodes() {
        Set<String> out = new TreeSet<>();
        for (ExamValidationDiagnostic d : allDiagnostics()) {
            if (d.severity() == ExamValidationSeverity.BLOCKING || d.severity() == ExamValidationSeverity.STANDARD) {
                out.add(d.qualifiedCode());
            }
        }
        return List.copyOf(out);
    }

    public List<ExamValidationDiagnostic> allDiagnostics() {
        List<ExamValidationDiagnostic> out = new ArrayList<>(formDiagnostics);
        for (SectionValidation s : sections) out.addAll(s.diagnostics());
        return out;
    }

    /** Skill names in stable alphabetical order (catalog DTO contract). */
    public static List<String> skillNames(Set<SkillType> skills) {
        return skills.stream().map(Enum::name).sorted().toList();
    }

    private static Set<SkillType> immutableSkills(Set<SkillType> skills) {
        if (skills == null || skills.isEmpty()) return Set.of();
        return Collections.unmodifiableSet(EnumSet.copyOf(skills));
    }
}
