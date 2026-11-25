package com.englishcoach.leaderboard.board;

import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;

import javax.sql.DataSource;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Throw-away PostgreSQL 17 for the Phase 3 board tests: real V52 + V53 + V54 + V57 + V59 migrations plus minimal
 * stand-ins for users / user_profiles / avatar frames, plus V94. The returned DataSource connects as the least-privilege
 * application role english_coach_app (as production does) and logs every SQL text
 * sent to the database ({@link #SQL_LOG}) so tests can count statements and prove the read path.
 */
final class BoardTestPostgres {

    static final List<String> SQL_LOG = Collections.synchronizedList(new ArrayList<>());

    private static DataSource raw;
    private static DataSource app;
    private static DataSource logging;

    private BoardTestPostgres() {}

    static synchronized DataSource dataSource() {
        if (logging != null) {
            return logging;
        }
        PostgreSQLContainer<?> container = new PostgreSQLContainer<>("postgres:17");
        container.start();
        raw = new DriverManagerDataSource(container.getJdbcUrl(), container.getUsername(), container.getPassword());
        try (Connection c = raw.getConnection(); Statement st = c.createStatement()) {
            st.execute("""
                    CREATE TABLE public.users (id BIGINT PRIMARY KEY, name VARCHAR(255) NOT NULL,
                        email VARCHAR(255), role VARCHAR(20) NOT NULL DEFAULT 'ROLE_USER',
                        account_status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE');
                    INSERT INTO public.users (id, name, email) SELECT g, 'Learner ' || g, 'u' || g || '@example.test'
                        FROM generate_series(1, 600) g;
                    CREATE TABLE public.user_profiles (user_id BIGINT PRIMARY KEY, display_name VARCHAR(100),
                        avatar_storage_key VARCHAR(255), avatar_updated_at TIMESTAMPTZ);
                    CREATE TABLE public.avatar_frames (id BIGINT PRIMARY KEY, slug VARCHAR(64) NOT NULL, tier VARCHAR(16) NOT NULL,
                        render_type VARCHAR(32) NOT NULL, poster_asset VARCHAR(255) NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE);
                    CREATE TABLE public.user_avatar_frames (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, frame_id BIGINT NOT NULL,
                        expires_at TIMESTAMPTZ, is_equipped BOOLEAN NOT NULL DEFAULT FALSE);
                    INSERT INTO public.avatar_frames VALUES (1, 'jade-dragon', 'S', 'STATIC_SVG', '/frames/jade.svg', TRUE);
                    CREATE TABLE public.dictionary_entries (id BIGSERIAL PRIMARY KEY, word VARCHAR(255) NOT NULL,
                        cefr VARCHAR(10), entry_type VARCHAR(30) NOT NULL DEFAULT 'WORD');
                    -- 10 synthetic single words per level A1–C1 (+ a phrase, a two-level word, a C2 word: all excluded)
                    INSERT INTO public.dictionary_entries (word, cefr)
                        SELECT 'q' || chr(96 + lv) || chr(96 + i), (ARRAY['A1','A2','B1','B2','C1'])[lv]
                        FROM generate_series(1, 5) lv, generate_series(1, 10) i;
                    INSERT INTO public.dictionary_entries (word, cefr, entry_type) VALUES ('take off', 'A2', 'PHRASE'),
                        ('qaa', 'B2', 'WORD'), ('zzzword', 'C2', 'WORD');
                    """);
            for (String v : List.of("V52__leaderboard_activity.sql", "V53__proficiency_engine.sql", "V54__leaderboard_rollup.sql",
                    "V57__leaderboard_rollup_precision.sql",
                    "V59__leaderboard_exclusions_division_level.sql",
                    "V63__placement_quiz_division_level.sql",
                    "V66__placement_v2_live_leaderboard.sql",
                    "V69__placement_progress_bank_fix.sql",
                    "V94__database_runtime_least_privilege.sql")) {
                st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/" + v)));
            }
            // the code under test connects as production does since V94: as the least-privilege application role
            // (fixtures and resets keep the owner connection, rawConnection())
            st.execute("ALTER ROLE english_coach_app PASSWORD 'board-test-only'");
            app = new DriverManagerDataSource(container.getJdbcUrl(), "english_coach_app", "board-test-only");
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to prepare board test schema", ex);
        }
        logging = (DataSource) Proxy.newProxyInstance(BoardTestPostgres.class.getClassLoader(),
                new Class<?>[]{DataSource.class}, (p, m, args) -> {
                    Object r = invoke(app, m, args);
                    return r instanceof Connection c ? wrap(c, Connection.class) : r;
                });
        return logging;
    }

    /** Un-logged connection (test fixtures and concurrent lock holders). */
    static Connection rawConnection() throws Exception {
        dataSource();
        return raw.getConnection();
    }

    private static Object invoke(Object target, java.lang.reflect.Method m, Object[] args) throws Throwable {
        try {
            return m.invoke(target, args);
        } catch (InvocationTargetException ex) {
            throw ex.getCause();
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> T wrap(T target, Class<T> type) {
        InvocationHandler h = (p, m, args) -> {
            String name = m.getName();
            if (args != null && args.length > 0 && args[0] instanceof String sql
                    && (name.startsWith("prepare") || name.startsWith("execute") || name.equals("addBatch"))) {
                SQL_LOG.add(sql);
            }
            Object r = invoke(target, m, args);
            if (r instanceof java.sql.PreparedStatement ps) return wrap(ps, java.sql.PreparedStatement.class);
            if (r instanceof Statement s && !(r instanceof java.sql.PreparedStatement)) return wrap(s, Statement.class);
            return r;
        };
        return (T) Proxy.newProxyInstance(BoardTestPostgres.class.getClassLoader(), new Class<?>[]{type}, h);
    }
}
