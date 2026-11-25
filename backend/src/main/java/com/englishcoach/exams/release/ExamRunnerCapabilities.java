package com.englishcoach.exams.release;

import java.util.Map;
import java.util.Set;

import static java.util.Map.entry;

/**
 * Exams Recovery Phase 4B.9 / 4C.8 — what the CURRENT runtime can render and score, declared once.
 *
 * <p>{@link #INTERACTIONS} and {@link #FEATURES} mirror {@code frontend/src/lib/exams/runnerCapabilities.ts} entry for
 * entry; {@code frontend/scripts/check-exams-phase4-runtime-contract.mjs} parses BOTH files and fails on any drift, a
 * missing component, or a SUPPORTED feature without its {@code data-capability} marker in the claiming component.
 * {@link #MANIFEST_CONTRACT} and {@link #SCORING_CONTRACT} name backend facts that are each proven by a test
 * ({@code ExamPhase4ManifestContractTest}, {@code ExamPhase4ScoringTest}, {@code ExamImportDryRunPostgresTest}).
 * Nothing is inferred at runtime: a capability is SUPPORTED only when code + test exist.
 */
public final class ExamRunnerCapabilities {

    private ExamRunnerCapabilities() {}

    public enum Support { SUPPORTED, PARTIAL, UNSUPPORTED }

    /** Interaction type → learner runner support (rendering + answer payload + review). */
    public static final Map<String, Support> INTERACTIONS = Map.ofEntries(
            entry("SINGLE_CHOICE", Support.SUPPORTED),
            entry("TRUTH_CLASSIFICATION", Support.SUPPORTED),
            entry("MATCHING", Support.SUPPORTED),
            entry("HEADING_MATCHING", Support.SUPPORTED),
            entry("TEXT_GAP", Support.SUPPORTED),
            entry("SHORT_ANSWER", Support.SUPPORTED),
            entry("MULTIPLE_CHOICE_MULTI", Support.SUPPORTED),
            entry("WRITING_RESPONSE", Support.SUPPORTED),
            entry("SPEAKING_RESPONSE", Support.SUPPORTED),
            // Phase 6: one item per printed target, canonical option pool, figure shown once by the group via grant,
            // accessible select without drag-and-drop, scored per target by the objective scorer on the option id
            entry("LABEL_ASSIGNMENT", Support.SUPPORTED)
    );

    /** Presentation / media features a package may require. */
    public static final Map<String, Support> FEATURES = Map.ofEntries(
            entry("GROUP_INSTRUCTIONS", Support.SUPPORTED),
            entry("COMPLETION_TEMPLATE", Support.SUPPORTED),
            entry("CHOOSE_N_SELECTION", Support.SUPPORTED),
            entry("WORD_LIMIT_DISPLAY", Support.SUPPORTED),
            entry("MULTI_DOC_SEGMENTED", Support.SUPPORTED),
            entry("IMAGE_STIMULUS_GRANT", Support.SUPPORTED),
            entry("PER_PART_AUDIO_PLAYLIST", Support.SUPPORTED),
            entry("VIRTUAL_AUDIO_RANGE", Support.UNSUPPORTED)
    );

    /** Learner manifest DTO facts (ExamManifestService), proven by ExamPhase4ManifestContractTest. */
    public static final Set<String> MANIFEST_CONTRACT = Set.of(
            "GROUP_PRESENTATION",            // printed instructions / stem / selection carried once per group
            "GROUP_PLACEMENT_NUMBERING",     // form_groups ordinal + display numbering
            "ITEM_SELECTION_CARDINALITY",    // choose-N size reaches the runner (cardinality = selection.count)
            "ITEM_WORD_LIMIT",               // answer-spec word limit reaches the runner
            "ASSET_DELIVERY_PLAYBACK_GRANT"  // every asset resolvable by assetId through a playback grant
    );

    /** Objective scorer + scoring pipeline facts, proven by ExamPhase4ScoringTest / ExamImportDryRunPostgresTest. */
    public static final Set<String> SCORING_CONTRACT = Set.of(
            "UNORDERED_SET_DEDUP",           // choose-N: each key option credited once, duplicates never score twice
            "WORD_LIMIT_ENFORCED",           // server-side, raw response, accepted variants honoured
            "EMPTY_KEY_NEVER_MATCHES",       // blank key / blank response never correct (EXAM-AUD-026)
            "ATTEMPT_SNAPSHOT_SCORING",      // objective scoring from the attempt snapshot (EXAM-AUD-024)
            "PARTIAL_SECTION_UNSCALED",      // no standardized scale for an incomplete section
            "AI_FALLBACK_REVIEW_REQUIRED"    // productive fallback never authoritative (EXAM-AUD-014)
    );

    /** Interaction types the objective scorer judges deterministically (one option id / one text answer). */
    public static final Set<String> OBJECTIVE_SCORER_INTERACTIONS = Set.of(
            "SINGLE_CHOICE", "TRUTH_CLASSIFICATION", "MATCHING", "HEADING_MATCHING", "TEXT_GAP", "SHORT_ANSWER",
            "MULTIPLE_CHOICE_MULTI", "LABEL_ASSIGNMENT");

    /** Productive interaction types scored by the rubric-pinned AI judge (fallback ⇒ REVIEW_REQUIRED). */
    public static final Set<String> PRODUCTIVE_INTERACTIONS = Set.of("WRITING_RESPONSE", "SPEAKING_RESPONSE");

    /** Choice interactions whose key must be one of the item's option ids. */
    public static final Set<String> OPTION_KEYED_INTERACTIONS = Set.of(
            "SINGLE_CHOICE", "TRUTH_CLASSIFICATION", "MATCHING", "HEADING_MATCHING", "LABEL_ASSIGNMENT", "MULTIPLE_CHOICE_MULTI");

    /** The declared runtime as one value (tests inject a degraded copy to prove fail-closed readiness). */
    public record Capabilities(Map<String, Support> interactions, Map<String, Support> features,
                               Set<String> manifestContract, Set<String> scoringContract,
                               Set<String> objectiveScorerInteractions) {
        public boolean feature(String name) {
            return features.get(name) == Support.SUPPORTED;
        }
    }

    public static final Capabilities CURRENT = new Capabilities(INTERACTIONS, FEATURES, MANIFEST_CONTRACT,
            SCORING_CONTRACT, OBJECTIVE_SCORER_INTERACTIONS);
}
