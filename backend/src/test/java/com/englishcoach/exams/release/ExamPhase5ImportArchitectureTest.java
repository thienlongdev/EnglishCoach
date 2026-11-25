package com.englishcoach.exams.release;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.content.ExamPackageIdentity;
import com.englishcoach.exams.content.ExamPackageSuccessorBuilder;
import com.englishcoach.exams.release.ExamImportPlanner.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Exams Recovery Phase 5C–5H — pure tests of the import architecture on the repository pilot packages (read only;
 * every mutation below is an in-memory copy): package identity, gate-driven planner, deterministic successor versions,
 * media manifest.
 */
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamPhase5ImportArchitectureTest {

    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    private static final Path LISTENING = Path.of("..", "content", "exams", "original-pilot", "IELTS",
            "IELTS_SHARED_LISTENING_PILOT_001_V2.json");
    private static final Path WRITING = Path.of("..", "content", "exams", "original-pilot", "IELTS",
            "IELTS_ACAD_WRITING_PILOT_001_V1.json");
    private static ObjectNode listeningJson;
    private static ObjectNode writingJson;

    @BeforeAll
    static void load() throws Exception {
        assumeTrue(Files.isRegularFile(LISTENING) && Files.isRegularFile(WRITING), "pilot packages not present");
        listeningJson = (ObjectNode) MAPPER.readTree(LISTENING.toFile());
        writingJson = (ObjectNode) MAPPER.readTree(WRITING.toFile());
    }

    /** In-memory copy with a source identity (raw corpus shape) and a recomputed manifest hash. */
    static ExamContentPackage withSource(ObjectNode json, java.util.function.Consumer<ObjectNode> edit) throws Exception {
        ObjectNode copy = json.deepCopy();
        ObjectNode meta = copy.with("manifest").with("metadata");
        ObjectNode si = meta.putObject("sourceIdentity");
        si.put("publisher", "Pilot");
        si.put("collection", "pilot");
        si.put("book", "Pilot-Book");
        si.put("test", 1);
        si.put("rawSourceSha256", "ab".repeat(32));
        ObjectNode prov = meta.putObject("sourceProvenance");
        prov.put("extractorName", "exam-raw-extractor");
        prov.put("extractorVersion", "3.7.0");
        if (edit != null) edit.accept(copy);
        ExamContentPackage parsed = MAPPER.treeToValue(copy, ExamContentPackage.class);
        copy.with("manifest").put("contentHash", new ExamContentPackageValidator(MAPPER).computeContentHash(parsed));
        return MAPPER.treeToValue(copy, ExamContentPackage.class);
    }

    static void editFirstKey(ObjectNode pkg, String value) {
        for (JsonNode s : pkg.path("answerSpecs")) {
            if (s.path("acceptedAnswers").has("values")) {
                ((ObjectNode) s.path("acceptedAnswers")).set("values", MAPPER.createArrayNode().add(value));
                return;
            }
        }
        fail("no keyed answer spec");
    }

    static ExamReleaseReadinessGate.Decision gate(boolean importReady, boolean readyExceptHuman) {
        return new ExamReleaseReadinessGate.Decision("x", true, importReady, true, true, importReady, true, true,
                List.of(), readyExceptHuman);
    }

    /** In-memory target database. */
    static final class FakeState implements StateReader {
        final List<ImportedVersion> imports = new ArrayList<>();
        final List<FormRef> forms = new ArrayList<>();
        public List<ImportedVersion> importsForSource(String k) {
            return imports.stream().filter(v -> v.identity() != null && k.equals(v.identity().sourceKey())).toList();
        }
        public List<FormRef> formsByLogicalKey(String k) { return forms.stream().filter(f -> f.logicalKey().equals(k)).toList(); }
        public List<FormRef> formsByLogicalKeys(Collection<String> ks) { return forms.stream().filter(f -> ks.contains(f.logicalKey())).toList(); }
        void imported(ExamContentPackage p, int formVersion) {
            ExamPackageIdentity id = ExamPackageIdentity.of(p);
            imports.add(new ImportedVersion(p.manifest().packageId(), p.manifest().packageVersion(), p.manifest().contentHash(),
                    p.form().id(), formVersion, "DRAFT", id));
            forms.add(new FormRef(p.form().id(), p.form().logicalKey(), formVersion, "DRAFT"));
        }
    }

    // ── 5C identity ────────────────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("5C: metadata drift (extractor version, OCR metrics, title, asset state) keeps the semantic fingerprint")
    void identityStableAcrossMetadataDrift() throws Exception {
        ExamContentPackage a = withSource(listeningJson, null);
        ExamContentPackage b = withSource(listeningJson, j -> {
            ObjectNode meta = j.with("manifest").with("metadata");
            meta.with("sourceProvenance").put("extractorVersion", "9.9.9");
            meta.putObject("ocr").put("pagesRead", 123);
            j.with("form").put("title", "Owner-selected display name");
            for (JsonNode as : j.path("assets")) ((ObjectNode) as).put("validationState", "PENDING");
        });
        ExamPackageIdentity ia = ExamPackageIdentity.of(a), ib = ExamPackageIdentity.of(b);
        assertNotEquals(a.manifest().contentHash(), b.manifest().contentHash(), "the manifest hash moves with metadata");
        assertEquals(ia.semanticFingerprint(), ib.semanticFingerprint(), "content unchanged => same identity");
        assertNotEquals(ia.displayDigest(), ib.displayDigest());
        assertNotEquals(ia.mediaStateDigest(), ib.mediaStateDigest());
        assertEquals("IELTS:pilot/pilot-book/test-1", ia.sourceKey());
        assertEquals(ia, ExamPackageIdentity.fromMap(ia.asMap()).orElseThrow(), "recorded identity round-trips");
        assertEquals(ExamPackageIdentity.of(a), ia, "deterministic");
    }

    @Test
    @DisplayName("5C: an answer-key change is a content change confined to its group placement")
    void keyChangeIsContentChange() throws Exception {
        ExamContentPackage a = withSource(listeningJson, null);
        ExamContentPackage b = withSource(listeningJson, j -> editFirstKey(j, "corrected value"));
        ExamPackageIdentity ia = ExamPackageIdentity.of(a), ib = ExamPackageIdentity.of(b);
        assertNotEquals(ia.semanticFingerprint(), ib.semanticFingerprint());
        assertEquals(1, ib.changedPlacements(ia).size());
        assertEquals(ia.placements().size(), ib.placements().size());
    }

    @Test
    @DisplayName("5C: local machine paths in package metadata are reported (never shipped)")
    void localPathsReported() throws Exception {
        ExamContentPackage clean = withSource(listeningJson, j -> j.with("manifest").with("metadata")
                .with("sourceProvenance").putObject("rawSourceFile").put("path", "imports/source-files/x.pdf"));
        assertTrue(ExamPackageIdentity.of(clean).pathViolations().isEmpty(), "repo-relative paths are fine");
        ExamContentPackage dirty = withSource(listeningJson, j -> j.with("manifest").with("metadata")
                .with("sourceProvenance").putObject("rawSourceFile").put("path", "C:\\Users\\someone\\x.pdf"));
        assertFalse(ExamPackageIdentity.of(dirty).pathViolations().isEmpty());
    }

    // ── 5D / 5E / 5F planner ───────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("5D: release gate drives the plan — READY_EXCEPT_HUMAN_QA is BLOCKED; production is always BLOCKED")
    void gateDrivesPlan() throws Exception {
        ExamContentPackage p = withSource(listeningJson, null);
        Plan ready = ExamImportPlanner.plan(p, null, gate(true, false), null, List.of(), new FakeState(), Target.LOCAL_DRY_RUN);
        assertEquals(Operation.CREATE, ready.operation());
        assertEquals(p.form().version(), ready.plannedFormVersion(), "first import keeps the package's own version");
        Plan human = ExamImportPlanner.plan(p, null, gate(false, true), null, List.of(), new FakeState(), Target.LOCAL_DRY_RUN);
        assertEquals(Operation.BLOCKED, human.operation());
        assertEquals(Operation.CREATE, human.contentOperation(), "the content operation is still reported");
        assertTrue(human.blockers().containsAll(List.of("RELEASE_GATE_NOT_IMPORT_READY", "GATE_QA_APPROVED_NO", "GATE_MEDIA_READY_NO")));
        assertTrue(human.notes().contains("READY_EXCEPT_HUMAN_QA"));
        Plan none = ExamImportPlanner.plan(p, null, null, null, List.of(), new FakeState(), Target.LOCAL_DRY_RUN);
        assertEquals(Operation.BLOCKED, none.operation(), "no gate decision => blocked");
        Plan prod = ExamImportPlanner.plan(p, null, gate(true, false), null, List.of(), new FakeState(), Target.PRODUCTION);
        assertEquals(Operation.BLOCKED, prod.operation());
        assertTrue(prod.blockers().contains("PRODUCTION_IMPORT_BASIS_NOT_ESTABLISHED"));
        assertEquals(ready.planId(), ExamImportPlanner.plan(p, null, gate(true, false), null, List.of(), new FakeState(),
                Target.LOCAL_DRY_RUN).planId(), "deterministic plan id");
        assertTrue(Arrays.stream(Plan.class.getRecordComponents()).noneMatch(c -> c.getName().toLowerCase(Locale.ROOT)
                .matches(".*(force|skip|override|trust).*")), "no bypass field exists on a plan");
    }

    @Test
    @DisplayName("5E: same content => ALREADY_IMPORTED (also after metadata drift, whatever the gate); changed => NEW_VERSION")
    void idempotencyAndVersioning() throws Exception {
        ExamContentPackage v1 = withSource(listeningJson, null);
        FakeState db = new FakeState();
        db.imported(v1, v1.form().version());
        Plan again = ExamImportPlanner.plan(v1, null, gate(false, true), null, List.of(), db, Target.LOCAL_DRY_RUN);
        assertEquals(Operation.ALREADY_IMPORTED, again.operation());
        ExamContentPackage drift = withSource(listeningJson, j -> j.with("manifest").with("metadata")
                .with("sourceProvenance").put("extractorVersion", "3.7.1"));
        Plan d = ExamImportPlanner.plan(drift, null, gate(true, false), null, List.of(), db, Target.LOCAL_DRY_RUN);
        assertEquals(Operation.ALREADY_IMPORTED, d.operation());
        assertTrue(d.notes().contains("METADATA_ONLY_DRIFT"));

        ExamContentPackage changed = withSource(listeningJson, j -> editFirstKey(j, "corrected value"));
        Plan nv = ExamImportPlanner.plan(changed, null, gate(true, false), null, List.of(), db, Target.LOCAL_DRY_RUN);
        assertEquals(Operation.NEW_VERSION, nv.operation());
        assertEquals(v1.form().version() + 1, nv.plannedFormVersion());
        assertEquals(v1.manifest().packageVersion() + 1, nv.plannedPackageVersion());
        assertEquals(1, nv.changedPlacements().size());
        assertEquals(ExamPackageIdentity.of(v1).placements().size() - 1, nv.reusedPlacements().size());
        Plan nvBlocked = ExamImportPlanner.plan(changed, null, gate(false, true), null, List.of(), db, Target.LOCAL_DRY_RUN);
        assertEquals(Operation.BLOCKED, nvBlocked.operation(), "a new version still needs the release gate");
        assertEquals(Operation.NEW_VERSION, nvBlocked.contentOperation());
    }

    @Test
    @DisplayName("5E: a form under the same logical key without a recorded identity, or a changed shared definition, blocks")
    void identityConflictsBlock() throws Exception {
        ExamContentPackage p = withSource(listeningJson, null);
        FakeState legacyOnly = new FakeState();
        legacyOnly.forms.add(new FormRef(UUID.randomUUID(), p.form().logicalKey(), 1, "PUBLISHED"));
        Plan b = ExamImportPlanner.plan(p, null, gate(true, false), null, List.of(), legacyOnly, Target.LOCAL_DRY_RUN);
        assertEquals(Operation.BLOCKED, b.operation());
        assertTrue(b.blockers().contains("FORM_EXISTS_WITHOUT_RECORDED_IDENTITY"));

        FakeState db = new FakeState();
        db.imported(p, p.form().version());
        ExamContentPackage spec = withSource(listeningJson, j -> {
            editFirstKey(j, "x");
            ((ObjectNode) j.path("scoringSchemes").get(0)).with("aggregationRules").put("changed", true);
        });
        Plan s = ExamImportPlanner.plan(spec, null, gate(true, false), null, List.of(), db, Target.LOCAL_DRY_RUN);
        assertTrue(s.blockers().contains("SHARED_DEFINITION_CHANGED"), s.blockers().toString());
    }

    @Test
    @DisplayName("5F/5G: only a reviewed EXACT_SOURCE_MATCH to a live legacy form makes a REPLACEMENT_CANDIDATE; nothing is retired")
    void replacementCandidate() throws Exception {
        ExamContentPackage p = withSource(listeningJson, null);
        String key = ExamPackageIdentity.of(p).sourceKey();
        FakeState db = new FakeState();
        db.forms.add(new FormRef(UUID.randomUUID(), "FORM_REAL_LEGACY_T1", 1, "PUBLISHED"));
        db.forms.add(new FormRef(UUID.randomUUID(), "FORM_REAL_LEGACY_RETIRED", 1, "RETIRED"));
        List<ReplacementMapping> maps = List.of(
                new ReplacementMapping("FORM_REAL_LEGACY_T1", "LEGACY_T1", key, "EXACT_SOURCE_MATCH"),
                new ReplacementMapping("FORM_REAL_LEGACY_RETIRED", "LEGACY_R", key, "EXACT_SOURCE_MATCH"),
                new ReplacementMapping("FORM_REAL_LEGACY_T1", "LEGACY_T1B", "IELTS:other/x/test-1", "EXACT_SOURCE_MATCH"));
        Plan r = ExamImportPlanner.plan(p, null, gate(true, false), null, maps, db, Target.LOCAL_DRY_RUN);
        assertEquals(Operation.REPLACEMENT_CANDIDATE, r.operation());
        assertEquals(1, r.retireConsiderations().size(), "retired legacy forms and other sources are ignored");
        assertEquals(false, r.retireConsiderations().get(0).get("executedByPlan"));
        Plan review = ExamImportPlanner.plan(p, null, gate(true, false), null,
                List.of(new ReplacementMapping("FORM_REAL_LEGACY_T1", "LEGACY_T1", key, "REVIEW_REQUIRED")), db, Target.LOCAL_DRY_RUN);
        assertEquals(Operation.CREATE, review.operation(), "an unproven mapping never drives a replacement");
    }

    // ── 5E successor versions ────────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("5E/5F: successor = new form version; unchanged groups keep their rows, the changed group gets new versions")
    void successorVersion() throws Exception {
        ExamContentPackage v1 = withSource(listeningJson, null);
        ExamPackageIdentity id1 = ExamPackageIdentity.of(v1);
        ExamContentPackage changed = withSource(listeningJson, j -> editFirstKey(j, "corrected value"));
        int fv = id1.formVersion() + 1, pv = id1.packageVersion() + 1;
        ExamPackageSuccessorBuilder.Result r = ExamPackageSuccessorBuilder.build(changed, id1, fv, pv, MAPPER);
        ExamContentPackage v2 = r.pkg();
        assertEquals(1, r.changedPlacements().size());
        assertEquals(id1.placements().size() - 1, r.reusedPlacements().size());
        assertEquals(fv, v2.form().version());
        assertEquals(pv, v2.manifest().packageVersion());
        assertNotEquals(v1.form().id(), v2.form().id());
        assertEquals(v1.form().logicalKey(), v2.form().logicalKey());
        Set<UUID> v1Sections = new HashSet<>();
        v1.sections().forEach(s -> v1Sections.add(s.id()));
        assertTrue(v2.sections().stream().noneMatch(s -> v1Sections.contains(s.id())), "sections belong to the new form");
        Set<UUID> v1Groups = new HashSet<>();
        v1.groups().forEach(g -> v1Groups.add(g.id()));
        long sharedGroups = v2.groups().stream().filter(g -> v1Groups.contains(g.id())).count();
        assertEquals(id1.placements().size() - 1, sharedGroups, "unchanged groups are shared by id");
        assertEquals(1, v2.groups().stream().filter(g -> g.version() == fv).count());
        Set<UUID> v1Items = new HashSet<>();
        v1.items().forEach(i -> v1Items.add(i.id()));
        assertTrue(v2.items().stream().filter(i -> i.version() == fv).noneMatch(i -> v1Items.contains(i.id())),
                "changed items are new rows, the old ones stay untouched");
        assertTrue(new ExamContentPackageValidator(MAPPER).computeContentHash(v2).equals(v2.manifest().contentHash()));
        assertEquals(ExamPackageIdentity.of(changed).semanticFingerprint(), ExamPackageIdentity.of(v2).semanticFingerprint(),
                "re-identification never changes content");
        assertEquals(MAPPER.writeValueAsString(v2),
                MAPPER.writeValueAsString(ExamPackageSuccessorBuilder.build(changed, id1, fv, pv, MAPPER).pkg()), "deterministic");
        assertThrows(IllegalArgumentException.class, () -> ExamPackageSuccessorBuilder.build(changed, id1, id1.formVersion(), pv, MAPPER));
        ExamContentPackage other = withSource(listeningJson, j -> j.with("manifest").with("metadata")
                .with("sourceIdentity").put("test", 2));
        assertThrows(IllegalArgumentException.class, () -> ExamPackageSuccessorBuilder.build(other, id1, fv, pv, MAPPER));
    }

    // ── 5H media manifest ──────────────────────────────────────────────────────────────────────────────

    @Test
    @SuppressWarnings("unchecked")
    @DisplayName("5H: media manifest deduplicates by SHA-256, needs human approval for images, rejects URL keys")
    void mediaManifest() throws Exception {
        ExamContentPackage a = withSource(writingJson, null);
        ExamContentPackage b = withSource(writingJson, j -> {
            j.with("form").put("logicalKey", j.path("form").path("logicalKey").asText() + "_B");
            j.with("manifest").put("packageId", j.path("manifest").path("packageId").asText() + "-B");
            j.with("manifest").with("metadata").with("sourceIdentity").put("test", 2);
        });
        assumeTrue(!a.assets().isEmpty());
        Map<String, Object> m = ExamMediaImportManifest.build(List.of(
                new ExamMediaImportManifest.PackageMedia(a, ExamMediaImportPlan.plan(a, Path.of(".."), false), Map.of()),
                new ExamMediaImportManifest.PackageMedia(b, ExamMediaImportPlan.plan(b, Path.of(".."), false), Map.of())));
        Map<String, Object> s = (Map<String, Object>) m.get("summary");
        assertEquals(a.assets().size(), s.get("assets"), "the same bytes are one asset");
        assertEquals(2 * a.stimulusAssets().size(), s.get("bindings"));
        List<Map<String, Object>> assets = (List<Map<String, Object>>) m.get("assets");
        for (Map<String, Object> e : assets) {
            assertTrue(String.valueOf(e.get("canonicalAssetId")).startsWith("sha256:"));
            if (String.valueOf(e.get("mimeType")).startsWith("image/")) {
                assertEquals(Boolean.TRUE, ((Map<?, ?>) e.get("humanApproval")).get("required"));
                assertNotEquals("APPROVED", ((Map<?, ?>) e.get("humanApproval")).get("status"));
            }
        }
        ExamContentPackage url = withSource(writingJson, j -> {
            for (JsonNode as : j.path("assets")) ((ObjectNode) as).put("objectKey", "http://localhost:8080/storage/x.png");
        });
        Map<String, Object> bad = ExamMediaImportManifest.build(List.of(new ExamMediaImportManifest.PackageMedia(url,
                ExamMediaImportPlan.plan(url, Path.of(".."), false), Map.of())));
        assertFalse(((List<?>) bad.get("violations")).isEmpty(), "a localhost URL never becomes a canonical key");
    }
}
