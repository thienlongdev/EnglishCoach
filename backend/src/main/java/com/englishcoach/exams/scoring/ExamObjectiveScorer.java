package com.englishcoach.exams.scoring;

import com.englishcoach.exams.model.ExamContentRecords.AnswerSpecRecord;
import com.englishcoach.exams.model.ExamContentRecords.ScoringSchemeVersionRecord;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;

@Slf4j
@Component
@RequiredArgsConstructor
public class ExamObjectiveScorer {

    private final ExamAnswerNormalizer normalizer;

    /** Outcome codes recorded per item (no answer text). */
    public static final String OUTCOME_CORRECT = "CORRECT";
    public static final String OUTCOME_INCORRECT = "INCORRECT";
    public static final String OUTCOME_BLANK = "BLANK";
    public static final String OUTCOME_UNKEYED = "UNKEYED";
    public static final String OUTCOME_WORD_LIMIT_EXCEEDED = "WORD_LIMIT_EXCEEDED";
    public static final String OUTCOME_DUPLICATE_SELECTION = "DUPLICATE_SELECTION";

    public record ItemScoreResult(
            UUID itemId,
            Object userAnswer,
            Object acceptedAnswers,
            boolean isCorrect,
            double creditAwarded,
            double maxCredit,
            String explanation,
            String outcome
    ) {
        public ItemScoreResult(UUID itemId, Object userAnswer, Object acceptedAnswers, boolean isCorrect,
                               double creditAwarded, double maxCredit, String explanation) {
            this(itemId, userAnswer, acceptedAnswers, isCorrect, creditAwarded, maxCredit, explanation,
                    isCorrect ? OUTCOME_CORRECT : OUTCOME_INCORRECT);
        }
    }

    public record SectionObjectiveScoreResult(
            UUID sectionId,
            ExamFamily family,
            ScoreMetric metric,
            double rawScore,
            double maxRawScore,
            double scaledScore,
            String scaleName,
            List<ItemScoreResult> itemResults
    ) {}

    /**
     * One objective item of a scored attempt (Exams Phase 4): the pinned answer spec, the learner response, the printed
     * question number (orders a choose-TWO set) and whether the printed word-limit rule exempts numbers.
     */
    public record ObjectiveItemInput(UUID itemId, Integer questionNumber, Object response, AnswerSpecRecord spec,
                                     boolean numbersExempt) {}

    /**
     * Scores a single item based on learner answer and AnswerSpecRecord.
     */
    public ItemScoreResult scoreItem(UUID itemId, Object learnerResponse, AnswerSpecRecord spec) {
        return scoreItem(itemId, learnerResponse, spec, false);
    }

    /**
     * Scores one item. Fail-closed rules (Exams Phase 4C): a missing / blank key is never correct (EXAM-AUD-026); a
     * blank response is never correct; a TEXT answer over the spec's word limit is not correct (server-side, counted
     * on the RAW response) unless an accepted variant itself breaks the limit (the limit is then not enforceable and
     * the scoring gate reports it).
     */
    public ItemScoreResult scoreItem(UUID itemId, Object learnerResponse, AnswerSpecRecord spec, boolean numbersExempt) {
        double maxCredit = spec != null && spec.creditUnits() > 0 ? spec.creditUnits() : 1.0;
        String explanation = spec != null ? spec.explanation() : null;

        if (spec == null || spec.acceptedAnswers() == null || spec.acceptedAnswers().isEmpty()
                || nonBlankAccepted(spec.acceptedAnswers()).isEmpty() && !hasMatchingKey(spec.acceptedAnswers())) {
            return new ItemScoreResult(itemId, learnerResponse, null, false, 0.0, maxCredit, explanation, OUTCOME_UNKEYED);
        }

        Map<String, Object> acceptedMap = spec.acceptedAnswers();
        Map<String, Object> normPolicy = spec.normalizationPolicy() != null ? spec.normalizationPolicy() : Map.of();
        Object unwrapped = unwrap(learnerResponse, acceptedMap);
        if (isBlank(unwrapped)) {
            return new ItemScoreResult(itemId, learnerResponse, acceptedMap, false, 0.0, maxCredit, explanation, OUTCOME_BLANK);
        }
        boolean numberAllowed = numbersExempt || (normPolicy.get("bankNumberLimit") instanceof Number n && n.intValue() > 0);
        if (exceedsEnforceableWordLimit(unwrapped, spec, numberAllowed)) {
            return new ItemScoreResult(itemId, learnerResponse, acceptedMap, false, 0.0, maxCredit, explanation,
                    OUTCOME_WORD_LIMIT_EXCEEDED);
        }

        boolean isCorrect = evaluateAnswer(unwrapped, acceptedMap, normPolicy, spec.cardinality());
        double credit = isCorrect ? maxCredit : 0.0;

        return new ItemScoreResult(itemId, learnerResponse, acceptedMap, isCorrect, credit, maxCredit, explanation,
                isCorrect ? OUTCOME_CORRECT : OUTCOME_INCORRECT);
    }

