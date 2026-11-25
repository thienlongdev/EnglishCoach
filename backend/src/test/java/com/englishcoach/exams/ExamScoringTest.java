package com.englishcoach.exams;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.scoring.ExamScoreAggregator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class ExamScoringTest {

    private final ExamScoreAggregator aggregator = new ExamScoreAggregator();
    private final ExamAnswerNormalizer normalizer = new ExamAnswerNormalizer();
    private final ExamObjectiveScorer objectiveScorer = new ExamObjectiveScorer(normalizer);

    @Test
    @DisplayName("IELTS Quarter-Boundary Rounding Rules (.25 -> .5, .75 -> 1.0, .125 -> .0)")
    void testIeltsRounding() {
        // 6.125 -> 6.0
        assertEquals(6.0, aggregator.roundIeltsQuarterBoundary(6.125), 0.001);

        // 6.25 -> 6.5
        assertEquals(6.5, aggregator.roundIeltsQuarterBoundary(6.25), 0.001);

        // 6.375 -> 6.5
        assertEquals(6.5, aggregator.roundIeltsQuarterBoundary(6.375), 0.001);

        // 6.75 -> 7.0
        assertEquals(7.0, aggregator.roundIeltsQuarterBoundary(6.75), 0.001);

        // 6.875 -> 7.0
        assertEquals(7.0, aggregator.roundIeltsQuarterBoundary(6.875), 0.001);

        // 6.625 -> 6.5
        assertEquals(6.5, aggregator.roundIeltsQuarterBoundary(6.625), 0.001);
    }

    @Test
    @DisplayName("IELTS Writing Task 1 (1/3) and Task 2 (2/3) Weighting")
    void testIeltsWritingWeighting() {
        // Task 1 = 6.0, Task 2 = 7.0
        // Weighted = (6.0 * 1 + 7.0 * 2) / 3 = 20 / 3 = 6.666... -> rounds to 6.5
        double writingScore = aggregator.computeIeltsWriting(6.0, 7.0);
        assertEquals(6.5, writingScore, 0.001);

        // Task 1 = 7.0, Task 2 = 8.0 -> (7 + 16)/3 = 23/3 = 7.666... -> rounds to 7.5
        double writingScore2 = aggregator.computeIeltsWriting(7.0, 8.0);
        assertEquals(7.5, writingScore2, 0.001);
    }

    @Test
    @DisplayName("IELTS Full Overall Band from exactly all 4 skills")
    void testIeltsOverallBand() {
        // L=6.5, R=6.5, W=6.0, S=7.0 -> Sum=26.0 / 4 = 6.5
        double overall = aggregator.computeIeltsOverall(6.5, 6.5, 6.0, 7.0);
        assertEquals(6.5, overall, 0.001);

        // L=6.5, R=6.5, W=5.5, S=6.0 -> Sum=24.5 / 4 = 6.125 -> 6.0
        double overall2 = aggregator.computeIeltsOverall(6.5, 6.5, 5.5, 6.0);
        assertEquals(6.0, overall2, 0.001);
    }

    @Test
    @DisplayName("TOEIC L&R Total score summation (10 - 990)")
    void testToeicLrTotal() {
        double listening = 400.0;
        double reading = 350.0;
        double total = aggregator.computeToeicLrTotal(listening, reading);
        assertEquals(750.0, total, 0.001);

        // Clamping to bounds
        double minTotal = aggregator.computeToeicLrTotal(5.0, 5.0);
        assertEquals(10.0, minTotal, 0.001);

        double maxTotal = aggregator.computeToeicLrTotal(495.0, 495.0);
        assertEquals(990.0, maxTotal, 0.001);
    }

    @Test
    @DisplayName("Score Aggregator strictly enforces absence of 4-skill Overall for TOEIC")
    void testToeicNoFourSkillOverall() {
        Map<ScoreMetric, Double> scores = new HashMap<>();
        scores.put(ScoreMetric.LISTENING, 400.0);
        scores.put(ScoreMetric.READING, 350.0);
        scores.put(ScoreMetric.SPEAKING, 160.0);
        scores.put(ScoreMetric.WRITING, 150.0);

        aggregator.aggregateScores(ExamFamily.TOEIC, "SUITE", scores);

        // L&R total is computed
        assertTrue(scores.containsKey(ScoreMetric.LR_TOTAL));
        assertEquals(750.0, scores.get(ScoreMetric.LR_TOTAL), 0.001);

        // Invariant: FULL_OVERALL must NOT exist for TOEIC
        assertFalse(scores.containsKey(ScoreMetric.FULL_OVERALL));
    }

    @Test
    @DisplayName("Answer normalization cleans whitespace and standardizes punctuation")
    void testAnswerNormalizer() {
        Map<String, Object> policy = Map.of("stripPunctuation", true);
        assertEquals("hello world", normalizer.normalize("   Hello,   WORLD!   ", policy));
    }

    @Test
    @DisplayName("Objective scoring matches accepted answer variants")
    void testObjectiveAnswerMatching() {
        Map<String, Object> accepted = Map.of("variants", List.of("global warming", "climate change"));
        Map<String, Object> policy = Map.of();

        var res1 = normalizer.evaluate("   Global Warming  ", accepted, policy, 1.0);
        assertTrue(res1.isMatched());
        assertEquals(1.0, res1.awardedCredit(), 0.001);

        var res2 = normalizer.evaluate("CLIMATE CHANGE", accepted, policy, 1.0);
        assertTrue(res2.isMatched());
        assertEquals(1.0, res2.awardedCredit(), 0.001);

        var res3 = normalizer.evaluate("pollution", accepted, policy, 1.0);
        assertFalse(res3.isMatched());
        assertEquals(0.0, res3.awardedCredit(), 0.001);
    }
}
