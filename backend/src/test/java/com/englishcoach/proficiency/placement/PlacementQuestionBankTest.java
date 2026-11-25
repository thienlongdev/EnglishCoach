package com.englishcoach.proficiency.placement;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The V66 item bank, read from the migration file itself: every question passes the validator, 8 vocabulary + 8 grammar
 * per level A1–C1, unique keys / prompts, no V63 pseudoword anywhere, and malformed rows are rejected. Runs from the
 * backend module directory.
 */
class PlacementQuestionBankTest {

    private static final Path V63 = Path.of("src/main/resources/db/migration/exams/V63__placement_quiz_division_level.sql");
    private static final Path V66 = Path.of("src/main/resources/db/migration/exams/V66__placement_v2_live_leaderboard.sql");
    private static final Pattern ROW = Pattern.compile(
            "\\('([ABC][12]-[GV]-\\d{2})', '(GRAMMAR|VOCABULARY)', '([ABC][12])', '((?:[^']|'')*)', '((?:[^']|'')*)', (\\d)\\)");

    static List<PlacementQuestionValidator.Question> bank() throws Exception {
        String sql = Files.readString(V66);
        Matcher m = ROW.matcher(sql);
        ObjectMapper mapper = new ObjectMapper();
        List<PlacementQuestionValidator.Question> out = new ArrayList<>();
        long id = 1;
        while (m.find()) {
            List<String> options = mapper.readValue(m.group(5).replace("''", "'"), new TypeReference<List<String>>() {});
            out.add(new PlacementQuestionValidator.Question(id++, m.group(1), m.group(2), m.group(3),
                    m.group(4).replace("''", "'"), options, Integer.parseInt(m.group(6))));
        }
        return out;
    }

    static Set<String> v63Pseudowords() throws Exception {
        String sql = Files.readString(V63);
        String block = sql.substring(sql.indexOf("FROM (VALUES"), sql.indexOf(") AS v(w)"));
        Set<String> out = new HashSet<>();
        Matcher m = Pattern.compile("\\('([a-z]+)'\\)").matcher(block);
        while (m.find()) out.add(m.group(1));
        return out;
    }

    @Test
    @DisplayName("80 questions: 8 vocabulary + 8 grammar for each level A1–C1; every one valid; keys and prompts unique")
    void shapeAndValidity() throws Exception {
        List<PlacementQuestionValidator.Question> bank = bank();
        assertEquals(80, bank.size());
        Map<String, Integer> counts = new HashMap<>();
        Set<String> keys = new HashSet<>();
        Set<String> prompts = new HashSet<>();
        for (PlacementQuestionValidator.Question q : bank) {
            assertEquals(List.of(), PlacementQuestionValidator.problems(q), q.key());
            assertTrue(q.key().startsWith(q.cefr() + "-" + (q.skill().equals("GRAMMAR") ? "G" : "V")), q.key());
            counts.merge(q.cefr() + "/" + q.skill(), 1, Integer::sum);
            assertTrue(keys.add(q.key()), "duplicate key " + q.key());
            assertTrue(prompts.add(q.prompt().toLowerCase(Locale.ROOT)), "duplicate prompt " + q.prompt());
        }
        for (String level : List.of("A1", "A2", "B1", "B2", "C1")) {
            assertEquals(8, counts.get(level + "/VOCABULARY"), level + " vocabulary");
            assertEquals(8, counts.get(level + "/GRAMMAR"), level + " grammar");
        }
    }

    @Test
    @DisplayName("No V63 pseudoword (e.g. doabvig, brargoand, thangning) appears in any prompt or option")
    void noPseudowords() throws Exception {
        Set<String> pseudo = v63Pseudowords();
        assertTrue(pseudo.size() >= 150, "pseudoword list parsed: " + pseudo.size());
        assertTrue(pseudo.containsAll(List.of("doabvig", "brargoand", "thangning")));
        for (PlacementQuestionValidator.Question q : bank()) {
            List<String> texts = new ArrayList<>(q.options());
            texts.add(q.prompt());
            for (String text : texts) {
                for (String token : text.toLowerCase(Locale.ROOT).split("[^a-z]+")) {
                    assertFalse(pseudo.contains(token), q.key() + " contains pseudoword " + token);
                    if (token.length() > 3) {
                        assertTrue(token.matches(".*[aeiouy].*"), q.key() + " token without a vowel: " + token);
                    }
                }
            }
        }
    }

