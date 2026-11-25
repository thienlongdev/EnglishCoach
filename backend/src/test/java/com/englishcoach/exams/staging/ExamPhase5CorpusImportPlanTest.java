package com.englishcoach.exams.staging;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamPackageIdentity;
import com.englishcoach.exams.release.*;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.junit.jupiter.api.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Exams Recovery Phase 5 — for every staged package (LOCAL data; skips without it): deterministic package identity,
 * gate-driven LOCAL and PRODUCTION import plans (no database: "what would happen on an empty target"), and the
 * corpus-wide media import manifest. Writes imports/exams/staging/reports/phase5_import_plan.json and
 * media_import_manifest.json (ids, hashes, codes — no exam text). Reads the Phase 5G legacy mapping when present.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamPhase5CorpusImportPlanTest {

    private static final Path REPO = Path.of("..");
    private static final Path STAGING = REPO.resolve("imports").resolve("exams").resolve("staging");
    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    private static final Map<String, ExamContentPackage> PACKAGES = new TreeMap<>();
    private static final List<ExamImportPlanner.ReplacementMapping> MAPPINGS = new ArrayList<>();

    @BeforeAll
    static void load() throws Exception {
        ExamPhase4ReleaseReadinessTest.load();
        Path extracted = STAGING.resolve("extracted");
        try (Stream<Path> s = Files.walk(extracted)) {
            for (Path p : s.filter(f -> f.toString().endsWith(".json")).sorted().toList()) {
                String fam = p.toString().replace('\\', '/').contains("/toeic/") ? "toeic" : "ielts";
                String[] bt = p.getFileName().toString().replace(".json", "").split("__");
                PACKAGES.put(fam + "/" + bt[0] + "/" + bt[1], MAPPER.readValue(p.toFile(), ExamContentPackage.class));
            }
        }
        Path mapping = STAGING.resolve("reports").resolve("legacy_replacement_mapping.json");
        if (Files.isRegularFile(mapping)) {
            for (JsonNode m : MAPPER.readTree(mapping.toFile()).path("mappings")) {
                if (m.path("canonical").isObject()) {
                    MAPPINGS.add(new ExamImportPlanner.ReplacementMapping(m.path("legacyLogicalKey").asText(),
                            m.path("legacyPackageId").asText(), m.path("canonical").path("sourceKey").asText(),
                            m.path("status").asText()));
                }
            }
        }
    }

    static Map<String, String> cropDecisions(String testId) {
        Map<String, String> out = new HashMap<>();
        ExamPhase4ReleaseReadinessTest.qaReviewNode().path("packages").path(testId).path("cropUnits").fields()
                .forEachRemaining(e -> {
                    String st = e.getValue().path("status").asText("OPEN");
                    out.put(e.getValue().path("cropSha256").asText().toLowerCase(Locale.ROOT),
                            "OPEN".equals(st) ? "PENDING" : st);
                });
        return out;
    }

    @Test
    @Order(1)
    @DisplayName("Phase 5: identity + gate-driven import plans for every staged package; media manifest")
    void corpusImportPlan() throws Exception {
        List<Map<String, Object>> rows = new ArrayList<>();
        List<ExamMediaImportManifest.PackageMedia> media = new ArrayList<>();
        Set<String> sourceKeys = new HashSet<>();
        Map<String, Integer> ops = new TreeMap<>(), contentOps = new TreeMap<>();
        for (Map.Entry<String, ExamContentPackage> e : PACKAGES.entrySet()) {
            ExamContentPackage pkg = e.getValue();
            ExamPackageIdentity id = ExamPackageIdentity.of(pkg);
            assertTrue(sourceKeys.add(id.sourceKey()), "source identity is unique per package: " + id.sourceKey());
            assertTrue(id.pathViolations().isEmpty(), e.getKey() + " local paths " + id.pathViolations());
            assertEquals(id, ExamPackageIdentity.of(pkg), "identity is deterministic");
            ExamFormValidationReport structural = ExamPhase4ReleaseReadinessTest.structural(pkg);
            ExamRuntimeCompatibility.Report compat = ExamRuntimeCompatibility.audit(pkg);
            ExamMediaImportPlan.Plan plan = ExamMediaImportPlan.plan(pkg, REPO, true, ExamPhase4ReleaseReadinessTest.cropQa(e.getKey()));
            ExamReleaseReadinessGate.Decision gate = ExamReleaseReadinessGate.evaluate(pkg, structural,
                    ExamPhase4ReleaseReadinessTest.closureCodes(pkg), compat, ExamPhase4ReleaseReadinessTest.qa(e.getKey()), plan);
            ExamImportPlanner.Plan local = ExamImportPlanner.plan(pkg, structural, gate, plan, MAPPINGS,
                    ExamImportPlanner.StateReader.EMPTY, ExamImportPlanner.Target.LOCAL_DRY_RUN);
            ExamImportPlanner.Plan prod = ExamImportPlanner.plan(pkg, structural, gate, plan, MAPPINGS,
                    ExamImportPlanner.StateReader.EMPTY, ExamImportPlanner.Target.PRODUCTION);
            assertEquals(local.planId(), ExamImportPlanner.plan(pkg, structural, gate, plan, MAPPINGS,
                    ExamImportPlanner.StateReader.EMPTY, ExamImportPlanner.Target.LOCAL_DRY_RUN).planId(), "deterministic plan");
            assertEquals(ExamImportPlanner.Operation.BLOCKED, prod.operation(), "production import is never planned in Phase 5");
            if (!gate.importReady()) {
                assertEquals(ExamImportPlanner.Operation.BLOCKED, local.operation(), e.getKey() + ": no gate bypass");
                assertTrue(local.blockers().contains("RELEASE_GATE_NOT_IMPORT_READY"));
            }
            ops.merge(local.operation().name(), 1, Integer::sum);
            contentOps.merge(local.contentOperation().name(), 1, Integer::sum);
            media.add(new ExamMediaImportManifest.PackageMedia(pkg, plan, cropDecisions(e.getKey())));

            Map<String, Object> idMap = new LinkedHashMap<>();
            idMap.put("identityVersion", id.identityVersion());
            idMap.put("sourceKey", id.sourceKey());
            idMap.put("sourceIdentity", id.sourceIdentity());
            idMap.put("rawSourceSha256", id.rawSourceSha256());
            idMap.put("rawDocumentSha256", id.rawDocumentSha256());
            idMap.put("extractorName", id.extractorName());
            idMap.put("extractorVersion", id.extractorVersion());
            idMap.put("packageId", id.packageId());
            idMap.put("packageVersion", id.packageVersion());
            idMap.put("formLogicalKey", id.formLogicalKey());
            idMap.put("formVersion", id.formVersion());
            idMap.put("manifestContentHash", id.manifestContentHash());
            idMap.put("semanticFingerprint", id.semanticFingerprint());
            idMap.put("displayDigest", id.displayDigest());
            idMap.put("mediaStateDigest", id.mediaStateDigest());
            idMap.put("definitionsDigest", id.definitionsDigest());
            idMap.put("mediaSha256", id.mediaSha256());
            idMap.put("groupPlacements", id.placements().size());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("testId", e.getKey());
            row.put("identity", idMap);
            row.put("gate", gate.asMap());
            row.put("phase2ContentFingerprint", structural.contentFingerprint());
            row.put("localPlan", local.asMap());
            row.put("productionPlan", Map.of("operation", prod.operation().name(), "blockers", prod.blockers()));
            rows.add(row);
        }
        Map<String, Object> manifest = ExamMediaImportManifest.build(media);
        assertTrue(((List<?>) manifest.get("violations")).isEmpty(), "no URL / localhost / machine path in canonical media keys");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("generatedBy", "ExamPhase5CorpusImportPlanTest (Exams Recovery Phase 5, LOCAL; no database, no import)");
        out.put("planVersion", ExamImportPlanner.PLAN_VERSION);
        out.put("identityVersion", ExamPackageIdentity.IDENTITY_VERSION);
        out.put("targetState", "EMPTY (what would happen on a target without these imports)");
        out.put("packages", rows.size());
        out.put("localOperations", ops);
        out.put("contentOperations", contentOps);
        out.put("replacementMappingsLoaded", MAPPINGS.size());
        out.put("results", rows);
        MAPPER.copy().enable(SerializationFeature.INDENT_OUTPUT)
                .writeValue(STAGING.resolve("reports").resolve("phase5_import_plan.json").toFile(), out);
        MAPPER.copy().enable(SerializationFeature.INDENT_OUTPUT)
                .writeValue(STAGING.resolve("reports").resolve("media_import_manifest.json").toFile(), manifest);
    }
}
