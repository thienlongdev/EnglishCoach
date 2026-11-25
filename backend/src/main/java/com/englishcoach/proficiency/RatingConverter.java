package com.englishcoach.proficiency;

import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.proficiency.model.EvidenceKind;
import com.englishcoach.proficiency.model.ProficiencyCefr;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Score → observedRating (Proficiency Spec §4).
 * Standardized scores: linear interpolation between DB anchors only; outside the anchor range ⇒
 * empty (no evidence, never extrapolate — Hardening #9). T3: CEFR-ceiling mapping, never above hi.
 */
@Component
@RequiredArgsConstructor
public class RatingConverter {

    public static final String IELTS_BAND = "IELTS_BAND";
    public static final String TOEIC_LISTENING = "TOEIC_LISTENING";
    public static final String TOEIC_READING = "TOEIC_READING";
    public static final String TOEIC_SPEAKING = "TOEIC_SPEAKING";
    public static final String TOEIC_WRITING = "TOEIC_WRITING";

    private final ScoreMappingRepository mappingRepository;
    private volatile Map<String, List<ScoreMappingRepository.Anchor>> anchors;

    public record T3Observation(int rating, EvidenceKind kind) {}

    /**
     * P3: mapping scale for an exam component, from family + metric + the component's persisted
     * scale_name. Any inconsistent combination (e.g. a TOEIC Speaking score stored as IELTS_BAND)
     * or a non-skill metric (FULL_OVERALL, LR_TOTAL) ⇒ empty.
     */
    public static Optional<String> resolveExamScale(String family, ScoreMetric metric, String componentScaleName) {
        if (family == null || metric == null || componentScaleName == null) return Optional.empty();
        boolean ielts = "IELTS".equals(family);
        boolean toeic = "TOEIC".equals(family);
        switch (metric) {
            case LISTENING, READING -> {
                if (ielts && "IELTS_BAND".equals(componentScaleName)) return Optional.of(IELTS_BAND);
                if (toeic && "TOEIC_SCALE_5_495".equals(componentScaleName)) {
                    return Optional.of(metric == ScoreMetric.LISTENING ? TOEIC_LISTENING : TOEIC_READING);
                }
                return Optional.empty();
            }
            case WRITING, SPEAKING -> {
                if (ielts && "IELTS_BAND".equals(componentScaleName)) return Optional.of(IELTS_BAND);
                if (toeic && "TOEIC_SCALE_0_200".equals(componentScaleName)) {
                    return Optional.of(metric == ScoreMetric.WRITING ? TOEIC_WRITING : TOEIC_SPEAKING);
                }
                return Optional.empty();
            }
            default -> {
                return Optional.empty();
            }
        }
    }

    /** Interpolated rating for a raw score on a scale; empty outside the anchors or unknown scale. */
    public Optional<Integer> interpolate(String scale, double rawScore) {
        List<ScoreMappingRepository.Anchor> list = anchors().get(scale);
        return interpolateAnchors(list, rawScore);
    }

    static Optional<Integer> interpolateAnchors(List<ScoreMappingRepository.Anchor> list, double raw) {
        if (list == null || list.isEmpty() || Double.isNaN(raw)) return Optional.empty();
        double min = list.get(0).rawScore().doubleValue();
        double max = list.get(list.size() - 1).rawScore().doubleValue();
        if (raw < min || raw > max) return Optional.empty();
        for (int i = 0; i < list.size(); i++) {
            double x = list.get(i).rawScore().doubleValue();
            if (raw == x) return Optional.of(list.get(i).rating());
            if (i + 1 < list.size()) {
                double x1 = list.get(i + 1).rawScore().doubleValue();
                if (raw > x && raw < x1) {
                    int r0 = list.get(i).rating();
                    int r1 = list.get(i + 1).rating();
                    double r = r0 + (raw - x) / (x1 - x) * (r1 - r0);
                    return Optional.of(BigDecimal.valueOf(r).setScale(0, RoundingMode.HALF_UP).intValue());
                }
            }
        }
        return Optional.empty();
    }

    /**
     * T3 ceiling mapping with content band [lo, hi] (never above hi):
     * q ≥ 0.85 → hi (LOWER_BOUND) · 0.70 ≤ q < 0.85 → floor((lo+hi)/2) (LOWER_BOUND) ·
     * 0.50 ≤ q < 0.70 → lo (POINT) · q < 0.50 → max(0, lo − 100) (POINT).
     */
    public static T3Observation t3Observation(ProficiencyCefr contentCefr, double quality) {
        int lo = contentCefr.lo();
        int hi = contentCefr.hi();
        if (quality >= 0.85) return new T3Observation(hi, EvidenceKind.LOWER_BOUND);
        if (quality >= 0.70) return new T3Observation(Math.floorDiv(lo + hi, 2), EvidenceKind.LOWER_BOUND);
        if (quality >= 0.50) return new T3Observation(lo, EvidenceKind.POINT);
        return new T3Observation(Math.max(0, lo - 100), EvidenceKind.POINT);
    }

    private Map<String, List<ScoreMappingRepository.Anchor>> anchors() {
        Map<String, List<ScoreMappingRepository.Anchor>> a = anchors;
        if (a == null) {
            synchronized (this) {
                if (anchors == null) {
                    anchors = mappingRepository.loadAll();
                }
                a = anchors;
            }
        }
        return a;
    }
}
