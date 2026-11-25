package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.LivingRules.EraGate;
import com.englishcoach.garden.domain.LivingRules.Family;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The monumental Knowledge Tree (Phase 3B, blueprint §7.1): pure progression rules over counters of VERIFIED history.
 * An era is reached when every gate up to it is satisfied; nothing here can lower an era (the stored era is the maximum
 * ever computed). Progress proves participation, never proficiency.
 */
public final class MonumentEngine {

    /** Lifetime counters: verified learning days, days per skill family, credited graduations. */
    public record Counters(int learningDays, Map<Family, Integer> familyDays, int graduations) {

        public int days(Family f) {
            return familyDays.getOrDefault(f, 0);
        }
    }

    /** One requirement of a next step, with what the learner has ({@code have} is not capped). */
    public record Requirement(String code, int have, int need) {

        public boolean met() {
            return have >= need;
        }
    }

    public record NextEra(int era, List<Requirement> requirements) {}

    /** A permanent milestone: ERA / BRANCH (code = family) / MEMORY / RING, with its tier. */
    public record Milestone(String kind, String code, int tier) {}

    private final LivingRules.Monument rules;

    public MonumentEngine(LivingRules rules) {
        this.rules = rules.monument();
    }

    static int tierOf(List<Integer> thresholds, int value) {
        int tier = 0;
        for (int need : thresholds) {
            if (value < need) break;
            tier++;
        }
        return tier;
    }

    /** What the next tier needs, or empty at the top tier. */
    static Optional<Integer> nextAt(List<Integer> thresholds, int value) {
        return thresholds.stream().filter(need -> value < need).findFirst();
    }

    public int branchTier(int familyDays) {
        return tierOf(rules.branchTiers(), familyDays);
    }

    public Optional<Integer> nextBranchAt(int familyDays) {
        return nextAt(rules.branchTiers(), familyDays);
    }

    public int memoryTier(int graduations) {
        return tierOf(rules.memoryTiers(), graduations);
    }

    public Optional<Integer> nextMemoryAt(int graduations) {
        return nextAt(rules.memoryTiers(), graduations);
    }

    public int branchTierSum(Counters c) {
        int sum = 0;
        for (Family f : Family.values()) sum += branchTier(c.days(f));
        return sum;
    }

    private boolean satisfied(EraGate g, Counters c) {
        return c.learningDays() >= g.days() && c.graduations() >= g.graduations() && branchTierSum(c) >= g.branchTiers();
    }

    /** The highest era whose gate, and every gate before it, is satisfied. */
    public int era(Counters c) {
        int era = 0;
        for (EraGate g : rules.eras()) {
            if (!satisfied(g, c)) break;
            era = g.era();
        }
        return era;
    }

    /** Requirements of the era after {@code era} (only those the gate actually asks for); empty at the final era. */
    public Optional<NextEra> next(int era, Counters c) {
        return rules.eras().stream().filter(g -> g.era() > era).findFirst().map(g -> new NextEra(g.era(), List.of(
                new Requirement("DAYS", c.learningDays(), g.days()),
                new Requirement("GRADUATIONS", c.graduations(), g.graduations()),
                new Requirement("BRANCHES", branchTierSum(c), g.branchTiers())).stream().filter(r -> r.need() > 0).toList()));
    }

    /** Memory rings: after the final era, one per {@code ringEveryDays} further verified learning days (no cap). */
    public int rings(int era, Counters c) {
        if (rules.eras().isEmpty() || era < rules.maxEra() || rules.ringEveryDays() <= 0) return 0;
        return Math.max(0, (c.learningDays() - rules.eras().getLast().days()) / rules.ringEveryDays());
    }

    /** Verified learning days until the next ring; empty before the final era. */
    public Optional<Integer> daysToNextRing(int era, Counters c) {
        if (rules.eras().isEmpty() || era < rules.maxEra() || rules.ringEveryDays() <= 0) return Optional.empty();
        int past = Math.max(0, c.learningDays() - rules.eras().getLast().days());
        return Optional.of(rules.ringEveryDays() - past % rules.ringEveryDays());
    }

    /** A graduated tree counts for the monument when enough of its words were never credited before. */
    public boolean credits(int newWords) {
        return newWords >= rules.minNewWords();
    }

    /** Every milestone reached at these counters with {@code era} already raised (the caller stores each once). */
    public List<Milestone> milestones(int era, Counters c) {
        List<Milestone> out = new ArrayList<>();
        for (int e = 1; e <= era; e++) out.add(new Milestone("ERA", "ERA", e));
        for (Family f : Family.values()) {
            for (int t = 1; t <= branchTier(c.days(f)); t++) out.add(new Milestone("BRANCH", f.name(), t));
        }
        for (int t = 1; t <= memoryTier(c.graduations()); t++) out.add(new Milestone("MEMORY", "MEMORY", t));
        for (int r = 1; r <= rings(era, c); r++) out.add(new Milestone("RING", "RING", r));
        return out;
    }

    public static Counters counters(int learningDays, int vocabulary, int listening, int speaking, int writing, int exam,
                                    int graduations) {
        Map<Family, Integer> m = new EnumMap<>(Family.class);
        m.put(Family.VOCABULARY, vocabulary);
        m.put(Family.LISTENING, listening);
        m.put(Family.SPEAKING, speaking);
        m.put(Family.WRITING, writing);
        m.put(Family.EXAM, exam);
        return new Counters(learningDays, m, graduations);
    }
}
