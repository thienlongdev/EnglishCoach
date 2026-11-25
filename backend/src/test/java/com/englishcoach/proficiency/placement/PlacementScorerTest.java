package com.englishcoach.proficiency.placement;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Placement model 2 (vocabulary + grammar multiple choice). Deterministic learner profiles per CEFR level, edge cases
 * (all skipped, all wrong, reversed pattern) and a seeded population simulation that checks accuracy and the absence
 * of a systematic bias (the model-1 quiz collapsed strong learners to B1).
 */
class PlacementScorerTest {

    static final List<String> LEVELS = List.of("A1", "A2", "B1", "B2", "C1");
    static final PlacementScorer.Params P = PlacementScorer.Params.defaults(LEVELS);

    /** 4 vocabulary + 4 grammar per level (the previous 40-item form); the correct option is always index 0 here. */
    static List<PlacementScorer.Item> items() {
        return items(4, 4);
    }

    /** {@code v} vocabulary + {@code g} grammar items per level A1–C1. */
    static List<PlacementScorer.Item> items(int v, int g) {
        List<PlacementScorer.Item> out = new ArrayList<>();
        int i = 0;
        for (String level : LEVELS) {
            for (int k = 0; k < v + g; k++) {
                String skill = k < v ? PlacementScorer.VOCABULARY : PlacementScorer.GRAMMAR;
                out.add(new PlacementScorer.Item(i++, i, skill, level, "Prompt ___ " + i, List.of("a", "b", "c", "d"), 0));
            }
        }
        return out;
    }

    /** The production quick form, from the property defaults (3 vocabulary + 3 grammar per level = 30). */
    static final PlacementQuizProperties QUICK = new PlacementQuizProperties();

    static List<PlacementScorer.Item> quickItems() {
        return items(QUICK.getVocabularyPerLevel(), QUICK.getGrammarPerLevel());
    }

    /** Per level {right, wrong} on the 6-item quick blocks (V0 G0 V1 G1 V2 G2 fill order); the rest skipped. */
    static PlacementScorer.Result scoreQuick(int[][] perLevel) {
        int[] fill = {0, 3, 1, 4, 2, 5};
        List<Integer> out = new ArrayList<>();
        for (int[] rw : perLevel) {
            Integer[] block = new Integer[6];
            for (int j = 0; j < 6; j++) {
                if (j < rw[0]) block[fill[j]] = 0;
                else if (j < rw[0] + rw[1]) block[fill[j]] = 2;
            }
            out.addAll(java.util.Arrays.asList(block));
        }
        return PlacementScorer.score(quickItems(), out, QUICK.scorerParams());
    }

    /** Fill order inside a level block (V0 G0 V1 G1 …) so rights and wrongs are spread over both skills. */
    static final int[] FILL = {0, 4, 1, 5, 2, 6, 3, 7};

    /** Per level: {right, wrong}; the rest is skipped ("Tôi chưa biết" = null). Wrong = option 2. */
    static List<Integer> answers(int[][] perLevel) {
        List<Integer> out = new ArrayList<>();
        for (int[] rw : perLevel) {
            Integer[] block = new Integer[8];
            for (int j = 0; j < 8; j++) {
                if (j < rw[0]) block[FILL[j]] = 0;
                else if (j < rw[0] + rw[1]) block[FILL[j]] = 2;
            }
            out.addAll(java.util.Arrays.asList(block));
        }
        return out;
    }

    static PlacementScorer.Result score(int[][] perLevel) {
        return PlacementScorer.score(items(), answers(perLevel), P);
    }

    @Test
    @DisplayName("A1 learner: most A1 right, little above ⇒ A1")
    void a1() {
        PlacementScorer.Result r = score(new int[][]{{6, 1}, {2, 2}, {0, 2}, {0, 0}, {0, 0}});
        assertEquals("VALID", r.status());
        assertEquals("A1", r.resultCefr());
    }

    @Test
    @DisplayName("A2 learner ⇒ A2")
    void a2() {
        assertEquals("A2", score(new int[][]{{8, 0}, {6, 1}, {2, 3}, {1, 3}, {0, 0}}).resultCefr());
    }

