package com.englishcoach.exams.measurement.analytics;

import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.AnalysisReport;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.ItemStatistic;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.Reliability;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.OutcomeStatus;

import java.util.*;
import java.util.function.Function;
import java.util.stream.Collectors;

/** Classical test theory calculations used by the pilot pipeline. */
public final class ExamCttAnalytics {

    private ExamCttAnalytics() {}

    public record Policy(int minimumItemSample, int minimumReliabilityRespondents,
                         int minimumReliabilityItems, double lowDifficulty,
                         double highDifficulty, double negativePointBiserial,
                         double highOmissionRate) {
        public Policy {
            if (minimumItemSample < 2 || minimumReliabilityRespondents < 2 || minimumReliabilityItems < 2) {
                throw new IllegalArgumentException("CTT minimums must be at least two");
            }
        }

        public static Policy pilotDefault() {
            return new Policy(5, 5, 2, 0.20, 0.90, 0.0, 0.20);
        }
    }

    /**
     * An observation is deliberately outcome-aware. UNKNOWN and ABSTAINED
     * rows remain in the sample denominator but never become fabricated wrong
     * answers.
     */
    public record Observation(UUID respondentId, UUID itemId, OutcomeStatus outcomeStatus,
                              double scoreAwarded, double maxScore, Long responseTimeMs,
                              String selectedOption) {}

    public static AnalysisReport report(UUID runId, List<Observation> observations, Policy policy) {
        Objects.requireNonNull(runId, "runId");
        Objects.requireNonNull(policy, "policy");
        List<Observation> rows = observations == null ? List.of() : List.copyOf(observations);
        Map<UUID, List<Observation>> byItem = rows.stream().collect(Collectors.groupingBy(Observation::itemId));
        List<ItemStatistic> stats = new ArrayList<>();
        for (Map.Entry<UUID, List<Observation>> entry : byItem.entrySet()) {
            stats.add(itemStatistic(entry.getKey(), entry.getValue(), rows, policy));
        }
        stats.sort(Comparator.comparing(ItemStatistic::itemId));
        Reliability reliability = reliability(rows, policy);
        long excluded = rows.stream().filter(o -> !isKnown(o)).count();
        int clean = (int) rows.stream().filter(ExamCttAnalytics::isKnown).count();
        List<String> hygiene = new ArrayList<>();
        if (rows.isEmpty()) hygiene.add("NO_EVENTS");
        if (rows.stream().anyMatch(o -> o.respondentId() == null)) hygiene.add("MISSING_RESPONDENT_ID");
        if (rows.stream().anyMatch(o -> o.maxScore() <= 0)) hygiene.add("INVALID_MAX_SCORE");
        String status = reliability.status().equals("CALCULATED") && clean >= policy.minimumItemSample()
                ? "CALCULATED" : "INSUFFICIENT";
        return new AnalysisReport(runId, stats, reliability, rows.size(), clean, (int) excluded,
                status, List.copyOf(hygiene));
    }

    public static ItemStatistic itemStatistic(UUID itemId, List<Observation> itemRows,
                                              List<Observation> allRows, Policy policy) {
        List<Observation> rows = itemRows == null ? List.of() : itemRows;
        List<Observation> known = rows.stream().filter(ExamCttAnalytics::isKnown).toList();
        double omission = rows.isEmpty() ? 0.0 : rows.stream()
                .filter(o -> o.outcomeStatus() == OutcomeStatus.OMITTED
                        || o.outcomeStatus() == OutcomeStatus.ABSTAINED
                        || o.outcomeStatus() == OutcomeStatus.UNKNOWN)
                .count() / (double) rows.size();
        Map<String, Double> distractors = distractorRates(rows);
        Long medianTime = median(rows.stream().map(Observation::responseTimeMs)
                .filter(Objects::nonNull).filter(v -> v >= 0).toList());
        if (known.size() < policy.minimumItemSample()) {
            return new ItemStatistic(itemId, rows.size(), known.size(), null, null, omission,
                    medianTime, distractors, "INSUFFICIENT", List.of("ITEM_SAMPLE_TOO_SMALL"));
        }

        long correct = known.stream().filter(o -> o.outcomeStatus() == OutcomeStatus.CORRECT).count();
        double p = correct / (double) known.size();
        Map<UUID, Double> respondentTotals = allRows.stream()
                .filter(ExamCttAnalytics::isKnown)
                .collect(Collectors.groupingBy(Observation::respondentId,
                        Collectors.summingDouble(Observation::scoreAwarded)));
        List<Double> x = new ArrayList<>();
        List<Double> y = new ArrayList<>();
        for (Observation o : known) {
            Double total = respondentTotals.get(o.respondentId());
            if (total == null) continue;
            x.add(o.outcomeStatus() == OutcomeStatus.CORRECT ? 1.0 : 0.0);
            y.add(total - o.scoreAwarded());
        }
        Double rpb = pearson(x, y);
        String status = rpb == null ? "UNDEFINED" : "CALCULATED";
        List<String> flags = new ArrayList<>();
        if (p < policy.lowDifficulty() || p > policy.highDifficulty()) flags.add("EXTREME_DIFFICULTY");
        if (rpb != null && rpb < policy.negativePointBiserial()) flags.add("NEGATIVE_ITEM_REST");
        if (omission > policy.highOmissionRate()) flags.add("HIGH_OMISSION");
        if (rpb == null) flags.add("ITEM_REST_UNDEFINED");
        return new ItemStatistic(itemId, rows.size(), known.size(), p, rpb, omission, medianTime,
                distractors, status, List.copyOf(flags));
    }

