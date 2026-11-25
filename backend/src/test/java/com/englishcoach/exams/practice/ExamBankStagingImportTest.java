package com.englishcoach.exams.practice;

import com.englishcoach.exams.content.*;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.validation.ExamContentTree;
import com.englishcoach.exams.validation.ExamFormValidator;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Path;
import java.time.Instant;
import java.util.Set;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** Explicit local fixture. The normal package importer writes drafts. Only two original technical fixtures
 * may enter PILOT in this isolated database. No publication, QA decision or production connection. */
class ExamBankStagingImportTest {
    @Test
    void importVerifiedOriginalDrafts() throws Exception {
        assumeTrue(Boolean.getBoolean("examBank.localStage"));
        var mapper = new ObjectMapper().findAndRegisterModules();
        Path bank = Path.of("../data/exam-bank").toRealPath();
        var index = mapper.readTree(bank.resolve("manifests/exams.json").toFile());
        Set<String> fixtures = Set.of("ielts-general-training-reading-001", "ielts-writing-005");
        try (var pool = new HikariDataSource()) {
            pool.setJdbcUrl("jdbc:postgresql://127.0.0.1:5432/ec_exam_intelligence_20261116");
            pool.setUsername(System.getenv("STAGE_DB_USER"));
            pool.setPassword(System.getenv("STAGE_DB_PASSWORD"));
            pool.setMaximumPoolSize(2);
            var sql = new JdbcTemplate(pool);
            assertEquals("ec_exam_intelligence_20261116", sql.queryForObject("select current_database()", String.class));
            long actor = sql.queryForObject("select max(id) from public.users where email like '%.stage.%@example.test'", Long.class);
            var repository = new ExamContentRepository(new NamedParameterJdbcTemplate(pool), mapper);
            var importer = new ExamContentPackageImporter(repository, new ExamContentPackageValidator(mapper));
            var tx = new TransactionTemplate(new DataSourceTransactionManager(pool));
            int count = 0;
            for (var row : index) {
                String id = row.path("examId").asText();
                String edition = row.path("studentSHA256").asText().substring(0,12) + row.path("privateSHA256").asText().substring(0,12);
                var folder = bank.resolve("private/site-packages").resolve(id).resolve(edition).toRealPath();
                assertTrue(folder.startsWith(bank));
                if (!mapper.readTree(folder.resolve("validation.json").toFile()).path("valid").asBoolean()) continue;
                var pkg = mapper.readValue(folder.resolve("package.json").toFile(), ExamContentPackage.class);
                if (!pkg.sources().stream().allMatch(s -> "INTERNAL_ORIGINAL".equals(s.sourceType()))) continue;
                try {
                    tx.executeWithoutResult(status -> {
                        var imported = importer.importPackage(pkg, actor);
                        assertEquals(pkg.form().id(), imported.formId());
                        if (fixtures.contains(id)) {
                            var tree = ExamContentTree.fromPackage(pkg, mapper);
                            var validation = ExamFormValidator.validate(tree, mapper, Instant.now());
                            assertTrue(validation.fullSimulationEligible(), id + " " + validation.blockingCodes());
                            if (repository.findFormById(imported.formId()).orElseThrow().lifecycleState() == LifecycleState.DRAFT) {
                                repository.updateFormLifecycle(imported.formId(), LifecycleState.PILOT, null, null);
                                repository.insertAuditEvent(actor, "LOCAL_STAGING_FIXTURE", "FORM_VERSION", imported.formId().toString(),
                                        null, pkg.manifest().contentHash(), "Isolated bank acceptance fixture", null);
                            }
                        }
                    });
                } catch (RuntimeException ex) {
                    throw new IllegalStateException("Staging import failed for " + id, ex);
                }
                count++;
            }
            System.out.println("STAGING_CLOSURES_IMPORTED_OR_MATCHED=" + count);
            assertTrue(count > 0);
        }
    }
}

