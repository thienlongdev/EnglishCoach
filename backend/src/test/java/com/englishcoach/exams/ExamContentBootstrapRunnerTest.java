package com.englishcoach.exams;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.ExamContentBootstrapService;
import com.englishcoach.exams.content.ExamContentBootstrapService.BootstrapSummary;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.net.Socket;
import java.net.URI;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

public class ExamContentBootstrapRunnerTest {

    // Allow the full migration suite to use a disposable local schema instead of writing the ambient dev database.
    private static final String JDBC_URL = System.getProperty("test.db.url", "jdbc:postgresql://localhost:5432/english_coach");
    private static final URI DATABASE_URI = URI.create(JDBC_URL.replaceFirst("^jdbc:", ""));
    private static final int PG_PORT = DATABASE_URI.getPort() < 0 ? 5432 : DATABASE_URI.getPort();

    private static NamedParameterJdbcTemplate jdbcTemplate;
    private static ExamContentBootstrapService bootstrapService;

    @BeforeAll
    static void setUp() {
        if (!List.of("localhost", "127.0.0.1", "::1").contains(DATABASE_URI.getHost())) {
            throw new IllegalArgumentException("Bootstrap tests require a loopback disposable database");
        }
        boolean postgresUp = isPortListening(PG_PORT);
        assumeTrue(postgresUp, "PostgreSQL is not listening on port " + PG_PORT);

        DriverManagerDataSource dataSource = new DriverManagerDataSource();
        dataSource.setDriverClassName("org.postgresql.Driver");
        dataSource.setUrl(JDBC_URL);
        dataSource.setUsername("postgres");
        dataSource.setPassword("postgres");

        jdbcTemplate = new NamedParameterJdbcTemplate(dataSource);
        ObjectMapper mapper = new ObjectMapper().findAndRegisterModules()
                .configure(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false);
        ExamContentPackageValidator validator = new ExamContentPackageValidator(mapper);
        ExamContentRepository repository = new ExamContentRepository(jdbcTemplate, mapper);
        ExamContentPackageImporter importer = new ExamContentPackageImporter(repository, validator);
        ExamsProperties properties = new ExamsProperties();
        properties.setStrictMode(false); // internal/pilot mode

        bootstrapService = new ExamContentBootstrapService(repository, validator, importer, properties, mapper);
    }

    private static boolean isPortListening(int port) {
        try (Socket s = new Socket("127.0.0.1", port)) {
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @Test
    @Order(1)
    @DisplayName("Run deterministic bootstrap and verify idempotency on PostgreSQL")
    void runDeterministicBootstrapAndVerifyIdempotency() throws Exception {
        // Run 1: Bootstrap all canonical packages
        BootstrapSummary summary1 = bootstrapService.bootstrapCanonicalPackages(10L);
        assertNotNull(summary1);
        assertEquals(ExamContentBootstrapService.CANONICAL_PILOT_PACKAGES.size(), summary1.getTotalPackages());
        System.out.println("Bootstrap Run 1 Complete: " + summary1.getTotalPackages() + " packages processed.");

        // Snapshot counts
        Integer formsCount1 = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.form_versions", new MapSqlParameterSource(), Integer.class);
        Integer sectionsCount1 = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.sections", new MapSqlParameterSource(), Integer.class);
        Integer itemsCount1 = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.item_versions", new MapSqlParameterSource(), Integer.class);
        Integer catalogNodes1 = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.catalog_nodes", new MapSqlParameterSource(), Integer.class);
        Integer importsCount1 = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.content_package_imports", new MapSqlParameterSource(), Integer.class);

        System.out.println("POST-BOOTSTRAP DATABASE STATE:");
        System.out.println("  form_versions:          " + formsCount1);
        System.out.println("  sections:               " + sectionsCount1);
        System.out.println("  item_versions:          " + itemsCount1);
        System.out.println("  catalog_nodes:          " + catalogNodes1);
        System.out.println("  content_package_imports:" + importsCount1);

        // Run 2: Idempotent replay
        BootstrapSummary summary2 = bootstrapService.bootstrapCanonicalPackages(10L);
        assertNotNull(summary2);
        assertEquals(0, summary2.getNewlyImported(), "Run 2 must not import new packages");
        assertEquals(summary1.getTotalPackages(), summary2.getAlreadyImported(), "All packages must be ALREADY_IMPORTED");

        // Verify zero row delta
        Integer formsCount2 = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.form_versions", new MapSqlParameterSource(), Integer.class);
        Integer sectionsCount2 = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.sections", new MapSqlParameterSource(), Integer.class);
        Integer itemsCount2 = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.item_versions", new MapSqlParameterSource(), Integer.class);
        Integer catalogNodes2 = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.catalog_nodes", new MapSqlParameterSource(), Integer.class);
        Integer importsCount2 = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.content_package_imports", new MapSqlParameterSource(), Integer.class);

        assertEquals(formsCount1, formsCount2, "Form versions row delta must be 0");
        assertEquals(sectionsCount1, sectionsCount2, "Sections row delta must be 0");
        assertEquals(itemsCount1, itemsCount2, "Item versions row delta must be 0");
        assertEquals(catalogNodes1, catalogNodes2, "Catalog nodes row delta must be 0");
        assertEquals(importsCount1, importsCount2, "Package imports row delta must be 0");

        // Verify PILOT forms exist
        List<String> pilotForms = jdbcTemplate.queryForList(
                "SELECT title FROM exams.form_versions WHERE lifecycle_state = 'PILOT' ORDER BY title",
                new MapSqlParameterSource(), String.class);
        System.out.println("Active PILOT Forms in PostgreSQL (" + pilotForms.size() + "):");
        for (String title : pilotForms) {
            System.out.println("  - " + title);
        }
        assertTrue(pilotForms.size() >= 10, "At least 10 PILOT forms must be active");
    }
}