    /** KR-20 over complete respondent rows; undefined variance is reported, never coerced to zero. */
    public static Reliability reliability(List<Observation> observations, Policy policy) {
        Map<UUID, Map<UUID, Observation>> byRespondent = new LinkedHashMap<>();
        for (Observation o : observations == null ? List.<Observation>of() : observations) {
            if (!isKnown(o) || o.respondentId() == null || o.itemId() == null) continue;
            byRespondent.computeIfAbsent(o.respondentId(), ignored -> new LinkedHashMap<>()).put(o.itemId(), o);
        }
        Set<UUID> itemIds = byRespondent.values().stream().flatMap(m -> m.keySet().stream()).collect(Collectors.toSet());
        List<Map<UUID, Observation>> complete = byRespondent.values().stream()
                .filter(m -> m.keySet().containsAll(itemIds)).toList();
        int n = complete.size();
        int k = itemIds.size();
        if (n < policy.minimumReliabilityRespondents() || k < policy.minimumReliabilityItems()) {
            return new Reliability(n, k, null, "INSUFFICIENT", "RELIABILITY_SAMPLE_TOO_SMALL");
        }
        List<UUID> orderedItems = itemIds.stream().sorted().toList();
        double[] p = new double[k];
        for (int j = 0; j < k; j++) {
            int correct = 0;
            for (Map<UUID, Observation> row : complete) {
                if (row.get(orderedItems.get(j)).outcomeStatus() == OutcomeStatus.CORRECT) correct++;
            }
            p[j] = correct / (double) n;
        }
        double[] totals = complete.stream().mapToDouble(row -> row.values().stream()
                .mapToDouble(Observation::scoreAwarded).sum()).toArray();
        double variance = sampleVariance(totals);
        if (!Double.isFinite(variance) || variance == 0.0) {
            return new Reliability(n, k, null, "UNDEFINED", "TOTAL_SCORE_VARIANCE_ZERO");
        }
        double sumPq = Arrays.stream(p).map(v -> v * (1.0 - v)).sum();
        double kr20 = (k / (double) (k - 1)) * (1.0 - (sumPq / variance));
        return new Reliability(n, k, kr20, "CALCULATED", null);
    }

    public static boolean isKnown(Observation o) {
        return o != null && (o.outcomeStatus() == OutcomeStatus.CORRECT
                || o.outcomeStatus() == OutcomeStatus.INCORRECT)
                && Double.isFinite(o.scoreAwarded()) && Double.isFinite(o.maxScore()) && o.maxScore() > 0;
    }

    private static Map<String, Double> distractorRates(List<Observation> rows) {
        Map<String, Long> counts = rows.stream().map(Observation::selectedOption)
                .filter(Objects::nonNull).filter(s -> !s.isBlank())
                .collect(Collectors.groupingBy(Function.identity(), LinkedHashMap::new, Collectors.counting()));
        long total = counts.values().stream().mapToLong(Long::longValue).sum();
        if (total == 0) return Map.of();
        return counts.entrySet().stream().collect(Collectors.toMap(Map.Entry::getKey,
                e -> e.getValue() / (double) total, (a, b) -> a, LinkedHashMap::new));
    }

    private static Double pearson(List<Double> xs, List<Double> ys) {
        if (xs.size() < 2 || xs.size() != ys.size()) return null;
        double meanX = xs.stream().mapToDouble(Double::doubleValue).average().orElse(Double.NaN);
        double meanY = ys.stream().mapToDouble(Double::doubleValue).average().orElse(Double.NaN);
        double cov = 0, xx = 0, yy = 0;
        for (int i = 0; i < xs.size(); i++) {
            double dx = xs.get(i) - meanX, dy = ys.get(i) - meanY;
            cov += dx * dy; xx += dx * dx; yy += dy * dy;
        }
        if (xx == 0 || yy == 0) return null;
        return cov / Math.sqrt(xx * yy);
    }

    private static double sampleVariance(double[] values) {
        if (values.length < 2) return Double.NaN;
        double mean = Arrays.stream(values).average().orElse(Double.NaN);
        double sum = 0;
        for (double value : values) sum += Math.pow(value - mean, 2);
        return sum / (values.length - 1);
    }

    private static Long median(List<Long> values) {
        if (values == null || values.isEmpty()) return null;
        List<Long> sorted = values.stream().sorted().toList();
        int middle = sorted.size() / 2;
        return sorted.size() % 2 == 1 ? sorted.get(middle)
                : Math.round((sorted.get(middle - 1) + sorted.get(middle)) / 2.0);
    }
}
