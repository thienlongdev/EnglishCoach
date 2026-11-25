package com.englishcoach.wordchain;

import java.util.*;
import java.util.random.RandomGenerator;

/**
 * Echo's word choice. Echo plays only words that pass the same {@link WordChainLexicon#check} verdict as a human,
 * never repeats its own words, and draws from the approved lexicon by level before the dictionary fallback:
 * EASY = A1–A2 (then B1), MEDIUM = A1–B1 (then B2), HARD = B1 and above, choosing among a few legal words the one
 * whose last letter starts the fewest approved words. Echo sees nothing a human cannot (no hidden rule, no answer).
 */
final class WordChainBot {
    static final Set<String> LEVELS = Set.of("EASY", "MEDIUM", "HARD");
    static final int PROBES = 160;
    private WordChainBot() {}

    static List<int[]> stages(String level) {
        return switch (level) {
            case "EASY" -> List.of(new int[]{1, 1}, new int[]{1, 2}, new int[]{1, 4}, new int[]{1, 5});
            case "HARD" -> List.of(new int[]{2, 4}, new int[]{1, 4}, new int[]{1, 5});
            default -> List.of(new int[]{1, 2}, new int[]{1, 3}, new int[]{1, 4}, new int[]{1, 5});
        };
    }

    static WordChainLexicon.Word choose(WordChainLexicon lexicon, char letter, Set<String> used, String level,
                                        RandomGenerator random) {
        List<WordChainLexicon.BotWord> pool = lexicon.botWords().getOrDefault(letter, List.of());
        int probes = 0;
        for (int[] stage : stages(level)) {
            List<WordChainLexicon.BotWord> band = pool.stream()
                    .filter(w -> w.tier() >= stage[0] && w.tier() <= stage[1] && !used.contains(w.word()))
                    .filter(w -> !"EASY".equals(level) || stage[1] > 2 || w.word().length() <= 8).toList();
            if (band.isEmpty()) continue;
            // Visit the band from a random start with a stride coprime to its size: every word once, no shuffle copy.
            int n = band.size(), start = random.nextInt(n), step = 1 + random.nextInt(n);
            while (gcd(step, n) != 1) step = step % n + 1;
            List<WordChainLexicon.Word> legal = new ArrayList<>();
            int wanted = "HARD".equals(level) ? 5 : 1;
            for (int i = 0; i < n && probes < PROBES && legal.size() < wanted; i++) {
                var candidate = band.get((int) ((start + (long) i * step) % n));
                probes++;
                var verdict = lexicon.check(candidate.word());
                if (verdict.word() != null) legal.add(verdict.word());
            }
            if (!legal.isEmpty()) {
                if (!"HARD".equals(level)) return legal.getFirst();
                return legal.stream().min(Comparator.comparingInt((WordChainLexicon.Word w) -> openings(lexicon, last(w)))
                        .thenComparing(w -> -w.normalizedWord().length())).orElseThrow();
            }
            if (probes >= PROBES) break;
        }
        return null;
    }

    private static char last(WordChainLexicon.Word w) {
        String s = w.normalizedWord();
        return s.charAt(s.length() - 1);
    }

    private static int openings(WordChainLexicon lexicon, char letter) {
        int count = 0;
        for (var w : lexicon.botWords().getOrDefault(letter, List.of())) if (w.tier() < 5) count++;
        return count;
    }

    private static int gcd(int a, int b) { return b == 0 ? a : gcd(b, a % b); }
}
