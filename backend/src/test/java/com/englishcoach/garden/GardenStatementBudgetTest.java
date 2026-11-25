package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos.CosmeticBuyRequest;
import com.englishcoach.garden.api.GardenDtos.PlantRequest;
import com.englishcoach.garden.application.LedgerService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Phase 4 measurement on real PostgreSQL 17 through V90: how many SQL statements ONE request of a mid-game garden costs
 * ({@code pg_stat_statements}), and a budget that fails when a change makes the hottest request chattier. The garden
 * state is read on entry, on focus, every three minutes and after most commands, by every player — its statement count
 * is the garden's share of a database connection.
 *
 * <p>The fixture is a level-12 garden with ten planted beds, two Forgotten Pests, a Memory Tree, four animal houses
 * with animals, three guardians, owned cosmetics, two hundred flashcards and a review history. The full table is
 * written to {@code target/garden-statement-budget.txt}.</p>
 */
class GardenStatementBudgetTest {

    /** Statements of one {@code GET /state} of the fixture garden. Measured 2026-10-13: 139 before Phase 4, 90 after (see the Phase 4 report). */
    static final int STATE_BUDGET = 92;

    /**
     * Network round trips of one {@code GET /state} of the fixture garden, counted on the wire (the COMMIT included).
     * Measured 2026-10-13: 92 before Phase 5, 7 after. In production each one costs about 91 ms.
     */
    static final int STATE_ROUND_TRIPS = 8;

    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static long user;