    @Test
    @DisplayName("B1 learner ⇒ B1")
    void b1() {
        assertEquals("B1", score(new int[][]{{8, 0}, {8, 0}, {6, 2}, {3, 3}, {1, 4}}).resultCefr());
    }

    @Test
    @DisplayName("B2 learner ⇒ B2")
    void b2() {
        assertEquals("B2", score(new int[][]{{8, 0}, {8, 0}, {8, 0}, {6, 2}, {2, 4}}).resultCefr());
    }

    @Test
    @DisplayName("C1 learner ⇒ C1")
    void c1() {
        PlacementScorer.Result r = score(new int[][]{{8, 0}, {8, 0}, {8, 0}, {8, 0}, {6, 2}});
        assertEquals("C1", r.resultCefr());
        assertFalse(r.lowConfidence());
    }

    @Test
    @DisplayName("C2 is not supported: a perfect score is capped at C1")
    void perfectCappedAtC1() {
        PlacementScorer.Result r = score(new int[][]{{8, 0}, {8, 0}, {8, 0}, {8, 0}, {8, 0}});
        assertEquals("C1", r.resultCefr());
        assertEquals(5.0, r.score(), 1e-9);
    }

    @Test
    @DisplayName("Strong learner with one noisy level (the model-1 B1 collapse) is not pulled down to B1")
    void strongLearnerNoisyB2() {
        // model 1 stopped at the first level below the pass rate; prod pattern: B2 0.59 but C1 1.0 ⇒ B1
        PlacementScorer.Result r = score(new int[][]{{8, 0}, {8, 0}, {8, 0}, {5, 3}, {8, 0}});
        assertEquals("C1", r.resultCefr());
        PlacementScorer.Result r2 = score(new int[][]{{8, 0}, {8, 0}, {7, 1}, {4, 4}, {6, 2}});
        assertTrue(List.of("B2", "C1").contains(r2.resultCefr()), r2.resultCefr());
    }

    @Test
    @DisplayName("Weak learner with lucky guesses never reaches B2 / C1")
    void weakLearnerStaysLow() {
        // knows A1, guesses everything else (expected 2 right / 6 wrong per level ⇒ mastery 0)
        PlacementScorer.Result r = score(new int[][]{{7, 1}, {2, 6}, {3, 5}, {2, 6}, {2, 6}});
        assertEquals("A1", r.resultCefr());
        // lucky streak at B1 only
        PlacementScorer.Result r2 = score(new int[][]{{8, 0}, {4, 4}, {5, 3}, {2, 6}, {1, 7}});
        assertTrue(List.of("A1", "A2").contains(r2.resultCefr()), r2.resultCefr());
    }

    @Test
    @DisplayName("Honest skips are not penalised; blind guessing averages zero")
    void formulaScoring() {
        PlacementScorer.Result skipped = score(new int[][]{{8, 0}, {8, 0}, {4, 0}, {0, 0}, {0, 0}});
        PlacementScorer.Result guessed = score(new int[][]{{8, 0}, {8, 0}, {4, 4}, {0, 0}, {0, 0}});
        assertEquals(0.5, skipped.levelRates().get("B1"), 1e-9);
        assertEquals(0.333, guessed.levelRates().get("B1"), 1e-9);
        assertEquals(0.0, score(new int[][]{{2, 6}, {2, 6}, {2, 6}, {2, 6}, {2, 6}}).score(), 1e-9);
    }

    @Test
    @DisplayName("Everything skipped or wrong ⇒ VALID A1 with low confidence")
    void beginner() {
        PlacementScorer.Result skipped = score(new int[][]{{0, 0}, {0, 0}, {0, 0}, {0, 0}, {0, 0}});
        assertEquals("VALID", skipped.status());
        assertEquals("A1", skipped.resultCefr());
        assertTrue(skipped.lowConfidence());
        PlacementScorer.Result wrong = score(new int[][]{{0, 8}, {0, 8}, {0, 8}, {0, 8}, {0, 8}});
        assertEquals("A1", wrong.resultCefr());
        assertTrue(wrong.lowConfidence());
    }

