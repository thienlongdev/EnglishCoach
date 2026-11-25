package com.englishcoach.cosmos;

import java.util.List;

/** Echo Neural Cosmos — the learner's own evidence (the shared verified lexicon is a static, content-hashed client asset). */
public final class CosmosDtos {
    private CosmosDtos() {}

    /**
     * Times are epoch milliseconds (UTC). Every list is the caller's own data only; SYSTEM sources appear only when the learner
     * completed them. Nothing in here is a relation or a mastery claim: it is the evidence the client draws from.
     */
    public record Overlay(int extractorVersion, long generatedAt, List<Word> words, boolean wordsTruncated,
                          List<Review> reviews, boolean reviewsTruncated, List<Grammar> grammar, List<Source> sources) {}

    /**
     * One active flashcard (state 0). meaning = the learner's text, else the deck's taught sense, else the dictionary's.
     * reviewCount = the card's stored review counter (covers studying before the V116 log existed).
     * dueAt = the card's next review as the Flashcards scheduler stored it (epoch ms), null when none is stored. It is the
     * scheduler's own date, read as it is: never a prediction made here.
     */
    public record Word(long cardId, String word, String status, long createdAt, String meaning, String partOfSpeech,
                       String definition, String deckSlug, String deckTitle, String deckCategory, int reviewCount, Long dueAt) {}

    /** One stored rating (flashcard_review_log, since V116): q = hard | good | easy. */
    public record Review(long cardId, String q, long at) {}

    public record Grammar(String slug, long firstOpenedAt, Long studiedAt, Integer bestCheckPct, Long masteredAt,
                          boolean needsReview) {}

    /**
     * READING / LISTENING = a material the learner completed (receptive); WRITING / SPEAKING = text the learner produced.
     * tokens = {@link CosmosTokenizer} output for that exact content version.
     */
    public record Source(String kind, long id, String title, long at, boolean system, String tokens) {}

    /**
     * "Hỏi vũ trụ" passage retrieval. refs = "KIND:id" of sources (≤ 12; READING, LISTENING, WRITING, SPEAKING); groups = 1–2 lists
     * of word forms, each the forms of ONE concept (≤ 32). Two groups ⇒ only sentences that contain both. limit = per source (≤ 4).
     */
    public record PassageQuery(List<String> refs, List<List<String>> groups, Integer limit) {}

    /**
     * One sentence of a source the caller may see. segmentId / startMs = the Listening transcript segment (else 0 / null);
     * index = sentence position in the source; spans = [start, end, group] character ranges of the matched forms in text.
     */
    public record Passage(String kind, long id, String title, long at, boolean system, long segmentId, Integer startMs, int index,
                          String text, List<int[]> spans) {}

    /** more = further matching sentences exist beyond the limits (the client says so instead of hiding it). */
    public record Passages(List<Passage> passages, boolean more) {}
}
