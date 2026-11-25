package com.englishcoach.speaking.topic;

import com.englishcoach.speaking.topic.TopicBank.Item;
import com.englishcoach.speaking.topic.TopicBank.Style;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;

class TopicSelectorTest {

    private static Item item(String id, String category, String task, String cluster) {
        return new Item(id, Style.QUICK, category, "B1", task, cluster, null, List.of("Describe " + id + " please."),
                List.of(), null, null, null);
    }

    private final List<Item> pool = List.of(
            item("A-1", "daily-life", "DESCRIBE", "c1"), item("A-2", "daily-life", "OPINION", "c2"),
            item("B-1", "people", "DESCRIBE", "c3"), item("B-2", "people", "OPINION", "c1"),
            item("C-1", "travel", "SOLVE", "c4"), item("C-2", "travel", "EXPLAIN", "c5"));

    @Test
    void unseenItemsComeBeforeAnythingAlreadyDrawn() {
        Random r = new Random(7);
        List<Item> history = new ArrayList<>();
        Set<String> drawn = new HashSet<>();
        for (int i = 0; i < pool.size(); i++) {
            TopicSelector.Result res = TopicSelector.choose(pool, history, null, false, r);
            assertThat(res.outcome()).isEqualTo(TopicSelector.Outcome.CHOSEN);
            assertThat(drawn.add(res.item().id())).as("no repeat before the pool is used up").isTrue();
            history.addFirst(res.item());
        }
        assertThat(drawn).hasSize(pool.size());
    }

    @Test
    void exhaustedPoolIsReportedAndNeverSilentlyRepeated() {
        List<Item> history = new ArrayList<>(pool);
        TopicSelector.Result res = TopicSelector.choose(pool, history, null, false, new Random(1));
        assertThat(res.outcome()).isEqualTo(TopicSelector.Outcome.EXHAUSTED);
        assertThat(res.item()).isNull();
        assertThat(res.poolSize()).isEqualTo(6);
    }

    @Test
    void explicitReplayTakesTheLeastRecentlyDrawnAndNotTheJustRejectedItem() {
        // history newest first: A-1 just shown, C-2 the oldest
        List<Item> history = List.of(pool.get(0), pool.get(1), pool.get(2), pool.get(3), pool.get(4), pool.get(5));
        for (int seed = 0; seed < 20; seed++) {
            TopicSelector.Result res = TopicSelector.choose(pool, history, "A-1", true, new Random(seed));
            assertThat(res.outcome()).isEqualTo(TopicSelector.Outcome.CHOSEN);
            assertThat(res.item().id()).isEqualTo("C-2");
        }
    }

    @Test
    void recentClusterAndCategoryArePenalised() {
        // last draw: A-1 (daily-life, cluster c1). B-2 shares the cluster, A-2 the category: both lose to the others.
        List<Item> history = List.of(pool.get(0));
        Set<String> seen = new HashSet<>();
        for (int seed = 0; seed < 50; seed++) {
            seen.add(TopicSelector.choose(pool, history, null, false, new Random(seed)).item().id());
        }
        assertThat(seen).doesNotContain("B-2", "A-2", "A-1").isNotEmpty();
    }

    @Test
    void emptyPoolIsEmptyNotExhausted() {
        assertThat(TopicSelector.choose(List.of(), List.of(), null, false, new Random()).outcome())
                .isEqualTo(TopicSelector.Outcome.EMPTY);
    }

    @Test
    void realBankDrawsVaryAcrossCategoriesWhenMixed() {
        TopicBank bank = new TopicBank();
        List<Item> mixed = bank.pool(Style.QUICK, null, null);
        List<Item> history = new ArrayList<>();
        Random r = new Random(42);
        for (int i = 0; i < 30; i++) {
            Item next = TopicSelector.choose(mixed, history, null, false, r).item();
            if (!history.isEmpty()) {
                assertThat(next.category()).as("draw %d repeats the previous category", i).isNotEqualTo(history.getFirst().category());
                assertThat(next.cluster()).isNotEqualTo(history.getFirst().cluster());
            }
            history.addFirst(next);
        }
        assertThat(history.stream().map(Item::id).distinct().count()).isEqualTo(30);
    }
}
