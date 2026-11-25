package com.englishcoach.exams.staging;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.content.ExamProjectUsageAuthorization;
import com.englishcoach.exams.practice.ExamPracticeReadiness;
import com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness;
import com.englishcoach.exams.release.ExamRunnerCapabilities;
import com.englishcoach.exams.release.ExamScopedQaReadiness;
import com.englishcoach.exams.validation.ExamContentTree;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.englishcoach.exams.validation.ExamFormValidator;
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
 * Exams Phase 6 — practice scope readiness of EVERY staged package (Docker-free): canonical package →
 * {@link ExamContentTree#fromPackage} → unchanged Phase 2 validator → {@link ExamPracticeReadiness}. Form facts follow the
 * LOCAL owner-authorized basis: attemptable (the local dry-run imports set PILOT) and rights = the staging rights gate
 * ({@link ExamProjectUsageAuthorization#stagingRightsGate}). Nothing is imported, approved or written to the corpus.
 * Writes imports/exams/staging/reports/phase6_practice_scope_matrix.json (codes, counts, availability — no exam text).
 * Skips when no staged packages exist.
 */
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamPhase6PracticeScopeMatrixTest {

    private static final Path STAGING = Path.of("..", "imports", "exams", "staging");
    private static final Instant NOW = Instant.parse("2026-10-04T12:00:00Z");

    @Test
    @DisplayName("Phase 6: scope readiness of every staged package (fail closed; never an approval, never IMPORT_READY)")
    void scopeMatrix() throws Exception {
        Path extracted = STAGING.resolve("extracted");
        assumeTrue(Files.isDirectory(extracted), "no staged packages");
        List<Path> files;
        try (Stream<Path> s = Files.walk(extracted)) {
            files = s.filter(p -> p.toString().endsWith(".json")).sorted().toList();
        }
        assumeTrue(!files.isEmpty(), "staging area is empty");
        ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();
        ExamContentPackageValidator closure = new ExamContentPackageValidator(mapper);
        Map<String, List<Map<String, Object>>> openQa = openHumanQa(mapper);

        List<Map<String, Object>> rows = new ArrayList<>();
        Map<String, Map<String, Integer>> byType = new TreeMap<>();
        Map<String, Integer> totals = new TreeMap<>();
        for (Path file : files) {
            ExamContentPackage pkg = mapper.readValue(file.toFile(), ExamContentPackage.class);
            List<String> closureCodes = closure.validate(pkg, NOW).errors().stream().map(ExamContentPackage.ValidationError::code).toList();
            boolean rights = ExamProjectUsageAuthorization.stagingRightsGate(pkg, closureCodes).cleared();
            ExamContentTree tree = ExamContentTree.fromPackage(pkg, mapper);
            ExamFormValidationReport report = ExamFormValidator.validate(tree, mapper, NOW);
            List<ScopeReadiness> scopes = ExamPracticeReadiness.evaluate(tree, report, ExamRunnerCapabilities.CURRENT,
                    new ExamPracticeReadiness.FormFacts(true, rights), mapper);
            var scopeQa = ExamScopedQaReadiness.evaluate(pkg, tree, scopes, openQa.containsKey(pkg.manifest().packageId()),
                    openQa.getOrDefault(pkg.manifest().packageId(), List.of()), mapper);

            Map<String, Object> row = new LinkedHashMap<>();
            row.put("file", STAGING.relativize(file).toString().replace('\\', '/'));
            row.put("openHumanQaNotMappedToAScope", scopeQa.unresolvedEntryIds().size());
            row.put("unreferencedCurrentCropEntryIds", scopeQa.unreferencedCropEntryIds());
            row.put("phase2Status", report.status().name());
            row.put("stagingRightsCleared", rights);
            List<Map<String, Object>> sc = new ArrayList<>();
            for (ScopeReadiness r : scopes) {
                Map<String, Object> s = new LinkedHashMap<>();
                s.put("scopeCode", r.scope().scopeCode());
                s.put("questions", r.scope().itemCount());
                s.put("groups", r.scope().groupIds().size());
                s.put("ready", r.ready());
                s.put("availability", r.learnerState().name());
                s.put("reasonCodes", r.reasonCodes());
                // informational: the local dry-run DB may hold forms whose human QA is still open; production exposure
                // stays behind the import gate (IMPORT_READY needs QA_APPROVED), runtime readiness never sees this ledger
                var qa = scopeQa.scopes().get(r.scope().scopeCode());
                s.put("openHumanQa", qa.entryIds());
                s.put("qaReady", qa.ready());
                s.put("qaReasonCodes", qa.reasonCodes());
                s.put("practiceReleaseCandidate", r.ready() && qa.ready());
                sc.add(s);
                // a ready scope is always complete: keys present, media validated, supported interactions
                if (r.ready()) {
                    assertFalse(r.reasonCodes().contains("ANSWER_KEY_MISSING"));
                    assertTrue(r.scope().itemCount() > 0);
                }
                byType.computeIfAbsent(r.scope().scopeType().name(), k -> new TreeMap<>()).merge(r.learnerState().name(), 1, Integer::sum);
                totals.merge(r.learnerState().name(), 1, Integer::sum);
            }
            row.put("scopes", sc);
            rows.add(row);
        }
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("generatedBy", "ExamPhase6PracticeScopeMatrixTest (Exams Recovery Phase 6, Docker-free)");
        report.put("readinessVersion", ExamPracticeReadiness.READINESS_VERSION);
        report.put("packages", rows.size());
        report.put("scopeTotals", totals);
        report.put("byScopeType", byType);
        report.put("results", rows);
        mapper.copy().enable(SerializationFeature.INDENT_OUTPUT)
                .writeValue(STAGING.resolve("reports").resolve("phase6_practice_scope_matrix.json").toFile(), report);
        assertEquals(files.size(), rows.size());
    }

    /** Open human-QA entries per package id (release priority + subtype + questions + scope), from qa_release_review.json. */
    @SuppressWarnings("unchecked")
    static Map<String, List<Map<String, Object>>> openHumanQa(ObjectMapper mapper) throws Exception {
        Path f = STAGING.resolve("reports").resolve("qa_release_review.json");
        Map<String, List<Map<String, Object>>> out = new HashMap<>();
        if (!Files.isRegularFile(f)) return out;
        Map<String, Object> root = mapper.readValue(f.toFile(), Map.class);
        for (Object p : ((Map<String, Object>) root.getOrDefault("packages", Map.of())).values()) {
            Map<String, Object> pkg = (Map<String, Object>) p;
            out.putIfAbsent(String.valueOf(pkg.get("packageId")), new ArrayList<>());
            for (Object eo : (List<Object>) pkg.getOrDefault("entries", List.of())) {
                Map<String, Object> e = (Map<String, Object>) eo;
                out.get(String.valueOf(pkg.get("packageId"))).add(e);
            }
        }
        return out;
    }

    /** SKILL:questionNumber → scope code, from the printed question numbers of each scope's items. */
    static Map<String, String> scopeOfQuestion(ExamContentTree tree, List<ScopeReadiness> scopes, ObjectMapper mapper) {
        Map<String, String> out = new HashMap<>();
        for (ScopeReadiness r : scopes) {
            for (ExamContentTree.SectionNode s : tree.sections()) {
                if (!s.id().equals(r.scope().sectionId())) continue;
                for (ExamContentTree.PartNode p : s.parts()) {
                    if (!p.id().equals(r.scope().partId())) continue;
                    for (ExamContentTree.GroupNode g : p.groups()) for (ExamContentTree.ItemNode i : g.items()) {
                        try {
                            Map<?, ?> defs = i.optionDefinitionsJson() == null ? Map.of() : mapper.readValue(i.optionDefinitionsJson(), Map.class);
                            if (defs.get("questionNumber") instanceof Number n) out.put(s.skill().name() + ":" + n.intValue(), r.scope().scopeCode());
                        } catch (Exception ignored) {
                            // unparsable definitions map to no scope
                        }
                    }
                }
            }
        }
        return out;
    }

    /** Candidate SKILL:number keys of a QA entry (skill from its scope when stated; TOEIC numbers are unique per form). */
    static List<String> questionKeys(Map<String, Object> e) {
        List<Integer> numbers = new ArrayList<>();
        Object q = e.get("questions");
        if (q instanceof Number n) numbers.add(n.intValue());
        else if (q != null) {
            String[] ab = String.valueOf(q).split("-");
            try {
                int a = Integer.parseInt(ab[0].trim()), b = ab.length > 1 ? Integer.parseInt(ab[1].trim()) : a;
                for (int k = a; k <= b && k - a < 60; k++) numbers.add(k);
            } catch (NumberFormatException ignored) {
                // not a printed question range
            }
        }
        String scope = String.valueOf(e.get("scope"));
        List<String> skills = scope.contains("LISTENING") ? List.of("LISTENING") : scope.contains("READING") ? List.of("READING")
                : scope.contains("WRITING") ? List.of("WRITING") : List.of("LISTENING", "READING");
        List<String> out = new ArrayList<>();
        for (int n : numbers) for (String sk : skills) out.add(sk + ":" + n);
        return out;
    }
}
