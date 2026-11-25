package com.englishcoach.exams.practice;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.practice.ExamPracticeRecords.CreatePracticeAttemptRequest;
import com.englishcoach.exams.scoring.ExamAttemptSnapshotContent;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import org.junit.jupiter.api.*;

import java.nio.file.*;
import java.util.*;
import java.io.*;
import com.englishcoach.exams.release.ExamMediaImportPlan;
import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.model.ExamTypes.MediaPurpose;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import static org.mockito.Mockito.*;

import static com.englishcoach.exams.practice.ExamPracticePostgresTest.*;
import static org.junit.jupiter.api.Assertions.*;

/** All staged objective candidates through real services in a disposable PostgreSQL 17 database.
 * LOCAL owner rights are test wiring only; PASS never grants human QA, rights or production release.
 * Enumeration uses the extraction index; no recursive corpus walk or historical cache paths.
 */
class ExamCorpusQualificationPostgresTest {
    static final Path STAGING = Path.of("..", "imports", "exams", "staging");
    static final List<Map<String, Object>> RESULTS = new ArrayList<>();
    static final Map<Path, byte[]> READ_PACKAGES = new LinkedHashMap<>();
    static final String EVIDENCE_NAME = System.getProperty("exams.qualification.evidence");
    static final String BOOK_FILTER = System.getProperty("exams.qualification.book");
    static final Map<String, ExamMediaImportPlan.Entry> VERIFIED_MEDIA = new HashMap<>();

    @BeforeAll static void setup() throws Exception {
        if (BOOK_FILTER != null) assertTrue(BOOK_FILTER.matches("[a-z0-9]+(?:-[a-z0-9]+)*"), "invalid book selector");
        ExamPracticePostgresTest.setUp();
        var repository = new ExamMediaRepository(named, MAPPER);
        var rights = ExamRightsService.ownerAuthorizedLocalRuntime(contentRepository, repository, new ExamsProperties());
        ExamObjectStorage sourceStorage = mock(ExamObjectStorage.class);
        when(sourceStorage.contentLength(anyString())).thenAnswer(call -> {
            var entry = VERIFIED_MEDIA.get(call.getArgument(0, String.class));
            assertNotNull(entry, "unverified media object");
            if (entry.sourceKind() == ExamMediaImportPlan.SourceKind.RAW_ZIP_MEMBER) {
                String[] pieces = entry.sourcePath().split("::", 2);
                try (var zip = new java.util.zip.ZipFile(Path.of("..").resolve(pieces[0]).toFile())) {
                    return zip.getEntry(pieces[1]).getSize();
                }
            }
            return Files.size(Path.of("..").resolve(entry.sourcePath()));
        });
        when(sourceStorage.getObjectStream(anyString())).thenAnswer(call -> openVerifiedMedia(call.getArgument(0, String.class)));
        media = new ExamMediaService(repository, attemptRepository, rights, sourceStorage);
    }

    @AfterAll static void close() throws Exception {
        if (POOL != null) POOL.close();
        if (pg != null) pg.stop();
        for (var read : READ_PACKAGES.entrySet()) assertArrayEquals(read.getValue(), Files.readAllBytes(read.getKey()),
                "qualification changed a corpus fixture: " + read.getKey());
        if (!RESULTS.isEmpty() && EVIDENCE_NAME != null) {
            Map<String, Object> report = new LinkedHashMap<>();
            report.put("basis", "ISOLATED_TESTCONTAINER_OWNER_AUTHORIZED_LOCAL_ONLY");
            report.put("productionQualified", false);
            report.put("humanApprovalsWritten", 0);
            report.put("bookSelector", BOOK_FILTER == null ? "ALL_STAGED" : BOOK_FILTER);
            report.put("results", RESULTS);
            Files.writeString(Path.of("..", "docs", "exams-production-verification", "20261006", EVIDENCE_NAME), MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(report),
                    StandardOpenOption.CREATE_NEW);
        }
    }

