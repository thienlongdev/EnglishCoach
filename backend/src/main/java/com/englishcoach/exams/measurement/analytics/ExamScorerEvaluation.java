package com.englishcoach.exams.measurement.analytics;

import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.EvaluationMetrics;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.EvaluationRecord;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.EvaluationReport;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.Split;

import java.util.*;
import java.util.function.Predicate;
import java.util.stream.Collectors;

/** Offline, split-aware scorer evaluation. */
public final class ExamScorerEvaluation {

    private ExamScorerEvaluation() {}

    public record Policy(int minimumTestRows, double adjacentTolerance) {
        public Policy {
            if (minimumTestRows < 1 || adjacentTolerance < 0) throw new IllegalArgumentException("Invalid evaluation policy");
        }

        public static Policy defaultPolicy() { return new Policy(10, 1.0); }
    }

    public static EvaluationReport evaluate(List<EvaluationRecord> records, boolean lockedTest,
                                            Policy policy) {
        List<EvaluationRecord> rows = records == null ? List.of() : List.copyOf(records);
        List<String> hygiene = new ArrayList<>();
        Map<UUID, Split> memberSplits = new HashMap<>();
        Set<String> memberCriteria = new HashSet<>();
        for (EvaluationRecord row : rows) {
            if (row.memberId() == null || row.split() == null || row.criterion() == null || row.criterion().isBlank()) {
                hygiene.add("INCOMPLETE_RECORD");
                continue;
            }
            Split priorSplit = memberSplits.putIfAbsent(row.memberId(), row.split());
            if (priorSplit != null && priorSplit != row.split()) hygiene.add("SPLIT_OVERLAP");
            if (!memberCriteria.add(row.memberId() + "|" + row.criterion())) hygiene.add("DUPLICATE_RECORD");
        }
        if (!lockedTest) hygiene.add("TEST_SPLIT_NOT_LOCKED");
        List<EvaluationRecord> test = rows.stream().filter(r -> r.split() == Split.TEST).toList();
        boolean usableTest = lockedTest && hygiene.stream().noneMatch(flag ->
                flag.equals("SPLIT_OVERLAP") || flag.equals("DUPLICATE_RECORD") || flag.equals("INCOMPLETE_RECORD"));
        EvaluationMetrics overall = metrics(test, policy, usableTest);
        Map<String, EvaluationMetrics> criterion = group(test, EvaluationRecord::criterion, policy,
                usableTest);
        Map<String, EvaluationMetrics> subgroup = group(test, r -> r.subgroup() == null ? "UNKNOWN" : r.subgroup(), policy,
                usableTest);
        return new EvaluationReport(overall, criterion, subgroup, List.copyOf(hygiene));
    }

    private static Map<String, EvaluationMetrics> group(List<EvaluationRecord> rows,
                                                         java.util.function.Function<EvaluationRecord, String> key,
                                                         Policy policy, boolean locked) {
        return rows.stream().collect(Collectors.groupingBy(key, LinkedHashMap::new, Collectors.collectingAndThen(
                Collectors.toList(), list -> metrics(list, policy, locked))));
    }

    private static EvaluationMetrics metrics(List<EvaluationRecord> rows, Policy policy, boolean locked) {
        int sample = rows.size();
        int abstained = (int) rows.stream().filter(r -> r.abstained() || r.aiScore() == null).count();
        List<EvaluationRecord> scored = rows.stream().filter(r -> !r.abstained() && r.aiScore() != null)
                .toList();
        double abstentionRate = sample == 0 ? 1.0 : abstained / (double) sample;
        if (!locked || sample < policy.minimumTestRows()) {
            return new EvaluationMetrics(sample, scored.size(), abstained, null, null, null, null, null, null,
                    abstentionRate, "INSUFFICIENT", !locked ? "LOCKED_TEST_REQUIRED" : "TEST_SAMPLE_TOO_SMALL");
        }
        if (scored.isEmpty()) {
            return new EvaluationMetrics(sample, 0, abstained, null, null, null, null, null, null,
                    abstentionRate, "INSUFFICIENT", "NO_NON_ABSTAINED_SCORES");
        }
        double mae = scored.stream().mapToDouble(r -> Math.abs(r.aiScore() - r.humanScore())).average().orElse(Double.NaN);
        double rmse = Math.sqrt(scored.stream().mapToDouble(r -> Math.pow(r.aiScore() - r.humanScore(), 2)).average().orElse(Double.NaN));
        double exact = scored.stream().filter(r -> Double.compare(r.aiScore(), r.humanScore()) == 0).count() / (double) scored.size();
        double adjacent = scored.stream().filter(r -> Math.abs(r.aiScore() - r.humanScore()) <= policy.adjacentTolerance()).count()
                / (double) scored.size();
        Double kappa = kappa(scored);
        Double correlation = correlation(scored);
        String status = Double.isFinite(mae) && Double.isFinite(rmse) ? "CALCULATED" : "UNDEFINED";
        return new EvaluationMetrics(sample, scored.size(), abstained, mae, rmse, exact, adjacent, kappa, correlation,
                abstentionRate, status, status.equals("CALCULATED") ? null : "METRIC_UNDEFINED");
    }

    private static Double correlation(List<EvaluationRecord> rows) {
        if (rows.size() < 2) return null;
        double mx = rows.stream().mapToDouble(r -> r.aiScore()).average().orElse(Double.NaN);
        double my = rows.stream().mapToDouble(EvaluationRecord::humanScore).average().orElse(Double.NaN);
        double cov = 0, xx = 0, yy = 0;
        for (EvaluationRecord r : rows) {
            double x = r.aiScore() - mx, y = r.humanScore() - my;
            cov += x * y; xx += x * x; yy += y * y;
        }
        return xx == 0 || yy == 0 ? null : cov / Math.sqrt(xx * yy);
    }

    /** Cohen's kappa over observed numeric score categories. */
    private static Double kappa(List<EvaluationRecord> rows) {
        if (rows.isEmpty()) return null;
        Set<Double> categories = new TreeSet<>();
        rows.forEach(r -> { categories.add(r.humanScore()); categories.add(r.aiScore()); });
        if (categories.size() < 2) return null;
        Map<Double, Integer> index = new HashMap<>();
        int i = 0; for (Double category : categories) index.put(category, i++);
        int[][] matrix = new int[categories.size()][categories.size()];
        for (EvaluationRecord r : rows) matrix[index.get(r.humanScore())][index.get(r.aiScore())]++;
        double n = rows.size(), observed = 0, expected = 0;
        for (i = 0; i < matrix.length; i++) {
            observed += matrix[i][i] / n;
            int row = 0, col = 0;
            for (int j = 0; j < matrix.length; j++) { row += matrix[i][j]; col += matrix[j][i]; }
            expected += (row / n) * (col / n);
        }
        return observed == 1.0 && expected == 1.0 ? 1.0 : (1 - expected == 0 ? null : (observed - expected) / (1 - expected));
    }
}
