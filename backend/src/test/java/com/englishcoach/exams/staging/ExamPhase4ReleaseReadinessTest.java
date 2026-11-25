package com.englishcoach.exams.staging;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.release.ExamMediaImportPlan;
import com.englishcoach.exams.release.ExamReleaseReadinessGate;
import com.englishcoach.exams.release.ExamRunnerCapabilities;
import com.englishcoach.exams.release.ExamRuntimeCompatibility;
import com.englishcoach.exams.validation.ExamContentTree;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.englishcoach.exams.validation.ExamFormValidator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Exams Recovery Phase 4 — release readiness of every staged package (LOCAL data; skips without it): Phase 2 structure
 * (unchanged validator) + runner / scoring compatibility + QA release review + media plan (bytes re-hashed) + owner
 * project authorization + provenance ⇒ IMPORT_READY. Writes imports/exams/staging/reports/phase4_release_readiness.json
 * (codes, counts, booleans — no exam text). Also proves the gate fails closed on a degraded runtime / scorer and on
 * malformed choose-TWO / visual / multi-document contracts.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamPhase4ReleaseReadinessTest {

    private static final Path REPO = Path.of("..");
    private static final Path STAGING = REPO.resolve("imports").resolve("exams").resolve("staging");
    private static final Instant NOW = Instant.parse("2026-10-03T12:00:00Z");
    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    private static final Map<String, ExamContentPackage> PACKAGES = new TreeMap<>();
    private static final Map<String, Path> FILES = new TreeMap<>();
    private static JsonNode qaReview;

    static final String CAM17_T1 = "ielts/cambridge-ielts-17/test-1";
    static final String CAM21_T3 = "ielts/cambridge-ielts-21/test-3";
    static final String ETS_T1 = "toeic/ets-2026/test-1";
    static final String ETS_T2 = "toeic/ets-2026/test-2";

    @BeforeAll
    static void load() throws Exception {
        Path extracted = STAGING.resolve("extracted");
        assumeTrue(Files.isDirectory(extracted), "no staged packages (local data)");
        try (Stream<Path> s = Files.walk(extracted)) {
            for (Path p : s.filter(f -> f.toString().endsWith(".json")).sorted().toList()) {
                String fam = p.toString().replace('\\', '/').contains("/toeic/") ? "toeic" : "ielts";
                String[] bt = p.getFileName().toString().replace(".json", "").split("__");
                String id = fam + "/" + bt[0] + "/" + bt[1];
                PACKAGES.put(id, MAPPER.readValue(p.toFile(), ExamContentPackage.class));
                FILES.put(id, p);
            }
        }
        Path qa = STAGING.resolve("reports").resolve("qa_release_review.json");
        assumeTrue(Files.isRegularFile(qa), "run: python scripts/extract_exam_packages.py qa-review");
        qaReview = MAPPER.readTree(qa.toFile());
    }

    /** Phase 5: the loaded QA release review (shared with ExamPhase5CorpusImportPlanTest). */
    static JsonNode qaReviewNode() {
        return qaReview;
    }

    static ExamReleaseReadinessGate.QaStatus qa(String testId) {
        JsonNode p = qaReview.path("packages").path(testId);
        if (p.isMissingNode()) return new ExamReleaseReadinessGate.QaStatus(false, Map.of(), Set.of(), Set.of());
        Map<String, Integer> open = new TreeMap<>();
        p.path("openByReleasePriority").fields().forEachRemaining(e -> open.put(e.getKey(), e.getValue().asInt()));
        Set<String> openSubtypes = new TreeSet<>();
        Set<String> openStatuses = new TreeSet<>();
        Set<String> all = new TreeSet<>();
        Set<String> blocking = Set.of("OPEN", "REJECTED", "STALE_DECISION", "CORRECTION_PENDING");
        for (JsonNode e : p.path("entries")) {
            all.add(e.path("subtype").asText());
            if (blocking.contains(e.path("status").asText())
                    && ExamReleaseReadinessGate.QaStatus.BLOCKING.contains(e.path("releasePriority").asText())) {
                openSubtypes.add(e.path("subtype").asText());
                openStatuses.add(e.path("status").asText());
            }
        }
        return new ExamReleaseReadinessGate.QaStatus(!p.path("package").isNull(), open, openSubtypes, all, openStatuses);
    }

    /** Phase 4.1B: crop SHA-256 → technical status + fingerprint-current human approval (qa_release_review cropUnits). */
    static Map<String, ExamMediaImportPlan.CropQa> cropQa(String testId) {
        Map<String, ExamMediaImportPlan.CropQa> out = new HashMap<>();
        qaReview.path("packages").path(testId).path("cropUnits").fields().forEachRemaining(e -> out.put(
                e.getValue().path("cropSha256").asText().toLowerCase(Locale.ROOT),
                new ExamMediaImportPlan.CropQa(e.getValue().path("technical").asText(), e.getValue().path("humanApproved").asBoolean())));
        return out;
    }

    static ExamFormValidationReport structural(ExamContentPackage pkg) {
        return ExamFormValidator.validate(ExamContentTree.fromPackage(pkg, MAPPER), MAPPER, NOW);
    }

    static List<String> closureCodes(ExamContentPackage pkg) {
        return new ExamContentPackageValidator(MAPPER).validate(pkg, NOW).errors().stream()
                .map(ExamContentPackage.ValidationError::code).toList();
    }

    static ExamReleaseReadinessGate.Decision decide(String id, ExamContentPackage pkg, ExamRunnerCapabilities.Capabilities caps,
                                                    ExamMediaImportPlan.Plan media) {
        return ExamReleaseReadinessGate.evaluate(pkg, structural(pkg), closureCodes(pkg),
                ExamRuntimeCompatibility.audit(pkg, caps), qa(id), media);
    }

    @Test
    @Order(1)
    @DisplayName("every staged package: release readiness report (Phase 4 gate) is written; candidates are runtime + scoring compatible")
    void releaseReadinessReport() throws Exception {
        List<Map<String, Object>> rows = new ArrayList<>();
        Map<String, Integer> interactionTotals = new TreeMap<>();
        int importReady = 0;
        List<String> readyExceptHuman = new ArrayList<>();
        Map<String, Integer> dimensionTotals = new LinkedHashMap<>();
        for (Map.Entry<String, ExamContentPackage> e : PACKAGES.entrySet()) {
            ExamContentPackage pkg = e.getValue();
            ExamRuntimeCompatibility.Report compat = ExamRuntimeCompatibility.audit(pkg);
            ExamMediaImportPlan.Plan media = ExamMediaImportPlan.plan(pkg, REPO, true, cropQa(e.getKey()));
            ExamFormValidationReport structural = structural(pkg);
            ExamReleaseReadinessGate.Decision d = ExamReleaseReadinessGate.evaluate(pkg, structural, closureCodes(pkg), compat,
                    qa(e.getKey()), media);
            if (d.importReady()) importReady++;
            if (d.readyExceptHumanQa()) readyExceptHuman.add(e.getKey());
            d.asMap().forEach((k, v) -> { if (Boolean.TRUE.equals(v)) dimensionTotals.merge(k, 1, Integer::sum); });
            compat.interactions().forEach((k, v) -> interactionTotals.merge(k, v.items(), Integer::sum));
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("testId", e.getKey());
            row.put("packageId", pkg.manifest().packageId());
            row.put("packageVersion", pkg.manifest().packageVersion());
            row.put("contentHash", pkg.manifest().contentHash());
            row.put("phase2Status", structural.status().name());
            row.put("items", pkg.items().size());
            row.put("gate", d.asMap());
            row.put("runnerBlocking", compat.blockingCodes(ExamRuntimeCompatibility.Gate.RUNNER));
            row.put("scoringBlocking", compat.blockingCodes(ExamRuntimeCompatibility.Gate.SCORING));
            row.put("reviewCodes", compat.reviewCodes());
            row.put("requiredFeatures", compat.requiredFeatures());
            row.put("diagnostics", compat.diagnostics().stream().map(x -> Map.of("gate", x.gate().name(), "code", x.code(),
                    "severity", x.severity().name(), "occurrences", x.occurrences(),
                    "sample", String.valueOf(x.sampleRef()))).toList());
            row.put("interactions", compat.interactions());
            Map<String, Object> mediaRow = new LinkedHashMap<>();
            mediaRow.put("assets", media.entries().size());
            mediaRow.put("mediaReady", media.mediaReady());
            mediaRow.put("blockers", media.blockers());
            mediaRow.put("duplicateAssets", media.duplicateAssets());
            mediaRow.put("readyExceptHumanCropQa", media.readyExceptHumanCropQa());
            mediaRow.put("plan", media.entries().stream().map(x -> {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("assetId", x.assetId());
                m.put("sha256", x.sha256());
                m.put("mimeType", x.mimeType());
                m.put("roles", x.roles());
                m.put("stimulusKinds", x.stimulusKinds());
                m.put("validationState", x.validationState());
                m.put("sourceKind", x.sourceKind().name());
                m.put("derivation", x.derivation());
                m.put("storageObjectKey", x.storageObjectKey());
                m.put("dedupeKey", x.dedupeKey());
                m.put("fileStatus", x.fileStatus().name());
                m.put("ready", x.ready());
                m.put("bound", x.bound());
                m.put("cropTechnical", x.cropTechnical());
                m.put("cropHumanApproved", x.cropHumanApproved());
                return m;
            }).toList());
            row.put("media", mediaRow);
            rows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("generatedBy", "ExamPhase4ReleaseReadinessTest (Exams Recovery Phase 4 / 4.1)");
        out.put("evaluatedAt", NOW.toString());
        out.put("phase2ValidatorVersion", ExamFormValidator.VALIDATOR_VERSION);
        out.put("declaredRuntime", Map.of("interactions", ExamRunnerCapabilities.INTERACTIONS, "features", ExamRunnerCapabilities.FEATURES,
                "manifestContract", new TreeSet<>(ExamRunnerCapabilities.MANIFEST_CONTRACT),
                "scoringContract", new TreeSet<>(ExamRunnerCapabilities.SCORING_CONTRACT)));
        out.put("packages", rows.size());
        out.put("interactionTotals", interactionTotals);
        out.put("importReady", importReady);
        out.put("readyExceptHumanQa", readyExceptHuman);
        out.put("dimensionTotals", dimensionTotals);
        out.put("results", rows);
        MAPPER.copy().enable(SerializationFeature.INDENT_OUTPUT)
                .writeValue(STAGING.resolve("reports").resolve("phase4_release_readiness.json").toFile(), out);

        for (String id : List.of(CAM17_T1, CAM21_T3, ETS_T1, ETS_T2)) {
            ExamContentPackage pkg = PACKAGES.get(id);
            assertNotNull(pkg, id);
            ExamRuntimeCompatibility.Report c = ExamRuntimeCompatibility.audit(pkg);
            assertTrue(c.runnerCompatible(), id + " runner " + c.blockingCodes(ExamRuntimeCompatibility.Gate.RUNNER));
            assertTrue(c.scoringCompatible(), id + " scoring " + c.blockingCodes(ExamRuntimeCompatibility.Gate.SCORING));
            ExamReleaseReadinessGate.Decision d = decide(id, pkg, ExamRunnerCapabilities.CURRENT, ExamMediaImportPlan.plan(pkg, REPO, false));
            assertTrue(d.structuralValid(), id);
            assertTrue(d.projectAuthorized(), id + " " + d.reasons());
            assertTrue(d.provenanceComplete(), id + " " + d.reasons());
        }
    }

    @Test
    @Order(2)
    @DisplayName("ETS 2026 T1: 200 items, every item keyed, runner + scoring compatible")
    void ets2026Test1() {
        ExamContentPackage pkg = PACKAGES.get(ETS_T1);
        assumeTrue(pkg != null);
        assertEquals(200, pkg.items().size());
        Set<UUID> keyed = new HashSet<>();
        pkg.answerSpecs().forEach(s -> {
            if (!com.englishcoach.exams.scoring.ExamObjectiveScorer.nonBlankAccepted(s.acceptedAnswers()).isEmpty()) keyed.add(s.itemId());
        });
        assertEquals(200, keyed.size());
        ExamRuntimeCompatibility.Report c = ExamRuntimeCompatibility.audit(pkg);
        assertTrue(c.requiredFeatures().containsAll(Set.of("MULTI_DOC_SEGMENTED", "IMAGE_STIMULUS_GRANT", "PER_PART_AUDIO_PLAYLIST")),
                c.requiredFeatures().toString());
    }

    @Test
    @Order(3)
    @DisplayName("missing renderer / missing scorer ⇒ not import-ready (fail closed)")
    void degradedRuntimeFailsClosed() {
        ExamContentPackage pkg = PACKAGES.get(ETS_T1);
        assumeTrue(pkg != null);
        Map<String, ExamRunnerCapabilities.Support> features = new HashMap<>(ExamRunnerCapabilities.FEATURES);
        features.put("MULTI_DOC_SEGMENTED", ExamRunnerCapabilities.Support.UNSUPPORTED);
        var noRenderer = new ExamRunnerCapabilities.Capabilities(ExamRunnerCapabilities.INTERACTIONS, features,
                ExamRunnerCapabilities.MANIFEST_CONTRACT, ExamRunnerCapabilities.SCORING_CONTRACT,
                ExamRunnerCapabilities.OBJECTIVE_SCORER_INTERACTIONS);
        ExamRuntimeCompatibility.Report r1 = ExamRuntimeCompatibility.audit(pkg, noRenderer);
        assertFalse(r1.runnerCompatible());
        assertTrue(r1.blockingCodes(ExamRuntimeCompatibility.Gate.RUNNER).contains("RUNNER_MULTI_DOC_UNSUPPORTED"));
        assertFalse(decide(ETS_T1, pkg, noRenderer, ExamMediaImportPlan.plan(pkg, REPO, false)).importReady());

        Set<String> scorer = new HashSet<>(ExamRunnerCapabilities.OBJECTIVE_SCORER_INTERACTIONS);
        scorer.remove("SINGLE_CHOICE");
        var noScorer = new ExamRunnerCapabilities.Capabilities(ExamRunnerCapabilities.INTERACTIONS, ExamRunnerCapabilities.FEATURES,
                ExamRunnerCapabilities.MANIFEST_CONTRACT, ExamRunnerCapabilities.SCORING_CONTRACT, scorer);
        ExamRuntimeCompatibility.Report r2 = ExamRuntimeCompatibility.audit(pkg, noScorer);
        assertFalse(r2.scoringCompatible());
        assertTrue(r2.blockingCodes(ExamRuntimeCompatibility.Gate.SCORING).contains("SCORER_INTERACTION_UNSUPPORTED"));
        assertFalse(decide(ETS_T1, pkg, noScorer, ExamMediaImportPlan.plan(pkg, REPO, false)).importReady());

        var noSnapshot = new ExamRunnerCapabilities.Capabilities(ExamRunnerCapabilities.INTERACTIONS, ExamRunnerCapabilities.FEATURES,
                ExamRunnerCapabilities.MANIFEST_CONTRACT, Set.of("UNORDERED_SET_DEDUP", "WORD_LIMIT_ENFORCED"),
                ExamRunnerCapabilities.OBJECTIVE_SCORER_INTERACTIONS);
        assertTrue(ExamRuntimeCompatibility.audit(pkg, noSnapshot).blockingCodes(ExamRuntimeCompatibility.Gate.SCORING)
                .contains("SNAPSHOT_SCORING_UNSAFE"));
    }

    @Test
    @Order(4)
    @DisplayName("choose-TWO without set semantics, an image without an asset, a multi-document set without boundaries")
    void malformedContractsAreCaught() throws Exception {
        assumeTrue(FILES.containsKey(CAM17_T1) && FILES.containsKey(ETS_T1));
        // (a) Cambridge 17 T1: strip unorderedSet from one choose-TWO spec ⇒ MULTI_SELECT_CONTRACT_MISMATCH
        ObjectNode cam = (ObjectNode) MAPPER.readTree(FILES.get(CAM17_T1).toFile());
        Set<String> pairItems = new HashSet<>();
        for (JsonNode it : cam.path("items")) if (it.path("optionDefinitions").has("selection")) pairItems.add(it.path("id").asText());
        assertFalse(pairItems.isEmpty(), "Cambridge 17 T1 has choose-TWO pairs");
        for (JsonNode s : cam.path("answerSpecs")) {
            if (pairItems.contains(s.path("itemId").asText())) {
                ((ObjectNode) s.path("acceptedAnswers")).remove("unorderedSet");
                break;
            }
        }
        ExamRuntimeCompatibility.Report r = ExamRuntimeCompatibility.audit(MAPPER.treeToValue(cam, ExamContentPackage.class));
        assertTrue(r.blockingCodes(ExamRuntimeCompatibility.Gate.SCORING).contains("MULTI_SELECT_CONTRACT_MISMATCH"));

        // (b) ETS 2026 T1: positive — every image stimulus resolves; then remove image bindings ⇒ unresolved
        ExamContentPackage ets = PACKAGES.get(ETS_T1);
        assertTrue(ExamRuntimeCompatibility.audit(ets).blockingCodes(ExamRuntimeCompatibility.Gate.RUNNER).isEmpty());
        ObjectNode etsJson = (ObjectNode) MAPPER.readTree(FILES.get(ETS_T1).toFile());
        Set<String> imageAssets = new HashSet<>();
        for (JsonNode a : etsJson.path("assets")) if (a.path("mimeType").asText().startsWith("image/")) imageAssets.add(a.path("id").asText());
        ArrayNode kept = MAPPER.createArrayNode();
        for (JsonNode sa : etsJson.path("stimulusAssets")) if (!imageAssets.contains(sa.path("assetId").asText())) kept.add(sa);
        etsJson.set("stimulusAssets", kept);
        ExamRuntimeCompatibility.Report noImages = ExamRuntimeCompatibility.audit(MAPPER.treeToValue(etsJson, ExamContentPackage.class));
        assertTrue(noImages.blockingCodes(ExamRuntimeCompatibility.Gate.RUNNER).contains("RUNNER_IMAGE_REFERENCE_UNRESOLVED"));

        // (c) a multi-document set whose boundaries are not proven stays review-required (never auto-split)
        ObjectNode etsDocs = (ObjectNode) MAPPER.readTree(FILES.get(ETS_T1).toFile());
        for (JsonNode st : etsDocs.path("stimuli")) {
            if ("MULTI_DOC".equals(st.path("kind").asText())) {
                ((ObjectNode) st.path("bodyPayload")).put("documentBoundaries", "NOT_SEGMENTED");
            }
        }
        ExamRuntimeCompatibility.Report docs = ExamRuntimeCompatibility.audit(MAPPER.treeToValue(etsDocs, ExamContentPackage.class));
        assertTrue(docs.reviewCodes().contains("MULTI_DOC_BOUNDARY_NOT_SEGMENTED"));
        ExamReleaseReadinessGate.QaStatus clean = new ExamReleaseReadinessGate.QaStatus(true, Map.of(), Set.of(), Set.of());
        ExamReleaseReadinessGate.Decision d = ExamReleaseReadinessGate.evaluate(ets, structural(ets), closureCodes(ets), docs, clean,
                ExamMediaImportPlan.plan(ets, REPO, false));
        assertFalse(d.qaApproved(), "an unsegmented multi-document set needs a QA entry + human decision");
    }

    @Test
    @Order(5)
    @DisplayName("OWNER_AUTHORIZED clears project rights while every publisher licence stays UNKNOWN / PENDING")
    void ownerAuthorizationIsNotAPublisherLicence() {
        for (String id : List.of(CAM17_T1, ETS_T1)) {
            ExamContentPackage pkg = PACKAGES.get(id);
            assumeTrue(pkg != null);
            ExamReleaseReadinessGate.Decision d = decide(id, pkg, ExamRunnerCapabilities.CURRENT, ExamMediaImportPlan.plan(pkg, REPO, false));
            assertTrue(d.projectAuthorized());
            pkg.sources().stream().filter(s -> "THIRD_PARTY_PUBLICATION".equals(s.sourceType())).forEach(src ->
                    pkg.licenses().stream().filter(l -> l.sourceId().equals(src.id())).forEach(l -> {
                        assertEquals(com.englishcoach.exams.model.ExamTypes.ProvenanceCategory.UNKNOWN, l.provenanceCategory());
                        assertEquals("PENDING", l.legalStatus());
                    }));
            assertFalse(new ExamContentPackageValidator(MAPPER).validate(pkg, NOW).valid(),
                    "the production basis still refuses the package (publisher licence not established)");
        }
    }
}
