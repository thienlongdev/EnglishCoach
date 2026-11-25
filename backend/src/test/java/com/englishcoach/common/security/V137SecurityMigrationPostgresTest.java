package com.englishcoach.common.security;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.output.MigrateResult;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class V137SecurityMigrationPostgresTest {

    @Test
    @DisplayName("DB-01 & DB-03: Flyway V137 blocks runtime DELETE on financial/usage audit tables and pins function search_path")
    void v137EnforcesFinancialAuditImmutabilityAndFunctionSearchPath() throws Exception {
        try (var pg = new PostgreSQLContainer<>("postgres:17")) {
            pg.start();
            String url = pg.getJdbcUrl();
            String user = pg.getUsername();
            String pass = pg.getPassword();

            try (Connection conn = DriverManager.getConnection(url, user, pass);
                 Statement st = conn.createStatement()) {
                st.execute("CREATE SCHEMA IF NOT EXISTS exams");
                st.execute("CREATE ROLE english_coach_runtime NOLOGIN");
                st.execute("CREATE ROLE english_coach_app LOGIN PASSWORD 'app_test_pass' IN ROLE english_coach_runtime");

                st.execute("CREATE TABLE public.payment_orders (id BIGSERIAL PRIMARY KEY, code TEXT)");
                st.execute("CREATE TABLE public.payment_transactions (id BIGSERIAL PRIMARY KEY, tx_id TEXT)");
                st.execute("CREATE TABLE public.premium_ai_usage (id BIGSERIAL PRIMARY KEY, feature TEXT)");
                st.execute("CREATE TABLE public.document_recognition_usage (id BIGSERIAL PRIMARY KEY, kind TEXT)");

                st.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_orders, public.payment_transactions, public.premium_ai_usage, public.document_recognition_usage TO english_coach_runtime");
                st.execute("INSERT INTO public.payment_orders (code) VALUES ('EC1')");
                st.execute("INSERT INTO public.payment_transactions (tx_id) VALUES ('TX1')");
                st.execute("INSERT INTO public.premium_ai_usage (feature) VALUES ('WRITING')");
                st.execute("INSERT INTO public.document_recognition_usage (kind) VALUES ('PDF')");

                st.execute("CREATE FUNCTION public.messenger_directory_sync(uid bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$");
                st.execute("CREATE FUNCTION public.protect_premium_quote() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
            }

            Flyway flyway = Flyway.configure()
                    .dataSource(url, user, pass)
                    .schemas("exams")
                    .defaultSchema("exams")
                    .table("flyway_schema_history")
                    .locations("classpath:db/migration/exams")
                    .baselineOnMigrate(true)
                    .baselineVersion("136")
                    .target("137")
                    .load();

            flyway.baseline();
            MigrateResult result = flyway.migrate();
            assertThat(result.migrationsExecuted).isEqualTo(1);
            flyway.validate();
            assertThat(flyway.migrate().migrationsExecuted).isZero();

            // 1. Runtime role cannot DELETE from any of the 4 protected tables.
            try (Connection appConn = DriverManager.getConnection(url, "english_coach_app", "app_test_pass");
                 Statement st = appConn.createStatement()) {
                for (String table : new String[]{"payment_orders", "payment_transactions", "premium_ai_usage", "document_recognition_usage"}) {
                    assertThatThrownBy(() -> st.executeUpdate("DELETE FROM public." + table))
                            .isInstanceOf(SQLException.class);
                }
            }

            // 2. Owner cannot DELETE without explicit maintenance opt-in, and CAN with SET LOCAL opt-in.
            try (Connection ownerConn = DriverManager.getConnection(url, user, pass);
                 Statement st = ownerConn.createStatement()) {
                assertThatThrownBy(() -> st.executeUpdate("DELETE FROM public.payment_orders WHERE code = 'EC1'"))
                        .isInstanceOf(SQLException.class)
                        .hasMessageContaining("app.allow_maintenance_delete");

                ownerConn.setAutoCommit(false);
                st.execute("SET LOCAL app.allow_maintenance_delete = 'on'");
                assertThat(st.executeUpdate("DELETE FROM public.payment_orders WHERE code = 'EC1'")).isEqualTo(1);
                ownerConn.rollback();
                ownerConn.setAutoCommit(true);

                // 3. Functions have explicit search_path pinned.
                try (ResultSet rs = st.executeQuery("""
                        SELECT p.proname, array_to_string(p.proconfig, ',')
                        FROM pg_proc p
                        JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public'
                          AND p.proname IN ('messenger_directory_sync', 'protect_premium_quote', 'guard_financial_audit_delete')
                        ORDER BY p.proname
                        """)) {
                    int checked = 0;
                    while (rs.next()) {
                        checked++;
                        assertThat(rs.getString(2)).contains("search_path=public, pg_temp");
                    }
                    assertThat(checked).isEqualTo(3);
                }
            }
        }
    }
}