    @Test
    @DisplayName("Reversed pattern (hard right, easy wrong) ⇒ INVALID, no level")
    void reversedInvalid() {
        PlacementScorer.Result r = score(new int[][]{{1, 7}, {2, 6}, {4, 4}, {8, 0}, {8, 0}});
        assertEquals("INVALID", r.status());
        assertNull(r.resultCefr());
    }

    @Test
    @DisplayName("Per-skill counts are reported (vocabulary and grammar both measured)")
    void skillCounts() {
        PlacementScorer.Result r = score(new int[][]{{8, 0}, {8, 0}, {6, 2}, {2, 2}, {0, 0}});
        assertEquals(20, r.skills().get(PlacementScorer.VOCABULARY).total());
        assertEquals(20, r.skills().get(PlacementScorer.GRAMMAR).total());
        assertEquals(24, r.skills().get(PlacementScorer.VOCABULARY).correct() + r.skills().get(PlacementScorer.GRAMMAR).correct());
    }

    @Test
    @DisplayName("Wrong answer count / out-of-range index rejected")
    void validation() {
        assertThrows(IllegalArgumentException.class, () -> PlacementScorer.score(items(), List.of(0, 1), P));
        List<Integer> bad = new ArrayList<>(answers(new int[][]{{8, 0}, {8, 0}, {8, 0}, {8, 0}, {8, 0}}));
        bad.set(3, 7);
        assertThrows(IllegalArgumentException.class, () -> PlacementScorer.score(items(), bad, P));
    }

    /**
     * Population check: ability θ uniform inside each band; an item of level L (index l) is known with probability
     * σ(2.2 (θ − l)); unknown items are skipped or guessed (1 in 4 right) by a per-learner habit.
     */
    @Test
    @DisplayName("Simulation (seeded): ≥ 65 % exact, ≥ 97 % within one level, no systematic bias, strong learners not collapsed")
    void simulation() {
        simulate(items(), P);
    }

    @Test
    @DisplayName("Quick form: 30 items = 3 vocabulary + 3 grammar per level (half the 80-question bank or less)")
    void quickFormLength() {
        assertEquals(30, QUICK.itemCount());
        assertEquals(QUICK.getVocabularyPerLevel(), QUICK.getGrammarPerLevel(), "vocabulary and grammar balanced");
        assertTrue(QUICK.itemCount() <= 30 && QUICK.itemCount() >= 20, "quick: 20–30 questions");
        assertTrue(QUICK.getVocabularyPerLevel() <= 8 && QUICK.getGrammarPerLevel() <= 8, "the V66 bank has 8 + 8 per level");
    }

    @Test
    @DisplayName("Quick form (30 items): deterministic A1 / A2 / B1 / B2 / C1 learners classify correctly")
    void quickFormProfiles() {
        assertEquals("A1", scoreQuick(new int[][]{{5, 1}, {2, 1}, {0, 2}, {0, 0}, {0, 0}}).resultCefr());
        assertEquals("A2", scoreQuick(new int[][]{{6, 0}, {5, 1}, {2, 2}, {1, 2}, {0, 0}}).resultCefr());
        assertEquals("B1", scoreQuick(new int[][]{{6, 0}, {6, 0}, {5, 1}, {2, 2}, {1, 3}}).resultCefr());
        assertEquals("B2", scoreQuick(new int[][]{{6, 0}, {6, 0}, {6, 0}, {5, 1}, {1, 3}}).resultCefr());
        PlacementScorer.Result c1 = scoreQuick(new int[][]{{6, 0}, {6, 0}, {6, 0}, {6, 0}, {5, 1}});
        assertEquals("C1", c1.resultCefr());
        assertFalse(c1.lowConfidence());
        assertEquals("INVALID", scoreQuick(new int[][]{{1, 5}, {1, 5}, {3, 3}, {6, 0}, {6, 0}}).status());
        assertEquals("A1", scoreQuick(new int[][]{{0, 0}, {0, 0}, {0, 0}, {0, 0}, {0, 0}}).resultCefr());
        PlacementScorer.Result counts = scoreQuick(new int[][]{{6, 0}, {6, 0}, {6, 0}, {6, 0}, {6, 0}});
        assertEquals(15, counts.skills().get(PlacementScorer.VOCABULARY).total());
        assertEquals(15, counts.skills().get(PlacementScorer.GRAMMAR).total());
    }

