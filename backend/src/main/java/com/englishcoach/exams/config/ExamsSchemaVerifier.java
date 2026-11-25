package com.englishcoach.exams.config;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
public class ExamsSchemaVerifier implements ApplicationRunner {

    private final JdbcTemplate jdbcTemplate;
    private final ExamsProperties examsProperties;

    private volatile boolean verified = false;

    @Override
    public void run(ApplicationArguments args) {
        if (!examsProperties.isEnabled()) {
            log.info("Exams module is disabled via configuration.");
            return;
        }

        try {
            log.info("Verifying Exams database schema '{}'...", examsProperties.getSchema());

            Integer tableCount = jdbcTemplate.queryForObject(
                    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ?",
                    Integer.class,
                    examsProperties.getSchema()
            );

            if (tableCount == null || tableCount < 30) {
                String message = String.format("Exams schema '%s' is incomplete or missing! Found %d tables.",
                        examsProperties.getSchema(), tableCount == null ? 0 : tableCount);
                log.error(message);
                if (examsProperties.isStrictMode()) {
                    throw new IllegalStateException(message);
                }
                return;
            }

            // Verify essential runtime & integrity tables
            jdbcTemplate.execute("SELECT 1 FROM exams.form_versions LIMIT 0");
            jdbcTemplate.execute("SELECT 1 FROM exams.attempts LIMIT 0");
            jdbcTemplate.execute("SELECT 1 FROM exams.submissions LIMIT 0");
            jdbcTemplate.execute("SELECT 1 FROM exams.jobs LIMIT 0");
            jdbcTemplate.execute("SELECT 1 FROM exams.score_artifacts LIMIT 0");
            jdbcTemplate.execute("SELECT 1 FROM exams.profile_evidence LIMIT 0");

            verified = true;
            log.info("Exams database schema '{}' successfully verified with {} tables.",
                    examsProperties.getSchema(), tableCount);

        } catch (Exception e) {
            log.error("Exams schema verification failed: {}", e.getMessage());
            if (examsProperties.isStrictMode()) {
                throw new IllegalStateException("Exams schema verification failed", e);
            }
        }
    }

    public boolean isVerified() {
        return verified;
    }
}
