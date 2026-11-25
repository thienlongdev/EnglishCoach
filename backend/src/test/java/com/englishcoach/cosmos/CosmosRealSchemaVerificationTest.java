package com.englishcoach.cosmos;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Opt-in verification against a DISPOSABLE copy of a real application database (every migration V1–V118 applied by the
 * application itself), never production: {@code -Dcosmos.realSchema=jdbc:postgresql://127.0.0.1:15441/english_coach}.
 * It runs the real overlay SQL on the real schema, as the least-privilege runtime role, for the accounts with the most cards,
 * and checks every returned row against that account's own rows in the real tables (no foreign card, source or topic).
 */
@EnabledIfSystemProperty(named = "cosmos.realSchema", matches = "jdbc:postgresql://127\\.0\\.0\\.1:.*")
class CosmosRealSchemaVerificationTest {

    @Test
    void overlayOnTheRealSchemaAsTheRuntimeRoleReturnsOnlyTheCallersOwnEvidence() {
        var ds = new SingleConnectionDataSource(System.getProperty("cosmos.realSchema"), "postgres", "", true);
        JdbcTemplate jdbc = new JdbcTemplate(ds);
        // the application's runtime privileges (V94): DML only, no DDL
        jdbc.execute("SET ROLE english_coach_runtime");
        assertThat(jdbc.queryForObject("SELECT current_user", String.class)).isEqualTo("english_coach_runtime");
        CosmosOverlayService service = new CosmosOverlayService(jdbc);

        List<Long> users = jdbc.queryForList("""
                SELECT u.id FROM public.users u
                 WHERE EXISTS (SELECT 1 FROM public.flashcards f WHERE f.user_id = u.id AND f.state = 0)
                 ORDER BY (SELECT count(*) FROM public.flashcards f WHERE f.user_id = u.id) DESC, u.id LIMIT 6""", Long.class);
        users = new java.util.ArrayList<>(users);
        users.addAll(jdbc.queryForList("SELECT DISTINCT user_id FROM public.user_reading_progress WHERE completed_at IS NOT NULL LIMIT 3", Long.class));
        users.addAll(jdbc.queryForList("SELECT DISTINCT user_id FROM public.writing_practice_submission LIMIT 2", Long.class));
        users.addAll(jdbc.queryForList("SELECT DISTINCT user_id FROM public.grammar_topic_state LIMIT 2", Long.class));
        assertThat(users).isNotEmpty();
        StringBuilder report = new StringBuilder();
        for (long u : new HashSet<>(users)) {
            long t0 = System.nanoTime();
            CosmosDtos.Overlay o = service.overlay(u);
            long ms = (System.nanoTime() - t0) / 1_000_000;
            long t1 = System.nanoTime();
            service.overlay(u); // second read: every source served from the extraction cache
            long cachedMs = (System.nanoTime() - t1) / 1_000_000;
            report.append(String.format("user %d: %d words, %d reviews, %d grammar, %d sources; first %d ms, cached %d ms%n",
                    u, o.words().size(), o.reviews().size(), o.grammar().size(), o.sources().size(), ms, cachedMs));

            Set<Long> ownCards = new HashSet<>(jdbc.queryForList("SELECT id FROM public.flashcards WHERE user_id = ? AND state = 0", Long.class, u));
            assertThat(o.words()).allSatisfy(w -> assertThat(ownCards).contains(w.cardId()));
            assertThat(o.reviews()).allSatisfy(r -> assertThat(ownCards).contains(r.cardId()));
            Set<String> ownTopics = new HashSet<>(jdbc.queryForList("SELECT topic_slug FROM public.grammar_topic_state WHERE user_id = ?", String.class, u));
            assertThat(o.grammar()).allSatisfy(g -> assertThat(ownTopics).contains(g.slug()));
            for (CosmosDtos.Source s : o.sources()) {
                switch (s.kind()) {
                    case "READING" -> {
                        Map<String, Object> m = jdbc.queryForMap("SELECT is_system, owner_user_id FROM public.reading_materials WHERE id = ?", s.id());
                        assertThat(Boolean.TRUE.equals(m.get("is_system")) && m.get("owner_user_id") == null || Long.valueOf(u).equals(((Number) m.get("owner_user_id")).longValue())).isTrue();
                        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.user_reading_progress WHERE user_id = ? AND reading_material_id = ? AND completed_at IS NOT NULL", Integer.class, u, s.id())).isPositive();
                    }
                    case "LISTENING" -> {
                        Map<String, Object> m = jdbc.queryForMap("SELECT is_system, owner_user_id FROM public.listening_materials WHERE id = ?", s.id());
                        assertThat(Boolean.TRUE.equals(m.get("is_system")) && m.get("owner_user_id") == null || m.get("owner_user_id") != null && ((Number) m.get("owner_user_id")).longValue() == u).isTrue();
                    }
                    case "WRITING" -> assertThat(jdbc.queryForObject("SELECT user_id FROM public.writing_practice_submission WHERE id = ?", Long.class, s.id())).isEqualTo(u);
                    case "SPEAKING" -> assertThat(jdbc.queryForObject("SELECT user_id FROM exams.speaking_quick_checks WHERE id = ?", Long.class, s.id())).isEqualTo(u);
                    default -> throw new AssertionError(s.kind());
                }
            }
        }
        // the cache never holds a private source without its owner, and a private row belongs to its source's owner
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.cosmos_source_tokens WHERE source_kind IN ('WRITING','SPEAKING') AND owner_user_id IS NULL", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM public.cosmos_source_tokens c JOIN public.writing_practice_submission w ON w.id = c.source_id
                 WHERE c.source_kind = 'WRITING' AND c.owner_user_id <> w.user_id""", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM public.cosmos_source_tokens c JOIN public.reading_materials m ON m.id = c.source_id
                 WHERE c.source_kind = 'READING' AND c.owner_user_id IS DISTINCT FROM (CASE WHEN m.is_system AND m.owner_user_id IS NULL THEN NULL ELSE m.owner_user_id END)""", Integer.class)).isZero();
        System.out.println(report);
        ds.destroy();
    }
}
