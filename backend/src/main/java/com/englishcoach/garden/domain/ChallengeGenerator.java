package com.englishcoach.garden.domain;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Harvest recall questions (GDD 03 §8). Words come in priority groups chosen by the caller (the learner's own overdue
 * cards, recently learned cards, any own card, then the system starter vocabulary). Every choice is deterministic for
 * the challenge seed, so a stored challenge can be regenerated identically in tests. The caller persists the answers
 * server-side; only prompts and options ever reach the client. Answers never touch the Flashcard scheduler.
 */
public final class ChallengeGenerator {

    public enum Direction { EN_VI, VI_EN }

    public record Word(Long cardId, String word, String meaningVi, String ipa) {}

    public record Question(Direction direction, String prompt, String ipa, List<String> options, int answer,
                           Long cardId, String word) {}

    private final GardenRules rules;

    public ChallengeGenerator(GardenRules rules) {
        this.rules = rules;
    }

    public List<Question> generate(List<List<Word>> priorityGroups, List<Word> distractorPool, String seed) {
        var c = rules.challenge();
        return generate(priorityGroups, distractorPool, seed, c.questions(), c.reverseQuestions());
    }

    /**
     * Graduation (Phase 2): exactly one question per given word, in the given order (no priority shuffle), the last
     * {@code reverse} asked VI→EN. A word that cannot form a question (too few distinct options) is skipped.
     */
    public List<Question> generateFor(List<Word> words, List<Word> distractorPool, String seed, int reverse) {
        List<Word> picked = new ArrayList<>(usable(words));
        List<Word> pool = usable(distractorPool);
        List<Question> out = new ArrayList<>();
        for (int i = 0; i < picked.size(); i++) {
            Direction dir = i >= picked.size() - reverse ? Direction.VI_EN : Direction.EN_VI;
            Question q = build(picked.get(i), dir, pool, picked, seed + ":q" + i);
            if (q != null) out.add(q);
        }
        return out;
    }

    public List<Question> generate(List<List<Word>> priorityGroups, List<Word> distractorPool, String seed,
                                   int questions, int reverseQuestions) {
        Map<String, Word> chosen = new LinkedHashMap<>();
        int g = 0;
        for (List<Word> group : priorityGroups) {
            for (Word w : shuffled(usable(group), seed + ":g" + g)) {
                if (chosen.size() >= questions) break;
                chosen.putIfAbsent(norm(w.word()), w);
            }
            g++;
        }
        List<Word> picked = new ArrayList<>(chosen.values());
        List<Word> pool = usable(distractorPool);
        List<Question> out = new ArrayList<>();
        for (int i = 0; i < picked.size(); i++) {
            Word w = picked.get(i);
            Direction dir = i >= picked.size() - reverseQuestions && picked.size() == questions
                    ? Direction.VI_EN : Direction.EN_VI;
            Question q = build(w, dir, pool, picked, seed + ":q" + i);
            if (q != null) out.add(q);
        }
        return out;
    }

    private Question build(Word w, Direction dir, List<Word> pool, List<Word> picked, String seed) {
        int n = rules.challenge().options();
        String correct = dir == Direction.EN_VI ? shortMeaning(w.meaningVi()) : w.word();
        Map<String, String> options = new LinkedHashMap<>();
        options.put(norm(correct), correct);
        // distractors: the other picked words first (same session vocabulary), then the shuffled pool
        List<Word> candidates = new ArrayList<>(shuffled(picked, seed + ":p"));
        candidates.addAll(shuffled(pool, seed + ":d"));
        for (Word d : candidates) {
            if (options.size() >= n) break;
            if (norm(d.word()).equals(norm(w.word()))) continue;
            String text = dir == Direction.EN_VI ? shortMeaning(d.meaningVi()) : d.word();
            if (text.isBlank()) continue;
            options.putIfAbsent(norm(text), text);
        }
        if (options.size() < n) return null;
        List<String> texts = shuffled(new ArrayList<>(options.values()), seed + ":o");
        String prompt = dir == Direction.EN_VI ? w.word() : shortMeaning(w.meaningVi());
        return new Question(dir, prompt, dir == Direction.EN_VI ? w.ipa() : null, texts, texts.indexOf(correct),
                w.cardId(), w.word());
    }

    /** First sense of a dictionary translation ("Đồng ý, tán thành, bằng lòng" → "Đồng ý"), capitalised. */
    public static String shortMeaning(String vi) {
        if (vi == null) return "";
        String s = vi.replaceAll("\\([^)]*\\)", " ").replaceAll("\\s+", " ").trim();
        for (String part : s.split("[,;/]")) {
            String p = part.trim();
            if (!p.isEmpty()) {
                if (p.length() > 48) p = p.substring(0, 48).trim();
                return p.substring(0, 1).toUpperCase(Locale.ROOT) + p.substring(1);
            }
        }
        return "";
    }

    private static List<Word> usable(List<Word> words) {
        return words.stream().filter(w -> w.word() != null && !w.word().isBlank()
                && !shortMeaning(w.meaningVi()).isBlank()).toList();
    }

    private static <T> List<T> shuffled(List<T> items, String seed) {
        List<T> copy = new ArrayList<>(items);
        List<Integer> idx = new ArrayList<>();
        for (int i = 0; i < copy.size(); i++) idx.add(i);
        idx.sort(Comparator.comparingLong(i -> DeterministicRandom.hash(seed + "#" + i)));
        List<T> out = new ArrayList<>();
        for (int i : idx) out.add(copy.get(i));
        return out;
    }

    private static String norm(String s) {
        return s == null ? "" : s.trim().toLowerCase(Locale.ROOT);
    }
}