    @Test void everyStagedObjectiveScope() throws Exception {
        var importer = new ExamContentPackageImporter(contentRepository, new ExamContentPackageValidator(MAPPER));
        importer.setValidationService(validation);
        importer.setOwnerAuthorizedDryRunEnabled(true);
        Map<?, ?> runs = MAPPER.readValue(STAGING.resolve("cache/runs.json").toFile(), Map.class);
        List<String> failures = new ArrayList<>();
        int tested = 0;
        for (String testId : runs.keySet().stream().map(String::valueOf).sorted().toList()) {
            String[] identity = testId.split("/");
            assertEquals(3, identity.length);
            assertTrue(testId.matches("(ielts|toeic)/[a-z0-9-]+/test-[1-9][0-9]*"));
            if (BOOK_FILTER != null && !BOOK_FILTER.equals(identity[1])) continue;
            Path report = STAGING.resolve("reports/extraction/" + identity[0] + "/" + identity[1] + "__" + identity[2] + ".json");
            Map<?, ?> extraction = MAPPER.readValue(report.toFile(), Map.class);
            Map<?, ?> packageRef = (Map<?, ?>) extraction.get("package");
            if (packageRef.get("path") == null) continue;
            Path path = Path.of("..").resolve(String.valueOf(packageRef.get("path"))).normalize();
            assertTrue(path.toAbsolutePath().normalize().startsWith(STAGING.toAbsolutePath().normalize()));
            ExamContentPackage pkg = MAPPER.readValue(path.toFile(), ExamContentPackage.class);
            READ_PACKAGES.put(path, Files.readAllBytes(path));
            var mediaPlan = ExamMediaImportPlan.plan(pkg, Path.of(".."), true);
            for (var entry : mediaPlan.entries()) if (entry.fileStatus() == ExamMediaImportPlan.FileStatus.VERIFIED) {
                VERIFIED_MEDIA.put(entry.storageObjectKey(), entry);
            }
            UUID form;
            try {
                form = importer.importPackage(pkg, 1L,
                        ExamContentPackageImporter.ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN).formId();
                contentRepository.updateFormLifecycle(form, LifecycleState.PILOT, null, null);
                validation.invalidate(form);
            } catch (com.englishcoach.exams.content.ExamContentPackageValidationException error) {
                RESULTS.add(Map.of("testId", testId, "state", "LOCAL_IMPORT_CLOSURE_BLOCKED",
                        "exceptionType", error.getClass().getSimpleName(),
                        "reasonCodes", error.errors().stream().map(ExamContentPackage.ValidationError::code).distinct().sorted().toList()));
                continue;
            }
            for (var scope : practice.getDiagnostics(form)) {
                if (!scope.ready() || scope.objectiveItemCount() == 0) {
                    RESULTS.add(Map.of("testId", testId, "scopeCode", scope.scopeCode(),
                            "state", scope.ready() ? "PRODUCTIVE_RECORDING_OR_RESPONSE_QUALIFICATION_REQUIRED" : "CONTENT_BLOCKED",
                            "reasonCodes", scope.reasonCodes(), "questions", scope.questionCount()));
                    continue;
                }
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("testId", testId); row.put("scopeCode", scope.scopeCode());
                row.put("packageSha256", java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                        .digest(READ_PACKAGES.get(path))));
                row.put("questions", scope.questionCount()); row.put("productionQualified", false);
                try {
                    for (String scenario : List.of("ALL_CORRECT", "ALL_BLANK", "MIXED")) {
                        qualify(form, scope.scopeCode(), scenario, scope.questionCount(), scope.skill() == SkillType.LISTENING);
                    }
                    row.put("state", "LOCAL_OBJECTIVE_PIPELINE_PASS");
                    row.put("checks", List.of("SNAPSHOT", "RUNNER_MANIFEST", "AUTOSAVE", "SUBMIT", "PERSISTED_RAW_ARTIFACT",
                            "CORRECT_BLANK_MIXED", "IDEMPOTENT_SUBMIT", "RESULT_RELOAD", "SNAPSHOT_REVIEW", "HISTORY_UNCHANGED"));
                    if (scope.skill() == SkillType.LISTENING) row.put("listeningChecks",
                            List.of("SOURCE_MEDIA_SHA256", "SCOPED_AUDIO_CONTRACT", "PLAYBACK_GRANT", "GRANT_RESOLUTION", "READABLE_SOURCE_BYTES"));
                    tested++;
                } catch (AssertionError | RuntimeException error) {
                    row.put("state", "LOCAL_OBJECTIVE_PIPELINE_FAIL");
                    row.put("exceptionType", error.getClass().getSimpleName());
                    String message = String.valueOf(error.getMessage());
                    row.put("errorCode", message.matches("[A-Z_]+:.*") ? message.substring(0, message.indexOf(':')) : "QUALIFICATION_INVARIANT_FAILED");
                    failures.add(testId + ":" + scope.scopeCode());
                }
                RESULTS.add(row);
            }
        }
        assertTrue(tested > 0, "no objective scopes tested");
        assertEquals(List.of(), failures, "candidate pipeline failures (see qualification matrix)");
    }

    static void qualify(UUID form, String scope, String scenario, int expectedItems) throws Exception {
        qualify(form, scope, scenario, expectedItems, false);
    }

    @SuppressWarnings("unchecked")
    static void qualify(UUID form, String scope, String scenario, int expectedItems, boolean listening) throws Exception {
        var dto = practice.createPracticeAttempt(LEARNER, new CreatePracticeAttemptRequest(form, scope, null));
        UUID id = dto.attemptId();
        start(id, LEARNER);
        if (listening) {
            var manifest = attempts.getAttemptManifest(LEARNER, id);
            var audio = manifest.sections().stream().flatMap(s -> s.parts().stream())
                    .flatMap(p -> p.groups().stream()).flatMap(g -> g.stimuli().stream())
                    .flatMap(s -> s.assets().stream()).filter(a -> a.mimeType().startsWith("audio/"))
                    .distinct().toList();
            assertFalse(audio.isEmpty(), "listening scope without audio");
            for (var asset : audio) {
                assertTrue(asset.durationMs() != null && asset.durationMs() > 0);
                assertEquals("PLAYBACK_GRANT", asset.delivery());
                var grant = media.createPlaybackGrant(LEARNER, id, asset.assetId(), MediaPurpose.SIMULATION_LISTENING);
                assertEquals(asset.assetId(), grant.assetId());
                assertNotNull(grant.mediaStreamUrl());
                var resolved = media.openGrantedMedia(grant.grantToken());
                assertEquals(asset.mimeType(), resolved.mimeType());
                assertTrue(resolved.resource().contentLength() > 0);
                try (var bytes = resolved.resource().getInputStream()) { assertNotEquals(-1, bytes.read()); }
            }
        }
        var snapshotItems = items(id);
        assertEquals(expectedItems, snapshotItems.size());
        assertTrue(snapshotItems.stream().allMatch(i -> i.answerSpec() != null));
        Map<UUID, String> placement = placements(id, LEARNER);
        assertEquals(expectedItems, placement.size());
        Map<String, String> answers = new LinkedHashMap<>();
        Map<String, Integer> setPositions = new HashMap<>();
        int expectedCorrect = 0, expectedWrong = 0, expectedBlank = 0;
        for (int n = 0; n < snapshotItems.size(); n++) {
            var item = snapshotItems.get(n);
            Map<String, Object> accepted = item.answerSpec().acceptedAnswers();
            String truth;
            if (accepted.get("unorderedSet") instanceof Map<?, ?> set) {
                List<?> values = (List<?>) set.get("values");
                String setId = MAPPER.writeValueAsString(set);
                int pos = setPositions.merge(setId, 1, Integer::sum) - 1;
                truth = String.valueOf(values.get(pos % values.size()));
            } else {
                var keys = ExamObjectiveScorer.nonBlankAccepted(accepted);
                assertFalse(keys.isEmpty(), "no answer truth");
                truth = keys.get(0);
            }
            if ("ALL_BLANK".equals(scenario) || "MIXED".equals(scenario) && n % 3 == 2) {
                expectedBlank++;
            } else if ("MIXED".equals(scenario) && n % 3 == 1) {
                answers.put(placement.get(item.itemId()), "__qualification_wrong__");
                expectedWrong++;
            } else {
                answers.put(placement.get(item.itemId()), truth);
                expectedCorrect++;
            }
        }
        Map<String, String> batch = new LinkedHashMap<>();
        for (var answer : answers.entrySet()) {
            batch.put(answer.getKey(), answer.getValue());
            if (batch.size() == 50) { save(id, LEARNER, batch); batch.clear(); }
        }
        if (!batch.isEmpty()) save(id, LEARNER, batch);
        assertEquals(answers.size(), attemptRepository.findResponsesByAttemptId(id).size());
        var command = new com.englishcoach.exams.model.ExamAttemptRecords.SubmitAttemptRequest("submit-" + id,
                attempt(id).revision(), com.englishcoach.exams.model.ExamTypes.SubmissionReason.MANUAL, List.of());
        UUID submission = responses.submitAttempt(LEARNER, id, command);
        assertEquals(submission, responses.submitAttempt(LEARNER, id, command));
        var artifact = scoringRepository.findLatestArtifactBySubmissionId(submission).orElseThrow();
        assertTrue(artifact.versionBundle().get("practiceRawScores") instanceof Map<?, ?>);
        assertTrue(scoringRepository.findComponentsByArtifactId(artifact.id()).isEmpty());
        var result = practice.getResult(LEARNER, id);
        assertEquals("SUBMITTED", result.completionStatus());
        assertEquals(expectedItems, result.total());
        assertEquals(expectedCorrect, result.correct());
        assertEquals(expectedWrong, result.incorrect());
        assertEquals(expectedBlank, result.unanswered());
        assertFalse(result.standardizedScoreAvailable());
        String savedSnapshot = MAPPER.writeValueAsString(attempt(id).manifestSnapshot());
        String savedResult = MAPPER.writeValueAsString(result);
        validation.invalidate(form);
        assertEquals(savedResult, MAPPER.writeValueAsString(practice.getResult(LEARNER, id)));
        var review = practice.getReview(LEARNER, id);
        assertEquals("ATTEMPT_SNAPSHOT", review.contentBasis());
        var reviewed = review.groups().stream().flatMap(g -> g.items().stream()).toList();
        assertEquals(expectedItems, reviewed.size());
        assertEquals(expectedCorrect, reviewed.stream().filter(i -> "CORRECT".equals(i.status())).count());
        assertEquals(expectedWrong, reviewed.stream().filter(i -> "INCORRECT".equals(i.status())).count());
        assertEquals(expectedBlank, reviewed.stream().filter(i -> "UNANSWERED".equals(i.status())).count());
        assertTrue(reviewed.stream().allMatch(i -> i.correctAnswerAvailable()));
        assertEquals(savedSnapshot, MAPPER.writeValueAsString(attempt(id).manifestSnapshot()));
    }

    static InputStream openVerifiedMedia(String key) throws IOException {
        var entry = VERIFIED_MEDIA.get(key);
        assertNotNull(entry, "unverified media object");
        if (entry.sourceKind() != ExamMediaImportPlan.SourceKind.RAW_ZIP_MEMBER)
            return Files.newInputStream(Path.of("..").resolve(entry.sourcePath()));
        String[] pieces = entry.sourcePath().split("::", 2);
        var zip = new java.util.zip.ZipFile(Path.of("..").resolve(pieces[0]).toFile());
        try {
            return new FilterInputStream(zip.getInputStream(zip.getEntry(pieces[1]))) {
                @Override public void close() throws IOException { try { super.close(); } finally { zip.close(); } }
            };
        } catch (IOException | RuntimeException error) { zip.close(); throw error; }
    }
}
