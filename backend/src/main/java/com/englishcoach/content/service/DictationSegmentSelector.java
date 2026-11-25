package com.englishcoach.content.service;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Pure, deterministic segment selector for Daily Dictation (Option 1).
 * Selects ONE existing library segment whose duration is closest to target-seconds (20s, min 8s, max 25s),
 * skipping empty/sound-tag segments and segments with fewer than 6 words.
 * Deterministic by seed (epochDay + videoId hash).
 * Relaxes duration bounds only if no segment qualifies in the standard window.
 */
public class DictationSegmentSelector {

    private static final Pattern SOUND_TAGS_PATTERN = Pattern.compile("\\[[^\\]]*\\]|\\([^\\)]*\\)|[♪♫♩♬]+");

    public static final double DEFAULT_MIN_SECONDS = 8.0;
    public static final double DEFAULT_MAX_SECONDS = 25.0;
    public static final double DEFAULT_TARGET_SECONDS = 20.0;
    public static final int DEFAULT_MIN_WORDS = 6;

    public record Cue(Long id, double startSec, double endSec, String text) {
        public Cue(double startSec, double endSec, String text) {
            this(null, startSec, endSec, text);
        }
    }

    public record DictationSegment(Long segmentId, int startSeconds, int endSeconds, int durationSeconds) {
        public DictationSegment(int startSeconds, int endSeconds, int durationSeconds) {
            this(null, startSeconds, endSeconds, durationSeconds);
        }
    }

    public static Optional<DictationSegment> selectSegment(List<Cue> rawCues, long seed) {
        return selectSegment(rawCues, seed, DEFAULT_MIN_SECONDS, DEFAULT_MAX_SECONDS, DEFAULT_TARGET_SECONDS, DEFAULT_MIN_WORDS);
    }

    public static Optional<DictationSegment> selectSegment(
            List<Cue> rawCues,
            long seed,
            double minSeconds,
            double maxSeconds,
            double targetSeconds,
            int minWords
    ) {
        if (rawCues == null || rawCues.isEmpty()) {
            return Optional.empty();
        }

        // 1. Clean cues: strip sound tags, collapse whitespace, filter by minWords and valid duration
        List<Cue> validCues = new ArrayList<>();
        for (Cue c : rawCues) {
            if (c == null || c.text() == null) continue;
            String text = SOUND_TAGS_PATTERN.matcher(c.text()).replaceAll(" ").trim().replaceAll("\\s+", " ");
            double duration = c.endSec() - c.startSec();
            if (duration > 0 && countWords(text) >= minWords) {
                validCues.add(new Cue(c.id(), c.startSec(), c.endSec(), text));
            }
        }

        if (validCues.isEmpty()) {
            return Optional.empty();
        }

        // 2. Discover standard candidates within [minSeconds, maxSeconds]
        List<Cue> standardCandidates = new ArrayList<>();
        for (Cue c : validCues) {
            double duration = c.endSec() - c.startSec();
            if (duration >= minSeconds && duration <= maxSeconds) {
                standardCandidates.add(c);
            }
        }

        // 3. If standard pool is empty, relax duration bounds to all valid cues with >= minWords
        List<Cue> candidatePool = !standardCandidates.isEmpty() ? standardCandidates : validCues;

        // 4. Find the minimum distance to targetSeconds
        double minDistance = Double.MAX_VALUE;
        for (Cue c : candidatePool) {
            double duration = c.endSec() - c.startSec();
            double dist = Math.abs(duration - targetSeconds);
            if (dist < minDistance) {
                minDistance = dist;
            }
        }

        // 5. Gather all candidates that tie for the closest distance to target (within epsilon 1e-4)
        final double bestDist = minDistance;
        List<Cue> closestCandidates = new ArrayList<>();
        for (Cue c : candidatePool) {
            double duration = c.endSec() - c.startSec();
            if (Math.abs(Math.abs(duration - targetSeconds) - bestDist) < 1e-4) {
                closestCandidates.add(c);
            }
        }

        if (closestCandidates.isEmpty()) {
            return Optional.empty();
        }

        // 6. Deterministic tie-breaking by seed
        int chosenIdx = (int) Math.floorMod(seed, closestCandidates.size());
        Cue chosen = closestCandidates.get(chosenIdx);

        int startSec = (int) Math.round(chosen.startSec());
        int endSec = (int) Math.round(chosen.endSec());
        int durSec = Math.max(1, endSec - startSec);

        return Optional.of(new DictationSegment(chosen.id(), startSec, endSec, durSec));
    }

    public static int countWords(String text) {
        if (text == null || text.isBlank()) return 0;
        String[] tokens = text.trim().split("\\s+");
        return tokens.length;
    }
}