    /**
     * Scores every objective item of one section with set semantics (Exams Phase 4C.2). Items whose spec carries
     * {@code acceptedAnswers.unorderedSet} ("Choose TWO letters": one item per printed question, one shared key set)
     * are scored together: each distinct accepted option earns credit once, in question order; choosing the same
     * option on two questions of the set earns it once ({@code DUPLICATE_SELECTION}); total credit never exceeds the
     * key set size; order is irrelevant. No partial-credit scheme beyond one credit per question is implied.
     * Output order = input order.
     */
    public List<ItemScoreResult> scoreItems(List<ObjectiveItemInput> inputs) {
        ItemScoreResult[] out = new ItemScoreResult[inputs.size()];
        Map<String, List<Integer>> sets = new LinkedHashMap<>();
        for (int i = 0; i < inputs.size(); i++) {
            ObjectiveItemInput in = inputs.get(i);
            String setKey = unorderedSetKey(in.spec());
            if (setKey == null) {
                out[i] = scoreItem(in.itemId(), in.response(), in.spec(), in.numbersExempt());
            } else {
                sets.computeIfAbsent(setKey, k -> new ArrayList<>()).add(i);
            }
        }
        for (List<Integer> members : sets.values()) {
            List<Integer> ordered = new ArrayList<>(members);
            ordered.sort(Comparator.comparing((Integer i) -> inputs.get(i).questionNumber(),
                    Comparator.nullsLast(Comparator.naturalOrder())).thenComparing(i -> i));
            Set<String> credited = new HashSet<>();
            for (int i : ordered) {
                ObjectiveItemInput in = inputs.get(i);
                AnswerSpecRecord spec = in.spec();
                Map<String, Object> policy = spec.normalizationPolicy() != null ? spec.normalizationPolicy() : Map.of();
                double maxCredit = spec.creditUnits() > 0 ? spec.creditUnits() : 1.0;
                Set<String> keySet = new HashSet<>();
                for (String v : unorderedSetValues(spec)) keySet.add(normalizer.normalize(v, policy));
                keySet.remove("");
                Object unwrapped = unwrap(in.response(), spec.acceptedAnswers());
                String outcome;
                if (keySet.isEmpty()) {
                    outcome = OUTCOME_UNKEYED;
                } else if (isBlank(unwrapped) || unwrapped instanceof Collection<?> || unwrapped instanceof Map<?, ?>) {
                    // a set member holds exactly one option id; lists / maps are not a valid single selection
                    outcome = isBlank(unwrapped) ? OUTCOME_BLANK : OUTCOME_INCORRECT;
                } else {
                    String norm = normalizer.normalize(unwrapped.toString(), policy);
                    if (!keySet.contains(norm)) outcome = OUTCOME_INCORRECT;
                    else if (!credited.add(norm)) outcome = OUTCOME_DUPLICATE_SELECTION;
                    else outcome = OUTCOME_CORRECT;
                }
                boolean ok = OUTCOME_CORRECT.equals(outcome);
                out[i] = new ItemScoreResult(in.itemId(), in.response(), spec.acceptedAnswers(), ok, ok ? maxCredit : 0.0,
                        maxCredit, spec.explanation(), outcome);
            }
        }
        return Arrays.asList(out);
    }

    /** Stable identity of a choose-N set: its printed question numbers + key set; null when the spec has none. */
    @SuppressWarnings("unchecked")
    static String unorderedSetKey(AnswerSpecRecord spec) {
        if (spec == null || spec.acceptedAnswers() == null
                || !(spec.acceptedAnswers().get("unorderedSet") instanceof Map<?, ?> set)) return null;
        if (!(set.get("questions") instanceof List<?> qs) || qs.size() < 2) return null;
        List<String> q = new ArrayList<>();
        for (Object o : qs) q.add(String.valueOf(o));
        Collections.sort(q);
        return String.join(",", q);
    }

    static List<String> unorderedSetValues(AnswerSpecRecord spec) {
        List<String> values = new ArrayList<>();
        if (spec.acceptedAnswers().get("unorderedSet") instanceof Map<?, ?> set && set.get("values") instanceof List<?> l) {
            for (Object o : l) if (o != null && !o.toString().isBlank()) values.add(o.toString());
        }
        return values;
    }

