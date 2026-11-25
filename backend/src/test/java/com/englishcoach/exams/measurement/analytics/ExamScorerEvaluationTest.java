package com.englishcoach.exams.measurement.analytics;

import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.EvaluationRecord;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.Split;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class ExamScorerEvaluationTest {

    @Test
    void computesErrorAgreementCorrelationAndAbstentionOnLockedDisjointTest() {
        List<EvaluationRecord> rows = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            rows.add(new EvaluationRecord(UUID.nameUUIDFromBytes(("m" + i).getBytes()), Split.TEST,
                    i % 2 == 0 ? "fluency" : "grammar", i, i == 9 ? null : (double) i, i == 9, "cohort-a"));
        }
        var report = ExamScorerEvaluation.evaluate(rows, true, new ExamScorerEvaluation.Policy(10, 1));
        assertEquals("CALCULATED", report.overall().status());
        assertEquals(10, report.overall().sampleSize());
        assertEquals(9, report.overall().scoredCount());
        assertEquals(1, report.overall().abstainedCount());
        assertEquals(.1, report.overall().abstentionRate(), .00001);
        assertNotNull(report.overall().mae());
        assertNotNull(report.overall().rmse());
        assertNotNull(report.overall().kappa());
        assertNotNull(report.overall().correlation());
    }

    @Test
    void lockedTestAndEvidenceMinimumsAreFailClosed() {
        var row = new EvaluationRecord(UUID.randomUUID(), Split.TEST, "grammar", 4, 4.0, false, "a");
        var report = ExamScorerEvaluation.evaluate(List.of(row), false,
                new ExamScorerEvaluation.Policy(2, 1));
        assertEquals("INSUFFICIENT", report.overall().status());
        assertTrue(report.hygieneFlags().contains("TEST_SPLIT_NOT_LOCKED"));
    }

    @Test
    void rejectsAResearchRecordAppearingInTwoSplits() {
        UUID member = UUID.randomUUID();
        var report = ExamScorerEvaluation.evaluate(List.of(
                new EvaluationRecord(member, Split.CALIBRATION, "grammar", 4, 4.0, false, "a"),
                new EvaluationRecord(member, Split.TEST, "grammar", 4, 4.0, false, "a")
        ), true, new ExamScorerEvaluation.Policy(1, 1));
        assertTrue(report.hygieneFlags().contains("SPLIT_OVERLAP"));
        assertEquals("INSUFFICIENT", report.overall().status());
    }
}