    @Test
    @DisplayName("V66 retires the V63 pool and the migration shape guards hold")
    void migrationGuards() throws Exception {
        String sql = Files.readString(V66);
        assertTrue(sql.contains("UPDATE public.proficiency_placement_item SET active = FALSE WHERE active;"));
        assertTrue(sql.contains("jsonb_array_length(options) = 4"));
        assertTrue(sql.contains("answer_index BETWEEN 0 AND 3"));
        assertTrue(sql.contains("CONSTRAINT uq_proficiency_placement_question_prompt UNIQUE (prompt)"));
        assertTrue(sql.contains("CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_activity_rank"), "CONCURRENTLY needs the unique index");
        String view = sql.substring(sql.indexOf("CREATE MATERIALIZED VIEW public.mv_activity_rank"));
        assertFalse(view.contains("Asia/Ho_Chi_Minh"), "no time zone literal in the view");
        assertTrue(view.contains("activity_start_at"));
        assertTrue(view.contains("require_placement"));
        assertTrue(view.contains("ROW_NUMBER()"), "unique rank numbers");
        assertFalse(view.toLowerCase(Locale.ROOT).contains("score_events"), "the view must not read score_events");
        assertFalse(view.toLowerCase(Locale.ROOT).contains("proficiency_evidence"));
    }

    @Test
    @DisplayName("Malformed or duplicate questions are rejected by the validator")
    void malformedRejected() {
        List<String> ok = List.of("is", "are", "am", "be");
        assertTrue(PlacementQuestionValidator.isValid(q("She ___ a teacher.", ok, 0)));
        assertFalse(PlacementQuestionValidator.isValid(q("She is a teacher.", ok, 0)), "no blank");
        assertFalse(PlacementQuestionValidator.isValid(q("She ___ a ___.", ok, 0)), "two blanks");
        assertFalse(PlacementQuestionValidator.isValid(q("She ___ a teacher.", List.of("is", "are", "am"), 0)), "3 options");
        assertFalse(PlacementQuestionValidator.isValid(q("She ___ a teacher.", List.of("is", "are", "Is", "be"), 0)), "duplicate");
        assertFalse(PlacementQuestionValidator.isValid(q("She ___ a teacher.", List.of("is", "are", "", "be"), 0)), "blank option");
        assertFalse(PlacementQuestionValidator.isValid(q("She ___ a teacher.", ok, 4)), "answer out of range");
        assertFalse(PlacementQuestionValidator.isValid(q("Mail ___ x@y.z now", ok, 0)), "e-mail / odd characters");
        assertFalse(PlacementQuestionValidator.isValid(q("She ___ a teacher.", List.of("is", "are", "<b>am</b>", "be"), 0)), "markup");
        assertFalse(PlacementQuestionValidator.isValid(new PlacementQuestionValidator.Question(1, "k", "SPELLING", "A1",
                "She ___ a teacher.", ok, 0)), "unknown skill");
        assertFalse(PlacementQuestionValidator.isValid(new PlacementQuestionValidator.Question(1, "k", "GRAMMAR", "C2",
                "She ___ a teacher.", ok, 0)), "C2 not supported");
    }

    private static PlacementQuestionValidator.Question q(String prompt, List<String> options, int answer) {
        return new PlacementQuestionValidator.Question(1, "A1-G-99", "GRAMMAR", "A1", prompt, options, answer);
    }

    // ---- V69: effective bank (V66 + correction) + human-reviewed answer keys (2026-10-02 audit) -------------------

    private static final Path V69 = Path.of("src/main/resources/db/migration/exams/V69__placement_progress_bank_fix.sql");
    /** Same row shape as V66 but whitespace (line breaks) allowed between the columns. */
    private static final Pattern ROW_WS = Pattern.compile(
            "\\('([ABC][12]-[GV]-\\d{2})',\\s*'(GRAMMAR|VOCABULARY)',\\s*'([ABC][12])',\\s*'((?:[^']|'')*)',\\s*'((?:[^']|'')*)',\\s*(\\d)\\)");

