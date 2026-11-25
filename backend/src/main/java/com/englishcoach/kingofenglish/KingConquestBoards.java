package com.englishcoach.kingofenglish;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.zip.GZIPInputStream;

/**
 * Soán ngôi words and boards beyond the offline 5×5 bank.
 * <p>{@link #words()} is the SCOWL US + GB word list ({@code data/king/conquest-lexicon.txt.gz}, every inflected 3–8 letter
 * form; build script {@code backend/scripts/king/corpus/build_conquest_lexicon.py}, notice beside it), loaded once per JVM
 * as one sorted array. {@link #generate} builds a 4×4 / 6×6 / 7×7 board from the match seed: bounded attempts, a solver
 * bounded by word length 8 and prefix search, never an unbounded enumeration. The same seed always gives the same board.
 */
final class KingConquestBoards {
    private KingConquestBoards() {}

    /** Sorted, immutable word array with exact and prefix lookups. */
    static final class Words {
        private final String[] sorted;
        Words(Collection<String> words) {
            sorted = words.stream().filter(w -> w != null && w.matches("[a-z]{3,8}")).distinct().sorted().toArray(String[]::new);
        }
        boolean contains(String word) { return word != null && Arrays.binarySearch(sorted, word) >= 0; }
        boolean hasPrefix(String prefix) {
            int at = Arrays.binarySearch(sorted, prefix);
            if (at >= 0) return true;
            int next = -at - 1;
            return next < sorted.length && sorted[next].startsWith(prefix);
        }
        int size() { return sorted.length; }
        List<String> list() { return List.of(sorted); }
    }

    private static volatile Words bundled;
    /** The extended word list, shared by every room; empty (never a failure) when the resource is missing. */
    static Words words() {
        Words value = bundled;
        if (value != null) return value;
        synchronized (KingConquestBoards.class) {
            if (bundled != null) return bundled;
            var list = new ArrayList<String>(42_000);
            try (var stream = KingConquestBoards.class.getResourceAsStream("/data/king/conquest-lexicon.txt.gz")) {
                if (stream != null) try (var reader = new BufferedReader(new InputStreamReader(new GZIPInputStream(stream), StandardCharsets.US_ASCII))) {
                    for (String line; (line = reader.readLine()) != null; ) if (!line.isBlank()) list.add(line.strip());
                }
            } catch (java.io.IOException e) { list.clear(); }
            bundled = new Words(list);
            return bundled;
        }
    }

    record Generated(List<String> letters, int throne, List<KingConquestBank.Candidate> candidates, int playableWords) {}

    static boolean adjacent(int a, int b, int size) {
        return a != b && Math.max(Math.abs(a / size - b / size), Math.abs(a % size - b % size)) == 1;
    }

    /** The throne: the centre cell of an odd board; on an even board the central cell crossed by the most words (ties: lowest index). */
    static int throne(int size, Map<String, List<Integer>> paths) {
        if (size % 2 == 1) return (size / 2) * size + size / 2;
        int h = size / 2;
        int[] central = {(h - 1) * size + h - 1, (h - 1) * size + h, h * size + h - 1, h * size + h};
        int best = central[0], bestCount = -1;
        for (int cell : central) {
            int count = (int) paths.values().stream().filter(p -> p.contains(cell)).count();
            if (count > bestCount) { best = cell; bestCount = count; }
        }
        return best;
    }

    private static final String BAG = "AAAAAAAEEEEEEEEEEIIIIIOOOOOUUUUUNNNNNRRRRRRSSSSSSTTTTTTLLLLDDDDGGCCMMBBPPHHFFWWYYVK";
    static final int ATTEMPTS = 40;

    /** Minimum playable words, words through the throne and words per cell for a board to pass on the first try. */
    private static int[] floor(int size) {
        return switch (size) { case 4 -> new int[]{45, 6, 1}; case 6 -> new int[]{170, 12, 2}; case 7 -> new int[]{240, 14, 2};
            default -> new int[]{120, 8, 2}; };
    }

    /**
     * A fresh board for {@code size} from {@code seed}. {@code common} (the King learner lexicon when available) supplies Echo's
     * candidates first; {@code all} decides which words a board offers. The best of {@link #ATTEMPTS} boards is used when none
     * reaches the floor, so a match always starts.
     */
    static Generated generate(int size, long seed, Words all, Words common) {
        Generated best = null; int bestScore = -1;
        int[] floor = floor(size);
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            var random = new Random(seed * 31 + size * 1_000_003L + attempt);
            var letters = new ArrayList<String>(size * size);
            for (int i = 0; i < size * size; i++) letters.add(String.valueOf(BAG.charAt(random.nextInt(BAG.length()))));
            var paths = solve(letters, size, all);
            int throne = throne(size, paths);
            int[] coverage = new int[size * size];
            paths.values().forEach(p -> p.forEach(c -> coverage[c]++));
            int throneWords = coverage[throne], minCoverage = Arrays.stream(coverage).min().orElse(0);
            var ranked = paths.entrySet().stream().sorted(Comparator
                    .comparing((Map.Entry<String, List<Integer>> e) -> !common.contains(e.getKey()))
                    .thenComparing(e -> !e.getValue().contains(throne))
                    .thenComparing(e -> -e.getKey().length())
                    .thenComparing(Map.Entry::getKey)).limit(32)
                    .map(e -> new KingConquestBank.Candidate(e.getKey(), e.getValue())).toList();
            var generated = new Generated(List.copyOf(letters), throne, ranked, paths.size());
            boolean passes = paths.size() >= floor[0] && throneWords >= floor[1] && minCoverage >= floor[2] && ranked.size() >= 12;
            if (passes) return generated;
            int score = Math.min(paths.size(), floor[0]) * 4 + Math.min(throneWords, floor[1]) * 3 + Math.min(minCoverage, floor[2]) * 20;
            if (score > bestScore) { best = generated; bestScore = score; }
        }
        return best;
    }

    /** Every word of 3–8 letters on the board with the first path found for it. */
    static Map<String, List<Integer>> solve(List<String> letters, int size, Words words) {
        var found = new LinkedHashMap<String, List<Integer>>();
        var path = new int[8];
        var word = new StringBuilder(8);
        for (int start = 0; start < letters.size(); start++) walk(letters, size, words, start, 0, 0L, path, word, found);
        return found;
    }

    private static void walk(List<String> letters, int size, Words words, int cell, int depth, long used, int[] path,
                             StringBuilder word, Map<String, List<Integer>> found) {
        word.append(Character.toLowerCase(letters.get(cell).charAt(0)));
        path[depth] = cell;
        String text = word.toString();
        if (words.hasPrefix(text)) {
            if (depth >= 2 && !found.containsKey(text) && words.contains(text)) {
                var list = new ArrayList<Integer>(depth + 1);
                for (int i = 0; i <= depth; i++) list.add(path[i]);
                found.put(text, List.copyOf(list));
            }
            if (depth < 7) {
                long mask = used | (1L << cell);
                int row = cell / size, col = cell % size;
                for (int dr = -1; dr <= 1; dr++) for (int dc = -1; dc <= 1; dc++) {
                    int r = row + dr, c = col + dc;
                    if ((dr != 0 || dc != 0) && r >= 0 && c >= 0 && r < size && c < size) {
                        int next = r * size + c;
                        if ((mask & (1L << next)) == 0) walk(letters, size, words, next, depth + 1, mask, path, word, found);
                    }
                }
            }
        }
        word.setLength(word.length() - 1);
    }
}
