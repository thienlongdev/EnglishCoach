package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.LivingRules.Family;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.IntPredicate;

/**
 * Deterministic long-horizon simulation of the Phase 3B monument (no randomness, no clock, no database): scripted
 * personas study on scripted days and the REAL {@link MonumentEngine} decides eras, branch tiers and rings from the
 * resulting counters. It models the learning calendar and the five-card tree cycle only — coins, XP and harvests stay
 * with {@link EconomySimulator}. Results feed docs/echo-garden/PHASE3B_PROGRESSION_SIM_RESULTS.md; they are scripted
 * scenarios, never telemetry.
 *
 * <p>Tree model (mirrors the seeded Phase 2 rules): a grove slot opens on a given day; a tree planted there can graduate
 * on a study day once it is {@code minAgeDays} old and its words were reviewed on at least {@code reviewDaysNeeded}
 * study days since planting; the slot is replanted on the next study day. A tree counts for the monument when at least
 * {@code minNewWords} of its five words were never credited before.
 */
public final class ProgressionSimulator {

    /**
     * {@code studies}: day (1-based) → the learner studies that day; {@code cards}: different cards reviewed on a study
     * day; {@code skillEvery}: family → every n-th study day carries one qualifying lesson of that family (absent =
     * never); {@code slotDays}: day each grove slot opens (empty = never plants a tree); {@code newWordsPerTree}: words of
     * each new tree that were never planted before (5 = always new words, 0 = the same five words again and again).
     */
    public record Persona(String code, String label, IntPredicate studies, int cards, Map<Family, Integer> skillEvery,
                          int[] slotDays, int newWordsPerTree) {}

    public record Snapshot(int day, int learningDays, Map<Family, Integer> familyDays, int graduations, int forest, int era,
                           int branchTiers, int memoryTier, int rings) {}

    public record Result(Persona persona, List<Snapshot> days) {

        public Snapshot at(int day) {
            return days.get(Math.min(day, days.size()) - 1);
        }

        /** First day the era was reached, or -1. */
        public int dayReachingEra(int era) {
            return days.stream().filter(d -> d.era() >= era).mapToInt(Snapshot::day).findFirst().orElse(-1);
        }

        /** First day any ornament (branch tier or memory lantern) hangs on the tree, or -1. */
        public int firstOrnamentDay() {
            return days.stream().filter(d -> d.branchTiers() > 0 || d.memoryTier() > 0).mapToInt(Snapshot::day).findFirst().orElse(-1);
        }
    }

    private final LivingRules rules;
    private final MonumentEngine engine;
    private final int minAgeDays;
    private final int reviewDaysNeeded;

    public ProgressionSimulator(LivingRules rules, int minAgeDays, int reviewDaysNeeded) {
        this.rules = rules;
        this.engine = new MonumentEngine(rules);
        this.minAgeDays = minAgeDays;
        this.reviewDaysNeeded = reviewDaysNeeded;
    }

    public Result run(Persona p, int days) {
        Map<Family, Integer> family = new EnumMap<>(Family.class);
        for (Family f : Family.values()) family.put(f, 0);
        int learningDays = 0, credited = 0, forest = 0, era = 0, studyDays = 0;
        int slots = p.slotDays().length;
        int[] plantedOn = new int[slots];        // 0 = empty
        int[] reviewsSince = new int[slots];
        int[] newWords = new int[slots];
        Set<Integer> exploitWords = new HashSet<>();
        List<Snapshot> out = new ArrayList<>();
        for (int day = 1; day <= days; day++) {
            if (p.studies().test(day)) {
                studyDays++;
                boolean verified = false;
                if (p.cards() >= rules.monument().minCardReviews()) {
                    family.merge(Family.VOCABULARY, 1, Integer::sum);
                    verified = true;
                }
                for (var s : p.skillEvery().entrySet()) {
                    if (s.getValue() > 0 && studyDays % s.getValue() == 0) {
                        family.merge(s.getKey(), 1, Integer::sum);
                        verified = true;
                    }
                }
                if (verified) learningDays++;
                // the grove: trees need real card reviews, so only a learner who reviews cards tends them
                if (p.cards() > 0) {
                    for (int s = 0; s < slots; s++) {
                        if (plantedOn[s] > 0) {
                            reviewsSince[s]++;
                            if (day - plantedOn[s] >= minAgeDays && reviewsSince[s] >= reviewDaysNeeded) {
                                forest++;
                                if (engine.credits(newWords[s])) credited++;
                                plantedOn[s] = 0;
                            }
                        } else if (day >= p.slotDays()[s]) {
                            plantedOn[s] = day;
                            reviewsSince[s] = 0;
                            // the same five words again: only the first tree brings new words
                            newWords[s] = p.newWordsPerTree() > 0 ? p.newWordsPerTree() : exploitWords.add(0) ? 5 : 0;
                        }
                    }
                }
            }
            var c = new MonumentEngine.Counters(learningDays, new EnumMap<>(family), credited);
            era = Math.max(era, engine.era(c));
            out.add(new Snapshot(day, learningDays, new EnumMap<>(family), credited, forest, era, engine.branchTierSum(c),
                    engine.memoryTier(credited), engine.rings(era, c)));
        }
        return new Result(p, List.copyOf(out));
    }

    /** day → studies on {@code perWeek} fixed weekdays of every week (evenly spread, deterministic). */
    public static IntPredicate weekly(int perWeek) {
        boolean[] on = new boolean[7];
        for (int i = 0; i < perWeek; i++) on[(int) Math.floor(i * 7.0 / perWeek)] = true;
        return day -> on[(day - 1) % 7];
    }

    public static List<Persona> personas() {
        Map<Family, Integer> none = Map.of();
        return List.of(
                new Persona("L0", "Farm-only (never studies)", d -> false, 0, none, new int[0], 5),
                new Persona("L1", "Casual learner: 3 days / week, 8 cards", weekly(3), 8, none, new int[]{4, 8, 25}, 5),
                new Persona("L2", "Normal learner: 6 days / week, 20 cards, dictation weekly", weekly(6), 20,
                        Map.of(Family.LISTENING, 6), new int[]{2, 4, 12}, 5),
                new Persona("L3", "Active multi-skill: daily, 60 cards, four skills", d -> true, 60,
                        Map.of(Family.LISTENING, 3, Family.SPEAKING, 4, Family.WRITING, 7, Family.EXAM, 14), new int[]{1, 2, 7}, 5),
                new Persona("L4", "Infrequent learner: 1 day / week, 10 cards", weekly(1), 10, none, new int[]{8, 16, 42}, 5),
                new Persona("L5", "Returner: 21 days daily, 60 days away, then 5 days / week", d -> d <= 21 || (d > 81 && weekly(5).test(d)),
                        20, none, new int[]{2, 4, 12}, 5),
                new Persona("L6", "Harvest-focused: 2 days / week, exactly 5 cards", weekly(2), 5, none, new int[]{5, 14, 30}, 5),
                new Persona("L7", "Exploit: daily, the same 5 mastered cards, the same five words replanted", d -> true, 5, none,
                        new int[]{2, 4, 12}, 0),
                new Persona("L8", "Mastered deck: daily voluntary re-review of 10 different mastered cards", d -> true, 10, none,
                        new int[]{2, 4, 12}, 5),
                new Persona("L9", "Writing only: 5 days / week, no flashcards", weekly(5), 0, Map.of(Family.WRITING, 1), new int[0], 5));
    }
}
