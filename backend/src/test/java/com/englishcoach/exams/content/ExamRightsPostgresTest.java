package com.englishcoach.exams.content;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.ExamContentPackageImporter.ImportRightsBasis;
import com.englishcoach.exams.content.ExamRightsDecisionPolicy.*;
import com.englishcoach.exams.practice.ExamPracticeRecords.PracticeScopeDiagnosticDto;
import com.englishcoach.exams.practice.ExamPracticeService;
import com.englishcoach.exams.repository.*;
import com.englishcoach.exams.repository.ExamContentRepository.RightsClosureRow;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.validation.ExamContentValidationRepository;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Pre-Phase-8 rights checkpoint on an isolated PostgreSQL 17 Testcontainer (never the dev or production database):
 * exams migrations V1–V10 + drift shape + V71 + V72 (local). The staged ETS 2026 T1 package is imported with the
 * owner-authorized LOCAL dry-run basis; the test then proves that the persisted V72 authorization and licence closure
 * are LOADED, judged by the canonical {@link ExamRightsDecisionPolicy}, agree with the staging gate, and that every
 * production basis stays fail-closed (publisher basis, publication, production importer). Read-only after the import;
 * nothing is approved, published or written to the corpus. Skips without Docker or the local staged package.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamRightsPostgresTest {

    private static final Path MIGRATIONS = Path.of("src/main/resources/db/migration/exams");
    private static final Path STAGING = Path.of("..", "imports", "exams", "staging");
    private static final String ETS = "extracted/toeic/ets/ets-2026/ets-2026__test-1.json";
    private static final String CAM = "extracted/ielts/cambridge/cambridge-ielts-17/cambridge-ielts-17__test-1.json";

    static PostgreSQLContainer<?> pg;
    static com.zaxxer.hikari.HikariDataSource POOL;
    static JdbcTemplate jdbc;
    static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    static ExamContentRepository contentRepository;
    static ExamMediaRepository mediaRepository;
    static ExamContentValidationService validation;
    static ExamContentValidationRepository treeRepository;
    static ExamContentPackage etsPkg, camPkg;
    static UUID formId;
    static ExamRightsService springRights, ownerRights;

    @BeforeAll
    static void setUp() throws Exception {
        assumeTrue(Files.isRegularFile(STAGING.resolve(ETS)) && Files.isRegularFile(STAGING.resolve(CAM)), "staged packages not present (local data)");
        etsPkg = MAPPER.readValue(STAGING.resolve(ETS).toFile(), ExamContentPackage.class);
        camPkg = MAPPER.readValue(STAGING.resolve(CAM).toFile(), ExamContentPackage.class);
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker not available — rights checkpoint skipped");
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        // Exams Phase 9H: pooled (one TCP connection per statement exhausted Windows ephemeral ports in batch runs)
        POOL = com.englishcoach.exams.ExamTestDataSources.pooled(pg);
        javax.sql.DataSource ds = POOL;
        jdbc = new JdbcTemplate(ds);
        NamedParameterJdbcTemplate named = new NamedParameterJdbcTemplate(ds);
        jdbc.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, email VARCHAR(255)); "
                + "INSERT INTO public.users VALUES (1, 'operator@example.test');");
        for (String v : List.of("V1__content.sql", "V2__runtime.sql", "V3__scoring_profile.sql", "V4__integrity_operations.sql",
                "V5__content_factory.sql", "V6__exams_measurement_pipeline.sql", "V7__exams_profile_production_eligibility.sql",
                "V8__exams_content_import_compatibility.sql", "V9__exams_form_components_role_expansion.sql",
                "V10__exams_runtime_v4_turns_and_evidence.sql")) {
            jdbc.execute(Files.readString(MIGRATIONS.resolve(v)));
        }
        jdbc.execute("ALTER TABLE exams.sections ADD COLUMN is_runnable BOOLEAN; "
                + "ALTER TABLE exams.sections ADD COLUMN health_status VARCHAR(32); "
                + "ALTER TABLE exams.form_versions ADD COLUMN primary_health_status VARCHAR(32); "
                + "ALTER TABLE exams.item_versions ADD COLUMN ordinal INTEGER;");
        jdbc.execute(Files.readString(MIGRATIONS.resolve("V71__exams_content_validation_truth.sql")));
        jdbc.execute(Files.readString(MIGRATIONS.resolve("V72__exams_project_usage_authorization.sql")));

        contentRepository = new ExamContentRepository(named, MAPPER);
        mediaRepository = new ExamMediaRepository(named, MAPPER);
        treeRepository = new ExamContentValidationRepository(named, MAPPER);
        StaticListableBeanFactory beans = new StaticListableBeanFactory(Map.of("tm", new DataSourceTransactionManager(ds)));
        validation = new ExamContentValidationService(treeRepository, MAPPER, beans.getBeanProvider(PlatformTransactionManager.class));
        ExamContentPackageImporter importer = new ExamContentPackageImporter(contentRepository, new ExamContentPackageValidator(MAPPER));
        importer.setValidationService(validation);
        importer.setOwnerAuthorizedDryRunEnabled(true);
        formId = importer.importPackage(etsPkg, 1L, ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN).formId();
        jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'PILOT' WHERE id = ?", formId);
        validation.invalidate(formId);

        ExamsProperties props = new ExamsProperties();
        springRights = new ExamRightsService(contentRepository, mediaRepository, props);
        ownerRights = ExamRightsService.ownerAuthorizedLocalRuntime(contentRepository, mediaRepository, props);
    }

    @AfterAll
    static void tearDown() {
        if (POOL != null) POOL.close();
        if (pg != null) pg.stop();
    }

    static List<String> licenceTruth() {
        return jdbc.queryForList("SELECT provenance_category || '/' || legal_status || '/' || permitted_purposes::text "
                + "FROM exams.licenses ORDER BY id", String.class);
    }

    @Test
    @Order(1)
    @DisplayName("11/12: V72 authorization persisted AND loaded; the licence closure projection carries the publisher facts")
    void factsPersistedAndLoaded() {
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM exams.project_usage_authorizations WHERE form_id = ?",
                Integer.class, formId));
        var recorded = contentRepository.findLatestProjectUsageAuthorization(formId).orElseThrow();
        assertEquals(ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS, recorded.importBasis());
        ProjectAuthorizationFacts facts = ProjectAuthorizationFacts.fromMetadata(recorded.metadata(), recorded.importBasis());
        assertTrue(facts.present() && facts.wellFormed() && facts.authorizesLocalUse(), "persisted block is well formed");
        assertTrue(facts.sourceBoundToRawCorpus(), "persisted source provenance points into imports/source-files/");
        assertEquals("NOT_ESTABLISHED", facts.publisherLicence());
        assertFalse(facts.publisherEndorsement());

        List<RightsClosureRow> closure = contentRepository.findRightsClosureForForm(formId);
        assertFalse(closure.isEmpty());
        assertTrue(closure.stream().allMatch(r -> r.provenanceRowPresent() && r.licenceRowPresent()));
        assertTrue(closure.stream().anyMatch(r -> "UNKNOWN".equals(r.provenanceCategory()) && "PENDING".equals(r.legalStatus())
                && r.permittedPurposeKeys().equals(Set.of("LOCAL_PRIVATE_REVIEW"))), "staged publisher licence facts projected");
        assertTrue(contentRepository.findLatestProjectUsageAuthorization(UUID.randomUUID()).isEmpty());
    }

    @Test
    @Order(2)
    @DisplayName("01/13: explicit LOCAL owner basis → learner runtime allowed from persisted facts; Practice scopes see it")
    void ownerBasisAllowsRuntime() {
        Decision d = ownerRights.evaluateFormRights(formId, Operation.LEARNER_RUNTIME).orElseThrow();
        assertTrue(d.allowed(), d.toString());
        assertEquals(Reason.OWNER_AUTHORIZED_LOCAL_USE, d.reason());
        assertEquals("OWNER_PROJECT_AUTHORIZATION", d.grantedBy());
        Map<String, List<String>> ownerScopes = scopes(ownerRights);
        assertTrue(ownerScopes.values().stream().noneMatch(c -> c.contains("RIGHTS_OR_PROVENANCE_UNVERIFIED")), ownerScopes.toString());
        assertTrue(ownerScopes.get("TOEIC_PART_5").isEmpty(), "Part 5 practisable on persisted facts: " + ownerScopes.get("TOEIC_PART_5"));
    }

    @Test
    @Order(3)
    @DisplayName("03/04/05: publisher basis (the Spring bean) and PUBLICATION stay fail-closed on the same persisted form")
    void productionBasisFailClosed() {
        for (Operation op : Operation.values()) assertFalse(springRights.verifyFormRights(formId, op), op.name());
        assertEquals(Reason.PUBLISHER_LICENCE_NOT_ESTABLISHED,
                springRights.evaluateFormRights(formId, Operation.LEARNER_RUNTIME).orElseThrow().reason());
        assertFalse(ownerRights.verifyFormRights(formId, Operation.PUBLICATION));
        assertEquals(Reason.OWNER_AUTHORIZATION_NOT_A_PUBLICATION_BASIS,
                ownerRights.evaluateFormRights(formId, Operation.PUBLICATION).orElseThrow().reason());
        Map<String, List<String>> springScopes = scopes(springRights);
        assertFalse(springScopes.isEmpty());
        assertTrue(springScopes.values().stream().allMatch(c -> c.contains("RIGHTS_OR_PROVENANCE_UNVERIFIED")),
                "publisher basis: no owner-corpus scope is practisable");
    }

    @Test
    @Order(4)
    @DisplayName("14: the persisted runtime decision equals the staging gate decision for the same package")
    void stagingAndPersistedAgree() {
        List<String> packageCodes = new ExamContentPackageValidator(MAPPER).validate(etsPkg).errors().stream()
                .map(ExamContentPackage.ValidationError::code).toList();
        var staging = ExamProjectUsageAuthorization.stagingRightsGate(etsPkg, packageCodes);
        Decision persisted = ownerRights.evaluateFormRights(formId, Operation.LEARNER_RUNTIME).orElseThrow();
        assertEquals(staging.cleared(), persisted.allowed());
        assertEquals(staging.publisherRightsCodes(), persisted.publisherRightsCodes());
        assertEquals(staging.unclearedRightsCodes(), persisted.unclearedRightsCodes());
        assertEquals(staging.ownerAuthorized(), persisted.ownerAuthorized());
        assertEquals(staging.sourceBoundToRawCorpus(), persisted.sourceBoundToRawCorpus());
    }

    @Test
    @Order(5)
    @DisplayName("06/07/08: evaluation rewrites nothing — publisher licence stays UNKNOWN / PENDING / LOCAL_PRIVATE_REVIEW")
    void publisherTruthUnchanged() {
        List<String> before = licenceTruth();
        ownerRights.verifyFormRights(formId);
        springRights.verifyFormRights(formId);
        assertEquals(before, licenceTruth());
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM exams.licenses WHERE provenance_category = 'LICENSED'", Integer.class));
        assertTrue(before.stream().anyMatch(s -> s.startsWith("UNKNOWN/PENDING/") && s.contains("LOCAL_PRIVATE_REVIEW")));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM exams.form_versions WHERE lifecycle_state = 'PUBLISHED'", Integer.class));
    }

    @Test
    @Order(6)
    @DisplayName("10: V72 refuses a malformed authorization (status / publisher licence / endorsement / import basis)")
    void malformedAuthorizationRefusedByDatabase() {
        UUID source = jdbc.queryForObject("SELECT source_id FROM exams.project_usage_authorizations WHERE form_id = ?", UUID.class, formId);
        for (String[] bad : List.of(new String[]{"LICENSED", "NOT_ESTABLISHED", "FALSE", ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS},
                new String[]{"OWNER_AUTHORIZED", "LICENSED", "FALSE", ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS},
                new String[]{"OWNER_AUTHORIZED", "NOT_ESTABLISHED", "TRUE", ExamRightsDecisionPolicy.LOCAL_DRY_RUN_IMPORT_BASIS},
                new String[]{"OWNER_AUTHORIZED", "NOT_ESTABLISHED", "FALSE", "PRODUCTION"})) {
            assertThrows(Exception.class, () -> jdbc.update("INSERT INTO exams.project_usage_authorizations (package_id, package_version, "
                    + "package_content_hash, form_id, source_id, status, scope, authorized_by, decision_date, production_import, import_basis, "
                    + "publisher_licence, publisher_endorsement, source_identity, source_provenance) VALUES ('X', 9, ?, ?, ?, ?, 'S', 'O', "
                    + "DATE '2026-10-03', 'NO', ?, ?, " + bad[2] + ", '{}'::jsonb, '{}'::jsonb)",
                    "c".repeat(64), formId, source, bad[0], bad[3], bad[1]), Arrays.toString(bad));
        }
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM exams.project_usage_authorizations", Integer.class));
    }

    @Test
    @Order(7)
    @DisplayName("18/19: production importer still refuses the staged owner corpus; the local dry run needs its explicit switch")
    void productionImporterStillRefuses() {
        int forms = jdbc.queryForObject("SELECT COUNT(*) FROM exams.form_versions", Integer.class);
        ExamContentPackageImporter production = new ExamContentPackageImporter(contentRepository, new ExamContentPackageValidator(MAPPER));
        assertThrows(ExamContentPackageValidationException.class,
                () -> production.importPackage(camPkg, 1L, ImportRightsBasis.PUBLISHER_LICENCE));
        IllegalStateException disabled = assertThrows(IllegalStateException.class,
                () -> production.importPackage(camPkg, 1L, ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN));
        assertTrue(disabled.getMessage().startsWith("CONTENT_IMPORT_BASIS_DISABLED"));
        assertEquals(forms, jdbc.queryForObject("SELECT COUNT(*) FROM exams.form_versions", Integer.class), "nothing written");
        List<String> codes = new ExamContentPackageValidator(MAPPER).validate(camPkg).errors().stream()
                .map(ExamContentPackage.ValidationError::code).toList();
        assertTrue(codes.contains("RIGHTS_NOT_APPROVED") && codes.contains("RIGHTS_CATEGORY_FORBIDDEN"),
                "the production basis sees the truthful publisher gaps");
    }

    static Map<String, List<String>> scopes(ExamRightsService rights) {
        ExamPracticeService practice = new ExamPracticeService(contentRepository, new ExamAttemptRepository(
                new NamedParameterJdbcTemplate(jdbc.getDataSource()), MAPPER), validation, treeRepository, rights,
                null, new ExamObjectiveScorer(new ExamAnswerNormalizer()), MAPPER);
        Map<String, List<String>> out = new LinkedHashMap<>();
        for (PracticeScopeDiagnosticDto d : practice.getDiagnostics(formId)) out.put(d.scopeCode(), d.reasonCodes());
        return out;
    }
}
