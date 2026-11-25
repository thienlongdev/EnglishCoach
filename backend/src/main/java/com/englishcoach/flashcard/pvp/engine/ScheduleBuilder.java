package com.englishcoach.flashcard.pvp.engine;

import com.englishcoach.flashcard.pvp.config.CardBlastPvPConstants;
import com.englishcoach.flashcard.pvp.model.ScheduledWord;

import java.util.*;

public final class ScheduleBuilder {

    public record WordSource(
            long wordId,
            String word,
            String ipa,
            String vietnamese,
            List<String> allMeanings
    ) {}

    private ScheduleBuilder() {
    }

    public record SpeedConfig(long initialFallMs, long minFallMs, long initialGapMs, long minGapMs) {}

    public static SpeedConfig getSpeedConfig(int speedLevel) {
        return getSpeedConfig(speedLevel, "NORMAL");
    }

    public static SpeedConfig getSpeedConfig(int speedLevel, String hintLevel) {
        int clampedLevel = Math.max(1, Math.min(5, speedLevel));
        double speedMult = CardBlastPvPConstants.SPEED_MULT_NORMAL;
        long baseInterval = CardBlastPvPConstants.BASE_INTERVAL_NORMAL_MS;

        if ("EASY".equalsIgnoreCase(hintLevel)) {
            speedMult = CardBlastPvPConstants.SPEED_MULT_EASY;
            baseInterval = CardBlastPvPConstants.BASE_INTERVAL_EASY_MS;
        } else if ("HARD".equalsIgnoreCase(hintLevel)) {
            speedMult = CardBlastPvPConstants.SPEED_MULT_HARD;
            baseInterval = CardBlastPvPConstants.BASE_INTERVAL_HARD_MS;
        }

        // Exact formula from single player CardBlastEngine.tsx:
        // baseFallSpeed = (0.7 + Math.random() * 0.35) * diffParams.speedMult * (0.6 + (currentSpeedLevel - 1) * 0.22)
        // Midpoint fall speed = 0.875 * speedMult * speedFactor px/frame (60fps)
        // Reference fall distance = 572 px -> Base duration at 1.0 factor = ~11,000ms
        double speedFactor = CardBlastPvPConstants.SPEED_FACTOR_BASE + (clampedLevel - 1) * CardBlastPvPConstants.SPEED_FACTOR_STEP;
        double combinedMultiplier = speedMult * speedFactor;

        long initialFallMs = Math.round(11000.0 / combinedMultiplier);
        long minFallMs = Math.round(initialFallMs * 0.72);

        // Calibrated spawn gap to guarantee AT MOST 2-3 words on screen concurrently
        long initialGapMs;
        long minGapMs;
        switch (clampedLevel) {
            case 1 -> {
                initialGapMs = CardBlastPvPConstants.SPAWN_GAP_SPEED_1_INITIAL_MS;
                minGapMs = CardBlastPvPConstants.SPAWN_GAP_SPEED_1_MIN_MS;
            }
            case 2 -> {
                initialGapMs = CardBlastPvPConstants.SPAWN_GAP_SPEED_2_INITIAL_MS;
                minGapMs = CardBlastPvPConstants.SPAWN_GAP_SPEED_2_MIN_MS;
            }
            case 3 -> {
                initialGapMs = CardBlastPvPConstants.SPAWN_GAP_SPEED_3_INITIAL_MS;
                minGapMs = CardBlastPvPConstants.SPAWN_GAP_SPEED_3_MIN_MS;
            }
            case 4 -> {
                initialGapMs = CardBlastPvPConstants.SPAWN_GAP_SPEED_4_INITIAL_MS;
                minGapMs = CardBlastPvPConstants.SPAWN_GAP_SPEED_4_MIN_MS;
            }
            default -> {
                initialGapMs = CardBlastPvPConstants.SPAWN_GAP_SPEED_5_INITIAL_MS;
                minGapMs = CardBlastPvPConstants.SPAWN_GAP_SPEED_5_MIN_MS;
            }
        }

        return new SpeedConfig(initialFallMs, minFallMs, initialGapMs, minGapMs);
    }

    public static List<ScheduledWord> buildSchedule(List<WordSource> pool, long seed, String direction) {
        return buildSchedule(pool, seed, direction, 2, "NORMAL");
    }

    public static List<ScheduledWord> buildSchedule(List<WordSource> pool, long seed, String direction, int speedLevel) {
        return buildSchedule(pool, seed, direction, speedLevel, "NORMAL");
    }

    public static List<ScheduledWord> buildSchedule(List<WordSource> pool, long seed, String direction, int speedLevel, String hintLevel) {
        if (pool == null || pool.isEmpty()) {
            return Collections.emptyList();
        }

        SpeedConfig speedConfig = getSpeedConfig(speedLevel, hintLevel);

        // Deterministic shuffle using seed
        List<WordSource> shuffled = new ArrayList<>(pool);
        Random random = new Random(seed);
        Collections.shuffle(shuffled, random);

        int count = Math.min(CardBlastPvPConstants.MAX_WORDS_PER_MATCH, shuffled.size());
        List<ScheduledWord> schedule = new ArrayList<>(count);

        boolean isEnVi = "EN_VI".equalsIgnoreCase(direction);
        long currentSpawnMs = CardBlastPvPConstants.INITIAL_SPAWN_DELAY_MS;
        int prevLane = -1;

        for (int i = 0; i < count; i++) {
            WordSource src = shuffled.get(i);
            int seq = i + 1;

            // Lane selection: ensure adjacent spawns don't choose the same lane
            int lane = random.nextInt(CardBlastPvPConstants.NUM_LANES);
            if (lane == prevLane) {
                lane = (lane + 1 + random.nextInt(CardBlastPvPConstants.NUM_LANES - 1)) % CardBlastPvPConstants.NUM_LANES;
            }
            prevLane = lane;

            // Timing progression scaling based on speedLevel (50 word linear ramp)
            double progress = Math.min(1.0, (double) i / 50.0);
            long interval = Math.round(speedConfig.initialGapMs() - progress * (speedConfig.initialGapMs() - speedConfig.minGapMs()));
            long fallDuration = Math.round(speedConfig.initialFallMs() - progress * (speedConfig.initialFallMs() - speedConfig.minFallMs()));

            // Target answers
            List<String> targetAnswers = new ArrayList<>();
            if (isEnVi) {
                if (src.vietnamese() != null && !src.vietnamese().isBlank()) {
                    targetAnswers.add(src.vietnamese().trim());
                }
                if (src.allMeanings() != null) {
                    for (String m : src.allMeanings()) {
                        if (m != null && !m.isBlank() && !targetAnswers.contains(m.trim())) {
                            targetAnswers.add(m.trim());
                        }
                    }
                }
            } else {
                if (src.word() != null && !src.word().isBlank()) {
                    targetAnswers.add(src.word().trim());
                }
            }

            ScheduledWord sw = ScheduledWord.builder()
                    .seq(seq)
                    .wordId(src.wordId())
                    .word(src.word())
                    .ipa(src.ipa())
                    .vietnamese(src.vietnamese())
                    .targetAnswers(targetAnswers)
                    .lane(lane)
                    .spawnAtMs(currentSpawnMs)
                    .fallDurationMs(fallDuration)
                    .build();

            schedule.add(sw);
            currentSpawnMs += interval;
        }

        return Collections.unmodifiableList(schedule);
    }
}