    @Test
    @DisplayName("Quick form simulation (seeded): same accuracy / bias / no-collapse bars as the 40-item form")
    void quickFormSimulation() {
        simulate(quickItems(), QUICK.scorerParams());
    }

    private static void simulate(List<PlacementScorer.Item> items, PlacementScorer.Params params) {
        Random rng = new Random(20261002L);
        int[][] confusion = new int[5][5];
        int n = 3000;
        for (int level = 0; level < 5; level++) {
            for (int k = 0; k < n; k++) {
                double theta = level + rng.nextDouble();
                double guessRate = new double[]{0.0, 0.5, 1.0}[rng.nextInt(3)];
                List<Integer> a = new ArrayList<>();
                for (PlacementScorer.Item it : items) {
                    int l = LEVELS.indexOf(it.cefr());
                    double p = 1.0 / (1.0 + Math.exp(-2.2 * (theta - l)));
                    if (rng.nextDouble() < p) a.add(0);
                    else if (rng.nextDouble() < guessRate) a.add(rng.nextInt(4));
                    else a.add(null);
                }
                PlacementScorer.Result r = PlacementScorer.score(items, a, params);
                int got = r.resultCefr() == null ? 0 : LEVELS.indexOf(r.resultCefr());
                confusion[level][got]++;
            }
        }
        StringBuilder table = new StringBuilder("[Placement simulation] items=" + items.size() + " (rows: true level, % per result A1..C1)\n");
        for (int t = 0; t < 5; t++) {
            table.append(LEVELS.get(t)).append(':');
            for (int g = 0; g < 5; g++) table.append(String.format(java.util.Locale.ROOT, " %5.1f", 100.0 * confusion[t][g] / n));
            table.append('\n');
        }
        System.out.print(table);
        int exact = 0;
        int within = 0;
        long bias = 0;
        for (int t = 0; t < 5; t++) {
            for (int g = 0; g < 5; g++) {
                if (t == g) exact += confusion[t][g];
                if (Math.abs(t - g) <= 1) within += confusion[t][g];
                bias += (long) (g - t) * confusion[t][g];
            }
        }
        double total = 5.0 * n;
        assertTrue(exact / total >= 0.65, "exact " + exact / total);
        assertTrue(within / total >= 0.97, "within one " + within / total);
        assertTrue(Math.abs(bias / total) < 0.25, "mean bias " + bias / total);
        // strong learners (true B2 / C1) rarely land at B1 or below; weak learners (A1 / A2) never reach the advanced band
        int strongLow = confusion[3][0] + confusion[3][1] + confusion[4][0] + confusion[4][1] + confusion[4][2];
        assertTrue(strongLow / (2.0 * n) < 0.12, "strong learners at ≤ B1: " + strongLow / (2.0 * n));
        assertEquals(0, confusion[0][4] + confusion[1][4], "weak learners (A1 / A2) never reach C1");
        assertEquals(0, confusion[0][3] + confusion[0][4], "A1 learners never reach B2 / C1");
        assertTrue((confusion[1][3]) / (double) n < 0.005, "A2 learners at B2: " + confusion[1][3]);
        // per level the most frequent result is the true level (no level is systematically skipped)
        for (int t = 0; t < 5; t++) {
            int best = 0;
            for (int g = 1; g < 5; g++) if (confusion[t][g] > confusion[t][best]) best = g;
            assertEquals(t, best, "modal result for " + LEVELS.get(t));
        }
    }

    // ---- 30-item quick form: boundaries, guessing, "Tôi chưa biết", near-perfect (2026-10-02 reliability audit) ----

    /** Learner of ability θ (logistic σ(2.2(θ − level))) answering the quick form; unsure ⇒ guess with {@code guess}, else skip. */
    static List<Integer> learner(Random rng, List<PlacementScorer.Item> items, double theta, double guess) {
        List<Integer> a = new ArrayList<>();
        for (PlacementScorer.Item it : items) {
            double p = 1.0 / (1.0 + Math.exp(-2.2 * (theta - LEVELS.indexOf(it.cefr()))));
            if (rng.nextDouble() < p) a.add(0);
            else if (rng.nextDouble() < guess) a.add(rng.nextInt(4));
            else a.add(null);
        }
        return a;
    }

