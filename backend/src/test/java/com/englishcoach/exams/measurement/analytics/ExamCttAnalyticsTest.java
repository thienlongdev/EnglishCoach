package com.englishcoach.exams.measurement.analytics;

import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.AnalysisReport;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.OutcomeStatus;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class ExamCttAnalyticsTest {

    private final UUID itemA = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private final UUID itemB = UUID.fromString("00000000-0000-0000-0000-000000000002");

    @Test
    void computesItemRestDistractorsOmissionAndTimeWithoutCountingUnknownAsWrong() {
        List<ExamCttAnalytics.Observation> rows = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            UUID respondent = UUID.nameUUIDFromBytes(("r" + i).getBytes());
            boolean correct = i < 3;
            rows.add(new ExamCttAnalytics.Observation(respondent, itemA,
                    correct ? OutcomeStatus.CORRECT : OutcomeStatus.INCORRECT,
                    correct ? 1 : 0, 1, 100L + i, correct ? "A" : "B"));
            rows.add(new ExamCttAnalytics.Observation(respondent, itemB,
                    correct ? OutcomeStatus.CORRECT : OutcomeStatus.INCORRECT,
                    correct ? 1 : 0, 1, 200L + i, correct ? "C" : "D"));
        }
        rows.add(new ExamCttAnalytics.Observation(UUID.randomUUID(), itemA, OutcomeStatus.OMITTED,
                0, 1, 700L, null));
        ExamCttAnalytics.Policy policy = new ExamCttAnalytics.Policy(5, 5, 2, .2, .9, 0, .2);

        AnalysisReport report = ExamCttAnalytics.report(UUID.randomUUID(), rows, policy);
        var stat = report.itemStatistics().stream().filter(s -> s.itemId().equals(itemA)).findFirst().orElseThrow();
        assertEquals(7, stat.sampleSize());
        assertEquals(6, stat.validCount());
        assertEquals(.5, stat.pValue(), .00001);
        assertNotNull(stat.itemRestPointBiserial());
        assertTrue(stat.itemRestPointBiserial() > 0);
        assertEquals(1.0 / 7.0, stat.omissionRate(), .00001);
        assertEquals(103L, stat.medianResponseTimeMs());
        assertEquals(0.5, stat.distractorRates().get("A"), .00001);
        assertEquals("CALCULATED", stat.calculationStatus());
        assertEquals("CALCULATED", report.reliability().status());
        assertNotNull(report.reliability().kr20());
    }

    @Test
    void failsClosedForInsufficientAndUndefinedReliability() {
        UUID respondent = UUID.randomUUID();
        var small = ExamCttAnalytics.report(UUID.randomUUID(), List.of(
                new ExamCttAnalytics.Observation(respondent, itemA, OutcomeStatus.CORRECT, 1, 1, 50L, "A")
        ), ExamCttAnalytics.Policy.pilotDefault());
        assertEquals("INSUFFICIENT", small.reliability().status());
        assertEquals("INSUFFICIENT", small.itemStatistics().get(0).calculationStatus());

        List<ExamCttAnalytics.Observation> constantTotal = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            UUID r = UUID.nameUUIDFromBytes(("c" + i).getBytes());
            constantTotal.add(new ExamCttAnalytics.Observation(r, itemA,
                    i % 2 == 0 ? OutcomeStatus.CORRECT : OutcomeStatus.INCORRECT,
                    i % 2 == 0 ? 1 : 0, 1, 1L, "A"));
            constantTotal.add(new ExamCttAnalytics.Observation(r, itemB,
                    i % 2 == 0 ? OutcomeStatus.INCORRECT : OutcomeStatus.CORRECT,
                    i % 2 == 0 ? 0 : 1, 1, 1L, "B"));
        }
        var undefined = ExamCttAnalytics.report(UUID.randomUUID(), constantTotal,
                new ExamCttAnalytics.Policy(2, 5, 2, .2, .9, 0, .2));
        assertEquals("UNDEFINED", undefined.reliability().status());
        assertNull(undefined.reliability().kr20());
    }
}
