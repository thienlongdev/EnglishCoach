package com.englishcoach.flashcard.pvp;

import com.englishcoach.flashcard.pvp.config.CardBlastPvPConstants;
import com.englishcoach.flashcard.pvp.engine.ScheduleBuilder;
import com.englishcoach.flashcard.pvp.engine.ScheduleBuilder.WordSource;
import com.englishcoach.flashcard.pvp.model.ScheduledWord;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class ScheduleBuilderTest {

    private List<WordSource> testPool;

    @BeforeEach
    void setUp() {
        testPool = new ArrayList<>();
        for (int i = 1; i <= 80; i++) {
            testPool.add(new WordSource(
                    (long) i,
                    "word" + i,
                    "/wɜːd" + i + "/",
                    "từ" + i,
                    List.of("từ" + i, "nghĩa" + i)
            ));
        }
    }

    @Test
    @DisplayName("Should produce deterministic identical schedule with the same seed")
    void shouldProduceDeterministicSchedule() {
        long seed = 123456789L;
        List<ScheduledWord> schedule1 = ScheduleBuilder.buildSchedule(testPool, seed, "VI_EN");
        List<ScheduledWord> schedule2 = ScheduleBuilder.buildSchedule(testPool, seed, "VI_EN");

        assertEquals(schedule1.size(), schedule2.size());
        for (int i = 0; i < schedule1.size(); i++) {
            ScheduledWord w1 = schedule1.get(i);
            ScheduledWord w2 = schedule2.get(i);

            assertEquals(w1.getSeq(), w2.getSeq());
            assertEquals(w1.getWordId(), w2.getWordId());
            assertEquals(w1.getWord(), w2.getWord());
            assertEquals(w1.getLane(), w2.getLane());
            assertEquals(w1.getSpawnAtMs(), w2.getSpawnAtMs());
            assertEquals(w1.getFallDurationMs(), w2.getFallDurationMs());
            assertEquals(w1.getTargetAnswers(), w2.getTargetAnswers());
        }
    }

    @Test
    @DisplayName("Should cap schedule at min(60, deckSize)")
    void shouldCapScheduleSize() {
        List<ScheduledWord> schedule80 = ScheduleBuilder.buildSchedule(testPool, 42L, "VI_EN");
        assertEquals(CardBlastPvPConstants.MAX_WORDS_PER_MATCH, schedule80.size());

        List<WordSource> smallPool = testPool.subList(0, 15);
        List<ScheduledWord> schedule15 = ScheduleBuilder.buildSchedule(smallPool, 42L, "VI_EN");
        assertEquals(15, schedule15.size());
    }

    @Test
    @DisplayName("Should ensure adjacent spawns do not collide on the exact same lane")
    void shouldPreventAdjacentLaneCollisions() {
        List<ScheduledWord> schedule = ScheduleBuilder.buildSchedule(testPool, 999L, "VI_EN");
        int prevLane = -1;
        for (ScheduledWord sw : schedule) {
            assertTrue(sw.getLane() >= 0 && sw.getLane() < CardBlastPvPConstants.NUM_LANES);
            if (prevLane != -1) {
                assertNotEquals(prevLane, sw.getLane(), "Adjacent word spawned on same lane " + prevLane);
            }
            prevLane = sw.getLane();
        }
    }

    @Test
    @DisplayName("Should set correct target answers depending on direction")
    void shouldSetTargetAnswersCorrectly() {
        List<ScheduledWord> viEnSchedule = ScheduleBuilder.buildSchedule(testPool.subList(0, 5), 10L, "VI_EN");
        for (ScheduledWord sw : viEnSchedule) {
            assertEquals(1, sw.getTargetAnswers().size());
            assertEquals(sw.getWord(), sw.getTargetAnswers().get(0));
        }

        List<ScheduledWord> enViSchedule = ScheduleBuilder.buildSchedule(testPool.subList(0, 5), 10L, "EN_VI");
        for (ScheduledWord sw : enViSchedule) {
            assertTrue(sw.getTargetAnswers().size() >= 1);
            assertTrue(sw.getTargetAnswers().contains(sw.getVietnamese()));
        }
    }
}
