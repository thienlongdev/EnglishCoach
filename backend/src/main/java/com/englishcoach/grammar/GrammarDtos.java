package com.englishcoach.grammar;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public final class GrammarDtos {

    private GrammarDtos() {}

    public record Capabilities(boolean professorAvailable) {}

    public record AttemptRequest(@NotNull UUID requestId, @NotBlank @Size(max = 64) String exerciseId, @NotNull JsonNode answer) {}

    public record VerdictView(String exerciseId, String outcome, Double score, String explain, JsonNode reveal, List<String> tags) {}

    public record TopicStateView(String slug, String status, Instant firstOpenedAt, Instant studiedAt, int practiceScored,
                                 Integer practiceCorrectPct, Integer lastCheckPct, Integer bestCheckPct, Instant lastCheckAt,
                                 Instant masteredAt, Instant reviewDueAt, boolean needsReview, int reviewStage) {}

    public record Recommendation(String slug, String reason) {}

    public record MeView(String startLevel, String startBasis, List<TopicStateView> states, List<String> bookmarks,
                         List<Recommendation> next, List<String> dueReviews, Counts counts) {}

    public record Counts(int opened, int studied, int practising, int mastered, int due, int attempts30d, int bookmarks) {}

    public record CheckRequest(@NotBlank @Pattern(regexp = "TOPIC|REVIEW|DIAGNOSTIC|DOMAIN|IELTS|TOEIC") String kind,
                               @Size(max = 80) String scope) {}

    public record CheckView(UUID id, String kind, String scope, Instant startedAt, List<JsonNode> exercises, boolean submitted, CheckResult result) {}

    public record CheckSubmit(@NotNull @Size(max = 64) Map<String, JsonNode> answers) {}

    public record ItemResult(String exerciseId, String topic, String outcome, Double score, String explain, JsonNode reveal,
                             JsonNode answer) {}

    public record LevelResult(String level, int scored, int pct) {}

    /** {@code mastery}: what this check did to the topic, in plain states; never a band, score scale or certificate. */
    public record CheckResult(int pct, int scoredItems, int unscoredItems, boolean enoughEvidence, String mastery, Instant nextReviewAt,
                              String suggestedLevel, List<LevelResult> levels, List<ItemResult> items,
                              int productionScored, int productionCorrect, int productionRequired) {}

    public record CheckSummary(UUID id, String kind, String scope, Instant startedAt, Instant submittedAt, Integer pct, Integer scoredItems) {}

    public record MistakeGroup(String tag, int count, Instant lastAt, String topic, String exerciseId, String lastAnswer, int recent30d) {}

    public record MistakesView(List<MistakeGroup> groups, int windowDays, int totalWrong) {}

    public record ReportRequest(@NotBlank @Pattern(regexp = "ANSWER|CONTENT") String kind, @Size(max = 80) String topic,
                                @Size(max = 64) String exerciseId, @Size(max = 400) String answer, @Size(max = 800) String message) {}

    public record LevelRequest(@NotBlank @Pattern(regexp = "preA1|A1|A2|B1|B2|C1|C2") String level) {}

    public record PracticeSet(List<JsonNode> exercises, String note) {}

    public record ProfessorRequest(@NotBlank @Size(max = 80) String topic, @NotBlank @Size(max = 500) String question,
                                   @Size(max = 300) String sentence) {}

    public record ProfessorAnswer(String answer, List<Map<String, String>> examples, String confidence, boolean ai) {}

    public record ReportView(long id, Long userId, String topic, String exerciseId, String kind, String answer, String message, Instant createdAt) {}
}
