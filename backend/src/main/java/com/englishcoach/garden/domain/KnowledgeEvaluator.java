package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.GardenRules.KnowledgeRules;
import com.englishcoach.garden.domain.GardenRules.StageRule;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Knowledge Tree evidence (Phase 2). A tree is five of the player's own flashcards; its growth is EVIDENCE OF PRACTICE
 * with the real fixed-interval scheduler (FlashcardService#reviewFlashcard: again / hard → due now, good → +3 days,
 * easy → +7 days + MASTERED; MASTERED never comes due again). Nothing here models recall probability, ease factors or
 * SM-2 intervals, and "graduated" never means permanent mastery.
 *
 * <ul>
 *   <li>Card evidence = distinct Vietnam calendar days on which the card was genuinely reviewed AFTER the tree was
 *   planted (from the ingested {@code FLASHCARD_REVIEWED} log), capped at {@code evidenceCap}.</li>
 *   <li>A card needs attention when the scheduler's own due date is overdue by more than the pest grace, or when the
 *   card no longer exists / belongs to the player.</li>
 *   <li>Stage = the highest stage rule met (evidence sum, tree age in real days, per-card minimum). The stored peak
 *   never decreases; health (cards needing attention) is shown separately.</li>
 *   <li>Graduation needs the final stage, the minimum age, every card qualifying (present, studied — LEARNED or
 *   MASTERED —, enough review days, not overdue), no unresolved pest and no retry rest.</li>
 * </ul>
 */
public final class KnowledgeEvaluator {

    public enum Health { HEALTHY, THIRSTY, WILTING }

    /** Facts of one bound card, read from the Flashcard module at evaluation time. */
    public record CardFacts(long flashcardId, String word, String meaningVi, boolean present, String status,
                            boolean overdue, int reviewDays, Instant lastReviewAt) {}

    public record CardResult(CardFacts facts, int evidence, boolean needsAttention, boolean qualifies) {}

    public record Evaluation(int evidence, int maxEvidence, int computedStage, int stage, long ageDays,
                             List<CardResult> cards, Health health, int attention, boolean graduationEligible,
                             List<String> blockers, Instant ageReachedAt, NextStage next) {}

    /** What the next stage still needs (null at the final stage): evidence missing, days to wait, cards below. */
    public record NextStage(int stage, int evidenceMissing, Instant reachableAt, int cardsBelowMinimum) {}

    private final KnowledgeRules rules;

    public KnowledgeEvaluator(GardenRules rules) {
        this.rules = rules.knowledge();
    }

    public long ageDays(Instant plantedAt, Instant now) {
        return Math.max(0, Duration.between(plantedAt, now).toDays());
    }

    public int finalStage() {
        return rules.stages().stream().mapToInt(StageRule::stage).max().orElse(1);
    }

    public Evaluation evaluate(Instant plantedAt, int storedPeak, List<CardFacts> cards, Instant now,
                               boolean pestActive, Instant retryAt) {
        int cap = rules.evidenceCap();
        List<CardResult> results = new ArrayList<>();
        int sum = 0;
        int minEvidence = Integer.MAX_VALUE;
        int attention = 0;
        var g = rules.graduation();
        for (CardFacts f : cards) {
            int e = f.present() ? Math.min(cap, Math.max(0, f.reviewDays())) : 0;
            boolean needs = !f.present() || f.overdue();
            boolean studied = "LEARNED".equals(f.status()) || "MASTERED".equals(f.status());
            boolean qualifies = f.present() && studied && !f.overdue() && e >= g.minPerCard();
            results.add(new CardResult(f, e, needs, qualifies));
            sum += e;
            minEvidence = Math.min(minEvidence, e);
            if (needs) attention++;
        }
        if (cards.isEmpty()) minEvidence = 0;
        long age = ageDays(plantedAt, now);

        int computed = 1;
        NextStage next = null;
        for (StageRule s : rules.stages().stream().sorted((a, b) -> Integer.compare(a.stage(), b.stage())).toList()) {
            boolean met = sum >= s.minEvidence() && age >= s.minAgeDays() && minEvidence >= s.minPerCard();
            if (met) {
                computed = Math.max(computed, s.stage());
            } else if (next == null && s.stage() > computed) {
                int below = (int) results.stream().filter(r -> r.evidence() < s.minPerCard()).count();
                next = new NextStage(s.stage(), Math.max(0, s.minEvidence() - sum),
                        plantedAt.plus(Duration.ofDays(s.minAgeDays())), below);
            }
        }
        int stage = Math.max(computed, Math.max(1, storedPeak));
        if (next != null && next.stage() <= stage) next = null;

        Health health = attention == 0 ? Health.HEALTHY : attention <= 2 ? Health.THIRSTY : Health.WILTING;

        List<String> blockers = new ArrayList<>();
        Instant ageAt = plantedAt.plus(Duration.ofDays(g.minAgeDays()));
        if (age < g.minAgeDays()) blockers.add("AGE");
        if (stage < finalStage()) blockers.add("STAGE");
        if (results.stream().anyMatch(r -> !r.facts().present())) blockers.add("CARD_LOST");
        if (results.stream().anyMatch(r -> r.facts().present() && r.facts().overdue())) blockers.add("CARD_OVERDUE");
        if (results.stream().anyMatch(r -> r.facts().present() && !"LEARNED".equals(r.facts().status())
                && !"MASTERED".equals(r.facts().status()))) blockers.add("CARD_NEW");
        if (results.stream().anyMatch(r -> r.facts().present() && r.evidence() < g.minPerCard())) blockers.add("CARD_EVIDENCE");
        if (pestActive) blockers.add("PEST");
        if (retryAt != null && now.isBefore(retryAt)) blockers.add("RETRY_WAIT");
        if (cards.size() != rules.cards()) blockers.add("CARD_LOST");
        boolean eligible = blockers.isEmpty();
        return new Evaluation(sum, cap * rules.cards(), computed, stage, age, results, health, attention, eligible,
                blockers.stream().distinct().toList(), ageAt, next);
    }

    /** Essence accrual rate per day at a stage (0 for stages without essence). */
    public double essencePerDay(int stage) {
        double[] r = rules.essencePerDay();
        return stage >= 0 && stage < r.length ? r[stage] : 0;
    }

    /** The store holds at most {@code essenceStoreDays} days of the current stage's rate. */
    public double essenceStore(int stage) {
        return essencePerDay(stage) * rules.essenceStoreDays();
    }

    /** Essence available at {@code now}: banked (from earlier stages) + accrual at the stage's rate, capped. */
    public double essenceAccrued(double banked, Instant since, int stage, Instant now) {
        double days = Math.max(0, Duration.between(since, now).toMillis() / 86_400_000.0);
        double store = essenceStore(stage);
        return Math.min(Math.max(store, 0), Math.max(0, banked) + essencePerDay(stage) * days);
    }

    /** When the store will be full (null when it already is or the stage produces nothing). */
    public Instant essenceFullAt(double banked, Instant since, int stage, Instant now) {
        double rate = essencePerDay(stage);
        if (rate <= 0) return null;
        double missing = essenceStore(stage) - essenceAccrued(banked, since, stage, now);
        if (missing <= 1e-9) return null;
        return now.plusMillis((long) Math.ceil(missing / rate * 86_400_000.0));
    }
}
