package com.englishcoach.exams.practice;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.*;
import com.englishcoach.exams.media.LocalExamObjectStorage;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.service.*;
import org.junit.jupiter.api.*;
import java.nio.file.*;
import java.util.*;
import static com.englishcoach.exams.practice.ExamPracticePostgresTest.*;
import static org.junit.jupiter.api.Assertions.*;

/** Release only one selected family from the fixed registry; preserve existing snapshots. */
class ExamFamilyPracticeReleasePostgresTest {
    static final String BOOK = System.getProperty("exams.release.book");
    @BeforeAll static void setup() throws Exception {
        assertNotNull(BOOK, "exact family selector required");
        assertTrue(BOOK.matches("[a-z0-9]+(?:-[a-z0-9]+)*"));
        ExamPracticePostgresTest.setUp();
        jdbc.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/V73__exams_owner_authorized_production_use.sql")));
    }
    @AfterAll static void close() { if (POOL != null) POOL.close(); if (pg != null) pg.stop(); }
    @Test @SuppressWarnings("unchecked") void selectedFamilyReleaseIsIdempotentAndPreservesHistory() throws Exception {
        Map<String,Object> registry = MAPPER.readValue(getClass().getResourceAsStream("/exams/corpus-practice-release/registry.json"), Map.class);
        var rows = (List<Map<String,Object>>) registry.get("packages");
        var indices = new ArrayList<Integer>();
        for (int i = 0; i < rows.size(); i++) {
            if (String.valueOf(rows.get(i).get("testId")).split("/")[1].equals(BOOK)) indices.add(i);
        }
        assertFalse(indices.isEmpty());
        UUID oldForm = FORMS.get("ETS26_T1");
        String oldScope = practice.getDiagnostics(oldForm).stream().filter(s -> s.ready()).findFirst().orElseThrow().scopeCode();
        UUID oldAttempt = practice.createPracticeAttempt(LEARNER, new ExamPracticeRecords.CreatePracticeAttemptRequest(oldForm, oldScope, null)).attemptId();
        String snapshot = MAPPER.writeValueAsString(attempt(oldAttempt).manifestSnapshot());
        var props = new ExamsProperties();
        props.getStorage().getLocal().setBaseDir(Files.createTempDirectory("exam-family-release-").toString());
        var importer = new ExamContentPackageImporter(contentRepository, new ExamContentPackageValidator(MAPPER));
        importer.setValidationService(validation);
        var rights = new ExamRightsService(contentRepository, new ExamMediaRepository(named, MAPPER), props);
        var publication = new ExamPublicationService(contentRepository, rights, null, validation);
        var storage = new LocalExamObjectStorage(props);
        var service = new ExamCorpusPracticeReleaseService(MAPPER, named, importer, publication, practice, storage);
        for (int index : indices) {
            try (var input = getClass().getResourceAsStream("/exams/corpus-practice-release/" + rows.get(index).get("file"))) {
                var pkg = MAPPER.readValue(input, ExamContentPackage.class);
                var mediaPlan = com.englishcoach.exams.release.ExamMediaImportPlan.plan(pkg, Path.of(".."), true);
                for (var entry : mediaPlan.entries()) {
                    assertTrue(entry.ready(), "release test media must be byte verified");
                    ExamCorpusQualificationPostgresTest.VERIFIED_MEDIA.put(entry.storageObjectKey(), entry);
                    try (var bytes = ExamCorpusQualificationPostgresTest.openVerifiedMedia(entry.storageObjectKey())) {
                        storage.putObject(entry.storageObjectKey(), bytes.readAllBytes(), entry.mimeType());
                    }
                }
            }
            var receipt = service.releaseQualifiedPackage(1L, index);
            assertEquals(1, receipt.size());
            UUID form = (UUID) receipt.getFirst().get("formId");
            Set<String> expected = new TreeSet<>((List<String>) rows.get(index).get("scopeCodes"));
            Set<String> actual = new TreeSet<>();
            for (var scope : practice.getDiagnostics(form)) {
                assertTrue(scope.ready()); actual.add(scope.scopeCode());
                for (String scenario : List.of("ALL_CORRECT", "ALL_BLANK", "MIXED"))
                    ExamCorpusQualificationPostgresTest.qualify(form, scope.scopeCode(), scenario, scope.questionCount());
            }
            assertEquals(expected, actual);
            assertEquals("ALREADY_IMPORTED", service.releaseQualifiedPackage(1L, index).getFirst().get("operation"));
        }
        assertEquals(indices.size(), jdbc.queryForObject("SELECT COUNT(*) FROM exams.project_usage_authorizations WHERE import_basis='OWNER_AUTHORIZED_PRODUCTION_USE'", Integer.class));
        assertEquals(snapshot, MAPPER.writeValueAsString(attempt(oldAttempt).manifestSnapshot()));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM exams.content_reviews", Integer.class));
    }
}
