package com.englishcoach.common;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Flyway V94: the role the backend connects with in production can read and write rows, use sequences, run functions
 * and refresh the two ranking views through their owner functions — and nothing else: no DDL, no TRUNCATE, no write to
 * Flyway's history, no role or database attributes. Applied twice to prove it is idempotent.
 */
@Testcontainers(disabledWithoutDocker = true)
class DatabaseRuntimeLeastPrivilegeTest {

    private static final Path V94 = Path.of("src/main/resources/db/migration/exams/V94__database_runtime_least_privilege.sql");
    private static PostgreSQLContainer<?> db;

    @BeforeAll
    static void start() throws Exception {
        db = new PostgreSQLContainer<>("postgres:17");
        db.start();
        try (Connection c = owner(); Statement st = c.createStatement()) {
            st.execute("""
                    CREATE SCHEMA exams;
                    CREATE TABLE exams.flyway_schema_history (installed_rank INT PRIMARY KEY, version TEXT);
                    INSERT INTO exams.flyway_schema_history VALUES (1, '93');
                    CREATE TABLE public.notes (id BIGSERIAL PRIMARY KEY, body TEXT NOT NULL);
                    CREATE TABLE exams.attempts (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL);
                    CREATE MATERIALIZED VIEW public.mv_activity_rank AS SELECT 1 AS user_id;
                    CREATE UNIQUE INDEX ux_mv_activity_rank ON public.mv_activity_rank(user_id);
                    CREATE MATERIALIZED VIEW public.mv_proficiency_rank AS SELECT 1 AS user_id;
                    CREATE UNIQUE INDEX ux_mv_proficiency_rank ON public.mv_proficiency_rank(user_id);
                    """);
            String sql = Files.readString(V94);
            st.execute(sql);
            st.execute(sql); // idempotent
            st.execute("CREATE TABLE public.created_by_a_later_migration (id BIGSERIAL PRIMARY KEY)");
            st.execute("ALTER ROLE english_coach_app PASSWORD 'least-privilege-test'");
        }
    }

    @AfterAll
    static void stop() {
        if (db != null) db.stop();
    }

    private static Connection owner() throws SQLException {
        return DriverManager.getConnection(db.getJdbcUrl(), db.getUsername(), db.getPassword());
    }

    private static Connection app() throws SQLException {
        return DriverManager.getConnection(db.getJdbcUrl(), "english_coach_app", "least-privilege-test");
    }

    @Test
    void readsAndWritesRowsOfBothSchemasAndLaterTables() throws Exception {
        try (Connection c = app(); Statement st = c.createStatement()) {
            st.executeUpdate("INSERT INTO public.notes (body) VALUES ('a')");
            st.executeUpdate("UPDATE public.notes SET body = 'b'");
            st.executeUpdate("INSERT INTO exams.attempts (user_id) VALUES (7)");
            st.executeUpdate("INSERT INTO public.created_by_a_later_migration DEFAULT VALUES");
            st.execute("SELECT * FROM public.notes FOR UPDATE");
            st.execute("CREATE TEMP TABLE scratch ON COMMIT DROP AS SELECT 1 AS x");
            try (ResultSet rs = st.executeQuery("SELECT count(*) FROM exams.flyway_schema_history")) {
                rs.next();
                assertThat(rs.getInt(1)).isEqualTo(1);
            }
            st.executeUpdate("DELETE FROM public.notes");
        }
    }

    @Test
    void refreshesTheRankingViewsOnlyThroughTheOwnerFunctions() throws Exception {
        try (Connection c = app(); Statement st = c.createStatement()) {
            st.execute("SELECT public.refresh_mv_activity_rank()");
            st.execute("SELECT public.refresh_mv_proficiency_rank()");
            assertDenied(st, "REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_activity_rank");
        }
    }

    @Test
    void cannotChangeTheSchemaTheHistoryOrRoles() throws Exception {
        try (Connection c = app(); Statement st = c.createStatement()) {
            assertDenied(st, "CREATE TABLE public.intruder (id INT)");
            assertDenied(st, "CREATE TABLE exams.intruder (id INT)");
            assertDenied(st, "ALTER TABLE public.notes ADD COLUMN x INT");
            assertDenied(st, "DROP TABLE public.notes");
            assertDenied(st, "TRUNCATE public.notes");
            assertDenied(st, "CREATE INDEX ix_intruder ON public.notes(body)");
            assertDenied(st, "INSERT INTO exams.flyway_schema_history VALUES (2, '99')");
            assertDenied(st, "DELETE FROM exams.flyway_schema_history");
            assertDenied(st, "CREATE ROLE intruder");
            assertDenied(st, "CREATE SCHEMA intruder");
            try (ResultSet rs = st.executeQuery("""
                    SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolconnlimit
                    FROM pg_roles WHERE rolname = current_user""")) {
                rs.next();
                assertThat(rs.getBoolean(1) || rs.getBoolean(2) || rs.getBoolean(3) || rs.getBoolean(4) || rs.getBoolean(5)).isFalse();
                assertThat(rs.getInt(6)).isEqualTo(32);
            }
        }
    }

    private static void assertDenied(Statement st, String sql) {
        assertThatThrownBy(() -> st.execute(sql)).as(sql).isInstanceOf(SQLException.class)
                .satisfies(ex -> assertThat(((SQLException) ex).getSQLState()).as(sql).isIn("42501", "42P01"));
    }
}