    @Test
    @DisplayName("Quick form boundaries A1/A2, A2/B1, B1/B2, B2/C1: ≥ 98 % land on one of the two adjacent levels")
    void quickFormBoundaries() {
        Random rng = new Random(7L);
        List<PlacementScorer.Item> items = quickItems();
        for (int b = 1; b <= 4; b++) {
            int adjacent = 0;
            int n = 2000;
            for (int k = 0; k < n; k++) {
                double theta = b + (rng.nextDouble() - 0.5) * 0.1;
                PlacementScorer.Result r = PlacementScorer.score(items, learner(rng, items, theta, 0.5), QUICK.scorerParams());
                int got = r.resultCefr() == null ? -1 : LEVELS.indexOf(r.resultCefr());
                if (got == b - 1 || got == b) adjacent++;
            }
            assertTrue(adjacent / (double) n >= 0.98, "boundary " + LEVELS.get(b - 1) + "/" + LEVELS.get(b) + ": " + adjacent / (double) n);
        }
    }

    @Test
    @DisplayName("Pure random guessing on all 30 never reaches B1+ (≥ 98 % A1, rest A2 / INVALID)")
    void quickFormRandomGuessing() {
        Random rng = new Random(11L);
        List<PlacementScorer.Item> items = quickItems();
        int a1 = 0;
        int n = 5000;
        for (int k = 0; k < n; k++) {
            List<Integer> a = new ArrayList<>();
            for (int i = 0; i < items.size(); i++) a.add(rng.nextInt(4));
            PlacementScorer.Result r = PlacementScorer.score(items, a, QUICK.scorerParams());
            if (r.resultCefr() != null) {
                assertTrue(LEVELS.indexOf(r.resultCefr()) <= 1, "guessing reached " + r.resultCefr());
                if ("A1".equals(r.resultCefr())) a1++;
            }
        }
        assertTrue(a1 / (double) n >= 0.98, "A1 share " + a1 / (double) n);
    }

    @Test
    @DisplayName("Frequent 'Tôi chưa biết' is not penalised: an honest skipper is placed like a careful guesser (modal = true level)")
    void quickFormSkipper() {
        Random rng = new Random(13L);
        List<PlacementScorer.Item> items = quickItems();
        for (int level = 0; level < 5; level++) {
            int[] counts = new int[5];
            for (int k = 0; k < 2000; k++) {
                PlacementScorer.Result r = PlacementScorer.score(items, learner(rng, items, level + rng.nextDouble(), 0.0), QUICK.scorerParams());
                counts[r.resultCefr() == null ? 0 : LEVELS.indexOf(r.resultCefr())]++;
            }
            int best = 0;
            for (int g = 1; g < 5; g++) if (counts[g] > counts[best]) best = g;
            assertEquals(level, best, "modal result for skipper " + LEVELS.get(level));
            if (level <= 1) assertEquals(0, counts[3] + counts[4], "weak skipper never reaches B2 / C1");
        }
        // knows up to B1 exactly, skips everything above: B1 (skipping costs nothing)
        assertEquals("B1", scoreQuick(new int[][]{{6, 0}, {6, 0}, {6, 0}, {0, 0}, {0, 0}}).resultCefr());
    }

    @Test
    @DisplayName("All-correct / near-all-correct ⇒ C1; one careless miss per level does not drop a strong learner below C1")
    void quickFormNearPerfect() {
        assertEquals("C1", scoreQuick(new int[][]{{6, 0}, {6, 0}, {6, 0}, {6, 0}, {6, 0}}).resultCefr());
        assertEquals("C1", scoreQuick(new int[][]{{6, 0}, {6, 0}, {6, 0}, {6, 0}, {5, 1}}).resultCefr());
        assertEquals("C1", scoreQuick(new int[][]{{6, 0}, {6, 0}, {5, 1}, {6, 0}, {5, 0}}).resultCefr());
        assertEquals("B2", scoreQuick(new int[][]{{6, 0}, {6, 0}, {6, 0}, {5, 1}, {2, 3}}).resultCefr(),
                "C1 needs real evidence at C1");
    }
}