    /**
     * True when the response breaks an ENFORCEABLE word limit: the spec has a positive limit, the response is text,
     * and every accepted variant fits the same count (otherwise the key contradicts its own rule — the limit is not
     * enforced here and the scoring gate reports {@code ANSWER_SPEC_INVALID}).
     */
    public boolean exceedsEnforceableWordLimit(Object unwrappedResponse, AnswerSpecRecord spec, boolean numbersExempt) {
        if (spec == null || spec.wordLimit() == null || spec.wordLimit() <= 0) return false;
        if (!(unwrappedResponse instanceof String text)) return false;
        if (!isWordLimitEnforceable(spec, numbersExempt)) return false;
        return normalizer.countWords(text, numbersExempt) > spec.wordLimit();
    }

    /** A word limit is enforceable only when every accepted variant itself fits it. */
    public boolean isWordLimitEnforceable(AnswerSpecRecord spec, boolean numbersExempt) {
        if (spec == null || spec.wordLimit() == null || spec.wordLimit() <= 0) return false;
        List<String> accepted = nonBlankAccepted(spec.acceptedAnswers());
        if (accepted.isEmpty()) return false;
        for (String a : accepted) {
            if (normalizer.countWords(a, numbersExempt) > spec.wordLimit()) return false;
        }
        return true;
    }

    /** Non-blank accepted variants of a spec (blank keys are never answers). */
    public static List<String> nonBlankAccepted(Map<String, Object> acceptedMap) {
        List<String> acceptedList = new ArrayList<>();
        if (acceptedMap == null) return acceptedList;
        for (String key : ACCEPTED_KEYS) addAccepted(acceptedMap.get(key), acceptedList);
        return acceptedList;
    }

    private static final List<String> ACCEPTED_KEYS =
            List.of("accepted", "exact", "alternatives", "choices", "values", "variants", "items");

    private static boolean hasMatchingKey(Map<String, Object> acceptedMap) {
        return acceptedMap.get("matching") instanceof Map<?, ?> m && !m.isEmpty();
    }

    private static boolean isBlank(Object o) {
        if (o == null) return true;
        if (o instanceof String s) return s.isBlank();
        if (o instanceof Collection<?> c) return c.stream().allMatch(ExamObjectiveScorer::isBlank);
        if (o instanceof Map<?, ?> m) return m.isEmpty();
        return false;
    }

    /** Unwraps the stored response payload ({value}, {text}, {selectedOption}, {choiceId}, {answer}, {selected}). */
    private static Object unwrap(Object userAns, Map<String, Object> acceptedMap) {
        if (userAns instanceof Map<?, ?> userMap) {
            if (!(acceptedMap != null && acceptedMap.containsKey("matching") && acceptedMap.get("matching") instanceof Map<?, ?>)) {
                for (String k : List.of("value", "text", "selectedOption", "choiceId", "answer", "selected")) {
                    if (userMap.containsKey(k) && userMap.get(k) != null) return userMap.get(k);
                }
            }
        }
        return userAns;
    }

    @SuppressWarnings("unchecked")
    private boolean evaluateAnswer(Object userAns, Map<String, Object> acceptedMap, Map<String, Object> policy, int cardinality) {
        if (userAns == null) return false;

        // 1. Check direct accepted list or values (blank variants are dropped: an empty key never matches)
        List<String> acceptedList = new ArrayList<>();
        addAccepted(acceptedMap.get("accepted"), acceptedList);
        addAccepted(acceptedMap.get("exact"), acceptedList);
        addAccepted(acceptedMap.get("alternatives"), acceptedList);
        addAccepted(acceptedMap.get("choices"), acceptedList);
        addAccepted(acceptedMap.get("values"), acceptedList);
        addAccepted(acceptedMap.get("variants"), acceptedList);
        addAccepted(acceptedMap.get("items"), acceptedList);

        // Multi-cardinality match (e.g. multiple choice multi-select): set equality, duplicates collapse
        if (cardinality > 1) {
            if (!(userAns instanceof List<?> userList) || userList.size() != cardinality) return false;
            Set<String> normalizedUser = new HashSet<>();
            for (Object u : userList) {
                if (u != null) normalizedUser.add(normalizer.normalize(u.toString(), policy));
            }
            normalizedUser.remove("");
            Set<String> normalizedAccepted = new HashSet<>();
            for (String a : acceptedList) {
                normalizedAccepted.add(normalizer.normalize(a, policy));
            }
            normalizedAccepted.remove("");
            return normalizedUser.size() == cardinality && normalizedUser.equals(normalizedAccepted);
        }

        // Single cardinality match: a list / map is never one answer
        if (!(userAns instanceof Collection<?>) && !(userAns instanceof Map<?, ?>)) {
            String normUser = normalizer.normalize(userAns.toString(), policy);
            if (!normUser.isEmpty()) {
                for (String accepted : acceptedList) {
                    String normAccepted = normalizer.normalize(accepted, policy);
                    if (!normAccepted.isEmpty() && normUser.equals(normAccepted)) {
                        return true;
                    }
                }
            }
        }

        // Key-value map response (for matching/ordering interactions: e.g. {"1": "B", "2": "C"})
        if (userAns instanceof Map<?, ?> userMap && acceptedMap.containsKey("matching") && acceptedMap.get("matching") instanceof Map<?, ?> acceptedPairs) {
            for (Map.Entry<?, ?> entry : acceptedPairs.entrySet()) {
                Object expectedVal = entry.getValue();
                Object actualVal = userMap.get(entry.getKey());
                if (actualVal == null) return false;
                String normAct = normalizer.normalize(actualVal.toString(), policy);
                String normExp = normalizer.normalize(expectedVal.toString(), policy);
                if (!normAct.equals(normExp)) return false;
            }
            return true;
        }

        return false;
    }

