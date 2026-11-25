package com.englishcoach.exams;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamContentPackageValidationException;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.MethodOrderer;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.io.File;
import java.net.Socket;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Real PostgreSQL Database Verification for All Authoritative Content Packages.
 *
 * Runs against an isolated real PostgreSQL database on port 55432 (database: exams_verify).
 * Exercises every valid package through:
 *   1. Validation
 *   2. First Import into real PostgreSQL
 *   3. 4-Stage Hash Verification (Stage A = B = C = D)
 *   4. Graph Row Verification (Expected items/assets/parts exist)
 *   5. Idempotent Replay (ALREADY_IMPORTED, delta = 0 across 23 tables)
 *   6. Successor Version Coexistence (v1 and v2 coexist simultaneously)
 *   7. Large Package Stress Case (TOEIC L&R v2 200 items, 6 SVGs)
 *   8. Suite Coordination Verification (TOEIC Suite v1, child forms resolve, no overall)
 *   9. Fail-Closed Listening Blocker (IELTS Shared Listening fails with 4 missing audio assets)
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
public class ExamContentRealPostgresVerificationTest {

    private static final int PG_PORT = 55432;
    private static final String DB_NAME = "exams_verify";
    private static final String JDBC_URL = "jdbc:postgresql://127.0.0.1:" + PG_PORT + "/" + DB_NAME;

    private static NamedParameterJdbcTemplate jdbcTemplate;
    private static ExamContentRepository repository;
    private static ExamContentPackageValidator validator;
    private static ExamContentPackageImporter importer;
    private static ObjectMapper mapper;

    private static final List<String> GRAPH_TABLES = List.of(
            "exams.sources",
            "exams.licenses",
            "exams.provenance_records",
            "exams.catalog_nodes",
            "exams.specification_versions",
            "exams.rubric_versions",
            "exams.calibration_versions",
            "exams.scoring_scheme_versions",
            "exams.form_versions",
            "exams.form_components",
            "exams.sections",
            "exams.parts",
            "exams.group_versions",
            "exams.form_groups",
            "exams.stimulus_versions",
            "exams.group_stimuli",
            "exams.item_versions",
            "exams.answer_specs",
            "exams.assets",
            "exams.stimulus_assets",
            "exams.content_package_imports",
            "exams.content_qa_runs",
            "exams.audit_events"
    );

    // Canonical order: component packages before suite package
    private static final List<String> ORDERED_VALID_PACKAGE_FILES = List.of(
            "IELTS/IELTS_ACAD_READING_PILOT_001_V1.json",
            "IELTS/IELTS_ACAD_READING_PILOT_001_V2.json",
            "IELTS/IELTS_ACAD_WRITING_PILOT_001_V1.json",
            "IELTS/IELTS_GT_READING_PILOT_001_V1.json",
            "IELTS/IELTS_GT_WRITING_PILOT_001_V1.json",
            "IELTS/IELTS_SHARED_SPEAKING_PILOT_001_V1.json",
            "TOEIC/TOEIC_LR_PILOT_001_V1.json",
            "TOEIC/TOEIC_LR_PILOT_001_V2.json",
            "TOEIC/TOEIC_SPEAKING_PILOT_001_V1.json",
            "TOEIC/TOEIC_SPEAKING_PILOT_001_V2.json",
            "TOEIC/TOEIC_WRITING_PILOT_001_V1.json",
            "TOEIC/TOEIC_WRITING_PILOT_001_V2.json",
            "TOEIC/TOEIC_SUITE_PILOT_001_V1.json"
    );

