package com.englishcoach.exams.staging;

import com.englishcoach.exams.CorpusFixturesUnchangedExtension;
import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.release.ExamMediaImportPlan;
import com.englishcoach.exams.release.ExamReleaseReadinessGate;
import com.englishcoach.exams.release.ExamRuntimeCompatibility;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.validation.ExamContentTree;
import com.englishcoach.exams.validation.ExamFormValidator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Exams Recovery Phase 4.1 regressions: the five KEY_BREAKS_WORD_LIMIT conflicts resolved from source (slash read as a
 * digit / 'I', bracket-expanded combination over the printed limit, examiner annotations, page folio, calendar dates
 * as "a number"), the crop-QA media gate, READY_EXCEPT_HUMAN_QA, and the fixture-mutation guard. Staging-backed checks
 * skip without the local corpus.
 */
@ExtendWith(CorpusFixturesUnchangedExtension.class)
class ExamPhase41RegressionTest {

    private static final Path REPO = Path.of("..");
    private static final Path EXTRACTED = REPO.resolve("imports/exams/staging/extracted");
    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    private final ExamAnswerNormalizer normalizer = new ExamAnswerNormalizer();

    static JsonNode pkgJson(String rel) throws Exception {
        Path p = EXTRACTED.resolve(rel);
        assumeTrue(Files.isRegularFile(p), "staged package not present: " + rel);
        return MAPPER.readTree(p.toFile());
    }

    static JsonNode spec(JsonNode pkg, String logicalKeySuffix) {
        String itemId = null;
        for (JsonNode it : pkg.path("items")) if (it.path("logicalItemKey").asText().endsWith(logicalKeySuffix)) itemId = it.path("id").asText();
        assertNotNull(itemId, logicalKeySuffix);
        for (JsonNode s : pkg.path("answerSpecs")) if (s.path("itemId").asText().equals(itemId)) return s;
        throw new AssertionError("no spec for " + logicalKeySuffix);
    }

    static List<String> values(JsonNode spec) {
        List<String> out = new ArrayList<>();
        spec.path("acceptedAnswers").path("values").forEach(v -> out.add(v.asText()));
        return out;
    }

    @Test
    @DisplayName("13. date variants: '(the) 13(th) (of) January' is 'a number' under AND/OR A NUMBER, never otherwise")
    void dateVariants() {
        assertEquals(0, normalizer.countWords("the 13th of January", true));
        assertEquals(0, normalizer.countWords("13 January", true));
        assertEquals(0, normalizer.countWords("January the 13th", true));
        assertEquals(0, normalizer.countWords("May 5th", true));
        assertEquals(2, normalizer.countWords("may be", true), "a month word is a date only next to a day number");
        assertEquals(1, normalizer.countWords("January", true), "a month alone is a word");
        assertEquals(4, normalizer.countWords("the 13th of January", false), "no number rule ⇒ plain word count");
        assertEquals(2, normalizer.countWords("the 32 January", true), "32 is not a day: 'the' + 'January' count");
    }

    @Test
    @DisplayName("printed '(must have capitals)' ⇒ case-sensitive comparison for that item only")
    void capitalsRequired() {
        Map<String, Object> cs = Map.of("caseSensitive", true, "caseInsensitive", false);
        assertNotEquals(normalizer.normalize("hope street", cs), normalizer.normalize("Hope Street", cs));
        assertEquals(normalizer.normalize("hope street", Map.of()), normalizer.normalize("Hope Street", Map.of()));
    }

