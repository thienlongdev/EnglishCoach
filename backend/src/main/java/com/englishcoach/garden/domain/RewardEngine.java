package com.englishcoach.garden.domain;

import java.util.List;

/**
 * Learning → garden resources (02 §7), flashcard rule of Phase 1. Raw units of a VN calendar day pass through the
 * diminishing schedule (units 1–20 at 100 %, 21–40 at 70 %, then 30 %) into effective units; every
 * {@code unitsPerWater} effective units grant one water (the fraction carries within the day only) and every
 * effective unit is worth {@code xpPerUnit} XP. Integer grants are differences of floors of the running totals, so the
 * result never depends on how events are batched.
 */
public final class RewardEngine {

    public record DayStats(double rawUnits, double effectiveUnits, double waterCarry, int reviews) {
        public static DayStats empty() {
            return new DayStats(0, 0, 0, 0);
        }
    }

    public record Delta(DayStats after, double rawUnits, double effectiveUnits, int water, int xp) {}

    private final GardenRules rules;

    public RewardEngine(GardenRules rules) {
        this.rules = rules;
    }

    /** R2: the first review of a card on a day is worth a full unit; repeats of the same card that day are not. */
    public double unitsForReview(boolean firstReviewOfCardToday) {
        return firstReviewOfCardToday ? rules.rewards().reviewUnit() : rules.rewards().repeatSameDayUnit();
    }

    /** Effective units gained when the day's raw total moves from {@code rawBefore} by {@code add}. */
    public double effectiveGain(double rawBefore, double add) {
        return scheduleGain(rules.rewards().diminishing(), rawBefore, add);
    }

    /**
     * Harvest XP actually granted when the day's raw harvest XP moves from {@code rawBefore} by {@code add} (Phase 2):
     * the first harvests of a day keep their full value, a long farming session earns progressively less XP (coins
     * are untouched). Rounded down per call; callers pass whole harvest lines.
     */
    public int harvestXpGain(double rawBefore, double add) {
        var rows = rules.rewards().harvestXpDiminishing();
        if (rows == null || rows.isEmpty()) return (int) Math.floor(add + 1e-9);
        double before = scheduleGain(rows, 0, rawBefore);
        double after = scheduleGain(rows, 0, rawBefore + add);
        return (int) (Math.floor(after + 1e-9) - Math.floor(before + 1e-9));
    }

    private static double scheduleGain(List<double[]> schedule, double rawBefore, double add) {
        double gained = 0;
        double lower = 0;
        double from = rawBefore;
        double to = rawBefore + add;
        for (double[] tier : schedule) {
            double upper = tier[0];
            double a = Math.max(from, lower);
            double b = Math.min(to, upper);
            if (b > a) gained += (b - a) * tier[1];
            lower = upper;
            if (to <= upper) break;
        }
        return gained;
    }

    public Delta applyReview(DayStats before, boolean firstReviewOfCardToday) {
        double raw = unitsForReview(firstReviewOfCardToday);
        double eff = effectiveGain(before.rawUnits(), raw);
        double carry = before.waterCarry() + eff;
        int water = (int) Math.floor(carry / rules.rewards().unitsPerWater() + 1e-9);
        carry -= water * rules.rewards().unitsPerWater();
        double effAfter = before.effectiveUnits() + eff;
        int xp = (int) Math.floor(effAfter * rules.rewards().xpPerUnit() + 1e-9)
                - (int) Math.floor(before.effectiveUnits() * rules.rewards().xpPerUnit() + 1e-9);
        var after = new DayStats(before.rawUnits() + raw, effAfter, Math.max(0, carry), before.reviews() + 1);
        return new Delta(after, raw, eff, water, xp);
    }

    /**
     * Daily goal: enough effective units, or the due queue emptied after at least the minimum number of reviews today,
     * or (Phase 2) the mixed day — {@code goalMixUnits} units plus {@code goalMixSkills} credited skill lessons.
     */
    public boolean goalReached(DayStats today, long dueCountNow) {
        return goalReached(today, dueCountNow, 0);
    }

    public boolean goalReached(DayStats today, long dueCountNow, int skillsToday) {
        var r = rules.rewards();
        return today.effectiveUnits() + 1e-9 >= r.goalUnits()
                || (today.reviews() >= r.goalDueMinReviews() && dueCountNow == 0)
                || mixedGoal(today.effectiveUnits(), skillsToday);
    }

    public boolean mixedGoal(double effectiveUnits, int skillsToday) {
        var r = rules.rewards();
        return r.goalMixSkills() > 0 && skillsToday >= r.goalMixSkills() && effectiveUnits + 1e-9 >= r.goalMixUnits();
    }

    /** One verified activity of a learning category (Phase 2): rewards while under the daily cap, else nothing. */
    public record ActivityCredit(boolean credited, int xp, int fertilizer) {}

    public ActivityCredit creditActivity(String category, int creditedTodayBefore) {
        var c = rules.learning() == null ? null : rules.learning().categories().get(category);
        if (c == null || creditedTodayBefore >= c.dailyCap()) return new ActivityCredit(false, 0, 0);
        return new ActivityCredit(true, c.xp(), creditedTodayBefore < c.fertilizerFirst() ? 1 : 0);
    }
}
