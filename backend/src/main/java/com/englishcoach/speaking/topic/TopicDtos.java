package com.englishcoach.speaking.topic;

import jakarta.validation.constraints.*;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Wire records of "Nói theo chủ đề". Internal selection metadata (cognitive task, cluster) is never sent. */
public final class TopicDtos {

    private TopicDtos() {}

    public record CategoryCount(String key, String vi, String en, int count) {}

    public record StyleCatalog(String style, int units, int questions, List<CategoryCount> categories,
                               java.util.Map<String, Integer> bands) {}

    public record Catalog(String version, String provenance, String reviewStatus, List<StyleCatalog> styles) {}

    public record DefinitionView(String term, String en, String vi) {}

    public record ItemView(String id, String style, String category, String categoryVi, String categoryEn, String level,
                           String band, String title, List<String> questions, List<String> bullets, String explain,
                           DefinitionView definition, String linkedId, String followUpId) {}

    /**
     * @param style        QUICK, DEEP, IELTS1, IELTS2 or IELTS3 (ignored when {@code replayItemId} is given)
     * @param category     a category key, or null for the mixed pool ("Tổng hợp")
     * @param band         BASIC, INTERMEDIATE, ADVANCED or null (QUICK / DEEP only)
     * @param previousDrawId the draw this spin replaces; marked SKIPPED when it was never started
     * @param replayItemId an explicit, intentional replay of one item (retry, history, favourite)
     * @param allowReplay  the learner accepted repeats after the filtered pool was exhausted
     */
    public record DrawRequest(@NotNull UUID requestId,
                              @Pattern(regexp = "QUICK|DEEP|IELTS1|IELTS2|IELTS3") String style,
                              @Pattern(regexp = "[a-z0-9-]{2,40}") String category,
                              @Pattern(regexp = "BASIC|INTERMEDIATE|ADVANCED") String band,
                              @Positive Long previousDrawId,
                              @Pattern(regexp = "[A-Z0-9-]{3,24}") String replayItemId,
                              boolean allowReplay) {}

    /** {@code outcome}: DRAWN, EXHAUSTED (every eligible item was drawn recently) or EMPTY (no item matches). */
    public record DrawResponse(String outcome, Long drawId, ItemView item, int poolSize, int unseenRemaining) {}

    public record StartRequest(@Min(10) @Max(900) int targetSeconds) {}

    public record FinishRequest(@Min(0) @Max(1200) int spokenSeconds, boolean recorded) {}

    public record RoundView(long drawId, String status, Integer targetSeconds, Integer spokenSeconds,
                            Boolean reachedTarget, boolean recorded) {}

    public record HistoryEntry(long drawId, String status, Integer spokenSeconds, Boolean reachedTarget, Instant drawnAt,
                               ItemView item) {}

    public record Summary(int roundsFinished, int roundsReachedTarget, int spokenSeconds, int distinctTopicsSpoken,
                          int topicsDrawn, Instant lastPracticeAt, List<HistoryEntry> recent, List<ItemView> favorites) {}
}