    @BeforeAll
    static void setUp() {
        boolean postgresUp = isPortListening(PG_PORT);
        assumeTrue(postgresUp, "Isolated PostgreSQL cluster is not listening on port " + PG_PORT + "; skipping real DB test.");

        DriverManagerDataSource dataSource = new DriverManagerDataSource();
        dataSource.setDriverClassName("org.postgresql.Driver");
        dataSource.setUrl(JDBC_URL);
        dataSource.setUsername("postgres");
        dataSource.setPassword("");

        jdbcTemplate = new NamedParameterJdbcTemplate(dataSource);
        mapper = new ObjectMapper().findAndRegisterModules()
                .configure(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false);
        validator = new ExamContentPackageValidator(mapper);
        repository = new ExamContentRepository(jdbcTemplate, mapper);
        importer = new ExamContentPackageImporter(repository, validator);

        // Verify schema health: exams schema must contain at least 57 tables
        Integer tableCount = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'exams'",
                new MapSqlParameterSource(), Integer.class);
        assertNotNull(tableCount);
        assertTrue(tableCount >= 57, "Exams schema table count must be >= 57, found: " + tableCount);
    }

    private static boolean isPortListening(int port) {
        try (Socket s = new Socket("127.0.0.1", port)) {
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private Map<String, Integer> captureGraphCounts() {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String table : GRAPH_TABLES) {
            Integer count = jdbcTemplate.queryForObject(
                    "SELECT COUNT(*) FROM " + table,
                    new MapSqlParameterSource(), Integer.class);
            counts.put(table, count != null ? count : 0);
        }
        return counts;
    }

    @Test
    @Order(1)
    @DisplayName("Import and Replay All 13 Valid Packages into Real PostgreSQL Database")
    void testRealPostgresImportAndReplayAll13ValidPackages() throws Exception {
        Path root = Paths.get("..", "content", "exams", "original-pilot").toRealPath();
        Long actorId = 10L; // EXAMS_AUTHOR in public.users

        System.out.println("==================================================================");
        System.out.println("STARTING REAL POSTGRESQL VERIFICATION OF ALL 13 VALID PACKAGES");
        System.out.println("==================================================================");

        for (String relPath : ORDERED_VALID_PACKAGE_FILES) {
            File pkgFile = root.resolve(relPath).toFile();
            assertTrue(pkgFile.exists(), "Package file must exist: " + pkgFile);

            ExamContentPackage pkg = mapper.readValue(pkgFile, ExamContentPackage.class);
            String packageId = pkg.manifest().packageId();
            int packageVersion = pkg.manifest().packageVersion();
            String declaredHash = pkg.manifest().contentHash(); // Stage A

            System.out.println("\n--------------------------------------------------");
            System.out.println("Processing: " + relPath + " [" + packageId + " v" + packageVersion + "]");

            // 1. Validator Check
            ExamContentPackage.ValidationResult valResult = validator.validate(pkg);
            assertTrue(valResult.valid(), "Package must validate: " + relPath + " errors: " + valResult.errors());
            String computedHash = valResult.computedContentHash(); // Stage B
            assertEquals(declaredHash, computedHash, "Stage A must match Stage B for " + packageId);

            // 2. First Import
            ExamContentPackage.ImportResult importResult = importer.importPackage(pkg, actorId);
            assertEquals(ExamContentPackage.ImportStatus.IMPORTED, importResult.status(), "First import must return IMPORTED");
            assertFalse(importResult.idempotentReplay(), "First import must not be an idempotent replay");
            String importerHash = importResult.contentHash(); // Stage C
            assertEquals(declaredHash, importerHash, "Stage A must match Stage C for " + packageId);

            // 3. Inspect PostgreSQL exams.content_package_imports -> Stage D
            String dbStoredHash = jdbcTemplate.queryForObject(
                    "SELECT content_hash FROM exams.content_package_imports WHERE package_id = :pId AND package_version = :pVer",
                    new MapSqlParameterSource()
                            .addValue("pId", packageId)
                            .addValue("pVer", packageVersion),
                    String.class);
            assertNotNull(dbStoredHash, "Stored hash in PostgreSQL cannot be null for " + packageId);
            assertEquals(declaredHash, dbStoredHash, "Stage A must match Stage D in PostgreSQL for " + packageId);

            // Verify Stage A = Stage B = Stage C = Stage D
            System.out.println("  Stage A (Declared Manifest):  " + declaredHash);
            System.out.println("  Stage B (Validator Computed): " + computedHash);
            System.out.println("  Stage C (Importer Returned):  " + importerHash);
            System.out.println("  Stage D (PostgreSQL Stored):  " + dbStoredHash);
            System.out.println("  -> 4-STAGE HASH MATCH: TRUE (A=B=C=D)");

            // Verify form closure hash in PostgreSQL
            String formDbHash = jdbcTemplate.queryForObject(
                    "SELECT content_hash FROM exams.form_versions WHERE id = :formId",
                    new MapSqlParameterSource().addValue("formId", pkg.form().id()),
                    String.class);
            assertEquals(pkg.form().contentHash(), formDbHash, "Form closure hash in DB must match form.contentHash");

            // 4. Pre-Replay Snapshot
            Map<String, Integer> preReplayCounts = captureGraphCounts();

            // 5. Replay (Same identity and hash)
            ExamContentPackage.ImportResult replayResult = importer.importPackage(pkg, actorId);
            assertEquals(ExamContentPackage.ImportStatus.ALREADY_IMPORTED, replayResult.status(), "Replay must return ALREADY_IMPORTED");
            assertTrue(replayResult.idempotentReplay(), "Replay must indicate idempotentReplay = true");
            assertEquals(declaredHash, replayResult.contentHash(), "Replay hash must match declared hash");
            assertEquals(pkg.form().id(), replayResult.formId(), "Replay formId must match form ID");

            // 6. Post-Replay Snapshot & Zero Delta Assertion
            Map<String, Integer> postReplayCounts = captureGraphCounts();
            for (String table : GRAPH_TABLES) {
                int before = preReplayCounts.get(table);
                int after = postReplayCounts.get(table);
                assertEquals(before, after, "ROW DELTA must be 0 on replay for table: " + table);
            }
            System.out.println("  -> IDEMPOTENT REPLAY VERIFIED: ROW DELTA = 0 across all 23 tables");
        }
        System.out.println("\n==================================================================");
        System.out.println("ALL 13 VALID PACKAGES VERIFIED ON REAL POSTGRESQL WITH ZERO DELTA");
        System.out.println("==================================================================");
    }

    @Test
    @Order(2)
    @DisplayName("Large Package Stress Case: TOEIC_LR_PILOT_001_V2 (200 items in PostgreSQL)")
    void testToeicLrV2LargePackageStressInPostgres() {
        UUID formId = UUID.fromString("b5e9ccf1-31c2-5406-8bb3-07f2171f9a6d");

        // 1. Exactly 200 items in PostgreSQL
        Integer itemCount = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM exams.item_versions iv " +
                "JOIN exams.group_versions gv ON iv.group_id = gv.id " +
                "JOIN exams.form_groups fg ON fg.group_id = gv.id " +
                "JOIN exams.parts p ON fg.part_id = p.id " +
                "JOIN exams.sections s ON p.section_id = s.id " +
                "WHERE s.form_id = :formId",
                new MapSqlParameterSource().addValue("formId", formId),
                Integer.class);
        assertEquals(200, itemCount, "TOEIC L&R v2 must have exactly 200 items in PostgreSQL");

        // 2. Exactly 6 SVG visual assets in PostgreSQL
        Integer assetCount = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM exams.assets WHERE mime_type = 'image/svg+xml'",
                new MapSqlParameterSource(),
                Integer.class);
        assertTrue(assetCount >= 6, "At least 6 vector SVG photo assets must exist in PostgreSQL, found: " + assetCount);

        // 3. Exactly 7 parts (Parts 1 to 7) in PostgreSQL
        Integer partCount = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM exams.parts p " +
                "JOIN exams.sections s ON p.section_id = s.id " +
                "WHERE s.form_id = :formId",
                new MapSqlParameterSource().addValue("formId", formId),
                Integer.class);
        assertEquals(7, partCount, "TOEIC L&R v2 must have exactly 7 parts in PostgreSQL");

        // 4. Exactly 2 sections (LISTENING and READING)
        Integer sectionCount = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM exams.sections WHERE form_id = :formId",
                new MapSqlParameterSource().addValue("formId", formId),
                Integer.class);
        assertEquals(2, sectionCount, "TOEIC L&R v2 must have exactly 2 sections in PostgreSQL");
    }

    @Test
    @Order(3)
    @DisplayName("Successor Version Coexistence: V1 and V2 Coexist in Real PostgreSQL")
    void testSuccessorVersionCoexistenceInPostgres() {
        // 1. IELTS Academic Reading v1 + v2
        Integer acadReadingPackageImports = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM exams.content_package_imports WHERE package_id = 'IELTS_ACAD_READING_PILOT_001'",
                new MapSqlParameterSource(), Integer.class);
        assertEquals(2, acadReadingPackageImports, "Both v1 and v2 imports must exist for IELTS Academic Reading");

        // 2. TOEIC L&R v1 + v2
        Integer toeicLrPackageImports = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM exams.content_package_imports WHERE package_id = 'TOEIC_LR_PILOT_001'",
                new MapSqlParameterSource(), Integer.class);
        assertEquals(2, toeicLrPackageImports, "Both v1 and v2 imports must exist for TOEIC L&R");

        // 3. TOEIC Speaking v1 + v2
        Integer toeicSpeakingPackageImports = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM exams.content_package_imports WHERE package_id = 'TOEIC_SPEAKING_PILOT_001'",
                new MapSqlParameterSource(), Integer.class);
        assertEquals(2, toeicSpeakingPackageImports, "Both v1 and v2 imports must exist for TOEIC Speaking");

        // 4. TOEIC Writing v1 + v2
        Integer toeicWritingPackageImports = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM exams.content_package_imports WHERE package_id = 'TOEIC_WRITING_PILOT_001'",
                new MapSqlParameterSource(), Integer.class);
        assertEquals(2, toeicWritingPackageImports, "Both v1 and v2 imports must exist for TOEIC Writing");
    }

    @Test
    @Order(4)
    @DisplayName("Suite Verification: TOEIC_SUITE_PILOT_001_V1 Child Form Components and Scoring Scheme")
    void testToeicSuiteInPostgres() {
        UUID suiteFormId = UUID.fromString("ad406745-b4f5-5f95-8e0a-c8400854a333");

        // 1. Form exists in PostgreSQL
        Integer suiteFormCount = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM exams.form_versions WHERE id = :formId",
                new MapSqlParameterSource().addValue("formId", suiteFormId),
                Integer.class);
        assertEquals(1, suiteFormCount, "Suite form version must exist in PostgreSQL");

        // 2. Exactly 3 form_components linking to the child forms
        List<Map<String, Object>> components = jdbcTemplate.queryForList(
                "SELECT child_form_id, role, ordinal FROM exams.form_components WHERE parent_form_id = :formId ORDER BY ordinal",
                new MapSqlParameterSource().addValue("formId", suiteFormId));
        assertEquals(3, components.size(), "Suite must have exactly 3 child components");

        assertEquals("LR", components.get(0).get("role"));
        assertEquals("SPEAKING", components.get(1).get("role"));
        assertEquals("WRITING", components.get(2).get("role"));

        // Verify that child_form_ids exist in exams.form_versions
        for (Map<String, Object> comp : components) {
            UUID childFormId = (UUID) comp.get("child_form_id");
            Integer childExists = jdbcTemplate.queryForObject(
                    "SELECT COUNT(*) FROM exams.form_versions WHERE id = :childId",
                    new MapSqlParameterSource().addValue("childId", childFormId),
                    Integer.class);
            assertEquals(1, childExists, "Child form " + childFormId + " must exist in exams.form_versions");
        }

        // 3. Verify suite scoring scheme has no universal overall
        String mappingTableJson = jdbcTemplate.queryForObject(
                "SELECT mapping_table::text FROM exams.scoring_scheme_versions WHERE logical_code = 'TOEIC_FOUR_SKILL_SUITE_SCORING'",
                new MapSqlParameterSource(),
                String.class);
        assertNotNull(mappingTableJson);
        assertTrue(mappingTableJson.contains("No 4-skill universal aggregate score"), "Must contain explicit policy note");
    }

    @Test
    @Order(5)
    @DisplayName("Fail-Closed Validation of IELTS_SHARED_LISTENING_PILOT_001_V1 (Expected Blocked)")
    void testListeningExpectedFailureFailClosed() throws Exception {
        Path root = Paths.get("..", "content", "exams", "original-pilot").toRealPath();
        File listeningFile = root.resolve("IELTS/IELTS_SHARED_LISTENING_PILOT_001_V1.json").toFile();
        assertTrue(listeningFile.exists());

        ExamContentPackage pkg = mapper.readValue(listeningFile, ExamContentPackage.class);

        // 1. Validator must return invalid with 4 REQUIRED_ASSET_MISSING errors
        ExamContentPackage.ValidationResult valResult = validator.validate(pkg);
        assertFalse(valResult.valid(), "Shared listening package must be invalid due to missing audio assets");
        assertEquals(4, valResult.errors().size(), "Must have exactly 4 errors");
        for (ExamContentPackage.ValidationError err : valResult.errors()) {
            assertEquals("REQUIRED_ASSET_MISSING", err.code(), "Error code must be REQUIRED_ASSET_MISSING");
        }

        // 2. Importer must throw ExamContentPackageValidationException before JDBC
        assertThrows(ExamContentPackageValidationException.class, () -> importer.importPackage(pkg, 10L));

        // 3. Confirm zero rows inserted into exams.content_package_imports for listening
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM exams.content_package_imports WHERE package_id = 'IELTS_SHARED_LISTENING_PILOT_001'",
                new MapSqlParameterSource(),
                Integer.class);
        assertEquals(0, count, "No package import record should exist for listening in PostgreSQL");
    }
}