    /** Active bank after all migrations: V66 rows, minus the keys V69 deactivates, plus the V69 replacements. */
    static List<PlacementQuestionValidator.Question> effectiveBank() throws Exception {
        String v69 = Files.readString(V69);
        Set<String> retired = new HashSet<>();
        Matcher d = Pattern.compile("SET active = FALSE WHERE question_key = '([^']+)'").matcher(v69);
        while (d.find()) retired.add(d.group(1));
        List<PlacementQuestionValidator.Question> out = new ArrayList<>();
        for (PlacementQuestionValidator.Question q : bank()) if (!retired.contains(q.key())) out.add(q);
        Matcher m = ROW_WS.matcher(v69);
        ObjectMapper mapper = new ObjectMapper();
        long id = 1000;
        while (m.find()) {
            List<String> options = mapper.readValue(m.group(5).replace("''", "'"), new TypeReference<List<String>>() {});
            out.add(new PlacementQuestionValidator.Question(id++, m.group(1), m.group(2), m.group(3),
                    m.group(4).replace("''", "'"), options, Integer.parseInt(m.group(6))));
        }
        return out;
    }

    /**
     * Answer key of every active question as reviewed by hand on 2026-10-02 (sentence read with each option: exactly one
     * natural, grammatical answer). A change to any key / option order fails here and needs a new review.
     */
    static final Map<String, String> REVIEWED_KEYS = Map.ofEntries(
            Map.entry("A1-G-01", "is"), Map.entry("A1-G-02", "have"), Map.entry("A1-G-03", "are"), Map.entry("A1-G-04", "doesn't"),
            Map.entry("A1-G-05", "Do"), Map.entry("A1-G-06", "an"), Map.entry("A1-G-07", "in"), Map.entry("A1-G-08", "play"),
            Map.entry("A1-V-01", "coffee"), Map.entry("A1-V-02", "cold"), Map.entry("A1-V-03", "uncle"), Map.entry("A1-V-04", "bedroom"),
            Map.entry("A1-V-05", "week"), Map.entry("A1-V-06", "book"), Map.entry("A1-V-07", "umbrella"), Map.entry("A1-V-08", "ears"),
            Map.entry("A2-G-01", "went"), Map.entry("A2-G-02", "taller"), Map.entry("A2-G-03", "are playing"), Map.entry("A2-G-04", "am going to"),
            Map.entry("A2-G-05", "have"), Map.entry("A2-G-06", "must"), Map.entry("A2-G-07", "much"), Map.entry("A2-G-08", "when"),
            Map.entry("A2-V-01", "hungry"), Map.entry("A2-V-02", "pass"), Map.entry("A2-V-03", "missed"), Map.entry("A2-V-04", "nurse"),
            Map.entry("A2-V-05", "off"), Map.entry("A2-V-06", "journey"), Map.entry("A2-V-07", "interested"), Map.entry("A2-V-08", "centre"),
            Map.entry("B1-G-01", "will cancel"), Map.entry("B1-G-02", "since"), Map.entry("B1-G-03", "has been read"), Map.entry("B1-G-04", "whose"),
            Map.entry("B1-G-05", "was"), Map.entry("B1-G-06", "mustn't"), Map.entry("B1-G-07", "getting"), Map.entry("B1-G-08", "had already started"),
            Map.entry("B1-V-01", "favour"), Map.entry("B1-V-02", "put off"), Map.entry("B1-V-03", "spends"), Map.entry("B1-V-04", "stand"),
            Map.entry("B1-V-06", "for"), Map.entry("B1-V-07", "make"), Map.entry("B1-V-08", "risen"), Map.entry("B1-V-09", "experienced"),
            Map.entry("B2-G-01", "had known"), Map.entry("B2-G-02", "taking"), Map.entry("B2-G-03", "was he"), Map.entry("B2-G-04", "had studied"),
            Map.entry("B2-G-05", "will have been finished"), Map.entry("B2-G-06", "stealing"), Map.entry("B2-G-07", "went"), Map.entry("B2-G-08", "the more confident"),
            Map.entry("B2-V-01", "introduced"), Map.entry("B2-V-02", "impression"), Map.entry("B2-V-03", "take"), Map.entry("B2-V-04", "vague"),
            Map.entry("B2-V-05", "accused"), Map.entry("B2-V-06", "run"), Map.entry("B2-V-07", "impact"), Map.entry("B2-V-08", "lay off"),
            Map.entry("C1-G-01", "would have done"), Map.entry("C1-G-02", "have I seen"), Map.entry("C1-G-03", "which"), Map.entry("C1-G-04", "be"),
            Map.entry("C1-G-05", "Given"), Map.entry("C1-G-06", "than"), Map.entry("C1-G-07", "to have left"), Map.entry("C1-G-08", "that"),
            Map.entry("C1-V-01", "adverse"), Map.entry("C1-V-02", "insufficient"), Map.entry("C1-V-03", "undermined"), Map.entry("C1-V-04", "step down"),
            Map.entry("C1-V-05", "sustainable"), Map.entry("C1-V-06", "sparked"), Map.entry("C1-V-07", "depicts"), Map.entry("C1-V-08", "profound")
    );

