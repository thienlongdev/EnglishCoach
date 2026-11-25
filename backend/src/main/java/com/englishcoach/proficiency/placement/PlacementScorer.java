package com.englishcoach.proficiency.placement;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure scoring of a placement attempt (model 2, no I/O). Every item is a 4-option multiple-choice question
 * (VOCABULARY or GRAMMAR) labelled with one CEFR level; an answer is the chosen option index or {@code null}
 * ("Tôi chưa biết" — skipped, never penalised).
 * <ol>
 *   <li>Per level L: mastery m_L = clamp((right − wrong / (options − 1)) / n_L, 0, 1) — formula scoring, so blind
 *       guessing averages 0 while an honest skip costs nothing.</li>
 *   <li>Ability S = Σ m_L over the levels (0–5 for A1–C1). S is a sum score (sufficient for a Rasch-type ability),
 *       so one noisy level cannot cap the result the way the old "every level must pass" chain did.</li>
 *   <li>Level = number of thresholds S reaches (A2 ≥ 1.6, B1 ≥ 2.6, B2 ≥ 3.6, C1 ≥ 4.5), then stepped down while
 *       no level at or above it has m ≥ minLevelMastery (the result needs evidence at its own level or higher, so a
 *       perfect lower half alone cannot add up to an upper level).</li>
 *   <li>INVALID when the pattern is reversed: mean m of the two top levels exceeds the two bottom levels by
 *       ≥ invalidReversal (random / careless answering) — no level, retake at once.</li>
 *   <li>lowConfidence: S within 0.15 of a threshold, a level below the result with m &lt; 0.5, or A1 with S &lt; 0.8.</li>
 * </ol>
 */
public final class PlacementScorer {

    private PlacementScorer() {}

    public static final String VOCABULARY = "VOCABULARY";
    public static final String GRAMMAR = "GRAMMAR";

    /** One issued question as stored server-side; {@code answer} is the correct index in {@code options} as shown. */
    public record Item(int index, long questionId, String skill, String cefr, String prompt, List<String> options,
                       Integer answer) {}

    public record Params(List<String> levels, List<Double> thresholds, double minLevelMastery, double invalidReversal,
                         int optionCount) {
        public static Params defaults(List<String> levels) {
            return new Params(levels, List.of(1.6, 2.6, 3.6, 4.5), 0.34, 0.5, 4);
        }
    }

    /** Per-skill raw counts (shown to the learner). */
    public record SkillCount(int correct, int total) {}

    public record Result(String status, String resultCefr, boolean lowConfidence, double score,
                         Map<String, Double> levelRates, Map<String, SkillCount> skills) {}

    public static Result score(List<Item> items, List<Integer> answers, Params p) {
        if (items == null || answers == null || items.size() != answers.size()) {
            throw new IllegalArgumentException("answers must match the issued items");
        }
        Map<String, int[]> perLevel = new LinkedHashMap<>(); // [right, wrong, total]
        for (String level : p.levels()) {
            perLevel.put(level, new int[3]);
        }
        Map<String, int[]> perSkill = new LinkedHashMap<>();
        perSkill.put(VOCABULARY, new int[2]);
        perSkill.put(GRAMMAR, new int[2]);
        for (int i = 0; i < items.size(); i++) {
            Item item = items.get(i);
            Integer a = answers.get(i);
            if (a != null && (a < 0 || a >= p.optionCount())) {
                throw new IllegalArgumentException("answer out of range at " + i);
            }
            boolean right = a != null && a.equals(item.answer());
            int[] c = perLevel.get(item.cefr());
            if (c != null) {
                c[2]++;
                if (right) c[0]++;
                else if (a != null) c[1]++;
            }
            int[] s = perSkill.get(item.skill());
            if (s != null) {
                s[1]++;
                if (right) s[0]++;
            }
        }
        double penalty = 1.0 / (p.optionCount() - 1);
        Map<String, Double> rates = new LinkedHashMap<>();
        double[] m = new double[p.levels().size()];
        double sum = 0;
        for (int i = 0; i < p.levels().size(); i++) {
            int[] c = perLevel.get(p.levels().get(i));
            double v = c[2] == 0 ? 0.0 : Math.max(0.0, Math.min(1.0, (c[0] - c[1] * penalty) / c[2]));
            m[i] = round3(v);
            rates.put(p.levels().get(i), m[i]);
            sum += m[i];
        }
        double score = round3(sum);
        Map<String, SkillCount> skills = new LinkedHashMap<>();
        perSkill.forEach((k, v) -> skills.put(k, new SkillCount(v[0], v[1])));

        int n = m.length;
        if (n >= 4) {
            double low = (m[0] + m[1]) / 2.0;
            double high = (m[n - 1] + m[n - 2]) / 2.0;
            if (high - low >= p.invalidReversal()) {
                return new Result("INVALID", null, false, score, rates, skills);
            }
        }
        int k = 0;
        for (double t : p.thresholds()) {
            if (score >= t) k++;
        }
        k = Math.min(k, n - 1);
        while (k > 0 && maxFrom(m, k) < p.minLevelMastery()) {
            k--;
        }
        boolean low = (k == 0 && score < 0.8);
        for (double t : p.thresholds()) {
            if (Math.abs(score - t) < 0.15) low = true;
        }
        for (int i = 0; i < k; i++) {
            if (m[i] < 0.5) low = true;
        }
        return new Result("VALID", p.levels().get(k), low, score, rates, skills);
    }

    /** Best mastery at level index {@code from} or above. */
    private static double maxFrom(double[] m, int from) {
        double best = 0;
        for (int i = from; i < m.length; i++) best = Math.max(best, m[i]);
        return best;
    }

    private static double round3(double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }
}
