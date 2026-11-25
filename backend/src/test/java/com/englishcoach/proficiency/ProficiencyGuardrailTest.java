package com.englishcoach.proficiency;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Static guardrails (grep evidence) for the Proficiency hardening rules. Run from the backend
 * module directory (surefire default).
 */
class ProficiencyGuardrailTest {

    private static final Path MAIN = Path.of("src/main/java");
    private static final Path PROFICIENCY = MAIN.resolve("com/englishcoach/proficiency");

    private static List<Path> javaFiles(Path root) throws IOException {
        try (Stream<Path> s = Files.walk(root)) {
            return s.filter(p -> p.toString().endsWith(".java")).toList();
        }
    }

    private static String read(Path p) {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    /** Source without comment lines (Javadoc / line comments may legitimately name forbidden tables). */
    private static String code(String src) {
        StringBuilder sb = new StringBuilder();
        for (String line : src.split("\n")) {
            String t = line.trim();
            if (t.startsWith("*") || t.startsWith("/*") || t.startsWith("//")) continue;
            sb.append(line).append('\n');
        }
        return sb.toString();
    }

    @Test
    @DisplayName("No code path writes observed_rating into skill_proficiency.rating")
    void ratingOnlyFromCalculator() throws IOException {
        for (Path p : javaFiles(MAIN)) {
            String src = read(p);
            String[] parts = src.split("\"\"\"");
            for (int k = 1; k < parts.length; k += 2) { // odd segments = SQL text blocks
                String lower = parts[k].toLowerCase(Locale.ROOT);
                if (lower.contains("skill_proficiency") && (lower.contains("insert") || lower.contains("update"))) {
                    assertFalse(lower.contains("observed_rating"), "SQL mixes observed_rating into skill_proficiency: " + p);
                }
            }
        }
        // the only writer of skill_proficiency.rating takes a SkillRatingCalculator.Result
        Method writer = Arrays.stream(ProficiencyStateRepository.class.getDeclaredMethods())
                .filter(m -> m.getName().equals("upsertSkillFromCalculation")).findFirst().orElseThrow();
        assertEquals(SkillRatingCalculator.Result.class, writer.getParameterTypes()[1]);
        List<String> ratingWriters = new ArrayList<>();
        for (Method m : ProficiencyStateRepository.class.getDeclaredMethods()) {
            if (Modifier.isPublic(m.getModifiers()) && m.getName().toLowerCase(Locale.ROOT).contains("skill")
                    && !m.getName().startsWith("find")) {
                ratingWriters.add(m.getName());
            }
        }
        assertEquals(List.of("refreshSkill", "upsertSkillFromCalculation"), ratingWriters.stream().sorted().toList());
        String refresh = read(PROFICIENCY.resolve("ProficiencyStateRepository.java"));
        int i = refresh.indexOf("UPDATE public.skill_proficiency");
        String refreshSql = refresh.substring(i, refresh.indexOf("WHERE", i));
        assertFalse(refreshSql.contains("rating"), "nightly refresh must never set rating");
    }

    @Test
    @DisplayName("Package proficiency never queries score_events / leaderboard_content_cefr nor imports leaderboard")
    void pipelineSeparation() throws IOException {
        for (Path p : javaFiles(PROFICIENCY)) {
            String src = code(read(p));
            assertFalse(src.contains("score_events"), "score_events referenced in " + p);
            assertFalse(src.contains("leaderboard_content_cefr"), "leaderboard_content_cefr referenced in " + p);
            for (String line : src.split("\n")) {
                assertFalse(line.startsWith("import com.englishcoach.leaderboard."),
                        "forbidden leaderboard import in " + p + ": " + line.trim());
            }
            assertFalse(src.contains("publishEvent("), "proficiency must not publish events: " + p);
        }
    }

    @Test
    @DisplayName("publishEvent lines in source modules unchanged since Phase 1.1 (8 activity events, 11 total)")
    void publishEventCountUnchanged() throws IOException {
        int total = 0;
        int activityEvents = 0;
        for (Path p : javaFiles(MAIN)) {
            for (String line : read(p).split("\n")) {
                if (line.contains("publishEvent(")) {
                    total += line.split("publishEvent\\(", -1).length - 1;
                    if (line.contains("publishEvent(new com.englishcoach.leaderboard.activity.event.")
                            || line.contains("publishEvent(new com.englishcoach.common.event.")) {
                        activityEvents++;
                    }
                }
            }
        }
        assertEquals(8, activityEvents);
        assertEquals(11, total);
    }

    @Test
    @DisplayName("Evidence repository exposes only insert/select style methods (append-only ledger)")
    void evidenceRepositoryHasNoMutators() {
        for (Method m : ProficiencyEvidenceRepository.class.getDeclaredMethods()) {
            if (!Modifier.isPublic(m.getModifiers())) continue;
            String n = m.getName().toLowerCase(Locale.ROOT);
            assertTrue(n.startsWith("insert") || n.startsWith("find") || n.startsWith("has") || n.startsWith("lock"),
                    "unexpected evidence method: " + m.getName());
            assertFalse(n.contains("update") || n.contains("delete") || n.contains("remove"), m.getName());
        }
    }
}
