package com.englishcoach.exams.hardening;

import com.englishcoach.exams.model.ExamContentRecords.AnswerSpecRecord;
import com.englishcoach.exams.practice.ExamLearnerContentSanitizer;
import com.englishcoach.exams.service.ExamResultService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Exams Phase 9B — learner payload leak audit over REAL content (Docker-free): every stimulus body and option definition of
 * the 32 staged packages + the legacy pilot packages goes through the ONE learner sanitizer that every manifest path now
 * applies; the learner review answer truth goes through {@link ExamResultService#learnerCorrectAnswers}. The serialized
 * results are scanned for forbidden key NAMES at any depth and for machine paths. Learner text is kept. Fixtures are only
 * read (guarded).
 */
@ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamPhase9LearnerPayloadTest {

    static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    static final Path STAGED = Path.of("..", "imports", "exams", "staging", "extracted");
    static final Path PILOT = Path.of("..", "content", "exams", "original-pilot");

    /** Key names that must never appear anywhere in a learner manifest / pre-submission payload. */
    static final Set<String> FORBIDDEN_KEYS = Set.of(
            "acceptedAnswers", "answerKey", "correctAnswer", "correctAnswers", "keySource", "rejectedAnswers", "distractorLogic",
            "evidence", "evidenceRequired", "policy", "responsePolicy", "aiReview",
            "transcript", "transcriptText", "transcriptAvailable", "transcriptEmbedded", "segments", "scriptSegments",
            "dialogueSegments", "spokenResponses", "spokenPrompt", "learnerResponse", "scriptStatus",
            "mappingConfidence", "confidence", "ocrConfidence", "bbox", "boundingBox", "rendering", "sourcePage", "sourcePages",
            "sourceRole", "sourcePath", "sourceProvenance", "provenance", "provenanceId", "sourceIdentity", "extractionMethod",
            "extractor", "qaNotes", "notes", "reviewNote", "reviewEvidence", "fingerprint", "importStatus", "runtimeUse",
            "questionRange", "playback", "sceneDescription", "licence", "license", "rights");

    static final List<String> MACHINE_PATHS = List.of("C:/", "/home/", "/mnt/", "file:", "localhost", "imports/source-files");

    static List<Path> packages() throws Exception {
        List<Path> out = new ArrayList<>();
        for (Path root : List.of(STAGED, PILOT)) {
            if (!Files.isDirectory(root)) continue;
            try (Stream<Path> s = Files.walk(root)) {
                s.filter(p -> p.toString().endsWith(".json")).sorted().forEach(out::add);
            }
        }
        return out;
    }

    static void collectKeys(JsonNode n, Set<String> keys) {
        if (n.isObject()) n.fields().forEachRemaining(e -> {
            keys.add(e.getKey());
            collectKeys(e.getValue(), keys);
        });
        else if (n.isArray()) n.forEach(c -> collectKeys(c, keys));
    }

    static void findAll(JsonNode n, String key, List<JsonNode> out) {
        if (n.isObject()) n.fields().forEachRemaining(e -> {
            if (e.getKey().equals(key)) out.add(e.getValue());
            findAll(e.getValue(), key, out);
        });
        else if (n.isArray()) n.forEach(c -> findAll(c, key, out));
    }

    @Test
    @DisplayName("11-14/17/18: sanitized stimulus bodies + option definitions of every real package carry no key, transcript, "
            + "OCR / extractor / QA / provenance metadata or machine path — and keep the learner text")
    @SuppressWarnings("unchecked")
    void sanitizedContentIsLearnerSafe() throws Exception {
        List<Path> pkgs = packages();
        assumeTrue(!pkgs.isEmpty(), "no local content packages");
        int bodies = 0, defs = 0, textsKept = 0, rawLeaksBefore = 0;
        for (Path p : pkgs) {
            JsonNode root;
            try {
                root = MAPPER.readTree(p.toFile());
            } catch (Exception e) {
                continue;
            }
            List<JsonNode> stimuli = new ArrayList<>();
            findAll(root, "stimuli", stimuli);
            for (JsonNode list : stimuli) {
                if (!list.isArray()) continue;
                for (JsonNode st : list) {
                    JsonNode body = st.has("bodyPayload") ? st.get("bodyPayload") : st.get("body");
                    if (body == null || !body.isObject()) continue;
                    Set<String> rawKeys = new HashSet<>();
                    collectKeys(body, rawKeys);
                    if (rawKeys.stream().anyMatch(FORBIDDEN_KEYS::contains)) rawLeaksBefore++;
                    String kind = st.path("kind").asText(null);
                    Map<String, Object> clean = ExamLearnerContentSanitizer.stimulusBody(kind, MAPPER.convertValue(body, Map.class));
                    bodies++;
                    assertLearnerSafe(MAPPER.valueToTree(clean), p + " stimulus");
                    if (body.has("text") && !"AUDIO".equalsIgnoreCase(kind)) {
                        assertEquals(body.get("text"), MAPPER.valueToTree(clean).get("text"), "learner text kept: " + p);
                        textsKept++;
                    }
                }
            }
            List<JsonNode> optionDefs = new ArrayList<>();
            findAll(root, "optionDefinitions", optionDefs);
            for (JsonNode od : optionDefs) {
                if (!od.isObject()) continue;
                Map<String, Object> clean = ExamLearnerContentSanitizer.optionDefinitions(MAPPER.convertValue(od, Map.class));
                defs++;
                assertLearnerSafe(MAPPER.valueToTree(clean), p + " optionDefinitions");
                if (od.has("options")) assertEquals(od.get("options").size(), MAPPER.valueToTree(clean).get("options").size(),
                        "every option kept: " + p);
            }
        }
        assertTrue(bodies > 300, "the real corpus was scanned (" + bodies + " stimulus bodies)");
        assertTrue(defs > 2000, "option definitions scanned (" + defs + ")");
        assertTrue(textsKept > 100, "learner passages kept (" + textsKept + ")");
        assertTrue(rawLeaksBefore > 0, "the RAW bodies do carry internal metadata — the sanitizer is what removes it");
    }

    @Test
    @DisplayName("audio stimuli never carry a body (no hidden transcript), whatever the source stored")
    void audioBodyEmpty() {
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("segments", List.of(Map.of("text", "spoken words")));
        raw.put("transcriptAvailable", true);
        raw.put("text", "a transcript stored as text");
        assertEquals(Map.of(), ExamLearnerContentSanitizer.stimulusBody("AUDIO", raw));
    }

    @Test
    @DisplayName("17: legacy rendering references survive only as learner-safe relative references, never machine paths")
    void renderingReferences() {
        assertEquals("pilot_part1_photo.svg", ExamLearnerContentSanitizer.stimulusBody("IMAGE",
                Map.of("svgAsset", "pilot_part1_photo.svg", "sceneDescription", "answer-revealing caption")).get("svgAsset"));
        for (String bad : List.of("C:\\Users\\x\\photo.png", "C:/data/photo.png", "/home/app/photo.png", "file:///etc/x",
                "../../secret.png", "http://localhost:8080/storage/x.png", "\\\\server\\share\\x.png")) {
            assertFalse(ExamLearnerContentSanitizer.learnerSafeReference(bad), bad);
            assertFalse(ExamLearnerContentSanitizer.stimulusBody("IMAGE", Map.of("imageUrl", bad)).containsKey("imageUrl"), bad);
        }
        assertTrue(ExamLearnerContentSanitizer.learnerSafeReference("/storage/exams/images/a.png"));
    }

    @Test
    @DisplayName("19: post-submission review answer truth = canonical values only (no keySource / policy / evidence / rejected answers)")
    @SuppressWarnings("unchecked")
    void reviewAnswerTruthSanitized() throws Exception {
        List<Path> pkgs = packages();
        assumeTrue(!pkgs.isEmpty(), "no local content packages");
        int specs = 0, withValues = 0;
        for (Path p : pkgs) {
            JsonNode root;
            try {
                root = MAPPER.readTree(p.toFile());
            } catch (Exception e) {
                continue;
            }
            List<JsonNode> accepted = new ArrayList<>();
            findAll(root, "acceptedAnswers", accepted);
            for (JsonNode a : accepted) {
                if (!a.isObject()) continue;
                AnswerSpecRecord spec = new AnswerSpecRecord(UUID.randomUUID(), UUID.randomUUID(), MAPPER.convertValue(a, Map.class),
                        Map.of(), 1, null, 1.0, null, null, Instant.EPOCH);
                Map<String, Object> learner = ExamResultService.learnerCorrectAnswers(spec);
                specs++;
                assertEquals(Set.of("values"), learner.keySet(), p.toString());
                if (!((List<?>) learner.get("values")).isEmpty()) withValues++;
                Set<String> keys = new HashSet<>();
                collectKeys(MAPPER.valueToTree(learner), keys);
                keys.remove("values");
                assertTrue(keys.isEmpty(), "only values: " + keys);
            }
        }
        assertTrue(specs > 1000, "real answer specs checked (" + specs + ")");
        assertTrue(withValues > 1000, "the canonical correct values are still shown after submission (" + withValues + ")");
    }

    static void assertLearnerSafe(JsonNode payload, String where) {
        Set<String> keys = new HashSet<>();
        collectKeys(payload, keys);
        for (String k : keys) assertFalse(FORBIDDEN_KEYS.contains(k), "forbidden key '" + k + "' in " + where);
        List<String> texts = new ArrayList<>();
        collectText(payload, texts);
        for (String text : texts) {
            for (String path : MACHINE_PATHS) assertFalse(text.contains(path), "machine path '" + path + "' in " + where);
            assertFalse(DRIVE_PATH.matcher(text).find(), "drive path in " + where);
        }
    }

    static final java.util.regex.Pattern DRIVE_PATH = java.util.regex.Pattern.compile("\\b[A-Za-z]:\\\\[A-Za-z0-9_ ]");

    /** Decoded string values (JSON escapes such as "
" are not machine paths). */
    static void collectText(JsonNode n, List<String> out) {
        if (n.isTextual()) out.add(n.asText());
        else if (n.isContainerNode()) n.forEach(c -> collectText(c, out));
    }
}