    @Test
    @DisplayName("11/12. the five KEY_BREAKS_WORD_LIMIT forms are scoring-compatible after source-faithful key repair")
    void fiveConflictsResolved() throws Exception {
        Map<String, String> forms = Map.of(
                "CAM1_T1", "ielts/cambridge/cambridge-ielts-1/cambridge-ielts-1__test-1.json",
                "CAM1_T2", "ielts/cambridge/cambridge-ielts-1/cambridge-ielts-1__test-2.json",
                "CAM1_T4", "ielts/cambridge/cambridge-ielts-1/cambridge-ielts-1__test-4.json",
                "CAM16_T1", "ielts/cambridge/cambridge-ielts-16/cambridge-ielts-16__test-1.json",
                "CAM21_T2", "ielts/cambridge/cambridge-ielts-21/cambridge-ielts-21__test-2.json");
        for (Map.Entry<String, String> f : forms.entrySet()) {
            ExamContentPackage pkg = MAPPER.treeToValue(pkgJson(f.getValue()), ExamContentPackage.class);
            ExamRuntimeCompatibility.Report r = ExamRuntimeCompatibility.audit(pkg);
            assertTrue(r.scoringCompatible(), f.getKey() + " " + r.blockingCodes(ExamRuntimeCompatibility.Gate.SCORING));
        }
        JsonNode cam16 = pkgJson(forms.get("CAM16_T1"));
        assertEquals(List.of("movie", "film"), values(spec(cam16, "_L006")), "OCR '/' read as '1' is a separator, never a digit");
        assertEquals(List.of("practice", "practise"), values(spec(cam16, "_L040")), "the page folio is not part of the key");
        JsonNode cam1t1 = pkgJson(forms.get("CAM1_T1"));
        for (String v : values(spec(cam1t1, "_L035"))) {
            assertTrue(normalizer.countWords(v, false) <= 3, "no optional-word combination over NO MORE THAN THREE WORDS: " + v);
        }
        assertEquals(3, values(spec(cam1t1, "_L035")).size(), "each printed optional part still accepted");
        JsonNode t2 = spec(pkgJson(forms.get("CAM1_T2")), "_L003");
        assertEquals(List.of("not friendly", "kept to themselves"), values(t2));
        assertEquals("lonely", t2.path("acceptedAnswers").path("rejectedAnswers").get(0).asText(), "printed rejected answer kept as metadata");
        JsonNode t4 = spec(pkgJson(forms.get("CAM1_T4")), "_L013");
        assertEquals(List.of("Hope Street"), values(t4));
        assertTrue(t4.path("normalizationPolicy").path("caseSensitive").asBoolean());
        JsonNode cam21 = pkgJson(forms.get("CAM21_T2"));
        assertEquals(List.of("jewellery", "jewelry"), values(spec(cam21, "_R026")), "'I' separator under ONE WORD ONLY");
        assertTrue(values(spec(cam21, "_L001")).contains("the 13th of January"), "printed date forms are NOT deleted");
    }

    private static ExamContentPackage withAssetState(ExamContentPackage pkg, String state) {
        ObjectNode json = MAPPER.valueToTree(pkg);
        for (JsonNode a : json.path("assets")) if (a.path("mimeType").asText().startsWith("image/")) ((ObjectNode) a).put("validationState", state);
        return MAPPER.convertValue(json, ExamContentPackage.class);
    }

    private static Map<String, ExamMediaImportPlan.CropQa> crops(ExamContentPackage pkg, String technical, boolean approved) {
        Map<String, ExamMediaImportPlan.CropQa> out = new HashMap<>();
        pkg.assets().stream().filter(a -> a.mimeType().startsWith("image/"))
                .forEach(a -> out.put(a.sha256Hash().toLowerCase(Locale.ROOT), new ExamMediaImportPlan.CropQa(technical, approved)));
        return out;
    }

