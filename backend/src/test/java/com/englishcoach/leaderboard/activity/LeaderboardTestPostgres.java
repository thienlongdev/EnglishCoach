package com.englishcoach.leaderboard.activity;

import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;

import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;

/**
 * Shared throw-away PostgreSQL 17 container for leaderboard tests. The schema is the real
 * V52 migration plus minimal stand-ins for the source-module tables the Activity listener
 * reads (a full Flyway run cannot build from scratch — see 11-known-issues I3).
 */
final class LeaderboardTestPostgres {

    private static PostgreSQLContainer<?> container;
    private static DataSource dataSource;

    private LeaderboardTestPostgres() {}

    static synchronized DataSource dataSource() {
        if (dataSource != null) {
            return dataSource;
        }
        container = new PostgreSQLContainer<>("postgres:17");
        container.start();
        DriverManagerDataSource ds = new DriverManagerDataSource(
                container.getJdbcUrl(), container.getUsername(), container.getPassword());
        try (Connection c = ds.getConnection(); Statement st = c.createStatement()) {
            st.execute("""
                    CREATE TABLE public.users (id BIGINT PRIMARY KEY);
                    CREATE TABLE public.listening_sessions (id BIGSERIAL PRIMARY KEY, user_id BIGINT);
                    CREATE TABLE public.exercise_attempts (
                        id BIGSERIAL PRIMARY KEY,
                        listening_session_id BIGINT NOT NULL,
                        listening_exercise_id BIGINT NOT NULL);
                    CREATE TABLE public.speaking_turns (
                        id BIGSERIAL PRIMARY KEY, session_id BIGINT NOT NULL, speaker VARCHAR(30) NOT NULL,
                        is_mocked BOOLEAN, fluency_score INTEGER);
                    CREATE TABLE public.pvp_ratings (user_id BIGINT PRIMARY KEY, rating INT DEFAULT 1000);
                    CREATE TABLE public.lb_test_source (id BIGSERIAL PRIMARY KEY, note TEXT);
                    INSERT INTO public.users (id) SELECT g FROM generate_series(1, 500) g;
                    """);
            st.execute(Files.readString(Path.of(
                    "src/main/resources/db/migration/exams/V52__leaderboard_activity.sql")));
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to prepare leaderboard test schema", ex);
        }
        dataSource = ds;
        return dataSource;
    }
}
