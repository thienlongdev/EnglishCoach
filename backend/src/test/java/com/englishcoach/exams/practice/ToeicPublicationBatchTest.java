package com.englishcoach.exams.practice;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.*;
import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.security.ExamPermissionService;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.validation.ExamContentValidationRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class ToeicPublicationBatchTest {
    @Test void allPinnedEditionsPublishAndReplayInOneLocalTransaction() throws Exception {
        assumeTrue(Boolean.getBoolean("toeic.localStage"));
        var mapper = new ObjectMapper().findAndRegisterModules();
        var bank = Path.of("../data/exam-bank").toRealPath();
        var rows = mapper.readTree(bank.resolve("reports/toeic-publication-batch.json").toFile()).get("packages");
        try (var pool = new HikariDataSource()) {
            pool.setJdbcUrl("jdbc:postgresql://127.0.0.1:5432/ec_exam_intelligence_20261116");
            pool.setUsername("postgres");
            pool.setPassword(System.getenv("STAGE_DB_PASSWORD"));
            var sql = new JdbcTemplate(pool);
            assertEquals("ec_exam_intelligence_20261116",sql.queryForObject("select current_database()",String.class));
            long actor=sql.queryForObject("select min(id) from public.users where email like '%.stage.%@example.test'",Long.class);
            var jdbc = new NamedParameterJdbcTemplate(pool);
            var repo = new ExamContentRepository(jdbc,mapper);
            var rights = new ExamRightsService(repo,new ExamMediaRepository(jdbc,mapper),new ExamsProperties());
            var importer = new ExamContentPackageImporter(repo,new ExamContentPackageValidator(mapper));
            var storage = mock(ExamObjectStorage.class);
            var lookup = new java.util.HashMap<String,Path>();
            lookup.put("toeic-publication/owner-index.json",bank.resolve("private/toeic-publication/owner-index.json"));
            when(storage.objectExists("toeic-publication/owner-index.json")).thenReturn(true);
            for (var row:rows) lookup.put("toeic-publication/packages/"+row.get("fileHash").asText()+".json",
                    bank.resolve(row.get("file").asText()).toRealPath());
            when(storage.getObjectStream(anyString())).thenAnswer(inv -> {
                String key=inv.getArgument(0);
                Path path=lookup.getOrDefault(key,bank.resolve(key)).toRealPath();
                assertTrue(path.startsWith(bank)); return Files.newInputStream(path);
            });
            var permissions=mock(ExamPermissionService.class);
            when(permissions.hasOperatorPermission(eq(actor),anyString())).thenReturn(true);
            var release=new ToeicPackagePublication(importer,repo,storage,new ExamPrivatePackageDrafts(sql,mapper,
                    new ExamContentPackageValidator(mapper),storage),new ExamContentValidationRepository(jdbc,mapper),
                    rights,permissions,mapper);
            release.refreshSignedRoster();
            var tx=new TransactionTemplate(new DataSourceTransactionManager(pool));
            tx.executeWithoutResult(status -> {
                status.setRollbackOnly();
                for (var row:rows) {
                    var id=UUID.fromString(row.get("formId").asText());
                    assertTrue(release.publishIfCovered(id,actor),row.get("packageId").asText());
                    assertEquals(LifecycleState.PUBLISHED,repo.findFormById(id).orElseThrow().lifecycleState());
                    assertTrue(release.publishIfCovered(id,actor));
                    assertEquals(!"FULL".equals(row.get("scope").asText()),ToeicPackagePublication.practiceOnly(id));
                }
            });
        }
    }
}
