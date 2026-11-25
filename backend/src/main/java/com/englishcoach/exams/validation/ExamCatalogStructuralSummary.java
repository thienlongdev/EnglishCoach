package com.englishcoach.exams.validation;

import com.englishcoach.exams.practice.ExamPracticeReadiness;
import java.util.List;
import java.util.UUID;

/** Compact shared catalog truth. No diagnostic trees, questions, keys, rights or learner facts. */
public record ExamCatalogStructuralSummary(UUID formId, String inputRevision, String contentFingerprint,
        String validatorVersion, String readinessVersion, List<String> practiceSkills, List<String> simulationSkills,
        boolean fullSimulationEligible, boolean contentReviewRequired, List<String> availableModes,
        String validationStatus, List<String> practiceScopeCodes) {
    public ExamCatalogStructuralSummary {
        practiceSkills = List.copyOf(practiceSkills);
        simulationSkills = List.copyOf(simulationSkills);
        availableModes = List.copyOf(availableModes);
        practiceScopeCodes = List.copyOf(practiceScopeCodes);
    }

    static ExamCatalogStructuralSummary from(String revision, ExamFormValidationReport report,
            List<ExamPracticeReadiness.ScopeReadiness> scopes) {
        return new ExamCatalogStructuralSummary(report.formId(), revision, report.contentFingerprint(),
                report.validatorVersion(), readinessKey(),
                ExamFormValidationReport.skillNames(report.practiceSkills()),
                ExamFormValidationReport.skillNames(report.simulationSkills()), report.fullSimulationEligible(),
                report.contentReviewRequired(), report.availableModes(), report.status().name(),
                scopes.stream().filter(ExamPracticeReadiness.ScopeReadiness::ready)
                        .map(s -> s.scope().scopeCode()).toList());
    }

    boolean matches(UUID id, String revision) {
        return id.equals(formId) && revision.equals(inputRevision) && contentFingerprint != null
                && ExamFormValidator.VALIDATOR_VERSION.equals(validatorVersion)
                && readinessKey().equals(readinessVersion)
                && java.util.Set.of("VALID", "NEEDS_REVIEW", "INVALID").contains(validationStatus)
                && (!fullSimulationEligible || "VALID".equals(validationStatus))
                && practiceScopeCodes.size() <= 16;
    }

    private static final String READINESS_KEY = buildReadinessKey();
    private static String readinessKey() { return READINESS_KEY; }
    private static String buildReadinessKey() {
        var caps = com.englishcoach.exams.release.ExamRunnerCapabilities.CURRENT;
        String canonical = new java.util.TreeMap<>(caps.interactions()) + "|" + new java.util.TreeMap<>(caps.features())
                + "|" + new java.util.TreeSet<>(caps.manifestContract()) + "|" + new java.util.TreeSet<>(caps.scoringContract())
                + "|" + new java.util.TreeSet<>(caps.objectiveScorerInteractions());
        try {
            return ExamPracticeReadiness.READINESS_VERSION + ":" + java.util.HexFormat.of().formatHex(
                    java.security.MessageDigest.getInstance("SHA-256").digest(canonical.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }
}
