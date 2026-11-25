package com.englishcoach.auth.migration;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.output.MigrateResult;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

import static org.assertj.core.api.Assertions.assertThat;

class AuthenticationMigrationVerificationTest {

    @Test
    @DisplayName("Flyway: Successfully applies V11, V12, V13 and validates database invariants")
    void testFlywayMigrationExecutionAndInvariants() throws Exception {
        try (var database = new PostgreSQLContainer<>("postgres:17")
                .withInitScript("auth-migration/pre-v11.sql")) {
        database.start();
        String dbUrl = database.getJdbcUrl(), dbUser = database.getUsername(), dbPassword = database.getPassword();
        Flyway flyway = Flyway.configure()
                .dataSource(dbUrl, dbUser, dbPassword)
                .schemas("exams")
                .defaultSchema("exams")
                .table("flyway_schema_history")
                .locations("classpath:db/migration/exams")
                .baselineOnMigrate(true)
                .baselineVersion("10")
                .target("13")
                .load();

        String before = learningSnapshot(dbUrl, dbUser, dbPassword);
        MigrateResult result = flyway.migrate();
        assertThat(result.migrationsExecuted).isEqualTo(3);
        flyway.validate();
        assertThat(flyway.migrate().migrationsExecuted).isZero();
        assertThat(learningSnapshot(dbUrl, dbUser, dbPassword)).isEqualTo(before);
        System.out.println("[Flyway] Migrations executed successfully: " + result.migrationsExecuted);
        for (var mi : flyway.info().all()) {
            System.out.println("[Flyway Scan] version=" + mi.getVersion() + ", desc=" + mi.getDescription() + ", type=" + mi.getType() + ", state=" + mi.getState() + ", script=" + mi.getScript());
        }

        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPassword);
             Statement stmt = conn.createStatement()) {

            // 1. Verify all 671 user IDs are preserved
            try (ResultSet rs = stmt.executeQuery("SELECT count(*), min(id), max(id) FROM public.users")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getLong(1)).isEqualTo(671L);
                assertThat(rs.getLong(2)).isEqualTo(1L);
                assertThat(rs.getLong(3)).isEqualTo(674L);
            }

            // 2. Verify credential classifications
            try (ResultSet rs = stmt.executeQuery("SELECT credential_status, count(*) FROM public.users GROUP BY credential_status ORDER BY credential_status")) {
                long activeCount = 0;
                long noneCount = 0;
                long resetRequiredCount = 0;
                while (rs.next()) {
                    String status = rs.getString(1);
                    long count = rs.getLong(2);
                    if ("ACTIVE".equals(status)) activeCount = count;
                    else if ("NONE".equals(status)) noneCount = count;
                    else if ("RESET_REQUIRED".equals(status)) resetRequiredCount = count;
                }
                assertThat(activeCount).isEqualTo(12L);
                assertThat(noneCount).isEqualTo(3L);
                assertThat(resetRequiredCount).isEqualTo(656L);
            }

            // 3. Verify public.auth_security_state initialized for all 671 users
            try (ResultSet rs = stmt.executeQuery("SELECT count(*) FROM public.auth_security_state")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getLong(1)).isEqualTo(671L);
            }

            // 4. Verify email_normalized uniqueness constraint exists and has 0 duplicates
            try (ResultSet rs = stmt.executeQuery("SELECT count(DISTINCT email_normalized) FROM public.users")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getLong(1)).isEqualTo(671L);
            }
            assertThat(stmt.executeQuery("SELECT id FROM public.users WHERE email_normalized <> lower(btrim(email))").next()).isFalse();
            // Constraints, rather than just labels/counts, must reject corrupt auth state.
            org.junit.jupiter.api.Assertions.assertThrows(java.sql.SQLException.class,
                    () -> stmt.executeUpdate("UPDATE public.users SET credential_status='INVALID' WHERE id=1"));
            org.junit.jupiter.api.Assertions.assertThrows(java.sql.SQLException.class,
                    () -> stmt.executeUpdate("UPDATE public.users SET email=(SELECT email FROM public.users WHERE id=1) WHERE id=2"));

            // 5. Verify all required authentication tables exist
            String[] expectedTables = {
                    "auth_identities",
                    "auth_security_state",
                    "auth_sessions",
                    "auth_action_tokens",
                    "auth_rate_limit_buckets",
                    "auth_mail_jobs",
                    "auth_audit_events"
            };
            for (String table : expectedTables) {
                try (ResultSet rs = stmt.executeQuery("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '" + table + "'")) {
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getInt(1)).as("Table public." + table + " must exist").isEqualTo(1);
                }
            }

            // 6. Verify user learning data counts remain unchanged
            try (ResultSet rs = stmt.executeQuery("SELECT count(*) FROM public.flashcards")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getLong(1)).isEqualTo(3871L);
            }
            try (ResultSet rs = stmt.executeQuery("SELECT count(*) FROM exams.attempts")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getLong(1)).isEqualTo(668L);
            }
            try (ResultSet rs = stmt.executeQuery("SELECT count(*) FROM public.speaking_sessions")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getLong(1)).isEqualTo(30L);
            }
        }
        }
    }

    private String learningSnapshot(String url, String user, String password) throws Exception {
        var snapshot = new StringBuilder();
        try (var connection = DriverManager.getConnection(url, user, password); var statement = connection.createStatement()) {
            for (String table : java.util.List.of("public.flashcards", "exams.attempts", "public.speaking_sessions")) {
                try (var rows = statement.executeQuery("SELECT md5(string_agg(row_to_json(t)::text, ',' ORDER BY id)) FROM " + table + " t")) {
                    assertThat(rows.next()).isTrue(); snapshot.append(table).append(':').append(rows.getString(1));
                }
            }
        }
        return snapshot.toString();
    }
}