    private static void addAccepted(Object obj, List<String> list) {
        if (obj == null) return;
        if (obj instanceof List<?> l) {
            for (Object o : l) {
                if (o != null && !o.toString().isBlank()) list.add(o.toString());
            }
        } else if (!(obj instanceof Map<?, ?>) && !obj.toString().isBlank()) {
            list.add(obj.toString());
        }
    }

    /** Scale applicability of an objective section (Exams Phase 4C.6). */
    public enum ScaleApplicability { STANDARD_FULL_SECTION, PARTIAL_UNSCALED }

    /**
     * A standardized scale (IELTS band / TOEIC 5–495) is claimed only for a COMPLETE standard section: IELTS
     * Listening / Reading = 40 items, TOEIC Listening / Reading = 100 items (2016+ and pre-2016 alike). Anything else
     * (a partial or incomplete section) is reported as raw / percent only — no fake standardized score.
     */
    public static ScaleApplicability scaleApplicability(ExamFamily family, ScoreMetric metric, double maxRaw) {
        if (metric != ScoreMetric.LISTENING && metric != ScoreMetric.READING) return ScaleApplicability.PARTIAL_UNSCALED;
        int expected = family == ExamFamily.IELTS ? 40 : family == ExamFamily.TOEIC ? 100 : -1;
        return Math.round(maxRaw) == expected ? ScaleApplicability.STANDARD_FULL_SECTION : ScaleApplicability.PARTIAL_UNSCALED;
    }

    /**
     * Compute section raw score and convert to scaled score using the scheme's mappingTable.
     */
    public SectionObjectiveScoreResult scoreSection(
            UUID sectionId,
            ExamFamily family,
            ScoreMetric metric,
            List<ItemScoreResult> itemResults,
            ScoringSchemeVersionRecord scheme
    ) {
        return scoreSection(sectionId, family, metric, itemResults, scheme, null);
    }

    /**
     * IELTS business audit 2026-11-13: the form variant decides the Reading conversion (General Training Reading needs more
     * correct answers for the same band — ielts.org "IELTS scoring in detail"). A null variant keeps the Academic tables.
     */
    public SectionObjectiveScoreResult scoreSection(
            UUID sectionId,
            ExamFamily family,
            ScoreMetric metric,
            List<ItemScoreResult> itemResults,
            ScoringSchemeVersionRecord scheme,
            String variant
    ) {
        double rawTotal = 0.0;
        double maxRawTotal = 0.0;
        for (ItemScoreResult r : itemResults) {
            rawTotal += r.creditAwarded();
            maxRawTotal += r.maxCredit();
        }

        double scaled = mapRawToScaled(rawTotal, maxRawTotal, family, metric, scheme, variant);
        String scaleName = Double.isNaN(scaled) ? "RAW_ONLY"
                : family == ExamFamily.IELTS && mappedScore((int) Math.round(rawTotal), scheme).isEmpty() ? "IELTS_BAND_ESTIMATE"
                : family == ExamFamily.IELTS ? "IELTS_BAND" : "TOEIC_SCALE_5_495";

        return new SectionObjectiveScoreResult(
                sectionId,
                family,
                metric,
                rawTotal,
                maxRawTotal,
                scaled,
                scaleName,
                itemResults
        );
    }

    public double mapRawToScaled(double raw, double maxRaw, ExamFamily family, ScoreMetric metric, ScoringSchemeVersionRecord scheme) {
        return mapRawToScaled(raw, maxRaw, family, metric, scheme, null);
    }

