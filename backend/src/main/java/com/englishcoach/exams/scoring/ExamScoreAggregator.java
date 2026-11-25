package com.englishcoach.exams.scoring;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Map;

@Slf4j
@Component
public class ExamScoreAggregator {

    /**
     * Compute IELTS Overall Band score following official IELTS quarter-boundary rounding rules:
     * - Remainder < 0.25 -> round down to .0
     * - 0.25 <= Remainder < 0.75 -> round to .5
     * - Remainder >= 0.75 -> round up to next integer .0
     *
     * Exact decimal HALF_UP arithmetic via BigDecimal ensures binary floating-point
     * ties cannot drift:
     * - 6.000 -> 6.0
     * - 6.125 -> 6.0
     * - 6.250 -> 6.5
     * - 6.500 -> 6.5
     * - 6.750 -> 7.0
     * - 6.875 -> 7.0
     * - 7.000 -> 7.0
     *
     * Invariant: ONLY eligible when all 4 skills (L, R, W, S) are present and valid from the SAME attempt!
     */
    public double computeIeltsOverall(double listening, double reading, double writing, double speaking) {
        BigDecimal sum = BigDecimal.valueOf(listening)
                .add(BigDecimal.valueOf(reading))
                .add(BigDecimal.valueOf(writing))
                .add(BigDecimal.valueOf(speaking));
        BigDecimal rawAvg = sum.divide(BigDecimal.valueOf(4), 4, RoundingMode.HALF_UP);
        return roundIeltsQuarterBoundary(rawAvg.doubleValue());
    }

    public double roundIeltsQuarterBoundary(double score) {
        BigDecimal bd = BigDecimal.valueOf(score);
        BigDecimal doubled = bd.multiply(BigDecimal.valueOf(2));
        BigDecimal rounded = doubled.setScale(0, RoundingMode.HALF_UP);
        return rounded.divide(BigDecimal.valueOf(2), 1, RoundingMode.HALF_UP).doubleValue();
    }

    /**
     * IELTS Writing Task 1 (1/3) and Task 2 (2/3) weighting
     */
    public double computeIeltsWriting(double task1Band, double task2Band) {
        BigDecimal weighted = BigDecimal.valueOf(task1Band)
                .add(BigDecimal.valueOf(task2Band).multiply(BigDecimal.valueOf(2)))
                .divide(BigDecimal.valueOf(3), 4, RoundingMode.HALF_UP);
        return roundIeltsQuarterBoundary(weighted.doubleValue());
    }

    /**
     * TOEIC L&R Total score: Listening (5-495) + Reading (5-495) = 10-990.
     * Both must be multiples of 5, total is multiple of 5.
     */
    public double computeToeicLrTotal(double listening, double reading) {
        double total = listening + reading;
        // Clamp to 10 - 990
        if (total < 10.0) total = 10.0;
        if (total > 990.0) total = 990.0;
        // Round to nearest multiple of 5
        return Math.round(total / 5.0) * 5.0;
    }

    /**
     * Aggregates score metrics for an attempt.
     * Returns a map of ScoreMetric to double.
     *
     * Invariants:
     * - For IELTS: if all 4 skills (L, R, W, S) are present, non-null, and > 0.0 for FULL attempt,
     *   compute FULL_OVERALL. Otherwise NO FULL_OVERALL.
     * - For TOEIC: if Listening and Reading are present, non-null, and >= 5.0, compute TOEIC_LR_TOTAL.
     *   NEVER compute a 4-skill Overall for TOEIC (if present, strictly remove it).
     * - Never merge IELTS and TOEIC.
     */
    public void aggregateScores(
            ExamFamily family,
            String scope,
            Map<ScoreMetric, Double> scores
    ) {
        if (scores == null) {
            return;
        }

        if (family == ExamFamily.IELTS) {
            // Remove any stale overall score first
            scores.remove(ScoreMetric.FULL_OVERALL);

            boolean isFull = scope != null && (
                    "FULL".equalsIgnoreCase(scope) ||
                    "ALL".equalsIgnoreCase(scope) ||
                    "FULL_MOCK".equalsIgnoreCase(scope) ||
                    scope.toUpperCase().contains("FULL")
            );

            Double l = scores.get(ScoreMetric.LISTENING);
            Double r = scores.get(ScoreMetric.READING);
            Double w = scores.get(ScoreMetric.WRITING);
            Double s = scores.get(ScoreMetric.SPEAKING);

            boolean hasAllFourValid = l != null && l > 0.0 &&
                                      r != null && r > 0.0 &&
                                      w != null && w > 0.0 &&
                                      s != null && s > 0.0;

            if (isFull && hasAllFourValid) {
                double overall = computeIeltsOverall(l, r, w, s);
                scores.put(ScoreMetric.FULL_OVERALL, overall);
            }
        } else if (family == ExamFamily.TOEIC) {
            // CRITICAL INVARIANT: NEVER produce or retain a four-skill Overall for TOEIC!
            scores.remove(ScoreMetric.FULL_OVERALL);

            Double l = scores.get(ScoreMetric.LISTENING);
            Double r = scores.get(ScoreMetric.READING);

            if (l != null && l >= 5.0 && r != null && r >= 5.0) {
                double lrTotal = computeToeicLrTotal(l, r);
                scores.put(ScoreMetric.LR_TOTAL, lrTotal);
            }
        }
    }
}
