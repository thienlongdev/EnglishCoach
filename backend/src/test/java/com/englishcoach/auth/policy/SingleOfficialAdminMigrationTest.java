package com.englishcoach.auth.policy;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * V68 on PostgreSQL 17 with production-shaped data: two admins (the official one stored with different case + spaces,
 * plus an accidental admin with open sessions), learners with sessions and Premium. Checks the single-admin result,
 * the audit backup, session revocation, the DB trigger and that nothing else changes.
 */
class SingleOfficialAdminMigrationTest {

    static PostgreSQLContainer<?> pg;
    static JdbcTemplate jdbc;

    @BeforeAll
    static void migrate() throws Exception {
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        jdbc = new JdbcTemplate(new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword()));
        jdbc.execute("""
                CREATE TABLE public.users (id BIGINT PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL,
                    role VARCHAR(255) NOT NULL, account_status VARCHAR(255) DEFAULT 'ACTIVE', credential_version BIGINT NOT NULL DEFAULT 0);
                CREATE TABLE public.auth_sessions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id BIGINT NOT NULL REFERENCES public.users(id), state VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
                    revoked_at TIMESTAMPTZ, revoked_reason VARCHAR(255));
                CREATE TABLE public.premium_plans (id BIGSERIAL PRIMARY KEY, code VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(128) NOT NULL,
                    duration_months INT NOT NULL, price_vnd BIGINT NOT NULL, display_order INT NOT NULL DEFAULT 0, badge VARCHAR(64),
                    active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
                INSERT INTO public.premium_plans (code, name, duration_months, price_vnd) VALUES ('PLAN_1_MONTH', 'Gói 1 Tháng', 1, 59000);
                INSERT INTO public.users (id, email, name, role) VALUES
                    (1, ' LongNTT872006@Gmail.com ', 'Official', 'ROLE_ADMIN'),
                    (675, 'accidental.admin@gmail.com', 'Accidental', 'ROLE_ADMIN'),
                    (676, 'learner@gmail.com', 'Learner', 'ROLE_USER');
                INSERT INTO public.auth_sessions (user_id, state) VALUES (675, 'ACTIVE'), (675, 'PENDING'), (1, 'ACTIVE'), (676, 'ACTIVE');
                INSERT INTO public.auth_sessions (user_id, state, revoked_at, revoked_reason) VALUES (675, 'REVOKED', now() - interval '1 day', 'LOGOUT');
                """);
        jdbc.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/V68__single_official_admin.sql")));
    }

    @AfterAll
    static void stop() {
        if (pg != null) pg.stop();
    }

    @Test
    @DisplayName("Exactly one ROLE_ADMIN afterwards: the official account; the accidental admin is ROLE_USER")
    void singleAdmin() {
        assertEquals(List.of(1L), jdbc.queryForList("SELECT id FROM public.users WHERE role = 'ROLE_ADMIN'", Long.class));
        assertEquals("ROLE_USER", jdbc.queryForObject("SELECT role FROM public.users WHERE id = 675", String.class));
        assertEquals("ROLE_USER", jdbc.queryForObject("SELECT role FROM public.users WHERE id = 676", String.class));
        assertEquals(3, jdbc.queryForObject("SELECT COUNT(*) FROM public.users", Integer.class), "no account deleted");
    }

    @Test
    @DisplayName("Backup: one append-only audit row for the demoted account (old role kept)")
    void auditBackup() {
        List<Map<String, Object>> rows = jdbc.queryForList("SELECT user_id, old_role, new_role, reason FROM public.admin_role_changes");
        assertEquals(1, rows.size());
        assertEquals(675L, ((Number) rows.get(0).get("user_id")).longValue());
        assertEquals("ROLE_ADMIN", rows.get(0).get("old_role"));
        assertEquals("ROLE_USER", rows.get(0).get("new_role"));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.admin_role_changes"));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.admin_role_changes SET new_role = 'ROLE_ADMIN'"));
    }

    @Test
    @DisplayName("Only the demoted account's open sessions are revoked (forced re-login); others and old revocations untouched")
    void sessions() {
        assertEquals(2, jdbc.queryForObject(
                "SELECT COUNT(*) FROM public.auth_sessions WHERE user_id = 675 AND revoked_reason = 'ROLE_CHANGED' AND state = 'REVOKED'", Integer.class));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM public.auth_sessions WHERE user_id = 675 AND revoked_reason = 'LOGOUT'", Integer.class));
        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM public.auth_sessions WHERE user_id IN (1, 676) AND state = 'ACTIVE' AND revoked_at IS NULL", Integer.class));
    }

    @Test
    @DisplayName("DB trigger: no other account can become ROLE_ADMIN (insert or update), the admin e-mail cannot be re-pointed")
    void trigger() {
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.users SET role = 'ROLE_ADMIN' WHERE id = 676"));
        assertThrows(Exception.class, () -> jdbc.update("INSERT INTO public.users (id, email, name, role) VALUES (9, 'evil@example.com', 'e', 'ROLE_ADMIN')"));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.users SET email = 'other@gmail.com' WHERE id = 1"));
        assertEquals("ROLE_USER", jdbc.queryForObject("SELECT role FROM public.users WHERE id = 676", String.class));
        jdbc.update("UPDATE public.users SET name = 'Learner renamed' WHERE id = 676"); // unrelated updates still work
        jdbc.update("INSERT INTO public.users (id, email, name, role) VALUES (10, 'new@example.com', 'n', 'ROLE_USER')");
        jdbc.update("DELETE FROM public.users WHERE id = 10");
    }

    @Test
    @DisplayName("ADMIN_GRANT plan exists but is inactive (never listed / sold); entitlement audit is append-only")
    void premiumObjects() {
        assertEquals(Boolean.FALSE, jdbc.queryForObject("SELECT active FROM public.premium_plans WHERE code = 'ADMIN_GRANT'", Boolean.class));
        assertEquals(0L, jdbc.queryForObject("SELECT price_vnd FROM public.premium_plans WHERE code = 'ADMIN_GRANT'", Long.class));
        jdbc.update("""
                INSERT INTO public.premium_admin_entitlement_events (target_user_id, admin_user_id, action, reason, previous_premium, new_premium)
                VALUES (676, 1, 'GRANT', 'test', false, true)""");
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.premium_admin_entitlement_events SET reason = 'x'"));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.premium_admin_entitlement_events"));
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.premium_admin_entitlement_events (target_user_id, admin_user_id, action, reason, previous_premium, new_premium)
                VALUES (676, 1, 'GRANT', '   ', false, true)"""), "reason required");
    }
}