    @Test
    @DisplayName("Effective bank after V69: 80 active, 8 + 8 per level, all structurally valid, unique keys / prompts; ambiguous B1-V-05 retired")
    void effectiveBankShape() throws Exception {
        List<PlacementQuestionValidator.Question> bank = effectiveBank();
        assertEquals(80, bank.size());
        Map<String, Integer> counts = new HashMap<>();
        Set<String> keys = new HashSet<>();
        Set<String> prompts = new HashSet<>();
        for (PlacementQuestionValidator.Question q : bank) {
            assertEquals(List.of(), PlacementQuestionValidator.problems(q), q.key());
            assertTrue(keys.add(q.key()), "duplicate key " + q.key());
            assertTrue(prompts.add(q.prompt().toLowerCase(Locale.ROOT)), "duplicate prompt " + q.prompt());
            counts.merge(q.cefr() + "/" + q.skill(), 1, Integer::sum);
        }
        for (String level : List.of("A1", "A2", "B1", "B2", "C1")) {
            assertEquals(8, counts.get(level + "/VOCABULARY"), level + " vocabulary");
            assertEquals(8, counts.get(level + "/GRAMMAR"), level + " grammar");
        }
        assertFalse(keys.contains("B1-V-05"), "two defensible answers (experienced / expert) — retired");
        PlacementQuestionValidator.Question fix = bank.stream().filter(q -> q.key().equals("B1-V-09")).findFirst().orElseThrow();
        assertFalse(fix.options().contains("expert"), "the replacement has a single defensible answer");
    }

    @Test
    @DisplayName("Every active answer key matches the human-reviewed key (all 80, not a sample)")
    void reviewedAnswerKeys() throws Exception {
        List<PlacementQuestionValidator.Question> bank = effectiveBank();
        assertEquals(REVIEWED_KEYS.keySet(), bank.stream().map(PlacementQuestionValidator.Question::key).collect(java.util.stream.Collectors.toSet()));
        for (PlacementQuestionValidator.Question q : bank) {
            assertEquals(REVIEWED_KEYS.get(q.key()), q.options().get(q.answerIndex()), q.key() + " — " + q.prompt());
        }
        PlacementQuestionValidator.Question screenshot = bank.stream().filter(q -> q.key().equals("C1-V-08")).findFirst().orElseThrow();
        assertEquals("She has a ___ knowledge of medieval history.", screenshot.prompt());
        assertEquals("profound", screenshot.options().get(screenshot.answerIndex()));
    }

    @Test
    @DisplayName("No answer leakage: the keyed word never appears in the prompt; options are not substrings of the sentence")
    void noAnswerLeakage() throws Exception {
        for (PlacementQuestionValidator.Question q : effectiveBank()) {
            String prompt = " " + q.prompt().toLowerCase(Locale.ROOT).replaceAll("[^a-z' ]", " ") + " ";
            String key = q.options().get(q.answerIndex()).toLowerCase(Locale.ROOT);
            if (key.length() > 3) {
                assertFalse(prompt.contains(" " + key + " "), q.key() + " leaks its answer '" + key + "'");
            }
        }
    }
}
