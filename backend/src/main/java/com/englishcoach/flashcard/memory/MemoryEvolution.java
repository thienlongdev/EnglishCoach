package com.englishcoach.flashcard.memory;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Card Alchemy (owner brief 2026-11-12): a collectible look derived only from persisted evidence. It is separate from the
 * review schedule (a card can be due and still be a Pearl) and it never goes down: every input is append-only
 * (flashcard_review_log, flashcard_fusions) except the legacy status/review count, which only decides RAW vs SILVER.
 *
 *  RAW    — Raw Memory: nothing practised yet.
 *  SILVER — Silver Echo: practised (a logged rating, or a stored status/review count from before the log existed).
 *  PRISM  — Holo Prism: the learner USED the word in their own sentence and the Fusion check accepted it.
 *  PEARL  — Eternal Pearl: recalled (Tốt / Dễ) on at least {@value #PEARL_DAYS} different days spanning at least
 *           {@value #PEARL_SPAN_DAYS} days. One Dễ, or many ratings in one session, never makes a Pearl.
 */
public final class MemoryEvolution {

    private MemoryEvolution() {}

    public static final int PEARL_DAYS = 3;
    public static final int PEARL_SPAN_DAYS = 14;
    /** A word is "weak" after Khó on this many different days within {@value #WEAK_WINDOW_DAYS} days (not one session). */
    public static final int WEAK_DAYS = 2;
    public static final int WEAK_WINDOW_DAYS = 30;

    public enum Tier { RAW, SILVER, PRISM, PEARL }

    /** The day a card became a Pearl, from its distinct recall days (sorted or not), or null when it has not. */
    public static LocalDate pearlDay(Iterable<LocalDate> recallDays) {
        TreeSet<LocalDate> days = new TreeSet<>();
        for (LocalDate d : recallDays) if (d != null) days.add(d);
        if (days.size() < PEARL_DAYS) return null;
        LocalDate first = days.first();
        int seen = 0;
        for (LocalDate d : days) {
            seen++;
            if (seen >= PEARL_DAYS && ChronoUnit.DAYS.between(first, d) >= PEARL_SPAN_DAYS) return d;
        }
        return null;
    }

    public static Tier tier(boolean pearl, boolean fused, boolean practised) {
        if (pearl) return Tier.PEARL;
        if (fused) return Tier.PRISM;
        if (practised) return Tier.SILVER;
        return Tier.RAW;
    }

    /** Practised before or after the log existed: a logged rating, a stored status other than NEW, or review count > 0. */
    public static boolean practised(boolean logged, String status, int reviewCount) {
        return logged || reviewCount > 0 || (status != null && !"NEW".equals(status));
    }

    /**
     * Weak word: Khó on at least {@value #WEAK_DAYS} different local days inside the window ending today, and the latest
     * rating of the card is not Dễ (a word the learner has since found easy is not weak any more).
     */
    public static boolean weak(Set<LocalDate> hardDays, String latestQuality, LocalDate today) {
        if (hardDays == null || "easy".equals(latestQuality)) return false;
        LocalDate from = today.minusDays(WEAK_WINDOW_DAYS);
        long n = hardDays.stream().filter(d -> d != null && !d.isBefore(from) && !d.isAfter(today)).count();
        return n >= WEAK_DAYS;
    }

    public static final int[] REVIEW_TARGETS = {100, 1000};

    public record Milestone(String key, String evidence, int target, int value, LocalDate reachedOn) {
        public boolean reached() { return reachedOn != null; }
    }

    /**
     * Memory Reef milestones, each from one kind of evidence (never mixed): review history (distinct days, rating count),
     * self-rated recall across days (pearls) and AI-verified usage (fusions). The reach day is computed from the data,
     * so it is the same on every load.
     *
     * @param reviewDays     distinct local days with at least one logged rating, any order
     * @param totalReviews   number of logged ratings
     * @param reviewReach    the local day of the n-th logged rating, for n in {@link #REVIEW_TARGETS}
     * @param pearlDays      the day each Pearl card became a Pearl
     * @param fusionDays     the day of each accepted Fusion
     */
    public static List<Milestone> milestones(Iterable<LocalDate> reviewDays, int totalReviews, Map<Integer, LocalDate> reviewReach,
                                             List<LocalDate> pearlDays, List<LocalDate> fusionDays) {
        TreeSet<LocalDate> days = new TreeSet<>();
        for (LocalDate d : reviewDays) if (d != null) days.add(d);
        List<LocalDate> sortedDays = new ArrayList<>(days);
        List<LocalDate> pearls = new ArrayList<>(pearlDays); pearls.sort(null);
        List<LocalDate> fusions = new ArrayList<>(fusionDays); fusions.sort(null);
        List<Milestone> out = new ArrayList<>();
        for (int n : new int[]{1, 7, 30, 100}) out.add(nth("TIDE_DAYS_" + n, "REVIEW_HISTORY", n, sortedDays));
        for (int n : REVIEW_TARGETS) {
            LocalDate on = totalReviews >= n ? reviewReach.get(n) : null;
            out.add(new Milestone("REVIEWS_" + n, "REVIEW_HISTORY", n, totalReviews, on));
        }
        for (int n : new int[]{1, 10, 50}) out.add(nth("PEARLS_" + n, "SELF_RATED_RECALL", n, pearls));
        for (int n : new int[]{1, 5, 20}) out.add(nth("FUSIONS_" + n, "VERIFIED_USAGE", n, fusions));
        return out;
    }

    private static Milestone nth(String key, String evidence, int n, List<LocalDate> sorted) {
        LocalDate on = sorted.size() >= n ? sorted.get(n - 1) : null;
        return new Milestone(key, evidence, n, sorted.size(), on);
    }

    /** Distinct-day helper for callers holding (card → days) maps. */
    public static int distinctDays(Map<?, ? extends Set<LocalDate>> byCard) {
        TreeSet<LocalDate> all = new TreeSet<>();
        byCard.values().forEach(all::addAll);
        return all.size();
    }
}
