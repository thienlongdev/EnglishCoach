package com.englishcoach.leaderboard.board;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/** Static guardrails (grep evidence) for the Phase 3 hardening rules. Runs from the backend module dir. */
class LeaderboardPhase3GuardrailTest {

    private static final Path MAIN = Path.of("src/main/java/com/englishcoach");
    private static final Path ROLLUP = MAIN.resolve("leaderboard/activity/rollup");
    private static final Path BOARD = MAIN.resolve("leaderboard/board");
    private static final Path PROFICIENCY_BOARD = MAIN.resolve("proficiency/board");
    private static final Path V54 = Path.of("src/main/resources/db/migration/exams/V54__leaderboard_rollup.sql");
    private static final Path V57 = Path.of("src/main/resources/db/migration/exams/V57__leaderboard_rollup_precision.sql");

    private static List<Path> javaFiles(Path... roots) throws IOException {
        List<Path> out = new ArrayList<>();
        for (Path root : roots) {
            try (Stream<Path> s = Files.walk(root)) {
                s.filter(p -> p.toString().endsWith(".java")).forEach(out::add);
            }
        }
        return out;
    }

    /** Source without comment lines. */
    private static String code(Path p) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (String line : Files.readString(p).split("\n")) {
            String t = line.trim();
            if (t.startsWith("*") || t.startsWith("/*") || t.startsWith("//")) continue;
            sb.append(line).append('\n');
        }
        return sb.toString();
    }

    @Test
    @DisplayName("Read path: only the rollup writer touches score_events; nothing in Phase 3 touches proficiency_evidence")
    void readPathSeparation() throws IOException {
        for (Path p : javaFiles(ROLLUP, BOARD, PROFICIENCY_BOARD)) {
            String src = code(p);
            assertFalse(src.contains("proficiency_evidence"), "proficiency_evidence referenced in " + p);
            if (!p.getFileName().toString().equals("ActivityRollupRepository.java")) {
                assertFalse(src.contains("score_events"), "score_events referenced outside the rollup writer: " + p);
            }
        }
        String views = Files.readString(V54).replaceAll("(?m)--.*$", "").toLowerCase(Locale.ROOT);
        assertFalse(views.contains("score_events"), "views/tables of V54 must not read score_events");
        assertFalse(views.contains("proficiency_evidence"), "views/tables of V54 must not read proficiency_evidence");
    }

    @Test
    @DisplayName("Append-only ledgers: no UPDATE/DELETE/TRUNCATE of score_events or proficiency_evidence in Phase 3 code")
    void appendOnly() throws IOException {
        for (Path p : javaFiles(ROLLUP, BOARD, PROFICIENCY_BOARD)) {
            String src = code(p).toLowerCase(Locale.ROOT).replaceAll("\\s+", " ");
            for (String table : List.of("score_events", "proficiency_evidence")) {
                assertFalse(src.contains("update public." + table) || src.contains("delete from public." + table)
                        || src.contains("truncate public." + table), table + " mutated in " + p);
            }
        }
    }

    @Test
    @DisplayName("No N+1: rollup/views never call UserLevelProvider / ProficiencyLevelQuery; no publishEvent")
    void noPerUserLookupsNoEvents() throws IOException {
        for (Path p : javaFiles(ROLLUP, BOARD, PROFICIENCY_BOARD)) {
            String src = code(p);
            assertFalse(src.contains("UserLevelProvider"), "per-user level lookup in " + p);
            assertFalse(src.contains("ProficiencyLevelQuery"), "per-user level lookup in " + p);
            assertFalse(src.contains("publishEvent("), "publishEvent in " + p);
        }
    }

    @Test
    @DisplayName("Proficiency board imports nothing from leaderboard; Activity rollup imports nothing from proficiency")
    void packageDirection() throws IOException {
        for (Path p : javaFiles(PROFICIENCY_BOARD)) {
            assertFalse(code(p).contains("import com.englishcoach.leaderboard."), "leaderboard import in " + p);
        }
        for (Path p : javaFiles(ROLLUP)) {
            assertFalse(code(p).contains("import com.englishcoach.proficiency."), "proficiency import in " + p);
        }
    }

    @Test
    @DisplayName("ALL_TIME / start-at and time zone are not hard-coded in the view SQL (read from leaderboard_refresh_state)")
    void noHardCodedStartAt() throws IOException {
        String sql = Files.readString(V54);
        int view = sql.indexOf("CREATE MATERIALIZED VIEW public.mv_activity_rank");
        String body = sql.substring(view, sql.indexOf("WITH DATA", view));
        assertTrue(body.contains("activity_start_at"));
        assertFalse(body.matches("(?s).*'20\\d\\d-\\d\\d-\\d\\d.*"), "date literal in mv_activity_rank");
        assertFalse(body.contains("Asia/Ho_Chi_Minh"), "time zone literal in mv_activity_rank");
    }

    @Test
    @DisplayName("Phase 3.1 V57: view keeps config from refresh state, rounds once per period; score_events only gains an index")
    void v57Guardrails() throws IOException {
        String sql = Files.readString(V57).replaceAll("(?m)--.*$", "");
        int view = sql.indexOf("CREATE MATERIALIZED VIEW public.mv_activity_rank");
        String body = sql.substring(view, sql.indexOf("WITH DATA", view));
        assertTrue(body.contains("activity_start_at"));
        assertTrue(body.contains("ROUND(SUM(d.points))"), "period sum rounded once");
        assertFalse(body.contains("score_events"), "view must not read score_events");
        assertFalse(body.contains("proficiency_evidence"));
        assertFalse(body.matches("(?s).*'20\\d\\d-\\d\\d-\\d\\d.*"), "date literal in mv_activity_rank");
        assertFalse(body.contains("Asia/Ho_Chi_Minh"), "time zone literal in mv_activity_rank");
        assertTrue(sql.contains("CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_activity_rank"), "CONCURRENTLY needs the unique index");
        String lower = sql.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ");
        int mentions = lower.split("public.score_events", -1).length - 1;
        assertEquals(1, mentions, "score_events referenced only by the new created_at index");
        assertTrue(lower.contains("create index if not exists idx_score_events_created_at on public.score_events (created_at)"));
    }
}
