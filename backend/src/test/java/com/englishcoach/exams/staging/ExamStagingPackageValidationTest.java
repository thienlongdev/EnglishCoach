package com.englishcoach.exams.staging;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.content.ExamPackageSourceProvenance;
import com.englishcoach.exams.content.ExamProjectUsageAuthorization;
import com.englishcoach.exams.validation.ExamContentTree;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.englishcoach.exams.validation.ExamFormValidator;
import com.englishcoach.exams.validation.ExamValidationDiagnostic;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Exams Recovery Phase 3 — runs EVERY staged extractor package (imports/exams/staging/extracted/**) through the
 * unchanged Phase 2 gate: Jackson deserialisation into the canonical {@link ExamContentPackage} records (unknown
 * properties fail), {@link ExamContentPackageValidator} (closure, ids, hash, provenance, rights) and
 * {@link ExamFormValidator} on {@link ExamContentTree#fromPackage} (structure, keys, media, blueprints).
 *
 * <p>Phase 3.6: the publisher-licence rights codes stay reported exactly as the closure validator emits them
 * ({@code importable} = production importer semantics, unchanged); the LOCAL staging rights decision of
 * {@link ExamProjectUsageAuthorization#stagingRightsGate} is reported next to them
 * ({@code stagingImportPreparationEligible}). A malformed project authorization is a contract violation.
 *
 * <p>Writes imports/exams/staging/reports/phase2_validation.json (codes, counts and eligibility only — no exam
 * text). The validators are not modified or relaxed here; this test only fails when the extractor emits a
 * package that is not canonical (hash mismatch, unknown field, broken closure). Rights errors are expected (the
 * raw corpus licence is an open owner decision) and are reported separately.
 * Skips when no staged packages exist (the corpus and staging area are local, untracked data).
 */
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamStagingPackageValidationTest {

    private static final Path STAGING = Path.of("..", "imports", "exams", "staging");
    private static final Instant NOW = Instant.parse("2026-10-03T12:00:00Z");
    /** Owner decision (EXAM-AUD-009): reported, never "fixed" by the extractor. */
    static final Set<String> RIGHTS_CODES = Set.of("RIGHTS_CATEGORY_FORBIDDEN", "RIGHTS_NOT_APPROVED",
            "RIGHTS_SCOPE_INCOMPLETE", "RIGHTS_PURPOSE_REQUIRED", "RIGHTS_NOT_YET_VALID", "RIGHTS_EXPIRED");
    /** Content incompleteness the Phase 2 validator also reports (e.g. a source without an answer key). */
    static final Set<String> CONTENT_CODES = Set.of("MISSING_ANSWER", "ANSWER_REQUIRED");

    @Test
    @DisplayName("Phase 3: every staged extractor package is canonical and is judged by the Phase 2 gate")
    void validateStagedPackages() throws Exception {
        Path extracted = STAGING.resolve("extracted");
        assumeTrue(Files.isDirectory(extracted), "no staged packages (run scripts/extract_exam_packages.py first)");
        List<Path> files;
        try (Stream<Path> s = Files.walk(extracted)) {
            files = s.filter(p -> p.toString().endsWith(".json")).sorted().toList();
        }
        assumeTrue(!files.isEmpty(), "staging area is empty");

        ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();
        ExamContentPackageValidator closure = new ExamContentPackageValidator(mapper);
        List<Map<String, Object>> results = new ArrayList<>();
        List<String> contractViolations = new ArrayList<>();

        for (Path file : files) {
            String rel = STAGING.relativize(file).toString().replace('\\', '/');
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("file", rel);
            ExamContentPackage pkg;
            try {
                pkg = mapper.readValue(file.toFile(), ExamContentPackage.class);
            } catch (Exception e) {
                contractViolations.add(rel + ": not a canonical ExamContentPackage (" + e.getClass().getSimpleName() + ")");
                row.put("deserialization", "FAILED");
                results.add(row);
                continue;
            }
            row.put("packageId", pkg.manifest().packageId());
            ExamContentPackage.ValidationResult vr = closure.validate(pkg, NOW);
            boolean hashOk = pkg.manifest().contentHash() != null
                    && pkg.manifest().contentHash().equalsIgnoreCase(vr.computedContentHash());
            row.put("contentHashMatches", hashOk);
            List<Map<String, String>> structural = new ArrayList<>();
            Set<String> rights = new TreeSet<>();
            Set<String> content = new TreeSet<>();
            for (ExamContentPackage.ValidationError err : vr.errors()) {
                if (RIGHTS_CODES.contains(err.code())) rights.add(err.code());
                else if (CONTENT_CODES.contains(err.code())) content.add(err.code());
                else structural.add(Map.of("path", err.path(), "code", err.code()));
            }
            row.put("closureStructuralErrors", structural);
            row.put("closureRightsErrors", rights);
            row.put("closureContentErrors", content);
            row.put("importable", vr.valid());
            List<String> closureCodes = vr.errors().stream().map(ExamContentPackage.ValidationError::code).toList();
            ExamProjectUsageAuthorization.StagingRightsDecision gate =
                    ExamProjectUsageAuthorization.stagingRightsGate(pkg, closureCodes);
            Map<String, Object> rightsRow = new LinkedHashMap<>();
            rightsRow.put("publisherRightsCodes", gate.publisherRightsCodes());
            rightsRow.put("ownerAuthorized", gate.ownerAuthorized());
            rightsRow.put("sourceBoundToRawCorpus", gate.sourceBoundToRawCorpus());
            rightsRow.put("stagingRightsCleared", gate.cleared());
            rightsRow.put("unclearedRightsCodes", gate.unclearedRightsCodes());
            rightsRow.put("reason", gate.reason());
            row.put("stagingRights", rightsRow);
            boolean nonRightsClosureClean = structural.isEmpty() && content.isEmpty() && hashOk;
            row.put("stagingImportPreparationEligible", nonRightsClosureClean && gate.cleared());
            List<ExamContentPackage.ValidationError> authErrors = ExamProjectUsageAuthorization.validate(pkg.manifest());
            if (!authErrors.isEmpty()) contractViolations.add(rel + ": projectUsageAuthorization " + authErrors);
            // truthfulness: owner authorization never rewrites the publisher licence of third-party material
            if (gate.ownerAuthorized()) {
                for (var src : pkg.sources()) {
                    if (!"THIRD_PARTY_PUBLICATION".equals(src.sourceType())) continue;
                    pkg.licenses().stream().filter(l -> l.sourceId().equals(src.id())).forEach(l -> {
                        if (l.provenanceCategory() != com.englishcoach.exams.model.ExamTypes.ProvenanceCategory.UNKNOWN
                                || !"PENDING".equals(l.legalStatus())) {
                            contractViolations.add(rel + ": publisher licence of " + src.code() + " was rewritten");
                        }
                    });
                }
            }
            row.put("sourceProvenancePresent", ExamPackageSourceProvenance.fromManifest(pkg.manifest()).isPresent());
            if (!hashOk) contractViolations.add(rel + ": CONTENT_HASH_MISMATCH");
            if (!structural.isEmpty()) contractViolations.add(rel + ": closure errors " + structural);
            if (ExamPackageSourceProvenance.fromManifest(pkg.manifest()).isEmpty()) {
                contractViolations.add(rel + ": sourceProvenance missing");
            }

            ExamFormValidationReport report = ExamFormValidator.validate(ExamContentTree.fromPackage(pkg, mapper), mapper, NOW);
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("validatorVersion", report.validatorVersion());
            v.put("status", report.status().name());
            v.put("fullSimulationEligible", report.fullSimulationEligible());
            v.put("blueprintId", report.blueprintId());
            v.put("expectedSkills", ExamFormValidationReport.skillNames(report.expectedSkills()));
            v.put("practiceSkills", ExamFormValidationReport.skillNames(report.practiceSkills()));
            v.put("simulationSkills", ExamFormValidationReport.skillNames(report.simulationSkills()));
            v.put("officialEvidenceSkillsIfPublished", ExamFormValidationReport.skillNames(report.officialEvidenceSkills()));
            v.put("availableModes", report.availableModes());
            v.put("blockingCodes", report.blockingCodes());
            List<Map<String, Object>> sections = new ArrayList<>();
            for (ExamFormValidationReport.SectionValidation s : report.sections()) {
                Map<String, Object> sm = new LinkedHashMap<>();
                sm.put("skill", s.skill().name());
                sm.put("status", s.status().name());
                sm.put("items", s.itemCount());
                sm.put("diagnostics", s.diagnostics().stream().map(ExamStagingPackageValidationTest::diag).toList());
                sections.add(sm);
            }
            v.put("sections", sections);
            v.put("formDiagnostics", report.formDiagnostics().stream().map(ExamStagingPackageValidationTest::diag).toList());
            v.put("contentFingerprint", report.contentFingerprint());
            row.put("phase2", v);
            results.add(row);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("generatedBy", "ExamStagingPackageValidationTest (Exams Recovery Phase 3)");
        out.put("validatorVersion", ExamFormValidator.VALIDATOR_VERSION);
        out.put("evaluatedAt", NOW.toString());
        out.put("packages", results.size());
        out.put("contractViolations", contractViolations);
        out.put("results", results);
        Path reportFile = STAGING.resolve("reports").resolve("phase2_validation.json");
        Files.createDirectories(reportFile.getParent());
        mapper.copy().enable(SerializationFeature.INDENT_OUTPUT).writeValue(reportFile.toFile(), out);

        assertTrue(contractViolations.isEmpty(), "extractor output violates the canonical package contract: " + contractViolations);
    }

    private static Map<String, Object> diag(ExamValidationDiagnostic d) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", d.qualifiedCode());
        m.put("severity", d.severity().name());
        if (d.partCode() != null) m.put("part", d.partCode());
        if (d.occurrences() != 1) m.put("occurrences", d.occurrences());
        if (d.detail() != null) m.put("detail", d.detail());
        return m;
    }
}
