package com.englishcoach.speaking.topic;

import com.englishcoach.speaking.topic.TopicBank.Item;

import java.util.*;

/**
 * Chooses the next question for one learner from a filtered pool and that learner's recent draws. Pure and deterministic
 * apart from the final uniform pick among the equally best candidates (the {@link Random} is injected for tests).
 *
 * <ol>
 *   <li>Never the item just rejected ({@code excludeId}) while anything else is eligible.</li>
 *   <li>Unseen first: an item drawn in the history window (seen, skipped or spoken) is not offered again while an
 *       unseen one remains. When none remains the pool is EXHAUSTED: nothing is drawn unless the learner explicitly
 *       asks for a replay, which then takes the least recently drawn items. Filters are never widened silently.</li>
 *   <li>Variety among the unseen: penalties for the semantic cluster of the last draws (near-duplicate themes),
 *       for the category of the last two draws (only when the pool spans several categories) and for the cognitive
 *       task of the last two draws.</li>
 * </ol>
 */
final class TopicSelector {

    static final int CLUSTER_WINDOW = 8;

    enum Outcome { CHOSEN, EXHAUSTED, EMPTY }

    record Result(Outcome outcome, Item item, int poolSize, int unseen) {}

    private TopicSelector() {}

    /**
     * @param history items of the learner's recent draws, newest first (unknown ids already dropped)
     */
    static Result choose(List<Item> pool, List<Item> history, String excludeId, boolean allowReplay, Random random) {
        if (pool.isEmpty()) return new Result(Outcome.EMPTY, null, 0, 0);
        Map<String, Integer> lastSeen = new HashMap<>();
        for (int i = 0; i < history.size(); i++) lastSeen.putIfAbsent(history.get(i).id(), i);

        List<Item> candidates = pool.size() > 1
                ? pool.stream().filter(i -> !i.id().equals(excludeId)).toList()
                : pool;
        List<Item> unseen = candidates.stream().filter(i -> !lastSeen.containsKey(i.id())).toList();
        if (!unseen.isEmpty()) {
            return new Result(Outcome.CHOSEN, best(unseen, history, pool, random), pool.size(), unseen.size() - 1);
        }
        if (!allowReplay) return new Result(Outcome.EXHAUSTED, null, pool.size(), 0);
        // explicit replay: the least recently drawn quarter of the pool, still varied
        List<Item> oldest = new ArrayList<>(candidates);
        oldest.sort(Comparator.comparingInt((Item i) -> lastSeen.get(i.id())).reversed());
        List<Item> tail = oldest.subList(0, Math.max(1, oldest.size() / 4));
        return new Result(Outcome.CHOSEN, best(tail, history, pool, random), pool.size(), 0);
    }

    private static Item best(List<Item> options, List<Item> history, List<Item> pool, Random random) {
        boolean multiCategory = pool.stream().map(Item::category).distinct().count() > 1;
        int bestScore = Integer.MAX_VALUE;
        List<Item> top = new ArrayList<>();
        for (Item option : options) {
            int score = penalty(option, history, multiCategory);
            if (score < bestScore) {
                bestScore = score;
                top.clear();
            }
            if (score == bestScore) top.add(option);
        }
        return top.get(random.nextInt(top.size()));
    }

    static int penalty(Item option, List<Item> history, boolean multiCategory) {
        int score = 0;
        for (int i = 0; i < Math.min(CLUSTER_WINDOW, history.size()); i++) {
            Item seen = history.get(i);
            if (seen.cluster().equals(option.cluster())) score += 100 * (CLUSTER_WINDOW - i);
            if (i < 2 && multiCategory && seen.category().equals(option.category())) score += 30;
            if (i < 2 && seen.task().equals(option.task())) score += 10;
        }
        return score;
    }
}
