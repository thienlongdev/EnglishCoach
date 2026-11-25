package com.englishcoach.spelling;

import com.englishcoach.kingofenglish.KingCorpus;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import java.util.*;
import java.security.SecureRandom;

/** Finite editorial selection from the project's licensed vocabulary, never the reference game's word list. */
@Component
public class SpellingCatalog {
    public record Clip(String file, long durationMs, String sha256) {}
    public record Word(String word, int tier, String source, String clue, Clip clip) {}
    private final KingCorpus corpus;
    private final List<Word> words = new ArrayList<>();
    private final Map<String, Clip> phrases = new HashMap<>();
    private final SecureRandom random = new SecureRandom();
    private boolean complete;
    public SpellingCatalog(ObjectMapper json, KingCorpus corpus) {
        this.corpus = corpus;
        try (var in = new ClassPathResource("data/spelling/catalog.json").getInputStream()) {
            var root = json.readTree(in);
            if (!SpellingRules.VERSION.equals(root.path("version").asText()) || !"us_female".equals(root.path("voice").asText())) return;
            var clips = new HashMap<String, Clip>();
            for (var a : root.path("audio")) {
                String file = a.path("file").asText();
                long duration = a.path("durationMs").asLong();
                if (!file.matches("[a-f0-9]{64}\\.wav") || duration < 350 || duration > 18000
                    || !new ClassPathResource("data/spelling/audio/" + file).exists()) continue;
                clips.put(a.path("key").asText(), new Clip(file, duration, a.path("sha256").asText()));
            }
            for (var w : root.path("words")) {
                String word = w.path("word").asText(), source = w.path("source").asText();
                int tier = w.path("tier").asInt(-1);
                if (!word.matches("[a-z]{3,24}") || tier < 0 || tier > 2 || !clips.containsKey(word)) continue;
                boolean sourceValid = source.equals("king-core.lexicon:" + word) && corpus.wordEligible(word);
                if (source.startsWith("king-core.content:")) {
                    String ref = source.substring("king-core.content:".length());
                    int colon = ref.lastIndexOf(':');
                    if (colon > 0 && corpus.entry(ref.substring(0, colon)) != null)
                        sourceValid = word.equals(corpus.get(ref.substring(0, colon)).path("content").path(ref.substring(colon + 1)).asText().toLowerCase(Locale.ROOT));
                }
                if (sourceValid) words.add(new Word(word, tier, source, w.path("clue").asText(), clips.get(word)));
            }
            root.path("phrases").fieldNames().forEachRemaining(k -> { if (clips.containsKey(k)) phrases.put(k, clips.get(k)); });
            complete = phrases.size() == 9 && java.util.stream.IntStream.range(0,3).allMatch(t -> words.stream().filter(w -> w.tier == t).count() >= 70);
        } catch (Exception ignored) {
            // A missing preparation artifact disables this game, never the rest of English Coach.
            complete = false;
        }
    }
    public boolean available() { return complete && corpus.enabled(); }
    public List<Integer> counts() { return java.util.stream.IntStream.range(0,3).mapToObj(t -> (int)words.stream().filter(w -> w.tier == t).count()).toList(); }
    public Word choose(int tier, Set<String> used) {
        if (!available()) throw new IllegalStateException("SPELLING_AUDIO_UNAVAILABLE");
        var pool = words.stream().filter(w -> w.tier == tier && !used.contains(w.word)).toList();
        if (pool.isEmpty()) pool = words.stream().filter(w -> w.tier == tier).toList();
        return pool.get(random.nextInt(pool.size()));
    }
    public Clip phrase(String key) { return phrases.get(key); }
    public static ClassPathResource resource(Clip clip) { return new ClassPathResource("data/spelling/audio/" + clip.file); }
}