    @Test
    @DisplayName("14. MEDIA_READY needs bytes + hash + binding + VALIDATED + technical crop check + a human decision")
    void mediaGateNeedsHumanCropDecision() throws Exception {
        ExamContentPackage ets = MAPPER.treeToValue(pkgJson("toeic/ets/ets-2026/ets-2026__test-1.json"), ExamContentPackage.class);
        ExamMediaImportPlan.Plan none = ExamMediaImportPlan.plan(ets, REPO, true, Map.of());
        assertFalse(none.mediaReady());
        assertFalse(none.readyExceptHumanCropQa(), "no crop QA facts ⇒ not even technically cleared");
        ExamMediaImportPlan.Plan technical = ExamMediaImportPlan.plan(ets, REPO, true, crops(ets, "TECHNICALLY_VALID", false));
        assertFalse(technical.mediaReady(), "a technical check is never an approval");
        assertTrue(technical.readyExceptHumanCropQa());
        assertTrue(technical.blockers().containsKey("CROP_QA_DECISION_PENDING"));
        ExamMediaImportPlan.Plan approvedButPending = ExamMediaImportPlan.plan(ets, REPO, true, crops(ets, "TECHNICALLY_VALID", true));
        assertFalse(approvedButPending.mediaReady(), "the asset must also be VALIDATED (applied by the package builder)");
        ExamContentPackage validated = withAssetState(ets, "VALIDATED");
        assertTrue(ExamMediaImportPlan.plan(validated, REPO, true, crops(validated, "TECHNICALLY_VALID", true)).mediaReady());
        assertFalse(ExamMediaImportPlan.plan(validated, REPO, true, crops(validated, "TECHNICAL_FAIL", true)).mediaReady(),
                "a technical failure blocks even with an approval");
    }

    @Test
    @DisplayName("READY_EXCEPT_HUMAN_QA: engineering cleared, only OPEN human decisions left; a REJECTED entry clears it")
    void readyExceptHumanQa() throws Exception {
        ExamContentPackage cam = MAPPER.treeToValue(pkgJson("ielts/cambridge/cambridge-ielts-17/cambridge-ielts-17__test-1.json"),
                ExamContentPackage.class);
        var structural = ExamFormValidator.validate(ExamContentTree.fromPackage(cam, MAPPER), MAPPER, Instant.parse("2026-10-03T12:00:00Z"));
        List<String> closure = new com.englishcoach.exams.content.ExamContentPackageValidator(MAPPER)
                .validate(cam, Instant.parse("2026-10-03T12:00:00Z")).errors().stream().map(ExamContentPackage.ValidationError::code).toList();
        var compat = ExamRuntimeCompatibility.audit(cam);
        var media = ExamMediaImportPlan.plan(cam, REPO, true, crops(cam, "TECHNICALLY_VALID", false));
        var open = new ExamReleaseReadinessGate.QaStatus(true, Map.of("P2", 1), Set.of("IMAGE_REGION_HEURISTIC"),
                Set.of("IMAGE_REGION_HEURISTIC"), Set.of("OPEN"));
        ExamReleaseReadinessGate.Decision d = ExamReleaseReadinessGate.evaluate(cam, structural, closure, compat, open, media);
        assertFalse(d.importReady());
        assertTrue(d.readyExceptHumanQa(), d.reasons().toString());
        var rejected = new ExamReleaseReadinessGate.QaStatus(true, Map.of("P2", 1), Set.of("IMAGE_REGION_HEURISTIC"),
                Set.of("IMAGE_REGION_HEURISTIC"), Set.of("REJECTED"));
        assertFalse(ExamReleaseReadinessGate.evaluate(cam, structural, closure, compat, rejected, media).readyExceptHumanQa(),
                "a rejected crop needs engineering work, not just a decision");
    }

    @Test
    @DisplayName("17. fixture guard: any added / removed / changed corpus file is reported")
    void fixtureGuardDetectsMutation() {
        Map<String, String> before = Map.of("a.json@x", "1", "b.json@x", "2");
        assertEquals(List.of(), CorpusFixturesUnchangedExtension.diff(before, before));
        assertEquals(List.of("a.json@x", "b.json@x", "c.json@x"),
                CorpusFixturesUnchangedExtension.diff(before, Map.of("a.json@x", "9", "c.json@x", "3")));
    }
}
