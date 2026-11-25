package com.englishcoach.proficiency.placement;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.List;

/**
 * "Bài xếp lớp nhanh" ({@code app.proficiency.placement-quiz.*}). Model 2 (hotfix 2026-10-02): per level A1–C1
 * {@code vocabulary-per-level} vocabulary + {@code grammar-per-level} grammar multiple-choice questions from
 * {@code proficiency_placement_question}; result capped at C1 (no C2 item bank). Placement never creates evidence
 * or changes ratings / relativeMult.
 * <p>Quick form (2026-10-02): 3 + 3 per level = 30 of the 80-question bank (~4 minutes). The seeded population
 * simulation ({@code PlacementScorerTest}) gives ~77 % exact / ≥ 99.9 % within one level vs ~80 % / 99.99 % for the
 * previous 40-item form; the scorer, thresholds and model version are unchanged (it is length-agnostic, so issues
 * started with 40 items still score).
 */
@Data
@Configuration
@ConfigurationProperties(prefix = "app.proficiency.placement-quiz")
public class PlacementQuizProperties {

    /** Model version written on new issues / attempts (1 = V63 yes/no word recognition, retired). */
    public static final int MODEL_VERSION = 2;

    private boolean enabled = true;
    private List<String> levels = new ArrayList<>(List.of("A1", "A2", "B1", "B2", "C1"));
    private int vocabularyPerLevel = 3;
    private int grammarPerLevel = 3;
    /** Ability-score thresholds for A2, B1, B2, C1 (see {@link PlacementScorer}). */
    private List<Double> thresholds = new ArrayList<>(List.of(1.6, 2.6, 3.6, 4.5));
    /** Minimum mastery the result level itself needs (else one level lower). */
    private double minLevelMastery = 0.34;
    /** Top-two-levels minus bottom-two-levels mastery at or above which the attempt is INVALID. */
    private double invalidReversal = 0.5;
    /** Days after a VALID model-2 attempt before a retake (INVALID and model-1 results can be retaken at once). */
    private int retakeDays = 30;
    /**
     * Minutes an issued item list stays answerable — also the resume window of an unfinished, autosaved attempt (V69:
     * 24 h so a closed tab / F5 / later visit can continue; was 45 min). Expired attempts are closed as ABANDONED.
     */
    private int issueTtlMinutes = 1440;

    public int itemCount() {
        return levels.size() * (vocabularyPerLevel + grammarPerLevel);
    }

    public PlacementScorer.Params scorerParams() {
        return new PlacementScorer.Params(levels, thresholds, minLevelMastery, invalidReversal, 4);
    }
}