    @BeforeAll
    static void start() {
        GardenTestEnv.throughWire = true;
        try {
            env = new GardenTestEnv(Instant.parse("2026-10-09T03:00:00Z"), "90");
        } finally {
            GardenTestEnv.throughWire = false;
        }
        jdbc = env.jdbc;
        // other test classes of this JVM run on a fixture without some learning tables; here they exist
        com.englishcoach.garden.infra.GardenJdbc.forgetFailures();
        jdbc.execute("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
        // production has every learning module's table; the shared test fixture leaves these out on purpose (a missing
        // module must never break the garden). Here they exist, empty, so the measurement has production's shape.
        jdbc.execute("""
                CREATE TABLE public.speaking_shadowing_attempts(id BIGSERIAL PRIMARY KEY, session_id BIGINT, user_id BIGINT,
                    created_at TIMESTAMP, is_mocked BOOLEAN, analysis_status VARCHAR(32), accuracy_score DOUBLE PRECISION);
                CREATE TABLE public.writing_submissions(id BIGSERIAL PRIMARY KEY, session_id VARCHAR(64), user_id BIGINT, word_count INT);
                CREATE TABLE public.writing_assessments(id BIGSERIAL PRIMARY KEY, submission_id BIGINT, status VARCHAR(32),
                    completed_at TIMESTAMPTZ);
                CREATE TABLE public.word_chain_results(match_id UUID, user_id BIGINT, finished_at TIMESTAMPTZ, accepted_count INT);
                CREATE TABLE exams.attempts(id UUID PRIMARY KEY, user_id BIGINT, status VARCHAR(32), submitted_at TIMESTAMPTZ);
                """);
        user = fixture();
    }

    @AfterAll
    static void stop() {
        if (env != null) env.close();
    }

    static UUID key() {
        return UUID.randomUUID();
    }

    /** A mid-game garden built through the real services (plus direct fixtures for beds, cards and review history). */
    static long fixture() {
        long u = 170_001L;
        LedgerService ledger = new LedgerService(env.ctx);
        jdbc.update("INSERT INTO public.users(id, name, email) VALUES (?, 'Budget learner', 'budget@example.test')", u);
        env.state.state(u);
        jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", u);
        ledger.addXp(u, env.ctx.engine().levels().totalXpForLevel(12), "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        ledger.addCoins(u, 600_000, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        for (var p : GardenTestRules.economy().expansion().plots()) {
            jdbc.update("""
                    INSERT INTO public.garden_plot(user_id, kind, slot_index, grid_x, grid_y, unlocked_at) VALUES (?, 'CROP', ?, ?, ?, now())
                    ON CONFLICT DO NOTHING""", u, p.slot(), p.gx(), p.gy());
        }
        // two hundred cards with a review history of a month; five of them overdue
        List<Long> cards = new ArrayList<>();
        for (int i = 0; i < 200; i++) {
            long de = jdbc.queryForObject("INSERT INTO public.dictionary_entries(word, cefr, general_translation_vi) VALUES (?, 'A2', ?) RETURNING id",
                    Long.class, "budgetword" + i, "Nghĩa " + i);
            boolean overdue = i < 5;
            cards.add(jdbc.queryForObject("""
                    INSERT INTO public.flashcards(user_id, dictionary_entry_id, status, next_review_date, review_count)
                    VALUES (?, ?, 'LEARNED', ?, 6) RETURNING id""", Long.class, u, de,
                    Timestamp.valueOf(overdue ? LocalDateTime.now().minusHours(60 + i) : LocalDateTime.now().plusDays(2))));
        }
        for (int day = 30; day >= 1; day--) {
            for (int c = 0; c < 40; c++) {
                long card = cards.get((day * 7 + c) % cards.size());
                jdbc.update("""
                        INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at)
                        VALUES (?, 'FLASHCARD_REVIEWED', ?, ?) ON CONFLICT DO NOTHING""", u, card + ":" + (31 - day),
                        Timestamp.from(env.clock.now.minus(Duration.ofDays(day)).plusSeconds(c)));
            }
        }
        var s = env.state.state(u);
        for (var plot : s.plots()) env.planting.plant(u, key(), plot.id(), new PlantRequest(plot.slot() % 2 == 0 ? "CORN" : "TOMATO"));
        for (String house : List.of("COOP", "DUCK_POND", "PIG_PEN")) env.animals.buildHouse(u, key(), house);
        for (String species : List.of("CHICKEN", "CHICKEN", "CHICKEN", "DUCK", "DUCK", "PIG", "CAT", "GOOSE", "DOG")) env.animals.buy(u, key(), species);
        for (String code : List.of("HOUSE_BLOSSOM", "FENCE_BAMBOO", "DECOR_LANTERN_STONE")) env.cosmetics.buy(u, key(), new CosmeticBuyRequest(code));
        env.clock.advance(Duration.ofMinutes(45));
        env.state.state(u); // pests settle, orders materialise
        return u;
    }

    record Row(String query, long calls, double ms) {}

    static List<Row> measure(int runs, Runnable request) {
        request.run(); // warm: lazily loaded rules, one-off inserts
        jdbc.execute("SELECT pg_stat_statements_reset()");
        for (int i = 0; i < runs; i++) request.run();
        return jdbc.query("""
                SELECT regexp_replace(left(query, 150), '\\s+', ' ', 'g') AS q, calls, total_exec_time FROM pg_stat_statements
                WHERE query NOT LIKE '%pg_stat_statements%' AND query NOT ILIKE 'BEGIN%' AND query NOT ILIKE 'COMMIT%'
                  AND query NOT ILIKE 'SET %' AND query NOT ILIKE 'SHOW %'
                ORDER BY calls DESC, total_exec_time DESC""", (rs, n) -> new Row(rs.getString(1), rs.getLong(2), rs.getDouble(3)));
    }

    static double perRequest(List<Row> rows, int runs) {
        return rows.stream().mapToLong(Row::calls).sum() / (double) runs;
    }

    static String table(String title, List<Row> rows, int runs) {
        StringBuilder sb = new StringBuilder();
        sb.append(String.format("== %s: %.1f statements per request, %.2f ms SQL per request (%d runs)%n", title, perRequest(rows, runs),
                rows.stream().mapToDouble(Row::ms).sum() / runs, runs));
        for (Row r : rows) sb.append(String.format("%6.1f  %7.3f ms  %s%n", r.calls() / (double) runs, r.ms() / runs, r.query()));
        return sb.toString();
    }

    @Test
    void oneStateReadStaysInsideItsStatementBudget() throws Exception {
        int runs = 20;
        Map<String, Runnable> requests = new java.util.LinkedHashMap<>();
        requests.put("GET /state", () -> env.state.state(user));
        requests.put("GET /cosmetics (shop)", () -> env.cosmetics.shop(user));
        requests.put("GET /social/islands (discover)", () -> env.social.discover(user, null, null));
        StringBuilder report = new StringBuilder();
        double state = 0;
        for (var e : requests.entrySet()) {
            List<Row> rows = measure(runs, e.getValue());
            if (e.getKey().startsWith("GET /state")) state = perRequest(rows, runs);
            report.append(table(e.getKey(), rows, runs)).append(System.lineSeparator());
        }
        // Phase 5: what the wire shows for one state read — every exchange with the database, the COMMIT included
        env.state.state(user);
        long best = Long.MAX_VALUE;
        for (int i = 0; i < 5; i++) {
            long before = env.wire.roundTrips();
            env.state.state(user);
            best = Math.min(best, env.wire.roundTrips() - before);
        }
        List<String> trace = new ArrayList<>();
        com.englishcoach.garden.infra.GardenJdbc.observe(trace::add);
        try {
            env.state.state(user);
        } finally {
            com.englishcoach.garden.infra.GardenJdbc.observe(null);
        }
        report.append("== GET /state: ").append(best).append(" network round trips (wire)").append(System.lineSeparator());
        for (String line : trace) report.append("   ").append(line.length() > 150 ? line.substring(0, 150) : line).append(System.lineSeparator());
        Files.writeString(Path.of("target", "garden-statement-budget.txt"), report.toString());
        System.out.println(report);
        assertTrue(state <= STATE_BUDGET, "GET /state used " + state + " statements; budget " + STATE_BUDGET);
        assertTrue(best <= STATE_ROUND_TRIPS, "GET /state made " + best + " network round trips; budget " + STATE_ROUND_TRIPS);
    }
}