    @SuppressWarnings("unchecked")
    public double mapRawToScaled(double raw, double maxRaw, ExamFamily family, ScoreMetric metric, ScoringSchemeVersionRecord scheme, String variant) {
        int roundedRaw = (int) Math.round(raw);

        if (scheme != null && scheme.mappingTable() != null && "NONE".equals(scheme.mappingTable().get("conversion"))) return Double.NaN;
        OptionalDouble mapped = mappedScore(roundedRaw, scheme);
        if (mapped.isPresent()) return mapped.getAsDouble();
        return family == ExamFamily.IELTS ? fallbackIeltsRawToBand(roundedRaw, metric, variant) : Double.NaN;
    }

    private OptionalDouble mappedScore(int roundedRaw, ScoringSchemeVersionRecord scheme) {
        if (scheme == null || scheme.mappingTable() == null) return OptionalDouble.empty();
        Map<String, Object> table = scheme.mappingTable();
        if (table.get(String.valueOf(roundedRaw)) instanceof Number n) return OptionalDouble.of(n.doubleValue());
        if (table.get("ranges") instanceof List<?> ranges) {
            for (Object row : ranges) {
                if (row instanceof Map<?, ?> range && range.get("min") instanceof Number min && range.get("max") instanceof Number max
                        && range.get("scaled") instanceof Number scaled && roundedRaw >= min.intValue() && roundedRaw <= max.intValue()) {
                    return OptionalDouble.of(scaled.doubleValue());
                }
            }
        }
        return OptionalDouble.empty();
    }

    /**
     * IELTS 40-item fallback conversion, used only when the form's scoring scheme carries no mapping table.
     * Official basis (ielts.org "IELTS scoring in detail", fetched 2026-11-13): the published APPROXIMATE marks per band
     * differ by test — Listening 16 → 5, 23 → 6, 30 → 7, 35 → 8; Academic Reading 15 → 5, 23 → 6, 30 → 7, 35 → 8;
     * General Training Reading 15 → 4, 23 → 5, 30 → 6, 35 → 7 — and "will vary slightly from test version to test
     * version". Every table below passes through those anchors; the steps between anchors are the widely used practice
     * tables, NOT an official IELTS table, and a version-specific mapping table in the scoring scheme always wins.
     * Before 2026-11-13 one Academic-Reading-shaped table served all three (General Training Reading over-banded by
     * about one band, Listening 15 → 5.0).
     */
    static double fallbackIeltsRawToBand(int raw, ScoreMetric metric, String variant) {
        if (raw <= 0) return 0.0;
        boolean generalTraining = variant != null && variant.trim().toUpperCase().replace('-', '_').startsWith("GENERAL");
        int[][] table;
        if (metric == ScoreMetric.LISTENING) {
            table = IELTS_LISTENING_FALLBACK;
        } else if (metric == ScoreMetric.READING && generalTraining) {
            table = IELTS_GT_READING_FALLBACK;
        } else {
            table = IELTS_ACADEMIC_READING_FALLBACK;
        }
        for (int[] row : table) {
            if (raw >= row[0]) return row[1] / 10.0;
        }
        return table[table.length - 1][1] / 10.0;
    }

    /** {minimum raw, band × 10}, first match wins. Anchors: 16 → 5, 23 → 6, 30 → 7, 35 → 8. */
    static final int[][] IELTS_LISTENING_FALLBACK = {
            {39, 90}, {37, 85}, {35, 80}, {32, 75}, {30, 70}, {26, 65}, {23, 60}, {18, 55}, {16, 50}, {13, 45},
            {10, 40}, {8, 35}, {6, 30}, {4, 25}, {1, 20},
    };
    /** Anchors: 15 → 5, 23 → 6, 30 → 7, 35 → 8 (unchanged from the previous single table). */
    static final int[][] IELTS_ACADEMIC_READING_FALLBACK = {
            {39, 90}, {37, 85}, {35, 80}, {33, 75}, {30, 70}, {27, 65}, {23, 60}, {19, 55}, {15, 50}, {13, 45},
            {10, 40}, {8, 35}, {6, 30}, {4, 25}, {1, 20},
    };
    /** Anchors: 15 → 4, 23 → 5, 30 → 6, 35 → 7. */
    static final int[][] IELTS_GT_READING_FALLBACK = {
            {40, 90}, {39, 85}, {37, 80}, {36, 75}, {34, 70}, {32, 65}, {30, 60}, {27, 55}, {23, 50}, {19, 45},
            {15, 40}, {12, 35}, {9, 30}, {6, 25}, {1, 20},
    };

}
