package com.englishcoach.exams.practice;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.content.ExamOriginalPracticeBootstrapService;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.service.ExamManifestService;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.validation.ExamContentValidationRepository;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * LOCAL-ONLY staging fixture (opt-in, skipped unless {@code -Dexams.localFixture.url=jdbc:postgresql://localhost:5432/...}):
 * imports the project's OWN original practice bank (INTERNAL_ORIGINAL sources, ORIGINAL licences; no third-party exam
 * content) into a LOCAL development database through the canonical path an administrator triggers in production
 * ({@link ExamOriginalPracticeBootstrapService}: package validator, importer, form validator, practice readiness, PILOT).
 * It then checks readiness with the SAME rights basis the running application uses (publisher licence). It never
 * touches Learning Path or attempt tables. Never point it at production.
 */
class ExamOriginalPracticeLocalFixtureTest {

    @Test
    void importTheOriginalPracticeBankIntoTheLocalDatabase() throws Exception {
        String url = System.getProperty("exams.localFixture.url");
        assumeTrue(url != null && url.startsWith("jdbc:postgresql://localhost:"), "opt-in local fixture only");
        long actor = Long.parseLong(System.getProperty("exams.localFixture.actor", "1"));
        DriverManagerDataSource ds = new DriverManagerDataSource(url, System.getProperty("exams.localFixture.user", "postgres"),
                System.getProperty("exams.localFixture.password", "postgres"));
        NamedParameterJdbcTemplate named = new NamedParameterJdbcTemplate(ds);
        ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();
        ExamContentRepository content = new ExamContentRepository(named, mapper);
        ExamAttemptRepository attempts = new ExamAttemptRepository(named, mapper);
        DataSourceTransactionManager tm = new DataSourceTransactionManager(ds);
        ExamContentValidationRepository tree = new ExamContentValidationRepository(named, mapper);
        ExamContentValidationService validation = new ExamContentValidationService(tree, mapper,
                new StaticListableBeanFactory(Map.of("tm", tm)).getBeanProvider(PlatformTransactionManager.class));
        ExamContentPackageImporter importer = new ExamContentPackageImporter(content, new ExamContentPackageValidator(mapper));
        importer.setValidationService(validation);
        ExamsProperties props = new ExamsProperties(); // LOCAL_PRIVATE, not strict: the policy the bootstrap requires
        ExamRightsService rights = new ExamRightsService(content, new ExamMediaRepository(named, mapper), props);
        ExamPracticeService practice = new ExamPracticeService(content, attempts, validation, tree, rights,
                new ExamManifestService(content, attempts), new ExamObjectiveScorer(new ExamAnswerNormalizer()), mapper);
        var bootstrap = new ExamOriginalPracticeBootstrapService(mapper, importer, content, practice, props);
        List<ExamContentPackage.ImportResult> results = new TransactionTemplate(tm).execute(s -> {
            try {
                return bootstrap.bootstrap(actor);
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        for (var r : results) {
            validation.invalidate(r.formId());
            var scopes = practice.evaluateForm(r.formId()).scopes();
            System.out.println("[fixture] " + r.status() + " " + r.formId() + " ready=" + scopes.stream()
                    .filter(ExamPracticeReadiness.ScopeReadiness::ready).map(x -> x.scope().scopeCode()).toList());
            assertTrue(scopes.stream().allMatch(ExamPracticeReadiness.ScopeReadiness::ready));
        }
    }
}
