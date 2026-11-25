package com.englishcoach.exams.scoring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import org.junit.jupiter.api.Test;

/**
 * IELTS business audit 2026-11-13 — the raw-to-band fallback is skill- and variant-specific. Anchors are the approximate
 * marks per band published on ielts.org ("IELTS scoring in detail", fetched 2026-11-13); a scheme mapping table wins.
 */
class IeltsRawToBandFallbackTest {

    private final ExamObjectiveScorer scorer = new ExamObjectiveScorer(new ExamAnswerNormalizer());

    @Test
    void listeningAnchorsFollowTheOfficialApproximateMarks() {
        assertEquals(5.0, ExamObjectiveScorer.fallbackIeltsRawToBand(16, ScoreMetric.LISTENING, "ACADEMIC"));
        assertEquals(6.0, ExamObjectiveScorer.fallbackIeltsRawToBand(23, ScoreMetric.LISTENING, "ACADEMIC"));
        assertEquals(7.0, ExamObjectiveScorer.fallbackIeltsRawToBand(30, ScoreMetric.LISTENING, "GENERAL_TRAINING"));
        assertEquals(8.0, ExamObjectiveScorer.fallbackIeltsRawToBand(35, ScoreMetric.LISTENING, null));
        // The former shared table gave 15 → 5.0; ielts.org places Band 5 at 16 for Listening.
        assertEquals(4.5, ExamObjectiveScorer.fallbackIeltsRawToBand(15, ScoreMetric.LISTENING, "ACADEMIC"));
    }

    @Test
    void academicReadingAnchorsAreUnchanged() {
        assertEquals(5.0, ExamObjectiveScorer.fallbackIeltsRawToBand(15, ScoreMetric.READING, "ACADEMIC"));
        assertEquals(6.0, ExamObjectiveScorer.fallbackIeltsRawToBand(23, ScoreMetric.READING, "ACADEMIC"));
        assertEquals(7.0, ExamObjectiveScorer.fallbackIeltsRawToBand(30, ScoreMetric.READING, "ACADEMIC"));
        assertEquals(8.0, ExamObjectiveScorer.fallbackIeltsRawToBand(35, ScoreMetric.READING, "ACADEMIC"));
        assertEquals(9.0, ExamObjectiveScorer.fallbackIeltsRawToBand(40, ScoreMetric.READING, null));
    }

    @Test
    void generalTrainingReadingNeedsMoreCorrectAnswersForTheSameBand() {
        assertEquals(4.0, ExamObjectiveScorer.fallbackIeltsRawToBand(15, ScoreMetric.READING, "GENERAL_TRAINING"));
        assertEquals(5.0, ExamObjectiveScorer.fallbackIeltsRawToBand(23, ScoreMetric.READING, "GENERAL_TRAINING"));
        assertEquals(6.0, ExamObjectiveScorer.fallbackIeltsRawToBand(30, ScoreMetric.READING, "GENERAL_TRAINING"));
        assertEquals(7.0, ExamObjectiveScorer.fallbackIeltsRawToBand(35, ScoreMetric.READING, "general-training"));
        assertEquals(9.0, ExamObjectiveScorer.fallbackIeltsRawToBand(40, ScoreMetric.READING, "GENERAL_TRAINING"));
        assertEquals(0.0, ExamObjectiveScorer.fallbackIeltsRawToBand(0, ScoreMetric.READING, "GENERAL_TRAINING"));
    }

    @Test
    void everyTableIsMonotonicAndInHalfBands() {
        for (ScoreMetric metric : new ScoreMetric[] {ScoreMetric.LISTENING, ScoreMetric.READING}) {
            for (String variant : new String[] {"ACADEMIC", "GENERAL_TRAINING"}) {
                double previous = 0.0;
                for (int raw = 0; raw <= 40; raw++) {
                    double band = ExamObjectiveScorer.fallbackIeltsRawToBand(raw, metric, variant);
                    assertTrue(band >= previous, metric + " " + variant + " not monotonic at " + raw);
                    assertEquals(0.0, (band * 2) % 1, 1e-9, "half bands only");
                    previous = band;
                }
            }
        }
    }

    @Test
    void sectionScoringUsesTheVariantAndTheOldSignatureStaysAcademic() {
        assertEquals(6.0, scorer.mapRawToScaled(30, 40, ExamFamily.IELTS, ScoreMetric.READING, null, "GENERAL_TRAINING"));
        assertEquals(7.0, scorer.mapRawToScaled(30, 40, ExamFamily.IELTS, ScoreMetric.READING, null));
    }
}
