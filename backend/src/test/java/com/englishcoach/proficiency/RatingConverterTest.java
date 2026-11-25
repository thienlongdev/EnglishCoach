package com.englishcoach.proficiency;

import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.proficiency.model.EvidenceKind;
import com.englishcoach.proficiency.model.ProficiencyCefr;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

/** Score mapping (Spec §4, Hardening #9) with the same anchors V53 seeds. */
class RatingConverterTest {

    private static List<ScoreMappingRepository.Anchor> anchors(double[][] pairs) {
        return java.util.Arrays.stream(pairs)
                .map(p -> new ScoreMappingRepository.Anchor(BigDecimal.valueOf(p[0]), (int) p[1])).toList();
    }

    static final List<ScoreMappingRepository.Anchor> IELTS = anchors(new double[][]{
            {0.0, 0}, {3.0, 200}, {4.0, 334}, {5.5, 500}, {7.0, 667}, {8.5, 834}, {9.0, 950}});
    static final List<ScoreMappingRepository.Anchor> TOEIC_L = anchors(new double[][]{
            {5, 0}, {60, 0}, {110, 167}, {275, 334}, {400, 500}, {490, 667}, {495, 700}});

    @Test
    @DisplayName("IELTS 6.0 interpolates between 5.5→500 and 7.0→667 (= 556)")
    void ieltsInterpolation() {
        assertEquals(Optional.of(556), RatingConverter.interpolateAnchors(IELTS, 6.0)); // 500 + 0.5/1.5 × 167 = 555.67
        assertEquals(Optional.of(667), RatingConverter.interpolateAnchors(IELTS, 7.0));
        assertEquals(Optional.of(0), RatingConverter.interpolateAnchors(IELTS, 0.0));
        assertEquals(Optional.of(950), RatingConverter.interpolateAnchors(IELTS, 9.0));
    }

    @Test
    @DisplayName("TOEIC Listening 400 → 500")
    void toeicListening() {
        assertEquals(Optional.of(500), RatingConverter.interpolateAnchors(TOEIC_L, 400));
        assertEquals(Optional.of(0), RatingConverter.interpolateAnchors(TOEIC_L, 30)); // below A1 minimum: flat 0
    }

    @Test
    @DisplayName("Outside the official scale ⇒ no evidence (never extrapolate): IELTS 9.5, TOEIC L 500")
    void outsideScale() {
        assertEquals(Optional.empty(), RatingConverter.interpolateAnchors(IELTS, 9.5));
        assertEquals(Optional.empty(), RatingConverter.interpolateAnchors(IELTS, -0.5));
        assertEquals(Optional.empty(), RatingConverter.interpolateAnchors(TOEIC_L, 500));
        assertEquals(Optional.empty(), RatingConverter.interpolateAnchors(TOEIC_L, 0));
        assertEquals(Optional.empty(), RatingConverter.interpolateAnchors(null, 5.0));
    }

    @Test
    @DisplayName("Scale resolution: LR_TOTAL / FULL_OVERALL / inconsistent scale names ⇒ none")
    void scaleResolution() {
        assertEquals(Optional.of("IELTS_BAND"), RatingConverter.resolveExamScale("IELTS", ScoreMetric.WRITING, "IELTS_BAND"));
        assertEquals(Optional.of("TOEIC_LISTENING"), RatingConverter.resolveExamScale("TOEIC", ScoreMetric.LISTENING, "TOEIC_SCALE_5_495"));
        assertEquals(Optional.of("TOEIC_SPEAKING"), RatingConverter.resolveExamScale("TOEIC", ScoreMetric.SPEAKING, "TOEIC_SCALE_0_200"));
        assertEquals(Optional.empty(), RatingConverter.resolveExamScale("TOEIC", ScoreMetric.LR_TOTAL, "TOEIC_SCALE_10_990"));
        assertEquals(Optional.empty(), RatingConverter.resolveExamScale("IELTS", ScoreMetric.FULL_OVERALL, "IELTS_BAND"));
        assertEquals(Optional.empty(), RatingConverter.resolveExamScale("TOEIC", ScoreMetric.SPEAKING, "IELTS_BAND"),
                "TOEIC speaking stored on the IELTS band scale is inconsistent");
    }

    @Test
    @DisplayName("T3 ceiling: B1 material at 0.95 → 499 (hi), never higher")
    void t3Ceiling() {
        RatingConverter.T3Observation high = RatingConverter.t3Observation(ProficiencyCefr.B1, 0.95);
        assertEquals(499, high.rating());
        assertEquals(EvidenceKind.LOWER_BOUND, high.kind());
        assertEquals(499, RatingConverter.t3Observation(ProficiencyCefr.B1, 1.0).rating());
        assertEquals(new RatingConverter.T3Observation(416, EvidenceKind.LOWER_BOUND), RatingConverter.t3Observation(ProficiencyCefr.B1, 0.75));
        assertEquals(new RatingConverter.T3Observation(334, EvidenceKind.POINT), RatingConverter.t3Observation(ProficiencyCefr.B1, 0.60));
        assertEquals(new RatingConverter.T3Observation(234, EvidenceKind.POINT), RatingConverter.t3Observation(ProficiencyCefr.B1, 0.30));
        assertEquals(new RatingConverter.T3Observation(0, EvidenceKind.POINT), RatingConverter.t3Observation(ProficiencyCefr.A1, 0.10));
    }

    @Test
    @DisplayName("CEFR bands and strict parsing (no default, no lenient prefix)")
    void cefr() {
        assertEquals(ProficiencyCefr.B2, ProficiencyCefr.fromRating(556));
        assertEquals(ProficiencyCefr.A1, ProficiencyCefr.fromRating(166));
        assertEquals(ProficiencyCefr.A2, ProficiencyCefr.fromRating(167));
        assertEquals(ProficiencyCefr.C2, ProficiencyCefr.fromRating(1000));
        assertEquals(Optional.of(ProficiencyCefr.B1), ProficiencyCefr.parseStrict(" b1 "));
        assertEquals(Optional.empty(), ProficiencyCefr.parseStrict("B1+"));
        assertEquals(Optional.empty(), ProficiencyCefr.parseStrict(null));
        assertEquals(Optional.empty(), ProficiencyCefr.parseStrict(""));
    }
}
