package com.englishcoach.proficiency;

import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;

import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;

/**
 * Throw-away PostgreSQL 17 for proficiency tests: the real V53 migration plus minimal stand-ins
 * for the source tables the engine READS (users, listening_materials, speaking_scenarios,
 * speaking_turns, exams.*). A full Flyway build from scratch is impossible (11-known-issues I3).
 */
final class ProficiencyTestPostgres {

    private static DataSource dataSource;

    private ProficiencyTestPostgres() {}

    static synchronized DataSource dataSource() {
        if (dataSource != null) {
            return dataSource;
        }
        PostgreSQLContainer<?> container = new PostgreSQLContainer<>("postgres:17");
        container.start();
        DriverManagerDataSource ds = new DriverManagerDataSource(
                container.getJdbcUrl(), container.getUsername(), container.getPassword());
        try (Connection c = ds.getConnection(); Statement st = c.createStatement()) {
            st.execute("""
                    CREATE TABLE public.users (id BIGINT PRIMARY KEY);
                    INSERT INTO public.users (id) SELECT g FROM generate_series(1, 500) g;
                    CREATE TABLE public.listening_materials (id BIGINT PRIMARY KEY, is_system BOOLEAN NOT NULL,
                        owner_user_id BIGINT, cefr_level VARCHAR(10));
                    CREATE TABLE public.speaking_scenarios (id BIGINT PRIMARY KEY, is_system BOOLEAN NOT NULL,
                        owner_user_id BIGINT, cefr_level VARCHAR(20));
                    CREATE TABLE public.speaking_turns (id BIGSERIAL PRIMARY KEY, session_id BIGINT NOT NULL,
                        speaker VARCHAR(30) NOT NULL, is_mocked BOOLEAN, fluency_score INTEGER);
                    CREATE SCHEMA exams;
                    CREATE TABLE exams.form_versions (id UUID PRIMARY KEY, lifecycle_state VARCHAR(30) NOT NULL);
                    CREATE TABLE exams.attempts (id UUID PRIMARY KEY, user_id BIGINT, form_id UUID NOT NULL, family VARCHAR(10) NOT NULL,
                        attempt_mode VARCHAR(30) NOT NULL DEFAULT 'EXAM_SIMULATION',
                        snapshot_state VARCHAR(30), manifest_snapshot JSONB);
                    CREATE TABLE exams.submissions (id UUID PRIMARY KEY, attempt_id UUID NOT NULL);
                    CREATE TABLE exams.score_artifacts (id UUID PRIMARY KEY, submission_id UUID NOT NULL,
                        run_ordinal INTEGER NOT NULL, result_status VARCHAR(30) NOT NULL, created_at TIMESTAMPTZ NOT NULL);
                    CREATE TABLE exams.score_components (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), artifact_id UUID NOT NULL,
                        metric VARCHAR(30) NOT NULL, scale_name VARCHAR(40), scaled_score NUMERIC(8,2) NOT NULL,
                        uncertainty_range JSONB);
                    INSERT INTO public.listening_materials VALUES (1, TRUE, NULL, 'B1'), (2, FALSE, 5, 'C2'), (3, TRUE, NULL, NULL);
                    INSERT INTO public.speaking_scenarios VALUES (10, TRUE, NULL, 'A2'), (11, FALSE, 5, 'C1');
                    """);
            st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/V53__proficiency_engine.sql")));
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to prepare proficiency test schema", ex);
        }
        dataSource = ds;
        return dataSource;
    }
}
